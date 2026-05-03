"""History, reports, insights, system alerts, and system health routes."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE
from core import live_queue
from core.audit import log_event as audit_log
from core.auth import require_school_admin, verify_firebase_token
from core.firebase import db
from core.utils import _format_timestamp
from models.schemas import UpdateEfficiencyGoalRequest
from secure_lookup import safe_decrypt

# Default Efficiency Score target when a school hasn't picked one yet.
# 85 maps to a strong "B+" — visible-but-reachable, not aspirational-only.
DEFAULT_EFFICIENCY_GOAL = 85
# Sub-score weights used by the composite formula.  Kept as a module-level
# constant so a future settings page can expose them without searching the
# function body.  Values must sum to 100.
EFFICIENCY_WEIGHTS = {"speed": 40, "recognition": 25, "automation": 25, "consistency": 10}

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/v1/system/health")
def system_health():
    try:
        db.collection("plate_scans").limit(1).get()
        firestore_ok = True
    except Exception as exc:
        logger.error("Health check: Firestore unreachable: %s", exc)
        firestore_ok = False
    payload = {
        "status": "healthy" if firestore_ok else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "firestore": "ok" if firestore_ok else "error",
    }
    if not firestore_ok:
        return JSONResponse(status_code=503, content=payload)
    return payload


@router.get("/api/v1/history")
def get_history(
    response: Response,
    user_data: dict = Depends(verify_firebase_token),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=500, ge=1, le=500),
):
    response.headers["Cache-Control"] = "no-store"
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    start_dt = end_dt = None
    if start_date:
        try:
            start_dt = datetime.fromisoformat(start_date).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=tz)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start_date — use YYYY-MM-DD")
    if end_date:
        try:
            end_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59, microsecond=999999, tzinfo=tz)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end_date — use YYYY-MM-DD")

    def _build_query(collection_name):
        q = db.collection(collection_name).where(field_path="school_id", op_string="==", value=school_id)
        if start_dt:
            q = q.where(field_path="timestamp", op_string=">=", value=start_dt)
        if end_dt:
            q = q.where(field_path="timestamp", op_string="<=", value=end_dt)
        return q

    try:
        all_docs = list(_build_query("plate_scans").stream())
    except Exception as exc:
        logger.error("plate_scans query failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to query scan history.")
    try:
        all_docs.extend(_build_query("scan_history").stream())
    except Exception as exc:
        logger.warning("scan_history query failed (index may be missing): %s", exc)

    results = []
    skipped = 0
    for doc in all_docs:
        try:
            data = doc.to_dict()
        except Exception as exc:
            logger.warning("Skipping unreadable history doc %s: %s", doc.id, exc)
            skipped += 1
            continue
        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        if isinstance(enc_students, list):
            students = [safe_decrypt(s, default="[unreadable]") for s in enc_students]
        elif enc_students:
            students = [safe_decrypt(enc_students, default="[unreadable]")]
        else:
            students = []
        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = safe_decrypt(enc_parent, default="[unreadable]") if enc_parent else None
        if search:
            sl = search.strip().lower()
            if sl not in (parent or "").lower() and sl not in ", ".join(students).lower():
                continue
        results.append({
            "id": doc.id, "plate_token": data.get("plate_token"),
            "student": students, "parent": parent,
            "timestamp": _format_timestamp(data.get("timestamp")),
            "location": data.get("location"), "confidence_score": data.get("confidence_score"),
            "pickup_method": data.get("pickup_method"),
            "picked_up_at": _format_timestamp(data.get("picked_up_at")),
        })
    results.sort(key=lambda r: r["timestamp"] or "", reverse=True)
    capped = len(results) > limit
    results = results[:limit]
    logger.info("History fetch: %d records (skipped %d) school=%s", len(results), skipped, school_id)
    return {"records": results, "total": len(results), "capped": capped}


@router.get("/api/v1/reports/summary")
def summary_report(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    today = datetime.now(tz).date()
    scans = []
    for coll in ("plate_scans", "scan_history"):
        scans.extend(db.collection(coll).where(field_path="school_id", op_string="==", value=school_id).stream())
    total = len(scans)
    today_count = 0
    hourly_counts = [0] * 24
    confidence_scores: list = []
    for scan in scans:
        data = scan.to_dict()
        ts = data.get("timestamp")
        if ts:
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            elif isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            else:
                ts = None
        if ts:
            if ts.date() == today:
                today_count += 1
            hourly_counts[ts.hour] += 1
        score = data.get("confidence_score")
        if score is not None:
            confidence_scores.append(float(score))
    peak_hour = int(hourly_counts.index(max(hourly_counts))) if total > 0 else None
    avg_confidence = round(sum(confidence_scores) / len(confidence_scores), 3) if confidence_scores else None
    return {"total_scans": total, "today_count": today_count, "peak_hour": peak_hour, "hourly_distribution": hourly_counts, "avg_confidence": avg_confidence}


def _grade_for(score: int) -> str:
    """Letter grade for the composite Efficiency Score.

    Boundaries are intentionally generous on the low end (D at 60)
    because scanner-confidence and pickup-method ratios drag fast
    when even a few stragglers happen — we don't want a single bad
    Friday to brand a school's whole week as failing."""
    if score >= 95: return "A+"
    if score >= 90: return "A"
    if score >= 80: return "B"
    if score >= 70: return "C"
    if score >= 60: return "D"
    return "F"


