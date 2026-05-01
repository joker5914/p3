"""
services/firmware_signing.py — backend-side firmware verification + storage helpers.

The backend doesn't *sign* firmware (signing happens on the release
engineer's workstation via deploy/sign_firmware.py); it only verifies
that what the admin portal uploaded is signed correctly under the
canonical public key.  Doing this verification at the backend boundary
catches mistakes (wrong key, corrupted upload, mismatched manifest)
before any Pi is told to download the artifact, where a failure costs
a real device a rollback cycle.

Public key lives in Firestore under ``platform_settings/firmware`` so
the same key the Pis verify with is the key the backend reads.
Pre-baked into Pi images at provisioning; rotated only by re-imaging
the fleet.  See deploy/firmware.pub.example for the file format.

Storage layout (Firebase Storage default bucket):

    firmware/
      releases/{version}/
        dismissal-{version}.tar.gz
        manifest.json

Scanners get short-lived signed URLs to download the tarball; admins
upload via the Firebase Storage SDK directly (rules in storage.rules
keep this super_admin-only).
"""
from __future__ import annotations

import base64
import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from core.firebase import db

logger = logging.getLogger(__name__)

# How long the scanner-bound signed URL stays valid.  Long enough to
# tolerate a slow nightly download window plus retry, short enough that
# a leaked URL can't be replayed indefinitely.
ARTIFACT_URL_TTL = timedelta(hours=2)

# Where the canonical public key lives on the backend.  Stored as a
# string field on a single Firestore doc rather than a separate file
# in the function bundle so super_admins can audit/rotate it without
# a code deploy.  Distribution to devices still happens via image
# provisioning — the Firestore copy is the *backend's* reference.
PUBKEY_DOC = ("platform_settings", "firmware")
PUBKEY_FIELD = "public_key_b64"   # base64 of raw 32-byte ed25519 pubkey


class FirmwareSigningError(Exception):
    """Raised when an uploaded manifest fails verification at the backend."""


@dataclass(frozen=True)
class VerifiedManifest:
    version:                 str
    artifact_filename:       str
    sha256:                  str
    size_bytes:              int
    signature_ed25519:       str
    signed_at:               str
    signed_by:               str
    min_compatible_version:  str = "0.0.0"


