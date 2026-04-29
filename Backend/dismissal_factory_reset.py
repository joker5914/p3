#!/usr/bin/env python3
# =============================================================================
# Dismissal Scanner — Factory-Reset Daemon
# =============================================================================
# Watches the Pi 5 power button.  If the operator holds it for ≥10 seconds
# during the first 30 seconds of uptime, the device wipes its WiFi profile,
# its registration markers, and any locally cached state, blinks the ACT
# LED to confirm, and reboots — leaving an SD card behind that boots back
# into the captive-portal "Dismissal-Setup" mode for re-provisioning.
#
# Usage as a service:
#   /opt/dismissal/venv/bin/python /opt/dismissal/Backend/dismissal_factory_reset.py
#
# Required to be run as root — needs to read /dev/input/event*, write the
# LED brightness sysfs node, and remove the protected NM profile dir.
#
# This implementation depends on the `python3-evdev` apt package (also a
# pip-installable wheel, but the apt build matches the kernel's input
# header set out-of-the-box).  install.sh adds it to the venv.
# =============================================================================

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

LOG = logging.getLogger("dismissal-factory-reset")

# ---------------------------------------------------------------------------
# Configuration knobs
# ---------------------------------------------------------------------------
HOLD_THRESHOLD_S    = 10.0   # how long the button must be held to trigger
WATCH_WINDOW_S      = 30.0   # only listen during the first N seconds of uptime
LED_PATH            = Path("/sys/class/leds/ACT")   # Pi 5 activity LED
LED_BLINK_HZ        = 6                              # blink rate during reset
LED_BLINK_DURATION  = 4.0                            # confirm blink length

# Things we wipe on a factory reset.  The captive portal repopulates the
# first three; the registration record is recreated by the scanner the
# next time it boots cleanly with the cloud reachable.
NM_CONNECTIONS_DIR  = Path("/etc/NetworkManager/system-connections")
PROVISIONED_FLAG    = Path("/var/lib/dismissal/.wifi-provisioned")
DISMISSAL_STATE_DIR = Path("/var/lib/dismissal")
SCANNER_ENV_FILE    = Path("/opt/dismissal/Backend/.env")

# Connection profile names we explicitly remove.  We deliberately do NOT
# wipe e.g. cellular profiles (the field-installable Hologram SIM doesn't
# need to be re-introduced after a reset).
WIFI_PROFILES_TO_WIPE = ("dismissal-wifi", "dismissal-setup")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )


def system_uptime() -> float:
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError):
        return 0.0


def led_set(brightness: int) -> None:
    """Best-effort write to /sys/class/leds/ACT/brightness."""
    try:
        (LED_PATH / "brightness").write_text(str(brightness))
    except OSError:
        pass  # No LED — running on a Pi variant without ACT, or in a sandbox.


def led_take_control() -> Optional[str]:
    """
    Switch the ACT LED's trigger to "none" so we can drive it directly.
    Returns the previous trigger so the caller can restore it.
    """
    trig = LED_PATH / "trigger"
    try:
        prev = trig.read_text()
        # Trigger files report `[active] inactive other …` — extract bracketed.
        for tok in prev.split():
            if tok.startswith("[") and tok.endswith("]"):
                prev = tok[1:-1]
                break
        trig.write_text("none")
        return prev
    except OSError:
        return None


def led_restore(prev: Optional[str]) -> None:
    if not prev:
        return
    try:
        (LED_PATH / "trigger").write_text(prev)
    except OSError:
        pass


def led_blink(duration_s: float, hz: int) -> None:
    """Block-blink the LED for the given duration."""
    prev = led_take_control()
    half_period = 0.5 / max(hz, 1)
    end = time.time() + duration_s
    state = 0
    try:
        while time.time() < end:
            state ^= 1
            led_set(state)
            time.sleep(half_period)
    finally:
        led_set(0)
        led_restore(prev)


# ---------------------------------------------------------------------------
# Reset logic
# ---------------------------------------------------------------------------
def stop_dismissal_services() -> None:
    """Halt the runtime services so they don't recreate state mid-wipe."""
    services = (
        "dismissal-scanner",
        "dismissal-watchdog",
        "dismissal-health",
        "dismissal-setup-portal",
    )
    for svc in services:
        try:
            subprocess.run(
                ["systemctl", "stop", svc],
                check=False, timeout=15, capture_output=True,
            )
        except subprocess.TimeoutExpired:
            LOG.warning("Timed out stopping %s", svc)


def remove_nm_profile(name: str) -> None:
    """Remove an NM connection profile, both via nmcli and on-disk."""
    subprocess.run(
        ["nmcli", "connection", "delete", name],
        check=False, capture_output=True, timeout=15,
    )
    profile = NM_CONNECTIONS_DIR / f"{name}.nmconnection"
    try:
        profile.unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        LOG.warning("Could not unlink %s: %s", profile, e)


