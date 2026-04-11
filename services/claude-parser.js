/**
 * Claude Document Parser — calls Claude API directly from Render
 * Bypasses n8n for heavy document processing to avoid memory limits.
 *
 * Flow: Fetch docs from DB → Build Claude request → Call API → Parse response → Store results
 */

const config = require('../config');
const pool = require('../db/pool');
const { syncDealProperties } = require('./property-parser');

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;

// ── System prompt for deep extraction ──
const SYSTEM_PROMPT = `You are a deal data extraction AI for Daksfirst Limited, a UK bridging loan lender.
You will receive documents that have already been classified (classification labels are provided). Your job is to extract ALL relevant data from each document based on its type.

IMPORTANT BOUNDARIES — Claude fills factual data ONLY:
- DO extract: borrower details, property details, loan terms as stated, exit strategy, solicitor details, company details, existing charges, redemption figures, refurb costs, QS breakdowns, statement of works, planning refs, insurance
- DO NOT fill: arrangement fee %, broker fee %, interest rate, servicing type, commitment fee, security charge type, personal guarantee — these are commercial decisions for the RM

Return ONLY a valid JSON object with no other text, no markdown, no backticks.

JSON schema to populate:
{
  "borrowers": [
    {
      "full_name": "string or null",
      "date_of_birth": "YYYY-MM-DD or null",
      "nationality": "string or null",
      "email": "string or null",
      "phone": "string or null",
      "role": "primary or guarantor or director",
      "passport_number": "string or null",
      "passport_expiry": "YYYY-MM-DD or null",
      "source_document": "filename this was extracted from"
    }
  ],
  "company": {
    "name": "string or null",
    "company_number": "Companies House number or null",
    "registered_address": "string or null",
    "directors": "comma-separated names or null",
    "incorporation_date": "YYYY-MM-DD or null",
    "borrower_type": "individual or corporate or spv",
    "source_document": "filename"
  },
  "parsedProperties": [
    {
      "address": "full cleaned address without postcode",
      "postcode": "XX1 1XX — correctly formatted UK postcode",
      "market_value": 0,
      "purchase_price": 0,
      "property_type": "residential or commercial or mixed_use or hmo or mufb or land",
      "tenure": "freehold or leasehold or share_of_freehold",
      "title_number": "string or null",
      "occupancy_status": "vacant or tenanted or owner_occupied or null",
      "current_use": "string or null",
      "source_document": "filename"
    }
  ],
  "loan": {
    "loan_amount": 0,
    "ltv_requested": 0,
    "term_months": 0,
    "loan_purpose": "string or null",
    "exit_strategy": "string or null",
    "use_of_funds": "string or null",
    "rate_requested": 0,
    "interest_servicing": "retained or serviced or rolled_up or null",
    "existing_charges": "string or null",
    "deposit_source": "string or null"
  },
  "redemption": {
    "existing_lender": "string or null",
    "outstanding_balance": 0,
    "daily_interest": 0,
    "total_redemption_figure": 0,
    "early_repayment_charges": 0,
    "redemption_deadline": "YYYY-MM-DD or null",
    "source_document": "filename or null"
  },
  "refurbishment": {
    "total_refurb_cost": 0,
    "qs_firm": "string or null",
    "contingency_pct": 0,
    "gdv_estimate": 0,
    "build_timeline_months": 0,
    "cost_breakdown": [
      { "category": "string", "cost": 0 }
    ],
    "scope_of_works": "summary string or null",
    "contractor": "string or null",
    "source_document": "filename or null"
  },
  "solicitor": {
    "firm_name": "string or null",
    "solicitor_ref": "string or null",
    "contact_name": "string or null",
    "contact_email": "string or null",
    "contact_phone": "string or null",
    "source_document": "filename or null"
  },
  "insurance": {
    "reinstatement_value": 0,
    "insurer": "string or null",
    "policy_number": "string or null",
    "expiry_date": "YYYY-MM-DD or null",
    "source_document": "filename or null"
  },
  "planning": {
    "planning_ref": "string or null",
    "approval_status": "string or null",
    "conditions": "string or null",
    "permitted_use": "string or null",
    "source_document": "filename or null"
  },
  "broker": {
    "name": "string or null",
    "company": "string or null",
    "fca_number": "string or null",
    "email": "string or null",
    "phone": "string or null"
  },
  "notes": "any additional information that does not fit above fields",
  "confidence": 0.9,
  "extraction_summary": "one paragraph summarising what was extracted and what is still missing"
}

Rules:
- Extract monetary values as plain numbers (e.g. 500000 not 500,000)
- LTV should be a percentage number (e.g. 65 not 0.65)
- Rate should be monthly percentage (e.g. 0.95 for 0.95%/month)
- If a field cannot be determined from the documents, set it to null or 0
- For multiple properties, create a separate entry in parsedProperties for each
- Each property must have its own correctly matched UK postcode
- Track source_document so the broker can verify which document each data point came from
- Cross-reference data across documents: if the valuation report and broker pack both mention a property, reconcile the values
- Set confidence between 0 and 1 based on how much data you could reliably extract
- Include anything important in notes that does not fit other fields`;


