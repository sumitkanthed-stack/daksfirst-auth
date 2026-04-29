/**
 * Freshness gate for paid + cached data sources · FRESH-GATE (2026-04-29)
 *
 * Each external data source has a sensible re-pull interval. RM clicking the
 * refresh chip triggers a check here before the live API call fires; if the
 * cached row is fresh, we return early and avoid burning credits/£.
 *
 * Rules (per-source):
 *   chimnie  : 30 days   — AVM + comparables shift with market
 *   pd       : 30 days   — PropertyData rental medians shift
 *   paf      : 365 days  — Royal Mail addresses ~never change
 *   ptal     : 365 days  — TfL re-grids rarely
 *   area     : 90 days   — LA boundaries / school catchments
 *   land_reg : 90 days   — HMLR price-paid open data, slow-moving
 *   epc      : 365 days  — EPC certs valid 10y; updates lag the cert
 *   hmlr     : NEVER     — official copy is authoritative until legal event.
 *                          Force-only. RM confirms £3 charge per pull.
 *
 * Each chip on the property card shows the freshness age + colour band
 * (green = fresh, amber = stale, red = never pulled or paid+confirm-needed).
 *
 * Public API:
 *   FRESHNESS_RULES  — frozen object of source_key → { freshDays, paidPence, requiresConfirm }
 *   isFresh(pulledAt, sourceKey, options) — returns boolean
 *   ageDays(pulledAt) — returns whole days since pulledAt; null if pulledAt null
 *   ageBand(pulledAt, sourceKey) — returns 'fresh' | 'stale' | 'never'
 *   ageLabel(pulledAt) — short human label e.g. '3d', '12d', '14mo', 'never'
 *
 * Usage in a service wrapper:
 *   const freshness = require('./freshness');
 *   if (freshness.isFresh(prop.chimnie_pulled_at, 'chimnie') && !options.force) {
 *     return { ok: true, skipped: true, reason: 'fresh', age_days: ... };
 *   }
 *   // else fire live API
 */

const FRESHNESS_RULES = Object.freeze({
  chimnie:  { freshDays: 30,        paidPence: 10,  requiresConfirm: false },
  pd:       { freshDays: 30,        paidPence: 14,  requiresConfirm: false },
  paf:      { freshDays: 365,       paidPence: 4,   requiresConfirm: false },
  ptal:     { freshDays: 365,       paidPence: 0,   requiresConfirm: false },
  area:     { freshDays: 90,        paidPence: 0,   requiresConfirm: false },
  land_reg: { freshDays: 90,        paidPence: 0,   requiresConfirm: false },
  epc:      { freshDays: 365,       paidPence: 0,   requiresConfirm: false },
  hmlr:     { freshDays: Infinity,  paidPence: 300, requiresConfirm: true  },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ageDays(pulledAt) {
  if (!pulledAt) return null;
  const ts = pulledAt instanceof Date ? pulledAt : new Date(pulledAt);
  if (isNaN(ts.getTime())) return null;
  return Math.floor((Date.now() - ts.getTime()) / MS_PER_DAY);
}

function isFresh(pulledAt, sourceKey, options = {}) {
  const rule = FRESHNESS_RULES[sourceKey];
  if (!rule) {
    throw new Error(`freshness: unknown source key '${sourceKey}'. Known: ${Object.keys(FRESHNESS_RULES).join(', ')}`);
  }
  // HMLR is never auto-fresh — once pulled, RM still has to force any re-pull
  // (and the confirm dialog handles the £ charge). isFresh returns true so
  // the wrapper can short-circuit and skip the API call by default.
  if (rule.freshDays === Infinity) {
    return !!pulledAt;  // any prior pull is "fresh enough" — never auto re-pull
  }
  const age = ageDays(pulledAt);
  if (age === null) return false;
  return age < rule.freshDays;
}

function ageBand(pulledAt, sourceKey) {
  if (!pulledAt) return 'never';
  return isFresh(pulledAt, sourceKey) ? 'fresh' : 'stale';
}

function ageLabel(pulledAt) {
  const age = ageDays(pulledAt);
  if (age === null) return 'never';
  if (age === 0) return 'today';
  if (age === 1) return '1d';
  if (age < 30) return `${age}d`;
  if (age < 365) return `${Math.round(age / 30)}mo`;
  return `${Math.round(age / 365)}y`;
}

module.exports = {
  FRESHNESS_RULES,
  isFresh,
  ageDays,
  ageBand,
  ageLabel,
};
