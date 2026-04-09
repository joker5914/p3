import React, { useState } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "./firebase-config";
import "./Login.css";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const [resetMode, setResetMode] = useState(false);
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

  const schoolLogo = import.meta.env.VITE_SCHOOL_LOGO_URL || null;
  const schoolName = import.meta.env.VITE_SCHOOL_NAME || null;

  return (
    <div className="login-wrapper">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          {schoolLogo ? (
            <img
              src={schoolLogo}
              alt={schoolName || "School logo"}
              className="login-brand-logo"
              onError={(e) => { e.target.style.display = "none"; }}
            />
          ) : (
            <div className="login-brand-mark">P³</div>
          )}
          <span className="login-brand-name">{schoolName || "P³"}</span>
        </div>
        <p className="login-subtitle">Pickup &amp; Drop-off Portal</p>

        {!resetMode ? (
          <>
            <h1 className="login-title">Log In</h1>
            <form onSubmit={handleLogin}>
              <div className="login-field">
                <label className="login-label">E-mail</label>
                <input
                  type="email"
                  className="login-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <div className="login-field">
                <label className="login-label">Password</label>
                <input
                  type="password"
                  className="login-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              {error && <p className="login-error">{error}</p>}
              <div className="login-btn-row">
                <button type="submit" className="login-btn">Sign In</button>
              </div>
            </form>
            <button
              className="forgot-link"
              onClick={() => { setResetMode(true); setResetMsg(""); }}
            >
              Forgot your password?
            </button>
          </>
        ) : (
          <>
            <h1 className="login-title">Reset Password</h1>
            <form onSubmit={handleReset}>
              <div className="login-field">
                <label className="login-label">Account email</label>
                <input
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
                <p className={resetMsg.startsWith("Reset email") ? "login-success" : "login-error"}>
                  {resetMsg}
                </p>
              )}
              <div className="login-btn-row">
                <button type="submit" className="login-btn" disabled={resetSending}>
                  {resetSending ? "Sending…" : "Send Reset Link"}
                </button>
              </div>
            </form>
            <button
              className="forgot-link"
              onClick={() => { setResetMode(false); setResetMsg(""); }}
            >
              ← Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
