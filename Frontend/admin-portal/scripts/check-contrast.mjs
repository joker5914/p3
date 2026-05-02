#!/usr/bin/env node
/**
 * check-contrast.mjs
 *
 * Asserts WCAG 2.1 contrast ratios for the documented foreground /
 * background pairs used on the public surfaces — the marketing site
 * (`/`, `/trust`, `/accessibility`) and the sign-in page (`/portal`).
 * Both trees lock to `data-theme="light"` + `data-palette="citrus"`
 * (see Website.jsx and Login.jsx) and apply the same scoped token
 * overrides (--brand → #ad3a0e, --text-tertiary → #65656f, etc.) in
 * Website.css `.web` and Login.css `.login-shell`, so most of the
 * brand / muted-text / status pairs below cover BOTH scopes — pair
 * labels call out anything that's specific to one of them.
 *
 * Thresholds (per WCAG):
 *   - AA  body text:   4.5:1
 *   - AA  large text:  3.0:1   (≥ 18pt or ≥ 14pt bold)
 *   - AA  UI / icons:  3.0:1   (1.4.11 Non-text Contrast)
 *   - AAA body text:   7.0:1
 *   - AAA large text:  4.5:1
 *
 * `min` on each pair is the AA target; `aaa` is the optional AAA target
 * (set to null for UI/icon pairs that don't need to clear AAA).
 *
 * Run: `npm run a11y:contrast`
 *      `npm run a11y:contrast -- --aaa`   (also fails on AAA misses)
 *
 * Exit 0 when every pair meets its `min`, 1 otherwise.  In `--aaa`
 * mode, also fails when a pair has an `aaa` target it doesn't meet.
 */

const STRICT_AAA = process.argv.includes("--aaa");

