import { useEffect } from "react";
import "./Website.css";
import "./Trust.css";

/* ── Trust page ──────────────────────────────────────────────────────
   Public trust posture page at /trust.  Sibling to Website.jsx; shares
   the marketing nav/footer style language but lives at its own route
   so customer security teams can link directly.

   The SOC 2 attestation block is driven by the single ATTESTATION
   object below.  Once an audit closes, flip `status` and fill in the
   dates / auditor / trustCenterUrl — the rest of the page reshapes
   itself around the new state without further edits.
   ────────────────────────────────────────────────────────────────── */

// ── Single source of truth for compliance status ─────────────────────
// Drop-in updates: when each milestone is reached, set the matching
// fields and (if needed) bump `status`.  Everything else on the page
// reads from this object.
const ATTESTATION = {
  // "in_progress" → working toward attestation, no badge yet.
  // "type_i"      → SOC 2 Type I report issued (point-in-time).
  // "type_ii"     → SOC 2 Type II report issued (operating effectiveness).
  status: "in_progress",

  // Set once a CPA firm is engaged through Vanta.
  // e.g. "Prescient Assurance, via Vanta"
  auditor: null,

  // ISO date strings (YYYY-MM-DD).  Leave null until each milestone hits.
  observationStarted: null, // first day of evidence collection
  typeIIssued:        null, // Type I report date
  typeIIIssued:       null, // Type II report date

  // Vanta-hosted Trust Center URL (set after Vanta onboarding finishes).
  trustCenterUrl: null,

  // Where customers request the report (NDA-gated email is fine pre-Vanta).
  reportRequestUrl: "mailto:security@dismissal.app?subject=SOC%202%20report%20request",
};

const SECURITY_CONTACT = "security@dismissal.app";

// ── Inline brand-gradient defs (matches Website.jsx) ─────────────────
function GradientDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="brandGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFB86B" />
          <stop offset="0.55" stopColor="#FF9A3D" />
          <stop offset="1" stopColor="#FF5D8F" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function BrandMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M9 8.5h8.2c4.6 0 7.8 3.1 7.8 7.5s-3.2 7.5-7.8 7.5H9V8.5z" fill="#2A1500" />
      <circle cx="11.5" cy="16" r="1.7" fill="url(#brandGrad)" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

function ArrowOut() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
    </svg>
  );
}

// ── Render helpers for the compliance status block ───────────────────
function statusCopy(a) {
  if (a.status === "type_ii") {
    return {
      pillLabel: "Type II · Attested",
      pillTone:  "good",
      headline:  "SOC 2 Type II — attested.",
      lede:      `Our SOC 2 Type II report covers the AICPA Trust Services Criteria for Security, Availability, and Confidentiality. ${a.auditor ? `Audited by ${a.auditor}.` : ""}`.trim(),
    };
  }
  if (a.status === "type_i") {
    return {
      pillLabel: "Type I · Attested",
      pillTone:  "good",
      headline:  "SOC 2 Type I — attested.",
      lede:      `Our SOC 2 Type I report describes the design of our security controls at a point in time. Type II observation is in progress. ${a.auditor ? `Audited by ${a.auditor}.` : ""}`.trim(),
    };
  }
  return {
    pillLabel: "Type II · In progress",
    pillTone:  "amber",
    headline:  "SOC 2 Type II — in progress.",
    lede:      "We are working toward SOC 2 Type II attestation. Until the report is issued, the controls below describe our current security posture and what an auditor will be examining.",
  };
}

function fmtDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
      year:  "numeric",
      month: "long",
      day:   "numeric",
    });
  } catch {
    return iso;
  }
}

