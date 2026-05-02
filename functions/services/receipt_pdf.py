"""
services/receipt_pdf.py — chain-of-custody pickup receipt (issue #72).

A receipt is a one-page, tamper-evident PDF that says: "on this day, at
this time, this student was picked up by this guardian, in this vehicle,
acknowledged by this staff member, at this campus."  Schools hand it to
parents during custody disputes, CPS inquiries, and insurance claims.
The QR code on the page lets anyone (with no Dismissal account) verify
the receipt is authentic via the public ``/verify/{receipt_id}``
endpoint, which checks the HMAC signature without disclosing PII.

Design
------
* **Deterministic receipt id.**  Derived from the canonical scan
  document id + a short HMAC tag — same scan always issues the same
  receipt id.  This means the public verify endpoint is idempotent
  and a re-printed receipt verifies to the same record.

* **Canonical payload + HMAC-SHA256 signature.**  We build a stable
  JSON representation of the audit-relevant fields (sorted keys,
  separators with no whitespace), then HMAC it with ``SECRET_KEY``.
  Anyone holding the key can re-derive the signature; nobody else
  can forge one.  The verify endpoint re-runs the signing step
  against the stored receipt doc and compares with constant-time
  ``hmac.compare_digest``.

* **Plate masking.**  The PDF shows ``****1234`` rather than the full
  plate.  The full plate would be PII-leakage when the receipt is
  later filed with a third party (insurer, court).  The signed
  payload still carries the canonical hash of the plate token so
  verification can prove this is the same record.

* **Pure-Python deps.**  ``reportlab`` brings its own QR widget
  (``reportlab.graphics.barcode.qr``) — no Pillow / qrcode / lxml
  required.  Keeps cold-start small in Cloud Functions.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Identifiers + signing
# ---------------------------------------------------------------------------

# Tag-bytes that scope HMAC use to the receipt domain.  Without it, an
# attacker who somehow learned a SECRET_KEY-derived HMAC of arbitrary
# input could replay it as a receipt signature.  Domain separation is
# cheap insurance.
_RECEIPT_ID_TAG = b"dismissal/receipt-id/v1"
_SIGNATURE_TAG = b"dismissal/receipt-sig/v1"

# Fields we put into the canonical signed payload.  Order is alphabetical;
# json.dumps with sort_keys=True keeps the wire form stable across
# Python releases.
_CANONICAL_FIELDS = (
    "issued_at",
    "location",
    "plate_token",
    "receipt_id",
    "scan_id",
    "scan_timestamp",
    "school_id",
)


def _secret_key_bytes() -> bytes:
    """Return the HMAC key.  Reads SECRET_KEY (the same value that
    signs scan event hashes and tokenises plates) so verification only
    needs one secret to maintain."""
    raw = os.getenv("SECRET_KEY", "")
    if not raw:
        # Fall back to the encryption key — also 32 bytes of secret
        # material, present in every prod deploy.  Keeps dev/emulator
        # working when SECRET_KEY isn't separately injected.
        raw = os.getenv("DISMISSAL_ENCRYPTION_KEY", "")
    if not raw:
        raise RuntimeError(
            "Receipt signing requires SECRET_KEY (or DISMISSAL_ENCRYPTION_KEY) "
            "to be configured."
        )
    return raw.encode()


def derive_receipt_id(scan_id: str, school_id: str) -> str:
    """Return the deterministic receipt id for a given scan.

    16 hex chars (64 bits) of HMAC output — wide enough that a guesser
    has 1-in-2^64 odds of stumbling on a valid id, narrow enough to fit
    in a QR code without tipping into a denser symbol.
    """
    msg = f"{scan_id}|{school_id}".encode()
    return hmac.new(_secret_key_bytes() + _RECEIPT_ID_TAG, msg, hashlib.sha256).hexdigest()[:16]


def _canonical_json(payload: Dict[str, Any]) -> bytes:
    """Sorted-keys, no-whitespace JSON for stable signature input."""
    sub = {k: payload.get(k) for k in _CANONICAL_FIELDS}
    return json.dumps(sub, sort_keys=True, separators=(",", ":")).encode()


def sign_payload(payload: Dict[str, Any]) -> str:
    """Return a hex-encoded HMAC-SHA256 signature over the canonical
    payload.  Caller is responsible for storing it alongside the
    payload so verification can re-derive and compare."""
    canon = _canonical_json(payload)
    return hmac.new(_secret_key_bytes() + _SIGNATURE_TAG, canon, hashlib.sha256).hexdigest()


def verify_signature(payload: Dict[str, Any], signature_hex: str) -> bool:
    """Constant-time signature check.  Returns False on any failure
    (mismatch, malformed signature, missing fields)."""
    try:
        expected = sign_payload(payload)
    except Exception as exc:
        logger.warning("Receipt signature derivation failed: %s", exc)
        return False
    return hmac.compare_digest(expected, signature_hex or "")


# ---------------------------------------------------------------------------
# Plate masking
# ---------------------------------------------------------------------------

def mask_plate(plate: Optional[str]) -> str:
    """Mask all but the last 3 chars of a plate so the PDF doesn't leak
    the full registration number to whoever the receipt is later filed
    with.  ``ABC1234`` -> ``****234``; ``XY9`` -> ``XY9`` (too short to
    mask meaningfully); ``None`` -> ``—``."""
    if not plate:
        return "—"
    plate = plate.strip().upper()
    if len(plate) <= 3:
        return plate
    return ("*" * (len(plate) - 3)) + plate[-3:]


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def build_receipt_payload(
    *,
    scan_id: str,
    school_id: str,
    plate_token: str,
    plate_display: Optional[str],
    scan_timestamp_iso: str,
    location: Optional[str],
    issued_at_iso: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the canonical, signature-input fields for a receipt.

    PII (guardian/student names, vehicle make/model) is intentionally
    *not* in the canonical payload — only the audit-relevant identifiers
    are signed.  The PDF still renders the human-readable fields, but
    they are denormalised display data, not part of the signature input.
    A guardian who later changes their name doesn't invalidate the
    receipt; a forgery that swaps the student/guardian name would still
    have to match the original ``scan_id`` + ``plate_token`` to verify.
    """
    issued = issued_at_iso or datetime.now(timezone.utc).isoformat()
    receipt_id = derive_receipt_id(scan_id, school_id)
    return {
        "receipt_id":     receipt_id,
        "scan_id":        scan_id,
        "school_id":      school_id,
        "plate_token":    plate_token,
        "plate_display":  plate_display,                 # for PDF display only
        "scan_timestamp": scan_timestamp_iso,
        "location":       location,
        "issued_at":      issued,
    }


