/**
 * SONIA fetcher — PRICE-10 (2026-04-29)
 *
 * Pulls the latest published SONIA (Sterling Overnight Index Average)
 * from the Bank of England's Interactive Database CSV endpoint and
 * UPDATES pricing_assumptions.sonia_value_bps + sonia_last_pulled_at
 * in place.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ⚠ APPEND-ONLY EXCEPTION (intentional, documented):
 *
 *  SONIA is the ONE field on pricing_assumptions that we update in place
 *  rather than versioning. Reasons:
 *    - SONIA changes daily (252+ updates/year); a new pricing_version per
 *      day would balloon the audit trail without analytic value.
 *    - The OUTPUT of every pricing call is fully pinned in deal_pricings
 *      (recommended_*, calculated_yield_apr_bps, required_yield_apr_bps,
 *      margin_buffer_bps, stress_matrix_jsonb). Replay reproducibility
 *      lives there, not in the input config.
 *    - SONIA is live market data, not policy. Treating it as policy
 *      versioning creates noise in the assumptions audit log.
 *
 *  Every fetch UPDATEs:
 *    pricing_assumptions.sonia_value_bps    → integer bps from BoE
 *    pricing_assumptions.sonia_last_pulled_at → JSONB { timestamp, source_date, source }
 *
 *  We DO NOT version-bump. We DO NOT touch any other field.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * BoE source:
 *   https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp
 *   Series code: IUDSOIA
 *   Format: CSV with header + rows "DD MMM YYYY,X.XXXX"
 *
 * Fetcher requests the last 14 days (handles weekends/bank holidays) and
 * picks the most recent valid row.
 *
 * Failure modes:
 *   - Network/HTTP error  → throws, caller logs and surfaces
 *   - Empty/malformed CSV → throws with a parse-error message
 *   - Stale data (>14 d)  → throws "stale" — manual investigation needed
 *
 * Manual trigger via POST /api/admin/pricing/sonia-pull (routes/pricing.js).
 * Cron setup is Render-config (see CONTINUITY).
 */

const pool = require('../db/pool');

const BOE_BASE = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp';
const SERIES_CODE = 'IUDSOIA';
const STALE_DAYS_THRESHOLD = 14;

