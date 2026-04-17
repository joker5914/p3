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
# Idempotency — don't re-run if we already completed successfully.
#
# If DONE_MARKER exists AND cmdline.txt still has our hook (meaning a prior
# run of firstrun.sh completed but didn't strip cmdline.txt), strip it now
# and reboot.  Otherwise the Pi would infinite-reboot-loop: firstrun exits 0
# → systemd run_success_action=reboot → next boot re-enters
# kernel-command-line.target → firstrun exits 0 → …
# ---------------------------------------------------------------------------
if [[ -f "$DONE_MARKER" ]]; then
    log "First-run already completed — cleaning cmdline.txt hook and exiting."
    CMDLINE_FILE="$BOOT/cmdline.txt"
    if [[ -f "$CMDLINE_FILE" ]] && grep -q 'dismissal-firstrun' "$CMDLINE_FILE"; then
        sed -i '
            s| systemd\.run=[^ ]*||g
            s| systemd\.run_success_action=[^ ]*||g
            s| systemd\.run_failure_action=[^ ]*||g
            s| systemd\.unit=kernel-command-line\.target||g
            s|  *$||
        ' "$CMDLINE_FILE"
    fi
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
    log "Loaded config: branch=$DISMISSAL_BRANCH hostname=${DISMISSAL_HOSTNAME:-(unchanged)} wifi_ssid=${WIFI_SSID:-(not set)}"
fi

# ---------------------------------------------------------------------------
# Apply hostname (set by prepare-sdcard.sh; format: Dismissal-Edge-XXXXXXXX)
# ---------------------------------------------------------------------------
if [[ -n "${DISMISSAL_HOSTNAME:-}" ]]; then
    OLD_HOSTNAME=$(hostname)
    if [[ "$OLD_HOSTNAME" != "$DISMISSAL_HOSTNAME" ]]; then
        log "Setting hostname: $OLD_HOSTNAME → $DISMISSAL_HOSTNAME"
        hostnamectl set-hostname "$DISMISSAL_HOSTNAME"
        echo "$DISMISSAL_HOSTNAME" > /etc/hostname
        # Update the 127.0.1.1 line in /etc/hosts so sudo/avahi resolve the new name
        if grep -q '^127\.0\.1\.1' /etc/hosts; then
            sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t${DISMISSAL_HOSTNAME}/" /etc/hosts
        else
            echo -e "127.0.1.1\t${DISMISSAL_HOSTNAME}" >> /etc/hosts
        fi
        # Restart avahi so .local resolution picks up the new name without a reboot
        systemctl restart avahi-daemon 2>/dev/null || true
    fi
fi

# ---------------------------------------------------------------------------
# WiFi setup (if credentials provided)
#
# firstrun.sh runs very early in boot via `systemd.run=…`, often BEFORE
# NetworkManager finishes starting — so `nmcli device wifi connect` races the
# daemon and fails with "NetworkManager is not running".
#
# Robust strategy: write a NetworkManager connection profile directly to
# /etc/NetworkManager/system-connections/ — NM discovers it whenever it comes
# up (now or later) and autoconnects.  Then nudge NM active and retry a live
# `nmcli connection up` for good measure; if that races, the on-disk profile
# still wins the moment NM is ready.
# ---------------------------------------------------------------------------
if [[ -n "${WIFI_SSID:-}" && -n "${WIFI_PASS:-}" ]]; then
    log "Configuring WiFi: $WIFI_SSID"

    # Pi OS Bookworm+ soft-blocks the WiFi radio via rfkill until a wireless
    # regulatory domain is set.  With no country, the Pi won't even scan, let
    # alone associate — the hotspot side sees zero connect attempts.  Set the
    # country (defaults to US; override with WIFI_COUNTRY= in dismissal-config.txt),
    # then unblock rfkill explicitly in case Imager set it differently.
    WIFI_CC="${WIFI_COUNTRY:-US}"
    log "Setting WiFi regulatory domain: $WIFI_CC"
    if command -v raspi-config &>/dev/null; then
        raspi-config nonint do_wifi_country "$WIFI_CC" 2>&1 | tee -a "$LOG" || true
    fi
    iw reg set "$WIFI_CC" 2>/dev/null || true
    rfkill unblock wifi 2>/dev/null || true
    rfkill unblock all 2>/dev/null || true
    log "rfkill state after unblock:"
    rfkill list 2>&1 | tee -a "$LOG" || true

    NM_CONN_DIR="/etc/NetworkManager/system-connections"
    if [[ -d "$NM_CONN_DIR" ]] || mkdir -p "$NM_CONN_DIR" 2>/dev/null; then
        NM_PROFILE="$NM_CONN_DIR/dismissal-wifi.nmconnection"
        log "Writing NetworkManager profile → $NM_PROFILE"
        cat > "$NM_PROFILE" <<EOF
[connection]
id=dismissal-wifi
type=wifi
autoconnect=true
interface-name=wlan0

[wifi]
mode=infrastructure
ssid=$WIFI_SSID

