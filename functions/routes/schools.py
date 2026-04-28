"""School management (super_admin) and enrollment code lookup routes."""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from zoneinfo import ZoneInfo

from config import DEV_SCHOOL_ID, DEVICE_TIMEZONE, ENV
from core.audit import log_event as audit_log
from core.auth import (
    require_super_admin,
    require_super_or_district_admin,
    verify_firebase_token,
)
from core.firebase import db
from core.utils import _generate_enrollment_code
from models.schemas import CreateSchoolRequest, UpdateSchoolRequest

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/admin/schools")
def list_schools(
    district_id: str = Query(default=None),
    user_data: dict = Depends(require_super_or_district_admin),
):
    """List schools, optionally filtered by district.

    * ``super_admin`` with no filter — all schools.
    * ``super_admin`` with ``?district_id=X`` — just that district's schools.
    * ``district_admin`` — forced to their own district (filter ignored if
      it doesn't match).
    """
    role = user_data.get("role")
    query = db.collection("schools")

    effective_district: str | None = None
    if role == "district_admin":
        effective_district = user_data.get("district_id")
        if not effective_district:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
    elif district_id:
        effective_district = district_id

    if effective_district:
        query = query.where(field_path="district_id", op_string="==", value=effective_district)

    docs = list(query.stream())
    schools = []
    for doc in docs:
        data = doc.to_dict()
        val = data.get("created_at")
        if val is not None and hasattr(val, "isoformat"):
            data["created_at"] = val.isoformat()
        data["id"] = doc.id
        schools.append(data)
    schools.sort(key=lambda s: (s.get("name") or "").lower())
    return {"schools": schools, "total": len(schools)}


@router.post("/api/v1/admin/schools", status_code=201)
def create_school(
    body: CreateSchoolRequest,
    user_data: dict = Depends(require_super_or_district_admin),
):
    """Create a school inside a district.  District admins can only add
    schools to their own district; super admins can add to any."""
    role = user_data.get("role")
    district_id = (body.district_id or "").strip()
    if role == "district_admin":
        if district_id and district_id != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="Cannot create a school in another district")
        district_id = user_data.get("district_id")
        if not district_id:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
    if not district_id:
        raise HTTPException(status_code=400, detail="district_id is required")
    district_doc = db.collection("districts").document(district_id).get()
    if not district_doc.exists:
        raise HTTPException(status_code=400, detail="Unknown district_id")

    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "name": body.name, "district_id": district_id,
        "admin_email": body.admin_email, "timezone": body.timezone,
        "status": "active", "is_licensed": body.is_licensed, "license_tier": body.license_tier,
        "license_expires_at": body.license_expires_at, "address": body.address,
        "phone": body.phone, "website": body.website, "notes": body.notes,
        "enrollment_code": _generate_enrollment_code(), "created_at": now, "created_by": user_data["uid"],
    }
    _, new_ref = db.collection("schools").add(record)
    audit_log(
        action="school.created",
        actor=user_data,
        target={"type": "school", "id": new_ref.id, "display_name": body.name},
        diff={"district_id": district_id, "timezone": body.timezone, "is_licensed": body.is_licensed},
        severity="warning",
        school_id=new_ref.id,
        district_id=district_id,
        message=f"School '{body.name}' created",
    )
    return {"id": new_ref.id, **record, "created_at": now.isoformat()}


@router.patch("/api/v1/admin/schools/{school_id}")
def update_school(
    school_id: str,
    body: UpdateSchoolRequest,
    user_data: dict = Depends(require_super_or_district_admin),
):
    doc_ref = db.collection("schools").document(school_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="School not found")
    # District admins can only touch schools in their own district and
    # cannot move a school out of it.
    existing = snap.to_dict() or {}
    role = user_data.get("role")
    if role == "district_admin":
        if existing.get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="School is not in your district")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "district_id" in updates and role == "district_admin":
        raise HTTPException(status_code=403, detail="Only super admins can reassign districts")
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    before = {k: existing.get(k) for k in updates.keys()}
    doc_ref.update(updates)
    is_status_change = "status" in updates and before.get("status") != updates["status"]
    audit_log(
        action="school.status.changed" if is_status_change else "school.updated",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": existing.get("name", school_id)},
        diff={"before": before, "after": updates},
        severity="warning" if is_status_change else "info",
        school_id=school_id,
        district_id=existing.get("district_id"),
        message=(
            f"Status changed: {before.get('status')} → {updates['status']}"
            if is_status_change else f"School updated ({', '.join(updates.keys())})"
        ),
    )
    return {"id": school_id, **updates}


@router.get("/api/v1/admin/schools/{school_id}/stats")
def school_stats(
    school_id: str,
    user_data: dict = Depends(require_super_or_district_admin),
):
    if user_data.get("role") == "district_admin":
        snap = db.collection("schools").document(school_id).get()
        if not snap.exists or (snap.to_dict() or {}).get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="School is not in your district")
    return {
        "school_id": school_id,
        "plates":  len(list(db.collection("plates").where(field_path="school_id", op_string="==", value=school_id).stream())),
        "users":   len(list(db.collection("school_admins").where(field_path="school_id", op_string="==", value=school_id).stream())),
        "scans":   len(list(db.collection("plate_scans").where(field_path="school_id", op_string="==", value=school_id).stream())),
        "devices": len(list(db.collection("devices").where(field_path="school_id", op_string="==", value=school_id).stream())),
    }


@router.get("/api/v1/schools/lookup")
def lookup_school_by_code(code: str = Query(...), user_data: dict = Depends(verify_firebase_token)):
    code = code.strip().upper()
    if ENV == "development":
        return {"id": DEV_SCHOOL_ID, "name": "Development School"}
    docs = list(db.collection("schools").where(field_path="enrollment_code", op_string="==", value=code).limit(1).stream())
    if not docs:
        raise HTTPException(status_code=404, detail="Invalid enrollment code")
    data = docs[0].to_dict()
    if data.get("status") == "suspended":
        raise HTTPException(status_code=403, detail="School is currently suspended")
    return {"id": docs[0].id, "name": data.get("name", "")}
