import requests
from firebase_admin import auth, credentials, initialize_app
import json

# Initialize Firebase Admin
cred = credentials.Certificate("firebase_credentials.json")
initialize_app(cred)

# Set your service account email + user info
email = "scanner01@dismissal.local"
password = "Godisgod59145!"  # this user must already exist in Firebase Auth

# Generate a custom token
user = auth.get_user_by_email(email)
custom_token = auth.create_custom_token(user.uid)

print("\n✅ Custom Token generated.")

# Exchange custom token for ID token using Firebase REST API
FIREBASE_API_KEY = "AIzaSyAptP2cM_xj764rrwC4FRnbmnQJwFsLvFM"  # <-- from your Firebase project settings

url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={FIREBASE_API_KEY}"
payload = {
    "token": custom_token.decode(),
    "returnSecureToken": True
}

res = requests.post(url, json=payload)
if res.status_code == 200:
    id_token = res.json()["idToken"]
    print("\n✅ Firebase ID Token:\n")
    print(id_token)
else:
    print("❌ Failed to exchange custom token:")
    print(res.status_code, res.text)
