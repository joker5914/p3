"""Plate registry CRUD and bulk import routes."""
import asyncio
import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException

from core.audit import log_event as audit_log
from core.auth import _get_admin_school_ids, require_school_admin, verify_firebase_token
from core.firebase import db
from models.schemas import PlateImportRecord, PlateUpdateRequest
from secure_lookup import decrypt_string, encrypt_string, safe_decrypt, tokenize_plate

logger = logging.getLogger(__name__)

router = APIRouter()


def _safe_decrypt(ciphertext):
    if not ciphertext:
        return None
    try:
        return decrypt_string(ciphertext)
    except Exception:
        return None


def _build_plate_entry(doc_id, data, student_map):
    """Convert a plates-collection doc into a registry response dict."""
    linked_ids = data.get("linked_student_ids") or []
    if linked_ids:
        students = [f"{student_map[sid]['first_name']} {student_map[sid]['last_name']}".strip() for sid in linked_ids if sid in student_map]
        linked_students = [student_map[sid] for sid in linked_ids if sid in student_map]
    else:
        enc_students = data.get("student_names_encrypted")
        students = ([_safe_decrypt(s) or "(encrypted)" for s in enc_students] if isinstance(enc_students, list) else ([_safe_decrypt(enc_students) or "(encrypted)"] if enc_students else []))
        linked_students = []
    parent = _safe_decrypt(data.get("parent"))
    plate_display = _safe_decrypt(data.get("plate_number_encrypted"))
    auth_guardians = [{"name": _safe_decrypt(ag.get("name_encrypted")) or "", "photo_url": ag.get("photo_url"), "plate_number": _safe_decrypt(ag.get("plate_number_encrypted")), "vehicle_make": ag.get("vehicle_make"), "vehicle_model": ag.get("vehicle_model"), "vehicle_color": ag.get("vehicle_color")} for ag in data.get("authorized_guardians") or []]
    blk_guardians = [{"name": _safe_decrypt(bg.get("name_encrypted")) or "", "photo_url": bg.get("photo_url"), "plate_number": _safe_decrypt(bg.get("plate_number_encrypted")), "vehicle_make": bg.get("vehicle_make"), "vehicle_model": bg.get("vehicle_model"), "vehicle_color": bg.get("vehicle_color"), "reason": bg.get("reason")} for bg in data.get("blocked_guardians") or []]
    vehicles = [{"plate_number": _safe_decrypt(v.get("plate_number_encrypted")), "make": v.get("make"), "model": v.get("model"), "color": v.get("color")} for v in data.get("vehicles") or []]
    if not vehicles:
        vehicles.append({"plate_number": plate_display, "make": data.get("vehicle_make"), "model": data.get("vehicle_model"), "color": data.get("vehicle_color")})
    return {
        "plate_token": doc_id, "plate_display": plate_display, "parent": parent,
        "students": students, "linked_student_ids": linked_ids, "linked_students": linked_students,
        "vehicle_make": data.get("vehicle_make"), "vehicle_model": data.get("vehicle_model"),
        "vehicle_color": data.get("vehicle_color"), "vehicles": vehicles,
        "imported_at": data.get("imported_at"), "guardian_photo_url": data.get("guardian_photo_url"),
        "student_photo_urls": data.get("student_photo_urls") or [],
        "authorized_guardians": auth_guardians, "blocked_guardians": blk_guardians,
    }


def _fetch_student_map(student_ids):
    """Batch-fetch student docs and return {id: {id, first_name, last_name, photo_url}}."""
    result = {}
    for sid in student_ids:
        sdoc = db.collection("students").document(sid).get()
        if sdoc.exists:
            sdata = sdoc.to_dict()
            result[sid] = {
                "id": sid,
                "first_name": _safe_decrypt(sdata.get("first_name_encrypted")) or "",
                "last_name": _safe_decrypt(sdata.get("last_name_encrypted")) or "",
                "photo_url": sdata.get("photo_url"),
            }
    return result


