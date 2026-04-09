import React, { useState, useEffect, useCallback } from "react";
import { FaMoon, FaSun, FaBars } from "react-icons/fa";
import { ArrivalAlertToggle } from "./ArrivalToast";
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

function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("p3-theme");
    if (stored) return stored === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  useEffect(() => {
    document.body.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("p3-theme", dark ? "dark" : "light");
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  return { dark, toggle };
}

export default function Navbar({ handleLogout, currentUser, onToggleSidebar, arrivalAlerts }) {
  const role      = currentUser?.role;
  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);
  const { dark, toggle: toggleTheme } = useTheme();

  return (
    <nav className="navbar">
      {/* Hamburger — visible on mobile only */}
      {onToggleSidebar && (
        <button className="navbar-hamburger" onClick={onToggleSidebar} aria-label="Toggle navigation">
          <FaBars />
        </button>
      )}

      {/* Center: search bar */}
      <input
        className="navbar-search"
        type="search"
        placeholder="Search by name, plate, guardian..."
        readOnly
      />

      {/* Right: user + sign out */}
      <div className="navbar-right">
        {arrivalAlerts && (
          <ArrivalAlertToggle enabled={arrivalAlerts.enabled} onToggle={arrivalAlerts.toggle} />
        )}

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          title={dark ? "Light mode" : "Dark mode"}
        >
          <span className="theme-toggle-icon">
            {dark ? <FaSun /> : <FaMoon />}
          </span>
        </button>

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
