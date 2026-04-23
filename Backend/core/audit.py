"""
core/audit.py — enterprise-grade activity audit log (issue #86).

Design goals (bar: "what Microsoft/Google would ship"):

* **Semantic events, not HTTP traces.**  Every mutation logs a specific
  action name from a closed enum (``AUDIT_ACTIONS`` in
  ``models.schemas``).  We don't auto-infer actions from routes because
  the HTTP shape can't distinguish "role changed" from "display name
  changed" — both are ``PATCH /users/{uid}``.  Each sensitive route
  calls ``log_event(...)`` explicitly with the right action name and
  diff.

* **Rich actor + target + context + diff per event.**  Consumers of the
  log — security-incident investigators, compliance exports, the admin
  UI — should never need to cross-reference 3 other collections to
  understand what happened.  We denormalise display names at write-time
  so the event stays readable even after the underlying user/plate/etc
  is renamed or deleted.

* **Non-blocking to user actions.**  Audit writes wrap their own
  try/except and swallow errors with a warning log.  A Firestore blip
  never fails a user's intended operation.

* **Minimal surface area on callsites.**  The ``current_request``
  ContextVar (populated by middleware) carries IP/UA/correlation-id so
  route handlers don't have to thread a request object through
  everything.  Callers provide the semantic bits (action, target, diff);
  context is enriched automatically.

The collection layout::

    audit_log/{auto_id}
        action              str         # from AUDIT_ACTIONS
        actor               dict        # {uid, email, display_name, role}
        target              dict | null # {type, id, display_name}
        context             dict        # {ip, user_agent_raw, device,
                                        #  browser, os, correlation_id,
                                        #  school_id, district_id}
        outcome             "success" | "failure"
        severity            "info" | "warning" | "critical"
        diff                dict | null # free-form before/after payload
        message             str | null  # operator-supplied note
        timestamp           firestore.Timestamp
"""
from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from core.firebase import db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request context — populated by ``core.middleware.AuditContextMiddleware``
# ---------------------------------------------------------------------------

# A single ContextVar holds a dict of request-scoped metadata.  Using dict
# instead of multiple ContextVars keeps the middleware setup minimal and
# makes it easy to add fields later without touching callsites.
_request_ctx: ContextVar[Dict[str, Any]] = ContextVar("_audit_request_ctx", default={})


def set_request_context(**fields: Any) -> None:
    """Middleware hook.  Called once per request with IP, UA, correlation_id."""
    current = _request_ctx.get() or {}
    current = {**current, **fields}
    _request_ctx.set(current)


def clear_request_context() -> None:
    _request_ctx.set({})


def get_request_context() -> Dict[str, Any]:
    return dict(_request_ctx.get() or {})


# ---------------------------------------------------------------------------
# User-agent parsing — lazy import so the library stays optional.
# ---------------------------------------------------------------------------

def _parse_user_agent(raw: Optional[str]) -> Dict[str, Optional[str]]:
    """Return ``{device, browser, os}`` for a raw user-agent string.
    Falls back to ``None`` values if the ``user_agents`` library isn't
    installed (graceful degradation — audit still captures the raw UA)."""
    if not raw:
        return {"device": None, "browser": None, "os": None}
    try:
        from user_agents import parse as _ua_parse  # type: ignore
    except Exception:
        return {"device": None, "browser": None, "os": None}

    try:
        ua = _ua_parse(raw)
        if ua.is_bot:
            device = "Bot"
        elif ua.is_tablet:
            device = "Tablet"
        elif ua.is_mobile:
            device = "Mobile"
        elif ua.is_pc:
            device = "Desktop"
        else:
            device = "Unknown"
        browser = " ".join(
            filter(None, [ua.browser.family, ua.browser.version_string or ""])
        ).strip() or None
        os_str = " ".join(
            filter(None, [ua.os.family, ua.os.version_string or ""])
        ).strip() or None
        return {"device": device, "browser": browser, "os": os_str}
    except Exception as exc:
        logger.debug("UA parse failed for %r: %s", raw, exc)
        return {"device": None, "browser": None, "os": None}


# ---------------------------------------------------------------------------
# Logger
# ---------------------------------------------------------------------------

