import React from "react";
import Navbar from "./Navbar";
import LeftNav from "./LeftNav";
import Alerts from "./Alerts";
import "./Layout.css";

export default function Layout({ children, view, setView, handleLogout, wsStatus, token, currentUser }) {
  return (
    <div className="layout-container">
      <Navbar handleLogout={handleLogout} wsStatus={wsStatus} currentUser={currentUser} />
      <Alerts token={token} />
      <div className="layout-body">
        <LeftNav view={view} setView={setView} currentUser={currentUser} />
        <div className="layout-content">{children}</div>
      </div>
    </div>
  );
}
