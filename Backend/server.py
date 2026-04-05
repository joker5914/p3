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
if ENV == "development":
    _cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "firebase_credentials.json")
    if not firebase_admin._apps:
        cred = credentials.Certificate(_cred_path)
        firebase_admin.initialize_app(cred)
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
    if ENV == "production":
        if not token:
            await websocket.close(code=4001)
            return
        try:
            decoded = fb_auth.verify_id_token(token)
            school_id = decoded.get("school_id", decoded["uid"])
        except Exception:
            await websocket.close(code=4001)
            return
    else:
        school_id = DEV_SCHOOL_ID

    await websocket.accept()
    registry.add(school_id, websocket)
    logger.info("WS connected: school=%s", school_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
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


queue_manager = QueueManager()

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


# ---------------------------------------------------------------------------
# Authentication helpers
# ---------------------------------------------------------------------------
def verify_firebase_token(request: Request) -> dict:
    """
    Verify the Firebase ID token and enrich with role/status from Firestore.

    Role resolution order (Firestore wins over stale JWT claims):
      1. Query school_admins/{uid} — always fresh.
      2. If no record exists (legacy user), default role to 'school_admin'
         so pre-migration users are not locked out.
      3. If status == 'disabled' in Firestore, reject immediately — this is
         the real-time revocation path (JWT itself stays valid up to 1 hour).
    """
    if ENV == "development":
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

    # Real-time status + role from Firestore (overrides potentially stale JWT claims)
    try:
        admin_doc = db.collection("school_admins").document(uid).get()
        if admin_doc.exists:
            admin_data = admin_doc.to_dict()
            if admin_data.get("status") == "disabled":
                raise HTTPException(status_code=403, detail="Account is disabled")
            decoded["role"] = admin_data.get("role", decoded.get("role", "school_admin"))
            decoded["school_id"] = (
                admin_data.get("school_id") or decoded.get("school_id") or uid
            )
            decoded["display_name"] = admin_data.get("display_name", "")
            decoded["status"] = admin_data.get("status", "active")
        else:
            # Legacy user — no school_admins record yet; treat as school_admin
            decoded.setdefault("role", "school_admin")
            decoded.setdefault("school_id", decoded.get("school_id") or uid)
            decoded.setdefault("display_name", "")
            decoded.setdefault("status", "active")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("school_admins lookup failed uid=%s: %s", uid, exc)
        decoded.setdefault("role", "school_admin")
        decoded.setdefault("school_id", decoded.get("school_id") or uid)

    return decoded


def require_school_admin(user_data: dict = Depends(verify_firebase_token)) -> dict:
    """Dependency that rejects any caller whose role is not 'school_admin'."""
    if user_data.get("role") != "school_admin":
        raise HTTPException(status_code=403, detail="School admin role required")
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

    plate_doc = db.collection("plates").document(plate_token).get()
    if not plate_doc.exists:
        raise HTTPException(status_code=404, detail="Plate not found in registry")

    plate_info = plate_doc.to_dict()

    if plate_info.get("school_id") and plate_info["school_id"] != school_id:
        raise HTTPException(status_code=403, detail="Plate not registered to this school")

    decrypted_students, encrypted_students = _decrypt_students(plate_info)
    encrypted_parent = plate_info.get("parent")
    decrypted_parent = decrypt_string(encrypted_parent) if encrypted_parent else None

    event_hash = generate_hash(scan.plate, local_timestamp)
    event = {
        "plate_token": plate_token,
        "student": decrypted_students,
        "parent": decrypted_parent,
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "school_id": school_id,
    }
    queue_manager.add_event(school_id, event)

    firestore_doc = {
        "plate_token": plate_token,
        "student_names_encrypted": encrypted_students,
        "parent_name_encrypted": encrypted_parent,
        "timestamp": local_timestamp,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "hash": event_hash,
        "school_id": school_id,
    }
    doc_ref = db.collection("plate_scans").add(firestore_doc)
    firestore_id = doc_ref[1].id

    logger.info("Scan recorded: plate_token=%s school=%s", plate_token, school_id)
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

        results.append({
            "plate_token": data.get("plate_token"),
            "student": students,
            "parent": parent,
            "timestamp": _format_timestamp(data.get("timestamp")),
            "location": data.get("location"),
            "confidence_score": data.get("confidence_score"),
            "hash": data.get("hash"),
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
async def dismiss_from_queue(plate_token: str, user_data: dict = Depends(verify_firebase_token)):
    """Dismiss a single entry from the live queue by its plate token."""
    school_id = user_data.get("school_id") or user_data.get("uid")
    queue_manager.remove_event(school_id, plate_token)
    await registry.broadcast(school_id, {"type": "dismiss", "plate_token": plate_token})
    logger.info("Dismissed plate_token=%s from queue for school=%s", plate_token, school_id)
    return {"status": "dismissed", "plate_token": plate_token}


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

        results.append({
            "plate_token": doc.id,
            "parent": parent,
            "students": students,
            "vehicle_make": data.get("vehicle_make"),
            "vehicle_model": data.get("vehicle_model"),
            "vehicle_color": data.get("vehicle_color"),
            "imported_at": data.get("imported_at"),
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


@app.put("/api/v1/vehicles/{vehicle_id}")
def update_vehicle(
    vehicle_id: str,
    update: VehicleUpdate,
    user_data: dict = Depends(verify_firebase_token),
):
    return {"vehicle_id": vehicle_id, "updated": update.model_dump()}


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

    return {
        "uid": uid,
        "email": user_data.get("email", ""),
        "display_name": user_data.get("display_name", ""),
        "role": user_data.get("role", "school_admin"),
        "school_id": user_data.get("school_id", ""),
        "status": user_data.get("status", "active"),
    }


# ---------------------------------------------------------------------------
# User management  (school_admin only)
# ---------------------------------------------------------------------------
@app.get("/api/v1/users")
def list_users(user_data: dict = Depends(require_school_admin)):
    """List all admin/staff users for the calling user's school."""
    school_id = user_data.get("school_id") or user_data.get("uid")

    docs = list(
        db.collection("school_admins")
        .where(field_path="school_id", op_string="==", value=school_id)
        .stream()
    )

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
        raise HTTPException(status_code=500, detail="Failed to create user account")

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
        invite_link = fb_auth.generate_password_reset_link(body.email)
    except Exception as exc:
        logger.warning("generate_password_reset_link failed for %s: %s", body.email, exc)

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


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=ENV == "development")
