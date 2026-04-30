/**
 * services/matrix-normalizer.js — canonical-form boundary for matrix writes
 * ════════════════════════════════════════════════════════════════════════════
 * Sumit's architectural rule (2026-04-30): the matrix is the single source of
 * truth, and EVERY write path (QQ convert-to-deal, file-drop parser, manual
 * matrix edit, POST /borrowers, PUT /borrowers, wizard /submit) must produce
 * the SAME canonical form for the same input.
 *
 * Without this layer, drift produces:
 *   - phone: '+44 7777', '07777', '7777' all sitting in the same column
 *   - postcode: 'W1J5RL', 'w1j 5rl', 'W1J  5RL' all valid but different
 *   - borrower_type: 'limited' from QQ, 'corporate' from old wizard, 'ltd' from parser
 *   - email: 'Foo@Bar.COM' vs 'foo@bar.com'
 *   - date: '2026-04-30', '30/04/2026', '30 Apr 2026', or Date object
 *
 * This module exports:
 *   - Field-level normalizers (phone, postcode, email, date, money, etc.)
 *   - Entity-level orchestrators (normalizeBorrowerPayload, normalizePropertyPayload,
 *     normalizeDealPayload) that call the field-level ones for every column they
 *     know about
 *   - normalize(field, value): generic dispatcher
 *
 * USAGE:
 *   const { normalizeBorrowerPayload } = require('../services/matrix-normalizer');
 *   const clean = normalizeBorrowerPayload(req.body);
 *   await pool.query('INSERT INTO deal_borrowers ...', [clean.role, clean.full_name, ...]);
 */

// ─── Field-level normalizers ─────────────────────────────────────────────────

/**
 * UK phone number → E.164 format (+447XXXXXXXXX).
 * Accepts: '07777 123456', '+44 7777 123456', '447777123456', '7777123456', etc.
 * Returns null for empty/invalid.
 */
function normalizePhone(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (!s) return null;
  // Strip leading 0 → assume UK
  if (s.startsWith('0')) s = '+44' + s.substring(1);
  // Bare 10-digit (no leading 0 or +44) → assume UK mobile if starts with 7
  else if (/^\d{10}$/.test(s) && s.startsWith('7')) s = '+44' + s;
  // Bare 11-digit starting with 44 → prepend +
  else if (/^44\d{9,10}$/.test(s)) s = '+' + s;
  // If still no +, leave as-is (international or unknown format) — best effort
  if (!s.startsWith('+')) return null;
  // E.164 max length is 15 digits after the +
  const digits = s.substring(1);
  if (digits.length < 7 || digits.length > 15) return null;
  return s;
}

/**
 * UK postcode → uppercase, standard spacing ('W1J 5RL').
 * Accepts: 'w1j5rl', 'W1J  5RL', 'w1j 5rl', etc.
 * Returns null for empty/invalid.
 */
function normalizePostcode(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, '').trim();
  if (!s) return null;
  // UK postcodes are 5-7 chars without spaces — split into outward + inward (last 3)
  if (s.length < 5 || s.length > 8) return null;
  const inward = s.substring(s.length - 3);
  const outward = s.substring(0, s.length - 3);
  // Basic UK postcode regex check
  if (!/^[A-Z]{1,2}\d[A-Z\d]?$/.test(outward)) return null;
  if (!/^\d[A-Z]{2}$/.test(inward)) return null;
  return outward + ' ' + inward;
}

/**
 * Email → lowercase, trimmed.
 * Returns null for empty/invalid.
 */
function normalizeEmail(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Basic email regex — RFC 5321 simplified
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  return s;
}

/**
 * Any date input → ISO 8601 date string (YYYY-MM-DD).
 * Accepts: '2026-04-30', '30/04/2026', '30 Apr 2026', Date object, ISO datetime.
 * Returns null for empty/invalid. Returns full ISO datetime if input has a time component.
 */
