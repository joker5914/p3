"""
Transactional email delivery via Resend (https://resend.com).

Every send (success, failure, or skipped-because-unconfigured) writes a
structured row to ``email_log/{auto_id}`` so a Platform Admin can see
exactly what happened — recipient, provider response, error code, the
whole picture — without leaving the portal or pulling Cloud Run logs.

If RESEND_API_KEY is unset, every send is a no-op that returns False —
so local development and CI don't require email infrastructure.  The
skipped attempt is still logged (status="skipped", reason="not_configured")
so an operator can see "the user clicked Invite but no email left the
building" instead of silently nothing.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import requests

from config import (
    DEMO_NOTIFY_EMAIL,
    FRONTEND_URL,
    INVITE_PRODUCT_NAME,
    RESEND_API_KEY,
    RESEND_FROM_EMAIL,
    RESEND_REPLY_TO,
)

logger = logging.getLogger(__name__)

_RESEND_URL = "https://api.resend.com/emails"

_ROLE_LABELS = {
    "district_admin": "District Admin",
    "school_admin":   "Admin",
    "staff":          "Staff",
}

# Truncate provider error bodies so a malicious or chatty 500 can't bloat
# the email_log collection.  500 chars is more than enough to hold any
# real Resend error response.
_MAX_ERROR_BODY = 500


# ---------------------------------------------------------------------------
# Structured logging — every send writes to email_log/{auto_id}
# ---------------------------------------------------------------------------

def _audit_request_ctx() -> Dict[str, Optional[str]]:
    """Best-effort lookup of correlation_id + IP from the audit ContextVar
    populated by AuditContextMiddleware.  Returns a consistent shape even
    when called outside an HTTP request (scheduled jobs)."""
    try:
        from core.audit import get_request_context
        ctx = get_request_context() or {}
        return {
            "correlation_id": ctx.get("correlation_id"),
            "ip":             ctx.get("ip"),
        }
    except Exception:
        return {"correlation_id": None, "ip": None}


def _actor_fields(actor: Optional[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    """Flatten the ``user_data`` dict that admin routes already carry into
    the small set of fields we want denormalised on the email_log row."""
    if not actor:
        return {"actor_uid": None, "actor_email": None, "actor_role": None}
    return {
        "actor_uid":   actor.get("uid"),
        "actor_email": actor.get("email"),
        "actor_role":  actor.get("role"),
    }


def _log_send(
    *,
    kind: str,
    to: str,
    from_email: Optional[str],
    subject: str,
    status: str,
    http_status: Optional[int] = None,
    provider_id: Optional[str] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
    actor: Optional[Dict[str, Any]] = None,
) -> None:
    """Persist a single send attempt to ``email_log``.  Fire-and-forget;
    a Firestore blip never bubbles up to the caller — the original logger
    line is still emitted via the standard logging module."""
    try:
        from core.firebase import db
        doc = {
            "timestamp":     datetime.now(timezone.utc),
            "kind":          kind,
            "to":            to,
            "from_email":    from_email,
            "subject":       subject,
            "status":        status,           # sent | failed | skipped
            "provider":      "resend",
            "http_status":   http_status,
            "provider_id":   provider_id,
            "error_code":    error_code,
            "error_message": (error_message or "")[:_MAX_ERROR_BODY] or None,
            "meta":          meta or {},
            **_actor_fields(actor),
            **_audit_request_ctx(),
        }
        db.collection("email_log").add(doc)
    except Exception as exc:
        logger.warning("email_log write failed (kind=%s to=%s): %s", kind, to, exc)


def _resend_send(
    *,
    kind: str,
    to_email: str,
    subject: str,
    payload: Dict[str, Any],
    meta: Optional[Dict[str, Any]] = None,
    actor: Optional[Dict[str, Any]] = None,
) -> bool:
    """Single chokepoint for every Resend POST.  Performs the request,
    classifies the response, writes a structured email_log row, and
    returns True only on a 2xx delivery acceptance.

    ``payload`` is the full JSON body for the Resend API; ``kind``,
    ``to_email``, and ``subject`` are passed separately so the log row
    stays queryable without parsing the payload back out.
    """
    from_email = payload.get("from")

    # Pre-flight checks — config issues never reach the Resend API but
    # we still log them so the admin sees the symptom in the log.
    if not RESEND_API_KEY:
        logger.info("Resend not configured; skipping %s email to %s", kind, to_email)
        _log_send(
            kind=kind, to=to_email, from_email=from_email, subject=subject,
            status="skipped", error_code="not_configured",
            error_message="RESEND_API_KEY is not set",
            meta=meta, actor=actor,
        )
        return False
    if not to_email:
        _log_send(
            kind=kind, to="", from_email=from_email, subject=subject,
            status="skipped", error_code="missing_recipient",
            error_message="to_email was empty",
            meta=meta, actor=actor,
        )
        return False
    if not from_email:
        logger.warning("RESEND_FROM_EMAIL unset; skipping %s email to %s", kind, to_email)
        _log_send(
            kind=kind, to=to_email, from_email=None, subject=subject,
            status="skipped", error_code="missing_from",
            error_message="RESEND_FROM_EMAIL is not set",
            meta=meta, actor=actor,
        )
        return False

    try:
        resp = requests.post(
            _RESEND_URL,
            json=payload,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            timeout=10,
        )
    except requests.RequestException as exc:
        logger.warning("Resend request failed for %s to %s: %s", kind, to_email, exc)
        _log_send(
            kind=kind, to=to_email, from_email=from_email, subject=subject,
            status="failed", http_status=None,
            error_code="network_error",
            error_message=str(exc),
            meta=meta, actor=actor,
        )
        return False

    body_text = resp.text or ""
    body_json: Dict[str, Any] = {}
    try:
        body_json = resp.json() if body_text else {}
    except ValueError:
        body_json = {}

    if resp.status_code >= 300:
        # Resend error bodies look like {"name":"validation_error",
        # "message":"...","statusCode":403}.  Pull both fields when present
        # so the UI can surface the human message without re-parsing.
        err_code = (body_json.get("name") if isinstance(body_json, dict) else None) or "http_error"
        err_msg  = (body_json.get("message") if isinstance(body_json, dict) else None) or body_text
        logger.warning(
            "Resend rejected %s to %s: %s %s",
            kind, to_email, resp.status_code, body_text[:_MAX_ERROR_BODY],
        )
        _log_send(
            kind=kind, to=to_email, from_email=from_email, subject=subject,
            status="failed", http_status=resp.status_code,
            error_code=err_code, error_message=err_msg,
            meta=meta, actor=actor,
        )
        return False

    provider_id = body_json.get("id") if isinstance(body_json, dict) else None
    logger.info("%s email sent to %s (resend id=%s)", kind, to_email, provider_id)
    _log_send(
        kind=kind, to=to_email, from_email=from_email, subject=subject,
        status="sent", http_status=resp.status_code,
        provider_id=provider_id,
        meta=meta, actor=actor,
    )
    return True


# ---------------------------------------------------------------------------
# Invite email
# ---------------------------------------------------------------------------

def _wordmark_img(height_px: int = 28) -> str:
    """Brand wordmark <img> for email headers.  Uses the fixed-navy
    light variant because email clients don't reliably support
    `currentColor`.  Falls back to the product text if FRONTEND_URL
    is unset (no absolute base — broken <img src> would render an
    ugly placeholder, so we just skip the image)."""
    if not FRONTEND_URL:
        return ""
    src = f"{FRONTEND_URL.rstrip('/')}/brand/dismissal-wordmark-light.svg"
    return (
        f'<p style="margin: 0 0 24px;">'
        f'<img src="{src}" alt="Dismissal" height="{height_px}" '
        f'style="height:{height_px}px;width:auto;display:block;border:0;" />'
        f'</p>'
    )


def _render_invite_html(*, recipient_name: str, role_label: str, scope_label: str,
                        invite_link: str, inviter_name: str, product: str) -> str:
    safe_name = recipient_name or "there"
    inviter   = inviter_name or "a colleague"
    wordmark  = _wordmark_img()
    return f"""<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
    {wordmark}
    <h2 style="margin: 0 0 12px; font-size: 20px;">You've been invited to {product}</h2>
    <p style="margin: 0 0 12px; line-height: 1.5;">Hi {safe_name},</p>
    <p style="margin: 0 0 12px; line-height: 1.5;">
      {inviter} has invited you to join <strong>{product}</strong> as a
      <strong>{role_label}</strong>{f' for <strong>{scope_label}</strong>' if scope_label else ''}.
    </p>
    <p style="margin: 0 0 16px; line-height: 1.5;">Click the button below to set your password and sign in:</p>
    <p style="margin: 0 0 20px;">
      <a href="{invite_link}" style="display: inline-block; background: #25ABE2; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: 600;">Set password &amp; sign in</a>
    </p>
    <p style="margin: 0 0 8px; line-height: 1.5; font-size: 13px; color: #555;">
      If the button doesn't work, copy and paste this link into your browser:
    </p>
    <p style="margin: 0 0 20px; line-height: 1.5; font-size: 12px; word-break: break-all; color: #555;">
      {invite_link}
    </p>
    <p style="margin: 0; line-height: 1.5; font-size: 12px; color: #888;">
      This link expires after first use. If you weren't expecting this invite, you can safely ignore this email.
    </p>
  </body>
