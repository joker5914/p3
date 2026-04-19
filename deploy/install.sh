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
# 2. (Coral Edge TPU removed — kept breaking on Trixie / Python 3.10+)
#    The scanner runs contour-based plate detection on CPU. If you later
#    want to add hardware acceleration, do it via a framework that actually
#    tracks Python releases (ONNX Runtime, TFLite-runtime, Hailo, etc.)
#    rather than resurrecting pycoral.
# ---------------------------------------------------------------------------

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

    # video — access /dev/video* (CSI camera via v4l2 / libcamera)
    # gpio  — reserved for future GPIO work
    usermod -aG video,gpio "$DISMISSAL_USER" 2>/dev/null || true
    info "User '$DISMISSAL_USER' configured (groups: video, gpio)."
}

# ---------------------------------------------------------------------------
# 4. Clone or update the repository
# ---------------------------------------------------------------------------
setup_repo() {
    if [[ -d "$DISMISSAL_HOME/.git" ]]; then
        info "Repository already present — pulling latest $DISMISSAL_BRANCH…"
        # firstrun.sh clones the repo as root (it has to — the dismissal user
        # doesn't exist yet at that point).  Before running any sudo -u
        # dismissal git commands on it, take ownership of the tree so git's
        # safe-directory check doesn't trip with "fatal: detected dubious
        # ownership in repository at '/opt/dismissal'".
        chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME"
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
# --system-site-packages is required so that picamera2 (installed system-wide
# via apt) is visible inside the venv.
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

    # Best-effort neural runtime install.  tflite-runtime doesn't always
    # have wheels for the newest Python (e.g. Trixie ships Python 3.13);
    # try both official names and fall back to contour if neither works.
    install_tflite_runtime

    info "Python environment ready."
}

install_tflite_runtime() {
    local pip="$DISMISSAL_HOME/venv/bin/pip"
    local py="$DISMISSAL_HOME/venv/bin/python"
    if sudo -u "$DISMISSAL_USER" "$py" -c \
        "import tflite_runtime" 2>/dev/null; then
        info "tflite-runtime already available."
        return
    fi
    if sudo -u "$DISMISSAL_USER" "$py" -c \
        "import ai_edge_litert" 2>/dev/null; then
        info "ai-edge-litert already available."
        return
    fi
    info "Attempting to install tflite-runtime / ai-edge-litert…"
    for pkg in tflite-runtime ai-edge-litert; do
        if sudo -u "$DISMISSAL_USER" "$pip" install --quiet "$pkg" 2>/dev/null; then
            info "Installed $pkg."
            return
        fi
    done
    warn "Could not install tflite-runtime or ai-edge-litert — neural "
    warn "vehicle detector will be disabled.  Contour-only plate detection "
    warn "still works; retry after a Python downgrade or package update."
}

# ---------------------------------------------------------------------------
# 6. Environment file
#
# The scanner reads its backend URL + Firebase Web API key from
# scanner_config.py (committed, public), so the only thing a fresh Pi
# strictly needs in .env is ENV=production (so it picks the prod URL) plus
# a SCANNER_LOCATION label.  A heavier .env with tuning overrides can be
# staged onto the SD card by prepare-sdcard.sh; if that file is present
# when firstrun.sh runs, it wins and this function leaves it alone.
#
# Runs unconditionally — it's idempotent and safe under SKIP_ENV_SETUP
# (which firstrun.sh used to set when it handled .env itself).  The
# previous behavior of skipping under SKIP_ENV_SETUP left Pis with no
# .env at all when firstrun.sh didn't find a staged file, and the
# systemd unit refused to start on the missing EnvironmentFile.
# ---------------------------------------------------------------------------
setup_env() {
    local env_file="$DISMISSAL_HOME/Backend/.env"
    if [[ -f "$env_file" ]]; then
        info ".env already present at $env_file — leaving it alone."
        return
    fi
    info "Creating minimal .env at $env_file…"
    cat > "$env_file" <<EOF
# Auto-generated by install.sh on first boot.  Edit to override any
# scanner tuning knobs (see Backend/.env.example for the full list).
ENV=production
SCANNER_LOCATION=$(hostname)
EOF
    chown "$DISMISSAL_USER:$DISMISSAL_USER" "$env_file"
    chmod 600 "$env_file"
    info "Default .env written with SCANNER_LOCATION=$(hostname)."
}

