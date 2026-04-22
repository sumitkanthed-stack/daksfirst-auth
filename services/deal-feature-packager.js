/**
 * Deal Feature Packager — M1 (2026-04-22)
 *
 * Bundles every data signal auth has collected about a deal into a single
 * PII-sanitised feature blob, ready to send to BOTH the Anthropic analyst
 * (Claude Opus) and the in-house Alpha risk engine.
 *
 * Architectural split (feedback_auth_is_data_collector_not_decider.md):
 *   auth = data collector. No decisions are made here. This module reads
 *   DB state, strips PII, shapes a feature dict, returns it.
 *
 * Allowlist-driven by design:
 *   - Any column NOT in one of the allowlists below is NOT sent.
 *   - New Chimnie/CA/HMLR columns plug in by adding their column name to
 *     the relevant allowlist — no consumer changes required.
 *   - PII fields (names, addresses, DoBs, phones, emails) are NEVER added
 *     to an allowlist. See sanitisePostcode() for the one exception: we
 *     keep postcode OUTCODE (e.g. "W1J") which is public geography.
 *
 * Output shape (stable — both engines expect this):
 *   {
 *     schema_version: 1,
 *     deal_id: <auth internal int>,
 *     submission_id: <uuid>,              // public-safe deal handle
 *     stage_id: 'dip_submission' | 'dip_fee_paid' | ...,
 *     packaged_at: <iso ts>,
 *     features: {
 *       deal: { ...allowlisted deal_submissions cols },
 *       borrowers: [ { ...allowlisted deal_borrowers cols per party }, ... ],
 *       properties: [ { ...allowlisted deal_properties cols per property }, ... ]
 *     },
 *     feature_hash: <sha256 hex>          // deterministic over `features` only
 *   }
 *
 * The hash is computed over the sorted-key JSON of `features` (NOT the
 * whole envelope), so the same underlying data produces the same hash
 * across calls — used by the ledger for dedup and RM-feedback linkage.
 */

const crypto = require('crypto');
const pool = require('../db/pool');

const SCHEMA_VERSION = 1;

// ─── Allowlists ───────────────────────────────────────────────────────────────
// These are the ONLY columns that leave auth. Anything else stays behind.

// deal_submissions — numeric / categorical deal-level signals.
// Notable PII EXCLUSIONS (deliberately not listed): borrower_name, borrower_company,
// borrower_email, borrower_phone, broker_name, broker_company, broker_fca,
// security_address, security_postcode (full), company_name, company_number,
// admin_notes, additional_notes, documents.
const DEAL_ALLOWLIST = [
  'status',
  'deal_stage',
  'internal_status',
  'borrower_type',
  'asset_type',
  'loan_purpose',
  'exit_strategy',
  'interest_servicing',
  'current_value',
  'purchase_price',
  'loan_amount',
  'loan_amount_requested',
  'loan_amount_approved',
  'ltv_requested',
  'ltv_approved',
  'term_months',
  'min_loan_term',
  'rate_requested',
  'min_value_covenant',
  'day_count_basis',
  'dip_fee_confirmed',
  'commitment_fee_received',
  'fee_requested_amount',
  'dip_issued_at',
  'bank_submitted_at',
  'bank_approved_at',
  'auto_routed',
  'rm_recommendation',
  'credit_recommendation',
  'compliance_recommendation',
  'final_decision',
  'created_at',
  'updated_at',
];

// deal_borrowers — party-level signals without PII.
// EXCLUDED: full_name, date_of_birth, email, phone, address, company_name.
// KEPT: company_number (Companies House public), jurisdiction (ISO 2-letter),
// nationality (public), kyc_status. borrower_type and role drive corporate
// vs individual branching downstream.
const BORROWER_ALLOWLIST = [
  'role',
  'borrower_type',
  'nationality',
  'jurisdiction',
  'company_number',
  'kyc_status',
];

