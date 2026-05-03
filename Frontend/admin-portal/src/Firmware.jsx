import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import { I } from "./components/icons";
import "./Firmware.css";

/**
 * Firmware.jsx — OTA release management (issue #104).
 *
 * Three flows live on this page:
 *
 *   1. Upload + publish a new release.  The release engineer signs the
 *      tarball with deploy/sign_firmware.py, then on this page picks
 *      both files (manifest.json + tarball), confirms scope/window/
 *      stages, and clicks "Create".  We upload the two files directly
 *      to Firebase Storage (rules in storage.rules limit the path to
 *      super_admins) and POST the manifest to the backend, which
 *      verifies the Ed25519 signature against the canonical public key
 *      before creating the firmware_releases doc.  If the signature
 *      doesn't match, the release never lands and the upload sits in
 *      Storage as garbage to clean up later — small cost vs. the
 *      safety of catching a bad signature server-side.
 *
 *   2. Manage staged rollout.  For each published release, advance
 *      through the stages (canary → early → broad → general), or
 *      halt/resume at any point.  The dashboard shows fleet metrics
 *      (targeted / downloaded / applied / failed / rolled-back) so
 *      the engineer can see whether to advance or hold.
 *
 *   3. Per-device deployment view.  Picking a release opens a side
 *      panel listing every device targeting it with its FSM state,
 *      last error, and last update time — so the engineer can spot
 *      a single device hung in `health_check` and decide whether to
 *      pin it back or leave it.
 *
 * Pinning a single device to a specific version happens on the
 * Devices page (see DevicesList.jsx).  This page is the release-
 * engineer's surface; per-device control is on the device itself.
 */

const STATE_TONES = {
  idle:         "muted",
  assigned:     "blue",
  downloading:  "blue",
  verified:     "blue",
  staged:       "blue",
  applying:     "amber",
  health_check: "amber",
  committed:    "green",
  rolled_back:  "red",
  failed:       "red",
};


function StatusPill({ status }) {
  const tone = (
    status === "published" ? "green" :
    status === "halted"    ? "red"   :
    status === "archived"  ? "muted" :
    status === "draft"     ? "amber" : "muted"
  );
  return <span className={`fw-pill fw-pill--${tone}`}>{status || "—"}</span>;
}


function StagePill({ release }) {
  const stages = release?.rollout?.stages || [];
  const idx = release?.rollout?.current_stage ?? 0;
  const stage = stages[idx];
  if (!stage) return <span className="fw-pill fw-pill--muted">—</span>;
  return (
    <span className="fw-pill fw-pill--blue" title={`Stage ${idx + 1} of ${stages.length}`}>
      {stage.name} · {stage.percent}%
    </span>
  );
}


function MetricsRow({ metrics = {} }) {
  const m = (k) => metrics[k] ?? 0;
  return (
    <div className="fw-metrics">
      <span><b>{m("targeted_count")}</b> targeted</span>
      <span><b>{m("downloaded_count")}</b> downloaded</span>
      <span><b>{m("applied_count")}</b> applied</span>
      {m("failed_count") > 0 && (
        <span className="fw-metric-bad"><b>{m("failed_count")}</b> failed</span>
      )}
      {m("rolled_back_count") > 0 && (
        <span className="fw-metric-bad"><b>{m("rolled_back_count")}</b> rolled back</span>
      )}
    </div>
  );
}


