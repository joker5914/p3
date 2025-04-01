import requests
import firebase_admin
from firebase_admin import credentials, auth
import json
import os

# Load Firebase Admin credentials
cred = credentials.Certificate("firebase_credentials.json")
firebase_admin.initialize_app(cred)

# Firebase project config
FIREBASE_API_KEY = "YOUR_FIREBASE_API_KEY"  # ← Replace this
FIREBASE_AUTH_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"

email = "scanner01@p3.local"
password = "SuperSecureP3!"

# Create user if they don't exist
try:
    user = auth.get_user_by_email(email)
    print("✅ User already exists:", user.uid)
except auth.UserNotFoundError:
    user = auth.create_user(email=email, password=password)
    print("✅ Created new user:", user.uid)

# Sign in and get idToken via Firebase REST API
payload = {
    "email": email,
    "password": password,
    "returnSecureToken": True
}

response = requests.post(FIREBASE_AUTH_URL, data=json.dumps(payload))
if response.status_code != 200:
    print("❌ Failed to get idToken:", response.text)
    exit(1)

id_token = response.json()["idToken"]
print("\n🔐 Firebase idToken (short-lived):\n")
print(id_token)

# Write to .env file
env_path = os.path.join(os.path.dirname(__file__), ".env")
with open(env_path, "a") as f:
    f.write(f"\nP3_API_TOKEN={id_token}\n")

print(f"\n✅ idToken written to .env as P3_API_TOKEN at: {env_path}")
input("\nPress Enter to close...")
