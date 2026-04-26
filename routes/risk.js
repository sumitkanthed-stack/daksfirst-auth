/**
 * Risk Analysis Routes — V5 Risk MVP step 7+8 (2026-04-26)
 *
 * Two routes:
 *
 *  1. POST /api/admin/risk-runs/start
 *     ──────────────────────────────────────────────────────────────
 *     Admin/RM/credit/compliance trigger. Creates a 'pending' risk_view
 *     row, builds the risk payload (proves it serializes), and fires the
 *     n8n Risk Analysis Standalone webhook.
 *
 *     Body: { dealId: int, dataStage: 'dip'|'underwriting'|'post_completion' }
 *     Returns: { ok, risk_run_id, status:'pending', dispatched:true|false }
 *
 *  2. POST /api/risk-callback
 *     ──────────────────────────────────────────────────────────────
 *     Webhook from n8n. Validates X-Webhook-Secret. Settles the
 *     risk_view row with grades + token costs + status. Append-only
 *     except for status / cost telemetry transitions.
 *
 *     Body: {
 *       risk_run_id: int,
 *       success: bool,
 *       raw_response: string,
 *       parsed_grades: object,
 *       input_tokens: int,
 *       output_tokens: int,
 *       latency_ms: int,
 *       error_message?: string
 *     }
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ARCHITECTURE: auth = data collector + dispatcher. n8n owns the LLM call.
 *  See feedback_auth_is_data_collector_not_decider.md
 *
 *  COST CONTROL:
 *   - llm_model_config row 'risk_grade' pins model/max_tokens/temperature
 *   - Future: payload-hash dedup (skipped here; backlog #59 area)
 *  See project_risk_packager_drafted_2026_04_25.md
 * ───────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const riskPackager = require('../services/risk-packager');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Internal-staff gate (admin / rm / credit / compliance can trigger risk runs).
 * Same shape as authenticateInternal but inlined to keep this router self-contained.
 */
function authenticateInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!config.INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Internal staff access required' });
  }
  next();
}

