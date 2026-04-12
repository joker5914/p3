"""In-memory pickup queue manager and daily scan archival loop."""
import asyncio
import logging
import threading
from datetime import datetime
from typing import Dict, List

from zoneinfo import ZoneInfo

from config import DEVICE_TIMEZONE

logger = logging.getLogger(__name__)


class QueueManager:
    """Thread-safe per-school in-memory event queue."""

    def __init__(self):
        self._lock = threading.Lock()
        self._queues: Dict[str, List[dict]] = {}

    def add_event(self, school_id: str, event: dict):
        with self._lock:
            self._queues.setdefault(school_id, []).append(event)

    def get_sorted_queue(self, school_id: str) -> List[dict]:
        with self._lock:
            return sorted(
                self._queues.get(school_id, []),
                key=lambda x: x["timestamp"],
            )

    def remove_event(self, school_id: str, plate_token: str):
        with self._lock:
            queue = self._queues.get(school_id, [])
            self._queues[school_id] = [e for e in queue if e["plate_token"] != plate_token]

    def clear(self, school_id: str):
        with self._lock:
            self._queues[school_id] = []

    def get_event(self, school_id: str, plate_token: str):
        with self._lock:
            queue = self._queues.get(school_id, [])
            return next((e for e in queue if e["plate_token"] == plate_token), None)

    def get_all_events(self, school_id: str) -> List[dict]:
        with self._lock:
            return list(self._queues.get(school_id, []))


queue_manager = QueueManager()


def _archive_previous_day_scans():
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


async def archival_loop():
    """Hourly background task: archive previous-day scans."""
    while True:
        try:
            await asyncio.to_thread(_archive_previous_day_scans)
        except Exception as exc:
            logger.error("Scan archival error: %s", exc)
        await asyncio.sleep(3600)
