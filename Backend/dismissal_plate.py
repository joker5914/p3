"""
dismissal_plate.py — plate detection, OCR, validation and deduplication.

Pipeline:
  detect()   → list of (crop_bgr, (x1,y1,x2,y2)) candidates
  ocr_plate()→ (raw_text, confidence) | None
  clean_plate()  → normalised string | None
  PlateDeduplicator.is_new() → bool (cooldown suppression)
  MotionGate.has_motion()    → bool (skip static frames)

TPU path (preferred):
  Uses an EdgeTPU-compiled SSD-MobileNet-v2 COCO model to detect vehicle
  bounding boxes (car / bus / truck / motorcycle / bicycle) and then runs the
  contour heuristic only *within* each vehicle crop.  This cuts false positives
  dramatically compared to whole-frame contour scanning.

  Default model: ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite
  Downloaded by install.sh to /opt/dismissal/models/.

CPU fallback:
  Whole-frame contour analysis when no TPU / model is available.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger("dismissal-scanner.plate")

try:
    import pytesseract
    from PIL import Image as PILImage
    TESSERACT_OK = True
except ImportError:
    TESSERACT_OK = False
    logger.warning("pytesseract/Pillow not installed — OCR disabled. "
                   "apt install tesseract-ocr && pip install pytesseract pillow")

# pycoral is imported lazily inside PlateDetector so a missing package is only
# a warning, not a startup crash.
try:
    from pycoral.utils import edgetpu as _pc_edgetpu
    from pycoral.adapters import common as _pc_common
    from pycoral.adapters import detect as _pc_detect
    _PYCORAL = (_pc_edgetpu, _pc_common, _pc_detect)
except Exception:
    _PYCORAL = None  # type: ignore[assignment]

# COCO class IDs used by the MobileNet-v2 model from google-coral/test_data.
# (0-indexed label map: 2=car, 5=bus, 7=truck, 3=motorcycle, 1=bicycle)
_VEHICLE_IDS = {1, 2, 3, 5, 7}

BBox = Tuple[int, int, int, int]
Candidate = Tuple[np.ndarray, BBox]


# ---------------------------------------------------------------------------
# Plate detector
# ---------------------------------------------------------------------------

class PlateDetector:
    """
    Dispatches to TPU vehicle-detect → contour-within-vehicle, or pure contour.
    Instantiate once at startup; call ``detect(frame)`` per frame.
    """

    def __init__(self, model_path: str = ""):
        self._interp = None
        if model_path and Path(model_path).exists() and _PYCORAL is not None:
            edgetpu, _, _ = _PYCORAL
            try:
                devices = edgetpu.list_edge_tpus()
                if devices:
                    self._interp = edgetpu.make_interpreter(model_path)
                    self._interp.allocate_tensors()
                    logger.info("Coral TPU initialised: model=%s devices=%s",
                                model_path, devices)
                else:
                    logger.warning(
                        "SCANNER_MODEL_PATH set but no Coral TPU detected — "
                        "using contour fallback"
                    )
            except Exception as exc:
                logger.warning("TPU init failed (%s) — using contour fallback", exc)
        elif model_path and not Path(model_path).exists():
            logger.warning("Model not found at '%s' — using contour fallback", model_path)
        elif not model_path:
            logger.info("No model path set — using contour-only plate detection")

    @property
    def tpu_enabled(self) -> bool:
        return self._interp is not None

    def detect(self, frame: np.ndarray) -> List[Candidate]:
        if self._interp is not None:
            try:
                return self._detect_tpu(frame)
            except Exception as exc:
                logger.debug("TPU inference error (%s) — falling back to contour", exc)
        return _contour_candidates(frame)

    def _detect_tpu(self, frame: np.ndarray) -> List[Candidate]:
        _, common, detect = _PYCORAL
        _, input_h, input_w, _ = self._interp.get_input_details()[0]["shape"]

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (input_w, input_h))
        common.set_input(self._interp, resized)
        self._interp.invoke()
        objs = detect.get_objects(self._interp, score_threshold=0.4)

        fh, fw = frame.shape[:2]
        candidates: List[Candidate] = []
        for obj in objs:
            if obj.id not in _VEHICLE_IDS:
                continue
            b = obj.bbox
            # bbox coords are already in pixel space for this model
            vx1 = max(0, int(b.xmin))
            vy1 = max(0, int(b.ymin))
            vx2 = min(fw, int(b.xmax))
            vy2 = min(fh, int(b.ymax))
            if vx2 - vx1 < 80 or vy2 - vy1 < 60:
                continue
            vehicle = frame[vy1:vy2, vx1:vx2]
            for crop, (px1, py1, px2, py2) in _contour_candidates(vehicle):
                abs_box: BBox = (vx1 + px1, vy1 + py1, vx1 + px2, vy1 + py2)
                candidates.append((crop, abs_box))
        return candidates


def _contour_candidates(frame: np.ndarray) -> List[Candidate]:
    """Find plate-shaped rectangles in ``frame`` using edge/contour analysis."""
    if frame.size == 0:
        return []
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    filtered = cv2.bilateralFilter(gray, 11, 17, 17)
    edges = cv2.Canny(filtered, 30, 200)
    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:20]

    frame_area = frame.shape[0] * frame.shape[1]
    candidates: List[Candidate] = []
    for contour in contours:
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.018 * peri, True)
        if len(approx) != 4:
            continue
        x, y, w, h = cv2.boundingRect(approx)
        area = w * h
        if area < 1500 or area > 0.35 * frame_area:
            continue
        aspect = w / h if h else 0
        if not (2.0 <= aspect <= 6.0):
            continue
        m = 6
        x1 = max(0, x - m)
        y1 = max(0, y - m)
        x2 = min(frame.shape[1], x + w + m)
        y2 = min(frame.shape[0], y + h + m)
        crop = frame[y1:y2, x1:x2]
        if crop.size > 0:
            candidates.append((crop, (x1, y1, x2, y2)))
    return candidates


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------

_OCR_CONFIG = (
    "--psm 7 "   # single text line — better than psm 8 for multi-char plates
    "--oem 3 "   # LSTM engine
    "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)

# Minimum Laplacian variance to consider a crop sharp enough for OCR.
# Blurry crops (motion blur, out-of-focus) waste CPU and produce garbage text.
_BLUR_THRESHOLD = 80.0


def _is_sharp(crop: np.ndarray) -> bool:
    """Return True if the crop is sharp enough to attempt OCR."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    return cv2.Laplacian(gray, cv2.CV_64F).var() >= _BLUR_THRESHOLD


