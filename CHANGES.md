# P3 Code Review — Changes & Improvements

## Feature additions (roadmap item #9 — Multi-admin user management — April 2026)

### Role-based access control (RBAC)
- Two roles: `school_admin` (full access) and `staff` (read-only; cannot manage users, import data, delete plates, or clear the queue).
- `verify_firebase_token` now performs a real-time Firestore lookup on every authenticated request:
  - Checks `school_admins/{uid}.status` — disabled accounts are rejected immediately without waiting for the Firebase ID token to expire (which could be up to 1 hour).
  - Merges `role` and `school_id` from Firestore into the decoded token so stale JWT custom claims are always overridden.
  - Legacy users (no `school_admins` record) default to `school_admin` for backwards compatibility.
- New `require_school_admin` FastAPI dependency used on all write/admin endpoints.
- `import_plates`, `delete_plate`, and `clear_scans` migrated from the old `user_data.get("admin")` flag to `require_school_admin`.

### New Firestore collection: `school_admins`
Document ID is `{uid}`. Fields: `uid`, `email`, `display_name`, `school_id`, `role`, `status` (`active` / `disabled` / `pending`), `invited_by_uid`, `invited_at`, `created_at`.

### Backend user management API (all require `school_admin`)
- `GET /api/v1/me` — returns caller's profile; auto-transitions `pending` → `active` on first successful login.
- `GET /api/v1/users` — lists school's users sorted by name; enriched with Firebase Auth `last_sign_in` timestamp and `email_verified`.
- `POST /api/v1/users/invite` — creates Firebase Auth user, sets custom claims (`school_id`, `role`, `p3_admin: true`), writes Firestore record with `status: "pending"`, generates and returns a one-time Firebase password-reset link. Rolls back Auth user creation if custom-claims assignment fails.
- `PATCH /api/v1/users/{uid}/role` — updates Firestore + Firebase custom claims; guards against self-role-change.
- `PATCH /api/v1/users/{uid}/status` — disables/enables Firebase Auth account + Firestore status; guards against self-disable.
- `DELETE /api/v1/users/{uid}` — deletes from Firebase Auth (tolerates `UserNotFoundError`) and Firestore; guards against self-delete.

### Frontend user management
- `App.jsx`: fetches `/api/v1/me` after login; stores `currentUser` (`{uid, email, display_name, role, school_id, status}`) in state and clears it on logout. Passes `currentUser` to Layout → Navbar and LeftNav.
- `Navbar.jsx`: displays logged-in user's display name + a role badge (blue "Admin" / gray "Staff").
- `LeftNav.jsx`: "Admin Users" and "Integrations" menu items rendered only for `school_admin` role.
- `VehicleRegistry.jsx`: delete column and confirmation row hidden for `staff` role.
- `UserManagement.jsx` + `UserManagement.css` (new): Apple-style page with:
  - Searchable user table (name, email, role dropdown, status chip, last login, actions).
  - Inline role change via `<select>` (disabled for self).
  - Enable / Disable toggle button (disabled for self).
  - Trash icon → inline expand-to-confirm delete row with amber background (disabled for self).
  - Invite panel (collapsible) with email + display name + role picker (card-style radio buttons).
  - Post-invite success view shows invite link + copy-to-clipboard button.
  - "You" badge on the current user's own row.

---

## Feature additions (medium-priority roadmap items — April 2026)

### Scan history page
- New `GET /api/v1/history` endpoint: queries `plate_scans` by `school_id` with optional `start_date`/`end_date` filters, decrypts all PII server-side, applies optional `search` text filter in Python (avoids querying encrypted Firestore fields), sorts newest-first, caps at 500 records and returns `{records, total, capped}`.
- New `History.jsx` + `History.css`: paginated table (50 rows/page) with date-range filter bar and client-side full-text search across guardian, student, and location. Confidence score shown as a chip (amber warning below 70%). Export CSV exports all filtered records (not just the current page).

### Vehicle registry (view + delete)
- New `GET /api/v1/plates` endpoint: lists all `plates` documents for the school, decrypts guardian/student names, sorts by guardian name, returns `{plates, total}`.
- New `DELETE /api/v1/plates/{plate_token}` endpoint: verifies school ownership, deletes the Firestore document.
- New `VehicleRegistry.jsx` + `VehicleRegistry.css`: searchable list of all registered plates. Delete action uses inline expand-to-confirm pattern (no modal) with amber row highlight. On success the row is removed from local state immediately.

### CSV export
- New `utils.js` with shared `downloadCSV` (PapaParse `unparse` → Blob URL download), `todayISO`, `formatDateTime`, and `formatDate` helpers.
- Dashboard "Export CSV" button exports the currently visible (filtered/sorted) queue.
- History "Export CSV" button exports all records matching the current date range + search filter.

### Queue sort / filter (Dashboard)
- `Dashboard.jsx` now tracks `sortOrder` ("asc"/"desc") and `locFilter` (location string) in state. `displayQueue` is a `useMemo` of the filtered and sorted queue — no additional API calls.
- Filter bar renders only when the queue is non-empty. Location dropdown is populated from distinct non-null `location` values in the live queue. Separate empty state when a filter yields zero results.

---

## Feature additions (high-priority roadmap items)

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
| `Backend/Generate_P3_API_Token.js` | Password and Firebase API key hard-coded | Removed; token generation should use `firebase admin` CLI or the generate_test_token.py script with env vars |
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

`p3.py` (scanner client):
- Retry with exponential back-off.
- Uses a persistent `requests.Session` (TCP keep-alive, connection pooling).
- `_example_detection_source()` stub shows where to plug in the EdgeTPU inference queue.
- All config via env vars.

## Key rotation required

Because `firebase_credentials.json` was committed to source control, rotate **immediately**:

1. GCP IAM → Service Accounts → `firebase-adminsdk-fbsvc@p3-auth-762da` → **Add new key / delete old key**.
2. Firebase Console → Project Settings → **Regenerate Web API Key**.
3. Firebase Console → Authentication → change `scanner01@p3.local` password.
4. Regenerate `SECRET_KEY` and `P3_ENCRYPTION_KEY` in `.env`.
