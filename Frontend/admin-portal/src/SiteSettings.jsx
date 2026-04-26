import React, { useState, useEffect, useCallback, useMemo } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./SiteSettings.css";

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

const STATUS_FILTERS = [
  { key: "all",        label: "All"        },
  { key: "licensed",   label: "Licensed"   },
  { key: "unlicensed", label: "Unlicensed" },
  { key: "suspended",  label: "Suspended"  },
];

const BLANK_FORM = {
  name: "",
  admin_email: "",
  timezone: "America/New_York",
  is_licensed: false,
  license_tier: "trial",
  license_expires_at: "",
  address: "",
  phone: "",
  website: "",
  notes: "",
};

function LicenseBadge({ licensed, expiresAt }) {
  if (!licensed) return <span className="ss-chip ss-chip-unlicensed">Unlicensed</span>;
  const expired = expiresAt && new Date(expiresAt) < new Date();
  if (expired) return <span className="ss-chip ss-chip-expired">Expired</span>;
  return <span className="ss-chip ss-chip-licensed">Licensed</span>;
}

function StatusChip({ status }) {
  const active = status === "active";
  return (
    <span className={`ss-chip ss-chip-${active ? "active" : "suspended"}`}>
      {active ? "Active" : "Suspended"}
    </span>
  );
}

