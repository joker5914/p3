"""
DEPRECATED — this file is retired.

The monolithic server.py (~2,700 lines) has been decomposed into focused modules.
The FastAPI application entry point is now Backend/main.py.

Module map:
  Backend/main.py              — app init, CORS, startup/shutdown, uvicorn entry
  Backend/config.py            — env vars, logging setup
  Backend/models/schemas.py    — all Pydantic models + permission constants
  Backend/core/firebase.py     — Firebase/Firestore init, SECRET_KEY
  Backend/core/auth.py         — verify_firebase_token, require_* dependencies
  Backend/core/websocket.py    — ConnectionRegistry, /ws/dashboard endpoint
  Backend/core/queue.py        — QueueManager, archival loop
  Backend/core/utils.py        — generate_hash, localise, batch helpers
  Backend/routes/scan.py       — POST /scan, GET /dashboard, queue endpoints
  Backend/routes/history.py    — GET /history, reports, insights, alerts, health
  Backend/routes/plates.py     — GET/PATCH/DELETE /plates, import-plates
  Backend/routes/users.py      — /users/*, /me, /permissions
  Backend/routes/schools.py    — /admin/schools/*, /schools/lookup
  Backend/routes/guardian.py   — /benefactor/*, /auth/guardian-signup
  Backend/routes/admin.py      — /admin/students/*, /admin/guardians/*

Do not add code here. Add it to the appropriate module above.
"""

# Re-export app for any tooling that still references 'server:app'
# Remove this once all deployment configs point to 'main:app'
from main import app  # noqa: F401
