const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateAdmin, authenticateInternal } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];

// ═══════════════════════════════════════════════════════════════════════════
//  BROKER ONBOARDING: GET
// ═══════════════════════════════════════════════════════════════════════════
router.get('/broker/onboarding', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'broker') return res.status(403).json({ error: 'Broker access only' });
    let result = await pool.query(`SELECT * FROM broker_onboarding WHERE user_id = $1`, [req.user.userId]);
    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO broker_onboarding (user_id) VALUES ($1) RETURNING *`, [req.user.userId]
      );
    }
    // Get associated documents
    const docs = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at FROM deal_documents
       WHERE deal_id IS NULL AND id IN (
         SELECT unnest(ARRAY[passport_doc_id, proof_of_address_doc_id, incorporation_doc_id])
         FROM broker_onboarding WHERE user_id = $1
       )`, [req.user.userId]
    );
    res.json({ success: true, onboarding: result.rows[0], documents: docs.rows });
  } catch (error) {
    console.error('[broker-onb] Error:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BROKER CLIENTS (CRM)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/broker/clients', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'broker') return res.status(403).json({ error: 'Broker access only' });

    // Get unique borrowers across all this broker's deals
    // Sources: deal_borrowers table (structured) + deal_submissions fields (fallback)
    const result = await pool.query(`
      WITH borrower_deals AS (
        -- From deal_borrowers table (preferred, has structured data)
        SELECT
          b.full_name,
          b.email,
          b.phone,
          b.company_name,
          b.borrower_type,
          b.kyc_status,
          ds.id as deal_id,
          ds.submission_id,
          ds.loan_amount,
          ds.deal_stage,
          ds.security_address,
          ds.updated_at
        FROM deal_borrowers b
        JOIN deal_submissions ds ON b.deal_id = ds.id
        WHERE ds.user_id = $1 AND b.role = 'primary'

        UNION ALL

        -- Fallback: deals with no deal_borrowers entry
        SELECT
          ds.borrower_name as full_name,
          ds.borrower_email as email,
          ds.borrower_phone as phone,
          ds.borrower_company as company_name,
          'individual' as borrower_type,
          'pending' as kyc_status,
          ds.id as deal_id,
          ds.submission_id,
          ds.loan_amount,
          ds.deal_stage,
          ds.security_address,
          ds.updated_at
        FROM deal_submissions ds
        WHERE ds.user_id = $1
          AND ds.borrower_name IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM deal_borrowers b2
            WHERE b2.deal_id = ds.id AND b2.role = 'primary'
          )
      ),
      client_agg AS (
        SELECT
          COALESCE(NULLIF(TRIM(full_name), ''), 'Unknown') as client_name,
          MAX(email) as email,
          MAX(phone) as phone,
          MAX(company_name) as company_name,
          MAX(borrower_type) as borrower_type,
          MAX(kyc_status) as kyc_status,
          COUNT(DISTINCT deal_id) as deal_count,
          SUM(loan_amount) as total_loan_value,
          MAX(updated_at) as last_activity,
          json_agg(json_build_object(
            'deal_id', deal_id,
            'submission_id', submission_id,
            'loan_amount', loan_amount,
            'deal_stage', deal_stage,
            'security_address', security_address,
            'updated_at', updated_at
          ) ORDER BY updated_at DESC) as deals
        FROM borrower_deals
        WHERE full_name IS NOT NULL AND TRIM(full_name) != ''
        GROUP BY LOWER(TRIM(full_name))
      )
      SELECT * FROM client_agg ORDER BY last_activity DESC
    `, [req.user.userId]);

    // Get document counts per deal for these clients
    const dealIds = result.rows.flatMap(c =>
      (c.deals || []).map(d => d.deal_id)
    ).filter(Boolean);

    let docCounts = {};
    if (dealIds.length > 0) {
      const docResult = await pool.query(
        `SELECT deal_id, COUNT(*) as doc_count
         FROM deal_documents
         WHERE deal_id = ANY($1)
         GROUP BY deal_id`,
        [dealIds]
      );
      docResult.rows.forEach(r => { docCounts[r.deal_id] = parseInt(r.doc_count); });
    }

    // Attach doc counts to each client
    const clients = result.rows.map(c => ({
      ...c,
      total_documents: (c.deals || []).reduce((sum, d) => sum + (docCounts[d.deal_id] || 0), 0)
    }));

    res.json({ success: true, clients });
  } catch (error) {
    console.error('[broker-clients] Error:', error);
    res.status(500).json({ error: 'Failed to fetch broker clients' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BROKER ONBOARDING: UPDATE
// ═══════════════════════════════════════════════════════════════════════════
router.put('/broker/onboarding', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'broker') return res.status(403).json({ error: 'Broker access only' });
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
       bank_name, bank_sort_code, bank_account_no, bank_account_name, notes, req.user.userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Onboarding record not found' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    console.error('[broker-onb] Update error:', error);
    res.status(500).json({ error: 'Failed to update onboarding data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET STAFF DEALS (assigned to rm, credit, compliance)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/staff/deals', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;

    let whereClause = '';
    if (role === 'rm') whereClause = `WHERE ds.assigned_rm = $1`;
    else if (role === 'credit') whereClause = `WHERE ds.assigned_credit = $1`;
    else if (role === 'compliance') whereClause = `WHERE ds.assigned_compliance = $1`;
    else if (role === 'admin') whereClause = `WHERE 1=1`; // admin sees all

    const result = await pool.query(
      `SELECT ds.id, ds.submission_id, ds.status, ds.deal_stage, ds.borrower_name, ds.broker_name,
              ds.loan_amount, ds.security_address, ds.asset_type, ds.created_at, ds.updated_at,
              ds.assigned_rm, ds.assigned_credit, ds.assigned_compliance,
              ds.dip_fee_confirmed, ds.commitment_fee_received,
              ds.rm_recommendation, ds.credit_recommendation, ds.compliance_recommendation, ds.final_decision,
              rm.first_name as rm_first, rm.last_name as rm_last,
              cr.first_name as credit_first, cr.last_name as credit_last,
              co.first_name as comp_first, co.last_name as comp_last
       FROM deal_submissions ds
       LEFT JOIN users rm ON ds.assigned_rm = rm.id
       LEFT JOIN users cr ON ds.assigned_credit = cr.id
       LEFT JOIN users co ON ds.assigned_compliance = co.id
       ${whereClause}
       ORDER BY ds.updated_at DESC`,
      role === 'admin' ? [] : [userId]
    );

    res.json({ success: true, deals: result.rows });
  } catch (error) {
    console.error('[staff-deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: UPDATE BROKER ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════
router.put('/admin/broker/:userId/onboarding', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!['approved', 'rejected', 'under_review'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const result = await pool.query(
      `UPDATE broker_onboarding SET status = $1, notes = COALESCE($2, notes),
       reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE user_id = $4 RETURNING *`,
      [status, notes, req.user.userId, req.params.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Broker onboarding not found' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update broker onboarding' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET BROKER ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/broker/:userId/onboarding', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM broker_onboarding WHERE user_id = $1`, [req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No onboarding record' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch broker onboarding' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LAW FIRMS: LIST
// ═══════════════════════════════════════════════════════════════════════════
router.get('/law-firms', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM law_firms WHERE is_active = TRUE ORDER BY firm_name`);
    res.json({ success: true, law_firms: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch law firms' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LAW FIRMS: CREATE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/law-firms', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { firm_name, contact_name, email, phone, address, notes } = req.body;
    if (!firm_name) return res.status(400).json({ error: 'Firm name is required' });

    const result = await pool.query(
      `INSERT INTO law_firms (firm_name, contact_name, email, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [firm_name, contact_name || null, email || null, phone || null, address || null, notes || null]
    );
    res.status(201).json({ success: true, law_firm: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create law firm' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LAW FIRMS: UPDATE
// ═══════════════════════════════════════════════════════════════════════════
router.put('/law-firms/:id', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { firm_name, contact_name, email, phone, address, notes, is_active } = req.body;

    const result = await pool.query(
      `UPDATE law_firms SET
        firm_name = COALESCE($1, firm_name),
        contact_name = COALESCE($2, contact_name),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        notes = COALESCE($6, notes),
        is_active = COALESCE($7, is_active),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [firm_name || null, contact_name || null, email || null, phone || null, address || null, notes || null,
       is_active !== undefined ? is_active : null, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Law firm not found' });
    res.json({ success: true, law_firm: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update law firm' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LAW FIRMS: DELETE (deactivate)
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/law-firms/:id', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE law_firms SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING firm_name`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Law firm not found' });
    res.json({ success: true, message: `Law firm ${result.rows[0].firm_name} deactivated` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to deactivate law firm' });
  }
});

module.exports = router;
