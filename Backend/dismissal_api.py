"""
dismissal_api.py — durable outbox, Firebase auth, and HTTP poster for the
Dismissal scanner.

Auth model
----------
Authentication uses a **Firebase service-account JSON** resident on the Pi.
``FirebaseTokenManager`` mints a custom token via firebase-admin, exchanges it
for a 1-hour ID token via Firebase Auth's ``signInWithCustomToken`` REST
endpoint, and auto-refreshes a few minutes before expiry.  The backend
continues to verify Firebase ID tokens — no backend change needed.

Design
------
* ``ScanPoster.enqueue()`` writes immediately to an SQLite WAL database and
  returns.  The main scan loop is never blocked by network I/O.
* A background worker thread reads the queue, POSTs to the backend, and deletes
  on success.  Failed rows are rescheduled with exponential back-off.
* The Authorization header is rebuilt **per request** from the token manager,
  so an expiring token never silently taints in-flight posts.
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
from typing import Callable, Optional, Tuple

import requests

logger = logging.getLogger("dismissal-scanner.api")


# ===========================================================================
# Firebase token manager
# ===========================================================================

class FirebaseTokenManager:
    """
    Mints and refreshes Firebase ID tokens from a service-account JSON.

    Call ``.token()`` whenever you need a fresh bearer — it returns a cached
    token and only re-mints when the current one is within ``REFRESH_SLACK_SECS``
    of expiry.  Thread-safe.
    """

    REFRESH_SLACK_SECS = 300   # refresh if <5 min of life remains
    EXCHANGE_TIMEOUT   = 10

    def __init__(
        self,
        service_account_json_path: str,
        web_api_key: str,
        device_uid: str,
    ) -> None:
        if not service_account_json_path or not Path(service_account_json_path).is_file():
            raise FileNotFoundError(
                f"Firebase service-account JSON not found: {service_account_json_path}"
            )
        if not web_api_key:
            raise ValueError("FIREBASE_WEB_API_KEY is empty — cannot exchange custom tokens.")
        if not device_uid:
            raise ValueError("device_uid is empty — cannot mint custom tokens.")

        self._sa_path      = service_account_json_path
        self._web_api_key  = web_api_key
        self._uid          = device_uid
        self._lock         = threading.Lock()
        self._id_token: Optional[str] = None
        self._expires_at: float       = 0.0   # monotonic deadline

        # Initialise firebase-admin exactly once.  Importing lazily keeps the
        # import cost out of the scanner's hot path if auth isn't configured.
        import firebase_admin
        from firebase_admin import credentials

        try:
            firebase_admin.get_app()
        except ValueError:
            cred = credentials.Certificate(service_account_json_path)
            firebase_admin.initialize_app(cred)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def token(self) -> str:
        """Return a currently-valid Firebase ID token, minting a new one if needed."""
        with self._lock:
            if (
                self._id_token
                and time.monotonic() < self._expires_at - self.REFRESH_SLACK_SECS
            ):
                return self._id_token
            self._id_token, self._expires_at = self._mint_new_token()
            return self._id_token

    def invalidate(self) -> None:
        """Force the next ``.token()`` call to mint a fresh token."""
        with self._lock:
            self._id_token = None
            self._expires_at = 0.0

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _mint_new_token(self) -> Tuple[str, float]:
        from firebase_admin import auth as fb_auth

        # Tag the custom token with a "scanner" developer claim so the backend
        # can distinguish scanner tokens from admin/user tokens at the
        # authorisation boundary (require_scanner dependency).
        custom_token = fb_auth.create_custom_token(self._uid, {"scanner": True})
        if isinstance(custom_token, bytes):
            custom_token = custom_token.decode("ascii")

        url = (
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
            f"?key={self._web_api_key}"
        )
        try:
            resp = requests.post(
                url,
                json={"token": custom_token, "returnSecureToken": True},
                timeout=self.EXCHANGE_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f"Firebase token exchange network error: {exc}") from exc

        if resp.status_code != 200:
            raise RuntimeError(
                f"Firebase token exchange failed ({resp.status_code}): {resp.text[:300]}"
            )

        data = resp.json()
        id_token   = data["idToken"]
        expires_in = int(data.get("expiresIn", "3600"))
        expires_at = time.monotonic() + expires_in
        logger.info(
            "Firebase ID token minted (uid=%s, expires in %ds)", self._uid, expires_in,
        )
        return id_token, expires_at

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
        token_provider: Callable[[], str],
        db_path: str,
        location_provider: Callable[[], str],
        timeout: int = 10,
        max_attempts: int = 0,   # 0 = retry indefinitely
        invalidate_token: Optional[Callable[[], None]] = None,
    ):
        self._scan_url = scan_url
        self._location_provider = location_provider
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._db_path = db_path
        self._token_provider = token_provider
        self._invalidate_token = invalidate_token
        self._consecutive_401s = 0

        self._stop = threading.Event()
        self._wake = threading.Event()
        self._auth_fatal = threading.Event()

        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

        # Static headers only.  The Authorization header and scan location
        # are both resolved per request — the token provider keeps tokens
        # fresh, the location provider picks up admin-side label changes
        # without a service restart.  The User-Agent is a one-shot hostname
        # for debugging; it doesn't need to track renames.
        self._session = requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "User-Agent": f"dismissal-scanner/{location_provider()}",
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
                (plate, round(confidence, 4), self._location_provider(), iso),
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
            bearer = self._token_provider()
        except Exception as exc:
            logger.warning("Token fetch failed (attempt %d): %s", attempts + 1, exc)
            return False
        headers = {"Authorization": f"Bearer {bearer}"}
        try:
            resp = self._session.post(
                self._scan_url,
                json=payload,
                headers=headers,
                timeout=self._timeout,
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
            self._consecutive_401s = 0
            try:
                fs_id = resp.json().get("firestore_id", "?")
            except Exception:
                fs_id = "?"
            logger.info("Scan accepted: plate=%s fs_id=%s", plate, fs_id)
            return True

        if resp.status_code == 401:
            # A 401 here is usually either: (a) our cached token expired between
            # the refresh check and the actual POST, or (b) the service account
            # is genuinely revoked.  Invalidate the cached token so the *next*
            # attempt mints a fresh one; only flip auth_fatal after a second
            # consecutive 401 so systemd restart is reserved for real failures.
            self._consecutive_401s += 1
            if self._consecutive_401s == 1 and self._invalidate_token is not None:
                logger.warning(
                    "Auth rejected (401) id=%d — invalidating cached token and retrying.",
                    row_id,
                )
                try:
                    self._invalidate_token()
                except Exception as exc:
                    logger.warning("Token invalidate failed: %s", exc)
                return False

            logger.error(
                "Auth rejected (401) again after refresh — service account may "
                "be revoked.  Exiting so systemd can alert the operator.",
            )
            self._auth_fatal.set()
            return False

        # Any non-401 response counts as "auth is fine" for the streak counter.
        self._consecutive_401s = 0
        logger.warning(
            "POST HTTP %d id=%d plate=%s (attempt %d): %.200s",
            resp.status_code, row_id, plate, attempts + 1, resp.text,
        )
        return False
