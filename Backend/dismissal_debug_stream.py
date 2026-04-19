"""Lightweight LAN-only debug HTTP server for the Pi scanner.

Serves the current camera frame with detection/OCR overlays so an
operator can confirm, from any browser on the same network, that:

  * the camera is producing frames,
  * the motion gate is passing/blocking reasonably,
  * candidate regions are being detected,
  * OCR is firing and why plates are being accepted or rejected.

Routes (default port 8081, bound to 0.0.0.0):

  GET /              HTML page with the live stream + live stats panel
  GET /stream.mjpg   multipart/x-mixed-replace MJPEG stream
  GET /snapshot.jpg  single current frame
  GET /stats         JSON with the same fields the panel renders

There is intentionally no auth — keep the port LAN-only.  Uses only the
Python stdlib plus OpenCV (already a dependency of the scanner).
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

import cv2

logger = logging.getLogger(__name__)

# BGR (OpenCV) overlay colors.
_COLOR_ACCEPT = (0, 220, 0)      # green — a plate OCR'd cleanly
_COLOR_REJECT = (0, 120, 255)    # orange — a candidate that failed a gate
_COLOR_MOTION = (0, 255, 255)    # yellow — motion gate state badge
_COLOR_INFO   = (230, 230, 230)  # off-white — footer text

Bbox = Tuple[int, int, int, int]


class DebugStream:
    """Thread-safe latest-frame buffer + HTTP streaming server.

    Usage inside the scanner main loop::

        debug = DebugStream(port=8081)
        debug.start()
        ...
        debug.update(frame, motion=True, candidates=cands, accepted_plates=...)
    """

    def __init__(self, port: int = 8081, host: str = "0.0.0.0"):
        self._port = port
        self._host = host

        self._state_lock = threading.Lock()
        self._frame_jpeg: Optional[bytes] = None
        self._stats: Dict[str, Any] = {
            "ts": None,
            "motion": None,
            "candidates": 0,
            "accepted": 0,
            "reject_reason": None,
            "reject_guess": None,
            "reject_conf": None,
            "fps": None,
            "frame_count": 0,
        }
        # Rolling window of frame timestamps, to compute a smoothed FPS
        # without requiring the caller to track it.
        self._tick_times: deque = deque(maxlen=30)
        self._frame_count = 0

        # Wakes up MJPEG handlers when a new frame is ready.
        self._new_frame = threading.Condition()
        self._frame_seq = 0

        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        handler_cls = self._make_handler_class()
        self._server = ThreadingHTTPServer((self._host, self._port), handler_cls)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="debug-stream",
            daemon=True,
        )
        self._thread.start()
        logger.info("Debug stream listening on http://%s:%d/", self._host, self._port)

    def stop(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
            except Exception:
                pass

    # ------------------------------------------------------------------ frame ingest

    def update(
        self,
        frame,
        *,
        motion: Optional[bool] = None,
        candidates: Optional[List[Tuple[Any, Bbox]]] = None,
        accepted_plates: Optional[List[Tuple[str, float, Bbox]]] = None,
        reject_reason: Optional[str] = None,
        reject_guess: Optional[str] = None,
        reject_conf: Optional[float] = None,
    ) -> None:
        """Annotate a copy of ``frame`` and publish it to HTTP clients.

        Callers pass everything they know about the frame; missing values
        are fine and simply won't appear in the overlay.
        """
        if frame is None:
            return

        now = time.monotonic()
        self._tick_times.append(now)
        fps = self._rolling_fps()
        self._frame_count += 1

        annotated = frame.copy()
        h, w = annotated.shape[:2]

        # Motion badge (top-left).
        if motion is not None:
            badge = "MOTION: YES" if motion else "MOTION: NO"
            badge_color = _COLOR_ACCEPT if motion else _COLOR_MOTION
            cv2.putText(
                annotated, badge, (12, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, badge_color, 2,
            )

        # Every candidate region (orange, thin).
        if candidates:
            for _, bbox in candidates:
                x1, y1, x2, y2 = bbox
                cv2.rectangle(annotated, (x1, y1), (x2, y2), _COLOR_REJECT, 2)

        # Accepted plates (green, thicker, with label).
        if accepted_plates:
            for plate, conf, bbox in accepted_plates:
                x1, y1, x2, y2 = bbox
                cv2.rectangle(annotated, (x1, y1), (x2, y2), _COLOR_ACCEPT, 3)
                cv2.putText(
                    annotated, f"{plate}  {conf:.0%}",
                    (x1, max(18, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, _COLOR_ACCEPT, 2,
                )

        # Footer: fps + last reject reason (when motion passed but nothing
        # cleared OCR).  Keeps the "why isn't my car showing up?" answer
        # one glance away.
        footer_parts: List[str] = []
        if fps is not None:
            footer_parts.append(f"fps={fps:.1f}")
        if candidates is not None:
            footer_parts.append(f"cands={len(candidates)}")
        if reject_reason:
            guess = reject_guess if reject_guess is not None else "—"
            conf_txt = f"{reject_conf:.2f}" if reject_conf is not None else "—"
            footer_parts.append(f"last_reject={reject_reason} guess={guess!r} conf={conf_txt}")
        if footer_parts:
            cv2.putText(
                annotated, "  ".join(footer_parts),
                (12, h - 14),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, _COLOR_INFO, 1,
            )

        ok, jpeg = cv2.imencode(
            ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80],
        )
        if not ok:
            return
        jpeg_bytes = jpeg.tobytes()

        with self._state_lock:
            self._frame_jpeg = jpeg_bytes
            self._stats = {
                "ts": time.time(),
                "motion": motion,
                "candidates": len(candidates or []),
                "accepted": len(accepted_plates or []),
                "reject_reason": reject_reason,
                "reject_guess": reject_guess,
                "reject_conf": reject_conf,
                "fps": round(fps, 2) if fps is not None else None,
                "frame_count": self._frame_count,
                "frame_shape": [h, w],
            }

        with self._new_frame:
            self._frame_seq += 1
            self._new_frame.notify_all()

    def _rolling_fps(self) -> Optional[float]:
        if len(self._tick_times) < 2:
            return None
        span = self._tick_times[-1] - self._tick_times[0]
        if span <= 0:
            return None
        return (len(self._tick_times) - 1) / span

    # ------------------------------------------------------------------ http layer

    def _make_handler_class(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            # Silence the default one-line-per-request stdout noise; the
            # scanner already logs the interesting events elsewhere.
            def log_message(self, fmt, *args):
                return

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if path == "/" or path == "/index.html":
                    self._serve_html()
                elif path == "/stream.mjpg":
                    self._serve_mjpeg()
                elif path == "/snapshot.jpg":
                    self._serve_snapshot()
                elif path == "/stats":
                    self._serve_stats()
                else:
                    self.send_error(404, "not found")

            def _serve_html(self):
                body = _HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _serve_snapshot(self):
                with outer._state_lock:
                    jpeg = outer._frame_jpeg
                if jpeg is None:
                    self.send_error(503, "no frame yet")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpeg)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpeg)

            def _serve_stats(self):
                with outer._state_lock:
                    body = json.dumps(outer._stats).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _serve_mjpeg(self):
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "multipart/x-mixed-replace; boundary=frame",
                )
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()

                last_seq = -1
                try:
                    while True:
                        with outer._new_frame:
                            # Timeout so we can detect broken clients even
                            # if the scanner momentarily stops producing.
                            outer._new_frame.wait(timeout=1.0)
                            seq = outer._frame_seq
                        if seq == last_seq:
                            continue
                        last_seq = seq
                        with outer._state_lock:
                            jpeg = outer._frame_jpeg
                        if not jpeg:
                            continue
                        self.wfile.write(b"--frame\r\n")
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(
                            f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii"),
                        )
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

        return Handler


_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dismissal Scanner \u2014 Debug</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin:0; padding:0; background:#0d0f11; color:#e6e6e6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    header { padding:.75rem 1rem; background:#15181c; border-bottom:1px solid #1f2328; }
    header strong { color:#fff; }
    header .hint { color:#8a9099; margin-left:.6rem; font-size:.85rem; }
    main { display:grid; grid-template-columns: 1fr 280px; gap:1rem; padding:1rem; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
    .feed { background:#000; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center; }
    .feed img { width:100%; max-height:78vh; object-fit:contain; display:block; }
    .panel { background:#15181c; border:1px solid #1f2328; border-radius:8px; padding:.85rem 1rem; }
    .panel h2 { margin:0 0 .5rem; font-size:.8rem; color:#8a9099; letter-spacing:.08em; text-transform:uppercase; }
    dl { margin:0; }
    dt { color:#8a9099; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; margin-top:.55rem; }
    dd { margin:.15rem 0 0 0; font-variant-numeric: tabular-nums; color:#e6e6e6; }
    code { color:#9fe; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .motion-yes { color:#7ee787; }
    .motion-no  { color:#ffa657; }
  </style>
</head>
<body>
  <header>
    <strong>Dismissal Scanner</strong>
    <span class="hint">live debug view \u2014 green = accepted plate, orange = candidate</span>
  </header>
  <main>
    <div class="feed"><img src="/stream.mjpg" alt="camera feed"></div>
    <aside class="panel">
      <h2>Status</h2>
      <dl id="stats"></dl>
    </aside>
  </main>
  <script>
    const LABELS = {
      ts: "Last update",
      motion: "Motion gate",
      candidates: "Candidates",
      accepted: "Accepted plates",
      reject_reason: "Last reject",
      reject_guess: "Last guess",
      reject_conf: "Last conf",
      fps: "FPS",
      frame_count: "Frames served",
      frame_shape: "Resolution",
    };
    function fmt(k, v) {
      if (v === null || v === undefined) return "\u2014";
      if (k === "ts") return new Date(v * 1000).toLocaleTimeString();
      if (k === "motion") {
        return `<span class="${v ? 'motion-yes':'motion-no'}">${v ? 'YES':'NO'}</span>`;
      }
      if (k === "frame_shape" && Array.isArray(v)) return `${v[1]}\u00d7${v[0]}`;
      if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
      return String(v);
    }
    async function tick() {
      try {
        const r = await fetch('/stats', {cache: 'no-store'});
        const s = await r.json();
        const order = Object.keys(LABELS);
        const dl = document.getElementById('stats');
        dl.innerHTML = order
          .map(k => `<dt>${LABELS[k]}</dt><dd><code>${fmt(k, s[k])}</code></dd>`)
          .join('');
      } catch (e) { /* ignore */ }
    }
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>
"""
