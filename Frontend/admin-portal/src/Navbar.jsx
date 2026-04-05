import React from "react";
import "./Navbar.css";

const ROLE_LABELS = {
  super_admin:  "Platform Admin",
  school_admin: "Admin",
  staff:        "Staff",
};

function getInitials(name, email) {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

export default function Navbar({ handleLogout, wsStatus, currentUser, activeSchool }) {
  const role      = currentUser?.role;
  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);

  // Super admins in platform view don't have a WebSocket — hide the pill.
  // Show it only when in a school dashboard context.
  const isSuperAdmin      = role === "super_admin";
  const showWsPill        = !isSuperAdmin || !!activeSchool;
  const wsLabel           = wsStatus === "connected" ? "Live" : wsStatus === "error" ? "Error" : "Reconnecting";

  return (
    <nav className="navbar">
      {/* Left: intentionally empty — brand lives in sidebar */}
      <div className="navbar-left" />

      {/* Right: status + user + sign out */}
      <div className="navbar-right">
        {showWsPill && (
          <span className={`navbar-ws-pill ${wsStatus}`}>
            <span className="navbar-ws-dot" />
            {wsLabel}
          </span>
        )}

        {currentUser && (
          <div className="navbar-user">
            <div className="navbar-avatar">{initials}</div>
            <div className="navbar-user-info">
              {name && <span className="navbar-user-name">{name}</span>}
              {roleLabel && (
                <span className={`navbar-user-role role-${role}`}>{roleLabel}</span>
              )}
            </div>
          </div>
        )}

        <button className="nav-btn" onClick={handleLogout}>Sign Out</button>
      </div>
    </nav>
  );
}
