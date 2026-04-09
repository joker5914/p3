import React, { useEffect, useState, useRef, useCallback } from "react";
import "./SessionTimeout.css";

const IDLE_LIMIT    = 30 * 60 * 1000; // 30 minutes
const WARNING_AHEAD = 2  * 60 * 1000; // Show warning 2 minutes before logout
const TICK_INTERVAL = 1000;            // Update countdown every second

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "pointerdown"];

export default function SessionTimeout({ onLogout }) {
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const lastActivityRef = useRef(Date.now());
  const warningTimerRef = useRef(null);
  const logoutTimerRef  = useRef(null);
  const tickRef         = useRef(null);

  const resetTimers = useCallback(() => {
    lastActivityRef.current = Date.now();
    setShowWarning(false);

    clearTimeout(warningTimerRef.current);
    clearTimeout(logoutTimerRef.current);
    clearInterval(tickRef.current);

    // Schedule warning
    warningTimerRef.current = setTimeout(() => {
      setShowWarning(true);
      setSecondsLeft(Math.ceil(WARNING_AHEAD / 1000));

      // Start countdown tick
      tickRef.current = setInterval(() => {
        const elapsed = Date.now() - lastActivityRef.current;
        const remaining = Math.max(0, Math.ceil((IDLE_LIMIT - elapsed) / 1000));
        setSecondsLeft(remaining);
        if (remaining <= 0) clearInterval(tickRef.current);
      }, TICK_INTERVAL);
    }, IDLE_LIMIT - WARNING_AHEAD);

    // Schedule logout
    logoutTimerRef.current = setTimeout(() => {
      clearInterval(tickRef.current);
      onLogout();
    }, IDLE_LIMIT);
  }, [onLogout]);

  // Listen for user activity
  useEffect(() => {
    const handleActivity = () => resetTimers();

    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, handleActivity, { passive: true }));
    resetTimers();

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, handleActivity));
      clearTimeout(warningTimerRef.current);
      clearTimeout(logoutTimerRef.current);
      clearInterval(tickRef.current);
    };
  }, [resetTimers]);

  const handleStayLoggedIn = () => {
    resetTimers();
  };

  if (!showWarning) return null;

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeStr = mins > 0
    ? `${mins}:${secs.toString().padStart(2, "0")}`
    : `${secs}s`;

  return (
    <div className="session-overlay">
      <div className="session-modal">
        <div className="session-modal-icon">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="18" stroke="var(--orange, #ff9f0a)" strokeWidth="2.5" opacity="0.2"/>
            <circle cx="20" cy="20" r="18" stroke="var(--orange, #ff9f0a)" strokeWidth="2.5"
              strokeDasharray={`${(secondsLeft / 120) * 113} 113`}
              strokeLinecap="round"
              transform="rotate(-90 20 20)"
              style={{ transition: "stroke-dasharray 1s linear" }}
            />
            <text x="20" y="24" textAnchor="middle" fill="var(--orange, #ff9f0a)" fontSize="13" fontWeight="700" fontFamily="var(--font)">{timeStr}</text>
          </svg>
        </div>
        <h3 className="session-modal-title">Session Expiring</h3>
        <p className="session-modal-desc">
          Your session will expire due to inactivity.
          You'll be signed out automatically.
        </p>
        <div className="session-modal-actions">
          <button className="session-btn-logout" onClick={onLogout}>Sign Out Now</button>
          <button className="session-btn-stay" onClick={handleStayLoggedIn}>Stay Signed In</button>
        </div>
      </div>
    </div>
  );
}
