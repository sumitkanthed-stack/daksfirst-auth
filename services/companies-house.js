/**
 * Companies House API Service
 * https://developer.company-information.service.gov.uk
 *
 * Provides company verification for corporate borrowers:
 *  - Company profile (status, incorporation, address, SIC codes)
 *  - Officer list (directors, secretaries)
 *  - Persons with Significant Control (PSC — beneficial ownership for KYC)
 *  - Filing history (latest accounts, confirmation statements)
 *
 * Rate limit: 600 requests per 5 minutes (handled with retry-after)
 */

const config = require('../config');

const BASE_URL = 'https://api.company-information.service.gov.uk';

// ─── Internal fetch helper ───────────────────────────────────────────────────

async function chFetch(path, _retried = false) {
  const apiKey = config.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    throw new Error('COMPANIES_HOUSE_API_KEY not configured');
  }

  // Companies House uses HTTP Basic Auth: API key as username, no password
  const auth = Buffer.from(`${apiKey}:`).toString('base64');

  const url = `${BASE_URL}${path}`;
  console.log(`[companies-house] GET ${path}${_retried ? ' (retry)' : ''}`);

  // 2026-05-03 — single defensive retry on transient transport errors.
  // CONTINUITY backlog #3: search 1st-call sometimes fails (cold-start TLS
  // handshake / DNS blip / Render container scale-from-zero). Retry once
  // at 250ms covers this without masking real failures (4xx still throw,
  // 429 still throws to surface rate-limit, 404 still returns null).
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
  } catch (netErr) {
    if (!_retried) {
      console.warn(`[companies-house] Network error on ${path}: ${netErr.message}. Retrying once.`);
      await new Promise(r => setTimeout(r, 250));
      return chFetch(path, true);
    }
    throw netErr;
  }

  // 5xx — Companies House server-side transient. Single retry.
  if (res.status >= 500 && res.status < 600 && !_retried) {
    console.warn(`[companies-house] ${res.status} on ${path}. Retrying once.`);
    await new Promise(r => setTimeout(r, 250));
    return chFetch(path, true);
  }

  // Rate limited — log and throw (no retry; respect retry-after window)
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || '5';
    console.warn(`[companies-house] Rate limited. Retry after ${retryAfter}s`);
    throw new Error(`Rate limited by Companies House. Retry after ${retryAfter} seconds.`);
  }

  if (res.status === 404) {
    return null; // Company not found — not an error
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[companies-house] ${res.status} ${res.statusText}: ${body}`);
    throw new Error(`Companies House API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search for companies by name or number
 * @param {string} query - Company name or number
 * @returns {Array} Matching companies
 */
async function searchCompany(query) {
  const encoded = encodeURIComponent(query.trim());
  const data = await chFetch(`/search/companies?q=${encoded}&items_per_page=10`);
  if (!data || !data.items) return [];

  return data.items.map(item => ({
    company_number: item.company_number,
    company_name: item.title,
    company_status: item.company_status,
    company_type: item.company_type,
    date_of_creation: item.date_of_creation,
    address_snippet: item.address_snippet,
    description: item.description
  }));
}

/**
 * Get full company profile by company number
 * @param {string} companyNumber - e.g. "12345678"
 * @returns {Object|null} Company profile or null if not found
 */
async function getCompanyProfile(companyNumber) {
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}`);
  if (!data) return null;

  // Extract key fields for credit assessment
  const profile = {
    company_number: data.company_number,
    company_name: data.company_name,
    company_status: data.company_status,                   // active, dissolved, liquidation, etc.
    company_type: data.type,                                // ltd, plc, llp, etc.
    date_of_creation: data.date_of_creation,
    date_of_cessation: data.date_of_cessation || null,

    // Registered office
    registered_address: data.registered_office_address ? {
      line_1: data.registered_office_address.address_line_1 || '',
      line_2: data.registered_office_address.address_line_2 || '',
      locality: data.registered_office_address.locality || '',
      region: data.registered_office_address.region || '',
      postal_code: data.registered_office_address.postal_code || '',
      country: data.registered_office_address.country || ''
    } : null,

    // SIC codes (industry classification)
    sic_codes: data.sic_codes || [],

    // Accounts info
    accounts: data.accounts ? {
      next_due: data.accounts.next_due,
      last_made_up_to: data.accounts.last_accounts?.made_up_to || null,
      overdue: data.accounts.overdue || false
    } : null,

    // Confirmation statement
    confirmation_statement: data.confirmation_statement ? {
      next_due: data.confirmation_statement.next_due,
      last_made_up_to: data.confirmation_statement.last_made_up_to || null,
      overdue: data.confirmation_statement.overdue || false
    } : null,

    // Flags relevant to credit
    has_charges: data.has_charges || false,
    has_insolvency_history: data.has_insolvency_history || false,
    can_file: data.can_file || false,

    // Raw status detail
    jurisdiction: data.jurisdiction || null
  };

  // ── Credit risk flags ──
  profile.risk_flags = [];

  if (profile.company_status !== 'active') {
    profile.risk_flags.push({
      severity: 'critical',
      flag: `Company status: ${profile.company_status}`,
      detail: 'Company is not active — cannot be a borrower'
    });
  }

  if (profile.has_insolvency_history) {
    profile.risk_flags.push({
      severity: 'high',
      flag: 'Insolvency history',
      detail: 'Company has a history of insolvency proceedings'
    });
  }

  if (profile.accounts?.overdue) {
    profile.risk_flags.push({
      severity: 'medium',
      flag: 'Accounts overdue',
      detail: `Accounts overdue at Companies House (last filed: ${profile.accounts.last_made_up_to || 'unknown'})`
    });
  }

  if (profile.confirmation_statement?.overdue) {
    profile.risk_flags.push({
      severity: 'medium',
      flag: 'Confirmation statement overdue',
      detail: 'Annual confirmation statement is overdue'
    });
  }

  if (profile.has_charges) {
    profile.risk_flags.push({
      severity: 'info',
      flag: 'Has registered charges',
      detail: 'Company has charges registered — check for existing security'
    });
  }

  // Company age check
  if (profile.date_of_creation) {
    const created = new Date(profile.date_of_creation);
    const ageMonths = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24 * 30));
    if (ageMonths < 6) {
      profile.risk_flags.push({
        severity: 'high',
        flag: 'Newly incorporated',
        detail: `Company is only ${ageMonths} month${ageMonths !== 1 ? 's' : ''} old — phoenix company risk`
      });
    } else if (ageMonths < 24) {
      profile.risk_flags.push({
        severity: 'medium',
        flag: 'Young company',
        detail: `Company is ${ageMonths} months old — limited trading history`
      });
    }
    profile.age_months = ageMonths;
  }

  return profile;
}

/**
 * Extract the CH officer_id from an officer item.
 * Handles both response shapes:
 *   /company/{n}/officers  — item.links.officer.appointments
 *   /search/officers       — item.links.self  (already the .../appointments URL)
 *   /officers/{id}/appointments items — item.links.self also works
 * Used by getOfficers + searchOfficers (Sprint 5 #23/#24).
 */
function _extractOfficerId(item) {
  if (!item || !item.links) return null;
  const candidates = [
    item.links.officer && item.links.officer.appointments,
    item.links.self,
    item.links.officer
  ].filter(Boolean);
  for (const link of candidates) {
    const m = String(link).match(/\/officers\/([^/]+)(?:\/|$)/i);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Get officers (directors, secretaries) for a company
 * @param {string} companyNumber
 * @param {Object} [opts] - { includeResigned: boolean } default false
 * @returns {Array} Officers (active by default)
 */
async function getOfficers(companyNumber, opts) {
  const includeResigned = !!(opts && opts.includeResigned);
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}/officers?items_per_page=50`);
  if (!data || !data.items) return [];

  return data.items
    .filter(o => includeResigned || !o.resigned_on)
    .map(o => ({
      // Sprint 5 #23 — officer_id needed for downstream "Other Directorships" pulls
      officer_id: _extractOfficerId(o),
      name: o.name,
      officer_role: o.officer_role,           // director, secretary, llp-member, etc.
      appointed_on: o.appointed_on,
      resigned_on: o.resigned_on || null,
      nationality: o.nationality || null,
      country_of_residence: o.country_of_residence || null,
      occupation: o.occupation || null,
      date_of_birth: o.date_of_birth ? {
        month: o.date_of_birth.month,
        year: o.date_of_birth.year
      } : null,
      address: o.address ? {
        line_1: o.address.address_line_1 || '',
        locality: o.address.locality || '',
        postal_code: o.address.postal_code || '',
        country: o.address.country || ''
      } : null
    }));
}

