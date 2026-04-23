"""Admin routes: student and guardian management."""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from google.cloud import firestore as _fs

from core.audit import log_event as audit_log
from core.auth import _get_admin_school_ids, _get_user_permissions, require_school_admin, verify_firebase_token
from core.firebase import db
from models.schemas import AdminLinkStudentRequest, AssignSchoolRequest, GuardianProfileUpdate
from secure_lookup import safe_decrypt

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_guardians_read(user_data: dict) -> None:
    """Allow super/district/school admins unconditionally; allow staff
    only when their school has toggled the `guardians` permission on.

    This is the minimal view-side gate for the guardians/guardians_edit
    split — all mutating endpoints in this file stay on
    `require_school_admin`, so staff cannot mutate even with the
    permission, matching the frontend's `guardians_edit` gate.
    """
    role = user_data.get("role")
    if role in ("super_admin", "district_admin", "school_admin"):
        return
    if role == "staff":
        school_id = user_data.get("school_id")
        perms = _get_user_permissions(role, school_id) if school_id else {}
        if perms.get("guardians"):
            return
    raise HTTPException(status_code=403, detail="Not authorised to view guardians")


@router.get("/api/v1/admin/students")
def admin_list_students(user_data: dict = Depends(require_school_admin)):
    all_school_ids = _get_admin_school_ids(user_data)
    docs = []
    for sid in all_school_ids:
        docs.extend(list(db.collection("students").where(field_path="school_id", op_string="==", value=sid).stream()))
    guardian_uids = {d.to_dict().get("guardian_uid") for d in docs if d.to_dict().get("guardian_uid")}
    guardian_map = {}
    for gid in guardian_uids:
        if not gid:
            continue
        gdoc = db.collection("guardians").document(gid).get()
        if gdoc.exists:
            gdata = gdoc.to_dict()
            guardian_map[gid] = {"uid": gid, "display_name": gdata.get("display_name", ""), "email": gdata.get("email", "")}
    students = []
    for doc in docs:
        data = doc.to_dict()
        gid = data.get("guardian_uid")
        students.append({"id": doc.id, "first_name": safe_decrypt(data.get("first_name_encrypted"), default=""), "last_name": safe_decrypt(data.get("last_name_encrypted"), default=""), "grade": data.get("grade"), "photo_url": data.get("photo_url"), "status": data.get("status", "active"), "guardian": guardian_map.get(gid) if gid else None, "claimed_at": data.get("claimed_at"), "created_at": data.get("created_at")})
    students.sort(key=lambda s: f"{s['last_name']} {s['first_name']}".lower())
    return {"students": students, "total": len(students)}


@router.post("/api/v1/admin/students/{student_id}/unlink")
def admin_unlink_student(student_id: str, user_data: dict = Depends(require_school_admin)):
    school_id = user_data["school_id"]
    doc_ref = db.collection("students").document(student_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Student not found")
    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="Student does not belong to this school")
    old_guardian_uid = data.get("guardian_uid")
    if not old_guardian_uid:
        raise HTTPException(status_code=400, detail="Student is already unlinked")
    for vdoc in db.collection("vehicles").where(field_path="guardian_uid", op_string="==", value=old_guardian_uid).stream():
        vdata = vdoc.to_dict()
        sids = vdata.get("student_ids", [])
        if student_id in sids:
            sids.remove(student_id)
            db.collection("vehicles").document(vdoc.id).update({"student_ids": sids})
    doc_ref.update({"guardian_uid": None, "status": "unlinked", "unlinked_at": datetime.now(timezone.utc).isoformat(), "unlinked_by": user_data["uid"]})
    audit_log(
        action="student.unlinked",
        actor=user_data,
        target={"type": "student", "id": student_id, "display_name": student_id},
        diff={"previous_guardian_uid": old_guardian_uid},
        severity="warning",
        school_id=data.get("school_id"),
        message="Student unlinked from guardian",
    )
    return {"status": "unlinked", "id": student_id, "previous_guardian_uid": old_guardian_uid}


