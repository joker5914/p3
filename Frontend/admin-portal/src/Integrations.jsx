import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaSchool, FaPlug, FaFileUpload, FaCheckCircle, FaExclamationTriangle,
  FaSyncAlt, FaTimesCircle, FaChevronRight, FaKey, FaBolt,
} from "react-icons/fa";
import { createApiClient } from "./api";
import "./Integrations.css";

// ─────────────────────────────────────────────────────────────────────────────
// Integrations page
//
// Two surfaces live here:
//
//   1. Student Information System (SIS) — OneRoster-backed rostering sync.
//      District-admin owned.  Wizard for first-time setup, dashboard once
//      connected showing last-sync status, manual "Sync now", recent jobs,
//      and any duplicates flagged for admin review.
//
//   2. CSV data import (legacy) — the original upload flow.  We keep the
//      link visible so schools not yet on an SIS still have a path in.
//
// Scope of the first SIS provider is OneRoster 1.2, which covers PowerSchool,
// Infinite Campus, Skyward, Synergy, Aeries (their common API surface).
// Clever / ClassLink / PowerSchool-specific live under the same shape as
// "Coming soon" cards — the backend data model supports them, only the
// provider-client implementation is pending.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_CARDS = [
  {
    key: "oneroster", label: "OneRoster 1.2",
    blurb: "IMS Global / 1EdTech standard.  Works with PowerSchool, Infinite Campus, Skyward, Synergy, Aeries.",
    status: "live",
  },
  {
    key: "powerschool", label: "PowerSchool SIS",
    blurb: "Connect via your district's PowerSchool OneRoster endpoint (select 'OneRoster' above — works natively).",
    status: "alias",
  },
  {
    key: "clever", label: "Clever Secure Sync",
    blurb: "Pull rosters from Clever for districts that use it as their rostering bus.",
    status: "coming_soon",
  },
  {
    key: "classlink", label: "ClassLink Roster Server",
    blurb: "Pull rosters from ClassLink, the other dominant K-12 rostering aggregator.",
    status: "coming_soon",
  },
];

const SYNC_INTERVALS = [
  { value: "1h",  label: "Every hour" },
  { value: "2h",  label: "Every 2 hours (recommended)" },
  { value: "6h",  label: "Every 6 hours" },
  { value: "12h", label: "Twice a day" },
  { value: "24h", label: "Daily (overnight)" },
];

const SECRET_PLACEHOLDER = "__dismissal_secret_set__";

