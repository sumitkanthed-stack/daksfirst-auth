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
const {
  normalizePostcode,
  normalizeString,
  normalizeMoney,
  normalizeCompanyNumber,
} = require('../services/matrix-normalizer');

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
    // Generic source label for broker view — internal RM/credit get the full
    // vendor name elsewhere. "auto" = system-estimated valuation.
    avm_source: manualAvmUsed ? 'broker_estimate' : (chimnieAvmPence ? 'auto' : 'none'),
    property_type: propertyType,
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
    const rawBody = req.body || {};

    // ── Normalize every broker-typed field through the canonical layer ──
    // Note: this route uses pounds (not pence) at the input boundary —
    // poundsToPence() handles the conversion downstream. normalizeMoney
    // strips £/k/m/commas and returns the underlying number unchanged.
    const propertiesRaw = Array.isArray(rawBody.properties) ? rawBody.properties : [];
    const properties = propertiesRaw.map((p) => ({
      postcode: normalizePostcode(p.postcode),
      address_text: normalizeString(p.address_text),
      paf_uprn: normalizeString(p.paf_uprn),
      purpose: normalizeString(p.purpose, { lowercase: true }),
      existing_charge_balance: normalizeMoney(p.existing_charge_balance),
      manual_avm: normalizeMoney(p.manual_avm),
    }));
    const company_number = normalizeCompanyNumber(rawBody.company_number);
    const company_name_input = normalizeString(rawBody.company_name_input);
    const loan_amount = normalizeMoney(rawBody.loan_amount);

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

    // normalizeCompanyNumber already produces 8-char zero-padded uppercase form
    const cleanCompanyNumber = company_number || null;

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

    // ── Pricing engine — always run when we have an LTV, even on stretch
    // deals. Brokers need the rate to have a meaningful conversation about
    // alternatives (more security, smaller loan, etc.). When LTV > 75% we
    // pass stress_flagged so the engine bakes in the ceiling treatment.
    let indicativeRateBpsPm = null;
    let pricingDetail = null;
    if (ltvPct != null && crossCollateral.first_charge_count > 0) {
      try {
        const sector = inferSectorFromPortfolio();
        const pricing = await pricingEngine.priceDeal({
          mode: 'warehouse',
          channel: 'broker',
          sector,
          pd: 5, lgd: 'C', ia: 'C',
          loan_amount_pence: totalFacilityPence,
          term_months: 12,
          ltv_pct: ltvPct,
          stress_flagged: ltvPct > 75,  // marks stretch deals for ceiling treatment
        });
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
        req.user.userId || null,
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
    if (req.user.role === 'broker' && row.broker_user_id !== req.user.userId) {
      return res.status(403).json({ error: 'not your quote' });
    }
    res.json({ ok: true, quote: row });
  } catch (err) {
    console.error('[quick-quote/get] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/broker/quick-quote/:id/convert-to-deal
//  ─────────────────────────────────────────────────────────────────────────
//  One-shot promotion of a Quick Quote into a real deal_submissions record.
//  Avoids broker re-typing what they already gave us:
//   - Creates deal_submissions with loan_amount + purpose from quote
//   - Creates deal_properties for each property in the quote
//   - Creates deal_borrowers for the corporate borrower
//   - Stamps quick_quotes.converted_to_deal_id for conversion tracking
//   - Returns submission_id so frontend can route to documents upload
// ═══════════════════════════════════════════════════════════════════════════
router.post('/broker/quick-quote/:id/convert-to-deal', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid id' });

  const client = await pool.connect();
  try {
    const qq = (await client.query(`SELECT * FROM quick_quotes WHERE id = $1`, [id])).rows[0];
    if (!qq) return res.status(404).json({ ok: false, error: 'quote not found' });
    if (req.user.role === 'broker' && qq.broker_user_id !== req.user.userId) {
      return res.status(403).json({ ok: false, error: 'not your quote' });
    }
    if (qq.converted_to_deal_id) {
      return res.json({
        ok: true,
        already_converted: true,
        deal_id: qq.converted_to_deal_id,
        message: 'Quote already converted to a deal',
      });
    }

    const props = (qq.results_jsonb && Array.isArray(qq.results_jsonb.properties))
      ? qq.results_jsonb.properties : [];
    if (props.length === 0) {
      return res.status(400).json({ ok: false, error: 'quote has no properties to convert' });
    }
    const lead = props[0];
    const isCorporate = !!(qq.company_number || qq.company_name);

    // ──────────────────────────────────────────────────────────────────────
    // 2026-04-30 — matrix-canonical write pattern.
    //
    // Sumit's principle (memory: feedback_matrix_is_canonical): the matrix
    // (deal_submissions flat columns) is the SSOT for deal-level + primary
    // borrower / primary property fields. Child tables are DERIVED:
    //  - deal_properties: written here for every property (no flat→child
    //    auto-backfill exists for properties).
    //  - deal_borrowers: NOT written here. The GET handler at
    //    routes/deals.js:403 auto-backfills the primary borrower row from
    //    the flat fields (borrower_name, borrower_type, company_name,
    //    company_number) on first read. The wizard's /submit handler also
    //    relies on this — by following the same pattern, QQ-converted deals
    //    produce the IDENTICAL deal_borrowers shape that downstream
    //    consumers (CH verify, KYC, Add Borrower modal, audit) expect.
    //
    // Earlier convert-to-deal wrote a 6-column deal_borrowers INSERT
    // directly; that broke CH verify ('.id' undefined) and Add Borrower
    // (unique-name violation when broker tried to add a second borrower
    // with same name as existing primary). Both fixed by this refactor.
    // ──────────────────────────────────────────────────────────────────────

    await client.query('BEGIN');

    // Resolve broker's default RM (mirrors wizard's /submit handler at deals.js:480)
    let assignedRm = null;
    if (req.user.role === 'broker') {
      const brokerOnb = await client.query(
        `SELECT default_rm FROM broker_onboarding WHERE user_id = $1`,
        [req.user.userId]
      );
      if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
        assignedRm = brokerOnb.rows[0].default_rm;
      }
    }

    // Insert deal — flat-field shape that matches what wizard's /submit produces.
    // Anything QQ doesn't capture stays NULL; broker fills in the matrix.
    const dealResult = await client.query(`
      INSERT INTO deal_submissions (
        user_id,
        borrower_name, borrower_company, borrower_type,
        company_name, company_number,
        security_address, security_postcode, current_value,
        loan_amount, loan_purpose,
        existing_charges, additional_notes,
        documents, source, internal_status, deal_stage,
        assigned_rm
      ) VALUES (
        $1,
        $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        $10, $11,
        $12, $13,
        $14, 'quick_quote', 'new', 'received',
        $15
      )
      RETURNING id, submission_id, status, created_at
    `, [
      req.user.userId || null,
      // Primary borrower flat fields → auto-backfill creates deal_borrowers row from these
      isCorporate ? (qq.company_name || qq.company_number) : null,
      qq.company_name || null,
      isCorporate ? 'limited' : null,
      qq.company_name || null,
      qq.company_number || null,
      // Primary property flat fields
      lead.address_text || lead.postcode || 'Address pending',
      lead.postcode || null,
      lead.avm_pence ? Math.round(lead.avm_pence / 100) : null,
      // Loan
      Math.round((qq.loan_amount_pence || 0) / 100),
      lead.purpose || qq.purpose || null,
      // Notes
      props.some(p => p.existing_charge_balance_pence)
        ? `Existing charges captured per property — see deal_properties schedule`
        : null,
      `Quick Quote: ${props.length} ${props.length === 1 ? 'property' : 'properties'}, see schedule below`,
      JSON.stringify([]),
      assignedRm,
    ]);

    const deal = dealResult.rows[0];

    // Insert deal_properties rows for every property (incl. primary).
    // deal_properties.address is NOT NULL — always supply a value.
    // 2026-04-30 — dedup on (normalized address, postcode) so brokers entering
    // the same property twice in QQ don't get duplicate rows.
    const _propKey = (addr, pc) => {
      const a = String(addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const p = String(pc || '').trim().toUpperCase().replace(/\s+/g, '');
      return `${a}||${p}`;
    };
    const _seenPropKeys = new Set();
    let _propsInserted = 0;
    for (const p of props) {
      const addr = p.address_text || p.postcode || 'Address pending';
      const key = _propKey(addr, p.postcode);
      if (_seenPropKeys.has(key)) {
        console.log(`[quick-quote/convert] dedup — skipping duplicate property: ${addr} (${p.postcode || 'no postcode'})`);
        continue;
      }
      _seenPropKeys.add(key);
      await client.query(`
        INSERT INTO deal_properties (
          deal_id, address, postcode, market_value,
          loan_purpose, security_charge_type, existing_charge_balance_pence,
          paf_uprn, chimnie_avm_mid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        deal.id,
        addr,
        p.postcode || null,
        p.avm_pence ? Math.round(p.avm_pence / 100) : null,
        p.purpose || null,
        p.charge_type || p.security_charge_type || 'first_charge',
        p.existing_charge_balance_pence || null,
        p.paf_uprn || null,
        p.avm_pence ? Math.round(p.avm_pence / 100) : null,
      ]);
      _propsInserted++;
    }
    console.log(`[quick-quote/convert] inserted ${_propsInserted}/${props.length} properties (${props.length - _propsInserted} duped)`);

    // 2026-04-30 — Eager auto-backfill + auto-CH-verify so the broker doesn't
    // have to click anything. Mirrors the GET-handler auto-backfill at deals.js:403
    // (same column set) — the GET-side backfill becomes a fallback when this path
    // didn't run. Then for corporate borrowers with a company number, we kick off
    // _populateChChildrenRecursive synchronously to populate directors/PSCs/UBOs
    // and stamp ch_verified_at. Wrapped in try/catch — convert succeeds even if
    // CH verify fails (broker can re-verify manually from the matrix).
    let primaryBorrowerId = null;
    if (isCorporate || qq.company_name) {
      try {
        const backfillRes = await client.query(
          `INSERT INTO deal_borrowers
             (deal_id, role, full_name, borrower_type, email, phone, date_of_birth,
              nationality, jurisdiction, company_name, company_number)
           VALUES ($1, 'primary', $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            deal.id,
            qq.company_name || qq.company_number,
            isCorporate ? 'limited' : null,
            null, null, null, null, null,
            qq.company_name || null,
            qq.company_number || null,
          ]
        );
        primaryBorrowerId = backfillRes.rows[0].id;
        console.log(`[quick-quote/convert] eager-backfilled primary borrower id=${primaryBorrowerId} for deal ${deal.submission_id}`);
      } catch (bfErr) {
        // Non-fatal — GET handler's backfill will create it on first read instead.
        console.warn(`[quick-quote/convert] eager backfill skipped: ${bfErr.message}`);
      }
    }

    // Auto-CH-verify for corporate borrowers — fires the same recursive populator
    // the manual "Verify at Companies House" button calls. Wrapped: convert
    // succeeds even if CH API is down or company not found.
    if (primaryBorrowerId && isCorporate && qq.company_number) {
      try {
        const borrowersModule = require('./borrowers');
        const populateChChildrenRecursive = borrowersModule.populateChChildrenRecursive;
        if (typeof populateChChildrenRecursive === 'function') {
          const chResult = await populateChChildrenRecursive(
            deal.id, primaryBorrowerId, qq.company_number, req.user.userId, 0
          );
          if (chResult && chResult.verification) {
            // Stamp ch_verified_at + ch_match_data on the primary corporate row
            await client.query(
              `UPDATE deal_borrowers
                 SET ch_verified_at = NOW(),
                     ch_verified_by = $1,
                     ch_match_data = $2::jsonb,
                     ch_match_confidence = 'auto-populated',
                     updated_at = NOW()
               WHERE id = $3`,
              [req.user.userId, JSON.stringify(chResult.verification), primaryBorrowerId]
            );
            console.log(`[quick-quote/convert] auto-CH-verified primary borrower id=${primaryBorrowerId} (${qq.company_number}): ${chResult.inserted.officers} officers, ${chResult.inserted.pscs} PSCs`);
          } else {
            console.warn(`[quick-quote/convert] CH verify returned no verification for ${qq.company_number}`);
          }
        } else {
          console.warn('[quick-quote/convert] populateChChildrenRecursive not exported from routes/borrowers.js — skipping auto-verify');
        }
      } catch (chErr) {
        // Non-fatal — broker can manually verify from the matrix
        console.warn(`[quick-quote/convert] auto-CH-verify failed (non-fatal): ${chErr.message}`);
      }
    }

    // 2026-04-30 — Auto-enrich every property: FREE APIs (Postcodes.io + EPC) +
    // Chimnie (low-cost, freshness-gated). Land Registry Price Paid (£3) is
    // RM-only and NOT auto-fired here. Uses shared services/property-enrich.js
    // helpers so the code path matches POST /properties + claude-parser.
    // Wrapped: convert succeeds even if individual property enrichment fails.
    // Note: enrichment uses pool (not client) because helpers are pool-bound.
    // The convert transaction commits the property rows first, then enrichment
    // runs on committed rows — fine because helpers are best-effort + idempotent.
    try {
      const { autoEnrichProperty, autoEnrichChimnie } = require('../services/property-enrich');
      const propsList = await client.query(
        `SELECT id FROM deal_properties WHERE deal_id = $1 AND property_searched_at IS NULL`,
        [deal.id]
      );
      // Defer enrichment until after transaction commits (post-COMMIT). Stash IDs.
      deal._enrich_property_ids = propsList.rows.map(r => r.id);
    } catch (psBlockErr) {
      console.warn('[quick-quote/convert] property enrichment block skipped:', psBlockErr.message);
    }

    // Stamp conversion on the quote for analytics
    await client.query(
      `UPDATE quick_quotes SET converted_to_deal_id = $1 WHERE id = $2`,
      [deal.id, id]
    );

    // 2026-04-30 — fire auto-enrich AFTER transaction commits so enrichment writes
    // land on the committed property rows. Best-effort: convert response still goes
    // out even if enrichment fails. Each helper is itself try/catch-wrapped.
    if (Array.isArray(deal._enrich_property_ids) && deal._enrich_property_ids.length > 0) {
      try {
        const { autoEnrichProperty, autoEnrichChimnie } = require('../services/property-enrich');
        // Run sequentially so we don't slam Postcodes.io / EPC / Chimnie in parallel
        for (const pid of deal._enrich_property_ids) {
          await autoEnrichProperty(deal.id, pid, req.user.userId);
          await autoEnrichChimnie(deal.id, pid, req.user.userId);
        }
        console.log(`[quick-quote/convert] auto-enriched ${deal._enrich_property_ids.length} properties (postcode+EPC+Chimnie+PTAL)`);
      } catch (enrichErr) {
        console.warn('[quick-quote/convert] post-commit enrichment failed (non-fatal):', enrichErr.message);
      }
    }

    // Audit trail (mirrors wizard /submit handler)
    try {
      const { logAudit } = require('../services/audit');
      await logAudit(deal.id, 'deal_submitted_from_quick_quote', null, 'received',
        { qq_id: id, properties: props.length, loan_amount: Math.round((qq.loan_amount_pence || 0) / 100) },
        req.user.userId);
    } catch (auditErr) {
      console.warn('[quick-quote/convert] audit log skipped:', auditErr.message);
    }

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      deal_id: deal.id,
      submission_id: deal.submission_id,
      message: `Deal ${deal.submission_id} created from Quick Quote — ${props.length} ${props.length === 1 ? 'property' : 'properties'}, ${qq.company_name || 'borrower'} loaded.`,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[quick-quote/convert] error:', err);
    // 2026-04-30: surface real Postgres error so debugging isn't blind
    res.status(500).json({
      ok: false,
      error: err.detail || err.message,
      code: err.code || null,
      constraint: err.constraint || null,
    });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/admin/broker-activity  (admin) — pilot rollout dashboard data
//  ─────────────────────────────────────────────────────────────────────────
//  Returns aggregated quick-quote and deal stats for monitoring broker pilot.
//  Last 30 days by default, can override with ?days=N.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/broker-activity', authenticateToken, async (req, res) => {
  try {
    if (!req.user || !['admin', 'rm', 'credit', 'compliance'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Internal users only' });
    }
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

    const [byDay, byBroker, totals, deals] = await Promise.all([
      // Per-day quote volume + conversion + spend
      pool.query(`
        SELECT
          DATE(created_at)            AS day,
          COUNT(*)::int               AS quotes,
          COUNT(DISTINCT broker_user_id)::int AS unique_brokers,
          COUNT(*) FILTER (WHERE eligible_flag)::int AS eligible,
          COUNT(*) FILTER (WHERE converted_to_deal_id IS NOT NULL)::int AS converted,
          ROUND(SUM(total_cost_pence) / 100.0, 2)::float AS vendor_spend_gbp
        FROM quick_quotes
        WHERE created_at > NOW() - ($1::int || ' days')::interval
        GROUP BY 1
        ORDER BY 1 DESC
      `, [days]),
      // Per-broker leaderboard
      pool.query(`
        SELECT
          q.broker_user_id,
          u.email                AS broker_email,
          u.first_name           AS broker_first_name,
          u.last_name            AS broker_last_name,
          u.company              AS broker_company,
          COUNT(*)::int          AS quotes,
          COUNT(*) FILTER (WHERE q.eligible_flag)::int AS eligible,
          COUNT(*) FILTER (WHERE q.converted_to_deal_id IS NOT NULL)::int AS converted,
          ROUND(SUM(q.total_cost_pence) / 100.0, 2)::float AS vendor_spend_gbp,
          MAX(q.created_at)      AS last_quote_at
        FROM quick_quotes q
        LEFT JOIN users u ON u.id = q.broker_user_id
        WHERE q.created_at > NOW() - ($1::int || ' days')::interval
        GROUP BY q.broker_user_id, u.email, u.first_name, u.last_name, u.company
        ORDER BY quotes DESC
        LIMIT 50
      `, [days]),
      // Aggregate totals
      pool.query(`
        SELECT
          COUNT(*)::int AS total_quotes,
          COUNT(DISTINCT broker_user_id)::int AS total_brokers,
          COUNT(*) FILTER (WHERE eligible_flag)::int AS total_eligible,
          COUNT(*) FILTER (WHERE converted_to_deal_id IS NOT NULL)::int AS total_converted,
          ROUND(SUM(total_cost_pence) / 100.0, 2)::float AS total_spend_gbp,
          ROUND(AVG(ltv_pct), 1)::float AS avg_ltv_pct
        FROM quick_quotes
        WHERE created_at > NOW() - ($1::int || ' days')::interval
      `, [days]),
      // Deals submitted in window (broker channel only)
      pool.query(`
        SELECT
          COUNT(*)::int AS total_deals,
          COUNT(DISTINCT user_id)::int AS active_brokers,
          COUNT(*) FILTER (WHERE source = 'quick_quote')::int AS from_quick_quote,
          COUNT(*) FILTER (WHERE deal_stage = 'completed')::int AS completed
        FROM deal_submissions ds
        JOIN users u ON u.id = ds.user_id
        WHERE u.role = 'broker'
          AND ds.created_at > NOW() - ($1::int || ' days')::interval
      `, [days]),
    ]);

    res.json({
      success: true,
      window_days: days,
      totals: totals.rows[0],
      deals_summary: deals.rows[0],
      by_day: byDay.rows,
      by_broker: byBroker.rows,
    });
  } catch (err) {
    console.error('[broker-activity] error:', err);
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
