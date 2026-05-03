import React, { useState } from "react";
import { I } from "./components/icons";
import { formatApiError } from "./utils";
import CopyButton from "./CopyButton";

/**
 * Focused invite form for new Platform Admins.  Sibling of
 * InviteUserPanel — same look-and-feel (reuses the um-* classes and
 * CopyButton) but the role is always super_admin so we drop the role
 * picker entirely and don't need a currentUser to filter options.
 *
 * Props:
 *   api              axios-like client
 *   onInviteSuccess  callback fired after a successful invite
 *   onClose          parent's close-panel callback (Cancel button)
 */
export default function InvitePlatformAdminPanel({ api, onInviteSuccess, onClose }) {
  const [email, setEmail] = useState("");
  const [name,  setName]  = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { email, invite_link, email_sent }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api.post("/api/v1/admin/platform-users/invite", {
        email: email.trim(),
        display_name: name.trim(),
      });
      setResult({
        email: email.trim(),
        invite_link: res.data.invite_link || "",
        email_sent: !!res.data.email_sent,
      });
      setEmail("");
      setName("");
      onInviteSuccess?.();
    } catch (err) {
      setError(formatApiError(err, "Failed to send invite."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="um-invite-panel">
      <h2 className="um-invite-title">Invite a Platform Admin</h2>
      <p className="um-invite-subtitle">
        Platform Admins have unrestricted access to every district, school,
        and device on the system. Only invite people who need that scope.
      </p>

      {result ? (
        <div className="um-invite-success">
          <p className="um-invite-success-label">
            <I.checkCircle size={16} stroke={2.2} className="um-invite-success-icon" aria-hidden="true" />
            Account created for <strong>{result.email}</strong>
          </p>
          {result.email_sent ? (
            <p className="um-invite-link-note" style={{ color: "var(--on-green, #22863a)" }}>
              Invite email sent to <strong>{result.email}</strong>. If they
              don't receive it, share the link below as a backup.
            </p>
          ) : (
            <p
              className="um-invite-link-note"
              style={{
                background: "var(--amber-subtle)",
                border: "1px solid var(--amber)",
                borderRadius: "var(--r-md, 6px)",
                color: "var(--amber)",
                padding: "8px 12px",
                margin: "0 0 8px",
              }}
              role="status"
            >
              <I.alert size={13} aria-hidden="true" />{" "}
              Couldn't send the invite email to <strong>{result.email}</strong>.
              Share the link below so they can finish setting up.
            </p>
          )}
          {result.invite_link ? (
            <>
              <div className="um-invite-link-row">
                <input
                  className="um-invite-link-input"
                  readOnly
                  value={result.invite_link}
                  onFocus={(e) => e.target.select()}
                />
                <CopyButton text={result.invite_link} />
              </div>
              <p className="um-invite-link-note">
                {result.email_sent
                  ? "Backup link in case the email doesn't arrive."
                  : "Share this link so they can set their password. After setting it, they'll be redirected to the sign-in page — they must sign in with their email and new password to access the app."}
              </p>
            </>
          ) : (
            <p className="um-invite-link-note">
              Account created. Ask them to use the "Forgot password" link on the
              sign-in page to set their password.
            </p>
          )}
          <div className="um-invite-actions">
            <button type="button" className="um-btn-secondary" onClick={() => setResult(null)}>
              Invite another
            </button>
            <button type="button" className="um-btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="um-invite-form" onSubmit={handleSubmit}>
          <div className="um-form-row">
            <div className="um-field">
              <label className="um-label" htmlFor="pa-invite-email">
                Email address <span className="um-required" aria-label="required">*</span>
              </label>
              <input
                id="pa-invite-email"
                className="um-input"
                type="email"
                required
                placeholder="jane.smith@dismissal.app"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
            <div className="um-field">
              <label className="um-label" htmlFor="pa-invite-name">Display name</label>
              <input
                id="pa-invite-name"
                className="um-input"
                type="text"
                placeholder="Jane Smith"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          {error && <p className="um-field-error" role="alert">{error}</p>}

          <div className="um-invite-actions">
            <button type="button" className="um-btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="um-btn-primary" disabled={busy}>
              {busy ? "Creating account…" : "Send invite"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
