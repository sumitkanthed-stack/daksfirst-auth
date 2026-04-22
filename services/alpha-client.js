/**
 * Daksfirst Alpha Client (risk modeling / underwriting engine)
 * https://daksfirst-alpha.onrender.com  (Frankfurt, EEA — data residency)
 *
 * Alpha is deployed separately (Python/FastAPI on Render) and provides the
 * 6-stage underwriting pipeline: ingest -> market enrichment -> PCA ->
 * per-schema scorers -> fuzzy NN -> action points. Auth calls alpha for
 * deal scoring and feeds scored data back into the matrix UI.
 *
 * Integration pattern follows services/chimnie.js + services/companies-house.js:
 *   - fail-soft: every call returns {success, ...} — never throws
 *   - timeouts via AbortSignal.timeout
 *   - log every call for audit/troubleshooting
 *
 * Auth today (verified 2026-04-22 against alpha scaffold):
 *   - X-API-Key header, shared secret. Alpha checks x-api-key == settings.alpha_api_key
 *     at app/api/v1/score.py::require_api_key.
 *   - HMAC body verification is NOT enforced on alpha side. We still sign
 *     the body with ALPHA_WEBHOOK_SECRET and send X-Signature so that when
 *     alpha adds verification (planned, tracked in alpha's "Stage 1 ingest"
 *     runbook), we're already compliant. Today the header is a no-op.
 *
 * Endpoint inventory (verified live 2026-04-22):
 *   GET  /                               — public, service name + version
 *   GET  /health                         — public, version + db + model registry state
 *   POST /api/v1/score                   — auth required, full pipeline (404-safe: needs models loaded)
 *   POST /api/v1/ingest/deal             — auth required, store raw features only
 *   POST /api/v1/ingest/bulk-csv         — auth required, partner lender CSV
 *   POST /api/v1/ingest/outcome          — auth required, record realised outcome
 *
 * Cold start: Render free tier spins down after ~15 min idle. The first
 * call after idle can take 20-40s. ping() uses an extended timeout to
 * absorb this on smoke tests; generic alphaFetch uses 10s — callers
 * hitting /score should pass a longer timeoutMs.
 *
 * PII: never send borrower names, addresses, phones, DoBs to alpha. Feature
 * vectors only (numeric + categorical). Sanitise upstream of this client.
 */

const crypto = require('crypto');
const config = require('../config');

const DEFAULT_TIMEOUT_MS = 10000;
const PING_TIMEOUT_MS = 30000; // absorb Render free-tier cold start on smoke test

// ─── HMAC signing (optional, gated on ALPHA_WEBHOOK_SECRET) ───────────────────

/**
 * Compute sha256 HMAC of the request body using ALPHA_WEBHOOK_SECRET.
 * Returns hex string for X-Signature header, or null if secret is unset.
 *
 * Exported for unit testing.
 *
 * @param {string} bodyString  the exact JSON string that will be sent
 * @returns {string|null}
 */
function signBody(bodyString) {
  const secret = config.ALPHA_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto
    .createHmac('sha256', secret)
    .update(bodyString || '', 'utf8')
    .digest('hex');
}

// ─── Core fetch helper ────────────────────────────────────────────────────────

/**
 * All alpha calls funnel through here. Handles auth header, optional HMAC
 * signing, timeout, and error normalisation. Never throws.
 *
 * @param {'GET'|'POST'} method
 * @param {string} path                   e.g. "/health" or "/api/v1/score"
 * @param {object} [body]                 JSON-serialisable body for POST
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<{
 *   success: boolean,
 *   status?: number,
 *   data?: any,
 *   error?: string,
 *   raw?: string,
 *   latency_ms: number
 * }>}
 */
async function alphaFetch(method, path, body = null, opts = {}) {
  const baseUrl = (config.ALPHA_BASE_URL || '').trim();
  if (!baseUrl) {
    return { success: false, error: 'ALPHA_BASE_URL not configured', latency_ms: 0 };
  }

  const apiKey = (config.ALPHA_API_KEY || '').trim();
  if (!apiKey) {
    return { success: false, error: 'ALPHA_API_KEY not configured', latency_ms: 0 };
  }

  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl.replace(/\/$/, '')}${normalisedPath}`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const bodyString = body ? JSON.stringify(body) : null;

  const headers = {
    'Accept': 'application/json',
    'X-API-Key': apiKey,
  };
  if (bodyString) {
    headers['Content-Type'] = 'application/json';
    const sig = signBody(bodyString);
    if (sig) headers['X-Signature'] = sig; // no-op today; alpha may enforce later
  }

  console.log(`[alpha-client] ${method} ${normalisedPath} (timeout=${timeoutMs}ms)`);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyString || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency_ms = Date.now() - startedAt;

    const contentType = res.headers.get('content-type') || '';
    let parsed = null;
    let raw = '';
    if (contentType.includes('application/json')) {
      parsed = await res.json().catch(() => null);
    } else {
      raw = await res.text().catch(() => '');
    }

    if (!res.ok) {
      console.warn(`[alpha-client] ${method} ${normalisedPath} -> ${res.status} (${latency_ms}ms)`);
      return {
        success: false,
        status: res.status,
        error: `alpha returned ${res.status}`,
        data: parsed,
        raw: raw || undefined,
        latency_ms,
      };
    }

    console.log(`[alpha-client] ${method} ${normalisedPath} -> 200 (${latency_ms}ms)`);
    return { success: true, status: res.status, data: parsed, latency_ms };
  } catch (err) {
    const latency_ms = Date.now() - startedAt;
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    const reason = isTimeout ? `timeout after ${timeoutMs}ms` : err.message;
    console.warn(`[alpha-client] ${method} ${normalisedPath} FAILED: ${reason} (${latency_ms}ms)`);
    return { success: false, error: reason, latency_ms };
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Smoke test — GET /health on alpha with a long timeout to survive a
 * Render free-tier cold start. Use from admin route / ops dashboards
 * to verify the pipe is wired up before running scoring calls.
 *
 * /health is public on alpha, but we still send X-API-Key so this call
 * exercises the full auth header stack (catches config drift early).
 */
async function ping() {
  return alphaFetch('GET', '/health', null, { timeoutMs: PING_TIMEOUT_MS });
}

module.exports = {
  ping,
  alphaFetch,
  signBody, // exposed for unit tests
  // Endpoint constants for downstream consumers — avoid magic strings
  PATHS: {
    HEALTH: '/health',
    ROOT: '/',
    SCORE: '/api/v1/score',
    INGEST_DEAL: '/api/v1/ingest/deal',
    INGEST_BULK_CSV: '/api/v1/ingest/bulk-csv',
    INGEST_OUTCOME: '/api/v1/ingest/outcome',
  },
};
