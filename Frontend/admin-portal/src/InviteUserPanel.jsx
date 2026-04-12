import React, { useState } from "react";
import { FaUserPlus, FaUserShield, FaUser, FaCopy, FaCheck } from "react-icons/fa";

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }); };
  return (<button className="um-btn-copy" onClick={handleCopy} title="Copy invite link">{copied ? <FaCheck /> : <FaCopy />}{copied ? "Copied!" : "Copy link"}</button>);
}

/**
 * Self-contained invite panel. Manages its own form state.
 * Props:
 *   api            axios-like client instance
 *   onInviteSuccess  called with no args after a successful invite (triggers parent list refresh)
 *   onClose        called when user clicks Cancel
 */
export default function InviteUserPanel({ api, onInviteSuccess, onClose }) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName]   = useState("");
  const [inviteRole, setInviteRole]   = useState("staff");
  const [inviting, setInviting]       = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteResult, setInviteResult] = useState(null);

  const handleInvite = async (e) => {
    e.preventDefault(); setInviting(true); setInviteError(""); setInviteResult(null);
    try {
      const res = await api.post("/api/v1/users/invite", { email: inviteEmail.trim(), display_name: inviteName.trim(), role: inviteRole });
      setInviteResult({ email: inviteEmail.trim(), invite_link: res.data.invite_link || "" });
      setInviteEmail(""); setInviteName(""); setInviteRole("staff");
      onInviteSuccess();
    } catch (err) { setInviteError(err.response?.data?.detail || "Failed to send invite."); }
    finally { setInviting(false); }
  };

  return (
    <div className="um-invite-panel">
      <h2 className="um-invite-title">Invite a team member</h2>
      <p className="um-invite-subtitle">We’ll generate a secure link they can use to set their password and sign in.</p>

      {inviteResult ? (
        <div className="um-invite-success">
          <p className="um-invite-success-label"><FaCheck className="um-invite-success-icon" />Account created for <strong>{inviteResult.email}</strong></p>
          {inviteResult.invite_link ? (
            <>
              <div className="um-invite-link-row">
                <input className="um-invite-link-input" readOnly value={inviteResult.invite_link} onFocus={(e) => e.target.select()} />
                <CopyButton text={inviteResult.invite_link} />
              </div>
              <p className="um-invite-link-note">Share this link so they can set their password. After setting it, they’ll be redirected to the sign-in page — they must sign in with their email and new password to access the app.</p>
            </>
          ) : (
            <p className="um-invite-link-note">Account created. Ask them to use the “Forgot password” link on the sign-in page to set their password.</p>
          )}
          <button className="um-btn-secondary" onClick={() => setInviteResult(null)}>Invite another</button>
        </div>
      ) : (
        <form className="um-invite-form" onSubmit={handleInvite}>
          <div className="um-form-row">
            <div className="um-field">
              <label className="um-label">Email address <span className="um-required">*</span></label>
              <input className="um-input" type="email" required placeholder="jane.smith@school.edu" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} disabled={inviting} />
            </div>
            <div className="um-field">
              <label className="um-label">Display name</label>
              <input className="um-input" type="text" placeholder="Jane Smith" value={inviteName} onChange={(e) => setInviteName(e.target.value)} disabled={inviting} />
            </div>
          </div>
          <div className="um-field um-field-role">
            <label className="um-label">Role</label>
            <div className="um-role-options">
              {[
                { value: "staff", Icon: FaUser, label: "Staff", desc: "View dashboard, history, and reports. Cannot manage users or import data." },
                { value: "school_admin", Icon: FaUserShield, label: "Admin", desc: "Full access including user management, data import, and registry edits." },
              ].map(({ value, Icon, label, desc }) => (
                <label key={value} className={`um-role-option ${inviteRole === value ? "selected" : ""}`}>
                  <input type="radio" name="inviteRole" value={value} checked={inviteRole === value} onChange={() => setInviteRole(value)} disabled={inviting} />
                  <Icon className="um-role-icon" />
                  <div><strong>{label}</strong><p>{desc}</p></div>
                </label>
              ))}
            </div>
          </div>
          {inviteError && <p className="um-field-error">{inviteError}</p>}
          <div className="um-invite-actions">
            <button type="button" className="um-btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="um-btn-primary" disabled={inviting}>{inviting ? "Creating account…" : "Send invite"}</button>
          </div>
        </form>
      )}
    </div>
  );
}
