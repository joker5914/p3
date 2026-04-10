"""
Create a test Firebase user and print an ID token for local testing.

Usage:
  export FIREBASE_API_KEY="AIza..."          # From Firebase Console → Project Settings
  export TEST_USER_EMAIL="scanner01@dismissal.local"
  export TEST_USER_PASSWORD="your-password"
  python generate_test_user.py
"""
import os
import json
import requests
import firebase_admin
from firebase_admin import credentials, auth

cred = credentials.Certificate("firebase_credentials.json")
firebase_admin.initialize_app(cred)

FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY")
if not FIREBASE_API_KEY:
    raise RuntimeError("Set FIREBASE_API_KEY env var (Firebase Console → Project Settings → Web API Key)")

email = os.environ.get("TEST_USER_EMAIL", "scanner01@dismissal.local")
password = os.environ.get("TEST_USER_PASSWORD")
if not password:
    raise RuntimeError("Set TEST_USER_PASSWORD env var")

FIREBASE_AUTH_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"

# Create user if they don't exist
try:
    user = auth.get_user_by_email(email)
    print("✅ User already exists:", user.uid)
except auth.UserNotFoundError:
    user = auth.create_user(email=email, password=password)
    print("✅ Created new user:", user.uid)

# Sign in and get idToken via Firebase REST API
response = requests.post(FIREBASE_AUTH_URL, data=json.dumps({
    "email": email,
    "password": password,
    "returnSecureToken": True,
}))
if response.status_code != 200:
    print("❌ Failed to get idToken:", response.text)
    exit(1)

id_token = response.json()["idToken"]
print("\n🔐 Firebase idToken (short-lived):\n")
print(id_token)

# Write to .env file
env_path = os.path.join(os.path.dirname(__file__), ".env")
with open(env_path, "a") as f:
    f.write(f"\nDISMISSAL_API_TOKEN={id_token}\n")
print(f"\n✅ idToken written to .env as DISMISSAL_API_TOKEN at: {env_path}")
