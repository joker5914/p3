# Dismissal

> **Live student-pickup management for K-12 schools — vision-based at the curb, real-time in the office.**

A camera at the entry lane reads license plates as parents arrive. Behind the scenes the system matches each plate to its students and guardians, flags release authority, and pushes the family to the staff dashboard the moment the car is in line — no clipboards, no walkie-talkies, no kids waiting outside in the heat or cold for an adult to be flagged down.

Dismissal is built around three pieces:

| | What it is | Where it runs |
|---|---|---|
| **Edge scanner** | Raspberry Pi 5 with a CSI camera and (optional) Hailo-8L AI accelerator. Detects vehicles, reads plates, ships hashed events to the cloud. | At the school, on the curb |
| **Cloud API** | FastAPI app deployed as a Firebase Cloud Function. Lookups, multi-tenant authorization, audit logging, SIS sync, SSO. | Firebase + Google Cloud |
| **Admin portal** | React 19 + Vite SPA on Firebase Hosting. Live dashboard, registry management, device adoption, integrations, permissions. | Anywhere a browser opens |

---

## Table of Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Multi-tenancy & roles](#multi-tenancy--roles)
- [Repository layout](#repository-layout)
- [Edge scanner (Raspberry Pi 5)](#edge-scanner-raspberry-pi-5)
- [Cloud API (Firebase Functions)](#cloud-api-firebase-functions)
- [Admin portal](#admin-portal)
- [Integrations](#integrations)
- [Local development](#local-development)
- [Deployment & CI](#deployment--ci)
- [Security model](#security-model)
- [Operations](#operations)
- [Contributing](#contributing)

---

## How it works

```
┌──────────────────────────────────────┐
│   Raspberry Pi 5  +  IMX519 camera   │
│         (optional Hailo-8L NPU)      │
│                                      │
│  Picamera2 → motion gate → vehicle   │
│  detector → plate detector → OCR     │
│         │                            │
│   dismissal.py  ──── HTTPS ─────────┐│
│   (SQLite outbox + retry + watchdog)││
└──────────────────────────────────────┘
                                       │
                                       ▼
                  ┌────────────────────────────────────┐
                  │   FastAPI on Firebase Functions    │
                  │   (functions/, Python 3.13)        │
                  │                                    │
                  │  • verify Firebase ID token        │
                  │  • role-scope (super/district/     │
                  │    school admin or staff)          │
                  │  • HMAC-tokenize plate             │
                  │  • Firestore lookup + write to     │
                  │    live_queue/{school_id}/events   │
                  │  • audit log                       │
                  └────────────────┬───────────────────┘
                                   │ Firestore onSnapshot
                                   ▼
                  ┌────────────────────────────────────┐
                  │   React 19 admin portal            │
                  │   (Firebase Hosting)               │
                  │                                    │
                  │  Dashboard auto-updates as events  │
                  │  land in live_queue.  No polling,  │
                  │  no WebSockets.                    │
                  └────────────────────────────────────┘
```

A staff user sees a card per arriving family the moment a plate hits the curb. Cards show the student(s), the authorized guardian, and the vehicle — staff confirms identity, walks the student out, and dismisses the card.

---

## Architecture

| Layer | Stack |
|---|---|
| Edge inference (NPU) | Raspberry Pi AI HAT+ / Hailo-8L (HailoRT 4.23+) running YOLOv8 on a compiled `.hef` |
| Edge inference (fallback) | ONNX Runtime YOLOv8 plate detector → SSD-MobileNet on Coral USB TPU → CPU contour |
| Edge OCR | `fast-plate-ocr` (CRNN, ONNX) → Tesseract fallback |
| Edge plumbing | Python 3.11+, Picamera2 + libcamera, NetworkManager, systemd (Type=notify watchdog) |
| Edge resilience | SQLite outbox, exponential back-off, hardware watchdog, captive-portal first-boot |
| Cloud API | Python 3.13, FastAPI mounted under a Firebase Functions HTTPS function |
| Datastore | Firestore (only) — `districts`, `schools`, `school_admins`, `school_permissions`, `plate_scans`, `scan_history`, `live_queue/{school_id}/events`, `audit_events`, `sso_domain_mappings`, `sis_config` |
| Real-time push | Firestore `onSnapshot` listeners directly from the browser — no WebSocket layer |
| Background jobs | `hourly_maintenance` Cloud Function (archival, audit-log purge, OneRoster sync) |
| Auth | Firebase Authentication + custom claims for role + scope |
| Frontend | React 19, Vite 6, Firebase JS SDK 11, Firestore real-time |
| Frontend hosting | Firebase Hosting |
| CI/CD | GitHub Actions → `firebase deploy` (functions / hosting / firestore) |
| Encryption at rest | Fernet (AES-128-CBC + HMAC-SHA256) for guardian/student PII |
| Plate tokenization | HMAC-SHA256, keyed, deterministic, non-reversible |

---

## Multi-tenancy & roles

The platform is multi-tenant with a two-level hierarchy: **Districts → Schools**. A district can have one or many schools; every school sits under a district.

Four roles, each with custom claims set on the Firebase user record:

| Role | Scope | Typical tasks |
|---|---|---|
| `super_admin` | Platform-wide — every district, every school | Onboarding new districts, platform-level diagnostics |
| `district_admin` | Pinned to one district | Provisioning schools, district-level reporting, SSO mapping |
| `school_admin` | One or more schools (school-set claim) | Day-to-day operations, registry edits, user management, device adoption |
| `staff` | One or more schools | Operates the live dashboard, verifies identity at pickup |

Per-school feature toggles live in `school_permissions/{school_id}` — `school_admin` controls which subset of features `staff` can see (registry view vs. edit, guardians, devices, audit log, integrations, etc.). Defaults are conservative and editable from the **Permissions** page in the portal.

---

## Repository layout

```
Backend/                         # Edge-device code (Raspberry Pi)
├── dismissal.py                 # Main scanner loop (Type=notify, sd_notify watchdog)
├── dismissal_camera.py          # Picamera2 / libcamera capture
├── dismissal_plate.py           # Detector+OCR pipeline (Hailo / ONNX / Coral / contour)
├── dismissal_api.py             # SQLite outbox + Firebase token mint + async POST
├── dismissal_registration.py    # Device identity + register + heartbeat
├── dismissal_watchdog.py        # WiFi & backend connectivity recovery
├── dismissal_health.py          # Local HTTP /health endpoint on :9000
├── dismissal_setup_portal.py    # First-boot WiFi captive portal
├── dismissal_factory_reset.py   # Power-button factory-reset daemon
├── scanner_config.py            # Public defaults (backend URL, Firebase Web API key)
└── requirements-scanner.txt

functions/                       # Cloud API (Firebase Functions)
├── main.py                      # HTTPS function + scheduled function entrypoints
├── fastapi_app.py               # FastAPI app assembly (16 routers)
├── permissions.py               # ALL_PERMISSION_KEYS + DEFAULT_PERMISSIONS
├── core/
│   ├── auth.py                  # verify_firebase_token, role/scope claim parsing
│   ├── firebase.py              # Lazy Firestore client + Admin SDK init
│   ├── audit.py                 # core.audit.log_event()
│   ├── oneroster.py             # OneRoster 1.2 OAuth2 client
│   ├── sync.py                  # Hourly maintenance jobs
│   └── …
└── routes/
    ├── scan.py history.py plates.py     # vehicle / dismissal ops
    ├── districts.py schools.py users.py # tenants + enrollment
    ├── guardian.py admin.py devices.py  # guardian portal + device fleet
    ├── audit.py                         # audit log + CSV export
    ├── sso.py integrations.py           # SSO + OneRoster
    └── duplicates.py integrity.py public.py

Frontend/admin-portal/           # React + Vite SPA (Firebase Hosting)
├── src/
│   ├── App.jsx                  # Theme bootstrap + role-gated route table
│   ├── Dashboard.jsx            # Live pickup queue (Firestore onSnapshot)
│   ├── PlatformDistricts.jsx    # super_admin districts page
│   ├── PlatformAdmin.jsx        # super_admin school list (per district)
│   ├── SiteSettings.jsx         # School-level config
│   ├── UserManagement.jsx       # Invite, role, school-set assignment
│   ├── PermissionSettings.jsx   # Per-role feature toggles
│   ├── GuardianManagement.jsx   # Guardian directory
│   ├── VehicleRegistry.jsx      # Plate ↔ guardian ↔ student
│   ├── StudentManagement.jsx    # Student records
│   ├── AuditLog.jsx             # Audit trail w/ CSV export
│   ├── Integrations.jsx         # OneRoster + SSO config
│   ├── Insights.jsx             # Analytics, trends, confidence metrics
│   ├── History.jsx              # Past pickup events
│   ├── Devices.jsx              # Scanner fleet + adoption
│   ├── SsoSettings.jsx          # Domain → role mappings
│   ├── Login.jsx                # Firebase email/password + SSO sign-in
│   ├── Trust.jsx Accessibility.jsx   # Public marketing pages
│   ├── Website.jsx              # Marketing landing
│   └── index.css                # Theme tokens (Citrus / Forest / Plum + dark/light)
├── server.js                    # Optional Firebase App Hosting Express SSR shim
└── package.json

deploy/                          # Pi 5 field-deployment toolkit
├── install.sh                   # Idempotent setup of a Pi from a fresh image
├── prepare-sdcard.sh            # Per-card prep on a laptop
├── firstrun.sh                  # systemd.run hook that bootstraps install on first boot
├── build-image.sh               # Golden-image builder (one .img → N SD cards)
├── dismissal-{scanner,watchdog,health,setup-portal,factory-reset}.service
├── dismissal-captive-dnsmasq.conf
├── dismissal-logind.conf
├── dismissal-logrotate.conf
├── journald-dismissal.conf
├── sudoers-dismissal
├── install_hailo_model.sh
└── install_plate_model.sh

.github/workflows/
├── deploy-functions.yml         # functions/** → firebase deploy --only functions
├── deploy-hosting.yml           # Frontend/** → firebase deploy --only hosting
├── deploy-firestore.yml         # firestore rules + indexes
├── deploy-all.yml               # full-platform manual deploy
├── a11y.yml                     # Playwright + axe-core accessibility regression
└── codeql.yml                   # CodeQL static analysis

firestore.rules                  # Tenant-scoped read/write rules
firestore.indexes.json           # Composite-index definitions
firebase.json                    # Hosting + Functions + Firestore wiring
```

---

## Edge scanner (Raspberry Pi 5)

**Hardware** (typical install):

- Raspberry Pi 5 (4 or 8 GB)
- Arducam 16MP IMX519 (CSI) — works on any libcamera-supported camera
- *(optional)* Raspberry Pi AI HAT+ with Hailo-8L for on-device YOLOv8 inference
- *(optional)* Google Coral USB Accelerator
- *(optional)* Hologram.io LTE modem + SIM for cellular fallback

**Detection pipeline** (`Backend/dismissal_plate.py` priority dispatch):

1. **Hailo-8L NPU** — YOLOv8 compiled to `.hef`, on-chip NMS
2. **CPU YOLOv8** via ONNX Runtime
3. **Coral TPU** SSD-MobileNet via `tflite-runtime` + `libedgetpu`
4. **Contour fallback** — OpenCV plate-shape detection on CPU

OCR runs `fast-plate-ocr` (CRNN) by default and falls back to Tesseract if the model download fails. Each step downgrades silently with a journald warning, so a missing accelerator never crashes the scanner — it just runs slower.

**Onboarding a new device.** First-boot is genuinely zero-touch:

1. Image one of the pre-made SD cards (`build-image.sh` produces a single golden `.img` you `dd` onto N cards).
2. Drop the card in any Pi 5, apply power.
3. With no saved WiFi profile, the Pi broadcasts a captive-portal AP named `Dismissal-Setup-XXXX` (last 4 of the CPU serial).
4. The installer joins from a phone — iOS / Android / Windows captive-detect probes auto-open a Dismissal-branded picker.
5. Pick the local WiFi → enter the password → device joins and registers.
6. Device appears in the admin portal under **Devices** as "unassigned" — an admin binds it to a District and School with one click.

**Factory reset.** Hold the power button while booting for 10 seconds. The activity LED rapid-blinks to confirm; the device wipes WiFi profiles, provisioning markers, and scanner state, then reboots back into `Dismissal-Setup` mode.

**Resilience.** Every scan goes into a SQLite outbox before any network call; the outbox drains in the background with exponential back-off. The Pi runs three systemd services (Type=notify, hardware watchdog) so a wedged process self-heals in <90 s. WiFi disconnects, backend 5xx, and Firebase token rotations are all handled in the watchdog without manual intervention.

For deeper detail see [`deploy/README.md`](deploy/README.md) and the inline header comments in each `deploy/*.sh` script.

---

## Cloud API (Firebase Functions)

The backend is a FastAPI app mounted under a single Firebase HTTPS function. The Function URL is rewritten to `/api/**` by `firebase.json`, so the frontend just calls `/api/v1/...` and never thinks about Function URLs directly.

**Why Functions and not Cloud Run?** Cold starts are acceptable for K-12 traffic patterns (bursts at dismissal, idle most of the day), and the operational footprint is one fewer service to babysit. Firestore stays the source of truth either way.

**Key routes** (under `/api/v1/`):

| Area | Endpoint(s) |
|---|---|
| Health | `GET /system/health` |
| Live queue | `POST /scan` (from Pi), `GET /dashboard`, `DELETE /scans/clear`, `DELETE /plate/{plate}` |
| History | `GET /history`, `GET /history/{id}` |
| Tenants | `GET/POST/PATCH/DELETE /districts`, `GET/POST/PATCH/DELETE /schools` |
| Users | `GET/POST/PATCH /users`, role + school-set assignment |
| Permissions | `GET/PUT /permissions` |
| Registry | `POST /admin/import-plates` (CSV bulk, encrypts PII), guardian + student CRUD |
| Devices | `POST /devices/register`, `POST /devices/heartbeat`, `GET/PATCH /devices`, `GET /devices/{hostname}` |
| Audit | `GET /audit/events` (paginated), `GET /audit/events/export.csv` |
| SSO | `GET/POST/DELETE /sso/domain-mappings` |
| OneRoster | `GET/POST/PATCH /sis/config`, `POST /sis/sync` (manual trigger) |

**Auth.** Every route depends on `verify_firebase_token`. The token's custom claims are decoded into a `Principal` object that carries the role and scope. Per-route `require_super_admin`, `require_district_admin`, `require_school_admin`, `require_scanner` dependencies enforce the hierarchy. Cross-school reads are blocked at the dependency layer, not by hand-rolled checks in each handler.

**Background work.** A scheduled function (`hourly_maintenance`) runs every hour:

- archives `plate_scans` older than 24 h into `scan_history`
- purges `audit_events` older than 365 days
- triggers any due OneRoster syncs

There are no Pub/Sub topics, no Cloud Tasks queues, no GCS buckets. Firestore is the only durable store.

---

## Admin portal

**Stack.** React 19, Vite 6, Firebase JS SDK 11. State is local-component with Firestore real-time subscriptions for the dashboard and devices views. No Redux, no React Query.

**Theme system.**

- **Light / dark** toggle, persisted to `localStorage`
- Three brand palettes — **Citrus** (default; warm peach → coral), **Forest**, **Plum**
- A colorblind-safe mode (`data-palette="protanopia-deuteranopia"`) re-tunes status hues to Okabe-Ito-ish values without changing the rest of the chrome
- All colors are CSS-variable tokens; the sidebar, cards, tables, charts, and marketing pages all read from the same scale

**Responsive.** Tables use container queries so a card on the dashboard reflows the same way at a 320 px phone width as it does inside a 1200 px desktop pane. Mobile drawer mode forces ≥44 px tap targets on every nav row.

**Accessibility.** WCAG 2.2 AA across every public and authenticated route, with axe-core regression checks gating each PR via `.github/workflows/a11y.yml`.

---

## Integrations

**Single sign-on.** Domain-based provisioning. Configure a mapping like `acme.org → school_admin @ Acme Elementary`; the next user from that domain who signs in via Google or Microsoft is auto-provisioned with the right role and scope. Live in `routes/sso.py` + `Frontend/admin-portal/src/SsoSettings.jsx`.

**OneRoster 1.2 SIS sync.** OAuth2 client with delta sync (`?filter=dateLastModified>'<ISO8601>'`) supporting PowerSchool, Aeries, Skyward, Infinite Campus, Synergy, and any vendor implementing the OneRoster spec. Configure once in **Integrations**, sync runs hourly via `hourly_maintenance`. Code in `core/oneroster.py`.

---

## Local development

### Prerequisites

- Python 3.11+ (3.13 for the Functions emulator)
- Node 20+
- A Firebase project with Authentication + Firestore enabled
- The Firebase CLI: `npm install -g firebase-tools`
- *(optional)* The Google Cloud CLI for direct Firestore inspection

### Cloud API

```bash
cd functions

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Local emulator (FastAPI on :5001 via Functions emulator):
firebase emulators:start --only functions,firestore,auth
```

Drop a Firebase service-account JSON at `functions/firebase_credentials.json` for development. In production, Functions uses Application Default Credentials and this file isn't needed.

### Admin portal

```bash
cd Frontend/admin-portal
npm install

# Local dev:
npm run dev
# Vite proxies /api → emulator, no CORS dance.
```

### Pi scanner (without a Pi)

The scanner is intentionally hardware-aware — it really wants a CSI camera. For development, you can run `dismissal.py` against an MJPEG/RTSP stream by setting `SCANNER_VIDEO_SOURCE` in `Backend/.env`, but most contributors won't need to touch it.

---

## Deployment & CI

Every push to `master` triggers the right deploy automatically:

| Workflow | Trigger | Action |
|---|---|---|
| `deploy-functions.yml` | changes under `functions/**` | `firebase deploy --only functions` |
| `deploy-hosting.yml` | changes under `Frontend/admin-portal/**` | Build + `firebase deploy --only hosting` |
| `deploy-firestore.yml` | changes to `firestore.rules` / `firestore.indexes.json` | Deploy rules + indexes |
| `deploy-all.yml` | manual dispatch | Full platform deploy |
| `a11y.yml` | every PR | Playwright + axe-core regression |
| `codeql.yml` | every PR + weekly | CodeQL static analysis |

All workflows authenticate via the `GCP_SA_KEY` secret against the `dismissal-cloud` Firebase project. There is no Cloud Build, no Cloud Run.

---

## Security model

**Plate tokenization.** Plate numbers are hashed with HMAC-SHA256 (keyed) before any Firestore write. Lookups are deterministic; reverse lookups require `SECRET_KEY`.

**PII at rest.** Student names, guardian names, and guardian emails are encrypted with Fernet using `DISMISSAL_ENCRYPTION_KEY`. Plaintext only exists in memory, decrypted at query time.

**Tenant isolation.** Firestore security rules + the FastAPI `require_*` dependencies both enforce district/school scoping. A school_admin who attempts to read another school's collection gets a 403 from the API and a `permission-denied` from Firestore — defense in depth.

**Audit trail.** Every privileged action (registry edits, role changes, permission edits, device adoption, integrations) is logged to `audit_events` with actor, target, timestamp, and a 365-day retention. Available in the portal under **Activity Log** with CSV export.

**Transport.** HTTPS end-to-end. Pi → Functions → browser is TLS-only.

**Edge secrets.** A scanner-scoped Firebase service-account JSON is staged onto the Pi during prep; the scanner uses it to mint short-lived (1 hour) ID tokens via `firebase-admin`, refreshing every 50 minutes. No long-lived bearer tokens travel over the wire.

---

## Operations

**Health checks per Pi.** `curl http://<device>:9000/health` returns runtime stats (last scan, FPS, NPU/CPU temp, network).

**Watchdog behavior.** `dismissal-watchdog.service` re-launches the scanner if its sd_notify keepalive goes silent for 90 s, restarts NetworkManager on extended WiFi loss, and reboots the Pi via the BCM2835 hardware watchdog if userspace itself wedges.

**Logs.**

- `journalctl -u dismissal-scanner -f` (live tail)
- `journalctl -u dismissal-setup-portal` (captive portal events)
- `journalctl -u dismissal-factory-reset`
- Firebase Functions logs via `firebase functions:log` or the GCP console

**Adopting a fleet.** With pre-imaged cards, the typical install flow is:

1. Power on at the school; device joins WiFi via captive portal
2. Device shows up in **Devices** as unassigned
3. Admin clicks **Assign** → picks District and School
4. Within ~60 s the device's next heartbeat picks up the assignment and starts streaming scans into that school's `live_queue`

---

## Contributing

1. Fork the repo
2. Branch off `master`: `git checkout -b feature/your-thing`
3. Make changes; verify locally (emulator + portal dev server)
4. Ensure no secrets are staged: `git diff --cached` should never show `firebase_credentials.json` or `.env`
5. Push and open a PR — CI runs build, a11y, and CodeQL automatically

For architectural questions or commercial inquiries, see the website (linked from the portal footer).

---

*Built for the curb, the front office, and everyone in between.*
