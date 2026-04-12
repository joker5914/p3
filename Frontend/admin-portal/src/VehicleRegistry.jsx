import React, { useState, useEffect, useCallback, useMemo } from "react";
import { FaSearch, FaTrashAlt, FaExclamationTriangle, FaPencilAlt } from "react-icons/fa";
import { createApiClient } from "./api";
import { formatDate } from "./utils";
import PlateEditModal from "./PlateEditModal";
import "./VehicleRegistry.css";

export default function VehicleRegistry({ token, currentUser, schoolId = null }) {
  const isAdmin = currentUser?.role === "school_admin" || currentUser?.role === "super_admin";
  const [plates,    setPlates]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");
  const [search,    setSearch]    = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [deleting,  setDeleting]  = useState(new Set());
  const [editingPlate, setEditingPlate] = useState(null);

  const fetchPlates = useCallback(() => {
    setLoading(true); setError("");
    createApiClient(token, schoolId)
      .get("/api/v1/plates")
      .then((res) => setPlates(res.data.plates || []))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load registry."))
      .finally(() => setLoading(false));
  }, [token, schoolId]);

  useEffect(() => { fetchPlates(); }, [fetchPlates]);

  const filtered = useMemo(() => {
    const sl = search.trim().toLowerCase();
    if (!sl) return plates;
    return plates.filter((p) => {
      const students = (p.students || []).join(", ").toLowerCase();
      const vehiclesText = (p.vehicles || []).map((v) => [v.plate_number, v.make, v.model, v.color].filter(Boolean).join(" ")).join(" ").toLowerCase();
      const vehicle = [p.vehicle_make, p.vehicle_model, p.vehicle_color].filter(Boolean).join(" ").toLowerCase();
      const authNames = (p.authorized_guardians || []).map((a) => a.name).join(", ").toLowerCase();
      return (p.parent || "").toLowerCase().includes(sl) || students.includes(sl) || vehicle.includes(sl) || vehiclesText.includes(sl) || (p.plate_display || "").toLowerCase().includes(sl) || authNames.includes(sl);
    });
  }, [plates, search]);

  const handleDelete = async (plateToken) => {
    setDeleting((prev) => new Set([...prev, plateToken])); setConfirmId(null);
    try {
      await createApiClient(token, schoolId).delete(`/api/v1/plates/${encodeURIComponent(plateToken)}`);
      setPlates((prev) => prev.filter((p) => p.plate_token !== plateToken));
    } catch (err) {
      setError(err.response?.data?.detail || "Delete failed. Please try again.");
    } finally {
      setDeleting((prev) => { const n = new Set(prev); n.delete(plateToken); return n; });
    }
  };

  const handlePlateSaved = (updatedFields, newToken, rekeyed) => {
    setPlates((prev) => prev.map((p) =>
      p.plate_token === editingPlate.plate_token
        ? { ...p, plate_token: rekeyed ? newToken : p.plate_token, ...updatedFields, plate_display: updatedFields.plate_display || p.plate_display }
        : p
    ));
    setEditingPlate(null);
  };

  const vehicleLabel = (p) => {
    const vehicles = p.vehicles || [];
    if (vehicles.length > 1) {
      const first = [vehicles[0].color, vehicles[0].make, vehicles[0].model].filter(Boolean).join(" ");
      return first ? `${first} (+${vehicles.length - 1})` : `${vehicles.length} vehicles`;
    }
    const parts = [p.vehicle_color, p.vehicle_make, p.vehicle_model].filter(Boolean);
    return parts.length ? parts.join(" ") : "—";
  };

  return (
    <div className="registry-container">
      <div className="registry-header">
        <div className="registry-title-row">
          <h2 className="registry-title">Vehicle Registry</h2>
          {!loading && !error && <span className="registry-count">{plates.length.toLocaleString()} registered</span>}
        </div>
      </div>

      <div className="registry-search-bar">
        <div className="reg-search-wrap">
          <FaSearch className="reg-search-icon" />
          <input type="text" className="reg-search" placeholder="Search guardian, student, or vehicle…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="reg-clear-search" onClick={() => setSearch("")} title="Clear">×</button>}
        </div>
        {search && filtered.length !== plates.length && (<span className="reg-filter-count">{filtered.length} of {plates.length}</span>)}
      </div>

      {error && (
        <div className="reg-error">
          <FaExclamationTriangle style={{ flexShrink: 0 }} />{error}
          <button className="reg-btn reg-btn-ghost" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}

      {loading && <div className="reg-state">Loading registry…</div>}
      {!loading && !error && plates.length === 0 && (<div className="reg-state">No plates registered yet. Use <strong>Integrations → Data Import</strong> to add them.</div>)}
      {!loading && !error && plates.length > 0 && filtered.length === 0 && (<div className="reg-state">No records match your search.</div>)}

      {!loading && filtered.length > 0 && (
        <div className="reg-table-wrap">
          <table className="reg-table">
            <thead><tr><th>Guardian</th><th>Student(s)</th><th>Plate</th><th>Vehicle</th><th>Registered</th>{isAdmin && <th></th>}</tr></thead>
            <tbody>
              {filtered.map((p) => {
                const isConfirm = confirmId === p.plate_token;
                const isDeleting = deleting.has(p.plate_token);
                const authGuardians = p.authorized_guardians || [];
                return (
                  <tr key={p.plate_token} className={isConfirm ? "reg-row-confirm" : ""}>
                    <td className="reg-td-primary">
                      <div>{p.parent || "—"}</div>
                      {authGuardians.length > 0 && (<div className="reg-auth-badge" title={authGuardians.map((a) => a.name).join(", ")}>+{authGuardians.length} authorized</div>)}
                    </td>
                    <td>{(p.students || []).join(", ") || "—"}</td>
                    <td className="reg-td-plate">{p.plate_display || "—"}</td>
                    <td className="reg-td-secondary">{vehicleLabel(p)}</td>
                    <td className="reg-td-secondary">{formatDate(p.imported_at)}</td>
                    {isAdmin && (
                      <td className="reg-td-actions">
                        {isConfirm ? (
                          <div className="reg-confirm-row">
                            <span className="reg-confirm-label">Remove this record?</span>
                            <button className="reg-btn reg-btn-danger" onClick={() => handleDelete(p.plate_token)} disabled={isDeleting}>{isDeleting ? "Removing…" : "Confirm"}</button>
                            <button className="reg-btn reg-btn-ghost" onClick={() => setConfirmId(null)}>Cancel</button>
                          </div>
                        ) : (
                          <div className="reg-action-row">
                            <button className="reg-btn reg-btn-edit" onClick={() => setEditingPlate(p)} title="Edit record"><FaPencilAlt style={{ fontSize: 11 }} /></button>
                            <button className="reg-btn reg-btn-delete" onClick={() => setConfirmId(p.plate_token)} disabled={isDeleting} title="Remove from registry"><FaTrashAlt style={{ fontSize: 11 }} /></button>
                          </div>
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

      {editingPlate && (
        <PlateEditModal plate={editingPlate} token={token} schoolId={schoolId} onClose={() => setEditingPlate(null)} onSaved={handlePlateSaved} />
      )}
    </div>
  );
}
