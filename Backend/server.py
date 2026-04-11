"""
Dismissal Backend Server — FastAPI

Changes from original:
  - Fixed school_id scoping throughout all handlers
  - WebSocket requires Bearer token via ?token= query param
  - /api/v1/admin/import-plates tokenises & encrypts PII before storing
  - Queue cleared on clear event (was only broadcast)
  - Firestore batch deletes chunked at 500 (Firestore hard limit)
  - Per-school WebSocket rooms (broadcasts scoped to school_id)
  - CORS origins driven by env (VITE_PROD_FRONTEND_URL + ALLOWED_ORIGINS)
  - $PORT support in uvicorn for Cloud Run
  - Role-based access control (school_admin / staff)
  - Multi-admin user management endpoints
"""

from fastapi import FastAPI, HTTPException, Request, Response, Depends, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict
import firebase_admin
from firebase_admin import credentials, auth as fb_auth
from google.cloud import firestore
from secure_lookup import tokenize_plate, tokenize_student, encrypt_string, decrypt_string, safe_decrypt
import hmac
import hashlib
import re
import os
import threading
import logging
import asyncio
import json
import secrets
import string
from dotenv import load_dotenv
from zoneinfo import ZoneInfo

load_dotenv()

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
ENV = os.getenv("ENV", "development")

if ENV == "production":
    BACKEND_URL = (os.getenv("VITE_PROD_BACKEND_URL") or "").strip().rstrip("/")
    FRONTEND_URL = (os.getenv("VITE_PROD_FRONTEND_URL") or "").strip().rstrip("/")
else:
    BACKEND_URL = os.getenv("VITE_DEV_BACKEND_URL", "http://localhost:8000")
    FRONTEND_URL = os.getenv("VITE_DEV_FRONTEND_URL", "http://localhost:5173")

DEVICE_TIMEZONE = os.getenv("DEVICE_TIMEZONE", "America/New_York")
DEV_SCHOOL_ID = os.getenv("DEV_SCHOOL_ID", "dev_school")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App & CORS
# ---------------------------------------------------------------------------
app = FastAPI(title="Dismissal Backend", version="1.1.0")

# ---------------------------------------------------------------------------
# CORS origins
#
# Priority:
#  1. VITE_PROD_FRONTEND_URL  — primary frontend URL (custom domain / old Hosting)
#  2. ALLOWED_ORIGINS         — comma-separated list of additional origins
#                               (Firebase App Hosting URL, staging URLs, etc.)
#  3. localhost variants added automatically in development
#
# To add the Firebase App Hosting URL (or any future custom domain) without
# re-deploying code, set ALLOWED_ORIGINS on the Cloud Run backend:
#   ALLOWED_ORIGINS=https://mercury--p3-auth-762da.us-central1.hosted.app,https://app.example.com
# ---------------------------------------------------------------------------
_cors_origins: list[str] = []

if FRONTEND_URL:
    _cors_origins.append(FRONTEND_URL)
    # Firebase Hosting exposes both .web.app and .firebaseapp.com — accept both
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

# Firebase App Hosting generates a unique URL per rollout/channel, so a
# single origin string quickly goes stale.  Derive a regex that accepts
# every deployment of the same project+region automatically.
# Override: set ALLOWED_ORIGIN_REGEX on Cloud Run for full control.
_origin_regex_str = os.getenv("ALLOWED_ORIGIN_REGEX", "")
if not _origin_regex_str:
    # Strategy 1: derive from an explicit .hosted.app URL in the origins list
    for _o in _cors_origins:
        _m = re.match(r"https://([a-z][a-z0-9]*)[-a-z0-9]*\.([a-z0-9-]+)\.hosted\.app", _o)
        if _m:
            _origin_regex_str = (
                rf"https://{re.escape(_m.group(1))}[-a-z0-9]*"
                rf"\.{re.escape(_m.group(2))}\.hosted\.app"
            )
            break

if not _origin_regex_str:
    # Strategy 2: derive from VITE_PROD_FRONTEND_URL (.web.app → .hosted.app)
    # Firebase Hosting project "foo" → App Hosting URLs like
    # https://<backend>--foo-<hash>.<region>.hosted.app
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
    allow_headers=["Content-Type", "Authorization", "X-School-Id", "X-Dev-Role"],
    expose_headers=["Content-Length"],
    max_age=3600,
)


def _cors_headers_for(request: Request) -> dict:
    """Return the CORS response headers appropriate for ``request`` origin.

    Starlette's CORSMiddleware does not attach Access-Control-* headers when
    an unhandled exception escapes the application (the 500 response is
    generated by the outer ServerErrorMiddleware which the CORS middleware
    never sees). We reuse the whitelist/regex that was computed above to
    rebuild the headers manually for any error response the app returns.
    """
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
    """Ensure any uncaught exception returns a 500 with CORS headers.

    Without this, a Fernet InvalidToken (or any other stray exception) slips
    past CORSMiddleware and surfaces in the browser as an opaque
    "blocked by CORS" error — hiding the real failure from the frontend.
    Logging uses exc_info=True so GCP Error Reporting still captures it.
    """
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
# Firebase / Firestore
# ---------------------------------------------------------------------------
_cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH",
                        "firebase_credentials.json" if ENV == "development" else "")
_cred_json_str = os.getenv("FIREBASE_CREDENTIALS_JSON", "")

if _cred_json_str:
    # Secret injected as env var value (JSON content) — no file mount needed
    from google.oauth2 import service_account as _sa
    _cred_dict = json.loads(_cred_json_str)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(_cred_dict))
    _sa_creds = _sa.Credentials.from_service_account_info(
        _cred_dict,
        scopes=["https://www.googleapis.com/auth/cloud-platform",
                "https://www.googleapis.com/auth/datastore"],
    )
    db = firestore.Client(credentials=_sa_creds, project=_cred_dict.get("project_id"))
elif _cred_path:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(_cred_path))
    db = firestore.Client.from_service_account_json(_cred_path)
else:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    db = firestore.Client()

# ---------------------------------------------------------------------------
# Secret key
# ---------------------------------------------------------------------------
_secret_key_raw = os.getenv("SECRET_KEY")
if not _secret_key_raw:
    raise RuntimeError("SECRET_KEY environment variable is not set")
SECRET_KEY = _secret_key_raw.encode()

# ---------------------------------------------------------------------------
# WebSocket connection registry — keyed by school_id
# ---------------------------------------------------------------------------
class ConnectionRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._rooms: Dict[str, List[WebSocket]] = {}

    def add(self, school_id: str, ws: WebSocket):
        with self._lock:
            self._rooms.setdefault(school_id, []).append(ws)

    def remove(self, school_id: str, ws: WebSocket):
        with self._lock:
            room = self._rooms.get(school_id, [])
            if ws in room:
                room.remove(ws)

    async def broadcast(self, school_id: str, message: dict):
        payload = _serialise(message)
        with self._lock:
            targets = list(self._rooms.get(school_id, []))
        dead = []
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.remove(school_id, ws)


registry = ConnectionRegistry()


def _serialise(data: dict) -> str:
    def _default(obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")
    return json.dumps(data, default=_default)


# ---------------------------------------------------------------------------
# WebSocket endpoint — requires ?token= for authentication
# ---------------------------------------------------------------------------
@app.websocket("/ws/dashboard")
async def dashboard_ws(
    websocket: WebSocket,
    token: str = Query(default=None),
):
    # IMPORTANT: always accept first.
    # Calling close() before accept() sends an HTTP 403 instead of a proper
    # WebSocket close frame, which makes the browser report
    # "bad response from server" and triggers an infinite reconnect loop.
    await websocket.accept()

    if token:
        try:
            decoded = fb_auth.verify_id_token(token)
            school_id = decoded.get("school_id", decoded["uid"])
        except Exception as exc:
            logger.warning("WS rejected: token verification failed: %s", exc)
            await websocket.close(code=4001, reason="Invalid or expired token")
            return
    elif ENV == "development":
        # Allow unauthenticated WS connections in development for local testing
        school_id = DEV_SCHOOL_ID
    else:
        logger.warning("WS rejected: no token provided")
        await websocket.close(code=4001, reason="Authentication required")
        return
    registry.add(school_id, websocket)
    logger.info("WS connected: school=%s", school_id)

    async def _ping_loop():
        """Send periodic pings to prevent Cloud Run from timing out the connection."""
        try:
            while True:
                await asyncio.sleep(30)
                await websocket.send_text('{"type":"ping"}')
        except Exception:
            pass  # Connection closed — loop exits naturally

    ping_task = asyncio.create_task(_ping_loop())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ping_task.cancel()
        registry.remove(school_id, websocket)
        logger.info("WS disconnected: school=%s", school_id)


# ---------------------------------------------------------------------------
# Queue Manager (in-memory, per-school)
# ---------------------------------------------------------------------------
class QueueManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._queues: Dict[str, List[dict]] = {}

    def add_event(self, school_id: str, event: dict):
        with self._lock:
            self._queues.setdefault(school_id, []).append(event)

    def get_sorted_queue(self, school_id: str) -> List[dict]:
        with self._lock:
            return sorted(
                self._queues.get(school_id, []),
                key=lambda x: x["timestamp"],
            )

    def remove_event(self, school_id: str, plate_token: str):
        with self._lock:
            queue = self._queues.get(school_id, [])
            self._queues[school_id] = [e for e in queue if e["plate_token"] != plate_token]

    def clear(self, school_id: str):
        with self._lock:
            self._queues[school_id] = []

    def get_event(self, school_id: str, plate_token: str):
        """Return a single event by plate_token (or None)."""
        with self._lock:
            queue = self._queues.get(school_id, [])
            return next((e for e in queue if e["plate_token"] == plate_token), None)

    def get_all_events(self, school_id: str) -> List[dict]:
        """Return a snapshot of all events for a school."""
        with self._lock:
            return list(self._queues.get(school_id, []))


queue_manager = QueueManager()


# ---------------------------------------------------------------------------
# Daily scan archival — moves previous-day scans to scan_history, keeps 1 year
# ---------------------------------------------------------------------------
def _archive_previous_day_scans():
    """Move plate_scans from previous days into scan_history collection.

    Only scans whose timestamp is strictly before today (in device timezone)
    are archived.  Scans older than 365 days are purged from scan_history.
    """
    tz = ZoneInfo(DEVICE_TIMEZONE)
    today_start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)

    # ── 1. Archive old plate_scans ──────────────────────────────────────────
    old_scans = list(
        db.collection("plate_scans")
        .where(field_path="timestamp", op_string="<", value=today_start)
        .stream()
    )

    if old_scans:
        CHUNK = 250  # each doc = 1 set + 1 delete = 2 ops; Firestore limit is 500
        for i in range(0, len(old_scans), CHUNK):
            batch = db.batch()
            for doc in old_scans[i: i + CHUNK]:
                data = doc.to_dict()
                data["archived_at"] = datetime.now(tz)
                data["original_firestore_id"] = doc.id
                batch.set(db.collection("scan_history").document(), data)
                batch.delete(doc.reference)
            batch.commit()
        logger.info("Archived %d scan(s) from plate_scans to scan_history", len(old_scans))

    # ── 2. Purge scan_history older than 1 year ─────────────────────────────
    cutoff = today_start.replace(year=today_start.year - 1)
    expired = list(
        db.collection("scan_history")
        .where(field_path="timestamp", op_string="<", value=cutoff)
        .stream()
    )
    if expired:
        refs = [doc.reference for doc in expired]
        _firestore_batch_delete(refs)
        logger.info("Purged %d expired scan_history record(s) older than 1 year", len(refs))


async def _archival_loop():
    """Background loop — runs archival on startup then every hour."""
    while True:
        try:
            await asyncio.to_thread(_archive_previous_day_scans)
        except Exception as exc:
            logger.error("Scan archival error: %s", exc)
        await asyncio.sleep(3600)  # check every hour


@app.on_event("startup")
async def _start_archival_task():
    asyncio.create_task(_archival_loop())


@app.on_event("shutdown")
async def _graceful_shutdown():
    """Close all open WebSocket connections before Cloud Run terminates."""
    logger.info("Shutdown: closing all WebSocket connections...")
    with registry._lock:
        all_sockets = [ws for sockets in registry._rooms.values() for ws in sockets]
    for ws in all_sockets:
        try:
            await ws.close(code=1001, reason="Server shutting down")
        except Exception:
            pass
    logger.info("Shutdown: closed %d WebSocket connection(s)", len(all_sockets))


# ---------------------------------------------------------------------------
# Pickup tracking helpers
# ---------------------------------------------------------------------------
def _mark_picked_up(firestore_id: str, pickup_method: str, dismissed_by_uid: str):
    """Update a plate_scans doc with pickup timestamp and method."""
    tz = ZoneInfo(DEVICE_TIMEZONE)
    db.collection("plate_scans").document(firestore_id).update({
        "picked_up_at": datetime.now(tz),
        "pickup_method": pickup_method,
        "dismissed_by_uid": dismissed_by_uid,
    })


def _mark_bulk_picked_up(firestore_ids: list, pickup_method: str, dismissed_by_uid: str):
    """Batch-update multiple plate_scans docs with pickup info."""
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    CHUNK = 500  # Firestore batch limit
    for i in range(0, len(firestore_ids), CHUNK):
        batch = db.batch()
        for fid in firestore_ids[i: i + CHUNK]:
            ref = db.collection("plate_scans").document(fid)
            batch.update(ref, {
                "picked_up_at": now,
                "pickup_method": pickup_method,
                "dismissed_by_uid": dismissed_by_uid,
            })
        batch.commit()


def _get_active_firestore_ids(school_id: str) -> list:
    """Return Firestore document IDs for all active (not picked up) scans."""
    scans = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )
    return [scan.id for scan in scans if not scan.to_dict().get("picked_up_at")]


