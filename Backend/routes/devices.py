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

from core.auth import require_scanner, require_super_admin, verify_firebase_token
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


def _serialise(doc_data: dict) -> dict:
    """Convert a Firestore doc dict into the shape returned by the API."""
    data = dict(doc_data)
    data["status"] = _derive_status(data.get("last_seen_at"))
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
def list_devices(user_data: dict = Depends(require_super_admin)):
    """List all registered devices, newest heartbeat first."""
    docs = db.collection("devices").stream()
    devices = [_serialise(doc.to_dict()) for doc in docs]
    devices.sort(key=lambda d: d.get("last_seen_at") or "", reverse=True)
    return {"devices": devices}


@router.get("/api/v1/devices/{hostname}")
def get_device(
    hostname: str,
    user_data: dict = Depends(require_super_admin),
):
    doc = db.collection("devices").document(hostname).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"device": _serialise(doc.to_dict())}


@router.patch("/api/v1/devices/{hostname}")
def update_device(
    hostname: str,
    payload: DevicePatch,
    user_data: dict = Depends(require_super_admin),
):
    """Admin update — currently only ``location`` is editable."""
    ref = db.collection("devices").document(hostname)
    snapshot = ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Device not found")

    update: dict = {}
    if payload.location is not None:
        update["location"] = payload.location.strip()
    if not update:
        raise HTTPException(status_code=400, detail="No updatable fields provided")

    update["updated_at"] = _iso_now()
    ref.update(update)
    logger.info("Device updated: hostname=%s fields=%s", hostname, list(update.keys()))
    return {"device": _serialise({**snapshot.to_dict(), **update})}
