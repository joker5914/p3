import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaGoogle, FaMicrosoft, FaPlus, FaTrashAlt, FaExclamationTriangle,
  FaShieldAlt, FaSchool, FaGlobe,
} from "react-icons/fa";
import { createApiClient } from "./api";
import "./SsoSettings.css";

// ─────────────────────────────────────────────────────────────────────────────
// Single Sign-On admin page (issue #88 phase 2).
//
// Scope: super_admin and district_admin configure federated identity for
// their district.  Two things live here:
//
//   1. Provider toggles (Google / Microsoft / Clever / ClassLink) at the
//      district level.  Clever + ClassLink are disabled placeholders — the
//      underlying OIDC wiring ships in follow-up issues.
//   2. Domain → {provider, default_role, default_school} mappings.  When a
//      user signs in with a federated identity whose email domain matches
//      a mapping, the backend auto-provisions them at the stamped role.
//
// District admins are capped at default_role="staff"; granting school_admin
// via SSO is a super_admin-only action.  The backend enforces this too.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_META = {
  google:    { label: "Google Workspace",        icon: FaGoogle,    enabled: true,  note: "" },
  microsoft: { label: "Microsoft 365 / Entra ID", icon: FaMicrosoft, enabled: true,  note: "" },
  clever:    { label: "Clever",                   icon: null,        enabled: false, note: "Coming soon" },
  classlink: { label: "ClassLink",                icon: null,        enabled: false, note: "Coming soon" },
};

