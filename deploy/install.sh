#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Raspberry Pi Field Deployment Script
# =============================================================================
# Tested on: Raspberry Pi OS Lite (64-bit, Bookworm)
# Run as root on a FRESH image:
#   curl -sSL https://raw.githubusercontent.com/joker5914/Dismissal/master/deploy/install.sh | sudo bash
#
# Or clone the repo first and run locally:
#   sudo bash deploy/install.sh
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config — override with environment variables before running if needed
# ---------------------------------------------------------------------------
DISMISSAL_USER="dismissal"
DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_REPO="https://github.com/joker5914/Dismissal.git"
DISMISSAL_BRANCH="master"
PYTHON="python3"
SERVICES=("dismissal-scanner" "dismissal-watchdog" "dismissal-health")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m"

info()  { echo -e "${GREEN}[Dismissal]${NC} $*"; }
warn()  { echo -e "${YELLOW}[Dismissal WARN]${NC} $*"; }
error() { echo -e "${RED}[Dismissal ERROR]${NC} $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || error "This script must be run as root (sudo bash install.sh)"
}

# ---------------------------------------------------------------------------
# 1. System update and package dependencies
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
    libatlas-base-dev \
    libjpeg-dev \
    libtiff-dev \
    libavcodec-dev \
    libavformat-dev \
    libswscale-dev \
    v4l-utils \
    curl \
    logrotate

  info "System packages installed."
}

# ---------------------------------------------------------------------------
# 2. Create dedicated low-privilege user
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

  # Allow dismissal user to access the camera (video group) and GPIO
  usermod -aG video,gpio "$DISMISSAL_USER" 2>/dev/null || true
  info "User '$DISMISSAL_USER' configured."
}

# ---------------------------------------------------------------------------
# 3. Clone or update the repository
# ---------------------------------------------------------------------------
setup_repo() {
  if [[ -d "$DISMISSAL_HOME/.git" ]]; then
    info "Repository already cloned — pulling latest $DISMISSAL_BRANCH…"
    sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" fetch origin
    sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" reset --hard "origin/$DISMISSAL_BRANCH"
  else
    info "Cloning Dismissal repository…"
    # Clone into a temp dir then move so $DISMISSAL_HOME can already exist
    tmpdir=$(mktemp -d)
    git clone --depth 1 --branch "$DISMISSAL_BRANCH" "$DISMISSAL_REPO" "$tmpdir/dismissal"
    rsync -a "$tmpdir/dismissal/" "$DISMISSAL_HOME/"
    rm -rf "$tmpdir"
    chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME"
  fi
  info "Repository ready at $DISMISSAL_HOME."
}

# ---------------------------------------------------------------------------
# 4. Python virtual environment + scanner dependencies
# ---------------------------------------------------------------------------
setup_venv() {
  info "Creating Python virtual environment…"
  sudo -u "$DISMISSAL_USER" $PYTHON -m venv "$DISMISSAL_HOME/venv"

  info "Installing Python scanner dependencies…"
  sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" install --upgrade pip --quiet
  sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" install \
    --quiet \
    -r "$DISMISSAL_HOME/Backend/requirements-scanner.txt"

  # systemd watchdog integration
  sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" install --quiet sdnotify

  info "Python environment ready."
}

# ---------------------------------------------------------------------------
# 5. Environment file
# ---------------------------------------------------------------------------
setup_env() {
  local env_file="$DISMISSAL_HOME/Backend/.env"
  if [[ -f "$env_file" ]]; then
    warn ".env already exists — not overwriting. Review it manually."
  else
    info "Creating .env from template…"
    cp "$DISMISSAL_HOME/Backend/.env.example" "$env_file"
    chown "$DISMISSAL_USER:$DISMISSAL_USER" "$env_file"
    chmod 600 "$env_file"  # readable only by dismissal user
    warn "ACTION REQUIRED: Edit $env_file and fill in all REPLACE_ME values."
  fi
}

# ---------------------------------------------------------------------------
# 6. Create required runtime directories
# ---------------------------------------------------------------------------
setup_dirs() {
  info "Creating runtime directories…"
  mkdir -p \
    "$DISMISSAL_HOME/Backend/debug_frames" \
    "$DISMISSAL_HOME/Backend/logs"
  chown -R "$DISMISSAL_USER:$DISMISSAL_USER" "$DISMISSAL_HOME/Backend/debug_frames" "$DISMISSAL_HOME/Backend/logs"
}

# ---------------------------------------------------------------------------
# 7. Disable GPU memory split (headless — no display)
# ---------------------------------------------------------------------------
configure_headless() {
  info "Configuring headless boot settings…"

  # Minimise GPU memory — scanner does not need a display
  local boot_config="/boot/firmware/config.txt"
  [[ -f "$boot_config" ]] || boot_config="/boot/config.txt"  # older RPi OS

  if grep -q "^gpu_mem=" "$boot_config" 2>/dev/null; then
    sed -i 's/^gpu_mem=.*/gpu_mem=16/' "$boot_config"
  else
    echo "gpu_mem=16" >> "$boot_config"
  fi

  # Disable desktop autologin if raspi-config is present
  if command -v raspi-config &>/dev/null; then
    raspi-config nonint do_boot_behaviour B1 2>/dev/null || true  # CLI no autologin
  fi

  # Disable HDMI output to save ~25 mA (field devices rarely have a monitor)
  if ! grep -q 'hdmi_blanking=2' "$boot_config" 2>/dev/null; then
    echo "hdmi_blanking=2" >> "$boot_config"
  fi

  info "Headless configuration applied."
}

