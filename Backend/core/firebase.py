"""
Firebase Admin SDK and Firestore client initialisation.

Import `db` and `SECRET_KEY` from here — never call firebase_admin.initialize_app
or os.getenv('SECRET_KEY') anywhere else.
"""
import base64
import json
import logging
import os

import firebase_admin
from firebase_admin import credentials
from google.cloud import firestore

from config import ENV

logger = logging.getLogger(__name__)

_cred_path = os.getenv(
    "FIREBASE_CREDENTIALS_PATH",
    "firebase_credentials.json" if ENV == "development" else "",
)
_cred_raw = os.getenv("FIREBASE_CREDENTIALS_JSON", "")


def _parse_firebase_creds(raw: str) -> dict:
    """
    Parse FIREBASE_CREDENTIALS_JSON robustly.

    Cloud Run's Secret Manager injection can introduce a UTF-8 BOM or trailing
    newline. Some secrets are also stored base64-encoded. This function handles
    both cases:
      1. Raw JSON (possibly with BOM / surrounding whitespace)
      2. Base64-encoded JSON
    """
    cleaned = raw.strip().lstrip("\ufeff")
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    try:
        decoded = base64.b64decode(cleaned).decode("utf-8").strip()
        result = json.loads(decoded)
        logger.info("Firebase credentials decoded from base64")
        return result
    except Exception:
        pass
    raise RuntimeError(
        "FIREBASE_CREDENTIALS_JSON could not be parsed as JSON or base64-JSON. "
        "Check the value stored in GCP Secret Manager."
    )


if _cred_raw:
    from google.oauth2 import service_account as _sa
    _cred_dict = _parse_firebase_creds(_cred_raw)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(_cred_dict))
    _sa_creds = _sa.Credentials.from_service_account_info(
        _cred_dict,
        scopes=[
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/datastore",
        ],
    )
    db = firestore.Client(credentials=_sa_creds, project=_cred_dict.get("project_id"))
elif _cred_path:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(_cred_path))
    db = firestore.Client.from_service_account_json(_cred_path)
else:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    db = firestore.Client()

# ---------------------------------------------------------------------------
# HMAC secret
# ---------------------------------------------------------------------------
_secret_key_raw = os.getenv("SECRET_KEY")
if not _secret_key_raw:
    raise RuntimeError("SECRET_KEY environment variable is not set")
SECRET_KEY: bytes = _secret_key_raw.encode()
