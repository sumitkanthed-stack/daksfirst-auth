const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { categoriseWithAI } = require('../services/ai-categorise');
const { extractDealFieldsFromDocument, extractDealFieldsFromMultipleDocs } = require('../services/ai-extract');
const config = require('../config');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 }
});

const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];
const N8N_PARSE_WEBHOOK_URL = config.N8N_PARSE_WEBHOOK_URL || '';

// ═══════════════════════════════════════════════════════════════════════════
//  UPLOAD FILES FOR AI PARSING (new deal or existing deal)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/upload', authenticateToken, upload.any(), async (req, res) => {
  try {
    console.log('[smart-parse] Upload from user:', req.user.userId, 'files:', req.files?.length || 0);
    const { deal_id, whatsapp_text } = req.body; // deal_id is optional (if updating existing deal)

    if ((!req.files || req.files.length === 0) && !whatsapp_text) {
      return res.status(400).json({ error: 'No files or text provided' });
    }

    // If deal_id provided, verify access
    let existingDeal = null;
    if (deal_id) {
      const dealCheck = await pool.query(
        `SELECT id, submission_id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
        [deal_id]
      );
      if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const d = dealCheck.rows[0];
      // Check access: owner, borrower, or internal staff
      const isOwner = d.user_id === req.user.userId || d.borrower_user_id === req.user.userId;
      const isInternal = INTERNAL_ROLES.includes(req.user.role);
      if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });
      existingDeal = d;
    }

    // Create a parse session to track the request
    const parseSessionId = crypto.randomUUID();

    // Upload files to OneDrive under a /Parsing/ folder
    let token;
    const uploadedFiles = [];
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[smart-parse] OneDrive token failed:', err.message);
      // Continue without OneDrive - we'll send file buffers directly to n8n
    }

    // Truncate MIME types that exceed DB column width (Office formats can be 73+ chars)
    const safeMime = (mime) => (mime || 'application/octet-stream').substring(0, 255);

    const fileMetadata = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileMeta = {
          filename: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          // Base64 encode file content for n8n webhook
          content_base64: file.buffer.toString('base64')
        };
        fileMetadata.push(fileMeta);

        // Also upload to OneDrive if token available
        if (token) {
          try {
            const dealRef = existingDeal ? existingDeal.submission_id.substring(0, 8) : parseSessionId.substring(0, 8);
            const info = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);
            uploadedFiles.push({
              filename: file.originalname,
              file_type: file.mimetype,
              file_size: file.size,
              onedrive_item_id: info.itemId,
              onedrive_path: info.path,
              onedrive_download_url: info.downloadUrl
            });
          } catch (err) {
            console.error('[smart-parse] OneDrive upload failed for:', file.originalname);
          }
        }
      }
    }

    // Save file records to deal_documents with AI-suggested categories
    const savedDocs = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const matchingUpload = uploadedFiles.find(u => u.filename === file.originalname);

        // AI-categorise the document (fast Haiku call)
        let suggestedCategory = null;
        try {
          suggestedCategory = await categoriseWithAI(file);
          // Map ai-categorise keys to our simpler category set
          const categoryMap = { kyc: 'kyc', financials_aml: 'financial', valuation: 'property', use_of_funds: 'financial', exit_evidence: 'legal', other_conditions: 'other', general: 'other' };
          suggestedCategory = categoryMap[suggestedCategory] || suggestedCategory || 'other';
          console.log(`[smart-parse] AI categorised "${file.originalname}" → ${suggestedCategory}`);
        } catch (catErr) {
          console.warn(`[smart-parse] AI categorisation failed for ${file.originalname}:`, catErr.message);
          suggestedCategory = 'other';
        }

        // Save file with suggested category
        try {
          const docResult = await pool.query(
            `INSERT INTO deal_documents (deal_id, parse_session_id, filename, file_type, file_size, file_content, doc_category, onedrive_item_id, onedrive_path, onedrive_download_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, filename, doc_category`,
            [
              existingDeal ? existingDeal.id : null,
              parseSessionId,
              file.originalname,
              safeMime(file.mimetype),
              file.size,
              file.buffer, // Stored as BYTEA
              suggestedCategory,
              matchingUpload ? matchingUpload.onedrive_item_id : null,
              matchingUpload ? matchingUpload.onedrive_path : null,
              matchingUpload ? matchingUpload.onedrive_download_url : null
            ]
          );
          savedDocs.push(docResult.rows[0]);
        } catch (err) {
          if (err.message.includes('file_content') || err.message.includes('doc_category')) {
            // Columns may not exist yet, try minimal insert
            const docResult = await pool.query(
              `INSERT INTO deal_documents (deal_id, parse_session_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id, filename`,
              [
                existingDeal ? existingDeal.id : null,
                parseSessionId,
                file.originalname,
                safeMime(file.mimetype),
                file.size,
                matchingUpload ? matchingUpload.onedrive_item_id : null,
                matchingUpload ? matchingUpload.onedrive_path : null,
                matchingUpload ? matchingUpload.onedrive_download_url : null
              ]
            );
            savedDocs.push({ ...docResult.rows[0], doc_category: suggestedCategory });
          } else {
            console.error(`[smart-parse] DB insert failed for "${file.originalname}":`, err.message);
            // Continue with remaining files — don't kill the whole upload
          }
        }
      }
      console.log(`[smart-parse] Saved ${savedDocs.length}/${req.files.length} file records with AI categories (parse_session_id: ${parseSessionId})`);
    }

    // Send to n8n parse webhook for AI extraction
    let parsedData = null;
    if (N8N_PARSE_WEBHOOK_URL) {
      try {
        console.log('[smart-parse] Sending to n8n for AI parsing...');
        const payload = {
          parse_session_id: parseSessionId,
          user_id: req.user.userId,
          user_email: req.user.email,
          user_role: req.user.role,
          deal_id: existingDeal ? existingDeal.submission_id : null,
          whatsapp_text: whatsapp_text || null,
          files: fileMetadata.map(f => ({
            filename: f.filename,
            mimetype: f.mimetype,
            size: f.size,
            content_base64: f.content_base64
          })),
          timestamp: new Date().toISOString()
        };

        const parseResp = await fetch(N8N_PARSE_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': config.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000) // 2 min timeout for AI parsing
        });

        if (parseResp.ok) {
          const n8nResult = await parseResp.json();
          console.log('[smart-parse] AI parsing returned:', JSON.stringify(n8nResult).substring(0, 500));
          // n8n returns { parse_session_id, parsed_data, error, file_count, file_names }
          // We need just the parsed_data object
          parsedData = n8nResult.parsed_data || n8nResult || null;
          if (n8nResult.error) {
            console.error('[smart-parse] AI extraction error:', n8nResult.error);
          }
        } else {
          const errText = await parseResp.text();
          console.error('[smart-parse] n8n returned error:', parseResp.status, errText.substring(0, 200));
        }
      } catch (err) {
        console.error('[smart-parse] n8n webhook failed:', err.message);
      }
    } else {
      console.log('[smart-parse] N8N_PARSE_WEBHOOK_URL not configured — broker will confirm categories first, then parse');
    }

    // Return the result — includes AI categories for each file
    // Parsing happens AFTER broker confirms categories (via /parse-confirmed endpoint)
    res.json({
      success: true,
      parse_session_id: parseSessionId,
      files_uploaded: uploadedFiles.length,
      files_received: (req.files || []).length,
      has_whatsapp_text: !!whatsapp_text,
      existing_deal: existingDeal ? existingDeal.submission_id : null,
      documents: savedDocs, // [{id, filename, doc_category}] — AI-suggested categories
      parsed_data: parsedData || null, // The AI-extracted structured data (if n8n responded)
      message: savedDocs.length > 0
        ? 'Files uploaded and categorised. Please confirm document categories, then parse to extract deal data.'
        : (parsedData ? 'Text parsed successfully.' : 'Upload complete.')
    });
  } catch (error) {
    console.error('[smart-parse] Error:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARSE SESSION — Run AI extraction on uploaded files BEFORE deal exists
//  Called after broker confirms document categories
// ═══════════════════════════════════════════════════════════════════════════
router.post('/parse-session', authenticateToken, async (req, res) => {
  try {
    const { parse_session_id } = req.body;
    if (!parse_session_id) return res.status(400).json({ error: 'parse_session_id is required' });

    // Fetch all documents for this parse session
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, file_content, doc_category
       FROM deal_documents WHERE parse_session_id = $1 ORDER BY id`,
      [parse_session_id]
    );

    const docs = docsResult.rows;
    if (docs.length === 0) return res.status(404).json({ error: 'No documents found for this session' });

    const docsWithContent = docs.filter(d => d.file_content && d.file_content.length > 0);
    console.log(`[parse-session] Session ${parse_session_id}: ${docsWithContent.length}/${docs.length} docs have content`);

    let parsedData = null;

    // Try direct Claude API extraction
    if (docsWithContent.length > 0) {
      try {
        const { merged, perDoc, conflicts } = await extractDealFieldsFromMultipleDocs(docsWithContent);
        parsedData = merged;

        // Store per-document parsed data
        for (const [docId, docParsed] of perDoc) {
          try {
            const issueDate = docParsed['doc_issue_date'] || docParsed['doc-issue-date'] || null;
            const expiryDate = docParsed['doc_expiry_date'] || docParsed['doc-expiry-date'] || null;
            await pool.query(
              `UPDATE deal_documents
               SET parsed_data = $1, parsed_at = NOW(),
                   doc_issue_date = COALESCE($2::DATE, doc_issue_date),
                   doc_expiry_date = COALESCE($3::DATE, doc_expiry_date)
               WHERE id = $4`,
              [JSON.stringify(docParsed), issueDate, expiryDate, docId]
            );
          } catch (pdErr) {
            console.warn(`[parse-session] Could not store parsed_data for doc ${docId}:`, pdErr.message);
          }
        }

        if (parsedData) {
          const fieldCount = Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length;
          console.log(`[parse-session] Claude extracted ${fieldCount} merged fields from ${docsWithContent.length} docs`);
        }
      } catch (extractErr) {
        console.error('[parse-session] Direct Claude extraction failed:', extractErr.message);
      }
    }

    // Mark all documents as parsed
    try {
      await pool.query(
        `UPDATE deal_documents SET parsed_at = COALESCE(parsed_at, NOW()) WHERE parse_session_id = $1`,
        [parse_session_id]
      );
    } catch (markErr) {
      console.warn('[parse-session] Could not mark parsed_at:', markErr.message);
    }

    res.json({
      success: true,
      total_documents: docs.length,
      parsed_data: parsedData || null,
      message: parsedData
        ? `Parsed ${docs.length} documents. ${Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length} fields extracted. Review below.`
        : `Could not extract data from documents (may be images/scans needing OCR).`
    });
  } catch (error) {
    console.error('[parse-session] Error:', error);
    res.status(500).json({ error: 'Failed to parse session documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DOCUMENT CATEGORY — Broker confirms/changes a document's category
// ═══════════════════════════════════════════════════════════════════════════
router.put('/document/:docId/category', authenticateToken, async (req, res) => {
  try {
    const { docId } = req.params;
    const { doc_category } = req.body;
    if (!doc_category) return res.status(400).json({ error: 'doc_category is required' });

    const result = await pool.query(
      `UPDATE deal_documents
       SET doc_category = $1, category_confirmed_at = NOW()
       WHERE id = $2
       RETURNING id, filename, doc_category, category_confirmed_at`,
      [doc_category, docId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

    console.log(`[smart-parse] Doc ${docId} category confirmed: ${doc_category}`);
    res.json({ success: true, document: result.rows[0] });
  } catch (error) {
    console.error('[smart-parse] Category update error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARSE CONFIRMED — Run AI extraction AFTER categories are confirmed
//  Tries n8n first, falls back to direct Claude API extraction
// ═══════════════════════════════════════════════════════════════════════════
router.post('/parse-confirmed', authenticateToken, async (req, res) => {
  try {
    const { deal_id } = req.body;
    if (!deal_id) return res.status(400).json({ error: 'deal_id is required' });

    // Verify deal access
    const dealCheck = await pool.query(
      `SELECT id, submission_id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
      [deal_id]
    );
    if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealCheck.rows[0];
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    const isInternal = INTERNAL_ROLES.includes(req.user.role);
    if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

    // Fetch all deal documents with their confirmed categories
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, file_content, doc_category, category_confirmed_at
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at`,
      [deal.id]
    );

    const docs = docsResult.rows;
    if (docs.length === 0) return res.status(400).json({ error: 'No documents found for this deal' });

    const confirmed = docs.filter(d => d.category_confirmed_at);
    const unconfirmed = docs.filter(d => !d.category_confirmed_at);

    console.log(`[parse-confirmed] Deal ${deal_id}: ${confirmed.length} confirmed, ${unconfirmed.length} unconfirmed of ${docs.length} total`);

    // ── DIAGNOSTIC: Check file_content status for each document ──
    for (const doc of docs) {
      const hasContent = doc.file_content && doc.file_content.length > 0;
      const contentType = doc.file_content ? `Buffer(${doc.file_content.length})` : 'NULL';
      console.log(`[parse-confirmed] Doc ${doc.id} "${doc.filename}" — type: ${doc.file_type}, size: ${doc.file_size}, content: ${contentType}, category: ${doc.doc_category}`);
    }
    console.log(`[parse-confirmed] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}, N8N_PARSE_WEBHOOK_URL set: ${!!N8N_PARSE_WEBHOOK_URL}`);

    let parsedData = null;

    // ── Strategy 1: Try n8n webhook ──
    if (N8N_PARSE_WEBHOOK_URL) {
      try {
        console.log('[parse-confirmed] Sending to n8n with confirmed categories...');
        const fileMetadata = [];
        for (const doc of docs) {
          if (doc.file_content) {
            fileMetadata.push({
              filename: doc.filename, mimetype: doc.file_type, size: doc.file_size,
              doc_category: doc.doc_category || 'other',
              category_confirmed: !!doc.category_confirmed_at,
              content_base64: doc.file_content.toString('base64')
            });
          }
        }
        const categorySummary = docs.map(d => `- ${d.filename}: ${(d.doc_category || 'other').toUpperCase()}${d.category_confirmed_at ? ' (confirmed)' : ' (suggested)'}`).join('\n');

        const payload = {
          parse_session_id: crypto.randomUUID(),
          user_id: req.user.userId, user_email: req.user.email, user_role: req.user.role,
          deal_id: deal.submission_id, category_context: categorySummary,
          files: fileMetadata, timestamp: new Date().toISOString()
        };

        const parseResp = await fetch(N8N_PARSE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': config.WEBHOOK_SECRET || 'daksfirst_webhook_2026' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000)
        });

        if (parseResp.ok) {
          const n8nResult = await parseResp.json();
          console.log('[parse-confirmed] n8n returned:', JSON.stringify(n8nResult).substring(0, 500));
          parsedData = n8nResult.parsed_data || n8nResult || null;
        } else {
          console.error('[parse-confirmed] n8n error:', parseResp.status);
        }
      } catch (err) {
        console.error('[parse-confirmed] n8n webhook failed:', err.message);
      }
    }

    // ── Strategy 2: Direct Claude API extraction (fallback) ──
    let extractionConflicts = {};
    if (!parsedData) {
      console.log(`[parse-confirmed] Using direct Claude API extraction as fallback for ${docs.length} docs...`);
      console.log(`[parse-confirmed] Docs with file_content: ${docs.filter(d => d.file_content && d.file_content.length > 0).length}/${docs.length}`);
      try {
        const { merged, perDoc, conflicts } = await extractDealFieldsFromMultipleDocs(docs);
        console.log(`[parse-confirmed] Extraction result: merged=${merged ? Object.keys(merged).length + ' fields' : 'null'}, perDoc=${perDoc.size} docs with data, conflicts=${Object.keys(conflicts || {}).length}`);
        parsedData = merged;
        extractionConflicts = conflicts || {};

        // Store per-document parsed data in DB (including extracted dates)
        for (const [docId, docParsed] of perDoc) {
          try {
            // Extract document dates from parsed data (check both deal-level and section-level field names)
            const issueDate = docParsed['doc_issue_date'] || docParsed['doc-issue-date'] || null;
            const expiryDate = docParsed['doc_expiry_date'] || docParsed['doc-expiry-date'] || null;
            await pool.query(
              `UPDATE deal_documents
               SET parsed_data = $1, parsed_at = NOW(),
                   doc_issue_date = COALESCE($2::DATE, doc_issue_date),
                   doc_expiry_date = COALESCE($3::DATE, doc_expiry_date)
               WHERE id = $4`,
              [JSON.stringify(docParsed), issueDate, expiryDate, docId]
            );
            if (issueDate || expiryDate) {
              console.log(`[parse-confirmed] Doc ${docId}: issue=${issueDate || 'N/A'}, expiry=${expiryDate || 'N/A'}`);
            }
          } catch (pdErr) {
            console.warn(`[parse-confirmed] Could not store parsed_data for doc ${docId}:`, pdErr.message);
          }
        }

        if (parsedData) {
          console.log(`[parse-confirmed] Claude extracted ${Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length} merged fields`);
        }
      } catch (extractErr) {
        console.error('[parse-confirmed] Direct extraction failed:', extractErr.message);
      }
    }

    // Mark ALL documents as parsed (parsed_at) even if extraction returned limited data
    try {
      await pool.query(
        `UPDATE deal_documents SET parsed_at = COALESCE(parsed_at, NOW()) WHERE deal_id = $1`,
        [deal.id]
      );
      console.log(`[parse-confirmed] Marked documents as parsed`);
    } catch (markErr) {
      console.warn('[parse-confirmed] Could not mark parsed_at:', markErr.message);
    }

    await logAudit(deal.id, 'parse_confirmed_triggered', null, 'parse_with_categories',
      { total_docs: docs.length, confirmed_docs: confirmed.length, unconfirmed_docs: unconfirmed.length,
        extraction_method: N8N_PARSE_WEBHOOK_URL ? 'n8n' : 'claude_direct' }, req.user.userId);

    const conflictCount = Object.keys(extractionConflicts || {}).length;
    res.json({
      success: true,
      total_documents: docs.length,
      confirmed_documents: confirmed.length,
      unconfirmed_documents: unconfirmed.length,
      parsed_data: parsedData || null,
      conflicts: extractionConflicts || {},
      core_fields: require('../services/ai-extract').CORE_STRUCTURE_FIELDS,
      message: parsedData
        ? `Parsed ${docs.length} documents. ${Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length} fields extracted.${conflictCount > 0 ? ` ⚠ ${conflictCount} conflicting fields need your review.` : ' Review below.'}`
        : `Documents marked as parsed but no text could be extracted (images/scans may need OCR).`
    });
  } catch (error) {
    console.error('[parse-confirmed] Error:', error);
    res.status(500).json({ error: 'Failed to parse documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PARSE SINGLE DOCUMENT — extract fields from one document
// ═══════════════════════════════════════════════════════════════════════════
router.post('/parse-document/:docId', authenticateToken, async (req, res) => {
  try {
    const { docId } = req.params;

    // Get the document with its deal
    const docResult = await pool.query(
      `SELECT dd.id, dd.deal_id, dd.filename, dd.file_type, dd.file_size, dd.file_content, dd.doc_category, dd.parsed_data,
              ds.submission_id, ds.user_id, ds.borrower_user_id
       FROM deal_documents dd
       JOIN deal_submissions ds ON ds.id = dd.deal_id
       WHERE dd.id = $1`,
      [docId]
    );

    if (docResult.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const doc = docResult.rows[0];

    // Check access
    const isOwner = doc.user_id === req.user.userId || doc.borrower_user_id === req.user.userId;
    const isInternal = INTERNAL_ROLES.includes(req.user.role);
    if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

    // If already parsed and we have stored data, return it
    if (doc.parsed_data && Object.keys(doc.parsed_data).length > 0) {
      console.log(`[parse-document] Returning cached parsed_data for doc ${docId}`);
      return res.json({
        success: true,
        doc_id: parseInt(docId),
        filename: doc.filename,
        parsed_data: doc.parsed_data,
        cached: true,
        message: `Showing previously extracted data for "${doc.filename}".`
      });
    }

    // Extract using direct Claude API
    if (!doc.file_content) {
      return res.status(400).json({ error: 'Document content not available for parsing' });
    }

    console.log(`[parse-document] Extracting fields from "${doc.filename}" (${doc.file_type})...`);
    const parsedData = await extractDealFieldsFromDocument(
      doc.file_content, doc.file_type, doc.filename, doc.doc_category
    );

    // Store result, mark as parsed, and persist extracted dates
    try {
      const issueDate = parsedData ? (parsedData['doc_issue_date'] || parsedData['doc-issue-date'] || null) : null;
      const expiryDate = parsedData ? (parsedData['doc_expiry_date'] || parsedData['doc-expiry-date'] || null) : null;
      await pool.query(
        `UPDATE deal_documents
         SET parsed_data = $1, parsed_at = NOW(),
             doc_issue_date = COALESCE($2::DATE, doc_issue_date),
             doc_expiry_date = COALESCE($3::DATE, doc_expiry_date)
         WHERE id = $4`,
        [parsedData ? JSON.stringify(parsedData) : null, issueDate, expiryDate, docId]
      );
      if (issueDate || expiryDate) {
        console.log(`[parse-document] Doc ${docId}: issue=${issueDate || 'N/A'}, expiry=${expiryDate || 'N/A'}`);
      }
    } catch (storeErr) {
      console.warn(`[parse-document] Could not store parsed_data:`, storeErr.message);
    }

    await logAudit(doc.deal_id, 'document_parsed', null, doc.filename,
      { doc_id: docId, fields_extracted: parsedData ? Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length : 0 },
      req.user.userId);

    res.json({
      success: true,
      doc_id: parseInt(docId),
      filename: doc.filename,
      parsed_data: parsedData || {},
      cached: false,
      message: parsedData
        ? `Extracted ${Object.keys(parsedData).filter(k => parsedData[k] != null && k !== 'confidence').length} fields from "${doc.filename}".`
        : `Could not extract text from "${doc.filename}" (may be an image/scan needing OCR).`
    });
  } catch (error) {
    console.error('[parse-document] Error:', error);
    res.status(500).json({ error: 'Failed to parse document' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CALLBACK FROM n8n AFTER ASYNC PARSING
// ═══════════════════════════════════════════════════════════════════════════
router.post('/callback', async (req, res) => {
  try {
    const { parse_session_id, parsed_data, error } = req.body;
    if (!parse_session_id) return res.status(400).json({ error: 'parse_session_id is required' });

    if (error) {
      console.error('[smart-parse-callback] Parse error for session:', parse_session_id, error);
      return res.json({ success: false, error });
    }

    console.log('[smart-parse-callback] Received parsed data for session:', parse_session_id);
    // Store in a temporary table or cache — for now, log it
    // The frontend polls or the n8n response was synchronous
    res.json({ success: true, message: 'Parsed data received' });
  } catch (error) {
    console.error('[smart-parse-callback] Error:', error);
    res.status(500).json({ error: 'Failed to process callback' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM PARSED DATA & CREATE/UPDATE DEAL
// ═══════════════════════════════════════════════════════════════════════════
router.post('/confirm', authenticateToken, async (req, res) => {
  try {
    const { parsed_data, deal_id, parse_session_id } = req.body;
    if (!parsed_data) return res.status(400).json({ error: 'Parsed data is required' });

    // Sanitise parsed data — convert string numbers, truncate long strings
    const pd = { ...parsed_data };
    const numericFields = ['current_value', 'purchase_price', 'loan_amount', 'ltv_requested', 'rate_requested', 'term_months', 'refurb_cost'];
    for (const f of numericFields) {
      if (pd[f] !== null && pd[f] !== undefined) {
        const num = parseFloat(String(pd[f]).replace(/[£$,]/g, ''));
        pd[f] = isNaN(num) ? null : num;
      }
    }
    // Remove confidence field (not a DB column)
    delete pd.confidence;

    // ── Auto-detect corporate borrower ──────────────────────────────
    // If borrower_company or company_name is present, force borrower_type to 'corporate'
    // and sync company_name ↔ borrower_company so both fields are populated
    const hasCompany = pd.borrower_company || pd.company_name;
    if (hasCompany) {
      if (pd.borrower_type === 'individual' || !pd.borrower_type) {
        pd.borrower_type = 'corporate';
        console.log(`[smart-parse] Auto-corrected borrower_type to corporate (company: ${hasCompany})`);
      }
      // Sync: if one is set but not the other, copy across
      if (pd.borrower_company && !pd.company_name) pd.company_name = pd.borrower_company;
      if (pd.company_name && !pd.borrower_company) pd.borrower_company = pd.company_name;
    }

    // Auto-calculate indicative loan amount and LTV if not provided
    // Rule: Max 75% LTV (of current value) or 90% LTC (of purchase price), whichever is LOWER
    const currentVal = pd.current_value ? Number(pd.current_value) : null;
    const purchasePrice = pd.purchase_price ? Number(pd.purchase_price) : null;
    const refurbCost = pd.refurb_cost ? Number(pd.refurb_cost) : 0;

    if (!pd.loan_amount && (currentVal || purchasePrice)) {
      const maxByLtv = currentVal ? currentVal * 0.75 : Infinity;  // 75% of value
      const totalCost = purchasePrice ? purchasePrice + refurbCost : Infinity;
      const maxByLtc = totalCost < Infinity ? totalCost * 0.90 : Infinity; // 90% of total cost
      const indicativeLoan = Math.min(maxByLtv, maxByLtc);
      if (indicativeLoan < Infinity) {
        pd.loan_amount = Math.round(indicativeLoan); // Round to nearest pound
        console.log(`[smart-parse] Auto-calculated indicative loan: £${pd.loan_amount} (75% LTV = £${maxByLtv < Infinity ? Math.round(maxByLtv) : 'N/A'}, 90% LTC = £${maxByLtc < Infinity ? Math.round(maxByLtc) : 'N/A'})`);
      }
    }

    if (!pd.ltv_requested && pd.loan_amount && currentVal && currentVal > 0) {
      pd.ltv_requested = Math.round((Number(pd.loan_amount) / currentVal) * 100 * 100) / 100; // 2 decimal places
      console.log(`[smart-parse] Auto-calculated LTV: ${pd.ltv_requested}%`);
    }

    if (deal_id) {
      // UPDATE existing deal with parsed fields
      const dealCheck = await pool.query(
        `SELECT id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
        [deal_id]
      );
      if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const deal = dealCheck.rows[0];
      const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
      const isInternal = INTERNAL_ROLES.includes(req.user.role);
      if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

      // Update deal with parsed fields (only non-null values)
      const fields = [];
      const values = [];
      let paramIdx = 1;

      const fieldMap = {
        borrower_name: pd.borrower_name, borrower_company: pd.borrower_company,
        borrower_email: pd.borrower_email, borrower_phone: pd.borrower_phone,
        broker_name: pd.broker_name, broker_company: pd.broker_company, broker_fca: pd.broker_fca,
        security_address: pd.security_address, security_postcode: pd.security_postcode,
        asset_type: pd.asset_type, current_value: pd.current_value,
        loan_amount: pd.loan_amount, ltv_requested: pd.ltv_requested,
        loan_purpose: pd.loan_purpose, exit_strategy: pd.exit_strategy,
        term_months: pd.term_months, rate_requested: pd.rate_requested,
        additional_notes: pd.additional_notes,
        borrower_nationality: pd.borrower_nationality, borrower_type: pd.borrower_type,
        company_name: pd.company_name, company_number: pd.company_number,
        interest_servicing: pd.interest_servicing, existing_charges: pd.existing_charges,
        property_tenure: pd.property_tenure, occupancy_status: pd.occupancy_status,
        current_use: pd.current_use, purchase_price: pd.purchase_price,
        use_of_funds: pd.use_of_funds, refurb_scope: pd.refurb_scope,
        refurb_cost: pd.refurb_cost, deposit_source: pd.deposit_source
      };

      for (const [col, val] of Object.entries(fieldMap)) {
        if (val !== undefined && val !== null && val !== '') {
          fields.push(`${col} = $${paramIdx}`);
          values.push(val);
          paramIdx++;
        }
      }

      if (fields.length > 0) {
        fields.push('updated_at = NOW()');
        values.push(deal_id);
        await pool.query(
          `UPDATE deal_submissions SET ${fields.join(', ')} WHERE submission_id = $${paramIdx}`,
          values
        );
      }

      await logAudit(deal.id, 'smart_parse_update', null, 'data_updated',
        { parse_session_id, fields_updated: Object.keys(fieldMap).filter(k => fieldMap[k]) }, req.user.userId);

      res.json({ success: true, message: 'Deal updated with parsed data', submission_id: deal_id });
    } else {
      // CREATE new deal from parsed data
      const result = await pool.query(`
        INSERT INTO deal_submissions (
          user_id, borrower_name, borrower_company, borrower_email, borrower_phone,
          broker_name, broker_company, broker_fca,
          security_address, security_postcode, asset_type, current_value,
          loan_amount, ltv_requested, loan_purpose, exit_strategy,
          term_months, rate_requested, additional_notes, source, internal_status,
          borrower_nationality, borrower_type, company_name, company_number,
          interest_servicing, existing_charges, property_tenure, occupancy_status,
          current_use, purchase_price, use_of_funds, refurb_scope, refurb_cost,
          deposit_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
        RETURNING id, submission_id, status, created_at
      `, [
        req.user.userId,
        pd.borrower_name || null, pd.borrower_company || null, pd.borrower_email || null, pd.borrower_phone || null,
        pd.broker_name || null, pd.broker_company || null, pd.broker_fca || null,
        pd.security_address || null, pd.security_postcode || null, pd.asset_type || null, pd.current_value || null,
        pd.loan_amount || null, pd.ltv_requested || null, pd.loan_purpose || null, pd.exit_strategy || null,
        pd.term_months || null, pd.rate_requested || null, pd.additional_notes || null, 'smart_parse', 'new',
        pd.borrower_nationality || null, pd.borrower_type || null, pd.company_name || null, pd.company_number || null,
        pd.interest_servicing || null, pd.existing_charges || null, pd.property_tenure || null, pd.occupancy_status || null,
        pd.current_use || null, pd.purchase_price || null, pd.use_of_funds || null,
        pd.refurb_scope || null, pd.refurb_cost || null, pd.deposit_source || null
      ]);

      const newDeal = result.rows[0];

      // Auto-assign RM from broker's default_rm if applicable
      if (req.user.role === 'broker') {
        const brokerOnb = await pool.query('SELECT default_rm FROM broker_onboarding WHERE user_id = $1', [req.user.userId]);
        if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
          await pool.query('UPDATE deal_submissions SET assigned_rm = $1, assigned_to = $1, deal_stage = \'assigned\' WHERE id = $2',
            [brokerOnb.rows[0].default_rm, newDeal.id]);
        }
      }

      // Link any documents from the parse session to the new deal
      if (parse_session_id) {
        const linked = await pool.query(
          `UPDATE deal_documents SET deal_id = $1 WHERE parse_session_id = $2 AND deal_id IS NULL`,
          [newDeal.id, parse_session_id]
        );
        console.log(`[smart-parse-confirm] Linked ${linked.rowCount} documents to new deal ${newDeal.submission_id}`);
      }

      await logAudit(newDeal.id, 'deal_submitted_smart_parse', null, 'received',
        { parse_session_id, source: 'smart_parse' }, req.user.userId);

      res.status(201).json({
        success: true,
        message: 'Deal created from parsed documents',
        deal: { id: newDeal.id, submission_id: newDeal.submission_id, status: newDeal.status, created_at: newDeal.created_at }
      });
    }
  } catch (error) {
    console.error('[smart-parse-confirm] Error:', error);
    res.status(500).json({ error: 'Failed to create/update deal from parsed data' });
  }
});

module.exports = router;
