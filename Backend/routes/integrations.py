"""
routes/integrations.py — SIS (Student Information System) integration CRUD.

Scope today: OneRoster 1.2.  Clever / ClassLink / PowerSchool-specific
slots exist in the provider enum but the wizard renders them as
"Coming soon" placeholders until their client implementations ship in
follow-up PRs.

All endpoints are district-scoped.  ``super_admin`` can configure any
district (via the drill-down with ``X-District-Id``); ``district_admin``
can only touch their own district.  School admins see read-only status
only — the SIS connection is a district-level decision.

Credential storage
------------------
``client_secret`` is encrypted with the existing
``DISMISSAL_ENCRYPTION_KEY`` (Fernet) before any Firestore write; the
GET response substitutes ``"__dismissal_secret_set__"`` as a sentinel so
the wizard can tell "a secret is configured" without ever round-tripping
the plaintext.  A PUT with no ``client_secret`` field preserves the
existing encrypted value; a PUT with a new secret rotates it.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from core.audit import log_event as audit_log
from core.auth import verify_firebase_token
from core.firebase import db
from core.oneroster import OneRosterClient, OneRosterError
from core.sync import run_sync
from models.schemas import (
    SIS_PROVIDERS,
    SIS_SYNC_INTERVALS,
    SisConfigUpdate,
    SisDuplicateResolveRequest,
    SisTestConnectionRequest,
)
from secure_lookup import encrypt_string, safe_decrypt

logger = logging.getLogger(__name__)

router = APIRouter()

# Sentinel returned in place of the real encrypted secret.  The wizard
# knows to treat this as "secret already configured, leave it alone".
_SECRET_PLACEHOLDER = "__dismissal_secret_set__"


# ---------------------------------------------------------------------------
# Access helpers
# ---------------------------------------------------------------------------

def _can_admin_district(user_data: dict, district_id: str) -> bool:
    role = user_data.get("role")
    if role == "super_admin":
        return True
    return role == "district_admin" and user_data.get("district_id") == district_id


def _assert_district_admin(user_data: dict, district_id: str) -> None:
    if not _can_admin_district(user_data, district_id):
        raise HTTPException(
            status_code=403,
            detail="Only the district's admins (or a platform admin) can configure SIS integrations.",
        )


def _assert_district_viewer(user_data: dict, district_id: str) -> None:
    """Viewers of the status (not writers): district admins of this
    district + super admins + school admins whose school belongs to
    this district."""
    role = user_data.get("role")
    if role in ("super_admin",):
        return
    if role == "district_admin" and user_data.get("district_id") == district_id:
        return
    if role in ("school_admin", "staff"):
        # The simpler check here is "does this school belong to that
        # district?".  We look up the school's district_id.
        school_id = user_data.get("school_id")
        if not school_id:
            raise HTTPException(status_code=403, detail="No school context")
        try:
            snap = db.collection("schools").document(school_id).get()
            if snap.exists and (snap.to_dict() or {}).get("district_id") == district_id:
                return
        except Exception:
            pass
    raise HTTPException(status_code=403, detail="Not allowed to view this district's SIS config")


# ---------------------------------------------------------------------------
# Config serialisation
# ---------------------------------------------------------------------------

def _serialise_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Strip secrets, format timestamps.  Never returns plaintext
    credentials — the wizard uses the sentinel to tell 'is a secret
    configured?' without ever reading the underlying value."""
    out: Dict[str, Any] = {
        "enabled":       bool(cfg.get("enabled", False)),
        "provider":      cfg.get("provider"),
        "endpoint_url":  cfg.get("endpoint_url"),
        "client_id":     cfg.get("client_id"),
        "client_secret": _SECRET_PLACEHOLDER if cfg.get("client_secret_encrypted") else None,
        "sync_interval": cfg.get("sync_interval", "2h"),
        "store_raw":     bool(cfg.get("store_raw", False)),
        "last_sync_at":         _fmt_ts(cfg.get("last_sync_at")),
        "last_sync_status":     cfg.get("last_sync_status"),
        "last_sync_summary":    cfg.get("last_sync_summary") or {},
    }
    return out


