import { useEffect, useState, useRef, useCallback } from "react";
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

const SESSION_KEY = "p3_session_token";

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(SESSION_KEY));
  const [currentUser, setCurrentUser] = useState(null);
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState("dashboard");
  const [wsStatus, setWsStatus] = useState("disconnected");
  // activeSchool: null = platform view; { id, name } = viewing a specific school
  const [activeSchool, setActiveSchool] = useState(null);

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef = useRef(true);

  const handleLogin = useCallback((idToken) => {
    sessionStorage.setItem(SESSION_KEY, idToken);
    setToken(idToken);
  }, []);

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setCurrentUser(null);
    setQueue([]);
    setView("dashboard");
    setWsStatus("disconnected");
    setActiveSchool(null);
  }, []);

  // Fetch the authenticated user's profile (role, display name, school) after login.
  // On success, super_admins land on the platform admin page by default.
  useEffect(() => {
    if (!token) { setCurrentUser(null); return; }
    createApiClient(token)
      .get("/api/v1/me")
      .then((res) => {
        setCurrentUser(res.data);
        if (res.data.is_super_admin) setView("platformAdmin");
      })
      .catch((err) => {
        if (err.response?.status === 401) handleLogout();
        else console.error("Failed to load user profile:", err);
      });
  }, [token, handleLogout]);

  useEffect(() => {
    if (!token || view !== "dashboard") return;
    const api = createApiClient(token);
    api
      .get("/api/v1/dashboard")
      .then((res) => {
        if (mountedRef.current) setQueue(res.data.queue || []);
      })
      .catch((err) => {
        if (err.response?.status === 401) handleLogout();
        else console.error("Dashboard fetch error:", err);
      });
  }, [token, view, handleLogout]);

  useEffect(() => {
    mountedRef.current = true;
    if (!token || view !== "dashboard") return;

    let ws;
    let intentionallyClosed = false;
    let backoff = 1000;

    const connect = () => {
      if (!mountedRef.current || intentionallyClosed) return;

      ws = new WebSocket(buildWsUrl(token));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setWsStatus("connected");
        backoff = 1000;
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
        setWsStatus("disconnected");
        if (e.code === 4001) {
          handleLogout();
          return;
        }
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
      setWsStatus("disconnected");
    };
  }, [token, view, handleLogout]);

  if (!token) return <Login onLogin={handleLogin} />;

  const handleDismiss = useCallback((plateToken) => {
    setQueue((prev) => prev.filter((e) => e.plate_token !== plateToken));
  }, []);

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
