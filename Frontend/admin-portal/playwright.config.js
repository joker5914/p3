import { defineConfig, devices } from "@playwright/test";

// Accessibility-only Playwright harness.  We run Chromium-only because axe-core
// rules are engine-agnostic — re-running on Firefox/WebKit adds CI time without
// catching different a11y bugs.  Re-enable cross-browser if we ever add tests
// that exercise browser-specific behaviour.
export default defineConfig({
  testDir: "./tests/a11y",
  // Fail fast in CI — one broken test shouldn't hide others, but we also
  // don't need to keep running after the first rule violation within a test.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ["list"],
    // HTML report uploaded as a CI artifact so violations are inspectable
    // without rerunning the suite locally.
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },

  // Boot Vite before the suite runs.  reuseExistingServer lets a developer
  // keep `npm run dev` open while iterating on a spec.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
