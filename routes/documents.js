const express = require('express');
const multer = require('multer');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { authenticateInternal } = require('../middleware/auth');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { logAudit } = require('../services/audit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10
  }
});

// LIST DOCUMENTS FOR A DEAL
router.get('/deals/:dealId/documents', authenticateToken, async (req, res) => {
  try {
    // Verify ownership
    const dealResult = await pool.query(
      'SELECT id FROM deal_submissions WHERE id = $1 AND user_id = $2',
      [req.params.dealId, req.user.userId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.dealId]
    );

    res.json({ success: true, documents: result.rows });
  } catch (error) {
    console.error('[docs-list] Error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// UPLOAD DOCUMENTS FOR A DEAL (User)
router.post('/deals/:dealId/upload', authenticateToken, upload.any(), async (req, res) => {
  try {
    console.log('[upload] File upload to deal:', req.params.dealId, 'files:', req.files?.length || 0);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Verify deal ownership
    const dealResult = await pool.query(
      `SELECT id, submission_id FROM deal_submissions WHERE id = $1 AND user_id = $2`,
      [req.params.dealId, req.user.userId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found or access denied' });
    }

    const deal = dealResult.rows[0];
    const dealRef = deal.submission_id.substring(0, 8);

    // Get OneDrive token
    let token;
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[upload] Could not get OneDrive token:', err.message);
      return res.status(503).json({
        error: 'OneDrive service unavailable. Files may not be uploaded to cloud storage.'
      });
    }

    const uploadedDocs = [];
    const uploadErrors = [];

    for (const file of req.files) {
      try {
        const oneDriveInfo = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);

        // Store reference in DB with file content
        const docResult = await pool.query(
          `INSERT INTO deal_documents
           (deal_id, filename, file_type, file_size, file_content, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, filename, file_size, uploaded_at`,
          [
            req.params.dealId,
            file.originalname,
            file.mimetype,
            file.size,
            file.buffer,
            oneDriveInfo.itemId,
            oneDriveInfo.path,
            oneDriveInfo.downloadUrl
          ]
        );

        uploadedDocs.push(docResult.rows[0]);
        console.log('[upload] File uploaded:', file.originalname);
      } catch (err) {
        console.error('[upload] Failed to upload', file.originalname, ':', err.message);
        uploadErrors.push({ filename: file.originalname, error: err.message });
      }
    }

    if (uploadedDocs.length === 0) {
      return res.status(400).json({
        error: 'Failed to upload any files',
        details: uploadErrors
      });
    }

    res.json({
      success: true,
      message: `${uploadedDocs.length} file(s) uploaded successfully`,
      documents: uploadedDocs,
      errors: uploadErrors.length > 0 ? uploadErrors : undefined
    });
  } catch (error) {
    console.error('[upload] Error:', error);
    res.status(500).json({ error: 'File upload failed. Please try again.' });
  }
});

// UPLOAD DOCUMENTS FOR A DEAL (Admin/Internal)
router.post('/admin/deals/:dealId/upload', authenticateToken, authenticateInternal, upload.any(), async (req, res) => {
  try {
    console.log('[admin-upload] File upload to deal:', req.params.dealId, 'files:', req.files?.length || 0);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Verify deal exists
    const dealResult = await pool.query(
      `SELECT id, submission_id FROM deal_submissions WHERE id = $1`,
      [req.params.dealId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealRef = deal.submission_id.substring(0, 8);

    // Get OneDrive token
    let token;
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[admin-upload] Could not get OneDrive token:', err.message);
      return res.status(503).json({
        error: 'OneDrive service unavailable. Files may not be uploaded to cloud storage.'
      });
    }

    const uploadedDocs = [];
    const uploadErrors = [];

    for (const file of req.files) {
      try {
        const oneDriveInfo = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);

        const docResult = await pool.query(
          `INSERT INTO deal_documents
           (deal_id, filename, file_type, file_size, file_content, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, filename, file_size, uploaded_at`,
          [
            req.params.dealId,
            file.originalname,
            file.mimetype,
            file.size,
            file.buffer,
            oneDriveInfo.itemId,
            oneDriveInfo.path,
            oneDriveInfo.downloadUrl
          ]
        );

        uploadedDocs.push(docResult.rows[0]);
        await logAudit(req.params.dealId, 'document_uploaded', null, file.originalname,
          { uploaded_by: req.user.userId, file_type: file.mimetype }, req.user.userId);

        console.log('[admin-upload] File uploaded:', file.originalname);
      } catch (err) {
        console.error('[admin-upload] Failed to upload', file.originalname, ':', err.message);
        uploadErrors.push({ filename: file.originalname, error: err.message });
      }
    }

    if (uploadedDocs.length === 0) {
      return res.status(400).json({
        error: 'Failed to upload any files',
        details: uploadErrors
      });
    }

    res.json({
      success: true,
      message: `${uploadedDocs.length} file(s) uploaded successfully`,
      documents: uploadedDocs,
      errors: uploadErrors.length > 0 ? uploadErrors : undefined
    });
  } catch (error) {
    console.error('[admin-upload] Error:', error);
    res.status(500).json({ error: 'File upload failed. Please try again.' });
  }
});

// DOWNLOAD DOCUMENT (accessible by deal owner OR internal staff)
router.get('/deals/:submissionId/documents/:docId/download', authenticateToken, async (req, res) => {
  try {
    const { submissionId, docId } = req.params;
    const config = require('../config');
    const isInternal = config.INTERNAL_ROLES.includes(req.user.role);

    // Verify deal access: owner or internal staff
    let dealResult;
    if (isInternal) {
      dealResult = await pool.query(
        `SELECT id FROM deal_submissions WHERE submission_id = $1`,
        [submissionId]
      );
    } else {
      dealResult = await pool.query(
        `SELECT id FROM deal_submissions WHERE submission_id = $1 AND (user_id = $2 OR borrower_user_id = $2)`,
        [submissionId, req.user.userId]
      );
    }

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const dealId = dealResult.rows[0].id;

    // Get document
    const docResult = await pool.query(
      `SELECT id, filename, file_type, file_content FROM deal_documents WHERE id = $1 AND deal_id = $2`,
      [docId, dealId]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    if (!doc.file_content) {
      return res.status(400).json({ error: 'Document content not available' });
    }

    res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.file_content);
  } catch (error) {
    console.error('[doc-download] Error:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CONFIRM / RECLASSIFY DOCUMENT CATEGORY (RM / Admin only)
// ═══════════════════════════════════════════════════════════════
const VALID_DOC_CATEGORIES = ['kyc', 'financial', 'property', 'legal', 'issued', 'email', 'other'];
const CONFIRM_ROLES = ['rm', 'admin'];

// One-time migration: add confirmation columns if they don't exist
(async () => {
  try {
    await pool.query(`
      ALTER TABLE deal_documents
        ADD COLUMN IF NOT EXISTS category_confirmed_by INTEGER,
        ADD COLUMN IF NOT EXISTS category_confirmed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS category_confirmed_name TEXT
    `);
    console.log('[docs] category confirmation columns ensured');
  } catch (e) {
    console.warn('[docs] Could not add confirmation columns (may already exist):', e.message);
  }
})();

router.put('/deals/:submissionId/documents/:docId/confirm-category', authenticateToken, async (req, res) => {
  try {
    const { submissionId, docId } = req.params;
    const { doc_category } = req.body;

    // Role check — only RM and admin can confirm
    if (!CONFIRM_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only RM or Admin can confirm document categories' });
    }

    // Validate category
    if (!doc_category || !VALID_DOC_CATEGORIES.includes(doc_category.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid category. Must be one of: ' + VALID_DOC_CATEGORIES.join(', ') });
    }

    // Verify deal exists
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );
    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    const dealId = dealResult.rows[0].id;

    // Verify document belongs to this deal
    const docResult = await pool.query(
      `SELECT id, doc_category FROM deal_documents WHERE id = $1 AND deal_id = $2`,
      [docId, dealId]
    );
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const oldCategory = docResult.rows[0].doc_category;
    const confirmerName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email;

    // Update category + set confirmation fields
    await pool.query(
      `UPDATE deal_documents
       SET doc_category = $1,
           category_confirmed_by = $2,
           category_confirmed_at = NOW(),
           category_confirmed_name = $3
       WHERE id = $4`,
      [doc_category.toLowerCase(), req.user.userId, confirmerName, docId]
    );

    // Audit log
    await logAudit(dealId, 'document_category_confirmed', oldCategory, doc_category.toLowerCase(), {
      doc_id: docId,
      confirmed_by: req.user.userId,
      confirmer_name: confirmerName
    }, req.user.userId);

    console.log(`[docs] Category confirmed: doc ${docId} → ${doc_category} by ${confirmerName}`);

    res.json({
      success: true,
      doc_id: parseInt(docId),
      doc_category: doc_category.toLowerCase(),
      category_confirmed_by: req.user.userId,
      category_confirmed_name: confirmerName,
      category_confirmed_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[docs] Confirm category error:', error);
    res.status(500).json({ error: 'Failed to confirm document category' });
  }
});

module.exports = router;
