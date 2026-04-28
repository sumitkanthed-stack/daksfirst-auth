/**
 * deal-display.js — Single source of truth for deal DISPLAY logic.
 *
 * Created 2026-04-21 to end duplicated rendering code across Snapshot,
 * Matrix header, Deal Progress bar, deals list, and any other surface
 * that needs to present a deal to a user.
 *
 * What this file owns:
 *   - Stage synthesis (info_gathering + assigned_rm → 'under_review')
 *   - Stage labels (same across broker/RM so messaging is consistent)
 *   - Stage pipeline order for timeline displays
 *   - Portfolio reads: sorted properties, valuation, headline address
 *   - Primary borrower display name (canonical hierarchical + flat fallback)
 *
 * What this file does NOT own:
 *   - Business logic gates (stage === 'draft' checks for edit permission).
 *     Those stay on the raw `deal.deal_stage` — they need the exact DB value,
 *     not a synthesised UI label.
 *   - Data mutation of any kind. Pure read/derive helpers.
 */

const CORPORATE_TYPES = ['corporate', 'spv', 'ltd', 'llp', 'trust', 'partnership'];

const PRE_DIP_STAGES = ['draft', 'received', 'info_gathering', 'under_review'];

// ═══════════════════════════════════════════════════════════════════
// LOAN PURPOSE — controlled vocabulary
// ═══════════════════════════════════════════════════════════════════
// Shared enum for the broker-facing loan purpose dropdown. UK bridging
// standard categories. Used on the day-zero deal creation wizard AND the
// Matrix Use of Funds section so the same options render consistently.
//
// Ordering: most common first (acquisition / refinance), refurb categories
// grouped, edge cases at the end.
export const LOAN_PURPOSE_OPTIONS = [
  { value: 'acquisition',      label: 'Acquisition — property purchase' },
  { value: 'refinance',        label: 'Refinance — clear existing lender' },
  { value: 'bridge_to_sale',   label: 'Bridge to sale — short-term, exit via sale' },
  { value: 'bridge_to_let',    label: 'Bridge to let — refinance onto BTL' },
  { value: 'light_refurb',     label: 'Light refurbishment (<15% of value, no planning)' },
  { value: 'heavy_refurb',     label: 'Heavy refurbishment / conversion' },
  { value: 'development_exit', label: 'Development exit (finished stock)' },
  { value: 'auction_purchase', label: 'Auction purchase (28-day completion)' },
  { value: 'cash_out',         label: 'Equity release / cash-out' },
  { value: 'chain_break',      label: 'Chain break' },
  { value: 'other',            label: 'Other (explain below)' }
];

const LOAN_PURPOSE_MAP = Object.fromEntries(LOAN_PURPOSE_OPTIONS.map(o => [o.value, o.label]));

// Sprint 2 — Exit strategy enums (deal_submissions structured cols)
export const EXIT_ROUTE_OPTIONS = [
  { value: 'sale',                  label: 'Sale — exit via property disposal' },
  { value: 'refinance_btl',         label: 'Refinance to BTL (specialist or high-street BTL lender)' },
  { value: 'refinance_owner_occ',   label: 'Refinance to owner-occupier mortgage' },
  { value: 'refinance_commercial',  label: 'Refinance to commercial mortgage' },
  { value: 'combination',           label: 'Combination — partial sale + partial refi' }
];

export const EXIT_CONFIDENCE_OPTIONS = [
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' }
];

/**
 * Get the human-readable label for a loan_purpose code. Falls back to the
 * code itself if unknown. Use this wherever the stored value needs display.
 */
export function getLoanPurposeLabel(code) {
  if (!code) return '';
  return LOAN_PURPOSE_MAP[code] || code;
}

/**
 * Purposes that require refurbishment detail (scope + cost) from broker.
 */
export function requiresRefurbDetail(loanPurpose) {
  return ['light_refurb', 'heavy_refurb'].includes(loanPurpose);
}

