"""WebSocket connection registry and /ws/dashboard endpoint."""
import asyncio
import json
import logging
import threading
from datetime import datetime
from typing import Dict, List

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from firebase_admin import auth as fb_auth

from config import DEV_SCHOOL_ID, ENV
from core.firebase import db

logger = logging.getLogger(__name__)

router = APIRouter()


def _serialise(data: dict) -> str:
    def _default(obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")
    return json.dumps(data, default=_default)


class ConnectionRegistry:
    """Per-school WebSocket rooms."""

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

    def all_sockets(self) -> List[WebSocket]:
        with self._lock:
            return [ws for sockets in self._rooms.values() for ws in sockets]


registry = ConnectionRegistry()


def _resolve_school_id(decoded: dict, requested_school_id: str | None = None) -> str | None:
    """Resolve which school room this WS should join.

    Mirrors the HTTP ``verify_firebase_token`` school-scoping logic so
    a Platform Admin (super_admin / district_admin) viewing a specific
    campus actually subscribes to that campus's broadcast room instead
    of silently falling back to their uid-keyed room (which never
    receives scan events, so the dashboard looks frozen until a manual
    refresh fetches the list via the REST endpoint).

    ``requested_school_id`` is the ``school_id`` query param from the
    client; it's honoured only when the caller has actual access to it.
    Returns ``None`` when an elevated admin hasn't picked a campus yet —
    the WS handler should reject the connection in that case.
    """
    uid = decoded.get("uid")
    requested = (requested_school_id or "").strip() or None
    try:
        admin_doc = db.collection("school_admins").document(uid).get()
    except Exception as exc:
        logger.warning("WS school_id lookup failed uid=%s: %s", uid, exc)
        admin_doc = None

    if admin_doc and admin_doc.exists:
        admin_data = admin_doc.to_dict() or {}
        role = admin_data.get("role", "school_admin")
        if role == "district_admin":
            return requested
        school_ids = list(admin_data.get("school_ids") or [])
        legacy = admin_data.get("school_id")
        if legacy and legacy not in school_ids:
            school_ids.insert(0, legacy)
        if requested and requested in school_ids:
            return requested
        if school_ids:
            return school_ids[0]
        return legacy or None

    # No school_admins doc — super_admin (platform role via a different
    # collection) or a scanner/guardian token.  Trust the query param
    # for these; the JWT claim is the fallback.
    return requested or decoded.get("school_id") or uid


@router.websocket("/ws/dashboard")
async def dashboard_ws(
    websocket: WebSocket,
    token: str = Query(default=None),
    school_id: str = Query(default=None),
):
    await websocket.accept()

    if token:
        try:
            decoded = fb_auth.verify_id_token(token)
            school_id = _resolve_school_id(decoded, school_id)
        except Exception as exc:
            logger.warning("WS rejected: token verification failed: %s", exc)
            await websocket.close(code=4001, reason="Invalid or expired token")
            return
        if not school_id:
            # Elevated admin hasn't selected a campus — nothing to stream.
            await websocket.close(code=4002, reason="No active school selected")
            return
    elif ENV == "development":
        school_id = DEV_SCHOOL_ID
    else:
        logger.warning("WS rejected: no token provided")
        await websocket.close(code=4001, reason="Authentication required")
        return

    registry.add(school_id, websocket)
    logger.info("WS connected: school=%s", school_id)

    async def _ping_loop():
        try:
            while True:
                await asyncio.sleep(30)
                await websocket.send_text('{"type":"ping"}')
        except Exception:
            pass

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
