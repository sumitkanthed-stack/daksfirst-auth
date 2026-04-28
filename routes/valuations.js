/**
 * routes/valuations.js — RICS valuation admin endpoints
 * ============================================================
 * Admin-only CRUD on deal_valuations (Pattern B evidence).
 *
 * Sumit's design lock 2026-04-28:
 *   - Append-only — no in-place edits to finalised rows.
 *     Revisions = supersedeWithNew (atomic).
 *   - lending_value_pence is THE LTV anchor; finalisation enforces it.
 *   - 6-month drawdown gate: GET /:dealId/drawdown-check returns
 *     valid rows only.
 *   - Off-panel valuers allowed (soft policy) but flagged in payload
 *     for the rubric to penalise.
 *
 * MOUNT: app.use('/api/admin/valuations', valuationsRoutes);
 *   GET    /:dealId                   — all rows for a deal (audit trail)
 *   GET    /:dealId/active            — active rows (finalised + non-superseded)
 *   GET    /:dealId/drawdown-check    — active AND within 6 months (drawdown gate)
 *   GET    /property/:propertyId/:dealId — active per-property
 *   GET    /single/:id                — one row with valuer JOIN + expiry
 *   POST   /:dealId                   — create draft
 *   PUT    /:id                       — update draft fields
 *   POST   /:id/attach-document       — link deal_documents.id
 *   POST   /:id/finalise              — flip to finalised
 *   POST   /:id/supersede             — atomic supersede + new draft
 *   GET    /schema                    — enum lists + writable cols for UI
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const valuations = require('../services/valuations');

const router = express.Router();
router.use(authenticateToken);
router.use(authenticateAdmin);

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function wrapErr(res, err, fallback = 'Internal error') {
  console.error('[valuations]', err);
  const message = err && err.message ? err.message : fallback;
  // 400 for validation/state errors, 500 otherwise
  const status = /required|invalid|must be|already been|cannot|provide/i.test(message) ? 400 : 500;
  res.status(status).json({ success: false, error: message });
}

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================
// GET /schema — surface enums + writable columns for UI form
// ============================================================
router.get('/schema', (req, res) => {
  res.json({
    success: true,
    data: {
      writable_columns: valuations.WRITABLE_COLUMNS,
      valid_methods: valuations.VALID_METHODS,
      valid_condition: valuations.VALID_CONDITION,
      valid_marketability: valuations.VALID_MARKETABILITY,
      expiry_months: valuations.EXPIRY_MONTHS,
      common_key_risks: [
        'cladding', 'leasehold_short', 'damp', 'subsidence', 'japanese_knotweed',
        'flood_zone', 'contamination', 'mining_subsidence',
        'planning_breach', 'unsold_lease_terms', 'cat_a_only', 'shell_finish',
        'concentration_risk', 'over_supply_local', 'illiquid_market'
      ]
    }
  });
});

// ============================================================
// GET /single/:id — fetch one (with valuer firm name + expiry)
// ============================================================
router.get('/single/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const row = await valuations.getById(id);
    if (!row) return res.status(404).json({ success: false, error: 'Valuation not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// GET /:dealId — all rows for deal (audit trail UI)
// ============================================================
router.get('/:dealId', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const rows = await valuations.listAllForDeal(dealId);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// GET /:dealId/active — finalised + non-superseded (rubric/UI consumes this)
// ============================================================
router.get('/:dealId/active', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const rows = await valuations.listActiveForDeal(dealId);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// GET /:dealId/drawdown-check — drawdown gate (within 6 months)
// ============================================================
router.get('/:dealId/drawdown-check', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const rows = await valuations.listValidForDrawdown(dealId);
    res.json({
      success: true,
      data: rows,
      count: rows.length,
      drawdown_blocked: rows.length === 0,
      reason: rows.length === 0
        ? 'No active valuation within 6 months — drawdown blocked. Re-val required before facility utilisation.'
        : null
    });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// GET /property/:propertyId/:dealId — active per-property
//   (dealId in path so tenant-scoping check is explicit)
// ============================================================
router.get('/property/:propertyId/:dealId', async (req, res) => {
  try {
    const propertyId = parseId(req.params.propertyId);
    const dealId = parseId(req.params.dealId);
    if (!propertyId || !dealId) {
      return res.status(400).json({ success: false, error: 'Invalid propertyId or dealId' });
    }
    const rows = await valuations.listActiveForProperty(dealId, propertyId);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// POST /:dealId — create draft
// ============================================================
router.post('/:dealId', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const userId = req.user && req.user.id;
    const row = await valuations.createDraft(dealId, req.body || {}, userId);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// PUT /:id — update draft (fails on finalised/superseded)
// ============================================================
router.put('/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const userId = req.user && req.user.id;
    const row = await valuations.updateDraft(id, req.body || {}, userId);
    if (!row) return res.status(404).json({ success: false, error: 'Valuation not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// POST /:id/attach-document — link deal_documents.id
// ============================================================
router.post('/:id/attach-document', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const documentId = parseId(req.body && req.body.document_id);
    if (!id || !documentId) {
      return res.status(400).json({ success: false, error: 'Invalid id or document_id' });
    }
    const row = await valuations.attachDocument(id, documentId);
    if (!row) return res.status(404).json({ success: false, error: 'Valuation not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// POST /:id/finalise — flip to finalised (validates essentials)
// ============================================================
router.post('/:id/finalise', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
    const userId = req.user && req.user.id;
    const row = await valuations.finalise(id, userId);
    if (!row) return res.status(404).json({ success: false, error: 'Valuation not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    wrapErr(res, err);
  }
});

// ============================================================
// POST /:id/supersede — atomic supersede + new draft
//   Body = full new valuation data (panel valuer_id or off-panel name + fields)
// ============================================================
router.post('/:id/supersede', async (req, res) => {
  try {
    const oldId = parseId(req.params.id);
    if (!oldId) return res.status(400).json({ success: false, error: 'Invalid id' });
    const userId = req.user && req.user.id;
    const result = await valuations.supersedeWithNew(oldId, req.body || {}, userId);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    wrapErr(res, err);
  }
});

module.exports = router;
