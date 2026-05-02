import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaUsers, FaSync, FaExclamationTriangle } from "react-icons/fa";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import ConfirmDialog from "./ConfirmDialog";
import InvitePlatformAdminPanel from "./InvitePlatformAdminPanel";
import "./PlatformAdmin.css";

/* Platform-Admin-only management surface.

   The single page where a Platform Admin (super_admin) can invite,
   view, status-toggle, resend invites for, and delete other Platform
   Admins.  District Admins / Admins / Staff are intentionally NOT
   surfaced here — those roles live at the District level and are
   managed via the school-scoped invite/CRUD flow in UserManagement.
   Keeping the two surfaces separate prevents this screen from
   accidentally becoming a "fix any user anywhere" pane that hides
   cross-tenant edits behind a single button. */

const REFRESH_MS = 30_000;

// Only the two states the dropdown should expose.  "pending" is a
// transient state managed automatically (set on invite, cleared on
// first sign-in) — exposing it in the dropdown would let a Platform
// Admin "demote" an active user back to pending, which has no
// well-defined meaning.
const STATUSES = [
  { value: "active",   label: "Active" },
  { value: "disabled", label: "Disabled" },
];

function StatusBadge({ status }) {
  if (status === "pending") {
    return <span className="pa-badge pa-badge--suspended">Pending invite</span>;
  }
  const active = status === "active";
  return (
    <span className={`pa-badge pa-badge--${active ? "active" : "suspended"}`}>
      {status || "—"}
    </span>
  );
}

