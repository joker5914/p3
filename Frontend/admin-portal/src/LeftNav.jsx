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
  FaGlobeAmericas,
} from "react-icons/fa";

export default function LeftNav({ view, setView, currentUser, activeSchool, isOpen }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "school_admin" || isSuperAdmin;

  const inSchoolContext = isSuperAdmin && activeSchool;

  // Org name shown in the selector at top
  const orgName = activeSchool?.name
    || (isSuperAdmin ? "P³ Platform" : currentUser?.display_name || "P³");

  return (
    <nav className={`leftnav${isOpen ? " leftnav-open" : ""}`}>
      {/* Org selector */}
      <div className="leftnav-org">
        <span className="leftnav-org-name">{orgName}</span>
        <FaChevronRight className="leftnav-org-chevron" />
      </div>

      <ul className="leftnav-menu">

        {/* Platform nav — super_admin, no school context */}
        {isSuperAdmin && !inSchoolContext && (
          <li
            className={`menu-item ${view === "platformAdmin" ? "active" : ""}`}
            onClick={() => setView("platformAdmin")}
          >
            <FaGlobeAmericas className="menu-icon" />
            <span>Dashboard</span>
          </li>
        )}

        {/* School-level nav */}
        {(!isSuperAdmin || inSchoolContext) && (
          <>
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

            {isAdmin && (
              <li
                className={`menu-item ${view === "users" ? "active" : ""}`}
                onClick={() => setView("users")}
              >
                <FaUsers className="menu-icon" />
                <span>User Management</span>
              </li>
            )}

            {isAdmin && (
              <li>
                <button
                  className="menu-item-toggle"
                  onClick={() => setShowIntegrations((p) => !p)}
                >
                  <FaPuzzlePiece className="menu-icon" />
                  <span>Integrations</span>
                  <FaChevronRight className={`menu-chevron ${showIntegrations ? "open" : ""}`} />
                </button>
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
          </>
        )}

      </ul>
    </nav>
  );
}
