import React, { useState, useEffect, useCallback } from "react";
import { FaMoon, FaSun, FaColumns, FaUniversalAccess } from "react-icons/fa";
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

// Colorblind-safe palette toggle — persists alongside the theme and sets
// data-palette on <body>.  index.css has the Okabe-Ito overrides keyed on
// this attribute; it layers cleanly over both light and dark themes.
function usePalette() {
  const [colorblind, setColorblind] = useState(() => {
    return localStorage.getItem("dismissal-palette") === "colorblind";
  });

  useEffect(() => {
    if (colorblind) document.body.setAttribute("data-palette", "colorblind");
    else document.body.removeAttribute("data-palette");
    localStorage.setItem("dismissal-palette", colorblind ? "colorblind" : "default");
  }, [colorblind]);

  const toggle = useCallback(() => setColorblind((c) => !c), []);
  return { colorblind, toggle };
}

export default function Navbar({ onToggleSidebar, arrivalAlerts, view }) {
  const { dark, toggle: toggleTheme } = useTheme();
  const { colorblind, toggle: togglePalette } = usePalette();
  const pageTitle = VIEW_TITLES[view] || "Dashboard";

  return (
    <nav className="navbar" aria-label="Primary">
      {/* Left: sidebar toggle + page title */}
      <div className="navbar-left">
        {onToggleSidebar && (
          <button className="navbar-sidebar-toggle" onClick={onToggleSidebar} aria-label="Toggle sidebar">
            <FaColumns aria-hidden="true" />
          </button>
        )}
        <span className="navbar-page-title">{pageTitle}</span>
      </div>

      <div className="navbar-spacer" />

      {/* Right: alerts + palette + theme toggle */}
      <div className="navbar-right">
        {arrivalAlerts && (
          <ArrivalAlertToggle enabled={arrivalAlerts.enabled} onToggle={arrivalAlerts.toggle} />
        )}

        <button
          className={`theme-toggle${colorblind ? " theme-toggle-active" : ""}`}
          onClick={togglePalette}
          aria-label={
            colorblind
              ? "Disable colorblind-safe palette"
              : "Enable colorblind-safe palette"
          }
          aria-pressed={colorblind}
          title={colorblind ? "Colorblind palette: on" : "Colorblind palette: off"}
        >
          <span className="theme-toggle-icon">
            <FaUniversalAccess aria-hidden="true" />
          </span>
        </button>

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          aria-pressed={dark}
          title={dark ? "Light mode" : "Dark mode"}
        >
          <span className="theme-toggle-icon">
            {dark ? <FaSun aria-hidden="true" /> : <FaMoon aria-hidden="true" />}
          </span>
        </button>
      </div>
    </nav>
  );
}
