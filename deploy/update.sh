#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Field Update Script
# =============================================================================
# Pulls the latest code, upgrades dependencies, reloads service units, and
# restarts all services.  Safe to run remotely over SSH.
#
# Usage:
#   sudo bash /opt/dismissal/deploy/update.sh
# =============================================================================
set -euo pipefail

DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_USER="dismissal"
DISMISSAL_BRANCH="master"
SERVICES=("dismissal-scanner" "dismissal-watchdog" "dismissal-health")

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; NC="\033[0m"
info() { echo -e "${GREEN}[Dismissal UPDATE]${NC} $*"; }
warn() { echo -e "${YELLOW}[Dismissal WARN]${NC} $*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

info "Stopping Dismissal services…"
for svc in "${SERVICES[@]}"; do
    systemctl stop "$svc" 2>/dev/null || true
done

info "Pulling latest code from $DISMISSAL_BRANCH…"
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" fetch origin
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" reset --hard "origin/$DISMISSAL_BRANCH"

# ---------------------------------------------------------------------------
# Upgrade the Python venv itself before installing packages.
# Over time, pip and setuptools drift; upgrading the venv avoids subtle
# "package already installed at wrong version" failures.
# --system-site-packages is preserved since it was set at creation time.
# ---------------------------------------------------------------------------
info "Upgrading Python virtual environment…"
sudo -u "$DISMISSAL_USER" python3 -m venv \
    --upgrade \
    --system-site-packages \
    "$DISMISSAL_HOME/venv"

info "Upgrading pip and scanner dependencies…"
sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" \
    install --upgrade pip --quiet
sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" \
    install --quiet \
    -r "$DISMISSAL_HOME/Backend/requirements-scanner.txt"

# ---------------------------------------------------------------------------
# Re-install the sudoers drop-in in case it changed in this release.
# Validate with visudo before installing.
# ---------------------------------------------------------------------------
SUDOERS_SRC="$DISMISSAL_HOME/deploy/sudoers-dismissal"
SUDOERS_DST="/etc/sudoers.d/dismissal-watchdog"
if [[ -f "$SUDOERS_SRC" ]]; then
    if visudo -c -f "$SUDOERS_SRC" &>/dev/null; then
        cp "$SUDOERS_SRC" "$SUDOERS_DST"
        chmod 0440 "$SUDOERS_DST"
        info "sudoers drop-in updated."
    else
        warn "sudoers validation failed — skipping update of $SUDOERS_DST"
    fi
fi

# ---------------------------------------------------------------------------
# Reload systemd service units and re-enable in case unit files changed.
# ---------------------------------------------------------------------------
info "Reloading systemd unit files…"
for svc in "${SERVICES[@]}"; do
    cp "$DISMISSAL_HOME/deploy/${svc}.service" "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload
for svc in "${SERVICES[@]}"; do
    systemctl enable "$svc" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Download model update if the expected path is missing (e.g. new SD card)
# ---------------------------------------------------------------------------
MODEL_FILE="$DISMISSAL_HOME/models/plate_detector_edgetpu.tflite"
MODEL_URL="https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"
if [[ ! -f "$MODEL_FILE" ]]; then
    warn "Model file missing — attempting re-download…"
    mkdir -p "$DISMISSAL_HOME/models"
    wget -q --show-progress -O "$MODEL_FILE" "$MODEL_URL" \
        && chown "$DISMISSAL_USER:$DISMISSAL_USER" "$MODEL_FILE" \
        && info "Model re-downloaded." \
        || warn "Model download failed — contour-only detection will be used."
fi

info "Starting Dismissal services…"
for svc in "${SERVICES[@]}"; do
    systemctl start "$svc"
done

info "Update complete.  Service status:"
for svc in "${SERVICES[@]}"; do
    echo ""
    systemctl status "$svc" --no-pager --lines=3 || true
done
