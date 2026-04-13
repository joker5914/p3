import React, { useState, useEffect, useMemo } from "react";
import {
  FaShieldAlt,
  FaUserShield,
  FaUser,
  FaCheck,
  FaUndo,
  FaExclamationTriangle,
} from "react-icons/fa";
import { createApiClient } from "./api";
import "./PermissionSettings.css";

const PERMISSION_META = [
  { key: "dashboard",     label: "Dashboard",         desc: "View the live arrival dashboard" },
  { key: "history",       label: "History",            desc: "View scan history and past events" },
  { key: "reports",       label: "Reports",            desc: "View analytics and reports" },
  { key: "registry",      label: "Vehicle Registry",   desc: "View the vehicle/student registry" },
  { key: "registry_edit", label: "Registry Editing",   desc: "Add, edit, and delete registry entries" },
  { key: "users",         label: "User Management",    desc: "View and manage user accounts" },
  { key: "integrations",  label: "Integrations",       desc: "Access integrations and third-party connections" },
  { key: "data_import",   label: "Data Import",        desc: "Import data from external sources" },
  { key: "site_settings", label: "Site Settings",      desc: "View and manage school/site configuration" },
];

const ROLE_INFO = {
  school_admin: {
    label: "Admin",
    Icon: FaUserShield,
    desc: "Full access by default. Customize which features admins can access.",
  },
  staff: {
    label: "Staff",
    Icon: FaUser,
    desc: "Limited access by default. Grant additional features as needed.",
  },
};

export default function PermissionSettings({ token, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [permissions, setPermissions] = useState(null);
  const [original, setOriginal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api
      .get("/api/v1/permissions")
      .then((res) => {
        setPermissions(res.data.permissions);
        setOriginal(JSON.parse(JSON.stringify(res.data.permissions)));
      })
      .catch((err) => setError(err.response?.data?.detail || "Failed to load permissions."))
      .finally(() => setLoading(false));
  }, [api]);

  const hasChanges = JSON.stringify(permissions) !== JSON.stringify(original);

  const togglePerm = (role, key) => {
    setPermissions((prev) => ({
      ...prev,
      [role]: { ...prev[role], [key]: !prev[role][key] },
    }));
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
      setError(err.response?.data?.detail || "Failed to save permissions.");
    } finally {
      setSaving(false);
    }
  };

  const grantedCount = (role) => {
    if (!permissions?.[role]) return 0;
    return Object.values(permissions[role]).filter(Boolean).length;
  };

  return (
    <div className="ps-container">
      <div className="ps-header">
        <div className="ps-header-left">
          <h2 className="ps-title">
            <FaShieldAlt className="ps-title-icon" />
            Permissions
          </h2>
          <p className="ps-subtitle">
            Configure which features each role can access. Changes apply to all users with that role.
          </p>
        </div>
        <div className="ps-header-actions">
          {hasChanges && (
            <button className="ps-btn-reset" onClick={handleReset} disabled={saving}>
              <FaUndo /> Discard
            </button>
          )}
          <button
            className="ps-btn-save"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            <FaCheck />
            {saving ? "Saving\u2026" : "Save Changes"}
          </button>
        </div>
      </div>

      {error && (
        <div className="ps-message ps-error">
          <FaExclamationTriangle /> {error}
          <button className="ps-dismiss" onClick={() => setError("")}>x</button>
        </div>
      )}
      {success && (
        <div className="ps-message ps-success">
          <FaCheck /> {success}
        </div>
      )}

      {loading ? (
        <p className="ps-loading">Loading permissions\u2026</p>
      ) : permissions && (
        <div className="ps-roles">
          {["school_admin", "staff"].map((role) => {
            const info = ROLE_INFO[role];
            const Icon = info.Icon;
            const count = grantedCount(role);
            const total = PERMISSION_META.length;

            return (
              <div key={role} className="ps-role-card">
                <div className="ps-role-header">
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
                </div>

                <div className="ps-perm-list">
                  {PERMISSION_META.map(({ key, label, desc }) => {
                    const enabled = permissions[role]?.[key] === true;
                    return (
                      <label key={key} className={`ps-perm-row ${enabled ? "enabled" : "disabled"}`}>
                        <div className="ps-perm-info">
                          <span className="ps-perm-label">{label}</span>
                          <span className="ps-perm-desc">{desc}</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          className={`ps-toggle ${enabled ? "on" : "off"}`}
                          onClick={() => togglePerm(role, key)}
                          disabled={saving}
                        >
                          <span className="ps-toggle-thumb" />
                        </button>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