</html>"""


def _render_invite_text(*, recipient_name: str, role_label: str, scope_label: str,
                        invite_link: str, inviter_name: str, product: str) -> str:
    safe_name = recipient_name or "there"
    inviter   = inviter_name or "a colleague"
    scope = f" for {scope_label}" if scope_label else ""
    return (
        f"Hi {safe_name},\n\n"
        f"{inviter} has invited you to join {product} as a {role_label}{scope}.\n\n"
        f"Set your password and sign in here:\n{invite_link}\n\n"
        f"This link expires after first use. If you weren't expecting this invite, "
        f"you can safely ignore this email.\n"
    )


def send_invite_email(
    *,
    to_email: str,
    to_name: Optional[str],
    role: str,
    invite_link: str,
    inviter_name: Optional[str] = None,
    scope_label: Optional[str] = None,
    actor: Optional[Dict[str, Any]] = None,
) -> bool:
    """Send a transactional invite email via Resend.

    Returns True on successful send, False otherwise (including when the
    Resend API key is unset).  Never raises; failures are logged.

    scope_label — human-readable thing the user is being invited to manage
    (e.g. "Campus 1" or "Default District").  Rendered as supporting text.
    """
    if not invite_link:
        logger.warning("No invite link; skipping email to %s", to_email)
        _log_send(
            kind="invite", to=to_email, from_email=RESEND_FROM_EMAIL,
            subject="You've been invited",
            status="skipped", error_code="missing_invite_link",
            error_message="No invite link was generated",
            meta={"role": role, "to_name": to_name, "scope_label": scope_label},
            actor=actor,
        )
        return False

    product = INVITE_PRODUCT_NAME or "Dismissal"
    role_label = _ROLE_LABELS.get(role, role.replace("_", " ").title())
    tpl_args = {
        "recipient_name": (to_name or "").strip(),
        "role_label":     role_label,
        "scope_label":    (scope_label or "").strip(),
        "invite_link":    invite_link,
        "inviter_name":   (inviter_name or "").strip(),
        "product":        product,
    }
    subject = f"You've been invited to {product}"

    payload = {
        "from":    RESEND_FROM_EMAIL,
        "to":      [to_email],
        "subject": subject,
        "html":    _render_invite_html(**tpl_args),
        "text":    _render_invite_text(**tpl_args),
    }
    if RESEND_REPLY_TO:
        payload["reply_to"] = RESEND_REPLY_TO

    return _resend_send(
        kind="invite",
        to_email=to_email,
        subject=subject,
        payload=payload,
        meta={
            "role":         role,
            "role_label":   role_label,
            "scope_label":  scope_label or None,
            "to_name":      to_name or None,
            "inviter_name": inviter_name or None,
            # First ~80 chars of the link is enough to identify the flow
            # (action mode + apiKey) without persisting full single-use
            # tokens to Firestore.
            "invite_link_prefix": (invite_link or "")[:80],
        },
        actor=actor,
    )


# ---------------------------------------------------------------------------
# Demo-request lead notification (marketing site → team inbox)
# ---------------------------------------------------------------------------

def _esc(value: Optional[str]) -> str:
    """Minimal HTML escape for email body interpolation.  We don't render
    untrusted HTML — just plain text inside <p>/<td> — but interpolating
    user input without escaping leaves a stored-XSS vector if the inbox
    surfaces these emails in a webmail client that renders tags."""
    if value is None:
        return ""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _render_demo_html(payload: dict) -> str:
    rows = [
        ("Name",            payload.get("name")),
        ("Work email",      payload.get("work_email")),
        ("School / org",    payload.get("school_name")),
        ("Role",            payload.get("role")),
        ("Students",        payload.get("students_count") or "—"),
        ("Preferred times", payload.get("preferred_times") or "—"),
    ]
    rows_html = "\n".join(
        f'<tr><td style="padding:6px 12px 6px 0;color:#555;white-space:nowrap;'
        f'vertical-align:top;">{_esc(label)}</td>'
        f'<td style="padding:6px 0;color:#1a1a1a;">{_esc(value)}</td></tr>'
        for label, value in rows
    )
    message = payload.get("message")
    message_block = (
        f'<p style="margin:18px 0 6px;color:#555;font-size:13px;">Message</p>'
        f'<div style="padding:12px 14px;background:#f6f6f4;border-radius:6px;'
        f'white-space:pre-wrap;color:#1a1a1a;line-height:1.5;">{_esc(message)}</div>'
        if message else ""
    )
    return f"""<!DOCTYPE html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">
    {_wordmark_img(height_px=24)}
    <h2 style="margin:0 0 4px;font-size:18px;">New demo request</h2>
    <p style="margin:0 0 18px;color:#666;font-size:13px;">Submitted via the marketing site.</p>
    <table style="border-collapse:collapse;font-size:14px;width:100%;">
      {rows_html}
    </table>
    {message_block}
    <p style="margin:24px 0 0;color:#888;font-size:12px;">
      Reply directly to this email to reach the requester.
    </p>
  </body>
