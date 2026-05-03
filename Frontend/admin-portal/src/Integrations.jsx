import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaPlug } from "react-icons/fa";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
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

// Preset cadence chips shown in the wizard + dashboard.  "Custom…" reveals
// a number+unit input that accepts anything from 15 minutes to 24 hours.
const SYNC_PRESETS = [
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h",  label: "1h"  },
  { value: "2h",  label: "2h",  recommended: true },
  { value: "4h",  label: "4h"  },
  { value: "8h",  label: "8h"  },
  { value: "12h", label: "12h" },
  { value: "24h", label: "24h" },
];

const SYNC_MIN_MINUTES = 15;
const SYNC_MAX_MINUTES = 24 * 60;

function intervalToMinutes(value) {
  if (!value) return 120;
  const m = /^(\d+)([hm])$/.exec(String(value).trim().toLowerCase());
  if (!m) return 120;
  const n = parseInt(m[1], 10);
  return m[2] === "h" ? n * 60 : n;
}

function formatInterval(value) {
  const mins = intervalToMinutes(value);
  if (mins < 60)        return `every ${mins} minutes`;
  if (mins === 60)      return "every hour";
  if (mins % 60 === 0)  return `every ${mins / 60} hours`;
  return `every ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const SECRET_PLACEHOLDER = "__dismissal_secret_set__";

// ─────────────────────────────────────────────────────────────────────────────
// Top-level page
// ─────────────────────────────────────────────────────────────────────────────
export default function Integrations({ setView, token, currentUser, activeDistrict, schoolId = null }) {
  const districtId = activeDistrict?.id || currentUser?.district_id || null;
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const isSuperAdmin    = currentUser?.role === "super_admin";
  const canAdminSis     = isDistrictAdmin || isSuperAdmin;
  // Pass the drilled-in school to the API client so every request carries
  // an X-School-Id header.  The backend uses it to self-heal records
  // whose district_id was never stamped — without the header the
  // resolver has no context and can't derive the district on first
  // contact for historical users.
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  const [cfg, setCfg]     = useState(null);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [cfgError, setCfgError] = useState("");

  const loadCfg = useCallback(() => {
    if (!districtId) { setCfg(null); return; }
    setLoadingCfg(true);
    setCfgError("");
    api.get(`/api/v1/admin/districts/${districtId}/sis-config`)
      .then((r) => setCfg(r.data.sis_config || null))
      .catch((e) => setCfgError(formatApiError(e, "Failed to load SIS config")))
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
          <I.building size={32} aria-hidden="true" />
          <h3>Pick a district first</h3>
          <p>SIS connections are configured per district.  Head to Districts, select one, then come back here.</p>
        </div>
      </div>
    );
  }

  // District admin whose record is missing district_id — rare after the
  // backfill lands, but worth surfacing as an actionable error instead
  // of letting them walk the wizard and 403 on Test Connection.
  if (isDistrictAdmin && !districtId) {
    return (
      <div className="int-container">
        <header className="int-header">
          <h2 className="int-title">Integrations</h2>
          <p className="int-subtitle">Connect your Student Information System so Dismissal always has current rosters.</p>
        </header>
        <div className="int-empty" role="status">
          <I.alert size={32} aria-hidden="true" />
          <h3>Your account is missing a district assignment</h3>
          <p>
            You're signed in as a district admin but your profile isn't linked to a district.
            Ask a platform admin to assign you one (Platform Users page), then reload this tab.
          </p>
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
          <I.alert size={14} aria-hidden="true" /> {cfgError}
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
            <I.upload size={14} aria-hidden="true" /> Open CSV importer
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
  // Tracks the user's *label* choice separately from the wire provider.
  // PowerSchool and OneRoster both store provider="oneroster" but the UI
  // keeps the card highlighted so nobody is confused after the click.
  const [powerschoolPicked, setPowerschoolPicked] = useState(false);
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
      setTestResult({ ok: false, message: formatApiError(err, "Connection failed") });
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
      setSaveError(formatApiError(err, "Failed to save config"));
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
              const disabled = p.status === "coming_soon";
              // Clicking PowerSchool selects OneRoster under the hood
              // (same wire protocol) but highlights the PowerSchool card
              // so the admin recognises what they picked.  This was a
              // UX bug in the first pass — aliases were unclickable.
              const effectiveProvider = p.status === "alias" ? "oneroster" : p.key;
              const active = provider === effectiveProvider && (p.status === "alias"
                ? powerschoolPicked
                : !powerschoolPicked);
              return (
                <button
                  type="button"
                  key={p.key}
                  className={`int-provider-card${active ? " active" : ""}${disabled ? " disabled" : ""}`}
                  onClick={() => {
                    if (disabled) return;
                    setProvider(effectiveProvider);
                    setPowerschoolPicked(p.status === "alias");
                  }}
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`${p.label}${disabled ? " (coming soon)" : ""}`}
                >
                  <div className="int-provider-head">
                    <strong>{p.label}</strong>
                    {p.status === "live"        && <span className="int-badge int-badge-live">Live</span>}
                    {p.status === "alias"       && <span className="int-badge int-badge-alias">Via OneRoster</span>}
                    {p.status === "coming_soon" && <span className="int-badge int-badge-soon">Coming soon</span>}
                  </div>
                  <p className="int-provider-blurb">{p.blurb}</p>
                </button>
              );
            })}
          </div>

          {powerschoolPicked && (
            <div className="int-note-small" role="note">
              <strong>PowerSchool uses OneRoster 1.2 natively.</strong>{" "}
              We'll store the provider as <code>oneroster</code> and use the
              PowerSchool OneRoster endpoint you provide in the next step.
            </div>
          )}

          <div className="int-billing-note" role="note">
            <I.bolt size={14} aria-hidden="true" />
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
              Continue <I.chevronRight size={12} aria-hidden="true" />
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
              Continue <I.chevronRight size={12} aria-hidden="true" />
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
              {testing ? (<><I.refresh size={14} className="int-spin" aria-hidden="true" /> Testing…</>) : (<><I.key size={14} aria-hidden="true" /> Run test</>)}
            </button>
            {testResult && (
              <div className={`int-test-result${testResult.ok ? " ok" : " fail"}`} role="status">
                {testResult.ok ? (
                  <>
                    <I.check size={14} aria-hidden="true" />
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
                    <I.x size={14} aria-hidden="true" />
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
              Continue <I.chevronRight size={12} aria-hidden="true" />
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
            <div className="int-field">
              <span>Automatic sync interval</span>
              <IntervalPicker value={syncInterval} onChange={setSyncInterval} />
              <small>
                Only changed records are pulled each pass (delta sync).  Floor is 15 minutes
                (below that pounds the SIS without benefit); ceiling is 24 hours.
              </small>
            </div>
          </div>

          {saveError && (
            <div className="int-error" role="alert">
              <I.alert size={14} aria-hidden="true" /> {saveError}
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
      setActionError(formatApiError(err, "Sync failed"));
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
      setActionError(formatApiError(err, "Could not resolve duplicate"));
    } finally {
      setResolvingId(null);
    }
  };

  const disconnect = async () => {
    try {
      await api.put(`/api/v1/admin/districts/${districtId}/sis-config`, { enabled: false });
      onRefresh();
    } catch (err) {
      setActionError(formatApiError(err, "Could not disable SIS"));
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
              · syncs <strong>{formatInterval(cfg.sync_interval || "2h")}</strong>
              {" "}<IntervalInlineEdit
                api={api}
                districtId={districtId}
                currentInterval={cfg.sync_interval}
                onSaved={onRefresh}
              />
            </p>
          </div>
          <div className="int-dash-actions">
            <button className="int-btn int-btn-primary" onClick={runSyncNow} disabled={syncing}>
              <I.refresh size={14} className={syncing ? "int-spin" : ""} aria-hidden="true" />
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button className="int-btn int-btn-ghost" onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </button>
          </div>
        </div>

        {actionError && (
          <div className="int-error" role="alert">
            <I.alert size={14} aria-hidden="true" /> {actionError}
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
            <I.check size={14} aria-hidden="true" />
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
                      <td data-label="When" title={j.started_at}>{started ? started.toLocaleString() : "—"}</td>
                      <td data-label="Trigger">{j.trigger}</td>
                      <td data-label="Status">
                        <span className={`int-status-pill ${j.status}`}>
                          {j.status}
                        </span>
                      </td>
                      <td data-label="Students">+{j.students_added ?? 0} / ~{j.students_updated ?? 0}</td>
                      <td data-label="Guardians">+{j.guardians_added ?? 0} / ~{j.guardians_updated ?? 0}</td>
                      <td data-label="Duplicates">{j.duplicates_flagged ?? 0}</td>
                      <td data-label="Duration">{duration}</td>
                      <td data-label="Error" className="int-table-error">{j.error || "—"}</td>
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

// ─────────────────────────────────────────────────────────────────────────────
// Interval picker — preset chips + Custom input
//
// Mirrors the backend parser (15m floor, 24h ceiling).  The Custom option
// reveals a number + unit input that clamps to the same range so invalid
// values never hit the API.
// ─────────────────────────────────────────────────────────────────────────────
function IntervalPicker({ value, onChange }) {
  const isPreset = SYNC_PRESETS.some((p) => p.value === value);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [customN, setCustomN]       = useState(() => {
    if (isPreset) return 45;
    const m = /^(\d+)([hm])$/.exec(String(value || "").trim().toLowerCase());
    if (!m) return 45;
    return parseInt(m[1], 10);
  });
  const [customUnit, setCustomUnit] = useState(() => {
    if (isPreset) return "m";
    const m = /^(\d+)([hm])$/.exec(String(value || "").trim().toLowerCase());
    return m ? m[2] : "m";
  });

  const pickPreset = (v) => {
    setCustomOpen(false);
    onChange(v);
  };

  const applyCustom = () => {
    const mins = customUnit === "h" ? customN * 60 : customN;
    if (mins < SYNC_MIN_MINUTES || mins > SYNC_MAX_MINUTES) return;
    onChange(`${customN}${customUnit}`);
  };

  const customInvalid = (() => {
    const mins = customUnit === "h" ? customN * 60 : customN;
    return !Number.isFinite(customN) || mins < SYNC_MIN_MINUTES || mins > SYNC_MAX_MINUTES;
  })();

  return (
    <div className="int-interval" role="group" aria-label="Automatic sync interval">
      <div className="int-interval-chips">
        {SYNC_PRESETS.map((p) => (
          <button
            type="button"
            key={p.value}
            className={`int-interval-chip${value === p.value && !customOpen ? " active" : ""}`}
            onClick={() => pickPreset(p.value)}
            aria-pressed={value === p.value && !customOpen}
          >
            {p.label}
            {p.recommended && <span className="int-interval-recommended" aria-hidden="true">★</span>}
          </button>
        ))}
        <button
          type="button"
          className={`int-interval-chip int-interval-chip-custom${customOpen ? " active" : ""}`}
          onClick={() => setCustomOpen((v) => !v)}
          aria-pressed={customOpen}
          aria-expanded={customOpen}
        >
          Custom…
        </button>
      </div>

      {customOpen && (
        <div className="int-interval-custom">
          <label className="sr-only" htmlFor="int-custom-n">Custom interval amount</label>
          <input
            id="int-custom-n"
            type="number"
            min="1"
            max={customUnit === "h" ? 24 : 1440}
            step="1"
            value={customN}
            onChange={(e) => setCustomN(parseInt(e.target.value, 10) || 0)}
          />
          <label className="sr-only" htmlFor="int-custom-unit">Custom interval unit</label>
          <select
            id="int-custom-unit"
            value={customUnit}
            onChange={(e) => setCustomUnit(e.target.value)}
          >
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </select>
          <button
            type="button"
            className="int-btn int-btn-ghost int-interval-apply"
            onClick={applyCustom}
            disabled={customInvalid}
          >
            Apply
          </button>
          {customInvalid && (
            <span className="int-interval-invalid" role="alert">
              Pick between {SYNC_MIN_MINUTES} minutes and 24 hours.
            </span>
          )}
        </div>
      )}

      <div className="int-interval-summary" aria-live="polite">
        Currently syncing <strong>{formatInterval(value)}</strong>.
      </div>
    </div>
  );
}

// Inline-edit control used on the dashboard — lets an admin rotate the
// cadence without going back through the wizard.  Collapsed by default to
// keep the dashboard lean; expanding reveals the IntervalPicker + Save.
function IntervalInlineEdit({ api, districtId, currentInterval, onSaved }) {
  const [open, setOpen]   = useState(false);
  const [draft, setDraft] = useState(currentInterval || "2h");
  const [saving, setSaving] = useState(false);
  const [err, setErr]     = useState("");

  const save = async () => {
    setSaving(true); setErr("");
    try {
      await api.put(`/api/v1/admin/districts/${districtId}/sis-config`, { sync_interval: draft });
      setOpen(false);
      onSaved && onSaved();
    } catch (e) {
      setErr(formatApiError(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="int-interval-edit-link"
        onClick={() => { setDraft(currentInterval || "2h"); setOpen(true); }}
        aria-label="Change sync interval"
      >
        Change
      </button>
    );
  }
  return (
    <div className="int-interval-inline">
      <IntervalPicker value={draft} onChange={setDraft} />
      {err && <div className="int-error" role="alert">{err}</div>}
      <div className="int-interval-inline-actions">
        <button type="button" className="int-btn int-btn-ghost" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="int-btn int-btn-primary" onClick={save} disabled={saving || draft === currentInterval}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
