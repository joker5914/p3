import React, { useState, useCallback, useEffect } from "react";
import Navbar from "./Navbar";
import LeftNav from "./LeftNav";
import Alerts from "./Alerts";
import "./Layout.css";

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
  arrivalAlerts,
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

  return (
    <div className="layout-container">
      <Navbar
        onToggleSidebar={toggleSidebar}
        arrivalAlerts={arrivalAlerts}
      />
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
      <Alerts token={token} />
      <div className="layout-body">
        {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
        <LeftNav
          view={view}
          setView={handleSetView}
          currentUser={currentUser}
          activeSchool={activeSchool}
          isOpen={sidebarOpen}
          handleLogout={handleLogout}
        />
        <div className="layout-content">{children}</div>
      </div>
    </div>
  );
}
