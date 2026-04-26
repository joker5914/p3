import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import ConfirmDialog from "./ConfirmDialog";
import "./GuardianManagement.css";

const STATUS_FILTERS = [
  { key: "all",        label: "All"        },
  { key: "assigned",   label: "Assigned"   },
  { key: "unassigned", label: "Unassigned" },
];

export default function GuardianManagement({ token, schoolId = null, currentUser = null }) {
  // `schoolId` only carries a value for super_admins who have selected a
  // school in the platform view (it becomes the X-School-Id header). For a
  // regular school_admin the prop is null, but they still need their own
  // school_id to assign themselves to guardians — fall back to the uid
  // embedded in the /api/v1/me response.
  const effectiveSchoolId = schoolId || currentUser?.school_id || null;
  const role = currentUser?.role;
  const isSuperAdmin = role === "super_admin";
  const perms = currentUser?.permissions || {};
  // Edit gate mirrors the `can()` helper in LeftNav — super/district
  // admins always pass; school_admin and staff go through the
  // `guardians_edit` permission toggle.
  const canEdit = role === "super_admin" || role === "district_admin" || perms.guardians_edit === true;
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [guardians, setGuardians] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const searchTimerRef = useRef(null);

  // Assign school modal state
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignSchoolId, setAssignSchoolId] = useState("");
  const [availableSchools, setAvailableSchools] = useState([]);
  const [schoolsLoading, setSchoolsLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState("");

  // Detail/edit modal state
  const [detailTarget, setDetailTarget] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ display_name: "", phone: "" });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");

  const load = useCallback((searchQuery = "") => {
    setLoading(true);
    setError("");
    const params = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : "";
    api.get(`/api/v1/admin/guardians${params}`)
      .then((r) => setGuardians(r.data.guardians || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load guardians"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Debounced search: when the user types at least two characters, hit the
  // backend so name- and email-based lookups surface guardians who aren't
  // yet linked to this school.
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = search.trim();
    if (q.length < 2) return;
    searchTimerRef.current = setTimeout(() => load(q), 400);
    return () => clearTimeout(searchTimerRef.current);
  }, [search, load]);

  // ── Fetch available schools for the dropdown ──
  const fetchAvailableSchools = useCallback(() => {
    setSchoolsLoading(true);
    const endpoint = isSuperAdmin
      ? "/api/v1/admin/schools"
      : "/api/v1/site-settings/schools";
    api.get(endpoint)
      .then((r) => setAvailableSchools(r.data.schools || []))
      .catch(() => setAvailableSchools([]))
      .finally(() => setSchoolsLoading(false));
  }, [api, isSuperAdmin]);

  // ── Assign school to guardian ──
  const handleAssignSchool = async (guardianUid) => {
    const targetSchoolId = assignSchoolId || effectiveSchoolId;
    if (!targetSchoolId) {
      setAssignError(
        "Please select a school to assign."
      );
      return;
    }
    setAssignLoading(true);
    setAssignError("");
    try {
      const res = await api.post(`/api/v1/admin/guardians/${guardianUid}/schools`, {
        school_id: targetSchoolId,
      });
      const schoolName = res.data.school_name || availableSchools.find((s) => s.id === targetSchoolId)?.name || "School";
      // Update local state
      setGuardians((prev) =>
        prev.map((g) => {
          if (g.uid !== guardianUid) return g;
          const alreadyHas = g.assigned_school_ids.includes(targetSchoolId);
          if (alreadyHas) return g;
          return {
            ...g,
            assigned_school_ids: [...g.assigned_school_ids, targetSchoolId],
            assigned_schools: [...g.assigned_schools, { id: targetSchoolId, name: schoolName }],
          };
        })
      );
      setAssignTarget(null);
      setAssignSchoolId("");
      load(); // Reload for fresh data
    } catch (err) {
      setAssignError(err.response?.data?.detail || "Failed to assign school");
    } finally {
      setAssignLoading(false);
    }
  };

  // ── Load guardian detail (profile, children, vehicles, authorized pickups) ──
  const loadGuardianDetail = useCallback(async (guardianUid) => {
    setDetailLoading(true);
    setDetailError("");
    setEditingProfile(false);
    setProfileMsg("");
    try {
      const res = await api.get(`/api/v1/admin/guardians/${guardianUid}/detail`);
      setDetailData(res.data);
      setProfileForm({
        display_name: res.data.profile?.display_name || "",
        phone: res.data.profile?.phone || "",
      });
    } catch (err) {
      setDetailError(err.response?.data?.detail || "Failed to load guardian details");
    } finally {
      setDetailLoading(false);
    }
  }, [api]);

  // ── Save guardian profile edits ──
  const handleSaveProfile = async () => {
    if (!detailTarget) return;
    setProfileSaving(true);
    setProfileMsg("");
    try {
      await api.patch(`/api/v1/admin/guardians/${detailTarget.uid}/profile`, profileForm);
      setProfileMsg("Profile updated successfully.");
      setEditingProfile(false);
      // Update local guardian list
      setGuardians((prev) =>
        prev.map((g) =>
          g.uid === detailTarget.uid
            ? { ...g, display_name: profileForm.display_name || g.display_name }
            : g
        )
      );
      // Refresh detail
      loadGuardianDetail(detailTarget.uid);
    } catch (err) {
      setProfileMsg(err.response?.data?.detail || "Failed to update profile");
    } finally {
      setProfileSaving(false);
    }
  };

  // ── Remove school from guardian ──
  // Two-step: row "X" button stages the target via openRemoveSchool;
  // ConfirmDialog's onConfirm runs the API call.  Replaces the
  // previous window.confirm prompt with the shared modal so this
  // destructive flow matches every other admin-table delete.
  const [removeSchoolTarget, setRemoveSchoolTarget] = useState(null);
  const [removeSchoolBusy, setRemoveSchoolBusy] = useState(false);
  const [removeSchoolError, setRemoveSchoolError] = useState("");

  const openRemoveSchool = (guardian, schoolEntry) => {
    setRemoveSchoolTarget({
      guardianUid:    guardian.uid,
      guardianLabel:  guardian.display_name || guardian.email || "this guardian",
      schoolId:       schoolEntry.id,
      schoolName:     schoolEntry.name,
    });
    setRemoveSchoolError("");
  };

  const confirmRemoveSchool = async () => {
    if (!removeSchoolTarget) return;
    const { guardianUid, schoolId: removeSchoolId } = removeSchoolTarget;
    setRemoveSchoolBusy(true);
    setRemoveSchoolError("");
    try {
      await api.delete(`/api/v1/admin/guardians/${guardianUid}/schools/${removeSchoolId}`);
      setGuardians((prev) =>
        prev.map((g) => {
          if (g.uid !== guardianUid) return g;
          return {
            ...g,
            assigned_school_ids: g.assigned_school_ids.filter((id) => id !== removeSchoolId),
            assigned_schools: g.assigned_schools.filter((s) => s.id !== removeSchoolId),
          };
        })
      );
      setRemoveSchoolTarget(null);
    } catch (err) {
      setRemoveSchoolError(err.response?.data?.detail || "Failed to remove school");
    } finally {
      setRemoveSchoolBusy(false);
    }
  };

  // ── Filter & search ──
  const filtered = useMemo(() => {
    let list = guardians;
    if (statusFilter === "assigned") {
      list = list.filter((g) => (g.assigned_school_ids || []).length > 0);
    } else if (statusFilter === "unassigned") {
      list = list.filter((g) => (g.assigned_school_ids || []).length === 0);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((g) =>
      (g.display_name || "").toLowerCase().includes(q) ||
      (g.email || "").toLowerCase().includes(q)
    );
  }, [guardians, search, statusFilter]);

  const statusCounts = useMemo(() => ({
    all:        guardians.length,
    assigned:   guardians.filter((g) => (g.assigned_school_ids || []).length > 0).length,
    unassigned: guardians.filter((g) => (g.assigned_school_ids || []).length === 0).length,
  }), [guardians]);

  const isSchoolAssigned = (guardian) =>
    effectiveSchoolId && guardian.assigned_school_ids.includes(effectiveSchoolId);

  return (
    <div className="gm-container page-shell">
      {/* Header — eyebrow + display headline + count chip */}
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Roster · guardians</span>
          <h1 className="page-title">Guardians</h1>
          <p className="page-sub">
            Every guardian linked to this school, with their assigned schools, children, and authorized pickups.
          </p>
        </div>
        <div className="page-actions">
          <span className="page-chip" aria-label={`${guardians.length} guardians`}>
            <I.guardians size={12} aria-hidden="true" />
            {guardians.length.toLocaleString()} {guardians.length === 1 ? "guardian" : "guardians"}
          </span>
        </div>
      </div>

      {error && (
        <div className="gm-error">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="gm-error-dismiss"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Controls: filter pills (left) + search (right) — mirrors UM */}
      <div className="gm-toolbar">
        <div className="gm-filter-bar" role="tablist" aria-label="Filter guardians">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`gm-filter-tab${statusFilter === f.key ? " active" : ""}`}
              onClick={() => setStatusFilter(f.key)}
              role="tab"
              aria-selected={statusFilter === f.key}
              aria-label={`${f.label}: ${statusCounts[f.key] ?? 0} guardians`}
            >
              {f.label}
              <span className="gm-filter-badge" aria-hidden="true">{statusCounts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="gm-search-wrap" role="search">
          <I.search size={14} className="gm-search-icon" aria-hidden="true" />
          <label htmlFor="gm-search" className="sr-only">
            Search guardians by name or email
          </label>
          <input
            id="gm-search"
            className="gm-search"
            type="search"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading guardians…</p>
        </div>
      )}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div className="page-empty">
          <span className="page-empty-icon"><I.guardians size={22} aria-hidden="true" /></span>
          <h3 className="page-empty-title">
            {guardians.length === 0 ? "No guardians found" : "No guardians match your search"}
          </h3>
          <p className="page-empty-sub">
            {guardians.length === 0
              ? "Newly registered guardians appear here automatically. If you don't see one, try searching by their name or email."
              : "Try adjusting your search criteria."}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="gm-table-wrap">
          <table className="gm-table">
            <thead>
              <tr>
                <th scope="col">Guardian</th>
                <th scope="col">Children</th>
                <th scope="col">Assigned Schools</th>
                <th scope="col" className="gm-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.uid} className="gm-row">
                  <td data-label="Guardian">
                    <div className="gm-guardian-cell">
                      <div className="gm-guardian-avatar">
                        {(g.display_name || g.email || "?")[0].toUpperCase()}
                      </div>
                      <div className="gm-guardian-info">
                        <span className="gm-guardian-name">
                          {g.display_name || "(No name)"}
                          {g.is_pending && (
                            <span
                              className="gm-pending-badge"
                              title="This guardian signed up but hasn't been assigned to a school yet."
                            >
                              Pending
                            </span>
                          )}
                        </span>
                        <span className="gm-guardian-email">{g.email}</span>
                      </div>
                    </div>
                  </td>
                  <td data-label="Children">
                    <span className="gm-child-count">
                      {g.child_count} {g.child_count === 1 ? "child" : "children"}
                    </span>
                  </td>
                  <td data-label="Schools">
                    <div className="gm-schools-cell">
                      {g.assigned_schools.length === 0 ? (
                        <span className="gm-no-schools">No schools assigned</span>
                      ) : (
                        <div className="gm-school-tags">
                          {g.assigned_schools.map((s) => (
                            <span key={s.id} className="gm-school-tag">
                              <I.building size={11} className="gm-school-tag-icon" aria-hidden="true" />
                              {s.name}
                              {canEdit && (
                                <button
                                  className="gm-school-tag-remove"
                                  onClick={() => openRemoveSchool(g, s)}
                                  title="Remove school"
                                  aria-label={`Remove ${s.name}`}
                                >
                                  <I.x size={11} aria-hidden="true" />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td data-label="Actions" className="gm-td-actions">
                    <button
                      className="gm-btn-view"
                      onClick={() => {
                        setDetailTarget(g);
                        loadGuardianDetail(g.uid);
                      }}
                      title="View guardian details"
                    >
                      <I.eye size={12} aria-hidden="true" /> View
                    </button>
                    {!isSchoolAssigned(g) && canEdit && (
                      <button
                        className="gm-btn-assign"
                        onClick={() => {
                          setAssignTarget(g);
                          setAssignSchoolId(effectiveSchoolId || "");
                          setAssignError("");
                          fetchAvailableSchools();
                        }}
                        title="Assign a school"
                      >
                        <I.plus size={12} aria-hidden="true" /> Assign School
                      </button>
                    )}
                    {isSchoolAssigned(g) && (
                      <span className="gm-assigned-badge">Assigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assign School Modal with Dropdown */}
      {assignTarget && (
        <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setAssignTarget(null)}>
          <div className="gm-modal">
            <div className="gm-modal-header">
              <h2>Assign School to Guardian</h2>
              <button className="gm-modal-close" onClick={() => setAssignTarget(null)} aria-label="Close dialog">
                <I.x size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="gm-modal-desc">
              Select a school to assign to{" "}
              <strong>{assignTarget.display_name || assignTarget.email}</strong>.
              This will allow the guardian to add children enrolled at the selected school.
            </p>
            <div className="gm-field">
              <label className="gm-label">School</label>
              {schoolsLoading ? (
                <div className="gm-field-loading">Loading schools...</div>
              ) : (
                <select
                  className="gm-select"
                  value={assignSchoolId}
                  onChange={(e) => setAssignSchoolId(e.target.value)}
                >
                  <option value="">Select a school...</option>
                  {availableSchools
                    .filter((s) => !assignTarget.assigned_school_ids.includes(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
            {assignError && <p className="gm-form-error">{assignError}</p>}
            <div className="gm-modal-actions">
              <button
                className="gm-btn-ghost"
                onClick={() => setAssignTarget(null)}
                disabled={assignLoading}
              >
                Cancel
              </button>
              <button
                className="gm-btn-primary"
                onClick={() => handleAssignSchool(assignTarget.uid)}
                disabled={assignLoading || !assignSchoolId}
              >
                {assignLoading ? "Assigning..." : "Assign School"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guardian Detail/Edit Modal */}
      {detailTarget && (
        <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setDetailTarget(null)}>
          <div className="gm-modal gm-modal-lg">
            <div className="gm-modal-header">
              <h2>Guardian Details</h2>
              <button className="gm-modal-close" onClick={() => setDetailTarget(null)} aria-label="Close dialog">
                <I.x size={16} aria-hidden="true" />
              </button>
            </div>

            {detailLoading && <div className="gm-detail-loading">Loading guardian details...</div>}
            {detailError && <div className="gm-form-error">{detailError}</div>}

            {!detailLoading && detailData && (
              <div className="gm-detail-content">
                {/* Profile Section */}
                <div className="gm-detail-section">
                  <div className="gm-detail-section-header">
                    <h3>Profile</h3>
                    {!editingProfile && canEdit && (
                      <button className="gm-btn-view" onClick={() => setEditingProfile(true)}>
                        <I.edit size={12} aria-hidden="true" /> Edit
                      </button>
                    )}
                  </div>

                  {editingProfile ? (
                    <div className="gm-detail-edit-form">
                      <div className="gm-field">
                        <label className="gm-label">Display Name</label>
                        <input
                          className="gm-input"
                          value={profileForm.display_name}
                          onChange={(e) => setProfileForm((f) => ({ ...f, display_name: e.target.value }))}
                          placeholder="Full name"
                        />
                      </div>
                      <div className="gm-field">
                        <label className="gm-label">Phone</label>
                        <input
                          className="gm-input"
                          value={profileForm.phone}
                          onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))}
                          placeholder="(555) 123-4567"
                          type="tel"
                        />
                      </div>
                      {profileMsg && (
                        <p className={`gm-detail-msg${profileMsg.includes("Failed") ? " error" : ""}`}>
                          {profileMsg}
                        </p>
                      )}
                      <div className="gm-detail-edit-actions">
                        <button
                          className="gm-btn-ghost"
                          onClick={() => {
                            setEditingProfile(false);
                            setProfileMsg("");
                            setProfileForm({
                              display_name: detailData.profile?.display_name || "",
                              phone: detailData.profile?.phone || "",
                            });
                          }}
                          disabled={profileSaving}
                        >
                          Cancel
                        </button>
                        <button
                          className="gm-btn-primary"
                          onClick={handleSaveProfile}
                          disabled={profileSaving}
                        >
                          {profileSaving ? "Saving..." : "Save Changes"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="gm-detail-profile-info">
                      <div className="gm-detail-row">
                        <span className="gm-detail-label">Name</span>
                        <span className="gm-detail-value">{detailData.profile?.display_name || "(No name)"}</span>
                      </div>
                      <div className="gm-detail-row">
                        <span className="gm-detail-label">Email</span>
                        <span className="gm-detail-value">{detailData.profile?.email || "—"}</span>
                      </div>
                      <div className="gm-detail-row">
                        <span className="gm-detail-label">Phone</span>
                        <span className="gm-detail-value">{detailData.profile?.phone || "—"}</span>
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
                      {profileMsg && (
                        <p className={`gm-detail-msg${profileMsg.includes("Failed") ? " error" : ""}`}>
                          {profileMsg}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Assigned Schools Section */}
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

                {/* Children Section */}
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

                {/* Vehicles Section */}
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

                {/* Authorized Pickups Section */}
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
      )}

      <ConfirmDialog
        open={!!removeSchoolTarget}
        title="Remove school assignment"
        prompt={removeSchoolTarget && (
          <>
            Remove <strong>{removeSchoolTarget.schoolName}</strong> from{" "}
            <strong>{removeSchoolTarget.guardianLabel}</strong>?
          </>
        )}
        warning="The guardian will no longer be able to add children to this school. Any children already linked at this school stay linked."
        destructive
        confirmLabel="Remove school"
        busyLabel="Removing…"
        busy={removeSchoolBusy}
        error={removeSchoolError}
        onConfirm={confirmRemoveSchool}
        onCancel={() => setRemoveSchoolTarget(null)}
        confirmIcon={<I.trash size={12} aria-hidden="true" />}
      />
    </div>
  );
}
