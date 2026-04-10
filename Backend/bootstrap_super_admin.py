#!/usr/bin/env python3
"""
bootstrap_super_admin.py — One-time script to promote an existing Firebase user
to super_admin (God-Admin) status.

Usage:
    FIREBASE_CREDENTIALS_PATH=firebase_credentials.json \\
        python bootstrap_super_admin.py <email>

The script:
  1. Looks up the user by email in Firebase Auth (they must already exist).
  2. Sets custom claims: {super_admin: true, dismissal_admin: true, role: "super_admin"}.
  3. Creates / upserts a school_admins/{uid} Firestore record with
     role="super_admin" and NO school_id (cross-school access).

This script is intentionally NOT exposed as an API endpoint — privilege
escalation to super_admin must be performed server-side by someone who already
has access to the service-account credentials.

Only run this once per super_admin user. Subsequent runs are idempotent.
"""

import sys
import os
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, auth as fb_auth
from google.cloud import firestore


def main():
    if len(sys.argv) < 2:
        print("Usage: python bootstrap_super_admin.py <email>", file=sys.stderr)
        sys.exit(1)

    email = sys.argv[1].strip().lower()
    if "@" not in email:
        print(f"ERROR: '{email}' does not look like a valid email address.", file=sys.stderr)
        sys.exit(1)

    # ── Firebase initialisation ──────────────────────────────────────────────
    cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase_credentials.json")
    if not os.path.exists(cred_path):
        print(
            f"ERROR: Firebase credentials file not found at '{cred_path}'.\n"
            "Set FIREBASE_CREDENTIALS_PATH to the correct path.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not firebase_admin._apps:
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)

    db = firestore.Client.from_service_account_json(cred_path)

    # ── Look up user in Firebase Auth ────────────────────────────────────────
    print(f"Looking up Firebase user: {email}")
    try:
        user = fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        print(
            f"ERROR: No Firebase Auth user found with email '{email}'.\n"
            "The user must sign in at least once (or be invited via the admin UI) "
            "before they can be promoted to super_admin.",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: Firebase lookup failed: {exc}", file=sys.stderr)
        sys.exit(1)

    uid = user.uid
    display_name = user.display_name or email.split("@")[0]
    print(f"Found user: uid={uid}  display_name={display_name!r}")

    # ── Set custom claims ────────────────────────────────────────────────────
    # Preserve any existing claims so we don't wipe school_id etc. on other
    # users who might share credentials in unusual setups.
    existing_claims: dict = user.custom_claims or {}
    new_claims = {
        **existing_claims,
        "super_admin": True,
        "dismissal_admin": True,
        "role": "super_admin",
    }
    # super_admin has no school restriction — remove school_id claim if present
    new_claims.pop("school_id", None)

    print("Setting custom claims:", new_claims)
    try:
        fb_auth.set_custom_user_claims(uid, new_claims)
    except Exception as exc:
        print(f"ERROR: Failed to set custom claims: {exc}", file=sys.stderr)
        sys.exit(1)
    print("  ✓ Custom claims set")

    # ── Upsert school_admins Firestore record ────────────────────────────────
    now = datetime.now(tz=timezone.utc)
    record = {
        "uid": uid,
        "email": email,
        "display_name": display_name,
        "role": "super_admin",
        "status": "active",
        # No school_id — super_admin operates across all schools
        "created_at": now,
        "promoted_to_super_admin_at": now,
    }
    try:
        db.collection("school_admins").document(uid).set(record, merge=True)
    except Exception as exc:
        print(f"ERROR: Firestore write failed: {exc}", file=sys.stderr)
        sys.exit(1)
    print("  ✓ school_admins record upserted")

    # ── Done ─────────────────────────────────────────────────────────────────
    print(
        f"\nSuccess! {email} is now a super_admin.\n"
        "The user must sign out and sign back in (or wait up to 1 hour) for the\n"
        "new custom claims to take effect in their ID token."
    )


if __name__ == "__main__":
    main()
