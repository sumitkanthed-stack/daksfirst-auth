/**
 * Address Lookup — Ideal Postcodes (UK PAF) integration · PROP-1 (2026-04-29)
 *
 * Three modes (env var ADDRESS_LOOKUP_MODE):
 *   mock — returns canned data for a small set of test postcodes (default)
 *   test — hits Ideal Postcodes test endpoint with the test API key
 *   live — hits the production API; charges per lookup against PAYG balance
 *
 * Vendor: ideal-postcodes.co.uk
 *   API key in ENV: IDEAL_POSTCODES_API_KEY (ak_xxx format)
 *   Pricing: PAYG ~£0.04/lookup. First key has free test balance.
 *   Background: getAddress.io shut down Feb 2026 (PAF licensing dispute) —
 *   Ideal Postcodes is the clean PAF-licensed replacement.
 *
 * Functions:
 *   searchByPostcode(postcode)     — returns array of addresses on that postcode
 *   autocomplete(query)            — typeahead suggestions for partial address/postcode
 *   lookupByUDPRN(udprn)           — full address detail for a single UDPRN
 *
 * Each function returns a normalised envelope:
 *   { ok, mode, addresses: [...], cost_pence, raw }
 *
 * Mirrors services/chimnie.js + services/hmlr.js + services/smartsearch.js
 * pattern. Append-only: every successful lookup writes a row to
 * paf_lookups history table for audit (see PROP-2 migration).
 */

const IDEAL_POSTCODES_BASE = 'https://api.ideal-postcodes.co.uk/v1';
const COST_PER_LOOKUP_PENCE = 4;  // PAYG £0.04/lookup

/**
 * Resolve mode + API key from env. Default mock for safety — never accidentally
 * burn live API credits if env vars not set.
 */
function getConfig() {
  const mode = (process.env.ADDRESS_LOOKUP_MODE || 'mock').toLowerCase();
  const apiKey = process.env.IDEAL_POSTCODES_API_KEY || '';
  if ((mode === 'test' || mode === 'live') && !apiKey) {
    throw new Error(`address-lookup: ADDRESS_LOOKUP_MODE='${mode}' but IDEAL_POSTCODES_API_KEY not set`);
  }
  return { mode, apiKey };
}

// ─── Mock fixtures (used in mock mode) ───────────────────────────────────────
// Small cherry-picked set of UK postcodes we know are real for testing.
const MOCK_FIXTURES = {
  'W6 9RH': [
    {
      postcode: 'W6 9RH', line_1: '129 Rannoch Road', line_2: '', line_3: '',
      post_town: 'LONDON', county: 'GREATER LONDON',
      udprn: 12345001, uprn: '100021245001',
      latitude: 51.482876, longitude: -0.230101, country: 'England',
      thoroughfare: 'Rannoch Road', premise: '129',
    },
    {
      postcode: 'W6 9RH', line_1: '127 Rannoch Road', line_2: '', line_3: '',
      post_town: 'LONDON', county: 'GREATER LONDON',
      udprn: 12345002, uprn: '100021245002',
      latitude: 51.482880, longitude: -0.230120, country: 'England',
      thoroughfare: 'Rannoch Road', premise: '127',
    },
  ],
  'SW5 9SH': [
    {
      postcode: 'SW5 9SH', line_1: '62 Longridge Road', line_2: '', line_3: '',
      post_town: 'LONDON', county: 'GREATER LONDON',
      udprn: 12346001, uprn: '100021256001',
      latitude: 51.4937, longitude: -0.1925, country: 'England',
      thoroughfare: 'Longridge Road', premise: '62',
    },
  ],
  'W6 9SY': [
    {
      postcode: 'W6 9SY', line_1: 'Apartment No.82', line_2: '2 Bedroom River View',
      line_3: '', post_town: 'LONDON', county: 'GREATER LONDON',
      udprn: 12347001, uprn: '100021267001',
      latitude: 51.4825, longitude: -0.2298, country: 'England',
      thoroughfare: '', premise: 'Apartment No.82',
    },
  ],
};

function normalisePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]+\d[A-Z\d]?)(\d[A-Z]{2})$/, '$1 $2');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up all addresses on a postcode.
 * Returns: { ok, mode, postcode, addresses: [...], cost_pence, raw? }
 */
