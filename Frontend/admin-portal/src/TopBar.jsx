import { useEffect } from "react";
import { I } from "./components/icons";
import "./TopBar.css";

/* ── TopBar ─────────────────────────────────────────────
   56px sticky blurred glass.  Layout:
     [panel toggle] [school name] / [page crumb]   [search] [Live] [bell]

   The panel toggle cycles the sidebar mode (full ↔ icon).  Hidden mode
   is reachable from the Settings page (or by future keyboard shortcut)
   so users can't accidentally lose the nav with no way back.

   Theme + colorblind toggles intentionally do NOT live here — per the
   refresh plan they belong in the Account / Settings page.

   Search input is decorative for now (no global search backend yet);
   the visual is wired so the wiring drops in cleanly when search ships.
   ────────────────────────────────────────────────────── */

const VIEW_TITLES = {
  dashboard:      "Dashboard",
  history:        "History",
  reports:        "Insights",
  registry:       "Vehicles",
  users:          "User Management",
  dataImporter:   "Data Import",
  platformAdmin:  "Locations",
  districts:      "Districts",
  platformUsers:  "Platform Users",
  devices:        "Devices",
  students:       "Students",
  guardians:      "Guardians",
  profile:        "Account",
  permissions:    "Permissions",
  integrations:   "Integrations",
  siteSettings:   "Locations",
  sso:            "Single Sign-On",
  audit:          "Activity Log",
};

function nextSidebarMode(mode) {
  // Cycle full ↔ icon.  "hidden" is intentionally not in the cycle —
  // see component header comment.
  return mode === "icon" ? "full" : "icon";
}

export default function TopBar({
  view,
  activeSchool,
  activeDistrict,
  currentUser,
  wsStatus,
  sidebarMode,
  setSidebarMode,
  arrivalAlerts,
}) {
  const pageTitle = VIEW_TITLES[view] || "Dashboard";

  // Breadcrumb context: prefer the active school name, fall back to
  // the active district, fall back to the user's role label so the
  // crumb is always grounded.
  let context = "Dismissal";
  if (activeSchool?.name)        context = activeSchool.name;
  else if (activeDistrict?.name) context = activeDistrict.name;
  else if (currentUser?.role === "super_admin") context = "Platform";

  const liveOn = wsStatus === "connected";

  // ⌘K / Ctrl-K placeholder shortcut — listens but currently no-ops
  // since global search isn't wired yet.  Kept so the kbd hint isn't
  // a lie; swap the body for whatever opens the search palette later.
  useEffect(() => {
    const handler = (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Future: open search palette here.
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const cycleSidebar = () => setSidebarMode((m) => nextSidebarMode(m));

  return (
    <div className="topbar" role="banner">
      <div className="topbar-left">
        <button
          type="button"
          className="topbar-icon-btn"
          onClick={cycleSidebar}
          aria-label={
            sidebarMode === "icon"
              ? "Expand sidebar"
              : "Collapse sidebar to icons"
          }
          aria-pressed={sidebarMode === "icon"}
          title={sidebarMode === "icon" ? "Expand sidebar" : "Collapse sidebar"}
        >
          <I.panel size={16} />
        </button>

        <span className="topbar-context t-meta">{context}</span>
        <span className="topbar-crumb-sep" aria-hidden="true">/</span>
        <span className="topbar-crumb">{pageTitle}</span>
      </div>

      <div className="topbar-right">
        {/* Decorative search input — global search isn't wired yet.
            Render as a div, not an <input>, so screen readers don't
            promise text input that doesn't work.  Reachable as a
            single button-like element. */}
        <button type="button" className="topbar-search" aria-label="Search (coming soon)">
          <I.search size={14} />
          <span className="topbar-search-placeholder">
            Search students, plates, vehicles…
          </span>
          <span className="topbar-kbd t-num">⌘K</span>
        </button>

        <span className="topbar-sep" aria-hidden="true" />

        <span
          className={`topbar-live${liveOn ? " topbar-live-on" : ""}`}
          aria-live="polite"
          aria-label={liveOn ? "Live updates connected" : "Live updates disconnected"}
        >
          <span className="topbar-live-dot" aria-hidden="true" />
          <span className="topbar-live-label">Live</span>
        </span>

        {arrivalAlerts && (
          <button
            type="button"
            className={`topbar-icon-btn topbar-bell${arrivalAlerts.enabled ? "" : " topbar-bell-muted"}`}
            onClick={arrivalAlerts.toggle}
            aria-label={arrivalAlerts.enabled ? "Mute arrival alerts" : "Enable arrival alerts"}
            aria-pressed={arrivalAlerts.enabled}
            title={arrivalAlerts.enabled ? "Arrival alerts on" : "Arrival alerts muted"}
          >
            {arrivalAlerts.enabled ? <I.bell size={16} /> : <I.bellSlash size={16} />}
          </button>
        )}
      </div>
    </div>
  );
}
