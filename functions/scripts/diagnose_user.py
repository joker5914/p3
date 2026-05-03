"""Read-only diagnostic for a single account.

Prints whatever state the auth resolver would see for this user:
- Firebase Auth user (uid, disabled, custom claims)
- school_admins/{uid} doc (role, status, district_id, school_id, school_ids)
- guardians/{uid} doc (auto-created when school_admins is absent)

Use this before recover_platform_admin.py when you don't know which
surface dropped the user — diagnose first, fix second.

Usage:
    python functions/scripts/diagnose_user.py <email>
"""
import json
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import auth as fb_auth
from google.cloud import firestore


def _resolve_project_id() -> str:
    firebaserc = Path(__file__).resolve().parents[2] / ".firebaserc"
    with firebaserc.open("r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    project = (cfg.get("projects") or {}).get("default")
    if not project:
        sys.exit("Could not read default project from .firebaserc")
    return project


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: diagnose_user.py <email>", file=sys.stderr)
        return 2
    email = sys.argv[1].strip().lower()

    project_id = _resolve_project_id()
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project_id})
    db = firestore.Client(project=project_id)

    try:
        user = fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        print(f"No Firebase Auth user with email {email!r}", file=sys.stderr)
        return 1

    print(f"== Firebase Auth ==")
    print(f"  uid:           {user.uid}")
    print(f"  email:         {user.email}")
    print(f"  disabled:      {user.disabled}")
    print(f"  email_verified:{user.email_verified}")
    print(f"  custom_claims: {user.custom_claims!r}")
    print()

    sa = db.collection("school_admins").document(user.uid).get()
    print(f"== school_admins/{user.uid} ==")
    if sa.exists:
        d = sa.to_dict() or {}
        for key in ("role", "status", "district_id", "school_id", "school_ids", "display_name", "email"):
            print(f"  {key}: {d.get(key)!r}")
    else:
        print("  (DOES NOT EXIST)")
    print()

    g = db.collection("guardians").document(user.uid).get()
    print(f"== guardians/{user.uid} ==")
    if g.exists:
        d = g.to_dict() or {}
        for key in ("display_name", "email", "assigned_school_ids", "sso_provider", "auto_provisioned", "created_at"):
            print(f"  {key}: {d.get(key)!r}")
    else:
        print("  (DOES NOT EXIST)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
