/**
 * Risk Analysis Packager — V5 Risk MVP step 6 (2026-04-25)
 *
 * Assembles the input_payload that n8n's Risk Analysis Standalone workflow
 * sends to Anthropic for rubric grading. ONE function in, ONE envelope out.
 * No LLM call, no DB write — pure assembly.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  POLICY (inherited from deal-feature-packager, set by Sumit 2026-04-22):
 *    SEND EVERYTHING. No PII stripping. The rubric's Information Quality
 *    dimension explicitly grades how complete the data is — withholding
 *    fields would corrupt the grade. See feedback_credit_analysis_sends_full_data.md
 *
 *  ARCHITECTURE: auth = data collector. No rules / scores / decisions here.
 *    See feedback_auth_is_data_collector_not_decider.md
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Reuses services/deal-feature-packager.js (M1) for the matrix envelope —
 * single source of truth for "what does a deal look like as JSON". This
 * service only adds the risk-specific outer shell:
 *   - pins the active rubric + macro prompt versions at packaging time
 *   - resolves data_stage to one of dip|underwriting|post_completion
 *   - attaches Companies House snapshots for any company_number borrowers
 *   - records a source_provenance summary the rubric can grade
 *
 * Output shape (stable — n8n's "Build Risk Prompt" node expects this):
 *   {
 *     schema_version: 2,                    // Sprint 5 #27 bumped from 1
 *     deal_id, submission_id, data_stage, packaged_at,
 *     rubric:  { prompt_key, version, prompt_id },
 *     macro:   { prompt_key, version, prompt_id },
 *     taxonomy_version: 'tax_v1',
 *     taxonomy: {
 *       version, determinants:[9], sectors:[6], grade_scale:{...}
 *     },
 *     sensitivity_calculator_version,
 *     features: { deal, borrowers, properties },
 *     companies_house: [ { company_number, ... } ],
 *     credit_checks:   [ ... ],             // Experian (EXP-B7)
 *     kyc_checks:      [ ... ],             // SmartSearch (SS-B8)
 *     valuations:      [ ... ],             // RICS Pattern B (Sprint 1b/2)
 *     directorships:   [ ... ],             // CH directorships (Sprint 3 #18)
 *     // Sprint 5 #27 (2026-04-28) — Sprint 3+4 data joins payload:
 *     balance_sheet: {
 *       consolidated: { counts, balance_sheet, income_expense,
 *                       annualised_disposable, ubo_count_with_data },
 *       per_ubo: [ { borrower_id, full_name, role, counts,
 *                   balance_sheet, income_expense,
 *                   months_runway_at_zero_income } ]
 *     },
 *     borrower_exposure: null | {            // concentration across deals
 *       other_deals_count, active_other_deals, total_loan_other,
 *       total_loan_active_other, match_keys_used, top_active_deals[3]
 *     },
 *     sources_uses: {                        // S&U computed summary
 *       primary_use_type, totals, uses_breakdown, sources_breakdown, ratios
 *     },
 *     source_provenance: { ... },
 *     feature_hash:     <sha256 of features>,
 *     risk_payload_hash: <sha256 of full payload incl. version pins>
 *   }
 *
 * The risk_payload_hash differs from feature_hash because risk_view rows
 * must be reproducible against the EXACT rubric/macro version pinned at
 * run time — re-grading a deal under prior rubric is a memory promise
 * (see project_risk_mvp_db_shipped_2026_04_25.md).
 */

const crypto = require('crypto');
const pool = require('../db/pool');
const featurePackager = require('./deal-feature-packager');
const valuationsService = require('./valuations');
const directorshipsService = require('./directorships');
// Sprint 5 #27 (2026-04-28) — wire balance sheet + I/E + exposure into payload
const balanceSheetService = require('./borrower-balance-sheet');
const exposureService = require('./borrower-exposure');