function ReleaseRow({ release, onSelect, onAction, busy }) {
  const halted = release?.rollout?.halted;
  const isFinalStage = (() => {
    const stages = release?.rollout?.stages || [];
    return (release?.rollout?.current_stage ?? 0) >= stages.length - 1;
  })();
  return (
    <tr className="fw-row" onClick={() => onSelect(release)}>
      <td data-label="Version" className="fw-cell-version">
        <span className="fw-version">{release.version}</span>
        <span className="fw-channel">{release.channel || "stable"}</span>
      </td>
      <td data-label="Status"><StatusPill status={release.status} /></td>
      <td data-label="Stage">
        <StagePill release={release} />
        {halted && <span className="fw-pill fw-pill--red" style={{ marginLeft: 6 }}>halted</span>}
      </td>
      <td data-label="Metrics"><MetricsRow metrics={release.metrics} /></td>
      <td data-label="Published" className="fw-cell-time">{release.published_at?.slice(0, 16) || release.created_at?.slice(0, 16)}</td>
      <td data-label="Actions" className="fw-cell-actions" onClick={(e) => e.stopPropagation()}>
        {release.status === "draft" && (
          <button className="fw-btn fw-btn-primary" disabled={busy}
                  onClick={() => onAction("publish", release)}>Publish</button>
        )}
        {release.status === "published" && !halted && !isFinalStage && (
          <button className="fw-btn" disabled={busy}
                  onClick={() => onAction("advance", release)}>Advance →</button>
        )}
        {release.status === "published" && !halted && (
          <button className="fw-btn fw-btn-warn" disabled={busy}
                  onClick={() => onAction("halt", release)}>Halt</button>
        )}
        {release.status === "published" && halted && (
          <button className="fw-btn" disabled={busy}
                  onClick={() => onAction("resume", release)}>Resume</button>
        )}
        {release.status !== "archived" && (
          <button className="fw-btn fw-btn-ghost" disabled={busy}
                  onClick={() => onAction("archive", release)}>Archive</button>
        )}
      </td>
    </tr>
  );
}


