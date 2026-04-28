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

# Key material is read lazily on first use so that this module is safe
# to import in environments where the env vars haven't been injected yet
# (notably the firebase-functions deploy-time discovery phase, which
# imports main.py just to enumerate decorators).
_fernet: "Fernet | None" = None
_HMAC_KEY: "bytes | None" = None


def _resolve_keys() -> None:
    """Validate env vars and build the Fernet + HMAC key on first call."""
    global _fernet, _HMAC_KEY
    if _fernet is not None and _HMAC_KEY is not None:
        return
    raw_key = os.getenv("DISMISSAL_ENCRYPTION_KEY")
    if not raw_key:
        raise RuntimeError(
            "DISMISSAL_ENCRYPTION_KEY is not set. "
            "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    try:
        decoded = base64.urlsafe_b64decode(raw_key.encode())
        if len(decoded) != 32:
            raise ValueError(f"Key decoded to {len(decoded)} bytes; expected 32.")
    except Exception as exc:
        raise RuntimeError(f"DISMISSAL_ENCRYPTION_KEY is invalid: {exc}") from exc

    _fernet = Fernet(raw_key.encode())
    _HMAC_KEY = os.getenv("SECRET_KEY", raw_key).encode()


def tokenize_plate(plate: str) -> str:
    """Return a deterministic, keyed HMAC-SHA256 token for a licence plate."""
    _resolve_keys()
    return hmac.new(_HMAC_KEY, plate.encode(), hashlib.sha256).hexdigest()


def tokenize_student(first_name: str, last_name: str, school_id: str) -> str:
    """Return a deterministic HMAC-SHA256 identity token for a student.

    The token is derived from the normalised (lowercase, stripped) first name,
    last name, and school ID so that two records referring to the same student
    at the same school always produce the same token — regardless of casing or
    surrounding whitespace.
    """
    _resolve_keys()
    identity = f"{first_name.strip().lower()}|{last_name.strip().lower()}|{school_id}".encode()
    return hmac.new(_HMAC_KEY, identity, hashlib.sha256).hexdigest()


def encrypt_string(plaintext: str) -> str:
    """Encrypt a UTF-8 string and return a URL-safe base64 token."""
    _resolve_keys()
    return _fernet.encrypt(plaintext.encode()).decode()


def decrypt_string(ciphertext: str) -> str:
    """Decrypt a token produced by encrypt_string()."""
    _resolve_keys()
    return _fernet.decrypt(ciphertext.encode()).decode()


def safe_decrypt(ciphertext, default=None):
    """Decrypt tolerantly, returning ``default`` on any failure.

    Useful for read paths (history, dashboard, admin lists, …) where a
    single corrupt or key-mismatched record should not crash the entire
    response. Accepts ``None``/empty input and returns ``default``.

    If ``ciphertext`` is a list, every element is decrypted individually
    and a list of the same length is returned, with failed elements
    replaced by ``default``.
    """
    if ciphertext is None or ciphertext == "":
        return default
    if isinstance(ciphertext, list):
        return [safe_decrypt(item, default=default) for item in ciphertext]
    if not isinstance(ciphertext, str):
        return default
    try:
        return decrypt_string(ciphertext)
    except Exception:
        return default


def hmac_verify(value: str, expected_hex: str) -> bool:
    """Constant-time comparison of two HMAC digests."""
    return hmac.compare_digest(value, expected_hex)
