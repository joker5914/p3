#!/usr/bin/env python3
# =============================================================================
# Dismissal Scanner — First-Boot WiFi Captive Portal
# =============================================================================
# When a Pi 5 boots without a saved WiFi profile, this module brings up an
# access point named "Dismissal-Setup-XXXX" (last 4 of CPU serial), serves a
# Dismissal-branded captive-portal page on http://10.42.0.1, and lets the
# installer pick the local WiFi network from a list and enter the password.
#
# On submit the chosen credentials become a permanent NetworkManager
# connection profile and the AP is torn down — the scanner's other
# services come up against the newly-provisioned WiFi on the next boot.
#
# Designed to run as root (needs nmcli + ability to write to
# /etc/NetworkManager/system-connections/).  Stdlib-only (http.server +
# subprocess) so we don't add fastapi/uvicorn to the scanner image.
# =============================================================================

from __future__ import annotations

import html
import logging
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

LOG = logging.getLogger("dismissal-setup-portal")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
AP_GATEWAY_IP   = "10.42.0.1"
AP_PORT         = 80
AP_PROFILE_NAME = "dismissal-setup"
AP_IFACE        = "wlan0"
WIFI_PROFILE    = "dismissal-wifi"
NM_CONN_DIR     = Path("/etc/NetworkManager/system-connections")
PROVISIONED_FLAG = Path("/var/lib/dismissal/.wifi-provisioned")

# The captive portal serves the same page for every URL so iOS / Android /
# Windows captive-portal-detection probes all hit it and trigger the OS-level
# "Sign in" notification.  Phones probe these well-known endpoints:
CAPTIVE_PROBE_HOSTS = {
    "captive.apple.com",                  # iOS / macOS
    "www.apple.com",                      # iOS fallback
    "connectivitycheck.gstatic.com",      # Android
    "connectivitycheck.android.com",      # older Android
    "clients3.google.com",                # ChromeOS
    "www.msftconnecttest.com",            # Windows 10/11
    "detectportal.firefox.com",           # Firefox
}


# ---------------------------------------------------------------------------
# nmcli helpers
# ---------------------------------------------------------------------------
def _run(cmd: list[str], check: bool = False, timeout: int = 30) -> subprocess.CompletedProcess:
    """Run a subprocess and return the completed object — never raise on stderr."""
    LOG.debug("exec: %s", " ".join(cmd))
    return subprocess.run(
        cmd, check=check, timeout=timeout,
        capture_output=True, text=True,
    )


def list_wifi_networks() -> list[dict]:
    """
    Return nearby WiFi networks via `nmcli dev wifi list --rescan auto`.
    De-duplicates by SSID, filters out hidden + the setup-AP itself,
    sorts by signal strength descending.
    """
    proc = _run(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE",
                 "device", "wifi", "list", "--rescan", "auto"], timeout=20)
    seen: dict[str, dict] = {}
    for raw_line in proc.stdout.splitlines():
        # nmcli -t escapes literal ':' as '\:' inside fields; split carefully.
        parts = re.split(r'(?<!\\):', raw_line)
        parts = [p.replace(r'\:', ':') for p in parts]
        if len(parts) < 4:
            continue
        ssid, signal, security, in_use = parts[0], parts[1], parts[2], parts[3]
        if not ssid or ssid == "--":
            continue
        if ssid.startswith("Dismissal-Setup-"):
            continue
        try:
            signal_i = int(signal or 0)
        except ValueError:
            signal_i = 0
        prev = seen.get(ssid)
        if prev is None or signal_i > prev["signal"]:
            seen[ssid] = {
                "ssid":     ssid,
                "signal":   signal_i,
                "security": security or "--",
                "open":     security in ("", "--"),
                "in_use":   in_use == "*",
            }
    return sorted(seen.values(), key=lambda n: n["signal"], reverse=True)


