import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FaClock } from "react-icons/fa";
import { I } from "./components/icons";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import { formatDate , formatApiError } from "./utils";
import { processProfilePhoto } from "./imageUtils";
import PersonAvatar from "./PersonAvatar";
import DuplicateDetector from "./DuplicateDetector";
import ConfirmDialog from "./ConfirmDialog";
import "./VehicleRegistry.css";

// Stable client-side id for editable list rows. Used as React `key` for
// vehicles / authorized_guardians / blocked_guardians so deleting a row
// doesn't cause the remaining controlled inputs to shift their state.
const newUid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `uid_${Math.random().toString(36).slice(2)}_${Date.now()}`);

export default function VehicleRegistry({
  token,
  currentUser,
  schoolId = null,
  initialSearch = null,
}) {
  const isAdmin = currentUser?.role === "school_admin" || currentUser?.role === "super_admin";
  const [tab, setTab] = useState("registry");
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

  // Student linking state
  const [allStudents, setAllStudents] = useState([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentSearch, setStudentSearch] = useState("");
  const [studentDropdownOpen, setStudentDropdownOpen] = useState(false);
  const studentSearchRef = useRef(null);
  const studentDropdownRef = useRef(null);

  const fetchPlates = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token, schoolId)
      .get("/api/v1/plates")
      .then((res) => setPlates(res.data.plates || []))
      .catch((err) => setError(formatApiError(err, "Failed to load registry.")))
      .finally(() => setLoading(false));
  }, [token, schoolId]);

  useEffect(() => { fetchPlates(); }, [fetchPlates]);

  // Seed local search from the global ⌘K palette.  Switch to the
  // registry tab as well so the search visibly affects what the user
  // sees — without that, a search seeded while the page was last on
  // the import tab would silently filter a hidden table.
  useEffect(() => {
    if (initialSearch?.search != null) {
      setSearch(initialSearch.search);
      setTab("registry");
    }
  }, [initialSearch?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch students for linking when edit modal opens
  const fetchStudents = useCallback(() => {
    if (!isAdmin) return;
    setStudentsLoading(true);
    createApiClient(token, schoolId)
      .get("/api/v1/admin/students")
      .then((res) => setAllStudents(res.data.students || []))
      .catch(() => {})
      .finally(() => setStudentsLoading(false));
  }, [token, schoolId, isAdmin]);

  // Close student dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (
        studentDropdownRef.current && !studentDropdownRef.current.contains(e.target) &&
        studentSearchRef.current && !studentSearchRef.current.contains(e.target)
      ) {
        setStudentDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
  // confirmId still tracks which row is being confirmed (drives the
  // ConfirmDialog open state).  Actual delete now runs via
  // confirmDelete(); the previous in-row confirm/cancel buttons are
  // replaced by the shared <ConfirmDialog> mounted at the bottom of
  // the render so this destructive flow matches every other admin
  // table.  deleteError surfaces inside the modal so a failed delete
  // doesn't push the user back to the page-level error banner.
  const [deleteError, setDeleteError] = useState("");

  const confirmDelete = async () => {
    if (!confirmId) return;
    const plateToken = confirmId;
    setDeleting((prev) => new Set([...prev, plateToken]));
    setDeleteError("");
    try {
      await createApiClient(token, schoolId).delete(`/api/v1/plates/${encodeURIComponent(plateToken)}`);
      setPlates((prev) => prev.filter((p) => p.plate_token !== plateToken));
      setConfirmId(null);
    } catch (err) {
      setDeleteError(formatApiError(err, "Delete failed. Please try again."));
    } finally {
      setDeleting((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  const cancelDelete = () => {
    setConfirmId(null);
    setDeleteError("");
  };

  // ── Edit ──────────────────────────────────────────────
  function openEdit(plate) {
    setEditingPlate(plate);
    // Build vehicles array from API data
    const vehicles = (plate.vehicles && plate.vehicles.length > 0)
      ? plate.vehicles.map((v) => ({
          _uid: newUid(),
          plate_number: v.plate_number || "",
          make: v.make || "",
          model: v.model || "",
          color: v.color || "",
        }))
      : [{
          _uid: newUid(),
          plate_number: plate.plate_display || "",
          make: plate.vehicle_make || "",
          model: plate.vehicle_model || "",
          color: plate.vehicle_color || "",
        }];
    setEditForm({
      guardian_name:      plate.parent || "",
      linkedStudents:     (plate.linked_students || []).map((s) => ({
        id: s.id,
        first_name: s.first_name || "",
        last_name: s.last_name || "",
        photo_url: s.photo_url || null,
      })),
      legacyStudentNames: (!plate.linked_student_ids || plate.linked_student_ids.length === 0)
        ? (plate.students || [])
        : [],
      vehicles,
      guardian_photo_url: plate.guardian_photo_url || null,
      student_photo_urls: plate.student_photo_urls || [],
      authorized_guardians: (plate.authorized_guardians || []).map((ag) => ({
        _uid: newUid(),
        name: ag.name || "",
        photo_url: ag.photo_url || null,
        plate_number: ag.plate_number || "",
        vehicle_make: ag.vehicle_make || "",
        vehicle_model: ag.vehicle_model || "",
        vehicle_color: ag.vehicle_color || "",
      })),
      blocked_guardians: (plate.blocked_guardians || []).map((bg) => ({
        _uid: newUid(),
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
    setStudentSearch("");
    setStudentDropdownOpen(false);
    fetchStudents();
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
      const linkedStudentIds = (editForm.linkedStudents || []).map((s) => s.id);
      const studentNames = (editForm.linkedStudents || []).map(
        (s) => `${s.first_name} ${s.last_name}`.trim()
      );

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
          linked_student_ids: linkedStudentIds,
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
        linked_student_ids: linkedStudentIds,
        linked_students:    editForm.linkedStudents,
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
      setEditError(formatApiError(err, "Save failed. Please try again."));
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

  // Temp-vehicle helper (issue #80): days from today to YYYY-MM-DD,
  // negative if past.  Returns null when the input is empty or
  // unparseable so callers can short-circuit.
  const tempDaysUntil = (iso) => {
    if (!iso) return null;
    try {
      const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
      const target = new Date(y, m - 1, d);
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      return Math.round((target - now) / 86400000);
    } catch {
      return null;
    }
  };

  return (
    <div className="registry-container page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Activity · vehicle registry</span>
          <h1 className="page-title">Vehicle Registry</h1>
          <p className="page-sub">
            Authorized guardians, students, and the plates linked to them. Search, edit, and resolve duplicates.
          </p>
        </div>
        <div className="page-actions">
          {tab === "registry" && !loading && !error && (
            <span
              className="page-chip"
              aria-label={`${plates.length} registered plate${plates.length === 1 ? "" : "s"}`}
            >
              <I.car size={12} aria-hidden="true" />
              {plates.length.toLocaleString()} {plates.length === 1 ? "plate" : "plates"}
            </span>
          )}
        </div>
      </div>

      {/* Controls — UM pattern: pill tabs (left) + search (right) */}
      {isAdmin ? (
        <div className="registry-controls">
          <div className="registry-filter-bar">
            <button
              className={`registry-filter-tab${tab === "registry" ? " active" : ""}`}
              onClick={() => setTab("registry")}
            >
              Registry
              {!loading && <span className="registry-filter-badge">{plates.length}</span>}
            </button>
            <button
              className={`registry-filter-tab${tab === "duplicates" ? " active" : ""}`}
              onClick={() => setTab("duplicates")}
            >
              Duplicates
            </button>
          </div>
          {tab === "registry" && (
            <div className="reg-search-wrap">
              <I.search size={14} className="reg-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="reg-search"
                placeholder="Search guardian, student, or vehicle…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="registry-controls">
          <div className="reg-search-wrap reg-search-wrap-full">
            <I.search size={14} className="reg-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="reg-search"
              placeholder="Search guardian, student, or vehicle…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      {tab === "duplicates" && isAdmin && (
        <DuplicateDetector token={token} schoolId={schoolId} />
      )}

      {/* Registry tab content */}
      {tab === "registry" && <>
      {search && filtered.length !== plates.length && (
        <p className="reg-filter-count">Showing {filtered.length} of {plates.length}</p>
      )}

      {/* Error */}
      {error && (
        <div className="um-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="um-error-dismiss"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {loading && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading registry…</p>
        </div>
      )}

      {!loading && !error && plates.length === 0 && (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.car size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">No plates registered yet</p>
          <p className="page-empty-sub">
            Use <strong>Integrations → Data Import</strong> to add them.
          </p>
        </div>
      )}

      {!loading && !error && plates.length > 0 && filtered.length === 0 && (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.search size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">No records match your search</p>
          <p className="page-empty-sub">
            Try a different guardian, student, or vehicle term — or clear the search to see the full registry.
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="reg-table-wrap accent-bar">
          <table className="reg-table">
            <thead>
              <tr>
                <th scope="col">Guardian</th>
                <th scope="col">Student(s)</th>
                <th scope="col">Plate</th>
                <th scope="col">Vehicle</th>
                <th scope="col">Registered</th>
                {isAdmin && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isConfirm  = confirmId === p.plate_token;
                const isDeleting = deleting.has(p.plate_token);
                const authGuardians = p.authorized_guardians || [];

                return (
                  <tr key={p.plate_token} className={`reg-row ${isConfirm ? "reg-row-confirm" : ""}`}>
                    <td data-label="Guardian" className="reg-td-primary">
                      <div>{p.parent || "—"}</div>
                      {authGuardians.length > 0 && (
                        <div className="reg-auth-badge" title={authGuardians.map((a) => a.name).join(", ")}>
                          +{authGuardians.length} authorized
                        </div>
                      )}
                    </td>
                    <td data-label="Students">{(p.students || []).join(", ") || "—"}</td>
                    <td data-label="Plate" className="reg-td-plate">
                      {p.plate_display || "—"}
                      {p.vehicle_type === "temporary" && (() => {
                        const days = tempDaysUntil(p.valid_until);
                        const cls =
                          days === null ? "reg-temp-badge"
                          : days < 0 ? "reg-temp-badge reg-temp-badge-expired"
                          : days <= 3 ? "reg-temp-badge reg-temp-badge-soon"
                          : "reg-temp-badge";
                        const tip = p.valid_until
                          ? `Auto-expires ${p.valid_until}${p.temporary_reason ? ` — ${p.temporary_reason}` : ""}`
                          : "Temporary vehicle";
                        return (
                          <span className={cls} title={tip}>
                            <FaClock style={{ marginRight: 3, fontSize: 9 }} />
                            TEMP
                            {days !== null && days >= 0 && <span className="reg-temp-days"> · {days}d</span>}
                            {days !== null && days < 0 && <span className="reg-temp-days"> · expired</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td data-label="Vehicle" className="reg-td-secondary">{vehicleLabel(p)}</td>
                    <td data-label="Registered" className="reg-td-secondary">{formatDate(p.imported_at)}</td>
                    {isAdmin && (
                      <td data-label="Actions" className="reg-td-actions">
                        {/* Action buttons stay visible while confirmation
                            is in flight; the shared <ConfirmDialog>
                            below handles the destructive prompt.  The
                            `reg-row-confirm` class on the data row above
                            still applies a subtle row tint while the
                            modal is open as a visual cue for which row
                            is being confirmed. */}
                        <div className="reg-action-row">
                          <button
                            className="reg-btn reg-btn-edit"
                            onClick={() => openEdit(p)}
                            title="Edit record"
                            aria-label="Edit record"
                          >
                            <I.edit size={12} aria-hidden="true" /> <span className="btn-text">Edit</span>
                          </button>
                          <button
                            className="reg-btn reg-btn-delete"
                            onClick={() => { setConfirmId(p.plate_token); setDeleteError(""); }}
                            disabled={isDeleting}
                            title="Remove from registry"
                            aria-label="Remove from registry"
                          >
                            <I.trash size={12} aria-hidden="true" /> <span className="btn-text">Delete</span>
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>}

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
                <label className="reg-modal-label">Linked Students</label>
                {/* Legacy names notice */}
                {(editForm.legacyStudentNames || []).length > 0 && (editForm.linkedStudents || []).length === 0 && (
                  <p className="reg-modal-hint-block reg-legacy-notice">
                    Previously entered: {editForm.legacyStudentNames.join(", ")}. Use the search below to link actual student records.
                  </p>
                )}
                {/* Linked student chips */}
                {(editForm.linkedStudents || []).length > 0 && (
                  <div className="reg-student-chips">
                    {editForm.linkedStudents.map((s) => (
                      <span key={s.id} className="reg-student-chip">
                        {s.first_name} {s.last_name}
                        <button
                          type="button"
                          className="reg-student-chip-remove"
                          onClick={() =>
                            setEditForm((f) => ({
                              ...f,
                              linkedStudents: (f.linkedStudents || []).filter((ls) => ls.id !== s.id),
                            }))
                          }
                          title="Unlink student"
                        >
                          <I.x size={10} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {/* Student search input */}
                <div className="reg-student-search-wrap">
                  <input
                    ref={studentSearchRef}
                    className="reg-modal-input"
                    value={studentSearch}
                    onChange={(e) => {
                      setStudentSearch(e.target.value);
                      setStudentDropdownOpen(true);
                    }}
                    onFocus={() => setStudentDropdownOpen(true)}
                    placeholder={studentsLoading ? "Loading students…" : "Search students to link…"}
                    disabled={studentsLoading}
                  />
                  {studentDropdownOpen && studentSearch.trim() && (
                    <div className="reg-student-dropdown" ref={studentDropdownRef}>
                      {(() => {
                        const linkedIds = new Set((editForm.linkedStudents || []).map((s) => s.id));
                        const q = studentSearch.trim().toLowerCase();
                        const matches = allStudents.filter((s) => {
                          if (linkedIds.has(s.id)) return false;
                          const fullName = `${s.first_name} ${s.last_name}`.toLowerCase();
                          return fullName.includes(q);
                        }).slice(0, 8);
                        if (matches.length === 0) {
                          return <div className="reg-student-dropdown-empty">No matching students found</div>;
                        }
                        return matches.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="reg-student-dropdown-item"
                            onClick={() => {
                              setEditForm((f) => ({
                                ...f,
                                linkedStudents: [
                                  ...(f.linkedStudents || []),
                                  { id: s.id, first_name: s.first_name, last_name: s.last_name, photo_url: s.photo_url },
                                ],
                                legacyStudentNames: [],
                              }));
                              setStudentSearch("");
                              setStudentDropdownOpen(false);
                            }}
                          >
                            <span className="reg-student-dropdown-name">{s.first_name} {s.last_name}</span>
                            {s.grade && <span className="reg-student-dropdown-grade">Grade {s.grade}</span>}
                            {s.guardian && <span className="reg-student-dropdown-guardian">{s.guardian.display_name}</span>}
                          </button>
                        ));
                      })()}
                    </div>
                  )}
                </div>
                {(editForm.linkedStudents || []).length === 0 && (editForm.legacyStudentNames || []).length === 0 && (
                  <p className="reg-auth-empty">No students linked. Search above to link students.</p>
                )}
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
                      vehicles: [...(f.vehicles || []), { _uid: newUid(), plate_number: "", make: "", model: "", color: "" }],
                    }))
                  }
                >
                  <I.plus size={12} aria-hidden="true" /> Add Vehicle
                </button>
              </div>
              {(editForm.vehicles || []).map((veh, vIdx) => (
                <div key={veh._uid ?? vIdx} className="reg-vehicle-entry">
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
                        <I.x size={12} aria-hidden="true" />
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
                const studentNames = (editForm.linkedStudents || []).map(
                  (s) => `${s.first_name} ${s.last_name}`.trim()
                );

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
                          <I.camera size={14} aria-hidden="true" /> Take Photo
                        </button>
                        <button
                          type="button"
                          className="reg-photo-popover-option"
                          onClick={() => handlePhotoOption("gallery")}
                        >
                          <I.image size={14} aria-hidden="true" /> Choose from Library
                        </button>
                      </div>
                    )}
                  </div>
                );

                return (
                  <div className="reg-modal-field">
                    <label className="reg-modal-label">Photos <span className="reg-modal-hint">(optional)</span></label>

                    {/* Hidden file inputs for camera and gallery — triggered
                        programmatically by the Camera / Gallery buttons.  aria-label
                        is set so AT announces them correctly if focus ever lands
                        on them (e.g. via Tab while a picker is open). */}
                    <input
                      ref={cameraInputRef}
                      type="file"
                      accept="image/*"
                      capture="user"
                      hidden
                      aria-label="Take photo with camera"
                    />
                    <input
                      ref={galleryInputRef}
                      type="file"
                      accept="image/*"
                      hidden
                      aria-label="Choose photo from gallery"
                    />

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
                        authorized_guardians: [...(f.authorized_guardians || []), { _uid: newUid(), name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "" }],
                      }))
                    }
                  >
                    <I.plus size={12} aria-hidden="true" /> Add
                  </button>
                </div>
                <p className="reg-modal-hint-block">
                  Additional people authorized to pick up these students. Add their vehicle info so the system recognizes them on arrival.
                </p>
                {(editForm.authorized_guardians || []).length === 0 && (
                  <p className="reg-auth-empty">No additional guardians added.</p>
                )}
                {(editForm.authorized_guardians || []).map((ag, idx) => (
                  <div key={ag._uid ?? idx} className="reg-auth-entry">
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
                              <I.camera size={14} aria-hidden="true" /> Take Photo
                            </button>
                            <button type="button" className="reg-photo-popover-option" onClick={() => handlePhotoOption("gallery")}>
                              <I.image size={14} aria-hidden="true" /> Choose from Library
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="reg-btn reg-btn-icon-danger"
                        title="Block this guardian"
                        onClick={() => {
                          const blocked = ag.name.trim() ? { ...ag, _uid: newUid() } : null;
                          setEditForm((f) => ({
                            ...f,
                            authorized_guardians: (f.authorized_guardians || []).filter((_, i) => i !== idx),
                            ...(blocked ? { blocked_guardians: [...(f.blocked_guardians || []), { ...blocked, reason: "" }] } : {}),
                          }));
                        }}
                      >
                        <I.alert size={12} aria-hidden="true" />
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
                        <I.x size={12} aria-hidden="true" />
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
                        blocked_guardians: [...(f.blocked_guardians || []), { _uid: newUid(), name: "", photo_url: null, plate_number: "", vehicle_make: "", vehicle_model: "", vehicle_color: "", reason: "" }],
                      }))
                    }
                  >
                    <I.plus size={12} aria-hidden="true" /> Add
                  </button>
                </div>
                <p className="reg-modal-hint-block">
                  People NOT authorized to pick up these students. If their vehicle is scanned, admins will see an alert.
                </p>
                {(editForm.blocked_guardians || []).length === 0 && (
                  <p className="reg-auth-empty">No blocked guardians.</p>
                )}
                {(editForm.blocked_guardians || []).map((bg, idx) => (
                  <div key={bg._uid ?? idx} className="reg-auth-entry reg-blocked-entry">
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
                        <I.x size={12} aria-hidden="true" />
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
                <I.camera size={14} aria-hidden="true" style={{ marginRight: 6 }} /> Capture
              </button>
            </div>
          </div>
        </div>
      )}

      {(() => {
        const target = plates.find((p) => p.plate_token === confirmId);
        return (
          <ConfirmDialog
            open={!!target}
            title="Remove from registry"
            prompt={target && (
              <>
                Remove the registry record for{" "}
                <strong>{target.parent || "this guardian"}</strong>
                {target.plate_display && <> ({target.plate_display})</>}?
              </>
            )}
            warning="The plate, vehicles, and authorized-pickup metadata for this record are deleted from the registry. Linked students stay; their records can be re-associated with a new registry entry later."
            destructive
            confirmLabel="Remove"
            busyLabel="Removing…"
            busy={!!confirmId && deleting.has(confirmId)}
            error={deleteError}
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
          />
        );
      })()}
    </div>
  );
}
