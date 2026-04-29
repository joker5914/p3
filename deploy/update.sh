#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Field Update Script
# =============================================================================
# Pulls the latest code, upgrades dependencies, syncs every systemd unit +
# config drop-in we ship, and restarts services.  Safe to run remotely
# over SSH and idempotent.
#
# Usage:
#   sudo bash /opt/dismissal/deploy/update.sh
# =============================================================================
set -euo pipefail

DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_USER="dismissal"
DISMISSAL_BRANCH="master"

# Order matters here: factory-reset must run early at boot; setup-portal
# gates the runtime services on the wifi-provisioned marker.
SERVICES=(
    "dismissal-factory-reset"
    "dismissal-setup-portal"
    "dismissal-scanner"
    "dismissal-watchdog"
    "dismissal-health"
)

# Runtime services that need to be stopped/started — factory-reset and
# setup-portal are oneshot units that fire on their own schedule.
RUNTIME_SERVICES=(
    "dismissal-scanner"
    "dismissal-watchdog"
    "dismissal-health"
)

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; NC="\033[0m"
info() { echo -e "${GREEN}[Dismissal UPDATE]${NC} $*"; }
warn() { echo -e "${YELLOW}[Dismissal WARN]${NC} $*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

append_once() {
    local file="$1" line="$2"
    grep -qxF "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
}

# ---------------------------------------------------------------------------
# Stop the runtime services so we can swap unit files without races.
# ---------------------------------------------------------------------------
info "Stopping runtime services…"
for svc in "${RUNTIME_SERVICES[@]}"; do
    systemctl stop "$svc" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Pull the latest code.
# ---------------------------------------------------------------------------
info "Pulling latest code from $DISMISSAL_BRANCH…"
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" fetch origin
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" reset --hard "origin/$DISMISSAL_BRANCH"

# ---------------------------------------------------------------------------
# Upgrade the venv + scanner deps.
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
# Re-install the sudoers drop-in if it shipped with this release.
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
# Re-install every systemd unit we ship.  Catches new units (setup-portal,
# factory-reset) on devices that were last imaged before they existed.
# ---------------------------------------------------------------------------
info "Syncing systemd unit files…"
for svc in "${SERVICES[@]}"; do
    src="$DISMISSAL_HOME/deploy/${svc}.service"
    if [[ -f "$src" ]]; then
        cp "$src" "/etc/systemd/system/${svc}.service"
    else
        warn "Missing $src — skipping $svc"
    fi
done
systemctl daemon-reload
for svc in "${SERVICES[@]}"; do
    [[ -f "$DISMISSAL_HOME/deploy/${svc}.service" ]] || continue
    systemctl enable "$svc" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Captive portal + factory-reset config drop-ins.
#
# These came in with the captive-portal release; an older device that
# only ran update.sh wouldn't have them.  Mirror what install.sh does so
# update is a true superset.
# ---------------------------------------------------------------------------
info "Syncing captive-portal + factory-reset config drop-ins…"

DNS_SRC="$DISMISSAL_HOME/deploy/dismissal-captive-dnsmasq.conf"
if [[ -f "$DNS_SRC" ]]; then
    mkdir -p /etc/NetworkManager/dnsmasq-shared.d
    cp "$DNS_SRC" /etc/NetworkManager/dnsmasq-shared.d/dismissal-captive.conf
fi

LOGIND_SRC="$DISMISSAL_HOME/deploy/dismissal-logind.conf"
if [[ -f "$LOGIND_SRC" ]]; then
    mkdir -p /etc/systemd/logind.conf.d
    cp "$LOGIND_SRC" /etc/systemd/logind.conf.d/dismissal.conf
    systemctl reload systemd-logind 2>/dev/null || true
fi

# Older versions of update.sh appended a non-existent dtparam line to
# /boot/firmware/config.txt in an attempt to suppress the Pi 5 PMIC's
# long-press shutdown.  That parameter doesn't exist (the PMIC behavior
# is enforced in firmware below the OS), and the gesture is now a
# multi-tap rather than a hold, so the line is unnecessary.  Strip it
# out on upgrade so config.txt stays clean.
boot_config="/boot/firmware/config.txt"
[[ -f "$boot_config" ]] || boot_config="/boot/config.txt"
if [[ -f "$boot_config" ]] && grep -q '^dtparam=power_button_off=' "$boot_config"; then
    sed -i '/^dtparam=power_button_off=/d' "$boot_config"
    info "Removed legacy dtparam=power_button_off line from $boot_config."
fi

# ---------------------------------------------------------------------------
# Pi OS Bookworm fast-boot fix: mask systemd-networkd-wait-online.
#
# An earlier install.sh enabled this service, which is wrong on a Pi
# managed by NetworkManager — systemd-networkd has no active interface
# to wait for, so it sits on its full 120s timeout and pushes total
# boot past two minutes.  Mask it here so existing in-field devices
# get the fix without a re-image.
# ---------------------------------------------------------------------------
info "Masking redundant systemd-networkd-wait-online (Bookworm fast-boot fix)…"
systemctl disable --now systemd-networkd-wait-online.service 2>/dev/null || true
systemctl mask systemd-networkd-wait-online.service 2>/dev/null || true

# ---------------------------------------------------------------------------
# Backfill the wifi-provisioned marker for devices that came up before
# the marker existed.  Without this, scanner / watchdog / health all
# silently refuse to start because of their ConditionPathExists gate.
# ---------------------------------------------------------------------------
MARKER="/var/lib/dismissal/.wifi-provisioned"
if [[ ! -f "$MARKER" ]]; then
    has_real_wifi=0
    if command -v nmcli >/dev/null 2>&1; then
        while IFS=: read -r name ctype; do
            [[ "$ctype" == "802-11-wireless" ]] || continue
            [[ "$name" == "dismissal-setup" ]] && continue
            has_real_wifi=1
            break
        done < <(nmcli -t -f NAME,TYPE connection show 2>/dev/null)
    fi
    if (( has_real_wifi )); then
        mkdir -p /var/lib/dismissal
        echo "backfilled by update.sh on $(date '+%Y-%m-%dT%H:%M:%S%z')" \
            > "$MARKER"
        info "Detected existing WiFi profile — wrote $MARKER (unblocks runtime services)."
    else
        warn "No real WiFi profile detected — runtime services will stay paused"
        warn "until the captive portal provisions WiFi.  If this is a wired-only"
        warn "device, run:  sudo touch $MARKER"
    fi
fi

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

# ---------------------------------------------------------------------------
# Bring runtime services back up.  factory-reset / setup-portal are
# oneshot — they'll run on next boot or stay inactive as appropriate.
# ---------------------------------------------------------------------------
info "Starting runtime services…"
for svc in "${RUNTIME_SERVICES[@]}"; do
    systemctl start "$svc"
done

info "Update complete.  Service status:"
for svc in "${SERVICES[@]}"; do
    echo ""
    systemctl status "$svc" --no-pager --lines=3 || true
done

if [[ "${REBOOT_REQUIRED:-0}" -eq 1 ]]; then
    echo ""
    warn "============================================================"
    warn "  REBOOT REQUIRED for the new dtparam= setting in"
    warn "  $boot_config to take effect.  Run:"
    warn "    sudo reboot"
    warn "============================================================"
fi
