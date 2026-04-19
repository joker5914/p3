"""
dismissal_camera.py — camera abstraction for the Dismissal scanner.

Backends (tried in priority order):
  1. Picamera2 — Raspberry Pi 5 CSI cameras via libcamera (Arducam 16MP IMX519,
     official RPi Camera Module, etc.). This is the default on Pi 5 and is the
     only reliable path for CSI cameras because Pi 5 removed the legacy
     bcm2835-v4l2 driver.
  2. OpenCV (FFmpeg) — used for RTSP/HTTP URLs and USB UVC cameras as a
     fallback. RTSP streams are forced to TCP transport for reliability over
     WiFi.

Both backends expose the same ``read()`` contract: return the most recent
BGR numpy frame, or ``None`` if the camera is temporarily unhealthy.  For the
OpenCV backend a dedicated reader thread drains the socket so we never get
stale frames after a network hiccup.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional, Union

import numpy as np

logger = logging.getLogger("dismissal-scanner.camera")

try:
    from picamera2 import Picamera2
    PICAMERA2_OK = True
except Exception:
    PICAMERA2_OK = False

try:
    from libcamera import controls as _lc_controls
except Exception:
    _lc_controls = None

try:
    import cv2
    CV2_OK = True
except Exception:
    CV2_OK = False


class CameraError(RuntimeError):
    pass


class FrameSource:
    """Abstract camera source — subclasses must never block indefinitely."""

    def read(self) -> Optional[np.ndarray]:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    # --- Focus hints (only the Picamera2 backend actually acts on these;
    # OpenCV sources silently ignore them because USB/RTSP cameras have
    # no standard focus API through cv2). -----------------------------
    def set_af_window(
        self,
        bbox: Optional[tuple],
        frame_size: Optional[tuple] = None,
    ) -> None:
        """Point the autofocus metering window at ``bbox`` (x1, y1, x2, y2)
        in frame pixel coords.  Pass ``bbox=None`` to clear the window
        and let AF evaluate the whole frame again."""
        return

    def set_manual_focus(self, lens_position: float) -> None:
        """Lock the lens at a specific diopter (0 = infinity, 1.0 = 1 m,
        higher = closer).  No-op on backends that can't control focus."""
        return


class Picamera2Source(FrameSource):
    """CSI / libcamera backend. Preferred on Pi 5 for the Arducam 16MP."""

    def __init__(self, width: int, height: int, framerate: int = 30):
        if not PICAMERA2_OK:
            raise CameraError(
                "picamera2 not installed — "
                "`apt install -y python3-picamera2 python3-libcamera`"
            )
        self._cam = Picamera2()
        self._frame_size = (int(width), int(height))
        cam_controls = {"FrameRate": float(framerate)}
        # Arducam 16MP / Pi Camera v3 have autofocus — enable continuous
        # focus if libcamera controls are available.  Modules without AF
        # silently reject these controls.
        if _lc_controls is not None:
            try:
                cam_controls["AfMode"]   = _lc_controls.AfModeEnum.Continuous
            except Exception:
                pass
            # Full range: don't let the lens park at infinity when the
            # scene is a close indoor shot, or at macro when the scene is
            # a distant entrance lane.
            try:
                cam_controls["AfRange"]  = _lc_controls.AfRangeEnum.Full
            except Exception:
                pass
            # Fast AF so the lens converges within the ~1–2 s window a
            # moving vehicle is in frame.
            try:
                cam_controls["AfSpeed"]  = _lc_controls.AfSpeedEnum.Fast
            except Exception:
                pass
        # Note: Picamera2's "RGB888" format writes BGR byte order — directly
        # consumable by OpenCV without conversion.
        config = self._cam.create_video_configuration(
            main={"size": (width, height), "format": "RGB888"},
            buffer_count=4,
            controls=cam_controls,
        )
        self._cam.configure(config)
        self._cam.start()
        # Drain stale buffer frames so the first frame returned to the caller
        # is a live, AE-settled frame — not a dark/green startup artifact.
        # Picamera2's buffer_count=4 means up to 4 stale frames need flushing.
        _WARMUP_FRAMES = 10
        _WARMUP_TIMEOUT = 3.0  # seconds total
        t0 = time.monotonic()
        drained = 0
        while drained < _WARMUP_FRAMES and (time.monotonic() - t0) < _WARMUP_TIMEOUT:
            try:
                self._cam.capture_array("main")
                drained += 1
            except Exception:
                break
        logger.info(
            "Picamera2 started: %dx%d @ %dfps (autofocus=%s, warmup=%d frames)",
            width, height, framerate, _lc_controls is not None, drained,
        )

    def read(self) -> Optional[np.ndarray]:
        try:
            return self._cam.capture_array("main")
        except Exception as exc:
            logger.warning("Picamera2 read failed: %s", exc)
            return None

    def set_af_window(
        self,
        bbox: Optional[tuple],
        frame_size: Optional[tuple] = None,
    ) -> None:
        if _lc_controls is None:
            return
        try:
            if bbox is None:
                # Return AF metering to the whole frame.
                self._cam.set_controls(
                    {"AfMetering": _lc_controls.AfMeteringEnum.Auto},
                )
                return
            fw, fh = frame_size or self._frame_size
            x1, y1, x2, y2 = bbox
            w, h = max(10, x2 - x1), max(10, y2 - y1)
            # libcamera expects AfWindows in the sensor's ScalerCropMaximum
            # coordinate space — we scale our frame-pixel bbox into that.
            sc = self._cam.camera_properties.get("ScalerCropMaximum")
            if sc and len(sc) == 4 and fw > 0 and fh > 0:
                sx, sy, sw, sh = sc
                rx = sx + int(x1 * sw / fw)
                ry = sy + int(y1 * sh / fh)
                rw = int(w * sw / fw)
                rh = int(h * sh / fh)
                self._cam.set_controls({
                    "AfMetering": _lc_controls.AfMeteringEnum.Windows,
                    "AfWindows": [(rx, ry, rw, rh)],
                })
        except Exception as exc:
            # Non-fatal: AF windows are a nice-to-have.  Log once via
            # debug so a repeat failure doesn't spam the journal.
            logger.debug("set_af_window failed: %s", exc)

    def set_manual_focus(self, lens_position: float) -> None:
        if _lc_controls is None:
            return
        try:
            self._cam.set_controls({
                "AfMode": _lc_controls.AfModeEnum.Manual,
                "LensPosition": float(lens_position),
            })
            logger.info(
                "Camera lens locked at position=%.2f (manual focus)",
                float(lens_position),
            )
        except Exception as exc:
            logger.warning("Manual focus failed: %s", exc)

    def close(self) -> None:
        try:
            self._cam.stop()
        except Exception:
            pass
        try:
            self._cam.close()
        except Exception:
            pass


