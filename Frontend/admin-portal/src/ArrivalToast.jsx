import React, { useEffect, useState, useRef, useCallback } from "react";
import { FaBell, FaBellSlash, FaCarSide, FaTimes } from "react-icons/fa";
import "./ArrivalToast.css";

/* ── Alert chime (HTML5 Audio — works reliably in Safari) ──────────── */
let chimeAudio = null;
let audioPrimed = false;

/**
 * Build a two-note ascending chime (E5 → A5) as a WAV blob and wrap it
 * in an HTMLAudioElement.  This avoids the Web Audio AudioContext API
 * entirely — Safari aggressively suspends AudioContexts and silently
 * blocks resume() calls outside user gestures, making oscillator-based
 * playback unreliable.  HTMLAudioElement, once primed by a single user
 * gesture, plays back reliably from any call-site (WebSocket handlers,
 * timers, etc.).
 */
function getChimeAudio() {
  if (chimeAudio) return chimeAudio;

  const rate = 44100;
  const dur = 0.7;
  const len = Math.floor(rate * dur);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);

  // ── WAV header ──
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);      // subchunk size
  v.setUint16(20, 1, true);       // PCM
  v.setUint16(22, 1, true);       // mono
  v.setUint32(24, rate, true);     // sample rate
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true);       // block align
  v.setUint16(34, 16, true);      // bits per sample
  w(36, "data");
  v.setUint32(40, len * 2, true);

  // ── Generate two-note ascending chime ──
  const PI2 = 2 * Math.PI;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let s = 0;
    // Note 1 — E5 (660 Hz)
    if (t < 0.45) {
      const att = Math.min(1, t / 0.03);
      s += Math.sin(PI2 * 660 * t) * att * Math.exp(-t * 6) * 0.4;
    }
    // Note 2 — A5 (880 Hz), offset 120 ms
    if (t >= 0.12) {
      const t2 = t - 0.12;
      if (t2 < 0.45) {
        const att = Math.min(1, t2 / 0.03);
        s += Math.sin(PI2 * 880 * t2) * att * Math.exp(-t2 * 6) * 0.4;
      }
    }
    v.setInt16(44 + i * 2, (Math.max(-1, Math.min(1, s)) * 32767) | 0, true);
  }

  chimeAudio = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
  return chimeAudio;
}

// Safari requires an audio element to receive at least one play() call
// during a user gesture before it allows programmatic playback.  Prime
// the element silently on the first interaction; the listener stays
// active until priming succeeds so background-tab suspensions are
// handled on the next click.
if (typeof document !== "undefined") {
  const prime = () => {
    if (audioPrimed) return;
    try {
      const audio = getChimeAudio();
      const origVol = audio.volume;
      audio.volume = 0;
      const p = audio.play();
      if (p && p.then) {
        p.then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = origVol;
          audioPrimed = true;
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  };
  document.addEventListener("click", prime);
  document.addEventListener("touchstart", prime);
}

function playChime() {
  try {
    const audio = getChimeAudio();
    audio.currentTime = 0;
    audio.volume = 1;
    audio.play().catch(() => {});
  } catch {
    // Audio not available — silently fail.
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
