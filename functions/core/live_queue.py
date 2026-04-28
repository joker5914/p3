"""Firestore-backed live event mirror.

Replaces the in-memory ``queue_manager`` + WebSocket ``registry`` pair
from the Cloud Run-era ``Backend/core/queue.py`` + ``Backend/core/websocket.py``.
Cloud Functions are stateless and can't host either; instead each scan
writes a mirror doc at:

    live_queue/{school_id}/events/{firestore_id}

The dashboard subscribes via the Firebase JS SDK's ``onSnapshot``: adds
appear as new cards, removes fire when the backend deletes on dismiss
or bulk-pickup.  No server process keeps live state.
"""
from __future__ import annotations

import logging
from typing import Iterable, List

from core.firebase import db

logger = logging.getLogger(__name__)


def _events_collection(school_id: str):
    return (
        db.collection("live_queue")
        .document(school_id)
        .collection("events")
    )


def add_event(school_id: str, firestore_id: str, event: dict) -> None:
    """Mirror a freshly-written scan into the live_queue collection.

    Idempotent: re-writing the same firestore_id overwrites the doc.
    """
    try:
        # Ensure the parent doc exists so security rules can match it
        # by collection-id; without this the parent doc is implicit and
        # ``get()`` calls in the rules don't see a school_id field.
        db.collection("live_queue").document(school_id).set(
            {"school_id": school_id}, merge=True,
        )
        _events_collection(school_id).document(firestore_id).set(event)
    except Exception as exc:
        logger.warning(
            "live_queue add failed school=%s id=%s: %s",
            school_id, firestore_id, exc,
        )


def remove_by_plate_token(school_id: str, plate_token: str) -> List[str]:
    """Delete every live_queue event for the given plate_token.

    Returns the list of removed firestore_ids (parity with the old
    queue_manager.remove_event semantics — removed all instances).
    """
    removed: List[str] = []
    try:
        docs = list(
            _events_collection(school_id)
            .where(field_path="plate_token", op_string="==", value=plate_token)
            .stream()
        )
        for d in docs:
            d.reference.delete()
            removed.append(d.id)
    except Exception as exc:
        logger.warning(
            "live_queue remove_by_plate_token school=%s token=%s: %s",
            school_id, plate_token, exc,
        )
    return removed


def remove_by_firestore_ids(school_id: str, firestore_ids: Iterable[str]) -> int:
    """Delete by exact firestore_id list — used after the source-of-truth
    plate_scans rows are marked picked_up so the live mirror stays in sync."""
    n = 0
    for fid in firestore_ids:
        try:
            _events_collection(school_id).document(fid).delete()
            n += 1
        except Exception as exc:
            logger.warning("live_queue remove %s/%s: %s", school_id, fid, exc)
    return n


def clear(school_id: str) -> List[str]:
    """Drop everything currently in the room.

    Returns plate_tokens of removed events for the audit log; parity
    with the old broadcast payload that included plate_tokens.
    """
    removed_tokens: List[str] = []
    try:
        docs = list(_events_collection(school_id).stream())
        for d in docs:
            data = d.to_dict() or {}
            t = data.get("plate_token")
            if t:
                removed_tokens.append(t)
            d.reference.delete()
    except Exception as exc:
        logger.warning("live_queue clear school=%s: %s", school_id, exc)
    return removed_tokens


def get_sorted(school_id: str) -> List[dict]:
    """Read-only snapshot used by /api/v1/system/alerts.

    Cheap (~10-50 docs per school during pickup window).  Returns the
    same shape the old ``queue_manager.get_sorted_queue`` returned so
    the alert thresholds keep working unchanged.
    """
    try:
        docs = list(
            _events_collection(school_id)
            .order_by("timestamp")
            .stream()
        )
        return [d.to_dict() for d in docs]
    except Exception as exc:
        logger.warning("live_queue get_sorted school=%s: %s", school_id, exc)
        return []
