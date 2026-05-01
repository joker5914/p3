"""
routes/firmware.py — OTA firmware release management + scanner check-in (issue #104).

Two audiences share this file (mirroring routes/devices.py):

* **Scanners** (``require_scanner``) hit ``GET /api/v1/scanner/firmware-check``
  on a periodic schedule (driven by Backend/dismissal_ota.py) to find out
  whether they should be running a different version.  When a target is
  assigned, the response carries a short-lived signed URL pointing at the
  tarball in Firebase Storage plus the manifest's sha256 + ed25519
  signature so the Pi can verify before swapping.  The scanner reports
  state transitions back via ``POST /api/v1/scanner/firmware-status``.

* **Admins** (``require_super_admin``) manage the release ledger:
  list / create / publish / advance-stage / halt / archive a release,
  pin a school / district / device to a specific version, and read the
  per-device deployment status for the dashboard.

The release model + staged rollout assignment logic live in
``services/firmware_signing`` and ``services/firmware_rollout``; this
file is the HTTP surface around them.

Why a separate route file (vs. extending ``routes/devices.py``):
firmware management is a clean domain boundary — release engineering
calls live here, device-assignment calls live there.  Mixing them
muddied the auth posture (devices.py is split between scanner
endpoints and per-school admin endpoints; firmware.py is uniformly
super_admin / scanner with no school-scoped path).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from core.audit import log_event as audit_log
from core.auth import (
    require_scanner,
    require_super_admin,
    require_super_or_district_admin,
)
from core.firebase import db
from services.firmware_rollout import (
    DEFAULT_STAGES,
    increment_release_metric,
    resolve_target,
    update_device_firmware_state,
)
from services.firmware_signing import (
    FirmwareSigningError,
    signed_artifact_url,
    storage_path_for,
    verify_manifest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?$")


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _validate_version(v: str) -> str:
    v = (v or "").strip()
    if not _VERSION_RE.match(v):
        raise HTTPException(
            status_code=400,
            detail="version must look like 1.2.3 or 1.2.3-beta1",
        )
    return v


def _enforce_scanner_owns_hostname(user_data: dict, hostname: str) -> None:
    if user_data.get("hostname") != hostname:
        raise HTTPException(
            status_code=403,
            detail="Scanner token UID does not match the hostname in the request body.",
        )


# =============================================================================
# Scanner endpoints
# =============================================================================


class FirmwareCheckRequest(BaseModel):
    hostname:        str
    current_version: str = ""
    # Optional — if the scanner is mid-flight on an update it tells the
    # backend so the response can guide it (continue the same target or
    # reset to idle).
    in_flight_state:   Optional[str] = None
    in_flight_version: Optional[str] = None


@router.post("/api/v1/scanner/firmware-check")
def scanner_firmware_check(
    payload: FirmwareCheckRequest,
    user_data: dict = Depends(require_scanner),
):
    """Tell a scanner whether it should be running a different version.

    Response shape::

        {
          "target_version":   "1.2.3" | null,
          "current_version":  "1.2.0",            # what we have on file
          "should_update":    true,
          "reason":           "rollout_stage:canary",
          "rollout_stage":    "canary",
          "pinned":           false,
          "artifact": {                            # only when should_update == true
            "download_url":     "https://...signed...",
            "sha256":           "<hex>",
            "size_bytes":       12345,
            "signature_ed25519": "<base64>",
            "expires_at":       "2026-..."
          },
          "apply_window":      {"start_hour": 2, "end_hour": 4} | null
        }

    Devices outside their apply window receive ``should_update=true``
    but the OTA agent is responsible for waiting; the backend doesn't
    enforce wall-clock here because the scanner's local time + the
    school's timezone are the right authority for "is it 2 AM yet?".
    """
    _enforce_scanner_owns_hostname(user_data, payload.hostname)

    dev_doc = db.collection("devices").document(payload.hostname).get()
    if not dev_doc.exists:
        raise HTTPException(status_code=404, detail="Device not registered")
    device = dev_doc.to_dict() or {}

    # Refresh on every check so the firmware ledger is the source of
    # truth even when the scanner restarts and picks up a stale local
    # version string.
    if payload.current_version:
        update_device_firmware_state(
            payload.hostname,
            state="idle",
            current_version=payload.current_version,
        )

    assignment = resolve_target({**device, "hostname": payload.hostname})
    target = assignment.target_version
    should_update = bool(target and target != payload.current_version)

    response: dict = {
        "target_version":  target,
        "current_version": payload.current_version,
        "should_update":   should_update,
        "reason":          assignment.reason,
        "rollout_stage":   assignment.rollout_stage,
        "pinned":          assignment.pinned,
    }
    if not should_update:
        return response

    release_doc = db.collection("firmware_releases").document(target).get()
    if not release_doc.exists:
        # The pin or rollout pointed at a release that doesn't exist —
        # this is a config error (e.g. school pinned to a version that
        # was archived).  Don't try to update; the admin needs to fix it.
        logger.error(
            "Device %s assigned to missing release %s (reason=%s)",
            payload.hostname, target, assignment.reason,
        )
        return {**response, "should_update": False, "reason": "release_missing"}
    release = release_doc.to_dict() or {}

    try:
        download_url = signed_artifact_url(target)
    except FirmwareSigningError as exc:
        logger.error("Signed URL minting failed for %s: %s", target, exc)
        # Don't expose internal storage errors to the scanner — just tell
        # it not to update yet so it'll retry on the next check.
        return {**response, "should_update": False, "reason": "artifact_unavailable"}

    update_device_firmware_state(
        payload.hostname,
        state="assigned",
        target_version=target,
        rollout_stage=assignment.rollout_stage,
    )
    increment_release_metric(target, "targeted_count")

    return {
        **response,
        "artifact": {
            "download_url":      download_url,
            "sha256":            release.get("artifact_sha256"),
            "size_bytes":        release.get("size_bytes"),
            "signature_ed25519": release.get("signature_ed25519"),
        },
        "apply_window": release.get("apply_window_local"),
    }


_VALID_STATES = {
    "idle", "assigned", "downloading", "verified", "staged",
    "applying", "health_check", "committed", "rolled_back", "failed",
}


class FirmwareStatusReport(BaseModel):
    hostname:         str
    state:            str
    target_version:   Optional[str] = None
    current_version:  Optional[str] = None
    previous_version: Optional[str] = None
    error:            Optional[str] = Field(default=None, max_length=500)


@router.post("/api/v1/scanner/firmware-status")
def scanner_firmware_status(
    payload: FirmwareStatusReport,
    user_data: dict = Depends(require_scanner),
):
    """Pi reports a state transition.  Backend writes ``device_firmware``
    and bumps release metrics on terminal states (committed / rolled_back / failed).
    """
    _enforce_scanner_owns_hostname(user_data, payload.hostname)
    if payload.state not in _VALID_STATES:
        raise HTTPException(status_code=400, detail=f"Unknown state: {payload.state}")

    update_device_firmware_state(
        payload.hostname,
        state=payload.state,
        target_version=payload.target_version,
        current_version=payload.current_version,
        previous_version=payload.previous_version,
        error=payload.error,
    )

    if payload.target_version:
        if payload.state == "downloading":
            increment_release_metric(payload.target_version, "downloaded_count")
        elif payload.state == "committed":
            increment_release_metric(payload.target_version, "applied_count")
        elif payload.state == "rolled_back":
            increment_release_metric(payload.target_version, "rolled_back_count")
            audit_log(
                action="firmware.device.rolled_back",
                actor={"uid": payload.hostname, "role": "scanner"},
                target={"type": "device", "id": payload.hostname, "display_name": payload.hostname},
                diff={"version": payload.target_version, "error": payload.error},
                severity="warning",
                message=f"Device {payload.hostname} rolled back from {payload.target_version}",
            )
        elif payload.state == "failed":
            increment_release_metric(payload.target_version, "failed_count")

    return {"status": "ok"}


# =============================================================================
# Admin endpoints — releases
# =============================================================================


class ReleaseStage(BaseModel):
    name:             str
    percent:          int = Field(ge=0, le=100)
    min_soak_hours:   int = Field(ge=0, le=720, default=0)


class ReleaseScope(BaseModel):
    include_districts: list[str] = Field(default_factory=list)
    include_schools:   list[str] = Field(default_factory=list)
    exclude_devices:   list[str] = Field(default_factory=list)


class ApplyWindow(BaseModel):
    start_hour: int = Field(ge=0, le=23)
    end_hour:   int = Field(ge=0, le=24)   # 24 == "until end of day"


class CreateReleaseRequest(BaseModel):
    """Manifest comes in as a JSON object the admin pasted from sign_firmware.py.

    The admin portal uploads the tarball + manifest.json directly to
    Firebase Storage, then POSTs here with the manifest contents inline
    so the backend can verify the signature against the canonical
    public key before creating the Firestore doc.  This means a corrupt
    manifest (or a manifest signed with the wrong key) fails *before*
    any Pi sees it.
    """
    version:                str
    channel:                str = Field(default="stable", pattern="^(stable|beta|hotfix)$")
    notes:                  str = Field(default="", max_length=8000)
    manifest:               dict
    stages:                 list[ReleaseStage] | None = None
    scope:                  ReleaseScope = Field(default_factory=ReleaseScope)
    apply_window_local:     ApplyWindow | None = None
    failure_threshold:      int = Field(default=3, ge=0, le=1000)


@router.post("/api/v1/admin/firmware/releases")
def create_release(
    payload: CreateReleaseRequest,
    user_data: dict = Depends(require_super_admin),
):
    version = _validate_version(payload.version)

    existing = db.collection("firmware_releases").document(version).get()
    if existing.exists:
        raise HTTPException(status_code=409, detail=f"Release {version} already exists")

    try:
        verified = verify_manifest(payload.manifest, expected_version=version)
    except FirmwareSigningError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    stages = (
        [s.model_dump() for s in payload.stages]
        if payload.stages
        else list(DEFAULT_STAGES)
    )
    # Stages must be monotonically non-decreasing in percent so
    # advancing always widens the rollout.
    if any(stages[i]["percent"] < stages[i - 1]["percent"] for i in range(1, len(stages))):
        raise HTTPException(
            status_code=400,
            detail="Stage percents must be non-decreasing (e.g. 1, 10, 50, 100)",
        )

    now = _iso_now()
    release = {
        "version":                version,
        "channel":                payload.channel,
        "status":                 "draft",
        "artifact_storage_path":  f"{storage_path_for(version)}/{verified.artifact_filename}",
        "artifact_filename":      verified.artifact_filename,
        "artifact_sha256":        verified.sha256,
        "size_bytes":             verified.size_bytes,
        "signature_ed25519":      verified.signature_ed25519,
        "signed_at":              verified.signed_at,
        "signed_by":              verified.signed_by,
        "min_compatible_version": verified.min_compatible_version,
        "notes":                  payload.notes,
        "rollout": {
            "stages":             stages,
            "current_stage":      0,
            "auto_advance":       False,
            "halted":             False,
            "halt_reason":        "",
            "failure_threshold":  payload.failure_threshold,
        },
        "scope": {
            "include_districts":  payload.scope.include_districts,
            "include_schools":    payload.scope.include_schools,
            "exclude_devices":    payload.scope.exclude_devices,
        },
        "apply_window_local":     payload.apply_window_local.model_dump() if payload.apply_window_local else None,
        "metrics": {
            "targeted_count":     0,
            "downloaded_count":   0,
            "applied_count":      0,
            "failed_count":       0,
            "rolled_back_count":  0,
        },
        "created_at":             now,
        "created_by":             user_data.get("uid"),
        "published_at":           None,
    }
    db.collection("firmware_releases").document(version).set(release)

    audit_log(
        action="firmware.release.created",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        diff={"channel": payload.channel, "sha256": verified.sha256, "signed_by": verified.signed_by},
        severity="info",
        message=f"Firmware release {version} created (signed by {verified.signed_by})",
    )
    return {"release": release}


class PublishRequest(BaseModel):
    # No fields — POST to publish.  Body kept so OpenAPI shows it as a
    # mutating action rather than a GET-shaped trigger.
    confirm: bool = True


@router.post("/api/v1/admin/firmware/releases/{version}/publish")
def publish_release(
    version: str,
    _: PublishRequest = Body(default_factory=lambda: PublishRequest()),
    user_data: dict = Depends(require_super_admin),
):
    """Move a draft release to ``published`` so devices start receiving it.

    The first stage (``canary`` by default) becomes effective immediately
    on publish.  Use ``advance`` to widen the rollout afterwards.
    """
    version = _validate_version(version)
    ref = db.collection("firmware_releases").document(version)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Release not found")
    rel = snap.to_dict() or {}
    if rel.get("status") not in (None, "draft"):
        raise HTTPException(
            status_code=409,
            detail=f"Release status is {rel.get('status')}, can only publish drafts",
        )

    stages = ((rel.get("rollout") or {}).get("stages") or DEFAULT_STAGES)
    now = _iso_now()
    stages[0] = {**stages[0], "started_at": now}
    ref.update({
        "status":              "published",
        "published_at":        now,
        "rollout.stages":      stages,
        "rollout.current_stage": 0,
    })

    audit_log(
        action="firmware.release.published",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        diff={"first_stage": stages[0]["name"], "percent": stages[0]["percent"]},
        severity="warning",   # publishing affects production hardware
        message=f"Firmware release {version} published — rollout starts at {stages[0]['name']} ({stages[0]['percent']}%)",
    )
    return {"status": "published", "version": version}


@router.post("/api/v1/admin/firmware/releases/{version}/advance")
def advance_release(
    version: str,
    user_data: dict = Depends(require_super_admin),
):
    """Move a published release to the next rollout stage."""
    version = _validate_version(version)
    ref = db.collection("firmware_releases").document(version)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Release not found")
    rel = snap.to_dict() or {}
    if rel.get("status") != "published":
        raise HTTPException(status_code=409, detail="Release is not published")
    rollout = rel.get("rollout") or {}
    if rollout.get("halted"):
        raise HTTPException(status_code=409, detail="Release is halted — resume before advancing")

    stages = list(rollout.get("stages") or DEFAULT_STAGES)
    current_idx = int(rollout.get("current_stage", 0))
    if current_idx + 1 >= len(stages):
        raise HTTPException(status_code=409, detail="Already at final stage")

    now = _iso_now()
    stages[current_idx] = {**stages[current_idx], "completed_at": now}
    next_idx = current_idx + 1
    stages[next_idx] = {**stages[next_idx], "started_at": now}

    ref.update({
        "rollout.stages":        stages,
        "rollout.current_stage": next_idx,
    })
    audit_log(
        action="firmware.release.stage.advanced",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        diff={"from": stages[current_idx]["name"], "to": stages[next_idx]["name"], "percent": stages[next_idx]["percent"]},
        severity="warning",
        message=f"Firmware release {version} advanced to {stages[next_idx]['name']} ({stages[next_idx]['percent']}%)",
    )
    return {"status": "advanced", "stage": stages[next_idx]}


class HaltRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


@router.post("/api/v1/admin/firmware/releases/{version}/halt")
def halt_release(
    version: str,
    payload: HaltRequest,
    user_data: dict = Depends(require_super_admin),
):
    version = _validate_version(version)
    ref = db.collection("firmware_releases").document(version)
    if not ref.get().exists:
        raise HTTPException(status_code=404, detail="Release not found")

    ref.update({
        "rollout.halted":      True,
        "rollout.halt_reason": payload.reason,
        "rollout.halted_at":   _iso_now(),
    })
    audit_log(
        action="firmware.release.halted",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        diff={"reason": payload.reason},
        severity="critical",
        message=f"Firmware release {version} HALTED: {payload.reason}",
    )
    return {"status": "halted"}


@router.post("/api/v1/admin/firmware/releases/{version}/resume")
def resume_release(version: str, user_data: dict = Depends(require_super_admin)):
    version = _validate_version(version)
    ref = db.collection("firmware_releases").document(version)
    if not ref.get().exists:
        raise HTTPException(status_code=404, detail="Release not found")

    ref.update({
        "rollout.halted":      False,
        "rollout.halt_reason": "",
    })
    audit_log(
        action="firmware.release.resumed",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        severity="warning",
        message=f"Firmware release {version} resumed",
    )
    return {"status": "resumed"}


@router.post("/api/v1/admin/firmware/releases/{version}/archive")
def archive_release(version: str, user_data: dict = Depends(require_super_admin)):
    version = _validate_version(version)
    ref = db.collection("firmware_releases").document(version)
    if not ref.get().exists:
        raise HTTPException(status_code=404, detail="Release not found")

    ref.update({"status": "archived", "archived_at": _iso_now()})
    audit_log(
        action="firmware.release.archived",
        actor=user_data,
        target={"type": "firmware_release", "id": version, "display_name": version},
        severity="info",
        message=f"Firmware release {version} archived",
    )
    return {"status": "archived"}


@router.get("/api/v1/admin/firmware/releases")
def list_releases(user_data: dict = Depends(require_super_or_district_admin)):
    """List every release.  Returns newest first by ``created_at``."""
    docs = list(db.collection("firmware_releases").stream())
    releases = [d.to_dict() | {"id": d.id} for d in docs]
    releases.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"releases": releases}


@router.get("/api/v1/admin/firmware/releases/{version}")
def get_release(version: str, user_data: dict = Depends(require_super_or_district_admin)):
    version = _validate_version(version)
    snap = db.collection("firmware_releases").document(version).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Release not found")
    rel = snap.to_dict()
    rel["id"] = snap.id

    # Per-device deployment for the dashboard.  Filtered to devices
    # *targeting or having recently targeted* this release so the table
    # stays small even when the fleet grows.
    fw_docs = list(db.collection("device_firmware").stream())
    devices = []
    for d in fw_docs:
        data = d.to_dict() or {}
        if data.get("target_version") == version or data.get("current_version") == version:
            devices.append({
                "hostname":         data.get("hostname"),
                "current_version":  data.get("current_version"),
                "target_version":   data.get("target_version"),
                "state":            data.get("state"),
                "rollout_stage":    data.get("rollout_stage"),
                "state_updated_at": data.get("state_updated_at"),
                "last_error":       data.get("last_error"),
            })
    devices.sort(key=lambda d: d.get("state_updated_at") or "", reverse=True)
    rel["devices"] = devices
    return {"release": rel}


# =============================================================================
# Per-device firmware admin (pinning + status read)
# =============================================================================


class PinRequest(BaseModel):
    version: str | None = None   # None == unpin


@router.post("/api/v1/admin/devices/{hostname}/firmware/pin")
def pin_device_firmware(
    hostname: str,
    payload: PinRequest,
    user_data: dict = Depends(require_super_admin),
):
    """Pin (or unpin) a single device to a specific firmware version.

    Pins override the staged rollout.  Used for two flows:
      * Pre-release canary: pin a single Pi to the new version while the
        rest of the fleet stays on the old one, observe for a day.
      * Field freeze: lock a misbehaving Pi to a known-good version
        while we investigate, so it doesn't follow the next rollout.
    """
    if not db.collection("devices").document(hostname).get().exists:
        raise HTTPException(status_code=404, detail="Device not registered")

    fw_ref = db.collection("device_firmware").document(hostname)
    snap = fw_ref.get()
    existing = snap.to_dict() if snap.exists else {}
    before = existing.get("pinned_version")

    if payload.version is None:
        version = None
        action_name = "device.firmware.unpinned"
        msg = f"Device {hostname} unpinned (was {before or 'unpinned'})"
    else:
        version = _validate_version(payload.version)
        rel = db.collection("firmware_releases").document(version).get()
        if not rel.exists:
            raise HTTPException(status_code=404, detail="Pin target version does not exist as a release")
        action_name = "device.firmware.pinned"
        msg = f"Device {hostname} pinned to {version} (was {before or 'unpinned'})"

    fw_ref.set({
        "hostname":          hostname,
        "pinned_version":    version,
        "pin_updated_at":    _iso_now(),
        "pinned_by":         user_data.get("uid"),
    }, merge=True)

    audit_log(
        action=action_name,
        actor=user_data,
        target={"type": "device", "id": hostname, "display_name": hostname},
        diff={"before": before, "after": version},
        severity="warning",
        message=msg,
    )
    return {"status": "ok", "pinned_version": version}


class PublicKeyUpload(BaseModel):
    """Base64 of the raw 32-byte Ed25519 public key.  Comments / whitespace
    are stripped server-side so admins can paste the contents of a
    firmware.pub file directly."""
    public_key_b64: str = Field(min_length=44, max_length=4096)


@router.post("/api/v1/admin/firmware/pubkey")
def set_canonical_pubkey(
    payload: PublicKeyUpload,
    user_data: dict = Depends(require_super_admin),
):
    """Bootstrap or rotate the canonical OTA public key.

    No release can be created until this is set — verification of an
    uploaded manifest reads from here.  Rotating the key is a fleet-
    wide event because every Pi has its own copy at
    /opt/dismissal/keys/firmware.pub; the admin must re-image (or
    push a configuration update through some out-of-band channel)
    before any newly-signed release is accepted by the existing fleet.
    """
    import base64 as _b64

    body = "".join(
        line.strip()
        for line in payload.public_key_b64.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    try:
        raw = _b64.b64decode(body, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"public_key_b64 is not valid base64: {exc}")
    if len(raw) != 32:
        raise HTTPException(status_code=400, detail=f"Public key must decode to 32 bytes, got {len(raw)}")

    now = _iso_now()
    ref = db.collection("platform_settings").document("firmware")
    snap = ref.get()
    before = (snap.to_dict() or {}).get("public_key_b64") if snap.exists else None
    ref.set({
        "public_key_b64": _b64.b64encode(raw).decode("ascii"),
        "rotated_at":     now,
        "rotated_by":     user_data.get("uid"),
    }, merge=True)

    audit_log(
        action="firmware.pubkey.rotated",
        actor=user_data,
        target={"type": "platform_settings", "id": "firmware", "display_name": "Firmware Public Key"},
        diff={"changed": before is not None},
        severity="critical",
        message="Firmware Ed25519 public key set/rotated — fleet must be re-imaged for older releases to remain trusted",
    )
    return {"status": "ok", "rotated_at": now}


@router.get("/api/v1/admin/firmware/devices")
def list_device_firmware(
    user_data: dict = Depends(require_super_or_district_admin),
):
    """Return every ``device_firmware`` doc.

    Used by the Devices page to render the Firmware column inline
    (current_version, state, pinned_version) without making N+1
    requests.  District admins see only their district's devices —
    we filter against ``devices/{hostname}.district_id`` rather than
    duplicating the field on the firmware doc.
    """
    fw_docs = list(db.collection("device_firmware").stream())
    by_host = {d.id: d.to_dict() for d in fw_docs}

    role = user_data.get("role")
    if role == "district_admin":
        district_id = user_data.get("district_id")
        # Filter to the district's devices.  One scan over the devices
        # collection is cheaper than reading each device doc by id.
        in_district = set()
        for dev in db.collection("devices").where(
            field_path="district_id", op_string="==", value=district_id,
        ).stream():
            in_district.add(dev.id)
        by_host = {h: v for h, v in by_host.items() if h in in_district}

    return {"firmware": by_host}


@router.get("/api/v1/admin/devices/{hostname}/firmware")
def get_device_firmware(
    hostname: str,
    user_data: dict = Depends(require_super_or_district_admin),
):
    """Return the firmware ledger entry for a device + currently-resolved target."""
    dev = db.collection("devices").document(hostname).get()
    if not dev.exists:
        raise HTTPException(status_code=404, detail="Device not registered")
    fw_doc = db.collection("device_firmware").document(hostname).get()
    fw = fw_doc.to_dict() if fw_doc.exists else {"hostname": hostname, "state": "idle"}

    assignment = resolve_target({**(dev.to_dict() or {}), "hostname": hostname})
    fw["resolved_target_version"] = assignment.target_version
    fw["resolved_target_reason"]  = assignment.reason
    fw["resolved_target_pinned"]  = assignment.pinned
    return {"firmware": fw}
