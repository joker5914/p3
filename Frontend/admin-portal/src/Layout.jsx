import React, { useState, useCallback, useEffect } from "react";
import { FaBars, FaTimes } from "react-icons/fa";
import LeftNav from "./LeftNav";
import Alerts from "./Alerts";
import "./Layout.css";

const VIEW_TITLES = {
  dashboard:     "Dashboard",
  history:       "History",
  reports:       "Insights",
  registry:      "Registry",
  users:         "User Management",
  dataImporter:  "Data Import",
  platformAdmin: "Platform Admin",
  students:      "Students",
  guardians:     "Guardians",
  profile:       "Account",
  permissions:   "Permissions",
  integrations:  "Integrations",
  siteSettings:  "Site Settings",
};

export default function Layout({
  children,
  view,
  setView,
  handleLogout,
  wsStatus,
  token,
  currentUser,
  activeSchool,
  setActiveSchool,
}) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    setView("platformAdmin");
    setSidebarOpen(false);
  }

  const pageTitle = VIEW_TITLES[view] || "Dashboard";

  return (
    <div className="layout-container">
      {/* Mobile-only top bar with hamburger + page title */}
      <header className="mobile-topbar">
        <button
          className="mobile-topbar-hamburger"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
        >
          {sidebarOpen ? <FaTimes /> : <FaBars />}
        </button>
        <span className="mobile-topbar-title">{pageTitle}</span>
      </header>

      {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}

      <LeftNav
        view={view}
        setView={handleSetView}
        currentUser={currentUser}
        activeSchool={activeSchool}
        isOpen={sidebarOpen}
        handleLogout={handleLogout}
      />

      <div className="layout-main">
        {isSuperAdmin && activeSchool && (
          <div className="school-context-banner">
            <span className="school-context-label">
              Viewing school:&nbsp;<strong>{activeSchool.name}</strong>
            </span>
            <button className="school-context-exit" onClick={handleExitSchool}>
              ← Back to Platform
            </button>
          </div>
        )}
        {/* Hide the system alerts bar when a super admin is in platform
            view with no school selected — there is no school context yet,
            so polling the school-scoped /api/v1/system/alerts endpoint
            every minute would return stale data for the admin's own uid. */}
        {!(isSuperAdmin && !activeSchool) && <Alerts token={token} schoolId={activeSchool?.id ?? null} />}
        <div className="layout-content">{children}</div>
      </div>
    </div>
  );
}