@router.get("/api/v1/plates")
def list_plates(user_data: dict = Depends(verify_firebase_token)):
    role = user_data.get("role")
    all_school_ids = _get_admin_school_ids(user_data) if role in ("school_admin", "super_admin") else {user_data.get("school_id") or user_data.get("uid")}
    school_id = user_data.get("school_id") or user_data.get("uid")

    # ── 1. Query the plates collection (admin-imported records) ──
    try:
        docs = []
        for sid in all_school_ids:
            docs.extend(list(db.collection("plates").where(field_path="school_id", op_string="==", value=sid).stream()))
    except Exception as exc:
        logger.error("plates query failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to load registry.")

    all_linked_ids: set = set()
    docs_data = []
    for doc in docs:
        data = doc.to_dict()
        docs_data.append((doc.id, data))
        for sid in data.get("linked_student_ids") or []:
            all_linked_ids.add(sid)

    # ── 2. Query the vehicles collection (guardian-added records) ──
    vehicle_docs = []
    try:
        for sid in all_school_ids:
            vehicle_docs.extend(list(
                db.collection("vehicles")
                .where(field_path="school_ids", op_string="array_contains", value=sid)
                .stream()
            ))
    except Exception as exc:
        logger.warning("vehicles query failed (non-fatal): %s", exc)

    # Collect student IDs from vehicle docs too
    for vdoc in vehicle_docs:
        vdata = vdoc.to_dict()
        for sid in vdata.get("student_ids") or []:
            all_linked_ids.add(sid)

    # ── 3. Batch-fetch all referenced students ──
    student_map = _fetch_student_map(all_linked_ids)

    # ── 4. Build results from plates collection ──
    seen_tokens: set = set()
    results = []
    for doc_id, data in docs_data:
        try:
            entry = _build_plate_entry(doc_id, data, student_map)
            results.append(entry)
            # Track plate_tokens so we don't duplicate from vehicles
            if data.get("plate_token"):
                seen_tokens.add(data["plate_token"])
            seen_tokens.add(doc_id)
        except Exception as exc:
            logger.warning("Skipping corrupt plate record %s: %s", doc_id, exc)

    # ── 5. Add vehicles not already in plates ──
    # Cache guardian names to avoid repeated lookups
    guardian_cache: dict = {}
    for vdoc in vehicle_docs:
        vdata = vdoc.to_dict()
        v_plate_token = vdata.get("plate_token", "")
        if v_plate_token in seen_tokens or vdoc.id in seen_tokens:
            continue
        seen_tokens.add(v_plate_token or vdoc.id)
        try:
            # Resolve guardian name
            g_uid = vdata.get("guardian_uid")
            if g_uid and g_uid not in guardian_cache:
                gdoc = db.collection("guardians").document(g_uid).get()
                guardian_cache[g_uid] = gdoc.to_dict().get("display_name", "") if gdoc.exists else ""
            parent_name = guardian_cache.get(g_uid, "") if g_uid else ""

            # Resolve students
            v_student_ids = vdata.get("student_ids") or []
            v_students = [f"{student_map[sid]['first_name']} {student_map[sid]['last_name']}".strip() for sid in v_student_ids if sid in student_map]
            v_linked = [student_map[sid] for sid in v_student_ids if sid in student_map]

            plate_display = _safe_decrypt(vdata.get("plate_number_encrypted"))
            results.append({
                "plate_token": v_plate_token or vdoc.id,
                "plate_display": plate_display,
                "parent": parent_name,
                "students": v_students,
                "linked_student_ids": v_student_ids,
                "linked_students": v_linked,
                "vehicle_make": vdata.get("make"),
                "vehicle_model": vdata.get("model"),
                "vehicle_color": vdata.get("color"),
                "vehicles": [{"plate_number": plate_display, "make": vdata.get("make"), "model": vdata.get("model"), "color": vdata.get("color")}],
                "imported_at": vdata.get("created_at"),
                "guardian_photo_url": None,
                "student_photo_urls": [],
                "authorized_guardians": [],
                "blocked_guardians": [],
                "_source": "vehicles",
            })
        except Exception as exc:
            logger.warning("Skipping vehicle record %s: %s", vdoc.id, exc)

    results.sort(key=lambda r: (r["parent"] or "").lower())
    logger.info("Plates list: %d records (plates+vehicles) school=%s", len(results), school_id)
    return {"plates": results, "total": len(results)}


