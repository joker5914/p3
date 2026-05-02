import { useEffect, useState } from "react";
import "./Website.css";
import "./Trust.css";
import "./Verify.css";

/* ── Verify page — public receipt authenticity check ──────────────────
   QR codes on the chain-of-custody PDF (issue #72) point at
   /verify/{receiptId}.  This page runs as part of the same SPA, but
   does *not* require sign-in: the backend's /api/v1/verify/{id}
   endpoint is on the public router and returns no PII regardless of
   the signature outcome.

   The page is intentionally read-only and minimal:
     - One status banner ("verified" / "could not be verified")
     - A small set of cross-checkable facts (issue date, location, school)
     - No login prompt, no nav, no CTAs that take a parent away from the
       receipt they are holding.

   AAA accessibility posture:
     * The verdict is announced via a polite live region while loading
       and switches to role="alert" / role="status" once resolved so the
       result is announced exactly once when it lands.
     * The colour cues (green / red) are paired with text *and* an icon
       so a colourblind reader doesn't have to decode hue alone — the
       per-deficiency palettes inherited from index.css already remap
       these tokens, but the redundant signalling is the point.
     * Focus is moved to the verdict on first render so a keyboard
       arrival lands at the answer.
     * A "back to school" link is provided so a parent who landed here
       by typing the URL has somewhere to go.
   ────────────────────────────────────────────────────────────────── */

const PATH_PREFIX = "/verify/";

function ShieldCheck() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ShieldAlert() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
      <path d="M12 8v5" />
      <circle cx="12" cy="16" r="0.6" fill="currentColor" />
    </svg>
  );
}

function fmtTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "long",
      year:   "numeric",
      month:  "long",
      day:    "numeric",
      hour:   "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

