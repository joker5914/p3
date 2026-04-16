"""
dismissal.py — Dismissal scanner main loop.

Orchestrates:
  dismissal_camera  → frame capture (Picamera2 or OpenCV)
  dismissal_plate   → motion gate, plate detection, OCR, validate, dedup
  dismissal_api     → durable SQLite outbox, async HTTP POST

systemd integration
-------------------
* Sends READY=1 after camera and detector are initialised.
* Sends WATCHDOG=1 every WatchdogSec/2 seconds from a background thread so
  systemd restarts us if the main loop hangs.
* Sends STOPPING=1 on shutdown so systemd doesn't mark us failed.

Environment variables
---------------------
See .env.example for the full list.  Key vars:

  ENV                      'production' | 'development'
  VITE_PROD_BACKEND_URL    Backend URL when ENV=production
  VITE_DEV_BACKEND_URL     Backend URL when ENV=development
  PROD_DISMISSAL_API_TOKEN Firebase token (production)
  DEV_DISMISSAL_API_TOKEN  Firebase token (development)

  SCANNER_CAMERA_URL       RTSP/HTTP URL — overrides CAMERA_INDEX
  SCANNER_CAMERA_INDEX     int  (default 0)
  SCANNER_RESOLUTION       WxH  (default 1280x720)
  SCANNER_CAMERA_FPS       int  capture framerate (default 30)
  SCANNER_FPS_CAP          int  max frames to run through the pipeline/sec (default 10)
  SCANNER_COOLDOWN_SECS    int  suppress same plate for N seconds (default 30)
  SCANNER_MIN_CONFIDENCE   float 0–1 (default 0.70)
  SCANNER_MIN_PLATE_LEN    int  (default 4)
  SCANNER_MAX_PLATE_LEN    int  (default 8)
  SCANNER_DEBUG            bool write annotated frames to ./debug_frames/
  SCANNER_MODEL_PATH       path to EdgeTPU .tflite model
  SCANNER_LOCATION         label sent with each scan event
  SCANNER_TIMEOUT_SECS     int  HTTP timeout per attempt (default 10)
  SCANNER_OUTBOX_PATH      path to SQLite outbox db (default /var/lib/dismissal/outbox.db)
"""
from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path

import cv2
from dotenv import load_dotenv

load_dotenv()

