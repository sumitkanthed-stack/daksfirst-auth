#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 *  dump-deal-for-risk-rubric.js
 *  Daksfirst V5 — 2026-04-25
 *
 *  PURPOSE
 *  -------
 *  One-shot helper. Given a deal_id, query the live database and emit the
 *  six XML blocks the Risk Analysis rubric v2 expects, ready to paste into
 *  a Claude API console / Cowork chat alongside the rubric body.
 *
 *  Self-contained — vendors sensitivity-calculator + matrix-to-sensitivity
 *  mapper inline so it has zero dependencies on the v5 services (which are
 *  not yet deployed on Render). Only requires `pg`.
 *
 *  USAGE (Render shell)
 *  --------------------
 *      cd /opt/render/project/src/daksfirst-auth
 *      node /tmp/dump-deal-for-risk-rubric.js 32 > /tmp/deal32-rubric-input.md
 *      cat /tmp/deal32-rubric-input.md
 *
 *  Or locally with DATABASE_URL set:
 *      DATABASE_URL=postgres://... node dump-deal-for-risk-rubric.js 32 > out.md
 *
 *  ARGS
 *  ----
 *      deal_id   (required)   integer primary key on deal_submissions.id
 *      --stage   (optional)   dip | underwriting | pre_completion (default: dip)
 *
 *  OUTPUT
 *  ------
 *  stdout — six XML blocks separated by blank lines:
 *      <data_stage>...</data_stage>
 *      <macro_context>...</macro_context>      (placeholder for v1)
 *      <deal_facts>...</deal_facts>
 *      <matrix>...</matrix>
 *      <property_intelligence>...</property_intelligence>
 *      <parties_and_corporate>...</parties_and_corporate>
 *      <sensitivity_tables>...</sensitivity_tables>
 *
 *  All five DB-derived blocks come from one transaction at one point in
 *  time so the snapshot is internally consistent.
 * ──────────────────────────────────────────────────────────────────────── */

const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────────────────
//  Args
// ─────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dealIdArg = argv.find((a) => /^\d+$/.test(a));
if (!dealIdArg) {
  process.stderr.write('Usage: node dump-deal-for-risk-rubric.js <deal_id> [--stage=dip|underwriting|pre_completion]\n');
  process.exit(2);
}
const dealId = parseInt(dealIdArg, 10);

const stageArg = (argv.find((a) => a.startsWith('--stage=')) || '--stage=dip').split('=')[1];
const validStages = ['dip', 'underwriting', 'pre_completion'];
if (!validStages.includes(stageArg)) {
  process.stderr.write(`--stage must be one of: ${validStages.join(', ')}\n`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────
//  Pool
// ─────────────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set in environment.\n');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') || process.env.DATABASE_URL.includes('amazonaws.com')
    ? { rejectUnauthorized: false }
    : false,
});

// ─────────────────────────────────────────────────────────────────────────
//  Vendored: matrix-to-sensitivity-mapper (trimmed to the bits we need)
// ─────────────────────────────────────────────────────────────────────────

