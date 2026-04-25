import React, { useState, useEffect, useMemo, useCallback } from "react";
import { I } from "./components/icons";
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

// Link-student modal — role="dialog" + Escape-to-close + labelled form.
function LinkStudentModal({ target, email, setEmail, error, loading, onSubmit, onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape" && !loading) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loading, onClose]);

  return (
    <div
      className="sm-modal-overlay"
      onClick={(e) => e.target === e.currentTarget && !loading && onClose()}
    >
      <div
        className="sm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sm-link-title"
      >
        <div className="sm-modal-header">
          <h2 id="sm-link-title">Link Student to Guardian</h2>
          <button
            className="sm-modal-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <I.x size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="sm-modal-desc">
          Link <strong>{target.first_name} {target.last_name}</strong> to a guardian by entering their account email address.
        </p>
        <form onSubmit={onSubmit} className="sm-modal-form">
          <div className="sm-field">
            <label htmlFor="sm-link-email">Guardian Email</label>
            <input
              id="sm-link-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="guardian@example.com"
              autoFocus
            />
          </div>
          {error && <p className="sm-form-error" role="alert">{error}</p>}
          <div className="sm-modal-actions">
            <button type="button" className="sm-btn sm-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="sm-btn sm-btn-primary" disabled={loading}>
              {loading ? "Linking..." : "Link Student"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
    <div className="sm-container page-shell">
      {/* Header — eyebrow + display headline + count chip */}
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Roster · students</span>
          <h1 className="page-title">Students</h1>
          <p className="page-sub">
            Roster of every student enrolled at this school and the guardians authorized to pick them up.
          </p>
        </div>
        <div className="page-actions">
          <span className="page-chip" aria-label={`${students.length} students`}>
            <I.student size={12} aria-hidden="true" />
            {students.length.toLocaleString()} {students.length === 1 ? "student" : "students"}
          </span>
        </div>
      </div>

      {error && (
        <div className="sm-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="sm-error-dismiss"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Controls: filter pills (left) + search (right) — matches UM */}
      <div className="sm-toolbar">
        <div className="sm-filter-bar" role="tablist" aria-label="Filter students">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`sm-filter-tab${statusFilter === f.key ? " active" : ""}`}
              onClick={() => setStatusFilter(f.key)}
              role="tab"
              aria-selected={statusFilter === f.key}
              aria-label={`${f.label}: ${counts[f.key] ?? 0} students`}
            >
              {f.label}
              <span className="sm-filter-badge" aria-hidden="true">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="sm-search-wrap" role="search">
          <I.search size={14} className="sm-search-icon" aria-hidden="true" />
          <label htmlFor="sm-search" className="sr-only">
            Search students or guardians
          </label>
          <input
            id="sm-search"
            className="sm-search"
            type="search"
            placeholder="Search students or guardians…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading students…</p>
        </div>
      )}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.student size={22} aria-hidden="true" /></span>
          <h3 className="page-empty-title">
            {students.length === 0 ? "No students enrolled yet" : "No students match your filters"}
          </h3>
          <p className="page-empty-sub">
            {students.length === 0
              ? "Add students using the Dismissal Admin Portal, then link them to their respective Guardian Portal for each school."
              : "Try adjusting your search or filter criteria."}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <caption className="sr-only">Students and their guardians</caption>
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Grade</th>
                <th scope="col">Guardian</th>
                <th scope="col">Status</th>
                <th scope="col" className="sm-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className={`sm-row ${s.status === "unlinked" ? "sm-row-unlinked" : ""}`}>
                  <td data-label="Student">
                    <div className="sm-student-cell">
                      <PersonAvatar
                        name={`${s.first_name} ${s.last_name}`}
                        photoUrl={s.photo_url}
                        size={36}
                      />
                      <span className="sm-student-name">{s.first_name} {s.last_name}</span>
                    </div>
                  </td>
                  <td data-label="Grade">{s.grade || "\u2014"}</td>
                  <td data-label="Guardian">
                    {s.guardian ? (
                      <div className="sm-guardian-cell">
                        <span className="sm-guardian-name">{s.guardian.display_name}</span>
                        <span className="sm-guardian-email">{s.guardian.email}</span>
                      </div>
                    ) : (
                      <span className="sm-no-guardian">No guardian</span>
                    )}
                  </td>
                  <td data-label="Status"><StatusChip status={s.status} /></td>
                  <td data-label="Actions" className="sm-td-actions">
                    {s.status === "active" && s.guardian && (
                      <button
                        className="sm-btn-unlink"
                        onClick={() => handleUnlink(s)}
                        title="Unlink from guardian"
                      >
                        <I.unlink size={12} aria-hidden="true" /> Unlink
                      </button>
                    )}
                    {s.status === "unlinked" && (
                      <button
                        className="sm-btn-link"
                        onClick={() => openLinkModal(s)}
                        title="Link to a guardian"
                      >
                        <I.link size={12} aria-hidden="true" /> Link
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
        <LinkStudentModal
          target={linkTarget}
          email={linkEmail}
          setEmail={setLinkEmail}
          error={linkError}
          loading={linkLoading}
          onSubmit={handleLink}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </div>
  );
}
