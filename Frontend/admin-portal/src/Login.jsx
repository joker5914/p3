import React, { useState } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "./firebase-config";
import "./Login.css";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  // Password reset state
  const [resetMode, setResetMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [resetSending, setResetSending] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const userCred = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await userCred.user.getIdToken();
      onLogin(idToken);
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

  return (
    <div className="login-wrapper">
      <div className="login-card">
        {/* Brand mark */}
        <div className="login-brand">P³</div>

        {!resetMode ? (
          <>
            <h1 className="login-title">Sign in to P³</h1>
            <p className="login-subtitle">Streamlined Pickup &amp; Drop-off</p>
            <form onSubmit={handleLogin} className="login-form">
              <input
                type="email"
                placeholder="Email"
                className="login-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <input
                type="password"
                placeholder="Password"
                className="login-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button type="submit" className="login-btn">Sign In</button>
              {error && <p className="login-error">{error}</p>}
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
            <p className="login-subtitle">We'll send a reset link to your email.</p>
            <form onSubmit={handleReset} className="login-form">
              <input
                type="email"
                placeholder="Account email"
                className="login-input"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <button type="submit" className="login-btn" disabled={resetSending}>
                {resetSending ? "Sending…" : "Send Reset Link"}
              </button>
              {resetMsg && (
                <p className={resetMsg.startsWith("Reset email") ? "login-success" : "login-error"}>
                  {resetMsg}
                </p>
              )}
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
