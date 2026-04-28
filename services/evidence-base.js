/**
 * services/evidence-base.js
 * ============================================================
 * Pattern B evidence scaffolding — shared helpers used by all
 * evidence-style tables (deal_valuations, deal_environmental,
 * borrower_tax_returns, …).
 *
 * Pattern B = "PDF report + structured fields + underwriter
 * commentary, append-only with revision chain." Common shape:
 *
 *   id                     SERIAL PK
 *   deal_id                INT NOT NULL
 *   status                 VARCHAR — 'draft' | 'finalised' | 'superseded'
 *   document_id            INT — FK to deal_documents (nullable until uploaded)
 *   underwriter_commentary TEXT
 *   submitted_by_user_id   INT
 *   submitted_at           TIMESTAMPTZ
 *   finalised_by_user_id   INT
 *   finalised_at           TIMESTAMPTZ
 *   superseded_by_id       INT (self FK)
 *   superseded_at          TIMESTAMPTZ
 *
 * The factory exposes generic transitions that work against ANY
 * Pattern B table. Per-table services (e.g. valuations.js) add
 * type-specific create/update logic on top of these helpers.
 *
 * Sumit's design lock 2026-04-28:
 *   - Append-only — never UPDATE finalised rows in-place. Edits
 *     after finalisation = create new row + supersede the old one.
 *   - Document attachment is optional at draft time, required at
 *     finalisation (per-type validators decide which fields are
 *     mandatory; this layer is content-agnostic).
 *   - 6-month expiry computed at SELECT-time, not stored — see
 *     computeExpiryStatus() below.
 * ============================================================
 */

const pool = require('../db/pool');

// ------------------------------------------------------------
// 1. Status transitions (generic; per-table validators run BEFORE these)
// ------------------------------------------------------------

/**
 * Flip an evidence row from 'draft' to 'finalised'. Records who/when.
 * Idempotent — safe to call on already-finalised rows (no-op).
 *
 * @param {string} table   — 'deal_valuations' | 'deal_environmental' | …
 * @param {number} id      — PK of the row to finalise
 * @param {number} userId  — admin/underwriter doing the finalisation
 * @returns {Promise<object|null>} the finalised row, or null if not found
 */
async function finaliseEvidence(table, id, userId) {
  const result = await pool.query(
    `UPDATE ${table}
       SET status = 'finalised',
           finalised_by_user_id = COALESCE(finalised_by_user_id, $2),
           finalised_at = COALESCE(finalised_at, NOW())
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, userId]
  );
  if (result.rows[0]) return result.rows[0];
  // Already finalised? Return current row so caller doesn't see a phantom NULL.
  const fallback = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return fallback.rows[0] || null;
}

/**
 * Mark an old evidence row as superseded by a newer one.
 * Used for revisions (e.g. borrower commissions a re-val).
 *
 * Both rows must already exist. Caller is responsible for inserting
 * the new row first via the per-table create*() function.
 *
 * Updates BOTH rows atomically:
 *   - oldId: status='superseded', superseded_by_id=newId, superseded_at=NOW()
 *   - newId: superseded_by_id remains NULL (it's the new active head)
 *
 * @returns {Promise<object|null>} the newly-superseded row
 */
async function supersedeEvidence(table, oldId, newId, userId) {
  const result = await pool.query(
    `UPDATE ${table}
       SET status = 'superseded',
           superseded_by_id = $2,
           superseded_at = NOW()
     WHERE id = $1 AND superseded_by_id IS NULL
     RETURNING *`,
    [oldId, newId]
  );
  return result.rows[0] || null;
}

/**
 * Attach a deal_documents row to an evidence record. Idempotent.
 * Caller pre-uploads the PDF via existing /api/documents endpoints
 * which return the deal_documents.id; we just link it here.
 *
 * @param {string} table       — Pattern B table name
 * @param {number} id          — evidence row id
 * @param {number} documentId  — deal_documents.id
 */
async function attachDocument(table, id, documentId) {
  const result = await pool.query(
    `UPDATE ${table} SET document_id = $2 WHERE id = $1 RETURNING *`,
    [id, documentId]
  );
  return result.rows[0] || null;
}

// ------------------------------------------------------------
// 2. Active-row helpers
// ------------------------------------------------------------

/**
 * Predicate snippet for "active" evidence rows: finalised AND not superseded.
 * Embed in larger SELECTs — keeps the policy in one place so per-table
 * services don't drift.
 */
const ACTIVE_PREDICATE = `status = 'finalised' AND superseded_by_id IS NULL`;

/**
 * Generic "list active rows for a deal" helper. Per-table services usually
 * wrap this with table-specific JOINs (e.g. JOIN approved_valuers on valuer_id).
 */
async function listActiveForDeal(table, dealId) {
  const result = await pool.query(
    `SELECT * FROM ${table}
     WHERE deal_id = $1 AND ${ACTIVE_PREDICATE}
     ORDER BY finalised_at DESC NULLS LAST, id DESC`,
    [dealId]
  );
  return result.rows;
}

/**
 * Generic "list all rows for a deal" — drafts + finalised + superseded.
 * Useful for audit-trail UI showing the full revision chain.
 */
async function listAllForDeal(table, dealId) {
  const result = await pool.query(
    `SELECT * FROM ${table}
     WHERE deal_id = $1
     ORDER BY submitted_at DESC, id DESC`,
    [dealId]
  );
  return result.rows;
}

// ------------------------------------------------------------
// 3. Expiry computation (NOT a generated column — CURRENT_DATE
//    isn't immutable in Postgres). Computed at read-time.
// ------------------------------------------------------------

/**
 * Computes expiry state for a date-bound evidence record.
 * RICS lending-grade valuations expire at 6 months for drawdown.
 * This util is generic — pass any expiryMonths and any reference date.
 *
 * @param {Date|string|null} dateRef       — valuation_date / report_date / etc.
 * @param {number}           expiryMonths  — typically 6 for RICS val
 * @param {Date}             [now=new Date()]
 * @returns {object}
 *   {
 *     state: 'missing'|'valid'|'expiring_soon'|'expired',
 *     daysRemaining: number|null,   — negative if already expired
 *     expiresAt: string|null         — ISO date when it goes stale
 *   }
 *
 * Thresholds:
 *   - 'missing'        — dateRef is null/undefined
 *   - 'valid'          — > 30 days remaining
 *   - 'expiring_soon'  — 0-30 days remaining
 *   - 'expired'        — past expiry
 */
function computeExpiryStatus(dateRef, expiryMonths, now = new Date()) {
  if (!dateRef) {
    return { state: 'missing', daysRemaining: null, expiresAt: null };
  }
  const ref = new Date(dateRef);
  if (isNaN(ref.getTime())) {
    return { state: 'missing', daysRemaining: null, expiresAt: null };
  }
  const expiresAt = new Date(ref);
  expiresAt.setMonth(expiresAt.getMonth() + expiryMonths);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / msPerDay);
  let state;
  if (daysRemaining < 0) state = 'expired';
  else if (daysRemaining <= 30) state = 'expiring_soon';
  else state = 'valid';
  return {
    state,
    daysRemaining,
    expiresAt: expiresAt.toISOString().substring(0, 10)
  };
}

// ------------------------------------------------------------
// 4. Module exports
// ------------------------------------------------------------

module.exports = {
  finaliseEvidence,
  supersedeEvidence,
  attachDocument,
  listActiveForDeal,
  listAllForDeal,
  computeExpiryStatus,
  ACTIVE_PREDICATE
};
