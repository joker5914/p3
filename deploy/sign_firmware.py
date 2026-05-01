#!/usr/bin/env python3
"""
sign_firmware.py — Dismissal scanner firmware signing tool.

The release engineer runs this on a workstation (NOT on a Pi or in CI
without secret protection) to produce a signed manifest for a firmware
tarball.  Output is uploaded alongside the tarball to Firebase Storage
under firmware/releases/{version}/.

Workflow:

  1. One-time, generate the long-lived signing keypair:

       python sign_firmware.py --gen-keypair --out-dir ./fw-keys

     Produces:
       fw-keys/firmware.priv  (KEEP SECRET — never commit, never put
                               on a Pi or in the backend repo)
       fw-keys/firmware.pub   (ship to every Pi at provisioning,
                               commit to deploy/firmware.pub.example
                               for audit)

  2. Per release, sign the tarball:

       export DISMISSAL_FW_PRIVATE_KEY=/secrets/firmware.priv
       python sign_firmware.py \
           --version 1.2.3 \
           --tarball ./dismissal-1.2.3.tar.gz \
           --signed-by alice@dismissal \
           --out ./manifest.json

  3. Upload tarball + manifest.json to Firebase Storage at
     firmware/releases/1.2.3/.  The admin portal's Firmware page
     reads them in and creates the firmware_releases/{version} doc.

Manifest format (JSON):

  {
    "version": "1.2.3",
    "artifact_filename": "dismissal-1.2.3.tar.gz",
    "sha256": "<hex>",
    "size_bytes": 12345,
    "signature_ed25519": "<base64>",
    "signed_at": "2026-05-01T12:00:00+00:00",
    "signed_by": "alice@dismissal",
    "min_compatible_version": "1.0.0"
  }

The signature covers the SHA-256 of the tarball (not the tarball
itself), so verification on the Pi does not require holding the whole
artifact in memory.  Combined with the on-device hash check, this is
enough to detect any tampering between the signing workstation and
the Pi.

Algorithm: Ed25519 (per issue #104).  Public-key format on the Pi is a
single line of base64-encoded raw 32-byte Ed25519 public key, with
human-readable comment lines starting with `#` ignored.  See
deploy/firmware.pub.example.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
except ImportError:
    sys.exit(
        "cryptography is required: pip install cryptography\n"
        "(this script runs on a workstation, not the Pi)"
    )

# Keep the manifest field set narrow: anything we add must be safe to
# extend across releases without breaking older Pis that don't know
# the field.  Pis ignore unknown fields when verifying.
MANIFEST_VERSION = 1


def _read_pubkey_b64(path: Path) -> bytes:
    """Strip comments + whitespace from the pubkey file and return raw bytes."""
    text = path.read_text(encoding="utf-8")
    body = "".join(
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    raw = base64.b64decode(body, validate=True)
    if len(raw) != 32:
        raise ValueError(
            f"Public key must be 32 raw bytes, got {len(raw)} (file: {path})"
        )
    return raw


def _read_privkey_b64(path: Path) -> bytes:
    """Same format as the public key — base64 of raw 32 bytes, # comments."""
    text = path.read_text(encoding="utf-8")
    body = "".join(
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    raw = base64.b64decode(body, validate=True)
    if len(raw) != 32:
        raise ValueError(
            f"Private key must be 32 raw bytes, got {len(raw)} (file: {path})"
        )
    return raw


def _sha256_file(path: Path) -> tuple[str, int]:
    """Stream the file through SHA-256.  Returns (hex_digest, size_bytes)."""
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            sha.update(chunk)
            size += len(chunk)
    return sha.hexdigest(), size


def _validate_version(v: str) -> str:
    """Permissive semver — major.minor.patch[-suffix] only."""
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?", v):
        raise ValueError(
            f"version must look like 1.2.3 or 1.2.3-beta1 (got: {v!r})"
        )
    return v


def cmd_gen_keypair(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    priv_path = out_dir / "firmware.priv"
    pub_path  = out_dir / "firmware.pub"
    if priv_path.exists() or pub_path.exists():
        print(
            f"Refusing to overwrite existing keys in {out_dir}\n"
            "Move or delete them first; rotating keys means re-provisioning Pis.",
            file=sys.stderr,
        )
        return 2

    priv = Ed25519PrivateKey.generate()
    raw_priv = priv.private_bytes_raw()
    raw_pub  = priv.public_key().public_bytes_raw()
    now      = datetime.now(tz=timezone.utc).isoformat()

    priv_path.write_text(
        "# Dismissal Firmware PRIVATE Key (Ed25519, raw 32 bytes, base64)\n"
        f"# Generated: {now}\n"
        "# KEEP SECRET — never commit, never put on a Pi or in the backend.\n"
        f"{base64.b64encode(raw_priv).decode('ascii')}\n",
        encoding="utf-8",
    )
    os.chmod(priv_path, 0o600)
    pub_path.write_text(
        "# Dismissal Firmware Public Key (Ed25519, raw 32 bytes, base64)\n"
        f"# Generated: {now}\n"
        f"{base64.b64encode(raw_pub).decode('ascii')}\n",
        encoding="utf-8",
    )
    print(f"Wrote {priv_path} (mode 0600)")
    print(f"Wrote {pub_path}")
    print()
    print("Next steps:")
    print(f"  - Distribute {pub_path.name} to every Pi at /opt/dismissal/keys/firmware.pub")
    print(f"  - Store {priv_path.name} in your secrets manager and DO NOT commit it.")
    return 0


def cmd_sign(args: argparse.Namespace) -> int:
    version = _validate_version(args.version)
    tarball = Path(args.tarball).expanduser().resolve()
    if not tarball.is_file():
        print(f"Tarball not found: {tarball}", file=sys.stderr)
        return 2

    priv_path_env = os.getenv("DISMISSAL_FW_PRIVATE_KEY", "").strip()
    priv_path = Path(args.private_key or priv_path_env).expanduser().resolve()
    if not priv_path.is_file():
        print(
            "Private key not found.  Set DISMISSAL_FW_PRIVATE_KEY or pass --private-key.",
            file=sys.stderr,
        )
        return 2

    raw_priv = _read_privkey_b64(priv_path)
    priv = Ed25519PrivateKey.from_private_bytes(raw_priv)

    sha_hex, size = _sha256_file(tarball)
    # Sign the SHA-256 digest bytes (not hex) — fixed 32-byte payload,
    # cheap to verify on the Pi without rehashing during signature check.
    sig = priv.sign(bytes.fromhex(sha_hex))
    signed_at = datetime.now(tz=timezone.utc).isoformat()

    manifest = {
        "manifest_version":      MANIFEST_VERSION,
        "version":               version,
        "artifact_filename":     tarball.name,
        "sha256":                sha_hex,
        "size_bytes":            size,
        "signature_ed25519":     base64.b64encode(sig).decode("ascii"),
        "signed_at":             signed_at,
        "signed_by":             args.signed_by,
        "min_compatible_version": args.min_compatible_version,
    }

    out_path = Path(args.out).expanduser().resolve() if args.out else (
        tarball.parent / "manifest.json"
    )
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote signed manifest to {out_path}")
    print(f"  version : {version}")
    print(f"  sha256  : {sha_hex}")
    print(f"  size    : {size:,} bytes")

    # Self-check: re-verify the signature we just wrote so a corrupt
    # private-key file or wrong algorithm fails loudly here, not in the
    # field on the first Pi to download it.
    try:
        priv.public_key().verify(sig, bytes.fromhex(sha_hex))
    except Exception as exc:
        print(f"Self-verification FAILED: {exc}", file=sys.stderr)
        return 3
    print("Self-verification passed.")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    """Local sanity check — replays what the Pi will do."""
    manifest_path = Path(args.manifest).expanduser().resolve()
    pub_path      = Path(args.public_key).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifact = manifest_path.parent / manifest["artifact_filename"]
    if args.tarball:
        artifact = Path(args.tarball).expanduser().resolve()
    if not artifact.is_file():
        print(f"Tarball not found: {artifact}", file=sys.stderr)
        return 2

    sha_hex, size = _sha256_file(artifact)
    if sha_hex != manifest["sha256"]:
        print(
            f"SHA-256 mismatch: artifact {sha_hex} vs manifest {manifest['sha256']}",
            file=sys.stderr,
        )
        return 3
    if size != manifest["size_bytes"]:
        print(
            f"Size mismatch: artifact {size} vs manifest {manifest['size_bytes']}",
            file=sys.stderr,
        )
        return 3

    pub = Ed25519PublicKey.from_public_bytes(_read_pubkey_b64(pub_path))
    sig = base64.b64decode(manifest["signature_ed25519"], validate=True)
    pub.verify(sig, bytes.fromhex(sha_hex))
    print(f"OK — manifest verified against {pub_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    p_gen = sub.add_parser("gen-keypair", help="Generate a fresh Ed25519 keypair")
    p_gen.add_argument("--out-dir", required=True, help="Directory to write firmware.priv + firmware.pub")
    p_gen.set_defaults(func=cmd_gen_keypair)

    p_sign = sub.add_parser("sign", help="Sign a firmware tarball, write manifest.json")
    p_sign.add_argument("--version", required=True, help="Release version, e.g. 1.2.3")
    p_sign.add_argument("--tarball", required=True, help="Path to dismissal-{version}.tar.gz")
    p_sign.add_argument("--out", help="Output manifest path (default: <tarball-dir>/manifest.json)")
    p_sign.add_argument("--signed-by", required=True, help="Identifier of release engineer (audit trail)")
    p_sign.add_argument("--min-compatible-version", default="0.0.0",
                        help="Minimum currently-installed version that may upgrade to this one (default 0.0.0)")
    p_sign.add_argument("--private-key", default=None,
                        help="Path to firmware.priv (defaults to $DISMISSAL_FW_PRIVATE_KEY)")
    p_sign.set_defaults(func=cmd_sign)

    p_ver = sub.add_parser("verify", help="Re-verify a manifest + tarball against a public key")
    p_ver.add_argument("--manifest", required=True)
    p_ver.add_argument("--public-key", required=True)
    p_ver.add_argument("--tarball", default=None,
                       help="Override path (default: artifact_filename relative to manifest)")
    p_ver.set_defaults(func=cmd_verify)

    # Top-level flag aliases so the original docstring examples still work.
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] not in ("sign", "gen-keypair", "verify") and not argv[0].startswith("-"):
        # Allow `--gen-keypair`, `--version` etc. directly without subcommand
        pass
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
