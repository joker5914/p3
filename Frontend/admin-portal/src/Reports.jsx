import React, { useState, useEffect, useCallback } from "react";
import { createApiClient } from "./api";
import "./Reports.css";

function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export default function Reports({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchSummary = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token)
      .get("/api/v1/reports/summary")
      .then((res) => setData(res.data))
      .catch(() => setError("Failed to load report data. Please try again."))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  if (loading) return <div className="reports-loading">Loading report…</div>;
  if (error) return <div className="reports-error">{error} <button className="reports-retry" onClick={fetchSummary}>Retry</button></div>;

  const { total_scans, today_count, peak_hour, hourly_distribution, avg_confidence } = data;
  const maxHourly = Math.max(...(hourly_distribution || []), 1);

  const peakLabel = peak_hour != null
    ? `${formatHour(peak_hour)} – ${formatHour(peak_hour + 1)}`
    : "—";

  const confidenceLabel = avg_confidence != null
    ? `${(avg_confidence * 100).toFixed(0)}%`
    : "—";

  return (
    <div className="reports-container">
      <div className="reports-header">
        <h3 className="reports-title">Summary Report</h3>
        <button className="reports-refresh" onClick={fetchSummary}>Refresh</button>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-value">{total_scans ?? 0}</div>
          <div className="stat-label">Total Scans (All Time)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{today_count ?? 0}</div>
          <div className="stat-label">Scans Today</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{peakLabel}</div>
          <div className="stat-label">Peak Hour</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{confidenceLabel}</div>
          <div className="stat-label">Avg Confidence</div>
        </div>
      </div>

      {hourly_distribution && (
        <div className="chart-section">
          <h4 className="chart-title">Scans by Hour of Day</h4>
          <div className="bar-chart">
            {hourly_distribution.map((count, hour) => (
              <div key={hour} className="bar-col">
                <div className="bar-count">{count > 0 ? count : ""}</div>
                <div
                  className="bar"
                  style={{ height: `${(count / maxHourly) * 100}%` }}
                  title={`${formatHour(hour)}: ${count} scan(s)`}
                />
                <div className="bar-label">{hour % 3 === 0 ? formatHour(hour) : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