def already_provisioned() -> bool:
    """
    Returns True if a real WiFi connection profile exists (any 802-11-wireless
    profile that isn't our setup AP).  Used at startup to decide whether to
    skip the portal.
    """
    if PROVISIONED_FLAG.exists():
        return True
    try:
        proc = _run(
            ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    for line in proc.stdout.splitlines():
        parts = line.split(":", 1)
        if len(parts) != 2:
            continue
        name, ctype = parts
        if ctype != "802-11-wireless":
            continue
        if name == AP_PROFILE_NAME:
            continue
        return True
    return False


def device_suffix() -> str:
    """4-char suffix for the setup-AP SSID — last 4 of the Pi's CPU serial."""
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Serial"):
                    serial = line.split(":", 1)[1].strip()
                    if serial:
                        return serial[-4:].upper()
    except OSError:
        pass
    # Fallback: short random — should never hit on real hardware.
    return secrets.token_hex(2).upper()


def setup_ap_ssid() -> str:
    return f"Dismissal-Setup-{device_suffix()}"


# ---------------------------------------------------------------------------
# AP lifecycle
# ---------------------------------------------------------------------------
def bring_up_ap(ssid: str) -> None:
    """
    Create + bring up the captive-portal hotspot.  Idempotent — wipes any
    prior incarnation of dismissal-setup before re-creating.

    Uses NM `shared` mode which gives us:
      * 10.42.0.1/24 on wlan0
      * dnsmasq DHCP for clients
      * NAT-less DNS (queries we'll hijack to our own captive page)
    """
    LOG.info("Bringing up captive-portal AP: SSID=%s", ssid)
    _run(["nmcli", "connection", "delete", AP_PROFILE_NAME])  # ignore "doesn't exist"
    add = _run([
        "nmcli", "connection", "add",
        "type", "wifi",
        "ifname", AP_IFACE,
        "con-name", AP_PROFILE_NAME,
        "autoconnect", "no",
        "ssid", ssid,
        "mode", "ap",
        "802-11-wireless.band", "bg",
        "ipv4.method", "shared",
        "ipv4.addresses", f"{AP_GATEWAY_IP}/24",
        "ipv6.method", "ignore",
    ])
    if add.returncode != 0:
        LOG.error("nmcli add failed: %s", add.stderr.strip())
    up = _run(["nmcli", "connection", "up", AP_PROFILE_NAME], timeout=45)
    if up.returncode != 0:
        LOG.error("nmcli up failed: %s", up.stderr.strip())
    else:
        LOG.info("AP active on %s (gateway %s)", AP_IFACE, AP_GATEWAY_IP)


def tear_down_ap() -> None:
    LOG.info("Tearing down captive-portal AP")
    _run(["nmcli", "connection", "down", AP_PROFILE_NAME])
    _run(["nmcli", "connection", "delete", AP_PROFILE_NAME])


def _atomic_write(path: Path, body: str, mode: int = 0o600) -> None:
    """
    Write `body` to `path` atomically: write to a sibling tempfile,
    fsync the contents, fsync the parent directory, then rename into
    place.  On a power loss, the tempfile may remain (harmless — we'll
    overwrite it on the next attempt) but `path` is guaranteed to be
    either the previous good content or the new complete content.

    Without this, a power loss mid-write left half-written NM profiles
    or empty marker files behind, which then needed a factory reset to
    recover from.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(
        str(tmp),
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        mode,
    )
    try:
        os.write(fd, body.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)  # atomic on POSIX
    # fsync the directory so the rename itself is durable.  Without
    # this, a crash after rename() but before the parent dir's
    # metadata flush could lose the rename.
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# WiFi profile write + connect
# ---------------------------------------------------------------------------
def write_wifi_profile(ssid: str, password: str) -> Path:
    """
    Write a NetworkManager connection profile for the user's WiFi.  We write
    it directly to /etc/NetworkManager/system-connections/ rather than going
    through `nmcli con add` because the AP is currently holding wlan0 — the
    new profile autoconnects the moment we tear the AP down.

    Atomic write so a power loss mid-write can't leave NM with a
    half-written profile that refuses to load on the next boot.
    """
    path = NM_CONN_DIR / f"{WIFI_PROFILE}.nmconnection"
    body = (
        "[connection]\n"
        f"id={WIFI_PROFILE}\n"
        "type=wifi\n"
        "autoconnect=true\n"
        "autoconnect-priority=50\n"
        f"interface-name={AP_IFACE}\n"
        "\n"
        "[wifi]\n"
        "mode=infrastructure\n"
        f"ssid={ssid}\n"
        "\n"
        "[wifi-security]\n"
        "key-mgmt=wpa-psk\n"
        f"psk={password}\n"
        "pmf=1\n"
        "\n"
        "[ipv4]\n"
        "method=auto\n"
        "\n"
        "[ipv6]\n"
        "method=auto\n"
    )
    _atomic_write(path, body, mode=0o600)
    LOG.info("Wrote WiFi profile: %s", path)
    return path


def mark_provisioned() -> None:
    """
    Drop the marker file the runtime services gate on.  Atomic so a
    power loss between writing the WiFi profile and writing the marker
    can't leave a half-written marker — the next boot will simply see
    the marker absent and the captive portal will rerun.
    """
    body = f"provisioned at {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
    _atomic_write(PROVISIONED_FLAG, body, mode=0o644)
    LOG.info("Wrote provisioning marker: %s", PROVISIONED_FLAG)


# ---------------------------------------------------------------------------
# Branded HTML
# ---------------------------------------------------------------------------
# Minimal, single-file page.  Inlined so the AP doesn't need to serve any
# secondary assets (faster page load on captive-portal popups, no asset
# routing complexity).  Color tokens mirror the Citrus brand palette used
# in the admin portal — orange→pink gradient on a near-white surface.

PAGE_CSS = """
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: #faf7f5; color: #0e0d0d;
  -webkit-font-smoothing: antialiased;
}
.shell {
  min-height: 100%;
  display: flex; flex-direction: column;
  padding: 24px 20px 40px;
  max-width: 480px; margin: 0 auto;
}
.brand {
  display: flex; align-items: center; gap: 12px; margin-bottom: 28px;
}
.mark {
  width: 40px; height: 40px; border-radius: 10px;
  background: linear-gradient(135deg, #ff8a3d 0%, #ff5675 100%);
  color: #fff; display: grid; place-items: center;
  font-weight: 700; font-size: 20px; letter-spacing: -0.04em;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18),
              0 1px 2px rgba(0,0,0,0.08);
}
.wordmark {
  font-size: 18px; font-weight: 600; letter-spacing: -0.01em;
}
h1 {
  font-size: 22px; font-weight: 700; line-height: 1.25;
  margin: 0 0 6px; letter-spacing: -0.015em;
}
.subtitle {
  font-size: 14.5px; color: #5a5654; margin: 0 0 24px; line-height: 1.45;
}
.card {
  background: #fff;
  border: 1px solid #ece7e3;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
}
.card + .card { margin-top: 14px; }
label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #2c2826; }
.network-list {
  max-height: 260px; overflow-y: auto;
  border: 1px solid #ece7e3; border-radius: 10px;
  background: #fdfcfb;
}
.network {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; cursor: pointer;
  border-bottom: 1px solid #f3efec;
  font-size: 14.5px;
}
.network:last-child { border-bottom: 0; }
.network:hover { background: #fff7f1; }
.network.selected { background: #fff1e8; }
.network .ssid { font-weight: 500; }
.network .meta { font-size: 12px; color: #8a8480; }
.network .signal {
  display: inline-block; width: 18px; height: 12px;
  background: linear-gradient(to top, #ff8a3d 0%, #ff8a3d 50%, #ddd 50%, #ddd 100%);
  border-radius: 2px; margin-right: 8px; vertical-align: middle;
  background-size: 100% 4px; background-repeat: no-repeat;
}
.input {
  width: 100%; padding: 12px 14px; font-size: 15px;
  border: 1px solid #ddd6d1; border-radius: 10px;
  background: #fff; color: #0e0d0d;
  font-family: inherit;
}
.input:focus { outline: 2px solid #ff8a3d; outline-offset: 0; border-color: #ff8a3d; }
.btn {
  display: block; width: 100%; padding: 14px 16px;
  font-size: 15px; font-weight: 600; letter-spacing: 0.01em;
  border: 0; border-radius: 12px; cursor: pointer;
  background: linear-gradient(135deg, #ff8a3d 0%, #ff5675 100%);
  color: #fff;
  font-family: inherit;
  margin-top: 14px;
  transition: transform 0.05s ease;
}
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.secondary {
  background: #fff; color: #2c2826; border: 1px solid #ddd6d1;
  margin-top: 8px;
}
.help {
  font-size: 12.5px; color: #8a8480; margin-top: 10px; line-height: 1.45;
}
.error {
  background: #fff0ee; color: #b3261e;
  border: 1px solid #fbcdc6; border-radius: 10px;
  padding: 10px 12px; font-size: 13.5px; margin-top: 12px;
}
.success-shell {
  text-align: center; padding-top: 32px;
}
.success-mark {
  width: 56px; height: 56px; border-radius: 50%;
  background: linear-gradient(135deg, #ff8a3d 0%, #ff5675 100%);
  color: #fff; display: inline-grid; place-items: center;
  font-size: 28px; margin-bottom: 16px;
}
.toggle-pw {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: #5a5654;
  margin-top: 8px; user-select: none; cursor: pointer;
}
.toggle-pw input { margin: 0; }
.device-id {
  font-size: 11.5px; color: #b1aba6;
  text-align: center; margin-top: 24px;
  letter-spacing: 0.04em; text-transform: uppercase;
}
"""


def setup_page(networks: list[dict], device_id: str, error: Optional[str] = None) -> str:
    """Render the network-picker page."""
    rows = []
    for n in networks:
        bars = max(1, min(4, round(n["signal"] / 25)))
        signal_pct = bars * 25
        ssid_attr = html.escape(n["ssid"], quote=True)
        ssid_disp = html.escape(n["ssid"])
        secured = "" if n["open"] else " · secured"
        rows.append(
            f'<div class="network" data-ssid="{ssid_attr}" data-secured="{0 if n["open"] else 1}">'
            f'  <div>'
            f'    <span class="signal" style="background: linear-gradient(to top, #ff8a3d {signal_pct}%, #ddd {signal_pct}%);"></span>'
            f'    <span class="ssid">{ssid_disp}</span>'
            f'    <div class="meta">{n["signal"]}%{secured}</div>'
            f'  </div>'
            f'</div>'
        )
    network_html = "\n".join(rows) if rows else (
        '<div class="network" style="cursor:default; color:#8a8480;">'
        'No networks found. Tap "Rescan" below.</div>'
    )
    err_html = f'<div class="error">{html.escape(error)}</div>' if error else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Connect Dismissal Scanner</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<div class="shell">
  <div class="brand">
    <div class="mark">D</div>
    <div class="wordmark">Dismissal</div>
  </div>

  <h1>Connect this scanner to WiFi</h1>
  <p class="subtitle">Pick the network you want this device to use. Once connected, it will appear in your Dismissal admin portal under <strong>Devices</strong> ready to be assigned to a school.</p>

  {err_html}

  <form method="POST" action="/save" id="setup-form">
    <div class="card">
      <label>Available networks</label>
      <div class="network-list" id="network-list">
        {network_html}
      </div>
      <a href="/?rescan=1" class="btn secondary" style="text-decoration:none; text-align:center;">Rescan</a>
    </div>

    <div class="card">
      <label for="ssid">Network name (SSID)</label>
      <input class="input" type="text" name="ssid" id="ssid" required autocomplete="off" autocapitalize="off">

      <label for="password" style="margin-top: 14px;">Password</label>
      <input class="input" type="password" name="password" id="password" autocomplete="off">
      <label class="toggle-pw">
        <input type="checkbox" id="show-pw"> Show password
      </label>
      <p class="help">Leave the password blank for an open network. WPA2/WPA3 are supported.</p>

      <button class="btn" type="submit" id="submit-btn">Connect this scanner</button>
    </div>
  </form>

  <div class="device-id">Device · {html.escape(device_id)}</div>
</div>

<script>
  // Populate SSID + focus password when a network is tapped.
  const list = document.getElementById('network-list');
  const ssidInput = document.getElementById('ssid');
  const pwInput = document.getElementById('password');
  list.addEventListener('click', (e) => {{
    const row = e.target.closest('.network');
    if (!row || !row.dataset.ssid) return;
    document.querySelectorAll('.network.selected').forEach(n => n.classList.remove('selected'));
    row.classList.add('selected');
    ssidInput.value = row.dataset.ssid;
    if (row.dataset.secured === '1') {{ pwInput.focus(); }}
  }});

  // Show/hide password.
  document.getElementById('show-pw').addEventListener('change', (e) => {{
    pwInput.type = e.target.checked ? 'text' : 'password';
  }});

  // Disable double-submits.
  document.getElementById('setup-form').addEventListener('submit', () => {{
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
  }});
</script>
</body>
</html>
"""


SUCCESS_PAGE = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dismissal Scanner Connected</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<div class="shell">
  <div class="brand">
    <div class="mark">D</div>
    <div class="wordmark">Dismissal</div>
  </div>

  <div class="success-shell">
    <div class="success-mark">✓</div>
    <h1>WiFi credentials saved</h1>
    <p class="subtitle">This scanner is rebooting onto your network. In a moment it will appear in <strong>Devices</strong> in your Dismissal admin portal, ready to be assigned to a school.</p>
    <p class="help">You can disconnect from <em>Dismissal-Setup</em> on your phone now and rejoin your normal WiFi.</p>
  </div>
</div>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class CaptiveHandler(BaseHTTPRequestHandler):
    """
    Serves the same setup page for every URL (so iOS/Android captive-portal
    probes trigger the OS sign-in popup).  POST /save commits the chosen
    credentials and signals the main thread to exit.
    """

    server_version = "Dismissal-Setup/1.0"

    # The portal hands control back to systemd by setting this from /save.
    _shutdown_signal: threading.Event  # injected by main()
    _device_id: str                    # injected by main()
    _last_networks: list[dict]         # injected by main()
    _scan_lock: threading.Lock         # injected by main()

    def log_message(self, fmt, *args):  # noqa: N802 (stdlib name)
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _send_html(self, body: str, status: int = 200) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        # Disable iOS "Success" matching so the captive sheet stays open.
        self.send_header("X-Captive-Portal", "1")
        self.end_headers()
        self.wfile.write(encoded)

    def _serve_setup(self, error: Optional[str] = None, force_rescan: bool = False) -> None:
        with self._scan_lock:
            if force_rescan or not self._last_networks:
                try:
                    self._last_networks[:] = list_wifi_networks()
                except Exception as e:  # noqa: BLE001
                    LOG.exception("WiFi scan failed: %s", e)
                    self._last_networks[:] = []
            networks = list(self._last_networks)
        self._send_html(setup_page(networks, self._device_id, error=error))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        rescan = parsed.query and "rescan=1" in parsed.query
        # Apple's captive-portal probe expects exactly the body
        # "Success" — by returning anything else, iOS treats this as a
        # captive portal and pops the sign-in sheet.
        self._serve_setup(force_rescan=rescan)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/save":
            self._serve_setup()
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 4096:
            self._serve_setup(error="Invalid request.")
            return
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        params = parse_qs(raw, keep_blank_values=True)

        ssid     = (params.get("ssid")     or [""])[0].strip()
        password = (params.get("password") or [""])[0]

        if not ssid:
            self._serve_setup(error="Pick a network from the list (or type its name).")
            return
        if len(ssid) > 32:
            self._serve_setup(error="SSID too long (max 32 characters).")
            return
        if password and (len(password) < 8 or len(password) > 63):
            self._serve_setup(error="WPA passwords must be 8–63 characters.")
            return

        # Persist the profile.  Don't try to bring it up here — the AP is
        # currently holding wlan0; tearing the AP down kicks the new profile
        # in via NM autoconnect.  Doing both atomically lives in main().
        try:
            write_wifi_profile(ssid, password)
        except Exception as e:  # noqa: BLE001
            LOG.exception("Failed to write WiFi profile: %s", e)
            self._serve_setup(error="Could not save credentials. Try again.")
            return

        # Capture chosen creds so main() can act on them after we respond.
        self.server.chosen_ssid = ssid          # type: ignore[attr-defined]
        self.server.chosen_password = password  # type: ignore[attr-defined]

        self._send_html(SUCCESS_PAGE)

        # Give the response a moment to flush, then signal main() to exit.
        threading.Timer(1.5, self._shutdown_signal.set).start()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )


def main() -> int:
    configure_logging(verbose=("--verbose" in sys.argv or "-v" in sys.argv))

    if os.geteuid() != 0:
        LOG.error("Must run as root (needs nmcli + write to /etc/NetworkManager).")
        return 2

    if already_provisioned():
        LOG.info("WiFi already provisioned — captive portal not needed.")
        return 0

    suffix = device_suffix()
    ssid   = f"Dismissal-Setup-{suffix}"
    LOG.info("Setup AP SSID: %s", ssid)

    bring_up_ap(ssid)
    # Give NM a few seconds to settle dnsmasq + iptables shared-mode rules.
    time.sleep(3)

    shutdown_signal = threading.Event()
    last_networks: list[dict] = []
    scan_lock = threading.Lock()

    # Inject shared state into the handler class.  `BaseHTTPRequestHandler`
    # is constructed per-request, so class attributes are the cleanest way
    # to share state with main().
    CaptiveHandler._shutdown_signal = shutdown_signal
    CaptiveHandler._device_id       = suffix
    CaptiveHandler._last_networks   = last_networks
    CaptiveHandler._scan_lock       = scan_lock

    # Background thread refreshes the WiFi scan every 30s so the network
    # list on the page is fresh whenever the user reloads.
    def _scan_loop() -> None:
        while not shutdown_signal.is_set():
            try:
                fresh = list_wifi_networks()
                with scan_lock:
                    last_networks[:] = fresh
            except Exception as e:  # noqa: BLE001
                LOG.warning("Scan loop error: %s", e)
            shutdown_signal.wait(30)

    threading.Thread(target=_scan_loop, daemon=True, name="wifi-scan").start()

    httpd = ThreadingHTTPServer(("", AP_PORT), CaptiveHandler)
    httpd.chosen_ssid = None       # type: ignore[attr-defined]
    httpd.chosen_password = None   # type: ignore[attr-defined]
    LOG.info("Captive portal listening on http://%s:%d/", AP_GATEWAY_IP, AP_PORT)

    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True, name="http")
    server_thread.start()

    try:
        # Block here until the /save handler signals us.  No upper bound —
        # the device should sit in setup mode until provisioned.
        shutdown_signal.wait()
    except KeyboardInterrupt:
        LOG.info("Interrupted")
        return 130
    finally:
        LOG.info("Shutting down HTTP server…")
        httpd.shutdown()
        httpd.server_close()

    chosen_ssid = getattr(httpd, "chosen_ssid", None)
    if chosen_ssid:
        LOG.info("Provisioning complete — chosen SSID: %s", chosen_ssid)
        # Tear AP down BEFORE marking provisioned so a stuck NM doesn't leave
        # the device half-online if the new SSID is bad.  The provisioned
        # marker is the load-bearing "we're done" gate.
        tear_down_ap()
        # Try to activate the new connection.  If it fails (typo'd password,
        # SSID out of range), drop the marker and let the bootstrap shell
        # script restart the portal on its next loop iteration.
        time.sleep(2)
        up = _run(["nmcli", "connection", "up", WIFI_PROFILE], timeout=60)
        if up.returncode == 0:
            mark_provisioned()
            LOG.info("Connected to %s — kicking off scanner services.", chosen_ssid)
            # Now that we have WiFi, start the scanner stack so the device
            # registers with the cloud and shows up in the admin portal
            # without waiting for a reboot.  Best-effort — these units have
            # ConditionPathExists gating, so a manual reboot would also work.
            for svc in ("dismissal-scanner", "dismissal-watchdog", "dismissal-health"):
                kick = _run(["systemctl", "start", svc], timeout=20)
                if kick.returncode != 0:
                    LOG.warning("Could not start %s: %s", svc, kick.stderr.strip())
            return 0
        LOG.error("Failed to activate WiFi profile: %s", up.stderr.strip())
        # Remove the bad profile so the next portal pass starts fresh.
        try:
            (NM_CONN_DIR / f"{WIFI_PROFILE}.nmconnection").unlink(missing_ok=True)
        except OSError:
            pass
        # Bring the AP back so the user can retry.
        bring_up_ap(ssid)
        # Non-zero exit so systemd Restart=on-failure re-runs us.
        return 1
    LOG.warning("Portal exited without saving credentials.")
    tear_down_ap()
    return 1


if __name__ == "__main__":
    sys.exit(main())
