import React, { useState, useEffect } from "react";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
} from "firebase/auth";
import { auth, googleProvider, microsoftProvider } from "./firebase-config";
import axios from "axios";
import "./Login.css";

export default function Login() {
  // Strip any lingering dark/light theme so the login page always looks the same.
  // The Navbar's useTheme hook will re-apply the user's preference after sign-in.
  useEffect(() => {
    const prev = document.body.getAttribute("data-theme");
    document.body.removeAttribute("data-theme");
    return () => {
      if (prev) document.body.setAttribute("data-theme", prev);
    };
  }, []);

  const [mode, setMode] = useState("login"); // "login" | "signup" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [ssoError, setSsoError] = useState("");
  const [ssoBusy, setSsoBusy] = useState(null); // "google" | "microsoft" | null

  // Signup fields
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirm, setSignupConfirm] = useState("");
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState("");

  // Reset fields
  const [resetEmail, setResetEmail] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [resetSending, setResetSending] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
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
      const baseURL = import.meta.env.VITE_API_BASE_URL || "";
      await axios.post(`${baseURL}/api/v1/auth/guardian-signup`, {
        email: signupEmail,
        password: signupPassword,
        display_name: signupName,
      });
      // Auto sign in after successful signup
      await signInWithEmailAndPassword(auth, signupEmail, signupPassword);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        setSignupError(detail);
      } else if (Array.isArray(detail)) {
        setSignupError(detail.map((d) => d.msg || d).join(". "));
      } else {
        setSignupError("Signup failed. Please try again.");
      }
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

  // Federated sign-in.  onIdTokenChanged in App.jsx takes it from here —
  // role resolution (SSO-auto-provisioned admin vs. pending guardian)
  // happens server-side in verify_firebase_token.
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
          "Sign in with your original method, then link this provider from your profile."
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
    <div className="login-wrapper">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <div className="login-brand-mark">D</div>
          <span className="login-brand-name">Dismissal</span>
        </div>

        {mode === "login" && (
          <>
            <h1 className="login-title">Log In</h1>

            {/* ── Federated sign-in (issue #88) ─────────────────────
                Shown above the email/password form because for most
                district users SSO is the expected primary path.  Email
                and password stays as a fallback for legacy accounts and
                non-SSO schools. */}
            <div className="sso-buttons" role="group" aria-label="Single sign-on">
              <button
                type="button"
                className="sso-btn sso-btn-google"
                onClick={() => handleSsoLogin("google")}
                disabled={ssoBusy !== null}
                aria-label="Sign in with Google"
              >
                <svg className="sso-btn-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                </svg>
                {ssoBusy === "google" ? "Opening…" : "Continue with Google"}
              </button>

              <button
                type="button"
                className="sso-btn sso-btn-microsoft"
                onClick={() => handleSsoLogin("microsoft")}
                disabled={ssoBusy !== null}
                aria-label="Sign in with Microsoft"
              >
                <svg className="sso-btn-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
                  <rect x="0"  y="0"  width="8" height="8" fill="#F25022"/>
                  <rect x="10" y="0"  width="8" height="8" fill="#7FBA00"/>
                  <rect x="0"  y="10" width="8" height="8" fill="#00A4EF"/>
                  <rect x="10" y="10" width="8" height="8" fill="#FFB900"/>
                </svg>
                {ssoBusy === "microsoft" ? "Opening…" : "Continue with Microsoft"}
              </button>

              {/* Placeholder slots — turned on by follow-up issues once
                  the Clever / ClassLink developer-portal setup is done. */}
              <button
                type="button"
                className="sso-btn sso-btn-coming-soon"
                disabled
                title="Clever integration coming soon"
                aria-label="Clever sign-in (coming soon)"
              >
                Clever <span className="sso-coming-soon-tag">Coming soon</span>
              </button>
              <button
                type="button"
                className="sso-btn sso-btn-coming-soon"
                disabled
                title="ClassLink integration coming soon"
                aria-label="ClassLink sign-in (coming soon)"
              >
                ClassLink <span className="sso-coming-soon-tag">Coming soon</span>
              </button>
            </div>

            {ssoError && (
              <p className="login-error" role="alert" style={{ marginTop: 12 }}>{ssoError}</p>
            )}

            <div className="sso-divider" role="separator" aria-label="or continue with email">
              <span>or</span>
            </div>

            <form onSubmit={handleLogin}>
              <div className="login-field">
                <label className="login-label" htmlFor="login-email">E-mail</label>
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
                <label className="login-label" htmlFor="login-password">Password</label>
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
              {error && <p id="login-error-msg" className="login-error" role="alert">{error}</p>}
              <div className="login-btn-row">
                <button type="submit" className="login-btn">Sign In</button>
              </div>
            </form>
            <div className="login-links">
              <button className="forgot-link" onClick={() => { setMode("reset"); setResetMsg(""); }}>
                Forgot your password?
              </button>
              <div className="login-signup-prompt">
                <span>Parent or guardian?</span>
                <button className="forgot-link" onClick={() => { setMode("signup"); setSignupError(""); }}>
                  Create an account
                </button>
              </div>
            </div>
          </>
        )}

        {mode === "signup" && (
          <>
            <h1 className="login-title">Create Account</h1>
            <p className="login-signup-desc">
              Sign up to manage your children and vehicles for school pickup.
            </p>
            <form onSubmit={handleSignup}>
              <div className="login-field">
                <label className="login-label" htmlFor="signup-name">Full Name</label>
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
                <label className="login-label" htmlFor="signup-email">E-mail</label>
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
                <label className="login-label" htmlFor="signup-password">Password</label>
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
                <label className="login-label" htmlFor="signup-confirm">Confirm Password</label>
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
              <div className="login-btn-row">
                <button type="submit" className="login-btn" disabled={signupLoading}>
                  {signupLoading ? "Creating Account..." : "Create Account"}
                </button>
              </div>
            </form>
            <button className="forgot-link" onClick={() => { setMode("login"); setSignupError(""); }}>
              Already have an account? Sign in
            </button>
          </>
        )}

        {mode === "reset" && (
          <>
            <h1 className="login-title">Reset Password</h1>
            <form onSubmit={handleReset}>
              <div className="login-field">
                <label className="login-label" htmlFor="reset-email">Account email</label>
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
              <div className="login-btn-row">
                <button type="submit" className="login-btn" disabled={resetSending}>
                  {resetSending ? "Sending..." : "Send Reset Link"}
                </button>
              </div>
            </form>
            <button
              className="forgot-link"
              onClick={() => { setMode("login"); setResetMsg(""); }}
              aria-label="Back to sign in"
            >
              <span aria-hidden="true">&larr;</span> Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
