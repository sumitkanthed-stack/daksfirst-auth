const config = require('../config');

let twilio;
try {
  twilio = require('twilio');
} catch (e) {
  console.log('[sms] Twilio not installed, SMS disabled');
}

async function sendSms(phoneNumber, message) {
  try {
    // Check if Twilio is configured
    if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_PHONE_NUMBER) {
      console.log('[sms] Twilio not configured, SMS stub:', { phoneNumber, message: message.substring(0, 50) });
      return false;
    }

    if (!twilio) {
      console.log('[sms] Twilio module not available');
      return false;
    }

    const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

    const result = await client.messages.create({
      body: message,
      from: config.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log('[sms] Message sent:', result.sid);
    return true;
  } catch (err) {
    console.error('[sms] Error:', err.message);
    return false;
  }
}

async function sendDealSms(eventType, dealData, phoneNumber) {
  try {
    let message = '';

    switch (eventType) {
      case config.SMS_EVENTS.DIP_APPROVAL:
        message = `Daksfirst: Your DIP has been approved for £${dealData.loan_amount || 0}. Our team will be in touch shortly.`;
        break;
      case config.SMS_EVENTS.FEE_REQUEST:
        message = `Daksfirst: Fee payment of £${dealData.fee_amount || 0} is now due. Please arrange payment urgently.`;
        break;
      case config.SMS_EVENTS.BANK_APPROVAL:
        message = `Daksfirst: Your application has received bank approval. We are proceeding to completion.`;
        break;
      default:
        console.log('[sms] Unknown event type:', eventType);
        return false;
    }

    return await sendSms(phoneNumber, message);
  } catch (err) {
    console.error('[sms] Error sending deal SMS:', err.message);
    return false;
  }
}

module.exports = {
  sendSms,
  sendDealSms
};
