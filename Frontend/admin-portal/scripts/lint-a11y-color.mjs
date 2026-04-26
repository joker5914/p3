#!/usr/bin/env node
/**
 * lint-a11y-color.mjs
 *
 * Codifies the GOV.UK accessibility rule used across the portal:
 * **colour is never the only channel for meaning**.  Status meaning
 * must always be encoded with a second visual cue (icon, text label,
 * pattern, or position) so colourblind users, screen-reader users,
 * and users in monochrome contexts can perceive it.
 *
 * What this lint actually does:
 *
 *   1. Scans every `src/**\/*.css` file for selectors that paint a
 *      status hue (--green / --amber / --red / --orange / --violet /
 *      --purple, in any of color / background / border / fill).
 *
 *   2. For each selector, classifies it:
 *        - PAIRED   → the selector itself or a sibling/parent rule
 *                     in the same file references an icon-bearing
 *                     class name (matches /icon|chip|pill|tone|dot|
 *                     badge|status-/), implying the chip wraps
 *                     colour + glyph as a unit.
 *        - WRAPPED  → the selector is inside a paired component
 *                     (`.al-tone-warn .al-icon-wrap`, etc.).
 *        - REVIEW   → no obvious pairing in the same file; flag for
 *                     manual review.
 *
 *   3. Prints a report card showing pairing % and a REVIEW list.
 *
 * Why this is "advisory" rather than a hard CI gate: regex-based
 * static analysis can't prove a paired icon is rendered at runtime —
 * it can only flag candidates.  Treat REVIEW entries as a checklist
 * that someone should glance over once per quarter, not a blocker.
 *
 * Hard-failing only ever flagged false positives in pilot runs and
 * pushed people to silence the linter rather than fix a real bug.
 *
 * Run with:  npm run lint:a11y-color
 * Exit code: 0 always (advisory).  Set LINT_A11Y_COLOR_STRICT=1 to
 * exit non-zero on REVIEW entries — useful when you want to block a
 * PR that introduces a new unpaired status colour.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..", "src");

// Tokens whose semantic meaning is "status".  Brand colours (--brand,
// --brand-accent) are intentionally excluded — they're identity, not
// information, so a brand-only fill is fine.
const STATUS_TOKEN_RE =
  /var\(--(green|amber|orange|red|violet|purple)(-subtle|-strong|-hover|-fill)?\)/;

// Properties where a status colour ENCODES MEANING.  `outline` is
// included because focus rings often pick up status hues for danger
// states.  `box-shadow` is excluded because rings/shadows are usually
// brand-tinted, not status-tinted.
const COLOR_PROPS_RE =
  /^\s*(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|fill|stroke|outline(-color)?):\s*[^;]*var\(--(green|amber|orange|red|violet|purple)/m;

// Class-name fragments that signal "this thing carries a glyph or
// label" — a paired channel.  When a CSS selector includes any of
// these tokens, we trust it ships colour + something else.
//
// Three families:
//
//   - Visual chrome that wraps an icon: icon, chip, pill, tone, dot,
//     badge, severity, tag, stat-card.
//
//   - Text-bearing containers: error, warn, alert, message, success,
//     hint, note, label, title, desc, sub, footnote, banner, link,
//     tooltip, required, field-error.  These render visible text
//     inside, so the colour is paired with the text content itself.
//
//   - Buttons: btn-danger, btn-delete, btn-warn, btn-suspend,
//     btn-license, btn-restore, btn-unlicense, btn-status, btn-role-
//     save.  Buttons always carry a visible label.
const PAIRED_CLASS_RE = new RegExp(
  [
    // Visual chrome
    "\\b(icon|chip|pill|tone|dot|badge|status-|severity|tag|stat-card)\\b",
    // Text containers
    "\\b(error|warn|alert|message|success|hint|note|label|title|desc(ription)?|sub|footnote|banner|link|tooltip|required|field-error)\\b",
    // Buttons of any kind (the visible label is the paired channel)
    "\\b(btn|button)\\b",
    // Keyframe step selectors aren't UI — skip them as paired (they
    // animate an already-paired element).
    "^(\\d+%|from|to)$",
  ].join("|"),
  "i",
);

// Selectors we skip entirely — purely visual elements that don't
// communicate status meaning to the user (chart bars, meters, sparklines,
// row-tinted backgrounds without text-on-tint).  These are colour-
// expressive by design (a chart IS its colour) and the chart's
// surrounding caption / axis labels carry the meaning.
const SKIP_SELECTOR_RE =
  /\b(meter|chart|spark|trend|gauge|hist|hm-|h-bar|t-bar|d-bar|wt-fill|conf-bar|fc-fill|pm-seg|pm-dot|stat-card::before|sc-)\b/i;

// Token-definition selectors — :root and [data-theme/palette/...]
// blocks set CSS custom properties; they don't paint anything for the
// user.  Skip so we audit only the call sites that paint status colour.
const TOKEN_DEFINITION_SELECTOR_RE =
  /^(:root|html|body|\[data-(theme|palette|density|type)[^\]]*\])(\s*,\s*(:root|html|body|\[data-(theme|palette|density|type)[^\]]*\]))*$/;

// CSS files we never care about (vendor, build output).
const IGNORE = new Set(["node_modules", "dist", "build", ".vite"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

// Crude CSS rule splitter — sufficient for our token-based rule set.
// Returns [{ selector, body, file, line }, …].  Doesn't handle nesting
// (we don't author nested CSS today) or @-rules.
function extractRules(file) {
  const text = readFileSync(file, "utf8");
  const rules = [];
  // Strip /* … */ comments first so they don't confuse the brace
  // matcher.  Preserve newline count so line numbers stay accurate.
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  let i = 0;
  let line = 1;
  while (i < stripped.length) {
    const open = stripped.indexOf("{", i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < stripped.length && depth > 0) {
      const ch = stripped[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth !== 0) break;
    const selectorRaw = stripped.slice(i, open).trim();
    const body = stripped.slice(open + 1, j - 1);
    // Skip @-rules (@media, @keyframes, etc.) — recurse into their body
    // by splicing it back into the stream so child rules get visited.
    if (selectorRaw.startsWith("@")) {
      i = open + 1;
      continue;
    }
    // Track lines: count newlines from the previous cursor.
    line += (stripped.slice(i, open).match(/\n/g) || []).length;
    rules.push({ selector: selectorRaw, body, file, line });
    line += (body.match(/\n/g) || []).length;
    i = j;
  }
  return rules;
}

