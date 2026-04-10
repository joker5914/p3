import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  FaSearch,
  FaUserGraduate,
  FaUnlink,
  FaLink,
  FaExclamationTriangle,
} from "react-icons/fa";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";
import "./StudentManagement.css";

const STATUS_FILTERS = [
  { key: "all",      label: "All"      },
  { key: "active",   label: "Linked"   },
  { key: "unlinked", label: "Unlinked" },
];

function StatusChip({ status }) {
  const labels = { active: "Linked", unlinked: "Unlinked" };
  return (
    <span className={`sm-chip sm-chip-${status}`}>{labels[status] ?? status}</span>
  );
}

export default function StudentManagement({ token, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [students, setStudents]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Link modal state
  const [linkTarget, setLinkTarget]     = useState(null);
  const [linkEmail, setLinkEmail]       = useState("");
  const [linkLoading, setLinkLoading]   = useState(false);
  const [linkError, setLinkError]       = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api.get("/api/v1/admin/students")
      .then((r) => setStudents(r.data.students || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load students"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // ── Unlink ────────────────────────────────────────────
  const handleUnlink = async (student) => {
    const name = `${student.first_name} ${student.last_name}`;
    const guardian = student.guardian?.display_name || student.guardian?.email || "their guardian";
    if (!window.confirm(
      `Unlink ${name} from ${guardian}?\n\n` +
      `The student will be removed from the guardian's account and any linked vehicles. ` +
      `The student record will be preserved and can be re-linked to another guardian.`
    )) return;

    try {
      await api.post(`/api/v1/admin/students/${student.id}/unlink`);
      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id ? { ...s, status: "unlinked", guardian: null } : s
        )
      );
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to unlink student");
    }
  };

  // ── Link ──────────────────────────────────────────────
  const openLinkModal = (student) => {
    setLinkTarget(student);
    setLinkEmail("");
    setLinkError("");
  };

  const handleLink = async (e) => {
    e.preventDefault();
    setLinkLoading(true);
    setLinkError("");
    try {
      const res = await api.post(`/api/v1/admin/students/${linkTarget.id}/link`, {
        guardian_email: linkEmail,
      });
      setStudents((prev) =>
        prev.map((s) =>
          s.id === linkTarget.id
            ? { ...s, status: "active", guardian: res.data.guardian }
            : s
        )
      );
      setLinkTarget(null);
    } catch (err) {
      setLinkError(err.response?.data?.detail || "Failed to link student");
    } finally {
      setLinkLoading(false);
    }
  };

  // ── Filter & search ───────────────────────────────────
  const filtered = useMemo(() => {
    let list = students;
    if (statusFilter !== "all") {
      list = list.filter((s) => s.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        `${s.first_name} ${s.last_name}`.toLowerCase().includes(q) ||
        (s.guardian?.display_name || "").toLowerCase().includes(q) ||
        (s.guardian?.email || "").toLowerCase().includes(q) ||
        (s.grade || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [students, statusFilter, search]);

  const counts = useMemo(() => ({
    all: students.length,
    active: students.filter((s) => s.status === "active").length,
    unlinked: students.filter((s) => s.status === "unlinked").length,
  }), [students]);

  // ── Render ────────────────────────────────────────────
  return (
    <div className="sm-container">
      {/* Header */}
      <div className="sm-header">
        <div className="sm-header-left">
          <h2 className="sm-title">Students</h2>
          <span className="sm-count">{students.length}</span>
        </div>
      </div>

      {error && (
        <div className="sm-error">
          <FaExclamationTriangle />
          {error}
          <button className="sm-error-dismiss" onClick={() => setError("")}>&times;</button>
        </div>
      )}

      {/* Toolbar: search + status filter */}
      <div className="sm-toolbar">
        <div className="sm-search-wrap">
          <FaSearch className="sm-search-icon" />
          <input
            className="sm-search"
            type="text"
            placeholder="Search students or guardians..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sm-filter-group">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`sm-filter-btn${statusFilter === f.key ? " active" : ""}`}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
              <span className="sm-filter-count">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && <div className="sm-state">Loading students...</div>}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div className="sm-empty">
          <FaUserGraduate size={32} />
          <h3>{students.length === 0 ? "No students enrolled yet" : "No students match your filters"}</h3>
          <p>
            {students.length === 0
              ? "Students will appear here once guardians register them via the Guardian Portal."
              : "Try adjusting your search or filter criteria."}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Grade</th>
                <th>Guardian</th>
                <th>Status</th>
                <th className="sm-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className={s.status === "unlinked" ? "sm-row-unlinked" : ""}>
                  <td>
                    <div className="sm-student-cell">
                      <PersonAvatar
                        name={`${s.first_name} ${s.last_name}`}
                        photoUrl={s.photo_url}
                        size={36}
                      />
                      <span className="sm-student-name">{s.first_name} {s.last_name}</span>
                    </div>
                  </td>
                  <td>{s.grade || "\u2014"}</td>
                  <td>
                    {s.guardian ? (
                      <div className="sm-guardian-cell">
                        <span className="sm-guardian-name">{s.guardian.display_name}</span>
                        <span className="sm-guardian-email">{s.guardian.email}</span>
                      </div>
                    ) : (
                      <span className="sm-no-guardian">No guardian</span>
                    )}
                  </td>
                  <td><StatusChip status={s.status} /></td>
                  <td className="sm-td-actions">
                    {s.status === "active" && s.guardian && (
                      <button
                        className="sm-btn sm-btn-unlink"
                        onClick={() => handleUnlink(s)}
                        title="Unlink from guardian"
                      >
                        <FaUnlink /> Unlink
                      </button>
                    )}
                    {s.status === "unlinked" && (
                      <button
                        className="sm-btn sm-btn-link"
                        onClick={() => openLinkModal(s)}
                        title="Link to a guardian"
                      >
                        <FaLink /> Link
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Link Modal */}
      {linkTarget && (
        <div className="sm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setLinkTarget(null)}>
          <div className="sm-modal">
            <div className="sm-modal-header">
              <h2>Link Student to Guardian</h2>
              <button className="sm-modal-close" onClick={() => setLinkTarget(null)}>&times;</button>
            </div>
            <p className="sm-modal-desc">
              Link <strong>{linkTarget.first_name} {linkTarget.last_name}</strong> to a guardian by entering their account email address.
            </p>
            <form onSubmit={handleLink} className="sm-modal-form">
              <div className="sm-field">
                <label>Guardian Email</label>
                <input
                  type="email"
                  value={linkEmail}
                  onChange={(e) => setLinkEmail(e.target.value)}
                  required
                  placeholder="guardian@example.com"
                  autoFocus
                />
              </div>
              {linkError && <p className="sm-form-error">{linkError}</p>}
              <div className="sm-modal-actions">
                <button type="button" className="sm-btn sm-btn-ghost" onClick={() => setLinkTarget(null)}>Cancel</button>
                <button type="submit" className="sm-btn sm-btn-primary" disabled={linkLoading}>
                  {linkLoading ? "Linking..." : "Link Student"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
