/**
 * routes/quick-quote.js — Broker Quick Quote · QQ bundle (2026-04-29, multi-prop refactor)
 * ════════════════════════════════════════════════════════════════════════════════
 * Top-of-funnel conversion tool. Brokers fill a form with N properties +
 * borrower company + total loan amount. Backend fans out per-property
 * to PAF + Chimnie + PD, runs Companies House on the borrower, then runs
 * pricing engine + cross-collateral math for an aggregate verdict.
 *
 *   POST /api/broker/quick-quote
 *   Body: {
 *     properties: [
 *       { postcode, address_text, paf_uprn, purpose, existing_charge_balance, manual_avm }
 *     ],
 *     company_number, company_name_input,
 *     loan_amount,
 *   }
 *
 * Chimnie is now looked up by UPRN when PAF returned one (more reliable than
 * fuzzy address match); falls back to address+postcode string match if no UPRN.
 *
 * Audit: every quote writes a quick_quotes row (one row per quote, multi-property
 * details persisted in results_jsonb).
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');

const chimnie = require('../services/chimnie');
const propertyData = require('../services/property-data');
const companiesHouse = require('../services/companies-house');
const pricingEngine = require('../services/pricing-engine');
const addressLookup = require('../services/address-lookup');
const xcoll = require('../services/cross-collateral');

// ─── Helpers ───────────────────────────────────────────────────────────────
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || req.ip
      || null;
}

function poundsToPence(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

function safeNumber(v) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  return Number(v);
}

function purposeToChargeType(purpose) {
  if (purpose === 'acquisition') return 'first_charge';
  if (purpose === 'refinance')   return 'first_charge';   // becomes 1st after redemption
  if (purpose === 'equity_release') return 'second_charge';
  return 'first_charge';
}

function inferSectorFromPortfolio() {
  // Default for v1. Future: smart sector detection from CH SIC codes + property types.
  return 'resi_bridging';
}

function computeCompanyAge(profile) {
  if (!profile || !profile.date_of_creation) return null;
  const created = new Date(profile.date_of_creation);
  if (isNaN(created)) return null;
  const ms = Date.now() - created.getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

// ─── Per-property orchestration ────────────────────────────────────────────
// Looks up Chimnie (UPRN-first, fall back to address) + PropertyData rental.
// Returns the per-property summary used in cross-collateral math + UI display.
async function quoteOneProperty(input) {
  const { postcode, address_text, paf_uprn, purpose, existing_charge_balance, manual_avm } = input;
  const charge_type = purposeToChargeType(purpose);

  // Try UPRN-first if PAF gave us one — far more reliable than fuzzy address
  let chimnieResult = null;
  let pafLookup = null;

  // If no UPRN was provided but we have a postcode + address, hit PAF first
  // to grab a UPRN, then use chimnie.lookupByUprn. Avoids fuzzy-match misses.
  let uprn = paf_uprn || null;
  if (!uprn && postcode && address_text) {
    try {
      pafLookup = await addressLookup.searchByPostcode(postcode);
      if (pafLookup && pafLookup.addresses) {
        // Find the one matching the typed address (best-effort substring match)
        const addrUpper = address_text.toUpperCase().replace(/\s+/g, '');
        const match = pafLookup.addresses.find((a) => {
          const candidate = ((a.line_1 || '') + (a.line_2 || '')).toUpperCase().replace(/\s+/g, '');
          return candidate.includes(addrUpper.split(',')[0].replace(/\s+/g, '').trim().substring(0, 12));
        });
        if (match && match.uprn) uprn = String(match.uprn);
      }
    } catch (err) {
      console.warn('[qq/property] PAF prelookup failed:', err.message);
    }
  }

  // Chimnie: UPRN preferred, address fallback
  try {
    if (uprn) {
      chimnieResult = await chimnie.lookupByUprn(uprn);
    } else {
      // Fuzzy address fallback — append postcode to maximise hit rate
      const q = address_text && postcode
        ? (address_text.toUpperCase().includes(postcode.toUpperCase().replace(/\s+/g, ''))
            ? address_text
            : `${address_text}, ${postcode}`)
        : (address_text || postcode);
      chimnieResult = await chimnie.lookupByAddress(q);
    }
  } catch (err) {
    chimnieResult = { success: false, error: err.message };
  }

  let chimnieAvmPence = null;
  let propertyType = null;
  let chimnieMode = null;
  if (chimnieResult && chimnieResult.success && chimnieResult.data) {
    const flat = chimnie.extractFlatFields(chimnieResult.data);
    const avmPounds = safeNumber(flat.chimnie_avm_mid)
                   || safeNumber(flat.chimnie_market_value)
                   || safeNumber(flat.chimnie_avm);
    if (avmPounds) chimnieAvmPence = Math.round(avmPounds * 100);
    propertyType = flat.chimnie_property_type || flat.chimnie_classification || null;
    chimnieMode = chimnieResult.mode || null;
  }

  // Manual AVM overrides Chimnie if provided
  let manualAvmUsed = false;
  const manualAvmPence = poundsToPence(manual_avm);
  if (manualAvmPence && manualAvmPence > 0) {
    chimnieAvmPence = manualAvmPence;
    manualAvmUsed = true;
  }

  // PropertyData rental — postcode-only is fine for indicative
  let pdRentalPcmPence = null;
  let pdYieldGrossPct = null;
  if (postcode) {
    try {
      const pdResult = await propertyData.getRentalsByPostcode(postcode);
      if (pdResult && pdResult.ok && pdResult.achieved_pcm) {
        if (pdResult.achieved_pcm.avg) pdRentalPcmPence = Math.round(pdResult.achieved_pcm.avg * 100);
        if (pdResult.yield_gross_pct) pdYieldGrossPct = pdResult.yield_gross_pct;
      }
      if (chimnieAvmPence && pdRentalPcmPence && !pdYieldGrossPct) {
        pdYieldGrossPct = Number((((pdRentalPcmPence * 12) / chimnieAvmPence) * 100).toFixed(2));
      }
    } catch (err) {
      console.warn('[qq/property] PD lookup failed:', err.message);
    }
  }

  return {
    postcode, address_text, paf_uprn: uprn,
    purpose, charge_type,
    existing_charge_balance_pence: poundsToPence(existing_charge_balance),
    avm_pence: chimnieAvmPence,
    avm_source: manualAvmUsed ? 'broker_estimate' : (chimnieAvmPence ? 'chimnie' : 'none'),
    property_type: propertyType,
    chimnie_mode: chimnieMode,
    rental_pcm_pence: pdRentalPcmPence,
    yield_gross_pct: pdYieldGrossPct,
    market_value: chimnieAvmPence ? Math.round(chimnieAvmPence / 100) : null,  // pounds for cross-collateral helper
    security_charge_type: charge_type,
    loan_purpose: purpose,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/broker/quick-quote
// ═══════════════════════════════════════════════════════════════════════════
router.post('/broker/quick-quote', authenticateToken, async (req, res) => {
  try {
    const {
      properties,
      company_number,
      company_name_input,
      loan_amount,
    } = req.body || {};

    if (!Array.isArray(properties) || properties.length === 0) {
      return res.status(400).json({ ok: false, error: 'properties[] required (at least 1)' });
    }
    if (properties.length > 10) {
      return res.status(400).json({ ok: false, error: 'Max 10 properties for quick quote — use full submission for larger portfolios' });
    }

    const loanAmountPence = poundsToPence(loan_amount);
    if (!loanAmountPence || loanAmountPence < 50000000) {
      return res.status(400).json({ ok: false, error: 'loan_amount must be at least £500,000' });
    }
    if (loanAmountPence > 1500000000) {
      return res.status(400).json({ ok: false, error: 'loan_amount above £15m — use full deal submission for jumbo' });
    }

    // ── Validate every property ────────────────────────────────────────
    for (const p of properties) {
      if (!p.postcode) return res.status(400).json({ ok: false, error: 'each property needs a postcode' });
      if (!p.purpose || !['acquisition','refinance','equity_release'].includes(p.purpose)) {
        return res.status(400).json({ ok: false, error: 'each property needs a valid purpose' });
      }
    }

    const cleanCompanyNumber = company_number ? String(company_number).trim().toUpperCase() : null;

    // ── Parallel: per-property + Companies House ──────────────────────
    const [propertyResults, chResult] = await Promise.all([
      Promise.all(properties.map(quoteOneProperty)),
      cleanCompanyNumber
        ? companiesHouse.getCompanyProfile(cleanCompanyNumber).catch((err) => ({ error: err.message }))
        : Promise.resolve(null),
    ]);

    let companyStatus = null;
    let companyAgeYears = null;
    let companyNameResolved = company_name_input || null;
    if (chResult && chResult.company_status) {
      companyStatus = chResult.company_status;
      companyAgeYears = computeCompanyAge(chResult);
      companyNameResolved = chResult.company_name || companyNameResolved;
    }

    // ── Total Daksfirst exposure ─────────────────────────────────────────
    // The user-entered loan_amount is "new money for acquisition". Refinance
    // redemptions are ADDITIONAL Daksfirst exposure — we have to fund the
    // payoff of the existing 1st charge to take its place.
    //
    //   Total facility = acquisition_loan + Σ (refinance existing balances)
    //
    // LTV math uses total facility against 1st-charge security values.
    const refiRedemptionsPence = propertyResults
      .filter((p) => p.purpose === 'refinance')
      .reduce((sum, p) => sum + (p.existing_charge_balance_pence || 0), 0);
    const totalFacilityPence = loanAmountPence + refiRedemptionsPence;

    // ── Cross-collateral aggregate using TOTAL facility (not net advance)
    const crossCollateral = xcoll.buildCrossCollateralSummary(propertyResults, totalFacilityPence);
    const ltvPct = crossCollateral.effective_ltv_pct;
    crossCollateral.acquisition_loan_pence = loanAmountPence;
    crossCollateral.refi_redemptions_added_pence = refiRedemptionsPence;
    crossCollateral.total_facility_pence = totalFacilityPence;

    // ── Eligibility verdict ────────────────────────────────────────────
    let eligibleFlag = false;
    let eligibleReason = '';
    const propsWithAvm = propertyResults.filter((p) => p.avm_pence);
    const noAvmCount = propertyResults.length - propsWithAvm.length;

    if (crossCollateral.first_charge_count === 0) {
      eligibleReason = 'No 1st-charge security across portfolio. Daksfirst policy requires at least one 1st-charge property.';
    } else if (ltvPct == null) {
      eligibleReason = `${noAvmCount} of ${propertyResults.length} properties have no AVM. Provide manual estimates or a full RICS valuation will be needed at submission.`;
    } else if (ltvPct > 75) {
      eligibleReason = `${ltvPct.toFixed(1)}% effective LTV (1st-charge security only) exceeds Daksfirst's 75% ceiling. ${crossCollateral.second_charge_count > 0 ? '2nd-charge security gives no LTV credit. ' : ''}Need additional 1st-charge or equity contribution.`;
    } else if (companyStatus && companyStatus !== 'active') {
      eligibleReason = `Borrower company is "${companyStatus}" at Companies House — needs an active corporate borrower.`;
    } else {
      eligibleFlag = true;
      const ltvBand = ltvPct <= 65 ? 'comfortably within' : 'in stretch zone of';
      eligibleReason = `${ltvPct.toFixed(1)}% effective LTV — ${ltvBand} Daksfirst's 75% ceiling.`;
      if (crossCollateral.second_charge_count > 0) {
        eligibleReason += ` Plus ${crossCollateral.second_charge_count} property at 2nd charge providing additional comfort security.`;
      }
      if (crossCollateral.refinance_count > 0) {
        eligibleReason += ` ${crossCollateral.refinance_count} property to be refinanced — auto-redemption baked into Sources & Uses.`;
      }
    }

    // ── Pricing engine — indicative rate at typical grade ────────────
    let indicativeRateBpsPm = null;
    let pricingDetail = null;
    if (eligibleFlag && ltvPct != null) {
      try {
        const sector = inferSectorFromPortfolio();
        const pricing = await pricingEngine.priceDeal({
          mode: 'warehouse',
          channel: 'broker',
          sector,
          pd: 5, lgd: 'C', ia: 'C',
          loan_amount_pence: totalFacilityPence,  // total exposure, not just acquisition
          term_months: 12,
          ltv_pct: ltvPct,
        });
        // priceDeal returns { recommended: { rate_bps_pm, upfront_fee_bps, min_term_months }, decline_flag, ... }
        indicativeRateBpsPm = pricing.recommended?.rate_bps_pm || null;
        pricingDetail = {
          recommended_upfront_fee_bps: pricing.recommended?.upfront_fee_bps || null,
          recommended_min_term_months: pricing.recommended?.min_term_months || null,
          decline_flag: pricing.decline_flag || false,
        };
      } catch (err) {
        console.warn('[quick-quote] pricing engine error:', err.message);
      }
    }

    // ── Audit row ────────────────────────────────────────────────────
    const totalCostPence =
      propertyResults.length * 10 +    // ~£0.10 per Chimnie call (mock=0)
      propertyResults.length * 14;     // ~£0.14 per PD call

    // For backwards-compat with existing schema, store the lead property in the
    // top-level cols + multi-property details in results_jsonb.
    const lead = propertyResults[0];
    const insertResult = await pool.query(
      `INSERT INTO quick_quotes
         (broker_user_id, postcode, address_text, paf_uprn,
          company_number, company_name,
          loan_amount_pence, purpose, drawdown_target_date,
          chimnie_avm_pence, pd_rental_pcm_pence, pd_yield_gross_pct,
          company_status, company_age_years,
          ltv_pct, indicative_rate_bps_pm,
          eligible_flag, eligible_reason,
          results_jsonb, quote_ip, quote_user_agent, total_cost_pence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22)
       RETURNING id`,
      [
        req.user.id || null,
        lead?.postcode || null,
        lead?.address_text || null,
        lead?.paf_uprn || null,
        cleanCompanyNumber,
        companyNameResolved,
        loanAmountPence,
        lead?.purpose || null,
        null,
        lead?.avm_pence || null,
        lead?.rental_pcm_pence || null,
        lead?.yield_gross_pct || null,
        companyStatus,
        companyAgeYears,
        ltvPct,
        indicativeRateBpsPm,
        eligibleFlag,
        eligibleReason,
        JSON.stringify({
          properties: propertyResults,
          cross_collateral: crossCollateral,
          companies_house: chResult ? { status: companyStatus, age_years: companyAgeYears } : null,
          pricing: pricingDetail,
        }),
        clientIp(req),
        req.headers['user-agent'] || null,
        totalCostPence,
      ]
    );

    const quickQuoteId = insertResult.rows[0].id;

    res.json({
      ok: true,
      quick_quote_id: quickQuoteId,
      verdict: {
        eligible: eligibleFlag,
        reason: eligibleReason,
        ltv_pct: ltvPct,
      },
      properties: propertyResults,
      cross_collateral: crossCollateral,
      company: cleanCompanyNumber ? {
        number: cleanCompanyNumber,
        name: companyNameResolved,
        status: companyStatus,
        age_years: companyAgeYears,
      } : null,
      pricing: indicativeRateBpsPm ? {
        rate_bps_pm: indicativeRateBpsPm,
        rate_pct_pm: Number((indicativeRateBpsPm / 100).toFixed(3)),
        upfront_fee_bps: pricingDetail?.recommended_upfront_fee_bps || null,
        min_term_months: pricingDetail?.recommended_min_term_months || null,
      } : null,
      cost_pence: totalCostPence,
    });

  } catch (err) {
    console.error('[quick-quote] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/broker/quick-quote/:id  — read back a quote (for pre-fill flow)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/broker/quick-quote/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const r = await pool.query(`SELECT * FROM quick_quotes WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'quote not found' });
    const row = r.rows[0];
    if (req.user.role === 'broker' && row.broker_user_id !== req.user.id) {
      return res.status(403).json({ error: 'not your quote' });
    }
    res.json({ ok: true, quote: row });
  } catch (err) {
    console.error('[quick-quote/get] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Broker-accessible PAF lookups (auth-only, no internal gate)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/broker/postcode-lookup', authenticateToken, async (req, res) => {
  try {
    const postcode = String(req.query.postcode || '').trim();
    if (!postcode) return res.status(400).json({ ok: false, error: 'postcode query param required' });
    const result = await addressLookup.searchByPostcode(postcode);
    return res.json(result);
  } catch (err) {
    console.error('[broker/postcode-lookup] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/broker/postcode-autocomplete', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, suggestions: [], cost_pence: 0 });
    const result = await addressLookup.autocomplete(q);
    return res.json(result);
  } catch (err) {
    console.error('[broker/postcode-autocomplete] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
