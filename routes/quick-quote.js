/**
 * routes/quick-quote.js — Broker Quick Quote tool · QQ bundle (2026-04-29)
 * ════════════════════════════════════════════════════════════════════
 * Top-of-funnel conversion tool. Broker fills a 4-input form:
 *   1) Property address (postcode-driven, PAF autocomplete-resolvable)
 *   2) Borrower company (CH number)
 *   3) Loan amount + purpose
 *   4) Drawdown date
 *
 * Backend fans out to PAF + Chimnie + PD + Companies House + pricing engine
 * in parallel (Promise.allSettled — one slow vendor doesn't block the others).
 * Returns an instant verdict: AVM, LTV, indicative rate, eligibility flag.
 *
 *   POST /api/broker/quick-quote
 *
 * Audit: every quote writes a quick_quotes row (cost-tracked, conversion
 * stamped if broker submits a full deal pack via the CTA pre-fill flow).
 *
 * Cost discipline: the four parallel lookups together cost ~£0.30 in vendor
 * credits per quote (Chimnie ~£0.10 + PD ~£0.14 + PAF ~£0.04 + CH free).
 * No per-broker rate-limit yet — add when broker count exceeds ~10.
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

function inferSectorFromPurpose(purpose, companyName) {
  // Default to resi_bridging for v1. Future: smart sector detection from
  // CH SIC codes (e.g. 68100 = real estate buy/sell → bridging) + property type.
  return 'resi_bridging';
}

function computeCompanyAge(profile) {
  if (!profile || !profile.date_of_creation) return null;
  const created = new Date(profile.date_of_creation);
  if (isNaN(created)) return null;
  const ms = Date.now() - created.getTime();
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/broker/quick-quote
// ═══════════════════════════════════════════════════════════════════════════
router.post('/broker/quick-quote', authenticateToken, async (req, res) => {
  try {
    // Allow any logged-in user — broker, internal, admin
    const {
      postcode,
      address_text,
      paf_uprn,
      company_number,
      company_name_input,
      loan_amount,           // £ (frontend sends pounds)
      purpose,               // 'acquisition' | 'refinance' | 'equity_release'
      drawdown_target_date,  // 'YYYY-MM-DD'
      manual_avm,            // £ (optional — broker's own valuation when Chimnie has no AVM)
    } = req.body || {};

    // ── Validate ────────────────────────────────────────────────────────
    if (!postcode && !address_text) {
      return res.status(400).json({ ok: false, error: 'postcode or address_text required' });
    }
    if (!loan_amount) {
      return res.status(400).json({ ok: false, error: 'loan_amount required' });
    }
    if (!purpose || !['acquisition', 'refinance', 'equity_release'].includes(purpose)) {
      return res.status(400).json({ ok: false, error: 'purpose required (acquisition|refinance|equity_release)' });
    }

    const loanAmountPence = poundsToPence(loan_amount);
    if (!loanAmountPence || loanAmountPence < 50000000) {
      return res.status(400).json({ ok: false, error: 'loan_amount must be at least £500,000 (Daksfirst minimum)' });
    }
    if (loanAmountPence > 1500000000) {
      return res.status(400).json({ ok: false, error: 'loan_amount above £15m — use full deal submission for jumbo' });
    }

    // Chimnie's fuzzy matcher works much better when address + postcode are
    // both supplied. Match the matrix's address-build pattern: "ADDRESS, POSTCODE".
    let addressQuery;
    if (address_text && postcode) {
      const addrUpper = String(address_text).toUpperCase();
      const pcUpper = String(postcode).toUpperCase().replace(/\s+/g, '');
      const addrPcStripped = addrUpper.replace(/\s+/g, '');
      // Don't double-append postcode if it's already in the address text
      addressQuery = addrPcStripped.includes(pcUpper)
        ? address_text
        : `${address_text}, ${postcode}`.trim().replace(/^,\s*/, '');
    } else {
      addressQuery = address_text || postcode;
    }
    const cleanCompanyNumber = company_number ? String(company_number).trim().toUpperCase() : null;

    // ── Parallel fan-out ────────────────────────────────────────────────
    // allSettled — one slow vendor doesn't block the others. We collect
    // whatever we got and surface a partial verdict if needed.
    const lookups = await Promise.allSettled([
      // Chimnie: AVM + property type
      chimnie.lookupByAddress(addressQuery).catch((err) => ({ success: false, error: err.message })),
      // PropertyData: rental signals (postcode-only, no beds filter for QQ)
      postcode ? propertyData.getRentalsByPostcode(postcode).catch((err) => ({ ok: false, error: err.message }))
               : Promise.resolve({ ok: false, error: 'no postcode' }),
      // Companies House: company status + age
      cleanCompanyNumber ? companiesHouse.getCompanyProfile(cleanCompanyNumber).catch((err) => ({ error: err.message }))
                         : Promise.resolve(null),
    ]);

    const chimnieResult = lookups[0].status === 'fulfilled' ? lookups[0].value : null;
    const pdResult      = lookups[1].status === 'fulfilled' ? lookups[1].value : null;
    const chResult      = lookups[2].status === 'fulfilled' ? lookups[2].value : null;

    // ── Extract signals ──────────────────────────────────────────────────
    let chimnieAvmPence = null;
    let propertyType = null;
    if (chimnieResult && chimnieResult.success && chimnieResult.data) {
      const flat = chimnie.extractFlatFields(chimnieResult.data);
      // Chimnie stores AVM in chimnie_avm_mid (pounds) typically
      const avmPounds = safeNumber(flat.chimnie_avm_mid)
                     || safeNumber(flat.chimnie_market_value)
                     || safeNumber(flat.chimnie_avm);
      if (avmPounds) chimnieAvmPence = Math.round(avmPounds * 100);
      propertyType = flat.chimnie_property_type || flat.chimnie_classification || null;
    }

    // Manual AVM override — broker provides their own estimate when Chimnie
    // returns nothing. We mark the quote as "broker-supplied valuation" so the
    // verdict + audit row reflect it's not an independent number.
    let manualAvmUsed = false;
    const manualAvmPence = poundsToPence(manual_avm);
    if (manualAvmPence && manualAvmPence > 0) {
      chimnieAvmPence = manualAvmPence;
      manualAvmUsed = true;
    }

    let pdRentalPcmPence = null;
    let pdYieldGrossPct = null;
    if (pdResult && pdResult.ok && pdResult.achieved_pcm) {
      const avgPcm = pdResult.achieved_pcm.avg;
      if (avgPcm) pdRentalPcmPence = Math.round(avgPcm * 100);
      if (pdResult.yield_gross_pct) pdYieldGrossPct = pdResult.yield_gross_pct;
    }
    // If we have AVM and rental, compute yield ourselves
    if (chimnieAvmPence && pdRentalPcmPence && !pdYieldGrossPct) {
      const annualRentPence = pdRentalPcmPence * 12;
      pdYieldGrossPct = Number(((annualRentPence / chimnieAvmPence) * 100).toFixed(2));
    }

    let companyStatus = null;
    let companyAgeYears = null;
    let companyNameResolved = company_name_input || null;
    if (chResult && chResult.company_status) {
      companyStatus = chResult.company_status;
      companyAgeYears = computeCompanyAge(chResult);
      companyNameResolved = chResult.company_name || companyNameResolved;
    }

    // ── LTV + eligibility ────────────────────────────────────────────────
    let ltvPct = null;
    if (chimnieAvmPence && chimnieAvmPence > 0) {
      ltvPct = Number(((loanAmountPence / chimnieAvmPence) * 100).toFixed(1));
    }

    let eligibleFlag = false;
    let eligibleReason = '';
    const valuationLabel = manualAvmUsed ? 'broker-supplied estimate' : 'Chimnie AVM';
    if (!chimnieAvmPence) {
      eligibleReason = 'No AVM available — provide an estimated value below to get an indicative quote, or commission a full surveyor valuation at submission.';
    } else if (ltvPct > 75) {
      eligibleReason = `${ltvPct}% effective LTV (against ${valuationLabel}) exceeds Daksfirst's 75% ceiling. Additional 1st-charge security or equity contribution required.`;
    } else if (companyStatus && companyStatus !== 'active') {
      eligibleReason = `Borrower company is "${companyStatus}" at Companies House — needs an active corporate borrower.`;
    } else {
      eligibleFlag = true;
      const baseReason = ltvPct <= 65
        ? `${ltvPct}% LTV — comfortably within Daksfirst's 75% ceiling.`
        : `${ltvPct}% LTV — within ceiling but in stretch zone. Pricing reflects.`;
      eligibleReason = manualAvmUsed
        ? baseReason + ' Indicative — based on broker-supplied valuation. Final rate subject to RICS valuation.'
        : baseReason;
    }

    // ── Pricing engine — indicative rate at typical grade ────────────────
    let indicativeRateBpsPm = null;
    let pricingDetail = null;
    if (chimnieAvmPence && eligibleFlag) {
      try {
        const sector = inferSectorFromPurpose(purpose, companyNameResolved);
        const pricing = await pricingEngine.priceDeal({
          mode: 'warehouse',
          channel: 'broker',
          sector,
          pd: 5,             // typical mid-grade default for indicative
          lgd: 'C',
          ia: 'C',
          loan_amount_pence: loanAmountPence,
          term_months: 12,
          ltv_pct: ltvPct,
        });
        indicativeRateBpsPm = pricing.recommended_rate_bps_pm || null;
        pricingDetail = {
          recommended_upfront_fee_bps: pricing.recommended_upfront_fee_bps,
          recommended_min_term_months: pricing.recommended_min_term_months,
          decline_flag: pricing.decline_flag,
        };
      } catch (err) {
        console.warn('[quick-quote] pricing engine error:', err.message);
      }
    }

    // ── Insert audit row ─────────────────────────────────────────────────
    const totalCostPence =
      (chimnieResult && chimnieResult.success ? 10 : 0) +
      (pdResult && pdResult.ok ? (pdResult.cost_pence || 14) : 0) +
      0; // CH and pricing engine are free

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
        postcode || null,
        address_text || null,
        paf_uprn || null,
        cleanCompanyNumber,
        companyNameResolved,
        loanAmountPence,
        purpose,
        drawdown_target_date || null,
        chimnieAvmPence,
        pdRentalPcmPence,
        pdYieldGrossPct,
        companyStatus,
        companyAgeYears,
        ltvPct,
        indicativeRateBpsPm,
        eligibleFlag,
        eligibleReason,
        JSON.stringify({
          chimnie: chimnieResult ? { success: chimnieResult.success, property_type: propertyType, avm_pence: chimnieAvmPence } : null,
          property_data: pdResult ? { ok: pdResult.ok, sample: pdResult.asking_pcm?.sample } : null,
          companies_house: chResult ? { status: companyStatus, age_years: companyAgeYears } : null,
          pricing: pricingDetail,
          manual_avm_used: manualAvmUsed,
          manual_avm_pence: manualAvmUsed ? manualAvmPence : null,
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
      property: {
        avm_pence: chimnieAvmPence,
        avm_source: manualAvmUsed ? 'broker_estimate' : (chimnieAvmPence ? 'chimnie' : 'none'),
        property_type: propertyType,
        rental_pcm_pence: pdRentalPcmPence,
        yield_gross_pct: pdYieldGrossPct,
      },
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
    // Ownership check — broker can only see their own quotes; internal users see all
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
//  ─────────────────────────────────────────────────────────────────────────
//  Used by the Quick Quote form's postcode autocomplete. Mirrors the admin
//  /api/admin/property/postcode-lookup + /autocomplete routes but is open
//  to any authenticated user including brokers. PAF lookups are cheap (~£0.04)
//  and don't expose any deal data — fine to surface to brokers.
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
