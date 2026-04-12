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


@router.websocket("/ws/dashboard")
async def dashboard_ws(
    websocket: WebSocket,
    token: str = Query(default=None),
):
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
