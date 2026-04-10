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

- [ ] Raspberry Pi 4 (2 GB RAM minimum, 4 GB recommended)
- [ ] MicroSD card 16 GB+ (Class 10 / A1 or better)
- [ ] USB camera or CSI ribbon camera positioned at the entry point
- [ ] Google Coral USB Accelerator or M.2 TPU (optional but recommended)
- [ ] Reliable power supply (official RPi 4 PSU, 5.1V 3A)
- [ ] WiFi or Ethernet connection

---

## Step 1 — Prepare the SD card

1. Download **Raspberry Pi OS Lite (64-bit)** from [raspberrypi.com/software](https://www.raspberrypi.com/software/).
2. Flash it with **Raspberry Pi Imager**.
3. Before writing, click the gear icon ⚙️ in Imager and configure:
   - Hostname: `dismissal-scanner-01` (or whatever identifies this unit)
   - Enable SSH with a key (disable password auth)
   - WiFi SSID and password for the school network
   - Locale and timezone
4. Write the card, insert into the RPi, and power on.

---

## Step 2 — First SSH connection

```bash
ssh pi@dismissal-scanner-01.local
```

If mDNS doesn't resolve the hostname, find the IP from your router's DHCP table.

---

## Step 3 — Run the install script

```bash
curl -sSL https://raw.githubusercontent.com/joker5914/p3/master/deploy/install.sh | sudo bash
```

This single command:
- Updates the OS packages
- Installs Tesseract OCR and all system libraries
- Creates the `dismissal` system user (no login shell, minimum privileges)
- Clones the repository to `/opt/dismissal`
- Creates a Python virtual environment
- Installs all scanner Python dependencies
- Configures headless boot (GPU memory = 16 MB, HDMI blanked)
- Sets up RAM-based `/tmp` and `/var/log` to protect the SD card
- Enables the BCM2835 hardware watchdog
- Installs and enables all three systemd services
- Configures log rotation

---

## Step 4 — Configure secrets

```bash
sudo nano /opt/dismissal/Backend/.env
```

Fill in every `REPLACE_ME` value:

```ini
# Required for scanner to authenticate with the backend
ENV=production
VITE_PROD_BACKEND_URL=https://your-cloud-run-url.run.app
PROD_DISMISSAL_API_TOKEN=<firebase id token for scanner service account>

# Identify this physical scanner unit
SCANNER_LOCATION=entry_gate_1

# Camera — use index 0 for USB/CSI, or set URL for RTSP
SCANNER_CAMERA_INDEX=0

# Timezone of the device
DEVICE_TIMEZONE=America/New_York
```

The `.env` file is owned by the `dismissal` user and mode `600` — only that user can read it.

---

## Step 5 — Start and verify

```bash
# Start all services immediately (without rebooting)
sudo systemctl start dismissal-scanner dismissal-watchdog dismissal-health

# Watch live logs from the scanner
journalctl -u dismissal-scanner -f

# Check all three services at once
sudo systemctl status dismissal-scanner dismissal-watchdog dismissal-health

# Check the health endpoint
curl http://localhost:9000/health | python3 -m json.tool
```

You should see `🔍 Plate detected:` lines in the journal once vehicles come into frame.

---

## Step 6 — Reboot test

```bash
sudo reboot
```

SSH back in after ~30 seconds and verify:

```bash
sudo systemctl status dismissal-scanner
# Should show: active (running)
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

## Coral TPU setup (optional)

If you have a Coral USB Accelerator or M.2 TPU:

```bash
# Install pycoral (follow official instructions for your RPi OS version)
# https://coral.ai/docs/accelerator/get-started/

# Install runtime
echo "deb https://packages.cloud.google.com/apt coral-edgetpu-stable main" | \
  sudo tee /etc/apt/sources.list.d/coral-edgetpu.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key add -
sudo apt-get update
sudo apt-get install libedgetpu1-std  # or libedgetpu1-max for max performance

# Install pycoral in the Dismissal venv
sudo -u dismissal /opt/dismissal/venv/bin/pip install pycoral tflite-runtime

# Set the model path in .env
# Download or compile an EdgeTPU licence plate detection model
# and point SCANNER_MODEL_PATH at the .tflite file
sudo nano /opt/dismissal/Backend/.env
# SCANNER_MODEL_PATH=/opt/dismissal/models/plate_detector_edgetpu.tflite

sudo systemctl restart dismissal-scanner
```

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
| Backend 401 errors | `PROD_DISMISSAL_API_TOKEN` is expired — Firebase ID tokens last 1 hour; use a service account |
| WiFi drops frequently | Check signal strength: `iwconfig wlan0`; consider USB WiFi adapter |
| SD card full | `journalctl --disk-usage`; `df -h`; reduce `SystemMaxUse` in journald config |
| High CPU temperature | Lower `SCANNER_FPS_CAP`; add heatsink/fan; check `SCANNER_DEBUG=false` |
