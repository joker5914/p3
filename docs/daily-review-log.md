# Daily Review Log

## 2026-04-29 — Backend services (Cloud Run, Python/Node APIs)
- Sub-area: `Backend/dismissal_watchdog.py` (seed: ASCII-sum("2026-04-29")=499, 499 mod 8=3)
- Findings: 1
- PRs opened: #219 (fix watchdog sd_notify gap)
- Deferred: 0
- Notes: Worst-case recovery path (WiFi + scanner both failing simultaneously) blocks the loop for ~65 s of work then sleeps 30 s, producing a 95 s gap between `sd_watchdog()` pings that exceeds `WatchdogSec=90`; fixed by adding a second ping before `_shutdown.wait()`.

## 2026-05-02 — CI/CD (GitHub Actions)
- Sub-area: N/A — blocked before sub-area selection (seed: N/A)
- Findings: 0
- PRs opened: none
- Deferred: 0
- Notes: GitHub MCP denied access to joker5914/p3 on both retries (session is scoped to joker5914/dismissal only); could not inspect `.github/workflows/*.yml`. Per §7, recording the failure here to be re-investigated on the next Saturday run.
