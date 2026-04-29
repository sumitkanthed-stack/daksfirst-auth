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
    // H2 (2026-04-20): add canEditDeal check — was missing, any authenticated
    // user could add properties to any deal by guessing submissionId.
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to add properties to this deal' });
    }

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
            gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes,
            security_charge_type, existing_charges_note } = req.body;

    const result = await pool.query(
      `UPDATE deal_properties SET
        address = COALESCE($1, address), postcode = COALESCE($2, postcode),
        property_type = COALESCE($3, property_type), tenure = COALESCE($4, tenure),
        occupancy = COALESCE($5, occupancy), current_use = COALESCE($6, current_use),
        market_value = COALESCE($7, market_value), purchase_price = COALESCE($8, purchase_price),
        gdv = COALESCE($9, gdv), reinstatement = COALESCE($10, reinstatement),
        title_number = COALESCE($11, title_number), valuation_date = COALESCE($12, valuation_date),
        insurance_sum = COALESCE($13, insurance_sum), solicitor_firm = COALESCE($14, solicitor_firm),
        solicitor_ref = COALESCE($15, solicitor_ref), notes = COALESCE($16, notes),
        security_charge_type = COALESCE($17, security_charge_type),
        existing_charges_note = COALESCE($18, existing_charges_note),
        updated_at = NOW()
       WHERE id = $19 RETURNING *`,
      [address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
       gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes,
       security_charge_type, existing_charges_note,
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

    // Price paid data — write fresh values on success; CLEAR stale values on no-match
    // (prevents old wrong data lingering when the unit-number matcher correctly rejects it)
    if (results.price_paid.success) {
      const pp = results.price_paid.data;
      if (pp.latest_price) {
        updates.push(`last_sale_price = $${idx}`); values.push(pp.latest_price); idx++;
        updates.push(`last_sale_date = $${idx}`); values.push(pp.latest_date); idx++;
      } else {
        updates.push(`last_sale_price = NULL`);
        updates.push(`last_sale_date = NULL`);
      }
      updates.push(`price_paid_data = $${idx}`); values.push(JSON.stringify(pp.transactions || [])); idx++;
    } else {
      // Land Registry returned no match — clear any stale cached values from a previous (buggy) query
      updates.push(`last_sale_price = NULL`);
      updates.push(`last_sale_date = NULL`);
      updates.push(`price_paid_data = '[]'::jsonb`);
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
          else { updates.push(`last_sale_price = NULL`); updates.push(`last_sale_date = NULL`); }
          updates.push(`price_paid_data = $${idx}`); values.push(JSON.stringify(pp.transactions || [])); idx++;
        } else {
          // No match — clear stale values from previous (buggy) queries
          updates.push(`last_sale_price = NULL`);
          updates.push(`last_sale_date = NULL`);
          updates.push(`price_paid_data = '[]'::jsonb`);
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

// ═══════════════════════════════════════════════════════════════════════════
//  VERIFY PROPERTY — Analyst accepts EPC match and locks the record
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/properties/:propertyId/verify', authenticateToken, async (req, res) => {
  try {
    const { submissionId, propertyId } = req.params;
    if (!await canEditDeal(req, submissionId)) return res.status(403).json({ error: 'Access denied' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `UPDATE deal_properties
       SET property_verified_at = NOW(), property_verified_by = $1, updated_at = NOW()
       WHERE id = $2 AND deal_id = $3
       RETURNING id, address, property_verified_at`,
      [req.user.userId, propertyId, dealResult.rows[0].id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });

    await logAudit(dealResult.rows[0].id, 'property_verified', null, result.rows[0].address,
      { propertyId }, req.user.userId);

    res.json({ success: true, property: result.rows[0] });
  } catch (error) {
    console.error('[property-verify] Error:', error);
    res.status(500).json({ error: 'Verify failed: ' + error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UNVERIFY — Undo an accepted match so analyst can re-search or pick differently
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/properties/:propertyId/unverify', authenticateToken, async (req, res) => {
  try {
    const { submissionId, propertyId } = req.params;
    if (!await canEditDeal(req, submissionId)) return res.status(403).json({ error: 'Access denied' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `UPDATE deal_properties
       SET property_verified_at = NULL, property_verified_by = NULL, updated_at = NOW()
       WHERE id = $1 AND deal_id = $2
       RETURNING id, address`,
      [propertyId, dealResult.rows[0].id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });

    await logAudit(dealResult.rows[0].id, 'property_unverified', null, result.rows[0].address,
      { propertyId }, req.user.userId);

    res.json({ success: true, property: result.rows[0] });
  } catch (error) {
    console.error('[property-unverify] Error:', error);
    res.status(500).json({ error: 'Unverify failed: ' + error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SELECT EPC — Analyst manually picks an EPC from the alternative_matches list
//  (used when auto-match was ambiguous or none)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/properties/:propertyId/select-epc', authenticateToken, async (req, res) => {
  try {
    const { submissionId, propertyId } = req.params;
    const { lmk_key } = req.body;
    if (!lmk_key) return res.status(400).json({ error: 'lmk_key required' });
    if (!await canEditDeal(req, submissionId)) return res.status(403).json({ error: 'Access denied' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    // Read the property's saved property_search_data to find the selected EPC row
    const propResult = await pool.query(
      `SELECT property_search_data FROM deal_properties WHERE id = $1 AND deal_id = $2`,
      [propertyId, dealResult.rows[0].id]
    );
    if (propResult.rows.length === 0) return res.status(404).json({ error: 'Property not found' });

    const searchData = propResult.rows[0].property_search_data || {};
    const epcBlock = searchData.epc || {};
    const pool_of_epcs = [epcBlock.data, ...(epcBlock.alternative_matches || [])].filter(Boolean);
    const picked = pool_of_epcs.find(e => e && e.lmk_key === lmk_key);

    if (!picked) {
      return res.status(400).json({
        error: 'Selected EPC not found in this property\'s search results. Try Re-Search first.',
        available_keys: pool_of_epcs.map(e => e.lmk_key).filter(Boolean)
      });
    }

    // Write the chosen EPC's fields over the property, and record which lmk_key was selected
    await pool.query(
      `UPDATE deal_properties SET
         epc_rating = $1, epc_score = $2, epc_potential_rating = $3, epc_floor_area = $4,
         epc_property_type = $5, epc_built_form = $6, epc_construction_age = $7,
         epc_habitable_rooms = $8, epc_inspection_date = $9, epc_certificate_id = $10,
         epc_selected_lmk_key = $10, updated_at = NOW()
       WHERE id = $11 AND deal_id = $12`,
      [picked.epc_rating || null, picked.epc_score || null, picked.potential_rating || null,
       picked.floor_area || null, picked.property_type || null, picked.built_form || null,
       picked.construction_age || null, picked.number_habitable_rooms || null,
       picked.inspection_date || null, picked.lmk_key,
       propertyId, dealResult.rows[0].id]
    );

    await logAudit(dealResult.rows[0].id, 'epc_manually_selected', null, picked.address,
      { propertyId, lmk_key, epc_rating: picked.epc_rating }, req.user.userId);

    res.json({ success: true, selected: picked });
  } catch (error) {
    console.error('[select-epc] Error:', error);
    res.status(500).json({ error: 'Select EPC failed: ' + error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CHIMNIE PROPERTY INTELLIGENCE LOOKUP (2026-04-21)
//  Pulls the full Chimnie dossier for a property (AVM + comps + flood + crime
//  + ownership + construction + rental + rebuild cost). Internal users only —
//  broker doesn't trigger paid API calls. Monthly credit cap stops runaway spend.
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:submissionId/properties/:propertyId/chimnie-lookup', authenticateToken, async (req, res) => {
  try {
    const { submissionId, propertyId } = req.params;
    const { method } = req.body || {};  // optional: 'address' (default) or 'uprn'

    // Internal users only — this is a paid call, brokers can't trigger.
    if (!config.INTERNAL_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Chimnie lookup is available to internal users only' });
    }

    // Resolve deal + property
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const propResult = await pool.query(
      `SELECT id, address, postcode, chimnie_uprn, chimnie_fetched_at
         FROM deal_properties WHERE id = $1 AND deal_id = $2`,
      [propertyId, dealId]
    );
    if (propResult.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    const prop = propResult.rows[0];

    if (!prop.address && !prop.postcode && !prop.chimnie_uprn) {
      return res.status(400).json({ error: 'Property has no address, postcode, or UPRN to look up' });
    }

    // FRESH-GATE — skip live API call if last pull was within 30 days, unless
    // force=true in body. Saves a Chimnie credit and a couple seconds of latency.
    // RM clicks "Force refresh" in the UI to override (rare — markets shift slowly).
    const freshness = require('../services/freshness');
    const force = req.body && req.body.force === true;
    if (freshness.isFresh(prop.chimnie_fetched_at, 'chimnie') && !force) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'fresh',
        message: `Chimnie data is fresh — last pulled ${freshness.ageLabel(prop.chimnie_fetched_at)} ago. Pass force:true to override.`,
        property_id: prop.id,
        deal_id: dealId,
        cached_at: prop.chimnie_fetched_at,
      });
    }

    // Monthly spend cap — sum credits used this calendar month across all deals.
    // Prevents a buggy loop or rogue frontend from draining the account balance.
    const capResult = await pool.query(`
      SELECT COALESCE(SUM(chimnie_credits_used), 0)::int AS total_this_month
      FROM deal_properties
      WHERE chimnie_fetched_at >= DATE_TRUNC('month', NOW())
    `);
    const usedThisMonth = capResult.rows[0].total_this_month || 0;
    if (usedThisMonth >= config.CHIMNIE_MONTHLY_CAP_CREDITS) {
      return res.status(429).json({
        error: `Monthly Chimnie credit cap reached (${usedThisMonth} / ${config.CHIMNIE_MONTHLY_CAP_CREDITS}). Raise CHIMNIE_MONTHLY_CAP_CREDITS env var to lift.`,
        used_this_month: usedThisMonth,
        cap: config.CHIMNIE_MONTHLY_CAP_CREDITS
      });
    }

    // Call Chimnie
    const chimnie = require('../services/chimnie');
    let result, lookupMethod;
    if (method === 'uprn' && prop.chimnie_uprn) {
      result = await chimnie.lookupByUprn(prop.chimnie_uprn);
      lookupMethod = 'uprn';
    } else {
      // Full-address lookup: concatenate address + postcode so Chimnie's
      // fuzzy matcher has both parts. If the stored address already contains
      // the postcode, this is harmless (still a valid query).
      const addressQuery = prop.postcode
        ? `${prop.address || ''}, ${prop.postcode}`.trim().replace(/^,\s*/, '')
        : (prop.address || '');
      result = await chimnie.lookupByAddress(addressQuery);
      lookupMethod = 'address';
    }

    if (!result.success) {
      // Log the failed call but don't write anything to the property row
      await logAudit(dealId, 'chimnie_lookup_failed', null, prop.address || prop.postcode,
        { propertyId, method: lookupMethod, error: result.error, status: result.status },
        req.user.userId);
      return res.status(result.status || 502).json({
        error: result.error,
        status: result.status
      });
    }

    // Extract flat fields for indexed columns
    const flat = chimnie.extractFlatFields(result.data);

    // 2026-04-21: compute PTAL (London only) from Chimnie's lat/lng. Free local
    // lookup against TfL's 2015 PTAL grid — no external call, no cost, <1ms.
    // Verified path via live payload inspection: lat/lng live at
    // property.attributes.status.{latitude,longitude}, NOT at property.attributes.
    try {
      const ptalService = require('../services/ptal');
      const chimnieGet = require('../services/chimnie')._get;
      const lat = chimnieGet(result.data, 'property.attributes.status.latitude')
               ?? chimnieGet(result.data, 'property.attributes.latitude');  // fallback if schema shifts
      const lng = chimnieGet(result.data, 'property.attributes.status.longitude')
               ?? chimnieGet(result.data, 'property.attributes.longitude');
      if (lat != null && lng != null) {
        const ptalResult = ptalService.getPtalForLatLng(Number(lat), Number(lng));
        if (ptalResult && ptalResult.in_london && ptalResult.ptal) {
          flat.chimnie_ptal = ptalResult.ptal;
          console.log(`[ptal] ${prop.postcode || prop.address} → PTAL ${ptalResult.ptal} (${ptalResult.distance_m}m to nearest grid cell)`);
        } else {
          flat.chimnie_ptal = null;  // non-London or no grid match
          if (ptalResult && !ptalResult.in_london) {
            console.log(`[ptal] ${prop.postcode || prop.address} → outside London bbox (lat ${lat}, lng ${lng})`);
          }
        }
      } else {
        console.warn(`[ptal] No lat/lng in Chimnie payload for ${prop.postcode || prop.address}`);
      }
    } catch (ptalErr) {
      // Non-fatal — log and continue. Chimnie data still lands.
      console.warn('[ptal] Lookup failed (non-fatal):', ptalErr.message);
    }

    // Build UPDATE statement.
    // ⚠ JSONB encoding fix (2026-04-29): some flat fields are arrays
    // (chimnie_listing_image_urls, chimnie_floorplan_image_urls) targeting
    // JSONB columns. node-postgres serialises JS arrays as Postgres text
    // array literals ({a,b,c}) by default — that's not valid JSON, so
    // Postgres rejects with "invalid input syntax for type json". Force
    // stringification for any array/object value before binding. Scalars
    // (string/number/bool/null/undefined) pass through unchanged.
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [col, val] of Object.entries(flat)) {
      sets.push(`${col} = $${i}`);
      const isArrayOrObject = (val !== null && typeof val === 'object');
      vals.push(isArrayOrObject ? JSON.stringify(val) : val);
      i++;
    }
    // Raw payload + audit columns
    sets.push(`chimnie_data = $${i}`); vals.push(JSON.stringify(result.data)); i++;
    sets.push(`chimnie_fetched_at = NOW()`);
    sets.push(`chimnie_fetched_by = $${i}`); vals.push(req.user.userId); i++;
    sets.push(`chimnie_lookup_method = $${i}`); vals.push(lookupMethod); i++;
    // Credit usage — Chimnie doesn't return cost in response (that we know of);
    // assume 1 credit per property lookup for now. Will tune if they expose a cost field.
    sets.push(`chimnie_credits_used = COALESCE(chimnie_credits_used, 0) + 1`);
    sets.push(`updated_at = NOW()`);
    vals.push(propertyId);

    await pool.query(
      `UPDATE deal_properties SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );

    await logAudit(dealId, 'chimnie_lookup', null, prop.address || prop.postcode,
      {
        propertyId, method: lookupMethod,
        exact_match: flat.chimnie_exact_match,
        avm_mid: flat.chimnie_avm_mid,
        avm_confidence: flat.chimnie_avm_confidence
      },
      req.user.userId);

    // Return the flat extracted fields + a small marker that the JSONB blob landed.
    // Don't send the full 300-field payload back — let the frontend fetch only
    // what it needs via GET /deals/:id (matrix already refreshes from there).
    res.json({
      success: true,
      method: lookupMethod,
      flat,
      raw_size_bytes: JSON.stringify(result.data).length,
      credits_used_this_month: usedThisMonth + 1,
      credits_cap: config.CHIMNIE_MONTHLY_CAP_CREDITS
    });

  } catch (error) {
    console.error('[chimnie-lookup] Error:', error);
    res.status(500).json({ error: 'Chimnie lookup failed: ' + error.message });
  }
});

module.exports = router;