/**
 * Build Claude content blocks from files
 */
function buildContentBlocks(files, dealContext, securityContext) {
  const contentParts = [];

  // Add deal context as text
  contentParts.push({
    type: 'text',
    text: `=== DEAL CONTEXT ===\nBorrower: ${dealContext.borrower_name || 'Unknown'}\nLoan: £${dealContext.loan_amount || 0}\nSecurity: ${securityContext.address || 'Unknown'}\nPostcode: ${securityContext.postcode || ''}\nExit: ${dealContext.exit_strategy || 'Unknown'}\nTerm: ${dealContext.loan_term_months || 0} months\nPurpose: ${dealContext.loan_purpose || 'Unknown'}\n`
  });

  let fileDescriptions = '';

  for (const file of files) {
    const ext = file.filename.toLowerCase().split('.').pop();

    // PDF → document block
    if (ext === 'pdf' && file.content_base64) {
      contentParts.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: file.content_base64
        }
      });
      fileDescriptions += `=== PDF: ${file.filename} [${file.doc_category || 'unclassified'}] (attached above) ===\n\n`;
    }
    // Images → image block
    else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) && file.content_base64) {
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeMap[ext] || 'image/jpeg',
          data: file.content_base64
        }
      });
      fileDescriptions += `=== IMAGE: ${file.filename} [${file.doc_category || 'unclassified'}] (attached above) ===\n\n`;
    }
    // Text → decode and include inline
    else if (['txt', 'csv', 'tsv'].includes(ext) && file.content_base64) {
      try {
        const decoded = Buffer.from(file.content_base64, 'base64').toString('utf-8');
        fileDescriptions += `=== FILE: ${file.filename} [${file.doc_category || 'unclassified'}] ===\n${decoded.substring(0, 50000)}\n\n`;
      } catch (e) {
        fileDescriptions += `=== FILE: ${file.filename} [${file.doc_category || 'unclassified'}] (could not decode) ===\n\n`;
      }
    }
    // Other → note it
    else {
      fileDescriptions += `=== FILE: ${file.filename} [${file.doc_category || 'unclassified'}] (${file.file_type || 'unknown format'}) ===\n\n`;
    }
  }

  // Add file descriptions as the final text block
  contentParts.push({
    type: 'text',
    text: fileDescriptions || 'Extract all deal data from the attached documents.'
  });

  return contentParts;
}


/**
 * Call Claude API directly
 */
