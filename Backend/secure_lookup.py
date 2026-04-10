"""
secure_lookup.py — Cryptographic helpers for Dismissal.

Changes from original:
  - Key validation gives a clearer error message.
  - Added hmac_verify() for constant-time comparison of event hashes.
  - tokenize_plate() uses HMAC-SHA256 (keyed hash) so tokens cannot be
    reversed without knowing SECRET_KEY.
"""

import os
import hmac
import hashlib
import base64
from dotenv import load_dotenv
from cryptography.fernet import Fernet

load_dotenv()

_raw_key = os.getenv("DISMISSAL_ENCRYPTION_KEY")
if not _raw_key:
    raise RuntimeError(
        "DISMISSAL_ENCRYPTION_KEY is not set. "
        "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
    )

try:
    _decoded = base64.urlsafe_b64decode(_raw_key.encode())
    if len(_decoded) != 32:
        raise ValueError(f"Key decoded to {len(_decoded)} bytes; expected 32.")
except Exception as exc:
    raise RuntimeError(f"DISMISSAL_ENCRYPTION_KEY is invalid: {exc}") from exc

fernet = Fernet(_raw_key.encode())

_secret_key_raw = os.getenv("SECRET_KEY", _raw_key)
_HMAC_KEY: bytes = _secret_key_raw.encode()


def tokenize_plate(plate: str) -> str:
    """Return a deterministic, keyed HMAC-SHA256 token for a licence plate."""
    return hmac.new(_HMAC_KEY, plate.encode(), hashlib.sha256).hexdigest()


def tokenize_student(first_name: str, last_name: str, school_id: str) -> str:
    """Return a deterministic HMAC-SHA256 identity token for a student.

    The token is derived from the normalised (lowercase, stripped) first name,
    last name, and school ID so that two records referring to the same student
    at the same school always produce the same token — regardless of casing or
    surrounding whitespace.
    """
    identity = f"{first_name.strip().lower()}|{last_name.strip().lower()}|{school_id}".encode()
    return hmac.new(_HMAC_KEY, identity, hashlib.sha256).hexdigest()


def encrypt_string(plaintext: str) -> str:
    """Encrypt a UTF-8 string and return a URL-safe base64 token."""
    return fernet.encrypt(plaintext.encode()).decode()


def decrypt_string(ciphertext: str) -> str:
    """Decrypt a token produced by encrypt_string()."""
    return fernet.decrypt(ciphertext.encode()).decode()


def hmac_verify(value: str, expected_hex: str) -> bool:
    """Constant-time comparison of two HMAC digests."""
    return hmac.compare_digest(value, expected_hex)
