import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase-config";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";
import ConfirmDialog from "./ConfirmDialog";
import "./BenefactorPortal.css";

// ─── Inline Icons (minimal) ────────────────────────────────────────────────
const IconChildren = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const IconCar = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h1l2-3h8l2 3h1a2 2 0 012 2v6a2 2 0 01-2 2M5 17a2 2 0 002 2h10a2 2 0 002-2" />
    <circle cx="7.5" cy="14.5" r="1.5" /><circle cx="16.5" cy="14.5" r="1.5" />
  </svg>
);
const IconUser = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);
const IconShield = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const IconClock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
  </svg>
);
const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const IconSchool = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 10l10-7 10 7" /><path d="M22 10v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10" /><path d="M8 22v-6a2 2 0 012-2h4a2 2 0 012 2v6" />
  </svg>
);
const IconChevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const IconToday = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const IconClipboard = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="12" height="16" rx="2" />
    <path d="M9 4h6v3H9z" fill="currentColor" stroke="none" />
    <path d="M9 11h6M9 15h4" />
  </svg>
);

// ─── School Switcher (Slack/Notion-inspired) ────────────────────────────────
function SchoolSwitcher({ schools, selectedSchool, onSelect }) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (schools.length <= 1) return null;

  const current = selectedSchool
    ? schools.find((s) => s.id === selectedSchool)
    : null;
  const label = current ? current.name : "All Schools";

  return (
    <div className="bp-school-switcher" ref={dropdownRef}>
      <button className="bp-school-switcher-btn" onClick={() => setOpen((o) => !o)}>
        <span className="bp-school-switcher-icon">
          {current?.logo_url ? (
            <img src={current.logo_url} alt="" className="bp-school-logo" />
          ) : (
            <IconSchool />
          )}
        </span>
        <span className="bp-school-switcher-label">{label}</span>
        <span className={`bp-school-switcher-chevron${open ? " open" : ""}`}><IconChevron /></span>
      </button>

      {open && (
        <div className="bp-school-dropdown">
          <div className="bp-school-dropdown-header">Switch School</div>
          <button
            className={`bp-school-option${!selectedSchool ? " active" : ""}`}
            onClick={() => { onSelect(null); setOpen(false); }}
          >
            <span className="bp-school-option-icon bp-school-option-all">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
            </span>
            <span className="bp-school-option-info">
              <span className="bp-school-option-name">All Schools</span>
              <span className="bp-school-option-detail">{schools.length} schools</span>
            </span>
            {!selectedSchool && <span className="bp-school-option-check">&#10003;</span>}
          </button>

          <div className="bp-school-dropdown-divider" />

          {schools.map((s) => (
            <button
              key={s.id}
              className={`bp-school-option${selectedSchool === s.id ? " active" : ""}`}
              onClick={() => { onSelect(s.id); setOpen(false); }}
            >
              <span className="bp-school-option-icon">
                {s.logo_url ? (
                  <img src={s.logo_url} alt="" className="bp-school-logo-sm" />
                ) : (
                  <IconSchool />
                )}
              </span>
              <span className="bp-school-option-info">
                <span className="bp-school-option-name">{s.name}</span>
                {s.dismissal_time && <span className="bp-school-option-detail">Dismissal: {s.dismissal_time}</span>}
              </span>
              {selectedSchool === s.id && <span className="bp-school-option-check">&#10003;</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── Today Tab ──────────────────────────────────────────────────────────────
function TodayTab({ api, schools }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/today")
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const formatTime = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return time;
    } catch {
      return ts;
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;
  if (error) return <div className="bp-error">{error} <button onClick={() => { setError(""); load(); }}>Retry</button></div>;
  if (!data) return null;

  const { schools: schoolSummaries = [], today_events = [] } = data;

  return (
    <div>
      {/* School cards overview */}
      <div className="bp-today-schools">
        {schoolSummaries.map((s) => (
          <div key={s.id} className="bp-today-school-card">
            <div className="bp-today-school-header">
              <span className="bp-today-school-icon"><IconSchool /></span>
              <div className="bp-today-school-info">
                <h4 className="bp-today-school-name">{s.name}</h4>
                <span className="bp-today-school-meta">
                  {s.children_count} {s.children_count === 1 ? "child" : "children"}
                  {s.dismissal_time && <> &middot; Dismissal at {s.dismissal_time}</>}
                </span>
              </div>
            </div>
            {s.children && s.children.length > 0 && (
              <div className="bp-today-children">
                {s.children.map((c) => (
                  <div key={c.id} className="bp-today-child-chip">
                    <PersonAvatar name={`${c.first_name} ${c.last_name}`} photoUrl={c.photo_url} size={24} />
                    <span>{c.first_name}</span>
                    {c.grade && <span className="bp-today-child-grade">Gr. {c.grade}</span>}
                  </div>
                ))}
              </div>
            )}
            {s.today_events_count > 0 && (
              <div className="bp-today-school-activity">
                <IconCar /> <span>{s.today_events_count} pickup {s.today_events_count === 1 ? "event" : "events"} today</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Merged today's activity feed */}
      <div className="bp-section-header" style={{ marginTop: 24 }}>
        <span>Today's Activity</span>
        <button className="bp-btn bp-btn-ghost bp-btn-sm" onClick={load}>Refresh</button>
      </div>

      {today_events.length === 0 ? (
        <div className="bp-today-empty">
          <span className="bp-today-empty-icon">
            <IconClock />
          </span>
          <p>No pickup activity yet today. Events will appear here as they happen.</p>
        </div>
      ) : (
        <div className="bp-activity-list">
          {today_events.map((ev) => {
            const school = schoolSummaries.find((s) => s.id === ev.school_id);
            return (
              <div key={ev.id} className="bp-activity-row">
                <div className="bp-activity-icon">
                  <IconCar />
                </div>
                <div className="bp-activity-info">
                  <div className="bp-activity-main">
                    <span className="bp-activity-vehicle">{ev.vehicle_desc}</span>
                    {ev.plate_number && <span className="bp-plate-badge">{ev.plate_number}</span>}
                  </div>
                  {ev.students.length > 0 && (
                    <span className="bp-activity-students">{ev.students.join(", ")}</span>
                  )}
                  <span className="bp-activity-meta">
                    {formatTime(ev.timestamp)}
                    {school && <> &middot; {school.name}</>}
                    {ev.location && <> &middot; {ev.location}</>}
                    {ev.picked_up_at && <> &middot; Picked up</>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


export default function BenefactorPortal({ token, currentUser, handleLogout }) {
  const [tab, setTab] = useState("today");
  const [schools, setSchools] = useState([]);
  const [selectedSchool, setSelectedSchool] = useState(null); // null = "All Schools"
  const [noSchool, setNoSchool] = useState(false);
  const [checkingAgain, setCheckingAgain] = useState(false);

  // Build API client that threads school_id when a specific school is selected
  const api = useCallback(() => {
    const client = createApiClient(token);
    if (!selectedSchool) return client;
    // Wrap get/post/patch/delete to append school_id query param
    const original = { get: client.get.bind(client), post: client.post.bind(client), patch: client.patch.bind(client), delete: client.delete.bind(client) };
    const appendSchoolId = (url) => {
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}school_id=${encodeURIComponent(selectedSchool)}`;
    };
    client.get = (url, config) => original.get(appendSchoolId(url), config);
    // POST/PATCH/DELETE don't need school_id in query for mutations
    return client;
  }, [token, selectedSchool]);

  // Plain API without school filtering (for endpoints that don't need it)
  const plainApi = useCallback(() => createApiClient(token), [token]);

  const firstName = (currentUser?.display_name || "").split(" ")[0] || "there";
  const hasMultipleSchools = schools.length > 1;

  // Load assigned schools
  const loadSchools = useCallback(() => {
    if (!token) return Promise.resolve();
    return createApiClient(token)
      .get("/api/v1/benefactor/assigned-schools")
      .then((res) => {
        const s = res.data.schools || [];
        setSchools(s);
        setNoSchool(s.length === 0);
        // Default tab: show "today" for multi-school, "children" for single
        if (s.length <= 1) setTab("children");
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => { loadSchools(); }, [loadSchools]);

  const handleCheckAgain = useCallback(async () => {
    setCheckingAgain(true);
    try { await loadSchools(); } finally { setCheckingAgain(false); }
  }, [loadSchools]);

  // When school selection changes, stay on the current tab
  const handleSchoolSelect = useCallback((schoolId) => {
    setSelectedSchool(schoolId);
  }, []);

  const tabs = useMemo(() => {
    const base = [
      { key: "children",  label: "My Children",        icon: <IconChildren /> },
      { key: "vehicles",  label: "My Vehicles",        icon: <IconCar /> },
      { key: "pickups",   label: "Authorized Pickups", icon: <IconShield /> },
      { key: "activity",  label: "Activity",           icon: <IconClock /> },
      { key: "profile",   label: "Profile",            icon: <IconUser /> },
    ];
    // Prepend "Today" tab when guardian has multiple schools
    if (hasMultipleSchools) {
      base.unshift({ key: "today", label: "Today", icon: <IconToday /> });
    }
    return base;
  }, [hasMultipleSchools]);

  return (
    <div className="bp-shell">
      {/* ── Top bar ── */}
      <header className="bp-topbar">
        <div className="bp-topbar-left">
          <div className="bp-brand">Dismissal <span className="bp-brand-sub">Guardian Portal</span></div>
          <SchoolSwitcher
            schools={schools}
            selectedSchool={selectedSchool}
            onSelect={handleSchoolSelect}
          />
        </div>
        <div className="bp-user">
          <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={32} />
          <span className="bp-user-name">{currentUser?.display_name || currentUser?.email}</span>
          <button className="bp-sign-out" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {/* ── Pending-approval splash ─────────────────────────────────
          When a guardian has no schools assigned, their account is in
          the "waiting for campus approval" state described in
          issue #88 — they can sign in but can't do anything until a
          school admin grants them access.  The splash is non-dismissible:
          guardians cannot manage children/vehicles/pickups until a campus
          patron has linked them. */}
      {noSchool ? (
        <div className="bp-pending-wrap">
          <div className="bp-pending-card">
            <div className="bp-pending-icon" aria-hidden="true">
              <IconShield />
            </div>
            <h2 className="bp-pending-title">Waiting for campus approval</h2>
            <p className="bp-pending-sub">
              Your Dismissal account was created successfully
              {currentUser?.email ? <> for <strong>{currentUser.email}</strong></> : null}.
              Before you can add children, vehicles, or see pickup activity,
              a school administrator needs to grant you access to your
              child's campus.
            </p>
            <ol className="bp-pending-steps">
              <li>Contact your school's front office and ask them to add you as a guardian in Dismissal.</li>
              <li>They'll link your email address to the school in their Guardians page.</li>
              <li>Come back here and click <em>Check again</em>, or sign out and back in.</li>
            </ol>
            <div className="bp-pending-actions">
              <button
                className="bp-btn bp-btn-primary"
                onClick={handleCheckAgain}
                disabled={checkingAgain}
              >
                {checkingAgain ? "Checking…" : "Check again"}
              </button>
              <button
                className="bp-btn bp-btn-ghost"
                onClick={handleLogout}
              >
                Sign out
              </button>
            </div>
            <p className="bp-pending-footnote">
              Signed in as {currentUser?.display_name || currentUser?.email}.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ── Welcome ── */}
          <div className="bp-welcome">
            <h1 className="bp-welcome-title">Welcome, {firstName}</h1>
            <p className="bp-welcome-sub">
              {hasMultipleSchools
                ? `Managing pickup across ${schools.length} schools.`
                : "Manage your children and vehicles for quick school pickup."
              }
            </p>
          </div>

          {/* ── Tab bar ── */}
          <nav className="bp-tabs">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`bp-tab${tab === t.key ? " active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.icon}
                <span className="bp-tab-label">{t.label}</span>
              </button>
            ))}
          </nav>

          {/* ── Tab content ── */}
          <div className="bp-content">
            {tab === "today"     && <TodayTab api={plainApi} schools={schools} />}
            {tab === "children"  && <ChildrenTab api={api} token={token} schools={schools} selectedSchool={selectedSchool} />}
            {tab === "vehicles"  && <VehiclesTab api={api} token={token} />}
            {tab === "pickups"   && <AuthorizedPickupsTab api={plainApi} />}
            {tab === "activity"  && <ActivityTab api={api} />}
            {tab === "profile"   && <ProfileTab api={plainApi} currentUser={currentUser} />}
          </div>
        </>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// CHILDREN TAB
// ═══════════════════════════════════════════════════════════════════════════
function ChildrenTab({ api, token, schools, selectedSchool }) {
  const [children, setChildren] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ first_name: "", last_name: "", school_id: "", grade: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [uploading, setUploading] = useState(null);

  // Use schools from parent (already loaded); filter for add form based on selection
  const assignedSchools = selectedSchool
    ? schools.filter((s) => s.id === selectedSchool)
    : schools;

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/children")
      .then((res) => {
        setChildren(res.data.children || []);
      })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/children", form);
      setChildren((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ first_name: "", last_name: "", school_id: "", grade: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add child");
    } finally {
      setSaving(false);
    }
  };

  const handlePhoto = async (childId, file) => {
    setUploading(childId);
    try {
      const path = `benefactor/${token ? "user" : "anon"}/${childId}/photo`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/children/${childId}`, { photo_url: url });
      setChildren((p) => p.map((c) => c.id === childId ? { ...c, photo_url: url } : c));
    } catch (err) {
      setError("Photo upload failed");
    } finally {
      setUploading(null);
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {children.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon" aria-hidden="true"><IconChildren /></div>
          <h3>No children added yet</h3>
          <p>Add your children to get started with pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Add Your First Child
          </button>
        </div>
      )}

      {children.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{children.length} {children.length === 1 ? "child" : "children"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Child
            </button>
          </div>

          <div className="bp-cards">
            {children.map((c) => (
              <div key={c.id} className="bp-card">
                <div className="bp-card-top">
                  <label className="bp-card-avatar-wrap">
                    <PersonAvatar name={`${c.first_name} ${c.last_name}`} photoUrl={c.photo_url} size={56} />
                    <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && handlePhoto(c.id, e.target.files[0])} />
                    {uploading === c.id && <div className="bp-avatar-loading">...</div>}
                  </label>
                  <div className="bp-card-info">
                    <h4 className="bp-card-name">{c.first_name} {c.last_name}</h4>
                    {c.school_name && <span className="bp-card-detail">{c.school_name}</span>}
                    {c.grade && <span className="bp-card-detail">Grade {c.grade}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="bp-admin-note">
            To update student names or remove a student from your account, please contact your school administrator.
          </p>
        </>
      )}

      {/* Add Child Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Add Child</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>First Name</label>
                  <input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} required placeholder="Alex" />
                </div>
                <div className="bp-field">
                  <label>Last Name</label>
                  <input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} required placeholder="Smith" />
                </div>
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>School</label>
                  {assignedSchools.length === 0 ? (
                    <div className="bp-no-schools-msg">
                      No schools have been assigned to your account yet. Please contact your school administrator to get access.
                    </div>
                  ) : (
                    <select
                      className="bp-select"
                      value={form.school_id}
                      onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))}
                      required
                    >
                      <option value="">Select a school...</option>
                      {assignedSchools.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="bp-field">
                  <label>Grade <span className="bp-optional">(optional)</span></label>
                  <input value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} placeholder="3rd" />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving || assignedSchools.length === 0}>{saving ? "Adding..." : "Add Child"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// VEHICLES TAB  (Guardian Vehicle Registry)
// ═══════════════════════════════════════════════════════════════════════════
const IconEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const IconCamera = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" />
  </svg>
);
const IconCheck = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function VehiclesTab({ api, token }) {
  const [vehicles, setVehicles] = useState([]);
  const [children, setChildren] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [editing, setEditing]   = useState(null);   // vehicle object being edited
  const [form, setForm]         = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [editForm, setEditForm] = useState({ plate_number: "", make: "", model: "", color: "", year: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [uploading, setUploading] = useState(null);  // vehicle id currently uploading photo

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api().get("/api/v1/benefactor/vehicles"),
      api().get("/api/v1/benefactor/children"),
    ])
      .then(([vRes, cRes]) => {
        setVehicles(vRes.data.vehicles || []);
        setChildren(cRes.data.children || []);
      })
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // ── Add vehicle ──
  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/vehicles", form);
      setVehicles((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ plate_number: "", make: "", model: "", color: "", year: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add vehicle");
    } finally {
      setSaving(false);
    }
  };

  // ── Edit vehicle ──
  const openEdit = (v) => {
    setEditing(v);
    setEditForm({
      plate_number: v.plate_number || "",
      make: v.make || "",
      model: v.model || "",
      color: v.color || "",
      year: v.year || "",
    });
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api().patch(`/api/v1/benefactor/vehicles/${editing.id}`, editForm);
      setVehicles((p) => p.map((v) => v.id === editing.id ? { ...v, ...editForm } : v));
      setEditing(null);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update vehicle");
    } finally {
      setSaving(false);
    }
  };

  // ── Delete vehicle ──
  // Two-step: row "X" stages the target via openDelete; ConfirmDialog
  // onConfirm runs the API call.  Replaces the previous window.confirm
  // prompt with the shared modal.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const openDelete = (vehicle) => {
    setDeleteTarget(vehicle);
    setDeleteError("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api().delete(`/api/v1/benefactor/vehicles/${id}`);
      setVehicles((p) => p.filter((v) => v.id !== id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err.response?.data?.detail || "Failed to remove");
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Photo upload ──
  const handlePhoto = async (vehicleId, file) => {
    setUploading(vehicleId);
    try {
      const path = `vehicles/${vehicleId}/photo_${Date.now()}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { photo_url: url });
      setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, photo_url: url } : v));
    } catch (err) {
      setError("Photo upload failed");
    } finally {
      setUploading(null);
    }
  };

  // ── Child linking ──
  const toggleChild = async (vehicleId, childId, currentIds) => {
    const newIds = currentIds.includes(childId)
      ? currentIds.filter((id) => id !== childId)
      : [...currentIds, childId];
    try {
      await api().patch(`/api/v1/benefactor/vehicles/${vehicleId}`, { student_ids: newIds });
      setVehicles((p) => p.map((v) => v.id === vehicleId ? { ...v, student_ids: newIds } : v));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  // ── Helpers ──
  const schoolMap = {};
  children.forEach((c) => {
    if (c.school_id && c.school_name) schoolMap[c.school_id] = c.school_name;
  });

  const formatDate = (ts) => {
    if (!ts) return null;
    try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); } catch { return null; }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {vehicles.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon" aria-hidden="true"><IconCar /></div>
          <h3>No vehicles registered yet</h3>
          <p>Register your vehicles so the school can identify you at pickup.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Register Your First Vehicle
          </button>
        </div>
      )}

      {vehicles.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{vehicles.length} registered {vehicles.length === 1 ? "vehicle" : "vehicles"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Vehicle
            </button>
          </div>

          <div className="bp-cards">
            {vehicles.map((v) => {
              const desc = [v.color, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
              const linkedIds = v.student_ids || [];
              const linkedSchools = (v.school_ids || []).map((sid) => schoolMap[sid]).filter(Boolean);
              const regDate = formatDate(v.created_at);
              return (
                <div key={v.id} className="bp-card">
                  <div className="bp-card-top">
                    {/* Vehicle photo or icon */}
                    <label className="bp-vehicle-photo-wrap">
                      {v.photo_url ? (
                        <img src={v.photo_url} alt={desc} className="bp-vehicle-photo" />
                      ) : (
                        <div className="bp-vehicle-icon-wrap">
                          <IconCar />
                        </div>
                      )}
                      <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && handlePhoto(v.id, e.target.files[0])} />
                      <div className="bp-vehicle-photo-overlay">
                        {uploading === v.id ? "..." : <IconCamera />}
                      </div>
                    </label>

                    <div className="bp-card-info">
                      <h4 className="bp-card-name">{desc}</h4>
                      <div className="bp-vehicle-meta">
                        {v.plate_number && <span className="bp-plate-badge">{v.plate_number}</span>}
                        {v.year && <span className="bp-card-detail">{v.year}</span>}
                      </div>
                      {linkedSchools.length > 0 && (
                        <div className="bp-vehicle-schools">
                          <IconCheck />
                          <span>{linkedSchools.join(", ")}</span>
                        </div>
                      )}
                      {regDate && <span className="bp-card-detail">Registered {regDate}</span>}
                    </div>

                    <div className="bp-card-actions">
                      <button className="bp-card-action-btn" onClick={() => openEdit(v)} title="Edit vehicle">
                        <IconEdit />
                      </button>
                      <button className="bp-card-delete" onClick={() => openDelete(v)} title="Remove vehicle">&times;</button>
                    </div>
                  </div>

                  {/* Child linking */}
                  {children.length > 0 && (
                    <div className="bp-vehicle-children">
                      <span className="bp-vehicle-children-label">Linked for pickup:</span>
                      <div className="bp-child-chips">
                        {children.map((c) => {
                          const linked = linkedIds.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              className={`bp-child-chip${linked ? " active" : ""}`}
                              onClick={() => toggleChild(v.id, c.id, linkedIds)}
                              title={linked ? `Remove ${c.first_name}` : `Add ${c.first_name}`}
                              aria-pressed={linked}
                            >
                              {c.first_name}
                              {linked
                                ? <IconCheck />
                                : <IconPlus />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add Vehicle Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Register Vehicle</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-field">
                <label>License Plate</label>
                <input
                  value={form.plate_number}
                  onChange={(e) => setForm((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))}
                  required
                  placeholder="ABC 1234"
                  className="bp-plate-input"
                />
              </div>
              <div className="bp-form-row bp-form-row-3">
                <div className="bp-field">
                  <label>Make</label>
                  <input value={form.make} onChange={(e) => setForm((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
                </div>
                <div className="bp-field">
                  <label>Model</label>
                  <input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="Highlander" />
                </div>
                <div className="bp-field">
                  <label>Color</label>
                  <input value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} placeholder="Gray" />
                </div>
              </div>
              <div className="bp-field">
                <label>Year <span className="bp-optional">(optional)</span></label>
                <input value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))} placeholder="2024" maxLength={4} style={{ maxWidth: 120 }} />
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Registering..." : "Register Vehicle"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Vehicle Modal */}
      {editing && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Edit Vehicle</h2>
              <button className="bp-modal-close" onClick={() => setEditing(null)}>&times;</button>
            </div>
            <form onSubmit={handleEdit} className="bp-form">
              <div className="bp-field">
                <label>License Plate</label>
                <input
                  value={editForm.plate_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, plate_number: e.target.value.toUpperCase() }))}
                  required
                  placeholder="ABC 1234"
                  className="bp-plate-input"
                />
              </div>
              <div className="bp-form-row bp-form-row-3">
                <div className="bp-field">
                  <label>Make</label>
                  <input value={editForm.make} onChange={(e) => setEditForm((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
                </div>
                <div className="bp-field">
                  <label>Model</label>
                  <input value={editForm.model} onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))} placeholder="Highlander" />
                </div>
                <div className="bp-field">
                  <label>Color</label>
                  <input value={editForm.color} onChange={(e) => setEditForm((f) => ({ ...f, color: e.target.value }))} placeholder="Gray" />
                </div>
              </div>
              <div className="bp-field">
                <label>Year <span className="bp-optional">(optional)</span></label>
                <input value={editForm.year} onChange={(e) => setEditForm((f) => ({ ...f, year: e.target.value }))} placeholder="2024" maxLength={4} style={{ maxWidth: 120 }} />
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove vehicle"
        prompt={deleteTarget && (
          <>
            Remove the vehicle{" "}
            <strong>
              {[deleteTarget.make, deleteTarget.model, deleteTarget.color]
                .filter(Boolean).join(" ") || deleteTarget.plate_number || "from your account"}
            </strong>?
          </>
        )}
        warning="It will no longer be recognised at pickup, and any links to your children for this vehicle are removed."
        destructive
        confirmLabel="Remove vehicle"
        busyLabel="Removing…"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZED PICKUPS TAB
// ═══════════════════════════════════════════════════════════════════════════
function AuthorizedPickupsTab({ api }) {
  const [pickups, setPickups]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ name: "", phone: "", relationship: "" });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  // Edit state mirrors VehiclesTab: `editing` is the pickup being
  // edited (null = not editing) and `editForm` holds the in-flight
  // values so the user can cancel without losing the original row.
  const [editing, setEditing]   = useState(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", relationship: "" });

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/authorized-pickups")
      .then((r) => setPickups(r.data.pickups || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().post("/api/v1/benefactor/authorized-pickups", form);
      setPickups((p) => [...p, res.data]);
      setShowAdd(false);
      setForm({ name: "", phone: "", relationship: "" });
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (pk) => {
    setEditing(pk);
    setEditForm({
      name: pk.name || "",
      phone: pk.phone || "",
      relationship: pk.relationship || "",
    });
    setError("");
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api().patch(
        `/api/v1/benefactor/authorized-pickups/${editing.id}`,
        editForm,
      );
      // Backend returns the canonical updated entry — including the
      // normalized phone / relationship values and the updated_at
      // timestamp — so prefer it over the optimistic local merge.
      setPickups((p) => p.map((pk) => (pk.id === editing.id ? res.data : pk)));
      setEditing(null);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  // Two-step delete via the shared <ConfirmDialog> instead of
  // window.confirm — matches every other admin destructive flow.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const openDelete = (pk) => {
    setDeleteTarget(pk);
    setDeleteError("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api().delete(`/api/v1/benefactor/authorized-pickups/${id}`);
      setPickups((p) => p.filter((pk) => pk.id !== id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err.response?.data?.detail || "Failed to remove");
    } finally {
      setDeleteBusy(false);
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {pickups.length === 0 && !showAdd && (
        <div className="bp-empty">
          <div className="bp-empty-icon" aria-hidden="true"><IconShield /></div>
          <h3>No authorized pickups yet</h3>
          <p>Add other adults (grandparents, family friends, etc.) who are authorized to pick up your children.</p>
          <button className="bp-btn bp-btn-primary" onClick={() => setShowAdd(true)}>
            <IconPlus /> Add Authorized Person
          </button>
        </div>
      )}

      {pickups.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>{pickups.length} authorized {pickups.length === 1 ? "person" : "people"}</span>
            <button className="bp-btn bp-btn-primary bp-btn-sm" onClick={() => setShowAdd(true)}>
              <IconPlus /> Add Person
            </button>
          </div>

          <div className="bp-cards">
            {pickups.map((pk) => (
              <div key={pk.id} className="bp-card">
                <div className="bp-card-top">
                  <div className="bp-pickup-icon-wrap">
                    <IconShield />
                  </div>
                  <div className="bp-card-info">
                    <h4 className="bp-card-name">{pk.name}</h4>
                    {pk.relationship && <span className="bp-card-detail">{pk.relationship}</span>}
                    {pk.phone && <span className="bp-card-detail">{pk.phone}</span>}
                  </div>
                  <div className="bp-card-actions">
                    <button
                      className="bp-card-action-btn"
                      onClick={() => openEdit(pk)}
                      title={`Edit ${pk.name}`}
                      aria-label={`Edit ${pk.name}`}
                    >
                      <IconEdit />
                    </button>
                    <button
                      className="bp-card-delete"
                      onClick={() => openDelete(pk)}
                      title={`Remove ${pk.name}`}
                      aria-label={`Remove ${pk.name}`}
                    >
                      &times;
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Add Authorized Pickup Modal */}
      {showAdd && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Add Authorized Pickup</h2>
              <button className="bp-modal-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form onSubmit={handleAdd} className="bp-form">
              <div className="bp-field">
                <label>Full Name</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="e.g. Grandma Smith" />
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>Phone <span className="bp-optional">(optional)</span></label>
                  <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" />
                </div>
                <div className="bp-field">
                  <label>Relationship <span className="bp-optional">(optional)</span></label>
                  <input value={form.relationship} onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))} placeholder="e.g. Grandmother" />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Adding..." : "Add Person"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Authorized Pickup Modal — clone of Add with prefilled
          values + handleEdit submit + "Save changes" CTA copy. */}
      {editing && (
        <div className="bp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="bp-modal">
            <div className="bp-modal-header">
              <h2>Edit {editing.name}</h2>
              <button className="bp-modal-close" onClick={() => setEditing(null)} aria-label="Close dialog">&times;</button>
            </div>
            <form onSubmit={handleEdit} className="bp-form">
              <div className="bp-field">
                <label>Full Name</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  placeholder="e.g. Grandma Smith"
                  autoFocus
                />
              </div>
              <div className="bp-form-row">
                <div className="bp-field">
                  <label>Phone <span className="bp-optional">(optional)</span></label>
                  <input
                    value={editForm.phone}
                    onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="(555) 123-4567"
                    type="tel"
                  />
                </div>
                <div className="bp-field">
                  <label>Relationship <span className="bp-optional">(optional)</span></label>
                  <input
                    value={editForm.relationship}
                    onChange={(e) => setEditForm((f) => ({ ...f, relationship: e.target.value }))}
                    placeholder="e.g. Grandmother"
                  />
                </div>
              </div>
              {error && <p className="bp-form-error">{error}</p>}
              <div className="bp-form-actions">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="bp-btn bp-btn-primary" disabled={saving}>{saving ? "Saving..." : "Save changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove authorized pickup"
        prompt={deleteTarget && (
          <>
            Remove <strong>{deleteTarget.name}</strong> from your authorized
            pickup list?
          </>
        )}
        warning="They will no longer be allowed to pick up your children. You can re-add them at any time."
        destructive
        confirmLabel="Remove"
        busyLabel="Removing…"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ═══════════════════════════════════════════════════════════════════════════
function ActivityTab({ api }) {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/activity?limit=50")
      .then((r) => setEvents(r.data.events || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load activity"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const formatTime = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
      const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `${date} at ${time}`;
    } catch {
      return ts;
    }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}

      {events.length === 0 && (
        <div className="bp-empty">
          <div className="bp-empty-icon" aria-hidden="true"><IconClipboard /></div>
          <h3>No pickup activity yet</h3>
          <p>Once your vehicles are scanned at school, pickup events will appear here.</p>
        </div>
      )}

      {events.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>Recent pickup activity</span>
            <button className="bp-btn bp-btn-ghost bp-btn-sm" onClick={load}>Refresh</button>
          </div>

          <div className="bp-activity-list">
            {events.map((ev) => (
              <div key={ev.id} className="bp-activity-row">
                <div className="bp-activity-icon">
                  <IconCar />
                </div>
                <div className="bp-activity-info">
                  <div className="bp-activity-main">
                    <span className="bp-activity-vehicle">{ev.vehicle_desc}</span>
                    {ev.plate_number && <span className="bp-plate-badge">{ev.plate_number}</span>}
                  </div>
                  {ev.students.length > 0 && (
                    <span className="bp-activity-students">{ev.students.join(", ")}</span>
                  )}
                  <span className="bp-activity-meta">
                    {formatTime(ev.timestamp)}
                    {ev.location && <> &middot; {ev.location}</>}
                    {ev.picked_up_at && <> &middot; Picked up</>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════════════════════════════════════════
function ProfileTab({ api, currentUser }) {
  const [form, setForm]     = useState({ display_name: currentUser?.display_name || "", phone: currentUser?.phone || "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState("");

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      await api().patch("/api/v1/benefactor/profile", form);
      setMsg("Profile updated!");
    } catch (err) {
      setMsg(err.response?.data?.detail || "Update failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bp-profile">
      <div className="bp-profile-header">
        <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={72} />
        <div>
          <h3>{currentUser?.display_name || "Your Profile"}</h3>
          <span className="bp-card-detail">{currentUser?.email}</span>
        </div>
      </div>

      <form onSubmit={handleSave} className="bp-form bp-profile-form">
        <div className="bp-field">
          <label>Display Name</label>
          <input value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} placeholder="Your name" />
        </div>
        <div className="bp-field">
          <label>Phone <span className="bp-optional">(optional)</span></label>
          <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" type="tel" />
        </div>
        {msg && <p className={`bp-form-msg${msg.includes("fail") ? " error" : ""}`}>{msg}</p>}
        <button type="submit" className="bp-btn bp-btn-primary" disabled={saving} style={{ alignSelf: "flex-start" }}>
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </form>
    </div>
  );
}
