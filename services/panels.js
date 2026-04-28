/**
 * services/panels.js
 * ============================================================
 * Approved panel management — RICS valuers + conveyancing lawyers
 *
 * Both panels share an identical CRUD shape (admin-managed reference
 * tables with PI insurance + audit trail). Functions are factored
 * via _makePanelCrud(table) so the two panels reuse the same logic
 * with table-specific allowed-column whitelists.
 *
 * Sumit's architecture lock 2026-04-28:
 *   - Soft policy — off-panel use allowed but flagged in IA grade
 *     (see deal_valuations.valuer_off_panel_name fallback)
 *   - Status enum: active | suspended | removed (soft-delete only;
 *     never hard-delete because historic deals must keep valuer
 *     attribution intact)
 *   - approved_by_funder TEXT[] — distinguishes Daksfirst panel from
 *     funder-specific panels (GB Bank may have its own subset/superset)
 *   - CSV import for initial seed of historic firms
 *   - PI insurance + RICS/SRA regulation flags for compliance audit
 *
 * Used by:
 *   - routes/panels.js          — admin REST endpoints
 *   - admin/panels.html         — admin UI page
 *   - js/deal-matrix.js         — valuer dropdown when adding a RICS val
 *   - js/deal-matrix.js (later) — lawyer dropdown for solicitor block
 * ============================================================
 */

const pool = require('../db/pool');

// ------------------------------------------------------------
// 1. Whitelisted writable columns per table
//    Excludes id, status (changed via dedicated suspend/remove/restore),
//    added_by_user_id (set on insert), added_at (NOW default),
//    removed_* (set via remove()).
// ------------------------------------------------------------
const VALUER_COLUMNS = [
  'firm_name', 'firm_address', 'firm_postcode', 'firm_phone',
  'firm_email', 'firm_website', 'rics_regulated', 'rics_firm_number',
  'companies_house_number', 'specialisms', 'geographic_coverage',
  'approved_by_funder', 'pi_insurance_provider',
  'pi_insurance_amount_pence', 'pi_insurance_expiry', 'notes'
];

const LAWYER_COLUMNS = [
  'firm_name', 'firm_address', 'firm_postcode', 'firm_phone',
  'firm_email', 'firm_website', 'sra_regulated', 'sra_number',
  'companies_house_number', 'specialisms', 'geographic_coverage',
  'approved_by_funder', 'pi_insurance_provider',
  'pi_insurance_amount_pence', 'pi_insurance_expiry',
  'cdd_undertaking_signed', 'cdd_undertaking_date', 'notes'
];

