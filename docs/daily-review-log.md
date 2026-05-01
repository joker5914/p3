# Daily Review Log

## 2026-04-29 — Backend services (Cloud Run, Python/Node APIs)
- Sub-area: `Backend/dismissal_watchdog.py` (seed: ASCII-sum("2026-04-29")=499, 499 mod 8=3)
- Findings: 1
- PRs opened: #219 (fix watchdog sd_notify gap)
- Deferred: 0
- Notes: Worst-case recovery path (WiFi + scanner both failing simultaneously) blocks the loop for ~65 s of work then sleeps 30 s, producing a 95 s gap between `sd_watchdog()` pings that exceeds `WatchdogSec=90`; fixed by adding a second ping before `_shutdown.wait()`.

## 2026-05-01 — Auth (Firebase Auth + WebSocket auth + sessions)
- Sub-area: `Frontend/admin-portal/src/SessionTimeoutWarning.jsx` (seed: ASCII-sum("2026-05-01")=490, 490 mod 8=2)
- Findings: 2
- PRs opened: #231 (re-focus action button when modal transitions to expired state), #232 (callback ref for Escape handler to fix stale refreshing closure)
- Deferred: 0
- Notes: Both defects are in the same file — #231 fixes a WCAG focus-order regression where the "Stay signed in" button unmounting on countdown-zero leaves keyboard users with no focused element inside the alertdialog; #232 fixes a stale closure in the `[open]`-gated Escape keydown handler that bypassed the `if (refreshing) return` guard, allowing a second concurrent `getIdToken(true)` call mid-flight.
