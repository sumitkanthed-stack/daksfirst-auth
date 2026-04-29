/**
 * Cross-collateral helpers · XCOLL-2 (2026-04-29)
 *
 * Centralises the math for deals where Daksfirst takes security across
 * multiple properties with mixed charge positions and loan purposes.
 *
 * Policy (locked 2026-04-29):
 *   1st charge + acquisition or refinance → full market_value as security
 *   2nd or 3rd charge                     → £0 (comfort only, not in LTV)
 *
 * Aggregate effective LTV = daksfirst_exposure / sum(1st-charge market values)
 *
 * 2nd-charge security is reported separately as "comfort" — surfaced to RM
 * and Opus but never reduces grade severity by more than half a band.
 *
 * S&U auto-redemption lines: for any property with loan_purpose='refinance',
 * the existing_charge_balance_pence is auto-listed as a Use line so RM
 * doesn't have to type it twice.
 */

// Pence helpers — matrix stores values in pounds; cross-collateral output
// stays in pence to mirror the rest of the codebase (Stripe pattern).
function poundsToPence(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function pencePlain(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : Math.round(n);
}

/**
 * Effective security value for a single property in pence.
 * Returns 0 for 2nd/3rd charges (comfort only, no LTV credit).
 * Falls back to first-charge default if security_charge_type is null
 * (matches the UI which defaults the dropdown to first_charge).
 */
function propertyEffectiveSecurityValuePence(prop) {
  const charge = prop.security_charge_type || 'first_charge';
  if (charge === 'second_charge' || charge === 'third_charge') return 0;
  if (charge === 'no_charge') return 0;
  // first_charge regardless of acquisition / refinance / equity_release
  // (refi means we redeem the existing 1st and become senior — same value
  // capture; equity_release only makes sense with 2nd charge so should
  // never hit this branch in practice, but defensive).
  return poundsToPence(prop.market_value);
}

/**
 * 2nd/3rd charge "comfort" security value in pence — what we'd capture
 * after the prior charge gets paid out, conservatively. Not in LTV math.
 *
 *   comfort = market_value − existing_charge_balance_pence
 *
 * Floor at zero (no negative comfort).
 */
function propertyComfortSecurityValuePence(prop) {
  const charge = prop.security_charge_type || 'first_charge';
  if (charge !== 'second_charge' && charge !== 'third_charge') return 0;
  const mv = poundsToPence(prop.market_value);
  const prior = pencePlain(prop.existing_charge_balance_pence);
  return Math.max(0, mv - prior);
}

/**
 * Aggregate effective security value (pence) — the denominator for
 * effective LTV. Excludes 2nd-charge properties entirely.
 */
function aggregateEffectiveSecurityValuePence(properties) {
  if (!Array.isArray(properties)) return 0;
  return properties.reduce((sum, p) => sum + propertyEffectiveSecurityValuePence(p), 0);
}

/**
 * Aggregate comfort security (pence) — sum of 2nd/3rd-charge equity-after-prior.
 * Reported separately as risk mitigant, never enters LTV.
 */
function aggregateComfortSecurityValuePence(properties) {
  if (!Array.isArray(properties)) return 0;
  return properties.reduce((sum, p) => sum + propertyComfortSecurityValuePence(p), 0);
}

/**
 * Effective aggregate LTV (percentage, e.g. 70.5).
 * Returns null if no first-charge security exists (avoids div-by-zero
 * and signals "decline by definition" — caller decides how to render).
 */
function effectiveAggregateLtvPct(daksfirstExposurePence, properties) {
  const sec = aggregateEffectiveSecurityValuePence(properties);
  if (!sec || sec === 0) return null;
  return (daksfirstExposurePence / sec) * 100;
}

/**
 * Auto-derived S&U redemption lines for properties with loan_purpose='refinance'.
 * Each line: { property_id, address, balance_pence, lender_note }
 * lender_note is the free-text existing_charges_note (RM annotation).
 */
function buildAutoRedemptionLines(properties) {
  if (!Array.isArray(properties)) return [];
  return properties
    .filter((p) => p.loan_purpose === 'refinance')
    .map((p) => ({
      property_id:    p.id,
      address:        p.address || null,
      postcode:       p.postcode || null,
      balance_pence:  pencePlain(p.existing_charge_balance_pence),
      lender_note:    p.existing_charges_note || null,
      // The RM-typed encumbrance note often contains the lender name; we
      // surface it for IC-pack readability without parsing.
    }));
}

/**
 * Headline summary — one object that the frontend renders, the risk
 * packager ships to Opus, and the IC pack uses. All values in pence
 * unless noted.
 */
function buildCrossCollateralSummary(properties, daksfirstExposurePence) {
  const props = Array.isArray(properties) ? properties : [];
  const firstChargeProps = props.filter((p) => {
    const c = p.security_charge_type || 'first_charge';
    return c === 'first_charge';
  });
  const secondChargeProps = props.filter((p) => p.security_charge_type === 'second_charge');
  const thirdChargeProps  = props.filter((p) => p.security_charge_type === 'third_charge');
  const refinanceProps    = props.filter((p) => p.loan_purpose === 'refinance');

  const effectiveSec = aggregateEffectiveSecurityValuePence(props);
  const comfortSec   = aggregateComfortSecurityValuePence(props);
  const effectiveLtv = effectiveAggregateLtvPct(daksfirstExposurePence, props);

  const totalRedemptions = refinanceProps.reduce(
    (sum, p) => sum + pencePlain(p.existing_charge_balance_pence),
    0
  );

  // Cross-collateral flag: any deal with > 1 property at 1st charge OR any
  // property at 2nd/3rd charge counts as cross-collateralised.
  const isCrossCollateral =
    firstChargeProps.length > 1 ||
    secondChargeProps.length > 0 ||
    thirdChargeProps.length > 0;

  return {
    is_cross_collateralised:           isCrossCollateral,
    properties_count:                  props.length,
    first_charge_count:                firstChargeProps.length,
    second_charge_count:                secondChargeProps.length,
    third_charge_count:                 thirdChargeProps.length,
    refinance_count:                   refinanceProps.length,
    effective_security_value_pence:    effectiveSec,
    comfort_security_value_pence:      comfortSec,
    effective_ltv_pct:                 effectiveLtv,
    daksfirst_exposure_pence:          daksfirstExposurePence,
    total_existing_redemptions_pence:  totalRedemptions,
    auto_redemption_lines:             buildAutoRedemptionLines(props),
  };
}

module.exports = {
  poundsToPence,
  pencePlain,
  propertyEffectiveSecurityValuePence,
  propertyComfortSecurityValuePence,
  aggregateEffectiveSecurityValuePence,
  aggregateComfortSecurityValuePence,
  effectiveAggregateLtvPct,
  buildAutoRedemptionLines,
  buildCrossCollateralSummary,
};
