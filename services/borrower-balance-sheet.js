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
  const [props, others, borrowerRow] = await Promise.all([
    listPortfolioForBorrower(borrowerId),
    listAssetsLiabsForBorrower(borrowerId),
    // Sprint 5 #24 — return borrower identity for directorships search prefill
    pool.query(
      `SELECT id, full_name, date_of_birth, ch_match_data
         FROM deal_borrowers WHERE id = $1`,
      [borrowerId]
    ).then(r => r.rows[0] || null)
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
    // Sprint 5 #24 — surface name + DoB for downstream UI (Find at CH prefill)
    full_name: borrowerRow ? borrowerRow.full_name : null,
    date_of_birth: borrowerRow ? borrowerRow.date_of_birth : null,
    has_ch_officer_id: !!(borrowerRow && borrowerRow.ch_match_data &&
      (borrowerRow.ch_match_data.officer_id || borrowerRow.ch_match_data.ch_officer_id)),
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

// ════════════════════════════════════════════════════════════
// Sprint 4 #20 (2026-04-28) — Per-UBO income & expenses
// ════════════════════════════════════════════════════════════

const IE_COLS = [
  'kind', 'category', 'description', 'amount',
  'frequency', 'ownership_pct', 'ownership_via', 'notes'
];

const VALID_IE_KIND = ['income', 'expense'];
const VALID_FREQUENCY = ['monthly', 'annually', 'one_off'];

const COMMON_IE_CATEGORIES = {
  income: ['employment', 'self_employment', 'rental', 'dividend', 'pension', 'investment', 'other_income'],
  expense: ['mortgage', 'rent', 'utilities', 'council_tax', 'living_costs', 'school_fees', 'insurance', 'other_expense']
};

// Convert any (amount, frequency) to a monthly figure for roll-ups.
// 'one_off' contributes 0 to monthly run-rate (still stored, just doesn't
// flow to monthly DSCR-style calculations).
function _toMonthly(amount, frequency) {
  const a = Number(amount || 0);
  if (!Number.isFinite(a)) return 0;
  switch ((frequency || 'monthly').toLowerCase()) {
    case 'annually':  return a / 12;
    case 'one_off':   return 0;
    case 'monthly':
    default:          return a;
  }
}

function _decorateIeRow(row) {
  if (!row) return row;
  const a = Number(row.amount || 0);
  const pct = Number(row.ownership_pct || 100) / 100;
  const monthly = _toMonthly(a, row.frequency);
  return Object.assign({}, row, {
    derived: {
      effective_amount: a * pct,
      monthly_gross: monthly,
      monthly_effective: monthly * pct
    }
  });
}

async function listIncomeExpensesForBorrower(borrowerId) {
  const r = await pool.query(
    `SELECT * FROM borrower_income_expenses
      WHERE borrower_id = $1 AND deleted_at IS NULL
      ORDER BY kind, id ASC`,
    [borrowerId]
  );
  return r.rows.map(_decorateIeRow);
}

async function listIncomeExpensesForDeal(dealId) {
  const r = await pool.query(
    `SELECT bie.*
       FROM borrower_income_expenses bie
       JOIN deal_borrowers db ON db.id = bie.borrower_id
      WHERE db.deal_id = $1 AND bie.deleted_at IS NULL
      ORDER BY bie.borrower_id, bie.kind, bie.id`,
    [dealId]
  );
  return r.rows.map(_decorateIeRow);
}

async function createIncomeExpenseRow(borrowerId, data, userId) {
  if (!data.kind || !VALID_IE_KIND.includes(data.kind)) {
    throw new Error(`kind must be one of: ${VALID_IE_KIND.join(', ')}`);
  }
  if (data.frequency && !VALID_FREQUENCY.includes(data.frequency)) {
    throw new Error(`frequency must be one of: ${VALID_FREQUENCY.join(', ')}`);
  }
  const cols = ['borrower_id', 'added_by_user_id'];
  const placeholders = ['$1', '$2'];
  const values = [borrowerId, userId];
  let i = 3;
  for (const c of IE_COLS) {
    if (data[c] !== undefined && data[c] !== null) {
      cols.push(c);
      placeholders.push('$' + i);
      values.push(data[c]);
      i++;
    }
  }
  const sql = `INSERT INTO borrower_income_expenses (${cols.join(', ')})
               VALUES (${placeholders.join(', ')})
               RETURNING *`;
  const r = await pool.query(sql, values);
  return _decorateIeRow(r.rows[0]);
}

async function updateIncomeExpenseRow(id, data) {
  if (data.kind !== undefined && !VALID_IE_KIND.includes(data.kind)) {
    throw new Error(`kind must be one of: ${VALID_IE_KIND.join(', ')}`);
  }
  if (data.frequency !== undefined && !VALID_FREQUENCY.includes(data.frequency)) {
    throw new Error(`frequency must be one of: ${VALID_FREQUENCY.join(', ')}`);
  }
  const sets = [];
  const values = [];
  let i = 1;
  for (const c of IE_COLS) {
    if (data[c] !== undefined) {
      sets.push(c + ' = $' + i);
      values.push(data[c]);
      i++;
    }
  }
  if (sets.length === 0) return await getIncomeExpenseRow(id);
  values.push(id);
  const r = await pool.query(
    `UPDATE borrower_income_expenses SET ${sets.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *`,
    values
  );
  return r.rows[0] ? _decorateIeRow(r.rows[0]) : null;
}

async function softDeleteIncomeExpenseRow(id) {
  const r = await pool.query(
    `UPDATE borrower_income_expenses
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [id]
  );
  return r.rows[0] || null;
}

async function getIncomeExpenseRow(id) {
  const r = await pool.query(
    `SELECT * FROM borrower_income_expenses WHERE id = $1`,
    [id]
  );
  return r.rows[0] ? _decorateIeRow(r.rows[0]) : null;
}

// Sprint 4 #21 — Consolidated rollups across ALL borrowers on a deal.
// No new tables; just SUMs across the per-borrower data.
async function getConsolidatedForDeal(dealId) {
  const [props, other, ie] = await Promise.all([
    listPortfolioForDeal(dealId),
    listAssetsLiabsForDeal(dealId),
    listIncomeExpensesForDeal(dealId)
  ]);

  // Property side
  const totalGrossMV    = props.reduce((s,p) => s + Number(p.market_value || 0), 0);
  const totalGrossMort  = props.reduce((s,p) => s + Number(p.mortgage_outstanding || 0), 0);
  const totalEffMV      = props.reduce((s,p) => s + Number((p.derived && p.derived.effective_market_value) || 0), 0);
  const totalEffMort    = props.reduce((s,p) => s + Number((p.derived && p.derived.effective_mortgage) || 0), 0);
  const totalEffEquity  = props.reduce((s,p) => s + Number((p.derived && p.derived.effective_equity) || 0), 0);
  const totalEffNetRent = props.reduce((s,p) => s + Number((p.derived && p.derived.net_rent_monthly_effective) || 0), 0);

  // Other A/L side
  const assetsArr = other.filter(r => r.kind === 'asset');
  const liabsArr  = other.filter(r => r.kind === 'liability');
  const totalEffAssets = assetsArr.reduce((s,r) => s + Number((r.derived && r.derived.effective_amount) || 0), 0);
  const totalEffLiabs  = liabsArr.reduce((s,r) => s + Number((r.derived && r.derived.effective_amount) || 0), 0);

  // Income/Expense side
  const incomes  = ie.filter(r => r.kind === 'income');
  const expenses = ie.filter(r => r.kind === 'expense');
  const monthlyIncome  = incomes.reduce((s,r) => s + Number((r.derived && r.derived.monthly_effective) || 0), 0);
  const monthlyExpense = expenses.reduce((s,r) => s + Number((r.derived && r.derived.monthly_effective) || 0), 0);

  return {
    deal_id: dealId,
    counts: {
      portfolio_properties: props.length,
      other_assets: assetsArr.length,
      other_liabilities: liabsArr.length,
      income_lines: incomes.length,
      expense_lines: expenses.length
    },
    consolidated_balance_sheet: {
      gross_property_value: totalGrossMV,
      gross_property_mortgage: totalGrossMort,
      effective_property_value: totalEffMV,
      effective_property_mortgage: totalEffMort,
      effective_property_equity: totalEffEquity,
      effective_other_assets: totalEffAssets,
      effective_other_liabilities: totalEffLiabs,
      effective_total_assets: totalEffMV + totalEffAssets,
      effective_total_liabilities: totalEffMort + totalEffLiabs,
      effective_consolidated_net_worth: totalEffEquity + totalEffAssets - totalEffLiabs
    },
    consolidated_income_expense: {
      effective_monthly_income: monthlyIncome,
      effective_monthly_expense: monthlyExpense,
      effective_monthly_net: monthlyIncome - monthlyExpense,
      effective_monthly_net_rent: totalEffNetRent
    },
    portfolio_properties: props,
    other_assets_liabilities: other,
    income_expenses: ie
  };
}

// Per-UBO income/expenses roll-up
async function getIncomeExpenseSummaryForBorrower(borrowerId) {
  const rows = await listIncomeExpensesForBorrower(borrowerId);
  const incomes = rows.filter(r => r.kind === 'income');
  const expenses = rows.filter(r => r.kind === 'expense');
  const monthlyIncome = incomes.reduce((s, r) => s + Number(r.derived.monthly_effective || 0), 0);
  const monthlyExpense = expenses.reduce((s, r) => s + Number(r.derived.monthly_effective || 0), 0);
  return {
    borrower_id: borrowerId,
    income_count: incomes.length,
    expense_count: expenses.length,
    effective_monthly_income: monthlyIncome,
    effective_monthly_expense: monthlyExpense,
    effective_monthly_net: monthlyIncome - monthlyExpense,
    incomes,
    expenses
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
  // Income / Expenses (Sprint 4 #20)
  listIncomeExpensesForBorrower,
  listIncomeExpensesForDeal,
  createIncomeExpenseRow,
  updateIncomeExpenseRow,
  softDeleteIncomeExpenseRow,
  getIncomeExpenseRow,
  getIncomeExpenseSummaryForBorrower,
  // Roll-up
  getNetWorthForBorrower,
  // Sprint 4 #21 — Consolidated rollups across UBOs
  getConsolidatedForDeal,
  // Constants
  PROP_COLS,
  ASSET_COLS,
  IE_COLS,
  VALID_KIND,
  VALID_IE_KIND,
  VALID_FREQUENCY,
  COMMON_CATEGORIES,
  COMMON_IE_CATEGORIES
};
