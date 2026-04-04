import React, { useState } from "react";
import { FaCarSide, FaWifi, FaExclamationTriangle, FaTrashAlt } from "react-icons/fa";
import { createApiClient } from "./api";
import "./Dashboard.css";

export default function Dashboard({ queue, wsStatus, onClearQueue, token }) {
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    if (!window.confirm("Clear all scans for this session? This cannot be undone.")) return;
    setClearing(true);
    try {
      const api = createApiClient(token);
      await api.delete("/api/v1/scans/clear");
      onClearQueue();
    } catch (err) {
      console.error("Clear failed:", err);
      alert("Failed to clear scans. Check the console.");
    } finally {
      setClearing(false);
    }
  };

  const statusIcon =
    wsStatus === "connected" ? (
      <span className="ws-status connected" title="Live — connected">
        <FaWifi /> Live
      </span>
    ) : (
      <span className="ws-status disconnected" title={`WebSocket ${wsStatus}`}>
        <FaExclamationTriangle /> {wsStatus === "error" ? "Error" : "Reconnecting…"}
      </span>
    );

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h3 className="dashboard-title">Current Pickup Queue</h3>
        <div className="dashboard-controls">
          {statusIcon}
          {queue.length > 0 && (
            <button
              className="btn btn-danger"
              onClick={handleClear}
              disabled={clearing}
              title="Clear all scans"
            >
              <FaTrashAlt /> {clearing ? "Clearing…" : `Clear (${queue.length})`}
            </button>
          )}
        </div>
      </div>

      {queue.length === 0 ? (
        <div className="empty-message">No scans yet — waiting for vehicles…</div>
      ) : (
        <div className="cards-container">
          {queue.map((entry, index) => {
            const timeString = new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            });
            const students = Array.isArray(entry.student)
              ? entry.student
              : entry.student
              ? [entry.student]
              : [];

            return (
              <div key={`${entry.plate_token}-${index}`} className="card">
                <div className="badge">{index + 1}</div>
                <div className="card-header">
                  <FaCarSide className="car-icon" />
                  <div className="time">{timeString}</div>
                </div>
                <div className="card-content">
                  <div className="info">
                    <div className="info-row">
                      <span className="label">Guardian:</span>
                      <span className="value">{entry.parent || "N/A"}</span>
                    </div>
                    <div className="info-row">
                      <span className="label">
                        {students.length === 1 ? "Student:" : "Students:"}
                      </span>
                      <span className="value">
                        {students.length ? students.join(", ") : "N/A"}
                      </span>
                    </div>
                  </div>
                  <div className="extra">
                    <span>📍 {entry.location || "N/A"}</span>
                    <span>
                      🎯{" "}
                      {entry.confidence_score != null
                        ? `${(entry.confidence_score * 100).toFixed(0)}%`
                        : "N/A"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
