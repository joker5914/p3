import React from "react";
import { FaCamera, FaImage, FaExclamationTriangle, FaPlus, FaTimes } from "react-icons/fa";
import PersonAvatar from "./PersonAvatar";

/**
 * Renders either the Authorized Guardians or Blocked Guardians section
 * inside the plate edit modal. Keeps the two very-similar lists DRY.
 *
 * Props:
 *   type              "authorized" | "blocked"
 *   entries           current array from editForm
 *   setEditForm       state setter from PlateEditModal
 *   uploadingPhoto    key of photo currently uploading (string | null)
 *   openPhotoMenu     (key, type, index) => void
 *   photoMenuOpen     key of open popover (string | null)
 *   handlePhotoOption (mode) => void
 */
export default function GuardianEntrySection({
  type,
  entries,
  setEditForm,
  uploadingPhoto,
  openPhotoMenu,
  photoMenuOpen,
  handlePhotoOption,
}) {
  const isBlocked = type === "blocked";
  const field = isBlocked ? "blocked_guardians" : "authorized_guardians";
  const photoKeyPrefix = "auth"; // always "auth" — handlePhotoUpload checks type

  const blank = isBlocked
    ? { name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "", reason: "" }
    : { name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "" };

  const addEntry = () => setEditForm((f) => ({ ...f, [field]: [...(f[field] || []), blank] }));

  const updateEntry = (idx, patch) =>
    setEditForm((f) => {
      const list = [...(f[field] || [])];
      list[idx] = { ...list[idx], ...patch };
      return { ...f, [field]: list };
    });

  const removeEntry = (idx) =>
    setEditForm((f) => ({ ...f, [field]: (f[field] || []).filter((_, i) => i !== idx) }));

  const blockEntry = (idx) =>
    setEditForm((f) => {
      const ag = (f.authorized_guardians || [])[idx];
      return {
        ...f,
        authorized_guardians: (f.authorized_guardians || []).filter((_, i) => i !== idx),
        ...(ag?.name.trim()
          ? { blocked_guardians: [...(f.blocked_guardians || []), { name: ag.name, photo_url: ag.photo_url, plate_number: ag.plate_number, vehicle_make: ag.vehicle_make, vehicle_model: ag.vehicle_model, vehicle_color: ag.vehicle_color, reason: "" }] }
          : {}),
      };
    });

  return (
    <>
      <div className="reg-modal-divider" />
      <div className="reg-modal-field">
        <div className="reg-modal-section-header">
          <label className={`reg-modal-section-label${isBlocked ? " reg-section-danger" : ""}`}>
            {isBlocked ? "Blocked Guardians" : "Authorized Guardians"}
          </label>
          <button type="button" className="reg-btn reg-btn-ghost reg-btn-sm" onClick={addEntry}>
            <FaPlus style={{ fontSize: 10 }} /> Add
          </button>
        </div>
        <p className="reg-modal-hint-block">
          {isBlocked
            ? "People NOT authorized to pick up these students. If their vehicle is scanned, admins will see an alert."
            : "Additional people authorized to pick up these students. Add their vehicle info so the system recognizes them on arrival."}
        </p>
        {entries.length === 0 && (
          <p className="reg-auth-empty">{isBlocked ? "No blocked guardians." : "No additional guardians added."}</p>
        )}
        {entries.map((entry, idx) => {
          const photoKey = `${photoKeyPrefix}_${idx}`;
          return (
            <div key={idx} className={`reg-auth-entry${isBlocked ? " reg-blocked-entry" : ""}`}>
              <div className="reg-auth-row">
                <PersonAvatar name={entry.name} photoUrl={entry.photo_url} size={32} />
                <input
                  className="reg-modal-input reg-auth-name"
                  value={entry.name}
                  onChange={(e) => updateEntry(idx, { name: e.target.value })}
                  placeholder={isBlocked ? "Person name" : "Guardian name"}
                />
                {/* Photo button — authorized only */}
                {!isBlocked && (
                  <div className="reg-photo-btn-wrap">
                    <button
                      type="button"
                      className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === photoKey ? " uploading" : ""}`}
                      onClick={() => !uploadingPhoto && openPhotoMenu(photoKey, "auth", idx)}
                      disabled={!!uploadingPhoto}
                    >
                      {uploadingPhoto === photoKey ? "..." : entry.photo_url ? "Photo" : "Add Photo"}
                    </button>
                    {photoMenuOpen === photoKey && (
                      <div className="reg-photo-popover">
                        <button type="button" className="reg-photo-popover-option" onClick={() => handlePhotoOption("camera")}><FaCamera style={{ fontSize: 13 }} /> Take Photo</button>
                        <button type="button" className="reg-photo-popover-option" onClick={() => handlePhotoOption("gallery")}><FaImage style={{ fontSize: 13 }} /> Choose from Library</button>
                      </div>
                    )}
                  </div>
                )}
                {/* Block button — authorized only */}
                {!isBlocked && (
                  <button type="button" className="reg-btn reg-btn-icon-danger" title="Block this guardian" onClick={() => blockEntry(idx)}>
                    <FaExclamationTriangle style={{ fontSize: 10 }} />
                  </button>
                )}
                <button type="button" className="reg-btn reg-btn-icon-delete" title={isBlocked ? "Remove from blocked list" : "Remove guardian"} onClick={() => removeEntry(idx)}>
                  <FaTimes style={{ fontSize: 10 }} />
                </button>
              </div>
              <div className="reg-auth-vehicle">
                <input className="reg-modal-input reg-auth-plate" value={entry.plate_number} onChange={(e) => updateEntry(idx, { plate_number: e.target.value.toUpperCase() })} placeholder="Plate #" />
                <input className="reg-modal-input" value={entry.vehicle_make} onChange={(e) => updateEntry(idx, { vehicle_make: e.target.value })} placeholder="Make" />
                <input className="reg-modal-input" value={entry.vehicle_model} onChange={(e) => updateEntry(idx, { vehicle_model: e.target.value })} placeholder="Model" />
                <input className="reg-modal-input" value={entry.vehicle_color} onChange={(e) => updateEntry(idx, { vehicle_color: e.target.value })} placeholder="Color" />
              </div>
              {isBlocked && (
                <input className="reg-modal-input reg-blocked-reason" value={entry.reason || ""} onChange={(e) => updateEntry(idx, { reason: e.target.value })} placeholder="Reason (e.g., custody revoked)" />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
