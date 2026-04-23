"""
routes/devices.py — scanner device registration + admin device management.

Two audiences share this file:

* **Scanners** (``require_scanner``): POST ``/devices/register`` on startup,
  POST ``/devices/heartbeat`` every 5 minutes.  Both endpoints upsert a row
  in the ``devices`` Firestore collection keyed by hostname and return the
  current device config (location).

* **Admins** (``require_super_admin``): list all devices, view a single
  device, update the admin-editable fields (currently just ``location``).
  Super-admin-only — it's a platform-level view, not school-scoped.

Firestore collection layout
---------------------------
``devices/{hostname}`` — one doc per device.
Fields (all optional on first register):
  hostname        str   (doc ID, also stored for easy querying)
  cpu_serial      str   (Pi CPU serial — hardware-unique)
  mac_address     str
  ip_address      str   (last-seen IPv4 on the default route)
  firmware_sha    str   (short git SHA currently deployed)
  location        str   (admin-editable label — shown in UI)
  status          str   (derived at read time: "online"/"offline")
  created_at      str   (ISO-8601, set on first register only)
  first_seen_at   str   (ISO-8601, alias of created_at kept for clarity)
  last_seen_at    str   (ISO-8601, refreshed on every heartbeat)
  last_started_at str   (ISO-8601, refreshed on every register)
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.auth import (
    _get_user_permissions,
    require_scanner,
    require_super_admin,
    require_super_or_district_admin,
    verify_firebase_token,
)
from core.firebase import db

logger = logging.getLogger(__name__)

router = APIRouter()

# A device is considered online if it has heartbeat-ed within this window.
ONLINE_WINDOW = timedelta(minutes=10)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class DeviceRegistration(BaseModel):
    hostname:      str
    cpu_serial:    str = ""
    mac_address:   str = ""
    ip_address:    str = ""
    firmware_sha:  str = ""
    started_at:    str = ""


class DeviceHealthSnapshot(BaseModel):
    """Compact per-device telemetry pushed alongside the heartbeat so the
    admin portal's Devices view can show live cpu/memory/uptime without
    needing a path into the Pi's LAN-only /health HTTP endpoint."""
    healthy:             bool | None = None
    uptime_seconds:      float | None = None
    cpu_temp_c:          float | None = None
    memory_total_mb:     int | None = None
    memory_used_mb:      int | None = None
    memory_available_mb: int | None = None
    service_scanner:     str | None = None
    service_watchdog:    str | None = None
    reported_at:         str | None = None


class DeviceHeartbeat(BaseModel):
    hostname:    str
    ip_address:  str = ""
    sent_at:     str = ""
    health:      DeviceHealthSnapshot | None = None


class DevicePatch(BaseModel):
    location: str | None = Field(default=None, min_length=1, max_length=120)
    # Which district this device belongs to.  Set by super_admins at
    # platform level — e.g. when a newly registered Pi ships to a customer.
    # Empty string = unassign (and also clears school_id, since schools
    # live inside a district).
    district_id: str | None = Field(default=None, max_length=120)
    # Which school (within the assigned district) this device belongs to.
    # Set by district admins when the Pi is physically installed at a
    # specific campus.  Empty string = unassign.  The scanner auth path
    # reads this field so scans show up in the right campus Dashboard.
    school_id: str | None = Field(default=None, max_length=120)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _derive_status(last_seen_iso: str | None) -> str:
    if not last_seen_iso:
        return "offline"
    try:
        last_seen = datetime.fromisoformat(last_seen_iso)
    except ValueError:
        return "offline"
    return "online" if datetime.now(tz=timezone.utc) - last_seen <= ONLINE_WINDOW else "offline"


_school_name_cache: dict = {}
_district_name_cache: dict = {}


