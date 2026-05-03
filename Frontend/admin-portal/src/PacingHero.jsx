import React, { useEffect, useRef, useState } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./PacingHero.css";

/* ── PacingHero — Dashboard countdown + pacing indicator (issue #69) ───
   Hero card sitting above the StatStrip on the Dashboard.  Pulls
   /api/v1/dashboard/pacing every 15 s; keeps a local 1 s wall-clock
   tick going for the countdown so digits stay smooth without forcing
   a network round trip per second.

   Variants (driven by payload.is_open + payload.status):
     • Closed today      — eyebrow "No dismissal today" + next-open chip
     • Not yet started   — countdown to start, no pacing math yet
     • Warming up        — first 3 min of dismissal; status pill is muted
     • On pace           — green pill; track fill at/above the needle
     • Behind            — amber pill; track fill behind the needle
     • Critical          — red pulse pill; "throughput tip" inline once
     • Completed         — green; "Cleared at HH:MM"
     • Overrun           — red; "X cars remaining past dismissal"

   Throughput Mode is a toggle that lifts up to Dashboard.jsx; we just
   render the switch chip and call onToggleThroughputMode.
   ────────────────────────────────────────────────────────────────────── */

const POLL_INTERVAL_MS = 15_000;

function pad(n, w = 2) {
  return String(Math.max(0, Math.floor(n))).padStart(w, "0");
}

// Format remaining-ms as HH:MM:SS or MM:SS depending on size.
function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function formatClockTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatWeekday(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
}

const STATUS_LABELS = {
  on_pace:    { label: "On pace",      tone: "good" },
  behind:     { label: "Behind",       tone: "warn" },
  critical:   { label: "Critical",     tone: "bad"  },
  warming_up: { label: "Warming up",   tone: "neutral" },
  not_started:{ label: "Starting soon",tone: "neutral" },
  completed:  { label: "Cleared",      tone: "good" },
  overrun:    { label: "Overrun",      tone: "bad"  },
};

const CLOSED_REASON_COPY = {
  closed_holiday: "Holiday",
  closed_weekend: "Weekend",
  closed_manual:  "Closed",
};


export default function PacingHero({
  token,
  schoolId,
  throughputMode = false,
  onToggleThroughputMode,
}) {
  const [data, setData] = useState(null);
  const [now, setNow]   = useState(() => Date.now());
  const [tipDismissed, setTipDismissed] = useState(false);
  const fetchRef = useRef(null);

  // -- 15 s pacing poll ----------------------------------------------------
  // Identical pattern to the scanner-status poll at Dashboard.jsx:271-285.
  // Failed polls keep the last good payload so a single Firestore blip
  // doesn't make the hero flap to a "loading" state.
  useEffect(() => {
    if (!token || !schoolId) return;
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await createApiClient(token, schoolId).get("/api/v1/dashboard/pacing");
        if (!cancelled) setData(res.data);
      } catch {
        /* silent — hero shouldn't flap on a single failed poll */
      }
    };
    fetchRef.current = fetch;
    fetch();
    const id = setInterval(fetch, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); fetchRef.current = null; };
  }, [token, schoolId]);

  // -- 1 s wall-clock tick (only when there's something to count down to) --
  const ticking = !!data && (data.is_open === true);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking, data?.window_start, data?.window_end]);

  // -- visibilitychange recovery -------------------------------------------
  // Backgrounded tabs throttle setInterval to ~1/min; force a re-sync on
  // return so the countdown jumps to current and we re-poll fresh data.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      if (fetchRef.current) fetchRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ── Render ──
  if (!data) {
    return (
      <section className="pacing-card pacing-card-skeleton" aria-label="Dismissal pacing">
        <div className="pacing-skeleton-line" aria-hidden="true" />
        <div className="pacing-skeleton-line pacing-skeleton-line-sm" aria-hidden="true" />
      </section>
    );
  }

  if (!data.is_open) {
    return <ClosedHero data={data} />;
  }
  if (data.status === "not_started") {
    return (
      <NotStartedHero
        data={data}
        now={now}
        throughputMode={throughputMode}
        onToggleThroughputMode={onToggleThroughputMode}
      />
    );
  }
  return (
    <ActiveHero
      data={data}
      now={now}
      throughputMode={throughputMode}
      onToggleThroughputMode={onToggleThroughputMode}
      tipDismissed={tipDismissed}
      onDismissTip={() => setTipDismissed(true)}
    />
  );
}


// ==========================================================================
// Closed today
// ==========================================================================

