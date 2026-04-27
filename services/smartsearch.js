/**
 * services/smartsearch.js
 * ============================================================
 * SmartSearch UK KYC/AML REST client — 2026-04-27
 *
 * Four products (one method each):
 *   1. runIndividualKyc       — Identity verification (electoral roll, mortality,
 *                               address history, document checks)
 *   2. runBusinessKyb         — Company verification (incorporation, directors,
 *                               UBOs, financials snapshot)
 *   3. runSanctionsPep        — Sanctions + PEP + RCA + SIP + adverse media
 *                               screening (Dow Jones Watchlist, 1,100+ lists)
 *   4. enrolMonitoring        — Subscribe a passed check to ongoing monitoring;
 *                               vendor pushes updates to /api/webhooks/smartsearch
 *
 * Three modes (SMARTSEARCH_MODE env var):
 *   - 'mock' : returns canned fixtures, no network call, no charge.
 *              DEFAULT — safe to leave on in production with no creds.
 *   - 'test' : hits SmartSearch sandbox via Basic Auth + API key header.
 *              No real charges; use realistic test subjects.
 *   - 'live' : hits SmartSearch production and CHARGES per check.
 *              Per-product pricing varies; see SMARTSEARCH_MAX_PENCE_PER_CHECK.
 *
 * All exported functions return the same fail-soft shape:
 *   { success: bool, error: string|null, data: object|null, status: int|null,
 *     raw: any, mode: 'mock'|'test'|'live', cost_pence: int }
 *
 * Sumit's architecture sign-off (2026-04-27):
 *   - Append-only kyc_checks table (NOT latest-only)
 *   - All four products
 *   - Admin-only manual trigger (Q1)
 *   - Per-subject endpoints + batch sweep for directors (Q2)
 *   - Monitoring is admin-pick, NOT auto-enrol (Q3)
 *   - Per-check cost cap defends against pricing surprise
 * ============================================================
 */

const crypto = require('crypto');
const config = require('../config');

// ------------------------------------------------------------
// 1.  Base URL resolver
// ------------------------------------------------------------
function getBaseUrl() {
  if (config.SMARTSEARCH_MODE === 'live') return config.SMARTSEARCH_LIVE_BASE_URL;
  return config.SMARTSEARCH_TEST_BASE_URL; // 'test' and unknown fall through to test
}

// ------------------------------------------------------------
// 2.  Auth header builder
// ------------------------------------------------------------
function getAuthHeaders() {
  if (!config.SMARTSEARCH_USERNAME || !config.SMARTSEARCH_PASSWORD) {
    throw new Error('SmartSearch Basic Auth not configured — set SMARTSEARCH_USERNAME and SMARTSEARCH_PASSWORD');
  }
  if (!config.SMARTSEARCH_API_KEY) {
    throw new Error('SmartSearch API key not configured — set SMARTSEARCH_API_KEY');
  }
  const creds = `${config.SMARTSEARCH_USERNAME}:${config.SMARTSEARCH_PASSWORD}`;
  return {
    Authorization: `Basic ${Buffer.from(creds).toString('base64')}`,
    'X-API-Key': config.SMARTSEARCH_API_KEY,
  };
}

// ------------------------------------------------------------
// 3.  Cost cap guard — defensive
// ------------------------------------------------------------
function checkCostCap(expectedPence, productLabel) {
  if (expectedPence > config.SMARTSEARCH_MAX_PENCE_PER_CHECK) {
    return {
      success: false,
      error: `${productLabel} cost (${expectedPence}p) exceeds SMARTSEARCH_MAX_PENCE_PER_CHECK (${config.SMARTSEARCH_MAX_PENCE_PER_CHECK}p) — raise the cap if intentional`,
      data: null, status: null, raw: null, mode: config.SMARTSEARCH_MODE, cost_pence: 0,
    };
  }
  return null;
}

// ------------------------------------------------------------
// 4.  Low-level fetch — never throws, always returns standard shape
// ------------------------------------------------------------
async function ssFetch(path, { method = 'POST', body = null } = {}) {
  const url = `${getBaseUrl()}${path}`;
  const startedAt = Date.now();
  console.log(`[smartsearch] ${method} ${url} (mode=${config.SMARTSEARCH_MODE})`);

  try {
    const headers = {
      ...getAuthHeaders(),
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.SMARTSEARCH_TIMEOUT_MS),
    });

    const elapsed = Date.now() - startedAt;
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }

    console.log(`[smartsearch] ← ${response.status} in ${elapsed}ms (${text.length} bytes)`);

    if (!response.ok) {
      return {
        success: false,
        error: `SmartSearch ${response.status}: ${typeof data === 'object' ? JSON.stringify(data).substring(0, 240) : String(data).substring(0, 240)}`,
        data: null,
        status: response.status,
        raw: data,
        mode: config.SMARTSEARCH_MODE,
        cost_pence: 0,
      };
    }

    return {
      success: true,
      error: null,
      data,
      status: response.status,
      raw: data,
      mode: config.SMARTSEARCH_MODE,
      cost_pence: 0, // caller fills from product pricing
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const msg = err.name === 'TimeoutError'
      ? `SmartSearch request timed out after ${config.SMARTSEARCH_TIMEOUT_MS}ms`
      : `SmartSearch fetch failed: ${err.message}`;
    console.error(`[smartsearch] ✗ ${msg} (elapsed=${elapsed}ms)`);
    return {
      success: false,
      error: msg,
      data: null,
      status: null,
      raw: null,
      mode: config.SMARTSEARCH_MODE,
      cost_pence: 0,
    };
  }
}

