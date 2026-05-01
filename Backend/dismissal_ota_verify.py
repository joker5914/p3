"""
dismissal_ota_verify.py — verify a downloaded firmware artifact against
its manifest before the OTA agent swaps the live release.

Verification (all three must pass before swap):

  1. The artifact's SHA-256 matches manifest.sha256 and its byte size
     matches manifest.size_bytes.
  2. The manifest's `version` matches the version the agent thought it
     was downloading (stops a confused-deputy that reuses an old
     manifest with a new artifact).
  3. The manifest's ed25519 signature, run against the artifact's
     SHA-256 digest bytes (NOT the tarball itself), verifies under the
     public key baked into the Pi at /opt/dismissal/keys/firmware.pub.

Public key format (matches deploy/sign_firmware.py output):

    # comment lines starting with # are ignored
    <single line of base64 of the raw 32-byte ed25519 public key>

The signing tool's documentation (deploy/sign_firmware.py module
docstring) is the canonical spec; keep this verifier aligned with it.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

# cryptography is a transitive dep of firebase-admin (via google-auth)
# so it's already available on every scanner.  Pinning it explicitly in
# requirements-scanner.txt makes the dependency declared.
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

logger = logging.getLogger("dismissal-ota.verify")

# Default location on the Pi.  Provisioning (deploy/install.sh) writes
# the key here; deploy/firstrun.sh ensures the directory exists with
# 0755 perms (the file is 0644 — public).
DEFAULT_PUBKEY_PATH = "/opt/dismissal/keys/firmware.pub"


class FirmwareVerificationError(Exception):
    """Raised when a downloaded artifact fails any verification step.

    The OTA agent treats any of these as a hard reject — the artifact
    is deleted, the device_firmware state moves to ``failed``, and the
    backend is told why so an admin can see it on the Releases page."""


@dataclass(frozen=True)
class FirmwareManifest:
    version:                 str
    artifact_filename:       str
    sha256:                  str
    size_bytes:              int
    signature_ed25519:       str   # base64
    signed_at:               str   # ISO-8601
    signed_by:               str
    min_compatible_version:  str = "0.0.0"

    @classmethod
    def from_json(cls, blob: dict) -> "FirmwareManifest":
        try:
            return cls(
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
            raise FirmwareVerificationError(f"Manifest is malformed: {exc}") from exc


def load_pubkey(path: str | Path = DEFAULT_PUBKEY_PATH) -> Ed25519PublicKey:
    """Read the on-disk pubkey file and return an ed25519 verifier.

    Raises ``FirmwareVerificationError`` if the file is missing,
    unparseable, or doesn't decode to a 32-byte raw key — those are
    all "do not apply firmware" conditions, treated identically to a
    bad signature."""
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise FirmwareVerificationError(
            f"Public key not found at {p} ({exc})"
        ) from exc

    body = "".join(
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    try:
        raw = base64.b64decode(body, validate=True)
    except Exception as exc:
        raise FirmwareVerificationError(f"Public key {p} is not valid base64: {exc}") from exc
    if len(raw) != 32:
        raise FirmwareVerificationError(
            f"Public key {p} must decode to 32 bytes, got {len(raw)}"
        )
    return Ed25519PublicKey.from_public_bytes(raw)


def sha256_of_file(path: str | Path) -> tuple[str, int]:
    """Stream-hash ``path`` so we never hold a multi-MB tarball in RAM.
    Returns ``(hex_digest, byte_size)``."""
    sha = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            sha.update(chunk)
            size += len(chunk)
    return sha.hexdigest(), size


def parse_manifest(path: str | Path) -> FirmwareManifest:
    p = Path(path)
    try:
        blob = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FirmwareVerificationError(f"Manifest at {p} could not be parsed: {exc}") from exc
    return FirmwareManifest.from_json(blob)


def verify_artifact(
    artifact_path:  str | Path,
    manifest:       FirmwareManifest,
    *,
    expected_version: str,
    pubkey_path:    str | Path = DEFAULT_PUBKEY_PATH,
) -> None:
    """Run all checks; raise ``FirmwareVerificationError`` on any failure.

    On success, returns silently.  Any non-success path leaves the
    caller responsible for deleting the artifact + updating state."""
    if manifest.version != expected_version:
        raise FirmwareVerificationError(
            f"Manifest version {manifest.version!r} does not match expected "
            f"target {expected_version!r}"
        )

    sha_hex, size = sha256_of_file(artifact_path)
    if sha_hex.lower() != manifest.sha256.lower():
        raise FirmwareVerificationError(
            f"Artifact SHA-256 mismatch: file={sha_hex} manifest={manifest.sha256}"
        )
    if size != manifest.size_bytes:
        raise FirmwareVerificationError(
            f"Artifact size mismatch: file={size} manifest={manifest.size_bytes}"
        )

    try:
        pub = load_pubkey(pubkey_path)
        sig = base64.b64decode(manifest.signature_ed25519, validate=True)
        # Signature payload is the raw 32-byte digest, not the hex string.
        pub.verify(sig, bytes.fromhex(sha_hex))
    except InvalidSignature as exc:
        raise FirmwareVerificationError(
            "Ed25519 signature did not verify against on-device public key"
        ) from exc
    except FirmwareVerificationError:
        raise
    except Exception as exc:
        raise FirmwareVerificationError(f"Signature check failed: {exc}") from exc

    logger.info(
        "Firmware verified: version=%s sha256=%s size=%d signed_by=%s",
        manifest.version, manifest.sha256, manifest.size_bytes, manifest.signed_by,
    )


def compare_versions(a: str, b: str) -> int:
    """Return -1/0/1 for a<b / a==b / a>b on the leading numeric components.

    Strict semver libs would be overkill — releases are major.minor.patch
    with optional ``-suffix``.  Suffix comparisons are lexicographic only
    when the leading numeric parts match.  This is enough to enforce the
    ``min_compatible_version`` floor on the Pi without a new dependency.
    """
    def _parts(v: str) -> tuple[list[int], str]:
        head, _, suffix = v.partition("-")
        nums = [int(x) for x in head.split(".") if x.isdigit()]
        return nums, suffix
    an, asx = _parts(a)
    bn, bsx = _parts(b)
    # Pad to equal length so 1.2 < 1.2.0 returns 0, not -1.
    while len(an) < len(bn):
        an.append(0)
    while len(bn) < len(an):
        bn.append(0)
    if an != bn:
        return -1 if an < bn else 1
    if asx == bsx:
        return 0
    # Pre-release suffix sorts before plain version (1.2.3-rc1 < 1.2.3).
    if not asx:
        return 1
    if not bsx:
        return -1
    return -1 if asx < bsx else 1
