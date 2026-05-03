import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaGoogle, FaMicrosoft, FaPlus, FaTrashAlt, FaExclamationTriangle,
  FaShieldAlt, FaSchool, FaGlobe,
} from "react-icons/fa";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import "./SsoSettings.css";

// ─────────────────────────────────────────────────────────────────────────────
// Single Sign-On admin page.
//
// Scope: super_admin and district_admin manage domain → {provider,
// default_role, default_school} mappings.  When a user signs in with a
// federated identity whose email domain matches a mapping, the backend
// auto-provisions them at the stamped role.
//
// Provider on/off is controlled in Firebase Console (Authentication →
// Sign-in method), not here — that's the authoritative switch and the
// login page picks it up automatically.  Clever + ClassLink are listed
// as "coming soon" in the dropdown but can't be picked until their
// OIDC wiring ships.
//
// District admins are capped at default_role="staff"; granting school_admin
// via SSO is a super_admin-only action.  The backend enforces this too.
// ─────────────────────────────────────────────────────────────────────────────

// Provider catalog.  The `provider` field on a mapping is mostly a label
// stamped at sign-in time — the backend (core/auth.py) accepts any
// `oidc.*` / `saml.*` Firebase sign_in_provider claim, so the entries
// here are an admin-facing shortlist with tailored setup guidance for
// the IdPs we see most often.  "Generic OIDC" / "Generic SAML 2.0" are
// the catch-alls for anything else a district registers in Firebase
// Console (Identity Platform required for custom OIDC/SAML providers).
const PROVIDER_META = {
  google:      { label: "Google Workspace",         icon: FaGoogle,    enabled: true,  note: "" },
  microsoft:   { label: "Microsoft 365 / Entra ID", icon: FaMicrosoft, enabled: true,  note: "Includes Azure AD" },
  okta:        { label: "Okta",                     icon: null,        enabled: true,  note: "OIDC or SAML" },
  onelogin:    { label: "OneLogin",                 icon: null,        enabled: true,  note: "OIDC or SAML" },
  ping:        { label: "Ping Identity",            icon: null,        enabled: true,  note: "PingOne / PingFederate" },
  quicklaunch: { label: "Quicklaunch.io",           icon: null,        enabled: true,  note: "" },
  shibboleth:  { label: "Shibboleth / InCommon",    icon: null,        enabled: true,  note: "SAML 2.0" },
  clever:      { label: "Clever",                   icon: null,        enabled: false, note: "Coming soon" },
  classlink:   { label: "ClassLink",                icon: null,        enabled: false, note: "Coming soon" },
  oidc:        { label: "Generic OIDC",             icon: null,        enabled: true,  note: "Any OpenID Connect IdP" },
  saml:        { label: "Generic SAML 2.0",         icon: null,        enabled: true,  note: "Any SAML 2.0 IdP" },
};

// Groupings for the Provider <select>.  Order within a group is the
// order options render under that <optgroup>.
const PROVIDER_GROUPS = [
  { label: "Identity providers", keys: ["google", "microsoft", "okta", "onelogin", "ping", "quicklaunch", "shibboleth"] },
  { label: "K-12 SSO",           keys: ["clever", "classlink"] },
  { label: "Generic protocols",  keys: ["oidc", "saml"] },
];