function normalizeInterestStructure(s) {
  if (!s || typeof s !== 'string') return 'rolled';
  const t = s.toLowerCase().trim();
  if (t.includes('serviced') || t.includes('monthly')) return 'serviced';
  if (t.includes('rolled')   || t.includes('roll'))    return 'rolled';
  if (t.includes('retain'))                            return 'retained';
  if (t.includes('partial')  || t.includes('part'))    return 'partial';
  return 'rolled';
}
function pickFirstNumber(...candidates) {
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function pickFirstString(...candidates) {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}
function safeNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function sumFinancialsByKeyword(financials, keywords) {
  if (!Array.isArray(financials) || !financials.length) return 0;
  const kws = keywords.map((k) => k.toLowerCase());
  let total = 0;
  for (const row of financials) {
    const desc = String(row.description || '').toLowerCase();
    if (kws.some((k) => desc.includes(k))) {
      total += Number(row.amount) || 0;
    }
  }
  return total;
}

function mapMatrixToSensitivityInputs(matrix, financials = [], primaryProperty = {}) {
  if (!matrix || typeof matrix !== 'object') {
    throw new Error('mapMatrixToSensitivityInputs: matrix object required');
  }
  const props = primaryProperty || {};

  const loan = pickFirstNumber(
    matrix.loan_amount_approved,
    matrix.loan_amount_requested,
    matrix.loan_amount,
  );
  const rateMonthly = pickFirstNumber(matrix.rate_approved, matrix.rate_requested);
  const termMonths  = pickFirstNumber(matrix.term_months_approved, matrix.term_months_requested, matrix.term_months);
  const exitStrategy = pickFirstString(matrix.exit_strategy_approved, matrix.exit_strategy_requested, matrix.exit_strategy);

  const brokerFeePct      = Number(matrix.broker_fee_pct) || 0;
  const brokerFeeFromPct  = brokerFeePct > 0 ? loan * (brokerFeePct / 100) : 0;
  const brokerFeeFromFin  = sumFinancialsByKeyword(financials, ['broker']);
  const brokerFeeGbp      = brokerFeeFromPct || brokerFeeFromFin;

  const legalFeesGbp    = sumFinancialsByKeyword(financials, ['legal', 'solicitor']);
  const valuationFeeGbp = sumFinancialsByKeyword(financials, ['valuation', 'survey']);

  return {
    loan_amount_gbp:           loan,
    rate_monthly_pct:          rateMonthly,
    arrangement_fee_pct:       Number(matrix.arrangement_fee_pct) || 0,
    arrangement_fee_flat_gbp:  Number(matrix.commitment_fee)      || 0,
    exit_fee_pct:              Number(matrix.exit_fee_pct)        || 0,
    term_months:               termMonths,
    property_value_gbp:        Number(matrix.current_value)       || pickFirstNumber(props.market_value),
    gdv_estimate_gbp:          Number(matrix.gdv)                 || pickFirstNumber(props.gdv),
    interest_structure:        normalizeInterestStructure(matrix.interest_servicing),
    exit_strategy:             exitStrategy.toLowerCase().includes('refin') ? 'refinance'
                              : exitStrategy.toLowerCase().includes('mix')   ? 'mixed'
                              : 'sale',
    legal_fees_gbp:            legalFeesGbp,
    valuation_fee_gbp:         valuationFeeGbp,
    broker_fee_gbp:            brokerFeeGbp,
    cost_to_complete_gbp:      Number(matrix.refurb_cost) || 0,
    sale_legal_pct:            1.5,
    sale_agent_pct:            1.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Vendored: sensitivity-calculator (full)
// ─────────────────────────────────────────────────────────────────────────

const CALCULATOR_VERSION = '1.0.0';
const MAX_LTV_THRESHOLD  = 0.75;
const VALUE_SHOCKS       = [0, -0.05, -0.10, -0.15, -0.20];
const RATE_SHOCKS_BPS    = [0, 50, 100, 150, 200];
const TERM_DELAYS        = [0, 3, 6];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function _pct(v) { return num(v) / 100; }
function round(v, dp = 2) {
  const m = Math.pow(10, dp);
  return Math.round(num(v) * m) / m;
}
function gbp(v) { return round(v, 0); }

function bpsToMonthly(annualBps, baseMonthlyRate) {
  return baseMonthlyRate + (annualBps / 10000) / 12;
}

function totalInterest(principal, monthlyRate, months, structure) {
  if (months <= 0 || monthlyRate <= 0 || principal <= 0) return 0;
  if (structure === 'serviced') return principal * monthlyRate * months;
  return principal * (Math.pow(1 + monthlyRate, months) - 1);
}

function buildScenario(matrix, opts) {
  const { valueShockPct = 0, rateShockBps = 0, monthsExtra = 0 } = opts || {};

  const loan        = num(matrix.loan_amount_gbp);
  const baseMonthly = _pct(matrix.rate_monthly_pct);
  const monthlyRate = bpsToMonthly(rateShockBps, baseMonthly);
  const months      = num(matrix.term_months) + monthsExtra;
  const structure   = matrix.interest_structure || 'rolled';

  const arrFeePct  = _pct(matrix.arrangement_fee_pct);
  const arrFeeFlat = num(matrix.arrangement_fee_flat_gbp);
  const exitFeePct = _pct(matrix.exit_fee_pct);
  const legalFees  = num(matrix.legal_fees_gbp);
  const valFee     = num(matrix.valuation_fee_gbp);
  const brokerFee  = num(matrix.broker_fee_gbp);

  const arrangementFee = (loan * arrFeePct) + arrFeeFlat;
  const exitFee        = loan * exitFeePct;
  const interest       = totalInterest(loan, monthlyRate, months, structure);

  const totalCostToBorrower = arrangementFee + interest + exitFee + legalFees + valFee + brokerFee;

  const baseValue     = num(matrix.property_value_gbp);
  const stressedValue = baseValue * (1 + valueShockPct);

  const upfrontDeductions = arrangementFee + legalFees + valFee + brokerFee
    + (structure === 'retained' ? interest : 0);
  const netDay1Advance    = loan - upfrontDeductions;
  const day1LTVPct        = baseValue > 0 ? (loan / baseValue) * 100 : null;

  const debtAtExit = loan + (structure === 'serviced' ? 0 : interest);
  const exitLTVPct = stressedValue > 0 ? (debtAtExit / stressedValue) * 100 : null;

  const saleLegalPct = _pct(matrix.sale_legal_pct ?? 1.5);
  const saleAgentPct = _pct(matrix.sale_agent_pct ?? 1.5);
  const saleCosts    = stressedValue * (saleLegalPct + saleAgentPct);
  const residualGbp  = stressedValue - debtAtExit - saleCosts - exitFee;

  return {
    loan: gbp(loan),
    monthsTotal: months,
    monthsExtra,
    monthlyRatePct: round(monthlyRate * 100, 4),
    arrangementFeeGbp: gbp(arrangementFee),
    exitFeeGbp: gbp(exitFee),
    interestGbp: gbp(interest),
    totalCostGbp: gbp(totalCostToBorrower),
    netDay1AdvanceGbp: gbp(netDay1Advance),
    propertyValueGbp: gbp(baseValue),
    stressedValueGbp: gbp(stressedValue),
    valueShockPct: round(valueShockPct * 100, 2),
    day1LTVPct: day1LTVPct === null ? null : round(day1LTVPct, 2),
    debtAtExitGbp: gbp(debtAtExit),
    exitLTVPct: exitLTVPct === null ? null : round(exitLTVPct, 2),
    saleCostsGbp: gbp(saleCosts),
    residualGbp: gbp(residualGbp),
    breachesPolicy75LTV: (exitLTVPct ?? 0) > MAX_LTV_THRESHOLD * 100,
  };
}

function findValueDropAtZeroResidual(matrix) {
  let lo = 0, hi = -0.50, ans = null;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const r = buildScenario(matrix, { valueShockPct: mid }).residualGbp;
    if (r > 0) { lo = mid; ans = mid; } else { hi = mid; }
  }
  return ans === null ? null : round(ans * 100, 2);
}
function findMonthsDelayAtBreach75LTV(matrix) {
  for (let extra = 0; extra <= 24; extra++) {
    const s = buildScenario(matrix, { monthsExtra: extra });
    if (s.exitLTVPct !== null && s.exitLTVPct > MAX_LTV_THRESHOLD * 100) return extra;
  }
  return null;
}

function computeSensitivity(matrix) {
  const base = buildScenario(matrix, {});
  const valueStress = VALUE_SHOCKS.map((s) => {
    const sc = buildScenario(matrix, { valueShockPct: s });
    return {
      shockPct: round(s * 100, 2),
      label: s === 0 ? 'Base case' : `Value ${(s * 100).toFixed(0)}%`,
      stressedValue: sc.stressedValueGbp,
      exitLTVPct: sc.exitLTVPct,
      residualGbp: sc.residualGbp,
      breachesPolicy: sc.breachesPolicy75LTV,
    };
  });
  const rateStress = RATE_SHOCKS_BPS.map((bps) => {
    const sc = buildScenario(matrix, { rateShockBps: bps });
    return {
      rateShockBps: bps,
      label: bps === 0 ? 'Base rate' : `+${bps} bps`,
      monthlyRatePct: sc.monthlyRatePct,
      interestGbp: sc.interestGbp,
      totalCostGbp: sc.totalCostGbp,
      residualGbp: sc.residualGbp,
    };
  });
  const termDelay = TERM_DELAYS.map((extra) => {
    const sc = buildScenario(matrix, { monthsExtra: extra });
    return {
      monthsExtra: extra,
      label: extra === 0 ? 'On-time exit' : `+${extra}m`,
      monthsTotal: sc.monthsTotal,
      interestGbp: sc.interestGbp,
      totalCostGbp: sc.totalCostGbp,
      exitLTVPct: sc.exitLTVPct,
      residualGbp: sc.residualGbp,
      breachesPolicy: sc.breachesPolicy75LTV,
    };
  });
  return {
    base: {
      loanGbp: base.loan,
      termMonths: base.monthsTotal,
      monthlyRatePct: base.monthlyRatePct,
      arrangementFeeGbp: base.arrangementFeeGbp,
      exitFeeGbp: base.exitFeeGbp,
      interestGbp: base.interestGbp,
      totalCostGbp: base.totalCostGbp,
      netDay1AdvanceGbp: base.netDay1AdvanceGbp,
      propertyValueGbp: base.propertyValueGbp,
      day1LTVPct: base.day1LTVPct,
      debtAtExitGbp: base.debtAtExitGbp,
      exitLTVPct: base.exitLTVPct,
      residualGbp: base.residualGbp,
      breachesPolicy75LTV: base.breachesPolicy75LTV,
    },
    valueStress,
    rateStress,
    termDelay,
    breakEven: {
      valueDropPctAtZeroResidual: findValueDropAtZeroResidual(matrix),
      monthsDelayAtBreach75LTV:   findMonthsDelayAtBreach75LTV(matrix),
    },
    metadata: {
      calculatorVersion: CALCULATOR_VERSION,
      calculatedAt: new Date().toISOString(),
      lendingCriteria: {
        maxLTVPct: MAX_LTV_THRESHOLD * 100,
        valueShocksPct: VALUE_SHOCKS.map((s) => round(s * 100, 2)),
        rateShocksBps: RATE_SHOCKS_BPS,
        termDelaysMonths: TERM_DELAYS,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Helpers — formatting
// ─────────────────────────────────────────────────────────────────────────

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function pickChimnieFields(propRow) {
  const out = {};
  for (const k of Object.keys(propRow).sort()) {
    if (k.startsWith('chimnie_') || k.startsWith('ptal_') || k === 'address' || k === 'postcode'
        || k === 'property_type' || k === 'tenure' || k === 'occupancy' || k === 'current_use'
        || k === 'market_value' || k === 'purchase_price' || k === 'gdv' || k === 'reinstatement'
        || k === 'title_number' || k === 'valuation_date' || k === 'insurance_sum'
        || k === 'security_charge_type' || k === 'existing_charges_note' || k === 'epc_rating'
        || k === 'epc_score' || k === 'land_registry_last_sale_price' || k === 'land_registry_last_sale_date') {
      out[k] = propRow[k];
    }
  }
  return out;
}

function safeJsonStringify(obj, indent = 2) {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && v.constructor && v.constructor.name === 'Date') {
      return v.toISOString();
    }
    return v;
  }, indent);
}

// ─────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────

(async () => {
  const client = await pool.connect();
  try {
    // ── 1. deal_submissions row (deal header + matrix JSONB) ─────────────
    const dealQ = await client.query(
      `SELECT * FROM deal_submissions WHERE id = $1`,
      [dealId]
    );
    if (dealQ.rowCount === 0) {
      process.stderr.write(`No deal_submissions row found for id=${dealId}\n`);
      process.exit(1);
    }
    const deal = dealQ.rows[0];
    // Matrix = the entire deal_submissions row. The 107 native columns
    // (loan_amount_approved, rate_approved, current_value, exit_strategy_*,
    //  arrangement_fee_pct, broker_fee_pct, interest_servicing_*, ...) ARE
    // the canonical matrix. The matrix_data JSONB is legacy/additive only —
    // merged on top so any straggler keys still surface.
    const matrix = { ...deal, ...(deal.matrix_data || {}) };

    // ── 2. deal_properties (all properties for this deal) ────────────────
    const propsQ = await client.query(
      `SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY market_value DESC NULLS LAST, id ASC`,
      [dealId]
    );
    const properties = propsQ.rows;
    const primaryProperty = properties[0] || {};

    // ── 3. deal_borrowers (parties — hierarchical) ───────────────────────
    const partiesQ = await client.query(
      `SELECT * FROM deal_borrowers
       WHERE deal_id = $1
       ORDER BY (parent_borrower_id IS NULL) DESC,
                CASE role
                  WHEN 'primary' THEN 1
                  WHEN 'joint' THEN 2
                  WHEN 'guarantor' THEN 3
                  WHEN 'director' THEN 4
                  ELSE 5
                END,
                id ASC`,
      [dealId]
    );
    const parties = partiesQ.rows;

    // ── 4. deal_financials (line-item fees) ──────────────────────────────
    const finQ = await client.query(
      `SELECT id, category, description, amount, frequency, holder, reference, notes
       FROM deal_financials
       WHERE deal_id = $1
       ORDER BY category, id ASC`,
      [dealId]
    );
    const financials = finQ.rows;

    // ── 5. Compute sensitivity ───────────────────────────────────────────
    const sensInputs = mapMatrixToSensitivityInputs(matrix, financials, primaryProperty);
    const sensitivity = computeSensitivity(sensInputs);

    // ─────────────────────────────────────────────────────────────────────
    //  Emit XML blocks
    // ─────────────────────────────────────────────────────────────────────

    const out = [];

    out.push(`<data_stage>${stageArg}</data_stage>`);
    out.push('');

    out.push('<macro_context>');
    out.push('PLACEHOLDER — April 2026 macro context block has not yet been drafted.');
    out.push('Treat this run as "neutral macro: no themes flagged this cycle."');
    out.push('Do not invent macro signals. Justify ONLY deal-intrinsic grading.');
    out.push('</macro_context>');
    out.push('');

    // deal_facts — concise human-readable summary
    out.push('<deal_facts>');
    const borrowerName = parties.find((p) => p.role === 'primary')?.full_name
                      || parties.find((p) => p.role === 'primary')?.company_name
                      || matrix.borrower_legal_name
                      || matrix.borrower_name
                      || '(unknown)';
    const totalSecurity = properties.reduce((acc, p) => acc + (Number(p.market_value) || 0), 0);
    out.push(`borrower_name: ${borrowerName}`);
    out.push(`asset_count: ${properties.length}`);
    out.push(`total_security_value_gbp: ${totalSecurity || '(unknown)'}  (${fmtMoney(totalSecurity)})`);
    out.push(`loan_amount_requested_gbp: ${matrix.loan_amount_requested ?? matrix.loan_amount ?? '(unknown)'}`);
    out.push(`loan_amount_approved_gbp: ${matrix.loan_amount_approved ?? '(not yet approved)'}`);
    out.push(`rate_requested_pct_per_month: ${matrix.rate_requested ?? '(unknown)'}`);
    out.push(`rate_approved_pct_per_month: ${matrix.rate_approved ?? '(not yet approved)'}`);
    out.push(`term_months: ${matrix.term_months_approved ?? matrix.term_months_requested ?? matrix.term_months ?? '(unknown)'}`);
    out.push(`exit_strategy: ${matrix.exit_strategy_approved ?? matrix.exit_strategy_requested ?? matrix.exit_strategy ?? '(unknown)'}`);
    out.push(`ltv_requested_pct: ${matrix.ltv_requested ?? '(derived from loan/value)'}`);
    out.push(`deal_stage: ${deal.deal_stage ?? '(unknown)'}`);
    out.push(`submission_id: ${deal.submission_id ?? '(none)'}`);
    out.push(`created_at: ${deal.created_at instanceof Date ? deal.created_at.toISOString() : deal.created_at}`);
    out.push('</deal_facts>');
    out.push('');

    // matrix — full canonical fact set
    out.push('<matrix>');
    out.push(safeJsonStringify(matrix));
    out.push('</matrix>');
    out.push('');

    // property_intelligence — Chimnie + PTAL per asset
    out.push('<property_intelligence>');
    if (properties.length === 0) {
      out.push('(no deal_properties rows — flag as missing data)');
    } else {
      properties.forEach((p, idx) => {
        const slim = pickChimnieFields(p);
        out.push(`=== Property ${idx + 1} of ${properties.length} (id=${p.id}) ===`);
        out.push(safeJsonStringify(slim));
        if (idx < properties.length - 1) out.push('');
      });
    }
    out.push('</property_intelligence>');
    out.push('');

    // parties_and_corporate — every party row + ch_match_data JSONB inline
    out.push('<parties_and_corporate>');
    if (parties.length === 0) {
      out.push('(no deal_borrowers rows — flag as missing data)');
    } else {
      parties.forEach((p, idx) => {
        out.push(`=== Party ${idx + 1} of ${parties.length} ===`);
        out.push(`role: ${p.role}`);
        out.push(`borrower_type: ${p.borrower_type || '(unknown)'}`);
        out.push(`parent_borrower_id: ${p.parent_borrower_id ?? '(top-level)'}`);
        out.push(`full_name: ${p.full_name || '(none)'}`);
        out.push(`company_name: ${p.company_name || '(none)'}`);
        out.push(`company_number: ${p.company_number || '(none)'}`);
        if (p.date_of_birth) out.push(`date_of_birth: ${p.date_of_birth instanceof Date ? p.date_of_birth.toISOString().slice(0, 10) : p.date_of_birth}`);
        if (p.nationality) out.push(`nationality: ${p.nationality}`);
        if (p.jurisdiction) out.push(`jurisdiction: ${p.jurisdiction}`);
        if (p.address) out.push(`address: ${p.address}`);
        if (p.kyc_status) out.push(`kyc_status: ${p.kyc_status}`);
        if (p.ch_matched_role) out.push(`ch_matched_role: ${p.ch_matched_role}`);
        if (p.ch_match_confidence) out.push(`ch_match_confidence: ${p.ch_match_confidence}`);
        if (p.ch_match_data) {
          out.push('companies_house_data:');
          out.push(safeJsonStringify(p.ch_match_data));
        }
        if (idx < parties.length - 1) out.push('');
      });
    }
    out.push('</parties_and_corporate>');
    out.push('');

    // sensitivity_tables — deterministic, calculated now
    out.push('<sensitivity_tables>');
    out.push(safeJsonStringify({
      sensitivity_inputs: sensInputs,
      sensitivity_output: sensitivity,
    }));
    out.push('</sensitivity_tables>');
    out.push('');

    // ── Audit footer (commented, not part of any block) ──────────────────
    out.push('<!--');
    out.push(`Generated: ${new Date().toISOString()}`);
    out.push(`Source DB: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
    out.push(`Deal ID: ${dealId}`);
    out.push(`Stage:   ${stageArg}`);
    out.push(`Properties found: ${properties.length}`);
    out.push(`Parties found:    ${parties.length}`);
    out.push(`Financials found: ${financials.length}`);
    out.push(`Calculator version: ${CALCULATOR_VERSION}`);
    out.push('-->');

    process.stdout.write(out.join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
