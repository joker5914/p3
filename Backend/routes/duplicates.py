"""Duplicate-plate detector & merge endpoints."""
import logging
from datetime import datetime, timezone
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException

from core.auth import _get_admin_school_ids, require_school_admin
from core.firebase import db
from models.schemas import KeepBothRequest, MergeRequest
from secure_lookup import decrypt_string, safe_decrypt

logger = logging.getLogger(__name__)
router = APIRouter()

_FUZZY_THRESHOLD = 0.75


def _sd(val):
    if not val:
        return None
    try:
        return decrypt_string(val)
    except Exception:
        return None


def _plate_display(data):
    return _sd(data.get("plate_number_encrypted")) or ""


def _guardian_name(data):
    return _sd(data.get("parent")) or ""


def _vehicle_sig(data):
    parts = [data.get("vehicle_make"), data.get("vehicle_model"), data.get("vehicle_color")]
    return " ".join(p for p in parts if p).lower()


def _similar(a, b):
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _summarise(doc_id, data, student_map):
    """Lightweight summary of a plate record for the comparison UI."""
    linked_ids = data.get("linked_student_ids") or []
    students = []
    for sid in linked_ids:
        if sid in student_map:
            s = student_map[sid]
            students.append(f"{s['first_name']} {s['last_name']}".strip())
    if not students:
        enc = data.get("student_names_encrypted")
        if isinstance(enc, list):
            students = [_sd(s) or "(encrypted)" for s in enc]
        elif enc:
            students = [_sd(enc) or "(encrypted)"]

    vehicles = []
    for v in data.get("vehicles") or []:
        vehicles.append({
            "plate_number": _sd(v.get("plate_number_encrypted")),
            "make": v.get("make"), "model": v.get("model"), "color": v.get("color"),
        })
    if not vehicles:
        vehicles.append({
            "plate_number": _plate_display(data),
            "make": data.get("vehicle_make"), "model": data.get("vehicle_model"),
            "color": data.get("vehicle_color"),
        })

    return {
        "plate_token": doc_id,
        "plate_display": _plate_display(data),
        "guardian": _guardian_name(data),
        "students": students,
        "linked_student_ids": linked_ids,
        "vehicles": vehicles,
        "imported_at": data.get("imported_at"),
        "guardian_photo_url": data.get("guardian_photo_url"),
        "auth_count": len(data.get("authorized_guardians") or []),
    }


def _fetch_student_map(ids):
    result = {}
    for sid in ids:
        doc = db.collection("students").document(sid).get()
        if doc.exists:
            d = doc.to_dict()
            result[sid] = {
                "id": sid,
                "first_name": safe_decrypt(d.get("first_name_encrypted"), default=""),
                "last_name": safe_decrypt(d.get("last_name_encrypted"), default=""),
            }
    return result


@router.get("/api/v1/admin/registry/duplicates")
def list_duplicates(user_data: dict = Depends(require_school_admin)):
    """Scan the plates collection for exact-token collisions and fuzzy plate matches."""
    school_ids = _get_admin_school_ids(user_data)

    docs = []
    for sid in school_ids:
        docs.extend(list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=sid)
            .stream()
        ))

    # Load dismissed pairs
    school_id = user_data.get("school_id") or user_data.get("uid")
    dismissed = set()
    try:
        for d in db.collection("duplicate_dismissals").where(
            field_path="school_id", op_string="==", value=school_id
        ).stream():
            pair = d.to_dict()
            dismissed.add(frozenset([pair.get("token_a", ""), pair.get("token_b", "")]))
    except Exception:
        pass

    # Collect all student IDs for batch fetch
    all_sids = set()
    records = []
    for doc in docs:
        data = doc.to_dict()
        for sid in data.get("linked_student_ids") or []:
            all_sids.add(sid)
        records.append((doc.id, data))

    student_map = _fetch_student_map(all_sids)

    # Exact token duplicates (same plate_token appearing in vehicles sub-docs)
    # + fuzzy matching on decrypted plate strings
    pairs = []
    seen_pairs = set()

    # Decrypt plates once
    plate_texts = {}
    for doc_id, data in records:
        plate_texts[doc_id] = _plate_display(data)

    # Fuzzy comparison: O(n^2) but n is per-school, typically small
    for i, (id_a, data_a) in enumerate(records):
        for j in range(i + 1, len(records)):
            id_b, data_b = records[j]
            pair_key = frozenset([id_a, id_b])
            if pair_key in seen_pairs or pair_key in dismissed:
                continue

            plate_a, plate_b = plate_texts[id_a], plate_texts[id_b]
            reason = None

            # Exact token match (shouldn't happen often but can via re-imports)
            if id_a == id_b:
                continue

            # Exact plate text match
            if plate_a and plate_b and plate_a.upper() == plate_b.upper():
                reason = "exact_plate"
            # Fuzzy plate match
            elif plate_a and plate_b and _similar(plate_a, plate_b) >= _FUZZY_THRESHOLD:
                reason = "similar_plate"
            # Same guardian + similar vehicle
            elif _guardian_name(data_a) and _guardian_name(data_b):
                g_sim = _similar(_guardian_name(data_a), _guardian_name(data_b))
                v_sim = _similar(_vehicle_sig(data_a), _vehicle_sig(data_b))
                if g_sim >= 0.85 and v_sim >= _FUZZY_THRESHOLD:
                    reason = "guardian_vehicle"

            if reason:
                seen_pairs.add(pair_key)
                pairs.append({
                    "reason": reason,
                    "a": _summarise(id_a, data_a, student_map),
                    "b": _summarise(id_b, data_b, student_map),
                })

    logger.info("Duplicates scan: %d pairs found for school=%s", len(pairs), school_id)
    return {"pairs": pairs, "total": len(pairs)}


