import React from "react";
import { FaSpinner } from "react-icons/fa";

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu",
];

const LICENSE_TIERS = [
  { value: "trial", label: "Trial" }, { value: "basic", label: "Basic" },
  { value: "standard", label: "Standard" }, { value: "premium", label: "Premium" },
  { value: "enterprise", label: "Enterprise" },
];

/**
 * Add / Edit school modal form.
 *
 * Props:
 *   mode         "create" | "edit"
 *   form         current form values
 *   onChange     (e) => void — standard input change handler
 *   onSubmit     (e) => void
 *   onClose      () => void
 *   saving       boolean
 *   formError    string | null
 */
export default function SchoolFormModal({ mode, form, onChange, onSubmit, onClose, saving, formError }) {
  return (
    <div className="ss-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ss-modal">
        <div className="ss-modal-header">
          <h2 className="ss-modal-title">{mode === "create" ? "Add School" : "Edit Site Settings"}</h2>
          <button className="ss-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <form className="ss-form" onSubmit={onSubmit}>
          {/* School Info */}
          <div className="ss-form-section">
            <h3 className="ss-section-title">School Info</h3>
            <div className="ss-field">
              <label className="ss-label">School Name *</label>
              <input className="ss-input" name="name" value={form.name} onChange={onChange} placeholder="e.g. Riverside Elementary" required />
            </div>
            <div className="ss-field">
              <label className="ss-label">Primary Admin Email</label>
              <input className="ss-input" name="admin_email" type="email" value={form.admin_email} onChange={onChange} placeholder="principal@school.edu" />
            </div>
            <div className="ss-grid-2">
              <div className="ss-field">
                <label className="ss-label">Phone</label>
                <input className="ss-input" name="phone" value={form.phone} onChange={onChange} placeholder="(555) 123-4567" />
              </div>
              <div className="ss-field">
                <label className="ss-label">Website</label>
                <input className="ss-input" name="website" value={form.website} onChange={onChange} placeholder="https://school.edu" />
              </div>
            </div>
            <div className="ss-field">
              <label className="ss-label">Address</label>
              <input className="ss-input" name="address" value={form.address} onChange={onChange} placeholder="123 Main St, City, ST 12345" />
            </div>
            <div className="ss-field">
              <label className="ss-label">Timezone</label>
              <select className="ss-select" name="timezone" value={form.timezone} onChange={onChange}>
                {TIMEZONES.map((tz) => (<option key={tz} value={tz}>{tz}</option>))}
              </select>
            </div>
          </div>

          {/* License */}
          <div className="ss-form-section">
            <h3 className="ss-section-title">License</h3>
            <label className="ss-checkbox">
              <input type="checkbox" name="is_licensed" checked={form.is_licensed} onChange={onChange} />
              <span>License this school to be used officially</span>
            </label>
            <div className="ss-grid-2">
              <div className="ss-field">
                <label className="ss-label">License Tier</label>
                <select className="ss-select" name="license_tier" value={form.license_tier} onChange={onChange} disabled={!form.is_licensed}>
                  {LICENSE_TIERS.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                </select>
              </div>
              <div className="ss-field">
                <label className="ss-label">License Expires</label>
                <input className="ss-input" type="date" name="license_expires_at" value={form.license_expires_at} onChange={onChange} disabled={!form.is_licensed} />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="ss-form-section">
            <h3 className="ss-section-title">Admin Notes</h3>
            <div className="ss-field">
              <textarea className="ss-textarea" name="notes" value={form.notes} onChange={onChange} placeholder="Internal notes about this school (not visible to school staff)" rows={3} />
            </div>
          </div>

          {formError && <p className="ss-error">{formError}</p>}
          <div className="ss-form-actions">
            <button type="button" className="ss-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="ss-btn-primary" disabled={saving}>
              {saving ? (<><FaSpinner className="ss-spinner-sm" /> Saving&hellip;</>) : mode === "create" ? "Create School" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
