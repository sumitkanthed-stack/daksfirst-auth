/**
 * services/experian.js
 * ============================================================
 * Experian UK Credit Bureau REST client — 2026-04-27
 *
 * Three products (one method each):
 *   1. runCommercialDelphi  — UK SME/Ltd commercial credit score (0-100)
 *                             + recommended limit (£) + payment behaviour
 *                             + gazette filings (insolvency notices)
 *   2. runPersonalCredit    — Personal credit file (0-999 score)
 *                             + CCJs + bankruptcy + IVA + electoral roll
 *                             + defaults + gone-away markers
 *   3. runHunterFraud       — CIFAS fraud markers + identity-fraud flags
 *                             (bundled with Experian B2B)
 *
 * Three modes (EXPERIAN_MODE env var):
 *   - 'mock' : returns canned fixtures, no network call, no charge.
 *              DEFAULT — safe to leave on in production with no creds.
 *   - 'test' : hits Experian sandbox via OAuth2 Bearer token.
 *              No real charges; use realistic test subjects.
 *   - 'live' : hits Experian production and CHARGES per search.
 *              Per-product pricing varies; see EXPERIAN_MAX_PENCE_PER_SEARCH.
 *
 * Auth model: OAuth2 client_credentials grant. Token cached in-memory until
 * expiry. Modern Experian Connect API (preferred over legacy Bureau Gateway
 * Basic Auth — though we keep username/password fields for legacy fallback).
 *
 * All exported run* functions return the same fail-soft shape:
 *   { success: bool, error: string|null, data: object|null, status: int|null,
 *     raw: any, mode: 'mock'|'test'|'live', cost_pence: int }
 *
 * Sumit's architecture sign-off (2026-04-27):
 *   - Append-only credit_checks table (mirrors kyc_checks pattern)
 *   - Three products at launch (Commercial Delphi + Personal + Hunter)
 *   - Admin-only manual trigger (no auto-fire on borrower create)
 *   - Per-subject endpoints + batch sweep for parent + directors
 *   - Per-search cost cap defends against pricing surprise
 *   - Auth = data collector ONLY (results flow into risk packager
 *     <credit_data> block; no local rules/scoring)
 * ============================================================
 */

const config = require('../config');

// ------------------------------------------------------------
// 1.  Base URL resolver
// ------------------------------------------------------------
function getBaseUrl() {
  if (config.EXPERIAN_MODE === 'live') return config.EXPERIAN_LIVE_BASE_URL;
  return config.EXPERIAN_TEST_BASE_URL;
}

// ------------------------------------------------------------
// 2.  OAuth2 token cache — single shared token, refreshed on expiry
// ------------------------------------------------------------
let tokenCache = { access_token: null, expires_at: 0 };

async function getAccessToken() {
  const now = Date.now();
  // Refresh 60s before expiry to avoid edge races
  if (tokenCache.access_token && tokenCache.expires_at - 60000 > now) {
    return tokenCache.access_token;
  }
  if (!config.EXPERIAN_CLIENT_ID || !config.EXPERIAN_CLIENT_SECRET) {
    throw new Error('Experian OAuth not configured — set EXPERIAN_CLIENT_ID and EXPERIAN_CLIENT_SECRET');
  }
  const tokenUrl = `${config.EXPERIAN_AUTH_BASE_URL}/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.EXPERIAN_CLIENT_ID,
    client_secret: config.EXPERIAN_CLIENT_SECRET,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(config.EXPERIAN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Experian OAuth token fetch failed (${res.status}): ${errText.substring(0, 200)}`);
  }
  const json = await res.json();
  tokenCache = {
    access_token: json.access_token,
    expires_at: now + ((json.expires_in || 3600) * 1000),
  };
  console.log(`[experian] OAuth token acquired, expires in ${json.expires_in || 3600}s`);
  return tokenCache.access_token;
}

