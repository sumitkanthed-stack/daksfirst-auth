/**
 * routes/borrower-balance-sheet.js — Sprint 3 #17 (2026-04-28)
 * ============================================================
 * Per-UBO balance sheet admin endpoints. Admin-only.
 *
 * MOUNT: app.use('/api/admin/balance-sheet', balanceSheetRoutes);
 *
 * Portfolio properties:
 *   GET    /borrower/:borrowerId/portfolio
 *   POST   /borrower/:borrowerId/portfolio
 *   PUT    /portfolio/:id
 *   DELETE /portfolio/:id
 *
 * Other assets/liabilities:
 *   GET    /borrower/:borrowerId/other
 *   POST   /borrower/:borrowerId/other        body: { kind: 'asset'|'liability', ... }
 *   PUT    /other/:id
 *   DELETE /other/:id
 *
 * Roll-up:
 *   GET    /borrower/:borrowerId/net-worth
 *   GET    /deal/:dealId/all                 — aggregator for the matrix
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const bs = require('../services/borrower-balance-sheet');

const router = express.Router();
router.use(authenticateToken);
router.use(authenticateAdmin);

function wrapErr(res, err, fallback = 'Internal error') {
  console.error('[balance-sheet]', err);
  const msg = (err && err.message) || fallback;
  const status = /required|invalid|must be/i.test(msg) ? 400 : 500;
  res.status(status).json({ success: false, error: msg });
}

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─────────────────────────────────────────────────
// Schema endpoint
// ─────────────────────────────────────────────────
router.get('/schema', (req, res) => {
  res.json({
    success: true,
    data: {
      portfolio_columns: bs.PROP_COLS,
      asset_liability_columns: bs.ASSET_COLS,
      valid_kinds: bs.VALID_KIND,
      common_categories: bs.COMMON_CATEGORIES
    }
  });
});

// ─────────────────────────────────────────────────
// Portfolio properties
// ─────────────────────────────────────────────────
router.get('/borrower/:borrowerId/portfolio', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const rows = await bs.listPortfolioForBorrower(id);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) { wrapErr(res, err); }
});

router.post('/borrower/:borrowerId/portfolio', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const userId = req.user && req.user.id;
    const row = await bs.createPortfolioRow(id, req.body || {}, userId);
    res.status(201).json({ success: true, data: row });
  } catch (err) { wrapErr(res, err); }
});

router.put('/portfolio/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const row = await bs.updatePortfolioRow(id, req.body || {});
    if (!row) return res.status(404).json({ success: false, error: 'Property not found' });
    res.json({ success: true, data: row });
  } catch (err) { wrapErr(res, err); }
});

router.delete('/portfolio/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const r = await bs.softDeletePortfolioRow(id);
    if (!r) return res.status(404).json({ success: false, error: 'Property not found' });
    res.json({ success: true, data: r });
  } catch (err) { wrapErr(res, err); }
});

// ─────────────────────────────────────────────────
// Other assets/liabilities
// ─────────────────────────────────────────────────
router.get('/borrower/:borrowerId/other', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const rows = await bs.listAssetsLiabsForBorrower(id);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) { wrapErr(res, err); }
});

router.post('/borrower/:borrowerId/other', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const userId = req.user && req.user.id;
    const row = await bs.createAssetLiabRow(id, req.body || {}, userId);
    res.status(201).json({ success: true, data: row });
  } catch (err) { wrapErr(res, err); }
});

router.put('/other/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const row = await bs.updateAssetLiabRow(id, req.body || {});
    if (!row) return res.status(404).json({ success: false, error: 'Row not found' });
    res.json({ success: true, data: row });
  } catch (err) { wrapErr(res, err); }
});

router.delete('/other/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const r = await bs.softDeleteAssetLiabRow(id);
    if (!r) return res.status(404).json({ success: false, error: 'Row not found' });
    res.json({ success: true, data: r });
  } catch (err) { wrapErr(res, err); }
});

// ─────────────────────────────────────────────────
// Roll-up
// ─────────────────────────────────────────────────
router.get('/borrower/:borrowerId/net-worth', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const data = await bs.getNetWorthForBorrower(id);
    res.json({ success: true, data });
  } catch (err) { wrapErr(res, err); }
});

router.get('/deal/:dealId/all', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const [portfolio, other] = await Promise.all([
      bs.listPortfolioForDeal(dealId),
      bs.listAssetsLiabsForDeal(dealId)
    ]);
    res.json({
      success: true,
      data: {
        portfolio_properties: portfolio,
        other_assets_liabilities: other
      }
    });
  } catch (err) { wrapErr(res, err); }
});

module.exports = router;
