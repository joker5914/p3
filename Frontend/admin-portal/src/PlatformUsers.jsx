import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaUsers, FaSync, FaExclamationTriangle } from "react-icons/fa";
import { createApiClient } from "./api";
import "./PlatformAdmin.css";

/* Super-admin-only sweep of every admin/staff record in the system, so
   stale mappings (e.g. a school_admin doc pointing at a dead legacy
   school_id) can be repaired inline instead of via a Firestore console
   session.

   Intentionally kept separate from the campus-scoped UserManagement
   page: that view is for the admins of a specific school and enforces
   their scope; this one is the platform pane of glass. */

const REFRESH_MS = 30_000;

const ROLES = [
  { value: "staff",          label: "Staff" },
  { value: "school_admin",   label: "Admin" },
  { value: "district_admin", label: "District Admin" },
];
const STATUSES = [
  { value: "active",   label: "Active" },
  { value: "pending",  label: "Pending" },
  { value: "disabled", label: "Disabled" },
];

function RoleBadge({ role }) {
  return (
    <span className={`pa-badge pa-badge--${role === "disabled" ? "suspended" : "active"}`}>
      {ROLES.find((r) => r.value === role)?.label || role || "—"}
    </span>
  );
}

function StatusBadge({ status }) {
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

export default function PlatformUsers({ token }) {
  const [users, setUsers]         = useState([]);
  const [schools, setSchools]     = useState([]);
  const [districts, setDistricts] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]         = useState(null);
  const [saving, setSaving]       = useState({});   // uid → true while a PATCH is in flight
  const [rowErr, setRowErr]       = useState({});   // uid → last error string

  const api = useCallback(() => createApiClient(token), [token]);

  const fetchAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const [u, s, d] = await Promise.all([
        api().get("/api/v1/admin/platform-users"),
        api().get("/api/v1/admin/schools"),
        api().get("/api/v1/admin/districts"),
      ]);
      setUsers(u.data.users || []);
      setSchools(s.data.schools || []);
      setDistricts(d.data.districts || []);
    } catch (err) {
      setError(err?.response?.data?.detail || "Failed to load platform users");
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

  const districtIndex = useMemo(() => {
    const m = new Map();
    districts.forEach((d) => m.set(d.id, d));
    return m;
  }, [districts]);

  const patchUser = useCallback(async (uid, body) => {
    setSaving((prev) => ({ ...prev, [uid]: true }));
    setRowErr((prev) => ({ ...prev, [uid]: null }));
    try {
      await api().patch(`/api/v1/admin/platform-users/${encodeURIComponent(uid)}`, body);
      // Re-fetch in the background so resolved district/school names are
      // also refreshed; keeps the UI source-of-truth honest.
      await fetchAll({ silent: true });
    } catch (err) {
      setRowErr((prev) => ({
        ...prev,
        [uid]: err?.response?.data?.detail || "Save failed",
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [uid]: false }));
    }
  }, [api, fetchAll]);

  return (
    <div className="pa-container">
      <div className="pa-header">
        <div className="pa-header-left">
          <h1 className="pa-title">
            <FaUsers style={{ marginRight: 10, opacity: 0.7 }} />
            Platform Users
          </h1>
          <p className="pa-subtitle">
            {users.length} admin{users.length !== 1 ? "s" : ""} across every district ·
            fix stale mappings inline
          </p>
        </div>
        <button
          className="pa-btn-ghost"
          onClick={() => fetchAll()}
          disabled={refreshing}
          title="Refresh"
        >
          <FaSync className={refreshing ? "dev-spin" : ""} /> Refresh
        </button>
      </div>

      {error && <div className="pa-alert"><FaExclamationTriangle /> {error}</div>}

      {loading ? (
        <div className="pa-empty"><p>Loading…</p></div>
      ) : users.length === 0 ? (
        <div className="pa-empty"><p>No admin users on the platform yet.</p></div>
      ) : (
        <div className="pa-card">
          <table className="pa-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>District</th>
                <th>School</th>
                <th>Status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const busy = !!saving[u.uid];
                // School picker is constrained to schools inside the
                // currently selected district — otherwise we'd let a user
                // pick cross-district schools which the backend would
                // then auto-correct.
                const currentDistrictId = u.district_id || null;
                const filteredSchools = schools.filter(
                  (s) => !currentDistrictId || s.district_id === currentDistrictId
                );
                return (
                  <tr key={u.uid} className="pa-row">
                    <td data-label="Name">
                      <div className="pa-school-name">{u.display_name || "—"}</div>
                      {u.uid && (
                        <div className="pa-school-email" style={{ fontFamily: "var(--mono, ui-monospace, monospace)", opacity: 0.6 }}>
                          {u.uid.slice(0, 12)}…
                        </div>
                      )}
                    </td>
                    <td data-label="Email">{u.email || "—"}</td>
                    <td data-label="Role">
                      <select
                        className="pa-select"
                        value={u.role || "staff"}
                        disabled={busy}
                        onChange={(e) => patchUser(u.uid, { role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="District">
                      <select
                        className="pa-select"
                        value={u.district_id || ""}
                        disabled={busy}
                        onChange={(e) => patchUser(u.uid, {
                          district_id: e.target.value,
                          // Changing district invalidates any school link
                          // it was anchored to; clear so the user must
                          // explicitly repick.
                          school_id: "",
                        })}
                      >
                        <option value="">— unassigned —</option>
                        {districts.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="School">
                      <select
                        className="pa-select"
                        value={u.school_id || ""}
                        disabled={busy || u.role === "district_admin"}
                        onChange={(e) => patchUser(u.uid, { school_id: e.target.value })}
                        title={u.role === "district_admin" ? "District admins aren't pinned to a school" : undefined}
                      >
                        <option value="">— unassigned —</option>
                        {filteredSchools.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Status">
                      <select
                        className="pa-select"
                        value={u.status || "active"}
                        disabled={busy}
                        onChange={(e) => patchUser(u.uid, { status: e.target.value })}
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Last seen">{formatRelative(u.last_sign_in)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Any per-row save errors surface below the table.  Rare but
          important — we never want a silent failure on a reassignment. */}
      {Object.entries(rowErr).filter(([, v]) => v).map(([uid, msg]) => (
        <div key={uid} className="pa-alert" style={{ marginTop: 8 }}>
          <strong>{uid.slice(0, 8)}…</strong> {msg}
        </div>
      ))}
    </div>
  );
}
