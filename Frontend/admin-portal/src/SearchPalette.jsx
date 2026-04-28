import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./SearchPalette.css";

/* ── SearchPalette ─────────────────────────────────────
   Global ⌘K palette wired to TopBar.  Fan-out fetches the three
   admin lists the user is most likely to be hunting through
   (students, guardians, plates) and filters them client-side;
   responses are cached for 60 s per (token, schoolId) so quick
   re-opens don't re-fetch.

   Selecting a result navigates to that entity's page and seeds
   the page's local search box (the existing list pages each have
   one) — that scopes the page to the picked row in a single
   click, without forcing each page to know about a "preselected
   id" prop.

   The decision to fan-out client-side rather than add a unified
   /search endpoint is deliberate: the existing endpoints already
   decrypt names server-side and lists are school-scoped (small),
   so a one-shot fetch + cache + filter is fast enough and ships
   without backend changes. ────────────────────────────────── */

const CACHE_TTL_MS = 60_000;
const RESULTS_PER_GROUP = 5;

// Per-mount cache so re-opens within a minute don't refetch.
// Keyed by `${token}::${schoolId ?? ""}` — a school switch
// invalidates by mismatching the key.
const _cache = new Map();

function _readCache(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return hit.data;
}

function _writeCache(key, data) {
  _cache.set(key, { at: Date.now(), data });
}

function normalize(s) {
  return (s ?? "").toString().toLowerCase();
}

function studentLabel(s) {
  return [s.first_name, s.last_name].filter(Boolean).join(" ") || "(unnamed)";
}

function studentMatches(s, q) {
  const name = `${s.first_name ?? ""} ${s.last_name ?? ""}`;
  return (
    normalize(name).includes(q) ||
    normalize(s.grade).includes(q) ||
    normalize(s.guardian?.display_name).includes(q) ||
    normalize(s.guardian?.email).includes(q)
  );
}

function guardianMatches(g, q) {
  return (
    normalize(g.display_name).includes(q) ||
    normalize(g.email).includes(q) ||
    normalize(g.phone).includes(q)
  );
}

function plateMatches(p, q) {
  const vehicles = (p.vehicles || [])
    .map((v) => [v.plate_number, v.make, v.model, v.color].filter(Boolean).join(" "))
    .join(" ");
  const students = (p.students || []).join(" ");
  const auth = (p.authorized_guardians || []).map((a) => a.name).join(" ");
  return (
    normalize(p.plate_display).includes(q) ||
    normalize(p.parent).includes(q) ||
    normalize(vehicles).includes(q) ||
    normalize(students).includes(q) ||
    normalize(auth).includes(q)
  );
}

function plateLabel(p) {
  return p.plate_display || (p.vehicles && p.vehicles[0]?.plate_number) || "(plate)";
}

function plateSubtitle(p) {
  const v = (p.vehicles || [])[0];
  const car = v ? [v.color, v.make, v.model].filter(Boolean).join(" ") : "";
  const owner = p.parent ? `· ${p.parent}` : "";
  return [car, owner].filter(Boolean).join(" ") || "Vehicle";
}