def _find_vehicle_doc(plate_token: str):
    """Locate a guardian-added record in the ``vehicles`` collection.

    Registry rows mix plates-collection docs and vehicles-collection
    docs (see the list endpoint), but both are returned under the same
    ``plate_token`` key.  For vehicles, the token is either:
      * the ``plate_token`` field on the doc, or
      * the Firestore-auto doc ID (fallback for legacy records).
    Returns the DocumentSnapshot or None.
    """
    hits = list(
        db.collection("vehicles")
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .limit(1)
        .stream()
    )
    if hits:
        return hits[0]
    try:
        doc = db.collection("vehicles").document(plate_token).get()
        if doc.exists:
            return doc
    except Exception:
        pass
    return None


def _vehicle_scope_ok(vdata: dict, school_id: str) -> bool:
    v_school_ids = vdata.get("school_ids") or []
    if not v_school_ids:
        return True  # legacy record, allow
    return school_id in v_school_ids


@router.delete("/api/v1/plates/{plate_token}")
async def delete_plate(plate_token: str, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    doc_ref = db.collection("plates").document(plate_token)
    doc = doc_ref.get()
    if doc.exists:
        if doc.to_dict().get("school_id") and doc.to_dict()["school_id"] != school_id:
            raise HTTPException(status_code=403, detail="Not authorised to delete this plate")
        plate_display = _safe_decrypt(doc.to_dict().get("plate_number_encrypted")) or plate_token[:12]
        await asyncio.to_thread(doc_ref.delete)
        logger.info("Deleted plate_token=%s school=%s", plate_token, school_id)
        audit_log(
            action="plate.deleted",
            actor=user_data,
            target={"type": "plate", "id": plate_token, "display_name": plate_display},
            severity="warning",
            school_id=school_id,
            message=f"Plate removed from registry ({plate_display})",
        )
        return {"status": "deleted", "plate_token": plate_token, "source": "plates"}

    # Fall through: the registry also surfaces guardian-added vehicles.
    vdoc = _find_vehicle_doc(plate_token)
    if vdoc is None:
        raise HTTPException(status_code=404, detail="Plate not found")
    if not _vehicle_scope_ok(vdoc.to_dict(), school_id):
        raise HTTPException(status_code=403, detail="Not authorised to delete this vehicle")
    plate_display = _safe_decrypt(vdoc.to_dict().get("plate_number_encrypted")) or plate_token[:12]
    await asyncio.to_thread(vdoc.reference.delete)
    logger.info("Deleted vehicle=%s (plate_token=%s) school=%s", vdoc.id, plate_token, school_id)
    audit_log(
        action="plate.deleted",
        actor=user_data,
        target={"type": "vehicle", "id": vdoc.id, "display_name": plate_display},
        severity="warning",
        school_id=school_id,
        message=f"Guardian-added vehicle removed ({plate_display})",
    )
    return {"status": "deleted", "plate_token": plate_token, "source": "vehicles"}


async def _update_vehicle(vdoc, body: "PlateUpdateRequest", school_id: str) -> dict:
    """Apply a PlateUpdateRequest to a ``vehicles`` collection doc.

    Only the fields that exist on the vehicles schema are written; any
    plates-only fields (authorized_guardians, blocked_guardians,
    guardian_name, photos) are silently ignored — the UI shows them for
    every row but they don't apply to guardian-added records.
    """
    if not _vehicle_scope_ok(vdoc.to_dict(), school_id):
        raise HTTPException(status_code=403, detail="Not authorised to edit this vehicle")

    updates: dict = {}
    new_token = vdoc.to_dict().get("plate_token") or vdoc.id

    # Plate number — either from body.plate_number or vehicles[0].plate_number.
    pc = None
    if body.plate_number is not None:
        pc = body.plate_number.upper().strip()
    elif body.vehicles and body.vehicles[0].plate_number:
        pc = body.vehicles[0].plate_number.upper().strip()
    if pc is not None:
        if not pc:
            raise HTTPException(status_code=400, detail="Plate number cannot be blank")
        new_token = tokenize_plate(pc)
        updates["plate_token"] = new_token
        updates["plate_number_encrypted"] = encrypt_string(pc)

    # Make / model / color — accept either flat fields or vehicles[0].
    if body.vehicles:
        first = body.vehicles[0]
        if first.make   is not None: updates["make"]   = first.make
        if first.model  is not None: updates["model"]  = first.model
        if first.color  is not None: updates["color"]  = first.color
    if body.vehicle_make  is not None: updates["make"]  = body.vehicle_make
    if body.vehicle_model is not None: updates["model"] = body.vehicle_model
    if body.vehicle_color is not None: updates["color"] = body.vehicle_color

    if body.linked_student_ids is not None:
        updates["student_ids"] = body.linked_student_ids

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    await asyncio.to_thread(vdoc.reference.update, updates)
    logger.info(
        "Updated vehicle=%s (plate_token→%s) fields=%s school=%s",
        vdoc.id, new_token, list(updates.keys()), school_id,
    )
    return {"plate_token": new_token, "updated": list(updates.keys()), "source": "vehicles"}


@router.patch("/api/v1/plates/{plate_token}")
async def update_plate(plate_token: str, body: PlateUpdateRequest, user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    doc_ref = db.collection("plates").document(plate_token)
    doc = await asyncio.to_thread(doc_ref.get)
    if not doc.exists:
        # The registry list endpoint also surfaces guardian-added
        # vehicles — route those edits to the vehicles collection.
        vdoc = _find_vehicle_doc(plate_token)
        if vdoc is None:
            raise HTTPException(status_code=404, detail="Plate not found")
        return await _update_vehicle(vdoc, body, school_id)
    plate_data = doc.to_dict()
    if plate_data.get("school_id") and plate_data["school_id"] != school_id:
        raise HTTPException(status_code=403, detail="Not authorised to edit this plate")
    updates: dict = {}
    if body.guardian_name is not None:
        updates["parent"] = encrypt_string(body.guardian_name)
    if body.linked_student_ids is not None:
        updates["linked_student_ids"] = body.linked_student_ids
        resolved_names = []
        for sid in body.linked_student_ids:
            sdoc = db.collection("students").document(sid).get()
            if sdoc.exists:
                sdata = sdoc.to_dict()
                full = f"{safe_decrypt(sdata.get('first_name_encrypted'), default='')} {safe_decrypt(sdata.get('last_name_encrypted'), default='')}".strip()
                if full:
                    resolved_names.append(full)
        updates["student_names_encrypted"] = [encrypt_string(n) for n in resolved_names] if len(resolved_names) > 1 else (encrypt_string(resolved_names[0]) if resolved_names else [])
    elif body.student_names is not None:
        names = [n.strip() for n in body.student_names if n.strip()]
        if names:
            updates["student_names_encrypted"] = [encrypt_string(n) for n in names] if len(names) > 1 else encrypt_string(names[0])
    if body.vehicles is not None:
        vehicles_list = []
        for v in body.vehicles:
            veh = {"make": v.make, "model": v.model, "color": v.color}
            if v.plate_number:
                pc = v.plate_number.upper().strip()
                veh["plate_number_encrypted"] = encrypt_string(pc)
                veh["plate_token"] = tokenize_plate(pc)
            vehicles_list.append(veh)
        updates["vehicles"] = vehicles_list
        if vehicles_list and body.vehicles:
            first = body.vehicles[0]
            updates["vehicle_make"] = first.make
            updates["vehicle_model"] = first.model
            updates["vehicle_color"] = first.color
    else:
        if body.vehicle_make is not None:
            updates["vehicle_make"] = body.vehicle_make
        if body.vehicle_model is not None:
            updates["vehicle_model"] = body.vehicle_model
        if body.vehicle_color is not None:
            updates["vehicle_color"] = body.vehicle_color
    if "guardian_photo_url" in body.model_fields_set:
        updates["guardian_photo_url"] = body.guardian_photo_url
    if "student_photo_urls" in body.model_fields_set:
        updates["student_photo_urls"] = body.student_photo_urls
    if body.authorized_guardians is not None:
        auth_plate_tokens, auth_list = [], []
        for ag in body.authorized_guardians:
            entry = {"name_encrypted": encrypt_string(ag.name), "photo_url": ag.photo_url, "vehicle_make": ag.vehicle_make, "vehicle_model": ag.vehicle_model, "vehicle_color": ag.vehicle_color}
            if ag.plate_number:
                pc = ag.plate_number.upper().strip()
                entry["plate_number_encrypted"] = encrypt_string(pc)
                entry["plate_token"] = tokenize_plate(pc)
                auth_plate_tokens.append(entry["plate_token"])
            auth_list.append(entry)
        updates["authorized_guardians"] = auth_list
        updates["authorized_plate_tokens"] = auth_plate_tokens
    if body.blocked_guardians is not None:
        blocked_plate_tokens, blocked_list = [], []
        for bg in body.blocked_guardians:
            entry = {"name_encrypted": encrypt_string(bg.name), "photo_url": bg.photo_url, "vehicle_make": bg.vehicle_make, "vehicle_model": bg.vehicle_model, "vehicle_color": bg.vehicle_color, "reason": bg.reason}
            if bg.plate_number:
                pc = bg.plate_number.upper().strip()
                entry["plate_number_encrypted"] = encrypt_string(pc)
                entry["plate_token"] = tokenize_plate(pc)
                blocked_plate_tokens.append(entry["plate_token"])
            blocked_list.append(entry)
        updates["blocked_guardians"] = blocked_list
        updates["blocked_plate_tokens"] = blocked_plate_tokens
    new_token = plate_token
    if body.plate_number is not None:
        pc = body.plate_number.upper().strip()
        if not pc:
            raise HTTPException(status_code=400, detail="Plate number cannot be blank")
        new_token = tokenize_plate(pc)
        updates["plate_number_encrypted"] = encrypt_string(pc)
        if new_token != plate_token:
            merged = {**plate_data, **updates}
            merged.pop("plate_token", None)
            await asyncio.to_thread(db.collection("plates").document(new_token).set, merged)
            await asyncio.to_thread(doc_ref.delete)
            return {"plate_token": new_token, "updated": list(updates.keys()), "rekeyed": True}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    await asyncio.to_thread(doc_ref.update, updates)
    audit_log(
        action="plate.updated",
        actor=user_data,
        target={"type": "plate", "id": new_token, "display_name": _safe_decrypt(updates.get("plate_number_encrypted")) or plate_token[:12]},
        diff={"fields": list(updates.keys())},
        school_id=school_id,
        message=f"Plate updated ({', '.join(sorted(updates.keys()))})",
    )
    return {"plate_token": new_token, "updated": list(updates.keys())}


@router.post("/api/v1/admin/import-plates")
async def import_plates(records: List[PlateImportRecord], user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    plate_groups: dict = {}
    for rec in records:
        pk = rec.plate_number.upper().strip()
        if pk not in plate_groups:
            plate_groups[pk] = {"guardian_id": rec.guardian_id, "guardian_name": rec.guardian_name, "student_names": [], "vehicle_make": rec.vehicle_make, "vehicle_model": rec.vehicle_model, "vehicle_color": rec.vehicle_color}
        plate_groups[pk]["student_names"].append(rec.student_name)
    batch = db.batch()
    count = 0
    for plate_number, info in plate_groups.items():
        plate_token = tokenize_plate(plate_number)
        doc_ref = db.collection("plates").document(plate_token)
        snames = info["student_names"]
        enc_students = [encrypt_string(n) for n in snames] if len(snames) > 1 else encrypt_string(snames[0])
        batch.set(doc_ref, {"student_names_encrypted": enc_students, "parent": encrypt_string(info["guardian_name"]), "guardian_id_encrypted": encrypt_string(info["guardian_id"]), "plate_number_encrypted": encrypt_string(plate_number), "school_id": school_id, "vehicle_make": info.get("vehicle_make"), "vehicle_model": info.get("vehicle_model"), "vehicle_color": info.get("vehicle_color"), "imported_at": datetime.now(timezone.utc).isoformat()}, merge=True)
        count += 1
        if count % 500 == 0:
            await asyncio.to_thread(batch.commit)
            batch = db.batch()
    if count % 500 != 0:
        await asyncio.to_thread(batch.commit)
    logger.info("Imported %d plate records for school=%s", count, school_id)
    audit_log(
        action="plate.imported",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": school_id},
        diff={"plate_count": count, "row_count": len(records)},
        school_id=school_id,
        message=f"Bulk-imported {count} plate(s) from {len(records)} CSV row(s)",
    )
    return {"status": "imported", "plate_count": count}
