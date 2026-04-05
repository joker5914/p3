"""
firestore_setup.py — One-time bootstrap script.

Run this ONCE on a machine with access to firebase_credentials.json
to create your own school_admins record so the role/invite system works.

Usage:
    python Backend/firestore_setup.py \\
        --uid  <your Firebase Auth UID>  \\
        --email <your email> \\
        --name  "Your Name" \\
        --school <your_school_id>

You can find your Firebase Auth UID in:
  Firebase Console → Authentication → Users → copy the User UID column.

After running this, log out and back into the admin portal — your account
will now have the school_admin role and the full menu will appear.
"""

import argparse
import os
from datetime import datetime, timezone
from google.cloud import firestore
from firebase_admin import credentials, auth as fb_auth, initialize_app
from dotenv import load_dotenv

load_dotenv()


def main():
    parser = argparse.ArgumentParser(description="Bootstrap P3 Firestore for a new school.")
    parser.add_argument("--uid",    required=True,  help="Your Firebase Auth UID")
    parser.add_argument("--email",  required=True,  help="Your email address")
    parser.add_argument("--name",   required=True,  help="Your display name")
    parser.add_argument("--school", required=True,  help="School ID (short slug, e.g. 'lincoln_high')")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be written without writing")
    args = parser.parse_args()

    cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase_credentials.json")
    cred = credentials.Certificate(cred_path)
    initialize_app(cred)
    db = firestore.Client.from_service_account_json(cred_path)

    now = datetime.now(tz=timezone.utc)

    # ── 1. school_admins record ──────────────────────────────────────────────
    admin_record = {
        "uid":            args.uid,
        "email":          args.email,
        "display_name":   args.name,
        "school_id":      args.school,
        "role":           "school_admin",
        "status":         "active",
        "invited_by_uid": args.uid,   # self-bootstrapped
        "invited_at":     now,
        "created_at":     now,
    }

    # ── 2. Firebase custom claims ────────────────────────────────────────────
    claims = {
        "school_id": args.school,
        "role":      "school_admin",
        "p3_admin":  True,
    }

    print("\n=== P3 Firestore Bootstrap ===")
    print(f"  UID        : {args.uid}")
    print(f"  Email      : {args.email}")
    print(f"  Name       : {args.name}")
    print(f"  School ID  : {args.school}")
    print(f"  Role       : school_admin")

    if args.dry_run:
        print("\n[DRY RUN] Would write:")
        print(f"  Firestore  : school_admins/{args.uid} → {admin_record}")
        print(f"  Auth claims: uid={args.uid} → {claims}")
        print("\nNo changes made.")
        return

    # Write Firestore record
    db.collection("school_admins").document(args.uid).set(admin_record)
    print(f"\n✅ Firestore school_admins/{args.uid} written.")

    # Set custom claims
    fb_auth.set_custom_user_claims(args.uid, claims)
    print(f"✅ Custom claims set for uid={args.uid}.")

    print("\n⚠️  You must log out and back into the admin portal")
    print("   for the new custom claims to take effect in your JWT.")
    print("\nDone.")


if __name__ == "__main__":
    main()