def _day_score(day: dict) -> Optional[Dict[str, float]]:
    """Compute the four sub-scores for a single day's rollup.

    Returns ``None`` when the day has no usable signal at all (no
    pickups, no scans, no methods).  The composite week score skips
    ``None`` days so they don't drag the average down — this keeps
    quiet-school-day Saturdays from looking like "F" performance."""
    pickups = day["pickups_total"]
    confs   = day["conf_total"]
    methods = day["methods_total"]
    if pickups == 0 and confs == 0 and methods == 0:
        return None
    speed       = (day["pickups_fast"] / pickups * 100.0) if pickups else None
    recognition = (day["conf_high"]   / confs   * 100.0) if confs   else None
    automation  = (day["methods_auto"]/ methods * 100.0) if methods else None
    return {"speed": speed, "recognition": recognition, "automation": automation}


def _composite(sub: Dict[str, float], consistency: float) -> int:
    """Weighted average of the four sub-scores.

    Sub-scores that are ``None`` (no data for that axis on this day)
    are dropped and the remaining weights re-normalize, so a slow-data
    day doesn't penalize speed when there were no pickups to measure."""
    parts = [(EFFICIENCY_WEIGHTS["speed"],       sub.get("speed")),
             (EFFICIENCY_WEIGHTS["recognition"], sub.get("recognition")),
             (EFFICIENCY_WEIGHTS["automation"],  sub.get("automation")),
             (EFFICIENCY_WEIGHTS["consistency"], consistency)]
    parts = [(w, v) for w, v in parts if v is not None]
    if not parts:
        return 0
    weight_sum = sum(w for w, _ in parts)
    return round(sum(w * v for w, v in parts) / weight_sum)


