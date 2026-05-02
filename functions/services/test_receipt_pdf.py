"""
Smoke checks for services/receipt_pdf.py — runnable as a script.

Run with:

    cd functions
    SECRET_KEY=test-secret python -m services.test_receipt_pdf

This module is deliberately not a pytest suite — the project has no
Python test harness wired into CI yet, and adding one is out of scope
for issue #72.  Instead this is a lightweight self-check that an
engineer (or a release reviewer) can execute by hand to confirm the
signing primitives behave as expected.
"""
from __future__ import annotations

import os
import sys

# Ensure SECRET_KEY is set before importing the module — the helpers
# read it lazily on first use.
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-receipt-self-check")

from services.receipt_pdf import (
    build_receipt_payload,
    derive_receipt_id,
    mask_plate,
    sign_payload,
    verify_signature,
)


def _check(label: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        sys.exit(1)


def main() -> int:
    print("receipt_pdf self-check\n")

    # ── derive_receipt_id is deterministic ──────────────────────
    id_a1 = derive_receipt_id("scan-1", "school-1")
    id_a2 = derive_receipt_id("scan-1", "school-1")
    id_b  = derive_receipt_id("scan-1", "school-2")
    _check("receipt id is deterministic",                 id_a1 == id_a2)
    _check("receipt id changes with school",              id_a1 != id_b)
    _check("receipt id is 16 hex chars",                  len(id_a1) == 16 and all(c in "0123456789abcdef" for c in id_a1))

    # ── sign / verify round-trip ────────────────────────────────
    payload = build_receipt_payload(
        scan_id="scan-1",
        school_id="school-1",
        plate_token="abc123",
        plate_display="ABC1234",
        scan_timestamp_iso="2026-05-02T15:14:25-04:00",
        location="Carline B",
        issued_at_iso="2026-05-02T15:15:00+00:00",
    )
    sig = sign_payload(payload)
    _check("signature is non-empty",                      bool(sig))
    _check("verify_signature accepts the signed payload", verify_signature(payload, sig))

    # ── tampering invalidates the signature ─────────────────────
    tampered = dict(payload, location="Carline C")
    _check("verify_signature rejects modified location",  not verify_signature(tampered, sig))
    tampered = dict(payload, scan_timestamp="2026-05-03T00:00:00+00:00")
    _check("verify_signature rejects modified timestamp", not verify_signature(tampered, sig))
    _check("verify_signature rejects empty signature",    not verify_signature(payload, ""))
    _check("verify_signature rejects garbage signature",  not verify_signature(payload, "deadbeef"))

    # ── plate masking ───────────────────────────────────────────
    _check("mask_plate masks long plate",                 mask_plate("ABC1234") == "****234")
    _check("mask_plate leaves short plate alone",         mask_plate("XY9") == "XY9")
    _check("mask_plate handles None",                     mask_plate(None) == "—")
    _check("mask_plate handles empty",                    mask_plate("") == "—")

    print("\nAll receipt_pdf self-checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
