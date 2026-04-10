# Dismissal Feature Roadmap

This file tracks feature recommendations for the admin portal. Items are grouped by priority. Move an item to `CHANGES.md` when it ships.

---

## High Priority

### ~~1. Individual card dismissal — mark vehicle as picked up~~ ✅ Shipped
Added "Picked Up" button to each queue card. Calls new `DELETE /api/v1/queue/{plate_token}` endpoint, removes the card locally and broadcasts a `dismiss` WebSocket event so all connected screens update in real time. Also normalised the `plate_token` field name consistently across the WS scan event and queue manager.

---

### ~~2. Reports / Summary page~~ ✅ Shipped
`Reports.jsx` page added with real backend aggregation: total scans, today's count, peak hour, average confidence score, and a CSS hourly bar chart. Accessible via "Reports" in the left nav.

---

### ~~3. System alerts panel~~ ✅ Shipped
`Alerts.jsx` banner added to the layout (below the navbar). Polls `/api/v1/system/alerts` every 60 seconds. Backend now returns real alerts: low scanner confidence, large queue volume, and stale queue entries during school hours. Each alert is individually dismissible.

---

### ~~4. Password reset flow~~ ✅ Shipped
"Forgot password?" link added to `Login.jsx`. Toggles to a reset form that calls Firebase `sendPasswordResetEmail`. Shows a confirmation or error message inline.

---

## Medium Priority

### ~~5. Scan history / audit log~~ ✅ Shipped
`History.jsx` page added with a paginated, searchable table of past `plate_scans` records. Supports date-range filtering (start/end date inputs) and client-side full-text search across guardian, student, and location fields. Fetches from new `GET /api/v1/history` backend endpoint (decrypts PII server-side, sorts newest-first, caps at 500 records). Pagination at 50 rows per page with full "Export CSV" support for all matching records.

---

### ~~6. Vehicle registry management (list + delete)~~ ✅ Shipped (partial — view & delete only)
`VehicleRegistry.jsx` page lists all registered plates for the school via new `GET /api/v1/plates` endpoint. Each row supports inline delete confirmation (no modal; expands in-place) backed by new `DELETE /api/v1/plates/{plate_token}` endpoint. Edit/update skipped to avoid re-encryption complexity — re-import via Data Import is the recommended path. Client-side search filters across guardian, student names, and vehicle fields.

---

### ~~7. CSV export~~ ✅ Shipped
Export CSV buttons added to both Dashboard (current visible queue) and History (all filtered scan records). Client-side generation via PapaParse `unparse`. Shared `downloadCSV` and `todayISO` helpers in new `utils.js`.

---

### ~~8. Queue sort / filter controls~~ ✅ Shipped
Sort (oldest/newest first) and location filter dropdown added to the Dashboard filter bar. All filtering is client-side via `useMemo`. Filter bar only appears when the queue has entries. Clear filter link resets the location filter.

---

### ~~9. Multi-admin user management~~ ✅ Shipped
Full role-based user management system implemented. No more direct Firebase Console access needed.

**What shipped:**
- Two-tier role system: `school_admin` (full access) and `staff` (read-only, no user management)
- `GET /api/v1/me` — returns caller's profile; transitions invited users from `pending` → `active` on first login
- `GET /api/v1/users` — lists all users for the school, enriched with Firebase Auth last-login and email_verified
- `POST /api/v1/users/invite` — creates Firebase Auth account, sets custom claims, writes Firestore record, returns a one-time password-reset link the admin shares with the invitee
- `PATCH /api/v1/users/{uid}/role` — changes role in Firestore + custom claims
- `PATCH /api/v1/users/{uid}/status` — disables/enables in Firebase Auth + Firestore (real-time revocation; doesn't wait for JWT expiry)
- `DELETE /api/v1/users/{uid}` — removes from Firebase Auth and Firestore
- `verify_firebase_token` now performs a Firestore lookup on every request to enforce real-time status and always-fresh role resolution
- `UserManagement.jsx` page: searchable user table with inline role dropdown, enable/disable toggle, inline delete confirmation; invite panel with role picker and copy-to-clipboard invite link
- LeftNav hides "Admin Users" and "Integrations" items from `staff` role users
- Registry delete buttons hidden for `staff`; navbar shows user display name and role badge

---

## Lower Priority / Polish

### ~~10. Dark mode toggle~~ ✅ Shipped
Full dark theme with smooth transitions, respecting system preference.

**What shipped:**
- `[data-theme="dark"]` CSS variable override block in `index.css` with a rich, Apple-inspired dark palette (deep backgrounds, muted text, adjusted status colours)
- Dark mode overrides for every component: Navbar, LeftNav, Dashboard cards, Alerts, Login, History, Reports, VehicleRegistry, UserManagement, PlatformAdmin
- Sun/Moon toggle button in the navbar with spring animation
- Preference persisted to `localStorage` (`dismissal-theme`); falls back to `prefers-color-scheme` media query on first visit
- `useTheme` hook in `Navbar.jsx` manages `data-theme` attribute on `<body>`

---

### ~~11. Audio / visual alert for new arrivals~~ ✅ Shipped
Staff now get an audio chime and visual toast when a new vehicle arrives.

**What shipped:**
- `ArrivalToast.jsx` component with `useArrivalAlerts` hook
- Two-note ascending sine-wave chime (E5→A5) via Web Audio API on each `scan` WebSocket event
- Slide-in toast notifications (bottom-right, max 5 stacked) showing guardian name and students — auto-dismiss after 4.5s with smooth exit animation
- Bell toggle button in the navbar to mute/unmute alerts; preference persisted to `localStorage` (`dismissal-arrival-alerts`)
- Full dark mode and mobile-responsive toast styling
- Wired into the WebSocket `scan` handler in `App.jsx` via stable ref

---

### ~~12. Mobile-responsive layout~~ ✅ Shipped
The admin portal now works on tablets and phones used at the carline.

**What shipped:**
- Hamburger menu button in the navbar (visible below 768px) toggles the sidebar as a slide-out drawer
- LeftNav slides in from the left with backdrop overlay; closes on navigation, overlay click, or Escape key
- Dashboard card grid reflows to a single column on narrow viewports; filter bar stacks vertically
- History, VehicleRegistry, and UserManagement tables scroll horizontally on small screens
- Reports stat cards reflow to smaller minimum column widths
- All page containers use tighter padding on mobile
- Navbar hides the search bar and user info text on small screens to save space

---

### 13. School logo / branding customisation
The login page has a commented-out `<img>` logo slot. Schools should be able to set their own branding.

**Work needed:**
- Uncomment and wire the logo slot in `Login.jsx` and `Navbar.jsx`
- Add a logo URL field to the school's Firestore document
- Fetch and display on login and in the top navbar

---

### 14. Idle session timeout
`sessionStorage` persists until the tab is closed. An unattended logged-in tab is a risk.

**Work needed:**
- Add an inactivity timer (e.g. 30 minutes) that calls `handleLogout` automatically
- Reset the timer on any user interaction (mouse/keyboard events)
- Show a "Session expiring in 2 minutes" warning modal before logging out

---

### 15. Confidence score threshold warning
Low-confidence plate reads may cause mismatches. Cards below a threshold should be visually flagged.

**Work needed:**
- Define a configurable threshold (default 70%) in app config or a settings page
- Apply a warning style (amber border, icon) to cards where `confidence_score < threshold`
- Optionally add a tooltip explaining the low-confidence flag to staff
