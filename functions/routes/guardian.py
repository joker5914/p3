"""Guardian portal: profile, children, vehicles, pickups, auth, and activity routes."""
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from firebase_admin import auth as fb_auth
from google.cloud import firestore as _fs

from config import DEV_SCHOOL_ID, ENV
from core.audit import log_event as audit_log
from core.auth import require_guardian, verify_firebase_token
from core.firebase import db
from models.schemas import (
    AddAuthorizedPickupRequest, AddChildRequest, AddVehicleRequest,
    DEFAULT_TEMP_VEHICLE_MAX_DAYS,
    GuardianProfileUpdate, GuardianSignupRequest, SessionStartRequest,
    UpdateAuthorizedPickupRequest, UpdateChildRequest, UpdateVehicleRequest,
    _parse_iso_date,
)
from secure_lookup import decrypt_string, encrypt_string, safe_decrypt, tokenize_plate, tokenize_student

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/auth/logout")
def logout(user_data: dict = Depends(verify_firebase_token)):
    audit_log(
        action="auth.signout",
        actor=user_data,
        message="User signed out",
    )
    return {"status": "logged out", "user": user_data["uid"]}


@router.post("/api/v1/auth/session-start")
def session_start(
    body: SessionStartRequest,
    user_data: dict = Depends(verify_firebase_token),
):
    """Fired by the frontend once on first ``onIdTokenChanged`` of a new
    session so we can record a clean sign-in event (with IP, UA, and the
    provider that minted the session) for the audit log.

    Backend-driven sign-in detection is unreliable — ``verify_firebase_token``
    is called on every request, so we'd need heuristics to decide "is this
    a new session?" vs. "is this a token refresh?".  The client knows for
    certain (onIdTokenChanged fires with a new uid on sign-in), so it tells
    us.

    Idempotent from the audit log's perspective: if the frontend fires
    this twice due to a reload, we get two events — which is accurate
    (the browser session really did start twice).  No-op on the user
    record itself; pure telemetry.
    """
    provider = body.provider or "unknown"
    audit_log(
        action="auth.signin.success",
        actor=user_data,
        message=f"Signed in via {provider}",
        diff={"provider": provider},
    )
    return {"status": "recorded", "uid": user_data.get("uid")}


@router.post("/api/v1/auth/guardian-signup", status_code=201)
def guardian_signup(body: GuardianSignupRequest):
    existing_user = None
    try:
        existing_user = fb_auth.get_user_by_email(body.email)
    except fb_auth.UserNotFoundError:
        pass
    except Exception:
        raise HTTPException(status_code=500, detail="Account creation failed")
    if existing_user:
        has_admin = has_guardian = False
        try:
            has_admin = db.collection("school_admins").document(existing_user.uid).get().exists
        except Exception:
            pass
        try:
            has_guardian = db.collection("guardians").document(existing_user.uid).get().exists
        except Exception:
            pass
        if has_admin or has_guardian:
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        try:
            fb_auth.delete_user(existing_user.uid)
        except Exception:
            raise HTTPException(status_code=500, detail="Account creation failed")
    try:
        user = fb_auth.create_user(email=body.email, password=body.password, display_name=body.display_name)
    except Exception:
        raise HTTPException(status_code=500, detail="Account creation failed")
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.collection("guardians").document(user.uid).set({"display_name": body.display_name, "email": body.email, "email_lower": body.email.lower(), "phone": None, "photo_url": None, "assigned_school_ids": [], "created_at": now})
    except Exception as exc:
        logger.warning("Failed to pre-create guardian profile uid=%s: %s", user.uid, exc)
    return {"status": "created", "uid": user.uid, "email": body.email, "display_name": body.display_name}


