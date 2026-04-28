/**
 * services/borrower-balance-sheet.js
 * ============================================================
 * Per-UBO balance sheet — portfolio properties + other assets/liabilities.
 *
 * Two tables (Sprint 3 #17, 2026-04-28):
 *   borrower_portfolio_properties
 *   borrower_other_assets_liabilities
 *
 * Both keyed on borrower_id → deal_borrowers(id), so any individual
 * party (primary, joint, guarantor, director, PSC, UBO) can have their
 * own balance sheet captured.
 *
 * ownership_pct + ownership_via track partial / indirect ownership
 * (e.g. 50% owned jointly with spouse, or 30% via SPV X). Effective
 * economic interest = amount × ownership_pct / 100.
 *
 * Net worth roll-up:
 *   Effective property equity = Σ ((market_value − mortgage_outstanding) × pct/100)
 *   Effective other assets    = Σ (asset_amount × pct/100)
 *   Effective other liabilities = Σ (liability_amount × pct/100)
 *   Effective net worth = property_equity + other_assets − other_liabilities
 * ============================================================
 */

const pool = require('../db/pool');

const PROP_COLS = [
  'address', 'postcode', 'property_type', 'tenure', 'occupancy',
  'market_value', 'mortgage_outstanding', 'mortgage_lender', 'mortgage_rate_pct_pa',
  'monthly_rent', 'monthly_interest',
  'ownership_pct', 'ownership_via', 'notes'
];

const ASSET_COLS = [
  'kind', 'category', 'description', 'amount',
  'ownership_pct', 'ownership_via', 'notes'
];

const VALID_KIND = ['asset', 'liability'];
const COMMON_CATEGORIES = {
  asset: ['cash', 'investment', 'director_loan_receivable', 'pension', 'business_share', 'other_asset'],
  liability: ['personal_loan', 'credit_card', 'overdraft', 'director_loan_payable', 'tax_owed', 'other_liability']
};

// ─────────────────────────────────────────────────
// Portfolio properties CRUD
// ─────────────────────────────────────────────────

async function listPortfolioForBorrower(borrowerId) {
  const r = await pool.query(
    `SELECT * FROM borrower_portfolio_properties
      WHERE borrower_id = $1 AND deleted_at IS NULL
      ORDER BY id ASC`,
    [borrowerId]
  );
  return r.rows.map(_decoratePortfolioRow);
}

async function listPortfolioForDeal(dealId) {
  // Aggregator across all borrowers on a deal — used by risk packager.
  const r = await pool.query(
    `SELECT bpp.*
       FROM borrower_portfolio_properties bpp
       JOIN deal_borrowers db ON db.id = bpp.borrower_id
      WHERE db.deal_id = $1 AND bpp.deleted_at IS NULL
      ORDER BY bpp.borrower_id, bpp.id`,
    [dealId]
  );
  return r.rows.map(_decoratePortfolioRow);
}

async function createPortfolioRow(borrowerId, data, userId) {
  const cols = ['borrower_id', 'added_by_user_id'];
  const placeholders = ['$1', '$2'];
  const values = [borrowerId, userId];
  let i = 3;
  for (const c of PROP_COLS) {
    if (data[c] !== undefined && data[c] !== null) {
      cols.push(c);
      placeholders.push('$' + i);
      values.push(data[c]);
      i++;
    }
  }
  const sql = `INSERT INTO borrower_portfolio_properties (${cols.join(', ')})
               VALUES (${placeholders.join(', ')})
               RETURNING *`;
  const r = await pool.query(sql, values);
  return _decoratePortfolioRow(r.rows[0]);
}

async function updatePortfolioRow(id, data) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const c of PROP_COLS) {
    if (data[c] !== undefined) {
      sets.push(c + ' = $' + i);
      values.push(data[c]);
      i++;
    }
  }
  if (sets.length === 0) return await getPortfolioRow(id);
  values.push(id);
  const r = await pool.query(
    `UPDATE borrower_portfolio_properties SET ${sets.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *`,
    values
  );
  return r.rows[0] ? _decoratePortfolioRow(r.rows[0]) : null;
}

