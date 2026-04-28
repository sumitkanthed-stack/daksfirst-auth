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

async function chFetch(path) {
  const apiKey = config.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    throw new Error('COMPANIES_HOUSE_API_KEY not configured');
  }

  // Companies House uses HTTP Basic Auth: API key as username, no password
  const auth = Buffer.from(`${apiKey}:`).toString('base64');

  const url = `${BASE_URL}${path}`;
  console.log(`[companies-house] GET ${path}`);

  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json'
    }
  });

  // Rate limited — log and throw
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
 * Get officers (directors, secretaries) for a company
 * @param {string} companyNumber
 * @returns {Array} Active officers
 */
async function getOfficers(companyNumber) {
  const num = companyNumber.trim().padStart(8, '0');
  const data = await chFetch(`/company/${num}/officers?items_per_page=50`);
  if (!data || !data.items) return [];

  return data.items
    .filter(o => !o.resigned_on) // Only active officers
    .map(o => ({
      name: o.name,
      officer_role: o.officer_role,           // director, secretary, llp-member, etc.
      appointed_on: o.appointed_on,
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
      company_name: it.name_elements
        ? null  // some responses have name_elements instead
        : (company.company_name || null),
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
  TROUBLESOME_COMPANY_STATUSES
};
