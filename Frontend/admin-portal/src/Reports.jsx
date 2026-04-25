import React, { useState, useEffect, useCallback } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./Reports.css";

function formatHour(h) {
  if (h === 0)  return "12a";
  if (h < 12)   return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

export default function Reports({ token, schoolId = null }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  const fetchSummary = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token, schoolId)
      .get("/api/v1/reports/summary")
      .then((res) => setData(res.data))
      .catch(() => setError("Failed to load report data."))
      .finally(() => setLoading(false));
  }, [token, schoolId]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  if (loading) return (
    <div className="reports-container">
      <div className="page-empty">
        <div className="page-empty-icon"><I.spinner size={22} /></div>
        Loading report…
      </div>
    </div>
  );

  if (error) return (
    <div className="reports-container">
      <div className="page-empty">
        <div className="page-empty-icon"><I.alert size={22} /></div>
        {error}
        <button className="btn-ghost reports-retry" onClick={fetchSummary}>
          <I.refresh size={14} /> Retry
        </button>
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
      <header className="page-head">
        <div>
          <div className="page-eyebrow">Insights · scans</div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Pickup activity at a glance — totals, peak windows, and recognition confidence.</p>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={fetchSummary}>
            <I.refresh size={14} /> Refresh
          </button>
        </div>
      </header>

      <div className="stat-cards">
        {[
          { value: total_scans ?? 0, label: "Total Scans",    icon: I.insights,    accent: "brand"  },
          { value: today_count  ?? 0, label: "Today",          icon: I.history,     accent: "blue"   },
          { value: peakLabel,         label: "Peak Hour",      icon: I.zap,         accent: "violet" },
          { value: confLabel,         label: "Avg Confidence", icon: I.checkCircle, accent: "green"  },
        ].map(({ value, label, icon, accent }) => {
          const Icon = icon;
          return (
            <div className="stat-card" data-accent={accent} key={label}>
              <div className="stat-icon" aria-hidden="true"><Icon size={16} /></div>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          );
        })}
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