async function softDeletePortfolioRow(id) {
  const r = await pool.query(
    `UPDATE borrower_portfolio_properties
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [id]
  );
  return r.rows[0] || null;
}

async function getPortfolioRow(id) {
  const r = await pool.query(
    `SELECT * FROM borrower_portfolio_properties WHERE id = $1`,
    [id]
  );
  return r.rows[0] ? _decoratePortfolioRow(r.rows[0]) : null;
}

function _decoratePortfolioRow(row) {
  if (!row) return row;
  const mv = Number(row.market_value || 0);
  const mort = Number(row.mortgage_outstanding || 0);
  const pct = Number(row.ownership_pct || 100) / 100;
  const grossEquity = mv - mort;
  const netRentMonthly = Number(row.monthly_rent || 0) - Number(row.monthly_interest || 0);
  return Object.assign({}, row, {
    derived: {
      gross_equity: grossEquity,
      effective_equity: grossEquity * pct,
      effective_market_value: mv * pct,
      effective_mortgage: mort * pct,
      net_rent_monthly_gross: netRentMonthly,
      net_rent_monthly_effective: netRentMonthly * pct
    }
  });
}

// ─────────────────────────────────────────────────
// Other assets/liabilities CRUD
// ─────────────────────────────────────────────────

async function listAssetsLiabsForBorrower(borrowerId) {
  const r = await pool.query(
    `SELECT * FROM borrower_other_assets_liabilities
      WHERE borrower_id = $1 AND deleted_at IS NULL
      ORDER BY kind, id ASC`,
    [borrowerId]
  );
  return r.rows.map(_decorateAssetRow);
}

async function listAssetsLiabsForDeal(dealId) {
  const r = await pool.query(
    `SELECT boal.*
       FROM borrower_other_assets_liabilities boal
       JOIN deal_borrowers db ON db.id = boal.borrower_id
      WHERE db.deal_id = $1 AND boal.deleted_at IS NULL
      ORDER BY boal.borrower_id, boal.kind, boal.id`,
    [dealId]
  );
  return r.rows.map(_decorateAssetRow);
}

async function createAssetLiabRow(borrowerId, data, userId) {
  if (!data.kind || !VALID_KIND.includes(data.kind)) {
    throw new Error(`kind must be one of: ${VALID_KIND.join(', ')}`);
  }
  const cols = ['borrower_id', 'added_by_user_id'];
  const placeholders = ['$1', '$2'];
  const values = [borrowerId, userId];
  let i = 3;
  for (const c of ASSET_COLS) {
    if (data[c] !== undefined && data[c] !== null) {
      cols.push(c);
      placeholders.push('$' + i);
      values.push(data[c]);
      i++;
    }
  }
  const sql = `INSERT INTO borrower_other_assets_liabilities (${cols.join(', ')})
               VALUES (${placeholders.join(', ')})
               RETURNING *`;
  const r = await pool.query(sql, values);
  return _decorateAssetRow(r.rows[0]);
}

async function updateAssetLiabRow(id, data) {
  if (data.kind !== undefined && !VALID_KIND.includes(data.kind)) {
    throw new Error(`kind must be one of: ${VALID_KIND.join(', ')}`);
  }
  const sets = [];
  const values = [];
  let i = 1;
  for (const c of ASSET_COLS) {
    if (data[c] !== undefined) {
      sets.push(c + ' = $' + i);
      values.push(data[c]);
      i++;
    }
  }
  if (sets.length === 0) return await getAssetLiabRow(id);
  values.push(id);
  const r = await pool.query(
    `UPDATE borrower_other_assets_liabilities SET ${sets.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *`,
    values
  );
  return r.rows[0] ? _decorateAssetRow(r.rows[0]) : null;
}

async function softDeleteAssetLiabRow(id) {
  const r = await pool.query(
    `UPDATE borrower_other_assets_liabilities
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [id]
  );
  return r.rows[0] || null;
}

async function getAssetLiabRow(id) {
  const r = await pool.query(
    `SELECT * FROM borrower_other_assets_liabilities WHERE id = $1`,
    [id]
  );
  return r.rows[0] ? _decorateAssetRow(r.rows[0]) : null;
}

function _decorateAssetRow(row) {
  if (!row) return row;
  const amt = Number(row.amount || 0);
  const pct = Number(row.ownership_pct || 100) / 100;
  return Object.assign({}, row, {
    derived: {
      effective_amount: amt * pct
    }
  });
}

// ─────────────────────────────────────────────────
// Net worth roll-up per borrower
// ─────────────────────────────────────────────────

async function getNetWorthForBorrower(borrowerId) {
  const [props, others] = await Promise.all([
    listPortfolioForBorrower(borrowerId),
    listAssetsLiabsForBorrower(borrowerId)
  ]);

  const effPropertyEquity = props.reduce((s, r) => s + Number(r.derived.effective_equity || 0), 0);
  const effOtherAssets = others
    .filter(r => r.kind === 'asset')
    .reduce((s, r) => s + Number(r.derived.effective_amount || 0), 0);
  const effOtherLiabs = others
    .filter(r => r.kind === 'liability')
    .reduce((s, r) => s + Number(r.derived.effective_amount || 0), 0);

  const netWorth = effPropertyEquity + effOtherAssets - effOtherLiabs;

  const monthlyNetRentEffective = props.reduce(
    (s, r) => s + Number(r.derived.net_rent_monthly_effective || 0), 0
  );

  return {
    borrower_id: borrowerId,
    portfolio_properties_count: props.length,
    other_assets_count: others.filter(r => r.kind === 'asset').length,
    other_liabilities_count: others.filter(r => r.kind === 'liability').length,
    effective_property_equity: effPropertyEquity,
    effective_other_assets: effOtherAssets,
    effective_other_liabilities: effOtherLiabs,
    effective_net_worth: netWorth,
    effective_monthly_net_rent: monthlyNetRentEffective,
    portfolio: props,
    other_assets_liabilities: others
  };
}

module.exports = {
  // Portfolio properties
  listPortfolioForBorrower,
  listPortfolioForDeal,
  createPortfolioRow,
  updatePortfolioRow,
  softDeletePortfolioRow,
  getPortfolioRow,
  // Other A/L
  listAssetsLiabsForBorrower,
  listAssetsLiabsForDeal,
  createAssetLiabRow,
  updateAssetLiabRow,
  softDeleteAssetLiabRow,
  getAssetLiabRow,
  // Roll-up
  getNetWorthForBorrower,
  // Constants
  PROP_COLS,
  ASSET_COLS,
  VALID_KIND,
  COMMON_CATEGORIES
};
