const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { parseDocumentsOnly } = require('../services/claude-parser');
const { syncDealProperties } = require('../services/property-parser');
const config = require('../config');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 }
});

const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];
const N8N_PARSE_WEBHOOK_URL = config.N8N_PARSE_WEBHOOK_URL || '';

// ── Extract doc_expiry_date and doc_issue_date from parsed analysis ──
// Path A analysis has nested objects (borrowers[].passport_expiry, insurance.expiry_date, etc.)
// Path B flatFields have doc_expiry_date and doc_issue_date directly
function extractDocDates(analysis, flatFields, docCategory) {
  let expiryDate = null;
  let issueDate = null;

  // 1. Try flatFields first (Path B puts them there directly)
  if (flatFields) {
    if (flatFields.doc_expiry_date) expiryDate = flatFields.doc_expiry_date;
    if (flatFields.doc_issue_date) issueDate = flatFields.doc_issue_date;
    if (flatFields['doc-expiry-date']) expiryDate = flatFields['doc-expiry-date'];
    if (flatFields['doc-issue-date']) issueDate = flatFields['doc-issue-date'];
  }

  // 2. Try analysis object (Path A nested structure)
  if (analysis && !expiryDate) {
    const cat = (docCategory || '').toLowerCase();
    // KYC documents — passport expiry
    if (cat === 'kyc' || cat === 'id') {
      const borrower = (analysis.borrowers || [])[0];
      if (borrower && borrower.passport_expiry) expiryDate = borrower.passport_expiry;
    }
    // Insurance — policy expiry
    if (cat === 'legal' || cat === 'insurance') {
      if (analysis.insurance && analysis.insurance.expiry_date) expiryDate = analysis.insurance.expiry_date;
    }
    // Property/valuation — valuation date as issue date
    if (cat === 'property' || cat === 'valuation') {
      const prop = (analysis.parsedProperties || [])[0];
      if (prop && prop.valuation_date) issueDate = prop.valuation_date;
    }
  }

  // Validate date format (must be YYYY-MM-DD)
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (expiryDate && !dateRe.test(expiryDate)) expiryDate = null;
  if (issueDate && !dateRe.test(issueDate)) issueDate = null;

  return { expiryDate, issueDate };
}

// ── Lightweight filename-based document categoriser (no AI call) ──
function categoriseByFilename(filename) {
  const f = (filename || '').toLowerCase();

  // KYC / Identity
  if (/passport|driving.?licen[cs]e|photo.?id|national.?id|visa|biometric|right.?to.?remain|brp/i.test(f)) return 'kyc';
  if (/kyc|know.?your.?customer|id.?check|identity|aml.?check/i.test(f)) return 'kyc';

  // Financial
  if (/bank.?statement|account.?statement/i.test(f)) return 'financial';
  if (/tax.?return|sa302|sa100|ct600|p60|p45|payslip|wage.?slip|income/i.test(f)) return 'financial';
  if (/assets?.?liabilit|net.?worth|financial.?statement|balance.?sheet|pnl|profit.?(?:and|&).?loss/i.test(f)) return 'financial';
  if (/statement.*gbp|statement.*eur|statement.*usd/i.test(f)) return 'financial';

  // Property
  if (/title.?register|title.?deed|land.?registry|hmlr|official.?copy/i.test(f)) return 'property';
  if (/valuation|survey|rics|red.?book|avm|property.?report|epc|floor.?plan/i.test(f)) return 'property';
  if (/portfolio|schedule.?of.?propert|rent.?roll|tenancy|lease.?agreement|asr/i.test(f)) return 'property';
  if (/planning.?permission|building.?reg|completion.?cert/i.test(f)) return 'property';

  // Legal
  if (/solicitor|legal|facility.?agreement|loan.?agreement|charge|debenture|guarantee/i.test(f)) return 'legal';
  if (/certificate.?of.?incorporat|company.?search|memorandum|articles/i.test(f)) return 'legal';
  if (/insurance|indemnity|warranty/i.test(f)) return 'legal';

  // Proof of address (subset of KYC but useful to separate)
  if (/council.?tax|utility.?bill|water.?bill|electric|gas.?bill|phone.?bill|proof.?of.?address/i.test(f)) return 'kyc';

  // Company filings
  if (/csl2|companies.?house|annual.?return|confirmation.?statement|filing/i.test(f)) return 'legal';

  return 'uncategorised';
}