def _fmt_ts(v: Any) -> Optional[str]:
    if not v:
        return None
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            pass
    return str(v)


# ---------------------------------------------------------------------------
# Endpoints — config
# ---------------------------------------------------------------------------

@router.get("/api/v1/admin/districts/{district_id}/sis-config")
def get_sis_config(
    district_id: str,
    user_data: dict = Depends(verify_firebase_token),
):
    _assert_district_viewer(user_data, district_id)
    snap = db.collection("districts").document(district_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="District not found")
    cfg = (snap.to_dict() or {}).get("sis_config") or {}
    return {"district_id": district_id, "sis_config": _serialise_config(cfg)}


@router.put("/api/v1/admin/districts/{district_id}/sis-config")
def put_sis_config(
    district_id: str,
    body: SisConfigUpdate,
    user_data: dict = Depends(verify_firebase_token),
):
    _assert_district_admin(user_data, district_id)
    ref = db.collection("districts").document(district_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="District not found")

    existing_cfg = (snap.to_dict() or {}).get("sis_config") or {}
    payload = body.model_dump(exclude_unset=True)
    updates: Dict[str, Any] = {}
    diff: Dict[str, Any] = {}

    # Track enable/disable separately so the audit log has a specific
    # action name — "config.updated" is noisy; "enabled" is the signal
    # compliance reviewers actually scan for.
    enable_transition: Optional[str] = None
    if "enabled" in payload:
        was = bool(existing_cfg.get("enabled", False))
        now_val = bool(payload["enabled"])
        if was != now_val:
            enable_transition = "enabled" if now_val else "disabled"
        updates["sis_config.enabled"] = now_val
        diff["enabled"] = {"before": was, "after": now_val}

    for field_name in ("provider", "endpoint_url", "client_id", "sync_interval", "store_raw"):
        if field_name in payload and payload[field_name] is not None:
            updates[f"sis_config.{field_name}"] = payload[field_name]
            if existing_cfg.get(field_name) != payload[field_name]:
                diff[field_name] = {
                    "before": existing_cfg.get(field_name),
                    "after":  payload[field_name],
                }

    # Credential rotation — only when the caller supplied a new secret
    # AND it's not the sentinel.  Empty string or the sentinel preserves
    # the current encrypted value.
    new_secret = payload.get("client_secret")
    if new_secret and new_secret != _SECRET_PLACEHOLDER:
        updates["sis_config.client_secret_encrypted"] = encrypt_string(new_secret)
        diff["client_secret"] = {"before": "[redacted]", "after": "[rotated]"}

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["sis_config.updated_at"] = datetime.now(timezone.utc)
    updates["sis_config.updated_by"] = user_data.get("uid")
    ref.update(updates)

    logger.info(
        "SIS config updated: district=%s fields=%s by=%s",
        district_id, list(diff.keys()), user_data.get("uid"),
    )

    if enable_transition == "enabled":
        audit_log(
            action="sis.config.enabled", actor=user_data,
            target={"type": "district", "id": district_id, "display_name": district_id},
            diff=diff, severity="warning", district_id=district_id,
            message=f"SIS integration enabled ({payload.get('provider') or existing_cfg.get('provider')})",
        )
    elif enable_transition == "disabled":
        audit_log(
            action="sis.config.disabled", actor=user_data,
            target={"type": "district", "id": district_id, "display_name": district_id},
            diff=diff, severity="warning", district_id=district_id,
            message="SIS integration disabled",
        )
    else:
        audit_log(
            action="sis.config.updated", actor=user_data,
            target={"type": "district", "id": district_id, "display_name": district_id},
            diff=diff, severity="info", district_id=district_id,
            message=f"SIS config updated ({', '.join(diff.keys())})",
        )

    # Re-read and return the post-update shape so the wizard can reflect
    # the persisted state without making a second round trip.
    return get_sis_config(district_id, user_data)


# ---------------------------------------------------------------------------
# Endpoints — actions
# ---------------------------------------------------------------------------

