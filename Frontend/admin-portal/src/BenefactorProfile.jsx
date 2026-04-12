import React, { useState } from "react";
import PersonAvatar from "./PersonAvatar";

export default function BenefactorProfile({ api, currentUser }) {
  const [form, setForm]     = useState({ display_name: currentUser?.display_name || "", phone: currentUser?.phone || "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState("");

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true); setMsg("");
    try { await api().patch("/api/v1/benefactor/profile", form); setMsg("Profile updated!"); }
    catch (err) { setMsg(err.response?.data?.detail || "Update failed"); }
    finally { setSaving(false); }
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
        <div className="bp-field"><label>Display Name</label><input value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} placeholder="Your name" /></div>
        <div className="bp-field"><label>Phone <span className="bp-optional">(optional)</span></label><input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" /></div>
        {msg && <p className={`bp-form-msg${msg.includes("fail") ? " error" : ""}`}>{msg}</p>}
        <button type="submit" className="bp-btn bp-btn-primary" disabled={saving} style={{ alignSelf: "flex-start" }}>{saving ? "Saving..." : "Save Changes"}</button>
      </form>
    </div>
  );
}
