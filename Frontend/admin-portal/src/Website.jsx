import { useEffect, useMemo, useState } from "react";
import "./Website.css";
import MarketingChrome, { useScrollSpy } from "./MarketingChrome";
import BookDemoModal from "./BookDemoModal";
import { BrandWordmark } from "./components/Brand";

// In-page section ids the top nav anchors to.  Used by the scrollspy
// hook to underline the matching link as the reader scrolls.
const NAV_SECTION_IDS = ["how", "audiences", "features", "pricing"];

/* ── Marketing site ──────────────────────────────────────────────────
   The front-facing landing page that lives at "/".  All authenticated
   product flows continue to live under /portal where Login → the
   existing app shell takes over — guardians, staff, and admins all
   sign in through the same portal link.

   Site is dark-first / citrus on purpose — even if the user's portal
   theme is light, marketing always reads in the editorial dark frame.
   Uses tokens (no hard-coded colors) so the gradient/headline accents
   pick up the brand palette.

   Copy posture: every claim on this page maps to something the product
   actually does.  Mock UI cards mirror real components in /portal —
   PickupCard, the Dashboard stat strip, the audit log entry — so what
   visitors see in marketing is what they'll see when they sign in.
   ────────────────────────────────────────────────────────────────── */

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

function CrossIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}