// ------------------------------------------------------------
// 5.  MOCK fixtures — used when SMARTSEARCH_MODE === 'mock'
//     Mirrors the shape of real SmartSearch responses so downstream
//     code (parsers, packagers, frontend) can be built and tested
//     before the live channel opens.
// ------------------------------------------------------------
function mockIndividualKyc({ firstName = 'JOHN', lastName = 'SMITH', dob = '1980-01-15' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      check_type: 'individual_kyc',
      result_status: 'pass',
      result_score: 92,
      subject: { first_name: firstName, last_name: lastName, dob },
      summary: {
        electoral_roll_match: true,
        mortality_check: 'alive',
        address_match: true,
        documents_verified: 2,
        passport_check: 'verified',
        driving_licence_check: 'verified',
      },
    },
    raw: { _mock: true },
  };
}

function mockBusinessKyb({ companyNumber = '12345678', companyName = 'MOCK BORROWER LIMITED' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      check_type: 'business_kyb',
      result_status: 'pass',
      result_score: 88,
      subject: { company_number: companyNumber, company_name: companyName },
      summary: {
        incorporation_date: '2018-03-15',
        company_status: 'active',
        registered_office: 'MOCK REGISTERED OFFICE, LONDON, W1J 5NG',
        directors_count: 2,
        ubos_count: 1,
        directors: [
          { name: 'JANE DOE', dob_year: 1975, appointment_date: '2018-03-15' },
          { name: 'JOHN SMITH', dob_year: 1980, appointment_date: '2019-06-01' },
        ],
        ubos: [
          { name: 'JANE DOE', ownership_pct: 75 },
        ],
      },
    },
    raw: { _mock: true },
  };
}

function mockSanctionsPep({ firstName = 'JOHN', lastName = 'SMITH', dob = '1980-01-15' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      check_type: 'sanctions_pep',
      result_status: 'pass', // 'refer' if any hits
      result_score: 0,       // higher = more concerning
      subject: { first_name: firstName, last_name: lastName, dob },
      sanctions_hits: [],
      pep_hits: [],
      rca_hits: [],
      sip_hits: [],
      adverse_media: [],
      lists_checked: 1147,
      vendor: 'Dow Jones Watchlist',
    },
    raw: { _mock: true },
  };
}

function mockMonitoring({ checkId = 0 } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      check_type: 'ongoing_monitoring',
      result_status: 'pass',
      monitoring_id: `MOCK-MON-${checkId || Date.now()}`,
      enrolled_at: new Date().toISOString(),
      frequency: 'daily',
    },
    raw: { _mock: true },
  };
}

// ------------------------------------------------------------
// 6.  PUBLIC API
// ------------------------------------------------------------

/**
 * Run individual KYC (identity verification).
 * Chargeable in live mode (~£3-5).
 */