@router.get("/api/v1/benefactor/profile")
def get_guardian_profile(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc = db.collection("guardians").document(uid).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")
    data = doc.to_dict()
    return {"uid": uid, "display_name": data.get("display_name", ""), "email": data.get("email", ""), "phone": data.get("phone"), "photo_url": data.get("photo_url")}


@router.patch("/api/v1/benefactor/profile")
def update_guardian_profile(body: GuardianProfileUpdate, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name.strip()
    if "phone" in body.model_fields_set:
        updates["phone"] = body.phone
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    db.collection("guardians").document(uid).update(updates)
    return {"status": "updated", "updated": list(updates.keys())}


@router.get("/api/v1/benefactor/children")
def list_children(user_data: dict = Depends(require_guardian), school_id: Optional[str] = Query(None)):
    uid = user_data["uid"]
    query = db.collection("students").where(field_path="guardian_uid", op_string="==", value=uid)
    if school_id:
        query = query.where(field_path="school_id", op_string="==", value=school_id)
    docs = list(query.stream())
    children = [{"id": doc.id, "first_name": safe_decrypt(doc.to_dict().get("first_name_encrypted"), default=""), "last_name": safe_decrypt(doc.to_dict().get("last_name_encrypted"), default=""), "school_id": doc.to_dict().get("school_id"), "school_name": doc.to_dict().get("school_name", ""), "grade": doc.to_dict().get("grade"), "photo_url": doc.to_dict().get("photo_url")} for doc in docs]
    children.sort(key=lambda c: f"{c['first_name']} {c['last_name']}".lower())
    return {"children": children, "total": len(children)}


@router.post("/api/v1/benefactor/children", status_code=201)
def add_child(body: AddChildRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    school_id = body.school_id.strip()
    if ENV == "development":
        school_name = "Development School"
    else:
        school_doc = db.collection("schools").document(school_id).get()
        if not school_doc.exists:
            raise HTTPException(status_code=404, detail="School not found")
        school_data = school_doc.to_dict()
        if school_data.get("status") == "suspended":
            raise HTTPException(status_code=403, detail="School is currently suspended")
        school_name = school_data.get("name", "")
        guardian_doc = db.collection("guardians").document(uid).get()
        assigned_schools = guardian_doc.to_dict().get("assigned_school_ids", []) if guardian_doc.exists else []
        if school_id not in assigned_schools:
            raise HTTPException(status_code=403, detail="You are not authorized for this school.")
    student_token = tokenize_student(body.first_name, body.last_name, school_id)
    existing = list(db.collection("students").where(field_path="student_token", op_string="==", value=student_token).limit(1).stream())
    if existing:
        ex_data = existing[0].to_dict()
        ex_guardian = ex_data.get("guardian_uid")
        if ex_data.get("status", "active") == "active" and ex_guardian:
            if ex_guardian == uid:
                raise HTTPException(status_code=409, detail="This child is already on your account")
            raise HTTPException(status_code=409, detail="This student is already registered to another guardian.")
        doc_ref = db.collection("students").document(existing[0].id)
        updates = {"guardian_uid": uid, "status": "active", "claimed_at": datetime.now(timezone.utc).isoformat()}
        if body.grade is not None:
            updates["grade"] = body.grade
        if body.photo_url is not None:
            updates["photo_url"] = body.photo_url
        doc_ref.update(updates)
        return {"id": existing[0].id, "first_name": safe_decrypt(ex_data.get("first_name_encrypted"), default=body.first_name.strip()), "last_name": safe_decrypt(ex_data.get("last_name_encrypted"), default=body.last_name.strip()), "school_id": school_id, "school_name": ex_data.get("school_name", school_name), "grade": body.grade or ex_data.get("grade"), "photo_url": body.photo_url or ex_data.get("photo_url")}
    record = {"first_name_encrypted": encrypt_string(body.first_name.strip()), "last_name_encrypted": encrypt_string(body.last_name.strip()), "student_token": student_token, "school_id": school_id, "school_name": school_name, "grade": body.grade, "photo_url": body.photo_url, "guardian_uid": uid, "status": "active", "claimed_at": datetime.now(timezone.utc).isoformat(), "created_at": datetime.now(timezone.utc).isoformat()}
    _, doc_ref = db.collection("students").add(record)
    return {"id": doc_ref.id, "first_name": body.first_name.strip(), "last_name": body.last_name.strip(), "school_id": school_id, "school_name": school_name, "grade": body.grade, "photo_url": body.photo_url}


@router.patch("/api/v1/benefactor/children/{child_id}")
def update_child(child_id: str, body: UpdateChildRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("students").document(child_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Child not found")
    if body.first_name is not None or body.last_name is not None:
        raise HTTPException(status_code=403, detail="Name changes require school administrator approval.")
    updates = {}
    if "grade" in body.model_fields_set:
        updates["grade"] = body.grade
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    doc_ref.update(updates)
    return {"status": "updated", "id": child_id}


@router.delete("/api/v1/benefactor/children/{child_id}")
def remove_child(child_id: str, user_data: dict = Depends(require_guardian)):
    raise HTTPException(status_code=403, detail="Students can only be unlinked by a school administrator.")


def _temp_max_days_for_schools(school_ids: list) -> int:
    """Resolve the temporary-vehicle expiry cap a guardian can pick.

    A guardian can be enrolled at multiple campuses with different
    caps; we apply the *minimum* configured cap so the picker honours
    every school the vehicle would be visible at.  Falls back to
    ``DEFAULT_TEMP_VEHICLE_MAX_DAYS`` when no school overrides exist or
    the lookup fails (kept best-effort so a Firestore blip doesn't
    block a guardian from registering a temp vehicle entirely)."""
    cap = DEFAULT_TEMP_VEHICLE_MAX_DAYS
    for sid in school_ids or []:
        try:
            snap = db.collection("schools").document(sid).get()
            if not snap.exists:
                continue
            v = (snap.to_dict() or {}).get("temp_vehicle_max_days")
            if isinstance(v, (int, float)) and 1 <= int(v) <= 365:
                cap = min(cap, int(v))
        except Exception:
            continue
    return cap


def _validate_temp_window(valid_until: Optional[str], max_days: int) -> str:
    """Common gate for AddVehicle / UpdateVehicle when ``vehicle_type`` is
    ``temporary``.  Returns the normalised ``YYYY-MM-DD`` string.  Raises
    HTTPException(400) so FastAPI surfaces a friendly message."""
    from datetime import date as _date, timedelta
    if valid_until is None:
        raise HTTPException(status_code=400, detail="valid_until is required for temporary vehicles")
    try:
        target = _parse_iso_date(valid_until)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    today = _date.today()
    if target < today:
        raise HTTPException(status_code=400, detail="valid_until cannot be in the past")
    if target > today + timedelta(days=max_days):
        raise HTTPException(
            status_code=400,
            detail=f"Temporary vehicles cannot be valid for more than {max_days} days",
        )
    return target.isoformat()


def _vehicle_response(doc_id: str, data: dict) -> dict:
    """Common response shape for both LIST and POST.  Centralised so the
    new temp fields don't drift between endpoints."""
    return {
        "id":               doc_id,
        "plate_number":     safe_decrypt(data.get("plate_number_encrypted"), default=""),
        "make":             data.get("make"),
        "model":            data.get("model"),
        "color":            data.get("color"),
        "year":             data.get("year"),
        "photo_url":        data.get("photo_url"),
        "school_ids":       data.get("school_ids", []),
        "student_ids":      data.get("student_ids", []),
        "created_at":       data.get("created_at"),
        "vehicle_type":     data.get("vehicle_type") or "permanent",
        "valid_until":      data.get("valid_until"),
        "temporary_reason": data.get("temporary_reason"),
    }


@router.get("/api/v1/benefactor/vehicles")
def list_vehicles(user_data: dict = Depends(require_guardian), school_id: Optional[str] = Query(None)):
    uid = user_data["uid"]
    query = db.collection("vehicles").where(field_path="guardian_uid", op_string="==", value=uid)
    if school_id:
        query = query.where(field_path="school_ids", op_string="array_contains", value=school_id)
    docs = list(query.stream())
    vehicles = [_vehicle_response(doc.id, doc.to_dict() or {}) for doc in docs]
    # Surface the per-guardian effective cap so the portal's date picker
    # can constrain itself without a separate round-trip.  Computed from
    # the union of schools across all of this guardian's children.
    child_docs = list(db.collection("students").where(field_path="guardian_uid", op_string="==", value=uid).stream())
    all_school_ids = list({d.to_dict().get("school_id") for d in child_docs if d.to_dict().get("school_id")})
    return {
        "vehicles": vehicles,
        "total": len(vehicles),
        "temp_vehicle_max_days": _temp_max_days_for_schools(all_school_ids),
    }


@router.post("/api/v1/benefactor/vehicles", status_code=201)
def add_vehicle(body: AddVehicleRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    plate_token = tokenize_plate(body.plate_number)
    child_docs = list(db.collection("students").where(field_path="guardian_uid", op_string="==", value=uid).stream())
    school_ids = list({d.to_dict().get("school_id") for d in child_docs if d.to_dict().get("school_id")})
    student_ids = [d.id for d in child_docs]
    record = {
        "plate_number_encrypted": encrypt_string(body.plate_number),
        "plate_token":   plate_token,
        "make":          body.make,
        "model":         body.model,
        "color":         body.color,
        "year":          body.year,
        "photo_url":     body.photo_url,
        "guardian_uid":  uid,
        "school_ids":    school_ids,
        "student_ids":   student_ids,
        "created_at":    datetime.now(timezone.utc).isoformat(),
        "vehicle_type":  body.vehicle_type,
    }
    if body.vehicle_type == "temporary":
        cap = _temp_max_days_for_schools(school_ids)
        record["valid_until"]      = _validate_temp_window(body.valid_until, cap)
        record["temporary_reason"] = body.temporary_reason
        # Stamp the cap that was in force at write time so the expiry
        # sweep (and any audit reader) can reason about why this date
        # was accepted, even if the school later lowers the cap.
        record["temp_vehicle_max_days_at_create"] = cap
    _, doc_ref = db.collection("vehicles").add(record)

    if body.vehicle_type == "temporary":
        audit_log(
            action="vehicle.temporary.created",
            actor=user_data,
            target={"type": "vehicle", "id": doc_ref.id, "display_name": body.plate_number},
            diff={"valid_until": record["valid_until"], "reason": body.temporary_reason},
            message=(
                f"Temporary vehicle registered ({body.plate_number}), expires "
                f"{record['valid_until']}"
            ),
        )

    return _vehicle_response(doc_ref.id, record)


@router.patch("/api/v1/benefactor/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: str, body: UpdateVehicleRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("vehicles").document(vehicle_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    existing = doc.to_dict() or {}
    updates = {}
    if body.plate_number is not None:
        plate = body.plate_number.upper().strip()
        updates["plate_number_encrypted"] = encrypt_string(plate)
        updates["plate_token"] = tokenize_plate(plate)
    for field in ("make", "model", "color", "year"):
        val = getattr(body, field)
        if val is not None:
            updates[field] = val
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if body.student_ids is not None:
        updates["student_ids"] = body.student_ids

    # Type / expiry edits — supports flipping a vehicle between
    # permanent and temporary in either direction.  When the resulting
    # state is temporary we always re-validate the window (even if only
    # valid_until changed) so a stale cap from a previous create can't
    # carry forward past a reduced school cap.
    fset = body.model_fields_set
    new_type = body.vehicle_type if "vehicle_type" in fset else (existing.get("vehicle_type") or "permanent")

    type_or_expiry_touched = bool(fset & {"vehicle_type", "valid_until", "temporary_reason"})

    if type_or_expiry_touched:
        if new_type == "temporary":
            valid_until_in = body.valid_until if "valid_until" in fset else existing.get("valid_until")
            cap = _temp_max_days_for_schools(existing.get("school_ids") or [])
            updates["valid_until"]  = _validate_temp_window(valid_until_in, cap)
            updates["vehicle_type"] = "temporary"
            if "temporary_reason" in fset:
                updates["temporary_reason"] = body.temporary_reason
        else:
            # Promoting to permanent strips the temp metadata so the
            # expiry sweep never picks it up again.
            updates["vehicle_type"]     = "permanent"
            updates["valid_until"]      = None
            updates["temporary_reason"] = None
            updates.pop("temp_vehicle_max_days_at_create", None)

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    doc_ref.update(updates)
    return {"status": "updated", "id": vehicle_id}


@router.delete("/api/v1/benefactor/vehicles/{vehicle_id}")
def delete_vehicle(vehicle_id: str, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("vehicles").document(vehicle_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    doc_ref.delete()
    return {"status": "deleted", "id": vehicle_id}


@router.get("/api/v1/benefactor/authorized-pickups")
def list_authorized_pickups(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    guardian_doc = db.collection("guardians").document(uid).get()
    if not guardian_doc.exists:
        return {"pickups": []}
    return {"pickups": guardian_doc.to_dict().get("authorized_pickups", [])}


@router.post("/api/v1/benefactor/authorized-pickups")
def add_authorized_pickup(body: AddAuthorizedPickupRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    guardian_ref = db.collection("guardians").document(uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")
    pickups = guardian_doc.to_dict().get("authorized_pickups", [])
    entry = {"id": secrets.token_hex(8), "name": body.name.strip(), "phone": (body.phone or "").strip() or None, "relationship": (body.relationship or "").strip() or None, "added_at": datetime.now(timezone.utc).isoformat()}
    pickups.append(entry)
    guardian_ref.update({"authorized_pickups": pickups})
    return entry


@router.patch("/api/v1/benefactor/authorized-pickups/{pickup_id}")
def update_authorized_pickup(
    pickup_id: str,
    body: UpdateAuthorizedPickupRequest,
    user_data: dict = Depends(require_guardian),
):
    """PATCH semantics: only the fields present in `body` are written.
    Mirrors `add_authorized_pickup` for input cleaning — strip whitespace,
    coerce empty optional strings to None — so the stored shape stays
    consistent across create + update.
    """
    uid = user_data["uid"]
    guardian_ref = db.collection("guardians").document(uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")
    pickups = guardian_doc.to_dict().get("authorized_pickups", [])

    target = next((p for p in pickups if p.get("id") == pickup_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Authorized pickup not found")

    # `model_dump(exclude_unset=True)` gives us only the fields the
    # caller actually sent — true PATCH semantics, not "send the whole
    # object and hope".  Then normalize the same way add does.
    patch = body.model_dump(exclude_unset=True)
    if "name" in patch and patch["name"] is not None:
        target["name"] = patch["name"].strip()
    if "phone" in patch:
        target["phone"] = (patch["phone"] or "").strip() or None
    if "relationship" in patch:
        target["relationship"] = (patch["relationship"] or "").strip() or None
    target["updated_at"] = datetime.now(timezone.utc).isoformat()

    guardian_ref.update({"authorized_pickups": pickups})
    return target


@router.delete("/api/v1/benefactor/authorized-pickups/{pickup_id}")
def remove_authorized_pickup(pickup_id: str, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    guardian_ref = db.collection("guardians").document(uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")
    pickups = guardian_doc.to_dict().get("authorized_pickups", [])
    new_pickups = [p for p in pickups if p.get("id") != pickup_id]
    if len(new_pickups) == len(pickups):
        raise HTTPException(status_code=404, detail="Authorized pickup not found")
    guardian_ref.update({"authorized_pickups": new_pickups})
    return {"status": "removed", "id": pickup_id}


@router.get("/api/v1/benefactor/activity")
def guardian_activity(user_data: dict = Depends(require_guardian), limit: int = 20, school_id: Optional[str] = Query(None)):
    uid = user_data["uid"]
    limit = min(max(limit, 1), 100)
    veh_query = db.collection("vehicles").where("guardian_uid", "==", uid)
    if school_id:
        veh_query = veh_query.where("school_ids", "array_contains", school_id)
    vehicles = veh_query.stream()
    plate_tokens, plate_info = [], {}
    for v in vehicles:
        vdata = v.to_dict()
        token = vdata.get("plate_token")
        if token:
            plate_tokens.append(token)
            try:
                plate_num = decrypt_string(vdata.get("plate_number_encrypted", ""))
            except Exception:
                plate_num = "***"
            desc = " ".join(filter(None, [vdata.get("color"), vdata.get("make"), vdata.get("model")])) or "Vehicle"
            plate_info[token] = {"plate_number": plate_num, "vehicle_desc": desc}
    if not plate_tokens:
        return {"events": [], "total": 0}
    all_events = []
    for i in range(0, len(plate_tokens), 30):
        chunk = plate_tokens[i:i+30]
        scans = db.collection("plate_scans").where("plate_token", "in", chunk).order_by("timestamp", direction=_fs.Query.DESCENDING).limit(limit).stream()
        for s in scans:
            sdata = s.to_dict()
            token = sdata.get("plate_token", "")
            students_raw = sdata.get("student_names_encrypted", [])
            if isinstance(students_raw, str):
                students_raw = [students_raw]
            students = []
            for enc in students_raw:
                try:
                    students.append(decrypt_string(enc))
                except Exception:
                    students.append("(encrypted)")
            info = plate_info.get(token, {})
            all_events.append({"id": s.id, "timestamp": sdata.get("timestamp"), "plate_number": info.get("plate_number", "***"), "vehicle_desc": info.get("vehicle_desc", "Vehicle"), "students": students, "location": sdata.get("location", ""), "picked_up_by": sdata.get("picked_up_by"), "picked_up_at": sdata.get("picked_up_at")})
    all_events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
    return {"events": all_events[:limit], "total": len(all_events[:limit])}


@router.get("/api/v1/benefactor/today")
def guardian_today(user_data: dict = Depends(require_guardian)):
    """Unified 'Today' view: upcoming pickups across all schools, grouped by school."""
    uid = user_data["uid"]

    # 1. Load guardian's assigned schools
    if ENV == "development":
        school_map = {DEV_SCHOOL_ID: {"name": "Development School", "dismissal_time": None, "timezone": "America/New_York"}}
    else:
        guardian_doc = db.collection("guardians").document(uid).get()
        if not guardian_doc.exists:
            return {"schools": [], "upcoming_pickups": []}
        assigned_ids = guardian_doc.to_dict().get("assigned_school_ids", [])
        school_map = {}
        for sid in assigned_ids:
            sdoc = db.collection("schools").document(sid).get()
            if sdoc.exists:
                sdata = sdoc.to_dict()
                if sdata.get("status") != "suspended":
                    school_map[sid] = {
                        "name": sdata.get("name", ""),
                        "dismissal_time": sdata.get("dismissal_time"),
                        "timezone": sdata.get("timezone", "America/New_York"),
                    }

    if not school_map:
        return {"schools": [], "upcoming_pickups": []}

    # 2. Load children grouped by school
    child_docs = list(db.collection("students").where(field_path="guardian_uid", op_string="==", value=uid).stream())
    children_by_school = {}
    for doc in child_docs:
        d = doc.to_dict()
        sid = d.get("school_id")
        if sid and sid in school_map:
            children_by_school.setdefault(sid, []).append({
                "id": doc.id,
                "first_name": safe_decrypt(d.get("first_name_encrypted"), default=""),
                "last_name": safe_decrypt(d.get("last_name_encrypted"), default=""),
                "grade": d.get("grade"),
                "photo_url": d.get("photo_url"),
            })

    # 3. Load today's scan events for this guardian's vehicles
    vehicles = list(db.collection("vehicles").where("guardian_uid", "==", uid).stream())
    plate_tokens, plate_info = [], {}
    for v in vehicles:
        vdata = v.to_dict()
        token = vdata.get("plate_token")
        if token:
            plate_tokens.append(token)
            try:
                plate_num = decrypt_string(vdata.get("plate_number_encrypted", ""))
            except Exception:
                plate_num = "***"
            desc = " ".join(filter(None, [vdata.get("color"), vdata.get("make"), vdata.get("model")])) or "Vehicle"
            plate_info[token] = {"plate_number": plate_num, "vehicle_desc": desc, "school_ids": vdata.get("school_ids", [])}

    today_events = []
    if plate_tokens:
        from datetime import date
        today_start = datetime.combine(date.today(), datetime.min.time(), tzinfo=timezone.utc)
        for i in range(0, len(plate_tokens), 30):
            chunk = plate_tokens[i:i + 30]
            scans = db.collection("plate_scans").where("plate_token", "in", chunk).order_by("timestamp", direction=_fs.Query.DESCENDING).limit(50).stream()
            for s in scans:
                sdata = s.to_dict()
                ts = sdata.get("timestamp")
                # Filter today's events only
                if ts:
                    try:
                        scan_time = ts if hasattr(ts, "date") else datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                        if scan_time.replace(tzinfo=timezone.utc if scan_time.tzinfo is None else scan_time.tzinfo) < today_start:
                            continue
                    except Exception:
                        pass
                token = sdata.get("plate_token", "")
                students_raw = sdata.get("student_names_encrypted", [])
                if isinstance(students_raw, str):
                    students_raw = [students_raw]
                students = []
                for enc in students_raw:
                    try:
                        students.append(decrypt_string(enc))
                    except Exception:
                        students.append("(encrypted)")
                info = plate_info.get(token, {})
                today_events.append({
                    "id": s.id,
                    "timestamp": sdata.get("timestamp"),
                    "plate_number": info.get("plate_number", "***"),
                    "vehicle_desc": info.get("vehicle_desc", "Vehicle"),
                    "students": students,
                    "school_id": sdata.get("school_id", ""),
                    "location": sdata.get("location", ""),
                    "picked_up_at": sdata.get("picked_up_at"),
                })
        today_events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)

    # 4. Build school summaries
    schools_summary = []
    for sid, sinfo in school_map.items():
        children = children_by_school.get(sid, [])
        school_events = [e for e in today_events if e.get("school_id") == sid]
        schools_summary.append({
            "id": sid,
            "name": sinfo["name"],
            "dismissal_time": sinfo.get("dismissal_time"),
            "timezone": sinfo.get("timezone", "America/New_York"),
            "children_count": len(children),
            "children": children,
            "today_events_count": len(school_events),
        })

    return {
        "schools": schools_summary,
        "today_events": today_events[:50],
        "total_children": sum(len(c) for c in children_by_school.values()),
    }


@router.get("/api/v1/benefactor/assigned-schools")
def get_assigned_schools(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    if ENV == "development":
        return {"schools": [{"id": DEV_SCHOOL_ID, "name": "Development School", "logo_url": None, "address": None, "timezone": "America/New_York", "dismissal_time": None}]}
    guardian_doc = db.collection("guardians").document(uid).get()
    if not guardian_doc.exists:
        return {"schools": []}
    assigned_ids = guardian_doc.to_dict().get("assigned_school_ids", [])
    schools = []
    for sid in assigned_ids:
        sdoc = db.collection("schools").document(sid).get()
        if sdoc.exists:
            sdata = sdoc.to_dict()
            if sdata.get("status") != "suspended":
                schools.append({
                    "id": sid,
                    "name": sdata.get("name", ""),
                    "logo_url": sdata.get("logo_url"),
                    "address": sdata.get("address"),
                    "timezone": sdata.get("timezone", "America/New_York"),
                    "dismissal_time": sdata.get("dismissal_time"),
                })
    schools.sort(key=lambda s: s.get("name", "").lower())
    return {"schools": schools}