function normalizeDate(raw, { keepTime = false } = {}) {
  if (raw == null || raw === '') return null;
  // Already a Date object
  if (raw instanceof Date) {
    if (isNaN(raw)) return null;
    return keepTime ? raw.toISOString() : raw.toISOString().substring(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return null;
  // ISO format already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (isNaN(d)) return null;
    return keepTime ? d.toISOString() : s.substring(0, 10);
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const ukMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (ukMatch) {
    const day = ukMatch[1].padStart(2, '0');
    const month = ukMatch[2].padStart(2, '0');
    let year = ukMatch[3];
    if (year.length === 2) year = (parseInt(year) < 50 ? '20' : '19') + year;
    return `${year}-${month}-${day}`;
  }
  // Free-form parse (e.g. '30 Apr 2026', 'April 30, 2026')
  const d = new Date(s);
  if (isNaN(d)) return null;
  return keepTime ? d.toISOString() : d.toISOString().substring(0, 10);
}

/**
 * UK Companies House number → 8 chars, zero-padded.
 * Accepts: '123456', 'OC12345', '12345678', '15521240'.
 * CH numbers are alphanumeric in some cases (Scotland: SC, Northern Ireland: NI, LLP: OC, etc).
 * Returns null for empty/invalid.
 */
function normalizeCompanyNumber(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, '').trim();
  if (!s) return null;
  // If purely numeric → zero-pad to 8 chars
  if (/^\d+$/.test(s)) {
    if (s.length > 8) return null;
    return s.padStart(8, '0');
  }
  // Alphanumeric (e.g. 'OC123456', 'SC123456') — keep as-is if reasonable length
  if (/^[A-Z]{2}\d+$/.test(s) && s.length <= 8) {
    // Pad the numeric part to make total 8 chars
    const prefix = s.match(/^[A-Z]+/)[0];
    const num = s.substring(prefix.length);
    return prefix + num.padStart(8 - prefix.length, '0');
  }
  // Already 8 chars, alphanumeric, well-formed
  if (s.length === 8 && /^[A-Z0-9]+$/.test(s)) return s;
  return null;
}

/**
 * Borrower type enum normalizer.
 * Accepts: 'limited', 'ltd', 'corporate', 'corp', 'company', 'spv', 'llp', 'plc',
 *          'individual', 'sole_trader', 'sole trader', 'partnership', 'trust'.
 * Returns canonical: 'individual' | 'limited' | 'llp' | 'plc' | 'spv' | 'partnership' | 'trust'.
 * Defaults to 'individual' if completely unrecognised.
 */
function normalizeBorrowerType(raw) {
  if (raw == null || raw === '') return 'individual';
  const s = String(raw).toLowerCase().trim().replace(/[^a-z]/g, '');
  if (!s) return 'individual';
  if (['limited', 'ltd', 'corporate', 'corp', 'company'].includes(s)) return 'limited';
  if (['llp'].includes(s)) return 'llp';
  if (['plc'].includes(s)) return 'plc';
  if (['spv'].includes(s)) return 'spv';
  if (['partnership'].includes(s)) return 'partnership';
  if (['trust'].includes(s)) return 'trust';
  if (['individual', 'soletrader', 'person', 'natural'].includes(s)) return 'individual';
  // Unrecognised — default safe fallback
  return 'individual';
}

/**
 * Money / numeric → number (no commas, no currency symbols).
 * Accepts: '£1,500,000', '1500000', '1,500,000.00', 1500000, '£1.5M', '1.5m'.
 * Returns null for empty/invalid.
 *
 * Note: this returns POUNDS as a Number (matches deal_submissions.loan_amount column).
 * Use multiplyBy100 to get pence if needed.
 */
function normalizeMoney(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  // Remove currency symbols + commas
  s = s.replace(/[£$€,\s]/g, '');
  // Handle 'M' / 'K' suffixes
  let multiplier = 1;
  if (/m$/i.test(s)) { multiplier = 1_000_000; s = s.replace(/m$/i, ''); }
  else if (/k$/i.test(s)) { multiplier = 1_000; s = s.replace(/k$/i, ''); }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return Math.round(n * multiplier);
}

/**
 * Generic string normalizer — trim, collapse whitespace, return null for empty.
 */
function normalizeString(raw, { uppercase = false, lowercase = false, maxLength = null } = {}) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (uppercase) s = s.toUpperCase();
  else if (lowercase) s = s.toLowerCase();
  if (maxLength && s.length > maxLength) s = s.substring(0, maxLength);
  return s;
}

