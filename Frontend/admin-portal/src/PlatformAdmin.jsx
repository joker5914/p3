import React, { useState, useEffect, useCallback } from "react";
import { FaSchool, FaPlus, FaSpinner, FaCog, FaBan, FaCheckCircle, FaPencilAlt } from "react-icons/fa";
import { createApiClient } from "./api";
import "./PlatformAdmin.css";

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function StatusBadge({ status }) {
  return (
    <span className={`pa-badge pa-badge--${status === "active" ? "active" : "suspended"}`}>
      {status === "active" ? "Active" : "Suspended"}
    </span>
  );
}

export default function PlatformAdmin({ token, setActiveSchool, setView }) {
  const [schools, setSchools] = useState([]);
  const [stats, setStats]     = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", admin_email: "", timezone: "America/New_York" });
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState(null);

  // Edit modal
  const [editingSchool, setEditingSchool] = useState(null); // school object being edited
  const [editForm, setEditForm]           = useState({ name: "", admin_email: "", timezone: "" });
  const [saving, setSaving]               = useState(false);
  const [editError, setEditError]         = useState(null);

  // Per-school toggle
  const [toggling, setToggling] = useState(null);

  const api = useCallback(() => createApiClient(token), [token]);

  const fetchSchools = useCallback(() => {
    setLoading(true);
    setError(null);
    api()
      .get("/api/v1/admin/schools")
      .then((res) => { setSchools(res.data.schools || []); setLoading(false); })
      .catch((err) => { setError(err.response?.data?.detail || "Failed to load schools"); setLoading(false); });
  }, [api]);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);

  useEffect(() => {
    if (!schools.length) return;
    schools.forEach((school) => {
      api()
        .get(`/api/v1/admin/schools/${school.id}/stats`)
        .then((res) => setStats((prev) => ({ ...prev, [school.id]: res.data })))
        .catch(() => {});
    });
  }, [schools, api]);

  // ── Create ──────────────────────────────────────────────────────────────
  function handleCreateChange(e) {
    const { name, value } = e.target;
    setCreateForm((f) => ({ ...f, [name]: value }));
  }

  function handleCreateSubmit(e) {
    e.preventDefault();
    if (!createForm.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    api()
      .post("/api/v1/admin/schools", createForm)
      .then((res) => {
        setSchools((prev) => [...prev, res.data].sort((a, b) => (a.name || "").localeCompare(b.name || "")));
        setCreateForm({ name: "", admin_email: "", timezone: "America/New_York" });
        setShowCreate(false);
        setCreating(false);
      })
      .catch((err) => { setCreateError(err.response?.data?.detail || "Failed to create school"); setCreating(false); });
  }

  // ── Edit ────────────────────────────────────────────────────────────────
  function openEdit(school) {
    setEditingSchool(school);
    setEditForm({ name: school.name || "", admin_email: school.admin_email || "", timezone: school.timezone || "America/New_York" });
    setEditError(null);
  }

  function handleEditChange(e) {
    const { name, value } = e.target;
    setEditForm((f) => ({ ...f, [name]: value }));
  }

  function handleEditSubmit(e) {
    e.preventDefault();
    if (!editForm.name.trim()) return;
    setSaving(true);
    setEditError(null);
    api()
      .patch(`/api/v1/admin/schools/${editingSchool.id}`, {
        name: editForm.name.trim(),
        admin_email: editForm.admin_email.trim(),
        timezone: editForm.timezone,
      })
      .then(() => {
        setSchools((prev) =>
          prev.map((s) =>
            s.id === editingSchool.id
              ? { ...s, name: editForm.name.trim(), admin_email: editForm.admin_email.trim(), timezone: editForm.timezone }
              : s
          ).sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        );
        setEditingSchool(null);
        setSaving(false);
      })
      .catch((err) => { setEditError(err.response?.data?.detail || "Failed to save changes"); setSaving(false); });
  }

  // ── Toggle status ────────────────────────────────────────────────────────
  function handleToggleStatus(school) {
    const newStatus = school.status === "active" ? "suspended" : "active";
    setToggling(school.id);
    api()
      .patch(`/api/v1/admin/schools/${school.id}`, { status: newStatus })
      .then(() => {
        setSchools((prev) => prev.map((s) => s.id === school.id ? { ...s, status: newStatus } : s));
        setToggling(null);
      })
      .catch(() => setToggling(null));
  }

  function handleManage(school) {
    setActiveSchool({ id: school.id, name: school.name });
    setView("dashboard");
  }

  if (loading) {
    return (
      <div className="pa-loading">
        <FaSpinner className="pa-spinner" />
        <span>Loading schools…</span>
      </div>
    );
  }

  return (
    <div className="pa-container">
      {/* Header */}
      <div className="pa-header">
        <div className="pa-header-left">
          <h1 className="pa-title">Platform Admin</h1>
          <p className="pa-subtitle">{schools.length} school{schools.length !== 1 ? "s" : ""} on platform</p>
        </div>
        <button className="pa-btn-primary" onClick={() => setShowCreate((v) => !v)}>
          <FaPlus /> New School
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="pa-card pa-create-card">
          <h2 className="pa-card-title">Create School</h2>
          <form className="pa-form" onSubmit={handleCreateSubmit}>
            <div className="pa-field">
              <label className="pa-label">School Name *</label>
              <input className="pa-input" name="name" value={createForm.name} onChange={handleCreateChange} placeholder="e.g. Riverside Elementary" required />
            </div>
            <div className="pa-field">
              <label className="pa-label">Primary Admin Email (optional)</label>
              <input className="pa-input" name="admin_email" type="email" value={createForm.admin_email} onChange={handleCreateChange} placeholder="principal@school.edu" />
            </div>
            <div className="pa-field">
              <label className="pa-label">Timezone</label>
              <select className="pa-select" name="timezone" value={createForm.timezone} onChange={handleCreateChange}>
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
            {createError && <p className="pa-error">{createError}</p>}
            <div className="pa-form-actions">
              <button type="button" className="pa-btn-ghost" onClick={() => { setShowCreate(false); setCreateError(null); }}>Cancel</button>
              <button type="submit" className="pa-btn-primary" disabled={creating}>
                {creating ? <FaSpinner className="pa-spinner-sm" /> : null}
                {creating ? "Creating…" : "Create School"}
              </button>
            </div>
          </form>
        </div>
      )}

      {error && <div className="pa-alert">{error}</div>}

      {/* Schools table */}
      {schools.length === 0 ? (
        <div className="pa-empty">
          <FaSchool className="pa-empty-icon" />
          <p>No schools yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <thead>
              <tr>
                <th>School</th>
                <th>Status</th>
                <th>Plates</th>
                <th>Users</th>
                <th>Scans</th>
                <th>Timezone</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schools.map((school) => {
                const s = stats[school.id];
                return (
                  <tr key={school.id}>
                    <td>
                      <div className="pa-school-name">{school.name}</div>
                      {school.admin_email && <div className="pa-school-email">{school.admin_email}</div>}
                    </td>
                    <td><StatusBadge status={school.status} /></td>
                    <td className="pa-stat">{s ? s.plates : "—"}</td>
                    <td className="pa-stat">{s ? s.users : "—"}</td>
                    <td className="pa-stat">{s ? s.scans : "—"}</td>
                    <td className="pa-tz">{school.timezone || "—"}</td>
                    <td>
                      <div className="pa-actions">
                        <button className="pa-btn-action" onClick={() => handleManage(school)} title="Manage school">
                          <FaCog /> Manage
                        </button>
                        <button className="pa-btn-action pa-btn-edit" onClick={() => openEdit(school)} title="Edit school settings">
                          <FaPencilAlt /> Edit
                        </button>
                        <button
                          className={`pa-btn-action pa-btn-toggle ${school.status !== "active" ? "pa-btn-restore" : ""}`}
                          onClick={() => handleToggleStatus(school)}
                          disabled={toggling === school.id}
                          title={school.status === "active" ? "Suspend school" : "Reactivate school"}
                        >
                          {toggling === school.id ? <FaSpinner className="pa-spinner-sm" /> : school.status === "active" ? <FaBan /> : <FaCheckCircle />}
                          {school.status === "active" ? "Suspend" : "Restore"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit School Modal */}
      {editingSchool && (
        <div className="pa-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditingSchool(null)}>
          <div className="pa-modal">
            <div className="pa-modal-header">
              <h2 className="pa-modal-title">Edit School</h2>
              <button className="pa-modal-close" onClick={() => setEditingSchool(null)}>×</button>
            </div>
            <form className="pa-form" onSubmit={handleEditSubmit}>
              <div className="pa-field">
                <label className="pa-label">School Name *</label>
                <input className="pa-input" name="name" value={editForm.name} onChange={handleEditChange} required />
              </div>
              <div className="pa-field">
                <label className="pa-label">Primary Admin Email</label>
                <input className="pa-input" name="admin_email" type="email" value={editForm.admin_email} onChange={handleEditChange} placeholder="principal@school.edu" />
              </div>
              <div className="pa-field">
                <label className="pa-label">Timezone</label>
                <select className="pa-select" name="timezone" value={editForm.timezone} onChange={handleEditChange}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              {editError && <p className="pa-error">{editError}</p>}
              <div className="pa-form-actions">
                <button type="button" className="pa-btn-ghost" onClick={() => setEditingSchool(null)}>Cancel</button>
                <button type="submit" className="pa-btn-primary" disabled={saving}>
                  {saving ? <FaSpinner className="pa-spinner-sm" /> : null}
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
