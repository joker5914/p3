import { useEffect, useMemo, useState } from "react";
import "./Website.css";
import MarketingChrome, { useScrollSpy } from "./MarketingChrome";
import BookDemoModal from "./BookDemoModal";
import LiveCards from "./LiveCards";
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

      {/* ── Nav ─────────────────────────────────────── */}
      <header className="web-nav-outer">
        <div className="web-site web-nav">
          <a href="/" className="web-brand" aria-label="Dismissal home">
            <BrandWordmark className="web-brand-word" aria-hidden="true" />
          </a>
          <nav className="web-nav-links" aria-label="Primary">
            <a href="#how"       data-active={activeSection === "how"       ? "true" : undefined}>How it works</a>
            <a href="#audiences" data-active={activeSection === "audiences" ? "true" : undefined}>Who it's for</a>
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
            <span className="web-eyebrow">School pickup, made simple</span>
            <h1 id="hero-heading">
              Get your kids home faster after school.
            </h1>
            <p className="web-hero-lede">
              Most parents arrive an hour before the bell just to beat the pickup line —
              then sit through it, then crawl home through afternoon traffic.  Dismissal
              collapses the line itself.  A camera at the curb reads each car.  The office
              sees the family on screen.  One tap signs the kid out.  Less waiting.  Fewer
              mistakes.  A clean record of who left with whom — and an afternoon back.
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
                <div className="n" style={{ color: "var(--brand)" }}>Time back</div>
                <div className="l">pickup runs in minutes — no need to arrive early to beat the line</div>
              </div>
              <div>
                <div className="n" style={{ color: "var(--brand)" }}>Calmer curb</div>
                <div className="l">staff sees the family on screen before the car reaches the door</div>
              </div>
              <div>
                <div className="n" style={{ color: "var(--brand)" }}>On the record</div>
                <div className="l">every pickup is signed, time-stamped, and exportable</div>
              </div>
            </div>
          </div>

          <div className="web-hero-visual">
            <LiveCards />
          </div>
        </div>

        {/* Collaborator line — replaces fabricated logos rail */}
        <div className="web-site">
          <div className="web-logos">
            <div className="lbl" style={{ maxWidth: "none" }}>
              Built with the principals, office staff, and parents who've spent enough afternoons in the pickup line.
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem ─────────────────────────────────── */}
      <section className="web-problem" id="problem" aria-labelledby="problem-heading">
        <div className="web-site">
          <div className="web-problem-grid">
            <div>
              <span className="web-eyebrow">What pickup costs today</span>
              <h2 id="problem-heading" className="web-section-title">
                Pickup doesn't take 28 minutes. It takes most of your afternoon.
              </h2>
              <p className="web-section-sub">
                Parents already know the line gets long, so they arrive an hour before the
                bell to beat it.  Then they sit through the line.  Then they crawl through
                the traffic the line just made.  Inside, staff are radioing names down a
                list and crossing them off a clipboard — and when something goes wrong, no
                one can tell you exactly who left with whom, because no one wrote it down.
              </p>

              <div className="web-stat-row">
                <div>
                  <div className="n">1<span className="unit">hr</span></div>
                  <div className="l">how early parents arrive — to beat the line</div>
                </div>
                <div>
                  <div className="n">28<span className="unit">min</span></div>
                  <div className="l">the wait once the line actually forms</div>
                </div>
                <div>
                  <div className="n">264<span className="unit">hrs</span></div>
                  <div className="l">lost to pickup, per family, per school year</div>
                </div>
              </div>
            </div>

            <div>
              <div className="web-clock-stack">
                <div className="web-clock bad">
                  <div>
                    <div className="l">A regular pickup line today</div>
                    <div className="t" style={{ marginTop: 8 }}>28:14</div>
                  </div>
                  <div className="meter"><span /></div>
                </div>
                <div className="web-clock warn">
                  <div>
                    <div className="l">Schools that automated half of it</div>
                    <div className="t" style={{ marginTop: 8 }}>12:40</div>
                  </div>
                  <div className="meter"><span /></div>
                </div>
                <div className="web-clock good">
                  <div>
                    <div className="l">With Dismissal — no early arrival needed</div>
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
                  <li><CrossIcon /> Pickup days that left no record at all</li>
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
            Three steps from the school bell to your driveway.
          </h2>
          <p className="web-section-sub">
            The line gets long because the office finds out who's at the curb only after
            the car reaches the door.  Dismissal moves that moment forward — the family is
            already on screen by the time the car pulls in.
          </p>

          <div className="web-how-grid">
            <div className="web-step">
              <span className="num">01</span>
              <h3>The camera sees the car.</h3>
              <p>
                A camera at the pickup zone reads each car's license plate the moment it
                arrives.  It runs at the curb itself, so it keeps working even if the school's
                network blinks.
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
              <h3>The office sees the family on screen.</h3>
              <p>
                The office screen shows the family's photo, the kids linked to that car, and
                whether the driver is allowed to pick up.  Custody flags and blocked drivers
                light up before the car reaches the door.
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
              <h3>One tap signs the kid out.</h3>
              <p>
                Staff taps once to confirm.  The pickup is signed, time-stamped, and tied to
                the car, the adult, and the staff member.  If something doesn't match, an
                override is one tap — and the override is logged with a reason.
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
            One tool. Three groups it helps.
          </h2>

          <div className="web-aud-grid">
            <div className="web-aud">
              <span className="role">Parents & guardians</span>
              <h3>Set it up once. Stop arriving early.</h3>
              <ul>
                <li>Add your children, your cars, and the people allowed to pick up — with photos, in your own account.</li>
                <li>Each adult is a separate record — co-parents, grandparents, sitters, friends.  Remove anyone any time.</li>
                <li>You see the moment your child is signed out, by whom, and into which car.</li>
                <li>No more leaving work an hour early to beat the line — or sitting in it when you don't.</li>
              </ul>
              <div className="sig">→ You always know who picked up your child.</div>
            </div>

            <div className="web-aud">
              <span className="role">Front-office staff</span>
              <h3>No more clipboard.</h3>
              <ul>
                <li>A live screen shows every car as it pulls up — the photo, the kids linked to that car, and whether the driver is allowed.</li>
                <li>Cars with more than one child show all of them together, so you sign them out in one go.  Custody flags and blocked drivers turn red on screen.</li>
                <li>Every pickup is signed, time-stamped, and tied to a real adult.  Overrides are logged with a reason.</li>
              </ul>
              <div className="sig">→ Less guessing. Less stress.</div>
            </div>

            <div className="web-aud">
              <span className="role">Administrators</span>
              <h3>A record you can show the school board.</h3>
              <ul>
                <li>Every pickup is time-stamped and tied to a license plate, an adult, and a staff member.</li>
                <li>Roll out across one school or many.  Five permission levels (super-admin, district-admin, school-admin, staff, and scanner), scoped per school.</li>
                <li>Reports show peak times, wait windows, and pickup methods.  How long records are kept is up to your district.</li>
              </ul>
              <div className="sig">→ Every pickup is on the record.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Feature mosaic ──────────────────────────── */}
      <section id="features" aria-labelledby="features-heading">
        <div className="web-site">
          <span className="web-eyebrow">What's inside</span>
          <h2 id="features-heading" className="web-section-title">
            What's inside Dismissal.
          </h2>
          <p className="web-section-sub">
            Eight features, each doing one thing well — so the line keeps moving instead
            of waiting on one big screen to do everything.
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
                <h3>Reads license plates at the curb</h3>
                <p>A camera at each pickup zone reads license plates the moment cars arrive.  Staff sees the family on screen before the car reaches the door.  Cars the system isn't sure about show up as "unrecognized" for one-tap manual confirm.</p>
              </div>
              <div className="web-ph">
                <svg
                  className="web-ph-svg"
                  viewBox="0 0 320 140"
                  role="img"
                  aria-label="A camera on a pole reads a car's license plate as it pulls up to the curb."
                >
                  {/* Camera pole */}
                  <line x1="50" y1="40" x2="50" y2="118" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  {/* Camera body */}
                  <rect x="30" y="22" width="44" height="22" rx="4" fill="var(--bg-surface)" stroke="currentColor" strokeWidth="2" />
                  {/* Camera lens */}
                  <circle cx="60" cy="33" r="5" fill="currentColor" />
                  {/* Recognition beam — dashed arc from camera to plate */}
                  <path d="M 78 38 Q 145 55 210 92" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 4" fill="none" opacity="0.55" />
                  {/* Curb / ground line */}
                  <line x1="0" y1="118" x2="320" y2="118" stroke="currentColor" strokeWidth="1" opacity="0.3" />
                  {/* Car body */}
                  <path d="M 132 96 L 148 76 L 222 76 L 240 96 L 288 96 Q 294 96 294 102 L 294 110 Q 294 116 288 116 L 132 116 Q 126 116 126 110 L 126 102 Q 126 96 132 96 Z"
                        fill="var(--brand-subtle)" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                  {/* Windshield divider */}
                  <line x1="185" y1="76" x2="185" y2="96" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
                  {/* Wheels */}
                  <circle cx="156" cy="116" r="9" fill="var(--bg-surface)" stroke="currentColor" strokeWidth="2" />
                  <circle cx="264" cy="116" r="9" fill="var(--bg-surface)" stroke="currentColor" strokeWidth="2" />
                  {/* License plate */}
                  <rect x="196" y="94" width="36" height="13" rx="2" fill="var(--bg-surface)" stroke="currentColor" strokeWidth="1.5" />
                  <text x="214" y="103" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="8" fill="currentColor" fontWeight="600">7VLM 482</text>
                  {/* Green confirmation badge */}
                  <circle cx="248" cy="100" r="7" fill="var(--green-strong)" />
                  <path d="M 244 100 L 247 103 L 252 97" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="cap">Recognized at the curb</span>
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
                <h3>List of who's allowed to pick up</h3>
                <p>Parents add the adults allowed to pick up — co-parents, grandparents, sitters, friends — each with a photo, each easy to remove.  If a court has said someone is not allowed near a child, that car turns red on the office screen before it reaches the door.</p>
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
                <h3>Cameras that install themselves</h3>
                <p>The cameras come ready to mount outside, with their own power and internet built in.  No wires across the parking lot.  No campus IT work.  They install where wires don't reach.</p>
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
                <h3>Sign-out with one tap</h3>
                <p>The license plate, the adult, and which kids are linked all show on screen before staff confirms.  If anything doesn't match, an override is one tap — and every override is logged with a reason.</p>
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
                <h3>One car, several kids</h3>
                <p>If one car picks up more than one child, all of them show together on the office screen.  Staff signs them all out in one go.</p>
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
                <h3>Reports for principals</h3>
                <p>See your busiest minutes, a chart of how long parents wait, how families pick up (car, walk, bus), and a heatmap of the last 28 days.  So you know whether to add a staff member at the curb or move the bell.</p>
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
                <h3>A record of every pickup</h3>
                <p>Every pickup, and every override, is signed, time-stamped, and ready to export.  How long records are kept is up to your district.</p>
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
                <h3>Stays in sync with your student system</h3>
                <p>Updates the class roster every night from your school's student information system, using the standards your district already uses.  No double entry.  No out-of-date class lists.</p>
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
          <h2 id="timeline-heading" className="web-section-title">What a typical Tuesday looks like.</h2>
          <p className="web-section-sub">
            18 minutes from first car to last car out.  No staging lap around the block.
            No idling line down the street.
          </p>

          <div className="web-timeline">
            <div className="web-tl-row">
              <div className="web-tl-time">3:14 PM</div>
              <div className="web-tl-event">
                <h3>The bell rings. Pickup is open.</h3>
                <p>The curb cameras switch on.  The office opens the pickup screen.  Today's class list is already loaded — it synced from the school's student system last night.</p>
              </div>
              <div className="web-tl-meta">— front loop, upper lot, loading dock</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:16 PM</div>
              <div className="web-tl-event">
                <h3>The first car arrives.</h3>
                <p>7VLM 482 pulls up.  The camera reads it right away.  Carla R appears on the office screen as the main guardian, with her two kids — Maya (grade 4) and Theo (grade 2) — already linked.</p>
              </div>
              <div className="web-tl-meta">— matched at the curb</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:18 PM</div>
              <div className="web-tl-event">
                <h3>Tap to sign out.</h3>
                <p>Staff taps once to confirm.  The record is saved: "Picked up · 7VLM 482 · J. Reyes · 3:18:42 PM · 2 students."  Carla pulls forward.  The next car pulls in.</p>
              </div>
              <div className="web-tl-meta">— signed and time-stamped</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:24 PM</div>
              <div className="web-tl-event">
                <h3>An unfamiliar car shows up.</h3>
                <p>The car shows up as "unrecognized."  The office calls Carla, confirms her sister-in-law is on the approved list, and taps "Override and Pick up."  The override is saved with the reason — and stays in the record from then on.</p>
              </div>
              <div className="web-tl-meta">— flagged amber, override logged</div>
            </div>
            <div className="web-tl-row">
              <div className="web-tl-time">3:32 PM</div>
              <div className="web-tl-event">
                <h3>Last car out. Pickup is closed.</h3>
                <p>The day's record is locked.  The reports update with today's wait times and the share of pickups that needed an override.  Staff head back inside to a quieter afternoon.</p>
              </div>
              <div className="web-tl-meta">— 184 students signed out</div>
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
                Handing a child to the right adult is the most important thing a school does
                each afternoon.  It used to take walkie-talkies, paper hangtags, and an
                hour-long line that started before the bell.  We built Dismissal because the
                staff member at the curb shouldn't have to guess, and the family in the car
                shouldn't have to lose their afternoon to a process.  The right answer is in
                front of staff in under a second — and there's a clean record of it that
                holds up later.
              </p>
              <div className="web-quote-meta">
                <div className="web-qm-av">D</div>
                <div>
                  <div className="web-qm-name">From the Dismissal team</div>
                  <div className="web-qm-role">Built with K–12 principals and office staff</div>
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
              <div className="lbl">car-to-family match before the car reaches the door — so the line never forms.</div>

              <div className="web-metric-grid">
                <div className="mc"><div className="n">1hr</div><div className="l">handed back to each family, every school afternoon</div></div>
                <div className="mc"><div className="n">5</div><div className="l">permission levels, scoped per school</div></div>
                <div className="mc"><div className="n">1y</div><div className="l">how long records are kept by default (your district sets it)</div></div>
                <div className="mc"><div className="n">100%</div><div className="l">of pickups are signed, time-stamped, and ready to export</div></div>
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
              <span className="web-eyebrow">Built to be trusted</span>
              <h2 id="security-heading" className="web-section-title">
                Built to keep student data safe.
              </h2>
              <p className="web-section-sub">
                Time back doesn't mean records out.  Every action is signed.  Every device
                is enrolled.  Every change to the roster is on the record.  And how long
                records are kept is a setting, not our default.
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
                  <span className="ttl">Follows FERPA student-privacy rules</span>
                </div>
                <p>We store as little personal data as possible, we encrypt it on disk, and your district decides how long license-plate records, pickup logs, and student records are kept.</p>
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
                  <span className="ttl">Each person sees only what they should</span>
                </div>
                <p>Five permission levels: super-admin, district-admin, school-admin, staff, and scanner.  Each is scoped per school, so a substitute sees today's roster while a district admin sees the whole year.</p>
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
                  <span className="ttl">You decide how long records are kept</span>
                </div>
                <p>Pickup records are kept for 365 days by default — your district can change that.  License-plate records move to a one-year archive every night.  Set the windows your school's policies require.</p>
              </div>

              <a href="/trust" className="web-btn web-btn-ghost" style={{ alignSelf: "flex-start", marginTop: 4 }}>
                See our full security details <ArrowRight />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────── */}
      <section id="pricing" aria-labelledby="pricing-heading">
        <div className="web-site">
          <span className="web-eyebrow">Common questions</span>
          <h2 id="pricing-heading" className="web-section-title">Common questions.</h2>

          <div className="web-faq" style={{ marginTop: 36 }}>
            <div>
              <p style={{
                color: "var(--text-secondary)", fontSize: 14,
                lineHeight: 1.55, maxWidth: 360, margin: 0,
              }}>
                If your question isn't here, email us.  A real person will write back.
              </p>
              <a href="#cta" className="web-btn web-btn-ghost" style={{ marginTop: 16 }}>
                Ask us anything →
              </a>
            </div>

            <div>
              <div className="web-q">
                <h3>Doesn't this just speed up the line? <span className="pl">+</span></h3>
                <p>It collapses it.  Most of pickup time isn't the line itself — it's the hour parents arrive early to beat the line, and the traffic the line creates on the way home.  When the office knows the family before the car reaches the door, the line never forms, and the hour-early arrival stops being necessary.</p>
              </div>
              <div className="web-q">
                <h3>Do we need to install cameras? <span className="pl">+</span></h3>
                <p>Yes.  Most schools start with one camera at each pickup spot.  We supply the cameras and work with you on install timing.  Every school's pickup layout is different, so we plan it together.</p>
              </div>
              <div className="web-q">
                <h3>Do the cameras need WiFi? <span className="pl">+</span></h3>
                <p>No.  The cameras have their own internet built in.  No campus network drop and no digging across the parking lot.</p>
              </div>
              <div className="web-q">
                <h3>What if a parent doesn't have a smartphone? <span className="pl">+</span></h3>
                <p>The camera reads the car, not the driver's phone, so there's no app to install.  Parents who prefer paper can register their car at the school office and updates work the same way.</p>
              </div>
              <div className="web-q">
                <h3>How do you handle divorced parents and custody rules? <span className="pl">+</span></h3>
                <p>Each adult is a separate record with their own permissions.  Schools can require the main guardian's approval before a different adult can pick up.  If a court has said someone is not allowed near a child, that car turns red on the office screen before it reaches the door.</p>
              </div>
              <div className="web-q">
                <h3>What if a car isn't recognized? <span className="pl">+</span></h3>
                <p>The car shows up on screen as "unrecognized," with a photo and (when possible) a best-guess match.  Staff checks the approved list, signs the kid out with an override, and the override is signed and logged with a reason.</p>
              </div>
              <div className="web-q">
                <h3>How much does it cost? <span className="pl">+</span></h3>
                <p>You pay per student, per year, plus a one-time fee for the cameras.  We don't charge per parent or per device, and we never sell student data.  Larger districts pay less per student — happy to share exact numbers on a call.</p>
              </div>
              <div className="web-q">
                <h3>How long before we're up and running? <span className="pl">+</span></h3>
                <p>We plan the timing with each school.  A single-school pilot — installing the cameras, syncing the class roster, and a one-afternoon staff training — usually takes a few weeks.  District rollouts depend on how many schools are joining.</p>
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
            <h2 id="cta-heading">Get your school running by next month.</h2>
            <p className="lede">
              A 20-minute demo, a walk through your school's pickup setup, and an honest plan
              for a pilot.  Twenty minutes now.  Hundreds of afternoons back for your
              families.
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
              <p>School pickup, made simple.  Built for districts and private schools that want shorter pickup lines and better records.</p>
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
            <div className="dots"><span className="dot" /> Built with K–12 school teams</div>
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