// ═══════════════════════════════════════════════════════════════════
// STAGE SYNTHESIS
// ═══════════════════════════════════════════════════════════════════

/**
 * Derive the display stage from the raw deal_stage + assigned_rm.
 *
 *   info_gathering + assigned_rm → 'under_review' (someone is actively looking)
 *   info_gathering + no RM       → stays 'info_gathering' (awaiting assignment)
 *   everything else              → returned as-is
 *
 * Use this whenever rendering a stage to a user. Use raw `deal.deal_stage`
 * only for business logic gates.
 */
export function deriveDisplayStage(deal) {
  const rawStage = (deal && deal.deal_stage) || 'draft';
  if (rawStage === 'info_gathering' && deal && deal.assigned_rm) return 'under_review';
  return rawStage;
}

/**
 * Is the deal in a pre-submit state (broker still editing or just submitted
 * but RM hasn't picked up)? Used to gate UI visibility of RM-owned fields.
 */
export function isPreSubmit(deal) {
  const stage = (deal && deal.deal_stage) || 'draft';
  return ['draft', 'received'].includes(stage);
}

/**
 * Is the deal pre-DIP (before a Decision in Principle is issued)? Covers
 * pre-submit plus info_gathering and under_review.
 */
export function isPreDip(deal) {
  const stage = deriveDisplayStage(deal);
  return PRE_DIP_STAGES.includes(stage);
}

// ═══════════════════════════════════════════════════════════════════
// STAGE LABELS
// ═══════════════════════════════════════════════════════════════════

// Unified labels — broker and RM/internal see the same stage names so
// messaging is consistent when they talk about "where the deal is".
const STAGE_LABELS = {
  draft:             'Draft',
  received:          'Submitted',
  info_gathering:    'Submitted',       // pre-RM-assignment; upgrades to 'Under Review' via synthesis
  assigned:          'Under Review',
  under_review:      'Under Review',    // synthesised stage
  dip_issued:        'DIP Issued',
  ai_termsheet:      'Indicative Termsheet',
  fee_pending:       'Fee Pending',
  fee_paid:          'Fee Paid',
  underwriting:      'Underwriting',
  bank_submitted:    'Bank Submitted',
  bank_approved:     'Bank Approved',
  borrower_accepted: 'Borrower Accepted',
  legal_instructed:  'Legal Instructed',
  completed:         'Completed',
  declined:          'Declined',
  withdrawn:         'Withdrawn'
};

/**
 * Get the user-facing stage label for a deal.
 *   getStageLabel({ deal_stage: 'info_gathering', assigned_rm: 5 }) → 'Under Review'
 *   getStageLabel({ deal_stage: 'draft' })                        → 'Draft'
 */
export function getStageLabel(deal) {
  const stage = deriveDisplayStage(deal);
  return STAGE_LABELS[stage] || stage;
}

/**
 * Stage pipeline order for timeline display. Draft first, under_review
 * between submitted and DIP issued.
 */
export function getStagePipelineOrder() {
  return [
    'draft',
    'received',
    'under_review',
    'dip_issued',
    'ai_termsheet',
    'fee_pending',
    'fee_paid',
    'underwriting',
    'bank_submitted',
    'bank_approved',
    'borrower_accepted',
    'legal_instructed',
    'completed'
  ];
}

/**
 * Utility: stage labels map (for callers that need to map ALL stages,
 * e.g., pipeline rendering).
 */
export function getAllStageLabels() {
  return { ...STAGE_LABELS };
}

// ═══════════════════════════════════════════════════════════════════
// PORTFOLIO / PROPERTY HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Properties array sorted deterministically:
 *   1. Market value DESC (most valuable security first)
 *   2. Alphabetical by address (tiebreaker)
 *
 * Every view calling this gets the same order regardless of session.
 */
