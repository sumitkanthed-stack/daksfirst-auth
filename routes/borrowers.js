const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateInternal } = require('../middleware/auth');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { normalizeBorrowerPayload } = require('../services/matrix-normalizer');

// Helper: check if user owns the deal or is internal staff
async function canEditDeal(req, submissionId) {
  const isInternal = config.INTERNAL_ROLES.includes(req.user.role);
  if (isInternal) return true;
  const result = await pool.query(
    `SELECT 1 FROM deal_submissions WHERE submission_id = $1 AND user_id = $2 LIMIT 1`,
    [submissionId, req.user.userId]
  );
  return result.rows.length > 0;
}

// Helper: validate parent_borrower_id — must belong to same deal and be top-level (its own parent_borrower_id IS NULL).
// Returns { ok: true } or { ok: false, error: '...' }.
async function _validateParentBorrower(parentId, dealId) {
  if (parentId === null || parentId === undefined || parentId === '') return { ok: true, value: null };
  const pid = parseInt(parentId);
  if (Number.isNaN(pid)) return { ok: false, error: 'parent_borrower_id must be an integer' };
  const row = await pool.query(
    `SELECT id, deal_id, parent_borrower_id FROM deal_borrowers WHERE id = $1`,
    [pid]
  );
  if (row.rows.length === 0) return { ok: false, error: 'parent_borrower_id does not exist' };
  if (row.rows[0].deal_id !== dealId) return { ok: false, error: 'parent_borrower_id belongs to a different deal' };
  if (row.rows[0].parent_borrower_id !== null) return { ok: false, error: 'parent_borrower_id must be a top-level party (cannot be another child)' };
  return { ok: true, value: pid };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CREATE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers', authenticateToken, async (req, res) => {
  try {
    // H1 (2026-04-20): add canEditDeal check — was missing, any authenticated
    // user could add borrowers to any deal by guessing submissionId.
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to add borrowers to this deal' });
    }

    // 2026-04-30 — normalize the payload BEFORE touching the DB.
    // Single canonical-form layer per matrix-normalizer rule: phone → E.164,
    // postcode → 'W1J 5RL', borrower_type → enum, date → ISO, email → lowercase, etc.
    const _normalized = normalizeBorrowerPayload(req.body);
    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number, parent_borrower_id } = _normalized;
    if (!full_name) return res.status(400).json({ error: 'Full name is required' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    // Validate parent_borrower_id if provided (must exist, same deal, be top-level)
    const parentCheck = await _validateParentBorrower(parent_borrower_id, dealId);
    if (!parentCheck.ok) return res.status(400).json({ error: parentCheck.error });

    const result = await pool.query(
      `INSERT INTO deal_borrowers (deal_id, role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number, parent_borrower_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [dealId, role || 'primary', full_name, date_of_birth || null, nationality || null,
       jurisdiction || null, email || null, phone || null, address || null, borrower_type || 'individual',
       company_name || null, company_number || null, parentCheck.value]
    );

    await logAudit(dealId, 'borrower_added', null, full_name,
      { role: role || 'primary', borrower_type: borrower_type || 'individual', parent_borrower_id: parentCheck.value }, req.user.userId);

    // 2026-04-30 — Auto-CH-verify on corporate borrower add. Mirrors the guarantor-
    // election flow (this file ~lines 760-776) so guarantors AND borrowers get the
    // same UBO/Director/PSC auto-population. Brokers don't need to click Verify.
    // Wrapped: row creation succeeds even if CH lookup fails.
    let autoChResult = { skipped: true };
    const newBorrowerRow = result.rows[0];
    const isCorporateAdd = ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes(
      String(newBorrowerRow.borrower_type || '').toLowerCase()
    );
    if (isCorporateAdd && newBorrowerRow.company_number && !newBorrowerRow.parent_borrower_id) {
      try {
        console.log(`[borrower-add] Auto-CH-verifying new corporate borrower #${newBorrowerRow.id} (${newBorrowerRow.company_number})`);
        const chResult = await _populateChChildrenRecursive(
          dealId, newBorrowerRow.id, newBorrowerRow.company_number, req.user.userId, 0
        );
        if (chResult && chResult.verification) {
          // Stamp ch_verified_at + ch_match_data on the new corporate row
          await pool.query(
            `UPDATE deal_borrowers
               SET ch_verified_at = NOW(),
                   ch_verified_by = $1,
                   ch_match_data = $2::jsonb,
                   ch_match_confidence = 'auto-populated',
                   updated_at = NOW()
             WHERE id = $3`,
            [req.user.userId, JSON.stringify(chResult.verification), newBorrowerRow.id]
          );
          autoChResult = {
            skipped: false,
            officers_inserted: chResult.inserted.officers,
            pscs_inserted: chResult.inserted.pscs,
            recursed: chResult.recursed,
          };
          // Reflect the verified state on the response row so frontend renders ✓ immediately
          newBorrowerRow.ch_verified_at = new Date().toISOString();
          newBorrowerRow.ch_match_data = chResult.verification;
          newBorrowerRow.ch_match_confidence = 'auto-populated';
        } else {
          autoChResult = { skipped: false, reason: 'company_not_found_at_ch' };
        }
      } catch (chErr) {
        console.warn(`[borrower-add] Auto-CH-verify failed (non-fatal): ${chErr.message}`);
        autoChResult = { skipped: false, error: chErr.message };
      }
    }

    res.status(201).json({ success: true, borrower: newBorrowerRow, auto_ch: autoChResult });
  } catch (error) {
    console.error('[borrower] Error:', error);
    // 2026-04-30: surface real Postgres error (constraint + detail) so we
    // stop debugging blind. Common: unique-name index violation when broker
    // tries to add a borrower with the same full_name as an existing one.
    const isUniqueViolation = error.code === '23505';
    res.status(isUniqueViolation ? 409 : 500).json({
      error: isUniqueViolation
        ? 'A borrower with this name already exists on the deal. Use a different name or edit the existing record.'
        : (error.detail || error.message || 'Failed to add borrower'),
      code: error.code || null,
      constraint: error.constraint || null,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET BORROWERS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/borrowers', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, created_at`,
      [dealResult.rows[0].id]
    );
    res.json({ success: true, borrowers: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch borrowers' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/borrowers/:borrowerId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to edit this borrower' });
    }

    // 2026-04-30 — normalize the payload BEFORE the SQL UPDATE.
    // PUT /borrowers is the matrix-inline-edit path — broker/RM editing existing
    // borrower row. Same canonical-form treatment as POST.
    const _normalized = normalizeBorrowerPayload(req.body);
    const { kyc_status, kyc_data, pg_status, pg_limit_amount, pg_notes } = req.body;
    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number } = _normalized;

    // Parent hierarchy — handle separately so user can explicitly detach (null) vs "no change" (undefined)
    const parentKeyPresent = Object.prototype.hasOwnProperty.call(req.body, 'parent_borrower_id');
    let parentForUpdate = 'SKIP'; // sentinel
    if (parentKeyPresent) {
      // Need deal_id to validate parent belongs to same deal
      const dealRow = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
      if (dealRow.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      // Prevent parenting self
      if (req.body.parent_borrower_id && parseInt(req.body.parent_borrower_id) === parseInt(req.params.borrowerId)) {
        return res.status(400).json({ error: 'A borrower cannot be its own parent' });
      }
      const parentCheck = await _validateParentBorrower(req.body.parent_borrower_id, dealRow.rows[0].id);
      if (!parentCheck.ok) return res.status(400).json({ error: parentCheck.error });
      parentForUpdate = parentCheck.value; // null or integer
    }

    // Build SET clause dynamically so parent_borrower_id can be set to NULL
    // G5.3.2: pg_status, pg_limit_amount, pg_notes — use IS NULL check so 'waived' / NULL limit works
    const setClauses = [
      'role = COALESCE($1, role)', 'full_name = COALESCE($2, full_name)',
      'date_of_birth = COALESCE($3, date_of_birth)', 'nationality = COALESCE($4, nationality)',
      'jurisdiction = COALESCE($5, jurisdiction)', 'email = COALESCE($6, email)',
      'phone = COALESCE($7, phone)', 'address = COALESCE($8, address)',
      'borrower_type = COALESCE($9, borrower_type)', 'company_name = COALESCE($10, company_name)',
      'company_number = COALESCE($11, company_number)', 'kyc_status = COALESCE($12, kyc_status)',
      'kyc_data = COALESCE($13, kyc_data)',
      'pg_status = COALESCE($14, pg_status)',
      'pg_limit_amount = $15',                       // allow explicit NULL clear
      'pg_notes = COALESCE($16, pg_notes)',
      'updated_at = NOW()'
    ];
    const params = [
      role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address,
      borrower_type, company_name, company_number, kyc_status, kyc_data ? JSON.stringify(kyc_data) : null,
      pg_status,
      pg_limit_amount === undefined ? null : (pg_limit_amount === '' || pg_limit_amount === null ? null : parseFloat(pg_limit_amount)),
      pg_notes
    ];
    if (parentForUpdate !== 'SKIP') {
      setClauses.push(`parent_borrower_id = $${params.length + 1}`);
      params.push(parentForUpdate); // null to detach, or integer to re-parent
    }
    params.push(req.params.borrowerId);

    const result = await pool.query(
      `UPDATE deal_borrowers SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });

    // 2026-04-30 — auto-fire CH-verify when company_number is set/changed on a corporate borrower
    // Mirrors POST /borrowers behaviour. ch_verified_at gate prevents duplicate verifies.
    const updatedRow = result.rows[0];
    const justGotCorpNumber = (
      Object.prototype.hasOwnProperty.call(req.body, 'company_number') &&
      updatedRow.company_number &&
      !updatedRow.ch_verified_at
    );
    if (justGotCorpNumber) {
      try {
        const dealRow = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
        if (dealRow.rows.length > 0) {
          await _populateChChildrenRecursive(
            dealRow.rows[0].id,
            updatedRow.id,
            updatedRow.company_number,
            req.user.userId,
            0
          );
          // Re-fetch borrower with verify flags
          const verified = await pool.query(`SELECT * FROM deal_borrowers WHERE id = $1`, [updatedRow.id]);
          return res.json({ success: true, borrower: verified.rows[0] || updatedRow });
        }
      } catch (chErr) {
        console.warn(`[borrower PUT] auto-CH-verify failed for borrower ${updatedRow.id}:`, chErr.message);
        // Fall through and return the un-verified row — verify can be retried manually
      }
    }
    res.json({ success: true, borrower: updatedRow });
  } catch (error) {
    console.error('[borrower PUT] Error:', error);
    res.status(500).json({ error: 'Failed to update borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId/borrowers/:borrowerId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to remove this borrower' });
    }

    const result = await pool.query(`DELETE FROM deal_borrowers WHERE id = $1 RETURNING full_name`, [req.params.borrowerId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });
    res.json({ success: true, message: `Borrower ${result.rows[0].full_name} removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CH ROLE VERIFICATION — RM confirms each borrower's role after CH check
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers/verify-roles', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { verifications } = req.body;
    // verifications = [{ borrower_id, confirmed_role, ch_matched_role, ch_match_confidence, ch_match_data }]
    if (!verifications || !Array.isArray(verifications) || verifications.length === 0) {
      return res.status(400).json({ error: 'No verifications provided' });
    }

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const results = [];
    for (const v of verifications) {
      const result = await pool.query(
        `UPDATE deal_borrowers SET
          role = COALESCE($1, role),
          ch_matched_role = $2,
          ch_match_confidence = $3,
          ch_verified_by = $4,
          ch_verified_at = NOW(),
          ch_match_data = COALESCE($5, '{}'::jsonb),
          updated_at = NOW()
         WHERE id = $6 AND deal_id = $7 RETURNING id, full_name, role, ch_matched_role, ch_match_confidence`,
        [
          v.confirmed_role || null,
          v.ch_matched_role || null,
          v.ch_match_confidence || 'manual',
          req.user.userId,
          v.ch_match_data ? JSON.stringify(v.ch_match_data) : null,
          v.borrower_id,
          dealId
        ]
      );
      if (result.rows.length > 0) results.push(result.rows[0]);
    }

    await logAudit(dealId, 'ch_roles_verified', null, `${results.length} borrower roles verified`,
      { verifications: results.map(r => ({ id: r.id, name: r.full_name, role: r.role, ch_role: r.ch_matched_role })) },
      req.user.userId);

    res.json({ success: true, verified: results, count: results.length });
  } catch (error) {
    console.error('[borrower/verify-roles] Error:', error);
    res.status(500).json({ error: 'Failed to verify borrower roles' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Recursive CH populate helper (G5.3 Part A — 2026-04-20)
//  Core logic for inserting officers + PSCs as children of a corporate row.
//  Called by the /ch-verify-populate endpoint at depth=0. Recurses to depth
//  MAX_RECURSION_DEPTH when a corporate PSC is detected with its own company
//  number — so ownership chains like "Cohort Capital Ltd ← Cohort Capital
//  Holdings Ltd ← its own officers" are fully populated.
// ═══════════════════════════════════════════════════════════════════════════
// Bumped 2026-04-19 from 2 → 4 to trace full UBO chain up to 4 levels.
// Typical worst-case API cost: 1 + 2 + 4 + 8 = 15 CH calls per primary (CH limit 600/5min).
// Below MAX depth, a corporate PSC WITHOUT a UK registration number (e.g. BVI entity) is
// flagged with broker_trace_required=true so RM can ask broker for manual UBO chain.
const MAX_RECURSION_DEPTH = 4;

async function _populateChChildrenRecursive(dealId, parentRowId, companyNumber, userId, depth = 0) {
  if (!companyNumber) return { verification: null, inserted: { officers: 0, pscs: 0 }, recursed: 0 };

  const companiesHouse = require('../services/companies-house');
  let verification;
  try {
    verification = await companiesHouse.verifyCompany(companyNumber);
  } catch (chErr) {
    console.warn(`[ch-recurse depth=${depth}] verifyCompany(${companyNumber}) failed:`, chErr.message);
    return { verification: null, inserted: { officers: 0, pscs: 0 }, recursed: 0, error: chErr.message };
  }
  if (!verification || !verification.found) {
    console.warn(`[ch-recurse depth=${depth}] company not found: ${companyNumber}`);
    return { verification: null, inserted: { officers: 0, pscs: 0 }, recursed: 0 };
  }

  // Load existing children so we don't duplicate; keep id mapping so we can recurse on existing corporate PSCs
  const childRows = await pool.query(
    `SELECT id, full_name, ch_match_data FROM deal_borrowers WHERE parent_borrower_id = $1`,
    [parentRowId]
  );
  // ─── 2026-04-21 — token-sorted name key (mirrors claude-parser._normaliseNameKey) ───
  // Was: simple lowercase+trim — treated "Alessandra CENCI" and "CENCI, Alessandra"
  // as different people, so CH officer insert would create a duplicate of the
  // UBO row written earlier by candidate confirm. Now uses the same sort-tokens
  // logic that AI Parse uses, so variants of the same person collapse.
  const _normaliseNameKey = (name) => {
    if (!name) return '';
    return String(name)
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t && !['mr','mrs','ms','miss','dr','prof','sir','dame','lord','lady'].includes(t))
      .sort()
      .join(' ');
  };
  const existingByName = new Map(childRows.rows.map(c => [_normaliseNameKey(c.full_name), c]));
  const existingNames = new Set(existingByName.keys());

  let officersInserted = 0;
  let pscsInserted = 0;
  const corporatePscsToRecurse = [];

  // Insert directors / secretaries / LLP members as 'director' children
  const officers = Array.isArray(verification.officers) ? verification.officers : [];
  for (const o of officers) {
    const nameKey = _normaliseNameKey(o.name);
    if (!nameKey) continue;

    // ─── 2026-04-21 Step 3: MERGE instead of SKIP ───
    // If an existing child row matches (broker elected this person as UBO/PG
    // via candidate confirm, or CH previously captured them as PSC), don't
    // drop the CH officer facts. Merge them into ch_match_data with
    // ch_officer_* namespaced keys so the row carries all role facets
    // (UBO + Director + PSC) for the same person without overwriting the
    // broker-assigned label.
    if (existingNames.has(nameKey)) {
      const existingChild = existingByName.get(nameKey);
      const officerFacets = {
        ch_officer_source: 'ch_officers_endpoint',
        ch_officer_role: o.officer_role || null,
        ch_officer_appointed_on: o.appointed_on || null,
        ch_officer_resigned_on: o.resigned_on || null,
        ch_officer_nationality: o.nationality || null,
        ch_officer_country_of_residence: o.country_of_residence || null,
        ch_officer_occupation: o.occupation || null,
        ch_officer_date_of_birth: o.date_of_birth || null,
        ch_officer_recursion_depth: depth,
        ch_officer_merged_at: new Date().toISOString(),
        // Sprint 5 #23 — capture CH officer_id so directorships pull works automatically
        officer_id: o.officer_id || null,
        ch_officer_id: o.officer_id || null
      };
      try {
        // 2026-04-21 Step 3.5: also stamp CH verification on the existing row so
        // the UI's allChVerified check flips true and the rich rendering fires
        // automatically after CH verify (no manual click-through needed).
        // ch_matched_role accumulates as comma-separated list — broker's label
        // preserved, CH role appended only if not already present.
        await pool.query(
          `UPDATE deal_borrowers
             SET ch_match_data = COALESCE(ch_match_data, '{}'::jsonb) || $1::jsonb,
                 ch_verified_at = COALESCE(ch_verified_at, NOW()),
                 ch_verified_by = COALESCE(ch_verified_by, $3::integer),
                 ch_matched_role = CASE
                   WHEN ch_matched_role IS NULL OR TRIM(ch_matched_role) = '' THEN $4
                   WHEN POSITION(LOWER($4) IN LOWER(ch_matched_role)) > 0 THEN ch_matched_role
                   ELSE ch_matched_role || ', ' || $4
                 END,
                 ch_match_confidence = COALESCE(NULLIF(ch_match_confidence, ''), 'ch_direct'),
                 updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(officerFacets), existingChild.id, userId, o.officer_role || 'director']
        );
        console.log(`[ch-recurse depth=${depth}] merged officer facets + CH-verified existing row id=${existingChild.id} (${o.name}, role=${o.officer_role})`);
      } catch (e) {
        console.warn(`[ch-recurse depth=${depth}] officer merge failed on id=${existingChild.id}:`, e.message);
      }
      continue;
    }
    const roleMap = { director: 'director', 'llp-member': 'director', secretary: 'director' };
    const mappedRole = roleMap[o.officer_role] || 'director';
    const chData = {
      source: 'ch_officers_endpoint',
      company_number: companyNumber,
      officer_role: o.officer_role,
      appointed: o.appointed_on || null,
      nationality: o.nationality || null,
      country_of_residence: o.country_of_residence || null,
      occupation: o.occupation || null,
      date_of_birth: o.date_of_birth || null,
      recursion_depth: depth,
      // Sprint 5 #23 — capture CH officer_id so directorships pull works automatically
      officer_id: o.officer_id || null,
      ch_officer_id: o.officer_id || null
    };
    try {
      const ins = await pool.query(
        `INSERT INTO deal_borrowers
          (deal_id, role, full_name, nationality, borrower_type, parent_borrower_id, address, kyc_status,
           ch_verified_at, ch_verified_by, ch_matched_role, ch_match_confidence, ch_match_data)
         VALUES ($1, $2, $3, $4, 'individual', $5, $6, 'pending',
           NOW(), $7, $8, 'ch_direct', $9::jsonb)
         RETURNING id`,
        [dealId, mappedRole, o.name, o.nationality || null, parentRowId,
         o.address ? [o.address.line_1, o.address.locality, o.address.postal_code, o.address.country].filter(Boolean).join(', ') : null,
         userId, o.officer_role || mappedRole, JSON.stringify(chData)]
      );
      if (ins.rows.length > 0) {
        officersInserted++;
        existingNames.add(nameKey);
      }
    } catch (e) { console.warn(`[ch-recurse depth=${depth}] officer insert:`, e.message); }
  }

  // Insert PSCs as children; queue corporate PSCs for recursion (incl. existing ones not yet recursed)
  const pscs = Array.isArray(verification.pscs) ? verification.pscs : [];
  for (const p of pscs) {
    const nameKey = _normaliseNameKey(p.name);
    if (!nameKey) continue;
    const pscKindStr = String(p.kind || '').toLowerCase();
    const isCorporatePsc = pscKindStr.includes('corporate-entity') || pscKindStr.includes('legal-person');
    const pscBorrowerType = isCorporatePsc ? 'corporate' : 'individual';
    const pscOwnCompanyNumber = (isCorporatePsc && p.identification && p.identification.registration_number)
      ? String(p.identification.registration_number)
      : null;

    // Diagnostic log — tells us exactly why recursion does or doesn't fire
    console.log(`[ch-recurse depth=${depth}] PSC name="${p.name}" kind="${p.kind}" isCorp=${isCorporatePsc} ownCoNum=${pscOwnCompanyNumber || 'NONE'} existed=${existingNames.has(nameKey)} identification=${JSON.stringify(p.identification || null)}`);

    // Broker-trace flag: corporate PSC that we cannot further verify via UK CH
    // (typically BVI / offshore / other non-UK jurisdiction with no registration number).
    // Set a flag on the row so UI can render an amber advisory asking broker for manual UBO chain.
    const _brokerTraceRequired = isCorporatePsc && !pscOwnCompanyNumber;
    const _brokerTraceReason = _brokerTraceRequired
      ? (() => {
          const country = (p.address && p.address.country) || (p.identification && p.identification.country_registered) || null;
          const legalAuthority = p.identification && p.identification.legal_authority ? p.identification.legal_authority : null;
          if (country && !/united kingdom|england|wales|scotland|northern ireland/i.test(country)) {
            return `Non-UK entity (${country}${legalAuthority ? ', ' + legalAuthority : ''}) — CH cannot trace. Broker to provide UBO chain.`;
          }
          if (legalAuthority && !/england|wales|scotland|northern ireland/i.test(legalAuthority)) {
            return `Jurisdiction: ${legalAuthority} — no UK registration. Broker to provide UBO chain.`;
          }
          return 'Corporate PSC without registration number — broker to provide UBO chain.';
        })()
      : null;

    // If existing — MERGE PSC facets into existing row, then handle corporate
    // recursion / broker-trace as before. 2026-04-21 Step 3: previously this
    // branch only handled corporate-PSC specific updates (recursion, trace flag)
    // and otherwise skipped silently. Now it also captures PSC facets (natures
    // of control, percentage, kind) for ALL existing matches so a person who
    // is UBO + Director + PSC has all three facets on one row without
    // overwriting the broker-assigned role label.
    if (existingNames.has(nameKey)) {
      const existingChild = existingByName.get(nameKey);

      // Always merge PSC facets under `ch_psc_*` namespace
      const pscFacets = {
        ch_psc_source: 'ch_psc_endpoint',
        ch_psc_kind: p.kind || null,
        ch_psc_notified_on: p.notified_on || null,
        ch_psc_ceased_on: p.ceased_on || null,
        ch_psc_natures_of_control: p.natures_of_control || [],
        ch_psc_nationality: p.nationality || null,
        ch_psc_country_of_residence: p.country_of_residence || null,
        ch_psc_date_of_birth: p.date_of_birth || null,
        ch_psc_is_corporate: isCorporatePsc,
        ch_psc_own_company_number: pscOwnCompanyNumber,
        ch_psc_identification: p.identification || null,
        ch_psc_recursion_depth: depth,
        ch_psc_merged_at: new Date().toISOString()
      };
      try {
        // 2026-04-21 Step 3.5: also stamp CH verification on the existing row
        // so allChVerified flips true and rich rendering fires. ch_matched_role
        // accumulates — broker's label preserved, 'psc' appended if absent.
        await pool.query(
          `UPDATE deal_borrowers
             SET ch_match_data = COALESCE(ch_match_data, '{}'::jsonb) || $1::jsonb,
                 ch_verified_at = COALESCE(ch_verified_at, NOW()),
                 ch_verified_by = COALESCE(ch_verified_by, $3::integer),
                 ch_matched_role = CASE
                   WHEN ch_matched_role IS NULL OR TRIM(ch_matched_role) = '' THEN 'psc'
                   WHEN POSITION('psc' IN LOWER(ch_matched_role)) > 0 THEN ch_matched_role
                   ELSE ch_matched_role || ', psc'
                 END,
                 ch_match_confidence = COALESCE(NULLIF(ch_match_confidence, ''), 'ch_direct'),
                 updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(pscFacets), existingChild.id, userId]
        );
        console.log(`[ch-recurse depth=${depth}] merged PSC facets + CH-verified existing row id=${existingChild.id} (${p.name})`);
      } catch (e) {
        console.warn(`[ch-recurse depth=${depth}] PSC merge failed on id=${existingChild.id}:`, e.message);
      }

      // Pre-existing behaviour: corporate-PSC recursion + broker-trace flagging
      if (isCorporatePsc && pscOwnCompanyNumber && depth < MAX_RECURSION_DEPTH) {
        const existingChMatch = existingChild.ch_match_data || {};
        const alreadyRecursed = !!(existingChMatch.nested_verification);
        console.log(`[ch-recurse depth=${depth}] Existing corporate PSC detected: ${p.name} — alreadyRecursed=${alreadyRecursed}, will${alreadyRecursed ? ' NOT' : ''} queue for recursion`);
        if (!alreadyRecursed) {
          // Backfill the company_number on the existing row so future runs know
          await pool.query(
            `UPDATE deal_borrowers SET company_number = COALESCE(company_number, $1),
                ch_match_data = ch_match_data || $2::jsonb, updated_at = NOW() WHERE id = $3`,
            [pscOwnCompanyNumber, JSON.stringify({ psc_own_company_number: pscOwnCompanyNumber, psc_identification: p.identification || null }), existingChild.id]
          );
          corporatePscsToRecurse.push({ rowId: existingChild.id, companyNumber: pscOwnCompanyNumber });
        }
      } else if (isCorporatePsc) {
        console.log(`[ch-recurse depth=${depth}] Existing corporate PSC "${p.name}" NOT queued — reason: ownCoNum=${pscOwnCompanyNumber || 'missing'}, depth=${depth}/${MAX_RECURSION_DEPTH}`);
        if (_brokerTraceRequired) {
          await pool.query(
            `UPDATE deal_borrowers SET ch_match_data = ch_match_data || $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify({ broker_trace_required: true, broker_trace_reason: _brokerTraceReason }), existingChild.id]
          );
          console.log(`[ch-recurse depth=${depth}] Flagged existing "${p.name}" for broker trace: ${_brokerTraceReason}`);
        }
      }
      continue;  // skip the insert — facets merged above
    }
    const chData = {
      source: 'ch_psc_endpoint',
      company_number: companyNumber,
      psc_kind: p.kind || null,
      psc_own_company_number: pscOwnCompanyNumber,
      psc_identification: p.identification || null,
      notified: p.notified_on || null,
      nationality: p.nationality || null,
      country_of_residence: p.country_of_residence || null,
      natures_of_control: p.natures_of_control || [],
      date_of_birth: p.date_of_birth || null,
      recursion_depth: depth,
      ...(_brokerTraceRequired ? { broker_trace_required: true, broker_trace_reason: _brokerTraceReason } : {})
    };
    if (_brokerTraceRequired) {
      console.log(`[ch-recurse depth=${depth}] New "${p.name}" flagged for broker trace: ${_brokerTraceReason}`);
    }
    try {
      const ins = await pool.query(
        `INSERT INTO deal_borrowers
          (deal_id, role, full_name, nationality, borrower_type, company_number, parent_borrower_id, kyc_status,
           ch_verified_at, ch_verified_by, ch_matched_role, ch_match_confidence, ch_match_data)
         VALUES ($1, 'psc', $2, $3, $4, $5, $6, 'pending',
           NOW(), $7, 'psc', 'ch_direct', $8::jsonb)
         RETURNING id`,
        [dealId, p.name, p.nationality || null, pscBorrowerType, pscOwnCompanyNumber, parentRowId, userId, JSON.stringify(chData)]
      );
      if (ins.rows.length > 0) {
        pscsInserted++;
        existingNames.add(nameKey);
        if (isCorporatePsc && pscOwnCompanyNumber && depth < MAX_RECURSION_DEPTH) {
          corporatePscsToRecurse.push({ rowId: ins.rows[0].id, companyNumber: pscOwnCompanyNumber });
        }
      }
    } catch (e) { console.warn(`[ch-recurse depth=${depth}] PSC insert:`, e.message); }
  }

  // Recurse for each corporate PSC we queued
  let totalRecursed = corporatePscsToRecurse.length;
  for (const cp of corporatePscsToRecurse) {
    try {
      const sub = await _populateChChildrenRecursive(dealId, cp.rowId, cp.companyNumber, userId, depth + 1);
      // Stash the sub-verification on the PSC row so frontend can render its detail panel
      if (sub && sub.verification) {
        await pool.query(
          `UPDATE deal_borrowers SET ch_match_data = ch_match_data || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ nested_verification: sub.verification, nested_inserted: sub.inserted }), cp.rowId]
        );
      }
    } catch (e) { console.warn(`[ch-recurse depth=${depth + 1}] recurse failed:`, e.message); }
  }

  return {
    verification,
    inserted: { officers: officersInserted, pscs: pscsInserted },
    recursed: totalRecursed
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PER-CORPORATE CH VERIFY & POPULATE — Phase G2b
//  Runs Companies House verification on a specific corporate borrower row
//  (e.g. a corporate guarantor) and auto-creates its officers & PSCs as child
//  borrower rows with parent_borrower_id set.
//  G5.3 Part A (2026-04-20): extended to recursively verify corporate PSCs
//  up to MAX_RECURSION_DEPTH = 2 levels — so ownership chains like
//  "Cohort Capital Ltd ← Cohort Capital Holdings Ltd ← its own officers"
//  are fully populated on a single CH verify action.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers/:borrowerId/ch-verify-populate', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission for this deal' });
    }

    // Load the target borrower and confirm it belongs to this deal
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const borResult = await pool.query(
      `SELECT id, role, full_name, borrower_type, company_name, company_number, parent_borrower_id
       FROM deal_borrowers WHERE id = $1 AND deal_id = $2`,
      [req.params.borrowerId, dealId]
    );
    if (borResult.rows.length === 0) return res.status(404).json({ error: 'Borrower not found on this deal' });
    const parent = borResult.rows[0];

    // Must be a corporate party with a company number. Top-level OR nested corporate PSC both allowed.
    if (!parent.company_number) return res.status(400).json({ error: 'This borrower has no company_number — set it before running CH verify' });
    if (parent.parent_borrower_id && (parent.borrower_type || '').toLowerCase() !== 'corporate') {
      return res.status(400).json({ error: 'CH verify is only supported on corporate parties (top-level or corporate PSC children)' });
    }

    // Delegate to recursive helper — inserts officers+PSCs, and recurses into corporate PSCs
    const result = await _populateChChildrenRecursive(dealId, parent.id, parent.company_number, req.user.userId, 0);

    if (!result.verification) {
      return res.status(404).json({ error: 'Company not found at Companies House', companyNumber: parent.company_number });
    }
    const verification = result.verification;
    const officers = Array.isArray(verification.officers) ? verification.officers : [];
    const pscs = Array.isArray(verification.pscs) ? verification.pscs : [];
    const created = []; // maintained for response-shape backward compat (summary instead of full rows)

    // Mark the parent corporate borrower as CH verified, stash the verification
    await pool.query(
      `UPDATE deal_borrowers
       SET ch_verified_at = NOW(), ch_verified_by = $1,
           ch_match_data = $2::jsonb, ch_match_confidence = 'auto-populated',
           updated_at = NOW()
       WHERE id = $3`,
      [req.user.userId, JSON.stringify(verification), parent.id]
    );

    await logAudit(dealId, 'ch_verified_and_populated', null, parent.company_name || parent.full_name,
      { companyNumber: parent.company_number, created_children: result.inserted.officers + result.inserted.pscs,
        officers: result.inserted.officers, pscs: result.inserted.pscs, recursed_corporate_pscs: result.recursed },
      req.user.userId);

    const totalInserted = result.inserted.officers + result.inserted.pscs;
    res.json({
      success: true,
      verification: {
        company_name: verification.company_name,
        company_number: verification.company_number,
        company_status: verification.company_status,
        incorporated_on: verification.incorporated_on,
        officer_count: officers.length,
        psc_count: pscs.length,
      },
      created_summary: {
        officers_inserted: result.inserted.officers,
        pscs_inserted: result.inserted.pscs,
        corporate_pscs_recursed: result.recursed
      },
      skipped: (officers.length + pscs.length) - totalInserted,
      message: `Verified ${verification.company_name} — added ${totalInserted} officer(s)/PSC(s)${result.recursed > 0 ? ` and auto-verified ${result.recursed} corporate PSC chain(s)` : ''}`
    });
  } catch (error) {
    // 2026-04-30: full diagnostic so we stop hunting blind. Returns the stack
    // trace (top 8 frames) so the frontend alert / network tab shows exactly
    // which file + line raised. Stack trace is safe to expose internally for
    // debugging — strip later once root cause is found.
    console.error('[ch-verify-populate] Error:', error);
    console.error('[ch-verify-populate] Stack:', error.stack);
    const stackLines = (error.stack || '').split('\n').slice(0, 8).join('\n');
    res.status(500).json({
      error: 'CH verify & populate failed: ' + error.message,
      message: error.message,
      code: error.code || null,
      stack_top: stackLines,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  G5.3 Part C — Elect corporate PSC as Corporate Guarantor (2026-04-20)
//
//  Converts an informational corporate-PSC row into a structural decision:
//  this entity IS a corporate guarantor on the deal. Creates a NEW top-level
//  row with role='guarantor', borrower_type='corporate', pre-filled from the
//  source PSC's identity (name, company_number, address, jurisdiction).
//  Links back via ch_match_data.elected_from_borrower_id so the guarantor
//  row remembers its provenance.
//
//  Idempotent: if already elected (by source id OR company_number OR name),
//  returns 409 with the existing guarantor row id.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers/:borrowerId/elect-as-corporate-guarantor', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission for this deal' });
    }

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    // Load the source corporate row
    const srcResult = await pool.query(
      `SELECT id, role, full_name, borrower_type, company_number, nationality, jurisdiction, address,
              ch_verified_at, ch_matched_role, ch_match_confidence, ch_match_data, parent_borrower_id
       FROM deal_borrowers WHERE id = $1 AND deal_id = $2`,
      [req.params.borrowerId, dealId]
    );
    if (srcResult.rows.length === 0) return res.status(404).json({ error: 'Source borrower not found on this deal' });
    const src = srcResult.rows[0];

    if ((src.borrower_type || '').toLowerCase() !== 'corporate') {
      return res.status(400).json({ error: 'Only corporate entities can be elected as Corporate Guarantor. This row is not corporate.' });
    }
    if (src.role === 'guarantor') {
      return res.status(400).json({ error: 'This row is already a guarantor.' });
    }

    // Idempotency: look for existing guarantor already elected from this source,
    // OR an existing corporate guarantor in the same deal with matching company_number / name.
    // All conditions parameterised (defense in depth even though company_number is CH-controlled).
    const dupCheck = await pool.query(
      `SELECT id, full_name, company_number, ch_match_data FROM deal_borrowers
       WHERE deal_id = $1 AND role = 'guarantor' AND borrower_type = 'corporate' AND (
         (ch_match_data->>'elected_from_borrower_id')::int = $2
         OR ($3::text IS NOT NULL AND company_number = $3)
         OR LOWER(TRIM(full_name)) = LOWER(TRIM($4))
       )`,
      [dealId, src.id, src.company_number || null, src.full_name || '']
    );
    if (dupCheck.rows.length > 0) {
      const existing = dupCheck.rows[0];
      return res.status(409).json({
        error: 'Already elected as corporate guarantor on this deal',
        existing_guarantor_id: existing.id,
        existing_guarantor_name: existing.full_name,
        message: `${src.full_name} is already a corporate guarantor on this deal (row #${existing.id}).`
      });
    }

    // Build elected ch_match_data: preserve useful source fields + provenance trail
    const srcCm = src.ch_match_data || {};
    const electedChMatch = {
      elected_from_borrower_id: src.id,
      elected_from_role: src.role,
      elected_from_name: src.full_name,
      elected_at: new Date().toISOString(),
      elected_by_user_id: req.user.userId,
      // Preserve source identity fields that inform the guarantor card
      company_number: src.company_number || srcCm.psc_own_company_number || null,
      registered_address: srcCm.registered_address || null,
      psc_identification: srcCm.psc_identification || null,
      jurisdiction: src.jurisdiction || srcCm.jurisdiction || null,
      natures_of_control_at_borrower: Array.isArray(srcCm.natures_of_control) ? srcCm.natures_of_control : null,
      // Mirror broker-trace flag if source had it (non-UK entity)
      ...(srcCm.broker_trace_required === true
        ? { broker_trace_required: true, broker_trace_reason: srcCm.broker_trace_reason }
        : {})
    };

    // Flatten a registered-address string if the source row's address column is empty
    let addr = src.address;
    if (!addr && srcCm.registered_address && typeof srcCm.registered_address === 'object') {
      const ra = srcCm.registered_address;
      addr = [ra.line_1, ra.line_2, ra.locality, ra.region, ra.postal_code, ra.country]
        .filter(x => x && String(x).trim()).join(', ') || null;
    }

    const ins = await pool.query(
      `INSERT INTO deal_borrowers
        (deal_id, role, full_name, nationality, jurisdiction, borrower_type, company_number, parent_borrower_id,
         address, kyc_status, ch_verified_at, ch_verified_by, ch_matched_role, ch_match_confidence, ch_match_data)
       VALUES ($1, 'guarantor', $2, $3, $4, 'corporate', $5, NULL,
         $6, 'pending', $7, $8, 'corporate_guarantor_elected', 'elected', $9::jsonb)
       RETURNING id, role, full_name, borrower_type, company_number, ch_match_data`,
      [
        dealId,
        src.full_name,
        src.nationality || null,
        src.jurisdiction || electedChMatch.jurisdiction || null,
        src.company_number || null,
        addr,
        src.ch_verified_at || null,  // inherit CH verified status from source
        req.user.userId,
        JSON.stringify(electedChMatch)
      ]
    );

    const newRow = ins.rows[0];

    // Also stamp the SOURCE row so future requests know it's been elected (saves a lookup)
    await pool.query(
      `UPDATE deal_borrowers
       SET ch_match_data = ch_match_data || $1::jsonb, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ elected_as_corporate_guarantor_id: newRow.id, elected_at: new Date().toISOString() }), src.id]
    );

    // ── Auto-populate guarantor's own directors/PSCs (2026-04-20, Overnight 2) ─────────
    // Avoids the "0 directors/PSCs" quirk on newly-elected guarantors. Re-uses the same
    // recursive helper used by direct CH verify; populates as children of the NEW guarantor row.
    // Idempotent: children with matching names will be deduped by the unique index.
    // Skipped if source was never CH-verified or has no company_number.
    let autoPopulate = { officers: 0, pscs: 0, recursed: 0, skipped: false, reason: null };
    if (src.company_number && src.ch_verified_at) {
      try {
        console.log(`[elect] Auto-populating CH children for new guarantor #${newRow.id} (${src.company_number})`);
        const chResult = await _populateChChildrenRecursive(dealId, newRow.id, src.company_number, req.user.userId, 0);
        autoPopulate.officers = chResult.inserted.officers;
        autoPopulate.pscs = chResult.inserted.pscs;
        autoPopulate.recursed = chResult.recursed;
        // Merge the full CH verification blob onto the guarantor row for rich panel rendering
        if (chResult.verification) {
          await pool.query(
            `UPDATE deal_borrowers SET ch_match_data = ch_match_data || $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(chResult.verification), newRow.id]
          );
        }
      } catch (autoErr) {
        console.warn(`[elect] Auto-populate failed for new guarantor #${newRow.id}:`, autoErr.message);
        autoPopulate.skipped = true;
        autoPopulate.reason = 'auto_populate_error';
        autoPopulate.error = autoErr.message;
      }
    } else {
      autoPopulate.skipped = true;
      autoPopulate.reason = !src.company_number ? 'no_company_number' : 'source_not_ch_verified';
    }

    await logAudit(dealId, 'elected_as_corporate_guarantor', null, src.full_name,
      { source_borrower_id: src.id, new_guarantor_id: newRow.id, company_number: src.company_number,
        auto_populated: autoPopulate },
      req.user.userId);

    // Message reflects whether children were auto-populated
    const populateSuffix = autoPopulate.skipped
      ? ''
      : ` Auto-populated ${autoPopulate.officers} officer(s) and ${autoPopulate.pscs} PSC(s)${autoPopulate.recursed > 0 ? ` (recursed into ${autoPopulate.recursed} sub-corporate${autoPopulate.recursed > 1 ? 's' : ''})` : ''}.`;

    res.json({
      success: true,
      guarantor: newRow,
      source_borrower_id: src.id,
      auto_populated: autoPopulate,
      message: `${src.full_name} elected as Corporate Guarantor. Row added to Guarantors section.${populateSuffix}`
    });
  } catch (error) {
    console.error('[elect-as-corporate-guarantor] Error:', error);
    res.status(500).json({ error: 'Election failed: ' + error.message });
  }
});

// 2026-04-30 — expose the recursive CH populator so other routes (e.g.,
// quick-quote convert-to-deal) can fire auto-CH-verify without re-implementing.
module.exports = router;
module.exports.populateChChildrenRecursive = _populateChChildrenRecursive;
