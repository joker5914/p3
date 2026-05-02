import { useEffect, useState } from "react";
import "./Website.css";
import "./Trust.css";
import MarketingChrome from "./MarketingChrome";
import BookDemoModal from "./BookDemoModal";
import { BrandWordmark } from "./components/Brand";

/* ── Accessibility statement (/accessibility) ────────────────────────
   Public conformance + posture page mirroring Trust.jsx.  Lives at its
   own route so procurement teams, district disability-services offices,
   and assistive-tech users can link directly.

   The status block is driven by the single ACCESSIBILITY object below
   (mirrors the ATTESTATION pattern on /trust): drop-in editable as the
   ACR / VPAT 2.5 milestones land.
   ────────────────────────────────────────────────────────────────── */

const ACCESSIBILITY = {
  // "in_progress"     → conforming day-to-day but no formal ACR yet.
  // "vpat_published"  → ACR uploaded; vpatUrl populated.
  status: "in_progress",

  // Set once the ACR / VPAT is authored.  e.g. "/accessibility-conformance-report.pdf"
  vpatUrl: null,

  // ISO date when the ACR was last revised — flip alongside vpatUrl.
  vpatRevised: null,

  // Where customers / users request the ACR pre-publication.
  reportRequestUrl: "mailto:accessibility@dismissal.app?subject=Accessibility%20Conformance%20Report%20request",
};

const ACCESSIBILITY_CONTACT = "accessibility@dismissal.app";

// Shared inline icons (kept local rather than importing the portal's
// icon set so the marketing pages have zero portal-side dependencies).
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

