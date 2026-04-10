import React, { useState, useEffect, useCallback } from "react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";
import "./BenefactorPortal.css";

// ─── Inline Icons (minimal) ────────────────────────────────────────────────
const IconChildren = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const IconCar = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h1l2-3h8l2 3h1a2 2 0 012 2v6a2 2 0 01-2 2M5 17a2 2 0 002 2h10a2 2 0 002-2" />
    <circle cx="7.5" cy="14.5" r="1.5" /><circle cx="16.5" cy="14.5" r="1.5" />
  </svg>
);
const IconUser = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);
const IconShield = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const IconClock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);
const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function BenefactorPortal({ token, currentUser, handleLogout }) {
  const [tab, setTab] = useState("children");
  const [noSchool, setNoSchool] = useState(false);
  const [noSchoolDismissed, setNoSchoolDismissed] = useState(false);
  const api = useCallback(() => createApiClient(token), [token]);

  const firstName = (currentUser?.display_name || "").split(" ")[0] || "there";

  // Check whether this guardian has been assigned to a school
  useEffect(() => {
    if (!token) return;
    createApiClient(token)
      .get("/api/v1/benefactor/assigned-schools")
      .then((res) => {
        const schools = res.data.schools || [];
        setNoSchool(schools.length === 0);
      })
      .catch(() => {}); // silently ignore
  }, [token]);

  return (
    <div className="bp-shell">
      {/* ── Top bar ── */}
      <header className="bp-topbar">
        <div className="bp-brand">Dismissal <span className="bp-brand-sub">Guardian Portal</span></div>
        <div className="bp-user">
          <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={32} />
          <span className="bp-user-name">{currentUser?.display_name || currentUser?.email}</span>
          <button className="bp-sign-out" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {/* ── No-school onboarding notification ── */}
      {noSchool && !noSchoolDismissed && (
        <div className="bp-alert-bar">
          <div className="bp-alert-item bp-alert-info">
            <span className="bp-alert-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
            <span className="bp-alert-message">
              Your account is not yet linked to a school. Please contact your school and ask them to add you in the Dismissal system so you can start managing pickups.
            </span>
            <button
              className="bp-alert-dismiss"
              onClick={() => setNoSchoolDismissed(true)}
              title="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Welcome ── */}
      <div className="bp-welcome">
        <h1 className="bp-welcome-title">Welcome, {firstName}</h1>
        <p className="bp-welcome-sub">Manage your children and vehicles for quick school pickup.</p>
      </div>

      {/* ── Tab bar ── */}
      <nav className="bp-tabs">
        {[
          { key: "children",  label: "My Children",        icon: <IconChildren /> },
          { key: "vehicles",  label: "My Vehicles",        icon: <IconCar /> },
          { key: "pickups",   label: "Authorized Pickups", icon: <IconShield /> },
          { key: "activity",  label: "Activity",           icon: <IconClock /> },
          { key: "profile",   label: "Profile",            icon: <IconUser /> },
        ].map((t) => (
          <button
            key={t.key}
            className={`bp-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            <span className="bp-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Tab content ── */}
      <div className="bp-content">
        {tab === "children"  && <ChildrenTab api={api} token={token} />}
        {tab === "vehicles"  && <VehiclesTab api={api} token={token} />}
        {tab === "pickups"   && <AuthorizedPickupsTab api={api} />}
        {tab === "activity"  && <ActivityTab api={api} />}
        {tab === "profile"   && <ProfileTab api={api} currentUser={currentUser} />}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CHILDREN TAB
// ═══════════════════════════════════════════════════════════════════════════
function ChildrenTab({ api, token }) {
  const [children, setChildren] = useState([]);
  const [assignedSchools, setAssignedSchools] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ first_name: "", last_name: "", school_id: "", grade: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [uploading, setUploading] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api().get("/api/v1/benefactor/children"),
      api().get("/api/v1/benefactor/assigned-schools"),
    ])
      .then(([childRes, schoolRes]) => {
        setChildren(childRes.data.children || []);
        setAssignedSchools(schoolRes.data.schools || []);
      })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/children", form);
      setChildren((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ first_name: "", last_name: "", school_id: "", grade: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add child");
    } finally {
      setSaving(false);
    }
  };

  const handlePhoto = async (childId, file) => {
    setUploading(childId);
    try {
      const path = `benefactor/${token ? "user" : "anon"}/${childId}/photo`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/children/${childId}`, { photo_url: url });
      setChildren((p) => p.map((c) => c.id === childId ? { ...c, photo_url: url } : c));
    } catch (err) {
      setError("Photo upload failed");
    } finally {
      setUploading(null);
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {children.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">👧👦</div>
          <h3>No children added yet</h3>
          <p>Add your children to get started with pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Add Your First Child
          </button>
        </div>
      )}

      {children.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{children.length} {children.length === 1 ? "child" : "children"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Child
            </button>
          </div>

          <div className="bp-cards">
            {children.map((c) => (
              <div key={c.id} className="bp-card">
                <div className="bp-card-top">
                  <label className="bp-card-avatar-wrap">
                    <PersonAvatar name={`${c.first_name} ${c.last_name}`} photoUrl={c.photo_url} size={56} />
                    <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && handlePhoto(c.id, e.target.files[0])} />
                    {uploading === c.id && <div className="bp-avatar-loading">...</div>}
                  </label>
                  <div className="bp-card-info">
                    <h4 className="bp-card-name">{c.first_name} {c.last_name}</h4>
                    {c.school_name && <span className="bp-card-detail">{c.school_name}</span>}
                    {c.grade && <span className="bp-card-detail">Grade {c.grade}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="bp-admin-note">
            To update student names or remove a student from your account, please contact your school administrator.
          </p>
        </>
      )}

      {/* Add Child Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Add Child</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>First Name</label>
                  <input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} required placeholder="Alex" />
                </div>
                <div className="bp-field">
                  <label>Last Name</label>
                  <input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} required placeholder="Smith" />
                </div>
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>School</label>
                  {assignedSchools.length === 0 ? (
                    <div className="bp-no-schools-msg">
                      No schools have been assigned to your account yet. Please contact your school administrator to get access.
                    </div>
                  ) : (
                    <select
                      className="bp-select"
                      value={form.school_id}
                      onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))}
                      required
                    >
                      <option value="">Select a school...</option>
                      {assignedSchools.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="bp-field">
                  <label>Grade <span className="bp-optional">(optional)</span></label>
                  <input value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} placeholder="3rd" />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving || assignedSchools.length === 0}>{saving ? "Adding..." : "Add Child"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// VEHICLES TAB  (Guardian Vehicle Registry)
// ═══════════════════════════════════════════════════════════════════════════
const IconEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const IconCamera = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" />
  </svg>
);
const IconCheck = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function VehiclesTab({ api, token }) {
  const [vehicles, setVehicles] = useState([]);
  const [children, setChildren] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [editing, setEditing]   = useState(null);   // vehicle object being edited
  const [form, setForm]         = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [editForm, setEditForm] = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [uploading, setUploading] = useState(null);  // vehicle id currently uploading photo

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api().get("/api/v1/benefactor/vehicles"),
      api().get("/api/v1/benefactor/children"),
    ])
      .then(([vRes, cRes]) => {
        setVehicles(vRes.data.vehicles || []);
        setChildren(cRes.data.children || []);
      })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // ── Add vehicle ──
  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/vehicles", form);
      setVehicles((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ plate_number: "", make: "", model: "", color: "", year: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add vehicle");
    } finally {
      setSaving(false);
    }
  };

  // ── Edit vehicle ──
  const openEdit = (v) => {
    setEditing(v);
    setEditForm({
      plate_number: v.plate_number || "",
      make: v.make || "",
      model: v.model || "",
      color: v.color || "",
      year: v.year || "",
    });
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api().patch(`/api/v1/benefactor/vehicles/${editing.id}`, editForm);
      setVehicles((p) => p.map((v) => v.id === editing.id ? { ...v, ...editForm } : v));
      setEditing(null);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update vehicle");
    } finally {
      setSaving(false);
    }
  };

  // ── Delete vehicle ──
  const handleDelete = async (id) => {
    if (!window.confirm("Remove this vehicle? It will no longer be recognized at pickup.")) return;
    try {
      await api().delete(`/api/v1/benefactor/vehicles/${id}`);
      setVehicles((p) => p.filter((v) => v.id !== id));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove");
    }
  };

  // ── Photo upload ──
  const handlePhoto = async (vehicleId, file) => {
    setUploading(vehicleId);
    try {
      const path = `vehicles/${vehicleId}/photo_${Date.now()}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { photo_url: url });
      setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, photo_url: url } : v));
    } catch (err) {
      setError("Photo upload failed");
    } finally {
      setUploading(null);
    }
  };

  // ── Child linking ──
  const toggleChild = async (vehicleId, childId, currentIds) => {
    const newIds = currentIds.includes(childId)
      ? currentIds.filter((id) => id !== childId)
      : [...currentIds, childId];
    try {
      await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { student_ids: newIds });
      setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, student_ids: newIds } : v));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  // ── Helpers ──
  const schoolMap = {};
  children.forEach((c) => {
    if (c.school_id && c.school_name) schoolMap[c.school_id] = c.school_name;
  });

  const formatDate = (ts) => {
    if (!ts) return null;
    try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return null; }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {vehicles.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">🚗</div>
          <h3>No vehicles registered yet</h3>
          <p>Register your vehicles so the school can identify you at pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Register Your First Vehicle
          </button>
        </div>
      )}

      {vehicles.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{vehicles.length} registered {vehicles.length === 1 ? "vehicle" : "vehicles"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Vehicle
            </button>
          </div>

          <div className="bp-cards">
            {vehicles.map((v) => {
              const desc = [v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
              const linkedIds = v.student_ids || [];
              const linkedSchools = (v.school_ids || []).map((sid) => schoolMap[sid]).filter(Boolean);
              const regDate = formatDate(v.created_at);
              return (
                <div key={v.id} className="bp-card">
                  <div className="bp-card-top">
                    {/* Vehicle photo or icon */}
                    <label className="bp-vehicle-photo-wrap">
                      {v.photo_url ? (
                        <img src={v.photo_url} alt={desc} className="bp-vehicle-photo" />
                      ) : (
                        <div className="bp-vehicle-icon-wrap">
                          <IconCar />
                        </div>
                      )}
                      <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && handlePhoto(v.id, e.target.files[0])} />
                      <div className="bp-vehicle-photo-overlay">
                        {uploading === v.id ? "..." : <IconCamera />}
                      </div>
                    </label>

                    <div className="bp-card-info">
                      <h4 className="bp-card-name">{desc}</h4>
                      <div className="bp-vehicle-meta">
                        {v.plate_number && <span className="bp-plate-badge">{v.plate_number}</span>}
                        {v.year && <span className="bp-card-detail">{v.year}</span>}
                      </div>
                      {linkedSchools.length > 0 && (
                        <div className="bp-vehicle-schools">
                          <IconCheck />
                          <span>{linkedSchools.join(", ")}</span>
                        </div>
                      )}
                      {regDate && <span className="bp-card-detail">Registered {regDate}</span>}
                    </div>

                    <div className="bp-card-actions">
                      <button className="bp-card-action-btn" onClick={() => openEdit(v)} title="Edit vehicle">
                        <IconEdit />
                      </button>
                      <button className="bp-card-delete" onClick={() => handleDelete(v.id)} title="Remove vehicle">&times;</button>
                    </div>
                  </div>

                  {/* Child linking */}
                  {children.length > 0 && (
                    <div className="bp-vehicle-children">
                      <span className="bp-vehicle-children-label">Linked for pickup:</span>
                      <div className="bp-child-chips">
                        {children.map((c) => {
                          const linked = linkedIds.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              className={`bp-child-chip${linked ? " active" : ""}`}
                              onClick={() => toggleChild(v.id, c.id, linkedIds)}
                              title={linked ? `Remove ${c.first_name}` : `Add ${c.first_name}`}
                            >
                              {c.first_name} {linked ? "✓" : "+"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add Vehicle Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Register Vehicle</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-field">
                <label>License Plate</label>
                <input
                  value={form.plate_number}
                  onChange={(e) => setForm((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))}
                  required
                  placeholder="ABC 1234"
                  className="bp-plate-input"
                />
              </div>
              <div className="bp-form-row bp-form-row-3">
                <div className="bp-field">
                  <label>Make</label>
                  <input value={form.make} onChange={(e) => setForm((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
                </div>
                <div className="bp-field">
                  <label>Model</label>
                  <input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="Highlander" />
                </div>
                <div className="bp-field">
                  <label>Color</label>
                  <input value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} placeholder="Gray" />
                </div>
              </div>
              <div className="bp-field">
                <label>Year <span className="bp-optional">(optional)</span></label>
                <input value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))} placeholder="2024" maxLength={4} style={{ maxWidth: 120 }} />
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Registering..." : "Register Vehicle"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Vehicle Modal */}
      {editing && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Edit Vehicle</h2>
              <button className="bp-modal-close" onClick={() => setEditing(null)}>&times;</button>
            </div>
            <form onSubmit={handleEdit} className="bp-form">
              <div className="bp-field">
                <label>License Plate</label>
                <input
                  value={editForm.plate_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))}
                  required
                  placeholder="ABC 1234"
                  className="bp-plate-input"
                />
              </div>
              <div className="bp-form-row bp-form-row-3">
                <div className="bp-field">
                  <label>Make</label>
                  <input value={editForm.make} onChange={(e) => setEditForm((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
                </div>
                <div className="bp-field">
                  <label>Model</label>
                  <input value={editForm.model} onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))} placeholder="Highlander" />
                </div>
                <div className="bp-field">
                  <label>Color</label>
                  <input value={editForm.color} onChange={(e) => setEditForm((f) => ({ ...f, color: e.target.value }))} placeholder="Gray" />
                </div>
              </div>
              <div className="bp-field">
                <label>Year <span className="bp-optional">(optional)</span></label>
                <input value={editForm.year} onChange={(e) => setEditForm((f) => ({ ...f, year: e.target.value }))} placeholder="2024" maxLength={4} style={{ maxWidth: 120 }} />
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZED PICKUPS TAB
// ═══════════════════════════════════════════════════════════════════════════
function AuthorizedPickupsTab({ api }) {
  const [pickups, setPickups]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ name: "", phone: "", relationship: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/authorized-pickups")
      .then((r) => setPickups(r.data.pickups || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/authorized-pickups", form);
      setPickups((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ name: "", phone: "", relationship: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this authorized pickup person?")) return;
    try {
      await api().delete(`/api/v1/benefactor/authorized-pickups/${id}`);
      setPickups((p) => p.filter((pk) => pk.id !== id));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove");
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {pickups.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">🛡️</div>
          <h3>No authorized pickups yet</h3>
          <p>Add other adults (grandparents, family friends, etc.) who are authorized to pick up your children.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Add Authorized Person
          </button>
        </div>
      )}

      {pickups.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{pickups.length} authorized {pickups.length === 1 ? "person" : "people"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Person
            </button>
          </div>

          <div className="bp-cards">
            {pickups.map((pk) => (
              <div key={pk.id} className="bp-card">
                <div className="bp-card-top">
                  <div className="bp-pickup-icon-wrap">
                    <IconShield />
                  </div>
                  <div className="bp-card-info">
                    <h4 className="bp-card-name">{pk.name}</h4>
                    {pk.relationship && <span className="bp-card-detail">{pk.relationship}</span>}
                    {pk.phone && <span className="bp-card-detail">{pk.phone}</span>}
                  </div>
                  <button className="bp-card-delete" onClick={() => handleDelete(pk.id)} title="Remove">&times;</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add Authorized Pickup Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Add Authorized Pickup</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-field">
                <label>Full Name</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="e.g. Grandma Smith" />
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>Phone <span className="bp-optional">(optional)</span></label>
                  <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" />
                </div>
                <div className="bp-field">
                  <label>Relationship <span className="bp-optional">(optional)</span></label>
                  <input value={form.relationship} onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))} placeholder="e.g. Grandmother" />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Adding..." : "Add Person"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ═══════════════════════════════════════════════════════════════════════════
function ActivityTab({ api }) {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/activity?limit=50")
      .then((r) => setEvents(r.data.events || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load activity"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const formatTime = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
      const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${date} at ${time}`;
    } catch {
      return ts;
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {events.length === 0 && (
        <div className="bp-empty">
          <div className="bp-empty-icon">📋</div>
          <h3>No pickup activity yet</h3>
          <p>Once your vehicles are scanned at school, pickup events will appear here.</p>
        </div>
      )}

      {events.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>Recent pickup activity</span>
            <button className="bp-btn bp-btn-ghost bp-btn-sm" onClick={load}>Refresh</button>
          </div>

          <div className="bp-activity-list">
            {events.map((ev) => (
              <div key={ev.id} className="bp-activity-row">
                <div className="bp-activity-icon">
                  <IconCar />
                </div>
                <div className="bp-activity-info">
                  <div className="bp-activity-main">
                    <span className="bp-activity-vehicle">{ev.vehicle_desc}</span>
                    {ev.plate_number && <span className="bp-plate-badge">{ev.plate_number}</span>}
                  </div>
                  {ev.students.length > 0 && (
                    <span className="bp-activity-students">{ev.students.join(", ")}</span>
                  )}
                  <span className="bp-activity-meta">
                    {formatTime(ev.timestamp)}
                    {ev.location && <> &middot; {ev.location}</>}
                    {ev.picked_up_at && <> &middot; Picked up</>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════════════════════════════════════════
function ProfileTab({ api, currentUser }) {
  const [form, setForm]     = useState({ display_name: currentUser?.display_name || "", phone: currentUser?.phone || "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState("");

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      await api().patch("/api/v1/benefactor/profile", form);
      setMsg("Profile updated!");
    } catch (err) {
      setMsg(err.response?.data?.detail || "Update failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bp-profile">
      <div className="bp-profile-header">
        <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={72} />
        <div>
          <h3>{currentUser?.display_name || "Your Profile"}</h3>
          <span className="bp-card-detail">{currentUser?.email}</span>
        </div>
      </div>

      <form onSubmit={handleSave} className="bp-form bp-profile-form">
        <div className="bp-field">
          <label>Display Name</label>
          <input value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} placeholder="Your name" />
        </div>
        <div className="bp-field">
          <label>Phone <span className="bp-optional">(optional)</span></label>
          <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" />
        </div>
        {msg && <p className={`bp-form-msg${msg.includes("fail") ? " error" : ""}`}>{msg}</p>}
        <button type="submit" className="bp-btn bp-btn-primary" disabled={saving} style={{ alignSelf: "flex-start" }}>
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </form>
    </div>
  );
}
