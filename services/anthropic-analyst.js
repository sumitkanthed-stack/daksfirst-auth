/**
 * Anthropic Credit Analyst — M2 (2026-04-22)
 *
 * Sends a packaged deal feature envelope (from services/deal-feature-packager.js)
 * to Claude Opus 4.6 and returns a structured credit analysis. Designed to be
 * called by the 'anthropic' branch of POST /api/admin/deals/:id/send-to-analyst,
 * and to persist its response into the deal_stage_analyses ledger that M1 built.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ARCHITECTURAL POSITION
 *    auth = data collector, NOT a decider. This service produces ADVICE for
 *    humans (and later, alpha); auth never acts on its recommendation on its
 *    own. See feedback_auth_is_data_collector_not_decider.md.
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  KEY DESIGN CHOICES (locked with Sumit 2026-04-22):
 *    - Opus 4.6 default across all stages. Model override per-call supported
 *      (for the future Credit-facing election button, M3 scope).
 *    - Temperature 0 → deterministic output for a given feature_hash.
 *    - JSON-only response via system prompt + parse + schema validation.
 *    - Citation validator: every finding must cite a dotted path that
 *      resolves in envelope.features. Unresolved → row marked
 *      error='hallucinated_citation:<path>', analysis NOT shown to Credit.
 *    - Cost cap (ANTHROPIC_MAX_GBP_PER_DEAL, default £50): pre-flight block
 *      on estimated cost; soft warn at 50%; post-flight cost persisted.
 *    - Full feature blob sent including PII per
 *      feedback_credit_analysis_sends_full_data.md. DPA on production
 *      Anthropic key confirmed by Sumit 2026-04-22.
 *
 *  Pure service file — no routes, no DB writes. Route handler owns ledger I/O.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

// ─── Constants ───────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SYSTEM_PROMPT = [
  'You are a senior credit analyst at Daksfirst Limited, a UK property-backed',
  'bridging lender (FCA 937220, 8 Hill Street, Mayfair, London W1J 5NG).',
  '',
  'You analyse deals against Daksfirst lending criteria:',
  '  - Max LTV: 75% (net day 1)',
  '  - Loan sizes: £500k – £15m',
  '  - Asset types: residential, commercial, mixed use, land with planning',
  '  - Geography: England and Wales only',
  '  - Terms: 3 – 24 months',
  '  - Minimum rate: 0.85%/month',
  '  - Exclusions: development from scratch, agricultural, overseas assets',
  '',
  'You will receive a JSON feature envelope containing EVERYTHING auth knows',
  'about the deal: the deal record, borrower and guarantor tree, properties,',
  'and any enrichment data (Companies House, Chimnie, EPC, PTAL, Land',
  'Registry Price Paid, etc). You read it as a professional underwriter would.',
  '',
  'OUTPUT CONTRACT — YOU MUST FOLLOW THIS EXACTLY:',
  '  1. Reply with a SINGLE JSON OBJECT and nothing else — no prose, no markdown',
  '     fences, no preamble. Your first character MUST be "{".',
  '  2. The JSON object must conform to the schema embedded at the end of this',
  '     prompt.',
  '  3. For EVERY numeric claim, date, entity name, or factual finding, you',
  '     MUST include a `citation` array listing the dotted paths inside the',
  '     feature envelope where those facts live. Example citations:',
  '       "features.deal.loan_amount_requested"',
  '       "features.properties[0].market_value"',
  '       "features.borrowers[0].full_name"',
  '     If you cannot cite a fact from the envelope, DO NOT state it. If you',
  '     are inferring (e.g. computing LTV from loan/value), cite the inputs',
  '     you used.',
  '  4. Be direct. If the deal is weak, say so. Do not be polite about bad',
  '     deals. Follow the Daksfirst house style: quantified, no fluff.',
  '  5. Do not invent fields. Do not hallucinate lender names, valuers, or',
  '     dates. If a field is missing, add it to `missing_information`.',
  '',
  'OUTPUT JSON SCHEMA:',
  JSON.stringify({
    schema_version: 1,
    model: 'claude-opus-4-6',
    stage_id: '<stage id echoed back>',
    summary: '150-400 char executive summary',
    recommendation: "'approve' | 'decline' | 'more_info_needed'",
    recommendation_rationale: 'string',
    key_findings: [
      {
        topic: 'string',
        verdict: "'positive' | 'neutral' | 'negative'",
        finding: 'string',
        citation: ['features.<dotted.path>'],
        confidence: "'high' | 'medium' | 'low'"
      }
    ],
    risks: [
      {
        risk: 'string',
        severity: "'low' | 'medium' | 'high'",
        mitigant_suggestion: 'string | null'
      }
    ],
    missing_information: ['string'],
    ltv_checks: {
      day1_ltv_pct: 'number | null',
      stressed_ltv_pct: 'number | null',
      exceeds_policy_cap_75pct: 'boolean | null',
      computation_citation: ['features.<dotted.path>']
    },
    daksfirst_policy_hits: ['string — any criterion breach or near-miss']
  }, null, 2)
].join('\n');

// ─── Citation path resolver ──────────────────────────────────────────────────

/**
 * Resolve a dotted/indexed path like "features.properties[0].market_value"
 * against the envelope object. Returns { resolved: boolean, value: any }.
 *
 * Accepts both "features.deal.x" and "deal.x" — so Opus can be slightly sloppy
 * about the leading "features." prefix.
 */
