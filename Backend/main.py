"""
Dismissal Backend — application entry point.

Run locally:  uvicorn main:app --reload
Cloud Run:    CMD ["python", "main.py"]  (see Dockerfile)

NOTE: update Dockerfile CMD from `server:app` to `main:app` after merging.
"""
import asyncio
import logging
import os
import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import ENV, FRONTEND_URL

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Dismissal Backend", version="1.1.0")

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
_cors_origins: list = []

if FRONTEND_URL:
    _cors_origins.append(FRONTEND_URL)
    if FRONTEND_URL.endswith(".web.app"):
        _cors_origins.append(FRONTEND_URL.replace(".web.app", ".firebaseapp.com"))

_extra_origins = os.getenv("ALLOWED_ORIGINS", "")
for _o in _extra_origins.split(","):
    _o = _o.strip().rstrip("/")
    if _o and _o not in _cors_origins:
        _cors_origins.append(_o)

if ENV == "development":
    for _dev_origin in ["http://localhost:5173", "http://localhost:3000"]:
        if _dev_origin not in _cors_origins:
            _cors_origins.append(_dev_origin)

_origin_regex_str = os.getenv("ALLOWED_ORIGIN_REGEX", "")
if not _origin_regex_str:
    for _o in _cors_origins:
        _m = re.match(r"https://([a-z][a-z0-9]*)[-a-z0-9]*\.([a-z0-9-]+)\.hosted\.app", _o)
        if _m:
            _origin_regex_str = (
                rf"https://{re.escape(_m.group(1))}[-a-z0-9]*"
                rf"\.{re.escape(_m.group(2))}\.hosted\.app"
            )
            break

if not _origin_regex_str:
    _web_m = re.match(r"https://([a-z0-9][-a-z0-9]*)\.web\.app", FRONTEND_URL or "")
    if _web_m:
        _project = _web_m.group(1)
        _origin_regex_str = (
            rf"https://[-a-z0-9]+--{re.escape(_project)}[-a-z0-9]*"
            rf"\.[-a-z0-9]+\.hosted\.app"
        )

logger.info("CORS allowed origins: %s", _cors_origins)
if _origin_regex_str:
    logger.info("CORS origin regex: %s", _origin_regex_str)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_origin_regex_str or None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-School-Id", "X-District-Id", "X-Dev-Role"],
    expose_headers=["Content-Length"],
    max_age=3600,
)


def _cors_headers_for(request: Request) -> dict:
    origin = request.headers.get("origin", "")
    if not origin:
        return {}
    allowed = origin in _cors_origins
    if not allowed and _origin_regex_str:
        try:
            allowed = bool(re.fullmatch(_origin_regex_str, origin))
        except re.error:
            allowed = False
    if not allowed:
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Vary": "Origin",
    }


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.error(
        "Unhandled exception on %s %s: %s",
        request.method, request.url.path, exc, exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=_cors_headers_for(request),
    )


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
from core.websocket import router as ws_router          # noqa: E402
from routes.scan import router as scan_router           # noqa: E402
from routes.history import router as history_router     # noqa: E402
from routes.plates import router as plates_router       # noqa: E402
from routes.users import router as users_router         # noqa: E402
from routes.schools import router as schools_router     # noqa: E402
from routes.districts import router as districts_router # noqa: E402
from routes.integrity import router as integrity_router # noqa: E402
from routes.guardian import router as guardian_router   # noqa: E402
from routes.admin import router as admin_router         # noqa: E402
from routes.duplicates import router as duplicates_router  # noqa: E402
from routes.devices import router as devices_router    # noqa: E402
from routes.sso import router as sso_router            # noqa: E402
from site_settings import router as site_settings_router  # noqa: E402

app.include_router(ws_router)
app.include_router(scan_router)
app.include_router(history_router)
app.include_router(plates_router)
app.include_router(users_router)
app.include_router(schools_router)
app.include_router(districts_router)
app.include_router(integrity_router)
app.include_router(guardian_router)
app.include_router(admin_router)
app.include_router(duplicates_router)
app.include_router(devices_router)
app.include_router(sso_router)
app.include_router(site_settings_router)


# ---------------------------------------------------------------------------
# Startup / shutdown lifecycle
# ---------------------------------------------------------------------------
def _ensure_default_district() -> None:
    """One-time migration: every school must belong to a district, but the
    ``districts`` collection was introduced later.  On startup:

    1. If no ``districts`` doc exists, create a "Default District" doc.
    2. Backfill ``district_id`` on any ``schools`` doc missing it, pointing
       at the Default District.

    Idempotent — safe to re-run on every cold start.  The super_admin
    renames the Default District later via the Districts page.
    """
    from core.firebase import db
    from datetime import datetime, timezone

    try:
        existing = list(db.collection("districts").limit(1).stream())
    except Exception as exc:
        logger.warning("District migration: district read failed: %s", exc)
        return

    if existing:
        default_id = existing[0].id
    else:
        ref = db.collection("districts").add({
            "name":          "Default District",
            "status":        "active",
            "is_licensed":   False,
            "license_tier":  None,
            "timezone":      "America/New_York",
            "admin_email":   "",
            "notes":         "Auto-created on first deploy. Rename me.",
            "created_at":    datetime.now(tz=timezone.utc),
            "created_by":    "system",
        })
        default_id = ref[1].id
        logger.info("District migration: created Default District id=%s", default_id)

    try:
        orphans = db.collection("schools").where(
            field_path="district_id", op_string="==", value=None,
        ).stream()
        count = 0
        for sdoc in orphans:
            db.collection("schools").document(sdoc.id).update({"district_id": default_id})
            count += 1
        # Firestore doesn't return rows with a missing-field filter the way
        # we'd like, so also sweep for docs that simply don't have the key.
        for sdoc in db.collection("schools").stream():
            data = sdoc.to_dict() or {}
            if "district_id" not in data or not data.get("district_id"):
                db.collection("schools").document(sdoc.id).update({"district_id": default_id})
                count += 1
        if count:
            logger.info("District migration: backfilled %d schools into Default District", count)
    except Exception as exc:
        logger.warning("District migration: school backfill failed: %s", exc)


@app.on_event("startup")
async def _start_archival_task():
    from core.queue import archival_loop
    _ensure_default_district()
    asyncio.create_task(archival_loop())


@app.on_event("shutdown")
async def _graceful_shutdown():
    from core.websocket import registry
    logger.info("Shutdown: closing all WebSocket connections...")
    all_sockets = registry.all_sockets()
    for ws in all_sockets:
        try:
            await ws.close(code=1001, reason="Server shutting down")
        except Exception:
            pass
    logger.info("Shutdown: closed %d WebSocket connection(s)", len(all_sockets))


# ---------------------------------------------------------------------------
# Entry point (local dev / Cloud Run)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=ENV == "development")
