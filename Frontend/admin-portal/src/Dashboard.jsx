import React, { useState, useMemo, useEffect } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import PickupCard from "./PickupCard";
import ConfirmDialog from "./ConfirmDialog";
import "./Dashboard.css";

/* ── Dashboard — Pickup Queue ───────────────────────────
   Refresh pattern: dark canvas with subtle radial-gradient
   atmosphere, eyebrow + display headline, contextual chip row, view
   toggle / filter / bulk action.  Stat strip below shows queue-
   derived metrics, then the photo-led PickupCard grid.

   The arrival-alert toggle previously lived on this page; it moved
   to the topbar so the dashboard header can focus on queue context.
   The "Recognition · live/offline" pill polls /api/v1/scanner/status
   so it reflects actual scanner heartbeat — not the listener state
   of the current tab.
   ────────────────────────────────────────────────────── */

// Map the existing authorization_status enum to the four visual
// states the new PickupCard understands.
function stateOf(authStatus) {
  if (authStatus === "unauthorized")  return "unauth";
  if (authStatus === "unregistered")  return "unreg";
  if (authStatus === "unrecognized")  return "unrec";
  return "auth"; // "authorized" + "authorized_guardian" both land here
}

// Person-row "role" copy — keeps the existing semantic distinctions
// (primary guardian, blocked reason, OCR fallback) so AT users and
// sighted users get the same context the v1 banner provided.
function roleCopy(entry, st) {
  if (st === "auth") {
    if (entry.authorization_status === "authorized_guardian") {
      return entry.primary_guardian
        ? `Authorized · primary guardian`
        : `Authorized guardian`;
    }
    return "Authorized";
  }
  if (st === "unauth") {
    return entry.blocked_reason
      ? `Blocked · ${entry.blocked_reason}`
      : "Blocked · custody flag";
  }
  if (st === "unreg") {
    return "Plate not in registry";
  }
  // unrec
  return entry.ocr_guess
    ? `OCR guess: ${entry.ocr_guess} · review`
    : "Manual review needed";
}

