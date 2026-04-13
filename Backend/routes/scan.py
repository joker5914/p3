"""Scan ingestion, live dashboard, and queue management routes."""
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from google.cloud import firestore as _fs

from core.auth import _get_admin_school_ids, verify_firebase_token
from core.firebase import db
from core.queue import queue_manager
from core.utils import (
    _find_firestore_ids_by_plate_token,
    _format_timestamp,
    _get_active_firestore_ids,
    _localise,
    _mark_bulk_picked_up,
    generate_hash,
)
from core.websocket import registry
from models.schemas import PlateScan
from secure_lookup import encrypt_string, safe_decrypt, tokenize_plate

logger = logging.getLogger(__name__)

router = APIRouter()


def _decrypt_students_inline(plate_info: dict):
    if "student_names_encrypted" in plate_info:
        enc = plate_info["student_names_encrypted"]
        if isinstance(enc, list):
            return [safe_decrypt(s, default="") for s in enc], enc
        return safe_decrypt(enc, default=""), enc
    enc = plate_info.get("student_name")
    if enc:
        return safe_decrypt(enc, default=""), enc
    return None, None


@router.post("/api/v1/scan")
async def scan_plate(
    scan: PlateScan,
    user_data: dict = Depends(verify_firebase_token),
):
    school_id = user_data.get("school_id") or user_data.get("uid")
    role = user_data.get("role")
    if role in ("school_admin", "super_admin"):
        admin_school_ids = _get_admin_school_ids(user_data)
    else:
        admin_school_ids = {school_id}

    local_timestamp = _localise(scan.timestamp)
    plate_token = tokenize_plate(scan.plate)
    event_hash = generate_hash(scan.plate, local_timestamp)

    base_event = {
        "plate_token": plate_token,
        "plate_display": scan.plate.upper().strip(),
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "school_id": school_id,
    }

    event = None
    enc_plate_number = None
    encrypted_parent = None
    encrypted_students = None

    # ── 1. Check vehicles collection (guardian-added) ──
    vehicle_docs = list(
        db.collection("vehicles")
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .limit(1)
        .stream()
    )

    if vehicle_docs:
        vdata = vehicle_docs[0].to_dict()
        vehicle_school_ids = set(vdata.get("school_ids", []))
        if vehicle_school_ids & admin_school_ids:
            guardian_uid = vdata.get("guardian_uid")
            gdoc = db.collection("guardians").document(guardian_uid).get() if guardian_uid else None
            gdata = gdoc.to_dict() if gdoc and gdoc.exists else {}
            students_decrypted, student_photos, student_names_enc = [], [], []
            for sid in vdata.get("student_ids", []):
                sdoc = db.collection("students").document(sid).get()
                if sdoc.exists:
                    sd = sdoc.to_dict()
                    first = safe_decrypt(sd.get("first_name_encrypted"), default="")
                    last = safe_decrypt(sd.get("last_name_encrypted"), default="")
                    students_decrypted.append(f"{first} {last}".strip())
                    student_photos.append(sd.get("photo_url"))
                    student_names_enc.append(sd.get("first_name_encrypted", ""))
            plate_display = safe_decrypt(vdata.get("plate_number_encrypted"), default=scan.plate) or scan.plate
            guardian_name = gdata.get("display_name", "")
            encrypted_parent = encrypt_string(guardian_name) if guardian_name else None
            encrypted_students = student_names_enc or None
            enc_plate_number = vdata.get("plate_number_encrypted")
            event = {
                **base_event,
                "plate_display": plate_display,
                "student": students_decrypted if len(students_decrypted) != 1 else students_decrypted[0],
                "parent": guardian_name,
                "vehicle_make": vdata.get("make"),
                "vehicle_model": vdata.get("model"),
                "vehicle_color": vdata.get("color"),
                "guardian_photo_url": gdata.get("photo_url"),
                "student_photo_urls": student_photos,
                "authorization_status": "authorized",
            }

    # ── 2. Check plates collection (admin-imported) ──
    if not event:
        plate_doc = db.collection("plates").document(plate_token).get()
        if plate_doc.exists:
            plate_info = plate_doc.to_dict()
            plate_school = plate_info.get("school_id")
            if not plate_school or plate_school in admin_school_ids:
                decrypted_students, encrypted_students = _decrypt_students_inline(plate_info)
                encrypted_parent = plate_info.get("parent")
                guardian_name = safe_decrypt(encrypted_parent) if encrypted_parent else None
                enc_plate_number = plate_info.get("plate_number_encrypted")
                auth_guardians = []
                for ag in plate_info.get("authorized_guardians") or []:
                    auth_guardians.append({"name": safe_decrypt(ag.get("name_encrypted"), default=""), "photo_url": ag.get("photo_url")})
                event = {
                    **base_event,
                    "plate_display": safe_decrypt(enc_plate_number) if enc_plate_number else None,
                    "student": decrypted_students,
                    "parent": guardian_name,
                    "vehicle_make": plate_info.get("vehicle_make"),
                    "vehicle_model": plate_info.get("vehicle_model"),
                    "vehicle_color": plate_info.get("vehicle_color"),
                    "guardian_photo_url": plate_info.get("guardian_photo_url"),
                    "student_photo_urls": plate_info.get("student_photo_urls") or [],
                    "authorized_guardians": auth_guardians,
                    "authorization_status": "authorized",
                }

    # ── 3. Check authorized guardian plates ──
    if not event:
        auth_hits = list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=school_id)
            .where(field_path="authorized_plate_tokens", op_string="array_contains", value=plate_token)
            .limit(1).stream()
        )
        if auth_hits:
            plate_info = auth_hits[0].to_dict()
            decrypted_students, encrypted_students = _decrypt_students_inline(plate_info)
            encrypted_parent = plate_info.get("parent")
            primary_guardian = safe_decrypt(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")
            arriving_guardian, arriving_vehicle = None, {}
            for ag in plate_info.get("authorized_guardians") or []:
                if ag.get("plate_token") == plate_token:
                    arriving_guardian = safe_decrypt(ag.get("name_encrypted"), default="")
                    arriving_vehicle = {"vehicle_make": ag.get("vehicle_make"), "vehicle_model": ag.get("vehicle_model"), "vehicle_color": ag.get("vehicle_color")}
                    enc_plate_number = ag.get("plate_number_encrypted")
                    break
            event = {
                **base_event,
                "plate_display": (safe_decrypt(enc_plate_number) if enc_plate_number else None) or scan.plate.upper(),
                "student": decrypted_students,
                "parent": arriving_guardian or "Authorized Guardian",
                "primary_guardian": primary_guardian,
                **arriving_vehicle,
                "guardian_photo_url": None,
                "student_photo_urls": plate_info.get("student_photo_urls") or [],
                "authorization_status": "authorized_guardian",
            }

    # ── 4. Check blocked guardian plates ──
    if not event:
        blocked_hits = list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=school_id)
            .where(field_path="blocked_plate_tokens", op_string="array_contains", value=plate_token)
            .limit(1).stream()
        )
        if blocked_hits:
            plate_info = blocked_hits[0].to_dict()
            decrypted_students, encrypted_students = _decrypt_students_inline(plate_info)
            encrypted_parent = plate_info.get("parent")
            primary_guardian = safe_decrypt(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")
            blocked_name, blocked_reason, blocked_vehicle = None, None, {}
            for bg in plate_info.get("blocked_guardians") or []:
                if bg.get("plate_token") == plate_token:
                    blocked_name = safe_decrypt(bg.get("name_encrypted"), default="")
                    blocked_reason = bg.get("reason")
                    blocked_vehicle = {"vehicle_make": bg.get("vehicle_make"), "vehicle_model": bg.get("vehicle_model"), "vehicle_color": bg.get("vehicle_color")}
                    enc_plate_number = bg.get("plate_number_encrypted")
                    break
            event = {
                **base_event,
                "plate_display": (safe_decrypt(enc_plate_number) if enc_plate_number else None) or scan.plate.upper(),
                "student": decrypted_students,
                "parent": blocked_name or "Blocked Person",
                "primary_guardian": primary_guardian,
                **blocked_vehicle,
                "guardian_photo_url": None,
                "student_photo_urls": [],
                "authorization_status": "unauthorized",
                "blocked_reason": blocked_reason,
            }

    # ── 5. Unregistered fallback ──
    if not event:
        enc_plate_number = encrypt_string(scan.plate.upper().strip())
        event = {
            **base_event,
            "student": None, "parent": None,
            "vehicle_make": None, "vehicle_model": None, "vehicle_color": None,
            "guardian_photo_url": None, "student_photo_urls": [],
            "authorization_status": "unregistered",
        }

    queue_manager.add_event(school_id, event)
    if enc_plate_number is None:
        enc_plate_number = encrypt_string(scan.plate.upper().strip())

    firestore_doc = {
        "plate_token": plate_token,
        "plate_number_encrypted": enc_plate_number,
        "student_names_encrypted": encrypted_students,
        "parent_name_encrypted": encrypted_parent,
        "timestamp": local_timestamp,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "hash": event_hash,
        "school_id": school_id,
        "vehicle_make": event.get("vehicle_make"),
        "vehicle_model": event.get("vehicle_model"),
        "vehicle_color": event.get("vehicle_color"),
        "guardian_photo_url": event.get("guardian_photo_url"),
        "student_photo_urls": event.get("student_photo_urls") or [],
        "authorized_guardians": event.get("authorized_guardians") or [],
        "authorization_status": event.get("authorization_status", "authorized"),
        "primary_guardian": event.get("primary_guardian"),
        "blocked_reason": event.get("blocked_reason"),
        "picked_up_at": None,
        "pickup_method": None,
    }
    doc_ref = db.collection("plate_scans").add(firestore_doc)
    firestore_id = doc_ref[1].id
    event["firestore_id"] = firestore_id

    logger.info("Scan recorded: plate_token=%s status=%s school=%s", plate_token, event.get("authorization_status"), school_id)
    await registry.broadcast(school_id, {"type": "scan", "data": event})
    return {"status": "success", "firestore_id": firestore_id}


@router.get("/api/v1/dashboard")
def get_dashboard(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    scans_query = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .order_by("timestamp", direction=_fs.Query.ASCENDING)
        .stream()
    )
    results = []
    for scan in scans_query:
        data = scan.to_dict()
        if data.get("picked_up_at"):
            continue
        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        if enc_students:
            students = [safe_decrypt(s, default="") for s in enc_students] if isinstance(enc_students, list) else safe_decrypt(enc_students, default="")
        else:
            students = None
        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = safe_decrypt(enc_parent) if enc_parent else None
        enc_plate = data.get("plate_number_encrypted")
        plate_display = safe_decrypt(enc_plate) if enc_plate else None
        if not plate_display and data.get("plate_token"):
            _pt = data["plate_token"]
            _vdocs = list(db.collection("vehicles").where(field_path="plate_token", op_string="==", value=_pt).limit(1).stream())
            if _vdocs:
                _enc = _vdocs[0].to_dict().get("plate_number_encrypted")
                plate_display = safe_decrypt(_enc) if _enc else None
            if not plate_display:
                _pdoc = db.collection("plates").document(_pt).get()
                if _pdoc.exists:
                    _enc = _pdoc.to_dict().get("plate_number_encrypted")
                    plate_display = safe_decrypt(_enc) if _enc else None
        results.append({
            "firestore_id": scan.id, "plate_token": data.get("plate_token"),
            "plate_display": plate_display, "student": students, "parent": parent,
            "timestamp": _format_timestamp(data.get("timestamp")),
            "location": data.get("location"), "confidence_score": data.get("confidence_score"),
            "hash": data.get("hash"), "vehicle_make": data.get("vehicle_make"),
            "vehicle_model": data.get("vehicle_model"), "vehicle_color": data.get("vehicle_color"),
            "guardian_photo_url": data.get("guardian_photo_url"),
            "student_photo_urls": data.get("student_photo_urls") or [],
            "authorized_guardians": data.get("authorized_guardians") or [],
            "authorization_status": data.get("authorization_status", "authorized"),
            "primary_guardian": data.get("primary_guardian"),
            "blocked_reason": data.get("blocked_reason"),
        })
    logger.info("Dashboard fetch: %d records for school=%s", len(results), school_id)
    return JSONResponse(content={"queue": results}, headers={"Cache-Control": "no-store"})


@router.delete("/api/v1/plate/{plate}")
def remove_plate_from_queue(plate: str, user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    plate_token = tokenize_plate(plate.upper().strip())
    queue_manager.remove_event(school_id, plate_token)
    return {"status": "removed", "plate_token": plate_token}


@router.delete("/api/v1/queue/{plate_token}")
async def dismiss_from_queue(
    plate_token: str,
    pickup_method: str = Query(default="manual"),
    user_data: dict = Depends(verify_firebase_token),
):
    school_id = user_data.get("school_id") or user_data.get("uid")
    all_events = queue_manager.get_all_events(school_id)
    firestore_ids = [e["firestore_id"] for e in all_events if e["plate_token"] == plate_token and e.get("firestore_id")]
    queue_manager.remove_event(school_id, plate_token)
    try:
        db_ids = await asyncio.to_thread(_find_firestore_ids_by_plate_token, school_id, plate_token)
        for fid in db_ids:
            if fid not in firestore_ids:
                firestore_ids.append(fid)
    except Exception as exc:
        logger.warning("Firestore lookup for plate_token=%s failed: %s", plate_token, exc)
    if firestore_ids:
        try:
            await asyncio.to_thread(_mark_bulk_picked_up, firestore_ids, pickup_method, user_data.get("uid"))
        except Exception as exc:
            logger.warning("Failed to mark pickup in Firestore: %s", exc)
    await registry.broadcast(school_id, {"type": "dismiss", "plate_token": plate_token})
    logger.info("Dismissed plate_token=%s method=%s school=%s", plate_token, pickup_method, school_id)
    return {"status": "dismissed", "plate_token": plate_token, "pickup_method": pickup_method}


@router.post("/api/v1/queue/bulk-pickup")
async def bulk_pickup(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    events = queue_manager.get_all_events(school_id)
    firestore_ids = await asyncio.to_thread(_get_active_firestore_ids, school_id)
    if not events and not firestore_ids:
        return {"status": "success", "count": 0}
    if firestore_ids:
        try:
            await asyncio.to_thread(_mark_bulk_picked_up, firestore_ids, "manual_bulk", user_data.get("uid"))
        except Exception as exc:
            logger.warning("Failed to batch-mark pickups in Firestore: %s", exc)
    plate_tokens = [e["plate_token"] for e in events]
    queue_manager.clear(school_id)
    await registry.broadcast(school_id, {"type": "bulk_dismiss", "plate_tokens": plate_tokens})
    count = max(len(events), len(firestore_ids))
    logger.info("Bulk pickup: %d entries for school=%s", count, school_id)
    return {"status": "success", "count": count}