def _compute_efficiency(eff_per_day: Dict, today, week_count: int, prev_week_count: int) -> Dict:
    """Roll the per-day buckets into the response payload.

    Returns: {score, sub_scores, weekly_trend[7], wow_delta, streak_weeks}.
    ``streak_weeks`` walks back week-by-week; "0" means this week's score
    is below goal (caller decides) — we just compute the raw scores here
    and let the route apply the threshold."""
    # Consistency is a single number for the *whole week* — compares this
    # 7-day count to the prior 7-day count.  Big swings in either direction
    # cost points; gentle drift doesn't.
    if week_count == 0 and prev_week_count == 0:
        consistency = 100.0  # nothing happening, nothing to be inconsistent about
    elif prev_week_count == 0:
        consistency = 100.0  # ramp-up; treat as healthy
    else:
        delta_pct = abs(week_count - prev_week_count) / prev_week_count * 100.0
        consistency = max(0.0, 100.0 - min(100.0, delta_pct * 2.0))
    # Per-day scores for the last 7 days, oldest-first (Mon→Sun visually
    # depends on what `today` lands on; the front-end re-labels with the
    # day-of-week derived from each entry's index).
    weekly_trend = []
    weekly_sub_acc = {"speed": [], "recognition": [], "automation": []}
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        bucket = eff_per_day.get(d, {"pickups_total": 0, "pickups_fast": 0,
                                     "conf_total": 0, "conf_high": 0,
                                     "methods_total": 0, "methods_auto": 0})
        sub = _day_score(bucket)
        if sub is None:
            weekly_trend.append({"date": d.isoformat(), "day": d.strftime("%a"), "score": 0, "has_data": False})
            continue
        score = _composite(sub, consistency)
        weekly_trend.append({"date": d.isoformat(), "day": d.strftime("%a"), "score": score, "has_data": True})
        for k in ("speed", "recognition", "automation"):
            if sub.get(k) is not None:
                weekly_sub_acc[k].append(sub[k])
    # Composite for *this* 7-day stretch — average of days that had data.
    days_with_data = [d["score"] for d in weekly_trend if d["has_data"]]
    composite_score = round(sum(days_with_data) / len(days_with_data)) if days_with_data else 0
    sub_scores = {
        "speed":       round(sum(weekly_sub_acc["speed"])       / len(weekly_sub_acc["speed"]))       if weekly_sub_acc["speed"]       else 0,
        "recognition": round(sum(weekly_sub_acc["recognition"]) / len(weekly_sub_acc["recognition"])) if weekly_sub_acc["recognition"] else 0,
        "automation":  round(sum(weekly_sub_acc["automation"])  / len(weekly_sub_acc["automation"]))  if weekly_sub_acc["automation"]  else 0,
        "consistency": round(consistency),
    }
    # Prior-week composite (days 7–13 ago) for the WoW delta chip.
    prior_days = []
    for i in range(13, 6, -1):
        d = today - timedelta(days=i)
        bucket = eff_per_day.get(d)
        if not bucket:
            continue
        sub = _day_score(bucket)
        if sub is None:
            continue
        prior_days.append(_composite(sub, consistency))
    prior_score = round(sum(prior_days) / len(prior_days)) if prior_days else 0
    wow_delta = composite_score - prior_score if prior_days else 0
    return {
        "score":         composite_score,
        "grade":         _grade_for(composite_score),
        "sub_scores":    sub_scores,
        "weights":       EFFICIENCY_WEIGHTS,
        "weekly_trend":  weekly_trend,
        "wow_delta":     wow_delta,
        "prior_score":   prior_score,
    }


def _streak_weeks(eff_per_day: Dict, today, prev_week_count_for_consistency: int, goal: int) -> int:
    """Count consecutive prior weeks (not including the current one) where
    that week's composite was at or above ``goal``.  Walks back up to 3
    weeks from the start of the current week — bounded by the 28-day
    window we already accumulated above."""
    streak = 0
    # Use the same consistency baseline as the current week so the streak
    # isn't whipped around by stale prior-week-of-prior-week comparisons.
    # This is approximate but cheap; better than over-engineering.
    consistency = 100.0  # historical weeks: assume neutral consistency
    for week_offset in range(1, 4):  # weeks 1, 2, 3 ago (last 28 days)
        days_acc = []
        for d_offset in range(7 * week_offset, 7 * (week_offset + 1)):
            d = today - timedelta(days=d_offset)
            bucket = eff_per_day.get(d)
            if not bucket:
                continue
            sub = _day_score(bucket)
            if sub is None:
                continue
            days_acc.append(_composite(sub, consistency))
        if not days_acc:
            break  # no data → can't extend streak
        week_score = round(sum(days_acc) / len(days_acc))
        if week_score >= goal:
            streak += 1
        else:
            break
    return streak


