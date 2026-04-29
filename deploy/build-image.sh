#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Golden SD-Card Image Builder
# =============================================================================
# Produces a single .img file you can `dd` onto N SD cards in parallel — every
# card boots into the captive-portal "Dismissal-Setup-XXXX" AP on first power-
# on, an installer provisions WiFi from a phone, the device registers itself,
# and an admin assigns it to a District/School from the portal.  No per-card
# WiFi or per-card credentials baked in.
#
# Usage:
#   sudo bash deploy/build-image.sh \
#       --base    ~/Downloads/2024-12-pi-os-lite-arm64.img \
#       --output  ./dismissal-edge-golden.img \
#       --service-account-json ~/secrets/firebase-scanner-sa.json \
#       [--ssh-key  ~/.ssh/id_ed25519.pub] \
#       [--no-bake-install]           # SKIP running install.sh inside the image
#                                     # (faster build, but the resulting cards
#                                     # require WiFi at first boot to clone +
#                                     # install — defeats captive-portal flow).
#                                     # Default: bake install in.
#       [--branch  master] \
#       [--grow-mb 2048]              # grow root partition for headroom
#
# Linux-only.  Pi 5 native (aarch64) host is fastest.  On x86 hosts the
# --bake-install path needs qemu-user-static + binfmt_misc registered.
#
# After the script completes:
#   xz -T0 -9 dismissal-edge-golden.img      # optional: compress for distribution
#   sudo dd if=dismissal-edge-golden.img of=/dev/sdX bs=64M conv=fsync status=progress
#   (or use Raspberry Pi Imager → Use custom image)
# =============================================================================
set -euo pipefail

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
info()  { echo -e "${GREEN}[build-image]${NC} $*"; }
warn()  { echo -e "${YELLOW}[build-image WARN]${NC} $*"; }
error() { echo -e "${RED}[build-image ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BASE_IMG=""
OUTPUT_IMG=""
SA_JSON_FILE=""
SSH_KEY_FILE=""
BRANCH="master"
GROW_MB="2048"
BAKE_INSTALL=1   # default ON — captive-portal flow needs no-internet first boot

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base)                BASE_IMG="$2"; shift 2 ;;
        --output)              OUTPUT_IMG="$2"; shift 2 ;;
        --service-account-json) SA_JSON_FILE="$2"; shift 2 ;;
        --ssh-key)             SSH_KEY_FILE="$2"; shift 2 ;;
        --branch)              BRANCH="$2"; shift 2 ;;
        --grow-mb)             GROW_MB="$2"; shift 2 ;;
        --bake-install)        BAKE_INSTALL=1; shift ;;
        --no-bake-install)     BAKE_INSTALL=0; shift ;;
        --help|-h)
            sed -n '4,40p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) error "Unknown argument: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || error "Run as root: sudo bash $0 …"
[[ -n "$BASE_IMG"   ]] || error "--base /path/to/pi-os-lite.img is required"
[[ -n "$OUTPUT_IMG" ]] || error "--output /path/to/golden.img is required"
[[ -n "$SA_JSON_FILE" ]] || error "--service-account-json is required (Firebase scanner SA)"
[[ -f "$BASE_IMG" ]] || error "Base image not found: $BASE_IMG"
[[ -f "$SA_JSON_FILE" ]] || error "Service-account JSON not found: $SA_JSON_FILE"

if [[ "$(uname)" != "Linux" ]]; then
    error "build-image.sh is Linux-only (needs loop devices + losetup)."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ---------------------------------------------------------------------------
# Copy base → output, then grow the root partition for headroom.
# ---------------------------------------------------------------------------
info "Copying base image → $OUTPUT_IMG"
cp --reflink=auto -f "$BASE_IMG" "$OUTPUT_IMG"
sync

if (( GROW_MB > 0 )); then
    info "Growing image by ${GROW_MB} MB to make room for apt install + venv…"
    truncate -s "+${GROW_MB}M" "$OUTPUT_IMG"
fi

# ---------------------------------------------------------------------------
# Loop-mount, expand the root partition over the new space, fsck.
# ---------------------------------------------------------------------------
LOOP="$(losetup --find --partscan --show "$OUTPUT_IMG")"
trap 'losetup -d "$LOOP" 2>/dev/null || true' EXIT
info "Loop device: $LOOP"

