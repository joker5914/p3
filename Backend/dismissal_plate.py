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
import os
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

# ONNX Runtime is used by the direct-plate YOLO detector.  Optional
# dependency — missing import means we fall back to SSD vehicle-in-crop.
try:
    import onnxruntime as _ort  # type: ignore[import-not-found]
except ImportError:
    _ort = None

# fast-plate-ocr — plate-trained CRNN via ONNX Runtime.  Much more
# accurate than Tesseract on real-world US plates.  Optional; ocr_plate
# falls back to Tesseract when this isn't installed.
#
# v1.1+ renamed the class to LicensePlateRecognizer and returns
# PlatePrediction objects; v1.0 shipped ONNXPlateRecognizer that
# returned (texts, confs) tuples.  We handle both.
_FastPlateOCR = None
try:
    from fast_plate_ocr import LicensePlateRecognizer as _FastPlateOCR  # type: ignore[import-not-found]
except ImportError:
    try:
        from fast_plate_ocr import ONNXPlateRecognizer as _FastPlateOCR  # type: ignore[import-not-found]
    except ImportError:
        _FastPlateOCR = None

_FAST_PLATE_MODEL = os.getenv(
    "SCANNER_PLATE_OCR_MODEL", "global-plates-mobile-vit-v2-model",
)
_fast_plate_instance = None  # lazy-init; first call downloads weights


def _get_fast_plate_ocr():
    """Lazy-init the fast-plate-ocr recognizer.  First call downloads
    the model (~10 MB) into the user's cache; subsequent calls reuse
    the in-memory instance."""
    global _fast_plate_instance
    if _FastPlateOCR is None:
        return None
    if _fast_plate_instance is not None:
        return _fast_plate_instance
    try:
        _fast_plate_instance = _FastPlateOCR(_FAST_PLATE_MODEL)
        logger.info("fast-plate-ocr loaded: model=%s", _FAST_PLATE_MODEL)
    except Exception as exc:
        logger.warning(
            "fast-plate-ocr init failed (%s) — falling back to Tesseract.", exc,
        )
        _fast_plate_instance = None
    return _fast_plate_instance

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
        plate_model_path: str = "",
        use_edgetpu: bool = False,
    ):
        self._interp = None
        self._plate_yolo: Optional[PlateYOLODetector] = None
        self._backend = "contour"
        self._last_vehicle_boxes: List[BBox] = []

        # 0. Plate-specific YOLO (preferred when a model file exists and
        # onnxruntime is installed).  This goes straight from frame to
        # plate bboxes — no vehicle step, so close-ups without a
        # recognisable car silhouette still work.
        if plate_model_path and Path(plate_model_path).exists() and _ort is not None:
            try:
                self._plate_yolo = PlateYOLODetector(plate_model_path)
                self._backend = "plate_yolo"
            except Exception as exc:
                logger.warning(
                    "Plate YOLO init failed (%s) — falling back to SSD/contour.",
                    exc,
                )
                self._plate_yolo = None

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
        """plate_yolo / edgetpu / cpu / contour — the detector actually
        used by ``detect()``.  plate_yolo wins when it's loaded, because
        detect() tries it first."""
        if self._plate_yolo is not None:
            return "plate_yolo"
        return self._backend

    @property
    def last_vehicle_boxes(self) -> List[BBox]:
        """Vehicle bboxes from the most recent ``detect()`` call — so the
        debug overlay can draw them alongside plate candidates."""
        return list(self._last_vehicle_boxes)

    def detect(self, frame: np.ndarray) -> List[Candidate]:
        self._last_vehicle_boxes = []
        # Preferred: direct plate YOLO.
        if self._plate_yolo is not None:
            try:
                return self._plate_yolo.detect(frame)
            except Exception as exc:
                logger.debug(
                    "Plate YOLO error (%s) — falling back to SSD/contour.", exc,
                )
        # SSD vehicle detection + contour-within-vehicle.
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