function ClosedHero({ data }) {
  const reasonCopy = CLOSED_REASON_COPY[data.reason] || "Closed";
  const next = data.next_open;
  return (
    <section className="pacing-card pacing-card-closed" aria-label="No dismissal today">
      <header className="pacing-head">
        <span className="pacing-eyebrow">{reasonCopy}</span>
        <span className="pacing-status pacing-status-neutral">No dismissal</span>
      </header>
      <div className="pacing-empty">
        <div className="pacing-empty-headline">
          {data.label || "No dismissal scheduled today"}
        </div>
        <p className="pacing-empty-msg">
          {next
            ? <>Next dismissal: <strong>{formatWeekday(next.window_start)}</strong> at <strong>{formatClockTime(next.window_start)}</strong>{next.label ? ` · ${next.label}` : ""}.</>
            : <>No dismissal scheduled in the next two weeks. Check the Schedule page if that's not right.</>}
        </p>
      </div>
    </section>
  );
}


// ==========================================================================
// Not yet started — countdown to window_start, no pacing math
// ==========================================================================

function NotStartedHero({ data, now, throughputMode, onToggleThroughputMode }) {
  const startMs = new Date(data.window_start).getTime();
  const remainingMs = Math.max(0, startMs - now);
  return (
    <section className="pacing-card pacing-card-prelude" aria-label="Dismissal starts soon">
      <header className="pacing-head">
        <span className="pacing-eyebrow">Dismissal · {formatClockTime(data.window_start)}</span>
        <span className="pacing-status pacing-status-neutral">Starting soon</span>
        <ThroughputToggle on={throughputMode} onToggle={onToggleThroughputMode} />
      </header>
      <div className="pacing-body pacing-body-prelude">
        <div className="pacing-col pacing-countdown-col">
          <span className="pacing-countdown-label">Starts in</span>
          <div className="pacing-countdown" aria-live="polite">
            {formatRemaining(remainingMs)}
          </div>
          <span className="pacing-countdown-foot">
            {formatClockTime(data.window_start)} → {formatClockTime(data.window_end)}
            {data.label ? ` · ${data.label}` : ""}
          </span>
        </div>
        <div className="pacing-col pacing-prelude-msg">
          <I.bolt size={18} aria-hidden="true" />
          <p>
            {data.queue_depth > 0
              ? <>Already <strong>{data.queue_depth}</strong> {data.queue_depth === 1 ? "vehicle" : "vehicles"} waiting before the bell.</>
              : <>Lot is empty. Pacing data will appear once the dismissal window opens.</>}
          </p>
        </div>
      </div>
    </section>
  );
}


// ==========================================================================
// Active dismissal — full hero
// ==========================================================================

function ActiveHero({
  data, now, throughputMode, onToggleThroughputMode,
  tipDismissed, onDismissTip,
}) {
  const status = STATUS_LABELS[data.status] || STATUS_LABELS.warming_up;
  const endMs  = new Date(data.window_end).getTime();
  const remainingMs = endMs - now;

  // Big number swap: countdown when window is live, "Cleared at HH:MM" when
  // completed, "X cars remaining" when overrun.
  let bigNumber, bigLabel, bigFoot;
  if (data.status === "completed") {
    bigNumber = formatClockTime(data.window_end);
    bigLabel  = "Cleared at";
    bigFoot   = `Window closed at ${formatClockTime(data.window_end)}`;
  } else if (data.status === "overrun") {
    bigNumber = String(data.queue_depth);
    bigLabel  = data.queue_depth === 1 ? "Car remaining" : "Cars remaining";
    bigFoot   = `${data.overrun_minutes ? Math.ceil(data.overrun_minutes) : 0} min past dismissal`;
  } else {
    bigNumber = formatRemaining(remainingMs);
    bigLabel  = "Remaining";
    const projected = data.projected_clear_at;
    bigFoot   = projected
      ? `Projected clear · ${formatClockTime(projected)}`
      : "Projected clear · waiting on more pickups";
  }

  // Throughput delta vs DOW baseline
  let throughputDelta = null;
  if (data.dow_baseline_per_min && data.dow_baseline_per_min > 0) {
    const pct = ((data.current_throughput_per_min - data.dow_baseline_per_min)
      / data.dow_baseline_per_min) * 100;
    throughputDelta = Math.round(pct);
  }

  // Pacing track positions (clamped 0..100)
  const fillPct   = Math.max(0, Math.min(100, data.percent_complete));
  const needlePct = Math.max(0, Math.min(100, data.percent_time_elapsed));

  // Inline tip — show once when behind/critical and Throughput Mode is off
  const showTip = !throughputMode
    && !tipDismissed
    && (data.status === "behind" || data.status === "critical");

  return (
    <section
      className={`pacing-card pacing-card-${status.tone} pacing-status-pulse-${data.status}`}
      aria-label="Dismissal pacing"
    >
      <header className="pacing-head">
        <span className="pacing-eyebrow">
          Dismissal · {formatClockTime(data.window_start)} → {formatClockTime(data.window_end)}
          {data.label ? ` · ${data.label}` : ""}
        </span>
        <span className={`pacing-status pacing-status-${status.tone}`}>
          <span className="pacing-status-dot" aria-hidden="true" />
          {status.label}
        </span>
        <ThroughputToggle on={throughputMode} onToggle={onToggleThroughputMode} />
      </header>

      <div className="pacing-body">
        {/* COL 1 — countdown / clear time / overrun count */}
        <div className="pacing-col pacing-countdown-col">
          <span className="pacing-countdown-label">{bigLabel}</span>
          <div
            className="pacing-countdown"
            aria-live="polite"
            aria-atomic="true"
          >
            {bigNumber}
          </div>
          <span className="pacing-countdown-foot">{bigFoot}</span>
        </div>

        {/* COL 2 — pacing track */}
        <div className="pacing-col pacing-track-col">
          <div className="pacing-track-head">
            <span className="pacing-track-title">Progress vs time</span>
            <span className="pacing-track-meta t-num">
              {data.percent_complete.toFixed(0)}% done · {data.percent_time_elapsed.toFixed(0)}% elapsed
            </span>
          </div>
          <div className="pacing-track" role="progressbar"
               aria-valuenow={Math.round(fillPct)}
               aria-valuemin={0} aria-valuemax={100}
               aria-label="Percent complete vs percent time elapsed">
            <div className="pacing-track-fill" style={{ width: `${fillPct}%` }} />
            <div className="pacing-track-needle" style={{ left: `${needlePct}%` }} aria-hidden="true">
              <span className="pacing-needle-cap pacing-needle-cap-top" />
              <span className="pacing-needle-cap pacing-needle-cap-bot" />
            </div>
          </div>
          <div className="pacing-track-foot">
            {data.queue_depth > 0
              ? <span><strong>{data.queue_depth}</strong> in queue</span>
              : <span>Queue empty</span>}
            {data.pacing_delta != null && data.status !== "warming_up" && (
              <span className={`pacing-delta pacing-delta-${data.pacing_delta >= 0 ? "ahead" : "behind"}`}>
                {data.pacing_delta >= 0
                  ? <><I.arrowUp size={11} stroke={2.4} /> Ahead by {Math.abs(data.pacing_delta).toFixed(0)} pts</>
                  : <><I.arrowDown size={11} stroke={2.4} /> Behind by {Math.abs(data.pacing_delta).toFixed(0)} pts</>}
              </span>
            )}
          </div>
          {showTip && (
            <div className="pacing-tip" role="note">
              <I.bolt size={11} stroke={2.4} aria-hidden="true" />
              <span>Tip: turn on Throughput Mode to shrink cards and surface the bulk-pickup button.</span>
              <button
                type="button"
                className="pacing-tip-dismiss"
                onClick={onDismissTip}
                aria-label="Dismiss tip"
              >
                <I.x size={11} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* COL 3 — throughput */}
        <div className="pacing-col pacing-throughput-col">
          <span className="pacing-throughput-label">Throughput</span>
          <div className="pacing-throughput-num">
            <span className="pacing-throughput-value">
              {data.current_throughput_per_min.toFixed(1)}
            </span>
            <span className="pacing-throughput-unit">/min</span>
          </div>
          {data.dow_baseline_per_min != null ? (
            <div className="pacing-throughput-foot">
              <span className="pacing-throughput-baseline t-num">
                vs {data.dow_baseline_per_min.toFixed(1)}/min avg
              </span>
              {throughputDelta != null && (
                <span className={`pacing-delta pacing-delta-${throughputDelta >= 0 ? "ahead" : "behind"}`}>
                  {throughputDelta >= 0 ? "+" : ""}{throughputDelta}%
                </span>
              )}
            </div>
          ) : (
            <span className="pacing-throughput-foot pacing-throughput-foot-quiet">
              Building baseline…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}


function ThroughputToggle({ on, onToggle }) {
  if (!onToggle) return null;
  return (
    <button
      type="button"
      className={`pacing-throughput-toggle${on ? " pacing-throughput-toggle-on" : ""}`}
      onClick={() => onToggle(!on)}
      aria-pressed={on}
      title={on ? "Throughput Mode is on — exit to standard layout" : "Compact cards + pinned bulk-pickup"}
    >
      <I.bolt size={12} stroke={2.2} aria-hidden="true" />
      <span>Throughput Mode</span>
      <span className={`pacing-throughput-switch${on ? " pacing-throughput-switch-on" : ""}`} aria-hidden="true">
        <span className="pacing-throughput-knob" />
      </span>
    </button>
  );
}
