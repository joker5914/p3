import React, { useState } from "react";
import "./LeftNav.css";
import { FaTachometerAlt, FaPuzzlePiece, FaFileImport, FaChartBar } from "react-icons/fa";

export default function LeftNav({ view, setView }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

  const toggleIntegrations = () => {
    setShowIntegrations((prev) => !prev);
  };

  return (
    <nav className="leftnav">
      <ul className="leftnav-menu">
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
        <li className="menu-item" onClick={toggleIntegrations}>
          <FaPuzzlePiece className="menu-icon" />
          <span>Integrations</span>
        </li>
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
      </ul>
    </nav>
  );
}
