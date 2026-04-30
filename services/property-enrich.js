/**
 * services/property-enrich.js — Auto-enrichment helpers for deal_properties
 * ════════════════════════════════════════════════════════════════════════════
 * Extracted from routes/properties.js (2026-04-30) so multiple entry paths
 * can share the same enrichment logic:
 *   - routes/properties.js POST + PUT (broker matrix entry)
 *   - routes/quick-quote.js convert-to-deal (broker QQ flow)
 *   - services/claude-parser.js (file-drop pipeline, free APIs only)
 *
 * Two tiers:
 *   autoEnrichProperty  — postcode + EPC (FREE government APIs)
 *   autoEnrichChimnie   — Chimnie property intelligence (LOW-cost paid,
 *                          freshness-gated + monthly-cap-protected)
 *
 * Land Registry Price Paid (£3/property) is RM-only — gated separately
 * via INTERNAL_ROLES on /search and /search-all endpoints.
 */

const pool = require('../db/pool');
const config = require('../config');
const { logAudit } = require('./audit');

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-ENRICH FREE: Postcodes.io + EPC (best-effort, swallows errors)
// ═══════════════════════════════════════════════════════════════════════════
async function autoEnrichProperty(dealId, propertyId, userId) {
  try {
    const propResult = await pool.query(
      `SELECT id, address, postcode FROM deal_properties WHERE id = $1 AND deal_id = $2`,
      [propertyId, dealId]
    );
    if (propResult.rows.length === 0) return;
    const prop = propResult.rows[0];
    if (!prop.postcode && !prop.address) return;

    const { lookupPostcode, lookupEPC } = require('./property-search');
    const [postcodeResult, epcResult] = await Promise.all([
      lookupPostcode(prop.postcode),
      lookupEPC(prop.postcode, prop.address),
    ]);
    const results = {
      searched_at: new Date().toISOString(),
      postcode_lookup: postcodeResult,
      epc: epcResult,
      price_paid: { success: false, skipped: true, reason: 'rm_only_paid' },
      auto_enrich: true,
    };

    const updates = [];
    const values = [];
    let idx = 1;

    if (results.postcode_lookup && results.postcode_lookup.success) {
      const pc = results.postcode_lookup.data;
      for (const [col, val] of [
        ['region', pc.region], ['country', pc.country], ['local_authority', pc.admin_district],
        ['admin_ward', pc.admin_ward], ['latitude', pc.latitude], ['longitude', pc.longitude],
        ['in_england_or_wales', pc.in_england_or_wales]
      ]) {
        if (val !== null && val !== undefined) {
          updates.push(`${col} = $${idx}`); values.push(val); idx++;
        }
      }
    }

    const epcExact = results.epc && results.epc.success && results.epc.match_confidence === 'exact' && results.epc.data;
    if (epcExact) {
      const e = results.epc.data;
      for (const [col, val] of [
        ['epc_rating', e.epc_rating], ['epc_score', e.epc_score],
        ['epc_potential_rating', e.potential_rating], ['epc_floor_area', e.floor_area],
        ['epc_property_type', e.property_type], ['epc_built_form', e.built_form],
        ['epc_construction_age', e.construction_age], ['epc_habitable_rooms', e.number_habitable_rooms],
        ['epc_inspection_date', e.inspection_date], ['epc_certificate_id', e.lmk_key]
      ]) {
        if (val !== null && val !== undefined) {
          updates.push(`${col} = $${idx}`); values.push(val); idx++;
        }
      }
    }

    updates.push(`property_search_data = $${idx}`); values.push(JSON.stringify(results)); idx++;
    updates.push(`property_searched_at = NOW()`);
    if (userId != null) {
      updates.push(`property_searched_by = $${idx}`); values.push(userId); idx++;
    }
    updates.push(`updated_at = NOW()`);
    values.push(propertyId);

    if (updates.length > 0) {
      await pool.query(
        `UPDATE deal_properties SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }
    console.log(`[property-enrich] FREE auto-enriched property ${propertyId}: postcode=${!!(results.postcode_lookup && results.postcode_lookup.success)}, epc=${results.epc && results.epc.success ? results.epc.match_confidence : 'failed'}`);
  } catch (err) {
    console.warn(`[property-enrich] FREE auto-enrich failed for property ${propertyId}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-ENRICH CHIMNIE: low-cost paid touchpoint
//  - 30-day freshness gate skips redundant calls
//  - Monthly credit cap (CHIMNIE_MONTHLY_CAP_CREDITS) hard-stops runaway cost
//  - 1 credit per property × cap = bounded budget
// ═══════════════════════════════════════════════════════════════════════════
async function autoEnrichChimnie(dealId, propertyId, userId) {
  try {
    const propResult = await pool.query(
      `SELECT id, address, postcode, chimnie_uprn, chimnie_fetched_at
         FROM deal_properties WHERE id = $1 AND deal_id = $2`,
      [propertyId, dealId]
    );
    if (propResult.rows.length === 0) return;
    const prop = propResult.rows[0];
    if (!prop.address && !prop.postcode && !prop.chimnie_uprn) return;

    const freshness = require('./freshness');
    if (freshness.isFresh(prop.chimnie_fetched_at, 'chimnie')) {
      console.log(`[chimnie auto] property ${propertyId} fresh — skipping (last ${freshness.ageLabel(prop.chimnie_fetched_at)} ago)`);
      return;
    }

    const capResult = await pool.query(
      `SELECT COALESCE(SUM(chimnie_credits_used), 0)::int AS total_this_month
         FROM deal_properties
         WHERE chimnie_fetched_at >= DATE_TRUNC('month', NOW())`
    );
    const usedThisMonth = capResult.rows[0].total_this_month || 0;
    if (usedThisMonth >= config.CHIMNIE_MONTHLY_CAP_CREDITS) {
      console.warn(`[chimnie auto] monthly cap reached (${usedThisMonth}/${config.CHIMNIE_MONTHLY_CAP_CREDITS}) — skipping property ${propertyId}`);
      return;
    }

    const chimnie = require('./chimnie');
    let result, lookupMethod;
    if (prop.chimnie_uprn) {
      result = await chimnie.lookupByUprn(prop.chimnie_uprn);
      lookupMethod = 'uprn';
    } else {
      const addressQuery = prop.postcode
        ? `${prop.address || ''}, ${prop.postcode}`.trim().replace(/^,\s*/, '')
        : (prop.address || '');
      result = await chimnie.lookupByAddress(addressQuery);
      lookupMethod = 'address';
    }

    if (!result.success) {
      await logAudit(dealId, 'chimnie_lookup_failed', null, prop.address || prop.postcode,
        { propertyId, method: lookupMethod, error: result.error, status: result.status, source: 'auto' },
        userId);
      console.warn(`[chimnie auto] property ${propertyId} lookup failed: ${result.error}`);
      return;
    }

    const flat = chimnie.extractFlatFields(result.data);

    try {
      const ptalService = require('./ptal');
      const chimnieGet = chimnie._get;
      const lat = chimnieGet(result.data, 'property.attributes.status.latitude')
               ?? chimnieGet(result.data, 'property.attributes.latitude');
      const lng = chimnieGet(result.data, 'property.attributes.status.longitude')
               ?? chimnieGet(result.data, 'property.attributes.longitude');
      if (lat != null && lng != null) {
        const ptalResult = ptalService.getPtalForLatLng(Number(lat), Number(lng));
        if (ptalResult && ptalResult.in_london && ptalResult.ptal) {
          flat.chimnie_ptal = ptalResult.ptal;
        } else {
          flat.chimnie_ptal = null;
        }
      }
    } catch (ptalErr) {
      console.warn('[chimnie auto] PTAL lookup failed (non-fatal):', ptalErr.message);
    }

    const sets = [];
    const vals = [];
    let i = 1;
    for (const [col, val] of Object.entries(flat)) {
      sets.push(`${col} = $${i}`);
      const isArrayOrObject = (val !== null && typeof val === 'object');
      vals.push(isArrayOrObject ? JSON.stringify(val) : val);
      i++;
    }
    sets.push(`chimnie_data = $${i}`); vals.push(JSON.stringify(result.data)); i++;
    sets.push(`chimnie_fetched_at = NOW()`);
    if (userId != null) {
      sets.push(`chimnie_fetched_by = $${i}`); vals.push(userId); i++;
    }
    sets.push(`chimnie_lookup_method = $${i}`); vals.push(lookupMethod); i++;
    sets.push(`chimnie_credits_used = COALESCE(chimnie_credits_used, 0) + 1`);
    sets.push(`updated_at = NOW()`);
    vals.push(propertyId);

    await pool.query(
      `UPDATE deal_properties SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );

    await logAudit(dealId, 'chimnie_lookup', null, prop.address || prop.postcode,
      {
        propertyId, method: lookupMethod, source: 'auto',
        exact_match: flat.chimnie_exact_match,
        avm_mid: flat.chimnie_avm_mid,
        avm_confidence: flat.chimnie_avm_confidence
      },
      userId);

    console.log(`[chimnie auto] property ${propertyId} enriched — method=${lookupMethod}, exact=${flat.chimnie_exact_match}, avm_mid=${flat.chimnie_avm_mid}`);
  } catch (err) {
    console.warn(`[chimnie auto] property ${propertyId} unexpected error:`, err.message);
  }
}

module.exports = { autoEnrichProperty, autoEnrichChimnie };
