"""
dismissal_registration.py — device registration + heartbeat for the scanner.

Lifecycle
---------
1. On scanner startup, ``DeviceRegistrar.register()`` POSTs device facts
   (hostname, CPU serial, MAC, IP, firmware SHA, timestamp) to
   ``POST /api/v1/devices/register``.  The backend upserts a row in the
   ``devices`` Firestore collection keyed by hostname and returns the current
   device config — including the admin-assigned ``location`` label.
2. A background thread sends a lightweight heartbeat every
   ``HEARTBEAT_INTERVAL_SECS`` (default 5 min) to
   ``POST /api/v1/devices/heartbeat``.  The response carries the same config
   shape so the scanner can pick up location changes without a restart.

The module is best-effort: the scanner keeps running even if registration
fails (so a backend outage never takes the capture loop offline).  Callers
read the current location via ``registrar.current_location``.
"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import requests

logger = logging.getLogger("dismissal-scanner.registration")

HEARTBEAT_INTERVAL_SECS = int(os.getenv("DEVICE_HEARTBEAT_INTERVAL", "300"))
REQUEST_TIMEOUT         = int(os.getenv("DEVICE_HTTP_TIMEOUT", "10"))


# ---------------------------------------------------------------------------
# Hardware / network facts
# ---------------------------------------------------------------------------

def _read_cpu_serial() -> str:
    """Read the Pi's CPU serial from /proc/cpuinfo (unique per board)."""
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("Serial"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


def _read_primary_mac() -> str:
    """MAC of the first UP, non-loopback interface — prefer eth/wlan."""
    # Order matters: prefer built-in interfaces over virtual ones.
    for iface in ("wlan0", "eth0", "end0"):
        path = Path(f"/sys/class/net/{iface}/address")
        if path.is_file():
            try:
                return path.read_text().strip()
            except OSError:
                continue
    return ""


def _read_primary_ip() -> str:
    """Current IPv4 on the default route, or empty if no uplink."""
    try:
        # Connect-UDP trick: no packets actually sent, but the kernel fills in
        # the src addr of the default route.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return ""


def _read_firmware_sha(repo_dir: str = "/opt/dismissal") -> str:
    """Short git SHA of the currently-deployed code, or empty on failure."""
    try:
        out = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


# ---------------------------------------------------------------------------
# Registrar
# ---------------------------------------------------------------------------

class DeviceRegistrar:
    """
    Registers this device with the backend and heartbeats periodically.

    ``current_location`` reflects the most recent location string returned by
    the backend (set by an admin via the Devices page).  It starts at the
    ``initial_location`` passed in (typically the hostname) and is updated
    in-place on every successful register/heartbeat.  Reads are lock-free —
    Python assignments to a string attribute are atomic.
    """

    def __init__(
        self,
        backend_url: str,
        token_provider: Callable[[], str],
        initial_location: str,
        timeout: int = REQUEST_TIMEOUT,
    ) -> None:
        self._register_url  = f"{backend_url.rstrip('/')}/api/v1/devices/register"
        self._heartbeat_url = f"{backend_url.rstrip('/')}/api/v1/devices/heartbeat"
        self._token_provider = token_provider
        self._timeout = timeout
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None

        self.hostname        = socket.gethostname()
        self.current_location = initial_location

        # Cache hardware facts at construction — they don't change between
        # boots so there's no point re-reading on every heartbeat.
        self._device_facts = {
            "hostname":      self.hostname,
            "cpu_serial":    _read_cpu_serial(),
            "mac_address":   _read_primary_mac(),
            "firmware_sha":  _read_firmware_sha(),
        }

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def register(self) -> bool:
        """
        One-shot registration at startup.  Returns True on success.
        Failures are logged but non-fatal — the scanner continues.
        """
        payload = {
            **self._device_facts,
            "ip_address":  _read_primary_ip(),
            "started_at":  _iso_now(),
        }
        return self._post(self._register_url, payload, op="register")

    def start_heartbeat(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(
            target=self._heartbeat_loop,
            daemon=True,
            name="device-heartbeat",
        )
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            self._worker.join(timeout=2)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _heartbeat_loop(self) -> None:
        logger.info(
            "Heartbeat loop starting (interval=%ds)", HEARTBEAT_INTERVAL_SECS,
        )
        while not self._stop.wait(timeout=HEARTBEAT_INTERVAL_SECS):
            payload = {
                "hostname":   self.hostname,
                "ip_address": _read_primary_ip(),
                "sent_at":    _iso_now(),
            }
            self._post(self._heartbeat_url, payload, op="heartbeat")
        logger.info("Heartbeat loop stopped.")

    def _post(self, url: str, payload: dict, *, op: str) -> bool:
        try:
            bearer = self._token_provider()
        except Exception as exc:
            logger.warning("%s: token fetch failed: %s", op, exc)
            return False
        try:
            resp = requests.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type":  "application/json",
                    "User-Agent":    f"dismissal-scanner/{self.hostname}",
                },
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            logger.warning("%s: network error: %s", op, exc)
            return False

        if resp.status_code != 200:
            logger.warning(
                "%s: HTTP %d — %.200s", op, resp.status_code, resp.text,
            )
            return False

        # Apply any config changes the backend returned.
        try:
            data = resp.json() or {}
        except ValueError:
            data = {}
        new_location = (data.get("config") or {}).get("location")
        if new_location and new_location != self.current_location:
            logger.info(
                "Location updated by backend: %s → %s",
                self.current_location, new_location,
            )
            self.current_location = new_location
        logger.debug("%s OK (location=%s)", op, self.current_location)
        return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(tz=timezone.utc).isoformat()