def _read_canonical_pubkey() -> Ed25519PublicKey:
    """Read the trusted public key from Firestore, decode base64, return verifier.

    Cached implicitly by the Firestore client's local document cache so
    we don't pay a read on every release verification.  If the doc is
    missing, signing is intentionally broken — the admin must call the
    bootstrap endpoint to upload the canonical key first.
    """
    snap = db.collection(PUBKEY_DOC[0]).document(PUBKEY_DOC[1]).get()
    if not snap.exists:
        raise FirmwareSigningError(
            "No firmware public key configured.  Upload one at "
            "platform_settings/firmware.public_key_b64 (base64 of the raw "
            "32-byte Ed25519 public key — see deploy/firmware.pub.example)."
        )
    data = snap.to_dict() or {}
    body = (data.get(PUBKEY_FIELD) or "").strip()
    if not body:
        raise FirmwareSigningError(
            "platform_settings/firmware.public_key_b64 is empty"
        )
    try:
        raw = base64.b64decode(body, validate=True)
    except Exception as exc:
        raise FirmwareSigningError(
            f"public_key_b64 is not valid base64: {exc}"
        ) from exc
    if len(raw) != 32:
        raise FirmwareSigningError(
            f"public_key_b64 must decode to 32 bytes, got {len(raw)}"
        )
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_manifest(blob: dict, *, expected_version: str) -> VerifiedManifest:
    """Verify the manifest the admin pasted/uploaded against the canonical key.

    The manifest carries the SHA-256 of the artifact + an Ed25519
    signature over that digest.  We can't re-hash the artifact here
    (it lives in Storage; we don't pull it down server-side just to
    verify), so we trust the manifest's sha256 *value* but verify its
    signature.  When the Pi downloads the artifact, it re-hashes and
    re-checks the signature — defence in depth.

    Returns the parsed manifest on success.  Raises FirmwareSigningError
    with a precise reason on any failure so the admin portal can
    surface "your signature didn't match" cleanly to the user.
    """
    try:
        manifest = VerifiedManifest(
            version=               str(blob["version"]),
            artifact_filename=     str(blob["artifact_filename"]),
            sha256=                str(blob["sha256"]).lower(),
            size_bytes=            int(blob["size_bytes"]),
            signature_ed25519=     str(blob["signature_ed25519"]),
            signed_at=             str(blob.get("signed_at", "")),
            signed_by=             str(blob.get("signed_by", "")),
            min_compatible_version=str(blob.get("min_compatible_version", "0.0.0")),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise FirmwareSigningError(f"Manifest fields are missing or malformed: {exc}") from exc

    if manifest.version != expected_version:
        raise FirmwareSigningError(
            f"Manifest version {manifest.version!r} does not match release "
            f"version {expected_version!r}"
        )
    if not manifest.sha256 or len(manifest.sha256) != 64:
        raise FirmwareSigningError("Manifest sha256 must be 64 hex characters")
    try:
        digest_bytes = bytes.fromhex(manifest.sha256)
    except ValueError as exc:
        raise FirmwareSigningError(f"Manifest sha256 is not valid hex: {exc}") from exc
    try:
        sig_bytes = base64.b64decode(manifest.signature_ed25519, validate=True)
    except Exception as exc:
        raise FirmwareSigningError(f"Signature is not valid base64: {exc}") from exc

    pub = _read_canonical_pubkey()
    try:
        pub.verify(sig_bytes, digest_bytes)
    except InvalidSignature as exc:
        raise FirmwareSigningError(
            "Ed25519 signature did not verify against the canonical public key. "
            "The manifest may have been signed with the wrong private key, or "
            "tampered with after signing."
        ) from exc

    return manifest


def storage_path_for(version: str) -> str:
    """Canonical Firebase Storage prefix for a release."""
    return f"firmware/releases/{version}"


def signed_artifact_url(version: str, *, ttl: timedelta = ARTIFACT_URL_TTL) -> str:
    """Generate a short-lived signed URL the scanner can use to download the tarball.

    Uses the Admin SDK's ``generate_signed_url`` so the URL doesn't
    require a Firebase token in the request — needed because the Pi
    fetches the artifact with a plain ``requests`` call from the OTA
    agent rather than through the API gateway.
    """
    from firebase_admin import storage as fb_storage

    bucket = fb_storage.bucket()
    blob = bucket.blob(f"{storage_path_for(version)}/dismissal-{version}.tar.gz")
    if not blob.exists():
        raise FirmwareSigningError(
            f"Tarball missing in Storage at {storage_path_for(version)}/dismissal-{version}.tar.gz"
        )
    return blob.generate_signed_url(
        expiration=datetime.now(tz=timezone.utc) + ttl,
        method="GET",
        version="v4",
    )


def device_bucket(cpu_serial: str, version: str) -> float:
    """Deterministically map a (device, release) pair to a 0–100 bucket.

    Used by the rollout scheduler to decide whether ``cpu_serial``
    falls inside the current stage's percent of fleet.  Stable across
    backend restarts (no random state) and across releases so the same
    device sees the same canary status for a given version.  Bucket
    differs across releases because the version string is part of the
    hash — this means the canary fleet rotates naturally between
    releases and no single device is permanently in the canary group.

    Returns a float in [0, 100).  The caller compares against
    ``stage.percent``; ``bucket < percent`` means assigned.
    """
    if not cpu_serial:
        return 100.0  # Devices without a serial are treated as "last to receive"
    digest = hashlib.sha256(f"{cpu_serial}:{version}".encode("utf-8")).digest()
    # First 4 bytes of the digest as an unsigned 32-bit int → 0-1 → 0-100.
    n = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return n * 100.0
