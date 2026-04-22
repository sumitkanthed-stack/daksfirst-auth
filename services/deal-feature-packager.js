/**
 * Deal Feature Packager — M1 (2026-04-22)
 *
 * Bundles every data signal auth has collected about a deal into a single
 * feature envelope, ready to send to BOTH the Anthropic analyst (Claude
 * Opus) and the in-house Alpha risk engine.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  POLICY (set by Sumit, 2026-04-22):
 *    SEND EVERYTHING. No PII stripping. Credit underwriting needs the full
 *    picture — names, addresses, DoBs, phones, emails, UPRNs, Companies
 *    House numbers. Alpha is EEA-resident (Frankfurt) and Anthropic is
 *    under enterprise DPA; both are valid processors for legitimate-
 *    interest credit decisioning. Removing PII would cripple KYC/AML,
 *    entity resolution, fraud detection, and bureau matching.
 *  See: feedback_credit_analysis_sends_full_data.md
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Architectural split (still holds): auth = data collector. No decisions
 * happen here. This module reads DB state, shapes an envelope, returns it.
 *
 * Output shape (stable — both engines expect this):
 *   {
 *     schema_version: 1,
 *     deal_id:       <auth internal int>,
 *     submission_id: <uuid>,
 *     stage_id:      'dip_submission' | 'dip_fee_paid' | ...,
 *     packaged_at:   <iso ts>,
 *     features: {
 *       deal:       { ...every column from deal_submissions },
 *       borrowers:  [ { ...every column from deal_borrowers }, ... ],
 *       properties: [ { ...every column from deal_properties }, ... ]
 *     },
 *     feature_hash: <sha256 hex>   // deterministic over `features` only
 *   }
 *
 * The hash is computed over the sorted-key JSON of `features` (NOT the
 * whole envelope), so the same underlying data always produces the same
 * hash across calls — used by the ledger for dedup and RM-feedback linkage.
 *
 * What is deliberately NOT included (noise / scale, not privacy):
 *   - deal_documents.file_content (BYTEA blobs — too large, doc parsing
 *     is a separate path via services/claude-parser.js)
 *   - users.* (the submitter) — auth metadata, not deal signal
 * If either needs to flow to alpha later, add a loader here.
 */

const crypto = require('crypto');
const pool = require('../db/pool');

const SCHEMA_VERSION = 1;

// ─── DB loaders (SELECT * — send everything) ─────────────────────────────────

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

// ─── Compactor ───────────────────────────────────────────────────────────────

/**
 * Drop null/undefined keys so the feature blob doesn't drag empty slots
 * across the wire. Everything else — including PII — passes through.
 */
function compact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Deterministic sha256 hex hash of the features object. Sorts keys
 * recursively so the same data always produces the same hash regardless
 * of insertion order. Used by the ledger for dedup across re-dispatches.
 */
function hashFeatures(features) {
  const sortedJson = stableStringify(features);
  return crypto.createHash('sha256').update(sortedJson, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(',')}}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Package a deal at the given stage into a hashed feature envelope ready
 * for POSTing to alpha's /api/v1/ingest/deal or for sending into the
 * Anthropic analyst prompt.
 *
 * Fails soft: if the deal doesn't exist, returns { success: false, error }.
 * Throws only on unexpected DB errors (caller should log and return 500).
 *
 * @param {number} dealId   deal_submissions.id (the INT, not the UUID)
 * @param {string} stageId  e.g. 'dip_submission', 'dip_fee_paid'
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
    deal: compact(deal),
    borrowers: borrowerRows.map(compact),
    properties: propertyRows.map(compact),
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
      deal_cols: Object.keys(features.deal).length,
    },
  };

  console.log(
    `[feature-packager] deal=${deal.id} stage=${stageId} ` +
      `borrowers=${borrowerRows.length} properties=${propertyRows.length} ` +
      `deal_cols=${Object.keys(features.deal).length} ` +
      `hash=${feature_hash.slice(0, 12)}`
  );

  return { success: true, envelope, feature_hash };
}

module.exports = {
  packageDealForStage,
  // Exposed for unit tests
  hashFeatures,
  stableStringify,
  compact,
  SCHEMA_VERSION,
};
