/**
 * AI Document Data Extraction Service
 * Reads uploaded documents per onboarding section and extracts structured data
 * to auto-fill form fields using Claude.
 */

const Anthropic = require('@anthropic-ai/sdk');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (e) {}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

/**
 * Extract text from PDF buffer (first 5 pages for extraction — need more detail than categorisation)
 */
async function extractPdfText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer, { max: 5 });
    return data.text ? data.text.substring(0, 6000) : null;
  } catch (err) {
    console.error('[ai-extract] PDF parse error:', err.message);
    return null;
  }
}

/**
 * Section-specific extraction schemas — maps section to field IDs and extraction prompt
 */
const SECTION_SCHEMAS = {
  kyc: {
    systemPrompt: `You are a KYC data extraction specialist for a UK bridging loan lender. Extract identity and personal information from the provided documents. Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find.`,
    fields: {
      'kyc-full-name': 'Full legal name as shown on passport or ID document',
      'kyc-dob': 'Date of birth in YYYY-MM-DD format',
      'kyc-ni-number': 'UK National Insurance Number (format: XX 99 99 99 X)',
      'kyc-nationality': 'Nationality as stated on passport',
      'kyc-country-birth': 'Country of birth',
      'kyc-current-address': 'Current residential address including postcode',
      'kyc-address-history': 'Previous addresses for last 3 years with approximate dates',
      'kyc-pep': 'PEP status: "no" if not a PEP, "yes" if PEP or connected to PEP. Default to empty string if not stated.',
      'kyc-source-wealth': 'Source of wealth narrative — how wealth was accumulated',
      'kyc-source-deposit': 'Source of deposit / equity for this transaction',
      'kyc-ubo-declaration': 'UBO details — names and percentage holdings of individuals with 25%+ interest',
      'doc-issue-date': 'Issue date of the passport or ID document in YYYY-MM-DD format. Use null if not found.',
      'doc-expiry-date': 'Expiry date of the passport or ID document in YYYY-MM-DD format. Use null if not found.'
    }
  },

  financials_aml: {
    systemPrompt: `You are a financial data extraction specialist for a UK bridging loan lender. Extract financial details, bank statement summaries, and AML information from the provided documents. Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find.`,
    fields: {
      'fin-credit-consent': 'Credit search consent: "yes" or "no". Default empty string if not stated.',
      'fin-adverse': 'Adverse credit: "none", "ccj", "iva", "bankruptcy_discharged", "defaults", or "other". Default empty string.',
      'fin-mortgage-schedule': 'Existing mortgages: lender name, outstanding balance, monthly payment for each',
      'aml-source-wealth': 'Source of wealth narrative — employment history, business, inheritance, investments',
      'aml-pep': 'PEP/sanctions status: "clear", "pep_domestic", or "pep_foreign". Default empty string.',
      'aml-utr': 'HMRC Unique Taxpayer Reference number if found',
      'aml-tax-residency': 'Tax residency: "uk_resident" or "non_uk". Default empty string.',
      'aml-broker-ack': 'AML acknowledgement status. Default empty string.',
      'aml-conflicts': 'Any conflicts of interest declared, or "None"',
      'doc-issue-date': 'Statement date, period end date, or tax return year-end date in YYYY-MM-DD format. For bank statements use the most recent statement date. Use null if not found.',
      'doc-expiry-date': 'Date after which this document is considered stale (e.g. bank statements older than 3 months). If not explicitly stated, use null.'
    }
  },

  valuation: {
    systemPrompt: `You are a property valuation data extraction specialist for a UK bridging loan lender. Extract valuation figures, title details, and solicitor information from the provided documents (RICS valuations, title registers, land registry docs). Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find. All monetary values should be numbers only (no £ or commas).`,
    fields: {
      'val-day1-value': 'Current market value (Day 1 value) from RICS valuation — number only',
      'val-reinstatement': 'Reinstatement / insurance rebuild value — number only',
      'val-gdv': 'Gross Development Value (post-works value) if stated — number only',
      'val-90day': '90-day forced sale value if stated — number only',
      'val-180day': '180-day forced sale value if stated — number only',
      'val-solicitor-firm': 'Borrower solicitor firm name',
      'val-sra-number': 'SRA number of the solicitor firm',
      'val-solicitor-partner': 'Name of the supervising partner at the solicitor firm',
      'doc-issue-date': 'Date of the valuation report or inspection date in YYYY-MM-DD format. Use null if not found.',
      'doc-expiry-date': 'Valuation validity expiry date in YYYY-MM-DD format. RICS valuations are typically valid for 3-6 months from the report date. If an explicit expiry is stated use that, otherwise use null.'
    }
  },

  use_of_funds: {
    systemPrompt: `You are a use-of-funds data extraction specialist for a UK bridging loan lender. Extract redemption figures, refurbishment costs, contractor details, and schedule of costs from the provided documents. Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find. All monetary values should be numbers only (no £ or commas).`,
    fields: {
      'uof-schedule-costs': 'Itemised breakdown of costs: purchase price, stamp duty, legal fees, broker fees, refurb costs, retained interest, etc.',
      'refurb-contractor-name': 'Main contractor name',
      'refurb-contractor-accred': 'Contractor accreditations (NICEIC, Gas Safe, etc.)',
      'refurb-day1': 'Pre-works Day 1 value — number only',
      'refurb-gdv': 'Post-works GDV — number only',
      'refurb-monitoring': 'Monitoring surveyor name and firm if stated'
    }
  },

  exit_evidence: {
    systemPrompt: `You are an exit strategy data extraction specialist for a UK bridging loan lender. Extract exit strategy details from the provided documents (AIPs, sale contracts, estate agent valuations, rental schedules). Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find.`,
    fields: {
      'exit-narrative': 'Detailed exit strategy narrative: how and when the loan will be repaid, including lender names, sale prices, rental yields, or refinance terms as applicable'
    }
  },

  other_conditions: {
    systemPrompt: `You are a conditions data extraction specialist for a UK bridging loan lender. Extract insurance details, Section 106 information, and planning conditions from the provided documents. Return ONLY a JSON object with the following field IDs as keys. Use null for any field you cannot find. Monetary values should be numbers only.`,
    fields: {
      'ins-sum-insured': 'Sum insured on buildings insurance policy — number only',
      'oc-other-notes': 'Any notable conditions, restrictions, or requirements found in the documents',
      'doc-issue-date': 'Issue date or effective date of the document (e.g. insurance policy start date) in YYYY-MM-DD format. Use null if not found.',
      'doc-expiry-date': 'Expiry or renewal date of the document (e.g. insurance policy expiry) in YYYY-MM-DD format. Use null if not found.'
    }
  }
};

