import React, { useEffect, useRef } from "react";
import { I } from "./components/icons";
import AccountProfile from "./AccountProfile";
import "./AccountSettingsOverlay.css";

/* AccountSettingsOverlay — popover wrapper around the existing
   <AccountProfile> view.  Renders Account Settings on top of whatever
   the user was already looking at instead of routing them away from it.

   Dismiss model:
     - Click anywhere on the dim backdrop                → close
     - Press Escape                                       → close
     - Click the × button in the panel header            → close

   The panel itself stops click propagation so taps inside the form
   don't leak to the backdrop and accidentally close the overlay.
   We focus the close button on open so keyboard users land somewhere
   actionable; full focus-trapping is overkill for a settings sheet. */
export default function AccountSettingsOverlay({ open, onClose, ...accountProps }) {
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the overlay is open so the underlying
    // page can't scroll behind a fixed panel — same trick used in the
    // confirm-dialog pattern elsewhere in the portal.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Defer focus to next tick so the panel is in the DOM.
    const focusTimer = setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(focusTimer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ap-overlay-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        className="ap-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ap-overlay-title"
      >
        <button
          ref={closeBtnRef}
          className="ap-overlay-close"
          onClick={onClose}
          aria-label="Close account settings"
          title="Close (Esc)"
        >
          <I.x size={16} aria-hidden="true" />
        </button>
        {/* Hidden a11y label so screen readers announce the dialog
            even though the visible heading is rendered inside the
            embedded AccountProfile via .page-title. */}
        <span id="ap-overlay-title" className="sr-only">Account Settings</span>
        <div className="ap-overlay-body">
          <AccountProfile {...accountProps} />
        </div>
      </div>
    </div>
  );
}
