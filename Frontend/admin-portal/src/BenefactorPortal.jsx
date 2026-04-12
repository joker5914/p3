import React, { useState, useEffect, useCallback } from "react";
import { createApiClient } from "./api";
import PersonAvatar from "./PersonAvatar";
import BenefactorChildren from "./BenefactorChildren";
import BenefactorVehicles from "./BenefactorVehicles";
import BenefactorPickups from "./BenefactorPickups";
import BenefactorActivity from "./BenefactorActivity";
import BenefactorProfile from "./BenefactorProfile";
import "./BenefactorPortal.css";

const IconChildren = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>);
const IconCar = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h1l2-3h8l2 3h1a2 2 0 012 2v6a2 2 0 01-2 2M5 17a2 2 0 002 2h10a2 2 0 002-2" /><circle cx="7.5" cy="14.5" r="1.5" /><circle cx="16.5" cy="14.5" r="1.5" /></svg>);
const IconUser = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
const IconShield = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>);
const IconClock = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>);
const InfoCircle = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>);
const IconX = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>);

const TABS = [
  { key: "children",  label: "My Children",        icon: <IconChildren /> },
  { key: "vehicles",  label: "My Vehicles",        icon: <IconCar /> },
  { key: "pickups",   label: "Authorized Pickups", icon: <IconShield /> },
  { key: "activity",  label: "Activity",           icon: <IconClock /> },
  { key: "profile",   label: "Profile",            icon: <IconUser /> },
];

export default function BenefactorPortal({ token, currentUser, handleLogout }) {
  const [tab, setTab] = useState("children");
  const [noSchool, setNoSchool] = useState(false);
  const [noSchoolDismissed, setNoSchoolDismissed] = useState(false);
  const api = useCallback(() => createApiClient(token), [token]);
  const firstName = (currentUser?.display_name || "").split(" ")[0] || "there";

  useEffect(() => {
    if (!token) return;
    createApiClient(token).get("/api/v1/benefactor/assigned-schools")
      .then((res) => setNoSchool((res.data.schools || []).length === 0))
      .catch(() => {});
  }, [token]);

  return (
    <div className="bp-shell">
      <header className="bp-topbar">
        <div className="bp-brand">Dismissal <span className="bp-brand-sub">Guardian Portal</span></div>
        <div className="bp-user">
          <PersonAvatar name={currentUser?.display_name} photoUrl={currentUser?.photo_url} size={32} />
          <span className="bp-user-name">{currentUser?.display_name || currentUser?.email}</span>
          <button className="bp-sign-out" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {noSchool && !noSchoolDismissed && (
        <div className="bp-alert-bar">
          <div className="bp-alert-item bp-alert-info">
            <span className="bp-alert-icon"><InfoCircle /></span>
            <span className="bp-alert-message">Your account is not yet linked to a school. Please contact your school and ask them to add you in the Dismissal system so you can start managing pickups.</span>
            <button className="bp-alert-dismiss" onClick={() => setNoSchoolDismissed(true)} title="Dismiss"><IconX /></button>
          </div>
        </div>
      )}

      <div className="bp-welcome">
        <h1 className="bp-welcome-title">Welcome, {firstName}</h1>
        <p className="bp-welcome-sub">Manage your children and vehicles for quick school pickup.</p>
      </div>

      <nav className="bp-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`bp-tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.icon}<span className="bp-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="bp-content">
        {tab === "children"  && <BenefactorChildren api={api} token={token} />}
        {tab === "vehicles"  && <BenefactorVehicles api={api} token={token} />}
        {tab === "pickups"   && <BenefactorPickups api={api} />}
        {tab === "activity"  && <BenefactorActivity api={api} />}
        {tab === "profile"   && <BenefactorProfile api={api} currentUser={currentUser} />}
      </div>
    </div>
  );
}
