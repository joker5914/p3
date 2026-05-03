import React, { useState, useEffect, useMemo } from "react";
import axios from "axios";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { downloadCSV, todayISO, formatDateTime , formatApiError } from "./utils";
import "./History.css";

const PAGE_SIZE = 50;

function ConfChip({ value }) {
  if (value == null) return <span className="hist-chip" aria-label="No confidence score">—</span>;
  const pct  = (value * 100).toFixed(0);
  const warn = value < 0.7;
  const Icon = warn ? I.alert : I.checkCircle;
  return (
    <span
      className={`hist-chip${warn ? " hist-chip-warn" : ""}`}
      aria-label={`${warn ? "Low confidence: " : "Confidence: "}${pct}%`}
    >
      <Icon size={11} stroke={2.2} aria-hidden="true" />
      {pct}%
    </span>
  );
}

const PICKUP_LABELS = {
  manual:      "Manual",
  manual_bulk: "Bulk",
  auto:        "Auto (Scanner)",
};

function PickupChip({ method, pickedUpAt }) {
  if (!method) return <span className="hist-chip">—</span>;
  const label = PICKUP_LABELS[method] || method;
  const title = pickedUpAt ? `Picked up: ${pickedUpAt}` : "";
  return (
    <span className={`hist-chip hist-chip-pickup hist-chip-pickup-${method}`} title={title}>
      {label}
    </span>
  );
}

