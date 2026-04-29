/**
 * routes/kyc.js — SmartSearch KYC/AML admin endpoints + monitoring webhook
 * ============================================================
 * Sumit's directives (2026-04-27):
 *   Q1: Manual fired only by Admin — strict admin gate, NOT internal
 *   Q2: One-by-one + batch sweep for directors of a corporate borrower
 *   Q3: Monitoring is admin-pick (NOT auto-enrol)
 *
 * EXPORTS TWO ROUTERS:
 *   adminRouter   — mount at /api/admin/kyc       (auth + admin gated)
 *   webhookRouter — mount at /api/webhooks/smartsearch (HMAC verified, public)
 *
 * Every call writes a fresh kyc_checks row — success OR failure — for audit.
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const ss = require('../services/smartsearch');
const consent = require('../services/consent');

// CONS-3 (2026-04-29): consent gate helper for individual_kyc + sanctions_pep.
// Mock mode bypasses the gate. Business KYB doesn't need consent — public data.
async function requireConsent(borrowerId, consentType, mode) {
  if (mode === 'mock') return null;
  const row = await consent.hasValidConsent(borrowerId, consentType);
  if (!row) {
    return {
      status: 403,
      body: {
        error: `Consent gate: no valid consent for borrower ${borrowerId} on ${consentType}. Capture consent first via broker attestation or email-link.`,
        consent_type_required: consentType,
        consent_paths: ['broker_attestation', 'email_link_token'],
      },
    };
  }
  return null;
}
const pool = require('../db/pool');

// ============================================================
//  Helpers
// ============================================================

/**
 * Pragmatic split of a UK-style full_name into first + last.
 * "JANE DOE" → { first: "JANE", last: "DOE" }
 * "MARIE-CLAIRE VAN DER BERG" → { first: "MARIE-CLAIRE", last: "VAN DER BERG" }
 * Single-token names get last="" — caller should validate before sending live.
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
 * Persist a kyc_checks row from a SmartSearch result.
 * @param {object} args
 * @param {object} args.result  - The standard service shape from runX()
 * @param {string} args.checkType  - 'individual_kyc' | 'business_kyb' | 'sanctions_pep' | 'ongoing_monitoring'
 * @param {object} args.refs    - { deal_id, borrower_id, director_id, individual_id, company_id, parent_check_id, requested_by }
 * @returns {Promise<number>}   - inserted row id
 */
