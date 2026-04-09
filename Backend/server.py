"""
P3 Backend Server — FastAPI

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

from fastapi import FastAPI, HTTPException, Request, Depends, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from datetime import datetime
from typing import Optional, List, Dict
import firebase_admin
from firebase_admin import credentials, auth as fb_auth
from google.cloud import firestore
from secure_lookup import tokenize_plate, encrypt_string, decrypt_string
import hmac
import hashlib
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
    BACKEND_URL = os.getenv("VITE_PROD_BACKEND_URL")
    FRONTEND_URL = os.getenv("VITE_PROD_FRONTEND_URL")
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
app = FastAPI(title="P3 Backend", version="1.1.0")

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
    _cors_origins.append(FRONTEND_URL.rstrip("/"))

_extra_origins = os.getenv("ALLOWED_ORIGINS", "")
for _o in _extra_origins.split(","):
    _o = _o.strip().rstrip("/")
    if _o and _o not in _cors_origins:
        _cors_origins.append(_o)

if ENV == "development":
    for _dev_origin in ["http://localhost:5173", "http://localhost:3000"]:
        if _dev_origin not in _cors_origins:
            _cors_origins.append(_dev_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

    if ENV == "production":
        if not token:
            logger.warning("WS rejected: no token provided")
            await websocket.close(code=4001, reason="Authentication required")
            return
        try:
            decoded = fb_auth.verify_id_token(token)
            school_id = decoded.get("school_id", decoded["uid"])
        except Exception as exc:
            logger.warning("WS rejected: token verification failed: %s", exc)
            await websocket.close(code=4001, reason="Invalid or expired token")
            return
    else:
        school_id = DEV_SCHOOL_ID
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


def _find_firestore_id_by_plate_token(school_id: str, plate_token: str):
    """Look up a Firestore doc ID by plate_token when not found in memory."""
    scans = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .where(field_path="plate_token", op_string="==", value=plate_token)
        .limit(1)
        .stream()
    )
    for scan in scans:
        if not scan.to_dict().get("picked_up_at"):
            return scan.id
    return None

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
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_color: Optional[str] = None
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
    school_code: str
    grade: Optional[str] = None
    photo_url: Optional[str] = None

    @field_validator("first_name", "last_name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
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
    if ENV == "development":
        dev_role = request.headers.get("X-Dev-Role", "").strip().lower()
        if dev_role == "guardian":
            return {
                "uid": "dev_guardian",
                "email": "guardian@p3.local",
                "display_name": "Dev Guardian",
                "role": "guardian",
                "status": "active",
            }
        return {
            "uid": "dev_user",
            "school_id": DEV_SCHOOL_ID,
            "email": "dev@p3.local",
            "role": "school_admin",
            "display_name": "Dev Admin",
            "status": "active",
        }
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    id_token = auth_header.split("Bearer ", 1)[1]
    try:
        decoded = fb_auth.verify_id_token(id_token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    uid = decoded.get("uid")

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
    # Triggered by EITHER:
    #   a) Firestore role == "super_admin"  ← preferred (set via Firebase Console)
    #   b) JWT custom claim super_admin == True  ← legacy / bootstrap script
    # Firestore wins — if Firestore says super_admin, we honour it regardless
    # of what the JWT claims say.
    is_super = (firestore_role == "super_admin") or bool(decoded.get("super_admin"))
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
        # First-time guardian — create profile from Firebase Auth data
        profile = {
            "display_name": decoded.get("name", decoded.get("email", "")),
            "email": decoded.get("email", ""),
            "phone": decoded.get("phone_number"),
            "photo_url": decoded.get("picture"),
            "created_at": datetime.utcnow().isoformat(),
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
            return [decrypt_string(s) for s in enc], enc
        return decrypt_string(enc), enc
    enc = plate_info.get("student_name")
    if enc:
        return decrypt_string(enc), enc
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
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "env": ENV,
    }


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
                first = decrypt_string(sd["first_name_encrypted"]) if sd.get("first_name_encrypted") else ""
                last = decrypt_string(sd["last_name_encrypted"]) if sd.get("last_name_encrypted") else ""
                students_decrypted.append(f"{first} {last}".strip())
                student_photos.append(sd.get("photo_url"))
                student_names_enc.append(sd.get("first_name_encrypted", ""))

        plate_display = decrypt_string(vdata["plate_number_encrypted"]) if vdata.get("plate_number_encrypted") else scan.plate
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
            guardian_name = decrypt_string(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")
            plate_display = decrypt_string(enc_plate_number) if enc_plate_number else None

            auth_guardians = []
            for ag in plate_info.get("authorized_guardians") or []:
                ag_name = decrypt_string(ag["name_encrypted"]) if ag.get("name_encrypted") else ""
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
            primary_guardian = decrypt_string(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")

            # Find which authorized guardian's plate matched
            arriving_guardian = None
            arriving_vehicle = {}
            for ag in plate_info.get("authorized_guardians") or []:
                if ag.get("plate_token") == plate_token:
                    arriving_guardian = decrypt_string(ag["name_encrypted"]) if ag.get("name_encrypted") else ""
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
                "plate_display": decrypt_string(enc_plate_number) if enc_plate_number else scan.plate.upper(),
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
            primary_guardian = decrypt_string(encrypted_parent) if encrypted_parent else None
            enc_plate_number = plate_info.get("plate_number_encrypted")

            # Find which blocked guardian's plate matched
            blocked_name = None
            blocked_reason = None
            blocked_vehicle = {}
            for bg in plate_info.get("blocked_guardians") or []:
                if bg.get("plate_token") == plate_token:
                    blocked_name = decrypt_string(bg["name_encrypted"]) if bg.get("name_encrypted") else ""
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
                "plate_display": decrypt_string(enc_plate_number) if enc_plate_number else scan.plate.upper(),
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

        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        if enc_students:
            if isinstance(enc_students, list):
                students = [decrypt_string(s) for s in enc_students]
            else:
                students = decrypt_string(enc_students)
        else:
            students = None

        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = decrypt_string(enc_parent) if enc_parent else None

        enc_plate = data.get("plate_number_encrypted")
        plate_display = decrypt_string(enc_plate) if enc_plate else None

        # Fallback: look up plate from vehicle/plate registrations if missing
        if not plate_display and data.get("plate_token"):
            _pt = data["plate_token"]
            _vdocs = list(db.collection("vehicles").where(field_path="plate_token", op_string="==", value=_pt).limit(1).stream())
            if _vdocs:
                _enc = _vdocs[0].to_dict().get("plate_number_encrypted")
                plate_display = decrypt_string(_enc) if _enc else None
            if not plate_display:
                _pdoc = db.collection("plates").document(_pt).get()
                if _pdoc.exists:
                    _enc = _pdoc.to_dict().get("plate_number_encrypted")
                    plate_display = decrypt_string(_enc) if _enc else None

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

    # Grab the event before removing so we can update Firestore
    event = queue_manager.get_event(school_id, plate_token)
    queue_manager.remove_event(school_id, plate_token)

    firestore_id = event.get("firestore_id") if event else None

    # Fall back to Firestore lookup if not in in-memory queue (e.g. after server restart)
    if not firestore_id:
        try:
            firestore_id = await asyncio.to_thread(
                _find_firestore_id_by_plate_token, school_id, plate_token
            )
        except Exception as exc:
            logger.warning("Firestore lookup for plate_token=%s failed: %s", plate_token, exc)

    if firestore_id:
        try:
            await asyncio.to_thread(
                _mark_picked_up, firestore_id, pickup_method, user_data.get("uid")
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


@app.delete("/api/v1/scans/clear")
async def clear_scans(user_data: dict = Depends(require_school_admin)):
    school_id = user_data.get("school_id") or user_data.get("uid")

    docs = list(
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )
    refs = [doc.reference for doc in docs]
    if refs:
        await asyncio.to_thread(_firestore_batch_delete, refs)

    queue_manager.clear(school_id)
    logger.info("Cleared %d scans for school=%s", len(refs), school_id)

    await registry.broadcast(school_id, {"type": "clear"})
    return {"status": "success", "deleted_count": len(refs)}


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
            "imported_at": datetime.utcnow().isoformat(),
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
    user_data: dict = Depends(verify_firebase_token),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=500, ge=1, le=500),
):
    """Return scan history (newest first) with optional date-range and name search filters."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    tz = ZoneInfo(DEVICE_TIMEZONE)

    query = (
        db.collection("plate_scans")
        .where(field_path="school_id", op_string="==", value=school_id)
    )

    if start_date:
        try:
            start_dt = datetime.fromisoformat(start_date).replace(
                hour=0, minute=0, second=0, microsecond=0, tzinfo=tz
            )
            query = query.where(field_path="timestamp", op_string=">=", value=start_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start_date — use YYYY-MM-DD")

    if end_date:
        try:
            end_dt = datetime.fromisoformat(end_date).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=tz
            )
            query = query.where(field_path="timestamp", op_string="<=", value=end_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end_date — use YYYY-MM-DD")

    docs = list(query.stream())
    results = []

    for doc in docs:
        data = doc.to_dict()
        enc_students = data.get("student_names_encrypted") or data.get("student_name")
        students: list = (
            [decrypt_string(s) for s in enc_students] if isinstance(enc_students, list)
            else ([decrypt_string(enc_students)] if enc_students else [])
        )
        enc_parent = data.get("parent_name_encrypted") or data.get("parent")
        parent = decrypt_string(enc_parent) if enc_parent else None

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

    logger.info("History fetch: %d records school=%s search=%r", len(results), school_id, search)
    return {"records": results, "total": len(results), "capped": capped}


@app.get("/api/v1/plates")
def list_plates(
    user_data: dict = Depends(verify_firebase_token),
):
    """List all registered plates for the school with decrypted guardian/student names."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    docs = list(
        db.collection("plates")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )

    results = []
    for doc in docs:
        data = doc.to_dict()
        enc_students = data.get("student_names_encrypted")
        students: list = (
            [decrypt_string(s) for s in enc_students] if isinstance(enc_students, list)
            else ([decrypt_string(enc_students)] if enc_students else [])
        )
        enc_parent = data.get("parent")
        parent = decrypt_string(enc_parent) if enc_parent else None

        enc_plate = data.get("plate_number_encrypted")
        plate_display = decrypt_string(enc_plate) if enc_plate else None

        # Decrypt authorized guardians
        auth_guardians = []
        for ag in data.get("authorized_guardians") or []:
            ag_name = decrypt_string(ag["name_encrypted"]) if ag.get("name_encrypted") else ""
            ag_plate_enc = ag.get("plate_number_encrypted")
            auth_guardians.append({
                "name": ag_name,
                "photo_url": ag.get("photo_url"),
                "plate_number": decrypt_string(ag_plate_enc) if ag_plate_enc else None,
                "vehicle_make": ag.get("vehicle_make"),
                "vehicle_model": ag.get("vehicle_model"),
                "vehicle_color": ag.get("vehicle_color"),
            })

        # Decrypt blocked guardians
        blk_guardians = []
        for bg in data.get("blocked_guardians") or []:
            bg_name = decrypt_string(bg["name_encrypted"]) if bg.get("name_encrypted") else ""
            bg_plate_enc = bg.get("plate_number_encrypted")
            blk_guardians.append({
                "name": bg_name,
                "photo_url": bg.get("photo_url"),
                "plate_number": decrypt_string(bg_plate_enc) if bg_plate_enc else None,
                "vehicle_make": bg.get("vehicle_make"),
                "vehicle_model": bg.get("vehicle_model"),
                "vehicle_color": bg.get("vehicle_color"),
                "reason": bg.get("reason"),
            })

        results.append({
            "plate_token": doc.id,
            "plate_display": plate_display,
            "parent": parent,
            "students": students,
            "vehicle_make": data.get("vehicle_make"),
            "vehicle_model": data.get("vehicle_model"),
            "vehicle_color": data.get("vehicle_color"),
            "imported_at": data.get("imported_at"),
            "guardian_photo_url": data.get("guardian_photo_url"),
            "student_photo_urls": data.get("student_photo_urls") or [],
            "authorized_guardians": auth_guardians,
            "blocked_guardians": blk_guardians,
        })

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

    scans = list(
        db.collection("plate_scans")
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
    if body.student_names is not None:
        names = [n.strip() for n in body.student_names if n.strip()]
        if names:
            updates["student_names_encrypted"] = (
                [encrypt_string(n) for n in names] if len(names) > 1
                else encrypt_string(names[0])
            )
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
    if user_data.get("status") == "pending":
        try:
            db.collection("school_admins").document(uid).update({"status": "active"})
            user_data["status"] = "active"
        except Exception as exc:
            logger.warning("pending→active transition failed uid=%s: %s", uid, exc)

    role = user_data.get("role", "school_admin")
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
        base["school_id"] = user_data.get("school_id", "")
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
            "p3_admin": True,
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

    # Delete from Firebase Auth
    try:
        fb_auth.delete_user(target_uid)
    except fb_auth.UserNotFoundError:
        pass  # Already gone from Auth — continue to clean up Firestore
    except Exception as exc:
        logger.error("Firebase delete_user failed uid=%s: %s", target_uid, exc)
        raise HTTPException(status_code=500, detail="Failed to delete user account")

    # Delete Firestore record
    doc_ref.delete()

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
        first = decrypt_string(data["first_name_encrypted"]) if data.get("first_name_encrypted") else ""
        last = decrypt_string(data["last_name_encrypted"]) if data.get("last_name_encrypted") else ""
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

    # Validate school code
    code = body.school_code.strip().upper()
    if ENV == "development":
        school_id = DEV_SCHOOL_ID
        school_name = "Development School"
    else:
        school_docs = list(
            db.collection("schools")
            .where(field_path="enrollment_code", op_string="==", value=code)
            .limit(1)
            .stream()
        )
        if not school_docs:
            raise HTTPException(status_code=404, detail="Invalid school enrollment code")
        school_data = school_docs[0].to_dict()
        if school_data.get("status") == "suspended":
            raise HTTPException(status_code=403, detail="School is currently suspended")
        school_id = school_docs[0].id
        school_name = school_data.get("name", "")

    record = {
        "first_name_encrypted": encrypt_string(body.first_name.strip()),
        "last_name_encrypted": encrypt_string(body.last_name.strip()),
        "school_id": school_id,
        "school_name": school_name,
        "grade": body.grade,
        "photo_url": body.photo_url,
        "guardian_uid": uid,
        "created_at": datetime.utcnow().isoformat(),
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

    updates = {}
    if body.first_name is not None:
        updates["first_name_encrypted"] = encrypt_string(body.first_name.strip())
    if body.last_name is not None:
        updates["last_name_encrypted"] = encrypt_string(body.last_name.strip())
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
    uid = user_data["uid"]
    doc_ref = db.collection("students").document(child_id)
    doc = doc_ref.get()
    if not doc.exists or doc.to_dict().get("guardian_uid") != uid:
        raise HTTPException(status_code=404, detail="Child not found")

    # Also remove this student from any vehicles' student_ids
    vehicles = list(
        db.collection("vehicles")
        .where(field_path="guardian_uid", op_string="==", value=uid)
        .stream()
    )
    for vdoc in vehicles:
        vdata = vdoc.to_dict()
        sids = vdata.get("student_ids", [])
        if child_id in sids:
            sids.remove(child_id)
            db.collection("vehicles").document(vdoc.id).update({"student_ids": sids})

    doc_ref.delete()
    logger.info("Child removed id=%s guardian=%s", child_id, uid)
    return {"status": "deleted", "id": child_id}


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
        plate = decrypt_string(data["plate_number_encrypted"]) if data.get("plate_number_encrypted") else ""
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
        "created_at": datetime.utcnow().isoformat(),
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
        "school_ids": school_ids,
        "student_ids": student_ids,
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


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=ENV == "development")
