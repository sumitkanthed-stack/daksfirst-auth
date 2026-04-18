const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateInternal } = require('../middleware/auth');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');

// Helper: check if user owns the deal or is internal staff
async function canEditDeal(req, submissionId) {
  const isInternal = config.INTERNAL_ROLES.includes(req.user.role);
  if (isInternal) return true;
  // Broker: check they own this deal
  const result = await pool.query(
    `SELECT 1 FROM deal_submissions WHERE submission_id = $1 AND user_id = $2 LIMIT 1`,
    [submissionId, req.user.userId]
  );
  return result.rows.length > 0;
}
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
router.put('/:submissionId/properties/:propertyId', authenticateToken, async (req, res) => {
  try {
    // Allow internal staff OR deal owner
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to edit this property' });
    }

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
router.delete('/:submissionId/properties/:propertyId', authenticateToken, async (req, res) => {
  try {
    // Allow internal staff OR deal owner
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to delete this property' });
    }

    const result = await pool.query(`DELETE FROM deal_properties WHERE id = $1 RETURNING address`, [req.params.propertyId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json({ success: true, message: `Property removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove property' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARSE PROGRESS — Lightweight endpoint polled by frontend for live status
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/parse-progress', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT parse_progress, status FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const { parse_progress, status } = result.rows[0];
    return res.json({ success: true, progress: parse_progress || {}, deal_status: status });
  } catch (err) {
    console.error('[parse-progress] Error:', err);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPARSE — Calls Claude directly from Render to extract deal data
//  Fire-and-forget: responds immediately, processes in background
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/reparse', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT id, security_address, security_postcode, current_value, asset_type, property_tenure,
              loan_amount, borrower_name, exit_strategy, term_months, loan_purpose
       FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Check we have the API key
    const config = require('../config');
    if (!config.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'Anthropic API key not configured' });
    }

    // Quick check: does this deal have any documents?
    const docCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM deal_documents WHERE deal_id = $1 AND file_content IS NOT NULL`,
      [deal.id]
    );

    if (docCount.rows[0].cnt === 0 && !deal.security_address) {
      return res.json({ success: false, message: 'No documents or address data to parse' });
    }

    // ── Fire and forget: respond immediately, parse in background ──
    const { parseDealDocuments } = require('../services/claude-parser');

    const dealContext = {
      borrower_name: deal.borrower_name,
      loan_amount: deal.loan_amount,
      exit_strategy: deal.exit_strategy,
      loan_term_months: deal.term_months,
      loan_purpose: deal.loan_purpose
    };
    const securityContext = {
      address: deal.security_address,
      postcode: deal.security_postcode,
      asset_type: deal.asset_type,
      current_value: deal.current_value,
      tenure: deal.property_tenure
    };

    // Reset progress for fresh parse (don't touch status — it uses deal lifecycle stages)
    try {
      await pool.query(
        `UPDATE deal_submissions SET parse_progress = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [deal.id, JSON.stringify({ status: 'starting', message: 'Parse triggered — initialising...', steps: [] })]
      );
    } catch (progErr) {
      console.warn('[reparse] Could not reset parse_progress:', progErr.message);
    }

    // Start background parsing — don't await
    parseDealDocuments(req.params.submissionId, deal.id, dealContext, securityContext)
      .then(result => {
        console.log(`[reparse] Background parse complete for ${req.params.submissionId}:`, result);
      })
      .catch(err => {
        console.error(`[reparse] Background parse failed for ${req.params.submissionId}:`, err);
      });

    await logAudit(deal.id, 'property_reparse_triggered', null, null,
      { triggered_by: req.user.userId, doc_count: docCount.rows[0].cnt }, req.user.userId);

    console.log(`[reparse] Triggered for deal ${req.params.submissionId} (${docCount.rows[0].cnt} docs) — processing in background`);
    return res.json({
      success: true,
      message: `Parsing ${docCount.rows[0].cnt} documents — Claude is working on it.`
    });
  } catch (error) {
    console.error('[reparse] Error:', error);
    res.status(500).json({ error: 'Failed to trigger property parsing' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PROPERTY AUTO-SEARCH — Postcodes.io + EPC + Land Registry Price Paid
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /:submissionId/properties/:propertyId/search
 * Runs all three property data APIs in parallel and writes results to deal_properties.
 * Can be triggered manually (button click) or automatically after parse.
 */
router.post('/:submissionId/properties/:propertyId/search', authenticateToken, async (req, res) => {
  try {
    const { submissionId, propertyId } = req.params;

    // Auth check
    if (!await canEditDeal(req, submissionId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get property record
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const propResult = await pool.query(
      `SELECT id, address, postcode FROM deal_properties WHERE id = $1 AND deal_id = $2`,
      [propertyId, dealId]
    );
    if (propResult.rows.length === 0) return res.status(404).json({ error: 'Property not found' });

    const prop = propResult.rows[0];
    if (!prop.postcode && !prop.address) {
      return res.status(400).json({ error: 'Property has no postcode or address to search' });
    }

    // Run the search
    const { searchProperty } = require('../services/property-search');
    const results = await searchProperty(prop.postcode, prop.address);

    // Write results to deal_properties
    const updates = [];
    const values = [];
    let idx = 1;

    // Postcode data
    if (results.postcode_lookup.success) {
      const pc = results.postcode_lookup.data;
      const fields = [
        ['region', pc.region], ['country', pc.country], ['local_authority', pc.admin_district],
        ['admin_ward', pc.admin_ward], ['latitude', pc.latitude], ['longitude', pc.longitude],
        ['in_england_or_wales', pc.in_england_or_wales]
      ];
      for (const [col, val] of fields) {
        if (val !== null && val !== undefined) {
          updates.push(`${col} = $${idx}`);
          values.push(val);
          idx++;
        }
      }
    }

    // EPC data — only write fields when match is EXACT. Otherwise NULL out stale columns.
    const epcCols = ['epc_rating','epc_score','epc_potential_rating','epc_floor_area',
                     'epc_property_type','epc_built_form','epc_construction_age',
                     'epc_habitable_rooms','epc_inspection_date','epc_certificate_id'];
    const epcExact = results.epc.success && results.epc.match_confidence === 'exact' && results.epc.data;
    if (epcExact) {
      const e = results.epc.data;
      const fields = [
        ['epc_rating', e.epc_rating], ['epc_score', e.epc_score],
        ['epc_potential_rating', e.potential_rating], ['epc_floor_area', e.floor_area],
        ['epc_property_type', e.property_type], ['epc_built_form', e.built_form],
        ['epc_construction_age', e.construction_age], ['epc_habitable_rooms', e.number_habitable_rooms],
        ['epc_inspection_date', e.inspection_date], ['epc_certificate_id', e.lmk_key]
      ];
      for (const [col, val] of fields) {
        if (val !== null && val !== undefined) {
          updates.push(`${col} = $${idx}`); values.push(val); idx++;
        }
      }
    } else {
      // Clear any stale EPC data so the previous (wrong) match doesn't linger
      for (const col of epcCols) updates.push(`${col} = NULL`);
    }

    // Price paid data
    if (results.price_paid.success) {
      const pp = results.price_paid.data;
      if (pp.latest_price) {
        updates.push(`last_sale_price = $${idx}`); values.push(pp.latest_price); idx++;
        updates.push(`last_sale_date = $${idx}`); values.push(pp.latest_date); idx++;
      }
      updates.push(`price_paid_data = $${idx}`); values.push(JSON.stringify(pp.transactions || [])); idx++;
    }

    // Full raw results + metadata (includes EPC alternatives for picker UI)
    updates.push(`property_search_data = $${idx}`); values.push(JSON.stringify(results)); idx++;
    updates.push(`property_searched_at = NOW()`);
    updates.push(`property_searched_by = $${idx}`); values.push(req.user.userId); idx++;
    updates.push(`updated_at = NOW()`);

    // property ID for WHERE clause
    values.push(propertyId);

    if (updates.length > 0) {
      await pool.query(
        `UPDATE deal_properties SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Audit log — positional signature (dealId, action, fromVal, toVal, details, performedBy)
    await logAudit(dealId, 'property_search', null, prop.address || prop.postcode, {
      postcode_ok: results.postcode_lookup.success,
      epc_confidence: results.epc.success ? results.epc.match_confidence : 'failed',
      epc_alternatives: results.epc.success ? (results.epc.alternative_matches || []).length : 0,
      price_paid_ok: results.price_paid.success,
    }, req.user.userId);

    // Geography warning
    const geoWarning = results.postcode_lookup.success && !results.postcode_lookup.data.in_england_or_wales
      ? `WARNING: Property is in ${results.postcode_lookup.data.country} — outside Daksfirst lending geography (England & Wales only)`
      : null;

    // EPC ambiguity warning (separate from error — analyst needs to pick)
    const epcWarning = (results.epc.success && results.epc.match_confidence !== 'exact')
      ? `EPC match: ${results.epc.match_confidence.toUpperCase()} — ${results.epc.match_note || 'review required'}`
      : null;

    res.json({
      success: true,
      results,
      match_confidence: results.epc.success ? results.epc.match_confidence : 'failed',
      alternative_matches: results.epc.success ? (results.epc.alternative_matches || []) : [],
      geo_warning: geoWarning,
      epc_warning: epcWarning,
      message: 'Property search completed'
    });

  } catch (error) {
    console.error('[property-search] Route error:', error);
    res.status(500).json({ error: 'Property search failed: ' + error.message });
  }
});

/**
 * POST /:submissionId/properties/search-all
 * Search all properties on a deal at once (used by auto-trigger after parse)
 */
router.post('/:submissionId/properties/search-all', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;
    if (!await canEditDeal(req, submissionId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const props = await pool.query(
      `SELECT id, address, postcode FROM deal_properties WHERE deal_id = $1 AND property_searched_at IS NULL ORDER BY id`,
      [dealId]
    );

    if (props.rows.length === 0) {
      return res.json({ success: true, message: 'No unsearched properties found', results: [] });
    }

    const { searchProperty } = require('../services/property-search');
    const allResults = [];

    for (const prop of props.rows) {
      if (!prop.postcode && !prop.address) continue;
      try {
        const results = await searchProperty(prop.postcode, prop.address);

        // Same write logic as single search
        const updates = [];
        const values = [];
        let idx = 1;

        if (results.postcode_lookup.success) {
          const pc = results.postcode_lookup.data;
          for (const [col, val] of [
            ['region', pc.region], ['country', pc.country], ['local_authority', pc.admin_district],
            ['admin_ward', pc.admin_ward], ['latitude', pc.latitude], ['longitude', pc.longitude],
            ['in_england_or_wales', pc.in_england_or_wales]
          ]) {
            if (val !== null && val !== undefined) { updates.push(`${col} = $${idx}`); values.push(val); idx++; }
          }
        }
        // EPC — only write on exact match; clear stale otherwise
        const epcColsSA = ['epc_rating','epc_score','epc_potential_rating','epc_floor_area',
                           'epc_property_type','epc_built_form','epc_construction_age',
                           'epc_habitable_rooms','epc_inspection_date','epc_certificate_id'];
        if (results.epc.success && results.epc.match_confidence === 'exact' && results.epc.data) {
          const e = results.epc.data;
          for (const [col, val] of [
            ['epc_rating', e.epc_rating], ['epc_score', e.epc_score],
            ['epc_potential_rating', e.potential_rating], ['epc_floor_area', e.floor_area],
            ['epc_property_type', e.property_type], ['epc_built_form', e.built_form],
            ['epc_construction_age', e.construction_age], ['epc_habitable_rooms', e.number_habitable_rooms],
            ['epc_inspection_date', e.inspection_date], ['epc_certificate_id', e.lmk_key]
          ]) {
            if (val !== null && val !== undefined) { updates.push(`${col} = $${idx}`); values.push(val); idx++; }
          }
        } else {
          for (const col of epcColsSA) updates.push(`${col} = NULL`);
        }
        if (results.price_paid.success) {
          const pp = results.price_paid.data;
          if (pp.latest_price) { updates.push(`last_sale_price = $${idx}`); values.push(pp.latest_price); idx++; updates.push(`last_sale_date = $${idx}`); values.push(pp.latest_date); idx++; }
          updates.push(`price_paid_data = $${idx}`); values.push(JSON.stringify(pp.transactions || [])); idx++;
        }
        updates.push(`property_search_data = $${idx}`); values.push(JSON.stringify(results)); idx++;
        updates.push(`property_searched_at = NOW()`);
        updates.push(`property_searched_by = $${idx}`); values.push(req.user.userId); idx++;
        updates.push(`updated_at = NOW()`);
        values.push(prop.id);

        await pool.query(`UPDATE deal_properties SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        allResults.push({ propertyId: prop.id, address: prop.address, success: true, results });
      } catch (err) {
        allResults.push({ propertyId: prop.id, address: prop.address, success: false, error: err.message });
      }
    }

    res.json({ success: true, searched: allResults.length, results: allResults });
  } catch (error) {
    console.error('[property-search] Search-all error:', error);
    res.status(500).json({ error: 'Property search-all failed: ' + error.message });
  }
});

module.exports = router;