def _find_firestore_ids_by_plate_token(school_id: str, plate_token: str) -> list:
    """Look up all active Firestore doc IDs for a plate_token."""
    scans = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .stream()
    )
    return [scan.id for scan in scans if not scan.to_dict().get("picked_up_at")]

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class PlateScan(BaseModel):
    plate: str
    timestamp: datetime
    location: Optional[str] = None
    confidence_score: Optional[float] = None

    @field_validator("plate")
    @classmethod
    def plate_uppercase(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("confidence_score")
    @classmethod
    def confidence_range(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("confidence_score must be between 0 and 1")
        return v


class PlateImportRecord(BaseModel):
    guardian_id: str
    guardian_name: str
    student_id: str
    student_name: str
    plate_number: str
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None


class VehicleUpdate(BaseModel):
    plate_number: Optional[str] = None
    vehicle_details: Optional[dict] = None


class InviteUserRequest(BaseModel):
    email: str
    display_name: str = ""
    role: str = "staff"

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("school_admin", "staff"):
            raise ValueError("role must be 'school_admin' or 'staff'")
        return v


class UpdateRoleRequest(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("school_admin", "staff"):
            raise ValueError("role must be 'school_admin' or 'staff'")
        return v


class UpdateStatusRequest(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in ("active", "disabled"):
            raise ValueError("status must be 'active' or 'disabled'")
        return v


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if len(v) < 1:
                raise ValueError("Display name cannot be empty")
            if len(v) > 100:
                raise ValueError("Display name must be 100 characters or fewer")
        return v


class UpdatePermissionsRequest(BaseModel):
    staff: Dict[str, bool]
    school_admin: Dict[str, bool]


# ---------------------------------------------------------------------------
# Granular permissions — defaults & helpers
# ---------------------------------------------------------------------------
ALL_PERMISSION_KEYS = [
    "dashboard",
    "history",
    "reports",
    "registry",
    "registry_edit",
    "users",
    "data_import",
]

DEFAULT_PERMISSIONS = {
    "school_admin": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": True,
        "users": True,
        "data_import": True,
    },
    "staff": {
        "dashboard": True,
        "history": True,
        "reports": True,
        "registry": True,
        "registry_edit": False,
        "users": False,
        "data_import": False,
    },
}


def _get_school_permissions(school_id: str) -> dict:
    """Fetch the permission config for a school, falling back to defaults."""
    try:
        doc = db.collection("school_permissions").document(school_id).get()
        if doc.exists:
            data = doc.to_dict()
            # Merge with defaults so new keys are always present
            result = {}
            for role in ("school_admin", "staff"):
                saved = data.get(role, {})
                merged = dict(DEFAULT_PERMISSIONS[role])
                merged.update({k: v for k, v in saved.items() if k in ALL_PERMISSION_KEYS})
                result[role] = merged
            return result
    except Exception as exc:
        logger.warning("Failed to load school permissions school=%s: %s", school_id, exc)
    return dict(DEFAULT_PERMISSIONS)


def _get_user_permissions(role: str, school_id: str) -> dict:
    """Return the effective permissions for a user based on role and school config."""
    if role == "super_admin":
        return {k: True for k in ALL_PERMISSION_KEYS}
    school_perms = _get_school_permissions(school_id)
    return school_perms.get(role, DEFAULT_PERMISSIONS.get(role, {}))


class VehicleEntry(BaseModel):
    plate_number: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None


class AuthorizedGuardianEntry(BaseModel):
    name: str
    photo_url: Optional[str] = None
    plate_number: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None


class BlockedGuardianEntry(BaseModel):
    name: str
    photo_url: Optional[str] = None
    plate_number: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    reason: Optional[str] = None


class PlateUpdateRequest(BaseModel):
    plate_number: Optional[str] = None
    guardian_name: Optional[str] = None
    student_names: Optional[List[str]] = None
    linked_student_ids: Optional[List[str]] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
    vehicles: Optional[List[VehicleEntry]] = None
    guardian_photo_url: Optional[str] = None
    student_photo_urls: Optional[List[Optional[str]]] = None
    authorized_guardians: Optional[List[AuthorizedGuardianEntry]] = None
    blocked_guardians: Optional[List[BlockedGuardianEntry]] = None


# ---------------------------------------------------------------------------
# Benefactor (guardian / parent) models
# ---------------------------------------------------------------------------
class GuardianProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    phone: Optional[str] = None
    photo_url: Optional[str] = None


class AddChildRequest(BaseModel):
    first_name: str
    last_name: str
    school_id: str
    grade: Optional[str] = None
    photo_url: Optional[str] = None

    @field_validator("first_name", "last_name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v

    @field_validator("school_id")
    @classmethod
    def school_id_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School must be selected")
        return v


class UpdateChildRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    grade: Optional[str] = None
    photo_url: Optional[str] = None


class AddVehicleRequest(BaseModel):
    plate_number: str
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None

    @field_validator("plate_number")
    @classmethod
    def plate_uppercase(cls, v: str) -> str:
        v = v.upper().strip()
        if not v:
            raise ValueError("Plate number cannot be blank")
        return v


class UpdateVehicleRequest(BaseModel):
    plate_number: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    color: Optional[str] = None
    year: Optional[str] = None
    photo_url: Optional[str] = None
    student_ids: Optional[List[str]] = None


class AddAuthorizedPickupRequest(BaseModel):
    name: str
    phone: Optional[str] = None
    relationship: Optional[str] = None

    @field_validator("name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class AdminLinkStudentRequest(BaseModel):
    guardian_email: str

    @field_validator("guardian_email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v


class AssignSchoolRequest(BaseModel):
    school_id: str

    @field_validator("school_id")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School ID cannot be blank")
        return v


class GuardianSignupRequest(BaseModel):
    email: str
    password: str
    display_name: str

    @field_validator("email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email address")
        return v

    @field_validator("password")
    @classmethod
    def password_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v

    @field_validator("display_name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class CreateSchoolRequest(BaseModel):
    name: str
    admin_email: str = ""
    timezone: str = "America/New_York"

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("School name cannot be empty")
        return v


class UpdateSchoolRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    admin_email: Optional[str] = None
    timezone: Optional[str] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v is not None and v not in ("active", "suspended"):
            raise ValueError("status must be 'active' or 'suspended'")
        return v


# ---------------------------------------------------------------------------
# Authentication helpers
# ---------------------------------------------------------------------------
def verify_firebase_token(request: Request) -> dict:
    """
    Verify the Firebase ID token and enrich with role/status from Firestore.

    Role resolution (Firestore always wins over stale JWT claims):
      • super_admin claim → cross-school access; X-School-Id header sets context.
      • school_admins/{uid} exists → use its role/status (real-time revocation).
      • No record (legacy user) → default to school_admin so they aren't locked out.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        # In development, fall back to a hardcoded dev user when no token is
        # provided (convenient for local API testing without Firebase Auth).
        if ENV == "development":
            logger.info("No Bearer token — using dev fallback user")
            dev_role = request.headers.get("X-Dev-Role", "").strip().lower()
            if dev_role == "guardian":
                return {
                    "uid": "dev_guardian",
                    "email": "guardian@dismissal.local",
                    "display_name": "Dev Guardian",
                    "role": "guardian",
                    "status": "active",
                }
            return {
                "uid": "dev_user",
                "school_id": DEV_SCHOOL_ID,
                "email": "dev@dismissal.local",
                "role": "school_admin",
                "display_name": "Dev Admin",
                "status": "active",
            }
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    id_token = auth_header.split("Bearer ", 1)[1]
    try:
        decoded = fb_auth.verify_id_token(id_token)
    except Exception as exc:
        logger.warning("Firebase token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    uid = decoded.get("uid")
    logger.info("Token verified: uid=%s email=%s", uid, decoded.get("email"))

    # ── Always check Firestore first — it is the single source of truth ──────
    # This means super_admin status can be granted purely by creating/updating
    # a school_admins/{uid} document in the Firebase Console — no custom claims
    # or bootstrap scripts required.
    try:
        admin_doc = db.collection("school_admins").document(uid).get()
    except Exception as exc:
        logger.warning("Firestore lookup failed uid=%s: %s", uid, exc)
        admin_doc = None

    firestore_role = None
    if admin_doc and admin_doc.exists:
        admin_data = admin_doc.to_dict()
        if admin_data.get("status") == "disabled":
            raise HTTPException(status_code=403, detail="Account is disabled")
        firestore_role = admin_data.get("role")

    # ── Super-admin path ─────────────────────────────────────────────────────
    # Only Firestore is the source of truth for super_admin role.
    # JWT custom claims are NOT trusted for role escalation — a compromised
    # Firebase Auth token with super_admin=True in claims will be ignored.
    if decoded.get("super_admin"):
        logger.warning("Ignoring deprecated super_admin JWT claim for uid=%s; use Firestore role", uid)
    is_super = (firestore_role == "super_admin")
    if is_super:
        if admin_doc and admin_doc.exists:
            admin_data = admin_doc.to_dict()
            decoded["display_name"] = admin_data.get("display_name", decoded.get("name", ""))
            decoded["status"] = admin_data.get("status", "active")

        # X-School-Id lets a super_admin act on behalf of a specific school
        school_header = request.headers.get("X-School-Id", "").strip()
        decoded["role"] = "super_admin"
        decoded["school_id"] = school_header or None
        decoded.setdefault("display_name", decoded.get("name", ""))
        decoded.setdefault("status", "active")
        return decoded

    # ── Regular school_admin / staff path ───────────────────────────────────
    if admin_doc and admin_doc.exists:
        admin_data = admin_doc.to_dict()
        decoded["role"] = admin_data.get("role", decoded.get("role", "school_admin"))
        decoded["school_id"] = (
            admin_data.get("school_id") or decoded.get("school_id") or uid
        )
        decoded["display_name"] = admin_data.get("display_name", "")
        decoded["status"] = admin_data.get("status", "active")
        return decoded

    # ── Guardian path — user has no school_admins doc ──────────────────────
    # Any Firebase Auth user who isn't staff/admin is treated as a guardian.
    # Auto-create a guardians doc on first login.
    try:
        guardian_doc = db.collection("guardians").document(uid).get()
    except Exception as exc:
        logger.warning("Firestore guardians lookup failed uid=%s: %s", uid, exc)
        guardian_doc = None

    if not (guardian_doc and guardian_doc.exists):
        # First-time guardian — create profile from Firebase Auth data.
        # `assigned_school_ids` is initialized to an empty list so the
        # guardian is discoverable via the admin "pending assignment" list.
        email_value = decoded.get("email", "") or ""
        profile = {
            "display_name": decoded.get("name", email_value),
            "email": email_value,
            "email_lower": email_value.lower(),
            "phone": decoded.get("phone_number"),
            "photo_url": decoded.get("picture"),
            "assigned_school_ids": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            db.collection("guardians").document(uid).set(profile)
            logger.info("Auto-created guardian profile uid=%s", uid)
        except Exception as exc:
            logger.error("Failed to create guardian profile uid=%s: %s", uid, exc)
        guardian_data = profile
    else:
        guardian_data = guardian_doc.to_dict()

    decoded["role"] = "guardian"
    decoded["display_name"] = guardian_data.get("display_name", "")
    decoded["email"] = guardian_data.get("email", decoded.get("email", ""))
    decoded["phone"] = guardian_data.get("phone")
    decoded["photo_url"] = guardian_data.get("photo_url")
    decoded["status"] = "active"
    return decoded


def require_school_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """
    Dependency that allows school_admin and super_admin (with school context).
    Super admins must supply X-School-Id to operate on a specific school.
    """
    role = user_data.get("role")
    if role == "super_admin":
        if not user_data.get("school_id"):
            raise HTTPException(
                status_code=400,
                detail="X-School-Id header required when performing school-scoped operations as super_admin",
            )
        return user_data
    if role != "school_admin":
        raise HTTPException(status_code=403, detail="School admin role required")
    return user_data


def require_super_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Dependency that only allows super_admin users."""
    if user_data.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin role required")
    return user_data


def require_guardian(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Dependency that only allows guardian (parent/benefactor) users."""
    if user_data.get("role") != "guardian":
        raise HTTPException(status_code=403, detail="Guardian role required")
    return user_data


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def generate_hash(plate: str, timestamp: datetime) -> str:
    message = f"{plate}{timestamp.isoformat()}".encode()
    return hmac.new(SECRET_KEY, message, hashlib.sha256).hexdigest()


def _format_timestamp(ts) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, str):
        return ts
    return ts.isoformat()


def _localise(ts: datetime) -> datetime:
    tz = ZoneInfo(DEVICE_TIMEZONE)
    if ts.tzinfo is None:
        return ts.replace(tzinfo=tz)
    return ts.astimezone(tz)


def _decrypt_students(plate_info: dict):
    if "student_names_encrypted" in plate_info:
        enc = plate_info["student_names_encrypted"]
        if isinstance(enc, list):
            return [safe_decrypt(s, default="") for s in enc], enc
        return safe_decrypt(enc, default=""), enc
    enc = plate_info.get("student_name")
    if enc:
        return safe_decrypt(enc, default=""), enc
    return None, None


def _firestore_batch_delete(refs: list):
    CHUNK = 500
    for i in range(0, len(refs), CHUNK):
        batch = db.batch()
        for ref in refs[i: i + CHUNK]:
            batch.delete(ref)
        batch.commit()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/v1/system/health")
def system_health():
    # Verify Firestore is reachable — if this fails, Cloud Run will restart
    try:
        db.collection("plate_scans").limit(1).get()
        firestore_ok = True
    except Exception as exc:
        logger.error("Health check: Firestore unreachable: %s", exc)
        firestore_ok = False

    payload = {
        "status": "healthy" if firestore_ok else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "env": ENV,
        "firestore": "ok" if firestore_ok else "error",
    }
    if not firestore_ok:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.post("/api/v1/scan")
async def scan_plate(
    scan: PlateScan,
    request: Request,
    user_data: dict = Depends(verify_firebase_token),
):
    school_id = user_data.get("school_id") or user_data.get("uid")
    local_timestamp = _localise(scan.timestamp)
    plate_token = tokenize_plate(scan.plate)
    event_hash = generate_hash(scan.plate, local_timestamp)

    # Shared fields for every event regardless of status
    base_event = {
        "plate_token": plate_token,
        "plate_display": scan.plate.upper().strip(),
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "school_id": school_id,
    }

    event = None
    enc_plate_number = None
    encrypted_parent = None
    encrypted_students = None

    # ── 1. Try new vehicle-centric model ─────────────────────────────────
    vehicle_docs = list(
        db.collection("vehicles")
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .limit(1)
        .stream()
    )

    if vehicle_docs:
        vdata = vehicle_docs[0].to_dict()
        if school_id not in vdata.get("school_ids", []):
            raise HTTPException(status_code=403, detail="Vehicle not registered at this school")

        guardian_uid = vdata.get("guardian_uid")
        gdoc = db.collection("guardians").document(guardian_uid).get() if guardian_uid else None
        gdata = gdoc.to_dict() if gdoc and gdoc.exists else {}

        students_decrypted = []
        student_photos = []
        student_names_enc = []
        for sid in vdata.get("student_ids", []):
            sdoc = db.collection("students").document(sid).get()
            if sdoc.exists:
                sd = sdoc.to_dict()
                first = safe_decrypt(sd.get("first_name_encrypted"), default="")
                last = safe_decrypt(sd.get("last_name_encrypted"), default="")
                students_decrypted.append(f"{first} {last}".strip())
                student_photos.append(sd.get("photo_url"))
                student_names_enc.append(sd.get("first_name_encrypted", ""))

        plate_display = safe_decrypt(vdata.get("plate_number_encrypted"), default=scan.plate) or scan.plate
        guardian_name = gdata.get("display_name", "")
        guardian_photo = gdata.get("photo_url")
        encrypted_parent = encrypt_string(guardian_name) if guardian_name else None
        encrypted_students = student_names_enc or None
        enc_plate_number = vdata.get("plate_number_encrypted")

        event = {
            **base_event,
            "plate_display": plate_display,
            "student": students_decrypted if len(students_decrypted) != 1 else students_decrypted[0],
            "parent": guardian_name,
            "vehicle_make": vdata.get("make"),
            "vehicle_model": vdata.get("model"),
            "vehicle_color": vdata.get("color"),
            "guardian_photo_url": guardian_photo,
            "student_photo_urls": student_photos,
            "authorization_status": "authorized",
        }

    # ── 2. Legacy fallback: plates collection (primary plate) ────────────
    if not event:
        plate_doc = db.collection("plates").document(plate_token).get()
        if plate_doc.exists:
            plate_info = plate_doc.to_dict()

            if plate_info.get("school_id") and plate_info["school_id"] != school_id:
                raise HTTPException(status_code=403, detail="Plate not registered to this school")

            decrypted_students, encrypted_students = _decrypt_students(plate_info)
            encrypted_parent = plate_info.get("parent")
            guardian_name = safe_decrypt(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")
            plate_display = safe_decrypt(enc_plate_number) if enc_plate_number else None

            auth_guardians = []
            for ag in plate_info.get("authorized_guardians") or []:
                ag_name = safe_decrypt(ag.get("name_encrypted"), default="")
                auth_guardians.append({"name": ag_name, "photo_url": ag.get("photo_url")})

            event = {
                **base_event,
                "plate_display": plate_display,
                "student": decrypted_students,
                "parent": guardian_name,
                "vehicle_make": plate_info.get("vehicle_make"),
                "vehicle_model": plate_info.get("vehicle_model"),
                "vehicle_color": plate_info.get("vehicle_color"),
                "guardian_photo_url": plate_info.get("guardian_photo_url"),
                "student_photo_urls": plate_info.get("student_photo_urls") or [],
                "authorized_guardians": auth_guardians,
                "authorization_status": "authorized",
            }

    # ── 3. Check authorized guardian plates ───────────────────────────────
    if not event:
        auth_hits = list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=school_id)
            .where(field_path="authorized_plate_tokens", op_string="array_contains", value=plate_token)
            .limit(1)
            .stream()
        )
        if auth_hits:
            plate_info = auth_hits[0].to_dict()
            decrypted_students, encrypted_students = _decrypt_students(plate_info)
            encrypted_parent = plate_info.get("parent")
            primary_guardian = safe_decrypt(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")

            # Find which authorized guardian's plate matched
            arriving_guardian = None
            arriving_vehicle = {}
            for ag in plate_info.get("authorized_guardians") or []:
                if ag.get("plate_token") == plate_token:
                    arriving_guardian = safe_decrypt(ag.get("name_encrypted"), default="")
                    ag_plate_enc = ag.get("plate_number_encrypted")
                    arriving_vehicle = {
                        "vehicle_make": ag.get("vehicle_make"),
                        "vehicle_model": ag.get("vehicle_model"),
                        "vehicle_color": ag.get("vehicle_color"),
                    }
                    enc_plate_number = ag_plate_enc
                    break

            event = {
                **base_event,
                "plate_display": (safe_decrypt(enc_plate_number) if enc_plate_number else None) or scan.plate.upper(),
                "student": decrypted_students,
                "parent": arriving_guardian or "Authorized Guardian",
                "primary_guardian": primary_guardian,
                "vehicle_make": arriving_vehicle.get("vehicle_make"),
                "vehicle_model": arriving_vehicle.get("vehicle_model"),
                "vehicle_color": arriving_vehicle.get("vehicle_color"),
                "guardian_photo_url": None,
                "student_photo_urls": plate_info.get("student_photo_urls") or [],
                "authorization_status": "authorized_guardian",
            }

    # ── 4. Check blocked guardian plates ──────────────────────────────────
    if not event:
        blocked_hits = list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=school_id)
            .where(field_path="blocked_plate_tokens", op_string="array_contains", value=plate_token)
            .limit(1)
            .stream()
        )
        if blocked_hits:
            plate_info = blocked_hits[0].to_dict()
            decrypted_students, encrypted_students = _decrypt_students(plate_info)
            encrypted_parent = plate_info.get("parent")
            primary_guardian = safe_decrypt(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")

            # Find which blocked guardian's plate matched
            blocked_name = None
            blocked_reason = None
            blocked_vehicle = {}
            for bg in plate_info.get("blocked_guardians") or []:
                if bg.get("plate_token") == plate_token:
                    blocked_name = safe_decrypt(bg.get("name_encrypted"), default="")
                    blocked_reason = bg.get("reason")
                    blocked_vehicle = {
                        "vehicle_make": bg.get("vehicle_make"),
                        "vehicle_model": bg.get("vehicle_model"),
                        "vehicle_color": bg.get("vehicle_color"),
                    }
                    bg_plate_enc = bg.get("plate_number_encrypted")
                    enc_plate_number = bg_plate_enc
                    break

            event = {
                **base_event,
                "plate_display": (safe_decrypt(enc_plate_number) if enc_plate_number else None) or scan.plate.upper(),
                "student": decrypted_students,
                "parent": blocked_name or "Blocked Person",
                "primary_guardian": primary_guardian,
                "vehicle_make": blocked_vehicle.get("vehicle_make"),
                "vehicle_model": blocked_vehicle.get("vehicle_model"),
                "vehicle_color": blocked_vehicle.get("vehicle_color"),
                "guardian_photo_url": None,
                "student_photo_urls": [],
                "authorization_status": "unauthorized",
                "blocked_reason": blocked_reason,
            }

    # ── 5. Unregistered vehicle — still queue it for admin awareness ─────
    if not event:
        enc_plate_number = encrypt_string(scan.plate.upper().strip())
        event = {
            **base_event,
            "student": None,
            "parent": None,
            "vehicle_make": None,
            "vehicle_model": None,
            "vehicle_color": None,
            "guardian_photo_url": None,
            "student_photo_urls": [],
            "authorization_status": "unregistered",
        }
        encrypted_parent = None
        encrypted_students = None

    queue_manager.add_event(school_id, event)

    # Ensure encrypted plate is always persisted so dashboard can display it.
    if enc_plate_number is None:
        enc_plate_number = encrypt_string(scan.plate.upper().strip())

    firestore_doc = {
        "plate_token": plate_token,
        "plate_number_encrypted": enc_plate_number,
        "student_names_encrypted": encrypted_students,
        "parent_name_encrypted": encrypted_parent,
        "timestamp": local_timestamp,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "hash": event_hash,
        "school_id": school_id,
        "vehicle_make": event.get("vehicle_make"),
        "vehicle_model": event.get("vehicle_model"),
        "vehicle_color": event.get("vehicle_color"),
        "guardian_photo_url": event.get("guardian_photo_url"),
        "student_photo_urls": event.get("student_photo_urls") or [],
        "authorized_guardians": event.get("authorized_guardians") or [],
        "authorization_status": event.get("authorization_status", "authorized"),
        "primary_guardian": event.get("primary_guardian"),
        "blocked_reason": event.get("blocked_reason"),
        "picked_up_at": None,
        "pickup_method": None,
    }
    doc_ref = db.collection("plate_scans").add(firestore_doc)
    firestore_id = doc_ref[1].id
    event["firestore_id"] = firestore_id

    logger.info("Scan recorded: plate_token=%s status=%s school=%s", plate_token, event.get("authorization_status"), school_id)
    await registry.broadcast(school_id, {"type": "scan", "data": event})

    return {"status": "success", "firestore_id": firestore_id}


@app.get("/api/v1/dashboard")
def get_dashboard(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")

    scans_query = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .order_by("timestamp", direction=firestore.Query.ASCENDING)
        .stream()
    )

    results = []
    for scan in scans_query:
        data = scan.to_dict()

        # Skip scans that have already been picked up
        if data.get("picked_up_at"):
            continue

        # Tolerate corrupt / key-mismatched records so a single bad row
        # doesn't take down the whole dashboard.
        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        if enc_students:
            if isinstance(enc_students, list):
                students = [safe_decrypt(s, default="") for s in enc_students]
            else:
                students = safe_decrypt(enc_students, default="")
        else:
            students = None

        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = safe_decrypt(enc_parent) if enc_parent else None

        enc_plate = data.get("plate_number_encrypted")
        plate_display = safe_decrypt(enc_plate) if enc_plate else None

        # Fallback: look up plate from vehicle/plate registrations if missing
        if not plate_display and data.get("plate_token"):
            _pt = data["plate_token"]
            _vdocs = list(db.collection("vehicles").where(field_path="plate_token", op_string="==", value=_pt).limit(1).stream())
            if _vdocs:
                _enc = _vdocs[0].to_dict().get("plate_number_encrypted")
                plate_display = safe_decrypt(_enc) if _enc else None
            if not plate_display:
                _pdoc = db.collection("plates").document(_pt).get()
                if _pdoc.exists:
                    _enc = _pdoc.to_dict().get("plate_number_encrypted")
                    plate_display = safe_decrypt(_enc) if _enc else None

        results.append({
            "firestore_id": scan.id,
            "plate_token": data.get("plate_token"),
            "plate_display": plate_display,
            "student": students,
            "parent": parent,
            "timestamp": _format_timestamp(data.get("timestamp")),
            "location": data.get("location"),
            "confidence_score": data.get("confidence_score"),
            "hash": data.get("hash"),
            "vehicle_make": data.get("vehicle_make"),
            "vehicle_model": data.get("vehicle_model"),
            "vehicle_color": data.get("vehicle_color"),
            "guardian_photo_url": data.get("guardian_photo_url"),
            "student_photo_urls": data.get("student_photo_urls") or [],
            "authorized_guardians": data.get("authorized_guardians") or [],
            "authorization_status": data.get("authorization_status", "authorized"),
            "primary_guardian": data.get("primary_guardian"),
            "blocked_reason": data.get("blocked_reason"),
        })

    logger.info("Dashboard fetch: %d records for school=%s", len(results), school_id)
    return JSONResponse(
        content={"queue": results},
        headers={"Cache-Control": "no-store"},
    )


@app.delete("/api/v1/plate/{plate}")
def remove_plate_from_queue(plate: str, user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    plate_token = tokenize_plate(plate.upper().strip())
    queue_manager.remove_event(school_id, plate_token)
    return {"status": "removed", "plate_token": plate_token}


@app.delete("/api/v1/queue/{plate_token}")
async def dismiss_from_queue(
    plate_token: str,
    pickup_method: str = Query(default="manual"),
    user_data: dict = Depends(verify_firebase_token),
):
    """Dismiss a single entry from the live queue by its plate token."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    # Collect firestore IDs from all in-memory events before removing them
    all_events = queue_manager.get_all_events(school_id)
    firestore_ids = [
        e["firestore_id"] for e in all_events
        if e["plate_token"] == plate_token and e.get("firestore_id")
    ]
    queue_manager.remove_event(school_id, plate_token)

    # Also pick up any Firestore docs not tracked in memory (e.g. after server restart)
    try:
        db_ids = await asyncio.to_thread(
            _find_firestore_ids_by_plate_token, school_id, plate_token
        )
        for fid in db_ids:
            if fid not in firestore_ids:
                firestore_ids.append(fid)
    except Exception as exc:
        logger.warning("Firestore lookup for plate_token=%s failed: %s", plate_token, exc)

    if firestore_ids:
        try:
            await asyncio.to_thread(
                _mark_bulk_picked_up, firestore_ids, pickup_method, user_data.get("uid")
            )
        except Exception as exc:
            logger.warning("Failed to mark pickup in Firestore: %s", exc)

    await registry.broadcast(school_id, {"type": "dismiss", "plate_token": plate_token})
    logger.info("Dismissed plate_token=%s method=%s school=%s", plate_token, pickup_method, school_id)
    return {"status": "dismissed", "plate_token": plate_token, "pickup_method": pickup_method}


@app.post("/api/v1/queue/bulk-pickup")
async def bulk_pickup(user_data: dict = Depends(verify_firebase_token)):
    """Mark every entry currently in the queue as picked up at once."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    events = queue_manager.get_all_events(school_id)

    # Always query Firestore for active (non-picked-up) scans so that entries
    # survive server restarts or instance changes where the in-memory queue is lost.
    firestore_ids = await asyncio.to_thread(_get_active_firestore_ids, school_id)

    if not events and not firestore_ids:
        return {"status": "success", "count": 0}

    if firestore_ids:
        try:
            await asyncio.to_thread(
                _mark_bulk_picked_up, firestore_ids, "manual_bulk", user_data.get("uid")
            )
        except Exception as exc:
            logger.warning("Failed to batch-mark pickups in Firestore: %s", exc)

    plate_tokens = [e["plate_token"] for e in events]
    queue_manager.clear(school_id)

    await registry.broadcast(school_id, {"type": "bulk_dismiss", "plate_tokens": plate_tokens})
    count = max(len(events), len(firestore_ids))
    logger.info("Bulk pickup: %d entries for school=%s", count, school_id)
    return {"status": "success", "count": count}


@app.post("/api/v1/admin/import-plates")
async def import_plates(
    records: List[PlateImportRecord],
    user_data: dict = Depends(require_school_admin),
):

    school_id = user_data.get("school_id") or user_data.get("uid")

    plate_groups: dict[str, dict] = {}
    for rec in records:
        plate_key = rec.plate_number.upper().strip()
        if plate_key not in plate_groups:
            plate_groups[plate_key] = {
                "guardian_id": rec.guardian_id,
                "guardian_name": rec.guardian_name,
                "student_names": [],
                "vehicle_make": rec.vehicle_make,
                "vehicle_model": rec.vehicle_model,
                "vehicle_color": rec.vehicle_color,
            }
        plate_groups[plate_key]["student_names"].append(rec.student_name)

    batch = db.batch()
    count = 0
    for plate_number, info in plate_groups.items():
        plate_token = tokenize_plate(plate_number)
        doc_ref = db.collection("plates").document(plate_token)

        student_names = info["student_names"]
        enc_students = (
            [encrypt_string(n) for n in student_names]
            if len(student_names) > 1
            else encrypt_string(student_names[0])
        )

        doc_data = {
            "student_names_encrypted": enc_students,
            "parent": encrypt_string(info["guardian_name"]),
            "guardian_id_encrypted": encrypt_string(info["guardian_id"]),
            "plate_number_encrypted": encrypt_string(plate_number),
            "school_id": school_id,
            "vehicle_make": info.get("vehicle_make"),
            "vehicle_model": info.get("vehicle_model"),
            "vehicle_color": info.get("vehicle_color"),
            "imported_at": datetime.now(timezone.utc).isoformat(),
        }
        batch.set(doc_ref, doc_data, merge=True)
        count += 1

        if count % 500 == 0:
            await asyncio.to_thread(batch.commit)
            batch = db.batch()

    if count % 500 != 0:
        await asyncio.to_thread(batch.commit)

    logger.info("Imported %d plate records for school=%s", count, school_id)
    return {"status": "imported", "plate_count": count}


@app.post("/api/v1/auth/logout")
def logout(user_data: dict = Depends(verify_firebase_token)):
    return {"status": "logged out", "user": user_data["uid"]}


@app.get("/api/v1/history")
def get_history(
    response: Response,
    user_data: dict = Depends(verify_firebase_token),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=500, ge=1, le=500),
):
    """Return scan history (newest first) with optional date-range and name search filters."""
    response.headers["Cache-Control"] = "no-store"

    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)

    start_dt = None
    end_dt = None
    if start_date:
        try:
            start_dt = datetime.fromisoformat(start_date).replace(
                hour=0, minute=0, second=0, microsecond=0, tzinfo=tz
            )
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start_date — use YYYY-MM-DD")
    if end_date:
        try:
            end_dt = datetime.fromisoformat(end_date).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=tz
            )
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end_date — use YYYY-MM-DD")

    def _build_query(collection_name):
        query = db.collection(collection_name).where(
            field_path="school_id", op_string="==", value=school_id
        )
        if start_dt:
            query = query.where(field_path="timestamp", op_string=">=", value=start_dt)
        if end_dt:
            query = query.where(field_path="timestamp", op_string="<=", value=end_dt)
        return query

    # Primary source: current-day scans
    try:
        all_docs = list(_build_query("plate_scans").stream())
    except Exception as exc:
        logger.error("plate_scans query failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to query scan history. The required Firestore index may not be deployed yet.",
        )

    # Secondary source: archived scans (tolerate failure — index may not exist yet)
    try:
        all_docs.extend(_build_query("scan_history").stream())
    except Exception as exc:
        logger.warning("scan_history query failed (index may be missing): %s", exc)

    results = []
    skipped = 0
    for doc in all_docs:
        try:
            data = doc.to_dict()
        except Exception as exc:
            logger.warning("Skipping unreadable history doc %s: %s", doc.id, exc)
            skipped += 1
            continue

        # Tolerant decryption — if the key has been rotated or a record is
        # corrupt, fall back to an "[unreadable]" placeholder so the row
        # still shows in the UI instead of taking down the endpoint.
        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        if isinstance(enc_students, list):
            students = [safe_decrypt(s, default="[unreadable]") for s in enc_students]
        elif enc_students:
            students = [safe_decrypt(enc_students, default="[unreadable]")]
        else:
            students = []

        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = safe_decrypt(enc_parent, default="[unreadable]") if enc_parent else None

        if search:
            sl = search.strip().lower()
            if sl not in (parent or "").lower() and sl not in ", ".join(students).lower():
                continue

        results.append({
            "id": doc.id,
            "plate_token": data.get("plate_token"),
            "student": students,
            "parent": parent,
            "timestamp": _format_timestamp(data.get("timestamp")),
            "location": data.get("location"),
            "confidence_score": data.get("confidence_score"),
            "pickup_method": data.get("pickup_method"),
            "picked_up_at": _format_timestamp(data.get("picked_up_at")),
        })

    # Sort newest-first in Python (avoids needing a separate DESC composite index)
    results.sort(key=lambda r: r["timestamp"] or "", reverse=True)
    capped = len(results) > limit
    results = results[:limit]

    logger.info(
        "History fetch: %d records (skipped %d) school=%s search=%r",
        len(results), skipped, school_id, search,
    )
    return {"records": results, "total": len(results), "capped": capped}


@app.get("/api/v1/plates")
def list_plates(
    user_data: dict = Depends(verify_firebase_token),
):
    """List all registered plates for the school with decrypted guardian/student names."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    try:
        docs = list(
            db.collection("plates")
            .where(field_path="school_id", op_string="==", value=school_id)
            .stream()
        )
    except Exception as exc:
        logger.error("plates query failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to load registry. Check Firestore permissions and indexes.",
        )

    # Batch-resolve linked student IDs across all plates
    all_linked_ids: set = set()
    docs_data = []
    for doc in docs:
        data = doc.to_dict()
        docs_data.append((doc.id, data))
        for sid in data.get("linked_student_ids") or []:
            all_linked_ids.add(sid)

    def _safe_decrypt(ciphertext):
        """Decrypt, returning None on failure (wrong key, corrupt data)."""
        if not ciphertext:
            return None
        try:
            return decrypt_string(ciphertext)
        except Exception:
            return None

    student_map: dict = {}
    for sid in all_linked_ids:
        sdoc = db.collection("students").document(sid).get()
        if sdoc.exists:
            sdata = sdoc.to_dict()
            first = _safe_decrypt(sdata.get("first_name_encrypted")) or ""
            last = _safe_decrypt(sdata.get("last_name_encrypted")) or ""
            student_map[sid] = {
                "id": sid,
                "first_name": first,
                "last_name": last,
                "photo_url": sdata.get("photo_url"),
            }

    results = []
    for doc_id, data in docs_data:
        try:
            linked_ids = data.get("linked_student_ids") or []

            # If linked students exist, resolve names from student records
            if linked_ids:
                students = []
                for sid in linked_ids:
                    info = student_map.get(sid)
                    if info:
                        students.append(f"{info['first_name']} {info['last_name']}".strip())
                linked_students = [student_map[sid] for sid in linked_ids if sid in student_map]
            else:
                enc_students = data.get("student_names_encrypted")
                students = (
                    [_safe_decrypt(s) or "(encrypted)" for s in enc_students] if isinstance(enc_students, list)
                    else ([_safe_decrypt(enc_students) or "(encrypted)"] if enc_students else [])
                )
                linked_students = []

            enc_parent = data.get("parent")
            parent = _safe_decrypt(enc_parent)

            enc_plate = data.get("plate_number_encrypted")
            plate_display = _safe_decrypt(enc_plate)

            # Decrypt authorized guardians
            auth_guardians = []
            for ag in data.get("authorized_guardians") or []:
                ag_name = _safe_decrypt(ag.get("name_encrypted")) or ""
                ag_plate_enc = ag.get("plate_number_encrypted")
                auth_guardians.append({
                    "name": ag_name,
                    "photo_url": ag.get("photo_url"),
                    "plate_number": _safe_decrypt(ag_plate_enc),
                    "vehicle_make": ag.get("vehicle_make"),
                    "vehicle_model": ag.get("vehicle_model"),
                    "vehicle_color": ag.get("vehicle_color"),
                })

            # Decrypt blocked guardians
            blk_guardians = []
            for bg in data.get("blocked_guardians") or []:
                bg_name = _safe_decrypt(bg.get("name_encrypted")) or ""
                bg_plate_enc = bg.get("plate_number_encrypted")
                blk_guardians.append({
                    "name": bg_name,
                    "photo_url": bg.get("photo_url"),
                    "plate_number": _safe_decrypt(bg_plate_enc),
                    "vehicle_make": bg.get("vehicle_make"),
                    "vehicle_model": bg.get("vehicle_model"),
                    "vehicle_color": bg.get("vehicle_color"),
                    "reason": bg.get("reason"),
                })

            # Decrypt vehicles array
            vehicles = []
            for v in data.get("vehicles") or []:
                v_plate_enc = v.get("plate_number_encrypted")
                vehicles.append({
                    "plate_number": _safe_decrypt(v_plate_enc),
                    "make": v.get("make"),
                    "model": v.get("model"),
                    "color": v.get("color"),
                })
            # Fallback: if no vehicles array, build one from legacy single-vehicle fields
            if not vehicles:
                vehicles.append({
                    "plate_number": plate_display,
                    "make": data.get("vehicle_make"),
                    "model": data.get("vehicle_model"),
                    "color": data.get("vehicle_color"),
                })

            results.append({
                "plate_token": doc_id,
                "plate_display": plate_display,
                "parent": parent,
                "students": students,
                "linked_student_ids": linked_ids,
                "linked_students": linked_students,
                "vehicle_make": data.get("vehicle_make"),
                "vehicle_model": data.get("vehicle_model"),
                "vehicle_color": data.get("vehicle_color"),
                "vehicles": vehicles,
                "imported_at": data.get("imported_at"),
                "guardian_photo_url": data.get("guardian_photo_url"),
                "student_photo_urls": data.get("student_photo_urls") or [],
                "authorized_guardians": auth_guardians,
                "blocked_guardians": blk_guardians,
            })
        except Exception as exc:
            logger.warning("Skipping corrupt plate record %s: %s", doc_id, exc)

    results.sort(key=lambda r: (r["parent"] or "").lower())
    logger.info("Plates list: %d records school=%s", len(results), school_id)
    return {"plates": results, "total": len(results)}


@app.delete("/api/v1/plates/{plate_token}")
async def delete_plate(plate_token: str, user_data: dict = Depends(require_school_admin)):
    """Permanently remove a plate from the registry."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    doc_ref = db.collection("plates").document(plate_token)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Plate not found")

    plate_data = doc.to_dict()
    if plate_data.get("school_id") and plate_data["school_id"] != school_id:
        raise HTTPException(status_code=403, detail="Not authorised to delete this plate")

    await asyncio.to_thread(doc_ref.delete)
    logger.info("Deleted plate_token=%s school=%s", plate_token, school_id)
    return {"status": "deleted", "plate_token": plate_token}


@app.get("/api/v1/reports/summary")
def summary_report(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    today = datetime.now(tz).date()

    # Query both current-day scans and archived history
    scans = []
    for coll in ("plate_scans", "scan_history"):
        scans.extend(
            db.collection(coll)
            .where(field_path="school_id", op_string="==", value=school_id)
            .stream()
        )

    total = len(scans)
    today_count = 0
    hourly_counts = [0] * 24
    confidence_scores: list[float] = []

    for scan in scans:
        data = scan.to_dict()
        ts = data.get("timestamp")
        if ts:
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            elif isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            else:
                ts = None
        if ts:
            if ts.date() == today:
                today_count += 1
            hourly_counts[ts.hour] += 1
        score = data.get("confidence_score")
        if score is not None:
            confidence_scores.append(float(score))

    peak_hour = int(hourly_counts.index(max(hourly_counts))) if total > 0 else None
    avg_confidence = round(sum(confidence_scores) / len(confidence_scores), 3) if confidence_scores else None

    return {
        "total_scans": total,
        "today_count": today_count,
        "peak_hour": peak_hour,
        "hourly_distribution": hourly_counts,
        "avg_confidence": avg_confidence,
    }


@app.get("/api/v1/insights/summary")
def insights_summary(user_data: dict = Depends(verify_firebase_token)):
    """Rich analytics endpoint for the Insights dashboard."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    today = now.date()
    yesterday = today - timedelta(days=1)
    week_ago = today - timedelta(days=7)
    two_weeks_ago = today - timedelta(days=14)

    scans = []
    for coll in ("plate_scans", "scan_history"):
        scans.extend(
            db.collection(coll)
            .where(field_path="school_id", op_string="==", value=school_id)
            .stream()
        )

    total = len(scans)
    today_count = 0
    yesterday_count = 0
    week_count = 0
    hourly_counts = [0] * 24
    confidence_scores: list[float] = []
    confidence_buckets = {"high": 0, "medium": 0, "low": 0}
    date_counts: Dict[str, int] = {}
    today_plates: set = set()

    for scan in scans:
        data = scan.to_dict()
        ts = data.get("timestamp")
        if ts:
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            elif isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            else:
                ts = None

        if ts:
            scan_date = ts.date()
            date_counts[scan_date] = date_counts.get(scan_date, 0) + 1
            hourly_counts[ts.hour] += 1
            if scan_date == today:
                today_count += 1
                pt = data.get("plate_token") or data.get("plate", "")
                if pt:
                    today_plates.add(pt)
            if scan_date == yesterday:
                yesterday_count += 1
            if scan_date >= week_ago:
                week_count += 1

        score = data.get("confidence_score")
        if score is not None:
            s = float(score)
            confidence_scores.append(s)
            if s >= 0.85:
                confidence_buckets["high"] += 1
            elif s >= 0.60:
                confidence_buckets["medium"] += 1
            else:
                confidence_buckets["low"] += 1

    peak_hour = int(hourly_counts.index(max(hourly_counts))) if total > 0 else None
    avg_confidence = round(sum(confidence_scores) / len(confidence_scores), 3) if confidence_scores else None

    distinct_days = max(len(date_counts), 1)
    avg_daily = round(total / distinct_days, 1)

    # Last 14 days
    daily_counts = []
    for i in range(13, -1, -1):
        d = today - timedelta(days=i)
        daily_counts.append({
            "date": d.isoformat(),
            "count": date_counts.get(d, 0),
            "day": d.strftime("%a"),
        })

    # Day-of-week averages (0=Mon … 6=Sun)
    dow_totals = [0] * 7
    dow_days = [0] * 7
    for d, count in date_counts.items():
        dow = d.weekday()
        dow_totals[dow] += count
        dow_days[dow] += 1
    day_of_week_avg = [
        round(dow_totals[i] / dow_days[i], 1) if dow_days[i] > 0 else 0
        for i in range(7)
    ]

    predicted_today = round(day_of_week_avg[today.weekday()])

    prev_week_count = sum(
        c for d, c in date_counts.items() if week_ago > d >= two_weeks_ago
    )
    if prev_week_count == 0:
        scan_trend = "up" if week_count > 0 else "stable"
    elif week_count > prev_week_count * 1.1:
        scan_trend = "up"
    elif week_count < prev_week_count * 0.9:
        scan_trend = "down"
    else:
        scan_trend = "stable"

    return {
        "total_scans": total,
        "today_count": today_count,
        "yesterday_count": yesterday_count,
        "week_count": week_count,
        "avg_daily": avg_daily,
        "peak_hour": peak_hour,
        "hourly_distribution": hourly_counts,
        "avg_confidence": avg_confidence,
        "confidence_buckets": confidence_buckets,
        "daily_counts": daily_counts,
        "day_of_week_avg": day_of_week_avg,
        "predicted_today": predicted_today,
        "unique_plates_today": len(today_plates),
        "scan_trend": scan_trend,
    }


@app.get("/api/v1/system/alerts")
def system_alerts(user_data: dict = Depends(verify_firebase_token)):
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)
    now = datetime.now(tz)
    alerts = []

    queue = queue_manager.get_sorted_queue(school_id)

    # Alert: low scanner confidence in current queue
    scores = [e["confidence_score"] for e in queue if e.get("confidence_score") is not None]
    if scores and (avg_conf := sum(scores) / len(scores)) < 0.60:
        alerts.append({
            "id": "low_confidence",
            "severity": "warning",
            "message": (
                f"Scanner confidence is low — average {avg_conf * 100:.0f}% "
                f"over {len(scores)} scan(s). Check camera alignment."
            ),
        })

    # Alert: large queue
    if len(queue) >= 15:
        alerts.append({
            "id": "high_queue",
            "severity": "warning",
            "message": f"Queue has {len(queue)} vehicles waiting. Consider deploying additional staff.",
        })

    # Alert: stale oldest entry during school hours (7 AM–5 PM)
    if 7 <= now.hour < 17 and queue:
        ts = queue[0].get("timestamp")
        if ts:
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
            if hasattr(ts, "tzinfo"):
                ts = ts.replace(tzinfo=tz) if ts.tzinfo is None else ts.astimezone(tz)
            age_minutes = (now - ts).total_seconds() / 60
            if age_minutes > 30:
                alerts.append({
                    "id": "stale_queue",
                    "severity": "info",
                    "message": f"Oldest entry in queue is {int(age_minutes)} minutes old.",
                })

    return {"alerts": alerts}


@app.patch("/api/v1/plates/{plate_token}")
async def update_plate(
    plate_token: str,
    body: PlateUpdateRequest,
    user_data: dict = Depends(require_school_admin),
):
    """Update guardian name, student names, vehicle details, plate number, or authorized guardians."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    doc_ref = db.collection("plates").document(plate_token)
    doc = await asyncio.to_thread(doc_ref.get)
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Plate not found")
    plate_data = doc.to_dict()
    if plate_data.get("school_id") and plate_data["school_id"] != school_id:
        raise HTTPException(status_code=403, detail="Not authorised to edit this plate")

    updates: dict = {}
    if body.guardian_name is not None:
        updates["parent"] = encrypt_string(body.guardian_name)
    if body.linked_student_ids is not None:
        # Store the linked student IDs on the plate document
        updates["linked_student_ids"] = body.linked_student_ids
        # Resolve student names from the students collection for backward compat
        resolved_names = []
        for sid in body.linked_student_ids:
            sdoc = db.collection("students").document(sid).get()
            if sdoc.exists:
                sdata = sdoc.to_dict()
                first = safe_decrypt(sdata.get("first_name_encrypted"), default="")
                last = safe_decrypt(sdata.get("last_name_encrypted"), default="")
                full = f"{first} {last}".strip()
                if full:
                    resolved_names.append(full)
        if resolved_names:
            updates["student_names_encrypted"] = (
                [encrypt_string(n) for n in resolved_names] if len(resolved_names) > 1
                else encrypt_string(resolved_names[0])
            )
        else:
            updates["student_names_encrypted"] = []
    elif body.student_names is not None:
        names = [n.strip() for n in body.student_names if n.strip()]
        if names:
            updates["student_names_encrypted"] = (
                [encrypt_string(n) for n in names] if len(names) > 1
                else encrypt_string(names[0])
            )
    if body.vehicles is not None:
        vehicles_list = []
        for v in body.vehicles:
            veh = {
                "make": v.make,
                "model": v.model,
                "color": v.color,
            }
            if v.plate_number:
                plate_clean = v.plate_number.upper().strip()
                veh["plate_number_encrypted"] = encrypt_string(plate_clean)
                veh["plate_token"] = tokenize_plate(plate_clean)
            vehicles_list.append(veh)
        updates["vehicles"] = vehicles_list
        # Keep legacy single-vehicle fields in sync with first vehicle
        if vehicles_list:
            first = body.vehicles[0]
            updates["vehicle_make"] = first.make
            updates["vehicle_model"] = first.model
            updates["vehicle_color"] = first.color
    else:
        if body.vehicle_make is not None:
            updates["vehicle_make"] = body.vehicle_make
        if body.vehicle_model is not None:
            updates["vehicle_model"] = body.vehicle_model
        if body.vehicle_color is not None:
            updates["vehicle_color"] = body.vehicle_color
    if "guardian_photo_url" in body.model_fields_set:
        updates["guardian_photo_url"] = body.guardian_photo_url
    if "student_photo_urls" in body.model_fields_set:
        updates["student_photo_urls"] = body.student_photo_urls
    if body.authorized_guardians is not None:
        auth_plate_tokens = []
        auth_list = []
        for ag in body.authorized_guardians:
            entry = {
                "name_encrypted": encrypt_string(ag.name),
                "photo_url": ag.photo_url,
                "vehicle_make": ag.vehicle_make,
                "vehicle_model": ag.vehicle_model,
                "vehicle_color": ag.vehicle_color,
            }
            if ag.plate_number:
                plate_clean = ag.plate_number.upper().strip()
                entry["plate_number_encrypted"] = encrypt_string(plate_clean)
                entry["plate_token"] = tokenize_plate(plate_clean)
                auth_plate_tokens.append(entry["plate_token"])
            auth_list.append(entry)
        updates["authorized_guardians"] = auth_list
        updates["authorized_plate_tokens"] = auth_plate_tokens

    if body.blocked_guardians is not None:
        blocked_plate_tokens = []
        blocked_list = []
        for bg in body.blocked_guardians:
            entry = {
                "name_encrypted": encrypt_string(bg.name),
                "photo_url": bg.photo_url,
                "vehicle_make": bg.vehicle_make,
                "vehicle_model": bg.vehicle_model,
                "vehicle_color": bg.vehicle_color,
                "reason": bg.reason,
            }
            if bg.plate_number:
                plate_clean = bg.plate_number.upper().strip()
                entry["plate_number_encrypted"] = encrypt_string(plate_clean)
                entry["plate_token"] = tokenize_plate(plate_clean)
                blocked_plate_tokens.append(entry["plate_token"])
            blocked_list.append(entry)
        updates["blocked_guardians"] = blocked_list
        updates["blocked_plate_tokens"] = blocked_plate_tokens

    # Handle plate number change — requires re-tokenizing (new doc ID)
    new_token = plate_token
    if body.plate_number is not None:
        plate_clean = body.plate_number.upper().strip()
        if not plate_clean:
            raise HTTPException(status_code=400, detail="Plate number cannot be blank")
        new_token = tokenize_plate(plate_clean)
        updates["plate_number_encrypted"] = encrypt_string(plate_clean)

        if new_token != plate_token:
            # Plate changed — create new document and delete old one
            merged = {**plate_data, **updates}
            merged.pop("plate_token", None)
            new_doc_ref = db.collection("plates").document(new_token)
            await asyncio.to_thread(new_doc_ref.set, merged)
            await asyncio.to_thread(doc_ref.delete)
            logger.info(
                "Plate re-keyed old=%s new=%s school=%s",
                plate_token, new_token, school_id,
            )
            return {"plate_token": new_token, "updated": list(updates.keys()), "rekeyed": True}

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    await asyncio.to_thread(doc_ref.update, updates)
    logger.info("Updated plate_token=%s fields=%r school=%s", plate_token, list(updates.keys()), school_id)
    return {"plate_token": new_token, "updated": list(updates.keys())}


# ---------------------------------------------------------------------------
# Current-user profile
# ---------------------------------------------------------------------------
@app.get("/api/v1/me")
def get_me(user_data: dict = Depends(verify_firebase_token)):
    """
    Return the authenticated user's profile.
    Also transitions a 'pending' account to 'active' on first successful login
    so the inviting admin can see the user has completed onboarding.
    """
    uid = user_data.get("uid")
    logger.info("GET /api/v1/me → uid=%s display_name=%s role=%s",
                uid, user_data.get("display_name"), user_data.get("role"))
    if user_data.get("status") == "pending":
        try:
            db.collection("school_admins").document(uid).update({"status": "active"})
            user_data["status"] = "active"
        except Exception as exc:
            logger.warning("pending→active transition failed uid=%s: %s", uid, exc)

    role = user_data.get("role", "school_admin")
    school_id = user_data.get("school_id", "")
    base = {
        "uid": uid,
        "email": user_data.get("email", ""),
        "display_name": user_data.get("display_name", ""),
        "role": role,
        "status": user_data.get("status", "active"),
        "is_super_admin": role == "super_admin",
        "is_guardian": role == "guardian",
    }
    if role == "guardian":
        base["phone"] = user_data.get("phone")
        base["photo_url"] = user_data.get("photo_url")
    else:
        base["school_id"] = school_id
        base["permissions"] = _get_user_permissions(role, school_id)
    return base


# ---------------------------------------------------------------------------
# User management  (school_admin only)
# ---------------------------------------------------------------------------
@app.get("/api/v1/users")
def list_users(user_data: dict = Depends(require_school_admin)):
    """List all admin/staff users for the calling user's school."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    try:
        docs = list(
            db.collection("school_admins")
            .where(field_path="school_id", op_string="==", value=school_id)
            .stream()
        )
    except Exception as exc:
        logger.error("Firestore list_users query failed school=%s: %s", school_id, exc)
        raise HTTPException(status_code=500, detail=f"Failed to load users: {exc}")

    tz = ZoneInfo(DEVICE_TIMEZONE)
    users: list[dict] = []
    for doc in docs:
        data = doc.to_dict()

        # Enrich with Firebase Auth metadata (last sign-in, email_verified)
        try:
            fb_user = fb_auth.get_user(data["uid"])
            lsi_ms = fb_user.user_metadata.last_sign_in_timestamp
            data["last_sign_in"] = (
                datetime.fromtimestamp(lsi_ms / 1000, tz=tz).isoformat()
                if lsi_ms else None
            )
            data["email_verified"] = fb_user.email_verified
        except Exception:
            data["last_sign_in"] = None
            data["email_verified"] = False

        # Serialise Firestore timestamps
        for field in ("invited_at", "created_at"):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()

        users.append(data)

    users.sort(key=lambda u: (u.get("display_name") or u.get("email") or "").lower())
    logger.info("Users list: %d records school=%s", len(users), school_id)
    return {"users": users, "total": len(users)}


@app.post("/api/v1/users/invite", status_code=201)
def invite_user(body: InviteUserRequest, user_data: dict = Depends(require_school_admin)):
    """
    Create a new Firebase Auth user, set custom claims, write a school_admins
    record, and return a one-time password-reset link the admin can share.
    The invited user follows the link to set their own password before first login.
    """
    school_id = user_data.get("school_id") or user_data.get("uid")
    calling_uid = user_data.get("uid")

    # 1. Create Firebase Auth account
    try:
        fb_user = fb_auth.create_user(
            email=body.email,
            display_name=body.display_name,
            email_verified=False,
            disabled=False,
        )
    except fb_auth.EmailAlreadyExistsError:
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    except Exception as exc:
        logger.error("Firebase create_user failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to create user account: {exc}")

    uid = fb_user.uid

    # 2. Set custom claims immediately so they are baked into the first token
    try:
        fb_auth.set_custom_user_claims(uid, {
            "school_id": school_id,
            "role": body.role,
            "dismissal_admin": True,
        })
    except Exception as exc:
        # Roll back — user would exist with no claims, which is worse
        try:
            fb_auth.delete_user(uid)
        except Exception:
            pass
        logger.error("set_custom_user_claims failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to assign user permissions")

    # 3. Write Firestore record (source of truth for role & status)
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "uid": uid,
        "email": body.email,
        "display_name": body.display_name,
        "school_id": school_id,
        "role": body.role,
        "status": "pending",
        "invited_by_uid": calling_uid,
        "invited_at": now,
        "created_at": now,
    }
    try:
        db.collection("school_admins").document(uid).set(record)
    except Exception as exc:
        logger.error("Firestore write failed for invite uid=%s: %s", uid, exc)
        # Non-fatal — auth + claims are set; record will be created on first login

    # 4. Generate a password-reset link that serves as the first-time invite link
    invite_link: Optional[str] = None
    try:
        # continueUrl redirects the user to the app login page after they set
        # their password, so they land on the sign-in form rather than staying
        # on Firebase's hosted action page.
        _action_settings = fb_auth.ActionCodeSettings(url=FRONTEND_URL or "")
        invite_link = fb_auth.generate_password_reset_link(
            body.email, action_code_settings=_action_settings
        )
    except Exception as exc:
        logger.warning("generate_password_reset_link (with continueUrl) failed for %s: %s", body.email, exc)
        try:
            invite_link = fb_auth.generate_password_reset_link(body.email)
        except Exception as exc2:
            logger.warning("generate_password_reset_link fallback failed for %s: %s", body.email, exc2)

    logger.info(
        "Invited user email=%s role=%s school=%s uid=%s by=%s",
        body.email, body.role, school_id, uid, calling_uid,
    )
    return {
        "uid": uid,
        "email": body.email,
        "display_name": body.display_name,
        "role": body.role,
        "status": "pending",
        "invite_link": invite_link,
    }


@app.patch("/api/v1/users/{target_uid}/role")
def update_user_role(
    target_uid: str,
    body: UpdateRoleRequest,
    user_data: dict = Depends(require_school_admin),
):
    """Change a user's role. Admins cannot change their own role."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    calling_uid = user_data.get("uid")

    if target_uid == calling_uid:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")

    # Update Firestore (source of truth)
    doc_ref.update({"role": body.role})

    # Update custom claims so next token refresh reflects the new role
    try:
        existing = fb_auth.get_user(target_uid).custom_claims or {}
        existing["role"] = body.role
        fb_auth.set_custom_user_claims(target_uid, existing)
    except Exception as exc:
        logger.warning("Custom claims update failed uid=%s: %s", target_uid, exc)

    logger.info("Role updated uid=%s role=%s by=%s", target_uid, body.role, calling_uid)
    return {"uid": target_uid, "role": body.role}


@app.patch("/api/v1/users/{target_uid}/status")
def update_user_status(
    target_uid: str,
    body: UpdateStatusRequest,
    user_data: dict = Depends(require_school_admin),
):
    """Enable or disable a user account. Disabled users are blocked at the next request."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    calling_uid = user_data.get("uid")

    if target_uid == calling_uid:
        raise HTTPException(status_code=400, detail="You cannot disable your own account")

    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")

    # Disable/enable in Firebase Auth (prevents new tokens from being issued)
    try:
        fb_auth.update_user(target_uid, disabled=(body.status == "disabled"))
    except Exception as exc:
        logger.error("Firebase update_user disabled failed uid=%s: %s", target_uid, exc)
        raise HTTPException(status_code=500, detail="Failed to update account status")

    # Update Firestore status (blocks existing valid tokens via verify_firebase_token)
    doc_ref.update({"status": body.status})

    logger.info("Status updated uid=%s status=%s by=%s", target_uid, body.status, calling_uid)
    return {"uid": target_uid, "status": body.status}


@app.delete("/api/v1/users/{target_uid}")
def delete_user_account(
    target_uid: str,
    user_data: dict = Depends(require_school_admin),
):
    """Permanently delete a user from Firebase Auth and the school_admins collection."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    calling_uid = user_data.get("uid")

    if target_uid == calling_uid:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    doc_ref = db.collection("school_admins").document(target_uid)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    if doc.to_dict().get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")

    # Delete Firestore record first so the user is immediately deactivated
    # even if the Firebase Auth call below fails.
    doc_ref.delete()

    # Delete from Firebase Auth
    try:
        fb_auth.delete_user(target_uid)
    except fb_auth.UserNotFoundError:
        pass  # Already gone from Auth
    except Exception as exc:
        # Log but don't fail — the Firestore record is already removed, so
        # the user can no longer sign in as admin.  The orphaned Auth user
        # will be cleaned up automatically if the email is reused for a
        # guardian signup.
        logger.error("Firebase delete_user failed uid=%s: %s", target_uid, exc)

    logger.info("Deleted user uid=%s by=%s school=%s", target_uid, calling_uid, school_id)
    return {"status": "deleted", "uid": target_uid}


@app.post("/api/v1/users/{target_uid}/resend-invite")
def resend_invite(target_uid: str, user_data: dict = Depends(require_school_admin)):
    """Generate a fresh password-reset link for a pending user so the admin can resend it."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    doc = db.collection("school_admins").document(target_uid).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="User does not belong to your school")

    email = data.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="No email address on record")

    try:
        _action_settings = fb_auth.ActionCodeSettings(url=FRONTEND_URL or "")
        link = fb_auth.generate_password_reset_link(
            email, action_code_settings=_action_settings
        )
    except Exception as exc:
        logger.warning("generate_password_reset_link (with continueUrl) failed uid=%s: %s", target_uid, exc)
        try:
            link = fb_auth.generate_password_reset_link(email)
        except Exception as exc2:
            logger.error("generate_password_reset_link fallback failed uid=%s: %s", target_uid, exc2)
            raise HTTPException(status_code=500, detail="Failed to generate invite link")

    logger.info("Resent invite uid=%s email=%s by=%s", target_uid, email, user_data.get("uid"))
    return {"invite_link": link, "email": email}


# ---------------------------------------------------------------------------
# Profile — update own account
# ---------------------------------------------------------------------------

@app.patch("/api/v1/me")
def update_profile(body: UpdateProfileRequest, user_data: dict = Depends(verify_firebase_token)):
    """Allow the authenticated user to update their own display name."""
    uid = user_data.get("uid")
    role = user_data.get("role")

    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Update Firestore record
    collection = "guardians" if role == "guardian" else "school_admins"
    try:
        db.collection(collection).document(uid).update(updates)
    except Exception as exc:
        logger.error("Profile update Firestore failed uid=%s: %s", uid, exc)
        raise HTTPException(status_code=500, detail="Failed to update profile")

    # Update Firebase Auth display name
    if "display_name" in updates:
        try:
            fb_auth.update_user(uid, display_name=updates["display_name"])
        except Exception as exc:
            logger.warning("Firebase Auth display_name update failed uid=%s: %s", uid, exc)

    logger.info("Profile updated uid=%s fields=%s", uid, list(updates.keys()))
    return {"uid": uid, **updates}


# ---------------------------------------------------------------------------
# Permissions management  (school_admin only)
# ---------------------------------------------------------------------------

@app.get("/api/v1/permissions")
def get_permissions(user_data: dict = Depends(require_school_admin)):
    """Return the school's permission configuration for all roles."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    perms = _get_school_permissions(school_id)
    return {"school_id": school_id, "permissions": perms, "all_keys": ALL_PERMISSION_KEYS}


@app.put("/api/v1/permissions")
def update_permissions(body: UpdatePermissionsRequest, user_data: dict = Depends(require_school_admin)):
    """Update the permission configuration for staff and admin roles."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    # Validate keys — only allow known permission keys
    cleaned = {}
    for role_key in ("staff", "school_admin"):
        raw = getattr(body, role_key, {})
        cleaned[role_key] = {
            k: bool(v) for k, v in raw.items() if k in ALL_PERMISSION_KEYS
        }
        # Fill in any missing keys with defaults
        for k in ALL_PERMISSION_KEYS:
            if k not in cleaned[role_key]:
                cleaned[role_key][k] = DEFAULT_PERMISSIONS[role_key][k]

    cleaned["school_id"] = school_id
    try:
        db.collection("school_permissions").document(school_id).set(cleaned)
    except Exception as exc:
        logger.error("Failed to save permissions school=%s: %s", school_id, exc)
        raise HTTPException(status_code=500, detail="Failed to save permissions")

    logger.info("Permissions updated school=%s by=%s", school_id, user_data.get("uid"))
    return {"school_id": school_id, "permissions": {k: v for k, v in cleaned.items() if k != "school_id"}}


# ---------------------------------------------------------------------------
# Platform / super_admin — school management
# ---------------------------------------------------------------------------

@app.get("/api/v1/admin/schools")
def list_schools(user_data: dict = Depends(require_super_admin)):
    """Return all schools on the platform."""
    docs = list(db.collection("schools").stream())
    schools = []
    for doc in docs:
        data = doc.to_dict()
        # Serialise timestamps
        for field in ("created_at",):
            val = data.get(field)
            if val is not None and hasattr(val, "isoformat"):
                data[field] = val.isoformat()
        data["id"] = doc.id
        schools.append(data)
    schools.sort(key=lambda s: (s.get("name") or "").lower())
    logger.info("Super admin listed %d schools uid=%s", len(schools), user_data["uid"])
    return {"schools": schools, "total": len(schools)}


def _generate_enrollment_code(length: int = 6) -> str:
    """Generate a short alphanumeric enrollment code."""
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


@app.post("/api/v1/admin/schools", status_code=201)
def create_school(body: CreateSchoolRequest, user_data: dict = Depends(require_super_admin)):
    """Create a new school record on the platform."""
    now = datetime.now(tz=ZoneInfo(DEVICE_TIMEZONE))
    record = {
        "name": body.name,
        "admin_email": body.admin_email,
        "timezone": body.timezone,
        "status": "active",
        "enrollment_code": _generate_enrollment_code(),
        "created_at": now,
        "created_by": user_data["uid"],
    }
    _ref = db.collection("schools").add(record)
    school_id = _ref[1].id
    logger.info("Created school name=%r id=%s by=%s", body.name, school_id, user_data["uid"])
    return {"id": school_id, **record, "created_at": now.isoformat()}


@app.patch("/api/v1/admin/schools/{school_id}")
def update_school(
    school_id: str,
    body: UpdateSchoolRequest,
    user_data: dict = Depends(require_super_admin),
):
    """Update school metadata or status."""
    doc_ref = db.collection("schools").document(school_id)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="School not found")

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    doc_ref.update(updates)
    logger.info("Updated school id=%s updates=%r by=%s", school_id, updates, user_data["uid"])
    return {"id": school_id, **updates}


@app.get("/api/v1/admin/schools/{school_id}/stats")
def school_stats(school_id: str, user_data: dict = Depends(require_super_admin)):
    """Return aggregate stats for a single school."""
    plates_count = len(list(
        db.collection("plates")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    ))
    users_count = len(list(
        db.collection("school_admins")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    ))
    scans_count = len(list(
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    ))
    return {
        "school_id": school_id,
        "plates": plates_count,
        "users": users_count,
        "scans": scans_count,
    }


# ---------------------------------------------------------------------------
# School lookup by enrollment code (used by guardians when adding children)
# ---------------------------------------------------------------------------
@app.get("/api/v1/schools/lookup")
def lookup_school_by_code(code: str = Query(...), user_data: dict = Depends(verify_firebase_token)):
    """Resolve a school enrollment code to school id + name."""
    code = code.strip().upper()
    if ENV == "development":
        return {"id": DEV_SCHOOL_ID, "name": "Development School"}

    docs = list(
        db.collection("schools")
        .where(field_path="enrollment_code", op_string="==", value=code)
        .limit(1)
        .stream()
    )
    if not docs:
        raise HTTPException(status_code=404, detail="Invalid enrollment code")
    data = docs[0].to_dict()
    if data.get("status") == "suspended":
        raise HTTPException(status_code=403, detail="School is currently suspended")
    return {"id": docs[0].id, "name": data.get("name", "")}


# ---------------------------------------------------------------------------
# Benefactor — Guardian Profile
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/profile")
def get_guardian_profile(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc = db.collection("guardians").document(uid).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")
    data = doc.to_dict()
    return {
        "uid": uid,
        "display_name": data.get("display_name", ""),
        "email": data.get("email", ""),
        "phone": data.get("phone"),
        "photo_url": data.get("photo_url"),
    }


@app.patch("/api/v1/benefactor/profile")
def update_guardian_profile(body: GuardianProfileUpdate, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name.strip()
    if "phone" in body.model_fields_set:
        updates["phone"] = body.phone
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    db.collection("guardians").document(uid).update(updates)
    logger.info("Guardian profile updated uid=%s fields=%r", uid, list(updates.keys()))
    return {"status": "updated", "updated": list(updates.keys())}


# ---------------------------------------------------------------------------
# Benefactor — Children (Students)
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/children")
def list_children(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    docs = list(
        db.collection("students")
        .where(field_path="guardian_uid", op_string="==", value=uid)
        .stream()
    )
    children = []
    for doc in docs:
        data = doc.to_dict()
        first = safe_decrypt(data.get("first_name_encrypted"), default="")
        last = safe_decrypt(data.get("last_name_encrypted"), default="")
        children.append({
            "id": doc.id,
            "first_name": first,
            "last_name": last,
            "school_id": data.get("school_id"),
            "school_name": data.get("school_name", ""),
            "grade": data.get("grade"),
            "photo_url": data.get("photo_url"),
        })
    children.sort(key=lambda c: f"{c['first_name']} {c['last_name']}".lower())
    return {"children": children, "total": len(children)}


@app.post("/api/v1/benefactor/children", status_code=201)
def add_child(body: AddChildRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]

    # Validate school_id against guardian's assigned schools
    school_id = body.school_id.strip()

    if ENV == "development":
        school_name = "Development School"
    else:
        # Verify the school exists
        school_doc = db.collection("schools").document(school_id).get()
        if not school_doc.exists:
            raise HTTPException(status_code=404, detail="School not found")
        school_data = school_doc.to_dict()
        if school_data.get("status") == "suspended":
            raise HTTPException(status_code=403, detail="School is currently suspended")
        school_name = school_data.get("name", "")

        # Verify the guardian is assigned to this school
        guardian_doc = db.collection("guardians").document(uid).get()
        assigned_schools = []
        if guardian_doc.exists:
            assigned_schools = guardian_doc.to_dict().get("assigned_school_ids", [])
        if school_id not in assigned_schools:
            raise HTTPException(
                status_code=403,
                detail="You are not authorized for this school. Please contact your school administrator.",
            )

    # ── Student uniqueness enforcement ──────────────────────────────────
    # Generate a deterministic identity token from name + school so the
    # same student can never be registered twice at the same school.
    student_token = tokenize_student(body.first_name, body.last_name, school_id)

    existing = list(
        db.collection("students")
        .where(field_path="student_token", op_string="==", value=student_token)
        .limit(1)
        .stream()
    )

    if existing:
        ex_data = existing[0].to_dict()
        ex_status = ex_data.get("status", "active")
        ex_guardian = ex_data.get("guardian_uid")

        if ex_status == "active" and ex_guardian:
            if ex_guardian == uid:
                raise HTTPException(
                    status_code=409,
                    detail="This child is already on your account",
                )
            raise HTTPException(
                status_code=409,
                detail="This student is already registered to another guardian. "
                       "Contact your school administrator if you believe this is an error.",
            )

        # Student exists but is unlinked — reclaim the record
        doc_ref = db.collection("students").document(existing[0].id)
        updates = {
            "guardian_uid": uid,
            "status": "active",
            "claimed_at": datetime.now(timezone.utc).isoformat(),
        }
        if body.grade is not None:
            updates["grade"] = body.grade
        if body.photo_url is not None:
            updates["photo_url"] = body.photo_url
        doc_ref.update(updates)
        logger.info(
            "Child reclaimed id=%s guardian=%s school=%s",
            existing[0].id, uid, school_id,
        )
        first = safe_decrypt(ex_data.get("first_name_encrypted"), default=body.first_name.strip())
        last = safe_decrypt(ex_data.get("last_name_encrypted"), default=body.last_name.strip())
        return {
            "id": existing[0].id,
            "first_name": first,
            "last_name": last,
            "school_id": school_id,
            "school_name": ex_data.get("school_name", school_name),
            "grade": body.grade or ex_data.get("grade"),
            "photo_url": body.photo_url or ex_data.get("photo_url"),
        }

    # ── Create new student record ───────────────────────────────────────
    record = {
        "first_name_encrypted": encrypt_string(body.first_name.strip()),
        "last_name_encrypted": encrypt_string(body.last_name.strip()),
        "student_token": student_token,
        "school_id": school_id,
        "school_name": school_name,
        "grade": body.grade,
        "photo_url": body.photo_url,
        "guardian_uid": uid,
        "status": "active",
        "claimed_at": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _, doc_ref = db.collection("students").add(record)
    logger.info("Child added id=%s guardian=%s school=%s", doc_ref.id, uid, school_id)
    return {
        "id": doc_ref.id,
        "first_name": body.first_name.strip(),
        "last_name": body.last_name.strip(),
        "school_id": school_id,
        "school_name": school_name,
        "grade": body.grade,
        "photo_url": body.photo_url,
    }


@app.patch("/api/v1/benefactor/children/{child_id}")
def update_child(child_id: str, body: UpdateChildRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("students").document(child_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Child not found")

    # Guardians may update grade and photo only — name changes require admin
    # action because they affect the student identity token.
    updates = {}
    if body.first_name is not None or body.last_name is not None:
        raise HTTPException(
            status_code=403,
            detail="Name changes require school administrator approval. "
                   "Contact your school to update a student's name.",
        )
    if "grade" in body.model_fields_set:
        updates["grade"] = body.grade
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    doc_ref.update(updates)
    logger.info("Child updated id=%s guardian=%s", child_id, uid)
    return {"status": "updated", "id": child_id}


@app.delete("/api/v1/benefactor/children/{child_id}")
def remove_child(child_id: str, user_data: dict = Depends(require_guardian)):
    """Guardians cannot remove students. Only school admins can unlink students."""
    raise HTTPException(
        status_code=403,
        detail="Students can only be unlinked by a school administrator. "
               "Please contact your school to request changes.",
    )


# ---------------------------------------------------------------------------
# Benefactor — Vehicles
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/vehicles")
def list_vehicles(user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    docs = list(
        db.collection("vehicles")
        .where(field_path="guardian_uid", op_string="==", value=uid)
        .stream()
    )
    vehicles = []
    for doc in docs:
        data = doc.to_dict()
        plate = safe_decrypt(data.get("plate_number_encrypted"), default="")
        vehicles.append({
            "id": doc.id,
            "plate_number": plate,
            "make": data.get("make"),
            "model": data.get("model"),
            "color": data.get("color"),
            "year": data.get("year"),
            "photo_url": data.get("photo_url"),
            "school_ids": data.get("school_ids", []),
            "student_ids": data.get("student_ids", []),
            "created_at": data.get("created_at"),
        })
    return {"vehicles": vehicles, "total": len(vehicles)}


@app.post("/api/v1/benefactor/vehicles", status_code=201)
def add_vehicle(body: AddVehicleRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    plate_token = tokenize_plate(body.plate_number)

    # Derive school_ids from guardian's children
    child_docs = list(
        db.collection("students")
        .where(field_path="guardian_uid", op_string="==", value=uid)
        .stream()
    )
    school_ids = list({d.to_dict().get("school_id") for d in child_docs if d.to_dict().get("school_id")})
    student_ids = [d.id for d in child_docs]

    record = {
        "plate_number_encrypted": encrypt_string(body.plate_number),
        "plate_token": plate_token,
        "make": body.make,
        "model": body.model,
        "color": body.color,
        "year": body.year,
        "photo_url": body.photo_url,
        "guardian_uid": uid,
        "school_ids": school_ids,
        "student_ids": student_ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _, doc_ref = db.collection("vehicles").add(record)
    logger.info("Vehicle added id=%s plate_token=%s guardian=%s schools=%s", doc_ref.id, plate_token, uid, school_ids)
    return {
        "id": doc_ref.id,
        "plate_number": body.plate_number,
        "make": body.make,
        "model": body.model,
        "color": body.color,
        "year": body.year,
        "photo_url": body.photo_url,
        "school_ids": school_ids,
        "student_ids": student_ids,
        "created_at": record["created_at"],
    }


@app.patch("/api/v1/benefactor/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: str, body: UpdateVehicleRequest, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("vehicles").document(vehicle_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    updates = {}
    if body.plate_number is not None:
        plate = body.plate_number.upper().strip()
        updates["plate_number_encrypted"] = encrypt_string(plate)
        updates["plate_token"] = tokenize_plate(plate)
    if body.make is not None:
        updates["make"] = body.make
    if body.model is not None:
        updates["model"] = body.model
    if body.color is not None:
        updates["color"] = body.color
    if body.year is not None:
        updates["year"] = body.year
    if "photo_url" in body.model_fields_set:
        updates["photo_url"] = body.photo_url
    if body.student_ids is not None:
        updates["student_ids"] = body.student_ids
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    doc_ref.update(updates)
    logger.info("Vehicle updated id=%s guardian=%s", vehicle_id, uid)
    return {"status": "updated", "id": vehicle_id}


@app.delete("/api/v1/benefactor/vehicles/{vehicle_id}")
def delete_vehicle(vehicle_id: str, user_data: dict = Depends(require_guardian)):
    uid = user_data["uid"]
    doc_ref = db.collection("vehicles").document(vehicle_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    doc_ref.delete()
    logger.info("Vehicle deleted id=%s guardian=%s", vehicle_id, uid)
    return {"status": "deleted", "id": vehicle_id}


# ---------------------------------------------------------------------------
# Guardian Signup (public — no auth required)
# ---------------------------------------------------------------------------
@app.post("/api/v1/auth/guardian-signup", status_code=201)
def guardian_signup(body: GuardianSignupRequest):
    """
    Create a new Firebase Auth account for a guardian/parent.
    No school_admins record is created — the user is automatically treated
    as a guardian by verify_firebase_token() on first login.
    """
    # Check if email already exists in Firebase Auth
    existing_user = None
    try:
        existing_user = fb_auth.get_user_by_email(body.email)
    except fb_auth.UserNotFoundError:
        pass  # Good — email is available
    except Exception as exc:
        logger.error("Firebase lookup error during signup: %s", exc)
        raise HTTPException(status_code=500, detail="Account creation failed")

    if existing_user:
        # Email exists in Firebase Auth — check if it belongs to an active
        # admin/staff or guardian.  If the user was deleted from the admin
        # panel but the Firebase Auth record survived (e.g. the Auth delete
        # call failed while the Firestore doc was removed), the Auth user is
        # orphaned.  We clean it up so the email can be reused.
        has_admin = False
        has_guardian = False
        try:
            admin_doc = db.collection("school_admins").document(existing_user.uid).get()
            has_admin = admin_doc.exists
        except Exception:
            pass
        try:
            guardian_doc = db.collection("guardians").document(existing_user.uid).get()
            has_guardian = guardian_doc.exists
        except Exception:
            pass

        if has_admin or has_guardian:
            raise HTTPException(
                status_code=409,
                detail="An account with this email already exists",
            )

        # Orphaned Firebase Auth user — delete so we can recreate below
        logger.info("Removing orphaned Firebase Auth user uid=%s email=%s",
                     existing_user.uid, body.email)
        try:
            fb_auth.delete_user(existing_user.uid)
        except Exception as exc:
            logger.error("Failed to remove orphaned Auth user uid=%s: %s",
                         existing_user.uid, exc)
            raise HTTPException(status_code=500, detail="Account creation failed")

    # Create Firebase Auth user
    try:
        user = fb_auth.create_user(
            email=body.email,
            password=body.password,
            display_name=body.display_name,
        )
    except Exception as exc:
        logger.error("Firebase create_user failed: %s", exc)
        raise HTTPException(status_code=500, detail="Account creation failed")

    # Pre-create the guardians profile doc so first login is seamless.
    # `assigned_school_ids` is initialized to an empty list so that admins
    # can discover the guardian via the "pending assignment" query in
    # admin_list_guardians before they have any children at a school.
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.collection("guardians").document(user.uid).set({
            "display_name": body.display_name,
            "email": body.email,
            "email_lower": body.email.lower(),
            "phone": None,
            "photo_url": None,
            "assigned_school_ids": [],
            "created_at": now,
        })
    except Exception as exc:
        logger.warning("Failed to pre-create guardian profile uid=%s: %s", user.uid, exc)

    logger.info("Guardian signed up: uid=%s email=%s", user.uid, body.email)
    return {
        "status": "created",
        "uid": user.uid,
        "email": body.email,
        "display_name": body.display_name,
    }


# ---------------------------------------------------------------------------
# Benefactor — Authorized Pickups
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/authorized-pickups")
def list_authorized_pickups(user_data: dict = Depends(require_guardian)):
    """List all authorized pickup people for this guardian."""
    uid = user_data["uid"]
    guardian_doc = db.collection("guardians").document(uid).get()
    if not guardian_doc.exists:
        return {"pickups": []}
    data = guardian_doc.to_dict()
    pickups = data.get("authorized_pickups", [])
    return {"pickups": pickups}


@app.post("/api/v1/benefactor/authorized-pickups")
def add_authorized_pickup(body: AddAuthorizedPickupRequest, user_data: dict = Depends(require_guardian)):
    """Add an authorized pickup person."""
    uid = user_data["uid"]
    guardian_ref = db.collection("guardians").document(uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")

    data = guardian_doc.to_dict()
    pickups = data.get("authorized_pickups", [])

    # Generate a simple unique ID
    pickup_id = secrets.token_hex(8)
    entry = {
        "id": pickup_id,
        "name": body.name.strip(),
        "phone": (body.phone or "").strip() or None,
        "relationship": (body.relationship or "").strip() or None,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    pickups.append(entry)
    guardian_ref.update({"authorized_pickups": pickups})
    logger.info("Authorized pickup added: guardian=%s pickup=%s", uid, pickup_id)
    return entry


@app.delete("/api/v1/benefactor/authorized-pickups/{pickup_id}")
def remove_authorized_pickup(pickup_id: str, user_data: dict = Depends(require_guardian)):
    """Remove an authorized pickup person."""
    uid = user_data["uid"]
    guardian_ref = db.collection("guardians").document(uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian profile not found")

    data = guardian_doc.to_dict()
    pickups = data.get("authorized_pickups", [])
    original_count = len(pickups)
    pickups = [p for p in pickups if p.get("id") != pickup_id]
    if len(pickups) == original_count:
        raise HTTPException(status_code=404, detail="Authorized pickup not found")

    guardian_ref.update({"authorized_pickups": pickups})
    logger.info("Authorized pickup removed: guardian=%s pickup=%s", uid, pickup_id)
    return {"status": "removed", "id": pickup_id}


# ---------------------------------------------------------------------------
# Benefactor — Pickup Activity Feed
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/activity")
def guardian_activity(user_data: dict = Depends(require_guardian), limit: int = 20):
    """
    Return recent pickup scan events for vehicles belonging to this guardian.
    Decrypts student/guardian names for display.
    """
    uid = user_data["uid"]
    limit = min(max(limit, 1), 100)

    # Get guardian's vehicle plate tokens
    vehicles = db.collection("vehicles").where("guardian_uid", "==", uid).stream()
    plate_tokens = []
    plate_info = {}  # token → {plate_number, desc}
    for v in vehicles:
        vdata = v.to_dict()
        token = vdata.get("plate_token")
        if token:
            plate_tokens.append(token)
            try:
                plate_num = decrypt_string(vdata.get("plate_number_encrypted", ""))
            except Exception:
                plate_num = "***"
            desc = " ".join(filter(None, [vdata.get("color"), vdata.get("make"), vdata.get("model")])) or "Vehicle"
            plate_info[token] = {"plate_number": plate_num, "vehicle_desc": desc}

    if not plate_tokens:
        return {"events": [], "total": 0}

    # Firestore 'in' queries are limited to 30 values
    all_events = []
    for i in range(0, len(plate_tokens), 30):
        chunk = plate_tokens[i:i+30]
        scans = (
            db.collection("plate_scans")
            .where("plate_token", "in", chunk)
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        for s in scans:
            sdata = s.to_dict()
            token = sdata.get("plate_token", "")
            # Decrypt student names
            students_raw = sdata.get("student_names_encrypted", [])
            if isinstance(students_raw, str):
                students_raw = [students_raw]
            students = []
            for enc in students_raw:
                try:
                    students.append(decrypt_string(enc))
                except Exception:
                    students.append("(encrypted)")

            info = plate_info.get(token, {})
            all_events.append({
                "id": s.id,
                "timestamp": sdata.get("timestamp"),
                "plate_number": info.get("plate_number", "***"),
                "vehicle_desc": info.get("vehicle_desc", "Vehicle"),
                "students": students,
                "location": sdata.get("location", ""),
                "picked_up_by": sdata.get("picked_up_by"),
                "picked_up_at": sdata.get("picked_up_at"),
            })

    # Sort by timestamp descending and limit
    all_events.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
    all_events = all_events[:limit]

    return {"events": all_events, "total": len(all_events)}


# ---------------------------------------------------------------------------
# Admin — Student Management
# ---------------------------------------------------------------------------
@app.get("/api/v1/admin/students")
def admin_list_students(user_data: dict = Depends(require_school_admin)):
    """
    List all students for the current school with guardian details.
    Returns decrypted names, status, and linked guardian info.
    """
    school_id = user_data["school_id"]
    docs = list(
        db.collection("students")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )

    # Batch-fetch guardian profiles for linked students
    guardian_uids = {d.to_dict().get("guardian_uid") for d in docs if d.to_dict().get("guardian_uid")}
    guardian_map = {}
    for gid in guardian_uids:
        if not gid:
            continue
        gdoc = db.collection("guardians").document(gid).get()
        if gdoc.exists:
            gdata = gdoc.to_dict()
            guardian_map[gid] = {
                "uid": gid,
                "display_name": gdata.get("display_name", ""),
                "email": gdata.get("email", ""),
            }

    students = []
    for doc in docs:
        data = doc.to_dict()
        first = safe_decrypt(data.get("first_name_encrypted"), default="")
        last = safe_decrypt(data.get("last_name_encrypted"), default="")
        gid = data.get("guardian_uid")
        students.append({
            "id": doc.id,
            "first_name": first,
            "last_name": last,
            "grade": data.get("grade"),
            "photo_url": data.get("photo_url"),
            "status": data.get("status", "active"),
            "guardian": guardian_map.get(gid) if gid else None,
            "claimed_at": data.get("claimed_at"),
            "created_at": data.get("created_at"),
        })

    students.sort(key=lambda s: f"{s['last_name']} {s['first_name']}".lower())
    return {"students": students, "total": len(students)}


@app.post("/api/v1/admin/students/{student_id}/unlink")
def admin_unlink_student(student_id: str, user_data: dict = Depends(require_school_admin)):
    """
    Unlink a student from their guardian. The student record is preserved
    with status 'unlinked' and becomes available for another guardian to claim.
    Also removes the student from any vehicles belonging to the old guardian.
    """
    school_id = user_data["school_id"]
    doc_ref = db.collection("students").document(student_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Student not found")

    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="Student does not belong to this school")

    old_guardian_uid = data.get("guardian_uid")
    if not old_guardian_uid:
        raise HTTPException(status_code=400, detail="Student is already unlinked")

    # Remove student from any vehicles belonging to the old guardian
    vehicles = list(
        db.collection("vehicles")
        .where(field_path="guardian_uid", op_string="==", value=old_guardian_uid)
        .stream()
    )
    for vdoc in vehicles:
        vdata = vdoc.to_dict()
        sids = vdata.get("student_ids", [])
        if student_id in sids:
            sids.remove(student_id)
            db.collection("vehicles").document(vdoc.id).update({"student_ids": sids})

    # Unlink the student
    doc_ref.update({
        "guardian_uid": None,
        "status": "unlinked",
        "unlinked_at": datetime.now(timezone.utc).isoformat(),
        "unlinked_by": user_data["uid"],
    })

    logger.info(
        "Student unlinked id=%s old_guardian=%s by=%s school=%s",
        student_id, old_guardian_uid, user_data["uid"], school_id,
    )
    return {
        "status": "unlinked",
        "id": student_id,
        "previous_guardian_uid": old_guardian_uid,
    }


@app.post("/api/v1/admin/students/{student_id}/link")
def admin_link_student(
    student_id: str,
    body: AdminLinkStudentRequest,
    user_data: dict = Depends(require_school_admin),
):
    """
    Link an unlinked student to a guardian by email. The guardian must already
    have an account. This is the admin override for re-assigning students.
    """
    school_id = user_data["school_id"]
    doc_ref = db.collection("students").document(student_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Student not found")

    data = doc.to_dict()
    if data.get("school_id") != school_id:
        raise HTTPException(status_code=403, detail="Student does not belong to this school")

    if data.get("status") == "active" and data.get("guardian_uid"):
        raise HTTPException(
            status_code=409,
            detail="Student is already linked to a guardian. Unlink first.",
        )

    # Look up the guardian by email
    guardian_docs = list(
        db.collection("guardians")
        .where(field_path="email", op_string="==", value=body.guardian_email)
        .limit(1)
        .stream()
    )
    if not guardian_docs:
        raise HTTPException(status_code=404, detail="No guardian account found with that email")

    guardian_uid = guardian_docs[0].id
    guardian_data = guardian_docs[0].to_dict()

    doc_ref.update({
        "guardian_uid": guardian_uid,
        "status": "active",
        "claimed_at": datetime.now(timezone.utc).isoformat(),
        "linked_by": user_data["uid"],
    })

    logger.info(
        "Student linked id=%s guardian=%s by=%s school=%s",
        student_id, guardian_uid, user_data["uid"], school_id,
    )
    return {
        "status": "linked",
        "id": student_id,
        "guardian": {
            "uid": guardian_uid,
            "display_name": guardian_data.get("display_name", ""),
            "email": guardian_data.get("email", ""),
        },
    }


# ---------------------------------------------------------------------------
# Admin — Guardian School Assignment
# ---------------------------------------------------------------------------
@app.get("/api/v1/admin/guardians")
def admin_list_guardians(
    user_data: dict = Depends(require_school_admin),
    search: Optional[str] = Query(default=None),
):
    """
    List guardians visible to this admin.

    The default list contains three buckets, merged and de-duplicated:

      1. Guardians with at least one student at this school.
      2. Guardians directly assigned to this school.
      3. Guardians with no school assignment yet ("pending" pool) —
         so that newly-signed-up guardians are discoverable and can be
         claimed by any admin who assigns a school to them.

    When ``search`` is provided, we additionally match guardians globally
    by email (exact match on lowercase email) and by partial display_name
    / email prefix, so an admin can find a guardian even if they haven't
    signed up yet via any school.
    """
    school_id = user_data["school_id"]
    search_raw = (search or "").strip()
    search_lower = search_raw.lower()

    # ── Bucket 1: guardians with children at this school ────────────────────
    student_docs = list(
        db.collection("students")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )
    guardian_uids: set[str] = {
        d.to_dict().get("guardian_uid")
        for d in student_docs
        if d.to_dict().get("guardian_uid")
    }

    # Track which guardians were brought in by each bucket so the UI can
    # render a "pending assignment" badge. A guardian is considered pending
    # if they have no assigned_school_ids and no children at this school.
    guardian_docs_cache: dict = {}

    def _remember(gid: str, gdoc):
        if gid and gid not in guardian_docs_cache and gdoc is not None:
            guardian_docs_cache[gid] = gdoc

    # ── Bucket 2: guardians directly assigned to this school ───────────────
    try:
        assigned_docs = list(
            db.collection("guardians")
            .where(field_path="assigned_school_ids", op_string="array_contains", value=school_id)
            .stream()
        )
    except Exception as exc:
        logger.warning("assigned_school_ids query failed: %s", exc)
        assigned_docs = []
    for doc in assigned_docs:
        guardian_uids.add(doc.id)
        _remember(doc.id, doc)

    # ── Bucket 3: guardians with no school assignment yet ───────────────────
    # Firestore can't directly query "missing field" or "empty array", so we
    # stream the collection and filter in-memory. The guardian pool is
    # bounded by the number of parent accounts (typically small), so this
    # is acceptable. We cap the scan to avoid pathological cases and
    # prioritise the most recently created guardians so newly-signed-up
    # parents show up first.
    PENDING_SCAN_CAP = 500
    try:
        try:
            pending_stream = (
                db.collection("guardians")
                .order_by("created_at", direction=firestore.Query.DESCENDING)
                .limit(PENDING_SCAN_CAP)
                .stream()
            )
        except Exception:
            # order_by fails on docs missing `created_at`; fall back to an
            # unordered scan so legacy guardians remain discoverable.
            pending_stream = db.collection("guardians").limit(PENDING_SCAN_CAP).stream()
        for doc in pending_stream:
            gdata = doc.to_dict() or {}
            if not gdata.get("assigned_school_ids"):
                guardian_uids.add(doc.id)
                _remember(doc.id, doc)
    except Exception as exc:
        logger.warning("Pending-guardian scan failed: %s", exc)

    # ── Search expansion: match guardians globally by name / email ──────────
    if search_raw:
        # Exact-email match (preserves existing behaviour).
        try:
            email_docs = list(
                db.collection("guardians")
                .where(field_path="email_lower", op_string="==", value=search_lower)
                .stream()
            )
            for doc in email_docs:
                guardian_uids.add(doc.id)
                _remember(doc.id, doc)
        except Exception as exc:
            logger.warning("Guardian email_lower search failed: %s", exc)

        # Legacy fallback: older guardian docs may not have `email_lower`.
        try:
            legacy_email_docs = list(
                db.collection("guardians")
                .where(field_path="email", op_string="==", value=search_lower)
                .stream()
            )
            for doc in legacy_email_docs:
                guardian_uids.add(doc.id)
                _remember(doc.id, doc)
        except Exception as exc:
            logger.warning("Guardian email search failed: %s", exc)

    # ── Build response objects ──────────────────────────────────────────────
    guardians = []
    for gid in guardian_uids:
        if not gid:
            continue
        gdoc = guardian_docs_cache.get(gid)
        if gdoc is None:
            gdoc = db.collection("guardians").document(gid).get()
        if not getattr(gdoc, "exists", False):
            continue
        gdata = gdoc.to_dict() or {}

        # Count children at this school
        child_count = sum(
            1 for d in student_docs
            if d.to_dict().get("guardian_uid") == gid
        )

        assigned_school_ids = gdata.get("assigned_school_ids") or []

        # Resolve school names for assigned schools
        assigned_schools = []
        for sid in assigned_school_ids:
            sdoc = db.collection("schools").document(sid).get()
            if sdoc.exists:
                sdata = sdoc.to_dict()
                assigned_schools.append({"id": sid, "name": sdata.get("name", "")})
            else:
                assigned_schools.append({"id": sid, "name": "(deleted school)"})

        # A guardian is "pending assignment" when they have no schools at
        # all and no students at this school yet.
        is_pending = not assigned_school_ids and child_count == 0

        guardians.append({
            "uid": gid,
            "display_name": gdata.get("display_name", ""),
            "email": gdata.get("email", ""),
            "phone": gdata.get("phone"),
            "child_count": child_count,
            "assigned_schools": assigned_schools,
            "assigned_school_ids": assigned_school_ids,
            "is_pending": is_pending,
            "created_at": gdata.get("created_at"),
        })

    # Apply the name/email search filter in-memory so the bucket expansion
    # above doesn't drown the real match. Empty search returns everything.
    if search_raw:
        def _matches(g: dict) -> bool:
            hay = " ".join([
                (g.get("display_name") or ""),
                (g.get("email") or ""),
            ]).lower()
            return search_lower in hay
        guardians = [g for g in guardians if _matches(g)]

    guardians.sort(
        key=lambda g: (
            0 if g["is_pending"] else 1,  # pending guardians first
            (g.get("display_name") or g.get("email") or "").lower(),
        )
    )
    logger.info(
        "Admin listed %d guardians school=%s search=%r pending=%d",
        len(guardians), school_id, search_raw,
        sum(1 for g in guardians if g["is_pending"]),
    )
    return {"guardians": guardians, "total": len(guardians)}


@app.post("/api/v1/admin/guardians/{guardian_uid}/schools")
def admin_assign_school_to_guardian(
    guardian_uid: str,
    body: AssignSchoolRequest,
    user_data: dict = Depends(require_school_admin),
):
    """
    Assign a school to a guardian. The admin must have access to the school
    being assigned (their own school_id context).
    """
    admin_school_id = user_data["school_id"]
    target_school_id = body.school_id.strip()

    # School admins can only assign their own school
    if user_data.get("role") != "super_admin" and target_school_id != admin_school_id:
        raise HTTPException(
            status_code=403,
            detail="You can only assign guardians to your own school",
        )

    # Verify the target school exists
    school_doc = db.collection("schools").document(target_school_id).get()
    if not school_doc.exists:
        raise HTTPException(status_code=404, detail="School not found")
    school_data = school_doc.to_dict()

    # Verify the guardian exists
    guardian_ref = db.collection("guardians").document(guardian_uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")

    guardian_data = guardian_doc.to_dict()
    assigned = guardian_data.get("assigned_school_ids", [])

    if target_school_id in assigned:
        raise HTTPException(status_code=409, detail="School is already assigned to this guardian")

    assigned.append(target_school_id)
    guardian_ref.update({"assigned_school_ids": assigned})

    logger.info(
        "School assigned guardian=%s school=%s by=%s",
        guardian_uid, target_school_id, user_data["uid"],
    )
    return {
        "status": "assigned",
        "guardian_uid": guardian_uid,
        "school_id": target_school_id,
        "school_name": school_data.get("name", ""),
        "assigned_school_ids": assigned,
    }


@app.delete("/api/v1/admin/guardians/{guardian_uid}/schools/{school_id}")
def admin_remove_school_from_guardian(
    guardian_uid: str,
    school_id: str,
    user_data: dict = Depends(require_school_admin),
):
    """
    Remove a school assignment from a guardian. Only the school's own admin
    can remove their school from a guardian's list.
    """
    admin_school_id = user_data["school_id"]

    # School admins can only remove their own school
    if user_data.get("role") != "super_admin" and school_id != admin_school_id:
        raise HTTPException(
            status_code=403,
            detail="You can only remove your own school from a guardian",
        )

    guardian_ref = db.collection("guardians").document(guardian_uid)
    guardian_doc = guardian_ref.get()
    if not guardian_doc.exists:
        raise HTTPException(status_code=404, detail="Guardian not found")

    guardian_data = guardian_doc.to_dict()
    assigned = guardian_data.get("assigned_school_ids", [])

    if school_id not in assigned:
        raise HTTPException(status_code=404, detail="School is not assigned to this guardian")

    assigned.remove(school_id)
    guardian_ref.update({"assigned_school_ids": assigned})

    logger.info(
        "School removed from guardian=%s school=%s by=%s",
        guardian_uid, school_id, user_data["uid"],
    )
    return {
        "status": "removed",
        "guardian_uid": guardian_uid,
        "school_id": school_id,
        "assigned_school_ids": assigned,
    }


# ---------------------------------------------------------------------------
# Benefactor — Assigned Schools
# ---------------------------------------------------------------------------
@app.get("/api/v1/benefactor/assigned-schools")
def get_assigned_schools(user_data: dict = Depends(require_guardian)):
    """Return the list of schools assigned to this guardian by admins."""
    uid = user_data["uid"]

    if ENV == "development":
        return {"schools": [{"id": DEV_SCHOOL_ID, "name": "Development School"}]}

    guardian_doc = db.collection("guardians").document(uid).get()
    if not guardian_doc.exists:
        return {"schools": []}

    assigned_ids = guardian_doc.to_dict().get("assigned_school_ids", [])
    schools = []
    for sid in assigned_ids:
        sdoc = db.collection("schools").document(sid).get()
        if sdoc.exists:
            sdata = sdoc.to_dict()
            if sdata.get("status") != "suspended":
                schools.append({"id": sid, "name": sdata.get("name", "")})

    schools.sort(key=lambda s: s.get("name", "").lower())
    return {"schools": schools}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=ENV == "development")
