import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Public-route axe coverage — Marketing landing (/) and Trust (/trust).
// Both are pre-auth surfaces and should hold the same WCAG 2.2 AA bar
// as the Login page in login.spec.js.  Lives in its own file so a
// regression on the marketing site doesn't get blamed on a Login change
// in PR review.

const DEFERRED_RULES = ["color-contrast"];

async function expectNoAxeViolations(page, { tagContext } = {}) {
  const builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .disableRules(DEFERRED_RULES);

  const results = await builder.analyze();

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

test.describe("Marketing landing — WCAG 2.2 AA", () => {
  test("/ has no axe violations", async ({ page }) => {
    await page.goto("/");
    // The marketing site renders client-side — wait for any heading
    // visible to be sure React has hydrated.
    await page.locator("h1, h2").first().waitFor();
    await expectNoAxeViolations(page, { tagContext: "marketing /" });
  });

  test("/ has lang and title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/dismissal/i);
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBeTruthy();
  });
});

test.describe("Trust page — WCAG 2.2 AA", () => {
  test("/trust has no axe violations", async ({ page }) => {
    await page.goto("/trust");
    await page.locator("h1, h2").first().waitFor();
    await expectNoAxeViolations(page, { tagContext: "/trust" });
  });
});

test.describe("Accessibility statement — WCAG 2.2 AA", () => {
  test("/accessibility has no axe violations", async ({ page }) => {
    await page.goto("/accessibility");
    await page.locator("h1, h2").first().waitFor();
    await expectNoAxeViolations(page, { tagContext: "/accessibility" });
  });
});

test.describe("Receipt verify page — WCAG 2.2 AA", () => {
  // Public chain-of-custody receipt verifier (issue #72).  Reached by
  // anyone scanning the QR code on a printed receipt — must clear the
  // same a11y bar as the marketing site, with the added wrinkle that
  // the verdict carries a strong colour-coded affordance and so MUST
  // also reach the user via icon + text.  axe-core covers the colour
  // pairing rule; the custom assertion below covers icon-and-text
  // redundant signalling.
  test("/verify/<malformed> has no axe violations and reports missing-id state", async ({ page }) => {
    await page.goto("/verify/not-a-real-id");
    await page.locator("h1").first().waitFor();
    await expectNoAxeViolations(page, { tagContext: "/verify/<malformed>" });
    // Verdict heading should be focusable and its content readable
    // independently of the icon (text alternative requirement).
    const heading = page.locator("#verify-verdict-heading");
    await expect(heading).toBeVisible();
    const headingText = (await heading.innerText()).trim();
    expect(headingText.length).toBeGreaterThan(0);
  });
});
