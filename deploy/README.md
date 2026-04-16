# Dismissal Scanner — Field Deployment Guide

This guide covers deploying the Dismissal licence plate scanner on a Raspberry Pi in fully unattended, headless mode. Once deployed the device boots, connects to WiFi, and starts scanning with no human interaction required.

---

## What gets installed

| Component | Purpose |
|---|---|
| `dismissal-scanner.service` | Main scanner process — captures frames, detects plates, posts to backend |
| `dismissal-watchdog.service` | Monitors WiFi and backend connectivity, restarts scanner if it fails |
| `dismissal-health.service` | HTTP health endpoint on port 9000 for external monitoring |
| BCM2835 hardware watchdog | Reboots the RPi if the OS hangs completely |
| journald limits | Caps log storage to 100 MB so the SD card doesn't fill up |
| tmpfs mounts | Puts `/tmp` and `/var/log` in RAM to reduce SD card writes |

All three services are managed by **systemd** and start automatically on boot, restart on crash, and log to the journal.

---

## Hardware checklist

- [ ] Raspberry Pi 5 (4 GB RAM recommended) — Pi 4 also works
- [ ] MicroSD card 16 GB+ (Class 10 / A1 or better)
- [ ] Arducam 16MP IMX519 (CSI) or any USB camera positioned at the entry point
- [ ] Google Coral USB Accelerator (recommended for TPU-accelerated detection)
- [ ] Reliable power supply (official Pi 5 PSU: 5.1 V 5 A USB-C)
- [ ] Hologram.io SIM + compatible LTE modem (optional; WiFi is used otherwise)

---

## Zero-touch deployment (recommended)

Total operator time: **~3 minutes** of active work.  The Pi then self-installs
over the next ~15 minutes with no SSH, keyboard, or HDMI required.

### Step 1 — Flash Pi OS

