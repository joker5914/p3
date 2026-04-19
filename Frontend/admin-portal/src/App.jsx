import { useEffect, useState, useRef, useCallback } from "react";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { auth } from "./firebase-config";
import { createApiClient } from "./api";
import Login from "./Login";
import Dashboard from "./Dashboard";
import DataImporter from "./DataImporter";
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
import DevicesList from "./DevicesList";
import SiteSettings from "./SiteSettings";
import Layout from "./Layout";
import BenefactorPortal from "./BenefactorPortal";
import ArrivalToasts, { useArrivalAlerts } from "./ArrivalToast";
import "./App.css";

function buildWsUrl(token) {
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
  return `${origin}/ws/dashboard?token=${encodeURIComponent(token)}`;
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

function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [token, setToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState("dashboard");
  const [wsStatus, setWsStatus] = useState(null);
  const [activeSchool, setActiveSchool] = useState(null);
  const [activeDistrict, setActiveDistrict] = useState(null);
  const [scanVersion, setScanVersion] = useState(0);

  const { dark, toggle: toggleTheme } = useTheme();

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);

  const arrivalAlerts = useArrivalAlerts();
  const arrivalNotifyRef = useRef(arrivalAlerts.notify);
  arrivalNotifyRef.current = arrivalAlerts.notify;

  const seenHashesRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);

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
          if (res.data.is_guardian) setView("benefactor");
          else if (res.data.is_super_admin) setView("districts");
          else if (res.data.role === "district_admin") setView("platformAdmin");
        } catch (err) {
          if (err.response?.status === 401) {
            await signOut(auth);
          } else {
            console.error("Failed to load user profile:", err);
          }
        }
      } else {
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
    createApiClient(token)
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
  }, [token, view, handleLogout]);

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

      ws = new WebSocket(buildWsUrl(freshToken));
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
        createApiClient(freshToken)
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

    const poll = () => {
      createApiClient(token)
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
  }, [token, view, wsStatus, handleLogout]);

  if (authLoading) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#f5f5f7",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
        color: "#6e6e73",
        fontSize: "14px",
      }}>
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
  const platformRole = currentUser?.role === "super_admin" || currentUser?.role === "district_admin";
  const isAdminNoSchool = platformRole && !activeSchool;

  const schoolSelectionPrompt = (
    <div className="school-selection-required">
      <div className="school-selection-required-card">
        <h3 className="school-selection-required-title">School Selection Required</h3>
        <p className="school-selection-required-desc">
          Select a school from the Locations page to access this section.
        </p>
        <button
          className="school-selection-required-btn"
          onClick={() => setView("platformAdmin")}
        >
          Go to Locations
        </button>
      </div>
    </div>
  );

  const SCHOOL_SCOPED_VIEWS = new Set([
    "dashboard", "students", "guardians", "users", "permissions",
    "registry", "integrations", "reports", "history", "siteSettings",
  ]);

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
    integrations: <DataImporter token={token} schoolId={schoolId} />,
    reports: <Insights token={token} schoolId={schoolId} scanVersion={scanVersion} />,
    history: <History token={token} schoolId={schoolId} />,
    registry: <VehicleRegistry token={token} currentUser={currentUser} schoolId={schoolId} />,
    students: <StudentManagement token={token} schoolId={schoolId} />,
    guardians: <GuardianManagement token={token} schoolId={schoolId} currentUser={currentUser} />,
    users: <UserManagement token={token} currentUser={currentUser} schoolId={schoolId} />,
    profile: (
      <AccountProfile
        token={token}
        currentUser={currentUser}
        onProfileUpdate={handleProfileUpdate}
        schoolId={schoolId}
        dark={dark}
        onToggleTheme={toggleTheme}
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
    devices: <DevicesList token={token} />,
    siteSettings: <SiteSettings token={token} schoolId={schoolId} currentUser={currentUser} />,
  };

  const resolvedView = isAdminNoSchool && SCHOOL_SCOPED_VIEWS.has(view)
    ? schoolSelectionPrompt
    : content[view] ?? <h2 style={{ padding: "2rem" }}>Select an option from the navigation.</h2>;

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
