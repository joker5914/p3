import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaSearch, FaDownload, FaChevronLeft, FaChevronRight } from "react-icons/fa";
import { createApiClient } from "./api";
import { downloadCSV, todayISO, formatDateTime } from "./utils";
import "./History.css";

const PAGE_SIZE = 50;

function ConfChip({ value }) {
  if (value == null) return <span className="hist-chip">—</span>;
  const pct  = (value * 100).toFixed(0);
  const warn = value < 0.7;
  return (
    <span className={`hist-chip${warn ? " hist-chip-warn" : ""}`}>
      {warn ? "⚠️" : "🎯"} {pct}%
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
  const [startDate, setStartDate] = useState("");
  const [endDate,   setEndDate]   = useState(todayISO());

  // ── data state ────────────────────────────────────────
  const [rawRecords, setRawRecords] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [capped,     setCapped]     = useState(false);
  const [page,       setPage]       = useState(1);

  // ── fetch from API (called when date range changes) ───
  const fetchHistory = useCallback(() => {
    setLoading(true);
    setError("");
    setPage(1);

    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate)   params.set("end_date",   endDate);

    createApiClient(token, schoolId)
      .get(`/api/v1/history?${params.toString()}`)
      .then((res) => {
        setRawRecords(res.data.records || []);
        setCapped(res.data.capped || false);
      })
      .catch((err) => {
        setError(err.response?.data?.detail || "Failed to load history.");
        setRawRecords([]);
      })
      .finally(() => setLoading(false));
  }, [token, startDate, endDate]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

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
    downloadCSV(rows, `p3-history-${todayISO()}.csv`);
  };

  return (
    <div className="history-container">
      {/* ── Header ── */}
      <div className="history-header">
        <div className="history-title-row">
          <h2 className="history-title">Scan History</h2>
          {filteredRecords.length > 0 && (
            <span className="history-count">{filteredRecords.length.toLocaleString()} record{filteredRecords.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <button
          className="hist-btn hist-btn-export"
          onClick={handleExport}
          disabled={!filteredRecords.length}
          title="Export as CSV"
        >
          <FaDownload style={{ fontSize: 12 }} /> Export CSV
        </button>
      </div>

      {/* ── Filter bar ── */}
      <div className="history-filters">
        <div className="hist-search-wrap">
          <FaSearch className="hist-search-icon" />
          <input
            type="text"
            className="hist-search"
            placeholder="Search guardian or student…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="hist-clear-search" onClick={() => setSearch("")} title="Clear">×</button>
          )}
        </div>

        <div className="hist-dates">
          <label className="hist-date-label">From</label>
          <input
            type="date"
            className="hist-date"
            value={startDate}
            max={endDate || todayISO()}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <label className="hist-date-label">To</label>
          <input
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
        <div className="hist-cap-notice">
          Showing the 500 most recent matching records. Narrow the date range to see more.
        </div>
      )}

      {/* ── States ── */}
      {loading && <div className="hist-state">Loading history…</div>}

      {!loading && error && (
        <div className="hist-error">{error} <button className="hist-btn hist-btn-ghost" onClick={fetchHistory}>Retry</button></div>
      )}

      {!loading && !error && filteredRecords.length === 0 && (
        <div className="hist-state">
          {rawRecords.length > 0 ? "No records match your search." : "No scan history found for this date range."}
        </div>
      )}

      {/* ── Table ── */}
      {!loading && !error && pageRecords.length > 0 && (
        <>
          <div className="hist-table-wrap">
            <table className="hist-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Guardian</th>
                  <th>Student(s)</th>
                  <th>Location</th>
                  <th>Confidence</th>
                  <th>Pickup</th>
                </tr>
              </thead>
              <tbody>
                {pageRecords.map((r) => {
                  const students = Array.isArray(r.student)
                    ? r.student.join(", ")
                    : (r.student || "—");
                  return (
                    <tr key={r.id}>
                      <td className="hist-td-time">{formatDateTime(r.timestamp)}</td>
                      <td>{r.parent || "—"}</td>
                      <td>{students}</td>
                      <td className="hist-td-secondary">{r.location || "—"}</td>
                      <td><ConfChip value={r.confidence_score} /></td>
                      <td><PickupChip method={r.pickup_method} pickedUpAt={r.picked_up_at} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div className="hist-pagination">
              <button
                className="hist-page-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
              >
                <FaChevronLeft style={{ fontSize: 11 }} /> Previous
              </button>
              <span className="hist-page-info">
                Page {safePage} of {totalPages}
                <span className="hist-page-count">
                  &nbsp;({((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filteredRecords.length)} of {filteredRecords.length})
                </span>
              </span>
              <button
                className="hist-page-btn"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                Next <FaChevronRight style={{ fontSize: 11 }} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
