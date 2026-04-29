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
const soniaFetcher = require('../services/sonia-fetcher');

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

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/pricing/assumptions/list   (PRICE-4)
//  ─────────────────────────────────────────────────────────────────────────
//  List all assumption rows for a given version (default: active). Used by
//  admin/pricing.html to render the editor table.
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/pricing/assumptions/list',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    try {
      let version = req.query.version;
      if (!version) {
        const r = await pool.query(
          `SELECT version FROM pricing_assumptions_versions WHERE is_active = TRUE LIMIT 1`
        );
        if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'No active assumptions version' });
        version = r.rows[0].version;
      }

      const versionMeta = (await pool.query(
        `SELECT version, description, is_active, activated_at, change_reason, created_at
           FROM pricing_assumptions_versions WHERE version = $1`,
        [version]
      )).rows[0];
      if (!versionMeta) return res.status(404).json({ ok: false, error: `Version ${version} not found` });

      const rows = (await pool.query(
        `SELECT id, key, label, value_bps, value_pence, value_jsonb,
                source, citation, last_changed_by, last_changed_at, change_reason
           FROM pricing_assumptions
          WHERE version = $1
          ORDER BY id ASC`,
        [version]
      )).rows;

      const allVersions = (await pool.query(
        `SELECT version, is_active, created_at, change_reason
           FROM pricing_assumptions_versions
          ORDER BY created_at DESC LIMIT 20`
      )).rows;

      return res.json({ ok: true, version: versionMeta, rows, all_versions: allVersions });
    } catch (err) {
      console.error('[pricing/assumptions/list] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/assumptions/activate-new   (PRICE-4)
//  ─────────────────────────────────────────────────────────────────────────
//  Body: {
//    description?: string,
//    activate_reason?: string,
//    changes: [
//      { key, value_bps?, value_pence?, value_jsonb?, change_reason }
//    ]
//  }
//
//  In a single transaction:
//    1. Compute next version number (vN+1 by row count)
//    2. INSERT new pricing_assumptions_versions row
//    3. For each row in the current active version, INSERT a copy under new
//       version. If the key is in `changes`, apply the new value/reason
//       AND record last_changed_by = req.user.id.
//    4. UPDATE old version is_active=FALSE; UPDATE new version is_active=TRUE.
//    5. COMMIT.
//
//  Every changed row REQUIRES a non-empty change_reason (per design Q1).
//  Returns: { ok, new_version, changed_count, total_count }
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/assumptions/activate-new',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const body = req.body || {};
    const changes = Array.isArray(body.changes) ? body.changes : [];

    if (changes.length === 0) {
      return res.status(400).json({ ok: false, error: 'No changes provided — include at least one row in `changes`' });
    }
    for (const c of changes) {
      if (!c.key) return res.status(400).json({ ok: false, error: 'Every change requires a `key`' });
      if (!c.change_reason || !String(c.change_reason).trim()) {
        return res.status(400).json({ ok: false, error: `change for key '${c.key}' missing required change_reason` });
      }
    }
    const changesByKey = Object.fromEntries(changes.map(c => [c.key, c]));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Find current active version
      const activeRow = (await client.query(
        `SELECT version FROM pricing_assumptions_versions WHERE is_active = TRUE LIMIT 1 FOR UPDATE`
      )).rows[0];
      if (!activeRow) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'No active assumptions version to fork from' });
      }
      const oldVersion = activeRow.version;

      // 2. Compute next version (vN where N = current count + 1)
      const countRow = (await client.query(
        `SELECT COUNT(*)::int AS n FROM pricing_assumptions_versions`
      )).rows[0];
      const newVersion = `v${countRow.n + 1}`;

      // 3. INSERT new pricing_assumptions_versions row (is_active=FALSE for now)
      await client.query(
        `INSERT INTO pricing_assumptions_versions (version, description, is_active, activated_at, activated_by, change_reason)
         VALUES ($1, $2, FALSE, NOW(), $3, $4)`,
        [newVersion, body.description || `Tuned from ${oldVersion} on ${new Date().toISOString().substring(0,10)}`,
         req.user.id, body.activate_reason || `${changes.length} field(s) changed`]
      );

      // 4. Copy all rows from old version → new version, applying changes
      const oldRows = (await client.query(
        `SELECT key, label, value_bps, value_pence, value_jsonb, source, citation, change_reason
           FROM pricing_assumptions WHERE version = $1`,
        [oldVersion]
      )).rows;

      let changedCount = 0;
      for (const old of oldRows) {
        const change = changesByKey[old.key];
        let value_bps = old.value_bps;
        let value_pence = old.value_pence;
        let value_jsonb = old.value_jsonb;
        let source = old.source;
        let citation = old.citation;
        let change_reason = old.change_reason;
        let last_changed_by = null;

        if (change) {
          changedCount++;
          if ('value_bps' in change && change.value_bps !== undefined) value_bps = change.value_bps;
          if ('value_pence' in change && change.value_pence !== undefined) value_pence = change.value_pence;
          if ('value_jsonb' in change && change.value_jsonb !== undefined) value_jsonb = change.value_jsonb;
          source = change.source || 'tuned';
          if (change.citation) citation = change.citation;
          change_reason = change.change_reason;
          last_changed_by = req.user.id;
        }

        await client.query(
          `INSERT INTO pricing_assumptions
             (version, key, label, value_bps, value_pence, value_jsonb,
              source, citation, last_changed_by, last_changed_at, change_reason)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, NOW(), $10)`,
          [newVersion, old.key, old.label,
           value_bps, value_pence,
           value_jsonb !== null && value_jsonb !== undefined ? JSON.stringify(value_jsonb) : null,
           source, citation, last_changed_by, change_reason]
        );
      }

      // 5. Validate all change keys actually existed in the old version
      const knownKeys = new Set(oldRows.map(r => r.key));
      const unknownChanges = Object.keys(changesByKey).filter(k => !knownKeys.has(k));
      if (unknownChanges.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: `Unknown keys in changes: ${unknownChanges.join(', ')}` });
      }

      // 6. Flip is_active (partial unique index allows only one TRUE at a time)
      await client.query(
        `UPDATE pricing_assumptions_versions SET is_active = FALSE WHERE version = $1`,
        [oldVersion]
      );
      await client.query(
        `UPDATE pricing_assumptions_versions SET is_active = TRUE WHERE version = $1`,
        [newVersion]
      );

      await client.query('COMMIT');
      console.log(`[pricing/activate-new] User ${req.user.id} activated ${newVersion} from ${oldVersion} (${changedCount} changes)`);
      return res.json({
        ok: true,
        new_version: newVersion,
        old_version: oldVersion,
        changed_count: changedCount,
        total_count: oldRows.length,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[pricing/activate-new] error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Activation failed' });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/pricing/grid/list   (PRICE-5)
//  ─────────────────────────────────────────────────────────────────────────
//  Returns the 45 cells for one (version, sector) combo + active version
//  metadata + sector list (from risk_taxonomy active version). Defaults to
//  active version if version not specified, defaults to first sector if
//  sector not specified.
// ═══════════════════════════════════════════════════════════════════════════
router.get(
  '/admin/pricing/grid/list',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    try {
      let version = req.query.version;
      if (!version) {
        const r = await pool.query(`SELECT version FROM pricing_grid_versions WHERE is_active = TRUE LIMIT 1`);
        if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'No active grid version' });
        version = r.rows[0].version;
      }
      const versionMeta = (await pool.query(
        `SELECT version, description, is_active, activated_at, change_reason, created_at
           FROM pricing_grid_versions WHERE version = $1`, [version]
      )).rows[0];
      if (!versionMeta) return res.status(404).json({ ok: false, error: `Version ${version} not found` });

      // Sector list — distinct sectors that exist in the grid for this version
      const sectorRows = (await pool.query(
        `SELECT DISTINCT sector FROM pricing_grid WHERE version = $1 ORDER BY sector`, [version]
      )).rows;
      const sectors = sectorRows.map(r => r.sector);

      const sectorFilter = req.query.sector || (sectors[0] || 'commercial');
      const cellRows = (await pool.query(
        `SELECT id, sector, pd_band, lgd_band,
                base_rate_bps_pm, base_upfront_fee_bps, base_commitment_fee_bps,
                retained_months, base_exit_fee_bps, min_term_months,
                source, citation, last_changed_by, last_changed_at, change_reason
           FROM pricing_grid
          WHERE version = $1 AND sector = $2
          ORDER BY pd_band ASC, lgd_band ASC`,
        [version, sectorFilter]
      )).rows;

      const allVersions = (await pool.query(
        `SELECT version, is_active, created_at, change_reason
           FROM pricing_grid_versions ORDER BY created_at DESC LIMIT 20`
      )).rows;

      return res.json({
        ok: true,
        version: versionMeta,
        sector: sectorFilter,
        sectors,
        cells: cellRows,
        all_versions: allVersions,
      });
    } catch (err) {
      console.error('[pricing/grid/list] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/grid/activate-new   (PRICE-5)
//  ─────────────────────────────────────────────────────────────────────────
//  Same fork-and-flip pattern as assumptions. Body:
//    {
//      activate_reason,
//      changes: [
//        { sector, pd_band, lgd_band,
//          base_rate_bps_pm?, base_upfront_fee_bps?, base_commitment_fee_bps?,
//          retained_months?, base_exit_fee_bps?, min_term_months?,
//          change_reason }
//      ]
//    }
//
//  Txn: compute next version (vN+1), INSERT new pricing_grid_versions row,
//  copy all cells from active grid version, apply changes by (sector,pd,lgd),
//  flip is_active.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/grid/activate-new',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    const body = req.body || {};
    const changes = Array.isArray(body.changes) ? body.changes : [];

    if (changes.length === 0) {
      return res.status(400).json({ ok: false, error: 'No changes provided' });
    }
    for (const c of changes) {
      if (!c.sector || !c.pd_band || !c.lgd_band) {
        return res.status(400).json({ ok: false, error: 'Every change requires sector + pd_band + lgd_band' });
      }
      if (!c.change_reason || !String(c.change_reason).trim()) {
        return res.status(400).json({ ok: false, error: `change for (${c.sector}, PD${c.pd_band}, LGD-${c.lgd_band}) missing required change_reason` });
      }
    }
    // Map by composite key
    const changesByKey = Object.fromEntries(
      changes.map(c => [`${c.sector}|${c.pd_band}|${c.lgd_band}`, c])
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const activeRow = (await client.query(
        `SELECT version FROM pricing_grid_versions WHERE is_active = TRUE LIMIT 1 FOR UPDATE`
      )).rows[0];
      if (!activeRow) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'No active grid version to fork from' });
      }
      const oldVersion = activeRow.version;

      const countRow = (await client.query(`SELECT COUNT(*)::int AS n FROM pricing_grid_versions`)).rows[0];
      const newVersion = `v${countRow.n + 1}`;

      await client.query(
        `INSERT INTO pricing_grid_versions (version, description, is_active, activated_at, activated_by, change_reason)
         VALUES ($1, $2, FALSE, NOW(), $3, $4)`,
        [newVersion, body.description || `Tuned grid from ${oldVersion} on ${new Date().toISOString().substring(0,10)}`,
         req.user.id, body.activate_reason || `${changes.length} cell(s) changed`]
      );

      const oldCells = (await client.query(
        `SELECT sector, pd_band, lgd_band,
                base_rate_bps_pm, base_upfront_fee_bps, base_commitment_fee_bps,
                retained_months, base_exit_fee_bps, min_term_months,
                source, citation, change_reason
           FROM pricing_grid WHERE version = $1`,
        [oldVersion]
      )).rows;

      let changedCount = 0;
      for (const old of oldCells) {
        const k = `${old.sector}|${old.pd_band}|${old.lgd_band}`;
        const change = changesByKey[k];
        let row = { ...old };
        let last_changed_by = null;
        if (change) {
          changedCount++;
          if (change.base_rate_bps_pm        !== undefined) row.base_rate_bps_pm        = change.base_rate_bps_pm;
          if (change.base_upfront_fee_bps    !== undefined) row.base_upfront_fee_bps    = change.base_upfront_fee_bps;
          if (change.base_commitment_fee_bps !== undefined) row.base_commitment_fee_bps = change.base_commitment_fee_bps;
          if (change.retained_months         !== undefined) row.retained_months         = change.retained_months;
          if (change.base_exit_fee_bps       !== undefined) row.base_exit_fee_bps       = change.base_exit_fee_bps;
          if (change.min_term_months         !== undefined) row.min_term_months         = change.min_term_months;
          row.source = 'tuned';
          if (change.citation) row.citation = change.citation;
          row.change_reason = change.change_reason;
          last_changed_by = req.user.id;
        }
        await client.query(
          `INSERT INTO pricing_grid
             (version, sector, pd_band, lgd_band,
              base_rate_bps_pm, base_upfront_fee_bps, base_commitment_fee_bps,
              retained_months, base_exit_fee_bps, min_term_months,
              source, citation, last_changed_by, last_changed_at, change_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)`,
          [newVersion, row.sector, row.pd_band, row.lgd_band,
           row.base_rate_bps_pm, row.base_upfront_fee_bps, row.base_commitment_fee_bps,
           row.retained_months, row.base_exit_fee_bps, row.min_term_months,
           row.source, row.citation, last_changed_by, row.change_reason]
        );
      }

      // Validate every change key matched
      const knownKeys = new Set(oldCells.map(r => `${r.sector}|${r.pd_band}|${r.lgd_band}`));
      const unknownChanges = Object.keys(changesByKey).filter(k => !knownKeys.has(k));
      if (unknownChanges.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: `Unknown cell coords: ${unknownChanges.join(', ')}` });
      }

      // Flip is_active
      await client.query(`UPDATE pricing_grid_versions SET is_active = FALSE WHERE version = $1`, [oldVersion]);
      await client.query(`UPDATE pricing_grid_versions SET is_active = TRUE  WHERE version = $1`, [newVersion]);

      await client.query('COMMIT');
      console.log(`[pricing/grid/activate-new] User ${req.user.id} activated grid ${newVersion} from ${oldVersion} (${changedCount} cells changed)`);
      return res.json({
        ok: true,
        new_version: newVersion,
        old_version: oldVersion,
        changed_count: changedCount,
        total_count: oldCells.length,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[pricing/grid/activate-new] error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/preview-cell   (PRICE-5)
//  ─────────────────────────────────────────────────────────────────────────
//  Body: { sector, pd, lgd, ia,
//          levers: {rate_bps_pm, upfront_fee_bps, commitment_fee_bps,
//                   retained_months, exit_fee_bps, min_term_months},
//          example_loan_pence, example_term_months, mode? }
//
//  Returns the engine envelope's headline numbers (required, net, buffer,
//  decline) for the synthetic cell. Used by the grid editor's live impact
//  preview as admin types — debounced 300ms client-side.
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/preview-cell',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    try {
      const result = await pricingEngine.previewCellImpact(req.body || {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[pricing/preview-cell] error:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/pricing/sonia-pull   (PRICE-10)
//  ─────────────────────────────────────────────────────────────────────────
//  Triggers a fresh SONIA pull from BoE IADB (CSV endpoint, series IUDSOIA)
//  and UPDATEs pricing_assumptions.sonia_value_bps + sonia_last_pulled_at
//  in place.
//
//  ⚠ Update-in-place is the documented exception to append-only — see
//  services/sonia-fetcher.js header for the rationale (live market data,
//  output reproducibility lives in deal_pricings).
//
//  Manual today; cron-config later (Render Cron Job hits this endpoint
//  daily 06:00 UTC after BoE publishes ~09:00 BST).
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/pricing/sonia-pull',
  authenticateToken,
  authenticateInternal,
  async (req, res) => {
    try {
      const result = await soniaFetcher.fetchAndStore();
      console.log(`[sonia-pull] Updated SONIA to ${result.sonia_bps} bps (${result.sonia_pct}%) from ${result.source_date}, triggered by user ${req.user.id}`);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[sonia-pull] error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'SONIA pull failed' });
    }
  }
);

module.exports = router;
