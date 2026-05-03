"""Re-enable a locked-out Platform Admin (super_admin) account.

The Platform Users PATCH endpoint mirrors ``status="disabled"`` to
Firebase Auth via ``fb_auth.update_user(uid, disabled=True)``, so a
self-disable locks the account out on both surfaces. The in-app
last-active-super-admin guard prevents this going forward, but a doc
already in ``status="disabled"`` has no in-app recovery path —
``require_super_admin`` rejects every admin call before the user can
flip the field back. This script bypasses both surfaces via the
Firebase Admin SDK (which respects neither the Firestore status nor
the Auth disabled flag for its own writes).

Usage:
    python functions/scripts/recover_platform_admin.py <email>

Requires Application Default Credentials with permission on the
target Firebase project. One-time setup on a developer machine:

    gcloud auth application-default login

The project ID is read from .firebaserc rather than gcloud's active
configuration, so a stale ``gcloud config set project`` won't make
this script silently target the wrong tenant.
"""
import json
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import auth as fb_auth
from google.cloud import firestore


def _resolve_project_id() -> str:
    """Pin the project to .firebaserc's default — never trust ambient
    gcloud config for a destructive recovery operation."""
    firebaserc = Path(__file__).resolve().parents[2] / ".firebaserc"
    with firebaserc.open("r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    project = (cfg.get("projects") or {}).get("default")
    if not project:
        sys.exit("Could not read default project from .firebaserc")
    return project


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: recover_platform_admin.py <email>", file=sys.stderr)
        return 2
    email = sys.argv[1].strip().lower()

    project_id = _resolve_project_id()
    print(f"Using project_id={project_id!r}")

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project_id})
    db = firestore.Client(project=project_id)

    try:
        user = fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        print(f"No Firebase Auth user with email {email!r}", file=sys.stderr)
        return 1
    print(f"Found uid={user.uid}  auth.disabled={user.disabled}")

    doc_ref = db.collection("school_admins").document(user.uid)
    snap = doc_ref.get()
    if not snap.exists:
        print(f"No school_admins doc for uid={user.uid}", file=sys.stderr)
        return 1
    data = snap.to_dict() or {}
    print(f"Firestore role={data.get('role')!r}  status={data.get('status')!r}")

    # Refuse to operate on anything other than a super_admin: regular
    # admin/staff accounts have proper in-app re-enable paths via the
    # District-level user surface, and bypassing them here would let
    # this script silently elevate / restore privileges that the
    # admin layer would have rejected.
    if data.get("role") != "super_admin":
        print("Refusing to touch a non-super_admin account from this script.", file=sys.stderr)
        return 1

    fb_auth.update_user(user.uid, disabled=False)
    doc_ref.update({"status": "active"})

    after_user = fb_auth.get_user(user.uid)
    after_data = (doc_ref.get().to_dict() or {})
    print(
        f"OK -> auth.disabled={after_user.disabled}  "
        f"status={after_data.get('status')!r}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
