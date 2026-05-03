import React, { useState, useEffect, useCallback, useMemo } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatDateTime, formatApiError } from "./utils";
import ConfirmDialog from "./ConfirmDialog";
import CopyButton from "./CopyButton";
import InvitePlatformAdminPanel from "./InvitePlatformAdminPanel";
import "./UserManagement.css";

/* Platform-Admin-only management surface — UI parity with the
   school-scoped UserManagement page on purpose so the two access
   surfaces look and feel identical to a Platform Admin moving
   between them.  District/School/Staff CRUD lives at the District
   level; this page is super_admin only and the backend filters the
   list endpoint accordingly. */

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

function StatusChip({ status }) {
  const labels = { active: "Active", pending: "Pending", disabled: "Disabled" };
  return (
    <span className={`um-chip um-chip-${status}`}>{labels[status] ?? status}</span>
  );
}

// Single read-only role chip — every row on this surface is
// super_admin so we don't need a select like UserManagement does.
// Reuses the .um-chip-role-school_admin styling because there's no
// .um-chip-role-super_admin variant in the stylesheet and the
// outline/fill matches the "elevated admin" visual class.
function PlatformAdminChip() {
  return (
    <span className="um-chip um-chip-role-school_admin">
      <I.shield size={11} stroke={2.2} aria-hidden="true" />
      Platform Admin
    </span>
  );
}

