#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# install_plate_model.sh
#
# One-shot helper that downloads a pretrained license-plate YOLOv8 model
# (keremberke/yolov8n-license-plate on HuggingFace, Apache 2.0) and
# exports it to ONNX for the Dismissal scanner to use.
#
# Runs inside a *temporary* virtualenv so the ~1 GB torch + ultralytics
# install doesn't pollute the scanner venv.  The exported model is
# written to /opt/dismissal/models/plate_yolo.onnx and then the temp
# venv is deleted.
#
# Re-runnable: if the target file already exists the script is a no-op.
# Usage:
#   sudo bash /opt/dismissal/deploy/install_plate_model.sh
# -----------------------------------------------------------------------------
set -euo pipefail

TARGET_DIR="/opt/dismissal/models"
TARGET_FILE="$TARGET_DIR/plate_yolo.onnx"
HF_MODEL="keremberke/yolov8n-license-plate"
# Build under /var/tmp (disk-backed) not /tmp (tmpfs on Pi OS — torch
# + ultralytics install is ~1 GB and blows the RAM-backed tmpfs).
TMP_ROOT="$(mktemp -d -p /var/tmp plate-model-XXXXXX)"
TMP_VENV="$TMP_ROOT/plate-model-venv"
DISMISSAL_USER="${DISMISSAL_USER:-dismissal}"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${GRN}[plate-model]${NC} $*"; }
warn() { echo -e "${YLW}[plate-model WARN]${NC} $*"; }
fail() { echo -e "${RED}[plate-model ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run with sudo."

if [[ -f "$TARGET_FILE" ]]; then
    info "Model already present at $TARGET_FILE — nothing to do."
    info "Delete it first if you want to re-download / re-export."
    exit 0
fi

mkdir -p "$TARGET_DIR"
chown "$DISMISSAL_USER:$DISMISSAL_USER" "$TARGET_DIR"

info "Creating temporary venv at $TMP_VENV for ultralytics conversion (~1 GB)…"
python3 -m venv "$TMP_VENV"
# shellcheck disable=SC1091
source "$TMP_VENV/bin/activate"
# Keep pip build dirs out of /tmp (tmpfs) too.
export TMPDIR="$TMP_ROOT"
trap 'deactivate 2>/dev/null || true; rm -rf "$TMP_ROOT"' EXIT

pip install --quiet --upgrade pip
# ultralytics pulls torch, torchvision, opencv, huggingface-hub, etc.
pip install --quiet ultralytics onnx onnxruntime huggingface-hub

info "Downloading pretrained model from HuggingFace: $HF_MODEL"
python3 - <<PYEOF
from ultralytics import YOLO
import shutil, os, pathlib
model = YOLO("$HF_MODEL")
# Force a 640x640 square export with built-in NMS.
model.export(format="onnx", imgsz=640, simplify=True, opset=12)
# Ultralytics writes the .onnx next to the downloaded .pt — find it.
pt = pathlib.Path(model.ckpt_path if hasattr(model, "ckpt_path") else "")
candidates = list(pathlib.Path(".").rglob("*.onnx"))
if not candidates:
    raise SystemExit("No .onnx produced")
src = max(candidates, key=lambda p: p.stat().st_mtime)
shutil.copy(src, "$TARGET_FILE")
print(f"Wrote $TARGET_FILE from {src}")
PYEOF

chown "$DISMISSAL_USER:$DISMISSAL_USER" "$TARGET_FILE"
chmod 644 "$TARGET_FILE"

info "Plate model installed: $TARGET_FILE"
info "Restart the scanner to pick it up:"
info "  sudo systemctl restart dismissal-scanner"
