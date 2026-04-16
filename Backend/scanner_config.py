"""
scanner_config.py — project-wide constants for the Dismissal scanner.

These values are the same across every scanner deployment:

* Backend URLs (public endpoints — the scanner POSTs to these)
* Firebase Web API key (public; every Firebase web app embeds it in JS)

Putting them in the repo instead of a per-device ``.env`` removes a manual
editing step from the deployment workflow and keeps the SD-card prep command
to a single invocation.  These values are not secrets.

Per-device secrets (the Firebase service-account JSON) still live on disk
at /opt/dismissal/Backend/firebase-scanner-sa.json (mode 600, owner dismissal).

Environment variables with the same name as any constant below override the
constant at runtime — handy for development or ad-hoc testing, but not
required for a standard deployment.
"""
from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Backend endpoints
# ---------------------------------------------------------------------------
PROD_BACKEND_URL = os.getenv(
    "VITE_PROD_BACKEND_URL",
    "https://YOUR_CLOUD_RUN_URL.run.app",
)
DEV_BACKEND_URL = os.getenv(
    "VITE_DEV_BACKEND_URL",
    "http://localhost:8000",
)

# ---------------------------------------------------------------------------
# Firebase (public, not a secret)
# Find in Firebase Console → Project Settings → General → Web API Key.
# ---------------------------------------------------------------------------
FIREBASE_WEB_API_KEY = os.getenv(
    "FIREBASE_WEB_API_KEY",
    "REPLACE_WITH_YOUR_FIREBASE_WEB_API_KEY",
)


def backend_url(env: str) -> str:
    """Return the backend URL for the current environment."""
    return PROD_BACKEND_URL if env == "production" else DEV_BACKEND_URL
