import React, { useState, useEffect, useMemo } from "react";
import { FaUndo } from "react-icons/fa";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import "./PermissionSettings.css";

// Permission tree.  Items are either leaf permissions (single key) or
// groups bundling related view/edit pairs under a parent label so the
// list stays scannable as new permissions are added.  The parent toggle
// follows the standard "apply to all" pattern: any-on → tap turns all
// off; all-off → tap turns all on; mixed shows a tri-state thumb.
//
// Children's `key` MUST match a value in the backend's
// ALL_PERMISSION_KEYS — only those keys round-trip through
// PUT /api/v1/permissions; the parent `id` is UI-only and never sent.
const PERMISSION_TREE = [
  { kind: "leaf", key: "dashboard", label: "Dashboard",        desc: "View the live arrival dashboard" },
  { kind: "leaf", key: "history",   label: "History",          desc: "View scan history and past events" },
  { kind: "leaf", key: "reports",   label: "Insights",         desc: "View the Insights dashboard (analytics, trends, confidence metrics)" },
  {
    kind: "group", id: "vehicle_registry",
    label: "Vehicle Registry",
    desc:  "View and edit the vehicle/student registry",
    children: [
      { key: "registry",      label: "View", desc: "View the vehicle/student registry" },
      { key: "registry_edit", label: "Edit", desc: "Add, edit, and delete registry entries" },
    ],
  },
  {
    kind: "group", id: "guardians",
    label: "Guardians",
    desc:  "View and manage guardian records",
    children: [
      { key: "guardians",      label: "View", desc: "View the guardian directory and see which students each guardian is linked to" },
      { key: "guardians_edit", label: "Edit", desc: "Assign schools, edit profiles, and remove guardian records" },
    ],
  },
  { kind: "leaf", key: "students_edit", label: "Student Editing",  desc: "Edit student names and grade after they've been added (admin-only by default)" },
  { kind: "leaf", key: "users",         label: "User Management",  desc: "View and manage user accounts" },
  { kind: "leaf", key: "data_import",   label: "Data Import",      desc: "Import data from external sources" },
  { kind: "leaf", key: "devices",       label: "Devices",          desc: "View scanner health and edit device location labels" },
  { kind: "leaf", key: "audit_log",     label: "Activity Log",     desc: "View the audit trail of privileged actions and sign-ins across the school" },
];

// Flat list of every backend key the tree manages — used for the
// "X / total enabled" badge and any future keys-only operations.
const ALL_TREE_KEYS = PERMISSION_TREE.flatMap((item) =>
  item.kind === "leaf" ? [item.key] : item.children.map((c) => c.key),
);

const ROLE_INFO = {
  school_admin: {
    label: "Admin",
    Icon: I.shield,
    desc: "Full access by default. Customize which features admins can access.",
  },
  staff: {
    label: "Staff",
    Icon: I.user,
    desc: "Limited access by default. Grant additional features as needed.",
  },
};

// Group toggle state derived from its children:
//   "on"    — every child enabled
//   "off"   — every child disabled
//   "mixed" — partial; tri-state thumb in CSS
function deriveGroupState(rolePerms, group) {
  const onCount = group.children.filter((c) => rolePerms?.[c.key] === true).length;
  if (onCount === 0) return "off";
  if (onCount === group.children.length) return "on";
  return "mixed";
}

