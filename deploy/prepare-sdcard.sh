#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — SD Card Preparation Script
# =============================================================================
# Run this on your laptop/desktop AFTER flashing Pi OS Lite 64-bit with
# Raspberry Pi Imager.  It injects credentials and an automated installer
# into the boot partition so the Pi sets itself up on first power-on with
# NO SSH or manual steps required.
#
# Requirements (laptop side):
#   - Linux, macOS, or WSL2
#   - sudo access
#   - The SD card inserted (do NOT mount it manually first)
#
# Usage:
#   sudo bash deploy/prepare-sdcard.sh [OPTIONS]
#
# Options:
#   --device  DEV   Block device of the SD card  (e.g. /dev/sdb, /dev/mmcblk0)
#                   Omit to auto-detect (only safe when one removable disk present)
#   --env     FILE  Optional: path to a .env with tuning overrides.
#                   For a standard deploy you do NOT need one — the scanner
#                   reads its backend URL and Firebase Web API key from
#                   Backend/scanner_config.py in the cloned repo.
#   --location NAME Optional human-readable location label for this unit.
#                   If omitted, the scanner registers under its hostname and
#                   you can set / rename the location later from the
#                   Devices page of the Dismissal Admin Portal.
#   --branch  NAME  Git branch to deploy (default: master)
#   --wifi-ssid  S  WiFi SSID  (optional — skip if you used Pi Imager advanced options)
#   --wifi-pass  P  WiFi password
#   --ssh-key    F  SSH public key file to authorise for the pi user
#                   Defaults to ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub if present
#                   Pass an empty string ('') to skip.
#   --hostname   H  Hostname for this scanner unit.  Default is a freshly
#                   generated Dismissal-Edge-<8 alphanumeric chars> value.
#   --service-account-json FILE
#                   Firebase service-account JSON for this scanner.  Installed
#                   to /opt/dismissal/Backend/firebase-scanner-sa.json on the Pi
#                   (mode 600, owned by the dismissal user).
#   --help          Show this help
#
# Workflow:
#   1. Flash Pi OS Lite 64-bit with Raspberry Pi Imager.
#      In Imager's "Advanced options" set the hostname and the default user
#      (username + password).  SSH and key injection are handled by THIS
#      script — you don't need to configure them in Imager.
#   2. Leave SD card in the card reader.
#   3. Run: sudo bash deploy/prepare-sdcard.sh --env /path/to/dismissal.env
#   4. Eject the SD card, insert into Pi 5, apply power.
#   5. Wait ~15 minutes for automatic installation to complete.
#      The green activity LED will stop flashing when done (then the Pi reboots).
#   6. Check with: ssh pi@dismissal-scanner-01.local
#                  curl http://<pi-ip>:9000/health
#
# Security note:
#   dismissal.env is copied to the FAT32 boot partition during prep and
#   deleted from it after first-boot install completes.  The final .env
#   lives at /opt/dismissal/Backend/.env (mode 600, owned by dismissal).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEVICE=""
ENV_FILE=""
BRANCH="master"
WIFI_SSID=""
WIFI_PASS=""
SSH_KEY_FILE="__AUTO__"   # sentinel: resolve after we know SUDO_USER's $HOME
HOSTNAME_OVERRIDE=""
SA_JSON_FILE=""
LOCATION=""

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
info()  { echo -e "${GREEN}[prepare-sdcard]${NC} $*"; }
warn()  { echo -e "${YELLOW}[prepare-sdcard WARN]${NC} $*"; }
error() { echo -e "${RED}[prepare-sdcard ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --device)  DEVICE="$2";     shift 2 ;;
        --env)     ENV_FILE="$2";   shift 2 ;;
        --branch)  BRANCH="$2";     shift 2 ;;
        --wifi-ssid) WIFI_SSID="$2"; shift 2 ;;
        --wifi-pass) WIFI_PASS="$2"; shift 2 ;;
        --ssh-key)   SSH_KEY_FILE="$2"; shift 2 ;;
        --hostname)  HOSTNAME_OVERRIDE="$2"; shift 2 ;;
        --service-account-json) SA_JSON_FILE="$2"; shift 2 ;;
        --location)  LOCATION="$2"; shift 2 ;;
        --help|-h)
            sed -n '4,50p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) error "Unknown argument: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || error "Run as root: sudo bash $0"

