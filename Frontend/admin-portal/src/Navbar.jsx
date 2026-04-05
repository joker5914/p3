import React from "react";
import "./Navbar.css";

export default function Navbar({ handleLogout, wsStatus }) {
  const label = wsStatus === "connected" ? "Live" : wsStatus === "error" ? "Error" : "Reconnecting";

  return (
    <nav className="navbar">
      <div className="navbar-brand">P³</div>
      <div className="navbar-right">
        <span className={`navbar-ws-pill ${wsStatus}`}>
          <span className="navbar-ws-dot" />
          {label}
        </span>
        <button className="nav-btn" onClick={handleLogout}>Sign Out</button>
      </div>
    </nav>
  );
}
