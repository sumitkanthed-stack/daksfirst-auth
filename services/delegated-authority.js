// ═══════════════════════════════════════════════════════════════════════════
//  Delegated Authority — auto-routing rules engine
//  Created 2026-04-20 (Session 1b)
//
//  Evaluates a deal against admin-configurable thresholds + hard rules.
//  Returns { eligible, decision, rules[], summary } so callers can route
//  the DIP to broker (eligible=true) or to Credit queue (eligible=false).
//
//  The engine is PURE — takes deal + config, returns a decision object.
//  Callers are responsible for loading the deal (with borrowers + properties)
//  and the config row, and for persisting the decision on deal_submissions.
//
//  Defaults for config fields (per 2026-04-11 agreement):
//    auto_approve_enabled       = true
//    auto_approve_max_loan      = £1,000,000
//    auto_approve_max_ltv_pct   = 65.00%
//    auto_approve_asset_types   = ['residential']
//
//  Hard rules (not configurable — deliberate policy floor):
//    - England or Wales only
//    - Single primary borrower, zero joints
//    - Single security property
//    - No adverse flags: insolvency history, CH status ≠ active, PEP, sanctions
// ═══════════════════════════════════════════════════════════════════════════

const UK_GEOGRAPHIES = ['england', 'wales', 'united kingdom', 'uk'];

/**
 * Normalize a country/region string for geography comparison.
 * Returns lowercase trimmed string or empty string if falsy.
 */
function _normalizeGeo(s) {
  return String(s || '').toLowerCase().trim();
}

/**
 * Extract the borrower's loan amount as a number. Safe against NULL/undefined/strings.
 */
function _numLoan(deal) {
  const raw = deal.loan_amount;
  if (raw == null) return 0;
  const n = Number(raw);
  return isFinite(n) ? n : 0;
}

/**
 * Sum market values across security properties to get total MV for LTV calc.
 * Uses `market_value` column per property. Returns 0 if no properties or all empty.
 */
function _totalMarketValue(deal) {
  const props = Array.isArray(deal.properties) ? deal.properties : [];
  return props.reduce((sum, p) => {
    const mv = Number(p.market_value || 0);
    return sum + (isFinite(mv) ? mv : 0);
  }, 0);
}

/**
 * Day-1 LTV from loan / total market value. Returns null if MV is zero (can't compute).
 */
function _day1Ltv(deal) {
  const mv = _totalMarketValue(deal);
  if (mv <= 0) return null;
  return (_numLoan(deal) / mv) * 100;
}

/**
 * Count top-level primary borrowers (excludes children and joints).
 */
function _primaryCount(deal) {
  const bors = Array.isArray(deal.borrowers) ? deal.borrowers : [];
  return bors.filter(b => b.role === 'primary' && !b.parent_borrower_id).length;
}

/**
 * Count top-level joint borrowers.
 */
function _jointCount(deal) {
  const bors = Array.isArray(deal.borrowers) ? deal.borrowers : [];
  return bors.filter(b => b.role === 'joint' && !b.parent_borrower_id).length;
}

/**
 * Detect adverse flags across all borrowers on the deal.
 * Returns array of human-readable strings describing each flag found.
 */
function _adverseFlags(deal) {
  const bors = Array.isArray(deal.borrowers) ? deal.borrowers : [];
  const flags = [];
  for (const b of bors) {
    const chm = b.ch_match_data || {};
    if (chm.has_insolvency_history === true) {
      flags.push(`${b.full_name || 'unnamed'}: insolvency history`);
    }
    if (chm.company_status && chm.company_status !== 'active') {
      flags.push(`${b.full_name || 'unnamed'}: CH status=${chm.company_status}`);
    }
    if (b.pep_status === 'flagged') {
      flags.push(`${b.full_name || 'unnamed'}: PEP flagged`);
    }
    if (b.sanctions_status === 'flagged') {
      flags.push(`${b.full_name || 'unnamed'}: sanctions flagged`);
    }
  }
  return flags;
}

/**
 * Evaluate auto-route eligibility for a deal.
 *
 * @param {Object} deal - deal object with embedded borrowers[] and properties[]
 * @param {Object} config - admin_config row (auto_approve_* fields)
 * @returns {Object} { eligible, decision, rules[], summary }
 *
 * `rules` is an array of per-rule results so the caller can show the user
 * EXACTLY which rule blocked auto-route (pre-flight modal, Credit queue reason).
 * Every rule is evaluated even if an earlier one failed — this gives a complete
 * report rather than short-circuiting on the first failure.
 */
