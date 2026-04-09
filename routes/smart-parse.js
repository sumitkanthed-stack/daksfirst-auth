const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

const pool = require('../db/pool');
const { authenticateToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAudit } = require('../services/audit');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const config = require('../config');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
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

    // Save file records to deal_documents — always, even without OneDrive, and save file_content (BYTEA)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const matchingUpload = uploadedFiles.find(u => u.filename === file.originalname);

        // Add file_content column if it doesn't exist, then save the file
        try {
          await pool.query(
            `INSERT INTO deal_documents (deal_id, parse_session_id, filename, file_type, file_size, file_content, onedrive_item_id, onedrive_path, onedrive_download_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              existingDeal ? existingDeal.id : null,
              parseSessionId,
              file.originalname,
              file.mimetype,
              file.size,
              file.buffer, // Stored as BYTEA
              matchingUpload ? matchingUpload.onedrive_item_id : null,
              matchingUpload ? matchingUpload.onedrive_path : null,
              matchingUpload ? matchingUpload.onedrive_download_url : null
            ]
          );
        } catch (err) {
          if (err.message.includes('file_content')) {
            // Column doesn't exist yet, try without it
            await pool.query(
              `INSERT INTO deal_documents (deal_id, parse_session_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                existingDeal ? existingDeal.id : null,
                parseSessionId,
                file.originalname,
                file.mimetype,
                file.size,
                matchingUpload ? matchingUpload.onedrive_item_id : null,
                matchingUpload ? matchingUpload.onedrive_path : null,
                matchingUpload ? matchingUpload.onedrive_download_url : null
              ]
            );
          } else {
            throw err;
          }
        }
      }
      console.log(`[smart-parse] Saved ${req.files.length} file records to deal_documents (parse_session_id: ${parseSessionId})`);
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
      console.log('[smart-parse] N8N_PARSE_WEBHOOK_URL not configured — returning files without AI parsing');
    }

    // Return the result
    res.json({
      success: true,
      parse_session_id: parseSessionId,
      files_uploaded: uploadedFiles.length,
      files_received: (req.files || []).length,
      has_whatsapp_text: !!whatsapp_text,
      existing_deal: existingDeal ? existingDeal.submission_id : null,
      parsed_data: parsedData || null, // The AI-extracted structured data
      message: parsedData
        ? 'Files parsed successfully. Please review the extracted data.'
        : 'Files uploaded. AI parsing is not configured — please fill in the deal details manually.'
    });
  } catch (error) {
    console.error('[smart-parse] Error:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
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
