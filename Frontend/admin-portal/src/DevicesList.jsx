import React, { useCallback, useEffect, useState } from "react";
import { FaMicrochip, FaSync, FaPencilAlt, FaCheck, FaTimes } from "react-icons/fa";
import { createApiClient } from "./api";
import "./DevicesList.css";

// Poll every 30 s so the online/offline badge + health telemetry reflect
// real heartbeat state without the admin having to reload.
const REFRESH_MS = 30_000;

function formatUptime(sec) {
  if (!sec || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function cpuTempTone(t) {
  if (t == null) return "muted";
  if (t >= 80) return "red";
  if (t >= 70) return "orange";
  return "green";
}

function HealthCell({ device }) {
  const cpu = device.health_cpu_temp_c;
  const memTotal = device.health_memory_total_mb;
  const memUsed = device.health_memory_used_mb;
  const uptime = device.health_uptime_seconds;
  const scanner = device.health_service_scanner;
  const watchdog = device.health_service_watchdog;
  const reportedAt = device.health_reported_at;

  // Nothing reported yet → this device is on an older firmware or hasn't
  // heartbeated once since the upgrade.
  if (cpu == null && memTotal == null && uptime == null) {
    return <span className="dev-health-none">—</span>;
  }

  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : null;
  const scannerOk = scanner === "active";
  const watchdogOk = watchdog === "active";

  return (
    <div className="dev-health" title={reportedAt ? `Reported ${reportedAt}` : ""}>
      {cpu != null && (
        <span className={`dev-health-chip dev-health-chip--${cpuTempTone(cpu)}`}>
          {cpu.toFixed(1)}°C
        </span>
      )}
      {memPct != null && (
        <span className="dev-health-chip dev-health-chip--muted">
          {memPct}% mem
        </span>
      )}
      {uptime != null && (
        <span className="dev-health-chip dev-health-chip--muted">
          ↑ {formatUptime(uptime)}
        </span>
      )}
      {(scanner || watchdog) && (
        <span
          className={`dev-health-svc ${scannerOk && watchdogOk ? "ok" : "bad"}`}
          title={`scanner: ${scanner || "?"} · watchdog: ${watchdog || "?"}`}
        >
          {scannerOk && watchdogOk ? "✓ services" : "⚠ services"}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const isOnline = status === "online";
  return (
    <span className={`dev-badge dev-badge--${isOnline ? "online" : "offline"}`}>
      <span className="dev-badge-dot" />
      {isOnline ? "Online" : "Offline"}
    </span>
  );
}

function formatRelative(iso) {
  if (!iso) return "—";
  const ts = new Date(iso);
  if (isNaN(ts.getTime())) return "—";
  const deltaMs = Date.now() - ts.getTime();
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function SchoolCell({ hostname, schoolId, schoolName, schools, onChange }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = async (e) => {
    const next = e.target.value;
    setSaving(true);
    setError(null);
    try {
      // Empty-string = explicit unassign; backend accepts it.
      await onChange(hostname, next);
    } catch (err) {
      setError(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const noSchools = !schools || schools.length === 0;

  return (
    <div className="dev-school-cell">
      <select
        className="dev-school-select"
        value={schoolId || ""}
        onChange={handleChange}
        disabled={saving || noSchools}
      >
        <option value="">— unassigned —</option>
        {(schools || []).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {!schoolId && <span className="dev-school-warning" title="Scans from this device are rejected until a school is assigned.">⚠</span>}
      {schoolName && schoolId && <span className="dev-school-display">{schoolName}</span>}
      {error && <span className="dev-loc-error">{error}</span>}
    </div>
  );
}

function LocationCell({ hostname, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setDraft(value || ""); }, [value]);

  const commit = async () => {
    const next = draft.trim();
    if (!next) { setEditing(false); setDraft(value || ""); return; }
    if (next === (value || "")) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(hostname, next);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setEditing(false); setDraft(value || ""); setError(null); };

  if (editing) {
    return (
      <div className="dev-loc-edit">
        <input
          autoFocus
          className="dev-loc-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          disabled={saving}
          placeholder="e.g. entry-north-gate"
        />
        <button className="dev-loc-btn" onClick={commit} disabled={saving} title="Save">
          <FaCheck />
        </button>
        <button className="dev-loc-btn dev-loc-btn-ghost" onClick={cancel} disabled={saving} title="Cancel">
          <FaTimes />
        </button>
        {error && <span className="dev-loc-error">{error}</span>}
      </div>
    );
  }

  return (
    <button
      className="dev-loc-display"
      onClick={() => setEditing(true)}
      title="Click to edit location"
    >
      <span className={value ? "" : "dev-loc-empty"}>
        {value || "— set a location —"}
      </span>
      <FaPencilAlt className="dev-loc-pencil" />
    </button>
  );
}

export default function DevicesList({ token }) {
  const [devices, setDevices] = useState([]);
  const [schools, setSchools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const api = useCallback(() => createApiClient(token), [token]);

  const fetchDevices = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(!silent === false ? true : false);
    setError(null);
    try {
      const res = await api().get("/api/v1/devices");
      setDevices(res.data.devices || []);
    } catch (err) {
      setError(err?.response?.data?.detail || "Failed to load devices");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  // Devices is super_admin-only, so /admin/schools is the right list source
  // — it's the same one Platform Admin uses.
  const fetchSchools = useCallback(async () => {
    try {
      const res = await api().get("/api/v1/admin/schools");
      setSchools(res.data.schools || []);
    } catch {
      setSchools([]);
    }
  }, [api]);

  useEffect(() => {
    fetchDevices();
    fetchSchools();
    const id = setInterval(() => fetchDevices({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchDevices, fetchSchools]);

  const handleLocationSave = useCallback(async (hostname, location) => {
    const res = await api().patch(`/api/v1/devices/${encodeURIComponent(hostname)}`, { location });
    const updated = res.data.device;
    setDevices((prev) => prev.map((d) => (d.hostname === hostname ? updated : d)));
  }, [api]);

  const handleSchoolChange = useCallback(async (hostname, school_id) => {
    const res = await api().patch(
      `/api/v1/devices/${encodeURIComponent(hostname)}`,
      { school_id },
    );
    const updated = res.data.device;
    setDevices((prev) => prev.map((d) => (d.hostname === hostname ? updated : d)));
  }, [api]);

  return (
    <div className="dev-container">
      <div className="dev-header">
        <div className="dev-header-left">
          <h2 className="dev-title">
            <FaMicrochip className="dev-title-icon" />
            Devices
          </h2>
          <p className="dev-subtitle">
            Scanners registered with this backend. Assign each device to a school so
            its scans appear in that campus's Dashboard; unassigned devices have their
            scans rejected. Location changes are picked up on the next heartbeat.
          </p>
        </div>
        <button
          className="dev-btn-ghost"
          onClick={() => fetchDevices()}
          disabled={loading || refreshing}
          title="Refresh"
        >
          <FaSync className={refreshing ? "dev-spin" : ""} /> Refresh
        </button>
      </div>

      {loading && <div className="dev-state">Loading devices…</div>}
      {error && !loading && <div className="dev-state dev-state-error">{error}</div>}
      {!loading && !error && devices.length === 0 && (
        <div className="dev-state">
          No devices have registered yet. Power on a prepared Pi and it will appear here
          within a minute or two.
        </div>
      )}

      {!loading && !error && devices.length > 0 && (
        <div className="dev-table-wrap">
          <table className="dev-table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Status</th>
                <th>School</th>
                <th>Location</th>
                <th>Health</th>
                <th>Last seen</th>
                <th>IP</th>
                <th>Firmware</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.hostname} className="dev-row">
                  <td data-label="Hostname" className="dev-hostname">{d.hostname}</td>
                  <td data-label="Status"><StatusBadge status={d.status} /></td>
                  <td data-label="School">
                    <SchoolCell
                      hostname={d.hostname}
                      schoolId={d.school_id}
                      schoolName={d.school_name}
                      schools={schools}
                      onChange={handleSchoolChange}
                    />
                  </td>
                  <td data-label="Location">
                    <LocationCell
                      hostname={d.hostname}
                      value={d.location}
                      onSave={handleLocationSave}
                    />
                  </td>
                  <td data-label="Health"><HealthCell device={d} /></td>
                  <td data-label="Last seen" title={d.last_seen_at || ""}>{formatRelative(d.last_seen_at)}</td>
                  <td data-label="IP" className="dev-mono">{d.ip_address || "—"}</td>
                  <td data-label="Firmware" className="dev-mono">{d.firmware_sha || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
