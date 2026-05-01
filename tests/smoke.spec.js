// @ts-check
// First Playwright test — login smoke test.
// Verifies the basic flow: navigate to portal → log in → land on dashboard.
// Safe: just reads, doesn't create or modify any data.
//
// Run with:  npx playwright test
// Run headed (watch the browser):  HEADED=1 npx playwright test
// Run with UI mode (interactive):  npx playwright test --ui

const { test, expect } = require('@playwright/test');

// ─── Test credentials ────────────────────────────────────────────────────────
// Set these via env vars so they're not committed to git.
// PowerShell:  $env:TEST_BROKER_EMAIL="..."; $env:TEST_BROKER_PASSWORD="..."
// Or create a `.env.local` (gitignored) and load it via dotenv.
const TEST_EMAIL = process.env.TEST_BROKER_EMAIL || 'sumitkanthed@gmail.com';
const TEST_PASSWORD = process.env.TEST_BROKER_PASSWORD || '';

if (!TEST_PASSWORD) {
  console.warn('[smoke] TEST_BROKER_PASSWORD not set — login test will fail.');
  console.warn('[smoke] Set it in PowerShell: $env:TEST_BROKER_PASSWORD = "your-password"');
}

test.describe('Daksfirst auth portal — smoke', () => {

  // Helper: navigate to login form. The root URL shows a landing screen with
  // "I'm a Broker" / "I'm a Borrower" tiles and a small "Sign in" link at the
  // bottom. Clicking "Sign in" switches to the login form.
  async function gotoLoginForm(page) {
    await page.goto('/');
    // Click the "Sign in" link (matches 3 things by text — link, h2, button — so
    // we target the link role specifically, which switches the SPA to login screen).
    await page.getByRole('link', { name: 'Sign in' }).click();
    // Wait for the login form to actually appear
    await expect(page.locator('#login-email')).toBeVisible({ timeout: 5000 });
  }

  test('login page renders', async ({ page }) => {
    await gotoLoginForm(page);
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
  });

  test('login succeeds with valid credentials', async ({ page }) => {
    test.skip(!TEST_PASSWORD, 'TEST_BROKER_PASSWORD env var not set');
    await gotoLoginForm(page);
    await page.fill('#login-email', TEST_EMAIL);
    await page.fill('#login-password', TEST_PASSWORD);
    await page.click('#login-btn');
    // After login, we should NOT see the login form anymore — some other screen mounts.
    await expect(page.locator('#login-email')).toBeHidden({ timeout: 10000 });
  });

  test('quick-quote form is reachable after login', async ({ page }) => {
    test.skip(!TEST_PASSWORD, 'TEST_BROKER_PASSWORD env var not set');
    await gotoLoginForm(page);
    await page.fill('#login-email', TEST_EMAIL);
    await page.fill('#login-password', TEST_PASSWORD);
    await page.click('#login-btn');
    // QQ section should be on the dashboard (broker role)
    await expect(page.locator('#qq-section')).toBeVisible({ timeout: 10000 });
    // Open the form
    await page.click('#qq-toggle');
    await expect(page.locator('#qq-form')).toBeVisible();
    // Form has the expected fields
    await expect(page.locator('#qq-company-number')).toBeVisible();
    await expect(page.locator('#qq-loan-amount')).toBeVisible();
    await expect(page.locator('#qq-submit')).toBeVisible();
  });

});
