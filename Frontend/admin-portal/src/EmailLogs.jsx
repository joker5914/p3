import React, { useState, useEffect, useCallback, useMemo } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import "./UserManagement.css";

/* Platform-Admin-only diagnostic surface for transactional email
   delivery via Resend.  Reads the email_log collection populated by
   core/email.py so an operator can see exactly what happened to every
   invite / temp-expiry / demo-request email without leaving the portal
   or pulling Cloud Run logs.

   UX parity with PlatformUsers / UserManagement on purpose: same status
   filter tabs, same table chrome, same chip styling — Platform Admins
   shouldn't have to learn a new visual vocabulary for each surface. */

const STATUS_FILTERS = [
  { key: "all",     label: "All"     },
  { key: "sent",    label: "Sent"    },
  { key: "failed",  label: "Failed"  },
  { key: "skipped", label: "Skipped" },
];

const KIND_LABELS = {
  invite:       "Invite",
  temp_expiry:  "Temp vehicle expiry",
  demo_request: "Demo request",
};

function formatTimestamp(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

function StatusChip({ status }) {
  // Map send statuses onto the existing um-chip palette so we don't need
  // a new stylesheet for one screen:
  //   sent    → Active (green)
  //   failed  → Disabled (red)
  //   skipped → Pending (amber/grey)
  const variant = status === "sent" ? "active"
                : status === "failed" ? "disabled"
                : "pending";
  const label = status === "sent" ? "Sent"
              : status === "failed" ? "Failed"
              : status === "skipped" ? "Skipped"
              : status;
  return <span className={`um-chip um-chip-${variant}`}>{label}</span>;
}

function KindChip({ kind }) {
  return (
    <span className="um-chip um-chip-role-school_admin">
      <I.envelope size={11} stroke={2.2} aria-hidden="true" />
      {KIND_LABELS[kind] || kind}
    </span>
  );
}

function ErrorDetails({ row }) {
  // Inline expansion shown when a row is clicked.  Surfaces every
  // diagnostic field we capture so the operator can copy/paste a full
  // failure into a Resend support ticket without round-tripping into
  // Firestore.
  return (
    <div className="email-log-detail">
      <dl className="email-log-detail-grid">
        <dt>Recipient</dt>      <dd>{row.to || "—"}</dd>
        <dt>From</dt>           <dd>{row.from_email || "—"}</dd>
        <dt>Subject</dt>        <dd>{row.subject || "—"}</dd>
        <dt>HTTP status</dt>    <dd>{row.http_status ?? "—"}</dd>
        <dt>Provider id</dt>    <dd>{row.provider_id || "—"}</dd>
        <dt>Error code</dt>     <dd>{row.error_code || "—"}</dd>
        <dt>Triggered by</dt>   <dd>{row.actor_email || row.actor_uid || "system"}</dd>
        <dt>Correlation id</dt> <dd><code>{row.correlation_id || "—"}</code></dd>
      </dl>
      {row.error_message && (
        <>
          <p className="email-log-detail-label">Error message</p>
          <pre className="email-log-detail-pre">{row.error_message}</pre>
        </>
      )}
      {row.meta && Object.keys(row.meta).length > 0 && (
        <>
          <p className="email-log-detail-label">Metadata</p>
          <pre className="email-log-detail-pre">{JSON.stringify(row.meta, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

export default function EmailLogs({ token }) {
  const api = useMemo(() => createApiClient(token), [token]);

  const [logs, setLogs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [search, setSearch]     = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState(null); // log doc id

  const [summary, setSummary] = useState(null);

  const fetchLogs = useCallback(() => {
    setLoading(true);
    setError("");
    const params = {};
    if (statusFilter !== "all") params.status = statusFilter;
    api
      .get("/api/v1/admin/email-logs", { params })
      .then((res) => setLogs(res.data.logs || []))
      .catch((err) => setError(formatApiError(err, "Failed to load email logs.")))
      .finally(() => setLoading(false));
  }, [api, statusFilter]);

  const fetchSummary = useCallback(() => {
    api
      .get("/api/v1/admin/email-logs/summary")
      .then((res) => setSummary(res.data))
      .catch(() => setSummary(null));
  }, [api]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const statusCounts = useMemo(() => ({
    all:     logs.length,
    sent:    logs.filter((l) => l.status === "sent").length,
    failed:  logs.filter((l) => l.status === "failed").length,
    skipped: logs.filter((l) => l.status === "skipped").length,
  }), [logs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((l) => {
      const meta = l.meta || {};
      const blob = [
        l.to, l.from_email, l.subject, l.error_code, l.error_message,
        l.actor_email, l.actor_uid, l.kind, l.provider_id,
        meta.role, meta.to_name, meta.scope_label, meta.inviter_name,
      ].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [logs, search]);

  const emptyMessage = search
    ? "No email log entries match your search."
    : statusFilter === "failed"  ? "No failed sends in the recent log."
    : statusFilter === "skipped" ? "No skipped sends in the recent log."
    : statusFilter === "sent"    ? "No successful sends recorded yet."
    : "No email send attempts recorded yet.";

  return (
    <div className="um-container page-shell">

      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Platform · diagnostics</span>
          <h1 className="page-title">Email Delivery Log</h1>
          <p className="page-sub">
            Every invite, expiry notice, and demo-request email routed through Resend.
            Click any row for the full provider response.
          </p>
        </div>
        <div className="page-actions">
          {summary && (
            <span className="page-chip" aria-label="Last 24 hours">
              <I.envelope size={12} aria-hidden="true" />
              24h: {summary.counts?.sent ?? 0} sent
              {(summary.counts?.failed || 0) > 0 && (
                <> · <strong style={{ color: "var(--red, #d33)" }}>{summary.counts.failed} failed</strong></>
              )}
              {(summary.counts?.skipped || 0) > 0 && (
                <> · {summary.counts.skipped} skipped</>
              )}
            </span>
          )}
          <button className="um-btn-secondary" onClick={() => { fetchLogs(); fetchSummary(); }}>
            <I.spinner size={12} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="um-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            className="um-error-dismiss"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {summary?.last_failure && statusFilter !== "failed" && (
        <div
          role="status"
          style={{
            background: "var(--amber-subtle)",
            border: "1px solid var(--amber)",
            borderRadius: "var(--r-md, 6px)",
            color: "var(--amber)",
            padding: "10px 14px",
            margin: "0 0 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
          }}
        >
          <I.alert size={14} aria-hidden="true" />
          <span>
            Last failure {formatTimestamp(summary.last_failure.timestamp)} —{" "}
            <strong>{summary.last_failure.error_code || "error"}</strong>
            {summary.last_failure.error_message && <>: {summary.last_failure.error_message}</>}
          </span>
          <button
            className="um-btn-secondary"
            style={{ marginLeft: "auto" }}
            onClick={() => setStatusFilter("failed")}
          >
            View failures
          </button>
        </div>
      )}

      <div className="um-controls">
        <div
          className="um-filter-bar"
          role="tablist"
          aria-label="Filter email log by status"
        >
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              className={`um-filter-tab${statusFilter === key ? " active" : ""}`}
              onClick={() => setStatusFilter(key)}
              role="tab"
              aria-selected={statusFilter === key}
              aria-label={`${label}: ${statusCounts[key] || 0}`}
            >
              {label}
              {!loading && (
                <span className="um-filter-badge" aria-hidden="true">{statusCounts[key]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="um-search-wrap" role="search">
          <I.search size={14} className="um-search-icon" aria-hidden="true" />
          <label htmlFor="el-search" className="sr-only">Search email log</label>
          <input
            id="el-search"
            className="um-search-input"
            type="search"
            placeholder="Search by recipient, error, sender…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading email log…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty" role="status">
          <span className="page-empty-icon"><I.envelope size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">{emptyMessage}</p>
        </div>
      ) : (
        <div className="um-table-wrap">
          <table className="um-table">
            <caption className="sr-only">Email send attempts</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Kind</th>
                <th scope="col">To</th>
                <th scope="col">Status</th>
                <th scope="col">Detail</th>
                <th scope="col" aria-label="Expand"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isOpen = expanded === row.id;
                return (
                  <React.Fragment key={row.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : row.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{formatTimestamp(row.timestamp)}</td>
                      <td><KindChip kind={row.kind} /></td>
                      <td>{row.to || <span style={{ color: "var(--text-tertiary)" }}>—</span>}</td>
                      <td><StatusChip status={row.status} /></td>
                      <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.status === "sent"
                          ? <span style={{ color: "var(--text-tertiary)" }}>id {row.provider_id || "—"}</span>
                          : (row.error_message || row.error_code || "—")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <I.chevronRight
                          size={12}
                          aria-hidden="true"
                          style={{
                            transform: isOpen ? "rotate(90deg)" : "none",
                            transition: "transform 0.15s",
                          }}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--surface-2, #fafafa)" }}>
                          <ErrorDetails row={row} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
