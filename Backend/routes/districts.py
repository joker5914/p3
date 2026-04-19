"""
routes/districts.py — district CRUD + stats.

Districts sit above schools in the org hierarchy.  Dismissal employees
(``super_admin``) create and license districts; once a district exists, a
customer-designated ``district_admin`` can see/manage all schools
("locations") inside that district, and ``super_admin`` can do the same
plus create new districts.

Firestore layout::

    districts/{district_id}
        name               str
        admin_email        str
        timezone           str
        status             "active" | "suspended"
        is_licensed        bool
        license_tier       str | None
        license_expires_at ISO str | None
        notes              str
        created_at         datetime
        created_by         uid

Schools gain a ``district_id`` field; see ``_ensure_default_district`` in
``main.py`` for the one-time backfill that runs on startup.
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE
from core.auth import require_super_admin, verify_firebase_token
from core.firebase import db
from models.schemas import CreateDistrictRequest, UpdateDistrictRequest

logger = logging.getLogger(__name__)

router = APIRouter()


def _serialise(doc) -> dict:
    """Convert a Firestore district doc into the API shape."""
    data = doc.to_dict() or {}
    data["id"] = doc.id
    for field in ("created_at",):
        val = data.get(field)
        if val is not None and hasattr(val, "isoformat"):
            data[field] = val.isoformat()
    return data


# ---------------------------------------------------------------------------
# List / read
# ---------------------------------------------------------------------------

@router.get("/api/v1/admin/districts")
def list_districts(user_data: dict = Depends(verify_firebase_token)):
    """List districts.

    * ``super_admin`` — all districts, sorted by name.
    * ``district_admin`` — only the district they belong to.
    * Anyone else — 403.
    """
    role = user_data.get("role")
    if role == "super_admin":
        docs = list(db.collection("districts").stream())
    elif role == "district_admin":
        did = user_data.get("district_id")
        if not did:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
        doc = db.collection("districts").document(did).get()
        docs = [doc] if doc.exists else []
    else:
        raise HTTPException(status_code=403, detail="District visibility requires admin role")

    districts = [_serialise(d) for d in docs]
    districts.sort(key=lambda r: (r.get("name") or "").lower())
    return {"districts": districts, "total": len(districts)}


@router.get("/api/v1/admin/districts/{district_id}")
def get_district(district_id: str, user_data: dict = Depends(verify_firebase_token)):
    _assert_can_read_district(user_data, district_id)
    doc = db.collection("districts").document(district_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="District not found")
    return {"district": _serialise(doc)}


@router.get("/api/v1/admin/districts/{district_id}/stats")
def district_stats(district_id: str, user_data: dict = Depends(verify_firebase_token)):
    """Roll up counts across all schools inside this district."""
    _assert_can_read_district(user_data, district_id)

    school_docs = list(
        db.collection("schools")
        .where(field_path="district_id", op_string="==", value=district_id)
        .stream()
    )
    school_ids = [d.id for d in school_docs]
    locations = len(school_ids)

    plates = users = scans = 0
    for sid in school_ids:
        # Firestore has no cross-collection count; these are small lists per
        # school so the fan-out is fine for the platform admin view.  If it
        # ever matters we can maintain a counter document.
        plates += len(list(db.collection("plates").where(field_path="school_id", op_string="==", value=sid).stream()))
        users  += len(list(db.collection("school_admins").where(field_path="school_id", op_string="==", value=sid).stream()))
        scans  += len(list(db.collection("plate_scans").where(field_path="school_id", op_string="==", value=sid).stream()))

    return {
        "district_id": district_id,
        "locations": locations,
        "plates":    plates,
        "users":     users,
        "scans":     scans,
    }


# ---------------------------------------------------------------------------
# Create / update / delete  (super_admin only — per product spec)
# ---------------------------------------------------------------------------

@router.post("/api/v1/admin/districts", status_code=201)
def create_district(
    body: CreateDistrictRequest,
    user_data: dict = Depends(require_super_admin),
):
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "name":               body.name,
        "admin_email":        body.admin_email,
        "timezone":           body.timezone,
        "status":             "active",
        "is_licensed":        body.is_licensed,
        "license_tier":       body.license_tier,
        "license_expires_at": body.license_expires_at,
        "notes":              body.notes,
        "created_at":         now,
        "created_by":         user_data["uid"],
    }
    _ref = db.collection("districts").add(record)
    district_id = _ref[1].id
    logger.info("District created: id=%s name=%s by=%s", district_id, body.name, user_data.get("uid"))
    return {"id": district_id, **record, "created_at": now.isoformat()}


@router.patch("/api/v1/admin/districts/{district_id}")
def update_district(
    district_id: str,
    body: UpdateDistrictRequest,
    user_data: dict = Depends(require_super_admin),
):
    doc_ref = db.collection("districts").document(district_id)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="District not found")
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    doc_ref.update(updates)
    logger.info("District updated: id=%s fields=%s", district_id, list(updates.keys()))
    return {"id": district_id, **updates}


@router.delete("/api/v1/admin/districts/{district_id}")
def delete_district(district_id: str, user_data: dict = Depends(require_super_admin)):
    """Deletes a district only if no schools still reference it.  We don't
    cascade — a district with active locations is almost certainly someone
    else's production data."""
    child = list(
        db.collection("schools")
        .where(field_path="district_id", op_string="==", value=district_id)
        .limit(1)
        .stream()
    )
    if child:
        raise HTTPException(
            status_code=409,
            detail="District still has locations. Reassign or delete them first.",
        )
    ref = db.collection("districts").document(district_id)
    if not ref.get().exists:
        raise HTTPException(status_code=404, detail="District not found")
    ref.delete()
    logger.info("District deleted: id=%s by=%s", district_id, user_data.get("uid"))
    return {"status": "deleted", "id": district_id}


# ---------------------------------------------------------------------------
# Access helpers
# ---------------------------------------------------------------------------

def _assert_can_read_district(user_data: dict, district_id: str) -> None:
    role = user_data.get("role")
    if role == "super_admin":
        return
    if role == "district_admin" and user_data.get("district_id") == district_id:
        return
    raise HTTPException(status_code=403, detail="Not allowed to view this district")