// ─── Date helpers ───────────────────────────────────────────────────────
const MONTH_3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtBoeDate(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mmm = MONTH_3[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mmm}/${yyyy}`;
}
function parseBoeDate(s) {
  // "29 Apr 2026"
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const day = Number(parts[0]);
  const mon = MONTH_3.indexOf(parts[1]);
  const yr = Number(parts[2]);
  if (mon < 0 || !Number.isFinite(day) || !Number.isFinite(yr)) return null;
  return new Date(Date.UTC(yr, mon, day));
}

// ─── BoE CSV pull ───────────────────────────────────────────────────────
/**
 * Returns the raw CSV text from BoE for the last `days` days for SONIA.
 * Throws on any non-200 response.
 */
async function fetchBoeCsv(days = 14) {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    'csv.x': 'yes',
    'Datefrom': fmtBoeDate(from),
    'Dateto': fmtBoeDate(to),
    'SeriesCodes': SERIES_CODE,
    'CSVF': 'TN',
    'UsingCodes': 'Y',
    'VPD': 'Y',
    'VFD': 'N',
  });
  const url = `${BOE_BASE}?${params.toString()}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'text/csv,*/*', 'User-Agent': 'Daksfirst-Pricing-Engine/1.0' },
  });
  if (!resp.ok) {
    throw new Error(`BoE fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  return await resp.text();
}

/**
 * Parse the BoE CSV. Returns the most recent { date, sonia_pct } pair, OR
 * throws if no valid rows in the last STALE_DAYS_THRESHOLD days.
 *
 * BoE CSV shape (TN format):
 *   "Title,IUDSOIA"            (header)
 *   "Series Description,..."   (metadata)
 *   "Source,..."
 *   "...other metadata..."
 *   "29 Apr 2026,4.1234"       (data rows)
 */
function parseBoeCsv(csv) {
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const dataRows = [];
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length < 2) continue;
    const dateRaw = cols[0].replace(/^"|"$/g, '');
    const valRaw = cols[1].replace(/^"|"$/g, '');
    const date = parseBoeDate(dateRaw);
    const val = Number(valRaw);
    if (date && Number.isFinite(val)) {
      dataRows.push({ date, sonia_pct: val });
    }
  }
  if (dataRows.length === 0) {
    throw new Error(`BoE CSV contained no parseable SONIA rows (length=${csv.length})`);
  }
  // Sort descending by date, take most recent
  dataRows.sort((a, b) => b.date - a.date);
  const latest = dataRows[0];
  const ageDays = (Date.now() - latest.date.getTime()) / (24 * 3600 * 1000);
  if (ageDays > STALE_DAYS_THRESHOLD) {
    throw new Error(`BoE SONIA latest=${latest.date.toISOString().substring(0,10)} is ${ageDays.toFixed(1)}d old (threshold ${STALE_DAYS_THRESHOLD}d) — manual investigation needed`);
  }
  return latest;
}

// ─── Public: fetch + persist ────────────────────────────────────────────

/**
 * Pulls latest SONIA from BoE and UPDATEs pricing_assumptions in place
 * (the documented exception to append-only). Returns the snapshot.
 *
 * If the active version doesn't have a sonia_value_bps row yet, no-op
 * (pricing_assumptions UPSERT pattern requires a v1+ active version
 * present — should always be true post-PRICE-2).
 */
async function fetchAndStore(client) {
  const db = client || pool;
  const csv = await fetchBoeCsv(14);
  const latest = parseBoeCsv(csv);
  const sonia_bps = Math.round(latest.sonia_pct * 100); // 4.1234% → 412 bps

  // Find active assumptions version
  const versionRow = (await db.query(
    `SELECT version FROM pricing_assumptions_versions WHERE is_active = TRUE LIMIT 1`
  )).rows[0];
  if (!versionRow) {
    throw new Error('No active pricing_assumptions_versions row — cannot persist SONIA');
  }
  const version = versionRow.version;

  // UPDATE in place — the one exception to append-only
  await db.query(
    `UPDATE pricing_assumptions
        SET value_bps = $1,
            source = 'live',
            citation = $2,
            last_changed_at = NOW(),
            change_reason = $3
      WHERE version = $4 AND key = 'sonia_value_bps'`,
    [
      sonia_bps,
      `BoE IUDSOIA ${latest.date.toISOString().substring(0,10)}`,
      `Auto-pulled from BoE IADB; latest published rate ${latest.sonia_pct.toFixed(4)}%`,
      version
    ]
  );

  // Also update sonia_last_pulled_at (JSONB) for audit
  await db.query(
    `UPDATE pricing_assumptions
        SET value_jsonb = $1::jsonb,
            source = 'live',
            citation = 'BoE IADB autopull',
            last_changed_at = NOW(),
            change_reason = 'Auto-pulled by services/sonia-fetcher.js'
      WHERE version = $2 AND key = 'sonia_last_pulled_at'`,
    [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        source_date: latest.date.toISOString().substring(0,10),
        source: 'BoE IADB IUDSOIA',
        sonia_pct: latest.sonia_pct,
        sonia_bps,
      }),
      version
    ]
  );

  return {
    sonia_bps,
    sonia_pct: latest.sonia_pct,
    source_date: latest.date.toISOString().substring(0,10),
    fetched_at: new Date().toISOString(),
    pricing_assumptions_version: version,
  };
}

module.exports = {
  fetchAndStore,
  // exposed for testing:
  fetchBoeCsv,
  parseBoeCsv,
  fmtBoeDate,
  parseBoeDate,
};
