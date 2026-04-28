/**
 * services/valuations.js
 * ============================================================
 * RICS valuation evidence — Pattern B implementation on top of
 * services/evidence-base.js.
 *
 * Sumit's design lock 2026-04-28:
 *   - lending_value_pence is THE LTV anchor (replaces broker-stated
 *     value in rubric/pricing)
 *   - 6-month expiry from valuation_date — drawdown gate enforced
 *     at SELECT-time
 *   - valuer_id FK to approved_valuers (nullable for soft-policy
 *     off-panel use). When NULL, valuer_off_panel_name carries the
 *     free-text firm name and the rubric flags this as off-panel
 *     risk in the IA grade.
 *   - Append-only: edits after finalisation create a new row that
 *     supersedes the old one (preserves audit chain).
 *
 * VALIDATION POLICY:
 *   - createDraft: only firm identity is required (valuer_id OR
 *     valuer_off_panel_name). Everything else can be filled in
 *     iteratively before finalisation.
 *   - finalise: enforces the lending-decision essentials —
 *     valuation_date, lending_value_pence, valuation_method.
 *     Document attachment is REQUIRED before finalisation (RICS
 *     report PDF must be on file for audit).
 * ============================================================
 */

const pool = require('../db/pool');
const evidence = require('./evidence-base');

const TABLE = 'deal_valuations';
const EXPIRY_MONTHS = 6;

// ------------------------------------------------------------
// 1. Whitelisted writable columns (excludes id, status, audit cols,
//    superseded chain — those flip via dedicated transitions).
// ------------------------------------------------------------
const WRITABLE_COLUMNS = [
  'property_id', 'document_id',
  'valuer_id', 'valuer_off_panel_name',
  'valuation_method', 'rics_member_name', 'rics_member_number',
  'valuation_date', 'inspection_date',
  'market_value_pence', 'vp_value_pence',
  'lending_value_pence', 'mortgage_lending_value_pence',
  'comparable_count', 'condition_grade', 'marketability_grade',
  'key_risks', 'assumptions', 'recommendations',
  'underwriter_commentary'
];

const VALID_METHODS = ['rics_red_book', 'desktop', 'drive_by', 'avm'];
const VALID_CONDITION = ['excellent', 'good', 'fair', 'poor'];
const VALID_MARKETABILITY = ['high', 'medium', 'low'];

// ------------------------------------------------------------
// 2. Validation helpers
// ------------------------------------------------------------

/**
 * Identity is required at draft creation: a deal_id PLUS either a
 * panel valuer_id OR a free-text valuer_off_panel_name.
 */
function _validateIdentity(data) {
  const errs = [];
  if (!data.valuer_id && !data.valuer_off_panel_name) {
    errs.push('Either valuer_id (panel firm) OR valuer_off_panel_name (free-text) is required');
  }
  if (data.valuer_id && data.valuer_off_panel_name) {
    errs.push('Provide valuer_id OR valuer_off_panel_name, not both');
  }
  if (data.valuation_method && !VALID_METHODS.includes(data.valuation_method)) {
    errs.push(`valuation_method must be one of: ${VALID_METHODS.join(', ')}`);
  }
  if (data.condition_grade && !VALID_CONDITION.includes(data.condition_grade)) {
    errs.push(`condition_grade must be one of: ${VALID_CONDITION.join(', ')}`);
  }
  if (data.marketability_grade && !VALID_MARKETABILITY.includes(data.marketability_grade)) {
    errs.push(`marketability_grade must be one of: ${VALID_MARKETABILITY.join(', ')}`);
  }
  return errs;
}

/**
 * Finalisation requires the lending-decision essentials. Stricter
 * than draft validation — we're committing this as the LTV anchor.
 */
function _validateForFinalise(row) {
  const errs = [];
  if (!row.valuation_date) errs.push('valuation_date is required to finalise');
  if (row.lending_value_pence == null) errs.push('lending_value_pence is required to finalise');
  if (!row.valuation_method) errs.push('valuation_method is required to finalise');
  if (!row.document_id) errs.push('A RICS report PDF must be attached before finalising (document_id null)');
  return errs;
}

// ------------------------------------------------------------
// 3. Internal: build INSERT/UPDATE column lists from data
// ------------------------------------------------------------
function _extractWritable(data) {
  const cols = [];
  const values = [];
  for (const c of WRITABLE_COLUMNS) {
    if (data[c] !== undefined) {
      cols.push(c);
      values.push(data[c]);
    }
  }
  return { cols, values };
}

// ------------------------------------------------------------
// 4. Public API
// ------------------------------------------------------------

/**
 * Create a new draft valuation. Identity must be supplied; other
 * fields can come later via update().
 *
 * @param {number} dealId
 * @param {Object} data    — writable columns (incl. valuer_id or off-panel name)
 * @param {number} userId  — submitting underwriter
 * @returns {Promise<object>} the created row (status='draft')
 */
