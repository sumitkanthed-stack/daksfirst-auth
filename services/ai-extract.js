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
      'kyc-ubo-declaration': 'UBO details — names and percentage holdings of individuals with 25%+ interest'
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
      'aml-conflicts': 'Any conflicts of interest declared, or "None"'
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
      'val-solicitor-partner': 'Name of the supervising partner at the solicitor firm'
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
      'oc-other-notes': 'Any notable conditions, restrictions, or requirements found in the documents'
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
      model: 'claude-sonnet-4-5-20250514',
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
  "broker_name": "broker name",
  "broker_company": "broker company name",
  "broker_fca": "broker FCA number",
  "confidence": 0.85
}

RULES:
- Return ONLY valid JSON, no markdown, no explanation
- For currency values (current_value, purchase_price, loan_amount, refurb_cost), return the NUMBER only — strip £ signs and commas
- For percentage values (ltv_requested, rate_requested), return the NUMBER only
- Set "confidence" to a decimal between 0.0 and 1.0 reflecting how confident you are in the overall extraction
- Be thorough — extract every field possible from the available text`;

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

  const mime = (mimetype || '').toLowerCase();
  const name = (filename || '').toLowerCase();
  let text = null;

  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    text = await extractPdfText(buffer);
  } else if (mime === 'text/plain' || name.endsWith('.txt') || name.endsWith('.csv')) {
    text = buffer.toString('utf-8').substring(0, 6000);
  }

  if (!text || text.trim().length < 30) {
    console.log(`[ai-extract] Not enough text from "${filename}" — skipping`);
    return null;
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
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

/**
 * Extract deal fields from multiple documents and merge results.
 * Each document is parsed individually and results are merged.
 * Returns { merged, perDoc } where perDoc is a Map<docId, parsedData>
 */
async function extractDealFieldsFromMultipleDocs(docs) {
  if (!ANTHROPIC_API_KEY) return { merged: null, perDoc: new Map() };

  const merged = {};
  let totalConfidence = 0;
  let confCount = 0;
  const perDoc = new Map();

  for (const doc of docs) {
    if (!doc.file_content) continue;

    const result = await extractDealFieldsFromDocument(
      doc.file_content, doc.file_type, doc.filename, doc.doc_category
    );

    if (result) {
      perDoc.set(doc.id, result);

      // Merge into combined result (non-null values overwrite)
      for (const [key, val] of Object.entries(result)) {
        if (key === 'confidence') {
          totalConfidence += (val || 0);
          confCount++;
          continue;
        }
        if (val != null && val !== '') {
          merged[key] = val;
        }
      }
    }
  }

  if (Object.keys(merged).length === 0) return { merged: null, perDoc };

  merged.confidence = confCount > 0 ? totalConfidence / confCount : 0.5;
  return { merged, perDoc };
}

module.exports = { extractSectionData, SECTION_SCHEMAS, extractDealFieldsFromDocument, extractDealFieldsFromMultipleDocs };