export default function PermissionSettings({ token, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [permissions, setPermissions] = useState(null);
  const [original, setOriginal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Role cards default collapsed for a compact overview; tap to drill
  // into a role's permissions.  Sub-permission groups likewise default
  // collapsed because the common case is granting the whole bundle —
  // granular view/edit is the exception.
  const [expandedRoles, setExpandedRoles] = useState(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  useEffect(() => {
    setLoading(true);
    setError("");
    api
      .get("/api/v1/permissions")
      .then((res) => {
        setPermissions(res.data.permissions);
        setOriginal(JSON.parse(JSON.stringify(res.data.permissions)));
      })
      .catch((err) => setError(formatApiError(err, "Failed to load permissions.")))
      .finally(() => setLoading(false));
  }, [api]);

  const hasChanges = JSON.stringify(permissions) !== JSON.stringify(original);

  const togglePerm = (role, key) => {
    setPermissions((prev) => ({
      ...prev,
      [role]: { ...prev[role], [key]: !prev[role][key] },
    }));
  };

  // Standard "apply to all" pattern: any child on → tap turns all off;
  // all off → tap turns all on.  Matches GitHub / macOS Finder grouped
  // toggle behavior so it doesn't surprise users.
  const toggleGroup = (role, group) => {
    setPermissions((prev) => {
      const childKeys = group.children.map((c) => c.key);
      const anyOn = childKeys.some((k) => prev[role]?.[k] === true);
      const target = !anyOn;
      const nextRole = { ...prev[role] };
      childKeys.forEach((k) => { nextRole[k] = target; });
      return { ...prev, [role]: nextRole };
    });
  };

  const toggleRoleExpansion = (role) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  };

  const toggleGroupExpansion = (role, groupId) => {
    const id = `${role}.${groupId}`;
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleReset = () => {
    setPermissions(JSON.parse(JSON.stringify(original)));
    setSuccess("");
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const res = await api.put("/api/v1/permissions", permissions);
      const saved = res.data.permissions;
      setPermissions(saved);
      setOriginal(JSON.parse(JSON.stringify(saved)));
      setSuccess("Permissions saved successfully.");
      setTimeout(() => setSuccess(""), 4000);
    } catch (err) {
      setError(formatApiError(err, "Failed to save permissions."));
    } finally {
      setSaving(false);
    }
  };

  const grantedCount = (role) => {
    if (!permissions?.[role]) return 0;
    return ALL_TREE_KEYS.filter((k) => permissions[role][k] === true).length;
  };

  return (
    <div className="ps-container">
      <div className="ps-header">
        <div className="ps-header-left">
          <h2 className="ps-title">
            <I.shield size={16} className="ps-title-icon" aria-hidden="true" />
            Permissions
          </h2>
          <p className="ps-subtitle">
            Configure which features each role can access. Changes apply to all users with that role.
          </p>
        </div>
        <div className="ps-header-actions">
          {hasChanges && (
            <button className="ps-btn-reset" onClick={handleReset} disabled={saving}>
              <FaUndo aria-hidden="true" /> Discard
            </button>
          )}
          <button
            className="ps-btn-save"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            <I.check size={12} aria-hidden="true" />
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="ps-message ps-error">
          <I.alert size={14} aria-hidden="true" /> {error}
          <button className="ps-dismiss" onClick={() => setError("")}>x</button>
        </div>
      )}
      {success && (
        <div className="ps-message ps-success">
          <I.check size={12} aria-hidden="true" /> {success}
        </div>
      )}

      {loading ? (
        <p className="ps-loading">Loading permissions…</p>
      ) : permissions && (
        <div className="ps-roles">
          {["school_admin", "staff"].map((role) => {
            const info = ROLE_INFO[role];
            const Icon = info.Icon;
            const count = grantedCount(role);
            const total = ALL_TREE_KEYS.length;
            const roleExpanded = expandedRoles.has(role);
            const bodyId = `ps-role-body-${role}`;

            return (
              <div key={role} className="ps-role-card">
                <button
                  type="button"
                  className={`ps-role-header${roleExpanded ? " expanded" : ""}`}
                  onClick={() => toggleRoleExpansion(role)}
                  aria-expanded={roleExpanded}
                  aria-controls={bodyId}
                >
                  <I.chevronRight
                    size={14}
                    className={`ps-role-chevron${roleExpanded ? " open" : ""}`}
                    aria-hidden="true"
                  />
                  <div className="ps-role-info">
                    <div className={`ps-role-icon-wrap role-${role}`}>
                      <Icon />
                    </div>
                    <div>
                      <h3 className="ps-role-name">{info.label}</h3>
                      <p className="ps-role-desc">{info.desc}</p>
                    </div>
                  </div>
                  <span className="ps-role-count">
                    {count}/{total} enabled
                  </span>
                </button>

                {roleExpanded && (
                  <div id={bodyId} className="ps-perm-list">
                    {PERMISSION_TREE.map((item) => {
                      if (item.kind === "leaf") {
                        const enabled = permissions[role]?.[item.key] === true;
                        return (
                          <div key={item.key} className={`ps-perm-row leaf ${enabled ? "enabled" : "disabled"}`}>
                            <div className="ps-perm-info">
                              <span className="ps-perm-label">{item.label}</span>
                              <span className="ps-perm-desc">{item.desc}</span>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={enabled}
                              aria-label={`${info.label}: ${item.label}`}
                              className={`ps-toggle ${enabled ? "on" : "off"}`}
                              onClick={() => togglePerm(role, item.key)}
                              disabled={saving}
                            >
                              <span className="ps-toggle-thumb" />
                            </button>
                          </div>
                        );
                      }

                      // Group row + (when expanded) indented children
                      const state = deriveGroupState(permissions[role], item);
                      const groupExpanded = expandedGroups.has(`${role}.${item.id}`);
                      const childListId = `ps-group-${role}-${item.id}`;
                      // Toggle uses role=checkbox so we can express the
                      // tri-state cleanly via aria-checked="mixed".
                      // Switches in ARIA only support true/false.
                      const ariaChecked = state === "mixed" ? "mixed" : state === "on";

                      return (
                        <div key={item.id} className={`ps-perm-group state-${state}${groupExpanded ? " expanded" : ""}`}>
                          <div className="ps-perm-row group-parent">
                            <button
                              type="button"
                              className={`ps-group-expand${groupExpanded ? " open" : ""}`}
                              onClick={() => toggleGroupExpansion(role, item.id)}
                              aria-expanded={groupExpanded}
                              aria-controls={childListId}
                              aria-label={`${groupExpanded ? "Collapse" : "Expand"} ${item.label} sub-permissions`}
                            >
                              <I.chevronRight size={12} aria-hidden="true" />
                            </button>
                            <div className="ps-perm-info">
                              <span className="ps-perm-label">{item.label}</span>
                              <span className="ps-perm-desc">{item.desc}</span>
                            </div>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={ariaChecked}
                              aria-label={`${info.label}: ${item.label} (grants all sub-permissions)`}
                              className={`ps-toggle ${state}`}
                              onClick={() => toggleGroup(role, item)}
                              disabled={saving}
                            >
                              <span className="ps-toggle-thumb" />
                            </button>
                          </div>

                          {groupExpanded && (
                            <div id={childListId} className="ps-perm-children">
                              {item.children.map((child) => {
                                const enabled = permissions[role]?.[child.key] === true;
                                return (
                                  <div
                                    key={child.key}
                                    className={`ps-perm-row child ${enabled ? "enabled" : "disabled"}`}
                                  >
                                    <div className="ps-perm-info">
                                      <span className="ps-perm-label">{child.label}</span>
                                      <span className="ps-perm-desc">{child.desc}</span>
                                    </div>
                                    <button
                                      type="button"
                                      role="switch"
                                      aria-checked={enabled}
                                      aria-label={`${info.label}: ${item.label} – ${child.label}`}
                                      className={`ps-toggle ${enabled ? "on" : "off"}`}
                                      onClick={() => togglePerm(role, child.key)}
                                      disabled={saving}
                                    >
                                      <span className="ps-toggle-thumb" />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
