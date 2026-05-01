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
    "dismissal-ota"
)

# Runtime services that need to be stopped/started — factory-reset and
# setup-portal are oneshot units that fire on their own schedule.
RUNTIME_SERVICES=(
    "dismissal-scanner"
    "dismissal-watchdog"
    "dismissal-health"
    "dismissal-ota"
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

# OTA agent's privileged surface — passwordless sudo for firmware_swap.sh
# only.  Without this the OTA agent can stage and verify a release but
# cannot atomically swap it into place.
OTA_SUDOERS_SRC="$DISMISSAL_HOME/deploy/sudoers-dismissal-ota"
OTA_SUDOERS_DST="/etc/sudoers.d/dismissal-ota"
if [[ -f "$OTA_SUDOERS_SRC" ]]; then
    if visudo -c -f "$OTA_SUDOERS_SRC" &>/dev/null; then
        cp "$OTA_SUDOERS_SRC" "$OTA_SUDOERS_DST"
        chmod 0440 "$OTA_SUDOERS_DST"
        info "OTA sudoers drop-in updated."
    else
        warn "OTA sudoers validation failed — skipping update of $OTA_SUDOERS_DST"
    fi
fi
# Make sure the swap script is executable — git preserves the bit on
# clone but a fresh fetch onto an existing checkout sometimes drops it.
chmod 0755 "$DISMISSAL_HOME/deploy/firmware_swap.sh" 2>/dev/null || true

# ---------------------------------------------------------------------------
# OTA bootstrap migration (issue #104).  First time we touch a device
# after introducing OTA, set up the swappable release layout:
#
#   /opt/dismissal/
#     current        -> releases/0.0.0-legacy/   (created here)
#     releases/
#       0.0.0-legacy/Backend/                    (snapshot of current code)
#     keys/firmware.pub                          (canonical OTA pubkey)
#     ota/                                       (agent state + staging)
#
# Subsequent OTA updates extract to releases/{version}/ and flip the
# `current` symlink — the systemd units already point at
# /opt/dismissal/current/Backend/... so nothing else has to change.
# ---------------------------------------------------------------------------
if [[ ! -L "$DISMISSAL_HOME/current" ]]; then
    info "OTA bootstrap: creating /opt/dismissal/current symlink…"
    mkdir -p "$DISMISSAL_HOME/releases/0.0.0-legacy"
    # Use cp -a to preserve perms/timestamps; we don't move because
    # update.sh's own git pull above operates on $DISMISSAL_HOME/Backend
    # and we want both the OTA-managed copy AND the git copy to exist
    # so future `git pull` keeps working as a fallback.
    cp -a "$DISMISSAL_HOME/Backend" "$DISMISSAL_HOME/releases/0.0.0-legacy/"
    ln -sfn "$DISMISSAL_HOME/releases/0.0.0-legacy" "$DISMISSAL_HOME/current"
    chown -h "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME/current"
    chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME/releases"
    info "Bootstrap release: $DISMISSAL_HOME/current -> releases/0.0.0-legacy/"
fi
mkdir -p "$DISMISSAL_HOME/keys" "$DISMISSAL_HOME/ota/staging"
chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME/keys" "$DISMISSAL_HOME/ota"
# Drop in a placeholder pubkey if none is installed.  Production
# devices must overwrite this with the real key (see docs/OTA.md).
if [[ ! -f "$DISMISSAL_HOME/keys/firmware.pub" && -f "$DISMISSAL_HOME/deploy/firmware.pub.example" ]]; then
    warn "Installing PLACEHOLDER firmware.pub — OTA verification will fail"
    warn "until $DISMISSAL_HOME/keys/firmware.pub is replaced with a real key."
    cp "$DISMISSAL_HOME/deploy/firmware.pub.example" "$DISMISSAL_HOME/keys/firmware.pub"
    chown "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME/keys/firmware.pub"
    chmod 0644 "$DISMISSAL_HOME/keys/firmware.pub"
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

# Persistent journal — older installs have only the volatile journal in
# /run/log/journal, which means `journalctl -b -1` returns nothing after
# any reboot and we can't see what happened on a prior boot.  Sync the
# updated journald drop-in (Storage=persistent) and create the directory
# so journald starts persisting immediately, no reboot required.
JOURNALD_SRC="$DISMISSAL_HOME/deploy/journald-dismissal.conf"
if [[ -f "$JOURNALD_SRC" ]]; then
    mkdir -p /etc/systemd/journald.conf.d
    cp "$JOURNALD_SRC" /etc/systemd/journald.conf.d/dismissal.conf
    mkdir -p /var/log/journal
    systemctl restart systemd-journald 2>/dev/null || true
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
# Pi OS Bookworm fast-boot fix: mask both systemd-networkd-wait-online
# AND systemd-networkd itself.  An earlier install.sh enabled the wait-
# online service, which is wrong on a Pi managed by NetworkManager —
# systemd-networkd has no active interface to wait for, so it sits on
# its full 120s timeout and pushes total boot past two minutes.  Mask
# both so cloud-init / apt can't re-enable them on a future boot.
# ---------------------------------------------------------------------------
info "Masking systemd-networkd + wait-online + socket (Bookworm fast-boot fix)…"
systemctl disable --now systemd-networkd-wait-online.service 2>/dev/null || true
systemctl disable --now systemd-networkd.service 2>/dev/null || true
systemctl disable --now systemd-networkd.socket 2>/dev/null || true
systemctl mask systemd-networkd-wait-online.service
systemctl mask systemd-networkd.service
systemctl mask systemd-networkd.socket
for unit in systemd-networkd-wait-online.service \
            systemd-networkd.service \
            systemd-networkd.socket; do
    if [[ "$(systemctl is-enabled "$unit" 2>/dev/null)" != "masked" ]]; then
        warn "$unit did not report as 'masked' after mask."
    fi
done

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
