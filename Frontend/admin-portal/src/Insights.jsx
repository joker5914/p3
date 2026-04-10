import React, { useState, useEffect, useCallback } from "react";
import { createApiClient } from "./api";
import {
  FaArrowUp,
  FaArrowDown,
  FaMinus,
  FaSyncAlt,
} from "react-icons/fa";
import "./Insights.css";

/* ── helpers ─────────────────────────────────────────────────────────── */

function formatHour(h) {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* ── sub-components ──────────────────────────────────────────────────── */

function ConfBar({ label, sublabel, count, total, variant }) {
  const pct = total > 0 ? ((count / total) * 100).toFixed(0) : 0;
  return (
    <div className={`conf-row conf-${variant}`}>
      <div className="conf-info">
        <span className="conf-label">{label}</span>
        <span className="conf-sublabel">{sublabel}</span>
      </div>
      <div className="conf-bar-track">
        <div className="conf-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="conf-stats">
        <span className="conf-count">{count}</span>
        <span className="conf-pct">{pct}%</span>
      </div>
    </div>
  );
}

/* ── main component ──────────────────────────────────────────────────── */

export default function Insights({ token, schoolId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchInsights = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token, schoolId)
      .get("/api/v1/insights/summary")
      .then((res) => {
        setData(res.data);
        setLastUpdated(new Date());
      })
      .catch(() => setError("Failed to load insights data."))
      .finally(() => setLoading(false));
  }, [token, schoolId]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  /* loading / error */
  if (loading && !data)
    return (
      <div className="ins">
        <div className="ins-loading">
          <div className="ins-spinner" />
          Loading insights…
        </div>
      </div>
    );

  if (error && !data)
    return (
      <div className="ins">
        <div className="ins-error">
          {error}
          <button className="ins-retry" onClick={fetchInsights}>
            Retry
          </button>
        </div>
      </div>
    );

  /* destructure */
  const {
    total_scans,
    today_count,
    yesterday_count,
    week_count,
    avg_daily,
    peak_hour,
    hourly_distribution,
    avg_confidence,
    confidence_buckets,
    daily_counts,
    day_of_week_avg,
    predicted_today,
    unique_plates_today,
    scan_trend,
  } = data;

  const maxH = Math.max(...(hourly_distribution || [0]), 1);
  const maxDaily = Math.max(...(daily_counts || []).map((d) => d.count), 1);
  const maxDow = Math.max(...(day_of_week_avg || [0]), 1);
  const totalConf =
    (confidence_buckets?.high || 0) +
    (confidence_buckets?.medium || 0) +
    (confidence_buckets?.low || 0);

  const peakLabel =
    peak_hour != null
      ? `${formatHour(peak_hour)}–${formatHour((peak_hour + 1) % 24)}`
      : "—";

  const confPct =
    avg_confidence != null ? (avg_confidence * 100).toFixed(0) : null;

  const todayChange = today_count - (yesterday_count || 0);
  const todayChangeText =
    todayChange > 0
      ? `+${todayChange} vs yesterday`
      : todayChange < 0
        ? `${todayChange} vs yesterday`
        : "Same as yesterday";

  const trendIcon =
    scan_trend === "up" ? (
      <FaArrowUp />
    ) : scan_trend === "down" ? (
      <FaArrowDown />
    ) : (
      <FaMinus />
    );
  const trendClass =
    scan_trend === "up"
      ? "trend-up"
      : scan_trend === "down"
        ? "trend-down"
        : "trend-stable";

  const currentHour = new Date().getHours();
  const currentDow = (new Date().getDay() + 6) % 7; // Mon=0

  const predictedPct =
    predicted_today > 0
      ? Math.min((today_count / predicted_today) * 100, 150)
      : 0;

  return (
    <div className="ins">
      {/* ─── Header ────────────────────────────────────────────── */}
      <div className="ins-header">
        <div>
          <h2 className="ins-title">Insights</h2>
          {lastUpdated && (
            <span className="ins-updated">
              Updated{" "}
              {lastUpdated.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
        <button
          className="ins-refresh"
          onClick={fetchInsights}
          disabled={loading}
          title="Refresh"
        >
          <FaSyncAlt className={loading ? "spin" : ""} />
          <span>Refresh</span>
        </button>
      </div>

      {/* ─── Stat cards ────────────────────────────────────────── */}
      <div className="stat-grid">
        <StatCard
          accent="blue"
          label="Total Scans"
          value={(total_scans ?? 0).toLocaleString()}
          footer={
            <span className={`stat-trend ${trendClass}`}>
              {trendIcon}
              {scan_trend === "up"
                ? "Trending up"
                : scan_trend === "down"
                  ? "Trending down"
                  : "Stable"}{" "}
              this week
            </span>
          }
        />
        <StatCard
          accent="green"
          label="Today"
          value={today_count ?? 0}
          footer={
            <span
              className={`stat-trend ${todayChange >= 0 ? "trend-up" : "trend-down"}`}
            >
              {todayChange >= 0 ? <FaArrowUp /> : <FaArrowDown />}
              {todayChangeText}
            </span>
          }
        />
        <StatCard
          accent="purple"
          label="This Week"
          value={(week_count ?? 0).toLocaleString()}
          footer={<span className="stat-sub">{avg_daily ?? 0} avg / day</span>}
        />
        <StatCard
          accent="amber"
          label="Peak Hour"
          value={peakLabel}
          footer={<span className="stat-sub">Busiest pickup window</span>}
        />
        <StatCard
          accent="teal"
          label="Vehicles Today"
          value={unique_plates_today ?? 0}
          footer={<span className="stat-sub">Unique plates detected</span>}
        />
        <StatCard
          accent="cyan"
          label="Recognition Rate"
          value={confPct != null ? `${confPct}%` : "—"}
          footer={<span className="stat-sub">Avg confidence score</span>}
        />
      </div>

      {/* ─── Row 1: Hourly + Confidence ────────────────────────── */}
      <div className="chart-row">
        <div className="chart-card chart-wide">
          <ChartHeader title="Today's Activity" subtitle="Scans by hour" />
          <div className="hourly-chart">
            {(hourly_distribution || []).map((count, hour) => (
              <div
                key={hour}
                className={`h-col${hour === currentHour ? " h-now" : ""}`}
                title={`${formatHour(hour)}: ${count}`}
              >
                <span className="h-count">{count > 0 ? count : ""}</span>
                <div
                  className="h-bar"
                  style={{ height: `${(count / maxH) * 100}%` }}
                />
                <span className="h-label">
                  {hour % 3 === 0 ? formatHour(hour) : ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="chart-card">
          <ChartHeader
            title="Recognition Quality"
            subtitle="Confidence distribution"
          />
          {totalConf > 0 ? (
            <div className="conf-breakdown">
              <ConfBar
                label="High"
                sublabel="≥ 85%"
                count={confidence_buckets.high}
                total={totalConf}
                variant="high"
              />
              <ConfBar
                label="Medium"
                sublabel="60–84%"
                count={confidence_buckets.medium}
                total={totalConf}
                variant="med"
              />
              <ConfBar
                label="Low"
                sublabel="< 60%"
                count={confidence_buckets.low}
                total={totalConf}
                variant="low"
              />
            </div>
          ) : (
            <div className="no-data">No confidence data yet</div>
          )}

          {confPct != null && (
            <div className="gauge">
              <div className="gauge-track">
                <div
                  className="gauge-fill"
                  style={{ width: `${confPct}%` }}
                />
              </div>
              <div className="gauge-labels">
                <span>0%</span>
                <span className="gauge-val">{confPct}% avg</span>
                <span>100%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── 14-Day Trend ──────────────────────────────────────── */}
      <div className="chart-card chart-full">
        <ChartHeader
          title="14-Day Trend"
          subtitle={`Daily scan volume · ${avg_daily} avg/day`}
        />
        <div className="trend-chart">
          {(daily_counts || []).map((day, i) => {
            const isToday =
              day.date === new Date().toISOString().split("T")[0];
            return (
              <div
                key={i}
                className={`t-col${isToday ? " t-today" : ""}`}
                title={`${day.day} ${day.date}: ${day.count}`}
              >
                <span className="t-count">
                  {day.count > 0 ? day.count : ""}
                </span>
                <div
                  className="t-bar"
                  style={{ height: `${(day.count / maxDaily) * 100}%` }}
                />
                <span className="t-day">{day.day}</span>
                <span className="t-date">{day.date.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Row 2: Weekly Pattern + Forecast ──────────────────── */}
      <div className="chart-row">
        <div className="chart-card">
          <ChartHeader
            title="Weekly Pattern"
            subtitle="Avg scans by day of week"
          />
          <div className="dow-chart">
            {DAY_NAMES.map((name, i) => {
              const val = day_of_week_avg?.[i] ?? 0;
              return (
                <div
                  key={i}
                  className={`d-col${i === currentDow ? " d-now" : ""}`}
                  title={`${name}: ${val} avg`}
                >
                  <span className="d-count">{val > 0 ? val : ""}</span>
                  <div
                    className="d-bar"
                    style={{ height: `${(val / maxDow) * 100}%` }}
                  />
                  <span className="d-label">{name}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="chart-card forecast-card">
          <ChartHeader
            title="Forecast"
            subtitle="Based on historical patterns"
          />
          <div className="fc">
            <div className="fc-hero">
              <span className="fc-big">{predicted_today ?? 0}</span>
              <span className="fc-label">scans expected today</span>
            </div>

            <div className="fc-progress">
              <div className="fc-progress-head">
                <span>Progress</span>
                <span className="fc-pct">
                  {Math.min(predictedPct, 100).toFixed(0)}%
                </span>
              </div>
              <div className="fc-track">
                <div
                  className="fc-fill"
                  style={{ width: `${Math.min(predictedPct, 100)}%` }}
                />
              </div>
              <div className="fc-counts">
                <span>{today_count} actual</span>
                <span>{predicted_today ?? 0} predicted</span>
              </div>
            </div>

            {peak_hour != null && (
              <div className="fc-peak">
                <span className="fc-peak-label">Peak window</span>
                <span className="fc-peak-value">{peakLabel}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── tiny presentational helpers ─────────────────────────────────────── */

function StatCard({ accent, label, value, footer }) {
  return (
    <div className={`stat-card sc-${accent}`}>
      <span className="sc-label">{label}</span>
      <span className="sc-value">{value}</span>
      {footer && <div className="sc-footer">{footer}</div>}
    </div>
  );
}

function ChartHeader({ title, subtitle }) {
  return (
    <div className="ch-hdr">
      <h3 className="ch-title">{title}</h3>
      {subtitle && <span className="ch-sub">{subtitle}</span>}
    </div>
  );
}
