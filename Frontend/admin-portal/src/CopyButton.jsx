import React, { useState } from "react";
import { I } from "./components/icons";

/**
 * Copy-to-clipboard button used by every flow that surfaces a one-time
 * link (invite generation, resend, etc.).  Self-contained: lives in its
 * own file so the resend modal in UserManagement and the InviteUserPanel
 * share a single implementation rather than each carrying a copy.
 */
export default function CopyButton({ text, label = "Copy link" }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  return (
    <button
      className="um-btn-copy"
      onClick={handleCopy}
      aria-label={copied ? "Link copied" : "Copy invite link"}
      title="Copy invite link"
    >
      {copied
        ? <I.check size={13} stroke={2.4} aria-hidden="true" />
        : <I.copy  size={13} aria-hidden="true" />}
      {copied ? "Copied!" : label}
    </button>
  );
}