# Pi OS partition layout: ${LOOP}p1 = vfat (boot), ${LOOP}p2 = ext4 (root).
BOOT_PART="${LOOP}p1"
ROOT_PART="${LOOP}p2"
[[ -b "$BOOT_PART" ]] || error "Boot partition not found: $BOOT_PART"
[[ -b "$ROOT_PART" ]] || error "Root partition not found: $ROOT_PART"

if (( GROW_MB > 0 )); then
    info "Resizing partition table to consume the new space…"
    parted -s "$LOOP" resizepart 2 100% || warn "parted resizepart failed — continuing"
    e2fsck -f -y "$ROOT_PART" >/dev/null 2>&1 || true
    resize2fs "$ROOT_PART" >/dev/null
fi

BOOT_MNT="$(mktemp -d /tmp/dismissal-boot.XXXXXX)"
ROOT_MNT="$(mktemp -d /tmp/dismissal-root.XXXXXX)"
trap '
    set +e
    for m in "$ROOT_MNT/dev/pts" "$ROOT_MNT/dev" "$ROOT_MNT/proc" "$ROOT_MNT/sys" \
             "$ROOT_MNT/run" "$ROOT_MNT/boot/firmware" "$ROOT_MNT/boot" "$ROOT_MNT" \
             "$BOOT_MNT"; do
        umount "$m" 2>/dev/null
    done
    losetup -d "$LOOP" 2>/dev/null
    rm -rf "$BOOT_MNT" "$ROOT_MNT"
' EXIT

mount -t vfat "$BOOT_PART" "$BOOT_MNT"
mount -t ext4 "$ROOT_PART" "$ROOT_MNT"

# Verify it really is a Pi OS image.
[[ -f "$BOOT_MNT/cmdline.txt" ]] || error "cmdline.txt missing — not a Pi OS image?"
[[ -f "$BOOT_MNT/config.txt"  ]] || error "config.txt missing — not a Pi OS image?"

# ---------------------------------------------------------------------------
# Stage firstrun + per-card config on the boot (FAT32) partition.
# All fields here are deliberately generic — no per-card WiFi or
# location.  The captive portal fills in WiFi at install time, and the
# admin assigns location via the portal.
# ---------------------------------------------------------------------------
info "Staging firstrun + config on boot partition…"
cp "$SCRIPT_DIR/firstrun.sh" "$BOOT_MNT/dismissal-firstrun.sh"
chmod +x "$BOOT_MNT/dismissal-firstrun.sh" || true

cat > "$BOOT_MNT/dismissal-config.txt" <<EOF
# Generic config used by every card flashed from this golden image.
# A unique hostname is generated by firstrun.sh on the Pi itself, so
# every card gets its own identity (Dismissal-Edge-XXXXXXXX) without
# any per-card prep.  WiFi is left blank on purpose — captive portal.
DISMISSAL_BRANCH=${BRANCH}
DISMISSAL_HOSTNAME=
WIFI_SSID=
WIFI_PASS=
EOF

# Firebase service-account is shared across all devices — per-device
# identity comes from CPU serial + hostname, not the SA itself.
info "Copying Firebase service-account JSON onto boot partition…"
cp "$SA_JSON_FILE" "$BOOT_MNT/firebase-scanner-sa.json"
chmod 600 "$BOOT_MNT/firebase-scanner-sa.json" 2>/dev/null || true

if [[ -n "$SSH_KEY_FILE" ]]; then
    [[ -f "$SSH_KEY_FILE" ]] || error "SSH key not found: $SSH_KEY_FILE"
    info "Staging SSH public key…"
    cp "$SSH_KEY_FILE" "$BOOT_MNT/dismissal-ssh-key.pub"
fi

# Pi OS convention: a file named `ssh` enables sshd on first boot.
touch "$BOOT_MNT/ssh"

# Activate the firstrun hook in cmdline.txt.
CMDLINE="$BOOT_MNT/cmdline.txt"
if grep -q "dismissal-firstrun.sh" "$CMDLINE"; then
    info "firstrun hook already in cmdline.txt — leaving alone."
else
    info "Wiring firstrun hook into cmdline.txt…"
    CMDLINE_ORIG="$(tr -d '\n' < "$CMDLINE")"
    CMDLINE_NEW="${CMDLINE_ORIG% } systemd.run=/boot/firmware/dismissal-firstrun.sh systemd.run_success_action=reboot systemd.run_failure_action=reboot systemd.unit=kernel-command-line.target"
    echo "$CMDLINE_NEW" > "$CMDLINE"
