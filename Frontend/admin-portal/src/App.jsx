import { useEffect, useState, useRef, useCallback } from "react";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { auth } from "./firebase-config";
import { createApiClient } from "./api";
import Login from "./Login";
import Dashboard from "./Dashboard";
import DataImporter from "./DataImporter";
import Integrations from "./Integrations";
import Insights from "./Insights";
import History from "./History";
import VehicleRegistry from "./VehicleRegistry";
import UserManagement from "./UserManagement";
import StudentManagement from "./StudentManagement";
import GuardianManagement from "./GuardianManagement";
import AccountProfile from "./AccountProfile";
import PermissionSettings from "./PermissionSettings";
import PlatformAdmin from "./PlatformAdmin";
import PlatformDistricts from "./PlatformDistricts";
import PlatformUsers from "./PlatformUsers";
import DevicesList from "./DevicesList";
import SiteSettings from "./SiteSettings";
import SsoSettings from "./SsoSettings";
import AuditLog from "./AuditLog";
import Layout from "./Layout";
import BenefactorPortal from "./BenefactorPortal";
import ArrivalToasts, { useArrivalAlerts } from "./ArrivalToast";
import "./App.css";

function buildWsUrl(token, schoolId) {
  const apiBase = import.meta.env.VITE_API_BASE_URL;
  let origin;
  if (apiBase) {
    origin = apiBase
      .replace(/^https/, "wss")
      .replace(/^http/, "ws")
      .replace(/\/+$/, "");
  } else {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    origin = `${proto}://${window.location.host}`;
  }
  const qs = new URLSearchParams({ token });
  if (schoolId) qs.set("school_id", schoolId);
  return `${origin}/ws/dashboard?${qs.toString()}`;
}

