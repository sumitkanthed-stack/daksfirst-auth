const { sendDealEmail } = require('./email');
const { sendDealSms } = require('./sms');
const config = require('../config');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════════════════
//  enrichDealPayload — hydrate deal object from DB so email templates always
//  see canonical, lending-critical fields regardless of what the call site
//  happened to pass in. Matrix-SSOT: prefers *_approved columns, falls back
//  to requested. Also fetches deal_properties (multi-property deals) so the
//  email template can render the full security portfolio.
//
//  Returns the original `deal` object if enrichment fails (non-blocking).
// ═══════════════════════════════════════════════════════════════════════════
async function enrichDealPayload(deal) {
  if (!deal) return deal;
  const key = deal.submission_id || null;
  const intId = Number(deal.id);
  try {
    let row = null;
    if (key) {
      const r = await pool.query(
        `SELECT id, submission_id, status, borrower_name, borrower_company,
                security_address, security_postcode, asset_type,
                loan_amount, loan_amount_approved, ltv_requested, ltv_approved,
                rate_requested, rate_approved, term_months, arrangement_fee_pct,
                commitment_fee, dip_fee, current_value
           FROM deal_submissions WHERE submission_id = $1`,
        [key]
      );
      if (r.rows.length > 0) row = r.rows[0];
    } else if (Number.isFinite(intId) && intId > 0) {
      const r = await pool.query(
        `SELECT id, submission_id, status, borrower_name, borrower_company,
                security_address, security_postcode, asset_type,
                loan_amount, loan_amount_approved, ltv_requested, ltv_approved,
                rate_requested, rate_approved, term_months, arrangement_fee_pct,
                commitment_fee, dip_fee, current_value
           FROM deal_submissions WHERE id = $1`,
        [intId]
      );
      if (r.rows.length > 0) row = r.rows[0];
    }

    if (!row) return deal;

    // Approved-first merge (Matrix-SSOT): approved takes precedence if set,
    // otherwise use requested. Keeps original deal object as fallback floor.
    const approvedOr = (approved, requested) =>
      (approved != null && approved !== '' ? approved : requested);

    const enriched = Object.assign({}, deal, row, {
      loan_amount: approvedOr(row.loan_amount_approved, row.loan_amount),
      ltv: approvedOr(row.ltv_approved, row.ltv_requested),
      rate: approvedOr(row.rate_approved, row.rate_requested)
    });

    // Attach properties (multi-property deals)
    try {
      const props = await pool.query(
        `SELECT address, postcode, property_type, market_value
           FROM deal_properties
          WHERE deal_id = $1
          ORDER BY id ASC`,
        [row.id]
      );
      enriched.properties = props.rows || [];
    } catch (pErr) {
      console.warn('[notifications] properties enrichment skipped:', pErr.message);
      enriched.properties = [];
    }

    return enriched;
  } catch (err) {
    console.warn('[notifications] enrichDealPayload failed, using original deal:', err.message);
    return deal;
  }
}

async function notifyDealEvent(eventType, deal, recipients = {}) {
  try {
    const dealId = deal && (deal.submission_id || deal.id);
    console.log(`[notifications] Triggering ${eventType} for deal ${dealId} (recipients type: ${Array.isArray(recipients) ? 'array' : typeof recipients})`);

    // Hydrate deal with canonical DB data before rendering any template.
    // Non-blocking: if enrichment fails we still fire the email with the
    // partial data the caller passed.
    deal = await enrichDealPayload(deal);

    // Normalise recipients into { email: [...], phone: [...] }
    let emails = [];
    let phones = [];
    if (typeof recipients === 'string') {
      emails = [recipients];
    } else if (Array.isArray(recipients)) {
      emails = recipients.filter(r => typeof r === 'string');
    } else if (recipients && typeof recipients === 'object') {
      if (recipients.email) {
        emails = Array.isArray(recipients.email) ? recipients.email : [recipients.email];
      }
      if (recipients.phone) {
        phones = Array.isArray(recipients.phone) ? recipients.phone : [recipients.phone];
      }
    }

    // Filter out empty/invalid
    emails = emails.filter(e => e && typeof e === 'string' && e.includes('@'));
    phones = phones.filter(p => p && typeof p === 'string');

    if (emails.length === 0 && phones.length === 0) {
      console.warn(`[notifications] No valid recipients for ${eventType} on deal ${dealId}`);
      return false;
    }

    // Email notifications
    for (const email of emails) {
      try {
        await sendDealEmail(eventType, deal, email);
        console.log(`[notifications] ✓ Email queued to ${email} for ${eventType}`);
      } catch (err) {
        console.error(`[notifications] Email to ${email} failed:`, err.message);
      }
    }

    // SMS notifications (only for specific events and if phone is provided)
    if (phones.length > 0) {
      const smsTriggers = {
        [config.EMAIL_EVENTS.DIP_ISSUED]: config.SMS_EVENTS.DIP_APPROVAL,
        [config.EMAIL_EVENTS.FEE_REQUESTED]: config.SMS_EVENTS.FEE_REQUEST,
        [config.EMAIL_EVENTS.BANK_APPROVED]: config.SMS_EVENTS.BANK_APPROVAL
      };
      if (smsTriggers[eventType]) {
        for (const phone of phones) {
          await sendDealSms(smsTriggers[eventType], deal, phone).catch(err => {
            console.error('[notifications] SMS failed:', err.message);
          });
        }
      }
    }

    return true;
  } catch (err) {
    console.error('[notifications] Error:', err.message);
    return false;
  }
}

module.exports = {
  notifyDealEvent
};
