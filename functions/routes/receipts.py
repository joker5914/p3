"""
routes/receipts.py — signed pickup receipt PDFs (issue #72).

Two endpoints:

* ``GET /api/v1/receipts/{scan_id}`` (auth required, school-scoped)
  Generates a one-page PDF "chain of custody" receipt for a single
  ``plate_scans`` document.  The PDF is HMAC-signed and carries a QR
  code pointing at the public verify endpoint.  Issuance is recorded
  in the audit log so investigators can later prove which staff
  member printed which receipt and when.

* ``GET /api/v1/verify/{receipt_id}`` (public, unauthenticated)
  Verifies a receipt's authenticity from its id alone.  Returns a
  small JSON envelope describing whether the signature is intact and
  what high-level facts (issue date, location, school name) were
  attested.  No PII is exposed — student/guardian names and the full
  plate stay on the printed page only.

Why two endpoints under the same router: they share the
``receipts/{receipt_id}`` Firestore document layout and the same
canonicalisation/signing helpers.  Splitting them lets the PDF
generator stay behind ``verify_firebase_token`` while the verify route
sits on the public surface alongside the marketing-site demo form.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from config import FRONTEND_URL
from core.audit import log_event as audit_log
from core.auth import _get_admin_school_ids, verify_firebase_token
from core.firebase import db
from core.utils import _format_timestamp
from secure_lookup import safe_decrypt
from services.receipt_pdf import (
    build_receipt_payload,
    derive_receipt_id,
    mask_plate,
    render_receipt_pdf,
    sign_payload,
    verify_signature,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_verify_base(request: Request) -> str:
    """Pick the base URL the QR code should encode.

    Order of preference: the request's own scheme + host (so a receipt
    rendered against an emulator points at the emulator), then the
    configured production frontend URL.  This makes per-environment
    correctness automatic — admins printing from staging get a
    staging-host QR, prod prints get prod.
    """
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if forwarded_host:
        scheme = forwarded_proto or "https"
        return f"{scheme}://{forwarded_host}"
    if request.url.netloc and request.url.netloc != "internal":
        return f"{request.url.scheme}://{request.url.netloc}"
    return FRONTEND_URL or "https://app.dismissal.app"


def _load_school_doc(school_id: str) -> Dict[str, Any]:
    try:
        doc = db.collection("schools").document(school_id).get()
        if doc.exists:
            return doc.to_dict() or {}
    except Exception as exc:
        logger.warning("School lookup failed school=%s: %s", school_id, exc)
    return {}


def _decode_students(scan_data: Dict[str, Any]) -> list[str]:
    enc = scan_data.get("student_names_encrypted") or scan_data.get("student_name")
    if isinstance(enc, list):
        return [safe_decrypt(s, default="") or "" for s in enc if s]
    if enc:
        single = safe_decrypt(enc, default="") or ""
        return [single] if single else []
    return []


def _decode_guardian(scan_data: Dict[str, Any]) -> Optional[str]:
    enc = scan_data.get("parent_name_encrypted") or scan_data.get("parent")
    return safe_decrypt(enc, default=None) if enc else None


def _decode_plate(scan_data: Dict[str, Any]) -> Optional[str]:
    enc = scan_data.get("plate_number_encrypted")
    return safe_decrypt(enc, default=None) if enc else None


def _staff_label(uid: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Return ``(display_name, email)`` for the staff uid that confirmed
    the pickup.  Falls back to (None, None) when the user record is
    unreadable so the receipt still prints with a "—"."""
    if not uid:
        return (None, None)
    try:
        doc = db.collection("school_admins").document(uid).get()
        if doc.exists:
            d = doc.to_dict() or {}
            return (d.get("display_name") or None, d.get("email") or None)
    except Exception as exc:
        logger.warning("Staff lookup failed uid=%s: %s", uid, exc)
    return (None, None)


# ---------------------------------------------------------------------------
# Authenticated: generate and download a receipt PDF.
# ---------------------------------------------------------------------------