// Bumped to 2 (2026-04-28) when Sprint 3+4 data joined the payload:
// balance_sheet (consolidated + per_ubo aggregates), income_expenses (per_ubo),
// borrower_exposure (concentration), sources_uses (computed summary).
// Rubric prompts pinned to risk_view rows continue grading against the
// schema_version they were captured under — older runs unaffected.
const SCHEMA_VERSION = 2;
const DEFAULT_SENSITIVITY_VERSION = 'v5.1';
const VALID_STAGES = ['dip', 'underwriting', 'post_completion'];

// --- Active prompt resolution ---

async function loadActivePrompt(promptKey) {
  const { rows } = await pool.query(
    `SELECT id, prompt_key, version
       FROM llm_prompts
      WHERE prompt_key = $1 AND is_active = TRUE
      LIMIT 1`,
    [promptKey]
  );
  if (rows.length === 0) {
    throw new Error(
      `risk-packager: no active version found for prompt_key '${promptKey}'. ` +
      `Seed via migration or upload via /admin/prompts.`
    );
  }
  const r = rows[0];
  return { prompt_key: r.prompt_key, version: r.version, prompt_id: r.id };
}

// --- Active taxonomy resolution ---

async function loadActiveTaxonomy() {
  const { rows: vRows } = await pool.query(
    `SELECT version
       FROM risk_taxonomy_versions
      WHERE is_active = TRUE
      LIMIT 1`
  );
  if (vRows.length === 0) {
    throw new Error(
      'risk-packager: no active risk_taxonomy version. ' +
      'Seed via migration (tax_v1) or activate via /admin/taxonomy.'
    );
  }
  const version = vRows[0].version;

  const { rows } = await pool.query(
    `SELECT kind, node_key, label, ordering, metadata
       FROM risk_taxonomy
      WHERE version = $1 AND is_active = TRUE
      ORDER BY kind, ordering, node_key`,
    [version]
  );

  const determinants = rows
    .filter((r) => r.kind === 'determinant')
    .map((r) => ({
      key:      r.node_key,
      label:    r.label,
      ordering: r.ordering,
      metadata: r.metadata || {},
    }));

  const sectors = rows
    .filter((r) => r.kind === 'sector')
    .map((r) => ({
      key:      r.node_key,
      label:    r.label,
      ordering: r.ordering,
      metadata: r.metadata || {},
    }));

  const gradeScaleRow = rows.find(
    (r) => r.kind === 'config' && r.node_key === 'grade_scale'
  );

  if (determinants.length === 0) {
    throw new Error(
      `risk-packager: taxonomy version '${version}' has zero active determinants.`
    );
  }
  if (sectors.length === 0) {
    throw new Error(
      `risk-packager: taxonomy version '${version}' has zero active sectors.`
    );
  }
  if (!gradeScaleRow) {
    throw new Error(
      `risk-packager: taxonomy version '${version}' missing grade_scale config row.`
    );
  }

  return {
    version,
    determinants,
    sectors,
    grade_scale: gradeScaleRow.metadata || {},
  };
}

// --- Companies House enrichment ---

async function loadCompaniesHouseSnapshots(borrowerRows) {
  const numbers = [
    ...new Set(
      borrowerRows
        .map((b) => b.company_number)
        .filter((n) => n && typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim().toUpperCase())
    ),
  ];
  if (numbers.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT company_number, company_name, company_status,
            risk_score, risk_flags, verification_data, verified_at
       FROM company_verifications
      WHERE UPPER(company_number) = ANY($1::text[])`,
    [numbers]
  );
  return rows;
}

// --- Experian credit_checks enrichment (2026-04-27, EXP-B7) ---
//
// Pulls latest-per-borrower-per-product credit_checks rows for the deal.
// Three products in scope: commercial_delphi (corporate borrowers),
// personal_credit + hunter_fraud (individuals — directors, guarantors, UBOs).
// Soft-fail: if no rows exist, returns empty array. Risk grading proceeds
// with NULL credit signal — Opus is briefed (via prompt) to mark the
// determinant as Information Availability gap, not auto-decline.
//
// Pre-CONS-3 NOTE: this function ships ALL credit_checks rows regardless of
// borrower consent state. Once CONS-3 lands, callers will only have populated
// rows where consent was given — uncalled subjects simply won't have rows
// in credit_checks, so this query naturally filters consented data only.
async function loadCreditChecks(dealId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (borrower_id, product)
            id, deal_id, borrower_id, director_id, company_id,
            product, vendor,
            subject_first_name, subject_last_name, subject_company_name,
            subject_company_number,
            result_status, result_grade, credit_score,
            recommended_limit_pence,
            ccj_count, ccj_value_pence, ccj_jsonb,
            bankruptcy_flag, iva_flag,
            default_count, default_value_pence,
            electoral_roll_jsonb, gone_away_flag,
            payment_behaviour_jsonb, gazette_jsonb,
            fraud_markers_jsonb, hunter_match_count,
            adverse_jsonb,
            mode, cost_pence, requested_at
       FROM credit_checks
      WHERE deal_id = $1
        AND pull_error IS NULL
      ORDER BY borrower_id, product, requested_at DESC`,
    [dealId]
  );
  return rows;
}

