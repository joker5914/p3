#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Raspberry Pi 5 Field Deployment Script
# =============================================================================
# Tested on: Raspberry Pi OS Lite 64-bit (Bookworm) on Raspberry Pi 5
# Hardware:  Arducam 16MP IMX519 (CSI), Google Coral USB Accelerator
#
# Run as root on a fresh image:
#   curl -sSL https://raw.githubusercontent.com/joker5914/Dismissal/master/deploy/install.sh | sudo bash
#
# Or clone the repo first:
#   sudo bash deploy/install.sh
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config — override with environment variables before running
# ---------------------------------------------------------------------------
DISMISSAL_USER="dismissal"
DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_REPO="https://github.com/joker5914/Dismissal.git"
DISMISSAL_BRANCH="master"
SERVICES=("dismissal-scanner" "dismissal-watchdog" "dismissal-health")

# Default plate detection model (Coral SSD-MobileNet-v2 COCO, official Coral release)
MODEL_DIR="$DISMISSAL_HOME/models"
MODEL_FILE="plate_detector_edgetpu.tflite"
MODEL_URL="https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
info()  { echo -e "${GREEN}[Dismissal]${NC} $*"; }
warn()  { echo -e "${YELLOW}[Dismissal WARN]${NC} $*"; }
error() { echo -e "${RED}[Dismissal ERROR]${NC} $*" >&2; exit 1; }

append_once() {
    # append_once FILE LINE — add LINE to FILE only if not already present
    local file="$1" line="$2"
    grep -qxF "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
}

require_root() {
    [[ $EUID -eq 0 ]] || error "Run as root: sudo bash $0"
}

# ---------------------------------------------------------------------------
# 1. System update and base package dependencies
# ---------------------------------------------------------------------------
install_system_deps() {
    info "Updating package lists…"
    apt-get update -qq

    info "Installing system dependencies…"
    apt-get install -y --no-install-recommends \
        git \
        python3 \
        python3-pip \
        python3-venv \
        python3-dev \
        build-essential \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libgl1 \
        tesseract-ocr \
        tesseract-ocr-eng \
        libjpeg-dev \
        libtiff-dev \
        libavcodec-dev \
        libavformat-dev \
        libswscale-dev \
        v4l-utils \
        curl \
        wget \
        logrotate \
        sudo \
        network-manager \
        modemmanager \
        libqmi-utils \
        libmbim-utils

    # -----------------------------------------------------------------------
    # Picamera2 — MUST come from apt on Pi OS.  Not available on PyPI; the apt
    # package ships the compiled libcamera binding that pip cannot provide.
    # python3-kms++ is required by Picamera2 for display-less (headless) init.
    # -----------------------------------------------------------------------
    info "Installing Picamera2 and libcamera Python bindings…"
    apt-get install -y --no-install-recommends \
        python3-picamera2 \
        python3-libcamera \
        python3-kms++ \
        libcamera-tools

    info "System packages installed."
}

# ---------------------------------------------------------------------------
# 2. Google Coral Edge TPU runtime and PyCoral
# ---------------------------------------------------------------------------
install_coral() {
    info "Installing Google Coral Edge TPU runtime…"

    # Add Coral apt repository (idempotent)
    local coral_list="/etc/apt/sources.list.d/coral-edgetpu.list"
    if [[ ! -f "$coral_list" ]]; then
        echo "deb https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
            > "$coral_list"
        curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
            | gpg --dearmor -o /etc/apt/trusted.gpg.d/coral-edgetpu.gpg
        apt-get update -qq
    else
        info "Coral apt repo already configured — skipping."
    fi

    # libedgetpu1-std ships the udev rules that allow non-root USB access.
    # Use libedgetpu1-max for maximum clock speed (runs hotter).
    apt-get install -y --no-install-recommends libedgetpu1-std python3-pycoral

    info "Coral TPU runtime installed."
}

# ---------------------------------------------------------------------------
# 3. Create dedicated low-privilege system user
# ---------------------------------------------------------------------------
create_user() {
    if id "$DISMISSAL_USER" &>/dev/null; then
        info "User '$DISMISSAL_USER' already exists — skipping."
    else
        info "Creating system user '$DISMISSAL_USER'…"
        useradd \
            --system \
            --shell /usr/sbin/nologin \
            --home-dir "$DISMISSAL_HOME" \
            --create-home \
            "$DISMISSAL_USER"
    fi

    # video  — access /dev/video* (CSI camera via v4l2 or libcamera)
    # gpio   — GPIO pins if needed later
    # plugdev — password-less access to Coral USB Accelerator (udev rule)
    usermod -aG video,gpio,plugdev "$DISMISSAL_USER" 2>/dev/null || true
    info "User '$DISMISSAL_USER' configured (groups: video, gpio, plugdev)."
}

