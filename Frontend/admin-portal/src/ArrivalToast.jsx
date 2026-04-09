import React, { useEffect, useState, useRef, useCallback } from "react";
import { FaBell, FaBellSlash, FaCarSide, FaTimes } from "react-icons/fa";
import "./ArrivalToast.css";

/* ── Web Audio chime ────────────────────────────────────────────────── */
let audioCtx = null;

// Browsers require a user gesture (click/tap) before an AudioContext can
// produce sound.  Pre-create and resume the context on the very first
// interaction so that later programmatic calls from WebSocket / polling
// handlers are never blocked by the autoplay policy.
if (typeof document !== "undefined") {
  const unlock = () => {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch { /* ignore */ }
  };
  document.addEventListener("click", unlock, { once: true });
  document.addEventListener("touchstart", unlock, { once: true });
}

function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;

    // Two-note ascending chime — pleasant and non-intrusive
    const notes = [660, 880]; // E5 → A5
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.12);

      gain.gain.setValueAtTime(0, now + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.45);

      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.5);
    });
  } catch {
    // Audio not supported or blocked — silently fail.
  }
}

/* ── Toast item ─────────────────────────────────────────────────────── */
function Toast({ id, guardian, students, onRemove }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), 4500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onRemove(id), 300);
    return () => clearTimeout(timer);
  }, [exiting, id, onRemove]);

  const studentText = students.length > 0
    ? students.join(", ")
    : null;

  return (
    <div className={`arrival-toast${exiting ? " arrival-toast-exit" : ""}`}>
      <div className="arrival-toast-icon">
        <FaCarSide />
      </div>
      <div className="arrival-toast-body">
        <span className="arrival-toast-title">New Arrival</span>
        <span className="arrival-toast-name">{guardian || "Unknown driver"}</span>
        {studentText && (
          <span className="arrival-toast-students">{studentText}</span>
        )}
      </div>
      <button className="arrival-toast-close" onClick={() => setExiting(true)}>
        <FaTimes />
      </button>
    </div>
  );
}

/* ── Toast container + toggle ───────────────────────────────────────── */
export function useArrivalAlerts() {
  const [enabled, setEnabled] = useState(() => {
    const stored = localStorage.getItem("p3-arrival-alerts");
    return stored !== "off";
  });
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("p3-arrival-alerts", next ? "on" : "off");
      return next;
    });
  }, []);

  const notify = useCallback((scanData) => {
    if (!enabled) return;
    playChime();
    const id = ++idCounter.current;
    const guardian = scanData.parent || "Unknown";
    const students = Array.isArray(scanData.student) ? scanData.student : scanData.student ? [scanData.student] : [];
    setToasts((prev) => [...prev.slice(-4), { id, guardian, students }]);
  }, [enabled]);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { enabled, toggle, toasts, notify, removeToast };
}

/* ── Rendered component ─────────────────────────────────────────────── */
export default function ArrivalToasts({ toasts, removeToast }) {
  if (toasts.length === 0) return null;
  return (
    <div className="arrival-toasts-container">
      {toasts.map((t) => (
        <Toast key={t.id} id={t.id} guardian={t.guardian} students={t.students} onRemove={removeToast} />
      ))}
    </div>
  );
}

/* ── Toggle button (for navbar) ─────────────────────────────────────── */
export function ArrivalAlertToggle({ enabled, onToggle }) {
  return (
    <button
      className={`alert-toggle${enabled ? " alert-toggle-on" : ""}`}
      onClick={onToggle}
      aria-label={enabled ? "Mute arrival alerts" : "Enable arrival alerts"}
      title={enabled ? "Arrival alerts on" : "Arrival alerts muted"}
    >
      <span className="alert-toggle-icon">
        {enabled ? <FaBell /> : <FaBellSlash />}
      </span>
    </button>
  );
}
