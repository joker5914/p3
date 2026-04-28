"""One-shot bootstrap migration — replaces the old startup hook.

Originally lived in ``Backend/main.py::_ensure_default_district`` and
ran every cold start.  Cloud Functions cold-start is too frequent to
abuse for migrations, so the same logic now lives behind a manually-
callable function (see main.py: bootstrap_default_district).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def ensure_default_district() -> dict:
    """Create a Default District if none exists, then backfill any
    schools missing a district_id.  Idempotent.

    Returns a small dict so the HTTPS endpoint can echo what happened.
    """
    from core.firebase import db

    try:
        existing = list(db.collection("districts").limit(1).stream())
    except Exception as exc:
        logger.warning("District migration: district read failed: %s", exc)
        raise

    if existing:
        default_id = existing[0].id
        created = False
    else:
        ref = db.collection("districts").add({
            "name":          "Default District",
            "status":        "active",
            "is_licensed":   False,
            "license_tier":  None,
            "timezone":      "America/New_York",
            "admin_email":   "",
            "notes":         "Auto-created on first deploy. Rename me.",
            "created_at":    datetime.now(tz=timezone.utc),
            "created_by":    "system",
        })
        default_id = ref[1].id
        created = True
        logger.info("District migration: created Default District id=%s", default_id)

    backfilled = 0
    try:
        orphans = db.collection("schools").where(
            field_path="district_id", op_string="==", value=None,
        ).stream()
        for sdoc in orphans:
            db.collection("schools").document(sdoc.id).update({"district_id": default_id})
            backfilled += 1
        for sdoc in db.collection("schools").stream():
            data = sdoc.to_dict() or {}
            if "district_id" not in data or not data.get("district_id"):
                db.collection("schools").document(sdoc.id).update({"district_id": default_id})
                backfilled += 1
        if backfilled:
            logger.info("District migration: backfilled %d schools", backfilled)
    except Exception as exc:
        logger.warning("District migration: school backfill failed: %s", exc)
        raise

    return {
        "default_district_id": default_id,
        "default_district_created": created,
        "schools_backfilled": backfilled,
    }
