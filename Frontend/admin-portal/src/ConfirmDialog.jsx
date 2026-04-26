import React, { useEffect, useId, useRef } from "react";
import { I } from "./components/icons";
import "./ConfirmDialog.css";

/* ── ConfirmDialog ────────────────────────────────────────
   Shared destructive-confirmation modal used by every admin-table
   delete / suspend / unlink / "are you sure" flow in the portal.

   Replaces the previous mix of per-page modals, inline confirmation
   rows, and OS-level `window.confirm` prompts so users see one
   consistent destructive-action dialog regardless of which page
   they're on.

   A11y posture:
   - role="alertdialog" + aria-modal + aria-labelledby + aria-describedby
   - Esc closes (calls onCancel)
   - Click on the overlay (not the panel) closes
   - Focus moves to the SAFE button (Cancel) on open, so a stray Enter
     after the dialog appears doesn't destroy data — the user has to
     deliberately Tab to Confirm
   - Focus restores to whatever held focus before the dialog opened
   - prefers-reduced-motion respected (CSS layer flattens transitions)

   API
     <ConfirmDialog
       open                 // bool — renders nothing when false
       title="Remove user"  // h2 text
       prompt="…"           // main message (string or JSX)
       warning="…"          // optional secondary line (smaller/greyer)
       destructive          // bool — applies the danger styling to confirm
       confirmLabel="Remove"
       busyLabel="Removing…"
       cancelLabel="Cancel"
       busy={false}         // disables buttons + flips confirmLabel→busyLabel
       error="…"            // shown inside the modal body in red
       onConfirm={…}
       onCancel={…}
       confirmIcon={<I.trash size={12} aria-hidden="true" />}
     />
   ────────────────────────────────────────────────────── */

export default function ConfirmDialog({
  open,
  title,
  prompt,
  warning,
  destructive = false,
  confirmLabel = "Confirm",
  busyLabel,
  cancelLabel = "Cancel",
  busy = false,
  error,
  onConfirm,
  onCancel,
  confirmIcon,
}) {
  const reactId = useId();
  const titleId = `cd-title-${reactId}`;
  const descId  = `cd-desc-${reactId}`;
  const cancelBtnRef = useRef(null);
  const lastFocusedRef = useRef(null);

  // Esc closes (calls onCancel) — standard dialog convention.  Only
  // wires up when the dialog is open so other Esc-handling code on
  // the page (e.g. the SessionTimeoutWarning) keeps working when the
  // dialog isn't shown.  Held-busy ignores Esc so the user can't
  // dismiss the modal mid-API-call.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onCancel]);

  // Focus management: move focus into the dialog on open (to the
  // SAFE button — Cancel — so an accidental Enter doesn't trigger
  // the destructive action), restore to the previous focus on close.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement;
      requestAnimationFrame(() => cancelBtnRef.current?.focus());
    } else if (lastFocusedRef.current && lastFocusedRef.current.focus) {
      lastFocusedRef.current.focus();
      lastFocusedRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="cd-overlay"
      onClick={(e) => {
        // Click on the overlay backdrop (not the panel) cancels.
        // Held-busy ignores so a stray click can't dismiss in-flight.
        if (e.target === e.currentTarget && !busy) onCancel?.();
      }}
    >
      <div
        className="cd-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div className="cd-header">
          <h2 id={titleId} className="cd-title">{title}</h2>
          <button
            type="button"
            className="cd-close"
            onClick={() => !busy && onCancel?.()}
            aria-label="Close dialog"
            disabled={busy}
          >
            <I.x size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="cd-body">
          <p id={descId} className="cd-prompt">{prompt}</p>
          {warning && <p className="cd-warning">{warning}</p>}
          {error && <p className="cd-error" role="alert">{error}</p>}
        </div>

        <div className="cd-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="cd-btn cd-btn-cancel"
            onClick={() => onCancel?.()}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`cd-btn ${destructive ? "cd-btn-danger" : "cd-btn-primary"}`}
            onClick={() => onConfirm?.()}
            disabled={busy}
          >
            {busy
              ? <>
                  <I.spinner size={12} aria-hidden="true" />{" "}
                  {busyLabel || `${confirmLabel}…`}
                </>
              : <>
                  {confirmIcon}
                  {confirmLabel}
                </>}
          </button>
        </div>
      </div>
    </div>
  );
}
