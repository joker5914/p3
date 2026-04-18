import React, { useCallback, useEffect, useState } from "react";
import { FaMicrochip, FaSync, FaPencilAlt, FaCheck, FaTimes } from "react-icons/fa";
import { createApiClient } from "./api";
import "./DevicesList.css";

// Poll every 30 s so the online/offline badge reflects real heartbeat state
// without the admin having to reload.
const REFRESH_MS = 30_000;

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

  useEffect(() => {
    fetchDevices();
    const id = setInterval(() => fetchDevices({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchDevices]);

  const handleLocationSave = useCallback(async (hostname, location) => {
    const res = await api().patch(`/api/v1/devices/${encodeURIComponent(hostname)}`, { location });
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
            Scanners registered with this backend. Click a location to rename; changes are
            picked up by the device on its next heartbeat (≤5&nbsp;min).
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
                <th>Location</th>
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
                  <td data-label="Location">
                    <LocationCell
                      hostname={d.hostname}
                      value={d.location}
                      onSave={handleLocationSave}
                    />
                  </td>
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