// ------------------------------------------------------------
// 3.  Cost cap guard — defensive
// ------------------------------------------------------------
function checkCostCap(expectedPence, productLabel) {
  if (expectedPence > config.EXPERIAN_MAX_PENCE_PER_SEARCH) {
    return {
      success: false,
      error: `${productLabel} cost (${expectedPence}p) exceeds EXPERIAN_MAX_PENCE_PER_SEARCH (${config.EXPERIAN_MAX_PENCE_PER_SEARCH}p) — raise the cap if intentional`,
      data: null, status: null, raw: null, mode: config.EXPERIAN_MODE, cost_pence: 0,
    };
  }
  return null;
}

// ------------------------------------------------------------
// 4.  Low-level fetch — never throws, always returns standard shape
// ------------------------------------------------------------
async function expFetch(path, { method = 'POST', body = null } = {}) {
  const url = `${getBaseUrl()}${path}`;
  const startedAt = Date.now();
  console.log(`[experian] ${method} ${url} (mode=${config.EXPERIAN_MODE})`);

  try {
    const token = await getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.EXPERIAN_TIMEOUT_MS),
    });

    const elapsed = Date.now() - startedAt;
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }

    console.log(`[experian] ← ${response.status} in ${elapsed}ms (${text.length} bytes)`);

    if (!response.ok) {
      return {
        success: false,
        error: `Experian ${response.status}: ${typeof data === 'object' ? JSON.stringify(data).substring(0, 240) : String(data).substring(0, 240)}`,
        data: null,
        status: response.status,
        raw: data,
        mode: config.EXPERIAN_MODE,
        cost_pence: 0,
      };
    }

    return {
      success: true,
      error: null,
      data,
      status: response.status,
      raw: data,
      mode: config.EXPERIAN_MODE,
      cost_pence: 0, // caller fills from product pricing
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const msg = err.name === 'TimeoutError'
      ? `Experian request timed out after ${config.EXPERIAN_TIMEOUT_MS}ms`
      : `Experian fetch failed: ${err.message}`;
    console.error(`[experian] ✗ ${msg} (elapsed=${elapsed}ms)`);
    return {
      success: false,
      error: msg,
      data: null,
      status: null,
      raw: null,
      mode: config.EXPERIAN_MODE,
      cost_pence: 0,
    };
  }
}

// ------------------------------------------------------------
// 5.  MOCK fixtures — used when EXPERIAN_MODE === 'mock'
//     Mirrors the shape of real Experian responses so downstream
//     code (parsers, packagers, frontend) can be built and tested
//     before the live channel opens.
// ------------------------------------------------------------
function mockCommercialDelphi({ companyNumber = '12345678', companyName = 'MOCK BORROWER LIMITED' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      product: 'commercial_delphi',
      result_status: 'clean', // clean | thin_file | adverse | decline
      result_grade: 'B',      // A/B/C/D/E
      credit_score: 76,       // 0-100 commercial Delphi
      recommended_limit_pence: 1500000, // £15,000
      subject: { company_number: companyNumber, company_name: companyName },
      summary: {
        incorporation_date: '2018-03-15',
        company_status: 'active',
        sic_codes: ['68209'], // Other letting and operating of own or leased real estate
        directors_count: 2,
        accounts_filed_to: '2025-03-31',
        accounts_overdue: false,
        confirmation_overdue: false,
      },
      payment_behaviour: {
        days_beyond_terms: 4,
        ccjs_12m: 0,
        ccjs_value_pence: 0,
        paydex_index: 78,
        trend_12m: 'stable',
      },
      gazette: [],
      adverse_summary: { count: 0, items: [] },
    },
    raw: { _mock: true },
  };
}