/**
 * Sprint 5 #24 — Search Companies House for officers matching a name (and optional DoB).
 * Endpoint: /search/officers?q=...
 * @param {string} query - Officer name to search
 * @param {Object} [filter] - { dobYear, dobMonth } optional DoB filter applied client-side
 * @param {number} [limit] - max results (default 25, max 100)
 * @returns {Array} matching officers with officer_id, name, dob, current appointments
 */
async function searchOfficers(query, filter, limit) {
  const q = String(query || '').trim();
  if (!q) return [];
  const items_per_page = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const path = `/search/officers?q=${encodeURIComponent(q)}&items_per_page=${items_per_page}`;
  let data;
  try {
    data = await chFetch(path);
  } catch (err) {
    console.warn('[ch] searchOfficers failed for "' + q + '":', err.message);
    throw err;
  }
  if (!data || !Array.isArray(data.items)) return [];

  let rows = data.items.map(it => ({
    officer_id: _extractOfficerId(it),
    title: it.title || it.name || '',
    description: it.description || '',
    description_identifiers: it.description_identifiers || [],
    address_snippet: it.address_snippet || '',
    appointment_count: it.appointment_count || null,
    date_of_birth: it.date_of_birth ? {
      month: it.date_of_birth.month,
      year: it.date_of_birth.year
    } : null,
    matches: it.matches || null
  })).filter(r => r.officer_id);

  // Optional DoB filter (CH's API doesn't filter by DoB server-side)
  if (filter && filter.dobYear) {
    const y = parseInt(filter.dobYear, 10);
    const m = filter.dobMonth ? parseInt(filter.dobMonth, 10) : null;
    rows = rows.filter(r => {
      if (!r.date_of_birth) return false;
      if (r.date_of_birth.year !== y) return false;
      if (m && r.date_of_birth.month !== m) return false;
      return true;
    });
  }

  return rows;
}

