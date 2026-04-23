/**
 * Output Engine Dispatcher — OE-3 (2026-04-22)
 *
 * Ships feature envelopes to the n8n "Credit Analysis - Admin Run" workflow
 * and records every run in `credit_analysis_outputs`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  AUTH IS A DATA COLLECTOR. No decisions happen here.
 *  This module wraps:
 *    1. Adapter: packager output → nested envelope the clone's
 *       `Code in JavaScript1` node expects (borrower/broker/security/loan/
 *       onboarding/documents/approvals/documentSummary/dip/credit).
 *    2. Dispatcher: fire-and-forget POST to the n8n webhook, returns runId.
 *       n8n executes async and POSTs back to /api/webhooks/output-engine/complete
 *       with base64 DOCX blobs keyed by runId.
 *    3. Ledger write: INSERT row into credit_analysis_outputs with status
 *       'running' BEFORE dispatch so a timeout is detectable.
 *  See memory: project_output_engine_oe1_sealed.md
 * ───────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config');

const N8N_OUTPUT_ENGINE_URL = config.N8N_OUTPUT_ENGINE_WEBHOOK_URL || '';

// Hardcoded public base URL for the auth service — the n8n callback needs an
// absolute URL to POST back to. Render deploy is the authoritative one for
// webhook callbacks (Vercel is the frontend).
const AUTH_CALLBACK_BASE =
  config.AUTH_PUBLIC_BASE_URL || 'https://daksfirst-auth.onrender.com';

// ─── Adapter ────────────────────────────────────────────────────────────────

/**
 * Convert the packager's flat features object into the nested envelope the
 * existing n8n `Code in JavaScript1` node consumes. Keeps n8n untouched
 * through OE-1 sealing; OE-2 will swap this for a flatter passthrough when
 * the LLM chain splits into 7 section-calls.
 *
 * Non-destructive: keeps the original packager envelope under
 * `_feature_envelope` so the LLM can reach deep fields if the prompt wants.
 *
 * @param {object} pkg        output of featurePackager.packageDealForStage()
 * @param {object} options
 * @param {string} options.runId
 * @param {string} options.callbackUrl
 * @param {string} options.callbackSecret  shared WEBHOOK_SECRET — n8n uses it
 *                                         to HMAC-sign the callback body.
 *                                         Sent in-envelope because n8n Cloud
 *                                         Starter blocks Code-node $env access,
 *                                         so Preamble Assembly can't read it
 *                                         from n8n env vars.
 * @returns {object} envelope ready to POST to N8N_OUTPUT_ENGINE_WEBHOOK_URL
 */
function buildN8nEnvelope(pkg, { runId, callbackUrl, callbackSecret } = {}) {
  if (!pkg || !pkg.envelope || !pkg.envelope.features) {
    throw new Error('[output-engine-dispatcher] invalid packager output');
  }

  const deal = pkg.envelope.features.deal || {};
  const borrowers = pkg.envelope.features.borrowers || [];
  const properties = pkg.envelope.features.properties || [];

  const primaryBorrower =
    borrowers.find((b) => b.role === 'primary') || borrowers[0] || {};
  const primaryProperty = properties[0] || {};

  return {
    // ── Correlation / meta ──────────────────────────────────────────────
    runId,
    callbackUrl,
    // HMAC-signing secret for the callback. n8n Preamble Assembly reads this
    // and passes it through to Callback Assembly, which signs the callback
    // body with it. Auth verifies the signature on receipt. TLS protects
    // transit; n8n execution logs are admin-only (same trust surface as the
    // Render/Vercel env stores). Added 2026-04-23 because n8n Cloud Starter
    // blocks $env access in Code nodes — the previous fallback path is dead.
    callbackSecret,
    submissionId: deal.submission_id,
    source: 'admin_run',
    timestamp: new Date().toISOString(),

    // ── Borrower block (Code in JavaScript1 reads these keys) ───────────
    borrower: {
      name: primaryBorrower.full_name || deal.borrower_name || '',
      company:
        deal.borrower_company ||
        deal.company_name ||
        primaryBorrower.company_name ||
        '',
      email: primaryBorrower.email || deal.borrower_email || '',
      phone: primaryBorrower.phone || deal.borrower_phone || '',
      type: deal.borrower_type || '',
      _all_borrowers: borrowers, // full array for the LLM
    },

    broker: {
      name: deal.broker_name || '',
      company: deal.broker_company || '',
      fca_number: deal.broker_fca || '',
      email: deal.broker_email || '',
    },

    security: {
      address: primaryProperty.address || deal.security_address || '',
      postcode: primaryProperty.postcode || deal.security_postcode || '',
      asset_type: primaryProperty.property_type || deal.asset_type || '',
      current_value:
        primaryProperty.market_value || deal.current_value || null,
      _all_properties: properties,
    },

    loan: {
      amount: deal.loan_amount || deal.loan_amount_requested || null,
      amount_approved: deal.loan_amount_approved || null,
      ltv_requested: deal.ltv_requested || null,
      ltv_approved: deal.ltv_approved || null,
      purpose: deal.loan_purpose || '',
      exit_strategy: deal.exit_strategy || '',
      term_months: deal.term_months || null,
      rate_requested: deal.rate_requested || null,
      interest_servicing: deal.interest_servicing || '',
    },

    dip: {
      issued: Boolean(deal.dip_issued_at),
      issued_at: deal.dip_issued_at || null,
      fee_requested_amount: deal.fee_requested_amount || null,
      fee_requested_at: deal.fee_requested_at || null,
      fee_confirmed: Boolean(
        deal.dip_fee_confirmed || deal.commitment_fee_received
      ),
    },

    credit: {
      rm_recommendation: deal.rm_recommendation || '',
      credit_recommendation: deal.credit_recommendation || '',
      compliance_recommendation: deal.compliance_recommendation || '',
      final_decision: deal.final_decision || '',
      internal_status: deal.internal_status || '',
    },

    approvals: {
      rm: deal.rm_recommendation || '',
      credit: deal.credit_recommendation || '',
      compliance: deal.compliance_recommendation || '',
    },

    // Admin-run path has no fresh docs to parse — HTTP Request5
    // (/parse-all-files) tolerates empty array. OE-2 will replace.
    documents: [],
    documentSummary: {},
    onboarding: {},

    additional_notes: deal.additional_notes || deal.dip_notes || '',

    // Full packager features for deep retrieval by the LLM prompt.
    // Not consumed by Code in JavaScript1 today — staged for OE-2.
    _feature_envelope: {
      schema_version: pkg.envelope.schema_version,
      stage_id: pkg.envelope.stage_id,
      feature_hash: pkg.feature_hash,
      packaged_at: pkg.envelope.packaged_at,
      counts: pkg.envelope.counts,
      features: pkg.envelope.features,
    },
  };
}

