/**
 * PropertyData (propertydata.co.uk) integration · PD-1 (2026-04-29)
 *
 * Three modes (env PROPERTY_DATA_MODE): mock | test | live
 *   Default: mock (safe — never burns API credits without explicit live)
 *
 * Vendor: PropertyData
 *   API key: PROPERTY_DATA_API_KEY (env)
 *   Base: https://api.propertydata.co.uk
 *   Auth: ?key=xxx query param
 *   Plan: API 2k @ £28/mo (2,000 credits), each /rents call = 1 credit
 *
 * Functions:
 *   getRentalsByPostcode(postcode, beds?)  — postcode rental data, optional bed filter
 *   getYieldsByPostcode(postcode, value, rent_pcm) — gross/net yield calc
 *
 * Returned envelope (normalised, mirrors chimnie/hmlr/smartsearch pattern):
 *   {
 *     ok, mode,
 *     postcode,
 *     beds,
 *     asking_pcm: { avg, min, max, sample },
 *     achieved_pcm: { avg, min, max, sample },
 *     yield_gross_pct,
 *     cost_pence,
 *     raw,
 *   }
 */

const PD_BASE = 'https://api.propertydata.co.uk';
const COST_PER_LOOKUP_PENCE = 14;  // ~£0.014 per credit on API 2k plan

function getConfig() {
  const mode = (process.env.PROPERTY_DATA_MODE || 'mock').toLowerCase();
  const apiKey = process.env.PROPERTY_DATA_API_KEY || '';
  if ((mode === 'test' || mode === 'live') && !apiKey) {
    throw new Error(`property-data: PROPERTY_DATA_MODE='${mode}' but PROPERTY_DATA_API_KEY not set`);
  }
  return { mode, apiKey };
}

function normalisePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]+\d[A-Z\d]?)(\d[A-Z]{2})$/, '$1 $2');
}

// ─── Mock fixtures ───────────────────────────────────────────────────────
const MOCK_RENTAL = {
  'E14 9GR': {
    asking_pcm: { avg: 3300, min: 2800, max: 3600, sample: 47 },
    achieved_pcm: { avg: 2950, min: 2500, max: 3200, sample: 32 },
    yield_gross_pct: 6.15,
  },
  'W6 9RH': {
    asking_pcm: { avg: 2800, min: 2400, max: 3200, sample: 28 },
    achieved_pcm: { avg: 2650, min: 2300, max: 3000, sample: 22 },
    yield_gross_pct: 4.85,
  },
  'SW5 9SH': {
    asking_pcm: { avg: 3500, min: 3000, max: 4200, sample: 19 },
    achieved_pcm: { avg: 3200, min: 2750, max: 3800, sample: 14 },
    yield_gross_pct: 5.20,
  },
};

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch postcode-level rental data from PropertyData /rents endpoint.
 * If `beds` is provided, narrows comparables to that bedroom count.
 */
