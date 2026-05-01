"""
Transactional email delivery via Resend (https://resend.com).

Only one send path today: admin / staff invite emails.  Extend as needed.

If RESEND_API_KEY is unset, every send is a no-op that returns False — so
local development and CI don't require email infrastructure.  Callers
should treat `send_invite_email()` as best-effort: the invite flow still
records the invite and returns the link to the UI, so an email failure
never blocks an admin from issuing an invite.
"""
import logging
from typing import Optional

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
) -> bool:
    """Send a transactional invite email via Resend.

    Returns True on successful send, False otherwise (including when the
    Resend API key is unset).  Never raises; failures are logged.

    scope_label — human-readable thing the user is being invited to manage
    (e.g. "Campus 1" or "Default District").  Rendered as supporting text.
    """
    if not RESEND_API_KEY:
        logger.info("Resend not configured; skipping invite email to %s", to_email)
        return False
    if not invite_link:
        logger.warning("No invite link; skipping email to %s", to_email)
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

    try:
        resp = requests.post(
            _RESEND_URL,
            json=payload,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            timeout=10,
        )
    except requests.RequestException as exc:
        logger.warning("Resend request failed for %s: %s", to_email, exc)
        return False
    if resp.status_code >= 300:
        logger.warning(
            "Resend rejected invite to %s: %s %s",
            to_email, resp.status_code, resp.text[:300],
        )
        return False
    logger.info("Invite email sent to %s", to_email)
    return True


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


def send_demo_request_notification(payload: dict) -> bool:
    """Email the team about a new demo request.  Best-effort: returns
    False when Resend isn't configured or the API rejects the send, so
    the route always 200s — we already stored the request in Firestore."""
    if not RESEND_API_KEY:
        logger.info("Resend not configured; skipping demo-request notification")
        return False
    if not DEMO_NOTIFY_EMAIL:
        logger.warning("DEMO_NOTIFY_EMAIL unset; skipping demo-request notification")
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

    try:
        resp = requests.post(
            _RESEND_URL,
            json=body,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            timeout=10,
        )
    except requests.RequestException as exc:
        logger.warning("Resend request failed for demo notification: %s", exc)
        return False
    if resp.status_code >= 300:
        logger.warning(
            "Resend rejected demo notification: %s %s",
            resp.status_code, resp.text[:300],
        )
        return False
    logger.info("Demo-request notification sent to %s", DEMO_NOTIFY_EMAIL)
    return True