export default function Accessibility() {
  // Lock to the light/citrus editorial frame, matching Website.jsx and
  // Trust.jsx so the visual identity is continuous across the public
  // surfaces.
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

  const published = ACCESSIBILITY.status === "vpat_published";

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

      {/* ── Nav (mirrors Website.jsx / Trust.jsx) ───────────────── */}
      <header className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <BrandWordmark className="web-brand-word" aria-hidden="true" />
          </a>
          <nav className="web-nav-links" aria-label="Primary">
            <a href="/#how">How it works</a>
            <a href="/#audiences">For schools</a>
            <a href="/#features">Features</a>
            <a href="/trust">Trust</a>
            <a href="/accessibility" aria-current="page">Accessibility</a>
            <a href="/#pricing">Pricing</a>
          </nav>
          <div className="web-nav-cta">
            <a href="/portal" className="web-signin">Sign in</a>
            <a href="/#cta" className="web-btn web-btn-primary" onClick={openDemo("a11y-nav")}>
              Book a demo <ArrowRight />
            </a>
          </div>
        </div>
      </header>

      <main id="main-content">
      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className="trust-hero" aria-labelledby="a11y-hero-heading">
        <div className="web-site">
          <span className="web-eyebrow">Accessibility at Dismissal</span>
          <h1 id="a11y-hero-heading" className="trust-h1">
            Designed for <em>everyone</em>, in earnest.
          </h1>
          <p className="trust-lede">
            Picking up a child shouldn't depend on perfect vision, perfect
            hearing, or perfect motor control.  This page describes our
            current conformance posture, the controls in place today, and
            the known limitations we are still working on — written the
            way we'd want a vendor's accessibility statement to read.
          </p>
        </div>
      </section>

      {/* ── Conformance status (driven by ACCESSIBILITY) ──────────── */}
      <section className="trust-section trust-status-section" aria-label="Conformance status">
        <div className="web-site">
          <span className="web-eyebrow">Conformance status</span>
          <div className="trust-status-card">
            <div className="trust-status-head">
              <span className={`trust-pill trust-pill-${published ? "good" : "amber"}`}>
                <ShieldIcon />{" "}
                {published ? "WCAG 2.2 AA · ACR published" : "WCAG 2.2 AA · ACR in progress"}
              </span>
              {ACCESSIBILITY.vpatUrl ? (
                <a href={ACCESSIBILITY.vpatUrl} className="web-btn web-btn-ghost"
                   target="_blank" rel="noopener noreferrer">
                  Open the ACR (PDF) <ArrowOut />
                </a>
              ) : null}
            </div>

            <h2 className="trust-status-headline">
              {published
                ? "Accessibility Conformance Report — published."
                : "WCAG 2.2 Level AA across the product today."}
            </h2>
            <p className="trust-status-lede">
              The portal conforms to WCAG 2.2 Level AA across every public
              and authenticated route, with AAA-level controls on the
              colorblind axis (per-deficiency presets, not just an on/off
              toggle).  An automated accessibility regression suite gates
              every code change so accessibility is enforced at merge time,
              not at customer-report time.  The formal ACR / VPAT 2.5
              document is in progress; reach out at
              {" "}<a href={`mailto:${ACCESSIBILITY_CONTACT}`}>{ACCESSIBILITY_CONTACT}</a>
              {" "}if your procurement process requires the document
              before publication.
            </p>

            <dl className="trust-status-meta">
              <div>
                <dt>Standard</dt>
                <dd>WCAG 2.2 Level AA (with AAA on the colorblind axis); also informed by Section 508 and EN 301 549.</dd>
              </div>
              <div>
                <dt>Conformance evidence</dt>
                <dd>Automated accessibility regression suite gating every code change; per-page audit including dark/light × 3 colorblind palettes; documented internally.</dd>
              </div>
              <div>
                <dt>ACR / VPAT 2.5</dt>
                <dd>{published ? fmtDate(ACCESSIBILITY.vpatRevised) : "In progress — request via accessibility@"}</dd>
              </div>
              <div>
                <dt>Last reviewed</dt>
                <dd>April 2026</dd>
              </div>
            </dl>

            <div className="trust-status-actions">
              {published ? (
                <a href={ACCESSIBILITY.vpatUrl} className="web-btn web-btn-primary"
                   target="_blank" rel="noopener noreferrer">
                  Download the ACR (PDF) <ArrowOut />
                </a>
              ) : (
                <a href={ACCESSIBILITY.reportRequestUrl} className="web-btn web-btn-ghost">
                  Get notified when the ACR is published
                </a>
              )}
              <a href={`mailto:${ACCESSIBILITY_CONTACT}`} className="web-btn web-btn-ghost">
                Email accessibility@
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Controls in place today ─────────────────────────────── */}
      <section className="trust-section trust-section-sunken" aria-labelledby="a11y-controls-heading">
        <div className="web-site">
          <span className="web-eyebrow">Controls in place today</span>
          <h2 id="a11y-controls-heading" className="web-section-title">
            What's <em>actually shipped</em>.
          </h2>
          <p className="web-section-sub">
            These are the controls in production — not roadmap.  Where a
            control is partial or known to be limited, it's listed in
            "Known limitations" below.
          </p>

          <div className="trust-controls-grid">
            <div className="trust-control">
              <h3>Colour vision</h3>
              <ul>
                <li>Per-deficiency colour-vision palettes: <strong>Default</strong>, <strong>Red-green</strong> (tuned for protanopia and deuteranopia), and <strong>Blue-yellow</strong> (tuned for tritanopia).</li>
                <li>Status meaning is encoded with both colour <em>and</em> a second channel (icon, label, or pattern) on every screen — colour is never the only signal.</li>
                <li>Palette tokens are theme-aware (light / dark) and palette-aware so contrast stays above 4.5:1 in every combination.</li>
                <li>Palette choice is saved to your account and follows you across devices.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Screen readers &amp; keyboard</h3>
              <ul>
                <li>Semantic landmarks (<code>banner</code>, <code>nav</code>, <code>main</code>, <code>region</code>) on every page.</li>
                <li>First Tab on any page reveals a "Skip to main content" link.</li>
                <li>Visible 2px focus ring on every interactive element via <code>:focus-visible</code>.</li>
                <li>Modal dialogs trap focus, restore on close, and respond to <kbd>Esc</kbd>.</li>
                <li>Tables use <code>scope="col"</code>; icon-only buttons carry <code>aria-label</code>; live regions announce queue arrivals and async results.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Hearing</h3>
              <ul>
                <li>Pickup-arrival audio chime always pairs with a visual toast and an in-page log entry — the same information reaches users who can't hear it.</li>
                <li>One-click mute toggle in the topbar; preference persists across sessions.</li>
                <li>No video content on the portal today; any future video will ship with captions and a transcript.</li>
              </ul>
            </div>

            <div className="trust-control">
              <h3>Motion, time, and motor</h3>
              <ul>
                <li><code>prefers-reduced-motion</code> is honoured — sidebar transitions, modal fades, and loading animations flatten to ~0ms when the OS asks.</li>
                <li>Session-timeout warning surfaces 5 minutes before sign-out with a one-click "Stay signed in" — accidental Esc / click-outside default to staying signed in, never signing out.</li>
                <li>Targets meet WCAG 2.2 minimum size (24×24 CSS px); no drag-only interactions; consistent help and form-field affordances across pages.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Supported assistive technology ──────────────────────── */}
      <section className="trust-section" aria-labelledby="a11y-at-heading">
        <div className="web-site">
          <div className="trust-two-col">
            <div>
              <span className="web-eyebrow">Supported assistive tech</span>
              <h2 id="a11y-at-heading" className="web-section-title">
                Tested with the AT customers <em>actually use</em>.
              </h2>
              <p className="web-section-sub">
                We test against the assistive-tech / browser pairs that
                cover the bulk of our user base.  If you use something
                outside this list and hit a wall, please write us — we
                respond to AT-specific bugs the same week.
              </p>
            </div>

            <ul className="trust-bullets">
              <li>
                <h3>NVDA &amp; JAWS on Chrome / Edge (Windows)</h3>
                <p>Primary test pair.  Every public route plus the Login / signup / reset flows are covered by automated accessibility checks on every code change.</p>
              </li>
              <li>
                <h3>VoiceOver on Safari (macOS / iOS)</h3>
                <p>Spot-checked on each release.  Mobile VoiceOver covered for the guardian flow specifically.</p>
              </li>
              <li>
                <h3>OS-level colour filters (Windows / macOS)</h3>
                <p>Compatible with system filters in addition to the in-app per-deficiency palettes.  Use whichever is more comfortable.</p>
              </li>
              <li>
                <h3>Keyboard-only navigation</h3>
                <p>Every action reachable via Tab / Shift-Tab / Enter / Space / Esc / arrow keys.  No mouse-only interaction is required to operate the product.</p>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Known limitations ───────────────────────────────────── */}
      <section className="trust-section trust-section-sunken" aria-labelledby="a11y-limitations-heading">
        <div className="web-site">
          <span className="web-eyebrow">Known limitations</span>
          <h2 id="a11y-limitations-heading" className="web-section-title">
            What we are <em>still working on</em>.
          </h2>
          <p className="web-section-sub">
            We'd rather list these than hide them.  Each item has an
            owner and a target; updates land on this page as they ship.
          </p>

          <ul className="trust-bullets">
            <li>
              <h3>Automated coverage for authenticated routes</h3>
              <p>The automated suite currently runs on every code change against the Login, signup, password-reset, marketing, and Trust pages.  Authenticated routes are audited per-release until automated coverage extends to them — work in progress.</p>
            </li>
            <li>
              <h3>Brand-logo colours bypass the colour-vision palette</h3>
              <p>The Google and Microsoft glyph fills on the SSO sign-in buttons render in their canonical brand colours rather than the active colour-vision palette.  WCAG 2.2 1.4.11 explicitly exempts logotypes, and both vendors' brand guidelines require the canonical hues.  Each button still carries a visible label and an <code>aria-label</code> so the provider is identifiable regardless.</p>
            </li>
            <li>
              <h3>Accessibility Conformance Report (ACR / VPAT 2.5)</h3>
              <p>The formal document is in progress.  Reach out at <a href={`mailto:${ACCESSIBILITY_CONTACT}`}>{ACCESSIBILITY_CONTACT}</a> if your procurement process requires it before publication; we'll send the working draft under NDA.</p>
            </li>
          </ul>
        </div>
      </section>

      {/* ── Reporting issues ────────────────────────────────────── */}
      <section className="trust-section" aria-labelledby="a11y-reporting-heading">
        <div className="web-site">
          <div className="trust-incident">
            <div>
              <span className="web-eyebrow">Reporting issues</span>
              <h2 id="a11y-reporting-heading" className="web-section-title">
                Hit a wall? <em>Tell us first</em>.
              </h2>
              <p className="web-section-sub">
                Accessibility bugs are bugs.  We answer accessibility mail
                in person, not through a form, and triage issues that block
                a user from completing a pickup as priority.
              </p>
            </div>

            <div className="trust-incident-card">
              <div className="trust-incident-row">
                <span className="l">Accessibility contact</span>
                <a href={`mailto:${ACCESSIBILITY_CONTACT}`} className="trust-incident-val">
                  {ACCESSIBILITY_CONTACT}
                </a>
              </div>
              <div className="trust-incident-row">
                <span className="l">Initial acknowledgement</span>
                <span className="trust-incident-val">Within 1 business day</span>
              </div>
              <div className="trust-incident-row">
                <span className="l">Blocking-bug priority</span>
                <span className="trust-incident-val">Same-week fix or workaround</span>
              </div>
              <div className="trust-incident-row">
                <span className="l">Standards we apply</span>
                <span className="trust-incident-val">WCAG 2.2 AA · Section 508 · EN 301 549</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      </main>

      {/* ── Footer (mirrors Website.jsx / Trust.jsx) ─────────────── */}
      <footer className="web-footer">
        <div className="web-site">
          <div className="web-ft-grid">
            <div className="web-ft-brand">
              <a href="/" className="web-brand" aria-label="Dismissal home">
                <BrandWordmark className="web-brand-word" aria-hidden="true" />
              </a>
              <p>School pickup, calmly run. Built for districts and independent schools that would like their afternoons back.</p>
            </div>
            <div className="web-ft-col">
              <h2>Product</h2>
              <a href="/#how">How it works</a>
              <a href="/#features">Features</a>
              <a href="/trust">Trust &amp; security</a>
              <a href="/accessibility">Accessibility</a>
              <a href="/#pricing">Pricing</a>
            </div>
            <div className="web-ft-col">
              <h2>Schools</h2>
              <a href="/#audiences">For administrators</a>
              <a href="/#audiences">For staff</a>
              <a href="/#audiences">For parents</a>
              <a href="/#">Case studies</a>
            </div>
            <div className="web-ft-col">
              <h2>Company</h2>
              <a href="/#">About</a>
              <a href="/#">Careers</a>
              <a href="/#">Press</a>
              <a href="mailto:hello@dismissal.app">Contact</a>
            </div>
            <nav className="web-ft-col" aria-label="Support">
              <h2>Support</h2>
              <a href="/#pricing">FAQ</a>
              <a href="mailto:accessibility@dismissal.app?subject=Help">Accessibility help</a>
              <a href="mailto:hello@dismissal.app?subject=Help">General help</a>
              <a href="/trust">Trust &amp; security</a>
            </nav>
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
