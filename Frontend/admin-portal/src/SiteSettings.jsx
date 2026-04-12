import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  FaSchool, FaPlus, FaSpinner, FaSearch, FaPencilAlt, FaBan,
  FaCheckCircle, FaCertificate, FaExclamationTriangle, FaMapMarkerAlt,
  FaPhone, FaGlobe, FaTimes, FaTrashAlt,
} from "react-icons/fa";
import { createApiClient } from "./api";
import SchoolFormModal from "./SchoolFormModal";
import "./SiteSettings.css";

const BLANK_FORM = { name: "", admin_email: "", timezone: "America/New_York", is_licensed: false, license_tier: "trial", license_expires_at: "", address: "", phone: "", website: "", notes: "" };

const LICENSE_TIER_LABELS = { trial: "Trial", basic: "Basic", standard: "Standard", premium: "Premium", enterprise: "Enterprise" };

function LicenseBadge({ licensed, expiresAt }) {
  if (!licensed) return <span className="ss-badge ss-badge--unlicensed">Unlicensed</span>;
  const expired = expiresAt && new Date(expiresAt) < new Date();
  return <span className={`ss-badge ss-badge--${expired ? "expired" : "licensed"}`}>{expired ? "Expired" : "Licensed"}</span>;
}

export default function SiteSettings({ token, schoolId = null, currentUser = null }) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [schools, setSchools]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [search, setSearch]     = useState("");
  const [toggling, setToggling] = useState(null);

  const [formOpen, setFormOpen]       = useState(false);
  const [formMode, setFormMode]       = useState("create");
  const [formSchoolId, setFormSchoolId] = useState(null);
  const [form, setForm]               = useState(BLANK_FORM);
  const [formError, setFormError]     = useState(null);
  const [saving, setSaving]           = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState(null);

  const baseUrl = isSuperAdmin ? "/api/v1/admin/schools" : "/api/v1/site-settings/schools";

  const fetchSchools = useCallback(() => {
    setLoading(true); setError(null);
    api.get(baseUrl)
      .then((res) => setSchools(res.data.schools || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load schools"))
      .finally(() => setLoading(false));
  }, [api, baseUrl]);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);

  const filtered = useMemo(() => {
    if (!search.trim()) return schools;
    const q = search.toLowerCase();
    return schools.filter((s) => (s.name || "").toLowerCase().includes(q) || (s.admin_email || "").toLowerCase().includes(q) || (s.address || "").toLowerCase().includes(q));
  }, [schools, search]);

  const stats = useMemo(() => ({ total: schools.length, licensed: schools.filter((s) => s.is_licensed).length, suspended: schools.filter((s) => s.status === "suspended").length }), [schools]);

  function openCreate() { setFormMode("create"); setFormSchoolId(null); setForm(BLANK_FORM); setFormError(null); setFormOpen(true); }

  function openEdit(school) {
    setFormMode("edit"); setFormSchoolId(school.id);
    setForm({ name: school.name || "", admin_email: school.admin_email || "", timezone: school.timezone || "America/New_York", is_licensed: !!school.is_licensed, license_tier: school.license_tier || "trial", license_expires_at: school.license_expires_at ? school.license_expires_at.substring(0, 10) : "", address: school.address || "", phone: school.phone || "", website: school.website || "", notes: school.notes || "" });
    setFormError(null); setFormOpen(true);
  }

  function handleFormChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setFormError("School name is required"); return; }
    setSaving(true); setFormError(null);
    const payload = { name: form.name.trim(), admin_email: form.admin_email.trim(), timezone: form.timezone, is_licensed: form.is_licensed, license_tier: form.is_licensed ? form.license_tier : null, license_expires_at: form.is_licensed && form.license_expires_at ? form.license_expires_at : null, address: form.address.trim(), phone: form.phone.trim(), website: form.website.trim(), notes: form.notes.trim() };
    const req = formMode === "create" ? api.post(baseUrl, payload) : api.patch(`${baseUrl}/${formSchoolId}`, payload);
    req.then(() => { fetchSchools(); setFormOpen(false); })
      .catch((err) => setFormError(err.response?.data?.detail || "Failed to save"))
      .finally(() => setSaving(false));
  }

  function handleToggleLicense(school) {
    setToggling(school.id);
    api.patch(`${baseUrl}/${school.id}`, { is_licensed: !school.is_licensed })
      .then(() => setSchools((prev) => prev.map((s) => s.id === school.id ? { ...s, is_licensed: !school.is_licensed } : s)))
      .catch((err) => setError(err.response?.data?.detail || "Failed to update license"))
      .finally(() => setToggling(null));
  }

  function handleToggleStatus(school) {
    const newStatus = school.status === "active" ? "suspended" : "active";
    setToggling(school.id);
    api.patch(`${baseUrl}/${school.id}`, { status: newStatus })
      .then(() => setSchools((prev) => prev.map((s) => s.id === school.id ? { ...s, status: newStatus } : s)))
      .catch((err) => setError(err.response?.data?.detail || "Failed to update status"))
      .finally(() => setToggling(null));
  }

  function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError(null);
    api.delete(`${baseUrl}/${deleteTarget.id}`)
      .then(() => { setSchools((prev) => prev.filter((s) => s.id !== deleteTarget.id)); setDeleteTarget(null); })
      .catch((err) => setDeleteError(err.response?.data?.detail || "Failed to delete site"))
      .finally(() => setDeleting(false));
  }

  if (loading) return (<div className="ss-loading"><FaSpinner className="ss-spinner" /><span>Loading site settings&hellip;</span></div>);

  return (
    <div className="ss-container">
      <div className="ss-header">
        <div><h1 className="ss-title">Site Settings</h1><p className="ss-subtitle">Add, configure, and license schools so they can be referenced throughout the platform.</p></div>
        <button className="ss-btn-primary" onClick={openCreate}><FaPlus /> Add School</button>
      </div>

      <div className="ss-summary">
        <div className="ss-stat-card"><span className="ss-stat-label">Total Sites</span><span className="ss-stat-value">{stats.total}</span></div>
        <div className="ss-stat-card"><span className="ss-stat-label">Licensed</span><span className="ss-stat-value ss-stat-licensed">{stats.licensed}</span></div>
        <div className="ss-stat-card"><span className="ss-stat-label">Suspended</span><span className="ss-stat-value ss-stat-suspended">{stats.suspended}</span></div>
      </div>

      {error && (<div className="ss-alert"><FaExclamationTriangle /> {error}<button className="ss-alert-close" onClick={() => setError(null)}><FaTimes /></button></div>)}

      <div className="ss-toolbar">
        <div className="ss-search-wrap">
          <FaSearch className="ss-search-icon" />
          <input className="ss-search" type="text" placeholder="Search schools by name, email, or address..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="ss-empty"><FaSchool className="ss-empty-icon" /><p>{schools.length === 0 ? "No schools yet. Add your first school to start licensing." : "No schools match your search."}</p></div>
      ) : (
        <div className="ss-card">
          <table className="ss-table">
            <thead><tr><th>Site</th><th>License</th><th>Status</th><th>Contact</th><th>Timezone</th><th className="ss-th-actions">Actions</th></tr></thead>
            <tbody>
              {filtered.map((school) => (
                <tr key={school.id}>
                  <td>
                    <div className="ss-school-name">{school.name}</div>
                    <div className="ss-school-meta">
                      {school.address && <span className="ss-school-meta-item"><FaMapMarkerAlt /> {school.address}</span>}
                      {school.website && <span className="ss-school-meta-item"><FaGlobe /> {school.website}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="ss-license-cell">
                      <LicenseBadge licensed={school.is_licensed} expiresAt={school.license_expires_at} />
                      {school.is_licensed && school.license_tier && <span className="ss-tier">{LICENSE_TIER_LABELS[school.license_tier] || school.license_tier}</span>}
                      {school.is_licensed && school.license_expires_at && <span className="ss-expires">Expires {new Date(school.license_expires_at).toLocaleDateString()}</span>}
                    </div>
                  </td>
                  <td><span className={`ss-badge ss-badge--${school.status === "active" ? "active" : "suspended"}`}>{school.status === "active" ? "Active" : "Suspended"}</span></td>
                  <td>
                    <div className="ss-contact-cell">
                      {school.admin_email && <span className="ss-contact-line">{school.admin_email}</span>}
                      {school.phone && <span className="ss-contact-muted"><FaPhone /> {school.phone}</span>}
                      {!school.admin_email && !school.phone && <span className="ss-contact-muted">—</span>}
                    </div>
                  </td>
                  <td className="ss-tz">{school.timezone || "—"}</td>
                  <td>
                    <div className="ss-actions">
                      <button className="ss-btn-action ss-btn-edit" onClick={() => openEdit(school)} title="Edit site settings"><FaPencilAlt /> Edit</button>
                      <button className={`ss-btn-action ${school.is_licensed ? "ss-btn-unlicense" : "ss-btn-license"}`} onClick={() => handleToggleLicense(school)} disabled={toggling === school.id} title={school.is_licensed ? "Revoke license" : "License this school"}>
                        {toggling === school.id ? <FaSpinner className="ss-spinner-sm" /> : <FaCertificate />}
                        {school.is_licensed ? "Unlicense" : "License"}
                      </button>
                      <button className={`ss-btn-action ${school.status === "active" ? "ss-btn-suspend" : "ss-btn-restore"}`} onClick={() => handleToggleStatus(school)} disabled={toggling === school.id}>
                        {school.status === "active" ? <FaBan /> : <FaCheckCircle />}{school.status === "active" ? "Suspend" : "Restore"}
                      </button>
                      <button className="ss-btn-action ss-btn-delete" onClick={() => { setDeleteTarget(school); setDeleteError(null); }} title="Delete site"><FaTrashAlt /> Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <div className="ss-modal-overlay" onClick={(e) => e.target === e.currentTarget && !deleting && setDeleteTarget(null)}>
          <div className="ss-modal ss-modal-sm">
            <div className="ss-modal-header"><h2 className="ss-modal-title">Delete Site</h2><button className="ss-modal-close" onClick={() => !deleting && setDeleteTarget(null)} aria-label="Close">&times;</button></div>
            <p style={{ margin: "0 0 8px", lineHeight: 1.5 }}>Are you sure you want to delete <strong>{deleteTarget.name}</strong>?</p>
            <p style={{ margin: "0 0 16px", lineHeight: 1.5, color: "#6b7280", fontSize: "0.9rem" }}>This action is permanent and cannot be undone. The site can only be deleted if it has no students, guardians, admin users, plates, or scan records associated with it.</p>
            {deleteError && <p className="ss-error">{deleteError}</p>}
            <div className="ss-form-actions">
              <button type="button" className="ss-btn-ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button type="button" className="ss-btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? (<><FaSpinner className="ss-spinner-sm" /> Deleting&hellip;</>) : (<><FaTrashAlt /> Delete Site</>)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Form Modal */}
      {formOpen && (
        <SchoolFormModal mode={formMode} form={form} onChange={handleFormChange} onSubmit={handleSubmit} onClose={() => { setFormOpen(false); setFormError(null); }} saving={saving} formError={formError} />
      )}
    </div>
  );
}
