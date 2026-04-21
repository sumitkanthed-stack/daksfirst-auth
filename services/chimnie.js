/**
 * Chimnie Property Intelligence API Service
 * https://docs.chimnie.com  |  https://api.chimnie.com  (v7.6.0)
 *
 * Provides a comprehensive property data dossier per UK residential property —
 * ~300+ fields covering AVM, comps, rental estimate, rebuild cost, ownership,
 * flood risk, crime, EPC, planning, education, transport, environment, and
 * 2021 census demographics.
 *
 * Integration pattern follows services/companies-house.js:
 *   - fail-soft (return {success:false, error} rather than throw)
 *   - timeouts via AbortSignal.timeout
 *   - log every call for audit/troubleshooting
 *
 * Auth: `?api_key=XXX` as query parameter (not Bearer, not X-API-Key).
 *   Verified 2026-04-21 against real endpoint responses (401 on bogus key,
 *   matches the docs example URL `/residential/uprn/{UPRN}?api_key=YOUR_API_KEY`).
 *
 * Endpoint inventory (partial — probed live, Phase 1 uses first 3):
 *   GET  /residential/uprn/{UPRN}                  — by UPRN (paid)
 *   GET  /residential/address/{urlenc address}     — by full address (paid)
 *   GET  /residential/autocomplete/{partial}       — autocomplete (cheap, session)
 *   GET  /info/residential-property-response-schema.json  — schema (free)
 *   GET  /info/metadata                            — version info (free)
 *   GET  /info/credits                             — remaining credits (auth req)
 *
 * Response shape: see /info/residential-property-response-schema.json
 *   Top-level keys: id, exact_match, property, premium, plus, surroundings
 */

const config = require('../config');

// ─── Internal fetch helper ───────────────────────────────────────────────────

/**
 * All paid endpoints require `?api_key=XXX`. This helper appends the key to
 * the given path, fires the request with timeout, and normalises errors into
 * {success, error, data} shape so callers never have to try/catch HTTP.
 *
 * @param {string} path  e.g. "/residential/uprn/100023336956"
 * @param {object} [queryParams]  additional query params to merge in
 * @returns {Promise<{success:boolean, status?:number, data?:any, error?:string, raw?:string}>}
 */