function resolveCitation(path, envelope) {
  if (typeof path !== 'string' || !path.length) return { resolved: false };

  // Strip optional leading "features." so "features.deal.x" and "deal.x" both work.
  const stripped = path.replace(/^features\./, '');

  // Tokenise: split on '.' but treat [N] as its own step.
  // e.g. "properties[0].market_value" → ["properties", 0, "market_value"]
  const tokens = [];
  const re = /[^.[\]]+|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (m[1] !== undefined) tokens.push(Number(m[1]));
    else tokens.push(m[0]);
  }
  if (!tokens.length) return { resolved: false };

  let cur = envelope.features;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return { resolved: false };
    cur = cur[tok];
  }
  // Resolved if we reached a non-undefined leaf. Null counts as resolved
  // (field is known, explicitly null). We only flag undefined = hallucination.
  if (cur === undefined) return { resolved: false };
  return { resolved: true, value: cur };
}

/**
 * Walk the Opus response and pull every citation path out of findings,
 * ltv_checks, etc. Returns a flat array of { location, path }.
 */
function extractCitations(response) {
  const out = [];
  const pushAll = (loc, arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((p, i) => out.push({ location: `${loc}[${i}]`, path: p }));
  };
  if (Array.isArray(response?.key_findings)) {
    response.key_findings.forEach((f, idx) =>
      pushAll(`key_findings[${idx}].citation`, f?.citation || [])
    );
  }
  if (response?.ltv_checks?.computation_citation) {
    pushAll('ltv_checks.computation_citation', response.ltv_checks.computation_citation);
  }
  return out;
}

/**
 * Validate every citation resolves in the envelope. Returns:
 *   { ok: true }                                if all resolve
 *   { ok: false, firstFailure: { location, path } } on first miss
 */
function validateCitations(response, envelope) {
  const citations = extractCitations(response);
  for (const c of citations) {
    const r = resolveCitation(c.path, envelope);
    if (!r.resolved) {
      return { ok: false, firstFailure: c, checked: citations.length };
    }
  }
  return { ok: true, checked: citations.length };
}

// ─── Cost estimation ─────────────────────────────────────────────────────────

/**
 * Rough pre-flight token estimate. Conservative (over-estimates).
 *   - ~4 chars per token for English+JSON text (industry rule of thumb)
 *   - doubles the system prompt + JSON schema allocation (Opus reads them fully)
 *   - assumes 2000 tokens of output ceiling for a verbose credit memo
 */
function estimateCostGbp(envelope) {
  const featureJsonLen = JSON.stringify(envelope.features).length;
  const systemLen = SYSTEM_PROMPT.length;
  const estInputTokens = Math.ceil((featureJsonLen + systemLen + 500) / 4);
  const estOutputTokens = 2000;
  const inputRate = config.ANTHROPIC_INPUT_GBP_PER_MTOK || 0;
  const outputRate = config.ANTHROPIC_OUTPUT_GBP_PER_MTOK || 0;
  return {
    estInputTokens,
    estOutputTokens,
    estCostGbp: (estInputTokens * inputRate + estOutputTokens * outputRate) / 1_000_000
  };
}

/**
 * Post-flight actual cost from the API's usage block.
 */
function actualCostGbp(usage) {
  if (!usage) return null;
  const inputRate = config.ANTHROPIC_INPUT_GBP_PER_MTOK || 0;
  const outputRate = config.ANTHROPIC_OUTPUT_GBP_PER_MTOK || 0;
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  if (inputRate === 0 && outputRate === 0) return null; // not configured
  return Number(
    ((inputTok * inputRate + outputTok * outputRate) / 1_000_000).toFixed(4)
  );
}

// ─── Main service ────────────────────────────────────────────────────────────

/**
 * Analyse a packaged deal-stage envelope with Claude Opus.
 *
 * @param {object} envelope   Output of packageDealForStage() — must contain
 *                            `features`, `stage_id`, `feature_hash`, etc.
 * @param {object} [opts]
 * @param {string} [opts.model]    Override ANTHROPIC_ANALYST_MODEL default.
 * @param {string} [opts.userId]   For log correlation only.
 * @returns {Promise<{
 *   response: object|null,       // parsed Opus JSON, or null on error
 *   model_version: string,       // model string actually called
 *   cost_gbp: number|null,       // post-flight cost, null if pricing unset
 *   latency_ms: number,          // wall-clock round-trip
 *   prompt_tokens: number|null,
 *   completion_tokens: number|null,
 *   error: string|null           // non-null iff the row should be marked bad
 * }>}
 */
