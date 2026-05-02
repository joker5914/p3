# Dismissal Code Review — Changes & Improvements

## Feature additions (high-priority roadmap items)

### Temporary / rental vehicle support with auto-expiry (issue #80)
- Guardians can register a vehicle as **Temporary** with a mandatory `valid_until` date and an optional reason ("Rental while car is in shop"). Permanent stays the default so existing flows are untouched.
- Per-school cap (`schools/{id}.temp_vehicle_max_days`, default 30) — admin-configurable via the existing school PATCH surfaces (`/api/v1/site-settings/schools/{id}` and `/api/v1/admin/schools/{id}`). Backend re-validates against the cap on every add/update so a stale client can't stretch past the limit.
- New `expire_temporary_vehicles()` sweep wired into `hourly_maintenance` deletes vehicles whose `valid_until` has passed (using the device timezone for the day boundary), emails the owning guardian via Resend, and writes a `vehicle.temporary.expired` audit event. Guardian-add path writes `vehicle.temporary.created`.
- Guardian portal **Vehicles** tab gains a Permanent/Temporary segmented toggle, a date picker capped at the per-school max, and a reason input. Cards for temp vehicles get a dashed border, clock icon, "Expires in N days" countdown (red ≤ 3 days), and the original reason as a subtitle.
- Admin **Vehicle Registry** table shows a compact `TEMP · Nd` badge next to the plate; turns red within 3 days of expiry, strike-through "expired" until the next sweep deletes it.
- New Firestore composite index on `vehicles(vehicle_type, valid_until)` so the sweep query stays cheap; new audit actions registered in `models/schemas.py`.

### Per-card queue dismissal
- New `DELETE /api/v1/queue/{plate_token}` backend endpoint accepts the plate token directly (avoids re-tokenisation), removes the entry from the in-memory queue, and broadcasts a `{"type": "dismiss", "plate_token": "..."}` WebSocket event to all connected clients for the school.
- Fixed field-name inconsistency: the scan event stored in `QueueManager` and broadcast over WebSocket previously used key `"plate"` for the plate token; renamed to `"plate_token"` to match the REST `/api/v1/dashboard` response.
- `Dashboard.jsx`: each queue card now has a "Picked Up" button. On click it calls the dismiss endpoint, removes the card optimistically, and the WS broadcast ensures other open tabs stay in sync.

### Reports / Summary page
- `GET /api/v1/reports/summary` replaced static stub with real Firestore aggregation: total scan count (all time), today's count, peak hour, per-hour distribution (array of 24 counts), and average confidence score.
- New `Reports.jsx` + `Reports.css`: stat cards for each metric plus a CSS bar chart of the hourly distribution. Accessible via a new "Reports" entry in the left nav.

### System alerts panel
- `GET /api/v1/system/alerts` replaced empty stub with live checks against the in-memory queue:
  - **Low confidence**: average confidence < 60% over current queue entries.
  - **High queue volume**: 15+ vehicles waiting.
  - **Stale queue**: oldest entry > 30 minutes old during school hours (7 AM–5 PM).
- New `Alerts.jsx` + `Alerts.css`: dismissible banner rendered between the top navbar and the main content area. Polls the endpoint every 60 seconds. Silently ignores fetch errors so a transient network issue doesn't produce a spurious alert.

### Password reset flow
- `Login.jsx` now includes a "Forgot password?" link that toggles to a reset form.
- Calls Firebase Auth `sendPasswordResetEmail`; shows a green success message or an inline error. A "← Back to login" link returns to the standard form without a page reload.

## Security

### Critical fixes
| File | Issue | Fix |
|---|---|---|
| `Backend/.env` | Real private keys, tokens, and service-account JSON committed to repo | Replaced with `.env.example`; added `.env` and `firebase_credentials.json` to `.gitignore` |
| `Backend/firebase_credentials.json` / `firestore-credentials.json` | Full GCP service-account private key in source control | **Delete from repo & rotate the key immediately.** Use ADC (Application Default Credentials) in Cloud Run; only use the JSON file locally |
| `Backend/Generate_Dismissal_API_Token.js` | Password and Firebase API key hard-coded | Removed; token generation should use `firebase admin` CLI or the generate_test_token.py script with env vars |
| `Backend/generate_test_user.py` | Password hard-coded | Sourced from env |
| `Frontend/src/api.js` | Backend URL hard-coded to `localhost:8000` | Uses Vite proxy (`/api` → backend) so the URL is never in the browser bundle |
| `Frontend/src/App.jsx` | Firebase ID token stored in `localStorage` (persists across sessions, XSS accessible) | Switched to `sessionStorage` (cleared on tab close) |

