from fastapi import FastAPI, HTTPException, Request, Depends, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List
import firebase_admin
from firebase_admin import credentials, auth
from google.cloud import firestore
from secure_lookup import tokenize_plate, encrypt_string, decrypt_string
import hmac, hashlib, os, threading, logging, asyncio, json
from dotenv import load_dotenv
from zoneinfo import ZoneInfo

load_dotenv()

ENV = os.getenv("ENV", "development")

# Dynamically set URLs and Tokens (for reference)
if ENV == "production":
    BACKEND_URL = os.getenv("VITE_PROD_BACKEND_URL")
    FRONTEND_URL = os.getenv("VITE_PROD_FRONTEND_URL")
    API_TOKEN = os.getenv("PROD_P3_API_TOKEN")
else:
    BACKEND_URL = os.getenv("VITE_DEV_BACKEND_URL")
    FRONTEND_URL = os.getenv("VITE_DEV_FRONTEND_URL")
    API_TOKEN = os.getenv("DEV_P3_API_TOKEN")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# === Add CORS Middleware ===
origins = [
    "http://localhost:5173",
    # Add additional origins if needed
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# === End CORS Middleware ===

# === Realtime: WebSocket Setup ===
active_websockets = []

@app.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
    try:
        # Keep connection open. Optionally, listen for incoming messages.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_websockets.remove(websocket)

async def broadcast_event(message_data: dict):
    """
    Expects message_data to be a dict like:
    {
      "type": "scan", "data": { ... }
    }
    or
    {
      "type": "clear"
    }
    """
    # If this is a scan event, ensure its timestamp is a string.
    if message_data.get("type") == "scan":
        evt = message_data.get("data", {})
        if "timestamp" in evt and isinstance(evt["timestamp"], datetime):
            evt["timestamp"] = evt["timestamp"].isoformat()
        message_data["data"] = evt

    message = json.dumps(message_data)
    for ws in active_websockets.copy():
        try:
            await ws.send_text(message)
        except Exception:
            active_websockets.remove(ws)


# === End WebSocket Setup ===

# Initialize Firebase & Firestore conditionally based on environment
if ENV == "development":
    cred = credentials.Certificate("firebase_credentials.json")
    firebase_admin.initialize_app(cred)
    db = firestore.Client.from_service_account_json("firebase_credentials.json")
else:
    # firebase_admin.initialize_app()
    # db = firestore.Client()
    pass

# Secret key setup
secret_key_raw = os.getenv('SECRET_KEY')
if not secret_key_raw:
    raise RuntimeError("SECRET_KEY environment variable is not set")
SECRET_KEY = secret_key_raw.encode()

# Queue Manager
class QueueManager:
    def __init__(self):
        self.active_queue = []
        self.queue_lock = threading.Lock()
    def add_event(self, event):
        with self.queue_lock:
            self.active_queue.append(event)
    def get_sorted_queue(self):
        with self.queue_lock:
            return sorted(self.active_queue, key=lambda x: x['timestamp'])
    def remove_event(self, plate):
        with self.queue_lock:
            self.active_queue = [e for e in self.active_queue if e["plate"] != plate]

queue_manager = QueueManager()

# Models
class PlateScan(BaseModel):
    plate: str
    timestamp: datetime  # Stored as a Firestore Timestamp
    location: Optional[str] = None
    confidence_score: Optional[float] = None

class VehicleUpdate(BaseModel):
    plate_number: Optional[str] = None
    vehicle_details: Optional[dict] = None

# Authentication (DEV simplified)
def verify_firebase_token(request: Request):
    if ENV == "development":
        return {"uid": "dev_user", "school_id": "dev_school", "email": "dev@yourcompany.com"}
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    id_token = auth_header.split("Bearer ")[1]
    try:
        return auth.verify_id_token(id_token)
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

# Helpers
def generate_hash(plate: str, timestamp: datetime) -> str:
    message = f"{plate}{timestamp.isoformat()}".encode()
    return hmac.new(SECRET_KEY, message, hashlib.sha256).hexdigest()

def write_scan_to_firestore(scan_data: dict) -> str:
    doc_ref = db.collection("plate_scans").add(scan_data)
    return doc_ref[1].id

def format_timestamp(ts):
    if not ts:
        return None
    if isinstance(ts, str):
        return ts
    return ts.isoformat()

# Updated scan endpoint as async for realtime broadcasting
@app.post("/api/v1/scan")
async def scan_plate(scan: PlateScan, user_data=Depends(verify_firebase_token)):
    # Convert the scan timestamp to the device's local timezone.
    device_tz = os.getenv("DEVICE_TIMEZONE", "America/New_York")
    if scan.timestamp.tzinfo is None:
        local_timestamp = scan.timestamp.replace(tzinfo=ZoneInfo(device_tz))
    else:
        local_timestamp = scan.timestamp.astimezone(ZoneInfo(device_tz))

    plate_token = tokenize_plate(scan.plate)
    plate_doc = db.collection("plates").document(plate_token).get()
    if not plate_doc.exists:
        raise HTTPException(status_code=404, detail="Plate not found")
    plate_info = plate_doc.to_dict()

    # Check if multiple children are stored; if so, decrypt each name.
    if "student_names_encrypted" in plate_info:
        stored_students = plate_info["student_names_encrypted"]
        if isinstance(stored_students, list):
            decrypted_students = [decrypt_string(s) for s in stored_students]
        else:
            decrypted_students = decrypt_string(stored_students)
        encrypted_students = stored_students
    else:
        decrypted_students = decrypt_string(plate_info["student_name"])
        encrypted_students = plate_info["student_name"]

    event_hash = generate_hash(scan.plate, local_timestamp)
    event = {
        "plate": plate_token,
        "student": decrypted_students,
        "parent": decrypt_string(plate_info["parent"]),
        "timestamp": local_timestamp,
        "hash": event_hash,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "school_id": user_data["school_id"]
    }
    queue_manager.add_event(event)

    firestore_id = write_scan_to_firestore({
        "plate_token": plate_token,
        "student_names_encrypted": encrypted_students,
        "parent_name_encrypted": plate_info["parent"],
        "timestamp": local_timestamp,
        "location": scan.location,
        "confidence_score": scan.confidence_score,
        "hash": event_hash,
        "school_id": user_data["school_id"]
    })

    logger.info(f"New plate event for {event['plate']} added at {local_timestamp}.")

    # Broadcast the new event in a structured format.
    await broadcast_event({
        "type": "scan",
        "data": event
    })

    # Return a minimal response so the client doesn't update state from HTTP.
    return {"status": "success", "firestore_id": firestore_id}

@app.get("/api/v1/dashboard")
def get_dashboard(user_data=Depends(verify_firebase_token)):
    school_id = user_data["school_id"]

    scans_query = db.collection("plate_scans") \
                    .where(field_path="school_id", op_string="==", value=school_id) \
                    .order_by("timestamp", direction=firestore.Query.ASCENDING) \
                    .stream()

    def format_timestamp(ts):
        if not ts:
            return None
        if isinstance(ts, str):
            return ts
        return ts.isoformat()

    sorted_scans = []
    for scan in scans_query:
        data = scan.to_dict()  # Convert the document to a dict
        # Try to get the encrypted student names from the new key; fallback to the old key.
        encrypted_students = data.get("student_names_encrypted", data.get("student_name"))
        if encrypted_students:
            if isinstance(encrypted_students, list):
                decrypted_students = [decrypt_string(s) for s in encrypted_students]
            else:
                decrypted_students = decrypt_string(encrypted_students)
        else:
            decrypted_students = None

        # Do the same for the parent field.
        encrypted_parent = data.get("parent_name_encrypted", data.get("parent"))
        decrypted_parent = decrypt_string(encrypted_parent) if encrypted_parent else None

        sorted_scans.append({
            "plate_token": data.get("plate_token"),
            "student": decrypted_students,
            "parent": decrypted_parent,
            "timestamp": format_timestamp(data.get("timestamp")),
            "location": data.get("location"),
            "confidence_score": data.get("confidence_score"),
            "hash": data.get("hash"),
        })

    logger.info(f"Fetched {len(sorted_scans)} scan records for school_id: {school_id}")

    return JSONResponse(
        content={"queue": sorted_scans},
        headers={"Cache-Control": "no-store"}
    )

@app.delete("/api/v1/plate/{plate}")
def remove_plate(plate: str, user_data=Depends(verify_firebase_token)):
    queue_manager.remove_event(plate)
    return {"status": "removed", "plate": plate}

@app.get("/api/v1/system/health")
def system_health():
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    return {"status": "healthy", "timestamp": current_time}

@app.post("/api/v1/auth/logout")
def logout(user_data=Depends(verify_firebase_token)):
    return {"status": "logged out", "user": user_data["uid"]}

@app.get("/api/v1/reports/summary")
def summary_report(user_data=Depends(verify_firebase_token)):
    return {"average_wait_time": "5 mins", "peak_period": "3:00-3:30 PM"}

@app.get("/api/v1/system/alerts")
def system_alerts(user_data=Depends(verify_firebase_token)):
    return {"alerts": []}

@app.put("/api/v1/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: str, update: VehicleUpdate, user_data=Depends(verify_firebase_token)):
    return {"vehicle_id": vehicle_id, "updated": update.dict()}

@app.post("/api/v1/admin/import")
def admin_import(data: List[dict], user_data=Depends(verify_firebase_token)):
    if not user_data.get("email", "").endswith("@yourcompany.com"):
        raise HTTPException(status_code=403, detail="Not authorized for admin import")
    count = 0
    for record in data:
        db.collection("imported_data").add(record)
        count += 1
    return {"status": "imported", "count": count}

@app.delete("/api/v1/scans/clear")
async def clear_scans(user_data=Depends(verify_firebase_token)):
    school_id = user_data["school_id"]
    docs = db.collection("plate_scans").where(field_path="school_id", op_string="==", value=school_id).stream()

    batch = db.batch()
    count = 0
    for doc in docs:
        batch.delete(doc.reference)
        count += 1

    if count > 0:
        await asyncio.to_thread(batch.commit)
        logger.info(f"Cleared {count} scans for school_id: {school_id}")
    else:
        logger.info(f"No scans to clear for school_id: {school_id}")

    await broadcast_event({"type": "clear"})
    return {"status": "success", "deleted_count": count}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