/**
 * Get Persons with Significant Control (PSC) — beneficial ownership
 * Critical for KYC/AML
 * @param {string} companyNumber
 * @returns {Array} PSCs
 */
async function getPSCs(companyNumber) {
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}/persons-with-significant-control?items_per_page=50`);
  if (!data || !data.items) return [];

  return data.items
    .filter(p => !p.ceased_on) // Only active PSCs
    .map(p => ({
      name: p.name,
      kind: p.kind,                           // individual-person-with-significant-control, etc.
      notified_on: p.notified_on,
      nationality: p.nationality || null,
      country_of_residence: p.country_of_residence || null,
      date_of_birth: p.date_of_birth ? {
        month: p.date_of_birth.month,
        year: p.date_of_birth.year
      } : null,
      natures_of_control: p.natures_of_control || [],  // e.g. ["ownership-of-shares-25-to-50-percent"]
      // G5.3 Part A — preserve identification block for corporate PSCs (needed to recurse into the PSC's own CH record)
      identification: p.identification || null,
      address: p.address ? {
        line_1: p.address.address_line_1 || '',
        locality: p.address.locality || '',
        postal_code: p.address.postal_code || '',
        country: p.address.country || ''
      } : null
    }));
}

/**
 * Get recent filing history
 * @param {string} companyNumber
 * @param {number} count - Number of filings to return (default 10)
 * @returns {Array} Recent filings
 */
async function getFilingHistory(companyNumber, count = 10) {
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}/filing-history?items_per_page=${count}`);
  if (!data || !data.items) return [];

  return data.items.map(f => ({
    date: f.date,
    type: f.type,
    category: f.category,
    description: f.description,
    description_values: f.description_values || {}
  }));
}

