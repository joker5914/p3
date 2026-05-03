import { useEffect, useId, useRef, useState } from "react";

const API_BASE = "";

const BLANK = {
  name: "",
  work_email: "",
  school_name: "",
  role: "",
  students_count: "",
  preferred_times: "",
  message: "",
  // Honeypot — hidden from real users via CSS, named like a legit
  // field so naive bots fill it in.  Backend silently 200s when set.
  website: "",
};

const ROLE_OPTIONS = [
  "Principal / Head of School",
  "Assistant principal",
  "Operations / Front office",
  "District administrator",
  "Technology / IT",
  "Other",
];

/**
 * Demo-request modal opened by every "Book a demo" CTA on the marketing
 * site.  Posts to `/api/v1/public/demo-requests` (no auth) and shows a
 * confirmation state so the visitor knows the request landed without
 * having to bounce out to email.
 */
export default function BookDemoModal({ open, onClose, source = "unknown" }) {
  const [form, setForm]       = useState(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState("");
  const [submitted, setSubmitted] = useState(false);

  const titleId = useId();
  const firstFieldRef = useRef(null);

  // Reset state on every open so a previous submission doesn't bleed
  // into the next visitor's session.
  useEffect(() => {
    if (open) {
      setForm(BLANK);
      setSubmitted(false);
      setError("");
      // Wait one tick for the input to mount before grabbing focus.
      setTimeout(() => firstFieldRef.current?.focus(), 40);
    }
  }, [open]);

  // Esc closes; lock background scroll while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/v1/public/demo-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source }),
      });
      if (!res.ok) {
        // Pydantic validation errors come back as 422 with a structured
        // body; surface the first message to the user instead of a
        // generic "something broke."
        let detail = "";
        try {
          const data = await res.json();
          detail = data?.detail?.[0]?.msg || data?.detail || "";
        } catch { /* ignore parse errors */ }
        throw new Error(detail || `Request failed (${res.status})`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again or email hello@dismissal.app.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="web-modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="web-modal">
        <button
          type="button"
          className="web-modal-close"
          onClick={onClose}
          aria-label="Close dialog"
        >
          ×
        </button>

        {submitted ? (
          <div className="web-modal-success">
            <div className="web-modal-success-icon" aria-hidden="true">✓</div>
            <h2 id={titleId} className="web-modal-title">Request received.</h2>
            <p className="web-modal-lede">
              Thanks for reaching out. We'll get back to you within one business
              day to schedule the call. A real person will reply — not an automated
              sequence.
            </p>
            <button
              type="button"
              className="web-btn web-btn-primary web-btn-lg"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        ) : (
          <form className="web-modal-form" onSubmit={handleSubmit} noValidate>
            <header className="web-modal-head">
              <span className="web-eyebrow">Book a demo</span>
              <h2 id={titleId} className="web-modal-title">Tell us about your school.</h2>
              <p className="web-modal-lede">
                A 20-minute call. We'll ask about how your pickup runs today.
                You ask about how Dismissal works. No sales script — we want
                to find out together whether this is a fit.
              </p>
            </header>

            <div className="web-modal-grid">
              <label className="web-field">
                <span className="web-field-label">Your name <i>*</i></span>
                <input
                  ref={firstFieldRef}
                  className="web-input"
                  type="text"
                  required
                  value={form.name}
                  onChange={update("name")}
                  autoComplete="name"
                  disabled={submitting}
                />
              </label>

              <label className="web-field">
                <span className="web-field-label">Work email <i>*</i></span>
                <input
                  className="web-input"
                  type="email"
                  required
                  value={form.work_email}
                  onChange={update("work_email")}
                  autoComplete="email"
                  disabled={submitting}
                />
              </label>

              <label className="web-field">
                <span className="web-field-label">School or district <i>*</i></span>
                <input
                  className="web-input"
                  type="text"
                  required
                  value={form.school_name}
                  onChange={update("school_name")}
                  autoComplete="organization"
                  disabled={submitting}
                />
              </label>

              <label className="web-field">
                <span className="web-field-label">Your role <i>*</i></span>
                <select
                  className="web-input"
                  required
                  value={form.role}
                  onChange={update("role")}
                  disabled={submitting}
                >
                  <option value="" disabled>Select…</option>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>

              <label className="web-field">
                <span className="web-field-label">Students at pickup</span>
                <input
                  className="web-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 450"
                  value={form.students_count}
                  onChange={update("students_count")}
                  disabled={submitting}
                />
              </label>

              <label className="web-field">
                <span className="web-field-label">Preferred call times</span>
                <input
                  className="web-input"
                  type="text"
                  placeholder="e.g. Tue/Thu afternoons (CST)"
                  value={form.preferred_times}
                  onChange={update("preferred_times")}
                  disabled={submitting}
                />
              </label>
            </div>

            <label className="web-field web-field-wide">
              <span className="web-field-label">Anything we should know?</span>
              <textarea
                className="web-input web-textarea"
                rows={3}
                placeholder="What you use today, what slows pickup down, anything unusual about your campus."
                value={form.message}
                onChange={update("message")}
                disabled={submitting}
              />
            </label>

            {/* Honeypot.  Real users never see or fill this; bots usually
                do.  Display:none in CSS would tip off smarter bots, so we
                visually hide via tab-index + offscreen positioning. */}
            <div className="web-honeypot" aria-hidden="true">
              <label>
                Website
                <input
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={update("website")}
                />
              </label>
            </div>

            {error && <p className="web-modal-error" role="alert">{error}</p>}

            <div className="web-modal-actions">
              <button
                type="button"
                className="web-btn web-btn-ghost"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="web-btn web-btn-primary"
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send request"}
              </button>
            </div>

            <p className="web-modal-fineprint">
              We'll only use your details to schedule this call. No newsletter,
              no resale. <a href="mailto:hello@dismissal.app">hello@dismissal.app</a>
              {" "}if you'd rather just email us.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
