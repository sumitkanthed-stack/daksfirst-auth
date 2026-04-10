const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken, authenticateInternal } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER: Get internal deal ID from submission_id
// ═══════════════════════════════════════════════════════════════════════════
async function getDealIdFromSubmissionId(submissionId) {
  const result = await pool.query(
    'SELECT id FROM deal_submissions WHERE submission_id = $1',
    [submissionId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].id;
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. GET /:dealId/matrix-summary
//  Returns the full matrix state for a deal
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:dealId/matrix-summary', authenticateToken, async (req, res) => {
  try {
    const { dealId } = req.params;
    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const [fieldStatusResult, infoRequestsResult, docsIssuedResult, docRepoResult, dealResult] = await Promise.all([
      pool.query(
        'SELECT section, field_key, stage, status, updated_by, updated_at FROM deal_field_status WHERE deal_id = $1 ORDER BY section, field_key, stage',
        [internalDealId]
      ),
      pool.query(
        'SELECT id, section, message, requested_by, requested_role, status, resolved_by, resolved_at, created_at FROM deal_info_requests WHERE deal_id = $1 ORDER BY created_at DESC',
        [internalDealId]
      ),
      pool.query(
        'SELECT id, doc_type, stage, reference, issued_at, issued_by, sent_to, signing_method, signed_at, signed_status, validity_days, file_url, signed_file_url, envelope_id, notes, created_at FROM deal_documents_issued WHERE deal_id = $1 ORDER BY stage, created_at',
        [internalDealId]
      ),
      pool.query(
        'SELECT id, filename, file_type, file_size, category, section, status, uploaded_by, verified_by, verified_at, source_doc_id, auto_parsed, parse_confidence, notes, created_at FROM deal_document_repo WHERE deal_id = $1 ORDER BY created_at DESC',
        [internalDealId]
      ),
      pool.query(
        'SELECT deal_stage, matrix_data, borrower_financials, aml_data FROM deal_submissions WHERE id = $1',
        [internalDealId]
      )
    ]);

    const deal = dealResult.rows[0];
    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Group field_status by section
    const fieldStatusBySection = {};
    for (const row of fieldStatusResult.rows) {
      if (!fieldStatusBySection[row.section]) {
        fieldStatusBySection[row.section] = [];
      }
      fieldStatusBySection[row.section].push({
        field_key: row.field_key,
        stage: row.stage,
        status: row.status,
        updated_by: row.updated_by,
        updated_at: row.updated_at
      });
    }

    res.json({
      field_status: fieldStatusBySection,
      info_requests: infoRequestsResult.rows,
      documents_issued: docsIssuedResult.rows,
      document_repo: docRepoResult.rows,
      deal_stage: deal.deal_stage,
      matrix_data: deal.matrix_data || {},
      borrower_financials: deal.borrower_financials || {},
      aml_data: deal.aml_data || {}
    });
  } catch (err) {
    console.error('[matrix] Get summary error:', err);
    res.status(500).json({ error: 'Failed to load matrix summary' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. PUT /:dealId/field-status
//  Update a field's status at a stage
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:dealId/field-status', authenticateInternal, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { section, field_key, stage, status } = req.body;

    if (!section || !field_key || !stage || !status) {
      return res.status(400).json({ error: 'Missing required fields: section, field_key, stage, status' });
    }

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // UPSERT: insert or update
    const result = await pool.query(
      `INSERT INTO deal_field_status (deal_id, section, field_key, stage, status, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (deal_id, field_key, stage) DO UPDATE SET
         status = EXCLUDED.status,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, section, field_key, stage, status, updated_by, updated_at`,
      [internalDealId, section, field_key, stage, status, req.user.userId]
    );

    const updated = result.rows[0];

    await logAudit(internalDealId, 'field_status_updated', null, status, {
      section, field_key, stage, status
    }, req.user.userId);

    res.json(updated);
  } catch (err) {
    console.error('[matrix] Field status update error:', err);
    res.status(500).json({ error: 'Failed to update field status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. POST /:dealId/info-request
//  Create an information request
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:dealId/info-request', authenticateInternal, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { section, message } = req.body;

    if (!section || !message) {
      return res.status(400).json({ error: 'Missing required fields: section, message' });
    }

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `INSERT INTO deal_info_requests (deal_id, section, message, requested_by, requested_role, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW())
       RETURNING id, deal_id, section, message, requested_by, requested_role, status, resolved_by, resolved_at, created_at`,
      [internalDealId, section, message, req.user.userId, req.user.role]
    );

    const created = result.rows[0];

    await logAudit(internalDealId, 'info_request_created', null, 'open', {
      section, message
    }, req.user.userId);

    res.status(201).json(created);
  } catch (err) {
    console.error('[matrix] Info request create error:', err);
    res.status(500).json({ error: 'Failed to create information request' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. PUT /:dealId/info-request/:requestId/resolve
//  Mark an info request as done
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:dealId/info-request/:requestId/resolve', authenticateInternal, async (req, res) => {
  try {
    const { dealId, requestId } = req.params;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `UPDATE deal_info_requests SET status = 'done', resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 AND deal_id = $3
       RETURNING id, deal_id, section, message, requested_by, requested_role, status, resolved_by, resolved_at, created_at`,
      [req.user.userId, requestId, internalDealId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Information request not found' });
    }

    const updated = result.rows[0];

    await logAudit(internalDealId, 'info_request_resolved', 'open', 'done', {
      request_id: requestId
    }, req.user.userId);

    res.json(updated);
  } catch (err) {
    console.error('[matrix] Info request resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve information request' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. GET /:dealId/info-requests
//  List all info requests for a deal
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:dealId/info-requests', authenticateToken, async (req, res) => {
  try {
    const { dealId } = req.params;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `SELECT id, deal_id, section, message, requested_by, requested_role, status, resolved_by, resolved_at, created_at
       FROM deal_info_requests WHERE deal_id = $1 ORDER BY created_at DESC`,
      [internalDealId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[matrix] List info requests error:', err);
    res.status(500).json({ error: 'Failed to load information requests' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. PUT /:dealId/matrix-data
//  Save matrix JSONB data (borrower financials, AML, etc)
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:dealId/matrix-data', authenticateInternal, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { matrix_data, borrower_financials, aml_data } = req.body;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Build update query dynamically
    const updates = [];
    const values = [internalDealId];
    let paramIndex = 2;

    if (matrix_data !== undefined) {
      updates.push(`matrix_data = $${paramIndex}`);
      values.push(JSON.stringify(matrix_data));
      paramIndex++;
    }
    if (borrower_financials !== undefined) {
      updates.push(`borrower_financials = $${paramIndex}`);
      values.push(JSON.stringify(borrower_financials));
      paramIndex++;
    }
    if (aml_data !== undefined) {
      updates.push(`aml_data = $${paramIndex}`);
      values.push(JSON.stringify(aml_data));
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No data to update' });
    }

    const sql = `UPDATE deal_submissions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING id`;
    await pool.query(sql, values);

    await logAudit(internalDealId, 'matrix_data_updated', null, null, {
      matrix_data: matrix_data !== undefined,
      borrower_financials: borrower_financials !== undefined,
      aml_data: aml_data !== undefined
    }, req.user.userId);

    res.json({ success: true, message: 'Matrix data updated' });
  } catch (err) {
    console.error('[matrix] Matrix data update error:', err);
    res.status(500).json({ error: 'Failed to update matrix data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  7. GET /:dealId/document-repo
//  List all documents in the repository
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:dealId/document-repo', authenticateToken, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { category } = req.query;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    let sql = 'SELECT id, deal_id, filename, file_type, file_size, category, section, status, uploaded_by, verified_by, verified_at, source_doc_id, auto_parsed, parse_confidence, notes, created_at FROM deal_document_repo WHERE deal_id = $1';
    const values = [internalDealId];

    if (category) {
      sql += ' AND category = $2';
      values.push(category);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await pool.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    console.error('[matrix] List document repo error:', err);
    res.status(500).json({ error: 'Failed to load document repository' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  8. POST /:dealId/document-repo
//  Add a document to the repository
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:dealId/document-repo', authenticateInternal, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { filename, file_type, file_size, category, section, status, notes } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Missing required field: filename' });
    }

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `INSERT INTO deal_document_repo (deal_id, filename, file_type, file_size, category, section, status, uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, deal_id, filename, file_type, file_size, category, section, status, uploaded_by, verified_by, verified_at, source_doc_id, auto_parsed, parse_confidence, notes, created_at`,
      [internalDealId, filename, file_type || null, file_size || null, category || null, section || null, status || 'uploaded', req.user.userId]
    );

    const created = result.rows[0];

    await logAudit(internalDealId, 'document_added_to_repo', null, 'uploaded', {
      filename, file_type, category, section
    }, req.user.userId);

    res.status(201).json(created);
  } catch (err) {
    console.error('[matrix] Add document repo error:', err);
    res.status(500).json({ error: 'Failed to add document to repository' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  9. PUT /:dealId/document-repo/:docId/verify
//  Mark a document as verified
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:dealId/document-repo/:docId/verify', authenticateInternal, async (req, res) => {
  try {
    const { dealId, docId } = req.params;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `UPDATE deal_document_repo SET status = 'verified', verified_by = $1, verified_at = NOW()
       WHERE id = $2 AND deal_id = $3
       RETURNING id, deal_id, filename, file_type, file_size, category, section, status, uploaded_by, verified_by, verified_at, source_doc_id, auto_parsed, parse_confidence, notes, created_at`,
      [req.user.userId, docId, internalDealId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updated = result.rows[0];

    await logAudit(internalDealId, 'document_verified', 'uploaded', 'verified', {
      doc_id: docId, filename: updated.filename
    }, req.user.userId);

    res.json(updated);
  } catch (err) {
    console.error('[matrix] Verify document error:', err);
    res.status(500).json({ error: 'Failed to verify document' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  10. GET /:dealId/documents-issued
//  List all issued documents
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:dealId/documents-issued', authenticateToken, async (req, res) => {
  try {
    const { dealId } = req.params;

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `SELECT id, deal_id, doc_type, stage, reference, issued_at, issued_by, sent_to, signing_method, signed_at, signed_status, validity_days, file_url, signed_file_url, envelope_id, notes, created_at
       FROM deal_documents_issued WHERE deal_id = $1 ORDER BY stage, created_at`,
      [internalDealId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[matrix] List documents issued error:', err);
    res.status(500).json({ error: 'Failed to load issued documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  11. POST /:dealId/documents-issued
//  Record a new issued document
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:dealId/documents-issued', authenticateInternal, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { doc_type, stage, reference, signing_method, sent_to, validity_days, file_url, notes } = req.body;

    if (!doc_type || !stage) {
      return res.status(400).json({ error: 'Missing required fields: doc_type, stage' });
    }

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `INSERT INTO deal_documents_issued (deal_id, doc_type, stage, reference, issued_at, issued_by, sent_to, signing_method, validity_days, file_url, notes, created_at)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, NOW())
       RETURNING id, deal_id, doc_type, stage, reference, issued_at, issued_by, sent_to, signing_method, signed_at, signed_status, validity_days, file_url, signed_file_url, envelope_id, notes, created_at`,
      [internalDealId, doc_type, stage, reference || null, req.user.userId, sent_to || null, signing_method || null, validity_days || null, file_url || null, notes || null]
    );

    const created = result.rows[0];

    await logAudit(internalDealId, 'document_issued', null, 'not_issued', {
      doc_type, stage, reference, signing_method
    }, req.user.userId);

    res.status(201).json(created);
  } catch (err) {
    console.error('[matrix] Issue document error:', err);
    res.status(500).json({ error: 'Failed to record issued document' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  12. PUT /:dealId/documents-issued/:docIssuedId/status
//  Update signing status of an issued document
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:dealId/documents-issued/:docIssuedId/status', authenticateInternal, async (req, res) => {
  try {
    const { dealId, docIssuedId } = req.params;
    const { signed_status, signed_file_url, envelope_id } = req.body;

    if (!signed_status) {
      return res.status(400).json({ error: 'Missing required field: signed_status' });
    }

    const internalDealId = await getDealIdFromSubmissionId(dealId);
    if (!internalDealId) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // If status is 'signed', also set signed_at = NOW()
    let sql = `UPDATE deal_documents_issued SET signed_status = $1`;
    const values = [signed_status, internalDealId, docIssuedId];
    let paramIndex = 3;

    if (signed_file_url) {
      sql += `, signed_file_url = $${paramIndex + 1}`;
      values.splice(3, 0, signed_file_url);
      paramIndex++;
    }
    if (envelope_id) {
      sql += `, envelope_id = $${paramIndex + 1}`;
      values.splice(paramIndex, 0, envelope_id);
      paramIndex++;
    }
    if (signed_status === 'signed') {
      sql += `, signed_at = NOW()`;
    }

    sql += ` WHERE deal_id = $2 AND id = $3 RETURNING id, deal_id, doc_type, stage, reference, issued_at, issued_by, sent_to, signing_method, signed_at, signed_status, validity_days, file_url, signed_file_url, envelope_id, notes, created_at`;

    const result = await pool.query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updated = result.rows[0];

    await logAudit(internalDealId, 'document_status_updated', null, signed_status, {
      doc_issued_id: docIssuedId, signed_status
    }, req.user.userId);

    res.json(updated);
  } catch (err) {
    console.error('[matrix] Update document status error:', err);
    res.status(500).json({ error: 'Failed to update document status' });
  }
});

module.exports = router;