</html>"""


def _render_demo_text(payload: dict) -> str:
    lines = [
        "New demo request",
        "",
        f"Name:            {payload.get('name', '')}",
        f"Work email:      {payload.get('work_email', '')}",
        f"School / org:    {payload.get('school_name', '')}",
        f"Role:            {payload.get('role', '')}",
        f"Students:        {payload.get('students_count') or '—'}",
        f"Preferred times: {payload.get('preferred_times') or '—'}",
    ]
    if payload.get("message"):
        lines += ["", "Message:", payload["message"]]
    lines += ["", "Reply to this email to reach the requester."]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Temporary-vehicle expiry notice (issue #80)
# ---------------------------------------------------------------------------

def _render_temp_expiry_html(*, recipient_name: str, plate_number: str,
                             vehicle_desc: str, reason: str) -> str:
    safe_name = recipient_name or "there"
    plate_html = _esc(plate_number) or "(unknown plate)"
    desc_html  = _esc(vehicle_desc) or "Vehicle"
    reason_block = (
        f'<p style="margin: 0 0 12px; line-height: 1.5; color: #555; font-size: 13px;">'
        f'<strong style="color:#1a1a1a;">Original reason:</strong> {_esc(reason)}'
        f'</p>'
        if reason else ""
    )
    wordmark = _wordmark_img()
    return f"""<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
    {wordmark}
    <h2 style="margin: 0 0 12px; font-size: 20px;">A temporary vehicle was removed</h2>
    <p style="margin: 0 0 12px; line-height: 1.5;">Hi {safe_name},</p>
    <p style="margin: 0 0 12px; line-height: 1.5;">
      Your temporary vehicle <strong>{desc_html}</strong> (<strong>{plate_html}</strong>) reached
      its expiry date and has been removed from your Dismissal account so the registry stays
      tidy. The school will no longer recognise this plate at pickup.
    </p>
    {reason_block}
    <p style="margin: 0 0 16px; line-height: 1.5;">
      If you still need to use this vehicle for pickup, sign in and register it again
      (either as a permanent vehicle or a new temporary one).
    </p>
    <p style="margin: 0; line-height: 1.5; font-size: 12px; color: #888;">
      You're receiving this email because you registered a temporary vehicle on your
      Dismissal account.
    </p>
  </body>