def wipe_state() -> None:
    """The actual factory-reset payload."""
    LOG.warning("FACTORY RESET — wiping device state")

    stop_dismissal_services()

    for name in WIFI_PROFILES_TO_WIPE:
        remove_nm_profile(name)

    # Belt-and-braces: nuke any NM connection file under our control that
    # we may have written under a different name in a future version.
    if NM_CONNECTIONS_DIR.exists():
        for profile in NM_CONNECTIONS_DIR.glob("dismissal-*.nmconnection"):
            try:
                profile.unlink()
            except OSError:
                pass

    # Clear the runtime state directory but keep the dir itself (systemd
    # StateDirectory= recreates contents only if dir is missing).
    if DISMISSAL_STATE_DIR.exists():
        for entry in DISMISSAL_STATE_DIR.iterdir():
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
            except OSError as e:
                LOG.warning("Could not remove %s: %s", entry, e)

    # Drop any operator-tuned .env so the device boots back to defaults.
    try:
        SCANNER_ENV_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        LOG.warning("Could not remove %s: %s", SCANNER_ENV_FILE, e)

    # Provisioning marker is the source of truth for "is this device
    # ready to run?"  Removing it is what makes the next boot land in
    # captive-portal mode.
    try:
        PROVISIONED_FLAG.unlink()
    except FileNotFoundError:
        pass

    # Force NM to reload now that the profiles are gone.
    subprocess.run(
        ["nmcli", "connection", "reload"],
        check=False, capture_output=True, timeout=15,
    )

    LOG.warning("State wiped — confirming via LED then rebooting")
    led_blink(LED_BLINK_DURATION, LED_BLINK_HZ)

    # `--no-wall` keeps systemd from broadcasting the reboot to all
    # logged-in users (which on a headless scanner is just noise).
    subprocess.run(
        ["systemctl", "reboot", "--no-wall"],
        check=False, timeout=10, capture_output=True,
    )


# ---------------------------------------------------------------------------
# Power-button watcher
# ---------------------------------------------------------------------------
def find_power_button_devices() -> list:
    """
    Return every evdev InputDevice that publishes KEY_POWER.

    Pi 5 + Bookworm exposes the on-board power button as
    `/dev/input/event0` (name "pwr_button") via the rp1 GPIO power button
    overlay; older boards may expose it through systemd-logind's ACPI
    button handler.  Listen on every match so we don't have to hard-code
    a path.
    """
    try:
        import evdev  # local import so the daemon can warn cleanly if missing
    except ImportError:
        LOG.error("python-evdev not installed; factory-reset disabled.")
        return []

    devices = []
    for path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(path)
        except OSError:
            continue
        caps = dev.capabilities().get(evdev.ecodes.EV_KEY, [])
        if evdev.ecodes.KEY_POWER in caps:
            LOG.info("Watching power button: %s (%s)", dev.path, dev.name)
            devices.append(dev)
    return devices


def watch_for_long_press(devices: Iterable, deadline: float) -> bool:
    """
    Block until either the button has been held HOLD_THRESHOLD_S, or we
    pass the watch-window deadline.  Returns True if a reset is requested.
    """
    try:
        import evdev
    except ImportError:
        return False
    from select import select

    # We can't simply read_loop() across multiple devices; use select()
    # so an event on any of them wakes us up.  Limit blocking to 0.25s
    # so we can also notice button-still-held without an actual event.
    button_pressed_at: Optional[float] = None
    fd_to_dev = {dev.fd: dev for dev in devices}

    while time.time() < deadline:
        # If a press is in progress, see whether it has crossed the threshold.
        if button_pressed_at is not None:
            held_for = time.time() - button_pressed_at
            if held_for >= HOLD_THRESHOLD_S:
                LOG.warning("Power button held %.1fs — triggering factory reset",
                            held_for)
                return True
            # During an active hold, blink LED slowly to confirm we noticed.
            led_set((int(time.time() * 2) & 1))

        readable, _, _ = select(list(fd_to_dev), [], [], 0.25)
        for fd in readable:
            dev = fd_to_dev[fd]
            try:
                for event in dev.read():
                    if event.type != evdev.ecodes.EV_KEY:
                        continue
                    if event.code != evdev.ecodes.KEY_POWER:
                        continue
                    if event.value == 1:    # press
                        button_pressed_at = time.time()
                        LOG.info("Power-button press detected at uptime=%.1fs",
                                 system_uptime())
                    elif event.value == 0:  # release
                        if button_pressed_at:
                            held = time.time() - button_pressed_at
                            LOG.info("Power-button released after %.1fs", held)
                        button_pressed_at = None
                        led_set(0)
            except (OSError, BlockingIOError):
                continue

    led_set(0)
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    configure_logging(verbose=("--verbose" in sys.argv or "-v" in sys.argv))

    if os.geteuid() != 0:
        LOG.error("Must run as root.")
        return 2

    if "--reset-now" in sys.argv:
        # Manual escape hatch — `dismissal_factory_reset.py --reset-now`
        # bypasses the button watcher and runs the wipe directly.  Useful
        # over SSH for ops, and used by deploy/factory-reset.sh.
        wipe_state()
        return 0

    uptime = system_uptime()
    if uptime > WATCH_WINDOW_S:
        # Started late — nothing to do this boot.  Daemon exits clean and
        # systemd will re-launch us at the next reboot.
        LOG.info("Uptime %.1fs > %.1fs window — skipping watch.",
                 uptime, WATCH_WINDOW_S)
        return 0

    devices = find_power_button_devices()
    if not devices:
        LOG.warning("No KEY_POWER input devices found — factory-reset by "
                    "button is unavailable on this hardware.")
        return 0

    # Reasonable termination behaviour: SIGTERM from systemd should let us
    # shut down cleanly.
    stopping = {"flag": False}
    def _handle_term(*_):  # noqa: ANN001, ANN002
        stopping["flag"] = True
    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    deadline = time.time() + max(0.0, WATCH_WINDOW_S - uptime)
    LOG.info("Watching power button for %.1fs.", deadline - time.time())

    triggered = watch_for_long_press(devices, deadline)

    for dev in devices:
        try:
            dev.close()
        except Exception:  # noqa: BLE001
            pass

    if triggered and not stopping["flag"]:
        wipe_state()
        return 0

    LOG.info("Factory-reset window closed without trigger — exiting.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
