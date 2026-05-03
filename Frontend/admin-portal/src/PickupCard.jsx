import React from "react";
import { I } from "./components/icons";
import PersonAvatar from "./PersonAvatar";

/* ── PickupCard ─────────────────────────────────────────
   Photo-led pickup card.  Visual structure (top → bottom):

     1. Lane bar           — 4px gradient pill on the left edge,
                             status-keyed (green/red/amber/neutral).
     2. Eyebrow row        — status pill (icon + tracked uppercase
                             label) + monospace position chip.
     3. 16:9 photo block   — LPR camera capture with overlays:
                             plate chip (bottom-left), timestamp
                             (bottom-right). Falls back to a tinted
                             gradient when no photo is available.
     4. Vehicle line       — display font, 16px / 600.
     5. Person row         — avatar + name + tracked uppercase role,
                             separated from the body by a 1px top
                             border.
     6. Action row         — primary CTA (gradient green for `auth`,
                             neutral "Override · Pick up" for others)
                             + ghost more-menu button.

   `state` prop maps the existing authorization_status enum to the
   four visual treatments the design defines:
     authorized / authorized_guardian → auth
     unauthorized                     → unauth
     unregistered                     → unreg
     unrecognized                     → unrec
   The mapping happens at the call site (Dashboard.jsx).
   ────────────────────────────────────────────────────── */

const STATE_META = {
  auth:   { label: "Authorized guardian", icon: I.shield,   ctaLabel: "Mark picked up" },
  unauth: { label: "Unauthorized person", icon: I.alert,    ctaLabel: "Override · Pick up" },
  unreg:  { label: "Unregistered driver", icon: I.question, ctaLabel: "Override · Pick up" },
  unrec:  { label: "Unrecognized plate",  icon: I.question, ctaLabel: "Override · Pick up" },
};

export default function PickupCard({
  pos,
  vehicle,
  plate,
  time,
  name,
  role,
  state = "auth",
  photo,
  guardianPhotoUrl = null,
  students = null,
  onPickup,
  onMore,
  pending = false,
  ariaLabel,
  // Throughput Mode (issue #69) — flatten paddings, drop the photo block,
  // and tighten the row so two card-widths squeeze into one.  Driven by
  // the parent toggle on Dashboard.jsx; not part of `state` because the
  // density is orthogonal to the authorisation classification.
  compact = false,
}) {
  // Normalise: backend returns either a single string, a list, or null.
  // Empty strings inside the list are filtered so encrypted-but-undecryptable
  // entries don't render as floating commas.
  const studentList = Array.isArray(students)
    ? students.filter((s) => typeof s === "string" && s.trim())
    : (typeof students === "string" && students.trim() ? [students.trim()] : []);
  const meta = STATE_META[state] || STATE_META.auth;
  const StatusIcon = meta.icon;

  return (
    <article
      className={`pickup-card pickup-card-${state}${compact ? " pickup-card-compact" : ""}`}
      role="article"
      aria-label={ariaLabel}
    >
      {/* Lane bar — gradient pill on the inside-left edge. */}
      <span className="pickup-lane" aria-hidden="true" />

      <header className="pickup-eyebrow-row">
        <span className="pickup-status-pill t-eyebrow">
          <StatusIcon size={11} stroke={2.2} />
          <span>{meta.label}</span>
        </span>
        <span className="pickup-pos-chip t-num" aria-label={`Position ${pos}`}>
          #{String(pos).padStart(2, "0")}
        </span>
      </header>

      <div className="pickup-photo">
        {photo ? (
          <img
            className="pickup-photo-img"
            src={photo}
            alt={`License plate scan: ${plate || "no plate detected"} at ${time || ""}`}
            loading="lazy"
          />
        ) : (
          <div className="pickup-photo-placeholder" aria-hidden="true" />
        )}
        <div className="pickup-photo-shade" aria-hidden="true" />
        {plate && <span className="pickup-photo-plate t-plate">{plate}</span>}
        {time && <span className="pickup-photo-time t-num">{time}</span>}
      </div>

      <div className="pickup-vehicle">{vehicle || "Unknown vehicle"}</div>

      <div className="pickup-person">
        {guardianPhotoUrl || name ? (
          <PersonAvatar name={name || "?"} photoUrl={guardianPhotoUrl} size={32} />
        ) : (
          <div className="pickup-person-avatar-placeholder" aria-hidden="true">?</div>
        )}
        <div className="pickup-person-info">
          <span className="pickup-person-name">{name || "Unknown driver"}</span>
          {role && <span className="pickup-person-role t-eyebrow">{role}</span>}
        </div>
      </div>

      {/* Children to release.  Only renders for cards that actually
          have a student linkage — unrec / unregistered cards stay
          quiet so the missing list doesn't read as "no children
          assigned" (which would be misleading). */}
      {studentList.length > 0 && (
        <div className="pickup-students">
          <span className="pickup-students-label t-eyebrow">
            Release to driver
          </span>
          <ul className="pickup-students-list">
            {studentList.map((s) => (
              <li key={s} className="pickup-students-item">
                <I.user size={11} stroke={2.2} aria-hidden="true" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pickup-actions">
        <button
          type="button"
          className={`pickup-cta pickup-cta-${state}`}
          onClick={onPickup}
          disabled={pending}
          aria-label={`${meta.ctaLabel} — ${name || "this vehicle"}`}
        >
          <I.checkCircle size={14} stroke={2.2} aria-hidden="true" />
          <span>{pending ? "Marking…" : meta.ctaLabel}</span>
        </button>
        {onMore && (
          <button
            type="button"
            className="pickup-more"
            onClick={onMore}
            aria-label="More options"
            title="More"
          >
            <I.more size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}
