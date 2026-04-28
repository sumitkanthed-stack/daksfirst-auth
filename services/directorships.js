/**
 * services/directorships.js — Sprint 3 #18 (2026-04-28)
 * ============================================================
 * Pull, store, and surface CH "other directorships" for a given
 * individual borrower. Used by KYC enrichment.
 *
 * Trigger:
 *   - On corporate borrower CH verify, the existing flow stores each
 *     director/PSC as a deal_borrowers row with the CH officer_id in
 *     ch_match_data (or similar). When that row is created, this service
 *     is called with (borrower_id, officer_id) to pull all their other
 *     directorships and store them.
 *
 *   - Or manually via POST /api/admin/directorships/pull/:borrowerId
 *     (admin can re-pull at any time to refresh the snapshot).
 *
 * Display:
 *   - Aggregates: total / active / historical / troublesome counts
 *   - List filtered to troublesome by default; "show all" toggle in UI
 *
 * Risk packager:
 *   - ships aggregates + troublesome list only (NOT the full set)
 * ============================================================
 */

const pool = require('../db/pool');
const ch = require('./companies-house');

/**
 * Pull all appointments for an officer_id and store rows for the given
 * borrower_id. Replaces (delete + insert) any existing rows for that
 * borrower so re-pull always reflects current CH state.
 *
 * @returns {Promise<object>} { inserted, troublesome_count, total }
 */
async function pullAndStoreForBorrower(borrowerId, officerId) {
  if (!borrowerId || !officerId) {
    return { inserted: 0, troublesome_count: 0, total: 0, skipped: true };
  }
  const appts = await ch.getOfficerAppointments(officerId);
  if (!appts.length) {
    // Clear any existing rows so removed appointments don't linger
    await pool.query(`DELETE FROM borrower_other_directorships WHERE borrower_id = $1`, [borrowerId]);
    return { inserted: 0, troublesome_count: 0, total: 0 };
  }

  // Replace previous snapshot for this borrower
  await pool.query(`DELETE FROM borrower_other_directorships WHERE borrower_id = $1`, [borrowerId]);

  let inserted = 0;
  let troublesomeCount = 0;
  for (const a of appts) {
    const reasons = ch.classifyTroublesomeAppointment(a);
    if (reasons.length) troublesomeCount++;
    try {
      await pool.query(
        `INSERT INTO borrower_other_directorships
          (borrower_id, ch_officer_id, company_number, company_name,
           company_status, officer_role, appointment_date, resignation_date,
           troublesome_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          borrowerId,
          a.ch_officer_id,
          a.company_number,
          a.company_name,
          a.company_status,
          a.officer_role,
          a.appointment_date,
          a.resignation_date,
          reasons.length ? reasons : null
        ]
      );
      inserted++;
    } catch (err) {
      console.warn('[directorships] insert failed for', a.company_number, ':', err.message);
    }
  }

  return { inserted, troublesome_count: troublesomeCount, total: appts.length };
}

/**
 * Get the directorships summary for a borrower — aggregates + troublesome
 * list only (NOT the full set). What the rubric reads.
 */
async function getSummaryForBorrower(borrowerId) {
  const all = await pool.query(
    `SELECT * FROM borrower_other_directorships
      WHERE borrower_id = $1
      ORDER BY is_active DESC, appointment_date DESC NULLS LAST`,
    [borrowerId]
  );
  const total = all.rows.length;
  const active = all.rows.filter(r => r.is_active).length;
  const historical = total - active;
  const troublesome = all.rows.filter(r => r.is_troublesome);
  return {
    borrower_id: borrowerId,
    total_count: total,
    active_count: active,
    historical_count: historical,
    troublesome_count: troublesome.length,
    troublesome,    // surfaced rows
    last_pulled_at: all.rows.length ? all.rows[0].pulled_at : null
  };
}

/**
 * Get the FULL list (used by the "show all" toggle in the UI). Same
 * data the rubric does not need — just for admin transparency.
 */
async function getAllForBorrower(borrowerId) {
  const r = await pool.query(
    `SELECT * FROM borrower_other_directorships
      WHERE borrower_id = $1
      ORDER BY is_active DESC, appointment_date DESC NULLS LAST`,
    [borrowerId]
  );
  return r.rows;
}

/**
 * Aggregator across all individual borrowers on a deal — for the
 * risk packager's payload.
 */
async function getSummaryForDeal(dealId) {
  const r = await pool.query(
    `SELECT db.id AS borrower_id, db.full_name, db.role,
            COUNT(bod.id) FILTER (WHERE bod.id IS NOT NULL) AS total_count,
            COUNT(bod.id) FILTER (WHERE bod.is_active) AS active_count,
            COUNT(bod.id) FILTER (WHERE bod.is_troublesome) AS troublesome_count
       FROM deal_borrowers db
       LEFT JOIN borrower_other_directorships bod ON bod.borrower_id = db.id
      WHERE db.deal_id = $1
      GROUP BY db.id, db.full_name, db.role
      ORDER BY db.id`,
    [dealId]
  );
  // Get troublesome rows for each
  const summaries = [];
  for (const row of r.rows) {
    const trRes = await pool.query(
      `SELECT company_number, company_name, company_status, officer_role,
              appointment_date, resignation_date, troublesome_reasons
         FROM borrower_other_directorships
        WHERE borrower_id = $1 AND is_troublesome = TRUE
        ORDER BY appointment_date DESC NULLS LAST`,
      [row.borrower_id]
    );
    summaries.push({
      borrower_id: row.borrower_id,
      full_name: row.full_name,
      role: row.role,
      total_count: Number(row.total_count) || 0,
      active_count: Number(row.active_count) || 0,
      historical_count: (Number(row.total_count) || 0) - (Number(row.active_count) || 0),
      troublesome_count: Number(row.troublesome_count) || 0,
      troublesome: trRes.rows
    });
  }
  return summaries;
}

module.exports = {
  pullAndStoreForBorrower,
  getSummaryForBorrower,
  getAllForBorrower,
  getSummaryForDeal
};
