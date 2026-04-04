#!/usr/bin/env bash
# =============================================================================
# P3 Scanner — Field Update Script
# =============================================================================
# Run this to pull the latest code and restart services without re-running
# the full install.  Safe to run remotely via SSH.
#
# Usage:
#   sudo bash /opt/p3/deploy/update.sh
# =============================================================================
set -euo pipefail

P3_HOME="/opt/p3"
P3_USER="p3"
P3_BRANCH="master"
SERVICES=("p3-scanner" "p3-watchdog" "p3-health")

GREEN="\033[0;32m"; NC="\033[0m"
info() { echo -e "${GREEN}[P3 UPDATE]${NC} $*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

info "Stopping P3 services…"
for svc in "${SERVICES[@]}"; do
  systemctl stop "$svc" 2>/dev/null || true
done

info "Pulling latest code from $P3_BRANCH…"
sudo -u "$P3_USER" git -C "$P3_HOME" fetch origin
sudo -u "$P3_USER" git -C "$P3_HOME" reset --hard "origin/$P3_BRANCH"

info "Updating Python dependencies…"
sudo -u "$P3_USER" "$P3_HOME/venv/bin/pip" install \
  --quiet \
  -r "$P3_HOME/Backend/requirements-scanner.txt"

info "Reloading systemd unit files…"
cp "$P3_HOME/deploy/"*.service /etc/systemd/system/
systemctl daemon-reload

info "Starting P3 services…"
for svc in "${SERVICES[@]}"; do
  systemctl start "$svc"
done

info "Update complete. Service status:"
for svc in "${SERVICES[@]}"; do
  echo ""
  systemctl status "$svc" --no-pager --lines=3 || true
done
