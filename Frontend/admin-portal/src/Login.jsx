import React, { useState, useEffect } from "react";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "firebase/auth";
import { auth, googleProvider, microsoftProvider } from "./firebase-config";
import axios from "axios";
import { I } from "./components/icons";
import { BrandIcon, BrandWordmark } from "./components/Brand";
import { formatApiError } from "./utils";
import "./Login.css";

/* ── Login — split-panel hero + form ────────────────────
   Refresh layout: 1.1fr editorial hero on the left, 1fr form panel on
   the right.  Hero panel is dark with radial-gradient atmosphere
   (cyan + violet) and a 4px scanline overlay; form panel hosts the
   three modes (login / signup / reset) — the hero stays put, only the
   form content swaps.

   All three flows from v1 are preserved: email+password sign-in,
   Google / Microsoft SSO with the same handleSsoLogin error shaping,
   guardian signup against /api/v1/auth/guardian-signup, and password
   reset via Firebase sendPasswordResetEmail.  The only thing that
   changed is the rendered UI.
   ────────────────────────────────────────────────────── */

export default function Login() {
  // Pin the login page to light theme regardless of the previously-
  // stored preference.  The site's default surface is light; the
  // citrus brand accents on the hero gradient read against that
  // canvas as the canonical look.  Restored on unmount so a returning
  // user who had picked dark sees their preference once signed in.
  useEffect(() => {
    const prev = document.body.getAttribute("data-theme");
    document.body.setAttribute("data-theme", "light");
    return () => {
      if (prev) document.body.setAttribute("data-theme", prev);
      else document.body.removeAttribute("data-theme");
    };
  }, []);

  const [mode, setMode] = useState("login"); // "login" | "signup" | "reset"

  // Login fields
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError]       = useState("");

  // SSO state
  const [ssoError, setSsoError] = useState("");
  const [ssoBusy,  setSsoBusy]  = useState(null); // "google" | "microsoft" | null

  // Signup fields
  const [signupName,     setSignupName]     = useState("");
  const [signupEmail,    setSignupEmail]    = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirm,  setSignupConfirm]  = useState("");
  const [signupLoading,  setSignupLoading]  = useState(false);
  const [signupError,    setSignupError]    = useState("");

  // Reset fields
  const [resetEmail,   setResetEmail]   = useState("");
  const [resetMsg,     setResetMsg]     = useState("");
  const [resetSending, setResetSending] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      // "Keep me signed in" maps to Firebase persistence: local persists
      // across browser restarts (default), session ends with the tab.
      // Set this BEFORE signInWithEmailAndPassword so the very first
      // token issued already follows the chosen lifetime.
      await setPersistence(
        auth,
        keepSignedIn ? browserLocalPersistence : browserSessionPersistence,
      );
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError("Invalid login. Check your credentials.");
      console.error(err);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setSignupError("");
    if (signupPassword !== signupConfirm) {
      setSignupError("Passwords do not match.");
      return;
    }
    if (signupPassword.length < 8) {
      setSignupError("Password must be at least 8 characters.");
      return;
    }
    setSignupLoading(true);
    try {
      await axios.post(`/api/v1/auth/guardian-signup`, {
        email: signupEmail,
        password: signupPassword,
        display_name: signupName,
      });
      // Auto sign in after successful signup
      await signInWithEmailAndPassword(auth, signupEmail, signupPassword);
    } catch (err) {
      setSignupError(formatApiError(err, "Signup failed. Please try again."));
    } finally {
      setSignupLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setResetMsg("");
    setResetSending(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail);
      setResetMsg("Reset email sent — check your inbox.");
    } catch (err) {
      setResetMsg("Could not send reset email. Check the address and try again.");
      console.error(err);
    } finally {
      setResetSending(false);
    }
  };

  // Federated sign-in.  onIdTokenChanged in App.jsx takes it from
  // here — role resolution (SSO-auto-provisioned admin vs. pending
  // guardian) happens server-side in verify_firebase_token.
  const handleSsoLogin = async (providerKey) => {
    setSsoError("");
    setSsoBusy(providerKey);
    try {
      const provider = providerKey === "google" ? googleProvider() : microsoftProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = err?.code || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // User backed out of the provider popup — not an error worth surfacing.
        return;
      }
      if (code === "auth/account-exists-with-different-credential") {
        setSsoError(
          "An account with this email already exists under a different sign-in method. " +
          "Sign in with your original method, then link this provider from your profile.",
        );
        return;
      }
      setSsoError(
        err?.message?.replace(/^Firebase:\s*/, "") ||
          "Sign-in failed. Try again or use email and password.",
      );
      console.error("SSO sign-in error:", err);
    } finally {
      setSsoBusy(null);
    }
  };

  return (
    <div className="login-shell">

      {/* ── Hero panel ─────────────────────────────────── */}
      <aside className="login-hero" aria-hidden="true">
        <div className="login-hero-grain" />

        <div className="login-hero-brand">
          <BrandIcon className="login-hero-mark" aria-hidden="true" />
          <BrandWordmark className="login-hero-word" aria-hidden="true" />
        </div>

        <div className="login-hero-body">
          <span className="t-eyebrow login-hero-eyebrow">
            Modern school dismissal.
          </span>
          <h1 className="login-hero-headline">
            Pickup, <em className="login-hero-em">perfected</em>.
          </h1>
          <p className="login-hero-sub">
            A live pickup queue, scoped roles for every team, and a
            verified handoff your staff actually trusts. From the curb to
            the classroom — without a clipboard.
          </p>
        </div>

        <div className="login-hero-stats">
          <div className="login-hero-stat">
            <div className="login-hero-stat-value t-num">Live</div>
            <div className="t-eyebrow login-hero-stat-label">Real-time pickup queue</div>
          </div>
          <div className="login-hero-stat">
            <div className="login-hero-stat-value t-num">Roles</div>
            <div className="t-eyebrow login-hero-stat-label">Scoped per school</div>
          </div>
          <div className="login-hero-stat">
            <div className="login-hero-stat-value t-num">FERPA</div>
            <div className="t-eyebrow login-hero-stat-label">Built to support compliance</div>
          </div>
        </div>
      </aside>

      {/* ── Form panel ─────────────────────────────────── */}
      <main className="login-form-wrap" role="main">
        <a href="/" className="login-back" aria-label="Back to dismissal.app home">
          <I.arrowLeft size={14} stroke={2.2} aria-hidden="true" />
          <span>Back to site</span>
        </a>
        {/* Wordmark above the form — visible at every viewport, but
            most load-bearing on narrow widths where the editorial
            hero panel collapses out and the form needs its own brand
            anchor. */}
        <BrandWordmark className="login-form-wordmark" aria-hidden="true" />
        <div className="login-form-card">

          {mode === "login" && (
            <>
              <span className="t-eyebrow login-form-eyebrow">
                Sign in · staff portal
              </span>
              <h2 className="login-form-title">Welcome back.</h2>
              <p className="login-form-sub">
                Use your school-issued credentials or single sign-on.
              </p>

              <form onSubmit={handleLogin}>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="login-email">E-mail</label>
                  <input
                    id="login-email"
                    type="email"
                    className="login-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    aria-describedby={error ? "login-error-msg" : undefined}
                  />
                </div>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="login-password">Password</label>
                  <input
                    id="login-password"
                    type="password"
                    className="login-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    aria-describedby={error ? "login-error-msg" : undefined}
                  />
                </div>

                {/* Persistence toggle + reset-password link.  Keep-signed-in
                    is the default so a power-cycle of the kiosk doesn't
                    boot the staff back to the login screen mid-shift; the
                    handler maps this to Firebase's local vs session
                    persistence before the credential exchange. */}
                <div className="login-row">
                  <label className="login-keep">
                    <input
                      type="checkbox"
                      checked={keepSignedIn}
                      onChange={(e) => setKeepSignedIn(e.target.checked)}
                    />
                    Keep me signed in
                  </label>
                  <button
                    type="button"
                    className="login-link"
                    onClick={() => { setMode("reset"); setResetMsg(""); }}
                  >
                    Forgot password?
                  </button>
                </div>

                {error && <p id="login-error-msg" className="login-error" role="alert">{error}</p>}
                <button type="submit" className="login-submit">
                  Sign in
                  <I.arrowRight size={14} stroke={2.2} aria-hidden="true" />
                </button>
              </form>

              <div className="login-divider" role="separator" aria-label="or continue with single sign-on">
                <span className="login-divider-line" />
                <span className="t-section">or</span>
                <span className="login-divider-line" />
              </div>

              {/* SSO under the divider — most staff use email/password,
                  so SSO sits below as the alternative.  Provider buttons
                  share visual weight; the unfinished integrations are
                  rendered disabled with a "Soon" tag.

                  Brand-logo a11y note: the Google and Microsoft glyph
                  fills are deliberately the canonical brand hex values
                  (Google blue/green/yellow/red, Microsoft Fluent four-tile)
                  and are NOT swept into the [data-palette="colorblind"]
                  Okabe-Ito overrides.  WCAG 2.2 1.4.11 explicitly exempts
                  logotypes from non-text contrast / palette rules
                  ("Text that is part of a logo or brand name has no
                  contrast requirement"), and both vendors' brand guidelines
                  require their marks to render in the canonical colors.
                  The buttons themselves carry visible text plus aria-label,
                  so colorblind / screen-reader users identify the provider
                  by name regardless of how the brand glyphs render. */}
              <div className="login-sso" role="group" aria-label="Single sign-on">
                <button
                  type="button"
                  className="login-sso-btn"
                  onClick={() => handleSsoLogin("google")}
                  disabled={ssoBusy !== null}
                  aria-label="Sign in with Google"
                >
                  <svg className="login-sso-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 18 18">
                    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/>
                    <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
                    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                  </svg>
                  {ssoBusy === "google" ? "Opening…" : "Continue with Google"}
                </button>

                <button
                  type="button"
                  className="login-sso-btn"
                  onClick={() => handleSsoLogin("microsoft")}
                  disabled={ssoBusy !== null}
                  aria-label="Sign in with Microsoft"
                >
                  <svg className="login-sso-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 18 18">
                    <rect x="0"  y="0"  width="8" height="8" fill="#F25022"/>
                    <rect x="10" y="0"  width="8" height="8" fill="#7FBA00"/>
                    <rect x="0"  y="10" width="8" height="8" fill="#00A4EF"/>
                    <rect x="10" y="10" width="8" height="8" fill="#FFB900"/>
                  </svg>
                  {ssoBusy === "microsoft" ? "Opening…" : "Continue with Microsoft"}
                </button>

                <button
                  type="button"
                  className="login-sso-btn login-sso-btn-soon"
                  disabled
                  title="Clever integration coming soon"
                  aria-label="Clever sign-in (coming soon)"
                >
                  Clever — coming soon
                </button>
              </div>

              {ssoError && (
                <p className="login-error" role="alert">{ssoError}</p>
              )}

              <div className="login-signup-prompt">
                New to Dismissal?{" "}
                <button
                  type="button"
                  className="login-link login-link-brand"
                  onClick={() => { setMode("signup"); setSignupError(""); }}
                >
                  Create a guardian account →
                </button>
              </div>
            </>
          )}

          {mode === "signup" && (
            <>
              <span className="t-eyebrow login-form-eyebrow">
                Create account · guardian
              </span>
              <h2 className="login-form-title">Sign up to manage pickup.</h2>
              <p className="login-form-sub">
                Add your children and vehicles so school staff can wave you
                through the curb.
              </p>

              <form onSubmit={handleSignup}>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="signup-name">Full name</label>
                  <input
                    id="signup-name"
                    type="text"
                    className="login-input"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    required
                    autoComplete="name"
                    autoFocus
                    placeholder="Jane Doe"
                  />
                </div>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="signup-email">E-mail</label>
                  <input
                    id="signup-email"
                    type="email"
                    className="login-input"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="jane@example.com"
                  />
                </div>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="signup-password">Password</label>
                  <input
                    id="signup-password"
                    type="password"
                    className="login-input"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    aria-describedby="signup-password-hint"
                  />
                  <span id="signup-password-hint" className="sr-only">
                    Must be at least 8 characters.
                  </span>
                </div>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="signup-confirm">Confirm password</label>
                  <input
                    id="signup-confirm"
                    type="password"
                    className="login-input"
                    value={signupConfirm}
                    onChange={(e) => setSignupConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                {signupError && <p className="login-error" role="alert">{signupError}</p>}
                <button type="submit" className="login-submit" disabled={signupLoading}>
                  {signupLoading ? "Creating account…" : "Create account"}
                  {!signupLoading && <I.arrowRight size={14} stroke={2.2} aria-hidden="true" />}
                </button>
              </form>

              <div className="login-signup-prompt">
                Already have an account?{" "}
                <button
                  type="button"
                  className="login-link login-link-brand"
                  onClick={() => { setMode("login"); setSignupError(""); }}
                >
                  Sign in →
                </button>
              </div>
            </>
          )}

          {mode === "reset" && (
            <>
              <span className="t-eyebrow login-form-eyebrow">
                Reset · password
              </span>
              <h2 className="login-form-title">Forgot your password?</h2>
              <p className="login-form-sub">
                We'll email you a link to reset it.
              </p>

              <form onSubmit={handleReset}>
                <div className="login-field">
                  <label className="login-label t-eyebrow" htmlFor="reset-email">Account email</label>
                  <input
                    id="reset-email"
                    type="email"
                    className="login-input"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                  />
                </div>
                {resetMsg && (
                  <p
                    className={resetMsg.startsWith("Reset email") ? "login-success" : "login-error"}
                    role={resetMsg.startsWith("Reset email") ? "status" : "alert"}
                  >
                    {resetMsg}
                  </p>
                )}
                <button type="submit" className="login-submit" disabled={resetSending}>
                  {resetSending ? "Sending…" : "Send reset link"}
                  {!resetSending && <I.arrowRight size={14} stroke={2.2} aria-hidden="true" />}
                </button>
              </form>

              <div className="login-links">
                <button
                  type="button"
                  className="login-link"
                  onClick={() => { setMode("login"); setResetMsg(""); }}
                  aria-label="Back to sign in"
                >
                  ← Back to sign in
                </button>
              </div>
            </>
          )}

        </div>
      </main>
    </div>
  );
}