fi

# ---------------------------------------------------------------------------
# userconf.txt — left untouched.  The base image you produced via Raspberry
# Pi Imager should already have userconf.txt set (Imager → Advanced options
# → Set username + password).  We deliberately don't generate one here
# because hardcoding a known password into 50 SD cards is a bad idea.
# ---------------------------------------------------------------------------
if [[ ! -f "$BOOT_MNT/userconf.txt" ]]; then
    warn "Base image has no userconf.txt — flashed cards will boot without"
    warn "a default user.  Re-flash your base via Pi Imager → Advanced"
    warn "Options → 'Set username and password' so SSH works post-deploy."
fi

# ---------------------------------------------------------------------------
# Optional: --bake-install runs install.sh inside the image so the resulting
# .img boots fully offline.  Requires either:
#   * aarch64 host (native, fast)
#   * x86 host with qemu-user-static + binfmt_misc registered (slow)
# ---------------------------------------------------------------------------
if (( BAKE_INSTALL )); then
    info "Bake-install: running deploy/install.sh inside the image…"

    HOST_ARCH="$(uname -m)"
    if [[ "$HOST_ARCH" != "aarch64" ]]; then
        if ! command -v qemu-aarch64-static >/dev/null 2>&1; then
            error "Cross-arch bake needs qemu-user-static.  Install it:
  apt-get install -y qemu-user-static binfmt-support
…or run this script on a Pi 5 (aarch64) host."
        fi
        info "Cross-arch bake — installing qemu-aarch64-static into chroot…"
        cp "$(command -v qemu-aarch64-static)" "$ROOT_MNT/usr/bin/"
        # binfmt-support handles the registration on the host; nothing to do
        # in the chroot beyond placing the binary.
    fi

    # Bind-mount the kernel interfaces the chroot needs.
    mount --bind /dev      "$ROOT_MNT/dev"
    mount --bind /dev/pts  "$ROOT_MNT/dev/pts"
    mount -t proc proc     "$ROOT_MNT/proc"
    mount -t sysfs sysfs   "$ROOT_MNT/sys"
    mount -t tmpfs tmpfs   "$ROOT_MNT/run"
    # /boot/firmware in the chroot must point at the FAT partition so
    # install.sh's append_once on /boot/firmware/config.txt actually lands.
    mkdir -p "$ROOT_MNT/boot/firmware"
    mount --bind "$BOOT_MNT" "$ROOT_MNT/boot/firmware"

    # Stage our repo into /opt/dismissal so install.sh has its files.
    info "Pre-staging repo to /opt/dismissal in image…"
    mkdir -p "$ROOT_MNT/opt/dismissal"
    rsync -a --delete --exclude '.git' --exclude 'node_modules' \
        --exclude 'Frontend' --exclude 'functions' --exclude 'dist' \
        "$REPO_ROOT/" "$ROOT_MNT/opt/dismissal/"

    # Run install.sh inside the chroot.
    info "Running install.sh inside chroot (this takes 10–20 min)…"
    chroot "$ROOT_MNT" /bin/bash -c "
        set -e
        export DEBIAN_FRONTEND=noninteractive
        bash /opt/dismissal/deploy/install.sh
        mkdir -p /var/lib/dismissal
        touch /var/lib/dismissal/.install-complete
    "

    info "install.sh complete inside image."
fi

# ---------------------------------------------------------------------------
# Sync + unmount, leave the loop teardown to the EXIT trap.
# ---------------------------------------------------------------------------
sync
info "Image build complete: $OUTPUT_IMG"
echo ""
echo "Next steps:"
echo "  Optional: compress for distribution"
echo "    xz -T0 -9 \"$OUTPUT_IMG\""
echo ""
echo "  Flash to a card:"
echo "    sudo dd if=\"$OUTPUT_IMG\" of=/dev/sdX bs=64M conv=fsync status=progress"
echo "  …or open Raspberry Pi Imager → 'Use custom image' → \"$OUTPUT_IMG\""
echo ""
echo "  On first boot each card auto-generates a unique hostname"
echo "  (Dismissal-Edge-XXXXXXXX), broadcasts its captive-portal AP if no"
echo "  WiFi is configured, and registers with the cloud once provisioned."
