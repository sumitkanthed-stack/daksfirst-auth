const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { parseDocumentsOnly, parseDealForCandidates } = require('../services/claude-parser');
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
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': config.WEBHOOK_SECRET },
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
                  `INSERT INTO deal_borrowers (deal_id, full_name, date_of_birth, nationality, email, phone, role, borrower_type, company_name, company_number, gender, id_type, id_number, id_expiry, residential_address, kyc_status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
                   ON CONFLICT (deal_id, LOWER(TRIM(full_name))) DO UPDATE SET
                     date_of_birth = COALESCE(deal_borrowers.date_of_birth, EXCLUDED.date_of_birth),
                     nationality = COALESCE(deal_borrowers.nationality, EXCLUDED.nationality),
                     email = COALESCE(deal_borrowers.email, EXCLUDED.email),
                     phone = COALESCE(deal_borrowers.phone, EXCLUDED.phone),
                     role = COALESCE(deal_borrowers.role, EXCLUDED.role),
                     borrower_type = COALESCE(deal_borrowers.borrower_type, EXCLUDED.borrower_type),
                     company_name = COALESCE(deal_borrowers.company_name, EXCLUDED.company_name),
                     company_number = COALESCE(deal_borrowers.company_number, EXCLUDED.company_number),
                     gender = COALESCE(deal_borrowers.gender, EXCLUDED.gender),
                     id_type = COALESCE(deal_borrowers.id_type, EXCLUDED.id_type),
                     id_number = COALESCE(deal_borrowers.id_number, EXCLUDED.id_number),
                     id_expiry = COALESCE(deal_borrowers.id_expiry, EXCLUDED.id_expiry),
                     residential_address = COALESCE(deal_borrowers.residential_address, EXCLUDED.residential_address),
                     updated_at = NOW()`,
                  [deal.id, b.full_name, b.date_of_birth || null, b.nationality || null,
                   b.email || null, b.phone || null, b.role || 'primary',
                   result.analysis.company?.borrower_type || 'individual',
                   result.analysis.company?.name || null, result.analysis.company?.company_number || null,
                   b.gender || null, b.id_type || (b.passport_number ? 'passport' : null),
                   b.passport_number || null, b.passport_expiry || null,
                   b.residential_address || null]
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
//  STAGE 4: PARSE FOR CANDIDATES — Extract entities as candidates (not assigned)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/deals/:submissionId/parse-for-review', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;

    // Fetch the deal
    const dealResult = await pool.query(
      `SELECT ds.id, ds.user_id, ds.borrower_user_id FROM deal_submissions ds WHERE ds.submission_id = $1`,
      [submissionId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];

    // Check access (broker, borrower, or internal)
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    const isInternal = INTERNAL_ROLES.includes(req.user.role);
    if (!isOwner && !isInternal) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch ALL docs with file_content for this deal (any category)
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_content, doc_category FROM deal_documents
       WHERE deal_id = $1 AND file_content IS NOT NULL
       ORDER BY uploaded_at ASC`,
      [deal.id]
    );

    if (docsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No documents with content available to parse' });
    }

    console.log(`[parse-for-review] Parsing ${docsResult.rows.length} documents for deal ${submissionId}...`);

    // Seed initial progress — UI polling picks this up right away
    await pool.query(
      `UPDATE deal_submissions SET candidates_progress = $1 WHERE id = $2`,
      [JSON.stringify({ stage: 'started', startedAt: new Date().toISOString(), totalDocs: docsResult.rows.length, message: `Reading ${docsResult.rows.length} document(s)…` }), deal.id]
    );

    // Progress writer — called after each batch. Fire-and-forget so slow DB
    // writes never block the parser itself.
    const onProgress = async (progress) => {
      try {
        await pool.query(
          `UPDATE deal_submissions SET candidates_progress = $1 WHERE id = $2`,
          [JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }), deal.id]
        );
      } catch (e) {
        console.warn('[parse-for-review] progress write failed:', e.message);
      }
    };

    // Call parseDealForCandidates with progress callback
    const parseResult = await parseDealForCandidates(docsResult.rows, { onProgress });

    if (!parseResult.success) {
      return res.status(400).json({ error: 'Failed to parse documents', reason: parseResult.reason });
    }

    // Store result in candidates_payload JSONB + mark progress as complete
    await pool.query(
      `UPDATE deal_submissions
       SET candidates_payload = $1, candidates_parsed_at = NOW(),
           candidates_progress = $3
       WHERE id = $2`,
      [
        JSON.stringify(parseResult.candidates),
        deal.id,
        JSON.stringify({
          stage: 'complete',
          completedAt: new Date().toISOString(),
          totals: {
            corporates: (parseResult.candidates.corporate_entities || []).length,
            individuals: (parseResult.candidates.individuals || []).length,
            properties: (parseResult.candidates.properties || []).length
          },
          message: 'Extraction complete'
        })
      ]
    );

    // Audit log
    await logAudit(deal.id, 'candidates_parsed', null, null,
      {
        documents_count: docsResult.rows.length,
        candidates_count: {
          corporate_entities: (parseResult.candidates.corporate_entities || []).length,
          individuals: (parseResult.candidates.individuals || []).length,
          properties: (parseResult.candidates.properties || []).length
        },
        confidence: parseResult.confidence
      },
      req.user.userId);

    res.json({
      success: true,
      candidates: parseResult.candidates,
      confidence: parseResult.confidence
    });
  } catch (error) {
    console.error('[parse-for-review] Error:', error);
    res.status(500).json({ error: 'Failed to parse for review', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /deals/:submissionId/parse-progress
// Frontend polls this every 2 seconds while parse-for-review is running.
// Returns the latest progress JSON from deal_submissions.candidates_progress.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deals/:submissionId/parse-progress', authenticateToken, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const r = await pool.query(
      `SELECT id, user_id, borrower_user_id, candidates_progress, candidates_parsed_at
         FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = r.rows[0];
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    const isInternal = INTERNAL_ROLES.includes(req.user.role);
    if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

    return res.json({
      success: true,
      progress: deal.candidates_progress || null,
      parsed_at: deal.candidates_parsed_at || null
    });
  } catch (error) {
    console.error('[parse-progress] Error:', error);
    res.status(500).json({ error: 'Failed to read progress' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Apply confirmed candidates to deal (transaction)
// ─────────────────────────────────────────────────────────────────────────────
async function applyConfirmedCandidates(client, dealId, candidates, assignments) {
  // Defensive dedup + guard rails on the assignments themselves, in case the
  // broker accidentally assigned two variants of the same entity to different
  // roles (e.g. two Gold Medal candidates pre-dedup, one as Primary, one as
  // Co-Borrower → produced duplicate top-level parties). 2026-04-20 hardening.

  // ── Corporates: collapse by (company_number OR normalised name) ──
  const corpByKey = new Map();  // key → { assignment, candidate, count }
  for (const a of assignments.corporate_entities || []) {
    if (!a || a.role === 'ignore') continue;
    const cand = (candidates.corporate_entities || []).find(c => c.id === a.candidate_id);
    if (!cand) continue;
    const coNo = (cand.company_number || '').replace(/\s/g, '').toLowerCase();
    const nameKey = (cand.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ltd|limited|llp|plc|inc)$/, '');
    const key = coNo || nameKey || a.candidate_id;
    const existing = corpByKey.get(key);
    if (!existing) {
      corpByKey.set(key, { assignment: a, candidate: cand, count: 1 });
    } else {
      existing.count++;
      // Prefer more-specific roles over 'ignore', and keep first non-ignore role
      if (existing.assignment.role === 'ignore' && a.role !== 'ignore') {
        existing.assignment = a;
        existing.candidate = cand;
      }
    }
  }
  if (corpByKey.size !== (assignments.corporate_entities || []).filter(a => a && a.role !== 'ignore').length) {
    console.log(`[confirm-candidates] dedup: collapsed ${(assignments.corporate_entities || []).length} corporate assignments → ${corpByKey.size} unique`);
  }

  // ── Write deduped corporates ──
  const corpIdMap = {};
  for (const { assignment, candidate } of corpByKey.values()) {
    const { role } = assignment;
    let dbRole = 'primary';
    if (role === 'co_borrower') dbRole = 'joint';
    else if (role === 'corporate_guarantor') dbRole = 'guarantor';

    const result = await client.query(
      `INSERT INTO deal_borrowers (
        deal_id, full_name, borrower_type, role, company_name, company_number, parent_borrower_id, kyc_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, NOW(), NOW())
       RETURNING id`,
      [
        dealId,
        candidate.name || '',
        'corporate',
        dbRole,
        candidate.name || '',
        candidate.company_number || null,
        'pending'
      ]
    );

    const newId = result.rows[0].id;
    // Map EVERY assignment candidate_id that collapsed into this entity so
    // individuals that linked to any variant still resolve correctly.
    for (const a of (assignments.corporate_entities || [])) {
      if (!a) continue;
      const aCand = (candidates.corporate_entities || []).find(c => c.id === a.candidate_id);
      if (!aCand) continue;
      const aCoNo = (aCand.company_number || '').replace(/\s/g, '').toLowerCase();
      const aNameKey = (aCand.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ltd|limited|llp|plc|inc)$/, '');
      const aKey = aCoNo || aNameKey || a.candidate_id;
      const candCoNo = (candidate.company_number || '').replace(/\s/g, '').toLowerCase();
      const candNameKey = (candidate.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ltd|limited|llp|plc|inc)$/, '');
      const candKey = candCoNo || candNameKey || candidate.id;
      if (aKey === candKey) corpIdMap[a.candidate_id] = newId;
    }
    console.log(`[confirm-candidates] wrote corporate ${candidate.name} (${candidate.company_number || 'no-co-no'}) as ${dbRole}, id=${newId}`);
  }

  // ── Individuals: collapse by (DOB OR normalised name) ──
  const indByKey = new Map();
  for (const a of assignments.individuals || []) {
    if (!a || a.role === 'ignore') continue;
    const cand = (candidates.individuals || []).find(c => c.id === a.candidate_id);
    if (!cand) continue;
    const dob = (cand.date_of_birth || '').substring(0, 10);
    const nameKey = (cand.name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
    const key = dob ? `dob:${dob}` : (nameKey ? `name:${nameKey}` : a.candidate_id);
    const existing = indByKey.get(key);
    if (!existing) {
      indByKey.set(key, { assignment: a, candidate: cand });
    } else {
      // If the duplicate carries a link and the existing doesn't, keep the link
      if (!existing.assignment.linked_to_corporate_candidate_id && a.linked_to_corporate_candidate_id) {
        existing.assignment.linked_to_corporate_candidate_id = a.linked_to_corporate_candidate_id;
      }
    }
  }

  // ── Write individuals ──
  for (const { assignment, candidate } of indByKey.values()) {
    const { role } = assignment;
    let parentBorrowerId = null;
    if (assignment.linked_to_corporate_candidate_id) {
      parentBorrowerId = corpIdMap[assignment.linked_to_corporate_candidate_id] || null;
    }
    // Fallback: if no link provided but we wrote exactly one corporate,
    // parent to that corporate. Common case for simple corporate + UBO deals.
    if (!parentBorrowerId && Object.keys(corpIdMap).length > 0) {
      const uniqueIds = Array.from(new Set(Object.values(corpIdMap)));
      if (uniqueIds.length === 1 && (role === 'ubo' || role === 'director' || role === 'pg_from_ubo')) {
        parentBorrowerId = uniqueIds[0];
        console.log(`[confirm-candidates] auto-linked individual ${candidate.name} to sole corporate id=${parentBorrowerId} (no explicit link set)`);
      }
    }

    // CRITICAL: map UI-level roles to DB-allowed role values.
    // CHECK constraint (migrations.js:650) accepts ONLY:
    //   'primary','joint','guarantor','director','ubo','psc','shareholder'
    // 'pg_from_ubo' is NOT valid — map to 'ubo' + set pg_status='required'.
    // 'kyc_only' → 'primary' (as applicant).
    let dbRole;
    let pgStatus = null;
    if (role === 'ubo') {
      dbRole = 'ubo';
    } else if (role === 'director') {
      dbRole = 'director';
    } else if (role === 'pg_from_ubo') {
      dbRole = 'ubo';
      pgStatus = 'required';
    } else if (role === 'third_party_guarantor') {
      dbRole = 'guarantor';
      pgStatus = 'required';
    } else if (role === 'kyc_only') {
      dbRole = 'primary';
    } else {
      dbRole = 'primary';  // safe default
    }

    const kycData = { pg_required: pgStatus === 'required' };

    // Mirror UBO-style records into ch_match_data so the DIP + Matrix Parties
    // grouping (which keys off is_psc + officer_role) renders Alessandra as an
    // actual UBO card, not just a bare child row.
    const chMatchData = (role === 'ubo' || role === 'pg_from_ubo')
      ? { is_psc: true, officer_role: 'Ultimate Beneficial Owner', psc_percentage: candidate.psc_percentage || null, appointed_on: null, resigned_on: null, nationality: candidate.nationality || null }
      : (role === 'director' ? { is_psc: false, officer_role: 'Director' } : null);

    await client.query(
      `INSERT INTO deal_borrowers (
        deal_id, full_name, borrower_type, role, date_of_birth, nationality, email, phone, parent_borrower_id, kyc_status, kyc_data, ch_match_data, ch_matched_role, pg_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())`,
      [
        dealId,
        candidate.name || '',
        'individual',
        dbRole,
        candidate.date_of_birth || null,
        candidate.nationality || null,
        candidate.email || null,
        candidate.phone || null,
        parentBorrowerId,
        'pending',
        JSON.stringify(kycData),
        chMatchData ? JSON.stringify(chMatchData) : null,
        (role === 'ubo' || role === 'pg_from_ubo') ? 'UBO' : (role === 'director' ? 'Director' : null),
        pgStatus
      ]
    );
    console.log(`[confirm-candidates] wrote individual ${candidate.name} as role=${dbRole}, pg_status=${pgStatus || 'NULL'}, parent=${parentBorrowerId || 'TOP-LEVEL'}`);
  }

  // Write properties (wipe and rewrite)
  await client.query(`DELETE FROM deal_properties WHERE deal_id = $1`, [dealId]);

  for (const propAssignment of assignments.properties || []) {
    const candidate = candidates.properties.find(c => c.id === propAssignment.candidate_id);
    if (!candidate) continue;

    if (propAssignment.role === 'ignore') continue;

    await client.query(
      `INSERT INTO deal_properties (
        deal_id, address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price, gdv, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
      [
        dealId,
        candidate.address || '',
        candidate.postcode || null,
        candidate.property_type || null,
        candidate.tenure || null,
        candidate.occupancy || null,
        candidate.current_use || null,
        candidate.market_value || null,
        candidate.purchase_price || null,
        null // gdv can be null or calculated later
      ]
    );
  }

  // Update deal_submissions from loan_facts and broker
  const loanFacts = candidates.loan_facts || {};
  const broker = candidates.broker || {};

  const updateData = [];
  const updateValues = [];
  let paramIndex = 1;

  if (loanFacts.amount_requested) {
    updateData.push(`loan_amount = $${paramIndex++}`);
    updateValues.push(loanFacts.amount_requested);
  }
  if (loanFacts.ltv_requested) {
    updateData.push(`ltv_requested = $${paramIndex++}`);
    updateValues.push(loanFacts.ltv_requested);
  }
  if (loanFacts.term_months) {
    updateData.push(`term_months = $${paramIndex++}`);
    updateValues.push(loanFacts.term_months);
  }
  if (loanFacts.rate_requested) {
    updateData.push(`rate_requested = $${paramIndex++}`);
    updateValues.push(loanFacts.rate_requested);
  }
  if (loanFacts.loan_purpose) {
    updateData.push(`loan_purpose = $${paramIndex++}`);
    updateValues.push(loanFacts.loan_purpose);
  }
  if (loanFacts.exit_strategy) {
    updateData.push(`exit_strategy = $${paramIndex++}`);
    updateValues.push(loanFacts.exit_strategy);
  }
  if (loanFacts.arrangement_fee_pct) {
    updateData.push(`arrangement_fee_pct = $${paramIndex++}`);
    updateValues.push(loanFacts.arrangement_fee_pct);
  }
  if (loanFacts.broker_fee_pct !== undefined) {
    updateData.push(`broker_fee_pct = $${paramIndex++}`);
    updateValues.push(loanFacts.broker_fee_pct);
  }

  if (broker.name) {
    updateData.push(`broker_name = $${paramIndex++}`);
    updateValues.push(broker.name);
  }
  if (broker.company) {
    updateData.push(`broker_company = $${paramIndex++}`);
    updateValues.push(broker.company);
  }
  if (broker.fca_number) {
    updateData.push(`broker_fca = $${paramIndex++}`);
    updateValues.push(broker.fca_number);
  }

  // Determine primary borrower name/type
  const primaryCorp = assignments.corporate_entities?.find(c => c.role === 'primary_borrower');
  const primaryInd = assignments.individuals?.find(c => c.role === 'primary_borrower');

  if (primaryCorp) {
    const corpCandidate = candidates.corporate_entities.find(c => c.id === primaryCorp.candidate_id);
    if (corpCandidate) {
      updateData.push(`borrower_name = $${paramIndex++}`);
      updateValues.push(corpCandidate.name || '');
      updateData.push(`borrower_company = $${paramIndex++}`);
      updateValues.push(corpCandidate.name || '');
      updateData.push(`borrower_type = 'corporate'`);
    }
  } else if (primaryInd) {
    const indCandidate = candidates.individuals.find(c => c.id === primaryInd.candidate_id);
    if (indCandidate) {
      updateData.push(`borrower_name = $${paramIndex++}`);
      updateValues.push(indCandidate.name || '');
      updateData.push(`borrower_type = 'individual'`);
    }
  }

  if (updateData.length > 0) {
    updateValues.push(dealId);
    await client.query(
      `UPDATE deal_submissions SET ${updateData.join(', ')} WHERE id = $${paramIndex}`,
      updateValues
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM CANDIDATES — Assign roles and persist to deal
// ─────────────────────────────────────────────────────────────────────────────
router.post('/deals/:submissionId/confirm-candidates', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { submissionId } = req.params;
    const { assignments } = req.body;

    if (!assignments) {
      return res.status(400).json({ error: 'assignments object is required' });
    }

    // Fetch the deal
    const dealResult = await client.query(
      `SELECT ds.id, ds.user_id, ds.borrower_user_id, ds.candidates_payload
       FROM deal_submissions ds WHERE ds.submission_id = $1`,
      [submissionId]
    );

    if (dealResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];

    // Check access — log detail so 403s are diagnosable
    const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
    const isInternal = INTERNAL_ROLES.includes(req.user.role);
    const isBroker = req.user.role === 'broker';
    console.log(`[confirm-candidates] access check: user=${req.user.userId}(role=${req.user.role}), deal=${submissionId}, deal.user_id=${deal.user_id}, deal.borrower_user_id=${deal.borrower_user_id}, isOwner=${isOwner}, isInternal=${isInternal}, isBroker=${isBroker}`);
    // Permissive: any authenticated broker, owner, or internal user can confirm.
    // A broker submitting their own deal should always be able to confirm candidates.
    if (!isOwner && !isInternal && !isBroker) {
      client.release();
      return res.status(403).json({
        error: 'Access denied',
        message: `User role '${req.user.role}' cannot confirm candidates. isOwner=${isOwner}, isInternal=${isInternal}.`
      });
    }

    // Load candidates payload
    const candidates = deal.candidates_payload;
    if (!candidates) {
      client.release();
      return res.status(400).json({ error: 'No candidates found for this deal. Call parse-for-review first.' });
    }

    // Validate: at least ONE primary_borrower
    const hasPrimaryBorrower = (assignments.corporate_entities || []).some(c => c.role === 'primary_borrower') ||
                               (assignments.individuals || []).some(c => c.role === 'primary_borrower');

    if (!hasPrimaryBorrower) {
      client.release();
      return res.status(400).json({ error: 'At least one primary_borrower must be assigned' });
    }

    // BEGIN TRANSACTION
    await client.query('BEGIN');

    try {
      // Wipe existing parties
      await client.query(`DELETE FROM deal_borrowers WHERE deal_id = $1`, [deal.id]);

      // Apply confirmed candidates
      await applyConfirmedCandidates(client, deal.id, candidates, assignments);

      // Audit log
      const corpCount = assignments.corporate_entities?.filter(c => c.role !== 'ignore').length || 0;
      const indCount = assignments.individuals?.filter(c => c.role !== 'ignore').length || 0;
      const propCount = assignments.properties?.filter(c => c.role !== 'ignore').length || 0;

      await logAudit(deal.id, 'candidates_confirmed', null, null,
        {
          assignments,
          counts: {
            corporates_created: corpCount,
            individuals_created: indCount,
            properties_created: propCount
          }
        },
        req.user.userId);

      // COMMIT
      await client.query('COMMIT');

      res.json({
        success: true,
        summary: {
          corporates_created: corpCount,
          individuals_created: indCount,
          properties_created: propCount
        }
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[confirm-candidates] Error:', error);
    res.status(500).json({ error: 'Failed to confirm candidates', message: error.message });
  } finally {
    client.release();
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
