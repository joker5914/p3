"""School management (super_admin) and enrollment code lookup routes."""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from zoneinfo import ZoneInfo

from config import DEV_SCHOOL_ID, DEVICE_TIMEZONE, ENV
from core.auth import require_super_admin, verify_firebase_token
from core.firebase import db
from core.utils import _generate_enrollment_code
from models.schemas import CreateSchoolRequest, UpdateSchoolRequest

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/admin/schools")
def list_schools(user_data: dict = Depends(require_super_admin)):
    docs = list(db.collection("schools").stream())
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
def create_school(body: CreateSchoolRequest, user_data: dict = Depends(require_super_admin)):
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "name": body.name, "admin_email": body.admin_email, "timezone": body.timezone,
        "status": "active", "is_licensed": body.is_licensed, "license_tier": body.license_tier,
        "license_expires_at": body.license_expires_at, "address": body.address,
        "phone": body.phone, "website": body.website, "notes": body.notes,
        "enrollment_code": _generate_enrollment_code(), "created_at": now, "created_by": user_data["uid"],
    }
    _ref = db.collection("schools").add(record)
    return {"id": _ref[1].id, **record, "created_at": now.isoformat()}


@router.patch("/api/v1/admin/schools/{school_id}")
def update_school(school_id: str, body: UpdateSchoolRequest, user_data: dict = Depends(require_super_admin)):
    doc_ref = db.collection("schools").document(school_id)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="School not found")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    doc_ref.update(updates)
    return {"id": school_id, **updates}


@router.get("/api/v1/admin/schools/{school_id}/stats")
def school_stats(school_id: str, user_data: dict = Depends(require_super_admin)):
    return {
        "school_id": school_id,
        "plates": len(list(db.collection("plates").where(field_path="school_id", op_string="==", value=school_id).stream())),
        "users": len(list(db.collection("school_admins").where(field_path="school_id", op_string="==", value=school_id).stream())),
        "scans": len(list(db.collection("plate_scans").where(field_path="school_id", op_string="==", value=school_id).stream())),
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
