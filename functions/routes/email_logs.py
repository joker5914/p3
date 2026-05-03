"""
routes/email_logs.py — Platform Admin view of every transactional email
attempt routed through ``core.email``.

Reads from the ``email_log`` collection populated by ``core.email._log_send``.
Super-admin only: invite/temp-expiry/demo notifications carry recipient
addresses and provider error bodies that lower-tier admins shouldn't see.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from google.cloud import firestore as _fs

from core.auth import require_super_admin
from core.firebase import db

logger = logging.getLogger(__name__)

router = APIRouter()

_PAGE_MAX = 200

# Closed enums so a typo'd query string doesn't silently return zero rows.
_KINDS    = {"invite", "temp_expiry", "demo_request"}
_STATUSES = {"sent", "failed", "skipped"}


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


def _apply_search(rows: List[dict], search: Optional[str]) -> List[dict]:
    if not search:
        return rows
    s = search.strip().lower()
    if not s:
        return rows

    def haystack(row: dict) -> str:
        meta = row.get("meta") or {}
        return " ".join(str(x or "") for x in [
            row.get("to"),
            row.get("from_email"),
            row.get("subject"),
            row.get("status"),
            row.get("kind"),
            row.get("error_code"),
            row.get("error_message"),
            row.get("provider_id"),
            row.get("actor_email"),
            row.get("actor_uid"),
            meta.get("role"),
            meta.get("to_name"),
            meta.get("scope_label"),
            meta.get("inviter_name"),
        ]).lower()

    return [r for r in rows if s in haystack(r)]


@router.get("/api/v1/admin/email-logs")
def list_email_logs(
    user_data: dict = Depends(require_super_admin),  # noqa: ARG001 — auth gate only
    status:    Optional[str] = Query(default=None),
    kind:      Optional[str] = Query(default=None),
    to:        Optional[str] = Query(default=None, description="Exact recipient match"),
    since:     Optional[str] = Query(default=None, description="ISO 8601"),
    until:     Optional[str] = Query(default=None, description="ISO 8601"),
    search:    Optional[str] = Query(default=None, description="Free-text filter"),
    limit:     int = Query(default=50, ge=1, le=_PAGE_MAX),
    cursor:    Optional[str] = Query(default=None, description="ISO timestamp from previous page"),
):
    """List recent email send attempts.  Response shape::

        { logs: [...], next_cursor: "<iso>" | null, count: N }
    """
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_STATUSES)}")
    if kind and kind not in _KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(_KINDS)}")

    q = db.collection("email_log")

    if status:
        q = q.where(field_path="status", op_string="==", value=status)
    if kind:
        q = q.where(field_path="kind", op_string="==", value=kind)
    if to:
        q = q.where(field_path="to", op_string="==", value=to.strip())
    if since:
        q = q.where(field_path="timestamp", op_string=">=", value=_parse_iso("since", since))
    if until:
        q = q.where(field_path="timestamp", op_string="<=", value=_parse_iso("until", until))

    q = q.order_by("timestamp", direction=_fs.Query.DESCENDING)

    if cursor:
        cur_ts = _parse_iso("cursor", cursor)
        if cur_ts:
            q = q.start_after({"timestamp": cur_ts})

    fetch_n = limit + 1
    if search:
        # Over-fetch to keep page sizes roughly stable when the text
        # filter eliminates rows post-query.  Same pattern audit.py uses.
        fetch_n = min(_PAGE_MAX, max(fetch_n, limit * 4))

    try:
        docs = list(q.limit(fetch_n).stream())
    except Exception as exc:
        logger.error("Email-log query failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to load email log") from exc

    rows = [_serialise(d) for d in docs]
    rows = _apply_search(rows, search)

    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1].get("timestamp") if has_more and page else None

    return {"logs": page, "next_cursor": next_cursor, "count": len(page)}


@router.get("/api/v1/admin/email-logs/summary")
def email_log_summary(
    user_data: dict = Depends(require_super_admin),  # noqa: ARG001
):
    """Lightweight roll-up for the top of the screen: last-24h counts by
    status + the most recent failure (if any).  Helps an operator spot
    "everything is fine" vs "Resend just started rejecting us" without
    scrolling the table."""
    now = datetime.now(timezone.utc)
    from datetime import timedelta
    since_24h = now - timedelta(days=1)

    counts = {"sent": 0, "failed": 0, "skipped": 0}
    last_failure: Optional[dict] = None
    try:
        docs = list(
            db.collection("email_log")
              .where(field_path="timestamp", op_string=">=", value=since_24h)
              .order_by("timestamp", direction=_fs.Query.DESCENDING)
              .limit(_PAGE_MAX * 5)
              .stream()
        )
    except Exception as exc:
        logger.warning("Email-log summary query failed: %s", exc)
        docs = []

    for d in docs:
        data = d.to_dict() or {}
        s = data.get("status")
        if s in counts:
            counts[s] += 1
        if last_failure is None and s == "failed":
            last_failure = _serialise(d)

    return {
        "counts":       counts,
        "last_failure": last_failure,
        "as_of":        now.isoformat(),
    }
