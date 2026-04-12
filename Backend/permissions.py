"""Centralized school permission management.

Single source of truth for:
  - permission key definitions
  - role-based default permissions
  - Firestore provisioning, reads, and writes

Every school gets a ``school_permissions/{school_id}`` document that stores
per-role boolean flags.  The document is **auto-provisioned** when:
  1. A school is created (batch write alongside the ``schools`` doc).
  2. A permission read finds no document (self-healing).

This ensures Firestore security rules always find a document with a
``school_id`` field they can match against the caller's custom claim.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from google.cloud.firestore_v1.client import Client as FirestoreClient

logger = logging.getLogger(__name__)

# ── Permission key registry ─────────────────────────────────────────────
# Add new keys here — every downstream consumer (rules, backend, frontend)
# should reference this list.

ALL_PERMISSION_KEYS: list[str] = [
    "dashboard",
    "history",
    "reports",
    "registry",
    "registry_edit",
    "users",
    "data_import",
    "site_settings",
]

# ── Role defaults ────────────────────────────────────────────
# school_admin gets everything; staff gets read-only views by default.

DEFAULT_PERMISSIONS: dict[str, dict[str, bool]] = {
    "school_admin": {key: True for key in ALL_PERMISSION_KEYS},
    "staff": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": False,
        "users": False,
        "data_import": False,
        "site_settings": False,
    },
}


def _build_defaults() -> dict:
    """Return a full permission document payload with defaults + school_id placeholder."""
    return {
        "school_admin": dict(DEFAULT_PERMISSIONS["school_admin"]),
        "staff": dict(DEFAULT_PERMISSIONS["staff"]),
    }


# ── Provisioning ──────────────────────────────────────────────

def provision_school_permissions(db: "FirestoreClient", school_id: str) -> dict:
    """Create a ``school_permissions/{school_id}`` document with defaults.

    Safe to call multiple times — uses ``set`` which is an upsert when the
    document already exists (but only writes defaults, so existing customizations
    are preserved via the ``create_if_missing`` path below).

    Returns the permissions payload that was written.
    """
    doc_ref = db.collection("school_permissions").document(school_id)
    existing = doc_ref.get()
    if existing.exists:
        logger.info("school_permissions/%s already exists — skipping provision", school_id)
        return existing.to_dict()

    payload = _build_defaults()
    payload["school_id"] = school_id
    doc_ref.set(payload)
    logger.info("Provisioned school_permissions/%s with defaults", school_id)
    return payload


# ── Reads ────────────────────────────────────────────────

def get_school_permissions(db: "FirestoreClient", school_id: str) -> dict:
    """Return merged permission dict ``{role: {key: bool}}`` for a school.

    Self-healing: if the Firestore document is missing, auto-provisions it so
    subsequent client-side reads (governed by security rules) succeed.
    """
    try:
        doc = db.collection("school_permissions").document(school_id).get()
        if doc.exists:
            data = doc.to_dict()
            result = {}
            for role in ("school_admin", "staff"):
                saved = data.get(role, {})
                merged = dict(DEFAULT_PERMISSIONS[role])
                merged.update(
                    {k: v for k, v in saved.items() if k in ALL_PERMISSION_KEYS}
                )
                result[role] = merged
            return result

        # Document missing — auto-provision so Firestore rules can find it.
        logger.warning(
            "school_permissions/%s missing — auto-provisioning defaults", school_id
        )
        provision_school_permissions(db, school_id)
    except Exception as exc:
        logger.warning(
            "Failed to load school_permissions school=%s: %s", school_id, exc
        )

    return dict(DEFAULT_PERMISSIONS)


def get_user_permissions(db: "FirestoreClient", role: str, school_id: str) -> dict:
    """Return the effective permission dict for a single user's role."""
    if role == "super_admin":
        return {k: True for k in ALL_PERMISSION_KEYS}
    school_perms = get_school_permissions(db, school_id)
    return school_perms.get(role, DEFAULT_PERMISSIONS.get(role, {}))


# ── Writes ───────────────────────────────────────────────

def update_school_permissions(
    db: "FirestoreClient", school_id: str, staff: dict, school_admin: dict
) -> dict:
    """Validate and persist permission updates for a school.

    Returns the cleaned ``{role: {key: bool}}`` that was saved.
    """
    cleaned: dict = {}
    for role_key, raw in (("staff", staff), ("school_admin", school_admin)):
        cleaned[role_key] = {
            k: bool(v) for k, v in raw.items() if k in ALL_PERMISSION_KEYS
        }
        # Back-fill any keys not included in the request with defaults.
        for k in ALL_PERMISSION_KEYS:
            if k not in cleaned[role_key]:
                cleaned[role_key][k] = DEFAULT_PERMISSIONS[role_key][k]

    # Always persist the school_id so Firestore rules can match it.
    doc_payload = {**cleaned, "school_id": school_id}
    db.collection("school_permissions").document(school_id).set(doc_payload)
    return cleaned


# ── Bulk repair ─────────────────────────────────────────────

def repair_missing_permissions(db: "FirestoreClient") -> dict:
    """Backfill ``school_permissions`` for every school that's missing one.

    Returns ``{"provisioned": [...ids], "already_existed": [...ids]}``.
    """
    provisioned: list[str] = []
    already_existed: list[str] = []

    for school_doc in db.collection("schools").stream():
        sid = school_doc.id
        perm_doc = db.collection("school_permissions").document(sid).get()
        if perm_doc.exists:
            # Ensure the school_id field is present (fix legacy docs).
            data = perm_doc.to_dict()
            if data.get("school_id") != sid:
                db.collection("school_permissions").document(sid).update(
                    {"school_id": sid}
                )
                provisioned.append(sid)
            else:
                already_existed.append(sid)
        else:
            provision_school_permissions(db, sid)
            provisioned.append(sid)

    return {"provisioned": provisioned, "already_existed": already_existed}
