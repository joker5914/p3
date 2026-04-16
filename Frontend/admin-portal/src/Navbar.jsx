import React, { useState, useEffect, useCallback } from "react";
import { FaMoon, FaSun, FaColumns } from "react-icons/fa";
import { ArrivalAlertToggle } from "./ArrivalToast";
import "./Navbar.css";

const VIEW_TITLES = {
  dashboard:      "Dashboard",
  history:        "History",
  reports:        "Reports",
  registry:       "Registry",
  users:          "User Management",
  dataImporter:   "Data Import",
  platformAdmin:  "Dashboard",
  devices:        "Devices",
};

function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("dismissal-theme");
    if (stored) return stored === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  useEffect(() => {
    document.body.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("dismissal-theme", dark ? "dark" : "light");
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  return { dark, toggle };
}

export default function Navbar({ onToggleSidebar, arrivalAlerts, view }) {
  const { dark, toggle: toggleTheme } = useTheme();
  const pageTitle = VIEW_TITLES[view] || "Dashboard";

  return (
    <nav className="navbar">
      {/* Left: sidebar toggle + page title */}
      <div className="navbar-left">
        {onToggleSidebar && (
          <button className="navbar-sidebar-toggle" onClick={onToggleSidebar} aria-label="Toggle sidebar">
            <FaColumns />
          </button>
        )}
        <span className="navbar-page-title">{pageTitle}</span>
      </div>

      <div className="navbar-spacer" />

      {/* Right: alerts + theme toggle */}
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
      </div>
    </nav>
  );
}
