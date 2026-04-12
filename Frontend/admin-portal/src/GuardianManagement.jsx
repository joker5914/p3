import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { FaSearch, FaUserFriends, FaSchool, FaPlus, FaTimes, FaExclamationTriangle, FaEye } from "react-icons/fa";
import { createApiClient } from "./api";
import GuardianDetailModal from "./GuardianDetailModal";
import "./GuardianManagement.css";

export default function GuardianManagement({ token, schoolId = null, currentUser = null }) {
  const effectiveSchoolId = schoolId || currentUser?.school_id || null;
  const isSuperAdmin = currentUser?.role === "super_admin";
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [guardians, setGuardians] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [search, setSearch]       = useState("");
  const searchTimerRef = useRef(null);

  const [assignTarget, setAssignTarget]   = useState(null);
  const [assignSchoolId, setAssignSchoolId] = useState("");
  const [availableSchools, setAvailableSchools] = useState([]);
  const [schoolsLoading, setSchoolsLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError]     = useState("");

  const [detailGuardian, setDetailGuardian] = useState(null);

  const load = useCallback((searchQuery = "") => {
    setLoading(true); setError("");
    const params = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : "";
    api.get(`/api/v1/admin/guardians${params}`)
      .then((r) => setGuardians(r.data.guardians || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load guardians"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = search.trim();
    if (q.length < 2) return;
    searchTimerRef.current = setTimeout(() => load(q), 400);
    return () => clearTimeout(searchTimerRef.current);
  }, [search, load]);

  const fetchAvailableSchools = useCallback(() => {
    setSchoolsLoading(true);
    api.get(isSuperAdmin ? "/api/v1/admin/schools" : "/api/v1/site-settings/schools")
      .then((r) => setAvailableSchools(r.data.schools || []))
      .catch(() => setAvailableSchools([]))
      .finally(() => setSchoolsLoading(false));
  }, [api, isSuperAdmin]);

  const handleAssignSchool = async (guardianUid) => {
    const targetSchoolId = assignSchoolId || effectiveSchoolId;
    if (!targetSchoolId) { setAssignError("Please select a school to assign."); return; }
    setAssignLoading(true); setAssignError("");
    try {
      const res = await api.post(`/api/v1/admin/guardians/${guardianUid}/schools`, { school_id: targetSchoolId });
      const schoolName = res.data.school_name || availableSchools.find((s) => s.id === targetSchoolId)?.name || "School";
      setGuardians((prev) => prev.map((g) => {
        if (g.uid !== guardianUid || g.assigned_school_ids.includes(targetSchoolId)) return g;
        return { ...g, assigned_school_ids: [...g.assigned_school_ids, targetSchoolId], assigned_schools: [...g.assigned_schools, { id: targetSchoolId, name: schoolName }] };
      }));
      setAssignTarget(null); setAssignSchoolId(""); load();
    } catch (err) { setAssignError(err.response?.data?.detail || "Failed to assign school"); }
    finally { setAssignLoading(false); }
  };

  const handleRemoveSchool = async (guardianUid, removeSchoolId) => {
    if (!window.confirm("Remove this school assignment?")) return;
    try {
      await api.delete(`/api/v1/admin/guardians/${guardianUid}/schools/${removeSchoolId}`);
      setGuardians((prev) => prev.map((g) => g.uid !== guardianUid ? g : {
        ...g,
        assigned_school_ids: g.assigned_school_ids.filter((id) => id !== removeSchoolId),
        assigned_schools: g.assigned_schools.filter((s) => s.id !== removeSchoolId),
      }));
    } catch (err) { setError(err.response?.data?.detail || "Failed to remove school"); }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return guardians;
    const q = search.toLowerCase();
    return guardians.filter((g) => (g.display_name || "").toLowerCase().includes(q) || (g.email || "").toLowerCase().includes(q));
  }, [guardians, search]);

  const isSchoolAssigned = (guardian) => effectiveSchoolId && guardian.assigned_school_ids.includes(effectiveSchoolId);

  return (
    <div className="gm-container">
      <div className="gm-header">
        <div className="gm-header-left"><h2 className="gm-title">Guardians</h2><span className="gm-count">{guardians.length}</span></div>
      </div>

      {error && (<div className="gm-error"><FaExclamationTriangle />{error}<button className="gm-error-dismiss" onClick={() => setError("")}>&times;</button></div>)}

      <div className="gm-toolbar">
        <div className="gm-search-wrap">
          <FaSearch className="gm-search-icon" />
          <input className="gm-search" type="text" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading && <div className="gm-state">Loading guardians...</div>}
      {!loading && filtered.length === 0 && (
        <div className="gm-empty">
          <FaUserFriends size={32} />
          <h3>{guardians.length === 0 ? "No guardians found" : "No guardians match your search"}</h3>
          <p>{guardians.length === 0 ? "Newly registered guardians appear here automatically. If you don't see one, try searching by their name or email." : "Try adjusting your search criteria."}</p>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="gm-table-wrap">
          <table className="gm-table">
            <thead><tr><th>Guardian</th><th>Children</th><th>Assigned Schools</th><th className="gm-th-actions">Actions</th></tr></thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.uid}>
                  <td>
                    <div className="gm-guardian-cell">
                      <div className="gm-guardian-avatar">{(g.display_name || g.email || "?")[0].toUpperCase()}</div>
                      <div className="gm-guardian-info">
                        <span className="gm-guardian-name">{g.display_name || "(No name)"}{g.is_pending && <span className="gm-pending-badge" title="This guardian signed up but hasn’t been assigned to a school yet.">Pending</span>}</span>
                        <span className="gm-guardian-email">{g.email}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className="gm-child-count">{g.child_count} {g.child_count === 1 ? "child" : "children"}</span></td>
                  <td>
                    <div className="gm-schools-cell">
                      {g.assigned_schools.length === 0 ? (<span className="gm-no-schools">No schools assigned</span>) : (
                        <div className="gm-school-tags">
                          {g.assigned_schools.map((s) => (
                            <span key={s.id} className="gm-school-tag">
                              <FaSchool className="gm-school-tag-icon" />{s.name}
                              <button className="gm-school-tag-remove" onClick={() => handleRemoveSchool(g.uid, s.id)} title="Remove school"><FaTimes /></button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="gm-td-actions">
                    <button className="gm-btn gm-btn-view" onClick={() => setDetailGuardian(g)} title="View guardian details"><FaEye /> View</button>
                    {!isSchoolAssigned(g) && (<button className="gm-btn gm-btn-assign" onClick={() => { setAssignTarget(g); setAssignSchoolId(effectiveSchoolId || ""); setAssignError(""); fetchAvailableSchools(); }} title="Assign a school"><FaPlus /> Assign School</button>)}
                    {isSchoolAssigned(g) && <span className="gm-assigned-badge">Assigned</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assign School Modal */}
      {assignTarget && (
        <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setAssignTarget(null)}>
          <div className="gm-modal">
            <div className="gm-modal-header"><h2>Assign School to Guardian</h2><button className="gm-modal-close" onClick={() => setAssignTarget(null)}>&times;</button></div>
            <p className="gm-modal-desc">Select a school to assign to <strong>{assignTarget.display_name || assignTarget.email}</strong>. This will allow the guardian to add children enrolled at the selected school.</p>
            <div className="gm-field">
              <label className="gm-label">School</label>
              {schoolsLoading ? (<div className="gm-field-loading">Loading schools...</div>) : (
                <select className="gm-select" value={assignSchoolId} onChange={(e) => setAssignSchoolId(e.target.value)}>
                  <option value="">Select a school...</option>
                  {availableSchools.filter((s) => !assignTarget.assigned_school_ids.includes(s.id)).map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                </select>
              )}
            </div>
            {assignError && <p className="gm-form-error">{assignError}</p>}
            <div className="gm-modal-actions">
              <button className="gm-btn gm-btn-ghost" onClick={() => setAssignTarget(null)} disabled={assignLoading}>Cancel</button>
              <button className="gm-btn gm-btn-primary" onClick={() => handleAssignSchool(assignTarget.uid)} disabled={assignLoading || !assignSchoolId}>{assignLoading ? "Assigning..." : "Assign School"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Guardian Detail Modal */}
      {detailGuardian && (
        <GuardianDetailModal
          guardian={detailGuardian}
          api={api}
          onClose={() => setDetailGuardian(null)}
          onProfileUpdated={(uid, updates) => setGuardians((prev) => prev.map((g) => g.uid === uid ? { ...g, ...updates } : g))}
          onSchoolRemoved={(uid, sid) => setGuardians((prev) => prev.map((g) => g.uid !== uid ? g : { ...g, assigned_school_ids: g.assigned_school_ids.filter((id) => id !== sid), assigned_schools: g.assigned_schools.filter((s) => s.id !== sid) }))}
        />
      )}
    </div>
  );
}