/* ── Theme hook (global) ───────────────────────────────── */
function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("dismissal-theme");
    if (stored) return stored === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  useEffect(() => {
    document.body.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("dismissal-theme", dark ? "dark" : "light");
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  return { dark, toggle };
}

/* ── Colorblind-safe palette hook (global) ────────────────
   Toggles body[data-palette="colorblind"], which index.css uses to
   override hue vars with the Okabe-Ito palette over either light or
   dark theme.  Persisted in localStorage so the choice survives
   reloads and applies before React paints. */
function usePalette() {
  const [colorblind, setColorblind] = useState(
    () => localStorage.getItem("dismissal-palette") === "colorblind",
  );

  useEffect(() => {
    if (colorblind) document.body.setAttribute("data-palette", "colorblind");
    else document.body.removeAttribute("data-palette");
    localStorage.setItem("dismissal-palette", colorblind ? "colorblind" : "default");
  }, [colorblind]);

  const toggle = useCallback(() => setColorblind((c) => !c), []);
  return { colorblind, toggle };
}

// Persist the current view + school/district context in sessionStorage so a
// browser refresh lands the user back where they were instead of the default
// role landing page.  sessionStorage (not localStorage) scopes this to the
// tab — opening a fresh tab still shows the role-default landing view.
const VIEW_STORAGE_KEY     = "dismissal-view";
const SCHOOL_STORAGE_KEY   = "dismissal-active-school";
const DISTRICT_STORAGE_KEY = "dismissal-active-district";

function _readStoredJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _clearViewStorage() {
  sessionStorage.removeItem(VIEW_STORAGE_KEY);
  sessionStorage.removeItem(SCHOOL_STORAGE_KEY);
  sessionStorage.removeItem(DISTRICT_STORAGE_KEY);
}

function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [token, setToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState(
    () => sessionStorage.getItem(VIEW_STORAGE_KEY) || "dashboard",
  );
  const [wsStatus, setWsStatus] = useState(null);
  const [activeSchool, setActiveSchool] = useState(
    () => _readStoredJson(SCHOOL_STORAGE_KEY),
  );
  const [activeDistrict, setActiveDistrict] = useState(
    () => _readStoredJson(DISTRICT_STORAGE_KEY),
  );
  const [scanVersion, setScanVersion] = useState(0);
  // Audit log actor filter: when set by "View activity" on a user card, the
  // nav click that follows loads AuditLog prefiltered by this uid/label.
  // Cleared once the user navigates away from the audit view.
  const [auditFilter, setAuditFilter] = useState(null); // { uid, label } | null

  useEffect(() => {
    if (view) sessionStorage.setItem(VIEW_STORAGE_KEY, view);
    // Clear audit actor-filter state when the user navigates away from the
    // audit view — otherwise coming back via the nav would re-apply the
    // per-user filter that was set by "View activity".
    if (view !== "audit") setAuditFilter(null);
  }, [view]);

  useEffect(() => {
    if (activeSchool) sessionStorage.setItem(SCHOOL_STORAGE_KEY, JSON.stringify(activeSchool));
    else sessionStorage.removeItem(SCHOOL_STORAGE_KEY);
  }, [activeSchool]);

  useEffect(() => {
    if (activeDistrict) sessionStorage.setItem(DISTRICT_STORAGE_KEY, JSON.stringify(activeDistrict));
    else sessionStorage.removeItem(DISTRICT_STORAGE_KEY);
  }, [activeDistrict]);

  const { dark, toggle: toggleTheme } = useTheme();
  const { colorblind, toggle: togglePalette } = usePalette();

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);

  const arrivalAlerts = useArrivalAlerts();
  const arrivalNotifyRef = useRef(arrivalAlerts.notify);
  arrivalNotifyRef.current = arrivalAlerts.notify;

  const seenHashesRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);
  // Track the UID we've already recorded an auth.signin.success audit
  // event for.  Firebase's onIdTokenChanged fires on every token refresh,
  // not just sign-in — we only want one sign-in event per actual session.
  const sessionRecordedForUidRef = useRef(null);

  const handleDismiss = useCallback((plateToken) => {
    setQueue((prev) => {
      for (const e of prev) {
        if (e.plate_token === plateToken && e.hash) {
          seenHashesRef.current.delete(e.hash);
        }
      }
      return prev.filter((e) => e.plate_token !== plateToken);
    });
  }, []);

  const handleLogout = useCallback(async () => {
    await signOut(auth);
  }, []);

  const handleProfileUpdate = useCallback((updatedUser) => {
    setCurrentUser(updatedUser);
  }, []);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const idToken = await fbUser.getIdToken();
          setToken(idToken);
          const res = await createApiClient(idToken).get("/api/v1/me");
          setCurrentUser(res.data);
          // Audit: record the sign-in event exactly once per session.  We
          // know this is a new session rather than a silent token refresh
          // because the uid differs from the one we last recorded.  The
          // provider comes off the Firebase user metadata so the audit
          // log captures "signed in with Google" vs. "with password".
          if (sessionRecordedForUidRef.current !== fbUser.uid) {
            sessionRecordedForUidRef.current = fbUser.uid;
            const providerData = fbUser.providerData || [];
            const provider = providerData[0]?.providerId || "password";
            createApiClient(idToken)
              .post("/api/v1/auth/session-start", { provider })
              .catch((err) => {
                // Non-fatal — auth audit is telemetry, not a gate.
                console.debug("session-start audit failed:", err?.message || err);
              });
          }
          // Only apply the role-default landing view on a fresh login — if
          // the user refreshed the tab, sessionStorage already has their
          // last view and we shouldn't yank them back to the role landing.
          if (!sessionStorage.getItem(VIEW_STORAGE_KEY)) {
            if (res.data.is_guardian) setView("benefactor");
            else if (res.data.is_super_admin) setView("districts");
            else if (res.data.role === "district_admin") setView("platformAdmin");
          }
        } catch (err) {
          if (err.response?.status === 401) {
            await signOut(auth);
          } else {
            console.error("Failed to load user profile:", err);
          }
        }
      } else {
        // Clear persisted view before resetting state so the next login
        // lands on its role-default view instead of the last user's page.
        _clearViewStorage();
        sessionRecordedForUidRef.current = null;
        setToken(null);
        setCurrentUser(null);
        setQueue([]);
        setView("dashboard");
        setWsStatus("disconnected");
        setActiveSchool(null);
        setActiveDistrict(null);
        initialLoadDoneRef.current = false;
        seenHashesRef.current = new Set();
      }
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!token || (view !== "dashboard" && view !== "reports")) return;
    // Pickup Queue is per-school: skip the fetch until an elevated admin
    // has actually chosen a campus, otherwise we'd either query the wrong
    // bucket (old UID fallback) or spam 400s.
    if (
      (currentUser?.role === "super_admin" || currentUser?.role === "district_admin")
      && !activeSchool
    ) {
      setQueue([]);
      initialLoadDoneRef.current = true;
      return;
    }
    createApiClient(token, activeSchool?.id ?? null)
      .get("/api/v1/dashboard")
      .then((res) => {
        if (!mountedRef.current) return;
        const items = res.data.queue || [];
        items.forEach((e) => { if (e.hash) seenHashesRef.current.add(e.hash); });
        setQueue(items);
        initialLoadDoneRef.current = true;
      })
      .catch((err) => {
        if (err.response?.status === 401) handleLogout();
        else console.error("Dashboard fetch error:", err);
        initialLoadDoneRef.current = true;
      });
  }, [token, view, activeSchool, currentUser, handleLogout]);

  useEffect(() => {
    mountedRef.current = true;
    const liveView = view === "dashboard" || view === "reports";
    if (!token || !liveView || currentUser === null) return;
    // The live dashboard (pickup queue) only makes sense when we're inside
    // a specific school.  Super admins at district-level or platform-level
    // don't need the WS.  Same for district admins who haven't drilled in.
    if ((currentUser.role === "super_admin" || currentUser.role === "district_admin") && !activeSchool) return;

    let ws;
    let intentionallyClosed = false;
    let backoff = 1000;
    let retryCount = 0;
    let heartbeatId;
    let staleTimerId;
    let connectTimeoutId;

    const clearTimers = () => {
      clearTimeout(connectTimeoutId);
      clearInterval(heartbeatId);
      clearTimeout(staleTimerId);
    };

    const resetStaleTimer = () => {
      clearTimeout(staleTimerId);
      staleTimerId = setTimeout(() => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close(4000, "Stale connection");
        }
      }, 65_000);
    };

    const connect = async () => {
      if (!mountedRef.current || intentionallyClosed) return;
      clearTimers();
      setWsStatus("connecting");
      let freshToken = token;
      try {
        freshToken = (await auth.currentUser?.getIdToken()) ?? token;
      } catch {
      }
      if (!mountedRef.current || intentionallyClosed) return;

      ws = new WebSocket(buildWsUrl(freshToken, activeSchool?.id ?? null));
      wsRef.current = ws;

      connectTimeoutId = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(connectTimeoutId);
        if (!mountedRef.current) return;
        setWsStatus("connected");
        backoff = 1000;
        retryCount = 0;
        createApiClient(freshToken, activeSchool?.id ?? null)
          .get("/api/v1/dashboard")
          .then((res) => {
            if (!mountedRef.current) return;
            const items = res.data.queue || [];
            items.forEach((e) => { if (e.hash) seenHashesRef.current.add(e.hash); });
            setQueue(items);
          })
          .catch(() => {});
        resetStaleTimer();
        heartbeatId = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* ignore */ }
          }
        }, 25_000);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        resetStaleTimer();
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ping") return;
          if (data.type === "clear") {
            setQueue([]);
            setScanVersion((v) => v + 1);
          } else if (data.type === "scan" && data.data) {
            const alreadySeen = seenHashesRef.current.has(data.data.hash);
            seenHashesRef.current.add(data.data.hash);
            setQueue((prev) => {
              if (prev.some((e) => e.hash === data.data.hash)) return prev;
              return [...prev, data.data];
            });
            if (!alreadySeen) arrivalNotifyRef.current(data.data);
            setScanVersion((v) => v + 1);
          } else if (data.type === "dismiss" && data.plate_token) {
            setQueue((prev) => {
              for (const e of prev) {
                if (e.plate_token === data.plate_token && e.hash) {
                  seenHashesRef.current.delete(e.hash);
                }
              }
              return prev.filter((e) => e.plate_token !== data.plate_token);
            });
            setScanVersion((v) => v + 1);
          } else if (data.type === "bulk_dismiss") {
            seenHashesRef.current.clear();
            setQueue([]);
            setScanVersion((v) => v + 1);
          }
        } catch (e) {
          console.error("WS message parse error:", e);
        }
      };

      ws.onerror = () => {};

      ws.onclose = (e) => {
        clearTimers();
        if (!mountedRef.current || intentionallyClosed) return;
        retryCount += 1;
        if (e.code === 4001) {
          setWsStatus(retryCount >= 3 ? "offline" : "disconnected");
          if (retryCount <= 5) reconnectRef.current = setTimeout(connect, 5_000);
          return;
        }
        setWsStatus(retryCount >= 3 ? "offline" : "disconnected");
        reconnectRef.current = setTimeout(() => {
          backoff = Math.min(backoff * 1.5, 30_000);
          connect();
        }, backoff);
      };
    };

    connect();

    return () => {
      mountedRef.current = false;
      intentionallyClosed = true;
      clearTimers();
      clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
      setWsStatus(null);
    };
  }, [token, view, currentUser, activeSchool]);

  useEffect(() => {
    if (!token || (view !== "dashboard" && view !== "reports")) return;
    if (wsStatus === "connected") return;
    // Same guard as the initial fetch — poll only when we have a concrete
    // campus to scope to.
    if (
      (currentUser?.role === "super_admin" || currentUser?.role === "district_admin")
      && !activeSchool
    ) return;

    const poll = () => {
      createApiClient(token, activeSchool?.id ?? null)
        .get("/api/v1/dashboard")
        .then((res) => {
          if (!mountedRef.current) return;
          const items = res.data.queue || [];
          let hasNew = false;
          items.forEach((e) => {
            if (!e.hash) return;
            if (!seenHashesRef.current.has(e.hash)) {
              seenHashesRef.current.add(e.hash);
              if (initialLoadDoneRef.current) arrivalNotifyRef.current(e);
              hasNew = true;
            }
          });
          setQueue(items);
          if (hasNew) setScanVersion((v) => v + 1);
        })
        .catch((err) => {
          if (err?.response?.status === 401) handleLogout();
        });
    };

    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [token, view, wsStatus, activeSchool, currentUser, handleLogout]);

  if (authLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          minHeight: "100vh",
          background: "#f5f5f7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          color: "#6e6e73",
          fontSize: "14px",
        }}
      >
        Loading…
      </div>
    );
  }

  if (!token) return <Login />;

  if (currentUser?.is_guardian) {
    return (
      <BenefactorPortal
        token={token}
        currentUser={currentUser}
        handleLogout={handleLogout}
      />
    );
  }

  const schoolId = activeSchool?.id ?? null;
  const isSuperAdmin = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const platformRole = isSuperAdmin || isDistrictAdmin;
  const isAdminNoSchool = platformRole && !activeSchool;
  // Super admins must pick a district before they can reach location-scoped
  // views; otherwise they'd bypass the district -> location drill-down that
  // keeps data scoped correctly.  District admins have an implicit district
  // (their assignment), so they skip this gate.
  const superAdminNeedsDistrict = isSuperAdmin && !activeDistrict;

  const districtSelectionPrompt = (
    <div className="school-selection-required">
      <div className="school-selection-required-card">
        <h3 className="school-selection-required-title">District Selection Required</h3>
        <p className="school-selection-required-desc">
          Pick a district first — locations, devices, and school-scoped
          views belong to a specific district.
        </p>
        <button
          className="school-selection-required-btn"
          onClick={() => setView("districts")}
        >
          Go to Districts
        </button>
      </div>
    </div>
  );

  const schoolSelectionPrompt = (
    <div className="school-selection-required">
      <div className="school-selection-required-card">
        <h3 className="school-selection-required-title">School Selection Required</h3>
        <p className="school-selection-required-desc">
          Select a school from the Locations page to access this section.
        </p>
        <button
          className="school-selection-required-btn"
          onClick={() => setView(superAdminNeedsDistrict ? "districts" : "platformAdmin")}
        >
          {superAdminNeedsDistrict ? "Go to Districts" : "Go to Locations"}
        </button>
      </div>
    </div>
  );

  const SCHOOL_SCOPED_VIEWS = new Set([
    "dashboard", "students", "guardians", "users", "permissions",
    "registry", "integrations", "reports", "history", "siteSettings",
  ]);
  // Platform-level views that require a district to be selected first.
  // Super admins hitting these without a district see the district-picker
  // prompt.  Devices stays accessible at the platform top so Dismissal
  // staff can manage unassigned hardware across all customers.
  const DISTRICT_SCOPED_VIEWS = new Set(["platformAdmin", "sso"]);

  const content = {
    dashboard: (
      <Dashboard
        queue={queue}
        wsStatus={wsStatus}
        onClearQueue={() => { seenHashesRef.current.clear(); setQueue([]); }}
        onDismiss={handleDismiss}
        token={token}
        schoolId={schoolId}
        arrivalAlerts={arrivalAlerts}
      />
    ),
    integrations: (
      <Integrations
        token={token}
        currentUser={currentUser}
        activeDistrict={activeDistrict}
        setView={setView}
      />
    ),
    dataImporter: <DataImporter token={token} schoolId={schoolId} />,
    reports: <Insights token={token} schoolId={schoolId} scanVersion={scanVersion} />,
    history: <History token={token} schoolId={schoolId} />,
    registry: <VehicleRegistry token={token} currentUser={currentUser} schoolId={schoolId} />,
    students: <StudentManagement token={token} schoolId={schoolId} />,
    guardians: <GuardianManagement token={token} schoolId={schoolId} currentUser={currentUser} />,
    users: (
      <UserManagement
        token={token}
        currentUser={currentUser}
        schoolId={schoolId}
        onViewActivity={(uid, label) => {
          setAuditFilter({ uid, label });
          setView("audit");
        }}
      />
    ),
    profile: (
      <AccountProfile
        token={token}
        currentUser={currentUser}
        onProfileUpdate={handleProfileUpdate}
        schoolId={schoolId}
        dark={dark}
        onToggleTheme={toggleTheme}
        colorblind={colorblind}
        onTogglePalette={togglePalette}
      />
    ),
    permissions: <PermissionSettings token={token} schoolId={schoolId} />,
    platformAdmin: (
      <PlatformAdmin
        token={token}
        setActiveSchool={setActiveSchool}
        setView={setView}
        activeDistrict={activeDistrict}
        setActiveDistrict={setActiveDistrict}
      />
    ),
    districts: (
      <PlatformDistricts
        token={token}
        setActiveDistrict={setActiveDistrict}
        setView={setView}
      />
    ),
    platformUsers: <PlatformUsers token={token} />,
    devices: <DevicesList token={token} currentUser={currentUser} />,
    siteSettings: <SiteSettings token={token} schoolId={schoolId} currentUser={currentUser} />,
    sso: (
      <SsoSettings
        token={token}
        currentUser={currentUser}
        activeDistrict={activeDistrict}
      />
    ),
    audit: (
      <AuditLog
        token={token}
        currentUser={currentUser}
        schoolId={schoolId}
        initialActorUid={auditFilter?.uid ?? null}
        initialActorLabel={auditFilter?.label ?? null}
      />
    ),
  };

  let resolvedView;
  if (superAdminNeedsDistrict && DISTRICT_SCOPED_VIEWS.has(view)) {
    resolvedView = districtSelectionPrompt;
  } else if (isAdminNoSchool && SCHOOL_SCOPED_VIEWS.has(view)) {
    resolvedView = schoolSelectionPrompt;
  } else {
    resolvedView = content[view] ?? <h2 style={{ padding: "2rem" }}>Select an option from the navigation.</h2>;
  }

  return (
    <Layout
      view={view}
      setView={setView}
      handleLogout={handleLogout}
      wsStatus={wsStatus}
      token={token}
      currentUser={currentUser}
      activeSchool={activeSchool}
      setActiveSchool={setActiveSchool}
      activeDistrict={activeDistrict}
      setActiveDistrict={setActiveDistrict}
    >
      {resolvedView}
      <ArrivalToasts toasts={arrivalAlerts.toasts} removeToast={arrivalAlerts.removeToast} />
    </Layout>
  );
}

export default App;
