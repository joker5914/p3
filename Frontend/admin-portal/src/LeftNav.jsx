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
  FaSearch,
  FaSignOutAlt,
} from "react-icons/fa";

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

export default function LeftNav({ view, setView, currentUser, activeSchool, isOpen, handleLogout }) {
  const [showIntegrations, setShowIntegrations] = useState(false);

  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "school_admin" || isSuperAdmin;

  const inSchoolContext = isSuperAdmin && activeSchool;

  // Org name shown in the selector at top
  const orgName = activeSchool?.name
    || (isSuperAdmin ? "P³ Platform" : currentUser?.display_name || "P³");

  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);

  return (
    <nav className={`leftnav${isOpen ? " leftnav-open" : ""}`}>
      {/* Org selector */}
      <div className="leftnav-org">
        <span className="leftnav-org-name">{orgName}</span>
        <FaChevronRight className="leftnav-org-chevron" />
      </div>

      {/* Search bar */}
      <div className="leftnav-search-wrapper">
        <FaSearch className="leftnav-search-icon" />
        <input
          className="leftnav-search"
          type="search"
          placeholder="Search..."
          readOnly
        />
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

      {/* Bottom: user profile + sign out */}
      {currentUser && (
        <div className="leftnav-bottom">
          <div className="leftnav-user">
            <div className="leftnav-avatar">{initials}</div>
            <div className="leftnav-user-info">
              {name && <span className="leftnav-user-name">{name}</span>}
              {roleLabel && (
                <span className={`leftnav-user-role role-${role}`}>{roleLabel}</span>
              )}
            </div>
            <button
              className="leftnav-signout"
              onClick={handleLogout}
              title="Sign Out"
              aria-label="Sign Out"
            >
              <FaSignOutAlt />
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
