import React, { useCallback, useEffect, useState } from "react";
import { I } from "./components/icons";
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

// CPU thermal thresholds: the Pi 5 starts soft-throttling around 80°C
// and hard-throttles at 85°C.  Orange ahead of soft-throttle is the
// "do something soon" zone; red is "you're throttling now".
function cpuTempTone(t) {
  if (t == null) return "muted";
  if (t >= 80) return "red";
  if (t >= 70) return "orange";
  return "green";
}

// Hailo-8/8L thermal thresholds are different from the Pi CPU — the
// chip's safe operating limit is higher (rated to 85°C operating, hard
// shutdown at 105°C per Hailo's datasheet).  Tone the chip more
// conservatively than the spec to nudge operators toward better
// cooling well before the chip is actually unhappy.
function hailoTempTone(t) {
  if (t == null) return "muted";
  if (t >= 85) return "red";
  if (t >= 75) return "orange";
  return "green";
}

function HealthCell({ device }) {
  const cpu = device.health_cpu_temp_c;
  const hailo = device.health_hailo_temp_c;
  const memTotal = device.health_memory_total_mb;
  const memUsed = device.health_memory_used_mb;
  const uptime = device.health_uptime_seconds;
  const scanner = device.health_service_scanner;
  const watchdog = device.health_service_watchdog;
  const reportedAt = device.health_reported_at;

  // Nothing reported yet → this device is on an older firmware or hasn't
  // heartbeated once since the upgrade.
  if (cpu == null && hailo == null && memTotal == null && uptime == null) {
    return <span className="dev-health-none">—</span>;
  }

  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : null;
  const scannerOk = scanner === "active";
  const watchdogOk = watchdog === "active";

  return (
    <div className="dev-health" title={reportedAt ? `Reported ${reportedAt}` : ""}>
      {cpu != null && (
        <span
          className={`dev-health-chip dev-health-chip--${cpuTempTone(cpu)}`}
          title={`CPU temperature: ${cpu.toFixed(1)}°C`}
        >
          CPU {cpu.toFixed(1)}°C
        </span>
      )}
      {hailo != null && (
        <span
          className={`dev-health-chip dev-health-chip--${hailoTempTone(hailo)}`}
          title={`Hailo NPU temperature: ${hailo.toFixed(1)}°C`}
        >
          NPU {hailo.toFixed(1)}°C
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
          {scannerOk && watchdogOk
            ? <><I.checkCircle size={11} stroke={2.4} aria-hidden="true" /> services</>
            : <><I.alert       size={11} stroke={2.2} aria-hidden="true" /> services</>}
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


// Firmware column — shows OTA version + state when available, falls back
// to the legacy git-SHA field on devices that haven't received their first
// firmware-check response yet.  Super admins get an inline pin/unpin
// action; other roles read-only.
function FirmwareCell({ device, ota, canPin, onPin }) {
  const version = ota?.current_version || device?.firmware_sha || "—";
  const target  = ota?.target_version;
  const state   = ota?.state;
  const pinned  = ota?.pinned_version || "";
  const inFlight = state && !["idle", "committed"].includes(state);
  return (
    <div className="dev-fw-cell">
      <span className="dev-fw-version" title={`Current: ${version}`}>{version}</span>
      {pinned && (
        <span className="dev-fw-pin" title={`Pinned to ${pinned}`}>📌 {pinned}</span>
      )}
      {inFlight && target && target !== version && (
        <span className="dev-fw-state" title={`OTA state: ${state}`}>
          → {target} ({state})
        </span>
      )}
      {state === "rolled_back" && (
        <span className="dev-fw-state dev-fw-state-bad" title={ota?.last_error || ""}>
          rolled back
        </span>
      )}
      {canPin && (
        <button
          className="dev-fw-pin-btn"
          onClick={() => onPin(device.hostname, pinned)}
          title={pinned ? "Unpin firmware" : "Pin to a specific version"}
        >
          {pinned ? "Unpin" : "Pin"}
        </button>
      )}
    </div>
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

function AssignCell({ hostname, label, value, options, disabled, placeholderWarn, onChange }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = async (e) => {
    const next = e.target.value;
    setSaving(true);
    setError(null);
    try {
      await onChange(hostname, next);
    } catch (err) {
      setError(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const noOptions = !options || options.length === 0;

  return (
    <div className="dev-school-cell">
      <select
        className="dev-school-select"
        value={value || ""}
        onChange={handleChange}
        disabled={saving || disabled || noOptions}
        aria-label={`${label} for ${hostname}`}
      >
        <option value="">— unassigned —</option>
        {(options || []).map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      {!value && placeholderWarn && (
        <span
          className="dev-school-warning"
          title={placeholderWarn}
          aria-label={placeholderWarn}
          role="img"
        >
          <I.alert size={12} stroke={2.4} aria-hidden="true" />
        </span>
      )}
      {error && <span className="dev-loc-error" role="alert">{error}</span>}
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
          aria-label={`Location label for ${hostname}`}
        />
        <button
          className="dev-loc-btn"
          onClick={commit}
          disabled={saving}
          aria-label="Save location"
          title="Save"
        >
          <I.check size={12} stroke={2.6} aria-hidden="true" />
        </button>
        <button
          className="dev-loc-btn dev-loc-btn-ghost"
          onClick={cancel}
          disabled={saving}
          aria-label="Cancel location edit"
          title="Cancel"
        >
          <I.x size={12} stroke={2.6} aria-hidden="true" />
        </button>
        {error && <span className="dev-loc-error" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <button
      className="dev-loc-display"
      onClick={() => setEditing(true)}
      aria-label={value ? `Edit location: ${value}` : "Set a location"}
      title="Click to edit location"
    >
      <span className={value ? "" : "dev-loc-empty"}>
        {value || "— set a location —"}
      </span>
      <I.edit size={11} className="dev-loc-pencil" aria-hidden="true" />
    </button>
  );
}

export default function DevicesList({ token, currentUser = null }) {
  const isSuperAdmin    = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  // School admins / staff only see devices assigned to their school, and
  // can only edit the location label.  They never pick district/school.
  const isSchoolScoped  = currentUser?.role === "school_admin" || currentUser?.role === "staff";

  const [devices, setDevices]     = useState([]);
  const [schools, setSchools]     = useState([]);
  const [districts, setDistricts] = useState([]);
  const [firmware, setFirmware]   = useState({});  // hostname -> device_firmware doc
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
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

  // Super admins pick a district per device; district admins are pinned to
  // theirs so we only need the school list filtered to that district.
  const fetchSchools = useCallback(async () => {
    try {
      const res = await api().get("/api/v1/admin/schools");
      setSchools(res.data.schools || []);
    } catch {
      setSchools([]);
    }
  }, [api]);

  const fetchDistricts = useCallback(async () => {
    try {
      const res = await api().get("/api/v1/admin/districts");
      setDistricts(res.data.districts || []);
    } catch {
      setDistricts([]);
    }
  }, [api]);

  // Per-device OTA state (current/target/state) for the Firmware column.
  // Best-effort — non-super-admins may get 403 on this endpoint, in
  // which case the column gracefully falls back to the legacy
  // firmware_sha display.
  const fetchFirmware = useCallback(async () => {
    try {
      const res = await api().get("/api/v1/admin/firmware/devices");
      setFirmware(res.data.firmware || {});
    } catch {
      setFirmware({});
    }
  }, [api]);

  useEffect(() => {
    fetchDevices();
    fetchSchools();
    fetchDistricts();
    fetchFirmware();
    const id = setInterval(() => {
      fetchDevices({ silent: true });
      fetchFirmware();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchDevices, fetchSchools, fetchDistricts, fetchFirmware]);

  const handleLocationSave = useCallback(async (hostname, location) => {
    const res = await api().patch(`/api/v1/devices/${encodeURIComponent(hostname)}`, { location });
    const updated = res.data.device;
    setDevices((prev) => prev.map((d) => (d.hostname === hostname ? updated : d)));
  }, [api]);

  const handleDistrictChange = useCallback(async (hostname, district_id) => {
    const res = await api().patch(
      `/api/v1/devices/${encodeURIComponent(hostname)}`,
      { district_id },
    );
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

  const handlePinFirmware = useCallback(async (hostname, currentPin) => {
    // Toggle: prompt for a version when not pinned, unpin when pinned.
    let body;
    if (currentPin) {
      if (!window.confirm(`Unpin ${hostname} from version ${currentPin}? It will follow the staged rollout next check.`)) return;
      body = { version: null };
    } else {
      const v = window.prompt(`Pin ${hostname} to which version? (e.g. 1.2.3)`);
      if (!v) return;
      body = { version: v };
    }
    try {
      await api().post(`/api/v1/admin/devices/${encodeURIComponent(hostname)}/firmware/pin`, body);
      await fetchFirmware();
    } catch (err) {
      alert(err?.response?.data?.detail || "Pin update failed");
    }
  }, [api, fetchFirmware]);

  return (
    <div className="dev-container page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Fleet · scanners</span>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            {isSuperAdmin && (
              "Scanners registered with this backend. Assign each device to a district (and optionally a school within it); district admins finish the school assignment when the Pi is physically installed."
            )}
            {isDistrictAdmin && (
              "Devices in your district. Assign each to the school where it's installed so scans land in that campus's Dashboard; unassigned devices have their scans rejected."
            )}
            {isSchoolScoped && (
              "Scanners installed at your school. Edit the location label if a scanner is moved; district reassignment is handled by your district or platform admin."
            )}
          </p>
        </div>
        <div className="page-actions">
          {!loading && devices.length > 0 && (
            <span className="page-chip" aria-label={`${devices.length} devices`}>
              <I.device size={12} aria-hidden="true" />
              {devices.length.toLocaleString()} {devices.length === 1 ? "device" : "devices"}
            </span>
          )}
          <button
            className="dev-btn-ghost"
            onClick={() => fetchDevices()}
            disabled={loading || refreshing}
            aria-label="Refresh device list"
            title="Refresh"
          >
            <I.refresh size={13} className={refreshing ? "dev-spin" : ""} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading devices…</p>
        </div>
      )}
      {error && !loading && (
        <div className="dev-state-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && devices.length === 0 && (
        <div className="page-empty">
          <span className="page-empty-icon"><I.device size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">No devices registered yet</p>
          <p className="page-empty-sub">
            Power on a prepared Pi and it will appear here within a minute or two.
          </p>
        </div>
      )}

      {!loading && !error && devices.length > 0 && (
        <div className="dev-table-wrap">
          <table className="dev-table">
            <caption className="sr-only">Registered scanner devices</caption>
            <thead>
              <tr>
                <th scope="col">Hostname</th>
                <th scope="col">Status</th>
                {isSuperAdmin && <th scope="col">District</th>}
                {!isSchoolScoped && <th scope="col">School</th>}
                <th scope="col">Location</th>
                <th scope="col">Health</th>
                <th scope="col">Last seen</th>
                <th scope="col">IP</th>
                <th scope="col">Firmware</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                // School options are constrained to the device's district so
                // we don't silently allow cross-district assignments.
                const deviceDistrictId = d.district_id || null;
                const schoolOptions = (schools || [])
                  .filter((s) => !deviceDistrictId || s.district_id === deviceDistrictId)
                  .map((s) => ({ id: s.id, name: s.name }));
                const districtOptions = (districts || []).map((x) => ({ id: x.id, name: x.name }));

                return (
                  <tr key={d.hostname} className="dev-row">
                    <td data-label="Hostname" className="dev-hostname">{d.hostname}</td>
                    <td data-label="Status"><StatusBadge status={d.status} /></td>
                    {isSuperAdmin && (
                      <td data-label="District">
                        <AssignCell
                          hostname={d.hostname}
                          label="District"
                          value={d.district_id}
                          options={districtOptions}
                          onChange={handleDistrictChange}
                          placeholderWarn="Assign a district before picking a school."
                        />
                      </td>
                    )}
                    {!isSchoolScoped && (
                      <td data-label="School">
                        <AssignCell
                          hostname={d.hostname}
                          label="School"
                          value={d.school_id}
                          options={schoolOptions}
                          disabled={!deviceDistrictId}
                          onChange={handleSchoolChange}
                          placeholderWarn={
                            deviceDistrictId
                              ? "Scans are rejected until a school is assigned."
                              : "Device needs a district first."
                          }
                        />
                      </td>
                    )}
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
                    <td data-label="Firmware" className="dev-mono">
                      <FirmwareCell
                        device={d}
                        ota={firmware[d.hostname]}
                        canPin={isSuperAdmin}
                        onPin={handlePinFirmware}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
