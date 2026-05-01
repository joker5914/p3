import { useEffect, useState } from "react";
import "./Website.css";
import "./Trust.css";
import MarketingChrome from "./MarketingChrome";
import BookDemoModal from "./BookDemoModal";
import { BrandIcon } from "./components/Brand";

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

// Mirrors ATTESTATION's drop-in pattern for accessibility conformance.
// `status` flips to "vpat_published" once an Accessibility Conformance
// Report (VPAT 2.5) has been authored against WCAG 2.2 AA and uploaded
// to a public URL.  Read by both the Trust accessibility teaser and
// the standalone /accessibility statement page.
const ACCESSIBILITY = {
  // "in_progress"     → conforming day-to-day but no formal ACR yet.
  // "vpat_published"  → ACR uploaded; vpatUrl populated.
  status: "in_progress",

  // Set once the ACR / VPAT is authored.  e.g. "/accessibility-conformance-report.pdf"
  vpatUrl: null,

  // ISO date when the ACR was last revised — flip alongside vpatUrl.
  vpatRevised: null,

  // Where customers request the ACR pre-publication.
  reportRequestUrl: "mailto:accessibility@dismissal.app?subject=Accessibility%20Conformance%20Report%20request",
};

const SECURITY_CONTACT = "security@dismissal.app";
const ACCESSIBILITY_CONTACT = "accessibility@dismissal.app";

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
  // Marketing pages lock to the light/citrus editorial frame.  Mirrors
  // Website.jsx so the visual identity is continuous across /, /trust,
  // /accessibility, and /portal sign-in.  Saved portal preferences are
  // restored on unmount.
  useEffect(() => {
    const body = document.body;
    const prev = {
      theme:   body.getAttribute("data-theme"),
      palette: body.getAttribute("data-palette"),
      type:    body.getAttribute("data-type"),
      density: body.getAttribute("data-density"),
    };
    body.setAttribute("data-theme",   "light");
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

  // Demo modal — same flow as the marketing home, opened from the
  // shared "Book a demo" CTA in this page's nav.
  const [demoSource, setDemoSource] = useState(null);
  const openDemo = (source) => (e) => { e.preventDefault(); setDemoSource(source); };

  return (
    <div className="web">
      <MarketingChrome />
      <BookDemoModal
        open={demoSource !== null}
        source={demoSource}
        onClose={() => setDemoSource(null)}
      />

      {/* ── Nav (mirrors Website.jsx) ─────────────────────────── */}
      <div className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <BrandIcon className="web-brand-mark" aria-hidden="true" />
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
            <a href="/#cta" className="web-btn web-btn-primary" onClick={openDemo("trust-nav")}>
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
                <li>Federated sign-in via Google or Microsoft for staff; password-based sign-in is also supported.</li>
                <li>Five scoped roles: super-admin, district-admin, school-admin, staff, scanner.</li>
                <li>Permissions are scoped per school within a district and revoke immediately when an account is deactivated.</li>
                <li>Per-tenant isolation enforced at the database layer; permissions ride on the user's authenticated session.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Data protection</h3>
              <ul>
                <li>Encryption in transit (TLS) and at rest, on a managed cloud provider.</li>
                <li>Vehicle records archive nightly to a 1-year long-term store; retention windows are configurable per district.</li>
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
                <li>Hosted on a major managed cloud provider with US data residency.</li>
                <li>Managed identity, hosting, and storage — patched on the provider's cadence.</li>
                <li>Codebase under version control; deploys are versioned and reversible.</li>
                <li>Vehicle recognition happens at the curb itself — no cloud round-trip in the recognition path.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Accessibility conformance (mirrors SOC 2 ATTESTATION) ─── */}
      <section className="trust-section">
        <div className="web-site">
          <span className="web-eyebrow">Accessibility</span>
          <div className="trust-status-card">
            <div className="trust-status-head">
              <span className={`trust-pill trust-pill-${ACCESSIBILITY.status === "vpat_published" ? "good" : "amber"}`}>
                <ShieldIcon />{" "}
                {ACCESSIBILITY.status === "vpat_published"
                  ? "WCAG 2.2 AA · ACR published"
                  : "WCAG 2.2 AA · ACR in progress"}
              </span>
              <a href="/accessibility" className="web-btn web-btn-ghost">
                Read the full statement <ArrowRight />
              </a>
            </div>

            <h2 className="trust-status-headline">
              {ACCESSIBILITY.status === "vpat_published"
                ? "Accessibility Conformance Report — published."
                : "WCAG 2.2 AA today; ACR document in progress."}
            </h2>
            <p className="trust-status-lede">
              The portal conforms to WCAG 2.2 Level AA across every public
              and authenticated route.  Per-deficiency colorblind presets
              (red-green and blue-yellow), a session-timeout warning, full
              keyboard navigation, screen-reader landmarks, and an
              <em> opt-out for motion</em> are shipped today.  The full
              control list and our known limitations live on the
              accessibility statement; the formal ACR / VPAT 2.5 document
              is in progress.
            </p>

            <dl className="trust-status-meta">
              <div>
                <dt>Standard</dt>
                <dd>WCAG 2.2 Level AA (with AAA on the colorblind axis)</dd>
              </div>
              <div>
                <dt>Conformance evidence</dt>
                <dd>Automated accessibility regression suite gates every code change; per-deficiency colorblind presets, reduced-motion support, semantic landmarks, focus management, ARIA live regions</dd>
              </div>
              <div>
                <dt>ACR / VPAT 2.5</dt>
                <dd>{ACCESSIBILITY.vpatUrl ? fmtDate(ACCESSIBILITY.vpatRevised) : "In progress — request via accessibility@"}</dd>
              </div>
              <div>
                <dt>Accessibility contact</dt>
                <dd><a href={`mailto:${ACCESSIBILITY_CONTACT}`}>{ACCESSIBILITY_CONTACT}</a></dd>
              </div>
            </dl>

            <div className="trust-status-actions">
              {ACCESSIBILITY.vpatUrl ? (
                <a href={ACCESSIBILITY.vpatUrl} className="web-btn web-btn-primary"
                   target="_blank" rel="noopener noreferrer">
                  Download the ACR (PDF) <ArrowOut />
                </a>
              ) : (
                <a href={ACCESSIBILITY.reportRequestUrl} className="web-btn web-btn-ghost">
                  Get notified when the ACR is published
                </a>
              )}
              <a href="/accessibility" className="web-btn web-btn-ghost">
                Open accessibility statement <ArrowRight />
              </a>
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
                <p>Vehicle records archive nightly to a 1-year long-term store. Audit log retention defaults to 365 days. Both windows are configurable per district to match the contracts your compliance posture requires.</p>
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
              <span>Category</span>
              <span>Purpose</span>
              <span>Region</span>
            </div>
            <div className="trust-subproc-row">
              <span className="v">Major managed cloud provider</span>
              <span>Application hosting, compute, identity, storage</span>
              <span>US</span>
            </div>
            <div className="trust-subproc-row">
              <span className="v">Federated identity provider (optional)</span>
              <span>Single sign-on for districts that opt in</span>
              <span>US</span>
            </div>
          </div>

          <p className="trust-subproc-note">
            District customers receive the full named subprocessor inventory under DPA, and notice before any new subprocessor is added.
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
                <BrandIcon className="web-brand-mark" aria-hidden="true" />
                <span className="web-brand-word">Dismissal</span>
              </a>
              <p>School pickup, calmly run. Built for districts and independent schools that would like their afternoons back.</p>
            </div>
            <div className="web-ft-col">
              <h6>Product</h6>
              <a href="/#how">How it works</a>
              <a href="/#features">Features</a>
              <a href="/trust">Trust &amp; security</a>
              <a href="/accessibility">Accessibility</a>
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
