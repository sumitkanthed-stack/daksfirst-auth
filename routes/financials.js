const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { normalizeMoney, normalizeString } = require('../services/matrix-normalizer');

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

// Valid categories
const VALID_CATEGORIES = ['asset', 'liability', 'income', 'expense'];
const VALID_FREQUENCIES = ['one_off', 'monthly', 'quarterly', 'annual'];

// ═══════════════════════════════════════════════════════════════════════════
//  GET FINANCIALS (by category or all)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:submissionId/financials', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const { category } = req.query;
    let query = `SELECT * FROM deal_financials WHERE deal_id = $1`;
    const params = [dealResult.rows[0].id];

    if (category && VALID_CATEGORIES.includes(category)) {
      query += ` AND category = $2`;
      params.push(category);
    }
    query += ` ORDER BY category, created_at`;

    const result = await pool.query(query, params);
    res.json({ success: true, financials: result.rows });
  } catch (error) {
    console.error('[financials] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch financial records' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CREATE FINANCIAL LINE ITEM
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:submissionId/financials', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to edit this deal' });
    }

    // 2026-04-30 — normalize at the boundary: amount → number, free-text → trimmed strings
    const { category, frequency, supporting_doc_id, source } = req.body;
    const description = normalizeString(req.body.description);
    const amount = normalizeMoney(req.body.amount);
    const holder = normalizeString(req.body.holder);
    const reference = normalizeString(req.body.reference);
    const notes = normalizeString(req.body.notes);

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Valid category required (asset, liability, income, expense)' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `INSERT INTO deal_financials (deal_id, category, description, amount, frequency, holder, reference, notes, supporting_doc_id, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [dealResult.rows[0].id, category, description.trim(),
       amount ? parseFloat(amount) : null,
       (frequency && VALID_FREQUENCIES.includes(frequency)) ? frequency : 'one_off',
       holder || null, reference || null, notes || null,
       supporting_doc_id || null, source || 'manual', req.user.userId]
    );

    await logAudit(dealResult.rows[0].id, 'financial_added', null, description,
      { category, amount, frequency }, req.user.userId);

    res.status(201).json({ success: true, financial: result.rows[0] });
  } catch (error) {
    console.error('[financials] POST error:', error);
    res.status(500).json({ error: 'Failed to add financial record' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE FINANCIAL LINE ITEM
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:submissionId/financials/:financialId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to edit this deal' });
    }

    // 2026-04-30 — normalize at the boundary
    const { frequency, supporting_doc_id } = req.body;
    const description = normalizeString(req.body.description);
    const amount = normalizeMoney(req.body.amount);
    const holder = normalizeString(req.body.holder);
    const reference = normalizeString(req.body.reference);
    const notes = normalizeString(req.body.notes);

    const result = await pool.query(
      `UPDATE deal_financials SET
        description = COALESCE($1, description),
        amount = COALESCE($2, amount),
        frequency = COALESCE($3, frequency),
        holder = COALESCE($4, holder),
        reference = COALESCE($5, reference),
        notes = COALESCE($6, notes),
        supporting_doc_id = COALESCE($7, supporting_doc_id),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [description || null, amount ? parseFloat(amount) : null,
       (frequency && VALID_FREQUENCIES.includes(frequency)) ? frequency : null,
       holder || null, reference || null, notes || null,
       supporting_doc_id || null, parseInt(req.params.financialId)]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Financial record not found' });

    res.json({ success: true, financial: result.rows[0] });
  } catch (error) {
    console.error('[financials] PUT error:', error);
    res.status(500).json({ error: 'Failed to update financial record' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DELETE FINANCIAL LINE ITEM
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:submissionId/financials/:financialId', authenticateToken, async (req, res) => {
  try {
    if (!(await canEditDeal(req, req.params.submissionId))) {
      return res.status(403).json({ error: 'You do not have permission to delete this record' });
    }

    const result = await pool.query(
      `DELETE FROM deal_financials WHERE id = $1 RETURNING id, category, description`,
      [parseInt(req.params.financialId)]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Financial record not found' });

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('[financials] DELETE error:', error);
    res.status(500).json({ error: 'Failed to delete financial record' });
  }
});

module.exports = router;