function mockPersonalCredit({ firstName = 'JOHN', lastName = 'SMITH', dob = '1980-01-15', postcode = 'W1J 5NG' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      product: 'personal_credit',
      result_status: 'clean',
      result_grade: 'A',
      credit_score: 870, // 0-999 Experian personal scale
      subject: { first_name: firstName, last_name: lastName, dob, postcode },
      summary: {
        electoral_roll_match: true,
        electoral_roll_years: 8,
        gone_away_flag: false,
        date_first_seen: '2010-04-01',
      },
      adverse: {
        ccj_count: 0,
        ccj_value_pence: 0,
        ccj_items: [],
        bankruptcy_flag: false,
        iva_flag: false,
        debt_relief_order: false,
        default_count: 0,
        default_value_pence: 0,
      },
      electoral_roll: [
        { address: 'MOCK ADDRESS 1, LONDON, W1J 5NG', from: '2018-04', to: 'present', match: 'exact' },
        { address: 'PRIOR ADDRESS, LONDON, W2 1AA', from: '2010-04', to: '2018-03', match: 'exact' },
      ],
    },
    raw: { _mock: true },
  };
}

function mockHunterFraud({ firstName = 'JOHN', lastName = 'SMITH', dob = '1980-01-15' } = {}) {
  return {
    success: true, error: null, status: 200, mode: 'mock', cost_pence: 0,
    data: {
      product: 'hunter_fraud',
      result_status: 'clean',
      result_grade: 'A',
      credit_score: null,
      subject: { first_name: firstName, last_name: lastName, dob },
      summary: {
        cifas_search_performed: true,
        cifas_match_count: 0,
        hunter_match_count: 0,
        velocity_alerts: 0,
      },
      fraud_markers: [],
      adverse_summary: { count: 0, items: [] },
    },
    raw: { _mock: true },
  };
}

// ------------------------------------------------------------
// 6.  PUBLIC API
// ------------------------------------------------------------

/**
 * Run Commercial Delphi on a UK Ltd / SPV.
 * Chargeable in live mode (~£12-20).
 */