def _enhance_for_ocr(crop: np.ndarray) -> np.ndarray:
    """Upscale, denoise, and binarise a plate crop for Tesseract."""
    h, w = crop.shape[:2]
    if h < 1:
        return crop
    scale = max(1, int(180 / h))   # target ~180 px tall
    if scale > 1:
        crop = cv2.resize(crop, (w * scale, h * scale),
                          interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(gray, h=10)
    _, binary = cv2.threshold(denoised, 0, 255,
                              cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # White border helps Tesseract find text near the edge of the crop.
    return cv2.copyMakeBorder(binary, 10, 10, 10, 10,
                              cv2.BORDER_CONSTANT, value=255)


def _run_tesseract(img: np.ndarray) -> Optional[Tuple[str, float]]:
    """Run Tesseract on a pre-processed image; return (text, conf) or None."""
    pil_img = PILImage.fromarray(img)
    data = pytesseract.image_to_data(
        pil_img,
        config=_OCR_CONFIG,
        output_type=pytesseract.Output.DICT,
    )
    texts, confs = [], []
    for text, conf in zip(data["text"], data["conf"]):
        text = text.strip()
        conf_f = int(conf) / 100.0 if str(conf).lstrip("-").isdigit() else 0.0
        if text and conf_f > 0:
            texts.append(text)
            confs.append(conf_f)
    if not texts:
        return None
    return "".join(texts), sum(confs) / len(confs)


def ocr_plate(crop: np.ndarray) -> Optional[Tuple[str, float]]:
    """
    Run Tesseract on a plate crop using two passes:
      1. Normal (dark text on light background — most US plates)
      2. Inverted (light text on dark background — some specialty plates)
    Returns the pass with the higher confidence, or None if both fail.

    A Laplacian sharpness gate skips obviously blurry crops before OCR to
    avoid wasting CPU on frames captured during vehicle motion.
    """
    if not TESSERACT_OK:
        return None

    # Sharpness gate — skip motion-blurred crops
    if not _is_sharp(crop):
        logger.debug("Skipping blurry crop (Laplacian below threshold)")
        return None

    try:
        normal  = _enhance_for_ocr(crop)
        inv_src = crop.copy()
        inv_src = cv2.bitwise_not(inv_src)   # invert before enhance
        inverted = _enhance_for_ocr(inv_src)

        result_normal   = _run_tesseract(normal)
        result_inverted = _run_tesseract(inverted)

        # Pick whichever pass returned the higher confidence
        best = None
        for result in (result_normal, result_inverted):
            if result is None:
                continue
            if best is None or result[1] > best[1]:
                best = result
        return best
    except Exception as exc:
        logger.debug("OCR error: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Plate string validation
# ---------------------------------------------------------------------------

def clean_plate(raw: str, min_len: int, max_len: int) -> Optional[str]:
    """
    Strip non-alphanumeric chars, uppercase, validate length.
    Returns cleaned string or ``None`` if it fails the length check.
    """
    cleaned = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if min_len <= len(cleaned) <= max_len:
        return cleaned
    return None


# ---------------------------------------------------------------------------
# Duplicate suppression
# ---------------------------------------------------------------------------

class PlateDeduplicator:
    """Suppress the same plate within a configurable cooldown window."""

    def __init__(self, cooldown: int):
        self._seen: dict[str, float] = {}
        self._cooldown = cooldown
        self._lock = threading.Lock()

    def is_new(self, plate: str) -> bool:
        now = time.monotonic()
        with self._lock:
            if now - self._seen.get(plate, 0.0) >= self._cooldown:
                self._seen[plate] = now
                return True
        return False

    def purge_old(self) -> None:
        """Remove stale entries — call occasionally to keep dict bounded."""
        cutoff = time.monotonic() - self._cooldown * 2
        with self._lock:
            stale = [p for p, t in self._seen.items() if t < cutoff]
            for p in stale:
                del self._seen[p]


# ---------------------------------------------------------------------------
# Motion gate
# ---------------------------------------------------------------------------

class MotionGate:
    """Skip plate detection on static frames to save CPU/TPU cycles."""

    def __init__(self, threshold: float = 0.003):
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
