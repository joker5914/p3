"""
p3.py — Raspberry Pi + Google Coral TPU licence plate scanner for P3.

Pipeline
--------
1. Capture frames from a USB/CSI camera (or RTSP stream).
2. Motion gate  — skip OCR on static frames to save CPU/TPU cycles.
3. Plate detect — find candidate plate regions via contour analysis.
4. OCR          — extract text with Tesseract (psm 8, alphanumeric).
5. Validate     — clean the string, reject implausible results.
6. Dedup        — suppress the same plate within a cooldown window.
7. POST         — send to P3 backend with retry + exponential back-off.

Coral TPU
---------
If pycoral is installed and a TPU is detected the pipeline uses an
EdgeTPU-compiled object detection model to localise plates before OCR,
yielding much better recall in busy scenes.  When the TPU is absent the
code falls back to the pure OpenCV contour detector automatically.

Environment variables
---------------------
See .env.example for the full list.  Key scanner vars:

  SCANNER_CAMERA_INDEX    int   Camera device index (default 0)
  SCANNER_CAMERA_URL      str   RTSP/HTTP URL overrides CAMERA_INDEX
  SCANNER_RESOLUTION      str   WxH, e.g. 1280x720 (default 1280x720)
  SCANNER_FPS_CAP         int   Max frames to process per second (default 10)
  SCANNER_COOLDOWN_SECS   int   Ignore same plate within N seconds (default 30)
  SCANNER_MIN_CONFIDENCE  float Minimum OCR confidence 0-1 (default 0.7)
  SCANNER_MIN_PLATE_LEN   int   Shortest valid plate string (default 4)
  SCANNER_MAX_PLATE_LEN   int   Longest valid plate string (default 8)
  SCANNER_DEBUG           bool  Write annotated frames to ./debug_frames/
  SCANNER_MODEL_PATH      str   Path to EdgeTPU .tflite model (optional)
  SCANNER_LOCATION        str   Label sent with each scan event
  SCANNER_TIMEOUT_SECS    int   HTTP timeout per attempt (default 10)
  SCANNER_MAX_RETRIES     int   HTTP retry attempts (default 5)
"""

from __future__ import annotations

import os
import re
import sys
import time
import queue
import signal
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("p3-scanner")

# ---------------------------------------------------------------------------
# Config from environment
# ---------------------------------------------------------------------------
ENV = os.getenv("ENV", "development")
BASE_URL = (
    os.getenv("VITE_PROD_BACKEND_URL", "")
    if ENV == "production"
    else os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
)
API_TOKEN = (
    os.getenv("PROD_P3_API_TOKEN", "")
    if ENV == "production"
    else os.getenv("DEV_P3_API_TOKEN", "")
)
if not API_TOKEN:
    raise RuntimeError(
        f"{'PROD' if ENV == 'production' else 'DEV'}_P3_API_TOKEN is not set in .env"
    )

SCAN_URL = f"{BASE_URL}/api/v1/scan"
LOCATION = os.getenv("SCANNER_LOCATION", "entry_scanner_1")
REQUEST_TIMEOUT = int(os.getenv("SCANNER_TIMEOUT_SECS", "10"))
MAX_RETRIES = int(os.getenv("SCANNER_MAX_RETRIES", "5"))

CAMERA_URL = os.getenv("SCANNER_CAMERA_URL", "")          # RTSP/HTTP URL if set
CAMERA_INDEX = int(os.getenv("SCANNER_CAMERA_INDEX", "0")) # USB/CSI index fallback
_res = os.getenv("SCANNER_RESOLUTION", "1280x720").lower().split("x")
CAM_W, CAM_H = int(_res[0]), int(_res[1])
FPS_CAP = int(os.getenv("SCANNER_FPS_CAP", "10"))          # frames to process/sec
COOLDOWN_SECS = int(os.getenv("SCANNER_COOLDOWN_SECS", "30"))
MIN_CONFIDENCE = float(os.getenv("SCANNER_MIN_CONFIDENCE", "0.70"))
MIN_PLATE_LEN = int(os.getenv("SCANNER_MIN_PLATE_LEN", "4"))
MAX_PLATE_LEN = int(os.getenv("SCANNER_MAX_PLATE_LEN", "8"))
DEBUG = os.getenv("SCANNER_DEBUG", "false").lower() in ("1", "true", "yes")
MODEL_PATH = os.getenv("SCANNER_MODEL_PATH", "")           # EdgeTPU .tflite model

