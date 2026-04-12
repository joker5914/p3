"""Shared utility functions used across route handlers."""
import hashlib
import hmac
import logging
import secrets
import string
from datetime import datetime
from typing import Optional

from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE

logger = logging.getLogger(__name__)


def generate_hash(plate: str, timestamp: datetime) -> str:
    from core.firebase import SECRET_KEY
    message = f"{plate}{timestamp.isoformat()}".encode()
    return hmac.new(SECRET_KEY, message, hashlib.sha256).hexdigest()


def _format_timestamp(ts) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, str):
        return ts
    return ts.isoformat()


def _localise(ts: datetime) -> datetime:
    tz = ZoneInfo(DEVICE_TIMEZONE)
    if ts.tzinfo is None:
        return ts.replace(tzinfo=tz)
    return ts.astimezone(tz)


def _decrypt_students(plate_info: dict):
    from secure_lookup import safe_decrypt
    if "student_names_encrypted" in plate_info:
        enc = plate_info["student_names_encrypted"]
        if isinstance(enc, list):
            return [safe_decrypt(s, default="") for s in enc], enc
        return safe_decrypt(enc, default=""), enc
    enc = plate_info.get("student_name")
    if enc:
        return safe_decrypt(enc, default=""), enc
    return None, None


def _firestore_batch_delete(refs: list):
    from core.firebase import db
    CHUNK = 500
    for i in range(0, len(refs), CHUNK):
        batch = db.batch()
        for ref in refs[i: i + CHUNK]:
            batch.delete(ref)
        batch.commit()


def _mark_picked_up(firestore_id: str, pickup_method: str, dismissed_by_uid: str):
    from core.firebase import db
    tz = ZoneInfo(DEVICE_TIMEZONE)
    db.collection("plate_scans").document(firestore_id).update({
        "picked_up_at": datetime.now(tz),
        "pickup_method": pickup_method,
        "dismissed_by_uid": dismissed_by_uid,
    })


def _mark_bulk_picked_up(firestore_ids: list, pickup_method: str, dismissed_by_uid: str):
    from core.firebase import db
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    CHUNK = 500
    for i in range(0, len(firestore_ids), CHUNK):
        batch = db.batch()
        for fid in firestore_ids[i: i + CHUNK]:
            ref = db.collection("plate_scans").document(fid)
            batch.update(ref, {
                "picked_up_at": now,
                "pickup_method": pickup_method,
                "dismissed_by_uid": dismissed_by_uid,
            })
        batch.commit()


def _get_active_firestore_ids(school_id: str) -> list:
    from core.firebase import db
    scans = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )
    return [scan.id for scan in scans if not scan.to_dict().get("picked_up_at")]


def _find_firestore_ids_by_plate_token(school_id: str, plate_token: str) -> list:
    from core.firebase import db
    scans = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .stream()
    )
    return [scan.id for scan in scans if not scan.to_dict().get("picked_up_at")]


def _generate_enrollment_code(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))