// ─────────────────────────────────────────────────────────────────────────────
// Top-level page
// ─────────────────────────────────────────────────────────────────────────────
export default function Integrations({ setView, token, currentUser, activeDistrict }) {
  const districtId = activeDistrict?.id || currentUser?.district_id || null;
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const isSuperAdmin    = currentUser?.role === "super_admin";
  const canAdminSis     = isDistrictAdmin || isSuperAdmin;
  const api = useMemo(() => createApiClient(token), [token]);

  const [cfg, setCfg]     = useState(null);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [cfgError, setCfgError] = useState("");

  const loadCfg = useCallback(() => {
    if (!districtId) { setCfg(null); return; }
    setLoadingCfg(true);
    setCfgError("");
    api.get(`/api/v1/admin/districts/${districtId}/sis-config`)
      .then((r) => setCfg(r.data.sis_config || null))
      .catch((e) => setCfgError(e.response?.data?.detail || "Failed to load SIS config"))
      .finally(() => setLoadingCfg(false));
  }, [api, districtId]);

  useEffect(() => { loadCfg(); }, [loadCfg]);

  const isConfigured = cfg && (cfg.provider || cfg.endpoint_url || cfg.enabled);

  // Super-admin at platform top with no district picked — prompt to pick one.
  if (isSuperAdmin && !districtId) {
    return (
      <div className="int-container">
        <header className="int-header">
          <h2 className="int-title">Integrations</h2>
          <p className="int-subtitle">Connect your Student Information System so Dismissal always has current rosters.</p>
        </header>
        <div className="int-empty" role="status">
          <FaSchool size={32} aria-hidden="true" />
          <h3>Pick a district first</h3>
          <p>SIS connections are configured per district.  Head to Districts, select one, then come back here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="int-container">
      <header className="int-header">
        <h2 className="int-title">Integrations</h2>
        <p className="int-subtitle">
          Connect your Student Information System so Dismissal always has current rosters.
          {activeDistrict?.name && <> &nbsp;·&nbsp; <strong>{activeDistrict.name}</strong></>}
        </p>
      </header>

      {cfgError && (
        <div className="int-error" role="alert">
          <FaExclamationTriangle aria-hidden="true" /> {cfgError}
        </div>
      )}

      {loadingCfg ? (
        <div className="int-state" role="status">Loading…</div>
      ) : !canAdminSis ? (
        <ReadOnlySisSummary cfg={cfg} />
      ) : isConfigured ? (
        <SisDashboard
          api={api}
          districtId={districtId}
          cfg={cfg}
          onRefresh={loadCfg}
        />
      ) : (
        <SisWizard
          api={api}
          districtId={districtId}
          onComplete={loadCfg}
        />
      )}

      <section className="int-section int-legacy">
        <div className="int-legacy-head">
          <div>
            <h3 className="int-section-title">CSV data import</h3>
            <p className="int-section-sub">
              Legacy path for schools without an SIS, or for one-off bulk uploads.
              Still works; prefer SIS sync when possible for real-time accuracy.
            </p>
          </div>
          <button
            className="int-btn int-btn-ghost"
            onClick={() => setView && setView("dataImporter")}
          >
            <FaFileUpload aria-hidden="true" /> Open CSV importer
          </button>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only summary for school admins / staff
// ─────────────────────────────────────────────────────────────────────────────
function ReadOnlySisSummary({ cfg }) {
  if (!cfg || !cfg.enabled) {
    return (
      <div className="int-empty" role="status">
        <FaPlug size={32} aria-hidden="true" />
        <h3>No SIS connected yet</h3>
        <p>Your district administrator manages SIS connections.  Ask them to head to Integrations when ready.</p>
      </div>
    );
  }
  return (
    <section className="int-section">
      <h3 className="int-section-title">Student Information System</h3>
      <p className="int-section-sub">
        Connected to <strong>{(cfg.provider || "").toUpperCase()}</strong>.  Last sync{" "}
        {cfg.last_sync_at ? <time>{new Date(cfg.last_sync_at).toLocaleString()}</time> : "—"}.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard — first-time setup
// ─────────────────────────────────────────────────────────────────────────────
function SisWizard({ api, districtId, onComplete }) {
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState("oneroster");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [syncInterval, setSyncInterval] = useState("2h");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post(
        `/api/v1/admin/districts/${districtId}/sis-config/test`,
        { provider, endpoint_url: endpointUrl, client_id: clientId, client_secret: clientSecret },
      );
      setTestResult(res.data);
    } catch (err) {
      setTestResult({ ok: false, message: err.response?.data?.detail || "Connection failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleEnable = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await api.put(`/api/v1/admin/districts/${districtId}/sis-config`, {
        provider,
        endpoint_url: endpointUrl,
        client_id: clientId,
        client_secret: clientSecret,
        sync_interval: syncInterval,
        enabled: true,
      });
      onComplete();
    } catch (err) {
      setSaveError(err.response?.data?.detail || "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="int-section int-wizard">
      <div className="int-wizard-head">
        <h3 className="int-section-title">Connect your Student Information System</h3>
        <p className="int-section-sub">
          Dismissal will pull your roster every {syncInterval} so student and guardian records stay
          current without manual updates.  Fields Dismissal doesn't use are never imported.
        </p>
        <div className="int-wizard-steps" role="list" aria-label="Setup steps">
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              role="listitem"
              className={`int-wizard-step${step >= n ? " active" : ""}${step === n ? " current" : ""}`}
              aria-current={step === n ? "step" : undefined}
            >
              {n}
            </span>
          ))}
        </div>
      </div>

      {/* Step 1 — provider */}
      {step === 1 && (
        <div className="int-wizard-body">
          <h4 className="int-step-title">1. Pick your provider</h4>
          <p className="int-step-desc">
            If your SIS is PowerSchool, Infinite Campus, Skyward, Synergy, or Aeries, choose
            <strong> OneRoster 1.2</strong> — they all support it.  Clever and ClassLink are
            coming in a later release.
          </p>

          <div className="int-provider-grid">
            {PROVIDER_CARDS.map((p) => {
              const active = provider === p.key;
              const disabled = p.status === "coming_soon";
              const alias    = p.status === "alias";
              return (
                <button
                  type="button"
                  key={p.key}
                  className={`int-provider-card${active ? " active" : ""}${disabled ? " disabled" : ""}`}
                  onClick={() => !disabled && !alias && setProvider(p.key)}
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`${p.label}${disabled ? " (coming soon)" : alias ? " (use OneRoster option)" : ""}`}
                >
                  <div className="int-provider-head">
                    <strong>{p.label}</strong>
                    {p.status === "live"        && <span className="int-badge int-badge-live">Live</span>}
                    {p.status === "alias"       && <span className="int-badge int-badge-alias">Use OneRoster</span>}
                    {p.status === "coming_soon" && <span className="int-badge int-badge-soon">Coming soon</span>}
                  </div>
                  <p className="int-provider-blurb">{p.blurb}</p>
                </button>
              );
            })}
          </div>

          <div className="int-billing-note" role="note">
            <FaBolt aria-hidden="true" />
            <div>
              <strong>Heads up on SIS setup.</strong>{" "}
              Most districts don't pay a per-seat fee to use OneRoster — it's a standard feature of your SIS.
              You'll need to <em>authorize</em> Dismissal in your SIS admin portal (generate a Client ID / Client
              Secret under the OAuth or API section).  If your district has a procurement policy, loop them in
              before enabling.
            </div>
          </div>

          <div className="int-wizard-actions">
            <button className="int-btn int-btn-primary" onClick={() => setStep(2)}>
              Continue <FaChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — credentials */}
      {step === 2 && (
        <div className="int-wizard-body">
          <h4 className="int-step-title">2. Enter credentials</h4>
          <p className="int-step-desc">
            Paste the values you generated in your SIS admin portal.  The secret is encrypted before it lands in our database.
          </p>

          <div className="int-form">
            <label className="int-field">
              <span>OneRoster endpoint URL</span>
              <input
                type="url"
                placeholder="https://district.powerschool.com/ims/oneroster/v1p2"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                required
              />
              <small>The base path ending in <code>/ims/oneroster/v1p2</code> (or v1p1 for older installs).</small>
            </label>

            <label className="int-field">
              <span>Client ID</span>
              <input
                type="text"
                placeholder="e.g. ab12cd34-..."
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
            </label>

            <label className="int-field">
              <span>Client Secret</span>
              <input
                type="password"
                placeholder="Paste the secret from your SIS OAuth page"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required
                autoComplete="off"
              />
              <small>
                Encrypted at rest with <code>DISMISSAL_ENCRYPTION_KEY</code>.  We never show this value back to you — paste it fresh if you rotate.
              </small>
            </label>
          </div>

          <div className="int-wizard-actions">
            <button className="int-btn int-btn-ghost" onClick={() => setStep(1)}>Back</button>
            <button
              className="int-btn int-btn-primary"
              disabled={!endpointUrl || !clientId || !clientSecret}
              onClick={() => setStep(3)}
            >
              Continue <FaChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — test */}
      {step === 3 && (
        <div className="int-wizard-body">
          <h4 className="int-step-title">3. Test the connection</h4>
          <p className="int-step-desc">
            Dismissal will hit your OneRoster endpoint with the credentials above and try to fetch one student.
            Nothing is saved yet.
          </p>

          <div className="int-test-wrap">
            <button
              className="int-btn int-btn-primary"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? (<><FaSyncAlt className="int-spin" aria-hidden="true" /> Testing…</>) : (<><FaKey aria-hidden="true" /> Run test</>)}
            </button>
            {testResult && (
              <div className={`int-test-result${testResult.ok ? " ok" : " fail"}`} role="status">
                {testResult.ok ? (
                  <>
                    <FaCheckCircle aria-hidden="true" />
                    <div>
                      <strong>Connection successful.</strong>
                      {typeof testResult.student_count === "number" ? (
                        <> Found <strong>{testResult.student_count.toLocaleString()}</strong> students on the other end.</>
                      ) : (
                        <> Credentials accepted and a student record was readable.</>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <FaTimesCircle aria-hidden="true" />
                    <div>
                      <strong>{testResult.error_type === "auth" ? "Authentication failed." : "Connection failed."}</strong>
                      <div className="int-test-msg">{testResult.message}</div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="int-wizard-actions">
            <button className="int-btn int-btn-ghost" onClick={() => setStep(2)}>Back</button>
            <button
              className="int-btn int-btn-primary"
              disabled={!testResult?.ok}
              onClick={() => setStep(4)}
            >
              Continue <FaChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Step 4 — cadence + enable */}
      {step === 4 && (
        <div className="int-wizard-body">
          <h4 className="int-step-title">4. Sync cadence</h4>
          <p className="int-step-desc">
            Pick how often Dismissal should pull changes.  You can always hit <em>Sync now</em> from the dashboard
            to force an immediate refresh.
          </p>

          <div className="int-form">
            <label className="int-field">
              <span>Automatic sync interval</span>
              <select
                value={syncInterval}
                onChange={(e) => setSyncInterval(e.target.value)}
              >
                {SYNC_INTERVALS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <small>
                Only changed records are pulled each pass (delta sync).  Students enrolled this morning
                appear by dismissal time.
              </small>
            </label>
          </div>

          {saveError && (
            <div className="int-error" role="alert">
              <FaExclamationTriangle aria-hidden="true" /> {saveError}
            </div>
          )}

          <div className="int-wizard-actions">
            <button className="int-btn int-btn-ghost" onClick={() => setStep(3)}>Back</button>
            <button
              className="int-btn int-btn-primary"
              onClick={handleEnable}
              disabled={saving}
            >
              {saving ? "Saving…" : "Enable & run first sync"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — post-connection
// ─────────────────────────────────────────────────────────────────────────────
function SisDashboard({ api, districtId, cfg, onRefresh }) {
  const [syncing, setSyncing]     = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [jobs, setJobs]           = useState([]);
  const [duplicates, setDuplicates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [actionError, setActionError] = useState("");
  const [resolvingId, setResolvingId] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const loadJobs = useCallback(() => {
    api.get(`/api/v1/admin/districts/${districtId}/sis-sync-jobs?limit=25`)
      .then((r) => setJobs(r.data.jobs || []))
      .catch(() => {});
  }, [api, districtId]);

  const loadDuplicates = useCallback(() => {
    api.get(`/api/v1/admin/districts/${districtId}/sis-duplicates`)
      .then((r) => setDuplicates(r.data.duplicates || []))
      .catch(() => {});
  }, [api, districtId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadJobs(), loadDuplicates()]).finally(() => setLoading(false));
  }, [loadJobs, loadDuplicates]);

  const runSyncNow = async () => {
    setSyncing(true);
    setActionError("");
    setLastResult(null);
    try {
      const res = await api.post(`/api/v1/admin/districts/${districtId}/sis-sync`);
      setLastResult(res.data);
      loadJobs();
      loadDuplicates();
      onRefresh();
    } catch (err) {
      setActionError(err.response?.data?.detail || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const resolveDuplicate = async (dupId, action) => {
    setResolvingId(dupId);
    try {
      await api.post(
        `/api/v1/admin/districts/${districtId}/sis-duplicates/${dupId}/resolve`,
        { action },
      );
      setDuplicates((prev) => prev.filter((d) => d.id !== dupId));
    } catch (err) {
      setActionError(err.response?.data?.detail || "Could not resolve duplicate");
    } finally {
      setResolvingId(null);
    }
  };

  const disconnect = async () => {
    try {
      await api.put(`/api/v1/admin/districts/${districtId}/sis-config`, { enabled: false });
      onRefresh();
    } catch (err) {
      setActionError(err.response?.data?.detail || "Could not disable SIS");
    }
  };

  const statusTone = cfg.last_sync_status === "ok"    ? "ok"
                   : cfg.last_sync_status === "error" ? "fail"
                   : "neutral";
  const summary = cfg.last_sync_summary || {};

  return (
    <>
      <section className="int-section int-dashboard">
        <div className="int-dash-head">
          <div>
            <h3 className="int-section-title">Student Information System</h3>
            <p className="int-section-sub">
              Connected via <strong>{(cfg.provider || "").toUpperCase()}</strong>{" "}
              · syncs {SYNC_INTERVALS.find((s) => s.value === cfg.sync_interval)?.label.toLowerCase() || "every 2 hours"}
            </p>
          </div>
          <div className="int-dash-actions">
            <button className="int-btn int-btn-primary" onClick={runSyncNow} disabled={syncing}>
              <FaSyncAlt className={syncing ? "int-spin" : ""} aria-hidden="true" />
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button className="int-btn int-btn-ghost" onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </button>
          </div>
        </div>

        {actionError && (
          <div className="int-error" role="alert">
            <FaExclamationTriangle aria-hidden="true" /> {actionError}
          </div>
        )}

        <div className="int-status-grid">
          <StatusCard
            label="Last sync"
            value={cfg.last_sync_at ? relativeFrom(cfg.last_sync_at) : "Never"}
            detail={cfg.last_sync_at ? new Date(cfg.last_sync_at).toLocaleString() : null}
            tone={statusTone}
          />
          <StatusCard label="Students added (last run)"   value={summary.students_added   ?? 0} />
          <StatusCard label="Students updated (last run)" value={summary.students_updated ?? 0} />
          <StatusCard label="Guardians added (last run)"  value={summary.guardians_added  ?? 0} />
          <StatusCard label="Flagged duplicates"          value={duplicates.length} tone={duplicates.length > 0 ? "warn" : "neutral"} />
        </div>

        {lastResult && (
          <div className={`int-result${lastResult.status === "ok" ? " ok" : " fail"}`} role="status">
            <FaCheckCircle aria-hidden="true" />
            <div>
              <strong>
                {lastResult.status === "ok" ? "Sync complete." : "Sync failed."}
              </strong>{" "}
              {lastResult.status === "ok" ? (
                <>
                  +{lastResult.summary?.students_added ?? 0} students, ~{lastResult.summary?.students_updated ?? 0} updated,{" "}
                  +{lastResult.summary?.guardians_added ?? 0} guardians.{" "}
                  {(lastResult.summary?.duplicates_flagged ?? 0) > 0 && (
                    <em>{lastResult.summary.duplicates_flagged} flagged for review.</em>
                  )}
                </>
              ) : (
                <span>{lastResult.error}</span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Duplicate review */}
      {duplicates.length > 0 && (
        <section className="int-section">
          <h3 className="int-section-title">
            Review: {duplicates.length} student{duplicates.length === 1 ? "" : "s"} may already exist in Dismissal
          </h3>
          <p className="int-section-sub">
            These SIS records share a name and school with an existing Dismissal student but no sourcedId
            was recorded yet.  Merge to link them (SIS takes over the name/grade fields), or keep them
            separate to create a second record.
          </p>
          <div className="int-dup-list">
            {duplicates.map((d) => (
              <DuplicateRow
                key={d.id}
                dup={d}
                onResolve={(action) => resolveDuplicate(d.id, action)}
                busy={resolvingId === d.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Recent sync jobs */}
      <section className="int-section">
        <h3 className="int-section-title">Recent sync jobs</h3>
        {loading ? (
          <div className="int-state" role="status">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="int-state" role="status">No sync jobs yet.  Hit <em>Sync now</em> above to run the first one.</div>
        ) : (
          <div className="int-table-wrap">
            <table className="int-table">
              <caption className="sr-only">SIS sync history</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Status</th>
                  <th scope="col">Students</th>
                  <th scope="col">Guardians</th>
                  <th scope="col">Duplicates</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const started = j.started_at ? new Date(j.started_at) : null;
                  const finished = j.finished_at ? new Date(j.finished_at) : null;
                  const duration = started && finished ? `${Math.round((finished - started) / 1000)}s` : "—";
                  return (
                    <tr key={j.id}>
                      <td title={j.started_at}>{started ? started.toLocaleString() : "—"}</td>
                      <td>{j.trigger}</td>
                      <td>
                        <span className={`int-status-pill ${j.status}`}>
                          {j.status}
                        </span>
                      </td>
                      <td>+{j.students_added ?? 0} / ~{j.students_updated ?? 0}</td>
                      <td>+{j.guardians_added ?? 0} / ~{j.guardians_updated ?? 0}</td>
                      <td>{j.duplicates_flagged ?? 0}</td>
                      <td>{duration}</td>
                      <td className="int-table-error">{j.error || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmDisconnect && (
        <div className="int-modal-overlay" onClick={(e) => e.target === e.currentTarget && setConfirmDisconnect(false)}>
          <div className="int-modal" role="dialog" aria-modal="true" aria-labelledby="int-disconnect-title">
            <h3 id="int-disconnect-title">Disconnect SIS?</h3>
            <p>
              Existing imported students and guardians stay in Dismissal.  Scheduled syncs stop until you re-enable.
              Credentials are preserved so re-enabling doesn't require re-entering them.
            </p>
            <div className="int-modal-actions">
              <button className="int-btn int-btn-ghost" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
              <button className="int-btn int-btn-danger" onClick={() => { setConfirmDisconnect(false); disconnect(); }}>
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────
function StatusCard({ label, value, detail, tone = "neutral" }) {
  return (
    <div className={`int-status-card int-tone-${tone}`}>
      <span className="int-status-label">{label}</span>
      <span className="int-status-value">{value}</span>
      {detail && <span className="int-status-detail" title={detail}>{detail}</span>}
    </div>
  );
}

function DuplicateRow({ dup, onResolve, busy }) {
  const ex = dup.existing || {};
  return (
    <div className="int-dup-row">
      <div className="int-dup-col">
        <div className="int-dup-col-label">Already in Dismissal</div>
        <strong>{ex.first_name} {ex.last_name}</strong>
        {ex.grade && <div className="int-dup-col-meta">Grade {ex.grade}</div>}
        {ex.guardian_uid ? (
          <div className="int-dup-col-meta">Linked to a guardian</div>
        ) : (
          <div className="int-dup-col-meta">Unlinked</div>
        )}
      </div>
      <div className="int-dup-col">
        <div className="int-dup-col-label">Incoming from SIS</div>
        <strong>{dup.sis_given_name} {dup.sis_family_name}</strong>
        {dup.sis_grade && <div className="int-dup-col-meta">Grade {dup.sis_grade}</div>}
        {dup.sis_local_id && <div className="int-dup-col-meta">Student # {dup.sis_local_id}</div>}
      </div>
      <div className="int-dup-actions">
        <button
          className="int-btn int-btn-primary"
          onClick={() => onResolve("merge")}
          disabled={busy}
          aria-label={`Merge ${dup.sis_given_name} ${dup.sis_family_name} with existing Dismissal record`}
        >
          {busy ? "…" : "Merge"}
        </button>
        <button
          className="int-btn int-btn-ghost"
          onClick={() => onResolve("keep_separate")}
          disabled={busy}
          aria-label={`Keep these as two separate students`}
        >
          Keep separate
        </button>
      </div>
    </div>
  );
}

function relativeFrom(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const delta = (Date.now() - d.getTime()) / 1000;
  if (delta < 60)        return "just now";
  if (delta < 3600)      return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400)     return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}