export default function SiteSettings({ token, schoolId = null, currentUser = null }) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [schools, setSchools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [toggling, setToggling] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState("create");
  const [formSchoolId, setFormSchoolId] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Escape key closes either modal — matches dialog conventions expected by
  // keyboard and screen-reader users.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "Escape") return;
      if (formOpen && !saving) setFormOpen(false);
      else if (deleteTarget && !deleting) setDeleteTarget(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [formOpen, saving, deleteTarget, deleting]);

  const fetchSchools = useCallback(() => {
    setLoading(true);
    setError(null);
    const endpoint = isSuperAdmin
      ? "/api/v1/admin/schools"
      : "/api/v1/site-settings/schools";
    api
      .get(endpoint)
      .then((res) => setSchools(res.data.schools || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load schools"))
      .finally(() => setLoading(false));
  }, [api, isSuperAdmin]);

  useEffect(() => {
    fetchSchools();
  }, [fetchSchools]);

  const statusCounts = useMemo(() => ({
    all:        schools.length,
    licensed:   schools.filter((s) => s.is_licensed).length,
    unlicensed: schools.filter((s) => !s.is_licensed).length,
    suspended:  schools.filter((s) => s.status === "suspended").length,
  }), [schools]);

  const filtered = useMemo(() => {
    let list = schools;
    if (statusFilter === "licensed")   list = list.filter((s) => s.is_licensed);
    if (statusFilter === "unlicensed") list = list.filter((s) => !s.is_licensed);
    if (statusFilter === "suspended")  list = list.filter((s) => s.status === "suspended");

    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        (s.name || "").toLowerCase().includes(q) ||
        (s.admin_email || "").toLowerCase().includes(q) ||
        (s.address || "").toLowerCase().includes(q)
    );
  }, [schools, search, statusFilter]);

  function openCreate() {
    setFormMode("create");
    setFormSchoolId(null);
    setForm(BLANK_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(school) {
    setFormMode("edit");
    setFormSchoolId(school.id);
    setForm({
      name: school.name || "",
      admin_email: school.admin_email || "",
      timezone: school.timezone || "America/New_York",
      is_licensed: !!school.is_licensed,
      license_tier: school.license_tier || "trial",
      license_expires_at: school.license_expires_at
        ? school.license_expires_at.substring(0, 10)
        : "",
      address: school.address || "",
      phone: school.phone || "",
      website: school.website || "",
      notes: school.notes || "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setFormError(null);
  }

  function handleFormChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError("School name is required");
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      name: form.name.trim(),
      admin_email: form.admin_email.trim(),
      timezone: form.timezone,
      is_licensed: form.is_licensed,
      license_tier: form.is_licensed ? form.license_tier : null,
      license_expires_at: form.is_licensed && form.license_expires_at ? form.license_expires_at : null,
      address: form.address.trim(),
      phone: form.phone.trim(),
      website: form.website.trim(),
      notes: form.notes.trim(),
    };
    const base = isSuperAdmin ? "/api/v1/admin/schools" : "/api/v1/site-settings/schools";
    const request =
      formMode === "create"
        ? api.post(base, payload)
        : api.patch(`${base}/${formSchoolId}`, payload);

    request
      .then(() => {
        fetchSchools();
        setFormOpen(false);
      })
      .catch((err) => setFormError(err.response?.data?.detail || "Failed to save"))
      .finally(() => setSaving(false));
  }

  function patchUrl(schoolDocId) {
    const base = isSuperAdmin ? "/api/v1/admin/schools" : "/api/v1/site-settings/schools";
    return `${base}/${schoolDocId}`;
  }

  function handleToggleLicense(school) {
    setToggling(school.id);
    api
      .patch(patchUrl(school.id), { is_licensed: !school.is_licensed })
      .then(() => {
        setSchools((prev) =>
          prev.map((s) =>
            s.id === school.id ? { ...s, is_licensed: !school.is_licensed } : s
          )
        );
      })
      .catch((err) => setError(err.response?.data?.detail || "Failed to update license"))
      .finally(() => setToggling(null));
  }

  function handleToggleStatus(school) {
    const newStatus = school.status === "active" ? "suspended" : "active";
    setToggling(school.id);
    api
      .patch(patchUrl(school.id), { status: newStatus })
      .then(() => {
        setSchools((prev) =>
          prev.map((s) => (s.id === school.id ? { ...s, status: newStatus } : s))
        );
      })
      .catch((err) => setError(err.response?.data?.detail || "Failed to update status"))
      .finally(() => setToggling(null));
  }

  function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    const base = isSuperAdmin ? "/api/v1/admin/schools" : "/api/v1/site-settings/schools";
    api
      .delete(`${base}/${deleteTarget.id}`)
      .then(() => {
        setSchools((prev) => prev.filter((s) => s.id !== deleteTarget.id));
        setDeleteTarget(null);
      })
      .catch((err) => setDeleteError(err.response?.data?.detail || "Failed to delete location"))
      .finally(() => setDeleting(false));
  }

  const emptyMessage = search
    ? "No schools match your search."
    : statusFilter === "licensed"   ? "No licensed schools yet."
    : statusFilter === "unlicensed" ? "No unlicensed schools."
    : statusFilter === "suspended"  ? "No suspended schools."
    : "No schools yet. Add your first school to start licensing.";

  return (
    <div className="ss-container page-shell">

      {/* Header — eyebrow + display headline + count chip + Add CTA */}
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">District · locations</span>
          <h1 className="page-title">Locations</h1>
          <p className="page-sub">
            Add, configure, and license schools so they can be referenced throughout the platform.
          </p>
        </div>
        <div className="page-actions">
          {!loading && (
            <span className="page-chip" aria-label={`${schools.length} locations`}>
              <I.building size={12} aria-hidden="true" />
              {schools.length.toLocaleString()} {schools.length === 1 ? "location" : "locations"}
            </span>
          )}
          <button className="ss-btn-primary" onClick={openCreate}>
            <I.plus size={13} aria-hidden="true" /> Add School
          </button>
        </div>
      </div>

      {/* Global error */}
      {error && (
        <div className="ss-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="ss-error-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Controls: filter bar + search */}
      <div className="ss-controls">
        <div
          className="ss-filter-bar"
          role="tablist"
          aria-label="Filter locations by status"
        >
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              className={`ss-filter-tab${statusFilter === key ? " active" : ""}`}
              onClick={() => setStatusFilter(key)}
              role="tab"
              aria-selected={statusFilter === key}
              aria-label={`${label}: ${statusCounts[key] || 0} locations`}
            >
              {label}
              {!loading && (
                <span className="ss-filter-badge" aria-hidden="true">{statusCounts[key]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="ss-search-wrap" role="search">
          <I.search size={14} className="ss-search-icon" aria-hidden="true" />
          <label htmlFor="ss-search" className="sr-only">Search locations</label>
          <input
            id="ss-search"
            className="ss-search-input"
            type="search"
            placeholder="Search by name, email, or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading locations…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.building size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">{emptyMessage}</p>
        </div>
      ) : (
        <div className="ss-table-wrap">
          <table className="ss-table">
            <caption className="sr-only">Licensed and unlicensed locations</caption>
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">License</th>
                <th scope="col">Status</th>
                <th scope="col">Contact</th>
                <th scope="col">Timezone</th>
                <th scope="col" className="ss-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((school) => (
                <tr key={school.id} className="ss-row">
                  <td data-label="Location">
                    <div className="ss-school-cell">
                      <span className="ss-school-name">{school.name}</span>
                      {school.address && (
                        <span className="ss-school-meta">
                          <I.pin size={11} aria-hidden="true" /> {school.address}
                        </span>
                      )}
                      {school.website && (
                        <span className="ss-school-meta">
                          <I.globe size={11} aria-hidden="true" /> {school.website}
                        </span>
                      )}
                    </div>
                  </td>
                  <td data-label="License">
                    <div className="ss-license-cell">
                      <LicenseBadge
                        licensed={school.is_licensed}
                        expiresAt={school.license_expires_at}
                      />
                      {school.is_licensed && school.license_tier && (
                        <span className="ss-tier">
                          {LICENSE_TIERS.find((t) => t.value === school.license_tier)?.label ||
                            school.license_tier}
                        </span>
                      )}
                      {school.is_licensed && school.license_expires_at && (
                        <span className="ss-expires">
                          Expires {new Date(school.license_expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </td>
                  <td data-label="Status">
                    <StatusChip status={school.status} />
                  </td>
                  <td data-label="Contact">
                    <div className="ss-contact-cell">
                      {school.admin_email && (
                        <span className="ss-contact-line">{school.admin_email}</span>
                      )}
                      {school.phone && (
                        <span className="ss-contact-muted">
                          <I.phone size={11} aria-hidden="true" /> {school.phone}
                        </span>
                      )}
                      {!school.admin_email && !school.phone && (
                        <span className="ss-contact-muted">—</span>
                      )}
                    </div>
                  </td>
                  <td data-label="Timezone" className="ss-tz">
                    {school.timezone || "—"}
                  </td>
                  <td data-label="Actions">
                    <div className="ss-actions">
                      <button
                        className="ss-btn-action ss-btn-edit"
                        onClick={() => openEdit(school)}
                        title="Edit location"
                      >
                        <I.edit size={12} aria-hidden="true" /> Edit
                      </button>
                      <button
                        className={`ss-btn-action ${
                          school.is_licensed ? "ss-btn-unlicense" : "ss-btn-license"
                        }`}
                        onClick={() => handleToggleLicense(school)}
                        disabled={toggling === school.id}
                        title={school.is_licensed ? "Revoke license" : "License this school"}
                      >
                        {toggling === school.id ? (
                          <I.spinner size={12} aria-hidden="true" />
                        ) : (
                          <I.certificate size={12} aria-hidden="true" />
                        )}
                        {school.is_licensed ? "Unlicense" : "License"}
                      </button>
                      <button
                        className={`ss-btn-action ${
                          school.status === "active" ? "ss-btn-suspend" : "ss-btn-restore"
                        }`}
                        onClick={() => handleToggleStatus(school)}
                        disabled={toggling === school.id}
                        title={school.status === "active" ? "Suspend school" : "Restore school"}
                      >
                        {school.status === "active"
                          ? <I.ban         size={12} aria-hidden="true" />
                          : <I.checkCircle size={12} aria-hidden="true" />}
                        {school.status === "active" ? "Suspend" : "Restore"}
                      </button>
                      <button
                        className="ss-btn-action ss-btn-delete"
                        onClick={() => {
                          setDeleteTarget(school);
                          setDeleteError(null);
                        }}
                        title="Delete location"
                      >
                        <I.trash size={12} aria-hidden="true" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="ss-modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !deleting && setDeleteTarget(null)}
        >
          <div
            className="ss-modal ss-modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ss-delete-title"
          >
            <div className="ss-modal-header">
              <h2 id="ss-delete-title" className="ss-modal-title">Delete Location</h2>
              <button
                className="ss-modal-close"
                onClick={() => !deleting && setDeleteTarget(null)}
                aria-label="Close dialog"
              >
                <I.x size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="ss-modal-body">
              <p className="ss-delete-prompt">
                Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
              </p>
              <p className="ss-delete-warning">
                This action is permanent and cannot be undone. The location can only be deleted if it has no students, guardians, admin users, plates, or scan records associated with it.
              </p>
              {deleteError && <p className="ss-field-error">{deleteError}</p>}
            </div>
            <div className="ss-form-actions">
              <button
                type="button"
                className="ss-btn-secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ss-btn-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <>
                    <I.spinner size={12} aria-hidden="true" /> Deleting…
                  </>
                ) : (
                  <>
                    <I.trash size={12} aria-hidden="true" /> Delete Location
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {formOpen && (
        <div
          className="ss-modal-overlay"
          onClick={(e) => e.target === e.currentTarget && closeForm()}
        >
          <div
            className="ss-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ss-form-title"
          >
            <div className="ss-modal-header">
              <h2 id="ss-form-title" className="ss-modal-title">
                {formMode === "create" ? "Add School" : "Edit Location"}
              </h2>
              <button
                className="ss-modal-close"
                onClick={closeForm}
                aria-label="Close dialog"
              >
                <I.x size={16} aria-hidden="true" />
              </button>
            </div>
            <form className="ss-form" onSubmit={handleSubmit}>
              <div className="ss-form-section">
                <h3 className="ss-section-title">School Info</h3>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ss-form-name">
                    School Name <span className="ss-required" aria-label="required">*</span>
                  </label>
                  <input
                    id="ss-form-name"
                    className="ss-input"
                    name="name"
                    value={form.name}
                    onChange={handleFormChange}
                    placeholder="e.g. Riverside Elementary"
                    required
                  />
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ss-form-admin-email">Primary Admin Email</label>
                  <input
                    id="ss-form-admin-email"
                    className="ss-input"
                    name="admin_email"
                    type="email"
                    value={form.admin_email}
                    onChange={handleFormChange}
                    placeholder="principal@school.edu"
                  />
                </div>
                <div className="ss-form-row">
                  <div className="ss-field">
                    <label className="ss-label" htmlFor="ss-form-phone">Phone</label>
                    <input
                      id="ss-form-phone"
                      className="ss-input"
                      name="phone"
                      value={form.phone}
                      onChange={handleFormChange}
                      placeholder="(555) 123-4567"
                    />
                  </div>
                  <div className="ss-field">
                    <label className="ss-label" htmlFor="ss-form-website">Website</label>
                    <input
                      id="ss-form-website"
                      className="ss-input"
                      name="website"
                      value={form.website}
                      onChange={handleFormChange}
                      placeholder="https://school.edu"
                    />
                  </div>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ss-form-address">Address</label>
                  <input
                    id="ss-form-address"
                    className="ss-input"
                    name="address"
                    value={form.address}
                    onChange={handleFormChange}
                    placeholder="123 Main St, City, ST 12345"
                  />
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ss-form-timezone">Timezone</label>
                  <select
                    id="ss-form-timezone"
                    className="ss-select"
                    name="timezone"
                    value={form.timezone}
                    onChange={handleFormChange}
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ss-form-section">
                <h3 className="ss-section-title">License</h3>
                <label className="ss-checkbox">
                  <input
                    type="checkbox"
                    name="is_licensed"
                    checked={form.is_licensed}
                    onChange={handleFormChange}
                  />
                  <span>License this school to be used officially</span>
                </label>
                <div className="ss-form-row">
                  <div className="ss-field">
                    <label className="ss-label" htmlFor="ss-form-tier">License Tier</label>
                    <select
                      id="ss-form-tier"
                      className="ss-select"
                      name="license_tier"
                      value={form.license_tier}
                      onChange={handleFormChange}
                      disabled={!form.is_licensed}
                    >
                      {LICENSE_TIERS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ss-field">
                    <label className="ss-label" htmlFor="ss-form-expires">License Expires</label>
                    <input
                      id="ss-form-expires"
                      className="ss-input"
                      type="date"
                      name="license_expires_at"
                      value={form.license_expires_at}
                      onChange={handleFormChange}
                      disabled={!form.is_licensed}
                    />
                  </div>
                </div>
              </div>

              <div className="ss-form-section">
                <h3 className="ss-section-title">Admin Notes</h3>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="ss-form-notes">Admin Notes</label>
                  <textarea
                    id="ss-form-notes"
                    className="ss-textarea"
                    name="notes"
                    value={form.notes}
                    onChange={handleFormChange}
                    placeholder="Internal notes about this school (not visible to school staff)"
                    rows={3}
                  />
                </div>
              </div>

              {formError && <p className="ss-field-error" role="alert">{formError}</p>}

              <div className="ss-form-actions">
                <button
                  type="button"
                  className="ss-btn-secondary"
                  onClick={closeForm}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button type="submit" className="ss-btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <I.spinner size={13} aria-hidden="true" /> Saving…
                    </>
                  ) : formMode === "create" ? (
                    "Create School"
                  ) : (
                    "Save Changes"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