/**
 * Extract structured data from documents for a given section
 * @param {string} section - The onboarding section key (e.g. 'kyc', 'financials_aml')
 * @param {Array} documents - Array of { filename, buffer } objects
 * @returns {Object} - Extracted data keyed by form field IDs
 */
async function extractSectionData(section, documents) {
  if (!ANTHROPIC_API_KEY) {
    console.log('[ai-extract] No ANTHROPIC_API_KEY — cannot extract');
    return null;
  }

  const schema = SECTION_SCHEMAS[section];
  if (!schema) {
    console.log('[ai-extract] No schema for section:', section);
    return null;
  }

  // Extract text from all documents in this section
  const docTexts = [];
  for (const doc of documents) {
    if (!doc.buffer) continue;
    const mime = (doc.file_type || '').toLowerCase();
    const name = (doc.filename || '').toLowerCase();

    let text = null;
    if (mime === 'application/pdf' || name.endsWith('.pdf')) {
      text = await extractPdfText(doc.buffer);
    } else if (mime === 'text/plain' || name.endsWith('.txt') || name.endsWith('.csv')) {
      text = doc.buffer.toString('utf-8').substring(0, 4000);
    }

    if (text && text.trim().length > 20) {
      docTexts.push(`=== Document: ${doc.filename} ===\n${text}`);
    }
  }

  if (docTexts.length === 0) {
    console.log('[ai-extract] No extractable text for section:', section);
    return null;
  }

  // Build the field description for the prompt
  const fieldDesc = Object.entries(schema.fields)
    .map(([id, desc]) => `  "${id}": "${desc}"`)
    .join(',\n');

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: schema.systemPrompt + `\n\nExpected JSON fields:\n{\n${fieldDesc}\n}\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no backticks, no explanation. Just the JSON object.`,
      messages: [{
        role: 'user',
        content: `Extract data from these ${docTexts.length} document(s):\n\n${docTexts.join('\n\n')}`
      }]
    });

    const responseText = (message.content[0]?.text || '').trim();

    // Parse JSON — strip any markdown backticks if present
    const jsonStr = responseText.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const extracted = JSON.parse(jsonStr);

    // Filter out null values and validate field IDs
    const validFields = Object.keys(schema.fields);
    const result = {};
    for (const [key, value] of Object.entries(extracted)) {
      if (validFields.includes(key) && value !== null && value !== undefined && value !== '') {
        result[key] = String(value);
      }
    }

    console.log(`[ai-extract] Extracted ${Object.keys(result).length} fields for section: ${section}`);
    return result;
  } catch (err) {
    console.error('[ai-extract] Claude API error:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// DEAL-LEVEL EXTRACTION — extract Matrix fields from documents
// Used as fallback when n8n is not configured
// ═══════════════════════════════════════════════════════════════

const DEAL_EXTRACTION_PROMPT = `You are Daksfirst's document data extraction engine. You are given the text content of one or more documents uploaded for a UK bridging loan deal.

Extract every deal-relevant field you can find and return ONLY a JSON object with these keys (use null for fields you cannot find):

{
  "borrower_name": "full name of the borrower / applicant",
  "borrower_email": "email address",
  "borrower_phone": "phone number",
  "borrower_dob": "date of birth (YYYY-MM-DD)",
  "borrower_nationality": "nationality",
  "borrower_type": "individual or corporate",
  "company_name": "company name if corporate borrower",
  "company_number": "Companies House number",
  "security_address": "full property address being used as security",
  "security_postcode": "postcode of the property",
  "asset_type": "residential, commercial, mixed_use, land_with_planning, hmo, semi_commercial",
  "property_tenure": "freehold or leasehold",
  "occupancy_status": "vacant, tenanted, owner_occupied",
  "current_use": "description of current use",
  "current_value": "current market value (number only, no currency symbol)",
  "purchase_price": "purchase price (number only)",
  "loan_amount": "loan amount requested (number only)",
  "ltv_requested": "LTV percentage (number only)",
  "term_months": "loan term in months (number only)",
  "rate_requested": "interest rate per month as percentage (number only)",
  "interest_servicing": "rolled_up, serviced, or retained",
  "loan_purpose": "bridge, refurbishment, acquisition, refinance, auction, development_exit",
  "use_of_funds": "description of how funds will be used",
  "refurb_scope": "description of refurbishment works if applicable",
  "refurb_cost": "refurbishment cost (number only)",
  "exit_strategy": "how the borrower plans to repay - sale, refinance, development_sale",
  "deposit_source": "source of the deposit or equity",
  "existing_charges": "details of any existing charges on the property",
  "additional_notes": "any other relevant information",
  "broker_name": "FINANCE BROKER / MORTGAGE INTERMEDIARY name only — NOT estate agents, NOT valuers, NOT solicitors. null if no finance broker found",
  "broker_company": "finance brokerage firm name only — NOT estate agency, NOT surveyor firm. null if no finance broker found",
  "broker_fca": "FCA number of the finance broker. null if not found",
  "doc_issue_date": "issue date or effective date of this document in YYYY-MM-DD format (e.g. passport issue date, valuation date, statement date, policy start date)",
  "doc_expiry_date": "expiry date of this document in YYYY-MM-DD format (e.g. passport expiry, valuation validity, insurance renewal date). Use null if no expiry applies.",
  "confidence": 0.85
}

RULES:
- Return ONLY valid JSON, no markdown, no explanation
- For currency values (current_value, purchase_price, loan_amount, refurb_cost), return the NUMBER only — strip £ signs and commas
- For percentage values (ltv_requested, rate_requested), return the NUMBER only
- Set "confidence" to a decimal between 0.0 and 1.0 reflecting how confident you are in the overall extraction
- Be thorough — extract every field possible from the available text
- BROKER: Only populate broker_name/broker_company/broker_fca if someone is explicitly a FINANCE BROKER or MORTGAGE INTERMEDIARY. Estate agents (Foxtons, Savills, Fletchers, Knight Frank etc), valuers/surveyors, and solicitors are NOT brokers — leave broker fields null if no finance broker is mentioned`;

/**
 * Extract deal fields from a single document's text content
 * @param {Buffer} buffer - file content
 * @param {string} mimetype - file MIME type
 * @param {string} filename - original filename
 * @param {string} docCategory - confirmed category (kyc, financial, property, etc.)
 * @returns {Object|null} - extracted fields JSON or null
 */
async function extractDealFieldsFromDocument(buffer, mimetype, filename, docCategory) {
  if (!ANTHROPIC_API_KEY) {
    console.log('[ai-extract] No ANTHROPIC_API_KEY — cannot extract');
    return null;
  }

  // Ensure we have a proper Buffer
  if (!buffer) {
    console.log(`[ai-extract] No buffer for "${filename}" — skipping`);
    return null;
  }
  if (!Buffer.isBuffer(buffer)) {
    console.log(`[ai-extract] Converting non-Buffer (${typeof buffer}) to Buffer for "${filename}"`);
    try {
      buffer = Buffer.from(buffer);
    } catch (e) {
      console.error(`[ai-extract] Cannot convert to Buffer for "${filename}":`, e.message);
      return null;
    }
  }
  console.log(`[ai-extract] Processing "${filename}" — type: ${mimetype}, size: ${buffer.length} bytes, category: ${docCategory}`);

  if (buffer.length === 0) {
    console.log(`[ai-extract] Empty buffer for "${filename}" — skipping`);
    return null;
  }

  const mime = (mimetype || '').toLowerCase();
  const name = (filename || '').toLowerCase();
  let text = null;

  // PDF extraction
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    console.log(`[ai-extract] Attempting PDF text extraction for "${filename}"...`);
    text = await extractPdfText(buffer);
    console.log(`[ai-extract] PDF extraction result: ${text ? text.length + ' chars' : 'null'}`);
  }
  // Plain text / CSV
  else if (mime === 'text/plain' || name.endsWith('.txt') || name.endsWith('.csv')) {
    text = buffer.toString('utf-8').substring(0, 6000);
  }
  // Word docs — try to extract as UTF-8 (crude but catches some data)
  else if (mime.includes('word') || mime.includes('openxmlformats-officedocument') || name.endsWith('.docx') || name.endsWith('.doc')) {
    console.log(`[ai-extract] Word doc detected: "${filename}" — extracting raw text strings`);
    // Extract readable strings from docx XML (crude but effective for data extraction)
    const raw = buffer.toString('utf-8');
    // Pull text between XML tags
    const textParts = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    if (textParts) {
      text = textParts.map(t => t.replace(/<[^>]+>/g, '')).join(' ').substring(0, 6000);
      console.log(`[ai-extract] Extracted ${text.length} chars from Word doc XML`);
    }
  }
  // Images — we can't extract text without OCR, but try Claude vision if small enough
  else if (mime.startsWith('image/')) {
    console.log(`[ai-extract] Image file "${filename}" — will try Claude vision API`);
    // Use Claude's vision capability to read the image directly
    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const base64 = buffer.toString('base64');
      const mediaType = mime.includes('png') ? 'image/png' : mime.includes('gif') ? 'image/gif' : mime.includes('webp') ? 'image/webp' : 'image/jpeg';

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: DEAL_EXTRACTION_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Document: "${filename}"\nCategory: ${docCategory || 'unknown'}\n\nExtract all deal-relevant fields from this document image.` }
          ]
        }]
      });

      const raw = (message.content[0]?.text || '').trim();
      let jsonStr = raw;
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(jsonStr);
      console.log(`[ai-extract] Vision extracted ${Object.keys(parsed).filter(k => parsed[k] != null && parsed[k] !== '' && k !== 'confidence').length} fields from image "${filename}"`);
      return parsed;
    } catch (visErr) {
      console.error(`[ai-extract] Vision extraction failed for "${filename}":`, visErr.message);
      return null;
    }
  }

  // If still no text, try brute-force UTF-8 extraction (catches some non-standard formats)
  if (!text && !mime.startsWith('image/')) {
    console.log(`[ai-extract] Trying brute-force UTF-8 extraction for "${filename}" (mime: ${mime})`);
    const raw = buffer.toString('utf-8');
    // Strip non-printable characters and keep only readable text
    const cleaned = raw.replace(/[^\x20-\x7E\n\r\t£€]/g, ' ').replace(/\s{3,}/g, ' ').trim();
    if (cleaned.length > 50) {
      text = cleaned.substring(0, 6000);
      console.log(`[ai-extract] Brute-force extracted ${text.length} chars`);
    }
  }

  if (!text || text.trim().length < 20) {
    console.log(`[ai-extract] Not enough text from "${filename}" (${text ? text.trim().length : 0} chars) — skipping`);
    return null;
  }

  console.log(`[ai-extract] Sending ${text.length} chars to Claude for "${filename}"...`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: DEAL_EXTRACTION_PROMPT,
      messages: [{
        role: 'user',
        content: `Document: "${filename}"\nCategory: ${docCategory || 'unknown'}\n\n--- DOCUMENT TEXT ---\n${text}`
      }]
    });

    const raw = (message.content[0]?.text || '').trim();
    let jsonStr = raw;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    const fieldCount = Object.keys(parsed).filter(k => parsed[k] != null && parsed[k] !== '' && k !== 'confidence').length;
    console.log(`[ai-extract] Extracted ${fieldCount} deal fields from "${filename}"`);
    return parsed;
  } catch (err) {
    console.error(`[ai-extract] Deal extraction error for "${filename}":`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// DEAL STRUCTURE vs SUPPORTING EVIDENCE
// ═══════════════════════════════════════════════════════════════
// Core structure fields define the deal identity — they get set once
// from the primary deal document (broker pack, application form, legal doc)
// and should NOT be overwritten by supporting evidence (bank statements, etc.)
const CORE_STRUCTURE_FIELDS = [
  'borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone',
  'borrower_dob', 'borrower_nationality',
  'company_name', 'company_number',
  'security_address', 'security_postcode',
  'asset_type', 'property_tenure',
  'loan_purpose'
];

// Evidence fields can be refined/updated by any doc — they get better
// with more data (valuations, statements, etc.)
const EVIDENCE_FIELDS = [
  'current_value', 'purchase_price', 'loan_amount', 'ltv_requested',
  'term_months', 'rate_requested', 'interest_servicing',
  'occupancy_status', 'current_use',
  'use_of_funds', 'refurb_scope', 'refurb_cost',
  'exit_strategy', 'deposit_source', 'existing_charges',
  'additional_notes',
  'broker_name', 'broker_company', 'broker_fca'
];

/**
 * Category priority for field groups — higher number = higher priority.
 * When two documents provide the same field, the one from the higher-priority
 * category wins. This prevents bank statements from overwriting borrower
 * identity that came from a legal or property document.
 */
const FIELD_CATEGORY_PRIORITY = {
  // Borrower identity fields — prefer legal/property docs, then KYC
  borrower_name:       { legal: 10, property: 9, kyc: 8, financial: 3, other: 2 },
  borrower_email:      { legal: 10, property: 9, kyc: 8, financial: 5, other: 2 },
  borrower_phone:      { legal: 10, property: 9, kyc: 8, financial: 5, other: 2 },
  borrower_dob:        { kyc: 10, legal: 8, property: 5, financial: 3, other: 2 },
  borrower_nationality:{ kyc: 10, legal: 8, property: 5, financial: 3, other: 2 },
  borrower_type:       { legal: 10, property: 9, kyc: 8, financial: 3, other: 2 },
  company_name:        { legal: 10, property: 9, kyc: 8, financial: 3, other: 2 },
  company_number:      { legal: 10, property: 9, kyc: 8, financial: 5, other: 2 },
  // Property fields — prefer property/valuation docs
  security_address:    { property: 10, legal: 9, financial: 3, kyc: 2, other: 2 },
  security_postcode:   { property: 10, legal: 9, financial: 3, kyc: 2, other: 2 },
  asset_type:          { property: 10, legal: 8, financial: 3, kyc: 2, other: 2 },
  property_tenure:     { property: 10, legal: 9, financial: 2, kyc: 2, other: 2 },
  occupancy_status:    { property: 10, legal: 8, financial: 3, kyc: 2, other: 2 },
  current_use:         { property: 10, legal: 8, financial: 3, kyc: 2, other: 2 },
  current_value:       { property: 10, legal: 8, financial: 5, kyc: 2, other: 2 },
  purchase_price:      { property: 10, legal: 9, financial: 5, kyc: 2, other: 2 },
  // Loan fields — prefer legal/property, then financial
  loan_amount:         { legal: 10, property: 9, financial: 7, kyc: 2, other: 5 },
  ltv_requested:       { legal: 10, property: 9, financial: 7, kyc: 2, other: 5 },
  term_months:         { legal: 10, property: 8, financial: 7, kyc: 2, other: 5 },
  rate_requested:      { legal: 10, property: 8, financial: 7, kyc: 2, other: 5 },
  interest_servicing:  { legal: 10, property: 8, financial: 7, kyc: 2, other: 5 },
  loan_purpose:        { legal: 10, property: 9, financial: 6, kyc: 2, other: 5 },
  use_of_funds:        { legal: 10, property: 8, financial: 7, kyc: 2, other: 5 },
  refurb_scope:        { property: 10, legal: 8, financial: 5, kyc: 2, other: 5 },
  refurb_cost:         { property: 10, legal: 8, financial: 5, kyc: 2, other: 5 },
  exit_strategy:       { legal: 10, property: 9, financial: 6, kyc: 2, other: 5 },
  deposit_source:      { financial: 10, legal: 8, kyc: 7, property: 5, other: 3 },
  existing_charges:    { legal: 10, property: 9, financial: 7, kyc: 2, other: 3 },
  additional_notes:    { legal: 5, property: 5, financial: 5, kyc: 5, other: 5 },
  // Broker fields — any source is fine
  broker_name:         { legal: 10, property: 8, financial: 5, kyc: 5, other: 5 },
  broker_company:      { legal: 10, property: 8, financial: 5, kyc: 5, other: 5 },
  broker_fca:          { legal: 10, property: 8, financial: 5, kyc: 5, other: 5 },
};

function getCategoryPriority(field, docCategory) {
  const cat = (docCategory || 'other').toLowerCase();
  const priorities = FIELD_CATEGORY_PRIORITY[field];
  if (!priorities) return 5; // default medium priority
  return priorities[cat] || priorities['other'] || 2;
}

/**
 * Extract deal fields from multiple documents and merge results.
 * Uses category-aware priority: e.g. borrower name from a legal doc
 * takes precedence over a name found in a bank statement.
 * Returns { merged, perDoc } where perDoc is a Map<docId, parsedData>
 */
async function extractDealFieldsFromMultipleDocs(docs) {
  if (!ANTHROPIC_API_KEY) {
    console.log('[ai-extract] No ANTHROPIC_API_KEY set — cannot extract any documents');
    return { merged: null, perDoc: new Map(), conflicts: {} };
  }

  console.log(`[ai-extract] Processing ${docs.length} documents for deal field extraction...`);

  const merged = {};
  const mergedPriority = {}; // tracks the priority of the current value per field
  const mergedSource = {};   // tracks which doc set each field: { docId, filename, category }
  const conflicts = {};      // tracks conflicting values: { field: [{ value, docId, filename, category, priority }] }
  let totalConfidence = 0;
  let confCount = 0;
  const perDoc = new Map();

  for (const doc of docs) {
    if (!doc.file_content) {
      console.log(`[ai-extract] Doc ${doc.id} "${doc.filename}" has no file_content — skipping`);
      continue;
    }

    const result = await extractDealFieldsFromDocument(
      doc.file_content, doc.file_type, doc.filename, doc.doc_category
    );

    if (result) {
      perDoc.set(doc.id, result);

      const docCat = doc.doc_category || 'other';

      for (const [key, val] of Object.entries(result)) {
        if (key === 'confidence') {
          totalConfidence += (val || 0);
          confCount++;
          continue;
        }
        if (val == null || val === '') continue;

        const newPriority = getCategoryPriority(key, docCat);
        const existingPriority = mergedPriority[key] || 0;
        const isCore = CORE_STRUCTURE_FIELDS.includes(key);

        // If field already has a value AND it's a core structure field, track as conflict
        if (merged[key] && isCore && String(merged[key]).toLowerCase() !== String(val).toLowerCase()) {
          if (!conflicts[key]) {
            conflicts[key] = [{
              value: merged[key],
              docId: mergedSource[key]?.docId,
              filename: mergedSource[key]?.filename,
              category: mergedSource[key]?.category,
              priority: existingPriority
            }];
          }
          conflicts[key].push({
            value: val,
            docId: doc.id,
            filename: doc.filename,
            category: docCat,
            priority: newPriority
          });
        }

        // Only overwrite if higher priority
        if (newPriority >= existingPriority) {
          if (merged[key] && isCore && newPriority > existingPriority) {
            console.log(`[ai-extract] CORE field "${key}": replacing "${String(merged[key]).substring(0,40)}" (${mergedSource[key]?.category}:${existingPriority}) with "${String(val).substring(0,40)}" (${docCat}:${newPriority})`);
          }
          merged[key] = val;
          mergedPriority[key] = newPriority;
          mergedSource[key] = { docId: doc.id, filename: doc.filename, category: docCat };
        } else if (isCore) {
          console.log(`[ai-extract] CORE field "${key}": keeping "${String(merged[key]).substring(0,40)}" over "${String(val).substring(0,40)}" from ${docCat} doc (lower priority)`);
        }
      }
    }
  }

  // Log conflicts summary
  const conflictKeys = Object.keys(conflicts);
  if (conflictKeys.length > 0) {
    console.log(`[ai-extract] ⚠ ${conflictKeys.length} CORE FIELD CONFLICTS detected: ${conflictKeys.join(', ')}`);
    for (const [field, options] of Object.entries(conflicts)) {
      console.log(`  ${field}: ${options.map(o => `"${String(o.value).substring(0,30)}" (${o.category})`).join(' vs ')}`);
    }
  }

  if (Object.keys(merged).length === 0) return { merged: null, perDoc, conflicts: {} };

  merged.confidence = confCount > 0 ? totalConfidence / confCount : 0.5;
  return { merged, perDoc, conflicts };
}

module.exports = { extractSectionData, SECTION_SCHEMAS, extractDealFieldsFromDocument, extractDealFieldsFromMultipleDocs, CORE_STRUCTURE_FIELDS, EVIDENCE_FIELDS };
