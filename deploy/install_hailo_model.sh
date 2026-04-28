#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# install_hailo_model.sh
#
# Setup helper for the Raspberry Pi AI HAT+ (Hailo-8L).  Two phases:
#
# 1. ON THE PI (this script when the HAT+ is attached):
#    - Installs the Hailo apt stack (hailo-all).
#    - Verifies the driver can see the chip.
#    - Places a compiled plate_yolo.hef at /opt/dismissal/models/ if
#      one was already scp'd there; otherwise prints instructions.
#
# 2. ON AN x86 LINUX WORKSTATION (not this script):
#    Compile plate_yolo.onnx → plate_yolo.hef with Hailo's Dataflow
#    Compiler.  The compiler is free but Hailo-account-gated; sign up
#    at https://hailo.ai and install the SDK.  Rough steps:
#
#      hailo parser onnx plate_yolo.onnx
#      hailo optimize plate_yolo.har --calib-set-path calib/
#      hailo compile plate_yolo.har
#      scp plate_yolo.hef pi@dismissal-edge:/opt/dismissal/models/
#
#    A calibration set of ~100 representative plate images is enough
#    for a single-class detector.  Inaccuracy from quantisation is
#    usually <1% mAP.
# -----------------------------------------------------------------------------
set -euo pipefail

HEF_PATH="/opt/dismissal/models/plate_yolo.hef"
DISMISSAL_USER="${DISMISSAL_USER:-dismissal}"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; NC='\033[0m'
info() { echo -e "${GRN}[hailo-setup]${NC} $*"; }
warn() { echo -e "${YLW}[hailo-setup WARN]${NC} $*"; }
fail() { echo -e "${RED}[hailo-setup ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run with sudo."

# 1. Install the Hailo apt stack if it's missing.  Pulls in the kernel
#    module, firmware, libhailort, and python3-hailort.
if dpkg -s hailo-all &>/dev/null; then
    info "hailo-all already installed."
else
    info "Installing hailo-all (kernel driver + runtime + Python bindings)…"
    apt-get update -qq
    apt-get install -y --no-install-recommends hailo-all
    info "Reboot recommended once after install so the kernel module loads."
fi

# 1b. Disable hailort.service.  The hailo-all package installs and enables
# a multi-process broker daemon at /usr/bin/hailort_service that holds
# /dev/hailo0 exclusively.  Direct VDevice() opens from our scanner then
# fail with HAILO_DRIVER_OPERATION_FAILED(36) and we silently fall back
# to ONNX/CPU.  Since only the dismissal-scanner uses the chip, we don't
# need the broker — disable it so the scanner gets direct access.
if systemctl is-enabled hailort.service &>/dev/null \
   || systemctl is-active hailort.service &>/dev/null; then
    info "Disabling hailort.service (multi-process broker; not needed here)…"
    systemctl disable --now hailort.service 2>/dev/null || true
fi

# 2. Verify the device is present.
if command -v hailortcli &>/dev/null; then
    if hailortcli fw-control identify 2>/dev/null | grep -q "Hailo"; then
        info "Hailo device detected:"
        hailortcli fw-control identify | sed 's/^/    /'
    else
        warn "hailortcli didn't see a Hailo device.  Check the HAT+ is"
        warn "seated on the PCIe FPC connector and that you've rebooted"
        warn "at least once after installing hailo-all."
    fi
else
    warn "hailortcli not on PATH — hailo-all may not have installed cleanly."
fi

# 3. Make sure the models directory exists.
mkdir -p "$(dirname "$HEF_PATH")"
chown "$DISMISSAL_USER:$DISMISSAL_USER" "$(dirname "$HEF_PATH")"

if [[ -f "$HEF_PATH" ]]; then
    info "Plate HEF already in place: $HEF_PATH"
    info "Enable it by adding these lines to /opt/dismissal/Backend/.env:"
    echo "    SCANNER_USE_HAILO=1"
    echo "    SCANNER_PLATE_MODEL_HEF_PATH=$HEF_PATH"
    info "Then: sudo systemctl restart dismissal-scanner"
else
    cat <<EOF
${YLW}
[hailo-setup] No plate_yolo.hef found at $HEF_PATH.

The Hailo chip needs a model file compiled by Hailo's Dataflow Compiler,
which runs on an x86 Linux machine, not the Pi itself.  Steps:

  1. Sign up at https://hailo.ai, install the Dataflow Compiler.
  2. On the x86 box, run:
       hailo parser onnx plate_yolo.onnx
       hailo optimize plate_yolo.har --calib-set-path calib/
       hailo compile plate_yolo.har
     (calib/ should hold ~100 representative plate images as PNG/JPG.)
  3. Copy the result to the Pi:
       scp plate_yolo.hef pi@$(hostname):$HEF_PATH
  4. Re-run this script or set:
       SCANNER_USE_HAILO=1
       SCANNER_PLATE_MODEL_HEF_PATH=$HEF_PATH
     in /opt/dismissal/Backend/.env, then restart the scanner.

For a faster path, skip the custom model and grab a pre-compiled
YOLOv8n HEF from Hailo's Model Zoo — accuracy will be lower on plates
but it gets the hardware online in minutes.
${NC}
EOF
fi
