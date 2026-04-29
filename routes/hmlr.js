/**
 * routes/hmlr.js — HM Land Registry Business Gateway admin endpoints
 * ============================================================
 * All routes are ADMIN-ONLY (Sumit's directive 2026-04-27).
 *
 *  GET  /api/admin/hmlr/status                       — Check mode + creds (no network)
 *  POST /api/admin/hmlr/search                       — Search title by postcode/house
 *  POST /api/admin/hmlr/pull/:propertyId             — Pull OC1 + persist on deal_properties
 *  GET  /api/admin/hmlr/property/:propertyId         — Read latest stored HMLR data
 *
 * The pull route is the workhorse: it calls services/hmlr.js, flattens the
 * response into the hmlr_* columns we added in db/migrations.js, and stamps
 * who/when/cost/mode for audit. Mock mode never touches the network and
 * never charges — safe to enable on production from day one.
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const hmlr = require('../services/hmlr');
const freshness = require('../services/freshness');
const pool = require('../db/pool');

// All routes require auth + admin role
router.use(authenticateToken);
router.use(authenticateAdmin);

// ─── Status check (no network call) ────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const status = hmlr.getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[hmlr/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Search title by postcode (discovery) ──────────────────────────────────────
router.post('/search', async (req, res) => {
  try {
    const { postcode, houseNumber } = req.body || {};
    if (!postcode) {
      return res.status(400).json({ error: 'postcode required in body' });
    }
    const result = await hmlr.searchTitleByAddress({ postcode, houseNumber });
    if (!result.success) {
      return res.status(result.status === 404 ? 404 : 502).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[hmlr/search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Pull OC1 and persist (the chargeable one) ────────────────────────────────
router.post('/pull/:propertyId', async (req, res) => {
  const { propertyId } = req.params;
  const { titleNumber, address, force } = req.body || {};

  if (!propertyId || !/^\d+$/.test(propertyId)) {
    return res.status(400).json({ error: 'valid numeric propertyId required in URL' });
  }
  if (!titleNumber) {
    return res.status(400).json({ error: 'titleNumber required in body' });
  }

  try {
    // 1. Verify the property exists before charging
    const propLookup = await pool.query(
      `SELECT id, deal_id, address,
              hmlr_pulled_at, hmlr_title_number, hmlr_pulled_cost_pence
         FROM deal_properties WHERE id = $1`,
      [parseInt(propertyId, 10)]
    );
    if (propLookup.rowCount === 0) {
      return res.status(404).json({ error: `Property ${propertyId} not found` });
    }
    const property = propLookup.rows[0];

    // 2. FRESH-GATE — HMLR rule: any prior pull blocks re-pull unless force=true.
    // The frontend's confirm dialog passes { force: true } after RM acknowledges
    // the £3 charge. Without force, skip silently and return cached metadata.
    if (freshness.isFresh(property.hmlr_pulled_at, 'hmlr') && !force) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'fresh',
        message: `HMLR title already pulled — last fired ${freshness.ageLabel(property.hmlr_pulled_at)} ago. Re-pull requires explicit confirm (£3).`,
        property_id: property.id,
        deal_id: property.deal_id,
        cached: {
          title_number:    property.hmlr_title_number,
          last_pulled_at:  property.hmlr_pulled_at,
          last_cost_pence: property.hmlr_pulled_cost_pence,
        },
      });
    }

    // 3. Call HMLR (mock/test/live based on HMLR_MODE)
    const result = await hmlr.getOfficialCopy({
      titleNumber,
      address: address || property.address,
    });

    // 3a. Audit row — every fired call lands in hmlr_lookups for £-spend
    // reconciliation. Append-only, regardless of success/failure.
    try {
      await pool.query(
        `INSERT INTO hmlr_lookups
           (deal_id, property_id, lookup_type, title_number,
            result_jsonb, mode, cost_pence, requested_by, pull_error)
         VALUES ($1, $2, 'official_copy', $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          property.deal_id,
          property.id,
          titleNumber,
          result.success ? JSON.stringify(result.data || {}) : null,
          result.mode,
          result.cost_pence || 0,
          req.user.id || null,
          result.success ? null : (result.error || 'unknown'),
        ]
      );
    } catch (auditErr) {
      // Don't fail the user-facing call if audit write fails — log it.
      console.error('[hmlr/pull] audit write failed:', auditErr.message);
    }

    // 3. Always persist the outcome — success OR failure — for audit trail
    if (result.success) {
      const flat = hmlr.extractFlatFields(result.data);
      await pool.query(
        `UPDATE deal_properties
            SET hmlr_title_number       = $1,
                hmlr_register_pdf_url   = $2,
                hmlr_register_raw_jsonb = $3::jsonb,
                hmlr_proprietors_jsonb  = $4::jsonb,
                hmlr_charges_jsonb      = $5::jsonb,
                hmlr_restrictions_jsonb = $6::jsonb,
                hmlr_tenure             = $7,
                hmlr_class_of_title     = $8,
                hmlr_pulled_at          = NOW(),
                hmlr_pulled_cost_pence  = $9,
                hmlr_pull_mode          = $10,
                hmlr_pull_error         = NULL,
                hmlr_pulled_by          = $11
          WHERE id = $12`,
        [
          flat.hmlr_title_number,
          flat.hmlr_register_pdf_url,
          JSON.stringify(flat.hmlr_register_raw_jsonb),
          flat.hmlr_proprietors_jsonb ? JSON.stringify(flat.hmlr_proprietors_jsonb) : null,
          flat.hmlr_charges_jsonb ? JSON.stringify(flat.hmlr_charges_jsonb) : null,
          flat.hmlr_restrictions_jsonb ? JSON.stringify(flat.hmlr_restrictions_jsonb) : null,
          flat.hmlr_tenure,
          flat.hmlr_class_of_title,
          result.cost_pence,
          result.mode,
          req.user.id || null,
          property.id,
        ]
      );
    } else {
      // Failure: stamp the error but DON'T overwrite a previous successful pull
      await pool.query(
        `UPDATE deal_properties
            SET hmlr_pull_error    = $1,
                hmlr_pull_mode     = $2,
                hmlr_pulled_at     = NOW(),
                hmlr_pulled_by     = $3
          WHERE id = $4`,
        [result.error, result.mode, req.user.id || null, property.id]
      );
    }

    res.status(result.success ? 200 : 502).json({
      ...result,
      property_id: property.id,
      deal_id: property.deal_id,
    });
  } catch (err) {
    console.error('[hmlr/pull] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Read latest stored HMLR data for a property ──────────────────────────────
router.get('/property/:propertyId', async (req, res) => {
  const { propertyId } = req.params;
  if (!propertyId || !/^\d+$/.test(propertyId)) {
    return res.status(400).json({ error: 'valid numeric propertyId required' });
  }
  try {
    const r = await pool.query(
      `SELECT id, deal_id, address,
              hmlr_title_number, hmlr_register_pdf_url, hmlr_proprietors_jsonb,
              hmlr_charges_jsonb, hmlr_restrictions_jsonb, hmlr_tenure,
              hmlr_class_of_title, hmlr_pulled_at, hmlr_pulled_cost_pence,
              hmlr_pull_mode, hmlr_pull_error, hmlr_pulled_by
         FROM deal_properties
        WHERE id = $1`,
      [parseInt(propertyId, 10)]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: `Property ${propertyId} not found` });
    }
    res.json({ success: true, property: r.rows[0] });
  } catch (err) {
    console.error('[hmlr/property] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
