import React, { useState, useEffect, useCallback } from "react";
import { FaMoon, FaSun, FaBars } from "react-icons/fa";
import { ArrivalAlertToggle } from "./ArrivalToast";
import "./Navbar.css";

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

export default function Navbar({ onToggleSidebar, arrivalAlerts }) {
  const { dark, toggle: toggleTheme } = useTheme();

  return (
    <nav className="navbar">
      {/* Hamburger — visible on mobile only */}
      {onToggleSidebar && (
        <button className="navbar-hamburger" onClick={onToggleSidebar} aria-label="Toggle navigation">
          <FaBars />
        </button>
      )}

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
