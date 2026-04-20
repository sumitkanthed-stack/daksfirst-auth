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
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
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
      "full_name": "FULL LEGAL NAME — use the complete name from passport/ID/KYC, not abbreviated forms like 'Mrs A Smith' from letters or valuation reports",
      "date_of_birth": "YYYY-MM-DD or null",
      "nationality": "string or null",
      "email": "string or null",
      "phone": "string or null",
      "role": "primary or guarantor or director",
      "gender": "male or female or null — infer from name/title if not explicitly stated (Mr = male, Mrs/Ms/Miss = female)",
      "passport_number": "string or null",
      "passport_expiry": "YYYY-MM-DD or null",
      "id_type": "passport or driving_licence or national_id or null — type of primary ID document",
      "residential_address": "full residential address of this individual or null",
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
    "name": "string or null — the FINANCE BROKER / MORTGAGE INTERMEDIARY who introduced this deal to Daksfirst. NOT an estate agent, NOT a valuation surveyor, NOT a solicitor",
    "company": "string or null — the finance brokerage firm",
    "fca_number": "string or null — FCA registration number of the broker",
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

BROKER RULES (CRITICAL):
- The "broker" is the FINANCE BROKER / MORTGAGE INTERMEDIARY who introduced this loan deal. They have an FCA number.
- Estate agents (e.g. Foxtons, Savills, Fletchers, Knight Frank, Harrods Estates) are NOT brokers — they sell/let properties
- Valuation surveyors / RICS surveyors are NOT brokers — they value properties
- Solicitors / conveyancers are NOT brokers — they handle legal work
- If no clear finance broker is identified in the documents, set all broker fields to null
- Do NOT guess — only populate broker if someone is explicitly described as a broker, intermediary, or introducer for the loan

PROPERTY RULES (CRITICAL — follow exactly):
- parsedProperties must ONLY contain properties pledged as SECURITY/COLLATERAL for this loan
- Do NOT include: comparable properties, market evidence properties, registered company addresses, correspondence addresses, or any property merely referenced or used for valuation comparison
- If a valuation report lists "comparable evidence" or "market comparables", those are NOT security properties — ignore them entirely
- If the same security property appears across multiple documents with different address formats (e.g. "Apartment No.82, 2 Bedroom River Front Apartment, London" vs "Apartment No.82 King Henrys Reach, Manbre Road, London"), these are the SAME property — include it ONCE using the most complete address
- Match properties by unit/flat/apartment number + postcode — same unit number at the same postcode = same property
- Each unique security property should appear exactly ONCE in parsedProperties
- Each property must have its own correctly matched UK postcode
- For market_value: use the CURRENT MARKET VALUE or OPEN MARKET VALUE from the valuation, NOT the GDV, NOT the purchase price, NOT a comparable sale price. If multiple values exist for the same property, use the professional valuation figure
- For purchase_price: extract EACH property's individual purchase price. If the documents mention a total/aggregate purchase price for a portfolio but also break it down per unit, use the per-unit figures. If only a total is given for multiple properties, divide it proportionally by market value. NEVER leave purchase_price as 0 if a purchase price exists anywhere in the documents
- EVERY security property must have: address, postcode, market_value, purchase_price (if mentioned anywhere). Do NOT only extract values for the first property and ignore the rest

- Track source_document so the broker can verify which document each data point came from
- Cross-reference data across documents: if the valuation report and broker pack both mention a property, use the valuation report figure for market_value
- Set confidence between 0 and 1 based on how much data you could reliably extract
- Include anything important in notes that does not fit other fields

