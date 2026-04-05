# P³ Feature Roadmap

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

### 9. Multi-admin user management
No UI for creating, viewing, or removing admin accounts; it must be done directly in the Firebase console.

**Work needed:**
- Build a `UserManagement.jsx` page (admin-only) that lists Firebase Auth users for the school
- Support invite-by-email (Firebase `createUserWithEmailAndPassword` or email link flow)
- Support disabling / deleting accounts
- Requires a backend proxy for Firebase Admin SDK calls

---

## Lower Priority / Polish

### 10. Dark mode toggle
The CSS uses class-based styling, making a theme toggle straightforward.

**Work needed:**
- Add a `data-theme` attribute toggle on `<body>`
- Define a `[data-theme="dark"]` CSS variable override block in `index.css`
- Persist preference to `localStorage`
- Add toggle button to the navbar

---

### 11. Audio / visual alert for new arrivals
Staff watching the screen during busy pickup periods need an attention signal when a new car arrives.

**Work needed:**
- Play a short chime (Web Audio API or a bundled sound file) on each new `scan` WebSocket event
- Show a toast notification with guardian + student name
- Make the alert optional via a settings toggle

---

### 12. Mobile-responsive layout
The left nav and card grid are not optimised for tablet/phone screens used at the carline.

**Work needed:**
- Add responsive breakpoints to `Layout.css` and `LeftNav.css`
- Collapse the left nav to a hamburger menu on small screens
- Ensure card grid reflows to a single column on narrow viewports

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
