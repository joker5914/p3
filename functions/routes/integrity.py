"""
routes/integrity.py — platform-wide data integrity check + self-heal.

Triggered from the Account Settings page by a super_admin.  Sweeps every
collection that the product has evolved over and rewrites any doc whose
shape no longer matches how a fresh install would write it.  Non-
destructive by design — we fill gaps and reconcile references, never
delete records the admin might still care about.

Checks:

1.  **districts** — ensure at least one district exists ("Default District")
    so orphan schools have a landing zone.

2.  **schools** — every school must carry a ``district_id`` pointing at a
    real district.  Missing or dangling IDs are healed to Default District.

3.  **devices** — if ``school_id`` is set, ``district_id`` must match the
    school's current district.  Catches both "new device, never had a
    district" and "school moved districts after device was pinned".

4.  **school_admins** — per-role scope:
        * super_admin: must not carry a school_id / district_id (platform
          users cross every tenant).
        * district_admin: must carry a district_id.  If absent but a
          school_id is present, lift the district from the school.
        * school_admin / staff: if school_id is present and district_id is
          absent, backfill district_id from the school.

5.  **Firebase Auth custom claims** — mirror role / school_id / district_id
    from the school_admins doc so the next sign-in picks up the resolved
    scope without forcing a claim-refresh hack.

Warnings (reported, not auto-fixed):
    * school_admins whose school_id or district_id points at a deleted doc
    * devices whose school_id points at a deleted doc
    * plate_scans whose school_id points at a deleted doc

The report shape is stable:

    {
      "ok": bool,               # true when nothing needed fixing
      "ran_at": ISO timestamp,
      "summary": {
        "fixed": N,             # count of doc updates applied
        "warnings": M,          # count of things that need manual attention
      },
      "checks": [
        {
          "id":       "schools.district_id.backfill",
          "label":    "Schools missing district_id",
          "status":   "fixed" | "ok" | "warning",
          "count":    N,
          "details":  ["school_A → Default District", ...]
        },
        ...
      ]
    }
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from firebase_admin import auth as fb_auth

from core.auth import require_super_admin
from core.firebase import db

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Report helpers
# ---------------------------------------------------------------------------

class CheckResult:
    """``fix_category`` lets the UI render a destructive "Fix" action next
    to warnings we can't auto-heal in the main pass (deleting orphan
    scans, clearing stale refs).  Corresponds to the ``category`` arg of
    ``POST /integrity/fix-orphans``."""
    __slots__ = ("check_id", "label", "status", "count", "details", "fix_category")

    def __init__(self, check_id: str, label: str, fix_category: Optional[str] = None):
        self.check_id     = check_id
        self.label        = label
        self.status       = "ok"   # ok | fixed | warning
        self.count        = 0
        self.details: list[str] = []
        self.fix_category = fix_category

    def fixed(self, detail: str) -> None:
        self.status = "fixed"
        self.count += 1
        if len(self.details) < 50:
            self.details.append(detail)

    def warn(self, detail: str) -> None:
        if self.status != "fixed":
            self.status = "warning"
        self.count += 1
        if len(self.details) < 50:
            self.details.append(detail)

    def to_dict(self) -> dict:
        return {
            "id":           self.check_id,
            "label":        self.label,
            "status":       self.status,
            "count":        self.count,
            "details":      self.details,
            "fix_category": self.fix_category,
        }


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def _ensure_default_district(results: list[CheckResult]) -> str:
    """Return the ID of Default District, creating it if no district exists
    at all.  Named to match the startup migration so repeat runs are a
    no-op."""
    chk = CheckResult("districts.default_exists", "Default District exists")
    existing = list(db.collection("districts").limit(1).stream())
    if existing:
        chk.count = 1
        results.append(chk)
        # Prefer an existing district literally named "Default District",
        # otherwise fall back to the first we find.
        for d in db.collection("districts").stream():
            data = d.to_dict() or {}
            if (data.get("name") or "").strip().lower() == "default district":
                return d.id
        return existing[0].id

    ref = db.collection("districts").add({
        "name":         "Default District",
        "status":       "active",
        "is_licensed":  False,
        "license_tier": None,
        "timezone":     "America/New_York",
        "admin_email":  "",
        "notes":        "Auto-created by integrity check.",
        "created_at":   datetime.now(tz=timezone.utc),
        "created_by":   "integrity-check",
    })
    chk.fixed("Created Default District")
    results.append(chk)
    return ref[1].id


def _check_schools(results: list[CheckResult], default_district: str) -> dict:
    """Every school must carry a valid ``district_id``.  Returns a map of
    school_id → district_id so follow-up checks can look up the school's
    current district without a fresh read."""
    chk = CheckResult("schools.district_id", "Schools pinned to a valid district")
    school_to_district: dict = {}

    district_ids = {d.id for d in db.collection("districts").stream()}

    for doc in db.collection("schools").stream():
        data = doc.to_dict() or {}
        did  = data.get("district_id")
        if not did:
            db.collection("schools").document(doc.id).update({"district_id": default_district})
            chk.fixed(f"School '{data.get('name') or doc.id}' → Default District")
            did = default_district
        elif did not in district_ids:
            db.collection("schools").document(doc.id).update({"district_id": default_district})
            chk.fixed(f"School '{data.get('name') or doc.id}' had stale district → Default District")
            did = default_district
        school_to_district[doc.id] = did

    results.append(chk)
    return school_to_district


def _check_devices(results: list[CheckResult], school_to_district: dict) -> None:
    """Devices carry both ``school_id`` (set by district admin) and
    ``district_id`` (set by super admin).  Heal drift so the UI's cascade
    (district → school) always matches what the device is actually
    assigned to."""
    chk_scope  = CheckResult("devices.scope", "Device district ↔ school consistency")
    chk_orphan = CheckResult(
        "devices.refs", "Devices reference real schools",
        fix_category="devices",
    )

    district_ids = {d.id for d in db.collection("districts").stream()}

    for doc in db.collection("devices").stream():
        data = doc.to_dict() or {}
        sid  = data.get("school_id")
        did  = data.get("district_id")
        updates: dict = {}

        if sid and sid not in school_to_district:
            chk_orphan.warn(f"Device '{doc.id}' school_id={sid} no longer exists")
            continue

        if sid:
            expected = school_to_district.get(sid)
            if did != expected:
                updates["district_id"] = expected
        elif did and did not in district_ids:
            updates["district_id"] = None
            chk_scope.warn(f"Device '{doc.id}' had stale district_id cleared")

        if updates:
            db.collection("devices").document(doc.id).update(updates)
            chk_scope.fixed(f"Device '{doc.id}' district → {updates.get('district_id') or '—'}")

    results.extend([chk_scope, chk_orphan])


def _check_admins(results: list[CheckResult], school_to_district: dict) -> list[dict]:
    """Per-role scope validation on every school_admins record.  Returns
    the (possibly updated) list so the auth-claim sweep can reuse it
    without re-reading Firestore."""
    chk_super  = CheckResult("admins.super_admin.scope", "Platform admins have no scope")
    chk_dist   = CheckResult("admins.district_admin.scope", "District admins carry a district")
    chk_school = CheckResult("admins.school_scope.backfill", "School admins / staff carry a district")
    chk_orphan = CheckResult(
        "admins.refs", "Admin docs reference real schools / districts",
        fix_category="admins",
    )

    district_ids = {d.id for d in db.collection("districts").stream()}
    refreshed: list[dict] = []

    for doc in db.collection("school_admins").stream():
        data = dict(doc.to_dict() or {})
        role = data.get("role")
        updates: dict = {}
        uid  = data.get("uid") or doc.id
        label = data.get("email") or uid

        if role == "super_admin":
            if data.get("school_id"):
                updates["school_id"] = None
            if data.get("district_id"):
                updates["district_id"] = None
            if updates:
                chk_super.fixed(f"'{label}' — cleared scope on Platform Admin")

        elif role == "district_admin":
            did = data.get("district_id")
            if not did:
                sid = data.get("school_id")
                if sid and sid in school_to_district:
                    updates["district_id"] = school_to_district[sid]
                    chk_dist.fixed(f"'{label}' — district resolved from school")
                else:
                    chk_dist.warn(f"'{label}' — district_admin with no district_id; assign one from Platform Users")
            elif did not in district_ids:
                chk_orphan.warn(f"'{label}' — district_id {did} no longer exists")

        elif role in ("school_admin", "staff"):
            sid = data.get("school_id")
            if sid and sid not in school_to_district:
                chk_orphan.warn(f"'{label}' — school_id {sid} no longer exists")
            elif sid and not data.get("district_id"):
                updates["district_id"] = school_to_district[sid]
                chk_school.fixed(f"'{label}' — district backfilled from school")
            elif sid and data.get("district_id") != school_to_district[sid]:
                # School moved to a different district after this admin was
                # pinned; keep the pointer in sync with the school.
                updates["district_id"] = school_to_district[sid]
                chk_school.fixed(f"'{label}' — district realigned with school")

        if updates:
            db.collection("school_admins").document(doc.id).update(updates)
            data.update(updates)
        refreshed.append(data)

    results.extend([chk_super, chk_dist, chk_school, chk_orphan])
    return refreshed


def _check_auth_claims(results: list[CheckResult], admins: list[dict]) -> None:
    """Firebase Auth custom claims should mirror role + scope on the
    school_admins doc.  Drift shows up when docs are hand-edited, or
    when earlier code paths forgot to mirror."""
    chk = CheckResult("auth.claims.sync", "Firebase Auth claims match Firestore")

    for data in admins:
        uid  = data.get("uid")
        if not uid:
            continue
        role = data.get("role")
        desired: dict = {}
        if role:
            desired["role"] = role
        if data.get("school_id"):
            desired["school_id"] = data["school_id"]
        if data.get("district_id"):
            desired["district_id"] = data["district_id"]

        try:
            fb_user = fb_auth.get_user(uid)
            existing = fb_user.custom_claims or {}
        except Exception as exc:
            chk.warn(f"{data.get('email') or uid}: Firebase user lookup failed ({exc})")
            continue

        # Desired claims should be present and equal; stale scope fields
        # that are no longer on the doc should be removed.
        drift = False
        merged = dict(existing)
        for k in ("role", "school_id", "district_id"):
            want = desired.get(k)
            have = existing.get(k)
            if want and want != have:
                merged[k] = want
                drift = True
            elif not want and have:
                merged.pop(k, None)
                drift = True

        if drift:
            try:
                fb_auth.set_custom_user_claims(uid, merged)
                chk.fixed(f"{data.get('email') or uid} — claims re-synced")
            except Exception as exc:
                chk.warn(f"{data.get('email') or uid}: claim write failed ({exc})")

    results.append(chk)


def _check_scan_refs(results: list[CheckResult], school_to_district: dict) -> None:
    """plate_scans should reference a real school.  We don't auto-delete
    — deletion is destructive and permanent, so it lives behind the
    orphan-fix action a super_admin has to trigger explicitly."""
    chk = CheckResult(
        "scans.refs", "Scan rows reference real schools",
        fix_category="scans",
    )

    orphans = 0
    for doc in db.collection("plate_scans").stream():
        sid = (doc.to_dict() or {}).get("school_id")
        if sid and sid not in school_to_district:
            orphans += 1
    if orphans:
        chk.warn(f"{orphans} scan row{'s' if orphans != 1 else ''} reference a deleted school")
    else:
        chk.count = 0

    results.append(chk)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/api/v1/admin/integrity/fix-orphans")
def fix_orphans(category: str, user_data: dict = Depends(require_super_admin)):
    """Destructive cleanup of references that point at deleted parents.

    Kept out of the main ``/check`` pass so a super_admin has to trigger
    it deliberately — once these records are gone, there's no
    server-side undo.

    * ``category=scans``   — deletes ``plate_scans`` whose ``school_id``
      no longer exists.  Use when a school was fully deleted and its
      historical scans should go with it.  Irreversible.
    * ``category=admins``  — clears ``school_id`` / ``district_id`` on
      ``school_admins`` docs when those refs are dead.  The account stays
      active but becomes unscoped — sign-ins land on the School Selection
      prompt until re-homed from Platform Users.
    * ``category=devices`` — clears ``school_id`` on ``devices`` whose
      referenced school is gone.  Device returns to "awaiting school
      assignment" inside its district.

    Firebase Auth custom claims aren't rewritten here directly — the
    next ``/check`` run mirrors any cleared scope on the school_admins
    doc back to the claim.  The frontend re-runs ``/check`` right after
    a fix so that's transparent."""
    from google.cloud.firestore_v1 import FieldFilter  # noqa: F401  (import check)
    _ = FieldFilter  # keeps linters quiet when the import isn't needed

    if category not in ("scans", "admins", "devices"):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="category must be 'scans', 'admins' or 'devices'")

    valid_schools   = {d.id for d in db.collection("schools").stream()}
    valid_districts = {d.id for d in db.collection("districts").stream()}

    summary = {"category": category, "affected": 0, "details": []}

    if category == "scans":
        # Firestore doesn't support a batch-delete primitive, so we loop.
        # Typical platform has O(thousands) of orphans at worst; tune if
        # this ever gets slow.
        for doc in db.collection("plate_scans").stream():
            sid = (doc.to_dict() or {}).get("school_id")
            if sid and sid not in valid_schools:
                db.collection("plate_scans").document(doc.id).delete()
                summary["affected"] += 1
        logger.info(
            "Integrity fix-orphans: deleted %d plate_scans by=%s",
            summary["affected"], user_data.get("uid"),
        )

    elif category == "admins":
        for doc in db.collection("school_admins").stream():
            data = doc.to_dict() or {}
            updates: dict = {}
            sid = data.get("school_id")
            did = data.get("district_id")
            if sid and sid not in valid_schools:
                updates["school_id"] = None
            if did and did not in valid_districts:
                updates["district_id"] = None
            if updates:
                db.collection("school_admins").document(doc.id).update(updates)
                summary["affected"] += 1
                label = data.get("email") or doc.id
                summary["details"].append(
                    f"{label} — cleared: " + ", ".join(updates.keys())
                )
        logger.info(
            "Integrity fix-orphans: unscoped %d admin docs by=%s",
            summary["affected"], user_data.get("uid"),
        )

    elif category == "devices":
        for doc in db.collection("devices").stream():
            sid = (doc.to_dict() or {}).get("school_id")
            if sid and sid not in valid_schools:
                db.collection("devices").document(doc.id).update({"school_id": None})
                summary["affected"] += 1
                summary["details"].append(f"Device '{doc.id}' — school cleared")
        logger.info(
            "Integrity fix-orphans: unscoped %d devices by=%s",
            summary["affected"], user_data.get("uid"),
        )

    return summary


@router.post("/api/v1/admin/integrity/check")
def run_integrity_check(user_data: dict = Depends(require_super_admin)):
    logger.info("Data integrity check started by uid=%s", user_data.get("uid"))
    checks: list[CheckResult] = []

    default_district = _ensure_default_district(checks)
    school_to_district = _check_schools(checks, default_district)
    _check_devices(checks, school_to_district)
    admins_after = _check_admins(checks, school_to_district)
    _check_auth_claims(checks, admins_after)
    _check_scan_refs(checks, school_to_district)

    fixed_total    = sum(c.count for c in checks if c.status == "fixed")
    warnings_total = sum(c.count for c in checks if c.status == "warning")

    report = {
        "ok":       fixed_total == 0 and warnings_total == 0,
        "ran_at":   datetime.now(tz=timezone.utc).isoformat(),
        "summary":  {"fixed": fixed_total, "warnings": warnings_total},
        "checks":   [c.to_dict() for c in checks],
    }
    logger.info(
        "Data integrity check done: fixed=%d warnings=%d ok=%s",
        fixed_total, warnings_total, report["ok"],
    )
    return report
