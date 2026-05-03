# Daily Review Log

## 2026-05-03 — Infra & deploy config
- Sub-area: `deploy/install.sh` (seed: 1c4f8e30, hash mod 7 = 3)
- Findings: 2
- PRs opened: #257 (guard OTA layout symlink on re-run), #258 (remove /var/log tmpfs conflicting with Storage=persistent)
- Deferred: 0
- Notes: Both bugs interact on re-run scenarios — #257 would silently revert OTA-updated Pis to the bootstrap release; #258 wipes the persistent journal on every reboot, defeating the field-debug fix that journald-dismissal.conf was explicitly introduced to provide.

## 2026-04-29 — Backend services (Cloud Run, Python/Node APIs)
- Sub-area: `Backend/dismissal_watchdog.py` (seed: ASCII-sum("2026-04-29")=499, 499 mod 8=3)
- Findings: 1
- PRs opened: #219 (fix watchdog sd_notify gap)
- Deferred: 0
- Notes: Worst-case recovery path (WiFi + scanner both failing simultaneously) blocks the loop for ~65 s of work then sleeps 30 s, producing a 95 s gap between `sd_watchdog()` pings that exceeds `WatchdogSec=90`; fixed by adding a second ping before `_shutdown.wait()`.
