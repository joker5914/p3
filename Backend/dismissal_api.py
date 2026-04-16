"""
dismissal_api.py — durable outbox and HTTP poster for the Dismissal scanner.

Design
------
* ``ScanPoster.enqueue()`` writes immediately to an SQLite WAL database and
  returns.  The main scan loop is never blocked by network I/O.
* A background worker thread reads the queue, POSTs to the backend, and deletes
  on success.  Failed rows are rescheduled with exponential back-off.
* The database survives process restarts — pending scans are replayed on the
  next start.  This handles WiFi drops, power cycles, and backend restarts
  without losing scan events.
* Auth failures (HTTP 401) are treated as fatal; a flag is raised so the main
  loop can exit cleanly and let systemd restart the service.

Database path
-------------
Configured via ``SCANNER_OUTBOX_PATH`` (default ``/var/lib/dismissal/outbox.db``).
The ``StateDirectory=dismissal`` directive in the systemd unit creates
``/var/lib/dismissal`` and sets correct ownership before the service starts.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import requests

logger = logging.getLogger("dismissal-scanner.api")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plate       TEXT    NOT NULL,
    confidence  REAL    NOT NULL,
    location    TEXT    NOT NULL,
    captured_at TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at REAL    NOT NULL DEFAULT 0
)
"""


class ScanPoster:
    """
    Thread-safe durable outbox.  One instance per process.
    Call ``start()`` once after construction.
    """

    def __init__(
        self,
        scan_url: str,
        api_token: str,
        db_path: str,
        location: str,
        timeout: int = 10,
        max_attempts: int = 0,   # 0 = retry indefinitely
    ):
        self._scan_url = scan_url
        self._location = location
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._db_path = db_path

        self._stop = threading.Event()
        self._wake = threading.Event()
        self._auth_fatal = threading.Event()

        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
            "User-Agent": f"dismissal-scanner/{location}",
        })

        self._worker = threading.Thread(
            target=self._run, daemon=True, name="api-poster"
        )

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def start(self) -> None:
        self._worker.start()

    def stop(self, drain_timeout: float = 5.0) -> None:
        """
        Signal stop and wait up to ``drain_timeout`` seconds for in-flight
        rows to post.  Bounded so systemd shutdown is never hung waiting for
        a downed backend.
        """
        deadline = time.monotonic() + drain_timeout
        while time.monotonic() < deadline and self._pending_count() > 0:
            self._wake.set()
            time.sleep(0.2)
        self._stop.set()
        self._wake.set()
        self._worker.join(timeout=2)

    @property
    def auth_fatal(self) -> bool:
        """True when the backend has rejected our token (HTTP 401)."""
        return self._auth_fatal.is_set()

    def enqueue(self, plate: str, confidence: float) -> None:
        """Write a scan event to the outbox and wake the worker."""
        iso = datetime.now(tz=timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO outbox (plate, confidence, location, captured_at)"
                " VALUES (?, ?, ?, ?)",
                (plate, round(confidence, 4), self._location, iso),
            )
        self._wake.set()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(_CREATE_SQL)

    def _pending_count(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) FROM outbox").fetchone()
            return row[0] if row else 0

    def _next_batch(self, limit: int = 10) -> list:
        now = time.monotonic()
        with self._connect() as conn:
            cur = conn.execute(
                "SELECT id, plate, confidence, location, captured_at, attempts"
                " FROM outbox WHERE next_try_at <= ? ORDER BY id LIMIT ?",
                (now, limit),
            )
            return cur.fetchall()

    def _delete(self, row_id: int) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM outbox WHERE id = ?", (row_id,))

    def _reschedule(self, row_id: int, attempts: int) -> None:
        delay = min(1.0 * (2 ** min(attempts, 8)), 300.0)  # cap at 5 min
        next_at = time.monotonic() + delay
        with self._connect() as conn:
            conn.execute(
                "UPDATE outbox SET attempts = ?, next_try_at = ? WHERE id = ?",
                (attempts + 1, next_at, row_id),
            )

    # ------------------------------------------------------------------
    # Worker thread
    # ------------------------------------------------------------------

    def _run(self) -> None:
        logger.info("API poster started: %s", self._scan_url)
        while not self._stop.is_set():
            rows = self._next_batch()
            if not rows:
                self._wake.wait(timeout=5.0)
                self._wake.clear()
                continue

            for row in rows:
                if self._stop.is_set():
                    break
                row_id, plate, conf, loc, captured, attempts = row
                success = self._post_once(row_id, plate, conf, loc, captured, attempts)
                if success:
                    self._delete(row_id)
                elif self._max_attempts and attempts + 1 >= self._max_attempts:
                    logger.error(
                        "Max attempts reached for id=%d plate=%s — dropping",
                        row_id, plate,
                    )
                    self._delete(row_id)
                else:
                    self._reschedule(row_id, attempts)

        logger.info("API poster stopped. Pending rows: %d", self._pending_count())

    def _post_once(
        self,
        row_id: int,
        plate: str,
        conf: float,
        loc: str,
        captured: str,
        attempts: int,
    ) -> bool:
        payload = {
            "plate": plate,
            "timestamp": captured,
            "location": loc,
            "confidence_score": conf,
        }
        try:
            resp = self._session.post(
                self._scan_url, json=payload, timeout=self._timeout
            )
        except requests.exceptions.Timeout:
            logger.warning("POST timeout id=%d plate=%s (attempt %d)",
                           row_id, plate, attempts + 1)
            return False
        except requests.exceptions.ConnectionError as exc:
            logger.warning("POST connection error id=%d (attempt %d): %s",
                           row_id, attempts + 1, exc)
            return False
        except Exception as exc:
            logger.warning("POST error id=%d: %s", row_id, exc)
            return False

        if resp.status_code == 200:
            try:
                fs_id = resp.json().get("firestore_id", "?")
            except Exception:
                fs_id = "?"
            logger.info("Scan accepted: plate=%s fs_id=%s", plate, fs_id)
            return True

        if resp.status_code == 401:
            logger.error(
                "Auth rejected (401) — API token is invalid or expired. "
                "Update .env and restart the service. Pausing poster."
            )
            self._auth_fatal.set()
            return False

        logger.warning(
            "POST HTTP %d id=%d plate=%s (attempt %d): %.200s",
            resp.status_code, row_id, plate, attempts + 1, resp.text,
        )
        return False
