import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import { formatApiError } from "./utils";
import "./Scheduler.css";

/* ── Scheduler — per-school dismissal windows + exceptions ─────────────
   Three stacked cards:
     1. Weekly grid — one row per ISO weekday (Mon=1..Sun=7) with an
        enable toggle, start, end, and a duration chip.  "Apply Mon to
        weekdays" copies row 1 across rows 2-5 (the canonical
        low-clicks setup).
     2. Holiday seeds — only renders until applied; one-click bulk
        installs federal + common school-break holidays for the current
        school year, with a checkbox per date.
     3. Exceptions — every date-level override, grouped by month.
        Inline add form, edit, delete.

   Schedule is read once on mount via GET /api/v1/scheduler.  Saves go
   through PUT/POST/DELETE on the same family of endpoints; the page
   re-fetches on success so derived state (today's resolved window,
   already_set flags on seeds) stays consistent.
   ────────────────────────────────────────────────────────────────────── */

const WEEKDAY_LABELS = {
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
  "7": "Sunday",
};
const WEEKDAY_ORDER = ["1", "2", "3", "4", "5", "6", "7"];

function durationLabel(start, end) {
  if (!start || !end) return "—";
  const [sh, sm] = start.split(":").map((x) => parseInt(x, 10));
  const [eh, em] = end.split(":").map((x) => parseInt(x, 10));
  const mins = (eh - sh) * 60 + (em - sm);
  if (!Number.isFinite(mins) || mins <= 0) return "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

function formatTimeForDisplay(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const dt = new Date();
  dt.setHours(h, m, 0, 0);
  return dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateLong(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function monthKey(iso) {
  const [y, m] = iso.split("-");
  return `${y}-${m}`;
}

function monthLabel(iso) {
  const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long", year: "numeric",
  });
}


// ============================================================================
// Top-level page
// ============================================================================

export default function Scheduler({ token, schoolId, currentUser }) {
  const [data, setData]       = useState(null);  // { schedule, today, timezone }
  const [seeds, setSeeds]     = useState(null);  // { school_year, candidates: [...] }
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState("");

  const isAdmin = currentUser?.role === "school_admin"
    || currentUser?.role === "district_admin"
    || currentUser?.role === "super_admin";

  const fetchAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setErr("");
    try {
      const api = createApiClient(token, schoolId);
      const [scheduleRes, seedsRes] = await Promise.all([
        api.get("/api/v1/scheduler"),
        api.get("/api/v1/scheduler/seed-candidates"),
      ]);
      setData(scheduleRes.data);
      setSeeds(seedsRes.data);
    } catch (ex) {
      setErr(formatApiError(ex, "Couldn't load the schedule."));
    } finally {
      setLoading(false);
    }
  }, [token, schoolId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (!isAdmin) {
    return (
      <div className="sched-shell">
        <div className="sched-inner">
          <div className="sched-card">
            <div className="sched-empty">
              <div className="sched-empty-eyebrow">Schedule</div>
              <p className="sched-empty-msg">You don't have permission to manage the dismissal schedule. Ask your school admin.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sched-shell">
      <div className="sched-inner">

        {/* Header */}
        <div className="sched-head">
          <span className="t-eyebrow sched-eyebrow">Schedule · {data?.timezone || "—"}</span>
          <h1 className="t-display sched-title">Dismissal schedule</h1>
          <p className="sched-subtitle">
            Set the daily dismissal window staff will pace against, and
            mark holidays or early-release dates so the Dashboard countdown
            shows the right thing on the right day.
          </p>
          {data?.today && (
            <div className="sched-chips">
              {data.today.is_open ? (
                <span className="sched-chip sched-chip-open">
                  <span className="sched-chip-dot" aria-hidden="true" />
                  Today: {formatTimeForDisplay(data.today.window_start.slice(11, 16))}
                  &nbsp;→&nbsp;
                  {formatTimeForDisplay(data.today.window_end.slice(11, 16))}
                  {data.today.label && <>&nbsp;· {data.today.label}</>}
                </span>
              ) : (
                <span className="sched-chip sched-chip-closed">
                  <span className="sched-chip-dot" aria-hidden="true" />
                  Today: closed{data.today.label ? ` · ${data.today.label}` : ""}
                </span>
              )}
            </div>
          )}
        </div>

        {err && <div className="sched-error" role="alert">{err}</div>}
        {loading && !data && (
          <div className="sched-card sched-card-loading"><span>Loading schedule…</span></div>
        )}

        {data && (
          <>
            <WeeklyGridSection
              token={token}
              schoolId={schoolId}
              weekly={data.schedule.weekly}
              onSaved={fetchAll}
            />
            {seeds && (
              <HolidaySeedSection
                token={token}
                schoolId={schoolId}
                seeds={seeds}
                onApplied={fetchAll}
              />
            )}
            <ExceptionsSection
              token={token}
              schoolId={schoolId}
              exceptions={data.schedule.exceptions || {}}
              onSaved={fetchAll}
            />
          </>
        )}

      </div>
    </div>
  );
}


// ============================================================================
// Weekly grid section
// ============================================================================

function WeeklyGridSection({ token, schoolId, weekly, onSaved }) {
  // Local edit buffer — initialised from props, copied over on prop changes
  // (i.e. after a successful save the parent refetches, and we re-seed).
  const [draft, setDraft] = useState(weekly);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");
  const lastWeeklyRef = useRef(weekly);
  useEffect(() => {
    if (lastWeeklyRef.current !== weekly) {
      setDraft(weekly);
      lastWeeklyRef.current = weekly;
    }
  }, [weekly]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(weekly), [draft, weekly]);

  const setField = (day, field, value) => {
    setDraft((d) => ({ ...d, [day]: { ...d[day], [field]: value } }));
  };

  const toggleEnabled = (day) => {
    setDraft((d) => {
      const cur = d[day] || {};
      const next = !cur.enabled;
      // When enabling a day that has no times yet, copy from Monday if it's
      // configured — saves 4 clicks for the typical M–F pattern.
      const fromMon = d["1"] || {};
      const start = cur.start || (next && fromMon.start) || "14:30";
      const end   = cur.end   || (next && fromMon.end)   || "15:15";
      return {
        ...d,
        [day]: {
          enabled: next,
          start:   next ? start : null,
          end:     next ? end   : null,
        },
      };
    });
  };

  const applyMonToWeekdays = () => {
    setDraft((d) => {
      const mon = d["1"] || {};
      if (!mon.enabled) return d;
      const out = { ...d };
      for (const k of ["2", "3", "4", "5"]) {
        out[k] = { enabled: true, start: mon.start, end: mon.end };
      }
      return out;
    });
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const api = createApiClient(token, schoolId);
      // Backend requires every enabled day to carry both times — local
      // toggleEnabled keeps that invariant, but be defensive on save.
      const sanitized = {};
      for (const k of WEEKDAY_ORDER) {
        const e = draft[k] || {};
        if (e.enabled && e.start && e.end) {
          sanitized[k] = { enabled: true, start: e.start, end: e.end };
        } else {
          sanitized[k] = { enabled: false, start: null, end: null };
        }
      }
      await api.put("/api/v1/scheduler/weekly", { weekly: sanitized });
      onSaved && onSaved();
    } catch (ex) {
      setErr(formatApiError(ex, "Couldn't save the weekly schedule."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sched-card sched-card-weekly" aria-label="Weekly dismissal window">
      <header className="sched-card-head">
        <div className="sched-card-titles">
          <span className="sched-eyebrow">Weekly window</span>
          <h2 className="sched-card-title">Daily dismissal times</h2>
        </div>
        <button
          type="button"
          className="sched-btn-ghost"
          onClick={applyMonToWeekdays}
          disabled={!draft["1"]?.enabled}
          title="Copy Monday's start/end to Tue–Fri"
        >
          <I.copy size={13} stroke={2.0} />
          <span>Copy Mon → weekdays</span>
        </button>
      </header>

      <div className="sched-weekly-grid">
        {WEEKDAY_ORDER.map((k) => {
          const e = draft[k] || { enabled: false };
          return (
            <div key={k} className={`sched-day-row${e.enabled ? "" : " sched-day-row-off"}`}>
              <button
                type="button"
                className={`sched-day-toggle${e.enabled ? " sched-day-toggle-on" : ""}`}
                onClick={() => toggleEnabled(k)}
                aria-pressed={e.enabled}
                aria-label={`${WEEKDAY_LABELS[k]}: ${e.enabled ? "enabled" : "closed"}`}
                title={e.enabled ? "Disable this day" : "Enable this day"}
              >
                <span className="sched-day-toggle-knob" aria-hidden="true" />
              </button>
              <span className="sched-day-name">{WEEKDAY_LABELS[k]}</span>
              {e.enabled ? (
                <>
                  <input
                    type="time"
                    className="sched-time-input"
                    value={e.start || ""}
                    onChange={(ev) => setField(k, "start", ev.target.value)}
                    aria-label={`${WEEKDAY_LABELS[k]} dismissal start`}
                  />
                  <span className="sched-arrow" aria-hidden="true">→</span>
                  <input
                    type="time"
                    className="sched-time-input"
                    value={e.end || ""}
                    onChange={(ev) => setField(k, "end", ev.target.value)}
                    aria-label={`${WEEKDAY_LABELS[k]} dismissal end`}
                  />
                  <span className="sched-duration-chip t-num">
                    {durationLabel(e.start, e.end)}
                  </span>
                </>
              ) : (
                <span className="sched-day-closed">Closed</span>
              )}
            </div>
          );
        })}
      </div>

      <footer className="sched-card-foot">
        {err && <span className="sched-card-err" role="alert">{err}</span>}
        <button
          type="button"
          className="sched-btn-primary"
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : dirty ? "Save weekly schedule" : "Saved"}
        </button>
      </footer>
    </section>
  );
}


// ============================================================================
// Holiday seed section — collapses to summary once any holidays are set
// ============================================================================

function HolidaySeedSection({ token, schoolId, seeds, onApplied }) {
  // Pre-tick everything that isn't already on the calendar.  Manual edits
  // (already_set && manual) are shown but unticked because applying would
  // overwrite their label/source.
  const initialPicks = useMemo(() => {
    const set = new Set();
    for (const c of seeds.candidates || []) {
      if (!c.already_set) set.add(c.date);
    }
    return set;
  }, [seeds]);

  const [picks, setPicks] = useState(initialPicks);
  const [collapsed, setCollapsed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { setPicks(new Set(initialPicks)); }, [initialPicks]);

  const total = seeds.candidates.length;
  const alreadyApplied = seeds.candidates.filter((c) => c.already_set).length;
  const allAlreadyApplied = total > 0 && alreadyApplied === total;

  // Auto-collapse when nothing remains to suggest.
  useEffect(() => {
    if (allAlreadyApplied) setCollapsed(true);
  }, [allAlreadyApplied]);

  const togglePick = (iso) => {
    setPicks((s) => {
      const next = new Set(s);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const apply = async () => {
    if (picks.size === 0) return;
    setApplying(true);
    setErr("");
    try {
      const dates = [...picks].map((iso) => {
        const c = seeds.candidates.find((x) => x.date === iso);
        return { date: iso, label: c?.label || "" };
      });
      const api = createApiClient(token, schoolId);
      await api.post("/api/v1/scheduler/seed-holidays", { dates });
      onApplied && onApplied();
    } catch (ex) {
      setErr(formatApiError(ex, "Couldn't apply holidays."));
    } finally {
      setApplying(false);
    }
  };

  if (collapsed) {
    return (
      <section className="sched-card sched-card-seed sched-card-seed-collapsed">
        <header className="sched-card-head">
          <div className="sched-card-titles">
            <span className="sched-eyebrow">Pre-seeded holidays</span>
            <h2 className="sched-card-title">
              <I.checkCircle size={16} stroke={2.0} aria-hidden="true" />
              &nbsp;{alreadyApplied} of {total} applied for {seeds.school_year.start.slice(0, 4)}–{seeds.school_year.end.slice(2, 4)} school year
            </h2>
          </div>
          <button
            type="button"
            className="sched-btn-ghost"
            onClick={() => setCollapsed(false)}
          >
            Manage
          </button>
        </header>
      </section>
    );
  }

  return (
    <section className="sched-card sched-card-seed" aria-label="Pre-seeded holidays">
      <header className="sched-card-head">
        <div className="sched-card-titles">
          <span className="sched-eyebrow">Pre-seeded holidays</span>
          <h2 className="sched-card-title">
            For the {seeds.school_year.start.slice(0, 4)}–{seeds.school_year.end.slice(2, 4)} school year
          </h2>
        </div>
        <span className="sched-pill t-num">
          {picks.size} selected
        </span>
      </header>

      <p className="sched-card-blurb">
        One-click apply federal holidays + typical school breaks. Each one
        marks that date as closed on the dismissal calendar. Manual edits
        you've made are preserved.
      </p>

      <ul className="sched-seed-list">
        {seeds.candidates.map((c) => {
          const checked = picks.has(c.date);
          const locked = c.already_set && c.manual; // don't trample manual edits
          return (
            <li key={c.date} className={`sched-seed-row${c.already_set ? " sched-seed-row-set" : ""}`}>
              <label className={`sched-checkbox${locked ? " sched-checkbox-locked" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={() => togglePick(c.date)}
                />
                <span className="sched-checkbox-box" aria-hidden="true">
                  {checked && <I.check size={11} stroke={3} />}
                </span>
                <span className="sched-seed-date">{formatDateLong(c.date)}</span>
                <span className="sched-seed-label">{c.label}</span>
                {c.already_set && (
                  <span className="sched-seed-applied t-eyebrow">
                    {locked ? "Manual entry" : "Already applied"}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      <footer className="sched-card-foot">
        {err && <span className="sched-card-err" role="alert">{err}</span>}
        <button
          type="button"
          className="sched-btn-ghost"
          onClick={() => setCollapsed(true)}
          disabled={applying}
        >
          {alreadyApplied > 0 ? "Done" : "Skip, add my own"}
        </button>
        <button
          type="button"
          className="sched-btn-primary"
          onClick={apply}
          disabled={applying || picks.size === 0}
        >
          {applying ? "Applying…" : `Apply ${picks.size} ${picks.size === 1 ? "holiday" : "holidays"}`}
        </button>
      </footer>
    </section>
  );
}


// ============================================================================
// Exceptions section — list grouped by month, inline add/edit
// ============================================================================

function ExceptionsSection({ token, schoolId, exceptions, onSaved }) {
  // Group by YYYY-MM, sorted ascending so upcoming dates come first.
  const groups = useMemo(() => {
    const out = new Map();
    for (const [iso, ex] of Object.entries(exceptions)) {
      const k = monthKey(iso);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ date: iso, ...ex });
    }
    for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [exceptions]);

  const [adding, setAdding] = useState(false);
  const [editingDate, setEditingDate] = useState(null);

  return (
    <section className="sched-card sched-card-exceptions" aria-label="Date exceptions">
      <header className="sched-card-head">
        <div className="sched-card-titles">
          <span className="sched-eyebrow">Exceptions</span>
          <h2 className="sched-card-title">Closures &amp; modified hours</h2>
        </div>
        {!adding && (
          <button
            type="button"
            className="sched-btn-primary"
            onClick={() => { setAdding(true); setEditingDate(null); }}
          >
            <I.plus size={13} stroke={2.4} />
            <span>Add exception</span>
          </button>
        )}
      </header>

      {adding && (
        <ExceptionEditor
          token={token}
          schoolId={schoolId}
          mode="add"
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); onSaved && onSaved(); }}
        />
      )}

      {groups.length === 0 && !adding && (
        <p className="sched-empty-msg sched-exceptions-empty">
          No exceptions yet. Add one for early-release days, parent-teacher
          conferences, or one-off closures that aren't part of the federal
          holiday list.
        </p>
      )}

      {groups.map(([key, rows]) => (
        <div key={key} className="sched-month">
          <h3 className="sched-month-label t-section">{monthLabel(`${key}-01`)}</h3>
          <ul className="sched-exception-list">
            {rows.map((row) => (
              <ExceptionRow
                key={row.date}
                row={row}
                isEditing={editingDate === row.date}
                token={token}
                schoolId={schoolId}
                onEdit={() => setEditingDate(row.date)}
                onCloseEdit={() => setEditingDate(null)}
                onSaved={() => { setEditingDate(null); onSaved && onSaved(); }}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ExceptionRow({ row, isEditing, token, schoolId, onEdit, onCloseEdit, onSaved }) {
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState("");

  const remove = async () => {
    setDeleting(true);
    setErr("");
    try {
      const api = createApiClient(token, schoolId);
      await api.delete(`/api/v1/scheduler/exceptions/${encodeURIComponent(row.date)}`);
      onSaved && onSaved();
    } catch (ex) {
      setErr(formatApiError(ex, "Couldn't remove this exception."));
      setDeleting(false);
    }
  };

  if (isEditing) {
    return (
      <li className="sched-exception-row sched-exception-row-editing">
        <ExceptionEditor
          token={token}
          schoolId={schoolId}
          mode="edit"
          initial={row}
          onClose={onCloseEdit}
          onSaved={onSaved}
        />
      </li>
    );
  }

  return (
    <li className="sched-exception-row">
      <span className="sched-exception-date t-num">{formatDateLong(row.date)}</span>
      <span className="sched-exception-label">
        {row.label || (row.closed ? "Closed" : "Modified hours")}
      </span>
      <span className={`sched-exception-status${row.closed ? " sched-exception-status-closed" : " sched-exception-status-modified"}`}>
        {row.closed
          ? "Closed"
          : `${formatTimeForDisplay(row.start)} → ${formatTimeForDisplay(row.end)}`}
      </span>
      <span className={`sched-exception-source t-eyebrow source-${(row.source || "manual").replace(/_/g, "-")}`}>
        {row.source === "seed_us_federal" ? "Federal"
          : row.source === "seed_common_school" ? "Common"
          : "Manual"}
      </span>
      <button
        type="button"
        className="sched-icon-btn"
        onClick={onEdit}
        aria-label="Edit exception"
        title="Edit"
      >
        <I.edit size={13} />
      </button>
      <button
        type="button"
        className="sched-icon-btn sched-icon-btn-danger"
        onClick={remove}
        disabled={deleting}
        aria-label="Remove exception"
        title="Remove"
      >
        <I.trash size={13} />
      </button>
      {err && <span className="sched-exception-err" role="alert">{err}</span>}
    </li>
  );
}

function ExceptionEditor({ token, schoolId, mode, initial = null, onClose, onSaved }) {
  const [date, setDate] = useState(initial?.date || "");
  const [closed, setClosed] = useState(initial ? !!initial.closed : true);
  const [start, setStart] = useState(initial?.start || "");
  const [end, setEnd]     = useState(initial?.end || "");
  const [label, setLabel] = useState(initial?.label || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const dateInputRef = useRef(null);

  // Focus the first empty input on mount — date in add mode, label in edit.
  useEffect(() => {
    if (mode === "add" && dateInputRef.current) dateInputRef.current.focus();
  }, [mode]);

  // Esc closes the editor for add mode (edit mode rows have their own
  // dismiss treatment via the cancel button only — Esc on a focused
  // time-input shouldn't blow away unsaved changes by accident).
  useEffect(() => {
    if (mode !== "add") return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  const save = async (e) => {
    e?.preventDefault();
    if (!date) {
      setErr("Pick a date for this exception.");
      return;
    }
    if (!closed) {
      if (!start || !end) {
        setErr("Modified-hours exceptions need both a start and end time.");
        return;
      }
      if (start >= end) {
        setErr("End time must be after start time.");
        return;
      }
    }
    setSaving(true);
    setErr("");
    try {
      const api = createApiClient(token, schoolId);
      await api.put(
        `/api/v1/scheduler/exceptions/${encodeURIComponent(date)}`,
        {
          closed,
          start: closed ? null : start,
          end:   closed ? null : end,
          label: label.trim() || null,
        },
      );
      onSaved && onSaved();
    } catch (ex) {
      setErr(formatApiError(ex, "Couldn't save this exception."));
      setSaving(false);
    }
  };

  return (
    <form className="sched-exception-editor" onSubmit={save}>
      <div className="sched-exception-editor-row">
        <label className="sched-field">
          <span className="sched-field-label t-eyebrow">Date</span>
          <input
            ref={dateInputRef}
            type="date"
            className="sched-time-input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={mode === "edit"}
            required
          />
        </label>
        <fieldset className="sched-radio-group">
          <legend className="sched-field-label t-eyebrow">Type</legend>
          <label className={`sched-radio${closed ? " sched-radio-on" : ""}`}>
            <input
              type="radio"
              name="exc-type"
              checked={closed}
              onChange={() => setClosed(true)}
            />
            <span>Closed (no dismissal)</span>
          </label>
          <label className={`sched-radio${!closed ? " sched-radio-on" : ""}`}>
            <input
              type="radio"
              name="exc-type"
              checked={!closed}
              onChange={() => setClosed(false)}
            />
            <span>Modified hours</span>
          </label>
        </fieldset>
      </div>

      {!closed && (
        <div className="sched-exception-editor-row">
          <label className="sched-field">
            <span className="sched-field-label t-eyebrow">Start</span>
            <input
              type="time"
              className="sched-time-input"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>
          <label className="sched-field">
            <span className="sched-field-label t-eyebrow">End</span>
            <input
              type="time"
              className="sched-time-input"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>
          <span className="sched-duration-chip t-num">
            {durationLabel(start, end)}
          </span>
        </div>
      )}

      <label className="sched-field">
        <span className="sched-field-label t-eyebrow">Label (optional)</span>
        <input
          type="text"
          className="sched-text-input"
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={closed ? "e.g. Snow day, Parent–teacher conferences" : "e.g. Early release"}
        />
      </label>

      {err && <p className="sched-card-err" role="alert">{err}</p>}

      <div className="sched-exception-editor-actions">
        <button type="button" className="sched-btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="sched-btn-primary" disabled={saving}>
          {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Add exception"}
        </button>
      </div>
    </form>
  );
}
