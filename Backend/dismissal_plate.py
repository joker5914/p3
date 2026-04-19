"""
dismissal_plate.py — plate detection, OCR, validation and deduplication.

Pipeline:
  detect()   → list of (crop_bgr, (x1,y1,x2,y2)) candidates
  ocr_plate()→ (raw_text, confidence) | None
  clean_plate()  → normalised string | None
  PlateDeduplicator.is_new() → bool (cooldown suppression)
  MotionGate.has_motion()    → bool (skip static frames)

Vehicle detection backend (priority order):
  1. Edge TPU  — SSD-MobileNet-v2 COCO *_edgetpu.tflite loaded via
                 tflite_runtime + libedgetpu.so.1 delegate.  Requires a
                 Coral USB/M.2 accelerator plugged in.
  2. CPU       — same network architecture, plain quantised .tflite
                 file, runs on the Pi 5 ARM cores at ~5–10 FPS.
  3. Contour   — whole-frame edge/contour analysis.  Always available
                 but produces many false positives (road markings etc.)
                 because it has no vehicle context.

In each of the first two modes we only run the contour heuristic
*inside* each vehicle bbox — that's what cuts false positives.

We no longer depend on pycoral (abandoned, Python < 3.10 only).  If
neither tflite runtime is installed, the detector silently falls back
to contour-only and logs the fact.
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

# tflite-runtime (preferred) or ai-edge-litert (successor) — either one
# gives us Interpreter + load_delegate.  Import lazily so a missing
# package isn't a startup crash; PlateDetector will fall back to contour.
_Interpreter = None
_load_delegate = None
try:
    from tflite_runtime.interpreter import Interpreter as _Interpreter  # type: ignore[no-redef]
    try:
        from tflite_runtime.interpreter import load_delegate as _load_delegate  # type: ignore[no-redef]
    except ImportError:
        _load_delegate = None
except ImportError:
    try:
        from ai_edge_litert.interpreter import Interpreter as _Interpreter  # type: ignore[no-redef]
        try:
            from ai_edge_litert.interpreter import load_delegate as _load_delegate  # type: ignore[no-redef]
        except ImportError:
            _load_delegate = None
    except ImportError:
        pass

# COCO class IDs used by the SSD-MobileNet-v2 model from google-coral/test_data.
# (0-indexed label map: 1=bicycle, 2=car, 3=motorcycle, 5=bus, 7=truck)
_VEHICLE_IDS = {1, 2, 3, 5, 7}
_DETECT_SCORE_THRESHOLD = 0.4

BBox = Tuple[int, int, int, int]
Candidate = Tuple[np.ndarray, BBox]


# ---------------------------------------------------------------------------
# Plate detector
# ---------------------------------------------------------------------------

class PlateDetector:
    """Dispatches to Edge TPU vehicle-detect → contour-within-vehicle,
    CPU vehicle-detect → contour-within-vehicle, or pure contour.
    Instantiate once at startup; call ``detect(frame)`` per frame.
    """

    def __init__(
        self,
        model_path: str = "",
        cpu_model_path: str = "",
        use_edgetpu: bool = False,
    ):
        self._interp = None
        self._backend = "contour"
        self._last_vehicle_boxes: List[BBox] = []

        if _Interpreter is None:
            logger.info(
                "tflite-runtime not installed — using contour-only plate "
                "detection.  `pip install tflite-runtime` to enable the "
                "neural vehicle detector.",
            )
            return

        # 1. Try Edge TPU first — opt-in only, because some combinations
        # (e.g. ai-edge-litert + libedgetpu.so.1) can SEGV in the delegate
        # instead of raising a catchable Python exception.  Set
        # SCANNER_USE_EDGETPU=1 once you've verified it works on your Pi.
        if (
            use_edgetpu
            and model_path
            and Path(model_path).exists()
            and _load_delegate is not None
        ):
            try:
                delegate = _load_delegate("libedgetpu.so.1")
                self._interp = _Interpreter(
                    model_path=model_path,
                    experimental_delegates=[delegate],
                )
                self._interp.allocate_tensors()
                self._backend = "edgetpu"
                logger.info("Edge TPU detector initialised: model=%s", model_path)
            except Exception as exc:
                logger.info(
                    "Edge TPU unavailable (%s) — trying CPU detector.", exc,
                )
                self._interp = None
        elif not use_edgetpu:
            logger.info(
                "Edge TPU path skipped (SCANNER_USE_EDGETPU=0) — using CPU detector.",
            )

        # 2. Fall back to CPU tflite.  Default CPU model path strips the
        #    "_edgetpu" suffix from the TPU one so a single SCANNER_MODEL_PATH
        #    config works for both.
        if self._interp is None:
            cpu_path = cpu_model_path
            if not cpu_path and model_path:
                cpu_path = model_path.replace("_edgetpu.tflite", ".tflite")
            if cpu_path and Path(cpu_path).exists() and cpu_path != model_path:
                try:
                    self._interp = _Interpreter(model_path=cpu_path)
                    self._interp.allocate_tensors()
                    self._backend = "cpu"
                    logger.info("CPU detector initialised: model=%s", cpu_path)
                except Exception as exc:
                    logger.warning(
                        "CPU detector init failed (%s) — using contour fallback",
                        exc,
                    )
                    self._interp = None

        if self._interp is None:
            if model_path or cpu_model_path:
                logger.warning(
                    "No usable detector model found (tried edgetpu=%s cpu=%s) — "
                    "using contour-only fallback.",
                    model_path or "—", cpu_model_path or "—",
                )
            else:
                logger.info("No model path set — using contour-only plate detection")

    @property
    def tpu_enabled(self) -> bool:
        """Kept for log compatibility — true when any neural backend is
        running (Edge TPU or CPU)."""
        return self._interp is not None

    @property
    def backend(self) -> str:
        """edgetpu / cpu / contour"""
        return self._backend

    @property
    def last_vehicle_boxes(self) -> List[BBox]:
        """Vehicle bboxes from the most recent ``detect()`` call — so the
        debug overlay can draw them alongside plate candidates."""
        return list(self._last_vehicle_boxes)

    def detect(self, frame: np.ndarray) -> List[Candidate]:
        self._last_vehicle_boxes = []
        if self._interp is not None:
            try:
                return self._detect_nn(frame)
            except Exception as exc:
                logger.debug(
                    "Neural inference error (%s) — falling back to contour", exc,
                )
        return _contour_candidates(frame)

    def _detect_nn(self, frame: np.ndarray) -> List[Candidate]:
        """Single code path for both Edge TPU and CPU — tflite_runtime
        hides the delegate once the interpreter is built."""
        inp = self._interp.get_input_details()[0]
        _, input_h, input_w, _ = inp["shape"]

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (input_w, input_h))
        # SSD-MobileNet-v2 quant model takes uint8 directly; float models
        # would need normalisation but we only ship the quant ones.
        self._interp.set_tensor(inp["index"], np.expand_dims(resized, 0))
        self._interp.invoke()

        # Standard google-coral/test_data SSD tflite output order:
        #   0: boxes  (1, N, 4)   ymin, xmin, ymax, xmax  normalised
        #   1: classes (1, N)     0-indexed class IDs
        #   2: scores  (1, N)
        #   3: num_det (1,)
        outs = self._interp.get_output_details()
        boxes   = self._interp.get_tensor(outs[0]["index"])[0]
        classes = self._interp.get_tensor(outs[1]["index"])[0]
        scores  = self._interp.get_tensor(outs[2]["index"])[0]
        num_det = int(self._interp.get_tensor(outs[3]["index"])[0])

        fh, fw = frame.shape[:2]
        candidates: List[Candidate] = []
        vehicle_boxes: List[BBox] = []
        for i in range(num_det):
            if scores[i] < _DETECT_SCORE_THRESHOLD:
                continue
            if int(classes[i]) not in _VEHICLE_IDS:
                continue
            ymin, xmin, ymax, xmax = boxes[i]
            vx1 = max(0, int(xmin * fw))
            vy1 = max(0, int(ymin * fh))
            vx2 = min(fw, int(xmax * fw))
            vy2 = min(fh, int(ymax * fh))
            if vx2 - vx1 < 80 or vy2 - vy1 < 60:
                continue
            vehicle_boxes.append((vx1, vy1, vx2, vy2))
            vehicle = frame[vy1:vy2, vx1:vx2]
            for crop, (px1, py1, px2, py2) in _contour_candidates(vehicle):
                abs_box: BBox = (vx1 + px1, vy1 + py1, vx1 + px2, vy1 + py2)
                candidates.append((crop, abs_box))
        self._last_vehicle_boxes = vehicle_boxes
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
    """Skip plate detection on static frames to save CPU/TPU cycles.

    Also exposes ``last_bbox`` — the bounding box of the largest moving
    region on the most recent ``has_motion()`` call — so the main loop
    can point the camera's autofocus window at the moving subject
    instead of letting libcamera hunt across the whole frame.
    """

    def __init__(self, threshold: float = 0.003):
        self._prev_gray: Optional[np.ndarray] = None
        self._threshold = threshold
        # (x1, y1, x2, y2) in frame pixel coordinates, or None.
        self.last_bbox: Optional[tuple] = None

    def has_motion(self, frame: np.ndarray) -> bool:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (11, 11), 0)
        if self._prev_gray is None:
            self._prev_gray = gray
            self.last_bbox = None
            return True
        delta = cv2.absdiff(self._prev_gray, gray)
        _, thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)
        motion_fraction = np.count_nonzero(thresh) / thresh.size
        self._prev_gray = gray
        if motion_fraction <= self._threshold:
            self.last_bbox = None
            return False
        # Union bbox of every moving region — cheap and gives the AF a
        # single ROI that covers the whole subject even when motion is
        # fragmented (e.g. reflections on the windshield).
        contours, _ = cv2.findContours(
            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
        )
        if contours:
            pts = np.vstack(contours)
            x, y, w, h = cv2.boundingRect(pts)
            self.last_bbox = (int(x), int(y), int(x + w), int(y + h))
        else:
            self.last_bbox = None
        return True