async function chimnieFetch(path, queryParams = {}) {
  const apiKey = config.CHIMNIE_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'CHIMNIE_API_KEY not configured' };
  }

  // Merge api_key into query params so every paid endpoint is authenticated
  const params = new URLSearchParams({ ...queryParams, api_key: apiKey });
  const url = `${config.CHIMNIE_BASE_URL}${path}?${params.toString()}`;
  // Redact api_key in logs
  const redactedUrl = url.replace(/api_key=[^&]+/, 'api_key=REDACTED');
  console.log(`[chimnie] GET ${redactedUrl}`);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(config.CHIMNIE_TIMEOUT_MS)
    });

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* keep raw */ }

    if (res.status === 401) {
      return { success: false, status: 401, error: 'Chimnie 401: API key rejected', raw: text };
    }
    if (res.status === 402 || res.status === 429) {
      // 402 Payment Required or 429 Rate Limited — either out of credits or throttled
      return { success: false, status: res.status, error: `Chimnie ${res.status}: ${data?.message || text}`, raw: text };
    }
    if (res.status === 404) {
      // 404 on property lookup = not found (not an error condition for UW)
      return { success: false, status: 404, error: 'Property not found', raw: text };
    }
    if (!res.ok) {
      return { success: false, status: res.status, error: `Chimnie ${res.status}: ${data?.message || res.statusText}`, raw: text };
    }

    return { success: true, status: res.status, data };
  } catch (err) {
    // Network error / timeout / DNS fail
    const errorMsg = err.name === 'TimeoutError'
      ? `Chimnie timeout after ${config.CHIMNIE_TIMEOUT_MS}ms`
      : `Chimnie network error: ${err.message}`;
    return { success: false, error: errorMsg };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Lookup a property by its UPRN. Paid endpoint — costs credits.
 *
 * @param {string|number} uprn  UK Unique Property Reference Number
 * @returns {Promise<{success, data?, error?}>}
 */
async function lookupByUprn(uprn) {
  if (!uprn) return { success: false, error: 'UPRN required' };
  const cleanUprn = String(uprn).replace(/\D/g, ''); // strip non-digits
  if (!cleanUprn) return { success: false, error: 'UPRN must contain digits' };
  return chimnieFetch(`/residential/uprn/${cleanUprn}`);
}

/**
 * Lookup a property by address string. Paid endpoint — costs credits.
 *
 * The address can be the full address line including postcode, e.g.
 * "82 King Henrys Reach, London, W6 9RH". Chimnie handles fuzzy matching
 * and returns exact_match=false if the match wasn't unambiguous.
 *
 * @param {string} address  full address, URL-encoded internally
 * @returns {Promise<{success, data?, error?}>}
 */
async function lookupByAddress(address) {
  if (!address || typeof address !== 'string') {
    return { success: false, error: 'Address string required' };
  }
  const trimmed = address.trim();
  if (!trimmed) return { success: false, error: 'Address cannot be empty' };
  // URL-encode the address — Chimnie accepts spaces as %20 in the path segment
  const encoded = encodeURIComponent(trimmed);
  return chimnieFetch(`/residential/address/${encoded}`);
}

/**
 * Autocomplete partial address string. Session-scoped for cost efficiency —
 * pass the same session id across subsequent keystrokes within one picker
 * session so Chimnie can charge once for the whole search.
 *
 * @param {string} partial  at least 2 chars
 * @param {string} [sessionId]  optional session id (returned from the first call)
 * @returns {Promise<{success, data?, error?}>}
 */
async function autocompleteAddress(partial, sessionId) {
  if (!partial || partial.length < 2) {
    return { success: false, error: 'Partial address must be at least 2 characters' };
  }
  const encoded = encodeURIComponent(partial.trim());
  const query = sessionId ? { session: sessionId } : {};
  return chimnieFetch(`/residential/autocomplete/${encoded}`, query);
}

/**
 * Get remaining Chimnie credit balance for the account. Used for the monthly
 * spend cap check and to display balance in the admin UI.
 *
 * @returns {Promise<{success, credits?, raw?, error?}>}
 */
async function getRemainingCredits() {
  const result = await chimnieFetch('/info/credits');
  if (!result.success) return result;
  // Response shape not yet verified — probably { credits: number } or similar.
  // Return raw payload so the caller can inspect when we first hit the endpoint.
  return { success: true, credits: result.data, raw: result.data };
}

/**
 * Get API version metadata. Free endpoint — no auth required.
 * @returns {Promise<{success, version?, error?}>}
 */
async function getApiMetadata() {
  const apiKey = config.CHIMNIE_API_KEY;
  const url = `${config.CHIMNIE_BASE_URL}/info/metadata`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(config.CHIMNIE_TIMEOUT_MS)
    });
    if (!res.ok) return { success: false, error: `Chimnie metadata ${res.status}` };
    const data = await res.json();
    return { success: true, version: data.version, raw: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Field extraction helpers ────────────────────────────────────────────────

/**
 * Walk a deep-nested object path safely. `get(obj, 'a.b.c')` returns undefined
 * if any link is missing instead of throwing. Mirrors lodash _.get minus deps.
 */
function get(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Given a full Chimnie residential property response, extract the subset of
 * fields that get promoted to flat indexed columns on deal_properties. The
 * full payload continues to live in chimnie_data JSONB for deep queries.
 *
 * Field paths sourced from the /info/residential-property-response-schema.json
 * (Draft 2020-12) and verified via Wiseguy on 2026-04-21.
 *
 * @param {object} data  full Chimnie property response
 * @returns {object} flat object suitable for SQL INSERT/UPDATE
 */
function extractFlatFields(data) {
  if (!data) return {};
  return {
    chimnie_uprn: data.id || null,
    chimnie_exact_match: typeof data.exact_match === 'boolean' ? data.exact_match : null,

    // Classification + type
    chimnie_classification: get(data, 'property.attributes.classification') || null,
    chimnie_property_type: get(data, 'property.attributes.property_type_predicted') || null,
    chimnie_property_subtype: get(data, 'plus.property.attributes.status.property_subtype') || null,
    chimnie_region: get(data, 'plus.property.attributes.status.region') || null,
    chimnie_postcode: get(data, 'plus.property.attributes.status.postcode') || null,

    // Dimensions (prefer declared+predicted, fall back to declared-only)
    chimnie_bedrooms: get(data, 'property.attributes.indoor.bedrooms_declared_and_predicted')
                   ?? get(data, 'property.attributes.indoor.bedrooms_declared_only')
                   ?? null,
    chimnie_bathrooms: get(data, 'property.attributes.indoor.bathrooms_declared_and_predicted')
                    ?? get(data, 'property.attributes.indoor.bathrooms_declared_only')
                    ?? null,
    chimnie_floor_area_sqm: get(data, 'property.attributes.indoor.floor_area_declared_and_predicted')
                         ?? get(data, 'property.attributes.indoor.floor_area_declared_only')
                         ?? null,

    // AVM (Valuation - Sale)
    chimnie_avm_mid: get(data, 'property.value.sale.property_value') || null,
    chimnie_avm_low: get(data, 'property.value.sale.property_value_range.0') || null,
    chimnie_avm_high: get(data, 'property.value.sale.property_value_range.1') || null,
    chimnie_avm_confidence: get(data, 'property.value.sale.property_value_confidence') || null,
    chimnie_last_sale_price: get(data, 'property.value.sale.last_transaction_price') || null,
    chimnie_last_sale_date: get(data, 'property.value.sale.last_transaction_date') || null,
    chimnie_years_owned: get(data, 'property.value.sale.years_owned') || null,

    // Rental
    chimnie_rental_pcm: get(data, 'property.value.rental.rental_value_pcm') || null,

    // Ownership (lending-critical flags)
    chimnie_lease_type: get(data, 'property.ownership.lease_type') || null,
    chimnie_overseas_ownership: get(data, 'property.ownership.overseas_ownership') ?? null,
    chimnie_company_ownership: get(data, 'property.ownership.company_ownership') ?? null,
    chimnie_occupancy_status: get(data, 'property.ownership.occupancy_status') || null,

    // Building attributes (UW gates)
    chimnie_is_listed: get(data, 'property.attributes.status.listed_building.is_listed') ?? null,
    chimnie_construction_material: get(data, 'property.attributes.status.frame_construction_material_declared_and_predicted') || null,
    chimnie_date_of_construction: get(data, 'property.attributes.status.date_of_construction_declared_and_predicted') || null,

    // Flood risk (lending-critical)
    chimnie_flood_risk_rivers_sea: get(data, 'surroundings.environment.flood.flood_risk_rivers_sea') ?? null,
    chimnie_flood_risk_surface_water: get(data, 'surroundings.environment.flood.flood_risk_surface_water') ?? null,
    chimnie_flood_risk_surface_cat: get(data, 'surroundings.environment.flood.risk_category_surface_water') || null,

    // Crime
    chimnie_crime_percentile_total: get(data, 'surroundings.safety.crime.crime_percentile.total') ?? null,

    // Bills
    chimnie_council_tax_band: get(data, 'property.bills.tax.council_tax_band_declared_and_predicted')
                           ?? get(data, 'property.bills.tax.council_tax_band_declared_only')
                           ?? null,
    chimnie_epc_current: get(data, 'property.bills.energy.current_energy_rating_declared_and_predicted')
                      ?? get(data, 'property.bills.energy.current_energy_rating_declared_only')
                      ?? null,
    chimnie_epc_potential: get(data, 'property.bills.energy.potential_energy_rating_declared_and_predicted')
                        ?? get(data, 'property.bills.energy.potential_energy_rating_declared_only')
                        ?? null,

    // Rebuild cost (for insurance reinstatement clause)
    chimnie_rebuild_cost_estimate: get(data, 'premium.property.value.rebuild.estimated_rebuild_cost.estimate') || null,

    // Transit — nearest train/TFL station. Chimnie does NOT provide PTAL; we'll
    // compute that separately from TfL's free PTAL dataset in Phase 2.
    // Confirmed by Wiseguy 2026-04-21: only `nearest_train_station.distance` available.
    chimnie_nearest_station_name: get(data, 'surroundings.facilities.transport.nearest_train_station.name') || null,
    chimnie_nearest_station_distance_m: get(data, 'surroundings.facilities.transport.nearest_train_station.distance') || null,

    // ═══ Area Intelligence (2026-04-21) ═══
    // Location — check both nested paths. Verified 2026-04-21 that some fields
    // live under `property.attributes.status.*` not just `property.attributes.*`.
    chimnie_local_authority: get(data, 'property.attributes.ltla')
                          ?? get(data, 'property.attributes.status.ltla')
                          ?? null,
    chimnie_postcode_district: get(data, 'plus.property.attributes.status.postcode_district') || null,
    chimnie_is_urban: (() => {
      const v = get(data, 'property.attributes.is_urban') ?? get(data, 'property.attributes.status.is_urban');
      return typeof v === 'boolean' ? v : null;
    })(),

    // Sales market velocity — drives exit-via-sale viability
    chimnie_area_sales_12m: get(data, 'surroundings.values.sale.sales_nearby_12m') ?? null,
    chimnie_area_sales_yoy: get(data, 'surroundings.values.sale.sales_yoy') ?? null,
    chimnie_area_price_per_sqft: get(data, 'surroundings.values.sale.price_per_sqft') ?? null,
    chimnie_area_days_to_sell: get(data, 'surroundings.values.sale.days_to_sell') ?? null,
    chimnie_area_avg_years_owned: get(data, 'surroundings.values.sale.average_years_owned') ?? null,
    // Rental market velocity — BTL exit viability
    chimnie_area_days_to_rent: get(data, 'surroundings.values.rental.days_to_rent') ?? null,

    // Wealth percentiles (higher = wealthier). Chimnie uses `_score` for percentile 0-100.
    chimnie_wealth_pct_national: get(data, 'premium.ownership.household_wealth_percentile.total_score') ?? null,
    chimnie_wealth_pct_local_authority: get(data, 'premium.ownership.household_wealth_percentile.local_authority_score') ?? null,
    chimnie_wealth_pct_postcode_district: get(data, 'premium.ownership.household_wealth_percentile.postcode_district_score') ?? null,
    chimnie_total_hhi_msoa: get(data, 'premium.ownership.total_hhi_msoa') ?? null,
    chimnie_disposable_hhi_msoa: get(data, 'premium.ownership.disposable_hhi_msoa') ?? null,

    // Schools — nearest primary + best nearby secondary
    chimnie_nearest_primary_name: get(data, 'surroundings.facilities.education.nearest_primary.name') || null,
    chimnie_nearest_primary_distance_m: get(data, 'surroundings.facilities.education.nearest_primary.distance') ?? null,
    chimnie_nearest_primary_ofsted: get(data, 'surroundings.facilities.education.nearest_primary.ofsted_rating') || null,
    chimnie_best_secondary_name: get(data, 'surroundings.facilities.education.best_nearby_secondary.name') || null,
    chimnie_best_secondary_distance_m: get(data, 'surroundings.facilities.education.best_nearby_secondary.distance') ?? null,
    chimnie_best_secondary_ofsted: get(data, 'surroundings.facilities.education.best_nearby_secondary.ofsted_rating') || null,
    chimnie_best_secondary_att8: get(data, 'surroundings.facilities.education.best_nearby_secondary.att8scr') ?? null,

    // Planning constraints — affect redevelopment / conversion / extension exits
    chimnie_in_green_belt: _boolOrNull(get(data, 'surroundings.environment.land.green_belt.affected')),
    chimnie_in_aonb: _boolOrNull(get(data, 'surroundings.environment.land.aonb.affected')),
    chimnie_near_historic_landfill: _boolOrNull(get(data, 'surroundings.environment.land.historic_landfill.affected')),
    chimnie_in_coal_mining_area: _boolOrNull(get(data, 'surroundings.environment.land.in_coal_mining_reporting_area')),
    chimnie_in_world_heritage: _boolOrNull(get(data, 'surroundings.environment.land.world_heritage_sites.affected')),
    chimnie_sssi_affected: _boolOrNull(get(data, 'surroundings.environment.land.sssi.affected')),
    chimnie_scheduled_monument_affected: _boolOrNull(get(data, 'surroundings.environment.land.scheduled_monuments.affected')),

    // 5-year value trajectory — compute % change from historical monthly series.
    // historical_property_values shape (from schema): object with monthly keys,
    // OR an array of {date, value} pairs. Handle both; return null if absent.
    chimnie_5y_value_change_pct: _computeFiveYearChange(get(data, 'property.value.sale.historical_property_values')),

    // ═══ Tier 1 + 2 (2026-04-21) ═══
    // Sale/ownership signals
    chimnie_sale_propensity: get(data, 'property.value.sale.sale_propensity') || null,
    chimnie_avg_proximal_value: get(data, 'property.value.sale.average_proximal_property_value') ?? null,
    chimnie_estimated_listing_value: get(data, 'property.value.sale.estimated_listing_sale_value') ?? null,
    chimnie_prebuild: _boolOrNull(get(data, 'property.attributes.prebuild')
                               ?? get(data, 'property.attributes.status.prebuild')),
    chimnie_has_farmland: _boolOrNull(get(data, 'property.outdoor.farmland')
                                  ?? get(data, 'property.attributes.outdoor.farmland')),
    // Flat-specific
    chimnie_flat_storey_count: get(data, 'property.attributes.status.flat_storey_count_declared_only')
                            ?? get(data, 'premium.property.attributes.status.flat_storey_count_declared_and_predicted')
                            ?? get(data, 'property.attributes.flat_storey_count')
                            ?? null,
    chimnie_estimated_floor_level: get(data, 'premium.property.attributes.status.estimated_floor_level') ?? null,
    // Outdoor value-add
    chimnie_has_garden: _boolOrNull(get(data, 'premium.property.outdoor.garden')
                                ?? get(data, 'property.outdoor.garden')
                                ?? get(data, 'property.attributes.outdoor.garden')),
    chimnie_grounds_area_sqm: get(data, 'premium.property.outdoor.grounds_area')
                           ?? get(data, 'premium.property.outdoor.size_of_grounds_declared_and_predicted')
                           ?? null,
    // Subsidence forecast (2030 / 2050 / 2080)
    chimnie_subsidence_risk_2030: get(data, 'surroundings.environment.subsidence.subsidence_risk.2030') || null,
    chimnie_subsidence_risk_2050: get(data, 'surroundings.environment.subsidence.subsidence_risk.2050') || null,
    chimnie_subsidence_risk_2080: get(data, 'surroundings.environment.subsidence.subsidence_risk.2080') || null,
    // Tree hazard — imminent subsidence trigger
    chimnie_tree_hazard_index: get(data, 'premium.property.outdoor.tree_hazard_index') ?? null,
    chimnie_closest_tree_distance_m: get(data, 'premium.property.outdoor.closest_tree_distance') ?? null,
    chimnie_closest_tree_height_m: get(data, 'premium.property.outdoor.closest_tree_height') ?? null,
    // Radon
    chimnie_radon_affected: _boolOrNull(get(data, 'surroundings.environment.land.radon.affected')),
    chimnie_radon_protection_level: get(data, 'surroundings.environment.land.radon.level_of_protection_required') || null,
    // Flood context
    chimnie_distance_from_coast_m: get(data, 'surroundings.environment.flood.distance_from_coast') ?? null,
    chimnie_distance_from_river_m: get(data, 'surroundings.environment.flood.distance_from_river') ?? null,
    chimnie_elevation_min_m: get(data, 'surroundings.environment.land.property_elevation_min') ?? null,
    chimnie_elevation_max_m: get(data, 'surroundings.environment.land.property_elevation_max') ?? null,
    // Noise
    chimnie_noise_road_db: get(data, 'surroundings.environment.noise.noise_road_db') ?? null,
    chimnie_noise_rail_db: get(data, 'surroundings.environment.noise.noise_rail_db') ?? null,
    chimnie_noise_air_db: get(data, 'surroundings.environment.noise.noise_air_db') ?? null,
    // Additional planning constraints
    chimnie_in_ancient_woodland: _boolOrNull(get(data, 'surroundings.environment.land.ancient_woodland.affected')),
    chimnie_in_common_land: _boolOrNull(get(data, 'surroundings.environment.land.common_land.affected')),
    chimnie_in_historic_parks: _boolOrNull(get(data, 'surroundings.environment.land.historic_parks_and_gardens.affected')),
    // University proximity
    chimnie_nearest_university_name: get(data, 'surroundings.facilities.education.nearest_university.name') || null,
    chimnie_nearest_university_distance_m: get(data, 'surroundings.facilities.education.nearest_university.distance') ?? null,
    // Rebuild cost tiers
    chimnie_rebuild_cost_basic: get(data, 'premium.value.rebuild.basic_finish_rebuild_cost_estimate') ?? null,
    chimnie_rebuild_cost_modern: get(data, 'premium.value.rebuild.modern_finish_rebuild_cost_estimate') ?? null,
    chimnie_rebuild_cost_luxury: get(data, 'premium.value.rebuild.luxury_finish_rebuild_cost_estimate') ?? null,
    // Connected property risk
    chimnie_connected_property_risk: get(data, 'premium.ownership.connected_property_risk') || null,
    chimnie_parent_uprn: (() => {
      const v = get(data, 'plus.property.attributes.status.parent_uprn');
      return v != null ? String(v) : null;
    })(),
    chimnie_sibling_uprn_count: (() => {
      const s = get(data, 'plus.property.attributes.status.sibling_uprns');
      return Array.isArray(s) ? s.length : null;
    })(),
    chimnie_subproperty_uprn_count: (() => {
      const s = get(data, 'plus.property.attributes.status.subproperties');
      return Array.isArray(s) ? s.length : null;
    })()
  };
}

// Coerce to boolean, preserving null when the source was truly absent.
function _boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}

// Compute % change from the earliest to latest value in a historical series.
// The TfL schema says "5-year history of predicted property value with monthly
// granularity" — format could be either an ordered array of [{date, value}] or
// an object keyed by YYYY-MM. Handle both.
function _computeFiveYearChange(hist) {
  if (!hist) return null;
  let values = [];
  if (Array.isArray(hist)) {
    // Array of {date, value} or {ym, v} — try common shapes
    values = hist
      .map(row => {
        if (!row) return null;
        const v = row.value ?? row.v ?? row.price ?? row[Object.keys(row)[1]];
        return (typeof v === 'number') ? v : (typeof v === 'string' ? parseFloat(v) : null);
      })
      .filter(v => v != null && isFinite(v));
  } else if (typeof hist === 'object') {
    // Object keyed by date
    values = Object.values(hist)
      .map(v => (typeof v === 'number') ? v : (typeof v === 'string' ? parseFloat(v) : null))
      .filter(v => v != null && isFinite(v));
  }
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (!first || first <= 0) return null;
  const pct = ((last - first) / first) * 100;
  return Math.round(pct * 100) / 100;  // 2dp
}

module.exports = {
  lookupByUprn,
  lookupByAddress,
  autocompleteAddress,
  getRemainingCredits,
  getApiMetadata,
  extractFlatFields,
  // Exposed for tests
  _chimnieFetch: chimnieFetch,
  _get: get
};
