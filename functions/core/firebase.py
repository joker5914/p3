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

# Inside the Firebase emulator (local `firebase emulators:start`) and
# when this module is imported by the deployed Cloud Function, default
# Application Default Credentials are correct — no key file needed.
# The presence of any of these env vars means we're talking to an
# emulator and should skip the credential bootstrap entirely.
_IN_EMULATOR = bool(
    os.getenv("FUNCTIONS_EMULATOR")
    or os.getenv("FIRESTORE_EMULATOR_HOST")
    or os.getenv("FIREBASE_AUTH_EMULATOR_HOST")
)

_cred_path_default = (
    "firebase_credentials.json"
    if ENV == "development" and not _IN_EMULATOR
    else ""
)
_cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", _cred_path_default)
# A missing key file is never fatal — fall through to ADC (works in
# the emulator, in deployed Functions, and locally when the developer
# is signed in via `gcloud auth application-default login`).  This
# only catches the case where the path was wrong; it doesn't suppress
# real misconfiguration of an explicitly-set FIREBASE_CREDENTIALS_JSON.
if _cred_path and not os.path.isfile(_cred_path):
    _cred_path = ""

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


def _build_firestore_client():
    """Materialise the real Firestore client.

    Deferred so module import does no network/credential work — important
    for the firebase-functions deploy-time discovery phase, which loads
    main.py to enumerate decorators and shouldn't have to authenticate
    to Google to do that.
    """
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
        return firestore.Client(credentials=_sa_creds, project=_cred_dict.get("project_id"))
    if _cred_path:
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(_cred_path))
        return firestore.Client.from_service_account_json(_cred_path)
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    return firestore.Client()


class _LazyFirestore:
    """Proxy that defers the real ``firestore.Client()`` call until first use.

    Behaves like a Firestore client for every call site that does
    ``db.collection(...)``, ``db.batch()``, ``db.document(...)``, etc.
    """
    __slots__ = ("_client",)

    def __init__(self):
        self._client = None

    def _resolve(self):
        if self._client is None:
            self._client = _build_firestore_client()
        return self._client

    def __getattr__(self, name):
        return getattr(self._resolve(), name)


db = _LazyFirestore()

# ---------------------------------------------------------------------------
# HMAC secret — also lazy so module import doesn't fail at deploy
# discovery time when the SECRET_KEY env var hasn't been injected yet.
# Call sites use ``SECRET_KEY`` as a module-level ``bytes`` value, so we
# expose it through a module __getattr__ that resolves on first access.
# ---------------------------------------------------------------------------
_SECRET_KEY_CACHE: bytes | None = None


def _resolve_secret_key() -> bytes:
    global _SECRET_KEY_CACHE
    if _SECRET_KEY_CACHE is None:
        raw = os.getenv("SECRET_KEY")
        if not raw:
            raise RuntimeError("SECRET_KEY environment variable is not set")
        _SECRET_KEY_CACHE = raw.encode()
    return _SECRET_KEY_CACHE


def __getattr__(name):
    if name == "SECRET_KEY":
        return _resolve_secret_key()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