@router.post("/api/v1/admin/districts/{district_id}/sis-config/test")
def test_sis_connection(
    district_id: str,
    body: SisTestConnectionRequest,
    user_data: dict = Depends(verify_firebase_token),
):
    """Test Connection button.  If the caller supplies override fields
    (fresh typed values from the wizard), we use those without saving.
    Otherwise we test the currently-persisted config."""
    _assert_district_admin(user_data, district_id)
    snap = db.collection("districts").document(district_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="District not found")

    cfg = (snap.to_dict() or {}).get("sis_config") or {}
    provider = body.provider or cfg.get("provider") or "oneroster"
    if provider != "oneroster":
        raise HTTPException(
            status_code=400,
            detail=f"Provider {provider!r} is listed but not yet implemented. Only 'oneroster' is live today.",
        )

    endpoint = body.endpoint_url or cfg.get("endpoint_url")
    client_id = body.client_id or cfg.get("client_id")
    if body.client_secret and body.client_secret != _SECRET_PLACEHOLDER:
        client_secret = body.client_secret
    else:
        enc = cfg.get("client_secret_encrypted")
        client_secret = safe_decrypt(enc, default="") if enc else ""
    if not (endpoint and client_id and client_secret):
        raise HTTPException(
            status_code=400,
            detail="Endpoint, client ID, and client secret are required to test the connection.",
        )

    client = OneRosterClient(
        endpoint=endpoint,
        client_id=client_id,
        client_secret=client_secret,
    )
    result = client.test_connection()
    return result


@router.post("/api/v1/admin/districts/{district_id}/sis-sync")
async def trigger_sis_sync(
    district_id: str,
    user_data: dict = Depends(verify_firebase_token),
):
    """Manual "Sync now" from the Integrations dashboard.  Runs the
    sync in a worker thread so the HTTP request returns promptly
    (scheduler owns the long-tail) — we block long enough to get the
    resulting job summary back so the UI can show a toast.
    """
    _assert_district_admin(user_data, district_id)
    job = await asyncio.to_thread(run_sync, district_id, "manual", user_data)
    return {
        "status":      job.status,
        "error":       job.error,
        "started_at":  _fmt_ts(job.started_at),
        "finished_at": _fmt_ts(job.finished_at),
        "summary": {
            "students_added":     job.students_added,
            "students_updated":   job.students_updated,
            "guardians_added":    job.guardians_added,
            "guardians_updated":  job.guardians_updated,
            "duplicates_flagged": job.duplicates_flagged,
        },
    }


@router.get("/api/v1/admin/districts/{district_id}/sis-sync-jobs")
def list_sis_sync_jobs(
    district_id: str,
    limit: int = Query(default=25, ge=1, le=100),
    user_data: dict = Depends(verify_firebase_token),
):
    _assert_district_viewer(user_data, district_id)
    try:
        docs = list(
            db.collection("sis_sync_jobs")
            .where(field_path="district_id", op_string="==", value=district_id)
            .order_by("started_at", direction=__import__("google.cloud.firestore", fromlist=["Query"]).Query.DESCENDING)
            .limit(limit).stream()
        )
    except Exception as exc:
        logger.warning("sis-sync-jobs query failed: %s", exc)
        # Firestore sometimes returns a FAILED_PRECONDITION while the
        # composite index builds — surface an empty list rather than a
        # 500 so the UI keeps working.
        docs = []
    jobs = []
    for d in docs:
        data = d.to_dict() or {}
        data["id"] = d.id
        for f in ("started_at", "finished_at"):
            data[f] = _fmt_ts(data.get(f))
        jobs.append(data)
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/api/v1/admin/districts/{district_id}/sis-duplicates")
def list_sis_duplicates(
    district_id: str,
    user_data: dict = Depends(verify_firebase_token),
):
    _assert_district_viewer(user_data, district_id)
    docs = list(
        db.collection("sis_duplicates")
        .where(field_path="district_id", op_string="==", value=district_id)
        .where(field_path="status",       op_string="==", value="pending")
        .stream()
    )
    dups = []
    for d in docs:
        data = d.to_dict() or {}
        data["id"] = d.id
        # Enrich each duplicate with a snapshot of the existing student
        # so the review UI can show the two side-by-side without fanning
        # out extra calls.
        try:
            existing = db.collection("students").document(data.get("existing_student_id", "")).get()
            if existing.exists:
                ed = existing.to_dict() or {}
                data["existing"] = {
                    "id":         existing.id,
                    "first_name": safe_decrypt(ed.get("first_name_encrypted"), default=""),
                    "last_name":  safe_decrypt(ed.get("last_name_encrypted"),  default=""),
                    "grade":      ed.get("grade"),
                    "photo_url":  ed.get("photo_url"),
                    "guardian_uid": ed.get("guardian_uid"),
                    "created_at": ed.get("created_at"),
                }
        except Exception:
            pass
        dups.append(data)
    # Oldest flag first — admins typically want to work the backlog FIFO.
    dups.sort(key=lambda x: x.get("flagged_at") or "")
    return {"duplicates": dups, "count": len(dups)}


