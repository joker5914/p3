import React, { useState, useMemo, useCallback } from "react";
import { FaCarSide, FaCheckCircle, FaTrashAlt, FaExclamationTriangle, FaQuestionCircle, FaShieldAlt, FaSlidersH } from "react-icons/fa";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";
import "./Dashboard.css";

const DEFAULT_CONF_THRESHOLD = 70;

function useConfThreshold() {
  const [threshold, setThreshold] = useState(() => {
    const stored = localStorage.getItem("p3-conf-threshold");
    const val = stored ? parseInt(stored, 10) : DEFAULT_CONF_THRESHOLD;
    return val >= 0 && val <= 100 ? val : DEFAULT_CONF_THRESHOLD;
  });

  const update = useCallback((val) => {
    const clamped = Math.max(0, Math.min(100, val));
    setThreshold(clamped);
    localStorage.setItem("p3-conf-threshold", String(clamped));
  }, []);

  return { threshold, update };
}

const WS_LABELS = {
  connecting:   "Connecting",
  connected:    "Live",
  disconnected: "Reconnecting",
  offline:      "Offline",
  error:        "Error",
};

export default function Dashboard({ queue, wsStatus, onClearQueue, onDismiss, token, schoolId = null }) {
  const [clearing,    setClearing]    = useState(false);
  const [dismissing,  setDismissing]  = useState(new Set());
  const [sortOrder,   setSortOrder]   = useState("asc");
  const [locFilter,   setLocFilter]   = useState("");
  const [showThresholdControl, setShowThresholdControl] = useState(false);
  const { threshold: confThreshold, update: setConfThreshold } = useConfThreshold();
  const confWarn = confThreshold / 100;

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
      await createApiClient(token, schoolId).delete(`/api/v1/queue/${encodeURIComponent(plateToken)}?pickup_method=manual`);
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

  // ── bulk pickup ────────────────────────────────────────
  const [bulkPicking, setBulkPicking] = useState(false);

  const handleBulkPickup = async () => {
    const count = displayQueue.length;
    if (!window.confirm(`Mark all ${count} vehicle${count !== 1 ? "s" : ""} as picked up? This cannot be undone.`)) return;
    setBulkPicking(true);
    try {
      await createApiClient(token, schoolId).post("/api/v1/queue/bulk-pickup");
      onClearQueue();
    } catch (err) {
      console.error("Bulk pickup failed:", err);
      alert("Failed to complete bulk pickup.");
    } finally {
      setBulkPicking(false);
    }
  };

  const wsLabel = WS_LABELS[wsStatus] ?? null;
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
          {wsLabel && (
            <span className={`ws-status ${wsStatus}`}>
              <span className="ws-dot" />
              {wsLabel}
            </span>
          )}
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

          <div className="filterbar-right">
            <button
              className="btn btn-bulk-pickup"
              onClick={handleBulkPickup}
              disabled={displayQueue.length === 0 || bulkPicking}
              title="Mark all visible vehicles as picked up"
            >
              <FaCheckCircle style={{ fontSize: 12 }} />
              {bulkPicking ? "Marking…" : "Mark All Picked Up"}
            </button>

            <button
              className={`btn-threshold-toggle${showThresholdControl ? " active" : ""}`}
              onClick={() => setShowThresholdControl((p) => !p)}
              title={`Confidence threshold: ${confThreshold}%`}
            >
              <FaSlidersH style={{ fontSize: 12 }} />
            </button>
          </div>

          {showThresholdControl && (
            <div className="threshold-control">
              <label className="threshold-label">
                Confidence warning threshold
              </label>
              <div className="threshold-slider-row">
                <input
                  type="range"
                  className="threshold-slider"
                  min={0}
                  max={100}
                  step={5}
                  value={confThreshold}
                  onChange={(e) => setConfThreshold(Number(e.target.value))}
                />
                <span className="threshold-value">{confThreshold}%</span>
              </div>
              <p className="threshold-hint">
                Cards below this score get an amber warning. Currently flagging reads under {confThreshold}%.
              </p>
            </div>
          )}
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
            const time         = new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const students     = Array.isArray(entry.student) ? entry.student : entry.student ? [entry.student] : [];
            const photoUrls    = Array.isArray(entry.student_photo_urls) ? entry.student_photo_urls : [];
            const conf         = entry.confidence_score;
            const isWarn       = conf != null && conf < confWarn;
            const vehicleLabel = [entry.vehicle_color, entry.vehicle_make, entry.vehicle_model].filter(Boolean).join(" ") || null;
            const authStatus   = entry.authorization_status || "authorized";
            const isUnauthorized = authStatus === "unauthorized";
            const isUnregistered = authStatus === "unregistered";
            const isAuthGuardian = authStatus === "authorized_guardian";

            const cardClass = [
              "card",
              isUnauthorized ? "card-unauthorized" : "",
              isUnregistered ? "card-unregistered" : "",
              isAuthGuardian ? "card-auth-guardian" : "",
              isWarn && !isUnauthorized && !isUnregistered ? "card-warn" : "",
            ].filter(Boolean).join(" ");

            return (
              <div key={`${entry.plate_token}-${index}`} className={cardClass}>
                <div className="badge">{index + 1}</div>

                {/* Status banner for unauthorized */}
                {isUnauthorized && (
                  <div className="card-banner card-banner-unauthorized">
                    <FaExclamationTriangle />
                    <div className="card-banner-text">
                      <strong>Unauthorized Person</strong>
                      {entry.blocked_reason && <span>{entry.blocked_reason}</span>}
                    </div>
                  </div>
                )}

                {/* Status banner for unregistered */}
                {isUnregistered && (
                  <div className="card-banner card-banner-unregistered">
                    <FaQuestionCircle />
                    <div className="card-banner-text">
                      <strong>Unregistered Vehicle</strong>
                      <span>Not found in system</span>
                    </div>
                  </div>
                )}

                {/* Status banner for low confidence */}
                {isWarn && !isUnauthorized && !isUnregistered && (
                  <div className="card-banner card-banner-lowconf">
                    <FaExclamationTriangle />
                    <div className="card-banner-text">
                      <strong>Low Confidence Read ({(conf * 100).toFixed(0)}%)</strong>
                      <span>Below {confThreshold}% threshold — verify plate before releasing</span>
                    </div>
                  </div>
                )}

                {/* Status banner for authorized guardian */}
                {isAuthGuardian && (
                  <div className="card-banner card-banner-auth-guardian">
                    <FaShieldAlt />
                    <div className="card-banner-text">
                      <strong>Authorized Guardian Pickup</strong>
                      {entry.primary_guardian && <span>Primary: {entry.primary_guardian}</span>}
                    </div>
                  </div>
                )}

                {/* Header: car icon + plate + time */}
                <div className="card-header">
                  <div className="card-header-left">
                    <FaCarSide className="car-icon" />
                    {entry.plate_display && (
                      <span className={`plate-chip${isUnauthorized ? " plate-danger" : isUnregistered ? " plate-unknown" : ""}`}>
                        {entry.plate_display}
                      </span>
                    )}
                  </div>
                  <span className="time">{time}</span>
                </div>

                {/* Body: guardian + students */}
                <div className="card-body">
                  {/* Guardian row */}
                  {entry.parent ? (
                    <div className="person-row">
                      <PersonAvatar name={entry.parent} photoUrl={entry.guardian_photo_url} size={34} />
                      <div className="person-info">
                        <span className="person-name">{entry.parent}</span>
                        <span className="person-role">
                          {isUnauthorized ? "Blocked" : isAuthGuardian ? "Authorized Guardian" : "Guardian"}
                        </span>
                      </div>
                    </div>
                  ) : isUnregistered ? (
                    <div className="person-row">
                      <div className="avatar-unknown">?</div>
                      <div className="person-info">
                        <span className="person-name">Unknown Driver</span>
                        <span className="person-role">No record found</span>
                      </div>
                    </div>
                  ) : null}

                  {/* Student rows */}
                  {students.length > 0 && (
                    <div className="students-section">
                      {students.map((name, i) => (
                        <div key={i} className="person-row student-row">
                          <PersonAvatar name={name} photoUrl={photoUrls[i] ?? null} size={28} />
                          <span className="student-name">{name}</span>
                          <span className="student-order">{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Authorized guardians */}
                  {(entry.authorized_guardians || []).length > 0 && (
                    <div className="auth-guardians-section">
                      <span className="auth-guardians-label">Also authorized</span>
                      {entry.authorized_guardians.map((ag, i) => (
                        <div key={i} className="person-row student-row">
                          <PersonAvatar name={ag.name} photoUrl={ag.photo_url} size={24} />
                          <span className="student-name">{ag.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Meta chips */}
                <div className="card-meta">
                  {entry.location && <span className="meta-chip">📍 {entry.location}</span>}
                  {conf != null && (
                    <span
                      className={`meta-chip${isWarn ? " warn" : ""}`}
                      title={isWarn
                        ? `Low confidence read (${(conf * 100).toFixed(0)}%) — below ${confThreshold}% threshold. Plate may be misread; verify before releasing.`
                        : `Confidence: ${(conf * 100).toFixed(0)}%`
                      }
                    >
                      {isWarn ? "⚠️" : "🎯"} {(conf * 100).toFixed(0)}%
                    </span>
                  )}
                  {vehicleLabel && <span className="meta-chip">🚘 {vehicleLabel}</span>}
                </div>

                <button
                  className={`btn-pickup${isUnauthorized ? " btn-pickup-danger" : ""}`}
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
