import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./AuditLog.css";

// ─────────────────────────────────────────────────────────────────────────────
// AuditLog.jsx — per-user session & activity trail (issue #86).
//
// Enterprise audit UI: a full-page timeline scoped to the caller's role,
// with a filter bar (actor, action family, date range, outcome, search),
// an expandable event detail drawer, CSV export (server-rendered, respects
// every active filter), pagination (cursor-based), and a summary strip
// showing last-24h / 7d / 30d counts + top actions.
//
// Live-tail mode (issue #157): a "Live" toggle pulls newly-written events
// via short tail-polls of the same scoped HTTP endpoint, prepends them with
// a fade-in, and caps in-memory history at LIVE_CAP.  We deliberately
// don't open a WebSocket — the backend runs on stateless Cloud Functions
// that can't host one (see core/live_queue.py for the same migration the
// Dashboard made), and audit_log Firestore rules block client-side reads
// so onSnapshot isn't an option either.  Polling the existing role-scoped
// HTTP endpoint reuses every authorisation guarantee the backend already
// enforces and gives a single, easy-to-reason-about teardown surface.
//
// The shape mirrors what Microsoft 365 Defender / Google Admin Audit Log
// expose to customers — rich actor/target metadata, a stable action
// taxonomy, and a clear audit trail that stays readable after targets
// are deleted.
// ─────────────────────────────────────────────────────────────────────────────

// Cap on rows held in state during a long live session.  The view shows
// recency-first, so older rows fall off the tail when new ones arrive.
const LIVE_CAP = 500;
const LIVE_BASE_DELAY_MS = 3000;
const LIVE_MAX_DELAY_MS  = 30_000;

// Action catalogue: icon + colour + human label per action name.  Keeping
// this client-side is fine because the backend enum is closed and only
// changes alongside the UI.  Unknown actions fall back to a generic icon.
const ACTION_META = {
  // auth
  "auth.signin.success":    { icon: I.signIn,    family: "auth",     label: "Signed in",             tone: "ok" },
  "auth.signout":           { icon: I.signOut,   family: "auth",     label: "Signed out",            tone: "neutral" },
  "auth.session.expired":   { icon: I.signOut,   family: "auth",     label: "Session expired",       tone: "neutral" },
  "auth.denied":            { icon: I.alert,     family: "auth",     label: "Access denied",         tone: "warn" },
  // user mgmt
  "user.invited":           { icon: I.user,      family: "users",    label: "Invited user",          tone: "ok" },
  "user.role.changed":      { icon: I.edit,      family: "users",    label: "Role changed",          tone: "warn" },
  "user.status.changed":    { icon: I.ban,       family: "users",    label: "Account status changed", tone: "warn" },
  "user.profile.updated":   { icon: I.edit,      family: "users",    label: "Profile updated",       tone: "neutral" },
  "user.deleted":           { icon: I.trash,     family: "users",    label: "User deleted",          tone: "crit" },
  "user.invite.resent":     { icon: I.user,      family: "users",    label: "Invite resent",         tone: "neutral" },
  // plates
  "plate.imported":         { icon: I.upload,    family: "plates",   label: "Plates imported",       tone: "ok" },
  "plate.created":          { icon: I.car,       family: "plates",   label: "Plate added",           tone: "neutral" },
  "plate.updated":          { icon: I.car,       family: "plates",   label: "Plate updated",         tone: "neutral" },
  "plate.deleted":          { icon: I.trash,     family: "plates",   label: "Plate removed",         tone: "warn" },
  // scans
  "scan.dismissed":         { icon: I.checkCircle, family: "scans",  label: "Pickup marked",         tone: "neutral" },
  "scan.bulk_dismissed":    { icon: I.checkCircle, family: "scans",  label: "Bulk pickup",           tone: "warn" },
  "scan.queue.cleared":     { icon: I.trash,     family: "scans",    label: "Queue cleared",         tone: "warn" },
  "scan.history.cleared":   { icon: I.trash,     family: "scans",    label: "Scan history cleared",  tone: "crit" },
  // guardians / students
  "guardian.school.assigned": { icon: I.guardians, family: "guardians", label: "Guardian approved",     tone: "ok" },
  "guardian.school.removed":  { icon: I.guardians, family: "guardians", label: "Guardian access removed", tone: "warn" },
  "student.linked":         { icon: I.guardians, family: "guardians", label: "Student linked",        tone: "ok" },
  "student.unlinked":       { icon: I.guardians, family: "guardians", label: "Student unlinked",      tone: "warn" },
  // sso
  "sso.domain.created":     { icon: I.key,       family: "sso",      label: "SSO domain added",      tone: "warn" },
  "sso.domain.updated":     { icon: I.key,       family: "sso",      label: "SSO domain updated",    tone: "warn" },
  "sso.domain.deleted":     { icon: I.key,       family: "sso",      label: "SSO domain removed",    tone: "crit" },
  // districts / schools
  "district.created":       { icon: I.building,  family: "org",      label: "District created",      tone: "warn" },
  "district.updated":       { icon: I.building,  family: "org",      label: "District updated",      tone: "neutral" },
  "district.deleted":       { icon: I.building,  family: "org",      label: "District deleted",      tone: "crit" },
  "school.created":         { icon: I.building,  family: "org",      label: "School created",        tone: "warn" },
  "school.updated":         { icon: I.building,  family: "org",      label: "School updated",        tone: "neutral" },
  "school.status.changed":  { icon: I.building,  family: "org",      label: "School status changed", tone: "warn" },
  "school.deleted":         { icon: I.building,  family: "org",      label: "School deleted",        tone: "crit" },
  // data / devices / permissions
  "data.exported":          { icon: I.download,  family: "data",     label: "Data exported",         tone: "warn" },
  "device.assigned":        { icon: I.device,    family: "devices",  label: "Device re-assigned",    tone: "warn" },
  "device.location.changed":{ icon: I.device,    family: "devices",  label: "Device location changed", tone: "neutral" },
  "permission.updated":     { icon: I.cog,       family: "settings", label: "Permissions updated",   tone: "warn" },
};

