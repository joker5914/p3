import React, { useState } from "react";
import "./LeftNav.css";
import {
  FaTachometerAlt,
  FaPuzzlePiece,
  FaFileImport,
  FaChartBar,
  FaHistory,
  FaCar,
  FaUsers,
  FaChevronRight,
} from "react-icons/fa";

export default function LeftNav({ view, setView, currentUser }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

  const isAdmin = currentUser?.role === "school_admin";

  return (
    <nav className="leftnav">
      <ul className="leftnav-menu" style={{ listStyle: "none" }}>

        <li
          className={`menu-item ${view === "dashboard" ? "active" : ""}`}
          onClick={() => setView("dashboard")}
        >
          <FaTachometerAlt className="menu-icon" />
          <span>Dashboard</span>
        </li>

        <li
          className={`menu-item ${view === "history" ? "active" : ""}`}
          onClick={() => setView("history")}
        >
          <FaHistory className="menu-icon" />
          <span>History</span>
        </li>

        <li
          className={`menu-item ${view === "reports" ? "active" : ""}`}
          onClick={() => setView("reports")}
        >
          <FaChartBar className="menu-icon" />
          <span>Reports</span>
        </li>

        <li
          className={`menu-item ${view === "registry" ? "active" : ""}`}
          onClick={() => setView("registry")}
        >
          <FaCar className="menu-icon" />
          <span>Registry</span>
        </li>

        {/* Admin-only: user management */}
        {isAdmin && (
          <li
            className={`menu-item ${view === "users" ? "active" : ""}`}
            onClick={() => setView("users")}
          >
            <FaUsers className="menu-icon" />
            <span>Admin Users</span>
          </li>
        )}

        {/* Integrations — hidden for staff; they cannot import data */}
        {isAdmin && (
          <li>
            <div
              className="menu-item-toggle"
              onClick={() => setShowIntegrations((p) => !p)}
            >
              <FaPuzzlePiece className="menu-icon" />
              <span>Integrations</span>
              <FaChevronRight className={`menu-chevron ${showIntegrations ? "open" : ""}`} />
            </div>
            {showIntegrations && (
              <ul className="submenu">
                <li
                  className={`submenu-item ${view === "dataImporter" ? "active" : ""}`}
                  onClick={() => setView("dataImporter")}
                >
                  <FaFileImport className="submenu-icon" />
                  <span>Data Import</span>
                </li>
              </ul>
            )}
          </li>
        )}

      </ul>
    </nav>
  );
}