def _lookup_school_name(school_id: str | None) -> str | None:
    """Resolve a display name for the device's school.  Cached in-process
    because the device list fans out one read per device and we don't want
    to re-query Firestore for the same school N times per request."""
    if not school_id:
        return None
    if school_id in _school_name_cache:
        return _school_name_cache[school_id]
    try:
        sdoc = db.collection("schools").document(school_id).get()
        name = (sdoc.to_dict() or {}).get("name") if sdoc.exists else None
    except Exception:
        name = None
    _school_name_cache[school_id] = name
    return name


def _lookup_district_name(district_id: str | None) -> str | None:
    if not district_id:
        return None
    if district_id in _district_name_cache:
        return _district_name_cache[district_id]
    try:
        ddoc = db.collection("districts").document(district_id).get()
        name = (ddoc.to_dict() or {}).get("name") if ddoc.exists else None
    except Exception:
        name = None
    _district_name_cache[district_id] = name
    return name


def _school_district_id(school_id: str | None) -> str | None:
    """Return the ``district_id`` of ``school_id`` or None if missing."""
    if not school_id:
        return None
    try:
        sdoc = db.collection("schools").document(school_id).get()
        if sdoc.exists:
            return (sdoc.to_dict() or {}).get("district_id")
    except Exception:
        pass
    return None


def _serialise(doc_data: dict) -> dict:
    """Convert a Firestore doc dict into the shape returned by the API."""
    data = dict(doc_data)
    data["status"] = _derive_status(data.get("last_seen_at"))
    data["school_name"]   = _lookup_school_name(data.get("school_id"))
    data["district_name"] = _lookup_district_name(data.get("district_id"))
    return data


def _config_payload(device: dict) -> dict:
    """Shape returned to the scanner so it can apply admin-set config."""
    return {
        "location": device.get("location") or device.get("hostname", ""),
    }


def _enforce_scanner_owns_hostname(user_data: dict, hostname: str) -> None:
    if user_data.get("hostname") != hostname:
        raise HTTPException(
            status_code=403,
            detail="Scanner token UID does not match the hostname in the request body.",
        )