async function searchByPostcode(postcode) {
  const { mode, apiKey } = getConfig();
  const norm = normalisePostcode(postcode);
  if (!norm || !/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(norm)) {
    throw new Error(`address-lookup: invalid postcode '${postcode}'`);
  }

  if (mode === 'mock') {
    const addresses = MOCK_FIXTURES[norm] || [];
    return {
      ok: true, mode, postcode: norm,
      addresses,
      cost_pence: 0,
      raw: null,
    };
  }

  // test or live — both hit the same endpoint; the API key dictates billing
  const url = `${IDEAL_POSTCODES_BASE}/postcodes/${encodeURIComponent(norm)}?api_key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Daksfirst-Pricing/1.0' },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    return {
      ok: false, mode, postcode: norm,
      addresses: [], cost_pence: 0,
      error: json?.message || `HTTP ${resp.status}`,
      raw: json,
    };
  }
  return {
    ok: true, mode, postcode: norm,
    addresses: Array.isArray(json?.result) ? json.result : [],
    cost_pence: COST_PER_LOOKUP_PENCE,
    raw: mode === 'live' ? null : json, // strip raw in live to keep DB rows light
  };
}

/**
 * Autocomplete — typeahead suggestions for a partial address or postcode.
 * Cheaper than postcode lookup (counted as suggestion call, not full lookup).
 */
async function autocomplete(query) {
  const { mode, apiKey } = getConfig();
  if (!query || query.length < 2) {
    return { ok: true, mode, suggestions: [], cost_pence: 0 };
  }

  if (mode === 'mock') {
    // Return matches from our mock fixtures
    const q = query.toUpperCase();
    const suggestions = [];
    for (const [pc, addrs] of Object.entries(MOCK_FIXTURES)) {
      if (pc.replace(/\s/g, '').includes(q.replace(/\s/g, ''))) {
        for (const a of addrs) {
          suggestions.push({
            suggestion: `${a.line_1}, ${a.post_town}, ${pc}`,
            udprn: a.udprn,
            urls: { udprn: `mock://${a.udprn}` },
          });
        }
      } else {
        for (const a of addrs) {
          if (a.line_1.toUpperCase().includes(q) || a.thoroughfare.toUpperCase().includes(q)) {
            suggestions.push({
              suggestion: `${a.line_1}, ${a.post_town}, ${pc}`,
              udprn: a.udprn,
              urls: { udprn: `mock://${a.udprn}` },
            });
          }
        }
      }
    }
    return { ok: true, mode, suggestions: suggestions.slice(0, 10), cost_pence: 0 };
  }

  const url = `${IDEAL_POSTCODES_BASE}/autocomplete/addresses?query=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { ok: false, mode, suggestions: [], cost_pence: 0, error: json?.message || `HTTP ${resp.status}` };
  }
  return {
    ok: true, mode,
    suggestions: json?.result?.hits || [],
    cost_pence: 0, // autocomplete is free / bundled
  };
}

/**
 * Resolve a single address by UDPRN (returned from autocomplete suggestions).
 * Charges 1 lookup against the balance.
 */
async function lookupByUDPRN(udprn) {
  const { mode, apiKey } = getConfig();
  if (!udprn) throw new Error('address-lookup: udprn required');

  if (mode === 'mock') {
    for (const addrs of Object.values(MOCK_FIXTURES)) {
      const found = addrs.find(a => String(a.udprn) === String(udprn));
      if (found) {
        return { ok: true, mode, address: found, cost_pence: 0, raw: null };
      }
    }
    return { ok: false, mode, address: null, cost_pence: 0, error: `Mock UDPRN ${udprn} not found` };
  }

  const url = `${IDEAL_POSTCODES_BASE}/udprn/${encodeURIComponent(udprn)}?api_key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { ok: false, mode, address: null, cost_pence: 0, error: json?.message || `HTTP ${resp.status}` };
  }
  return {
    ok: true, mode,
    address: json?.result || null,
    cost_pence: COST_PER_LOOKUP_PENCE,
    raw: mode === 'live' ? null : json,
  };
}

module.exports = {
  searchByPostcode,
  autocomplete,
  lookupByUDPRN,
  // exported for tests:
  normalisePostcode,
  COST_PER_LOOKUP_PENCE,
};
