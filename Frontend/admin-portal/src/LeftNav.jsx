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
  FaMicrochip,
  FaBuilding,
} from "react-icons/fa";

function BrandLogo() {
  return (
    <svg className="leftnav-logo-icon" width="26" height="26" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="28" rx="6" fill="#1a3a6b"/>
      <path d="M5 10C5 8.9 5.9 8 7 8H21C22.1 8 23 8.9 23 10V18C23 18.55 22.78 19.05 22.41 19.41L22 20H6L5.59 19.41C5.22 19.05 5 18.55 5 18V10Z" fill="#4285f4"/>
      <line x1="5" y1="14" x2="23" y2="14" stroke="#1a3a6b" strokeWidth="1.5"/>
      <line x1="11" y1="8" x2="11" y2="20" stroke="#1a3a6b" strokeWidth="1.5"/>
      <line x1="17" y1="8" x2="17" y2="20" stroke="#1a3a6b" strokeWidth="1.5"/>
      <circle cx="9" cy="21.5" r="2" fill="#4285f4"/>
      <circle cx="19" cy="21.5" r="2" fill="#4285f4"/>
      <rect x="5" y="5" width="12" height="4" rx="1" fill="#5a9cf8"/>
    </svg>
  );
}

const ROLE_LABELS = {
  super_admin:   "Platform Admin",
  district_admin:"District Admin",
  school_admin:  "Admin",
  staff:         "Staff",
};

function getInitials(name, email) {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

function NavItem({ icon, label, viewName, currentView, setView }) {
  return (
    <li
      className={`menu-item ${currentView === viewName ? "active" : ""}`}
      onClick={() => setView(viewName)}
    >
      {icon}
      <span>{label}</span>
    </li>
  );
}

export default function LeftNav({ view, setView, currentUser, activeSchool, activeDistrict, isOpen, handleLogout }) {
  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const isDistrictAdmin = role === "district_admin";
  const isAdmin = role === "school_admin" || isSuperAdmin || isDistrictAdmin;
  const perms = currentUser?.permissions || {};

  const can = (key) => isSuperAdmin || isDistrictAdmin || perms[key] === true;

  const inSchoolContext = (isSuperAdmin || isDistrictAdmin) && activeSchool;
  const inDistrictContext = isSuperAdmin && activeDistrict && !activeSchool;
  // District admins are always in their own district — they never see the
  // platform-level Districts list, so their "top" is the Locations view.
  const atPlatformTop = isSuperAdmin && !activeDistrict && !activeSchool;

  const roleLabel = ROLE_LABELS[role] ?? "";
  const name      = currentUser?.display_name || currentUser?.email || "";
  const initials  = getInitials(currentUser?.display_name, currentUser?.email);

  const hasOverview    = !(isSuperAdmin || isDistrictAdmin) || inSchoolContext;
  const hasManagement  = isAdmin || can("registry") || can("users") || can("devices");
  const hasSettings    = can("integrations") || can("site_settings");

  return (
    <nav className={`leftnav${isOpen ? " leftnav-open" : ""}`}>

      <div className="leftnav-header">
        <BrandLogo />
        <span className="leftnav-wordmark">Dismissal</span>
      </div>

      <ul className="leftnav-menu">

        {atPlatformTop && (
          <>
            <NavItem icon={<FaBuilding className="menu-icon" />} label="Districts" viewName="districts" currentView={view} setView={setView} />
            <NavItem icon={<FaMicrochip className="menu-icon" />} label="Devices" viewName="devices" currentView={view} setView={setView} />
            <NavItem icon={<FaUsers className="menu-icon" />} label="Platform Users" viewName="platformUsers" currentView={view} setView={setView} />
          </>
        )}

        {inDistrictContext && (
          <>
            <NavItem icon={<FaGlobeAmericas className="menu-icon" />} label="Locations" viewName="platformAdmin" currentView={view} setView={setView} />
            <NavItem icon={<FaMicrochip className="menu-icon" />} label="Devices" viewName="devices" currentView={view} setView={setView} />
          </>
        )}

        {isDistrictAdmin && !inSchoolContext && (
          <>
            <NavItem icon={<FaGlobeAmericas className="menu-icon" />} label="Locations" viewName="platformAdmin" currentView={view} setView={setView} />
            <NavItem icon={<FaMicrochip className="menu-icon" />} label="Devices" viewName="devices" currentView={view} setView={setView} />
          </>
        )}

        {hasOverview && (
          <>
            <li className="leftnav-section-label">Overview</li>

            {can("dashboard") && (
              <NavItem icon={<FaTachometerAlt className="menu-icon" />} label="Dashboard" viewName="dashboard" currentView={view} setView={setView} />
            )}
            {can("history") && (
              <NavItem icon={<FaHistory className="menu-icon" />} label="History" viewName="history" currentView={view} setView={setView} />
            )}
            {can("reports") && (
              <NavItem icon={<FaLightbulb className="menu-icon" />} label="Insights" viewName="reports" currentView={view} setView={setView} />
            )}

            {hasManagement && <li className="leftnav-divider" />}
          </>
        )}

        {hasManagement && (
          <>
            <li className="leftnav-section-label">Management</li>

            {can("registry") && (
              <NavItem icon={<FaCar className="menu-icon" />} label="Registry" viewName="registry" currentView={view} setView={setView} />
            )}
            {isAdmin && (
              <NavItem icon={<FaUserGraduate className="menu-icon" />} label="Students" viewName="students" currentView={view} setView={setView} />
            )}
            {isAdmin && (
              <NavItem icon={<FaUserFriends className="menu-icon" />} label="Guardians" viewName="guardians" currentView={view} setView={setView} />
            )}
            {can("users") && (
              <NavItem icon={<FaUsers className="menu-icon" />} label="User Management" viewName="users" currentView={view} setView={setView} />
            )}
            {isAdmin && (
              <NavItem icon={<FaShieldAlt className="menu-icon" />} label="Permissions" viewName="permissions" currentView={view} setView={setView} />
            )}
            {/* School-level Devices view — only surfaces here when not
                already shown by the platform-top / district-context
                blocks at the top of this nav. */}
            {!atPlatformTop && !inDistrictContext && can("devices") && (
              <NavItem icon={<FaMicrochip className="menu-icon" />} label="Devices" viewName="devices" currentView={view} setView={setView} />
            )}

            {hasSettings && <li className="leftnav-divider" />}
          </>
        )}

        {hasSettings && (
          <>
            <li className="leftnav-section-label">Settings</li>

            {can("integrations") && (
              <NavItem icon={<FaPuzzlePiece className="menu-icon" />} label="Integrations" viewName="integrations" currentView={view} setView={setView} />
            )}
            {can("site_settings") && (
              <NavItem icon={<FaCog className="menu-icon" />} label="Locations" viewName="siteSettings" currentView={view} setView={setView} />
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
