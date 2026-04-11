const config = require('../config');
const { getGraphToken } = require('./graph');

// Email template utilities
function getEmailTemplate(eventType, dealData = {}) {
  const brandColor = config.BRAND_COLOR_PRIMARY;
  const accentColor = config.BRAND_COLOR_ACCENT;

  const templates = {
    [config.EMAIL_EVENTS.DIP_ISSUED]: {
      subject: 'DIP Issued - Your Daksfirst Application',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">DIP Issued</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Applicant'},</p>
            <p>Great news! Your Daksfirst application has been approved and we are pleased to issue your Discreet Interest in Principle (DIP).</p>
            <p><strong>DIP Details:</strong></p>
            <ul>
              <li>Deal Ref: ${dealData.submission_id || 'N/A'}</li>
              <li>Property: ${dealData.security_address || 'N/A'}</li>
              <li>Loan Amount: £${(dealData.loan_amount || 0).toLocaleString('en-GB')}</li>
            </ul>
            <p>Your relationship manager will be in touch shortly with the next steps.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG<br>
              portal@daksfirst.com
            </p>
          </div>
        </div>
      `
    },

    [config.EMAIL_EVENTS.CREDIT_APPROVED]: {
      subject: 'Credit Approved - Daksfirst',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">Credit Approval</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Applicant'},</p>
            <p>Your application has been approved at credit stage. We are progressing your deal towards completion.</p>
            <p>Your dedicated relationship manager will be in contact with the next steps and timeline.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG
            </p>
          </div>
        </div>
      `
    },

    [config.EMAIL_EVENTS.FEE_REQUESTED]: {
      subject: 'Fee Payment Required - Daksfirst',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">Fee Payment Due</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Borrower'},</p>
            <p>We are writing to request payment of the agreed fee to progress your application.</p>
            <p><strong>Fee Amount: £${(dealData.fee_amount || 0).toLocaleString('en-GB')}</strong></p>
            <p>Please arrange payment at your earliest convenience. Bank details and payment reference will be provided separately.</p>
            <p style="text-align:center;margin-top:30px;">
              <a href="https://apply.daksfirst.com" style="background:${accentColor};color:white;padding:12px 30px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">View Your Application</a>
            </p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG
            </p>
          </div>
        </div>
      `
    },

    [config.EMAIL_EVENTS.BANK_APPROVED]: {
      subject: 'Bank Approved - Daksfirst',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">Bank Approval Received</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Applicant'},</p>
            <p>Excellent news! Your application has received final bank approval.</p>
            <p>Your legal team will now be instructed to proceed with the completion of your transaction.</p>
            <p>We will keep you updated on the next steps and completion timeline.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG
            </p>
          </div>
        </div>
      `
    },

    [config.EMAIL_EVENTS.DEAL_COMPLETED]: {
      subject: 'Deal Completed - Daksfirst',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">Deal Completed</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Applicant'},</p>
            <p>Congratulations! Your Daksfirst application has been successfully completed and funds have been released.</p>
            <p style="color:#27ae60;font-weight:bold;font-size:16px;">Deal Ref: ${dealData.submission_id || 'N/A'}</p>
            <p>Thank you for choosing Daksfirst. We look forward to working with you on future transactions.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG<br>
              portal@daksfirst.com
            </p>
          </div>
        </div>
      `
    },

    [config.EMAIL_EVENTS.DEAL_DECLINED]: {
      subject: 'Application Update - Daksfirst',
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#c0392b;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;">Application Update</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>Dear ${dealData.borrower_name || 'Applicant'},</p>
            <p>Thank you for submitting your application to Daksfirst. Unfortunately, we are unable to offer bridging finance at this time.</p>
            <p>Please contact your relationship manager to discuss alternative options or if you would like feedback on your application.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG
            </p>
          </div>
        </div>
      `
    },

    // ── RM NOTIFICATION — Deal submitted for review ──
    'deal_submitted_for_review': {
      subject: `Action Required: Deal ${dealData.submission_id || ''} Submitted for Review`,
      body: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${brandColor};color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:22px;">New Deal for Review</h1>
          </div>
          <div style="padding:30px;background:#f9f9f9;border:1px solid #e0e0e0;border-top:none;">
            <p>A deal has been submitted for your review.</p>
            <table style="width:100%;border-collapse:collapse;margin:20px 0;">
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;width:40%;">Deal Ref</td>
                <td style="padding:10px;">${dealData.submission_id || 'N/A'}</td>
              </tr>
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;">Borrower</td>
                <td style="padding:10px;">${dealData.borrower_name || 'N/A'}</td>
              </tr>
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;">Property</td>
                <td style="padding:10px;">${dealData.security_address || 'N/A'}</td>
              </tr>
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;">Loan Amount</td>
                <td style="padding:10px;">&pound;${(dealData.loan_amount || 0).toLocaleString('en-GB')}</td>
              </tr>
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;">LTV</td>
                <td style="padding:10px;">${dealData.ltv_requested || 'N/A'}%</td>
              </tr>
              <tr style="border-bottom:1px solid #e0e0e0;">
                <td style="padding:10px;font-weight:bold;color:#666;">Submitted By</td>
                <td style="padding:10px;">${dealData.submitted_by_name || 'N/A'} (${dealData.submitted_by_role || 'N/A'})</td>
              </tr>
              <tr>
                <td style="padding:10px;font-weight:bold;color:#666;">Completeness</td>
                <td style="padding:10px;">${dealData.completeness || 'N/A'}%</td>
              </tr>
            </table>
            <p style="text-align:center;margin-top:20px;">
              <a href="https://apply.daksfirst.com" style="background:${accentColor};color:white;padding:14px 35px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;font-size:15px;">Review Deal Now</a>
            </p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e0e0e0;">
            <p style="color:#666;font-size:13px;">
              Daksfirst Limited | Bridging Finance, Built for Professionals<br>
              8 Hill Street, Mayfair, London W1J 5NG<br>
              portal@daksfirst.com
            </p>
          </div>
        </div>
      `
    }
  };

  return templates[eventType] || null;
}

async function sendDealEmail(eventType, dealData, recipients) {
  try {
    const template = getEmailTemplate(eventType, dealData);
    if (!template) {
      console.error(`[email] Unknown event type: ${eventType}`);
      return false;
    }

    const token = await getGraphToken();
    const sendUrl = 'https://graph.microsoft.com/v1.0/users/' + config.GRAPH_USER_EMAIL + '/sendMail';

    // Handle single recipient or array
    const recipientList = Array.isArray(recipients) ? recipients : [recipients];

    for (const recipient of recipientList) {
      try {
        const response = await fetch(sendUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              subject: template.subject,
              body: { contentType: 'HTML', content: template.body },
              toRecipients: [{ emailAddress: { address: recipient } }],
              from: { emailAddress: { address: config.GRAPH_USER_EMAIL, name: config.BRAND_NAME } }
            },
            saveToSentItems: true
          })
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Graph sendMail failed: ${response.status} ${text}`);
        }

        console.log(`[email] Sent ${eventType} to ${recipient}`);
      } catch (err) {
        console.error(`[email] Failed to send to ${recipient}:`, err.message);
      }
    }

    return true;
  } catch (err) {
    console.error('[email] Error:', err.message);
    return false;
  }
}

module.exports = {
  sendDealEmail,
  getEmailTemplate
};