if DEBUG:
    Path("debug_frames").mkdir(exist_ok=True)
    logger.info("Debug mode ON — annotated frames → ./debug_frames/")

# ---------------------------------------------------------------------------
# Try to import Tesseract OCR
# ---------------------------------------------------------------------------
try:
    import pytesseract
    from PIL import Image as PILImage
    TESSERACT_OK = True
    logger.info("Tesseract OCR available")
except ImportError:
    TESSERACT_OK = False
    logger.warning(
        "pytesseract / Pillow not installed — OCR disabled. "
        "Install with: pip install pytesseract pillow"
    )

# ---------------------------------------------------------------------------
# Try to import Google Coral PyCoral (TPU acceleration)
# ---------------------------------------------------------------------------
TPU_OK = False
interpreter = None

if MODEL_PATH and Path(MODEL_PATH).exists():
    try:
        from pycoral.utils import edgetpu
        from pycoral.adapters import common as coral_common
        from pycoral.adapters import detect as coral_detect

        _tpu_devices = edgetpu.list_edge_tpus()
        if _tpu_devices:
            interpreter = edgetpu.make_interpreter(MODEL_PATH)
            interpreter.allocate_tensors()
            TPU_OK = True
            logger.info("Coral TPU initialised with model: %s", MODEL_PATH)
        else:
            logger.warning("SCANNER_MODEL_PATH set but no Coral TPU detected — using CPU fallback")
    except Exception as exc:
        logger.warning("Coral TPU init failed (%s) — using CPU fallback", exc)
else:
    if MODEL_PATH:
        logger.warning("SCANNER_MODEL_PATH '%s' not found — using CPU fallback", MODEL_PATH)
    else:
        logger.info("No SCANNER_MODEL_PATH set — using OpenCV contour detector")

# ---------------------------------------------------------------------------
# HTTP session
# ---------------------------------------------------------------------------
session = requests.Session()
session.headers.update({
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
})

# ---------------------------------------------------------------------------
# Shutdown flag
# ---------------------------------------------------------------------------
_shutdown = threading.Event()

def _handle_signal(sig, frame):  # noqa: ARG001
    logger.info("Shutdown signal received")
    _shutdown.set()

signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)

# ===========================================================================
# 1. Camera capture
# ===========================================================================

def open_camera() -> cv2.VideoCapture:
    """Open the camera source and configure resolution."""
    source = CAMERA_URL if CAMERA_URL else CAMERA_INDEX
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera source: {source!r}")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAM_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)   # keep buffer minimal to get latest frame
    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    logger.info("Camera opened: source=%r resolution=%dx%d", source, actual_w, actual_h)
    return cap


# ===========================================================================
# 2. Motion gate
# ===========================================================================

class MotionGate:
    """
    Skip OCR when the scene is static.  Uses frame-differencing; only
    passes frames where enough pixels changed since the last processed frame.
    """
    def __init__(self, threshold: float = 0.005):
        # threshold = fraction of pixels that must differ
        self._prev_gray: Optional[np.ndarray] = None
        self._threshold = threshold

    def has_motion(self, frame: np.ndarray) -> bool:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (11, 11), 0)
        if self._prev_gray is None:
            self._prev_gray = gray
            return True
        delta = cv2.absdiff(self._prev_gray, gray)
        _, thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)
        motion_fraction = np.count_nonzero(thresh) / thresh.size
        self._prev_gray = gray
        return motion_fraction > self._threshold