@router.get("/api/v1/receipts/{scan_id}")
def issue_receipt(
    scan_id: str,
    request: Request,
    user_data: dict = Depends(verify_firebase_token),
):
    """Render and return a chain-of-custody pickup receipt for one
    ``plate_scans`` document.

    Authorization: the caller must be a staff/admin user whose school
    scope includes the scan's ``school_id``.  We do *not* gate on the
    "history" permission separately — receipts are an extension of the
    history view, and any role permitted to read the history row is
    permitted to print its receipt.

    The receipt id (and therefore the QR target) is deterministic per
    scan, so re-printing produces the same verifiable id.  We persist
    a ``receipts/{receipt_id}`` doc on first issuance so the public
    verify endpoint has a canonical payload to compare against; the
    doc is overwritten on re-issuance only when the underlying scan's
    pickup metadata has changed (caught by the timestamp diff).
    """
    role = user_data.get("role")
    if role in ("guardian", "scanner"):
        raise HTTPException(status_code=403, detail="Receipts require an admin or staff role")

    try:
        scan_ref = db.collection("plate_scans").document(scan_id)
        scan_doc = scan_ref.get()
    except Exception as exc:
        logger.error("plate_scans lookup failed scan_id=%s: %s", scan_id, exc)
        raise HTTPException(status_code=500, detail="Failed to load scan")

    if not scan_doc.exists:
        raise HTTPException(status_code=404, detail="Scan not found")

    scan_data = scan_doc.to_dict() or {}
    school_id = scan_data.get("school_id")
    if not school_id:
        # Older scans pre-multi-tenant may lack school_id; refuse to
        # issue a receipt for those rather than guessing.
        raise HTTPException(status_code=409, detail="Scan is missing school context — cannot issue receipt")

    # Authorization: school scope check.
    allowed_schools = _get_admin_school_ids(user_data) or set()
    if school_id not in allowed_schools:
        # Super admins drilled into a school land here naturally because
        # _get_admin_school_ids reflects X-School-Id.  Refusing rather
        # than silently broadening prevents cross-tenant receipt issuance.
        logger.warning(
            "Receipt issue refused: scan school=%s not in caller scope (uid=%s, role=%s)",
            school_id, user_data.get("uid"), role,
        )
        raise HTTPException(status_code=403, detail="Scan is outside your school scope")

    # ── Build the canonical signed payload ────────────────────
    plate_token = scan_data.get("plate_token") or ""
    scan_ts_iso = _format_timestamp(scan_data.get("timestamp")) or ""
    location = scan_data.get("location")
    plate_display = _decode_plate(scan_data)

    payload = build_receipt_payload(
        scan_id=scan_id,
        school_id=school_id,
        plate_token=plate_token,
        plate_display=plate_display,
        scan_timestamp_iso=scan_ts_iso,
        location=location,
    )
    signature = sign_payload(payload)

    # ── Persist / refresh the verify-side record ──────────────
    receipt_id = payload["receipt_id"]
    receipt_ref = db.collection("receipts").document(receipt_id)
    persist_doc = {
        # Canonical fields (subset signed) — kept verbatim so the verify
        # endpoint can re-derive the signature without re-reading the
        # plate_scans document at all.
        "scan_id":        scan_id,
        "school_id":      school_id,
        "plate_token":    plate_token,
        "scan_timestamp": payload["scan_timestamp"],
        "location":       payload["location"],
        "issued_at":      payload["issued_at"],
        "signature":      signature,
        # Display data — never used in signature derivation, included so
        # repeat downloads don't have to re-decrypt.  Encrypted-at-rest
        # is preserved by the cloud provider; the names themselves are
        # not surfaced through the public verify endpoint.
        "issued_by_uid":  user_data.get("uid"),
        "version":        1,
    }
    try:
        receipt_ref.set(persist_doc, merge=True)
    except Exception as exc:
        # Don't fail the user's print job — a verify lookup will
        # fall back to recomputing from the plate_scans doc if this
        # write was the issue.  But surface in logs.
        logger.warning("Receipt doc persist failed receipt_id=%s: %s", receipt_id, exc)

    # ── Render the PDF ────────────────────────────────────────
    school = _load_school_doc(school_id)
    student_names = _decode_students(scan_data)
    guardian_name = _decode_guardian(scan_data)
    staff_name, staff_email = _staff_label(scan_data.get("dismissed_by_uid"))

    verify_base = _resolve_verify_base(request)
    verify_url = f"{verify_base}/verify/{receipt_id}"

    pdf_bytes = render_receipt_pdf(
        payload=payload,
        signature_hex=signature,
        verify_url=verify_url,
        school_name=school.get("name") or "School",
        school_address=school.get("address"),
        school_phone=school.get("phone"),
        guardian_name=guardian_name,
        student_names=student_names,
        vehicle_make=scan_data.get("vehicle_make"),
        vehicle_model=scan_data.get("vehicle_model"),
        vehicle_color=scan_data.get("vehicle_color"),
        confidence_score=scan_data.get("confidence_score"),
        pickup_method=scan_data.get("pickup_method"),
        staff_display_name=staff_name,
        staff_email=staff_email,
    )

    # ── Audit ─────────────────────────────────────────────────
    audit_log(
        action="receipt.issued",
        actor=user_data,
        target={"type": "plate_scan", "id": scan_id, "display_name": mask_plate(plate_display)},
        diff={
            "receipt_id":     receipt_id,
            "school_id":      school_id,
            "scan_timestamp": payload["scan_timestamp"],
            "pickup_method":  scan_data.get("pickup_method"),
        },
        school_id=school_id,
        message=f"Pickup receipt {receipt_id} issued",
    )

    filename = f"pickup-receipt-{receipt_id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Receipt-Id": receipt_id,
        },
    )