/**
 * Address — minimal normalization. Keeps free-form but trimmed/collapsed.
 * Future: parse to {line1, line2, town, postcode} via PAF lookup.
 */
function normalizeAddress(raw) {
  if (raw == null || raw === '') return null;
  return normalizeString(raw, { maxLength: 500 });
}

// ─── Generic field dispatcher ────────────────────────────────────────────────

/**
 * Generic normalize(field, value) — looks up the right normalizer by field name.
 * For unknown fields, returns the value trimmed.
 */
function normalize(field, value) {
  if (value == null) return null;
  const f = String(field).toLowerCase();
  // Phone fields
  if (f === 'phone' || f.endsWith('_phone') || f === 'borrower_phone') return normalizePhone(value);
  // Email fields
  if (f === 'email' || f.endsWith('_email') || f === 'borrower_email') return normalizeEmail(value);
  // Postcode fields
  if (f === 'postcode' || f.endsWith('_postcode') || f === 'security_postcode') return normalizePostcode(value);
  // Date fields
  if (f === 'date_of_birth' || f === 'borrower_dob' || f.endsWith('_date') || f === 'drawdown_date' || f === 'date') return normalizeDate(value);
  // Company number
  if (f === 'company_number') return normalizeCompanyNumber(value);
  // Borrower type
  if (f === 'borrower_type') return normalizeBorrowerType(value);
  // Money fields
  if (f === 'loan_amount' || f === 'current_value' || f === 'market_value' || f === 'purchase_price' || f === 'gdv' || f.endsWith('_value') || f.endsWith('_price') || f.endsWith('_amount')) return normalizeMoney(value);
  // Address fields
  if (f === 'address' || f === 'security_address' || f === 'residential_address' || f.endsWith('_address')) return normalizeAddress(value);
  // Default — string trim
  return normalizeString(value);
}

// ─── Entity-level orchestrators ──────────────────────────────────────────────

/**
 * Normalize a borrower payload (from req.body, parser output, QQ data, anywhere).
 * Returns a NEW object with every recognized field normalized.
 * Unknown fields pass through trimmed.
 */
function normalizeBorrowerPayload(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  out.role = normalizeString(input.role, { lowercase: true }) || 'primary';
  out.full_name = normalizeString(input.full_name);
  out.borrower_type = normalizeBorrowerType(input.borrower_type);
  out.date_of_birth = normalizeDate(input.date_of_birth);
  out.nationality = normalizeString(input.nationality);
  out.jurisdiction = normalizeString(input.jurisdiction);
  out.email = normalizeEmail(input.email);
  out.phone = normalizePhone(input.phone);
  out.address = normalizeAddress(input.address);
  out.residential_address = normalizeAddress(input.residential_address);
  out.company_name = normalizeString(input.company_name);
  out.company_number = normalizeCompanyNumber(input.company_number);
  out.parent_borrower_id = (input.parent_borrower_id != null && input.parent_borrower_id !== '') ? parseInt(input.parent_borrower_id) : null;
  // Pass-through fields that don't need normalization (UI-set enums, IDs, etc.)
  if (input.gender != null) out.gender = normalizeString(input.gender, { lowercase: true });
  if (input.id_type != null) out.id_type = normalizeString(input.id_type, { lowercase: true });
  if (input.id_number != null) out.id_number = normalizeString(input.id_number);
  if (input.id_expiry != null) out.id_expiry = normalizeDate(input.id_expiry);
  if (input.kyc_status != null) out.kyc_status = normalizeString(input.kyc_status, { lowercase: true });
  // Strip nulls so we don't overwrite existing columns with NULL on partial updates
  return Object.fromEntries(Object.entries(out).filter(([_k, v]) => v !== null && v !== undefined));
}

/**
 * Normalize a property payload.
 */
