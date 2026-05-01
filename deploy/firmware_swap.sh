#!/usr/bin/env bash
# =============================================================================
# Dismissal Firmware Swap — atomic release switch + service restart
# =============================================================================
# Called by Backend/dismissal_ota.py via passwordless sudo (granted in
# /etc/sudoers.d/dismissal-ota).  Performs the actual atomic symlink
# swap that activates a new release, then restarts the scanner.  Kept
# in shell rather than Python so the privileged surface granted to the
# OTA agent is minimal and auditable — this whole file is the contract.
#
# Usage:
#   sudo /opt/dismissal/deploy/firmware_swap.sh <version>
#
# Pre-conditions (the agent guarantees these):
#   * /opt/dismissal/releases/<version>/Backend/dismissal.py exists
#   * <version> has been verified (sha256 + ed25519) by the agent
#
# What we do:
#   1. Capture the currently-active version (from the symlink target)
#      so the watchdog has it on disk for emergency rollback.
#   2. Atomically flip /opt/dismissal/current → releases/<version>
#      using `ln -sfn` which is rename(2) under the hood — no window
#      where the symlink is missing.
#   3. Restart dismissal-scanner (and dismissal-watchdog so it picks
#      up any updated unit files / scripts).  dismissal-health is
#      not touched here — it's a thin probe and surviving across the
#      swap is fine.
#
# Exit codes:
#   0 — success
#   1 — bad arguments
#   2 — release directory missing or invalid
#   3 — symlink swap failed
#   4 — service restart failed
# =============================================================================
set -euo pipefail

DISMISSAL_HOME="/opt/dismissal"
RELEASES_DIR="${DISMISSAL_HOME}/releases"
CURRENT_LINK="${DISMISSAL_HOME}/current"
PREVIOUS_FILE="${DISMISSAL_HOME}/ota/previous_version"

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <version>" >&2
    exit 1
fi

VERSION="$1"
TARGET_DIR="${RELEASES_DIR}/${VERSION}"

if [[ ! -d "${TARGET_DIR}/Backend" ]]; then
    echo "Release directory ${TARGET_DIR}/Backend does not exist" >&2
    exit 2
fi
if [[ ! -f "${TARGET_DIR}/Backend/dismissal.py" ]]; then
    echo "Release ${VERSION} is missing Backend/dismissal.py" >&2
    exit 2
fi

# Capture the currently-active version (if any) for the watchdog.
mkdir -p "$(dirname "$PREVIOUS_FILE")"
if [[ -L "$CURRENT_LINK" ]]; then
    CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
    if [[ -n "$CURRENT_TARGET" ]]; then
        CURRENT_VERSION="$(basename "$CURRENT_TARGET")"
        if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
            echo "$CURRENT_VERSION" > "$PREVIOUS_FILE"
            echo "Recorded previous version: $CURRENT_VERSION"
        fi
    fi
fi

# Atomic symlink swap.  `ln -sfn` writes to a temp name then rename(2)s
# it over the existing symlink — there is no instant where /current is
# missing.
if ! ln -sfn "${TARGET_DIR}" "${CURRENT_LINK}"; then
    echo "Symlink swap failed" >&2
    exit 3
fi
echo "Active release: ${CURRENT_LINK} -> ${TARGET_DIR}"

# Restart services.  We restart watchdog too because any updated
# unit-file content under deploy/ (shipped in the release tarball)
# would otherwise stay loaded as the old version.  scanner is
# Type=notify so systemctl returns once READY=1 is sent — meaning a
# successful exit here implies the new code at least started up.
SERVICES=("dismissal-scanner" "dismissal-watchdog")
for svc in "${SERVICES[@]}"; do
    if ! systemctl restart "$svc"; then
        echo "Failed to restart $svc" >&2
        exit 4
    fi
done

echo "Swap to ${VERSION} complete."
