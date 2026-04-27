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
 *     taxonomy_version: 'tax_v1',
 *     taxonomy: {
 *       version, determinants:[9], sectors:[6], grade_scale:{...}
 *     },
 *     sensitivity_calculator_version,
 *     features: { deal, borrowers, properties },
 *     companies_house: [ { company_number, ... } ],
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
  sha256,
  stableStringify,
  SCHEMA_VERSION,
  VALID_STAGES,
  DEFAULT_SENSITIVITY_VERSION,
};
