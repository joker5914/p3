"""Scheduled-job helpers extracted from the old Cloud Run archival_loop.

These are the bits of ``Backend/core/queue.py`` that survived the
queue_manager → live_queue migration: the daily plate_scans archival
sweep and the per-district SIS roster sync trigger.  Both run from the
``hourly_maintenance`` scheduled function in main.py.
"""
from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE

logger = logging.getLogger(__name__)


def archive_previous_day_scans() -> None:
    """Move yesterday's plate_scans into scan_history; purge records older than 1 year."""
    from core.firebase import db
    from core.utils import _firestore_batch_delete

    tz = ZoneInfo(DEVICE_TIMEZONE)
    today_start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)

    old_scans = list(
        db.collection("plate_scans")
        .where(field_path="timestamp", op_string="<", value=today_start)
        .stream()
    )

    if old_scans:
        CHUNK = 250
        for i in range(0, len(old_scans), CHUNK):
            batch = db.batch()
            for doc in old_scans[i: i + CHUNK]:
                data = doc.to_dict()
                data["archived_at"] = datetime.now(tz)
                data["original_firestore_id"] = doc.id
                batch.set(db.collection("scan_history").document(), data)
                batch.delete(doc.reference)
            batch.commit()
        logger.info("Archived %d scan(s) from plate_scans to scan_history", len(old_scans))

    cutoff = today_start.replace(year=today_start.year - 1)
    expired = list(
        db.collection("scan_history")
        .where(field_path="timestamp", op_string="<", value=cutoff)
        .stream()
    )
    if expired:
        refs = [doc.reference for doc in expired]
        _firestore_batch_delete(refs)
        logger.info("Purged %d expired scan_history record(s) older than 1 year", len(refs))


def purge_stale_live_queue(today_start: datetime | None = None) -> int:
    """Drop yesterday's ``live_queue/{school_id}/events`` mirror entries.

    The Dashboard's onSnapshot listener reads from live_queue; without
    this sweep, rows from a campus that closed without clearing the queue
    (admin forgot to "Mark all picked up", network blip dropped the
    final bulk delete, etc.) briefly render on the next morning's first
    load before the client filters them out.  Same day-boundary as
    ``archive_previous_day_scans`` so the two run in lockstep — anything
    archived to scan_history is also dropped from the live mirror.

    Idempotent: a second pass within the same day finds nothing to delete.
    Safe to run hourly — the timestamp filter ensures only stale rows go.
    """
    from core import live_queue
    from core.firebase import db

    if today_start is None:
        tz = ZoneInfo(DEVICE_TIMEZONE)
        today_start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)

    try:
        school_docs = list(db.collection("live_queue").stream())
    except Exception as exc:
        logger.warning("live_queue purge: school list failed: %s", exc)
        return 0

    total = 0
    for sd in school_docs:
        total += live_queue.purge_before(sd.id, today_start)
    if total:
        logger.info("Purged %d stale live_queue event(s) from before %s",
                    total, today_start.isoformat())
    return total


def _interval_to_minutes(value) -> int:
    try:
        from models.schemas import parse_sync_interval_to_minutes
        return parse_sync_interval_to_minutes(value)
    except Exception:
        return 120


def run_due_sis_syncs() -> None:
    """Iterate enabled districts; trigger sync when the configured
    interval has elapsed since the last successful pass.

    Identical decision logic to the old archival_loop branch — the only
    change is "trigger" labeling, since now Cloud Scheduler is the
    cadence source.
    """
    try:
        from core.firebase import db
        from core.sync import run_sync
    except Exception as exc:
        logger.warning("SIS sync: imports failed: %s", exc)
        return

    now = datetime.utcnow()
    try:
        districts = list(db.collection("districts").stream())
    except Exception as exc:
        logger.warning("SIS sync: district list failed: %s", exc)
        return

    for d in districts:
        data = d.to_dict() or {}
        cfg = data.get("sis_config") or {}
        if not cfg.get("enabled"):
            continue
        interval = _interval_to_minutes(cfg.get("sync_interval", "2h"))
        last = cfg.get("last_sync_at")
        if last is not None:
            try:
                last_naive = last.replace(tzinfo=None) if hasattr(last, "replace") else None
            except Exception:
                last_naive = None
            if last_naive and (now - last_naive).total_seconds() / 60 < interval:
                continue

        try:
            logger.info("SIS scheduled sync: starting district=%s", d.id)
            run_sync(district_id=d.id, trigger="scheduled")
        except Exception as exc:
            logger.error("SIS scheduled sync crashed for district=%s: %s", d.id, exc)
