import React, { useState, useEffect, useCallback } from "react";
import { FaExclamationTriangle, FaInfoCircle, FaTimes } from "react-icons/fa";
import { createApiClient } from "./api";
import "./Alerts.css";

const POLL_INTERVAL = 60_000; // 1 minute

export default function Alerts({ token, schoolId = null }) {
  const [alerts, setAlerts] = useState([]);
  const [dismissed, setDismissed] = useState(new Set());

  const fetchAlerts = useCallback(() => {
    if (!token) return;
    createApiClient(token, schoolId)
      .get("/api/v1/system/alerts")
      .then((res) => setAlerts(res.data.alerts || []))
      .catch(() => {}); // silently ignore — don't surface a fetch error as a fake alert
  }, [token, schoolId]);

  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (!visible.length) return null;

  const dismiss = (id) =>
    setDismissed((prev) => new Set([...prev, id]));

  return (
    <div
      className="alerts-bar"
      role="region"
      aria-label="System alerts"
      aria-live="polite"
    >
      {visible.map((alert) => (
        <div
          key={alert.id}
          className={`alert-item alert-${alert.severity}`}
          role={alert.severity === "warning" ? "alert" : "status"}
        >
          <span className="alert-icon" aria-hidden="true">
            {alert.severity === "warning" ? <FaExclamationTriangle /> : <FaInfoCircle />}
          </span>
          <span className="sr-only">
            {alert.severity === "warning" ? "Warning: " : "Info: "}
          </span>
          <span className="alert-message">{alert.message}</span>
          <button
            className="alert-dismiss"
            onClick={() => dismiss(alert.id)}
            aria-label={`Dismiss alert: ${alert.message}`}
            title="Dismiss"
          >
            <FaTimes aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