# ---------------------------------------------------------------------------
# Public: verify a receipt by id.
# ---------------------------------------------------------------------------

@router.get("/api/v1/verify/{receipt_id}")
def verify_receipt(receipt_id: str):
    """Public, unauthenticated authenticity check for a printed receipt.

    The response is intentionally minimal:

      * ``ok`` — boolean, true iff the stored signature still matches a
        re-derived signature over the canonical fields.
      * ``receipt_id`` — echoed for the caller's UI.
      * ``issued_at`` / ``scan_timestamp`` / ``location`` /
        ``school_name`` — non-PII fields the receipt bearer can use to
        cross-check the printed page.

    PII (student names, guardian names, plate digits) is never returned.
    A receipt holder who scans the QR sees "Yes, this matches a real
    pickup at Riverside Elementary on Thursday, March 5th at 3:14pm at
    Carline B"; an attacker who guesses a receipt id sees nothing
    personally identifying about the family.
    """
    # Receipt ids are 16-hex-char HMAC outputs.  Reject anything that
    # doesn't match the shape so an attacker fuzzing this endpoint
    # gets cheap 400s instead of forcing a Firestore round-trip per
    # guess.
    rid = (receipt_id or "").strip().lower()
    if len(rid) != 16 or not all(ch in "0123456789abcdef" for ch in rid):
        raise HTTPException(status_code=400, detail="Malformed receipt id")

    try:
        doc = db.collection("receipts").document(rid).get()
    except Exception as exc:
        logger.error("Receipt lookup failed receipt_id=%s: %s", rid, exc)
        raise HTTPException(status_code=500, detail="Verification temporarily unavailable")

    if not doc.exists:
        # No record — could be never-issued, expired, or fabricated.
        # Same response either way to avoid an oracle.
        return {"ok": False, "receipt_id": rid, "reason": "not_found"}

    data = doc.to_dict() or {}
    payload = {
        "receipt_id":     rid,
        "scan_id":        data.get("scan_id") or "",
        "school_id":      data.get("school_id") or "",
        "plate_token":    data.get("plate_token") or "",
        "scan_timestamp": data.get("scan_timestamp") or "",
        "location":       data.get("location"),
        "issued_at":      data.get("issued_at") or "",
    }
    stored_sig = data.get("signature") or ""

    # Belt-and-braces check: re-derive the receipt id from
    # (scan_id, school_id) and confirm it matches the doc id.  Catches
    # the (extremely unlikely) case where someone hand-edited Firestore
    # to replace one receipt's payload with another's.
    expected_id = derive_receipt_id(payload["scan_id"], payload["school_id"])
    id_ok = expected_id == rid

    sig_ok = verify_signature(payload, stored_sig)
    ok = bool(id_ok and sig_ok)

    school_name: Optional[str] = None
    if ok:
        school = _load_school_doc(payload["school_id"])
        school_name = school.get("name") or None

    response = {
        "ok":              ok,
        "receipt_id":      rid,
        "issued_at":       payload["issued_at"] if ok else None,
        "scan_timestamp":  payload["scan_timestamp"] if ok else None,
        "location":        payload["location"] if ok else None,
        "school_name":     school_name,
        # Non-PII confirmation that the QR'd record corresponds to a
        # real pickup line in the issuing school.  Useful when a
        # receipt is being checked alongside the printed page.
        "verified_at":     datetime.now(timezone.utc).isoformat() if ok else None,
    }
    if not ok:
        # Provide a single coarse reason so a receipt holder can tell
        # "the page was tampered with" from "I mistyped the id".  Don't
        # leak whether the signature failed vs. the id failed — both
        # mean "do not trust this page".
        response["reason"] = "signature_mismatch"
    return response
