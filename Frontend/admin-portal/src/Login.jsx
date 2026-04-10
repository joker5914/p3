import React, { useState, useEffect } from "react";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "./firebase-config";
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

  return (
    <div className="login-wrapper">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <div className="login-brand-mark">D</div>
          <span className="login-brand-name">Dismissal</span>
        </div>
        <p className="login-subtitle">Guardian Portal</p>

        {mode === "login" && (
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
                <label className="login-label">Full Name</label>
                <input
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
                <label className="login-label">E-mail</label>
                <input
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
                <label className="login-label">Password</label>
                <input
                  type="password"
                  className="login-input"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="login-field">
                <label className="login-label">Confirm Password</label>
                <input
                  type="password"
                  className="login-input"
                  value={signupConfirm}
                  onChange={(e) => setSignupConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              {signupError && <p className="login-error">{signupError}</p>}
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
                  {resetSending ? "Sending..." : "Send Reset Link"}
                </button>
              </div>
            </form>
            <button className="forgot-link" onClick={() => { setMode("login"); setResetMsg(""); }}>
              &larr; Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
