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
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Broker/internal: see deals they submitted or are assigned to
    // Borrower: see deals assigned to them
    let query, params;

    if (req.user.role === 'borrower') {
      query = `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.security_address,
                      ds.loan_amount, ds.loan_purpose, ds.asset_type, ds.created_at, ds.updated_at,
                      COUNT(dd.id) as document_count
               FROM deal_submissions ds
               LEFT JOIN deal_documents dd ON ds.id = dd.deal_id
               WHERE ds.borrower_user_id = $1
               GROUP BY ds.id
               ORDER BY ds.created_at DESC`;
      params = [req.user.userId];
    } else {
      query = `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.security_address,
                      ds.loan_amount, ds.loan_purpose, ds.asset_type, ds.created_at, ds.updated_at,
                      COUNT(dd.id) as document_count
               FROM deal_submissions ds
               LEFT JOIN deal_documents dd ON ds.id = dd.deal_id
               WHERE ds.user_id = $1
               GROUP BY ds.id
               ORDER BY ds.created_at DESC`;
      params = [req.user.userId];
    }

    const result = await pool.query(query, params);
    res.json({ success: true, deals: result.rows });
  } catch (error) {
    console.error('[deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET SINGLE DEAL (Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId', authenticateToken, async (req, res) => {
  try {
    // Broker/internal: see deals they submitted or are assigned to
    // Borrower: see deals assigned to them
    let dealResult;

    if (req.user.role === 'borrower') {
      dealResult = await pool.query(
        `SELECT * FROM deal_submissions WHERE submission_id = $1 AND borrower_user_id = $2`,
        [req.params.submissionId, req.user.userId]
      );
    } else {
      dealResult = await pool.query(
        `SELECT * FROM deal_submissions WHERE submission_id = $1 AND user_id = $2`,
        [req.params.submissionId, req.user.userId]
      );
    }

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Get documents
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
      [dealId]
    );

    // Get analysis results
    const analysisResult = await pool.query(
      `SELECT credit_memo_url, termsheet_url, gbb_memo_url, analysis_json, completed_at
       FROM analysis_results WHERE deal_id = $1`,
      [dealId]
    );

    res.json({
      success: true,
      deal: {
        ...deal,
        documents: docsResult.rows,
        analysis: analysisResult.rows[0] || null
      }
    });
  } catch (error) {
    console.error('[deal-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deal details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DEAL STATUS (from webhook callback)
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/status', authenticateToken, validate('dealStatusUpdate'), async (req, res) => {
  try {
    const { status, internal_status } = req.validated;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const result = await pool.query(
      `UPDATE deal_submissions
       SET status = $1, internal_status = COALESCE($2, internal_status), updated_at = NOW()
       WHERE submission_id = $3 AND user_id = $4
       RETURNING id, submission_id, status, updated_at`,
      [status, internal_status || null, req.params.submissionId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    console.log('[deal-update] Deal', req.params.submissionId, 'status updated to', status);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[deal-update] Error:', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SAVE ONBOARDING DATA (Phase 2 — per tab)
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/onboarding', authenticateToken, validate('dealOnboarding'), async (req, res) => {
  try {
    const { tab, data } = req.validated;
    if (!tab || !data) return res.status(400).json({ error: 'Tab name and data are required' });

    // Valid Phase 2 tabs
    const validTabs = ['kyc', 'financials', 'valuation', 'refurbishment', 'exit_evidence', 'aml', 'insurance'];
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
router.get('/:submissionId/audit', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const auditResult = await pool.query(
      `SELECT a.id, a.action, a.from_value, a.to_value, a.details, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_audit_log a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC`,
      [dealResult.rows[0].id]
    );

    res.json({ success: true, audit: auditResult.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET FEES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/fees', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const feesResult = await pool.query(
      `SELECT f.id, f.fee_type, f.amount, f.payment_date, f.payment_ref, f.notes, f.created_at,
              u.first_name, u.last_name
       FROM deal_fee_payments f
       LEFT JOIN users u ON f.confirmed_by = u.id
       WHERE f.deal_id = $1
       ORDER BY f.created_at DESC`,
      [dealResult.rows[0].id]
    );

    res.json({ success: true, fees: feesResult.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch fees' });
  }
});

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

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

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

    // 2. Generate Termsheet DOCX (branded with VML letterhead)
    const { generateTermsheetDocx } = require('../services/termsheet-doc');
    console.log('[issue-termsheet] Generating Termsheet DOCX for', req.params.submissionId);
    const docxBuffer = await generateTermsheetDocx(aiData.termsheet);
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
router.post('/:submissionId/invite-borrower', authenticateToken, authenticateInternal, validate('inviteBorrower'), async (req, res) => {
  try {
    const { borrower_invite_email } = req.validated;
    if (!borrower_invite_email) return res.status(400).json({ error: 'Borrower email is required' });

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        borrower_invited_at = NOW(),
        borrower_invite_email = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, borrower_invited_at, borrower_invite_email`,
      [borrower_invite_email, dealId]
    );

    await logAudit(dealId, 'borrower_invited', dealResult.rows[0].status, 'borrower_invited',
      { email: borrower_invite_email }, req.user.userId);

    res.json({ success: true, deal: result.rows[0], message: 'Invitation sent' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to invite borrower' });
  }
});

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

module.exports = router;
