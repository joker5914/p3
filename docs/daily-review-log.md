# Daily Review Log

## 2026-04-29 — Backend services (Cloud Run, Python/Node APIs)
- Sub-area: `Backend/dismissal_watchdog.py` (seed: ASCII-sum("2026-04-29")=499, 499 mod 8=3)
- Findings: 1
- PRs opened: #219 (fix watchdog sd_notify gap)
- Deferred: 0
- Notes: Worst-case recovery path (WiFi + scanner both failing simultaneously) blocks the loop for ~65 s of work then sleeps 30 s, producing a 95 s gap between `sd_watchdog()` pings that exceeds `WatchdogSec=90`; fixed by adding a second ping before `_shutdown.wait()`.

## 2026-04-30 — Firestore (rules, indexes, collection access)
- Sub-area: `firestore.rules` — `plates` & `plate_scans` (seed: ASCII-sum("2026-04-30")=491, 491 mod 7=1)
- Findings: 0
- PRs opened: none
- Deferred: 1 — `schools` collection `allow read: if isAuthed()` has no school scoping; FIRESTORE.md notes enrollment codes are stored there; any authenticated user can read any school's document; needs human review to confirm whether cross-school read is intentional.
- Notes: Reviewed `plates` and `plate_scans` rules; all access patterns are correctly school-scoped and role-gated; no qualifying defects found in the assigned sub-area.
