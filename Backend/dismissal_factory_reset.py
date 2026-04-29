#!/usr/bin/env python3
# =============================================================================
# Dismissal Scanner — Factory-Reset Daemon
# =============================================================================
# Watches the Pi 5 power button continuously and triggers a factory reset
# when the operator taps it five times within three seconds.  On trigger
# the device wipes its WiFi profile, its registration markers, and any
# locally cached state, blinks the ACT LED to confirm, and reboots —
# leaving an SD card behind that boots back into the captive-portal
# "Dismissal-Setup" mode for re-provisioning.
#
# Why a multi-tap instead of a long hold?
#   The Pi 5's PMIC firmware unconditionally forces a shutdown when the
#   power button is held for ~7 seconds, regardless of what the OS or
#   any service is doing.  Earlier versions of this daemon waited for a
#   10-second hold, which the firmware preempted every time — the device
#   simply powered off before the gesture could be detected.  Five short
#   taps in three seconds is well clear of that 7-second cliff and is a
#   gesture that's unlikely to be produced accidentally.
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
PRESS_COUNT_THRESHOLD = 5     # taps required to trigger
PRESS_WINDOW_S        = 3.0   # within this rolling window
LED_PATH              = Path("/sys/class/leds/ACT")   # Pi 5 activity LED
LED_BLINK_HZ          = 6                              # blink rate during reset
LED_BLINK_DURATION    = 4.0                            # confirm blink length
LED_TAP_FLASH_S       = 0.08                           # flash per acknowledged tap

# Things we wipe on a factory reset.  The captive portal repopulates the
# first three; the registration record is recreated by the scanner the
# next time it boots cleanly with the cloud reachable.
NM_CONNECTIONS_DIR  = Path("/etc/NetworkManager/system-connections")
PROVISIONED_FLAG    = Path("/var/lib/dismissal/.wifi-provisioned")
DISMISSAL_STATE_DIR = Path("/var/lib/dismissal")
SCANNER_ENV_FILE    = Path("/opt/dismissal/Backend/.env")

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


def wipe_all_wifi_profiles() -> None:
    """
    Delete every saved WiFi connection profile, regardless of name.

    Earlier versions only deleted profiles named ``dismissal-*``, which
    missed three real-world cases:
      1. Pi Imager's ``preconfigured.nmconnection`` (default for cards
         imaged with WiFi creds via the Imager UI).
      2. Profiles auto-named after their SSID by ``nmcli device wifi
         connect`` (e.g. ``AndromedaMobile.nmconnection``).
      3. Profiles created by ``nmcli connection add`` with a custom
         ``con-name``.

    All three would survive a factory reset and silently auto-rejoin on
    the next boot, defeating the captive-portal hand-off entirely.

    Cellular (gsm) and wired (802-3-ethernet) profiles are preserved on
    purpose — the field-installable Hologram SIM and any operator-
    configured wired link should still bring the device back online for
    re-adoption without needing a phone.
    """
    try:
        proc = subprocess.run(
            ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
            check=False, capture_output=True, timeout=15, text=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        LOG.warning("Could not enumerate NM connections: %s", e)
        return

    for line in proc.stdout.splitlines():
        # NAME may contain colons (escaped); the last field is TYPE.
        parts = line.split(":")
        if len(parts) < 2:
            continue
        ctype = parts[-1]
        name = ":".join(parts[:-1])
        if ctype != "802-11-wireless":
            continue
        LOG.info("Deleting WiFi profile: %s", name)
        remove_nm_profile(name)

    # Belt-and-braces: any .nmconnection file with a [wifi] section that
    # nmcli might have missed (e.g. file present on disk but not in NM's
    # in-memory list because the daemon hasn't reloaded yet).  Catches
    # files of any name, not just dismissal-*.
    if NM_CONNECTIONS_DIR.exists():
        for profile in NM_CONNECTIONS_DIR.glob("*.nmconnection"):
            try:
                content = profile.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if "type=wifi" in content or "[wifi]" in content:
                LOG.info("Removing leftover WiFi profile file: %s", profile.name)
                try:
                    profile.unlink()
                except OSError as e:
                    LOG.warning("Could not unlink %s: %s", profile, e)


def wipe_state() -> None:
    """The actual factory-reset payload."""
    LOG.warning("FACTORY RESET — wiping device state")

    stop_dismissal_services()

    wipe_all_wifi_profiles()

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


def _flash_tap_ack() -> None:
    """Brief LED pulse to acknowledge a single tap."""
    led_set(1)
    time.sleep(LED_TAP_FLASH_S)
    led_set(0)


def watch_for_multi_tap(devices: Iterable, stopping: dict) -> bool:
    """
    Block forever, watching every KEY_POWER event across the supplied
    input devices.  Returns True when PRESS_COUNT_THRESHOLD taps land
    within a rolling PRESS_WINDOW_S window, or False if the supplied
    `stopping` flag is raised by SIGTERM.

    A "tap" is a press (value=1) — the release is informational.  We
    ignore long sustained holds entirely: the Pi 5 PMIC will force a
    shutdown long before our software-side timer would matter.
    """
    try:
        import evdev
    except ImportError:
        return False
    from select import select

    fd_to_dev = {dev.fd: dev for dev in devices}
    press_times: list[float] = []
    led_prev = led_take_control()

    try:
        while not stopping["flag"]:
            readable, _, _ = select(list(fd_to_dev), [], [], 0.25)
            for fd in readable:
                dev = fd_to_dev[fd]
                try:
                    for event in dev.read():
                        if event.type != evdev.ecodes.EV_KEY:
                            continue
                        if event.code != evdev.ecodes.KEY_POWER:
                            continue
                        if event.value != 1:
                            continue   # only count presses, not releases/repeats

                        now = time.time()
                        press_times.append(now)
                        # Drop taps older than the rolling window.
                        cutoff = now - PRESS_WINDOW_S
                        press_times[:] = [t for t in press_times if t >= cutoff]

                        LOG.info("Power-button tap %d/%d (uptime=%.1fs)",
                                 len(press_times), PRESS_COUNT_THRESHOLD,
                                 system_uptime())
                        _flash_tap_ack()

                        if len(press_times) >= PRESS_COUNT_THRESHOLD:
                            LOG.warning(
                                "Detected %d taps within %.1fs — "
                                "triggering factory reset",
                                len(press_times), PRESS_WINDOW_S)
                            return True
                except (OSError, BlockingIOError):
                    continue
    finally:
        led_set(0)
        led_restore(led_prev)

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

    devices = find_power_button_devices()
    if not devices:
        # No power button at all — sleep forever waiting for SIGTERM rather
        # than exiting (which under Restart=always burns CPU re-launching
        # us forever).  systemd stop on shutdown will tear us down cleanly.
        LOG.warning("No KEY_POWER input devices found — factory-reset by "
                    "button is unavailable on this hardware.  Idling.")
        signal.pause()
        return 0

    # Reasonable termination behaviour: SIGTERM from systemd should let us
    # shut down cleanly.
    stopping = {"flag": False}
    def _handle_term(*_):  # noqa: ANN001, ANN002
        stopping["flag"] = True
    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    LOG.info("Watching power button continuously "
             "(tap %d times within %.0fs to factory-reset).",
             PRESS_COUNT_THRESHOLD, PRESS_WINDOW_S)

    triggered = watch_for_multi_tap(devices, stopping)

    for dev in devices:
        try:
            dev.close()
        except Exception:  # noqa: BLE001
            pass

    if triggered and not stopping["flag"]:
        wipe_state()
        return 0

    LOG.info("Factory-reset daemon stopping (SIGTERM received).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
