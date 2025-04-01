import { useEffect, useState, useRef } from "react";
import { createApiClient } from "./api";
import Login from "./Login";
import Dashboard from "./Dashboard";
import DataImporter from "./DataImporter";
import Layout from "./Layout";
import "./App.css";

function App() {
  const [token, setToken] = useState(localStorage.getItem("idToken"));
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState("dashboard");

  // Refs to hold the websocket, reconnect timer, and flags.
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const isManuallyClosed = useRef(false);
  const connectionCount = useRef(0);

  const handleLogin = (idToken) => {
    localStorage.setItem("idToken", idToken);
    setToken(idToken);
  };

  const handleLogout = () => {
    localStorage.removeItem("idToken");
    setToken(null);
    setQueue([]);
    setView("dashboard");
  };

  // Initial fetch on dashboard
  useEffect(() => {
    if (token && view === "dashboard") {
      const api = createApiClient(token);
      api.get("/api/v1/dashboard")
        .then((res) => {
          setQueue(res.data.queue || []);
        })
        .catch((err) => {
          console.error("Error fetching dashboard:", err);
          if (err.response?.status === 401) handleLogout();
        });
    }
  }, [token, view]);

  // WebSocket for realtime updates on dashboard view
  useEffect(() => {
    if (token && view === "dashboard") {
      const connectWebSocket = () => {
        const ws = new WebSocket("ws://localhost:8000/ws/dashboard");
        wsRef.current = ws;

        ws.onopen = () => {
          connectionCount.current++;
          console.log("WebSocket connection established. Total connections:", connectionCount.current);
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "clear") {
            console.log("Received 'clear' event");
            setQueue([]);
          } else if (data.type === "scan") {
            console.log("Received 'scan' event:", data.data);
            setQueue((prevQueue) => [...prevQueue, data.data]);
          }
        };

        ws.onerror = (error) => {
          console.error("WebSocket error:", error);
        };

        ws.onclose = (e) => {
          connectionCount.current--;
          console.log("WebSocket closed. Total connections:", connectionCount.current, "Reason:", e.reason);
          if (!isManuallyClosed.current) {
            reconnectTimeoutRef.current = setTimeout(() => {
              connectWebSocket();
            }, 1000);
          }
        };
      };

      // Optional slight delay before connecting
      const timer = setTimeout(() => {
        isManuallyClosed.current = false;
        connectWebSocket();
      }, 500);

      return () => {
        clearTimeout(timer);
        isManuallyClosed.current = true;
        if (wsRef.current) {
          wsRef.current.close();
        }
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };
    }
  }, [token, view]);

  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  let content;
  switch (view) {
    case "dashboard":
      content = <Dashboard queue={queue} />;
      break;
    case "dataImporter":
      content = <DataImporter />;
      break;
    default:
      content = <h2>Select an option from the left nav.</h2>;
  }

  return (
    <Layout view={view} setView={setView} handleLogout={handleLogout}>
      {content}
    </Layout>
  );
}

export default App;