class PlateYOLODetector:
    """Direct license-plate detector backed by a YOLOv8-format ONNX model.

    Unlike the SSD COCO detector (which needs a recognisable full vehicle
    in frame), this runs straight on the frame and localises plates of
    any size — including close-ups where only the bumper is visible.

    The model is expected to be a single-class detector (class 0 = plate)
    exported from an Ultralytics YOLOv8 checkpoint via
    ``model.export(format='onnx', imgsz=640)``.  Install with
    ``deploy/install_plate_model.sh``.
    """

    def __init__(
        self,
        model_path: str,
        input_size: int = 640,
        conf_threshold: float = 0.30,
        iou_threshold: float = 0.45,
    ):
        if _ort is None:
            raise RuntimeError("onnxruntime not installed")
        if not Path(model_path).exists():
            raise FileNotFoundError(model_path)
        self._session = _ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name
        self._input_size = input_size
        self._conf_threshold = conf_threshold
        self._iou_threshold = iou_threshold
        logger.info(
            "Plate YOLO detector loaded: %s (input=%dx%d conf>=%.2f)",
            model_path, input_size, input_size, conf_threshold,
        )

    @staticmethod
    def _letterbox(img: np.ndarray, new_size: int):
        """Letterbox so the output is new_size x new_size with aspect ratio
        preserved.  Returns the resized padded image + (scale, pad_x, pad_y)
        so we can map detections back to the original frame."""
        h, w = img.shape[:2]
        scale = min(new_size / h, new_size / w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        pad_x = (new_size - nw) // 2
        pad_y = (new_size - nh) // 2
        canvas = np.full((new_size, new_size, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
        return canvas, scale, pad_x, pad_y

    @staticmethod
    def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list:
        """Simple numpy NMS — returns indices of boxes to keep.  Boxes are
        (x1, y1, x2, y2)."""
        if len(boxes) == 0:
            return []
        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]
        keep = []
        while order.size > 0:
            i = order[0]
            keep.append(int(i))
            if order.size == 1:
                break
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h
            iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
            order = order[1:][iou <= iou_threshold]
        return keep

    def detect(self, frame: np.ndarray) -> List[Candidate]:
        fh, fw = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        padded, scale, pad_x, pad_y = self._letterbox(rgb, self._input_size)
        tensor = padded.astype(np.float32) / 255.0
        tensor = tensor.transpose(2, 0, 1)[None, ...]  # NCHW
        raw = self._session.run(None, {self._input_name: tensor})[0]

        # YOLOv8 export usually produces (1, 5, N) for 1-class or
        # (1, 4+C, N).  Some exports are (1, N, 5).  Normalise to (N, C).
        if raw.ndim == 3:
            if raw.shape[1] < raw.shape[2]:
                preds = raw[0].T  # (N, C)
            else:
                preds = raw[0]    # already (N, C)
        else:
            preds = raw

        if preds.shape[1] < 5:
            return []

        # For single-class: col 4 is confidence.  For multi-class:
        # cols 4..n are class scores and we take the max.
        boxes_xywh = preds[:, :4]
        if preds.shape[1] == 5:
            scores = preds[:, 4]
        else:
            scores = preds[:, 4:].max(axis=1)
        mask = scores >= self._conf_threshold
        if not mask.any():
            return []
        boxes_xywh = boxes_xywh[mask]
        scores = scores[mask]

        # YOLOv8 raw boxes are center-x, center-y, w, h in padded-image coords.
        x_c = boxes_xywh[:, 0]
        y_c = boxes_xywh[:, 1]
        w   = boxes_xywh[:, 2]
        h   = boxes_xywh[:, 3]
        x1 = (x_c - w / 2 - pad_x) / scale
        y1 = (y_c - h / 2 - pad_y) / scale
        x2 = (x_c + w / 2 - pad_x) / scale
        y2 = (y_c + h / 2 - pad_y) / scale
        xyxy = np.stack([x1, y1, x2, y2], axis=1)

        keep = self._nms(xyxy, scores, self._iou_threshold)
        candidates: List[Candidate] = []
        for i in keep:
            px1 = max(0, int(xyxy[i, 0]))
            py1 = max(0, int(xyxy[i, 1]))
            px2 = min(fw, int(xyxy[i, 2]))
            py2 = min(fh, int(xyxy[i, 3]))
            if px2 - px1 < 20 or py2 - py1 < 10:
                continue
            crop = frame[py1:py2, px1:px2]
            if crop.size > 0:
                candidates.append((crop, (px1, py1, px2, py2)))
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

# Tesseract PSM modes worth trying on a plate crop.  Different plates
# (stacked state names, hyphens, state silhouettes) parse better under
# different segmentation strategies, so we try several and keep the
# best-confidence result that still passes the clean_plate validator.
_OCR_PSM_MODES = (7, 8, 13, 6)

# Character whitelist — US plates use A-Z 0-9 only.
_OCR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

# Minimum Laplacian variance to consider a crop sharp enough for OCR.
# 40 is permissive enough to let through small-but-readable plates;
# the character-length + whitelist gate downstream catches real noise.
_BLUR_THRESHOLD = 40.0


def _is_sharp(crop: np.ndarray) -> bool:
    """Return True if the crop is sharp enough to attempt OCR."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    return cv2.Laplacian(gray, cv2.CV_64F).var() >= _BLUR_THRESHOLD


def _enhance_variants(crop: np.ndarray) -> list:
    """Produce several differently-preprocessed versions of the plate
    crop so Tesseract has a few angles of attack.  Each variant is a
    binary image sized for a ~32-40 px x-height (Tesseract's happy zone).

    Variants:
      * Otsu on CLAHE-normalised grayscale
      * Adaptive (gaussian) threshold — better on non-uniform lighting
      * Inverted Otsu — specialty plates with light text on dark
    """
    h, w = crop.shape[:2]
    if h < 1 or w < 1:
        return []
    # Upscale using a *float* scale so small plates get a real boost
    # (the old integer scale snapped to 1× or 2×, leaving short crops
    # under-sampled).  Target ~100 px tall.
    target_h = 100
    if h < target_h:
        scale = target_h / h
        crop = cv2.resize(
            crop,
            (int(w * scale), target_h),
            interpolation=cv2.INTER_CUBIC,
        )
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    normed = clahe.apply(gray)

    # No fastNlMeansDenoising — at these sizes it smudges character
    # edges harder than it cleans noise.

    _, otsu = cv2.threshold(normed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, otsu_inv = cv2.threshold(
        normed, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU,
    )
    adaptive = cv2.adaptiveThreshold(
        normed, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY,
        blockSize=31, C=10,
    )

    variants = []
    for img in (otsu, adaptive, otsu_inv):
        bordered = cv2.copyMakeBorder(
            img, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255,
        )
        variants.append(bordered)
    return variants


def _run_tesseract(img: np.ndarray, psm: int) -> Optional[Tuple[str, float]]:
    """Run Tesseract with a specific PSM; return (text, conf) or None."""
    config = (
        f"--psm {psm} --oem 3 "
        f"-c tessedit_char_whitelist={_OCR_WHITELIST}"
    )
    pil_img = PILImage.fromarray(img)
    data = pytesseract.image_to_data(
        pil_img,
        config=config,
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


def _extract_text_and_conf(obj) -> Optional[Tuple[str, float]]:
    """Pull (text, confidence) out of one fast-plate-ocr prediction.

    Handles v1.1 PlatePrediction objects (attribute-based), v1.0 bare
    strings, and plain strings defensively.  Confidence defaults to
    0.8 when the library doesn't expose one.
    """
    if obj is None:
        return None
    if isinstance(obj, str):
        text = obj.strip()
        return (text, 0.8) if text else None
    # Try common attribute names used by PlatePrediction across versions.
    text = None
    for attr in ("plate_text", "text", "plate", "value"):
        t = getattr(obj, attr, None)
        if isinstance(t, str) and t.strip():
            text = t.strip()
            break
    if text is None:
        return None
    conf = None
    for attr in ("mean_confidence", "confidence", "score", "conf"):
        c = getattr(obj, attr, None)
        if isinstance(c, (int, float)):
            conf = float(c)
            break
        if isinstance(c, (list, tuple)) and c:
            conf = float(sum(c) / len(c))
            break
        if hasattr(c, "mean"):
            try:
                conf = float(c.mean())
                break
            except Exception:
                pass
    return text, conf if conf is not None else 0.8


def _ocr_with_fast_plate(crop: np.ndarray, recognizer) -> Optional[Tuple[str, float]]:
    """Run fast-plate-ocr on a crop; return (text, confidence) or None."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    # v1.1 drops return_confidence (PlatePrediction exposes it directly);
    # v1.0 accepts it and returns (texts, confs).  Try the v1.0 signature
    # first, fall back on TypeError.
    try:
        result = recognizer.run(gray, return_confidence=True)
    except TypeError:
        result = recognizer.run(gray)

    # v1.0 tuple form: (['AAA123'], np.ndarray[[0.9, 0.8, ...]])
    if isinstance(result, tuple) and len(result) == 2:
        texts, confs = result
        text = texts[0] if isinstance(texts, (list, tuple)) and texts else None
        if isinstance(text, str) and text.strip():
            conf_f = 0.8
            try:
                arr = np.array(confs[0]) if len(confs) > 0 else None
                if arr is not None and arr.size > 0:
                    conf_f = float(arr.mean())
            except Exception:
                pass
            return text.strip(), conf_f
        return None

    # v1.1 list of PlatePrediction (or single).
    if isinstance(result, (list, tuple)):
        for item in result:
            out = _extract_text_and_conf(item)
            if out is not None:
                return out
        return None
    # Single object or raw string fallback.
    return _extract_text_and_conf(result)


def _ocr_with_tesseract(crop: np.ndarray) -> Optional[Tuple[str, float]]:
    """Fallback OCR path: multi-variant preprocessing + multi-PSM."""
    if not TESSERACT_OK:
        return None
    variants = _enhance_variants(crop)
    if not variants:
        return None
    best: Optional[Tuple[str, float]] = None
    try:
        for variant in variants:
            for psm in _OCR_PSM_MODES:
                result = _run_tesseract(variant, psm)
                if result is None:
                    continue
                if best is None or result[1] > best[1]:
                    best = result
        return best
    except Exception as exc:
        logger.debug("Tesseract error: %s", exc)
        return None


def ocr_plate(crop: np.ndarray) -> Optional[Tuple[str, float]]:
    """Plate OCR.  Preferred path: a plate-trained CRNN via
    ``fast_plate_ocr``.  Fallback: multi-variant, multi-PSM Tesseract.

    Both paths skip obviously blurry crops up front (Laplacian gate)
    to avoid wasting CPU on motion-blurred frames.
    """
    if not _is_sharp(crop):
        logger.debug("Skipping blurry crop (Laplacian below threshold)")
        return None

    recognizer = _get_fast_plate_ocr()
    if recognizer is not None:
        try:
            result = _ocr_with_fast_plate(crop, recognizer)
            if result is not None:
                return result
        except Exception as exc:
            logger.debug(
                "fast-plate-ocr inference error (%s) — falling back to Tesseract",
                exc,
            )

    return _ocr_with_tesseract(crop)


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
