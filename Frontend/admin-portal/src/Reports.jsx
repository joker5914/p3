import React, { useState, useEffect, useCallback } from "react";
import { createApiClient } from "./api";
import "./Reports.css";

function formatHour(h) {
  if (h === 0)  return "12a";
  if (h < 12)   return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

export default function Reports({ token }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  const fetchSummary = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token)
      .get("/api/v1/reports/summary")
      .then((res) => setData(res.data))
      .catch(() => setError("Failed to load report data."))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  if (loading) return <div className="reports-container"><div className="reports-loading">Loading report…</div></div>;

  if (error) return (
    <div className="reports-container">
      <div className="reports-error">
        {error}
        <button className="reports-retry" onClick={fetchSummary}>Retry</button>
      </div>
    </div>
  );

  const { total_scans, today_count, peak_hour, hourly_distribution, avg_confidence } = data;
  const maxH = Math.max(...(hourly_distribution || [0]), 1);

  const peakLabel = peak_hour != null
    ? `${formatHour(peak_hour)}–${formatHour(peak_hour + 1)}`
    : "—";

  const confLabel = avg_confidence != null
    ? `${(avg_confidence * 100).toFixed(0)}%`
    : "—";

  return (
    <div className="reports-container">
      <div className="reports-header">
        <h2 className="reports-title">Reports</h2>
        <button className="reports-refresh" onClick={fetchSummary}>Refresh</button>
      </div>

      <div className="stat-cards">
        {[
          { value: total_scans ?? 0, label: "Total Scans" },
          { value: today_count  ?? 0, label: "Today" },
          { value: peakLabel,         label: "Peak Hour" },
          { value: confLabel,         label: "Avg Confidence" },
        ].map(({ value, label }) => (
          <div className="stat-card" key={label}>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {hourly_distribution && (
        <div className="chart-section">
          <div className="chart-title">Scans by Hour of Day</div>
          <div className="bar-chart">
            {hourly_distribution.map((count, hour) => (
              <div key={hour} className="bar-col" title={`${formatHour(hour)}: ${count}`}>
                <div className="bar-count">{count > 0 ? count : ""}</div>
                <div className="bar" style={{ height: `${(count / maxH) * 100}%` }} />
                <div className="bar-label">{hour % 3 === 0 ? formatHour(hour) : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
