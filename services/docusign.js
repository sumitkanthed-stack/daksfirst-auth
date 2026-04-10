/**
 * DocuSign Integration Service
 * JWT authentication, multi-signer envelopes for Termsheet & Facility Letter
 *
 * NOT LIVE — Parked for Termsheet/Facility Letter stage.
 * Enable by uncommenting the require() in routes/deals.js and server.js
 */
const config = require('../config');

// ─── JWT Authentication ─────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Get a DocuSign access token via JWT Grant
 * Caches the token until it expires (with 5 min buffer)
 */
async function getAccessToken() {
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

// ─── Envelope Creation ──────────────────────────────────────────

/**
 * Send a document for signing via DocuSign
 * Supports multiple signers (Borrower + Guarantor) and CC recipients (Broker)
 *
 * @param {Object} params
 * @param {Buffer}   params.pdfBuffer     - The PDF as a buffer
 * @param {string}   params.pdfName       - Filename for the PDF
 * @param {string}   params.docType       - 'termsheet' | 'facility_letter'
 * @param {string}   params.dealRef       - Deal submission_id
 * @param {Array}    params.signers       - Array of { name, email, role } — role is 'borrower' or 'guarantor'
 * @param {Array}    [params.ccRecipients] - Array of { name, email } — e.g. broker, RM
 * @param {string}   [params.callbackUrl] - Webhook URL for status events
 * @returns {Object} { envelopeId, status, sentAt }
 */
async function sendForSigning({ pdfBuffer, pdfName, docType, dealRef, signers, ccRecipients = [], callbackUrl }) {
  const token = await getAccessToken();

  // Document type labels
  const docLabels = {
    termsheet: { subject: 'Termsheet', blurb: 'Please review and sign the attached Termsheet from Daksfirst Limited.' },
    facility_letter: { subject: 'Facility Letter', blurb: 'Please review and sign the attached Facility Letter from Daksfirst Limited.' }
  };
  const label = docLabels[docType] || docLabels.termsheet;

  // Build signer objects with anchor-based tab placement
  // Each signer gets their own signature line based on their role text in the PDF
  const signerRecipients = signers.map((s, idx) => {
    const recipientId = String(idx + 1);
    const routingOrder = String(idx + 1); // Sequential signing: borrower first, then guarantor

    // Anchor strings should match text in the PDF template
    // e.g. "Borrower Signature ___" and "Guarantor Signature ___"
    const anchorLabel = s.role === 'guarantor' ? 'Guarantor Signature' : 'Borrower Signature';

    return {
      email: s.email,
      name: s.name,
      recipientId,
      routingOrder,
      roleName: s.role,
      tabs: {
        signHereTabs: [
          {
            documentId: '1',
            anchorString: anchorLabel,
            anchorUnits: 'pixels',
            anchorXOffset: '0',
            anchorYOffset: '20'
          }
        ],
        dateSignedTabs: [
          {
            documentId: '1',
            anchorString: anchorLabel,
            anchorUnits: 'pixels',
            anchorXOffset: '300',
            anchorYOffset: '20'
          }
        ]
      }
    };
  });

  // CC recipients (broker, RM, etc.) — they receive a copy after signing is complete
  const ccList = ccRecipients.map((cc, idx) => ({
    email: cc.email,
    name: cc.name,
    recipientId: String(signers.length + idx + 1),
    routingOrder: String(signers.length + 1) // All CCs share the same routing order (after all signers)
  }));

  const envelope = {
    emailSubject: `Daksfirst ${label.subject} — Please sign (Ref: ${dealRef})`,
    emailBlurb: label.blurb,
    documents: [
      {
        documentBase64: pdfBuffer.toString('base64'),
        name: pdfName || `${docType}_${dealRef}.pdf`,
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    recipients: {
      signers: signerRecipients,
      carbonCopies: ccList
    },
    status: 'sent',
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

  // Custom fields to store metadata on the envelope (helps webhook identify what it's for)
  envelope.customFields = {
    textCustomFields: [
      { name: 'dealRef', value: dealRef, show: 'false' },
      { name: 'docType', value: docType, show: 'false' }
    ]
  };

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
  console.log(`[docusign] ${docType} envelope created:`, result.envelopeId, 'status:', result.status, 'signers:', signers.length);

  return {
    envelopeId: result.envelopeId,
    status: result.status,
    sentAt: result.statusDateTime || new Date().toISOString()
  };
}

// ─── Document Retrieval ─────────────────────────────────────────

/**
 * Download the signed (completed) document from DocuSign
 * @param {string} envelopeId
 * @returns {Buffer} - The signed PDF as a buffer
 */
async function downloadSignedDocument(envelopeId) {
  const token = await getAccessToken();

  const resp = await fetch(
    `${config.DOCUSIGN_BASE_URL}/v2.1/accounts/${config.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`,
    { headers: { 'Authorization': `Bearer ${token}` } }
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
    { headers: { 'Authorization': `Bearer ${token}` } }
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
