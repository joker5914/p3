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


def _render_invite_html(*, recipient_name: str, role_label: str, scope_label: str,
                        invite_link: str, inviter_name: str, product: str) -> str:
    safe_name = recipient_name or "there"
    inviter   = inviter_name or "a colleague"
    return f"""<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
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