function formatRelative(iso) {
  if (!iso) return "—";
  const ts = new Date(iso);
  if (isNaN(ts.getTime())) return "—";
  const delta = Date.now() - ts.getTime();
  const m = Math.round(delta / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function PlatformUsers({ token, currentUser }) {
  const [users, setUsers]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]         = useState(null);
  const [saving, setSaving]       = useState({});   // uid → true while a PATCH/DELETE is in flight
  const [rowErr, setRowErr]       = useState({});   // uid → last error string
  const [rowMsg, setRowMsg]       = useState({});   // uid → transient success message (e.g. "Invite re-sent")

  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // { uid, label } | null
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const api = useCallback(() => createApiClient(token), [token]);

  const fetchAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const u = await api().get("/api/v1/admin/platform-users");
      setUsers(u.data.users || []);
    } catch (err) {
      setError(formatApiError(err, "Failed to load Platform Admins"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(() => fetchAll({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  const patchUser = useCallback(async (uid, body) => {
    setSaving((prev) => ({ ...prev, [uid]: true }));
    setRowErr((prev) => ({ ...prev, [uid]: null }));
    try {
      await api().patch(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}`, body);
      await fetchAll({ silent: true });
    } catch (err) {
      setRowErr((prev) => ({ ...prev, [uid]: formatApiError(err, "Save failed") }));
    } finally {
      setSaving((prev) => ({ ...prev, [uid]: false }));
    }
  }, [api, fetchAll]);

  const resendInvite = useCallback(async (uid) => {
    setSaving((prev) => ({ ...prev, [uid]: true }));
    setRowErr((prev) => ({ ...prev, [uid]: null }));
    setRowMsg((prev) => ({ ...prev, [uid]: null }));
    try {
      const res = await api().post(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}/resend-invite`);
      const sent = !!res.data?.email_sent;
      setRowMsg((prev) => ({
        ...prev,
        [uid]: sent ? "Invite email re-sent." : "Invite link refreshed (email not configured).",
      }));
      // Auto-clear the inline confirmation after a few seconds so the
      // table doesn't accumulate stale "re-sent" notes.
      setTimeout(() => {
        setRowMsg((prev) => ({ ...prev, [uid]: null }));
      }, 5000);
    } catch (err) {
      setRowErr((prev) => ({ ...prev, [uid]: formatApiError(err, "Resend failed") }));
    } finally {
      setSaving((prev) => ({ ...prev, [uid]: false }));
    }
  }, [api]);

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api().delete(`/api/v1/admin/platform-users/${encodeURIComponent(confirmDelete.uid)}`);
      setConfirmDelete(null);
      await fetchAll({ silent: true });
    } catch (err) {
      setDeleteError(formatApiError(err, "Delete failed"));
    } finally {
      setDeleteBusy(false);
    }
  }, [api, confirmDelete, fetchAll]);

  const inviteApi = useMemo(() => api(), [api]);
  const callerUid = currentUser?.uid;

  return (
    <div className="pa-container">
      <div className="pa-header">
        <div className="pa-header-left">
          <h1 className="pa-title">
            <FaUsers style={{ marginRight: 10, opacity: 0.7 }} />
            Platform Users
          </h1>
          <p className="pa-subtitle">
            {users.length} Platform Admin{users.length !== 1 ? "s" : ""} ·
            full access across every district and school
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pa-btn-ghost"
            onClick={() => fetchAll()}
            disabled={refreshing}
            title="Refresh"
          >
            <FaSync className={refreshing ? "dev-spin" : ""} /> Refresh
          </button>
          <button
            className="pa-btn-primary"
            onClick={() => setInviteOpen(true)}
          >
            <I.plus size={14} aria-hidden="true" /> Invite Platform Admin
          </button>
        </div>
      </div>

      {error && <div className="pa-alert"><FaExclamationTriangle /> {error}</div>}

      {loading ? (
        <div className="pa-empty"><p>Loading…</p></div>
      ) : users.length === 0 ? (
        <div className="pa-empty">
          <p>No Platform Admins yet. Use <strong>Invite Platform Admin</strong> to create the first one.</p>
        </div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col">Last seen</th>
                <th scope="col" style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const busy = !!saving[u.uid];
                const isSelf = u.uid === callerUid;
                const isPending = u.status === "pending";
                return (
                  <tr key={u.uid} className="pa-row">
                    <td data-label="Name">
                      <div className="pa-school-name">
                        {u.display_name || "—"}
                        {isSelf && (
                          <span className="pa-badge pa-badge--active" style={{ marginLeft: 8 }}>
                            You
                          </span>
                        )}
                      </div>
                      {u.uid && (
                        <div className="pa-school-email" style={{ fontFamily: "var(--mono, ui-monospace, monospace)", opacity: 0.6 }}>
                          {u.uid.slice(0, 12)}…
                        </div>
                      )}
                    </td>
                    <td data-label="Email">{u.email || "—"}</td>
                    <td data-label="Status">
                      {isPending ? (
                        <StatusBadge status="pending" />
                      ) : (
                        <select
                          className="pa-select"
                          value={u.status || "active"}
                          disabled={busy || isSelf}
                          title={isSelf ? "You can't change your own status" : ""}
                          onChange={(e) => patchUser(u.uid, { status: e.target.value })}
                        >
                          {STATUSES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td data-label="Last seen">{formatRelative(u.last_sign_in)}</td>
                    <td data-label="Actions" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {isPending && (
                        <button
                          type="button"
                          className="pa-btn-ghost"
                          onClick={() => resendInvite(u.uid)}
                          disabled={busy}
                          title="Re-send the invite email"
                          style={{ marginRight: 6 }}
                        >
                          <I.envelope size={13} aria-hidden="true" /> Resend
                        </button>
                      )}
                      <button
                        type="button"
                        className="pa-btn-ghost"
                        onClick={() => {
                          setDeleteError("");
                          setConfirmDelete({
                            uid: u.uid,
                            label: u.display_name || u.email || u.uid,
                          });
                        }}
                        disabled={busy || isSelf}
                        title={isSelf ? "You can't delete your own account" : "Delete this Platform Admin"}
                        style={{ color: isSelf ? undefined : "var(--danger, #d04545)" }}
                      >
                        <I.trash size={13} aria-hidden="true" /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-row save / resend feedback.  Errors stay until the next
          mutation; success messages auto-clear after 5s. */}
      {Object.entries(rowErr).filter(([, v]) => v).map(([uid, msg]) => (
        <div key={`err-${uid}`} className="pa-alert" style={{ marginTop: 8 }}>
          <strong>{uid.slice(0, 8)}…</strong> {msg}
        </div>
      ))}
      {Object.entries(rowMsg).filter(([, v]) => v).map(([uid, msg]) => (
        <div
          key={`msg-${uid}`}
          className="pa-alert"
          style={{
            marginTop: 8,
            background: "var(--surface-success, rgba(40,160,80,0.12))",
            color: "var(--on-green, #22863a)",
            borderColor: "var(--on-green, #22863a)",
          }}
        >
          <I.checkCircle size={14} aria-hidden="true" />{" "}
          <strong>{uid.slice(0, 8)}…</strong> {msg}
        </div>
      ))}

      {/* Invite Platform Admin modal. */}
      {inviteOpen && (
        <div
          className="pa-modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setInviteOpen(false)}
        >
          <div className="pa-modal" role="dialog" aria-modal="true" aria-labelledby="pa-invite-title">
            <div className="pa-modal-header">
              <h2 id="pa-invite-title" className="pa-modal-title">Invite Platform Admin</h2>
              <button
                className="pa-modal-close"
                onClick={() => setInviteOpen(false)}
                aria-label="Close dialog"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <InvitePlatformAdminPanel
              api={inviteApi}
              onInviteSuccess={() => fetchAll({ silent: true })}
              onClose={() => setInviteOpen(false)}
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Platform Admin"
        prompt={
          confirmDelete
            ? `Permanently delete ${confirmDelete.label}? They will lose access immediately and their account will be removed.`
            : ""
        }
        warning="This cannot be undone. Their sign-in account is also deleted, so re-granting access requires a fresh invite."
        destructive
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!deleteBusy) {
            setConfirmDelete(null);
            setDeleteError("");
          }
        }}
        confirmIcon={<I.trash size={12} aria-hidden="true" />}
      />
    </div>
  );
}