/**
 * Get registered charges (mortgages, debentures)
 * Important for checking existing security
 * @param {string} companyNumber
 * @returns {Array} Charges
 */
async function getCharges(companyNumber) {
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}/charges?items_per_page=50`);
  if (!data || !data.items) return [];

  return data.items.map(c => ({
    charge_code: c.charge_code,
    status: c.status,                          // outstanding, fully-satisfied, part-satisfied
    created_on: c.created_on,
    delivered_on: c.delivered_on,
    satisfied_on: c.satisfied_on || null,
    persons_entitled: c.persons_entitled || [],
    particulars: c.particulars ? {
      type: c.particulars.type || '',
      description: c.particulars.description || '',
      contains_fixed_charge: c.particulars.contains_fixed_charge || false,
      contains_floating_charge: c.particulars.contains_floating_charge || false,
      floating_charge_covers_all: c.particulars.floating_charge_covers_all || false
    } : null,
    classification: c.classification ? {
      type: c.classification.type,
      description: c.classification.description
    } : null
  }));
}

/**
 * Full company verification — pulls everything in parallel
 * This is the main function called during deal submission
 * @param {string} companyNumber
 * @returns {Object} Complete verification report
 */
async function verifyCompany(companyNumber) {
  const num = companyNumber.trim().padStart(8, '0');
  const startTime = Date.now();

  console.log(`[companies-house] Full verification for ${num}`);

  // Fetch all data in parallel (5 API calls)
  const [profile, officers, pscs, filings, charges] = await Promise.all([
    getCompanyProfile(num),
    getOfficers(num),
    getPSCs(num),
    getFilingHistory(num, 10),
    getCharges(num)
  ]);

  if (!profile) {
    return {
      found: false,
      company_number: num,
      error: 'Company not found at Companies House',
      verified_at: new Date().toISOString()
    };
  }

  // Build verification summary
  const verification = {
    found: true,
    company_number: profile.company_number,
    company_name: profile.company_name,
    company_status: profile.company_status,
    company_type: profile.company_type,
    date_of_creation: profile.date_of_creation,
    age_months: profile.age_months,
    registered_address: profile.registered_address,
    sic_codes: profile.sic_codes,

    // KYC data
    officers: officers,
    director_count: officers.filter(o => o.officer_role === 'director').length,
    pscs: pscs,
    psc_count: pscs.length,

    // Financial health
    accounts: profile.accounts,
    confirmation_statement: profile.confirmation_statement,
    has_charges: profile.has_charges,
    has_insolvency_history: profile.has_insolvency_history,

    // Outstanding charges (important for existing security check)
    charges_outstanding: charges.filter(c => c.status === 'outstanding'),
    charges_total: charges.length,

    // Recent filings
    recent_filings: filings,

    // Credit risk flags
    risk_flags: profile.risk_flags,
    risk_score: calculateRiskScore(profile.risk_flags),

    // Metadata
    verified_at: new Date().toISOString(),
    api_time_ms: Date.now() - startTime,
    source: 'companies-house-api'
  };

  return verification;
}

/**
 * Calculate simple risk score from flags
 * @param {Array} flags
 * @returns {string} 'low' | 'medium' | 'high' | 'critical'
 */
function calculateRiskScore(flags) {
  if (!flags || flags.length === 0) return 'low';
  if (flags.some(f => f.severity === 'critical')) return 'critical';
  if (flags.some(f => f.severity === 'high')) return 'high';
  if (flags.filter(f => f.severity === 'medium').length >= 2) return 'high';
  if (flags.some(f => f.severity === 'medium')) return 'medium';
  return 'low';
}

// ════════════════════════════════════════════════════════════
// Sprint 3 #18 (2026-04-28) — Officer appointments + troublesome scoring
// ════════════════════════════════════════════════════════════

// Companies whose CH numbers we treat as competitor lenders. Director of any
// of these flags as 'competitor_lender' troublesome. Add or curate as needed.
const COMPETITOR_LENDER_CH_NUMBERS = [
  // Examples — replace with real numbers when you build the watchlist:
  // '12345678', // West One Loans
  // '87654321', // Together Financial
];

const TROUBLESOME_COMPANY_STATUSES = new Set([
  'dissolved',
  'liquidation',
  'in_administration',
  'receivership',
  'voluntary_arrangement',
  'converted_or_closed',
  'insolvency_proceedings'
]);

/**
 * Get all appointments (current + resigned) for a CH officer.
 *
 * @param {string} officerId — CH officer_id (NOT a company number; use the
 *   officer.links.officer.appointments value from /company/{n}/officers).
 * @returns {Promise<Array>} array of normalized appointment objects.
 */
async function getOfficerAppointments(officerId) {
  if (!officerId) return [];
  // CH endpoint: /officers/{officer_id}/appointments
  const path = '/officers/' + encodeURIComponent(officerId) + '/appointments';
  let raw;
  try {
    raw = await chFetch(path);
  } catch (err) {
    console.warn('[ch] getOfficerAppointments failed for ' + officerId + ':', err.message);
    return [];
  }
  const items = (raw && raw.items) || [];
  return items.map(it => {
    const company = it.appointed_to || {};
    const apptDate = it.appointed_on || null;
    const resignDate = it.resigned_on || null;
    const companyStatus = (company.company_status || '').toLowerCase();
    return {
      ch_officer_id: officerId,
      company_number: company.company_number || null,
      // 2026-04-30 fix: name_elements is the OFFICER's name, NOT a flag for missing
      // company name. Always read appointed_to.company_name. Previous logic
      // erroneously nulled company_name for any officer whose own name was structured.
      company_name: company.company_name || null,
      company_status: companyStatus,
      officer_role: (it.officer_role || '').toLowerCase(),
      appointment_date: apptDate,
      resignation_date: resignDate,
      raw_item: it
    };
  });
}

/**
 * Apply troublesome rules to a normalized appointment row. Returns an
 * array of reason strings (empty = clean). Used by the storage layer
 * before INSERT.
 *
 * Rules (rubric-relevant):
 *   - dissolved / liquidation / in_administration / receivership / etc.
 *   - phoenix_pattern: resigned within 6 months pre-dissolution
 *     (not detectable from a single appointment row alone — needs
 *      cross-appointment analysis; flagged here when resignation date
 *      is recent AND status is dissolved)
 *   - competitor_lender: company_number on the watchlist
 */
function classifyTroublesomeAppointment(appt) {
  const reasons = [];
  if (!appt) return reasons;
  const status = (appt.company_status || '').toLowerCase();
  if (TROUBLESOME_COMPANY_STATUSES.has(status)) {
    reasons.push(status);
  }
  // Phoenix-pattern proxy: resigned + dissolved (proper phoenix detection
  // requires the company's dissolution date, which we don't have on the
  // appointment payload — call this 'resigned_dissolved' for now).
  if (status === 'dissolved' && appt.resignation_date) {
    reasons.push('resigned_then_dissolved');
  }
  if (appt.company_number && COMPETITOR_LENDER_CH_NUMBERS.includes(appt.company_number)) {
    reasons.push('competitor_lender');
  }
  return reasons;
}

// ════════════════════════════════════════════════════════════
// Sprint 5 #23 (2026-04-28) — Officer-id auto-link for individual UBOs
// ════════════════════════════════════════════════════════════

/**
 * Normalise a name for matching: lowercase, strip honorifics, sort tokens.
 * Mirrors _normaliseNameKey in routes/borrowers.js so collapses
 * "Sumit KANTHED" / "KANTHED, Sumit" / "Mr Sumit Kanthed" → same key.
 */
function _normaliseNameKey(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !['mr','mrs','ms','miss','dr','prof','sir','dame','lord','lady'].includes(t))
    .sort()
    .join(' ');
}

/**
 * Auto-link CH officer_ids to deal_borrowers rows that are children of a corporate.
 *
 * Given a verified corporate borrower (parent_borrower_id), pulls the officers
 * list from CH and matches each officer (by name + DoB month/year if both have it)
 * against the corporate's child deal_borrowers rows. On match, writes
 * ch_match_data.officer_id so the directorships pull works without manual lookup.
 *
 * Idempotent: only writes officer_id when missing on the child row. Safe to re-run.
 *
 * @param {Object} pool - pg pool (passed in to avoid circular requires)
 * @param {number} corporateBorrowerId - deal_borrowers.id of the corporate parent
 * @param {string} companyNumber - corporate's CH company_number
 * @returns {Promise<Object>} { linked: [{ borrower_id, officer_id, name }], unmatched: [...], skipped: [...] }
 */
async function linkOfficersToBorrowers(pool, corporateBorrowerId, companyNumber) {
  if (!pool) throw new Error('pool required');
  if (!corporateBorrowerId) throw new Error('corporateBorrowerId required');
  if (!companyNumber) throw new Error('companyNumber required');

  // Pull officers (incl. resigned so we can match resigned-then-still-on-deal directors)
  const officers = await getOfficers(companyNumber, { includeResigned: true });
  if (!officers.length) {
    return { linked: [], unmatched: [], skipped: [], reason: 'no_officers_returned' };
  }

  // Load child borrowers under this corporate
  const r = await pool.query(
    `SELECT id, full_name, date_of_birth, ch_match_data, is_corporate, borrower_type
       FROM deal_borrowers
      WHERE parent_borrower_id = $1
        AND (is_corporate IS NULL OR is_corporate = false)`,
    [corporateBorrowerId]
  );
  const children = r.rows || [];
  if (!children.length) {
    return { linked: [], unmatched: officers.map(o => o.name), skipped: [], reason: 'no_children' };
  }

  // Index children by normalised name
  const childByName = new Map();
  for (const c of children) {
    childByName.set(_normaliseNameKey(c.full_name), c);
  }

  const linked = [];
  const unmatched = [];
  const skipped = [];

  for (const o of officers) {
    if (!o.officer_id) {
      skipped.push({ name: o.name, reason: 'no_officer_id_in_ch_response' });
      continue;
    }
    const key = _normaliseNameKey(o.name);
    const child = childByName.get(key);
    if (!child) {
      unmatched.push({ ch_name: o.name, officer_id: o.officer_id });
      continue;
    }

    // DoB sanity check (year+month if both have it)
    let dobOk = true;
    if (o.date_of_birth && o.date_of_birth.year && child.date_of_birth) {
      const childYear = new Date(child.date_of_birth).getUTCFullYear();
      if (childYear && o.date_of_birth.year && childYear !== o.date_of_birth.year) {
        dobOk = false;
      }
    }
    if (!dobOk) {
      skipped.push({
        name: child.full_name,
        reason: 'dob_mismatch',
        ch_dob: o.date_of_birth,
        deal_dob: child.date_of_birth
      });
      continue;
    }

    const existingId = child.ch_match_data && (child.ch_match_data.officer_id || child.ch_match_data.ch_officer_id);
    if (existingId === o.officer_id) {
      skipped.push({ borrower_id: child.id, reason: 'already_linked' });
      continue;
    }

    // Patch officer_id into ch_match_data (preserve existing keys)
    const patch = {
      officer_id: o.officer_id,
      ch_officer_id: o.officer_id,           // alias for older readers
      ch_officer_linked_at: new Date().toISOString(),
      ch_officer_link_source: 'auto_link_via_corporate_' + companyNumber
    };
    await pool.query(
      `UPDATE deal_borrowers
          SET ch_match_data = COALESCE(ch_match_data, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(patch), child.id]
    );

    linked.push({
      borrower_id: child.id,
      officer_id: o.officer_id,
      name: child.full_name,
      ch_name: o.name,
      ch_role: o.officer_role
    });
  }

  return { linked, unmatched, skipped, total_officers: officers.length };
}

module.exports = {
  searchCompany,
  getCompanyProfile,
  getOfficers,
  getPSCs,
  getFilingHistory,
  getCharges,
  verifyCompany,
  // Sprint 3 #18
  getOfficerAppointments,
  classifyTroublesomeAppointment,
  COMPETITOR_LENDER_CH_NUMBERS,
  TROUBLESOME_COMPANY_STATUSES,
  // Sprint 5 #23/#24 — officer-id linking
  searchOfficers,
  linkOfficersToBorrowers
};
