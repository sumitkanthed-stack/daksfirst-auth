/**
 * PTAL (Public Transport Accessibility Level) lookup service
 *
 * TfL's PTAL measures how accessible a London location is via public transport.
 * Scored 0 (no access) to 6b (excellent — central London). It's an OFFICIAL
 * TfL metric, published as free open data at data.london.gov.uk, and the
 * UK standard for public-transport-accessibility scoring used by planning
 * authorities, lenders, and valuers.
 *
 * Dataset: TfL "2015 PTAL Grid Values" — 100m grid covering Greater London,
 * ~150,000 cells. We use the 2015 release because it's the most recent
 * public version (TfL has newer internal updates but this is the free one).
 *
 * Data file:   data/ptal-2015-grid.csv  (committed to repo, ~5.2 MB)
 * Format:      ID, X (BNG easting), Y (BNG northing), AI2015, PTAL2015
 * Units:       British National Grid metres (EPSG:27700)
 * Coverage:    Greater London only — returns null for anywhere else
 *
 * On server startup this module loads the CSV into memory (~150k rows),
 * builds a kd-tree spatial index (kdbush), and exports getPtalForLatLng(lat, lng)
 * which:
 *   1. Bounding-box checks the input against Greater London (early return)
 *   2. Converts WGS84 lat/lng to BNG easting/northing via proj4
 *   3. Queries the kd-tree for the nearest grid cell
 *   4. Returns { ptal, ai, distance_m } or null
 *
 * Typical lookup: <1ms after startup. Startup cost: ~200ms to parse CSV
 * + build index (one-off per process).
 */

const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');
const KDBush = require('kdbush');

// ─── Coordinate reference systems ────────────────────────────────────────────
// WGS84 is the global lat/lng standard (what Chimnie returns).
// EPSG:27700 is British National Grid — what TfL's PTAL grid uses.
// proj4's defs already include WGS84 and EPSG:4326; we register BNG explicitly
// because it's not bundled by default.

proj4.defs('EPSG:27700',
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 ' +
  '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 ' +
  '+units=m +no_defs');

// Greater London bounding box in WGS84 — used for quick reject before conversion.
// Values sourced from ONS Geography boundaries; slightly padded to avoid
// edge-case false negatives on M25-adjacent properties.
const LONDON_BBOX = {
  minLat: 51.25,   // ~Coulsdon
  maxLat: 51.72,   // ~Enfield
  minLng: -0.55,   // ~Uxbridge
  maxLng: 0.35     // ~Upminster
};

// ─── Load data on module init ────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, '..', 'data', 'ptal-2015-grid.csv');

let _grid = null;        // parallel typed arrays for X, Y, PTAL, AI
let _index = null;       // KDBush spatial index
let _loaded = false;
let _loadError = null;

function _loadGrid() {
  if (_loaded) return;
  try {
    if (!fs.existsSync(DATA_PATH)) {
      _loadError = `PTAL grid file not found at ${DATA_PATH}`;
      console.warn('[ptal] ' + _loadError);
      _loaded = true;  // mark loaded so we don't re-try every call
      return;
    }
    const t0 = Date.now();
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    // Strip BOM if present (Excel UTF-8 export sometimes adds one)
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const lines = text.split(/\r?\n/);

    // First line is header: ID,X,Y,AI2015,PTAL2015
    // Validate header matches what we expect (fail loud if TfL changes format)
    const header = (lines[0] || '').toLowerCase().split(',').map(s => s.trim());
    const idxX = header.indexOf('x');
    const idxY = header.indexOf('y');
    const idxAI = header.findIndex(h => h.startsWith('ai'));
    const idxPTAL = header.findIndex(h => h.startsWith('ptal'));
    if (idxX < 0 || idxY < 0 || idxPTAL < 0) {
      _loadError = 'PTAL grid header missing expected columns: ' + header.join(',');
      console.error('[ptal] ' + _loadError);
      _loaded = true;
      return;
    }

    const n = lines.length - 1;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const ptal = new Array(n);
    const ai = new Float64Array(n);
    let rowCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',');
      const x = parseFloat(cols[idxX]);
      const y = parseFloat(cols[idxY]);
      if (!isFinite(x) || !isFinite(y)) continue;
      xs[rowCount] = x;
      ys[rowCount] = y;
      ai[rowCount] = parseFloat(cols[idxAI]) || 0;
      // PTAL is a banded string: '0', '1a', '1b', '2', '3', '4', '5', '6a', '6b'.
      // Trim quotes if Excel wrapped it.
      ptal[rowCount] = (cols[idxPTAL] || '').replace(/^"|"$/g, '').trim() || '0';
      rowCount++;
    }

    // Truncate typed arrays to actual row count
    const xFinal = xs.slice(0, rowCount);
    const yFinal = ys.slice(0, rowCount);
    const aiFinal = ai.slice(0, rowCount);
    const ptalFinal = ptal.slice(0, rowCount);

    // Build 2D kd-tree index. KDBush API v4:
    //   const index = new KDBush(n); for (let i = 0; i < n; i++) index.add(x[i], y[i]); index.finish();
    const index = new KDBush(rowCount);
    for (let i = 0; i < rowCount; i++) index.add(xFinal[i], yFinal[i]);
    index.finish();

    _grid = { x: xFinal, y: yFinal, ai: aiFinal, ptal: ptalFinal, n: rowCount };
    _index = index;
    _loaded = true;
    console.log(`[ptal] Loaded ${rowCount.toLocaleString()} grid cells from ${path.basename(DATA_PATH)} in ${Date.now() - t0}ms`);
  } catch (err) {
    _loadError = 'PTAL grid load failed: ' + err.message;
    console.error('[ptal] ' + _loadError);
    _loaded = true;
  }
}

