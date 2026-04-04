# P3 Code Review — Changes & Improvements

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
