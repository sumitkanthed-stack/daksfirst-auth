// ─────────────────────────────────────────────────────────────────────────────
// routes/output-engine-v2.js
//
// NEW callback handler for the v2 5-DOCX prompt regime.
//
// POST /api/webhook/output-engine/complete
//   Called by n8n "Credit Analysis - Admin Run v2" once all 5 calls and all
//   5 DOCX builds are done. Persists the 5 blobs + cost breakdown into
//   credit_analysis_outputs, flips status to 'complete'.
//
// POST /api/webhook/output-engine/failed
//   Called by n8n if any call or DOCX build fails. Marks run 'failed' with
//   the error message.
//
// Expected happy-path payload shape (from n8n callback assembly node):
//   {
//     runId:             "uuid",
//     status:            "completed",
//     outputs: {
//       credit_memo:           { filename, b64, bytes },
//       termsheet:             { filename, b64, bytes },
//       funder_placement:      { filename, b64, bytes },
//       financial_sensitivity: { filename, b64, bytes },
//       assembled_briefing:    { filename, b64, bytes }
//     },
//     cost: {
//       total_gbp: 0.78,
//       by_call: { credit_memo: {...}, termsheet: {...}, ... },
//       cache_creation_input_tokens: N,
//       cache_read_input_tokens:     N,
//       prompt_cache_hit_ratio:      0.95,
//       model_version:               "claude-opus-4-7",
//       pricing_ts:                  "2026-04-23T..."
//     },
//     blocksAssembly:         false,
//     n8n_execution_id:       "...",
//     timestamp:              "ISO-8601"
//   }
//
// Auth — HMAC signature on request body OR shared secret header
// (we keep WEBHOOK_SECRET for backward compat + add HMAC as the strong path).
//
// Mount in server.js:
//   const outputEngineV2Routes = require('./routes/output-engine-v2');
//   app.use('/api/webhook', outputEngineV2Routes);
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const pool   = require('../db/pool');
const config = require('../config');