// deal_properties — property-level signals.
// ALL chimnie_* flat columns are allowlisted via the chimnie_ prefix rule
// (they are derived signals, not PII). EPC + Land Registry derived flags
// likewise. Address/postcode FULL are stripped; outcode is derived separately.
const PROPERTY_ALLOWLIST = [
  // Location (public geography)
  'region',
  'country',
  'local_authority',
  'admin_ward',
  'in_england_or_wales',
  'latitude',
  'longitude',
  // Core property facts
  'property_type',
  'tenure',
  'occupancy',
  'current_use',
  'market_value',
  'purchase_price',
  'gdv',
  'reinstatement',
  'day1_ltv',
  'valuation_date',
  'insurance_sum',
  // EPC (derived)
  'epc_rating',
  'epc_score',
  'epc_potential_rating',
  'epc_floor_area',
  'epc_property_type',
  'epc_built_form',
  'epc_construction_age',
  'epc_habitable_rooms',
  'epc_inspection_date',
  // Land Registry (derived)
  'last_sale_price',
  'last_sale_date',
  // Audit timestamps
  'property_searched_at',
  'property_verified_at',
  'chimnie_fetched_at',
];

// All chimnie_* columns are auto-allowlisted (public derived signals).
// Listed explicitly as a prefix rule applied in collectPropertyFeatures().
const PROPERTY_PREFIX_ALLOW = ['chimnie_'];

// Chimnie column names to EXPLICITLY DROP even though they pass the prefix
// rule (images are URLs that may embed address strings; listing URLs ditto).
const PROPERTY_CHIMNIE_DENYLIST = new Set([
  'chimnie_listing_image_url',
  'chimnie_floorplan_image_url',
  'chimnie_listing_image_urls',
  'chimnie_floorplan_image_urls',
  'chimnie_data',          // full JSONB — leave behind, too PII-risky
  'chimnie_fetched_by',    // internal user id
  'chimnie_uprn',          // public but we emit a sanitised hash below
  'chimnie_postcode',      // full postcode — replaced with outcode
  'chimnie_parent_uprn',   // ditto UPRN rationale
  'chimnie_nearest_station_name',       // venue string — geo-identifiable
  'chimnie_nearest_primary_name',       // school name — geo-identifiable
  'chimnie_best_secondary_name',
  'chimnie_nearest_university_name',
  'chimnie_fire_station_name',
  'chimnie_primary_heating_source',     // rarely signal, verbose
]);

// ─── PII sanitisers ───────────────────────────────────────────────────────────

/**
 * Keep OUTCODE only from a UK postcode. "W1J 5NG" -> "W1J".
 * Returns null for missing / unparseable input.
 */
function postcodeToOutcode(postcode) {
  if (!postcode || typeof postcode !== 'string') return null;
  const cleaned = postcode.trim().toUpperCase();
  // UK outcode is 2-4 chars: letter, optional letter, digit, optional digit/letter
  const m = cleaned.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)/);
  return m ? m[1] : null;
}

/**
 * One-way hash of a UPRN so the engine can tell "this is the same property
 * we've seen before" across stages without us sending the raw public ID
 * (which is linkable to a specific address via OS AddressBase). 10-char
 * hex is plenty for within-a-deal dedup and far less identifying.
 */
function hashUprn(uprn) {
  if (!uprn) return null;
  return crypto.createHash('sha256').update(String(uprn)).digest('hex').slice(0, 10);
}

/**
 * Project a row against an allowlist, dropping anything not listed.
 * Also drops null/undefined so the feature blob stays compact.
 */
function pickAllowlisted(row, allowlist) {
  const out = {};
  for (const key of allowlist) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    out[key] = v;
  }
  return out;
}

/**
 * Collect every chimnie_* column that passes the prefix rule and isn't
 * on the denylist. Keeps derived risk/valuation flags, drops URL/name
 * fields that could leak address or identity.
 */
