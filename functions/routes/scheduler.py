"""Dismissal schedule + pacing routes (issue #69).

Two coupled features share this file:

1. **Scheduler** — admin CRUD for the per-school weekly window + date-level
   exceptions + holiday seeding.  Stored embedded on
   ``schools/{id}.dismissal_schedule``.

2. **Dashboard pacing** — ``GET /api/v1/dashboard/pacing`` resolves today's
   window from the schedule and returns countdown / throughput / projection
   data so the Dashboard hero can render "are we on track?" in one round
   trip per 15 s poll.

Window edges are always built with wall-clock arithmetic in the school's
timezone (``schools.timezone or DEVICE_TIMEZONE``); never with
``now - timedelta``, which mishandles DST transitions.
"""
import logging
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from google.cloud.firestore_v1.base_query import FieldFilter

from config import DEVICE_TIMEZONE
from core import live_queue
from core.audit import log_event as audit_log
from core.auth import require_school_admin, require_school_admin_or_permission
from core.firebase import db
from models.schemas import (
    PutWeeklyRequest,
    SeedHolidaysRequest,
    UpsertExceptionRequest,
)
from services.holidays import candidates_for_school_year, school_year_span

logger = logging.getLogger(__name__)
router = APIRouter()


# Sensible defaults so the page renders something the first time an admin
# opens it on a brand-new school — they can save as-is or edit.  Mon–Fri
# 14:30 → 15:15 reflects the typical US elementary dismissal block.
DEFAULT_WEEKLY: Dict[str, Dict] = {
    "1": {"enabled": True,  "start": "14:30", "end": "15:15"},
    "2": {"enabled": True,  "start": "14:30", "end": "15:15"},
    "3": {"enabled": True,  "start": "14:30", "end": "15:15"},
    "4": {"enabled": True,  "start": "14:30", "end": "15:15"},
    "5": {"enabled": True,  "start": "14:30", "end": "15:15"},
    "6": {"enabled": False, "start": None,    "end": None},
    "7": {"enabled": False, "start": None,    "end": None},
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _school_tz(school_data: Dict) -> ZoneInfo:
    """Per-school timezone, falling back to DEVICE_TIMEZONE if missing or
    unknown.  Bad zone strings shouldn't crash the pacing endpoint."""
    tz_name = (school_data or {}).get("timezone") or DEVICE_TIMEZONE
    try:
        return ZoneInfo(tz_name)
    except Exception:
        logger.warning("Unknown school timezone %r; falling back to %s", tz_name, DEVICE_TIMEZONE)
        return ZoneInfo(DEVICE_TIMEZONE)


def _parse_hhmm(value: str) -> Tuple[int, int]:
    h, m = value.split(":")
    return int(h), int(m)


def _local_dt(d: date, hhmm: str, tz: ZoneInfo) -> datetime:
    """Build a tz-aware datetime by combining a date with HH:MM in the
    given timezone — avoids ``replace(tzinfo=...)`` pitfalls around DST."""
    h, m = _parse_hhmm(hhmm)
    return datetime.combine(d, dt_time(h, m, 0), tzinfo=tz)


def _read_schedule(school_data: Dict) -> Dict:
    """Return the schedule sub-document (with sane defaults), never None."""
    sch = (school_data or {}).get("dismissal_schedule") or {}
    weekly = sch.get("weekly") or {}
    # Fill any missing day with disabled, so callers can index "1".."7"
    # without KeyError.
    out_weekly: Dict[str, Dict] = {}
    for k in ("1", "2", "3", "4", "5", "6", "7"):
        e = weekly.get(k)
        if isinstance(e, dict):
            out_weekly[k] = {
                "enabled": bool(e.get("enabled", False)),
                "start":   e.get("start"),
                "end":     e.get("end"),
            }
        else:
            out_weekly[k] = {"enabled": False, "start": None, "end": None}
    return {
        "weekly":     out_weekly,
        "exceptions": dict(sch.get("exceptions") or {}),
        "school_year_start_month": int(sch.get("school_year_start_month") or 8),
    }


def _resolve_window(schedule: Dict, target_date: date, tz: ZoneInfo) -> Dict:
    """Return today's resolved window.  Output shape (open day):
        {is_open: True, window_start: dt, window_end: dt, source, label}
    Closed:
        {is_open: False, reason: "closed_holiday"|"closed_weekend"|"closed_manual",
         label, source}
    """
    iso = target_date.isoformat()
    exc = (schedule.get("exceptions") or {}).get(iso)
    if exc:
        if exc.get("closed"):
            return {
                "is_open": False,
                "reason":  "closed_holiday",
                "label":   exc.get("label"),
                "source":  exc.get("source", "manual"),
            }
        # Override window — present even on a normally-closed weekday.
        return {
            "is_open":      True,
            "window_start": _local_dt(target_date, exc["start"], tz),
            "window_end":   _local_dt(target_date, exc["end"],   tz),
            "source":       exc.get("source", "manual"),
            "label":        exc.get("label"),
        }

    # Fall back to weekly default.  ISO weekday 1=Mon..7=Sun.
    wd = str(target_date.isoweekday())
    entry = (schedule.get("weekly") or {}).get(wd) or {}
    if not entry.get("enabled") or not entry.get("start") or not entry.get("end"):
        # Distinguish "Sat/Sun closed" from "Tuesday explicitly disabled by
        # admin" only by the day-of-week — labels would be presumptuous.
        reason = "closed_weekend" if target_date.isoweekday() >= 6 else "closed_manual"
        return {"is_open": False, "reason": reason, "label": None, "source": "weekly"}

    return {
        "is_open":      True,
        "window_start": _local_dt(target_date, entry["start"], tz),
        "window_end":   _local_dt(target_date, entry["end"],   tz),
        "source":       "weekly",
        "label":        None,
    }


def _next_open(schedule: Dict, after_date: date, tz: ZoneInfo, max_lookahead: int = 14) -> Optional[Dict]:
    """Walk forward up to ``max_lookahead`` days looking for the next open
    dismissal window.  Returns a {date, window_start_iso, label} dict or
    None if nothing's open in the next two weeks (e.g. a long break)."""
    for i in range(1, max_lookahead + 1):
        d = after_date + timedelta(days=i)
        w = _resolve_window(schedule, d, tz)
        if w.get("is_open"):
            return {
                "date":           d.isoformat(),
                "window_start":   w["window_start"].isoformat(),
                "label":          w.get("label"),
            }
    return None


def _get_school(user_data: Dict) -> Tuple[str, Dict]:
    """Load the active school doc for the requesting admin.  Raises 404 if
    the school doesn't exist (rare — almost always a stale X-School-Id)."""
    school_id = user_data.get("school_id")
    if not school_id:
        raise HTTPException(status_code=400, detail="No school assigned to your account")
    snap = db.collection("schools").document(school_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="School not found")
    return school_id, (snap.to_dict() or {})


def _stamp_save(user_data: Dict) -> Dict:
    """Sub-document of bookkeeping fields we stamp on every schedule write."""
    return {
        "schedule_updated_at": datetime.now(timezone.utc).isoformat(),
        "schedule_updated_by": user_data.get("uid"),
    }


# ---------------------------------------------------------------------------
# Schedule CRUD
# ---------------------------------------------------------------------------

@router.get("/api/v1/scheduler")
def get_schedule(user_data: Dict = Depends(require_school_admin_or_permission("schedule"))):
    """Full schedule + today's resolved window for the active school."""
    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    tz = _school_tz(school)
    today = datetime.now(tz).date()
    today_window = _resolve_window(schedule, today, tz)

    # Serialise window edges back to ISO for the wire.
    if today_window.get("is_open"):
        today_payload = {
            "date":         today.isoformat(),
            "is_open":      True,
            "window_start": today_window["window_start"].isoformat(),
            "window_end":   today_window["window_end"].isoformat(),
            "source":       today_window["source"],
            "label":        today_window.get("label"),
        }
    else:
        today_payload = {
            "date":   today.isoformat(),
            "is_open": False,
            "reason":  today_window["reason"],
            "label":   today_window.get("label"),
            "source":  today_window["source"],
        }

    return {
        "schedule": schedule,
        "today":    today_payload,
        "timezone": str(tz),
    }


@router.put("/api/v1/scheduler/weekly")
def put_weekly(body: PutWeeklyRequest, user_data: Dict = Depends(require_school_admin_or_permission("schedule"))):
    """Atomic replace of the 7-day weekly grid."""
    school_id, school = _get_school(user_data)
    before = (school.get("dismissal_schedule") or {}).get("weekly")
    new_weekly = {k: v.model_dump() for k, v in body.weekly.items()}

    db.collection("schools").document(school_id).set(
        {
            "dismissal_schedule": {
                "weekly": new_weekly,
                **_stamp_save(user_data),
            }
        },
        merge=True,
    )

    audit_log(
        action="school.schedule.weekly.updated",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": school.get("name", school_id)},
        diff={"before": before, "after": new_weekly},
        severity="info",
        school_id=school_id,
        district_id=school.get("district_id"),
        message="Dismissal weekly schedule updated",
    )
    return {"weekly": new_weekly}


@router.put("/api/v1/scheduler/exceptions/{iso_date}")
def upsert_exception(
    iso_date: str,
    body: UpsertExceptionRequest,
    user_data: Dict = Depends(require_school_admin_or_permission("schedule")),
):
    """Add or replace a date-level exception."""
    try:
        parsed = date.fromisoformat(iso_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="iso_date must be YYYY-MM-DD")

    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    before = schedule["exceptions"].get(iso_date)
    payload = body.model_dump()
    # Manual upserts win over future seeds — see seed-holidays for the
    # corresponding skip rule.
    payload["source"] = "manual"

    db.collection("schools").document(school_id).set(
        {
            "dismissal_schedule": {
                "exceptions": {parsed.isoformat(): payload},
                **_stamp_save(user_data),
            }
        },
        merge=True,
    )

    audit_log(
        action="school.schedule.exception.upserted",
        actor=user_data,
        target={"type": "school.schedule.exception", "id": parsed.isoformat(),
                "display_name": payload.get("label") or parsed.isoformat()},
        diff={"before": before, "after": payload},
        severity="info",
        school_id=school_id,
        district_id=school.get("district_id"),
        message=f"Exception {parsed.isoformat()} saved",
    )
    return {"date": parsed.isoformat(), "exception": payload}


@router.delete("/api/v1/scheduler/exceptions/{iso_date}")
def delete_exception(iso_date: str, user_data: Dict = Depends(require_school_admin_or_permission("schedule"))):
    """Remove an exception so the date reverts to the weekly default."""
    try:
        parsed = date.fromisoformat(iso_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="iso_date must be YYYY-MM-DD")

    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    before = schedule["exceptions"].get(iso_date)
    if before is None:
        # Idempotent — deleting a non-existent exception is a no-op.
        return {"date": parsed.isoformat(), "deleted": False}

    # Firestore has no native dotted-path delete on a map key from the
    # Python SDK without ``DELETE_FIELD``.  Easier to read+rewrite the
    # whole exceptions map.
    new_exceptions = dict(schedule["exceptions"])
    new_exceptions.pop(iso_date, None)
    db.collection("schools").document(school_id).set(
        {
            "dismissal_schedule": {
                "exceptions": new_exceptions,
                **_stamp_save(user_data),
            }
        },
        merge=True,
    )
    # Note: ``set(merge=True)`` merges the exceptions map rather than
    # replacing it, which would re-add the deleted key.  Use update with
    # an explicit map overwrite to actually drop the entry.
    db.collection("schools").document(school_id).update(
        {"dismissal_schedule.exceptions": new_exceptions}
    )

    audit_log(
        action="school.schedule.exception.deleted",
        actor=user_data,
        target={"type": "school.schedule.exception", "id": parsed.isoformat(),
                "display_name": (before or {}).get("label") or parsed.isoformat()},
        diff={"before": before, "after": None},
        severity="info",
        school_id=school_id,
        district_id=school.get("district_id"),
        message=f"Exception {parsed.isoformat()} removed",
    )
    return {"date": parsed.isoformat(), "deleted": True}


# ---------------------------------------------------------------------------
# Holiday seed candidates + bulk apply
# ---------------------------------------------------------------------------

@router.get("/api/v1/scheduler/seed-candidates")
def list_seed_candidates(user_data: Dict = Depends(require_school_admin_or_permission("schedule"))):
    """Pre-seed list for the school year containing today.  ``already_set``
    flags dates that already have an exception stored, so the UI can
    pre-tick the unmarked ones and grey out the rest."""
    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    tz = _school_tz(school)
    today = datetime.now(tz).date()
    start_month = schedule["school_year_start_month"]

    span_start, span_end = school_year_span(today, start_month)
    cands = candidates_for_school_year(today, start_month)
    existing = schedule["exceptions"]

    out = []
    for c in cands:
        iso = c["date"].isoformat()
        ex = existing.get(iso)
        out.append({
            "date":         iso,
            "label":        c["label"],
            "kind":         c["kind"],
            "source":       c["source"],
            "already_set":  ex is not None,
            "manual":       bool(ex and ex.get("source") == "manual"),
        })

    return {
        "school_year": {"start": span_start.isoformat(), "end": span_end.isoformat()},
        "candidates":  out,
    }


@router.post("/api/v1/scheduler/seed-holidays")
def seed_holidays(body: SeedHolidaysRequest, user_data: Dict = Depends(require_school_admin_or_permission("schedule"))):
    """Bulk-apply selected holiday dates.  The server re-derives its own
    seed list and intersects with the request body so a stale or hostile
    client can't seed dates outside the catalog.  Existing entries flagged
    ``source: "manual"`` are preserved verbatim — admins' intentional
    overrides survive a re-seed."""
    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    tz = _school_tz(school)
    today = datetime.now(tz).date()
    start_month = body.school_year_start_month or schedule["school_year_start_month"]

    server_cands = {
        c["date"].isoformat(): c for c in candidates_for_school_year(today, start_month)
    }
    requested_dates = {row.date for row in body.dates}
    valid_dates = requested_dates & set(server_cands.keys())

    existing = dict(schedule["exceptions"])
    applied: List[str] = []
    skipped_manual: List[str] = []

    for iso in sorted(valid_dates):
        prior = existing.get(iso)
        if prior and prior.get("source") == "manual":
            skipped_manual.append(iso)
            continue
        seed = server_cands[iso]
        existing[iso] = {
            "closed": True,
            "start":  None,
            "end":    None,
            "label":  seed["label"],
            "source": seed["source"],
        }
        applied.append(iso)

    db.collection("schools").document(school_id).set(
        {
            "dismissal_schedule": {
                "exceptions": existing,
                "school_year_start_month": start_month,
                **_stamp_save(user_data),
            }
        },
        merge=True,
    )

    audit_log(
        action="school.schedule.seed_applied",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": school.get("name", school_id)},
        diff={"applied": applied, "skipped_manual": skipped_manual,
              "ignored_outside_catalog": sorted(requested_dates - valid_dates)},
        severity="info",
        school_id=school_id,
        district_id=school.get("district_id"),
        message=f"{len(applied)} holidays seeded",
    )
    return {
        "applied":          applied,
        "skipped_manual":   skipped_manual,
        "school_year_start_month": start_month,
    }


# ---------------------------------------------------------------------------
# Pacing — /api/v1/dashboard/pacing  (15 s polling endpoint)
# ---------------------------------------------------------------------------

def _query_pickups(school_id: str, start: datetime, end: datetime):
    """Return scan docs in ``plate_scans`` for ``school_id`` whose
    ``picked_up_at`` falls in [start, end].  Both endpoints inclusive."""
    q = (
        db.collection("plate_scans")
          .where(filter=FieldFilter("school_id",   "==", school_id))
          .where(filter=FieldFilter("picked_up_at", ">=", start))
          .where(filter=FieldFilter("picked_up_at", "<=", end))
    )
    return list(q.stream())


def _dow_baseline_per_min(school_id: str, schedule: Dict, target_dow: int,
                          tz: ZoneInfo, today: date) -> Optional[float]:
    """Avg pickups-per-minute for the given day-of-week across the last 4
    matching weekdays (skipping today and any closed/exception day).  Returns
    None when no days have data yet (insufficient history)."""
    samples: List[float] = []
    # Walk back up to 8 weeks to find 4 sampled days; some weekdays might
    # be exception-closed.
    d = today - timedelta(days=7)
    weeks_walked = 0
    while len(samples) < 4 and weeks_walked < 8:
        if d.isoweekday() == target_dow:
            window = _resolve_window(schedule, d, tz)
            if window.get("is_open"):
                ws, we = window["window_start"], window["window_end"]
                pickups = _query_pickups(school_id, ws, we)
                duration_min = (we - ws).total_seconds() / 60.0
                if pickups and duration_min > 0:
                    samples.append(len(pickups) / duration_min)
            d -= timedelta(days=7)
            weeks_walked += 1
        else:
            d -= timedelta(days=1)
    if not samples:
        return None
    return round(sum(samples) / len(samples), 2)


def _status_for(elapsed_min: float, pacing_delta: float, overrun_min: float,
                queue_now: int, now: datetime, window_end: datetime) -> str:
    """Status pill rule.  Overrun and pacing-delta thresholds are dual-gated
    so we catch both 'projected to overrun' and 'cumulatively far behind'."""
    if now > window_end:
        return "overrun" if queue_now > 0 else "completed"
    if elapsed_min < 3:
        return "warming_up"
    if overrun_min >= 5 or pacing_delta <= -25:
        return "critical"
    if overrun_min >= 1 or pacing_delta <= -10:
        return "behind"
    return "on_pace"


@router.get("/api/v1/dashboard/pacing")
def get_pacing(user_data: Dict = Depends(require_school_admin)):
    """Return countdown + throughput + projection for the active dismissal.
    Single endpoint feeds the Dashboard hero — see PacingHero.jsx."""
    school_id, school = _get_school(user_data)
    schedule = _read_schedule(school)
    tz = _school_tz(school)
    now = datetime.now(tz)
    today = now.date()
    window = _resolve_window(schedule, today, tz)

    # Closed-day branch — render an idle hero with the next-open chip.
    if not window.get("is_open"):
        return {
            "is_open":   False,
            "now":       now.isoformat(),
            "reason":    window["reason"],
            "label":     window.get("label"),
            "source":    window.get("source"),
            "next_open": _next_open(schedule, today, tz),
            "queue_depth": len(live_queue.get_sorted(school_id) or []),
            "timezone":  str(tz),
        }

    window_start: datetime = window["window_start"]
    window_end:   datetime = window["window_end"]
    queue_now = len(live_queue.get_sorted(school_id) or [])

    # Not-started branch — countdown to start, no pacing math yet.
    if now < window_start:
        return {
            "is_open":            True,
            "status":             "not_started",
            "now":                now.isoformat(),
            "window_start":       window_start.isoformat(),
            "window_end":         window_end.isoformat(),
            "seconds_until_start": int((window_start - now).total_seconds()),
            "seconds_remaining":  int((window_end - now).total_seconds()),
            "label":              window.get("label"),
            "queue_depth":        queue_now,
            "timezone":           str(tz),
        }

    # ── Active dismissal: count pickups inside the window so far ──
    elapsed_min = max(0.0, (now - window_start).total_seconds() / 60.0)
    cumulative_pickups = len(_query_pickups(school_id, window_start, now))

    # Throughput: cumulative during warm-up, rolling 5-min after.  The
    # rolling rule is more responsive once a few cars have actually moved
    # through; before that, dividing-by-tiny-elapsed flickers wildly.
    if elapsed_min < 5:
        throughput_per_min = cumulative_pickups / max(elapsed_min, 0.5)
    else:
        recent_start = max(now - timedelta(minutes=5), window_start)
        recent = len(_query_pickups(school_id, recent_start, now))
        throughput_per_min = recent / 5.0
    throughput_per_min = round(throughput_per_min, 2)

    # Projected clear time — when does the queue empty at current pace?
    if queue_now == 0:
        projected_clear_at = now
    elif throughput_per_min <= 0:
        projected_clear_at = None
    else:
        projected_clear_at = now + timedelta(minutes=queue_now / throughput_per_min)

    # Progress: percent_complete vs percent_time_elapsed.
    total_today = cumulative_pickups + queue_now
    if total_today > 0:
        percent_complete = round(cumulative_pickups / total_today * 100.0, 1)
    else:
        percent_complete = 100.0
    duration_min = (window_end - window_start).total_seconds() / 60.0
    if duration_min > 0:
        pct_time = (now - window_start).total_seconds() / 60.0 / duration_min * 100.0
    else:
        pct_time = 100.0
    percent_time_elapsed = round(max(0.0, min(100.0, pct_time)), 1)
    pacing_delta = round(percent_complete - percent_time_elapsed, 1)

    # Overrun: how late will we finish vs the bell?
    overrun_min = 0.0
    if projected_clear_at and projected_clear_at > window_end:
        overrun_min = (projected_clear_at - window_end).total_seconds() / 60.0

    status = _status_for(
        elapsed_min, pacing_delta, overrun_min, queue_now, now, window_end,
    )

    # DOW baseline for the "vs avg" delta — None when insufficient history.
    dow_baseline = _dow_baseline_per_min(
        school_id, schedule, today.isoweekday(), tz, today,
    )

    return {
        "is_open":             True,
        "status":              status,
        "now":                 now.isoformat(),
        "window_start":        window_start.isoformat(),
        "window_end":          window_end.isoformat(),
        "seconds_remaining":   int((window_end - now).total_seconds()),
        "label":               window.get("label"),
        "source":              window.get("source"),
        "queue_depth":         queue_now,
        "current_throughput_per_min": throughput_per_min,
        "dow_baseline_per_min":       dow_baseline,
        "projected_clear_at":         projected_clear_at.isoformat() if projected_clear_at else None,
        "percent_complete":           percent_complete,
        "percent_time_elapsed":       percent_time_elapsed,
        "pacing_delta":               pacing_delta,
        "overrun_minutes":            round(overrun_min, 1),
        "timezone":                   str(tz),
    }
