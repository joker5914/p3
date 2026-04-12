import React, { useState, useEffect, useCallback } from "react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";

const IconCar = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h1l2-3h8l2 3h1a2 2 0 012 2v6a2 2 0 01-2 2M5 17a2 2 0 002 2h10a2 2 0 002-2" /><circle cx="7.5" cy="14.5" r="1.5" /><circle cx="16.5" cy="14.5" r="1.5" /></svg>);
const IconEdit = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>);
const IconCamera = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>);
const IconCheck = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>);
const IconPlus = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);

export default function BenefactorVehicles({ api }) {
  const [vehicles, setVehicles]   = useState([]);
  const [children, setChildren]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showAdd, setShowAdd]     = useState(false);
  const [editing, setEditing]     = useState(null);
  const [form, setForm]           = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [editForm, setEditForm]   = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState("");
  const [uploading, setUploading] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api().get("/api/v1/benefactor/vehicles"), api().get("/api/v1/benefactor/children")])
      .then(([vRes, cRes]) => { setVehicles(vRes.data.vehicles || []); setChildren(cRes.data.children || []); })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try { const res = await api().post("/api/v1/benefactor/vehicles", form); setVehicles((p) => [...p, res.data]); setShowAdd(false); setForm({ plate_number: "", make: "", model: "", color: "", year: "" }); }
    catch (err) { setError(err.response?.data?.detail || "Failed to add vehicle"); }
    finally { setSaving(false); }
  };

  const openEdit = (v) => { setEditing(v); setEditForm({ plate_number: v.plate_number || "", make: v.make || "", model: v.model || "", color: v.color || "", year: v.year || "" }); };

  const handleEdit = async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try { await api().patch(`/api/v1/benefactor/vehicles/${editing.id}`, editForm); setVehicles((p) => p.map((v) => v.id === editing.id ? { ...v, ...editForm } : v)); setEditing(null); }
    catch (err) { setError(err.response?.data?.detail || "Failed to update vehicle"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this vehicle?")) return;
    try { await api().delete(`/api/v1/benefactor/vehicles/${id}`); setVehicles((p) => p.filter((v) => v.id !== id)); }
    catch (err) { setError(err.response?.data?.detail || "Failed to remove"); }
  };

  const handlePhoto = async (vehicleId, file) => {
    setUploading(vehicleId);
    try {
      const storageRef = ref(storage, `vehicles/${vehicleId}/photo_${Date.now()}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { photo_url: url });
      setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, photo_url: url } : v));
    } catch { setError("Photo upload failed"); }
    finally { setUploading(null); }
  };

  const toggleChild = async (vehicleId, childId, currentIds) => {
    const newIds = currentIds.includes(childId) ? currentIds.filter((id) => id !== childId) : [...currentIds, childId];
    try { await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { student_ids: newIds }); setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, student_ids: newIds } : v)); }
    catch (err) { setError(err.response?.data?.detail || "Failed to update"); }
  };

  const schoolMap = {};
  children.forEach((c) => { if (c.school_id && c.school_name) schoolMap[c.school_id] = c.school_name; });
  const formatDate = (ts) => { if (!ts) return null; try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return null; } };

  const VehicleFormFields = ({ vals, set }) => (
    <>
      <div className="bp-field"><label>License Plate</label><input value={vals.plate_number} onChange={(e) => set((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))} required placeholder="ABC 1234" className="bp-plate-input" /></div>
      <div className="bp-form-row bp-form-row-3">
        <div className="bp-field"><label>Make</label><input value={vals.make} onChange={(e) => set((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" /></div>
        <div className="bp-field"><label>Model</label><input value={vals.model} onChange={(e) => set((f) => ({ ...f, model: e.target.value }))} placeholder="Highlander" /></div>
        <div className="bp-field"><label>Color</label><input value={vals.color} onChange={(e) => set((f) => ({ ...f, color: e.target.value }))} placeholder="Gray" /></div>
      </div>
      <div className="bp-field"><label>Year <span className="bp-optional">(optional)</span></label><input value={vals.year} onChange={(e) => set((f) => ({ ...f, year: e.target.value }))} placeholder="2024" maxLength={4} style={{ maxWidth: 120 }} /></div>
    </>
  );

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {vehicles.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">🚗</div>
          <h3>No vehicles registered yet</h3>
          <p>Register your vehicles so the school can identify you at pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}><IconPlus /> Register Your First Vehicle</button>
        </div>
      )}

      {vehicles.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{vehicles.length} registered {vehicles.length === 1 ? "vehicle" : "vehicles"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}><IconPlus /> Add Vehicle</button>
          </div>
          <div className="bp-cards">
            {vehicles.map((v) => {
              const desc = [v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
              const linkedIds = v.student_ids || [];
              const linkedSchools = (v.school_ids || []).map((sid) => schoolMap[sid]).filter(Boolean);
              return (
                <div key={v.id} className="bp-card">
                  <div className="bp-card-top">
                    <label className="bp-vehicle-photo-wrap">
                      {v.photo_url ? (<img src={v.photo_url} alt={desc} className="bp-vehicle-photo" />) : (<div className="bp-vehicle-icon-wrap"><IconCar /></div>)}
                      <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && handlePhoto(v.id, e.target.files[0])} />
                      <div className="bp-vehicle-photo-overlay">{uploading === v.id ? "..." : <IconCamera />}</div>
                    </label>
                    <div className="bp-card-info">
                      <h4 className="bp-card-name">{desc}</h4>
                      <div className="bp-vehicle-meta">
                        {v.plate_number && <span className="bp-plate-badge">{v.plate_number}</span>}
                        {v.year && <span className="bp-card-detail">{v.year}</span>}
                      </div>
                      {linkedSchools.length > 0 && (<div className="bp-vehicle-schools"><IconCheck /><span>{linkedSchools.join(", ")}</span></div>)}
                      {formatDate(v.created_at) && <span className="bp-card-detail">Registered {formatDate(v.created_at)}</span>}
                    </div>
                    <div className="bp-card-actions">
                      <button className="bp-card-action-btn" onClick={() => openEdit(v)} title="Edit vehicle"><IconEdit /></button>
                      <button className="bp-card-delete" onClick={() => handleDelete(v.id)} title="Remove vehicle">&times;</button>
                    </div>
                  </div>
                  {children.length > 0 && (
                    <div className="bp-vehicle-children">
                      <span className="bp-vehicle-children-label">Linked for pickup:</span>
                      <div className="bp-child-chips">
                        {children.map((c) => {
                          const linked = linkedIds.includes(c.id);
                          return (<button key={c.id} className={`bp-child-chip${linked ? " active" : ""}`} onClick={() => toggleChild(v.id, c.id, linkedIds)} title={linked ? `Remove ${c.first_name}` : `Add ${c.first_name}`}>{c.first_name} {linked ? "✓" : "+"}</button>);
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

      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header"><h2>Register Vehicle</h2><button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button></div>
            <form onSubmit={handleAdd} className="bp-form">
              <VehicleFormFields vals={form} set={setForm} />
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions"><button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button><button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Registering..." : "Register Vehicle"}</button></div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="bp-modal">
            <div className="bp-modal-header"><h2>Edit Vehicle</h2><button className="bp-modal-close" onClick={() => setEditing(null)}>&times;</button></div>
            <form onSubmit={handleEdit} className="bp-form">
              <VehicleFormFields vals={editForm} set={setEditForm} />
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions"><button type="button" className="bp-btn bp-btn-ghost" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Changes"}</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
