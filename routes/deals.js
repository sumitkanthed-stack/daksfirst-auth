const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { authenticateInternal } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { notifyDealEvent } = require('../services/notifications');
const { generateDipPdf, buildDipHtml } = require('../services/dip-pdf');
// const { sendForSigning } = require('../services/docusign'); // Parked — will use for Termsheet/Facility Letter
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { syncDealProperties } = require('../services/property-parser');
const { getExposureForDeal } = require('../services/borrower-exposure');
// Delegated Authority (2026-04-20, DA Session 2c)
const { evaluateAutoRoute, compactReason, enrichPropertiesForEvaluator } = require('../services/delegated-authority');

// ═══════════════════════════════════════════════════════════════════════════
//  G5 — Group borrowers hierarchically for DIP / TS party rendering (2026-04-20)
//  Returns { primary, joint, corporate_guarantors, individual_guarantors, officers_by_parent }
//  Phase G model: parent_borrower_id NULL = top-level party; officers point to parent.
//  Role + borrower_type combined to derive logical categories (role 'guarantor' + borrower_type
//  distinguishes corporate vs individual guarantor).
//  Optional `deal` second argument: if no row has role='primary' but deal.borrower_company
//  is set (legacy single-borrower data), synthesize a primary entry from deal_submissions
//  fields so the Parties table is complete.
// ═══════════════════════════════════════════════════════════════════════════
function groupBorrowersForDip(rows, deal) {
  rows = Array.isArray(rows) ? rows.slice() : [];

  // Legacy backfill: synthesize a primary borrower from deal_submissions fields
  // if no row in deal_borrowers carries role='primary' but the deal has borrower_company.
  // Also synthesize a UBO officer row for this primary so the card pair has both sides.
  const hasPrimary = rows.some(r => r.role === 'primary' && !r.parent_borrower_id);
  if (!hasPrimary && deal && (deal.borrower_company || deal.borrower_name)) {
    const isLegacyCorp = !!(deal.borrower_company || deal.company_number);
    const syntheticPrimaryId = `legacy-primary-${deal.id || 'x'}`;
    rows.unshift({
      id: syntheticPrimaryId,
      role: 'primary',
      parent_borrower_id: null,
      full_name: deal.borrower_company || deal.borrower_name,
      borrower_type: isLegacyCorp ? 'corporate' : 'individual',
      company_number: deal.company_number || null,
      nationality: deal.borrower_nationality || null,
      email: deal.borrower_email || null,
      address: deal.borrower_address || deal.security_postcode || null,
      kyc_status: deal.kyc_status || 'pending',
      ch_verified_at: null,
      ch_matched_role: null,
      ch_match_confidence: null,
      ch_match_data: null
    });

    // If corporate AND we have a separate UBO name on the deal, synthesize an officer row
    // so the new card layout can pair the corporate with its UBO.
    if (isLegacyCorp && deal.borrower_name && deal.borrower_name !== deal.borrower_company) {
      rows.push({
        id: `legacy-ubo-${deal.id || 'x'}`,
        role: 'psc',
        parent_borrower_id: syntheticPrimaryId,
        full_name: deal.borrower_name,
        borrower_type: 'individual',
        company_number: null,
        nationality: deal.borrower_nationality || null,
        email: deal.borrower_email || null,
        address: null,
        kyc_status: deal.kyc_status || 'pending',
        ch_verified_at: null,
        ch_matched_role: 'UBO',
        ch_match_confidence: null,
        ch_match_data: { is_psc: true, officer_role: 'Ultimate Beneficial Owner' }
      });
    }
  }

  if (rows.length === 0) {
    return {
      primary: [],
      joint: [],
      corporate_guarantors: [],
      individual_guarantors: [],
      officers_by_parent: {}
    };
  }

  const isCorp = (bt) => {
    const t = (bt || '').toLowerCase();
    return ['corporate', 'spv', 'ltd', 'llp', 'limited', 'plc', 'company'].includes(t);
  };

  // Top-level parties vs child officers
  const topLevel = rows.filter(r => !r.parent_borrower_id);
  const officers = rows.filter(r => r.parent_borrower_id);

  // Format a top-level party into a uniform shape for templates
  const formatParty = (b) => ({
    id: b.id,
    full_name: b.full_name,
    borrower_type: b.borrower_type,       // 'corporate' | 'individual' | 'spv' | etc
    company_number: b.company_number,
    nationality: b.nationality,
    email: b.email,
    address: b.address,                    // single TEXT field on deal_borrowers
    kyc_status: b.kyc_status,              // 'pending' | 'submitted' | 'verified' | 'rejected'
    kyc_verified: b.kyc_status === 'verified',
    ch_verified_at: b.ch_verified_at,
    ch_match_confidence: b.ch_match_confidence,
    ch_match_data: b.ch_match_data,
    role: b.role                           // raw role from DB ('primary' | 'joint' | 'guarantor' | etc)
  });

  // Format a child officer — caller filters out resigned_on ≠ null per G5 Q3
  const formatOfficer = (o) => {
    const chData = o.ch_match_data || {};
    // role='psc' (a DB role value) OR ch_match_data.is_psc=true both indicate PSC
    const isPsc = !!chData.is_psc || o.role === 'psc';
    return {
      id: o.id,
      parent_borrower_id: o.parent_borrower_id,
      full_name: o.full_name,
      role: o.role,    // raw DB role — needed by downstream pickers
      role_label: chData.officer_role || o.ch_matched_role || (o.role === 'psc' ? 'PSC' : 'Director'),
      appointed_on: chData.appointed_on,
      resigned_on: chData.resigned_on,
      nationality: o.nationality || chData.nationality,
      is_psc: isPsc,
      psc_percentage: chData.psc_percentage
    };
  };

  // Guarantors split by borrower_type: corporate vs individual
  const primary = topLevel.filter(r => r.role === 'primary').map(formatParty);
  const joint = topLevel.filter(r => r.role === 'joint').map(formatParty);
  const allGuarantors = topLevel.filter(r => r.role === 'guarantor');
  const corporate_guarantors = allGuarantors.filter(r => isCorp(r.borrower_type)).map(formatParty);
  const individual_guarantors = allGuarantors.filter(r => !isCorp(r.borrower_type)).map(formatParty);

  // Group active child officers by parent
  const officers_by_parent = {};
  officers.forEach(o => {
    const formatted = formatOfficer(o);
    if (formatted.resigned_on) return;    // G5 Q3 — active only
    const parentKey = o.parent_borrower_id;
    if (!officers_by_parent[parentKey]) officers_by_parent[parentKey] = [];
    officers_by_parent[parentKey].push(formatted);
  });

  return { primary, joint, corporate_guarantors, individual_guarantors, officers_by_parent };
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIELD LOCK & SNAPSHOT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

// Tier 1 — Identity fields: lock when DIP is signed (borrower has committed)
const TIER1_FIELDS = [
  'borrower_name', 'borrower_company', 'borrower_email', 'borrower_phone',
  'borrower_dob', 'borrower_nationality', 'borrower_jurisdiction', 'borrower_type',
  'company_name', 'company_number',
  'security_address', 'security_postcode', 'asset_type'
];

// Tier 2 — Commercial fields: lock when Indicative Termsheet is generated
const TIER2_FIELDS = [
  'loan_amount', 'ltv_requested', 'current_value', 'term_months',
  'rate_requested', 'purchase_price', 'interest_servicing'
];

// Tier 3 — Supporting detail: lock at bank submission
const TIER3_FIELDS = [
  'exit_strategy', 'loan_purpose', 'use_of_funds', 'refurb_scope',
  'refurb_cost', 'deposit_source', 'drawdown_date', 'existing_charges',
  'property_tenure', 'occupancy_status', 'current_use', 'concurrent_transactions'
];

// Snapshot fields — the core terms we track across stages
const SNAPSHOT_FIELDS = [
  'borrower_name', 'borrower_company', 'company_name',
  'security_address', 'asset_type',
  'loan_amount', 'current_value', 'ltv_requested',
  'rate_requested', 'term_months', 'exit_strategy',
  'interest_servicing', 'loan_purpose'
];

/**
 * Capture a snapshot of critical deal fields at a given gate
 */
function captureSnapshot(dealRow) {
  const snap = { captured_at: new Date().toISOString() };
  for (const field of SNAPSHOT_FIELDS) {
    snap[field] = dealRow[field] ?? null;
  }
  // Also capture DIP terms if they exist (rate, arrangement fee etc from ai_termsheet_data)
  const tsData = typeof dealRow.ai_termsheet_data === 'string'
    ? (() => { try { return JSON.parse(dealRow.ai_termsheet_data); } catch { return {}; } })()
    : (dealRow.ai_termsheet_data || {});
  if (tsData && Object.keys(tsData).length > 0) {
    snap.dip_terms = {
      loan_amount: tsData.loan_amount || null,
      ltv: tsData.ltv || null,
      rate_monthly: tsData.rate_monthly || null,
      arrangement_fee_pct: tsData.arrangement_fee_pct || null,
      term_months: tsData.term_months || null
    };
  }
  return snap;
}

/**
 * Check which fields are locked at the current deal stage.
 * Returns an object { locked: [...fieldNames], reason: string } or null if none locked.
 */
function getLockedFields(deal) {
  const locked = [];
  const reasons = {};

  // After DIP signed → Tier 1 locked
  if (deal.dip_signed) {
    for (const f of TIER1_FIELDS) {
      locked.push(f);
      reasons[f] = 'DIP signed — identity fields locked';
    }
  }

  // After Indicative Termsheet generated → Tier 2 locked
  if (deal.ai_termsheet_generated_at) {
    for (const f of TIER2_FIELDS) {
      locked.push(f);
      reasons[f] = 'Indicative Termsheet issued — commercial fields locked';
    }
  }

  // After bank submission → Tier 3 locked (everything)
  const bankStages = ['bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
  if (bankStages.includes(deal.status)) {
    for (const f of TIER3_FIELDS) {
      locked.push(f);
      reasons[f] = 'Bank submitted — all deal fields locked';
    }
  }

  return { locked, reasons };
}

/**
 * Compare two snapshots and return variances
 */
function compareSnapshots(label1, snap1, label2, snap2) {
  if (!snap1 || !snap2) return [];
  const variances = [];
  const compareFields = [
    { key: 'loan_amount', label: 'Loan Amount', format: 'currency' },
    { key: 'current_value', label: 'Property Value', format: 'currency' },
    { key: 'ltv_requested', label: 'LTV', format: 'pct' },
    { key: 'rate_requested', label: 'Rate', format: 'pct' },
    { key: 'term_months', label: 'Term', format: 'months' },
    { key: 'exit_strategy', label: 'Exit Strategy', format: 'text' },
    { key: 'borrower_name', label: 'Borrower', format: 'text' },
    { key: 'security_address', label: 'Security Address', format: 'text' },
    { key: 'asset_type', label: 'Asset Type', format: 'text' }
  ];
  for (const cf of compareFields) {
    const v1 = snap1[cf.key];
    const v2 = snap2[cf.key];
    if (String(v1 || '') !== String(v2 || '')) {
      variances.push({
        field: cf.label,
        [label1]: v1,
        [label2]: v2,
        format: cf.format
      });
    }
  }
  return variances;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LIST DEALS (dashboard)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { userId, role } = req.user;
    let result;

    // 2026-04-21: include portfolio properties + primary borrower summary so
    // the shared display helpers (deal-display.js) work on list views the
    // same way they work on deal-detail. Without this, list views fall back
    // to legacy flat security_address / borrower_name and portfolio deals
    // like Gold Medal (property data in deal_properties) show '-' in the
    // Security column.
    const propertiesSubquery = `
      COALESCE((
        SELECT json_agg(json_build_object(
          'address', address,
          'postcode', postcode,
          'market_value', market_value,
          'property_type', property_type,
          'tenure', tenure
        ) ORDER BY market_value DESC NULLS LAST, address ASC)
        FROM deal_properties
        WHERE deal_id = d.id
      ), '[]'::json) AS properties
    `;
    const borrowersSubquery = `
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', id,
          'role', role,
          'full_name', full_name,
          'borrower_type', borrower_type,
          'company_name', company_name,
          'company_number', company_number,
          'parent_borrower_id', parent_borrower_id
        ) ORDER BY role = 'primary' DESC, id ASC)
        FROM deal_borrowers
        WHERE deal_id = d.id AND parent_borrower_id IS NULL
      ), '[]'::json) AS borrowers
    `;

    if (['admin', 'credit', 'compliance', 'rm'].includes(role)) {
      // Internal staff see all deals
      result = await pool.query(
        `SELECT d.*, u.first_name AS broker_first, u.last_name AS broker_last, u.email AS broker_email,
                ${propertiesSubquery}, ${borrowersSubquery}
         FROM deal_submissions d
         LEFT JOIN users u ON d.user_id = u.id
         ORDER BY d.created_at DESC`
      );
    } else {
      // Brokers / borrowers see only their own
      result = await pool.query(
        `SELECT d.*, ${propertiesSubquery}, ${borrowersSubquery}
         FROM deal_submissions d
         WHERE d.user_id = $1
         ORDER BY d.created_at DESC`,
        [userId]
      );
    }

    res.json({ deals: result.rows });
  } catch (err) {
    console.error('[deals] List error:', err);
    res.status(500).json({ error: 'Failed to load deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET SINGLE DEAL (broker / borrower view)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { userId, role } = req.user;

    let result;
    if (['admin', 'rm', 'credit', 'compliance'].includes(role)) {
      result = await pool.query('SELECT * FROM deal_submissions WHERE submission_id = $1', [submissionId]);
    } else {
      result = await pool.query('SELECT * FROM deal_submissions WHERE submission_id = $1 AND user_id = $2', [submissionId, userId]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = result.rows[0];

    // Include properties from deal_properties table (source of truth for per-property data)
    const propsResult = await pool.query(
      `SELECT id, address, postcode, property_type, tenure, occupancy, current_use,
              market_value, purchase_price, gdv, reinstatement, day1_ltv, title_number,
              solicitor_firm, solicitor_ref, notes,
              region, country, local_authority, admin_ward, latitude, longitude, in_england_or_wales,
              epc_rating, epc_score, epc_potential_rating, epc_floor_area, epc_property_type,
              epc_built_form, epc_construction_age, epc_habitable_rooms, epc_inspection_date,
              epc_certificate_id, epc_selected_lmk_key,
              last_sale_price, last_sale_date, price_paid_data,
              property_search_data, property_searched_at,
              property_verified_at, property_verified_by
       FROM deal_properties WHERE deal_id = $1 ORDER BY id`,
      [deal.id]
    );
    deal.properties = propsResult.rows;

    // Include borrowers from deal_borrowers table
    const borrowersResult = await pool.query(
      `SELECT id, role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address,
              borrower_type, company_name, company_number, kyc_status,
              ch_matched_role, ch_match_confidence, ch_verified_by, ch_verified_at, ch_match_data,
              gender, id_type, id_number, id_expiry, residential_address, address_proof_status,
              credit_score, credit_score_source, credit_score_date,
              ccj_count, bankruptcy_status, pep_status, sanctions_status,
              source_of_wealth, source_of_funds,
              parent_borrower_id
       FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, id`,
      [deal.id]
    );
    deal.borrowers = borrowersResult.rows;

    // Auto-backfill: if deal_borrowers is empty but flat borrower_name exists, create the primary record
    if (borrowersResult.rows.length === 0 && deal.borrower_name) {
      try {
        const backfill = await pool.query(
          `INSERT INTO deal_borrowers (deal_id, role, full_name, borrower_type, email, phone, date_of_birth, nationality, jurisdiction, company_name, company_number)
           VALUES ($1, 'primary', $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, role, full_name, date_of_birth, nationality, jurisdiction, email, phone, borrower_type, company_name, company_number, kyc_status`,
          [deal.id, deal.borrower_name, deal.borrower_type || null,
           deal.borrower_email || null, deal.borrower_phone || null,
           deal.borrower_dob || null, deal.borrower_nationality || null,
           deal.borrower_jurisdiction || null, deal.company_name || null, deal.company_number || null]
        );
        deal.borrowers = backfill.rows;
        console.log(`[deal-detail] Auto-backfilled primary borrower for deal ${deal.submission_id}: ${deal.borrower_name}`);
      } catch (backfillErr) {
        console.warn('[deal-detail] Borrower backfill note:', backfillErr.message.substring(0, 80));
      }
    }

    // Include portfolio summary
    if (propsResult.rows.length > 0) {
      const totalValue = propsResult.rows.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0);
      deal.portfolio_summary = {
        count: propsResult.rows.length,
        total_value: totalValue,
        postcodes: [...new Set(propsResult.rows.map(p => p.postcode).filter(Boolean))]
      };
    }

    // Include financial schedules (assets, liabilities, income, expenses)
    const financialsResult = await pool.query(
      `SELECT * FROM deal_financials WHERE deal_id = $1 ORDER BY category, created_at`,
      [deal.id]
    );
    deal.financials = financialsResult.rows;

    // Document summary — lets the matrix show sync status
    const docSummary = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(parsed_at)::int AS parsed,
              COUNT(*) FILTER (WHERE parsed_at IS NULL)::int AS unparsed
       FROM deal_documents WHERE deal_id = $1`,
      [deal.id]
    );
    deal.doc_summary = docSummary.rows[0] || { total: 0, parsed: 0, unparsed: 0 };

    res.json({ deal });
  } catch (err) {
    console.error('[deals] Get single deal error:', err);
    res.status(500).json({ error: 'Failed to load deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SUBMIT DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.post('/submit', authenticateToken, validate('dealSubmit'), async (req, res) => {
  try {
    console.log('[deal] Submission from user:', req.user.userId);
    const {
      borrower_name, borrower_company, borrower_email, borrower_phone,
      broker_name, broker_company, broker_fca,
      security_address, security_postcode, asset_type, current_value,
      loan_amount, ltv_requested, loan_purpose, exit_strategy,
      term_months, rate_requested, additional_notes, documents,
      borrower_dob, borrower_nationality, borrower_jurisdiction, borrower_type,
      company_name, company_number, drawdown_date, interest_servicing,
      existing_charges, property_tenure, occupancy_status, current_use,
      purchase_price, use_of_funds, refurb_scope, refurb_cost,
      deposit_source, concurrent_transactions, borrower_invite_email
    } = req.validated;

    // Validation
    if (!security_address || !loan_amount || !loan_purpose) {
      return res.status(400).json({ error: 'Security address, loan amount and loan purpose are required' });
    }

    // Get broker's default_rm if this is a broker submitting
    let assignedRm = null;
    if (req.user.role === 'broker') {
      const brokerOnb = await pool.query(`SELECT default_rm FROM broker_onboarding WHERE user_id = $1`, [req.user.userId]);
      if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
        assignedRm = brokerOnb.rows[0].default_rm;
      }
    }

    // Insert deal
    const result = await pool.query(`
      INSERT INTO deal_submissions (
        user_id, borrower_name, borrower_company, borrower_email, borrower_phone,
        broker_name, broker_company, broker_fca,
        security_address, security_postcode, asset_type, current_value,
        loan_amount, ltv_requested, loan_purpose, exit_strategy,
        term_months, rate_requested, additional_notes, documents, source, internal_status,
        borrower_dob, borrower_nationality, borrower_jurisdiction, borrower_type,
        company_name, company_number, drawdown_date, interest_servicing,
        existing_charges, property_tenure, occupancy_status, current_use,
        purchase_price, use_of_funds, refurb_scope, refurb_cost,
        deposit_source, concurrent_transactions, borrower_invite_email, assigned_rm
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
      RETURNING id, submission_id, status, created_at
    `, [
      req.user.userId,
      borrower_name || null, borrower_company || null, borrower_email || null, borrower_phone || null,
      broker_name || null, broker_company || null, broker_fca || null,
      security_address, security_postcode || null, asset_type || null, current_value || null,
      loan_amount, ltv_requested || null, loan_purpose, exit_strategy || null,
      term_months || null, rate_requested || null, additional_notes || null,
      JSON.stringify(documents || []), 'web_form', 'new',
      borrower_dob || null, borrower_nationality || null, borrower_jurisdiction || null, borrower_type || null,
      company_name || null, company_number || null, drawdown_date || null, interest_servicing || null,
      existing_charges || null, property_tenure || null, occupancy_status || null, current_use || null,
      purchase_price || null, use_of_funds || null, refurb_scope || null, refurb_cost || null,
      deposit_source || null, concurrent_transactions || null,
      borrower_invite_email || null, assignedRm || null
    ]);

    const deal = result.rows[0];
    console.log('[deal] Created:', deal.submission_id);
    // Properties will be parsed by Claude via n8n — no regex here

    // Log audit trail
    await logAudit(deal.id, 'deal_submitted', null, 'received',
      { submitted_by: req.user.userId, loan_amount, security_address, assigned_rm: assignedRm }, req.user.userId);

    res.status(201).json({
      success: true,
      message: 'Deal submitted successfully. Our team will review it shortly.',
      deal: {
        id: deal.id,
        submission_id: deal.submission_id,
        status: deal.status,
        created_at: deal.created_at
      }
    });
  } catch (error) {
    console.error('[deal] Error:', error);
    res.status(500).json({ error: 'Failed to submit deal. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET USER'S DEALS (Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  GET SINGLE DEAL (Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DEAL STATUS (from webhook callback)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  SAVE ONBOARDING DATA (Phase 2 — per tab)
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/onboarding', authenticateToken, validate('dealOnboarding'), async (req, res) => {
  try {
    const { tab, data } = req.validated;
    if (!tab || !data) return res.status(400).json({ error: 'Tab name and data are required' });

    // Valid Phase 2 tabs (6 onboarding sections)
    const validTabs = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    if (!validTabs.includes(tab)) return res.status(400).json({ error: 'Invalid onboarding tab' });

    // Get the deal
    const dealResult = await pool.query(
      'SELECT id, onboarding_data, deal_stage FROM deal_submissions WHERE submission_id = $1 AND user_id = $2',
      [req.params.submissionId, req.user.userId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = dealResult.rows[0];

    // Check if Phase 2 is unlocked (termsheet must be signed)
    const unlockedStages = ['termsheet_signed', 'underwriting', 'approved', 'legal', 'completed'];
    if (!unlockedStages.includes(deal.deal_stage)) {
      return res.status(403).json({ error: 'Onboarding is not yet available. Termsheet must be signed first.' });
    }

    // Merge the tab data into onboarding_data JSONB
    const currentData = deal.onboarding_data || {};
    currentData[tab] = { ...data, updated_at: new Date().toISOString() };

    await pool.query(
      'UPDATE deal_submissions SET onboarding_data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(currentData), deal.id]
    );

    console.log(`[onboarding] Saved tab '${tab}' for deal ${req.params.submissionId}`);
    res.json({ success: true, message: `${tab} data saved successfully` });
  } catch (error) {
    console.error('[onboarding] Error:', error);
    res.status(500).json({ error: 'Failed to save onboarding data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  FEE CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/fee', authenticateToken, authenticateInternal, validate('feeConfirm'), async (req, res) => {
  try {
    const { fee_type, amount, payment_date, payment_ref, notes } = req.validated;
    if (!fee_type || !amount || !payment_date) {
      return res.status(400).json({ error: 'Fee type, amount, and payment date are required' });
    }
    if (!['dip_fee', 'commitment_fee', 'arrangement_fee', 'legal_fee', 'valuation_fee', 'other'].includes(fee_type)) {
      return res.status(400).json({ error: 'Invalid fee type' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Only the assigned RM or admin can confirm fees
    if (req.user.role === 'rm' && deal.assigned_rm !== req.user.userId) {
      return res.status(403).json({ error: 'Only the assigned RM can confirm fees for this deal' });
    }

    // Record the payment
    await pool.query(
      `INSERT INTO deal_fee_payments (deal_id, fee_type, amount, payment_date, payment_ref, notes, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deal.id, fee_type, amount, payment_date, payment_ref || null, notes || null, req.user.userId]
    );

    // Update deal flags
    if (fee_type === 'dip_fee') {
      await pool.query(`UPDATE deal_submissions SET dip_fee_confirmed = true, dip_fee_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id]);
    }
    if (fee_type === 'commitment_fee') {
      await pool.query(`UPDATE deal_submissions SET commitment_fee_received = true, commitment_fee_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id]);
    }

    await logAudit(deal.id, `fee_confirmed_${fee_type}`, null, String(amount),
      { fee_type, amount, payment_date, payment_ref, confirmed_by: req.user.userId }, req.user.userId);

    res.json({ success: true, message: `${fee_type.replace('_', ' ')} of £${amount} confirmed` });
  } catch (error) {
    console.error('[fee] Error:', error);
    res.status(500).json({ error: 'Failed to confirm fee' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DEAL STAGE (Internal)
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/stage', authenticateToken, authenticateInternal, validate('dealStageUpdate'), async (req, res) => {
  try {
    const { new_stage, comments } = req.validated;
    const validStages = ['dip', 'dip_issued', 'termsheet_sent', 'termsheet_signed', 'underwriting', 'credit_review', 'compliance_review', 'approved', 'legal', 'funds_released', 'declined', 'withdrawn'];
    if (!validStages.includes(new_stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const oldStage = deal.deal_stage;

    // Only assigned RM or admin can advance stage
    if (req.user.role === 'rm' && deal.assigned_rm !== req.user.userId) {
      return res.status(403).json({ error: 'Only the assigned RM can advance this deal' });
    }

    // Business rules
    if (new_stage === 'underwriting' && !deal.dip_fee_confirmed) {
      // Check if DIP fee has been confirmed
      const feeCheck = await pool.query(`SELECT dip_fee_confirmed FROM deal_submissions WHERE id = $1`, [deal.id]);
      if (!feeCheck.rows[0].dip_fee_confirmed) {
        return res.status(400).json({ error: 'DIP fee must be confirmed before moving to underwriting' });
      }
    }

    // Final approval can only be done by admin
    if (['approved', 'declined'].includes(new_stage) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only Admin can make the final lending decision' });
    }

    await pool.query(
      `UPDATE deal_submissions SET deal_stage = $1,
       termsheet_signed_at = CASE WHEN $1 = 'termsheet_signed' THEN NOW() ELSE termsheet_signed_at END,
       submitted_to_credit_at = CASE WHEN $1 = 'underwriting' THEN NOW() ELSE submitted_to_credit_at END,
       submitted_to_compliance_at = CASE WHEN $1 = 'compliance_review' THEN NOW() ELSE submitted_to_compliance_at END,
       final_decision = CASE WHEN $1 IN ('approved', 'declined') THEN $1 ELSE final_decision END,
       final_decision_by = CASE WHEN $1 IN ('approved', 'declined') THEN $2 ELSE final_decision_by END,
       final_decision_at = CASE WHEN $1 IN ('approved', 'declined') THEN NOW() ELSE final_decision_at END,
       status = CASE WHEN $1 = 'approved' THEN 'completed' WHEN $1 = 'declined' THEN 'declined' ELSE status END,
       updated_at = NOW()
       WHERE id = $3`,
      [new_stage, req.user.userId, deal.id]
    );

    await logAudit(deal.id, 'stage_advanced', oldStage, new_stage,
      { comments, advanced_by: req.user.userId, role: req.user.role }, req.user.userId);

    res.json({ success: true, message: `Deal stage updated to ${new_stage}`, from: oldStage, to: new_stage });
  } catch (error) {
    console.error('[stage] Error:', error);
    res.status(500).json({ error: 'Failed to update deal stage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RECOMMENDATION
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/recommendation', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { decision, comments } = req.body;
    if (!['approve', 'decline', 'more_info'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approve, decline, or more_info' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_credit, assigned_compliance FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    let approvalStage = '';
    let updateCol = '';

    if (req.user.role === 'rm') {
      approvalStage = 'rm_recommendation';
      updateCol = 'rm_recommendation';
    } else if (req.user.role === 'credit') {
      approvalStage = 'credit_review';
      updateCol = 'credit_recommendation';
      if (deal.assigned_credit && deal.assigned_credit !== req.user.userId) {
        return res.status(403).json({ error: 'You are not the assigned Credit Analyst for this deal' });
      }
    } else if (req.user.role === 'compliance') {
      approvalStage = 'compliance_review';
      updateCol = 'compliance_recommendation';
      if (deal.assigned_compliance && deal.assigned_compliance !== req.user.userId) {
        return res.status(403).json({ error: 'You are not the assigned Compliance officer for this deal' });
      }
    } else if (req.user.role === 'admin') {
      // Admin can act as any role
      approvalStage = req.body.stage || 'admin_decision';
      updateCol = 'final_decision';
    }

    // Record the approval
    await pool.query(
      `INSERT INTO deal_approvals (deal_id, approval_stage, decision, comments, decided_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [deal.id, approvalStage, decision, comments || null, req.user.userId]
    );

    // Update the deal's recommendation field
    if (updateCol) {
      await pool.query(`UPDATE deal_submissions SET ${updateCol} = $1, updated_at = NOW() WHERE id = $2`, [decision, deal.id]);
    }

    await logAudit(deal.id, `recommendation_${approvalStage}`, null, decision,
      { decision, comments, decided_by: req.user.userId, role: req.user.role }, req.user.userId);

    res.json({ success: true, message: `${approvalStage} recorded: ${decision}` });
  } catch (error) {
    console.error('[recommendation] Error:', error);
    res.status(500).json({ error: 'Failed to record recommendation' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  GET FEES
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  ISSUE DIP — Generates PDF, uploads to OneDrive, borrower accepts in-portal
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-ROUTE PREVIEW (DA Session 2d, 2026-04-20)
//  Read-only: returns how the deal WOULD route if Issue DIP was clicked now.
//  No DB writes, no PDF, no email. Feeds the matrix pre-flight modal so the
//  RM can see the rule-by-rule verdict before committing.
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  DIP Section Approval Gates (M4a, 2026-04-20) — Matrix-SSOT for DIP
//  Five sections that RM must individually approve before Issue DIP fires:
//    borrower, security, loan_terms, fees, conditions
//  Each stamp = {approved BOOLEAN, by INT ref users(id), at TIMESTAMPTZ}.
//  matrix-fields PUT already auto-revokes stamps when referenced data changes
//  (see AUTO_REVOKE_MAP in the /matrix-fields handler).
//
//  Issue DIP endpoint will check all 5 are TRUE before allowing DIP to go out.
//  Credit Decision (6th section) is separate and only applies when auto-route
//  requires credit review — handled by the existing credit-decision endpoint.
// ═══════════════════════════════════════════════════════════════════════════
const VALID_DIP_SECTIONS = [
  'borrower', 'security',
  // M4d (2026-04-20): UoF + Exit are their own gates; sit BEFORE loan_terms
  // in the RM's mental model because you price a loan after understanding
  // purpose and exit, not before.
  'use_of_funds', 'exit_strategy',
  'loan_terms', 'fees', 'conditions'
];

async function _handleDipApproval(req, res, approve) {
  try {
    const { section } = req.body || {};
    if (!section || !VALID_DIP_SECTIONS.includes(section)) {
      return res.status(400).json({
        error: 'Invalid section. Must be one of: ' + VALID_DIP_SECTIONS.join(', ')
      });
    }
    const col = 'dip_' + section + '_approved';
    const byCol = col + '_by';
    const atCol = col + '_at';

    const dealRes = await pool.query(
      `SELECT id, deal_stage FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealRes.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealRes.rows[0].id;

    // Placeholders numbered starting at $1 in each branch. Approve needs userId;
    // unapprove only needs dealId (NULL is set as SQL literal, not a param).
    const sql = approve
      ? `UPDATE deal_submissions SET ${col} = TRUE, ${byCol} = $1, ${atCol} = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING ${col}, ${byCol}, ${atCol}`
      : `UPDATE deal_submissions SET ${col} = FALSE, ${byCol} = NULL, ${atCol} = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING ${col}, ${byCol}, ${atCol}`;
    const params = approve ? [req.user.userId, dealId] : [dealId];
    const r = await pool.query(sql, params);

    await logAudit(
      dealId,
      approve ? 'dip_section_approved' : 'dip_section_unapproved',
      null, section,
      { section, by: req.user.userId, role: req.user.role },
      req.user.userId
    );

    res.json({
      success: true,
      section,
      approved: !!r.rows[0][col],
      by: r.rows[0][byCol],
      at: r.rows[0][atCol]
    });
  } catch (error) {
    console.error('[dip-section-approval] Error:', error);
    res.status(500).json({
      error: 'Failed to update DIP section approval',
      detail: error.message,
      code: error.code || null
    });
  }
}

router.post('/:submissionId/dip-approve-section', authenticateToken, authenticateInternal,
  (req, res) => _handleDipApproval(req, res, true));
router.post('/:submissionId/dip-unapprove-section', authenticateToken, authenticateInternal,
  (req, res) => _handleDipApproval(req, res, false));

// ═══════════════════════════════════════════════════════════════════════════
//  Credit Decision on DIP (M4c, 2026-04-20) — Hybrid model
//  Shown on DIPs where auto-route flagged credit_review. Credit can:
//    - Approve: greenlights the DIP; broker email fires downstream
//    - Decline: kills the deal
//    - More Info: bounces back to RM with notes, no broker email
//  Credit can ALSO override the following matrix fields at decision time:
//    - rate_approved, ltv_approved, arrangement_fee_pct
//  Overrides write through to matrix (SSOT preserved). Matrix auto-revoke
//  then fires on dip_loan_terms_approved / dip_fees_approved so RM sees the
//  re-approval demand if they look back at the form.
//
//  Access: 'credit' or 'admin' roles only. RM cannot set Credit Decision.
// ═══════════════════════════════════════════════════════════════════════════
const VALID_CREDIT_DECISIONS = ['approved', 'declined', 'more_info'];

router.post('/:submissionId/dip-credit-decision', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    // Role gate — only Credit + Admin can set this (not RM)
    if (!['credit', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only Credit or Admin can record a Credit Decision.' });
    }

    const { decision, notes, overrides } = req.body || {};
    if (!decision || !VALID_CREDIT_DECISIONS.includes(decision)) {
      return res.status(400).json({
        error: 'Invalid decision. Must be one of: ' + VALID_CREDIT_DECISIONS.join(', ')
      });
    }

    const dealRes = await pool.query(
      `SELECT id, deal_stage, auto_routed, user_id, submission_id, dip_broker_notified_at,
              status, loan_amount, loan_amount_approved, borrower_name, dip_issued_at
       FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealRes.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealRow = dealRes.rows[0];
    const dealId = dealRow.id;

    // Apply matrix overrides first (if provided) — these revoke dependent approvals
    // via the existing matrix-fields PUT pattern (audit consistency + auto-revoke).
    const allowedOverrides = ['rate_approved', 'ltv_approved', 'arrangement_fee_pct'];
    const overrideFields = [];
    const overrideValues = [];
    let i = 1;
    if (overrides && typeof overrides === 'object') {
      for (const key of allowedOverrides) {
        if (overrides[key] != null && overrides[key] !== '') {
          const n = parseFloat(String(overrides[key]).replace(/,/g, ''));
          if (isFinite(n)) {
            overrideFields.push(`${key} = $${i++}`);
            overrideValues.push(n);
          }
        }
      }
    }

    // Build the decision SQL
    const setParts = ['dip_credit_decision = $' + (i++), 'dip_credit_decided_by = $' + (i++),
      'dip_credit_decided_at = NOW()', 'dip_credit_notes = $' + (i++), 'updated_at = NOW()'];
    const params = [...overrideValues, decision, req.user.userId, notes || null];

    // Combine overrides + decision into a single UPDATE
    const allSet = [...overrideFields, ...setParts].join(', ');

    // If Credit overrode any matrix field, also revoke the dependent approval stamps
    // (loan_terms and/or fees) so RM sees the change and re-approves if still on the form.
    if (overrideFields.length > 0) {
      const touchedLoan = overrideFields.some(f => f.startsWith('rate_approved') || f.startsWith('ltv_approved'));
      const touchedFees = overrideFields.some(f => f.startsWith('arrangement_fee_pct'));
      if (touchedLoan) setParts.push('dip_loan_terms_approved = FALSE', 'dip_loan_terms_approved_by = NULL', 'dip_loan_terms_approved_at = NULL');
      if (touchedFees) setParts.push('dip_fees_approved = FALSE', 'dip_fees_approved_by = NULL', 'dip_fees_approved_at = NULL');
    }

    params.push(dealId);
    const sql = `UPDATE deal_submissions
                 SET ${[...overrideFields, ...setParts].join(', ')}
                 WHERE id = $${i}
                 RETURNING dip_credit_decision, dip_credit_decided_by, dip_credit_decided_at, dip_credit_notes,
                           rate_approved, ltv_approved, arrangement_fee_pct, auto_routed`;

    const r = await pool.query(sql, params);

    await logAudit(
      dealId, 'dip_credit_decision', null, decision,
      {
        decision,
        notes: notes ? notes.substring(0, 200) : null,
        overrides_applied: overrideFields.length > 0 ? Object.keys(overrides).filter(k => allowedOverrides.includes(k)) : [],
        role: req.user.role
      },
      req.user.userId
    );

    // ── M5-2: On approval, fire broker email if we haven't already ──
    // Idempotency: dip_broker_notified_at guards against double-send if Credit
    // accidentally re-clicks approve or if something loops.
    let brokerNotified = false;
    if (decision === 'approved' && !dealRow.dip_broker_notified_at) {
      try {
        const brokerRes = await pool.query(`SELECT email FROM users WHERE id = $1`, [dealRow.user_id]);
        if (brokerRes.rows.length > 0 && brokerRes.rows[0].email) {
          // Re-fetch minimal deal row for notifyDealEvent payload
          const dealForEmail = Object.assign({}, dealRow, {
            submission_id: dealRow.submission_id || req.params.submissionId,
            status: dealRow.status || 'dip_issued'
          });
          await notifyDealEvent('dip_issued', dealForEmail, [brokerRes.rows[0].email]);
          await pool.query(`UPDATE deal_submissions SET dip_broker_notified_at = NOW() WHERE id = $1`, [dealId]);
          brokerNotified = true;
          console.log(`[dip-credit-decision] Broker notified on Credit approve for ${req.params.submissionId}`);
        }
      } catch (emailErr) {
        // Non-blocking — decision is already recorded. Log and continue.
        console.error('[dip-credit-decision] Broker email failed (non-blocking):', emailErr.message);
      }
    } else if (decision === 'approved' && dealRow.dip_broker_notified_at) {
      console.log(`[dip-credit-decision] Broker already notified at ${dealRow.dip_broker_notified_at} — skipping`);
    }

    res.json({
      success: true,
      decision,
      decided_by: r.rows[0].dip_credit_decided_by,
      decided_at: r.rows[0].dip_credit_decided_at,
      overrides_applied: overrideFields.length > 0,
      broker_notified: brokerNotified,
      row: r.rows[0],
      message: decision === 'approved'
        ? (brokerNotified ? 'Credit approved — broker notified.' : 'Credit approved — broker was already notified.')
        : decision === 'declined'
          ? 'Credit declined — deal will not proceed until RM addresses concerns.'
          : 'More info requested — RM will see the notes and can update the deal.'
    });
  } catch (error) {
    console.error('[dip-credit-decision] Error:', error);
    res.status(500).json({
      error: 'Failed to record Credit Decision',
      detail: error.message,
      code: error.code || null
    });
  }
});

router.get('/:submissionId/auto-route-preview', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    const [borrowersResult, propertiesResult, cfgResult] = await Promise.all([
      pool.query(
        `SELECT id, full_name, role, borrower_type, company_number, parent_borrower_id,
                ch_match_data, pep_status, sanctions_status
         FROM deal_borrowers WHERE deal_id = $1`,
        [dealId]
      ),
      pool.query(
        `SELECT id, address, postcode, market_value, property_type
         FROM deal_properties WHERE deal_id = $1`,
        [dealId]
      ),
      pool.query(`SELECT * FROM admin_config WHERE id = 1`)
    ]);

    const dealForEval = Object.assign({}, deal, {
      borrowers: borrowersResult.rows,
      properties: enrichPropertiesForEvaluator(propertiesResult.rows, deal)
    });
    const cfg = cfgResult.rows[0] || null;

    const result = evaluateAutoRoute(dealForEval, cfg);

    res.json({
      success: true,
      preview: {
        eligible: result.eligible,
        decision: result.decision,
        summary: result.summary,
        rules: result.rules,
        config_snapshot: cfg ? {
          enabled: cfg.auto_approve_enabled,
          max_loan: cfg.auto_approve_max_loan,
          max_ltv_pct: cfg.auto_approve_max_ltv_pct,
          asset_types: cfg.auto_approve_asset_types
        } : null
      }
    });
  } catch (error) {
    console.error('[auto-route-preview] Error:', error);
    res.status(500).json({ error: 'Failed to evaluate auto-route preview' });
  }
});

router.post('/:submissionId/issue-dip', authenticateToken, authenticateInternal, validate('issueDip'), async (req, res) => {
  try {
    const { notes, dip_data } = req.validated;

    // 1. Fetch full deal data
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;
    const userId = deal.user_id;

    // ── M5-1 (2026-04-20): Matrix-SSOT — prefer matrix _approved columns over dip_data.
    // Priority order for each field:
    //   1. deal.<field>_approved  (matrix canonical — RM-approved value)
    //   2. dip_data.<field>       (legacy form override, back-compat)
    //   3. deal.<legacy column>   (very old data)
    const _matrixOrForm = (approvedVal, dipDataVal, legacyVal) => {
      if (approvedVal != null && approvedVal !== '') return approvedVal;
      if (dipDataVal != null && dipDataVal !== '') return dipDataVal;
      return legacyVal;
    };

    // ── M5-1: 7-APPROVAL GATE — prevent direct-API bypass of DIP form approval UI ──
    const REQUIRED_APPROVALS = [
      { col: 'dip_borrower_approved',      label: 'Borrower & Guarantors' },
      { col: 'dip_security_approved',      label: 'Security & Properties' },
      { col: 'dip_use_of_funds_approved',  label: 'Use of Funds & Purpose' },
      { col: 'dip_exit_strategy_approved', label: 'Exit Strategy' },
      { col: 'dip_loan_terms_approved',    label: 'Loan Terms (Approved)' },
      { col: 'dip_fees_approved',          label: 'Fee Schedule' },
      { col: 'dip_conditions_approved',    label: 'Conditions & Notes' }
    ];
    const missingApprovals = REQUIRED_APPROVALS.filter(a => !deal[a.col]);
    if (missingApprovals.length > 0) {
      console.log('[issue-dip] BLOCKED — missing approvals:', missingApprovals.map(m => m.col).join(', '));
      return res.status(400).json({
        error: 'DIP cannot be issued — section approvals incomplete',
        missing_approvals: missingApprovals.map(m => m.label),
        message: 'The following DIP sections have not been approved: ' + missingApprovals.map(m => m.label).join(', ') + '. Approve them in the DIP Section Approvals block before issuing.'
      });
    }

    // ── AUTOMATED GUARDRAILS — hard blocks based on Daksfirst lending criteria ──
    const guardrailErrors = [];
    const dipLoan = parseFloat(_matrixOrForm(deal.loan_amount_approved, dip_data?.loan_amount, deal.loan_amount) || 0);
    const dipLtv = parseFloat(_matrixOrForm(deal.ltv_approved, dip_data?.ltv, deal.ltv_requested) || 0);
    const dipRate = parseFloat(_matrixOrForm(deal.rate_approved, dip_data?.rate_monthly, deal.rate_requested) || 0);
    const dipTerm = parseInt(_matrixOrForm(deal.term_months_approved, dip_data?.term_months, deal.term_months) || 0);
    const assetType = String(_matrixOrForm(null, dip_data?.asset_type, deal.asset_type) || '').toLowerCase();
    const loanPurpose = String(_matrixOrForm(null, dip_data?.loan_purpose, deal.loan_purpose) || '').toLowerCase();

    // Loan size: £500k – £15m
    if (dipLoan < 500000) guardrailErrors.push(`Loan amount £${(dipLoan).toLocaleString()} is below minimum £500,000`);
    if (dipLoan > 15000000) guardrailErrors.push(`Loan amount £${(dipLoan).toLocaleString()} exceeds maximum £15,000,000`);

    // Max LTV: 75% net day 1
    if (dipLtv > 75) guardrailErrors.push(`LTV ${dipLtv.toFixed(1)}% exceeds maximum 75%. Reduce loan amount or increase valuation.`);

    // Minimum rate: 0.85%/month
    if (dipRate > 0 && dipRate < 0.85) guardrailErrors.push(`Rate ${dipRate.toFixed(2)}%/month is below minimum 0.85%/month`);

    // Term: 3–24 months
    if (dipTerm > 0 && dipTerm < 3) guardrailErrors.push(`Term ${dipTerm} months is below minimum 3 months`);
    if (dipTerm > 24) guardrailErrors.push(`Term ${dipTerm} months exceeds maximum 24 months`);

    // Excluded asset types
    const excludedAssets = ['agricultural', 'farm', 'overseas'];
    if (excludedAssets.some(ex => assetType.includes(ex))) {
      guardrailErrors.push(`Asset type "${assetType}" is outside Daksfirst lending criteria`);
    }

    // Excluded loan purposes
    if (loanPurpose.includes('development') && !loanPurpose.includes('exit')) {
      guardrailErrors.push(`Ground-up development is outside Daksfirst lending criteria. Only development exit is permitted.`);
    }

    if (guardrailErrors.length > 0) {
      console.log('[issue-dip] GUARDRAIL BLOCKED:', guardrailErrors.join('; '));
      return res.status(400).json({
        error: 'Deal falls outside lending criteria',
        guardrail_errors: guardrailErrors,
        message: guardrailErrors.join('\n')
      });
    }

    // 2. Get borrowers + properties for this deal (for the DIP PDF)
    // G5: expanded SELECT to return fields needed for Option B party rendering
    const borrowersResult = await pool.query(
      `SELECT id, full_name, role, email, kyc_status, borrower_type, company_number,
              nationality, address, parent_borrower_id,
              ch_verified_at, ch_matched_role, ch_match_confidence, ch_match_data,
              pg_status, pg_limit_amount, pg_notes
       FROM deal_borrowers WHERE deal_id = $1
       ORDER BY
         CASE role
           WHEN 'primary' THEN 1
           WHEN 'joint' THEN 2
           WHEN 'guarantor' THEN 3
           WHEN 'director' THEN 4
           ELSE 5
         END,
         parent_borrower_id NULLS FIRST,
         id`,
      [dealId]
    );
    const propertiesResult = await pool.query(
      `SELECT id, address, postcode, market_value, property_type, tenure, security_charge_type, existing_charges_note, loan_purpose, existing_charge_balance_pence FROM deal_properties WHERE deal_id = $1 ORDER BY id`,
      [dealId]
    );
    // G5: build both legacy flat array (backward compat) + new grouped structure
    const flatBorrowers = borrowersResult.rows.map(b => ({
      name: b.full_name,
      role: b.role,
      email: b.email,
      kyc_verified: b.kyc_status === 'verified'
    }));
    const partiesGrouped = groupBorrowersForDip(borrowersResult.rows, deal);

    const dipDataWithBorrowers = {
      ...dip_data,
      notes,
      borrowers: flatBorrowers,               // legacy, current generator reads this
      parties_grouped: partiesGrouped,        // G5 new structure, G5.2+ generators will use
      properties: propertiesResult.rows
    };

    // 3. Generate DIP PDF (branded)
    console.log('[issue-dip] Generating DIP PDF for', req.params.submissionId);
    const pdfBuffer = await generateDipPdf(deal, dipDataWithBorrowers, {
      issuedBy: req.user.userId,
      issuedAt: new Date().toISOString()
    });
    // Deal ref format: DF-YYMM-XXXX
    const createdDate = deal.created_at ? new Date(deal.created_at) : new Date();
    const yy = String(createdDate.getFullYear()).slice(-2);
    const mm = String(createdDate.getMonth() + 1).padStart(2, '0');
    const shortId = (deal.submission_id || req.params.submissionId).substring(0, 4).toUpperCase();
    const dealRef = `DF-${yy}${mm}-${shortId}`;
    const pdfFilename = `DIP-${dealRef}.pdf`;

    // 4. Upload DIP PDF to OneDrive
    let dipPdfUrl = null;
    try {
      const graphToken = await getGraphToken();
      const uploadResult = await uploadFileToOneDrive(graphToken, req.params.submissionId, pdfFilename, pdfBuffer);
      dipPdfUrl = uploadResult.downloadUrl;
      console.log('[issue-dip] DIP PDF uploaded to OneDrive:', dipPdfUrl);
    } catch (uploadErr) {
      console.error('[issue-dip] OneDrive upload failed (non-blocking):', uploadErr.message);
    }

    // ── 4.5: Delegated Authority evaluation (2026-04-20, Session 2c) ──
    // Evaluate whether this DIP auto-routes to broker or holds for Credit review.
    // Decision stored on the deal row; broker email gated downstream.
    let autoRouteDecision = { eligible: false, decision: 'credit_review', summary: 'not_evaluated', rules: [] };
    let autoRouted = false;
    try {
      const cfgResult = await pool.query(`SELECT * FROM admin_config WHERE id = 1`);
      const cfg = cfgResult.rows[0] || null;
      // Build evaluation-time deal with latest dip overrides + loaded borrowers/properties
      // Properties need enrichment (asset_type + country) since deal_properties has neither column
      const dealForEval = Object.assign({}, deal, {
        loan_amount: dipLoan || deal.loan_amount,
        asset_type: assetType || deal.asset_type,  // dip form override takes precedence
        borrowers: borrowersResult.rows,
        properties: enrichPropertiesForEvaluator(propertiesResult.rows, { asset_type: assetType || deal.asset_type })
      });
      autoRouteDecision = evaluateAutoRoute(dealForEval, cfg);
      autoRouted = autoRouteDecision.eligible === true;
      console.log(`[issue-dip] Auto-route decision for ${req.params.submissionId}: ${autoRouteDecision.decision} (${autoRouteDecision.summary})`);
    } catch (evalErr) {
      // On evaluator failure, fall back to Credit review (safe default)
      console.warn('[issue-dip] Auto-route evaluation failed, defaulting to credit_review:', evalErr.message);
      autoRouteDecision = { eligible: false, decision: 'credit_review', summary: 'evaluator_error', rules: [], error: evalErr.message };
      autoRouted = false;
    }

    // 5. Update deal in database
    // Stage stays 'dip_issued' regardless of routing — auto_routed carries the decision.
    // (Introducing 'pending_credit' as a new stage was deferred to avoid UI breakage;
    //  Credit dashboard filters on auto_routed=false to surface deals needing review.)
    const updateFields = [
      `status = 'dip_issued'`,
      `deal_stage = 'dip_issued'`,
      `dip_issued_at = NOW()`,
      `dip_issued_by = $1`,
      `dip_notes = $2`,
      `dip_pdf_url = $3`,
      `dip_signed = false`,
      `auto_routed = $4`,
      `auto_route_reason = $5::jsonb`,
      `auto_route_decision_at = NOW()`,
      `updated_at = NOW()`
    ];
    const updateValues = [
      req.user.userId, notes || null, dipPdfUrl || null,
      autoRouted, JSON.stringify(compactReason(autoRouteDecision))
    ];
    let paramIdx = 6;

    // Store structured DIP data
    if (dip_data) {
      updateFields.push(`ai_termsheet_data = $${paramIdx}`);
      updateValues.push(JSON.stringify(dip_data));
      paramIdx++;

      // Also update core deal fields from DIP data — these are the single source of truth
      // that the matrix and other views read from (SSOT pass 2, 2026-04-20)
      const fieldMap = {
        loan_amount: 'loan_amount',
        ltv: 'ltv_requested',
        term_months: 'term_months',
        rate_monthly: 'rate_requested',
        property_value: 'current_value',
        exit_strategy: 'exit_strategy',
        interest_servicing: 'interest_servicing',
        // Fee fields — keep matrix in sync with whatever was finally issued on the DIP
        arrangement_fee_pct: 'arrangement_fee_pct',
        broker_fee_pct: 'broker_fee_pct',
        retained_months: 'retained_interest_months',
        fee_commitment: 'commitment_fee',
        // G5: Share Charge election from DIP form mirrors to matrix column
        requires_share_charge: 'requires_share_charge'
      };
      for (const [dipKey, dbCol] of Object.entries(fieldMap)) {
        if (dip_data[dipKey] !== undefined) {
          updateFields.push(`${dbCol} = $${paramIdx}`);
          updateValues.push(dip_data[dipKey]);
          paramIdx++;
        }
      }
    }

    updateValues.push(dealId);
    const result = await pool.query(
      `UPDATE deal_submissions SET ${updateFields.join(', ')} WHERE id = $${paramIdx} RETURNING submission_id, status, dip_issued_at`,
      updateValues
    );

    // 6. Store DIP PDF in deal_documents as 'issued' category (appears in doc repo)
    try {
      const issuerName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email;
      await pool.query(
        `INSERT INTO deal_documents
         (deal_id, filename, file_type, file_size, file_content, doc_category,
          category_confirmed_by, category_confirmed_at, category_confirmed_name,
          onedrive_download_url)
         VALUES ($1, $2, $3, $4, $5, 'issued', $6, NOW(), $7, $8)`,
        [dealId, pdfFilename, 'application/pdf', pdfBuffer.length, pdfBuffer,
         req.user.userId, issuerName, dipPdfUrl]
      );
      console.log('[issue-dip] DIP PDF stored in deal_documents as issued');
    } catch (docErr) {
      console.error('[issue-dip] Could not store DIP in deal_documents:', docErr.message);
    }

    await logAudit(dealId, 'dip_issued', deal.status, 'dip_issued', {
      issued_by: req.user.userId,
      dip_data_stored: !!dip_data,
      pdf_generated: !!pdfBuffer,
      pdf_uploaded: !!dipPdfUrl,
      // DA Session 2c — capture routing outcome in audit log
      auto_routed: autoRouted,
      auto_route_summary: autoRouteDecision.summary
    }, req.user.userId);

    // Notify broker via email — only if auto-routed (Credit review deals hold).
    // M5-2: stamp dip_broker_notified_at so we don't double-send when credit-approve fires.
    if (autoRouted) {
      const brokerEmailResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (brokerEmailResult.rows.length > 0) {
        await notifyDealEvent('dip_issued', result.rows[0], [brokerEmailResult.rows[0].email]);
        await pool.query(`UPDATE deal_submissions SET dip_broker_notified_at = NOW() WHERE id = $1`, [dealId]);
        console.log(`[issue-dip] Broker notified (auto-routed) for ${req.params.submissionId}`);
      }
    } else {
      console.log(`[issue-dip] Broker NOT notified — deal ${req.params.submissionId} held for Credit review. Reason: ${autoRouteDecision.summary}`);
    }

    res.json({
      success: true,
      deal: result.rows[0],
      pdf_url: dipPdfUrl,
      // DA Session 2c — surface the routing decision so the matrix pre-flight
      // and RM feedback can reflect what happened
      auto_routed: autoRouted,
      decision: autoRouteDecision.decision,
      summary: autoRouteDecision.summary,
      rules: autoRouteDecision.rules
    });
  } catch (error) {
    console.error('[issue-dip] Error:', error);
    res.status(500).json({ error: 'Failed to issue DIP' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  VIEW DIP PDF — On-the-fly generation (v4.2)
//  TODO: Once template is confirmed correct, switch to canonical stored PDF
//  serving from deal_documents to guarantee document integrity.
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  DIP PREVIEW HTML (2026-04-21) — returns the same HTML that generates the
//  final PDF, but with data-approval-section attrs added to each section
//  wrapper. Frontend renders this into the DIP Form container and overlays
//  per-section approve/unapprove buttons. Zero drift between preview and PDF.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/dip-preview-html', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Access control — same rules as /dip-pdf
    const internalRoles = ['admin', 'rm', 'credit', 'compliance'];
    const isInternal = internalRoles.includes(req.user.role);
    const isOwner = deal.user_id === req.user.userId;
    const isBorrower = deal.borrower_email === req.user.email || deal.borrower_invite_email === req.user.email;
    if (!isInternal && !isOwner && !isBorrower) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // dipData from stored ai_termsheet_data
    const dipData = typeof deal.ai_termsheet_data === 'string'
      ? JSON.parse(deal.ai_termsheet_data) : (deal.ai_termsheet_data || {});

    // Apply credit overrides (preview matches final issue-dip output)
    if (dipData.credit_override_rate !== undefined) dipData.rate_monthly = dipData.credit_override_rate;
    if (dipData.credit_override_ltv !== undefined) dipData.ltv = dipData.credit_override_ltv;
    if (dipData.credit_override_arr_fee !== undefined) {
      dipData.arrangement_fee = dipData.credit_override_arr_fee;
      dipData.arrangement_fee_pct = dipData.credit_override_arr_fee;
    }

    // Borrowers for Parties block
    const borrowersResult = await pool.query(
      `SELECT id, full_name, role, email, kyc_status, borrower_type, company_number, company_name,
              nationality, address, parent_borrower_id,
              ch_verified_at, ch_matched_role, ch_match_confidence, ch_match_data,
              pg_status, pg_limit_amount, pg_notes
       FROM deal_borrowers WHERE deal_id = $1
       ORDER BY
         CASE role WHEN 'primary' THEN 1 WHEN 'joint' THEN 2 WHEN 'guarantor' THEN 3 WHEN 'director' THEN 4 ELSE 5 END,
         parent_borrower_id NULLS FIRST, id`,
      [dealId]
    );

    // Properties
    const propertiesResult = await pool.query(
      `SELECT id, address, postcode, market_value, property_type, tenure, security_charge_type, existing_charges_note,
              loan_purpose, existing_charge_balance_pence
       FROM deal_properties WHERE deal_id = $1 ORDER BY market_value DESC NULLS LAST, id`,
      [dealId]
    );

    const flatBorrowers = borrowersResult.rows.map(b => ({
      name: b.full_name, role: b.role, email: b.email, kyc_verified: b.kyc_status === 'verified'
    }));
    const partiesGrouped = groupBorrowersForDip(borrowersResult.rows, deal);

    const dipDataFull = {
      ...dipData,
      borrowers: flatBorrowers,
      parties_grouped: partiesGrouped,
      properties: propertiesResult.rows
    };

    // Build the HTML with approval-section attrs for in-app preview
    const html = buildDipHtml(deal, dipDataFull, { forPreview: true });

    // Current approval state per section — frontend renders overlay badges
    const approvals = {
      borrower: {
        approved: !!deal.dip_borrower_approved,
        approved_at: deal.dip_borrower_approved_at || null,
        approved_by: deal.dip_borrower_approved_by || null
      },
      security: {
        approved: !!deal.dip_security_approved,
        approved_at: deal.dip_security_approved_at || null,
        approved_by: deal.dip_security_approved_by || null
      },
      loan_terms: {
        approved: !!deal.dip_loan_terms_approved,
        approved_at: deal.dip_loan_terms_approved_at || null,
        approved_by: deal.dip_loan_terms_approved_by || null
      },
      use_of_funds: {
        approved: !!deal.dip_use_of_funds_approved,
        approved_at: deal.dip_use_of_funds_approved_at || null,
        approved_by: deal.dip_use_of_funds_approved_by || null
      },
      exit_strategy: {
        approved: !!deal.dip_exit_strategy_approved,
        approved_at: deal.dip_exit_strategy_approved_at || null,
        approved_by: deal.dip_exit_strategy_approved_by || null
      },
      fees: {
        approved: !!deal.dip_fees_approved,
        approved_at: deal.dip_fees_approved_at || null,
        approved_by: deal.dip_fees_approved_by || null
      },
      conditions: {
        approved: !!deal.dip_conditions_approved,
        approved_at: deal.dip_conditions_approved_at || null,
        approved_by: deal.dip_conditions_approved_by || null
      }
    };

    res.json({ html, approvals });
  } catch (err) {
    console.error('[dip-preview-html] Error:', err);
    res.status(500).json({ error: 'Failed to build DIP preview' });
  }
});

router.get('/:submissionId/dip-pdf', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Access control: borrower (deal owner), broker (submitter), or internal
    const internalRoles = ['admin', 'rm', 'credit', 'compliance'];
    const isInternal = internalRoles.includes(req.user.role);
    const isOwner = deal.user_id === req.user.userId;
    const isBorrower = deal.borrower_email === req.user.email || deal.borrower_invite_email === req.user.email;
    if (!isInternal && !isOwner && !isBorrower) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get DIP data from stored ai_termsheet_data
    const dipData = typeof deal.ai_termsheet_data === 'string'
      ? JSON.parse(deal.ai_termsheet_data) : (deal.ai_termsheet_data || {});

    // Apply credit overrides (if credit has reviewed and overridden values)
    if (dipData.credit_override_rate !== undefined) dipData.rate_monthly = dipData.credit_override_rate;
    if (dipData.credit_override_ltv !== undefined) dipData.ltv = dipData.credit_override_ltv;
    if (dipData.credit_override_arr_fee !== undefined) {
      dipData.arrangement_fee = dipData.credit_override_arr_fee;
      dipData.arrangement_fee_pct = dipData.credit_override_arr_fee;
    }

    // Get borrowers — G5: expanded SELECT so preview matches issue-dip output
    const borrowersResult = await pool.query(
      `SELECT id, full_name, role, email, kyc_status, borrower_type, company_number,
              nationality, address, parent_borrower_id,
              ch_verified_at, ch_matched_role, ch_match_confidence, ch_match_data,
              pg_status, pg_limit_amount, pg_notes
       FROM deal_borrowers WHERE deal_id = $1
       ORDER BY
         CASE role
           WHEN 'primary' THEN 1
           WHEN 'joint' THEN 2
           WHEN 'guarantor' THEN 3
           WHEN 'director' THEN 4
           ELSE 5
         END,
         parent_borrower_id NULLS FIRST,
         id`,
      [dealId]
    );

    // Get properties (individual addresses, postcodes, valuations)
    const propertiesResult = await pool.query(
      `SELECT id, address, postcode, market_value, property_type, tenure, security_charge_type, existing_charges_note, loan_purpose, existing_charge_balance_pence FROM deal_properties WHERE deal_id = $1 ORDER BY id`, [dealId]
    );

    // G5: build both legacy flat array + new grouped structure (mirrors issue-dip handler)
    const flatBorrowersPreview = borrowersResult.rows.map(b => ({
      name: b.full_name, role: b.role, email: b.email, kyc_verified: b.kyc_status === 'verified'
    }));
    const partiesGroupedPreview = groupBorrowersForDip(borrowersResult.rows, deal);

    const dipDataWithBorrowers = {
      ...dipData,
      borrowers: flatBorrowersPreview,
      parties_grouped: partiesGroupedPreview,
      properties: propertiesResult.rows
    };

    const pdfBuffer = await generateDipPdf(deal, dipDataWithBorrowers, {
      issuedBy: deal.dip_issued_by || 'System',
      issuedAt: deal.dip_issued_at || new Date().toISOString()
    });

    // Deal ref for filename
    const createdDate = deal.created_at ? new Date(deal.created_at) : new Date();
    const yy = String(createdDate.getFullYear()).slice(-2);
    const mm = String(createdDate.getMonth() + 1).padStart(2, '0');
    const shortId = (deal.submission_id || req.params.submissionId).substring(0, 4).toUpperCase();
    const dealRef = `DF-${yy}${mm}-${shortId}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="DIP-${dealRef}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[dip-pdf] Error:', error);
    res.status(500).json({ error: 'Failed to generate DIP PDF' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ACCEPT DIP — Borrower/broker accepts the DIP in-portal (no DocuSign)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/accept-dip', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT * FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (deal.dip_signed) {
      return res.status(400).json({ error: 'DIP has already been accepted' });
    }
    if (deal.deal_stage !== 'dip_issued') {
      return res.status(400).json({ error: 'DIP has not been issued for this deal' });
    }
    // Credit must approve before borrower can accept
    if (deal.credit_recommendation !== 'approve') {
      return res.status(400).json({ error: 'DIP is still under credit review. Please wait for credit approval.' });
    }

    // Record acceptance with timestamp and IP for audit trail
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // ── SNAPSHOT: Capture DIP terms at point of acceptance ──
    const dipSnap = captureSnapshot(deal);

    // Accept DIP, capture snapshot, and advance to info_gathering
    await pool.query(
      `UPDATE deal_submissions SET
        dip_signed = true,
        dip_signed_at = NOW(),
        dip_snapshot = $2,
        status = 'info_gathering',
        deal_stage = 'info_gathering',
        updated_at = NOW()
       WHERE id = $1`,
      [deal.id, JSON.stringify(dipSnap)]
    );

    await logAudit(deal.id, 'dip_accepted', deal.status, 'info_gathering', {
      accepted_by: req.user.userId,
      accepted_role: req.user.role,
      client_ip: clientIp,
      user_agent: userAgent,
      method: 'in_portal'
    }, req.user.userId);

    // Notify internal team
    await notifyDealEvent('dip_accepted', { submission_id: deal.submission_id }, []);

    console.log('[accept-dip] DIP accepted by user', req.user.userId, 'for deal', deal.submission_id);

    res.json({
      success: true,
      message: 'DIP accepted successfully',
      accepted_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[accept-dip] Error:', error);
    res.status(500).json({ error: 'Failed to accept DIP' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GENERATE AI TERMSHEET
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/generate-ai-termsheet', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { ai_termsheet_data } = req.body;

    const dealResult = await pool.query(
      `SELECT * FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // GATE: Onboarding fee must be confirmed
    if (!deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee must be confirmed before generating indicative termsheet' });
    }

    // GATE: All 6 onboarding sections must be approved by RM
    const requiredSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    const approval = deal.onboarding_approval || {};
    const unapproved = requiredSections.filter(s => !approval[s] || !approval[s].approved);
    if (unapproved.length > 0) {
      return res.status(400).json({
        error: `All onboarding sections must be approved before generating indicative termsheet. Missing: ${unapproved.join(', ')}`,
        missing_sections: unapproved
      });
    }

    // ── SNAPSHOT: Capture terms at point of Indicative Termsheet generation ──
    // Merge in the new ai_termsheet_data so the snapshot reflects final terms
    const dealForSnap = { ...deal };
    if (ai_termsheet_data) dealForSnap.ai_termsheet_data = ai_termsheet_data;
    const tsSnap = captureSnapshot(dealForSnap);

    // Also compute drift from DIP snapshot
    const dipSnap = deal.dip_snapshot || null;
    const variances = dipSnap ? compareSnapshots('DIP', dipSnap, 'Termsheet', tsSnap) : [];

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'ai_termsheet',
        ai_termsheet_data = $1,
        ai_termsheet_generated_at = NOW(),
        termsheet_snapshot = $3,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, ai_termsheet_generated_at`,
      [ai_termsheet_data ? JSON.stringify(ai_termsheet_data) : '{}', dealId, JSON.stringify(tsSnap)]
    );

    await logAudit(dealId, 'ai_termsheet_generated', dealResult.rows[0].status, 'ai_termsheet',
      { generated_by: req.user.userId, variances_from_dip: variances.length > 0 ? variances : null }, req.user.userId);

    res.json({ success: true, deal: result.rows[0], variances });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate termsheet' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ISSUE TERMSHEET — Generate DOCX from ai_termsheet_data, send via DocuSign
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/issue-termsheet', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    // 1. Fetch full deal data + ai_termsheet_data
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    const aiData = typeof deal.ai_termsheet_data === 'string'
      ? JSON.parse(deal.ai_termsheet_data)
      : (deal.ai_termsheet_data || {});

    if (!aiData.termsheet) {
      return res.status(400).json({ error: 'AI termsheet data not found. Generate the AI analysis first.' });
    }

    // Apply credit overrides to termsheet data (if credit adjusted terms)
    const ts = aiData.termsheet;
    if (aiData.credit_override_rate !== undefined && ts) {
      ts.interestRate = aiData.credit_override_rate + '% per month';
      console.log('[issue-termsheet] Applied credit override: rate', aiData.credit_override_rate);
    }
    if (aiData.credit_override_ltv !== undefined && ts) {
      ts.gltv = aiData.credit_override_ltv + '%';
      console.log('[issue-termsheet] Applied credit override: LTV', aiData.credit_override_ltv);
    }
    if (aiData.credit_override_arr_fee !== undefined && ts) {
      ts.arrangementFee = aiData.credit_override_arr_fee + '% of the Facility';
      console.log('[issue-termsheet] Applied credit override: arrangement fee', aiData.credit_override_arr_fee);
    }

    // 2. Generate Termsheet DOCX (branded with VML letterhead)
    const { generateTermsheetDocx } = require('../services/termsheet-doc');
    console.log('[issue-termsheet] Generating Termsheet DOCX for', req.params.submissionId);
    const docxBuffer = await generateTermsheetDocx(ts);
    const docxFilename = `Termsheet_${req.params.submissionId}.docx`;

    // 3. Upload DOCX to OneDrive
    let tsDocUrl = null;
    try {
      const graphToken = await getGraphToken();
      const uploadResult = await uploadFileToOneDrive(graphToken, req.params.submissionId, docxFilename, docxBuffer);
      tsDocUrl = uploadResult.downloadUrl;
      console.log('[issue-termsheet] DOCX uploaded to OneDrive:', tsDocUrl);
    } catch (uploadErr) {
      console.error('[issue-termsheet] OneDrive upload failed (non-blocking):', uploadErr.message);
    }

    // 4. Send via DocuSign (if configured)
    let docusignResult = null;
    if (config.DOCUSIGN_INTEGRATION_KEY) {
      try {
        const { sendForSigning } = require('../services/docusign');

        // Build signer list — Borrower + Guarantor(s)
        const signers = [];
        const borrowerEmail = deal.borrower_email || deal.borrower_invite_email;
        const borrowerName = deal.borrower_name || aiData.termsheet.borrower || 'Borrower';

        if (borrowerEmail) {
          signers.push({ name: borrowerName, email: borrowerEmail, role: 'borrower' });
        }

        // Get guarantors from deal_borrowers table
        const guarantorResult = await pool.query(
          `SELECT full_name, email FROM deal_borrowers WHERE deal_id = $1 AND role = 'guarantor' AND email IS NOT NULL`,
          [dealId]
        );
        for (const g of guarantorResult.rows) {
          if (g.email) signers.push({ name: g.full_name, email: g.email, role: 'guarantor' });
        }

        if (signers.length === 0) {
          console.log('[issue-termsheet] No signer emails found — skipping DocuSign');
        } else {
          // CC the broker
          const ccRecipients = [];
          const brokerResult = await pool.query(`SELECT first_name, last_name, email FROM users WHERE id = $1`, [deal.user_id]);
          if (brokerResult.rows.length > 0 && brokerResult.rows[0].email) {
            const b = brokerResult.rows[0];
            ccRecipients.push({ name: `${b.first_name} ${b.last_name}`.trim(), email: b.email });
          }

          docusignResult = await sendForSigning({
            pdfBuffer: docxBuffer,
            pdfName: docxFilename,
            docType: 'termsheet',
            dealRef: req.params.submissionId,
            signers,
            ccRecipients,
            callbackUrl: config.DOCUSIGN_WEBHOOK_URL
          });
          console.log('[issue-termsheet] DocuSign envelope created:', docusignResult.envelopeId, 'signers:', signers.length);
        }
      } catch (dsErr) {
        console.error('[issue-termsheet] DocuSign send failed (non-blocking):', dsErr.message);
      }
    } else {
      console.log('[issue-termsheet] DocuSign not configured — DOCX only');
    }

    // 5. Update deal in database
    const updateFields = [
      `ts_pdf_url = $1`,
      `ts_issued_at = NOW()`,
      `ts_issued_by = $2`,
      `ts_signed = false`,
      `updated_at = NOW()`
    ];
    const updateValues = [tsDocUrl, req.user.userId];
    let paramIdx = 3;

    if (docusignResult && docusignResult.envelopeId) {
      updateFields.push(`ts_docusign_envelope_id = $${paramIdx}`);
      updateValues.push(docusignResult.envelopeId);
      paramIdx++;
      updateFields.push(`ts_docusign_status = $${paramIdx}`);
      updateValues.push('sent');
      paramIdx++;
    }

    updateValues.push(dealId);
    await pool.query(
      `UPDATE deal_submissions SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`,
      updateValues
    );

    await logAudit(dealId, 'termsheet_issued', deal.status, deal.status, {
      issued_by: req.user.userId,
      docx_uploaded: !!tsDocUrl,
      docusign_sent: !!(docusignResult && docusignResult.envelopeId),
      docusign_envelope_id: docusignResult ? docusignResult.envelopeId : null
    }, req.user.userId);

    // Notify broker
    const brokerEmailResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [deal.user_id]);
    if (brokerEmailResult.rows.length > 0) {
      await notifyDealEvent('termsheet_issued', { submission_id: deal.submission_id }, [brokerEmailResult.rows[0].email]);
    }

    res.json({
      success: true,
      doc_url: tsDocUrl,
      docusign: docusignResult ? {
        envelope_id: docusignResult.envelopeId,
        status: docusignResult.status
      } : null
    });
  } catch (error) {
    console.error('[issue-termsheet] Error:', error);
    res.status(500).json({ error: 'Failed to issue termsheet' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CREDIT DECISION
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/credit-decision', authenticateToken, authenticateInternal, validate('creditDecision'), async (req, res) => {
  try {
    const { decision, notes, conditions, retained_months, override_rate, override_ltv, override_arr_fee } = req.validated;
    if (!decision) return res.status(400).json({ error: 'Decision is required' });

    const dealResult = await pool.query(
      `SELECT id, status, ai_termsheet_data, user_id FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Store credit decision in ai_termsheet_data
    const existingData = deal.ai_termsheet_data || {};
    existingData.credit_decision = {
      decision,
      notes,
      conditions,
      decided_by: req.user.userId,
      decided_at: new Date().toISOString()
    };

    // If credit overrides retained months, store it
    if (retained_months !== undefined && retained_months !== null) {
      existingData.retained_months = retained_months;
      console.log(`[credit-decision] Credit overrode retained months to ${retained_months}`);
    }

    // Store credit overrides for rate, LTV, arrangement fee
    if (override_rate !== undefined) {
      existingData.credit_override_rate = override_rate;
      console.log(`[credit-decision] Credit overrode rate to ${override_rate}%/m`);
    }
    if (override_ltv !== undefined) {
      existingData.credit_override_ltv = override_ltv;
      console.log(`[credit-decision] Credit overrode max LTV to ${override_ltv}%`);
    }
    if (override_arr_fee !== undefined) {
      existingData.credit_override_arr_fee = override_arr_fee;
      console.log(`[credit-decision] Credit overrode arrangement fee to ${override_arr_fee}%`);
    }

    // If moreinfo, store the question for the RM to see
    if (decision === 'moreinfo' && notes) {
      existingData.credit_query = {
        question: notes,
        asked_by: req.user.userId,
        asked_at: new Date().toISOString(),
        resolved: false
      };
      console.log('[credit-decision] More info requested — query stored for RM');
    }

    const updates = [
      'ai_termsheet_data = $1',
      'credit_recommendation = $2',
      'updated_at = NOW()'
    ];
    const values = [JSON.stringify(existingData), decision];
    let paramIdx = 3;

    // Set the next stage based on decision
    // At dip_issued: credit approval does NOT advance the stage — borrower acceptance does
    const currentStatus = deal.status || '';
    if (decision === 'approve') {
      if (currentStatus === 'dip_issued') {
        // Stay at dip_issued — borrower must accept before advancing
        // credit_recommendation is already set above, that's the gate
        console.log('[credit-decision] Approved at dip_issued — awaiting borrower acceptance before advancing');
      } else {
        updates.push(`status = $${paramIdx}`);
        values.push('info_gathering');
        paramIdx++;
        updates.push(`deal_stage = $${paramIdx}`);
        values.push('info_gathering');
        paramIdx++;
      }
    } else if (decision === 'decline') {
      updates.push(`status = $${paramIdx}`);
      values.push('declined');
      paramIdx++;
      updates.push(`deal_stage = $${paramIdx}`);
      values.push('declined');
      paramIdx++;
    } else if (decision === 'moreinfo') {
      updates.push(`status = $${paramIdx}`);
      values.push('assigned');
      paramIdx++;
      updates.push(`deal_stage = $${paramIdx}`);
      values.push('assigned');
      paramIdx++;
    }

    values.push(req.params.submissionId);
    await pool.query(
      `UPDATE deal_submissions SET ${updates.join(', ')} WHERE submission_id = $${paramIdx}`,
      values
    );

    // Detailed audit logging per decision type
    const auditAction = decision === 'moreinfo' ? 'credit_moreinfo_requested' : `credit_${decision}`;
    const newStage = decision === 'approve' ? (currentStatus === 'dip_issued' ? 'dip_issued' : 'info_gathering') : decision === 'decline' ? 'declined' : 'assigned';
    const auditMeta = { decision, decided_by: req.user.userId };
    if (decision === 'moreinfo') {
      auditMeta.query = (notes || '').substring(0, 500);
      auditMeta.description = 'Credit requested more information from RM';
    } else if (decision === 'decline') {
      auditMeta.reason = (notes || '').substring(0, 500);
      auditMeta.description = 'Credit declined the deal';
    } else if (decision === 'approve') {
      auditMeta.notes = (notes || '').substring(0, 500);
      auditMeta.conditions = (conditions || '').substring(0, 200);
      if (retained_months !== undefined) auditMeta.retained_months_override = retained_months;
      auditMeta.description = 'Credit approved in-principle';
    }
    await logAudit(deal.id, auditAction, deal.status, newStage, auditMeta, req.user.userId);

    // Notify broker if approved
    if (decision === 'approve') {
      const brokerEmail = await pool.query(`SELECT email FROM users WHERE id = $1`, [deal.user_id]);
      if (brokerEmail.rows.length > 0) {
        await notifyDealEvent('credit_approved', deal, [brokerEmail.rows[0].email]);
      }
    }

    res.json({ success: true, message: `Credit decision: ${decision}` });
  } catch (error) {
    console.error('[credit-decision] Error:', error);
    res.status(500).json({ error: 'Failed to record credit decision' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESPOND TO CREDIT QUERY — RM answers credit team's question
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/respond-credit-query', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { response } = req.body;
    if (!response || !response.trim()) {
      return res.status(400).json({ error: 'Response text is required' });
    }

    const dealResult = await pool.query(
      `SELECT id, status, ai_termsheet_data FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    const existingData = deal.ai_termsheet_data || {};
    if (!existingData.credit_query || existingData.credit_query.resolved) {
      return res.status(400).json({ error: 'No pending credit query to respond to' });
    }

    // Move current query to history
    if (!existingData.credit_query_history) existingData.credit_query_history = [];
    existingData.credit_query_history.push({
      question: existingData.credit_query.question,
      asked_by: existingData.credit_query.asked_by,
      asked_at: existingData.credit_query.asked_at,
      response: response.trim(),
      responded_by: req.user.userId,
      responded_at: new Date().toISOString()
    });

    // Mark current query as resolved
    existingData.credit_query.resolved = true;
    existingData.credit_query.response = response.trim();
    existingData.credit_query.responded_by = req.user.userId;
    existingData.credit_query.responded_at = new Date().toISOString();

    await pool.query(
      `UPDATE deal_submissions SET ai_termsheet_data = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(existingData), deal.id]
    );

    // Audit log
    await logAudit(deal.id, 'credit_query_responded', deal.status, deal.status, {
      query: existingData.credit_query.question.substring(0, 200),
      response: response.trim().substring(0, 500),
      responded_by: req.user.userId,
      description: 'RM responded to credit query'
    }, req.user.userId);

    console.log(`[respond-credit-query] RM responded to credit query for ${req.params.submissionId}`);
    res.json({ success: true, message: 'Response recorded' });
  } catch (error) {
    console.error('[respond-credit-query] Error:', error);
    res.status(500).json({ error: 'Failed to record response' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  REQUEST FEE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/request-fee', authenticateToken, authenticateInternal, validate('requestFee'), async (req, res) => {
  try {
    const { fee_requested_amount } = req.validated;
    if (!fee_requested_amount) return res.status(400).json({ error: 'Fee amount is required' });

    const dealResult = await pool.query(`SELECT id, status, user_id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;
    const userId = dealResult.rows[0].user_id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'fee_pending',
        fee_requested_at = NOW(),
        fee_requested_amount = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, fee_requested_at, fee_requested_amount`,
      [fee_requested_amount, dealId]
    );

    await logAudit(dealId, 'fee_requested', dealResult.rows[0].status, 'fee_pending',
      { amount: fee_requested_amount }, req.user.userId);

    // Notify broker
    const brokerEmail = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (brokerEmail.rows.length > 0) {
      await notifyDealEvent('fee_requested', result.rows[0], [brokerEmail.rows[0].email]);
    }

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to request fee' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BANK SUBMIT
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/bank-submit', authenticateToken, authenticateInternal, validate('bankSubmit'), async (req, res) => {
  try {
    const { bank_reference } = req.validated;

    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // ── SNAPSHOT: Capture final terms at bank submission ──
    const finalSnap = captureSnapshot(deal);

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'bank_submitted',
        bank_submitted_at = NOW(),
        bank_submitted_by = $1,
        bank_reference = $2,
        final_snapshot = $4,
        updated_at = NOW()
       WHERE id = $3 RETURNING submission_id, status, bank_submitted_at, bank_reference`,
      [req.user.userId, bank_reference || null, dealId, JSON.stringify(finalSnap)]
    );

    await logAudit(dealId, 'bank_submitted', deal.status, 'bank_submitted',
      { bank_reference }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit to bank' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BANK APPROVE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/bank-approve', authenticateToken, authenticateInternal, validate('bankApprove'), async (req, res) => {
  try {
    const { bank_approval_notes } = req.validated;

    const dealResult = await pool.query(`SELECT id, status, user_id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;
    const userId = dealResult.rows[0].user_id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'bank_approved',
        bank_approved_at = NOW(),
        bank_approval_notes = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, bank_approved_at`,
      [bank_approval_notes || null, dealId]
    );

    await logAudit(dealId, 'bank_approved', dealResult.rows[0].status, 'bank_approved',
      { notes: bank_approval_notes }, req.user.userId);

    // Notify broker
    const brokerEmail = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (brokerEmail.rows.length > 0) {
      await notifyDealEvent('bank_approved', result.rows[0], [brokerEmail.rows[0].email]);
    }

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve deal at bank' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BORROWER ACCEPT
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrower-accept', authenticateToken, validate('borrowerAccept'), async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id, status, borrower_user_id, user_id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const dealId = dealResult.rows[0].id;
    const userId = dealResult.rows[0].user_id;

    // Only the assigned borrower can accept
    if (dealResult.rows[0].borrower_user_id && dealResult.rows[0].borrower_user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to accept this deal' });
    }

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'borrower_accepted',
        borrower_accepted_at = NOW(),
        borrower_user_id = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, borrower_accepted_at`,
      [req.user.userId, dealId]
    );

    await logAudit(dealId, 'borrower_accepted', dealResult.rows[0].status, 'borrower_accepted',
      { accepted_by: req.user.userId }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  INSTRUCT LEGAL
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/instruct-legal', authenticateToken, authenticateInternal, validate('instructLegal'), async (req, res) => {
  try {
    const { lawyer_firm, lawyer_email, lawyer_contact, lawyer_reference } = req.validated;
    if (!lawyer_firm) return res.status(400).json({ error: 'Law firm is required' });

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'legal_instructed',
        legal_instructed_at = NOW(),
        lawyer_firm = $1,
        lawyer_email = $2,
        lawyer_contact = $3,
        lawyer_reference = $4,
        updated_at = NOW()
       WHERE id = $5 RETURNING submission_id, status, legal_instructed_at, lawyer_firm`,
      [lawyer_firm, lawyer_email || null, lawyer_contact || null, lawyer_reference || null, dealId]
    );

    await logAudit(dealId, 'legal_instructed', dealResult.rows[0].status, 'legal_instructed',
      { lawyer_firm, lawyer_email }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to instruct legal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  INVITE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE INTAKE FIELDS (RM / Internal)
//  Allows RM to amend pre-populated intake fields after review
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/intake', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    // ── FIELD LOCK CHECK ──
    // Fetch deal to determine lock state
    const dealCheck = await pool.query(
      `SELECT id, dip_signed, ai_termsheet_generated_at, status FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealState = dealCheck.rows[0];
    const { locked, reasons } = getLockedFields(dealState);

    // Check if any requested fields are locked
    const blockedFields = Object.keys(updates).filter(k => locked.includes(k));
    if (blockedFields.length > 0) {
      const blockedDetail = blockedFields.map(f => ({ field: f, reason: reasons[f] }));
      return res.status(403).json({
        error: 'Some fields are locked and cannot be amended at this stage',
        locked_fields: blockedDetail
      });
    }

    // Whitelist of editable intake fields — only these can be changed
    const allowedFields = [
      'borrower_name', 'borrower_company', 'borrower_email', 'borrower_phone',
      'borrower_dob', 'borrower_nationality', 'borrower_jurisdiction', 'borrower_type',
      'company_name', 'company_number',
      'broker_name', 'broker_company', 'broker_fca',
      'security_address', 'security_postcode', 'asset_type', 'current_value',
      'loan_amount', 'ltv_requested', 'loan_purpose', 'exit_strategy',
      'term_months', 'rate_requested', 'additional_notes',
      'drawdown_date', 'interest_servicing', 'existing_charges',
      'property_tenure', 'occupancy_status', 'current_use',
      'purchase_price', 'use_of_funds', 'refurb_scope', 'refurb_cost',
      'deposit_source', 'concurrent_transactions',
      'estimated_net_worth', 'source_of_wealth'
    ];

    // Numeric fields that need parsing
    const numericFields = [
      'current_value', 'loan_amount', 'ltv_requested', 'term_months',
      'rate_requested', 'purchase_price', 'refurb_cost', 'estimated_net_worth'
    ];

    // Build dynamic SET clause — only for allowed fields present in the body
    const setClauses = [];
    const values = [];
    let paramIdx = 1;

    for (const [key, val] of Object.entries(updates)) {
      if (!allowedFields.includes(key)) continue; // skip anything not whitelisted
      setClauses.push(`${key} = $${paramIdx}`);
      if (numericFields.includes(key) && val !== null && val !== '') {
        // Strip commas and parse as number
        const parsed = parseFloat(String(val).replace(/,/g, ''));
        values.push(isNaN(parsed) ? null : parsed);
      } else {
        values.push(val === '' ? null : val);
      }
      paramIdx++;
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' });
    }

    // Add updated_at
    setClauses.push(`updated_at = NOW()`);

    // Add submission_id as final param
    values.push(req.params.submissionId);

    const result = await pool.query(
      `UPDATE deal_submissions SET ${setClauses.join(', ')} WHERE submission_id = $${paramIdx} RETURNING id, submission_id, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    await logAudit(result.rows[0].id, 'intake_fields_updated', null, null,
      { fields_updated: Object.keys(updates).filter(k => allowedFields.includes(k)), updated_by: req.user.userId }, req.user.userId);

    console.log('[intake-update] Deal', req.params.submissionId, '- fields updated by', req.user.userId, ':', setClauses.length, 'fields');
    res.json({ success: true, message: `${setClauses.length - 1} field(s) updated`, deal: result.rows[0] });
  } catch (error) {
    console.error('[intake-update] Error:', error);
    res.status(500).json({ error: 'Failed to update intake fields' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MATRIX FIELD UPDATE — Allows broker/borrower/RM to edit deal fields inline
//  Credit/compliance/admin are read-only on the Matrix
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/matrix-fields', authenticateToken, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    const { userId, role } = req.user;

    // Only broker, borrower, rm can edit via Matrix
    const editableRoles = ['broker', 'borrower', 'rm', 'admin'];
    if (!editableRoles.includes(role)) {
      return res.status(403).json({ error: 'Matrix fields are read-only for your role' });
    }

    // Fetch deal — broker/borrower must own the deal, RM/admin can edit any
    let dealResult;
    if (['rm', 'admin', 'credit', 'compliance'].includes(role)) {
      dealResult = await pool.query(`SELECT id, dip_signed, ai_termsheet_generated_at, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    } else {
      dealResult = await pool.query(`SELECT id, dip_signed, ai_termsheet_generated_at, status FROM deal_submissions WHERE submission_id = $1 AND user_id = $2`, [req.params.submissionId, userId]);
    }

    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealState = dealResult.rows[0];

    // Field lock check
    const { locked, reasons } = getLockedFields(dealState);
    const blockedFields = Object.keys(updates).filter(k => locked.includes(k));
    if (blockedFields.length > 0) {
      return res.status(403).json({
        error: 'Some fields are locked at this stage',
        locked_fields: blockedFields.map(f => ({ field: f, reason: reasons[f] }))
      });
    }

    // Whitelist — broker/borrower can edit client-facing fields, RM/admin can edit all
    const clientFields = [
      'borrower_name', 'borrower_company', 'borrower_email', 'borrower_phone',
      'borrower_dob', 'borrower_nationality', 'borrower_jurisdiction', 'borrower_type',
      'company_name', 'company_number',
      'security_address', 'security_postcode', 'asset_type', 'current_value',
      'loan_amount', 'ltv_requested', 'loan_purpose', 'exit_strategy',
      'term_months', 'additional_notes',
      'drawdown_date', 'interest_servicing', 'existing_charges',
      'property_tenure', 'occupancy_status', 'current_use',
      'purchase_price', 'use_of_funds', 'refurb_scope', 'refurb_cost',
      'deposit_source', 'concurrent_transactions',
      'estimated_net_worth', 'source_of_wealth',
      // 2026-04-21: broker-editable Requested-column variants. UI now renders
      // Requested as editable (Max Loan pill, LTV auto-calc). Previously the
      // whitelist only accepted the legacy flat keys (loan_amount, term_months,
      // interest_servicing, exit_strategy) — saves of _requested variants from
      // the Matrix UI returned "No valid fields to update". Rate Requested
      // stays RM-only per lender-side pricing policy.
      'loan_amount_requested', 'term_months_requested',
      'interest_servicing_requested', 'exit_strategy_requested'
    ];

    const rmFields = [
      ...clientFields,
      'broker_name', 'broker_company', 'broker_fca',
      'arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee',
      'retained_interest_months', 'rate_requested',
      // G5.3.2 Security & Guarantee section — deal-level fields
      'requires_share_charge', 'additional_security_text',
      // M2a (Matrix-SSOT 2026-04-20): Approved columns — what we offer, editable by RM/Credit
      'loan_amount_approved', 'ltv_approved', 'rate_approved',
      'term_months_approved', 'interest_servicing_approved', 'exit_strategy_approved',
      // M2a: Additional requested columns (RM may need to correct these occasionally)
      'loan_amount_requested', 'term_months_requested', 'interest_servicing_requested',
      'exit_strategy_requested',
      // M2a: New fee columns
      'dip_fee', 'exit_fee_pct', 'extension_fee_pct',
      // 2026-04-21: RM-authored DIP Conditions — separate from broker-facing
      // additional_notes. Only dip_notes appears on the DIP preview / PDF.
      'dip_notes',
      // Sprint 2 (2026-04-28): structured exit-strategy cols — RM/Credit fill
      // these as part of underwriting. Free-text exit_strategy_* stays for
      // approval-flow audit; these are the analytical view the rubric reads.
      'exit_route_primary', 'exit_route_secondary',
      'exit_target_date', 'exit_target_disposal_window_days',
      'exit_target_refi_lender', 'exit_target_refi_loan',
      'exit_target_refi_ltv_pct', 'exit_target_refi_rate_pct_pa',
      'exit_expected_disposal_proceeds',
      'exit_borrower_stated_confidence', 'exit_underwriter_assessed_confidence',
      'exit_underwriter_commentary',
      // Sprint 3 #16 (2026-04-28): Sources & Uses funding stack — 8 cols.
      // Existing purchase_price/refurb_cost/fees cover the rest of uses;
      // loan_amount_approved is the senior_loan source.
      'uses_sdlt', 'uses_legal_fees', 'uses_other_amount', 'uses_other_description',
      'sources_second_charge', 'sources_equity', 'sources_other_amount', 'sources_other_description',
      // Sprint 4 #19 — refinance-aware S&U
      'uses_loan_redemption',
      // Sprint 5 #26 — explicit primary-use type dropdown
      'uses_primary_type'
    ];

    const allowedFields = ['rm', 'admin'].includes(role) ? rmFields : clientFields;

    // Numeric fields
    const numericFields = [
      'current_value', 'loan_amount', 'ltv_requested', 'term_months',
      'rate_requested', 'purchase_price', 'refurb_cost',
      'arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee', 'retained_interest_months',
      'estimated_net_worth',
      // M2a: Approved numerics
      'loan_amount_approved', 'ltv_approved', 'rate_approved', 'term_months_approved',
      'loan_amount_requested', 'term_months_requested',
      'dip_fee', 'exit_fee_pct', 'extension_fee_pct',
      // Sprint 2 — exit strategy numerics
      'exit_target_disposal_window_days', 'exit_target_refi_loan',
      'exit_target_refi_ltv_pct', 'exit_target_refi_rate_pct_pa',
      'exit_expected_disposal_proceeds',
      // Sprint 3 #16 — Sources & Uses numerics
      'uses_sdlt', 'uses_legal_fees', 'uses_other_amount',
      'sources_second_charge', 'sources_equity', 'sources_other_amount',
      // Sprint 4 #19
      'uses_loan_redemption'
    ];

    // M2c+M4d (Matrix-SSOT auto-revoke): editing any field in an approval section's
    // referenced set clears that section's DIP approval stamp. Forces re-approval.
    const AUTO_REVOKE_MAP = {
      dip_loan_terms_approved: [
        'loan_amount_approved', 'ltv_approved', 'rate_approved', 'term_months_approved',
        'interest_servicing_approved',
        // Requested-side changes also invalidate since display shows both
        'loan_amount_requested', 'term_months_requested', 'interest_servicing_requested'
      ],
      dip_fees_approved: [
        'dip_fee', 'arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee',
        'exit_fee_pct', 'extension_fee_pct', 'retained_interest_months'
      ],
      dip_security_approved: [
        'security_address', 'security_postcode', 'asset_type', 'current_value',
        'requires_share_charge', 'additional_security_text'
      ],
      // M4d: Use of Funds is its own gate (was rolled into loan_terms / conditions)
      dip_use_of_funds_approved: [
        'loan_purpose', 'use_of_funds', 'refurb_scope', 'refurb_cost', 'purchase_price', 'deposit_source'
      ],
      // M4d: Exit Strategy its own gate (was rolled into conditions)
      dip_exit_strategy_approved: [
        'exit_strategy', 'exit_strategy_approved', 'exit_strategy_requested'
      ],
      // conditions is now a true 'anything else' bucket
      dip_conditions_approved: ['additional_notes']
      // dip_borrower_approved revoked only by borrower CRUD endpoints, not matrix-fields
    };

    // Build SET clause
    const setClauses = [];
    const values = [];
    let paramIdx = 1;
    const editedFields = [];

    for (const [key, val] of Object.entries(updates)) {
      if (!allowedFields.includes(key)) continue;
      setClauses.push(`${key} = $${paramIdx}`);
      if (numericFields.includes(key) && val !== null && val !== '') {
        const parsed = parseFloat(String(val).replace(/,/g, ''));
        values.push(isNaN(parsed) ? null : parsed);
      } else {
        values.push(val === '' ? null : val);
      }
      paramIdx++;
      editedFields.push(key);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // M2c+M5-3: Auto-revoke — if any edited field belongs to an approval section's
    // referenced set, clear that section's DIP approval stamp. AND if loan_terms
    // or fees are touched, ALSO clear dip_credit_decision (triggers a fresh
    // Credit review cycle — RM edits after Credit saw it = Credit re-reviews).
    const revokedSections = [];
    let creditDecisionCleared = false;
    const CREDIT_RESET_TRIGGERS = new Set([...AUTO_REVOKE_MAP.dip_loan_terms_approved, ...AUTO_REVOKE_MAP.dip_fees_approved]);
    for (const [approvalCol, watchedFields] of Object.entries(AUTO_REVOKE_MAP)) {
      const changed = editedFields.some(f => watchedFields.includes(f));
      if (changed) {
        setClauses.push(`${approvalCol} = FALSE`);
        setClauses.push(`${approvalCol}_by = NULL`);
        setClauses.push(`${approvalCol}_at = NULL`);
        revokedSections.push(approvalCol);
      }
    }
    // M5-3: Clear credit decision if any loan_terms or fees trigger fired
    const creditReset = editedFields.some(f => CREDIT_RESET_TRIGGERS.has(f));
    if (creditReset) {
      setClauses.push(`dip_credit_decision = NULL`);
      setClauses.push(`dip_credit_decided_by = NULL`);
      setClauses.push(`dip_credit_decided_at = NULL`);
      setClauses.push(`dip_credit_notes = NULL`);
      creditDecisionCleared = true;
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(req.params.submissionId);

    const result = await pool.query(
      `UPDATE deal_submissions SET ${setClauses.join(', ')} WHERE submission_id = $${paramIdx} RETURNING id, submission_id, updated_at`,
      values
    );

    const updatedDealId = result.rows[0].id;

    await logAudit(updatedDealId, 'matrix_fields_updated', null, null,
      { fields_updated: Object.keys(updates).filter(k => allowedFields.includes(k)), updated_by: userId, role }, userId);

    // ── Sync borrower fields to deal_borrowers table ──
    // The matrix saves to flat deal_submissions fields, but the Borrower Structure
    // section reads from deal_borrowers. Keep them in sync.
    const borrowerFieldMap = {
      borrower_name: 'full_name', borrower_type: 'borrower_type',
      borrower_email: 'email', borrower_phone: 'phone',
      borrower_dob: 'date_of_birth', borrower_nationality: 'nationality',
      borrower_jurisdiction: 'jurisdiction',
      company_name: 'company_name', company_number: 'company_number'
    };
    const borrowerUpdates = Object.keys(updates).filter(k => borrowerFieldMap[k] && allowedFields.includes(k));

    if (borrowerUpdates.length > 0) {
      try {
        // Check if a primary borrower record exists
        const existingBorrower = await pool.query(
          `SELECT id FROM deal_borrowers WHERE deal_id = $1 AND role = 'primary' LIMIT 1`,
          [updatedDealId]
        );

        if (existingBorrower.rows.length > 0) {
          // Update existing primary borrower
          const bSetClauses = [];
          const bValues = [];
          let bIdx = 1;
          for (const flatKey of borrowerUpdates) {
            const dbCol = borrowerFieldMap[flatKey];
            bSetClauses.push(`${dbCol} = $${bIdx}`);
            bValues.push(updates[flatKey] === '' ? null : updates[flatKey]);
            bIdx++;
          }
          bValues.push(existingBorrower.rows[0].id);
          await pool.query(
            `UPDATE deal_borrowers SET ${bSetClauses.join(', ')}, updated_at = NOW() WHERE id = $${bIdx}`,
            bValues
          );
        } else {
          // Create a new primary borrower from the flat fields
          // Fetch all current borrower fields from the deal to populate fully
          const dealFull = await pool.query(
            `SELECT borrower_name, borrower_type, borrower_email, borrower_phone,
                    borrower_dob, borrower_nationality, borrower_jurisdiction,
                    company_name, company_number
             FROM deal_submissions WHERE id = $1`, [updatedDealId]
          );
          if (dealFull.rows.length > 0) {
            const d = dealFull.rows[0];
            // Only create if there's at least a name
            if (d.borrower_name) {
              await pool.query(
                `INSERT INTO deal_borrowers (deal_id, role, full_name, borrower_type, email, phone, date_of_birth, nationality, jurisdiction, company_name, company_number)
                 VALUES ($1, 'primary', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [updatedDealId, d.borrower_name, d.borrower_type || null,
                 d.borrower_email || null, d.borrower_phone || null,
                 d.borrower_dob || null, d.borrower_nationality || null,
                 d.borrower_jurisdiction || null, d.company_name || null, d.company_number || null]
              );
              console.log('[matrix-fields] Created primary borrower record from flat fields');
            }
          }
        }
      } catch (borrowerSyncErr) {
        console.warn('[matrix-fields] Borrower sync note:', borrowerSyncErr.message.substring(0, 80));
      }
    }

    console.log('[matrix-fields] Deal', req.params.submissionId, '- updated by', role, userId, ':', editedFields.length, 'fields' +
      (revokedSections.length > 0 ? ` (auto-revoked: ${revokedSections.join(', ')})` : '') +
      (creditDecisionCleared ? ' (credit decision cleared)' : ''));
    res.json({
      success: true,
      fields_updated: editedFields.length,
      revoked_approvals: revokedSections,
      credit_decision_cleared: creditDecisionCleared
    });
  } catch (error) {
    console.error('[matrix-fields] Error:', error);
    res.status(500).json({ error: 'Failed to update matrix fields' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  TERMS TRACKER — Side-by-side DIP → Termsheet → Final comparison
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/terms-tracker', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT id, dip_snapshot, termsheet_snapshot, final_snapshot,
              dip_signed, ai_termsheet_generated_at, status,
              loan_amount, current_value, ltv_requested, rate_requested,
              term_months, exit_strategy, borrower_name, borrower_company,
              company_name, security_address, asset_type, interest_servicing,
              loan_purpose, ai_termsheet_data
       FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Build current live values snapshot for comparison
    const liveSnap = captureSnapshot(deal);

    // The tracked fields with display labels
    const trackedFields = [
      { key: 'borrower_name', label: 'Borrower', format: 'text' },
      { key: 'company_name', label: 'Company / SPV', format: 'text' },
      { key: 'security_address', label: 'Security Address', format: 'text' },
      { key: 'asset_type', label: 'Asset Type', format: 'text' },
      { key: 'loan_amount', label: 'Loan Amount', format: 'currency' },
      { key: 'current_value', label: 'Property Value', format: 'currency' },
      { key: 'ltv_requested', label: 'LTV %', format: 'pct' },
      { key: 'rate_requested', label: 'Rate (monthly)', format: 'pct' },
      { key: 'term_months', label: 'Term (months)', format: 'number' },
      { key: 'exit_strategy', label: 'Exit Strategy', format: 'text' },
      { key: 'interest_servicing', label: 'Interest Servicing', format: 'text' },
      { key: 'loan_purpose', label: 'Loan Purpose', format: 'text' }
    ];

    const dipSnap = deal.dip_snapshot || null;
    const tsSnap = deal.termsheet_snapshot || null;
    const finalSnap = deal.final_snapshot || null;

    // Build rows: each field with value at each stage
    const rows = trackedFields.map(tf => {
      const row = {
        field: tf.label,
        key: tf.key,
        format: tf.format,
        current: liveSnap[tf.key] ?? null,
        dip: dipSnap ? (dipSnap[tf.key] ?? null) : null,
        termsheet: tsSnap ? (tsSnap[tf.key] ?? null) : null,
        final: finalSnap ? (finalSnap[tf.key] ?? null) : null,
        changed: false
      };
      // Flag if value drifted between any captured stages
      const vals = [row.dip, row.termsheet, row.final].filter(v => v !== null);
      if (vals.length >= 2) {
        row.changed = new Set(vals.map(String)).size > 1;
      }
      return row;
    });

    // Also include DIP terms (from ai_termsheet_data) if available
    const dipTerms = dipSnap?.dip_terms || null;
    const tsTerms = tsSnap?.dip_terms || null;

    // Compute variances
    const dipToTs = (dipSnap && tsSnap) ? compareSnapshots('DIP', dipSnap, 'Termsheet', tsSnap) : [];
    const tsToFinal = (tsSnap && finalSnap) ? compareSnapshots('Termsheet', tsSnap, 'Final', finalSnap) : [];

    res.json({
      stages: {
        dip: dipSnap ? { captured_at: dipSnap.captured_at, exists: true } : { exists: false },
        termsheet: tsSnap ? { captured_at: tsSnap.captured_at, exists: true } : { exists: false },
        final: finalSnap ? { captured_at: finalSnap.captured_at, exists: true } : { exists: false }
      },
      rows,
      variances: { dip_to_termsheet: dipToTs, termsheet_to_final: tsToFinal },
      locks: getLockedFields(deal)
    });
  } catch (error) {
    console.error('[terms-tracker] Error:', error);
    res.status(500).json({ error: 'Failed to load terms tracker' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  FIELD LOCKS — Returns which fields are currently locked
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/field-locks', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT dip_signed, ai_termsheet_generated_at, status FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    res.json(getLockedFields(dealResult.rows[0]));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load field locks' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE FEES (Fee Tracker)
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/:submissionId/update-fees', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { fee_onboarding, fee_commitment, valuation_cost, legal_cost } = req.body;

    const dealResult = await pool.query(
      `SELECT id, ai_termsheet_data, status FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = dealResult.rows[0];
    const existing = deal.ai_termsheet_data || {};

    // Merge new fee values into existing ai_termsheet_data
    const updated = {
      ...existing,
      fee_onboarding: fee_onboarding ?? existing.fee_onboarding,
      fee_commitment: fee_commitment ?? existing.fee_commitment,
      valuation_cost: valuation_cost ?? existing.valuation_cost,
      legal_cost:     legal_cost     ?? existing.legal_cost
    };

    await pool.query(
      `UPDATE deal_submissions SET ai_termsheet_data = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updated), deal.id]
    );

    await logAudit(deal.id, 'fees_updated', deal.status, deal.status,
      { fee_onboarding, fee_commitment, valuation_cost, legal_cost, updated_by: req.user.userId },
      req.user.userId);

    console.log('[update-fees] Deal', req.params.submissionId, '- fees updated by', req.user.userId);
    res.json({ success: true, fees: { fee_onboarding, fee_commitment, valuation_cost, legal_cost } });
  } catch (error) {
    console.error('[update-fees] Error:', error);
    res.status(500).json({ error: 'Failed to update fees' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM ONBOARDING FEE — gates full onboarding unlock
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/confirm-onboarding-fee', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT id, deal_stage, status, dip_fee_confirmed FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee already confirmed' });
    }

    await pool.query(
      `UPDATE deal_submissions SET
        dip_fee_confirmed = true,
        dip_fee_confirmed_at = NOW(),
        updated_at = NOW()
       WHERE id = $1`,
      [deal.id]
    );

    await logAudit(deal.id, 'onboarding_fee_confirmed', deal.deal_stage, deal.deal_stage,
      { confirmed_by: req.user.userId }, req.user.userId);

    console.log('[confirm-onboarding-fee] Deal', req.params.submissionId, 'fee confirmed by', req.user.userId);
    res.json({ success: true, confirmed_at: new Date().toISOString() });
  } catch (error) {
    console.error('[confirm-onboarding-fee] Error:', error);
    res.status(500).json({ error: 'Failed to confirm onboarding fee' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  APPROVE ONBOARDING SECTION — RM ticks off each section
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/approve-onboarding-section', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { section, approved, notes } = req.body;

    const validSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(', ')}` });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, dip_fee_confirmed, onboarding_approval FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // GATE: Onboarding fee must be confirmed before sections can be approved
    if (!deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee must be confirmed before approving sections' });
    }

    const approval = deal.onboarding_approval || {};
    approval[section] = {
      approved: approved !== false,
      approved_by: req.user.userId,
      approved_at: new Date().toISOString(),
      notes: notes || null
    };

    // Check if all sections are now approved
    const allApproved = validSections.every(s => approval[s] && approval[s].approved);

    await pool.query(
      `UPDATE deal_submissions SET onboarding_approval = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(approval), deal.id]
    );

    await logAudit(deal.id, 'onboarding_section_approved', deal.deal_stage, deal.deal_stage,
      { section, approved: approved !== false, notes, approved_by: req.user.userId }, req.user.userId);

    console.log('[approve-section] Deal', req.params.submissionId, '- section', section,
      approved !== false ? 'approved' : 'rejected', 'by', req.user.userId,
      allApproved ? '(ALL SECTIONS APPROVED)' : '');

    // ═══════════════════════════════════════════════════════════════════
    //  AUTO-TRIGGER: When all 6 sections approved → fire n8n analysis
    // ═══════════════════════════════════════════════════════════════════
    let n8nTriggered = false;
    if (allApproved) {
      try {
        console.log('[approve-section] ALL SECTIONS APPROVED — assembling full deal pack for n8n...');

        // 1. Fetch complete deal data
        const fullDeal = await pool.query(
          `SELECT * FROM deal_submissions WHERE id = $1`, [deal.id]
        );
        const dealData = fullDeal.rows[0];

        // 2. Fetch all onboarding form data
        const onboardingData = dealData.onboarding_data || {};

        // 3. Fetch all uploaded documents (metadata only — n8n gets file names + categories)
        const docsResult = await pool.query(
          `SELECT filename, file_type, file_size, doc_category, uploaded_at, onedrive_download_url
           FROM deal_documents WHERE deal_id = $1 ORDER BY doc_category, uploaded_at`,
          [deal.id]
        );

        // 4. Fetch submitter (broker) info
        const brokerResult = await pool.query(
          `SELECT first_name, last_name, email, phone FROM users WHERE id = $1`, [dealData.user_id]
        );
        const broker = brokerResult.rows[0] || {};

        // 5. Build comprehensive deal pack payload for n8n
        const dealPack = {
          // Metadata
          trigger: 'onboarding_complete',
          submissionId: req.params.submissionId,
          dealId: deal.id,
          timestamp: new Date().toISOString(),
          approvedBy: req.user.userId,

          // Borrower & Broker
          borrower: {
            name: dealData.borrower_name,
            company: dealData.borrower_company,
            email: dealData.borrower_email,
            phone: dealData.borrower_phone,
            type: dealData.borrower_type,
            nationality: dealData.borrower_nationality,
            company_name: dealData.company_name,
            company_number: dealData.company_number
          },
          broker: {
            name: dealData.broker_name || `${broker.first_name || ''} ${broker.last_name || ''}`.trim(),
            company: dealData.broker_company,
            fca_number: dealData.broker_fca,
            email: broker.email,
            phone: broker.phone
          },

          // Security / Property
          security: {
            address: dealData.security_address,
            postcode: dealData.security_postcode,
            asset_type: dealData.asset_type,
            current_value: dealData.current_value,
            purchase_price: dealData.purchase_price,
            tenure: dealData.property_tenure,
            occupancy_status: dealData.occupancy_status,
            current_use: dealData.current_use
          },

          // Loan Details
          loan: {
            amount: dealData.loan_amount,
            ltv_requested: dealData.ltv_requested,
            purpose: dealData.loan_purpose,
            exit_strategy: dealData.exit_strategy,
            term_months: dealData.term_months,
            rate_requested: dealData.rate_requested,
            interest_servicing: dealData.interest_servicing,
            existing_charges: dealData.existing_charges,
            use_of_funds: dealData.use_of_funds,
            refurb_scope: dealData.refurb_scope,
            refurb_cost: dealData.refurb_cost,
            deposit_source: dealData.deposit_source
          },

          // Onboarding form data (all 6 sections as filled by borrower/broker)
          onboarding: onboardingData,

          // Section approval summary
          approvals: approval,

          // All uploaded documents (metadata + download URLs)
          documents: docsResult.rows.map(d => ({
            filename: d.filename,
            category: d.doc_category,
            type: d.file_type,
            size: d.file_size,
            uploaded_at: d.uploaded_at,
            download_url: d.onedrive_download_url || null
          })),

          // Document counts by category
          documentSummary: docsResult.rows.reduce((acc, d) => {
            acc[d.doc_category] = (acc[d.doc_category] || 0) + 1;
            return acc;
          }, {}),

          // DIP (Decision in Principle) data — what was already quoted to borrower
          dip: {
            issued: !!dealData.dip_issued_at,
            issued_at: dealData.dip_issued_at || null,
            issued_by: dealData.dip_issued_by || null,
            notes: dealData.dip_notes || null,
            signed: !!dealData.dip_signed,
            signed_at: dealData.dip_signed_at || null,
            fee_confirmed: !!dealData.dip_fee_confirmed,
            fee_confirmed_at: dealData.dip_fee_confirmed_at || null,
            // AI-generated indicative terms (with any RM credit overrides applied)
            terms: (() => {
              try {
                const raw = dealData.ai_termsheet_data;
                return typeof raw === 'string' ? JSON.parse(raw) : (raw || null);
              } catch { return null; }
            })()
          },

          // Credit decision (if RM already made one at DIP stage)
          credit: {
            recommendation: dealData.credit_recommendation || null,
            decision_notes: dealData.credit_notes || null
          },

          // Term snapshots and variances — for credit memo comparison
          term_snapshots: {
            dip: dealData.dip_snapshot || null,
            termsheet: dealData.termsheet_snapshot || null,
            final: dealData.final_snapshot || null,
            variances: (() => {
              const ds = dealData.dip_snapshot;
              const ts = dealData.termsheet_snapshot;
              if (ds && ts) return compareSnapshots('DIP', ds, 'Termsheet', ts);
              return [];
            })()
          },

          // Additional notes
          additional_notes: dealData.additional_notes,

          // Callback URL for n8n to send results back
          callbackUrl: 'https://daksfirst-auth.onrender.com/api/webhooks/analysis-complete'
        };

        // 6. Fire n8n webhook
        const N8N_WEBHOOK_URL = config.N8N_WEBHOOK_URL || '';
        if (N8N_WEBHOOK_URL) {
          const webhookResp = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': config.WEBHOOK_SECRET
            },
            body: JSON.stringify(dealPack),
            signal: AbortSignal.timeout(30000)
          });

          console.log(`[approve-section] n8n webhook fired: ${webhookResp.status}`);
          n8nTriggered = webhookResp.ok;

          // Log webhook attempt
          try {
            await pool.query(
              `INSERT INTO webhook_log (deal_id, attempt, status_code, response_body) VALUES ($1, 1, $2, $3)`,
              [deal.id, webhookResp.status, (await webhookResp.text()).substring(0, 500)]
            );
          } catch (logErr) {}

          // Update deal stage to show analysis is in progress
          if (webhookResp.ok) {
            await pool.query(
              `UPDATE deal_submissions SET deal_stage = 'ai_termsheet', webhook_status = 'sent', updated_at = NOW() WHERE id = $1`,
              [deal.id]
            );
            await logAudit(deal.id, 'n8n_analysis_triggered', deal.deal_stage, 'ai_termsheet',
              { triggered_by: 'auto_on_all_approved', approved_by: req.user.userId }, req.user.userId);
          }
        } else {
          console.warn('[approve-section] N8N_WEBHOOK_URL not configured — analysis not triggered');
        }
      } catch (n8nErr) {
        console.error('[approve-section] n8n trigger failed (non-blocking):', n8nErr.message);
        // Non-blocking — section approval still succeeds
      }
    }

    res.json({
      success: true,
      section,
      approved: approved !== false,
      all_sections_approved: allApproved,
      n8n_triggered: n8nTriggered,
      onboarding_approval: approval
    });
  } catch (error) {
    console.error('[approve-section] Error:', error);
    res.status(500).json({ error: 'Failed to approve onboarding section' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RM SIGN-OFF on AI Termsheet
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/rm-signoff', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { notes } = req.body;

    const dealResult = await pool.query(
      `SELECT id, deal_stage, ai_termsheet_data, ai_termsheet_generated_at, onboarding_approval, dip_fee_confirmed, rm_signoff_at FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // GATE: Onboarding fee must be confirmed
    if (!deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee must be confirmed first' });
    }

    // GATE: All 6 onboarding sections must be approved
    const requiredSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    const approval = deal.onboarding_approval || {};
    const unapproved = requiredSections.filter(s => !approval[s] || !approval[s].approved);
    if (unapproved.length > 0) {
      return res.status(400).json({ error: `All onboarding sections must be approved first. Missing: ${unapproved.join(', ')}` });
    }

    // GATE: AI termsheet must have been generated
    if (!deal.ai_termsheet_generated_at) {
      return res.status(400).json({ error: 'AI termsheet must be generated before RM can sign off' });
    }

    if (deal.rm_signoff_at) {
      return res.status(400).json({ error: 'RM has already signed off on this termsheet' });
    }

    // Store RM sign-off in ai_termsheet_data as well for downstream access
    const aiData = deal.ai_termsheet_data || {};
    aiData.rm_signoff = {
      signed_by: req.user.userId,
      signed_at: new Date().toISOString(),
      notes: notes || null
    };

    await pool.query(
      `UPDATE deal_submissions SET
        rm_signoff_at = NOW(),
        rm_signoff_by = $1,
        ai_termsheet_data = $2,
        updated_at = NOW()
       WHERE id = $3`,
      [req.user.userId, JSON.stringify(aiData), deal.id]
    );

    await logAudit(deal.id, 'rm_signoff', deal.deal_stage, deal.deal_stage,
      { signed_by: req.user.userId, notes }, req.user.userId);

    console.log('[rm-signoff] Deal', req.params.submissionId, 'RM signed off by', req.user.userId);
    res.json({ success: true, signed_at: new Date().toISOString() });
  } catch (error) {
    console.error('[rm-signoff] Error:', error);
    res.status(500).json({ error: 'Failed to record RM sign-off' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CREDIT SIGN-OFF on AI Termsheet
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/credit-signoff', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { notes, decision } = req.body;

    if (!['approve', 'decline', 'moreinfo'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approve, decline, or moreinfo' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, ai_termsheet_data, ai_termsheet_generated_at, rm_signoff_at, dip_fee_confirmed FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // GATE: Full chain must be complete
    if (!deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee must be confirmed first' });
    }
    if (!deal.ai_termsheet_generated_at) {
      return res.status(400).json({ error: 'AI termsheet must be generated first' });
    }
    if (!deal.rm_signoff_at) {
      return res.status(400).json({ error: 'RM must sign off before Credit can review' });
    }

    const aiData = deal.ai_termsheet_data || {};
    aiData.credit_signoff = {
      decision,
      signed_by: req.user.userId,
      signed_at: new Date().toISOString(),
      notes: notes || null
    };

    const updateFields = [
      `credit_signoff_at = NOW()`,
      `credit_signoff_by = $1`,
      `ai_termsheet_data = $2`,
      `updated_at = NOW()`
    ];
    const updateValues = [req.user.userId, JSON.stringify(aiData)];
    let paramIdx = 3;

    // If approved, advance stage to ai_termsheet (ready for formal termsheet issuance)
    if (decision === 'approve') {
      updateFields.push(`deal_stage = $${paramIdx}`);
      updateValues.push('ai_termsheet');
      paramIdx++;
    }

    updateValues.push(deal.id);
    await pool.query(
      `UPDATE deal_submissions SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`,
      updateValues
    );

    await logAudit(deal.id, 'credit_signoff', deal.deal_stage, decision === 'approve' ? 'ai_termsheet' : deal.deal_stage,
      { decision, signed_by: req.user.userId, notes }, req.user.userId);

    console.log('[credit-signoff] Deal', req.params.submissionId, 'Credit decision:', decision, 'by', req.user.userId);
    res.json({ success: true, decision, signed_at: new Date().toISOString() });
  } catch (error) {
    console.error('[credit-signoff] Error:', error);
    res.status(500).json({ error: 'Failed to record Credit sign-off' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPLOAD DOCUMENT WITH CATEGORY (for onboarding sections)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/upload-categorised', authenticateToken, async (req, res) => {
  try {
    const multer = require('multer');
    const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }).array('files', 10);

    upload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }

      const { category } = req.body;
      const validCategories = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions', 'general', 'post_completion'];
      if (category && !validCategories.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
      }

      const dealResult = await pool.query(
        `SELECT id, dip_fee_confirmed FROM deal_submissions WHERE submission_id = $1`,
        [req.params.submissionId]
      );
      if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

      // GATE: Onboarding fee must be confirmed before categorised uploads (except 'general')
      if (category !== 'general' && !dealResult.rows[0].dip_fee_confirmed) {
        return res.status(400).json({ error: 'Onboarding fee must be confirmed before uploading section documents' });
      }

      const dealId = dealResult.rows[0].id;

      // Ensure doc_category and uploaded_by columns exist
      try {
        await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS doc_category VARCHAR(50)`);
        await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS uploaded_by INT`);
      } catch (migErr) {
        console.log('[upload-categorised] Column check note:', migErr.message.substring(0, 60));
      }

      const uploaded = [];
      for (const file of (req.files || [])) {
        const result = await pool.query(
          `INSERT INTO deal_documents (deal_id, filename, file_type, file_size, file_content, doc_category, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, doc_category, uploaded_at`,
          [dealId, file.originalname, file.mimetype, file.size, file.buffer, category || 'general', req.user.userId]
        );
        uploaded.push(result.rows[0]);

        // Upload to OneDrive (non-blocking)
        try {
          const graphToken = await getGraphToken();
          const subfolder = category ? `${req.params.submissionId}/${category}` : req.params.submissionId;
          const uploadResult = await uploadFileToOneDrive(graphToken, subfolder, file.originalname, file.buffer);
          await pool.query(
            `UPDATE deal_documents SET onedrive_item_id = $1, onedrive_path = $2, onedrive_download_url = $3 WHERE id = $4`,
            [uploadResult.id, uploadResult.name, uploadResult.downloadUrl, result.rows[0].id]
          );
        } catch (odErr) {
          console.error('[upload-categorised] OneDrive upload failed (non-blocking):', odErr.message);
        }
      }

      await logAudit(dealId, 'documents_uploaded', null, null,
        { category, files: uploaded.map(u => u.filename), uploaded_by: req.user.userId }, req.user.userId);

      res.json({ success: true, documents: uploaded });
    });
  } catch (error) {
    console.error('[upload-categorised] Error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SMART UPLOAD — auto-categorise files by filename + AI content analysis
// ═══════════════════════════════════════════════════════════════════════════
const smartUploadMulter = require('multer')({ limits: { fileSize: 25 * 1024 * 1024 } }).array('files', 20);
const { categoriseWithAI } = require('../services/ai-categorise');

// Filename pattern → category mapping (ORDER MATTERS — first match wins)
const categoryPatterns = [
  // KYC patterns (check BEFORE financials_aml to avoid "kyc check" going to AML)
  { pattern: /passport|driving.?licen|photo.?id|identity|national.?id/i, category: 'kyc' },
  { pattern: /proof.?of.?address|poa|utility.?bill|council.?tax|bank.?letter/i, category: 'kyc' },
  { pattern: /certificate.?of.?incorp|mem.?art|articles.?of.?assoc|companies.?house|board.?resolution|ubo/i, category: 'kyc' },
  { pattern: /kyc|know.?your.?customer|id.?check|identity.?verif/i, category: 'kyc' },
  // Financials / AML
  { pattern: /bank.?statement|sa302|tax.?return|payslip|income|p60|accounts|balance.?sheet|profit.?loss|assets?.?liab|mortgage.?schedule/i, category: 'financials_aml' },
  { pattern: /aml|anti.?money|source.?of.?fund|source.?of.?wealth|pep|sanction|compliance/i, category: 'financials_aml' },
  // Valuation
  { pattern: /valuation|rics|survey|title.?register|land.?registry|title.?plan|charges.?register|search.?result|local.?authority/i, category: 'valuation' },
  { pattern: /solicitor|sra|legal.?opinion|purchase.?contract|transfer.?deed/i, category: 'valuation' },
  // Use of Funds
  { pattern: /redemption|redeem|use.?of.?fund|schedule.?of.?cost|refurb|renovation|contractor|quote|works|build.?programme|structural|planning.?consent/i, category: 'use_of_funds' },
  // Exit Evidence
  { pattern: /exit|refinance|sale.?contract|agent.?val|estate.?agent|aip|agreement.?in.?principle|rental|tenancy|ast/i, category: 'exit_evidence' },
  // Other Conditions
  { pattern: /insurance|buildings?.?ins|vacant.?prop|sec.?106|section.?106|planning.?condition|fire.?safety|party.?wall|building.?control/i, category: 'other_conditions' },
];

function categoriseFile(filename) {
  const lower = filename.toLowerCase();
  for (const { pattern, category } of categoryPatterns) {
    if (pattern.test(lower)) return category;
  }
  return 'general';
}

router.post('/:submissionId/smart-upload', authenticateToken, (req, res) => {
  smartUploadMulter(req, res, async (multerErr) => {
    try {
      if (multerErr) return res.status(400).json({ error: multerErr.message || 'Upload failed' });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files provided' });

      const dealResult = await pool.query(
        `SELECT id, dip_fee_confirmed FROM deal_submissions WHERE submission_id = $1`,
        [req.params.submissionId]
      );
      if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const dealId = dealResult.rows[0].id;

      // Ensure required columns exist (safe to run multiple times)
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS doc_category VARCHAR(50)`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS uploaded_by INT`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS file_content BYTEA`);

      // Check for existing files to prevent duplicates
      const existingDocs = await pool.query(
        `SELECT filename, file_size FROM deal_documents WHERE deal_id = $1`,
        [dealId]
      );
      const existingSet = new Set(existingDocs.rows.map(d => `${d.filename}::${d.file_size}`));

      const results = [];
      let skippedDupes = 0;
      for (const file of req.files) {
        // Skip duplicates (same filename + same size = same file)
        const fileKey = `${file.originalname}::${file.size}`;
        if (existingSet.has(fileKey)) {
          skippedDupes++;
          continue;
        }
        existingSet.add(fileKey); // Prevent dupes within same batch too

        let category = categoriseFile(file.originalname);
        let classifiedBy = 'filename';

        // If filename matching returned 'general', try AI content analysis
        if (category === 'general') {
          try {
            const aiCategory = await categoriseWithAI(file);
            if (aiCategory && aiCategory !== 'general') {
              category = aiCategory;
              classifiedBy = 'ai';
              console.log(`[smart-upload] AI classified "${file.originalname}" → ${category}`);
            }
          } catch (aiErr) {
            console.log('[smart-upload] AI categorisation skipped:', aiErr.message);
          }
        }

        // Always store file_content (BYTEA) — needed for AI extraction
        const result = await pool.query(
          `INSERT INTO deal_documents (deal_id, filename, file_type, file_size, file_content, doc_category, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, doc_category, uploaded_at`,
          [dealId, file.originalname, file.mimetype, file.size, file.buffer, category, req.user.userId]
        );

        results.push({ ...result.rows[0], category, classifiedBy });

        // Upload to OneDrive (non-blocking)
        try {
          const graphToken = await getGraphToken();
          const subfolder = `${req.params.submissionId}/${category}`;
          const uploadResult = await uploadFileToOneDrive(graphToken, subfolder, file.originalname, file.buffer);
          await pool.query(
            `UPDATE deal_documents SET onedrive_item_id = $1, onedrive_path = $2, onedrive_download_url = $3 WHERE id = $4`,
            [uploadResult.id, uploadResult.name, uploadResult.downloadUrl, result.rows[0].id]
          );
        } catch (odErr) {
          console.error('[smart-upload] OneDrive failed (non-blocking):', odErr.message);
        }
      }

      await logAudit(dealId, 'smart_upload', null, null,
        { files: results.map(r => ({ filename: r.filename, category: r.category })), uploaded_by: req.user.userId }, req.user.userId);

      console.log('[smart-upload]', results.length, 'files categorised,', skippedDupes, 'duplicates skipped for deal', req.params.submissionId);
      res.json({ success: true, results, skippedDuplicates: skippedDupes });
    } catch (error) {
      console.error('[smart-upload] Error:', error);
      res.status(500).json({ error: 'Smart upload failed: ' + error.message });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  AI EXTRACT — read uploaded docs and extract form data for a section
// ═══════════════════════════════════════════════════════════════════════════
const { extractSectionData } = require('../services/ai-extract');

router.post('/:submissionId/ai-extract/:section', authenticateToken, async (req, res) => {
  try {
    const { submissionId, section } = req.params;
    const validSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: 'Invalid section: ' + section });
    }

    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    // Step 1: Check how many docs exist for this section (with and without content)
    const countAll = await pool.query(
      `SELECT COUNT(*) as total FROM deal_documents WHERE deal_id = $1 AND doc_category = $2`,
      [dealId, section]
    );

    let countWithContent = { rows: [{ total: '0' }] };
    try {
      countWithContent = await pool.query(
        `SELECT COUNT(*) as total FROM deal_documents WHERE deal_id = $1 AND doc_category = $2 AND file_content IS NOT NULL`,
        [dealId, section]
      );
    } catch (e) {
      // file_content column doesn't exist at all
      console.log('[ai-extract] file_content column missing:', e.message);
      return res.status(400).json({
        error: 'Documents were uploaded without file content. Please clear documents and re-upload via the Smart Upload zone.',
        debug: { totalDocs: parseInt(countAll.rows[0].total), docsWithContent: 0 }
      });
    }

    const totalDocs = parseInt(countAll.rows[0].total);
    const docsWithContent = parseInt(countWithContent.rows[0].total);

    console.log(`[ai-extract] Section ${section}: ${totalDocs} total docs, ${docsWithContent} with file_content`);

    if (totalDocs === 0) {
      return res.status(400).json({ error: `No documents found in ${section.replace(/_/g, ' ')}. Upload documents first.`, debug: { totalDocs, docsWithContent } });
    }

    if (docsWithContent === 0) {
      return res.status(400).json({
        error: 'Documents exist but have no stored content. Please clear all documents and re-upload via Smart Upload.',
        debug: { totalDocs, docsWithContent }
      });
    }

    // Step 2: Fetch documents with content
    const docs = await pool.query(
      `SELECT filename, file_type, file_content as buffer FROM deal_documents
       WHERE deal_id = $1 AND doc_category = $2 AND file_content IS NOT NULL
       ORDER BY uploaded_at DESC LIMIT 10`,
      [dealId, section]
    );

    console.log(`[ai-extract] Extracting from ${docs.rows.length} docs for section: ${section}, deal: ${submissionId}`);

    // Step 3: Check buffer sizes
    for (const doc of docs.rows) {
      console.log(`[ai-extract]  - ${doc.filename}: buffer=${doc.buffer ? doc.buffer.length + ' bytes' : 'NULL'}, type=${doc.file_type}`);
    }

    const extracted = await extractSectionData(section, docs.rows);

    if (!extracted || Object.keys(extracted).length === 0) {
      return res.json({ success: true, extracted: {}, message: 'AI could not extract structured data from these documents. The PDFs may be image-based (scanned) rather than text-based.' });
    }

    res.json({ success: true, extracted, fieldsFound: Object.keys(extracted).length });
  } catch (error) {
    console.error('[ai-extract] Error:', error);
    res.status(500).json({ error: 'AI extraction failed: ' + error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CLEAR ALL UPLOADED DOCUMENTS (admin only — for re-upload)
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId/clear-documents', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const deleted = await pool.query(
      `DELETE FROM deal_documents WHERE deal_id = $1 RETURNING id`, [dealId]
    );
    console.log(`[clear-documents] Deleted ${deleted.rowCount} documents for deal ${req.params.submissionId}`);
    res.json({ success: true, deleted: deleted.rowCount });
  } catch (error) {
    console.error('[clear-documents] Error:', error);
    res.status(500).json({ error: 'Failed to clear documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LIST DOCUMENTS BY CATEGORY
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/documents-by-category', authenticateToken, async (req, res) => {
  try {
    // M5 post-scope (2026-04-20): broker cannot see 'issued' docs until the DIP
    // has been released to them (dip_broker_notified_at IS NOT NULL). Prevents
    // broker from downloading the DIP PDF via the repo before Credit approves.
    const isInternal = config.INTERNAL_ROLES.includes(req.user.role);
    const dealResult = await pool.query(
      `SELECT id, dip_broker_notified_at FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;
    const brokerNotifiedAt = dealResult.rows[0].dip_broker_notified_at;
    const hideIssuedFromBroker = !isInternal && !brokerNotifiedAt;

    // Try with doc_category column; fall back to without if column doesn't exist yet
    let result;
    try {
      const { category } = req.query;
      let query, params;
      // M5: build the issued-filter clause only when needed
      const issuedFilter = hideIssuedFromBroker
        ? " AND (doc_category IS NULL OR doc_category <> 'issued')"
        : '';
      if (category) {
        // If broker is asking specifically for the 'issued' category and they can't see it,
        // return an empty list cleanly rather than leaking existence via 403.
        if (hideIssuedFromBroker && category === 'issued') {
          return res.json({ documents: [] });
        }
        query = `SELECT id, filename, file_type, file_size, doc_category, uploaded_by, uploaded_at,
                        onedrive_download_url,
                        category_confirmed_by, category_confirmed_at, category_confirmed_name,
                        accepted_at, accepted_by, accepted_name,
                        doc_expiry_date, doc_issue_date,
                        parsed_at, parsed_data
                 FROM deal_documents WHERE deal_id = $1 AND doc_category = $2 ORDER BY uploaded_at DESC`;
        params = [dealId, category];
      } else {
        query = `SELECT id, filename, file_type, file_size, doc_category, uploaded_by, uploaded_at,
                        onedrive_download_url,
                        category_confirmed_by, category_confirmed_at, category_confirmed_name,
                        accepted_at, accepted_by, accepted_name,
                        doc_expiry_date, doc_issue_date,
                        parsed_at, parsed_data
                 FROM deal_documents WHERE deal_id = $1${issuedFilter} ORDER BY doc_category, uploaded_at DESC`;
        params = [dealId];
      }
      result = await pool.query(query, params);
    } catch (colErr) {
      // doc_category column may not exist yet — return all docs without category
      console.warn('[documents-by-category] Falling back (doc_category column may not exist):', colErr.message);
      result = await pool.query(
        `SELECT id, filename, file_type, file_size, uploaded_at, onedrive_download_url
         FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
        [dealId]
      );
    }

    res.json({ documents: result.rows });
  } catch (error) {
    console.error('[documents-by-category] Error:', error);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SUBMIT FOR REVIEW — Customer/broker marks deal ready for RM review
//  Triggers email + SMS notification to assigned RM
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/submit-for-review', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { completeness } = req.body; // frontend sends completeness %

    // Fetch deal
    const dealResult = await pool.query(
      `SELECT id, submission_id, user_id, borrower_user_id, assigned_rm, deal_stage,
              borrower_name, security_address, loan_amount, ltv_requested
       FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Access check — only deal owner, borrower, or internal
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    const config = require('../config');
    const isInternal = config.INTERNAL_ROLES.includes(req.user.role);
    if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

    // If deal was in draft and has no RM assigned, auto-assign from broker's default_rm
    const prevStage = deal.deal_stage;
    if ((prevStage === 'draft' || !deal.assigned_rm) && req.user.role === 'broker') {
      try {
        const brokerOnb = await pool.query('SELECT default_rm FROM broker_onboarding WHERE user_id = $1', [req.user.userId]);
        if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm && !deal.assigned_rm) {
          await pool.query(
            `UPDATE deal_submissions SET assigned_rm = $1, assigned_to = $1 WHERE id = $2`,
            [brokerOnb.rows[0].default_rm, deal.id]
          );
          deal.assigned_rm = brokerOnb.rows[0].default_rm;
        }
      } catch (rmErr) {
        console.warn('[submit-review] RM auto-assign failed:', rmErr.message);
      }
    }

    // Update deal stage to info_gathering (RM needs to review)
    await pool.query(
      `UPDATE deal_submissions SET deal_stage = 'info_gathering', updated_at = NOW() WHERE id = $1`,
      [deal.id]
    );

    const submitterName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email;

    // Audit log
    const { logAudit } = require('../services/audit');
    await logAudit(deal.id, 'deal_submitted_for_review', prevStage, 'info_gathering', {
      submitted_by: req.user.userId,
      submitter_name: submitterName,
      submitter_role: req.user.role,
      completeness: completeness || null
    }, req.user.userId);

    // ── Send RM notification (email) ──
    let notificationSent = false;
    if (deal.assigned_rm) {
      try {
        // Get RM's email
        const rmResult = await pool.query(
          `SELECT email, first_name, last_name, phone FROM users WHERE id = $1`,
          [deal.assigned_rm]
        );

        if (rmResult.rows.length > 0) {
          const rm = rmResult.rows[0];
          const { sendDealEmail } = require('../services/email');

          const dealData = {
            submission_id: deal.submission_id,
            borrower_name: deal.borrower_name,
            security_address: deal.security_address,
            loan_amount: deal.loan_amount,
            ltv_requested: deal.ltv_requested,
            submitted_by_name: submitterName,
            submitted_by_role: req.user.role,
            completeness: completeness || 'N/A'
          };

          await sendDealEmail('deal_submitted_for_review', dealData, rm.email);
          notificationSent = true;
          console.log(`[submit-review] RM notification sent to ${rm.email} for deal ${submissionId}`);

          // Also try SMS if RM has a phone number
          try {
            const { sendDealSms } = require('../services/sms');
            if (rm.phone) {
              await sendDealSms('deal_review_needed', dealData, rm.phone);
              console.log(`[submit-review] SMS sent to RM ${rm.phone}`);
            }
          } catch (smsErr) {
            console.warn('[submit-review] SMS failed (non-critical):', smsErr.message);
          }
        }
      } catch (notifyErr) {
        console.error('[submit-review] Notification error (non-critical):', notifyErr.message);
      }
    } else {
      console.warn(`[submit-review] No RM assigned to deal ${submissionId} — skipping notification`);
    }

    res.json({
      success: true,
      message: 'Deal submitted for review' + (notificationSent ? ' — RM has been notified' : ''),
      deal_stage: 'info_gathering',
      notification_sent: notificationSent,
      submission_id: submissionId
    });
  } catch (error) {
    console.error('[submit-review] Error:', error);
    res.status(500).json({ error: 'Failed to submit deal for review' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SUBMIT DRAFT — Move deal from 'draft' to 'received', assign RM
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/submit-draft', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;

    const dealResult = await pool.query(
      `SELECT id, submission_id, user_id, borrower_user_id, deal_stage
       FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Only owner can submit their draft
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });

    // Only draft deals can be submitted
    if (deal.deal_stage !== 'draft') {
      return res.status(400).json({ error: 'Only draft deals can be submitted. This deal is already ' + deal.deal_stage });
    }

    // Auto-assign RM from broker's default_rm if applicable
    let assignedRm = null;
    if (req.user.role === 'broker') {
      try {
        const brokerOnb = await pool.query('SELECT default_rm FROM broker_onboarding WHERE user_id = $1', [req.user.userId]);
        if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
          assignedRm = brokerOnb.rows[0].default_rm;
        }
      } catch (rmErr) {
        console.warn('[submit-draft] RM auto-assign lookup failed:', rmErr.message);
      }
    }

    // Move to 'received' (or 'assigned' if RM found)
    const newStage = assignedRm ? 'assigned' : 'received';
    const updateFields = assignedRm
      ? `deal_stage = '${newStage}', assigned_rm = ${assignedRm}, assigned_to = ${assignedRm}, updated_at = NOW()`
      : `deal_stage = '${newStage}', updated_at = NOW()`;

    await pool.query(`UPDATE deal_submissions SET ${updateFields} WHERE id = $1`, [deal.id]);

    // Audit
    await logAudit(deal.id, 'deal_submitted', 'draft', newStage, {
      submitted_by: req.user.userId,
      assigned_rm: assignedRm
    }, req.user.userId);

    console.log(`[submit-draft] Deal ${submissionId} moved from draft to ${newStage}`);
    res.json({ success: true, message: 'Deal submitted successfully', deal_stage: newStage });
  } catch (error) {
    console.error('[submit-draft] Error:', error);
    res.status(500).json({ error: 'Failed to submit deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE DRAFT — Hard delete a deal that is still in 'draft' stage
//  Cascades: deal_documents, deal_properties, deal_borrowers, audit_log
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;

    const dealResult = await pool.query(
      `SELECT id, submission_id, user_id, borrower_user_id, deal_stage
       FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Only owner can delete their deal
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    if (!isOwner) return res.status(403).json({ error: 'Access denied — only the deal creator can delete it' });

    // CRITICAL: Only draft deals can be deleted
    if (deal.deal_stage !== 'draft') {
      return res.status(400).json({
        error: 'Only draft deals can be deleted. This deal has been submitted and is now in stage: ' + deal.deal_stage
      });
    }

    console.log(`[delete-deal] Deleting draft deal ${submissionId} (internal id: ${deal.id})`);

    // Delete all related records in dependency order (most will be empty for drafts)
    const relatedTables = [
      'deal_documents', 'deal_properties', 'deal_borrowers',
      'deal_field_status', 'deal_info_requests', 'deal_documents_issued',
      'deal_document_repo', 'deal_fee_payments', 'deal_approvals',
      'analysis_results', 'client_notes', 'deal_audit_log'
    ];
    for (const table of relatedTables) {
      try {
        await pool.query(`DELETE FROM ${table} WHERE deal_id = $1`, [deal.id]);
      } catch (tableErr) {
        // Table might not exist yet — that's fine
        console.log(`[delete-deal] Note cleaning ${table}:`, tableErr.message.substring(0, 40));
      }
    }

    // Delete the deal itself
    await pool.query('DELETE FROM deal_submissions WHERE id = $1', [deal.id]);

    console.log(`[delete-deal] Draft deal ${submissionId} permanently deleted`);
    res.json({ success: true, message: 'Draft deal deleted' });
  } catch (error) {
    console.error('[delete-deal] Error:', error);
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 3 #15 — Borrower exposure / concentration risk aggregator
// ═══════════════════════════════════════════════════════════════════════════
// GET /api/deals/:submissionId/borrower-exposure
//
// Returns the count + total loan exposure of OTHER Daksfirst deals whose
// borrowers match this deal's borrowers (by CH number / email / name+DOB).
// Internal users only — concentration is risk-team data, not broker-facing.
router.get('/:submissionId/borrower-exposure', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      'SELECT id FROM deal_submissions WHERE submission_id = $1',
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    const exposure = await getExposureForDeal(dealResult.rows[0].id);
    res.json({ success: true, data: exposure });
  } catch (err) {
    console.error('[borrower-exposure] error:', err);
    res.status(500).json({ error: 'Failed to compute borrower exposure' });
  }
});

module.exports = router;
