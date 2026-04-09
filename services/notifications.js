const { sendDealEmail } = require('./email');
const { sendDealSms } = require('./sms');
const config = require('../config');

async function notifyDealEvent(eventType, deal, recipients = {}) {
  try {
    console.log(`[notifications] Triggering ${eventType} for deal ${deal.submission_id}`);

    // Email notifications
    if (recipients.email) {
      const emailList = Array.isArray(recipients.email) ? recipients.email : [recipients.email];
      for (const email of emailList) {
        await sendDealEmail(eventType, deal, email).catch(err => {
          console.error('[notifications] Email failed:', err.message);
        });
      }
    }

    // SMS notifications (only for specific events and if phone is provided)
    if (recipients.phone) {
      const smsTriggers = {
        [config.EMAIL_EVENTS.DIP_ISSUED]: config.SMS_EVENTS.DIP_APPROVAL,
        [config.EMAIL_EVENTS.FEE_REQUESTED]: config.SMS_EVENTS.FEE_REQUEST,
        [config.EMAIL_EVENTS.BANK_APPROVED]: config.SMS_EVENTS.BANK_APPROVAL
      };

      if (smsTriggers[eventType]) {
        const smsEventType = smsTriggers[eventType];
        const phoneList = Array.isArray(recipients.phone) ? recipients.phone : [recipients.phone];

        for (const phone of phoneList) {
          await sendDealSms(smsEventType, deal, phone).catch(err => {
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
