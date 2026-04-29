/**
 * Pricing Engine — PRICE-3 (2026-04-29)
 *
 * Pure compute service. Takes a risk grade (PD/LGD/IA) + deal inputs,
 * looks up the active versioned config (assumptions / grid / IA modifiers),
 * and returns a full pricing envelope. NO DB writes, NO LLM, NO side effects.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  CRITICAL — Cost-of-funds math (corrected 2026-04-29 after Sumit caught
 *  blended D+E error). Daksfirst funds 10% capital ratio itself; warehouse
 *  lender funds 90%. So:
 *
 *    CoF on debt portion       = (SONIA + GBB spread) × (1 − capital_ratio)
 *    Structuring on debt       = structuring_apr × (1 − capital_ratio)
 *    Capital cost on equity    = capital_ratio × equity_target_return
 *
 *  These are SEPARATE LINES in the cost stack — never blended. Sanity check:
 *  pre-tax ROE outside 15-65% range on warehouse mode = math error.
 *  See memory: feedback_lending_economics_basics.md
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Architecture commitments (locked in design memo
 * project_pricing_engine_design_2026_04_28.md):
 *   - 9×5×6 sectoral grid (PD × LGD × sector). IA applied as deltas.
 *   - min_term joint LGD×IA precision lookup (joint dep doesn't decompose
 *     into row deltas) — engine prefers `min_term_lgd_ia_table` over
 *     grid+modifier sum.
 *   - Rate-ceiling-aware: standard 1.25%pm, stressed 1.75%pm. Engine
 *     never bumps rate past ceiling — fees absorb gap; if still short,
 *     decline_flag = TRUE.
 *   - Whole-loan threshold ≥£5m. Engine emits parallel envelope under
 *     mode=whole_loan (no CoF, no capital cost, fee-only revenue).
 *   - Full stress matrix: 7 scenarios per cell.
 *   - Commitment fee netted off upfront at drawdown (NOT additive to revenue).
 *
 * Input shape:
 *   {
 *     deal_id,                   // for envelope echo
 *     risk_view_id,              // optional, for audit trail
 *     loan_amount_pence,         // BIGINT
 *     term_months,               // 1-24 typically
 *     sector,                    // node_key from risk_taxonomy: resi_bridging, etc.
 *     pd,                        // 1..9
 *     lgd,                       // 'A'..'E'
 *     ia,                        // 'A'..'E'
 *     mode,                      // 'warehouse' | 'whole_loan' | 'direct'  (default 'warehouse')
 *     book_size_pence,           // for concentration calc (optional, defaults to expected_avg_book_pence)
 *     stress_flagged,            // boolean — if TRUE engine uses stressed rate ceiling
 *     stress_reason,             // free-form audit string
 *     channel,                   // 'broker' | 'direct'  (default 'broker' — affects broker fee)
 *   }
 *
 * Output: see priceDeal() doc-comment.
 */

const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════════════════
//  Active config loader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Loads the active versioned config in one round-trip. Returns:
 *   {
 *     versions: { assumptions, grid, ia_modifiers },
 *     assumptions: { <key>: { value_bps, value_pence, value_jsonb, source, citation } },
 *     ia_modifiers: { A: {...}, B: {...}, ..., E: {...} },
 *   }
 *
 * Grid cells are looked up per-call by (sector, pd, lgd) since 270 rows
 * loaded eagerly is wasteful for a single deal.
 */