# ---------------------------------------------------------------------------
# Resolve env file (OPTIONAL — only needed for tuning overrides)
# ---------------------------------------------------------------------------
# Under the simplified flow the scanner reads backend URL + Firebase Web API
# key from Backend/scanner_config.py (committed, public).  A per-device .env
# is only needed when you want to override tuning values (FPS, plate length,
# etc.)  If --location was supplied but no --env, we synthesise a minimal one.
if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || error "Env file not found: $ENV_FILE"
    if grep -q "REPLACE_ME" "$ENV_FILE"; then
        warn "$ENV_FILE still contains REPLACE_ME placeholders — review it."
    fi
fi

# ---------------------------------------------------------------------------
# Resolve SSH public key
# ---------------------------------------------------------------------------
# We want the Pi to be SSH-reachable on first boot with the operator's key
# already installed.  Two-step approach:
#   1. Touch /boot/firmware/ssh   → enables sshd on first boot (Pi OS convention)
#   2. Copy pubkey to /boot/firmware/dismissal-ssh-key.pub  → firstrun.sh
#      installs it into the default user's ~/.ssh/authorized_keys
#
# Resolve the invoking user's $HOME even when running under `sudo`.
INVOKING_HOME=""
if [[ -n "${SUDO_USER:-}" ]] && [[ "$SUDO_USER" != "root" ]]; then
    INVOKING_HOME=$(eval echo "~$SUDO_USER")
elif [[ -n "${HOME:-}" ]] && [[ "$HOME" != "/root" ]]; then
    INVOKING_HOME="$HOME"
fi

if [[ "$SSH_KEY_FILE" == "__AUTO__" ]]; then
    SSH_KEY_FILE=""
    if [[ -n "$INVOKING_HOME" ]]; then
        for candidate in "$INVOKING_HOME/.ssh/id_ed25519.pub" \
                         "$INVOKING_HOME/.ssh/id_rsa.pub"; do
            if [[ -f "$candidate" ]]; then
                SSH_KEY_FILE="$candidate"
                info "Auto-detected SSH public key: $SSH_KEY_FILE"
                break
            fi
        done
    fi
fi

if [[ -n "$SSH_KEY_FILE" ]]; then
    [[ -f "$SSH_KEY_FILE" ]] || error "SSH key file not found: $SSH_KEY_FILE"
    # Sanity check: file should start with ssh- (ssh-ed25519, ssh-rsa, etc.)
    if ! head -c 4 "$SSH_KEY_FILE" | grep -q '^ssh-'; then
        error "$SSH_KEY_FILE does not look like an OpenSSH public key."
    fi
else
    warn "========================================================"
    warn "  No SSH public key will be installed."
    warn "  You will need to configure SSH access some other way"
    warn "  (e.g. Pi Imager advanced options) before you can"
    warn "  ssh into the Pi."
    warn "========================================================"
fi

# ---------------------------------------------------------------------------
# Resolve hostname
# ---------------------------------------------------------------------------
# Format: Dismissal-Edge-<8 lowercase alphanumeric>.
# 36^8 ≈ 2.8 × 10^12 combos; birthday collision prob for 1,000 devices ≈ 1e-7.
# Validate user-supplied overrides against DNS label rules (RFC 1123 + length).
gen_hostname_suffix() {
    # Prefer openssl (cryptographic); fall back to /dev/urandom; lowercase output.
    local raw
    if command -v openssl >/dev/null 2>&1; then
        raw=$(openssl rand -hex 4)      # 8 lowercase hex chars
    else
        raw=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 8 || true)
    fi
    echo "$raw"
}

if [[ -n "$HOSTNAME_OVERRIDE" ]]; then
    SCANNER_HOSTNAME="$HOSTNAME_OVERRIDE"
else
    SCANNER_HOSTNAME="Dismissal-Edge-$(gen_hostname_suffix)"
fi

# Validate (DNS label: 1-63 chars, letters/digits/hyphen, no leading/trailing hyphen).
if ! [[ "$SCANNER_HOSTNAME" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]] \
    || [[ "$SCANNER_HOSTNAME" == *- ]]; then
    error "Invalid hostname '$SCANNER_HOSTNAME' — must be 1–63 chars, letters/digits/hyphens only, no leading/trailing hyphen."
fi

# ---------------------------------------------------------------------------
# Validate service-account JSON (if supplied)
# ---------------------------------------------------------------------------
if [[ -n "$SA_JSON_FILE" ]]; then
    [[ -f "$SA_JSON_FILE" ]] || error "Service-account JSON not found: $SA_JSON_FILE"
    # Cheap schema check: Firebase/GCP service-account keys always have these fields.
    if ! grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$SA_JSON_FILE" \
        || ! grep -q '"private_key"' "$SA_JSON_FILE" \
        || ! grep -q '"client_email"' "$SA_JSON_FILE"; then
        error "$SA_JSON_FILE does not look like a Firebase/GCP service-account key."
    fi
