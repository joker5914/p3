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
const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function BenefactorPortal({ token, currentUser, handleLogout }) {
  const [tab, setTab] = useState("children");
  const api = useCallback(() => createApiClient(token), [token]);

  const firstName = (currentUser?.display_name || "").split(" ")[0] || "there";

  return (
    <div className="bp-shell">
      {/* ── Top bar ── */}
      <header className="bp-topbar">
        <div className="bp-brand">Dismissal <span className="bp-brand-sub">Family</span></div>
        <div className="bp-user">
          <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={32} />
          <span className="bp-user-name">{currentUser?.display_name || currentUser?.email}</span>
          <button className="bp-sign-out" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {/* ── Welcome ── */}
      <div className="bp-welcome">
        <h1 className="bp-welcome-title">Welcome, {firstName}</h1>
        <p className="bp-welcome-sub">Manage your children and vehicles for quick school pickup.</p>
      </div>

      {/* ── Tab bar ── */}
      <nav className="bp-tabs">
        {[
          { key: "children", label: "My Children", icon: <IconChildren /> },
          { key: "vehicles", label: "My Vehicles", icon: <IconCar /> },
          { key: "profile",  label: "Profile",     icon: <IconUser /> },
        ].map((t) => (
          <button
            key={t.key}
            className={`bp-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Tab content ── */}
      <div className="bp-content">
        {tab === "children" && <ChildrenTab api={api} token={token} />}
        {tab === "vehicles" && <VehiclesTab api={api} token={token} />}
        {tab === "profile"  && <ProfileTab api={api} currentUser={currentUser} />}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CHILDREN TAB
// ═══════════════════════════════════════════════════════════════════════════
function ChildrenTab({ api, token }) {
  const [children, setChildren] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ first_name: "", last_name: "", school_code: "", grade: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [uploading, setUploading] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/children")
      .then((r) => setChildren(r.data.children || []))
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
      setForm({ first_name: "", last_name: "", school_code: "", grade: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add child");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this child from your account?")) return;
    try {
      await api().delete(`/api/v1/benefactor/children/${id}`);
      setChildren((p) => p.filter((c) => c.id !== id));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove");
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
                  <button className="bp-card-delete" onClick={() => handleDelete(c.id)} title="Remove child">×</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add Child Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Add Child</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>×</button>
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
                  <label>School Code</label>
                  <input value={form.school_code} onChange={(e) => setForm((f) => ({ ...f, school_code: e.target.value.toUpperCase() }))} required placeholder="ABC123" maxLength={10} />
                  <span className="bp-hint">Ask your school for their enrollment code</span>
                </div>
                <div className="bp-field">
                  <label>Grade <span className="bp-optional">(optional)</span></label>
                  <input value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} placeholder="3rd" />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Adding..." : "Add Child"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// VEHICLES TAB
// ═══════════════════════════════════════════════════════════════════════════
function VehiclesTab({ api, token }) {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/vehicles")
      .then((r) => setVehicles(r.data.vehicles || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

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

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this vehicle?")) return;
    try {
      await api().delete(`/api/v1/benefactor/vehicles/${id}`);
      setVehicles((p) => p.filter((v) => v.id !== id));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove");
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {vehicles.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">🚗</div>
          <h3>No vehicles added yet</h3>
          <p>Add your vehicles so the school can identify you at pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Add Your First Vehicle
          </button>
        </div>
      )}

      {vehicles.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{vehicles.length} {vehicles.length === 1 ? "vehicle" : "vehicles"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Vehicle
            </button>
          </div>

          <div className="bp-cards">
            {vehicles.map((v) => {
              const desc = [v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
              return (
                <div key={v.id} className="bp-card">
                  <div className="bp-card-top">
                    <div className="bp-vehicle-icon-wrap">
                      <IconCar />
                    </div>
                    <div className="bp-card-info">
                      <h4 className="bp-card-name">{desc}</h4>
                      {v.plate_number && (
                        <span className="bp-plate-badge">{v.plate_number}</span>
                      )}
                      {v.year && <span className="bp-card-detail">{v.year}</span>}
                    </div>
                    <button className="bp-card-delete" onClick={() => handleDelete(v.id)} title="Remove vehicle">×</button>
                  </div>
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
              <h2>Add Vehicle</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>×</button>
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
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Adding..." : "Add Vehicle"}</button>
              </div>
            </form>
          </div>
        </div>
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
