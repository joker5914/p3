"""
core/sync.py — SIS → Dismissal roster sync service.

Orchestrates the three stages of every sync pass:

    1. **Fetch** — pull students + guardians + relationships from the SIS
       via the configured provider client (OneRoster today;
       Clever/ClassLink in follow-up PRs).
    2. **Resolve** — reconcile each incoming record against Dismissal's
       existing students/guardians using a three-tier identity cascade
       (``sourcedId`` → ``local_id + name + school`` → ``name + school``
       with admin confirmation → new record).
    3. **Apply** — upsert each matched record, respecting pinned fields
       the district admin manually overrode in Dismissal, and emit
       per-record audit events.

Every pass produces a ``sis_sync_jobs/{id}`` document with totals,
errors, and duration for the Integrations page history view.

Rules — what SIS controls vs. what Dismissal controls
-----------------------------------------------------
SIS wins: names, grade, school assignment, enrollment status, primary
guardian email.

Dismissal wins: photos, vehicles, plates, authorised-pickup lists,
phone numbers (parents update these actively; the SIS copy is often
stale).

Any field a Dismissal admin edits through the admin UI after a sync
gets marked in ``pinned_fields``; subsequent syncs leave it alone.
Today only name/grade are sync-managed so this is theoretical, but
the plumbing is in place so expanding the allowlist later doesn't
cost data-loss incidents.

Non-goals for phase 1
---------------------
* Class / enrollment sync — we track ``school_id`` only; period-level
  scheduling is out of scope for pickup.
* Write-back to SIS — one-way only.  Changes admins make in Dismissal
  (e.g. correcting a typo in a student name) are preserved via
  ``pinned_fields`` but never pushed upstream.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from core.audit import log_event as audit_log
from core.firebase import db
from core.oneroster import OneRosterClient, OneRosterError
from models.schemas import IMPORTED_GUARDIAN_FIELDS, IMPORTED_STUDENT_FIELDS
from secure_lookup import encrypt_string, safe_decrypt

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sync job record
# ---------------------------------------------------------------------------

@dataclass
class SisSyncJob:
    """Shape persisted to ``sis_sync_jobs/{id}`` after every pass."""
    district_id:        str
    provider:           str
    trigger:            str                 # "scheduled" | "manual"
    started_at:         datetime
    finished_at:        Optional[datetime]  = None
    status:             str                 = "running"  # "running" | "ok" | "error"
    error:              Optional[str]       = None
    students_added:     int = 0
    students_updated:   int = 0
    students_removed:   int = 0
    guardians_added:    int = 0
    guardians_updated:  int = 0
    duplicates_flagged: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "district_id":        self.district_id,
            "provider":           self.provider,
            "trigger":            self.trigger,
            "started_at":         self.started_at,
            "finished_at":        self.finished_at,
            "status":             self.status,
            "error":              self.error,
            "students_added":     self.students_added,
            "students_updated":   self.students_updated,
            "students_removed":   self.students_removed,
            "guardians_added":    self.guardians_added,
            "guardians_updated":  self.guardians_updated,
            "duplicates_flagged": self.duplicates_flagged,
        }


# ---------------------------------------------------------------------------
# Provider factory
# ---------------------------------------------------------------------------

def _build_client(district_id: str, sis_config: Dict[str, Any]) -> OneRosterClient:
    """Instantiate the provider client from a decrypted config dict.

    Phase 1 only supports OneRoster.  Clever and ClassLink slot in here
    as ``elif`` branches returning their own client classes (same
    ``fetch_users`` iterator + ``test_connection`` shape) in follow-up
    PRs.
    """
    provider = sis_config.get("provider")
    if provider == "oneroster":
        endpoint = sis_config.get("endpoint_url") or ""
        client_id = sis_config.get("client_id") or ""
        enc_secret = sis_config.get("client_secret_encrypted") or ""
        client_secret = safe_decrypt(enc_secret, default="") if enc_secret else ""
        if not (endpoint and client_id and client_secret):
            raise ValueError("OneRoster config is missing endpoint / client_id / client_secret")
        return OneRosterClient(
            endpoint=endpoint,
            client_id=client_id,
            client_secret=client_secret,
        )
    raise ValueError(f"SIS provider {provider!r} not supported yet")


# ---------------------------------------------------------------------------
# Identity resolution — the three-tier cascade
# ---------------------------------------------------------------------------

def _norm_name(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def _resolve_student(
    district_id: str,
    school_id:   str,
    sourced_id:  str,
    local_id:    Optional[str],
    first:       str,
    last:        str,
) -> Tuple[Optional[str], str]:
    """Return ``(firestore_id, match_type)`` where ``match_type`` ∈
    ``{"sourced_id", "local_id", "name_school", "new"}`` and
    ``firestore_id`` is None for ``"new"``.

    Order is deliberate: highest-confidence signal wins so one sync
    never auto-merges two actually-different students.
    """
    # Tier 1: stable sourcedId — strongest possible signal.
    exact = list(
        db.collection("students")
        .where(field_path="sis_sourced_id", op_string="==", value=sourced_id)
        .limit(1).stream()
    )
    if exact:
        return exact[0].id, "sourced_id"

    # Tier 2: district-assigned local student number (e.g. "12345")
    # combined with name + school.  local_id alone can collide across
    # districts, so the extra fields disambiguate.
    if local_id:
        candidates = list(
            db.collection("students")
            .where(field_path="sis_local_id", op_string="==", value=local_id)
            .where(field_path="school_id", op_string="==", value=school_id)
            .limit(5).stream()
        )
        for c in candidates:
            d = c.to_dict() or {}
            if _norm_name(_decrypt_first(d)) == _norm_name(first) and \
               _norm_name(_decrypt_last(d))  == _norm_name(last):
                return c.id, "local_id"

    # Tier 3: name + school match.  Ambiguous — flagged for admin review
    # rather than auto-merged.  Return the first hit's ID; the caller
    # decides whether to merge or create.
    candidates = list(
        db.collection("students")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )
    for c in candidates:
        d = c.to_dict() or {}
        if _norm_name(_decrypt_first(d)) == _norm_name(first) and \
           _norm_name(_decrypt_last(d))  == _norm_name(last):
            return c.id, "name_school"

    return None, "new"


def _decrypt_first(d: Dict[str, Any]) -> str:
    return safe_decrypt(d.get("first_name_encrypted"), default="") or ""


def _decrypt_last(d: Dict[str, Any]) -> str:
    return safe_decrypt(d.get("last_name_encrypted"), default="") or ""


# ---------------------------------------------------------------------------
# Field mapping — OneRoster user → Dismissal student/guardian
# ---------------------------------------------------------------------------

def _first_name(ou: Dict[str, Any]) -> str:
    return (ou.get("givenName") or "").strip()


def _last_name(ou: Dict[str, Any]) -> str:
    return (ou.get("familyName") or "").strip()


def _email(ou: Dict[str, Any]) -> str:
    return (ou.get("email") or "").strip().lower()


def _phone(ou: Dict[str, Any]) -> str:
    return (ou.get("phone") or "").strip()


def _grade(ou: Dict[str, Any]) -> Optional[str]:
    grades = ou.get("grades") or []
    if isinstance(grades, list) and grades:
        return str(grades[0])
    return None


def _primary_org_sourced_id(ou: Dict[str, Any]) -> Optional[str]:
    """OneRoster users embed an ``orgs`` array; the ``primary``-flagged
    entry is the user's home school for our purposes."""
    for o in (ou.get("orgs") or []):
        if o.get("primary") or o.get("roleType") == "primary":
            return o.get("sourcedId")
    # Fall back to the first org if no primary flag is present.
    orgs = ou.get("orgs") or []
    if orgs:
        return orgs[0].get("sourcedId")
    return None