def require_devices_viewer(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Read-side access to ``/api/v1/devices``.

    * ``super_admin`` — always.
    * ``district_admin`` — always (sees their whole district).
    * ``school_admin`` / ``staff`` — when the ``devices`` permission is
      granted for their role under Permissions.  They only ever see the
      devices assigned to their school (filter applied in list_devices).
    """
    role = user_data.get("role")
    if role in ("super_admin", "district_admin"):
        return user_data
    if role in ("school_admin", "staff"):
        school_id = user_data.get("school_id") or user_data.get("uid")
        perms = _get_user_permissions(role, school_id)
        if perms.get("devices"):
            return user_data
        raise HTTPException(status_code=403, detail="Devices permission required")
    raise HTTPException(status_code=403, detail="Admin role required")


# ---------------------------------------------------------------------------
# Scanner endpoints
# ---------------------------------------------------------------------------

@router.post("/api/v1/devices/register")
def register_device(
    payload: DeviceRegistration,
    user_data: dict = Depends(require_scanner),
):
    """
    Upsert the device row on every startup.  Idempotent — the scanner calls
    this every boot.  Returns the current admin-set config.
    """
    _enforce_scanner_owns_hostname(user_data, payload.hostname)
    now = _iso_now()
    ref = db.collection("devices").document(payload.hostname)

    existing = ref.get()
    if existing.exists:
        update = {
            "hostname":        payload.hostname,
            "cpu_serial":      payload.cpu_serial or existing.get("cpu_serial") or "",
            "mac_address":     payload.mac_address or existing.get("mac_address") or "",
            "ip_address":      payload.ip_address,
            "firmware_sha":    payload.firmware_sha,
            "last_seen_at":    now,
            "last_started_at": payload.started_at or now,
        }
        ref.update(update)
        device = {**existing.to_dict(), **update}
    else:
        device = {
            "hostname":        payload.hostname,
            "cpu_serial":      payload.cpu_serial,
            "mac_address":     payload.mac_address,
            "ip_address":      payload.ip_address,
            "firmware_sha":    payload.firmware_sha,
            "location":        "",   # admin fills in later
            "created_at":      now,
            "first_seen_at":   now,
            "last_seen_at":    now,
            "last_started_at": payload.started_at or now,
        }
        ref.set(device)
        logger.info("New device registered: hostname=%s", payload.hostname)

    return {"status": "ok", "config": _config_payload(device)}


@router.post("/api/v1/devices/heartbeat")
def heartbeat_device(
    payload: DeviceHeartbeat,
    user_data: dict = Depends(require_scanner),
):
    """
    Lightweight periodic check-in.  Updates ``last_seen_at`` + current IP;
    returns the current admin-set config so the scanner can pick up location
    changes without a restart.
    """
    _enforce_scanner_owns_hostname(user_data, payload.hostname)
    now = _iso_now()

    # Flatten any health snapshot the scanner sent so the fields live on
    # the device doc and can be read back in the list response without a
    # second lookup.  Every scalar is namespaced `health_*` so it's clear
    # they came from the scanner's dismissal_health probe.
    health_fields: dict = {}
    if payload.health:
        snap = payload.health.model_dump(exclude_none=True)
        for key, value in snap.items():
            health_fields[f"health_{key}"] = value

    ref = db.collection("devices").document(payload.hostname)
    snapshot = ref.get()
    if not snapshot.exists:
        # First contact via heartbeat (register didn't happen) — create a
        # minimal row so the scanner appears in the admin UI.
        ref.set({
            "hostname":      payload.hostname,
            "ip_address":    payload.ip_address,
            "created_at":    now,
            "first_seen_at": now,
            "last_seen_at":  now,
            **health_fields,
        })
        device = ref.get().to_dict() or {}
    else:
        update = {
            "ip_address":   payload.ip_address,
            "last_seen_at": now,
            **health_fields,
        }
        ref.update(update)
        device = {**snapshot.to_dict(), **update}

    return {"status": "ok", "config": _config_payload(device)}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@router.get("/api/v1/devices")
def list_devices(user_data: dict = Depends(require_devices_viewer)):
    """List registered devices.

    * ``super_admin`` — every device, so Dismissal staff can triage any
      customer's hardware.
    * ``district_admin`` — only devices assigned to their district, so they
      can pick which school inside the district each Pi is installed at.
    * ``school_admin`` / ``staff`` with ``devices`` permission — only
      devices assigned to their school.  Used for "is our scanner online"
      / "edit the scanner's location label" without needing higher roles.
    """
    role = user_data.get("role")
    query = db.collection("devices")
    if role == "district_admin":
        did = user_data.get("district_id")
        if not did:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
        query = query.where(field_path="district_id", op_string="==", value=did)
    elif role in ("school_admin", "staff"):
        sid = user_data.get("school_id") or user_data.get("uid")
        query = query.where(field_path="school_id", op_string="==", value=sid)

    docs = list(query.stream())
    devices = [_serialise(doc.to_dict()) for doc in docs]
    devices.sort(key=lambda d: d.get("last_seen_at") or "", reverse=True)
    return {"devices": devices}


@router.get("/api/v1/devices/{hostname}")
def get_device(
    hostname: str,
    user_data: dict = Depends(require_devices_viewer),
):
    doc = db.collection("devices").document(hostname).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Device not found")
    data = doc.to_dict() or {}
    role = user_data.get("role")
    if role == "district_admin":
        if data.get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="Device is not in your district")
    elif role in ("school_admin", "staff"):
        own_school = user_data.get("school_id") or user_data.get("uid")
        if data.get("school_id") != own_school:
            raise HTTPException(status_code=403, detail="Device is not assigned to your school")
    return {"device": _serialise(data)}


@router.patch("/api/v1/devices/{hostname}")
def update_device(
    hostname: str,
    payload: DevicePatch,
    user_data: dict = Depends(require_devices_viewer),
):
    """Admin update.

    Role rules:
      * ``super_admin`` — may set ``location``, ``district_id``, and
        ``school_id``.  If ``district_id`` changes, ``school_id`` is
        cleared (the old school lived under the old district).
      * ``district_admin`` — may set ``location`` and ``school_id`` only,
        and only on devices already assigned to their district.  The chosen
        school must belong to their district.
      * ``school_admin`` / ``staff`` with ``devices`` permission — may set
        ``location`` only, and only on devices assigned to their school.
        They can't move a scanner to another school or change its district.
    """
    ref = db.collection("devices").document(hostname)
    snapshot = ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Device not found")

    existing = snapshot.to_dict() or {}
    role     = user_data.get("role")

    if role == "district_admin":
        if existing.get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="Device is not in your district")
        if payload.district_id is not None:
            raise HTTPException(status_code=403, detail="Only super admins can change a device's district")
    elif role in ("school_admin", "staff"):
        own_school = user_data.get("school_id") or user_data.get("uid")
        if existing.get("school_id") != own_school:
            raise HTTPException(status_code=403, detail="Device is not assigned to your school")
        if payload.district_id is not None or payload.school_id is not None:
            raise HTTPException(
                status_code=403,
                detail="Only district/platform admins can reassign a device's district or school",
            )

    update: dict = {}
    if payload.location is not None:
        update["location"] = payload.location.strip()

    # District reassignment (super_admin only).  Clearing or changing the
    # district invalidates the existing school_id because schools live
    # inside districts.
    if payload.district_id is not None:
        new_district = payload.district_id.strip()
        if new_district:
            ddoc = db.collection("districts").document(new_district).get()
            if not ddoc.exists:
                raise HTTPException(status_code=400, detail="Unknown district_id")
            update["district_id"] = new_district
        else:
            update["district_id"] = None
        if update["district_id"] != existing.get("district_id"):
            update["school_id"] = None

    # School assignment — must match the device's (new or existing) district.
    if payload.school_id is not None:
        new_school = payload.school_id.strip()
        if new_school:
            school_doc = db.collection("schools").document(new_school).get()
            if not school_doc.exists:
                raise HTTPException(status_code=400, detail="Unknown school_id")
            school_data = school_doc.to_dict() or {}
            effective_district = update.get("district_id", existing.get("district_id"))
            if not effective_district:
                raise HTTPException(
                    status_code=400,
                    detail="Assign the device to a district before picking a school",
                )
            if school_data.get("district_id") != effective_district:
                raise HTTPException(
                    status_code=400,
                    detail="School is not in this device's district",
                )
            update["school_id"] = new_school
        else:
            update["school_id"] = None

    if not update:
        raise HTTPException(status_code=400, detail="No updatable fields provided")

    update["updated_at"] = _iso_now()
    ref.update(update)
    logger.info("Device updated: hostname=%s fields=%s by=%s", hostname, list(update.keys()), user_data.get("uid"))

    # Audit: separate "school/district re-assignment" from "location
    # label only" — the first reshapes where scans land, the second is a
    # cosmetic relabel.  Consumers of the log can filter on action name.
    touched_assignment = any(k in update for k in ("district_id", "school_id"))
    action = "device.assigned" if touched_assignment else "device.location.changed"
    before = {k: existing.get(k) for k in update.keys() if k != "updated_at"}
    after  = {k: v for k, v in update.items() if k != "updated_at"}
    from core.audit import log_event as _audit_log
    _audit_log(
        action=action,
        actor=user_data,
        target={"type": "device", "id": hostname, "display_name": hostname},
        diff={"before": before, "after": after},
        severity="warning" if touched_assignment else "info",
        school_id=update.get("school_id", existing.get("school_id")),
        district_id=update.get("district_id", existing.get("district_id")),
        message=(
            f"Device re-assigned ({', '.join(k for k in update.keys() if k != 'updated_at')})"
            if touched_assignment
            else f"Device location label → {update.get('location')}"
        ),
    )
    return {"device": _serialise({**existing, **update})}