// Trigger load immediately on module import so first request is fast.
_loadGrid();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up the PTAL score for a WGS84 lat/lng point.
 *
 * @param {number} lat  WGS84 latitude (e.g. 51.4934 for Hammersmith)
 * @param {number} lng  WGS84 longitude (e.g. -0.2229)
 * @returns {null | { ptal: string, ai: number, distance_m: number, in_london: boolean }}
 *    null if the grid data isn't loaded OR lat/lng is invalid.
 *    { in_london: false } if the point is outside Greater London bbox.
 *    { ptal, ai, distance_m, in_london: true } on success.
 */
function getPtalForLatLng(lat, lng) {
  if (!_loaded || !_index) return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;

  // Quick London bbox reject — saves the proj4 conversion for out-of-London
  if (lat < LONDON_BBOX.minLat || lat > LONDON_BBOX.maxLat ||
      lng < LONDON_BBOX.minLng || lng > LONDON_BBOX.maxLng) {
    return { in_london: false, ptal: null, ai: null, distance_m: null };
  }

  // Convert WGS84 (lng, lat) to BNG (easting, northing)
  let easting, northing;
  try {
    [easting, northing] = proj4('EPSG:4326', 'EPSG:27700', [lng, lat]);
  } catch (err) {
    console.warn('[ptal] proj4 conversion failed:', err.message);
    return null;
  }

  // Query the kd-tree for points within 100m (diagonal of the 100m cell is
  // sqrt(2)*100 ≈ 141m, but we use 100m to stay strictly "within a cell").
  // kdbush's `within` returns indices of matching points.
  const SEARCH_RADIUS_M = 100;
  const neighbours = _index.within(easting, northing, SEARCH_RADIUS_M);
  if (neighbours.length === 0) {
    // Point is in London bbox but not on the PTAL grid — possible if it's on
    // the Thames, a park with no grid cells, or right at the boundary.
    return { in_london: true, ptal: null, ai: null, distance_m: null };
  }

  // Find the NEAREST of the neighbours (kdbush.within returns all within radius,
  // not sorted by distance)
  let bestIdx = neighbours[0];
  let bestDist = _dist2(easting, northing, _grid.x[bestIdx], _grid.y[bestIdx]);
  for (let i = 1; i < neighbours.length; i++) {
    const idx = neighbours[i];
    const d = _dist2(easting, northing, _grid.x[idx], _grid.y[idx]);
    if (d < bestDist) { bestDist = d; bestIdx = idx; }
  }

  return {
    in_london: true,
    ptal: _grid.ptal[bestIdx],
    ai: _grid.ai[bestIdx],
    distance_m: Math.round(Math.sqrt(bestDist))
  };
}

function _dist2(x1, y1, x2, y2) {
  const dx = x1 - x2, dy = y1 - y2;
  return dx * dx + dy * dy;
}

/**
 * Diagnostics for the /health endpoint — tells us if the grid loaded OK.
 */
function getStatus() {
  return {
    loaded: _loaded && _grid !== null,
    cells: _grid ? _grid.n : 0,
    dataPath: DATA_PATH,
    error: _loadError
  };
}

module.exports = {
  getPtalForLatLng,
  getStatus,
  _loadGrid  // exposed for tests / manual reload
};