export default function Website() {
  // Marketing locks to light/citrus so the public site, the login page,
  // and the authenticated portal all read as one continuous identity.
  // Saved portal preferences (e.g. a returning admin who picked dark)
  // are restored on unmount so signing in still lands them on the
  // theme they chose.
  useEffect(() => {
    const body = document.body;
    const prev = {
      theme: body.getAttribute("data-theme"),
      palette: body.getAttribute("data-palette"),
      type: body.getAttribute("data-type"),
      density: body.getAttribute("data-density"),
    };
    body.setAttribute("data-theme", "light");
    body.setAttribute("data-palette", "citrus");
    body.setAttribute("data-type", "geist");
    body.setAttribute("data-density", "comfortable");
    return () => {
      if (prev.theme) body.setAttribute("data-theme", prev.theme);
      if (prev.palette) body.setAttribute("data-palette", prev.palette);
      if (prev.type) body.setAttribute("data-type", prev.type);
      if (prev.density) body.setAttribute("data-density", prev.density);
    };
  }, []);

  // Scrollspy: which in-page section the reader is currently in.  Used
  // to underline the matching nav link.  Memoized so the hook's effect
  // doesn't re-subscribe every render.
  const sectionIds = useMemo(() => NAV_SECTION_IDS, []);
  const activeSection = useScrollSpy(sectionIds);

  // Demo modal — open from any "Book a demo" CTA.  `source` is stored
  // alongside the request so we can later see which CTA people use most.
  const [demoSource, setDemoSource] = useState(null);
  const openDemo = (source) => (e) => {
    e.preventDefault();
    setDemoSource(source);
  };
  const closeDemo = () => setDemoSource(null);

  return (
    <div className="web">
      <MarketingChrome />

      <a href="#main-content" className="web-skip-link">
        Skip to main content
      </a>

      {/* ── Nav ─────────────────────────────────────── */}
      <header className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <BrandWordmark className="web-brand-word" aria-hidden="true" />
          </a>
          <nav className="web-nav-links" aria-label="Primary">
            <a href="#how"       data-active={activeSection === "how"       ? "true" : undefined}>How it works</a>
            <a href="#audiences" data-active={activeSection === "audiences" ? "true" : undefined}>For schools</a>
            <a href="#features"  data-active={activeSection === "features"  ? "true" : undefined}>Features</a>
            <a href="/trust">Trust</a>
            <a href="#pricing"   data-active={activeSection === "pricing"   ? "true" : undefined}>Pricing</a>
          </nav>
          <div className="web-nav-cta">
            <a href="/portal" className="web-signin">Sign in</a>
            <a href="#cta" className="web-btn web-btn-primary" onClick={openDemo("nav")}>
              Book a demo <ArrowRight />
            </a>
          </div>
        </div>
      </header>

      <main id="main-content">
      {/* ── Hero ────────────────────────────────────── */}
      <section className="web-hero" aria-labelledby="hero-heading">
        <div className="web-site web-hero-grid">
          <div>
            <span className="web-eyebrow">Pickup, calmly run</span>
            <h1 id="hero-heading">
              The afternoon, <em>orderly</em>.<br />
              The pickup, <em>recognized</em>.
            </h1>
            <p className="web-hero-lede">
              Dismissal turns the curb into a calm, photo-led release.  Every arrival surfaces
              with a vehicle photo, the family record, and the driver's authorization status —
              already linked, on a dashboard staff actually trust.  Verify with a glance.
              Dismiss with a tap.  Move on.
            </p>
            <div className="web-hero-actions">
              <a href="#cta" className="web-btn web-btn-primary web-btn-lg" onClick={openDemo("hero")}>
                Book a 20-minute demo <ArrowRight />
              </a>
              <a href="#how" className="web-btn web-btn-ghost web-btn-lg">
                See how it works
              </a>
            </div>

            <div className="web-hero-trust">
              <div>
                <div className="n">Inst<span style={{ color: "var(--brand)" }}>ant</span></div>
                <div className="l">vehicle to family record at the curb</div>
              </div>
              <div>
                <div className="n">Resi<span style={{ color: "var(--brand)" }}>lient</span></div>
                <div className="l">keeps running through network blips</div>
              </div>
              <div>
                <div className="n">Flex<span style={{ color: "var(--brand)" }}>ible</span></div>
                <div className="l">installs where wires don't reach</div>
              </div>
            </div>
          </div>

          <div className="web-hero-visual" aria-hidden="true">
            {/* Card 1 — PickupCard shape from the real /portal Dashboard */}
            <div className="web-hv-card web-hv-card-1">
              <div className="web-hv-row">
                <span className="web-hv-eyebrow">Front Loop · Live</span>
                <span className="web-hv-pill">● Authorized guardian</span>
              </div>
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
                <span className="web-hv-plate">7VLM 482</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>silver honda cr-v</span>
              </div>
              <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="web-hv-row">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>Carla R · primary</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>guardian ✓</span>
                </div>
                <div className="web-hv-row">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>Maya · 4B  ·  Theo · 2A</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>linked</span>
                </div>
              </div>
            </div>

            {/* Card 2 — Dashboard stat strip from the real /portal */}
            <div className="web-hv-card web-hv-card-2">
              <span className="web-hv-eyebrow" style={{ color: "var(--brand)" }}>Live queue · front loop</span>
              <div style={{
                marginTop: 12, fontFamily: "var(--font-display)", fontSize: 38,
                fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1,
              }}>
                09
              </div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11, marginTop: 4 }}>
                vehicles in queue
              </div>
              <div className="web-hv-bar" style={{ marginTop: 16 }}>
                <span style={{ width: "78%" }} />
              </div>
              <div className="web-hv-row" style={{ marginTop: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>78% authorized</span>
                <span className="web-hv-pill amber">● 2 flagged</span>
              </div>
            </div>

            {/* Card 3 — audit log entry, the real action shape */}
            <div className="web-hv-card web-hv-card-3">
              <div className="web-hv-row">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: "var(--brand-subtle)", display: "grid", placeItems: "center",
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                         style={{ color: "var(--brand)" }}>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>Picked up · audit signed</span>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>
                  3:18:42 PM
                </span>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)", fontSize: 11.5, marginTop: 8 }}>
                2 students · 7VLM 482 · staff: J. Reyes
              </div>
            </div>
          </div>
        </div>

        {/* Collaborator line — replaces fabricated logos rail */}
        <div className="web-site">
          <div className="web-logos">
            <div className="lbl" style={{ maxWidth: "none" }}>
              Designed alongside K–12 administrators, district IT, and the front-office staff who actually run dismissal.
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem ─────────────────────────────────── */}
      <section className="web-problem" id="problem" aria-labelledby="problem-heading">
        <div className="web-site">
          <div className="web-problem-grid">
            <div>
              <span className="web-eyebrow">The 3 o'clock problem</span>
              <h2 id="problem-heading" className="web-section-title">
                Twenty-eight minutes, every weekday, <em>parked</em>.
              </h2>
              <p className="web-section-sub">
                Industry surveys put the average school-pickup wait at twenty-plus minutes per
                family, every weekday.  Staff radio names down a list.  A clipboard chases the
                wrong child to the wrong car.  And when something goes wrong, no one can tell you
                exactly who left with whom — because no one was writing it down.
              </p>

              <div className="web-stat-row">
                <div>
                  <div className="n">28<span className="unit">min</span></div>
                  <div className="l">typical parent wait time during peak dismissal</div>
                </div>
                <div>
                  <div className="n">12<span className="unit">d</span></div>
                  <div className="l">school days per year a family spends in line</div>
                </div>
                <div>
                  <div className="n">0<span className="unit">records</span></div>
                  <div className="l">most schools can produce when a release is later questioned</div>
                </div>
              </div>
            </div>

            <div>
              <div className="web-clock-stack">
                <div className="web-clock bad">
                  <div>
                    <div className="l">Today · with the line</div>
                    <div className="t" style={{ marginTop: 8 }}>28:14</div>
                  </div>
                  <div className="meter"><span /></div>
                </div>
                <div className="web-clock warn">
                  <div>
                    <div className="l">Today · partial</div>
                    <div className="t" style={{ marginTop: 8 }}>12:40</div>
                  </div>
                  <div className="meter"><span /></div>
                </div>
                <div className="web-clock good">
                  <div>
                    <div className="l">With Dismissal</div>
                    <div className="t" style={{ marginTop: 8 }}>04:02</div>
                  </div>
                  <div className="meter"><span /></div>
                </div>
              </div>

              <div className="web-replaced">
                <div style={{
                  fontSize: 10.5, fontWeight: 600, letterSpacing: "0.18em",
                  textTransform: "uppercase", color: "var(--text-tertiary)",
                }}>
                  What we replaced
                </div>
                <ul>
                  <li><CrossIcon /> Walkie-talkies and shouted last names</li>
                  <li><CrossIcon /> Hangtags that fade, get borrowed, get lost</li>
                  <li><CrossIcon /> A clipboard with yesterday's names crossed out</li>
                  <li><CrossIcon /> Calling parents to ask "who's picking up today?"</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works — Capture / Verify / Release ────── */}
      <section id="how" aria-labelledby="how-heading">
        <div className="web-site">
          <span className="web-eyebrow">How it works</span>
          <h2 id="how-heading" className="web-section-title">
            Three moves between <em>3:14</em> and the highway.
          </h2>
          <p className="web-section-sub">
            Dismissal stitches together the three places dismissal already happens — the curb,
            the office, and the audit trail — into a single quiet flow.
          </p>

          <div className="web-how-grid">
            <div className="web-step">
              <span className="num">01</span>
              <h3>Capture.</h3>
              <p>
                A camera at the lane identifies arriving vehicles the moment they enter frame.
                Recognition happens at the curb itself, so identification is instant — even
                when the campus network blinks.
              </p>
              <div className="visual" aria-hidden="true">
                <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                  <span className="web-hv-plate" style={{ fontSize: 18, padding: "10px 16px" }}>7VLM 482</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>
                    recognized · at the curb
                  </span>
                </div>
              </div>
            </div>

            <div className="web-step">
              <span className="num">02</span>
              <h3>Verify.</h3>
              <p>
                The family record surfaces on the staff dashboard, photo-led: the camera capture,
                the linked students, and the driver's authorization status.  Custody flags and
                blocked drivers light up before the car reaches the curb.
              </p>
              <div className="visual" aria-hidden="true"
                   style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, alignItems: "stretch" }}>
                <div className="web-lane"><span className="dot" /> Authorized guardian · Carla R</div>
                <div className="web-lane" style={{ color: "var(--text-secondary)" }}>
                  <span className="dot" style={{ background: "var(--amber)", boxShadow: "0 0 0 4px var(--amber-subtle)" }} />
                  Authorized adult · sister-in-law
                </div>
                <div className="web-lane" style={{ color: "var(--text-tertiary)" }}>
                  <span className="dot" style={{ background: "var(--text-tertiary)", boxShadow: "none" }} />
                  Unrecognized · review
                </div>
              </div>
            </div>

            <div className="web-step">
              <span className="num">03</span>
              <h3>Release.</h3>
              <p>
                Staff confirms the handoff with a tap.  The dismissal is signed, timestamped,
                and tied to a verified plate, guardian, and staff member.  Override is one tap
                when a record's missing — and the override is logged with reason, too.
              </p>
              <div className="visual" aria-hidden="true">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 16, width: "100%" }}>
                  <div style={{
                    border: "1px solid var(--border)", borderRadius: 10, padding: 10,
                    background: "var(--bg-surface)",
                  }}>
                    <div className="web-hv-eyebrow">Vehicle</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                      7VLM 482
                    </div>
                  </div>
                  <div style={{
                    border: "1px solid color-mix(in srgb, var(--brand) 35%, var(--border))",
                    borderRadius: 10, padding: 10, background: "var(--brand-subtle)",
                  }}>
                    <div className="web-hv-eyebrow" style={{ color: "var(--brand)" }}>Audit ✓</div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 13,
                      marginTop: 4, color: "var(--brand)",
                    }}>
                      Maya · Theo
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Audiences ───────────────────────────────── */}
      <section id="audiences" aria-labelledby="audiences-heading" style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <span className="web-eyebrow">Who it's for</span>
          <h2 id="audiences-heading" className="web-section-title">
            One system. Three afternoons <em>given back</em>.
          </h2>

          <div className="web-aud-grid">
            <div className="web-aud">
              <span className="role">Parents & guardians</span>
              <h3>Self-serve.  Verifiable.  Linked.</h3>
              <ul>
                <li>Add your children, your vehicles, and the people authorized to pick up — with photos, in your own portal.</li>
                <li>Caregivers, co-parents, grandparents, friends — each is a separate record, with revoke control on every one.</li>
                <li>See the moment your child is released, by whom, and into whose vehicle.</li>
              </ul>
              <div className="sig">→ Visibility · without the chaos</div>
            </div>

            <div className="web-aud">
              <span className="role">Front-office staff</span>
              <h3>The clipboard, retired.</h3>
              <ul>
                <li>A live release queue, photo-led — every arrival shows the vehicle, the linked students, and the driver's authorization status.</li>
                <li>Multi-student vehicles surface together.  Custody flags and blocked drivers light up before the car reaches the curb.</li>
                <li>Every release is signed, timestamped, and tied to a verified guardian.  Overrides are logged with reason.</li>
              </ul>
              <div className="sig">→ Calmer halls · fewer judgment calls</div>
            </div>

            <div className="web-aud">
              <span className="role">Administrators</span>
              <h3>Audit trail you can hand the board.</h3>
              <ul>
                <li>Every pickup is timestamped and tied to a verified plate, guardian, and staff member.</li>
                <li>Roll out across one campus or many — super-admin, district-admin, school-admin, staff, and scanner roles, scoped per school.</li>
                <li>Insights for peak times, wait windows, and pickup methods.  Audit retention configurable per district.</li>
              </ul>
              <div className="sig">→ Compliance · without the spreadsheet</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Feature mosaic ──────────────────────────── */}
      <section id="features" aria-labelledby="features-heading">
        <div className="web-site">
          <span className="web-eyebrow">What's inside</span>
          <h2 id="features-heading" className="web-section-title">
            Built for the messy reality of <em>3 o'clock</em>.
          </h2>
          <p className="web-section-sub">
            A handful of features doing one thing each, very well — instead of one big screen
            trying to be everything.
          </p>

          <div className="web-mosaic">
            <div className="web-tile web-t-wide" style={{ overflow: "hidden" }}>
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="12" rx="2" />
                    <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M6 13h12" />
                  </svg>
                </span>
                <h3>Vehicle recognition at the curb</h3>
                <p>A camera at each pickup zone identifies arriving vehicles the moment they enter frame.  Recognition happens at the curb itself — fast enough that staff sees the family before the car reaches them.  Vehicles the system isn't sure about surface as <em>unrecognized</em> for one-tap manual confirm.</p>
              </div>
              <div className="web-ph">
                <span className="cap">[ camera at curb ]</span>
              </div>
            </div>

            <div className="web-tile web-t-tall">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </span>
                <h3>Authorized-pickup roster</h3>
                <p>Parents register caregivers, co-parents, grandparents, and friends — each as a separate record, with photos and revoke control.  Court-ordered exclusions store as blocked entries; when those plates show up, the dashboard surfaces them in red before the driver reaches the curb.</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}>
                <div className="web-lane" style={{ fontSize: 11 }}><span className="dot" /> Carla R · primary</div>
                <div className="web-lane" style={{ fontSize: 11 }}>
                  <span className="dot" style={{ background: "var(--brand-accent)" }} /> Marcus R · co-parent
                </div>
                <div className="web-lane" style={{ fontSize: 11 }}>
                  <span className="dot" style={{ background: "var(--amber)", boxShadow: "0 0 0 4px var(--amber-subtle)" }} />
                  Lena T · authorized
                </div>
                <div className="web-lane" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  <span className="dot" style={{ background: "var(--text-tertiary)", boxShadow: "none" }} />
                  + add caregiver
                </div>
              </div>
            </div>

            <div className="web-tile web-t-half">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                </span>
                <h3>Self-contained pickup hardware</h3>
                <p>Curb cameras come ready for outdoor mounting with built-in power and connectivity options.  No cabling across the parking lot, no campus IT plumbing — designed to install where wires don't reach.</p>
              </div>
            </div>

            <div className="web-tile web-t-half">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
                  </svg>
                </span>
                <h3>Match-surfaced release</h3>
                <p>Plate, guardian, and student authorization all show before staff confirms.  Mismatches require an override tap — and every override is logged with reason.</p>
              </div>
            </div>

            <div className="web-tile web-t-third">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3h18v6H3zM3 15h18v6H3z" />
                    <path d="M7 6h.01M7 18h.01" />
                  </svg>
                </span>
                <h3>Multi-student vehicles</h3>
                <p>One vehicle, multiple linked students.  They surface together on the dashboard so staff dismisses them in one pass.</p>
              </div>
            </div>

            <div className="web-tile web-t-third">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12 7 8l4 4 6-6 4 4" />
                  </svg>
                </span>
                <h3>Insights</h3>
                <p>Peak hours, wait-time histograms, pickup-method splits, and a 28-day heatmap — so you know whether to add a body to the curb or shift the bell.</p>
              </div>
            </div>

            <div className="web-tile web-t-third">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9 12 11 14l4-4" />
                  </svg>
                </span>
                <h3>Audit trail</h3>
                <p>Every release — and every override — is signed, timestamped, and exportable.  Retention is configurable per district.</p>
              </div>
            </div>

            <div className="web-tile web-t-third">
              <div>
                <span className="icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M16 11l-4 4-4-4M12 15V3" />
                  </svg>
                </span>
                <h3>SIS roster sync</h3>
                <p>Nightly sync against your student information system using the standards your district already uses.  No double entry, no stale class lists.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Workflow timeline ───────────────────────── */}
      <section id="timeline" aria-labelledby="timeline-heading" style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <span className="web-eyebrow">A typical Tuesday</span>
          <h2 id="timeline-heading" className="web-section-title">3:14 to 3:32 — narrated.</h2>

          <div className="web-timeline">
            <div className="web-tl-row">
              <div className="web-tl-time">3:14 PM</div>
              <div className="web-tl-event">
                <h3>Bell rings.  Queue opens.</h3>
                <p>Curb cameras shift into queue mode.  Front-office staff opens the live release dashboard.  The day's roster is already loaded — last night's roster sync took care of that.</p>
              </div>
              <div className="web-tl-meta">— front loop · upper lot · loading dock</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:16 PM</div>
              <div className="web-tl-event">
                <h3>First arrival.</h3>
                <p>7VLM 482 enters frame.  The curb camera identifies the vehicle instantly; Carla R surfaces on the dashboard as primary guardian, with Maya (4B) and Theo (2A) linked.</p>
              </div>
              <div className="web-tl-meta">— matched at the curb</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:18 PM</div>
              <div className="web-tl-event">
                <h3>Tap to release.</h3>
                <p>Staff confirms with a tap.  The audit log seals: <em>Picked up · 7VLM 482 · J. Reyes · 3:18:42 PM · 2 students</em>.  Carla pulls forward; the next vehicle slides in.</p>
              </div>
              <div className="web-tl-meta">— signed · timestamped</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:24 PM</div>
              <div className="web-tl-event">
                <h3>Edge case: an unrecognized plate.</h3>
                <p>The card surfaces as <em>Unrecognized</em>.  Office calls Carla, confirms her sister-in-law is on the authorized list, and taps <em>Override · Pick up</em>.  The override is logged with reason — visible in the audit trail forever.</p>
              </div>
              <div className="web-tl-meta">— amber path · override logged</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:32 PM</div>
              <div className="web-tl-event">
                <h3>Last car out.  Day closed.</h3>
                <p>Audit log finalizes for the day.  Insights update with today's wait-time histogram and the auto-vs-override split.  Staff retreat to a calmer afternoon.</p>
              </div>
              <div className="web-tl-meta">— 184 students released</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Design principle (replaces fabricated quote) + product facts ── */}
      <section aria-label="Design principle">
        <div className="web-site">
          <div className="web-quote-wrap">
            <div>
              <span className="web-eyebrow">Design principle</span>
              <p className="web-quote">
                The most consequential transaction a school makes each day — handing a child to
                the right adult — was happening on walkie-talkies, hangtags, and yesterday's
                clipboard.  We built Dismissal because identification, not estimation, is the
                job.  The staff member at the curb makes the call; we just make sure they have
                the right answer in front of them, in under a second, with a paper trail that
                holds up later.
              </p>
              <div className="web-quote-meta">
                <div className="web-qm-av">D</div>
                <div>
                  <div className="web-qm-name">From the Dismissal team</div>
                  <div className="web-qm-role">Designed in collaboration with K–12 administrators</div>
                </div>
              </div>
            </div>

            <div className="web-metric-card">
              <div style={{
                fontSize: 10.5, fontWeight: 600, letterSpacing: "0.18em",
                textTransform: "uppercase", color: "var(--text-tertiary)",
              }}>
                Built into the product
              </div>
              <div className="big" style={{ marginTop: 14 }}>Instant</div>
              <div className="lbl">vehicle-to-record match at the curb, before staff sees the car.</div>

              <div className="web-metric-grid">
                <div className="mc"><div className="n">4</div><div className="l">authorization tiers surfaced before pickup</div></div>
                <div className="mc"><div className="n">5</div><div className="l">scoped admin roles, per school</div></div>
                <div className="mc"><div className="n">1y</div><div className="l">default audit retention, configurable per district</div></div>
                <div className="mc"><div className="n">100%</div><div className="l">of releases signed, timestamped, and exportable</div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Security ────────────────────────────────── */}
      <section id="security" aria-labelledby="security-heading" style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <div className="web-quote-wrap" style={{ alignItems: "start" }}>
            <div>
              <span className="web-eyebrow">Trust by design</span>
              <h2 id="security-heading" className="web-section-title">
                Built like the school around it — <em>locked, logged, scoped</em>.
              </h2>
              <p className="web-section-sub">
                A child's release is the most consequential transaction a school makes each day.
                Dismissal treats it that way: every action is signed, every device is enrolled,
                every roster change is auditable, and every retention window is yours to set.
              </p>
            </div>

            <div className="web-trust-stack">
              <div className="web-trust-card">
                <div className="head">
                  <span className="ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6M9 13h6M9 17h6" />
                    </svg>
                  </span>
                  <span className="ttl">FERPA-aligned data handling</span>
                </div>
                <p>We minimize what we store, encrypt PII at rest, and give districts retention controls for vehicle records, audit log entries, and student records.</p>
              </div>
              <div className="web-trust-card">
                <div className="head">
                  <span className="ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <span className="ttl">Role-based access · scoped per school</span>
                </div>
                <p>Super-admin, district-admin, school-admin, staff, and scanner roles.  Permissions are scoped per school within a district, so a substitute sees today's roster while a district admin sees the year.</p>
              </div>
              <div className="web-trust-card">
                <div className="head">
                  <span className="ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                  </span>
                  <span className="ttl">Configurable retention</span>
                </div>
                <p>Audit log retention is set per district (365-day default).  Vehicle records archive nightly to a 1-year long-term store.  Set the windows your compliance posture requires.</p>
              </div>

              <a href="/trust" className="web-btn web-btn-ghost" style={{ alignSelf: "flex-start", marginTop: 4 }}>
                View our trust posture <ArrowRight />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────── */}
      <section id="pricing" aria-labelledby="pricing-heading">
        <div className="web-site">
          <span className="web-eyebrow">Common questions</span>
          <h2 id="pricing-heading" className="web-section-title">The honest answers.</h2>

          <div className="web-faq" style={{ marginTop: 36 }}>
            <div>
              <p style={{
                color: "var(--text-secondary)", fontSize: 14,
                lineHeight: 1.55, maxWidth: 360, margin: 0,
              }}>
                If your question isn't here, write us — we answer in person before we answer in marketing copy.
              </p>
              <a href="#cta" className="web-btn web-btn-ghost" style={{ marginTop: 16 }}>
                Ask us anything →
              </a>
            </div>

            <div>
              <div className="web-q">
                <h3>Do we need to install cameras? <span className="pl">+</span></h3>
                <p>Yes — most campuses start with a single camera per pickup zone.  We supply the hardware and work with each campus on install timing.  Pickup geometry varies a lot, so we scope it together.</p>
              </div>
              <div className="web-q">
                <h3>Does the curb hardware need WiFi? <span className="pl">+</span></h3>
                <p>No.  Curb cameras ship with built-in connectivity options for outdoor or off-grid pickup zones — no campus network drop or trenching across the parking lot required.</p>
              </div>
              <div className="web-q">
                <h3>What if a parent doesn't have a smartphone? <span className="pl">+</span></h3>
                <p>Vehicle recognition works without an app — the camera reads the vehicle, not the driver's phone.  Parents who prefer a paper alternative can register their vehicle with the school office, and the registry update flows through the same way.</p>
              </div>
              <div className="web-q">
                <h3>How do you handle custody and divorced parents? <span className="pl">+</span></h3>
                <p>Each authorized adult is a separate record with their own permissions.  Schools can require a primary-guardian override for non-primary pickups.  Court-ordered exclusions are stored as blocked entries — when those vehicles appear, the dashboard surfaces them in red before the driver reaches the curb.</p>
              </div>
              <div className="web-q">
                <h3>What if a vehicle isn't recognized? <span className="pl">+</span></h3>
                <p>Unrecognized arrivals surface on the dashboard with a thumbnail and (when possible) a best-guess match.  Staff can verify against the registry, dismiss with override, and the override is signed and logged with reason.</p>
              </div>
              <div className="web-q">
                <h3>What does it cost? <span className="pl">+</span></h3>
                <p>Per-student, per-year, with a flat hardware install.  We don't charge per parent or per device, and we never sell roster data.  Pricing tiers by district size — happy to share specifics on a call.</p>
              </div>
              <div className="web-q">
                <h3>How long until we're live? <span className="pl">+</span></h3>
                <p>We work with each campus to scope rollout pace.  A single-campus pilot — hardware install, roster sync, and a staff training afternoon — typically lands in a few weeks.  District rollouts vary with the number of campuses.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────── */}
      <section id="cta" aria-labelledby="cta-heading">
        <div className="web-site">
          <div className="web-cta-wrap">
            <span className="web-eyebrow">Get started</span>
            <h2 id="cta-heading">Hand the afternoon back. <em>Starting Monday</em>.</h2>
            <p className="lede">
              A 20-minute demo, a walk through your pickup geometry, and an honest path to a
              pilot.  We'll bring questions about your campus; you bring questions about ours.
            </p>
            <div className="actions">
              <a href="mailto:hello@dismissal.app" className="web-btn web-btn-primary web-btn-lg" onClick={openDemo("cta")}>
                Book a 20-minute demo <ArrowRight />
              </a>
              <a href="/portal" className="web-btn web-btn-ghost web-btn-lg">
                Open the staff portal <ArrowOut />
              </a>
            </div>
          </div>
        </div>
      </section>
      </main>

      {/* ── Footer ──────────────────────────────────── */}
      <footer className="web-footer">
        <div className="web-site">
          <div className="web-ft-grid">
            <div className="web-ft-brand">
              <a href="/" className="web-brand" aria-label="Dismissal home">
                <BrandWordmark className="web-brand-word" aria-hidden="true" />
              </a>
              <p>School pickup, calmly run.  Built for districts and independent schools that would like their afternoons back.</p>
            </div>
            <div className="web-ft-col">
              <h2>Product</h2>
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
              <a href="/trust">Trust &amp; security</a>
              <a href="/accessibility">Accessibility</a>
              <a href="#pricing">Pricing</a>
            </div>
            <div className="web-ft-col">
              <h2>Schools</h2>
              <a href="#audiences">For administrators</a>
              <a href="#audiences">For staff</a>
              <a href="#audiences">For parents</a>
              <a href="#cta">Pilot inquiries</a>
            </div>
            <div className="web-ft-col">
              <h2>Company</h2>
              <a href="#cta">Contact</a>
              <a href="mailto:hello@dismissal.app">hello@dismissal.app</a>
            </div>
            <nav className="web-ft-col" aria-label="Support">
              <h2>Support</h2>
              <a href="#pricing">FAQ</a>
              <a href="mailto:hello@dismissal.app?subject=Help">Help &amp; contact</a>
              <a href="/accessibility">Accessibility help</a>
              <a href="/trust">Trust &amp; security</a>
            </nav>
          </div>

          <div className="web-ft-bottom">
            <div>© 2026 Dismissal, Inc. · All rights reserved.</div>
            <div className="dots"><span className="dot" /> Designed in collaboration with school teams</div>
          </div>
        </div>
      </footer>

      <BookDemoModal
        open={demoSource !== null}
        source={demoSource}
        onClose={closeDemo}
      />
    </div>
  );
}
