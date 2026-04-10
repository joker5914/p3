#!/usr/bin/env bash
# =============================================================================
# Dismissal Scanner — Field Update Script
# =============================================================================
# Run this to pull the latest code and restart services without re-running
# the full install.  Safe to run remotely via SSH.
#
# Usage:
#   sudo bash /opt/dismissal/deploy/update.sh
# =============================================================================
set -euo pipefail

DISMISSAL_HOME="/opt/dismissal"
DISMISSAL_USER="dismissal"
DISMISSAL_BRANCH="master"
SERVICES=("dismissal-scanner" "dismissal-watchdog" "dismissal-health")

GREEN="\033[0;32m"; NC="\033[0m"
info() { echo -e "${GREEN}[Dismissal UPDATE]${NC} $*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash update.sh"; exit 1; }

info "Stopping Dismissal services…"
for svc in "${SERVICES[@]}"; do
  systemctl stop "$svc" 2>/dev/null || true
done

info "Pulling latest code from $DISMISSAL_BRANCH…"
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" fetch origin
sudo -u "$DISMISSAL_USER" git -C "$DISMISSAL_HOME" reset --hard "origin/$DISMISSAL_BRANCH"

info "Updating Python dependencies…"
sudo -u "$DISMISSAL_USER" "$DISMISSAL_HOME/venv/bin/pip" install \
  --quiet \
  -r "$DISMISSAL_HOME/Backend/requirements-scanner.txt"

info "Reloading systemd unit files…"
cp "$DISMISSAL_HOME/deploy/"*.service /etc/systemd/system/
systemctl daemon-reload

info "Starting Dismissal services…"
for svc in "${SERVICES[@]}"; do
  systemctl start "$svc"
done

info "Update complete. Service status:"
for svc in "${SERVICES[@]}"; do
  echo ""
  systemctl status "$svc" --no-pager --lines=3 || true
done
