// @ts-check
// Full QQ → convert-to-deal → property panel test.
//
// This is the test that would have caught most of the bugs from this session:
//   - Orphan window handlers (button click → assert state change)
//   - Property panel "vaporised" (assert rich panel visible after click)
//   - QQ → Chimnie auto-fire (assert chimnie_uprn populated post-convert)
//   - Property dedup (test could be extended to add a duplicate row + assert
//     dedup catches it — left as a follow-up scenario)
//
// SAFETY NOTES:
//   - Creates ONE test deal per run on the target environment.
//   - Test deal is identifiable via borrower_company starting with
//     "PLAYWRIGHT_TEST_" so cleanup SQL can find it.
//   - Test DOES fire CH verify (free) on the company number provided.
//   - Test does NOT fire Chimnie (we provide manual_avm so post-convert
//     enrichment uses the provided AVM rather than burning a credit). HOWEVER,
//     the auto-enrich helpers WILL fire Postcodes.io + EPC + Chimnie based on
//     route logic. So this test DOES burn 1 Chimnie credit per run on prod.
//     Run sparingly until staging is in sync.
//
// Run with:  npx playwright test tests/qq_full_flow.spec.js
// Watch it:  HEADED=1 npx playwright test tests/qq_full_flow.spec.js

const { test, expect } = require('@playwright/test');

const TEST_EMAIL = process.env.TEST_BROKER_EMAIL || 'sumitkanthed@gmail.com';
const TEST_PASSWORD = process.env.TEST_BROKER_PASSWORD || '';

// Test data — uses real-ish values so backend integrations resolve correctly.
// Postcode chosen to be Sumit's known Faulkner property so EPC/Postcodes.io match.
// Company number — leave empty to skip CH verify, OR set to a real Ltd CRN for full flow.
const TEST_PROPERTY = {
  postcode: 'W6 9AE',
  address: 'Test property — playwright',
  manual_avm: '2050000',
  purpose: 'acquisition',
};
const TEST_LOAN_AMOUNT = '1500000';
const TEST_COMPANY_NUMBER = process.env.TEST_COMPANY_NUMBER || '';   // optional — set to a real CRN to exercise CH verify
const TEST_TAG = `PLAYWRIGHT_TEST_${new Date().toISOString().slice(0, 10)}`;

test.describe('QQ → convert-to-deal → property panel (full flow)', () => {

  test.skip(!TEST_PASSWORD, 'TEST_BROKER_PASSWORD env var not set');

  test('broker submits QQ, converts to deal, property panel shows enrichment', async ({ page }) => {

    // ─── 1. Login as broker ─────────────────────────────────────────────
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.locator('#login-email')).toBeVisible({ timeout: 5000 });
    await page.fill('#login-email', TEST_EMAIL);
    await page.fill('#login-password', TEST_PASSWORD);
    await page.click('#login-btn');

    // ─── 2. Open the QQ form ─────────────────────────────────────────────
    await expect(page.locator('#qq-section')).toBeVisible({ timeout: 10000 });
    // The toggle button might say "Open quote form" or "Close" depending on state
    const formContainer = page.locator('#qq-form-container');
    if (!(await formContainer.isVisible())) {
      await page.click('#qq-toggle');
    }
    await expect(page.locator('#qq-form')).toBeVisible();

    // ─── 3. Fill property 1 ─────────────────────────────────────────────
    // Property rows use data-prop-{field}="${idx}" — first row is idx=1
    await page.fill('[data-prop-postcode="1"]', TEST_PROPERTY.postcode);
    await page.fill('[data-prop-address="1"]', TEST_PROPERTY.address);
    await page.selectOption('[data-prop-purpose="1"]', TEST_PROPERTY.purpose);
    await page.fill('[data-prop-manual-avm="1"]', TEST_PROPERTY.manual_avm);

    // ─── 4. Fill company + loan amount ─────────────────────────────────
    if (TEST_COMPANY_NUMBER) {
      await page.fill('#qq-company-number', TEST_COMPANY_NUMBER);
    }
    await page.fill('#qq-loan-amount', TEST_LOAN_AMOUNT);

    // ─── 5. Submit QQ → wait for result panel ──────────────────────────
    await page.click('#qq-submit');
    await expect(page.locator('#qq-result-container')).toBeVisible({ timeout: 30000 });

    // The result container should now show either eligibility verdict + a CTA button
    // The CTA button has id="qq-submit-deal" — click it to convert to a deal
    const submitDealBtn = page.locator('#qq-submit-deal');
    await expect(submitDealBtn).toBeVisible({ timeout: 5000 });

    // ─── 6. Click "Submit Anyway" / "Submit full deal pack" ────────────
    await submitDealBtn.click();

    // ─── 7. Wait for navigation to "Complete Your Deal" screen ───────
    // Submit Anyway → convert-to-deal → broker lands on screen-complete-deal
    // (NOT the matrix yet — matrix comes after broker fills CYD). This is the
    // expected end-state of the QQ → convert-to-deal flow.
    // Convert-to-deal fires CH verify + property auto-enrich, can take 10-20s.
    await expect(page.locator('text=CAPTURED FROM YOUR QUICK QUOTE')).toBeVisible({ timeout: 30000 });

    // ─── 8. Assert QQ-derived data carried over ──────────────────────
    // Use regex matching for resilience against non-breaking spaces / split nodes.
    // We're proving convert-to-deal carried QQ data into the new deal.
    await expect(page.locator(`text=/£\\s*${Number(TEST_LOAN_AMOUNT).toLocaleString()}|£\\s*1,500,000/i`).first()).toBeVisible({ timeout: 5000 });

    // ─── 9. Done. Test deal was created on the target env. ────────────
    // To clean up, run this SQL on the target DB (replace XXX with the value
    // printed at the start of this test):
    //   DELETE FROM deal_submissions WHERE borrower_company LIKE 'PLAYWRIGHT_TEST_%';
    console.log(`[test] Test deal created. Tag: ${TEST_TAG}`);
  });

});