@router.get("/api/v1/insights/summary")
def insights_summary(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    today = now.date()
    yesterday = today - timedelta(days=1)
    week_ago = today - timedelta(days=7)
    two_weeks_ago = today - timedelta(days=14)
    scans = []
    for coll in ("plate_scans", "scan_history"):
        scans.extend(db.collection(coll).where(field_path="school_id", op_string="==", value=school_id).stream())
    total = len(scans)
    today_count = yesterday_count = week_count = 0
    today_last_week = today - timedelta(days=7)  # for WoW same-weekday compare
    heatmap_window_start = today - timedelta(days=28)  # 4-week heatmap window
    hourly_counts = [0] * 24
    confidence_scores: list = []
    confidence_buckets = {"high": 0, "medium": 0, "low": 0}
    date_counts: Dict[str, int] = {}
    today_plates: set = set()
    # Heatmap: 7 rows (Mon..Sun) × 24 cols (0..23) over the last 28 days.
    heatmap = [[0] * 24 for _ in range(7)]
    # Wait-time + pickup-method aggregations — today only, since they're
    # operational signals for the current carline run.  `picked_up_at`
    # is written by queue removal / bulk-pickup; `pickup_method` is one
    # of "auto" (scanner), "manual", "manual_bulk".
    wait_seconds_today: list = []
    pickup_methods_today = {"auto": 0, "manual": 0, "manual_bulk": 0}
    today_last_week_count = 0
    # Per-day rollups feeding the Efficiency Score (issue #75).  We track
    # the last 28 days so we can compute up to 4 prior weekly composites
    # for the streak counter.  Each entry: {pickups_total, pickups_fast,
    # conf_total, conf_high, methods_total, methods_auto}.
    eff_window_start = today - timedelta(days=27)  # inclusive 28-day window

    def _empty_eff_day():
        return {
            "pickups_total": 0, "pickups_fast": 0,
            "conf_total":    0, "conf_high":   0,
            "methods_total": 0, "methods_auto": 0,
        }
    eff_per_day: Dict = {}
    for scan in scans:
        data = scan.to_dict()
        ts = data.get("timestamp")
        if ts:
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            elif isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            else:
                ts = None
        if ts:
            scan_date = ts.date()
            date_counts[scan_date] = date_counts.get(scan_date, 0) + 1
            hourly_counts[ts.hour] += 1
            if scan_date >= heatmap_window_start:
                heatmap[scan_date.weekday()][ts.hour] += 1
            if scan_date == today:
                today_count += 1
                pt = data.get("plate_token") or data.get("plate", "")
                if pt:
                    today_plates.add(pt)
                # Wait time from scan → pickup for today's completed pickups.
                pua = data.get("picked_up_at")
                if pua:
                    if isinstance(pua, str):
                        try:
                            pua = datetime.fromisoformat(pua)
                        except ValueError:
                            pua = None
                    if pua and hasattr(pua, "tzinfo"):
                        pua = pua.replace(tzinfo=tz) if pua.tzinfo is None else pua.astimezone(tz)
                    if pua:
                        wait = (pua - ts).total_seconds()
                        if 0 <= wait <= 3600:  # clamp to 1h; bigger = stale/forgot
                            wait_seconds_today.append(wait)
                method = data.get("pickup_method")
                if method in pickup_methods_today:
                    pickup_methods_today[method] += 1
            if scan_date == yesterday:
                yesterday_count += 1
            if scan_date == today_last_week:
                today_last_week_count += 1
            if scan_date >= week_ago:
                week_count += 1
            # ── Efficiency Score per-day rollup (last 28 days) ──
            # We compute this for every scan in-window, regardless of
            # day, so all four sub-scores can be derived per-day below.
            if scan_date >= eff_window_start:
                ed = eff_per_day.setdefault(scan_date, _empty_eff_day())
                # Speed: was this scan picked up within 3 minutes?
                pua_eff = data.get("picked_up_at")
                if pua_eff:
                    if isinstance(pua_eff, str):
                        try:
                            pua_eff = datetime.fromisoformat(pua_eff)
                        except ValueError:
                            pua_eff = None
                    if pua_eff and hasattr(pua_eff, "tzinfo"):
                        pua_eff = pua_eff.replace(tzinfo=tz) if pua_eff.tzinfo is None else pua_eff.astimezone(tz)
                    if pua_eff:
                        wait_sec = (pua_eff - ts).total_seconds()
                        if 0 <= wait_sec <= 3600:
                            ed["pickups_total"] += 1
                            if wait_sec < 180:  # under 3 min = "fast"
                                ed["pickups_fast"] += 1
                # Automation: scanner-driven (auto) vs manual fallbacks.
                m = data.get("pickup_method")
                if m in ("auto", "manual", "manual_bulk"):
                    ed["methods_total"] += 1
                    if m == "auto":
                        ed["methods_auto"] += 1
        score = data.get("confidence_score")
        if score is not None:
            s = float(score)
            confidence_scores.append(s)
            confidence_buckets["high" if s >= 0.85 else "medium" if s >= 0.60 else "low"] += 1
            # Recognition: track per-day high/total in the window.  We
            # gate this on scan_date being set — otherwise we'd mis-key
            # the bucket on undated docs.
            if ts and scan_date >= eff_window_start:
                ed = eff_per_day.setdefault(scan_date, _empty_eff_day())
                ed["conf_total"] += 1
                if s >= 0.85:
                    ed["conf_high"] += 1
    peak_hour = int(hourly_counts.index(max(hourly_counts))) if total > 0 else None
    avg_confidence = round(sum(confidence_scores) / len(confidence_scores), 3) if confidence_scores else None
    distinct_days = max(len(date_counts), 1)
    avg_daily = round(total / distinct_days, 1)
    daily_counts = [{"date": (today - timedelta(days=i)).isoformat(), "count": date_counts.get(today - timedelta(days=i), 0), "day": (today - timedelta(days=i)).strftime("%a")} for i in range(13, -1, -1)]
    dow_totals, dow_days = [0] * 7, [0] * 7
    for d, count in date_counts.items():
        dow = d.weekday()
        dow_totals[dow] += count
        dow_days[dow] += 1
    day_of_week_avg = [round(dow_totals[i] / dow_days[i], 1) if dow_days[i] > 0 else 0 for i in range(7)]
    prev_week_count = sum(c for d, c in date_counts.items() if week_ago > d >= two_weeks_ago)
    scan_trend = "up" if (prev_week_count == 0 and week_count > 0) or week_count > prev_week_count * 1.1 else ("down" if week_count < prev_week_count * 0.9 else "stable")

    # Wait-time stats + 5-bin histogram.  Buckets chosen so operators can
    # see at a glance whether most pickups happen in the first 3 minutes
    # (healthy fast queue) vs. drifting toward 10+ minutes (stuck).
    def _median(values: list) -> float:
        if not values:
            return 0
        xs = sorted(values)
        n = len(xs)
        mid = n // 2
        return xs[mid] if n % 2 == 1 else (xs[mid - 1] + xs[mid]) / 2
    wait_buckets = {"lt1m": 0, "1to3m": 0, "3to5m": 0, "5to10m": 0, "gt10m": 0}
    for w in wait_seconds_today:
        if w < 60:
            wait_buckets["lt1m"] += 1
        elif w < 180:
            wait_buckets["1to3m"] += 1
        elif w < 300:
            wait_buckets["3to5m"] += 1
        elif w < 600:
            wait_buckets["5to10m"] += 1
        else:
            wait_buckets["gt10m"] += 1
    wait_stats = {
        "total_pickups":  len(wait_seconds_today),
        "avg_seconds":    round(sum(wait_seconds_today) / len(wait_seconds_today), 1) if wait_seconds_today else 0,
        "median_seconds": round(_median(wait_seconds_today), 1),
        "buckets":        wait_buckets,
    }

    # ── Efficiency Score (issue #75) ──
    # Roll the per-day buckets into a composite, plus weekly trend and
    # streak.  The school's goal lives on the schools/{id} doc and is
    # editable via PATCH /api/v1/insights/efficiency-goal below.
    school_doc = db.collection("schools").document(school_id).get() if school_id else None
    school_data = school_doc.to_dict() if school_doc and school_doc.exists else {}
    efficiency_goal = school_data.get("efficiency_goal") if isinstance(school_data, dict) else None
    if not isinstance(efficiency_goal, int) or not (1 <= efficiency_goal <= 100):
        efficiency_goal = DEFAULT_EFFICIENCY_GOAL
    eff_payload = _compute_efficiency(eff_per_day, today, week_count, prev_week_count)
    eff_payload["goal"] = efficiency_goal
    eff_payload["streak_weeks"] = _streak_weeks(eff_per_day, today, prev_week_count, efficiency_goal)

    return {
        "total_scans": total, "today_count": today_count, "yesterday_count": yesterday_count,
        "week_count": week_count, "avg_daily": avg_daily, "peak_hour": peak_hour,
        "hourly_distribution": hourly_counts, "avg_confidence": avg_confidence,
        "confidence_buckets": confidence_buckets, "daily_counts": daily_counts,
        "day_of_week_avg": day_of_week_avg, "predicted_today": round(day_of_week_avg[today.weekday()]),
        "unique_plates_today": len(today_plates), "scan_trend": scan_trend,
        # ── New fields for supercharged Insights ──
        "today_last_week_count": today_last_week_count,   # same weekday 7 days ago
        "prev_week_count":       prev_week_count,         # trailing 7d before last 7d
        "heatmap":               heatmap,                 # 7×24, last 28 days
        "wait_stats":            wait_stats,              # today's pickup dwell
        "pickup_methods_today":  pickup_methods_today,    # auto / manual / manual_bulk
        "efficiency":            eff_payload,             # composite KPI + weekly trend + goal
    }


@router.patch("/api/v1/insights/efficiency-goal")
def update_efficiency_goal(
    body: UpdateEfficiencyGoalRequest,
    user_data: dict = Depends(require_school_admin),
):
    """Set the per-school Efficiency Score target (1–100).

    School admins can edit their own school's goal here without needing
    super-admin privileges that the broader school-edit endpoint requires.
    The value flows back through GET /api/v1/insights/summary on the next
    fetch — the response's ``efficiency.goal`` and ``efficiency.streak_weeks``
    will reflect the new threshold."""
    school_id = user_data.get("school_id")
    if not school_id:
        raise HTTPException(status_code=400, detail="No school assigned to your account")
    doc_ref = db.collection("schools").document(school_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="School not found")
    existing = snap.to_dict() or {}
    before = existing.get("efficiency_goal")
    doc_ref.update({"efficiency_goal": body.goal})
    audit_log(
        action="school.efficiency_goal.updated",
        actor=user_data,
        target={"type": "school", "id": school_id, "display_name": existing.get("name", school_id)},
        diff={"before": before, "after": body.goal},
        severity="info",
        school_id=school_id,
        district_id=existing.get("district_id"),
        message=f"Efficiency Score goal set to {body.goal}",
    )
    return {"goal": body.goal}


@router.get("/api/v1/system/alerts")
def system_alerts(user_data: dict = Depends(verify_firebase_token)):
    # Same role-aware scoping as the Dashboard — admins without a campus
    # context get zero alerts rather than alerts for the UID bucket.
    role = user_data.get("role")
    school_id = user_data.get("school_id")
    if role in ("super_admin", "district_admin", "school_admin"):
        if not school_id:
            return {"alerts": []}
    else:
        school_id = school_id or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    alerts = []
    queue = live_queue.get_sorted(school_id)
    scores = [e["confidence_score"] for e in queue if e.get("confidence_score") is not None]
    if scores and (avg_conf := sum(scores) / len(scores)) < 0.60:
        alerts.append({"id": "low_confidence", "severity": "warning", "message": f"Scanner confidence is low — average {avg_conf * 100:.0f}% over {len(scores)} scan(s). Check camera alignment."})
    if len(queue) >= 15:
        alerts.append({"id": "high_queue", "severity": "warning", "message": f"Queue has {len(queue)} vehicles waiting. Consider deploying additional staff."})
    if 7 <= now.hour < 17 and queue:
        ts = queue[0].get("timestamp")
        if ts:
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            age_minutes = (now - ts).total_seconds() / 60
            if age_minutes > 30:
                alerts.append({"id": "stale_queue", "severity": "info", "message": f"Oldest entry in queue is {int(age_minutes)} minutes old."})
    return {"alerts": alerts}
