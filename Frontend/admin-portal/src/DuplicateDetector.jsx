import React, { useState, useEffect, useCallback } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatDate , formatApiError } from "./utils";
import PersonAvatar from "./PersonAvatar";
import "./DuplicateDetector.css";

const REASON_LABELS = {
  exact_plate: "Exact plate match",
  similar_plate: "Similar plate",
  guardian_vehicle: "Same guardian & vehicle",
};

function RecordCard({ record, selected, onSelect }) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      className={`dup-card${selected ? " dup-card-selected" : ""}`}
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      aria-label={`Keep ${record.guardian || "Unknown"}, plate ${record.plate_display || "N/A"}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
    >
      <div className="dup-card-header">
        <PersonAvatar name={record.guardian} photoUrl={record.guardian_photo_url} size={32} />
        <div className="dup-card-meta">
          <span className="dup-card-guardian">{record.guardian || "Unknown"}</span>
          <span className="dup-card-plate">{record.plate_display || "N/A"}</span>
        </div>
        {selected && <I.check size={14} className="dup-card-check" aria-hidden="true" />}
      </div>
      {record.students.length > 0 && (
        <div className="dup-card-row">
          <span className="dup-card-label">Students</span>
          <span>{record.students.join(", ")}</span>
        </div>
      )}
      {record.vehicles.map((v, i) => (
        <div className="dup-card-row" key={i}>
          <span className="dup-card-label">{record.vehicles.length > 1 ? `Vehicle ${i + 1}` : "Vehicle"}</span>
          <span>{[v.color, v.make, v.model].filter(Boolean).join(" ") || "—"}</span>
        </div>
      ))}
      <div className="dup-card-row">
        <span className="dup-card-label">Auth. pickups</span>
        <span>{record.auth_count}</span>
      </div>
      {record.imported_at && (
        <div className="dup-card-row">
          <span className="dup-card-label">Registered</span>
          <span>{formatDate(record.imported_at)}</span>
        </div>
      )}
    </div>
  );
}

export default function DuplicateDetector({ token, schoolId }) {
  const [pairs, setPairs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [keepToken, setKeepToken] = useState(null);
  const [acting, setActing] = useState(false);
  const [keepReason, setKeepReason] = useState("");

  const api = useCallback(() => createApiClient(token, schoolId), [token, schoolId]);

  const fetchDuplicates = useCallback(() => {
    setLoading(true);
    setError("");
    api()
      .get("/api/v1/admin/registry/duplicates")
      .then((res) => setPairs(res.data.pairs || []))
      .catch((err) => setError(formatApiError(err, "Failed to scan for duplicates.")))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { fetchDuplicates(); }, [fetchDuplicates]);

  function expand(idx) {
    setExpandedIdx((prev) => (prev === idx ? null : idx));
    setKeepToken(null);
    setKeepReason("");
  }

  async function handleMerge(pair) {
    if (!keepToken) return;
    const discardToken = keepToken === pair.a.plate_token ? pair.b.plate_token : pair.a.plate_token;
    setActing(true);
    try {
      await api().post("/api/v1/admin/registry/merge", {
        keep_token: keepToken,
        discard_token: discardToken,
      });
      setPairs((prev) => prev.filter((_, i) => i !== expandedIdx));
      setExpandedIdx(null);
      setKeepToken(null);
    } catch (err) {
      setError(formatApiError(err, "Merge failed."));
    } finally {
      setActing(false);
    }
  }

  async function handleKeepBoth(pair) {
    setActing(true);
    try {
      await api().post("/api/v1/admin/registry/keep-both", {
        token_a: pair.a.plate_token,
        token_b: pair.b.plate_token,
        reason: keepReason,
      });
      setPairs((prev) => prev.filter((_, i) => i !== expandedIdx));
      setExpandedIdx(null);
      setKeepReason("");
    } catch (err) {
      setError(formatApiError(err, "Dismiss failed."));
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="dup-container">
      <div className="dup-header">
        <div className="dup-title-row">
          <h3 className="dup-title">Duplicate Detector</h3>
          {!loading && <span className="dup-count">{pairs.length} found</span>}
        </div>
        <button className="reg-btn reg-btn-ghost" onClick={fetchDuplicates} disabled={loading}>
          <I.refresh size={11} className={loading ? "dup-spin" : ""} aria-hidden="true" />
          {loading ? "Scanning…" : "Re-scan"}
        </button>
      </div>

      {error && (
        <div className="reg-error" role="alert">
          <I.alert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
          {error}
          <button className="reg-btn reg-btn-ghost" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {!loading && pairs.length === 0 && !error && (
        <div className="dup-empty" role="status">
          <I.check size={22} className="dup-empty-icon" aria-hidden="true" />
          <p>No duplicates detected. Registry is clean.</p>
        </div>
      )}

      <div className="dup-list">
        {pairs.map((pair, idx) => {
          const isOpen = expandedIdx === idx;
          const detailId = `dup-detail-${idx}`;
          return (
            <div key={idx} className={`dup-pair${isOpen ? " dup-pair-open" : ""}`}>
              {/* Summary row */}
              <button
                className="dup-pair-summary"
                onClick={() => expand(idx)}
                aria-expanded={isOpen}
                aria-controls={detailId}
              >
                <div className="dup-pair-plates">
                  <span className="dup-pair-plate">{pair.a.plate_display || "N/A"}</span>
                  <span className="dup-pair-vs">vs</span>
                  <span className="dup-pair-plate">{pair.b.plate_display || "N/A"}</span>
                </div>
                <span className={`dup-reason dup-reason-${pair.reason}`}>
                  {REASON_LABELS[pair.reason] || pair.reason}
                </span>
                <I.chevronRight
                  size={14}
                  className={`dup-chevron${isOpen ? " dup-chevron-open" : ""}`}
                  aria-hidden="true"
                />
              </button>

              {/* Expanded comparison */}
              {isOpen && (
                <div className="dup-detail" id={detailId}>
                  <p className="dup-detail-hint">Select the record to <strong>keep</strong>, then merge or dismiss.</p>
                  <div className="dup-compare" role="radiogroup" aria-label="Choose which record to keep">
                    <RecordCard
                      record={pair.a}
                      selected={keepToken === pair.a.plate_token}
                      onSelect={() => setKeepToken(pair.a.plate_token)}
                    />
                    <RecordCard
                      record={pair.b}
                      selected={keepToken === pair.b.plate_token}
                      onSelect={() => setKeepToken(pair.b.plate_token)}
                    />
                  </div>
                  <div className="dup-actions">
                    <button
                      className="reg-btn reg-btn-primary"
                      disabled={!keepToken || acting}
                      onClick={() => handleMerge(pair)}
                    >
                      {acting ? "Merging…" : "Merge records"}
                    </button>
                    <div className="dup-keep-both">
                      <label htmlFor={`keep-reason-${idx}`} className="sr-only">
                        Reason these are distinct records (optional)
                      </label>
                      <input
                        id={`keep-reason-${idx}`}
                        className="dup-keep-input"
                        placeholder="Reason they're distinct (optional)"
                        value={keepReason}
                        onChange={(e) => setKeepReason(e.target.value)}
                      />
                      <button
                        className="reg-btn reg-btn-ghost"
                        disabled={acting}
                        onClick={() => handleKeepBoth(pair)}
                      >
                        Keep both
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
