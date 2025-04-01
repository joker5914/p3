from google.cloud import firestore
from secure_lookup import tokenize_plate, encrypt_string
from dotenv import load_dotenv
import os
from datetime import datetime

load_dotenv()

db = firestore.Client.from_service_account_json("firebase_credentials.json")

plate = "ABC123"  # Replace with actual test plate
plate_token = tokenize_plate(plate)

db.collection("plates").document(plate_token).set({
    "student_name": encrypt_string("John Doe"),
    "parent": encrypt_string("Jane Doe"),
    "school_id": "school_123",
    "registered_at": datetime.utcnow().isoformat()
})

print(f"Plate {plate} added successfully.")