// ------------------------------------------------------------
// 2. Generic panel CRUD factory
//    Returns { list, getById, create, update, suspend, remove,
//              restore, importCsv } closed over the table name.
// ------------------------------------------------------------
function _makePanelCrud(table, allowedCols) {

  /**
   * List firms with optional filters.
   * @param {Object} opts
   * @param {string} [opts.funder=null]   - 'daksfirst' | 'gb_bank' | etc.
   * @param {string} [opts.status='active'] - active|suspended|removed|'*' (all)
   * @param {string} [opts.search=null]   - case-insensitive firm_name match
   */
  async function list({ funder = null, status = 'active', search = null } = {}) {
    const wheres = [];
    const params = [];
    let i = 1;

    if (status !== '*') {
      wheres.push(`status = $${i++}`);
      params.push(status);
    }

    if (funder) {
      wheres.push(`$${i++} = ANY(approved_by_funder)`);
      params.push(funder);
    }

    if (search) {
      wheres.push(`firm_name ILIKE $${i++}`);
      params.push(`%${search}%`);
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM ${table} ${whereSql} ORDER BY firm_name ASC`,
      params
    );
    return result.rows;
  }

  async function getById(id) {
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return result.rows[0] || null;
  }

  /**
   * Create a new panel firm.
   * @param {Object} data    - whitelisted writable fields
   * @param {number} userId  - admin who is adding the firm
   */
  async function create(data, userId) {
    if (!data.firm_name || !String(data.firm_name).trim()) {
      throw new Error('firm_name is required');
    }

    const cols = ['added_by_user_id'];
    const placeholders = ['$1'];
    const values = [userId];
    let i = 2;

    for (const col of allowedCols) {
      if (data[col] !== undefined && data[col] !== null) {
        cols.push(col);
        placeholders.push(`$${i++}`);
        values.push(data[col]);
      }
    }

    const sql = `INSERT INTO ${table} (${cols.join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING *`;
    const result = await pool.query(sql, values);
    return result.rows[0];
  }

  /**
   * Update whitelisted fields. Status changes go through suspend/remove/restore.
   */
  async function update(id, data, userId) {
    const sets = [];
    const values = [];
    let i = 1;

    for (const col of allowedCols) {
      if (data[col] !== undefined) {
        sets.push(`${col} = $${i++}`);
        values.push(data[col]);
      }
    }

    if (sets.length === 0) {
      return await getById(id);
    }

    values.push(id);
    const sql = `UPDATE ${table} SET ${sets.join(', ')}
                 WHERE id = $${i}
                 RETURNING *`;
    const result = await pool.query(sql, values);
    return result.rows[0] || null;
  }

  /**
   * Soft-suspend (status='suspended'). Reversible via restore().
   * Reason appended to notes for audit trail.
   */
  async function suspend(id, userId, reason) {
    const result = await pool.query(
      `UPDATE ${table}
       SET status = 'suspended',
           notes = COALESCE(notes, '') || E'\n[Suspended ' || NOW()::text || ' by user ' || $2::text || ']: ' || $3
       WHERE id = $1
       RETURNING *`,
      [id, userId, reason || 'No reason given']
    );
    return result.rows[0] || null;
  }

  /**
   * Soft-remove (status='removed'). Reversible via restore().
   * Records removed_by_user_id, removed_at, removed_reason for compliance audit.
   */
  async function remove(id, userId, reason) {
    const result = await pool.query(
      `UPDATE ${table}
       SET status = 'removed',
           removed_by_user_id = $2,
           removed_at = NOW(),
           removed_reason = $3
       WHERE id = $1
       RETURNING *`,
      [id, userId, reason || 'No reason given']
    );
    return result.rows[0] || null;
  }

  /**
   * Restore from suspended/removed back to active.
   * Clears removed_* audit columns; suspension audit stays in notes.
   */
  async function restore(id, userId) {
    const result = await pool.query(
      `UPDATE ${table}
       SET status = 'active',
           removed_by_user_id = NULL,
           removed_at = NULL,
           removed_reason = NULL,
           notes = COALESCE(notes, '') || E'\n[Restored ' || NOW()::text || ' by user ' || $2::text || ']'
       WHERE id = $1
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Bulk insert from CSV-parsed rows. Each row must include firm_name.
   * Invalid rows get collected in errors[] without rolling back valid ones.
   */
  async function importCsv(rows, userId) {
    let inserted = 0;
    const errors = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      try {
        await create(row, userId);
        inserted++;
      } catch (err) {
        errors.push({
          rowIndex: idx,
          firm_name: row.firm_name || '?',
          error: err.message
        });
      }
    }
    return { inserted, errors, total: rows.length };
  }

  return { list, getById, create, update, suspend, remove, restore, importCsv };
}

// ------------------------------------------------------------
// 3. Build per-panel APIs
// ------------------------------------------------------------
const valuersCrud = _makePanelCrud('approved_valuers', VALUER_COLUMNS);
const lawyersCrud = _makePanelCrud('approved_lawyers', LAWYER_COLUMNS);

// ------------------------------------------------------------
// 4. Module exports — distinct names so callers don't have to
//    pass a 'panel type' string everywhere.
// ------------------------------------------------------------
module.exports = {
  // Valuers
  listValuers:       valuersCrud.list,
  getValuer:         valuersCrud.getById,
  createValuer:      valuersCrud.create,
  updateValuer:      valuersCrud.update,
  suspendValuer:     valuersCrud.suspend,
  removeValuer:      valuersCrud.remove,
  restoreValuer:     valuersCrud.restore,
  importValuersCsv:  valuersCrud.importCsv,

  // Lawyers
  listLawyers:       lawyersCrud.list,
  getLawyer:         lawyersCrud.getById,
  createLawyer:      lawyersCrud.create,
  updateLawyer:      lawyersCrud.update,
  suspendLawyer:     lawyersCrud.suspend,
  removeLawyer:      lawyersCrud.remove,
  restoreLawyer:     lawyersCrud.restore,
  importLawyersCsv:  lawyersCrud.importCsv,

  // Whitelists exposed for routes/admin UI to validate inbound payloads
  VALUER_COLUMNS,
  LAWYER_COLUMNS
};
