import React, { useState } from "react";
import "./LeftNav.css";
import {
  FaTachometerAlt,
  FaPuzzlePiece,
  FaFileImport,
  FaLightbulb,
  FaHistory,
  FaCar,
  FaUsers,
  FaChevronRight,
  FaGlobeAmericas,
  FaSignOutAlt,
  FaCog,
  FaShieldAlt,
} from "react-icons/fa";

/* Inline SVG brand mark — swap for a real logo when available */
function BrandLogo() {
  return (
    <svg
      className="leftnav-logo-icon"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fontSize="15"
        fontWeight="700"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
        fill="white"
      >
        P³
      </text>
    </svg>
  );
}

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
  const perms = currentUser?.permissions || {};

  // Permission helpers — super_admin and school_admin always have access
  // to the permissions settings page (it's an admin-only feature).
  const can = (key) => isSuperAdmin || perms[key] === true;

  const inSchoolContext = isSuperAdmin && activeSchool;

  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);

  return (
    <nav className={`leftnav${isOpen ? " leftnav-open" : ""}`}>
      {/* Header: brand logo */}
      <div className="leftnav-header">
        <BrandLogo />
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
            {can("dashboard") && (
              <li
                className={`menu-item ${view === "dashboard" ? "active" : ""}`}
                onClick={() => setView("dashboard")}
              >
                <FaTachometerAlt className="menu-icon" />
                <span>Dashboard</span>
              </li>
            )}

            {can("history") && (
              <li
                className={`menu-item ${view === "history" ? "active" : ""}`}
                onClick={() => setView("history")}
              >
                <FaHistory className="menu-icon" />
                <span>History</span>
              </li>
            )}

            {can("reports") && (
              <li
                className={`menu-item ${view === "reports" ? "active" : ""}`}
                onClick={() => setView("reports")}
              >
                <FaLightbulb className="menu-icon" />
                <span>Insights</span>
              </li>
            )}

            {can("registry") && (
              <li
                className={`menu-item ${view === "registry" ? "active" : ""}`}
                onClick={() => setView("registry")}
              >
                <FaCar className="menu-icon" />
                <span>Registry</span>
              </li>
            )}

            {can("users") && (
              <li
                className={`menu-item ${view === "users" ? "active" : ""}`}
                onClick={() => setView("users")}
              >
                <FaUsers className="menu-icon" />
                <span>User Management</span>
              </li>
            )}

            {isAdmin && (
              <li
                className={`menu-item ${view === "permissions" ? "active" : ""}`}
                onClick={() => setView("permissions")}
              >
                <FaShieldAlt className="menu-icon" />
                <span>Permissions</span>
              </li>
            )}

            {can("data_import") && (
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
          <div
            className="leftnav-user leftnav-user-clickable"
            onClick={() => setView("profile")}
            title="Account settings"
          >
            <div className="leftnav-avatar">{initials}</div>
            <div className="leftnav-user-info">
              {name && <span className="leftnav-user-name">{name}</span>}
              {roleLabel && (
                <span className={`leftnav-user-role role-${role}`}>{roleLabel}</span>
              )}
            </div>
            <button
              className="leftnav-settings-btn"
              onClick={(e) => { e.stopPropagation(); setView("profile"); }}
              title="Account settings"
              aria-label="Account settings"
            >
              <FaCog />
            </button>
          </div>
          <button
            className="leftnav-signout-full"
            onClick={handleLogout}
            title="Sign Out"
            aria-label="Sign Out"
          >
            <FaSignOutAlt />
            <span>Sign Out</span>
          </button>
        </div>
      )}
    </nav>
  );
}
