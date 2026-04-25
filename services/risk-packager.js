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
 *     schema_version: 1,
 *     deal_id, submission_id, data_stage, packaged_at,
 *     rubric:  { prompt_key, version, prompt_id },
 *     macro:   { prompt_key, version, prompt_id },
 *     sensitivity_calculator_version,
 *     features: { deal, borrowers, properties },     // from M1 packager
 *     companies_house: [ { company_number, ... } ],  // verification snapshots
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

const SCHEMA_VERSION = 1;
const DEFAULT_SENSITIVITY_VERSION = 'v5.1';
const VALID_STAGES = ['dip', 'underwriting', 'post_completion'];

// ─── Active prompt resolution ────────────────────────────────────────────────

/**
 * Look up the currently-active row for a prompt_key. Throws if none active —
 * a missing rubric/macro is a hard fail, not a soft warning, because every
 * risk_view row must FK-pin to a real prompt id for audit reproducibility.
 */
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

// ─── Companies House enrichment ──────────────────────────────────────────────

/**
 * For each unique company_number that appears on any borrower row, pull the
 * latest verification snapshot from company_verifications. Returns [] if
 * none of the borrowers are corporate. Soft-fails per company (logs and
 * continues) — a missing CH lookup should NOT block a risk run.
 */
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

// ─── Data-stage resolution ───────────────────────────────────────────────────

/**
 * Validate / normalise data_stage. The caller is RM clicking "Run Risk
 * Analysis" on the deal page — they pick the stage explicitly. We do NOT
 * derive it from deal.deal_stage because (a) the same deal can be re-graded
 * at multiple stages and (b) RM may want to grade an underwriting-stage
 * deal as if it were DIP-stage (sanity check). Stage is part of the audit
 * pin, not a derived hint.
 */
function resolveDataStage(input) {
  const v = (input || '').toString().trim().toLowerCase();
  if (!VALID_STAGES.includes(v)) {
    throw new Error(
      `risk-packager: data_stage must be one of ${VALID_STAGES.join('|')}, got '${input}'`
    );
  }
  return v;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the risk-grading input payload for a deal at the given data stage.
 *
 * @param {number} dealId   deal_submissions.id (the INT)
 * @param {string} dataStage  'dip' | 'underwriting' | 'post_completion'
 * @param {object} [options]
 * @param {string} [options.sensitivityCalculatorVersion]  pinned to risk_view row
 * @returns {Promise<{
 *   success: boolean,
 *   payload?: object,
 *   feature_hash?: string,
 *   risk_payload_hash?: string,
 *   error?: string
 * }>}
 */
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

  // 1. Reuse M1 packager for the deal/borrowers/properties matrix envelope.
  //    'risk_run' is the stage_id used in M1's ledger — distinct from data_stage.
  const m1 = await featurePackager.packageDealForStage(dealId, 'risk_run');
  if (!m1.success) {
    return { success: false, error: `feature packager failed: ${m1.error}` };
  }

  // 2. Pin the active rubric + macro versions atomically. Both must exist.
  let rubric, macro;
  try {
    [rubric, macro] = await Promise.all([
      loadActivePrompt('risk_rubric'),
      loadActivePrompt('risk_macro'),
    ]);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // 3. Companies House enrichment (soft-fail per company is fine).
  const companiesHouse = await loadCompaniesHouseSnapshots(m1.envelope.features.borrowers);

  // 4. Provenance summary — what made it into the envelope.
  const propsWithChimnie = m1.envelope.features.properties.filter((p) => p.chimnie_uprn);
  const propsWithPtal    = m1.envelope.features.properties.filter((p) => p.chimnie_ptal);
  const propsWithArea    = m1.envelope.features.properties.filter((p) => p.chimnie_local_authority);

  const provenance = {
    deal_columns_count:     Object.keys(m1.envelope.features.deal).length,
    borrowers_count:        m1.envelope.features.borrowers.length,
    properties_count:       m1.envelope.features.properties.length,
    chimnie_attached_count: propsWithChimnie.length,
    ptal_attached_count:    propsWithPtal.length,
    area_intel_attached_count: propsWithArea.length,
    companies_house_count:  companiesHouse.length,
    matrix_data_jsonb_present:
      !!m1.envelope.features.deal.matrix_data &&
      Object.keys(m1.envelope.features.deal.matrix_data || {}).length > 0,
  };

  // 5. Assemble the final envelope.
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
    sensitivity_calculator_version: sensitivityVersion,
    features:         m1.envelope.features,
    companies_house:  companiesHouse,
    source_provenance: provenance,
    feature_hash:     m1.feature_hash,
  };

  // risk_payload_hash covers everything EXCEPT packaged_at (timestamps drift).
  // Used for re-run dedup when RM clicks the button twice on identical data.
  const { packaged_at, ...hashable } = payload;
  payload.risk_payload_hash = sha256(hashable);

  console.log(
    `[risk-packager] deal=${payload.deal_id} stage=${stage} ` +
    `rubric=${rubric.prompt_key}.v${rubric.version}#${rubric.prompt_id} ` +
    `macro=${macro.prompt_key}.v${macro.version}#${macro.prompt_id} ` +
    `borrowers=${provenance.borrowers_count} ` +
    `properties=${provenance.properties_count} ` +
    `chimnie=${provenance.chimnie_attached_count} ` +
    `ch=${provenance.companies_house_count} ` +
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
  // exposed for tests
  resolveDataStage,
  loadActivePrompt,
  loadCompaniesHouseSnapshots,
  sha256,
  stableStringify,
  SCHEMA_VERSION,
  VALID_STAGES,
  DEFAULT_SENSITIVITY_VERSION,
};
