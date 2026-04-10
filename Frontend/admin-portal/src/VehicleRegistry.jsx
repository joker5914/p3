import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FaSearch, FaTrashAlt, FaExclamationTriangle, FaPencilAlt, FaPlus, FaTimes, FaCamera, FaImage } from "react-icons/fa";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import { formatDate } from "./utils";
import { processProfilePhoto } from "./imageUtils";
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
  const [photoMenuOpen, setPhotoMenuOpen] = useState(null);  // key of open popover
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const photoMenuContext = useRef(null); // { type, index } for current photo action
  const videoRef = useRef(null);
  const streamRef = useRef(null);

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
      const vehiclesText = (p.vehicles || [])
        .map((v) => [v.plate_number, v.make, v.model, v.color].filter(Boolean).join(" "))
        .join(" ")
        .toLowerCase();
      const vehicle  = [p.vehicle_make, p.vehicle_model, p.vehicle_color].filter(Boolean).join(" ").toLowerCase();
      const plate    = (p.plate_display || "").toLowerCase();
      const authNames = (p.authorized_guardians || []).map((a) => a.name).join(", ").toLowerCase();
      return (
        (p.parent || "").toLowerCase().includes(sl) ||
        students.includes(sl) ||
        vehicle.includes(sl) ||
        vehiclesText.includes(sl) ||
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
    // Build vehicles array from API data
    const vehicles = (plate.vehicles && plate.vehicles.length > 0)
      ? plate.vehicles.map((v) => ({
          plate_number: v.plate_number || "",
          make: v.make || "",
          model: v.model || "",
          color: v.color || "",
        }))
      : [{
          plate_number: plate.plate_display || "",
          make: plate.vehicle_make || "",
          model: plate.vehicle_model || "",
          color: plate.vehicle_color || "",
        }];
    setEditForm({
      guardian_name:      plate.parent || "",
      students:           (plate.students || []).join(", "),
      vehicles,
      guardian_photo_url: plate.guardian_photo_url || null,
      student_photo_urls: plate.student_photo_urls || [],
      authorized_guardians: (plate.authorized_guardians || []).map((ag) => ({
        name: ag.name || "",
        photo_url: ag.photo_url || null,
        plate_number: ag.plate_number || "",
        vehicle_make: ag.vehicle_make || "",
        vehicle_model: ag.vehicle_model || "",
        vehicle_color: ag.vehicle_color || "",
      })),
      blocked_guardians: (plate.blocked_guardians || []).map((bg) => ({
        name: bg.name || "",
        photo_url: bg.photo_url || null,
        plate_number: bg.plate_number || "",
        vehicle_make: bg.vehicle_make || "",
        vehicle_model: bg.vehicle_model || "",
        vehicle_color: bg.vehicle_color || "",
        reason: bg.reason || "",
      })),
    });
    setEditError("");
    setPhotoMenuOpen(null);
  }

  async function handlePhotoUpload(file, type, index = null) {
    const key = type === "guardian" ? "guardian"
      : type === "student" ? `student_${index}`
      : `auth_${index}`;
    setUploadingPhoto(key);
    setPhotoMenuOpen(null);
    try {
      // Process image: auto-rotate, face-detect, crop to square
      const processed = await processProfilePhoto(file);
      const bucket = schoolId || "default";
      const path = `photos/${bucket}/${editingPlate.plate_token}/${key}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, processed);
      const url = await getDownloadURL(storageRef);
      if (type === "guardian") {
        setEditForm((f) => ({ ...f, guardian_photo_url: url }));
      } else if (type === "student") {
        setEditForm((f) => {
          const urls = [...(f.student_photo_urls || [])];
          urls[index] = url;
          return { ...f, student_photo_urls: urls };
        });
      } else if (type === "auth") {
        setEditForm((f) => {
          const list = [...(f.authorized_guardians || [])];
          list[index] = { ...list[index], photo_url: url };
          return { ...f, authorized_guardians: list };
        });
      }
    } catch (err) {
      setEditError("Photo upload failed: " + (err.message || "unknown error"));
    } finally {
      setUploadingPhoto(null);
    }
  }

  function openPhotoMenu(key, type, index) {
    photoMenuContext.current = { type, index };
    setPhotoMenuOpen((prev) => (prev === key ? null : key));
  }

  async function openCamera() {
    setCameraOpen(true);
    setPhotoMenuOpen(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      setCameraOpen(false);
      setEditError("Could not access camera: " + (err.message || "permission denied"));
    }
  }

  function closeCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx2d = canvas.getContext("2d");
    // Mirror horizontally to match the preview
    ctx2d.translate(canvas.width, 0);
    ctx2d.scale(-1, 1);
    ctx2d.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        const ctx = photoMenuContext.current;
        if (ctx) handlePhotoUpload(blob, ctx.type, ctx.index);
      }
      closeCamera();
    }, "image/jpeg", 0.92);
  }

  function handlePhotoOption(mode) {
    const ctx = photoMenuContext.current;
    if (!ctx) return;
    if (mode === "camera") {
      // On mobile, use native file input with capture; on desktop, use getUserMedia
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobile && cameraInputRef.current) {
        cameraInputRef.current.onchange = (e) => {
          if (e.target.files[0]) handlePhotoUpload(e.target.files[0], ctx.type, ctx.index);
          e.target.value = "";
        };
        cameraInputRef.current.click();
      } else {
        openCamera();
      }
    } else if (mode === "gallery" && galleryInputRef.current) {
      galleryInputRef.current.onchange = (e) => {
        if (e.target.files[0]) handlePhotoUpload(e.target.files[0], ctx.type, ctx.index);
        e.target.value = "";
      };
      galleryInputRef.current.click();
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

      const vehicles = (editForm.vehicles || []).map((v) => ({
        plate_number: v.plate_number || null,
        make: v.make || null,
        model: v.model || null,
        color: v.color || null,
      }));

      // Primary plate number comes from the first vehicle
      const primaryPlate = vehicles.length > 0 ? vehicles[0].plate_number : null;

      const authGuardians = (editForm.authorized_guardians || [])
        .filter((ag) => ag.name.trim())
        .map((ag) => ({
          name: ag.name.trim(),
          photo_url: ag.photo_url,
          plate_number: ag.plate_number || null,
          vehicle_make: ag.vehicle_make || null,
          vehicle_model: ag.vehicle_model || null,
          vehicle_color: ag.vehicle_color || null,
        }));

      const blockedGuardians = (editForm.blocked_guardians || [])
        .filter((bg) => bg.name.trim())
        .map((bg) => ({
          name: bg.name.trim(),
          photo_url: bg.photo_url,
          plate_number: bg.plate_number || null,
          vehicle_make: bg.vehicle_make || null,
          vehicle_model: bg.vehicle_model || null,
          vehicle_color: bg.vehicle_color || null,
          reason: bg.reason || null,
        }));

      const res = await createApiClient(token, schoolId).patch(
        `/api/v1/plates/${encodeURIComponent(editingPlate.plate_token)}`,
        {
          plate_number:       primaryPlate || undefined,
          guardian_name:      editForm.guardian_name,
          student_names:      studentNames,
          vehicles,
          guardian_photo_url: editForm.guardian_photo_url,
          student_photo_urls: editForm.student_photo_urls,
          authorized_guardians: authGuardians,
          blocked_guardians: blockedGuardians,
        }
      );

      const newToken = res.data.plate_token;
      const rekeyed = res.data.rekeyed;

      const firstVehicle = vehicles[0] || {};
      const updatedFields = {
        plate_display:      primaryPlate,
        parent:             editForm.guardian_name,
        students:           studentNames,
        vehicle_make:       firstVehicle.make,
        vehicle_model:      firstVehicle.model,
        vehicle_color:      firstVehicle.color,
        vehicles,
        guardian_photo_url: editForm.guardian_photo_url,
        student_photo_urls: editForm.student_photo_urls,
        authorized_guardians: authGuardians,
        blocked_guardians: blockedGuardians,
      };
      setPlates((prev) => {
        if (rekeyed) {
          return prev.map((p) =>
            p.plate_token === editingPlate.plate_token
              ? { ...p, plate_token: newToken, ...updatedFields }
              : p
          );
        }
        return prev.map((p) =>
          p.plate_token === editingPlate.plate_token
            ? { ...p, ...updatedFields, plate_display: primaryPlate || p.plate_display }
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
    const vehicles = p.vehicles || [];
    if (vehicles.length > 1) {
      const first = [vehicles[0].color, vehicles[0].make, vehicles[0].model].filter(Boolean).join(" ");
      return first ? `${first} (+${vehicles.length - 1})` : `${vehicles.length} vehicles`;
    }
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
        <div className="reg-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setEditingPlate(null); }}>
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
              <div className="reg-modal-section-header">
                <label className="reg-modal-section-label">Vehicles</label>
                <button
                  type="button"
                  className="reg-btn reg-btn-ghost reg-btn-sm"
                  onClick={() =>
                    setEditForm((f) => ({
                      ...f,
                      vehicles: [...(f.vehicles || []), { plate_number: "", make: "", model: "", color: "" }],
                    }))
                  }
                >
                  <FaPlus style={{ fontSize: 10 }} /> Add Vehicle
                </button>
              </div>
              {(editForm.vehicles || []).map((veh, vIdx) => (
                <div key={vIdx} className="reg-vehicle-entry">
                  {(editForm.vehicles || []).length > 1 && (
                    <div className="reg-vehicle-entry-header">
                      <span className="reg-vehicle-entry-label">Vehicle {vIdx + 1}</span>
                      <button
                        type="button"
                        className="reg-btn reg-btn-icon-delete"
                        title="Remove vehicle"
                        onClick={() =>
                          setEditForm((f) => ({
                            ...f,
                            vehicles: (f.vehicles || []).filter((_, i) => i !== vIdx),
                          }))
                        }
                      >
                        <FaTimes style={{ fontSize: 10 }} />
                      </button>
                    </div>
                  )}
                  <div className="reg-modal-field">
                    <label className="reg-modal-label">License Plate</label>
                    <input
                      className="reg-modal-input reg-plate-input"
                      value={veh.plate_number}
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase();
                        setEditForm((f) => {
                          const list = [...(f.vehicles || [])];
                          list[vIdx] = { ...list[vIdx], plate_number: val };
                          return { ...f, vehicles: list };
                        });
                      }}
                      placeholder="ABC 1234"
                    />
                  </div>
                  <div className="reg-modal-row">
                    <div className="reg-modal-field">
                      <label className="reg-modal-label">Make</label>
                      <input
                        className="reg-modal-input"
                        value={veh.make}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.vehicles || [])];
                            list[vIdx] = { ...list[vIdx], make: val };
                            return { ...f, vehicles: list };
                          });
                        }}
                        placeholder="Honda"
                      />
                    </div>
                    <div className="reg-modal-field">
                      <label className="reg-modal-label">Model</label>
                      <input
                        className="reg-modal-input"
                        value={veh.model}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.vehicles || [])];
                            list[vIdx] = { ...list[vIdx], model: val };
                            return { ...f, vehicles: list };
                          });
                        }}
                        placeholder="Accord"
                      />
                    </div>
                    <div className="reg-modal-field">
                      <label className="reg-modal-label">Color</label>
                      <input
                        className="reg-modal-input"
                        value={veh.color}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.vehicles || [])];
                            list[vIdx] = { ...list[vIdx], color: val };
                            return { ...f, vehicles: list };
                          });
                        }}
                        placeholder="Silver"
                      />
                    </div>
                  </div>
                </div>
              ))}
              {/* ── Photos ── */}
              {(() => {
                const studentNames = editForm.students
                  ? editForm.students.split(",").map((s) => s.trim()).filter(Boolean)
                  : [];

                const renderPhotoButton = (key, type, index, hasPhoto) => (
                  <div className="reg-photo-btn-wrap">
                    <button
                      type="button"
                      className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === key ? " uploading" : ""}`}
                      onClick={() => !uploadingPhoto && openPhotoMenu(key, type, index)}
                      disabled={!!uploadingPhoto}
                    >
                      {uploadingPhoto === key ? "Uploading…" : hasPhoto ? "Change" : "Add Photo"}
                    </button>
                    {photoMenuOpen === key && (
                      <div className="reg-photo-popover">
                        <button
                          type="button"
                          className="reg-photo-popover-option"
                          onClick={() => handlePhotoOption("camera")}
                        >
                          <FaCamera style={{ fontSize: 13 }} /> Take Photo
                        </button>
                        <button
                          type="button"
                          className="reg-photo-popover-option"
                          onClick={() => handlePhotoOption("gallery")}
                        >
                          <FaImage style={{ fontSize: 13 }} /> Choose from Library
                        </button>
                      </div>
                    )}
                  </div>
                );

                return (
                  <div className="reg-modal-field">
                    <label className="reg-modal-label">Photos <span className="reg-modal-hint">(optional)</span></label>

                    {/* Hidden file inputs for camera and gallery */}
                    <input ref={cameraInputRef} type="file" accept="image/*" capture="user" hidden />
                    <input ref={galleryInputRef} type="file" accept="image/*" hidden />

                    {/* Guardian photo */}
                    <div className="reg-photo-row">
                      <PersonAvatar
                        name={editForm.guardian_name}
                        photoUrl={editForm.guardian_photo_url}
                        size={36}
                      />
                      <span className="reg-photo-name">{editForm.guardian_name || "Guardian"}</span>
                      {renderPhotoButton("guardian", "guardian", null, editForm.guardian_photo_url)}
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
                        {renderPhotoButton(`student_${i}`, "student", i, (editForm.student_photo_urls || [])[i])}
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
                        authorized_guardians: [...(f.authorized_guardians || []), { name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "" }],
                      }))
                    }
                  >
                    <FaPlus style={{ fontSize: 10 }} /> Add
                  </button>
                </div>
                <p className="reg-modal-hint-block">
                  Additional people authorized to pick up these students. Add their vehicle info so the system recognizes them on arrival.
                </p>
                {(editForm.authorized_guardians || []).length === 0 && (
                  <p className="reg-auth-empty">No additional guardians added.</p>
                )}
                {(editForm.authorized_guardians || []).map((ag, idx) => (
                  <div key={idx} className="reg-auth-entry">
                    <div className="reg-auth-row">
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
                      <div className="reg-photo-btn-wrap">
                        <button
                          type="button"
                          className={`reg-btn reg-btn-ghost reg-photo-btn${uploadingPhoto === `auth_${idx}` ? " uploading" : ""}`}
                          onClick={() => !uploadingPhoto && openPhotoMenu(`auth_${idx}`, "auth", idx)}
                          disabled={!!uploadingPhoto}
                        >
                          {uploadingPhoto === `auth_${idx}` ? "..." : ag.photo_url ? "Photo" : "Add Photo"}
                        </button>
                        {photoMenuOpen === `auth_${idx}` && (
                          <div className="reg-photo-popover">
                            <button type="button" className="reg-photo-popover-option" onClick={() => handlePhotoOption("camera")}>
                              <FaCamera style={{ fontSize: 13 }} /> Take Photo
                            </button>
                            <button type="button" className="reg-photo-popover-option" onClick={() => handlePhotoOption("gallery")}>
                              <FaImage style={{ fontSize: 13 }} /> Choose from Library
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="reg-btn reg-btn-icon-danger"
                        title="Block this guardian"
                        onClick={() => {
                          const blocked = ag.name.trim() ? { ...ag } : null;
                          setEditForm((f) => ({
                            ...f,
                            authorized_guardians: (f.authorized_guardians || []).filter((_, i) => i !== idx),
                            ...(blocked ? { blocked_guardians: [...(f.blocked_guardians || []), { ...blocked, reason: "" }] } : {}),
                          }));
                        }}
                      >
                        <FaExclamationTriangle style={{ fontSize: 10 }} />
                      </button>
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
                    <div className="reg-auth-vehicle">
                      <input
                        className="reg-modal-input reg-auth-plate"
                        value={ag.plate_number}
                        onChange={(e) => {
                          const val = e.target.value.toUpperCase();
                          setEditForm((f) => {
                            const list = [...(f.authorized_guardians || [])];
                            list[idx] = { ...list[idx], plate_number: val };
                            return { ...f, authorized_guardians: list };
                          });
                        }}
                        placeholder="Plate #"
                      />
                      <input
                        className="reg-modal-input"
                        value={ag.vehicle_make}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.authorized_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_make: val };
                            return { ...f, authorized_guardians: list };
                          });
                        }}
                        placeholder="Make"
                      />
                      <input
                        className="reg-modal-input"
                        value={ag.vehicle_model}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.authorized_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_model: val };
                            return { ...f, authorized_guardians: list };
                          });
                        }}
                        placeholder="Model"
                      />
                      <input
                        className="reg-modal-input"
                        value={ag.vehicle_color}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.authorized_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_color: val };
                            return { ...f, authorized_guardians: list };
                          });
                        }}
                        placeholder="Color"
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Blocked Guardians ── */}
              <div className="reg-modal-divider" />
              <div className="reg-modal-field">
                <div className="reg-modal-section-header">
                  <label className="reg-modal-section-label reg-section-danger">Blocked Guardians</label>
                  <button
                    type="button"
                    className="reg-btn reg-btn-ghost reg-btn-sm"
                    onClick={() =>
                      setEditForm((f) => ({
                        ...f,
                        blocked_guardians: [...(f.blocked_guardians || []), { name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "", reason: "" }],
                      }))
                    }
                  >
                    <FaPlus style={{ fontSize: 10 }} /> Add
                  </button>
                </div>
                <p className="reg-modal-hint-block">
                  People NOT authorized to pick up these students. If their vehicle is scanned, admins will see an alert.
                </p>
                {(editForm.blocked_guardians || []).length === 0 && (
                  <p className="reg-auth-empty">No blocked guardians.</p>
                )}
                {(editForm.blocked_guardians || []).map((bg, idx) => (
                  <div key={idx} className="reg-auth-entry reg-blocked-entry">
                    <div className="reg-auth-row">
                      <PersonAvatar name={bg.name} photoUrl={bg.photo_url} size={32} />
                      <input
                        className="reg-modal-input reg-auth-name"
                        value={bg.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.blocked_guardians || [])];
                            list[idx] = { ...list[idx], name: val };
                            return { ...f, blocked_guardians: list };
                          });
                        }}
                        placeholder="Person name"
                      />
                      <button
                        type="button"
                        className="reg-btn reg-btn-icon-delete"
                        title="Remove from blocked list"
                        onClick={() =>
                          setEditForm((f) => ({
                            ...f,
                            blocked_guardians: (f.blocked_guardians || []).filter((_, i) => i !== idx),
                          }))
                        }
                      >
                        <FaTimes style={{ fontSize: 10 }} />
                      </button>
                    </div>
                    <div className="reg-auth-vehicle">
                      <input
                        className="reg-modal-input reg-auth-plate"
                        value={bg.plate_number}
                        onChange={(e) => {
                          const val = e.target.value.toUpperCase();
                          setEditForm((f) => {
                            const list = [...(f.blocked_guardians || [])];
                            list[idx] = { ...list[idx], plate_number: val };
                            return { ...f, blocked_guardians: list };
                          });
                        }}
                        placeholder="Plate #"
                      />
                      <input
                        className="reg-modal-input"
                        value={bg.vehicle_make}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.blocked_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_make: val };
                            return { ...f, blocked_guardians: list };
                          });
                        }}
                        placeholder="Make"
                      />
                      <input
                        className="reg-modal-input"
                        value={bg.vehicle_model}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.blocked_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_model: val };
                            return { ...f, blocked_guardians: list };
                          });
                        }}
                        placeholder="Model"
                      />
                      <input
                        className="reg-modal-input"
                        value={bg.vehicle_color}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditForm((f) => {
                            const list = [...(f.blocked_guardians || [])];
                            list[idx] = { ...list[idx], vehicle_color: val };
                            return { ...f, blocked_guardians: list };
                          });
                        }}
                        placeholder="Color"
                      />
                    </div>
                    <input
                      className="reg-modal-input reg-blocked-reason"
                      value={bg.reason}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditForm((f) => {
                          const list = [...(f.blocked_guardians || [])];
                          list[idx] = { ...list[idx], reason: val };
                          return { ...f, blocked_guardians: list };
                        });
                      }}
                      placeholder="Reason (e.g., custody revoked)"
                    />
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

      {/* Camera capture modal */}
      {cameraOpen && (
        <div className="reg-camera-overlay" onClick={closeCamera}>
          <div className="reg-camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="reg-camera-header">
              <h3 className="reg-modal-title">Take Photo</h3>
              <button type="button" className="reg-modal-close" onClick={closeCamera}>&times;</button>
            </div>
            <div className="reg-camera-body">
              <video
                ref={(el) => {
                  videoRef.current = el;
                  if (el && streamRef.current) el.srcObject = streamRef.current;
                }}
                autoPlay
                playsInline
                muted
                className="reg-camera-video"
              />
            </div>
            <div className="reg-camera-actions">
              <button type="button" className="reg-btn reg-btn-ghost" onClick={closeCamera}>Cancel</button>
              <button type="button" className="reg-btn reg-btn-primary" onClick={capturePhoto}>
                <FaCamera style={{ marginRight: 6 }} /> Capture
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