# ---------------------------------------------------------------------------
# 4. Clone or update the repository
# ---------------------------------------------------------------------------
setup_repo() {
    if [[ -d "$DISMISSAL_HOME/.git" ]]; then
        info "Repository already present — pulling latest $DISMISSAL_BRANCH…"
        sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" fetch origin
        sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" \
            reset --hard "origin/$DISMISSAL_BRANCH"
    else
        info "Cloning Dismissal repository…"
        tmpdir=$(mktemp -d)
        git clone --depth 1 --branch "$DISMISSAL_BRANCH" "$DISMISSAL_REPO" \
            "$tmpdir/dismissal"
        rsync -a "$tmpdir/dismissal/" "$DISMISSAL_HOME/"
        rm -rf "$tmpdir"
        chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME"
    fi
    info "Repository ready at $DISMISSAL_HOME."
}

# ---------------------------------------------------------------------------
# 5. Python virtual environment + scanner dependencies
#
# --system-site-packages is required so that picamera2 and pycoral (both
# installed system-wide via apt) are visible inside the venv.
# ---------------------------------------------------------------------------
setup_venv() {
    info "Creating Python virtual environment (--system-site-packages)…"
    sudo -u "$DISMISSAL_USER" python3 -m venv \
        --system-site-packages \
        "$DISMISSAL_HOME/venv"

    info "Installing Python scanner dependencies…"
    sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" \
        install --upgrade pip --quiet
    sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" \
        install --quiet \
        -r "$DISMISSAL_HOME/Backend/requirements-scanner.txt"

    info "Python environment ready."
}

# ---------------------------------------------------------------------------
# 6. Environment file
# Skipped when SKIP_ENV_SETUP=1 (set by firstrun.sh which handles .env itself)
# ---------------------------------------------------------------------------
setup_env() {
    [[ "${SKIP_ENV_SETUP:-0}" == "1" ]] && return
    local env_file="$DISMISSAL_HOME/Backend/.env"
    if [[ -f "$env_file" ]]; then
        warn ".env already exists — not overwriting. Review it manually."
    else
        info "Creating .env from template…"
        cp "$DISMISSAL_HOME/Backend/.env.example" "$env_file"
        chown "$DISMISSAL_USER:$DISMISSAL_USER" "$env_file"
        chmod 600 "$env_file"
        warn "ACTION REQUIRED: Edit $env_file and fill in all REPLACE_ME values."
    fi
}

# ---------------------------------------------------------------------------
# 7. Runtime directories
# ---------------------------------------------------------------------------
setup_dirs() {
    info "Creating runtime directories…"
    mkdir -p \
        "$DISMISSAL_HOME/Backend/debug_frames" \
        "$DISMISSAL_HOME/Backend/logs" \
        "$MODEL_DIR"
    chown -R "$DISMISSAL_USER:$DISMISSAL_USER" \
        "$DISMISSAL_HOME/Backend/debug_frames" \
        "$DISMISSAL_HOME/Backend/logs" \
        "$MODEL_DIR"
    # /var/lib/dismissal is created by systemd StateDirectory= but pre-create
    # it here so it exists before first service start.
    mkdir -p /var/lib/dismissal
    chown "$DISMISSAL_USER:$DISMISSAL_USER" /var/lib/dismissal
    chmod 750 /var/lib/dismissal
}

# ---------------------------------------------------------------------------
# 8. Download default plate detection model
#    The default is Coral's official SSD-MobileNet-v2 COCO model which detects
#    vehicles (car/bus/truck). The scanner finds plates via contour analysis
#    inside vehicle bounding boxes — better precision than whole-frame scan.
# ---------------------------------------------------------------------------
download_model() {
    local dest="$MODEL_DIR/$MODEL_FILE"
    if [[ -f "$dest" ]]; then
        info "Model already present at $dest — skipping download."
        return
    fi
    info "Downloading default plate-detection model…"
    info "  Source: $MODEL_URL"
    info "  Dest:   $dest"
    if wget -q --show-progress -O "$dest" "$MODEL_URL"; then
        chown "$DISMISSAL_USER:$DISMISSAL_USER" "$dest"
        info "Model downloaded successfully."
        info "TIP: Replace with a plate-specific EdgeTPU model for better accuracy."
        info "     Update SCANNER_MODEL_PATH in .env if you use a different path."
    else
        warn "Model download failed — scanner will fall back to contour-only detection."
        warn "Retry manually: wget -O $dest '$MODEL_URL'"
        rm -f "$dest"
    fi
}