async function createDraft(dealId, data, userId) {
  const errs = _validateIdentity(data);
  if (errs.length) throw new Error(errs.join('; '));

  const { cols, values } = _extractWritable(data);
  const insertCols = ['deal_id', 'submitted_by_user_id', 'status', ...cols];
  const insertVals = [dealId, userId, 'draft', ...values];
  const placeholders = insertVals.map((_, i) => `$${i + 1}`);

  const result = await pool.query(
    `INSERT INTO ${TABLE} (${insertCols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    insertVals
  );
  return result.rows[0];
}

/**
 * Update writable fields on a draft row. Refuses to update
 * finalised/superseded rows — those need supersedeWithNew() to
 * preserve audit integrity.
 */
async function updateDraft(id, data, userId) {
  // Status check first
  const cur = await pool.query(`SELECT id, status FROM ${TABLE} WHERE id = $1`, [id]);
  if (!cur.rows[0]) return null;
  if (cur.rows[0].status !== 'draft') {
    throw new Error(`Cannot update a row in status '${cur.rows[0].status}'. Use supersedeWithNew() to revise a finalised valuation.`);
  }

  const errs = _validateIdentity({ ...cur.rows[0], ...data });
  if (errs.length) throw new Error(errs.join('; '));

  const { cols, values } = _extractWritable(data);
  if (cols.length === 0) return cur.rows[0];

  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE ${TABLE} SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Finalise a draft. Validates lending-decision essentials.
 */
async function finalise(id, userId) {
  const cur = await pool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.status === 'finalised') return row; // idempotent
  if (row.status === 'superseded') {
    throw new Error('Cannot finalise a superseded row');
  }

  const errs = _validateForFinalise(row);
  if (errs.length) throw new Error(errs.join('; '));

  return await evidence.finaliseEvidence(TABLE, id, userId);
}

/**
 * Revise a finalised valuation: insert new row with the supplied data,
 * mark the old one as superseded by the new one. Atomic via tx.
 *
 * @returns {Promise<object>} { newRow, supersededOld }
 */
async function supersedeWithNew(oldId, newData, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [oldId]);
    if (!old.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error('Original valuation not found');
    }
    if (old.rows[0].superseded_by_id) {
      await client.query('ROLLBACK');
      throw new Error('That valuation has already been superseded');
    }

    // Carry over deal_id and property_id from the old row unless overridden
    const dealId = old.rows[0].deal_id;
    const merged = {
      property_id: old.rows[0].property_id,
      ...newData
    };
    const idErrs = _validateIdentity(merged);
    if (idErrs.length) {
      await client.query('ROLLBACK');
      throw new Error(idErrs.join('; '));
    }

    const { cols, values } = _extractWritable(merged);
    const insertCols = ['deal_id', 'submitted_by_user_id', 'status', ...cols];
    const insertVals = [dealId, userId, 'draft', ...values];
    const placeholders = insertVals.map((_, i) => `$${i + 1}`);

    const inserted = await client.query(
      `INSERT INTO ${TABLE} (${insertCols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      insertVals
    );
    const newRow = inserted.rows[0];

    const supersededOldRes = await client.query(
      `UPDATE ${TABLE}
         SET status = 'superseded',
             superseded_by_id = $2,
             superseded_at = NOW()
       WHERE id = $1 AND superseded_by_id IS NULL
       RETURNING *`,
      [oldId, newRow.id]
    );

    await client.query('COMMIT');
    return { newRow, supersededOld: supersededOldRes.rows[0] || null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 5. Read-side helpers (with valuer firm-name JOIN + expiry status)
// ------------------------------------------------------------

const VALUER_JOIN_SQL = `
  SELECT v.*,
         av.firm_name        AS valuer_firm_name,
         av.rics_firm_number AS valuer_rics_firm_number,
         av.status           AS valuer_panel_status,
         av.approved_by_funder AS valuer_approved_by_funder
    FROM ${TABLE} v
    LEFT JOIN approved_valuers av ON av.id = v.valuer_id
`;

/**
 * Decorate a row with computed expiry state. Caller can render
 * a pill (✓ Valid · 142d) / (⚠ Expiring · 12d) / (✗ Expired) / (— Missing date)
 * directly from the returned object.
 */
function _decorateExpiry(row) {
  if (!row) return null;
  const exp = evidence.computeExpiryStatus(row.valuation_date, EXPIRY_MONTHS);
  return Object.assign({}, row, { expiry: exp });
}

async function getById(id) {
  const result = await pool.query(`${VALUER_JOIN_SQL} WHERE v.id = $1`, [id]);
  return _decorateExpiry(result.rows[0]);
}

/**
 * Returns ALL rows for a deal — drafts, finalised, superseded —
 * ordered newest first. For the audit trail UI.
 */
async function listAllForDeal(dealId) {
  const result = await pool.query(
    `${VALUER_JOIN_SQL}
     WHERE v.deal_id = $1
     ORDER BY v.submitted_at DESC, v.id DESC`,
    [dealId]
  );
  return result.rows.map(_decorateExpiry);
}

/**
 * Returns active (finalised + non-superseded) rows — what the rubric
 * and pricing layer consume.
 */
async function listActiveForDeal(dealId) {
  const result = await pool.query(
    `${VALUER_JOIN_SQL}
     WHERE v.deal_id = $1 AND v.status = 'finalised' AND v.superseded_by_id IS NULL
     ORDER BY v.valuation_date DESC NULLS LAST, v.id DESC`,
    [dealId]
  );
  return result.rows.map(_decorateExpiry);
}

/**
 * Active row for a SPECIFIC property on the deal. Useful when the
 * matrix renders a per-property valuation card.
 */
async function listActiveForProperty(dealId, propertyId) {
  const result = await pool.query(
    `${VALUER_JOIN_SQL}
     WHERE v.deal_id = $1 AND v.property_id = $2
       AND v.status = 'finalised' AND v.superseded_by_id IS NULL
     ORDER BY v.valuation_date DESC NULLS LAST, v.id DESC`,
    [dealId, propertyId]
  );
  return result.rows.map(_decorateExpiry);
}

/**
 * Drawdown-gate query: active valuations on a deal with valuation_date
 * within the last EXPIRY_MONTHS months. Returns [] = drawdown blocked.
 */
async function listValidForDrawdown(dealId) {
  const result = await pool.query(
    `${VALUER_JOIN_SQL}
     WHERE v.deal_id = $1 AND v.status = 'finalised' AND v.superseded_by_id IS NULL
       AND v.valuation_date >= CURRENT_DATE - INTERVAL '${EXPIRY_MONTHS} months'
     ORDER BY v.valuation_date DESC`,
    [dealId]
  );
  return result.rows.map(_decorateExpiry);
}

/**
 * Risk-packager loader. Returns the shape that ships to Anthropic
 * as `payload.valuations`. Mirrors loadCreditChecks/loadKycChecks
 * pattern from EXP-B7/SS-B8.
 *
 * Each row exposes the 12 lending-decision fields + valuer panel
 * attribution (so the rubric can flag off-panel use). Drafts and
 * superseded rows are excluded.
 */
async function loadForRiskPackager(dealId) {
  const rows = await listActiveForDeal(dealId);
  return rows.map(r => ({
    id: r.id,
    deal_id: r.deal_id,
    property_id: r.property_id,
    // Identity / panel attribution
    valuer_id: r.valuer_id,
    valuer_firm_name: r.valuer_firm_name || r.valuer_off_panel_name || null,
    is_off_panel: !r.valuer_id && !!r.valuer_off_panel_name,
    valuer_panel_status: r.valuer_panel_status,
    valuer_approved_by_funder: r.valuer_approved_by_funder,
    rics_member_name: r.rics_member_name,
    rics_member_number: r.rics_member_number,
    // Method + dates
    valuation_method: r.valuation_method,
    valuation_date: r.valuation_date,
    inspection_date: r.inspection_date,
    expiry: r.expiry,
    // Money — pence on the wire, rubric can convert
    market_value_pence: r.market_value_pence,
    vp_value_pence: r.vp_value_pence,
    lending_value_pence: r.lending_value_pence,
    mortgage_lending_value_pence: r.mortgage_lending_value_pence,
    // Qualitative
    comparable_count: r.comparable_count,
    condition_grade: r.condition_grade,
    marketability_grade: r.marketability_grade,
    key_risks: r.key_risks,
    assumptions: r.assumptions,
    recommendations: r.recommendations,
    underwriter_commentary: r.underwriter_commentary,
    // Audit
    finalised_at: r.finalised_at
  }));
}

// ------------------------------------------------------------
// 6. Document attach pass-through
// ------------------------------------------------------------
async function attachDocument(id, documentId) {
  return await evidence.attachDocument(TABLE, id, documentId);
}

// ------------------------------------------------------------
// 7. Module exports
// ------------------------------------------------------------
module.exports = {
  // CRUD
  createDraft,
  updateDraft,
  finalise,
  supersedeWithNew,
  attachDocument,
  // Reads
  getById,
  listAllForDeal,
  listActiveForDeal,
  listActiveForProperty,
  listValidForDrawdown,
  // Risk-packager loader
  loadForRiskPackager,
  // Constants exposed for routes / UI validation
  WRITABLE_COLUMNS,
  VALID_METHODS,
  VALID_CONDITION,
  VALID_MARKETABILITY,
  EXPIRY_MONTHS
};
