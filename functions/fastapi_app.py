"""FastAPI application — assembled for the Cloud Functions runtime.

Mirrors ``Backend/main.py`` minus the bits that don't belong in a
stateless function:
  - No ``@app.on_event("startup")`` archival loop.  The hourly background
    work runs inside a separate ``scheduler_fn`` declared in main.py.
  - No ``@app.on_event("shutdown")`` WebSocket teardown — there are no
    persistent sockets in this runtime.
  - No ``/ws/dashboard`` router.  Live updates moved to a Firestore
    onSnapshot listener on ``live_queue/{school_id}/events``.

The startup migration ``_ensure_default_district`` is exposed as a
manually-callable function (see main.py: bootstrap_default_district).
"""
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import ENV, FRONTEND_URL

logger = logging.getLogger(__name__)

app = FastAPI(title="Dismissal Backend", version="2.0.0-functions")

# ---------------------------------------------------------------------------
# CORS — the portal lives at the same origin via Firebase Hosting's
# /api/** rewrite, so cross-origin only matters for dev and for the
# on-device scanner Pi (which is server-to-server and ignores CORS).
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
    for _dev_origin in ["http://localhost:5173", "http://localhost:3000", "http://localhost:5000"]:
        if _dev_origin not in _cors_origins:
            _cors_origins.append(_dev_origin)

logger.info("CORS allowed origins: %s", _cors_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-School-Id", "X-District-Id", "X-Dev-Role"],
    expose_headers=["Content-Length", "X-Correlation-Id"],
    max_age=3600,
)

from core.middleware import AuditContextMiddleware  # noqa: E402
app.add_middleware(AuditContextMiddleware)


def _cors_headers_for(request: Request) -> dict:
    origin = request.headers.get("origin", "")
    if not origin or origin not in _cors_origins:
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
# Routers — same set as Backend/main.py minus the WebSocket router.
# ---------------------------------------------------------------------------
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
from routes.firmware import router as firmware_router  # noqa: E402
from routes.sso import router as sso_router            # noqa: E402
from routes.audit import router as audit_router        # noqa: E402
from routes.email_logs import router as email_logs_router  # noqa: E402
from routes.integrations import router as integrations_router  # noqa: E402
from routes.public import router as public_router       # noqa: E402
from routes.receipts import router as receipts_router  # noqa: E402
from routes.scheduler import router as scheduler_router  # noqa: E402
from site_settings import router as site_settings_router  # noqa: E402

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
app.include_router(firmware_router)
app.include_router(sso_router)
app.include_router(audit_router)
app.include_router(email_logs_router)
app.include_router(integrations_router)
app.include_router(public_router)
app.include_router(receipts_router)
app.include_router(scheduler_router)
app.include_router(site_settings_router)
