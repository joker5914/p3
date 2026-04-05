import React, { useState } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "./firebase-config";
import "./Login.css";

export default function Login({ onLogin }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");

  const [resetMode, setResetMode]       = useState(false);
  const [resetEmail, setResetEmail]     = useState("");
  const [resetMsg, setResetMsg]         = useState("");
  const [resetSending, setResetSending] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const cred  = await signInWithEmailAndPassword(auth, email, password);
      const token = await cred.user.getIdToken();
      onLogin(token);
    } catch (err) {
      setError("Invalid email or password. Please try again.");
      console.error(err);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setResetMsg("");
    setResetSending(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail);
      setResetMsg("Reset link sent — check your inbox.");
    } catch (err) {
      setResetMsg("Couldn't send reset email. Check the address and try again.");
      console.error(err);
    } finally {
      setResetSending(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-left">
        <div className="brand-section">
          <div className="brand-mark">
            <span className="brand-mark-text">P³</span>
          </div>
          <div className="brand-subtitle">Streamlined Pickup &amp; Drop-off</div>
          <div className="brand-features">
            {["Real-time license plate recognition", "Live pickup queue management", "Encrypted student data"].map((f) => (
              <div className="brand-feature" key={f}>
                <span className="brand-feature-dot" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="login-right">
        <div className="login-card">
          {!resetMode ? (
            <>
              <p className="login-eyebrow">Admin Portal</p>
              <h1 className="login-title">Welcome back</h1>
              <p className="login-subtitle">Sign in to manage your school&apos;s pickup queue.</p>
              <form onSubmit={handleLogin} className="login-form">
                <input
                  type="email"
                  placeholder="Email address"
                  className="login-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <input
                  type="password"
                  placeholder="Password"
                  className="login-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button type="submit" className="login-btn">Sign In</button>
                {error && <p className="login-error">{error}</p>}
              </form>
              <div className="login-divider" />
              <button className="forgot-link" onClick={() => { setResetMode(true); setResetMsg(""); }}>
                Forgot password?
              </button>
            </>
          ) : (
            <>
              <p className="login-eyebrow">Password Reset</p>
              <h1 className="login-title">Reset password</h1>
              <p className="login-subtitle">Enter your email and we&apos;ll send you a reset link.</p>
              <form onSubmit={handleReset} className="login-form">
                <input
                  type="email"
                  placeholder="Email address"
                  className="login-input"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <button type="submit" className="login-btn" disabled={resetSending}>
                  {resetSending ? "Sending…" : "Send Reset Link"}
                </button>
                {resetMsg && (
                  <p className={resetMsg.startsWith("Reset link") ? "login-success" : "login-error"}>
                    {resetMsg}
                  </p>
                )}
              </form>
              <div className="login-divider" />
              <button className="forgot-link" onClick={() => { setResetMode(false); setResetMsg(""); }}>
                ← Back to sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
