import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  FaUserPlus,
  FaUsers,
  FaSearch,
  FaTrash,
  FaUserShield,
  FaUser,
  FaCopy,
  FaCheck,
  FaExclamationTriangle,
} from "react-icons/fa";
import { createApiClient } from "./api";
import { formatDateTime } from "./utils";
import "./UserManagement.css";

const ROLE_LABELS = { school_admin: "Admin", staff: "Staff" };

// ── Status chip ────────────────────────────────────────────────────────────
function StatusChip({ status }) {
  return (
    <span className={`um-chip um-chip-${status}`}>
      {status === "active" ? "Active" : status === "pending" ? "Pending" : "Disabled"}
    </span>
  );
}

// ── Role badge ─────────────────────────────────────────────────────────────
function RoleChip({ role }) {
  return (
    <span className={`um-chip um-chip-role-${role}`}>
      {role === "school_admin" ? <FaUserShield /> : <FaUser />}
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

// ── Copy-to-clipboard button ───────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  return (
    <button className="um-btn-copy" onClick={handleCopy} title="Copy invite link">
      {copied ? <FaCheck /> : <FaCopy />}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function UserManagement({ token, currentUser, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [search, setSearch]       = useState("");

  // Invite panel state
  const [inviteOpen, setInviteOpen]     = useState(false);
  const [inviteEmail, setInviteEmail]   = useState("");
  const [inviteName, setInviteName]     = useState("");
  const [inviteRole, setInviteRole]     = useState("staff");
  const [inviting, setInviting]         = useState(false);
  const [inviteError, setInviteError]   = useState("");
  const [inviteLink, setInviteLink]     = useState("");

  // Inline action state
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [actionLoading, setActionLoading]     = useState(null); // uid of row being updated

  const isSelf = useCallback((uid) => uid === currentUser?.uid, [currentUser]);

  // ── Fetch users ───────────────────────────────────────────────────────
  const fetchUsers = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .get("/api/v1/users")
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load users."))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // ── Client-side search ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.display_name || "").toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q) ||
        (ROLE_LABELS[u.role] || "").toLowerCase().includes(q)
    );
  }, [users, search]);

  // ── Invite submit ─────────────────────────────────────────────────────
  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setInviteError("");
    setInviteLink("");
    try {
      const res = await api.post("/api/v1/users/invite", {
        email: inviteEmail.trim(),
        display_name: inviteName.trim(),
        role: inviteRole,
      });
      setInviteLink(res.data.invite_link || "");
      setInviteEmail("");
      setInviteName("");
      setInviteRole("staff");
      fetchUsers();
    } catch (err) {
      setInviteError(err.response?.data?.detail || "Failed to send invite.");
    } finally {
      setInviting(false);
    }
  };

  // ── Role change ───────────────────────────────────────────────────────
  const handleRoleChange = async (uid, newRole) => {
    setActionLoading(uid);
    try {
      await api.patch(`/api/v1/users/${uid}/role`, { role: newRole });
      setUsers((prev) =>
        prev.map((u) => (u.uid === uid ? { ...u, role: newRole } : u))
      );
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update role.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Enable / Disable ──────────────────────────────────────────────────
  const handleStatusToggle = async (uid, currentStatus) => {
    const newStatus = currentStatus === "disabled" ? "active" : "disabled";
    setActionLoading(uid);
    try {
      await api.patch(`/api/v1/users/${uid}/status`, { status: newStatus });
      setUsers((prev) =>
        prev.map((u) => (u.uid === uid ? { ...u, status: newStatus } : u))
      );
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update account status.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDelete = async (uid) => {
    setActionLoading(uid);
    try {
      await api.delete(`/api/v1/users/${uid}`);
      setUsers((prev) => prev.filter((u) => u.uid !== uid));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete user.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="um-container">

      {/* Header */}
      <div className="um-header">
        <div className="um-header-left">
          <h1 className="um-title">Admin Users</h1>
          {!loading && (
            <span className="um-count">{users.length}</span>
          )}
        </div>
        <button
          className={`um-btn-invite ${inviteOpen ? "open" : ""}`}
          onClick={() => { setInviteOpen((p) => !p); setInviteLink(""); setInviteError(""); }}
        >
          <FaUserPlus />
          Invite User
        </button>
      </div>

      {/* Global error */}
      {error && (
        <div className="um-error">
          <FaExclamationTriangle />
          {error}
          <button className="um-error-dismiss" onClick={() => setError("")}>✕</button>
        </div>
      )}

      {/* Invite panel */}
      {inviteOpen && (
        <div className="um-invite-panel">
          <h2 className="um-invite-title">Invite a team member</h2>
          <p className="um-invite-subtitle">
            We'll generate a secure link they can use to set their password and log in.
          </p>

          {inviteLink ? (
            <div className="um-invite-success">
              <p className="um-invite-success-label">
                <FaCheck className="um-invite-success-icon" />
                User created! Share this link:
              </p>
              <div className="um-invite-link-row">
                <input
                  className="um-invite-link-input"
                  readOnly
                  value={inviteLink}
                  onFocus={(e) => e.target.select()}
                />
                <CopyButton text={inviteLink} />
              </div>
              <p className="um-invite-link-note">
                This link expires after use. The user will be prompted to set their password.
              </p>
              <button
                className="um-btn-secondary"
                onClick={() => { setInviteLink(""); }}
              >
                Invite another
              </button>
            </div>
          ) : (
            <form className="um-invite-form" onSubmit={handleInvite}>
              <div className="um-form-row">
                <div className="um-field">
                  <label className="um-label">Email address <span className="um-required">*</span></label>
                  <input
                    className="um-input"
                    type="email"
                    required
                    placeholder="jane.smith@school.edu"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    disabled={inviting}
                  />
                </div>
                <div className="um-field">
                  <label className="um-label">Display name</label>
                  <input
                    className="um-input"
                    type="text"
                    placeholder="Jane Smith"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    disabled={inviting}
                  />
                </div>
              </div>

              <div className="um-field um-field-role">
                <label className="um-label">Role</label>
                <div className="um-role-options">
                  <label className={`um-role-option ${inviteRole === "staff" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="inviteRole"
                      value="staff"
                      checked={inviteRole === "staff"}
                      onChange={() => setInviteRole("staff")}
                      disabled={inviting}
                    />
                    <FaUser className="um-role-icon" />
                    <div>
                      <strong>Staff</strong>
                      <p>View dashboard, history, and reports. Cannot manage users or import data.</p>
                    </div>
                  </label>
                  <label className={`um-role-option ${inviteRole === "school_admin" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="inviteRole"
                      value="school_admin"
                      checked={inviteRole === "school_admin"}
                      onChange={() => setInviteRole("school_admin")}
                      disabled={inviting}
                    />
                    <FaUserShield className="um-role-icon" />
                    <div>
                      <strong>Admin</strong>
                      <p>Full access including user management, data import, and registry edits.</p>
                    </div>
                  </label>
                </div>
              </div>

              {inviteError && <p className="um-field-error">{inviteError}</p>}

              <div className="um-invite-actions">
                <button type="button" className="um-btn-secondary" onClick={() => setInviteOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="um-btn-primary" disabled={inviting}>
                  {inviting ? "Creating account…" : "Send invite"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Search bar */}
      <div className="um-search-wrap">
        <FaSearch className="um-search-icon" />
        <input
          className="um-search-input"
          type="search"
          placeholder="Search by name, email, or role…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <p className="um-state-msg">Loading users…</p>
      ) : filtered.length === 0 ? (
        <div className="um-empty">
          <FaUsers className="um-empty-icon" />
          <p>{search ? "No users match your search." : "No users yet. Invite your first team member."}</p>
        </div>
      ) : (
        <div className="um-table-wrap">
          <table className="um-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const self = isSelf(u.uid);
                const busy = actionLoading === u.uid;
                const confirming = confirmDeleteId === u.uid;

                return (
                  <React.Fragment key={u.uid}>
                    <tr className={`um-row${u.status === "disabled" ? " um-row-disabled" : ""}${confirming ? " um-row-confirming" : ""}`}>

                      {/* Name + email */}
                      <td>
                        <div className="um-user-cell">
                          <span className="um-user-name">
                            {u.display_name || <em className="um-no-name">No display name</em>}
                            {self && <span className="um-you-badge">You</span>}
                          </span>
                          <span className="um-user-email">{u.email}</span>
                        </div>
                      </td>

                      {/* Role — inline dropdown for admins, read-only for self */}
                      <td>
                        {self ? (
                          <RoleChip role={u.role} />
                        ) : (
                          <select
                            className="um-role-select"
                            value={u.role}
                            disabled={busy}
                            onChange={(e) => handleRoleChange(u.uid, e.target.value)}
                            title="Change role"
                          >
                            <option value="staff">Staff</option>
                            <option value="school_admin">Admin</option>
                          </select>
                        )}
                      </td>

                      {/* Status */}
                      <td><StatusChip status={u.status} /></td>

                      {/* Last login */}
                      <td className="um-last-login">
                        {u.last_sign_in ? formatDateTime(u.last_sign_in) : "—"}
                      </td>

                      {/* Actions */}
                      <td>
                        <div className="um-actions">
                          {!self && (
                            <>
                              <button
                                className={`um-btn-status ${u.status === "disabled" ? "enable" : "disable"}`}
                                disabled={busy}
                                onClick={() => handleStatusToggle(u.uid, u.status)}
                                title={u.status === "disabled" ? "Enable account" : "Disable account"}
                              >
                                {busy && actionLoading === u.uid
                                  ? "…"
                                  : u.status === "disabled"
                                  ? "Enable"
                                  : "Disable"}
                              </button>
                              <button
                                className="um-btn-delete"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(confirming ? null : u.uid)}
                                title="Delete user"
                              >
                                <FaTrash />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Inline delete confirmation */}
                    {confirming && (
                      <tr className="um-confirm-row">
                        <td colSpan={5}>
                          <div className="um-confirm-inner">
                            <FaExclamationTriangle className="um-confirm-icon" />
                            <span>
                              Permanently delete <strong>{u.display_name || u.email}</strong>?
                              This cannot be undone.
                            </span>
                            <button
                              className="um-btn-danger"
                              disabled={busy}
                              onClick={() => handleDelete(u.uid)}
                            >
                              {busy ? "Deleting…" : "Yes, delete"}
                            </button>
                            <button
                              className="um-btn-secondary"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