### WebSocket authentication
- Original: zero authentication on `/ws/dashboard` — any browser tab could connect.
- Fix: clients pass `?token=<id_token>` query param; server verifies with Firebase Admin in production.

## Backend bugs fixed

### `school_id` missing in dev auth
`verify_firebase_token` in dev mode returned `{"uid": "dev_user", "school_id": "dev_school"}` — but `school_id` was never used consistently; `user_data["school_id"]` would `KeyError` in some paths. Fixed: all paths use `user_data.get("school_id") or user_data.get("uid")`.

### In-memory queue not cleared on `/api/v1/scans/clear`
The original `clear_scans` endpoint deleted Firestore docs and broadcast a `clear` WebSocket event, but **never cleared `queue_manager.active_queue`**. Fixed.

### Firestore batch delete limit
Firestore batches are limited to 500 operations. Original code built one unbounded batch. Fixed with chunked deletes.

### Admin import stored raw PII
`/api/v1/admin/import` stored the raw CSV dict (including names, email, plate) directly in Firestore without any encryption or tokenisation. Replaced with `/api/v1/admin/import-plates` which tokenises plates and encrypts all PII before writing.

### `badge` CSS class missing
`Dashboard.jsx` rendered `<div className="badge">` but `Dashboard.css` had no `.badge` rule — the position number was invisible. Added proper styling.

## Frontend improvements

### Vite proxy
`vite.config.js` now proxies both `/api` (HTTP) and `/ws` (WebSocket) to the backend in development. No hard-coded URLs in the React bundle.

### WebSocket reconnection
- Exponential back-off (starts at 1 s, caps at 30 s) instead of fixed 1 s retry.
- Token rejection (code 4001) triggers logout instead of looping forever.

### Connection status visible to user
- Navbar gains a coloured dot (green = live, amber = reconnecting, red = error).
- Dashboard header shows a "Live" / "Reconnecting…" pill next to the clear button.

### DataImporter improvements
- CSV column names are normalised (trimmed, lowercased) before validation.
- Required columns are validated before sending to the server.
- Preview table shows up to 10 rows before upload.
- Calls the new `/api/v1/admin/import-plates` endpoint.
- Multiple children with the same plate are handled correctly.

## Raspberry Pi / Coral TPU notes

`dismissal.py` (scanner client):
- Retry with exponential back-off.
- Uses a persistent `requests.Session` (TCP keep-alive, connection pooling).
- `_example_detection_source()` stub shows where to plug in the EdgeTPU inference queue.
- All config via env vars.

## Key rotation required

Because `firebase_credentials.json` was committed to source control, rotate **immediately**:

1. GCP IAM → Service Accounts → `firebase-adminsdk-fbsvc@dismissal-cloud` → **Add new key / delete old key**.
2. Firebase Console → Project Settings → **Regenerate Web API Key**.
3. Firebase Console → Authentication → change `scanner01@dismissal.local` password.
4. Regenerate `SECRET_KEY` and `DISMISSAL_ENCRYPTION_KEY` in `.env`.

---

## Bug sweep (April 2026)

Full-stack audit across the GitHub repo, Cloud Run backend, and Firebase
configuration. Bugs found and fixed:

### Backend (`Backend/server.py`)

- **Event-loop blocking on `/api/v1/scan`** — the endpoint was declared
  `async` but every Firestore read, encrypt/decrypt, and the plate-scans
  write was synchronous, stalling the uvicorn event loop on every scan.
  Extracted the resolve/persist pipeline into `_scan_plate_sync` and wrap
  it with `asyncio.to_thread` so concurrent scans no longer serialise.
- **Guardian role injection via `/api/v1/scan`** — the endpoint only
  required `verify_firebase_token` so a logged-in guardian could POST a
  scan and inject arbitrary events into the in-memory queue. Guardians
  are now rejected with 403 at the route entry.
- **Scanner service account misclassified as guardian** —
  `verify_firebase_token` auto-enrolled any Firebase Auth uid without a
  `school_admins` doc as a guardian. A scanner account bootstrapped via
  `bootstrap_super_admin.py` (which sets the `dismissal_admin` custom
  claim) whose Firestore record had been deleted would start scanning
  and then get 403'd by the new guardian check. We now honour the
  `dismissal_admin` claim as a staff-level fallback so the scanner keeps
  working even if its Firestore record is missing.
