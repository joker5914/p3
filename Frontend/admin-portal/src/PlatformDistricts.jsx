import React, { useState, useEffect, useCallback } from "react";
import {
  FaBuilding,
  FaPlus,
  FaSpinner,
  FaCog,
  FaBan,
  FaCheckCircle,
  FaPencilAlt,
  FaCertificate,
} from "react-icons/fa";
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

const LICENSE_TIERS = [
  { value: "trial", label: "Trial" },
  { value: "basic", label: "Basic" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
  { value: "enterprise", label: "Enterprise" },
];

function StatusBadge({ status }) {
  return (
    <span className={`pa-badge pa-badge--${status === "active" ? "active" : "suspended"}`}>
      {status === "active" ? "Active" : "Suspended"}
    </span>
  );
}

function LicenseChip({ licensed }) {
  return (
    <span className={`pa-badge pa-badge--${licensed ? "active" : "suspended"}`}>
      {licensed ? "Licensed" : "Unlicensed"}
    </span>
  );
}

export default function PlatformDistricts({ token, setActiveDistrict, setView }) {
  const [districts, setDistricts] = useState([]);
  const [stats, setStats]         = useState({});
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // Create / edit form
  const [formOpen, setFormOpen]     = useState(false);
  const [formMode, setFormMode]     = useState("create");
  const [formId, setFormId]         = useState(null);
  const [form, setForm]             = useState({
    name: "", admin_email: "", timezone: "America/New_York",
    is_licensed: false, license_tier: "trial", license_expires_at: "",
    notes: "",
  });
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState(null);

  const [toggling, setToggling]     = useState(null);

  const api = useCallback(() => createApiClient(token), [token]);

  const fetchDistricts = useCallback(() => {
    setLoading(true);
    setError(null);
    api()
      .get("/api/v1/admin/districts")
      .then((res) => { setDistricts(res.data.districts || []); setLoading(false); })
      .catch((err) => { setError(err.response?.data?.detail || "Failed to load districts"); setLoading(false); });
  }, [api]);

  useEffect(() => { fetchDistricts(); }, [fetchDistricts]);

  useEffect(() => {
    if (!districts.length) return;
    districts.forEach((d) => {
      api()
        .get(`/api/v1/admin/districts/${d.id}/stats`)
        .then((res) => setStats((prev) => ({ ...prev, [d.id]: res.data })))
        .catch(() => {});
    });
  }, [districts, api]);

  function openCreate() {
    setFormMode("create");
    setFormId(null);
    setForm({
      name: "", admin_email: "", timezone: "America/New_York",
      is_licensed: false, license_tier: "trial", license_expires_at: "",
      notes: "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(d) {
    setFormMode("edit");
    setFormId(d.id);
    setForm({
      name:       d.name || "",
      admin_email: d.admin_email || "",
      timezone:   d.timezone || "America/New_York",
      is_licensed: !!d.is_licensed,
      license_tier: d.license_tier || "trial",
      license_expires_at: d.license_expires_at ? d.license_expires_at.substring(0, 10) : "",
      notes:      d.notes || "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setFormError("District name is required"); return; }
    setSaving(true);
    setFormError(null);
    const payload = {
      name: form.name.trim(),
      admin_email: form.admin_email.trim(),
      timezone: form.timezone,
      is_licensed: form.is_licensed,
      license_tier: form.is_licensed ? form.license_tier : null,
      license_expires_at: form.is_licensed && form.license_expires_at ? form.license_expires_at : null,
      notes: form.notes.trim(),
    };
    const req = formMode === "create"
      ? api().post("/api/v1/admin/districts", payload)
      : api().patch(`/api/v1/admin/districts/${formId}`, payload);
    req
      .then(() => { fetchDistricts(); setFormOpen(false); })
      .catch((err) => setFormError(err.response?.data?.detail || "Failed to save"))
      .finally(() => setSaving(false));
  }

  function handleToggleStatus(d) {
    const newStatus = d.status === "active" ? "suspended" : "active";
    setToggling(d.id);
    api()
      .patch(`/api/v1/admin/districts/${d.id}`, { status: newStatus })
      .then(() => setDistricts((prev) => prev.map((x) => x.id === d.id ? { ...x, status: newStatus } : x)))
      .catch((err) => setError(err.response?.data?.detail || "Failed to update status"))
      .finally(() => setToggling(null));
  }

  function handleToggleLicense(d) {
    setToggling(d.id);
    api()
      .patch(`/api/v1/admin/districts/${d.id}`, { is_licensed: !d.is_licensed })
      .then(() => setDistricts((prev) => prev.map((x) => x.id === d.id ? { ...x, is_licensed: !d.is_licensed } : x)))
      .catch((err) => setError(err.response?.data?.detail || "Failed to update license"))
      .finally(() => setToggling(null));
  }

  function handleManage(d) {
    setActiveDistrict({ id: d.id, name: d.name });
    setView("platformAdmin");
  }

  if (loading) {
    return (
      <div className="pa-loading">
        <FaSpinner className="pa-spinner" />
        <span>Loading districts…</span>
      </div>
    );
  }

  return (
    <div className="pa-container">
      <div className="pa-header">
        <div className="pa-header-left">
          <h1 className="pa-title">Districts</h1>
          <p className="pa-subtitle">
            {districts.length} district{districts.length !== 1 ? "s" : ""} on platform · manage licensing here, drill in to build out locations
          </p>
        </div>
        <button className="pa-btn-primary" onClick={openCreate}>
          <FaPlus /> New District
        </button>
      </div>

      {error && <div className="pa-alert">{error}</div>}

      {districts.length === 0 ? (
        <div className="pa-empty">
          <FaBuilding className="pa-empty-icon" />
          <p>No districts yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <thead>
              <tr>
                <th>District</th>
                <th>Status</th>
                <th>License</th>
                <th>Locations</th>
                <th>Users</th>
                <th>Scans</th>
                <th>Timezone</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {districts.map((d) => {
                const s = stats[d.id];
                return (
                  <tr key={d.id} className="pa-row">
                    <td data-label="District">
                      <div className="pa-school-name">{d.name}</div>
                      {d.admin_email && <div className="pa-school-email">{d.admin_email}</div>}
                    </td>
                    <td data-label="Status"><StatusBadge status={d.status} /></td>
                    <td data-label="License"><LicenseChip licensed={d.is_licensed} /></td>
                    <td data-label="Locations" className="pa-stat">{s ? s.locations : "—"}</td>
                    <td data-label="Users" className="pa-stat">{s ? s.users : "—"}</td>
                    <td data-label="Scans" className="pa-stat">{s ? s.scans : "—"}</td>
                    <td data-label="Timezone" className="pa-tz">{d.timezone || "—"}</td>
                    <td data-label="Actions">
                      <div className="pa-actions">
                        <button className="pa-btn-action" onClick={() => handleManage(d)} title="Manage district locations">
                          <FaCog /> Manage
                        </button>
                        <button className="pa-btn-action pa-btn-edit" onClick={() => openEdit(d)} title="Edit district settings">
                          <FaPencilAlt /> Edit
                        </button>
                        <button
                          className="pa-btn-action"
                          onClick={() => handleToggleLicense(d)}
                          disabled={toggling === d.id}
                          title={d.is_licensed ? "Revoke license" : "License this district"}
                        >
                          <FaCertificate />
                          {d.is_licensed ? "Unlicense" : "License"}
                        </button>
                        <button
                          className={`pa-btn-action pa-btn-toggle ${d.status !== "active" ? "pa-btn-restore" : ""}`}
                          onClick={() => handleToggleStatus(d)}
                          disabled={toggling === d.id}
                          title={d.status === "active" ? "Suspend district" : "Reactivate district"}
                        >
                          {toggling === d.id ? <FaSpinner className="pa-spinner-sm" /> : d.status === "active" ? <FaBan /> : <FaCheckCircle />}
                          {d.status === "active" ? "Suspend" : "Restore"}
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

      {formOpen && (
        <div className="pa-modal-overlay" onClick={(e) => e.target === e.currentTarget && setFormOpen(false)}>
          <div className="pa-modal">
            <div className="pa-modal-header">
              <h2 className="pa-modal-title">{formMode === "create" ? "Create District" : "Edit District"}</h2>
              <button className="pa-modal-close" onClick={() => setFormOpen(false)}>×</button>
            </div>
            <form className="pa-form" onSubmit={handleSubmit}>
              <div className="pa-field">
                <label className="pa-label">District Name *</label>
                <input className="pa-input" name="name" value={form.name} onChange={handleChange} required placeholder="e.g. Fairview School District" />
              </div>
              <div className="pa-field">
                <label className="pa-label">Primary Admin Email (optional)</label>
                <input className="pa-input" name="admin_email" type="email" value={form.admin_email} onChange={handleChange} placeholder="superintendent@district.edu" />
              </div>
              <div className="pa-field">
                <label className="pa-label">Default Timezone</label>
                <select className="pa-select" name="timezone" value={form.timezone} onChange={handleChange}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>

              <div className="pa-field">
                <label className="pa-label">
                  <input type="checkbox" name="is_licensed" checked={form.is_licensed} onChange={handleChange} />
                  &nbsp;Licensed
                </label>
              </div>
              {form.is_licensed && (
                <>
                  <div className="pa-field">
                    <label className="pa-label">License Tier</label>
                    <select className="pa-select" name="license_tier" value={form.license_tier} onChange={handleChange}>
                      {LICENSE_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                  <div className="pa-field">
                    <label className="pa-label">License Expires</label>
                    <input className="pa-input" type="date" name="license_expires_at" value={form.license_expires_at} onChange={handleChange} />
                  </div>
                </>
              )}

              <div className="pa-field">
                <label className="pa-label">Admin Notes</label>
                <textarea className="pa-input" name="notes" rows={3} value={form.notes} onChange={handleChange} />
              </div>

              {formError && <p className="pa-error">{formError}</p>}

              <div className="pa-form-actions">
                <button type="button" className="pa-btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button>
                <button type="submit" className="pa-btn-primary" disabled={saving}>
                  {saving ? <FaSpinner className="pa-spinner-sm" /> : null}
                  {saving ? "Saving…" : formMode === "create" ? "Create District" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
