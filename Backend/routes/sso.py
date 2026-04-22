"""
routes/sso.py — SSO domain → role/school auto-provisioning.

Google and Microsoft as federated sign-in methods are configured once in
Firebase Console (Authentication → Sign-in method); that's the
authoritative on/off switch and there's no in-app provider toggle to
shadow it.  What lives here is the mapping that says "when an email
at ``@district.edu`` signs in via SSO for the first time, provision
them as staff at Lincoln Elementary" — read by
``core.auth.verify_firebase_token``.

Firestore layout::

    sso_domain_mappings/{domain}             # doc id = lower-cased domain
        domain, district_id, provider,
        default_role ("staff" | "school_admin"),
        default_school_id (nullable),
        created_by_uid, created_at, updated_at

Access rules:

* ``super_admin`` — full CRUD on any domain mapping.  Can assign
  ``default_role=school_admin``.
* ``district_admin`` — can create/update/delete mappings that belong to
  their district only; can NOT set ``default_role=school_admin`` (capped
  at ``staff``) because granting admin rights is a platform-level decision.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from core.auth import require_super_or_district_admin
from core.firebase import db
from models.schemas import (
    SsoDomainMappingCreate,
    SsoDomainMappingUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialise_mapping(doc) -> dict:
    data = doc.to_dict() or {}
    data["domain"] = doc.id
    for field in ("created_at", "updated_at"):
        val = data.get(field)
        if val is not None and hasattr(val, "isoformat"):
            data[field] = val.isoformat()
    return data


# ---------------------------------------------------------------------------
# Domain → role/school mappings
# ---------------------------------------------------------------------------

@router.get("/api/v1/admin/sso/domains")
def list_sso_domain_mappings(
    user_data: dict = Depends(require_super_or_district_admin),
):
    """super_admin sees all mappings; district_admin sees only mappings
    that point at their district."""
    role = user_data.get("role")
    col = db.collection("sso_domain_mappings")
    if role == "district_admin":
        did = user_data.get("district_id")
        if not did:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
        docs = list(col.where(field_path="district_id", op_string="==", value=did).stream())
    else:
        docs = list(col.stream())
    mappings = [_serialise_mapping(d) for d in docs]
    mappings.sort(key=lambda m: m.get("domain", ""))
    return {"mappings": mappings, "total": len(mappings)}


@router.post("/api/v1/admin/sso/domains", status_code=201)
def create_sso_domain_mapping(
    body: SsoDomainMappingCreate,
    user_data: dict = Depends(require_super_or_district_admin),
):
    # District admins can only map domains to their OWN district; they
    # also cannot grant the ``school_admin`` role via SSO (that's a
    # super_admin-only action).
    if user_data.get("role") == "district_admin":
        if body.district_id != user_data.get("district_id"):
            raise HTTPException(
                status_code=403,
                detail="District admins can only map domains to their own district.",
            )
        if body.default_role == "school_admin":
            raise HTTPException(
                status_code=403,
                detail="Only a platform admin can grant the 'school_admin' role via SSO.",
            )

    district_ref = db.collection("districts").document(body.district_id)
    if not district_ref.get().exists:
        raise HTTPException(status_code=404, detail="District not found")

    if body.default_school_id:
        school_doc = db.collection("schools").document(body.default_school_id).get()
        if not school_doc.exists:
            raise HTTPException(status_code=404, detail="default_school_id does not exist")
        if (school_doc.to_dict() or {}).get("district_id") != body.district_id:
            raise HTTPException(
                status_code=400,
                detail="default_school_id must belong to the target district.",
            )

    ref = db.collection("sso_domain_mappings").document(body.domain)
    if ref.get().exists:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Domain '{body.domain}' is already mapped.  Delete the existing "
                "mapping first or PATCH it to change its settings."
            ),
        )

    now = datetime.now(timezone.utc)
    record = {
        "district_id":       body.district_id,
        "provider":          body.provider,
        "default_role":      body.default_role,
        "default_school_id": body.default_school_id,
        "created_by_uid":    user_data.get("uid"),
        "created_at":        now,
        "updated_at":        now,
    }
    ref.set(record)
    logger.info(
        "SSO domain mapping created: domain=%s district=%s role=%s by=%s",
        body.domain, body.district_id, body.default_role, user_data.get("uid"),
    )
    return _serialise_mapping(ref.get())


@router.patch("/api/v1/admin/sso/domains/{domain}")
def update_sso_domain_mapping(
    domain: str,
    body: SsoDomainMappingUpdate,
    user_data: dict = Depends(require_super_or_district_admin),
):
    domain = (domain or "").strip().lower()
    ref = db.collection("sso_domain_mappings").document(domain)
    existing = ref.get()
    if not existing.exists:
        raise HTTPException(status_code=404, detail="Domain mapping not found")
    current = existing.to_dict() or {}

    # District admins can only touch their own mappings.
    if user_data.get("role") == "district_admin":
        if current.get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="Not your district's mapping")
        if body.default_role == "school_admin":
            raise HTTPException(
                status_code=403,
                detail="Only a platform admin can grant the 'school_admin' role via SSO.",
            )

    updates: dict = {}
    payload = body.model_dump(exclude_unset=True)
    for key, val in payload.items():
        if val is not None or key == "default_school_id":
            updates[key] = val

    if "default_school_id" in updates and updates["default_school_id"]:
        school_doc = db.collection("schools").document(updates["default_school_id"]).get()
        if not school_doc.exists:
            raise HTTPException(status_code=404, detail="default_school_id does not exist")
        if (school_doc.to_dict() or {}).get("district_id") != current.get("district_id"):
            raise HTTPException(
                status_code=400,
                detail="default_school_id must belong to this mapping's district.",
            )

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"]    = datetime.now(timezone.utc)
    updates["updated_by_uid"] = user_data.get("uid")
    ref.update(updates)
    logger.info("SSO domain mapping updated: domain=%s fields=%s", domain, list(updates.keys()))
    return _serialise_mapping(ref.get())


@router.delete("/api/v1/admin/sso/domains/{domain}")
def delete_sso_domain_mapping(
    domain: str,
    user_data: dict = Depends(require_super_or_district_admin),
):
    domain = (domain or "").strip().lower()
    ref = db.collection("sso_domain_mappings").document(domain)
    existing = ref.get()
    if not existing.exists:
        raise HTTPException(status_code=404, detail="Domain mapping not found")
    if user_data.get("role") == "district_admin":
        current = existing.to_dict() or {}
        if current.get("district_id") != user_data.get("district_id"):
            raise HTTPException(status_code=403, detail="Not your district's mapping")
    ref.delete()
    logger.info(
        "SSO domain mapping deleted: domain=%s by=%s",
        domain, user_data.get("uid"),
    )
    return {"status": "deleted", "domain": domain}