// Resend-invite result modal — same shape as UserManagement's, so the
// dialog feels familiar.  Owns its own Esc handler so other Esc
// handlers on the page (e.g. ConfirmDialog) keep working when this
// isn't open.
function ResendInviteModal({ result, onClose }) {
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
        aria-labelledby="pa-resend-title"
      >
        <div className="um-modal-header">
          <h2 id="pa-resend-title" className="um-modal-title">New invite link</h2>
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
          {result.email_sent ? (
            <p className="um-modal-desc">
              Invite email sent to <strong>{result.email}</strong>. Share the link below if it doesn't arrive.
            </p>
          ) : (
            <p
              className="um-modal-desc"
              role="status"
              style={{
                background: "var(--amber-subtle)",
                border: "1px solid var(--amber)",
                borderRadius: "var(--r-md, 6px)",
                color: "var(--amber)",
                padding: "8px 12px",
              }}
            >
              <I.alert size={13} aria-hidden="true" />{" "}
              Couldn't send the invite email to <strong>{result.email}</strong>.
              Share the link below so they can finish setting up.
            </p>
          )}
          <div className="um-invite-link-row">
            <label htmlFor="pa-resend-link" className="sr-only">Invite link</label>
            <input
              id="pa-resend-link"
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

export default function PlatformUsers({ token, currentUser }) {
  const api = useMemo(() => createApiClient(token), [token]);

  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [search, setSearch]     = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [inviteOpen, setInviteOpen] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [actionLoading, setActionLoading]     = useState(null);
  const [resendResult, setResendResult]       = useState(null);
  const [resendLoading, setResendLoading]     = useState(null);
  const [deleteError, setDeleteError]         = useState("");

  const isSelf = useCallback((uid) => uid === currentUser?.uid, [currentUser]);

  const fetchUsers = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .get("/api/v1/admin/platform-users")
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => setError(formatApiError(err, "Failed to load Platform Admins.")))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

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
      (u.email || "").toLowerCase().includes(q)
    );
  }, [users, search, statusFilter]);

  const handleStatusToggle = async (uid, currentStatus) => {
    const newStatus = currentStatus === "disabled" ? "active" : "disabled";
    setActionLoading(uid);
    try {
      await api.patch(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}`, { status: newStatus });
      setUsers((prev) => prev.map((u) => u.uid === uid ? { ...u, status: newStatus } : u));
    } catch (err) {
      setError(formatApiError(err, "Failed to update account status."));
    } finally {
      setActionLoading(null);
    }
  };

  const handleResendInvite = async (uid) => {
    setResendLoading(uid);
    try {
      const res = await api.post(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}/resend-invite`);
      const target = users.find((u) => u.uid === uid);
      setResendResult({
        email: target?.email || "",
        invite_link: res.data.invite_link || "",
        email_sent: !!res.data.email_sent,
      });
    } catch (err) {
      setError(formatApiError(err, "Failed to resend invite."));
    } finally {
      setResendLoading(null);
    }
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    const uid = confirmDeleteId;
    setActionLoading(uid);
    setDeleteError("");
    try {
      await api.delete(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}`);
      setUsers((prev) => prev.filter((u) => u.uid !== uid));
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(formatApiError(err, "Failed to delete user."));
    } finally {
      setActionLoading(null);
    }
  };

  const cancelDelete = () => {
    setConfirmDeleteId(null);
    setDeleteError("");
  };

  const emptyMessage = search
    ? "No Platform Admins match your search."
    : statusFilter === "pending"  ? "No pending invites."
    : statusFilter === "disabled" ? "No disabled accounts."
    : statusFilter === "active"   ? "No active Platform Admins yet."
    : "No Platform Admins yet. Invite your first one.";

  return (
    <div className="um-container page-shell">

      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Platform · admins</span>
          <h1 className="page-title">Platform Users</h1>
          <p className="page-sub">
            Platform Admins have full access across every district, school, and device.
            Invite a peer to share the keys.
          </p>
        </div>
        <div className="page-actions">
          {!loading && (
            <span
              className="page-chip"
              aria-label={`${users.length} Platform Admin${users.length === 1 ? "" : "s"}`}
            >
              <I.users size={12} aria-hidden="true" />
              {users.length.toLocaleString()} {users.length === 1 ? "admin" : "admins"}
            </span>
          )}
          <button
            className={`um-btn-invite ${inviteOpen ? "open" : ""}`}
            onClick={() => setInviteOpen((p) => !p)}
            aria-expanded={inviteOpen}
          >
            <I.plus size={13} aria-hidden="true" />
            Invite Platform Admin
          </button>
        </div>
      </div>

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

      {inviteOpen && (
        <InvitePlatformAdminPanel
          api={api}
          onInviteSuccess={fetchUsers}
          onClose={() => setInviteOpen(false)}
        />
      )}

      <div className="um-controls">
        <div
          className="um-filter-bar"
          role="tablist"
          aria-label="Filter Platform Admins by status"
        >
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              className={`um-filter-tab${statusFilter === key ? " active" : ""}`}
              onClick={() => setStatusFilter(key)}
              role="tab"
              aria-selected={statusFilter === key}
              aria-label={`${label}: ${statusCounts[key] || 0} admins`}
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
          <label htmlFor="pa-search" className="sr-only">Search Platform Admins</label>
          <input
            id="pa-search"
            className="um-search-input"
            type="search"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading Platform Admins…</p>
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
            <caption className="sr-only">Platform Admins</caption>
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
                const self        = isSelf(u.uid);
                const busy        = actionLoading === u.uid;
                const confirming  = confirmDeleteId === u.uid;
                const invitedOn   = formatInvited(u.invited_at);

                return (
                  <tr
                    key={u.uid}
                    className={[
                      "um-row",
                      u.status === "disabled" ? "um-row-disabled" : "",
                      confirming ? "um-row-confirming" : "",
                    ].join(" ").trim()}
                  >
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

                    <td data-label="Role"><PlatformAdminChip /></td>

                    <td data-label="Status"><StatusChip status={u.status} /></td>

                    <td data-label="Last login" className="um-last-login">
                      {u.last_sign_in ? formatDateTime(u.last_sign_in) : "—"}
                    </td>

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
                                aria-label="Resend invite link"
                              >
                                <I.refresh size={11} aria-hidden="true" />
                                <span className="btn-text">{resendLoading === u.uid ? "Sending…" : "Resend"}</span>
                              </button>
                            )}
                            <button
                              className={`um-btn-status ${u.status === "disabled" ? "enable" : "disable"}`}
                              disabled={busy}
                              onClick={() => handleStatusToggle(u.uid, u.status)}
                              title={u.status === "disabled" ? "Enable account" : "Disable account"}
                              aria-label={u.status === "disabled" ? "Enable account" : "Disable account"}
                            >
                              <span className="btn-text">{busy ? "…" : u.status === "disabled" ? "Enable" : "Disable"}</span>
                            </button>
                            <button
                              className="um-btn-delete"
                              disabled={busy}
                              onClick={() => { setConfirmDeleteId(u.uid); setDeleteError(""); }}
                              aria-label={`Delete ${u.display_name || u.email}`}
                              title="Delete user"
                            >
                              <I.trash size={12} aria-hidden="true" /> <span className="btn-text">Delete</span>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
            title="Delete Platform Admin"
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
