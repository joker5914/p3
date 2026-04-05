import React, { useState } from "react";
import "./LeftNav.css";
import {
  FaTachometerAlt,
  FaPuzzlePiece,
  FaFileImport,
  FaChartBar,
  FaChevronRight,
} from "react-icons/fa";

export default function LeftNav({ view, setView }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

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
          className={`menu-item ${view === "reports" ? "active" : ""}`}
          onClick={() => setView("reports")}
        >
          <FaChartBar className="menu-icon" />
          <span>Reports</span>
        </li>

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
      </ul>
    </nav>
  );
}
