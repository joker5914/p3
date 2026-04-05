import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaSearch, FaTrashAlt, FaExclamationTriangle } from "react-icons/fa";
import { createApiClient } from "./api";
import { formatDate } from "./utils";
import "./VehicleRegistry.css";

export default function VehicleRegistry({ token, currentUser }) {
  const isAdmin = currentUser?.role === "school_admin";
  const [plates,    setPlates]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");
  const [search,    setSearch]    = useState("");
  const [confirmId, setConfirmId] = useState(null); // plate_token pending delete
  const [deleting,  setDeleting]  = useState(new Set());

  // ── fetch ─────────────────────────────────────────────
  const fetchPlates = useCallback(() => {
    setLoading(true);
    setError("");
    createApiClient(token)
      .get("/api/v1/plates")
      .then((res) => setPlates(res.data.plates || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load registry."))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { fetchPlates(); }, [fetchPlates]);

  // ── client-side search ────────────────────────────────
  const filtered = useMemo(() => {
    const sl = search.trim().toLowerCase();
    if (!sl) return plates;
    return plates.filter((p) => {
      const students = (p.students || []).join(", ").toLowerCase();
      const vehicle  = [p.vehicle_make, p.vehicle_model, p.vehicle_color]
        .filter(Boolean).join(" ").toLowerCase();
      return (
        (p.parent || "").toLowerCase().includes(sl) ||
        students.includes(sl) ||
        vehicle.includes(sl)
      );
    });
  }, [plates, search]);

  // ── delete ────────────────────────────────────────────
  const handleDelete = async (plateToken) => {
    setDeleting((prev) => new Set([...prev, plateToken]));
    setConfirmId(null);
    try {
      await createApiClient(token).delete(`/api/v1/plates/${encodeURIComponent(plateToken)}`);
      setPlates((prev) => prev.filter((p) => p.plate_token !== plateToken));
    } catch (err) {
      setError(err.response?.data?.detail || "Delete failed. Please try again.");
    } finally {
      setDeleting((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  // ── vehicle label ──────────────────────────────────────
  const vehicleLabel = (p) => {
    const parts = [p.vehicle_color, p.vehicle_make, p.vehicle_model].filter(Boolean);
    return parts.length ? parts.join(" ") : "—";
  };

  return (
    <div className="registry-container">
      {/* ── Header ── */}
      <div className="registry-header">
        <div className="registry-title-row">
          <h2 className="registry-title">Vehicle Registry</h2>
          {!loading && !error && (
            <span className="registry-count">{plates.length.toLocaleString()} registered</span>
          )}
        </div>
      </div>

      {/* ── Search ── */}
      <div className="registry-search-bar">
        <div className="reg-search-wrap">
          <FaSearch className="reg-search-icon" />
          <input
            type="text"
            className="reg-search"
            placeholder="Search guardian, student, or vehicle…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="reg-clear-search" onClick={() => setSearch("")} title="Clear">×</button>
          )}
        </div>
        {search && filtered.length !== plates.length && (
          <span className="reg-filter-count">{filtered.length} of {plates.length}</span>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="reg-error">
          <FaExclamationTriangle style={{ flexShrink: 0 }} />
          {error}
          <button className="reg-btn reg-btn-ghost" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {/* ── States ── */}
      {loading && <div className="reg-state">Loading registry…</div>}

      {!loading && !error && plates.length === 0 && (
        <div className="reg-state">
          No plates registered yet. Use <strong>Integrations → Data Import</strong> to add them.
        </div>
      )}

      {!loading && !error && plates.length > 0 && filtered.length === 0 && (
        <div className="reg-state">No records match your search.</div>
      )}

      {/* ── Table ── */}
      {!loading && filtered.length > 0 && (
        <div className="reg-table-wrap">
          <table className="reg-table">
            <thead>
              <tr>
                <th>Guardian</th>
                <th>Student(s)</th>
                <th>Vehicle</th>
                <th>Registered</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isConfirm  = confirmId === p.plate_token;
                const isDeleting = deleting.has(p.plate_token);

                return (
                  <tr key={p.plate_token} className={isConfirm ? "reg-row-confirm" : ""}>
                    <td className="reg-td-primary">{p.parent || "—"}</td>
                    <td>{(p.students || []).join(", ") || "—"}</td>
                    <td className="reg-td-secondary">{vehicleLabel(p)}</td>
                    <td className="reg-td-secondary">{formatDate(p.imported_at)}</td>
                    {isAdmin && (
                      <td className="reg-td-actions">
                        {isConfirm ? (
                          <div className="reg-confirm-row">
                            <span className="reg-confirm-label">Remove this record?</span>
                            <button
                              className="reg-btn reg-btn-danger"
                              onClick={() => handleDelete(p.plate_token)}
                              disabled={isDeleting}
                            >
                              {isDeleting ? "Removing…" : "Confirm"}
                            </button>
                            <button
                              className="reg-btn reg-btn-ghost"
                              onClick={() => setConfirmId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="reg-btn reg-btn-delete"
                            onClick={() => setConfirmId(p.plate_token)}
                            disabled={isDeleting}
                            title="Remove from registry"
                          >
                            <FaTrashAlt style={{ fontSize: 11 }} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
