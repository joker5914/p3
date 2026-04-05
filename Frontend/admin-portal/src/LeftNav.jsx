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
  FaSchool,
  FaChevronRight,
  FaGlobeAmericas,
} from "react-icons/fa";

export default function LeftNav({ view, setView, currentUser, activeSchool }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "school_admin" || isSuperAdmin;

  // Super admin in school context shows school-level nav; otherwise platform nav
  const inSchoolContext = isSuperAdmin && activeSchool;

  return (
    <nav className="leftnav">
      {/* Brand lockup */}
      <div className="leftnav-brand">
        <div className="leftnav-brand-mark">P³</div>
        <div>
          <div className="leftnav-brand-name">P3 Admin</div>
          <div className="leftnav-brand-sub">
            {isSuperAdmin ? "Platform" : activeSchool?.name || "School Portal"}
          </div>
        </div>
      </div>

      <ul className="leftnav-menu">

        {/* ── Platform section (super_admin only, no school context) ───────── */}
        {isSuperAdmin && !inSchoolContext && (
          <>
            <li className="leftnav-section-label">Platform</li>
            <li
              className={`menu-item ${view === "platformAdmin" ? "active" : ""}`}
              onClick={() => setView("platformAdmin")}
            >
              <FaGlobeAmericas className="menu-icon" />
              <span>Schools</span>
            </li>
          </>
        )}

        {/* ── School-level nav (school_admin, staff, or super_admin in school context) ── */}
        {(!isSuperAdmin || inSchoolContext) && (
          <>
            {inSchoolContext && (
              <li className="leftnav-section-label">{activeSchool.name}</li>
            )}

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
          </>
        )}

      </ul>
    </nav>
  );
}
