/**
 * Property routes — Royal Mail PAF address lookup · PROP-2 (2026-04-29)
 *
 * Endpoints:
 *   GET  /api/admin/property/postcode-lookup?postcode=W6%209RH
 *   GET  /api/admin/property/autocomplete?q=129%20Rann
 *   POST /api/admin/property/select-address
 *        body: { property_id, deal_id?, udprn }
 *        Resolves UDPRN to full PAF address, stores on deal_properties,
 *        appends to paf_lookups history. Returns the verified address.
 *
 * All routes admin-only via authenticateToken + authenticateInternal.
 *
 * Mode flag (env ADDRESS_LOOKUP_MODE): mock | test | live. Service handles
 * the dispatch — routes just orchestrate.
 */

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const addressLookup = require('../services/address-lookup');
const propertyData = require('../services/property-data');

function authenticateInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!config.INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Internal staff access required' });
  }
  next();
}

/**
 * Persist a paf_lookups audit row. Best-effort; failures don't block the route.
 */
async function logLookup({ deal_id, property_id, lookup_type, query_value, udprn, uprn, result_count, result_jsonb, mode, cost_pence, requested_by, pull_error }) {
  try {
    await pool.query(
      `INSERT INTO paf_lookups
         (deal_id, property_id, lookup_type, query_value, udprn, uprn,
          result_count, result_jsonb, mode, cost_pence, requested_by, pull_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
      [deal_id || null, property_id || null, lookup_type, query_value || null,
       udprn || null, uprn || null, result_count ?? null,
       result_jsonb ? JSON.stringify(result_jsonb) : null,
       mode, cost_pence || 0, requested_by || null, pull_error || null]
    );
  } catch (err) {
    console.warn('[paf-lookups log] insert failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/property/postcode-lookup
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/property/postcode-lookup',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const postcode = String(req.query.postcode || '').trim();
    if (!postcode) {
      return res.status(400).json({ ok: false, error: 'postcode query param required' });
    }
    try {
      const result = await addressLookup.searchByPostcode(postcode);
      // Audit
      logLookup({
        deal_id: req.query.deal_id ? Number(req.query.deal_id) : null,
        property_id: req.query.property_id ? Number(req.query.property_id) : null,
        lookup_type: 'postcode',
        query_value: postcode,
        result_count: result.addresses?.length || 0,
        result_jsonb: result.addresses?.length ? { count: result.addresses.length, first_udprn: result.addresses[0]?.udprn } : null,
        mode: result.mode,
        cost_pence: result.cost_pence,
        requested_by: req.user.id,
        pull_error: result.error || null,
      });
      return res.json(result);
    } catch (err) {
      console.error('[property/postcode-lookup] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/property/autocomplete
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/property/autocomplete',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ ok: true, suggestions: [], cost_pence: 0 });
    }
    try {
      const result = await addressLookup.autocomplete(q);
      return res.json(result);
    } catch (err) {
      console.error('[property/autocomplete] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/property/select-address
//  ─────────────────────────────────────────────────────────────────────────
//  Body: { property_id?, deal_id?, udprn }
//  Resolves UDPRN to full PAF address. If property_id provided, UPDATEs
//  deal_properties with paf_* columns. Returns the verified address.
//
//  Currently does NOT auto-fire downstream Chimnie/EPC/HMLR — that's an
//  RM-elected button on the property card (admin can chain manually).
//  Reason: each downstream pull costs money; one accidental click on
//  "select address" shouldn't fire 3 paid services. RMs press the
//  individual pull buttons after verifying address.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/property/select-address',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const { property_id, deal_id, udprn } = req.body || {};
    if (!udprn) {
      return res.status(400).json({ ok: false, error: 'udprn required' });
    }

    try {
      const result = await addressLookup.lookupByUDPRN(udprn);
      if (!result.ok) {
        await logLookup({
          deal_id, property_id, lookup_type: 'udprn',
          udprn, mode: result.mode, cost_pence: 0,
          requested_by: req.user.id, pull_error: result.error,
        });
        return res.status(502).json({ ok: false, error: result.error || 'PAF lookup failed' });
      }

      const addr = result.address;
      // Persist on deal_properties if property_id provided
      if (property_id) {
        await pool.query(
          `UPDATE deal_properties
              SET paf_uprn = $1,
                  paf_udprn = $2,
                  paf_address_jsonb = $3::jsonb,
                  paf_pulled_at = NOW(),
                  paf_pull_mode = $4
            WHERE id = $5`,
          [addr.uprn || null, addr.udprn || null,
           JSON.stringify(addr), result.mode, property_id]
        );
      }

      await logLookup({
        deal_id, property_id, lookup_type: 'udprn',
        udprn, uprn: addr.uprn, result_count: 1,
        result_jsonb: addr, mode: result.mode,
        cost_pence: result.cost_pence, requested_by: req.user.id,
      });

      return res.json({
        ok: true,
        mode: result.mode,
        address: addr,
        cost_pence: result.cost_pence,
        persisted: !!property_id,
      });
    } catch (err) {
      console.error('[property/select-address] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/property/property-data-pull/:propertyId   (PD-2)
//  ─────────────────────────────────────────────────────────────────────────
//  Pulls postcode rental data + yield from PropertyData. Uses property's
//  postcode + bedrooms (if set on chimnie_bedrooms or notes). Persists to
//  deal_properties pd_* columns + audit row in pd_lookups.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/property/property-data-pull/:propertyId',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid propertyId' });
    }

    try {
      const propRow = (await pool.query(
        `SELECT id, deal_id, postcode, paf_address_jsonb, chimnie_bedrooms, market_value
           FROM deal_properties WHERE id = $1`,
        [propertyId]
      )).rows[0];
      if (!propRow) return res.status(404).json({ ok: false, error: `property ${propertyId} not found` });

      const postcode = propRow.postcode || propRow.paf_address_jsonb?.postcode;
      if (!postcode) {
        return res.status(422).json({ ok: false, error: 'property has no postcode — add address first' });
      }
      const beds = propRow.chimnie_bedrooms || req.body?.beds || null;

      const result = await propertyData.getRentalsByPostcode(postcode, beds);
      if (!result.ok) {
        await pool.query(
          `INSERT INTO pd_lookups (deal_id, property_id, lookup_type, postcode, beds_filter, mode, cost_pence, requested_by, pull_error)
           VALUES ($1, $2, 'rents', $3, $4, $5, 0, $6, $7)`,
          [propRow.deal_id, propertyId, postcode, beds, result.mode, req.user.id, result.error || 'unknown']
        ).catch(() => {});
        return res.status(502).json({ ok: false, error: result.error || 'PropertyData lookup failed' });
      }

      // Compute yield against actual property value if available
      let yieldGross = result.yield_gross_pct;
      if (!yieldGross && propRow.market_value && result.achieved_pcm?.avg) {
        yieldGross = Number(((result.achieved_pcm.avg * 12 / Number(propRow.market_value)) * 100).toFixed(2));
      }

      // Persist to deal_properties
      await pool.query(
        `UPDATE deal_properties
            SET pd_rental_pcm_asking_avg = $1,
                pd_rental_pcm_asking_min = $2,
                pd_rental_pcm_asking_max = $3,
                pd_rental_pcm_achieved_avg = $4,
                pd_rental_pcm_achieved_min = $5,
                pd_rental_pcm_achieved_max = $6,
                pd_rental_yield_gross_pct = $7,
                pd_sample_size = $8,
                pd_beds_filter = $9,
                pd_pulled_at = NOW(),
                pd_pull_mode = $10,
                pd_raw_jsonb = $11::jsonb
          WHERE id = $12`,
        [
          result.asking_pcm?.avg, result.asking_pcm?.min, result.asking_pcm?.max,
          result.achieved_pcm?.avg, result.achieved_pcm?.min, result.achieved_pcm?.max,
          yieldGross,
          result.asking_pcm?.sample,
          beds,
          result.mode,
          result.raw ? JSON.stringify(result.raw) : null,
          propertyId,
        ]
      );

      // Audit
      await pool.query(
        `INSERT INTO pd_lookups (deal_id, property_id, lookup_type, postcode, beds_filter, result_jsonb, mode, cost_pence, requested_by)
         VALUES ($1, $2, 'rents', $3, $4, $5::jsonb, $6, $7, $8)`,
        [propRow.deal_id, propertyId, postcode, beds, JSON.stringify(result), result.mode, result.cost_pence, req.user.id]
      ).catch(() => {});

      return res.json({
        ok: true,
        mode: result.mode,
        postcode,
        beds,
        asking_pcm: result.asking_pcm,
        achieved_pcm: result.achieved_pcm,
        yield_gross_pct: yieldGross,
        cost_pence: result.cost_pence,
      });
    } catch (err) {
      console.error('[property/property-data-pull] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
