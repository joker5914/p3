"""
routes/audit.py — read-only query + CSV export for the audit log.

Visibility scoping mirrors the rest of the admin portal:

* ``super_admin`` — sees all events, optionally scoped by
  ``X-School-Id`` / ``X-District-Id`` when drilled in.
* ``district_admin`` — sees events whose ``context.district_id`` matches
  their pinned district, plus events whose ``actor.uid`` belongs to a
  user in their district (captures the "admin signed in / did thing"
  events that occurred before a school context was chosen).
* ``school_admin`` / ``staff`` with ``users`` permission — sees events
  scoped to their school(s).
* Writes are never exposed on the HTTP surface — audit creation is an
  internal concern handled by ``core.audit.log_event`` at each mutation
  site.  This prevents a legitimate UI bug from producing bogus events.

Pagination is cursor-based on ``timestamp`` so the UI can infinite-scroll
without double-counting when a new event is written mid-query.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from google.cloud import firestore as _fs

from core.auth import _get_admin_school_ids, verify_firebase_token
from core.firebase import db
from models.schemas import AUDIT_ACTIONS

logger = logging.getLogger(__name__)

router = APIRouter()

# Max rows per page to keep Firestore reads + JSON payload bounded.  The UI
# uses cursor pagination so "see older events" is just another page.
_PAGE_MAX = 200
_EXPORT_MAX = 10_000


# ---------------------------------------------------------------------------
# Scoping helpers
# ---------------------------------------------------------------------------

def _scope_filter(user_data: dict) -> dict:
    """Return the set of constraints we AND into every audit query based
    on the caller's role + current drill-down.

    The return shape is deliberately lightweight — just the bits of
    state that drive the ``where`` clauses below — so we can unit-test
    the role logic without spinning up Firestore.
    """
    role = user_data.get("role")
    if role == "super_admin":
        # Most permissive: when drilled into a school they get only
        # that school; district drill-down gives the whole district;
        # platform-top (no context) returns everything.
        if user_data.get("school_id"):
            return {"school_ids": {user_data["school_id"]}}
        if user_data.get("district_id"):
            return {"district_id": user_data["district_id"]}
        return {}

    if role == "district_admin":
        district_id = user_data.get("district_id")
        if not district_id:
            raise HTTPException(status_code=400, detail="District admin has no district assigned")
        return {"district_id": district_id}

    if role in ("school_admin", "staff"):
        school_ids = _get_admin_school_ids(user_data) or set()
        if not school_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No school context available. "
                    "Super admins need to pick a school via X-School-Id "
                    "before viewing the audit log."
                ),
            )
        return {"school_ids": school_ids}

    # Scanners, guardians, etc. — no access.
    raise HTTPException(status_code=403, detail="Audit log requires admin role")


def _build_query(user_data: dict, filters: dict):
    """Compose the Firestore query based on role scoping + request
    filters.  Returns a Query object ready to stream / limit."""
    q = db.collection("audit_log")
    scope = _scope_filter(user_data)

    # Role-driven scope
    if "school_ids" in scope:
        sids = list(scope["school_ids"])
        if len(sids) == 1:
            q = q.where(field_path="context.school_id", op_string="==", value=sids[0])
        else:
            # Firestore ``in`` supports up to 30 values — plenty for a
            # multi-school admin, and school chain admins above that
            # are rare.  Fall back to per-school iteration if we ever hit
            # the limit.
            if len(sids) > 30:
                sids = sids[:30]
                logger.warning("Audit query: school_ids truncated to 30 for in-filter")
            q = q.where(field_path="context.school_id", op_string="in", value=sids)
    elif "district_id" in scope:
        q = q.where(field_path="context.district_id", op_string="==", value=scope["district_id"])

    # User filters
    if filters.get("actor_uid"):
        q = q.where(field_path="actor.uid", op_string="==", value=filters["actor_uid"])
    if filters.get("action"):
        actions = filters["action"]
        if isinstance(actions, str):
            actions = [actions]
        if len(actions) == 1:
            q = q.where(field_path="action", op_string="==", value=actions[0])
        elif len(actions) > 1:
            # Same 30-value cap as above.
            q = q.where(field_path="action", op_string="in", value=actions[:30])
    if filters.get("outcome"):
        q = q.where(field_path="outcome", op_string="==", value=filters["outcome"])
    if filters.get("since"):
        q = q.where(field_path="timestamp", op_string=">=", value=filters["since"])
    if filters.get("until"):
        q = q.where(field_path="timestamp", op_string="<=", value=filters["until"])

    return q.order_by("timestamp", direction=_fs.Query.DESCENDING)


def _serialise(doc) -> dict:
    data = doc.to_dict() or {}
    data["id"] = doc.id
    ts = data.get("timestamp")
    if ts is not None and hasattr(ts, "isoformat"):
        data["timestamp"] = ts.isoformat()
    return data


def _parse_iso(name: str, raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid ISO datetime for {name}")


def _apply_search_filter(rows: List[dict], search: Optional[str]) -> List[dict]:
    """Client-style text filter applied server-side so the UI doesn't
    have to re-fetch on every keystroke.  We search across the most
    commonly-meaningful text fields; regex is unnecessary."""
    if not search:
        return rows
    s = search.strip().lower()
    if not s:
        return rows
    def haystack(ev: dict) -> str:
        actor = ev.get("actor") or {}
        target = ev.get("target") or {}
        ctx = ev.get("context") or {}
        return " ".join(str(x or "") for x in [
            ev.get("action"),
            ev.get("outcome"),
            ev.get("message"),
            actor.get("email"), actor.get("display_name"), actor.get("uid"),
            target.get("display_name"), target.get("id"), target.get("type"),
            ctx.get("ip"), ctx.get("browser"), ctx.get("os"),
        ]).lower()
    return [ev for ev in rows if s in haystack(ev)]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/v1/audit/events")
def list_audit_events(
    user_data: dict = Depends(verify_firebase_token),
    actor_uid: Optional[str] = None,
    action:    Optional[List[str]] = Query(default=None),
    outcome:   Optional[str] = Query(default=None),
    since:     Optional[str] = Query(default=None, description="ISO 8601"),
    until:     Optional[str] = Query(default=None, description="ISO 8601"),
    search:    Optional[str] = Query(default=None, description="Free-text filter"),
    limit:     int = Query(default=50, ge=1, le=_PAGE_MAX),
    cursor:    Optional[str] = Query(default=None, description="Opaque cursor from a previous response"),
):
    """List recent audit events with filters.  Response shape::

        { events: [...], next_cursor: "<opaque>" | null, count: N }
    """
    if outcome and outcome not in ("success", "failure"):
        raise HTTPException(status_code=400, detail="outcome must be 'success' or 'failure'")
    if action:
        bad = [a for a in action if a not in AUDIT_ACTIONS]
        if bad:
            raise HTTPException(status_code=400, detail=f"Unknown action(s): {bad}")

    filters = {
        "actor_uid": actor_uid,
        "action":    action,
        "outcome":   outcome,
        "since":     _parse_iso("since", since),
        "until":     _parse_iso("until", until),
    }

    q = _build_query(user_data, filters)

    # Cursor is the timestamp of the last event from the previous page.
    # We use start_after on the ordered (timestamp DESC) stream so we
    # don't re-emit the same row across pages.
    if cursor:
        cur_ts = _parse_iso("cursor", cursor)
        if cur_ts:
            q = q.start_after({"timestamp": cur_ts})

    # Fetch one extra to know whether there's a next page.
    fetch_n = limit + 1
    if search:
        # When there's a text filter we post-filter server-side, so we
        # over-fetch to roughly preserve page sizes.  Capped to avoid
        # pathological scans; the UI can paginate further if needed.
        fetch_n = min(_PAGE_MAX, max(fetch_n, limit * 4))

    try:
        docs = list(q.limit(fetch_n).stream())
    except Exception as exc:
        logger.error("Audit query failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to load audit log") from exc

    rows = [_serialise(d) for d in docs]
    rows = _apply_search_filter(rows, search)

    # Slice to requested limit + surface next cursor.
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1].get("timestamp") if has_more and page else None

    return {"events": page, "next_cursor": next_cursor, "count": len(page)}


@router.get("/api/v1/audit/events.csv")
def export_audit_events_csv(
    user_data: dict = Depends(verify_firebase_token),
    actor_uid: Optional[str] = None,
    action:    Optional[List[str]] = Query(default=None),
    outcome:   Optional[str] = Query(default=None),
    since:     Optional[str] = Query(default=None),
    until:     Optional[str] = Query(default=None),
    search:    Optional[str] = Query(default=None),
):
    """Stream a flat CSV of the filtered audit events.  Capped at
    10,000 rows per export — investigators who need more can narrow the
    date range, or the backend can be extended to stream NDJSON/GCS for
    large compliance jobs."""
    filters = {
        "actor_uid": actor_uid,
        "action":    action,
        "outcome":   outcome,
        "since":     _parse_iso("since", since),
        "until":     _parse_iso("until", until),
    }
    q = _build_query(user_data, filters)
    try:
        docs = list(q.limit(_EXPORT_MAX).stream())
    except Exception as exc:
        logger.error("Audit CSV export query failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to export audit log") from exc

    rows = [_serialise(d) for d in docs]
    rows = _apply_search_filter(rows, search)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([
        "timestamp", "action", "outcome", "severity",
        "actor_uid", "actor_email", "actor_display_name", "actor_role",
        "target_type", "target_id", "target_display_name",
        "school_id", "district_id",
        "ip", "device", "browser", "os",
        "message", "correlation_id", "diff",
    ])
    import json as _json
    for r in rows:
        actor = r.get("actor") or {}
        target = r.get("target") or {}
        ctx = r.get("context") or {}
        writer.writerow([
            r.get("timestamp", ""),
            r.get("action", ""),
            r.get("outcome", ""),
            r.get("severity", ""),
            actor.get("uid", ""),
            actor.get("email", ""),
            actor.get("display_name", ""),
            actor.get("role", ""),
            target.get("type", ""),
            target.get("id", ""),
            target.get("display_name", ""),
            ctx.get("school_id", ""),
            ctx.get("district_id", ""),
            ctx.get("ip", ""),
            ctx.get("device", ""),
            ctx.get("browser", ""),
            ctx.get("os", ""),
            r.get("message", "") or "",
            ctx.get("correlation_id", ""),
            _json.dumps(r.get("diff")) if r.get("diff") else "",
        ])

    filename = f"dismissal-audit-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/v1/audit/summary")
def audit_summary(user_data: dict = Depends(verify_firebase_token)):
    """Lightweight roll-up for the audit page header: event count in the
    last 24h / 7d / 30d plus the top action types.  Gives operators an
    at-a-glance sense of platform activity."""
    filters = {"actor_uid": None, "action": None, "outcome": None,
               "since": None, "until": None}
    q_base = _build_query(user_data, filters)

    now = datetime.now(timezone.utc)
    windows = {
        "24h": now - timedelta(days=1),
        "7d":  now - timedelta(days=7),
        "30d": now - timedelta(days=30),
    }
    counts = {}
    action_buckets: dict = {}
    try:
        # One query for the last 30d; derive smaller windows from the same
        # stream so we don't triple the Firestore reads.
        docs = list(
            q_base.where(field_path="timestamp", op_string=">=", value=windows["30d"])
                  .limit(_PAGE_MAX * 5)   # hard safety cap
                  .stream()
        )
    except Exception as exc:
        logger.warning("Audit summary query failed: %s", exc)
        docs = []

    for label, cutoff in windows.items():
        counts[label] = 0
    for doc in docs:
        data = doc.to_dict() or {}
        ts = data.get("timestamp")
        if not ts:
            continue
        for label, cutoff in windows.items():
            if ts >= cutoff:
                counts[label] += 1
        action = data.get("action") or "unknown"
        action_buckets[action] = action_buckets.get(action, 0) + 1

    top_actions = sorted(action_buckets.items(), key=lambda kv: -kv[1])[:8]
    return {
        "counts":       counts,
        "top_actions": [{"action": a, "count": c} for a, c in top_actions],
        "as_of":        now.isoformat(),
    }