const FAMILY_LABELS = {
  auth:      "Authentication",
  users:     "User management",
  plates:    "Plate registry",
  scans:     "Scans / queue",
  guardians: "Guardians & students",
  sso:       "Single Sign-On",
  org:       "Districts & schools",
  data:      "Data export",
  devices:   "Devices",
  settings:  "Permissions",
};

function metaFor(action) {
  return ACTION_META[action] || { icon: I.history, family: "other", label: action, tone: "neutral" };
}

function Severity({ level }) {
  const label = { info: "Info", warning: "Warning", critical: "Critical" }[level] || level;
  return <span className={`al-severity al-severity-${level || "info"}`}>{label}</span>;
}

// Relative-time formatter tuned for an audit trail — "42m ago" for recent
// events, a calendar date for anything past a week.  Always falls back to
// the exact ISO on hover (via `title`).
function formatRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const delta = (Date.now() - d.getTime()) / 1000;
  if (delta < 45)        return "just now";
  if (delta < 60 * 60)   return `${Math.round(delta / 60)}m ago`;
  if (delta < 24 * 3600) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 7 * 86400) return `${Math.round(delta / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: delta > 365 * 86400 ? "numeric" : undefined });
}

function formatAbsolute(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary strip
// ─────────────────────────────────────────────────────────────────────────────
function SummaryStrip({ token, schoolId, refreshKey }) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get("/api/v1/audit/summary")
      .then((r) => setSummary(r.data))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [api, refreshKey]);

  const counts = summary?.counts || {};
  const top = summary?.top_actions || [];

  return (
    <section className="al-summary" aria-label="Activity at a glance">
      <div className="al-summary-stats">
        <div className="al-summary-stat">
          <span className="al-summary-num">{loading ? "…" : (counts["24h"] ?? 0)}</span>
          <span className="al-summary-lbl">events · 24h</span>
        </div>
        <div className="al-summary-stat">
          <span className="al-summary-num">{loading ? "…" : (counts["7d"] ?? 0)}</span>
          <span className="al-summary-lbl">events · 7d</span>
        </div>
        <div className="al-summary-stat">
          <span className="al-summary-num">{loading ? "…" : (counts["30d"] ?? 0)}</span>
          <span className="al-summary-lbl">events · 30d</span>
        </div>
      </div>
      {top.length > 0 && (
        <div className="al-summary-top">
          <span className="al-summary-top-label">Top actions (30d)</span>
          <div className="al-summary-top-list">
            {top.slice(0, 6).map((t) => (
              <span key={t.action} className="al-summary-chip" title={t.action}>
                {metaFor(t.action).label}
                <span className="al-summary-chip-count">{t.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-select dropdown for action filter
// ─────────────────────────────────────────────────────────────────────────────
function ActionFilter({ selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    // Escape closes the dialog and returns focus to the trigger so a
    // keyboard user isn't stranded in detached focus state — matches
    // the modal pattern UserManagement uses for its dialogs.
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const byFamily = useMemo(() => {
    const acc = {};
    for (const [key, meta] of Object.entries(ACTION_META)) {
      if (!acc[meta.family]) acc[meta.family] = [];
      acc[meta.family].push({ key, label: meta.label });
    }
    return acc;
  }, []);

  const toggleAction = (key) => {
    const set = new Set(selected);
    if (set.has(key)) set.delete(key); else set.add(key);
    onChange([...set]);
  };

  const toggleFamily = (family) => {
    const famKeys = byFamily[family].map((a) => a.key);
    const set = new Set(selected);
    const allOn = famKeys.every((k) => set.has(k));
    for (const k of famKeys) {
      if (allOn) set.delete(k); else set.add(k);
    }
    onChange([...set]);
  };

  const label = selected.length === 0
    ? "All actions"
    : selected.length === 1
      ? (metaFor(selected[0]).label || selected[0])
      : `${selected.length} actions`;

  return (
    <div className="al-multi" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`al-multi-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Filter by action"
      >
        <I.filter size={13} className="al-multi-icon" aria-hidden="true" />
        <span>{label}</span>
        <I.chevronDown size={13} className={`al-multi-chevron${open ? " open" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="al-multi-panel" role="dialog" aria-label="Action filter">
          <div className="al-multi-header">
            <span>Filter by action</span>
            {selected.length > 0 && (
              <button className="al-link-btn" onClick={() => onChange([])} type="button">
                Clear
              </button>
            )}
          </div>
          <div className="al-multi-body">
            {Object.entries(byFamily).map(([family, actions]) => {
              const famKeys = actions.map((a) => a.key);
              const famChecked = famKeys.filter((k) => selected.includes(k)).length;
              const indet = famChecked > 0 && famChecked < famKeys.length;
              return (
                <div key={family} className="al-multi-group">
                  <label className="al-multi-group-label">
                    <input
                      type="checkbox"
                      checked={famChecked === famKeys.length}
                      ref={(el) => { if (el) el.indeterminate = indet; }}
                      onChange={() => toggleFamily(family)}
                    />
                    <strong>{FAMILY_LABELS[family] || family}</strong>
                  </label>
                  <div className="al-multi-group-items">
                    {actions.map((a) => (
                      <label key={a.key} className="al-multi-item">
                        <input
                          type="checkbox"
                          checked={selected.includes(a.key)}
                          onChange={() => toggleAction(a.key)}
                        />
                        <span>{a.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expanded event detail
// ─────────────────────────────────────────────────────────────────────────────
function EventDetail({ event }) {
  const { actor = {}, target = {}, context = {}, diff, message, correlation_id } = event;
  return (
    <div className="al-detail">
      <div className="al-detail-grid">
        <div className="al-detail-block">
          <div className="al-detail-block-head">Actor</div>
          <dl className="al-detail-kv">
            <dt>UID</dt><dd><code>{actor.uid || "—"}</code></dd>
            <dt>Email</dt><dd>{actor.email || "—"}</dd>
            <dt>Name</dt><dd>{actor.display_name || "—"}</dd>
            <dt>Role</dt><dd>{actor.role || "—"}</dd>
          </dl>
        </div>
        <div className="al-detail-block">
          <div className="al-detail-block-head">Target</div>
          {target && (target.type || target.id || target.display_name) ? (
            <dl className="al-detail-kv">
              <dt>Type</dt><dd>{target.type || "—"}</dd>
              <dt>ID</dt><dd><code>{target.id || "—"}</code></dd>
              <dt>Label</dt><dd>{target.display_name || "—"}</dd>
            </dl>
          ) : (
            <p className="al-detail-muted">No specific target.</p>
          )}
        </div>
        <div className="al-detail-block">
          <div className="al-detail-block-head">Context</div>
          <dl className="al-detail-kv">
            <dt>IP</dt><dd><code>{context.ip || "—"}</code></dd>
            <dt>Device</dt><dd>{[context.device, context.browser, context.os].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>School</dt><dd><code>{context.school_id || "—"}</code></dd>
            <dt>District</dt><dd><code>{context.district_id || "—"}</code></dd>
            <dt>Request</dt><dd><code>{context.correlation_id || correlation_id || "—"}</code></dd>
          </dl>
        </div>
      </div>

      {message && (
        <div className="al-detail-message">
          <span className="al-detail-block-head">Message</span>
          <p>{message}</p>
        </div>
      )}

      {diff && (
        <div className="al-detail-diff">
          <span className="al-detail-block-head">Diff</span>
          <pre className="al-detail-diff-pre">
            {JSON.stringify(diff, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event row (timeline item)
// ─────────────────────────────────────────────────────────────────────────────
function EventRow({ event, expanded, onToggle }) {
  const meta = metaFor(event.action);
  const Icon = meta.icon;
  const actor = event.actor || {};
  const target = event.target || {};
  const ctx = event.context || {};
  const actorLabel = actor.display_name || actor.email || actor.uid || "Unknown";
  const targetLabel = target.display_name || target.id || null;
  const device = [ctx.device, ctx.browser].filter(Boolean).join(" · ");

  return (
    <li className={`al-row al-tone-${meta.tone}${expanded ? " expanded" : ""}${event._live ? " al-row-new" : ""}`}>
      <button
        type="button"
        className="al-row-main"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`al-icon-wrap al-icon-${meta.tone}`}>
          <Icon size={14} stroke={2} aria-hidden="true" />
        </span>
        <div className="al-row-content">
          <div className="al-row-headline">
            <span className="al-action-label">{meta.label}</span>
            <Severity level={event.severity} />
            {event.outcome === "failure" && (
              <span className="al-outcome-failure">failed</span>
            )}
          </div>
          <div className="al-row-sub">
            <strong>{actorLabel}</strong>
            {targetLabel && (
              <>
                {" "}<span className="al-row-muted">·</span>{" "}
                <span>{targetLabel}</span>
              </>
            )}
            {event.message && (
              <>
                {" "}<span className="al-row-muted">·</span>{" "}
                <span className="al-row-message">{event.message}</span>
              </>
            )}
          </div>
          <div className="al-row-meta">
            <span title={formatAbsolute(event.timestamp)}>{formatRelative(event.timestamp)}</span>
            {ctx.ip && (
              <>
                <span className="al-dot">·</span>
                <span><span className="al-meta-dot" aria-hidden="true" /> {ctx.ip}</span>
              </>
            )}
            {device && (
              <>
                <span className="al-dot">·</span>
                <span>{device}</span>
              </>
            )}
          </div>
        </div>
        <I.chevronDown size={14} className={`al-row-chevron${expanded ? " open" : ""}`} aria-hidden="true" />
      </button>
      {expanded && <EventDetail event={event} />}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function AuditLog({
  token,
  schoolId = null,
  initialActorUid = null,
  initialActorLabel = null,
}) {
  const api = useMemo(() => createApiClient(token, schoolId), [token, schoolId]);

  // Filter state
  const [actorUid, setActorUid]       = useState(initialActorUid);
  const [actorLabel, setActorLabel]   = useState(initialActorLabel);
  const [actions, setActions]         = useState([]);
  const [outcome, setOutcome]         = useState("");
  const [since, setSince]             = useState("");
  const [until, setUntil]             = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch]           = useState("");

  // Data state
  const [events, setEvents]       = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]         = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Live-tail state.  ``live`` is the user's intent (toggle ON/OFF);
  // ``paused`` halts polling without leaving live mode so an investigator
  // can read a row without it shifting under them.  ``liveStatus`` drives
  // the pulsing-dot indicator.
  const [live, setLive]               = useState(false);
  const [paused, setPaused]           = useState(false);
  const [liveStatus, setLiveStatus]   = useState(null); // null | connecting | streaming | reconnecting | paused
  const [newCount, setNewCount]       = useState(0);    // events streamed in this live session, for the pill

  // Debounce search input → effective search query
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const buildParams = useCallback((extra = {}) => {
    const p = new URLSearchParams();
    if (actorUid) p.set("actor_uid", actorUid);
    for (const a of actions) p.append("action", a);
    if (outcome) p.set("outcome", outcome);
    if (since)   p.set("since", new Date(since).toISOString());
    if (until)   p.set("until", new Date(until).toISOString());
    if (search)  p.set("search", search);
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p;
  }, [actorUid, actions, outcome, since, until, search]);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const params = buildParams({ limit: 50 });
    api.get(`/api/v1/audit/events?${params.toString()}`)
      .then((r) => {
        setEvents(r.data.events || []);
        setNextCursor(r.data.next_cursor || null);
      })
      .catch((err) => {
        setError(err.response?.data?.detail || "Failed to load audit events");
        setEvents([]);
      })
      .finally(() => setLoading(false));
  }, [api, buildParams]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const params = buildParams({ limit: 50, cursor: nextCursor });
    api.get(`/api/v1/audit/events?${params.toString()}`)
      .then((r) => {
        setEvents((prev) => [...prev, ...(r.data.events || [])]);
        setNextCursor(r.data.next_cursor || null);
      })
      .catch((err) => setError(err.response?.data?.detail || "Failed to load more"))
      .finally(() => setLoadingMore(false));
  }, [api, buildParams, nextCursor]);

  // ── Live tail ─────────────────────────────────────────────────────
  // Single setTimeout-based poll loop.  Reasons for setTimeout over
  // setInterval:
  //   * No overlapping requests if the network is slow — each tick is
  //     scheduled only after the previous one resolves.
  //   * Easy exponential backoff on errors without juggling intervals.
  //   * Single timer to clear in cleanup → impossible to leak.
  //
  // Refs (not state) hold values the tick reads each fire so the effect
  // doesn't re-mount on every new event or filter keystroke.  The effect
  // re-runs only when intent changes (live, paused) or when the request
  // shape changes (api, filter signature).  Stale state inside the tick
  // is avoided by reading from refs.
  const eventsRef     = useRef(events);
  const buildParamsRef = useRef(buildParams);
  const apiRef        = useRef(api);
  const loadingRef    = useRef(loading);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { buildParamsRef.current = buildParams; }, [buildParams]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Toggle live OFF whenever the underlying scope changes (token rotation
  // or school switch).  Re-enabling is an explicit user action — we
  // intentionally don't auto-resume across boundaries, since the new
  // scope might be a different campus and silently streaming events from
  // it would be surprising.
  useEffect(() => {
    setLive(false);
    setPaused(false);
    setNewCount(0);
  }, [api]);

  useEffect(() => {
    if (!live)   { setLiveStatus(null); return; }
    if (paused)  { setLiveStatus("paused"); return; }

    // Fresh session bookkeeping.  Each (re)entry into the running state
    // gets its own cancelled flag so a stale tick from a prior session
    // can't write into the new one.
    let cancelled = false;
    let inFlight  = false;
    let timer     = null;
    let delay     = LIVE_BASE_DELAY_MS;

    setLiveStatus("connecting");

    const tick = async () => {
      if (cancelled || inFlight) return;
      // Don't race the initial-load / refresh fetch — it replaces the
      // event list wholesale, and a tick prepend mid-flight would either
      // be discarded by the replacement or duplicate rows.  Skip and let
      // the next scheduled tick try again once load() settles.
      if (loadingRef.current) {
        timer = setTimeout(tick, LIVE_BASE_DELAY_MS);
        return;
      }
      inFlight = true;
      try {
        // Anchor at the freshest event we hold.  When the list is empty
        // (e.g. fresh page with strict filters), use "now" so we only see
        // genuinely new events.  The backend's ``since`` filter is >=,
        // so the anchor row may come back again — we de-dupe by id.
        // ``extra.since`` overrides the user's date-filter ``since`` in
        // buildParams (the extras loop sets keys after the filter loop),
        // which is what we want: live mode tracks the newest cursor.
        const tailFrom = eventsRef.current[0]?.timestamp || new Date().toISOString();
        const params = buildParamsRef.current({ limit: 50, since: tailFrom });
        const res = await apiRef.current.get(`/api/v1/audit/events?${params.toString()}`);
        if (cancelled) return;

        const fresh = res.data?.events || [];
        if (fresh.length > 0) {
          // Dedupe against current state.  ``since`` is inclusive on the
          // backend, so the anchor row reliably comes back; ids drop it.
          const seen = new Set(eventsRef.current.map((e) => e.id));
          const incoming = fresh.filter((e) => !seen.has(e.id));
          if (incoming.length > 0) {
            const tagged = incoming.map((e) => ({ ...e, _live: true }));
            setEvents((prev) => {
              // Re-check against the latest committed state in case it
              // changed between the snapshot above and this updater.
              const liveSeen = new Set(prev.map((e) => e.id));
              const stillNew = tagged.filter((e) => !liveSeen.has(e.id));
              if (stillNew.length === 0) return prev;
              const merged = [...stillNew, ...prev];
              return merged.length > LIVE_CAP ? merged.slice(0, LIVE_CAP) : merged;
            });
            setNewCount((n) => n + incoming.length);
          }
        }
        setLiveStatus("streaming");
        delay = LIVE_BASE_DELAY_MS;
      } catch {
        if (cancelled) return;
        setLiveStatus("reconnecting");
        delay = Math.min(delay * 2, LIVE_MAX_DELAY_MS);
      } finally {
        inFlight = false;
        if (!cancelled) timer = setTimeout(tick, delay);
      }
    };

    timer = setTimeout(tick, LIVE_BASE_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
    };
  }, [live, paused]);

  const toggleLive = useCallback(() => {
    setLive((on) => {
      const next = !on;
      // Resetting newCount on entry gives the user a clean "events since I
      // turned this on" counter; on exit we drop the _live tags so a later
      // refresh doesn't re-animate stale rows.
      if (next) {
        setNewCount(0);
        setPaused(false);
      } else {
        setEvents((prev) => prev.map((e) => (e._live ? { ...e, _live: false } : e)));
      }
      return next;
    });
  }, []);

  const handleExportCsv = useCallback(async () => {
    const params = buildParams();
    try {
      const res = await api.get(`/api/v1/audit/events.csv?${params.toString()}`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers?.["content-disposition"] || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      a.download = match ? match[1] : `dismissal-audit.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to export CSV");
    }
  }, [api, buildParams]);

  const clearFilters = () => {
    setActorUid(null);
    setActorLabel(null);
    setActions([]);
    setOutcome("");
    setSince("");
    setUntil("");
    setSearchInput("");
  };

  const hasFilters = Boolean(
    actorUid || actions.length || outcome || since || until || search,
  );

  return (
    <div className="al-container page-shell">
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Audit · activity</span>
          <h1 className="page-title">Activity Log</h1>
          <p className="page-sub">
            Who did what, when, and from where.  Every privileged action is
            recorded; access is restricted to the scope you administer.
          </p>
        </div>
        <div className="page-actions">
          {live && (
            <div
              className={`al-live-pill al-live-${liveStatus || "connecting"}`}
              role="status"
              aria-live="polite"
              aria-label={
                liveStatus === "paused"
                  ? "Live stream paused"
                  : liveStatus === "reconnecting"
                    ? "Reconnecting to live stream"
                    : "Live stream active"
              }
              title={
                liveStatus === "paused"
                  ? "Stream paused"
                  : liveStatus === "reconnecting"
                    ? "Reconnecting…"
                    : "Streaming new events as they happen"
              }
            >
              <span className="al-live-dot" aria-hidden="true" />
              <span className="al-live-label">
                {liveStatus === "paused"
                  ? "Paused"
                  : liveStatus === "reconnecting"
                    ? "Reconnecting"
                    : "Live"}
              </span>
              {newCount > 0 && (
                <span className="al-live-count" aria-label={`${newCount} new`}>
                  {newCount > 999 ? "999+" : newCount}
                </span>
              )}
            </div>
          )}
          {live && (
            <button
              className="al-btn-ghost"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
              title={paused ? "Resume the live stream" : "Pause new events without leaving live mode"}
            >
              <span>{paused ? "Resume" : "Pause"}</span>
            </button>
          )}
          <button
            className={`al-btn-ghost al-live-toggle${live ? " is-on" : ""}`}
            onClick={toggleLive}
            aria-pressed={live}
            title={live ? "Stop streaming new events" : "Stream new events as they're written"}
          >
            <span className="al-live-toggle-dot" aria-hidden="true" />
            <span>{live ? "Live · ON" : "Go live"}</span>
          </button>
          <button
            className="al-btn-ghost"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading || live}
            aria-label="Refresh"
            title={live ? "Disable live mode to refresh manually" : "Refresh"}
          >
            <I.refresh size={13} className={loading ? "al-spin" : ""} aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button
            className="al-btn-primary"
            onClick={handleExportCsv}
            disabled={events.length === 0}
            aria-label="Export filtered events as CSV"
          >
            <I.download size={13} aria-hidden="true" /> Export CSV
          </button>
        </div>
      </div>

      <SummaryStrip token={token} schoolId={schoolId} refreshKey={refreshKey} />

      {/* ── Filter bar ── */}
      <div className="al-filter-bar">
        <div className="al-search">
          <I.search size={14} className="al-search-icon" aria-hidden="true" />
          <label htmlFor="al-search-input" className="sr-only">
            Search actor, target, IP, or message
          </label>
          <input
            id="al-search-input"
            type="search"
            placeholder="Search actor, target, IP, message…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button
              className="al-search-clear"
              onClick={() => setSearchInput("")}
              aria-label="Clear search"
            ><I.x size={14} aria-hidden="true" /></button>
          )}
        </div>

        <ActionFilter selected={actions} onChange={setActions} />

        <label className="al-field">
          <span className="al-field-lbl">Outcome</span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            aria-label="Outcome filter"
          >
            <option value="">Any</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>

        <label className="al-field">
          <span className="al-field-lbl">From</span>
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="Since"
          />
        </label>

        <label className="al-field">
          <span className="al-field-lbl">To</span>
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="Until"
          />
        </label>

        {hasFilters && (
          <button className="al-btn-ghost al-btn-clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {actorUid && (
        <div className="al-actor-banner">
          <I.shield size={13} stroke={2.2} aria-hidden="true" />
          Filtering activity for <strong>{actorLabel || actorUid}</strong>.
          <button
            className="al-link-btn"
            onClick={() => { setActorUid(null); setActorLabel(null); }}
          >
            Show all users
          </button>
        </div>
      )}

      {/* ── Timeline ── */}
      {error && (
        <div className="al-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading events…</p>
        </div>
      ) : events.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.history size={22} aria-hidden="true" /></span>
          <h3 className="page-empty-title">No events match these filters</h3>
          <p className="page-empty-sub">
            {hasFilters
              ? "Try widening the date range or clearing a filter."
              : "Activity will appear here as users sign in and take privileged actions."}
          </p>
        </div>
      ) : (
        <>
          <ol
            className="al-timeline"
            role="log"
            aria-label="Audit event timeline"
            aria-live="polite"
            aria-relevant="additions"
          >
            {events.map((ev) => (
              <EventRow
                key={ev.id}
                event={ev}
                expanded={expandedId === ev.id}
                onToggle={() => setExpandedId((cur) => cur === ev.id ? null : ev.id)}
              />
            ))}
          </ol>

          {nextCursor && !live && (
            <div className="al-load-more">
              <button
                className="al-btn-ghost"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load 50 more"}
              </button>
            </div>
          )}
          {live && events.length >= LIVE_CAP && (
            <p className="al-footnote">
              Holding the {LIVE_CAP} most recent events. Older live events are dropped to keep the page responsive.
            </p>
          )}
          {!nextCursor && !live && events.length >= 50 && (
            <p className="al-footnote">End of results for these filters.</p>
          )}
        </>
      )}
    </div>
  );
}