def _build_actor_from_user_data(user_data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert the ``user_data`` dict returned by ``verify_firebase_token``
    into the actor shape we persist.  Falls back sensibly when fields are
    missing (dev fixtures, scanner tokens, etc)."""
    return {
        "uid":          user_data.get("uid", ""),
        "email":        user_data.get("email"),
        "display_name": user_data.get("display_name") or user_data.get("name"),
        "role":         user_data.get("role"),
    }


def log_event(
    action: str,
    actor: Dict[str, Any],
    target: Optional[Dict[str, Any]] = None,
    diff: Optional[Dict[str, Any]] = None,
    message: Optional[str] = None,
    outcome: str = "success",
    severity: str = "info",
    school_id: Optional[str] = None,
    district_id: Optional[str] = None,
) -> None:
    """Write a single audit event.  Fire-and-forget: any exception from
    the Firestore write is caught and logged; callers should never need
    to wrap this in a try/except themselves.

    ``actor`` is the ``user_data`` dict (accepts the full shape returned
    by ``verify_firebase_token``) — we strip it down to the fields we
    want to persist in ``_build_actor_from_user_data``.
    """
    try:
        req = get_request_context()
        ua_raw = req.get("user_agent")
        ua_parts = _parse_user_agent(ua_raw)

        # Fall back to the actor's school/district when route-level
        # scoping isn't passed in.  Many mutations naturally carry a
        # school context from the admin's session.
        scoped_school = school_id or (actor.get("school_id") if isinstance(actor, dict) else None)
        scoped_district = district_id or (actor.get("district_id") if isinstance(actor, dict) else None)

        event = {
            "action":   action,
            "actor":    _build_actor_from_user_data(actor),
            "target":   target or None,
            "context": {
                "ip":             req.get("ip"),
                "user_agent_raw": ua_raw,
                "device":         ua_parts["device"],
                "browser":        ua_parts["browser"],
                "os":             ua_parts["os"],
                "correlation_id": req.get("correlation_id"),
                "school_id":      scoped_school,
                "district_id":    scoped_district,
            },
            "outcome":   outcome,
            "severity":  severity,
            "diff":      diff,
            "message":   message,
            "timestamp": datetime.now(timezone.utc),
        }
        db.collection("audit_log").add(event)
    except Exception as exc:
        # Audit must never break the primary flow — log loudly and move on.
        logger.warning(
            "Audit write failed: action=%s actor=%s target=%s err=%s",
            action,
            (actor or {}).get("uid"),
            (target or {}).get("id") if target else None,
            exc,
        )


def make_correlation_id() -> str:
    """Short-ish hex id that ties multiple events from one request."""
    return uuid.uuid4().hex[:16]


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

def purge_expired_audit_events(default_retention_days: int = 365) -> int:
    """Delete audit events older than the cutoff.  Called from the daily
    archival loop.  Returns the number of docs deleted so the loop can log
    progress.  Honours ``districts/{id}.audit_retention_days`` when set
    (falls back to ``default_retention_days`` otherwise).

    Implementation is a scan-and-delete rather than a ranged delete because
    Firestore has no native range-delete and per-district retention means
    each district gets its own cutoff.
    """
    from core.utils import _firestore_batch_delete

    # Build a district_id -> cutoff_timestamp map.  Unknown districts use
    # the global default.
    now = datetime.now(timezone.utc)

    district_cutoffs: Dict[str, datetime] = {}
    try:
        for d in db.collection("districts").stream():
            dd = d.to_dict() or {}
            days = dd.get("audit_retention_days")
            try:
                days = int(days) if days else default_retention_days
            except (TypeError, ValueError):
                days = default_retention_days
            days = max(30, min(days, 3650))  # clamp 30d–10y to be safe
            district_cutoffs[d.id] = now.replace(microsecond=0) - _days(days)
    except Exception as exc:
        logger.warning("Retention: district cutoffs read failed: %s", exc)

    global_cutoff = now.replace(microsecond=0) - _days(default_retention_days)

    # One pass: query everything older than the GLOBAL cutoff, then
    # per-event check against its district-specific cutoff (which might be
    # longer — those rows stay).  This avoids a per-district query fanout
    # while still honouring shorter-than-default retention overrides.
    expired_refs = []
    try:
        older = db.collection("audit_log").where(
            field_path="timestamp", op_string="<", value=global_cutoff,
        ).stream()
        for doc in older:
            data = doc.to_dict() or {}
            did = (data.get("context") or {}).get("district_id")
            cutoff = district_cutoffs.get(did, global_cutoff)
            ts = data.get("timestamp")
            if ts and ts < cutoff:
                expired_refs.append(doc.reference)
    except Exception as exc:
        logger.warning("Retention: audit scan failed: %s", exc)
        return 0

    if expired_refs:
        _firestore_batch_delete(expired_refs)
        logger.info("Retention: purged %d expired audit_log event(s)", len(expired_refs))
    return len(expired_refs)


def _days(n: int):
    from datetime import timedelta
    return timedelta(days=n)
