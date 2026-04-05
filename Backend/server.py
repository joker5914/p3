"""
P3 Backend Server — FastAPI

Changes from original:
  - Fixed school_id scoping throughout all handlers
  - WebSocket requires Bearer token via ?token= query param
  - /api/v1/admin/import-plates tokenises & encrypts PII before storing
  - Queue cleared on clear event (was only broadcast)
  - Firestore batch deletes chunked at 500 (Firestore hard limit)
  - Per-school WebSocket rooms (broadcasts scoped to school_id)
  - CORS origins driven by env
  - $PORT support in uvicorn for Cloud Run
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

_cors_origins = [FRONTEND_URL] if FRONTEND_URL else []
if ENV == "development":
    _cors_origins.extend(["http://localhost:5173", "http://localhost:3000"])

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


# ---------------------------------------------------------------------------
# Authentication helper
# ---------------------------------------------------------------------------
def verify_firebase_token(request: Request) -> dict:
    if ENV == "development":
        return {
            "uid": "dev_user",
            "school_id": DEV_SCHOOL_ID,
            "email": "dev@p3.local",
        }
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    id_token = auth_header.split("Bearer ", 1)[1]
    try:
        return fb_auth.verify_id_token(id_token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


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
async def clear_scans(user_data: dict = Depends(verify_firebase_token)):
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
    user_data: dict = Depends(verify_firebase_token),
):
    if ENV == "production" and not user_data.get("admin"):
        raise HTTPException(status_code=403, detail="Admin role required")

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


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=ENV == "development")
