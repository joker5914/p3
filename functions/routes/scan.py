"""Scan ingestion, live dashboard, and queue management routes."""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from google.cloud import firestore as _fs

from core import live_queue
from core.audit import log_event as audit_log
from core.auth import _get_admin_school_ids, verify_firebase_token
from core.firebase import db
from core.utils import (
    _find_firestore_ids_by_plate_token,
    _format_timestamp,
    _get_active_firestore_ids,
    _localise,
    _mark_bulk_picked_up,
    generate_hash,
)
from models.schemas import PlateScan, UnrecognizedScan
from secure_lookup import encrypt_string, safe_decrypt, tokenize_plate

logger = logging.getLogger(__name__)

router = APIRouter()


# Window in which a freshly-arrived recognised scan auto-supersedes any
# unrecognised scans on the same school+location.  Sized to comfortably
# cover the gap between "Pi posts unrec for half-cropped frame" and "Pi
# posts the recognised read once the full plate is in view" — typically
# under a second, but cars approaching slowly + deduplication can
# stretch it to a few seconds.
_UNREC_SUPERSEDE_WINDOW_SECS = int(os.getenv("UNREC_SUPERSEDE_WINDOW_SECS", "30"))


async def _supersede_recent_unrec(
    school_id: str,
    location: Optional[str],
    recognized_at,
    new_plate_token: str,
):
    """Mark recently-posted unrecognized scans on the same camera as
    auto-superseded once the real plate comes through.

    Cleans up the case the operator hits when the Pi posts an unrec on
    a half-cropped frame ("BC7130" hallucinated from a partial plate)
    one frame before the same vehicle's full plate reads cleanly: both
    cards land in the queue, but only the recognised one is correct.

    Best-effort.  Failures are logged but don't propagate so the
    recognised-scan response stays fast.
    """
    try:
        cutoff = recognized_at - timedelta(seconds=_UNREC_SUPERSEDE_WINDOW_SECS)
        query = (
            db.collection("plate_scans")
            .where(field_path="school_id",            op_string="==", value=school_id)
            .where(field_path="authorization_status", op_string="==", value="unrecognized")
            .where(field_path="picked_up_at",         op_string="==", value=None)
            .where(field_path="timestamp",            op_string=">=", value=cutoff)
        )
        docs = list(query.stream())
    except Exception as exc:
        logger.warning("Unrec supersede lookup failed for school=%s: %s", school_id, exc)
        return

    superseded_tokens: list[str] = []
    for d in docs:
        data = d.to_dict() or {}
        # Only supersede unrec scans from the same camera location — a
        # different lane's unrec read is not the same vehicle.  When
        # location is missing on either side, fall through (single-camera
        # campuses don't tag location and we still want supersession).
        doc_loc = data.get("location")
        if location and doc_loc and doc_loc != location:
            continue
        try:
            d.reference.update({
                "picked_up_at":           recognized_at,
                "pickup_method":          "auto_superseded",
                "superseded_by_token":    new_plate_token,
            })
            superseded_tokens.append(data.get("plate_token"))
        except Exception as exc:
            logger.warning("Unrec supersede update failed for doc=%s: %s", d.id, exc)

    if not superseded_tokens:
        return

    logger.info(
        "Auto-superseded %d unrec scan(s) on school=%s loc=%s by recognised plate token=%s",
        len(superseded_tokens), school_id, location, new_plate_token,
    )
    # Drop the stale cards from the live mirror — clients listening on
    # live_queue/{school_id}/events see the doc deletes and remove the
    # rows from their queue.
    for token in superseded_tokens:
        if not token:
            continue
        live_queue.remove_by_plate_token(school_id, token)


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


def _resolve_scan_school(user_data: dict) -> str:
    """Pick the school_id this scan should be tagged with, or 400 with a
    clear message when no school context is available.

    * ``scanner`` — the device must be admin-assigned to a school
      (see the Devices page).
    * ``super_admin`` / ``district_admin`` / ``school_admin`` — must send
      ``X-School-Id``; we no longer silently fall back to the caller's
      UID because that routes test scans into a bucket the admin's
      Dashboard never queries.  Silent misroutes are worse than loud
      failures.
    * Anyone else — fall back to their UID (dev/guardian flows).
    """
    role = user_data.get("role")
    school_id = user_data.get("school_id")
    if role == "scanner":
        if not school_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Device is not assigned to a school. "
                    "Assign it from the admin portal's Devices page."
                ),
            )
        return school_id
    if role in ("super_admin", "district_admin", "school_admin"):
        if not school_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "X-School-Id header is required for admin-posted scans "
                    "so the scan lands in the correct campus Dashboard."
                ),
            )
        return school_id
    return school_id or user_data.get("uid")