</html>"""


def _render_temp_expiry_text(*, recipient_name: str, plate_number: str,
                             vehicle_desc: str, reason: str) -> str:
    safe_name = recipient_name or "there"
    reason_line = f"Original reason: {reason}\n\n" if reason else ""
    return (
        f"Hi {safe_name},\n\n"
        f"Your temporary vehicle {vehicle_desc} ({plate_number}) reached its expiry date "
        f"and has been removed from your Dismissal account. The school will no longer "
        f"recognise this plate at pickup.\n\n"
        f"{reason_line}"
        f"If you still need to use this vehicle for pickup, sign in and register it "
        f"again (either as a permanent vehicle or a new temporary one).\n"
    )


def send_temp_vehicle_expiry_email(
    *,
    to_email: str,
    to_name: Optional[str],
    plate_number: str,
    vehicle_desc: str,
    reason: Optional[str] = None,
) -> bool:
    """Notify a guardian that one of their temporary vehicles has been
    auto-removed.  Best-effort — returns False (and logs) if Resend is
    unconfigured or the API rejects the send; the underlying delete still
    happens regardless so the registry doesn't drift out of sync."""
    product = INVITE_PRODUCT_NAME or "Dismissal"
    subject = f"{product}: temporary vehicle expired ({plate_number})"
    tpl_args = {
        "recipient_name": (to_name or "").strip(),
        "plate_number":   plate_number or "",
        "vehicle_desc":   vehicle_desc or "",
        "reason":         (reason or "").strip(),
    }
    payload = {
        "from":    RESEND_FROM_EMAIL,
        "to":      [to_email],
        "subject": subject,
        "html":    _render_temp_expiry_html(**tpl_args),
        "text":    _render_temp_expiry_text(**tpl_args),
    }
    if RESEND_REPLY_TO:
        payload["reply_to"] = RESEND_REPLY_TO

    return _resend_send(
        kind="temp_expiry",
        to_email=to_email,
        subject=subject,
        payload=payload,
        meta={
            "plate_number": plate_number,
            "vehicle_desc": vehicle_desc,
            "reason":       reason or None,
            "to_name":      to_name or None,
        },
    )


