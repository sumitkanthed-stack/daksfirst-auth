const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const pool = require('../db/pool');
const { authenticateToken, authenticateAdmin, authenticateInternal } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET ALL DEALS (with pagination & filtering)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/deals', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, asset_type, broker, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `SELECT ds.id, ds.submission_id, ds.status, ds.deal_stage,
                        ds.borrower_name, ds.borrower_company, ds.borrower_type,
                        ds.broker_name, ds.broker_company,
                        ds.loan_amount, ds.current_value, ds.purchase_price, ds.ltv_requested,
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
                        u.first_name as submitter_first, u.last_name as submitter_last
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
        portfolio_summary: portfolioSummary
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

module.exports = router;
