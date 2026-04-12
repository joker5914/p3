import React, { useState, useEffect, useCallback } from "react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";

const IconPlus = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);

export default function BenefactorChildren({ api }) {
  const [children, setChildren] = useState([]);
  const [assignedSchools, setAssignedSchools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ first_name: "", last_name: "", school_id: "", grade: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api().get("/api/v1/benefactor/children"),
      api().get("/api/v1/benefactor/assigned-schools"),
    ])
      .then(([childRes, schoolRes]) => { setChildren(childRes.data.children || []); setAssignedSchools(schoolRes.data.schools || []); })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try {
      const res = await api().post("/api/v1/benefactor/children", form);
      setChildren((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ first_name: "", last_name: "", school_id: "", grade: "" });
    } catch (err) { setError(err.response?.data?.detail || "Failed to add child"); }
    finally { setSaving(false); }
  };

  const handlePhoto = async (childId, file) => {
    setUploading(childId);
    try {
      const storageRef = ref(storage, `benefactor/children/${childId}/photo`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/children/${childId}`, { photo_url: url });
      setChildren((p) => p.map((c) => c.id === childId ? { ...c, photo_url: url } : c));
    } catch { setError("Photo upload failed"); }
    finally { setUploading(null); }
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
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}><IconPlus /> Add Your First Child</button>
        </div>
      )}

      {children.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{children.length} {children.length === 1 ? "child" : "children"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}><IconPlus /> Add Child</button>
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
          <p className="bp-admin-note">To update student names or remove a student from your account, please contact your school administrator.</p>
        </>
      )}

      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header"><h2>Add Child</h2><button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button></div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-form-row">
                <div className="bp-field"><label>First Name</label><input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} required placeholder="Alex" /></div>
                <div className="bp-field"><label>Last Name</label><input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} required placeholder="Smith" /></div>
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>School</label>
                  {assignedSchools.length === 0 ? (
                    <div className="bp-no-schools-msg">No schools assigned to your account yet. Contact your school administrator.</div>
                  ) : (
                    <select className="bp-select" value={form.school_id} onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))} required>
                      <option value="">Select a school...</option>
                      {assignedSchools.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                    </select>
                  )}
                </div>
                <div className="bp-field"><label>Grade <span className="bp-optional">(optional)</span></label><input value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} placeholder="3rd" /></div>
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
