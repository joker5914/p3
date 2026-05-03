import React, { useState, useCallback, useEffect } from "react";
import { I } from "./components/icons";
import LeftNav from "./LeftNav";
import TopBar from "./TopBar";
import Alerts from "./Alerts";
import "./Layout.css";

const VIEW_TITLES = {
  dashboard:     "Dashboard",
  history:       "History",
  reports:       "Insights",
  registry:      "Vehicles",
  users:         "User Management",
  dataImporter:  "Data Import",
  platformAdmin: "Locations",
  districts:      "Districts",
  platformUsers:  "Platform Users",
  emailLogs:      "Email Delivery",
  devices:       "Devices",
  students:      "Students",
  guardians:     "Guardians",
  profile:       "Account",
  permissions:   "Permissions",
  integrations:  "Integrations",
  sso:           "Single Sign-On",
  audit:         "Activity Log",
};

export default function Layout({
  children,
  view,
  setView,
  handleLogout,
  token,
  currentUser,
  activeSchool,
  setActiveSchool,
  activeDistrict,
  setActiveDistrict,
  arrivalAlerts,
  onOpenSearch,
}) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar width mode: "full" | "icon" | "hidden".  Persisted in
  // localStorage (per the refresh plan, sidebar mode is per-session
  // and doesn't need server-side preference).  The topbar's panel
  // button cycles between full and icon; "hidden" is reachable from
  // Settings or via future keyboard shortcut.
  const [sidebarMode, setSidebarMode] = useState(() => {
    const stored = localStorage.getItem("dismissal-sidebar-mode");
    return stored === "icon" || stored === "hidden" ? stored : "full";
  });
  useEffect(() => {
    localStorage.setItem("dismissal-sidebar-mode", sidebarMode);
  }, [sidebarMode]);

  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  const closeSidebar  = useCallback(() => setSidebarOpen(false), []);

  // Close sidebar when navigating
  const handleSetView = useCallback((v) => {
    setView(v);
    setSidebarOpen(false);
  }, [setView]);

  // Close sidebar on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function handleExitSchool() {
    setActiveSchool(null);
    // Super admins with an active district go back to that district's
    // Locations view; otherwise back to the Districts list.
    if (isSuperAdmin && activeDistrict) {
      setView("platformAdmin");
    } else if (isSuperAdmin) {
      setView("districts");
    } else {
      setView("platformAdmin");
    }
    setSidebarOpen(false);
  }

  function handleExitDistrict() {
    if (setActiveDistrict) setActiveDistrict(null);
    setView("districts");
    setSidebarOpen(false);
  }

  const pageTitle = VIEW_TITLES[view] || "Dashboard";

  return (
    <div className="layout-container">
      {/* First focusable element on the page — hidden off-screen until a
          keyboard user Tabs to it, then revealed (see .skip-link in
          index.css).  Jumps focus past the sidebar straight to the main
          content region so AT users don't have to Tab through 10+ menu
          items on every page load. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Mobile-only top bar with hamburger + page title */}
      <header className="mobile-topbar">
        <button
          className="mobile-topbar-hamburger"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          aria-controls="leftnav"
        >
          {sidebarOpen ? <I.x aria-hidden="true" /> : <I.bars aria-hidden="true" />}
        </button>
        <span className="mobile-topbar-title">{pageTitle}</span>
      </header>

      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <LeftNav
        view={view}
        setView={handleSetView}
        currentUser={currentUser}
        activeSchool={activeSchool}
        activeDistrict={activeDistrict}
        isOpen={sidebarOpen}
        handleLogout={handleLogout}
        mode={sidebarMode}
      />

      {/* layout-main is a layout container, not a landmark — TopBar
          carries role="banner" and lives inside it, so promoting this
          div to <main> would nest a banner inside main (invalid per
          ARIA landmark rules).  The actual main landmark is layout-content
          below, which holds the routed page body and is the skip-link's
          jump target. */}
      <div className="layout-main">
        <TopBar
          view={view}
          activeSchool={activeSchool}
          activeDistrict={activeDistrict}
          currentUser={currentUser}
          sidebarMode={sidebarMode}
          setSidebarMode={setSidebarMode}
          arrivalAlerts={arrivalAlerts}
          onOpenSearch={onOpenSearch}
        />
        {isSuperAdmin && !activeSchool && activeDistrict && (
          <div className="school-context-banner">
            <span className="school-context-label">
              Managing district:&nbsp;<strong>{activeDistrict.name}</strong>
            </span>
            <button className="school-context-exit" onClick={handleExitDistrict}>
              ← All Districts
            </button>
          </div>
        )}
        {(isSuperAdmin || isDistrictAdmin) && activeSchool && (
          <div className="school-context-banner">
            <span className="school-context-label">
              Viewing school:&nbsp;<strong>{activeSchool.name}</strong>
              {activeDistrict && <> · {activeDistrict.name}</>}
            </span>
            <button className="school-context-exit" onClick={handleExitSchool}>
              ← Back {activeDistrict ? "to District" : "to Platform"}
            </button>
          </div>
        )}
        {/* Hide the system alerts bar when a super admin is in platform
            view with no school selected — there is no school context yet,
            so polling the school-scoped /api/v1/system/alerts endpoint
            every minute would return stale data for the admin's own uid. */}
        {!(isSuperAdmin && !activeSchool) && <Alerts token={token} schoolId={activeSchool?.id ?? null} />}
        <main className="layout-content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
