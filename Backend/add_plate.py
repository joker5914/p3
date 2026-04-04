"""
add_plate.py — One-off utility to register a single plate in Firestore.

Usage:
    python add_plate.py --plate ABC123 --student "John Doe" --parent "Jane Doe" --school school_123

For multiple children on the same plate, repeat --student:
    python add_plate.py --plate ABC123 --student "John Doe" --student "Jenny Doe" --parent "Jane Doe" --school school_123
"""

import argparse
from datetime import datetime
from google.cloud import firestore
from secure_lookup import tokenize_plate, encrypt_string
from dotenv import load_dotenv
import os

load_dotenv()


def main():
    parser = argparse.ArgumentParser(description="Register a plate in P3 Firestore.")
    parser.add_argument("--plate", required=True)
    parser.add_argument("--student", required=True, action="append", dest="students")
    parser.add_argument("--parent", required=True)
    parser.add_argument("--school", required=True)
    parser.add_argument("--make", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--color", default=None)
    args = parser.parse_args()

    cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase_credentials.json")
    db = firestore.Client.from_service_account_json(cred_path)

    plate = args.plate.upper().strip()
    plate_token = tokenize_plate(plate)

    enc_students = (
        [encrypt_string(s) for s in args.students]
        if len(args.students) > 1
        else encrypt_string(args.students[0])
    )

    doc_data = {
        "student_names_encrypted": enc_students,
        "parent": encrypt_string(args.parent),
        "school_id": args.school,
        "vehicle_make": args.make,
        "vehicle_model": args.model,
        "vehicle_color": args.color,
        "registered_at": datetime.utcnow().isoformat(),
    }

    db.collection("plates").document(plate_token).set(doc_data, merge=True)
    print(f"Plate '{plate}' registered successfully (token: {plate_token[:12]}…)")


if __name__ == "__main__":
    main()