async function getRentalsByPostcode(postcode, beds = null) {
  const { mode, apiKey } = getConfig();
  const norm = normalisePostcode(postcode);
  if (!norm || !/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(norm)) {
    throw new Error(`property-data: invalid postcode '${postcode}'`);
  }

  if (mode === 'mock') {
    const fixture = MOCK_RENTAL[norm];
    if (!fixture) {
      return {
        ok: true, mode, postcode: norm, beds,
        asking_pcm: { avg: null, min: null, max: null, sample: 0 },
        achieved_pcm: { avg: null, min: null, max: null, sample: 0 },
        yield_gross_pct: null,
        cost_pence: 0,
        raw: { mock: true, msg: `No mock fixture for ${norm}` },
      };
    }
    return { ok: true, mode, postcode: norm, beds, ...fixture, cost_pence: 0, raw: { mock: true } };
  }

  // test or live — both hit the real API
  const params = new URLSearchParams({ key: apiKey, postcode: norm });
  if (beds) params.append('bedrooms', String(beds));
  const url = `${PD_BASE}/rents?${params.toString()}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    return {
      ok: false, mode, postcode: norm, beds,
      asking_pcm: null, achieved_pcm: null, yield_gross_pct: null,
      cost_pence: 0,
      error: json?.error || `HTTP ${resp.status}`,
      raw: json,
    };
  }
  // PropertyData /rents response shape (typical):
  //   { status: 'success', data: { long_let: { '70pc_range': [low,high], '80pc_range': [...], average, median, samples }, short_let: {...} }, process_time, postcode }
  //
  // ⚠ UNIT — PropertyData /rents returns rents in £ per WEEK, not per month.
  // (Industry convention: agency feeds use £/wk; consumers think £/PCM.)
  // We convert to PCM using the standard formula: weekly × 52 / 12.
  // Verified 2026-04-29: smoke test on E14 9GR returned £535/wk = £2,318/PCM,
  // consistent with Canary Wharf 2-bed market median.
  const W2M = 52 / 12;
  const longLet = json?.data?.long_let || {};
  const samples = longLet.samples || 0;
  const askingAvgWeekly = longLet.average ?? null;
  const range = longLet['70pc_range'] || [null, null];
  const askingAvgPcm = askingAvgWeekly ? Math.round(askingAvgWeekly * W2M) : null;
  const askingMinPcm = range[0] ? Math.round(range[0] * W2M) : null;
  const askingMaxPcm = range[1] ? Math.round(range[1] * W2M) : null;
  // Achieved rents not directly published by /rents — approximate as asking × 0.92
  // (industry-typical asking-to-achieved discount). For real achieved rents
  // we'd need a separate endpoint or third-party source.
  return {
    ok: true, mode, postcode: norm, beds,
    asking_pcm: {
      avg: askingAvgPcm, min: askingMinPcm, max: askingMaxPcm,
      sample: samples,
    },
    achieved_pcm: {
      avg: askingAvgPcm ? Math.round(askingAvgPcm * 0.92) : null,
      min: askingMinPcm ? Math.round(askingMinPcm * 0.92) : null,
      max: askingMaxPcm ? Math.round(askingMaxPcm * 0.92) : null,
      sample: samples,  // same comp pool
    },
    yield_gross_pct: null,  // would need a value to compute; populated by /yields
    cost_pence: COST_PER_LOOKUP_PENCE,
    raw: mode === 'live' ? null : json,  // strip raw in live
  };
}

/**
 * Compute gross yield given a property value and monthly rent.
 * Hits PropertyData /yields endpoint. Returns yield_gross_pct.
 */
async function getYieldsByPostcode(postcode, propertyValue, monthlyRent) {
  const { mode, apiKey } = getConfig();
  const norm = normalisePostcode(postcode);
  if (mode === 'mock') {
    if (!propertyValue || !monthlyRent) return { ok: true, mode, yield_gross_pct: null, cost_pence: 0 };
    return {
      ok: true, mode,
      yield_gross_pct: Number(((monthlyRent * 12 / propertyValue) * 100).toFixed(2)),
      cost_pence: 0,
      raw: { mock: true },
    };
  }

  const params = new URLSearchParams({ key: apiKey, postcode: norm });
  if (propertyValue) params.append('value', String(propertyValue));
  if (monthlyRent) params.append('rent', String(monthlyRent));
  const url = `${PD_BASE}/yields?${params.toString()}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { ok: false, mode, yield_gross_pct: null, cost_pence: 0, error: json?.error || `HTTP ${resp.status}` };
  }
  return {
    ok: true, mode,
    yield_gross_pct: json?.data?.gross_yield ?? null,
    cost_pence: COST_PER_LOOKUP_PENCE,
    raw: mode === 'live' ? null : json,
  };
}

module.exports = {
  getRentalsByPostcode,
  getYieldsByPostcode,
  normalisePostcode,
  COST_PER_LOOKUP_PENCE,
};