export default function SsoSettings({ token, currentUser, activeDistrict }) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const api = useMemo(() => createApiClient(token), [token]);

  // For super_admin, activeDistrict comes from the platform drill-down.
  // For district_admin, their own district is the only one they can see.
  const districtId = activeDistrict?.id || currentUser?.district_id || null;

  const [loadingCfg, setLoadingCfg]     = useState(false);
  const [ssoConfig, setSsoConfig]       = useState(null);
  const [configError, setConfigError]   = useState("");
  const [savingProvider, setSavingProvider] = useState(null);

  // Microsoft tenant — editable inline once you toggle Microsoft on.
  const [msTenantDraft, setMsTenantDraft] = useState("");

  // Domain mappings state
  const [mappings, setMappings]         = useState([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [mappingsError, setMappingsError] = useState("");
  const [addOpen, setAddOpen]           = useState(false);
  const [districts, setDistricts]       = useState([]);
  const [schools, setSchools]           = useState([]);
  const [newMapping, setNewMapping]     = useState({
    domain: "",
    district_id: districtId || "",
    provider: "google",
    default_role: "staff",
    default_school_id: "",
  });
  const [creating, setCreating]         = useState(false);
  const [createError, setCreateError]   = useState("");
  const [deletingDomain, setDeletingDomain] = useState(null);

  // ── Load provider toggles for the selected district ────────────────────
  const loadConfig = useCallback(async () => {
    if (!districtId) { setSsoConfig(null); return; }
    setLoadingCfg(true);
    setConfigError("");
    try {
      const res = await api.get(`/api/v1/admin/districts/${districtId}/sso-config`);
      setSsoConfig(res.data.sso_config);
      setMsTenantDraft(res.data.sso_config?.microsoft?.tenant_id || "");
    } catch (err) {
      setConfigError(err.response?.data?.detail || "Failed to load SSO config");
      setSsoConfig(null);
    } finally {
      setLoadingCfg(false);
    }
  }, [api, districtId]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // ── Load domain mappings (scoped by backend to visibility rules) ───────
  const loadMappings = useCallback(async () => {
    setLoadingMappings(true);
    setMappingsError("");
    try {
      const res = await api.get("/api/v1/admin/sso/domains");
      setMappings(res.data.mappings || []);
    } catch (err) {
      setMappingsError(err.response?.data?.detail || "Failed to load domain mappings");
    } finally {
      setLoadingMappings(false);
    }
  }, [api]);

  useEffect(() => { loadMappings(); }, [loadMappings]);

  // ── Load schools + districts for the add-mapping form ──────────────────
  useEffect(() => {
    if (!addOpen) return;
    if (isSuperAdmin) {
      api.get("/api/v1/admin/districts")
        .then((r) => setDistricts(r.data.districts || []))
        .catch(() => setDistricts([]));
    }
    const endpoint = isSuperAdmin
      ? "/api/v1/admin/schools"
      : "/api/v1/site-settings/schools";
    api.get(endpoint)
      .then((r) => setSchools(r.data.schools || []))
      .catch(() => setSchools([]));
  }, [addOpen, api, isSuperAdmin]);

  // ── Provider toggle ────────────────────────────────────────────────────
  const handleProviderToggle = async (providerKey, nextValue) => {
    if (!districtId) return;
    setSavingProvider(providerKey);
    try {
      const currentForProvider = ssoConfig?.[providerKey] || {};
      const payload = { [providerKey]: { ...currentForProvider, enabled: nextValue } };
      const res = await api.put(
        `/api/v1/admin/districts/${districtId}/sso-config`,
        payload,
      );
      setSsoConfig(res.data.sso_config);
      setMsTenantDraft(res.data.sso_config?.microsoft?.tenant_id || "");
    } catch (err) {
      setConfigError(err.response?.data?.detail || "Failed to update provider");
    } finally {
      setSavingProvider(null);
    }
  };

  const handleMicrosoftTenantSave = async () => {
    if (!districtId) return;
    setSavingProvider("microsoft");
    try {
      const tenant = msTenantDraft.trim() || null;
      const res = await api.put(
        `/api/v1/admin/districts/${districtId}/sso-config`,
        { microsoft: { enabled: ssoConfig?.microsoft?.enabled ?? false, tenant_id: tenant } },
      );
      setSsoConfig(res.data.sso_config);
    } catch (err) {
      setConfigError(err.response?.data?.detail || "Failed to save tenant ID");
    } finally {
      setSavingProvider(null);
    }
  };

  // ── Create mapping ────────────────────────────────────────────────────
  const handleCreateMapping = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const payload = {
        domain: newMapping.domain.trim().toLowerCase(),
        district_id: newMapping.district_id.trim() || districtId,
        provider: newMapping.provider,
        default_role: newMapping.default_role,
        default_school_id: newMapping.default_school_id || null,
      };
      await api.post("/api/v1/admin/sso/domains", payload);
      setAddOpen(false);
      setNewMapping({
        domain: "",
        district_id: districtId || "",
        provider: "google",
        default_role: "staff",
        default_school_id: "",
      });
      loadMappings();
    } catch (err) {
      setCreateError(err.response?.data?.detail || "Failed to create mapping");
    } finally {
      setCreating(false);
    }
  };

  // ── Delete mapping ────────────────────────────────────────────────────
  const handleDeleteMapping = async (domain) => {
    if (!window.confirm(
      `Remove the SSO mapping for @${domain}?  Users from this domain will no longer be auto-provisioned on first sign-in.`,
    )) return;
    setDeletingDomain(domain);
    try {
      await api.delete(`/api/v1/admin/sso/domains/${encodeURIComponent(domain)}`);
      setMappings((prev) => prev.filter((m) => m.domain !== domain));
    } catch (err) {
      setMappingsError(err.response?.data?.detail || "Failed to delete mapping");
    } finally {
      setDeletingDomain(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  if (isSuperAdmin && !districtId) {
    return (
      <div className="sso-container">
        <div className="sso-empty" role="status">
          <FaShieldAlt size={32} aria-hidden="true" />
          <h3>Pick a district first</h3>
          <p>
            SSO is configured per district.  Go to Districts, select one,
            then come back to Single Sign-On.
          </p>
        </div>
      </div>
    );
  }

  if (!isSuperAdmin && !isDistrictAdmin) {
    return (
      <div className="sso-container">
        <div className="sso-empty" role="status">
          <FaShieldAlt size={32} aria-hidden="true" />
          <h3>Insufficient permissions</h3>
          <p>Single Sign-On is managed by platform and district admins.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sso-container">
      <header className="sso-header">
        <div>
          <h2 className="sso-title">Single Sign-On</h2>
          <p className="sso-subtitle">
            Let staff sign in with their district identity and auto-provision
            new users when their email domain matches a configured mapping.
            {activeDistrict?.name && (
              <> &nbsp;·&nbsp; <strong>{activeDistrict.name}</strong></>
            )}
          </p>
        </div>
      </header>

      {/* ── Provider toggles ── */}
      <section className="sso-section" aria-labelledby="sso-providers-heading">
        <h3 id="sso-providers-heading" className="sso-section-title">Identity providers</h3>
        <p className="sso-section-sub">
          Turn on the providers your district uses.  The actual OAuth credentials
          are configured once in Firebase Console; this toggle controls whether
          the button shows up on the sign-in page.
        </p>

        {configError && (
          <div className="sso-error" role="alert">
            <FaExclamationTriangle aria-hidden="true" /> {configError}
          </div>
        )}

        <div className="sso-provider-grid">
          {Object.entries(PROVIDER_META).map(([key, meta]) => {
            const enabled = ssoConfig?.[key]?.enabled ?? false;
            const Icon = meta.icon;
            const saving = savingProvider === key;
            return (
              <div
                key={key}
                className={`sso-provider-card${enabled ? " enabled" : ""}${!meta.enabled ? " disabled" : ""}`}
              >
                <div className="sso-provider-head">
                  {Icon ? <Icon className="sso-provider-icon" aria-hidden="true" /> :
                    <span className="sso-provider-icon-placeholder" aria-hidden="true" />}
                  <span className="sso-provider-label">{meta.label}</span>
                  {!meta.enabled && (
                    <span className="sso-badge-coming-soon">{meta.note}</span>
                  )}
                </div>
                <label className={`sso-switch${!meta.enabled ? " disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!meta.enabled || saving || loadingCfg}
                    onChange={(e) => handleProviderToggle(key, e.target.checked)}
                    aria-label={`Enable ${meta.label} sign-in`}
                  />
                  <span className="sso-switch-track" />
                  <span className="sso-switch-label">
                    {enabled ? "Enabled" : "Disabled"}
                  </span>
                </label>
                {key === "microsoft" && enabled && (
                  <div className="sso-provider-extra">
                    <label className="sso-field-label" htmlFor="ms-tenant">
                      Entra tenant ID
                      <span className="sso-field-hint">
                        Leave blank to accept any Microsoft account (<code>common</code>).
                      </span>
                    </label>
                    <div className="sso-inline-form">
                      <input
                        id="ms-tenant"
                        type="text"
                        className="sso-input"
                        placeholder="e.g. 72f988bf-86f1-41af-91ab-2d7cd011db47"
                        value={msTenantDraft}
                        onChange={(e) => setMsTenantDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="sso-btn-secondary"
                        onClick={handleMicrosoftTenantSave}
                        disabled={saving}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Domain mappings ── */}
      <section className="sso-section" aria-labelledby="sso-domains-heading">
        <div className="sso-section-row">
          <div>
            <h3 id="sso-domains-heading" className="sso-section-title">Domain auto-provisioning</h3>
            <p className="sso-section-sub">
              When a user signs in via SSO with an email at one of these
              domains, we create their account automatically at the role
              you pick below.  Unmapped email domains (personal Gmail,
              Outlook, etc.) become <strong>pending guardians</strong> — a
              campus admin still has to grant them access.
            </p>
          </div>
          <button
            className="sso-btn-primary"
            onClick={() => { setAddOpen((v) => !v); setCreateError(""); }}
            aria-expanded={addOpen}
          >
            <FaPlus aria-hidden="true" /> Add domain
          </button>
        </div>

        {mappingsError && (
          <div className="sso-error" role="alert">
            <FaExclamationTriangle aria-hidden="true" /> {mappingsError}
          </div>
        )}

        {addOpen && (
          <form className="sso-form" onSubmit={handleCreateMapping}>
            <div className="sso-form-row">
              <div className="sso-field">
                <label className="sso-field-label" htmlFor="sso-domain">
                  Email domain <span className="sso-required" aria-label="required">*</span>
                </label>
                <input
                  id="sso-domain"
                  type="text"
                  className="sso-input"
                  required
                  placeholder="lincoln.k12.example.edu"
                  value={newMapping.domain}
                  onChange={(e) => setNewMapping({ ...newMapping, domain: e.target.value })}
                />
              </div>
              <div className="sso-field">
                <label className="sso-field-label" htmlFor="sso-provider">Provider</label>
                <select
                  id="sso-provider"
                  className="sso-input"
                  value={newMapping.provider}
                  onChange={(e) => setNewMapping({ ...newMapping, provider: e.target.value })}
                >
                  {Object.entries(PROVIDER_META).map(([k, m]) => (
                    <option key={k} value={k} disabled={!m.enabled}>
                      {m.label}{!m.enabled ? " (coming soon)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="sso-form-row">
              {isSuperAdmin && (
                <div className="sso-field">
                  <label className="sso-field-label" htmlFor="sso-district">District</label>
                  <select
                    id="sso-district"
                    className="sso-input"
                    value={newMapping.district_id}
                    onChange={(e) => setNewMapping({ ...newMapping, district_id: e.target.value })}
                    required
                  >
                    <option value="">Select a district…</option>
                    {districts.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="sso-field">
                <label className="sso-field-label" htmlFor="sso-role">Default role on first sign-in</label>
                <select
                  id="sso-role"
                  className="sso-input"
                  value={newMapping.default_role}
                  onChange={(e) => setNewMapping({ ...newMapping, default_role: e.target.value })}
                >
                  <option value="staff">Staff (read-only)</option>
                  {isSuperAdmin && (
                    <option value="school_admin">School admin (full campus access)</option>
                  )}
                </select>
                {!isSuperAdmin && (
                  <span className="sso-field-hint">
                    Only platform admins can grant the school_admin role via SSO.
                  </span>
                )}
              </div>
              <div className="sso-field">
                <label className="sso-field-label" htmlFor="sso-school">Default school (optional)</label>
                <select
                  id="sso-school"
                  className="sso-input"
                  value={newMapping.default_school_id}
                  onChange={(e) => setNewMapping({ ...newMapping, default_school_id: e.target.value })}
                >
                  <option value="">— district-wide (unassigned) —</option>
                  {schools
                    .filter((s) => !newMapping.district_id || s.district_id === newMapping.district_id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                </select>
              </div>
            </div>

            {createError && (
              <p className="sso-field-error" role="alert">{createError}</p>
            )}

            <div className="sso-form-actions">
              <button
                type="button"
                className="sso-btn-secondary"
                onClick={() => setAddOpen(false)}
                disabled={creating}
              >
                Cancel
              </button>
              <button type="submit" className="sso-btn-primary" disabled={creating}>
                {creating ? "Creating…" : "Add mapping"}
              </button>
            </div>
          </form>
        )}

        {loadingMappings ? (
          <p className="sso-state" role="status" aria-live="polite">Loading mappings…</p>
        ) : mappings.length === 0 ? (
          <div className="sso-empty" role="status">
            <FaGlobe size={24} aria-hidden="true" />
            <p>No domain mappings yet.  Add one so users from your district's email domain can sign in via SSO.</p>
          </div>
        ) : (
          <div className="sso-table-wrap">
            <table className="sso-table">
              <caption className="sr-only">SSO domain mappings</caption>
              <thead>
                <tr>
                  <th scope="col">Domain</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Default role</th>
                  <th scope="col">Default school</th>
                  {isSuperAdmin && <th scope="col">District</th>}
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => {
                  const provMeta = PROVIDER_META[m.provider] || { label: m.provider };
                  const school = schools.find((s) => s.id === m.default_school_id);
                  return (
                    <tr key={m.domain}>
                      <td><code className="sso-domain-chip">@{m.domain}</code></td>
                      <td>{provMeta.label}</td>
                      <td>
                        <span className={`sso-role-chip sso-role-${m.default_role}`}>
                          {m.default_role === "school_admin" ? "School admin" : "Staff"}
                        </span>
                      </td>
                      <td>
                        {m.default_school_id ? (
                          <span>
                            <FaSchool aria-hidden="true" style={{ marginRight: 6 }} />
                            {school?.name || m.default_school_id}
                          </span>
                        ) : (
                          <span className="sso-muted">District-wide</span>
                        )}
                      </td>
                      {isSuperAdmin && (
                        <td className="sso-muted">{m.district_id}</td>
                      )}
                      <td>
                        <button
                          className="sso-btn-delete"
                          onClick={() => handleDeleteMapping(m.domain)}
                          disabled={deletingDomain === m.domain}
                          aria-label={`Delete mapping for @${m.domain}`}
                        >
                          <FaTrashAlt aria-hidden="true" />
                          {deletingDomain === m.domain ? "…" : "Remove"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Setup help ── */}
      <section className="sso-section sso-help">
        <h3 className="sso-section-title">Setup checklist</h3>
        <ol className="sso-help-steps">
          <li>
            <strong>Enable the provider in Firebase Console</strong> —
            Authentication → Sign-in method.  Google is one click.
            Microsoft needs an Azure AD app registration
            (<a href="https://firebase.google.com/docs/auth/web/microsoft-oauth" target="_blank" rel="noreferrer">docs</a>).
          </li>
          <li>
            <strong>Turn on the provider toggle above</strong> so the sign-in
            button shows on the login page.
          </li>
          <li>
            <strong>Add your email domain</strong> with the role new users
            should get — most districts map <code>@district.edu</code> → Staff,
            and pre-invite admins by email for school_admin access.
          </li>
          <li>
            <strong>Test with a staff account</strong>.  Their first sign-in
            creates their Dismissal account automatically at the mapped role.
          </li>
        </ol>
      </section>
    </div>
  );
}
