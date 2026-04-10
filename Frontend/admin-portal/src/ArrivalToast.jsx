import React, { useEffect, useState, useRef, useCallback } from "react";
import { FaBell, FaBellSlash, FaCarSide, FaTimes } from "react-icons/fa";
import "./ArrivalToast.css";

/* ── Audio: HTMLAudioElement with generated WAV ────────────────────── */
// Safari's Web Audio API (AudioContext) has strict autoplay restrictions
// that silently fail even after user gestures — it requires actual audio
// routed through the context during the gesture, not just resume(), and
// has an "interrupted" state that Chrome/Firefox don't have.
//
// Using an HTMLAudioElement with a programmatically generated WAV blob
// avoids all AudioContext quirks and works reliably across Safari, Chrome,
// and Firefox.

let chimeAudio = null;
let audioUnlocked = false;

/** Build a 16-bit mono WAV blob URL containing a two-note ascending chime. */
function buildChimeWav() {
  const RATE = 44100;
  const DUR = 0.62; // seconds
  const len = Math.ceil(RATE * DUR);
  const pcm = new Float32Array(len);

  // Two-note ascending chime: E5 (660 Hz) → A5 (880 Hz)
  [
    { hz: 660, t0: 0.0 },
    { hz: 880, t0: 0.12 },
  ].forEach(({ hz, t0 }) => {
    const start = Math.floor(t0 * RATE);
    const attackLen = Math.floor(0.03 * RATE);
    const total = Math.floor(0.45 * RATE);
    for (let i = 0; i < total && start + i < len; i++) {
      const sample = Math.sin(2 * Math.PI * hz * (i / RATE));
      const env = i < attackLen
        ? 0.35 * (i / attackLen)
        : 0.35 * Math.exp(-6 * ((i - attackLen) / (total - attackLen)));
      pcm[start + i] += sample * env;
    }
  });

  // Encode as WAV: 44-byte header + 16-bit PCM payload
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7FFF, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function getChimeAudio() {
  if (!chimeAudio) chimeAudio = new Audio(buildChimeWav());
  return chimeAudio;
}

// Browsers (especially Safari) block audio until a user gesture "unlocks" the
// page.  Play the audio element silently on first interaction so that later
// programmatic play() calls from WebSocket/polling handlers succeed.
if (typeof document !== "undefined") {
  const unlock = () => {
    if (audioUnlocked) return;
    try {
      const audio = getChimeAudio();
      audio.volume = 0;
      const p = audio.play();
      if (p) p.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audioUnlocked = true;
        // Remove listeners once audio is unlocked — no need to re-run.
        document.removeEventListener("click", unlock);
        document.removeEventListener("touchstart", unlock);
        document.removeEventListener("keydown", unlock);
      }).catch(() => { /* still blocked; will retry on next gesture */ });
    } catch { /* ignore */ }
  };
  document.addEventListener("click", unlock);
  document.addEventListener("touchstart", unlock);
  document.addEventListener("keydown", unlock);
}

async function playChime() {
  try {
    const audio = getChimeAudio();
    audio.currentTime = 0;
    audio.volume = 1;
    await audio.play();
  } catch {
    // Audio not supported or still locked — silently fail.
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
    const stored = localStorage.getItem("dismissal-arrival-alerts");
    return stored !== "off";
  });
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("dismissal-arrival-alerts", next ? "on" : "off");
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
