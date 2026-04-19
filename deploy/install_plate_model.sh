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
# Override with: sudo bash install_plate_model.sh <hf-repo>
# Known-working alternatives to try if the default ever 404s:
#   morsetechlab/yolov8-license-plate-detector
#   nickmuchi/yolos-small-finetuned-license-plate-detection  (different arch, won't work with YOLO())
#   harpreetsahota/yolov8n-license-plate                     (community)
# Or pass a local .pt directly: sudo bash install_plate_model.sh --pt=/path/to/model.pt
HF_MODEL="${1:-morsetechlab/yolov8-license-plate-detector}"
LOCAL_PT=""
if [[ "$HF_MODEL" == --pt=* ]]; then
    LOCAL_PT="${HF_MODEL#--pt=}"
    HF_MODEL=""
fi
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

if [[ -n "$LOCAL_PT" ]]; then
    info "Using local weights file: $LOCAL_PT"
    if [[ ! -f "$LOCAL_PT" ]]; then
        fail "Local .pt file not found: $LOCAL_PT"
    fi
else
    info "Downloading pretrained model from HuggingFace: $HF_MODEL"
fi
python3 - <<PYEOF
import pathlib, shutil, sys
from ultralytics import YOLO

local_pt = "$LOCAL_PT"
repo = "$HF_MODEL"

if local_pt:
    pt_path = local_pt
else:
    from huggingface_hub import hf_hub_download, list_repo_files
    try:
        files = list_repo_files(repo)
    except Exception as exc:
        sys.exit(
            f"Could not list HF repo {repo!r}: {exc}\n"
            f"Try another repo:\n"
            f"  sudo bash install_plate_model.sh <user/model>\n"
            f"Or provide a local .pt file:\n"
            f"  sudo bash install_plate_model.sh --pt=/path/to/model.pt\n"
        )
    pt_files = sorted(f for f in files if f.endswith(".pt"))
    if not pt_files:
        sys.exit(f"Repo {repo!r} has no .pt weights file")
    pt_name = next((f for f in pt_files if f.endswith("best.pt")), pt_files[0])
    print(f"Downloading weights file: {pt_name}")
    pt_path = hf_hub_download(repo_id=repo, filename=pt_name)
    print(f"Weights at {pt_path}")

model = YOLO(pt_path)
model.export(format="onnx", imgsz=640, simplify=True, opset=12)

candidates = list(pathlib.Path(pt_path).parent.rglob("*.onnx"))
candidates += list(pathlib.Path(".").rglob("*.onnx"))
if not candidates:
    sys.exit("No .onnx produced by export")
src = max(candidates, key=lambda p: p.stat().st_mtime)
shutil.copy(src, "$TARGET_FILE")
print(f"Wrote $TARGET_FILE from {src}")
PYEOF

chown "$DISMISSAL_USER:$DISMISSAL_USER" "$TARGET_FILE"
chmod 644 "$TARGET_FILE"

info "Plate model installed: $TARGET_FILE"
info "Restart the scanner to pick it up:"
info "  sudo systemctl restart dismissal-scanner"
