import React, { useState } from "react";
import { FaCarSide, FaCheckCircle, FaTrashAlt } from "react-icons/fa";
import { createApiClient } from "./api";
import "./Dashboard.css";

const CONF_WARN = 0.70;

export default function Dashboard({ queue, wsStatus, onClearQueue, onDismiss, token }) {
  const [clearing,   setClearing]   = useState(false);
  const [dismissing, setDismissing] = useState(new Set());

  const handleDismiss = async (plateToken) => {
    setDismissing((prev) => new Set([...prev, plateToken]));
    try {
      await createApiClient(token).delete(`/api/v1/queue/${encodeURIComponent(plateToken)}`);
      onDismiss(plateToken);
    } catch (err) {
      console.error("Dismiss failed:", err);
    } finally {
      setDismissing((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  const handleClear = async () => {
    if (!window.confirm("Clear all scans for this session? This cannot be undone.")) return;
    setClearing(true);
    try {
      await createApiClient(token).delete("/api/v1/scans/clear");
      onClearQueue();
    } catch (err) {
      console.error("Clear failed:", err);
      alert("Failed to clear scans.");
    } finally {
      setClearing(false);
    }
  };

  const wsLabel = wsStatus === "connected" ? "Live" : wsStatus === "error" ? "Error" : "Reconnecting…";

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h2 className="dashboard-title">
          Pickup Queue
          {queue.length > 0 && (
            <span style={{ marginLeft: 10, fontSize: 14, fontWeight: 600, color: "var(--text-tertiary)" }}>
              {queue.length} waiting
            </span>
          )}
        </h2>

        <div className="dashboard-controls">
          <span className={`ws-status ${wsStatus}`}>
            <span className="ws-dot" />
            {wsLabel}
          </span>

          {queue.length > 0 && (
            <button className="btn btn-danger" onClick={handleClear} disabled={clearing}>
              <FaTrashAlt style={{ fontSize: 12 }} />
              {clearing ? "Clearing…" : "Clear all"}
            </button>
          )}
        </div>
      </div>

      {queue.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🚗</div>
          <div className="empty-state-title">Queue is empty</div>
          <div className="empty-state-sub">Waiting for vehicles to be scanned…</div>
        </div>
      ) : (
        <div className="cards-container">
          {queue.map((entry, index) => {
            const time      = new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const students  = Array.isArray(entry.student) ? entry.student : entry.student ? [entry.student] : [];
            const conf      = entry.confidence_score;
            const isWarn    = conf != null && conf < CONF_WARN;

            return (
              <div key={`${entry.plate_token}-${index}`} className={`card${isWarn ? " card-warn" : ""}`}>
                <div className="badge">{index + 1}</div>

                <div className="card-header">
                  <FaCarSide className="car-icon" />
                  <span className="time">{time}</span>
                </div>

                <div className="card-body">
                  <div className="info-row">
                    <span className="label">Guardian</span>
                    <span className="value">{entry.parent || "—"}</span>
                  </div>
                  <div className="info-row">
                    <span className="label">{students.length === 1 ? "Student" : "Students"}</span>
                    <span className="value">{students.length ? students.join(", ") : "—"}</span>
                  </div>
                </div>

                <div className="card-meta">
                  {entry.location && (
                    <span className="meta-chip">📍 {entry.location}</span>
                  )}
                  {conf != null && (
                    <span className={`meta-chip${isWarn ? " warn" : ""}`}>
                      {isWarn ? "⚠️" : "🎯"} {(conf * 100).toFixed(0)}%
                    </span>
                  )}
                </div>

                <button
                  className="btn-pickup"
                  onClick={() => handleDismiss(entry.plate_token)}
                  disabled={dismissing.has(entry.plate_token)}
                >
                  <FaCheckCircle style={{ fontSize: 13 }} />
                  {dismissing.has(entry.plate_token) ? "Marking…" : "Picked Up"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