- **Student last name silently dropped on dashboard reload** — when a
  scan resolved through the vehicle-centric model the plate_scans doc
  only persisted the `first_name_encrypted` ciphertext, so once the
  WebSocket event scrolled off, the dashboard (reading Firestore) lost
  the last name entirely. We now encrypt and store the full display name
  (`first last`) in `student_names_encrypted`.
- **Deprecated `@app.on_event` startup/shutdown hooks** — FastAPI has
  removed these in 0.11x. Replaced with a proper `asynccontextmanager`
  lifespan that also cleanly cancels the archival task on shutdown.
- **Tuple-unpacking bug in `create_school`** — `_ref[1].id` works but
  implicitly relied on tuple positional access; replaced with the
  idiomatic `_, new_ref = db.collection(...).add(record)` pattern used
  elsewhere so the code no longer depends on the tuple layout. Same fix
  applied in `_scan_plate_sync`.
- **Deprecated positional `.where()` calls in `guardian_activity`** —
  google-cloud-firestore emits `DeprecationWarning` for positional args
  and will break in a future major. Switched to keyword `field_path=`,
  `op_string=`, `value=` arguments. Also replaced the hand-rolled
  `decrypt_string`/`try`-`except` with `safe_decrypt`.
- **Wrong field name on `picked_up_by`** — `guardian_activity` returned
  `sdata.get("picked_up_by")` but the actual field written by
  `_mark_picked_up` is `dismissed_by_uid`, so the value was always
  `None`. Serialised timestamps were also Firestore `DatetimeWithNanoseconds`
  objects (not JSON-safe) — now routed through `_format_timestamp`.

### Firebase (`firestore.indexes.json`)

- Added composite index `plates (school_id ASC, authorized_plate_tokens ARRAY_CONTAINS)`
  — required by the "authorized guardian plate" lookup in `scan_plate`.
  Without this index the query fails at runtime with `FAILED_PRECONDITION`.
- Added composite index `plates (school_id ASC, blocked_plate_tokens ARRAY_CONTAINS)`
  — required by the blocked-guardian lookup for the same reason.
- Added index `plate_scans (plate_token ASC, timestamp DESC)` to back
  `guardian_activity`'s ordered `in` query.
- Added index `guardians (assigned_school_ids ARRAY_CONTAINS, created_at DESC)`
  to back the admin "pending guardians" discovery query.

### Frontend (`Frontend/admin-portal/src/`)

- **Polling fallback silently swallowed 401s** (`App.jsx`) — the
  `.catch(() => {})` in the dashboard poller masked expired-token
  errors, leaving the dashboard stuck on stale data after the Firebase
  ID token expired. Now logs the user out on 401 and tolerates
  transient errors.
- **Dashboard card key instability** (`Dashboard.jsx`) — cards were
  keyed on `${entry.plate_token}-${index}`, so every sort-order flip
  remounted every card (losing button state and triggering avoidable
  renders). Switched to a stable key (`firestore_id` → `hash` →
  `plate_token`).
- **`/api/v1/system/alerts` polled with stale super-admin context**
  (`Layout.jsx`, `Alerts.jsx`) — the Alerts bar called the
  school-scoped endpoint every minute even when a super admin was
  viewing the platform root with no school selected, so it received
  alerts for the super-admin's own uid as `school_id`. Now hidden
  entirely until a school context exists, and passes through the
  selected `schoolId` so the backend scopes correctly.
- **`/api/v1/history` 500s when either collection query fails**
  (`server.py`) — after the daily archival moves records from
  `plate_scans` into `scan_history`, the History tab was blanking out
  with a 500 (surfacing in the browser as an opaque CORS error). The
  `plate_scans` query was raising an unwrapped `HTTPException(500)`
  on any failure, and `_format_timestamp` could `AttributeError` on
  an unexpected value type. Both collections are now loaded through
  a shared `_load_collection` helper that logs and returns `[]` on
  failure, per-row decryption/serialisation is wrapped in a
  last-resort try/except, and `_format_timestamp` catches any
  `.isoformat()` failure so a single corrupt row can never take down
  the whole response. Net effect: if a Firestore index is still
  building or a single doc is malformed, the endpoint returns
  whatever it can instead of a 500.
