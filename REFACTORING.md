# Dismissal — Codebase Refactoring Roadmap

This document tracks large-file violations across the codebase and provides concrete
decomposition plans for each one. The rule is **400 lines maximum per file**. Files
approaching 350 lines should be flagged during review.

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Healthy (<350 lines) |
| 🟡 | Yellow zone (350–449 lines) — monitor |
| 🟠 | Orange zone (450–499 lines) — refactor soon |
| 🔴 | Red zone (500+ lines) — must refactor before adding code |
| 🔵 | PR open / refactor complete on branch |

---

## Backend

### `Backend/server.py` — ~2,700 lines 🔵

**PR open:** `refactor/modular-backend` → `master`

Already fully decomposed into:
```
Backend/
├── main.py                   # app init, CORS, startup/shutdown, uvicorn entry
├── config.py                 # all env vars + logging setup
├── models/schemas.py         # 20+ Pydantic models + permission constants
├── core/firebase.py          # Firebase/Firestore init, SECRET_KEY
├── core/auth.py              # verify_token, require_* dependencies, permissions
├── core/websocket.py         # ConnectionRegistry, /ws/dashboard
├── core/queue.py             # QueueManager, archival loop
├── core/utils.py             # generate_hash, localise, batch helpers
├── routes/scan.py            # POST /scan, GET /dashboard, queue endpoints
├── routes/history.py         # GET /history, reports, insights, alerts, health
├── routes/plates.py          # GET/PATCH/DELETE /plates, import-plates
├── routes/users.py           # /users/*, /me, /permissions
├── routes/schools.py         # /admin/schools/*, /schools/lookup
├── routes/guardian.py        # /benefactor/*, /auth/guardian-signup
└── routes/admin.py           # /admin/students/*, /admin/guardians/*
```
**Action:** Merge the PR and update `Dockerfile` CMD from `server:app` to `main:app`.

---

### `Backend/dismissal.py` — ~380 lines 🟡

Currently in the yellow zone. This file handles Coral TPU camera integration, plate
recognition, and API posting. As new camera features are added it will breach 400 lines.

**Proposed split when it crosses 400 lines:**
```
Backend/
├── dismissal.py              # main loop, CLI entry point (~150 lines, keep)
├── dismissal_camera.py       # Coral TPU init, frame capture, confidence scoring
├── dismissal_api.py          # HTTP client logic: POST /scan, auth token refresh
└── dismissal_plate.py        # plate text extraction, normalisation, deduplication
```
**Action:** No change needed now. Revisit before adding new camera or API features.

---

## Frontend

All files are in `Frontend/admin-portal/src/`. Five components are deep in the red zone.
The decomposition pattern for each is the same: extract sub-components, move fetch
logic to a `hooks/` file, and move shared transforms to `utils/`.

---

### `VehicleRegistry.jsx` — ~1,120 lines 🔴

Highest priority. This file manages the plate/vehicle registry, including search,
list display, add/edit modals, authorized guardian entries, and blocked guardian entries.

**Proposed decomposition:**
```
Frontend/admin-portal/src/
├── VehicleRegistry.jsx             # page shell, search bar, list (~150 lines)
├── PlateCard.jsx                   # individual plate card with action buttons (~120 lines)
├── PlateModal.jsx                  # add/edit plate modal form (~180 lines)
├── GuardianEntryForm.jsx           # reusable auth/blocked guardian sub-form (~120 lines)
├── hooks/useVehicleRegistry.js     # fetch, optimistic updates, delete, patch (~150 lines)
└── utils/plateUtils.js             # tokenise, format, validate plate helpers (~60 lines)
```

---

### `BenefactorPortal.jsx` — ~900 lines 🔴

The guardian self-service portal is a single-file monolith mixing four distinct
feature sections: profile, children, vehicles, and authorized pickups.

**Proposed decomposition:**
```
Frontend/admin-portal/src/
├── BenefactorPortal.jsx            # tab shell + routing between sections (~80 lines)
├── BenefactorProfile.jsx           # display name, phone, photo (~150 lines)
├── BenefactorChildren.jsx          # add/remove children, school lookup (~200 lines)
├── BenefactorVehicles.jsx          # add/remove vehicles, plate input (~200 lines)
├── BenefactorPickups.jsx           # authorised pickup people list (~150 lines)
└── hooks/useBenefactor.js          # shared fetch: profile, children, vehicles (~120 lines)
```

---

### `GuardianManagement.jsx` — ~555 lines 🔴

Admin view of all guardians, with search, school assignment, and detail expansion.

**Proposed decomposition:**
```
Frontend/admin-portal/src/
├── GuardianManagement.jsx          # search bar, list container (~150 lines)
├── GuardianRow.jsx                 # expandable row: children, vehicles, schools (~180 lines)
├── AssignSchoolModal.jsx           # school assignment modal (~120 lines)
└── hooks/useGuardianManagement.js  # fetch, search debounce, assign/remove (~100 lines)
```

---

### `UserManagement.jsx` — ~552 lines 🔴

Manages school staff and admin accounts: invite, role change, disable, resend invite.

**Proposed decomposition:**
```
Frontend/admin-portal/src/
├── UserManagement.jsx              # user table, empty state, action toolbar (~150 lines)
├── InviteUserModal.jsx             # email + role form, submit, error handling (~150 lines)
├── UserRow.jsx                     # role badge, status toggle, action menu (~120 lines)
└── hooks/useUserManagement.js      # fetch, invite, update role/status, delete (~100 lines)
```

---

### `SiteSettings.jsx` — ~522 lines 🔴

Mixes school creation, info editing, enrollment code display, and multi-school
management into one file.

**Proposed decomposition:**
```
Frontend/admin-portal/src/
├── SiteSettings.jsx                # tab container or section header (~80 lines)
├── SiteInfoForm.jsx                # name, timezone, address, contact fields (~160 lines)
├── SiteEnrollmentCard.jsx          # enrollment code display + regenerate (~80 lines)
├── SiteSchoolList.jsx              # multi-school management for admins (~120 lines)
└── hooks/useSiteSettings.js        # fetch, save, create school, delete school (~80 lines)
```

---

## Yellow zone — watch list

These files are healthy today but should **not** grow without a refactor check.

| File | Est. lines | Trigger |
|------|-----------|--------|
| `Insights.jsx` | ~374 | Next chart or metric added pushes it over |
| `Dashboard.jsx` | ~320 | Next queue feature or stat card |
| `PlatformAdmin.jsx` | ~280 | Next school management feature |
| `App.jsx` | ~276 | Next route or auth flow |
| `Backend/dismissal.py` | ~380 | Next camera or API feature |

---

## Rules going forward

1. **400 line hard limit.** No file may exceed 400 lines. If adding a feature would
   push a file past this, decompose first.
2. **Single responsibility.** Each file owns one concern: one page component, one API
   resource's routes, one hook's data, one utility domain.
3. **Hooks for data, components for display.** Any `useState` + `useEffect` + `fetch`
   cluster that exceeds ~50 lines moves to a dedicated `hooks/use*.js` file.
4. **Backend routes stay grouped by resource.** No route handler belongs in `main.py`
   or `config.py` — it goes in the appropriate `routes/` file.
5. **Review large files before adding code.** Before touching any file over 300 lines,
   run `/code-efficiency-rule` to check if a refactor is needed first.
