/**
 * Property Auto-Search Service
 * Orchestrates three free UK property data APIs:
 *
 * 1. Postcodes.io        — geography, local authority, coordinates (free, no key)
 * 2. EPC Register         — energy performance, floor area, property type (free, needs API key)
 * 3. Land Registry PPD    — price paid history for valuation cross-check (free, open linked data)
 *
 * Each function returns a standardised result object with { success, data, error }.
 * The orchestrator runs all three in parallel and merges results.
 */

const config = require('../config');

// ═══════════════════════════════════════════════════════════════════════════
//  1. POSTCODES.IO — Geography & Local Authority
//     https://postcodes.io/docs
//     No API key. 100% free. No rate limit issues at our volume.
// ═══════════════════════════════════════════════════════════════════════════

async function lookupPostcode(postcode) {
  if (!postcode) return { success: false, error: 'No postcode provided' };

  const clean = postcode.replace(/\s+/g, '').toUpperCase();
  const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`;
  console.log(`[property-search] Postcodes.io GET ${clean}`);

  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      if (res.status === 404) return { success: false, error: `Postcode ${clean} not found` };
      return { success: false, error: `Postcodes.io returned ${res.status}` };
    }
    const json = await res.json();
    if (json.status !== 200 || !json.result) {
      return { success: false, error: 'Invalid response from Postcodes.io' };
    }

    const r = json.result;
    return {
      success: true,
      data: {
        postcode: r.postcode,
        region: r.region,
        country: r.country,
        admin_district: r.admin_district,       // e.g. "City of Westminster"
        admin_ward: r.admin_ward,
        parish: r.parish,
        parliamentary_constituency: r.parliamentary_constituency,
        latitude: r.latitude,
        longitude: r.longitude,
        // Lending-critical: England & Wales only
        in_england_or_wales: ['England', 'Wales'].includes(r.country),
        nuts: r.nuts,
        lsoa: r.lsoa,
        msoa: r.msoa,
      }
    };
  } catch (err) {
    console.error('[property-search] Postcodes.io error:', err.message);
    return { success: false, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  2. EPC REGISTER — Energy Performance Certificates
//     https://epc.opendatacommunities.org/docs/api
//     Free API key from: https://epc.opendatacommunities.org/login
//     Auth: Basic with email:apiKey, Accept: application/json
// ═══════════════════════════════════════════════════════════════════════════

async function lookupEPC(postcode, address) {
  const apiKey = config.EPC_API_KEY;
  const apiEmail = config.EPC_API_EMAIL;

  if (!apiKey || !apiEmail) {
    return { success: false, error: 'EPC_API_KEY or EPC_API_EMAIL not configured. Register free at https://epc.opendatacommunities.org/login' };
  }
  if (!postcode) return { success: false, error: 'No postcode for EPC lookup' };

  const clean = postcode.replace(/\s+/g, '').toUpperCase();
  // Search by postcode; optionally filter by address later
  const url = `https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${encodeURIComponent(clean)}&size=100`;
  const auth = Buffer.from(`${apiEmail}:${apiKey}`).toString('base64');

  console.log(`[property-search] EPC Register GET postcode=${clean}`);

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000
    });

    if (!res.ok) {
      if (res.status === 401) return { success: false, error: 'EPC API authentication failed — check EPC_API_KEY and EPC_API_EMAIL' };
      if (res.status === 404) return { success: false, error: `No EPC records for postcode ${clean}` };
      return { success: false, error: `EPC API returned ${res.status}` };
    }

    const json = await res.json();
    const rows = json.rows || [];

    if (rows.length === 0) {
      return { success: false, error: `No EPC certificates found for ${clean}` };
    }

    // Try to match by address if provided
    let bestMatch = rows[0]; // Default to first (most recent)
    if (address) {
      const addrLower = address.toLowerCase().replace(/[,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const addressTokens = addrLower.split(' ').filter(t => t.length > 2);

      let bestScore = 0;
      for (const row of rows) {
        const rowAddr = (row.address || '').toLowerCase().replace(/[,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
        let score = 0;
        for (const token of addressTokens) {
          if (rowAddr.includes(token)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = row;
        }
      }
    }

    return {
      success: true,
      data: {
        address: bestMatch.address,
        postcode: bestMatch.postcode,
        epc_rating: bestMatch['current-energy-rating'] || bestMatch.currentEnergyRating,
        epc_score: parseInt(bestMatch['current-energy-efficiency'] || bestMatch.currentEnergyEfficiency) || null,
        potential_rating: bestMatch['potential-energy-rating'] || bestMatch.potentialEnergyRating,
        potential_score: parseInt(bestMatch['potential-energy-efficiency'] || bestMatch.potentialEnergyEfficiency) || null,
        property_type: bestMatch['property-type'] || bestMatch.propertyType,
        built_form: bestMatch['built-form'] || bestMatch.builtForm,           // e.g. "Detached", "Semi-Detached"
        floor_area: parseFloat(bestMatch['total-floor-area'] || bestMatch.totalFloorArea) || null,  // sq metres
        construction_age: bestMatch['construction-age-band'] || bestMatch.constructionAgeBand,
        number_habitable_rooms: parseInt(bestMatch['number-habitable-rooms'] || bestMatch.numberHabitableRooms) || null,
        lodgement_date: bestMatch['lodgement-date'] || bestMatch.lodgementDate,
        inspection_date: bestMatch['inspection-date'] || bestMatch.inspectionDate,
        transaction_type: bestMatch['transaction-type'] || bestMatch.transactionType,
        lmk_key: bestMatch['lmk-key'] || bestMatch.lmkKey,                   // unique EPC certificate ID
        total_results: rows.length,
      }
    };
  } catch (err) {
    console.error('[property-search] EPC error:', err.message);
    return { success: false, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  3. LAND REGISTRY PRICE PAID — Historical Transaction Prices
//     https://landregistry.data.gov.uk/
//     Free SPARQL endpoint + REST-style linked data API
//     No API key needed.
// ═══════════════════════════════════════════════════════════════════════════

async function lookupPricePaid(postcode, address) {
  if (!postcode) return { success: false, error: 'No postcode for Price Paid lookup' };

  const clean = postcode.replace(/\s+/g, '').toUpperCase();

  // Use the Land Registry linked data API with SPARQL
  const sparql = `
    PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
    PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>

    SELECT ?paon ?saon ?street ?town ?county ?amount ?date ?type ?category ?status
    WHERE {
      ?tx lrppi:propertyAddress ?addr ;
          lrppi:pricePaid ?amount ;
          lrppi:transactionDate ?date ;
          lrppi:propertyType ?typeUri ;
          lrppi:transactionCategory ?catUri ;
          lrppi:recordStatus ?statusUri .

      ?addr lrcommon:postcode "${clean}" .

      OPTIONAL { ?addr lrcommon:paon ?paon }
      OPTIONAL { ?addr lrcommon:saon ?saon }
      OPTIONAL { ?addr lrcommon:street ?street }
      OPTIONAL { ?addr lrcommon:town ?town }
      OPTIONAL { ?addr lrcommon:county ?county }

      BIND(STRAFTER(STR(?typeUri), "http://landregistry.data.gov.uk/def/common/") AS ?type)
      BIND(STRAFTER(STR(?catUri), "http://landregistry.data.gov.uk/def/ppi/") AS ?category)
      BIND(STRAFTER(STR(?statusUri), "http://landregistry.data.gov.uk/def/ppi/") AS ?status)
    }
    ORDER BY DESC(?date)
    LIMIT 50
  `.trim();

  const url = `https://landregistry.data.gov.uk/app/root/qonsole/query?output=json&q=${encodeURIComponent(sparql)}`;

  console.log(`[property-search] Land Registry Price Paid SPARQL for ${clean}`);

  try {
    // Use the simpler REST endpoint first
    const restUrl = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(clean)}&_pageSize=50&_sort=-transactionDate`;

    const res = await fetch(restUrl, { timeout: 15000 });

    if (!res.ok) {
      return { success: false, error: `Land Registry API returned ${res.status}` };
    }

    const json = await res.json();
    const items = json.result?.items || [];

    if (items.length === 0) {
      return { success: false, error: `No price paid records for ${clean}` };
    }

    // Parse transactions
    const transactions = items.map(item => {
      const addr = item.propertyAddress || {};
      return {
        address: [addr.saon, addr.paon, addr.street, addr.town, addr.county].filter(Boolean).join(', '),
        postcode: addr.postcode || clean,
        price: item.pricePaid,
        date: item.transactionDate,
        property_type: _ppPropertyType(item.propertyType),
        new_build: item.newBuild === true,
        transaction_category: _ppCategory(item.transactionCategory),
      };
    });

    // Try to match by address
    let matched = transactions;
    if (address) {
      const addrLower = address.toLowerCase().replace(/[,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const tokens = addrLower.split(' ').filter(t => t.length > 2 && !clean.toLowerCase().includes(t));

      if (tokens.length > 0) {
        const scored = transactions.map(tx => {
          const txAddr = tx.address.toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (txAddr.includes(t)) score++;
          }
          return { ...tx, _score: score };
        });
        const maxScore = Math.max(...scored.map(s => s._score));
        if (maxScore > 0) {
          matched = scored.filter(s => s._score === maxScore).map(({ _score, ...rest }) => rest);
        }
      }
    }

    // Summary stats
    const prices = matched.map(t => t.price).filter(Boolean);
    const latest = matched[0] || null;

    return {
      success: true,
      data: {
        transactions: matched.slice(0, 10),   // Most recent 10 for this address
        total_postcode_results: transactions.length,
        address_matched_results: matched.length,
        latest_price: latest?.price || null,
        latest_date: latest?.date || null,
        latest_type: latest?.property_type || null,
        price_range: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      }
    };
  } catch (err) {
    console.error('[property-search] Price Paid error:', err.message);
    return { success: false, error: err.message };
  }
}

function _ppPropertyType(uri) {
  if (!uri) return null;
  const map = { 'detached': 'Detached', 'semi-detached': 'Semi-Detached', 'terraced': 'Terraced', 'flat-maisonette': 'Flat/Maisonette', 'other': 'Other' };
  const key = typeof uri === 'string' ? uri.split('/').pop().toLowerCase() : '';
  return map[key] || key;
}

function _ppCategory(uri) {
  if (!uri) return null;
  if (typeof uri === 'string' && uri.includes('additional')) return 'Additional Price Paid';
  return 'Standard Price Paid';
}


// ═══════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — Run all searches in parallel, merge results
// ═══════════════════════════════════════════════════════════════════════════

async function searchProperty(postcode, address) {
  console.log(`[property-search] ══ Starting property search: postcode=${postcode}, address=${(address || '').substring(0, 50)}...`);

  const startTime = Date.now();

  // Run all three in parallel
  const [postcodeResult, epcResult, pricePaidResult] = await Promise.all([
    lookupPostcode(postcode),
    lookupEPC(postcode, address),
    lookupPricePaid(postcode, address),
  ]);

  const elapsed = Date.now() - startTime;
  console.log(`[property-search] ══ Completed in ${elapsed}ms — postcode:${postcodeResult.success}, epc:${epcResult.success}, pricePaid:${pricePaidResult.success}`);

  return {
    searched_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    postcode_lookup: postcodeResult,
    epc: epcResult,
    price_paid: pricePaidResult,
    // Lending flags
    flags: {
      geography_ok: postcodeResult.success ? postcodeResult.data.in_england_or_wales : null,
      country: postcodeResult.success ? postcodeResult.data.country : null,
      local_authority: postcodeResult.success ? postcodeResult.data.admin_district : null,
    }
  };
}


module.exports = {
  lookupPostcode,
  lookupEPC,
  lookupPricePaid,
  searchProperty,
};
