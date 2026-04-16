"""
dismissal_watchdog.py — connectivity monitor and auto-recovery for the
Dismissal scanner node.

Runs as a separate systemd service alongside dismissal-scanner.service.

Responsibilities
----------------
1. Ping the Dismissal backend health endpoint every CHECK_INTERVAL seconds.
2. If the WiFi interface loses its IP, bounce it with ``sudo ip link`` and
   wait for wpa_supplicant to re-associate.
3. If dismissal-scanner.service enters a 'failed' state, restart it with
   ``sudo systemctl restart``.
4. Send WATCHDOG=1 to systemd so the watchdog service itself stays healthy.

Privilege model
---------------
The watchdog runs as the ``dismissal`` user.  The install script drops a
sudoers file (/etc/sudoers.d/dismissal-watchdog) that grants password-less
sudo for exactly the three commands used here:
  - /usr/bin/systemctl restart dismissal-scanner.service
  - /usr/sbin/ip link set <iface> up
  - /usr/sbin/ip link set <iface> down

Zero third-party Python dependencies so it works even if the venv is broken.
"""
from __future__ import annotations

import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [dismissal-watchdog] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dismissal-watchdog")

# ---------------------------------------------------------------------------
# Config (loaded from environment — set via EnvironmentFile in the unit)
# ---------------------------------------------------------------------------
ENV = os.getenv("ENV", "development")
BACKEND_URL = (
    os.getenv("VITE_PROD_BACKEND_URL", "")
    if ENV == "production"
    else os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
)
HEALTH_URL      = f"{BACKEND_URL}/api/v1/system/health"
CHECK_INTERVAL  = int(os.getenv("WATCHDOG_CHECK_INTERVAL", "30"))
WIFI_IFACE      = os.getenv("WATCHDOG_WIFI_IFACE", "wlan0")
SCANNER_SERVICE = "dismissal-scanner.service"

# ---------------------------------------------------------------------------
# Shutdown flag
# ---------------------------------------------------------------------------
_shutdown = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: _shutdown.set())
signal.signal(signal.SIGINT,  lambda *_: _shutdown.set())

# ---------------------------------------------------------------------------
# systemd sd_notify
# ---------------------------------------------------------------------------

def _sd_notify(msg: str) -> None:
    sock_path = os.getenv("NOTIFY_SOCKET", "")
    if not sock_path:
        return
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            if sock_path.startswith("@"):
                sock_path = "\0" + sock_path[1:]
            s.connect(sock_path)
            s.sendall(msg.encode())
    except Exception:
        pass


def sd_ready()          -> None: _sd_notify("READY=1")
def sd_watchdog()       -> None: _sd_notify("WATCHDOG=1")
def sd_status(msg: str) -> None: _sd_notify(f"STATUS={msg}")

# ---------------------------------------------------------------------------
# Backend connectivity
# ---------------------------------------------------------------------------

def check_backend(timeout: int = 8) -> bool:
    try:
        with urlopen(Request(HEALTH_URL), timeout=timeout) as resp:
            return resp.status == 200
    except (URLError, OSError, Exception):
        return False

# ---------------------------------------------------------------------------
# WiFi interface
# ---------------------------------------------------------------------------

def get_wifi_ip() -> str | None:
    """Return the current IPv4 of WIFI_IFACE, or None."""
    try:
        result = subprocess.run(
            ["ip", "-4", "addr", "show", WIFI_IFACE],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                return line.split()[1].split("/")[0]
    except Exception:
        pass
    return None


def restart_wifi() -> None:
    """Bounce the WiFi interface.  Requires the sudoers drop-in."""
    logger.warning("WiFi has no IP on %s — attempting recovery", WIFI_IFACE)
    try:
        subprocess.run(
            ["sudo", "/usr/sbin/ip", "link", "set", WIFI_IFACE, "down"],
            timeout=5, check=False,
        )
        time.sleep(2)
        subprocess.run(
            ["sudo", "/usr/sbin/ip", "link", "set", WIFI_IFACE, "up"],
            timeout=5, check=False,
        )
        time.sleep(10)   # wait for wpa_supplicant to re-associate
        ip = get_wifi_ip()
        if ip:
            logger.info("WiFi recovered: %s = %s", WIFI_IFACE, ip)
        else:
            logger.error("WiFi recovery failed — still no IP on %s", WIFI_IFACE)
    except Exception as exc:
        logger.error("WiFi recovery error: %s", exc)

# ---------------------------------------------------------------------------
# Scanner service
# ---------------------------------------------------------------------------

def get_service_state(service: str) -> str:
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def restart_scanner() -> None:
    """Restart the scanner service.  Requires the sudoers drop-in."""
    logger.warning("Restarting %s…", SCANNER_SERVICE)
    try:
        subprocess.run(
            ["sudo", "/usr/bin/systemctl", "restart", SCANNER_SERVICE],
            timeout=20, check=False,
        )
        logger.info("%s restarted.", SCANNER_SERVICE)
    except Exception as exc:
        logger.error("Failed to restart %s: %s", SCANNER_SERVICE, exc)

# ---------------------------------------------------------------------------
# Main watchdog loop
# ---------------------------------------------------------------------------

def run() -> None:
    logger.info(
        "Dismissal watchdog starting — backend=%s wifi=%s interval=%ds",
        BACKEND_URL, WIFI_IFACE, CHECK_INTERVAL,
    )
    sd_ready()

    consecutive_backend_failures = 0

    while not _shutdown.is_set():
        sd_watchdog()

        # --- WiFi ---
        ip = get_wifi_ip()
        if ip is None:
            restart_wifi()
        else:
            logger.debug("WiFi OK: %s = %s", WIFI_IFACE, ip)

        # --- Backend health ---
        if check_backend():
            consecutive_backend_failures = 0
            sd_status(f"OK — backend reachable wifi={ip}")
            logger.debug("Backend health OK")
        else:
            consecutive_backend_failures += 1
            sd_status(f"Backend unreachable (#{consecutive_backend_failures})")
            logger.warning(
                "Backend unreachable: %s (failure #%d)",
                HEALTH_URL, consecutive_backend_failures,
            )

        # --- Scanner service ---
        state = get_service_state(SCANNER_SERVICE)
        if state == "failed":
            logger.warning("%s in failed state — restarting", SCANNER_SERVICE)
            restart_scanner()
        elif state not in ("active", "activating"):
            logger.info("%s state: %s", SCANNER_SERVICE, state)

        _shutdown.wait(timeout=CHECK_INTERVAL)

    logger.info("Watchdog shutting down.")


if __name__ == "__main__":
    run()
