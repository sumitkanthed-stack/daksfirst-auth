/**
 * routes/directorships.js — Sprint 3 #18 (2026-04-28)
 *                          Sprint 5 #23/#24 (2026-04-28) — officer-id linking
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
 *
 * Sprint 5 #23/#24:
 *   POST   /corporate/:borrowerId/auto-link  — retro link officer_ids for child UBOs
 *   GET    /officer-search?q=&dob_year=&dob_month=  — manual CH officer search
 *   PUT    /borrower/:borrowerId/officer-id   — write picked officer_id { officer_id }
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const directorships = require('../services/directorships');
const companiesHouse = require('../services/companies-house');
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

// ════════════════════════════════════════════════════════════
// Sprint 5 #23 — Path A: retroactive auto-link from a corporate
// ════════════════════════════════════════════════════════════

/**
 * POST /api/admin/directorships/corporate/:borrowerId/auto-link
 *
 * Pulls officers from CH for the corporate borrower and writes
 * officer_id into ch_match_data on each child UBO it can match
 * by name (+ DoB if available). Returns a report:
 *   { linked: [...], unmatched: [...], skipped: [...] }
 *
 * Use when: a corporate was verified before Sprint 5 shipped,
 * or when CH officer list has changed since last verify.
 */
router.post('/corporate/:borrowerId/auto-link', async (req, res) => {
  try {
    const corpId = parseId(req.params.borrowerId);
    if (!corpId) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });

    // Resolve corporate's company_number
    const r = await pool.query(
      `SELECT id, full_name, company_number, is_corporate, ch_match_data
         FROM deal_borrowers WHERE id = $1`,
      [corpId]
    );
    const corp = r.rows[0];
    if (!corp) return res.status(404).json({ success: false, error: 'Corporate borrower not found' });
    if (corp.is_corporate === false) {
      return res.status(400).json({ success: false, error: 'Borrower is not a corporate — auto-link only works on corporate parents' });
    }
    const companyNumber = corp.company_number
      || (corp.ch_match_data && (corp.ch_match_data.company_number || corp.ch_match_data.ch_company_number))
      || null;
    if (!companyNumber) {
      return res.status(400).json({ success: false, error: 'Corporate borrower has no company_number — verify at CH first' });
    }

    const result = await companiesHouse.linkOfficersToBorrowers(pool, corpId, companyNumber);
    res.json({ success: true, data: result });
  } catch (err) { wrapErr(res, err); }
});

// ════════════════════════════════════════════════════════════
// Sprint 5 #24 — Path B: manual officer search + pick
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/directorships/officer-search?q=name&dob_year=YYYY&dob_month=M&limit=25
 *
 * Proxies CH /search/officers and applies optional DoB filter.
 * Returns: [{ officer_id, title, description, address_snippet,
 *             appointment_count, date_of_birth, ... }]
 */
router.get('/officer-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'Query "q" must be at least 2 chars' });
    }
    const dobYear = req.query.dob_year ? parseInt(req.query.dob_year, 10) : null;
    const dobMonth = req.query.dob_month ? parseInt(req.query.dob_month, 10) : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 25;

    const rows = await companiesHouse.searchOfficers(q, { dobYear, dobMonth }, limit);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) { wrapErr(res, err); }
});

/**
 * PUT /api/admin/directorships/borrower/:borrowerId/officer-id
 *
 * Writes the supplied officer_id into deal_borrowers.ch_match_data.
 * Used when an admin manually picks the right CH officer record
 * via the Find at CH search modal. Body: { officer_id, ch_name? }
 */
router.put('/borrower/:borrowerId/officer-id', async (req, res) => {
  try {
    const id = parseId(req.params.borrowerId);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid borrowerId' });
    const officerId = req.body && String(req.body.officer_id || '').trim();
    if (!officerId) return res.status(400).json({ success: false, error: 'officer_id required in body' });

    const userId = req.user && req.user.id;
    const patch = {
      officer_id: officerId,
      ch_officer_id: officerId,
      ch_officer_linked_at: new Date().toISOString(),
      ch_officer_link_source: 'manual_pick',
      ch_officer_picked_by: userId || null,
      ch_officer_picked_name: req.body.ch_name || null
    };
    const r = await pool.query(
      `UPDATE deal_borrowers
          SET ch_match_data = COALESCE(ch_match_data, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
        RETURNING id, full_name, ch_match_data`,
      [JSON.stringify(patch), id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Borrower not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { wrapErr(res, err); }
});

module.exports = router;
