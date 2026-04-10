"""
Generate a Firebase ID token for local testing.

Usage:
  export FIREBASE_API_KEY="AIza..."          # From Firebase Console → Project Settings
  export TEST_USER_EMAIL="scanner01@dismissal.local"
  export TEST_USER_PASSWORD="your-password"
  python generate_test_token.py
"""
import os
import requests
from firebase_admin import auth, credentials, initialize_app

# Initialize Firebase Admin
cred = credentials.Certificate("firebase_credentials.json")
initialize_app(cred)

email = os.environ.get("TEST_USER_EMAIL", "scanner01@dismissal.local")
password = os.environ.get("TEST_USER_PASSWORD")
if not password:
    raise RuntimeError("Set TEST_USER_PASSWORD env var")

FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY")
if not FIREBASE_API_KEY:
    raise RuntimeError("Set FIREBASE_API_KEY env var (Firebase Console → Project Settings → Web API Key)")

# Generate a custom token via Admin SDK, then exchange for ID token
user = auth.get_user_by_email(email)
custom_token = auth.create_custom_token(user.uid)

url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={FIREBASE_API_KEY}"
res = requests.post(url, json={"token": custom_token.decode(), "returnSecureToken": True})
if res.status_code == 200:
    id_token = res.json()["idToken"]
    print("\n✅ Firebase ID Token:\n")
    print(id_token)
else:
    print("❌ Failed to exchange custom token:")
    print(res.status_code, res.text)