// ── Auth middleware ─────────────────────────────────────────────────────────
// Accepts either:
//   - X-Webhook-Secret: <shared secret>   (legacy, same as OE-4)
//   - X-Signature: sha256=<hex(hmac(body))>  (v2, stronger)
// At least one must validate.
function verifyCallback(req, res, next) {
  const providedSecret = req.headers['x-webhook-secret'];
  const providedHmac   = req.headers['x-signature'];

  const secretOk = providedSecret && providedSecret === config.WEBHOOK_SECRET;

  // HMAC over the raw body. express.json() has already parsed, so
  // re-stringify deterministically. For strict verification, add a
  // raw-body middleware upstream. For MVP, accept EITHER auth method.
  let hmacOk = false;
  if (providedHmac && providedHmac.startsWith('sha256=')) {
    try {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', config.WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      hmacOk = crypto.timingSafeEqual(
        Buffer.from(providedHmac),
        Buffer.from(expected)
      );
    } catch (_) { hmacOk = false; }
  }

  if (!secretOk && !hmacOk) {
    console.warn('[output-engine-v2] Rejected callback — auth failed. IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function b64BytesOk(doc) {
  // Defensive: require at least a tiny blob (a real DOCX is >8kb).
  return doc && typeof doc.b64 === 'string' && doc.b64.length > 100;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(v, min), max);
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /output-engine/complete
// ═══════════════════════════════════════════════════════════════════════════
router.post('/output-engine/complete', verifyCallback, async (req, res) => {
  const startedAt = Date.now();

  try {
    const body = req.body || {};
    const {
      runId, outputs, cost, blocksAssembly,
      n8n_execution_id, status, timestamp,
    } = body;

    if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ error: 'runId missing or malformed' });
    }

    // Find the row
    const { rows } = await pool.query(
      `SELECT id, deal_id, status FROM credit_analysis_outputs WHERE run_id = $1 LIMIT 1`,
      [runId]
    );
    if (rows.length === 0) {
      console.warn('[output-engine-v2/complete] unknown runId:', runId);
      return res.status(404).json({ error: 'runId not found' });
    }
    const row = rows[0];

    if (status === 'failed') {
      const err = (body.error || 'n8n reported failure').toString().slice(0, 2000);
      await pool.query(
        `UPDATE credit_analysis_outputs
            SET status       = 'failed',
                error        = $2,
                completed_at = NOW()
          WHERE run_id = $1`,
        [runId, err]
      );
      console.log(`[output-engine-v2/complete] marked failed runId=${runId}: ${err}`);
      return res.json({ success: true, marked: 'failed' });
    }

    // Happy path — validate all 5 blobs present
    const o = outputs || {};
    const missing = [];
    if (!b64BytesOk(o.credit_memo))           missing.push('credit_memo');
    if (!b64BytesOk(o.termsheet))             missing.push('termsheet');
    if (!b64BytesOk(o.funder_placement))      missing.push('funder_placement');
    if (!b64BytesOk(o.financial_sensitivity)) missing.push('financial_sensitivity');
    if (!b64BytesOk(o.assembled_briefing))    missing.push('assembled_briefing');

    if (missing.length > 0) {
      const err = `missing or empty DOCX blobs: ${missing.join(', ')}`;
      await pool.query(
        `UPDATE credit_analysis_outputs
            SET status = 'failed', error = $2, completed_at = NOW()
          WHERE run_id = $1`,
        [runId, err]
      );
      return res.status(400).json({ error: err });
    }

    const totalGbp = clamp(cost && cost.total_gbp, 0, 1000);
    const costBreakdownJson = cost ? JSON.stringify(cost) : null;
    const blocksAssemblyBool = blocksAssembly === true || blocksAssembly === 'YES';

    await pool.query(
      `UPDATE credit_analysis_outputs
          SET status              = 'complete',
              memo_docx_b64       = $2,
              termsheet_docx_b64  = $3,
              gbb_docx_b64        = $4,
              financial_docx_b64  = $5,
              assembled_docx_b64  = $6,
              cost_gbp            = $7,
              cost_breakdown      = $8::jsonb,
              blocks_assembly     = $9,
              pipeline_version    = 'v2',
              model_version       = $10,
              n8n_execution_id    = $11,
              completed_at        = NOW()
        WHERE run_id = $1`,
      [
        runId,
        o.credit_memo.b64,
        o.termsheet.b64,
        o.funder_placement.b64,
        o.financial_sensitivity.b64,
        o.assembled_briefing.b64,
        totalGbp,
        costBreakdownJson,
        blocksAssemblyBool,
        (cost && cost.model_version) || null,
        n8n_execution_id || null,
      ]
    );

    console.log(
      `[output-engine-v2/complete] runId=${runId} dealId=${row.deal_id} ` +
      `cost=£${totalGbp ?? '-'} blocked=${blocksAssemblyBool} ` +
      `ms=${Date.now() - startedAt}`
    );

    return res.json({
      success: true,
      runId,
      deal_id: row.deal_id,
      status: 'complete',
      blocks_assembly: blocksAssemblyBool,
    });
  } catch (err) {
    console.error('[output-engine-v2/complete] crash:', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /output-engine/failed   (explicit failure webhook from n8n Error branch)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/output-engine/failed', verifyCallback, async (req, res) => {
  try {
    const { runId, error, failed_at_step } = req.body || {};
    if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
      return res.status(400).json({ error: 'runId missing or malformed' });
    }
    const msg = [
      failed_at_step ? `step=${failed_at_step}` : null,
      error || 'n8n reported failure',
    ].filter(Boolean).join(' | ').slice(0, 2000);

    await pool.query(
      `UPDATE credit_analysis_outputs
          SET status = 'failed', error = $2, completed_at = NOW()
        WHERE run_id = $1`,
      [runId, msg]
    );
    console.log(`[output-engine-v2/failed] runId=${runId} msg="${msg}"`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[output-engine-v2/failed] crash:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
