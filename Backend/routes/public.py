"""Public, unauthenticated endpoints exposed to the marketing site.

Anything in this router is reachable without a Firebase token, so every
handler must validate input strictly and treat the caller as adversarial.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Request

from core.email import send_demo_request_notification
from core.firebase import db
from models.schemas import DemoRequestCreate

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/public/demo-requests")
def create_demo_request(body: DemoRequestCreate, request: Request):
    """Capture a marketing-site demo request.

    Stores the request in Firestore (`demo_requests/{auto_id}`) and
    fires off a best-effort notification email to the team.  Honeypot:
    if `website` is populated, silently 200 without storing or
    emailing — bots that filled the hidden field get no feedback signal.

    Always returns 200 with `{ ok: true }` once basic validation passes
    so the form UX is consistent regardless of whether email + Firestore
    succeed.  Persistent failures are logged for investigation.
    """
    if body.website:
        # Honeypot tripped — pretend success.
        logger.info("Demo-request honeypot tripped from %s", request.client.host if request.client else "?")
        return {"ok": True}

    payload = {
        "name":            body.name,
        "work_email":      body.work_email,
        "school_name":     body.school_name,
        "role":            body.role,
        "students_count":  body.students_count,
        "preferred_times": body.preferred_times,
        "message":         body.message,
        "submitted_at":    datetime.now(timezone.utc),
        # Request metadata helps us spot abuse patterns later without
        # storing PII beyond what the form already collects.
        "user_agent":      (request.headers.get("user-agent") or "")[:500],
        "ip":              request.client.host if request.client else None,
        "status":          "new",
    }

    try:
        db.collection("demo_requests").add(payload)
    except Exception as exc:
        # Don't fail the request — without storage we still want the
        # email to fire so the team isn't ghosted.  Log and continue.
        logger.warning("Failed to store demo request: %s", exc)

    # Email is best-effort.  Storage above is the source of truth.
    try:
        send_demo_request_notification(payload)
    except Exception as exc:
        logger.warning("Demo-request notification raised unexpectedly: %s", exc)

    return {"ok": True}
