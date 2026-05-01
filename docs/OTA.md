# OTA Firmware Updates — Operations Runbook

This document is the operations playbook for the over-the-air firmware
update system shipped in issue [#104](https://github.com/joker5914/Dismissal/issues/104).
It covers cutting a release, monitoring a rollout, halting/rolling back,
and the on-device file layout.

---

## 1. Architecture in one diagram

```
┌──────────── release engineer ────────────┐
│ deploy/sign_firmware.py sign --version… │   (workstation, holds priv key)
└─────────────────┬────────────────────────┘
                  │ tarball + manifest.json
                  ▼
       Firebase Storage  firmware/releases/{version}/
                  ▲                          ▲
                  │ verify+publish (admin)   │ short-lived signed URL
                  │                          │
┌─── Admin Portal Firmware page ───┐   ┌─── Pi: dismissal-ota ───┐
│ POST /api/v1/admin/firmware/…    │   │ GET /scanner/firmware-  │
│ verifies ed25519 vs canonical    │   │ check, downloads, re-   │
│ pubkey, writes firmware_releases │   │ verifies, swaps symlink │
└───────────────┬──────────────────┘   └───────────────┬─────────┘
                │ Firestore                            │ POST status
                ▼                                      ▼
        firmware_releases / device_firmware  ←────────┘
```

Three independent verification points:

1. **Sign on workstation** — `deploy/sign_firmware.py sign` produces an
   Ed25519 signature over the SHA-256 of the tarball.
2. **Verify on backend** — when the admin creates a release, the backend
   re-verifies the signature against the canonical public key in
   `platform_settings/firmware`. A bad signature is rejected before any
   Pi sees it.
3. **Verify on device** — the Pi re-hashes the downloaded artifact and
   re-verifies the signature against `/opt/dismissal/keys/firmware.pub`
   before swapping the symlink.

A compromised signing key OR a compromised admin OR a tampered Storage
artifact will fail at least one of the three checks.

---

## 2. One-time setup

### Generate the signing keypair

Done once when the OTA system is first turned on.

```bash
cd /path/to/Dismissal
python deploy/sign_firmware.py gen-keypair --out-dir ./fw-keys
```

This produces:
- `fw-keys/firmware.priv` — keep secret. Store in a secrets manager.
- `fw-keys/firmware.pub` — distribute to every Pi at provisioning AND
  upload to the backend (next step).

### Upload the canonical public key to the backend

Admin Portal → **Firmware** → "Manage public key" → paste the contents
of `firmware.pub`.

Equivalently, via the API:

```bash
curl -X POST https://<backend>/api/v1/admin/firmware/pubkey \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public_key_b64": "MCowBQYDK2VwAyEA…"}'
```

This writes `platform_settings/firmware.public_key_b64`. The backend
will refuse to publish any release until this is set.

### Provision the public key on every Pi

The image-build pipeline (`deploy/build-image.sh` / `deploy/install.sh`)
should drop `firmware.pub` at `/opt/dismissal/keys/firmware.pub` (mode
0644). For existing field devices, push the file via your normal
config-management channel (SSH, Ansible, etc.) and run:

```bash
sudo install -m 0644 -o dismissal -g dismissal \
  firmware.pub /opt/dismissal/keys/firmware.pub
```

If a placeholder `firmware.pub.example` was installed by `install.sh`,
the OTA agent will refuse every signature until the real key replaces
it. You'll see this in `journalctl -u dismissal-ota`:

```
FirmwareVerificationError: Ed25519 signature did not verify against on-device public key
```

---

## 3. Cutting a release

### Step 1 — package the tarball

The tarball must contain a top-level `Backend/` directory:

```bash
git -C /path/to/Dismissal archive --format=tar.gz \
  --prefix= -o ./dismissal-1.2.3.tar.gz HEAD Backend/
```

Anything you put outside `Backend/` (e.g. an updated `deploy/`) is
extracted alongside but is NOT applied to the live system — only the
Backend/ side is what `current/Backend/` resolves to.

### Step 2 — sign

```bash
export DISMISSAL_FW_PRIVATE_KEY=/secrets/firmware.priv
python deploy/sign_firmware.py sign \
  --version 1.2.3 \
  --tarball ./dismissal-1.2.3.tar.gz \
  --signed-by alice@dismissal \
  --out ./manifest.json
```

This produces `manifest.json` next to the tarball and self-verifies
before exiting. A self-verification failure means the private key file
is corrupted or the wrong algorithm — fix it before uploading.

### Step 3 — upload + publish

Admin Portal → **Firmware** → "New release":

1. Pick the tarball and `manifest.json` files.
2. Confirm version (auto-filled from manifest).
3. Set release notes (markdown).
4. Optionally tweak the stage definitions (default is canary 1% →
   early 10% → broad 50% → general 100%).
5. Optionally set an apply window in device-local hours
   (e.g. 02–04 = "only between 2am and 4am local time").
6. Click "Create release".

The backend uploads both files to Firebase Storage at
`firmware/releases/{version}/`, verifies the manifest's signature,
and creates the `firmware_releases/{version}` doc with status `draft`.

### Step 4 — publish

In the Firmware page, click **Publish** on the new draft. This sets
`status=published` and starts the first stage (canary). Devices in
the canary bucket pick up the assignment on their next firmware-check
(within 5 minutes).

---

## 4. Managing a rollout

### Watching progress

Each release row shows live counters:

- **targeted** — devices the rollout assigned this version
- **downloaded** — devices that pulled the artifact
- **applied** — devices that swapped + passed health-check
- **failed** — devices that errored before the swap
- **rolled_back** — devices that swapped, failed health-check, and
  reverted to the previous version

Click a release for the per-device table — find any host stuck in
`applying` or `health_check` and decide whether to pin it back.

### Advancing stages

Click **Advance →** to widen the rollout to the next stage. The
stages are *cumulative caps*, not deltas: stage `early (10%)` includes
every device in stage `canary (1%)` plus the next 9% by hash bucket.

### Halting a rollout

Click **Halt** and provide a reason. Halted releases stop being
assigned to *new* devices — devices that already swapped to the new
version stay on it until you either resume or roll them back manually
via per-device pinning.

### Rolling back the whole fleet

There is no "atomic fleet rollback" button — by design, since rolling
the whole fleet back at once would re-trigger the apply-window gate
and leave devices on different versions for hours. Instead:

1. Halt the bad release.
2. Cut a new release that pins back to the prior known-good version
   (you can re-publish the tarball you already have signed; the
   version field in the manifest must differ, e.g. `1.2.3-rollback`).
3. Publish and advance straight to general.

For a single misbehaving device, use **Pin** on the Devices page to
lock it to a specific version while you investigate.

---

## 5. On-device layout

```
/opt/dismissal/
├── venv/                          # Python venv (shared across releases)
├── deploy/                        # OTA infrastructure (stable, git-managed)
│   ├── firmware_swap.sh           # called by OTA agent via passwordless sudo
│   ├── dismissal-ota.service      # systemd unit
│   ├── sudoers-dismissal-ota      # /etc/sudoers.d/ entry source
│   └── …
├── Backend/                       # OTA agent + watchdog (stable, git-managed)
│   ├── dismissal_ota.py           # the OTA agent itself
│   └── …
├── current -> releases/{version}  # OTA-managed symlink (atomic swap target)
├── releases/
│   ├── 1.2.0/Backend/             # previous release (kept for rollback)
│   └── 1.2.3/Backend/             # active release
├── keys/firmware.pub              # canonical Ed25519 pubkey
├── ota/
│   ├── state.json                 # local FSM mirror (idle/applying/etc)
│   ├── previous_version           # text file: rollback target
│   └── staging/                   # download workdir (cleared between attempts)
└── models/                        # ML model artifacts (shared, not in tarball)
```

The systemd units (`dismissal-scanner`, `dismissal-watchdog`,
`dismissal-health`) point at `/opt/dismissal/current/Backend/...`,
so the symlink swap atomically activates the new code on the next
service restart. The OTA agent itself runs from
`/opt/dismissal/Backend/dismissal_ota.py` (the stable infrastructure
path) so a release that breaks the agent doesn't leave the device
unable to receive a fix.

### Maintenance commands on the Pi

```bash
# What version is currently active?
readlink /opt/dismissal/current

# What state is the OTA agent in?
cat /opt/dismissal/ota/state.json

# Force the agent to check now (instead of waiting for the next interval)
sudo systemctl restart dismissal-ota

# Manually roll back to the previous release
sudo /opt/dismissal/deploy/firmware_swap.sh "$(cat /opt/dismissal/ota/previous_version)"

# Tail logs
journalctl -u dismissal-ota -f
```

---

## 6. Migrating existing devices

The first time `update.sh` runs after the OTA system is shipped, it
performs a one-time bootstrap migration:

1. Copies the existing `Backend/` directory to
   `/opt/dismissal/releases/0.0.0-legacy/Backend/`.
2. Creates the `/opt/dismissal/current` symlink pointing at it.
3. Installs the `dismissal-ota` systemd unit + sudoers drop-in.
4. Drops a placeholder `firmware.pub` if no real key has been
   provisioned yet (real key must be installed before any OTA
   verification will succeed).

Existing systemd units are also re-installed during this step,
switching their `ExecStart=` paths from `/opt/dismissal/Backend/...`
to `/opt/dismissal/current/Backend/...`. Services are restarted at
the end of `update.sh`, so the migration is transparent.

---

## 7. Key rotation

Rotating the signing keypair is a fleet-wide event:

1. Generate a new keypair (`gen-keypair`).
2. Update `/opt/dismissal/keys/firmware.pub` on every Pi out-of-band
   (existing devices won't trust newly-signed releases until they
   have the new pubkey).
3. Upload the new pubkey to the backend via the Firmware page.
4. From this point on, only releases signed with the new private key
   will be accepted.

Older releases signed with the old key will fail verification on the
fleet — keep the old key around until you're sure no device needs to
roll back to a release signed with it.

---

## 8. Failure modes & how they manifest

| Symptom | Where it shows up | Cause |
|---|---|---|
| "Manifest version does not match release version" | Admin portal toast on upload | Manifest's `version` field doesn't match what the admin typed |
| "Ed25519 signature did not verify against the canonical public key" | Admin portal toast on upload | Wrong private key signed the tarball, or manifest was edited after signing |
| "Artifact SHA-256 mismatch" | Pi `journalctl -u dismissal-ota` | Tarball corrupted in transit; agent retries on next tick |
| Device stuck in `health_check` | Firmware page device table | Scanner failed to come up after swap; OTA agent will roll back after 5 minutes |
| Device in `rolled_back` state | Firmware page device table | Swap completed but health-check failed; previous version is active again |
| "FirmwareVerificationError: Public key not found" | Pi `journalctl -u dismissal-ota` | `/opt/dismissal/keys/firmware.pub` missing — provision real pubkey |
| "release_missing" reason on firmware-check | Backend log | A pin or rollout points at a version whose `firmware_releases` doc was archived |