@router.post("/api/v1/admin/students/{student_id}/link")
def admin_link_student(student_id: str, body: AdminLinkStudentRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data["school_id"]
    doc_ref = db.collection("students").document(student_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Student not found")
    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="Student does not belong to this school")
    if data.get("status") == "active" and data.get("guardian_uid"):
        raise HTTPException(status_code=409, detail="Student is already linked to a guardian. Unlink first.")
    guardian_docs = list(db.collection("guardians").where(field_path="email", op_string="==", value=body.guardian_email).limit(1).stream())
    if not guardian_docs:
        raise HTTPException(status_code=404, detail="No guardian account found with that email")
    guardian_uid = guardian_docs[0].id
    guardian_data = guardian_docs[0].to_dict()
    doc_ref.update({"guardian_uid": guardian_uid, "status": "active", "claimed_at": datetime.now(timezone.utc).isoformat(), "linked_by": user_data["uid"]})
    audit_log(
        action="student.linked",
        actor=user_data,
        target={"type": "student", "id": student_id, "display_name": student_id},
        diff={"guardian_uid": guardian_uid, "guardian_email": guardian_data.get("email")},
        school_id=data.get("school_id"),
        message=f"Student linked to {guardian_data.get('email','guardian')}",
    )
    return {"status": "linked", "id": student_id, "guardian": {"uid": guardian_uid, "display_name": guardian_data.get("display_name", ""), "email": guardian_data.get("email", "")}}


@router.get("/api/v1/admin/guardians")
def admin_list_guardians(user_data: dict = Depends(verify_firebase_token), search: Optional[str] = Query(default=None)):
    _require_guardians_read(user_data)
    all_school_ids = _get_admin_school_ids(user_data)
    search_raw = (search or "").strip()
    search_lower = search_raw.lower()
    student_docs = []
    for sid in all_school_ids:
        student_docs.extend(list(db.collection("students").where(field_path="school_id", op_string="==", value=sid).stream()))
    guardian_uids: set = {d.to_dict().get("guardian_uid") for d in student_docs if d.to_dict().get("guardian_uid")}
    guardian_docs_cache: dict = {}

    def _remember(gid, gdoc):
        if gid and gid not in guardian_docs_cache and gdoc is not None:
            guardian_docs_cache[gid] = gdoc

    for sid in all_school_ids:
        try:
            for doc in db.collection("guardians").where(field_path="assigned_school_ids", op_string="array_contains", value=sid).stream():
                guardian_uids.add(doc.id)
                _remember(doc.id, doc)
        except Exception as exc:
            logger.warning("assigned_school_ids query failed for school %s: %s", sid, exc)
    try:
        try:
            pending_stream = db.collection("guardians").order_by("created_at", direction=_fs.Query.DESCENDING).limit(500).stream()
        except Exception:
            pending_stream = db.collection("guardians").limit(500).stream()
        for doc in pending_stream:
            gdata = doc.to_dict() or {}
            if not gdata.get("assigned_school_ids"):
                guardian_uids.add(doc.id)
                _remember(doc.id, doc)
    except Exception as exc:
        logger.warning("Pending-guardian scan failed: %s", exc)
    if search_raw:
        for query_field in ("email_lower", "email"):
            try:
                for doc in db.collection("guardians").where(field_path=query_field, op_string="==", value=search_lower).stream():
                    guardian_uids.add(doc.id)
                    _remember(doc.id, doc)
            except Exception:
                pass
    guardians = []
    for gid in guardian_uids:
        if not gid:
            continue
        gdoc = guardian_docs_cache.get(gid) or db.collection("guardians").document(gid).get()
        if not getattr(gdoc, "exists", False):
            continue
        gdata = gdoc.to_dict() or {}
        child_count = sum(1 for d in student_docs if d.to_dict().get("guardian_uid") == gid)
        assigned_school_ids = gdata.get("assigned_school_ids") or []
        assigned_schools = []
        for sid in assigned_school_ids:
            sdoc = db.collection("schools").document(sid).get()
            assigned_schools.append({"id": sid, "name": sdoc.to_dict().get("name", "") if sdoc.exists else "(deleted school)"})
        guardians.append({"uid": gid, "display_name": gdata.get("display_name", ""), "email": gdata.get("email", ""), "phone": gdata.get("phone"), "child_count": child_count, "assigned_schools": assigned_schools, "assigned_school_ids": assigned_school_ids, "is_pending": not assigned_school_ids and child_count == 0, "created_at": gdata.get("created_at")})
    if search_raw:
        guardians = [g for g in guardians if search_lower in f"{g.get('display_name','')} {g.get('email','')}".lower()]
    guardians.sort(key=lambda g: (0 if g["is_pending"] else 1, (g.get("display_name") or g.get("email") or "").lower()))
    return {"guardians": guardians, "total": len(guardians)}


@router.post("/api/v1/admin/guardians/{guardian_uid}/schools")
def admin_assign_school_to_guardian(guardian_uid: str, body: AssignSchoolRequest, user_data: dict = Depends(require_school_admin)):
    admin_school_id = user_data["school_id"]
    target_school_id = body.school_id.strip()
    if user_data.get("role") != "super_admin" and target_school_id != admin_school_id:
        raise HTTPException(status_code=403, detail="You can only assign guardians to your own school")
    school_doc = db.collection("schools").document(target_school_id).get()
    if not school_doc.exists:
        raise HTTPException(status_code=404, detail="School not found")
    guardian_ref = db.collection("guardians").document(guardian_uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")
    assigned = guardian_doc.to_dict().get("assigned_school_ids", [])
    if target_school_id in assigned:
        raise HTTPException(status_code=409, detail="School is already assigned to this guardian")
    assigned.append(target_school_id)
    guardian_ref.update({"assigned_school_ids": assigned})
    audit_log(
        action="guardian.school.assigned",
        actor=user_data,
        target={
            "type": "guardian",
            "id": guardian_uid,
            "display_name": guardian_doc.to_dict().get("email", guardian_uid),
        },
        diff={"school_id": target_school_id, "school_name": school_doc.to_dict().get("name", "")},
        school_id=target_school_id,
        message=f"Guardian approved for {school_doc.to_dict().get('name', target_school_id)}",
    )
    return {"status": "assigned", "guardian_uid": guardian_uid, "school_id": target_school_id, "school_name": school_doc.to_dict().get("name", ""), "assigned_school_ids": assigned}


@router.delete("/api/v1/admin/guardians/{guardian_uid}/schools/{school_id}")
def admin_remove_school_from_guardian(guardian_uid: str, school_id: str, user_data: dict = Depends(require_school_admin)):
    admin_school_id = user_data["school_id"]
    if user_data.get("role") != "super_admin" and school_id != admin_school_id:
        raise HTTPException(status_code=403, detail="You can only remove your own school from a guardian")
    guardian_ref = db.collection("guardians").document(guardian_uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")
    assigned = guardian_doc.to_dict().get("assigned_school_ids", [])
    if school_id not in assigned:
        raise HTTPException(status_code=404, detail="School is not assigned to this guardian")
    assigned.remove(school_id)
    guardian_ref.update({"assigned_school_ids": assigned})
    audit_log(
        action="guardian.school.removed",
        actor=user_data,
        target={
            "type": "guardian",
            "id": guardian_uid,
            "display_name": guardian_doc.to_dict().get("email", guardian_uid),
        },
        diff={"removed_school_id": school_id},
        severity="warning",
        school_id=school_id,
        message=f"Guardian removed from school {school_id}",
    )
    return {"status": "removed", "guardian_uid": guardian_uid, "school_id": school_id, "assigned_school_ids": assigned}


def _assert_admin_can_access_guardian(user_data: dict, guardian_data: dict) -> None:
    """Raise 403 unless this admin has at least one school in common with the guardian,
    or the guardian is still unassigned (pending) and therefore visible to any admin
    (matches the Guardians list behavior). Super admins bypass the check."""
    if user_data.get("role") == "super_admin":
        return
    admin_school_ids = set(_get_admin_school_ids(user_data) or [])
    guardian_school_ids = set(guardian_data.get("assigned_school_ids") or [])
    if not guardian_school_ids:
        return  # pending guardian — visible like in the list view
    if not (admin_school_ids & guardian_school_ids):
        raise HTTPException(status_code=403, detail="You cannot access this guardian")


@router.get("/api/v1/admin/guardians/{guardian_uid}/detail")
def admin_guardian_detail(guardian_uid: str, user_data: dict = Depends(verify_firebase_token)):
    _require_guardians_read(user_data)
    guardian_doc = db.collection("guardians").document(guardian_uid).get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")
    gdata = guardian_doc.to_dict() or {}
    _assert_admin_can_access_guardian(user_data, gdata)

    # Resolve assigned schools to {id, name} pairs
    assigned_school_ids = gdata.get("assigned_school_ids") or []
    assigned_schools = []
    for sid in assigned_school_ids:
        sdoc = db.collection("schools").document(sid).get()
        assigned_schools.append({
            "id": sid,
            "name": sdoc.to_dict().get("name", "") if sdoc.exists else "(deleted school)",
        })

    # Children this guardian is linked to
    children = []
    for doc in db.collection("students").where(field_path="guardian_uid", op_string="==", value=guardian_uid).stream():
        cdata = doc.to_dict() or {}
        children.append({
            "id": doc.id,
            "first_name": safe_decrypt(cdata.get("first_name_encrypted"), default=""),
            "last_name": safe_decrypt(cdata.get("last_name_encrypted"), default=""),
            "grade": cdata.get("grade"),
            "school_id": cdata.get("school_id"),
            "school_name": cdata.get("school_name", ""),
            "photo_url": cdata.get("photo_url"),
        })
    children.sort(key=lambda c: f"{c['last_name']} {c['first_name']}".lower())

    # Vehicles registered to this guardian
    vehicles = []
    for doc in db.collection("vehicles").where(field_path="guardian_uid", op_string="==", value=guardian_uid).stream():
        vdata = doc.to_dict() or {}
        vehicles.append({
            "id": doc.id,
            "plate_number": safe_decrypt(vdata.get("plate_number_encrypted"), default=""),
            "make": vdata.get("make"),
            "model": vdata.get("model"),
            "color": vdata.get("color"),
            "year": vdata.get("year"),
            "photo_url": vdata.get("photo_url"),
            "student_ids": vdata.get("student_ids", []),
            "school_ids": vdata.get("school_ids", []),
        })

    # Authorized pickups live as an array on the guardian doc
    authorized_pickups = gdata.get("authorized_pickups") or []

    return {
        "profile": {
            "uid": guardian_uid,
            "display_name": gdata.get("display_name", ""),
            "email": gdata.get("email", ""),
            "phone": gdata.get("phone"),
            "photo_url": gdata.get("photo_url"),
            "created_at": gdata.get("created_at"),
        },
        "assigned_schools": assigned_schools,
        "children": children,
        "vehicles": vehicles,
        "authorized_pickups": authorized_pickups,
    }


@router.patch("/api/v1/admin/guardians/{guardian_uid}/profile")
def admin_update_guardian_profile(
    guardian_uid: str,
    body: GuardianProfileUpdate,
    user_data: dict = Depends(require_school_admin),
):
    guardian_ref = db.collection("guardians").document(guardian_uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")
    _assert_admin_can_access_guardian(user_data, guardian_doc.to_dict() or {})

    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name.strip()
    if "phone" in body.model_fields_set:
        updates["phone"] = body.phone
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    guardian_ref.update(updates)
    return {"status": "updated", "updated": list(updates.keys())}
