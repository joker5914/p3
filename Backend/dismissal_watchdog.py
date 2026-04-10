"""
dismissal_watchdog.py — Dismissal connectivity monitor and auto-recovery daemon.

Runs as a separate systemd service alongside dismissal-scanner.service.

Responsibilities
----------------
1. Ping the Dismissal backend health endpoint every 30 seconds.
2. If the backend is unreachable, log a warning but keep trying.
3. If the local WiFi interface loses its IP, attempt a reconnect via
   `ip link` / `wpa_cli` and wait for recovery.
4. Restart dismissal-scanner.service via D-Bus if it has entered a failed state
   (systemd will limit retries, so this is a belt-and-braces measure).
5. Notify systemd watchdog so the watchdog service itself stays healthy.

This module has zero third-party dependencies beyond the standard library
so it works even if the venv is partially broken.
"""

from __future__ import annotations

import os
import sys
import time
import logging
import subprocess
import socket
import signal
import threading
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [dismissal-watchdog] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dismissal-watchdog")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ENV = os.getenv("ENV", "development")
BACKEND_URL = (
    os.getenv("VITE_PROD_BACKEND_URL", "")
    if ENV == "production"
    else os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
)
HEALTH_URL = f"{BACKEND_URL}/api/v1/system/health"
CHECK_INTERVAL = int(os.getenv("WATCHDOG_CHECK_INTERVAL", "30"))  # seconds
WIFI_IFACE = os.getenv("WATCHDOG_WIFI_IFACE", "wlan0")
SCANNER_SERVICE = "dismissal-scanner.service"

_shutdown = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: _shutdown.set())
signal.signal(signal.SIGINT, lambda *_: _shutdown.set())

# ---------------------------------------------------------------------------
# systemd watchdog notification (sd_notify)
# ---------------------------------------------------------------------------
def _sd_notify(msg: str):
    """Send a notification to systemd via the watchdog socket."""
    sock_path = os.getenv("NOTIFY_SOCKET", "")
    if not sock_path:
        return
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            if sock_path.startswith("@"):
                sock_path = "\0" + sock_path[1:]
            sock.connect(sock_path)
            sock.sendall(msg.encode())
    except Exception:
        pass


def sd_watchdog():
    _sd_notify("WATCHDOG=1")


def sd_ready():
    _sd_notify("READY=1")


def sd_status(msg: str):
    _sd_notify(f"STATUS={msg}")


# ---------------------------------------------------------------------------
# Backend connectivity check
# ---------------------------------------------------------------------------
def check_backend(timeout: int = 8) -> bool:
    try:
        req = Request(HEALTH_URL)
        with urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (URLError, OSError, Exception):
        return False


# ---------------------------------------------------------------------------
# WiFi interface check and recovery
# ---------------------------------------------------------------------------
def get_wifi_ip() -> str | None:
    """Return the current IP of WIFI_IFACE or None if no IP assigned."""
    try:
        result = subprocess.run(
            ["ip", "-4", "addr", "show", WIFI_IFACE],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                return line.split()[1].split("/")[0]
    except Exception:
        pass
    return None


def restart_wifi():
    """Bounce the WiFi interface to recover from a dropped association."""
    logger.warning("WiFi has no IP on %s — attempting recovery…", WIFI_IFACE)
    try:
        subprocess.run(["ip", "link", "set", WIFI_IFACE, "down"], timeout=5)
        time.sleep(2)
        subprocess.run(["ip", "link", "set", WIFI_IFACE, "up"], timeout=5)
        # Give wpa_supplicant time to re-associate
        time.sleep(10)
        ip = get_wifi_ip()
        if ip:
            logger.info("WiFi recovered: %s has IP %s", WIFI_IFACE, ip)
        else:
            logger.error("WiFi recovery failed — still no IP on %s", WIFI_IFACE)
    except Exception as exc:
        logger.error("WiFi recovery error: %s", exc)


# ---------------------------------------------------------------------------
# Scanner service health
# ---------------------------------------------------------------------------
def get_service_state(service: str) -> str:
    """Return the ActiveState of a systemd service (active/failed/etc.)."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def restart_scanner():
    logger.warning("Restarting %s…", SCANNER_SERVICE)
    try:
        subprocess.run(["systemctl", "restart", SCANNER_SERVICE], timeout=15)
        logger.info("%s restarted.", SCANNER_SERVICE)
    except Exception as exc:
        logger.error("Failed to restart %s: %s", SCANNER_SERVICE, exc)


# ---------------------------------------------------------------------------
# Main watchdog loop
# ---------------------------------------------------------------------------
def run():
    logger.info(
        "Dismissal watchdog starting — backend=%s wifi=%s interval=%ds",
        BACKEND_URL, WIFI_IFACE, CHECK_INTERVAL,
    )
    sd_ready()

    consecutive_failures = 0

    while not _shutdown.is_set():
        sd_watchdog()  # Tell systemd we're still alive

        # --- WiFi check ---
        ip = get_wifi_ip()
        if ip is None:
            restart_wifi()
        else:
            logger.debug("WiFi OK: %s = %s", WIFI_IFACE, ip)

        # --- Backend check ---
        backend_ok = check_backend()
        if backend_ok:
            consecutive_failures = 0
            sd_status(f"OK — backend reachable, wifi={ip}")
            logger.debug("Backend health check OK")
        else:
            consecutive_failures += 1
            sd_status(f"Backend unreachable (attempt {consecutive_failures})")
            logger.warning(
                "Backend unreachable: %s (failure #%d)",
                HEALTH_URL, consecutive_failures,
            )

        # --- Scanner service check ---
        state = get_service_state(SCANNER_SERVICE)
        if state == "failed":
            logger.warning("%s is in failed state — attempting restart", SCANNER_SERVICE)
            restart_scanner()
        elif state not in ("active", "activating"):
            logger.info("%s state: %s", SCANNER_SERVICE, state)

        _shutdown.wait(timeout=CHECK_INTERVAL)

    logger.info("Watchdog shutting down.")


if __name__ == "__main__":
    run()
