"""Cloud Functions for Firebase — Dismissal API entry point.

Exposes:
  - ``api`` — single HTTPS function that delegates every request to the
    FastAPI app.  Firebase Hosting rewrites ``/api/v1/**`` (and friends)
    to this function, so the portal calls it same-origin.
  - ``hourly_maintenance`` — scheduled function that mirrors the
    archival_loop body from the old Backend/core/queue.py: scan
    archival, audit retention, and SIS roster sync.
  - ``bootstrap_default_district`` — manually-invokable function
    replacing the @app.on_event("startup") migration that ensured
    every school had a district.

Local dev: ``firebase emulators:start --only functions,firestore,auth,hosting``
"""
import asyncio
import logging
from datetime import datetime, timezone

import httpx
from firebase_functions import https_fn, options, scheduler_fn
from firebase_functions.params import SecretParam

# Secrets sourced from Google Secret Manager and exposed to the runtime
# as env vars with the matching names — preserving the same names the
# old Cloud Run service used so the underlying modules pick them up
# unchanged via os.getenv().
SECRET_KEY = SecretParam("SECRET_KEY")
DISMISSAL_ENCRYPTION_KEY = SecretParam("DISMISSAL_ENCRYPTION_KEY")
RESEND_API_KEY = SecretParam("RESEND_API_KEY")
_ALL_SECRETS = [SECRET_KEY, DISMISSAL_ENCRYPTION_KEY, RESEND_API_KEY]

# Bound concurrency + memory in line with the existing Cloud Run profile.
# Gen 2 functions default to 1 vCPU, 256 MiB; the FastAPI app is fine on
# that during normal pickup load.  Memory bumped to 512 MiB to comfortably
# absorb the SIS sync's per-roster fetch buffers.
_HTTP_OPTIONS = options.HttpsOptions(
    region="us-central1",
    memory=options.MemoryOption.MB_512,
    concurrency=80,
    timeout_sec=120,
)

# Scheduled function knobs are passed directly to scheduler_fn.on_schedule
# below — the SDK doesn't expose a reusable Options dataclass for the
# scheduled trigger the way it does for HTTPS.
_SCHEDULED_REGION = "us-central1"
_SCHEDULED_MEMORY = options.MemoryOption.MB_512
_SCHEDULED_TIMEOUT_SEC = 540  # archival + SIS sync can run a few minutes


# ---------------------------------------------------------------------------
# HTTPS — FastAPI driven via httpx ASGITransport.
# ---------------------------------------------------------------------------
# Import side effects: bringing the FastAPI app into scope here forces
# core/firebase.py + secure_lookup.py to load.  Both modules are
# import-time lazy now (they read env on first use), so this is cheap
# and doesn't require credentials to be present yet.
from fastapi_app import app as fastapi_app  # noqa: E402

# A single ASGITransport reused across requests — building one per
# request would re-run lifespan startup and is unnecessary.  httpx
# manages concurrency safely when shared.
_asgi_transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)


async def _proxy_to_fastapi(method: str, url: str, headers: dict, content: bytes) -> httpx.Response:
    async with httpx.AsyncClient(transport=_asgi_transport, base_url="http://internal") as client:
        return await client.request(
            method=method,
            url=url,
            headers=headers,
            content=content,
            timeout=110.0,
        )