async function analyseDealStage(envelope, opts = {}) {
  const startedAt = Date.now();
  const result = {
    response: null,
    model_version: opts.model || config.ANTHROPIC_ANALYST_MODEL,
    cost_gbp: null,
    latency_ms: 0,
    prompt_tokens: null,
    completion_tokens: null,
    error: null
  };

  if (!envelope || !envelope.features) {
    result.error = 'envelope_missing_features';
    result.latency_ms = Date.now() - startedAt;
    return result;
  }
  const stageId = envelope.stage_id || opts.stageId;
  if (!stageId) {
    result.error = 'envelope_missing_stage_id';
    result.latency_ms = Date.now() - startedAt;
    return result;
  }
  if (!config.ANTHROPIC_API_KEY) {
    result.error = 'anthropic_api_key_not_configured';
    result.latency_ms = Date.now() - startedAt;
    return result;
  }

  // ─── Pre-flight cost gate ──────────────────────────────────────────────
  const cap = config.ANTHROPIC_MAX_GBP_PER_DEAL;
  const est = estimateCostGbp(envelope);
  if (est.estCostGbp > cap) {
    result.error = `precheck_cost_exceeds_cap:est_${est.estCostGbp.toFixed(2)}_cap_${cap}`;
    result.latency_ms = Date.now() - startedAt;
    console.warn(
      `[anthropic-analyst] BLOCKED: estimated cost £${est.estCostGbp.toFixed(2)} ` +
        `> hard cap £${cap} (deal=${envelope.deal_id} stage=${stageId})`
    );
    return result;
  }
  if (est.estCostGbp > cap * 0.5) {
    console.warn(
      `[anthropic-analyst] SOFT WARN: est cost £${est.estCostGbp.toFixed(2)} ` +
        `> 50% of cap £${cap} (deal=${envelope.deal_id} stage=${stageId})`
    );
  }

  // ─── API call ──────────────────────────────────────────────────────────
  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    timeout: config.ANTHROPIC_ANALYST_TIMEOUT_MS
  });

  const userMessage = [
    `Stage: ${stageId}`,
    `Deal ID (auth): ${envelope.deal_id}`,
    `Submission ID: ${envelope.submission_id || '(none)'}`,
    `Feature hash: ${envelope.feature_hash || '(none)'}`,
    '',
    'Feature envelope (full JSON follows):',
    JSON.stringify({ features: envelope.features }, null, 2)
  ].join('\n');

  let apiResponse;
  try {
    apiResponse = await client.messages.create({
      model: result.model_version,
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });
  } catch (err) {
    result.error = `anthropic_api_error:${err.message || err}`;
    result.latency_ms = Date.now() - startedAt;
    console.error('[anthropic-analyst] API call failed:', err.message || err);
    return result;
  }

  result.latency_ms = Date.now() - startedAt;
  result.prompt_tokens = apiResponse?.usage?.input_tokens ?? null;
  result.completion_tokens = apiResponse?.usage?.output_tokens ?? null;
  result.cost_gbp = actualCostGbp(apiResponse?.usage);

  // ─── Parse JSON from the model response ────────────────────────────────
  const rawText = (apiResponse?.content?.[0]?.text || '').trim();
  if (!rawText) {
    result.error = 'empty_model_output';
    return result;
  }
  // Opus should produce pure JSON. If it wrapped it in ```json fences, strip.
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    result.error = `response_not_json:${err.message}`;
    // Preserve the raw text for debugging (first 500 chars)
    result.response = { __raw_text: cleaned.slice(0, 500) };
    console.error(
      '[anthropic-analyst] JSON parse failed for deal=' + envelope.deal_id +
        ' stage=' + stageId + '. First 200 chars: ' + cleaned.slice(0, 200)
    );
    return result;
  }

  // ─── Citation validation ───────────────────────────────────────────────
  const cite = validateCitations(parsed, envelope);
  if (!cite.ok) {
    result.error = `hallucinated_citation:${cite.firstFailure.path}`;
    result.response = parsed; // keep response for review, but row is flagged
    console.warn(
      `[anthropic-analyst] citation failed: deal=${envelope.deal_id} ` +
        `path="${cite.firstFailure.path}" at ${cite.firstFailure.location}`
    );
    return result;
  }

  // ─── Success ───────────────────────────────────────────────────────────
  result.response = parsed;
  console.log(
    `[anthropic-analyst] deal=${envelope.deal_id} stage=${stageId} ` +
      `model=${result.model_version} tok=${result.prompt_tokens}/${result.completion_tokens} ` +
      `cost=£${result.cost_gbp ?? '?'} latency=${result.latency_ms}ms ` +
      `citations_ok=${cite.checked}`
  );
  return result;
}

module.exports = {
  analyseDealStage,
  // Exported for unit tests
  resolveCitation,
  validateCitations,
  extractCitations,
  estimateCostGbp,
  actualCostGbp,
  SCHEMA_VERSION,
  SYSTEM_PROMPT
};
