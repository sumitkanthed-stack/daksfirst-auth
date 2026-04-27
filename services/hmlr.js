/**
 * services/hmlr.js
 * ============================================================
 * HM Land Registry Business Gateway REST client — 2026-04-27
 *
 * Three modes (HMLR_MODE env var):
 *   - 'mock' : returns canned fixtures, no network call, no charge.
 *              DEFAULT — safe to leave on in production with no creds.
 *   - 'test' : hits HMLR's bgtest sandbox via mTLS + Basic Auth.
 *              Uses the test SSL cert pair. No real charges.
 *   - 'live' : hits HMLR production and CHARGES the Daksfirst credit account.
 *              Each Official Copy = ~£7 (post Dec 2024 pricing).
 *
 * Auth (test + live):
 *   1. Mutual TLS — client cert + private key in https.Agent
 *   2. HTTP Basic — username:password header
 *
 * All exported functions return the same fail-soft shape:
 *   { success: bool, error: string|null, data: object|null, status: int|null,
 *     raw: any, mode: 'mock'|'test'|'live', cost_pence: int }
 *
 * Sumit's architecture sign-off (2026-04-27):
 *   - Latest pull only, persisted on deal_properties (Chimnie pattern)
 *   - Admin-only button + admin-only display
 *   - Per-pull cost cap (HMLR_MAX_PENCE_PER_PULL) blocks accidental premium calls
 * ============================================================
 */

const https = require('https');
const config = require('../config');

// ------------------------------------------------------------
// 1.  TLS agent — built lazily so missing certs don't crash boot
// ------------------------------------------------------------
let _httpsAgent = null;
function getHttpsAgent() {
  if (_httpsAgent) return _httpsAgent;
  if (!config.HMLR_CLIENT_CERT || !config.HMLR_CLIENT_KEY) {
    throw new Error('HMLR mTLS cert/key not configured — set HMLR_CLIENT_CERT and HMLR_CLIENT_KEY env vars');
  }
  _httpsAgent = new https.Agent({
    cert: config.HMLR_CLIENT_CERT,
    key: config.HMLR_CLIENT_KEY,
    passphrase: config.HMLR_CLIENT_KEY_PASSPHRASE || undefined,
    keepAlive: true,
  });
  return _httpsAgent;
}

// ------------------------------------------------------------
// 2.  Base URL resolver
// ------------------------------------------------------------
function getBaseUrl() {
  if (config.HMLR_MODE === 'live') return config.HMLR_LIVE_BASE_URL;
  return config.HMLR_TEST_BASE_URL; // 'test' and unknown modes fall through to test sandbox
}

