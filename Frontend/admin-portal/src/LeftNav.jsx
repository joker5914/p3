import React from "react";
import "./LeftNav.css";
import { I } from "./components/icons";

/* ── Brand mark ────────────────────────────────────────
   Gradient rounded square + white "D" glyph.  Replaces the v1
   shuttle-bus SVG logo for the dark-first refresh — the gradient
   is brand-aware (Aurora cyan→violet by default; flips to citrus
   orange→pink, forest, plum if the user picks another palette). */
function BrandMark() {
  return (
    <div className="leftnav-mark" aria-hidden="true">
      D
    </div>
  );
}

const ROLE_LABELS = {
  super_admin:    "Platform Admin",
  district_admin: "District Admin",
  school_admin:   "Admin",
  staff:          "Staff",
};

function getInitials(name, email) {
  if (name && name.trim()) {
    return name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

function NavItem({ icon, label, viewName, currentView, setView, mode, badge }) {
  // Hoist the icon onto a capitalized binding so JSX renders it as a
  // component (lowercase JSX is treated as a DOM element).  The
  // capitalized name also matches the lint config's varsIgnorePattern
  // since ESLint here doesn't have react/jsx-uses-vars wired up.
  const Icon = icon;
  const active = currentView === viewName;
  const isIcon = mode === "icon";
  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setView(viewName);
    }
  };
  return (
    <li
      className={`menu-item ${active ? "active" : ""}`}
      role="link"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      aria-label={isIcon ? label : undefined}
      title={isIcon ? label : undefined}
      onClick={() => setView(viewName)}
      onKeyDown={handleKeyDown}
    >
      {/* Gradient left dot indicator — only painted on the active row.
          Sits in the row's negative left margin (full mode) or to the
          inside (icon mode) so it reads as an edge accent. */}
      {active && <span className="menu-item-dot" aria-hidden="true" />}
      <span className="menu-icon" aria-hidden="true">
        <Icon size={17} />
      </span>
      <span className="menu-label">{label}</span>
      {badge != null && (
        <span className="menu-badge t-num" aria-label={`${badge} items`}>
          {badge}
        </span>
      )}
    </li>
  );
}

export default function LeftNav({
  view,
  setView,
  currentUser,
  activeSchool,
  activeDistrict,
  isOpen,
  handleLogout,
  mode = "full",
}) {
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

  // The three top blocks above are an alternative nav for users sitting
  // above the school level — when one of them is showing, the sectioned
  // Overview/Management/Settings nav is suppressed so items (Devices,
  // Locations) aren't listed twice.
  const inTopOnlyContext = atPlatformTop || inDistrictContext || (isDistrictAdmin && !inSchoolContext);

  const hasOverview    = !(isSuperAdmin || isDistrictAdmin) || inSchoolContext;
  const hasManagement  = !inTopOnlyContext && (
    isAdmin || can("registry") || can("guardians") || can("users") ||
    can("devices") || can("site_settings") || can("audit_log")
  );
  const hasSettings    = !inTopOnlyContext && can("integrations");

  const isIcon = mode === "icon";

  const navProps = (icon, label, viewName, badge) => ({
    icon, label, viewName, badge,
    currentView: view,
    setView,
    mode,
  });

  return (
    <nav
      id="leftnav"
      className={`leftnav leftnav-mode-${mode}${isOpen ? " leftnav-open" : ""}`}
      aria-label="Main"
    >
      <div className="leftnav-header">
        <BrandMark />
        <span className="leftnav-wordmark">Dismissal</span>
      </div>

      <ul className="leftnav-menu">

        {atPlatformTop && (
          <>
            <NavItem {...navProps(I.building, "Districts",       "districts")} />
            <NavItem {...navProps(I.device,   "Devices",         "devices")} />
            <NavItem {...navProps(I.users,    "Platform Users",  "platformUsers")} />
          </>
        )}

        {inDistrictContext && (
          <>
            <NavItem {...navProps(I.globe,  "Locations",       "platformAdmin")} />
            <NavItem {...navProps(I.device, "Devices",         "devices")} />
            <NavItem {...navProps(I.key,    "Single Sign-On",  "sso")} />
          </>
        )}

        {isDistrictAdmin && !inSchoolContext && (
          <>
            <NavItem {...navProps(I.globe,  "Locations",       "platformAdmin")} />
            <NavItem {...navProps(I.device, "Devices",         "devices")} />
            <NavItem {...navProps(I.key,    "Single Sign-On",  "sso")} />
          </>
        )}

        {hasOverview && (
          <>
            <li className="leftnav-section-label t-section">Overview</li>

            {can("dashboard") && (
              <NavItem {...navProps(I.dashboard, "Dashboard", "dashboard")} />
            )}
            {can("history") && (
              <NavItem {...navProps(I.history, "History", "history")} />
            )}
            {can("reports") && (
              <NavItem {...navProps(I.insights, "Insights", "reports")} />
            )}
          </>
        )}

        {hasManagement && (
          <>
            <li className="leftnav-section-label t-section">Management</li>

            {can("site_settings") && (
              <NavItem {...navProps(I.globe, "Locations", "siteSettings")} />
            )}
            {can("devices") && (
              <NavItem {...navProps(I.device, "Devices", "devices")} />
            )}
            {can("guardians") && (
              <NavItem {...navProps(I.guardians, "Guardians", "guardians")} />
            )}
            {can("registry") && (
              <NavItem {...navProps(I.car, "Vehicles", "registry")} />
            )}
            {isAdmin && (
              <NavItem {...navProps(I.student, "Students", "students")} />
            )}
            {can("users") && (
              <NavItem {...navProps(I.users, "User Management", "users")} />
            )}
            {isAdmin && (
              <NavItem {...navProps(I.shield, "Permissions", "permissions")} />
            )}
            {can("audit_log") && (
              <NavItem {...navProps(I.audit, "Activity Log", "audit")} />
            )}
          </>
        )}

        {hasSettings && (
          <>
            <li className="leftnav-section-label t-section">Settings</li>

            {can("integrations") && (
              <NavItem {...navProps(I.puzzle, "Integrations", "integrations")} />
            )}
          </>
        )}

      </ul>

      {currentUser && (
        <div className="leftnav-bottom">
          <div
            className="leftnav-user leftnav-user-clickable"
            role="button"
            tabIndex={0}
            onClick={() => setView("profile")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setView("profile");
              }
            }}
            title={isIcon ? `Account — ${name || ""}` : "Account settings"}
            aria-label={`Account settings${name ? ` — ${name}` : ""}`}
          >
            <div className="leftnav-avatar" aria-hidden="true">{initials}</div>
            <div className="leftnav-user-info">
              {name && <span className="leftnav-user-name">{name}</span>}
              {roleLabel && (
                <span className={`leftnav-user-role t-eyebrow role-${role}`}>
                  {roleLabel}
                </span>
              )}
            </div>
            <button
              className="leftnav-settings-btn"
              onClick={(e) => { e.stopPropagation(); setView("profile"); }}
              title="Account settings"
              aria-label="Account settings"
            >
              <I.cog aria-hidden="true" size={14} />
            </button>
          </div>
          <button
            className="leftnav-signout-full"
            onClick={handleLogout}
            title="Sign Out"
            aria-label="Sign out"
          >
            <I.signOut aria-hidden="true" size={14} />
            <span className="leftnav-signout-label">Sign Out</span>
          </button>
        </div>
      )}
    </nav>
  );
}