export default function SearchPalette({
  open,
  onClose,
  token,
  schoolId,
  onNavigate,
}) {
  const [query, setQuery]   = useState("");
  const [students, setStudents]   = useState([]);
  const [guardians, setGuardians] = useState([]);
  const [plates, setPlates]       = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef(null);
  const listRef  = useRef(null);

  const cacheKey = useMemo(
    () => `${token ?? ""}::${schoolId ?? ""}`,
    [token, schoolId],
  );

  // Fan-out fetch on open (cache-first).  Three independent calls
  // run in parallel; each settles individually so a slow plates
  // endpoint doesn't block student/guardian results from showing.
  useEffect(() => {
    if (!open || !token) return;

    setQuery("");
    setActiveIndex(0);
    setError("");

    const cached = _readCache(cacheKey);
    if (cached) {
      setStudents(cached.students);
      setGuardians(cached.guardians);
      setPlates(cached.plates);
      return;
    }

    const api = createApiClient(token, schoolId);
    let alive = true;
    setLoading(true);

    const next = { students: [], guardians: [], plates: [] };
    let pending = 3;
    const settle = () => {
      if (--pending === 0 && alive) {
        setLoading(false);
        _writeCache(cacheKey, next);
      }
    };

    api.get("/api/v1/admin/students")
      .then((r) => {
        if (!alive) return;
        next.students = r.data?.students ?? [];
        setStudents(next.students);
      })
      .catch(() => {})
      .finally(settle);

    // Empty `search` returns the school-scoped list — same as the
    // GuardianManagement page on first load.
    api.get("/api/v1/admin/guardians")
      .then((r) => {
        if (!alive) return;
        next.guardians = r.data?.guardians ?? [];
        setGuardians(next.guardians);
      })
      .catch(() => {})
      .finally(settle);

    api.get("/api/v1/plates")
      .then((r) => {
        if (!alive) return;
        next.plates = r.data?.plates ?? [];
        setPlates(next.plates);
      })
      .catch(() => {})
      .finally(settle);

    return () => { alive = false; };
  }, [open, token, schoolId, cacheKey]);

  // Focus input on open so the user can type immediately.  Delay
  // one frame so the modal's transition has mounted the element.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Compute the flat result list in render — cheap relative to a
  // couple of hundred records and avoids a stale-state class of
  // bug between query and arrays updating on different ticks.
  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) {
      // Empty state: show the first few of each so an open palette
      // is never an empty box.  Keeps recency cheap (no separate
      // recents store) by leaning on the server's existing sort.
      return [
        ...students.slice(0, RESULTS_PER_GROUP).map((s) => ({
          kind: "student", id: s.id, raw: s,
        })),
        ...guardians.slice(0, RESULTS_PER_GROUP).map((g) => ({
          kind: "guardian", id: g.uid, raw: g,
        })),
        ...plates.slice(0, RESULTS_PER_GROUP).map((p) => ({
          kind: "plate", id: p.plate_token, raw: p,
        })),
      ];
    }
    const out = [];
    for (const s of students) {
      if (studentMatches(s, q)) {
        out.push({ kind: "student", id: s.id, raw: s });
        if (out.filter((r) => r.kind === "student").length >= RESULTS_PER_GROUP) break;
      }
    }
    for (const g of guardians) {
      if (guardianMatches(g, q)) {
        out.push({ kind: "guardian", id: g.uid, raw: g });
        if (out.filter((r) => r.kind === "guardian").length >= RESULTS_PER_GROUP) break;
      }
    }
    for (const p of plates) {
      if (plateMatches(p, q)) {
        out.push({ kind: "plate", id: p.plate_token, raw: p });
        if (out.filter((r) => r.kind === "plate").length >= RESULTS_PER_GROUP) break;
      }
    }
    return out;
  }, [query, students, guardians, plates]);

  // Reset highlight when results shrink (e.g. user types a more
  // specific query) so the index doesn't point past the end.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const choose = useCallback((entry) => {
    if (!entry) return;
    if (entry.kind === "student") {
      onNavigate?.({
        view: "students",
        search: studentLabel(entry.raw),
      });
    } else if (entry.kind === "guardian") {
      onNavigate?.({
        view: "guardians",
        search: entry.raw.display_name || entry.raw.email || "",
      });
    } else if (entry.kind === "plate") {
      onNavigate?.({
        view: "registry",
        search: entry.raw.plate_display || entry.raw.parent || "",
      });
    }
    onClose?.();
  }, [onNavigate, onClose]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(results[activeIndex]);
    }
  };

  // Scroll the active row into view on arrow-key navigation so the
  // highlight doesn't disappear off the bottom of the panel.
  useEffect(() => {
    const node = listRef.current?.querySelector(
      `[data-search-row="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  // Group results purely for presentation — keep the flat `results`
  // array for keyboard-nav indexing.
  const groups = [
    { kind: "student",  title: "Students",  icon: <I.student size={14} /> },
    { kind: "guardian", title: "Guardians", icon: <I.guardians size={14} /> },
    { kind: "plate",    title: "Vehicles",  icon: <I.car size={14} /> },
  ];

  return (
    <div
      className="search-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="search-palette" onKeyDown={onKeyDown}>
        <div className="search-palette-input-row">
          <I.search size={16} />
          <input
            ref={inputRef}
            type="text"
            className="search-palette-input"
            placeholder="Search students, plates, vehicles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="search-palette-kbd t-num">esc</span>
        </div>

        <div className="search-palette-results" ref={listRef}>
          {loading && results.length === 0 && (
            <div className="search-palette-empty">Loading…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="search-palette-empty">
              {query ? "No matches" : "Nothing to show yet"}
            </div>
          )}
          {error && <div className="search-palette-error">{error}</div>}

          {results.length > 0 && groups.map((g) => {
            const rows = results
              .map((r, idx) => ({ r, idx }))
              .filter(({ r }) => r.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <div className="search-palette-group" key={g.kind}>
                <div className="search-palette-group-title">
                  {g.icon}
                  <span>{g.title}</span>
                </div>
                {rows.map(({ r, idx }) => (
                  <button
                    type="button"
                    key={`${r.kind}-${r.id}`}
                    data-search-row={idx}
                    className={
                      "search-palette-row" +
                      (idx === activeIndex ? " search-palette-row-active" : "")
                    }
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => choose(r)}
                  >
                    <RowContent entry={r} />
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        <div className="search-palette-footer">
          <span><kbd className="t-num">↑↓</kbd> navigate</span>
          <span><kbd className="t-num">↵</kbd> open</span>
          <span><kbd className="t-num">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function RowContent({ entry }) {
  if (entry.kind === "student") {
    const s = entry.raw;
    const grade = s.grade ? `Grade ${s.grade}` : "";
    const guardian = s.guardian?.display_name ? `· ${s.guardian.display_name}` : "";
    return (
      <>
        <span className="search-palette-row-title">{studentLabel(s)}</span>
        <span className="search-palette-row-meta">
          {[grade, guardian].filter(Boolean).join(" ") || "Student"}
        </span>
      </>
    );
  }
  if (entry.kind === "guardian") {
    const g = entry.raw;
    const meta = g.email || g.phone || `${g.child_count ?? 0} children`;
    return (
      <>
        <span className="search-palette-row-title">{g.display_name || "(no name)"}</span>
        <span className="search-palette-row-meta">{meta}</span>
      </>
    );
  }
  // plate
  const p = entry.raw;
  return (
    <>
      <span className="search-palette-row-title">{plateLabel(p)}</span>
      <span className="search-palette-row-meta">{plateSubtitle(p)}</span>
    </>
  );
}