# ---------------------------------------------------------------------------
# 7. Runtime directories
# ---------------------------------------------------------------------------
setup_dirs() {
    info "Creating runtime directories…"
    mkdir -p \
        "$DISMISSAL_HOME/Backend/debug_frames" \
        "$DISMISSAL_HOME/Backend/logs"
    chown -R "$DISMISSAL_USER:$DISMISSAL_USER" \
        "$DISMISSAL_HOME/Backend/debug_frames" \
        "$DISMISSAL_HOME/Backend/logs"
    # /var/lib/dismissal is created by systemd StateDirectory= but pre-create
    # it here so it exists before first service start.
    mkdir -p /var/lib/dismissal
    chown "$DISMISSAL_USER:$DISMISSAL_USER" /var/lib/dismissal
    chmod 750 /var/lib/dismissal
}

# ---------------------------------------------------------------------------
# 8. Download SSD-MobileNet-v2 COCO models (CPU + optional Edge TPU variant)
#    and install libedgetpu so plugging in a Coral "just works" later.
#
#    Both .tflite files come from google-coral/test_data.  The plain
#    _postprocess.tflite runs on the Pi 5 CPU at ~5–10 FPS; the
#    _postprocess_edgetpu.tflite is only used when a Coral USB/M.2 is
#    plugged in and libedgetpu can load its delegate.
# ---------------------------------------------------------------------------
download_models() {
    local dir="$DISMISSAL_HOME/models"
    mkdir -p "$dir"

    local base="https://github.com/google-coral/test_data/raw/master"
    local cpu_name="ssd_mobilenet_v2_coco_quant_postprocess.tflite"
    local tpu_name="ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"

    for name in "$cpu_name" "$tpu_name"; do
        if [[ -f "$dir/$name" ]]; then
            info "Model already present: $name"
            continue
        fi
        info "Downloading $name…"
        if ! curl -fsSL -o "$dir/$name" "$base/$name"; then
            warn "Failed to download $name — scanner will use contour fallback."
            rm -f "$dir/$name"
        fi
    done

    chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$dir"
}

# Edge TPU runtime (libedgetpu.so.1).  Harmless to install without a Coral
# plugged in — the library just sits there until we call load_delegate().
install_edgetpu_runtime() {
    if dpkg -s libedgetpu1-std &>/dev/null || dpkg -s libedgetpu1-max &>/dev/null; then
        info "libedgetpu already installed."
        return
    fi
    info "Installing libedgetpu1-std (Edge TPU runtime)…"
    # Google's coral.ai APT repo provides the aarch64 package.
    if [[ ! -f /etc/apt/sources.list.d/coral-edgetpu.list ]]; then
        curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | \
            gpg --dearmor -o /usr/share/keyrings/coral-archive-keyring.gpg
        echo "deb [signed-by=/usr/share/keyrings/coral-archive-keyring.gpg] https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
            > /etc/apt/sources.list.d/coral-edgetpu.list
        apt-get update -qq
    fi
    apt-get install -y --no-install-recommends libedgetpu1-std || \
        warn "libedgetpu install failed — CPU detection will still work."
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
    echo "  1. (Optional) tune scanner knobs:"
    echo "     sudo nano /opt/dismissal/Backend/.env"
    echo ""
    echo "     A minimal default .env was created for you:"
    echo "       ENV=production"
    echo "       SCANNER_LOCATION=$(hostname)"
    echo ""
    echo "     Every other knob (FPS, plate length, timeouts) falls through"
    echo "     to sensible defaults — see Backend/.env.example for the list."
    echo ""
    echo "  2. REBOOT (required for hardware watchdog + IMX519 overlay):"
    echo "     sudo reboot"
    echo ""
    echo "  3. After reboot, verify the scanner registered:"
    echo "     sudo systemctl status dismissal-scanner"
    echo "     journalctl -u dismissal-scanner -f"
    echo "     (You should see 'Registered with backend as hostname=…')"
    echo ""
    echo "  4. Health endpoint:"
    echo "     curl http://localhost:9000/health | python3 -m json.tool"
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
    create_user
    setup_repo
    setup_venv
    setup_env
    setup_dirs
    install_edgetpu_runtime
    download_models
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