BORROWER NAME RULES (CRITICAL):
- Always use the FULL LEGAL NAME as it appears on passport, driving licence, or other ID document
- Do NOT use abbreviated forms from valuation reports, letters, or correspondence (e.g. "Mrs A Cenci", "Mr J Smith")
- If the full name appears in one document (e.g. passport: "Alessandra Cenci") and an abbreviated form in another (e.g. valuation: "Mrs A Cenci"), ALWAYS use the full legal name
- The valuation report addressee or "client" field is often abbreviated — never prefer this over KYC/ID documents`;


/**
 * Build Claude content blocks from files
 */
function buildContentBlocks(files, dealContext, securityContext) {
  const contentParts = [];

  // Add deal context as text (if available — may be null for new-deal parsing)
  if (dealContext) {
    contentParts.push({
      type: 'text',
      text: `=== DEAL CONTEXT ===\nBorrower: ${dealContext.borrower_name || 'Unknown'}\nLoan: £${dealContext.loan_amount || 0}\nSecurity: ${(securityContext && securityContext.address) || 'Unknown'}\nPostcode: ${(securityContext && securityContext.postcode) || ''}\nExit: ${dealContext.exit_strategy || 'Unknown'}\nTerm: ${dealContext.loan_term_months || 0} months\nPurpose: ${dealContext.loan_purpose || 'Unknown'}\n`
    });
  } else {
    contentParts.push({
      type: 'text',
      text: 'Extract all deal information from the attached documents. No existing deal context is available — extract everything you can find.'
    });
  }

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

  // Extract unit/flat/apartment identifier from an address
  // "Apartment No.82, 2 Bedroom..." → "apartmentno82"
  // "Flat 1 King Henrys Reach..." → "flat1"
  // "129 Rannoch Road, 4 Bedroom..." → "129"
  const extractUnitKey = (addr) => {
    if (!addr) return '';
    const clean = addr.toLowerCase().trim();
    // Match: apartment/flat/unit + number patterns
    const unitMatch = clean.match(/(?:apartment|apt|flat|unit|suite|room)\s*(?:no\.?\s*)?(\d+\w?)/i);
    if (unitMatch) return normalize(unitMatch[0]);
    // Match: leading number (house number) e.g. "129 Rannoch Road"
    const houseMatch = clean.match(/^(\d+\w?)\s/);
    if (houseMatch) return houseMatch[1];
    return '';
  };

  // Extract street-level key: text before first comma, normalised + capped
  const extractStreetKey = (addr) => {
    if (!addr) return '';
    const clean = addr.toLowerCase().trim();
    const parts = clean.split(/[,;]/)[0].trim();
    return normalize(parts).substring(0, 25);
  };

  const scoreProperty = (p) => {
    let score = 0;
    if (p.market_value && parseFloat(p.market_value) > 0) score += 3;
    if (p.purchase_price && parseFloat(p.purchase_price) > 0) score += 2;
    if (p.tenure) score += 1;
    if (p.property_type) score += 1;
    if (p.title_number) score += 1;
    if (p.occupancy_status) score += 1;
    if (p.current_use) score += 1;
    return score;
  };

  const seen = new Map(); // key → best property
  for (const prop of properties) {
    const pc = normalize(prop.postcode);
    const street = extractStreetKey(prop.address);
    const unit = extractUnitKey(prop.address);

    // Primary key: postcode + street (handles exact address matches and minor variations)
    const primaryKey = `${pc}::${street}`;
    // Secondary key: postcode + unit number (catches same flat described with different address text)
    const unitKey = unit ? `${pc}::unit::${unit}` : null;

    // Check if either key already exists
    let matchKey = null;
    if (seen.has(primaryKey)) {
      matchKey = primaryKey;
    } else if (unitKey && seen.has(unitKey)) {
      matchKey = unitKey;
    }

    if (matchKey) {
      // Duplicate found — keep first seen, but merge in any missing fields from later versions
      const existing = seen.get(matchKey);
      const ep = existing.prop;
      // Fill nulls/zeros from the new property into the existing one
      if (!ep.market_value && prop.market_value) ep.market_value = prop.market_value;
      if (!ep.purchase_price && prop.purchase_price) ep.purchase_price = prop.purchase_price;
      if (!ep.tenure && prop.tenure) ep.tenure = prop.tenure;
      if (!ep.property_type && prop.property_type) ep.property_type = prop.property_type;
      if (!ep.title_number && prop.title_number) ep.title_number = prop.title_number;
      if (!ep.occupancy_status && prop.occupancy_status) ep.occupancy_status = prop.occupancy_status;
      if (!ep.current_use && prop.current_use) ep.current_use = prop.current_use;
    } else {
      // New property — store under both keys pointing to same entry
      const entry = { prop, primaryKey, unitKey };
      seen.set(primaryKey, entry);
      if (unitKey) seen.set(unitKey, entry);
    }
  }

  // Collect unique properties (entries may be stored under 2 keys, deduplicate by reference)
  const unique = new Set();
  const result = [];
  for (const entry of seen.values()) {
    if (!unique.has(entry)) {
      unique.add(entry);
      result.push(entry.prop);
    }
  }
  return result;
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

// ═══════════════════════════════════════════════════════════════════════════
//  Candidate dedup — added 2026-04-20. Groups duplicates across batches and
//  merges source_docs, role_hints, reasoning. Works on the candidate output
//  shape from parseDealForCandidates (different fields from full borrower
//  records — that's why these are separate from deduplicateBorrowers).
// ═══════════════════════════════════════════════════════════════════════════

const NAME_TITLES = new Set(['mr', 'mrs', 'miss', 'ms', 'dr', 'sir', 'dame', 'lord', 'lady', 'prof', 'rev']);

function _normaliseNameKey(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !NAME_TITLES.has(t))
    .sort()
    .join(' ');
}

function _normaliseCompanyKey(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(ltd|limited|llp|plc|inc|llc|co|uk)\b/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function _mergeSources(a, b) {
  const set = new Set([...(a || []), ...(b || [])]);
  return Array.from(set);
}

function _pickLonger(a, b) {
  const sa = (a || '').toString();
  const sb = (b || '').toString();
  return sa.length >= sb.length ? sa : sb;
}

function _pickNonEmpty(a, b) {
  if (a !== null && a !== undefined && a !== '') return a;
  return b;
}

// Two name-token lists match if every pair is either equal OR one is a single
// letter that matches the first char of the other (initials-vs-fullname match).
function _tokensMatchWithInitials(shortToks, longToks) {
  if (shortToks.length !== longToks.length) return false;
  for (let i = 0; i < shortToks.length; i++) {
    const a = shortToks[i];
    const b = longToks[i];
    if (a === b) continue;
    if (a.length === 1 && b.startsWith(a)) continue;
    if (b.length === 1 && a.startsWith(b)) continue;
    return false;
  }
  return true;
}

function deduplicateCandidateIndividuals(individuals) {
  if (!Array.isArray(individuals) || individuals.length === 0) return individuals;

  // Pass 1: group by exact name-key match OR DOB match
  const groups = [];
  for (const ind of individuals) {
    const nameKey = _normaliseNameKey(ind.name);
    const dob = (ind.date_of_birth || '').substring(0, 10);

    const match = groups.find(g => {
      if (dob && g.dob && dob === g.dob) return true;
      if (nameKey && g.nameKey === nameKey) return true;
      return false;
    });

    if (match) {
      match.dob = match.dob || dob;
      match.nameKey = match.nameKey || nameKey;
      match.variants.push(ind);
    } else {
      groups.push({ nameKey, dob, variants: [ind] });
    }
  }

  // Pass 2: collapse initials-matching pairs (e.g. "A Cenci" + "Alessandra Cenci")
  // Walk groups oldest-first; if any later group's tokens match with the
  // initials rule AND DOBs don't conflict, absorb it.
  for (let i = 0; i < groups.length; i++) {
    const gi = groups[i];
    const giTokens = (gi.nameKey || '').split(' ').filter(Boolean);
    if (giTokens.length === 0) continue;

    for (let j = groups.length - 1; j > i; j--) {
      const gj = groups[j];
      if (gi.dob && gj.dob && gi.dob !== gj.dob) continue;   // different DOB → different people
      const gjTokens = (gj.nameKey || '').split(' ').filter(Boolean);
      if (gjTokens.length === 0) continue;
      if (_tokensMatchWithInitials(gjTokens, giTokens) || _tokensMatchWithInitials(giTokens, gjTokens)) {
        gi.variants.push(...gj.variants);
        gi.dob = gi.dob || gj.dob;
        // Keep the richer name-key (more characters)
        if ((gj.nameKey || '').length > (gi.nameKey || '').length) gi.nameKey = gj.nameKey;
        groups.splice(j, 1);
      }
    }
  }

  // Collapse each group into a single record by picking best fields + unioning
  return groups.map((group, idx) => {
    const v = group.variants;
    const merged = {
      id: 'ind-' + (idx + 1),
      name: v.reduce((best, c) => (c.name && c.name.length > (best.name || '').length ? c : best), {}).name || v[0].name,
      date_of_birth: v.reduce((d, c) => d || c.date_of_birth, null),
      nationality: v.reduce((n, c) => n || c.nationality, null),
      address: v.reduce((a, c) => a || c.address, null),
      email: v.reduce((e, c) => e || c.email, null),
      phone: v.reduce((p, c) => p || c.phone, null),
      psc_percentage: v.reduce((p, c) => p || c.psc_percentage, null),
      id_document_type: v.reduce((t, c) => t || c.id_document_type, null),
      id_document_number: v.reduce((n, c) => n || c.id_document_number, null),
      linked_to_corporate_id: v.reduce((l, c) => l || c.linked_to_corporate_id, null),
      // Union of role_hints across all duplicates — keep every hint Claude saw
      role_hints: Array.from(new Set(v.flatMap(c => c.role_hints || []))),
      // Union of source docs / pages
      source_docs: _mergeSources(...v.map(c => c.source_docs)),
      source_pages: Array.from(new Set(v.flatMap(c => c.source_pages || []))),
      // Pick the longest reasoning (most detail) — or concatenate top 2 if short
      reasoning: v.reduce((best, c) => _pickLonger(best, c.reasoning), ''),
      // Track duplicate count so UI can show "merged from N mentions"
      _duplicate_count: v.length
    };
    return merged;
  });
}

function deduplicateCandidateCorporates(corporates) {
  if (!Array.isArray(corporates) || corporates.length === 0) return corporates;

  const groups = [];
  for (const corp of corporates) {
    const coNo = (corp.company_number || '').replace(/\s/g, '').toLowerCase();
    const nameKey = _normaliseCompanyKey(corp.name);

    // Company number is a strong match; name match is a fallback
    const match = groups.find(g => {
      if (coNo && g.coNo && coNo === g.coNo) return true;
      if (nameKey && g.nameKey === nameKey) return true;
      return false;
    });

    if (match) {
      match.coNo = match.coNo || coNo;
      match.nameKey = match.nameKey || nameKey;
      match.variants.push(corp);
    } else {
      groups.push({ coNo, nameKey, variants: [corp] });
    }
  }

  return groups.map((group, idx) => {
    const v = group.variants;
    return {
      id: 'corp-' + (idx + 1),
      name: v.reduce((best, c) => (c.name && c.name.length > (best.name || '').length ? c : best), {}).name || v[0].name,
      company_number: v.reduce((n, c) => n || c.company_number, null),
      jurisdiction: v.reduce((j, c) => j || c.jurisdiction, null),
      registered_address: v.reduce((a, c) => _pickNonEmpty(a, c.registered_address), null),
      source_docs: _mergeSources(...v.map(c => c.source_docs)),
      source_pages: Array.from(new Set(v.flatMap(c => c.source_pages || []))),
      reasoning: v.reduce((best, c) => _pickLonger(best, c.reasoning), ''),
      _duplicate_count: v.length
    };
  });
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

      // ── Auto-trigger property search (Postcodes.io + EPC + Price Paid) ──
      try {
        const { searchProperty } = require('./property-search');
        const unsearched = await pool.query(
          `SELECT id, address, postcode FROM deal_properties WHERE deal_id = $1 AND property_searched_at IS NULL`,
          [dealId]
        );
        for (const prop of unsearched.rows) {
          if (!prop.postcode && !prop.address) continue;
          try {
            const results = await searchProperty(prop.postcode, prop.address);
            // Write key fields to columns
            const sets = [];
            const vals = [];
            let i = 1;
            if (results.postcode_lookup.success) {
              const pc = results.postcode_lookup.data;
              for (const [c, v] of [['region',pc.region],['country',pc.country],['local_authority',pc.admin_district],['admin_ward',pc.admin_ward],['latitude',pc.latitude],['longitude',pc.longitude],['in_england_or_wales',pc.in_england_or_wales]]) {
                if (v !== null && v !== undefined) { sets.push(`${c}=$${i}`); vals.push(v); i++; }
              }
            }
            if (results.epc.success) {
              const e = results.epc.data;
              for (const [c, v] of [['epc_rating',e.epc_rating],['epc_score',e.epc_score],['epc_potential_rating',e.potential_rating],['epc_floor_area',e.floor_area],['epc_property_type',e.property_type],['epc_built_form',e.built_form],['epc_construction_age',e.construction_age],['epc_habitable_rooms',e.number_habitable_rooms],['epc_inspection_date',e.inspection_date],['epc_certificate_id',e.lmk_key]]) {
                if (v !== null && v !== undefined) { sets.push(`${c}=$${i}`); vals.push(v); i++; }
              }
            }
            if (results.price_paid.success) {
              const pp = results.price_paid.data;
              if (pp.latest_price) { sets.push(`last_sale_price=$${i}`); vals.push(pp.latest_price); i++; sets.push(`last_sale_date=$${i}`); vals.push(pp.latest_date); i++; }
              sets.push(`price_paid_data=$${i}`); vals.push(JSON.stringify(pp.transactions||[])); i++;
            }
            sets.push(`property_search_data=$${i}`); vals.push(JSON.stringify(results)); i++;
            sets.push(`property_searched_at=NOW()`);
            sets.push(`updated_at=NOW()`);
            vals.push(prop.id);
            await pool.query(`UPDATE deal_properties SET ${sets.join(',')} WHERE id=$${i}`, vals);
            console.log(`[claude-parser] ✓ Auto-searched property ${prop.id}: ${prop.postcode}`);
          } catch (psErr) {
            console.warn(`[claude-parser] Property search failed for ${prop.id}:`, psErr.message);
          }
        }
        await updateProgress('property_search', `Auto-searched ${unsearched.rows.length} properties`);
      } catch (psErr) {
        console.warn('[claude-parser] Property auto-search skipped:', psErr.message);
      }
    }

    // ── 6b. Write borrowers to deal_borrowers table ──
    if (mergedAnalysis.borrowers && Array.isArray(mergedAnalysis.borrowers) && mergedAnalysis.borrowers.length > 0) {
      // Only delete pending borrowers that have NOT been CH-verified or KYC-verified
      await pool.query(
        `DELETE FROM deal_borrowers WHERE deal_id = $1 AND kyc_status = 'pending' AND ch_verified_at IS NULL`,
        [dealId]
      );
      for (const b of mergedAnalysis.borrowers) {
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
          [dealId, b.full_name, b.date_of_birth || null, b.nationality || null,
           b.email || null, b.phone || null, b.role || 'primary',
           mergedAnalysis.company?.borrower_type || 'individual',
           mergedAnalysis.company?.name || null, mergedAnalysis.company?.company_number || null,
           b.gender || null, b.id_type || (b.passport_number ? 'passport' : null),
           b.passport_number || null, b.passport_expiry || null,
           b.residential_address || null]
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
      const loanAmt = parseFloat(l.loan_amount) || 0;
      const ltv = parseFloat(l.ltv_requested) || 0;
      const termMonths = parseInt(l.term_months) || 0;  // INT column — must be whole number
      await pool.query(
        `UPDATE deal_submissions SET
           loan_amount = COALESCE(NULLIF($2::numeric, 0), loan_amount),
           ltv_requested = COALESCE(NULLIF($3::numeric, 0), ltv_requested),
           term_months = COALESCE(NULLIF($4::int, 0), term_months),
           loan_purpose = COALESCE(NULLIF($5, ''), loan_purpose),
           exit_strategy = COALESCE(NULLIF($6, ''), exit_strategy),
           use_of_funds = COALESCE(NULLIF($7, ''), use_of_funds),
           interest_servicing = COALESCE(NULLIF($8, ''), interest_servicing),
           existing_charges = COALESCE(NULLIF($9, ''), existing_charges),
           deposit_source = COALESCE(NULLIF($10, ''), deposit_source),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, loanAmt, ltv, termMonths,
         l.loan_purpose || '', l.exit_strategy || '', l.use_of_funds || '',
         l.interest_servicing || '', l.existing_charges || '', l.deposit_source || '']
      );
      await updateProgress('wrote_loan', `Saved loan terms: £${loanAmt.toLocaleString()}, ${termMonths} months, LTV ${ltv}%`);
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
    if (mergedAnalysis.refurbishment && parseFloat(mergedAnalysis.refurbishment.total_refurb_cost) > 0) {
      const refurbCost = parseFloat(mergedAnalysis.refurbishment.total_refurb_cost) || 0;
      await pool.query(
        `UPDATE deal_submissions SET
           refurb_cost = COALESCE(NULLIF($2::numeric, 0), refurb_cost),
           refurb_scope = COALESCE(NULLIF($3, ''), refurb_scope),
           updated_at = NOW()
         WHERE id = $1`,
        [dealId, refurbCost, mergedAnalysis.refurbishment.scope_of_works || '']
      );
      await updateProgress('wrote_refurb', `Saved refurb: £${mergedAnalysis.refurbishment.total_refurb_cost}`);
    }

    // ── 6g. Write broker details ──
    // Only overwrite broker fields if the deal creator is NOT a broker
    // (brokers are the logged-in user — whatever's in the docs is likely the borrower's agent)
    if (mergedAnalysis.broker && mergedAnalysis.broker.name) {
      const dealOwner = await pool.query(
        `SELECT u.role FROM deal_submissions d JOIN users u ON d.user_id = u.id WHERE d.id = $1`,
        [dealId]
      );
      const ownerIsBroker = dealOwner.rows.length > 0 && dealOwner.rows[0].role === 'broker';

      if (!ownerIsBroker) {
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
      } else {
        await updateProgress('wrote_broker', `Skipped — broker is logged-in user`);
      }
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

/**
 * parseDocumentsOnly — standalone parsing using Path A (Claude vision API)
 * Same quality as in-deal parsing, but returns structured data without needing a deal.
 * Used by broker new-deal upload flow.
 *
 * @param {Array} docs - Array of { filename, file_type, file_content, doc_category } from deal_documents table
 * @returns {Object} - { success, analysis (full parsed JSON), flatFields (mapped to deal form fields) }
 */
async function parseDocumentsOnly(docs) {
  if (!docs || docs.length === 0) return { success: false, reason: 'no_documents' };

  console.log(`[claude-parser] parseDocumentsOnly: ${docs.length} documents`);

  // Encode documents (same as parseDealDocuments step 2)
  const seenNames = new Set();
  const allFiles = [];
  for (const doc of docs) {
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

  if (allFiles.length === 0) return { success: false, reason: 'no_content' };
  console.log(`[claude-parser] parseDocumentsOnly: ${allFiles.length} unique documents encoded`);

  // Batch (same as parseDealDocuments step 3)
  const MAX_BATCH_B64 = 5 * 1024 * 1024;
  const batches = [];
  let currentBatch = [];
  let currentSize = 0;
  for (const file of allFiles) {
    const fileSize = file.content_base64.length;
    if (fileSize > MAX_BATCH_B64) {
      if (currentBatch.length > 0) { batches.push(currentBatch); currentBatch = []; currentSize = 0; }
      batches.push([file]);
      continue;
    }
    if (currentSize + fileSize > MAX_BATCH_B64) { batches.push(currentBatch); currentBatch = []; currentSize = 0; }
    currentBatch.push(file);
    currentSize += fileSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  console.log(`[claude-parser] parseDocumentsOnly: ${batches.length} batch(es)`);

  // Process batches through Claude (same as step 4)
  let mergedAnalysis = {};
  for (let i = 0; i < batches.length; i++) {
    try {
      const contentParts = buildContentBlocks(batches[i], null, null);
      const rawResponse = await callClaude(contentParts);
      const parsed = parseClaudeResponse(rawResponse);
      mergedAnalysis = i === 0 ? parsed : mergeAnalysis(mergedAnalysis, parsed);
      console.log(`[claude-parser] parseDocumentsOnly: batch ${i+1} done — ${parsed.parsedProperties?.length || 0} properties, ${parsed.borrowers?.length || 0} borrowers`);
    } catch (err) {
      console.error(`[claude-parser] parseDocumentsOnly: batch ${i+1} failed:`, err.message);
    }
  }

  // Dedup (same as step 5)
  if (mergedAnalysis.parsedProperties) {
    mergedAnalysis.parsedProperties = deduplicateProperties(mergedAnalysis.parsedProperties);
  }
  if (mergedAnalysis.borrowers) {
    mergedAnalysis.borrowers = deduplicateBorrowers(mergedAnalysis.borrowers);
  }

  // Map the rich analysis to flat deal form fields
  const flatFields = mapAnalysisToFormFields(mergedAnalysis);

  console.log(`[claude-parser] parseDocumentsOnly: extracted ${Object.keys(flatFields).filter(k => flatFields[k] != null && flatFields[k] !== '').length} form fields`);
  return { success: true, analysis: mergedAnalysis, flatFields };
}

/**
 * Map the rich analysis JSON from Path A to flat deal form field names
 *
 * Corporate-vs-individual borrower resolution (2026-04-20 fix):
 *   - If analysis.company.name is set, the deal IS corporate. borrower_name
 *     becomes the company name (Gold Medal Properties Limited), not the
 *     UBO/PSC individual name. Individual attributes (DOB, nationality) are
 *     null — they belong on the UBO child record in deal_borrowers, not on
 *     the corporate parent.
 *   - If no company detected, the deal is individual. borrower_name comes
 *     from the first primary (or first) individual borrower.
 *
 * Multi-property (2026-04-20 fix):
 *   - Still sets security_* scalar fields from the FIRST property (for
 *     backward compat with legacy Matrix UI).
 *   - ALSO returns properties_all: the full array of parsed properties so
 *     the new candidate-review UI can render every one. Downstream writer
 *     iterates this array to create one deal_properties row per asset.
 */
function mapAnalysisToFormFields(analysis) {
  const fields = {};

  const company = analysis.company || {};
  const isCorporate = !!(company.name || company.borrower_type === 'corporate');

  if (isCorporate) {
    // Corporate deal — borrower_name = company name. Individual attrs null.
    fields.borrower_name = company.name || null;
    fields.borrower_email = null;
    fields.borrower_phone = null;
    fields.borrower_dob = null;
    fields.borrower_nationality = null;
    fields.borrower_type = 'corporate';
    fields.company_name = company.name || null;
    fields.company_number = company.company_number || null;
    fields.borrower_company = company.name || null;
  } else {
    // Individual deal — borrower_name = first individual borrower's name.
    const primary = (analysis.borrowers || []).find(b => b.role === 'primary') || (analysis.borrowers || [])[0];
    if (primary) {
      fields.borrower_name = primary.full_name || null;
      fields.borrower_email = primary.email || null;
      fields.borrower_phone = primary.phone || null;
      fields.borrower_dob = primary.date_of_birth || null;
      fields.borrower_nationality = primary.nationality || null;
    }
    fields.borrower_type = 'individual';
  }

  // Property — legacy scalar fields from first, PLUS full array for new UI
  const allProps = Array.isArray(analysis.parsedProperties) ? analysis.parsedProperties : [];
  fields.properties_all = allProps;
  fields.properties_count = allProps.length;
  const prop = allProps[0];
  if (prop) {
    fields.security_address = prop.address || null;
    fields.security_postcode = prop.postcode || null;
    fields.asset_type = prop.property_type || null;
    fields.property_tenure = prop.tenure || null;
    fields.occupancy_status = prop.occupancy_status || null;
    fields.current_use = prop.current_use || null;
    fields.current_value = prop.market_value || null;
    fields.purchase_price = prop.purchase_price || null;
  }

  // Loan details
  if (analysis.loan) {
    fields.loan_amount = analysis.loan.amount_requested || null;
    fields.ltv_requested = analysis.loan.ltv_requested || null;
    fields.term_months = analysis.loan.term_months || null;
    fields.loan_purpose = analysis.loan.purpose || null;
    fields.rate_requested = analysis.loan.rate_requested || null;
    fields.interest_servicing = analysis.loan.interest_servicing || null;
    fields.existing_charges = analysis.loan.existing_charges || null;
  }

  // Exit strategy
  if (analysis.exit) {
    const parts = [];
    if (analysis.exit.primary_strategy) parts.push(analysis.exit.primary_strategy);
    if (analysis.exit.narrative) parts.push(analysis.exit.narrative);
    fields.exit_strategy = parts.join(' — ') || null;
  }

  // Refurbishment
  if (analysis.refurbishment) {
    fields.refurb_scope = analysis.refurbishment.scope || null;
    fields.refurb_cost = analysis.refurbishment.total_cost || null;
    fields.use_of_funds = analysis.refurbishment.schedule_of_works || null;
  }

  // Broker
  if (analysis.broker) {
    fields.broker_name = analysis.broker.name || null;
    fields.broker_company = analysis.broker.company || null;
    fields.broker_fca = analysis.broker.fca_number || null;
  }

  // Confidence
  fields.confidence = analysis.confidence || null;

  return fields;
}

/**
 * parseDealForCandidates — extract deal entities as CANDIDATES (not role-assigned)
 * Used by broker/RM review flow to assign roles manually.
 *
 * @param {Array} docs - Array of { filename, file_type, file_content, doc_category }
 * @returns {Object} - { success, candidates { corporate_entities, individuals, properties, loan_facts, broker }, confidence, analysis_raw }
 */
async function parseDealForCandidates(docs) {
  if (!docs || docs.length === 0) return { success: false, reason: 'no_documents' };

  console.log(`[claude-parser] parseDealForCandidates: ${docs.length} documents`);

  // ── Encode documents ──
  const seenNames = new Set();
  const allFiles = [];
  for (const doc of docs) {
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

  if (allFiles.length === 0) return { success: false, reason: 'no_content' };
  console.log(`[claude-parser] parseDealForCandidates: ${allFiles.length} unique documents encoded`);

  // ── Batch ──
  const MAX_BATCH_B64 = 5 * 1024 * 1024;
  const batches = [];
  let currentBatch = [];
  let currentSize = 0;
  for (const file of allFiles) {
    const fileSize = file.content_base64.length;
    if (fileSize > MAX_BATCH_B64) {
      if (currentBatch.length > 0) { batches.push(currentBatch); currentBatch = []; currentSize = 0; }
      batches.push([file]);
      continue;
    }
    if (currentSize + fileSize > MAX_BATCH_B64) { batches.push(currentBatch); currentBatch = []; currentSize = 0; }
    currentBatch.push(file);
    currentSize += fileSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  console.log(`[claude-parser] parseDealForCandidates: ${batches.length} batch(es)`);

  // ── Candidate extraction prompt ──
  const CANDIDATES_PROMPT = `You are analysing a UK bridging-loan broker pack for a lender. Your job is to extract every entity you find as a CANDIDATE. Do NOT decide who the Primary Borrower or Guarantor is — the lender's RM will assign roles from the UI.

CRITICAL RULES:
- For a LIMITED COMPANY deal, the Borrower is the company, not its PSC or Director. List the company as a corporate_entity candidate with registered name and Company Number. Individuals (directors, PSCs, UBOs) are SEPARATE candidates with role_hints array.
- If you see multiple properties pledged as SECURITY/COLLATERAL, each is a separate candidate. Do NOT collapse to one.
- For each candidate, note which document(s) and page(s) you found evidence on, and provide 1-2 sentence reasoning.
- Extract EVERY corporate entity, EVERY individual, EVERY property found. Do not filter or collapse.

Return ONLY a valid JSON object with no other text, no markdown, no backticks.

JSON schema:
{
  "corporate_entities": [
    {
      "id": "corp-1",
      "name": "Gold Medal Properties Limited",
      "company_number": "16607286",
      "jurisdiction": "England & Wales",
      "registered_address": "...",
      "source_docs": ["Certificate of Incorporation.pdf"],
      "source_pages": [1],
      "reasoning": "Identified as a limited company in Certificate of Incorporation and Companies House register entry."
    }
  ],
  "individuals": [
    {
      "id": "ind-1",
      "name": "Alessandra CENCI",
      "date_of_birth": "1979-09-22",
      "nationality": "Italian",
      "address": "...",
      "email": "kantheduk@gmail.com",
      "phone": "07777 777777",
      "role_hints": ["director", "psc"],
      "linked_to_corporate_id": "corp-1",
      "psc_percentage": 100,
      "id_document_type": "passport",
      "id_document_number": "...",
      "source_docs": ["Passport.pdf", "PSC Declaration.pdf"],
      "source_pages": [1, 2],
      "reasoning": "Named as sole Director and 100% PSC of Gold Medal Properties Limited. Passport confirms DOB and Italian nationality."
    }
  ],
  "properties": [
    {
      "id": "prop-1",
      "address": "Apartment 82, King Henrys Reach, London",
      "postcode": "W6 9RH",
      "property_type": "residential",
      "tenure": "leasehold",
      "occupancy": "vacant",
      "current_use": "2-bed river-front apartment",
      "market_value": 1750000,
      "purchase_price": 1300000,
      "source_docs": ["Valuation Report.pdf"],
      "source_pages": [1, 3],
      "reasoning": "Primary security — 2-bed apartment. RICS Day 1 value £1,750,000, broker-stated purchase price £1,300,000."
    }
  ],
  "loan_facts": {
    "amount_requested": 2000000,
    "term_months": 12,
    "rate_requested": 0.95,
    "rate_basis": "per month",
    "ltv_requested": 48.02,
    "loan_purpose": "purchase",
    "exit_strategy": "refinance",
    "interest_servicing": "retained",
    "retained_months": 6,
    "arrangement_fee_pct": 2.0,
    "broker_fee_pct": 0,
    "source_docs": ["Broker Email.pdf", "Facility Request.pdf"],
    "reasoning": "Broker requests £2m gross, 12-month term, 0.95% pm retained, 2% arrangement. Refi exit stated."
  },
  "broker": {
    "name": "...",
    "company": "...",
    "fca_number": "...",
    "source_docs": [],
    "reasoning": "..."
  },
  "confidence": 0.85
}`;

  // ── Process batches through Claude ──
  let mergedCandidates = {
    corporate_entities: [],
    individuals: [],
    properties: [],
    loan_facts: {},
    broker: {},
    confidence: 0
  };

  for (let i = 0; i < batches.length; i++) {
    try {
      const contentParts = buildContentBlocks(batches[i], null, null);
      const body = {
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: CANDIDATES_PROMPT,
        messages: [{ role: 'user', content: contentParts }]
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
      const parsed = parseClaudeResponse(textContent);

      // Merge candidates (dedup by id if present, otherwise append)
      if (parsed.corporate_entities && Array.isArray(parsed.corporate_entities)) {
        mergedCandidates.corporate_entities.push(...parsed.corporate_entities);
      }
      if (parsed.individuals && Array.isArray(parsed.individuals)) {
        mergedCandidates.individuals.push(...parsed.individuals);
      }
      if (parsed.properties && Array.isArray(parsed.properties)) {
        mergedCandidates.properties.push(...parsed.properties);
      }
      if (parsed.loan_facts && typeof parsed.loan_facts === 'object') {
        mergedCandidates.loan_facts = { ...mergedCandidates.loan_facts, ...parsed.loan_facts };
      }
      if (parsed.broker && typeof parsed.broker === 'object') {
        mergedCandidates.broker = { ...mergedCandidates.broker, ...parsed.broker };
      }
      if (parsed.confidence && parsed.confidence > mergedCandidates.confidence) {
        mergedCandidates.confidence = parsed.confidence;
      }

      console.log(`[claude-parser] parseDealForCandidates: batch ${i+1} done — ${parsed.corporate_entities?.length || 0} corporates, ${parsed.individuals?.length || 0} individuals, ${parsed.properties?.length || 0} properties`);
    } catch (err) {
      console.error(`[claude-parser] parseDealForCandidates: batch ${i+1} failed:`, err.message);
    }
  }

  // ── Intelligent dedup across all candidate types ──
  const beforeCorps = mergedCandidates.corporate_entities.length;
  const beforeInds = mergedCandidates.individuals.length;
  const beforeProps = mergedCandidates.properties.length;

  // 1) Dedupe corporates first, and build old-id → new-id map so we can rewrite
  //    linked_to_corporate_id references on individuals.
  const corpIdRemap = {};
  if (Array.isArray(mergedCandidates.corporate_entities)) {
    const originalCorps = mergedCandidates.corporate_entities;
    const dedupedCorps = deduplicateCandidateCorporates(originalCorps);
    // Build remap: for each original corp, find which deduped corp it merged into
    for (const orig of originalCorps) {
      const origCoNo = (orig.company_number || '').replace(/\s/g, '').toLowerCase();
      const origNameKey = _normaliseCompanyKey(orig.name);
      for (let i = 0; i < dedupedCorps.length; i++) {
        const d = dedupedCorps[i];
        const dCoNo = (d.company_number || '').replace(/\s/g, '').toLowerCase();
        const dNameKey = _normaliseCompanyKey(d.name);
        if ((origCoNo && origCoNo === dCoNo) || (origNameKey && origNameKey === dNameKey)) {
          corpIdRemap[orig.id] = d.id;
          break;
        }
      }
    }
    mergedCandidates.corporate_entities = dedupedCorps;
  }

  // 2) Dedupe individuals + rewrite linked_to_corporate_id via remap
  if (Array.isArray(mergedCandidates.individuals)) {
    // Rewrite links before deduping so merged records carry the remapped id
    mergedCandidates.individuals = mergedCandidates.individuals.map(ind => ({
      ...ind,
      linked_to_corporate_id: corpIdRemap[ind.linked_to_corporate_id] || ind.linked_to_corporate_id
    }));
    mergedCandidates.individuals = deduplicateCandidateIndividuals(mergedCandidates.individuals);
  }

  // 3) Dedupe properties (existing fn — matches on address + postcode)
  if (Array.isArray(mergedCandidates.properties)) {
    mergedCandidates.properties = deduplicateProperties(mergedCandidates.properties);
    // Re-label IDs so UI shows P1, P2, P3... in order
    mergedCandidates.properties.forEach((p, i) => { p.id = 'prop-' + (i + 1); });
  }

  console.log(`[claude-parser] parseDealForCandidates dedup: corporates ${beforeCorps}→${mergedCandidates.corporate_entities.length}, individuals ${beforeInds}→${mergedCandidates.individuals.length}, properties ${beforeProps}→${mergedCandidates.properties.length}`);

  return {
    success: true,
    candidates: mergedCandidates,
    confidence: mergedCandidates.confidence,
    analysis_raw: mergedCandidates  // preserve raw for audit
  };
}

module.exports = { parseDealDocuments, deduplicateProperties, parseDocumentsOnly, parseDealForCandidates, deduplicateCandidateIndividuals, deduplicateCandidateCorporates };
