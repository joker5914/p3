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

  ENV                          'production' | 'development'
  VITE_PROD_BACKEND_URL        Backend URL when ENV=production
  VITE_DEV_BACKEND_URL         Backend URL when ENV=development
  FIREBASE_SERVICE_ACCOUNT_JSON  Path to the scanner's Firebase SA JSON
  FIREBASE_WEB_API_KEY         Firebase Web API key (public, from Firebase console)
  SCANNER_DEVICE_UID           Custom UID used when minting tokens (default: hostname)

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

import base64
import logging
import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Thread-count env BEFORE numpy/opencv/onnx import so they pick it up.  These
# libraries read the env once at import; setting them here gives every CPU
# tensor op (motion gate, YOLO, fast-plate-ocr) all four Pi 5 cores instead
# of the aarch64 default of one.  Can be overridden via the real env.
# ---------------------------------------------------------------------------
_default_threads = str(os.cpu_count() or 4)
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, _default_threads)

import cv2
from dotenv import load_dotenv

load_dotenv()

import scanner_config
from dismissal_api import FirebaseTokenManager, ScanPoster
from dismissal_camera import CameraError, open_camera
from dismissal_registration import DeviceRegistrar
from dismissal_plate import (
    MotionGate,
    PlateConfirmer,
    PlateDeduplicator,
    PlateDetector,
    _get_fast_plate_ocr,
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
# Backend URL + Firebase Web API key are committed constants in scanner_config.
# Environment variables override them at runtime for development.
BASE_URL             = scanner_config.backend_url(ENV)
FIREBASE_WEB_API_KEY = scanner_config.FIREBASE_WEB_API_KEY

# Per-device secret lives on disk; set via prepare-sdcard.sh --service-account-json.
FIREBASE_SA_PATH = os.getenv(
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "/opt/dismissal/Backend/firebase-scanner-sa.json",
)
# UID used when minting custom tokens — defaults to the device hostname so
# scanners show up as distinct identities in Firebase Auth.
SCANNER_DEVICE_UID = os.getenv("SCANNER_DEVICE_UID", "") or socket.gethostname()

if FIREBASE_WEB_API_KEY.startswith("REPLACE_"):
    sys.exit(
        "FATAL: FIREBASE_WEB_API_KEY is not configured in Backend/scanner_config.py "
        "(or overridden via env)."
    )
if not Path(FIREBASE_SA_PATH).is_file():
    sys.exit(f"FATAL: Firebase service-account JSON not found at {FIREBASE_SA_PATH}")

SCAN_URL       = f"{BASE_URL}/api/v1/scan"
# Location is resolved in this order:
#   1. explicit SCANNER_LOCATION env var (operator override)
#   2. value returned by /devices/register when the scanner checks in
#   3. the device hostname (deterministic fallback)
LOCATION       = os.getenv("SCANNER_LOCATION", "") or socket.gethostname()
REQUEST_TIMEOUT = int(os.getenv("SCANNER_TIMEOUT_SECS", "10"))
CAMERA_URL     = os.getenv("SCANNER_CAMERA_URL", "")
CAMERA_INDEX   = int(os.getenv("SCANNER_CAMERA_INDEX", "0"))
_res = os.getenv("SCANNER_RESOLUTION", "1280x720").lower().split("x")
CAM_W, CAM_H   = int(_res[0]), int(_res[1])
CAM_FPS        = int(os.getenv("SCANNER_CAMERA_FPS", "30"))
FPS_CAP        = int(os.getenv("SCANNER_FPS_CAP", "10"))
COOLDOWN_SECS  = int(os.getenv("SCANNER_COOLDOWN_SECS", "30"))
MIN_CONFIDENCE = float(os.getenv("SCANNER_MIN_CONFIDENCE", "0.85"))
# N-of-M frame-agreement filter — a plate must OCR the same way on
# ``CONFIRM_MIN_HITS`` of the last ``CONFIRM_WINDOW`` observations
# (within ``CONFIRM_TTL_SECS``) before it's forwarded.  Cuts character-
# flip noise (6↔G, 0↔D) where the correct plate still dominates.
CONFIRM_MIN_HITS  = int(os.getenv("SCANNER_CONFIRM_MIN_HITS", "2"))
CONFIRM_WINDOW    = int(os.getenv("SCANNER_CONFIRM_WINDOW", "5"))
CONFIRM_TTL_SECS  = float(os.getenv("SCANNER_CONFIRM_TTL_SECS", "5.0"))
# Cap how many OCR passes we'll do per frame — noisy YOLO frames can
# return a dozen candidates.  Top-confidence ones first; the rest are
# dropped to keep the main loop snappy.
MAX_OCR_PER_FRAME = int(os.getenv("SCANNER_MAX_OCR_PER_FRAME", "3"))
MIN_PLATE_LEN  = int(os.getenv("SCANNER_MIN_PLATE_LEN", "4"))
MAX_PLATE_LEN  = int(os.getenv("SCANNER_MAX_PLATE_LEN", "8"))
DEBUG          = os.getenv("SCANNER_DEBUG", "false").lower() in ("1", "true", "yes")
MODEL_PATH     = os.getenv(
    "SCANNER_MODEL_PATH",
    "/opt/dismissal/models/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite",
)
# CPU fallback variant — used when no Coral is plugged in or pycoral/tflite
# can't load the TPU delegate.  Defaults to the edgetpu path with the suffix
# stripped, so one install script that ships both files "just works".
MODEL_PATH_CPU = os.getenv(
    "SCANNER_MODEL_PATH_CPU",
    "/opt/dismissal/models/ssd_mobilenet_v2_coco_quant_postprocess.tflite",
)
# Preferred detector: a YOLOv8 ONNX model trained specifically on
# license plates.  When a file exists here and onnxruntime is
# installed, it takes over from the generic SSD vehicle detector —
# works for close-ups where no full vehicle is visible.  Install with
# deploy/install_plate_model.sh.
PLATE_MODEL_PATH = os.getenv(
    "SCANNER_PLATE_MODEL_PATH",
    "/opt/dismissal/models/plate_yolo.onnx",
)
# Edge TPU is off by default because some libcamera/ai-edge-litert/libedgetpu
# combinations SEGV in the delegate instead of raising a catchable Python
# exception.  Flip to 1 once you've verified with the diagnostic script
# that delegate loading works in isolation on your Pi.
USE_EDGETPU = os.getenv("SCANNER_USE_EDGETPU", "0").strip() in ("1", "true", "yes")
# Raspberry Pi AI HAT+ (Hailo-8L) offload.  Compile a .hef with
# Hailo's Dataflow Compiler and drop it at PLATE_MODEL_HEF_PATH, then
# set SCANNER_USE_HAILO=1.  deploy/install_hailo_model.sh has steps.
USE_HAILO  = os.getenv("SCANNER_USE_HAILO", "0").strip() in ("1", "true", "yes")
PLATE_MODEL_HEF_PATH = os.getenv(
    "SCANNER_PLATE_MODEL_HEF_PATH",
    "/opt/dismissal/models/plate_yolo.hef",
)
OUTBOX_PATH    = os.getenv("SCANNER_OUTBOX_PATH", "/var/lib/dismissal/outbox.db")
# Thumbnail for the admin Dashboard — annotated JPEG at ~320 wide.
# JPEG quality 70 gives ~12–18 KB per thumbnail; base64 adds ~33%.
THUMB_WIDTH    = int(os.getenv("SCANNER_THUMB_WIDTH", "320"))
THUMB_QUALITY  = int(os.getenv("SCANNER_THUMB_QUALITY", "70"))
# Don't spam the backend with unrecognized reports; one every N seconds per
# scanner is plenty for diagnostic visibility.
UNREC_COOLDOWN = int(os.getenv("SCANNER_UNRECOGNIZED_COOLDOWN", "10"))
# Minimum OCR confidence required *even for unrecognized scans* — suppresses
# frames where Tesseract returned empty / garbage so the admin Dashboard
# doesn't fill up with 0% "Unknown Vehicle" entries.  Set to 0 to post
# every near-miss for visual debugging.
MIN_UNREC_CONFIDENCE = float(os.getenv("SCANNER_MIN_UNRECOGNIZED_CONFIDENCE", "0.60"))
# LAN-only debug HTTP view — http://<pi>:$SCANNER_DEBUG_PORT/ shows the
# live camera feed with detection overlays so an operator can confirm
# the scanner is actually seeing vehicles.  Set to 0 to disable.
DEBUG_STREAM_PORT = int(os.getenv("SCANNER_DEBUG_PORT", "8081"))
# Optional manual focus for fixed installations.  LensPosition is in
# diopters (1 / distance_in_metres).  Examples: 0.0 = infinity, 0.2 = 5 m,
# 0.33 = 3 m, 1.0 = 1 m.  Leave blank to use continuous autofocus with
# motion-guided AF windows.
_lens_raw = os.getenv("SCANNER_LENS_POSITION", "").strip()
LENS_POSITION: float | None = float(_lens_raw) if _lens_raw else None
# Rate-limit AF window updates — libcamera does not love being hammered
# with AfWindows changes every frame, and it can block convergence.
AF_WINDOW_UPDATE_MIN_SECS = float(os.getenv("SCANNER_AF_WINDOW_UPDATE_SECS", "0.75"))

if DEBUG:
    Path("debug_frames").mkdir(exist_ok=True)


def _encode_thumbnail(frame, bboxes, label=None):
    """Annotate ``frame`` with the candidate bboxes (+ optional label) and
    return it as a base64-encoded JPEG string ready for the backend.  Returns
    None on any encoding failure — thumbnails are a nice-to-have, not
    load-bearing."""
    try:
        annotated = frame.copy()
        for (x1, y1, x2, y2) in bboxes or ():
            cv2.rectangle(annotated, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
        if label:
            cv2.putText(
                annotated, label, (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2, cv2.LINE_AA,
            )
        h, w = annotated.shape[:2]
        if w > THUMB_WIDTH:
            scale = THUMB_WIDTH / float(w)
            annotated = cv2.resize(
                annotated, (THUMB_WIDTH, int(h * scale)),
                interpolation=cv2.INTER_AREA,
            )
        ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, THUMB_QUALITY])
        if not ok:
            return None
        return base64.b64encode(buf.tobytes()).decode("ascii")
    except Exception as exc:
        logger.debug("Thumbnail encode failed: %s", exc)
        return None

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

    # Mint the first Firebase ID token before we start posting — fails fast if
    # the service account / web key / UID combo is wrong.
    token_mgr = FirebaseTokenManager(
        service_account_json_path=FIREBASE_SA_PATH,
        web_api_key=FIREBASE_WEB_API_KEY,
        device_uid=SCANNER_DEVICE_UID,
    )
    # Prime the cache so config errors surface during startup, not after the
    # first scan event queues up.
    token_mgr.token()

    # Register this device with the backend.  Non-fatal if the backend is
    # unreachable — the capture loop still runs, we just retry on heartbeat.
    registrar = DeviceRegistrar(
        backend_url=BASE_URL,
        token_provider=token_mgr.token,
        initial_location=LOCATION,
    )
    if registrar.register():
        logger.info(
            "Registered with backend as hostname=%s location=%s",
            registrar.hostname, registrar.current_location,
        )
    else:
        logger.warning(
            "Backend registration failed at startup — will retry via heartbeat.",
        )
    registrar.start_heartbeat()

    # Start the outbox — replays any scans queued before a prior crash.
    # Location is sourced from the registrar so admin-side changes flow through
    # without a service restart.
    poster = ScanPoster(
        scan_url=SCAN_URL,
        token_provider=token_mgr.token,
        invalidate_token=token_mgr.invalidate,
        db_path=OUTBOX_PATH,
        location_provider=lambda: registrar.current_location,
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

    detector = PlateDetector(
        model_path=MODEL_PATH,
        cpu_model_path=MODEL_PATH_CPU,
        plate_model_path=PLATE_MODEL_PATH,
        plate_hef_path=PLATE_MODEL_HEF_PATH,
        use_edgetpu=USE_EDGETPU,
        use_hailo=USE_HAILO,
    )
    motion    = MotionGate(threshold=0.003)
    dedup     = PlateDeduplicator(cooldown=COOLDOWN_SECS)
    confirmer = PlateConfirmer(
        window=CONFIRM_WINDOW,
        min_hits=CONFIRM_MIN_HITS,
        ttl=CONFIRM_TTL_SECS,
    )

    # Eager-load fast-plate-ocr (~500 ms-1 s download + warmup on first
    # call) so the first real car doesn't stutter mid-capture.  Safe to
    # call repeatedly; returns None if the library isn't installed.
    try:
        _get_fast_plate_ocr()
    except Exception as exc:
        logger.warning("fast-plate-ocr preload failed: %s", exc)

    # Fixed-focus override for permanent installations (e.g. an entrance
    # lane where every vehicle passes at roughly the same distance).
    if LENS_POSITION is not None:
        try:
            cam.set_manual_focus(LENS_POSITION)
        except Exception as exc:
            logger.warning("Manual focus request failed: %s", exc)

    # Optional LAN-only live debug view.  Disabled when port == 0.
    debug_stream = None
    if DEBUG_STREAM_PORT > 0:
        try:
            from dismissal_debug_stream import DebugStream
            debug_stream = DebugStream(port=DEBUG_STREAM_PORT)
            debug_stream.start()
        except Exception as exc:
            logger.warning(
                "Debug stream failed to start on port %d (%s) — scanner continues.",
                DEBUG_STREAM_PORT, exc,
            )
            debug_stream = None

    logger.info(
        "Scanner ready: backend=%s ocr=%s resolution=%dx%d fps_cap=%d debug_port=%s",
        detector.backend, True, CAM_W, CAM_H, FPS_CAP,
        DEBUG_STREAM_PORT if debug_stream else "off",
    )

    # Tell systemd we are ready and start the watchdog keepalive.
    _sd_notify("READY=1")
    _sd_notify(f"STATUS=Scanning — backend={detector.backend} loc={LOCATION}")
    _start_watchdog_pinger()

    frame_interval = 1.0 / max(1, FPS_CAP)
    last_ts = 0.0
    debug_idx = 0
    _last_unrec_ts = 0.0
    # Throttle AF window updates so libcamera can actually converge.
    _last_af_update = 0.0
    _last_af_bbox: tuple | None = None

    # Stats counters — logged every STATS_INTERVAL seconds
    STATS_INTERVAL = 60.0
    _stats_ts    = time.monotonic()
    _frames_seen = 0
    _plates_seen = 0
    _unrec_seen  = 0
    _motion_skip = 0

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

            _frames_seen += 1

            if not motion.has_motion(frame):
                _motion_skip += 1
                if debug_stream is not None:
                    debug_stream.update(frame, motion=False)
                continue

            # Point autofocus at the moving region so the lens snaps to
            # the vehicle and not the wall behind it.  Only when we're
            # in continuous-AF mode (manual focus owns the lens).
            if LENS_POSITION is None and motion.last_bbox is not None:
                now_af = time.monotonic()
                if (now_af - _last_af_update) >= AF_WINDOW_UPDATE_MIN_SECS:
                    try:
                        cam.set_af_window(
                            motion.last_bbox, frame_size=(frame.shape[1], frame.shape[0]),
                        )
                        _last_af_update = now_af
                        _last_af_bbox = motion.last_bbox
                    except Exception:
                        pass

            candidates = detector.detect(frame)
            if not candidates:
                if debug_stream is not None:
                    debug_stream.update(frame, motion=True, candidates=[])
                continue
            # Cap the number of OCR passes per frame — noisy frames
            # can produce many low-quality candidates that only drag
            # the main loop down.  YOLO candidates aren't ordered by
            # confidence here, so just take the first N by area as a
            # rough quality proxy (bigger = usually sharper OCR).
            if len(candidates) > MAX_OCR_PER_FRAME:
                candidates = sorted(
                    candidates,
                    key=lambda c: (c[1][2] - c[1][0]) * (c[1][3] - c[1][1]),
                    reverse=True,
                )[:MAX_OCR_PER_FRAME]

            debug_frame = frame.copy() if DEBUG else None

            # Try every candidate crop; remember the "best" unrecognized
            # attempt so we can attach it to the fallback unrecognized-scan
            # post.  "Best" = highest confidence among the rejects.
            recognized_this_frame = False
            best_reject_guess: str | None = None
            best_reject_conf:  float = 0.0
            best_reject_reason: str | None = None
            # Accepted plates for the debug overlay (plate, conf, bbox).
            accepted_plates: list[tuple[str, float, tuple[int, int, int, int]]] = []

            for crop, bbox in candidates:
                result = ocr_plate(crop)
                if result is None:
                    # ocr_plate() returns None on blur-gate reject too
                    best_reject_reason = best_reject_reason or "blurry_or_ocr_empty"
                    continue
                raw_text, conf = result
                plate = clean_plate(raw_text, MIN_PLATE_LEN, MAX_PLATE_LEN)
                if plate is None:
                    logger.debug("Rejected OCR output: %r (conf=%.2f)", raw_text, conf)
                    if conf > best_reject_conf:
                        best_reject_conf   = conf
                        best_reject_guess  = raw_text
                        best_reject_reason = "bad_length_or_chars"
                    continue
                if conf < MIN_CONFIDENCE:
                    logger.debug("Low confidence: %s conf=%.2f", plate, conf)
                    if conf > best_reject_conf:
                        best_reject_conf   = conf
                        best_reject_guess  = plate
                        best_reject_reason = "low_confidence"
                    continue
                # Frame-agreement gate — don't forward until we've seen
                # this same plate text on enough recent frames.
                if not confirmer.observe(plate):
                    # Treat as recognized-pending so we don't also emit
                    # an unrecognized scan for this frame; the plate
                    # may still confirm on the next observation.
                    recognized_this_frame = True
                    logger.debug(
                        "Confirmation pending for plate=%s conf=%.2f",
                        plate, conf,
                    )
                    continue
                if not dedup.is_new(plate):
                    recognized_this_frame = True
                    continue

                logger.info("Plate detected: %s (conf=%.0f%%)", plate, conf * 100)
                _plates_seen += 1
                recognized_this_frame = True
                accepted_plates.append((plate, conf, bbox))
                thumb = _encode_thumbnail(
                    frame, [bbox], label=f"{plate} {conf:.0%}",
                )
                poster.enqueue(plate, conf, thumbnail_b64=thumb)

                if DEBUG and debug_frame is not None:
                    x1, y1, x2, y2 = bbox
                    cv2.rectangle(debug_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(
                        debug_frame, f"{plate} {conf:.0%}",
                        (x1, max(0, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2,
                    )

            # If nothing from this frame qualified as a recognized plate but
            # we *did* see plate-shaped regions, post one unrecognized scan
            # so the admin Dashboard surfaces a thumbnail — this is what
            # lets operators visually debug "I was here but nothing showed up".
            # Cooldown prevents flooding the backend when a parked car sits
            # in frame.
            if (
                not recognized_this_frame
                and candidates
                and best_reject_conf >= MIN_UNREC_CONFIDENCE
                and (time.monotonic() - _last_unrec_ts) >= UNREC_COOLDOWN
            ):
                thumb = _encode_thumbnail(
                    frame,
                    [b for _, b in candidates],
                    label=best_reject_guess or "unrecognized",
                )
                poster.enqueue_unrecognized(
                    ocr_guess=best_reject_guess,
                    confidence=best_reject_conf,
                    reason=best_reject_reason or "no_ocr_match",
                    thumbnail_b64=thumb,
                )
                _unrec_seen += 1
                _last_unrec_ts = time.monotonic()

            if debug_stream is not None:
                debug_stream.update(
                    frame,
                    motion=True,
                    candidates=candidates,
                    accepted_plates=accepted_plates,
                    vehicle_boxes=detector.last_vehicle_boxes,
                    reject_reason=best_reject_reason if not recognized_this_frame else None,
                    reject_guess=best_reject_guess if not recognized_this_frame else None,
                    reject_conf=best_reject_conf if not recognized_this_frame else None,
                )

            if DEBUG and debug_frame is not None:
                cv2.imwrite(f"debug_frames/frame_{debug_idx:06d}.jpg", debug_frame)
                debug_idx += 1

            if debug_idx % 300 == 0:
                dedup.purge_old()

            # Periodic stats log
            now2 = time.monotonic()
            elapsed = now2 - _stats_ts
            if elapsed >= STATS_INTERVAL:
                fps_actual = _frames_seen / elapsed if elapsed > 0 else 0
                ppm = (_plates_seen / elapsed) * 60 if elapsed > 0 else 0
                upm = (_unrec_seen / elapsed) * 60 if elapsed > 0 else 0
                logger.info(
                    "Stats: fps=%.1f plates/min=%.1f unrec/min=%.1f motion_skip=%d outbox=%d",
                    fps_actual, ppm, upm, _motion_skip, poster._pending_count(),
                )
                _sd_notify(
                    f"STATUS=fps={fps_actual:.1f} plates/min={ppm:.1f} "
                    f"unrec/min={upm:.1f} outbox={poster._pending_count()} "
                    f"backend={detector.backend}"
                )
                _stats_ts    = now2
                _frames_seen = 0
                _plates_seen = 0
                _unrec_seen  = 0
                _motion_skip = 0

    finally:
        _sd_notify("STOPPING=1")
        logger.info("Flushing outbox (up to 5 s)…")
        if debug_stream is not None:
            debug_stream.stop()
        try:
            cam.close()
        except Exception:
            pass
        registrar.stop()
        poster.stop(drain_timeout=5.0)
        logger.info("Scanner stopped.")


if __name__ == "__main__":
    run()
