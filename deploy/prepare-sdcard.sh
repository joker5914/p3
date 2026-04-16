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
#   --env     FILE  Path to your filled-in dismissal.env with credentials
#                   Defaults to Backend/.env if it exists, else Backend/.env.example
#   --branch  NAME  Git branch to deploy (default: master)
#   --wifi-ssid  S  WiFi SSID  (optional — skip if you used Pi Imager advanced options)
#   --wifi-pass  P  WiFi password
#   --help          Show this help
#
# Workflow:
#   1. Flash Pi OS Lite 64-bit with Raspberry Pi Imager.
#      In Imager's "Advanced options" set hostname, SSH public key, and WiFi.
#      (Or provide --wifi-ssid / --wifi-pass here to let firstrun.sh do it.)
#   2. Leave SD card in the card reader.
#   3. Run: sudo bash deploy/prepare-sdcard.sh --env /path/to/dismissal.env
#   4. Eject the SD card, insert into Pi 5, apply power.
#   5. Wait ~15 minutes for automatic installation to complete.
#      The green activity LED will stop flashing when done (then the Pi reboots).
#   6. Check with: ssh dismissal-scanner-01.local  OR  curl http://<pi-ip>:9000/health
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
        --help|-h)
            sed -n '4,50p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) error "Unknown argument: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || error "Run as root: sudo bash $0"

# ---------------------------------------------------------------------------
# Resolve env file
# ---------------------------------------------------------------------------
if [[ -z "$ENV_FILE" ]]; then
    if [[ -f "$REPO_ROOT/Backend/.env" ]]; then
        ENV_FILE="$REPO_ROOT/Backend/.env"
        info "Using existing Backend/.env"
    else
        ENV_FILE="$REPO_ROOT/Backend/.env.example"
        warn "No Backend/.env found — using .env.example (fill in REPLACE_ME values first!)"
    fi
fi
[[ -f "$ENV_FILE" ]] || error "Env file not found: $ENV_FILE"

# Warn if credentials look unfilled
if grep -q "REPLACE_ME" "$ENV_FILE"; then
    warn "========================================================"
    warn "  $ENV_FILE still contains REPLACE_ME placeholders."
    warn "  The scanner will NOT start until you fill these in."
    warn "  You can edit /boot/firmware/dismissal.env on the SD"
    warn "  card to update credentials before first boot."
    warn "========================================================"
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
# Copy credentials
# ---------------------------------------------------------------------------
info "Copying credentials to boot partition…"
cp "$ENV_FILE" "$MOUNT_POINT/dismissal.env"
chmod 600 "$MOUNT_POINT/dismissal.env" 2>/dev/null || true  # best-effort (FAT)

# ---------------------------------------------------------------------------
# Copy firstrun installer
# ---------------------------------------------------------------------------
info "Copying firstrun installer…"
cp "$SCRIPT_DIR/firstrun.sh" "$MOUNT_POINT/dismissal-firstrun.sh"
chmod +x "$MOUNT_POINT/dismissal-firstrun.sh" 2>/dev/null || true

# Write the injected branch so firstrun.sh knows which branch to clone
cat > "$MOUNT_POINT/dismissal-config.txt" << EOF
DISMISSAL_BRANCH=${BRANCH}
WIFI_SSID=${WIFI_SSID}
WIFI_PASS=${WIFI_PASS}
EOF

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
info "  Credentials : $ENV_FILE  →  /boot/firmware/dismissal.env"
info "  Branch      : $BRANCH"
info "  Firstrun    : /boot/firmware/dismissal-firstrun.sh"
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
