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

# 3. Find whichever recognizer class this version of the package exposes.
#    v1.1 = LicensePlateRecognizer, v1.0 = ONNXPlateRecognizer.
Recognizer = (
    getattr(fast_plate_ocr, "LicensePlateRecognizer", None)
    or getattr(fast_plate_ocr, "ONNXPlateRecognizer", None)
)
if Recognizer is None:
    print("[FAIL] neither LicensePlateRecognizer nor ONNXPlateRecognizer "
          "is exported by fast_plate_ocr")
    sys.exit(1)
print(f"[OK]   Recognizer class: {Recognizer.__name__}")

rec = step(
    f"{Recognizer.__name__}('global-plates-mobile-vit-v2-model')",
    lambda: Recognizer("global-plates-mobile-vit-v2-model"),
)

# 4. Run on a throwaway blank image (just to shake out .run() signature)
import numpy as np  # noqa: E402

blank = np.zeros((100, 300), dtype=np.uint8)
try:
    out = rec.run(blank, return_confidence=True)
    print(f"[OK]   rec.run(blank, return_confidence=True) → {out!r}")
except TypeError:
    out = rec.run(blank)
    print(f"[OK]   rec.run(blank) → {out!r}")
except Exception as exc:
    print(f"[FAIL] rec.run(): {type(exc).__name__}: {exc}")
    traceback.print_exc()
    sys.exit(1)

print("[DONE] fast-plate-ocr is healthy in this venv.")
