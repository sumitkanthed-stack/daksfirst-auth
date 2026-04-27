/**
 * routes/credit.js — Experian credit bureau admin endpoints
 * ============================================================
 * Architecture: auth = data collector ONLY. NO scoring or decision logic here.
 * Mirrors routes/kyc.js shape: admin-only, append-only credit_checks history,
 * one row per call success-or-fail for full audit trail.
 *
 * Sumit's directives (2026-04-27):
 *   • Manual fired only by Admin — strict admin gate
 *   • Per-borrower one-shot + sweep cascading to all directors of a corporate
 *   • All 3 products bound to the same UK app: BI Risk Scores (Commercial Delphi),
 *     Delphi Select (Personal Credit), Hunter (Fraud — mock until B2B account opens)
 *   • vendor column on credit_checks defaults to 'experian' — keeps door open
 *     for Equifax/CRIF as Phase C add-ons without a schema change.
 *
 * EXPORTS ONE ROUTER:
 *   adminRouter — mount at /api/admin/credit  (auth + admin gated)
 *
 * No webhook router — Experian one-shot pulls return synchronously.
 * Hunter monitoring (separate stream) is gated B2B and not in scope this sprint.
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const exp = require('../services/experian');
const pool = require('../db/pool');

// ============================================================
//  Helpers
// ============================================================

/**
 * Pragmatic split of a UK-style full_name into first + last.
 * Matches routes/kyc.js splitName() — keep behaviour identical so SmartSearch
 * + Experian rows in the same deal show the same subject_first_name/last_name.
 */