function verifyWebhookSecret(req, res, next) {
  const provided = req.headers['x-webhook-secret'];
  if (!provided || provided !== config.WEBHOOK_SECRET) {
    console.warn('[risk-callback] Rejected — invalid or missing X-Webhook-Secret. IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Fetch a prompt body by id. We only ship bodies in the trigger payload —
 * keeping rubric/macro body lookups on the auth side (rather than n8n calling
 * back) means n8n needs zero credentials to talk to auth, the trigger snapshot
 * is reproducible, and admin edits to llm_prompts take effect on the next run.
 *
 * Throws if id missing — every risk run must FK-pin to an existing prompt row.
 */
async function loadPromptBodyById(promptId) {
  const { rows } = await pool.query(
    `SELECT id, prompt_key, version, body
       FROM llm_prompts
      WHERE id = $1
      LIMIT 1`,
    [promptId]
  );
  if (rows.length === 0) {
    throw new Error(`loadPromptBodyById: prompt id ${promptId} not found in llm_prompts`);
  }
  return rows[0];
}

/**
 * GBP cost from token counts using llm_model_config cost_per_1m_*_usd columns.
 * Falls back to NULL if costs aren't set on the row (admin can backfill via UI).
 * USD→GBP conversion deliberately omitted: cost_per_1m_*_usd is the canonical
 * unit on the row, and any FX uplift is handled at finance-roll-up time, not
 * per-row. We stamp the USD-derived figure into cost_gbp AS USD for now —
 * marker that this needs a later FX pass. See backlog.
 */
function computeCostGbp(modelCfg, inputTokens, outputTokens) {
  const cIn = Number(modelCfg?.cost_per_1m_input_usd);
  const cOut = Number(modelCfg?.cost_per_1m_output_usd);
  if (!cIn || !cOut || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return null;
  }
  const usd = (inputTokens / 1_000_000) * cIn + (outputTokens / 1_000_000) * cOut;
  return Number(usd.toFixed(4));
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/risk-runs/start  — admin triggers a fresh risk run
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/risk-runs/start',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const { dealId, dataStage } = req.body || {};

    if (!Number.isInteger(Number(dealId)) || Number(dealId) <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId must be a positive integer' });
    }
    const VALID_STAGES = ['dip', 'underwriting', 'post_completion'];
    if (!VALID_STAGES.includes(dataStage)) {
      return res.status(400).json({
        ok: false,
        error: `dataStage must be one of ${VALID_STAGES.join('|')}`,
      });
    }

    let payloadResult;
    try {
      payloadResult = await riskPackager.buildRiskPayload(Number(dealId), dataStage);
    } catch (err) {
      console.error(`[risk-runs/start ${dealId}/${dataStage}] packager threw:`, err);
      return res.status(500).json({ ok: false, error: `packager error: ${err.message}` });
    }
    if (!payloadResult.success) {
      return res.status(400).json({ ok: false, error: payloadResult.error });
    }
    const payload = payloadResult.payload;

    // Pin the model config row so the canvas reads consistent values for this run.
    let modelCfg;
    try {
      const cfg = await pool.query(
        `SELECT call_type, model, max_tokens, temperature, budget_gbp,
                provider, extra_params, cost_per_1m_input_usd, cost_per_1m_output_usd, enabled
           FROM llm_model_config
          WHERE call_type = 'risk_grade'
          LIMIT 1`
      );
      if (cfg.rows.length === 0) {
        return res.status(500).json({
          ok: false,
          error: "llm_model_config row 'risk_grade' missing — seed via migration first",
        });
      }
      modelCfg = cfg.rows[0];
      if (modelCfg.enabled === false) {
        return res.status(409).json({
          ok: false,
          error: "risk_grade is disabled in llm_model_config — flip enabled=TRUE to dispatch",
        });
      }
    } catch (err) {
      console.error('[risk-runs/start] llm_model_config read failed:', err);
      return res.status(500).json({ ok: false, error: 'config read failed' });
    }

    // Insert pending risk_view row, FK-pinned to rubric + macro prompt_ids.
    let riskRunId;
    try {
      const ins = await pool.query(
        `INSERT INTO risk_view (
            deal_id, data_stage,
            rubric_prompt_id, macro_prompt_id,
            sensitivity_calculator_version,
            model, model_temperature, model_max_tokens,
            input_payload,
            status, triggered_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
         RETURNING id`,
        [
          payload.deal_id,
          payload.data_stage,
          payload.rubric.prompt_id,
          payload.macro.prompt_id,
          payload.sensitivity_calculator_version,
          modelCfg.model,
          modelCfg.temperature,
          modelCfg.max_tokens,
          JSON.stringify(payload),
          'pending',
          `${req.user.role}:${req.user.userId}`,
        ]
      );
      riskRunId = ins.rows[0].id;
    } catch (err) {
      console.error('[risk-runs/start] risk_view INSERT failed:', err);
      return res.status(500).json({ ok: false, error: 'risk_view insert failed' });
    }

    // Fire n8n webhook. We do NOT block on n8n's response — risk_view will be
    // settled by the callback. If dispatch fails, we mark the row failed
    // synchronously so the UI sees a fast error rather than a stuck pending.
    const N8N_RISK_URL = config.N8N_RISK_WEBHOOK_URL || process.env.N8N_RISK_WEBHOOK_URL || '';
    if (!N8N_RISK_URL) {
      await pool.query(
        `UPDATE risk_view SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
        ['N8N_RISK_WEBHOOK_URL not configured', riskRunId]
      ).catch(() => {});
      return res.status(500).json({
        ok: false,
        risk_run_id: riskRunId,
        error: 'N8N_RISK_WEBHOOK_URL env var not set on auth — cannot dispatch',
      });
    }

    // Pre-fetch rubric + macro bodies. We ship them in the trigger body so n8n
    // doesn't need an admin Bearer token to fetch from auth — the canvas becomes
    // a stateless prompt-builder + Anthropic-caller. See:
    // feedback_auth_is_data_collector_not_decider.md (auth assembles, n8n calls).
    let rubricRow, macroRow;
    try {
      [rubricRow, macroRow] = await Promise.all([
        loadPromptBodyById(payload.rubric.prompt_id),
        loadPromptBodyById(payload.macro.prompt_id),
      ]);
    } catch (err) {
      await pool.query(
        `UPDATE risk_view SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [`prompt body fetch failed: ${err.message}`, riskRunId]
      ).catch(() => {});
      return res.status(500).json({
        ok: false,
        risk_run_id: riskRunId,
        error: `prompt body fetch failed: ${err.message}`,
      });
    }

    const triggerBody = {
      risk_run_id: riskRunId,
      deal_id: payload.deal_id,
      submission_id: payload.submission_id,
      data_stage: payload.data_stage,
      callback_url: `${(config.PUBLIC_AUTH_URL || '').replace(/\/$/, '') || 'https://daksfirst-auth.onrender.com'}/api/risk-callback`,
      model_config_call_type: 'risk_grade',

      // ── Pre-fetched prompt bodies + model config + full deal payload ──
      // n8n needs no auth to fetch these — it just reads the body and builds
      // the Anthropic call. Total payload ~340kB for deal 32 (well under
      // n8n cloud's 16MB ceiling).
      rubric_body: rubricRow.body,
      macro_body:  macroRow.body,
      // pg deserializes NUMERIC columns as strings (max_tokens is INTEGER so
      // it's already a Number). Coerce here so n8n can ship straight to the
      // Anthropic API — Anthropic 400s on "temperature":"0.00" (string).
      model_config: {
        model:       modelCfg.model,
        max_tokens:  Number(modelCfg.max_tokens),
        temperature: Number(modelCfg.temperature),
        provider:    modelCfg.provider,
      },
      deal_payload: payload,
    };

    try {
      const resp = await fetch(N8N_RISK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': config.WEBHOOK_SECRET,
        },
        body: JSON.stringify(triggerBody),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        await pool.query(
          `UPDATE risk_view SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
          [`n8n dispatch ${resp.status}: ${txt.slice(0, 240)}`, riskRunId]
        ).catch(() => {});
        return res.status(502).json({
          ok: false,
          risk_run_id: riskRunId,
          error: `n8n returned ${resp.status}`,
        });
      }
    } catch (err) {
      await pool.query(
        `UPDATE risk_view SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
        [`n8n dispatch threw: ${err.message}`, riskRunId]
      ).catch(() => {});
      return res.status(502).json({
        ok: false,
        risk_run_id: riskRunId,
        error: `n8n dispatch threw: ${err.message}`,
      });
    }

    // Move row to 'running' so the UI can distinguish "queued" from "dispatched".
    await pool.query(
      `UPDATE risk_view SET status='running' WHERE id=$1 AND status='pending'`,
      [riskRunId]
    ).catch(() => {});

    console.log(
      `[risk-runs/start] dispatched risk_run_id=${riskRunId} deal=${payload.deal_id} ` +
      `stage=${payload.data_stage} model=${modelCfg.model}`
    );

    return res.json({
      ok: true,
      risk_run_id: riskRunId,
      deal_id: payload.deal_id,
      data_stage: payload.data_stage,
      status: 'running',
      dispatched: true,
      model: modelCfg.model,
      rubric: payload.rubric,
      macro: payload.macro,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/risk-view/:dealId/runs — list every risk run for a deal
//  GET /api/admin/risk-view/:dealId/runs/:runId — full row incl raw_response
//  ───────────────────────────────────────────────────────────────────────────
//  Read-only, append-only. Used by the Risk View section on /deal/:id.
//  Returns runs newest-first. Verdict is regex-extracted from raw_response so
//  the rail can render coloured pills without parsing the full markdown.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pull a verdict label out of the markdown rubric output.
 * v3 narrative emits a "## Layer 3 — Composite Verdict" block followed by
 * "### **HIGH**" (or LOW/MODERATE/ELEVATED). We try the explicit Layer 3
 * marker first, then fall back to the first bold-only verdict word anywhere.
 * Returns null if nothing matches — UI shows a grey "—" pill in that case.
 */
function extractVerdict(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'string') return null;
  const VERDICT_WORDS = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'CRITICAL'];

  // Preferred: header block under Layer 3 (`### **HIGH**` style).
  const layer3 = rawResponse.match(/Layer\s*3[\s\S]{0,400}?\*\*\s*(LOW|MODERATE|ELEVATED|HIGH|CRITICAL)\s*\*\*/i);
  if (layer3) return layer3[1].toUpperCase();

  // Fallback: first standalone `**WORD**` matching the verdict vocabulary.
  const bold = rawResponse.match(/\*\*\s*(LOW|MODERATE|ELEVATED|HIGH|CRITICAL)\s*\*\*/i);
  if (bold) return bold[1].toUpperCase();

  // Last resort: bare word on its own line.
  for (const w of VERDICT_WORDS) {
    const re = new RegExp(`(^|\\n)\\s*${w}\\s*(\\n|$)`, 'i');
    if (re.test(rawResponse)) return w;
  }
  return null;
}

router.get(
  '/admin/risk-view/:dealId/runs',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId must be a positive integer' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT
            rv.id,
            rv.deal_id,
            rv.data_stage,
            rv.status,
            rv.model,
            rv.model_temperature,
            rv.model_max_tokens,
            rv.input_tokens,
            rv.output_tokens,
            rv.cost_gbp,
            rv.latency_ms,
            rv.error_message,
            rv.triggered_by,
            rv.triggered_at AS created_at,
            rv.completed_at,
            rv.rubric_prompt_id,
            rv.macro_prompt_id,
            rv.sensitivity_calculator_version,
            rp.prompt_key   AS rubric_key,
            rp.version      AS rubric_version,
            rp.is_active    AS rubric_is_active,
            mp.prompt_key   AS macro_key,
            mp.version      AS macro_version,
            mp.is_active    AS macro_is_active,
            char_length(rv.raw_response)             AS raw_response_chars,
            (rv.parsed_grades IS NOT NULL)           AS has_parsed_grades,
            -- Pull just enough of raw_response to extract verdict server-side.
            substring(rv.raw_response from 1 for 16000) AS raw_response_head
          FROM risk_view rv
     LEFT JOIN llm_prompts rp ON rp.id = rv.rubric_prompt_id
     LEFT JOIN llm_prompts mp ON mp.id = rv.macro_prompt_id
         WHERE rv.deal_id = $1
      ORDER BY rv.id DESC`,
        [dealId]
      );

      const runs = rows.map(r => {
        const verdict = r.status === 'success' ? extractVerdict(r.raw_response_head) : null;
        const { raw_response_head, ...rest } = r;
        return {
          ...rest,
          verdict,
          // Stale-rubric flag: row was run against a non-active prompt version.
          rubric_stale: r.rubric_is_active === false,
          macro_stale:  r.macro_is_active  === false,
        };
      });

      return res.json({ ok: true, deal_id: dealId, runs });
    } catch (err) {
      console.error(`[risk-view runs ${dealId}] query failed:`, err);
      return res.status(500).json({ ok: false, error: 'query failed' });
    }
  }
);

router.get(
  '/admin/risk-view/:dealId/runs/:runId',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const dealId = Number(req.params.dealId);
    const runId  = Number(req.params.runId);
    if (!Number.isInteger(dealId) || dealId <= 0 || !Number.isInteger(runId) || runId <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId and runId must be positive integers' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT
            rv.*,
            rp.prompt_key  AS rubric_key,
            rp.version     AS rubric_version,
            rp.is_active   AS rubric_is_active,
            mp.prompt_key  AS macro_key,
            mp.version     AS macro_version,
            mp.is_active   AS macro_is_active
          FROM risk_view rv
     LEFT JOIN llm_prompts rp ON rp.id = rv.rubric_prompt_id
     LEFT JOIN llm_prompts mp ON mp.id = rv.macro_prompt_id
         WHERE rv.id = $1 AND rv.deal_id = $2
         LIMIT 1`,
        [runId, dealId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: `risk_run_id ${runId} not found for deal ${dealId}` });
      }
      const row = rows[0];
      const verdict = row.status === 'success' ? extractVerdict(row.raw_response) : null;
      return res.json({
        ok: true,
        run: {
          ...row,
          verdict,
          rubric_stale: row.rubric_is_active === false,
          macro_stale:  row.macro_is_active  === false,
        },
      });
    } catch (err) {
      console.error(`[risk-view run ${runId}] query failed:`, err);
      return res.status(500).json({ ok: false, error: 'query failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/risk-callback  — n8n returns grades + telemetry
// ═══════════════════════════════════════════════════════════════════════════
router.post('/risk-callback', verifyWebhookSecret, async (req, res) => {
  const {
    risk_run_id,
    success,
    raw_response,
    parsed_grades,
    input_tokens,
    output_tokens,
    latency_ms,
    error_message,
  } = req.body || {};

  if (!Number.isInteger(Number(risk_run_id))) {
    return res.status(400).json({ ok: false, error: 'risk_run_id must be an integer' });
  }

  // Look up the row and the matching model config for cost computation.
  let row;
  try {
    const r = await pool.query(
      `SELECT rv.id, rv.deal_id, rv.data_stage, rv.status, rv.model
         FROM risk_view rv
        WHERE rv.id = $1
        LIMIT 1`,
      [Number(risk_run_id)]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `risk_run_id ${risk_run_id} not found` });
    }
    row = r.rows[0];
  } catch (err) {
    console.error('[risk-callback] lookup failed:', err);
    return res.status(500).json({ ok: false, error: 'lookup failed' });
  }

  // Idempotency: callback fired twice (n8n retry) — accept first settle, ignore rest.
  if (row.status === 'success' || row.status === 'failed') {
    console.log(`[risk-callback] risk_run_id=${risk_run_id} already settled (${row.status}) — ignoring`);
    return res.json({ ok: true, idempotent: true, status: row.status });
  }

  // Pull cost rates for the model that was pinned at trigger time.
  let modelCfg = null;
  try {
    const cfg = await pool.query(
      `SELECT cost_per_1m_input_usd, cost_per_1m_output_usd
         FROM llm_model_config
        WHERE model = $1
        LIMIT 1`,
      [row.model]
    );
    modelCfg = cfg.rows[0] || null;
  } catch (_err) {
    // Cost computation is best-effort — null if rates aren't set.
  }

  const cost_gbp =
    success === true
      ? computeCostGbp(modelCfg, Number(input_tokens) || 0, Number(output_tokens) || 0)
      : null;

  const newStatus = success === true ? 'success' : 'failed';

  try {
    await pool.query(
      `UPDATE risk_view SET
          raw_response   = $1,
          parsed_grades  = $2::jsonb,
          input_tokens   = $3,
          output_tokens  = $4,
          cost_gbp       = $5,
          latency_ms     = $6,
          status         = $7,
          error_message  = $8,
          completed_at   = NOW()
        WHERE id = $9`,
      [
        typeof raw_response === 'string' ? raw_response : null,
        parsed_grades ? JSON.stringify(parsed_grades) : null,
        Number.isFinite(Number(input_tokens)) ? Number(input_tokens) : null,
        Number.isFinite(Number(output_tokens)) ? Number(output_tokens) : null,
        cost_gbp,
        Number.isFinite(Number(latency_ms)) ? Number(latency_ms) : null,
        newStatus,
        typeof error_message === 'string' ? error_message.slice(0, 2000) : null,
        Number(risk_run_id),
      ]
    );
  } catch (err) {
    console.error(`[risk-callback ${risk_run_id}] UPDATE failed:`, err);
    return res.status(500).json({ ok: false, error: 'update failed' });
  }

  console.log(
    `[risk-callback] settled risk_run_id=${risk_run_id} deal=${row.deal_id} ` +
    `status=${newStatus} in=${input_tokens} out=${output_tokens} cost=$${cost_gbp ?? 'n/a'} latency=${latency_ms}ms`
  );

  return res.json({ ok: true, risk_run_id: Number(risk_run_id), status: newStatus, cost_gbp });
});

module.exports = router;