function classify(rule, allRulesInFile) {
  const usesStatus =
    COLOR_PROPS_RE.test(rule.body) || STATUS_TOKEN_RE.test(rule.body);
  if (!usesStatus) return null;

  // SKIP: visual-only selectors (charts, meters, sparkline bars).
  if (SKIP_SELECTOR_RE.test(rule.selector)) return null;

  // SKIP: token-definition selectors (`:root`, `[data-theme/palette]`).
  // These don't paint — they define the var() values everything else
  // reads.  Confirming "the token definitions ship a paired channel"
  // is a category error.
  if (TOKEN_DEFINITION_SELECTOR_RE.test(rule.selector.trim())) return null;

  // PAIRED: the selector itself names a paired-class fragment.
  if (PAIRED_CLASS_RE.test(rule.selector)) return "PAIRED";

  // WRAPPED: another rule in the same file targets a child of this
  // selector that wraps an icon (e.g. ".al-tone-warn .al-icon-wrap").
  // Approximation: any other rule whose selector starts with ours
  // and includes a paired-class fragment.
  const sel = rule.selector;
  for (const other of allRulesInFile) {
    if (other === rule) continue;
    if (
      other.selector.startsWith(sel) &&
      PAIRED_CLASS_RE.test(other.selector)
    ) {
      return "WRAPPED";
    }
  }

  return "REVIEW";
}

function main() {
  const files = walk(SRC_ROOT);
  let paired = 0;
  let wrapped = 0;
  const review = [];

  for (const file of files) {
    const rules = extractRules(file);
    for (const rule of rules) {
      const verdict = classify(rule, rules);
      if (verdict === "PAIRED") paired++;
      else if (verdict === "WRAPPED") wrapped++;
      else if (verdict === "REVIEW") {
        review.push({
          file: relative(join(__dirname, ".."), rule.file),
          line: rule.line,
          selector: rule.selector.replace(/\s+/g, " ").slice(0, 80),
        });
      }
    }
  }

  const total = paired + wrapped + review.length;
  const pairedPct = total === 0 ? 100 : ((paired + wrapped) / total) * 100;

  console.log("");
  console.log("a11y colour-pairing audit");
  console.log("─".repeat(60));
  console.log(`  PAIRED   (selector self-identifies as a chip/pill/tone): ${paired}`);
  console.log(`  WRAPPED  (paired by a sibling selector in same file)  : ${wrapped}`);
  console.log(`  REVIEW   (no paired sibling found — manual check)     : ${review.length}`);
  console.log(`  TOTAL status-colour rules                              : ${total}`);
  console.log(`  Paired%                                                : ${pairedPct.toFixed(1)}%`);

  if (review.length > 0) {
    console.log("");
    console.log("REVIEW candidates — confirm each ships an icon, label, or pattern alongside the colour:");
    console.log("");
    for (const r of review) {
      console.log(`  ${r.file}:${r.line}  ${r.selector}`);
    }
    console.log("");
  }

  const strict = process.env.LINT_A11Y_COLOR_STRICT === "1";
  if (strict && review.length > 0) {
    console.error(`Strict mode: ${review.length} unpaired status-colour rule(s) — failing.`);
    process.exit(1);
  }
}

main();
