"""
dismissal_health.py — Lightweight HTTP health endpoint for the Dismissal scanner node.

Exposes a single endpoint on port 9000 (configurable via HEALTH_PORT):

  GET /health
    Returns JSON with:
      - scanner service state (systemd active/failed/etc.)
      - watchdog service state
      - WiFi IP and interface
      - System uptime
      - CPU temperature (RPi-specific)
      - CPU utilisation (100 ms sampled, averaged across cores)
      - Load averages (1/5/15 min)
      - Memory usage
      - Timestamp

This lets external monitoring tools (UptimeRobot, Grafana, etc.) verify
the device is alive and the scanner is running without SSH access.

Uses only the standard library — no FastAPI/Flask overhead.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import socket
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [dismissal-health] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dismissal-health")

HEALTH_PORT = int(os.getenv("HEALTH_PORT", "9000"))
WIFI_IFACE = os.getenv("WATCHDOG_WIFI_IFACE", "wlan0")


# ---------------------------------------------------------------------------
# System metrics
# ---------------------------------------------------------------------------

def _service_state(name: str) -> str:
    try:
        r = subprocess.run(
            ["systemctl", "is-active", name],
            capture_output=True, text=True, timeout=3
        )
        return r.stdout.strip()
    except Exception:
        return "unknown"


def _wifi_ip() -> str | None:
    try:
        r = subprocess.run(
            ["ip", "-4", "addr", "show", WIFI_IFACE],
            capture_output=True, text=True, timeout=3
        )
        for line in r.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                return line.split()[1].split("/")[0]
    except Exception:
        pass
    return None


def _cpu_temp() -> float | None:
    """Read BCM2835 CPU temperature from sysfs (RPi-specific)."""
    p = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        return int(p.read_text().strip()) / 1000.0
    except Exception:
        return None


def _cpu_jiffies() -> tuple[int, int] | None:
    """Return (total, idle) jiffies from the aggregate ``cpu`` line of
    /proc/stat.  Idle includes iowait (cores stalled on I/O aren't doing
    useful work).  Returns None if /proc/stat isn't parseable."""
    try:
        line = Path("/proc/stat").read_text().splitlines()[0]
        parts = line.split()
        if parts[0] != "cpu":
            return None
        fields = [int(x) for x in parts[1:]]
        # user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        return sum(fields), idle
    except Exception:
        return None


def _cpu_percent(sample_window: float = 0.1) -> float | None:
    """Average CPU utilisation across all cores over a short window.
    Blocks for ``sample_window`` seconds so callers get an instantaneous
    reading without needing a long-running sampler thread."""
    a = _cpu_jiffies()
    if a is None:
        return None
    time.sleep(sample_window)
    b = _cpu_jiffies()
    if b is None:
        return None
    total_delta = b[0] - a[0]
    idle_delta  = b[1] - a[1]
    if total_delta <= 0:
        return 0.0
    return round((1.0 - idle_delta / total_delta) * 100.0, 1)


def _load_avg() -> dict | None:
    """1/5/15-minute load averages (Linux kernel-maintained, free to read)."""
    try:
        one, five, fifteen = Path("/proc/loadavg").read_text().split()[:3]
        return {"1m": float(one), "5m": float(five), "15m": float(fifteen)}
    except Exception:
        return None


def _uptime_seconds() -> float:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except Exception:
        return 0.0


def _memory_mb() -> dict:
    try:
        lines = Path("/proc/meminfo").read_text().splitlines()
        info = {}
        for line in lines:
            parts = line.split()
            if parts[0] in ("MemTotal:", "MemAvailable:"):
                info[parts[0].rstrip(":")] = int(parts[1]) // 1024  # kB -> MB
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", 0)
        used = total - available
        return {"total_mb": total, "used_mb": used, "available_mb": available}
    except Exception:
        return {}


def _hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


def build_status() -> dict:
    scanner_state = _service_state("dismissal-scanner")
    watchdog_state = _service_state("dismissal-watchdog")
    healthy = scanner_state == "active"

    return {
        "healthy": healthy,
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "hostname": _hostname(),
        "uptime_seconds": _uptime_seconds(),
        "services": {
            "dismissal-scanner": scanner_state,
            "dismissal-watchdog": watchdog_state,
        },
        "network": {
            "interface": WIFI_IFACE,
            "ip": _wifi_ip(),
        },
        "hardware": {
            "cpu_temp_c": _cpu_temp(),
            "cpu_percent": _cpu_percent(),
            "load_avg": _load_avg(),
            "memory": _memory_mb(),
        },
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default access log
        pass

    def do_GET(self):
        if self.path not in ("/health", "/"):
            self.send_error(404)
            return

        status = build_status()
        body = json.dumps(status, indent=2).encode()
        http_code = 200 if status["healthy"] else 503

        self.send_response(http_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run():
    server = HTTPServer(("0.0.0.0", HEALTH_PORT), HealthHandler)
    logger.info("Dismissal health endpoint listening on port %d", HEALTH_PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        logger.info("Health server stopped.")


if __name__ == "__main__":
    run()
