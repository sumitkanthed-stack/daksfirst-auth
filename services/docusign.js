/**
 * DocuSign Integration Service
 * Handles JWT authentication, envelope creation, and signed document retrieval
 */
const config = require('../config');

// ─── JWT Authentication ─────────────────────────────────────────
// DocuSign JWT Grant flow — no user interaction needed

let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Get a DocuSign access token via JWT Grant
 * Caches the token until it expires
 */
async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 300000) {
    return _cachedToken;
  }

  const jwt = require('jsonwebtoken');

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: config.DOCUSIGN_INTEGRATION_KEY,
    sub: config.DOCUSIGN_USER_ID,
    aud: config.DOCUSIGN_AUTH_SERVER.replace('https://', ''),
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation'
  };

  // Sign with RSA private key
  const assertion = jwt.sign(payload, config.DOCUSIGN_PRIVATE_KEY, { algorithm: 'RS256' });

  const resp = await fetch(`${config.DOCUSIGN_AUTH_SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[docusign] Token error:', resp.status, text);
    throw new Error(`DocuSign auth failed: ${resp.status}`);
  }

  const data = await resp.json();
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in * 1000);

  console.log('[docusign] Token acquired, expires in', data.expires_in, 'seconds');
  return _cachedToken;
}

/**
 * Send DIP for signing via DocuSign
 * @param {Object} params
 * @param {Buffer} params.pdfBuffer - The DIP PDF as a buffer
 * @param {string} params.pdfName - Filename for the PDF
 * @param {string} params.borrowerName - Signer's name
 * @param {string} params.borrowerEmail - Signer's email
 * @param {string} params.brokerName - CC recipient name (optional)
 * @param {string} params.brokerEmail - CC recipient email (optional)
 * @param {string} params.dealRef - Deal submission_id for reference
 * @param {string} params.callbackUrl - Webhook URL for status updates
 * @returns {Object} { envelopeId, status, sentAt }
 */
async function sendForSigning({ pdfBuffer, pdfName, borrowerName, borrowerEmail, brokerName, brokerEmail, dealRef, callbackUrl }) {
  const token = await getAccessToken();

  // Build the envelope definition
  const envelope = {
    emailSubject: `Daksfirst DIP — Please sign (Ref: ${dealRef})`,
    emailBlurb: 'Please review and sign the attached Decision in Principle from Daksfirst Limited.',
    documents: [
      {
        documentBase64: pdfBuffer.toString('base64'),
        name: pdfName || `DIP_${dealRef}.pdf`,
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    recipients: {
      signers: [
        {
          email: borrowerEmail,
          name: borrowerName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              {
                documentId: '1',
                pageNumber: '1',
                anchorString: 'Borrower Signature',
                anchorUnits: 'pixels',
                anchorXOffset: '0',
                anchorYOffset: '-30'
              }
            ],
            dateSignedTabs: [
              {
                documentId: '1',
                pageNumber: '1',
                anchorString: 'Date',
                anchorUnits: 'pixels',
                anchorXOffset: '0',
                anchorYOffset: '-30'
              }
            ]
          }
        }
      ],
      carbonCopies: []
    },
    status: 'sent', // Send immediately
    eventNotification: callbackUrl ? {
      url: callbackUrl,
      loggingEnabled: true,
      requireAcknowledgment: true,
      envelopeEvents: [
        { envelopeEventStatusCode: 'completed' },
        { envelopeEventStatusCode: 'declined' },
        { envelopeEventStatusCode: 'voided' }
      ],
      recipientEvents: [
        { recipientEventStatusCode: 'Completed' },
        { recipientEventStatusCode: 'Declined' }
      ]
    } : undefined
  };

  // Add broker as CC if provided
  if (brokerEmail && brokerName) {
    envelope.recipients.carbonCopies.push({
      email: brokerEmail,
      name: brokerName,
      recipientId: '2',
      routingOrder: '2'
    });
  }

  // Send to DocuSign
  const resp = await fetch(`${config.DOCUSIGN_BASE_URL}/v2.1/accounts/${config.DOCUSIGN_ACCOUNT_ID}/envelopes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(envelope)
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[docusign] Envelope error:', resp.status, text);
    throw new Error(`DocuSign envelope failed: ${resp.status} — ${text.substring(0, 300)}`);
  }

  const result = await resp.json();
  console.log('[docusign] Envelope created:', result.envelopeId, 'status:', result.status);

  return {
    envelopeId: result.envelopeId,
    status: result.status,
    sentAt: result.statusDateTime || new Date().toISOString()
  };
}

/**
 * Download the signed (completed) document from DocuSign
 * @param {string} envelopeId
 * @returns {Buffer} - The signed PDF as a buffer
 */
async function downloadSignedDocument(envelopeId) {
  const token = await getAccessToken();

  const resp = await fetch(
    `${config.DOCUSIGN_BASE_URL}/v2.1/accounts/${config.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`,
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to download signed doc: ${resp.status}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Get envelope status from DocuSign
 * @param {string} envelopeId
 * @returns {Object} - Envelope status details
 */
async function getEnvelopeStatus(envelopeId) {
  const token = await getAccessToken();

  const resp = await fetch(
    `${config.DOCUSIGN_BASE_URL}/v2.1/accounts/${config.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}`,
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to get envelope status: ${resp.status}`);
  }

  return resp.json();
}

module.exports = {
  getAccessToken,
  sendForSigning,
  downloadSignedDocument,
  getEnvelopeStatus
};
