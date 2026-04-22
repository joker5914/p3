import React, { useState } from "react";
import { FaUser, FaEnvelope, FaShieldAlt, FaEdit, FaCheck, FaTimes, FaMoon, FaSun, FaDatabase, FaSpinner, FaExclamationTriangle, FaUniversalAccess } from "react-icons/fa";
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

export default function AccountProfile({
  token, currentUser, onProfileUpdate, schoolId = null,
  dark = false, onToggleTheme,
  colorblind = false, onTogglePalette,
}) {
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(currentUser?.display_name || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Platform-admin-only data integrity check state.  Report is the
  // backend response shape; null until the first run.
  const [integrityRunning, setIntegrityRunning] = useState(false);
  const [integrityReport, setIntegrityReport] = useState(null);
  const [integrityError, setIntegrityError] = useState("");
  const [integrityExpanded, setIntegrityExpanded] = useState({});

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

  const handleRunIntegrity = async () => {
    setIntegrityRunning(true);
    setIntegrityError("");
    setIntegrityReport(null);
    try {
      const res = await api.post("/api/v1/admin/integrity/check");
      setIntegrityReport(res.data);
    } catch (err) {
      setIntegrityError(err?.response?.data?.detail || "Data integrity check failed");
    } finally {
      setIntegrityRunning(false);
    }
  };

  const toggleCheckDetails = (id) => {
    setIntegrityExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Destructive actions need a clear confirmation. The copy is tailored
  // per category so the admin knows what's about to happen.
  const FIX_CONFIRM = {
    scans: "Permanently delete every scan row whose school no longer exists? This can't be undone.",
    admins: "Clear the stale school/district links on admin users? Their accounts stay active but become unscoped until you re-home them from Platform Users.",
    devices: "Clear the stale school link on every orphan device? Devices return to 'awaiting school assignment' and their next scans get rejected until a district admin re-places them.",
  };

  const handleFixOrphans = async (category) => {
    const msg = FIX_CONFIRM[category] || "Apply fix?";
    if (!window.confirm(msg)) return;
    setIntegrityRunning(true);
    setIntegrityError("");
    try {
      await api.post(`/api/v1/admin/integrity/fix-orphans?category=${encodeURIComponent(category)}`);
      // Re-run the check so the report reflects reality.
      const res = await api.post("/api/v1/admin/integrity/check");
      setIntegrityReport(res.data);
    } catch (err) {
      setIntegrityError(err?.response?.data?.detail || "Fix failed");
    } finally {
      setIntegrityRunning(false);
    }
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
    devices: "Devices",
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
            <label className="ap-label" htmlFor="ap-display-name">
              <FaUser className="ap-label-icon" aria-hidden="true" />
              Display Name
            </label>
            {editingName ? (
              <div className="ap-edit-row">
                <input
                  id="ap-display-name"
                  className="ap-input"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") handleCancelEdit(); }}
                  disabled={saving}
                  autoFocus
                />
                <button
                  className="ap-btn-save"
                  onClick={handleSaveName}
                  disabled={saving}
                  aria-label="Save display name"
                  title="Save"
                >
                  <FaCheck aria-hidden="true" />
                </button>
                <button
                  className="ap-btn-cancel"
                  onClick={handleCancelEdit}
                  disabled={saving}
                  aria-label="Cancel edit"
                  title="Cancel"
                >
                  <FaTimes aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="ap-value-row">
                <span id="ap-display-name" className="ap-value">{currentUser?.display_name || "—"}</span>
                <button
                  className="ap-btn-edit"
                  onClick={() => { setNewName(currentUser?.display_name || ""); setEditingName(true); }}
                  aria-label="Edit display name"
                >
                  <FaEdit aria-hidden="true" /> Edit
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
              aria-pressed={dark}
            >
              <span className="ap-toggle-knob" />
            </button>
          </div>
          <div className="ap-theme-row">
            <div className="ap-theme-info">
              <span className="ap-theme-icon"><FaUniversalAccess /></span>
              <div>
                <span className="ap-value">Colorblind-Safe Palette</span>
                <span className="ap-theme-hint">
                  Use an Okabe-Ito palette for status colours so they stay distinguishable across colour-vision types.
                </span>
              </div>
            </div>
            <button
              className={`ap-theme-toggle ${colorblind ? "active" : ""}`}
              onClick={onTogglePalette}
              aria-label={colorblind ? "Disable colorblind-safe palette" : "Enable colorblind-safe palette"}
              aria-pressed={colorblind}
            >
              <span className="ap-toggle-knob" />
            </button>
          </div>
        </div>
      </div>

      {/* Data Integrity card — platform admins only */}
      {currentUser?.is_super_admin && (
        <div className="ap-card">
          <div className="ap-card-header">
            <h3 className="ap-card-title">
              <FaDatabase style={{ marginRight: 8, opacity: 0.75 }} />
              Data Integrity
            </h3>
            <span className="ap-card-subtitle">
              Compare Firestore with the platform's current data model, heal safe drift, and flag anything that needs manual review.
            </span>
          </div>
          <div className="ap-card-body">
            <div className="ap-integrity-row">
              <div className="ap-integrity-copy">
                <strong>Run a platform-wide check</strong>
                <span>
                  Sweeps districts, schools, devices, admin users, and Firebase Auth claims.
                  Fixes are idempotent — re-running this is always safe.
                </span>
              </div>
              <button
                className="ap-integrity-btn"
                onClick={handleRunIntegrity}
                disabled={integrityRunning}
              >
                {integrityRunning ? (
                  <><FaSpinner className="ap-spin" /> Checking…</>
                ) : (
                  <>Run Check</>
                )}
              </button>
            </div>

            {integrityError && (
              <div className="ap-integrity-banner error">
                <FaExclamationTriangle /> {integrityError}
              </div>
            )}

            {integrityReport && (
              <>
                <div className={`ap-integrity-banner ${integrityReport.ok ? "ok" : "drift"}`}>
                  {integrityReport.ok ? (
                    <><FaCheck /> All good — every record matches the current model.</>
                  ) : (
                    <>
                      <FaDatabase /> Reconciled <strong>{integrityReport.summary.fixed}</strong>{" "}
                      issue{integrityReport.summary.fixed === 1 ? "" : "s"}
                      {integrityReport.summary.warnings > 0 && (
                        <> · <strong>{integrityReport.summary.warnings}</strong> warning
                        {integrityReport.summary.warnings === 1 ? "" : "s"} need review</>
                      )}
                      .
                    </>
                  )}
                </div>

                <ul className="ap-integrity-list">
                  {integrityReport.checks.map((check) => {
                    const canFix = check.status === "warning" && check.fix_category;
                    return (
                      <li key={check.id} className={`ap-integrity-check ${check.status}`}>
                        <div className="ap-integrity-check-header">
                          <button
                            className="ap-integrity-check-row"
                            onClick={() => toggleCheckDetails(check.id)}
                            disabled={check.details.length === 0}
                          >
                            <span className={`ap-integrity-dot ${check.status}`} />
                            <span className="ap-integrity-label">{check.label}</span>
                            <span className={`ap-integrity-status ${check.status}`}>
                              {check.status === "fixed" && `${check.count} fixed`}
                              {check.status === "warning" && `${check.count} warning${check.count === 1 ? "" : "s"}`}
                              {check.status === "ok" && "OK"}
                            </span>
                          </button>
                          {canFix && (
                            <button
                              className="ap-integrity-fix-btn"
                              onClick={() => handleFixOrphans(check.fix_category)}
                              disabled={integrityRunning}
                              title={FIX_CONFIRM[check.fix_category]}
                            >
                              Fix
                            </button>
                          )}
                        </div>
                        {integrityExpanded[check.id] && check.details.length > 0 && (
                          <ul className="ap-integrity-details">
                            {check.details.map((d, i) => (
                              <li key={i}>{d}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>

                <p className="ap-integrity-ran-at">
                  Last run {new Date(integrityReport.ran_at).toLocaleString()}
                </p>
              </>
            )}
          </div>
        </div>
      )}

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