@router.post("/api/v1/admin/districts/{district_id}/sis-duplicates/{dup_id}/resolve")
def resolve_sis_duplicate(
    district_id: str,
    dup_id: str,
    body: SisDuplicateResolveRequest,
    user_data: dict = Depends(verify_firebase_token),
):
    _assert_district_admin(user_data, district_id)
    ref = db.collection("sis_duplicates").document(dup_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Duplicate record not found")
    data = snap.to_dict() or {}
    if data.get("district_id") != district_id:
        raise HTTPException(status_code=404, detail="Duplicate record not found")
    if data.get("status") != "pending":
        raise HTTPException(status_code=409, detail="This duplicate has already been resolved")

    if body.action == "merge":
        # Stamp the existing Dismissal student with the incoming
        # sourcedId + local_id so future syncs silently hit the
        # sourced_id tier of the match cascade.
        existing_id = data.get("existing_student_id")
        student_ref = db.collection("students").document(existing_id)
        if not student_ref.get().exists:
            raise HTTPException(status_code=404, detail="Existing student record no longer exists")
        student_ref.update({
            "sis_sourced_id":       data.get("sis_sourced_id"),
            "sis_local_id":         data.get("sis_local_id"),
            "sis_synced_at":        datetime.now(timezone.utc).isoformat(),
            "sis_managed_fields":   ["given_name", "family_name", "grade"],
        })
    elif body.action == "keep_separate":
        # Create a new Dismissal student carrying the SIS identity;
        # existing one is left alone.  Matches the shape of _create_student
        # in core/sync.py but we inline it here to avoid a heavier
        # coupling — this path is rare enough that duplication is fine.
        now_iso = datetime.now(timezone.utc).isoformat()
        new_record = {
            "first_name_encrypted": encrypt_string(data.get("sis_given_name", "")),
            "last_name_encrypted":  encrypt_string(data.get("sis_family_name", "")),
            "school_id":            data.get("school_id"),
            "school_name":          None,
            "grade":                data.get("sis_grade"),
            "photo_url":            None,
            "guardian_uid":         None,
            "status":               "unlinked",
            "created_at":           now_iso,
            "sis_sourced_id":       data.get("sis_sourced_id"),
            "sis_local_id":         data.get("sis_local_id"),
            "sis_synced_at":        now_iso,
            "sis_managed_fields":   ["given_name", "family_name", "grade"],
        }
        db.collection("students").add(new_record)

    ref.update({
        "status":       f"resolved_{body.action}",
        "resolved_at":  datetime.now(timezone.utc).isoformat(),
        "resolved_by":  user_data.get("uid"),
    })

    audit_log(
        action="sis.duplicate.resolved",
        actor=user_data,
        target={"type": "sis_duplicate", "id": dup_id,
                "display_name": f"{data.get('sis_given_name','')} {data.get('sis_family_name','')}"},
        diff={"action": body.action, "existing_student_id": data.get("existing_student_id"),
              "sis_sourced_id": data.get("sis_sourced_id")},
        district_id=district_id,
        school_id=data.get("school_id"),
        message=f"Duplicate resolved: {body.action}",
    )
    return {"status": "ok", "action": body.action}