function normalizePropertyPayload(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  out.address = normalizeAddress(input.address);
  out.postcode = normalizePostcode(input.postcode);
  out.property_type = normalizeString(input.property_type, { lowercase: true });
  out.tenure = normalizeString(input.tenure, { lowercase: true });
  out.occupancy = normalizeString(input.occupancy, { lowercase: true });
  out.current_use = normalizeString(input.current_use, { lowercase: true });
  out.market_value = normalizeMoney(input.market_value);
  out.purchase_price = normalizeMoney(input.purchase_price);
  out.gdv = normalizeMoney(input.gdv);
  out.title_number = normalizeString(input.title_number, { uppercase: true });
  return Object.fromEntries(Object.entries(out).filter(([_k, v]) => v !== null && v !== undefined));
}

/**
 * Normalize a deal-level payload (deal_submissions flat columns).
 */
function normalizeDealPayload(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  // Borrower-level (denormalized into deal_submissions for primary)
  out.borrower_name = normalizeString(input.borrower_name);
  out.borrower_company = normalizeString(input.borrower_company);
  out.borrower_email = normalizeEmail(input.borrower_email);
  out.borrower_phone = normalizePhone(input.borrower_phone);
  out.borrower_dob = normalizeDate(input.borrower_dob);
  out.borrower_nationality = normalizeString(input.borrower_nationality);
  out.borrower_jurisdiction = normalizeString(input.borrower_jurisdiction);
  out.borrower_type = input.borrower_type ? normalizeBorrowerType(input.borrower_type) : null;
  out.company_name = normalizeString(input.company_name);
  out.company_number = normalizeCompanyNumber(input.company_number);
  // Property-level (denormalized into deal_submissions for primary property)
  out.security_address = normalizeAddress(input.security_address);
  out.security_postcode = normalizePostcode(input.security_postcode);
  out.current_value = normalizeMoney(input.current_value);
  out.purchase_price = normalizeMoney(input.purchase_price);
  out.asset_type = normalizeString(input.asset_type, { lowercase: true });
  out.property_tenure = normalizeString(input.property_tenure, { lowercase: true });
  out.occupancy_status = normalizeString(input.occupancy_status, { lowercase: true });
  out.current_use = normalizeString(input.current_use, { lowercase: true });
  // Loan
  out.loan_amount = normalizeMoney(input.loan_amount);
  out.loan_purpose = normalizeString(input.loan_purpose, { lowercase: true });
  out.term_months = (input.term_months != null && input.term_months !== '') ? parseInt(input.term_months) : null;
  out.rate_requested = (input.rate_requested != null && input.rate_requested !== '') ? parseFloat(input.rate_requested) : null;
  out.ltv_requested = (input.ltv_requested != null && input.ltv_requested !== '') ? parseFloat(input.ltv_requested) : null;
  out.exit_strategy = normalizeString(input.exit_strategy);
  out.drawdown_date = normalizeDate(input.drawdown_date);
  out.interest_servicing = normalizeString(input.interest_servicing, { lowercase: true });
  out.existing_charges = normalizeString(input.existing_charges);
  out.use_of_funds = normalizeString(input.use_of_funds);
  out.refurb_scope = normalizeString(input.refurb_scope);
  out.refurb_cost = normalizeMoney(input.refurb_cost);
  out.deposit_source = normalizeString(input.deposit_source);
  out.additional_notes = normalizeString(input.additional_notes);
  // Broker
  out.broker_name = normalizeString(input.broker_name);
  out.broker_company = normalizeString(input.broker_company);
  out.broker_fca = normalizeString(input.broker_fca, { uppercase: true });
  return Object.fromEntries(Object.entries(out).filter(([_k, v]) => v !== null && v !== undefined));
}

module.exports = {
  // Field-level
  normalizePhone,
  normalizePostcode,
  normalizeEmail,
  normalizeDate,
  normalizeCompanyNumber,
  normalizeBorrowerType,
  normalizeMoney,
  normalizeString,
  normalizeAddress,
  // Generic dispatcher
  normalize,
  // Entity-level orchestrators
  normalizeBorrowerPayload,
  normalizePropertyPayload,
  normalizeDealPayload,
};
