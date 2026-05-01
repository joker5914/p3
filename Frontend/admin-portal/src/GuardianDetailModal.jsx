import React, { useState, useEffect, useCallback } from "react";
import { I } from "./components/icons";
import { formatApiError } from "./utils";

/**
 * Guardian detail / edit modal.
 *
 * Self-contained: owns the detail-fetch lifecycle and the profile-edit
 * form state so that closing+reopening the modal resets cleanly.  Parent
 * controls visibility via `guardian` (truthy = open, null = closed) and
 * receives `onProfileUpdated` callbacks so it can keep the table row
 * label in sync with whatever the user just saved.
 *
 * Props:
 *   guardian            { uid, display_name, email, … } — the row that
 *                       was clicked.  Used to scope the detail fetch.
 *   api                 axios-like client
 *   canEdit             gate from the parent's permission check
 *   onClose             () => void
 *   onProfileUpdated    (uid, { display_name }) => void — fired after a
 *                       successful PATCH so parent can patch its list
 */
export default function GuardianDetailModal({
  guardian,
  api,
  canEdit,
  onClose,
  onProfileUpdated,
}) {
  const [detailData, setDetailData]       = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError]     = useState("");
  const [profileForm, setProfileForm]     = useState({ display_name: "", phone: "" });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg]       = useState("");

  const load = useCallback(async () => {
    setDetailLoading(true);
    setDetailError("");
    setProfileMsg("");
    try {
      const res = await api.get(`/api/v1/admin/guardians/${guardian.uid}/detail`);
      setDetailData(res.data);
      setProfileForm({
        display_name: res.data.profile?.display_name || "",
        phone: res.data.profile?.phone || "",
      });
    } catch (err) {
      setDetailError(formatApiError(err, "Failed to load guardian details"));
    } finally {
      setDetailLoading(false);
    }
  }, [api, guardian.uid]);

  useEffect(() => { load(); }, [load]);

  const handleSaveProfile = async () => {
    setProfileSaving(true);
    setProfileMsg("");
    try {
      await api.patch(`/api/v1/admin/guardians/${guardian.uid}/profile`, profileForm);
      setProfileMsg("Profile updated successfully.");
      onProfileUpdated?.(guardian.uid, { display_name: profileForm.display_name });
      load();
    } catch (err) {
      setProfileMsg(formatApiError(err, "Failed to update profile"));
    } finally {
      setProfileSaving(false);
    }
  };

  return (
    <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gm-modal gm-modal-lg">
        <div className="gm-modal-header">
          <h2>Guardian Details</h2>
          <button className="gm-modal-close" onClick={onClose} aria-label="Close dialog">
            <I.x size={16} aria-hidden="true" />
          </button>
        </div>

        {detailLoading && <div className="gm-detail-loading">Loading guardian details...</div>}
        {detailError && <div className="gm-form-error">{detailError}</div>}

        {!detailLoading && detailData && (
          <div className="gm-detail-content">
            {/* Profile — single view-and-edit screen.  The row Edit button
                opens the modal in edit mode; Cancel = close the modal
                (X). Pending edits are discarded by the next load() call
                when the modal is reopened. */}
            <div className="gm-detail-section">
              <div className="gm-detail-section-header">
                <h3>Profile</h3>
              </div>

              <div className="gm-detail-edit-form">
                <div className="gm-detail-row">
                  <span className="gm-detail-label">Email</span>
                  <span className="gm-detail-value">{detailData.profile?.email || "—"}</span>
                </div>
                {detailData.profile?.photo_url && (
                  <div className="gm-detail-row">
                    <span className="gm-detail-label">Photo</span>
                    <img
                      src={detailData.profile.photo_url}
                      alt="Guardian"
                      className="gm-detail-photo"
                    />
                  </div>
                )}
                <div className="gm-field">
                  <label className="gm-label" htmlFor="gm-profile-name">Display Name</label>
                  <input
                    id="gm-profile-name"
                    className="gm-input"
                    value={profileForm.display_name}
                    onChange={(e) => setProfileForm((f) => ({ ...f, display_name: e.target.value }))}
                    placeholder="Full name"
                    disabled={!canEdit}
                  />
                </div>
                <div className="gm-field">
                  <label className="gm-label" htmlFor="gm-profile-phone">Phone</label>
                  <input
                    id="gm-profile-phone"
                    className="gm-input"
                    value={profileForm.phone}
                    onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="(555) 123-4567"
                    type="tel"
                    disabled={!canEdit}
                  />
                </div>
                {profileMsg && (
                  <p className={`gm-detail-msg${profileMsg.includes("Failed") ? " error" : ""}`}>
                    {profileMsg}
                  </p>
                )}
                {canEdit && (
                  <div className="gm-detail-edit-actions">
                    <button
                      className="gm-btn-primary"
                      onClick={handleSaveProfile}
                      disabled={profileSaving}
                    >
                      {profileSaving ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="gm-detail-section">
              <h3>Assigned Schools</h3>
              {(detailData.assigned_schools || []).length === 0 ? (
                <p className="gm-detail-empty">No schools assigned</p>
              ) : (
                <div className="gm-detail-list">
                  {detailData.assigned_schools.map((s) => (
                    <div key={s.id} className="gm-detail-list-item">
                      <I.building size={14} className="gm-detail-item-icon" aria-hidden="true" />
                      <span>{s.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="gm-detail-section">
              <h3>Children ({(detailData.children || []).length})</h3>
              {(detailData.children || []).length === 0 ? (
                <p className="gm-detail-empty">No children added</p>
              ) : (
                <div className="gm-detail-list">
                  {detailData.children.map((c) => (
                    <div key={c.id} className="gm-detail-list-item">
                      <div className="gm-detail-child-info">
                        <span className="gm-detail-child-name">{c.first_name} {c.last_name}</span>
                        <span className="gm-detail-child-meta">
                          {c.school_name && <span>{c.school_name}</span>}
                          {c.grade && <span> &middot; Grade {c.grade}</span>}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="gm-detail-section">
              <h3>Vehicles ({(detailData.vehicles || []).length})</h3>
              {(detailData.vehicles || []).length === 0 ? (
                <p className="gm-detail-empty">No vehicles registered</p>
              ) : (
                <div className="gm-detail-list">
                  {detailData.vehicles.map((v) => (
                    <div key={v.id} className="gm-detail-list-item">
                      <div className="gm-detail-vehicle-info">
                        <span className="gm-detail-vehicle-desc">
                          {[v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle"}
                        </span>
                        <span className="gm-detail-vehicle-meta">
                          {v.plate_number && <span className="gm-plate-badge">{v.plate_number}</span>}
                          {v.year && <span> &middot; {v.year}</span>}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="gm-detail-section">
              <h3>Authorized Pickups ({(detailData.authorized_pickups || []).length})</h3>
              {(detailData.authorized_pickups || []).length === 0 ? (
                <p className="gm-detail-empty">No authorized pickups</p>
              ) : (
                <div className="gm-detail-list">
                  {detailData.authorized_pickups.map((p) => (
                    <div key={p.id} className="gm-detail-list-item">
                      <div className="gm-detail-pickup-info">
                        <span className="gm-detail-pickup-name">{p.name}</span>
                        <span className="gm-detail-pickup-meta">
                          {p.relationship && <span>{p.relationship}</span>}
                          {p.phone && <span> &middot; {p.phone}</span>}
                        </span>
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
