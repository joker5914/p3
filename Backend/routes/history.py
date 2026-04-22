"""History, reports, insights, system alerts, and system health routes."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE
from core.auth import verify_firebase_token
from core.firebase import db
from core.queue import queue_manager
from core.utils import _format_timestamp
from secure_lookup import safe_decrypt

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
        score = data.get("confidence_score")
        if score is not None:
            s = float(score)
            confidence_scores.append(s)
            confidence_buckets["high" if s >= 0.85 else "medium" if s >= 0.60 else "low"] += 1
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
    }


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
    queue = queue_manager.get_sorted_queue(school_id)
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
