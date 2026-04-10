const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { authenticateInternal } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { notifyDealEvent } = require('../services/notifications');
const { generateDipPdf } = require('../services/dip-pdf');
// const { sendForSigning } = require('../services/docusign'); // Parked — will use for Termsheet/Facility Letter
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');

// ═══════════════════════════════════════════════════════════════════════════
//  LIST DEALS (dashboard)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { userId, role } = req.user;
    let result;

    if (['admin', 'credit', 'compliance', 'rm'].includes(role)) {
      // Internal staff see all deals
      result = await pool.query(
        `SELECT d.*, u.first_name AS broker_first, u.last_name AS broker_last, u.email AS broker_email
         FROM deal_submissions d
         LEFT JOIN users u ON d.user_id = u.id
         ORDER BY d.created_at DESC`
      );
    } else {
      // Brokers / borrowers see only their own
      result = await pool.query(
        `SELECT * FROM deal_submissions WHERE user_id = $1 ORDER BY created_at DESC`,
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

    res.json({ deal: result.rows[0] });
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
router.post('/:submissionId/issue-dip', authenticateToken, authenticateInternal, validate('issueDip'), async (req, res) => {
  try {
    const { notes, dip_data } = req.validated;

    // 1. Fetch full deal data
    const dealResult = await pool.query(`SELECT * FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;
    const userId = deal.user_id;

    // 2. Get borrowers for this deal (for the DIP PDF)
    const borrowersResult = await pool.query(
      `SELECT full_name, role, email, kyc_status FROM deal_borrowers WHERE deal_id = $1 ORDER BY id`,
      [dealId]
    );
    const dipDataWithBorrowers = {
      ...dip_data,
      notes,
      borrowers: borrowersResult.rows.map(b => ({
        name: b.full_name,
        role: b.role,
        email: b.email,
        kyc_verified: b.kyc_status === 'verified'
      }))
    };

    // 3. Generate DIP PDF (branded)
    console.log('[issue-dip] Generating DIP PDF for', req.params.submissionId);
    const pdfBuffer = await generateDipPdf(deal, dipDataWithBorrowers, {
      issuedBy: req.user.userId,
      issuedAt: new Date().toISOString()
    });
    const pdfFilename = `DIP_${req.params.submissionId}.pdf`;

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

    // 5. Update deal in database
    const updateFields = [
      `status = 'dip_issued'`,
      `deal_stage = 'dip_issued'`,
      `dip_issued_at = NOW()`,
      `dip_issued_by = $1`,
      `dip_notes = $2`,
      `dip_pdf_url = $3`,
      `dip_signed = false`,
      `updated_at = NOW()`
    ];
    const updateValues = [req.user.userId, notes || null, dipPdfUrl || null];
    let paramIdx = 4;

    // Store structured DIP data
    if (dip_data) {
      updateFields.push(`ai_termsheet_data = $${paramIdx}`);
      updateValues.push(JSON.stringify(dip_data));
      paramIdx++;

      // Also update core deal fields from DIP data
      const fieldMap = {
        loan_amount: 'loan_amount',
        ltv: 'ltv_requested',
        term_months: 'term_months',
        rate_monthly: 'rate_requested',
        property_value: 'current_value',
        exit_strategy: 'exit_strategy',
        interest_servicing: 'interest_servicing'
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

    await logAudit(dealId, 'dip_issued', deal.status, 'dip_issued', {
      issued_by: req.user.userId,
      dip_data_stored: !!dip_data,
      pdf_generated: !!pdfBuffer,
      pdf_uploaded: !!dipPdfUrl
    }, req.user.userId);

    // Notify broker via email
    const brokerEmailResult = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (brokerEmailResult.rows.length > 0) {
      await notifyDealEvent('dip_issued', result.rows[0], [brokerEmailResult.rows[0].email]);
    }

    res.json({
      success: true,
      deal: result.rows[0],
      pdf_url: dipPdfUrl
    });
  } catch (error) {
    console.error('[issue-dip] Error:', error);
    res.status(500).json({ error: 'Failed to issue DIP' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  VIEW DIP PDF — On-the-fly generation (works even if OneDrive URL is missing)
// ═══════════════════════════════════════════════════════════════════════════
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

    // Get DIP data from the stored ai_termsheet_data (which holds dip_data at this stage)
    const dipData = typeof deal.ai_termsheet_data === 'string'
      ? JSON.parse(deal.ai_termsheet_data) : (deal.ai_termsheet_data || {});

    // Apply credit overrides (if credit has reviewed and overridden values)
    if (dipData.credit_override_rate !== undefined) {
      dipData.rate_monthly = dipData.credit_override_rate;
    }
    if (dipData.credit_override_ltv !== undefined) {
      dipData.ltv = dipData.credit_override_ltv;
    }
    if (dipData.credit_override_arr_fee !== undefined) {
      dipData.arrangement_fee = dipData.credit_override_arr_fee;
      dipData.arrangement_fee_pct = dipData.credit_override_arr_fee;
    }

    // Get borrowers
    const borrowersResult = await pool.query(
      `SELECT full_name, role, email, kyc_status FROM deal_borrowers WHERE deal_id = $1 ORDER BY id`, [dealId]
    );
    const dipDataWithBorrowers = {
      ...dipData,
      borrowers: borrowersResult.rows.map(b => ({ name: b.full_name, role: b.role, email: b.email, kyc_verified: b.kyc_status === 'verified' }))
    };

    const pdfBuffer = await generateDipPdf(deal, dipDataWithBorrowers, {
      issuedBy: deal.dip_issued_by || 'System',
      issuedAt: deal.dip_issued_at || new Date().toISOString()
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="DIP_${req.params.submissionId}.pdf"`);
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
      `SELECT id, submission_id, status, deal_stage, dip_signed, credit_recommendation FROM deal_submissions WHERE submission_id = $1`,
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

    // Accept DIP and advance to info_gathering (credit already approved)
    await pool.query(
      `UPDATE deal_submissions SET
        dip_signed = true,
        dip_signed_at = NOW(),
        status = 'info_gathering',
        deal_stage = 'info_gathering',
        updated_at = NOW()
       WHERE id = $1`,
      [deal.id]
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
      `SELECT id, status, dip_fee_confirmed, onboarding_approval FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // GATE: Onboarding fee must be confirmed
    if (!deal.dip_fee_confirmed) {
      return res.status(400).json({ error: 'Onboarding fee must be confirmed before generating AI termsheet' });
    }

    // GATE: All 6 onboarding sections must be approved by RM
    const requiredSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    const approval = deal.onboarding_approval || {};
    const unapproved = requiredSections.filter(s => !approval[s] || !approval[s].approved);
    if (unapproved.length > 0) {
      return res.status(400).json({
        error: `All onboarding sections must be approved before generating AI termsheet. Missing: ${unapproved.join(', ')}`,
        missing_sections: unapproved
      });
    }

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'ai_termsheet',
        ai_termsheet_data = $1,
        ai_termsheet_generated_at = NOW(),
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, ai_termsheet_generated_at`,
      [ai_termsheet_data ? JSON.stringify(ai_termsheet_data) : '{}', dealId]
    );

    await logAudit(dealId, 'ai_termsheet_generated', dealResult.rows[0].status, 'ai_termsheet',
      { generated_by: req.user.userId }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
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

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'bank_submitted',
        bank_submitted_at = NOW(),
        bank_submitted_by = $1,
        bank_reference = $2,
        updated_at = NOW()
       WHERE id = $3 RETURNING submission_id, status, bank_submitted_at, bank_reference`,
      [req.user.userId, bank_reference || null, dealId]
    );

    await logAudit(dealId, 'bank_submitted', dealResult.rows[0].status, 'bank_submitted',
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
      'deposit_source', 'concurrent_transactions'
    ];

    // Numeric fields that need parsing
    const numericFields = [
      'current_value', 'loan_amount', 'ltv_requested', 'term_months',
      'rate_requested', 'purchase_price', 'refurb_cost'
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
              'X-Webhook-Secret': config.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
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
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    // Try with doc_category column; fall back to without if column doesn't exist yet
    let result;
    try {
      const { category } = req.query;
      let query, params;
      if (category) {
        query = `SELECT id, filename, file_type, file_size, doc_category, uploaded_by, uploaded_at,
                        onedrive_download_url
                 FROM deal_documents WHERE deal_id = $1 AND doc_category = $2 ORDER BY uploaded_at DESC`;
        params = [dealId, category];
      } else {
        query = `SELECT id, filename, file_type, file_size, doc_category, uploaded_by, uploaded_at,
                        onedrive_download_url
                 FROM deal_documents WHERE deal_id = $1 ORDER BY doc_category, uploaded_at DESC`;
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

module.exports = router;