1. Download **Raspberry Pi OS Lite (64-bit, Bookworm)** from [raspberrypi.com/software](https://www.raspberrypi.com/software/).
2. Flash it with **Raspberry Pi Imager**.
3. In Imager's "Advanced options" (gear icon ⚙️), set:
   - **Username / password** for the default login user (use `pi` as the username; generate a strong random password per device, e.g. `openssl rand -base64 24`, and store it in your password manager)
   - **Locale and timezone**
   - *You can leave **hostname**, **SSH**, and **WiFi** unset — the prep script below assigns a unique hostname, enables SSH, installs your key, and configures WiFi automatically.*
4. Write the card.  **Do not eject it yet.**

### Step 2 — Run the prep script

You need **one file** on your laptop: the Firebase service-account JSON.

> **One-time setup (first scanner only).** In
> [`Backend/scanner_config.py`](../Backend/scanner_config.py), set
> `PROD_BACKEND_URL` and `FIREBASE_WEB_API_KEY` for your Firebase project.
> These values are public (the Web API key is embedded in every Firebase web
> app), are shared across every scanner you deploy, and are committed to
> the repo — so subsequent scanners don't need any editing at all.
>
> - `PROD_BACKEND_URL` — your Cloud Run URL.
> - `FIREBASE_WEB_API_KEY` — Firebase Console → Project Settings → **General** → *Web API Key*.

**Get the service-account JSON:**
Firebase Console → Project Settings → **Service Accounts** → *Generate new
private key* → save the JSON anywhere on your laptop (e.g.
`~/secrets/firebase-scanner-sa.json`). The same JSON works for every scanner
— per-device identity comes from the hostname the prep script generates.

**Then, with the freshly-flashed SD card still in the reader:**

```bash
sudo bash deploy/prepare-sdcard.sh \
    --service-account-json ~/secrets/firebase-scanner-sa.json \
    --wifi-ssid 'YourSSID' \
    --wifi-pass 'YourWiFiPassword'
```

That's it. No `.env` editing, no location field, no token minting.

What this does:
- Generates a unique hostname `Dismissal-Edge-<8 alphanumeric chars>` (override with `--hostname NAME`). Prints it at the end so you can label the SD card / unit.
- Enables SSH on first boot and copies your `~/.ssh/id_ed25519.pub` (or `id_rsa.pub`) into the default user's `authorized_keys`. Override with `--ssh-key /path/to/some.pub`.
- Stages the Firebase service-account JSON on the boot partition; `firstrun.sh` installs it to `/opt/dismissal/Backend/firebase-scanner-sa.json` (mode 600, owned by `dismissal`) and wipes the FAT copy after install.
- Patches `cmdline.txt` so the installer runs automatically on first power-on.

**Setting the device location.** Locations are managed from the Admin Portal
(Platform Admin → **Devices**) after the Pi checks in, so you don't pick
them at SD-card prep time. Each scanner registers itself on boot, appears
in the Devices list within a minute, and the location you enter there is
pushed to the device on its next heartbeat (≤5 min). If you want to
pre-seed a location anyway, pass `--location 'entry-north-gate'` and it
gets written to `.env` as `SCANNER_LOCATION=…`.

Omit the WiFi flags if the deployment site is cellular-only.

### Step 3 — Power on the Pi

Eject the SD card, insert it into the Pi, apply power, and wait ~15 minutes.

The Pi will:
1. Boot Pi OS, apply the assigned hostname, and enable SSH
2. Run the first-boot installer: wait for internet, clone this repo, run `install.sh` (installs OS deps, Tesseract, Coral TPU runtime, ModemManager, Python venv, systemd services, Hologram NM profile)
3. Install your SSH key into the default user's account
4. Install `.env` and the Firebase service-account JSON into `/opt/dismissal/Backend/` (mode 600, owned by `dismissal`)
5. Securely remove credentials from the boot partition
6. Reboot — the scanner mints its first Firebase ID token on startup and begins POSTing scans

### Step 4 — Connect and verify

Use the hostname printed by `prepare-sdcard.sh` (e.g. `Dismissal-Edge-a3k7fj92`):

```bash
ssh pi@Dismissal-Edge-a3k7fj92.local

# All three services should be active
sudo systemctl status dismissal-scanner dismissal-watchdog dismissal-health

# Live scanner logs (you should see "Firebase ID token minted" on startup)
journalctl -u dismissal-scanner -f

# Health endpoint (also reachable remotely)
curl http://localhost:9000/health | python3 -m json.tool
```

You should see `🔍 Plate detected:` lines in the journal once vehicles come into frame.

---

## Cellular connectivity (Hologram.io)

`install.sh` installs `ModemManager`, the QMI/MBIM tools, and a NetworkManager
profile for Hologram:

```text
Connection name : hologram
APN             : hologram           (no username / password)
Autoconnect     : yes, priority 100  (WiFi defaults to 0 / -10 after install)
Route metric    : 100 cellular, 600 WiFi  (cellular wins when both are up)
```

When both cellular and WiFi have IPs, routing prefers cellular (lower metric).
If the cellular link goes down, WiFi takes over automatically.

**Supported modems:** anything ModemManager recognises — USB LTE dongles,
Sixfab Cellular IoT HATs, Waveshare SIM7600, Quectel EC25/EG25, etc.

**Bringing a modem online:**
1. Insert the Hologram SIM into the modem.
2. Plug the modem into the Pi (USB or HAT pogo pins as applicable).
3. `mmcli -L` should list it within ~30 seconds.
4. `nmcli connection up hologram` — or wait ~60 s for autoconnect.

**Verify which uplink is active:**
```bash
ip route | head -n 2   # default route shows cellular (wwan0/ppp0) or wlan0
nmcli device status
```

---

## Manual / classic deployment (fallback)

If you'd rather SSH in and run the installer by hand (e.g. for debugging), flash
the card with Imager (SSH + user configured), then:

```bash
ssh pi@<hostname>.local
curl -sSL https://raw.githubusercontent.com/joker5914/Dismissal/master/deploy/install.sh | sudo bash

# Fill in the REPLACE_ME values (FIREBASE_WEB_API_KEY, backend URL, location)
sudo nano /opt/dismissal/Backend/.env

# Upload the Firebase service-account JSON
sudo install -o dismissal -g dismissal -m 600 /tmp/firebase-scanner-sa.json \
    /opt/dismissal/Backend/firebase-scanner-sa.json

sudo systemctl start dismissal-scanner dismissal-watchdog dismissal-health
sudo reboot                             # required for Arducam overlay + watchdog
```

---

## Tuning the plate detector

Enable debug mode to save annotated frames to disk:

```bash
sudo nano /opt/dismissal/Backend/.env
# Set: SCANNER_DEBUG=true
sudo systemctl restart dismissal-scanner
```

Frames are written to `/opt/dismissal/Backend/debug_frames/`. View them by SCP-ing to your laptop:

```bash
scp pi@dismissal-scanner-01.local:/opt/dismissal/Backend/debug_frames/*.jpg ./debug/
```

Once tuned, set `SCANNER_DEBUG=false` to stop writing frames to the SD card.

**Key tuning variables:**

| Variable | What it controls | Start here |
|---|---|---|
| `SCANNER_FPS_CAP` | Frames/sec processed | 10 |
| `SCANNER_MIN_CONFIDENCE` | OCR confidence threshold | 0.70 |
| `SCANNER_COOLDOWN_SECS` | Ignore same plate for N secs | 30 |
| `SCANNER_RESOLUTION` | Camera resolution | 1280x720 |
| `SCANNER_MIN_PLATE_LEN` | Shortest valid plate | 4 |
| `SCANNER_MAX_PLATE_LEN` | Longest valid plate | 8 |

---

## Coral TPU setup

`install.sh` already installs the Coral Edge TPU runtime (`libedgetpu1-std`),
`python3-pycoral`, the udev rules for non-root USB access, and downloads the
default SSD-MobileNet-v2 COCO model to `/opt/dismissal/models/`.  Just plug the
Coral USB Accelerator into the Pi before first boot (or reboot after plugging
it in later).

To swap in a plate-specific EdgeTPU model:

```bash
scp plate_detector_edgetpu.tflite pi@dismissal-scanner-01.local:/tmp/
ssh pi@dismissal-scanner-01.local
sudo install -o dismissal -g dismissal -m 644 \
    /tmp/plate_detector_edgetpu.tflite \
    /opt/dismissal/models/plate_detector_edgetpu.tflite
sudo systemctl restart dismissal-scanner
```

For a non-default path, set `SCANNER_MODEL_PATH` in `/opt/dismissal/Backend/.env`.

---

## Updating the scanner in the field

SSH in and run the update script:

```bash
sudo bash /opt/dismissal/deploy/update.sh
```

This pulls the latest code, updates dependencies, reloads systemd unit files, and restarts all services — no reboot needed.

---

## Monitoring

### Live logs
```bash
journalctl -u dismissal-scanner -f              # follow live
journalctl -u dismissal-scanner --since today   # today only
journalctl -u dismissal-scanner -n 100          # last 100 lines
```

### Health endpoint
The health service exposes `http://<rpi-ip>:9000/health`:

```json
{
  "healthy": true,
  "timestamp": "2025-04-01T15:30:00+00:00",
  "hostname": "dismissal-scanner-01",
  "uptime_seconds": 86400,
  "services": {
    "dismissal-scanner": "active",
    "dismissal-watchdog": "active"
  },
  "network": {
    "interface": "wlan0",
    "ip": "192.168.1.42"
  },
  "hardware": {
    "cpu_temp_c": 52.3,
    "memory": { "total_mb": 3879, "used_mb": 312, "available_mb": 3567 }
  }
}
```

Point UptimeRobot, Grafana, or any HTTP monitor at this URL. It returns HTTP 200 when healthy and HTTP 503 when the scanner service is not running.

### Service management quick reference
```bash
sudo systemctl status dismissal-scanner          # status
sudo systemctl restart dismissal-scanner         # restart
sudo systemctl stop dismissal-scanner            # stop
sudo systemctl disable dismissal-scanner         # prevent auto-start on boot
sudo systemctl enable dismissal-scanner          # re-enable auto-start
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Service won't start | `journalctl -u dismissal-scanner -n 50` — look for Python import errors |
| Camera not found | `ls /dev/video*` — verify device exists; check `SCANNER_CAMERA_INDEX` |
| No plates detected | Enable `SCANNER_DEBUG=true`, check debug frames |
| Backend 401 errors | Check service-account JSON is present at `/opt/dismissal/Backend/firebase-scanner-sa.json` (mode 600, owner `dismissal`); verify `FIREBASE_WEB_API_KEY` in `.env` matches the Firebase project; scanner logs will show "Firebase ID token minted" on every refresh |
| WiFi drops frequently | Check signal strength: `iwconfig wlan0`; consider USB WiFi adapter |
| Cellular modem not detected | `mmcli -L` (lists modems); `journalctl -u ModemManager`; check USB power budget on Pi 5 |
| Cellular not becoming primary | `nmcli device status`; confirm `hologram` connection is active and has lower `ipv4.route-metric` than wlan0 |
| SD card full | `journalctl --disk-usage`; `df -h`; reduce `SystemMaxUse` in journald config |
| High CPU temperature | Lower `SCANNER_FPS_CAP`; add heatsink/fan; check `SCANNER_DEBUG=false` |
