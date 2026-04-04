import React from "react";
import "./Navbar.css";

export default function Navbar({ handleLogout, wsStatus }) {
  return (
    <nav className="navbar">
      <div className="navbar-brand">P³ Dashboard</div>
      <div className="navbar-right">
        <div className={`navbar-ws-dot ${wsStatus}`} title={`WebSocket: ${wsStatus}`} />
        <button className="nav-btn logout-btn" onClick={handleLogout}>
          Logout
        </button>
      </div>
    </nav>
  );
}
