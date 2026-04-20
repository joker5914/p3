#!/usr/bin/env python3
"""Quick probe to find out why fast-plate-ocr isn't loading on the Pi.

Run with the scanner venv so it matches the real import environment:

    sudo -u dismissal /opt/dismissal/venv/bin/python \\
        /opt/dismissal/deploy/check_fast_plate_ocr.py
"""
import sys
import traceback


def step(label, fn):
    try:
        value = fn()
        print(f"[OK]   {label}: {value}")
        return value
    except Exception as exc:
        print(f"[FAIL] {label}: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        sys.exit(1)


# 1. Top-level module import
step("import fast_plate_ocr", lambda: __import__("fast_plate_ocr"))

# 2. What names does the module actually expose?
import fast_plate_ocr  # noqa: E402

public = [n for n in dir(fast_plate_ocr) if not n.startswith("_")]
print(f"[INFO] fast_plate_ocr.__version__ = "
      f"{getattr(fast_plate_ocr, '__version__', 'unknown')}")
print(f"[INFO] public attributes: {public}")

# 3. Try the class name we rely on
step(
    "from fast_plate_ocr import ONNXPlateRecognizer",
    lambda: __import__("fast_plate_ocr", fromlist=["ONNXPlateRecognizer"])
            .ONNXPlateRecognizer,
)

# 4. Instantiate the default model
from fast_plate_ocr import ONNXPlateRecognizer  # noqa: E402

rec = step(
    "ONNXPlateRecognizer('global-plates-mobile-vit-v2-model')",
    lambda: ONNXPlateRecognizer("global-plates-mobile-vit-v2-model"),
)

# 5. Run on a throwaway blank image (just to shake out .run() signature)
import numpy as np  # noqa: E402

blank = np.zeros((100, 300), dtype=np.uint8)
try:
    out = rec.run(blank, return_confidence=True)
    print(f"[OK]   rec.run(blank, return_confidence=True) → {out!r}")
except TypeError:
    out = rec.run(blank)
    print(f"[OK]   rec.run(blank) → {out!r}  "
          f"(older API, no return_confidence)")
except Exception as exc:
    print(f"[FAIL] rec.run(): {type(exc).__name__}: {exc}")
    traceback.print_exc()
    sys.exit(1)

print("[DONE] fast-plate-ocr is healthy in this venv.")