// --- SmartSearch kyc_checks enrichment (2026-04-28, SS-B8) ---
//
// Mirror of loadCreditChecks for KYC/AML signal. Four check_types in scope:
// individual_kyc, business_kyb, sanctions_pep, ongoing_monitoring.
// DISTINCT ON (borrower_id, check_type) returns latest-per-subject-per-type.
// is_monitoring_update rows excluded — those are async vendor pushes that
// belong in a separate "monitoring_events" stream, not the underwriting
// snapshot Opus grades against. pull_error filtered same as credit_checks.
async function loadKycChecks(dealId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (borrower_id, check_type)
            id, deal_id, borrower_id, director_id, individual_id, company_id,
            check_type, provider,
            subject_first_name, subject_last_name, subject_company_name,
            subject_company_number,
            result_status, result_score,
            result_summary_jsonb,
            sanctions_hits_jsonb, pep_hits_jsonb, rca_hits_jsonb,
            sip_hits_jsonb, adverse_media_jsonb,
            mode, cost_pence, requested_at, parent_check_id
       FROM kyc_checks
      WHERE deal_id = $1
        AND pull_error IS NULL
        AND is_monitoring_update = FALSE
      ORDER BY borrower_id, check_type, requested_at DESC`,
    [dealId]
  );
  return rows;
}

// --- RICS valuations enrichment (2026-04-28, Sprint 1b Pattern B) ---
//
// Pulls ACTIVE (finalised + non-superseded) RICS valuations for the deal.
// Drafts and superseded rows are excluded — Opus grades against the
// canonical lending value snapshot, not work-in-progress.
//
// Soft-fail: if no valuations exist, returns []. Risk grading proceeds
// with NULL valuation signal — the rubric's Information Availability
// dimension catches this gap (and downgrades IA grade accordingly).
//
// Each row carries valuer panel attribution (firm name, panel status,
// approved_by_funder) AND an `is_off_panel` flag — the rubric reads
// the latter to apply the off-panel IA penalty Sumit specified
// 2026-04-28 ("soft policy: off-panel allowed but flagged").
//
// Includes the computed expiry block { state, daysRemaining, expiresAt }
// so the rubric can flag expired/expiring vals without recomputing dates.
//
// Delegates to valuationsService.loadForRiskPackager(dealId) — that
// function owns the JOIN to approved_valuers and the field projection.
async function loadValuations(dealId) {
  return await valuationsService.loadForRiskPackager(dealId);
}

// --- Balance sheet enrichment (2026-04-28, Sprint 5 #27) ---
//
// Ships TWO aggregate blocks:
//   consolidated  — deal-wide rollup (single object). Critical signal —
//                   total effective net worth, monthly disposable, the
//                   "what's behind this loan" view.
//   per_ubo[]     — per-borrower aggregates ONLY (counts + totals).
//                   No row-level dumps — keeps payload bounded.
//
// Soft-fail on empty: returns { consolidated: null, per_ubo: [] } if no
// balance-sheet rows exist for any UBO on the deal. Rubric's IA dimension
// then catches the gap (information_availability grade downgrades).
async function loadBalanceSheet(dealId) {
  try {
    const consolidated = await balanceSheetService.getConsolidatedForDeal(dealId);
    if (!consolidated) return { consolidated: null, per_ubo: [] };

    // Per-UBO summaries — aggregates only (no portfolio/asset/liability rows in payload)
    const { rows: borrowers } = await pool.query(
      `SELECT id, full_name, role, borrower_type, is_corporate
         FROM deal_borrowers
        WHERE deal_id = $1
        ORDER BY id`,
      [dealId]
    );

    const perUbo = [];
    for (const b of borrowers) {
      try {
        const [nw, ie] = await Promise.all([
          balanceSheetService.getNetWorthForBorrower(b.id),
          balanceSheetService.getIncomeExpenseSummaryForBorrower(b.id)
        ]);
        // Only include UBOs that actually have data — skips empty rows
        const hasData = nw.portfolio_properties_count > 0
          || nw.other_assets_count > 0
          || nw.other_liabilities_count > 0
          || ie.income_count > 0
          || ie.expense_count > 0;
        if (!hasData) continue;
        perUbo.push({
          borrower_id: b.id,
          full_name: b.full_name,
          role: b.role,
          borrower_type: b.borrower_type,
          is_corporate: b.is_corporate,
          counts: {
            portfolio_properties: nw.portfolio_properties_count,
            other_assets: nw.other_assets_count,
            other_liabilities: nw.other_liabilities_count,
            income_lines: ie.income_count,
            expense_lines: ie.expense_count
          },
          balance_sheet: {
            effective_property_equity: nw.effective_property_equity,
            effective_other_assets: nw.effective_other_assets,
            effective_other_liabilities: nw.effective_other_liabilities,
            effective_net_worth: nw.effective_net_worth
          },
          income_expense: {
            effective_monthly_income: ie.effective_monthly_income,
            effective_monthly_expense: ie.effective_monthly_expense,
            effective_monthly_net: ie.effective_monthly_net,
            effective_monthly_net_rent: nw.effective_monthly_net_rent
          },
          // Single derived signal — months of expenses covered by liquid + rent.
          // Useful proxy for short-term affordability stress.
          months_runway_at_zero_income:
            (ie.effective_monthly_expense > 0 && nw.effective_other_assets > 0)
              ? Math.round(nw.effective_other_assets / ie.effective_monthly_expense)
              : null
        });
      } catch (err) {
        console.warn(`[risk-packager] balance-sheet UBO ${b.id} failed:`, err.message);
      }
    }

    return {
      consolidated: {
        counts: consolidated.counts,
        balance_sheet: consolidated.consolidated_balance_sheet,
        income_expense: consolidated.consolidated_income_expense,
        // Single derived signal: deal-level disposable annualised
        annualised_disposable: (consolidated.consolidated_income_expense.effective_monthly_net || 0) * 12,
        ubo_count_with_data: perUbo.length
      },
      per_ubo: perUbo
    };
  } catch (err) {
    console.warn('[risk-packager] loadBalanceSheet failed:', err.message);
    return { consolidated: null, per_ubo: [] };
  }
}

// --- Borrower exposure / concentration (2026-04-28, Sprint 5 #27) ---
//
// Cross-deal concentration risk: how much existing Daksfirst exposure does
// this borrower already have, across all OTHER deals? Single-borrower limit
// policy depends on this. Aggregates + match_keys only — the deals[] list
// is truncated to top-3 by loan amount to keep token cost bounded.
async function loadBorrowerExposure(dealId) {
  try {
    const exp = await exposureService.getExposureForDeal(dealId);
    if (!exp) return null;
    // Truncate deals[] — Opus only needs the loudest signals
    const topDeals = (exp.deals || [])
      .filter(d => d.is_active)
      .sort((a, b) => Number(b.loan_amount || 0) - Number(a.loan_amount || 0))
      .slice(0, 3)
      .map(d => ({
        submission_id: d.submission_id,
        deal_stage: d.deal_stage,
        loan_amount: d.loan_amount,
        created_at: d.created_at
      }));
    return {
      other_deals_count: exp.other_deals_count,
      active_other_deals: exp.active_other_deals,
      total_loan_other: exp.total_loan_other,
      total_loan_active_other: exp.total_loan_active_other,
      match_keys_used: {
        company_numbers: (exp.match_keys && exp.match_keys.company_numbers) || [],
        emails_count: ((exp.match_keys && exp.match_keys.emails) || []).length,
        name_dob_pairs_count: ((exp.match_keys && exp.match_keys.name_dob_pairs) || []).length
      },
      top_active_deals: topDeals
    };
  } catch (err) {
    console.warn('[risk-packager] loadBorrowerExposure failed:', err.message);
    return null;
  }
}

// --- Sources & Uses computed summary (2026-04-28, Sprint 5 #27) ---
//
// The native S&U cols are already in features.deal (auto-shipped). This
// helper pre-computes the balance state + ratios so Opus doesn't have to
// do arithmetic on raw cols. ~100 tokens — high signal/token ratio.
function buildSourcesUsesSummary(deal) {
  const num = (v) => Number(v || 0);
  const purchasePrice    = num(deal.purchase_price);
  const sdlt             = num(deal.uses_sdlt);
  const refurb           = num(deal.refurb_cost);
  const legal            = num(deal.uses_legal_fees);
  const otherUses        = num(deal.uses_other_amount);
  const loanRedemption   = num(deal.uses_loan_redemption);

  // Lender fees auto-derived from loan_amount_approved × pct
  const loanApproved   = num(deal.loan_amount_approved) || num(deal.loan_amount);
  const arrangementFee = (loanApproved * num(deal.arrangement_fee_pct)) / 100;
  const brokerFee      = (loanApproved * num(deal.broker_fee_pct)) / 100;
  const commitmentFee  = num(deal.commitment_fee);
  const dipFee         = num(deal.dip_fee);
  const lenderFeesTotal = arrangementFee + brokerFee + commitmentFee + dipFee;

  const totalUses = purchasePrice + sdlt + refurb + legal + otherUses + lenderFeesTotal + loanRedemption;

  // Sources
  const seniorLoan   = loanApproved;
  const secondCharge = num(deal.sources_second_charge);
  const equity       = num(deal.sources_equity);
  const otherSources = num(deal.sources_other_amount);
  const totalSources = seniorLoan + secondCharge + equity + otherSources;

  const balanceDiff = totalSources - totalUses;
  const isBalanced  = Math.abs(balanceDiff) < 1;
  const shortBy     = balanceDiff < 0 ? Math.abs(balanceDiff) : 0;
  const overBy      = balanceDiff > 0 ? balanceDiff : 0;

  // Implied LTC (loan to cost): senior loan / total uses
  const ltcImplied = totalUses > 0 ? (seniorLoan / totalUses) * 100 : null;
  // Equity in stack: how much skin does the borrower have
  const equityPct  = totalSources > 0 ? (equity / totalSources) * 100 : null;
  const seniorPct  = totalSources > 0 ? (seniorLoan / totalSources) * 100 : null;

  return {
    primary_use_type: deal.uses_primary_type || null,
    totals: {
      total_uses: totalUses,
      total_sources: totalSources,
      balance_diff: balanceDiff,
      is_balanced: isBalanced,
      short_by: shortBy,
      over_by: overBy
    },
    uses_breakdown: {
      purchase_price: purchasePrice,
      sdlt: sdlt,
      refurb: refurb,
      legal: legal,
      other: otherUses,
      loan_redemption: loanRedemption,
      lender_fees_total: lenderFeesTotal,
      lender_fees_breakdown: {
        arrangement: arrangementFee,
        broker: brokerFee,
        commitment: commitmentFee,
        dip: dipFee
      }
    },
    sources_breakdown: {
      senior_loan: seniorLoan,
      second_charge: secondCharge,
      equity: equity,
      other: otherSources
    },
    ratios: {
      ltc_implied_pct: ltcImplied,
      equity_in_stack_pct: equityPct,
      senior_in_stack_pct: seniorPct
    }
  };
}

// --- Data-stage resolution ---

function resolveDataStage(input) {
  const v = (input || '').toString().trim().toLowerCase();
  if (!VALID_STAGES.includes(v)) {
    throw new Error(
      `risk-packager: data_stage must be one of ${VALID_STAGES.join('|')}, got '${input}'`
    );
  }
  return v;
}

// --- Hashing ---

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex');
}

// --- Public API ---

async function buildRiskPayload(dealId, dataStage, options = {}) {
  if (!dealId || !Number.isInteger(Number(dealId))) {
    return { success: false, error: 'dealId must be an integer' };
  }

  let stage;
  try {
    stage = resolveDataStage(dataStage);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const m1 = await featurePackager.packageDealForStage(dealId, 'risk_run');
  if (!m1.success) {
    return { success: false, error: `feature packager failed: ${m1.error}` };
  }

  let rubric, macro;
  try {
    [rubric, macro] = await Promise.all([
      loadActivePrompt('risk_rubric'),
      loadActivePrompt('risk_macro'),
    ]);
  } catch (err) {
    return { success: false, error: err.message };
  }

  let taxonomy;
  try {
    taxonomy = await loadActiveTaxonomy();
  } catch (err) {
    return { success: false, error: err.message };
  }

  const companiesHouse = await loadCompaniesHouseSnapshots(m1.envelope.features.borrowers);

  // Experian credit_checks (2026-04-27, EXP-B7). Soft-fail on empty.
  const creditChecks = await loadCreditChecks(dealId);

  // SmartSearch kyc_checks (2026-04-28, SS-B8). Soft-fail on empty.
  const kycChecks = await loadKycChecks(dealId);

  // RICS valuations (2026-04-28, Sprint 1b Pattern B). Soft-fail on empty.
  // Active rows only (finalised + non-superseded). Includes valuer panel
  // attribution + computed expiry. lending_value_pence is THE LTV anchor.
  const valuations = await loadValuations(dealId);

  // CH directorships KYC (2026-04-28, Sprint 3 #18). Per-borrower aggregates
  // plus troublesome list only (not the full appointment set — that would
  // crowd the prompt). Soft-fail on empty.
  let directorshipsByBorrower = [];
  try {
    directorshipsByBorrower = await directorshipsService.getSummaryForDeal(dealId);
  } catch (err) {
    console.warn('[risk-packager] directorships pull failed:', err.message);
  }

  // Sprint 5 #27 (2026-04-28) — balance sheet + I/E aggregates + concentration.
  // All three are soft-fail. loadBalanceSheet returns
  //   { consolidated, per_ubo[] }
  // loadBorrowerExposure returns null on empty / failure.
  // S&U summary is computed from the deal row itself (always present).
  const [balanceSheet, borrowerExposure] = await Promise.all([
    loadBalanceSheet(dealId),
    loadBorrowerExposure(dealId)
  ]);

  const sourcesUsesSummary = buildSourcesUsesSummary(m1.envelope.features.deal);

  // XCOLL-2 (2026-04-29): cross-collateral summary — effective LTV (1st-charge
  // properties only) + 2nd-charge comfort security + auto-redemption lines for
  // refinance properties. Ships in payload alongside sources_uses for Opus.
  const crossCollateral = (() => {
    try {
      const xcoll = require('./cross-collateral');
      const dealRow = m1.envelope.features.deal;
      const loanApprovedPounds = Number(dealRow.loan_amount_approved || dealRow.loan_amount || 0);
      const loanApprovedPence = Math.round(loanApprovedPounds * 100);
      return xcoll.buildCrossCollateralSummary(m1.envelope.features.properties, loanApprovedPence);
    } catch (err) {
      console.warn('[risk-packager] cross-collateral summary failed:', err.message);
      return null;
    }
  })();

  const propsWithChimnie = m1.envelope.features.properties.filter((p) => p.chimnie_uprn);
  const propsWithPtal    = m1.envelope.features.properties.filter((p) => p.chimnie_ptal);
  const propsWithArea    = m1.envelope.features.properties.filter((p) => p.chimnie_local_authority);
  const propsWithPaf     = m1.envelope.features.properties.filter((p) => p.paf_uprn);
  const propsWithPd      = m1.envelope.features.properties.filter((p) => p.pd_pulled_at);

  // Per-product breakdown for provenance + log telemetry.
  const creditByProduct = creditChecks.reduce((acc, c) => {
    acc[c.product] = (acc[c.product] || 0) + 1;
    return acc;
  }, {});

  // Per-check_type breakdown for kyc_checks (SS-B8).
  const kycByType = kycChecks.reduce((acc, k) => {
    acc[k.check_type] = (acc[k.check_type] || 0) + 1;
    return acc;
  }, {});

  // Valuation telemetry for provenance + log: total active rows, off-panel
  // count (for IA penalty visibility), expired count (for drawdown gate).
  const valuationOffPanelCount = valuations.filter((v) => v.is_off_panel).length;
  const valuationExpiredCount = valuations.filter((v) =>
    v.expiry && v.expiry.state === 'expired'
  ).length;
  const valuationValidForDrawdown = valuations.filter((v) =>
    v.expiry && v.expiry.state !== 'expired' && v.expiry.state !== 'missing'
  ).length;

  const provenance = {
    deal_columns_count:     Object.keys(m1.envelope.features.deal).length,
    borrowers_count:        m1.envelope.features.borrowers.length,
    properties_count:       m1.envelope.features.properties.length,
    chimnie_attached_count: propsWithChimnie.length,
    ptal_attached_count:    propsWithPtal.length,
    area_intel_attached_count: propsWithArea.length,
    paf_attached_count:     propsWithPaf.length,
    propertydata_attached_count: propsWithPd.length,
    companies_house_count:  companiesHouse.length,
    credit_checks_count:    creditChecks.length,
    credit_commercial_count: creditByProduct.commercial_delphi || 0,
    credit_personal_count:   creditByProduct.personal_credit || 0,
    credit_hunter_count:     creditByProduct.hunter_fraud || 0,
    kyc_checks_count:       kycChecks.length,
    kyc_individual_count:   kycByType.individual_kyc || 0,
    kyc_business_count:     kycByType.business_kyb || 0,
    kyc_sanctions_count:    kycByType.sanctions_pep || 0,
    valuations_count:           valuations.length,
    valuations_off_panel_count: valuationOffPanelCount,
    valuations_expired_count:   valuationExpiredCount,
    valuations_valid_for_drawdown_count: valuationValidForDrawdown,
    directorships_count:        (directorshipsByBorrower || []).length,
    // Sprint 5 #27 — balance sheet + concentration provenance
    balance_sheet_ubos_with_data: (balanceSheet.per_ubo || []).length,
    balance_sheet_consolidated_present: !!balanceSheet.consolidated,
    consolidated_net_worth: balanceSheet.consolidated
      ? balanceSheet.consolidated.balance_sheet.effective_consolidated_net_worth
      : null,
    consolidated_monthly_disposable: balanceSheet.consolidated
      ? balanceSheet.consolidated.income_expense.effective_monthly_net
      : null,
    borrower_exposure_other_deals: borrowerExposure ? borrowerExposure.other_deals_count : 0,
    borrower_exposure_total_loan_other: borrowerExposure ? borrowerExposure.total_loan_other : 0,
    sources_uses_balanced: sourcesUsesSummary.totals.is_balanced,
    sources_uses_short_by: sourcesUsesSummary.totals.short_by,
    matrix_data_jsonb_present:
      !!m1.envelope.features.deal.matrix_data &&
      Object.keys(m1.envelope.features.deal.matrix_data || {}).length > 0,
  };

  const sensitivityVersion =
    options.sensitivityCalculatorVersion || DEFAULT_SENSITIVITY_VERSION;

  const payload = {
    schema_version:   SCHEMA_VERSION,
    deal_id:          m1.envelope.deal_id,
    submission_id:    m1.envelope.submission_id,
    data_stage:       stage,
    packaged_at:      new Date().toISOString(),
    rubric,
    macro,
    taxonomy_version: taxonomy.version,
    taxonomy,
    sensitivity_calculator_version: sensitivityVersion,
    features:         m1.envelope.features,
    companies_house:  companiesHouse,
    credit_checks:    creditChecks,
    kyc_checks:       kycChecks,
    valuations:       valuations,
    directorships:    directorshipsByBorrower,
    // Sprint 5 #27 — balance sheet + concentration + S&U computed summary
    balance_sheet:    balanceSheet,         // { consolidated, per_ubo[] }
    borrower_exposure: borrowerExposure,    // null | { aggregates + top_active_deals[3] }
    sources_uses:     sourcesUsesSummary,   // computed totals + ratios + breakdown
    cross_collateral: crossCollateral,      // XCOLL-2: effective LTV (1st-charge only)
                                             //          + 2nd-charge comfort + auto-redemptions
    source_provenance: provenance,
    feature_hash:     m1.feature_hash,
  };

  const { packaged_at, ...hashable } = payload;
  payload.risk_payload_hash = sha256(hashable);

  console.log(
    `[risk-packager] deal=${payload.deal_id} stage=${stage} ` +
    `rubric=${rubric.prompt_key}.v${rubric.version}#${rubric.prompt_id} ` +
    `macro=${macro.prompt_key}.v${macro.version}#${macro.prompt_id} ` +
    `taxonomy=${taxonomy.version}` +
    `(d=${taxonomy.determinants.length},s=${taxonomy.sectors.length}) ` +
    `borrowers=${provenance.borrowers_count} ` +
    `properties=${provenance.properties_count} ` +
    `chimnie=${provenance.chimnie_attached_count} ` +
    `ch=${provenance.companies_house_count} ` +
    `credit=${provenance.credit_checks_count}` +
    `(c=${provenance.credit_commercial_count},p=${provenance.credit_personal_count},h=${provenance.credit_hunter_count}) ` +
    `kyc=${provenance.kyc_checks_count}` +
    `(i=${provenance.kyc_individual_count},b=${provenance.kyc_business_count},s=${provenance.kyc_sanctions_count}) ` +
    `vals=${provenance.valuations_count}` +
    `(off=${provenance.valuations_off_panel_count},exp=${provenance.valuations_expired_count},ok=${provenance.valuations_valid_for_drawdown_count}) ` +
    // Sprint 5 #27 telemetry
    `bs=${provenance.balance_sheet_ubos_with_data}` +
    `(nw=${provenance.consolidated_net_worth},disp=${provenance.consolidated_monthly_disposable}) ` +
    `expo=${provenance.borrower_exposure_other_deals}` +
    `(£${provenance.borrower_exposure_total_loan_other}) ` +
    `s&u=${provenance.sources_uses_balanced ? 'BAL' : ('SHORT£' + provenance.sources_uses_short_by)} ` +
    `risk_hash=${payload.risk_payload_hash.slice(0, 12)}`
  );

  return {
    success: true,
    payload,
    feature_hash:     payload.feature_hash,
    risk_payload_hash: payload.risk_payload_hash,
  };
}

module.exports = {
  buildRiskPayload,
  resolveDataStage,
  loadActivePrompt,
  loadActiveTaxonomy,
  loadCompaniesHouseSnapshots,
  loadCreditChecks,
  loadKycChecks,
  loadValuations,
  // Sprint 5 #27
  loadBalanceSheet,
  loadBorrowerExposure,
  buildSourcesUsesSummary,
  sha256,
  stableStringify,
  SCHEMA_VERSION,
  VALID_STAGES,
  DEFAULT_SENSITIVITY_VERSION,
};