@router.post("/api/v1/scan")
async def scan_plate(
    scan: PlateScan,
    user_data: dict = Depends(verify_firebase_token),
):
    school_id = _resolve_scan_school(user_data)
    role = user_data.get("role")
    if role in ("school_admin", "super_admin"):
        admin_school_ids = _get_admin_school_ids(user_data)
    else:
        admin_school_ids = {school_id}

    local_timestamp = _localise(scan.timestamp)
    plate_token = tokenize_plate(scan.plate)
    event_hash = generate_hash(scan.plate, local_timestamp)

    # Trim whitespace at write time so historical scanners that posted
    # the same logical location with stray whitespace don't fragment the
    # Dashboard's location filter or the supersede query.
    location = (scan.location or "").strip() or None

    base_event = {
        "plate_token": plate_token,
        "plate_display": scan.plate.upper().strip(),
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": location,
        "confidence_score": scan.confidence_score,
        "school_id": school_id,
        "thumbnail_b64": scan.thumbnail_b64,
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

    if enc_plate_number is None:
        enc_plate_number = encrypt_string(scan.plate.upper().strip())

    firestore_doc = {
        "plate_token": plate_token,
        "plate_number_encrypted": enc_plate_number,
        "student_names_encrypted": encrypted_students,
        "parent_name_encrypted": encrypted_parent,
        "timestamp": local_timestamp,
        "location": location,
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
        "thumbnail_b64": scan.thumbnail_b64,
        "picked_up_at": None,
        "pickup_method": None,
    }
    doc_ref = db.collection("plate_scans").add(firestore_doc)
    firestore_id = doc_ref[1].id
    event["firestore_id"] = firestore_id

    # Mirror into the live_queue subcollection — the dashboard's
    # onSnapshot listener picks up the add and renders the new card.
    live_queue.add_event(school_id, firestore_id, event)

    logger.info("Scan recorded: plate_token=%s status=%s school=%s", plate_token, event.get("authorization_status"), school_id)

    # Drop any unrec scans the Pi posted moments ago for the same camera
    # — almost always the same vehicle whose plate finally read cleanly
    # on a later frame.  Keeps the operator queue from showing the
    # bogus "Unknown vehicle / Plate not detected" card next to the
    # correct one.
    await _supersede_recent_unrec(
        school_id=school_id,
        location=location,
        recognized_at=local_timestamp,
        new_plate_token=plate_token,
    )

    return {"status": "success", "firestore_id": firestore_id}


@router.post("/api/v1/scan/unrecognized")
async def scan_unrecognized(
    scan: UnrecognizedScan,
    user_data: dict = Depends(verify_firebase_token),
):
    """The scanner found a plate-shaped region in frame but couldn't read it.
    We record it so admins can visually verify what the camera saw and, if
    appropriate, follow up manually.  No plate lookup is attempted — there's
    nothing to look up."""
    school_id = _resolve_scan_school(user_data)
    local_timestamp = _localise(scan.timestamp)
    # Match the trim applied in scan_plate so the Dashboard's location
    # filter sees consistent values across both ingestion paths.
    location = (scan.location or "").strip() or None

    # Deterministic hash keeps the Dashboard dedup logic happy.  We fold in
    # the OCR guess (if any) + timestamp so repeated unrecognized captures
    # on the same frame don't collapse into one entry the way identical
    # plates do.
    hash_seed = f"{scan.ocr_guess or ''}@{local_timestamp.isoformat()}"
    event_hash = generate_hash(hash_seed, local_timestamp)

    event = {
        "plate_token": f"unrecognized_{event_hash[:16]}",
        "plate_display": scan.ocr_guess or None,
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": location,
        "confidence_score": scan.confidence_score,
        "school_id": school_id,
        "thumbnail_b64": scan.thumbnail_b64,
        "authorization_status": "unrecognized",
        "reason": scan.reason,
        "student": None,
        "parent": None,
        "vehicle_make": None,
        "vehicle_model": None,
        "vehicle_color": None,
        "guardian_photo_url": None,
        "student_photo_urls": [],
    }

    firestore_doc = {
        "plate_token": event["plate_token"],
        "plate_number_encrypted": None,
        "student_names_encrypted": None,
        "parent_name_encrypted": None,
        "timestamp": local_timestamp,
        "location": location,
        "confidence_score": scan.confidence_score,
        "hash": event_hash,
        "school_id": school_id,
        "authorization_status": "unrecognized",
        "ocr_guess": scan.ocr_guess,
        "reason": scan.reason,
        "thumbnail_b64": scan.thumbnail_b64,
        "picked_up_at": None,
        "pickup_method": None,
    }
    doc_ref = db.collection("plate_scans").add(firestore_doc)
    firestore_id = doc_ref[1].id
    event["firestore_id"] = firestore_id

    live_queue.add_event(school_id, firestore_id, event)
    logger.info(
        "Unrecognized scan recorded: reason=%s guess=%s school=%s",
        scan.reason, scan.ocr_guess, school_id,
    )
    return {"status": "success", "firestore_id": firestore_id}


def _scope_school_for_read(user_data: dict) -> Optional[str]:
    """Mirror of ``_resolve_scan_school`` for list/queue reads.  Returns
    the school_id to query, or ``None`` when an admin role hasn't picked
    a campus yet (caller should return an empty list instead of falling
    back to the UID bucket — that was the source of the silent-misroute
    class of bugs)."""
    role = user_data.get("role")
    school_id = user_data.get("school_id")
    if role in ("super_admin", "district_admin", "school_admin"):
        return school_id or None
    # scanner / guardian / dev — keep legacy UID fallback so those flows
    # continue to work without a school context.
    return school_id or user_data.get("uid")


@router.get("/api/v1/dashboard")
def get_dashboard(user_data: dict = Depends(verify_firebase_token)):
    school_id = _scope_school_for_read(user_data)
    if not school_id:
        logger.info(
            "Dashboard fetch skipped: no school_id for role=%s uid=%s",
            user_data.get("role"), user_data.get("uid"),
        )
        return JSONResponse(content={"queue": []}, headers={"Cache-Control": "no-store"})
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
            "thumbnail_b64": data.get("thumbnail_b64"),
            "ocr_guess": data.get("ocr_guess"),
            "reason": data.get("reason"),
        })
    logger.info("Dashboard fetch: %d records for school=%s", len(results), school_id)
    return JSONResponse(content={"queue": results}, headers={"Cache-Control": "no-store"})


