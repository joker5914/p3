"""Restore a Platform Admin who got auto-provisioned as a guardian.

Background: Firebase Auth keys users by sign-in method.  An account
that originally signed up via email/password gets one uid; the same
email signing in for the first time via Google SSO gets a different
uid — Firebase doesn't auto-link them.  Our auth resolver
(``core/auth.py``) treats a missing ``school_admins/{uid}`` doc as
"this user is a new guardian" and writes a ``guardians/{uid}`` entry,
which is the right behaviour for a brand-new parent but the wrong
behaviour for a Platform Admin who just changed sign-in method.

This script makes the Google-SSO uid the canonical Platform Admin
record:

1. Look up the Firebase Auth uid for the target email.
2. Find any *other* school_admins doc with the same email
   (``email_lower`` field).  That's the legacy record from the old
   uid; copy its role/status/district/school fields into a new doc
   keyed by the SSO uid so privileges and assignments survive.
3. Delete the auto-created ``guardians/{uid}`` doc, if it exists and
   has no children / vehicles / pickups (i.e. it was never used).
4. Stamp ``role`` + ``dismissal_admin`` custom claims on the Auth
   user so claim-based middleware sees them as admin too.
5. Optionally delete the legacy ``school_admins/{old_uid}`` doc to
   keep the collection from accumulating tombstones (off by default
   — uncomment ``DELETE_LEGACY = True`` to enable).

Usage:
    python functions/scripts/restore_platform_admin.py <email>
"""
import json
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import auth as fb_auth
from google.cloud import firestore

DELETE_LEGACY = False  # leave the old school_admins doc as a tombstone by default


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
        print("usage: restore_platform_admin.py <email>", file=sys.stderr)
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
    new_uid = user.uid
    print(f"Active Firebase Auth uid: {new_uid}")

    # 1. Look for a legacy school_admins doc keyed by a different uid
    #    but matching this email.  Try both ``email_lower`` (the
    #    canonical lookup field) and ``email`` (older docs that
    #    predate the lower-case mirror).
    legacy_doc = None
    for field in ("email_lower", "email"):
        try:
            for d in db.collection("school_admins").where(field_path=field, op_string="==", value=email).stream():
                if d.id != new_uid:
                    legacy_doc = d
                    break
        except Exception as exc:
            print(f"  query on {field!r} failed: {exc}", file=sys.stderr)
        if legacy_doc:
            break

    if legacy_doc:
        legacy = legacy_doc.to_dict() or {}
        print(f"Found legacy school_admins doc id={legacy_doc.id} role={legacy.get('role')!r} status={legacy.get('status')!r}")
    else:
        print("No legacy school_admins doc found by email — will create a fresh super_admin record.")

    # 2. Build the new school_admins doc.  When a legacy is found,
    #    inherit role/scope so we don't accidentally promote / demote
    #    the user; otherwise default to super_admin (the only role
    #    this script is meant to recover).
    base = (legacy.to_dict() if False else (legacy_doc.to_dict() if legacy_doc else None)) or {}
    role        = base.get("role") or "super_admin"
    status      = "active"
    district_id = base.get("district_id")
    school_id   = base.get("school_id")
    school_ids  = base.get("school_ids") or ([school_id] if school_id else [])
    display_name = base.get("display_name") or user.display_name or email

    new_record = {
        "uid": new_uid,
        "email": email,
        "email_lower": email,
        "display_name": display_name,
        "role": role,
        "status": status,
    }
    if district_id:
        new_record["district_id"] = district_id
    if school_id:
        new_record["school_id"] = school_id
    if school_ids:
        new_record["school_ids"] = school_ids
    # Preserve invited_at/created_at if we have them; otherwise leave
    # absent so we don't fabricate timestamps.
    for ts_field in ("invited_at", "created_at"):
        if base.get(ts_field):
            new_record[ts_field] = base[ts_field]

    db.collection("school_admins").document(new_uid).set(new_record)
    print(f"Wrote school_admins/{new_uid}  role={role}  status=active")

    # 3. Delete the auto-provisioned guardian doc only if it's
    #    obviously a fresh one (no schools, no children, no vehicles,
    #    no authorized_pickups).  Otherwise leave it for manual
    #    review.
    g_ref = db.collection("guardians").document(new_uid)
    g = g_ref.get()
    if g.exists:
        gdata = g.to_dict() or {}
        is_blank = (
            not gdata.get("assigned_school_ids")
            and not gdata.get("authorized_pickups")
        )
        # Children live in students collection keyed by guardian_uid;
        # vehicles likewise.  Quick existence checks.
        has_children = any(True for _ in db.collection("students").where(field_path="guardian_uid", op_string="==", value=new_uid).limit(1).stream())
        has_vehicles = any(True for _ in db.collection("vehicles").where(field_path="guardian_uid", op_string="==", value=new_uid).limit(1).stream())
        if is_blank and not has_children and not has_vehicles:
            g_ref.delete()
            print(f"Deleted blank auto-created guardians/{new_uid}")
        else:
            print(f"Kept guardians/{new_uid} (has data; review manually)")

    # 4. Stamp custom claims so claim-based middleware paths see admin
    #    privileges immediately on the next ID-token refresh.
    try:
        claims = {"role": role, "dismissal_admin": True}
        if role == "district_admin" and district_id:
            claims["district_id"] = district_id
        if role in ("school_admin", "staff") and school_id:
            claims["school_id"] = school_id
        fb_auth.set_custom_user_claims(new_uid, claims)
        print(f"Set custom claims: {claims}")
    except Exception as exc:
        print(f"  custom-claims write failed: {exc}", file=sys.stderr)

    # 5. Optional: delete the legacy school_admins doc.
    if legacy_doc and DELETE_LEGACY:
        legacy_doc.reference.delete()
        print(f"Deleted legacy school_admins/{legacy_doc.id}")

    print()
    print("Done. Refresh the portal in your browser; you should be a Platform Admin again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