else
    warn "No --service-account-json supplied — scanner will fail to start until"
    warn "you copy a key to /opt/dismissal/Backend/firebase-scanner-sa.json."
fi

# ---------------------------------------------------------------------------
# Detect SD card device
# ---------------------------------------------------------------------------
detect_device() {
    # Look for removable block devices (SD card readers appear as removable)
    local devs=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && devs+=("$line")
    done < <(lsblk -dno NAME,RM,TYPE | awk '$2=="1" && $3=="disk" {print "/dev/"$1}')

    if [[ ${#devs[@]} -eq 0 ]]; then
        # macOS fallback
        if [[ "$(uname)" == "Darwin" ]]; then
            while IFS= read -r line; do
                [[ -n "$line" ]] && devs+=("$line")
            done < <(diskutil list | awk '/external, physical/ {print $1}' | grep -v '^$')
        fi
    fi

    if [[ ${#devs[@]} -eq 1 ]]; then
        echo "${devs[0]}"
    elif [[ ${#devs[@]} -gt 1 ]]; then
        warn "Multiple removable devices found: ${devs[*]}"
        warn "Specify one explicitly with --device"
        exit 1
    else
        error "No removable block device found. Is the SD card inserted? Use --device to specify manually."
    fi
}

if [[ -z "$DEVICE" ]]; then
    DEVICE="$(detect_device)"
    info "Auto-detected device: $DEVICE"
fi

# Sanity check: is this actually a block device?
[[ -b "$DEVICE" ]] || error "$DEVICE is not a block device"

# Refuse to wipe a mounted system disk
if mount | grep -q "^${DEVICE}"; then
    error "$DEVICE appears to be mounted as a system disk. Refusing to proceed."
fi

# ---------------------------------------------------------------------------
# Find and mount the boot (FAT32) partition
# ---------------------------------------------------------------------------
# Pi OS: partition 1 is FAT32 boot, partition 2 is ext4 root
BOOT_PART="${DEVICE}1"
# Handle mmcblk-style names: /dev/mmcblk0 → /dev/mmcblk0p1
if [[ "$DEVICE" =~ mmcblk|loop|nvme ]]; then
    BOOT_PART="${DEVICE}p1"
fi
# macOS disk style: /dev/disk4 → /dev/disk4s1
if [[ "$(uname)" == "Darwin" ]]; then
    BOOT_PART="${DEVICE}s1"
fi

[[ -b "$BOOT_PART" ]] || error "Boot partition not found: $BOOT_PART"

MOUNT_POINT="$(mktemp -d /tmp/dismissal-boot.XXXXXX)"
info "Mounting $BOOT_PART → $MOUNT_POINT"
if [[ "$(uname)" == "Darwin" ]]; then
    mount -t msdos "$BOOT_PART" "$MOUNT_POINT"
else
    mount -t vfat "$BOOT_PART" "$MOUNT_POINT"
fi
trap 'sync; umount "$MOUNT_POINT" 2>/dev/null || true; rmdir "$MOUNT_POINT" 2>/dev/null || true' EXIT

# Verify this looks like a Pi boot partition
[[ -f "$MOUNT_POINT/cmdline.txt" ]] || error "cmdline.txt not found — is this a Pi OS SD card?"
[[ -f "$MOUNT_POINT/config.txt"  ]] || error "config.txt not found  — is this a Pi OS SD card?"

# ---------------------------------------------------------------------------
# Enable SSH on first boot
# ---------------------------------------------------------------------------
# Pi OS convention: if a file named `ssh` (or `ssh.txt`) exists on the boot
# partition at first boot, sshd is enabled and the file is deleted.
info "Enabling SSH on first boot…"
touch "$MOUNT_POINT/ssh"

# ---------------------------------------------------------------------------
# Copy SSH public key (firstrun.sh will install it into authorized_keys)
# ---------------------------------------------------------------------------
if [[ -n "$SSH_KEY_FILE" ]]; then
    info "Copying SSH public key to boot partition…"
    cp "$SSH_KEY_FILE" "$MOUNT_POINT/dismissal-ssh-key.pub"
fi

# ---------------------------------------------------------------------------
# Stage .env — only when the operator supplied one OR set --location.
# If neither is given, the scanner boots with no .env and reads everything
# from scanner_config.py, using the hostname as a fallback location.
# ---------------------------------------------------------------------------
STAGED_ENV="$MOUNT_POINT/dismissal.env"
if [[ -n "$ENV_FILE" ]]; then
    info "Copying env overrides from $ENV_FILE…"
    cp "$ENV_FILE" "$STAGED_ENV"
fi
if [[ -n "$LOCATION" ]]; then
    info "Writing SCANNER_LOCATION=$LOCATION to dismissal.env"
    # Append or create — duplicate keys are fine; python-dotenv takes the last one.
    echo "SCANNER_LOCATION=$LOCATION" >> "$STAGED_ENV"
fi
if [[ -f "$STAGED_ENV" ]]; then
    chmod 600 "$STAGED_ENV" 2>/dev/null || true   # best-effort (FAT)
fi

# ---------------------------------------------------------------------------
# Copy firstrun installer
# ---------------------------------------------------------------------------
info "Copying firstrun installer…"
cp "$SCRIPT_DIR/firstrun.sh" "$MOUNT_POINT/dismissal-firstrun.sh"
chmod +x "$MOUNT_POINT/dismissal-firstrun.sh" 2>/dev/null || true

# Per-device config consumed by firstrun.sh.  Key=value; values are not quoted
# because firstrun.sh sources this file directly.  Keep values shell-safe.
cat > "$MOUNT_POINT/dismissal-config.txt" << EOF
DISMISSAL_BRANCH=${BRANCH}
DISMISSAL_HOSTNAME=${SCANNER_HOSTNAME}
WIFI_SSID=${WIFI_SSID}
WIFI_PASS=${WIFI_PASS}
EOF

# ---------------------------------------------------------------------------
# Copy Firebase service-account JSON (if supplied)
# ---------------------------------------------------------------------------
if [[ -n "$SA_JSON_FILE" ]]; then
    info "Copying Firebase service-account JSON to boot partition…"
    cp "$SA_JSON_FILE" "$MOUNT_POINT/firebase-scanner-sa.json"
    chmod 600 "$MOUNT_POINT/firebase-scanner-sa.json" 2>/dev/null || true  # FAT best-effort
fi

# ---------------------------------------------------------------------------
# Activate firstrun via cmdline.txt
# ---------------------------------------------------------------------------
CMDLINE="$MOUNT_POINT/cmdline.txt"
CMDLINE_ORIG="$(cat "$CMDLINE")"

if grep -q "dismissal-firstrun.sh" "$CMDLINE"; then
    info "firstrun already configured in cmdline.txt — skipping."
else
    info "Activating firstrun in cmdline.txt…"
    # Pi OS firstrun hook: add to the single-line cmdline
    # Remove trailing newline, append our hook
    CMDLINE_NEW="${CMDLINE_ORIG% } systemd.run=/boot/firmware/dismissal-firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target"
    # Write back as a single line (cmdline.txt must be one line)
    echo "$CMDLINE_NEW" > "$CMDLINE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
sync
info ""
info "============================================================"
info "  SD card prepared successfully!"
info "============================================================"
info ""
info "  Hostname    : $SCANNER_HOSTNAME        (ssh pi@${SCANNER_HOSTNAME}.local after boot)"
if [[ -f "$STAGED_ENV" ]]; then
    info "  .env        : staged${ENV_FILE:+ from $ENV_FILE}${LOCATION:+  (location=$LOCATION)}"
else
    info "  .env        : (none — scanner uses committed config + hostname location)"
fi
info "  Branch      : $BRANCH"
info "  Firstrun    : /boot/firmware/dismissal-firstrun.sh"
info "  SSH         : enabled on first boot"
if [[ -n "$SSH_KEY_FILE" ]]; then
    info "  SSH key     : $SSH_KEY_FILE  →  authorized_keys (installed by firstrun)"
else
    info "  SSH key     : (none — configure via Pi Imager or add after boot)"
fi
if [[ -n "$SA_JSON_FILE" ]]; then
    info "  Firebase SA : $SA_JSON_FILE  →  /opt/dismissal/Backend/firebase-scanner-sa.json"
else
    info "  Firebase SA : (none — copy manually before scanner will start)"
fi
info ""
info "  LABEL THIS SD CARD / UNIT:  $SCANNER_HOSTNAME"
info ""
info "  Next steps:"
info "  1. Safely eject the SD card:  sudo eject $DEVICE"
info "  2. Insert into the Pi 5 and apply power."
info "  3. Wait ~15 min for automated install + reboot."
info "  4. Verify: curl http://<pi-ip>:9000/health"
info ""
warn "  If you used --env .env.example, SSH in after boot and"
warn "  update /opt/dismissal/Backend/.env with real credentials,"
warn "  then: sudo systemctl restart dismissal-scanner"
info ""