async function loadActivePricingConfig(client) {
  const db = client || pool;

  const versionsQuery = `
    SELECT
      (SELECT version FROM pricing_assumptions_versions WHERE is_active = TRUE) AS assumptions_version,
      (SELECT version FROM pricing_grid_versions        WHERE is_active = TRUE) AS grid_version,
      (SELECT version FROM ia_modifiers_versions        WHERE is_active = TRUE) AS ia_modifiers_version
  `;
  const versions = (await db.query(versionsQuery)).rows[0];

  if (!versions.assumptions_version || !versions.grid_version || !versions.ia_modifiers_version) {
    throw new Error(
      `pricing-engine: no active config (assumptions=${versions.assumptions_version}, ` +
      `grid=${versions.grid_version}, ia_modifiers=${versions.ia_modifiers_version})`
    );
  }

  // Assumptions as keyed dict
  const assumptionsRows = (await db.query(
    `SELECT key, value_bps, value_pence, value_jsonb, source, citation
       FROM pricing_assumptions WHERE version = $1`,
    [versions.assumptions_version]
  )).rows;
  const assumptions = {};
  for (const r of assumptionsRows) {
    assumptions[r.key] = {
      value_bps: r.value_bps,
      value_pence: r.value_pence,
      value_jsonb: r.value_jsonb,
      source: r.source,
      citation: r.citation,
    };
  }

  // IA modifiers as keyed dict by ia_band
  const iaRows = (await db.query(
    `SELECT ia_band, rate_bps_delta, upfront_fee_bps_delta, commitment_fee_bps_delta,
            retained_months_delta, min_term_months_delta
       FROM ia_modifiers WHERE version = $1`,
    [versions.ia_modifiers_version]
  )).rows;
  const ia_modifiers = {};
  for (const r of iaRows) {
    ia_modifiers[r.ia_band] = r;
  }

  return {
    versions: {
      assumptions: versions.assumptions_version,
      grid: versions.grid_version,
      ia_modifiers: versions.ia_modifiers_version,
    },
    assumptions,
    ia_modifiers,
  };
}

