const { sendDealEmail } = require('./email');
const { sendDealSms } = require('./sms');
const config = require('../config');

// ═══════════════════════════════════════════════════════════════════════════
//  notifyDealEvent — flexible signature
//  Accepts recipients as:
//    - String:     'foo@bar'                    → treated as email
//    - Array:      ['foo@bar', 'baz@qux']       → all treated as emails
//    - Object:     { email: '...', phone: '...' } → explicit routing
//
//  Pre-2026-04-20 bug: function only handled the object form. Entire codebase
//  was calling with arrays — all email sends were silently no-op'ing. Fixed so
//  every call signature in use now actually fires the email.
// ═══════════════════════════════════════════════════════════════════════════
async function notifyDealEvent(eventType, deal, recipients = {}) {
  try {
    const dealId = deal && (deal.submission_id || deal.id);
    console.log(`[notifications] Triggering ${eventType} for deal ${dealId} (recipients type: ${Array.isArray(recipients) ? 'array' : typeof recipients})`);

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
