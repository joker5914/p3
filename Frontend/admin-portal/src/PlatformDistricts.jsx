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
import { formatApiError } from "./utils";
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
      .catch((err) => { setError(formatApiError(err, "Failed to load districts")); setLoading(false); });
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
      .catch((err) => setFormError(formatApiError(err, "Failed to save")))
      .finally(() => setSaving(false));
  }

  function handleToggleStatus(d) {
    const newStatus = d.status === "active" ? "suspended" : "active";
    setToggling(d.id);
    api()
      .patch(`/api/v1/admin/districts/${d.id}`, { status: newStatus })
      .then(() => setDistricts((prev) => prev.map((x) => x.id === d.id ? { ...x, status: newStatus } : x)))
      .catch((err) => setError(formatApiError(err, "Failed to update status")))
      .finally(() => setToggling(null));
  }

  function handleToggleLicense(d) {
    setToggling(d.id);
    api()
      .patch(`/api/v1/admin/districts/${d.id}`, { is_licensed: !d.is_licensed })
      .then(() => setDistricts((prev) => prev.map((x) => x.id === d.id ? { ...x, is_licensed: !d.is_licensed } : x)))
      .catch((err) => setError(formatApiError(err, "Failed to update license")))
      .finally(() => setToggling(null));
  }

  function handleManage(d) {
    setActiveDistrict({ id: d.id, name: d.name });
    setView("platformAdmin");
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><FaSpinner className="pa-spinner" aria-hidden="true" style={{ fontSize: 20 }} /></span>
          <p className="page-empty-title">Loading districts…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Platform · districts</span>
          <h1 className="page-title">Districts</h1>
          <p className="page-sub">
            Manage licensing here, drill in to build out locations.
          </p>
        </div>
        <div className="page-actions">
          <span
            className="page-chip"
            aria-label={`${districts.length} district${districts.length === 1 ? "" : "s"}`}
          >
            <FaBuilding aria-hidden="true" />
            {districts.length.toLocaleString()} {districts.length === 1 ? "district" : "districts"}
          </span>
          <button className="pa-btn-primary" onClick={openCreate}>
            <FaPlus aria-hidden="true" /> New District
          </button>
        </div>
      </div>

      {error && (
        <div className="um-error" role="alert">
          <span>{error}</span>
          <button
            className="um-error-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      {districts.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><FaBuilding aria-hidden="true" style={{ fontSize: 22 }} /></span>
          <p className="page-empty-title">No districts yet</p>
          <p className="page-empty-sub">
            Create one to get started — you can add locations and users after the district is live.
          </p>
        </div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <thead>
              <tr>
                <th scope="col">District</th>
                <th scope="col">Status</th>
                <th scope="col">License</th>
                <th scope="col">Locations</th>
                <th scope="col">Users</th>
                <th scope="col">Scans</th>
                <th scope="col">Timezone</th>
                <th scope="col">Actions</th>
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
                        <button
                          className="pa-btn-action"
                          onClick={() => handleManage(d)}
                          title="Manage district locations"
                          aria-label="Manage district locations"
                        >
                          <FaCog /> <span className="btn-text">Manage</span>
                        </button>
                        <button
                          className="pa-btn-action pa-btn-edit"
                          onClick={() => openEdit(d)}
                          title="Edit district settings"
                          aria-label="Edit district settings"
                        >
                          <FaPencilAlt /> <span className="btn-text">Edit</span>
                        </button>
                        <button
                          className="pa-btn-action"
                          onClick={() => handleToggleLicense(d)}
                          disabled={toggling === d.id}
                          title={d.is_licensed ? "Revoke license" : "License this district"}
                          aria-label={d.is_licensed ? "Revoke license" : "License this district"}
                        >
                          <FaCertificate />
                          <span className="btn-text">{d.is_licensed ? "Unlicense" : "License"}</span>
                        </button>
                        <button
                          className={`pa-btn-action pa-btn-toggle ${d.status !== "active" ? "pa-btn-restore" : ""}`}
                          onClick={() => handleToggleStatus(d)}
                          disabled={toggling === d.id}
                          title={d.status === "active" ? "Suspend district" : "Reactivate district"}
                          aria-label={d.status === "active" ? "Suspend district" : "Reactivate district"}
                        >
                          {toggling === d.id ? <FaSpinner className="pa-spinner-sm" /> : d.status === "active" ? <FaBan /> : <FaCheckCircle />}
                          <span className="btn-text">{d.status === "active" ? "Suspend" : "Restore"}</span>
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
          <div
            className="pa-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pd-form-title"
          >
            <div className="pa-modal-header">
              <h2 id="pd-form-title" className="pa-modal-title">{formMode === "create" ? "Create District" : "Edit District"}</h2>
              <button
                className="pa-modal-close"
                onClick={() => setFormOpen(false)}
                aria-label="Close dialog"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <form className="pa-form" onSubmit={handleSubmit}>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pd-form-name">
                  District Name <span aria-label="required">*</span>
                </label>
                <input id="pd-form-name" className="pa-input" name="name" value={form.name} onChange={handleChange} required placeholder="e.g. Fairview School District" />
              </div>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pd-form-email">Primary Admin Email (optional)</label>
                <input id="pd-form-email" className="pa-input" name="admin_email" type="email" value={form.admin_email} onChange={handleChange} placeholder="superintendent@district.edu" />
              </div>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pd-form-tz">Default Timezone</label>
                <select id="pd-form-tz" className="pa-select" name="timezone" value={form.timezone} onChange={handleChange}>
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
                    <label className="pa-label" htmlFor="pd-form-tier">License Tier</label>
                    <select id="pd-form-tier" className="pa-select" name="license_tier" value={form.license_tier} onChange={handleChange}>
                      {LICENSE_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                  <div className="pa-field">
                    <label className="pa-label" htmlFor="pd-form-expires">License Expires</label>
                    <input id="pd-form-expires" className="pa-input" type="date" name="license_expires_at" value={form.license_expires_at} onChange={handleChange} />
                  </div>
                </>
              )}

              <div className="pa-field">
                <label className="pa-label" htmlFor="pd-form-notes">Admin Notes</label>
                <textarea id="pd-form-notes" className="pa-input" name="notes" rows={3} value={form.notes} onChange={handleChange} />
              </div>

              {formError && <p className="pa-error" role="alert">{formError}</p>}

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