async function callClaude(contentParts) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: contentParts
    }]
  };

  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'no body');
    throw new Error(`Claude API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textContent = data.content?.find(c => c.type === 'text')?.text || '';
  return textContent;
}


/**
 * Parse Claude's JSON response (handles markdown fences, partial JSON)
 */
function parseClaudeResponse(rawText) {
  let cleaned = rawText.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}


/**
 * Deduplicate properties by postcode + normalised address.
 * When duplicates exist, keep the one with the most populated fields.
 */
function deduplicateProperties(properties) {
  if (!Array.isArray(properties) || properties.length === 0) return properties;

  const normalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const scoreProperty = (p) => {
    let score = 0;
    if (p.market_value && p.market_value > 0) score += 3;
    if (p.purchase_price && p.purchase_price > 0) score += 2;
    if (p.tenure) score += 1;
    if (p.property_type) score += 1;
    if (p.title_number) score += 1;
    if (p.occupancy_status) score += 1;
    if (p.current_use) score += 1;
    return score;
  };

  const seen = new Map(); // key → best property
  for (const prop of properties) {
    // Build a dedup key from postcode + first meaningful part of address
    const pc = normalize(prop.postcode);
    const addr = normalize(prop.address).substring(0, 30); // first 30 normalised chars
    const key = `${pc}::${addr}`;

    const existing = seen.get(key);
    if (!existing || scoreProperty(prop) > scoreProperty(existing)) {
      seen.set(key, prop);
    }
  }

  return Array.from(seen.values());
}


/**
 * Deduplicate borrowers by normalised full_name
 */
function deduplicateBorrowers(borrowers) {
  if (!Array.isArray(borrowers) || borrowers.length === 0) return borrowers;
  const seen = new Map();
  for (const b of borrowers) {
    const key = (b.full_name || '').toLowerCase().trim();
    if (!key) continue;
    const existing = seen.get(key);
    // Keep the one with more fields populated
    if (!existing || Object.values(b).filter(v => v !== null).length > Object.values(existing).filter(v => v !== null).length) {
      seen.set(key, b);
    }
  }
  return Array.from(seen.values());
}


/**
 * Merge batch results into existing analysis
 */
function mergeAnalysis(existing, incoming) {
  const merged = { ...existing };

  // Append arrays (deduplication happens after all batches)
  for (const arrKey of ['borrowers', 'parsedProperties']) {
    if (Array.isArray(incoming[arrKey]) && incoming[arrKey].length > 0) {
      merged[arrKey] = [...(merged[arrKey] || []), ...incoming[arrKey]];
    }
  }

  // Merge objects: fill null/zero/undefined values
  for (const objKey of ['company', 'loan', 'redemption', 'refurbishment', 'solicitor', 'insurance', 'planning', 'broker']) {
    if (incoming[objKey] && typeof incoming[objKey] === 'object') {
      merged[objKey] = merged[objKey] || {};
      for (const [k, v] of Object.entries(incoming[objKey])) {
        if (v !== null && v !== 0 && v !== '' && (merged[objKey][k] === null || merged[objKey][k] === 0 || merged[objKey][k] === undefined)) {
          merged[objKey][k] = v;
        }
      }
    }
  }

  // Append notes
  if (incoming.notes && incoming.notes !== 'null') {
    merged.notes = merged.notes ? merged.notes + '\n' + incoming.notes : incoming.notes;
  }

  // Higher confidence wins
  if (incoming.confidence && (!merged.confidence || incoming.confidence > merged.confidence)) {
    merged.confidence = incoming.confidence;
  }

  // Append extraction summaries
  if (incoming.extraction_summary) {
    merged.extraction_summary = merged.extraction_summary
      ? merged.extraction_summary + ' | ' + incoming.extraction_summary
      : incoming.extraction_summary;
  }

  return merged;
}


/**
 * Main parse function — fetches docs, batches, calls Claude, stores results
 * Runs as a background async task (fire-and-forget from the endpoint)
 */
async function parseDealDocuments(submissionId, dealId, dealContext, securityContext) {
  const startTime = Date.now();

  // ── Progress helper — writes live status to DB so the frontend can poll it ──
  const steps = [];
  async function updateProgress(stage, message, detail) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const entry = { stage, message, elapsed: `${elapsed}s`, ts: new Date().toISOString() };
    if (detail) entry.detail = detail;
    steps.push(entry);
    const progress = { status: 'running', current_stage: stage, message, elapsed_seconds: parseFloat(elapsed), steps };
    try {
      await pool.query(
        `UPDATE deal_submissions SET parse_progress = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [dealId, JSON.stringify(progress)]
      );
    } catch (e) { /* don't let progress-write failures kill the parse */ }
    console.log(`[claude-parser] [${elapsed}s] ${message}`);
  }

  try {
    await updateProgress('starting', 'Starting document parse...');

    // ── 1. Fetch all documents from DB ──
    await updateProgress('fetching', 'Fetching documents from database...');
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_content, doc_category
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at ASC`,
      [dealId]
    );

    // ── 2. Deduplicate and encode ──
    await updateProgress('encoding', `Encoding ${docsResult.rows.length} documents...`);
    const seenNames = new Set();
    const allFiles = [];
    for (const doc of docsResult.rows) {
      if (seenNames.has(doc.filename)) continue;
      seenNames.add(doc.filename);
      if (!doc.file_content) continue;

      allFiles.push({
        filename: doc.filename,
        file_type: doc.file_type || 'application/octet-stream',
        doc_category: doc.doc_category || null,
        content_base64: Buffer.from(doc.file_content).toString('base64')
      });
    }

    await updateProgress('encoded', `${allFiles.length} unique documents ready`, allFiles.map(f => f.filename));

    if (allFiles.length === 0) {
      await updateProgress('error', 'No documents with content found');
      return { success: false, reason: 'no_documents' };
    }

    // ── 3. Split into batches (~5MB base64 each, safe for Claude API) ──
    const MAX_BATCH_B64 = 5 * 1024 * 1024;
    const batches = [];
    let currentBatch = [];
    let currentSize = 0;

    for (const file of allFiles) {
      const fileSize = file.content_base64.length;

      if (fileSize > MAX_BATCH_B64) {
        // Oversized file goes alone
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentSize = 0;
        }
        batches.push([file]);
        continue;
      }

      if (currentSize + fileSize > MAX_BATCH_B64) {
        batches.push(currentBatch);
        currentBatch = [];
        currentSize = 0;
      }

      currentBatch.push(file);
      currentSize += fileSize;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    await updateProgress('batching', `Split into ${batches.length} batch(es)`,
      batches.map((b, i) => `Batch ${i+1}: ${b.length} files (${b.map(f => f.filename).join(', ')})`));

    // ── 4. Process each batch through Claude ──
    let mergedAnalysis = {};
    let totalProperties = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchFiles = batch.map(f => f.filename);
      await updateProgress(`batch_${i+1}_sending`, `Sending batch ${i + 1}/${batches.length} to Claude (${batch.length} files)`, batchFiles);

      try {
        const contentParts = buildContentBlocks(batch, dealContext, securityContext);
        const rawResponse = await callClaude(contentParts);
        const parsed = parseClaudeResponse(rawResponse);

        if (i === 0) {
          mergedAnalysis = parsed;
        } else {
          mergedAnalysis = mergeAnalysis(mergedAnalysis, parsed);
        }

        const batchProps = parsed.parsedProperties?.length || 0;
        const batchBorrowers = parsed.borrowers?.length || 0;
        totalProperties += batchProps;
        await updateProgress(`batch_${i+1}_done`, `Batch ${i + 1} complete — found ${batchProps} properties, ${batchBorrowers} borrowers`, {
          properties: batchProps, borrowers: batchBorrowers, confidence: parsed.confidence
        });
      } catch (batchErr) {
        await updateProgress(`batch_${i+1}_error`, `Batch ${i + 1} failed: ${batchErr.message}`);
        // Continue with remaining batches
      }
    }

    // ── 5. Deduplicate across batches ──
    await updateProgress('deduplicating', 'Deduplicating extracted data...');
    if (mergedAnalysis.parsedProperties) {
      const before = mergedAnalysis.parsedProperties.length;
      mergedAnalysis.parsedProperties = deduplicateProperties(mergedAnalysis.parsedProperties);
      const after = mergedAnalysis.parsedProperties.length;
      if (before !== after) await updateProgress('dedup_properties', `Deduped properties: ${before} → ${after}`);
      totalProperties = after;
    }
    if (mergedAnalysis.borrowers) {
      const before = mergedAnalysis.borrowers.length;
      mergedAnalysis.borrowers = deduplicateBorrowers(mergedAnalysis.borrowers);
      const after = mergedAnalysis.borrowers.length;
      if (before !== after) await updateProgress('dedup_borrowers', `Deduped borrowers: ${before} → ${after}`);
    }

    // ── 6. Store results ──
    await updateProgress('storing', 'Saving extracted data to database...');
    const analysisJson = JSON.stringify(mergedAnalysis);

    // Store in analysis_results
    await pool.query(
      `INSERT INTO analysis_results (deal_id, analysis_json)
       VALUES ($1, $2)
       ON CONFLICT (deal_id) DO UPDATE SET
         analysis_json = EXCLUDED.analysis_json,
         completed_at = NOW()`,
      [dealId, analysisJson]
    );

    // ── 6a. Store parsed properties ──
    if (mergedAnalysis.parsedProperties && Array.isArray(mergedAnalysis.parsedProperties) && mergedAnalysis.parsedProperties.length > 0) {
      const claudeProperties = mergedAnalysis.parsedProperties.map(p => ({
        address: p.address || '',
        postcode: p.postcode || null,
        market_value: p.market_value ? parseFloat(p.market_value) : null,
        purchase_price: p.purchase_price ? parseFloat(p.purchase_price) : null,
        property_type: p.property_type || null,
        tenure: p.tenure || null,
        source: 'claude_parsed'
      }));
      await syncDealProperties(pool, dealId, claudeProperties, { force: true });
      await updateProgress('wrote_properties', `Saved ${claudeProperties.length} properties to database`);
    }

    // ── 6b. Write borrowers to deal_borrowers table ──
    if (mergedAnalysis.borrowers && Array.isArray(mergedAnalysis.borrowers) && mergedAnalysis.borrowers.length > 0) {
      // Clear old claude-parsed borrowers, then insert fresh
      await pool.query(`DELETE FROM deal_borrowers WHERE deal_id = $1 AND kyc_status = 'pending'`, [dealId]);
      for (const b of mergedAnalysis.borrowers) {
        if (!b.full_name) continue;
        await pool.query(
          `INSERT INTO deal_borrowers (deal_id, full_name, date_of_birth, nationality, email, phone, role, borrower_type, company_name, company_number, kyc_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
           ON CONFLICT DO NOTHING`,
          [dealId, b.full_name, b.date_of_birth || null, b.nationality || null,
           b.email || null, b.phone || null, b.role || 'primary',
           mergedAnalysis.company?.borrower_type || 'individual',
           mergedAnalysis.company?.name || null, mergedAnalysis.company?.company_number || null]
        );
      }
      // Update primary borrower on deal_submissions
      const primary = mergedAnalysis.borrowers.find(b => b.role === 'primary') || mergedAnalysis.borrowers[0];
      if (primary) {
        await pool.query(
          `UPDATE deal_submissions SET
             borrower_name = COALESCE(NULLIF($2, ''), borrower_name),
             borrower_email = COALESCE(NULLIF($3, ''), borrower_email),
             borrower_phone = COALESCE(NULLIF($4, ''), borrower_phone),
             borrower_dob = COALESCE($5, borrower_dob),
             borrower_nationality = COALESCE(NULLIF($6, ''), borrower_nationality),
             updated_at = NOW()
           WHERE id = $1`,
          [dealId, primary.full_name || '', primary.email || '', primary.phone || '',
           primary.date_of_birth || null, primary.nationality || '']
        );
      }
      await updateProgress('wrote_borrowers', `Saved ${mergedAnalysis.borrowers.length} borrowers`, mergedAnalysis.borrowers.map(b => b.full_name));
    }

    // ── 6c. Write company details ──
    if (mergedAnalysis.company && mergedAnalysis.company.name) {
      await pool.query(
        `UPDATE deal_submissions SET
           company_name = COALESCE(NULLIF($2, ''), company_name),
           company_number = COALESCE(NULLIF($3, ''), company_number),
           borrower_type = COALESCE(NULLIF($4, ''), borrower_type),
           borrower_company = COALESCE(NULLIF($2, ''), borrower_company),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, mergedAnalysis.company.name || '', mergedAnalysis.company.company_number || '',
         mergedAnalysis.company.borrower_type || '']
      );
      await updateProgress('wrote_company', `Saved company: ${mergedAnalysis.company.name}`);
    }

    // ── 6d. Write loan terms ──
    if (mergedAnalysis.loan) {
      const l = mergedAnalysis.loan;
      await pool.query(
        `UPDATE deal_submissions SET
           loan_amount = COALESCE(NULLIF($2, 0), loan_amount),
           ltv_requested = COALESCE(NULLIF($3, 0), ltv_requested),
           term_months = COALESCE(NULLIF($4, 0), term_months),
           loan_purpose = COALESCE(NULLIF($5, ''), loan_purpose),
           exit_strategy = COALESCE(NULLIF($6, ''), exit_strategy),
           use_of_funds = COALESCE(NULLIF($7, ''), use_of_funds),
           interest_servicing = COALESCE(NULLIF($8, ''), interest_servicing),
           existing_charges = COALESCE(NULLIF($9, ''), existing_charges),
           deposit_source = COALESCE(NULLIF($10, ''), deposit_source),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, l.loan_amount || 0, l.ltv_requested || 0, l.term_months || 0,
         l.loan_purpose || '', l.exit_strategy || '', l.use_of_funds || '',
         l.interest_servicing || '', l.existing_charges || '', l.deposit_source || '']
      );
      await updateProgress('wrote_loan', `Saved loan terms: £${l.loan_amount || 0}, ${l.term_months || 0} months`);
    }

    // ── 6e. Write solicitor details ──
    if (mergedAnalysis.solicitor && mergedAnalysis.solicitor.firm_name) {
      await pool.query(
        `UPDATE deal_submissions SET
           lawyer_firm = COALESCE(NULLIF($2, ''), lawyer_firm),
           lawyer_email = COALESCE(NULLIF($3, ''), lawyer_email),
           lawyer_contact = COALESCE(NULLIF($4, ''), lawyer_contact),
           lawyer_reference = COALESCE(NULLIF($5, ''), lawyer_reference),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, mergedAnalysis.solicitor.firm_name || '', mergedAnalysis.solicitor.contact_email || '',
         mergedAnalysis.solicitor.contact_name || '', mergedAnalysis.solicitor.solicitor_ref || '']
      );
      await updateProgress('wrote_solicitor', `Saved solicitor: ${mergedAnalysis.solicitor.firm_name}`);
    }

    // ── 6f. Write refurbishment details ──
    if (mergedAnalysis.refurbishment && mergedAnalysis.refurbishment.total_refurb_cost > 0) {
      await pool.query(
        `UPDATE deal_submissions SET
           refurb_cost = COALESCE(NULLIF($2, 0), refurb_cost),
           refurb_scope = COALESCE(NULLIF($3, ''), refurb_scope),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, mergedAnalysis.refurbishment.total_refurb_cost || 0,
         mergedAnalysis.refurbishment.scope_of_works || '']
      );
      await updateProgress('wrote_refurb', `Saved refurb: £${mergedAnalysis.refurbishment.total_refurb_cost}`);
    }

    // ── 6g. Write broker details ──
    if (mergedAnalysis.broker && mergedAnalysis.broker.name) {
      await pool.query(
        `UPDATE deal_submissions SET
           broker_name = COALESCE(NULLIF($2, ''), broker_name),
           broker_company = COALESCE(NULLIF($3, ''), broker_company),
           broker_fca = COALESCE(NULLIF($4, ''), broker_fca),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, mergedAnalysis.broker.name || '', mergedAnalysis.broker.company || '',
         mergedAnalysis.broker.fca_number || '']
      );
      await updateProgress('wrote_broker', `Saved broker: ${mergedAnalysis.broker.name}`);
    }

    // ── 6h. Store redemption, insurance, planning in matrix_data JSONB ──
    const matrixExtras = {};
    if (mergedAnalysis.redemption && (mergedAnalysis.redemption.existing_lender || mergedAnalysis.redemption.outstanding_balance > 0)) {
      matrixExtras.redemption = mergedAnalysis.redemption;
    }
    if (mergedAnalysis.insurance && (mergedAnalysis.insurance.insurer || mergedAnalysis.insurance.reinstatement_value > 0)) {
      matrixExtras.insurance = mergedAnalysis.insurance;
    }
    if (mergedAnalysis.planning && (mergedAnalysis.planning.planning_ref || mergedAnalysis.planning.approval_status)) {
      matrixExtras.planning = mergedAnalysis.planning;
    }
    if (Object.keys(matrixExtras).length > 0) {
      await pool.query(
        `UPDATE deal_submissions SET
           matrix_data = COALESCE(matrix_data, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, JSON.stringify(matrixExtras)]
      );
      await updateProgress('wrote_extras', `Saved: ${Object.keys(matrixExtras).join(', ')}`);
    }

    // Build summary of what was extracted
    const summary = [];
    if (totalProperties > 0) summary.push(`${totalProperties} properties`);
    if (mergedAnalysis.borrowers?.length) summary.push(`${mergedAnalysis.borrowers.length} borrowers`);
    if (mergedAnalysis.company?.name) summary.push(`company: ${mergedAnalysis.company.name}`);
    if (mergedAnalysis.loan?.loan_amount) summary.push(`loan: £${mergedAnalysis.loan.loan_amount.toLocaleString()}`);
    if (mergedAnalysis.solicitor?.firm_name) summary.push(`solicitor: ${mergedAnalysis.solicitor.firm_name}`);
    if (mergedAnalysis.broker?.name) summary.push(`broker: ${mergedAnalysis.broker.name}`);
    if (mergedAnalysis.refurbishment?.total_refurb_cost > 0) summary.push(`refurb: £${mergedAnalysis.refurbishment.total_refurb_cost.toLocaleString()}`);

    // Final progress — mark complete
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalProgress = {
      status: 'complete',
      current_stage: 'done',
      message: `Extraction complete — ${summary.join(', ')}`,
      elapsed_seconds: parseFloat(elapsed),
      confidence: mergedAnalysis.confidence,
      summary,
      steps
    };
    await pool.query(
      `UPDATE deal_submissions SET
         parse_progress = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [dealId, JSON.stringify(finalProgress)]
    );

    console.log(`[claude-parser] Done in ${elapsed}s — ${summary.join(', ')}`);
    return { success: true, properties: totalProperties, confidence: mergedAnalysis.confidence, elapsed };

  } catch (error) {
    console.error(`[claude-parser] Deal ${submissionId} failed:`, error);
    // Write error to progress so frontend can show it
    try {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      await pool.query(
        `UPDATE deal_submissions SET parse_progress = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [dealId, JSON.stringify({ status: 'error', message: error.message, elapsed_seconds: parseFloat(elapsed), steps })]
      );
    } catch (e) { /* ignore */ }
    return { success: false, error: error.message };
  }
}

module.exports = { parseDealDocuments };