function evaluateAutoRoute(deal, config) {
  // Safety: if config is missing or disabled, route to Credit
  if (!config || config.auto_approve_enabled === false) {
    return {
      eligible: false,
      decision: 'credit_review',
      rules: [{ rule: 'auto_approve_enabled', pass: false, value: false, reason: 'Auto-routing disabled in admin config' }],
      summary: 'disabled'
    };
  }

  const results = [];

  // 1. Loan amount
  const loan = _numLoan(deal);
  const maxLoan = Number(config.auto_approve_max_loan || 0);
  const loanPass = loan > 0 && loan <= maxLoan;
  results.push({ rule: 'loan_amount', pass: loanPass, value: loan, threshold: maxLoan,
    message: loanPass ? `Loan £${loan.toLocaleString()} ≤ £${maxLoan.toLocaleString()}` :
      (loan <= 0 ? 'Loan amount not set' : `Loan £${loan.toLocaleString()} exceeds cap £${maxLoan.toLocaleString()}`) });

  // 2. Day-1 LTV
  const day1Ltv = _day1Ltv(deal);
  const maxLtv = Number(config.auto_approve_max_ltv_pct || 0);
  const ltvPass = day1Ltv !== null && day1Ltv <= maxLtv;
  results.push({ rule: 'ltv', pass: ltvPass, value: day1Ltv, threshold: maxLtv,
    message: day1Ltv === null ? 'Cannot compute LTV (market value missing)' :
      (ltvPass ? `LTV ${day1Ltv.toFixed(1)}% ≤ ${maxLtv}%` : `LTV ${day1Ltv.toFixed(1)}% exceeds cap ${maxLtv}%`) });

  // 3. Asset type — EVERY security property must be in the allow-list
  const propsArr = Array.isArray(deal.properties) ? deal.properties : [];
  const assetTypes = propsArr.map(p => String(p.asset_type || p.property_type || '').toLowerCase());
  const allowedTypes = (config.auto_approve_asset_types || []).map(t => String(t).toLowerCase());
  const assetPass = assetTypes.length > 0 && assetTypes.every(t => t && allowedTypes.includes(t));
  results.push({ rule: 'asset_type', pass: assetPass, values: assetTypes, allowed: allowedTypes,
    message: assetTypes.length === 0 ? 'No properties on deal' :
      (assetPass ? `All ${assetTypes.length} asset(s) in allow-list` :
        `Asset types not all allowed: [${assetTypes.join(', ')}] vs allowed [${allowedTypes.join(', ')}]`) });

  // 4. Geography — EVERY property country must be UK (England/Wales policy-hard)
  const countries = propsArr.map(p => _normalizeGeo(p.country));
  const geoPass = countries.length > 0 && countries.every(c => c && UK_GEOGRAPHIES.includes(c));
  results.push({ rule: 'geography', pass: geoPass, values: countries,
    message: countries.length === 0 ? 'No properties on deal' :
      (geoPass ? `All ${countries.length} property/properties in UK` :
        `Non-UK or missing country on at least one property: [${countries.join(', ')}]`) });

  // 5. Single primary borrower (hard rule)
  const pCount = _primaryCount(deal);
  const jCount = _jointCount(deal);
  const borrowerPass = pCount === 1 && jCount === 0;
  results.push({ rule: 'single_borrower', pass: borrowerPass, primary: pCount, joint: jCount,
    message: borrowerPass ? '1 primary, 0 joint' :
      `${pCount} primary + ${jCount} joint — only single-primary deals auto-route` });

  // 6. Single security (hard rule)
  const propCount = propsArr.length;
  const securityPass = propCount === 1;
  results.push({ rule: 'single_security', pass: securityPass, count: propCount,
    message: securityPass ? '1 security property' :
      (propCount === 0 ? 'No security properties on deal' : `${propCount} properties — only single-security deals auto-route`) });

  // 7. No adverse flags (hard rule)
  const flags = _adverseFlags(deal);
  const adversePass = flags.length === 0;
  results.push({ rule: 'no_adverse_flags', pass: adversePass, flags,
    message: adversePass ? 'No adverse flags' : `Adverse flags present: ${flags.join('; ')}` });

  const allPass = results.every(r => r.pass);
  const failedRules = results.filter(r => !r.pass).map(r => r.rule);

  return {
    eligible: allPass,
    decision: allPass ? 'auto_issue' : 'credit_review',
    rules: results,
    summary: allPass ? 'all_pass' : failedRules.join(', ')
  };
}

/**
 * Convenience helper: shrink the evaluator result to a compact object suitable
 * for persistence in deal_submissions.auto_route_reason (JSONB).
 */
function compactReason(result) {
  return {
    decision: result.decision,
    summary: result.summary,
    failed_rules: result.rules.filter(r => !r.pass).map(r => ({
      rule: r.rule,
      message: r.message || null,
      value: r.value,
      threshold: r.threshold
    })),
    evaluated_at: new Date().toISOString()
  };
}

module.exports = {
  evaluateAutoRoute,
  compactReason,
  // Exported for testing
  _normalizeGeo,
  _numLoan,
  _totalMarketValue,
  _day1Ltv,
  _primaryCount,
  _jointCount,
  _adverseFlags,
  UK_GEOGRAPHIES
};
