/**
 * Pricing Routes — PRICE-3 (2026-04-29)
 *
 * Single endpoint for v1: read-only preview that returns the full pricing
 * envelope for a deal at its latest risk grade.
 *
 *   POST /api/admin/pricing/preview/:dealId
 *     Body (all optional): {
 *       sector,             // override matrix-derived sector
 *       mode,               // 'warehouse' | 'whole_loan'  (default 'warehouse')
 *       channel,            // 'broker' | 'direct'         (default 'broker')
 *       stress_flagged,     // boolean — uses stressed rate ceiling if TRUE
 *       stress_reason,      // free-form audit string
 *       book_size_pence,    // overrides expected_avg_book_pence for concentration
 *     }
 *     Returns: { ok: true, envelope: {...} }
 *
 *  No DB writes — pure preview. Persistence to deal_pricings is PRICE-9
 *  (admin can later "save this pricing" to commit a row for audit).
 *
 *  Surface assumption: the deal already has at least one settled risk_view
 *  row for v3.1 (final_pd, final_lgd, final_ia all NOT NULL). If not,
 *  returns 422 with a guidance message.
 *
 *  ARCHITECTURE: auth = data collector + compute. The PRICING decision
 *  (apply / override / decline) stays with credit + IC. Engine is a coach,
 *  not a gate. See feedback_auth_is_data_collector_not_decider.md
 */

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const pricingEngine = require('../services/pricing-engine');

// ─── Auth gate: internal staff only ──────────────────────────────────────
function authenticateInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!config.INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Internal staff access required' });
  }
  next();
}

// ─── Sector inference from deal_submissions.asset_type ────────────────────
// Falls back to 'commercial' if asset_type missing — admin can override via
// request body. Mapping uses the 6 sectors seeded in risk_taxonomy tax_v1.
function inferSectorFromAssetType(assetType) {
  if (!assetType) return null;
  const a = String(assetType).toLowerCase();
  if (a.includes('hospitality') || a.includes('hotel') || a.includes('serviced')) return 'hospitality';
  if (a.includes('mixed')) return 'mixed_use';
  if (a.includes('land')) return 'land_planning';
  if (a.includes('btl') || a.includes('buy-to-let') || a.includes('hmo')) return 'resi_btl';
  if (a.includes('residential') || a === 'resi') return 'resi_bridging';
  if (a.includes('commercial') || a.includes('office') || a.includes('retail') || a.includes('industrial')) return 'commercial';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/preview/:dealId
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/preview/:dealId',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId must be a positive integer' });
    }

    try {
      // 1. Load deal essentials
      const dealRow = (await pool.query(
        `SELECT id, loan_amount, term_months, asset_type
           FROM deal_submissions
          WHERE id = $1`,
        [dealId]
      )).rows[0];

      if (!dealRow) {
        return res.status(404).json({ ok: false, error: `deal ${dealId} not found` });
      }

      // 2. Load latest settled risk_view row with v3.1 grades
      const riskRow = (await pool.query(
        `SELECT id, final_pd, final_lgd, final_ia, taxonomy_version, data_stage, parsed_grades
           FROM risk_view
          WHERE deal_id = $1
            AND final_pd IS NOT NULL
            AND final_lgd IS NOT NULL
            AND final_ia IS NOT NULL
          ORDER BY id DESC
          LIMIT 1`,
        [dealId]
      )).rows[0];

      if (!riskRow) {
        return res.status(422).json({
          ok: false,
          error: `deal ${dealId} has no settled v3.1 risk run (need PD/LGD/IA grades). Run risk analysis first.`,
        });
      }

      // 3. Resolve sector — explicit override OR infer from matrix
      const overrideSector = req.body?.sector || null;
      const inferredSector = inferSectorFromAssetType(dealRow.asset_type);
      const sector = overrideSector || inferredSector || 'commercial';

      // 4. Validate loan + term
      const loan_amount_pence = Math.round(Number(dealRow.loan_amount || 0) * 100);
      const term_months = Number(dealRow.term_months || 0);

      if (loan_amount_pence <= 0) {
        return res.status(422).json({
          ok: false,
          error: `deal ${dealId} has no loan_amount on the matrix — cannot price`,
        });
      }
      if (!term_months || term_months <= 0) {
        return res.status(422).json({
          ok: false,
          error: `deal ${dealId} has no term_months on the matrix — cannot price`,
        });
      }

      // 5. Build engine input
      const engineInput = {
        deal_id: dealId,
        risk_view_id: riskRow.id,
        loan_amount_pence,
        term_months,
        sector,
        pd: riskRow.final_pd,
        lgd: riskRow.final_lgd,
        ia: riskRow.final_ia,
        mode: req.body?.mode || 'warehouse',
        channel: req.body?.channel || undefined,
        stress_flagged: !!req.body?.stress_flagged,
        stress_reason: req.body?.stress_reason || null,
        book_size_pence: req.body?.book_size_pence || null,
      };

      // 6. Run the engine
      const envelope = await pricingEngine.priceDeal(engineInput);

      // 7. Attach context the UI panel will want
      envelope.context = {
        deal_id: dealId,
        risk_view_id: riskRow.id,
        risk_data_stage: riskRow.data_stage,
        taxonomy_version: riskRow.taxonomy_version,
        asset_type: dealRow.asset_type,
        sector_inferred_from: overrideSector ? 'request_body' : (inferredSector ? 'asset_type' : 'fallback_commercial'),
      };

      return res.json({ ok: true, envelope });
    } catch (err) {
      console.error(`[pricing/preview ${dealId}] error:`, err);
      return res.status(500).json({
        ok: false,
        error: err.message || 'Pricing engine failed',
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/pricing/active-config
//  ─────────────────────────────────────────────────────────────────────────
//  Returns the active pricing config (versions + assumptions + IA modifiers).
//  Used by the admin UI (PRICE-4..7) to bootstrap the assumptions/grid editors.
//  Grid cells aren't loaded eagerly — UI fetches per (sector, pd, lgd) on demand.
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/pricing/active-config',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    try {
      const config = await pricingEngine.loadActivePricingConfig();
      return res.json({ ok: true, config });
    } catch (err) {
      console.error('[pricing/active-config] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
