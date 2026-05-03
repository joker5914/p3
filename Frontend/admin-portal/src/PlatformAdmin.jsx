import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { I } from "./components/icons";
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

function StatusBadge({ status }) {
  return (
    <span className={`pa-badge pa-badge--${status === "active" ? "active" : "suspended"}`}>
      {status === "active" ? "Active" : "Suspended"}
    </span>
  );
}

export default function PlatformAdmin({
  token,
  setActiveSchool,
  setView,
  activeDistrict = null,
  setActiveDistrict = () => {},
}) {
  const [schools, setSchools] = useState([]);
  const [stats, setStats]     = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const districtId   = activeDistrict?.id || null;
  const districtName = activeDistrict?.name || "";

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

  // District-wide device stats so we can surface "N devices in this
  // district are tagged but not yet assigned to a campus".  Only
  // meaningful when we're inside a district drilldown.
  const [districtStats, setDistrictStats] = useState(null);

  // Scope every request to the active district so the backend applies
  // district_admin filtering and the listing honours the drill-down.
  const api = useCallback(
    () => createApiClient(token, null, districtId),
    [token, districtId],
  );

  const fetchSchools = useCallback(() => {
    setLoading(true);
    setError(null);
    const url = districtId
      ? `/api/v1/admin/schools?district_id=${encodeURIComponent(districtId)}`
      : "/api/v1/admin/schools";
    api()
      .get(url)
      .then((res) => { setSchools(res.data.schools || []); setLoading(false); })
      .catch((err) => { setError(formatApiError(err, "Failed to load schools")); setLoading(false); });
  }, [api, districtId]);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);

  useEffect(() => {
    if (!districtId) { setDistrictStats(null); return; }
    const controller = new AbortController();
    api()
      .get(`/api/v1/admin/districts/${districtId}/stats`, { signal: controller.signal })
      .then((res) => setDistrictStats(res.data))
      .catch((err) => { if (!axios.isCancel(err)) setDistrictStats(null); });
    return () => controller.abort();
  }, [api, districtId, schools.length]);

  // Per-school stats: reset the map on district switch so stats from the
  // previous district can't linger, and abort in-flight requests so a late
  // response from an old district can't write into the new district's map.
  useEffect(() => { setStats({}); }, [districtId]);

  useEffect(() => {
    if (!schools.length) return;
    const controller = new AbortController();
    schools.forEach((school) => {
      api()
        .get(`/api/v1/admin/schools/${school.id}/stats`, { signal: controller.signal })
        .then((res) => setStats((prev) => ({ ...prev, [school.id]: res.data })))
        .catch(() => {});
    });
    return () => controller.abort();
  }, [schools, api]);

  // ── Create ──────────────────────────────────────────────────────────────
  function handleCreateChange(e) {
    const { name, value } = e.target;
    setCreateForm((f) => ({ ...f, [name]: value }));
  }

  function handleCreateSubmit(e) {
    e.preventDefault();
    if (!createForm.name.trim()) return;
    if (!districtId) {
      setCreateError("Pick a district from the Districts page first");
      return;
    }
    setCreating(true);
    setCreateError(null);
    api()
      .post("/api/v1/admin/schools", { ...createForm, district_id: districtId })
      .then((res) => {
        setSchools((prev) => [...prev, res.data].sort((a, b) => (a.name || "").localeCompare(b.name || "")));
        setCreateForm({ name: "", admin_email: "", timezone: "America/New_York" });
        setShowCreate(false);
        setCreating(false);
      })
      .catch((err) => { setCreateError(formatApiError(err, "Failed to create school")); setCreating(false); });
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
      .catch((err) => { setEditError(formatApiError(err, "Failed to save changes")); setSaving(false); });
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
      <div className="page-shell">
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading schools…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-head">
        <div className="page-head-left">
          {districtName && (
            <button
              className="pa-btn-ghost pa-btn-back"
              onClick={() => {
                setActiveDistrict(null);
                setView("districts");
              }}
              title="Back to Districts"
              style={{ alignSelf: "flex-start", marginBottom: 4 }}
            >
              <span aria-hidden="true" style={{ display: "inline-flex" }}>←</span> All Districts
            </button>
          )}
          <span className="t-eyebrow page-eyebrow">
            {districtName ? "District · locations" : "Platform · locations"}
          </span>
          <h1 className="page-title">
            {districtName ? `${districtName} — Locations` : "Locations"}
          </h1>
          <p className="page-sub">
            {schools.length === 0
              ? `No locations${districtName ? ` in ${districtName}` : ""} yet.`
              : `Manage campuses${districtName ? ` in ${districtName}` : ""} — drill in to set up devices and users.`}
            {districtStats?.devices_unassigned > 0 && (
              <>
                {" "}
                <button
                  className="pa-subtitle-link"
                  onClick={() => setView("devices")}
                  title="Open Devices to assign these to a school"
                >
                  {districtStats.devices_unassigned} device
                  {districtStats.devices_unassigned !== 1 ? "s" : ""} awaiting school assignment
                </button>
              </>
            )}
          </p>
        </div>
        <div className="page-actions">
          <span
            className="page-chip"
            aria-label={`${schools.length} location${schools.length === 1 ? "" : "s"}`}
          >
            <I.building size={12} aria-hidden="true" />
            {schools.length.toLocaleString()} {schools.length === 1 ? "location" : "locations"}
          </span>
          <button className="pa-btn-primary" onClick={() => setShowCreate((v) => !v)}>
            <I.plus size={13} aria-hidden="true" /> New School
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="pa-card pa-create-card">
          <h2 className="pa-card-title">Create School</h2>
          <form className="pa-form" onSubmit={handleCreateSubmit}>
            <div className="pa-field">
              <label className="pa-label" htmlFor="pa-create-name">
                School Name <span aria-label="required">*</span>
              </label>
              <input id="pa-create-name" className="pa-input" name="name" value={createForm.name} onChange={handleCreateChange} placeholder="e.g. Riverside Elementary" required />
            </div>
            <div className="pa-field">
              <label className="pa-label" htmlFor="pa-create-email">Primary Admin Email (optional)</label>
              <input id="pa-create-email" className="pa-input" name="admin_email" type="email" value={createForm.admin_email} onChange={handleCreateChange} placeholder="principal@school.edu" />
            </div>
            <div className="pa-field">
              <label className="pa-label" htmlFor="pa-create-tz">Timezone</label>
              <select id="pa-create-tz" className="pa-select" name="timezone" value={createForm.timezone} onChange={handleCreateChange}>
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
            {createError && <p className="pa-error" role="alert">{createError}</p>}
            <div className="pa-form-actions">
              <button type="button" className="pa-btn-ghost" onClick={() => { setShowCreate(false); setCreateError(null); }}>Cancel</button>
              <button type="submit" className="pa-btn-primary" disabled={creating}>
                {creating ? <I.spinner size={12} aria-hidden="true" /> : null}
                {creating ? "Creating…" : "Create School"}
              </button>
            </div>
          </form>
        </div>
      )}

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

      {/* Schools table */}
      {schools.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.building size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">
            {districtName ? `No locations in ${districtName} yet` : "No locations yet"}
          </p>
          <p className="page-empty-sub">
            Create a school to get started — once it's live, you can add devices and users from inside.
          </p>
        </div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <caption className="sr-only">Schools in this district</caption>
            <thead>
              <tr>
                <th scope="col">School</th>
                <th scope="col">Status</th>
                <th scope="col">Devices</th>
                <th scope="col">Plates</th>
                <th scope="col">Users</th>
                <th scope="col">Scans</th>
                <th scope="col">Timezone</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schools.map((school) => {
                const s = stats[school.id];
                return (
                  <tr key={school.id} className="pa-row">
                    <td data-label="School">
                      <div className="pa-school-name">{school.name}</div>
                      {school.admin_email && <div className="pa-school-email">{school.admin_email}</div>}
                    </td>
                    <td data-label="Status"><StatusBadge status={school.status} /></td>
                    <td data-label="Devices" className="pa-stat">{s ? s.devices : "—"}</td>
                    <td data-label="Plates" className="pa-stat">{s ? s.plates : "—"}</td>
                    <td data-label="Users" className="pa-stat">{s ? s.users : "—"}</td>
                    <td data-label="Scans" className="pa-stat">{s ? s.scans : "—"}</td>
                    <td data-label="Timezone" className="pa-tz">{school.timezone || "—"}</td>
                    <td data-label="Actions">
                      <div className="pa-actions">
                        <button className="pa-btn-action" onClick={() => handleManage(school)} title="Manage school">
                          <I.cog size={12} aria-hidden="true" /> Manage
                        </button>
                        <button className="pa-btn-action pa-btn-edit" onClick={() => openEdit(school)} title="Edit school settings">
                          <I.edit size={12} aria-hidden="true" /> Edit
                        </button>
                        <button
                          className={`pa-btn-action pa-btn-toggle ${school.status !== "active" ? "pa-btn-restore" : ""}`}
                          onClick={() => handleToggleStatus(school)}
                          disabled={toggling === school.id}
                          title={school.status === "active" ? "Suspend school" : "Reactivate school"}
                        >
                          {toggling === school.id ? <I.spinner size={12} aria-hidden="true" /> : school.status === "active" ? <I.ban size={12} aria-hidden="true" /> : <I.check size={12} aria-hidden="true" />}
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
          <div className="pa-modal" role="dialog" aria-modal="true" aria-labelledby="pa-edit-title">
            <div className="pa-modal-header">
              <h2 id="pa-edit-title" className="pa-modal-title">Edit School</h2>
              <button
                className="pa-modal-close"
                onClick={() => setEditingSchool(null)}
                aria-label="Close dialog"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <form className="pa-form" onSubmit={handleEditSubmit}>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pa-edit-name">
                  School Name <span aria-label="required">*</span>
                </label>
                <input id="pa-edit-name" className="pa-input" name="name" value={editForm.name} onChange={handleEditChange} required />
              </div>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pa-edit-email">Primary Admin Email</label>
                <input id="pa-edit-email" className="pa-input" name="admin_email" type="email" value={editForm.admin_email} onChange={handleEditChange} placeholder="principal@school.edu" />
              </div>
              <div className="pa-field">
                <label className="pa-label" htmlFor="pa-edit-tz">Timezone</label>
                <select id="pa-edit-tz" className="pa-select" name="timezone" value={editForm.timezone} onChange={handleEditChange}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              {editError && <p className="pa-error" role="alert">{editError}</p>}
              <div className="pa-form-actions">
                <button type="button" className="pa-btn-ghost" onClick={() => setEditingSchool(null)}>Cancel</button>
                <button type="submit" className="pa-btn-primary" disabled={saving}>
                  {saving ? <I.spinner size={12} aria-hidden="true" /> : null}
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
