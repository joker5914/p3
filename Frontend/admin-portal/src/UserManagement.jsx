import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaUserPlus, FaUsers, FaSearch, FaTrash, FaUserShield, FaUser, FaCopy, FaCheck, FaExclamationTriangle, FaRedo } from "react-icons/fa";
import { createApiClient } from "./api";
import { formatDateTime } from "./utils";
import InviteUserPanel from "./InviteUserPanel";
import "./UserManagement.css";

const ROLE_LABELS = { school_admin: "Admin", staff: "Staff" };
const STATUS_FILTERS = [{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "pending", label: "Pending" }, { key: "disabled", label: "Disabled" }];

function formatInvited(isoStr) {
  if (!isoStr) return null;
  try { return new Date(isoStr).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return null; }
}

function StatusChip({ status }) {
  return <span className={`um-chip um-chip-${status}`}>{{ active: "Active", pending: "Pending", disabled: "Disabled" }[status] ?? status}</span>;
}

function RoleChip({ role }) {
  return <span className={`um-chip um-chip-role-${role}`}>{role === "school_admin" ? <FaUserShield /> : <FaUser />}{ROLE_LABELS[role] ?? role}</span>;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }); };
  return <button className="um-btn-copy" onClick={handleCopy} title="Copy invite link">{copied ? <FaCheck /> : <FaCopy />}{copied ? "Copied!" : "Copy link"}</button>;
}

