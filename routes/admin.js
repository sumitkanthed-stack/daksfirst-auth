const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const pool = require('../db/pool');
const { authenticateToken, authenticateAdmin, authenticateInternal } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const alphaClient = require('../services/alpha-client');
const featurePackager = require('../services/deal-feature-packager');
const anthropicAnalyst = require('../services/anthropic-analyst');
const riskPackager = require('../services/risk-packager');

const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET ALL DEALS (with pagination & filtering)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/deals', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, asset_type, broker, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // 2026-04-21: include portfolio properties + top-level borrowers so the
    // shared display helpers (js/deal-display.js) can derive the primary
    // property address and primary borrower name the same way on the Admin
    // deals table as they do on Snapshot/Matrix. Same subquery pattern as
    // routes/deals.js list endpoint.
    let query = `SELECT ds.id, ds.submission_id, ds.status, ds.deal_stage,
                        ds.borrower_name, ds.borrower_company, ds.borrower_type,
                        ds.company_name, ds.company_number,
                        ds.broker_name, ds.broker_company,
                        ds.loan_amount, ds.loan_amount_requested, ds.loan_amount_approved,
                        ds.current_value, ds.purchase_price, ds.ltv_requested, ds.ltv_approved,
                        ds.security_address, ds.security_postcode,
                        ds.asset_type, ds.term_months, ds.rate_requested, ds.exit_strategy,
                        ds.interest_servicing, ds.loan_purpose,
                        ds.drawdown_date, ds.created_at, ds.updated_at,
                        ds.assigned_rm, ds.assigned_credit, ds.assigned_compliance,
                        ds.internal_status, ds.dip_fee_confirmed, ds.commitment_fee_received,
                        ds.fee_requested_amount, ds.fee_requested_at,
                        ds.dip_issued_at, ds.bank_submitted_at, ds.bank_approved_at,
                        ds.rm_recommendation, ds.credit_recommendation, ds.compliance_recommendation, ds.final_decision,
                        rm.first_name as rm_first, rm.last_name as rm_last,
                        cr.first_name as credit_first, cr.last_name as credit_last,
                        co.first_name as comp_first, co.last_name as comp_last,
                        u.first_name as submitter_first, u.last_name as submitter_last,
                        COALESCE((
                          SELECT json_agg(json_build_object(
                            'address', address,
                            'postcode', postcode,
                            'market_value', market_value,
                            'property_type', property_type,
                            'tenure', tenure
                          ) ORDER BY market_value DESC NULLS LAST, address ASC)
                          FROM deal_properties WHERE deal_id = ds.id
                        ), '[]'::json) AS properties,
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
                          FROM deal_borrowers WHERE deal_id = ds.id AND parent_borrower_id IS NULL
                        ), '[]'::json) AS borrowers
                 FROM deal_submissions ds
                 LEFT JOIN users rm ON ds.assigned_rm = rm.id
                 LEFT JOIN users cr ON ds.assigned_credit = cr.id
                 LEFT JOIN users co ON ds.assigned_compliance = co.id
                 LEFT JOIN users u ON ds.user_id = u.id
                 WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND ds.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    if (asset_type) {
      query += ` AND ds.asset_type = $${paramCount}`;
      params.push(asset_type);
      paramCount++;
    }
    if (broker) {
      query += ` AND ds.broker_company ILIKE $${paramCount}`;
      params.push(`%${broker}%`);
      paramCount++;
    }

    query += ` ORDER BY ds.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM deal_submissions WHERE 1=1`;
    const countParams = [];
    let countParamCount = 1;

    if (status) {
      countQuery += ` AND status = $${countParamCount}`;
      countParams.push(status);
      countParamCount++;
    }
    if (asset_type) {
      countQuery += ` AND asset_type = $${countParamCount}`;
      countParams.push(asset_type);
      countParamCount++;
    }
    if (broker) {
      countQuery += ` AND broker_company ILIKE $${countParamCount}`;
      countParams.push(`%${broker}%`);
      countParamCount++;
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = countResult.rows[0].total;

    res.json({
      success: true,
      deals: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[admin-deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET SINGLE DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.get('/deals/:submissionId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT ds.*,
              u.first_name, u.last_name, u.email as submitter_email,
              rm.first_name as rm_first, rm.last_name as rm_last, rm.email as rm_email,
              cr.first_name as credit_first, cr.last_name as credit_last,
              co.first_name as comp_first, co.last_name as comp_last,
              fd.first_name as decision_first, fd.last_name as decision_last
       FROM deal_submissions ds
       LEFT JOIN users u ON ds.user_id = u.id
       LEFT JOIN users rm ON ds.assigned_rm = rm.id
       LEFT JOIN users cr ON ds.assigned_credit = cr.id
       LEFT JOIN users co ON ds.assigned_compliance = co.id
       LEFT JOIN users fd ON ds.final_decision_by = fd.id
       WHERE ds.submission_id = $1`,
      [req.params.submissionId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Get documents
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, uploaded_at FROM deal_documents WHERE deal_id = $1`,
      [dealId]
    );

    // Get analysis
    const analysisResult = await pool.query(
      `SELECT credit_memo_url, termsheet_url, gbb_memo_url, completed_at FROM analysis_results WHERE deal_id = $1`,
      [dealId]
    );

    // Get notes
    const notesResult = await pool.query(
      `SELECT cn.id, cn.note, cn.created_at, u.first_name, u.last_name, u.email
       FROM client_notes cn
       LEFT JOIN users u ON cn.created_by = u.id
       WHERE cn.deal_id = $1 OR (cn.user_id = (SELECT user_id FROM deal_submissions WHERE id = $1))
       ORDER BY cn.created_at DESC`,
      [dealId]
    );

    // Get audit log
    const auditResult = await pool.query(
      `SELECT a.id, a.action, a.from_value, a.to_value, a.details, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_audit_log a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC LIMIT 50`,
      [dealId]
    );

    // Get fee payments
    const feesResult = await pool.query(
      `SELECT f.id, f.fee_type, f.amount, f.payment_date, f.payment_ref, f.notes, f.created_at,
              u.first_name, u.last_name
       FROM deal_fee_payments f
       LEFT JOIN users u ON f.confirmed_by = u.id
       WHERE f.deal_id = $1
       ORDER BY f.created_at DESC`,
      [dealId]
    );

    // Get approvals
    const approvalsResult = await pool.query(
      `SELECT a.id, a.approval_stage, a.decision, a.comments, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_approvals a
       LEFT JOIN users u ON a.decided_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC`,
      [dealId]
    );

    // Get borrowers
    const borrowersResult = await pool.query(
      `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, created_at`, [dealId]
    );

    // Get properties
    const propertiesResult = await pool.query(
      `SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY created_at`, [dealId]
    );
    const portfolioSummary = {
      total_properties: propertiesResult.rows.length,
      total_market_value: propertiesResult.rows.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0),
      total_gdv: propertiesResult.rows.reduce((sum, p) => sum + (parseFloat(p.gdv) || 0), 0)
    };

    // ── SmartSearch KYC checks (2026-04-27) ────────────────────────────────
    // Append-only kyc_checks history for this deal. Lightweight projection —
    // full raw vendor JSON stays in DB, frontend gets just enough to render
    // status pills and action buttons per borrower/property.
    const kycChecksResult = await pool.query(
      `SELECT id, deal_id, borrower_id, director_id, company_id, check_type, provider,
              subject_first_name, subject_last_name, subject_company_name,
              result_status, result_score, mode, cost_pence,
              requested_by, requested_at, parent_check_id, is_monitoring_update, pull_error
         FROM kyc_checks
        WHERE deal_id = $1
        ORDER BY requested_at DESC`,
      [dealId]
    );

    res.json({
      success: true,
      deal: {
        ...deal,
        documents: docsResult.rows,
        analysis: analysisResult.rows[0] || null,
        notes: notesResult.rows,
        audit: auditResult.rows,
        fees: feesResult.rows,
        approvals: approvalsResult.rows,
        borrowers: borrowersResult.rows,
        properties: propertiesResult.rows,
        portfolio_summary: portfolioSummary,
        kyc_checks: kycChecksResult.rows
      }
    });
  } catch (error) {
    console.error('[admin-deal-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deal details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: UPDATE DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.put('/deals/:submissionId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, admin_notes, assigned_to, internal_status } = req.body;

    const result = await pool.query(
      `UPDATE deal_submissions
       SET status = COALESCE($1, status),
           admin_notes = COALESCE($2, admin_notes),
           assigned_to = COALESCE($3, assigned_to),
           internal_status = COALESCE($4, internal_status),
           updated_at = NOW()
       WHERE submission_id = $5
       RETURNING id, submission_id, status, internal_status, assigned_to, updated_at`,
      [status || null, admin_notes || null, assigned_to || null, internal_status || null, req.params.submissionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    console.log('[admin-update] Deal', req.params.submissionId, 'updated by admin', req.user.userId);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[admin-update] Error:', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: UPDATE DEAL STAGE
// ═══════════════════════════════════════════════════════════════════════════
router.put('/deals/:submissionId/stage', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { stage } = req.body;
    const validStages = ['dip', 'dip_issued', 'termsheet_sent', 'termsheet_signed', 'underwriting', 'approved', 'legal', 'funds_released', 'declined', 'withdrawn'];
    if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid deal stage' });

    const updates = ['deal_stage = $1', 'updated_at = NOW()'];
    const values = [stage];

    if (stage === 'termsheet_signed') {
      updates.push('termsheet_signed_at = NOW()');
    }

    const result = await pool.query(
      `UPDATE deal_submissions SET ${updates.join(', ')} WHERE submission_id = $${values.length + 1} RETURNING id, submission_id, deal_stage`,
      [...values, req.params.submissionId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    console.log(`[admin] Deal ${req.params.submissionId} stage updated to: ${stage}`);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[admin-stage] Error:', error);
    res.status(500).json({ error: 'Failed to update deal stage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ASSIGN DEAL TO RM
// ═══════════════════════════════════════════════════════════════════════════
router.put('/deals/:submissionId/assign', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { rm_id } = req.body;
    if (!rm_id) return res.status(400).json({ error: 'RM user ID is required' });

    // Verify the user is an RM (not a broker or borrower)
    const rmCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [rm_id]);
    if (rmCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (!['rm', 'admin'].includes(rmCheck.rows[0].role)) {
      return res.status(400).json({ error: 'Can only assign deals to RM or Admin staff. Brokers and borrowers cannot be assigned deals.' });
    }

    const dealResult = await pool.query(
      `SELECT id, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = dealResult.rows[0];
    const oldRm = deal.assigned_rm;
    const rm = rmCheck.rows[0];

    await pool.query(
      `UPDATE deal_submissions SET assigned_rm = $1, assigned_to = $1, deal_stage = CASE WHEN deal_stage IN ('received', 'dip') THEN 'assigned' ELSE deal_stage END, updated_at = NOW() WHERE id = $2`,
      [rm_id, deal.id]
    );

    await logAudit(deal.id, 'deal_assigned_to_rm', oldRm ? String(oldRm) : null, String(rm_id),
      { rm_name: `${rm.first_name} ${rm.last_name}`, assigned_by: req.user.userId }, req.user.userId);

    res.json({ success: true, message: `Deal assigned to ${rm.first_name} ${rm.last_name}` });
  } catch (error) {
    console.error('[assign-rm] Error:', error);
    res.status(500).json({ error: 'Failed to assign deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ASSIGN CREDIT ANALYST / COMPLIANCE TO DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.put('/deals/:submissionId/assign-reviewer', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { credit_id, compliance_id } = req.body;

    const dealResult = await pool.query(
      `SELECT id, assigned_credit, assigned_compliance FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (credit_id) {
      const creditCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [credit_id]);
      if (creditCheck.rows.length === 0) return res.status(404).json({ error: 'Credit analyst not found' });
      if (!['credit', 'admin'].includes(creditCheck.rows[0].role)) {
        return res.status(400).json({ error: 'User must have credit or admin role' });
      }
      await pool.query(`UPDATE deal_submissions SET assigned_credit = $1, updated_at = NOW() WHERE id = $2`, [credit_id, deal.id]);
      await logAudit(deal.id, 'assigned_credit_analyst', deal.assigned_credit ? String(deal.assigned_credit) : null, String(credit_id),
        { name: `${creditCheck.rows[0].first_name} ${creditCheck.rows[0].last_name}` }, req.user.userId);
    }

    if (compliance_id) {
      const compCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [compliance_id]);
      if (compCheck.rows.length === 0) return res.status(404).json({ error: 'Compliance officer not found' });
      if (!['compliance', 'admin'].includes(compCheck.rows[0].role)) {
        return res.status(400).json({ error: 'User must have compliance or admin role' });
      }
      await pool.query(`UPDATE deal_submissions SET assigned_compliance = $1, updated_at = NOW() WHERE id = $2`, [compliance_id, deal.id]);
      await logAudit(deal.id, 'assigned_compliance', deal.assigned_compliance ? String(deal.assigned_compliance) : null, String(compliance_id),
        { name: `${compCheck.rows[0].first_name} ${compCheck.rows[0].last_name}` }, req.user.userId);
    }

    res.json({ success: true, message: 'Reviewers assigned' });
  } catch (error) {
    console.error('[assign-reviewer] Error:', error);
    res.status(500).json({ error: 'Failed to assign reviewers' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET ALL USERS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/users', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { role, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.company,
                        u.role, u.fca_number, u.created_at,
                        COUNT(DISTINCT ds.id) as deal_count
                 FROM users u
                 LEFT JOIN deal_submissions ds ON u.id = ds.user_id
                 WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (role) {
      query += ` AND u.role = $${paramCount}`;
      params.push(role);
      paramCount++;
    }

    query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM users WHERE 1=1`;
    if (role) {
      countQuery += ` AND role = $1`;
    }
    const countResult = await pool.query(countQuery, role ? [role] : []);
    const total = countResult.rows[0].total;

    res.json({
      success: true,
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[admin-users] Error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET USER DETAILS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/users/:userId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, first_name, last_name, email, phone, company, role, fca_number,
              loan_purpose, loan_amount, created_at, email_verified
       FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get user's deals
    const dealsResult = await pool.query(
      `SELECT id, submission_id, status, borrower_name, loan_amount, asset_type, created_at
       FROM deal_submissions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );

    res.json({
      success: true,
      user: {
        ...user,
        deals: dealsResult.rows
      }
    });
  } catch (error) {
    console.error('[admin-user-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ADD NOTE TO DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.post('/users/:userId/notes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { deal_id, note } = req.body;

    if (!note) {
      return res.status(400).json({ error: 'Note is required' });
    }

    const result = await pool.query(
      `INSERT INTO client_notes (user_id, deal_id, note, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, note, created_at`,
      [req.params.userId, deal_id || null, note, req.user.userId]
    );

    console.log('[admin-note] Note added by admin', req.user.userId, 'for user', req.params.userId);
    res.status(201).json({ success: true, note: result.rows[0] });
  } catch (error) {
    console.error('[admin-note] Error:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    // Total deals by status
    const statusResult = await pool.query(
      `SELECT status, COUNT(*) as count FROM deal_submissions GROUP BY status`
    );

    // Total users
    const userResult = await pool.query(
      `SELECT role, COUNT(*) as count FROM users WHERE role IN ('broker', 'borrower') GROUP BY role`
    );

    // Deals by month (last 12 months)
    const monthResult = await pool.query(
      `SELECT DATE_TRUNC('month', created_at)::DATE as month, COUNT(*) as count
       FROM deal_submissions
       WHERE created_at > NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY month DESC`
    );

    // Average LTV
    const ltvResult = await pool.query(
      `SELECT AVG(ltv_requested) as avg_ltv, MIN(ltv_requested) as min_ltv, MAX(ltv_requested) as max_ltv
       FROM deal_submissions WHERE ltv_requested IS NOT NULL`
    );

    // Approval rate (completed / total)
    const approvalResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') as approved,
         COUNT(*) as total
       FROM deal_submissions WHERE status IN ('completed', 'declined')`
    );

    const totalDeals = statusResult.rows.reduce((sum, r) => sum + parseInt(r.count), 0);

    res.json({
      success: true,
      stats: {
        totalDeals,
        byStatus: statusResult.rows,
        byUserRole: userResult.rows,
        byMonth: monthResult.rows,
        ltv: ltvResult.rows[0],
        approvalRate: approvalResult.rows[0].total > 0
          ? (approvalResult.rows[0].approved / approvalResult.rows[0].total * 100).toFixed(2)
          : 0
      }
    });
  } catch (error) {
    console.error('[admin-stats] Error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: CREATE INTERNAL USER (admin, rm, credit, compliance)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/create', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, password, role } = req.body;
    const userRole = role || 'admin';

    if (!first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!INTERNAL_ROLES.includes(userRole)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, rm, credit, or compliance.' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, email, first_name, last_name, role`,
      [userRole, first_name, last_name, email.toLowerCase(), phone, hashedPassword]
    );

    const newUser = result.rows[0];
    console.log(`[admin-create] New ${userRole} created:`, newUser.id, newUser.email, 'by', req.user.userId);

    res.status(201).json({ success: true, message: `${userRole.toUpperCase()} user created successfully`, user: newUser });
  } catch (error) {
    console.error('[admin-create] Error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET INTERNAL STAFF LIST (for assignment dropdowns)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/staff', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { role } = req.query;
    let query = `SELECT id, first_name, last_name, email, role FROM users WHERE role IN ('admin', 'rm', 'credit', 'compliance')`;
    const params = [];
    if (role) {
      query += ` AND role = $1`;
      params.push(role);
    }
    query += ` ORDER BY first_name`;
    const result = await pool.query(query, params);
    res.json({ success: true, staff: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: BROKER ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════

// Broker: get/create their onboarding record
router.get('/broker/:userId/onboarding', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    let result = await pool.query(`SELECT * FROM broker_onboarding WHERE user_id = $1`, [req.params.userId]);
    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO broker_onboarding (user_id) VALUES ($1) RETURNING *`, [req.params.userId]
      );
    }
    // Get associated documents
    const docs = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at FROM deal_documents
       WHERE deal_id IS NULL AND id IN (
         SELECT unnest(ARRAY[passport_doc_id, proof_of_address_doc_id, incorporation_doc_id])
         FROM broker_onboarding WHERE user_id = $1
       )`, [req.params.userId]
    );
    res.json({ success: true, onboarding: result.rows[0], documents: docs.rows });
  } catch (error) {
    console.error('[broker-onb] Error:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding data' });
  }
});

// Admin: update broker onboarding data
router.put('/broker/:userId/onboarding', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const {
      individual_name, date_of_birth, is_company, company_name, company_number,
      bank_name, bank_sort_code, bank_account_no, bank_account_name, notes
    } = req.body;

    const result = await pool.query(
      `UPDATE broker_onboarding SET
        individual_name = COALESCE($1, individual_name),
        date_of_birth = COALESCE($2, date_of_birth),
        is_company = COALESCE($3, is_company),
        company_name = COALESCE($4, company_name),
        company_number = COALESCE($5, company_number),
        bank_name = COALESCE($6, bank_name),
        bank_sort_code = COALESCE($7, bank_sort_code),
        bank_account_no = COALESCE($8, bank_account_no),
        bank_account_name = COALESCE($9, bank_account_name),
        notes = COALESCE($10, notes),
        status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END,
        updated_at = NOW()
       WHERE user_id = $11 RETURNING *`,
      [individual_name, date_of_birth, is_company, company_name, company_number,
       bank_name, bank_sort_code, bank_account_no, bank_account_name, notes, req.params.userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Onboarding record not found' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    console.error('[broker-onb] Update error:', error);
    res.status(500).json({ error: 'Failed to update onboarding data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: Delegated Authority config (2026-04-20, DA Session 2a)
//  Single-row config at admin_config.id=1.
//  GET returns the current row (seeded by migration).
//  PUT updates thresholds + asset-type allow-list + enabled toggle.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/config/delegated-authority', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM admin_config WHERE id = 1`);
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Admin config row not seeded. Migration may not have run.' });
    }
    res.json({ success: true, config: r.rows[0] });
  } catch (error) {
    console.error('[admin-config] GET error:', error);
    res.status(500).json({ error: 'Failed to load admin config' });
  }
});

router.put('/config/delegated-authority', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { auto_approve_enabled, auto_approve_max_loan, auto_approve_max_ltv_pct, auto_approve_asset_types } = req.body;

    // Validate inputs
    if (auto_approve_enabled != null && typeof auto_approve_enabled !== 'boolean') {
      return res.status(400).json({ error: 'auto_approve_enabled must be boolean' });
    }
    if (auto_approve_max_loan != null) {
      const n = Number(auto_approve_max_loan);
      if (!isFinite(n) || n <= 0) return res.status(400).json({ error: 'auto_approve_max_loan must be > 0' });
      if (n > 100000000) return res.status(400).json({ error: 'auto_approve_max_loan looks too high (> £100m)' });
    }
    if (auto_approve_max_ltv_pct != null) {
      const n = Number(auto_approve_max_ltv_pct);
      if (!isFinite(n) || n <= 0 || n > 100) return res.status(400).json({ error: 'auto_approve_max_ltv_pct must be between 0 and 100' });
    }
    if (auto_approve_asset_types != null) {
      if (!Array.isArray(auto_approve_asset_types)) {
        return res.status(400).json({ error: 'auto_approve_asset_types must be an array' });
      }
      const allowedSet = ['residential', 'mixed-use', 'commercial', 'land-with-planning'];
      const bad = auto_approve_asset_types.filter(t => !allowedSet.includes(String(t).toLowerCase()));
      if (bad.length > 0) return res.status(400).json({ error: `Unknown asset types: ${bad.join(', ')}. Allowed: ${allowedSet.join(', ')}` });
    }

    // Build dynamic SET — only update fields that were explicitly provided
    const sets = [];
    const vals = [];
    let i = 1;
    if (auto_approve_enabled != null) { sets.push(`auto_approve_enabled = $${i++}`); vals.push(auto_approve_enabled); }
    if (auto_approve_max_loan != null) { sets.push(`auto_approve_max_loan = $${i++}`); vals.push(auto_approve_max_loan); }
    if (auto_approve_max_ltv_pct != null) { sets.push(`auto_approve_max_ltv_pct = $${i++}`); vals.push(auto_approve_max_ltv_pct); }
    if (auto_approve_asset_types != null) { sets.push(`auto_approve_asset_types = $${i++}::text[]`); vals.push(auto_approve_asset_types); }
    sets.push(`updated_at = NOW()`);
    sets.push(`updated_by = $${i++}`); vals.push(req.user.userId);

    if (sets.length === 2) {
      // Only updated_at + updated_by would change — no actual config delta
      return res.status(400).json({ error: 'No config fields provided to update' });
    }

    const sql = `UPDATE admin_config SET ${sets.join(', ')} WHERE id = 1 RETURNING *`;
    const r = await pool.query(sql, vals);
    await logAudit(null, 'admin_config_updated', null, 'delegated_authority',
      { fields: Object.keys(req.body), by: req.user.userId }, req.user.userId);
    res.json({ success: true, config: r.rows[0] });
  } catch (error) {
    console.error('[admin-config] PUT error:', error);
    res.status(500).json({ error: 'Failed to update admin config' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: LLM MODEL CONFIG (V5 Credit Analysis — multi-provider)
//  GET  /api/admin/config/llm-config
//  PUT  /api/admin/config/llm-config/:callType
//
//  Controls model + max_tokens / temperature / budget / extra_params for each
//  call type used by the V5 n8n canvas. Multi-provider:
//    - anthropic   : Sonnet 4.6 / Opus 4.6 / Haiku 4.5 (writers + assembler)
//    - perplexity  : Sonar tiers (market evidence, party screening, quick facts)
//    - google      : NotebookLM / Gemini (doc synthesis, audio overview) — DISABLED
//                    until API access verified.
//
//  extra_params shape (provider-specific):
//    perplexity → { search_domain_filter:[...], search_recency_filter, return_citations }
//    google     → { grounding_sources:[...], notebook_id }  (TBD)
//    anthropic  → null
//
//  Editable from /admin/models.html.
// ═══════════════════════════════════════════════════════════════════════════

// Allowlists per provider — extend when a new approved model is added.
const ALLOWED_MODELS_BY_PROVIDER = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
  ],
  perplexity: [
    'sonar',
    'sonar-pro',
    'sonar-reasoning',
    'sonar-reasoning-pro',
    'sonar-deep-research',
  ],
  google: [
    // Empty intentionally until NotebookLM/Gemini API access is verified.
    // Add 'gemini-2.5-pro', 'gemini-2.5-flash', etc. once locked.
    '',
  ],
};

const ALLOWED_PROVIDERS = Object.keys(ALLOWED_MODELS_BY_PROVIDER);

// Flat allowlist (legacy field — keep for backward compat with the existing
// frontend until admin/models.html ships its provider-aware version).
const ALLOWED_LLM_MODELS = Object.values(ALLOWED_MODELS_BY_PROVIDER).flat().filter(Boolean);

router.get('/config/llm-config', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT call_type, provider, model, max_tokens, temperature, budget_gbp, enabled,
             notes, extra_params, cost_per_1m_input_usd, cost_per_1m_output_usd,
             updated_by, updated_at
      FROM llm_model_config
      ORDER BY provider, call_type
    `);

    const byCallType = {};
    for (const r of rows) {
      byCallType[r.call_type] = {
        provider:                r.provider,
        model:                   r.model,
        max_tokens:              r.max_tokens,
        temperature:             parseFloat(r.temperature),
        budget_gbp:              parseFloat(r.budget_gbp),
        enabled:                 r.enabled,
        notes:                   r.notes,
        extra_params:            r.extra_params || null,
        cost_per_1m_input_usd:   r.cost_per_1m_input_usd != null ? parseFloat(r.cost_per_1m_input_usd) : null,
        cost_per_1m_output_usd:  r.cost_per_1m_output_usd != null ? parseFloat(r.cost_per_1m_output_usd) : null,
        updated_by:              r.updated_by,
        updated_at:              r.updated_at,
      };
    }

    res.json({
      ok: true,
      config: byCallType,
      rows,
      allowed_providers: ALLOWED_PROVIDERS,
      allowed_models_by_provider: ALLOWED_MODELS_BY_PROVIDER,
      allowed_models: ALLOWED_LLM_MODELS,  // legacy field, kept for older UI
    });
  } catch (err) {
    console.error('[admin/llm-config GET] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put('/config/llm-config/:callType', authenticateToken, authenticateAdmin, async (req, res) => {
  const { callType } = req.params;
  const {
    provider, model, max_tokens, temperature, budget_gbp,
    enabled, notes, extra_params,
    cost_per_1m_input_usd, cost_per_1m_output_usd,
  } = req.body;

  try {
    // Existence check + load current provider so we can validate model against
    // the right allowlist when provider isn't being changed in this PUT.
    const { rows: existing } = await pool.query(
      'SELECT call_type, provider FROM llm_model_config WHERE call_type = $1',
      [callType]
    );
    if (existing.length === 0) {
      return res.status(404).json({ ok: false, error: `Unknown call_type: ${callType}` });
    }
    const effectiveProvider = (provider !== undefined) ? provider : existing[0].provider;

    if (provider !== undefined && !ALLOWED_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        ok: false,
        error: `Provider "${provider}" not allowed. Allowed: ${ALLOWED_PROVIDERS.join(', ')}`,
      });
    }

    if (model !== undefined) {
      const providerAllowed = ALLOWED_MODELS_BY_PROVIDER[effectiveProvider] || [];
      // Empty string is permitted for `google` while API access is being verified.
      if (!providerAllowed.includes(model)) {
        return res.status(400).json({
          ok: false,
          error: `Model "${model}" not allowed for provider "${effectiveProvider}". Allowed: ${providerAllowed.filter(Boolean).join(', ') || '(none yet)'}`,
        });
      }
    }

    if (max_tokens !== undefined) {
      const n = parseInt(max_tokens, 10);
      if (!Number.isFinite(n) || n < 100 || n > 32000) {
        return res.status(400).json({ ok: false, error: 'max_tokens must be integer 100–32000' });
      }
    }
    if (temperature !== undefined) {
      const t = parseFloat(temperature);
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        return res.status(400).json({ ok: false, error: 'temperature must be 0.00–1.00' });
      }
    }
    if (budget_gbp !== undefined) {
      const b = parseFloat(budget_gbp);
      if (!Number.isFinite(b) || b < 0 || b > 999.99) {
        return res.status(400).json({ ok: false, error: 'budget_gbp must be 0.00–999.99' });
      }
    }
    if (cost_per_1m_input_usd !== undefined && cost_per_1m_input_usd !== null) {
      const c = parseFloat(cost_per_1m_input_usd);
      if (!Number.isFinite(c) || c < 0 || c > 1000) {
        return res.status(400).json({ ok: false, error: 'cost_per_1m_input_usd must be 0–1000 or null' });
      }
    }
    if (cost_per_1m_output_usd !== undefined && cost_per_1m_output_usd !== null) {
      const c = parseFloat(cost_per_1m_output_usd);
      if (!Number.isFinite(c) || c < 0 || c > 1000) {
        return res.status(400).json({ ok: false, error: 'cost_per_1m_output_usd must be 0–1000 or null' });
      }
    }

    // extra_params: validated as JSON-shaped object. Provider-specific shape
    // checks are intentionally light here — n8n is the consumer and will fail
    // loud if a Perplexity row is missing search_domain_filter, etc.
    let extraParamsValue;
    if (extra_params !== undefined) {
      if (extra_params === null) {
        extraParamsValue = null;
      } else if (typeof extra_params === 'object' && !Array.isArray(extra_params)) {
        // Soft check: Perplexity rows should have search_domain_filter as an array
        if (effectiveProvider === 'perplexity') {
          if (!Array.isArray(extra_params.search_domain_filter)) {
            return res.status(400).json({
              ok: false,
              error: 'perplexity extra_params must include search_domain_filter as an array',
            });
          }
        }
        extraParamsValue = JSON.stringify(extra_params);
      } else {
        return res.status(400).json({ ok: false, error: 'extra_params must be an object or null' });
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (provider     !== undefined) { sets.push(`provider = $${i++}`);    vals.push(provider); }
    if (model        !== undefined) { sets.push(`model = $${i++}`);       vals.push(model); }
    if (max_tokens   !== undefined) { sets.push(`max_tokens = $${i++}`);  vals.push(parseInt(max_tokens, 10)); }
    if (temperature  !== undefined) { sets.push(`temperature = $${i++}`); vals.push(parseFloat(temperature)); }
    if (budget_gbp   !== undefined) { sets.push(`budget_gbp = $${i++}`);  vals.push(parseFloat(budget_gbp)); }
    if (enabled      !== undefined) { sets.push(`enabled = $${i++}`);     vals.push(!!enabled); }
    if (notes        !== undefined) { sets.push(`notes = $${i++}`);       vals.push(notes); }
    if (extra_params !== undefined) { sets.push(`extra_params = $${i++}::jsonb`); vals.push(extraParamsValue); }
    if (cost_per_1m_input_usd  !== undefined) { sets.push(`cost_per_1m_input_usd = $${i++}`);  vals.push(cost_per_1m_input_usd  === null ? null : parseFloat(cost_per_1m_input_usd)); }
    if (cost_per_1m_output_usd !== undefined) { sets.push(`cost_per_1m_output_usd = $${i++}`); vals.push(cost_per_1m_output_usd === null ? null : parseFloat(cost_per_1m_output_usd)); }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: 'No editable fields supplied' });
    }

    sets.push(`updated_by = $${i++}`); vals.push(req.user.userId);
    sets.push(`updated_at = NOW()`);

    vals.push(callType);
    const sql = `UPDATE llm_model_config SET ${sets.join(', ')} WHERE call_type = $${i} RETURNING *`;

    const { rows } = await pool.query(sql, vals);
    const row = rows[0];

    await logAudit(null, 'llm_config_updated', null, callType,
      { fields: Object.keys(req.body), by: req.user.userId }, req.user.userId);

    res.json({
      ok: true,
      call_type: row.call_type,
      updated: {
        provider:                row.provider,
        model:                   row.model,
        max_tokens:              row.max_tokens,
        temperature:             parseFloat(row.temperature),
        budget_gbp:              parseFloat(row.budget_gbp),
        enabled:                 row.enabled,
        notes:                   row.notes,
        extra_params:            row.extra_params || null,
        cost_per_1m_input_usd:   row.cost_per_1m_input_usd  != null ? parseFloat(row.cost_per_1m_input_usd)  : null,
        cost_per_1m_output_usd:  row.cost_per_1m_output_usd != null ? parseFloat(row.cost_per_1m_output_usd) : null,
        updated_by:              row.updated_by,
        updated_at:              row.updated_at,
      },
    });
  } catch (err) {
    console.error(`[admin/llm-config PUT ${callType}] error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: LLM PROMPT BODIES (V5 Risk Analysis + future memo/termsheet prompts)
//  GET  /api/admin/config/llm-prompt/:key
//  GET  /api/admin/config/llm-prompt/:key/history
//
//  Backed by llm_prompts table (append-only versioned). Returns the ACTIVE
//  body for a prompt_key, plus version + audit metadata. Read by the V5 n8n
//  canvas at workflow start to load risk_rubric + risk_macro before grading.
//
//  Allowed keys (server-side gate — extend as new prompt types ship):
//   - risk_rubric : 9-dimension risk grading rubric (active v2)
//   - risk_macro  : UK bridging macro context block (active v1 NEUTRAL seed)
//
//  History route is admin-UI-only (don't pipe to n8n). Use for the
//  /admin/prompts page to render version dropdowns + diff older versions.
//
//  No PUT/POST yet — those land with the /admin/prompts UI build (#48).
//  When they do, the rule is: every save = INSERT new row with version+1
//  and is_active=TRUE; deactivate the old active row in the same transaction.
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_PROMPT_KEYS = ['risk_rubric', 'risk_macro'];

router.get('/config/llm-prompt/:key', authenticateToken, authenticateAdmin, async (req, res) => {
  const { key } = req.params;

  if (!ALLOWED_PROMPT_KEYS.includes(key)) {
    return res.status(400).json({
      ok: false,
      error: `Unknown prompt_key '${key}'. Allowed: ${ALLOWED_PROMPT_KEYS.join(', ')}`,
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT id, prompt_key, version, body, description, parent_version,
             changelog, edited_by, edited_at
        FROM llm_prompts
       WHERE prompt_key = $1
         AND is_active = TRUE
       LIMIT 1
      `,
      [key]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `No active version found for prompt_key '${key}'. Seed via migration or upload via /admin/prompts.`,
      });
    }

    const row = rows[0];
    res.json({
      ok: true,
      prompt_key:     row.prompt_key,
      version:        row.version,
      body:           row.body,
      description:    row.description,
      parent_version: row.parent_version,
      changelog:      row.changelog,
      edited_by:      row.edited_by,
      edited_at:      row.edited_at,
      body_length:    row.body.length,
    });
  } catch (err) {
    console.error(`[admin/llm-prompt GET ${key}] error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/config/llm-prompt/:key/history', authenticateToken, authenticateAdmin, async (req, res) => {
  const { key } = req.params;

  if (!ALLOWED_PROMPT_KEYS.includes(key)) {
    return res.status(400).json({
      ok: false,
      error: `Unknown prompt_key '${key}'. Allowed: ${ALLOWED_PROMPT_KEYS.join(', ')}`,
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT id, prompt_key, version, is_active, description, parent_version,
             changelog, edited_by, edited_at, LENGTH(body) AS body_length
        FROM llm_prompts
       WHERE prompt_key = $1
       ORDER BY version DESC
      `,
      [key]
    );

    res.json({
      ok: true,
      prompt_key: key,
      versions:   rows,
      count:      rows.length,
    });
  } catch (err) {
    console.error(`[admin/llm-prompt history ${key}] error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: RISK PACKAGER PREVIEW (V5 Risk MVP step 6 — 2026-04-25)
//  POST /api/admin/risk-packager/preview/:dealId
//
//  Body: { data_stage: 'dip' | 'underwriting' | 'post_completion',
//          sensitivity_calculator_version?: 'v5.1' }
//
//  Returns the exact JSON payload that n8n's Risk Analysis Standalone
//  workflow will receive. DOES NOT call Anthropic, DOES NOT insert a
//  risk_view row. Use to:
//    - eyeball completeness before kicking off a real run
//    - confirm rubric/macro version pin against /admin/prompts
//    - debug "missing field" complaints from the rubric grader
// ═══════════════════════════════════════════════════════════════════════════
router.post('/risk-packager/preview/:dealId', authenticateToken, authenticateAdmin, async (req, res) => {
  const dealId = parseInt(req.params.dealId, 10);
  if (!Number.isInteger(dealId) || dealId <= 0) {
    return res.status(400).json({ ok: false, error: 'dealId path param must be a positive integer' });
  }

  const { data_stage, sensitivity_calculator_version } = req.body || {};

  try {
    const result = await riskPackager.buildRiskPayload(dealId, data_stage, {
      sensitivityCalculatorVersion: sensitivity_calculator_version,
    });

    if (!result.success) {
      // Surface validation / lookup errors as 400 — the route itself worked.
      return res.status(400).json({ ok: false, error: result.error });
    }

    res.json({
      ok: true,
      deal_id: result.payload.deal_id,
      data_stage: result.payload.data_stage,
      rubric: result.payload.rubric,
      macro: result.payload.macro,
      sensitivity_calculator_version: result.payload.sensitivity_calculator_version,
      source_provenance: result.payload.source_provenance,
      feature_hash: result.feature_hash,
      risk_payload_hash: result.risk_payload_hash,
      payload_size_bytes: Buffer.byteLength(JSON.stringify(result.payload), 'utf8'),
      payload: result.payload,
    });
  } catch (err) {
    console.error(`[admin/risk-packager/preview ${dealId}] error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ALPHA PIPE SMOKE TEST
//  GET /api/admin/alpha-ping
//
//  Calls daksfirst-alpha's /health endpoint via services/alpha-client and
//  returns the result to the caller. Use to verify the auth <-> alpha pipe
//  is wired correctly after config / env var changes.
//
//  Does NOT send any deal data. Body-less GET, X-API-Key header only.
//  Admin-only: leaks alpha's internal state (model versions, db status).
// ═══════════════════════════════════════════════════════════════════════════
router.get('/alpha-ping', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const result = await alphaClient.ping();
    // Always return 200 to the browser — the payload carries success/failure.
    // If we returned the alpha status directly, a 503 from alpha (cold start,
    // etc.) would look like a broken admin route. The shape lets the ops UI
    // render "alpha reachable? yes/no" without error handling acrobatics.
    res.json({
      alpha_configured: !!process.env.ALPHA_BASE_URL,
      probed_url: (process.env.ALPHA_BASE_URL || '').replace(/\/$/, '') + '/health',
      checked_at: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    // alphaClient.ping() is fail-soft so this should never fire, but belt +
    // braces: the route itself must not 500 under any circumstance.
    console.error('[admin alpha-ping] unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'alpha-ping route crashed — check server logs',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  M1 — SEND A DEAL TO AN ANALYST ENGINE (admin-only)
//  POST /api/admin/deals/:id/send-to-analyst
//
//  Body: { stage_id: 'dip_submission'|..., engine: 'anthropic'|'alpha' }
//
//  What it does:
//    1. Packages the deal at the given stage (PII-sanitised allowlist).
//    2. Dispatches the features to the chosen engine.
//       - engine=alpha    : POST alpha /api/v1/ingest/deal today; when
//                            alpha's models are live, switch to /score.
//       - engine=anthropic: reserved for M2 — returns 501 today so the
//                            route is safe to call but doesn't pretend.
//    3. Inserts ONE append-only row in deal_stage_analyses with the
//       features_sent, response, cost, latency, trigger, and any error.
//    4. Returns the inserted row so the caller can render immediately.
//
//  Auth never evaluates, scores, or gates here. The engine's output is
//  persisted verbatim and surfaced; decisions are the engine's business.
//  See memory: feedback_auth_is_data_collector_not_decider.md.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/deals/:id/send-to-analyst', authenticateToken, authenticateAdmin, async (req, res) => {
  const startedAt = Date.now();
  const dealId = parseInt(req.params.id, 10);
  const { stage_id: stageId, engine } = req.body || {};

  // Basic validation — fail fast before doing work.
  if (!Number.isInteger(dealId) || dealId <= 0) {
    return res.status(400).json({ success: false, error: 'invalid deal id' });
  }
  if (!stageId || typeof stageId !== 'string') {
    return res.status(400).json({ success: false, error: 'stage_id required' });
  }
  if (!engine || !['anthropic', 'alpha'].includes(engine)) {
    return res.status(400).json({ success: false, error: "engine must be 'anthropic' or 'alpha'" });
  }

  try {
    // 1. Package
    const pkg = await featurePackager.packageDealForStage(dealId, stageId);
    if (!pkg.success) {
      return res.status(404).json({ success: false, error: pkg.error });
    }

    // 2. Dispatch
    let engineResponse = null;
    let engineError = null;
    let engineLatencyMs = null;
    let engineStatus = null;
    let modelVersion = null;
    let engineCostGbp = null;

    if (engine === 'alpha') {
      // Alpha's /ingest/deal Pydantic schema (verified against
      // alpha-scaffold-2026-04-21/app/api/v1/ingest.py:27-34):
      //   { source: str, deal_id: str, features: dict }
      // We stash our richer context (stage_id, feature_hash, submission_id,
      // packaged_at) INSIDE features as `_auth_envelope` so no data is lost
      // but the top-level schema matches what alpha accepts today.
      const alphaBody = {
        source: 'daksfirst-auth',
        deal_id: String(pkg.envelope.submission_id || pkg.envelope.deal_id),
        features: {
          ...pkg.envelope.features,
          _auth_envelope: {
            schema_version: pkg.envelope.schema_version,
            stage_id: pkg.envelope.stage_id,
            feature_hash: pkg.feature_hash,
            packaged_at: pkg.envelope.packaged_at,
            counts: pkg.envelope.counts,
          },
        },
      };
      const r = await alphaClient.alphaFetch(
        'POST',
        alphaClient.PATHS.INGEST_DEAL,
        alphaBody,
        { timeoutMs: 15000 }
      );
      engineLatencyMs = r.latency_ms;
      engineStatus = r.status || null;
      if (r.success) {
        engineResponse = r.data || {};
        modelVersion = (r.data && (r.data.model_version || r.data.pca_version)) || null;
      } else {
        engineError = r.error || 'alpha call failed';
        engineResponse = r.data || { _raw: r.raw || null };
      }
    } else if (engine === 'anthropic') {
      // M2 (2026-04-22): Opus 4.6 reads the full feature envelope and
      // returns a structured credit analysis with citations. The service
      // enforces temperature 0, JSON-only output, and hallucination
      // detection via the citation validator. Any unresolved citation
      // path → row is marked with error='hallucinated_citation:<path>'.
      // See services/anthropic-analyst.js + project_m2_anthropic_analyst_kickoff.md.
      const a = await anthropicAnalyst.analyseDealStage(pkg.envelope, {
        userId: req.user && req.user.userId,
      });
      engineResponse = a.response || {};
      engineError = a.error;
      engineLatencyMs = a.latency_ms;
      engineStatus = a.error ? null : 200;
      modelVersion = a.model_version;
      engineCostGbp = a.cost_gbp;
    }

    // 3. Persist
    const inserted = await pool.query(
      `INSERT INTO deal_stage_analyses
        (deal_id, stage_id, engine, model_version, feature_hash,
         features_sent, response, cost_gbp, latency_ms, triggered_by, error)
       VALUES
        ($1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8, $9, $10, $11)
       RETURNING id, deal_id, stage_id, engine, model_version, feature_hash,
                 cost_gbp, latency_ms, triggered_by, triggered_at, error`,
      [
        dealId,
        stageId,
        engine,
        modelVersion,
        pkg.feature_hash,
        JSON.stringify(pkg.envelope.features),
        JSON.stringify(engineResponse || {}),
        engineCostGbp,                                          // cost_gbp — Anthropic-metered in M2; alpha calls still null
        engineLatencyMs,
        `user:${req.user && req.user.userId ? req.user.userId : 'unknown'}`,
        engineError,
      ]
    );

    await logAudit(
      dealId,
      'analyst_dispatch',
      null,
      `engine=${engine} stage=${stageId}`,
      {
        analysis_id: inserted.rows[0].id,
        feature_hash: pkg.feature_hash,
        engine_status: engineStatus,
        engine_error: engineError,
      },
      req.user && req.user.userId
    );

    return res.json({
      success: !engineError,
      analysis: inserted.rows[0],
      feature_counts: pkg.envelope.counts,
      engine_status: engineStatus,
      engine_error: engineError,
      total_latency_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[admin send-to-analyst] unexpected error:', error);
    return res.status(500).json({
      success: false,
      error: 'send-to-analyst crashed — check server logs',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  M1 — LIST ANALYSES FOR A DEAL (admin-only)
//  GET /api/admin/deals/:id/analyses
//
//  Returns every (stage, engine) analysis ever recorded for this deal,
//  newest first. Small convenience endpoint so the M3 matrix UI can read
//  the ledger without every consumer writing the same query.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/deals/:id/analyses', authenticateToken, authenticateAdmin, async (req, res) => {
  const dealId = parseInt(req.params.id, 10);
  if (!Number.isInteger(dealId) || dealId <= 0) {
    return res.status(400).json({ success: false, error: 'invalid deal id' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, deal_id, stage_id, engine, model_version, feature_hash,
              response, cost_gbp, latency_ms, triggered_by, triggered_at,
              rm_feedback, error
         FROM deal_stage_analyses
        WHERE deal_id = $1
        ORDER BY triggered_at DESC, id DESC`,
      [dealId]
    );
    res.json({ success: true, analyses: rows });
  } catch (error) {
    console.error('[admin list-analyses] error:', error);
    res.status(500).json({ success: false, error: 'failed to list analyses' });
  }
});

module.exports = router;