# ---------------------------------------------------------------------------
# 8. Harden SD card I/O (reduce writes to extend SD card life)
# ---------------------------------------------------------------------------
configure_sd_longevity() {
  info "Applying SD card longevity settings…"

  # Mount /tmp as tmpfs (RAM) so log churn doesn't wear the SD card
  if ! grep -q 'tmpfs /tmp' /etc/fstab; then
    echo 'tmpfs /tmp tmpfs defaults,noatime,nosuid,size=64m 0 0' >> /etc/fstab
  fi

  # Also put /var/log/journal in RAM if not already
  if ! grep -q 'tmpfs /var/log' /etc/fstab; then
    echo 'tmpfs /var/log tmpfs defaults,noatime,nosuid,size=32m 0 0' >> /etc/fstab
  fi

  info "SD card longevity settings applied."
}

# ---------------------------------------------------------------------------
# 9. Journal size limits
# ---------------------------------------------------------------------------
configure_journal() {
  info "Configuring systemd journal limits…"
  mkdir -p /etc/systemd/journald.conf.d
  cp "$DISMISSAL_HOME/deploy/journald-dismissal.conf" /etc/systemd/journald.conf.d/dismissal.conf
  systemctl restart systemd-journald
  info "Journal configured."
}

# ---------------------------------------------------------------------------
# 10. Install and enable systemd services
# ---------------------------------------------------------------------------
install_services() {
  info "Installing systemd service units…"

  for svc in "${SERVICES[@]}"; do
    cp "$DISMISSAL_HOME/deploy/${svc}.service" "/etc/systemd/system/${svc}.service"
  done

  systemctl daemon-reload

  for svc in "${SERVICES[@]}"; do
    systemctl enable "$svc"
    info "Enabled: $svc"
  done

  info "Services installed. They will start on next boot or run: sudo systemctl start dismissal-scanner"
}

# ---------------------------------------------------------------------------
# 11. Install logrotate config
# ---------------------------------------------------------------------------
install_logrotate() {
  info "Installing logrotate configuration…"
  cp "$DISMISSAL_HOME/deploy/dismissal-logrotate.conf" /etc/logrotate.d/dismissal
  info "Logrotate configured."
}

# ---------------------------------------------------------------------------
# 12. Optional: enable hardware watchdog (BCM2835 on RPi)
# ---------------------------------------------------------------------------
enable_hardware_watchdog() {
  info "Enabling BCM2835 hardware watchdog…"
  local boot_config="/boot/firmware/config.txt"
  [[ -f "$boot_config" ]] || boot_config="/boot/config.txt"

  if ! grep -q 'dtparam=watchdog=on' "$boot_config" 2>/dev/null; then
    echo 'dtparam=watchdog=on' >> "$boot_config"
  fi

  # Tell systemd to use the hardware watchdog
  if ! grep -q '^RuntimeWatchdogSec' /etc/systemd/system.conf 2>/dev/null; then
    echo 'RuntimeWatchdogSec=15' >> /etc/systemd/system.conf
    echo 'ShutdownWatchdogSec=2min' >> /etc/systemd/system.conf
  fi

  info "Hardware watchdog enabled."
}

# ---------------------------------------------------------------------------
# 13. Network wait — ensure WiFi is up before services start
# ---------------------------------------------------------------------------
configure_network_wait() {
  info "Configuring network-online.target wait…"
  systemctl enable systemd-networkd-wait-online.service 2>/dev/null || \
    systemctl enable NetworkManager-wait-online.service 2>/dev/null || \
    warn "Could not enable network-wait service — services may start before WiFi is ready."
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
  echo "  2. Start the scanner now (no reboot needed):"
  echo "     sudo systemctl start dismissal-scanner dismissal-watchdog dismissal-health"
  echo ""
  echo "  3. Check it's running:"
  echo "     sudo systemctl status dismissal-scanner"
  echo "     journalctl -u dismissal-scanner -f"
  echo ""
  echo "  4. Health endpoint (once dismissal-health is running):"
  echo "     curl http://localhost:9000/health"
  echo ""
  echo "  5. Reboot to verify auto-start:"
  echo "     sudo reboot"
  echo ""
  echo -e "${YELLOW}  IMPORTANT: Rotate any credentials that were previously${NC}"
  echo -e "${YELLOW}  committed to source control before deploying!${NC}"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  require_root
  info "Starting Dismissal scanner deployment on $(hostname) ($(uname -m))"

  install_system_deps
  create_user
  setup_repo
  setup_venv
  setup_env
  setup_dirs
  configure_headless
  configure_sd_longevity
  configure_journal
  install_services
  install_logrotate
  enable_hardware_watchdog
  configure_network_wait
  print_summary
}

main "$@"