# ---------------------------------------------------------------------------
# Sync pass
# ---------------------------------------------------------------------------

def _load_district_config(district_id: str) -> Optional[Dict[str, Any]]:
    snap = db.collection("districts").document(district_id).get()
    if not snap.exists:
        return None
    return ((snap.to_dict() or {}).get("sis_config") or None)


def _school_id_from_sourced(
    sourced_id: Optional[str],
    cache: Dict[str, Optional[str]],
    district_id: str,
) -> Optional[str]:
    """Map an SIS-side org sourcedId to a Dismissal ``school_id``.

    Districts register each school's SIS sourcedId via
    ``schools/{id}.sis_org_sourced_id``; if one of those matches, we
    route students there.  Unmapped orgs fall through and the student
    is skipped (logged as a warning) rather than landing in the
    wrong school.
    """
    if sourced_id in cache:
        return cache[sourced_id]
    if not sourced_id:
        cache[sourced_id] = None
        return None
    docs = list(
        db.collection("schools")
        .where(field_path="district_id", op_string="==", value=district_id)
        .where(field_path="sis_org_sourced_id", op_string="==", value=sourced_id)
        .limit(1).stream()
    )
    school_id = docs[0].id if docs else None
    cache[sourced_id] = school_id
    return school_id


def run_sync(
    district_id: str,
    trigger: str = "scheduled",
    actor: Optional[Dict[str, Any]] = None,
) -> SisSyncJob:
    """Run one full or delta sync pass for ``district_id``.

    Returns the completed ``SisSyncJob`` (persisted before return).
    Errors inside the pass are caught and recorded on the job rather
    than raised — the caller (scheduler or HTTP handler) decides how
    to surface them.
    """
    config = _load_district_config(district_id)
    job = SisSyncJob(
        district_id = district_id,
        provider    = (config or {}).get("provider", "unknown"),
        trigger     = trigger,
        started_at  = datetime.now(timezone.utc),
    )

    if not config or not config.get("enabled"):
        job.status = "error"
        job.error  = "SIS is not enabled for this district"
        job.finished_at = datetime.now(timezone.utc)
        _persist_job(job)
        return job

    actor_for_audit = actor or {"uid": "system", "role": "system", "display_name": "Scheduled sync"}

    audit_log(
        action="sis.sync.started",
        actor=actor_for_audit,
        target={"type": "district", "id": district_id, "display_name": district_id},
        diff={"provider": job.provider, "trigger": trigger},
        district_id=district_id,
        message=f"SIS sync started ({trigger})",
    )

    try:
        client = _build_client(district_id, config)
    except Exception as exc:
        job.status = "error"
        job.error  = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        _persist_job(job)
        audit_log(
            action="sis.sync.failed", actor=actor_for_audit,
            target={"type": "district", "id": district_id},
            severity="warning",
            district_id=district_id,
            message=f"SIS sync config invalid: {exc}",
        )
        return job

    last_sync = _parse_iso(config.get("last_sync_at"))
    school_cache: Dict[str, Optional[str]] = {}

    try:
        _sync_students(client, district_id, last_sync, school_cache, job, actor_for_audit)
        _sync_guardians(client, district_id, last_sync, job, actor_for_audit)
    except OneRosterError as exc:
        job.status = "error"
        job.error  = str(exc)[:500]
        job.finished_at = datetime.now(timezone.utc)
        _persist_job(job)
        audit_log(
            action="sis.sync.failed", actor=actor_for_audit,
            target={"type": "district", "id": district_id},
            severity="warning",
            district_id=district_id,
            message=f"SIS sync failed: {str(exc)[:160]}",
        )
        return job
    except Exception as exc:
        logger.exception("Unhandled SIS sync error for district %s", district_id)
        job.status = "error"
        job.error  = f"Internal: {type(exc).__name__}: {str(exc)[:400]}"
        job.finished_at = datetime.now(timezone.utc)
        _persist_job(job)
        return job

    job.status = "ok"
    job.finished_at = datetime.now(timezone.utc)
    _persist_job(job)

    # Stamp last_sync_at on the district config so the next pass does a
    # delta rather than a full refetch.
    try:
        db.collection("districts").document(district_id).update({
            "sis_config.last_sync_at":      job.finished_at,
            "sis_config.last_sync_status":  "ok",
            "sis_config.last_sync_summary": {
                "students_added":   job.students_added,
                "students_updated": job.students_updated,
                "guardians_added":  job.guardians_added,
                "guardians_updated": job.guardians_updated,
                "duplicates_flagged": job.duplicates_flagged,
            },
        })
    except Exception as exc:
        logger.warning("Failed to stamp last_sync on district %s: %s", district_id, exc)

    audit_log(
        action="sis.sync.completed",
        actor=actor_for_audit,
        target={"type": "district", "id": district_id, "display_name": district_id},
        diff=job.to_dict(),
        district_id=district_id,
        message=(
            f"SIS sync ok — +{job.students_added} / ~{job.students_updated} students, "
            f"+{job.guardians_added} / ~{job.guardians_updated} guardians, "
            f"{job.duplicates_flagged} flagged for review"
        ),
    )
    return job