# ---------------------------------------------------------------------------
# 9. Headless boot configuration
# ---------------------------------------------------------------------------
configure_headless() {
    info "Configuring headless boot settings…"

    local boot_config="/boot/firmware/config.txt"
    [[ -f "$boot_config" ]] || boot_config="/boot/config.txt"

    # Minimise GPU memory — scanner has no display
    if grep -q "^gpu_mem=" "$boot_config" 2>/dev/null; then
        sed -i 's/^gpu_mem=.*/gpu_mem=16/' "$boot_config"
    else
        append_once "$boot_config" "gpu_mem=16"
    fi

    # Arducam 16MP IMX519 overlay — required for Pi 5 CSI detection
    append_once "$boot_config" "dtoverlay=imx519"

    # BCM2835 hardware watchdog — reboots the Pi if the OS hangs
    append_once "$boot_config" "dtparam=watchdog=on"

    # Blank HDMI to save ~25 mA when no monitor is connected
    append_once "$boot_config" "hdmi_blanking=2"

    # Disable desktop autologin
    if command -v raspi-config &>/dev/null; then
        raspi-config nonint do_boot_behaviour B1 2>/dev/null || true
    fi

    info "Headless configuration applied."
}

# ---------------------------------------------------------------------------
# 10. SD card longevity (reduce writes)
# ---------------------------------------------------------------------------
configure_sd_longevity() {
    info "Applying SD card longevity settings…"
    append_once /etc/fstab \
        "tmpfs /tmp     tmpfs defaults,noatime,nosuid,size=64m  0 0"
    append_once /etc/fstab \
        "tmpfs /var/log tmpfs defaults,noatime,nosuid,size=32m  0 0"
    info "SD card longevity settings applied."
}

# ---------------------------------------------------------------------------
# 11. Hardware watchdog — tell systemd to use BCM2835 WDT
# ---------------------------------------------------------------------------
enable_hardware_watchdog() {
    info "Configuring systemd hardware watchdog…"
    local sysconfd="/etc/systemd/system.conf.d"
    mkdir -p "$sysconfd"
    # Use a drop-in so we don't touch the base system.conf
    cat > "$sysconfd/dismissal-watchdog.conf" << 'EOF'
[Manager]
RuntimeWatchdogSec=15
ShutdownWatchdogSec=2min
EOF
    info "Hardware watchdog configured (takes effect after reboot)."
}

# ---------------------------------------------------------------------------
# 12. Journal size limits
# ---------------------------------------------------------------------------
configure_journal() {
    info "Configuring systemd journal limits…"
    mkdir -p /etc/systemd/journald.conf.d
    cp "$DISMISSAL_HOME/deploy/journald-dismissal.conf" \
        /etc/systemd/journald.conf.d/dismissal.conf
    systemctl restart systemd-journald
    info "Journal configured."
}

# ---------------------------------------------------------------------------
# 13. sudoers drop-in for watchdog recovery commands
# ---------------------------------------------------------------------------
install_sudoers() {
    info "Installing sudoers drop-in for watchdog…"
    local src="$DISMISSAL_HOME/deploy/sudoers-dismissal"
    local dst="/etc/sudoers.d/dismissal-watchdog"
    cp "$src" "$dst"
    chmod 0440 "$dst"
    # Validate before leaving it in place
    if ! visudo -c -f "$dst" &>/dev/null; then
        rm -f "$dst"
        error "sudoers validation failed — $dst removed. Check $src syntax."
    fi
    info "sudoers drop-in installed and validated."
}

# ---------------------------------------------------------------------------
# 14. Install and enable systemd service units
# ---------------------------------------------------------------------------
install_services() {
    info "Installing systemd service units…"
    for svc in "${SERVICES[@]}"; do
        cp "$DISMISSAL_HOME/deploy/${svc}.service" \
            "/etc/systemd/system/${svc}.service"
    done
    systemctl daemon-reload
    for svc in "${SERVICES[@]}"; do
        systemctl enable "$svc"
        info "Enabled: $svc"
    done
    info "Services installed."
}

# ---------------------------------------------------------------------------
# 15. Logrotate
# ---------------------------------------------------------------------------
install_logrotate() {
    info "Installing logrotate configuration…"
    cp "$DISMISSAL_HOME/deploy/dismissal-logrotate.conf" \
        /etc/logrotate.d/dismissal
    info "Logrotate configured."
}