async function runCommercialDelphi({ companyNumber, companyName } = {}) {
  if (!companyNumber && !companyName) {
    return { success: false, error: 'companyNumber or companyName required', data: null, status: null, raw: null, mode: config.EXPERIAN_MODE, cost_pence: 0 };
  }
  if (config.EXPERIAN_MODE === 'mock') {
    return mockCommercialDelphi({ companyNumber, companyName });
  }
  const expectedCost = 1500; // ~£15 default; real pricing TBC
  const cap = checkCostCap(expectedCost, 'Commercial Delphi');
  if (cap) return cap;
  const result = await expFetch('/business/v1/commercial-delphi', {
    method: 'POST',
    body: { company_number: companyNumber, company_name: companyName },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Run Personal Credit search on an individual (CCJ, bankruptcy, electoral roll).
 * Chargeable in live mode (~£3-8). Requires DPA-compliant consent in live mode.
 */
async function runPersonalCredit({ firstName, lastName, dob, address, postcode } = {}) {
  if (!firstName || !lastName || !dob) {
    return { success: false, error: 'firstName, lastName, dob required', data: null, status: null, raw: null, mode: config.EXPERIAN_MODE, cost_pence: 0 };
  }
  if (config.EXPERIAN_MODE === 'mock') {
    return mockPersonalCredit({ firstName, lastName, dob, postcode });
  }
  const expectedCost = 500; // ~£5 default
  const cap = checkCostCap(expectedCost, 'Personal Credit');
  if (cap) return cap;
  const result = await expFetch('/consumer/v1/credit-report', {
    method: 'POST',
    body: { first_name: firstName, last_name: lastName, dob, address, postcode },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Run Hunter fraud / CIFAS check on individual or company.
 * Chargeable in live mode (~£2-5). Bundled with Experian B2B account.
 */
async function runHunterFraud({ firstName, lastName, dob, address, companyNumber, companyName } = {}) {
  if (!firstName && !lastName && !companyNumber && !companyName) {
    return { success: false, error: 'subject required (individual or company)', data: null, status: null, raw: null, mode: config.EXPERIAN_MODE, cost_pence: 0 };
  }
  if (config.EXPERIAN_MODE === 'mock') {
    return mockHunterFraud({ firstName: firstName || 'COMPANY', lastName: lastName || (companyName || ''), dob });
  }
  const expectedCost = 300; // ~£3 default
  const cap = checkCostCap(expectedCost, 'Hunter Fraud');
  if (cap) return cap;
  const result = await expFetch('/fraud/v1/hunter', {
    method: 'POST',
    body: { first_name: firstName, last_name: lastName, dob, address, company_number: companyNumber, company_name: companyName },
  });
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Convenience: extract the flat columns we persist on credit_checks.
 * Matches the credit_checks schema added in db/migrations.js.
 *
 * @param {object} apiData - the .data block from any of the run* methods
 * @param {string} product - 'commercial_delphi' | 'personal_credit' | 'hunter_fraud'
 * @returns {object} flat fields ready for INSERT
 */
function extractFlatFields(apiData, product) {
  if (!apiData || typeof apiData !== 'object') return {};
  const subject = apiData.subject || {};
  const adverse = apiData.adverse || {};
  return {
    product: product || apiData.product || null,
    vendor: 'experian',
    subject_first_name: subject.first_name || null,
    subject_last_name: subject.last_name || null,
    subject_dob: subject.dob || null,
    subject_address_jsonb: subject.address || null,
    subject_company_number: subject.company_number || null,
    subject_company_name: subject.company_name || null,
    result_status: apiData.result_status || null,
    result_grade: apiData.result_grade || null,
    credit_score: typeof apiData.credit_score === 'number' ? apiData.credit_score : null,
    recommended_limit_pence: typeof apiData.recommended_limit_pence === 'number' ? apiData.recommended_limit_pence : null,
    result_summary_jsonb: apiData.summary || null,
    result_raw_jsonb: apiData,
    ccj_count: typeof adverse.ccj_count === 'number' ? adverse.ccj_count : null,
    ccj_value_pence: typeof adverse.ccj_value_pence === 'number' ? adverse.ccj_value_pence : null,
    ccj_jsonb: adverse.ccj_items || null,
    bankruptcy_flag: typeof adverse.bankruptcy_flag === 'boolean' ? adverse.bankruptcy_flag : null,
    iva_flag: typeof adverse.iva_flag === 'boolean' ? adverse.iva_flag : null,
    default_count: typeof adverse.default_count === 'number' ? adverse.default_count : null,
    default_value_pence: typeof adverse.default_value_pence === 'number' ? adverse.default_value_pence : null,
    electoral_roll_jsonb: apiData.electoral_roll || null,
    gone_away_flag: typeof (apiData.summary && apiData.summary.gone_away_flag) === 'boolean' ? apiData.summary.gone_away_flag : null,
    payment_behaviour_jsonb: apiData.payment_behaviour || null,
    gazette_jsonb: apiData.gazette || null,
    fraud_markers_jsonb: apiData.fraud_markers || null,
    hunter_match_count: typeof (apiData.summary && apiData.summary.hunter_match_count) === 'number' ? apiData.summary.hunter_match_count : null,
    adverse_jsonb: apiData.adverse_summary || null,
  };
}

/**
 * Status check — used by /api/health and admin diagnostics.
 * Does NOT make a network call.
 */
function getStatus() {
  return {
    mode: config.EXPERIAN_MODE,
    base_url: getBaseUrl(),
    auth_url: config.EXPERIAN_AUTH_BASE_URL,
    creds_configured: !!(config.EXPERIAN_CLIENT_ID && config.EXPERIAN_CLIENT_SECRET),
    token_cached: !!tokenCache.access_token,
    token_expires_at: tokenCache.expires_at ? new Date(tokenCache.expires_at).toISOString() : null,
    max_pence_per_search: config.EXPERIAN_MAX_PENCE_PER_SEARCH,
  };
}

module.exports = {
  runCommercialDelphi,
  runPersonalCredit,
  runHunterFraud,
  extractFlatFields,
  getStatus,
};
