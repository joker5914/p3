import Papa from "papaparse";

/**
 * Trigger a CSV file download in the browser.
 * @param {object[]} rows  - Array of flat objects (each key becomes a column header).
 * @param {string}   filename - Desired filename (e.g. "p3-history-2025-04-05.csv").
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
