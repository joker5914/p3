import Papa from "papaparse";

/**
 * Trigger a CSV file download in the browser.
 * @param {object[]} rows  - Array of flat objects (each key becomes a column header).
 * @param {string}   filename - Desired filename (e.g. "dismissal-history-2025-04-05.csv").
 */
export function downloadCSV(rows, filename) {
  if (!rows?.length) return;
  const csv  = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Returns today's date in YYYY-MM-DD (local time). */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Format an ISO timestamp string into a human-readable date+time.
 * e.g. "Apr 5 · 3:24 PM"
 */
export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

/** Format an ISO timestamp into a short date: "Apr 5, 2025" */
export function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Normalise an error from an axios call into a string safe to render in
 * React state.
 *
 * FastAPI returns a string ``detail`` for ``HTTPException`` but an
 * *array of validation-error objects* on 422 (Pydantic) — shape
 * ``[{type, loc, msg, input, ctx}, ...]``.  Writing that array into
 * state and rendering it inside JSX trips minified React error #31
 * ("Objects are not valid as a React child") and can unmount the whole
 * page, turning a recoverable validation failure into a blank screen.
 *
 * Use this anywhere we surface API errors to a user — it handles all
 * three real-world shapes (string, array, plain object) and falls back
 * to ``err.message`` then the supplied fallback.
 */
export function formatApiError(err, fallback = "Request failed") {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (typeof d === "string") return d;
        const field = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        const msg   = d?.msg || "Invalid value";
        return field ? `${field}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (detail && typeof detail === "object") {
    return detail.msg || JSON.stringify(detail);
  }
  return err?.message || fallback;
}
