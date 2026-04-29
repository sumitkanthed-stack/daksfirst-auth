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

module.exports = router;
