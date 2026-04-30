/**
 * Broker invite token service · ROLLOUT-A (2026-04-29)
 *
 * Stateless invite tokens — admin issues, broker clicks, registers.
 * HMAC-signed JWT-style token (mirrors services/consent.js pattern).
 *
 * Token payload:
 *   { e: email, fn: first_name, ln: last_name, co: company, fca, iat, exp }
 *
 * Default TTL: 14 days. Token must be unused (verified by checking that no
 * user with that email exists yet).
 */

const crypto = require('crypto');
const config = require('../config');

const INVITE_VERSION = 'v1';

function getSecret() {
  const s = process.env.INVITE_TOKEN_SECRET || config.WEBHOOK_SECRET;
  if (!s) throw new Error('invite: no INVITE_TOKEN_SECRET or WEBHOOK_SECRET set');
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Sign a fresh invite token.
 *   payload: { email, first_name, last_name, company, fca_number }
 */
function signInviteToken({ email, first_name, last_name, company, fca_number, ttlDays = 14 }) {
  if (!email) throw new Error('invite: email required');
  const payload = {
    v: INVITE_VERSION,
    e:  String(email).toLowerCase(),
    fn: first_name || null,
    ln: last_name  || null,
    co: company    || null,
    fca: fca_number || null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest();
  return body + '.' + b64urlEncode(sig);
}

function verifyInviteToken(token) {
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
    throw new Error('invite token expired');
  }
  return {
    email: payload.e,
    first_name: payload.fn,
    last_name: payload.ln,
    company: payload.co,
    fca_number: payload.fca,
    issued_at: payload.iat,
    expires_at: payload.exp,
    version: payload.v,
  };
}

module.exports = {
  INVITE_VERSION,
  signInviteToken,
  verifyInviteToken,
};