# ===========================================================================
# 3a. Plate detection — OpenCV contour method (CPU fallback)
# ===========================================================================

def _preprocess_for_plates(frame: np.ndarray) -> np.ndarray:
    """Return a binarised image highlighting rectangular regions."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Bilateral filter preserves edges while smoothing noise
    filtered = cv2.bilateralFilter(gray, 11, 17, 17)
    edges = cv2.Canny(filtered, 30, 200)
    return edges


def detect_plates_contour(frame: np.ndarray) -> list[np.ndarray]:
    """
    Return a list of cropped plate candidate images using contour analysis.

    Heuristics:
      - Bounding box aspect ratio  2:1 – 6:1  (most plates are wider than tall)
      - Minimum area of 1 500 px²  (filters out noise)
      - Maximum area 15 % of frame (filters out entire-frame matches)
    """
    edges = _preprocess_for_plates(frame)
    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    # Sort largest-first so we process the most likely plates early
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:20]

    frame_area = frame.shape[0] * frame.shape[1]
    candidates = []

    for contour in contours:
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.018 * peri, True)
        # Plates approximate to a 4-point polygon
        if len(approx) != 4:
            continue
        x, y, w, h = cv2.boundingRect(approx)
        area = w * h
        if area < 1500 or area > 0.15 * frame_area:
            continue
        aspect = w / h
        if not (2.0 <= aspect <= 6.0):
            continue
        # Add a small margin around the detected region
        margin = 6
        x1 = max(0, x - margin)
        y1 = max(0, y - margin)
        x2 = min(frame.shape[1], x + w + margin)
        y2 = min(frame.shape[0], y + h + margin)
        crop = frame[y1:y2, x1:x2]
        if crop.size > 0:
            candidates.append((crop, (x1, y1, x2, y2)))

    return candidates


# ===========================================================================
# 3b. Plate detection — Coral TPU object detection method
# ===========================================================================

def detect_plates_tpu(frame: np.ndarray) -> list[np.ndarray]:
    """
    Use the EdgeTPU interpreter to detect licence plates.
    Requires an EdgeTPU-compiled SSD/YOLO tflite model whose output includes
    bounding boxes scored with a 'licence plate' class label.
    Falls back to contour method if inference fails.
    """
    try:
        from pycoral.adapters import common as coral_common
        from pycoral.adapters import detect as coral_detect

        _, input_h, input_w, _ = interpreter.get_input_details()[0]["shape"]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (input_w, input_h))
        coral_common.set_input(interpreter, resized)
        interpreter.invoke()
        objs = coral_detect.get_objects(interpreter, score_threshold=0.4)

        fh, fw = frame.shape[:2]
        candidates = []
        for obj in objs:
            bbox = obj.bbox
            x1 = max(0, int(bbox.xmin * fw))
            y1 = max(0, int(bbox.ymin * fh))
            x2 = min(fw, int(bbox.xmax * fw))
            y2 = min(fh, int(bbox.ymax * fh))
            crop = frame[y1:y2, x1:x2]
            if crop.size > 0:
                candidates.append((crop, (x1, y1, x2, y2)))
        return candidates
    except Exception as exc:
        logger.debug("TPU inference error: %s — falling back to contour", exc)
        return detect_plates_contour(frame)


def detect_plates(frame: np.ndarray) -> list[tuple[np.ndarray, tuple]]:
    """Dispatch to TPU or contour detector based on availability."""
    if TPU_OK:
        return detect_plates_tpu(frame)
    return detect_plates_contour(frame)


# ===========================================================================
# 4. OCR
# ===========================================================================

def _enhance_for_ocr(crop: np.ndarray) -> np.ndarray:
    """
    Pre-process a plate crop to improve Tesseract accuracy.
    Steps: upscale → greyscale → denoise → threshold → border
    """
    # Upscale small crops — Tesseract works better at ~150 dpi+ effective res
    h, w = crop.shape[:2]
    scale = max(1, int(180 / h))  # target ~180px tall
    if scale > 1:
        crop = cv2.resize(crop, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # CLAHE — improves contrast on dirty/shadowed plates
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(gray, h=10)
    # Otsu threshold gives clean black-on-white text
    _, binary = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # White border helps Tesseract find text near the edge
    bordered = cv2.copyMakeBorder(binary, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
    return bordered


OCR_CONFIG = (
    "--psm 8 "          # treat image as single word (plate as one token)
    "--oem 3 "          # LSTM engine
    "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)


def ocr_plate(crop: np.ndarray) -> Optional[tuple[str, float]]:
    """
    Run Tesseract on a plate crop.
    Returns (plate_text, confidence) or None if OCR failed / low confidence.
    """
    if not TESSERACT_OK:
        return None
    try:
        enhanced = _enhance_for_ocr(crop)
        pil_img = PILImage.fromarray(enhanced)
        data = pytesseract.image_to_data(
            pil_img,
            config=OCR_CONFIG,
            output_type=pytesseract.Output.DICT,
        )
        texts = []
        confs = []
        for text, conf in zip(data["text"], data["conf"]):
            text = text.strip()
            conf_f = int(conf) / 100.0 if str(conf).lstrip("-").isdigit() else 0.0
            if text and conf_f > 0:
                texts.append(text)
                confs.append(conf_f)
        if not texts:
            return None
        combined = "".join(texts)
        avg_conf = sum(confs) / len(confs)
        return combined, avg_conf
    except Exception as exc:
        logger.debug("OCR error: %s", exc)
        return None


# ===========================================================================
# 5. Plate string validation
# ===========================================================================

_PLATE_RE = re.compile(r"^[A-Z0-9]{%d,%d}$" % (MIN_PLATE_LEN, MAX_PLATE_LEN))


def clean_plate(raw: str) -> Optional[str]:
    """
    Strip non-alphanumeric characters, uppercase, and validate length.
    Returns the cleaned plate string or None if it looks invalid.
    """
    cleaned = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if _PLATE_RE.match(cleaned):
        return cleaned
    return None


# ===========================================================================
# 6. Duplicate suppression
# ===========================================================================

class PlateDeduplicator:
    """Suppress repeat submissions of the same plate within COOLDOWN_SECS."""

    def __init__(self, cooldown: int = COOLDOWN_SECS):
        self._seen: dict[str, float] = {}
        self._cooldown = cooldown
        self._lock = threading.Lock()

    def is_new(self, plate: str) -> bool:
        now = time.monotonic()
        with self._lock:
            last = self._seen.get(plate, 0.0)
            if now - last >= self._cooldown:
                self._seen[plate] = now
                return True
            return False

    def purge_old(self):
        """Remove stale entries to keep the dict bounded."""
        now = time.monotonic()
        with self._lock:
            stale = [p for p, t in self._seen.items() if now - t > self._cooldown * 2]
            for p in stale:
                del self._seen[p]


# ===========================================================================
# 7. HTTP POST with retry
# ===========================================================================

def post_scan(plate: str, confidence: float) -> bool:
    """POST a validated plate detection to the P3 backend."""
    payload = {
        "plate": plate,
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "location": LOCATION,
        "confidence_score": round(confidence, 4),
    }
    backoff = 1.0
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(SCAN_URL, json=payload, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                logger.info(
                    "✅ Scan accepted: plate=%s conf=%.0f%% fs_id=%s",
                    plate, confidence * 100, resp.json().get("firestore_id", "?"),
                )
                return True
            elif resp.status_code == 404:
                logger.warning("⚠️  Plate not registered: %s", plate)
                return False
            elif resp.status_code == 401:
                logger.error("🔑 Auth rejected — refresh API token in .env")
                _shutdown.set()   # fatal — stop the scanner
                return False
            else:
                logger.warning(
                    "HTTP %d on attempt %d/%d: %s",
                    resp.status_code, attempt, MAX_RETRIES, resp.text[:200],
                )
        except requests.exceptions.Timeout:
            logger.warning("⏳ Timeout on attempt %d/%d", attempt, MAX_RETRIES)
        except requests.exceptions.ConnectionError as exc:
            logger.warning("🔌 Connection error: %s", exc)

        if attempt < MAX_RETRIES:
            logger.info("Retrying in %.1fs…", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    logger.error("❌ Gave up on plate=%s after %d attempts", plate, MAX_RETRIES)
    return False


# ===========================================================================
# Main loop
# ===========================================================================

def run():
    logger.info(
        "P3 scanner starting — env=%s backend=%s location=%s tpu=%s ocr=%s",
        ENV, BASE_URL, LOCATION, TPU_OK, TESSERACT_OK,
    )

    cap = open_camera()
    motion_gate = MotionGate(threshold=0.003)
    deduplicator = PlateDeduplicator()

    # Async POST queue so OCR never blocks frame capture
    post_q: queue.Queue = queue.Queue(maxsize=50)

    def _poster_thread():
        while not _shutdown.is_set() or not post_q.empty():
            try:
                plate, conf = post_q.get(timeout=1)
                post_scan(plate, conf)
                post_q.task_done()
            except queue.Empty:
                continue

    poster = threading.Thread(target=_poster_thread, daemon=True, name="poster")
    poster.start()

    frame_interval = 1.0 / FPS_CAP
    last_frame_time = 0.0
    debug_idx = 0

    try:
        while not _shutdown.is_set():
            ret, frame = cap.read()
            if not ret:
                logger.warning("Frame grab failed — retrying camera in 2s")
                cap.release()
                time.sleep(2)
                try:
                    cap = open_camera()
                except RuntimeError as exc:
                    logger.error("%s", exc)
                    time.sleep(5)
                continue

            # FPS cap — skip processing if too soon since last frame
            now = time.monotonic()
            if now - last_frame_time < frame_interval:
                continue
            last_frame_time = now

            # Motion gate
            if not motion_gate.has_motion(frame):
                continue

            # Plate detection
            candidates = detect_plates(frame)
            if not candidates:
                continue

            debug_frame = frame.copy() if DEBUG else None

            for crop, bbox in candidates:
                result = ocr_plate(crop)
                if result is None:
                    continue
                raw_text, conf = result
                plate = clean_plate(raw_text)
                if plate is None:
                    logger.debug("Rejected OCR output: %r (conf=%.2f)", raw_text, conf)
                    continue
                if conf < MIN_CONFIDENCE:
                    logger.debug("Low confidence: %s conf=%.2f", plate, conf)
                    continue
                if not deduplicator.is_new(plate):
                    logger.debug("Duplicate suppressed: %s", plate)
                    continue

                logger.info("🔍 Plate detected: %s (conf=%.0f%%)", plate, conf * 100)

                if DEBUG and debug_frame is not None:
                    x1, y1, x2, y2 = bbox
                    cv2.rectangle(debug_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(
                        debug_frame, f"{plate} {conf:.0%}",
                        (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (0, 255, 0), 2,
                    )

                # Queue for async POST (non-blocking)
                try:
                    post_q.put_nowait((plate, conf))
                except queue.Full:
                    logger.warning("Post queue full — dropping %s", plate)

            if DEBUG and debug_frame is not None:
                fname = f"debug_frames/frame_{debug_idx:06d}.jpg"
                cv2.imwrite(fname, debug_frame)
                debug_idx += 1

            # Periodically clean up the deduplication cache
            if debug_idx % 300 == 0:
                deduplicator.purge_old()

    finally:
        logger.info("Shutting down — draining post queue…")
        post_q.join()
        cap.release()
        logger.info("Scanner stopped.")


if __name__ == "__main__":
    run()
