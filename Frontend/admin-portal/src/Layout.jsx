import React from "react";
import Navbar from "./Navbar";
import LeftNav from "./LeftNav";
import "./Layout.css";

export default function Layout({ children, view, setView, handleLogout, wsStatus }) {
  return (
    <div className="layout-container">
      <Navbar handleLogout={handleLogout} wsStatus={wsStatus} />
      <div className="layout-body">
        <LeftNav view={view} setView={setView} />
        <div className="layout-content">{children}</div>
      </div>
    </div>
  );
}
