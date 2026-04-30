/**
 * routes/invite.js — Broker invite-token registration · ROLLOUT-A (2026-04-29)
 *
 *   POST /api/admin/invite-broker     (admin) — mint token + email broker
 *   GET  /api/invite/sign?token=...    (public) — landing page
 *   POST /api/invite/accept?token=...  (public) — set password, create user
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const invite = require('../services/invite');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || req.ip
      || null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/admin/invite-broker  (admin only)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/admin/invite-broker', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { email, first_name, last_name, company, fca_number } = req.body || {};
    if (!email || !first_name || !last_name) {
      return res.status(400).json({ error: 'email, first_name, last_name required' });
    }

    // Refuse if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [String(email).toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const token = invite.signInviteToken({ email, first_name, last_name, company, fca_number, ttlDays: 14 });
    const baseUrl = config.AUTH_PUBLIC_BASE_URL || 'https://auth.daksfirst.com';
    const inviteUrl = `${baseUrl}/api/invite/sign?token=${encodeURIComponent(token)}`;

    // Send the invite email via Graph
    try {
      const { getGraphToken } = require('../services/graph');
      const tok = await getGraphToken();
      const sendUrl = `https://graph.microsoft.com/v1.0/users/${config.GRAPH_USER_EMAIL}/sendMail`;
      const subject = `You're invited to the Daksfirst Limited broker portal`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;max-width:560px;">
          <p>Dear ${escapeHtml(first_name)},</p>
          <p>You've been invited to register on the Daksfirst Limited broker portal. Click the secure link below to set your password and access your dashboard.</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${inviteUrl}" style="display:inline-block;padding:12px 28px;background:#D4A853;color:#111;text-decoration:none;border-radius:5px;font-weight:600;">
              Accept invite + set password
            </a>
          </p>
          <p style="font-size:12px;color:#666;">This invite expires in 14 days. If you didn't expect this, please ignore this email.</p>
          <p style="font-size:12px;color:#666;">Daksfirst Limited — FRN 937220</p>
        </div>`.trim();
      const r = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject, body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: email } }],
            from: { emailAddress: { address: config.GRAPH_USER_EMAIL, name: config.BRAND_NAME || 'Daksfirst Limited' } },
          },
          saveToSentItems: true,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Graph sendMail ${r.status}: ${t.substring(0, 200)}`);
      }
    } catch (mailErr) {
      console.error('[invite-broker] email send failed:', mailErr.message);
      return res.status(502).json({ error: `Email send failed: ${mailErr.message}`, invite_url: inviteUrl });
    }

    res.json({
      success: true,
      message: `Invite sent to ${email} (expires 14 days)`,
      invite_url: inviteUrl,
    });
  } catch (err) {
    console.error('[invite-broker] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/invite/sign?token=...  (public landing)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/invite/sign', async (req, res) => {
  const token = req.query.token;
  let payload;
  try {
    payload = invite.verifyInviteToken(token);
  } catch (e) {
    return res.status(400).send(invitePageShell(`<h1>Invalid or expired invite</h1><div class="err-banner">${escapeHtml(e.message)}</div><p>Ask Daksfirst for a fresh invite link.</p>`));
  }
  // If user already registered, send them to login
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [payload.email]);
  if (existing.rows.length > 0) {
    return res.send(invitePageShell(`
      <h1>Already registered</h1>
      <div class="ok-banner">An account for <strong>${escapeHtml(payload.email)}</strong> already exists. Sign in instead.</div>
      <p style="margin-top:20px;"><a href="https://apply.daksfirst.com" style="color:#D4A853;font-weight:600;">Go to apply.daksfirst.com →</a></p>
    `));
  }
  res.send(invitePageShell(`
    <h1>Welcome to Daksfirst Limited</h1>
    <p>Hello <strong>${escapeHtml(payload.first_name || 'there')}</strong>, set a password below to activate your broker account.</p>
    <form method="POST" action="/api/invite/accept?token=${encodeURIComponent(token)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <table style="width:100%;font-size:14px;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#666;width:120px;">Email</td><td style="padding:6px 0;"><strong>${escapeHtml(payload.email)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Name</td><td style="padding:6px 0;"><strong>${escapeHtml((payload.first_name || '') + ' ' + (payload.last_name || ''))}</strong></td></tr>
        ${payload.company ? `<tr><td style="padding:6px 0;color:#666;">Company</td><td style="padding:6px 0;"><strong>${escapeHtml(payload.company)}</strong></td></tr>` : ''}
        ${payload.fca_number ? `<tr><td style="padding:6px 0;color:#666;">FCA</td><td style="padding:6px 0;"><strong>${escapeHtml(payload.fca_number)}</strong></td></tr>` : ''}
      </table>
      <label style="display:block;font-weight:500;margin-top:14px;">Choose a password</label>
      <input type="password" name="password" minlength="10" required placeholder="Min 10 characters"
        style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:5px;font-size:14px;margin-top:6px;" />
      <label style="display:block;font-weight:500;margin-top:14px;">Confirm password</label>
      <input type="password" name="password_confirm" minlength="10" required placeholder="Type it again"
        style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:5px;font-size:14px;margin-top:6px;" />
      <button type="submit" style="background:#D4A853;color:#111;border:none;padding:11px 28px;border-radius:5px;font-size:14px;font-weight:600;cursor:pointer;margin-top:18px;">
        Activate account
      </button>
    </form>
    <div class="meta">Daksfirst Limited — FRN 937220</div>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/invite/accept?token=...  (public)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/invite/accept', express.urlencoded({ extended: true }), async (req, res) => {
  const token = req.query.token || req.body.token;
  let payload;
  try {
    payload = invite.verifyInviteToken(token);
  } catch (e) {
    return res.status(400).send(invitePageShell(`<h1>Invalid invite</h1><div class="err-banner">${escapeHtml(e.message)}</div>`));
  }
  const password = req.body && req.body.password;
  const confirm  = req.body && req.body.password_confirm;
  if (!password || password.length < 10) {
    return res.status(400).send(invitePageShell(`<h1>Password too short</h1><div class="err-banner">Minimum 10 characters.</div><p><a href="javascript:history.back()">Back</a></p>`));
  }
  if (password !== confirm) {
    return res.status(400).send(invitePageShell(`<h1>Passwords don't match</h1><div class="err-banner">Please re-type carefully.</div><p><a href="javascript:history.back()">Back</a></p>`));
  }

  // Idempotency — if user exists, just send them to login
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [payload.email]);
  if (existing.rows.length > 0) {
    return res.send(invitePageShell(`<h1>Already registered</h1><div class="ok-banner">Account exists — please sign in.</div><p style="margin-top:20px;"><a href="https://apply.daksfirst.com" style="color:#D4A853;font-weight:600;">Go to apply.daksfirst.com →</a></p>`));
  }

  // Create the user — broker role, auto-verified (admin-issued invite)
  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    await pool.query(`
      INSERT INTO users (role, first_name, last_name, email, company, fca_number, password_hash, source, email_verified_at)
      VALUES ('broker', $1, $2, $3, $4, $5, $6, 'invite', NOW())
    `, [
      payload.first_name || 'Broker',
      payload.last_name  || '',
      payload.email,
      payload.company || null,
      payload.fca_number || null,
      hashedPassword,
    ]);
    res.send(invitePageShell(`
      <h1>Account activated</h1>
      <div class="ok-banner">Your Daksfirst broker account is ready. Click below to sign in.</div>
      <p style="text-align:center;margin:28px 0;">
        <a href="https://apply.daksfirst.com" style="display:inline-block;padding:12px 28px;background:#D4A853;color:#111;text-decoration:none;border-radius:5px;font-weight:600;">
          Sign in to apply.daksfirst.com →
        </a>
      </p>
      <div class="meta">Daksfirst Limited — FRN 937220</div>
    `));
  } catch (err) {
    console.error('[invite/accept] error:', err);
    res.status(500).send(invitePageShell(`<h1>Could not activate</h1><div class="err-banner">${escapeHtml(err.message)}</div>`));
  }
});

// ─── HTML shell for invite landing pages ──────────────────────────────────
function invitePageShell(inner) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Daksfirst Broker Invite</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #F5F5F0; color: #222; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 32px auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 32px; }
    h1 { color: #D4A853; margin-top: 0; font-size: 22px; }
    p, td { line-height: 1.6; font-size: 14px; }
    .ok-banner { background: #d4f0d4; border: 1px solid #34a853; padding: 14px 18px; border-radius: 6px; color: #1a601a; }
    .err-banner { background: #fde4e4; border: 1px solid #d33; padding: 14px 18px; border-radius: 6px; color: #a00; }
    .meta { color: #666; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px; }
    a { color: #D4A853; }
  </style>
</head>
<body><div class="card">${inner}</div></body>
</html>`;
}

module.exports = router;
