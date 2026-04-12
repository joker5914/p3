import React, { useState, useEffect, useCallback } from "react";

const IconCar = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h1l2-3h8l2 3h1a2 2 0 012 2v6a2 2 0 01-2 2M5 17a2 2 0 002 2h10a2 2 0 002-2" /><circle cx="7.5" cy="14.5" r="1.5" /><circle cx="16.5" cy="14.5" r="1.5" /></svg>);

export default function BenefactorActivity({ api }) {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api().get("/api/v1/benefactor/activity?limit=50")
      .then((r) => setEvents(r.data.events || []))
      .catch((e) => setError(e.response?.data?.detail || "Failed to load activity"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const formatTime = (ts) => {
    if (!ts) return "";
    try { const d = new Date(ts); return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`; }
    catch { return ts; }
  };

  if (loading) return <div className="bp-state">Loading...</div>;

  return (
    <div>
      {error && <div className="bp-error">{error} <button onClick={() => setError("")}>Dismiss</button></div>}
      {events.length === 0 && (
        <div className="bp-empty">
          <div className="bp-empty-icon">📋</div>
          <h3>No pickup activity yet</h3>
          <p>Once your vehicles are scanned at school, pickup events will appear here.</p>
        </div>
      )}
      {events.length > 0 && (
        <>
          <div className="bp-section-header">
            <span>Recent pickup activity</span>
            <button className="bp-btn bp-btn-ghost bp-btn-sm" onClick={load}>Refresh</button>
          </div>
          <div className="bp-activity-list">
            {events.map((ev) => (
              <div key={ev.id} className="bp-activity-row">
                <div className="bp-activity-icon"><IconCar /></div>
                <div className="bp-activity-info">
                  <div className="bp-activity-main">
                    <span className="bp-activity-vehicle">{ev.vehicle_desc}</span>
                    {ev.plate_number && <span className="bp-plate-badge">{ev.plate_number}</span>}
                  </div>
                  {ev.students.length > 0 && (<span className="bp-activity-students">{ev.students.join(", ")}</span>)}
                  <span className="bp-activity-meta">
                    {formatTime(ev.timestamp)}
                    {ev.location && <> &middot; {ev.location}</>}
                    {ev.picked_up_at && <> &middot; Picked up</>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