function splitName(fullName) {
  if (!fullName || typeof fullName !== 'string') return { first: null, last: null };
  const trimmed = fullName.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { first: null, last: null };
  const parts = trimmed.split(' ');
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Persist a credit_checks row from an Experian service result.
 *
 * @param {object}  args
 * @param {object}  args.result   — standard service shape from runX():
 *                                  { success, mode, cost_pence, data, error, raw, status }
 * @param {string}  args.product  — 'commercial_delphi' | 'personal_credit' | 'hunter_fraud'
 * @param {object}  args.refs     — { deal_id, borrower_id, director_id, company_id,
 *                                   parent_check_id, requested_by }
 * @returns {Promise<number>}     — inserted row id
 */
async function persistCheck({ result, product, refs = {} }) {
  const flat = result.success ? exp.extractFlatFields(result.data, product) : {};

  const r = await pool.query(
    `INSERT INTO credit_checks (
       deal_id, borrower_id, director_id, company_id,
       product, vendor,
       subject_first_name, subject_last_name, subject_dob, subject_address_jsonb,
       subject_company_number, subject_company_name,
       result_status, result_grade, credit_score, recommended_limit_pence,
       result_summary_jsonb, result_raw_jsonb,
       ccj_count, ccj_value_pence, ccj_jsonb,
       bankruptcy_flag, iva_flag,
       default_count, default_value_pence,
       electoral_roll_jsonb, gone_away_flag,
       payment_behaviour_jsonb, gazette_jsonb,
       fraud_markers_jsonb, hunter_match_count,
       adverse_jsonb,
       mode, cost_pence, requested_by, parent_check_id, pull_error
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,
       $13,$14,$15,$16,$17::jsonb,$18::jsonb,
       $19,$20,$21::jsonb,$22,$23,$24,$25,
       $26::jsonb,$27,$28::jsonb,$29::jsonb,$30::jsonb,$31,
       $32::jsonb,$33,$34,$35,$36,$37
     ) RETURNING id`,
    [
      refs.deal_id || null,
      refs.borrower_id || null,
      refs.director_id || null,
      refs.company_id || null,
      product,
      'experian',
      flat.subject_first_name || null,
      flat.subject_last_name || null,
      flat.subject_dob || null,
      flat.subject_address_jsonb ? JSON.stringify(flat.subject_address_jsonb) : null,
      flat.subject_company_number || null,
      flat.subject_company_name || null,
      flat.result_status || (result.success ? null : 'error'),
      flat.result_grade || null,
      flat.credit_score ?? null,
      flat.recommended_limit_pence ?? null,
      flat.result_summary_jsonb ? JSON.stringify(flat.result_summary_jsonb) : null,
      flat.result_raw_jsonb ? JSON.stringify(flat.result_raw_jsonb) : (result.raw ? JSON.stringify(result.raw) : null),
      flat.ccj_count ?? null,
      flat.ccj_value_pence ?? null,
      flat.ccj_jsonb ? JSON.stringify(flat.ccj_jsonb) : null,
      flat.bankruptcy_flag ?? null,
      flat.iva_flag ?? null,
      flat.default_count ?? null,
      flat.default_value_pence ?? null,
      flat.electoral_roll_jsonb ? JSON.stringify(flat.electoral_roll_jsonb) : null,
      flat.gone_away_flag ?? null,
      flat.payment_behaviour_jsonb ? JSON.stringify(flat.payment_behaviour_jsonb) : null,
      flat.gazette_jsonb ? JSON.stringify(flat.gazette_jsonb) : null,
      flat.fraud_markers_jsonb ? JSON.stringify(flat.fraud_markers_jsonb) : null,
      flat.hunter_match_count ?? null,
      flat.adverse_jsonb ? JSON.stringify(flat.adverse_jsonb) : null,
      result.mode,
      result.cost_pence || 0,
      refs.requested_by || null,
      refs.parent_check_id || null,
      result.success ? null : (result.error || 'Unknown error'),
    ]
  );
  return r.rows[0].id;
}

// ============================================================
//  ADMIN ROUTER
// ============================================================
const adminRouter = express.Router();
adminRouter.use(authenticateToken);
adminRouter.use(authenticateAdmin);

// ─── Status (no network) ──────────────────────────────────────────────────────
adminRouter.get('/status', async (req, res) => {
  try {
    res.json({ success: true, ...exp.getStatus() });
  } catch (err) {
    console.error('[credit/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Personal credit (Delphi Select) per individual borrower/director ─────────
adminRouter.post('/personal/:borrowerId', async (req, res) => {
  const { borrowerId } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric borrowerId required' });
  }
  try {
    const lookup = await pool.query(
      `SELECT id, deal_id, full_name, date_of_birth, address, parent_borrower_id, borrower_type
         FROM deal_borrowers WHERE id = $1`,
      [parseInt(borrowerId, 10)]
    );
    if (lookup.rowCount === 0) {
      return res.status(404).json({ error: `Borrower ${borrowerId} not found` });
    }
    const b = lookup.rows[0];
    const { first: fnFromName, last: lnFromName } = splitName(b.full_name);
    const firstName = (req.body && req.body.firstName) || fnFromName;
    const lastName  = (req.body && req.body.lastName)  || lnFromName;
    const dob       = (req.body && req.body.dob)       || (b.date_of_birth ? b.date_of_birth.toISOString().slice(0, 10) : null);
    const address   = (req.body && req.body.address)   || b.address;

    if (!firstName || !lastName || !dob) {
      return res.status(400).json({
        error: 'Personal credit search requires firstName, lastName, dob — provide in request body or backfill on borrower record',
      });
    }

    const result = await exp.runPersonalCredit({ firstName, lastName, dob, address });
    const checkId = await persistCheck({
      result, product: 'personal_credit',
      refs: {
        deal_id: b.deal_id,
        borrower_id: b.id,
        director_id: b.parent_borrower_id ? b.id : null,
        requested_by: req.user.id || null,
      },
    });
    res.status(result.success ? 200 : 502).json({ ...result, credit_check_id: checkId });
  } catch (err) {
    console.error('[credit/personal] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Commercial Delphi (BI Risk Scores) per corporate borrower ────────────────
adminRouter.post('/business/:borrowerId', async (req, res) => {
  const { borrowerId } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric borrowerId required' });
  }
  try {
    const lookup = await pool.query(
      `SELECT id, deal_id, company_name, company_number, borrower_type
         FROM deal_borrowers WHERE id = $1`,
      [parseInt(borrowerId, 10)]
    );
    if (lookup.rowCount === 0) {
      return res.status(404).json({ error: `Borrower ${borrowerId} not found` });
    }
    const b = lookup.rows[0];
    if (b.borrower_type !== 'corporate' && !b.company_number && !b.company_name) {
      return res.status(400).json({ error: `Borrower ${borrowerId} is not a corporate entity` });
    }
    const companyNumber = (req.body && req.body.companyNumber) || b.company_number;
    const companyName   = (req.body && req.body.companyName)   || b.company_name;

    if (!companyNumber && !companyName) {
      return res.status(400).json({ error: 'Commercial Delphi requires companyNumber or companyName' });
    }

    const result = await exp.runCommercialDelphi({ companyNumber, companyName });
    const checkId = await persistCheck({
      result, product: 'commercial_delphi',
      refs: { deal_id: b.deal_id, borrower_id: b.id, company_id: b.id, requested_by: req.user.id || null },
    });
    res.status(result.success ? 200 : 502).json({ ...result, credit_check_id: checkId });
  } catch (err) {
    console.error('[credit/business] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Hunter Fraud / CIFAS per individual ──────────────────────────────────────
//  NB: Live mode requires CIFAS consortium membership (EXP-A1 callback).
//  Until then, mock mode returns a clean fixture.
adminRouter.post('/hunter/:borrowerId', async (req, res) => {
  const { borrowerId } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric borrowerId required' });
  }
  try {
    const lookup = await pool.query(
      `SELECT id, deal_id, full_name, date_of_birth, address, parent_borrower_id
         FROM deal_borrowers WHERE id = $1`,
      [parseInt(borrowerId, 10)]
    );
    if (lookup.rowCount === 0) {
      return res.status(404).json({ error: `Borrower ${borrowerId} not found` });
    }
    const b = lookup.rows[0];
    const { first: fnFromName, last: lnFromName } = splitName(b.full_name);
    const firstName = (req.body && req.body.firstName) || fnFromName;
    const lastName  = (req.body && req.body.lastName)  || lnFromName;
    const dob       = (req.body && req.body.dob)       || (b.date_of_birth ? b.date_of_birth.toISOString().slice(0, 10) : null);
    const address   = (req.body && req.body.address)   || b.address;

    const result = await exp.runHunterFraud({ firstName, lastName, dob, address });
    const checkId = await persistCheck({
      result, product: 'hunter_fraud',
      refs: {
        deal_id: b.deal_id,
        borrower_id: b.id,
        director_id: b.parent_borrower_id ? b.id : null,
        requested_by: req.user.id || null,
      },
    });
    res.status(result.success ? 200 : 502).json({ ...result, credit_check_id: checkId });
  } catch (err) {
    console.error('[credit/hunter] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sweep — full credit pull on parent corporate + every director ────────────
adminRouter.post('/sweep/:borrowerId', async (req, res) => {
  const { borrowerId } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric corporate borrowerId required' });
  }
  // Optional flags — default = run business on parent + personal+hunter on every director
  const includeBusiness = req.body?.includeBusiness !== false;     // default true
  const includePersonal = req.body?.includePersonal !== false;     // default true
  const includeHunter   = req.body?.includeHunter   !== false;     // default true

  try {
    const parentLookup = await pool.query(
      `SELECT id, deal_id, full_name, company_name, company_number, borrower_type,
              date_of_birth, address, parent_borrower_id
         FROM deal_borrowers WHERE id = $1`,
      [parseInt(borrowerId, 10)]
    );
    if (parentLookup.rowCount === 0) {
      return res.status(404).json({ error: `Borrower ${borrowerId} not found` });
    }
    const parent = parentLookup.rows[0];

    const directors = await pool.query(
      `SELECT id, full_name, date_of_birth, address
         FROM deal_borrowers
        WHERE parent_borrower_id = $1
        ORDER BY id`,
      [parent.id]
    );

    const summary = {
      parent_borrower_id: parent.id,
      deal_id: parent.deal_id,
      business: null,
      directors: [],
      total_cost_pence: 0,
    };

    // 1. Commercial Delphi on the parent corporate
    if (includeBusiness && (parent.company_number || parent.company_name)) {
      const r = await exp.runCommercialDelphi({
        companyNumber: parent.company_number, companyName: parent.company_name,
      });
      const id = await persistCheck({
        result: r, product: 'commercial_delphi',
        refs: { deal_id: parent.deal_id, borrower_id: parent.id, company_id: parent.id, requested_by: req.user.id || null },
      });
      summary.business = {
        credit_check_id: id,
        status: r.success ? r.data?.result_status : 'error',
        grade: r.success ? r.data?.result_grade : null,
        score: r.success ? r.data?.credit_score : null,
        cost_pence: r.cost_pence,
      };
      summary.total_cost_pence += (r.cost_pence || 0);
    }

    // 2. Personal credit + Hunter fraud on each director
    for (const d of directors.rows) {
      const { first, last } = splitName(d.full_name);
      const dob = d.date_of_birth ? d.date_of_birth.toISOString().slice(0, 10) : null;
      const dirSummary = { director_id: d.id, full_name: d.full_name, personal: null, hunter: null };

      if (includePersonal && first && last && dob) {
        const r = await exp.runPersonalCredit({ firstName: first, lastName: last, dob, address: d.address });
        const id = await persistCheck({
          result: r, product: 'personal_credit',
          refs: { deal_id: parent.deal_id, borrower_id: parent.id, director_id: d.id, requested_by: req.user.id || null },
        });
        dirSummary.personal = {
          credit_check_id: id,
          status: r.success ? r.data?.result_status : 'error',
          grade: r.success ? r.data?.result_grade : null,
          score: r.success ? r.data?.credit_score : null,
          ccj_count: r.success ? r.data?.ccj_count : null,
          cost_pence: r.cost_pence,
        };
        summary.total_cost_pence += (r.cost_pence || 0);
      } else if (includePersonal) {
        dirSummary.personal = { skipped: true, reason: 'missing firstName/lastName/dob on director record' };
      }

      if (includeHunter) {
        const r = await exp.runHunterFraud({ firstName: first, lastName: last, dob, address: d.address });
        const id = await persistCheck({
          result: r, product: 'hunter_fraud',
          refs: { deal_id: parent.deal_id, borrower_id: parent.id, director_id: d.id, requested_by: req.user.id || null },
        });
        dirSummary.hunter = {
          credit_check_id: id,
          status: r.success ? r.data?.result_status : 'error',
          hunter_match_count: r.success ? r.data?.hunter_match_count : null,
          cost_pence: r.cost_pence,
        };
        summary.total_cost_pence += (r.cost_pence || 0);
      }

      summary.directors.push(dirSummary);
    }

    res.json({ success: true, summary });
  } catch (err) {
    console.error('[credit/sweep] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── List checks (filter by deal/borrower/product) ────────────────────────────
adminRouter.get('/checks', async (req, res) => {
  const { dealId, borrowerId, product } = req.query;
  const where = [];
  const params = [];
  if (dealId)     { params.push(parseInt(dealId, 10));     where.push(`deal_id     = $${params.length}`); }
  if (borrowerId) { params.push(parseInt(borrowerId, 10)); where.push(`borrower_id = $${params.length}`); }
  if (product)    { params.push(product);                  where.push(`product     = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const r = await pool.query(
      `SELECT id, deal_id, borrower_id, director_id, company_id,
              product, vendor,
              subject_first_name, subject_last_name, subject_company_name,
              result_status, result_grade, credit_score, recommended_limit_pence,
              ccj_count, ccj_value_pence, bankruptcy_flag, iva_flag,
              default_count, default_value_pence, gone_away_flag,
              hunter_match_count,
              mode, cost_pence,
              requested_by, requested_at, parent_check_id, pull_error
         FROM credit_checks ${whereSql}
        ORDER BY requested_at DESC
        LIMIT 200`,
      params
    );
    res.json({ success: true, count: r.rowCount, checks: r.rows });
  } catch (err) {
    console.error('[credit/checks] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Single check detail (full raw incl. JSONB) ───────────────────────────────
adminRouter.get('/check/:checkId', async (req, res) => {
  const { checkId } = req.params;
  if (!/^\d+$/.test(checkId)) {
    return res.status(400).json({ error: 'valid numeric checkId required' });
  }
  try {
    const r = await pool.query(`SELECT * FROM credit_checks WHERE id = $1`, [parseInt(checkId, 10)]);
    if (r.rowCount === 0) {
      return res.status(404).json({ error: `Check ${checkId} not found` });
    }
    res.json({ success: true, check: r.rows[0] });
  } catch (err) {
    console.error('[credit/check] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Latest check by borrower + product (for inline panel hydration) ──────────
adminRouter.get('/latest/:borrowerId/:product', async (req, res) => {
  const { borrowerId, product } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric borrowerId required' });
  }
  if (!['commercial_delphi', 'personal_credit', 'hunter_fraud'].includes(product)) {
    return res.status(400).json({ error: 'product must be one of commercial_delphi, personal_credit, hunter_fraud' });
  }
  try {
    const r = await pool.query(
      `SELECT * FROM credit_checks
        WHERE borrower_id = $1 AND product = $2
        ORDER BY requested_at DESC
        LIMIT 1`,
      [parseInt(borrowerId, 10), product]
    );
    if (r.rowCount === 0) {
      return res.json({ success: true, check: null });
    }
    res.json({ success: true, check: r.rows[0] });
  } catch (err) {
    console.error('[credit/latest] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { adminRouter };