async function runIndividualKyc({ firstName, lastName, dob, address, postcode } = {}) {
  if (!firstName || !lastName || !dob) {
    return { success: false, error: 'firstName, lastName, dob required', data: null, status: null, raw: null, mode: config.SMARTSEARCH_MODE, cost_pence: 0 };
  }
  if (config.SMARTSEARCH_MODE === 'mock') {
    return mockIndividualKyc({ firstName, lastName, dob });
  }
  const expectedCost = 400; // ~£4 default; real pricing TBC
  const cap = checkCostCap(expectedCost, 'Individual KYC');
  if (cap) return cap;
  const result = await ssFetch('/checks/individual', {
    method: 'POST',
    body: { first_name: firstName, last_name: lastName, dob, address, postcode },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Run business KYB (company verification).
 * Chargeable in live mode (~£8-12).
 */
async function runBusinessKyb({ companyNumber, companyName } = {}) {
  if (!companyNumber && !companyName) {
    return { success: false, error: 'companyNumber or companyName required', data: null, status: null, raw: null, mode: config.SMARTSEARCH_MODE, cost_pence: 0 };
  }
  if (config.SMARTSEARCH_MODE === 'mock') {
    return mockBusinessKyb({ companyNumber, companyName });
  }
  const expectedCost = 1000; // ~£10 default
  const cap = checkCostCap(expectedCost, 'Business KYB');
  if (cap) return cap;
  const result = await ssFetch('/checks/business', {
    method: 'POST',
    body: { company_number: companyNumber, company_name: companyName },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Run sanctions + PEP + RCA + SIP + adverse media screening.
 * Chargeable in live mode (~£2).
 */
async function runSanctionsPep({ firstName, lastName, dob, address } = {}) {
  if (!firstName || !lastName) {
    return { success: false, error: 'firstName, lastName required', data: null, status: null, raw: null, mode: config.SMARTSEARCH_MODE, cost_pence: 0 };
  }
  if (config.SMARTSEARCH_MODE === 'mock') {
    return mockSanctionsPep({ firstName, lastName, dob });
  }
  const expectedCost = 200; // ~£2 default
  const cap = checkCostCap(expectedCost, 'Sanctions/PEP');
  if (cap) return cap;
  const result = await ssFetch('/checks/screening', {
    method: 'POST',
    body: { first_name: firstName, last_name: lastName, dob, address },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Enrol a passed check into ongoing monitoring.
 * SmartSearch will push updates to /api/webhooks/smartsearch when status changes.
 * Recurring fee in live mode (~£0.50/month/subject).
 */
async function enrolMonitoring({ checkId, vendorReference, frequency = 'daily' } = {}) {
  if (!checkId && !vendorReference) {
    return { success: false, error: 'checkId or vendorReference required', data: null, status: null, raw: null, mode: config.SMARTSEARCH_MODE, cost_pence: 0 };
  }
  if (config.SMARTSEARCH_MODE === 'mock') {
    return mockMonitoring({ checkId });
  }
  const expectedCost = 0; // Enrolment itself is free; monitoring is metered monthly
  const result = await ssFetch('/monitoring/enrol', {
    method: 'POST',
    body: { vendor_reference: vendorReference, frequency },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Verify HMAC signature on inbound webhook from SmartSearch.
 * Compute HMAC-SHA256(body) using SMARTSEARCH_WEBHOOK_SECRET, compare to header.
 *
 * @param {string|Buffer} rawBody - the raw request body bytes
 * @param {string} signatureHeader - value of the X-SmartSearch-Signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.SMARTSEARCH_WEBHOOK_SECRET) {
    console.warn('[smartsearch] SMARTSEARCH_WEBHOOK_SECRET not set — webhook verification will fail closed');
    return false;
  }
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', config.SMARTSEARCH_WEBHOOK_SECRET)
    .update(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody))
    .digest('hex');
  // Strip optional "sha256=" prefix that some vendors include
  const provided = signatureHeader.replace(/^sha256=/i, '').trim();
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch (_) {
    return false;
  }
}

/**
 * Convenience: extract the flat columns we persist on kyc_checks.
 * Matches the kyc_checks schema added in db/migrations.js.
 *
 * @param {object} apiData - the .data block from any of the run* methods
 * @param {string} checkType - 'individual_kyc' | 'business_kyb' | 'sanctions_pep' | 'ongoing_monitoring'
 * @returns {object} flat fields ready for INSERT
 */
function extractFlatFields(apiData, checkType) {
  if (!apiData || typeof apiData !== 'object') return {};
  const subject = apiData.subject || {};
  return {
    check_type: checkType || apiData.check_type || null,
    subject_first_name: subject.first_name || null,
    subject_last_name: subject.last_name || null,
    subject_dob: subject.dob || null,
    subject_address_jsonb: subject.address || null,
    subject_company_number: subject.company_number || null,
    subject_company_name: subject.company_name || null,
    result_status: apiData.result_status || null,
    result_score: typeof apiData.result_score === 'number' ? apiData.result_score : null,
    result_summary_jsonb: apiData.summary || null,
    result_raw_jsonb: apiData,
    sanctions_hits_jsonb: apiData.sanctions_hits || null,
    pep_hits_jsonb: apiData.pep_hits || null,
    rca_hits_jsonb: apiData.rca_hits || null,
    sip_hits_jsonb: apiData.sip_hits || null,
    adverse_media_jsonb: apiData.adverse_media || null,
  };
}

/**
 * Status check — used by /api/health and admin diagnostics.
 * Does NOT make a network call.
 */
function getStatus() {
  return {
    mode: config.SMARTSEARCH_MODE,
    base_url: getBaseUrl(),
    creds_configured: !!(config.SMARTSEARCH_USERNAME && config.SMARTSEARCH_PASSWORD),
    api_key_configured: !!config.SMARTSEARCH_API_KEY,
    webhook_secret_configured: !!config.SMARTSEARCH_WEBHOOK_SECRET,
    max_pence_per_check: config.SMARTSEARCH_MAX_PENCE_PER_CHECK,
  };
}

module.exports = {
  runIndividualKyc,
  runBusinessKyb,
  runSanctionsPep,
  enrolMonitoring,
  verifyWebhookSignature,
  extractFlatFields,
  getStatus,
};