from dismissal_api import ScanPoster
from dismissal_camera import CameraError, open_camera
from dismissal_plate import (
    MotionGate,
    PlateDeduplicator,
    PlateDetector,
    clean_plate,
    ocr_plate,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dismissal-scanner")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ENV = os.getenv("ENV", "development")
BASE_URL = (
    os.getenv("VITE_PROD_BACKEND_URL", "")
    if ENV == "production"
    else os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
)
API_TOKEN = (
    os.getenv("PROD_DISMISSAL_API_TOKEN", "")
    if ENV == "production"
    else os.getenv("DEV_DISMISSAL_API_TOKEN", "")
)
if not API_TOKEN:
    sys.exit(
        f"FATAL: {'PROD' if ENV == 'production' else 'DEV'}_DISMISSAL_API_TOKEN "
        "is not set in .env"
    )

SCAN_URL       = f"{BASE_URL}/api/v1/scan"
LOCATION       = os.getenv("SCANNER_LOCATION", "entry_scanner_1")
REQUEST_TIMEOUT = int(os.getenv("SCANNER_TIMEOUT_SECS", "10"))
CAMERA_URL     = os.getenv("SCANNER_CAMERA_URL", "")
CAMERA_INDEX   = int(os.getenv("SCANNER_CAMERA_INDEX", "0"))
_res = os.getenv("SCANNER_RESOLUTION", "1280x720").lower().split("x")
CAM_W, CAM_H   = int(_res[0]), int(_res[1])
CAM_FPS        = int(os.getenv("SCANNER_CAMERA_FPS", "30"))
FPS_CAP        = int(os.getenv("SCANNER_FPS_CAP", "10"))
COOLDOWN_SECS  = int(os.getenv("SCANNER_COOLDOWN_SECS", "30"))
MIN_CONFIDENCE = float(os.getenv("SCANNER_MIN_CONFIDENCE", "0.70"))
MIN_PLATE_LEN  = int(os.getenv("SCANNER_MIN_PLATE_LEN", "4"))
MAX_PLATE_LEN  = int(os.getenv("SCANNER_MAX_PLATE_LEN", "8"))
DEBUG          = os.getenv("SCANNER_DEBUG", "false").lower() in ("1", "true", "yes")
MODEL_PATH     = os.getenv(
    "SCANNER_MODEL_PATH",
    "/opt/dismissal/models/plate_detector_edgetpu.tflite",
)
OUTBOX_PATH    = os.getenv("SCANNER_OUTBOX_PATH", "/var/lib/dismissal/outbox.db")

if DEBUG:
    Path("debug_frames").mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# systemd sd_notify helpers
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
    except Exception as exc:
        logger.debug("sd_notify failed: %s", exc)


def _start_watchdog_pinger() -> None:
    """
    Ping systemd watchdog at half the configured WatchdogSec interval.
    WATCHDOG_USEC is exported by systemd when Type=notify and WatchdogSec is set.
    """
    watchdog_usec = int(os.getenv("WATCHDOG_USEC", "0"))
    if not watchdog_usec:
        return
    interval = max(1.0, (watchdog_usec / 1_000_000) / 2.0)

    def _ping() -> None:
        while not _shutdown.is_set():
            _sd_notify("WATCHDOG=1")
            _shutdown.wait(timeout=interval)

    threading.Thread(target=_ping, daemon=True, name="sd-watchdog").start()
    logger.debug("Watchdog pinger started (interval=%.1fs)", interval)


# ---------------------------------------------------------------------------
# Shutdown flag
# ---------------------------------------------------------------------------
_shutdown = threading.Event()


def _handle_signal(signum: int, _frame: object) -> None:
    logger.info("Signal %d received — shutting down", signum)
    _shutdown.set()


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run() -> None:
    logger.info(
        "Dismissal scanner starting — env=%s backend=%s location=%s",
        ENV, BASE_URL, LOCATION,
    )

    # Start the outbox first — replays any scans queued before a prior crash.
    poster = ScanPoster(
        scan_url=SCAN_URL,
        api_token=API_TOKEN,
        db_path=OUTBOX_PATH,
        location=LOCATION,
        timeout=REQUEST_TIMEOUT,
    )
    poster.start()

    # Open camera — retried at boot when the device isn't ready yet.
    cam = None
    for attempt in range(1, 11):
        try:
            cam = open_camera(CAMERA_URL, CAMERA_INDEX, CAM_W, CAM_H, CAM_FPS)
            break
        except CameraError as exc:
            logger.warning("Camera open failed (%d/10): %s", attempt, exc)
            if _shutdown.wait(timeout=3.0):
                break
    if cam is None:
        logger.error("Camera never became available — aborting")
        poster.stop()
        sys.exit(1)

    detector = PlateDetector(model_path=MODEL_PATH)
    motion    = MotionGate(threshold=0.003)
    dedup     = PlateDeduplicator(cooldown=COOLDOWN_SECS)

    logger.info(
        "Scanner ready: tpu=%s ocr=%s resolution=%dx%d fps_cap=%d",
        detector.tpu_enabled, True, CAM_W, CAM_H, FPS_CAP,
    )

    # Tell systemd we are ready and start the watchdog keepalive.
    _sd_notify("READY=1")
    _sd_notify(f"STATUS=Scanning — tpu={detector.tpu_enabled} loc={LOCATION}")
    _start_watchdog_pinger()

    frame_interval = 1.0 / max(1, FPS_CAP)
    last_ts = 0.0
    debug_idx = 0

    try:
        while not _shutdown.is_set():
            if poster.auth_fatal:
                logger.error(
                    "Backend token rejected — exiting so systemd can alert operator"
                )
                break

            # Sleep-based FPS pacing — avoids busy-looping when idle.
            now = time.monotonic()
            remaining = frame_interval - (now - last_ts)
            if remaining > 0:
                if _shutdown.wait(timeout=remaining):
                    break
            last_ts = time.monotonic()

            frame = cam.read()
            if frame is None:
                continue   # reader thread handles reconnect

            if not motion.has_motion(frame):
                continue

            candidates = detector.detect(frame)
            if not candidates:
                continue

            debug_frame = frame.copy() if DEBUG else None

            for crop, bbox in candidates:
                result = ocr_plate(crop)
                if result is None:
                    continue
                raw_text, conf = result
                plate = clean_plate(raw_text, MIN_PLATE_LEN, MAX_PLATE_LEN)
                if plate is None:
                    logger.debug("Rejected OCR output: %r (conf=%.2f)", raw_text, conf)
                    continue
                if conf < MIN_CONFIDENCE:
                    logger.debug("Low confidence: %s conf=%.2f", plate, conf)
                    continue
                if not dedup.is_new(plate):
                    continue

                logger.info("Plate detected: %s (conf=%.0f%%)", plate, conf * 100)
                poster.enqueue(plate, conf)

                if DEBUG and debug_frame is not None:
                    x1, y1, x2, y2 = bbox
                    cv2.rectangle(debug_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(
                        debug_frame, f"{plate} {conf:.0%}",
                        (x1, max(0, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2,
                    )

            if DEBUG and debug_frame is not None:
                cv2.imwrite(f"debug_frames/frame_{debug_idx:06d}.jpg", debug_frame)
                debug_idx += 1

            if debug_idx % 300 == 0:
                dedup.purge_old()

    finally:
        _sd_notify("STOPPING=1")
        logger.info("Flushing outbox (up to 5 s)…")
        try:
            cam.close()
        except Exception:
            pass
        poster.stop(drain_timeout=5.0)
        logger.info("Scanner stopped.")


if __name__ == "__main__":
    run()