def send_demo_request_notification(payload: dict) -> bool:
    """Email the team about a new demo request.  Best-effort: returns
    False when Resend isn't configured or the API rejects the send, so
    the route always 200s — we already stored the request in Firestore."""
    if not DEMO_NOTIFY_EMAIL:
        logger.warning("DEMO_NOTIFY_EMAIL unset; skipping demo-request notification")
        _log_send(
            kind="demo_request", to="", from_email=RESEND_FROM_EMAIL,
            subject="Demo request",
            status="skipped", error_code="missing_demo_notify",
            error_message="DEMO_NOTIFY_EMAIL is not set",
            meta={"work_email": payload.get("work_email"),
                  "school_name": payload.get("school_name")},
        )
        return False

    subject = f"Demo request — {payload.get('school_name') or 'unnamed school'}"
    body = {
        "from":    RESEND_FROM_EMAIL,
        "to":      [DEMO_NOTIFY_EMAIL],
        "subject": subject,
        "html":    _render_demo_html(payload),
        "text":    _render_demo_text(payload),
    }
    # Reply-To set to the requester so hitting Reply lands in their inbox,
    # not in our shared from-address.
    if payload.get("work_email"):
        body["reply_to"] = payload["work_email"]

    return _resend_send(
        kind="demo_request",
        to_email=DEMO_NOTIFY_EMAIL,
        subject=subject,
        payload=body,
        meta={
            "work_email":  payload.get("work_email"),
            "school_name": payload.get("school_name"),
            "name":        payload.get("name"),
            "role":        payload.get("role"),
        },
    )