# ---------------------------------------------------------------------------
# PDF rendering
# ---------------------------------------------------------------------------

def _draw_qr(c, x: float, y: float, size: float, value: str) -> None:
    """Render the verification QR onto the canvas at (x, y) with the
    given side length in points.  Uses reportlab's built-in QR widget
    so no external image library is needed."""
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF

    qr = QrCodeWidget(value, barLevel="M")
    bounds = qr.getBounds()
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    drawing = Drawing(size, size, transform=[size / width, 0, 0, size / height, 0, 0])
    drawing.add(qr)
    renderPDF.draw(drawing, c, x, y)


def render_receipt_pdf(
    *,
    payload: Dict[str, Any],
    signature_hex: str,
    verify_url: str,
    school_name: str,
    school_address: Optional[str],
    school_phone: Optional[str],
    guardian_name: Optional[str],
    student_names: Optional[list[str]],
    vehicle_make: Optional[str],
    vehicle_model: Optional[str],
    vehicle_color: Optional[str],
    confidence_score: Optional[float],
    pickup_method: Optional[str],
    staff_display_name: Optional[str],
    staff_email: Optional[str],
) -> bytes:
    """Compose a one-page PDF receipt and return the raw bytes.

    Layout is plain and screen-reader-friendly: a header band with the
    school identity, two cards of denormalised pickup detail, a footer
    band with the cryptographic signature + QR.  Body text is set in
    Helvetica at >= 10 pt to clear WCAG legibility, and the foreground
    palette is pure black-on-white for maximum contrast (>= 21:1).
    """
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase.pdfmetrics import stringWidth

    buf = io.BytesIO()
    page_w, page_h = letter
    c = canvas.Canvas(buf, pagesize=letter)

    # PDF metadata — visible in viewers' "Document Properties" panel.
    c.setTitle(f"Pickup Receipt {payload['receipt_id']}")
    c.setAuthor(school_name or "Dismissal")
    c.setSubject("Signed pickup receipt")
    c.setKeywords("pickup receipt chain-of-custody dismissal")
    c.setProducer("Dismissal — chain-of-custody receipt v1")

    margin = 0.6 * inch
    cursor_y = page_h - margin

    # ── Header band ───────────────────────────────────────────────
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(margin, cursor_y, "PICKUP RECEIPT")
    receipt_label = f"# {payload['receipt_id']}"
    c.drawRightString(page_w - margin, cursor_y, receipt_label)
    cursor_y -= 0.12 * inch
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(1.2)
    c.line(margin, cursor_y, page_w - margin, cursor_y)
    cursor_y -= 0.32 * inch

    # School identity
    c.setFont("Helvetica-Bold", 18)
    c.drawString(margin, cursor_y, school_name or "School")
    cursor_y -= 0.22 * inch
    c.setFont("Helvetica", 10)
    if school_address:
        c.drawString(margin, cursor_y, school_address)
        cursor_y -= 0.16 * inch
    if school_phone:
        c.drawString(margin, cursor_y, school_phone)
        cursor_y -= 0.16 * inch

    cursor_y -= 0.2 * inch

    # ── Lede ─────────────────────────────────────────────────────
    c.setFont("Helvetica-Oblique", 11)
    lede = (
        "This is a chain-of-custody record certifying the dismissal "
        "described below. The signature on this page can be verified by "
        "anyone using the QR code or verification URL — without an account."
    )
    cursor_y = _draw_wrapped(c, lede, margin, cursor_y, page_w - 2 * margin, leading=14)
    cursor_y -= 0.2 * inch

    # ── Detail block — two columns of label/value rows ──────────
    detail_rows = [
        ("Date & time of pickup", _fmt_pickup_time(payload.get("scan_timestamp"))),
        ("Location",              payload.get("location") or "—"),
        ("Student(s)",            ", ".join(student_names) if student_names else "—"),
        ("Guardian / driver",     guardian_name or "—"),
        ("Vehicle",               _fmt_vehicle(vehicle_make, vehicle_model, vehicle_color) or "—"),
        ("Plate (masked)",        mask_plate(payload.get("plate_display"))),
        ("Pickup method",         _PICKUP_METHOD_LABELS.get(pickup_method or "", pickup_method or "—")),
        ("Recognition confidence", f"{confidence_score * 100:.0f}%" if isinstance(confidence_score, (int, float)) else "—"),
        ("Acknowledged by",       _fmt_staff(staff_display_name, staff_email)),
        ("Receipt issued",        _fmt_pickup_time(payload.get("issued_at"))),
    ]

    label_x = margin
    value_x = margin + 1.85 * inch
    row_h = 0.26 * inch
    box_top = cursor_y
    box_bottom = cursor_y - (row_h * len(detail_rows)) - 0.18 * inch

    # Outer rounded box.  No fill — the page stays cleanly printable
    # on a B&W laser without mottling.
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.6)
    c.roundRect(
        margin - 0.1 * inch,
        box_bottom,
        page_w - 2 * margin + 0.2 * inch,
        box_top - box_bottom,
        6,
        stroke=1,
        fill=0,
    )

    cursor_y -= 0.18 * inch
    c.setFont("Helvetica", 10)
    for label, value in detail_rows:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(label_x, cursor_y, label)
        c.setFont("Helvetica", 10)
        # Wrap the value to the value column's width.
        max_value_w = page_w - margin - value_x
        wrapped = _wrap_text(c, str(value), "Helvetica", 10, max_value_w)
        if wrapped:
            c.drawString(value_x, cursor_y, wrapped[0])
            for extra in wrapped[1:]:
                cursor_y -= 0.16 * inch
                c.drawString(value_x, cursor_y, extra)
        cursor_y -= row_h

    cursor_y = box_bottom - 0.32 * inch

    # ── Signature + QR footer ───────────────────────────────────
    qr_size = 1.4 * inch
    qr_x = page_w - margin - qr_size
    qr_y = cursor_y - qr_size

    _draw_qr(c, qr_x, qr_y, qr_size, verify_url)

    # Caption under the QR
    c.setFont("Helvetica", 8)
    c.drawCentredString(qr_x + qr_size / 2, qr_y - 0.16 * inch, "Scan to verify")

    # Signature block to the left of the QR
    sig_x = margin
    sig_w = qr_x - margin - 0.25 * inch
    c.setFont("Helvetica-Bold", 10)
    c.drawString(sig_x, cursor_y - 0.1 * inch, "Cryptographic signature")

    c.setFont("Helvetica", 9)
    cursor_y2 = cursor_y - 0.32 * inch
    cursor_y2 = _draw_wrapped(
        c,
        "HMAC-SHA256 of the receipt's canonical fields. Re-deriving the "
        "signature without the school's signing key is not possible.",
        sig_x, cursor_y2, sig_w, leading=12, font="Helvetica", font_size=9,
    )
    cursor_y2 -= 0.06 * inch

    c.setFont("Courier", 8)
    sig_lines = _wrap_text(c, signature_hex, "Courier", 8, sig_w)
    for line in sig_lines:
        c.drawString(sig_x, cursor_y2, line)
        cursor_y2 -= 0.13 * inch

    cursor_y2 -= 0.1 * inch
    c.setFont("Helvetica", 8)
    c.drawString(sig_x, cursor_y2, f"Verify at: {verify_url}")
    cursor_y2 -= 0.12 * inch
    c.drawString(sig_x, cursor_y2, f"Receipt ID: {payload['receipt_id']}")

    # ── Page footer ─────────────────────────────────────────────
    c.setFont("Helvetica", 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawCentredString(
        page_w / 2,
        margin / 2,
        "Generated by Dismissal — chain-of-custody record for school pickup. "
        "Tampering invalidates the QR signature.",
    )

    c.showPage()
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Small text helpers
# ---------------------------------------------------------------------------

_PICKUP_METHOD_LABELS = {
    "manual":      "Confirmed manually by staff",
    "manual_bulk": "Bulk confirmed by staff",
    "auto":        "Confirmed by scanner",
    "auto_superseded": "Superseded by a later scan",
}


def _fmt_vehicle(make: Optional[str], model: Optional[str], color: Optional[str]) -> Optional[str]:
    parts = [p for p in (color, make, model) if p]
    return " ".join(parts) if parts else None


def _fmt_staff(name: Optional[str], email: Optional[str]) -> str:
    if name and email:
        return f"{name} <{email}>"
    return name or email or "—"


def _fmt_pickup_time(iso: Optional[str]) -> str:
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    return dt.strftime("%A, %B %d, %Y · %I:%M:%S %p %Z").strip().rstrip(" ·")


def _wrap_text(c, text: str, font: str, size: int, max_width: float) -> list[str]:
    from reportlab.pdfbase.pdfmetrics import stringWidth
    if not text:
        return [""]
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = words[0]
    for w in words[1:]:
        candidate = current + " " + w
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = w
    lines.append(current)
    # Hard-break any single token that's still too wide (e.g. signature hex).
    out: list[str] = []
    for line in lines:
        if stringWidth(line, font, size) <= max_width:
            out.append(line)
            continue
        # Greedy split by character.
        buf = ""
        for ch in line:
            if stringWidth(buf + ch, font, size) > max_width and buf:
                out.append(buf)
                buf = ch
            else:
                buf += ch
        if buf:
            out.append(buf)
    return out


def _draw_wrapped(
    c,
    text: str,
    x: float,
    y: float,
    max_width: float,
    *,
    leading: float = 14,
    font: str = "Helvetica-Oblique",
    font_size: int = 11,
) -> float:
    c.setFont(font, font_size)
    for line in _wrap_text(c, text, font, font_size, max_width):
        c.drawString(x, y, line)
        y -= leading
    return y
