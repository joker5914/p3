import React from "react";
import { I } from "./components/icons";

// Source of truth for the timezone + license-tier dropdowns.  Re-exported
// because SiteSettings still needs LICENSE_TIERS to render tier labels in
// the table cells (so we don't risk the modal and the table drifting
// apart).
export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export const LICENSE_TIERS = [
  { value: "trial",      label: "Trial"      },
  { value: "basic",      label: "Basic"      },
  { value: "standard",   label: "Standard"   },
  { value: "premium",    label: "Premium"    },
  { value: "enterprise", label: "Enterprise" },
];

/**
 * Add / Edit school modal.
 *
 * Stateless: parent owns `form`, `formMode`, `formError`, `saving`, the
 * change handler, and the submit/close callbacks — keeps the existing
 * data-flow intact and lets the parent's Esc-key handler close the
 * modal without crossing component boundaries.
 */
export default function SchoolFormModal({
  mode,
  form,
  formError,
  saving,
  onChange,
  onSubmit,
  onClose,
}) {
  return (
    <div
      className="ss-modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="ss-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ss-form-title"
      >
        <div className="ss-modal-header">
          <h2 id="ss-form-title" className="ss-modal-title">
            {mode === "create" ? "Add School" : "Edit Location"}
          </h2>
          <button
            className="ss-modal-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <I.x size={16} aria-hidden="true" />
          </button>
        </div>
        <form className="ss-form" onSubmit={onSubmit}>
          <div className="ss-form-section">
            <h3 className="ss-section-title">School Info</h3>
            <div className="ss-field">
              <label className="ss-label" htmlFor="ss-form-name">
                School Name <span className="ss-required" aria-label="required">*</span>
              </label>
              <input
                id="ss-form-name"
                className="ss-input"
                name="name"
                value={form.name}
                onChange={onChange}
                placeholder="e.g. Riverside Elementary"
                required
              />
            </div>
            <div className="ss-field">
              <label className="ss-label" htmlFor="ss-form-admin-email">Primary Admin Email</label>
              <input
                id="ss-form-admin-email"
                className="ss-input"
                name="admin_email"
                type="email"
                value={form.admin_email}
                onChange={onChange}
                placeholder="principal@school.edu"
              />
            </div>
            <div className="ss-form-row">
              <div className="ss-field">
                <label className="ss-label" htmlFor="ss-form-phone">Phone</label>
                <input
                  id="ss-form-phone"
                  className="ss-input"
                  name="phone"
                  value={form.phone}
                  onChange={onChange}
                  placeholder="(555) 123-4567"
                />
              </div>
              <div className="ss-field">
                <label className="ss-label" htmlFor="ss-form-website">Website</label>
                <input
                  id="ss-form-website"
                  className="ss-input"
                  name="website"
                  value={form.website}
                  onChange={onChange}
                  placeholder="https://school.edu"
                />
              </div>
            </div>
            <div className="ss-field">
              <label className="ss-label" htmlFor="ss-form-address">Address</label>
              <input
                id="ss-form-address"
                className="ss-input"
                name="address"
                value={form.address}
                onChange={onChange}
                placeholder="123 Main St, City, ST 12345"
              />
            </div>
            <div className="ss-field">
              <label className="ss-label" htmlFor="ss-form-timezone">Timezone</label>
              <select
                id="ss-form-timezone"
                className="ss-select"
                name="timezone"
                value={form.timezone}
                onChange={onChange}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ss-form-section">
            <h3 className="ss-section-title">License</h3>
            <label className="ss-checkbox">
              <input
                type="checkbox"
                name="is_licensed"
                checked={form.is_licensed}
                onChange={onChange}
              />
              <span>License this school to be used officially</span>
            </label>
            <div className="ss-form-row">
              <div className="ss-field">
                <label className="ss-label" htmlFor="ss-form-tier">License Tier</label>
                <select
                  id="ss-form-tier"
                  className="ss-select"
                  name="license_tier"
                  value={form.license_tier}
                  onChange={onChange}
                  disabled={!form.is_licensed}
                >
                  {LICENSE_TIERS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ss-field">
                <label className="ss-label" htmlFor="ss-form-expires">License Expires</label>
                <input
                  id="ss-form-expires"
                  className="ss-input"
                  type="date"
                  name="license_expires_at"
                  value={form.license_expires_at}
                  onChange={onChange}
                  disabled={!form.is_licensed}
                />
              </div>
            </div>
          </div>

          <div className="ss-form-section">
            <h3 className="ss-section-title">Admin Notes</h3>
            <div className="ss-field">
              <label className="ss-label" htmlFor="ss-form-notes">Admin Notes</label>
              <textarea
                id="ss-form-notes"
                className="ss-textarea"
                name="notes"
                value={form.notes}
                onChange={onChange}
                placeholder="Internal notes about this school (not visible to school staff)"
                rows={3}
              />
            </div>
          </div>

          {formError && <p className="ss-field-error" role="alert">{formError}</p>}

          <div className="ss-form-actions">
            <button
              type="button"
              className="ss-btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="ss-btn-primary" disabled={saving}>
              {saving ? (
                <>
                  <I.spinner size={13} aria-hidden="true" /> Saving…
                </>
              ) : mode === "create" ? (
                "Create School"
              ) : (
                "Save Changes"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
