import React, { useState, useEffect, useCallback, useMemo } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatDateTime } from "./utils";
import ConfirmDialog from "./ConfirmDialog";
import "./UserManagement.css";

const ROLE_LABELS = {
  district_admin: "District Admin",
  school_admin:   "Admin",
  staff:          "Staff",
};

const STATUS_FILTERS = [
  { key: "all",      label: "All"      },
  { key: "active",   label: "Active"   },
  { key: "pending",  label: "Pending"  },
  { key: "disabled", label: "Disabled" },
];

function formatInvited(isoStr) {
  if (!isoStr) return null;
  try {
    return new Date(isoStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return null; }
}

// ── Status chip ────────────────────────────────────────────────────────────
function StatusChip({ status }) {
  const labels = { active: "Active", pending: "Pending", disabled: "Disabled" };
  return (
    <span className={`um-chip um-chip-${status}`}>{labels[status] ?? status}</span>
  );
}

// ── Role badge ─────────────────────────────────────────────────────────────
function RoleChip({ role }) {
  return (
    <span className={`um-chip um-chip-role-${role}`}>
      {role === "school_admin" || role === "district_admin"
        ? <I.shield size={11} stroke={2.2} aria-hidden="true" />
        : <I.user   size={11} stroke={2.2} aria-hidden="true" />}
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

// ── Resend-invite modal (role="dialog" with Escape + autofocus) ──────────
function ResendInviteModal({ result, onClose }) {
  // Escape closes the modal — standard dialog behaviour expected by AT users.
  // The modal backdrop also captures clicks outside the panel.
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="um-modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="um-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="um-resend-title"
      >
        <div className="um-modal-header">
          <h2 id="um-resend-title" className="um-modal-title">New Invite Link</h2>
          <button
            className="um-modal-close"
            onClick={onClose}
            aria-label="Close dialog"
            autoFocus
          >
            <I.x size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="um-modal-body">
          <p className="um-modal-desc">
            {result.email_sent ? (
              <>Invite email sent to <strong>{result.email}</strong>. Share the link below if it doesn't arrive.</>
            ) : (
              <>Share this link with <strong>{result.email}</strong>. After setting their password they'll be redirected to sign in.</>
            )}
          </p>
          <div className="um-invite-link-row">
            <label htmlFor="um-resend-link" className="sr-only">
              Invite link
            </label>
            <input
              id="um-resend-link"
              className="um-invite-link-input"
              readOnly
              value={result.invite_link}
              onFocus={(e) => e.target.select()}
            />
            <CopyButton text={result.invite_link} />
          </div>
          <p className="um-invite-link-note">Expires after first use.</p>
        </div>
      </div>
    </div>
  );
}

// ── Copy-to-clipboard button ───────────────────────────────────────────────
function CopyButton({ text, label = "Copy link" }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  return (
    <button
      className="um-btn-copy"
      onClick={handleCopy}
      aria-label={copied ? "Link copied" : "Copy invite link"}
      title="Copy invite link"
    >
      {copied
        ? <I.check size={13} stroke={2.4} aria-hidden="true" />
        : <I.copy  size={13} aria-hidden="true" />}
      {copied ? "Copied!" : label}
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function UserManagement({ token, currentUser, schoolId = null, onViewActivity = null }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [search, setSearch]     = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Invite panel state
  const [inviteOpen, setInviteOpen]   = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName]   = useState("");
  const [inviteRole, setInviteRole]   = useState("staff");
  const [inviting, setInviting]       = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteResult, setInviteResult] = useState(null); // { email, invite_link }

  // Inline action state
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [actionLoading, setActionLoading]     = useState(null);
  const [pendingRoles, setPendingRoles]       = useState({}); // { [uid]: newRole }

  // Resend invite modal
  const [resendResult, setResendResult]   = useState(null);
  const [resendLoading, setResendLoading] = useState(null);

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

  // ── Derived lists ─────────────────────────────────────────────────────
  const statusCounts = useMemo(() => ({
    all:      users.length,
    active:   users.filter((u) => u.status === "active").length,
    pending:  users.filter((u) => u.status === "pending").length,
    disabled: users.filter((u) => u.status === "disabled").length,
  }), [users]);

  const filtered = useMemo(() => {
    let list = statusFilter === "all"
      ? users
      : users.filter((u) => u.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((u) =>
      (u.display_name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (ROLE_LABELS[u.role] || "").toLowerCase().includes(q)
    );
  }, [users, search, statusFilter]);

  // ── Invite submit ─────────────────────────────────────────────────────
  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setInviteError("");
    setInviteResult(null);
    try {
      const res = await api.post("/api/v1/users/invite", {
        email: inviteEmail.trim(),
        display_name: inviteName.trim(),
        role: inviteRole,
      });
      setInviteResult({
        email: inviteEmail.trim(),
        invite_link: res.data.invite_link || "",
        email_sent: !!res.data.email_sent,
      });
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

  // ── Role change (two-step) ────────────────────────────────────────────
  const setPendingRole = (uid, newRole) =>
    setPendingRoles((prev) => ({ ...prev, [uid]: newRole }));

  const cancelPendingRole = (uid) =>
    setPendingRoles((prev) => { const n = { ...prev }; delete n[uid]; return n; });

  const handleRoleSave = async (uid) => {
    const newRole = pendingRoles[uid];
    if (!newRole) return;
    setActionLoading(uid);
    try {
      await api.patch(`/api/v1/users/${uid}/role`, { role: newRole });
      setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, role: newRole } : u));
      cancelPendingRole(uid);
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
      setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, status: newStatus } : u));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update account status.");
    } finally {
      setActionLoading(null);
    }
  };

  // ── Resend invite ─────────────────────────────────────────────────────
  const handleResendInvite = async (uid) => {
    setResendLoading(uid);
    try {
      const res = await api.post(`/api/v1/users/${uid}/resend-invite`);
      setResendResult({
        email: res.data.email,
        invite_link: res.data.invite_link,
        email_sent: !!res.data.email_sent,
      });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to resend invite.");
    } finally {
      setResendLoading(null);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────
  // Two-step via the shared <ConfirmDialog>.  The trash button stages
  // confirmDeleteId; ConfirmDialog onConfirm runs the API call.
  // Replaces the previous inline confirmation row that was inserted
  // below the data row — that pattern was unique to UserManagement
  // and didn't match the modal-based delete UX every other admin
  // table uses.  deleteError surfaces inside the modal so a failed
  // delete doesn't push the user back to the page-level error banner.
  const [deleteError, setDeleteError] = useState("");

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    const uid = confirmDeleteId;
    setActionLoading(uid);
    setDeleteError("");
    try {
      await api.delete(`/api/v1/users/${uid}`);
      setUsers((prev) => prev.filter((u) => u.uid !== uid));
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err.response?.data?.detail || "Failed to delete user.");
    } finally {
      setActionLoading(null);
    }
  };

  const cancelDelete = () => {
    setConfirmDeleteId(null);
    setDeleteError("");
  };

  // ── Empty state message ───────────────────────────────────────────────
  const emptyMessage = search
    ? "No users match your search."
    : statusFilter === "pending"  ? "No pending invites."
    : statusFilter === "disabled" ? "No disabled accounts."
    : statusFilter === "active"   ? "No active users yet."
    : "No users yet. Invite your first team member.";

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="um-container page-shell">

      {/* Header — eyebrow + display headline + count chip + invite CTA */}
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Access · users</span>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">
            Staff, admins, and district admins with portal access. Invite a teammate to get them going.
          </p>
        </div>
        <div className="page-actions">
          {!loading && (
            <span className="page-chip" aria-label={`${users.length} users`}>
              <I.users size={12} aria-hidden="true" />
              {users.length.toLocaleString()} {users.length === 1 ? "user" : "users"}
            </span>
          )}
          <button
            className={`um-btn-invite ${inviteOpen ? "open" : ""}`}
            onClick={() => { setInviteOpen((p) => !p); setInviteResult(null); setInviteError(""); }}
            aria-expanded={inviteOpen}
          >
            <I.plus size={13} aria-hidden="true" />
            Invite User
          </button>
        </div>
      </div>

      {/* Global error */}
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

      {/* Invite panel */}
      {inviteOpen && (
        <div className="um-invite-panel">
          <h2 className="um-invite-title">Invite a team member</h2>
          <p className="um-invite-subtitle">
            We'll generate a secure link they can use to set their password and sign in.
          </p>

          {inviteResult ? (
            <div className="um-invite-success">
              <p className="um-invite-success-label">
                <I.checkCircle size={16} stroke={2.2} className="um-invite-success-icon" aria-hidden="true" />
                Account created for <strong>{inviteResult.email}</strong>
              </p>
              {inviteResult.email_sent && (
                <p className="um-invite-link-note" style={{ color: "var(--on-green, #22863a)" }}>
                  Invite email sent to <strong>{inviteResult.email}</strong>. If they
                  don't receive it, share the link below as a backup.
                </p>
              )}
              {inviteResult.invite_link ? (
                <>
                  <div className="um-invite-link-row">
                    <input
                      className="um-invite-link-input"
                      readOnly
                      value={inviteResult.invite_link}
                      onFocus={(e) => e.target.select()}
                    />
                    <CopyButton text={inviteResult.invite_link} />
                  </div>
                  <p className="um-invite-link-note">
                    {inviteResult.email_sent
                      ? "Backup link in case the email doesn't arrive."
                      : "Share this link so they can set their password. After setting it, they'll be redirected to the sign-in page — they must sign in with their email and new password to access the app."}
                  </p>
                </>
              ) : (
                <p className="um-invite-link-note">
                  Account created. Ask them to use the "Forgot password" link on the
                  sign-in page to set their password.
                </p>
              )}
              <button className="um-btn-secondary" onClick={() => setInviteResult(null)}>
                Invite another
              </button>
            </div>
          ) : (
            <form className="um-invite-form" onSubmit={handleInvite}>
              <div className="um-form-row">
                <div className="um-field">
                  <label className="um-label" htmlFor="um-invite-email">
                    Email address <span className="um-required" aria-label="required">*</span>
                  </label>
                  <input
                    id="um-invite-email"
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
                  <label className="um-label" htmlFor="um-invite-name">Display name</label>
                  <input
                    id="um-invite-name"
                    className="um-input"
                    type="text"
                    placeholder="Jane Smith"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    disabled={inviting}
                  />
                </div>
              </div>

              <fieldset className="um-field um-field-role">
                <legend className="um-label">Role</legend>
                <div className="um-role-options">
                  {[
                    { value: "staff", icon: I.user, label: "Staff",
                      desc: "View dashboard, history, and reports. Cannot manage users or import data.",
                      roles: ["super_admin", "district_admin", "school_admin"] },
                    { value: "school_admin", icon: I.shield, label: "Admin",
                      desc: "Full access including user management, data import, and registry edits.",
                      roles: ["super_admin", "district_admin", "school_admin"] },
                    { value: "district_admin", icon: I.shield, label: "District Admin",
                      desc: "Manages every school and device in this district. Only Platform Admins can grant this role.",
                      roles: ["super_admin"] },
                  ]
                    .filter(({ roles }) => roles.includes(currentUser?.role))
                    .map(({ value, icon, label, desc }) => {
                      const Icon = icon;
                      return (
                        <label key={value} className={`um-role-option ${inviteRole === value ? "selected" : ""}`}>
                          <input
                            type="radio"
                            name="inviteRole"
                            value={value}
                            checked={inviteRole === value}
                            onChange={() => setInviteRole(value)}
                            disabled={inviting}
                          />
                          <Icon size={16} stroke={2} className="um-role-icon" aria-hidden="true" />
                          <div>
                            <strong>{label}</strong>
                            <p>{desc}</p>
                          </div>
                        </label>
                      );
                    })}
                </div>
              </fieldset>

              {inviteError && <p className="um-field-error" role="alert">{inviteError}</p>}

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

      {/* Filter tabs + search */}
      <div className="um-controls">
        <div
          className="um-filter-bar"
          role="tablist"
          aria-label="Filter users by status"
        >
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              className={`um-filter-tab${statusFilter === key ? " active" : ""}`}
              onClick={() => setStatusFilter(key)}
              role="tab"
              aria-selected={statusFilter === key}
              aria-label={`${label}: ${statusCounts[key] || 0} users`}
            >
              {label}
              {!loading && (
                <span className="um-filter-badge" aria-hidden="true">{statusCounts[key]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="um-search-wrap" role="search">
          <I.search size={14} className="um-search-icon" aria-hidden="true" />
          <label htmlFor="um-search" className="sr-only">Search users</label>
          <input
            id="um-search"
            className="um-search-input"
            type="search"
            placeholder="Search by name, email, or role…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading users…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.users size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">{emptyMessage}</p>
          {statusFilter === "pending" && users.length > 0 && (
            <button className="um-btn-secondary" style={{ marginTop: 4 }} onClick={() => setInviteOpen(true)}>
              Invite someone
            </button>
          )}
        </div>
      ) : (
        <div className="um-table-wrap">
          <table className="um-table">
            <caption className="sr-only">Users and their roles</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Last login</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const self      = isSelf(u.uid);
                const busy      = actionLoading === u.uid;
                const confirming = confirmDeleteId === u.uid;
                const hasPending = pendingRoles[u.uid] !== undefined;
                const invitedOn  = formatInvited(u.invited_at);

                return (
                  <React.Fragment key={u.uid}>
                    <tr className={[
                      "um-row",
                      u.status === "disabled" ? "um-row-disabled" : "",
                      confirming ? "um-row-confirming" : "",
                    ].join(" ").trim()}>

                      {/* Name + email + invited date */}
                      <td data-label="Name">
                        <div className="um-user-cell">
                          <span className="um-user-name">
                            {u.display_name || <em className="um-no-name">No display name</em>}
                            {self && <span className="um-you-badge">You</span>}
                          </span>
                          <span className="um-user-email">{u.email}</span>
                          {invitedOn && (
                            <span className="um-user-meta">Invited {invitedOn}</span>
                          )}
                        </div>
                      </td>

                      {/* Role — two-step change for non-self */}
                      <td data-label="Role">
                        {self ? (
                          <RoleChip role={u.role} />
                        ) : (
                          <div className="um-role-cell">
                            <select
                              className="um-role-select"
                              value={hasPending ? pendingRoles[u.uid] : u.role}
                              disabled={busy}
                              onChange={(e) => setPendingRole(u.uid, e.target.value)}
                              title="Change role"
                            >
                              <option value="staff">Staff</option>
                              <option value="school_admin">Admin</option>
                              {currentUser?.role === "super_admin" && (
                                <option value="district_admin">District Admin</option>
                              )}
                            </select>
                            {hasPending && (
                              <div className="um-role-confirm">
                                <button
                                  className="um-btn-role-save"
                                  disabled={busy}
                                  onClick={() => handleRoleSave(u.uid)}
                                  aria-label={`Save role change to ${pendingRoles[u.uid]} for ${u.display_name || u.email}`}
                                  title="Save"
                                ><I.check size={12} stroke={2.6} aria-hidden="true" /></button>
                                <button
                                  className="um-btn-role-cancel"
                                  disabled={busy}
                                  onClick={() => cancelPendingRole(u.uid)}
                                  aria-label="Cancel role change"
                                  title="Cancel"
                                ><I.x size={12} stroke={2.6} aria-hidden="true" /></button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Status */}
                      <td data-label="Status"><StatusChip status={u.status} /></td>

                      {/* Last login */}
                      <td data-label="Last login" className="um-last-login">
                        {u.last_sign_in ? formatDateTime(u.last_sign_in) : "—"}
                      </td>

                      {/* Actions */}
                      <td data-label="Actions">
                        <div className="um-actions">
                          {!self && (
                            <>
                              {u.status === "pending" && (
                                <button
                                  className="um-btn-resend"
                                  disabled={resendLoading === u.uid}
                                  onClick={() => handleResendInvite(u.uid)}
                                  title="Resend invite link"
                                >
                                  <I.refresh size={11} aria-hidden="true" />
                                  {resendLoading === u.uid ? "Sending…" : "Resend"}
                                </button>
                              )}
                              {onViewActivity && (
                                <button
                                  className="um-btn-activity"
                                  onClick={() => onViewActivity(u.uid, u.display_name || u.email)}
                                  aria-label={`View activity for ${u.display_name || u.email}`}
                                  title="View activity"
                                >
                                  <I.history size={11} aria-hidden="true" />
                                  Activity
                                </button>
                              )}
                              <button
                                className={`um-btn-status ${u.status === "disabled" ? "enable" : "disable"}`}
                                disabled={busy}
                                onClick={() => handleStatusToggle(u.uid, u.status)}
                                title={u.status === "disabled" ? "Enable account" : "Disable account"}
                              >
                                {busy ? "…" : u.status === "disabled" ? "Enable" : "Disable"}
                              </button>
                              <button
                                className="um-btn-delete"
                                disabled={busy}
                                onClick={() => { setConfirmDeleteId(u.uid); setDeleteError(""); }}
                                aria-label={`Delete ${u.display_name || u.email}`}
                                title="Delete user"
                              >
                                <I.trash size={12} aria-hidden="true" /> Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Inline confirmation row removed — replaced by
                        the shared <ConfirmDialog> mounted below.  The
                        `um-row-confirming` class on the data row above
                        still applies a subtle row tint while the modal
                        is open as a visual cue for which row is being
                        confirmed. */}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Resend invite result modal */}
      {resendResult && (
        <ResendInviteModal
          result={resendResult}
          onClose={() => setResendResult(null)}
        />
      )}

      {(() => {
        const u = users.find((x) => x.uid === confirmDeleteId);
        return (
          <ConfirmDialog
            open={!!u}
            title="Delete user"
            prompt={u && (
              <>Permanently delete <strong>{u.display_name || u.email}</strong>?</>
            )}
            warning="The account is removed and cannot be restored. They lose access immediately and any sessions in flight are revoked."
            destructive
            confirmLabel="Delete user"
            busyLabel="Deleting…"
            busy={actionLoading === confirmDeleteId}
            error={deleteError}
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
            confirmIcon={<I.trash size={12} aria-hidden="true" />}
          />
        );
      })()}
    </div>
  );
}
