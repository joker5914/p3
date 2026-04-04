# P³ — PiPlatePickup

> **Streamlined, secure student pickup and drop-off management powered by a Raspberry Pi + Google Coral TPU, FastAPI, Firebase, and React.**

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Hardware Requirements](#hardware-requirements)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
  - [Raspberry Pi Scanner Setup](#raspberry-pi-scanner-setup)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Deployment](#deployment)
  - [Backend — Google Cloud Run](#backend--google-cloud-run)
  - [Frontend — Firebase Hosting](#frontend--firebase-hosting)
- [Security Model](#security-model)
- [Contributing](#contributing)

---

## Overview

P³ is a real-time school pickup management system. A camera-equipped Raspberry Pi with a Google Coral TPU reads licence plates as vehicles enter the pickup zone. Recognised plates are looked up in a Firebase database, and the matching student and guardian names are pushed instantly to a web dashboard used by school staff to coordinate pickup.

**Key goals:**
- Zero manual check-in — staff see who is arriving before the car stops.
- Privacy by design — plate numbers and all personally identifiable information are encrypted or one-way hashed before storage.
- Real-time — WebSocket push means the dashboard updates the moment a plate is scanned.
- Resilient — the scanner client retries with exponential back-off, so intermittent WiFi on the RPi does not drop events.

---

## How It Works

```
┌─────────────────────────────┐
│   Raspberry Pi 4            │
│   + Google Coral TPU        │
│                             │
│  Camera → EdgeTPU inference │
│  (licence plate detection)  │
│         │                   │
│      p3.py                  │
│  POST /api/v1/scan ─────────┼──────────────────────────────┐
└─────────────────────────────┘                              │
                                                             ▼
                                               ┌─────────────────────────┐
                                               │   FastAPI Backend        │
                                               │   (Google Cloud Run)     │
                                               │                          │
                                               │  1. HMAC-tokenise plate  │
                                               │  2. Lookup in Firestore  │
                                               │  3. Decrypt student/     │
                                               │     guardian names       │
                                               │  4. Broadcast via WS     │
                                               └────────────┬────────────┘
                                                            │ WebSocket
                                                            ▼
                                               ┌─────────────────────────┐
                                               │   React Admin Portal     │
                                               │   (Firebase Hosting)     │
                                               │                          │
                                               │  Live pickup queue       │
                                               │  cards update in         │
                                               │  real time               │
                                               └─────────────────────────┘
```

---

## Architecture

| Layer | Technology |
|---|---|
| Edge inference | Raspberry Pi 4 + Google Coral USB/M.2 TPU |
| Scanner client | Python 3.11, `requests`, custom back-off retry |
| Backend API | Python 3.11, FastAPI, Uvicorn |
| Database | Google Cloud Firestore |
| Authentication | Firebase Authentication (JWT) |
| Real-time push | WebSocket (FastAPI native) |
| Container | Docker → Google Artifact Registry → Cloud Run |
| CI/CD | Google Cloud Build (trigger on push to `master`) |
| Admin frontend | React 19, Vite 6, Firebase JS SDK |
| Frontend hosting | Firebase Hosting |
| Encryption | Fernet (AES-128-CBC + HMAC-SHA256) via `cryptography` |
| Plate tokenisation | HMAC-SHA256 (keyed, non-reversible) |

---

## Hardware Requirements

| Component | Notes |
|---|---|
| Raspberry Pi 4 (2 GB+ RAM) | Runs the scanner client (`p3.py`) |
| Google Coral USB Accelerator or M.2 TPU | Accelerates licence plate detection inference |
| IP or USB camera | Positioned to capture vehicle plates at entry |
| WiFi or Ethernet | RPi needs network access to reach Cloud Run |

The TPU inference pipeline feeds detected plate strings into `p3.py`. Replace the `_example_detection_source()` stub in `Backend/p3.py` with your EdgeTPU inference queue to complete the integration.

---

## Repository Structure

```
p3/
├── Backend/
│   ├── server.py              # FastAPI application — all API routes
│   ├── secure_lookup.py       # Encryption & HMAC plate tokenisation helpers
│   ├── p3.py                  # Raspberry Pi scanner client
│   ├── add_plate.py           # CLI utility to register individual plates
│   ├── Dockerfile             # Container definition for Cloud Run
│   ├── requirements.txt       # Python dependencies
│   ├── .env.example           # Environment variable template
│   └── TestImportData.csv     # Sample CSV for bulk plate import
│
├── Frontend/
│   └── admin-portal/
│       ├── src/
│       │   ├── App.jsx            # Root component, WebSocket lifecycle
│       │   ├── Dashboard.jsx      # Live pickup queue view
│       │   ├── DataImporter.jsx   # Bulk CSV plate registration
│       │   ├── Login.jsx          # Firebase email/password auth
│       │   ├── Layout.jsx         # App shell (navbar + left nav)
│       │   ├── Navbar.jsx         # Top bar with WS status indicator
│       │   ├── LeftNav.jsx        # Sidebar navigation
│       │   ├── api.js             # Axios client factory
│       │   └── firebase-config.js # Firebase SDK initialisation
│       ├── vite.config.js         # Vite + dev proxy config
│       └── package.json
│
├── CHANGES.md                 # Full audit log of all changes and bug fixes
├── .gitignore
└── README.md
```

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 20+
- A Firebase project with **Authentication** and **Firestore** enabled
- A GCP project with **Cloud Run** and **Artifact Registry** enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- `firebase` CLI installed (`npm install -g firebase-tools`)

---

### Backend Setup

```bash
cd Backend

# 1. Create a virtual environment
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env
# Edit .env and fill in all required values (see Environment Variables below)

# 4. Place your Firebase service account key
#    Download from: Firebase Console → Project Settings → Service Accounts
#    Save as: Backend/firebase_credentials.json
#    (This file is gitignored and must NEVER be committed)

# 5. Start the development server
python server.py
# API available at http://localhost:8000
# Interactive docs at http://localhost:8000/docs
```

---

### Frontend Setup

```bash
cd Frontend/admin-portal

# 1. Install dependencies
npm install

# 2. Configure environment
#    Create Frontend/admin-portal/.env.local with:
#    VITE_DEV_BACKEND_URL=http://localhost:8000
#    VITE_DEV_FRONTEND_URL=http://localhost:5173

# 3. Start the development server
npm run dev
# App available at http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` requests to the backend automatically — no CORS issues, no hardcoded URLs.

---

### Raspberry Pi Scanner Setup

```bash
# On the Raspberry Pi
cd Backend

pip install -r requirements.txt

# Configure .env with:
#   ENV=production
#   VITE_PROD_BACKEND_URL=https://your-cloud-run-url.run.app
#   PROD_P3_API_TOKEN=<firebase id token for scanner service account>
#   SCANNER_LOCATION=entry_gate_1
#   DEVICE_TIMEZONE=America/New_York

# Wire your EdgeTPU inference output into _example_detection_source() in p3.py
# then run:
python p3.py
```

---

### Registering Plates

**Single plate (CLI):**
```bash
python add_plate.py \
  --plate ABC123 \
  --student "John Doe" \
  --student "Jenny Doe" \
  --parent "Jane Doe" \
  --school your_school_id \
  --make Toyota --model Highlander --color Gray
```

**Bulk import (CSV via Admin Portal):**

1. Log into the admin portal
2. Navigate to **Integrations → Data Import**
3. Upload a CSV matching this format:

```csv
guardian_id,guardian_name,student_id,student_name,plate_number,vehicle_make,vehicle_model,vehicle_color
jdoe@example.com,Jane Doe,stu001,John Doe,ABC123,Toyota,Highlander,Gray
jdoe@example.com,Jane Doe,stu002,Jenny Doe,ABC123,Toyota,Highlander,Gray
```

Multiple children sharing a plate go on separate rows — they are grouped automatically.

---

## Environment Variables

Copy `Backend/.env.example` to `Backend/.env` and fill in the values below. **Never commit `.env` to source control.**

| Variable | Required | Description |
|---|---|---|
| `ENV` | ✅ | `development` or `production` |
| `SECRET_KEY` | ✅ | 32-byte hex string used for HMAC event hashes. Generate: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `P3_ENCRYPTION_KEY` | ✅ | Fernet key for encrypting PII. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `DEV_SCHOOL_ID` | ✅ | School identifier used in development mode (e.g. `dev_school`) |
| `DEVICE_TIMEZONE` | ✅ | IANA timezone name for the scanner (e.g. `America/New_York`) |
| `VITE_DEV_BACKEND_URL` | dev | Backend URL for local development |
| `VITE_DEV_FRONTEND_URL` | dev | Frontend URL for local development |
| `VITE_PROD_BACKEND_URL` | prod | Cloud Run service URL |
| `VITE_PROD_FRONTEND_URL` | prod | Firebase Hosting URL |
| `DEV_P3_API_TOKEN` | dev | Firebase ID token for local scanner testing |
| `PROD_P3_API_TOKEN` | prod | Firebase ID token for the RPi scanner service account |
| `FIREBASE_CREDENTIALS_PATH` | dev | Path to service account JSON (default: `firebase_credentials.json`) |
| `SCANNER_LOCATION` | scanner | Location label sent with each scan (e.g. `entry_gate_1`) |
| `SCANNER_TIMEOUT_SECS` | scanner | HTTP request timeout in seconds (default: `10`) |
| `SCANNER_MAX_RETRIES` | scanner | Max retry attempts per scan (default: `5`) |

---

## API Reference

All endpoints (except `/api/v1/system/health`) require a Firebase ID token:
```
Authorization: Bearer <firebase_id_token>
```

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/system/health` | Health check — no auth required |
| `POST` | `/api/v1/scan` | Submit a plate scan from the RPi |
| `GET` | `/ api/v1/dashboard` | Fetch today's scan queue for this school |
| `DELETE` | `/api/v1/scans/clear` | Clear all scans for this school |
| `DELETE` | `/api/v1/plate/{plate}` | Remove a specific plate from the in-memory queue |
| `POST` | `/api/v1/admin/import-plates` | Bulk import plate registrations (encrypts PII) |
| `GET` | `/api/v1/reports/summary` | Summary stats |
| `GET` | `/api/v1/system/alerts` | Active system alerts |
| `PUT` | `/api/v1/vehicles/{vehicle_id}` | Update vehicle details |
| `POST` | `/api/v1/auth/logout` | Invalidate session |
| `WS` | `/ws/dashboard?token=<id_token>` | Real-time scan event stream |

Interactive API docs (Swagger UI) are available at `http://localhost:8000/docs` in development.

### Scan payload (`POST /api/v1/scan`)

```json
{
  "plate": "ABC123",
  "timestamp": "2025-04-01T15:30:00Z",
  "location": "entry_gate_1",
  "confidence_score": 0.95
}
```

### WebSocket events

```json
// New scan arrives
{ "type": "scan", "data": { "student": ["John Doe"], "parent": "Jane Doe", "timestamp": "...", ... } }

// Queue cleared
{ "type": "clear" }
```

---

## Deployment

### Backend — Google Cloud Run

Continuous deployment is configured via **Google Cloud Build**. Any push to `master` automatically builds and deploys the backend.

**Cloud Build settings:**
| Field | Value |
|---|---|
| Branch | `^master$` |
| Build type | Dockerfile |
| Source location | `Backend/Dockerfile` |

**Manual deploy (one-off):**
```bash
cd Backend
gcloud builds submit --tag gcr.io/YOUR_PROJECT/p3-backend
gcloud run deploy p3-backend \
  --image gcr.io/YOUR_PROJECT/p3-backend \
  --platform managed \
  --region us-central1 \
  --set-env-vars ENV=production,SECRET_KEY=...,P3_ENCRYPTION_KEY=... \
  --allow-unauthenticated
```

> **Important:** In production, Cloud Run uses **Application Default Credentials** — do not set `FIREBASE_CREDENTIALS_PATH` or upload the service account JSON. Instead, grant the Cloud Run service account the `Firebase Admin SDK Administrator` IAM role.

---

### Frontend — Firebase Hosting

```bash
cd Frontend/admin-portal

# Build
npm run build

# Deploy
firebase deploy --only hosting
```

**`firebase.json`** is already configured to rewrite all routes to `index.html` for SPA routing.

---

## Security Model

### Plate tokenisation
Plate numbers are **never stored in plaintext**. They are hashed using HMAC-SHA256 with `SECRET_KEY` before any database write. This means:
- An attacker with Firestore access cannot reverse plate tokens to real plate numbers without knowing `SECRET_KEY`.
- Lookups are still deterministic — the same plate always produces the same token.

### PII encryption
All personally identifiable information (student names, guardian names, guardian email) is encrypted with **Fernet** (AES-128-CBC + HMAC-SHA256) using `P3_ENCRYPTION_KEY` before storage. Data is decrypted only at query time, in memory, and never written back in plaintext.

### Authentication
- The admin portal uses **Firebase Authentication** (email/password).
- Every API request requires a valid Firebase ID token in the `Authorization` header.
- WebSocket connections require the same token via `?token=` query parameter.
- In production, token rejection (code `4001`) causes the frontend to force logout.

### Transport
- All communication between the RPi scanner and Cloud Run uses HTTPS/WSS.
- Firebase Hosting enforces HTTPS by default.

### Secret rotation
If you believe any secret has been compromised, regenerate it and redeploy:
- `SECRET_KEY` — regenerate and re-deploy backend. Existing event hashes become unverifiable but data remains accessible.
- `P3_ENCRYPTION_KEY` — regenerate requires re-encrypting all Firestore PII. Run a migration script before switching.
- Firebase service account key — rotate in GCP IAM console and delete the old key.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test locally
4. Ensure no secrets are staged: `git diff --cached` should not show `.env` or `firebase_credentials.json`
5. Push and open a pull request against `master`

---

*Built with ❤️ for safer school pickup lines.*
