import React from "react";
import "./Navbar.css";

export default function Navbar({ handleLogout }) {
  return (
    <nav className="navbar">
      <div className="navbar-brand">P³ Dashboard</div>
      <div className="navbar-logout">
        <button className="nav-btn logout-btn" onClick={handleLogout}>
          Logout
        </button>
      </div>
    </nav>
  );
}
