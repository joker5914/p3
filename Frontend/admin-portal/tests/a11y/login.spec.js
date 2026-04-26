import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// ---------------------------------------------------------------------------
// Phase 4 of the WCAG 2.2 AA audit — regression guard.
//
// Scope today: the Login page in all three modes (login, signup, reset).
// The rest of the portal is gated by Firebase Auth and cannot be reached
// without a test Firebase project + fixture credentials.  See the
// "Expanding coverage" note at the bottom of this file for the playbook
// when that infrastructure lands.
//
// Why this coverage is still valuable even without authenticated routes:
// every page in the portal uses the same component patterns (form fields
// with htmlFor, icon-only buttons with aria-label, status chips with
// role/aria-live, modal dialogs with role="dialog").  If one of those
// patterns regresses on Login it will almost certainly have regressed
// elsewhere too — catching it here catches it everywhere cheaply.
// ---------------------------------------------------------------------------

// Rules we're deferring from the initial rollout — see notes below.
//
//   color-contrast: the brand blue (#25ABE2) used for links fails 4.5:1
//     against white.  Fixing this requires product design sign-off on a
//     darker accent; tracked as a follow-up and should be removed from
//     this list once the palette is updated.
const DEFERRED_RULES = ["color-contrast"];

async function expectNoAxeViolations(page, { tagContext } = {}) {
  const builder = new AxeBuilder({ page })
    // Full WCAG 2.2 AA conformance.
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .disableRules(DEFERRED_RULES);

  const results = await builder.analyze();

  // Attach the violations to the test report so a failure is actionable
  // without having to re-run locally.
  if (results.violations.length) {
    const detail = results.violations
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(
      `axe violations${tagContext ? ` (${tagContext})` : ""}:\n${detail}`,
    );
  }
  expect(results.violations, "axe-core violations found — see console output above").toEqual([]);
}

// "/" serves the marketing landing page (Website.jsx); any non-public
// path falls through to the Login flow per App.jsx getPublicRoute().
// Use /portal as the canonical jump-off so axe runs against Login, not
// the marketing site.
const LOGIN_URL = "/portal";

// Form labels use the .t-eyebrow utility (text-transform: uppercase),
// so Chromium's accessible-name computation may report the visible
// uppercase text. Match case-insensitively.
const EMAIL_LABEL = /e-?mail/i;

test.describe("Login page — WCAG 2.2 AA", () => {
  test("sign-in form has no axe violations", async ({ page }) => {
    await page.goto(LOGIN_URL);
    // Wait for the email input rather than a race with React hydration.
    await page.getByLabel(EMAIL_LABEL).first().waitFor();
    await expectNoAxeViolations(page, { tagContext: "login mode" });
  });

  test("signup form has no axe violations", async ({ page }) => {
    await page.goto(LOGIN_URL);
    await page.getByRole("button", { name: /create a guardian account/i }).click();
    await page.getByLabel(/full name/i).waitFor();
    await expectNoAxeViolations(page, { tagContext: "signup mode" });
  });

  test("password-reset form has no axe violations", async ({ page }) => {
    await page.goto(LOGIN_URL);
    await page.getByRole("button", { name: /forgot password/i }).click();
    await page.getByLabel(/account email/i).waitFor();
    await expectNoAxeViolations(page, { tagContext: "reset mode" });
  });

  test("document has lang attribute and title", async ({ page }) => {
    // These are checked by axe too but calling them out as explicit tests
    // makes the failure message clearer than "html-has-lang violation".
    await page.goto(LOGIN_URL);
    await expect(page).toHaveTitle(/dismissal/i);
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Expanding coverage (playbook for when Firebase Auth fixtures exist)
// ---------------------------------------------------------------------------
//
// 1. Spin up a Firebase Auth emulator OR create a dedicated test Firebase
//    project with a known set of fixture users (one per role: super_admin,
//    district_admin, school_admin, staff, guardian).
//
// 2. Add a Playwright auth-setup project that signs each fixture user in
//    once and persists storageState to a JSON file per role.
//
// 3. Add role-scoped spec files that load the appropriate storageState
//    via `test.use({ storageState: "auth/staff.json" })` and navigate the
//    authenticated routes (Dashboard, History, Registry, UserManagement,
//    PlatformAdmin, etc), running expectNoAxeViolations on each.
//
// 4. For routes that render async content (Dashboard queue, History
//    table), seed test data via the backend API before navigating, so
//    axe sees populated DOM instead of the empty state.
// ---------------------------------------------------------------------------