// ------------------------------------------------------------
// 3.  Auth header builder
// ------------------------------------------------------------
function getAuthHeader() {
  if (!config.HMLR_USERNAME || !config.HMLR_PASSWORD) {
    throw new Error('HMLR Basic Auth not configured — set HMLR_USERNAME and HMLR_PASSWORD env vars');
  }
  const creds = `${config.HMLR_USERNAME}:${config.HMLR_PASSWORD}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

// ------------------------------------------------------------
// 4.  Low-level fetch — never throws, always returns the standard shape
// ------------------------------------------------------------
async function hmlrFetch(path, { method = 'GET', body = null } = {}) {
  const url = `${getBaseUrl()}${path}`;
  const startedAt = Date.now();

  // Redact creds for logs
  const safeUrl = url; // URL itself is safe; auth is in header
  console.log(`[hmlr] ${method} ${safeUrl} (mode=${config.HMLR_MODE})`);

  try {
    const headers = {
      Authorization: getAuthHeader(),
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      agent: getHttpsAgent(),
      signal: AbortSignal.timeout(config.HMLR_TIMEOUT_MS),
    });

    const elapsed = Date.now() - startedAt;
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }

    console.log(`[hmlr] ← ${response.status} in ${elapsed}ms (${text.length} bytes)`);

    if (!response.ok) {
      return {
        success: false,
        error: `HMLR ${response.status}: ${typeof data === 'object' ? JSON.stringify(data).substring(0, 240) : String(data).substring(0, 240)}`,
        data: null,
        status: response.status,
        raw: data,
        mode: config.HMLR_MODE,
        cost_pence: 0,
      };
    }

    return {
      success: true,
      error: null,
      data,
      status: response.status,
      raw: data,
      mode: config.HMLR_MODE,
      cost_pence: 0, // caller fills from product pricing table
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const msg = err.name === 'TimeoutError'
      ? `HMLR request timed out after ${config.HMLR_TIMEOUT_MS}ms`
      : `HMLR fetch failed: ${err.message}`;
    console.error(`[hmlr] ✗ ${msg} (elapsed=${elapsed}ms)`);
    return {
      success: false,
      error: msg,
      data: null,
      status: null,
      raw: null,
      mode: config.HMLR_MODE,
      cost_pence: 0,
    };
  }
}

// ------------------------------------------------------------
// 5.  MOCK fixtures — used when HMLR_MODE === 'mock'
//     Mirrors the shape of a real OC1 response so downstream code
//     (parsers, packagers, frontend) can be built and tested before
//     the live channel opens.
// ------------------------------------------------------------
function mockOfficialCopy({ titleNumber = 'NGL123456', address = 'MOCK PROPERTY' } = {}) {
  return {
    success: true,
    error: null,
    status: 200,
    mode: 'mock',
    cost_pence: 0,
    data: {
      title_number: titleNumber,
      class_of_title: 'Absolute',
      tenure: 'Freehold',
      address,
      proprietors: [
        {
          name: 'MOCK BORROWER LIMITED',
          company_number: '12345678',
          address: 'MOCK REGISTERED OFFICE, LONDON, W1J 5NG',
          date_of_proprietorship: '2018-03-15',
        },
      ],
      charges: [
        {
          rank: 1,
          chargee: 'MOCK BANK PLC',
          chargee_address: 'MOCK BANK HQ, LONDON',
          date_of_charge: '2018-03-15',
          deed_reference: 'MOCK-DEED-001',
        },
      ],
      restrictions: [
        {
          type: 'Form A',
          text: 'No disposition by a sole proprietor of the registered estate ...',
        },
      ],
      register_pdf_url: null, // real responses include a signed S3-style URL
      pulled_at: new Date().toISOString(),
    },
    raw: { _mock: true },
  };
}

function mockTitleSearch({ postcode = 'W1J 5NG' } = {}) {
  return {
    success: true,
    error: null,
    status: 200,
    mode: 'mock',
    cost_pence: 0,
    data: {
      postcode,
      results: [
        { title_number: 'NGL123456', address: '8 HILL STREET, LONDON, W1J 5NG', tenure: 'Freehold' },
      ],
    },
    raw: { _mock: true },
  };
}

// ------------------------------------------------------------
// 6.  PUBLIC API
// ------------------------------------------------------------

/**
 * Search for title number(s) by postcode + house number/name.
 * Used to discover the correct title before pulling an OC1.
 *
 * @param {object} args
 * @param {string} args.postcode  - e.g. "W1J 5NG"
 * @param {string} [args.houseNumber] - e.g. "8" or "FLAT 4"
 * @returns {Promise<object>} Standard shape
 */
async function searchTitleByAddress({ postcode, houseNumber } = {}) {
  if (!postcode) {
    return { success: false, error: 'postcode required', data: null, status: null, raw: null, mode: config.HMLR_MODE, cost_pence: 0 };
  }
  if (config.HMLR_MODE === 'mock') {
    return mockTitleSearch({ postcode });
  }
  // Real endpoint TBC after dev license signed — placeholder path
  const qs = new URLSearchParams({ postcode, ...(houseNumber ? { house: houseNumber } : {}) });
  return hmlrFetch(`/title-search?${qs.toString()}`);
}

/**
 * Pull an Official Copy of the Register (OC1) for a given title number.
 * THIS IS A CHARGEABLE CALL in live mode (~£7).
 *
 * @param {object} args
 * @param {string} args.titleNumber - e.g. "NGL123456"
 * @param {string} [args.address] - optional, used for mock fixtures only
 * @returns {Promise<object>} Standard shape with cost_pence populated
 */
async function getOfficialCopy({ titleNumber, address } = {}) {
  if (!titleNumber) {
    return { success: false, error: 'titleNumber required', data: null, status: null, raw: null, mode: config.HMLR_MODE, cost_pence: 0 };
  }
  if (config.HMLR_MODE === 'mock') {
    return mockOfficialCopy({ titleNumber, address });
  }
  // Defensive cost cap — fixed per-call price, but guard against pricing changes
  const expectedCost = 700; // £7.00 in pence (standard digital OC1, post Dec 2024)
  if (expectedCost > config.HMLR_MAX_PENCE_PER_PULL) {
    return {
      success: false,
      error: `OC1 cost (${expectedCost}p) exceeds HMLR_MAX_PENCE_PER_PULL (${config.HMLR_MAX_PENCE_PER_PULL}p) — raise the cap if intentional`,
      data: null, status: null, raw: null, mode: config.HMLR_MODE, cost_pence: 0,
    };
  }
  const result = await hmlrFetch(`/official-copy/register/${encodeURIComponent(titleNumber)}`);
  if (result.success) result.cost_pence = expectedCost;
  return result;
}

/**
 * Convenience: extract the flat columns we persist on deal_properties.
 * Matches the hmlr_* schema added in db/migrations.js.
 *
 * @param {object} apiResult - the .data block from getOfficialCopy()
 * @returns {object} flat fields ready for INSERT/UPDATE
 */
function extractFlatFields(apiData) {
  if (!apiData || typeof apiData !== 'object') return {};
  return {
    hmlr_title_number: apiData.title_number || null,
    hmlr_register_pdf_url: apiData.register_pdf_url || null,
    hmlr_register_raw_jsonb: apiData,
    hmlr_proprietors_jsonb: apiData.proprietors || null,
    hmlr_charges_jsonb: apiData.charges || null,
    hmlr_restrictions_jsonb: apiData.restrictions || null,
    hmlr_tenure: apiData.tenure || null,
    hmlr_class_of_title: apiData.class_of_title || null,
  };
}

/**
 * Status check — used by /api/health and admin diagnostics.
 * Does NOT make a network call.
 */
function getStatus() {
  return {
    mode: config.HMLR_MODE,
    base_url: getBaseUrl(),
    creds_configured: !!(config.HMLR_USERNAME && config.HMLR_PASSWORD),
    cert_configured: !!(config.HMLR_CLIENT_CERT && config.HMLR_CLIENT_KEY),
    max_pence_per_pull: config.HMLR_MAX_PENCE_PER_PULL,
  };
}

module.exports = {
  searchTitleByAddress,
  getOfficialCopy,
  extractFlatFields,
  getStatus,
};
