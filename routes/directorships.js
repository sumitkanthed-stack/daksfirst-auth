/**
 * routes/directorships.js — Sprint 3 #18 (2026-04-28)
 * ============================================================
 * Admin endpoints for CH "other directorships" KYC enrichment.
 *
 * MOUNT: app.use('/api/admin/directorships', directorshipsRoutes);
 *
 *   GET    /borrower/:borrowerId/summary  — aggregates + troublesome list
 *   GET    /borrower/:borrowerId/all      — full list (for "show all" toggle)
 *   POST   /borrower/:borrowerId/pull     — fire CH appointments fetch
 *                                            body: { ch_officer_id }
 *   GET    /deal/:dealId/summary          — aggregator for the matrix
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const directorships = require('../services/directorships');
const pool = require('../db/pool');

const router = express.Router();
router.use(authenticateToken);
router.use(authenticateAdmin);

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function wrapErr(res, err, fallback = 'Internal error') {
  console.error('[directorships]', err);
  res.status(500).json({ success: false, error: (err && err.message) || fallback });
}

router.get('/borrower/:borrowerId/summary', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const data = await directorships.getSummaryForBorrower(id);
    res.json({ success: true, data });
  } catch (err) { wrapErr(res, err); }
});

router.get('/borrower/:borrowerId/all', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const data = await directorships.getAllForBorrower(id);
    res.json({ success: true, data, count: data.length });
  } catch (err) { wrapErr(res, err); }
});

router.post('/borrower/:borrowerId/pull', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    let officerId = req.body && req.body.ch_officer_id;
    // If not supplied, try to read from deal_borrowers.ch_match_data
    if (!officerId) {
      const r = await pool.query(`SELECT ch_match_data FROM deal_borrowers WHERE id = $1`, [id]);
      const md = r.rows[0] && r.rows[0].ch_match_data;
      officerId = (md && (md.officer_id || md.ch_officer_id)) || null;
    }
    if (!officerId) {
      return res.status(400).json({
        success: false,
        error: 'No ch_officer_id available — verify the corporate borrower at Companies House first, then pull again.'
      });
    }
    const result = await directorships.pullAndStoreForBorrower(id, officerId);
    res.json({ success: true, data: result });
  } catch (err) { wrapErr(res, err); }
});

router.get('/deal/:dealId/summary', async (req, res) => {
  try {
    const dealId = parseId(req.params.dealId);
    if (!dealId) return res.status(400).json({ success: false, error: 'Invalid dealId' });
    const data = await directorships.getSummaryForDeal(dealId);
    res.json({ success: true, data, count: data.length });
  } catch (err) { wrapErr(res, err); }
});

module.exports = router;
