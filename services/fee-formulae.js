// ═══════════════════════════════════════════════════════════════════════════
//  Fee formulae — canonical calculations for DIP-stage fees
//  Created 2026-04-20 (Matrix-SSOT, Session M1)
//
//  All calculations derived from loan_amount_approved. RM can override the
//  computed default via matrix inline edit (override writes to commitment_fee
//  / dip_fee columns directly). These helpers compute the SUGGESTED default.
//
//  DIP fee:       £1,000 flat (onboarding fee for underwriting kick-off).
//                 Not scaled by loan size — it's a commitment signal, not commission.
//                 RM can increase for complex deals.
//
//  Commitment fee: 0.10% × loan_approved
//                  Rounded DOWN in £2,000 increments
//                  Minimum £5,000
//                  Examples:
//                    £   750,000 → 0.10% = £   750 → round-down £2k = £0    → min £5k = £5,000
//                    £ 5,000,000 → 0.10% = £ 5,000 → round-down £2k = £4k   → min £5k = £5,000
//                    £ 7,500,000 → 0.10% = £ 7,500 → round-down £2k = £6k          = £6,000
//                    £10,000,000 → 0.10% = £10,000 → round-down £2k = £10k         = £10,000
//                    £13,400,000 → 0.10% = £13,400 → round-down £2k = £12k         = £12,000
// ═══════════════════════════════════════════════════════════════════════════

const DIP_FEE_DEFAULT = 1000;
const COMMITMENT_FEE_RATE = 0.001;      // 0.10%
const COMMITMENT_FEE_MIN = 5000;         // £5k floor
const COMMITMENT_FEE_INCREMENT = 2000;   // round DOWN in £2k steps

/**
 * Flat default onboarding/DIP fee. Does NOT scale with loan size.
 * @returns {number} £1,000
 */
function computeDipFee() {
  return DIP_FEE_DEFAULT;
}

/**
 * Commitment fee default for a given approved loan amount.
 * @param {number|string|null} loanApproved
 * @returns {number} final fee in GBP (never < COMMITMENT_FEE_MIN)
 */
function computeCommitmentFee(loanApproved) {
  const n = Number(loanApproved || 0);
  if (!isFinite(n) || n <= 0) return COMMITMENT_FEE_MIN;
  const raw = n * COMMITMENT_FEE_RATE;
  const rounded = Math.floor(raw / COMMITMENT_FEE_INCREMENT) * COMMITMENT_FEE_INCREMENT;
  return Math.max(COMMITMENT_FEE_MIN, rounded);
}

/**
 * Human-readable breakdown of the commitment fee calc for matrix tooltips.
 * Returns { value, steps[] } where steps is an ordered list of "0.10% × X = Y"
 * style strings the UI can render as a tooltip or inline explanation.
 */
function explainCommitmentFee(loanApproved) {
  const n = Number(loanApproved || 0);
  const steps = [];
  if (!isFinite(n) || n <= 0) {
    steps.push(`Loan amount not set — commitment fee defaults to minimum £${COMMITMENT_FEE_MIN.toLocaleString()}`);
    return { value: COMMITMENT_FEE_MIN, steps };
  }
  const raw = n * COMMITMENT_FEE_RATE;
  const rounded = Math.floor(raw / COMMITMENT_FEE_INCREMENT) * COMMITMENT_FEE_INCREMENT;
  const final = Math.max(COMMITMENT_FEE_MIN, rounded);

  steps.push(`0.10% × £${n.toLocaleString()} = £${raw.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  steps.push(`round down to nearest £${COMMITMENT_FEE_INCREMENT.toLocaleString()} = £${rounded.toLocaleString()}`);
  if (rounded < COMMITMENT_FEE_MIN) {
    steps.push(`below £${COMMITMENT_FEE_MIN.toLocaleString()} minimum — kicks up to £${final.toLocaleString()}`);
  }
  return { value: final, steps };
}

module.exports = {
  computeDipFee,
  computeCommitmentFee,
  explainCommitmentFee,
  DIP_FEE_DEFAULT,
  COMMITMENT_FEE_RATE,
  COMMITMENT_FEE_MIN,
  COMMITMENT_FEE_INCREMENT
};