export function getSortedProperties(deal) {
  const props = Array.isArray(deal && deal.properties)
    ? deal.properties.filter(p => p && (p.address || p.market_value))
    : [];
  const sorted = [...props];
  sorted.sort((a, b) => {
    const av = Number(a.market_value) || 0;
    const bv = Number(b.market_value) || 0;
    if (av !== bv) return bv - av;
    return String(a.address || '').localeCompare(String(b.address || ''));
  });
  return sorted;
}

/**
 * Sum of market_value across all properties. Falls back to legacy flat
 * `deal.current_value` if the portfolio has no values.
 */
export function getPortfolioValuation(deal) {
  const props = getSortedProperties(deal);
  const sum = props.reduce((s, p) => s + (Number(p.market_value) || 0), 0);
  if (sum > 0) return sum;
  return Number(deal && deal.current_value) || 0;
}

/**
 * Primary property address — the headline security. Deterministic ordering
 * (highest value first). For multi-property deals returns "Address (+N more)".
 *
 * Falls back to legacy flat `deal.security_address`. Never returns "N/A".
 */
export function getPrimaryPropertyAddress(deal, opts = {}) {
  const props = getSortedProperties(deal);
  const includeCount = opts.includeCount !== false;
  const maxLen = opts.maxLen || 80;
  if (props.length === 0) {
    const fallback = (deal && deal.security_address) || 'Property pending';
    return fallback.length > maxLen ? fallback.substring(0, maxLen - 3) + '...' : fallback;
  }
  const first = props[0].address || '';
  const firstTrim = first.length > maxLen ? first.substring(0, maxLen - 3) + '...' : first;
  if (props.length === 1 || !includeCount) return firstTrim;
  return `${firstTrim} (+${props.length - 1} more)`;
}

/**
 * Postcode area code (e.g. "W6") from the primary property, for compact display.
 */
export function getPrimaryPostcodeArea(deal) {
  const props = getSortedProperties(deal);
  const postcode = (props[0] && props[0].postcode) || (deal && deal.security_postcode) || '';
  return postcode ? postcode.split(' ')[0] : '';
}

// ═══════════════════════════════════════════════════════════════════
// BORROWER HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Primary borrower display name. Prefers canonical `deal.borrowers[]`
 * hierarchical data, falls back to legacy flat fields.
 *
 * For corporates, returns the company name. For individuals, the full name.
 */
export function getPrimaryBorrowerName(deal) {
  const borrowers = Array.isArray(deal && deal.borrowers) ? deal.borrowers : [];
  const primary = borrowers.find(b => b.role === 'primary' && !b.parent_borrower_id)
               || borrowers.find(b => b.role === 'primary')
               || borrowers[0];

  if (primary) {
    const isCorp = CORPORATE_TYPES.includes((primary.borrower_type || '').toLowerCase());
    if (isCorp) return primary.company_name || primary.full_name || 'Corporate borrower';
    return primary.full_name || 'Individual borrower';
  }

  // Fallback to legacy flat fields
  const bType = ((deal && deal.borrower_type) || '').toLowerCase();
  const isCorp = CORPORATE_TYPES.includes(bType);
  if (isCorp) return (deal && (deal.company_name || deal.borrower_company || deal.borrower_name)) || 'Corporate borrower';
  return (deal && deal.borrower_name) || 'Borrower pending';
}

/**
 * Is the primary borrower corporate (vs individual)? Reads canonical row first.
 */
export function isPrimaryBorrowerCorporate(deal) {
  const borrowers = Array.isArray(deal && deal.borrowers) ? deal.borrowers : [];
  const primary = borrowers.find(b => b.role === 'primary' && !b.parent_borrower_id)
               || borrowers.find(b => b.role === 'primary');
  if (primary && primary.borrower_type) {
    return CORPORATE_TYPES.includes((primary.borrower_type || '').toLowerCase());
  }
  return CORPORATE_TYPES.includes(((deal && deal.borrower_type) || '').toLowerCase());
}
