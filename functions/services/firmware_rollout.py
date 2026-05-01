"""
services/firmware_rollout.py — staged-rollout assignment + state transitions.

The rollout model in three sentences:

  Each release defines an ordered list of stages (canary → early →
  broad → general) with a percent-of-fleet cap and a minimum soak time
  before the next stage may begin.  A device's deterministic hash
  bucket is compared against the *current* stage's percent — devices
  in-bucket get the version assigned, devices out-of-bucket keep their
  current version.  Per-school pinning, per-device pinning, and an
  ``exclude`` blocklist override bucketing entirely so admins can
  freeze a school on a known-good release while the rest of the fleet
  rolls forward.

This module is the single source of truth for the question "what
version should device X be running right now?".  Both the
scanner-facing ``/firmware-check`` endpoint and the admin
"Releases · per-device status" view route through it so the answers
agree.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from core.firebase import db
from services.firmware_signing import device_bucket

logger = logging.getLogger(__name__)


# Default stage shape — admins can override per release at upload time.
# These percentages are cumulative caps, not deltas: stage N includes
# every bucket below stage N's percent (so canary 1% is also part of
# early 10%, etc).  This makes "advance to next stage" a one-field
# update rather than a recalculation.
DEFAULT_STAGES = [
    {"name": "canary",  "percent": 1,   "min_soak_hours": 24},
    {"name": "early",   "percent": 10,  "min_soak_hours": 48},
    {"name": "broad",   "percent": 50,  "min_soak_hours": 24},
    {"name": "general", "percent": 100, "min_soak_hours": 0},
]


@dataclass(frozen=True)
class Assignment:
    """Result of resolving "what version should this device run?"."""
    target_version:   Optional[str]    # version to install, or None
    reason:           str              # why we picked this version (audit)
    rollout_stage:    Optional[str] = None
    pinned:           bool = False     # set if a pin overrode the rollout


def _is_release_active(release: dict) -> bool:
    """Released and not halted/archived/draft."""
    return release.get("status") == "published" and not release.get("halted", False)


def _device_in_scope(release: dict, device: dict) -> tuple[bool, str]:
    """Apply scope filters: include_districts, include_schools, exclude_devices.

    Empty include lists mean "all".  Returns (in_scope, reason).
    """
    scope = release.get("scope", {}) or {}
    excluded = scope.get("exclude_devices") or []
    if device.get("hostname") in excluded:
        return False, "device_excluded"

    include_districts = scope.get("include_districts") or []
    if include_districts and device.get("district_id") not in include_districts:
        return False, "district_not_in_scope"

    include_schools = scope.get("include_schools") or []
    if include_schools and device.get("school_id") not in include_schools:
        return False, "school_not_in_scope"

    return True, "in_scope"


def _stage_for_device(release: dict, device: dict) -> Optional[dict]:
    """Return the stage this device falls into, or None if not yet assigned."""
    rollout = release.get("rollout", {}) or {}
    stages = rollout.get("stages") or DEFAULT_STAGES
    current_idx = int(rollout.get("current_stage", 0))
    if current_idx < 0 or current_idx >= len(stages):
        return None
    current = stages[current_idx]
    bucket = device_bucket(device.get("cpu_serial") or "", release.get("version", ""))
    if bucket < float(current.get("percent", 0)):
        return current
    return None


def resolve_target(device: dict) -> Assignment:
    """The complete answer for one device.

    Inputs: a ``devices/{hostname}`` doc dict (must include cpu_serial,
    school_id, district_id, hostname).  Reads the latest published
    release plus any pins from the school/district/device-firmware docs.

    Lookup order (first match wins):
      1. ``device_firmware/{hostname}.pinned_version`` — admin override.
      2. ``schools/{school_id}.firmware_pin`` — school freeze.
      3. ``districts/{district_id}.firmware_pin`` — district freeze.
      4. The newest published release whose rollout stage covers this
         device's bucket.
      5. Fallthrough — ``current_version`` on the device-firmware doc
         (don't change anything).
    """
    hostname = device.get("hostname") or ""
    if not hostname:
        return Assignment(None, "no_hostname")

    # 1. Per-device pin (highest priority — emergency lock or canary).
    fw_doc = db.collection("device_firmware").document(hostname).get()
    fw_state = fw_doc.to_dict() if fw_doc.exists else {}
    pinned = (fw_state.get("pinned_version") or "").strip()
    if pinned:
        return Assignment(
            target_version=pinned, reason="device_pinned", pinned=True,
        )

    # 2. School pin.
    school_id = device.get("school_id")
    if school_id:
        sdoc = db.collection("schools").document(school_id).get()
        if sdoc.exists:
            sp = (sdoc.to_dict() or {}).get("firmware_pin", "").strip()
            if sp:
                return Assignment(target_version=sp, reason="school_pinned", pinned=True)

    # 3. District pin.
    district_id = device.get("district_id")
    if district_id:
        ddoc = db.collection("districts").document(district_id).get()
        if ddoc.exists:
            dp = (ddoc.to_dict() or {}).get("firmware_pin", "").strip()
            if dp:
                return Assignment(target_version=dp, reason="district_pinned", pinned=True)

    # 4. Newest published, in-scope, in-bucket release.
    # We sort published releases by ``published_at`` desc and walk
    # them, taking the first one this device qualifies for.  Multiple
    # active releases at once is unusual but allowed — e.g. a hotfix
    # rolled out alongside a normal release on a different scope.
    releases = (
        db.collection("firmware_releases")
          .where(field_path="status", op_string="==", value="published")
          .stream()
    )
    candidates = []
    for r in releases:
        data = r.to_dict() or {}
        if not _is_release_active(data):
            continue
        candidates.append(data)
    candidates.sort(key=lambda d: d.get("published_at") or "", reverse=True)

    for release in candidates:
        in_scope, _ = _device_in_scope(release, device)
        if not in_scope:
            continue
        stage = _stage_for_device(release, device)
        if stage is None:
            continue
        return Assignment(
            target_version=release.get("version"),
            reason=f"rollout_stage:{stage.get('name')}",
            rollout_stage=stage.get("name"),
        )

    # 5. Fallthrough — keep current.
    return Assignment(
        target_version=fw_state.get("current_version") or None,
        reason="no_matching_release",
    )


def update_device_firmware_state(
    hostname: str,
    *,
    state:           str,
    target_version:  Optional[str] = None,
    current_version: Optional[str] = None,
    previous_version: Optional[str] = None,
    error:           Optional[str] = None,
    rollout_stage:   Optional[str] = None,
) -> None:
    """Record a transition reported by the OTA agent on the Pi.

    ``device_firmware/{hostname}`` is upserted; the last 10 attempts
    are kept under ``attempts_history`` for forensic value when an
    admin opens a device's release detail page.  Older entries fall
    off so the doc stays well under the 1 MiB document cap.
    """
    now = datetime.now(tz=timezone.utc).isoformat()
    ref = db.collection("device_firmware").document(hostname)
    snap = ref.get()
    existing = snap.to_dict() if snap.exists else {}

    update: dict = {
        "hostname":          hostname,
        "state":             state,
        "state_updated_at":  now,
        "last_check_at":     now,
    }
    if target_version is not None:
        update["target_version"] = target_version
    if current_version is not None:
        update["current_version"] = current_version
    if previous_version is not None:
        update["previous_version"] = previous_version
    if rollout_stage is not None:
        update["rollout_stage"] = rollout_stage
    if error is not None:
        update["last_error"] = error

    history = list(existing.get("attempts_history") or [])
    history.append({
        "at": now,
        "state": state,
        "version": target_version or existing.get("target_version"),
        "error": error,
    })
    update["attempts_history"] = history[-10:]

    if not snap.exists:
        update.setdefault("created_at", now)
    ref.set(update, merge=True)


def increment_release_metric(version: str, field: str, delta: int = 1) -> None:
    """Bump a counter on ``firmware_releases/{version}.metrics.{field}``."""
    from google.cloud.firestore import Increment
    ref = db.collection("firmware_releases").document(version)
    ref.set({"metrics": {field: Increment(delta)}}, merge=True)
