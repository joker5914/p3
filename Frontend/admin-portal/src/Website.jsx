import { useEffect } from "react";
import "./Website.css";

/* ── Marketing site ──────────────────────────────────────────────────
   The front-facing landing page that lives at "/".  All authenticated
   product flows continue to live under /portal where Login → the
   existing app shell takes over — guardians, staff, and admins all
   sign in through the same portal link.

   Site is dark-first / citrus on purpose — even if the user's portal
   theme is light, marketing always reads in the editorial dark frame.
   Uses tokens (no hard-coded colors) so the gradient/headline accents
   pick up the brand palette.
   ────────────────────────────────────────────────────────────────── */

// Inline brand-gradient defs so SVGs that reference url(#brandGrad)
// can render the citrus gradient without recolour gymnastics.
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

function CrossIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}

export default function Website() {
  // Marketing is locked to dark/citrus regardless of the visitor's saved
  // portal preference — strip overrides on mount, restore on unmount so
  // the portal still picks up whatever the signed-in user chose.
  useEffect(() => {
    const body = document.body;
    const prev = {
      theme: body.getAttribute("data-theme"),
      palette: body.getAttribute("data-palette"),
      type: body.getAttribute("data-type"),
      density: body.getAttribute("data-density"),
    };
    body.setAttribute("data-theme", "dark");
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

  return (
    <div className="web">
      <GradientDefs />

      {/* ── Nav ─────────────────────────────────────── */}
      <div className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <span className="web-brand-mark"><BrandMark /></span>
            <span className="web-brand-word">Dismissal</span>
          </a>
          <nav className="web-nav-links">
            <a href="#how">How it works</a>
            <a href="#audiences">For schools</a>
            <a href="#features">Features</a>
            <a href="#security">Security</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="web-nav-cta">
            <a href="/portal" className="web-signin">Sign in</a>
            <a href="#cta" className="web-btn web-btn-primary">
              Book a demo <ArrowRight />
            </a>
          </div>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────── */}
      <header className="web-hero">
        <div className="web-site web-hero-grid">
          <div>
            <span className="web-eyebrow">Pickup, calmly run</span>
            <h1>
              The afternoon, <em>orderly</em>.<br />
              The pickup line, <em>gone</em>.
            </h1>
            <p className="web-hero-lede">
              Dismissal hands the carpool line back to its rightful owner — your afternoon.
              License-plate recognition, a real-time queue staff actually trust, and a release
              process that always pairs the right student with the right vehicle.
            </p>
            <div className="web-hero-actions">
              <a href="#cta" className="web-btn web-btn-primary web-btn-lg">
                Book a 20-minute demo <ArrowRight />
              </a>
              <a href="#how" className="web-btn web-btn-ghost web-btn-lg">
                See how it works
              </a>
            </div>

            <div className="web-hero-trust">
              <div>
                <div className="n">38<span style={{ color: "var(--brand)" }}>m</span></div>
                <div className="l">avg. saved per family / day</div>
              </div>
              <div>
                <div className="n">92<span style={{ color: "var(--brand)" }}>%</span></div>
                <div className="l">plates auto-recognized</div>
              </div>
              <div>
                <div className="n">0</div>
                <div className="l">student mismatches reported</div>
              </div>
            </div>
          </div>

          <div className="web-hero-visual" aria-hidden="true">
            {/* Card 1 — pickup queue */}
            <div className="web-hv-card web-hv-card-1">
              <div className="web-hv-row">
                <span className="web-hv-eyebrow">Lane 03 · Now serving</span>
                <span className="web-hv-pill">● Live</span>
              </div>
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
                <span className="web-hv-plate">7VLM 482</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>silver crv</span>
              </div>
              <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="web-hv-row">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>Maya R · 4B</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>guardian ✓</span>
                </div>
                <div className="web-hv-row">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>Theo R · 2A</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>guardian ✓</span>
                </div>
              </div>
            </div>

            {/* Card 2 — queue position */}
            <div className="web-hv-card web-hv-card-2">
              <span className="web-hv-eyebrow" style={{ color: "var(--brand)" }}>Parent app</span>
              <div style={{
                marginTop: 12, fontFamily: "var(--font-display)", fontSize: 38,
                fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1,
              }}>
                02:14
              </div>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11, marginTop: 4 }}>
                est. wait · lane 03
              </div>
              <div className="web-hv-bar" style={{ marginTop: 16 }}>
                <span style={{ width: "68%" }} />
              </div>
              <div className="web-hv-row" style={{ marginTop: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>queue · #4 of 9</span>
                <span className="web-hv-pill amber">● approaching</span>
              </div>
            </div>

            {/* Card 3 — staff release */}
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
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>Released to vehicle</span>
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

        {/* Logos rail */}
        <div className="web-site">
          <div className="web-logos">
            <div className="lbl">Trusted by districts and independent schools</div>
            <div className="l">Roosevelt USD</div>
            <div className="l">Magnolia Day</div>
            <div className="l">Linden Academy</div>
            <div className="l">Cedar Park Schools</div>
            <div className="l">Birchwood Prep</div>
            <div className="l">Harbor District</div>
          </div>
        </div>
      </header>

      {/* ── Problem ─────────────────────────────────── */}
      <section className="web-problem" id="problem">
        <div className="web-site">
          <div className="web-problem-grid">
            <div>
              <span className="web-eyebrow">The 3 o'clock problem</span>
              <h2 className="web-section-title">
                Twenty-eight minutes, every weekday, <em>parked</em>.
              </h2>
              <p className="web-section-sub">
                The average family loses three full work-weeks a year sitting in a school pickup line.
                Staff radio names down a list. A clipboard chases the wrong child to the wrong car.
                Everyone leaves the afternoon a little more frayed than they need to be.
              </p>

              <div className="web-stat-row">
                <div>
                  <div className="n">28<span className="unit">min</span></div>
                  <div className="l">average parent wait time during peak dismissal</div>
                </div>
                <div>
                  <div className="n">15<span className="unit">d</span></div>
                  <div className="l">school days per year a family spends in line</div>
                </div>
                <div>
                  <div className="n">1<span className="unit">in 7</span></div>
                  <div className="l">staff report a near-miss release each semester</div>
                </div>
              </div>
            </div>

            <div>
              <div className="web-clock-stack">
                <div className="web-clock bad">
                  <div>
                    <div className="l">Today · with line</div>
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

      {/* ── How it works ────────────────────────────── */}
      <section id="how">
        <div className="web-site">
          <span className="web-eyebrow">How it works</span>
          <h2 className="web-section-title">
            Three moves between <em>3:14</em> and the highway.
          </h2>
          <p className="web-section-sub">
            Dismissal stitches together the three places dismissal already happens — the curb,
            the office, the classroom — into a single quiet flow.
          </p>

          <div className="web-how-grid">
            <div className="web-step">
              <span className="num">01</span>
              <h3>Plate in.</h3>
              <p>
                Vehicles approach the pickup zone. A camera at the lane recognizes the plate and
                pulls up the family in 0.4 seconds — no app to open, no number to write down.
              </p>
              <div className="visual" aria-hidden="true">
                <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                  <span className="web-hv-plate" style={{ fontSize: 18, padding: "10px 16px" }}>7VLM 482</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", fontSize: 11 }}>
                    recognized · 0.4s · 99.2% match
                  </span>
                </div>
              </div>
            </div>

            <div className="web-step">
              <span className="num">02</span>
              <h3>Class out.</h3>
              <p>
                Teachers see exactly which students to release, in what order, to which lane.
                Siblings group automatically. No more pulling kids out one by one and hoping the
                car is still there.
              </p>
              <div className="visual" aria-hidden="true"
                   style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, alignItems: "stretch" }}>
                <div className="web-lane"><span className="dot" /> Lane 03 · Maya R · Theo R</div>
                <div className="web-lane" style={{ opacity: 0.65 }}>
                  <span className="dot" style={{ background: "var(--amber)", boxShadow: "0 0 0 4px var(--amber-subtle)" }} />
                  Lane 01 · Sam K
                </div>
                <div className="web-lane" style={{ opacity: 0.4 }}>
                  <span className="dot" style={{ background: "var(--text-tertiary)", boxShadow: "none" }} />
                  Lane 04 · queued
                </div>
              </div>
            </div>

            <div className="web-step">
              <span className="num">03</span>
              <h3>Match, release.</h3>
              <p>
                Staff confirms the handoff with a tap. The student is logged into the right vehicle,
                with the right guardian, at the right time — and the line keeps moving.
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
                    <div className="web-hv-eyebrow" style={{ color: "var(--brand)" }}>Match ✓</div>
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
      <section id="audiences" style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <span className="web-eyebrow">Who it's for</span>
          <h2 className="web-section-title">
            One system. Three afternoons <em>given back</em>.
          </h2>

          <div className="web-aud-grid">
            <div className="web-aud">
              <span className="role">Parents & guardians</span>
              <h3>Forty minutes back. Every day.</h3>
              <ul>
                <li>Skip the line. Park, tap "I'm here," watch the queue ETA tick down.</li>
                <li>Add caregivers, grandparents, or a friend's parent — with a one-tap permission, never a phone tag chain.</li>
                <li>See the moment your child is released, by whom, and into whose vehicle.</li>
              </ul>
              <div className="sig">→ Time saved · accountability gained</div>
            </div>

            <div className="web-aud">
              <span className="role">Teachers & staff</span>
              <h3>The clipboard, retired.</h3>
              <ul>
                <li>A live release queue that knows which student belongs to which lane, and tells you in what order.</li>
                <li>Sibling grouping, late-bus flags, and after-school activity overrides — handled automatically.</li>
                <li>Every release is signed, timestamped, and tied to a verified guardian.</li>
              </ul>
              <div className="sig">→ Calmer halls · fewer judgement calls</div>
            </div>

            <div className="web-aud">
              <span className="role">Administrators</span>
              <h3>Audit trail you can hand the board.</h3>
              <ul>
                <li>Every pickup is timestamped and tied to a verified plate, guardian, and staff member.</li>
                <li>Roll out across one campus or thirty — role-based access for principals, office staff, and substitutes.</li>
                <li>Reports for liability, attendance reconciliation, and after-school program billing.</li>
              </ul>
              <div className="sig">→ Compliance · without the spreadsheet</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Feature mosaic ──────────────────────────── */}
      <section id="features">
        <div className="web-site">
          <span className="web-eyebrow">What's inside</span>
          <h2 className="web-section-title">
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
                <h4>License-plate recognition</h4>
                <p>An ANPR camera at each pickup lane resolves vehicles in under half a second. 92% auto-match rate; the rest fall back to a one-tap manual confirm.</p>
              </div>
              <div className="web-ph">
                <span className="cap">[ camera + lane diagram ]</span>
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
                <h4>Approved guardian roster</h4>
                <p>Parents add caregivers, exes, grandparents, friends — each with their own pickup window and tap-to-revoke control.</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}>
                <div className="web-lane" style={{ fontSize: 11 }}><span className="dot" /> Carla R · primary</div>
                <div className="web-lane" style={{ fontSize: 11 }}>
                  <span className="dot" style={{ background: "var(--brand-accent)" }} /> Marcus R · co-parent
                </div>
                <div className="web-lane" style={{ fontSize: 11 }}>
                  <span className="dot" style={{ background: "var(--amber)", boxShadow: "0 0 0 4px var(--amber-subtle)" }} />
                  Lena T · friday only
                </div>
                <div className="web-lane" style={{ fontSize: 11, opacity: 0.6 }}>
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
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </span>
                <h4>Live ETA</h4>
                <p>Parents see queue position and a real ETA — no more peeking out the windshield.</p>
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
                <h4>Match-required release</h4>
                <p>A child cannot be marked released until plate, guardian, and student all agree.</p>
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
                <h4>Sibling grouping</h4>
                <p>One vehicle pulls up. All matching students release together — no second loop around the block.</p>
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
                <h4>Insights</h4>
                <p>See peak minutes, slowest lanes, and which staff are running ragged — and where to add a body next semester.</p>
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
                <h4>Audit trail</h4>
                <p>Every release is signed, timestamped, and exportable. Hand it to the board, the bus company, or the auditor.</p>
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
                <h4>SIS sync</h4>
                <p>Nightly roster sync with PowerSchool, Skyward, Veracross — no double entry, no stale class lists.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Workflow timeline ───────────────────────── */}
      <section style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <span className="web-eyebrow">A typical Tuesday</span>
          <h2 className="web-section-title">3:14 to 3:32 — narrated.</h2>

          <div className="web-timeline">
            <div className="web-tl-row">
              <div className="web-tl-time">3:14 PM</div>
              <div className="web-tl-event">
                <h5>Bell rings, queue opens.</h5>
                <p>Teachers tap into the release view. Staff at the curb open their lane assignments. Plate cameras come online.</p>
              </div>
              <div className="web-tl-meta">— 14 lanes live</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:16 PM</div>
              <div className="web-tl-event">
                <h5>First family arrives, lane 03.</h5>
                <p>7VLM 482 — Carla R, primary guardian. Maya (4B) and Theo (2A) are flagged in their classrooms simultaneously.</p>
              </div>
              <div className="web-tl-meta">— matched in 0.4s</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:18 PM</div>
              <div className="web-tl-event">
                <h5>Walkout, match-confirm, release.</h5>
                <p>Both siblings escorted to the curb. Lane staff confirms the match with a tap. Carla pulls forward; the next vehicle slides in.</p>
              </div>
              <div className="web-tl-meta">— 38 sec curb-side</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:24 PM</div>
              <div className="web-tl-event">
                <h5>Edge case: an aunt arrives.</h5>
                <p>An unrecognized plate. The system flags it, the parent is pinged for a one-tap approval, and the release proceeds — without a phone-tree fire drill.</p>
              </div>
              <div className="web-tl-meta">— amber path</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:32 PM</div>
              <div className="web-tl-event">
                <h5>Last car out. Day closed.</h5>
                <p>Audit trail seals. Insights update. Staff retreat to a calmer afternoon. Total dismissal duration: 18 minutes.</p>
              </div>
              <div className="web-tl-meta">— 184 students released</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Quote / metrics ─────────────────────────── */}
      <section>
        <div className="web-site">
          <div className="web-quote-wrap">
            <div>
              <span className="web-eyebrow">From the field</span>
              <p className="web-quote">
                We used to dread Friday dismissal. Now it's the part of the day where I actually have time to talk to a parent about how their kid did. The line just… isn't a thing anymore.
              </p>
              <div className="web-quote-meta">
                <div className="web-qm-av">JR</div>
                <div>
                  <div className="web-qm-name">Jamie Reyes</div>
                  <div className="web-qm-role">Site Admin · Roosevelt Elementary</div>
                </div>
              </div>
            </div>

            <div className="web-metric-card">
              <div style={{
                fontSize: 10.5, fontWeight: 600, letterSpacing: "0.18em",
                textTransform: "uppercase", color: "var(--text-tertiary)",
              }}>
                By the second semester
              </div>
              <div className="big" style={{ marginTop: 14 }}>68%</div>
              <div className="lbl">drop in average parent wait time across our 12 pilot campuses, measured curb-arrival to curb-departure.</div>

              <div className="web-metric-grid">
                <div className="mc"><div className="n">38m</div><div className="l">saved per family / day</div></div>
                <div className="mc"><div className="n">0</div><div className="l">misreleases reported</div></div>
                <div className="mc"><div className="n">14d</div><div className="l">to full rollout</div></div>
                <div className="mc"><div className="n">94%</div><div className="l">parent retention y/y</div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Security ────────────────────────────────── */}
      <section id="security" style={{
        background: "var(--bg-sunken)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="web-site">
          <div className="web-quote-wrap" style={{ alignItems: "start" }}>
            <div>
              <span className="web-eyebrow">Trust by design</span>
              <h2 className="web-section-title">
                Built like the school around it — <em>locked, logged, learned</em>.
              </h2>
              <p className="web-section-sub">
                A child's release is the most consequential transaction a school makes each day.
                Dismissal treats it that way: every action is signed, every device is enrolled,
                every roster change is auditable.
              </p>
            </div>

            <div className="web-trust-stack">
              <div className="web-trust-card">
                <div className="head">
                  <span className="ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
                    </svg>
                  </span>
                  <span className="ttl">SOC 2 Type II · FERPA · COPPA</span>
                </div>
                <p>Independent attestation, not a self-checked box. Annual penetration testing and signed BAAs available.</p>
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
                  <span className="ttl">Role-based access control</span>
                </div>
                <p>Substitutes see today's roster; principals see the year. Permissions revoke the moment a staff badge is deactivated in your SIS.</p>
              </div>
              <div className="web-trust-card">
                <div className="head">
                  <span className="ic">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6M9 13h6M9 17h6" />
                    </svg>
                  </span>
                  <span className="ttl">Plate data, kept short</span>
                </div>
                <p>Plate images are matched and discarded within 24 hours. Only the resolved match — plate text and family link — is retained.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────── */}
      <section id="pricing">
        <div className="web-site">
          <span className="web-eyebrow">Common questions</span>
          <h2 className="web-section-title">The honest answers.</h2>

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
                <h5>Do we need to install cameras? <span className="pl">+</span></h5>
                <p>Most schools start with a single ANPR camera per pickup lane. We supply the hardware, mount it, and certify it. Pilot programs typically light up in two weeks.</p>
              </div>
              <div className="web-q">
                <h5>What if a parent doesn't have a smartphone? <span className="pl">+</span></h5>
                <p>Plate recognition works without an app. Parents can also receive SMS-based queue updates, or a paper hangtag that resolves to the same record.</p>
              </div>
              <div className="web-q">
                <h5>How do you handle custody and divorced parents? <span className="pl">+</span></h5>
                <p>Each guardian is a separately-permissioned record. Schools can require a second-guardian override for non-primary pickups, with date-bound exceptions.</p>
              </div>
              <div className="web-q">
                <h5>What does it cost? <span className="pl">+</span></h5>
                <p>Per-student, per-year, with a flat hardware install. We don't charge per parent or per device, and we never sell roster data. Pricing tiers by district size — happy to share specifics on a call.</p>
              </div>
              <div className="web-q">
                <h5>How long until we're live? <span className="pl">+</span></h5>
                <p>Two weeks for a single campus, including hardware install, SIS sync, and a staff training afternoon. Three to six weeks for a full district rollout.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────── */}
      <section id="cta">
        <div className="web-site">
          <div className="web-cta-wrap">
            <span className="web-eyebrow">Get started</span>
            <h2>Hand the afternoon back. <em>Starting Monday</em>.</h2>
            <p className="lede">
              A 20-minute demo, a 14-day pilot, and a school year that no longer ends with a queue.
              Book a call — we'll bring the carpool data; you bring the questions.
            </p>
            <div className="actions">
              <a href="mailto:hello@dismissal.app" className="web-btn web-btn-primary web-btn-lg">
                Book a 20-minute demo <ArrowRight />
              </a>
              <a href="/portal" className="web-btn web-btn-ghost web-btn-lg">
                Open the staff portal <ArrowOut />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────── */}
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
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
              <a href="#security">Security</a>
              <a href="#pricing">Pricing</a>
            </div>
            <div className="web-ft-col">
              <h6>Schools</h6>
              <a href="#audiences">For administrators</a>
              <a href="#audiences">For staff</a>
              <a href="#audiences">For parents</a>
              <a href="#">Case studies</a>
            </div>
            <div className="web-ft-col">
              <h6>Company</h6>
              <a href="#">About</a>
              <a href="#">Careers</a>
              <a href="#">Press</a>
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
