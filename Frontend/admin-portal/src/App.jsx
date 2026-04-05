import { useEffect, useState, useRef, useCallback } from "react";
import { createApiClient } from "./api";
import Login from "./Login";
import Dashboard from "./Dashboard";
import DataImporter from "./DataImporter";
import Reports from "./Reports";
import History from "./History";
import VehicleRegistry from "./VehicleRegistry";
import Layout from "./Layout";
import "./App.css";

function buildWsUrl(token) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  return `${proto}://${host}/ws/dashboard?token=${encodeURIComponent(token)}`;
}

const SESSION_KEY = "p3_session_token";

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(SESSION_KEY));
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState("dashboard");
  const [wsStatus, setWsStatus] = useState("disconnected");

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
    setQueue([]);
    setView("dashboard");
    setWsStatus("disconnected");
  }, []);

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

  const content = {
    dashboard: (
      <Dashboard
        queue={queue}
        wsStatus={wsStatus}
        onClearQueue={() => setQueue([])}
        onDismiss={handleDismiss}
        token={token}
      />
    ),
    dataImporter: <DataImporter token={token} />,
    reports: <Reports token={token} />,
    history: <History token={token} />,
    registry: <VehicleRegistry token={token} />,
  }[view] ?? <h2 style={{ padding: "2rem" }}>Select an option from the navigation.</h2>;

  return (
    <Layout view={view} setView={setView} handleLogout={handleLogout} wsStatus={wsStatus} token={token}>
      {content}
    </Layout>
  );
}

export default App;
