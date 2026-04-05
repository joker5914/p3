import React from "react";
import "./Navbar.css";

const ROLE_LABELS = {
  school_admin: "Admin",
  staff: "Staff",
};

export default function Navbar({ handleLogout, wsStatus, currentUser }) {
  const wsLabel =
    wsStatus === "connected" ? "Live" : wsStatus === "error" ? "Error" : "Reconnecting";

  const name = currentUser?.display_name || currentUser?.email || "";
  const roleLabel = ROLE_LABELS[currentUser?.role] ?? "";

  return (
    <nav className="navbar">
      <div className="navbar-brand">P³</div>

      <div className="navbar-right">
        <span className={`navbar-ws-pill ${wsStatus}`}>
          <span className="navbar-ws-dot" />
          {wsLabel}
        </span>

        {currentUser && (
          <div className="navbar-user">
            {name && <span className="navbar-user-name">{name}</span>}
            {roleLabel && (
              <span className={`navbar-user-role role-${currentUser.role}`}>{roleLabel}</span>
            )}
          </div>
        )}

        <button className="nav-btn" onClick={handleLogout}>Sign Out</button>
      </div>
    </nav>
  );
}