def _sync_students(
    client:      OneRosterClient,
    district_id: str,
    since:       Optional[datetime],
    school_cache: Dict[str, Optional[str]],
    job:         SisSyncJob,
    actor:       Dict[str, Any],
) -> None:
    for ou in client.fetch_users(role="student", since=since):
        sourced_id = ou.get("sourcedId")
        if not sourced_id:
            continue
        first = _first_name(ou)
        last  = _last_name(ou)
        if not (first and last):
            continue
        school_sid = _school_id_from_sourced(
            _primary_org_sourced_id(ou), school_cache, district_id,
        )
        if not school_sid:
            logger.info(
                "SIS sync: skipping student sourcedId=%s — no matching school in Dismissal",
                sourced_id,
            )
            continue

        local_id = ou.get("identifier")  # OneRoster convention for the SIS's local number
        fid, match = _resolve_student(
            district_id, school_sid, sourced_id, local_id, first, last,
        )

        if match in ("sourced_id", "local_id"):
            _update_student(fid, ou, school_sid, sourced_id, local_id, job, actor)
        elif match == "name_school":
            _flag_duplicate(fid, ou, school_sid, sourced_id, local_id, district_id, job, actor)
        else:
            _create_student(ou, school_sid, sourced_id, local_id, first, last, district_id, job, actor)