// ─── Ledger helpers ─────────────────────────────────────────────────────────

async function createRunRow({ dealId, dealSubmissionId, triggeredBy, featureHash }) {
  const runId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO credit_analysis_outputs
       (run_id, deal_id, deal_submission_id, status, feature_hash, triggered_by)
     VALUES ($1, $2, $3, 'running', $4, $5)`,
    [runId, dealId, dealSubmissionId, featureHash, triggeredBy]
  );
  return runId;
}

async function markRunFailed(runId, errorMsg) {
  await pool.query(
    `UPDATE credit_analysis_outputs
        SET status = 'failed', error = $2, completed_at = NOW()
      WHERE run_id = $1`,
    [runId, String(errorMsg || '').slice(0, 2000)]
  );
}

async function markRunComplete(runId, payload) {
  const {
    memo_docx_b64,
    termsheet_docx_b64,
    gbb_docx_b64,
    cost_gbp,
    model_version,
    n8n_execution_id,
  } = payload || {};

  await pool.query(
    `UPDATE credit_analysis_outputs
        SET status             = 'complete',
            memo_docx_b64      = $2,
            termsheet_docx_b64 = $3,
            gbb_docx_b64       = $4,
            cost_gbp           = $5,
            model_version      = $6,
            n8n_execution_id   = $7,
            completed_at       = NOW()
      WHERE run_id = $1`,
    [
      runId,
      memo_docx_b64 || null,
      termsheet_docx_b64 || null,
      gbb_docx_b64 || null,
      cost_gbp != null ? cost_gbp : null,
      model_version || null,
      n8n_execution_id || null,
    ]
  );
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Fire the envelope at n8n. Returns quickly — n8n executes async and calls
 * back. We DO NOT await the full workflow; a 202-style response from n8n
 * means "we accepted your payload" (Webhook node in production always
 * responds fast). If n8n rejects at the webhook, we mark the run failed and
 * surface the error back to the caller.
 *
 * @param {object} params
 * @param {object} params.pkg          packager output
 * @param {number} params.dealId       deal_submissions.id
 * @param {string} params.triggeredBy  user id / 'user:<uuid>'
 * @returns {Promise<{success: boolean, runId?: string, error?: string}>}
 */
async function dispatch({ pkg, dealId, triggeredBy }) {
  if (!N8N_OUTPUT_ENGINE_URL) {
    return {
      success: false,
      error: 'N8N_OUTPUT_ENGINE_WEBHOOK_URL not configured on auth',
    };
  }
  if (!pkg || !pkg.envelope || !pkg.envelope.features) {
    return { success: false, error: 'invalid packager output' };
  }

  const runId = await createRunRow({
    dealId,
    dealSubmissionId: pkg.envelope.submission_id,
    triggeredBy,
    featureHash: pkg.feature_hash,
  });

  // NB: server.js mounts webhookRoutes at '/api/webhook' (singular), so that's
  // the base path — not '/api/webhooks'.
  const callbackUrl = `${AUTH_CALLBACK_BASE}/api/webhook/output-engine/complete`;

  // Guard: the secret MUST be configured, or signatures can't be verified.
  // Fail fast rather than dispatch a run that can't complete.
  if (!config.WEBHOOK_SECRET) {
    return {
      success: false,
      error: 'WEBHOOK_SECRET not configured on auth — cannot sign callback',
    };
  }

  const envelope = buildN8nEnvelope(pkg, {
    runId,
    callbackUrl,
    callbackSecret: config.WEBHOOK_SECRET,
  });

  try {
    const response = await fetch(N8N_OUTPUT_ENGINE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': config.WEBHOOK_SECRET,
      },
      body: JSON.stringify({ body: envelope }), // Web Portal Code reads `.body`
      signal: AbortSignal.timeout(30000),
    });

    const respText = await response.text();
    if (!response.ok) {
      const err = `n8n webhook returned ${response.status}: ${respText.slice(0, 300)}`;
      console.error('[output-engine-dispatcher]', err);
      await markRunFailed(runId, err);
      return { success: false, error: err, runId };
    }

    console.log(
      `[output-engine-dispatcher] dispatched runId=${runId} dealId=${dealId} ` +
        `status=${response.status} n8n_response_bytes=${respText.length}`
    );
    return { success: true, runId };
  } catch (err) {
    console.error('[output-engine-dispatcher] dispatch crashed:', err);
    await markRunFailed(runId, err.message || String(err));
    return { success: false, error: err.message || String(err), runId };
  }
}

module.exports = {
  dispatch,
  markRunComplete,
  markRunFailed,
  // Exposed for tests
  buildN8nEnvelope,
  createRunRow,
  AUTH_CALLBACK_BASE,
};
