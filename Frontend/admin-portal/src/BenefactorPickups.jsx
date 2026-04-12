import React, { useState, useEffect, useCallback } from "react";

const IconShield = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>);
const IconPlus = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);

export default function BenefactorPickups({ api }) {
  const [pickups, setPickups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ name: "", phone: "", relationship: "" });
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/authorized-pickups")
      .then((r) => setPickups(r.data.pickups || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault(); setSaving(true); setError("");
    try { const res = await api().post("/api/v1/benefactor/authorized-pickups", form); setPickups((p) => [...p, res.data]); setShowAdd(false); setForm({ name: "", phone: "", relationship: "" }); }
    catch (err) { setError(err.response?.data?.detail || "Failed to add"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Remove this authorized pickup person?")) return;
    try { await api().delete(`/api/v1/benefactor/authorized-pickups/${id}`); setPickups((p) => p.filter((pk) => pk.id !== id)); }
    catch (err) { setError(err.response?.data?.detail || "Failed to remove"); }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}
      {pickups.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon">🛡️</div>
          <h3>No authorized pickups yet</h3>
          <p>Add other adults (grandparents, family friends, etc.) authorized to pick up your children.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}><IconPlus /> Add Authorized Person</button>
        </div>
      )}
      {pickups.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{pickups.length} authorized {pickups.length === 1 ? "person" : "people"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}><IconPlus /> Add Person</button>
          </div>
          <div className="bp-cards">
            {pickups.map((pk) => (
              <div key={pk.id} className="bp-card">
                <div className="bp-card-top">
                  <div className="bp-pickup-icon-wrap"><IconShield /></div>
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
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header"><h2>Add Authorized Pickup</h2><button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button></div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-field"><label>Full Name</label><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="e.g. Grandma Smith" /></div>
              <div className="bp-form-row">
                <div className="bp-field"><label>Phone <span className="bp-optional">(optional)</span></label><input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" /></div>
                <div className="bp-field"><label>Relationship <span className="bp-optional">(optional)</span></label><input value={form.relationship} onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))} placeholder="e.g. Grandmother" /></div>
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