@router.post("/api/v1/admin/registry/merge")
def merge_plates(body: MergeRequest, user_data: dict = Depends(require_school_admin)):
    """Merge two plate records: keep one, discard the other, re-parent children."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    keep_ref = db.collection("plates").document(body.keep_token)
    discard_ref = db.collection("plates").document(body.discard_token)
    keep_doc = keep_ref.get()
    discard_doc = discard_ref.get()

    if not keep_doc.exists:
        raise HTTPException(404, "Keep-record not found")
    if not discard_doc.exists:
        raise HTTPException(404, "Discard-record not found")

    keep_data = keep_doc.to_dict()
    discard_data = discard_doc.to_dict()

    for rec, label in [(keep_data, "keep"), (discard_data, "discard")]:
        if rec.get("school_id") and rec["school_id"] != school_id:
            raise HTTPException(403, f"Not authorised to modify {label} record")

    # Merge linked students
    keep_sids = set(keep_data.get("linked_student_ids") or [])
    for sid in discard_data.get("linked_student_ids") or []:
        keep_sids.add(sid)

    # Merge authorized guardians
    keep_auth = list(keep_data.get("authorized_guardians") or [])
    for ag in discard_data.get("authorized_guardians") or []:
        keep_auth.append(ag)

    # Merge vehicles
    keep_vehicles = list(keep_data.get("vehicles") or [])
    for v in discard_data.get("vehicles") or []:
        keep_vehicles.append(v)

    updates = {
        "linked_student_ids": list(keep_sids),
        "authorized_guardians": keep_auth,
        "vehicles": keep_vehicles,
    }
    keep_ref.update(updates)

    # Audit trail
    db.collection("merge_audit").add({
        "school_id": school_id,
        "action": "merge",
        "keep_token": body.keep_token,
        "discard_token": body.discard_token,
        "performed_by": user_data.get("uid"),
        "performed_at": datetime.now(timezone.utc).isoformat(),
    })

    discard_ref.delete()
    logger.info("Merged plate %s into %s school=%s", body.discard_token, body.keep_token, school_id)
    return {"status": "merged", "keep_token": body.keep_token}


@router.post("/api/v1/admin/registry/keep-both")
def keep_both(body: KeepBothRequest, user_data: dict = Depends(require_school_admin)):
    """Mark two records as intentionally distinct — hides them from future scans."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    db.collection("duplicate_dismissals").add({
        "school_id": school_id,
        "token_a": body.token_a,
        "token_b": body.token_b,
        "reason": body.reason,
        "performed_by": user_data.get("uid"),
        "performed_at": datetime.now(timezone.utc).isoformat(),
    })

    db.collection("merge_audit").add({
        "school_id": school_id,
        "action": "keep_both",
        "token_a": body.token_a,
        "token_b": body.token_b,
        "reason": body.reason,
        "performed_by": user_data.get("uid"),
        "performed_at": datetime.now(timezone.utc).isoformat(),
    })

    logger.info("Keep-both: %s & %s school=%s", body.token_a, body.token_b, school_id)
    return {"status": "dismissed"}