@router.delete("/api/v1/plate/{plate}")
def remove_plate_from_queue(plate: str, user_data: dict = Depends(verify_firebase_token)):
    school_id = _scope_school_for_read(user_data)
    if not school_id:
        raise HTTPException(status_code=400, detail="X-School-Id header required")
    plate_token = tokenize_plate(plate.upper().strip())
    live_queue.remove_by_plate_token(school_id, plate_token)
    return {"status": "removed", "plate_token": plate_token}


@router.delete("/api/v1/queue/{plate_token}")
async def dismiss_from_queue(
    plate_token: str,
    pickup_method: str = Query(default="manual"),
    user_data: dict = Depends(verify_firebase_token),
):
    school_id = _scope_school_for_read(user_data)
    if not school_id:
        raise HTTPException(status_code=400, detail="X-School-Id header required")
    # Source of truth for "still in the queue" is plate_scans with
    # picked_up_at == None — find those first so we can mark them
    # picked up regardless of whether the live mirror has drifted.
    firestore_ids: list[str] = []
    try:
        firestore_ids = await asyncio.to_thread(_find_firestore_ids_by_plate_token, school_id, plate_token)
    except Exception as exc:
        logger.warning("Firestore lookup for plate_token=%s failed: %s", plate_token, exc)
    if firestore_ids:
        try:
            await asyncio.to_thread(_mark_bulk_picked_up, firestore_ids, pickup_method, user_data.get("uid"))
        except Exception as exc:
            logger.warning("Failed to mark pickup in Firestore: %s", exc)
    # Now drop the live mirror — onSnapshot listeners on the dashboard
    # see the deletes and remove the cards.
    live_queue.remove_by_plate_token(school_id, plate_token)
    logger.info("Dismissed plate_token=%s method=%s school=%s", plate_token, pickup_method, school_id)
    audit_log(
        action="scan.dismissed",
        actor=user_data,
        target={"type": "plate_token", "id": plate_token, "display_name": plate_token[:12]},
        diff={"pickup_method": pickup_method, "firestore_ids_updated": len(firestore_ids)},
        school_id=school_id,
        message=f"Pickup marked via {pickup_method}",
    )
    return {"status": "dismissed", "plate_token": plate_token, "pickup_method": pickup_method}


@router.post("/api/v1/queue/bulk-pickup")
async def bulk_pickup(user_data: dict = Depends(verify_firebase_token)):
    school_id = _scope_school_for_read(user_data)
    if not school_id:
        raise HTTPException(status_code=400, detail="X-School-Id header required")
    firestore_ids = await asyncio.to_thread(_get_active_firestore_ids, school_id)
    if not firestore_ids:
        # Still wipe the mirror in case it drifted (defensive — should
        # be a no-op when the source of truth is empty).
        live_queue.clear(school_id)
        return {"status": "success", "count": 0}
    try:
        await asyncio.to_thread(_mark_bulk_picked_up, firestore_ids, "manual_bulk", user_data.get("uid"))
    except Exception as exc:
        logger.warning("Failed to batch-mark pickups in Firestore: %s", exc)
    live_queue.clear(school_id)
    count = len(firestore_ids)
    logger.info("Bulk pickup: %d entries for school=%s", count, school_id)
    audit_log(
        action="scan.bulk_dismissed",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": school_id},
        diff={"count": count},
        severity="warning" if count > 10 else "info",
        school_id=school_id,
        message=f"Bulk-marked {count} vehicle(s) as picked up",
    )
    return {"status": "success", "count": count}