function readReceiptIdFromPath() {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  if (!path.startsWith(PATH_PREFIX)) return null;
  // Strip trailing slash + any query / hash residue.
  const tail = path.slice(PATH_PREFIX.length).split(/[?#/]/)[0].trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(tail)) return null;
  return tail;
}

export default function Verify() {
  // Marketing-page styling — locked to light/citrus so the verify
  // page presents as a public document rather than the authenticated
  // portal.  Mirrors Trust.jsx + Website.jsx.
  useEffect(() => {
    const body = document.body;
    const prev = {
      theme:   body.getAttribute("data-theme"),
      palette: body.getAttribute("data-palette"),
      type:    body.getAttribute("data-type"),
      density: body.getAttribute("data-density"),
    };
    body.setAttribute("data-theme",   "light");
    body.setAttribute("data-palette", "default");
    body.setAttribute("data-type",    "geist");
    body.setAttribute("data-density", "comfortable");
    return () => {
      if (prev.theme)   body.setAttribute("data-theme",   prev.theme);
      if (prev.palette) body.setAttribute("data-palette", prev.palette);
      if (prev.type)    body.setAttribute("data-type",    prev.type);
      if (prev.density) body.setAttribute("data-density", prev.density);
    };
  }, []);

  const [receiptId] = useState(() => readReceiptIdFromPath());
  // status: "loading" | "ok" | "invalid" | "error" | "missing"
  const [status, setStatus] = useState(receiptId ? "loading" : "missing");
  const [data, setData] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!receiptId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/v1/verify/${receiptId}`, {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (!resp.ok) {
          // 4xx malformed-id flow — the backend treats these as caller
          // error rather than verification failure.  Surface as
          // "invalid id" so a typo gets a clearer message than the
          // signature-mismatch wording reserved for fabricated pages.
          if (resp.status === 400) {
            setStatus("missing");
            return;
          }
          setStatus("error");
          setErrorMsg(`Verification service returned HTTP ${resp.status}.`);
          return;
        }
        const body = await resp.json();
        setData(body);
        setStatus(body?.ok ? "ok" : "invalid");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err?.message || "Network error contacting verification service.");
      }
    })();
    return () => { cancelled = true; };
  }, [receiptId]);

  // Move keyboard focus to the verdict heading once the result is
  // known so the announcement and the focus arrive at the same place.
  useEffect(() => {
    if (status === "loading") return;
    const heading = document.getElementById("verify-verdict-heading");
    if (heading && typeof heading.focus === "function") {
      heading.focus();
    }
  }, [status]);

  const isOk = status === "ok";
  const isLoading = status === "loading";

  return (
    <div className="verify-page">
      {/* Skip link — visible only on focus (sr-only/sr-show pattern) */}
      <a href="#verify-main" className="sr-only sr-show-on-focus">
        Skip to verification result
      </a>

      <header className="verify-header">
        <a href="/" className="verify-brand" aria-label="Dismissal home">
          <span className="verify-brand-mark" aria-hidden="true">D</span>
          <span className="verify-brand-word">Dismissal</span>
        </a>
        <span className="verify-eyebrow">Pickup receipt verification</span>
      </header>

      <main id="verify-main" className="verify-main">
        <section
          className={`verify-card verify-card-${
            isLoading ? "loading"
            : isOk ? "ok"
            : "warn"
          }`}
          aria-labelledby="verify-verdict-heading"
        >
          {isLoading ? (
            <>
              <div className="verify-icon" aria-hidden="true"><ShieldCheck /></div>
              <h1
                id="verify-verdict-heading"
                tabIndex={-1}
                className="verify-headline"
              >
                Checking signature…
              </h1>
              <p className="verify-lede" role="status" aria-live="polite">
                Confirming the cryptographic signature on this receipt.
                This usually takes a moment.
              </p>
            </>
          ) : status === "missing" ? (
            <>
              <div className="verify-icon verify-icon-warn" aria-hidden="true"><ShieldAlert /></div>
              <h1
                id="verify-verdict-heading"
                tabIndex={-1}
                className="verify-headline"
              >
                That doesn't look like a receipt link.
              </h1>
              <p className="verify-lede" role="status">
                Receipt URLs end with a 16-character code. If you scanned a
                QR code from a printed receipt and landed here, the code may
                have been entered manually with a typo. Try scanning again,
                or contact the school office for a fresh copy.
              </p>
            </>
          ) : status === "error" ? (
            <>
              <div className="verify-icon verify-icon-warn" aria-hidden="true"><ShieldAlert /></div>
              <h1
                id="verify-verdict-heading"
                tabIndex={-1}
                className="verify-headline"
              >
                Verification couldn't run right now.
              </h1>
              <p className="verify-lede" role="alert">
                {errorMsg ||
                  "We couldn't reach the verification service. Try again in a few minutes, or contact the school for confirmation."}
              </p>
            </>
          ) : isOk ? (
            <>
              <div className="verify-icon verify-icon-ok" aria-hidden="true"><ShieldCheck /></div>
              <h1
                id="verify-verdict-heading"
                tabIndex={-1}
                className="verify-headline"
              >
                <span className="verify-badge">Verified</span>
                {" "}This receipt is authentic.
              </h1>
              <p className="verify-lede" role="status">
                The cryptographic signature on this page matches a real
                pickup record kept by the school. The details below
                should match what's printed on the receipt you have in
                hand.
              </p>
              <dl className="verify-meta">
                <div>
                  <dt>School</dt>
                  <dd>{data?.school_name || "—"}</dd>
                </div>
                <div>
                  <dt>Pickup date &amp; time</dt>
                  <dd>{fmtTime(data?.scan_timestamp) || "—"}</dd>
                </div>
                <div>
                  <dt>Pickup location</dt>
                  <dd>{data?.location || "—"}</dd>
                </div>
                <div>
                  <dt>Receipt issued</dt>
                  <dd>{fmtTime(data?.issued_at) || "—"}</dd>
                </div>
                <div>
                  <dt>Receipt ID</dt>
                  <dd className="verify-mono">{data?.receipt_id || receiptId}</dd>
                </div>
                <div>
                  <dt>Verified at</dt>
                  <dd>{fmtTime(data?.verified_at) || "—"}</dd>
                </div>
              </dl>
            </>
          ) : (
            <>
              <div className="verify-icon verify-icon-warn" aria-hidden="true"><ShieldAlert /></div>
              <h1
                id="verify-verdict-heading"
                tabIndex={-1}
                className="verify-headline"
              >
                <span className="verify-badge verify-badge-warn">Not verified</span>
                {" "}This receipt could not be verified.
              </h1>
              <p className="verify-lede" role="alert">
                Either the receipt was edited after it was issued, the QR
                code was photographed from a different page, or the
                receipt id was typed incorrectly. If you received this
                receipt directly from the school, please contact the
                front office to have a fresh copy issued.
              </p>
              <p className="verify-fineprint">
                Receipt ID: <span className="verify-mono">{receiptId || "—"}</span>
              </p>
            </>
          )}
        </section>

        <section className="verify-explainer" aria-label="About this verification">
          <h2 className="verify-h2">What does this page check?</h2>
          <ul className="verify-bullets">
            <li>
              <strong>Signature integrity.</strong> Each receipt is signed
              with HMAC-SHA256 using a secret key held only by the school's
              backend. Re-deriving a matching signature without that key is
              not feasible.
            </li>
            <li>
              <strong>No personal data is shown here.</strong> Student
              names, guardian names, and the full plate number stay on the
              printed receipt only. This page confirms that the page came
              from the school's system and was not edited afterwards.
            </li>
            <li>
              <strong>Privacy by default.</strong> If a stranger scans the
              QR code, they see the verdict, the school name, the time,
              and the pickup location. Nothing else.
            </li>
          </ul>
        </section>
      </main>

      <footer className="verify-footer">
        <p>
          Need help? Contact the school directly using the phone number
          on the receipt. For accessibility issues with this page, write
          to <a href="mailto:accessibility@dismissal.app">accessibility@dismissal.app</a>.
        </p>
        <p className="verify-fineprint">
          © {new Date().getFullYear()} Dismissal · <a href="/">Home</a>
        </p>
      </footer>
    </div>
  );
}
