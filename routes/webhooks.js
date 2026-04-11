const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { syncDealProperties } = require('../services/property-parser');

const N8N_WEBHOOK_URL = config.N8N_WEBHOOK_URL || '';

// ═══════════════════════════════════════════════════════════════════════════
//  WEBHOOK FIRE HELPER (with retry logic)
// ═══════════════════════════════════════════════════════════════════════════
async function fireWebhook(dealId, submissionId, dealData, userData) {
  if (!N8N_WEBHOOK_URL) {
    console.log('[webhook] No N8N_WEBHOOK_URL configured — skipping');
    return;
  }

  const payload = {
    submissionId: submissionId,
    source: 'web_form',
    timestamp: new Date().toISOString(),
    submittedBy: {
      userId: userData.userId,
      email: userData.email,
      role: userData.role
    },
    borrower: {
      name: dealData.borrower_name || '',
      company: dealData.borrower_company || '',
      email: dealData.borrower_email || '',
      phone: dealData.borrower_phone || ''
    },
    broker: {
      name: dealData.broker_name || '',
      company: dealData.broker_company || '',
      fca_number: dealData.broker_fca || ''
    },
    security: {
      address: dealData.security_address || '',
      postcode: dealData.security_postcode || '',
      asset_type: dealData.asset_type || '',
      current_value: dealData.current_value || null
    },
    loan: {
      amount: dealData.loan_amount || null,
      ltv_requested: dealData.ltv_requested || null,
      purpose: dealData.loan_purpose || '',
      exit_strategy: dealData.exit_strategy || '',
      term_months: dealData.term_months || null,
      rate_requested: dealData.rate_requested || null
    },
    documents: dealData.documents || [],
    additional_notes: dealData.additional_notes || ''
  };

  const delays = [0, 5000, 15000, 45000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt]));

    try {
      console.log(`[webhook] Attempt ${attempt + 1} for deal ${submissionId}`);
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': config.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });

      const responseText = await response.text();

      await pool.query(
        `INSERT INTO webhook_log (deal_id, attempt, status_code, response_body) VALUES ($1,$2,$3,$4)`,
        [dealId, attempt + 1, response.status, responseText.substring(0, 500)]
      );

      if (response.ok) {
        await pool.query(
          `UPDATE deal_submissions SET webhook_status='sent', webhook_attempts=$1, webhook_last_try=NOW(), status='processing' WHERE id=$2`,
          [attempt + 1, dealId]
        );
        console.log(`[webhook] Success for deal ${submissionId} on attempt ${attempt + 1}`);
        return;
      }

      console.warn(`[webhook] Non-OK response ${response.status} for deal ${submissionId}`);
    } catch (err) {
      console.error(`[webhook] Attempt ${attempt + 1} failed for deal ${submissionId}:`, err.message);
      await pool.query(
        `INSERT INTO webhook_log (deal_id, attempt, error_message) VALUES ($1,$2,$3)`,
        [dealId, attempt + 1, err.message]
      ).catch(() => {});
    }
  }

  await pool.query(
    `UPDATE deal_submissions SET webhook_status='failed', webhook_attempts=4, webhook_last_try=NOW() WHERE id=$1`,
    [dealId]
  ).catch(() => {});
  console.error(`[webhook] All retries exhausted for deal ${submissionId}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ANALYSIS WEBHOOK CALLBACK (from n8n)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/analysis-complete', async (req, res) => {
  try {
    const { submissionId, creditMemoUrl, termsheetUrl, gbbMemoUrl, analysisJson,
            batch_number, total_batches } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const batchLabel = batch_number ? ` (batch ${batch_number}/${total_batches})` : '';
    console.log(`[webhook-analysis] Analysis complete for: ${submissionId}${batchLabel}`);

    // Get deal ID from submission_id
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const dealId = dealResult.rows[0].id;
    const isBatch = batch_number && total_batches;
    const isFirstBatch = !isBatch || batch_number === 1;

    // ── Store / merge analysis results ──
    if (isFirstBatch) {
      // First batch (or non-batch): upsert the full analysis
      await pool.query(
        `INSERT INTO analysis_results (deal_id, credit_memo_url, termsheet_url, gbb_memo_url, analysis_json)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (deal_id) DO UPDATE SET
           credit_memo_url = COALESCE(EXCLUDED.credit_memo_url, analysis_results.credit_memo_url),
           termsheet_url = COALESCE(EXCLUDED.termsheet_url, analysis_results.termsheet_url),
           gbb_memo_url = COALESCE(EXCLUDED.gbb_memo_url, analysis_results.gbb_memo_url),
           analysis_json = EXCLUDED.analysis_json,
           completed_at = NOW()`,
        [dealId, creditMemoUrl || null, termsheetUrl || null, gbbMemoUrl || null, analysisJson || null]
      );
    } else {
      // Subsequent batches: merge analysisJson into existing
      try {
        const existing = await pool.query(
          `SELECT analysis_json FROM analysis_results WHERE deal_id = $1`, [dealId]
        );
        const existingData = existing.rows[0]?.analysis_json
          ? (typeof existing.rows[0].analysis_json === 'string' ? JSON.parse(existing.rows[0].analysis_json) : existing.rows[0].analysis_json)
          : {};
        const newData = typeof analysisJson === 'string' ? JSON.parse(analysisJson) : (analysisJson || {});

        // Merge: append arrays (borrowers, parsedProperties), fill nulls for objects
        const merged = { ...existingData };

        // Append array fields
        for (const arrKey of ['borrowers', 'parsedProperties']) {
          if (Array.isArray(newData[arrKey]) && newData[arrKey].length > 0) {
            merged[arrKey] = [...(merged[arrKey] || []), ...newData[arrKey]];
          }
        }
        // Merge object fields: new non-null values fill existing nulls
        for (const objKey of ['company', 'loan', 'redemption', 'refurbishment', 'solicitor', 'insurance', 'planning', 'broker']) {
          if (newData[objKey] && typeof newData[objKey] === 'object') {
            merged[objKey] = merged[objKey] || {};
            for (const [k, v] of Object.entries(newData[objKey])) {
              if (v !== null && v !== 0 && v !== '' && (merged[objKey][k] === null || merged[objKey][k] === 0 || merged[objKey][k] === undefined)) {
                merged[objKey][k] = v;
              }
            }
          }
        }
        // Append notes
        if (newData.notes) {
          merged.notes = merged.notes ? merged.notes + '\n' + newData.notes : newData.notes;
        }
        // Keep higher confidence
        if (newData.confidence && (!merged.confidence || newData.confidence > merged.confidence)) {
          merged.confidence = newData.confidence;
        }
        // Append extraction summary
        if (newData.extraction_summary) {
          merged.extraction_summary = merged.extraction_summary
            ? merged.extraction_summary + ' | Batch ' + batch_number + ': ' + newData.extraction_summary
            : newData.extraction_summary;
        }

        await pool.query(
          `UPDATE analysis_results SET analysis_json = $1, completed_at = NOW() WHERE deal_id = $2`,
          [JSON.stringify(merged), dealId]
        );
        console.log(`[webhook-analysis] Merged batch ${batch_number} into existing results for deal ${dealId}`);
      } catch (mergeErr) {
        console.error('[webhook-analysis] Batch merge failed, storing as standalone:', mergeErr.message);
        await pool.query(
          `INSERT INTO analysis_results (deal_id, analysis_json)
           VALUES ($1, $2)
           ON CONFLICT (deal_id) DO UPDATE SET analysis_json = EXCLUDED.analysis_json, completed_at = NOW()`,
          [dealId, analysisJson || null]
        );
      }
    }

    // Update deal status
    await pool.query(
      `UPDATE deal_submissions SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [dealId]
    );

    // ── Claude-parsed properties: extract and store ──
    try {
      const analysis = typeof analysisJson === 'string' ? JSON.parse(analysisJson) : (analysisJson || {});
      if (analysis.parsedProperties && Array.isArray(analysis.parsedProperties) && analysis.parsedProperties.length > 0) {
        const claudeProperties = analysis.parsedProperties.map(p => ({
          address: p.address || '',
          postcode: p.postcode || null,
          market_value: p.market_value ? parseFloat(p.market_value) : null,
          property_type: p.property_type || null,
          tenure: p.tenure || null,
          source: 'claude_parsed'
        }));
        // First batch: force overwrite. Subsequent batches: append only
        await syncDealProperties(pool, dealId, claudeProperties, { force: isFirstBatch });
        console.log(`[webhook-analysis] Claude parsed ${claudeProperties.length} properties for deal ${dealId}${batchLabel}`);
      }
    } catch (parseErr) {
      console.error('[webhook-analysis] Property parsing from Claude failed (non-blocking):', parseErr.message);
    }

    console.log(`[webhook-analysis] Analysis stored for deal: ${dealId}${batchLabel}`);
    res.json({ success: true, message: `Analysis results stored${batchLabel}` });
  } catch (error) {
    console.error('[webhook-analysis] Error:', error);
    res.status(500).json({ error: 'Failed to store analysis results' });
  }
});

module.exports = router;
module.exports.fireWebhook = fireWebhook;