function collectChimnieFeatures(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (!PROPERTY_PREFIX_ALLOW.some((p) => key.startsWith(p))) continue;
    if (PROPERTY_CHIMNIE_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// ─── DB loaders ──────────────────────────────────────────────────────────────

async function loadDeal(dealId) {
  const { rows } = await pool.query(
    `SELECT * FROM deal_submissions WHERE id = $1 LIMIT 1`,
    [dealId]
  );
  return rows[0] || null;
}

async function loadBorrowers(dealId) {
  const { rows } = await pool.query(
    `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, id ASC`,
    [dealId]
  );
  return rows;
}

async function loadProperties(dealId) {
  const { rows } = await pool.query(
    `SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY market_value DESC NULLS LAST, id ASC`,
    [dealId]
  );
  return rows;
}

// ─── Feature assembly ────────────────────────────────────────────────────────

function buildDealFeatures(deal) {
  const base = pickAllowlisted(deal, DEAL_ALLOWLIST);
  // Emit postcode outcode as a public-safe geography signal.
  const outcode = postcodeToOutcode(deal.security_postcode);
  if (outcode) base.security_postcode_outcode = outcode;
  return base;
}

function buildBorrowerFeatures(rows) {
  return rows.map((r) => {
    const base = pickAllowlisted(r, BORROWER_ALLOWLIST);
    // Carry a stable-within-deal anonymous id so downstream can reason
    // about "same corporate across stages" without us sending names.
    base.party_ref = `b${r.id}`;
    // Flag whether the borrower has a Companies House number without
    // sending the number itself (mitigates entity re-identification).
    base.has_company_number = !!r.company_number;
    if (r.company_number) {
      // Keep the CH number — it's public and required for the engines
      // to resolve duplicate entities across deals. Overwrites the null
      // pickAllowlisted would have otherwise set.
      base.company_number = String(r.company_number).trim().toUpperCase();
    }
    return base;
  });
}

function buildPropertyFeatures(rows) {
  return rows.map((r) => {
    const base = pickAllowlisted(r, PROPERTY_ALLOWLIST);
    const chimnie = collectChimnieFeatures(r);
    const outcode = postcodeToOutcode(r.postcode) || postcodeToOutcode(r.chimnie_postcode);
    if (outcode) base.postcode_outcode = outcode;
    const uprnHash = hashUprn(r.chimnie_uprn);
    if (uprnHash) base.uprn_hash = uprnHash;
    return {
      property_ref: `p${r.id}`,
      ...base,
      ...chimnie,
    };
  });
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Deterministic sha256 hex hash of the features object. Sorts keys
 * recursively so the same data always produces the same hash regardless
 * of insertion order. Used by the ledger for dedup.
 */
function hashFeatures(features) {
  const sortedJson = stableStringify(features);
  return crypto.createHash('sha256').update(sortedJson, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(',')}}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Package a deal at the given stage into a sanitised, hashed feature
 * envelope ready for POSTing to alpha's /api/v1/ingest/deal or for
 * sending into the Anthropic analyst prompt.
 *
 * Fails soft: if the deal doesn't exist, returns { success: false, error }.
 * Throws only on unexpected DB errors (caller should log and return 500).
 *
 * @param {number} dealId         deal_submissions.id (the INT, not the UUID)
 * @param {string} stageId        e.g. 'dip_submission', 'dip_fee_paid'
 * @returns {Promise<{
 *   success: boolean,
 *   envelope?: object,
 *   feature_hash?: string,
 *   error?: string
 * }>}
 */
async function packageDealForStage(dealId, stageId) {
  if (!dealId || !Number.isInteger(Number(dealId))) {
    return { success: false, error: 'dealId must be an integer' };
  }
  if (!stageId || typeof stageId !== 'string') {
    return { success: false, error: 'stageId is required' };
  }

  const deal = await loadDeal(dealId);
  if (!deal) {
    return { success: false, error: `deal ${dealId} not found` };
  }

  const [borrowerRows, propertyRows] = await Promise.all([
    loadBorrowers(dealId),
    loadProperties(dealId),
  ]);

  const features = {
    deal: buildDealFeatures(deal),
    borrowers: buildBorrowerFeatures(borrowerRows),
    properties: buildPropertyFeatures(propertyRows),
  };

  const feature_hash = hashFeatures(features);

  const envelope = {
    schema_version: SCHEMA_VERSION,
    deal_id: deal.id,
    submission_id: deal.submission_id,
    stage_id: stageId,
    packaged_at: new Date().toISOString(),
    features,
    feature_hash,
    counts: {
      borrowers: borrowerRows.length,
      properties: propertyRows.length,
    },
  };

  console.log(
    `[feature-packager] deal=${deal.id} stage=${stageId} ` +
      `borrowers=${borrowerRows.length} properties=${propertyRows.length} ` +
      `hash=${feature_hash.slice(0, 12)}`
  );

  return { success: true, envelope, feature_hash };
}

module.exports = {
  packageDealForStage,
  // Exposed for unit tests
  postcodeToOutcode,
  hashUprn,
  hashFeatures,
  stableStringify,
  SCHEMA_VERSION,
  ALLOWLISTS: {
    deal: DEAL_ALLOWLIST,
    borrower: BORROWER_ALLOWLIST,
    property: PROPERTY_ALLOWLIST,
    property_prefix: PROPERTY_PREFIX_ALLOW,
    property_chimnie_denylist: Array.from(PROPERTY_CHIMNIE_DENYLIST),
  },
};
