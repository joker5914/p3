import { useEffect, useState, useRef, useCallback } from "react";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { auth } from "./firebase-config";
import { createApiClient } from "./api";
import Login from "./Login";
import Dashboard from "./Dashboard";
import DataImporter from "./DataImporter";
import Reports from "./Reports";
import History from "./History";
import VehicleRegistry from "./VehicleRegistry";
import UserManagement from "./UserManagement";
import PlatformAdmin from "./PlatformAdmin";
import Layout from "./Layout";
import BenefactorPortal from "./BenefactorPortal";
import "./App.css";

/**
 * Build the WebSocket URL for the dashboard.
 *
 * In production, VITE_API_BASE_URL is the Cloud Run backend base
 * (e.g. https://p3-backend-....run.app). We convert the scheme to wss://
 * so the socket connects to the backend, not to the Firebase App Hosting host.
 *
 * In development, the variable is undefined and we fall back to the same
 * origin — the Vite dev server proxy forwards /ws → localhost:8000.
 */
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

function App() {
  // authLoading: true until Firebase resolves the persisted session on page load.
  // This is the single source of truth for whether we know if a user is signed in.
  const [authLoading, setAuthLoading] = useState(true);
  const [token, setToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState("dashboard");
  const [wsStatus, setWsStatus] = useState(null);
  // activeSchool: null = platform view; { id, name } = viewing a specific school
  const [activeSchool, setActiveSchool] = useState(null);

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);

  // All hooks must be called unconditionally before any early returns.
  const handleDismiss = useCallback((plateToken) => {
    setQueue((prev) => prev.filter((e) => e.plate_token !== plateToken));
  }, []);

  const handleLogout = useCallback(async () => {
    // signOut triggers onIdTokenChanged with null → cleans up all state below.
    await signOut(auth);
  }, []);

  /**
   * Firebase Auth observer — the industry-standard pattern.
   *
   * onIdTokenChanged fires:
   *   1. Once on page load, resolving any persisted session (no sessionStorage needed)
   *   2. On every sign-in / sign-out
   *   3. When Firebase silently refreshes an expiring token (~every 55 min)
   *
   * This eliminates manual token storage, loading-state race conditions,
   * and silent failures from expired tokens.
   */
  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const idToken = await fbUser.getIdToken();
          setToken(idToken);
          const res = await createApiClient(idToken).get("/api/v1/me");
          setCurrentUser(res.data);
          if (res.data.is_guardian) setView("benefactor");
          else if (res.data.is_super_admin) setView("platformAdmin");
        } catch (err) {
          if (err.response?.status === 401) {
            await signOut(auth);
          } else {
            console.error("Failed to load user profile:", err);
            // Still mark auth as resolved so the app doesn't hang.
          }
        }
      } else {
        // Signed out — reset all state.
        setToken(null);
        setCurrentUser(null);
        setQueue([]);
        setView("dashboard");
        setWsStatus("disconnected");
        setActiveSchool(null);
      }
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  // Fetch initial dashboard queue when entering dashboard view.
  useEffect(() => {
    if (!token || view !== "dashboard") return;
    createApiClient(token)
      .get("/api/v1/dashboard")
      .then((res) => {
        if (mountedRef.current) setQueue(res.data.queue || []);
      })
      .catch((err) => {
        if (err.response?.status === 401) handleLogout();
        else console.error("Dashboard fetch error:", err);
      });
  }, [token, view, handleLogout]);

  // WebSocket — only connect once we know who the user is and they need real-time updates.
  useEffect(() => {
    mountedRef.current = true;

    // Don't touch the WebSocket until we know who the user is.
    if (!token || view !== "dashboard" || currentUser === null) return;

    // Super admins in platform mode have no school context — skip WS entirely.
    if (currentUser.role === "super_admin" && !activeSchool) return;

    let ws;
    let intentionallyClosed = false;
    let backoff = 1000;
    let retryCount = 0;

    const connect = async () => {
      if (!mountedRef.current || intentionallyClosed) return;

      if (mountedRef.current) setWsStatus("connecting");

      // Always use a fresh token to prevent auth failures from stale tokens.
      // getIdToken() returns the cached token if still valid (Firebase auto-refreshes).
      let freshToken = token;
      try {
        freshToken = (await auth.currentUser?.getIdToken()) ?? token;
      } catch {
        // Fall back to the token we already have.
      }
      if (!mountedRef.current || intentionallyClosed) return;

      ws = new WebSocket(buildWsUrl(freshToken));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setWsStatus("connected");
        backoff = 1000;
        retryCount = 0;
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "clear") {
            setQueue([]);
          } else if (data.type === "scan" && data.data) {
            setQueue((prev) => [...prev, data.data]);
          } else if (data.type === "dismiss" && data.plate_token) {
            setQueue((prev) => prev.filter((e) => e.plate_token !== data.plate_token));
          }
        } catch (e) {
          console.error("WS message parse error:", e);
        }
      };

      ws.onerror = () => {
        if (mountedRef.current) setWsStatus("error");
      };

      ws.onclose = (e) => {
        if (!mountedRef.current || intentionallyClosed) return;
        if (e.code === 4001) {
          // Server rejected the token. Don't log the user out here — Firebase's
          // onIdTokenChanged will fire when the token refreshes and re-run this
          // effect with a new token. Logging out on every WS auth failure causes
          // unnecessary sign-outs during brief server hiccups.
          setWsStatus("disconnected");
          return;
        }
        retryCount += 1;
        // After 3 consecutive failures show "offline" so the UI doesn't
        // misleadingly say "Reconnecting" forever when the backend is unreachable.
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
      clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
      setWsStatus(null);
    };
  }, [token, view, currentUser, activeSchool]);

  // ── Render ──────────────────────────────────────────────────────────────────

  // Block rendering until Firebase has resolved the persisted session.
  // This is the only loading state needed — no race conditions possible.
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

  // ── Benefactor (guardian/parent) portal — completely separate layout ──
  if (currentUser?.is_guardian) {
    return (
      <BenefactorPortal
        token={token}
        currentUser={currentUser}
        handleLogout={handleLogout}
      />
    );
  }

  // ── Admin / Staff portal ─────────────────────────────────────────────
  const schoolId = activeSchool?.id ?? null;

  const content = {
    dashboard: (
      <Dashboard
        queue={queue}
        wsStatus={wsStatus}
        onClearQueue={() => setQueue([])}
        onDismiss={handleDismiss}
        token={token}
        schoolId={schoolId}
      />
    ),
    dataImporter: <DataImporter token={token} schoolId={schoolId} />,
    reports: <Reports token={token} schoolId={schoolId} />,
    history: <History token={token} schoolId={schoolId} />,
    registry: <VehicleRegistry token={token} currentUser={currentUser} schoolId={schoolId} />,
    users: <UserManagement token={token} currentUser={currentUser} schoolId={schoolId} />,
    platformAdmin: (
      <PlatformAdmin
        token={token}
        setActiveSchool={setActiveSchool}
        setView={setView}
      />
    ),
  }[view] ?? <h2 style={{ padding: "2rem" }}>Select an option from the navigation.</h2>;

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
    >
      {content}
    </Layout>
  );
}

export default App;
