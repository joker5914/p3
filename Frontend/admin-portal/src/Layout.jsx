import React from "react";
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
}) {
  const isSuperAdmin = currentUser?.role === "super_admin";

  function handleExitSchool() {
    setActiveSchool(null);
    setView("platformAdmin");
  }

  return (
    <div className="layout-container">
      <Navbar
        handleLogout={handleLogout}
        currentUser={currentUser}
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
        <LeftNav
          view={view}
          setView={setView}
          currentUser={currentUser}
          activeSchool={activeSchool}
        />
        <div className="layout-content">{children}</div>
      </div>
    </div>
  );
}
