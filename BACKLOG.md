# P³ Portal — Backlog

Items below are features that are currently **incomplete, non-functional, or stubbed out** in the portal. They are separate from the original roadmap — this file tracks things that need to be finished to make the shipped codebase fully functional.

---

## High Priority

### B-1. Navbar search bar is non-functional
The search bar in the top navbar accepts no input — it is rendered with `readOnly`.

**Current state:** `Navbar.jsx` line 53 — `<input ... readOnly />`. Placeholder text reads "Search by name, plate, guardian..." but the input is inert.

**Work needed:**
- Remove `readOnly` and add `value` + `onChange` state
- Implement client-side filtering across the current view's data (queue cards, history rows, registry rows)
- Or implement a backend `GET /api/v1/search?q=…` endpoint for global search
- Show results inline (filtered view) or in a dropdown overlay
- Consider debouncing the search input

---

### B-2. Integrations page is dead code
`Integrations.jsx` exists but is never imported into `App.jsx` or routed to. The LeftNav "Integrations" section is a collapsible group that directly routes to `dataImporter`, bypassing this component entirely.

**Current state:** The file is a stub with a dropdown that only has "Data Importer" as an option and a comment `{/* Future integration options can be added here */}`.

**Work needed:**
- **Option A:** Delete `Integrations.jsx` and `Integrations.css` — they're dead code. The LeftNav submenu pattern already works.
- **Option B:** Build out a proper integrations hub page (e.g. SIS sync, webhook config, API key management) and route to it in `App.jsx`.

---

### B-3. Error feedback on dashboard card actions is console-only
When dismissing a card or clearing the queue fails, the error is only logged to `console.error`. Users on the carline won't see browser dev tools.

**Current state:** `Dashboard.jsx` — `handleDismiss` (line 47), `handleClear` (line 61), `handleBulkPickup` (line 79) all catch errors and log to console. `handleClear` and `handleBulkPickup` also show `alert()`, but `handleDismiss` silently fails.

**Work needed:**
- Show an inline error toast or revert the card's "Marking…" state with a visible failure indicator
- Replace `window.alert()` calls with styled inline error banners consistent with the rest of the UI

---

## Medium Priority

### B-4. System alerts fetch errors are silently swallowed
`Alerts.jsx` line 17 catches fetch failures with `.catch(() => {})` — if the backend is unreachable, alerts silently stop updating with no indication to the user.

**Work needed:**
- Add a subtle error state (e.g. a small "Unable to fetch alerts" notice) after consecutive failures
- Log to console for debugging

---

### B-5. Platform Admin school stats fail silently
`PlatformAdmin.jsx` fetches per-school statistics (plate count, user count, scan count). Failures are swallowed: `.catch(() => {})`.

**Work needed:**
- Show dash placeholders on failure (already the default), but consider a retry button or error indicator after repeated failures
- Add console logging for debugging

---

### B-6. Firebase Analytics not wired up
`firebase-config.js` lines 3 and 18 have analytics imports commented out with "Uncomment later for Google Analytics integration".

**Work needed:**
- Uncomment `getAnalytics` import and initialisation when ready to track page views and events
- Or remove the commented-out code and the `measurementId` from the config if analytics is not planned

---

### B-7. Dashboard `schoolId` not passed to initial queue fetch
`App.jsx` line 121 fetches the dashboard queue via `createApiClient(token)` without passing `schoolId`. When a super_admin is viewing a specific school, the initial load may return the wrong school's queue.

**Current state:** The WebSocket connection correctly uses the school-scoped token, so real-time updates are correct. But the initial `GET /api/v1/dashboard` call may not be scoped.

**Work needed:**
- Pass `schoolId` (from `activeSchool?.id`) to `createApiClient(token, schoolId)` in the dashboard fetch effect
- Add `activeSchool` to the effect dependency array

---

## Low Priority / Polish

### B-8. Loading states are plain text
`Reports.jsx` shows "Loading report..." and `History.jsx` shows "Loading history..." as plain text. Other pages have similar bare loading states.

**Work needed:**
- Add skeleton loading screens or spinner components consistent with the design system
- Create a shared `<LoadingState />` component

---

### B-9. No prop validation anywhere
No component uses PropTypes or TypeScript for prop validation. Invalid props fail silently at runtime.

**Work needed:**
- Add PropTypes to all components, or migrate to TypeScript
- Focus first on components that receive data from API responses (Dashboard, History, VehicleRegistry)

---

### B-10. `window.confirm()` and `window.alert()` dialogs
Several actions use native browser dialogs (`window.confirm` for destructive actions, `window.alert` for errors) which are unstyled and jarring.

**Work needed:**
- Replace with styled confirmation modals consistent with the design system (similar to `SessionTimeout` modal pattern)
- Candidates: "Clear all scans" confirm, "Bulk pickup" confirm, "Delete vehicle" confirm, "Delete user" confirm

---

### B-11. CSV export is client-side only — no streaming for large data sets
`utils.js` uses PapaParse `unparse` to generate CSV in memory. For schools with thousands of records, this could cause browser memory issues.

**Work needed:**
- For History export, consider a backend endpoint that streams CSV directly
- Or paginate the client-side generation with a progress indicator

---

### B-12. BenefactorPortal dark mode coverage
The BenefactorPortal (guardian/parent view) has its own CSS file that was not updated with `[data-theme="dark"]` overrides when dark mode was added.

**Work needed:**
- Add dark mode CSS overrides to `BenefactorPortal.css`
- Also add dark mode overrides to `DataImporter.css` and `Integrations.css`
