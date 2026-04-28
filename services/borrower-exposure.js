/**
 * services/borrower-exposure.js
 * ============================================================
 * Cross-deal borrower concentration aggregator.
 *
 * Given a deal, finds OTHER Daksfirst deals whose borrowers match this
 * deal's borrowers, and returns count + total exposure for each. Match
 * keys (in priority order):
 *   1. company_number     — most reliable for corporate borrowers
 *   2. lower(trim(email)) — individuals with consistent email
 *   3. lower(trim(full_name)) + date_of_birth — last-resort match for
 *      individuals when no email/CH match exists
 *
 * Match scope crosses BOTH deal_submissions native cols (legacy primary
 * borrower captured pre-Phase G) AND deal_borrowers rows (Phase G+
 * hierarchical model with joints/guarantors/UBOs/PSCs).
 *
 * Sumit's design lock 2026-04-28:
 *   - Auto-aggregate at deal-page load — no manual trigger
 *   - Show on top of the Borrower section as a one-line widget
 *   - Click → modal with all linked deals + their stages + loan amounts
 *   - Origination scope only — does NOT track repayment history (LMS)
 * ============================================================
 */

const pool = require('../db/pool');

// Stages we consider "active" for concentration purposes — exclude these:
const TERMINAL_STAGES = new Set([
  'rejected', 'withdrawn', 'cancelled', 'declined',
  'completed', 'redeemed', 'closed', 'archived'
]);

function _normEmail(e) {
  return e ? String(e).toLowerCase().trim() : null;
}

function _normName(n) {
  return n ? String(n).toLowerCase().trim().replace(/\s+/g, ' ') : null;
}

/**
 * Get exposure summary for a deal.
 * @param {number} dealId — deal_submissions.id
 * @returns {Promise<object>} {
 *   other_deals_count, active_other_deals,
 *   total_loan_other, total_loan_active_other,
 *   match_keys: { company_numbers, emails, name_dob_pairs },
 *   deals: [...]
 * }
 */
async function getExposureForDeal(dealId) {
  if (!dealId) return _emptyExposure();

  // 1. Collect ALL borrower identifiers for this deal — from deal_submissions
  //    AND deal_borrowers (covers legacy + Phase G hierarchical).
  const idResult = await pool.query(
    `SELECT
       ds.company_number       AS ds_company_number,
       ds.borrower_email       AS ds_borrower_email,
       ds.borrower_name        AS ds_borrower_name,
       ds.borrower_dob         AS ds_borrower_dob,
       db.id                   AS db_id,
       db.full_name            AS db_full_name,
       db.email                AS db_email,
       db.company_number       AS db_company_number,
       db.date_of_birth        AS db_dob,
       db.borrower_type        AS db_type
     FROM deal_submissions ds
     LEFT JOIN deal_borrowers db ON db.deal_id = ds.id
     WHERE ds.id = $1`,
    [dealId]
  );

  if (idResult.rows.length === 0) return _emptyExposure();

  const companyNumbers = new Set();
  const emails = new Set();
  const nameDobPairs = new Set(); // 'name|yyyy-mm-dd'

  for (const r of idResult.rows) {
    if (r.ds_company_number) companyNumbers.add(r.ds_company_number);
    if (r.db_company_number) companyNumbers.add(r.db_company_number);
    const dse = _normEmail(r.ds_borrower_email);
    if (dse) emails.add(dse);
    const dbe = _normEmail(r.db_email);
    if (dbe) emails.add(dbe);
    // name+DOB pairs (last-resort)
    if (r.ds_borrower_dob && r.ds_borrower_name) {
      nameDobPairs.add(_normName(r.ds_borrower_name) + '|' + String(r.ds_borrower_dob).substring(0, 10));
    }
    if (r.db_dob && r.db_full_name) {
      nameDobPairs.add(_normName(r.db_full_name) + '|' + String(r.db_dob).substring(0, 10));
    }
  }

  const cnArr = Array.from(companyNumbers);
  const emArr = Array.from(emails);
  const ndArr = Array.from(nameDobPairs);

  if (cnArr.length === 0 && emArr.length === 0 && ndArr.length === 0) {
    return _emptyExposure({
      match_keys: { company_numbers: cnArr, emails: emArr, name_dob_pairs: ndArr }
    });
  }

  // 2. Find OTHER deals (different submission_id) where ANY identifier matches.
  //    DISTINCT to avoid counting the same deal twice if it matches via
  //    multiple keys.
  const otherDeals = await pool.query(
    `SELECT DISTINCT
       ds.id, ds.submission_id, ds.deal_stage, ds.status,
       ds.borrower_name, ds.borrower_company, ds.company_number,
       ds.loan_amount_approved, ds.loan_amount,
       ds.created_at, ds.updated_at
     FROM deal_submissions ds
     LEFT JOIN deal_borrowers db ON db.deal_id = ds.id
     WHERE ds.id <> $1
       AND (
         ($2::text[] IS NOT NULL AND (ds.company_number = ANY($2::text[]) OR db.company_number = ANY($2::text[])))
         OR
         ($3::text[] IS NOT NULL AND (
            LOWER(TRIM(ds.borrower_email)) = ANY($3::text[]) OR
            LOWER(TRIM(db.email)) = ANY($3::text[])
         ))
         OR
         ($4::text[] IS NOT NULL AND (
            (LOWER(TRIM(ds.borrower_name)) || '|' || COALESCE(SUBSTRING(ds.borrower_dob::text, 1, 10), '')) = ANY($4::text[]) OR
            (LOWER(TRIM(db.full_name))    || '|' || COALESCE(SUBSTRING(db.date_of_birth::text, 1, 10), '')) = ANY($4::text[])
         ))
       )
     ORDER BY ds.created_at DESC`,
    [
      dealId,
      cnArr.length ? cnArr : null,
      emArr.length ? emArr : null,
      ndArr.length ? ndArr : null
    ]
  );

  // 3. Aggregate
  const list = otherDeals.rows;
  const totalLoan = list.reduce((s, d) => s + Number(d.loan_amount_approved || d.loan_amount || 0), 0);
  const activeList = list.filter(d => !TERMINAL_STAGES.has(String(d.deal_stage || '').toLowerCase()));
  const totalLoanActive = activeList.reduce((s, d) => s + Number(d.loan_amount_approved || d.loan_amount || 0), 0);

  return {
    other_deals_count: list.length,
    active_other_deals: activeList.length,
    total_loan_other: totalLoan,
    total_loan_active_other: totalLoanActive,
    match_keys: {
      company_numbers: cnArr,
      emails: emArr,
      name_dob_pairs: ndArr
    },
    deals: list.map(d => ({
      id: d.id,
      submission_id: d.submission_id,
      deal_stage: d.deal_stage,
      status: d.status,
      is_active: !TERMINAL_STAGES.has(String(d.deal_stage || '').toLowerCase()),
      borrower_name: d.borrower_name,
      borrower_company: d.borrower_company,
      company_number: d.company_number,
      loan_amount: Number(d.loan_amount_approved || d.loan_amount || 0),
      created_at: d.created_at,
      updated_at: d.updated_at
    }))
  };
}

function _emptyExposure(extra) {
  return Object.assign({
    other_deals_count: 0,
    active_other_deals: 0,
    total_loan_other: 0,
    total_loan_active_other: 0,
    match_keys: { company_numbers: [], emails: [], name_dob_pairs: [] },
    deals: []
  }, extra || {});
}

module.exports = { getExposureForDeal };