async function persistCheck({ result, checkType, refs = {} }) {
  const flat = result.success ? ss.extractFlatFields(result.data, checkType) : {};
  const r = await pool.query(
    `INSERT INTO kyc_checks (
       deal_id, borrower_id, director_id, individual_id, company_id,
       check_type, provider,
       subject_first_name, subject_last_name, subject_dob, subject_address_jsonb,
       subject_company_number, subject_company_name,
       result_status, result_score, result_summary_jsonb, result_raw_jsonb,
       sanctions_hits_jsonb, pep_hits_jsonb, rca_hits_jsonb, sip_hits_jsonb, adverse_media_jsonb,
       mode, cost_pence, requested_by, parent_check_id, is_monitoring_update, pull_error
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17::jsonb,
       $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26,$27,$28
     ) RETURNING id`,
    [
      refs.deal_id || null,
      refs.borrower_id || null,
      refs.director_id || null,
      refs.individual_id || null,
      refs.company_id || null,
      checkType,
      'smartsearch',
      flat.subject_first_name || null,
      flat.subject_last_name || null,
      flat.subject_dob || null,
      flat.subject_address_jsonb ? JSON.stringify(flat.subject_address_jsonb) : null,
      flat.subject_company_number || null,
      flat.subject_company_name || null,
      flat.result_status || (result.success ? null : 'error'),
      flat.result_score,
      flat.result_summary_jsonb ? JSON.stringify(flat.result_summary_jsonb) : null,
      flat.result_raw_jsonb ? JSON.stringify(flat.result_raw_jsonb) : null,
      flat.sanctions_hits_jsonb ? JSON.stringify(flat.sanctions_hits_jsonb) : null,
      flat.pep_hits_jsonb ? JSON.stringify(flat.pep_hits_jsonb) : null,
      flat.rca_hits_jsonb ? JSON.stringify(flat.rca_hits_jsonb) : null,
      flat.sip_hits_jsonb ? JSON.stringify(flat.sip_hits_jsonb) : null,
      flat.adverse_media_jsonb ? JSON.stringify(flat.adverse_media_jsonb) : null,
      result.mode,
      result.cost_pence || 0,
      refs.requested_by || null,
      refs.parent_check_id || null,
      !!refs.is_monitoring_update,
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
    res.json({ success: true, ...ss.getStatus() });
  } catch (err) {
    console.error('[kyc/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Individual KYC (per borrower) ────────────────────────────────────────────
adminRouter.post('/individual/:borrowerId', async (req, res) => {
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
    // Allow body overrides — admin may know the verified spelling better than the matrix
    const { first: fnFromName, last: lnFromName } = splitName(b.full_name);
    const firstName = (req.body && req.body.firstName) || fnFromName;
    const lastName  = (req.body && req.body.lastName)  || lnFromName;
    const dob       = (req.body && req.body.dob)       || (b.date_of_birth ? b.date_of_birth.toISOString().slice(0, 10) : null);
    const address   = (req.body && req.body.address)   || b.address;

    // CONS-3 consent gate
    const status = ss.getStatus();
    const block = await requireConsent(b.id, 'kyc_smartsearch', status.mode);
    if (block) return res.status(block.status).json(block.body);

    const result = await ss.runIndividualKyc({ firstName, lastName, dob, address });
    const checkId = await persistCheck({
      result, checkType: 'individual_kyc',
      refs: {
        deal_id: b.deal_id,
        borrower_id: b.id,
        director_id: b.parent_borrower_id ? b.id : null,
        requested_by: req.user.id || null,
      },
    });
    res.status(result.success ? 200 : 502).json({ ...result, kyc_check_id: checkId });
  } catch (err) {
    console.error('[kyc/individual] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Business KYB (per corporate borrower) ────────────────────────────────────
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

    const result = await ss.runBusinessKyb({ companyNumber, companyName });
    const checkId = await persistCheck({
      result, checkType: 'business_kyb',
      refs: { deal_id: b.deal_id, borrower_id: b.id, company_id: b.id, requested_by: req.user.id || null },
    });
    res.status(result.success ? 200 : 502).json({ ...result, kyc_check_id: checkId });
  } catch (err) {
    console.error('[kyc/business] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sanctions/PEP screening (per individual) ─────────────────────────────────
adminRouter.post('/sanctions/:borrowerId', async (req, res) => {
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

    // CONS-3 consent gate (sanctions_pep falls under kyc_smartsearch consent)
    const status = ss.getStatus();
    const block = await requireConsent(b.id, 'kyc_smartsearch', status.mode);
    if (block) return res.status(block.status).json(block.body);

    const result = await ss.runSanctionsPep({ firstName, lastName, dob, address });
    const checkId = await persistCheck({
      result, checkType: 'sanctions_pep',
      refs: {
        deal_id: b.deal_id,
        borrower_id: b.id,
        director_id: b.parent_borrower_id ? b.id : null,
        requested_by: req.user.id || null,
      },
    });
    res.status(result.success ? 200 : 502).json({ ...result, kyc_check_id: checkId });
  } catch (err) {
    console.error('[kyc/sanctions] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sweep (Q2 batch — all directors of a corporate borrower) ─────────────────
adminRouter.post('/sweep/:borrowerId', async (req, res) => {
  const { borrowerId } = req.params;
  if (!/^\d+$/.test(borrowerId)) {
    return res.status(400).json({ error: 'valid numeric corporate borrowerId required' });
  }
  // Optional flags — default = run KYC + sanctions on every director, KYB on parent
  const includeKyb        = req.body?.includeKyb !== false;          // default true
  const includeIndividual = req.body?.includeIndividual !== false;   // default true
  const includeSanctions  = req.body?.includeSanctions !== false;    // default true

  try {
    const parentLookup = await pool.query(
      `SELECT id, deal_id, company_name, company_number, borrower_type
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

    const summary = { parent_borrower_id: parent.id, deal_id: parent.deal_id, kyb: null, directors: [] };

    // 1. KYB on the parent corporate
    if (includeKyb && (parent.company_number || parent.company_name)) {
      const kybResult = await ss.runBusinessKyb({
        companyNumber: parent.company_number, companyName: parent.company_name,
      });
      const id = await persistCheck({
        result: kybResult, checkType: 'business_kyb',
        refs: { deal_id: parent.deal_id, borrower_id: parent.id, company_id: parent.id, requested_by: req.user.id || null },
      });
      summary.kyb = { kyc_check_id: id, status: kybResult.success ? kybResult.data?.result_status : 'error', cost_pence: kybResult.cost_pence };
    }

    // 2. Individual KYC + sanctions on each director
    for (const d of directors.rows) {
      const { first, last } = splitName(d.full_name);
      const dob = d.date_of_birth ? d.date_of_birth.toISOString().slice(0, 10) : null;
      const dirSummary = { director_id: d.id, full_name: d.full_name, individual: null, sanctions: null };

      if (includeIndividual) {
        const r = await ss.runIndividualKyc({ firstName: first, lastName: last, dob, address: d.address });
        const id = await persistCheck({
          result: r, checkType: 'individual_kyc',
          refs: { deal_id: parent.deal_id, borrower_id: parent.id, director_id: d.id, requested_by: req.user.id || null },
        });
        dirSummary.individual = { kyc_check_id: id, status: r.success ? r.data?.result_status : 'error', cost_pence: r.cost_pence };
      }
      if (includeSanctions) {
        const r = await ss.runSanctionsPep({ firstName: first, lastName: last, dob, address: d.address });
        const id = await persistCheck({
          result: r, checkType: 'sanctions_pep',
          refs: { deal_id: parent.deal_id, borrower_id: parent.id, director_id: d.id, requested_by: req.user.id || null },
        });
        dirSummary.sanctions = { kyc_check_id: id, status: r.success ? r.data?.result_status : 'error', cost_pence: r.cost_pence };
      }
      summary.directors.push(dirSummary);
    }

    res.json({ success: true, summary });
  } catch (err) {
    console.error('[kyc/sweep] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Enrol monitoring (Q3 admin-pick on a passed check) ───────────────────────
adminRouter.post('/monitor/:checkId', async (req, res) => {
  const { checkId } = req.params;
  if (!/^\d+$/.test(checkId)) {
    return res.status(400).json({ error: 'valid numeric checkId required' });
  }
  try {
    const lookup = await pool.query(
      `SELECT id, deal_id, borrower_id, director_id, individual_id, company_id,
              check_type, result_status, result_raw_jsonb
         FROM kyc_checks WHERE id = $1`,
      [parseInt(checkId, 10)]
    );
    if (lookup.rowCount === 0) {
      return res.status(404).json({ error: `Check ${checkId} not found` });
    }
    const parent = lookup.rows[0];
    if (parent.result_status !== 'pass') {
      return res.status(400).json({ error: `Cannot monitor check ${checkId}: status is ${parent.result_status} (need 'pass')` });
    }
    const vendorReference = parent.result_raw_jsonb?.vendor_reference || parent.result_raw_jsonb?.id || `daksfirst-${parent.id}`;

    const result = await ss.enrolMonitoring({ checkId: parent.id, vendorReference, frequency: req.body?.frequency || 'daily' });
    const newId = await persistCheck({
      result, checkType: 'ongoing_monitoring',
      refs: {
        deal_id: parent.deal_id,
        borrower_id: parent.borrower_id,
        director_id: parent.director_id,
        individual_id: parent.individual_id,
        company_id: parent.company_id,
        parent_check_id: parent.id,
        requested_by: req.user.id || null,
      },
    });
    res.status(result.success ? 200 : 502).json({ ...result, kyc_check_id: newId, parent_check_id: parent.id });
  } catch (err) {
    console.error('[kyc/monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── List checks (for a deal) ─────────────────────────────────────────────────
adminRouter.get('/checks', async (req, res) => {
  const { dealId, borrowerId, checkType } = req.query;
  const where = [];
  const params = [];
  if (dealId)     { params.push(parseInt(dealId, 10));     where.push(`deal_id     = $${params.length}`); }
  if (borrowerId) { params.push(parseInt(borrowerId, 10)); where.push(`borrower_id = $${params.length}`); }
  if (checkType)  { params.push(checkType);                where.push(`check_type  = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const r = await pool.query(
      `SELECT id, deal_id, borrower_id, director_id, company_id, check_type, provider,
              subject_first_name, subject_last_name, subject_company_name,
              result_status, result_score, mode, cost_pence,
              requested_by, requested_at, parent_check_id, is_monitoring_update, pull_error
         FROM kyc_checks ${whereSql}
        ORDER BY requested_at DESC
        LIMIT 200`,
      params
    );
    res.json({ success: true, count: r.rowCount, checks: r.rows });
  } catch (err) {
    console.error('[kyc/checks] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Single check detail (full raw) ───────────────────────────────────────────
adminRouter.get('/check/:checkId', async (req, res) => {
  const { checkId } = req.params;
  if (!/^\d+$/.test(checkId)) {
    return res.status(400).json({ error: 'valid numeric checkId required' });
  }
  try {
    const r = await pool.query(`SELECT * FROM kyc_checks WHERE id = $1`, [parseInt(checkId, 10)]);
    if (r.rowCount === 0) {
      return res.status(404).json({ error: `Check ${checkId} not found` });
    }
    res.json({ success: true, check: r.rows[0] });
  } catch (err) {
    console.error('[kyc/check] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WEBHOOK ROUTER (HMAC-verified, NOT admin-gated)
// ============================================================
//  Mount at /api/webhooks/smartsearch.
//  REQUIRES: server.js's express.json() must capture rawBody via verify callback:
//      app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }))
//  Otherwise HMAC verification will fail (req.rawBody undefined).
// ============================================================
const webhookRouter = express.Router();

webhookRouter.post('/', async (req, res) => {
  const sig = req.headers['x-smartsearch-signature'] || req.headers['x-signature'] || '';
  if (!req.rawBody) {
    console.error('[smartsearch-webhook] req.rawBody missing — server.js needs verify callback on express.json');
    return res.status(500).json({ error: 'server misconfigured: rawBody missing' });
  }
  if (!ss.verifyWebhookSignature(req.rawBody, sig)) {
    console.warn('[smartsearch-webhook] HMAC mismatch — rejecting');
    return res.status(401).json({ error: 'invalid signature' });
  }
  // Body shape (assumed — confirm with vendor docs once SS-A1 done):
  //   { vendor_reference, parent_check_reference, status, score,
  //     sanctions_hits, pep_hits, ..., raw }
  const body = req.body || {};
  try {
    // Find the parent check by vendor reference if the original was stamped
    let parentCheckId = null;
    if (body.parent_check_reference) {
      const lookup = await pool.query(
        `SELECT id FROM kyc_checks
          WHERE result_raw_jsonb->>'vendor_reference' = $1
             OR result_raw_jsonb->>'id' = $1
          ORDER BY requested_at DESC LIMIT 1`,
        [String(body.parent_check_reference)]
      );
      if (lookup.rowCount > 0) parentCheckId = lookup.rows[0].id;
    }
    // Compose a synthetic "result" so we can reuse persistCheck()
    const synthetic = {
      success: true, error: null, status: 200, mode: 'live', cost_pence: 0,
      data: {
        check_type: 'ongoing_monitoring',
        result_status: body.status || 'refer',
        result_score: typeof body.score === 'number' ? body.score : null,
        subject: body.subject || {},
        sanctions_hits: body.sanctions_hits || [],
        pep_hits: body.pep_hits || [],
        rca_hits: body.rca_hits || [],
        sip_hits: body.sip_hits || [],
        adverse_media: body.adverse_media || [],
        summary: body.summary || null,
      },
      raw: body,
    };
    const refs = { parent_check_id: parentCheckId, is_monitoring_update: true };
    if (parentCheckId) {
      const p = await pool.query(
        `SELECT deal_id, borrower_id, director_id, individual_id, company_id FROM kyc_checks WHERE id = $1`,
        [parentCheckId]
      );
      if (p.rowCount > 0) Object.assign(refs, p.rows[0]);
    }
    const id = await persistCheck({ result: synthetic, checkType: 'ongoing_monitoring', refs });
    console.log(`[smartsearch-webhook] ✓ monitoring update ${id} (parent=${parentCheckId || '?'}, status=${synthetic.data.result_status})`);
    res.json({ ok: true, kyc_check_id: id });
  } catch (err) {
    console.error('[smartsearch-webhook] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { adminRouter, webhookRouter };