function DeviceTable({ devices = [] }) {
  if (!devices.length) {
    return <div className="fw-empty">No devices have been assigned this release yet.</div>;
  }
  return (
    <div className="fw-table-wrap">
      <table className="fw-device-table">
        <thead>
          <tr>
            <th>Device</th><th>State</th><th>Stage</th><th>Updated</th><th>Error</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.hostname}>
              <td data-label="Device" className="fw-mono">{d.hostname}</td>
              <td data-label="State">
                <span className={`fw-pill fw-pill--${STATE_TONES[d.state] || "muted"}`}>
                  {d.state || "—"}
                </span>
              </td>
              <td data-label="Stage">{d.rollout_stage || "—"}</td>
              <td data-label="Updated" className="fw-cell-time">{d.state_updated_at?.slice(0, 16) || "—"}</td>
              <td data-label="Error" className="fw-error">{d.last_error || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function UploadModal({ onClose, onCreated, api }) {
  const [tarball, setTarball]   = useState(null);
  const [manifest, setManifest] = useState(null);
  const [manifestText, setManifestText] = useState("");
  const [version, setVersion]   = useState("");
  const [notes, setNotes]       = useState("");
  const [stagesJson, setStagesJson] = useState(
    "[{\"name\":\"canary\",\"percent\":1,\"min_soak_hours\":24}," +
    "{\"name\":\"early\",\"percent\":10,\"min_soak_hours\":48}," +
    "{\"name\":\"broad\",\"percent\":50,\"min_soak_hours\":24}," +
    "{\"name\":\"general\",\"percent\":100,\"min_soak_hours\":0}]"
  );
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd]     = useState("");
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const onPickManifest = async (file) => {
    if (!file) { setManifest(null); setManifestText(""); return; }
    setManifest(file);
    const text = await file.text();
    setManifestText(text);
    try {
      const m = JSON.parse(text);
      if (m?.version) setVersion(m.version);
    } catch { /* let validation error surface on submit */ }
  };

  const submit = async () => {
    if (!tarball || !manifest || !version) {
      setError("Pick the tarball, manifest.json, and confirm the version");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let manifestObj;
      try {
        manifestObj = JSON.parse(manifestText);
      } catch {
        throw new Error("manifest.json is not valid JSON");
      }
      let stages;
      try {
        stages = JSON.parse(stagesJson);
      } catch {
        throw new Error("Stages JSON is invalid");
      }

      // Upload artifact + manifest to Storage at the canonical path.
      // Path mirrors functions/services/firmware_signing.py::storage_path_for.
      const base = `firmware/releases/${version}`;
      const tarRef = ref(storage, `${base}/${tarball.name}`);
      const mRef   = ref(storage, `${base}/manifest.json`);
      await uploadBytes(tarRef, tarball, { contentType: "application/gzip" });
      await uploadBytes(mRef, manifest, { contentType: "application/json" });

      // Now ask the backend to verify + create the release doc.
      const apply_window_local = (windowStart && windowEnd)
        ? { start_hour: Number(windowStart), end_hour: Number(windowEnd) }
        : null;

      await api().post("/api/v1/admin/firmware/releases", {
        version,
        channel: "stable",
        notes,
        manifest: manifestObj,
        stages,
        scope: { include_districts: [], include_schools: [], exclude_devices: [] },
        apply_window_local,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(formatApiError(err, "Upload failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fw-modal-bg" onClick={onClose}>
      <div className="fw-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New firmware release</h3>
        <p className="fw-modal-help">
          Sign the tarball with <code>deploy/sign_firmware.py sign</code>, then
          pick both files here.  The backend re-verifies the signature
          against the canonical public key before publishing.
        </p>
        <label className="fw-field">
          <span>Tarball (dismissal-{`{version}`}.tar.gz)</span>
          <input type="file" accept=".tar.gz,.tgz,application/gzip"
                 onChange={(e) => setTarball(e.target.files?.[0] || null)} />
        </label>
        <label className="fw-field">
          <span>manifest.json</span>
          <input type="file" accept=".json,application/json"
                 onChange={(e) => onPickManifest(e.target.files?.[0] || null)} />
        </label>
        <label className="fw-field">
          <span>Version (auto-filled from manifest)</span>
          <input type="text" value={version}
                 onChange={(e) => setVersion(e.target.value)}
                 placeholder="1.2.3" />
        </label>
        <label className="fw-field">
          <span>Release notes (markdown)</span>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="What changed and why" />
        </label>
        <label className="fw-field">
          <span>Stages (JSON — name / percent / min_soak_hours)</span>
          <textarea rows={3} value={stagesJson}
                    onChange={(e) => setStagesJson(e.target.value)} />
        </label>
        <fieldset className="fw-field-row">
          <legend>Apply window (device-local hours, optional)</legend>
          <input type="number" min="0" max="23" value={windowStart}
                 onChange={(e) => setWindowStart(e.target.value)}
                 placeholder="start" />
          <span>→</span>
          <input type="number" min="0" max="24" value={windowEnd}
                 onChange={(e) => setWindowEnd(e.target.value)}
                 placeholder="end" />
        </fieldset>
        {error && <div className="fw-error-bar">{error}</div>}
        <div className="fw-modal-actions">
          <button className="fw-btn fw-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="fw-btn fw-btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Uploading…" : "Create release"}
          </button>
        </div>
      </div>
    </div>
  );
}


function PubkeyBanner({ api, onPubkeyReady }) {
  const [editing, setEditing] = useState(false);
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api().post("/api/v1/admin/firmware/pubkey", { public_key_b64: keyText });
      onPubkeyReady();
      setEditing(false);
    } catch (err) {
      setError(formatApiError(err, "Failed to set public key"));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button className="fw-btn fw-btn-ghost" onClick={() => setEditing(true)}>
        <I.shield size={14} aria-hidden="true" />&nbsp;Manage public key
      </button>
    );
  }
  return (
    <div className="fw-pubkey-form">
      <textarea rows={4} placeholder="Paste contents of firmware.pub (base64; # comments OK)"
                value={keyText} onChange={(e) => setKeyText(e.target.value)} />
      {error && <div className="fw-error-bar">{error}</div>}
      <div className="fw-modal-actions">
        <button className="fw-btn fw-btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
        <button className="fw-btn fw-btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="fw-modal-help">
        Rotating the key only takes effect for releases signed AFTER the
        rotation.  The Pi-side key (<code>/opt/dismissal/keys/firmware.pub</code>)
        must be updated separately on every device for older releases to
        remain trusted.
      </p>
    </div>
  );
}


export default function Firmware({ token, currentUser }) {
  const isSuper = currentUser?.role === "super_admin";

  const api = useCallback(() => createApiClient(token), [token]);
  const [releases, setReleases]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [selected, setSelected]     = useState(null);  // {version, devices}
  const [busy, setBusy]             = useState(false);

  const fetchReleases = useCallback(async () => {
    setError(null);
    try {
      const res = await api().get("/api/v1/admin/firmware/releases");
      setReleases(res.data.releases || []);
    } catch (err) {
      setError(formatApiError(err, "Failed to load releases"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { fetchReleases(); }, [fetchReleases]);

  const openRelease = useCallback(async (release) => {
    try {
      const res = await api().get(`/api/v1/admin/firmware/releases/${release.version}`);
      setSelected(res.data.release);
    } catch (err) {
      setError(formatApiError(err, "Failed to load release"));
    }
  }, [api]);

  const performAction = useCallback(async (action, release) => {
    let body = null;
    let confirm = null;
    if (action === "halt") {
      const reason = window.prompt(`Halt ${release.version}? Reason for the audit log:`);
      if (!reason) return;
      body = { reason };
    } else if (action === "advance") {
      const stages = release?.rollout?.stages || [];
      const next = stages[(release?.rollout?.current_stage ?? 0) + 1];
      confirm = next
        ? `Advance ${release.version} to "${next.name}" (${next.percent}% of fleet)?`
        : `Advance ${release.version}?`;
      if (!window.confirm(confirm)) return;
    } else if (action === "archive") {
      if (!window.confirm(`Archive ${release.version}? Devices already on it stay.`)) return;
    }
    setBusy(true);
    try {
      await api().post(`/api/v1/admin/firmware/releases/${release.version}/${action}`, body || {});
      await fetchReleases();
      if (selected?.version === release.version) await openRelease(release);
    } catch (err) {
      setError(formatApiError(err, `Failed to ${action} release`));
    } finally {
      setBusy(false);
    }
  }, [api, fetchReleases, openRelease, selected]);

  const sortedReleases = useMemo(
    () => [...releases].sort((a, b) =>
      (b.created_at || "").localeCompare(a.created_at || "")),
    [releases],
  );

  if (!isSuper) {
    return (
      <div className="fw-page page-shell">
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.shield size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">Restricted to Platform Admins</p>
          <p className="page-empty-sub">
            Firmware release management is only available to Platform Admin accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fw-page page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Platform · firmware</span>
          <h1 className="page-title">Firmware</h1>
          <p className="page-sub">
            Sign, publish, and stage firmware updates across the fleet.
          </p>
        </div>
        <div className="page-actions">
          {!loading && sortedReleases.length > 0 && (
            <span
              className="page-chip"
              aria-label={`${sortedReleases.length} firmware release${sortedReleases.length === 1 ? "" : "s"}`}
            >
              <I.shield size={12} aria-hidden="true" />
              {sortedReleases.length.toLocaleString()} {sortedReleases.length === 1 ? "release" : "releases"}
            </span>
          )}
          <PubkeyBanner api={api} onPubkeyReady={fetchReleases} />
          <button className="um-btn-invite" onClick={() => setShowUpload(true)}>
            <I.shield size={13} aria-hidden="true" />
            New release
          </button>
        </div>
      </div>

      {error && (
        <div className="um-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="um-error-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading firmware releases…</p>
        </div>
      ) : sortedReleases.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.shield size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">No firmware releases yet</p>
          <p className="page-empty-sub">
            Sign a tarball and click "New release" to publish your first one.
          </p>
        </div>
      ) : (
        <div className="fw-table-wrap accent-bar">
          <table className="fw-release-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Metrics</th>
                <th>Published</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedReleases.map((r) => (
                <ReleaseRow
                  key={r.version}
                  release={r}
                  onSelect={openRelease}
                  onAction={performAction}
                  busy={busy}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <aside className="fw-detail">
          <header>
            <h3>{selected.version}</h3>
            <button className="fw-btn fw-btn-ghost" onClick={() => setSelected(null)}>
              <I.x size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="fw-detail-grid">
            <div><b>Status:</b> <StatusPill status={selected.status} /></div>
            <div><b>Stage:</b> <StagePill release={selected} /></div>
            <div><b>Signed by:</b> {selected.signed_by || "—"}</div>
            <div><b>SHA-256:</b> <code className="fw-mono">{selected.artifact_sha256?.slice(0, 16)}…</code></div>
          </div>
          <MetricsRow metrics={selected.metrics} />
          {selected.notes && (
            <details className="fw-notes">
              <summary>Release notes</summary>
              <pre>{selected.notes}</pre>
            </details>
          )}
          <h4>Devices</h4>
          <DeviceTable devices={selected.devices || []} />
        </aside>
      )}

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onCreated={fetchReleases}
          api={api}
        />
      )}
    </div>
  );
}
