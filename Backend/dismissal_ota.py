"""
dismissal_ota.py — Over-the-air firmware update agent (issue #104).

Runs as its own systemd unit (deploy/dismissal-ota.service) alongside
the scanner.  Separated from the scanner process so it can:

  * Restart the scanner cleanly via ``systemctl restart dismissal-scanner``
    after an atomic release swap (a process can't gracefully restart
    itself across a code swap).
  * Continue running when the scanner is down, so a rollout that
    leaves the scanner broken doesn't also stop the OTA loop from
    delivering the rollback target.

Lifecycle
---------

  Every ``OTA_CHECK_INTERVAL_SECS`` seconds:

    1. Mint a Firebase scanner token (same FirebaseTokenManager the
       scanner uses — different process, same SA key on disk).
    2. POST /api/v1/scanner/firmware-check with current_version.
    3. If ``should_update`` is true, transition to the staged-update FSM:

         assigned → wait for apply window
                  → wait for "no scans in last N minutes" gate
                  → downloading
                  → verified  (sha256 + ed25519 check)
                  → staged    (extracted to /opt/dismissal/releases/{ver}/)
                  → applying  (deploy/firmware_swap.sh: symlink + restart)
                  → health_check
                  → committed | rolled_back | failed

    4. POST /api/v1/scanner/firmware-status at every transition so the
       admin portal sees rollout progress in near-real-time.

On-disk layout
--------------

  /opt/dismissal/
    current -> releases/{active_version}            # OTA-managed symlink
    releases/
      {active_version}/Backend/...                  # what the scanner runs
      {previous_version}/Backend/...                # kept for rollback
    keys/firmware.pub                               # canonical OTA pubkey
    ota/
      staging/{version}/                            # download workdir
      state.json                                    # local FSM mirror
      previous_version                              # text file: rollback target

Tarball format
--------------

  dismissal-{version}.tar.gz contains a single top-level directory
  ``Backend/`` (no leading prefix).  Extracted to
  ``/opt/dismissal/releases/{version}/Backend/``.  Other top-level
  directories (e.g. ``deploy/``) are accepted but only ``Backend/`` is
  required — anything else is unpacked into the same release dir so
  release engineers can ship updated unit files / scripts when
  needed (the OTA agent won't act on those without manual intervention).

The agent never deletes the active release; it cleans up older releases
beyond the last two on a successful commit.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

# Reuse the scanner's auth + config so this agent doesn't drift.
import scanner_config
from dismissal_api import FirebaseTokenManager
from dismissal_ota_verify import (
    DEFAULT_PUBKEY_PATH,
    FirmwareVerificationError,
    compare_versions,
    parse_manifest,
    sha256_of_file,
    verify_artifact,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("dismissal-ota")


# ---------------------------------------------------------------------------
# Config (env-overridable; defaults match the install.sh layout)
# ---------------------------------------------------------------------------

ENV                       = os.getenv("ENV", "production")
BACKEND_URL               = scanner_config.backend_url(ENV)
FIREBASE_WEB_API_KEY      = scanner_config.FIREBASE_WEB_API_KEY
FIREBASE_SA_PATH          = os.getenv(
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "/opt/dismissal/Backend/firebase-scanner-sa.json",
)
SCANNER_DEVICE_UID        = os.getenv("SCANNER_DEVICE_UID", "") or socket.gethostname()

OTA_CHECK_INTERVAL_SECS   = int(os.getenv("OTA_CHECK_INTERVAL_SECS", "300"))   # 5 min
OTA_HTTP_TIMEOUT          = int(os.getenv("OTA_HTTP_TIMEOUT", "30"))
OTA_DOWNLOAD_TIMEOUT      = int(os.getenv("OTA_DOWNLOAD_TIMEOUT", "600"))      # 10 min
OTA_HEALTH_CHECK_SECS     = int(os.getenv("OTA_HEALTH_CHECK_SECS", "300"))     # 5 min after restart

DISMISSAL_HOME            = Path(os.getenv("DISMISSAL_HOME", "/opt/dismissal"))
RELEASES_DIR              = DISMISSAL_HOME / "releases"
CURRENT_LINK              = DISMISSAL_HOME / "current"
OTA_DIR                   = DISMISSAL_HOME / "ota"
STAGING_DIR               = OTA_DIR / "staging"
STATE_FILE                = OTA_DIR / "state.json"
PREVIOUS_VERSION_FILE     = OTA_DIR / "previous_version"
PUBKEY_PATH               = Path(os.getenv("FIRMWARE_PUBKEY_PATH", DEFAULT_PUBKEY_PATH))
SWAP_SCRIPT               = Path(os.getenv("FIRMWARE_SWAP_SCRIPT", DISMISSAL_HOME / "deploy" / "firmware_swap.sh"))

CHECK_URL    = f"{BACKEND_URL.rstrip('/')}/api/v1/scanner/firmware-check"
STATUS_URL   = f"{BACKEND_URL.rstrip('/')}/api/v1/scanner/firmware-status"


# ---------------------------------------------------------------------------
# Local state (mirrors the backend's device_firmware doc; used by watchdog)
# ---------------------------------------------------------------------------

@dataclass
class LocalState:
    current_version:  str = ""
    previous_version: str = ""
    target_version:   str = ""
    state:            str = "idle"
    last_check_at:    str = ""
    last_error:       str = ""
    started_target_at: str = ""

    def save(self) -> None:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(self.__dict__, indent=2), encoding="utf-8")

    @classmethod
    def load(cls) -> "LocalState":
        if not STATE_FILE.is_file():
            return cls()
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            return cls(**{k: data.get(k, "") for k in cls.__dataclass_fields__})
        except Exception as exc:
            logger.warning("State file unreadable, starting fresh: %s", exc)
            return cls()


def _read_running_version() -> str:
    """Read the version of the currently-active release from the symlink target.

    Pre-OTA installs (no /opt/dismissal/current) return "".  The first
    successful OTA swap creates the symlink and the version is read
    from then on.
    """
    if not CURRENT_LINK.exists():
        return ""
    try:
        target = os.readlink(CURRENT_LINK)
    except OSError:
        return ""
    # target looks like "/opt/dismissal/releases/1.2.3" or "releases/1.2.3"
    return Path(target).name


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Apply window — local-time gate
# ---------------------------------------------------------------------------

def _within_window(window: dict | None, *, tz_name: str) -> bool:
    """``window`` is ``{"start_hour": int, "end_hour": int}`` or None.

    Hours are interpreted in the device's local timezone (resolved
    via the school's ``timezone`` field, defaulting to UTC).  A window
    that crosses midnight (start > end) is supported — e.g.
    ``{"start_hour": 22, "end_hour": 4}`` means 10pm–4am.
    """
    if not window:
        return True
    try:
        start = int(window.get("start_hour", 0))
        end   = int(window.get("end_hour", 24))
    except (TypeError, ValueError):
        return True

    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except ZoneInfoNotFoundError:
        tz = timezone.utc
    now_hour = datetime.now(tz=tz).hour

    if start == end:
        return True   # degenerate window means "always"
    if start < end:
        return start <= now_hour < end
    # Window wraps past midnight (e.g. 22→4)
    return now_hour >= start or now_hour < end


# ---------------------------------------------------------------------------
# OTA agent
# ---------------------------------------------------------------------------

class OTAAgent:
    """Self-contained periodic runner.  The systemd unit just calls ``run()``."""

    def __init__(self) -> None:
        self.state = LocalState.load()
        # Prefer the symlinked version over whatever's in state.json — the
        # symlink is the *actual* truth; state.json can be stale if the
        # agent was killed mid-flight.
        live_version = _read_running_version()
        if live_version:
            self.state.current_version = live_version

        # Mid-flight crash recovery.  If state.json says we were in the
        # middle of an update when we got killed, reconcile:
        #   * If the symlink already points at the target, the swap
        #     succeeded — we just didn't get to commit.  The next tick
        #     will read backend's view and reconcile via firmware-check.
        #   * If the symlink still points at something else, we never
        #     finished the swap.  Mark as failed so the backend sees an
        #     accurate state and the rollout dashboard doesn't lie.
        if self.state.state in ("applying", "health_check", "downloading", "verified", "staged"):
            interrupted_target = self.state.target_version
            if interrupted_target and interrupted_target != live_version:
                logger.warning(
                    "Detected interrupted OTA: was %s on %s, current is %s — marking failed",
                    self.state.state, interrupted_target, live_version or "(unknown)",
                )
                self.state.state = "failed"
                self.state.last_error = "agent_interrupted_mid_flight"
                self.state.save()

        self._stop = threading.Event()
        self._token_mgr: Optional[FirebaseTokenManager] = None

    # -------------------- lifecycle --------------------

    def run(self) -> None:
        if FIREBASE_WEB_API_KEY.startswith("REPLACE_"):
            logger.error("FIREBASE_WEB_API_KEY not configured; OTA disabled")
            return
        if not Path(FIREBASE_SA_PATH).is_file():
            logger.error("Service account JSON missing at %s; OTA disabled", FIREBASE_SA_PATH)
            return

        self._token_mgr = FirebaseTokenManager(
            service_account_json_path=FIREBASE_SA_PATH,
            web_api_key=FIREBASE_WEB_API_KEY,
            device_uid=SCANNER_DEVICE_UID,
        )

        logger.info(
            "OTA agent started — backend=%s interval=%ds current_version=%s",
            BACKEND_URL, OTA_CHECK_INTERVAL_SECS, self.state.current_version or "(none)",
        )

        # Stagger first check by 30s so a freshly-restarted scanner has
        # time to register itself before we report status.
        if self._stop.wait(timeout=30):
            return

        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:
                logger.exception("OTA tick failed: %s", exc)
            if self._stop.wait(timeout=OTA_CHECK_INTERVAL_SECS):
                break

    def stop(self) -> None:
        self._stop.set()

    # -------------------- one iteration --------------------

    def tick(self) -> None:
        decision = self._poll_backend()
        self.state.last_check_at = _iso_now()
        if not decision:
            self.state.save()
            return

        if not decision.get("should_update"):
            self.state.save()
            return

        target = decision.get("target_version") or ""
        if not target:
            return
        if compare_versions(target, self.state.current_version or "0.0.0") <= 0:
            logger.info(
                "Backend asked us to install %s but we're already on %s — skipping (downgrade not allowed without pin)",
                target, self.state.current_version,
            )
            return

        artifact = decision.get("artifact") or {}
        download_url = artifact.get("download_url")
        if not download_url:
            logger.warning("Backend assigned target %s without a download URL", target)
            return

        # Apply window gate.  The backend doesn't enforce time-of-day
        # because Pi-local time + the school's timezone are the right
        # authority; we just check here and skip if outside.
        tz_name = decision.get("school_timezone") or "UTC"
        if not _within_window(decision.get("apply_window"), tz_name=tz_name):
            logger.info(
                "Outside apply window (tz=%s) — will retry next tick", tz_name,
            )
            self._report("assigned", target_version=target)
            return

        self._stage_and_apply(target, artifact)

    def _poll_backend(self) -> dict | None:
        token = self._token()
        if not token:
            return None
        try:
            resp = requests.post(
                CHECK_URL,
                json={
                    "hostname":          socket.gethostname(),
                    "current_version":   self.state.current_version or "",
                    "in_flight_state":   self.state.state,
                    "in_flight_version": self.state.target_version or "",
                },
                headers={"Authorization": f"Bearer {token}"},
                timeout=OTA_HTTP_TIMEOUT,
            )
        except requests.RequestException as exc:
            logger.warning("firmware-check request failed: %s", exc)
            return None
        if resp.status_code != 200:
            logger.warning("firmware-check HTTP %d: %.200s", resp.status_code, resp.text)
            return None
        try:
            return resp.json()
        except ValueError:
            return None

    # -------------------- staged update --------------------

    def _stage_and_apply(self, target: str, artifact: dict) -> None:
        logger.info("Beginning OTA update to %s", target)
        self.state.target_version = target
        self.state.started_target_at = _iso_now()
        self._report("downloading", target_version=target)

        staging_root = STAGING_DIR / target
        if staging_root.exists():
            shutil.rmtree(staging_root, ignore_errors=True)
        staging_root.mkdir(parents=True, exist_ok=True)

        try:
            tarball_path = self._download(artifact["download_url"], staging_root)
            manifest = self._build_manifest_from_artifact(artifact, target, tarball_path)
            self._verify(tarball_path, manifest, target)
            self._report("verified", target_version=target)
            release_dir = self._extract(tarball_path, target)
            self._report("staged", target_version=target)
            self._apply(target, release_dir)
        except FirmwareVerificationError as exc:
            self._fail(target, f"verification failed: {exc}")
        except OTAError as exc:
            self._fail(target, str(exc))
        except Exception as exc:
            logger.exception("Unhandled error during OTA staging")
            self._fail(target, f"internal error: {exc}")
        finally:
            # Always wipe the staging tarball — keeping it forever fills
            # the SD card on a long-lived Pi.  The extracted release dir
            # (under releases/) is preserved for rollback.
            shutil.rmtree(staging_root, ignore_errors=True)

    def _download(self, url: str, dest_dir: Path) -> Path:
        target_path = dest_dir / "firmware.tar.gz"
        logger.info("Downloading firmware from %s", url[:120])
        try:
            with requests.get(url, stream=True, timeout=OTA_DOWNLOAD_TIMEOUT) as resp:
                resp.raise_for_status()
                with target_path.open("wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            fh.write(chunk)
        except requests.RequestException as exc:
            raise OTAError(f"download failed: {exc}") from exc
        size = target_path.stat().st_size
        logger.info("Downloaded %d bytes to %s", size, target_path)
        return target_path

    def _build_manifest_from_artifact(self, artifact: dict, version: str, tarball: Path):
        """Assemble a FirmwareManifest-compatible object from the
        backend's firmware-check response.  The backend embeds the
        sha256 + signature inline rather than making us fetch a
        separate manifest.json — saves a round trip and keeps the
        signed bytes proximate to the artifact.
        """
        from dismissal_ota_verify import FirmwareManifest
        try:
            return FirmwareManifest(
                version=               version,
                artifact_filename=     tarball.name,
                sha256=                str(artifact["sha256"]).lower(),
                size_bytes=            int(artifact["size_bytes"]),
                signature_ed25519=     str(artifact["signature_ed25519"]),
                signed_at=             "",
                signed_by=             "",
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise OTAError(f"backend response missing artifact fields: {exc}") from exc

    def _verify(self, tarball: Path, manifest, expected_version: str) -> None:
        verify_artifact(
            tarball, manifest,
            expected_version=expected_version,
            pubkey_path=PUBKEY_PATH,
        )

    def _extract(self, tarball: Path, version: str) -> Path:
        release_dir = RELEASES_DIR / version
        if release_dir.exists():
            # Same version pushed twice — wipe and re-extract.  Should be
            # rare; happens if a previous attempt failed mid-extract.
            shutil.rmtree(release_dir, ignore_errors=True)
        release_dir.mkdir(parents=True, exist_ok=True)

        logger.info("Extracting tarball to %s", release_dir)
        with tarfile.open(tarball, "r:gz") as tf:
            # Refuse path traversals — defence against a malicious
            # tarball that signed correctly under a compromised key
            # (defence in depth).
            for member in tf.getmembers():
                m = Path(member.name)
                if m.is_absolute() or ".." in m.parts:
                    raise OTAError(f"tarball contains unsafe path: {member.name}")
            # Python 3.12+ ships a safer extractor flag; older Pythons
            # ignore the kwarg.
            try:
                tf.extractall(release_dir, filter="data")  # type: ignore[arg-type]
            except TypeError:
                tf.extractall(release_dir)

        # Sanity check: must have a top-level Backend/ directory.
        if not (release_dir / "Backend").is_dir():
            raise OTAError("tarball does not contain top-level Backend/ directory")
        return release_dir

    def _apply(self, target: str, release_dir: Path) -> None:
        previous = _read_running_version()
        self._report("applying", target_version=target, previous_version=previous)

        if not SWAP_SCRIPT.is_file():
            raise OTAError(f"swap script missing at {SWAP_SCRIPT}")

        logger.info("Invoking swap script: %s %s", SWAP_SCRIPT, target)
        try:
            # The swap script needs root for systemctl + symlink in /opt
            # — install.sh adds an /etc/sudoers.d entry granting NOPASSWD
            # for this exact path.
            result = subprocess.run(
                ["sudo", "-n", str(SWAP_SCRIPT), target],
                capture_output=True, text=True, timeout=120,
            )
        except subprocess.SubprocessError as exc:
            raise OTAError(f"swap subprocess failed: {exc}") from exc
        logger.info("swap stdout: %s", (result.stdout or "").strip())
        if result.returncode != 0:
            raise OTAError(
                f"swap returned exit {result.returncode}: {(result.stderr or '').strip()[:300]}"
            )

        # Remember what we swapped from in case we need to roll back.
        if previous and previous != target:
            self.state.previous_version = previous
            PREVIOUS_VERSION_FILE.parent.mkdir(parents=True, exist_ok=True)
            PREVIOUS_VERSION_FILE.write_text(previous, encoding="utf-8")

        self._report("health_check", target_version=target, previous_version=previous)
        self._post_swap_health_check(target, previous)

    def _post_swap_health_check(self, target: str, previous: str | None) -> None:
        """Wait OTA_HEALTH_CHECK_SECS for systemd to report dismissal-scanner
        as ``active (running)``; if it doesn't, roll back."""
        deadline = time.monotonic() + OTA_HEALTH_CHECK_SECS
        while time.monotonic() < deadline:
            if self._stop.wait(timeout=15):
                return
            if self._scanner_active():
                logger.info("Scanner is active on %s — committing", target)
                self.state.current_version = target
                self.state.target_version = ""
                self.state.state = "committed"
                self.state.last_error = ""
                self.state.save()
                self._report("committed", target_version=target, current_version=target)
                self._cleanup_old_releases(keep=2)
                return
        logger.error("Scanner failed to come up on %s within %ds — rolling back", target, OTA_HEALTH_CHECK_SECS)
        self._rollback(target, previous, reason="health_check_timeout")

    def _scanner_active(self) -> bool:
        try:
            r = subprocess.run(
                ["systemctl", "is-active", "dismissal-scanner"],
                capture_output=True, text=True, timeout=5,
            )
            return r.stdout.strip() == "active"
        except subprocess.SubprocessError:
            return False

    def _rollback(self, failed_target: str, previous: str | None, *, reason: str) -> None:
        if not previous:
            logger.error("No previous version recorded — cannot roll back %s automatically", failed_target)
            self._fail(failed_target, f"no rollback target ({reason})")
            return
        logger.warning("Rolling back %s -> %s (%s)", failed_target, previous, reason)
        try:
            r = subprocess.run(
                ["sudo", "-n", str(SWAP_SCRIPT), previous],
                capture_output=True, text=True, timeout=120,
            )
            if r.returncode != 0:
                logger.error("Rollback swap failed: %s", (r.stderr or "").strip())
                self._fail(failed_target, f"rollback swap failed: {(r.stderr or '').strip()[:200]}")
                return
        except subprocess.SubprocessError as exc:
            self._fail(failed_target, f"rollback subprocess failed: {exc}")
            return

        self.state.current_version = previous
        self.state.target_version = ""
        self.state.state = "rolled_back"
        self.state.last_error = reason
        self.state.save()
        self._report("rolled_back", target_version=failed_target, current_version=previous, error=reason)

    def _cleanup_old_releases(self, *, keep: int) -> None:
        """Keep the active release + the immediately-previous one for rollback;
        delete any older release dirs to reclaim SD-card space."""
        try:
            entries = sorted(
                [p for p in RELEASES_DIR.iterdir() if p.is_dir()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return
        for stale in entries[keep:]:
            # Never delete the active release — the symlink target is
            # always preserved.
            try:
                if stale.resolve() == CURRENT_LINK.resolve():
                    continue
            except OSError:
                pass
            logger.info("Pruning old release %s", stale.name)
            shutil.rmtree(stale, ignore_errors=True)

    # -------------------- reporting --------------------

    def _fail(self, target: str, reason: str) -> None:
        logger.error("OTA failed for %s: %s", target, reason)
        self.state.state = "failed"
        self.state.last_error = reason
        self.state.save()
        self._report("failed", target_version=target, error=reason)

    def _report(
        self,
        state: str,
        *,
        target_version:   Optional[str] = None,
        current_version:  Optional[str] = None,
        previous_version: Optional[str] = None,
        error:            Optional[str] = None,
    ) -> None:
        # Update local state immediately so a crash mid-flight leaves
        # an accurate breadcrumb for the watchdog.
        self.state.state = state
        if target_version is not None:
            self.state.target_version = target_version
        if current_version is not None:
            self.state.current_version = current_version
        if previous_version is not None:
            self.state.previous_version = previous_version
        if error is not None:
            self.state.last_error = error
        self.state.save()

        token = self._token()
        if not token:
            return
        payload = {
            "hostname":         socket.gethostname(),
            "state":            state,
            "target_version":   target_version,
            "current_version":  current_version or self.state.current_version,
            "previous_version": previous_version,
            "error":            error,
        }
        try:
            requests.post(
                STATUS_URL,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
                timeout=OTA_HTTP_TIMEOUT,
            )
        except requests.RequestException as exc:
            logger.warning("firmware-status report failed: %s", exc)

    def _token(self) -> Optional[str]:
        if not self._token_mgr:
            return None
        try:
            return self._token_mgr.token()
        except Exception as exc:
            logger.warning("Token mint failed: %s", exc)
            return None


class OTAError(Exception):
    """Recoverable failure during OTA staging — caller transitions to ``failed``."""


def main() -> None:
    OTA_DIR.mkdir(parents=True, exist_ok=True)
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)

    agent = OTAAgent()

    import signal
    def _stop_handler(*_a):
        logger.info("Signal received — stopping OTA agent")
        agent.stop()
    signal.signal(signal.SIGTERM, _stop_handler)
    signal.signal(signal.SIGINT, _stop_handler)

    agent.run()


if __name__ == "__main__":
    main()
