import React, { useState } from "react";
import { I } from "./components/icons";
import { formatApiError } from "./utils";
import CopyButton from "./CopyButton";

// Role options shown in the invite form.  Each entry includes the set
// of caller roles allowed to invite into that role — district_admin is
// only offered to platform admins, mirroring the backend's invite
// hierarchy enforced in routes/users._caller_may_invite.
const ROLE_OPTIONS = [
  { value: "staff",          icon: I.user,   label: "Staff",
    desc: "View dashboard, history, and reports. Cannot manage users or import data.",
    callerRoles: ["super_admin", "district_admin", "school_admin"] },
  { value: "school_admin",   icon: I.shield, label: "Admin",
    desc: "Full access including user management, data import, and registry edits.",
    callerRoles: ["super_admin", "district_admin", "school_admin"] },
  { value: "district_admin", icon: I.shield, label: "District Admin",
    desc: "Manages every school and device in this district. Only Platform Admins can grant this role.",
    callerRoles: ["super_admin"] },
];

/**
 * Self-contained invite panel.  Owns its own form state so that closing
 * + reopening the panel resets cleanly (mount/unmount is the reset).
 *
 * Props:
 *   api              axios-like client
 *   currentUser      used to filter ROLE_OPTIONS to roles this caller
 *                    is allowed to grant
 *   onInviteSuccess  callback fired after a successful invite (parent
 *                    typically refetches its list)
 *   onClose          parent's close-panel callback (Cancel button)
 */
export default function InviteUserPanel({ api, currentUser, onInviteSuccess, onClose }) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName,  setInviteName]  = useState("");
  const [inviteRole,  setInviteRole]  = useState("staff");
  const [inviting,    setInviting]    = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteResult, setInviteResult] = useState(null); // { email, invite_link, email_sent }

  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setInviteError("");
    setInviteResult(null);
    try {
      const res = await api.post("/api/v1/users/invite", {
        email: inviteEmail.trim(),
        display_name: inviteName.trim(),
        role: inviteRole,
      });
      setInviteResult({
        email: inviteEmail.trim(),
        invite_link: res.data.invite_link || "",
        email_sent: !!res.data.email_sent,
      });
      setInviteEmail("");
      setInviteName("");
      setInviteRole("staff");
      onInviteSuccess?.();
    } catch (err) {
      setInviteError(formatApiError(err, "Failed to send invite."));
    } finally {
      setInviting(false);
    }
  };

  const availableRoles = ROLE_OPTIONS.filter((r) =>
    r.callerRoles.includes(currentUser?.role),
  );

  return (
    <div className="um-invite-panel">
      <h2 className="um-invite-title">Invite a team member</h2>
      <p className="um-invite-subtitle">
        We'll generate a secure link they can use to set their password and sign in.
      </p>

      {inviteResult ? (
        <div className="um-invite-success">
          <p className="um-invite-success-label">
            <I.checkCircle size={16} stroke={2.2} className="um-invite-success-icon" aria-hidden="true" />
            Account created for <strong>{inviteResult.email}</strong>
          </p>
          {inviteResult.email_sent ? (
            <p className="um-invite-link-note" style={{ color: "var(--on-green, #22863a)" }}>
              Invite email sent to <strong>{inviteResult.email}</strong>. If they
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
              Couldn't send the invite email to <strong>{inviteResult.email}</strong>.
              Share the link below so they can finish setting up.
            </p>
          )}
          {inviteResult.invite_link ? (
            <>
              <div className="um-invite-link-row">
                <input
                  className="um-invite-link-input"
                  readOnly
                  value={inviteResult.invite_link}
                  onFocus={(e) => e.target.select()}
                />
                <CopyButton text={inviteResult.invite_link} />
              </div>
              <p className="um-invite-link-note">
                {inviteResult.email_sent
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
          <button className="um-btn-secondary" onClick={() => setInviteResult(null)}>
            Invite another
          </button>
        </div>
      ) : (
        <form className="um-invite-form" onSubmit={handleInvite}>
          <div className="um-form-row">
            <div className="um-field">
              <label className="um-label" htmlFor="um-invite-email">
                Email address <span className="um-required" aria-label="required">*</span>
              </label>
              <input
                id="um-invite-email"
                className="um-input"
                type="email"
                required
                placeholder="jane.smith@school.edu"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={inviting}
              />
            </div>
            <div className="um-field">
              <label className="um-label" htmlFor="um-invite-name">Display name</label>
              <input
                id="um-invite-name"
                className="um-input"
                type="text"
                placeholder="Jane Smith"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                disabled={inviting}
              />
            </div>
          </div>

          <fieldset className="um-field um-field-role">
            <legend className="um-label">Role</legend>
            <div className="um-role-options">
              {availableRoles.map(({ value, icon, label, desc }) => {
                const Icon = icon;
                return (
                  <label key={value} className={`um-role-option ${inviteRole === value ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="inviteRole"
                      value={value}
                      checked={inviteRole === value}
                      onChange={() => setInviteRole(value)}
                      disabled={inviting}
                    />
                    <Icon size={16} stroke={2} className="um-role-icon" aria-hidden="true" />
                    <div>
                      <strong>{label}</strong>
                      <p>{desc}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {inviteError && <p className="um-field-error" role="alert">{inviteError}</p>}

          <div className="um-invite-actions">
            <button type="button" className="um-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="um-btn-primary" disabled={inviting}>
              {inviting ? "Creating account…" : "Send invite"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