class OpenCVSource(FrameSource):
    """
    USB / RTSP / HTTP / file backend.  A dedicated reader thread keeps the most
    recent frame in memory so callers always get the freshest data even if the
    network stutters.  For RTSP we force TCP transport for reliability over
    WiFi.
    """

    def __init__(self, source: Union[int, str], width: int, height: int):
        if not CV2_OK:
            raise CameraError("opencv not installed")
        if isinstance(source, str) and source.lower().startswith("rtsp://"):
            # Must be set before VideoCapture is constructed for FFmpeg backend.
            os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        self._source = source
        self._cap = cv2.VideoCapture(source)
        if not self._cap.isOpened():
            raise CameraError(f"cannot open camera source: {source!r}")
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self._latest: Optional[np.ndarray] = None
        self._latest_at = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._reader_loop, daemon=True, name="camera-reader"
        )
        self._thread.start()
        logger.info("OpenCV camera opened: source=%r", source)

    def _reopen(self) -> bool:
        try:
            self._cap.release()
        except Exception:
            pass
        self._cap = cv2.VideoCapture(self._source)
        return self._cap.isOpened()

    def _reader_loop(self) -> None:
        consecutive_failures = 0
        while not self._stop.is_set():
            ok, frame = self._cap.read()
            if not ok or frame is None:
                consecutive_failures += 1
                if consecutive_failures >= 10:
                    logger.warning(
                        "Camera read failed %d times — attempting reopen",
                        consecutive_failures,
                    )
                    if self._reopen():
                        consecutive_failures = 0
                    else:
                        # back off before hammering the camera
                        self._stop.wait(timeout=2.0)
                else:
                    self._stop.wait(timeout=0.05)
                continue
            consecutive_failures = 0
            with self._lock:
                self._latest = frame
                self._latest_at = time.monotonic()

    def read(self) -> Optional[np.ndarray]:
        with self._lock:
            if self._latest is None:
                return None
            # Protect callers from seeing very stale frames during a reconnect
            if time.monotonic() - self._latest_at > 5.0:
                return None
            return self._latest.copy()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        try:
            self._cap.release()
        except Exception:
            pass


def open_camera(
    source_url: str,
    index: int,
    width: int,
    height: int,
    fps: int,
) -> FrameSource:
    """
    Pick the best camera backend available.

    Priority:
      * If ``source_url`` is set → OpenCV (RTSP/HTTP/file).
      * Else if Picamera2 is importable → Picamera2 (CSI on Pi 5).
      * Else → OpenCV with the given device index (USB webcam / legacy v4l2).
    """
    if source_url:
        return OpenCVSource(source_url, width, height)
    if PICAMERA2_OK:
        try:
            return Picamera2Source(width, height, fps)
        except Exception as exc:
            logger.warning(
                "Picamera2 init failed (%s) — falling back to OpenCV index %d",
                exc, index,
            )
    return OpenCVSource(index, width, height)
