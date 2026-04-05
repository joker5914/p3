import React, { useState, useEffect, useCallback } from "react";
import { FaExclamationTriangle, FaInfoCircle, FaTimes } from "react-icons/fa";
import { createApiClient } from "./api";
import "./Alerts.css";

export default function Alerts({ token }) {
  const [alerts,    setAlerts]    = useState([]);
  const [dismissed, setDismissed] = useState(new Set());

  const fetchAlerts = useCallback(() => {
    if (!token) return;
    createApiClient(token)
      .get("/api/v1/system/alerts")
      .then((res) => setAlerts(res.data.alerts || []))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (!visible.length) return null;

  return (
    <div className="alerts-bar">
      {visible.map((alert) => (
        <div key={alert.id} className={`alert-item alert-${alert.severity}`}>
          <span className="alert-icon">
            {alert.severity === "warning" ? <FaExclamationTriangle /> : <FaInfoCircle />}
          </span>
          <span className="alert-message">{alert.message}</span>
          <button
            className="alert-dismiss"
            onClick={() => setDismissed((p) => new Set([...p, alert.id]))}
            title="Dismiss"
          >
            <FaTimes />
          </button>
        </div>
      ))}
    </div>
  );
}