# ---------------------------------------------------------------------------
# 16. Cellular (Hologram.io) — NetworkManager GSM profile
#
# Hologram SIMs use APN 'hologram' with no username/password.  We create a
# catch-all NetworkManager profile (ifname "*") so it activates on whichever
# modem ModemManager discovers — USB LTE dongle, Sixfab HAT, Waveshare SIM7600,
# Quectel EC25, etc.  Priority + route-metric make it win over WiFi when both
# are up (cellular primary, WiFi fallback); if no modem is present, the profile
# sits idle and WiFi is used as normal.
# ---------------------------------------------------------------------------
configure_cellular() {
    if ! command -v nmcli >/dev/null 2>&1; then
        warn "nmcli not found — skipping cellular profile setup."
        return
    fi
    systemctl enable --now ModemManager.service 2>/dev/null || true
    systemctl enable --now NetworkManager.service 2>/dev/null || true

    if nmcli -t -f NAME connection show | grep -qx "hologram"; then
        info "Hologram cellular profile already present — skipping."
        return
    fi

    info "Creating Hologram cellular profile (APN=hologram, primary uplink)…"
    nmcli connection add \
        type gsm \
        ifname "*" \
        con-name hologram \
        apn hologram \
        connection.autoconnect yes \
        connection.autoconnect-priority 100 \
        ipv4.route-metric 100 \
        ipv6.route-metric 100 \
        >/dev/null \
        || warn "Failed to create Hologram NM profile — create it manually later."

    # Nudge any existing WiFi profiles down so cellular wins when both are up.
    while IFS=: read -r name type; do
        [[ "$type" == "802-11-wireless" ]] || continue
        nmcli connection modify "$name" \
            connection.autoconnect-priority -10 \
            ipv4.route-metric 600 \
            ipv6.route-metric 600 \
            >/dev/null 2>&1 || true
    done < <(nmcli -t -f NAME,TYPE connection show)

    info "Cellular profile configured. Insert a Hologram SIM + modem to use it."
}

# ---------------------------------------------------------------------------
# 17. Ensure network-wait service is enabled
# ---------------------------------------------------------------------------
configure_network_wait() {
    info "Configuring network-online.target wait…"
    systemctl enable systemd-networkd-wait-online.service 2>/dev/null \
        || systemctl enable NetworkManager-wait-online.service 2>/dev/null \
        || warn "Could not enable network-wait service."
    info "Network wait configured."
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
    echo ""
    echo -e "${GREEN}============================================================${NC}"
    echo -e "${GREEN}  Dismissal Scanner installation complete!${NC}"
    echo -e "${GREEN}============================================================${NC}"
    echo ""
    echo "  Next steps:"
    echo ""
    echo "  1. Fill in your secrets:"
    echo "     sudo nano /opt/dismissal/Backend/.env"
    echo ""
    echo "     Required fields:"
    echo "       ENV=production"
    echo "       VITE_PROD_BACKEND_URL=https://your-cloud-run-url.run.app"
    echo "       PROD_DISMISSAL_API_TOKEN=<firebase id token>"
    echo "       SCANNER_LOCATION=entry_gate_1"
    echo ""
    echo "  2. REBOOT (required for hardware watchdog + IMX519 overlay):"
    echo "     sudo reboot"
    echo ""
    echo "  3. After reboot, verify the scanner started:"
    echo "     sudo systemctl status dismissal-scanner"
    echo "     journalctl -u dismissal-scanner -f"
    echo ""
    echo "  4. Health endpoint:"
    echo "     curl http://localhost:9000/health | python3 -m json.tool"
    echo ""
    echo "  5. Default model: $MODEL_DIR/$MODEL_FILE"
    echo "     This is the Coral SSD-MobileNet-v2 COCO vehicle detector."
    echo "     For higher accuracy, swap in a plate-specific EdgeTPU model"
    echo "     and update SCANNER_MODEL_PATH in .env."
    echo ""
    echo -e "${YELLOW}  IMPORTANT: A reboot is required for the Arducam IMX519 overlay${NC}"
    echo -e "${YELLOW}  and BCM2835 hardware watchdog to take effect.${NC}"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    require_root
    info "Starting Dismissal deployment on $(hostname) ($(uname -m))"

    install_system_deps
    install_coral
    create_user
    setup_repo
    setup_venv
    setup_env
    setup_dirs
    download_model
    configure_headless
    configure_sd_longevity
    enable_hardware_watchdog
    configure_journal
    install_sudoers
    install_services
    install_logrotate
    configure_cellular
    configure_network_wait
    print_summary
}

main "$@"