export default function Trust() {
  // Marketing pages lock to the dark/citrus editorial frame regardless of
  // the visitor's saved portal preference.  Mirrors Website.jsx so the
  // visual identity is continuous across /, /trust, and /portal sign-in.
  useEffect(() => {
    const body = document.body;
    const prev = {
      theme:   body.getAttribute("data-theme"),
      palette: body.getAttribute("data-palette"),
      type:    body.getAttribute("data-type"),
      density: body.getAttribute("data-density"),
    };
    body.setAttribute("data-theme",   "dark");
    body.setAttribute("data-palette", "citrus");
    body.setAttribute("data-type",    "geist");
    body.setAttribute("data-density", "comfortable");
    return () => {
      if (prev.theme)   body.setAttribute("data-theme",   prev.theme);
      if (prev.palette) body.setAttribute("data-palette", prev.palette);
      if (prev.type)    body.setAttribute("data-type",    prev.type);
      if (prev.density) body.setAttribute("data-density", prev.density);
    };
  }, []);

  const sc = statusCopy(ATTESTATION);

  return (
    <div className="web">
      <GradientDefs />

      {/* ── Nav (mirrors Website.jsx) ─────────────────────────── */}
      <div className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <span className="web-brand-mark"><BrandMark /></span>
            <span className="web-brand-word">Dismissal</span>
          </a>
          <nav className="web-nav-links">
            <a href="/#how">How it works</a>
            <a href="/#audiences">For schools</a>
            <a href="/#features">Features</a>
            <a href="/trust" aria-current="page">Trust</a>
            <a href="/#pricing">Pricing</a>
          </nav>
          <div className="web-nav-cta">
            <a href="/portal" className="web-signin">Sign in</a>
            <a href="/#cta" className="web-btn web-btn-primary">
              Book a demo <ArrowRight />
            </a>
          </div>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <header className="trust-hero">
        <div className="web-site">
          <span className="web-eyebrow">Trust at Dismissal</span>
          <h1 className="trust-h1">
            Earned, <em>not claimed</em>.
          </h1>
          <p className="trust-lede">
            A child's release is the most consequential transaction a school
            makes each day. This page describes — honestly — where we are on
            compliance, what controls are in place today, and how to reach us
            if something feels off.
          </p>
        </div>
      </header>

      {/* ── Compliance status (driven by ATTESTATION) ─────────────── */}
      <section className="trust-section trust-status-section">
        <div className="web-site">
          <span className="web-eyebrow">Compliance status</span>
          <div className="trust-status-card">
            <div className="trust-status-head">
              <span className={`trust-pill trust-pill-${sc.pillTone}`}>
                <ShieldIcon /> {sc.pillLabel}
              </span>
              {ATTESTATION.trustCenterUrl ? (
                <a href={ATTESTATION.trustCenterUrl} className="web-btn web-btn-ghost"
                   target="_blank" rel="noopener noreferrer">
                  Open Trust Center <ArrowOut />
                </a>
              ) : null}
            </div>

            <h2 className="trust-status-headline">{sc.headline}</h2>
            <p className="trust-status-lede">{sc.lede}</p>

            <dl className="trust-status-meta">
              <div>
                <dt>Framework</dt>
                <dd>SOC 2 (AICPA TSC: Security, Availability, Confidentiality)</dd>
              </div>
              <div>
                <dt>Auditor</dt>
                <dd>{ATTESTATION.auditor || "To be engaged via Vanta"}</dd>
              </div>
              <div>
                <dt>Observation start</dt>
                <dd>{fmtDate(ATTESTATION.observationStarted) || "Not yet started"}</dd>
              </div>
              <div>
                <dt>Type I report</dt>
                <dd>{fmtDate(ATTESTATION.typeIIssued) || "Pending"}</dd>
              </div>
              <div>
                <dt>Type II report</dt>
                <dd>{fmtDate(ATTESTATION.typeIIIssued) || "Pending"}</dd>
              </div>
            </dl>

            <div className="trust-status-actions">
              {ATTESTATION.status === "in_progress" ? (
                <a href={ATTESTATION.reportRequestUrl} className="web-btn web-btn-ghost">
                  Get notified when the report is issued
                </a>
              ) : (
                <a href={ATTESTATION.reportRequestUrl} className="web-btn web-btn-primary">
                  Request the report (NDA) <ArrowRight />
                </a>
              )}
              <a href={`mailto:${SECURITY_CONTACT}`} className="web-btn web-btn-ghost">
                Email security@
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Controls in place today ─────────────────────────────── */}
      <section className="trust-section trust-section-sunken">
        <div className="web-site">
          <span className="web-eyebrow">Controls in place today</span>
          <h2 className="web-section-title">
            What an auditor will be <em>looking at</em>.
          </h2>
          <p className="web-section-sub">
            These are the controls that already exist in production, not
            promises. Where a control is partial or planned, we say so.
          </p>

          <div className="trust-controls-grid">
            <div className="trust-control">
              <h3>Identity &amp; access</h3>
              <ul>
                <li>Federated sign-in via Google or Microsoft (Entra) for staff; password-based sign-in is also supported.</li>
                <li>Five scoped roles: super-admin, district-admin, school-admin, staff, scanner.</li>
                <li>Permissions are scoped per school within a district and revoke immediately when an account is deactivated.</li>
                <li>Per-tenant isolation enforced at the Firestore security-rules layer via a school_id custom claim on each Auth token.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Data protection</h3>
              <ul>
                <li>Encryption in transit (TLS) and at rest (managed by Google Cloud / Firestore).</li>
                <li>Plate scans archive nightly to a 1-year cold store; retention windows are configurable per district.</li>
                <li>Tenant data segregated by district / school identifier on every query.</li>
                <li>Customer roster data is not sold, shared with third parties, or used to train models.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Auditability</h3>
              <ul>
                <li>Every pickup release is recorded with the acting staff member, vehicle, and timestamp.</li>
                <li>Authentication events (sign-in, session start) recorded in the audit log.</li>
                <li>Roster, permission, and configuration changes captured in the audit log.</li>
                <li>Audit log retention defaults to 365 days, configurable per district, and is exportable for review.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Infrastructure</h3>
              <ul>
                <li>Hosted on Google Cloud / Firebase with US data residency.</li>
                <li>Managed identity, hosting, and storage — patched on the provider's cadence.</li>
                <li>Codebase versioned in Git; deploys are versioned and reversible.</li>
                <li>License-plate recognition runs on-device at the curb (Hailo-8L NPU); no cloud OCR round-trip.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Data handling (FERPA / COPPA posture) ─────────────────── */}
      <section className="trust-section">
        <div className="web-site">
          <div className="trust-two-col">
            <div>
              <span className="web-eyebrow">Data handling</span>
              <h2 className="web-section-title">
                Built to <em>support</em> FERPA &amp; COPPA — not to claim them.
              </h2>
              <p className="web-section-sub">
                FERPA and COPPA bind the school district, not the vendor.
                Our job is to give districts the contractual terms, data
                handling, and parental-consent posture they need to comply.
              </p>
            </div>

            <ul className="trust-bullets">
              <li>
                <h4>Education record handling</h4>
                <p>We process student data only as a school official under FERPA's exception, on the district's behalf, for the legitimate educational interest of student dismissal.</p>
              </li>
              <li>
                <h4>Parental consent (COPPA)</h4>
                <p>Districts collect and document parental consent for under-13 students. We support consent records and revocation through the guardian roster.</p>
              </li>
              <li>
                <h4>Retention &amp; deletion</h4>
                <p>Plate scans archive nightly to a 1-year cold store. Audit log retention defaults to 365 days. Both windows are configurable per district to match the contracts your compliance posture requires.</p>
              </li>
              <li>
                <h4>Data Processing Addendum</h4>
                <p>We sign DPAs with district customers. Sample DPA available on request.</p>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Subprocessors ─────────────────────────────────────────── */}
      <section className="trust-section trust-section-sunken">
        <div className="web-site">
          <span className="web-eyebrow">Subprocessors</span>
          <h2 className="web-section-title">
            The vendors we trust with <em>your data</em>.
          </h2>
          <p className="web-section-sub">
            A short list, on purpose. The full audited inventory is published
            as part of SOC 2 Type II evidence.
          </p>

          <div className="trust-subproc">
            <div className="trust-subproc-head">
              <span>Vendor</span>
              <span>Purpose</span>
              <span>Region</span>
            </div>
            <div className="trust-subproc-row">
              <span className="v">Google Cloud Platform</span>
              <span>Application hosting, compute, storage</span>
              <span>US</span>
            </div>
            <div className="trust-subproc-row">
              <span className="v">Firebase</span>
              <span>Authentication, realtime database, file storage</span>
              <span>US</span>
            </div>
            <div className="trust-subproc-row">
              <span className="v">Microsoft Entra (optional)</span>
              <span>Federated sign-in for districts that opt in</span>
              <span>US</span>
            </div>
          </div>

          <p className="trust-subproc-note">
            District customers receive notice before any new subprocessor is added.
          </p>
        </div>
      </section>

      {/* ── Incident response ─────────────────────────────────────── */}
      <section className="trust-section">
        <div className="web-site">
          <div className="trust-incident">
            <div>
              <span className="web-eyebrow">Incident response</span>
              <h2 className="web-section-title">
                See something? <em>Tell us first</em>.
              </h2>
              <p className="web-section-sub">
                We answer security mail in person, not through a form. If
                you've found a vulnerability or suspect a misuse of the
                service, write directly — we'll acknowledge within one
                business day and work it from there.
              </p>
            </div>

            <div className="trust-incident-card">
              <div className="trust-incident-row">
                <span className="l">Security contact</span>
                <a href={`mailto:${SECURITY_CONTACT}`} className="trust-incident-val">
                  {SECURITY_CONTACT}
                </a>
              </div>
              <div className="trust-incident-row">
                <span className="l">Initial acknowledgement</span>
                <span className="trust-incident-val">Within 1 business day</span>
              </div>
              <div className="trust-incident-row">
                <span className="l">District customer notification</span>
                <span className="trust-incident-val">Without undue delay, per DPA</span>
              </div>
              <div className="trust-incident-row">
                <span className="l">Responsible disclosure</span>
                <span className="trust-incident-val">Welcomed; safe-harbor for good-faith research</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer (mirrors Website.jsx) ──────────────────────────── */}
      <footer className="web-footer">
        <div className="web-site">
          <div className="web-ft-grid">
            <div className="web-ft-brand">
              <a href="/" className="web-brand">
                <span className="web-brand-mark"><BrandMark /></span>
                <span className="web-brand-word">Dismissal</span>
              </a>
              <p>School pickup, calmly run. Built for districts and independent schools that would like their afternoons back.</p>
            </div>
            <div className="web-ft-col">
              <h6>Product</h6>
              <a href="/#how">How it works</a>
              <a href="/#features">Features</a>
              <a href="/trust">Trust &amp; security</a>
              <a href="/#pricing">Pricing</a>
            </div>
            <div className="web-ft-col">
              <h6>Schools</h6>
              <a href="/#audiences">For administrators</a>
              <a href="/#audiences">For staff</a>
              <a href="/#audiences">For parents</a>
              <a href="/#">Case studies</a>
            </div>
            <div className="web-ft-col">
              <h6>Company</h6>
              <a href="/#">About</a>
              <a href="/#">Careers</a>
              <a href="/#">Press</a>
              <a href="mailto:hello@dismissal.app">Contact</a>
            </div>
          </div>

          <div className="web-ft-bottom">
            <div>© 2026 Dismissal, Inc. · All rights reserved.</div>
            <div className="dots"><span className="dot" /> All systems normal</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
