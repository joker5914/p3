import React from "react";
import "./LiveCards.css";

/* ── Live cards ──────────────────────────────────────────────────────
   The three product-snapshot cards rendered in the marketing hero.
   Each card mirrors a real surface from the portal so a visitor who
   later signs in sees the same UI vocabulary:

     • Card 1 — front-loop detection  (mirrors PickupCard / arrival)
     • Card 2 — live queue stat       (mirrors Dashboard stat strip)
     • Card 3 — pickup completed      (mirrors audit log entry)

   All copy on this page maps to something the product actually does:
   plate, vehicle, OCR confidence, camera/lane, school chip, signed
   audit hash, sub-second timestamp, etc.

   No third-party deps — pure CSS via LiveCards.css.  The peach/teal
   atmosphere lives here so it stays decoupled from the rest of the
   page background.
   ──────────────────────────────────────────────────────────────── */

const Check = ({ size = 12, stroke = "currentColor", width = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke={stroke} strokeWidth={width}
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const Bell = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

const ChevronUp = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="3"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);

const Dot = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="6" />
  </svg>
);

export default function LiveCards() {
  return (
    <div className="lc-stage" role="img"
         aria-label="Three sample cards from the Dismissal portal: an authorized vehicle detection, a live queue stat, and a signed pickup audit entry.">

      {/* ── Card 1 · Front-loop detection (authorized) ── */}
      <article className="lc-card lc-card-one">
        <header className="lc-head">
          <div className="lc-head-stack">
            <span className="lc-label">
              <span className="lc-pulse" /> Front loop · Live
            </span>
            <span className="lc-school">
              <span className="lc-school-dot" /> Westbrook Elementary
            </span>
          </div>
          <span className="lc-pill lc-pill-authorized">
            <Check /> Authorized · guardian
          </span>
        </header>

        <div className="lc-vehicle">
          <span className="lc-plate">
            <span className="lc-plate-tab">OK</span>
            7VLM&nbsp;482
          </span>
          <div className="lc-vehicle-meta">
            <span className="lc-vehicle-desc">silver honda cr-v</span>
            <span className="lc-vehicle-source">
              cam: north-1 · lane 2
              <span className="lc-conf">98.4%</span>
            </span>
          </div>
        </div>

        <div className="lc-divider" />

        <div className="lc-row">
          <span className="lc-name">Carla R · primary</span>
          <span className="lc-role">
            guardian
            <span className="lc-check-badge">
              <Check size={9} stroke="#1A8657" width={4} />
            </span>
          </span>
        </div>

        <div className="lc-students">
          <span className="lc-students-label">Children</span>
          <span className="lc-student-chip">Maya <span className="lc-grade">4B</span></span>
          <span className="lc-student-chip">Theo <span className="lc-grade">2A</span></span>
        </div>
      </article>

      {/* ── Card 2 · Live queue stat ── */}
      <article className="lc-card lc-card-two">
        <header className="lc-card-two-head">
          <span className="lc-label lc-label-teal">
            <span className="lc-pulse" /> Live queue · Front loop
          </span>
          <span className="lc-school lc-school-strong">
            <span className="lc-school-dot" /> Westbrook
          </span>
        </header>

        <div className="lc-queue-num">
          <span className="lc-queue-big">09</span>
          <span className="lc-queue-delta">
            <ChevronUp /> +2 / min
          </span>
        </div>

        <div className="lc-queue-sub">vehicles in queue</div>
        <div className="lc-queue-since">since 2:45 PM · avg dwell 1m 12s</div>

        <div className="lc-meter" role="progressbar" aria-valuenow={78} aria-valuemin={0} aria-valuemax={100}>
          <div className="lc-meter-fill" />
        </div>

        <div className="lc-meter-row">
          <span><span className="lc-meter-pct">78%</span> authorized</span>
          <span className="lc-pill lc-pill-flag">
            <Dot /> 2 flagged
          </span>
        </div>
      </article>

      {/* ── Card 3 · Pickup audit signed ── */}
      <article className="lc-card lc-card-three">
        <header className="lc-pickup-head">
          <div className="lc-pickup-title">
            <span className="lc-check-icon">
              <Check size={16} stroke="#1A8657" width={2.6} />
            </span>
            <strong>Picked up · audit signed</strong>
          </div>
          <span className="lc-pickup-time">3:18:42.196 PM</span>
        </header>

        <div className="lc-pickup-body">
          <span>2 students</span>
          <span className="lc-bullet">·</span>
          <span className="lc-plate-mini">7VLM 482</span>
          <span className="lc-bullet">·</span>
          <span>staff: J. Reyes</span>
        </div>

        <div className="lc-audit-row">
          <span className="lc-bell"><Bell size={12} /></span>
          <span>signature</span>
          <span className="lc-audit-hash">a8f3·c2e1·90bd</span>
          <span className="lc-audit-spacer" />
          <span className="lc-brand">dismissal.io</span>
        </div>
      </article>
    </div>
  );
}
