import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaSearch, FaTrashAlt, FaExclamationTriangle, FaPencilAlt, FaPlus, FaTimes } from "react-icons/fa";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import { formatDate } from "./utils";
import PersonAvatar from "./PersonAvatar";
import "./VehicleRegistry.css";

export default function VehicleRegistry({ token, currentUser, schoolId = null }) {
  const isAdmin = currentUser?.role === "school_admin" || currentUser?.role === "super_admin";
  const [plates,    setPlates]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");
  const [search,    setSearch]    = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [deleting,  setDeleting]  = useState(new Set());

  // Edit modal state
  const [editingPlate, setEditingPlate]   = useState(null);
  const [editForm, setEditForm]           = useState({});
  const [saving, setSaving]               = useState(false);
  const [editError, setEditError]         = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(null); // "guardian" | "student_N"

  const fetchPlates = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token, schoolId)
      .get("/api/v1/plates")
      .then((res) => setPlates(res.data.plates || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load registry."))
      .finally(() => setLoading(false));
  }, [token, schoolId]);

  useEffect(() => { fetchPlates(); }, [fetchPlates]);

  const filtered = useMemo(() => {
    const sl = search.trim().toLowerCase();
    if (!sl) return plates;
    return plates.filter((p) => {
      const students = (p.students || []).join(", ").toLowerCase();
      const vehicle  = [p.vehicle_make, p.vehicle_model, p.vehicle_color].filter(Boolean).join(" ").toLowerCase();
      const plate    = (p.plate_display || "").toLowerCase();
      const authNames = (p.authorized_guardians || []).map((a) => a.name).join(", ").toLowerCase();
      return (
        (p.parent || "").toLowerCase().includes(sl) ||
        students.includes(sl) ||
        vehicle.includes(sl) ||
        plate.includes(sl) ||
        authNames.includes(sl)
      );
    });
  }, [plates, search]);

  // ── Delete ────────────────────────────────────────────
  const handleDelete = async (plateToken) => {
    setDeleting((prev) => new Set([...prev, plateToken]));
    setConfirmId(null);
    try {
      await createApiClient(token, schoolId).delete(`/api/v1/plates/${encodeURIComponent(plateToken)}`);
      setPlates((prev) => prev.filter((p) => p.plate_token !== plateToken));
    } catch (err) {
      setError(err.response?.data?.detail || "Delete failed. Please try again.");
    } finally {
      setDeleting((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  // ── Edit ──────────────────────────────────────────────
  function openEdit(plate) {
    setEditingPlate(plate);
    setEditForm({
      plate_number:       plate.plate_display || "",
      guardian_name:      plate.parent || "",
      students:           (plate.students || []).join(", "),
      vehicle_make:       plate.vehicle_make || "",
      vehicle_model:      plate.vehicle_model || "",
      vehicle_color:      plate.vehicle_color || "",
      guardian_photo_url: plate.guardian_photo_url || null,
      student_photo_urls: plate.student_photo_urls || [],
      authorized_guardians: (plate.authorized_guardians || []).map((ag) => ({
        name: ag.name || "",
        photo_url: ag.photo_url || null,
      })),
    });
    setEditError("");
  }

  async function handlePhotoUpload(file, type, studentIndex = null) {
    const key = type === "guardian" ? "guardian" : `student_${studentIndex}`;
    setUploadingPhoto(key);
    try {
      const bucket = schoolId || "default";
      const path = `photos/${bucket}/${editingPlate.plate_token}/${key}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      if (type === "guardian") {
        setEditForm((f) => ({ ...f, guardian_photo_url: url }));
      } else {
        setEditForm((f) => {
          const urls = [...(f.student_photo_urls || [])];
          urls[studentIndex] = url;
          return { ...f, student_photo_urls: urls };
        });
      }
    } catch (err) {
      setEditError("Photo upload failed: " + (err.message || "unknown error"));
    } finally {
      setUploadingPhoto(null);
    }
  }

  async function handleEditSave(e) {
    e.preventDefault();
    setSaving(true);
    setEditError("");
    try {
      const studentNames = editForm.students
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const authGuardians = (editForm.authorized_guardians || [])
        .filter((ag) => ag.name.trim())
        .map((ag) => ({ name: ag.name.trim(), photo_url: ag.photo_url }));

      const res = await createApiClient(token, schoolId).patch(
        `/api/v1/plates/${encodeURIComponent(editingPlate.plate_token)}`,
        {
          plate_number:       editForm.plate_number || undefined,
          guardian_name:      editForm.guardian_name,
          student_names:      studentNames,
          vehicle_make:       editForm.vehicle_make,
          vehicle_model:      editForm.vehicle_model,
          vehicle_color:      editForm.vehicle_color,
          guardian_photo_url: editForm.guardian_photo_url,
          student_photo_urls: editForm.student_photo_urls,
          authorized_guardians: authGuardians,
        }
      );

      const newToken = res.data.plate_token;
      const rekeyed = res.data.rekeyed;

      setPlates((prev) => {
        if (rekeyed) {
          // Plate changed — replace old record with new token
          return prev.map((p) =>
            p.plate_token === editingPlate.plate_token
              ? {
                  ...p,
                  plate_token:        newToken,
                  plate_display:      editForm.plate_number,
                  parent:             editForm.guardian_name,
                  students:           studentNames,
                  vehicle_make:       editForm.vehicle_make,
                  vehicle_model:      editForm.vehicle_model,
                  vehicle_color:      editForm.vehicle_color,
                  guardian_photo_url: editForm.guardian_photo_url,
                  student_photo_urls: editForm.student_photo_urls,
                  authorized_guardians: authGuardians,
                }
              : p
          );
        }
        return prev.map((p) =>
          p.plate_token === editingPlate.plate_token
            ? {
                ...p,
                plate_display:      editForm.plate_number || p.plate_display,
                parent:             editForm.guardian_name,
                students:           studentNames,
                vehicle_make:       editForm.vehicle_make,
                vehicle_model:      editForm.vehicle_model,
                vehicle_color:      editForm.vehicle_color,
                guardian_photo_url: editForm.guardian_photo_url,
                student_photo_urls: editForm.student_photo_urls,
                authorized_guardians: authGuardians,
              }
            : p
        );
      });
      setEditingPlate(null);
    } catch (err) {
      setEditError(err.response?.data?.detail || "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const vehicleLabel = (p) => {
    const parts = [p.vehicle_color, p.vehicle_make, p.vehicle_model].filter(Boolean);
    return parts.length ? parts.join(" ") : "—";
  };

  return (
    <div className="registry-container">
      {/* Header */}
      <div className="registry-header">
        <div className="registry-title-row">
          <h2 className="registry-title">Vehicle Registry</h2>
          {!loading && !error && (
            <span className="registry-count">{plates.length.toLocaleString()} registered</span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="registry-search-bar">
        <div className="reg-search-wrap">
          <FaSearch className="reg-search-icon" />
          <input
            type="text"
            className="reg-search"
            placeholder="Search guardian, student, or vehicle…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="reg-clear-search" onClick={() => setSearch("")} title="Clear">×</button>}
        </div>
        {search && filtered.length !== plates.length && (
          <span className="reg-filter-count">{filtered.length} of {plates.length}</span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="reg-error">
          <FaExclamationTriangle style={{ flexShrink: 0 }} />
          {error}
          <button className="reg-btn reg-btn-ghost" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {loading && <div className="reg-state">Loading registry…</div>}

      {!loading && !error && plates.length === 0 && (
        <div className="reg-state">
          No plates registered yet. Use <strong>Integrations → Data Import</strong> to add them.
        </div>
      )}

      {!loading && !error && plates.length > 0 && filtered.length === 0 && (
        <div className="reg-state">No records match your search.</div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="reg-table-wrap">
          <table className="reg-table">
            <thead>
              <tr>
                <th>Guardian</th>
                <th>Student(s)</th>
                <th>Plate</th>
                <th>Vehicle</th>
                <th>Registered</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isConfirm  = confirmId === p.plate_token;
                const isDeleting = deleting.has(p.plate_token);
                const authGuardians = p.authorized_guardians || [];

                return (
                  <tr key={p.plate_token} className={isConfirm ? "reg-row-confirm" : ""}>
                    <td className="reg-td-primary">
                      <div>{p.parent || "—"}</div>
                      {authGuardians.length > 0 && (
                        <div className="reg-auth-badge" title={authGuardians.map((a) => a.name).join(", ")}>
                          +{authGuardians.length} authorized
                        </div>
                      )}
                    </td>
                    <td>{(p.students || []).join(", ") || "—"}</td>
                    <td className="reg-td-plate">{p.plate_display || "—"}</td>
                    <td className="reg-td-secondary">{vehicleLabel(p)}</td>
                    <td className="reg-td-secondary">{formatDate(p.imported_at)}</td>
                    {isAdmin && (
                      <td className="reg-td-actions">
                        {isConfirm ? (
                          <div className="reg-confirm-row">
                            <span className="reg-confirm-label">Remove this record?</span>
                            <button className="reg-btn reg-btn-danger" onClick={() => handleDelete(p.plate_token)} disabled={isDeleting}>
                              {isDeleting ? "Removing…" : "Confirm"}
                            </button>
                            <button className="reg-btn reg-btn-ghost" onClick={() => setConfirmId(null)}>Cancel</button>
                          </div>
                        ) : (
                          <div className="reg-action-row">
                            <button
                              className="reg-btn reg-btn-edit"
                              onClick={() => openEdit(p)}
                              title="Edit record"
                            >
                              <FaPencilAlt style={{ fontSize: 11 }} />
                            </button>
                            <button
                              className="reg-btn reg-btn-delete"
                              onClick={() => setConfirmId(p.plate_token)}
                              disabled={isDeleting}
                              title="Remove from registry"
                            >
                              <FaTrashAlt style={{ fontSize: 11 }} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit Modal */}
      {editingPlate && (
        <div className="reg-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditingPlate(null)}>
          <div className="reg-modal">
            <div className="reg-modal-header">
              <h2 className="reg-modal-title">Edit Record</h2>
              <button className="reg-modal-close" onClick={() => setEditingPlate(null)}>×</button>
            </div>
            <form className="reg-modal-form" onSubmit={handleEditSave}>
              <div className="reg-modal-field">
                <label className="reg-modal-label">Primary Guardian</label>
                <input
                  className="reg-modal-input"
                  value={editForm.guardian_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, guardian_name: e.target.value }))}
                  placeholder="Full name"
                />
              </div>
              <div className="reg-modal-field">
                <label className="reg-modal-label">Student(s) <span className="reg-modal-hint">(comma-separated)</span></label>
                <input
                  className="reg-modal-input"
                  value={editForm.students}
                  onChange={(e) => setEditForm((f) => ({ ...f, students: e.target.value }))}
                  placeholder="Alex Smith, Jordan Smith"
                />
              </div>
              <div className="reg-modal-divider" />
              <div className="reg-modal-section-label">Vehicle</div>
              <div className="reg-modal-field">
                <label className="reg-modal-label">License Plate</label>
                <input
                  className="reg-modal-input reg-plate-input"
                  value={editForm.plate_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))}
                  placeholder="ABC 1234"
                />
              </div>
              <div className="reg-modal-row">
                <div className="reg-modal-field">
                  <label className="reg-modal-label">Make</label>
                  <input className="reg-modal-input" value={editForm.vehicle_make} onChange={(e) => setEditForm((f) => ({ ...f, vehicle_make: e.target.value }))} placeholder="Honda" />
                </div>
                <div className="reg-modal-field">
                  <label className="reg-modal-label">Model</label>
                  <input className="reg-modal-input" value={editForm.vehicle_model} onChange={(e) => setEditForm((f) => ({ ...f, vehicle_model: e.target.value }))} placeholder="Accord" />
                </div>
                <div className="reg-modal-field">
                  <label className="reg-modal-label">Color</label>
                  <input className="reg-modal-input" value={editForm.vehicle_color} onChange={(e) => setEditForm((f) => ({ ...f, vehicle_color: e.target.value }))} placeholder="Silver" />
                </div>
              </div>
              {/* ── Photos ── */}
              {(() => {
                const studentNames = editForm.students
                  ? editForm.students.split(",").map((s) => s.trim()).filter(Boolean)
                  : [];
                return (
                  <div className="reg-modal-field">
                    <label className="reg-modal-label">Photos <span className="reg-modal-hint">(optional)</span></label>

                    {/* Guardian photo */}
                    <div className="reg-photo-row">
                      <PersonAvatar
                        name={editForm.guardian_name}
                        photoUrl={editForm.guardian_photo_url}
                        size={36}
                      />
                      <span className="reg-photo-name">{editForm.guardian_name || "Guardian"}</span>
                      <label className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === "guardian" ? " uploading" : ""}`}>
                        {uploadingPhoto === "guardian" ? "Uploading…" : editForm.guardian_photo_url ? "Change" : "Add Photo"}
                        <input
                          type="file"
                          accept="image/*"
                          hidden
                          onChange={(e) => e.target.files[0] && handlePhotoUpload(e.target.files[0], "guardian")}
                          disabled={!!uploadingPhoto}
                        />
                      </label>
                      {editForm.guardian_photo_url && (
                        <button
                          type="button"
                          className="reg-btn reg-btn-ghost"
                          onClick={() => setEditForm((f) => ({ ...f, guardian_photo_url: null }))}
                          disabled={!!uploadingPhoto}
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {/* Per-student photos */}
                    {studentNames.map((name, i) => (
                      <div key={i} className="reg-photo-row">
                        <PersonAvatar
                          name={name}
                          photoUrl={(editForm.student_photo_urls || [])[i] ?? null}
                          size={32}
                        />
                        <span className="reg-photo-name">{name}</span>
                        <label className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === `student_${i}` ? " uploading" : ""}`}>
                          {uploadingPhoto === `student_${i}` ? "Uploading…" : (editForm.student_photo_urls || [])[i] ? "Change" : "Add Photo"}
                          <input
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(e) => e.target.files[0] && handlePhotoUpload(e.target.files[0], "student", i)}
                            disabled={!!uploadingPhoto}
                          />
                        </label>
                        {(editForm.student_photo_urls || [])[i] && (
                          <button
                            type="button"
                            className="reg-btn reg-btn-ghost"
                            onClick={() => {
                              const urls = [...(editForm.student_photo_urls || [])];
                              urls[i] = null;
                              setEditForm((f) => ({ ...f, student_photo_urls: urls }));
                            }}
                            disabled={!!uploadingPhoto}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* ── Authorized Guardians ── */}
              <div className="reg-modal-divider" />
              <div className="reg-modal-field">
                <div className="reg-modal-section-header">
                  <label className="reg-modal-section-label">Authorized Guardians</label>
                  <button
                    type="button"
                    className="reg-btn reg-btn-ghost reg-btn-sm"
                    onClick={() =>
                      setEditForm((f) => ({
                        ...f,
                        authorized_guardians: [...(f.authorized_guardians || []), { name: "", photo_url: null }],
                      }))
                    }
                  >
                    <FaPlus style={{ fontSize: 10 }} /> Add
                  </button>
                </div>
                <p className="reg-modal-hint-block">
                  Additional people authorized to pick up these students.
                </p>
                {(editForm.authorized_guardians || []).length === 0 && (
                  <p className="reg-auth-empty">No additional guardians added.</p>
                )}
                {(editForm.authorized_guardians || []).map((ag, idx) => (
                  <div key={idx} className="reg-auth-row">
                    <PersonAvatar name={ag.name} photoUrl={ag.photo_url} size={32} />
                    <input
                      className="reg-modal-input reg-auth-name"
                      value={ag.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditForm((f) => {
                          const list = [...(f.authorized_guardians || [])];
                          list[idx] = { ...list[idx], name: val };
                          return { ...f, authorized_guardians: list };
                        });
                      }}
                      placeholder="Guardian name"
                    />
                    <label className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === `auth_${idx}` ? " uploading" : ""}`}>
                      {uploadingPhoto === `auth_${idx}` ? "..." : ag.photo_url ? "Photo" : "Add Photo"}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          if (!e.target.files[0]) return;
                          const file = e.target.files[0];
                          const key = `auth_${idx}`;
                          setUploadingPhoto(key);
                          const bucket = schoolId || "default";
                          const path = `photos/${bucket}/${editingPlate.plate_token}/auth_${idx}`;
                          const storageRef = ref(storage, path);
                          uploadBytes(storageRef, file)
                            .then(() => getDownloadURL(storageRef))
                            .then((url) => {
                              setEditForm((f) => {
                                const list = [...(f.authorized_guardians || [])];
                                list[idx] = { ...list[idx], photo_url: url };
                                return { ...f, authorized_guardians: list };
                              });
                            })
                            .catch(() => setEditError("Photo upload failed"))
                            .finally(() => setUploadingPhoto(null));
                        }}
                        disabled={!!uploadingPhoto}
                      />
                    </label>
                    <button
                      type="button"
                      className="reg-btn reg-btn-icon-delete"
                      title="Remove guardian"
                      onClick={() =>
                        setEditForm((f) => ({
                          ...f,
                          authorized_guardians: (f.authorized_guardians || []).filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      <FaTimes style={{ fontSize: 10 }} />
                    </button>
                  </div>
                ))}
              </div>

              {editError && <p className="reg-modal-error">{editError}</p>}
              <div className="reg-modal-actions">
                <button type="button" className="reg-btn reg-btn-ghost" onClick={() => setEditingPlate(null)}>Cancel</button>
                <button type="submit" className="reg-btn reg-btn-primary" disabled={saving}>
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
