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
      {/* Left Column: Branding */}
      <div className="login-left">
        <div className="brand-section">
          {/* <img src="logo.png" alt="P³ Logo" className="brand-logo" /> */}
          <h1 className="brand-title">P³</h1>
          <p className="brand-subtitle">Streamlined Pickup &amp; Drop-off</p>
        </div>
      </div>

      {/* Right Column: Login / Reset Form */}
      <div className="login-right">
        <div className="login-card">
          {!resetMode ? (
            <>
              <h2 className="login-title">Welcome Back</h2>
              <form onSubmit={handleLogin} className="login-form">
                <input
                  type="email"
                  placeholder="Email"
                  className="login-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <input
                  type="password"
                  placeholder="Password"
                  className="login-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button type="submit" className="login-btn">
                  Login
                </button>
                {error && <p className="login-error">{error}</p>}
              </form>
              <button
                className="forgot-link"
                onClick={() => { setResetMode(true); setResetMsg(""); }}
              >
                Forgot password?
              </button>
            </>
          ) : (
            <>
              <h2 className="login-title">Reset Password</h2>
              <form onSubmit={handleReset} className="login-form">
                <input
                  type="email"
                  placeholder="Your account email"
                  className="login-input"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
                <button type="submit" className="login-btn" disabled={resetSending}>
                  {resetSending ? "Sending…" : "Send Reset Email"}
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
                ← Back to login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