def _sync_guardians(
    client:      OneRosterClient,
    district_id: str,
    since:       Optional[datetime],
    job:         SisSyncJob,
    actor:       Dict[str, Any],
) -> None:
    for ou in client.fetch_users(role="parent", since=since):
        sourced_id = ou.get("sourcedId")
        email = _email(ou)
        if not sourced_id or not email:
            continue
        # Upsert by email — guardians already sign in with email, so
        # that's the stable identity anchor on our side.
        docs = list(
            db.collection("guardians")
            .where(field_path="email_lower", op_string="==", value=email)
            .limit(1).stream()
        )
        now_iso = datetime.now(timezone.utc).isoformat()
        first = _first_name(ou)
        last  = _last_name(ou)
        display_name = f"{first} {last}".strip() or email
        phone = _phone(ou)
        if docs:
            doc = docs[0]
            data = doc.to_dict() or {}
            pinned = set(data.get("sis_pinned_fields") or [])
            updates: Dict[str, Any] = {
                "sis_sourced_id": sourced_id,
                "sis_synced_at":  now_iso,
            }
            if "display_name" not in pinned and display_name:
                updates["display_name"] = display_name
            # Phone intentionally Dismissal-wins — see file docstring.
            if phone and not data.get("phone") and "phone" not in pinned:
                updates["phone"] = phone
            doc.reference.update(updates)
            job.guardians_updated += 1
            audit_log(
                action="sis.guardian.updated", actor=actor,
                target={"type": "guardian", "id": doc.id, "display_name": email},
                diff={"fields": list(updates.keys())},
                district_id=district_id,
            )
        else:
            uid = f"sis_{uuid.uuid4().hex[:16]}"
            record = {
                "display_name":       display_name,
                "email":              email,
                "email_lower":        email,
                "phone":              phone or None,
                "photo_url":          None,
                "assigned_school_ids": [],
                "sis_sourced_id":     sourced_id,
                "sis_synced_at":      now_iso,
                "sis_managed_fields": ["display_name"],
                "created_at":         now_iso,
                "sso_provider":       None,
            }
            db.collection("guardians").document(uid).set(record)
            job.guardians_added += 1
            audit_log(
                action="sis.guardian.added", actor=actor,
                target={"type": "guardian", "id": uid, "display_name": email},
                diff={"email": email, "sourced_id": sourced_id},
                district_id=district_id,
            )


# ---------------------------------------------------------------------------
# Write paths — create / update / flag
# ---------------------------------------------------------------------------

