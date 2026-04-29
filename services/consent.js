/**
 * Borrower consent service · CONS bundle (2026-04-29)
 *
 * Two evidence paths:
 *   1) Broker attestation — broker confirms in their FCA fact-find that the
 *      borrower consented. RM/broker tickbox produces a borrower_consents
 *      row per UBO with evidence_source='broker_attestation'.
 *   2) Email-link — Daksfirst emails the borrower a one-time signed link.
 *      Borrower clicks, sees consent page, confirms. No portal login. Token
 *      is JWT-signed with WEBHOOK_SECRET (or a dedicated CONSENT_SECRET if set).
 *
 * Both paths write borrower_consents rows. Backend gates (CONS-3) check this
 * table for current-non-revoked-non-expired rows before firing live API.
 *
 * Verbatim consent text is captured in consent_text_snapshot so we can prove
 * exactly what the borrower agreed to even if the wording later changes.
 */

const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config');

// ─────────────────────────────────────────────────────────────────────────
// Consent text — verbatim, captured per borrower at consent acquisition.
// Update CONSENT_TEXT_VERSION whenever this changes (don't edit the body
// in place — old rows reference the old version via consent_text_version).
// ─────────────────────────────────────────────────────────────────────────
const CONSENT_TEXT_VERSION = 'v1';

const CONSENT_TEXT_BODY = `By providing my consent, I agree that Daksfirst Limited (FRN 937220), its appointed agents, and any broker acting on my behalf may carry out the following checks for the purpose of evaluating my loan application and, where applicable, for the duration of the loan:

1. Personal credit checks against my record at the major credit reference agencies (including Experian Delphi Select).

2. Fraud database searches (including CIFAS Hunter National Fraud Database).

3. Identity verification, including biometric video selfie checks (SmartSearch / GBG iD3global).

4. Sanctions, Politically Exposed Person (PEP), and adverse-media screening, including ongoing monitoring for the duration of the loan.

5. Where I separately authorise it, open-banking-based access to bank accounts I nominate (TruLayer or equivalent provider).

6. Verification of identity, address, and employment details with public registries (Royal Mail PAF, HM Land Registry, Companies House).

I understand that:
  - Daksfirst will share my data only with regulated agents, vendors, and the
    funder of my loan, and only for the purposes set out above.
  - I have rights under UK GDPR including the right to access my data, to
    request correction, and to withdraw this consent. Withdrawing consent
    will not affect any check already performed before the withdrawal but may
    prevent further evaluation of the loan application.
  - The Daksfirst Privacy Notice describes my rights in full and is available
    at https://daksfirst.com/privacy.

I confirm that I am the person named in the loan application, that I have
authority to give this consent, and that I am giving it freely.`;

const CONSENT_TYPES = [
  'personal_credit',
  'hunter_fraud',
  'kyc_smartsearch',
  'open_banking_truelayer',
];

// Per-product expiry windows
const EXPIRY_DAYS = {
  personal_credit:        180,  // 6 months
  hunter_fraud:           180,  // 6 months
  kyc_smartsearch:        365,  // 12 months
  open_banking_truelayer: 180,  // PSD2 hard limit
};

// ─────────────────────────────────────────────────────────────────────────
// Token signing for email-link path. Stateless — token contains payload,
// HMAC-signed, validated on landing-page hit. No DB row needed pre-click.
// ─────────────────────────────────────────────────────────────────────────

function getSecret() {
  const s = process.env.CONSENT_TOKEN_SECRET || config.WEBHOOK_SECRET;
  if (!s) throw new Error('consent: no CONSENT_TOKEN_SECRET or WEBHOOK_SECRET set');
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Build a signed consent token. Payload includes deal_id, borrower_id,
 * consent_text_version, expiry. Validity 30 days by default — borrower
 * has a month to click.
 */
function signConsentToken({ deal_id, borrower_id, ttlDays = 30 }) {
  const payload = {
    d: deal_id,
    b: borrower_id,
    v: CONSENT_TEXT_VERSION,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest();
  return body + '.' + b64urlEncode(sig);
}

function verifyConsentToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('invalid token format');
  }
  const [body, sigPart] = token.split('.');
  const expectSig = crypto.createHmac('sha256', getSecret()).update(body).digest();
  const givenSig = b64urlDecode(sigPart);
  if (expectSig.length !== givenSig.length || !crypto.timingSafeEqual(expectSig, givenSig)) {
    throw new Error('invalid signature');
  }
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch (_) { throw new Error('invalid payload'); }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired');
  }
  return {
    deal_id: payload.d,
    borrower_id: payload.b,
    consent_text_version: payload.v,
    issued_at: payload.iat,
    expires_at: payload.exp,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Consent row writers — both paths funnel into borrower_consents.
// ─────────────────────────────────────────────────────────────────────────

async function recordConsentRow({
  deal_id, borrower_id, consent_type, evidence_source, evidence_id,
  evidence_url, consent_ip, consent_user_agent, recorded_by,
}) {
  if (!CONSENT_TYPES.includes(consent_type)) {
    throw new Error(`consent: unknown consent_type '${consent_type}'`);
  }
  const expiryDays = EXPIRY_DAYS[consent_type];
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO borrower_consents
       (deal_id, borrower_id, consent_type, consent_text_version, consent_text_snapshot,
        evidence_source, evidence_id, evidence_url, consent_ip, consent_user_agent,
        expires_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, expires_at`,
    [
      deal_id, borrower_id, consent_type, CONSENT_TEXT_VERSION, CONSENT_TEXT_BODY,
      evidence_source, evidence_id, evidence_url, consent_ip, consent_user_agent,
      expiresAt, recorded_by,
    ]
  );
  return result.rows[0];
}

/**
 * Bulk-record all four consent types for a borrower in one go (typical
 * pattern when broker attests or borrower clicks email-link confirm).
 */
async function recordBlanketConsent({
  deal_id, borrower_id, evidence_source, evidence_id, evidence_url,
  consent_ip, consent_user_agent, recorded_by,
}) {
  const rows = [];
  for (const consent_type of CONSENT_TYPES) {
    const row = await recordConsentRow({
      deal_id, borrower_id, consent_type, evidence_source, evidence_id,
      evidence_url, consent_ip, consent_user_agent, recorded_by,
    });
    rows.push({ consent_type, ...row });
  }
  return rows;
}

/**
 * Check whether a borrower has a current valid consent for a given check.
 * Used by routes/credit.js + routes/kyc.js gates.
 */
async function hasValidConsent(borrower_id, consent_type) {
  const result = await pool.query(
    `SELECT id, evidence_source, expires_at, consented_at
       FROM borrower_consents
      WHERE borrower_id = $1
        AND consent_type = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
      ORDER BY consented_at DESC
      LIMIT 1`,
    [borrower_id, consent_type]
  );
  return result.rows[0] || null;
}

module.exports = {
  CONSENT_TEXT_VERSION,
  CONSENT_TEXT_BODY,
  CONSENT_TYPES,
  EXPIRY_DAYS,
  signConsentToken,
  verifyConsentToken,
  recordConsentRow,
  recordBlanketConsent,
  hasValidConsent,
};
