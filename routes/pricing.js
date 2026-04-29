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
      const built = await buildEnvelopeForDeal(dealId, req.body || {});
      if (built.error) return res.status(built.error.status).json({ ok: false, error: built.error.message });
      return res.json({ ok: true, envelope: built.envelope });
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

// ─── Internal helper: shared body of preview + save ──────────────────────
async function buildEnvelopeForDeal(dealId, body) {
  const dealRow = (await pool.query(
    `SELECT id, loan_amount, term_months, asset_type
       FROM deal_submissions WHERE id = $1`,
    [dealId]
  )).rows[0];
  if (!dealRow) {
    return { error: { status: 404, message: `deal ${dealId} not found` } };
  }

  const riskRow = (await pool.query(
    `SELECT id, final_pd, final_lgd, final_ia, taxonomy_version, data_stage
       FROM risk_view
      WHERE deal_id = $1
        AND final_pd IS NOT NULL AND final_lgd IS NOT NULL AND final_ia IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [dealId]
  )).rows[0];
  if (!riskRow) {
    return { error: { status: 422, message: `deal ${dealId} has no settled v3.1 risk run (need PD/LGD/IA grades). Run risk analysis first.` } };
  }

  const overrideSector = body?.sector || null;
  const inferredSector = inferSectorFromAssetType(dealRow.asset_type);
  const sector = overrideSector || inferredSector || 'commercial';

  const loan_amount_pence = Math.round(Number(dealRow.loan_amount || 0) * 100);
  const term_months = Number(dealRow.term_months || 0);
  if (loan_amount_pence <= 0) return { error: { status: 422, message: `deal ${dealId} has no loan_amount on the matrix — cannot price` } };
  if (!term_months || term_months <= 0) return { error: { status: 422, message: `deal ${dealId} has no term_months on the matrix — cannot price` } };

  const engineInput = {
    deal_id: dealId,
    risk_view_id: riskRow.id,
    loan_amount_pence,
    term_months,
    sector,
    pd: riskRow.final_pd,
    lgd: riskRow.final_lgd,
    ia: riskRow.final_ia,
    mode: body?.mode || 'warehouse',
    channel: body?.channel || undefined,
    stress_flagged: !!body?.stress_flagged,
    stress_reason: body?.stress_reason || null,
    book_size_pence: body?.book_size_pence || null,
  };

  const envelope = await pricingEngine.priceDeal(engineInput);
  envelope.context = {
    deal_id: dealId,
    risk_view_id: riskRow.id,
    risk_data_stage: riskRow.data_stage,
    taxonomy_version: riskRow.taxonomy_version,
    asset_type: dealRow.asset_type,
    sector_inferred_from: overrideSector ? 'request_body' : (inferredSector ? 'asset_type' : 'fallback_commercial'),
  };
  return { envelope, riskRow, dealRow };
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/save/:dealId   (PRICE-9)
//  ─────────────────────────────────────────────────────────────────────────
//  Runs the engine and INSERTS the envelope as an audit row in deal_pricings.
//  Append-only — every save creates a new row, never mutates. The row pins
//  to the THREE active config versions + the risk_view row that drove the
//  grade, so any historical recommendation can be replayed bit-for-bit.
//
//  Body (all optional): { sector, mode, channel, stress_flagged,
//                         stress_reason, book_size_pence,
//                         override_used, override_reason }
//    - override_used + override_reason audit-stamp manual deviations from
//      the engine's pure recommendation (e.g. credit picks a different rate).
//
//  Returns: { ok: true, envelope, deal_pricing_id }
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/save/:dealId',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId must be a positive integer' });
    }

    try {
      const built = await buildEnvelopeForDeal(dealId, req.body || {});
      if (built.error) return res.status(built.error.status).json({ ok: false, error: built.error.message });
      const { envelope } = built;

      const overrideUsed = !!req.body?.override_used;
      const overrideReason = req.body?.override_reason || null;

      const { rows } = await pool.query(
        `INSERT INTO deal_pricings (
           deal_id, risk_view_id,
           pricing_assumptions_version, pricing_grid_version, ia_modifiers_version,
           input_loan_amount_pence, input_term_months, input_sector,
           input_pd, input_lgd, input_ia,
           input_mode, input_concentration_bps, input_stress_flagged, input_stress_reason,
           recommended_rate_bps_pm, recommended_upfront_fee_bps, recommended_commitment_fee_bps,
           recommended_retained_months, recommended_exit_fee_bps, recommended_min_term_months,
           calculated_yield_apr_bps, required_yield_apr_bps, margin_buffer_bps,
           net_yield_after_broker_apr_bps,
           stress_matrix_jsonb, decline_flag, decline_reason,
           whole_loan_alternative_jsonb,
           override_used, override_by, override_reason,
           created_by
         ) VALUES (
           $1, $2,
           $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11,
           $12, $13, $14, $15,
           $16, $17, $18,
           $19, $20, $21,
           $22, $23, $24,
           $25,
           $26::jsonb, $27, $28,
           $29::jsonb,
           $30, $31, $32,
           $33
         ) RETURNING id, created_at`,
        [
          dealId, envelope.inputs.risk_view_id,
          envelope.pricing_versions.assumptions, envelope.pricing_versions.grid, envelope.pricing_versions.ia_modifiers,
          envelope.inputs.loan_amount_pence, envelope.inputs.term_months, envelope.inputs.sector,
          envelope.inputs.pd, envelope.inputs.lgd, envelope.inputs.ia,
          envelope.inputs.mode, envelope.cost_stack.concentration_adder_bps, envelope.inputs.stress_flagged, envelope.inputs.stress_reason,
          envelope.recommended.rate_bps_pm, envelope.recommended.upfront_fee_bps, envelope.recommended.commitment_fee_bps,
          envelope.recommended.retained_months, envelope.recommended.exit_fee_bps, envelope.recommended.min_term_months,
          envelope.gross_yield_apr_bps, envelope.cost_stack.required_yield_apr_bps, envelope.margin_buffer_bps,
          envelope.net_yield_after_broker_apr_bps,
          JSON.stringify(envelope.stress_matrix), envelope.decline_flag, envelope.decline_reason,
          envelope.whole_loan_alternative ? JSON.stringify(envelope.whole_loan_alternative) : null,
          overrideUsed, overrideUsed ? req.user.id : null, overrideReason,
          req.user.id
        ]
      );
      const row = rows[0];

      return res.json({
        ok: true,
        envelope,
        deal_pricing_id: row.id,
        created_at: row.created_at,
      });
    } catch (err) {
      console.error(`[pricing/save ${dealId}] error:`, err);
      return res.status(500).json({ ok: false, error: err.message || 'Pricing save failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/pricing/history/:dealId   (PRICE-9)
//  ─────────────────────────────────────────────────────────────────────────
//  List the last N pricing snapshots for a deal. Used by the panel's
//  "Recent snapshots" expandable. Default limit 10, max 50.
//  Returns an array sorted by created_at DESC — newest first.
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/pricing/history/:dealId',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return res.status(400).json({ ok: false, error: 'dealId must be a positive integer' });
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    try {
      const { rows } = await pool.query(
        `SELECT
           dp.id, dp.created_at, dp.created_by,
           u.first_name AS created_by_first, u.last_name AS created_by_last,
           dp.pricing_assumptions_version, dp.pricing_grid_version, dp.ia_modifiers_version,
           dp.input_pd, dp.input_lgd, dp.input_ia,
           dp.input_mode, dp.input_loan_amount_pence, dp.input_term_months, dp.input_sector,
           dp.input_stress_flagged,
           dp.recommended_rate_bps_pm, dp.recommended_upfront_fee_bps,
           dp.required_yield_apr_bps, dp.net_yield_after_broker_apr_bps, dp.margin_buffer_bps,
           dp.decline_flag, dp.decline_reason,
           dp.override_used, dp.override_reason,
           dp.risk_view_id
         FROM deal_pricings dp
         LEFT JOIN users u ON u.id = dp.created_by
         WHERE dp.deal_id = $1
         ORDER BY dp.id DESC
         LIMIT $2`,
        [dealId, limit]
      );
      return res.json({ ok: true, history: rows });
    } catch (err) {
      console.error(`[pricing/history ${dealId}] error:`, err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
