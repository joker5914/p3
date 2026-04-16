#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Automated First-Boot Installer
# =============================================================================
# This script is placed on the SD card's boot partition by prepare-sdcard.sh
# and runs automatically on the Pi's first power-on via:
#   systemd.run=/boot/firmware/dismissal-firstrun.sh
#
# It requires NO SSH, NO keyboard, NO HDMI.
# Progress is written to /var/log/dismissal-firstrun.log (also to journal).
#
# What it does:
#   1. Waits for internet connectivity (up to 10 minutes)
#   2. Reads credentials from /boot/firmware/dismissal.env
#   3. Configures WiFi if WIFI_SSID was provided in dismissal-config.txt
#   4. Runs the full install.sh from the cloned repo
#   5. Copies credentials to /opt/dismissal/Backend/.env
#   6. Removes sensitive files from the FAT boot partition
#   7. Marks itself done (won't re-run on subsequent boots)
#
# Logs: journalctl -u run-u*.service  OR  cat /var/log/dismissal-firstrun.log
# =============================================================================
set -euo pipefail

BOOT="/boot/firmware"
LOG="/var/log/dismissal-firstrun.log"
DONE_MARKER="$BOOT/.dismissal-firstrun-done"
DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_BRANCH="master"
DISMISSAL_REPO="https://github.com/joker5914/Dismissal.git"

exec > >(tee -a "$LOG") 2>&1

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [firstrun] $*"; }
fail() { log "FATAL: $*"; exit 1; }

# ---------------------------------------------------------------------------
# Idempotency — don't re-run if we already completed successfully
# ---------------------------------------------------------------------------
if [[ -f "$DONE_MARKER" ]]; then
    log "First-run already completed — exiting."
    exit 0
fi

log "============================================================"
log "  Dismissal Scanner first-boot installer starting"
log "============================================================"

# ---------------------------------------------------------------------------
# Load per-device config injected by prepare-sdcard.sh
# ---------------------------------------------------------------------------
CONFIG_FILE="$BOOT/dismissal-config.txt"
if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
    log "Loaded config: branch=$DISMISSAL_BRANCH wifi_ssid=${WIFI_SSID:-(not set)}"
fi

# ---------------------------------------------------------------------------
# Optional WiFi setup (if credentials provided and not already connected)
# ---------------------------------------------------------------------------
if [[ -n "${WIFI_SSID:-}" && -n "${WIFI_PASS:-}" ]]; then
    log "Configuring WiFi: $WIFI_SSID"
    if command -v nmcli &>/dev/null; then
        nmcli device wifi connect "$WIFI_SSID" password "$WIFI_PASS" \
            || log "WARNING: nmcli wifi connect failed (may already be configured)"
    elif command -v wpa_cli &>/dev/null; then
        wpa_passphrase "$WIFI_SSID" "$WIFI_PASS" >> /etc/wpa_supplicant/wpa_supplicant.conf
        wpa_cli -i wlan0 reconfigure || true
    else
        log "WARNING: No WiFi management tool found — skipping WiFi setup."
        log "         Ensure WiFi was configured via Raspberry Pi Imager."
    fi
fi

# ---------------------------------------------------------------------------
# Wait for internet connectivity (max 10 minutes)
# ---------------------------------------------------------------------------
log "Waiting for internet connectivity…"
CONNECTED=0
for i in $(seq 1 120); do
    if curl -sf --max-time 5 https://github.com > /dev/null 2>&1; then
        CONNECTED=1
        log "Internet reachable after $((i * 5)) seconds."
        break
    fi
    sleep 5
done
[[ $CONNECTED -eq 1 ]] || fail "No internet after 10 minutes. Check WiFi configuration."

# ---------------------------------------------------------------------------
# System update (minimal — just what we need to clone and run install.sh)
# ---------------------------------------------------------------------------
log "Updating package lists and installing git…"
apt-get update -qq
apt-get install -y --no-install-recommends git curl

# ---------------------------------------------------------------------------
# Clone the repository
# ---------------------------------------------------------------------------
if [[ -d "$DISMISSAL_HOME/.git" ]]; then
    log "Repository already cloned — pulling latest $DISMISSAL_BRANCH…"
    git -C "$DISMISSAL_HOME" fetch origin
    git -C "$DISMISSAL_HOME" reset --hard "origin/$DISMISSAL_BRANCH"
else
    log "Cloning Dismissal repository (branch: $DISMISSAL_BRANCH)…"
    git clone --depth 1 --branch "$DISMISSAL_BRANCH" "$DISMISSAL_REPO" "$DISMISSAL_HOME"
fi

# ---------------------------------------------------------------------------
# Run the main install script
# The installer expects to be run as root and handles all package installs,
# venv creation, service registration, and hardware configuration.
# We pass SKIP_ENV_SETUP=1 because we handle .env ourselves below.
# ---------------------------------------------------------------------------
log "Running Dismissal install script…"
export SKIP_ENV_SETUP=1   # tell install.sh not to prompt about .env
bash "$DISMISSAL_HOME/deploy/install.sh"

# ---------------------------------------------------------------------------
# Install credentials from boot partition
# ---------------------------------------------------------------------------
ENV_SRC="$BOOT/dismissal.env"
ENV_DST="$DISMISSAL_HOME/Backend/.env"
if [[ -f "$ENV_SRC" ]]; then
    log "Installing credentials from boot partition…"
    cp "$ENV_SRC" "$ENV_DST"
    chown dismissal:dismissal "$ENV_DST"
    chmod 600 "$ENV_DST"
    log "Credentials installed to $ENV_DST"
else
    log "WARNING: $ENV_SRC not found. Scanner needs credentials before it will start."
    log "         SSH in and edit $ENV_DST, then: sudo systemctl restart dismissal-scanner"
fi

# ---------------------------------------------------------------------------
# Start services now (they will also start on every subsequent boot)
# ---------------------------------------------------------------------------
log "Starting Dismissal services…"
systemctl start dismissal-scanner dismissal-watchdog dismissal-health || true

# ---------------------------------------------------------------------------
# Security cleanup — remove credentials and config from the FAT partition
# The .env file is now safely in /opt/dismissal/Backend/.env (mode 600).
# ---------------------------------------------------------------------------
log "Removing credentials from boot partition (security cleanup)…"
rm -f "$BOOT/dismissal.env" "$BOOT/dismissal-config.txt" || true

# Leave the firstrun script itself but mark completion so it won't re-run.
touch "$DONE_MARKER"

log "============================================================"
log "  First-boot install COMPLETE."
log "  Services: $(systemctl is-active dismissal-scanner) scanner /"
log "            $(systemctl is-active dismissal-watchdog) watchdog /"
log "            $(systemctl is-active dismissal-health) health"
log "  Health:   curl http://$(hostname -I | awk '{print $1}'):9000/health"
log "  Logs:     journalctl -u dismissal-scanner -f"
log "============================================================"
log "System will reboot in 5 seconds…"
sleep 5
# systemd.run_success_action=reboot handles the reboot via the cmdline.txt hook.
# If for some reason that didn't apply, reboot explicitly:
reboot