export default function SsoSettings({ token, currentUser, activeDistrict }) {
  const isSuperAdmin = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const api = useMemo(() => createApiClient(token), [token]);

  // For super_admin, activeDistrict comes from the platform drill-down.
  // For district_admin, their own district is the only one they can see.
  const districtId = activeDistrict?.id || currentUser?.district_id || null;

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
  // Delete-confirmation dialog target — replaces the previous
  // window.confirm() prompt so the destructive flow matches the
  // modal-based pattern used by SiteSettings (the canonical table
  // delete UX in the admin portal).
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError]   = useState("");

  // ── Load domain mappings (scoped by backend to visibility rules) ───────
  const loadMappings = useCallback(async () => {
    setLoadingMappings(true);
    setMappingsError("");
    try {
      const res = await api.get("/api/v1/admin/sso/domains");
      setMappings(res.data.mappings || []);
    } catch (err) {
      setMappingsError(formatApiError(err, "Failed to load domain mappings"));
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
      setCreateError(formatApiError(err, "Failed to create mapping"));
    } finally {
      setCreating(false);
    }
  };

  // ── Delete mapping ────────────────────────────────────────────────────
  // Two-step: row "Remove" button calls openDeleteDialog (sets the
  // target); the modal's confirm CTA calls confirmDeleteMapping (does
  // the actual API call).  Surface errors inside the modal so the user
  // can decide whether to retry or cancel without losing their place.
  const openDeleteDialog = (mapping) => {
    setDeleteTarget(mapping);
    setDeleteError("");
  };

  const confirmDeleteMapping = async () => {
    if (!deleteTarget) return;
    const domain = deleteTarget.domain;
    setDeletingDomain(domain);
    setDeleteError("");
    try {
      await api.delete(`/api/v1/admin/sso/domains/${encodeURIComponent(domain)}`);
      setMappings((prev) => prev.filter((m) => m.domain !== domain));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(formatApiError(err, "Failed to delete mapping"));
    } finally {
      setDeletingDomain(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  if (isSuperAdmin && !districtId) {
    return (
      <div className="sso-container page-shell">
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><FaShieldAlt aria-hidden="true" style={{ fontSize: 22 }} /></span>
          <p className="page-empty-title">Pick a district first</p>
          <p className="page-empty-sub">
            SSO is configured per district. Go to Districts, select one,
            then come back to Single Sign-On.
          </p>
        </div>
      </div>
    );
  }

  if (!isSuperAdmin && !isDistrictAdmin) {
    return (
      <div className="sso-container page-shell">
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><FaShieldAlt aria-hidden="true" style={{ fontSize: 22 }} /></span>
          <p className="page-empty-title">Insufficient permissions</p>
          <p className="page-empty-sub">
            Single Sign-On is managed by platform and district admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="sso-container page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">District · authentication</span>
          <h1 className="page-title">Single Sign-On</h1>
          <p className="page-sub">
            Let staff sign in with their district identity and auto-provision
            new users when their email domain matches a configured mapping.
            {activeDistrict?.name && (
              <> &nbsp;·&nbsp; <strong>{activeDistrict.name}</strong></>
            )}
          </p>
        </div>
        {!loadingMappings && mappings.length > 0 && (
          <div className="page-actions">
            <span
              className="page-chip"
              aria-label={`${mappings.length} domain mappings`}
            >
              <FaGlobe size={12} aria-hidden="true" />
              {mappings.length.toLocaleString()} {mappings.length === 1 ? "mapping" : "mappings"}
            </span>
          </div>
        )}
      </div>

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
          <div className="um-error" role="alert">
            <FaExclamationTriangle aria-hidden="true" />
            <span>{mappingsError}</span>
            <button
              className="um-error-dismiss"
              onClick={() => setMappingsError("")}
              aria-label="Dismiss error"
            >
              <span aria-hidden="true">×</span>
            </button>
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
                  {PROVIDER_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.keys.map((k) => {
                        const m = PROVIDER_META[k];
                        if (!m) return null;
                        return (
                          <option key={k} value={k} disabled={!m.enabled}>
                            {m.label}{!m.enabled ? " (coming soon)" : ""}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                </select>
                {PROVIDER_META[newMapping.provider]?.note && (
                  <span className="sso-field-hint">
                    {PROVIDER_META[newMapping.provider].note}
                  </span>
                )}
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
          <div className="page-empty" role="status" aria-live="polite">
            <span className="page-empty-icon"><FaShieldAlt aria-hidden="true" style={{ fontSize: 20 }} /></span>
            <p className="page-empty-title">Loading mappings…</p>
          </div>
        ) : mappings.length === 0 ? (
          <div className="page-empty" role="status">
            <span className="page-empty-icon"><FaGlobe aria-hidden="true" style={{ fontSize: 22 }} /></span>
            <p className="page-empty-title">No domain mappings yet</p>
            <p className="page-empty-sub">
              Add one so users from your district's email domain can sign in via SSO.
            </p>
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
                    <tr key={m.domain} className="sso-row">
                      <td data-label="Domain"><code className="sso-domain-chip">@{m.domain}</code></td>
                      <td data-label="Provider">{provMeta.label}</td>
                      <td data-label="Default role">
                        <span className={`sso-role-chip sso-role-${m.default_role}`}>
                          {m.default_role === "school_admin" ? "School admin" : "Staff"}
                        </span>
                      </td>
                      <td data-label="Default school">
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
                        <td data-label="District" className="sso-muted">{m.district_id}</td>
                      )}
                      <td data-label="Actions">
                        <button
                          className="sso-btn-delete"
                          onClick={() => openDeleteDialog(m)}
                          disabled={deletingDomain === m.domain}
                          aria-label={`Delete mapping for @${m.domain}`}
                          title={`Delete mapping for @${m.domain}`}
                        >
                          <FaTrashAlt aria-hidden="true" />
                          <span className="btn-text">{deletingDomain === m.domain ? "…" : "Remove"}</span>
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
            Microsoft 365 / Entra ID (incl. Azure AD) needs an app
            registration
            (<a href="https://firebase.google.com/docs/auth/web/microsoft-oauth" target="_blank" rel="noreferrer">docs</a>).
            For Okta, OneLogin, Ping, Shibboleth/InCommon, Quicklaunch,
            or any other third-party IdP, register a custom OIDC or SAML
            provider in
            {" "}<a href="https://cloud.google.com/identity-platform/docs/web/oidc" target="_blank" rel="noreferrer">Identity Platform</a>{" "}
            (the upgraded tier of Firebase Auth) — that issues the
            <code>oidc.&lt;id&gt;</code> / <code>saml.&lt;id&gt;</code> provider
            ID Firebase recognises at sign-in.  Provider on/off in the
            console is the authoritative switch; this page just decides
            who gets auto-provisioned and at what role.
          </li>
          <li>
            <strong>Add your email domain</strong> below with the role new
            users should get — most districts map <code>@district.edu</code>
            → Staff, and pre-invite admins by email for school_admin access.
            Pick the named provider if it's on the list; otherwise pick
            <em> Generic OIDC</em> or <em>Generic SAML 2.0</em>.  The
            provider field is a label for setup docs and audit — auth
            itself accepts any OIDC/SAML claim once the IdP is registered
            in Firebase.
          </li>
          <li>
            <strong>Test with a staff account</strong>.  Their first sign-in
            creates their Dismissal account automatically at the mapped role.
          </li>
        </ol>
      </section>

      {/* ── Delete-confirmation modal (replaces window.confirm) ──
          Mirrors the SiteSettings delete pattern so destructive
          row actions feel consistent across admin tables. */}
      {deleteTarget && (
        <div
          className="sso-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && deletingDomain !== deleteTarget.domain) {
              setDeleteTarget(null);
            }
          }}
        >
          <div
            className="sso-modal sso-modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sso-delete-title"
          >
            <div className="sso-modal-header">
              <h2 id="sso-delete-title" className="sso-modal-title">Remove SSO mapping</h2>
              <button
                className="sso-modal-close"
                onClick={() => deletingDomain !== deleteTarget.domain && setDeleteTarget(null)}
                aria-label="Close dialog"
              >&times;</button>
            </div>
            <div className="sso-modal-body">
              <p className="sso-delete-prompt">
                Remove the SSO mapping for <strong>@{deleteTarget.domain}</strong>?
              </p>
              <p className="sso-delete-warning">
                Users from this domain will no longer be auto-provisioned on first sign-in.
                Existing accounts created via this mapping keep working.
              </p>
              {deleteError && <p className="sso-field-error">{deleteError}</p>}
            </div>
            <div className="sso-form-actions">
              <button
                type="button"
                className="sso-btn-secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingDomain === deleteTarget.domain}
              >Cancel</button>
              <button
                type="button"
                className="sso-btn-delete"
                onClick={confirmDeleteMapping}
                disabled={deletingDomain === deleteTarget.domain}
              >
                <FaTrashAlt aria-hidden="true" />
                {deletingDomain === deleteTarget.domain ? "Removing…" : "Remove mapping"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
