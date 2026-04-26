import React, { useEffect, useRef, useState } from "react";
import { auth } from "./firebase-config";
import { I } from "./components/icons";
import "./SessionTimeoutWarning.css";

// Window of warning before the active Firebase ID token expires.  Five
// minutes matches what the Firebase SDK uses internally as the proactive
// auto-refresh window — if Firebase succeeds at refreshing in the
// background (the happy path), the new token's exp pushes out by an
// hour and this warning never opens.  The modal only surfaces when
// auto-refresh hasn't happened (network down, refresh-token revoked,
// long-suspended tab), giving the user a chance to act before they
// silently lose their session mid-action.  Satisfies WCAG 2.2.1
// (Timing Adjustable) and 2.2.6 (Timeouts).
const WARNING_WINDOW_MS = 5 * 60 * 1000;

// JWT payloads are base64url-encoded JSON.  Standalone implementation
// rather than pulling in jose just to read one claim — Firebase tokens
// always have an exp.  Returns null on any decode failure so callers
// fall through to "no countdown, no warning" rather than crash.
function decodeJwtExpMs(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "===".slice((padded.length + 3) % 4));
    const payload = JSON.parse(json);
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function SessionTimeoutWarning({ token, onSignOut }) {
  const expMs = decodeJwtExpMs(token);

  const [open, setOpen] = useState(false);
  const [msRemaining, setMsRemaining] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const stayBtnRef = useRef(null);
  // Remember whatever held focus when the modal opens so we can hand
  // focus back on close — the standard a11y pattern (matches the
  // UserManagement ResendInviteModal).
  const lastFocusedRef = useRef(null);

  // Schedule the modal to open WARNING_WINDOW_MS before exp; tear down
  // the timer whenever the token changes (Firebase auto-refresh issued
  // a new one) so we re-arm against the fresh exp.
  useEffect(() => {
    if (!expMs) return undefined;
    const now = Date.now();
    const msUntilWarning = expMs - now - WARNING_WINDOW_MS;
    if (msUntilWarning <= 0) {
      setOpen(true);
      setMsRemaining(Math.max(0, expMs - now));
      return undefined;
    }
    setOpen(false);
    setMsRemaining(0);
    setRefreshError("");
    const id = setTimeout(() => {
      setOpen(true);
      setMsRemaining(Math.max(0, expMs - Date.now()));
    }, msUntilWarning);
    return () => clearTimeout(id);
  }, [expMs]);

  // Tick the countdown once per second while the warning is visible.
  useEffect(() => {
    if (!open || !expMs) return undefined;
    const id = setInterval(() => {
      setMsRemaining(Math.max(0, expMs - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [open, expMs]);

  // Esc key inside the modal extends the session — Esc almost always
  // means "dismiss this dialog and let me keep working", and the
  // safe-default for an accidental Esc is staying signed in (signing
  // out on Esc would punish the wrong reflex).
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleStaySignedIn();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // handleStaySignedIn is stable enough — it reads refs + setters
    // that don't change identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Move focus into the modal on open; restore it on close.  Without
  // focus management, AT users land "outside" the modal even though
  // it's visible.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement;
      // Defer to next frame so the button is mounted.
      requestAnimationFrame(() => stayBtnRef.current?.focus());
    } else if (lastFocusedRef.current && lastFocusedRef.current.focus) {
      lastFocusedRef.current.focus();
      lastFocusedRef.current = null;
    }
  }, [open]);

  const expired = open && msRemaining <= 0;

  async function handleStaySignedIn() {
    if (refreshing) return;
    if (!auth.currentUser) {
      // Token already gone — fall through to sign-out flow.
      onSignOut?.();
      return;
    }
    setRefreshing(true);
    setRefreshError("");
    try {
      await auth.currentUser.getIdToken(true);
      // The forced refresh fires onIdTokenChanged in App.jsx, which
      // pushes a new token into props and re-runs the schedule effect
      // above (closing the modal naturally).  No further action here.
    } catch (err) {
      // Refresh-token revoked, network down, etc.  Show the failure so
      // the user can decide whether to sign out manually or retry.
      setRefreshError(
        err?.message?.replace(/^Firebase:\s*/, "") ||
          "Could not extend your session. Please sign out and sign in again.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="st-modal-overlay"
      // Click-outside also extends the session — same safe-default
      // reasoning as Esc.  We never sign someone out on a stray click.
      onClick={(e) => {
        if (e.target === e.currentTarget) handleStaySignedIn();
      }}
    >
      <div
        className="st-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="st-modal-title"
        aria-describedby="st-modal-desc"
      >
        <div className="st-modal-header">
          <span className="st-modal-icon" aria-hidden="true">
            <I.shield size={18} stroke={2} />
          </span>
          <h2 id="st-modal-title" className="st-modal-title">
            {expired ? "Session expired" : "Still there?"}
          </h2>
        </div>

        <div className="st-modal-body">
          <p id="st-modal-desc" className="st-modal-desc">
            {expired ? (
              <>
                Your session has ended. Sign in again to keep working.
              </>
            ) : (
              <>
                Your session will end in{" "}
                <strong className="st-countdown" aria-live="polite">
                  {formatCountdown(msRemaining)}
                </strong>
                . Choose <em>Stay signed in</em> to keep your work.
              </>
            )}
          </p>
          {refreshError && (
            <p className="st-modal-error" role="alert">
              {refreshError}
            </p>
          )}
        </div>

        <div className="st-modal-actions">
          {!expired && (
            <button
              ref={stayBtnRef}
              type="button"
              className="st-btn-primary"
              onClick={handleStaySignedIn}
              disabled={refreshing}
            >
              {refreshing ? (
                <><I.spinner size={14} aria-hidden="true" /> Refreshing…</>
              ) : (
                <>Stay signed in</>
              )}
            </button>
          )}
          <button
            ref={expired ? stayBtnRef : undefined}
            type="button"
            className={expired ? "st-btn-primary" : "st-btn-ghost"}
            onClick={() => onSignOut?.()}
          >
            {expired ? "Sign in again" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
