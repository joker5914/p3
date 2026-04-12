"""Site Settings endpoints for school_admin users.

Registered on the FastAPI app via `register_site_settings(app, db, ...)`
called from server.py at import time.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo
from permissions import provision_school_permissions
import secrets
import string
import os

router = APIRouter(prefix="/api/v1/site-settings", tags=["site-settings"])

DEVICE_TIMEZONE = os.getenv("DEVICE_TIMEZONE", "America/New_York")


def _generate_enrollment_code(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _require_school_admin():
    """Imported lazily from server to avoid circular imports."""
    from server import require_school_admin
    return require_school_admin


def _get_db():
    from server import db
    return db


@router.get("/schools")
def site_settings_list_schools(user_data: dict = Depends(_require_school_admin())):
    db = _get_db()
    schools = []
    for doc in db.collection("schools").stream():
        data = doc.to_dict()
        for field in ("created_at",):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()
        data["id"] = doc.id
        schools.append(data)
    schools.sort(key=lambda s: (s.get("name") or "").lower())
    return {"schools": schools, "total": len(schools)}


class SiteSettingsUpdateRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    admin_email: Optional[str] = None
    timezone: Optional[str] = None
    is_licensed: Optional[bool] = None
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v


class SiteSettingsCreateRequest(BaseModel):
    name: str
    admin_email: str = ""
    timezone: str = "America/New_York"
    is_licensed: bool = False
    license_tier: Optional[str] = None
    license_expires_at: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School name cannot be empty")
        return v


@router.post("/schools", status_code=201)
def site_settings_create_school(body: SiteSettingsCreateRequest, user_data: dict = Depends(_require_school_admin())):
    db = _get_db()
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "name": body.name, "admin_email": body.admin_email, "timezone": body.timezone,
        "status": "active", "is_licensed": body.is_licensed, "license_tier": body.license_tier,
        "license_expires_at": body.license_expires_at, "address": body.address,
        "phone": body.phone, "website": body.website, "notes": body.notes,
        "enrollment_code": _generate_enrollment_code(), "created_at": now, "created_by": user_data["uid"],
    }
    _ref = db.collection("schools").add(record)
    new_id = _ref[1].id
    # Auto-provision default permissions so Firestore rules find a document.
    provision_school_permissions(db, new_id)
    # Only set the admin's school_id if they don't already have one.
    # Overwriting it on every school creation caused all data scoped to the
    # previous school (guardians, students, vehicles) to disappear.
    admin_ref = db.collection("school_admins").document(user_data["uid"])
    admin_snap = admin_ref.get()
    if admin_snap.exists:
        existing_school_id = admin_snap.to_dict().get("school_id")
        if not existing_school_id:
            admin_ref.update({"school_id": new_id})
    else:
        admin_ref.set({"school_id": new_id})
    return {"id": new_id, **record, "created_at": now.isoformat()}


@router.patch("/schools/{school_id}")
def site_settings_update_school(school_id: str, body: SiteSettingsUpdateRequest, user_data: dict = Depends(_require_school_admin())):
    db = _get_db()
    doc_ref = db.collection("schools").document(school_id)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="School not found")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    doc_ref.update(updates)
    return {"id": school_id, **updates}


@router.delete("/schools/{school_id}")
def site_settings_delete_school(school_id: str, user_data: dict = Depends(_require_school_admin())):
    """Delete a school that has nothing associated with it (created in error)."""
    db = _get_db()
    doc_ref = db.collection("schools").document(school_id)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="School not found")

    # Check for associated students
    students = list(db.collection("students").where(
        field_path="school_id", op_string="==", value=school_id
    ).limit(1).stream())
    if students:
        raise HTTPException(status_code=409, detail="Cannot delete: this site has students associated with it.")

    # Check for guardians assigned to this school
    guardians = list(db.collection("guardians").where(
        field_path="assigned_school_ids", op_string="array_contains", value=school_id
    ).limit(1).stream())
    if guardians:
        raise HTTPException(status_code=409, detail="Cannot delete: guardians are assigned to this site.")

    # Check for admin users linked to this school
    admins = list(db.collection("school_admins").where(
        field_path="school_id", op_string="==", value=school_id
    ).limit(1).stream())
    if admins:
        raise HTTPException(status_code=409, detail="Cannot delete: admin/staff users are linked to this site.")

    # Check for legacy plate records
    plates = list(db.collection("plates").where(
        field_path="school_id", op_string="==", value=school_id
    ).limit(1).stream())
    if plates:
        raise HTTPException(status_code=409, detail="Cannot delete: plate records are associated with this site.")

    # Check for scan history
    scans = list(db.collection("plate_scans").where(
        field_path="school_id", op_string="==", value=school_id
    ).limit(1).stream())
    if scans:
        raise HTTPException(status_code=409, detail="Cannot delete: scan records are associated with this site.")

    # Safe to delete — also clean up school_permissions if present
    try:
        db.collection("school_permissions").document(school_id).delete()
    except Exception:
        pass  # No permissions doc is fine

    doc_ref.delete()
    return {"status": "deleted", "id": school_id}
