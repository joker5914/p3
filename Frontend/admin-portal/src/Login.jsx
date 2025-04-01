import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "./firebase-config";
import "./Login.css";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

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

  return (
    <div className="login-wrapper">
      {/* Left Column: Branding */}
      <div className="login-left">
        <div className="brand-section">
          {/* Uncomment and set your logo source if available */}
          {/* <img src="logo.png" alt="P³ Logo" className="brand-logo" /> */}
          <h1 className="brand-title">P³</h1>
          <p className="brand-subtitle">Streamlined Pickup &amp; Drop-off</p>
        </div>
      </div>

      {/* Right Column: Login Form */}
      <div className="login-right">
        <div className="login-card">
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
        </div>
      </div>
    </div>
  );
}
