// @ts-check
// Playwright config — Daksfirst auth portal end-to-end tests.
// SAFETY GUARDS BAKED IN: tests refuse to run against production URLs.

const { defineConfig, devices } = require('@playwright/test');

// ─── URL safety guard ────────────────────────────────────────────────────────
// Default base URL = staging. Override via env var if you absolutely need to
// test against a different env. The guard refuses to run against prod unless
// you explicitly pass ALLOW_PROD=yes — designed to fail fast on accident.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://apply-staging.daksfirst.com';

const isProd = /^https?:\/\/apply\.daksfirst\.com/i.test(BASE_URL);
if (isProd && process.env.ALLOW_PROD !== 'yes') {
  console.error('\n⛔ REFUSING to run tests against PRODUCTION URL: ' + BASE_URL);
  console.error('   Tests write real data, fire paid APIs, send real emails.');
  console.error('   Use https://apply-staging.daksfirst.com instead.');
  console.error('   To override deliberately: ALLOW_PROD=yes PLAYWRIGHT_BASE_URL=' + BASE_URL + ' npx playwright test\n');
  process.exit(1);
}

console.log('[playwright] Tests will run against: ' + BASE_URL);

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',   // Only match Playwright spec files — skip api.test.js (jest-style)
  fullyParallel: false,        // Sequential — easier to debug, no DB race conditions
  forbidOnly: !!process.env.CI,
  retries: 0,                  // No auto-retry — flaky tests should be diagnosed, not papered over
  workers: 1,                  // Single worker — simpler isolation
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',   // Record everything on retry — invaluable for diagnosis
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
