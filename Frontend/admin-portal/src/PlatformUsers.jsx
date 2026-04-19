import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaUsers, FaSync, FaExclamationTriangle, FaCaretDown } from "react-icons/fa";
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
  { value: "super_admin",    label: "Platform Admin" },
  { value: "district_admin", label: "District Admin" },
  { value: "school_admin",   label: "Admin" },
  { value: "staff",          label: "Staff" },
];
const STATUSES = [
  { value: "active",   label: "Active" },
  { value: "pending",  label: "Pending" },
  { value: "disabled", label: "Disabled" },
];

// Single-line trigger that opens a popover with checkboxes — one row
// height, fits any count, no layout thrash when schools are added.
// Parent owns the value; we just emit onChange(nextIds) on each toggle.
function SchoolMultiSelect({ value, schoolNames, options, disabled, placeholder, onChange }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);  // { top, left, width } for fixed-pos popover
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  // Position the popover using fixed coords so it escapes the scroll
  // container's overflow:hidden; recompute on scroll/resize.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();

    const handleClick = (e) => {
      const insideTrigger = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePopover = popoverRef.current && popoverRef.current.contains(e.target);
      if (!insideTrigger && !insidePopover) setOpen(false);
    };
    const handleKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const handleScroll = () => setOpen(false);
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open]);

  const resolvedName = (id) => {
    const fromBackend = (schoolNames || []).find((s) => s.id === id)?.name;
    if (fromBackend) return fromBackend;
    const fromOptions = (options || []).find((s) => s.id === id)?.name;
    return fromOptions || id;
  };

  const toggle = (id) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  };

  const summary = value.length === 0
    ? (placeholder || "— unassigned —")
    : value.length === 1
      ? resolvedName(value[0])
      : `${resolvedName(value[0])} +${value.length - 1}`;

  return (
    <div className="pa-school-multi" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-school-trigger${value.length === 0 ? " empty" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={
          value.length > 0
            ? value.map(resolvedName).join(", ")
            : (placeholder || "Pick schools")
        }
      >
        <span className="pa-school-summary">{summary}</span>
        <FaCaretDown className="pa-school-caret" />
      </button>

      {open && !disabled && anchor && (
        <div
          ref={popoverRef}
          className="pa-school-popover"
          style={{ top: anchor.top, left: anchor.left, minWidth: anchor.width }}
        >
          {(!options || options.length === 0) ? (
            <div className="pa-school-popover-empty">
              {placeholder || "No schools available"}
            </div>
          ) : (
            <ul className="pa-school-check-list">
              {options.map((s) => {
                const checked = value.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className={`pa-school-check-row${checked ? " checked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.id)}
                      />
                      <span>{s.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}


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
                const isSuper    = u.role === "super_admin";
                const isDistrict = u.role === "district_admin";
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
                        onChange={(e) => {
                          const next = e.target.value;
                          // Promoting to Platform Admin implicitly clears
                          // district+school; the backend also enforces
                          // this but sending them explicitly makes the UI
                          // state crystal clear in the PATCH.
                          const body = next === "super_admin"
                            ? { role: next, district_id: "", school_id: "" }
                            : { role: next };
                          patchUser(u.uid, body);
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="District">
                      {isSuper ? (
                        <span className="pa-badge pa-badge--active">All Districts</span>
                      ) : (
                        <select
                          className="pa-select"
                          value={u.district_id || ""}
                          disabled={busy}
                          onChange={(e) => patchUser(u.uid, {
                            district_id: e.target.value,
                            // Changing district invalidates any school
                            // link; clear so the user must explicitly
                            // repick inside the new district.
                            school_id: "",
                          })}
                        >
                          <option value="">— unassigned —</option>
                          {districts.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td data-label="School">
                      {isSuper ? (
                        <span className="pa-badge pa-badge--active">All Locations</span>
                      ) : isDistrict ? (
                        <span className="pa-badge pa-badge--active" title="District admins manage every school in their district">
                          District-wide
                        </span>
                      ) : (
                        <SchoolMultiSelect
                          value={u.school_ids || (u.school_id ? [u.school_id] : [])}
                          schoolNames={u.school_names || []}
                          options={filteredSchools}
                          disabled={busy || !currentDistrictId}
                          placeholder={
                            currentDistrictId
                              ? "Pick one or more schools"
                              : "Assign a district first"
                          }
                          onChange={(nextIds) =>
                            patchUser(u.uid, { school_ids: nextIds })
                          }
                        />
                      )}
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