export default function History({ token, schoolId = null }) {
  // ── filter state ──────────────────────────────────────
  const [search,    setSearch]    = useState("");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate,   setEndDate]   = useState(todayISO());

  // ── data state ────────────────────────────────────────
  const [rawRecords, setRawRecords] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [capped,     setCapped]     = useState(false);
  const [page,       setPage]       = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);

  // Per-row receipt download state.  We track in-flight scan ids in a
  // Set so multiple receipts can download concurrently without
  // their busy indicators interfering with one another.  ``receiptError``
  // is a single string slot — the most recent failure replaces the prior
  // one, mirroring how toasts surface in the Dashboard.
  const [receiptBusy, setReceiptBusy] = useState(() => new Set());
  const [receiptError, setReceiptError] = useState("");
  // ARIA live status used by screen readers when a download starts /
  // completes.  Empty string is intentional — the live region renders
  // unconditionally so SRs don't miss the first announcement after
  // page load.
  const [receiptStatus, setReceiptStatus] = useState("");

  // ── fetch from API (re-runs when date range or school changes) ───
  // AbortController cancels in-flight requests when deps change so a late
  // response from a stale date range can't clobber fresh data.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(1);

    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate)   params.set("end_date",   endDate);

    createApiClient(token, schoolId)
      .get(`/api/v1/history?${params.toString()}`, { signal: controller.signal })
      .then((res) => {
        setRawRecords(res.data.records || []);
        setCapped(res.data.capped || false);
      })
      .catch((err) => {
        if (axios.isCancel(err)) return;
        setError(formatApiError(err, "Failed to load history."));
        setRawRecords([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [token, schoolId, startDate, endDate, refreshTick]);

  // ── client-side search filter ────────────────────────
  const filteredRecords = useMemo(() => {
    const sl = search.trim().toLowerCase();
    if (!sl) return rawRecords;
    return rawRecords.filter((r) => {
      const students = Array.isArray(r.student) ? r.student.join(", ") : (r.student || "");
      return (
        (r.parent || "").toLowerCase().includes(sl) ||
        students.toLowerCase().includes(sl) ||
        (r.location || "").toLowerCase().includes(sl)
      );
    });
  }, [rawRecords, search]);

  // ── pagination ───────────────────────────────────────
  const totalPages   = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const safePage     = Math.min(page, totalPages);
  const pageRecords  = filteredRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Reset page when search changes
  useEffect(() => { setPage(1); }, [search]);

  // ── Signed pickup receipt (issue #72) ───────────────
  // Fetches the PDF as a Blob (axios responseType: "blob"), then
  // triggers a synthetic anchor click to download it.  Why a Blob/URL
  // round-trip instead of opening a new window:
  //
  //   * A new-tab approach loses the auth header — the backend
  //     requires a Firebase bearer, so we have to fetch the bytes
  //     ourselves through the api client.
  //   * Saving as a download (rather than rendering in-browser)
  //     matches what schools expect: they want to attach the receipt
  //     to a custody-dispute email or print it; in-browser viewers
  //     mid-flight aren't useful.
  //
  // The button announces start/finish to screen readers via the
  // live region below the table.  Errors land on the toast slot
  // *and* the live region so they're announced unprompted.
  const handleReceipt = async (record) => {
    if (!record?.id) return;
    setReceiptBusy((prev) => {
      const next = new Set(prev);
      next.add(record.id);
      return next;
    });
    setReceiptError("");
    setReceiptStatus("Generating signed pickup receipt…");
    try {
      const res = await createApiClient(token, schoolId).get(
        `/api/v1/receipts/${encodeURIComponent(record.id)}`,
        { responseType: "blob" },
      );
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const receiptId = res.headers?.["x-receipt-id"];
      const filename = receiptId
        ? `pickup-receipt-${receiptId}.pdf`
        : `pickup-receipt-${record.id}.pdf`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      // Anchor must be in the DOM for Firefox to honour the click.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setReceiptStatus("Receipt downloaded.");
    } catch (err) {
      const detail =
        err?.response?.data?.detail ||
        err?.message ||
        "Failed to generate receipt.";
      setReceiptError(detail);
      setReceiptStatus(`Receipt failed: ${detail}`);
    } finally {
      setReceiptBusy((prev) => {
        const next = new Set(prev);
        next.delete(record.id);
        return next;
      });
    }
  };

  // ── CSV export ───────────────────────────────────────
  const handleExport = () => {
    const rows = filteredRecords.map((r) => ({
      Timestamp:      r.timestamp || "",
      Guardian:       r.parent    || "",
      Students:       Array.isArray(r.student) ? r.student.join("; ") : (r.student || ""),
      Location:       r.location  || "",
      Confidence:     r.confidence_score != null ? `${(r.confidence_score * 100).toFixed(0)}%` : "",
      Pickup_Method:  r.pickup_method ? (PICKUP_LABELS[r.pickup_method] || r.pickup_method) : "",
      Picked_Up_At:   r.picked_up_at || "",
    }));
    downloadCSV(rows, `dismissal-history-${todayISO()}.csv`);
  };

  return (
    <div className="history-container page-shell">
      {/* ── Header — eyebrow + display headline + actions (page-chrome) ── */}
      <div className="page-head">
        <div className="page-head-left">
          <span className="t-eyebrow page-eyebrow">Activity · scans</span>
          <h1 className="page-title">Scan History</h1>
          {filteredRecords.length > 0 && (
            <span className="page-sub">
              {filteredRecords.length.toLocaleString()} record{filteredRecords.length !== 1 ? "s" : ""}
              {capped && " · capped at 500"}
            </span>
          )}
        </div>
        <div className="page-actions">
          <button
            className="hist-btn-export"
            onClick={handleExport}
            disabled={!filteredRecords.length}
            title="Export as CSV"
          >
            <I.download size={13} aria-hidden="true" />
            Export CSV
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="history-filters" role="search" aria-label="Filter history">
        <div className="hist-search-wrap">
          <I.search size={14} className="hist-search-icon" aria-hidden="true" />
          <label htmlFor="hist-search" className="sr-only">
            Search guardian, student, or location
          </label>
          <input
            id="hist-search"
            type="text"
            className="hist-search"
            placeholder="Search guardian or student…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="hist-clear-search"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear"
            >
              <I.x size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="hist-dates">
          <label className="hist-date-label" htmlFor="hist-start-date">From</label>
          <input
            id="hist-start-date"
            type="date"
            className="hist-date"
            value={startDate}
            max={endDate || todayISO()}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <label className="hist-date-label" htmlFor="hist-end-date">To</label>
          <input
            id="hist-end-date"
            type="date"
            className="hist-date"
            value={endDate}
            min={startDate}
            max={todayISO()}
            onChange={(e) => setEndDate(e.target.value)}
          />
          {(startDate || endDate) && (
            <button className="hist-btn hist-btn-ghost" onClick={() => { setStartDate(""); setEndDate(todayISO()); }}>
              Clear dates
            </button>
          )}
        </div>
      </div>

      {/* ── Capped warning ── */}
      {capped && (
        <div className="hist-cap-notice" role="status">
          <I.info size={14} aria-hidden="true" />
          <span>Showing the 500 most recent matching records. Narrow the date range to see more.</span>
        </div>
      )}

      {/* ── Receipt status (a11y live region) and error banner ──
          The live region lets a screen-reader announce "generating
          receipt" / "downloaded" / failure messages without stealing
          focus.  The error banner is dismissable via Esc-equivalent
          (the Clear button) — it's a polite alert, not a modal. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {receiptStatus}
      </div>
      {receiptError && (
        <div className="um-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{receiptError}</span>
          <button
            className="um-error-dismiss"
            onClick={() => { setReceiptError(""); setReceiptStatus(""); }}
            aria-label="Dismiss receipt error"
          >
            <I.x size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ── States ── */}
      {loading && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.spinner size={20} aria-hidden="true" /></span>
          <p className="page-empty-title">Loading history…</p>
        </div>
      )}

      {!loading && error && (
        <div className="um-error" role="alert">
          <I.alert size={14} aria-hidden="true" />
          <span>{error}</span>
          <button className="hist-btn-ghost" onClick={() => setRefreshTick((n) => n + 1)} style={{ marginLeft: "auto" }}>Retry</button>
        </div>
      )}

      {!loading && !error && filteredRecords.length === 0 && (
        <div className="page-empty" role="status" aria-live="polite">
          <span className="page-empty-icon"><I.history size={22} aria-hidden="true" /></span>
          <p className="page-empty-title">
            {rawRecords.length > 0 ? "No records match your search." : "No scans yet."}
          </p>
          <p className="page-empty-sub">
            {rawRecords.length > 0
              ? "Try clearing the search or widening the date range."
              : "Scan results from the LPR camera will appear here as soon as they come in."}
          </p>
        </div>
      )}

      {/* ── Table ── */}
      {!loading && !error && pageRecords.length > 0 && (
        <>
          <div className="hist-table-wrap accent-bar">
            <table className="hist-table">
              <caption className="sr-only">
                Scan history — {filteredRecords.length} records
              </caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Guardian</th>
                  <th scope="col">Student(s)</th>
                  <th scope="col">Location</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Pickup</th>
                  <th scope="col" className="hist-th-actions">
                    <span className="sr-only">Actions</span>
                    <span aria-hidden="true">Receipt</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRecords.map((r) => {
                  const students = Array.isArray(r.student)
                    ? r.student.join(", ")
                    : (r.student || "—");
                  const isBusy = receiptBusy.has(r.id);
                  const guardianLabel = r.parent || "guardian on record";
                  const timeLabel = formatDateTime(r.timestamp) || "this scan";
                  return (
                    <tr key={r.id} className="hist-row">
                      <td data-label="Time" className="hist-td-time">{formatDateTime(r.timestamp)}</td>
                      <td data-label="Guardian">{r.parent || "—"}</td>
                      <td data-label="Students">{students}</td>
                      <td data-label="Location" className="hist-td-secondary">{r.location || "—"}</td>
                      <td data-label="Confidence"><ConfChip value={r.confidence_score} /></td>
                      <td data-label="Pickup"><PickupChip method={r.pickup_method} pickedUpAt={r.picked_up_at} /></td>
                      <td data-label="Receipt" className="hist-td-actions">
                        <button
                          type="button"
                          className="hist-btn-receipt"
                          onClick={() => handleReceipt(r)}
                          disabled={isBusy}
                          aria-busy={isBusy}
                          aria-label={
                            isBusy
                              ? `Generating signed receipt for ${guardianLabel} at ${timeLabel}`
                              : `Download signed pickup receipt for ${guardianLabel} at ${timeLabel}`
                          }
                          title="Signed PDF receipt — chain-of-custody record for this dismissal"
                        >
                          {isBusy ? (
                            <I.spinner size={13} aria-hidden="true" />
                          ) : (
                            <I.receipt size={13} aria-hidden="true" />
                          )}
                          <span>{isBusy ? "Preparing…" : "Receipt"}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <nav className="hist-pagination" aria-label="History pagination">
              <button
                className="hist-page-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                aria-label="Previous page"
              >
                <I.chevronLeft size={12} aria-hidden="true" /> Previous
              </button>
              <span className="hist-page-info" aria-live="polite">
                Page {safePage} of {totalPages}
                <span className="hist-page-count">
                  &nbsp;({((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filteredRecords.length)} of {filteredRecords.length})
                </span>
              </span>
              <button
                className="hist-page-btn"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                aria-label="Next page"
              >
                Next <I.chevronRight size={12} aria-hidden="true" />
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