[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_PASS
pmf=1

[ipv4]
method=auto

[ipv6]
method=auto
EOF
        chmod 600 "$NM_PROFILE"
    else
        log "WARNING: could not write NetworkManager profile directory."
    fi

    # Enable + start NetworkManager (harmless if already running).
    systemctl enable --now NetworkManager 2>/dev/null || true

    # Wait up to 60 s for it to become active.
    for i in $(seq 1 30); do
        systemctl is-active --quiet NetworkManager && break
        sleep 2
    done

    # Retry a live activation — radio may still be initialising.  Non-fatal:
    # the profile on disk will autoconnect as soon as NM is ready regardless.
    if command -v nmcli &>/dev/null; then
        for attempt in 1 2 3 4 5; do
            nmcli connection reload >/dev/null 2>&1 || true
            if nmcli connection up dismissal-wifi 2>&1 | tee -a "$LOG" \
                | grep -q "successfully activated"; then
                log "WiFi connected on attempt $attempt."
                break
            fi
            log "WiFi activation attempt $attempt not ready, sleeping 5 s…"
            sleep 5
        done
    fi

    # Legacy fallback only if NM isn't present at all.
    if ! command -v nmcli &>/dev/null && command -v wpa_cli &>/dev/null; then
        wpa_passphrase "$WIFI_SSID" "$WIFI_PASS" >> /etc/wpa_supplicant/wpa_supplicant.conf
        wpa_cli -i wlan0 reconfigure || true
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
# Install Firebase service-account JSON (prepare-sdcard.sh staged it on FAT)
# ---------------------------------------------------------------------------
SA_SRC="$BOOT/firebase-scanner-sa.json"
SA_DST="$DISMISSAL_HOME/Backend/firebase-scanner-sa.json"
if [[ -f "$SA_SRC" ]]; then
    log "Installing Firebase service-account JSON…"
    cp "$SA_SRC" "$SA_DST"
    chown dismissal:dismissal "$SA_DST"
    chmod 600 "$SA_DST"
    log "Service-account JSON installed to $SA_DST"
else
    log "WARNING: $SA_SRC not found. Scanner will fail to start without it."
    log "         SCP the JSON to $SA_DST (mode 600, owner dismissal), then:"
    log "         sudo systemctl restart dismissal-scanner"
fi

# ---------------------------------------------------------------------------
# Install SSH public key (prepare-sdcard.sh staged it on the boot partition)
# ---------------------------------------------------------------------------
SSH_KEY_SRC="$BOOT/dismissal-ssh-key.pub"
if [[ -f "$SSH_KEY_SRC" ]]; then
    # Find the primary non-system login user (first UID >= 1000 with a login shell).
    # On a freshly-imaged Bookworm card this is whatever user Pi Imager configured
    # (often 'pi'), OR whatever userconf.txt declared.
    PRIMARY_USER=$(awk -F: '
        $3 >= 1000 && $3 < 65534 && $7 !~ /(nologin|false)$/ { print $1; exit }
    ' /etc/passwd)
    if [[ -n "$PRIMARY_USER" ]]; then
        PRIMARY_HOME=$(getent passwd "$PRIMARY_USER" | cut -d: -f6)
        log "Installing SSH public key for user '$PRIMARY_USER' at $PRIMARY_HOME/.ssh/authorized_keys"
        install -d -m 700 -o "$PRIMARY_USER" -g "$PRIMARY_USER" "$PRIMARY_HOME/.ssh"
        AUTH_KEYS="$PRIMARY_HOME/.ssh/authorized_keys"
        touch "$AUTH_KEYS"
        # Avoid duplicating if somehow already present
        if ! grep -qxFf "$SSH_KEY_SRC" "$AUTH_KEYS" 2>/dev/null; then
            cat "$SSH_KEY_SRC" >> "$AUTH_KEYS"
        fi
        chown "$PRIMARY_USER:$PRIMARY_USER" "$AUTH_KEYS"
        chmod 600 "$AUTH_KEYS"
    else
        log "WARNING: no primary login user found — SSH key not installed."
    fi
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
rm -f "$BOOT/dismissal.env" "$BOOT/dismissal-config.txt" \
      "$BOOT/dismissal-ssh-key.pub" "$BOOT/firebase-scanner-sa.json" || true

# Leave the firstrun script itself but mark completion so it won't re-run.
touch "$DONE_MARKER"

# ---------------------------------------------------------------------------
# Remove our systemd.run hook from cmdline.txt.
#
# Critical: without this, every subsequent boot re-enters
# systemd.unit=kernel-command-line.target, firstrun.sh runs again (exits 0
# immediately thanks to DONE_MARKER), systemd triggers run_success_action=reboot,
# and the Pi infinite-reboot-loops.  The normal multi-user.target never runs,
# so SSH, NetworkManager, and the dismissal-* services never start.
# ---------------------------------------------------------------------------
CMDLINE_FILE="$BOOT/cmdline.txt"
if [[ -f "$CMDLINE_FILE" ]]; then
    log "Cleaning systemd.run hook from cmdline.txt (prevents reboot loop)…"
    # Delete our injected options, leave everything else intact.  cmdline.txt
    # must remain a single line.
    sed -i '
        s| systemd\.run=[^ ]*||g
        s| systemd\.run_success_action=[^ ]*||g
        s| systemd\.run_failure_action=[^ ]*||g
        s| systemd\.unit=kernel-command-line\.target||g
        s|  *$||
    ' "$CMDLINE_FILE"
fi

log "============================================================"
log "  First-boot install COMPLETE."
log "  Services: $(systemctl is-active dismissal-scanner) scanner /"
log "            $(systemctl is-active dismissal-watchdog) watchdog /"
log "            $(systemctl is-active dismissal-health) health"
log "  Health:   curl http://$(hostname -I | awk '{print $1}'):9000/health"
log "  Logs:     journalctl -u dismissal-scanner -f"
log "============================================================"
log "Exiting 0 — systemd.run_success_action=reboot will now reboot."
# DO NOT call `reboot` here.  When the script calls `reboot`, systemd sends
# the script SIGTERM mid-execution, which counts as a non-zero exit, which
# means systemd runs run_failure_action= (default: poweroff) instead of the
# intended run_success_action=reboot.  Returning 0 from the script cleanly
# triggers the success action and the Pi reboots as expected.
exit 0
