const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateInternal } = require('../middleware/auth');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');

// Helper: check if user owns the deal or is internal staff
async function canEditDeal(req, submissionId) {
  const isInternal = config.INTERNAL_ROLES.includes(req.user.role);
  if (isInternal) return true;
  const result = await pool.query(
    `SELECT 1 FROM deal_submissions WHERE submission_id = $1 AND user_id = $2 LIMIT 1`,
    [submissionId, req.user.userId]
  );
  return result.rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CREATE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers', authenticateToken, async (req, res) => {
  try {
    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number } = req.body;
    if (!full_name) return res.status(400).json({ error: 'Full name is required' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `INSERT INTO deal_borrowers (deal_id, role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [dealResult.rows[0].id, role || 'primary', full_name, date_of_birth || null, nationality || null,
       jurisdiction || null, email || null, phone || null, address || null, borrower_type || 'individual',
       company_name || null, company_number || null]
    );

    await logAudit(dealResult.rows[0].id, 'borrower_added', null, full_name,
      { role: role || 'primary', borrower_type: borrower_type || 'individual' }, req.user.userId);

    res.status(201).json({ success: true, borrower: result.rows[0] });
  } catch (error) {
    console.error('[borrower] Error:', error);
    res.status(500).json({ error: 'Failed to add borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET BORROWERS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/borrowers', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, created_at`,
      [dealResult.rows[0].id]
    );
    res.json({ success: true, borrowers: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch borrowers' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/borrowers/:borrowerId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to edit this borrower' });
    }

    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number, kyc_status, kyc_data } = req.body;

    const result = await pool.query(
      `UPDATE deal_borrowers SET
        role = COALESCE($1, role), full_name = COALESCE($2, full_name),
        date_of_birth = COALESCE($3, date_of_birth), nationality = COALESCE($4, nationality),
        jurisdiction = COALESCE($5, jurisdiction), email = COALESCE($6, email),
        phone = COALESCE($7, phone), address = COALESCE($8, address),
        borrower_type = COALESCE($9, borrower_type), company_name = COALESCE($10, company_name),
        company_number = COALESCE($11, company_number), kyc_status = COALESCE($12, kyc_status),
        kyc_data = COALESCE($13, kyc_data), updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address,
       borrower_type, company_name, company_number, kyc_status, kyc_data ? JSON.stringify(kyc_data) : null,
       req.params.borrowerId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });
    res.json({ success: true, borrower: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE BORROWER
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId/borrowers/:borrowerId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to remove this borrower' });
    }

    const result = await pool.query(`DELETE FROM deal_borrowers WHERE id = $1 RETURNING full_name`, [req.params.borrowerId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });
    res.json({ success: true, message: `Borrower ${result.rows[0].full_name} removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CH ROLE VERIFICATION — RM confirms each borrower's role after CH check
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/borrowers/verify-roles', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { verifications } = req.body;
    // verifications = [{ borrower_id, confirmed_role, ch_matched_role, ch_match_confidence, ch_match_data }]
    if (!verifications || !Array.isArray(verifications) || verifications.length === 0) {
      return res.status(400).json({ error: 'No verifications provided' });
    }

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const results = [];
    for (const v of verifications) {
      const result = await pool.query(
        `UPDATE deal_borrowers SET
          role = COALESCE($1, role),
          ch_matched_role = $2,
          ch_match_confidence = $3,
          ch_verified_by = $4,
          ch_verified_at = NOW(),
          ch_match_data = COALESCE($5, '{}'::jsonb),
          updated_at = NOW()
         WHERE id = $6 AND deal_id = $7 RETURNING id, full_name, role, ch_matched_role, ch_match_confidence`,
        [
          v.confirmed_role || null,
          v.ch_matched_role || null,
          v.ch_match_confidence || 'manual',
          req.user.userId,
          v.ch_match_data ? JSON.stringify(v.ch_match_data) : null,
          v.borrower_id,
          dealId
        ]
      );
      if (result.rows.length > 0) results.push(result.rows[0]);
    }

    await logAudit(dealId, 'ch_roles_verified', null, `${results.length} borrower roles verified`,
      { verifications: results.map(r => ({ id: r.id, name: r.full_name, role: r.role, ch_role: r.ch_matched_role })) },
      req.user.userId);

    res.json({ success: true, verified: results, count: results.length });
  } catch (error) {
    console.error('[borrower/verify-roles] Error:', error);
    res.status(500).json({ error: 'Failed to verify borrower roles' });
  }
});

module.exports = router;