// ═══════════════════════════════════════════════════════════════════════════
//  UPLOAD FILES — Filing cabinet with staging. Save files, text, notes.
//  Create/attach deal, redirect. No AI calls here.
//  Parsing happens inside the deal via doc-panel flow (Path A).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/upload', authenticateToken, upload.any(), async (req, res) => {
  try {
    console.log('[smart-parse] Upload from user:', req.user.userId, 'files:', req.files?.length || 0);
    const { deal_id, whatsapp_text, notes } = req.body;

    if ((!req.files || req.files.length === 0) && !whatsapp_text) {
      return res.status(400).json({ error: 'No files or text provided' });
    }

    // Truncate MIME types that exceed DB column width (Office formats can be 73+ chars)
    const safeMime = (mime) => (mime || 'application/octet-stream').substring(0, 255);

    // ── Resolve or create the deal ────────────────────────────────────
    let dealIntId = null;    // integer PK (deal_submissions.id)
    let submissionId = null; // UUID (deal_submissions.submission_id) — used for frontend routing

    if (deal_id) {
      // EXISTING DEAL — verify access
      const dealCheck = await pool.query(
        `SELECT id, submission_id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
        [deal_id]
      );
      if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const d = dealCheck.rows[0];
      const isOwner = d.user_id === req.user.userId || d.borrower_user_id === req.user.userId;
      const isInternal = INTERNAL_ROLES.includes(req.user.role);
      if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });
      dealIntId = d.id;
      submissionId = d.submission_id;
      console.log(`[smart-parse] Attaching ${req.files.length} files to existing deal ${submissionId}`);
    } else {
      // NEW DEAL — create a blank deal in DRAFT stage (broker can edit before submitting)
      // If broker is creating: auto-set broker details from their profile (not from parsed docs)
      let brokerName = null, brokerCompany = null, brokerFca = null;
      if (req.user.role === 'broker') {
        brokerName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
        brokerCompany = req.user.company || null;
        brokerFca = req.user.fca_number || null;
      }

      const newDeal = await pool.query(
        `INSERT INTO deal_submissions (user_id, source, internal_status, deal_stage, broker_name, broker_company, broker_fca)
         VALUES ($1, 'smart_parse', 'new', 'draft', $2, $3, $4)
         RETURNING id, submission_id`,
        [req.user.userId, brokerName, brokerCompany, brokerFca]
      );
      dealIntId = newDeal.rows[0].id;
      submissionId = newDeal.rows[0].submission_id;
      console.log(`[smart-parse] Created new blank deal ${submissionId} for ${req.files.length} files (broker: ${brokerName || 'internal'})`);

      // Note: RM auto-assignment happens when broker submits the draft (moves to 'received'),
      // not at filing cabinet stage. Deal stays in 'draft' until broker explicitly submits.
    }

    // ── Save WhatsApp text and notes to the deal ───────────────────────
    const updateParts = [];
    const updateVals = [];
    let pIdx = 1;
    if (whatsapp_text) {
      updateParts.push(`additional_notes = COALESCE(additional_notes, '') || $${pIdx}`);
      updateVals.push((whatsapp_text || '').substring(0, 10000));
      pIdx++;
    }
    if (notes) {
      // Append notes after any existing text, separated by newline
      updateParts.push(`additional_notes = COALESCE(additional_notes, '') || $${pIdx}`);
      updateVals.push('\n--- Broker note ---\n' + (notes || '').substring(0, 5000));
      pIdx++;
    }
    if (updateParts.length > 0) {
      updateVals.push(dealIntId);
      try {
        await pool.query(
          `UPDATE deal_submissions SET ${updateParts.join(', ')}, updated_at = NOW() WHERE id = $${pIdx}`,
          updateVals
        );
        console.log(`[smart-parse] Saved text/notes to deal ${submissionId}`);
      } catch (txtErr) {
        console.warn('[smart-parse] Could not save text/notes:', txtErr.message);
      }
    }

    // ── Upload to OneDrive (best-effort) ──────────────────────────────
    let token;
    const uploadedFiles = [];
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[smart-parse] OneDrive token failed:', err.message);
    }

    if (token && req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const dealRef = submissionId.substring(0, 8);
          const info = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);
          uploadedFiles.push({ filename: file.originalname, ...info });
        } catch (err) {
          console.error('[smart-parse] OneDrive upload failed for:', file.originalname);
        }
      }
    }

    // ── Save files to deal_documents ──────────────────────────────────
    let savedCount = 0;
    for (const file of (req.files || [])) {
      const odFile = uploadedFiles.find(u => u.filename === file.originalname);
      const suggestedCategory = categoriseByFilename(file.originalname);
      try {
        await pool.query(
          `INSERT INTO deal_documents (deal_id, filename, file_type, file_size, file_content, doc_category, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            dealIntId,
            file.originalname,
            safeMime(file.mimetype),
            file.size,
            file.buffer,
            suggestedCategory,
            odFile ? odFile.itemId : null,
            odFile ? odFile.path : null,
            odFile ? odFile.downloadUrl : null
          ]
        );
        savedCount++;
      } catch (err) {
        // Fallback: try without file_content column (in case of older schema)
        try {
          await pool.query(
            `INSERT INTO deal_documents (deal_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              dealIntId,
              file.originalname,
              safeMime(file.mimetype),
              file.size,
              odFile ? odFile.itemId : null,
              odFile ? odFile.path : null,
              odFile ? odFile.downloadUrl : null
            ]
          );
          savedCount++;
        } catch (err2) {
          console.error(`[smart-parse] DB insert failed for "${file.originalname}":`, err2.message);
        }
      }
    }

    const totalFiles = (req.files || []).length;
    console.log(`[smart-parse] Saved ${savedCount}/${totalFiles} files to deal ${submissionId}`);

    await logAudit(dealIntId, deal_id ? 'docs_added_to_deal' : 'deal_created_with_docs', null, 'upload',
      { files_saved: savedCount, files_received: totalFiles, source: 'smart_parse', has_text: !!whatsapp_text, has_notes: !!notes }, req.user.userId);

    // ── Return submission_id so frontend can redirect into the deal ───
    res.json({
      success: true,
      submission_id: submissionId,
      is_new_deal: !deal_id,
      files_saved: savedCount,
      files_received: totalFiles,
      message: deal_id
        ? `${savedCount} file${savedCount !== 1 ? 's' : ''} added to deal. Opening deal...`
        : `New deal created with ${savedCount} file${savedCount !== 1 ? 's' : ''}. Opening deal...`
    });
  } catch (error) {
    console.error('[smart-parse] Error:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CATEGORISE DOCS — Claude Haiku classifies documents by content
//  Called after broker submits from staging area (fire-and-forget friendly)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/categorise-docs/:submissionId', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;

    // Get deal_id from submission_id
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`, [submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealIntId = dealResult.rows[0].id;

    // Fetch all docs that need categorisation (uncategorised or recently uploaded)
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_content FROM deal_documents
       WHERE deal_id = $1 AND (doc_category = 'uncategorised' OR doc_category IS NULL)
       ORDER BY id`,
      [dealIntId]
    );

    if (docsResult.rows.length === 0) {
      return res.json({ success: true, categorised: 0, message: 'No uncategorised documents found' });
    }

    // Respond immediately — categorise in background
    res.json({
      success: true,
      queued: docsResult.rows.length,
      message: `Categorising ${docsResult.rows.length} document${docsResult.rows.length !== 1 ? 's' : ''} with Claude...`
    });

    // ── Background categorisation ──
    const { categoriseWithAI } = require('../services/ai-categorise');

    // Map AI categories → frontend categories
    const CATEGORY_MAP = {
      'kyc': 'kyc',
      'financials_aml': 'financial',
      'valuation': 'property',
      'use_of_funds': 'financial',
      'exit_evidence': 'financial',
      'other_conditions': 'legal',
      'general': 'other'
    };

    let categorised = 0;
    for (const doc of docsResult.rows) {
      try {
        // Build a file-like object for categoriseWithAI
        const fileObj = {
          buffer: doc.file_content,
          mimetype: doc.file_type || 'application/pdf',
          originalname: doc.filename
        };

        const aiCategory = await categoriseWithAI(fileObj);
        const mappedCategory = aiCategory ? (CATEGORY_MAP[aiCategory] || 'other') : categoriseByFilename(doc.filename);

        await pool.query(
          `UPDATE deal_documents SET doc_category = $1, updated_at = NOW() WHERE id = $2`,
          [mappedCategory, doc.id]
        );
        categorised++;
        console.log(`[categorise] ${doc.filename} → ${aiCategory} → ${mappedCategory}`);
      } catch (docErr) {
        console.error(`[categorise] Failed for ${doc.filename}:`, docErr.message);
        // Fallback to filename-based
        const fallback = categoriseByFilename(doc.filename);
        await pool.query(
          `UPDATE deal_documents SET doc_category = $1, updated_at = NOW() WHERE id = $2`,
          [fallback, doc.id]
        ).catch(() => {});
      }
    }

    console.log(`[categorise] Done: ${categorised}/${docsResult.rows.length} docs for deal ${submissionId}`);
  } catch (error) {
    console.error('[categorise-docs] Error:', error);
    // Already responded — just log
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

    console.log(`[parse-session] Session ${parse_session_id}: ${docs.length} docs — using Path A (claude-parser)`);

    // Use Path A (claude-parser.js) — same quality as in-deal parsing
    // Sends actual PDFs to Claude vision API, batches, deduplicates
    const result = await parseDocumentsOnly(docs);

    // Mark all documents as parsed
    try {
      await pool.query(
        `UPDATE deal_documents SET parsed_at = COALESCE(parsed_at, NOW()) WHERE parse_session_id = $1`,
        [parse_session_id]
      );
    } catch (markErr) {
      console.warn('[parse-session] Could not mark parsed_at:', markErr.message);
    }

    if (result.success && result.flatFields) {
      const fieldCount = Object.keys(result.flatFields).filter(k => result.flatFields[k] != null && result.flatFields[k] !== '' && k !== 'confidence').length;
      res.json({
        success: true,
        total_documents: docs.length,
        parsed_data: result.flatFields,
        full_analysis: result.analysis, // Rich data for later use when deal is created
        message: `Parsed ${docs.length} documents using Claude. ${fieldCount} fields extracted. Review below.`
      });
    } else {
      res.json({
        success: true,
        total_documents: docs.length,
        parsed_data: null,
        message: `Could not extract data from documents (${result.reason || 'unknown error'}).`
      });
    }
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

    // ── Strategy 2: Path A — Claude vision API (parseDocumentsOnly) ──
    // This is the strong parser that sends actual PDF/image bytes to Claude,
    // batches, deduplicates, and returns rich structured data.
    let extractionConflicts = {};
    if (!parsedData) {
      const docsWithContent = docs.filter(d => d.file_content && d.file_content.length > 0);
      console.log(`[parse-confirmed] Using Path A (claude-parser) for ${docsWithContent.length}/${docs.length} docs with content...`);
      try {
        const result = await parseDocumentsOnly(docsWithContent);
        if (result.success && result.flatFields) {
          parsedData = result.flatFields;
          const fieldCount = Object.keys(result.flatFields).filter(k => result.flatFields[k] != null && result.flatFields[k] !== '' && k !== 'confidence').length;
          console.log(`[parse-confirmed] Path A extracted ${fieldCount} fields`);

          // Store full analysis JSON per document and extract validity dates per doc category
          if (result.analysis) {
            try {
              await pool.query(
                `UPDATE deal_documents SET parsed_data = $1, parsed_at = NOW() WHERE deal_id = $2 AND file_content IS NOT NULL`,
                [JSON.stringify(result.analysis), deal.id]
              );
              // Write per-document validity dates based on each doc's category
              for (const d of docsWithContent) {
                const { expiryDate, issueDate } = extractDocDates(result.analysis, result.flatFields, d.doc_category);
                if (expiryDate || issueDate) {
                  try {
                    await pool.query(
                      `UPDATE deal_documents SET doc_expiry_date = COALESCE($1, doc_expiry_date), doc_issue_date = COALESCE($2, doc_issue_date) WHERE id = $3`,
                      [expiryDate, issueDate, d.id]
                    );
                  } catch (dateErr) { /* ignore per-doc date write errors */ }
                }
              }
            } catch (storeErr) {
              console.warn('[parse-confirmed] Could not store analysis:', storeErr.message);
            }
          }
          // ── Sync ALL properties to deal_properties (not just the first one) ──
          if (result.analysis && result.analysis.parsedProperties && result.analysis.parsedProperties.length > 0) {
            try {
              const claudeProperties = result.analysis.parsedProperties.map(p => ({
                address: p.address || '',
                postcode: p.postcode || null,
                market_value: p.market_value ? parseFloat(p.market_value) : null,
                purchase_price: p.purchase_price ? parseFloat(p.purchase_price) : null,
                property_type: p.property_type || null,
                tenure: p.tenure || null,
                source: 'claude_parsed'
              }));
              await syncDealProperties(pool, deal.id, claudeProperties, { force: true });
              console.log(`[parse-confirmed] Synced ${claudeProperties.length} properties to deal_properties`);
            } catch (propErr) {
              console.warn('[parse-confirmed] Property sync error:', propErr.message);
            }
          }

          // ── Sync ALL borrowers to deal_borrowers ──
          if (result.analysis && result.analysis.borrowers && result.analysis.borrowers.length > 0) {
            try {
              // Only delete pending borrowers that have NOT been CH-verified or KYC-verified
              await pool.query(
                `DELETE FROM deal_borrowers WHERE deal_id = $1 AND kyc_status = 'pending' AND ch_verified_at IS NULL`,
                [deal.id]
              );
              for (const b of result.analysis.borrowers) {
                if (!b.full_name) continue;
                // UPSERT: if borrower with same name exists on this deal, update missing fields only
                await pool.query(
                  `INSERT INTO deal_borrowers (deal_id, full_name, date_of_birth, nationality, email, phone, role, borrower_type, company_name, company_number, kyc_status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
                   ON CONFLICT (deal_id, LOWER(TRIM(full_name))) DO UPDATE SET
                     date_of_birth = COALESCE(deal_borrowers.date_of_birth, EXCLUDED.date_of_birth),
                     nationality = COALESCE(deal_borrowers.nationality, EXCLUDED.nationality),
                     email = COALESCE(deal_borrowers.email, EXCLUDED.email),
                     phone = COALESCE(deal_borrowers.phone, EXCLUDED.phone),
                     role = COALESCE(deal_borrowers.role, EXCLUDED.role),
                     borrower_type = COALESCE(deal_borrowers.borrower_type, EXCLUDED.borrower_type),
                     company_name = COALESCE(deal_borrowers.company_name, EXCLUDED.company_name),
                     company_number = COALESCE(deal_borrowers.company_number, EXCLUDED.company_number),
                     updated_at = NOW()`,
                  [deal.id, b.full_name, b.date_of_birth || null, b.nationality || null,
                   b.email || null, b.phone || null, b.role || 'primary',
                   result.analysis.company?.borrower_type || 'individual',
                   result.analysis.company?.name || null, result.analysis.company?.company_number || null]
                );
              }
              console.log(`[parse-confirmed] Synced ${result.analysis.borrowers.length} borrowers to deal_borrowers`);
            } catch (borrErr) {
              console.warn('[parse-confirmed] Borrower sync error:', borrErr.message);
            }
          }
        } else {
          console.warn(`[parse-confirmed] Path A returned no data: ${result.reason || 'unknown'}`);
        }
      } catch (extractErr) {
        console.error('[parse-confirmed] Path A extraction failed:', extractErr.message);
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
        extraction_method: N8N_PARSE_WEBHOOK_URL ? 'n8n' : 'path_a_claude_vision' }, req.user.userId);

    const fieldCount = parsedData
      ? Object.keys(parsedData).filter(k => parsedData[k] != null && parsedData[k] !== '' && k !== 'confidence').length
      : 0;
    res.json({
      success: true,
      total_documents: docs.length,
      confirmed_documents: confirmed.length,
      unconfirmed_documents: unconfirmed.length,
      parsed_data: parsedData || null,
      conflicts: extractionConflicts || {},
      message: parsedData
        ? `Parsed ${docs.length} documents using Claude vision. ${fieldCount} fields extracted. Review below.`
        : `Documents marked as parsed but Claude could not extract structured data.`
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

    // Extract using Path A (Claude vision API) — same engine as bulk parse
    if (!doc.file_content) {
      return res.status(400).json({ error: 'Document content not available for parsing' });
    }

    console.log(`[parse-document] Path A extraction for "${doc.filename}" (${doc.file_type})...`);
    const result = await parseDocumentsOnly([doc]); // Pass single doc as array

    const parsedData = (result.success && result.flatFields) ? result.flatFields : null;
    const fieldCount = parsedData
      ? Object.keys(parsedData).filter(k => parsedData[k] != null && parsedData[k] !== '' && k !== 'confidence').length
      : 0;

    // Store result and mark as parsed — also write doc_expiry_date / doc_issue_date
    try {
      const { expiryDate, issueDate } = extractDocDates(result.analysis, parsedData, doc.doc_category);
      await pool.query(
        `UPDATE deal_documents SET parsed_data = $1, parsed_at = NOW(),
         doc_expiry_date = COALESCE($3, doc_expiry_date),
         doc_issue_date = COALESCE($4, doc_issue_date)
         WHERE id = $2`,
        [result.analysis ? JSON.stringify(result.analysis) : null, docId, expiryDate, issueDate]
      );
      if (expiryDate || issueDate) console.log(`[parse-document] Validity dates: expiry=${expiryDate}, issue=${issueDate}`);
    } catch (storeErr) {
      console.warn(`[parse-document] Could not store parsed_data:`, storeErr.message);
    }

    await logAudit(doc.deal_id, 'document_parsed', null, doc.filename,
      { doc_id: docId, fields_extracted: fieldCount, method: 'path_a_claude_vision' },
      req.user.userId);

    res.json({
      success: true,
      doc_id: parseInt(docId),
      filename: doc.filename,
      parsed_data: parsedData || {},
      cached: false,
      message: parsedData
        ? `Extracted ${fieldCount} fields from "${doc.filename}" using Claude vision.`
        : `Could not extract data from "${doc.filename}".`
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

      // If the deal creator is a broker, don't let parsed docs overwrite broker fields
      // (the broker IS the logged-in user, not someone mentioned in the docs)
      const dealCreatorIsBroker = req.user.role === 'broker' || (!INTERNAL_ROLES.includes(req.user.role));

      const fieldMap = {
        borrower_name: pd.borrower_name, borrower_company: pd.borrower_company,
        borrower_email: pd.borrower_email, borrower_phone: pd.borrower_phone,
        ...(dealCreatorIsBroker ? {} : { broker_name: pd.broker_name, broker_company: pd.broker_company, broker_fca: pd.broker_fca }),
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
      // CREATE new deal from parsed data — starts as DRAFT
      // If broker: use their profile for broker fields, not whatever was parsed from docs
      const isBrokerCreator = req.user.role === 'broker';
      const brokerN = isBrokerCreator ? ([req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null) : (pd.broker_name || null);
      const brokerC = isBrokerCreator ? (req.user.company || null) : (pd.broker_company || null);
      const brokerF = isBrokerCreator ? (req.user.fca_number || null) : (pd.broker_fca || null);

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
          deposit_source, deal_stage
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,'draft')
        RETURNING id, submission_id, status, created_at
      `, [
        req.user.userId,
        pd.borrower_name || null, pd.borrower_company || null, pd.borrower_email || null, pd.borrower_phone || null,
        brokerN, brokerC, brokerF,
        pd.security_address || null, pd.security_postcode || null, pd.asset_type || null, pd.current_value || null,
        pd.loan_amount || null, pd.ltv_requested || null, pd.loan_purpose || null, pd.exit_strategy || null,
        pd.term_months || null, pd.rate_requested || null, pd.additional_notes || null, 'smart_parse', 'new',
        pd.borrower_nationality || null, pd.borrower_type || null, pd.company_name || null, pd.company_number || null,
        pd.interest_servicing || null, pd.existing_charges || null, pd.property_tenure || null, pd.occupancy_status || null,
        pd.current_use || null, pd.purchase_price || null, pd.use_of_funds || null,
        pd.refurb_scope || null, pd.refurb_cost || null, pd.deposit_source || null
      ]);

      const newDeal = result.rows[0];

      // Note: RM auto-assignment happens when broker submits the draft, not at creation
      // Link any documents from the parse session to the new deal
      if (parse_session_id) {
        const linked = await pool.query(
          `UPDATE deal_documents SET deal_id = $1 WHERE parse_session_id = $2 AND deal_id IS NULL`,
          [newDeal.id, parse_session_id]
        );
        console.log(`[smart-parse-confirm] Linked ${linked.rowCount} documents to new deal ${newDeal.submission_id}`);
      }

      await logAudit(newDeal.id, 'deal_created_draft', null, 'draft',
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
