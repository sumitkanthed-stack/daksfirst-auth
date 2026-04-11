const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateInternal } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
// ═══════════════════════════════════════════════════════════════════════════
//  CREATE PROPERTY (with day1_ltv calculation)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/properties', authenticateToken, async (req, res) => {
  try {
    const { address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
            gdv, reinstatement, title_number, solicitor_firm, solicitor_ref, notes } = req.body;
    if (!address) return res.status(400).json({ error: 'Property address is required' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    // Calculate day 1 LTV if we have market_value and loan_amount
    let day1Ltv = null;
    if (market_value) {
      const loanResult = await pool.query(`SELECT loan_amount FROM deal_submissions WHERE id = $1`, [dealResult.rows[0].id]);
      if (loanResult.rows[0]?.loan_amount) {
        day1Ltv = ((loanResult.rows[0].loan_amount / market_value) * 100).toFixed(2);
      }
    }

    const result = await pool.query(
      `INSERT INTO deal_properties (deal_id, address, postcode, property_type, tenure, occupancy, current_use,
        market_value, purchase_price, gdv, reinstatement, day1_ltv, title_number, solicitor_firm, solicitor_ref, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [dealResult.rows[0].id, address, postcode || null, property_type || null, tenure || null,
       occupancy || null, current_use || null, market_value || null, purchase_price || null,
       gdv || null, reinstatement || null, day1Ltv, title_number || null,
       solicitor_firm || null, solicitor_ref || null, notes || null]
    );

    await logAudit(dealResult.rows[0].id, 'property_added', null, address, { property_type, market_value }, req.user.userId);
    res.status(201).json({ success: true, property: result.rows[0] });
  } catch (error) {
    console.error('[property] Error:', error);
    res.status(500).json({ error: 'Failed to add property' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET PROPERTIES WITH PORTFOLIO SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/properties', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(`SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY created_at`, [dealResult.rows[0].id]);

    // Portfolio summary
    const summary = {
      total_properties: result.rows.length,
      total_market_value: result.rows.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0),
      total_gdv: result.rows.reduce((sum, p) => sum + (parseFloat(p.gdv) || 0), 0),
      total_purchase_price: result.rows.reduce((sum, p) => sum + (parseFloat(p.purchase_price) || 0), 0)
    };

    res.json({ success: true, properties: result.rows, summary });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE PROPERTY
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/properties/:propertyId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
            gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes } = req.body;

    const result = await pool.query(
      `UPDATE deal_properties SET
        address = COALESCE($1, address), postcode = COALESCE($2, postcode),
        property_type = COALESCE($3, property_type), tenure = COALESCE($4, tenure),
        occupancy = COALESCE($5, occupancy), current_use = COALESCE($6, current_use),
        market_value = COALESCE($7, market_value), purchase_price = COALESCE($8, purchase_price),
        gdv = COALESCE($9, gdv), reinstatement = COALESCE($10, reinstatement),
        title_number = COALESCE($11, title_number), valuation_date = COALESCE($12, valuation_date),
        insurance_sum = COALESCE($13, insurance_sum), solicitor_firm = COALESCE($14, solicitor_firm),
        solicitor_ref = COALESCE($15, solicitor_ref), notes = COALESCE($16, notes), updated_at = NOW()
       WHERE id = $17 RETURNING *`,
      [address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
       gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes,
       req.params.propertyId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json({ success: true, property: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE PROPERTY
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId/properties/:propertyId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM deal_properties WHERE id = $1 RETURNING address`, [req.params.propertyId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json({ success: true, message: `Property removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove property' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPARSE PROPERTIES — Triggers n8n/Claude to re-parse properties (admin/RM only)
//  For existing deals where Claude hasn't parsed properties yet
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/reparse', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT id, security_address, security_postcode, current_value, asset_type, property_tenure
       FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (!deal.security_address) {
      return res.json({ success: false, message: 'No address data to parse' });
    }

    // Fire n8n webhook for data parsing (Smart Parse — Data Parsing workflow)
    const config = require('../config');
    const N8N_WEBHOOK_URL = config.N8N_DATA_PARSE_URL || config.N8N_WEBHOOK_URL;

    if (N8N_WEBHOOK_URL) {
      const webhookResp = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': config.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
        },
        body: JSON.stringify({
          trigger: 'property_reparse',
          submissionId: req.params.submissionId,
          dealId: deal.id,
          security: {
            address: deal.security_address,
            postcode: deal.security_postcode,
            asset_type: deal.asset_type,
            current_value: deal.current_value,
            tenure: deal.property_tenure
          },
          callbackUrl: 'https://daksfirst-auth.onrender.com/api/webhooks/analysis-complete'
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (webhookResp.ok) {
        await logAudit(deal.id, 'property_reparse_triggered', null, null,
          { triggered_by: req.user.userId }, req.user.userId);
        console.log(`[properties] Reparse triggered via n8n for deal ${req.params.submissionId}`);
        return res.json({ success: true, message: 'Property parsing triggered — Claude is working on it. Reload in a few seconds.' });
      } else {
        return res.status(502).json({ error: 'n8n webhook failed — try again' });
      }
    } else {
      return res.status(503).json({ error: 'n8n webhook not configured' });
    }
  } catch (error) {
    console.error('[properties] Reparse error:', error);
    res.status(500).json({ error: 'Failed to trigger property parsing' });
  }
});

module.exports = router;
