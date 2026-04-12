import React, { useState, useEffect, useCallback } from "react";
import { FaSchool } from "react-icons/fa";

/**
 * Detail / edit modal for a single guardian.
 *
 * Props:
 *   guardian           The guardian object (from the parent list)
 *   api                Axios-like client
 *   onClose            Close handler
 *   onProfileUpdated   (uid, { display_name }) callback to refresh parent list
 *   onSchoolRemoved    (uid, schoolId) callback to update parent list
 */
export default function GuardianDetailModal({ guardian, api, onClose, onProfileUpdated, onSchoolRemoved }) {
  const [detailData, setDetailData]     = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError]   = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm]   = useState({ display_name: "", phone: "" });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg]     = useState("");

  const load = useCallback(async () => {
    setDetailLoading(true); setDetailError(""); setEditingProfile(false); setProfileMsg("");
    try {
      const res = await api.get(`/api/v1/admin/guardians/${guardian.uid}/detail`);
      setDetailData(res.data);
      setProfileForm({ display_name: res.data.profile?.display_name || "", phone: res.data.profile?.phone || "" });
    } catch (err) {
      setDetailError(err.response?.data?.detail || "Failed to load guardian details");
    } finally { setDetailLoading(false); }
  }, [api, guardian.uid]);

  useEffect(() => { load(); }, [load]);

  const handleSaveProfile = async () => {
    setProfileSaving(true); setProfileMsg("");
    try {
      await api.patch(`/api/v1/admin/guardians/${guardian.uid}/profile`, profileForm);
      setProfileMsg("Profile updated successfully.");
      setEditingProfile(false);
      onProfileUpdated(guardian.uid, { display_name: profileForm.display_name });
      load();
    } catch (err) { setProfileMsg(err.response?.data?.detail || "Failed to update profile"); }
    finally { setProfileSaving(false); }
  };

  const handleRemoveSchool = async (schoolId) => {
    if (!window.confirm("Remove this school assignment? The guardian will no longer be able to add children to this school.")) return;
    try {
      await api.delete(`/api/v1/admin/guardians/${guardian.uid}/schools/${schoolId}`);
      onSchoolRemoved(guardian.uid, schoolId);
      load();
    } catch (err) { setDetailError(err.response?.data?.detail || "Failed to remove school"); }
  };

  return (
    <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gm-modal gm-modal-lg">
        <div className="gm-modal-header"><h2>Guardian Details</h2><button className="gm-modal-close" onClick={onClose}>&times;</button></div>

        {detailLoading && <div className="gm-detail-loading">Loading guardian details...</div>}
        {detailError && <div className="gm-form-error">{detailError}</div>}

        {!detailLoading && detailData && (
          <div className="gm-detail-content">
            {/* Profile */}
            <div className="gm-detail-section">
              <div className="gm-detail-section-header">
                <h3>Profile</h3>
                {!editingProfile && <button className="gm-btn gm-btn-sm" onClick={() => setEditingProfile(true)}>Edit</button>}
              </div>
              {editingProfile ? (
                <div className="gm-detail-edit-form">
                  <div className="gm-field"><label className="gm-label">Display Name</label><input className="gm-input" value={profileForm.display_name} onChange={(e) => setProfileForm((f) => ({ ...f, display_name: e.target.value }))} placeholder="Full name" /></div>
                  <div className="gm-field"><label className="gm-label">Phone</label><input className="gm-input" value={profileForm.phone} onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" /></div>
                  {profileMsg && <p className={`gm-detail-msg${profileMsg.includes("Failed") ? " error" : ""}`}>{profileMsg}</p>}
                  <div className="gm-detail-edit-actions">
                    <button className="gm-btn gm-btn-ghost" onClick={() => { setEditingProfile(false); setProfileMsg(""); setProfileForm({ display_name: detailData.profile?.display_name || "", phone: detailData.profile?.phone || "" }); }} disabled={profileSaving}>Cancel</button>
                    <button className="gm-btn gm-btn-primary" onClick={handleSaveProfile} disabled={profileSaving}>{profileSaving ? "Saving..." : "Save Changes"}</button>
                  </div>
                </div>
              ) : (
                <div className="gm-detail-profile-info">
                  <div className="gm-detail-row"><span className="gm-detail-label">Name</span><span className="gm-detail-value">{detailData.profile?.display_name || "(No name)"}</span></div>
                  <div className="gm-detail-row"><span className="gm-detail-label">Email</span><span className="gm-detail-value">{detailData.profile?.email || "—"}</span></div>
                  <div className="gm-detail-row"><span className="gm-detail-label">Phone</span><span className="gm-detail-value">{detailData.profile?.phone || "—"}</span></div>
                  {detailData.profile?.photo_url && (<div className="gm-detail-row"><span className="gm-detail-label">Photo</span><img src={detailData.profile.photo_url} alt="Guardian" className="gm-detail-photo" /></div>)}
                  {profileMsg && <p className={`gm-detail-msg${profileMsg.includes("Failed") ? " error" : ""}`}>{profileMsg}</p>}
                </div>
              )}
            </div>

            {/* Assigned Schools */}
            <div className="gm-detail-section">
              <h3>Assigned Schools</h3>
              {!(detailData.assigned_schools?.length) ? (<p className="gm-detail-empty">No schools assigned</p>) : (
                <div className="gm-detail-list">
                  {detailData.assigned_schools.map((s) => (
                    <div key={s.id} className="gm-detail-list-item">
                      <FaSchool className="gm-detail-item-icon" /><span>{s.name}</span>
                      <button className="gm-btn gm-btn-sm" onClick={() => handleRemoveSchool(s.id)} style={{ marginLeft: "auto" }}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Children */}
            <div className="gm-detail-section">
              <h3>Children ({detailData.children?.length ?? 0})</h3>
              {!(detailData.children?.length) ? (<p className="gm-detail-empty">No children added</p>) : (
                <div className="gm-detail-list">
                  {detailData.children.map((c) => (
                    <div key={c.id} className="gm-detail-list-item">
                      <div className="gm-detail-child-info">
                        <span className="gm-detail-child-name">{c.first_name} {c.last_name}</span>
                        <span className="gm-detail-child-meta">{c.school_name && <span>{c.school_name}</span>}{c.grade && <span> &middot; Grade {c.grade}</span>}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Vehicles */}
            <div className="gm-detail-section">
              <h3>Vehicles ({detailData.vehicles?.length ?? 0})</h3>
              {!(detailData.vehicles?.length) ? (<p className="gm-detail-empty">No vehicles registered</p>) : (
                <div className="gm-detail-list">
                  {detailData.vehicles.map((v) => (
                    <div key={v.id} className="gm-detail-list-item">
                      <div className="gm-detail-vehicle-info">
                        <span className="gm-detail-vehicle-desc">{[v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}</span>
                        <span className="gm-detail-vehicle-meta">{v.plate_number && <span className="gm-plate-badge">{v.plate_number}</span>}{v.year && <span> &middot; {v.year}</span>}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Authorized Pickups */}
            <div className="gm-detail-section">
              <h3>Authorized Pickups ({detailData.authorized_pickups?.length ?? 0})</h3>
              {!(detailData.authorized_pickups?.length) ? (<p className="gm-detail-empty">No authorized pickups</p>) : (
                <div className="gm-detail-list">
                  {detailData.authorized_pickups.map((p) => (
                    <div key={p.id} className="gm-detail-list-item">
                      <div className="gm-detail-pickup-info">
                        <span className="gm-detail-pickup-name">{p.name}</span>
                        <span className="gm-detail-pickup-meta">{p.relationship && <span>{p.relationship}</span>}{p.phone && <span> &middot; {p.phone}</span>}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