// ── WCAG relative-luminance + contrast (sRGB) ─────────────────────
function _channel(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function _luminance(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`bad hex: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b);
}
function contrast(fg, bg) {
  const L1 = _luminance(fg);
  const L2 = _luminance(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Documented pairs (light theme, citrus palette) ────────────────
// Mirror these against src/index.css [data-theme="light"] + the citrus
// :root brand block.  When you bump a token, update the value here so
// the script stays a source of truth instead of drifting.
const TOKENS = {
  // Surfaces
  "bg-canvas":  "#f6f6f4",
  "bg-surface": "#ffffff",
  "bg-sunken":  "#efefec",
  // Text — global tokens
  "text-primary":    "#14141a",
  "text-secondary":  "#5b5b66",
  "text-tertiary":   "#8c8c98",   // legacy — fails AA on light bgs; not used for body in marketing
  // Marketing-only AA-safe tertiary (defined in Website.css under `.web`).
  "text-tertiary-aa": "#65656f",
  // Brand — citrus light-theme global token (used in /portal etc.).
  "brand":             "#f0791f",
  // Marketing-only brand override (darker for AA on every light
  // surface AND on the cream `--brand-subtle` background where small
  // mono captions sit on hero cards).  Defined in Website.css `.web`.
  "brand-marketing":   "#ad3a0e",  // friendly orange — AA body on every light surface and on both single- and double-tinted brand-subtle backgrounds
  "brand-strong":      "#9a3412",  // AAA companion (orange-800) for hero accents that want ≥7:1 against surface
  // brand-subtle composites.  The same rgba(R, G, B, 0.10) layer paints
  // a different colour depending on its parent surface, so we audit the
  // two compositions that actually appear in the marketing tree:
  //   • over bg-surface (#ffffff) — the .num pill and most hero cards
  //   • over bg-sunken  (#efefec) — the inner cards inside .web-step
  //     .visual, which sets a sunken backdrop.  Without this pair the
  //     audit missed a "Maya · Theo" / "Audit ✓" double-tint regression.
  // Re-derive both whenever brand-marketing changes
  // (composite = R*0.10 + parentR*0.90, etc.).
  "brand-subtle-on-surface": "#f7ebe7",
  "brand-subtle-on-sunken":  "#e8ddd6",
  // Status (light-theme tuned)
  "green":             "#16a34a",  // global token
  "green-strong":      "#15803d",  // body-text variant — marketing's --green-strong AND sign-in's overridden --green resolve to this
  "amber":             "#b45309",
  "red":               "#b91c1c",
};

const PAIRS = [
  // ── Body text on canvas ────────────────────────────────
  { fg: "text-primary",   bg: "bg-canvas",  min: 4.5, aaa: 7.0, label: "primary text on canvas" },
  { fg: "text-secondary", bg: "bg-canvas",  min: 4.5, aaa: 7.0, label: "secondary text on canvas" },
  { fg: "text-tertiary-aa", bg: "bg-canvas", min: 4.5, aaa: null, label: "tertiary text (AA strength) on canvas" },

  // ── Body text on surface (cards) ───────────────────────
  { fg: "text-primary",   bg: "bg-surface", min: 4.5, aaa: 7.0, label: "primary text on surface" },
  { fg: "text-secondary", bg: "bg-surface", min: 4.5, aaa: 7.0, label: "secondary text on surface" },
  { fg: "text-tertiary-aa", bg: "bg-surface", min: 4.5, aaa: null, label: "tertiary text (AA strength) on surface" },

  // ── Body text on sunken (alt sections) ─────────────────
  { fg: "text-primary",   bg: "bg-sunken",  min: 4.5, aaa: 7.0, label: "primary text on sunken" },
  { fg: "text-secondary", bg: "bg-sunken",  min: 4.5, aaa: 7.0, label: "secondary text on sunken" },
  { fg: "text-tertiary-aa", bg: "bg-sunken", min: 4.5, aaa: null, label: "tertiary text (AA strength) on sunken" },

  // ── Brand accents (marketing site `.web` + sign-in `.login-shell`) ──
  // Both scopes override --brand to brand-marketing (#ad3a0e) so
  // body-text usages clear AA on light bgs.  Same hex on both
  // surfaces by design — this block audits the values that paint on
  // EITHER `/` (Website.css) or `/portal` (Login.css).  brand-strong
  // is the AAA companion used by the marketing hero only.
  { fg: "brand-marketing", bg: "bg-canvas",  min: 4.5, aaa: null, label: "brand body on canvas (marketing + sign-in form panel)" },
  { fg: "brand-marketing", bg: "bg-surface", min: 4.5, aaa: null, label: "brand body on surface (marketing + sign-in inputs / SSO buttons)" },
  { fg: "brand-marketing", bg: "bg-sunken",  min: 4.5, aaa: null, label: "brand body on sunken (marketing + sign-in hero panel)" },
  // Hero cards on `/` set background: var(--brand-subtle) and text
  // colour: var(--brand) on the same node — must clear AA against the
  // cream composite, otherwise axe flags the "Audit ✓" / "Maya · Theo"
  // eyebrows.  Marketing-only; the sign-in page doesn't use
  // brand-subtle as a text background.
  { fg: "brand-marketing", bg: "brand-subtle-on-surface", min: 4.5, aaa: null, label: "marketing brand text on brand-subtle background (over surface)" },
  // The "How it works" step 3 puts brand-subtle cards inside .web-step
  // .visual, which has a bg-sunken backdrop.  The 0.10 alpha then
  // composites over #efefec instead of #ffffff, producing a darker
  // cream that drops the brand-on-tint contrast.  Audit the nested
  // composition explicitly so a brand bump can't regress it again.
  { fg: "brand-marketing", bg: "brand-subtle-on-sunken",  min: 4.5, aaa: null, label: "marketing brand text on brand-subtle background (over sunken — nested step-3 cards)" },
  { fg: "brand-strong",    bg: "bg-canvas",  min: 4.5, aaa: 7.0,  label: "brand strong (AAA) on canvas" },
  { fg: "brand-strong",    bg: "bg-surface", min: 4.5, aaa: 7.0,  label: "brand strong (AAA) on surface" },

  // ── Status text on light surfaces ──────────────────────
  // The light-theme overrides in index.css darken these for AA; verify.
  { fg: "green-strong", bg: "bg-surface", min: 4.5, aaa: null, label: "green status body on surface" },
  { fg: "green-strong", bg: "bg-canvas",  min: 4.5, aaa: null, label: "green status body on canvas" },
  { fg: "amber", bg: "bg-surface", min: 4.5, aaa: null, label: "amber status text on surface" },
  { fg: "amber", bg: "bg-canvas",  min: 4.5, aaa: null, label: "amber status text on canvas" },
  { fg: "red",   bg: "bg-surface", min: 4.5, aaa: null, label: "red status text on surface" },
  { fg: "red",   bg: "bg-canvas",  min: 4.5, aaa: null, label: "red status text on canvas" },
];

// ── Run audit ─────────────────────────────────────────────────────
let aaFails = 0;
let aaaFails = 0;
const rows = [];

for (const { fg, bg, min, aaa, label } of PAIRS) {
  const fgHex = TOKENS[fg];
  const bgHex = TOKENS[bg];
  if (!fgHex || !bgHex) {
    console.error(`unknown token: fg=${fg} bg=${bg}`);
    process.exit(2);
  }
  const ratio = contrast(fgHex, bgHex);
  const aaPass = ratio >= min;
  const aaaPass = aaa === null ? null : ratio >= aaa;

  if (!aaPass) aaFails++;
  if (aaaPass === false) aaaFails++;

  rows.push({
    label,
    fg: `${fg} (${fgHex})`,
    bg: `${bg} (${bgHex})`,
    ratio: ratio.toFixed(2),
    aa: aaPass ? "PASS" : "FAIL",
    aaa:
      aaaPass === null ? "—" :
      aaaPass         ? "PASS" :
                        "FAIL",
    min,
    aaaTarget: aaa,
  });
}

// ── Report ────────────────────────────────────────────────────────
console.log("");
console.log("Public-surface contrast audit — marketing + sign-in (light theme · citrus palette)");
console.log("=".repeat(72));
console.log("");

const colW = {
  label: 56,
  ratio: 7,
  aa: 6,
  aaa: 6,
};
console.log(
  "  " +
    "pair".padEnd(colW.label) +
    "ratio".padStart(colW.ratio) +
    "  " +
    "AA".padStart(colW.aa) +
    "  " +
    "AAA".padStart(colW.aaa),
);
console.log("  " + "-".repeat(colW.label + colW.ratio + colW.aa + colW.aaa + 4));
for (const r of rows) {
  console.log(
    "  " +
      r.label.padEnd(colW.label) +
      r.ratio.padStart(colW.ratio) +
      "  " +
      r.aa.padStart(colW.aa) +
      "  " +
      r.aaa.padStart(colW.aaa),
  );
}
console.log("");
console.log(`  AA failures:  ${aaFails}`);
console.log(`  AAA failures: ${aaaFails}${STRICT_AAA ? "" : "  (informational; pass --aaa to fail)"}`);
console.log("");

if (aaFails > 0) {
  console.error("AA threshold not met — fix the values in src/index.css [data-theme=\"light\"] or update the docs above.");
  process.exit(1);
}
if (STRICT_AAA && aaaFails > 0) {
  console.error("AAA threshold not met (strict mode).");
  process.exit(1);
}
console.log("All AA pairs pass.");