def _update_student(
    fid: str,
    ou:  Dict[str, Any],
    school_id: str,
    sourced_id: str,
    local_id: Optional[str],
    job: SisSyncJob,
    actor: Dict[str, Any],
) -> None:
    doc = db.collection("students").document(fid).get()
    data = doc.to_dict() or {}
    pinned = set(data.get("sis_pinned_fields") or [])
    updates: Dict[str, Any] = {
        "sis_sourced_id": sourced_id,
        "sis_local_id":   local_id,
        "sis_synced_at":  datetime.now(timezone.utc).isoformat(),
        "school_id":      school_id,
    }
    if "given_name" not in pinned:
        updates["first_name_encrypted"] = encrypt_string(_first_name(ou))
    if "family_name" not in pinned:
        updates["last_name_encrypted"]  = encrypt_string(_last_name(ou))
    grade = _grade(ou)
    if grade is not None and "grade" not in pinned:
        updates["grade"] = grade
    db.collection("students").document(fid).update(updates)
    job.students_updated += 1
    audit_log(
        action="sis.student.updated",
        actor=actor,
        target={"type": "student", "id": fid, "display_name": f"{_first_name(ou)} {_last_name(ou)}"},
        diff={"fields": [k for k in updates.keys() if k not in ("sis_sourced_id", "sis_local_id", "sis_synced_at")]},
        school_id=school_id,
    )


def _create_student(
    ou: Dict[str, Any],
    school_id: str,
    sourced_id: str,
    local_id: Optional[str],
    first: str,
    last: str,
    district_id: str,
    job: SisSyncJob,
    actor: Dict[str, Any],
) -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    record: Dict[str, Any] = {
        "first_name_encrypted": encrypt_string(first),
        "last_name_encrypted":  encrypt_string(last),
        "school_id":            school_id,
        "school_name":          _school_name(school_id),
        "grade":                _grade(ou),
        "photo_url":            None,
        "guardian_uid":         None,
        "status":               "unlinked",
        "created_at":           now_iso,
        "sis_sourced_id":       sourced_id,
        "sis_local_id":         local_id,
        "sis_synced_at":        now_iso,
        "sis_managed_fields":   ["given_name", "family_name", "grade"],
    }
    _, ref = db.collection("students").add(record)
    job.students_added += 1
    audit_log(
        action="sis.student.added",
        actor=actor,
        target={"type": "student", "id": ref.id, "display_name": f"{first} {last}"},
        diff={"school_id": school_id, "grade": record["grade"], "sourced_id": sourced_id},
        school_id=school_id,
        district_id=district_id,
    )


def _flag_duplicate(
    existing_fid: str,
    ou: Dict[str, Any],
    school_id: str,
    sourced_id: str,
    local_id: Optional[str],
    district_id: str,
    job: SisSyncJob,
    actor: Dict[str, Any],
) -> None:
    """Record a pending duplicate for admin resolution.  We don't touch
    the existing student until an admin chooses 'merge' or 'keep
    separate' via the Integrations review panel."""
    record = {
        "district_id":         district_id,
        "school_id":           school_id,
        "existing_student_id": existing_fid,
        "sis_sourced_id":      sourced_id,
        "sis_local_id":        local_id,
        "sis_given_name":      _first_name(ou),
        "sis_family_name":     _last_name(ou),
        "sis_grade":           _grade(ou),
        "flagged_at":          datetime.now(timezone.utc).isoformat(),
        "status":              "pending",
    }
    # Idempotent — don't stack multiple pending dups for the same
    # (existing_student_id, sourcedId) pair across repeated syncs.
    existing = list(
        db.collection("sis_duplicates")
        .where(field_path="existing_student_id", op_string="==", value=existing_fid)
        .where(field_path="sis_sourced_id",       op_string="==", value=sourced_id)
        .limit(1).stream()
    )
    if existing:
        return
    _, ref = db.collection("sis_duplicates").add(record)
    job.duplicates_flagged += 1
    audit_log(
        action="sis.duplicate.flagged",
        actor=actor,
        target={"type": "student", "id": existing_fid,
                "display_name": f"{_first_name(ou)} {_last_name(ou)}"},
        diff={"sis_sourced_id": sourced_id, "duplicate_doc_id": ref.id},
        severity="warning",
        school_id=school_id,
        district_id=district_id,
        message="Name+school match — admin needs to confirm or reject merge",
    )


def _school_name(school_id: str) -> str:
    try:
        snap = db.collection("schools").document(school_id).get()
        return (snap.to_dict() or {}).get("name", "") if snap.exists else ""
    except Exception:
        return ""


def _persist_job(job: SisSyncJob) -> str:
    _, ref = db.collection("sis_sync_jobs").add(job.to_dict())
    return ref.id


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None
