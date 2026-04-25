import React, { useState, useEffect, useCallback, useRef } from "react";
import { createApiClient } from "./api";
import { I } from "./components/icons";
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

export default function Insights({ token, schoolId = null, scanVersion = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const debounceRef = useRef(null);

  // Core fetch — returns a promise so callers can chain.
  const fetchInsights = useCallback(() => {
    const api = createApiClient(token, schoolId);

    // Try the rich insights endpoint first; fall back to the legacy
    // reports/summary endpoint if the backend hasn't been updated yet.
    return api
      .get("/api/v1/insights/summary")
      .then((res) => {
        setData(res.data);
        setLastUpdated(new Date());
      })
      .catch(() =>
        api
          .get("/api/v1/reports/summary")
          .then((res) => {
            // Normalize legacy payload into the shape Insights expects
            const d = res.data;
            const hd = d.hourly_distribution || [];
            const todayScans = d.today_count ?? 0;
            const total = d.total_scans ?? 0;
            const avgConf = d.avg_confidence;

            // Build confidence buckets from avg (rough estimate)
            const buckets = { high: 0, medium: 0, low: 0 };
            if (avgConf != null) {
              if (avgConf >= 0.85) buckets.high = total;
              else if (avgConf >= 0.6) buckets.medium = total;
              else buckets.low = total;
            }

            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const daily = [];
            for (let i = 13; i >= 0; i--) {
              const dt = new Date(now);
              dt.setDate(dt.getDate() - i);
              daily.push({
                date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
                count: i === 0 ? todayScans : 0,
                day: dayNames[dt.getDay()],
              });
            }

            const dowAvg = [0, 0, 0, 0, 0, 0, 0];
            const currentDowIdx = (now.getDay() + 6) % 7;
            dowAvg[currentDowIdx] = todayScans;

            setData({
              total_scans: total,
              today_count: todayScans,
              yesterday_count: 0,
              week_count: todayScans,
              avg_daily: total > 0 ? Math.round(total * 10 / Math.max(1, total > todayScans ? 7 : 1)) / 10 : 0,
              peak_hour: d.peak_hour,
              hourly_distribution: hd,
              avg_confidence: avgConf,
              confidence_buckets: buckets,
              daily_counts: daily,
              day_of_week_avg: dowAvg,
              predicted_today: todayScans,
              unique_plates_today: todayScans,
              scan_trend: "stable",
            });
            setLastUpdated(new Date());
          })
      )
      .catch(() => setError("Failed to load insights data."));
  }, [token, schoolId]);

  // Initial load (shows spinner)
  useEffect(() => {
    setLoading(true);
    fetchInsights().finally(() => setLoading(false));
  }, [fetchInsights]);

  // Keep a ref to the latest fetchInsights so the debounced timeout below
  // never captures a stale closure.  Without this, a super-admin switching
  // schools while a 2-s debounce is pending would have the pending fetch
  // fire with the old schoolId and overwrite the new school's data.
  const fetchInsightsRef = useRef(fetchInsights);
  useEffect(() => { fetchInsightsRef.current = fetchInsights; }, [fetchInsights]);

  // Live refresh — debounced re-fetch when scan events arrive via WebSocket.
  // 2 s delay batches rapid-fire events into a single API call.
  useEffect(() => {
    if (!data) return; // skip before initial load completes
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchInsightsRef.current(), 2000);
    return () => clearTimeout(debounceRef.current);
  }, [scanVersion, data]);

  /* loading / error */
  if (loading && !data)
    return (
      <div className="ins">
        <div className="page-empty ins-loading">
          <div className="page-empty-icon"><I.spinner size={22} /></div>
          Loading insights…
        </div>
      </div>
    );

  if (error && !data)
    return (
      <div className="ins">
        <div className="page-empty ins-error">
          <div className="page-empty-icon"><I.alert size={22} /></div>
          {error}
          <button className="btn-ghost ins-retry" onClick={fetchInsights}>
            <I.refresh size={14} /> Retry
          </button>
        </div>
      </div>
    );

  /* destructure */
  const {
    total_scans,
    today_count,
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
    // ── Supercharged fields ──
    today_last_week_count = 0,
    prev_week_count = 0,
    heatmap = [],
    wait_stats = { total_pickups: 0, avg_seconds: 0, median_seconds: 0, buckets: {} },
    pickup_methods_today = { auto: 0, manual: 0, manual_bulk: 0 },
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

  const trendIcon =
    scan_trend === "up" ? (
      <I.arrowUp size={12} />
    ) : scan_trend === "down" ? (
      <I.arrowDown size={12} />
    ) : (
      <I.minus size={12} />
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

  // Pickup method totals / percentages — today only.
  const pmTotal =
    (pickup_methods_today.auto || 0) +
    (pickup_methods_today.manual || 0) +
    (pickup_methods_today.manual_bulk || 0);
  const pmPct = (n) => (pmTotal > 0 ? (n / pmTotal) * 100 : 0);

  // Heatmap intensity scaling.  Use the max cell across the 28-day window
  // so mid-peak hours still read as "busy" rather than "empty".
  const maxHeat = Math.max(
    1,
    ...((heatmap || []).flatMap((row) => row || [])),
  );

  // Wait-time histogram buckets in display order.
  const waitBuckets = [
    { key: "lt1m",    label: "<1m",   variant: "good" },
    { key: "1to3m",   label: "1–3m",  variant: "good" },
    { key: "3to5m",   label: "3–5m",  variant: "warn" },
    { key: "5to10m",  label: "5–10m", variant: "bad"  },
    { key: "gt10m",   label: ">10m",  variant: "bad"  },
  ];
  const waitBucketTotal = waitBuckets.reduce(
    (sum, b) => sum + (wait_stats.buckets?.[b.key] || 0),
    0,
  );

  return (
    <div className="ins">
      {/* ─── Header ────────────────────────────────────────────── */}
      <header className="page-head ins-header">
        <div>
          <div className="page-eyebrow">Analytics · pickups</div>
          <h1 className="page-title ins-title">Insights</h1>
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
        <div className="page-actions">
          <div className="ins-live" title="Data updates automatically when new scans arrive">
            <span className="ins-live-dot" />
            <span>Live</span>
          </div>
        </div>
      </header>

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
          footer={<WowDelta current={today_count} prior={today_last_week_count} label="vs same day last wk" />}
        />
        <StatCard
          accent="purple"
          label="This Week"
          value={(week_count ?? 0).toLocaleString()}
          footer={
            <div className="sc-footer-stack">
              <WowDelta current={week_count} prior={prev_week_count} label="vs prev 7d" />
              <span className="stat-sub">{avg_daily ?? 0} avg / day</span>
            </div>
          }
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

      {/* ─── Row: Wait Times + Pickup Methods (today) ──────────── */}
      <div className="chart-row">
        <div className="chart-card">
          <ChartHeader
            title="Wait Times Today"
            subtitle={
              wait_stats.total_pickups > 0
                ? `${wait_stats.total_pickups} pickup${wait_stats.total_pickups === 1 ? "" : "s"} completed`
                : "No completed pickups yet"
            }
          />
          {wait_stats.total_pickups > 0 ? (
            <>
              <div className="wt-headline">
                <div className="wt-stat">
                  <span className="wt-val">{formatDuration(wait_stats.avg_seconds)}</span>
                  <span className="wt-label">Average</span>
                </div>
                <div className="wt-stat">
                  <span className="wt-val">{formatDuration(wait_stats.median_seconds)}</span>
                  <span className="wt-label">Median</span>
                </div>
              </div>
              <div className="wt-hist">
                {waitBuckets.map((b) => {
                  const count = wait_stats.buckets?.[b.key] || 0;
                  const pct = waitBucketTotal > 0 ? (count / waitBucketTotal) * 100 : 0;
                  return (
                    <div key={b.key} className="wt-row" title={`${b.label}: ${count} (${pct.toFixed(0)}%)`}>
                      <span className="wt-bucket">{b.label}</span>
                      <div className="wt-track">
                        <div className={`wt-fill wt-${b.variant}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="wt-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="no-data">
              Wait-time data shows up here once vehicles start getting picked up today.
            </div>
          )}
        </div>

        <div className="chart-card">
          <ChartHeader
            title="Pickup Methods Today"
            subtitle={
              pmTotal > 0
                ? `${pmTotal} pickup${pmTotal === 1 ? "" : "s"}`
                : "Scanner vs manual breakdown"
            }
          />
          {pmTotal > 0 ? (
            <>
              <div className="pm-bar" role="img" aria-label="Pickup method distribution">
                {pickup_methods_today.auto > 0 && (
                  <div
                    className="pm-seg pm-auto"
                    style={{ width: `${pmPct(pickup_methods_today.auto)}%` }}
                    title={`Scanner: ${pickup_methods_today.auto}`}
                  />
                )}
                {pickup_methods_today.manual > 0 && (
                  <div
                    className="pm-seg pm-manual"
                    style={{ width: `${pmPct(pickup_methods_today.manual)}%` }}
                    title={`Manual: ${pickup_methods_today.manual}`}
                  />
                )}
                {pickup_methods_today.manual_bulk > 0 && (
                  <div
                    className="pm-seg pm-bulk"
                    style={{ width: `${pmPct(pickup_methods_today.manual_bulk)}%` }}
                    title={`Bulk: ${pickup_methods_today.manual_bulk}`}
                  />
                )}
              </div>
              <div className="pm-legend">
                <PmLegendItem variant="auto"   label="Scanner (auto)" count={pickup_methods_today.auto} pct={pmPct(pickup_methods_today.auto)} />
                <PmLegendItem variant="manual" label="Manual"         count={pickup_methods_today.manual} pct={pmPct(pickup_methods_today.manual)} />
                <PmLegendItem variant="bulk"   label="Bulk dismiss"   count={pickup_methods_today.manual_bulk} pct={pmPct(pickup_methods_today.manual_bulk)} />
              </div>
            </>
          ) : (
            <div className="no-data">
              Scanner vs. manual pickup counts appear once dismissals begin.
            </div>
          )}
        </div>
      </div>

      {/* ─── Weekly Heatmap (hour × day-of-week, last 4 weeks) ──── */}
      {Array.isArray(heatmap) && heatmap.length === 7 && (
        <div className="chart-card chart-full">
          <ChartHeader
            title="Weekly Heatmap"
            subtitle="Scan volume by hour and weekday · last 4 weeks"
          />
          <div className="hm-scroll">
            <div className="hm-grid" role="img" aria-label="Scan volume heatmap by weekday and hour">
              <span className="hm-corner" />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={`hdr-${h}`} className="hm-hour">
                  {h % 3 === 0 ? formatHour(h) : ""}
                </span>
              ))}
              {DAY_NAMES.map((name, dow) => (
                <React.Fragment key={`row-${dow}`}>
                  <span className="hm-day">{name}</span>
                  {(heatmap[dow] || []).map((count, h) => {
                    const intensity = maxHeat > 0 ? count / maxHeat : 0;
                    // "You are here" outline — only when the current cell
                    // actually has data.  Outlining an empty cell reads as
                    // a broken/unfilled box rather than a highlight.
                    const isNow = dow === currentDow && h === currentHour && count > 0;
                    return (
                      <div
                        key={`c-${dow}-${h}`}
                        className={`hm-cell${isNow ? " hm-now" : ""}`}
                        style={{ opacity: count === 0 ? 0.06 : 0.15 + 0.85 * intensity }}
                        title={`${name} ${formatHour(h)}: ${count} scan${count === 1 ? "" : "s"}`}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="hm-scale" aria-hidden="true">
            <span className="hm-scale-label">Less</span>
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
              <span key={v} className="hm-scale-cell" style={{ opacity: v === 0 ? 0.06 : 0.15 + 0.85 * v }} />
            ))}
            <span className="hm-scale-label">More</span>
          </div>
        </div>
      )}

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

// Week-over-week delta chip.  Three cases:
//  * both zero        → quiet "no data" note (so we don't shout stability)
//  * prior zero only  → "New" (can't divide by zero meaningfully)
//  * otherwise        → signed % with up/down/flat treatment
function WowDelta({ current, prior, label }) {
  current = current || 0;
  prior = prior || 0;
  if (current === 0 && prior === 0) {
    return <span className="stat-sub">No scans {label}</span>;
  }
  if (prior === 0) {
    return (
      <span className="stat-trend trend-up">
        <I.arrowUp size={12} aria-hidden="true" /> New {label}
      </span>
    );
  }
  const pct = ((current - prior) / prior) * 100;
  const absPct = Math.abs(pct);
  const flat = absPct < 1;
  const cls  = flat ? "trend-stable" : pct > 0 ? "trend-up" : "trend-down";
  const TrendIcon = flat ? I.minus : pct > 0 ? I.arrowUp : I.arrowDown;
  const sign = pct > 0 ? "+" : "";
  return (
    <span className={`stat-trend ${cls}`}>
      <TrendIcon size={12} aria-hidden="true" />
      {flat ? "~0% " : `${sign}${pct.toFixed(0)}% `}
      {label}
    </span>
  );
}

function PmLegendItem({ variant, label, count, pct }) {
  return (
    <div className="pm-legend-item">
      <span className={`pm-dot pm-dot-${variant}`} aria-hidden="true" />
      <span className="pm-legend-label">{label}</span>
      <span className="pm-legend-count">{count}</span>
      <span className="pm-legend-pct">{pct.toFixed(0)}%</span>
    </div>
  );
}

// Format a duration in seconds for human reading at operator-friendly
// granularity: seconds below 1 min, one-decimal minutes below 10 min,
// whole minutes above.
function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 10) return `${m.toFixed(1)}m`;
  return `${Math.round(m)}m`;
}
