/**
 * routes/consent.js — Borrower consent acquisition + management
 * ════════════════════════════════════════════════════════════
 * Three flavours:
 *
 *  1. Broker attestation (admin-only)
 *     POST  /api/admin/consent/broker-attest/:dealId
 *
 *  2. Email-link send (admin-only)
 *     POST  /api/admin/consent/send-link/:dealId/:borrowerId
 *
 *  3. Public landing page (no auth — token-validated)
 *     GET   /api/consent/sign?token=...     — renders consent page
 *     POST  /api/consent/sign?token=...     — records borrower's confirmation
 *
 *  4. Read-side queries (admin-only)
 *     GET   /api/admin/consent/status/:dealId   — per-borrower consent state
 *
 * All admin routes require auth + internal role. Public routes validate via
 * signed JWT-like token (services/consent.js).
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const consent = require('../services/consent');
const { sendDealEmail } = require('../services/email');

function isInternal(req) {
  return req.user && config.INTERNAL_ROLES && config.INTERNAL_ROLES.includes(req.user.role);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || req.ip
      || null;
}

function clientUa(req) {
  return req.headers['user-agent'] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. Broker attestation — RM ticks the box on the deal page
// ═══════════════════════════════════════════════════════════════════════════
router.post('/admin/consent/broker-attest/:dealId', authenticateToken, async (req, res) => {
  try {
    if (!isInternal(req)) return res.status(403).json({ error: 'Internal users only' });
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid dealId' });

    // Stamp deal_submissions with attestation metadata
    const upd = await pool.query(
      `UPDATE deal_submissions
          SET broker_consent_attested_at  = NOW(),
              broker_consent_attested_by  = $1,
              broker_consent_attested_ip  = $2,
              broker_consent_text_version = $3
        WHERE id = $4
        RETURNING id, submission_id`,
      [req.user.userId || null, clientIp(req), consent.CONSENT_TEXT_VERSION, dealId]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'deal not found' });

    // Find UBOs / individual borrowers on the deal — write one consent row per UBO
    const borrowers = await pool.query(
      `SELECT id, full_name, role
         FROM deal_borrowers
        WHERE deal_id = $1
          AND (borrower_type IS NULL OR borrower_type = 'individual'
               OR role IN ('borrower','guarantor','director','ubo','shareholder'))`,
      [dealId]
    );

    const evidence_id = `broker_attest:deal:${dealId}:by:${req.user.userId || 'unknown'}:at:${Date.now()}`;
    const writtenRows = [];
    for (const b of borrowers.rows) {
      const rows = await consent.recordBlanketConsent({
        deal_id: dealId,
        borrower_id: b.id,
        evidence_source: 'broker_attestation',
        evidence_id,
        evidence_url: null,
        consent_ip: clientIp(req),
        consent_user_agent: clientUa(req),
        recorded_by: req.user.userId || null,
      });
      writtenRows.push({ borrower_id: b.id, full_name: b.full_name, consents: rows });
    }

    res.json({
      success: true,
      message: `Broker attestation recorded for ${writtenRows.length} borrower(s) · ${consent.CONSENT_TYPES.length} consent type(s) each`,
      deal_id: dealId,
      submission_id: upd.rows[0].submission_id,
      borrowers: writtenRows,
      evidence_id,
    });
  } catch (err) {
    console.error('[consent/broker-attest] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Email-link send — RM clicks "Send consent link to borrower"
// ═══════════════════════════════════════════════════════════════════════════
router.post('/admin/consent/send-link/:dealId/:borrowerId', authenticateToken, async (req, res) => {
  try {
    if (!isInternal(req)) return res.status(403).json({ error: 'Internal users only' });
    const dealId = Number(req.params.dealId);
    const borrowerId = Number(req.params.borrowerId);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid dealId' });
    if (!Number.isInteger(borrowerId) || borrowerId <= 0) return res.status(400).json({ error: 'invalid borrowerId' });

    // Resolve borrower
    const bRes = await pool.query(
      `SELECT b.id, b.full_name, b.email, b.deal_id, d.submission_id, d.borrower_name AS deal_name
         FROM deal_borrowers b
         JOIN deal_submissions d ON d.id = b.deal_id
        WHERE b.id = $1 AND b.deal_id = $2`,
      [borrowerId, dealId]
    );
    if (bRes.rowCount === 0) return res.status(404).json({ error: 'borrower not on this deal' });
    const borrower = bRes.rows[0];
    if (!borrower.email) return res.status(422).json({ error: 'borrower has no email on file — add it in matrix first' });

    // Mint token + build link
    const token = consent.signConsentToken({ deal_id: dealId, borrower_id: borrowerId, ttlDays: 30 });
    const baseUrl = config.AUTH_PUBLIC_BASE_URL || config.PUBLIC_AUTH_URL || 'https://daksfirst-auth.onrender.com';
    const consentUrl = `${baseUrl}/api/consent/sign?token=${encodeURIComponent(token)}`;

    // Send email via Graph (uses existing email service infrastructure)
    const subject = `Consent for credit & identity checks — Daksfirst loan application`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;max-width:560px;">
        <p>Dear ${escapeHtml(borrower.full_name || 'Borrower')},</p>
        <p>Daksfirst Limited has received your loan application via your broker. Before we can proceed with the credit and identity checks needed for your application, we require your consent.</p>
        <p>Please click the secure link below to read what you are consenting to and provide your confirmation. The process takes about a minute.</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${consentUrl}" style="display:inline-block;padding:12px 28px;background:#D4A853;color:#111;text-decoration:none;border-radius:5px;font-weight:600;">
            Provide consent
          </a>
        </p>
        <p style="font-size:12px;color:#666;">This link will expire in 30 days. If you did not request this, please ignore this email or contact us at ${config.GRAPH_USER_EMAIL || 'support@daksfirst.com'}.</p>
        <p style="font-size:12px;color:#666;">Daksfirst Limited — FRN 937220</p>
      </div>`.trim();

    // Send via Graph using a thin direct call (sendDealEmail expects template
    // event types, we send raw here for the consent flow).
    try {
      const { getGraphToken } = require('../services/graph');
      const token2 = await getGraphToken();
      const sendUrl = `https://graph.microsoft.com/v1.0/users/${config.GRAPH_USER_EMAIL}/sendMail`;
      const r = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: borrower.email } }],
            from: { emailAddress: { address: config.GRAPH_USER_EMAIL, name: config.BRAND_NAME || 'Daksfirst' } },
          },
          saveToSentItems: true,
        }),
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Graph sendMail ${r.status}: ${errText.substring(0, 200)}`);
      }
    } catch (mailErr) {
      console.error('[consent/send-link] email send failed:', mailErr.message);
      return res.status(502).json({ error: `Email send failed: ${mailErr.message}` });
    }

    res.json({
      success: true,
      message: `Consent link sent to ${borrower.email}`,
      borrower_id: borrowerId,
      borrower_email: borrower.email,
      link_expires_in_days: 30,
    });
  } catch (err) {
    console.error('[consent/send-link] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. Public landing page — borrower clicks email link
// ═══════════════════════════════════════════════════════════════════════════
router.get('/consent/sign', async (req, res) => {
  const token = req.query.token;
  let payload;
  try {
    payload = consent.verifyConsentToken(token);
  } catch (e) {
    return res.status(400).send(consentLandingError(`Invalid or expired link: ${e.message}`));
  }

  // Lookup borrower for personalisation + dedup check
  const bRes = await pool.query(
    `SELECT b.id, b.full_name, b.email, d.submission_id, d.borrower_name
       FROM deal_borrowers b
       JOIN deal_submissions d ON d.id = b.deal_id
      WHERE b.id = $1 AND b.deal_id = $2`,
    [payload.borrower_id, payload.deal_id]
  );
  if (bRes.rowCount === 0) {
    return res.status(404).send(consentLandingError('Borrower or deal record not found.'));
  }
  const borrower = bRes.rows[0];

  // If already consented (any non-revoked row exists for this borrower), show
  // a "thank you, already received" page — idempotent click.
  const alreadyConsented = await pool.query(
    `SELECT MIN(consented_at) AS first_consent
       FROM borrower_consents
      WHERE borrower_id = $1
        AND deal_id = $2
        AND evidence_source = 'email_link_token'
        AND revoked_at IS NULL`,
    [payload.borrower_id, payload.deal_id]
  );
  if (alreadyConsented.rows[0].first_consent) {
    return res.send(consentLandingAlreadyDone(borrower, alreadyConsented.rows[0].first_consent));
  }

  res.send(consentLandingPage({ token, borrower, payload }));
});

router.post('/consent/sign', express.urlencoded({ extended: true }), async (req, res) => {
  const token = req.query.token || req.body.token;
  let payload;
  try {
    payload = consent.verifyConsentToken(token);
  } catch (e) {
    return res.status(400).send(consentLandingError(`Invalid or expired link: ${e.message}`));
  }

  if (!req.body || req.body.confirmed !== 'yes') {
    return res.status(400).send(consentLandingError('Consent confirmation missing. Please tick the box and click Confirm.'));
  }

  // Idempotency — if consent already recorded via this evidence path, return success
  const dup = await pool.query(
    `SELECT id FROM borrower_consents
      WHERE borrower_id = $1 AND deal_id = $2
        AND evidence_source = 'email_link_token' AND revoked_at IS NULL
      LIMIT 1`,
    [payload.borrower_id, payload.deal_id]
  );

  if (dup.rowCount === 0) {
    const evidenceId = `email_link_token:deal:${payload.deal_id}:bor:${payload.borrower_id}:iat:${payload.issued_at}`;
    await consent.recordBlanketConsent({
      deal_id: payload.deal_id,
      borrower_id: payload.borrower_id,
      evidence_source: 'email_link_token',
      evidence_id: evidenceId,
      evidence_url: null,
      consent_ip: clientIp(req),
      consent_user_agent: clientUa(req),
      recorded_by: null,
    });
  }

  res.send(consentLandingThankYou());
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Status read — per-borrower consent state on a deal
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/consent/status/:dealId', authenticateToken, async (req, res) => {
  try {
    if (!isInternal(req)) return res.status(403).json({ error: 'Internal users only' });
    const dealId = Number(req.params.dealId);

    const dealRow = await pool.query(
      `SELECT broker_consent_attested_at, broker_consent_attested_by, broker_consent_attested_ip
         FROM deal_submissions WHERE id = $1`,
      [dealId]
    );
    if (dealRow.rowCount === 0) return res.status(404).json({ error: 'deal not found' });

    const consents = await pool.query(
      `SELECT id, borrower_id, consent_type, evidence_source, evidence_id,
              consented_at, expires_at, revoked_at
         FROM borrower_consents
        WHERE deal_id = $1
        ORDER BY consented_at DESC`,
      [dealId]
    );

    res.json({
      success: true,
      deal_id: dealId,
      broker_attestation: dealRow.rows[0],
      consent_rows: consents.rows,
    });
  } catch (err) {
    console.error('[consent/status] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HTML rendering helpers — public landing page
// ─────────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function consentPageShell(inner) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Daksfirst Consent</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #F5F5F0; color: #222; margin: 0; padding: 24px; }
    .card { max-width: 720px; margin: 24px auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 32px; }
    h1 { color: #D4A853; margin-top: 0; font-size: 22px; }
    h2 { color: #333; font-size: 16px; margin-top: 24px; }
    p, li { line-height: 1.6; font-size: 14px; }
    .consent-text { background: #FAFAF5; padding: 16px 20px; border-radius: 6px; border-left: 3px solid #D4A853; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
    label.tickbox { display: flex; gap: 10px; align-items: flex-start; margin: 18px 0; cursor: pointer; user-select: none; }
    input[type="checkbox"] { margin-top: 3px; transform: scale(1.2); }
    button { background: #D4A853; color: #111; border: none; padding: 12px 32px; border-radius: 5px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .meta { color: #666; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px; }
    .ok-banner { background: #d4f0d4; border: 1px solid #34a853; padding: 14px 18px; border-radius: 6px; color: #1a601a; }
    .err-banner { background: #fde4e4; border: 1px solid #d33; padding: 14px 18px; border-radius: 6px; color: #a00; }
  </style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;
}

function consentLandingPage({ token, borrower, payload }) {
  const expiresOn = new Date(payload.expires_at * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return consentPageShell(`
    <h1>Daksfirst Limited — Consent for credit and identity checks</h1>
    <p>Hello <strong>${escapeHtml(borrower.full_name || 'Borrower')}</strong>,</p>
    <p>To progress your loan application, please read the consent below carefully and confirm by ticking the box and clicking <strong>Confirm consent</strong>.</p>
    <h2>What you are agreeing to</h2>
    <div class="consent-text">${escapeHtml(consent.CONSENT_TEXT_BODY)}</div>
    <form method="POST" action="/api/consent/sign?token=${encodeURIComponent(token)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <label class="tickbox">
        <input type="checkbox" name="confirmed" value="yes" required onchange="document.getElementById('btn').disabled = !this.checked" />
        <span>I confirm I have read the consent text above and I agree to it.</span>
      </label>
      <button id="btn" type="submit" disabled>Confirm consent</button>
    </form>
    <div class="meta">
      Consent text version: <strong>${escapeHtml(payload.consent_text_version)}</strong> · Link expires: <strong>${escapeHtml(expiresOn)}</strong><br />
      Daksfirst Limited — FRN 937220 — Privacy: <a href="https://daksfirst.com/privacy">daksfirst.com/privacy</a>
    </div>
  `);
}

function consentLandingThankYou() {
  return consentPageShell(`
    <h1>Thank you</h1>
    <div class="ok-banner">Your consent has been recorded. We have received your authorisation to proceed with credit and identity checks for your loan application.</div>
    <p style="margin-top:18px;">You can close this page. Your broker will be in touch with the next steps.</p>
    <div class="meta">Daksfirst Limited — FRN 937220</div>
  `);
}

function consentLandingAlreadyDone(borrower, firstConsentAt) {
  const when = new Date(firstConsentAt).toLocaleString('en-GB');
  return consentPageShell(`
    <h1>Consent already recorded</h1>
    <div class="ok-banner">Hello ${escapeHtml(borrower.full_name || 'there')}, we already recorded your consent on ${escapeHtml(when)}. No further action needed.</div>
    <p style="margin-top:18px;">If you wish to withdraw consent or have questions, contact your broker or Daksfirst at support@daksfirst.com.</p>
    <div class="meta">Daksfirst Limited — FRN 937220</div>
  `);
}

function consentLandingError(message) {
  return consentPageShell(`
    <h1>Unable to load consent page</h1>
    <div class="err-banner">${escapeHtml(message)}</div>
    <p style="margin-top:18px;">If this link came from us recently, please request a fresh link from your Daksfirst contact or your broker.</p>
    <div class="meta">Daksfirst Limited — FRN 937220</div>
  `);
}

module.exports = router;