function vehicleLabelOf(entry) {
  return [entry.vehicle_color, entry.vehicle_make, entry.vehicle_model]
    .filter(Boolean)
    .join(" ") || null;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Stat strip.  Numbers are derived from the current queue snapshot
// (no new API calls).  Avg pickup is intentionally a placeholder
// until the analytics endpoint exists.
function StatStrip({ queue }) {
  const total = queue.length;
  const authCount = queue.filter(
    (e) => e.authorization_status === "authorized" ||
           e.authorization_status === "authorized_guardian",
  ).length;
  const flags = queue.filter(
    (e) => ["unauthorized", "unregistered", "unrecognized"]
            .includes(e.authorization_status),
  ).length;
  const authPct = total > 0 ? Math.round((authCount / total) * 100) : 0;

  return (
    <div className="dash-stats">
      <div className="dash-stat" data-accent="brand">
        <span className="dash-stat-label t-eyebrow">In queue</span>
        <span className="dash-stat-value t-num">{total}</span>
        <span className="dash-stat-delta">
          {total === 0 ? "queue empty" : `${total} waiting`}
        </span>
      </div>
      <div className="dash-stat">
        <span className="dash-stat-label t-eyebrow">Avg pickup</span>
        <span className="dash-stat-value t-num">—</span>
        <span className="dash-stat-delta">analytics coming soon</span>
      </div>
      <div className="dash-stat">
        <span className="dash-stat-label t-eyebrow">Authorized</span>
        <span className="dash-stat-value t-num">{authPct}%</span>
        <span className="dash-stat-delta">
          {total > 0 ? `${authCount} of ${total} on file` : "—"}
        </span>
      </div>
      <div
        className={`dash-stat${flags > 0 ? " dash-stat-warn" : ""}`}
        data-accent={flags > 0 ? "amber" : ""}
      >
        <span className="dash-stat-label t-eyebrow">Flags now</span>
        <span className="dash-stat-value t-num">{flags}</span>
        <span className="dash-stat-delta">
          {flags === 0 ? "all clear" : "review and override"}
        </span>
      </div>
    </div>
  );
}

// View toggle (grid / list).  List mode is wired but visually
// renders the same grid for now — the design's list view will land
// when there's a use case beyond grid.
function ViewToggle({ value, onChange }) {
  return (
    <div className="dash-view-toggle" role="radiogroup" aria-label="View mode">
      <button
        type="button"
        className={value === "grid" ? "active" : ""}
        onClick={() => onChange("grid")}
        role="radio"
        aria-checked={value === "grid"}
        aria-label="Grid view"
      >
        <I.squares size={13} />
      </button>
      <button
        type="button"
        className={value === "list" ? "active" : ""}
        onClick={() => onChange("list")}
        role="radio"
        aria-checked={value === "list"}
        aria-label="List view"
      >
        <I.list size={13} />
      </button>
    </div>
  );
}

export default function Dashboard({
  queue,
  onClearQueue,
  onDismiss,
  token,
  schoolId = null,
}) {
  const [dismissing, setDismissing] = useState(new Set());
  const [sortOrder,  setSortOrder]  = useState("asc");
  const [locFilter,  setLocFilter]  = useState("");
  const [viewMode,   setViewMode]   = useState("grid");
  const [bulkPicking, setBulkPicking] = useState(false);

  // ── unique locations for filter ─────────────────────
  const locations = useMemo(() => {
    const s = new Set(queue.map((e) => e.location).filter(Boolean));
    return [...s].sort();
  }, [queue]);

  // ── sorted + filtered queue ─────────────────────────
  const displayQueue = useMemo(() => {
    let q = locFilter ? queue.filter((e) => e.location === locFilter) : [...queue];
    q.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return sortOrder === "asc" ? ta - tb : tb - ta;
    });
    return q;
  }, [queue, sortOrder, locFilter]);

  // ── per-card pickup ─────────────────────────────────
  const handleDismiss = async (plateToken) => {
    setDismissing((prev) => new Set([...prev, plateToken]));
    try {
      await createApiClient(token, schoolId)
        .delete(`/api/v1/queue/${encodeURIComponent(plateToken)}?pickup_method=manual`);
      onDismiss(plateToken);
    } catch (err) {
      console.error("Dismiss failed:", err);
    } finally {
      setDismissing((prev) => {
        const n = new Set(prev);
        n.delete(plateToken);
        return n;
      });
    }
  };

  // ── bulk pickup ─────────────────────────────────────
  // Two-step: opening the confirm dialog (setBulkConfirmOpen) is
  // detached from running the API call (confirmBulkPickup) so the
  // user gets the shared <ConfirmDialog> a11y treatment instead of
  // a window.confirm prompt.  Errors surface inside the dialog so
  // the user can retry without losing place.
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkError, setBulkError] = useState("");

  const confirmBulkPickup = async () => {
    setBulkPicking(true);
    setBulkError("");
    try {
      await createApiClient(token, schoolId).post("/api/v1/queue/bulk-pickup");
      onClearQueue();
      setBulkConfirmOpen(false);
    } catch (err) {
      console.error("Bulk pickup failed:", err);
      setBulkError(err?.response?.data?.detail || "Failed to complete bulk pickup.");
    } finally {
      setBulkPicking(false);
    }
  };

  const handleBulkPickup = () => {
    setBulkError("");
    setBulkConfirmOpen(true);
  };

  const total       = queue.length;
  const flagCount   = queue.filter(
    (e) => ["unauthorized", "unregistered", "unrecognized"]
            .includes(e.authorization_status),
  ).length;

  // Recognition pill reflects whether the campus's scanner(s) are reachable
  // — i.e. at least one device for this school has heartbeat-ed inside the
  // backend's ONLINE_WINDOW.  This is independent of wsStatus, which only
  // tells us whether *this* tab's Firestore listener has fired.
  const [recognitionOnline, setRecognitionOnline] = useState(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await createApiClient(token, schoolId).get("/api/v1/scanner/status");
        if (!cancelled) setRecognitionOnline(Boolean(res.data?.online));
      } catch {
        if (!cancelled) setRecognitionOnline(false);
      }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token, schoolId]);

  const liveOn = recognitionOnline === true;

  // The queue most-recently-added vehicle; used to power the
  // "last update Ns ago" hint.  Kept as a static "just now" string
  // when the queue is non-empty — a real ticking timer would belong
  // in a child component to avoid re-rendering the whole list.
  const lastUpdateLabel = total > 0 ? "live · streaming" : "idle · waiting for arrivals";

  // Current dismissal "now" — for the eyebrow context line.
  // Snapshot once when the component mounts; fresh enough for the
  // header context.  A ticking timer here would force the whole
  // dashboard to re-render every minute.
  const nowLabel = useMemo(
    () => `Dismissal · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    [],
  );

  return (
    <div className="dash-shell">
      <div className="dash-inner">

        {/* ── Header: eyebrow + display headline + chip row + actions ── */}
        <div className="dash-head">
          <div className="dash-head-left">
            <span className="t-eyebrow dash-eyebrow">{nowLabel}</span>
            <h1 className="t-display dash-title">Pickup queue</h1>
            <div className="dash-chips">
              {locations.length > 0 && (
                <select
                  className="dash-chip dash-chip-select"
                  value={locFilter}
                  onChange={(e) => setLocFilter(e.target.value)}
                  aria-label="Filter by location"
                >
                  <option value="">
                    {locations.length === 1 ? locations[0] : "All locations"}
                  </option>
                  {locations.map((loc) => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                </select>
              )}
              <span className={`dash-chip${liveOn ? " dash-chip-live" : ""}`}>
                <span className="dash-chip-dot" aria-hidden="true" />
                {liveOn ? "Recognition · live" : "Recognition · offline"}
              </span>
              <span className="dash-chip">
                <span className="t-num">{String(total).padStart(2, "0")}</span>&nbsp;vehicles in queue
              </span>
              {flagCount > 0 && (
                <span className="dash-chip dash-chip-warn">
                  <I.alert size={11} stroke={2.2} aria-hidden="true" />
                  <span className="t-num">{String(flagCount).padStart(2, "0")}</span>&nbsp;awaiting review
                </span>
              )}
            </div>
          </div>

          <div className="dash-head-actions">
            <ViewToggle value={viewMode} onChange={setViewMode} />
            <select
              className="dash-btn dash-btn-secondary"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              aria-label="Sort order"
            >
              <option value="asc">Oldest first</option>
              <option value="desc">Newest first</option>
            </select>
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              onClick={handleBulkPickup}
              disabled={displayQueue.length === 0 || bulkPicking}
              title="Mark all visible vehicles as picked up"
            >
              <I.checkCircle size={13} stroke={2.2} aria-hidden="true" />
              {bulkPicking ? "Marking…" : "Mark all picked up"}
            </button>
          </div>
        </div>

        {/* ── Stat strip ── */}
        <StatStrip queue={queue} />

        {/* ── Section header ── */}
        <div className="dash-section">
          <div className="dash-section-left">
            <span className="t-section">Live queue</span>
            <span className="dash-section-rule" aria-hidden="true" />
            <span className="dash-section-meta t-num">{lastUpdateLabel}</span>
          </div>
          <span className="dash-section-meta dash-section-meta-right t-num">
            sorted by {sortOrder === "asc" ? "arrival" : "newest first"}
          </span>
        </div>

        {/* ── Card grid / empty states ── */}
        {queue.length === 0 ? (
          <div className="dash-empty">
            <div className="dash-empty-icon" aria-hidden="true">
              <I.car size={32} stroke={1.6} />
            </div>
            <h2 className="dash-empty-title t-h2">Queue is empty</h2>
            <div className="dash-empty-sub t-body">
              Vehicles will appear here as they're scanned at the entrance.
            </div>
          </div>
        ) : displayQueue.length === 0 ? (
          <div className="dash-empty">
            <h2 className="dash-empty-title t-h2">No vehicles match this filter</h2>
            <div className="dash-empty-sub">
              <button
                type="button"
                className="dash-btn dash-btn-secondary"
                onClick={() => setLocFilter("")}
              >
                Clear filter
              </button>
            </div>
          </div>
        ) : (
          <div
            className={`dash-grid dash-grid-${viewMode}`}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Pickup queue — arrivals announced as they're scanned"
          >
            {displayQueue.map((entry, index) => {
              const st       = stateOf(entry.authorization_status);
              const time     = fmtTime(entry.timestamp);
              const vehicle  = vehicleLabelOf(entry);
              const role     = roleCopy(entry, st);
              const cardKey  = entry.firestore_id || entry.hash || entry.plate_token;
              const photo    = entry.thumbnail_b64
                ? `data:image/${entry.thumbnail_b64.startsWith("UklGR") ? "webp" : "jpeg"};base64,${entry.thumbnail_b64}`
                : null;
              const camera   = entry.location ? `${entry.location} · LPR` : "LPR";
              const plate    = entry.plate_display || (st === "unrec" ? "??????" : "");
              const driver   = entry.parent
                || (st === "unreg" ? "Unknown driver" : st === "unrec" ? "Plate not detected" : "Unknown driver");

              const summary =
                `Position ${index + 1}. ${role}. ${driver}. ${vehicle || "Unknown vehicle"} at ${time}.`;

              return (
                <PickupCard
                  key={cardKey}
                  pos={index + 1}
                  vehicle={vehicle}
                  plate={plate}
                  time={time}
                  name={driver}
                  role={role}
                  state={st}
                  photo={photo}
                  cameraLabel={camera}
                  guardianPhotoUrl={entry.guardian_photo_url || null}
                  students={entry.student}
                  onPickup={() => handleDismiss(entry.plate_token)}
                  pending={dismissing.has(entry.plate_token)}
                  ariaLabel={summary}
                />
              );
            })}
          </div>
        )}

      </div>

      <ConfirmDialog
        open={bulkConfirmOpen}
        title="Mark all picked up"
        prompt={`Mark all ${displayQueue.length} vehicle${displayQueue.length !== 1 ? "s" : ""} in the queue as picked up?`}
        warning="This action cannot be undone — every car currently waiting in the queue will be cleared."
        destructive
        confirmLabel="Mark all picked up"
        busyLabel="Marking…"
        busy={bulkPicking}
        error={bulkError}
        onConfirm={confirmBulkPickup}
        onCancel={() => setBulkConfirmOpen(false)}
        confirmIcon={<I.checkCircle size={12} aria-hidden="true" />}
      />
    </div>
  );
}