export default function UserManagement({ token, currentUser, schoolId = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [search, setSearch]   = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [inviteOpen, setInviteOpen]     = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [actionLoading, setActionLoading]     = useState(null);
  const [pendingRoles, setPendingRoles]       = useState({});
  const [resendResult, setResendResult]   = useState(null);
  const [resendLoading, setResendLoading] = useState(null);

  const isSelf = useCallback((uid) => uid === currentUser?.uid, [currentUser]);

  const fetchUsers = useCallback(() => {
    setLoading(true); setError("");
    api.get("/api/v1/users")
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load users."))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const statusCounts = useMemo(() => ({ all: users.length, active: users.filter((u) => u.status === "active").length, pending: users.filter((u) => u.status === "pending").length, disabled: users.filter((u) => u.status === "disabled").length }), [users]);

  const filtered = useMemo(() => {
    let list = statusFilter === "all" ? users : users.filter((u) => u.status === statusFilter);
    const q = search.trim().toLowerCase();
    return q ? list.filter((u) => (u.display_name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q) || (ROLE_LABELS[u.role] || "").toLowerCase().includes(q)) : list;
  }, [users, search, statusFilter]);

  const setPendingRole = (uid, newRole) => setPendingRoles((prev) => ({ ...prev, [uid]: newRole }));
  const cancelPendingRole = (uid) => setPendingRoles((prev) => { const n = { ...prev }; delete n[uid]; return n; });

  const handleRoleSave = async (uid) => {
    const newRole = pendingRoles[uid]; if (!newRole) return;
    setActionLoading(uid);
    try { await api.patch(`/api/v1/users/${uid}/role`, { role: newRole }); setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, role: newRole } : u)); cancelPendingRole(uid); }
    catch (err) { setError(err.response?.data?.detail || "Failed to update role."); }
    finally { setActionLoading(null); }
  };

  const handleStatusToggle = async (uid, currentStatus) => {
    const newStatus = currentStatus === "disabled" ? "active" : "disabled";
    setActionLoading(uid);
    try { await api.patch(`/api/v1/users/${uid}/status`, { status: newStatus }); setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, status: newStatus } : u)); }
    catch (err) { setError(err.response?.data?.detail || "Failed to update account status."); }
    finally { setActionLoading(null); }
  };

  const handleResendInvite = async (uid) => {
    setResendLoading(uid);
    try { const res = await api.post(`/api/v1/users/${uid}/resend-invite`); setResendResult({ email: res.data.email, invite_link: res.data.invite_link }); }
    catch (err) { setError(err.response?.data?.detail || "Failed to resend invite."); }
    finally { setResendLoading(null); }
  };

  const handleDelete = async (uid) => {
    setActionLoading(uid);
    try { await api.delete(`/api/v1/users/${uid}`); setUsers((prev) => prev.filter((u) => u.uid !== uid)); setConfirmDeleteId(null); }
    catch (err) { setError(err.response?.data?.detail || "Failed to delete user."); }
    finally { setActionLoading(null); }
  };

  const emptyMessage = search ? "No users match your search." : statusFilter === "pending" ? "No pending invites." : statusFilter === "disabled" ? "No disabled accounts." : statusFilter === "active" ? "No active users yet." : "No users yet. Invite your first team member.";

  return (
    <div className="um-container">
      <div className="um-header">
        <div className="um-header-left"><h2 className="um-title">Users</h2>{!loading && <span className="um-count">{users.length}</span>}</div>
        <button className={`um-btn-invite ${inviteOpen ? "open" : ""}`} onClick={() => { setInviteOpen((p) => !p); }}><FaUserPlus />Invite User</button>
      </div>

      {error && (<div className="um-error"><FaExclamationTriangle />{error}<button className="um-error-dismiss" onClick={() => setError("")}>&#x2715;</button></div>)}

      {inviteOpen && (<InviteUserPanel api={api} onInviteSuccess={() => { fetchUsers(); }} onClose={() => setInviteOpen(false)} />)}

      <div className="um-controls">
        <div className="um-filter-bar">
          {STATUS_FILTERS.map(({ key, label }) => (<button key={key} className={`um-filter-tab${statusFilter === key ? " active" : ""}`} onClick={() => setStatusFilter(key)}>{label}{!loading && <span className="um-filter-badge">{statusCounts[key]}</span>}</button>))}
        </div>
        <div className="um-search-wrap">
          <FaSearch className="um-search-icon" />
          <input className="um-search-input" type="search" placeholder="Search by name, email, or role…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (<p className="um-state-msg">Loading users…</p>) : filtered.length === 0 ? (
        <div className="um-empty"><FaUsers className="um-empty-icon" /><p>{emptyMessage}</p></div>
      ) : (
        <div className="um-table-wrap">
          <table className="um-table">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
            <tbody>
              {filtered.map((u) => {
                const self = isSelf(u.uid), busy = actionLoading === u.uid, confirming = confirmDeleteId === u.uid, hasPending = pendingRoles[u.uid] !== undefined;
                return (
                  <React.Fragment key={u.uid}>
                    <tr className={["um-row", u.status === "disabled" ? "um-row-disabled" : "", confirming ? "um-row-confirming" : ""].join(" ").trim()}>
                      <td>
                        <div className="um-user-cell">
                          <span className="um-user-name">{u.display_name || <em className="um-no-name">No display name</em>}{self && <span className="um-you-badge">You</span>}</span>
                          <span className="um-user-email">{u.email}</span>
                          {formatInvited(u.invited_at) && <span className="um-user-meta">Invited {formatInvited(u.invited_at)}</span>}
                        </div>
                      </td>
                      <td>
                        {self ? <RoleChip role={u.role} /> : (
                          <div className="um-role-cell">
                            <select className="um-role-select" value={hasPending ? pendingRoles[u.uid] : u.role} disabled={busy} onChange={(e) => setPendingRole(u.uid, e.target.value)} title="Change role">
                              <option value="staff">Staff</option><option value="school_admin">Admin</option>
                            </select>
                            {hasPending && (
                              <div className="um-role-confirm">
                                <button className="um-btn-role-save" disabled={busy} onClick={() => handleRoleSave(u.uid)} title="Save">✓</button>
                                <button className="um-btn-role-cancel" disabled={busy} onClick={() => cancelPendingRole(u.uid)} title="Cancel">✗</button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td><StatusChip status={u.status} /></td>
                      <td className="um-last-login">{u.last_sign_in ? formatDateTime(u.last_sign_in) : "—"}</td>
                      <td>
                        <div className="um-actions">
                          {!self && (
                            <>
                              {u.status === "pending" && (<button className="um-btn-resend" disabled={resendLoading === u.uid} onClick={() => handleResendInvite(u.uid)} title="Resend invite link"><FaRedo style={{ fontSize: 11 }} />{resendLoading === u.uid ? "Sending…" : "Resend"}</button>)}
                              <button className={`um-btn-status ${u.status === "disabled" ? "enable" : "disable"}`} disabled={busy} onClick={() => handleStatusToggle(u.uid, u.status)}>{busy ? "…" : u.status === "disabled" ? "Enable" : "Disable"}</button>
                              <button className="um-btn-delete" disabled={busy} onClick={() => setConfirmDeleteId(confirming ? null : u.uid)} title="Delete user"><FaTrash /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {confirming && (
                      <tr className="um-confirm-row"><td colSpan={5}>
                        <div className="um-confirm-inner">
                          <FaExclamationTriangle className="um-confirm-icon" />
                          <span>Permanently delete <strong>{u.display_name || u.email}</strong>? This cannot be undone.</span>
                          <button className="um-btn-danger" disabled={busy} onClick={() => handleDelete(u.uid)}>{busy ? "Deleting…" : "Yes, delete"}</button>
                          <button className="um-btn-secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        </div>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Resend invite result modal */}
      {resendResult && (
        <div className="um-modal-overlay" onClick={(e) => e.target === e.currentTarget && setResendResult(null)}>
          <div className="um-modal">
            <div className="um-modal-header"><h2 className="um-modal-title">New Invite Link</h2><button className="um-modal-close" onClick={() => setResendResult(null)}>×</button></div>
            <div className="um-modal-body">
              <p className="um-modal-desc">Share this link with <strong>{resendResult.email}</strong>. After setting their password they’ll be redirected to sign in.</p>
              <div className="um-invite-link-row">
                <input className="um-invite-link-input" readOnly value={resendResult.invite_link} onFocus={(e) => e.target.select()} />
                <CopyButton text={resendResult.invite_link} />
              </div>
              <p className="um-invite-link-note">Expires after first use.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
