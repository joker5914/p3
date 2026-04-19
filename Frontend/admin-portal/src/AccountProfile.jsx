import React, { useState } from "react";
import { FaUser, FaEnvelope, FaShieldAlt, FaEdit, FaCheck, FaTimes, FaMoon, FaSun } from "react-icons/fa";
import { createApiClient } from "./api";
import "./AccountProfile.css";

const ROLE_LABELS = {
  super_admin: "Platform Admin",
  school_admin: "Admin",
  staff: "Staff",
};

function getInitials(name, email) {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return "?";
}

export default function AccountProfile({ token, currentUser, onProfileUpdate, schoolId = null, dark = false, onToggleTheme }) {
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(currentUser?.display_name || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const api = createApiClient(token, schoolId);
  const role = currentUser?.role;
  const initials = getInitials(currentUser?.display_name, currentUser?.email);
  const permissions = currentUser?.permissions || {};

  const handleSaveName = async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Display name cannot be empty.");
      return;
    }
    if (trimmed === currentUser?.display_name) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.patch("/api/v1/me", { display_name: trimmed });
      setSuccess("Display name updated successfully.");
      setEditingName(false);
      if (onProfileUpdate) onProfileUpdate({ ...currentUser, display_name: trimmed });
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update display name.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setNewName(currentUser?.display_name || "");
    setEditingName(false);
    setError("");
  };

  // Must match ALL_PERMISSION_KEYS from backend schemas.py
  const permissionLabels = {
    dashboard: "Dashboard",
    history: "History",
    reports: "Reports",
    registry: "Vehicle Registry",
    registry_edit: "Registry Editing",
    users: "User Management",
    integrations: "Integrations",
    data_import: "Data Import",
    site_settings: "Locations",
  };

  return (
    <div className="ap-container">
      <div className="ap-header">
        <div className="ap-header-left">
          <h2 className="ap-title">Account Settings</h2>
          <p className="ap-subtitle">Manage your profile, appearance, and view your permissions.</p>
        </div>
      </div>

      {/* Profile card */}
      <div className="ap-card">
        <div className="ap-card-header">
          <h3 className="ap-card-title">Profile</h3>
        </div>
        <div className="ap-card-body">
          <div className="ap-profile-top">
            <div className="ap-avatar">{initials}</div>
            <div className="ap-profile-meta">
              <span className="ap-profile-name">{currentUser?.display_name || "—"}</span>
              <span className={`ap-role-badge role-${role}`}>
                <FaShieldAlt />
                {ROLE_LABELS[role] || role}
              </span>
            </div>
          </div>

          {error && <div className="ap-message ap-error">{error}</div>}
          {success && <div className="ap-message ap-success">{success}</div>}

          {/* Display Name */}
          <div className="ap-field">
            <label className="ap-label">
              <FaUser className="ap-label-icon" />
              Display Name
            </label>
            {editingName ? (
              <div className="ap-edit-row">
                <input
                  className="ap-input"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") handleCancelEdit(); }}
                  disabled={saving}
                  autoFocus
                />
                <button className="ap-btn-save" onClick={handleSaveName} disabled={saving} title="Save">
                  <FaCheck />
                </button>
                <button className="ap-btn-cancel" onClick={handleCancelEdit} disabled={saving} title="Cancel">
                  <FaTimes />
                </button>
              </div>
            ) : (
              <div className="ap-value-row">
                <span className="ap-value">{currentUser?.display_name || "—"}</span>
                <button className="ap-btn-edit" onClick={() => { setNewName(currentUser?.display_name || ""); setEditingName(true); }}>
                  <FaEdit /> Edit
                </button>
              </div>
            )}
          </div>

          {/* Email (read-only) */}
          <div className="ap-field">
            <label className="ap-label">
              <FaEnvelope className="ap-label-icon" />
              Email Address
            </label>
            <div className="ap-value-row">
              <span className="ap-value">{currentUser?.email || "—"}</span>
            </div>
          </div>

          {/* Role (read-only) */}
          <div className="ap-field">
            <label className="ap-label">
              <FaShieldAlt className="ap-label-icon" />
              Role
            </label>
            <div className="ap-value-row">
              <span className="ap-value">{ROLE_LABELS[role] || role}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Appearance card */}
      <div className="ap-card">
        <div className="ap-card-header">
          <h3 className="ap-card-title">Appearance</h3>
        </div>
        <div className="ap-card-body">
          <div className="ap-theme-row">
            <div className="ap-theme-info">
              <span className="ap-theme-icon">{dark ? <FaMoon /> : <FaSun />}</span>
              <div>
                <span className="ap-value">{dark ? "Dark Mode" : "Light Mode"}</span>
                <span className="ap-theme-hint">Switch between light and dark themes</span>
              </div>
            </div>
            <button
              className={`ap-theme-toggle ${dark ? "active" : ""}`}
              onClick={onToggleTheme}
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            >
              <span className="ap-toggle-knob" />
            </button>
          </div>
        </div>
      </div>

      {/* Permissions card */}
      {Object.keys(permissions).length > 0 && (
        <div className="ap-card">
          <div className="ap-card-header">
            <h3 className="ap-card-title">Your Permissions</h3>
            <span className="ap-card-subtitle">These are set by your administrator.</span>
          </div>
          <div className="ap-card-body">
            <div className="ap-perm-grid">
              {Object.entries(permissionLabels).map(([key, label]) => {
                const granted = permissions[key] === true;
                return (
                  <div key={key} className={`ap-perm-item ${granted ? "granted" : "denied"}`}>
                    <span className={`ap-perm-dot ${granted ? "granted" : "denied"}`} />
                    <span className="ap-perm-label">{label}</span>
                    <span className={`ap-perm-status ${granted ? "granted" : "denied"}`}>
                      {granted ? "Granted" : "Restricted"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