@https_fn.on_request(
    region=_HTTP_OPTIONS.region,
    memory=_HTTP_OPTIONS.memory,
    concurrency=_HTTP_OPTIONS.concurrency,
    timeout_sec=_HTTP_OPTIONS.timeout_sec,
    secrets=_ALL_SECRETS,
)
def api(request: https_fn.Request) -> https_fn.Response:
    """All HTTP traffic — delegates to the FastAPI app over an in-process
    ASGI transport.  No network round-trip; httpx talks to FastAPI
    directly via the ASGI protocol."""
    # Reconstruct the path+querystring the way the original client sent
    # it.  Flask's request.full_path appends a trailing '?' on bare
    # paths; strip that so FastAPI's router treats /foo and /foo? the
    # same.
    path_qs = request.full_path
    if path_qs.endswith("?"):
        path_qs = path_qs[:-1]

    # Skip Cloud Functions/Run hop-by-hop and proxy headers that confuse
    # FastAPI/Starlette routing — Host needs to be the inner ASGI host,
    # not the cloudfunctions.net hostname.
    upstream_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }

    response = asyncio.run(_proxy_to_fastapi(
        method=request.method,
        url=path_qs,
        headers=upstream_headers,
        content=request.get_data(cache=False),
    ))

    # Drop hop-by-hop headers from the response on the way back.
    out_headers = {
        k: v for k, v in response.headers.items()
        if k.lower() not in ("content-encoding", "transfer-encoding", "content-length", "connection")
    }
    return https_fn.Response(
        response.content,
        status=response.status_code,
        headers=out_headers,
    )


# ---------------------------------------------------------------------------
# Scheduled — hourly maintenance.
# ---------------------------------------------------------------------------
@scheduler_fn.on_schedule(
    schedule="every 1 hours",
    region=_SCHEDULED_REGION,
    memory=_SCHEDULED_MEMORY,
    timeout_sec=_SCHEDULED_TIMEOUT_SEC,
    secrets=_ALL_SECRETS,
)
def hourly_maintenance(event: scheduler_fn.ScheduledEvent) -> None:
    """Replaces the archival_loop background task.

    The old loop ran every hour from a long-lived asyncio task on Cloud
    Run.  Cloud Functions can't host that pattern, so Cloud Scheduler
    wakes us up on the same cadence instead.
    """
    logger = logging.getLogger("hourly_maintenance")

    # Late imports keep cold-start cheap when only the api function is hit.
    from core.audit import purge_expired_audit_events
    from core.queue_jobs import (
        archive_previous_day_scans,
        purge_stale_live_queue,
        run_due_sis_syncs,
    )

    try:
        archive_previous_day_scans()
    except Exception as exc:
        logger.error("Scan archival error: %s", exc)

    # Drop yesterday's live_queue events so the Dashboard's onSnapshot
    # listener doesn't briefly surface them on the next morning's first
    # load.  Cheap and idempotent — running hourly guarantees a fresh
    # campus state within an hour of the day boundary in the configured
    # timezone, even if the previous day's last bulk-pickup never fired.
    try:
        purge_stale_live_queue()
    except Exception as exc:
        logger.error("live_queue day-purge error: %s", exc)

    # Audit retention: cheap enough to run hourly now that we don't
    # have an in-process loop deciding "once per day".  Cloud Scheduler
    # gives us deterministic timing; running 24x/day costs effectively
    # nothing because most passes find no rows past their retention.
    try:
        purge_expired_audit_events(default_retention_days=365)
    except Exception as exc:
        logger.error("Audit retention error: %s", exc)

    try:
        run_due_sis_syncs()
    except Exception as exc:
        logger.error("SIS sync loop error: %s", exc)

    logger.info("hourly_maintenance complete: %s", datetime.now(timezone.utc).isoformat())


# ---------------------------------------------------------------------------
# Manually-invokable bootstrap — replaces @app.on_event("startup")'s
# _ensure_default_district().  Idempotent.  Call once after first
# deploy via:
#     firebase functions:shell  →  bootstrap_default_district({})
# or hit the HTTPS endpoint with a super_admin token.
# ---------------------------------------------------------------------------
@https_fn.on_request(
    region=_HTTP_OPTIONS.region,
    memory=options.MemoryOption.MB_256,
    timeout_sec=60,
    secrets=_ALL_SECRETS,
)
def bootstrap_default_district(request: https_fn.Request) -> https_fn.Response:
    from core.bootstrap import ensure_default_district

    try:
        result = ensure_default_district()
    except Exception as exc:
        return https_fn.Response(
            f'{{"status":"error","detail":"{exc}"}}',
            status=500,
            headers={"Content-Type": "application/json"},
        )
    import json
    return https_fn.Response(
        json.dumps({"status": "ok", **result}),
        status=200,
        headers={"Content-Type": "application/json"},
    )
