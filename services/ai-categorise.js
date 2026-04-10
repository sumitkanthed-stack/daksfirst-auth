/**
 * AI Document Categorisation Service
 * Uses pdf-parse to extract text, then Claude Haiku to classify documents
 * into onboarding categories based on content analysis.
 */

const Anthropic = require('@anthropic-ai/sdk');

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('[ai-categorise] pdf-parse not available — AI categorisation disabled');
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const CATEGORIES = {
  kyc: 'KYC / Identity — passports, driving licences, proof of address, utility bills, council tax, Companies House certificates, articles of association, board resolutions, UBO declarations',
  financials_aml: 'Financials / AML — bank statements, SA302 tax returns, payslips, P60s, company accounts, balance sheets, profit & loss, asset & liability statements, mortgage schedules, AML checks, source of funds/wealth declarations, PEP/sanctions screening',
  valuation: 'Valuation — RICS valuations, property surveys, title registers, land registry documents, title plans, charges registers, local authority search results, solicitor details, SRA records, legal opinions, purchase contracts',
  use_of_funds: 'Use of Funds — redemption statements, schedules of costs, refurbishment quotes, contractor quotes, build programmes, structural reports, planning consent documents, renovation budgets',
  exit_evidence: 'Exit Evidence — refinance agreements in principle (AIP), sale contracts, estate agent valuations, rental/tenancy agreements (AST), exit strategy documentation',
  other_conditions: 'Other Conditions — buildings insurance, vacant property insurance, Section 106 agreements, planning conditions, fire safety certificates, party wall agreements, building control documents'
};

const SYSTEM_PROMPT = `You are a document classifier for Daksfirst, a UK bridging loan lender. Given the extracted text from a document, classify it into exactly ONE of these categories:

${Object.entries(CATEGORIES).map(([key, desc]) => `- ${key}: ${desc}`).join('\n')}

If the document clearly doesn't fit any category, respond with "general".

RESPOND WITH ONLY THE CATEGORY KEY (e.g. "kyc" or "financials_aml"). No explanation, no quotes, no punctuation — just the key.`;

/**
 * Extract text from a PDF buffer (first 3 pages max)
 */
async function extractPdfText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer, { max: 3 }); // First 3 pages only
    // Truncate to ~2000 chars to keep API calls small and fast
    return data.text ? data.text.substring(0, 2000) : null;
  } catch (err) {
    console.error('[ai-categorise] PDF parse error:', err.message);
    return null;
  }
}

/**
 * Extract text from common file types
 */
function extractTextFromFile(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();

  // For images and other non-text formats, return null (can't extract without OCR)
  if (mime.startsWith('image/')) return Promise.resolve(null);

  // For plain text files
  if (mime === 'text/plain' || name.endsWith('.txt') || name.endsWith('.csv')) {
    return Promise.resolve(file.buffer.toString('utf-8').substring(0, 2000));
  }

  // For PDFs
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return extractPdfText(file.buffer);
  }

  // For Word docs, we can't easily extract without extra libs — return null
  return Promise.resolve(null);
}

/**
 * Use Claude to categorise a document based on its text content
 */
async function classifyWithAI(text, filename) {
  if (!ANTHROPIC_API_KEY) {
    console.log('[ai-categorise] No ANTHROPIC_API_KEY — skipping AI classification');
    return null;
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Filename: ${filename}\n\nDocument text:\n${text}`
      }]
    });

    const response = (message.content[0]?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');

    // Validate it's a known category
    const validCategories = [...Object.keys(CATEGORIES), 'general'];
    if (validCategories.includes(response)) {
      return response;
    }

    console.warn('[ai-categorise] Unexpected AI response:', message.content[0]?.text, '→ defaulting to general');
    return 'general';
  } catch (err) {
    console.error('[ai-categorise] Claude API error:', err.message);
    return null; // Fallback to filename matching
  }
}

/**
 * Main function: categorise a file using AI content analysis
 * Falls back to null if AI is unavailable or text can't be extracted
 */
async function categoriseWithAI(file) {
  const text = await extractTextFromFile(file);
  if (!text || text.trim().length < 50) {
    // Not enough text to classify — skip AI
    return null;
  }
  return classifyWithAI(text, file.originalname);
}

module.exports = { categoriseWithAI, extractPdfText, CATEGORIES };