async function loadGridCell(version, sector, pd, lgd, client) {
  const db = client || pool;
  const row = (await db.query(
    `SELECT base_rate_bps_pm, base_upfront_fee_bps, base_commitment_fee_bps,
            retained_months, base_exit_fee_bps, min_term_months,
            source, citation
       FROM pricing_grid
      WHERE version = $1 AND sector = $2 AND pd_band = $3 AND lgd_band = $4`,
    [version, sector, pd, lgd]
  )).rows[0];
  if (!row) {
    throw new Error(`pricing-engine: grid cell not found for (version=${version}, sector=${sector}, PD=${pd}, LGD=${lgd})`);
  }
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tier lookups (loan size → tiered bps)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Walk the tier array and return the bps for the smallest max_pence ≥ loan,
 * or the open-ended (max_pence=null) tier as fallback. Tier shape:
 *   [{ max_pence: <BIGINT|null>, bps: <int>, label: <str> }, ...]
 */
function lookupTier(tiers, loan_pence) {
  if (!Array.isArray(tiers)) return { bps: 0, label: 'no-tier' };
  for (const tier of tiers) {
    if (tier.max_pence === null || tier.max_pence === undefined) return tier;
    if (loan_pence <= tier.max_pence) return tier;
  }
  // Fallback: last tier
  return tiers[tiers.length - 1];
}

/**
 * Concentration adder (bps EL adder by deal % of book). Tier shape:
 *   [{ max_pct: <int|null>, adder: <int>, label: <str> }, ...]
 */
function lookupConcentration(buckets, loan_pence, book_pence) {
  if (!Array.isArray(buckets) || !book_pence || book_pence <= 0) {
    return { adder: 0, label: 'no-book-data' };
  }
  const pct = (Number(loan_pence) / Number(book_pence)) * 100;
  for (const b of buckets) {
    if (b.max_pct === null || b.max_pct === undefined) return { ...b, pct };
    if (pct <= b.max_pct) return { ...b, pct };
  }
  return { ...buckets[buckets.length - 1], pct };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cost stack — corrected CoF math
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns annualised cost stack in bps. Mode-aware:
 *   - warehouse  : full stack (CoF + structuring + EL + capital_cost + opex + margin)
 *   - whole_loan : no CoF, no structuring, no capital_cost (off-book) + EL + opex + whole_loan_margin
 *
 * EL is computed on the FULL loan amount (not × (1-capital_ratio)) — the
 * equity tranche absorbs first-loss but EL is the same overall.
 */
function buildCostStack(opts) {
  const {
    assumptions, mode, loan_pence, book_pence, pd, lgd,
  } = opts;

  const capital_ratio_decimal = (assumptions.capital_ratio_bps?.value_bps || 0) / 10000;
  const equity_target_decimal = (assumptions.equity_target_return_bps?.value_bps || 0) / 10000;

  const sonia_bps        = assumptions.sonia_value_bps?.value_bps || 0;
  const gbb_spread_bps   = assumptions.gbb_warehouse_spread_bps?.value_bps || 0;
  const structuring_bps  = assumptions.gbb_structuring_annualised_bps?.value_bps || 0;

  // PD/LGD anchors → annual EL
  const pd_anchors = assumptions.pd_anchors_pct?.value_jsonb || [];
  const lgd_anchors = assumptions.lgd_anchors_pct?.value_jsonb || [];
  const pd_pct = (pd_anchors.find(a => a.band === pd) || { pd: 0 }).pd / 100;
  const lgd_pct = (lgd_anchors.find(a => a.band === lgd) || { lgd: 0 }).lgd / 100;
  const el_base_bps = Math.round(pd_pct * lgd_pct * 10000);

  // Concentration adder
  const conc = lookupConcentration(
    assumptions.concentration_adder_buckets_bps?.value_jsonb,
    loan_pence,
    book_pence || (assumptions.expected_avg_book_pence?.value_pence)
  );
  const concentration_adder_bps = conc.adder || 0;

  // Opex + margin (tier-driven by loan size)
  const opex_tier = lookupTier(assumptions.opex_tiers_bps?.value_jsonb, loan_pence);
  const opex_apr_bps = opex_tier.bps || 0;

  let margin_apr_bps;
  if (mode === 'whole_loan') {
    // Whole-loan BTL: fixed 300 bps spread over SONIA (per GBB termsheet),
    // not the tier-driven margin used in warehouse mode.
    margin_apr_bps = assumptions.whole_loan_min_margin_bps?.value_bps
                  || assumptions.whole_loan_margin_bps?.value_bps
                  || 300;
  } else {
    const margin_tier = lookupTier(assumptions.margin_tiers_bps?.value_jsonb, loan_pence);
    margin_apr_bps = margin_tier.bps || 0;
  }

  // Mode-specific funding lines
  let cof_apr_bps = 0;
  let structuring_apr_bps = 0;
  let capital_cost_apr_bps = 0;

  if (mode === 'warehouse') {
    // CORRECTED FORMULA: CoF on debt portion only
    cof_apr_bps          = Math.round((sonia_bps + gbb_spread_bps) * (1 - capital_ratio_decimal));
    structuring_apr_bps  = Math.round(structuring_bps * (1 - capital_ratio_decimal));
    // Capital cost on equity portion only
    capital_cost_apr_bps = Math.round(capital_ratio_decimal * equity_target_decimal * 10000);
  }
  // whole_loan mode: cof/structuring/capital_cost all 0 (off-book, fee-only)

  const el_apr_bps = el_base_bps + concentration_adder_bps;
  const required_yield_apr_bps =
    cof_apr_bps + structuring_apr_bps + el_apr_bps +
    capital_cost_apr_bps + opex_apr_bps + margin_apr_bps;

  return {
    sonia_apr_bps: sonia_bps,
    gbb_spread_apr_bps: gbb_spread_bps,
    cof_apr_bps,
    structuring_apr_bps,
    el_base_bps,
    concentration_adder_bps,
    concentration_pct: conc.pct,
    concentration_label: conc.label,
    el_apr_bps,
    capital_cost_apr_bps,
    opex_apr_bps,
    opex_tier_label: opex_tier.label || null,
    margin_apr_bps,
    required_yield_apr_bps,
    capital_ratio_decimal,
    equity_target_decimal,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Recommended levers (grid + IA delta + min_term joint lookup + ceiling clamp)
// ═══════════════════════════════════════════════════════════════════════════

function applyRateCeiling(rate_bps_pm, stress_flagged, assumptions) {
  const standard_ceiling = assumptions.standard_rate_ceiling_bps_pm?.value_bps || 125;
  const stressed_ceiling = assumptions.stressed_rate_ceiling_bps_pm?.value_bps || 175;
  const ceiling = stress_flagged ? stressed_ceiling : standard_ceiling;
  if (rate_bps_pm > ceiling) {
    return { rate_bps_pm: ceiling, capped: true, ceiling, original: rate_bps_pm };
  }
  return { rate_bps_pm, capped: false, ceiling, original: rate_bps_pm };
}

/**
 * Cost floor by mode — bridging warehouse cannot price below cost-of-funds +
 * cost-of-equity + structuring + opex + minimum margin. Whole-loan BTL has a
 * different (lower) floor since there's no CoF on Daksfirst's balance sheet —
 * just GBB cost (SONIA + spread).
 *
 * Returns { floor_bps_pm, below_floor: bool, floor_source: 'warehouse'|'whole_loan' }
 */
function checkRateFloor(rate_bps_pm, mode, assumptions) {
  const warehouse_floor = assumptions.floor_rate_warehouse_bps_pm?.value_bps || 79;
  const whole_loan_floor = assumptions.floor_rate_whole_loan_bps_pm?.value_bps || 56;
  const floor_bps_pm = mode === 'whole_loan' ? whole_loan_floor : warehouse_floor;
  return {
    floor_bps_pm,
    below_floor: rate_bps_pm < floor_bps_pm,
    floor_source: mode === 'whole_loan' ? 'whole_loan (SONIA + 300)' : 'warehouse (CoF + CapCost + Opex + min margin)',
  };
}

function lookupMinTermJoint(assumptions, lgd, ia) {
  const table = assumptions.min_term_lgd_ia_table?.value_jsonb;
  if (!Array.isArray(table)) return null;
  const row = table.find(r => r.lgd === lgd);
  if (!row || !row.ia) return null;
  return row.ia[ia] ?? null;
}

function buildRecommendedLevers(opts) {
  const { gridCell, iaDelta, assumptions, lgd, ia, stress_flagged } = opts;

  // Sum grid + IA delta
  let rate_bps_pm        = gridCell.base_rate_bps_pm        + (iaDelta.rate_bps_delta || 0);
  const upfront_fee_bps  = gridCell.base_upfront_fee_bps    + (iaDelta.upfront_fee_bps_delta || 0);
  const commitment_fee_bps = gridCell.base_commitment_fee_bps + (iaDelta.commitment_fee_bps_delta || 0);
  const retained_months  = gridCell.retained_months         + (iaDelta.retained_months_delta || 0);
  const exit_fee_bps     = gridCell.base_exit_fee_bps; // no IA delta

  // min_term: prefer joint LGD×IA lookup over grid+delta sum
  const joint_min_term = lookupMinTermJoint(assumptions, lgd, ia);
  const min_term_months = joint_min_term ?? (gridCell.min_term_months + (iaDelta.min_term_months_delta || 0));

  // Apply rate ceiling
  const ceilingResult = applyRateCeiling(rate_bps_pm, stress_flagged, assumptions);
  rate_bps_pm = ceilingResult.rate_bps_pm;

  return {
    rate_bps_pm,
    upfront_fee_bps,
    commitment_fee_bps,
    retained_months,
    exit_fee_bps,
    min_term_months,
    rate_capped: ceilingResult.capped,
    rate_ceiling_bps_pm: ceilingResult.ceiling,
    rate_pre_ceiling_bps_pm: ceilingResult.original,
    min_term_source: joint_min_term !== null ? 'joint_lookup' : 'grid_plus_modifier',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Yield computation (gross / net / margin buffer)
// ═══════════════════════════════════════════════════════════════════════════

function computeYields(opts) {
  const { recommended, term_months, mode, channel, loan_pence, assumptions } = opts;

  // Gross APR: rate × 12 + (upfront + exit) × (12/term)
  // Commitment fee NETTED off upfront at drawdown — NOT additive (CONTINUITY §6).
  const rate_apr_bps    = recommended.rate_bps_pm * 12;
  const fee_factor      = term_months > 0 ? (12 / term_months) : 0;
  const upfront_apr_bps = Math.round(recommended.upfront_fee_bps * fee_factor);
  const exit_apr_bps    = Math.round(recommended.exit_fee_bps * fee_factor);
  const gross_yield_apr_bps = rate_apr_bps + upfront_apr_bps + exit_apr_bps;

  // Broker fee — paid one-off at drawdown, annualise over term.
  // Direct channel or whole_loan mode = no broker.
  let broker_bps = 0;
  if (channel !== 'direct' && mode !== 'whole_loan') {
    const broker_tier = lookupTier(assumptions.broker_fee_tiers_bps?.value_jsonb, loan_pence);
    broker_bps = broker_tier.bps || 0;
  }
  const broker_apr_bps = Math.round(broker_bps * fee_factor);
  const net_yield_after_broker_apr_bps = gross_yield_apr_bps - broker_apr_bps;

  return {
    rate_apr_bps,
    upfront_apr_bps,
    exit_apr_bps,
    gross_yield_apr_bps,
    broker_bps_one_off: broker_bps,
    broker_apr_bps,
    net_yield_after_broker_apr_bps,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Stress matrix — 7 scenarios per design Q3
// ═══════════════════════════════════════════════════════════════════════════

const LGD_BANDS = ['A', 'B', 'C', 'D', 'E'];

function shiftBand(band, delta) {
  const idx = LGD_BANDS.indexOf(band);
  if (idx < 0) return band;
  const newIdx = Math.min(LGD_BANDS.length - 1, Math.max(0, idx + delta));
  return LGD_BANDS[newIdx];
}

function shiftPd(pd, delta) {
  return Math.min(9, Math.max(1, pd + delta));
}

/**
 * Recompute EL + required yield + margin buffer at shifted PD/LGD.
 * Holds rates/fees/levers constant — purpose is to show resilience
 * of the recommendation, not to re-price the deal.
 */
function computeStressMatrix(opts) {
  const {
    assumptions, baseline_pd, baseline_lgd, mode,
    loan_pence, book_pence, gross_yield_apr_bps, broker_apr_bps,
  } = opts;

  const scenarios = [
    { key: 'base',         pd_shift: 0, lgd_shift: 0 },
    { key: 'PD+1',         pd_shift: 1, lgd_shift: 0 },
    { key: 'PD+2',         pd_shift: 2, lgd_shift: 0 },
    { key: 'LGD+1',        pd_shift: 0, lgd_shift: 1 },
    { key: 'LGD+2',        pd_shift: 0, lgd_shift: 2 },
    { key: 'PD+1×LGD+1',   pd_shift: 1, lgd_shift: 1 },
    { key: 'PD+2×LGD+2',   pd_shift: 2, lgd_shift: 2 },
  ];

  const net_yield = gross_yield_apr_bps - broker_apr_bps;
  return scenarios.map(s => {
    const pd_shifted  = shiftPd(baseline_pd, s.pd_shift);
    const lgd_shifted = shiftBand(baseline_lgd, s.lgd_shift);
    const stack = buildCostStack({
      assumptions, mode, loan_pence, book_pence,
      pd: pd_shifted, lgd: lgd_shifted,
    });
    return {
      scenario: s.key,
      pd_shifted, lgd_shifted,
      el_apr_bps: stack.el_apr_bps,
      required_yield_apr_bps: stack.required_yield_apr_bps,
      margin_buffer_bps: net_yield - stack.required_yield_apr_bps,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Decline gate
// ═══════════════════════════════════════════════════════════════════════════

function evaluateDecline(opts) {
  const {
    required_yield_apr_bps, net_yield_after_broker_apr_bps,
    rate_capped, assumptions, concentration_adder_bps,
    rate_bps_pm, mode,
  } = opts;

  const reasons = [];
  let decline = false;

  const apr_cap = assumptions.regulatory_apr_cap_bps?.value_bps || 2500;
  if (required_yield_apr_bps > apr_cap) {
    decline = true;
    reasons.push(`Required APR ${(required_yield_apr_bps/100).toFixed(2)}% > FCA cap ${(apr_cap/100).toFixed(0)}%`);
  }

  // Cost floor: rate cannot drop below CoF + CapCost + Opex + min margin (warehouse)
  // OR SONIA + 300 spread (whole-loan). Below floor = decline regardless of fees.
  if (rate_bps_pm !== undefined && mode !== undefined) {
    const floorCheck = checkRateFloor(rate_bps_pm, mode, assumptions);
    if (floorCheck.below_floor) {
      decline = true;
      reasons.push(
        `Rate ${(rate_bps_pm/100).toFixed(2)}% pm below ${floorCheck.floor_source} floor ${(floorCheck.floor_bps_pm/100).toFixed(2)}% pm — loss-making at any fee structure`
      );
    }
  }

  // If rate is at ceiling AND fees can't close gap, decline
  if (rate_capped && net_yield_after_broker_apr_bps < required_yield_apr_bps) {
    decline = true;
    reasons.push(
      `Rate at ceiling but margin buffer negative ` +
      `(net ${(net_yield_after_broker_apr_bps/100).toFixed(2)}% < required ${(required_yield_apr_bps/100).toFixed(2)}%)`
    );
  }

  // Concentration warning (>15% bucket = 200 bps adder per LOCKED defaults)
  if (concentration_adder_bps >= 200) {
    reasons.push('Concentration >15% of book — pierces single-borrower limit, often DECLINE');
    // not auto-decline by itself; flagged for human review
  }

  return { decline_flag: decline, decline_reason: reasons.join('; ') || null };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Whole-loan alternative (≥£5m parallel envelope)
// ═══════════════════════════════════════════════════════════════════════════

async function buildWholeLoanAlternative(input, config, gridCell, iaDelta, client) {
  const { assumptions } = config;
  const threshold = assumptions.whole_loan_threshold_pence?.value_pence;
  if (!threshold || Number(input.loan_amount_pence) < Number(threshold)) {
    return null;
  }

  const recommended = buildRecommendedLevers({
    gridCell, iaDelta, assumptions,
    lgd: input.lgd, ia: input.ia,
    stress_flagged: input.stress_flagged,
  });

  const cost_stack = buildCostStack({
    assumptions, mode: 'whole_loan',
    loan_pence: input.loan_amount_pence,
    book_pence: input.book_size_pence,
    pd: input.pd, lgd: input.lgd,
  });

  const yields = computeYields({
    recommended, term_months: input.term_months,
    mode: 'whole_loan', channel: 'direct',
    loan_pence: input.loan_amount_pence, assumptions,
  });

  return {
    mode: 'whole_loan',
    recommended,
    cost_stack,
    ...yields,
    margin_buffer_bps: yields.net_yield_after_broker_apr_bps - cost_stack.required_yield_apr_bps,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main entrypoint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the full pricing envelope:
 *   {
 *     pricing_versions: { assumptions, grid, ia_modifiers },
 *     inputs: { ...echo },
 *     cell: { ... raw grid cell + IA delta },
 *     recommended: { rate_bps_pm, upfront_fee_bps, ..., min_term_months },
 *     cost_stack: { sonia_apr_bps, cof_apr_bps, structuring_apr_bps, el_apr_bps,
 *                   capital_cost_apr_bps, opex_apr_bps, margin_apr_bps,
 *                   required_yield_apr_bps, ... },
 *     gross_yield_apr_bps,
 *     broker_apr_bps,
 *     net_yield_after_broker_apr_bps,
 *     margin_buffer_bps,
 *     decline_flag,
 *     decline_reason,
 *     stress_matrix: [...],
 *     whole_loan_alternative: null | {...},
 *     priced_at: ISO8601
 *   }
 */
async function priceDeal(input, client, opts = {}) {
  const db = client || pool;

  // Normalise input
  const mode = input.mode || 'warehouse';
  const channel = input.channel || (mode === 'whole_loan' ? 'direct' : 'broker');
  const stress_flagged = !!input.stress_flagged;

  if (!input.sector || !input.pd || !input.lgd || !input.ia) {
    throw new Error(`pricing-engine: missing required inputs (sector, pd, lgd, ia all required)`);
  }
  if (!input.loan_amount_pence || !input.term_months) {
    throw new Error(`pricing-engine: missing loan_amount_pence or term_months`);
  }

  // Load active config. Grid cell can be overridden (PRICE-5 cell editor
  // preview path) — when overrides.gridCell is provided, skip the DB lookup
  // and use the provided cell. Lets the admin UI preview unsaved edits.
  const config = await loadActivePricingConfig(db);
  const gridCell = opts.gridCell
    ? opts.gridCell
    : await loadGridCell(config.versions.grid, input.sector, input.pd, input.lgd, db);
  const iaDelta = config.ia_modifiers[input.ia];
  if (!iaDelta) {
    throw new Error(`pricing-engine: no IA modifier for band '${input.ia}' in version ${config.versions.ia_modifiers}`);
  }

  // Recommended levers (grid + IA + ceiling clamp + min_term joint lookup)
  const recommended = buildRecommendedLevers({
    gridCell, iaDelta,
    assumptions: config.assumptions,
    lgd: input.lgd, ia: input.ia,
    stress_flagged,
  });

  // Cost stack (corrected CoF math)
  const cost_stack = buildCostStack({
    assumptions: config.assumptions,
    mode,
    loan_pence: input.loan_amount_pence,
    book_pence: input.book_size_pence,
    pd: input.pd, lgd: input.lgd,
  });

  // Yields
  const yields = computeYields({
    recommended,
    term_months: input.term_months,
    mode, channel,
    loan_pence: input.loan_amount_pence,
    assumptions: config.assumptions,
  });

  const margin_buffer_bps = yields.net_yield_after_broker_apr_bps - cost_stack.required_yield_apr_bps;

  // Decline gate
  const decline = evaluateDecline({
    required_yield_apr_bps: cost_stack.required_yield_apr_bps,
    net_yield_after_broker_apr_bps: yields.net_yield_after_broker_apr_bps,
    rate_capped: recommended.rate_capped,
    assumptions: config.assumptions,
    concentration_adder_bps: cost_stack.concentration_adder_bps,
    rate_bps_pm: recommended.rate_bps_pm,
    mode,
  });

  // Stress matrix (7 scenarios at fixed levers, shift PD/LGD only)
  const stress_matrix = computeStressMatrix({
    assumptions: config.assumptions,
    baseline_pd: input.pd, baseline_lgd: input.lgd,
    mode,
    loan_pence: input.loan_amount_pence,
    book_pence: input.book_size_pence,
    gross_yield_apr_bps: yields.gross_yield_apr_bps,
    broker_apr_bps: yields.broker_apr_bps,
  });

  // Whole-loan alternative for ≥£5m
  const whole_loan_alternative = await buildWholeLoanAlternative(input, config, gridCell, iaDelta, db);

  return {
    pricing_versions: config.versions,
    inputs: {
      deal_id: input.deal_id,
      risk_view_id: input.risk_view_id || null,
      loan_amount_pence: input.loan_amount_pence,
      term_months: input.term_months,
      sector: input.sector,
      pd: input.pd, lgd: input.lgd, ia: input.ia,
      mode, channel,
      stress_flagged,
      stress_reason: input.stress_reason || null,
      book_size_pence: input.book_size_pence || null,
    },
    cell: {
      sector: input.sector,
      pd: input.pd, lgd: input.lgd, ia: input.ia,
      grid_cell: gridCell,
      ia_delta: iaDelta,
    },
    recommended,
    cost_stack,
    gross_yield_apr_bps: yields.gross_yield_apr_bps,
    rate_apr_bps: yields.rate_apr_bps,
    upfront_apr_bps: yields.upfront_apr_bps,
    exit_apr_bps: yields.exit_apr_bps,
    broker_bps_one_off: yields.broker_bps_one_off,
    broker_apr_bps: yields.broker_apr_bps,
    net_yield_after_broker_apr_bps: yields.net_yield_after_broker_apr_bps,
    margin_buffer_bps,
    decline_flag: decline.decline_flag,
    decline_reason: decline.decline_reason,
    stress_matrix,
    whole_loan_alternative,
    priced_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  previewCellImpact (PRICE-5) — lightweight preview for admin grid editor
//  ─────────────────────────────────────────────────────────────────────────
//  Skips stress matrix + whole-loan alt + audit trail. Uses a synthetic
//  example deal (loan + term + IA admin picks at the page level) and a
//  synthetic grid cell (the values the admin is currently typing into the
//  cell editor). Returns just the headline numbers the editor needs:
//  required APR, net APR, margin buffer, decline flag.
//
//  Designed to be called on every keystroke (debounced ~300ms client-side).
// ═══════════════════════════════════════════════════════════════════════════
async function previewCellImpact(opts, client) {
  const db = client || pool;
  const {
    sector, pd, lgd, ia,
    levers,                      // { rate_bps_pm, upfront_fee_bps, commitment_fee_bps, retained_months, exit_fee_bps, min_term_months }
    example_loan_pence,
    example_term_months,
    mode = 'warehouse',
    channel,
  } = opts;

  if (!sector || !pd || !lgd || !ia) {
    throw new Error('previewCellImpact: sector/pd/lgd/ia all required');
  }
  if (!example_loan_pence || !example_term_months) {
    throw new Error('previewCellImpact: example_loan_pence + example_term_months required');
  }

  // Build a synthetic grid cell from the levers being typed
  const syntheticCell = {
    base_rate_bps_pm:        Number(levers.rate_bps_pm)        || 0,
    base_upfront_fee_bps:    Number(levers.upfront_fee_bps)    || 0,
    base_commitment_fee_bps: Number(levers.commitment_fee_bps) || 0,
    retained_months:         Number(levers.retained_months)    || 0,
    base_exit_fee_bps:       Number(levers.exit_fee_bps)       || 0,
    min_term_months:         Number(levers.min_term_months)    || 0,
  };

  const config = await loadActivePricingConfig(db);
  const iaDelta = config.ia_modifiers[ia];
  if (!iaDelta) throw new Error(`previewCellImpact: unknown IA band '${ia}'`);

  const recommended = buildRecommendedLevers({
    gridCell: syntheticCell, iaDelta,
    assumptions: config.assumptions,
    lgd, ia, stress_flagged: false,
  });

  const cost_stack = buildCostStack({
    assumptions: config.assumptions,
    mode,
    loan_pence: example_loan_pence,
    book_pence: null, // use expected_avg_book_pence from assumptions
    pd, lgd,
  });

  const yields = computeYields({
    recommended,
    term_months: example_term_months,
    mode,
    channel: channel || 'broker',
    loan_pence: example_loan_pence,
    assumptions: config.assumptions,
  });

  const margin_buffer_bps = yields.net_yield_after_broker_apr_bps - cost_stack.required_yield_apr_bps;

  const decline = evaluateDecline({
    required_yield_apr_bps: cost_stack.required_yield_apr_bps,
    net_yield_after_broker_apr_bps: yields.net_yield_after_broker_apr_bps,
    rate_capped: recommended.rate_capped,
    assumptions: config.assumptions,
    concentration_adder_bps: cost_stack.concentration_adder_bps,
    rate_bps_pm: recommended.rate_bps_pm,
    mode,
  });

  return {
    pricing_versions: config.versions,
    inputs: {
      sector, pd, lgd, ia, mode,
      example_loan_pence, example_term_months,
    },
    recommended,
    cost_stack,
    gross_yield_apr_bps: yields.gross_yield_apr_bps,
    broker_apr_bps: yields.broker_apr_bps,
    net_yield_after_broker_apr_bps: yields.net_yield_after_broker_apr_bps,
    margin_buffer_bps,
    decline_flag: decline.decline_flag,
    decline_reason: decline.decline_reason,
  };
}

module.exports = {
  priceDeal,
  previewCellImpact,
  loadActivePricingConfig,
  // Internal helpers exported for unit testing:
  loadGridCell,
  buildCostStack,
  buildRecommendedLevers,
  computeYields,
  computeStressMatrix,
  evaluateDecline,
  buildWholeLoanAlternative,
  applyRateCeiling,
  checkRateFloor,
  lookupTier,
  lookupConcentration,
  lookupMinTermJoint,
};
