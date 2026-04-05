import React, { useState, useMemo } from "react";
import { FaCarSide, FaCheckCircle, FaTrashAlt, FaDownload } from "react-icons/fa";
import { createApiClient } from "./api";
import { downloadCSV, todayISO } from "./utils";
import "./Dashboard.css";

const CONF_WARN = 0.70;

export default function Dashboard({ queue, wsStatus, onClearQueue, onDismiss, token, schoolId = null }) {
  const [clearing,    setClearing]    = useState(false);
  const [dismissing,  setDismissing]  = useState(new Set());
  const [sortOrder,   setSortOrder]   = useState("asc");   // "asc" | "desc"
  const [locFilter,   setLocFilter]   = useState("");      // "" = all

  // ── unique locations from queue ────────────────────────
  const locations = useMemo(() => {
    const s = new Set(queue.map((e) => e.location).filter(Boolean));
    return [...s].sort();
  }, [queue]);

  // ── sorted + filtered queue ───────────────────────────
  const displayQueue = useMemo(() => {
    let q = locFilter ? queue.filter((e) => e.location === locFilter) : [...queue];
    q.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return sortOrder === "asc" ? ta - tb : tb - ta;
    });
    return q;
  }, [queue, sortOrder, locFilter]);

  // ── dismiss ────────────────────────────────────────────
  const handleDismiss = async (plateToken) => {
    setDismissing((prev) => new Set([...prev, plateToken]));
    try {
      await createApiClient(token, schoolId).delete(`/api/v1/queue/${encodeURIComponent(plateToken)}`);
      onDismiss(plateToken);
    } catch (err) {
      console.error("Dismiss failed:", err);
    } finally {
      setDismissing((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  // ── clear all ─────────────────────────────────────────
  const handleClear = async () => {
    if (!window.confirm("Clear all scans for this session? This cannot be undone.")) return;
    setClearing(true);
    try {
      await createApiClient(token, schoolId).delete("/api/v1/scans/clear");
      onClearQueue();
    } catch (err) {
      console.error("Clear failed:", err);
      alert("Failed to clear scans.");
    } finally {
      setClearing(false);
    }
  };

  // ── CSV export ─────────────────────────────────────────
  const handleExport = () => {
    const rows = displayQueue.map((e, i) => ({
      Position:   i + 1,
      Time:       e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "",
      Guardian:   e.parent || "",
      Students:   Array.isArray(e.student) ? e.student.join("; ") : (e.student || ""),
      Location:   e.location || "",
      Confidence: e.confidence_score != null ? `${(e.confidence_score * 100).toFixed(0)}%` : "",
    }));
    downloadCSV(rows, `p3-queue-${todayISO()}.csv`);
  };

  const wsLabel = wsStatus === "connected" ? "Live" : wsStatus === "error" ? "Error" : "Reconnecting…";
  const showFilters = queue.length > 0;

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="dashboard-header">
        <h2 className="dashboard-title">
          Pickup Queue
          {queue.length > 0 && (
            <span className="dashboard-count">{queue.length} waiting</span>
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

      {/* ── Filter / sort bar ── */}
      {showFilters && (
        <div className="dashboard-filterbar">
          <div className="filterbar-left">
            <select
              className="filter-select"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              aria-label="Sort order"
            >
              <option value="asc">Oldest first</option>
              <option value="desc">Newest first</option>
            </select>

            {locations.length > 0 && (
              <select
                className="filter-select"
                value={locFilter}
                onChange={(e) => setLocFilter(e.target.value)}
                aria-label="Filter by location"
              >
                <option value="">All locations</option>
                {locations.map((loc) => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            )}

            {locFilter && (
              <button className="filter-clear" onClick={() => setLocFilter("")}>
                Clear filter
              </button>
            )}
          </div>

          <button
            className="btn btn-export"
            onClick={handleExport}
            disabled={displayQueue.length === 0}
            title="Export visible queue as CSV"
          >
            <FaDownload style={{ fontSize: 11 }} /> Export CSV
          </button>
        </div>
      )}

      {/* ── Empty state ── */}
      {queue.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🚗</div>
          <div className="empty-state-title">Queue is empty</div>
          <div className="empty-state-sub">Vehicles will appear here as they're scanned at the entrance.</div>
        </div>
      ) : displayQueue.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No vehicles match this filter</div>
          <div className="empty-state-sub">
            <button className="filter-clear" onClick={() => setLocFilter("")}>Clear filter</button>
          </div>
        </div>
      ) : (
        <div className="cards-container">
          {displayQueue.map((entry, index) => {
            const time     = new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const students = Array.isArray(entry.student) ? entry.student : entry.student ? [entry.student] : [];
            const conf     = entry.confidence_score;
            const isWarn   = conf != null && conf < CONF_WARN;

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
                  {entry.location && <span className="meta-chip">📍 {entry.location}</span>}
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
