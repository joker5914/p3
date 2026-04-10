import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  FaSearch,
  FaUserFriends,
  FaSchool,
  FaPlus,
  FaTimes,
  FaExclamationTriangle,
} from "react-icons/fa";
import { createApiClient } from "./api";
import "./GuardianManagement.css";

export default function GuardianManagement({ token, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [guardians, setGuardians] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  // Assign school modal state
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api.get("/api/v1/admin/guardians")
      .then((r) => setGuardians(r.data.guardians || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load guardians"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // ── Assign school to guardian ──
  const handleAssignSchool = async (guardianUid) => {
    if (!schoolId) return;
    setAssignLoading(true);
    setAssignError("");
    try {
      await api.post(`/api/v1/admin/guardians/${guardianUid}/schools`, {
        school_id: schoolId,
      });
      // Update local state
      setGuardians((prev) =>
        prev.map((g) => {
          if (g.uid !== guardianUid) return g;
          const alreadyHas = g.assigned_school_ids.includes(schoolId);
          if (alreadyHas) return g;
          return {
            ...g,
            assigned_school_ids: [...g.assigned_school_ids, schoolId],
            assigned_schools: [...g.assigned_schools, { id: schoolId, name: "This school" }],
          };
        })
      );
      setAssignTarget(null);
      load(); // Reload for fresh data
    } catch (err) {
      setAssignError(err.response?.data?.detail || "Failed to assign school");
    } finally {
      setAssignLoading(false);
    }
  };

  // ── Remove school from guardian ──
  const handleRemoveSchool = async (guardianUid, removeSchoolId) => {
    if (!window.confirm(
      "Remove this school assignment? The guardian will no longer be able to add children to this school."
    )) return;
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
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove school");
    }
  };

  // ── Filter & search ──
  const filtered = useMemo(() => {
    if (!search.trim()) return guardians;
    const q = search.toLowerCase();
    return guardians.filter((g) =>
      (g.display_name || "").toLowerCase().includes(q) ||
      (g.email || "").toLowerCase().includes(q)
    );
  }, [guardians, search]);

  const isSchoolAssigned = (guardian) =>
    schoolId && guardian.assigned_school_ids.includes(schoolId);

  return (
    <div className="gm-container">
      {/* Header */}
      <div className="gm-header">
        <div className="gm-header-left">
          <h2 className="gm-title">Guardians</h2>
          <span className="gm-count">{guardians.length}</span>
        </div>
      </div>

      {error && (
        <div className="gm-error">
          <FaExclamationTriangle />
          {error}
          <button className="gm-error-dismiss" onClick={() => setError("")}>&times;</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="gm-toolbar">
        <div className="gm-search-wrap">
          <FaSearch className="gm-search-icon" />
          <input
            className="gm-search"
            type="text"
            placeholder="Search guardians by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Loading */}
      {loading && <div className="gm-state">Loading guardians...</div>}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div className="gm-empty">
          <FaUserFriends size={32} />
          <h3>{guardians.length === 0 ? "No guardians found" : "No guardians match your search"}</h3>
          <p>
            {guardians.length === 0
              ? "Guardians will appear here once they create accounts and are associated with your school."
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
                <th>Guardian</th>
                <th>Children</th>
                <th>Assigned Schools</th>
                <th className="gm-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.uid}>
                  <td>
                    <div className="gm-guardian-cell">
                      <div className="gm-guardian-avatar">
                        {(g.display_name || g.email || "?")[0].toUpperCase()}
                      </div>
                      <div className="gm-guardian-info">
                        <span className="gm-guardian-name">{g.display_name || "(No name)"}</span>
                        <span className="gm-guardian-email">{g.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="gm-child-count">
                      {g.child_count} {g.child_count === 1 ? "child" : "children"}
                    </span>
                  </td>
                  <td>
                    <div className="gm-schools-cell">
                      {g.assigned_schools.length === 0 ? (
                        <span className="gm-no-schools">No schools assigned</span>
                      ) : (
                        <div className="gm-school-tags">
                          {g.assigned_schools.map((s) => (
                            <span key={s.id} className="gm-school-tag">
                              <FaSchool className="gm-school-tag-icon" />
                              {s.name}
                              <button
                                className="gm-school-tag-remove"
                                onClick={() => handleRemoveSchool(g.uid, s.id)}
                                title="Remove school"
                              >
                                <FaTimes />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="gm-td-actions">
                    {!isSchoolAssigned(g) && (
                      <button
                        className="gm-btn gm-btn-assign"
                        onClick={() => {
                          setAssignTarget(g);
                          setAssignError("");
                        }}
                        title="Assign this school"
                      >
                        <FaPlus /> Assign School
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

      {/* Assign School Confirmation Modal */}
      {assignTarget && (
        <div className="gm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setAssignTarget(null)}>
          <div className="gm-modal">
            <div className="gm-modal-header">
              <h2>Assign School to Guardian</h2>
              <button className="gm-modal-close" onClick={() => setAssignTarget(null)}>&times;</button>
            </div>
            <p className="gm-modal-desc">
              Assign your school to <strong>{assignTarget.display_name || assignTarget.email}</strong>?
              This will allow the guardian to add children enrolled at your school.
            </p>
            {assignError && <p className="gm-form-error">{assignError}</p>}
            <div className="gm-modal-actions">
              <button
                className="gm-btn gm-btn-ghost"
                onClick={() => setAssignTarget(null)}
                disabled={assignLoading}
              >
                Cancel
              </button>
              <button
                className="gm-btn gm-btn-primary"
                onClick={() => handleAssignSchool(assignTarget.uid)}
                disabled={assignLoading}
              >
                {assignLoading ? "Assigning..." : "Assign School"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
