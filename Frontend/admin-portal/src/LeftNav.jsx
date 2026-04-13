import React from "react";
import "./LeftNav.css";
import {
  FaTachometerAlt,
  FaPuzzlePiece,
  FaLightbulb,
  FaHistory,
  FaCar,
  FaUserGraduate,
  FaUserFriends,
  FaUsers,
  FaGlobeAmericas,
  FaSignOutAlt,
  FaCog,
  FaShieldAlt,
} from "react-icons/fa";

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
        D
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
  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "school_admin" || isSuperAdmin;
  const perms = currentUser?.permissions || {};

  const can = (key) => isSuperAdmin || perms[key] === true;

  const inSchoolContext = isSuperAdmin && activeSchool;

  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);

  return (
    <nav className={`leftnav${isOpen ? " leftnav-open" : ""}`}>
      <div className="leftnav-header">
        <BrandLogo />
      </div>

      <ul className="leftnav-menu">

        {isSuperAdmin && !inSchoolContext && (
          <li
            className={`menu-item ${view === "platformAdmin" ? "active" : ""}`}
            onClick={() => setView("platformAdmin")}
          >
            <FaGlobeAmericas className="menu-icon" />
            <span>Dashboard</span>
          </li>
        )}

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

            {isAdmin && (
              <li
                className={`menu-item ${view === "students" ? "active" : ""}`}
                onClick={() => setView("students")}
              >
                <FaUserGraduate className="menu-icon" />
                <span>Students</span>
              </li>
            )}

            {isAdmin && (
              <li
                className={`menu-item ${view === "guardians" ? "active" : ""}`}
                onClick={() => setView("guardians")}
              >
                <FaUserFriends className="menu-icon" />
                <span>Guardians</span>
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

            {can("integrations") && (
              <li
                className={`menu-item ${view === "integrations" ? "active" : ""}`}
                onClick={() => setView("integrations")}
              >
                <FaPuzzlePiece className="menu-icon" />
                <span>Integrations</span>
              </li>
            )}

            {can("site_settings") && (
              <li
                className={`menu-item ${view === "siteSettings" ? "active" : ""}`}
                onClick={() => setView("siteSettings")}
              >
                <FaCog className="menu-icon" />
                <span>Site Settings</span>
              </li>
            )}

          </>
        )}

      </ul>

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
