/**
 * deal-risk.js — Risk View section renderer for /deal/:id
 * ─────────────────────────────────────────────────────────
 * Reads `risk_view` rows for a deal via the new admin read API,
 * paints a verdict ribbon + run rail + 5 sub-tabs in the
 * Daksfirst dark theme. Append-only, read-only — the only write
 * action exposed here is the existing "Run Risk Analysis" trigger.
 *
 * Architecture:
 *   - GET /api/admin/risk-view/:dealId/runs        — list with verdict
 *   - GET /api/admin/risk-view/:dealId/runs/:runId — full row + raw_response
 *   - POST /api/admin/risk-runs/start              — manual trigger (unchanged)
 *
 * The 9 dimensions and 3 latent layers are taxonomic — they reflect the v3
 * rubric's analytical asks. Claude column is hydrated from raw_response.
 * Alpha column is PENDING until alpha service ships scorers (see
 * project_alpha_pipeline_spec.md). Analyst column is read-only for now;
 * override-write is a future workstream.
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { showToast, sanitizeHtml } from './utils.js';

// ─────────────────────────────────────────────────────────────────
// 9 dimensions — names, weights, matrix-canonical sources, alpha schema pointer.
// Weights total 100%. Mirrors v3 rubric's Layer 1 + adds Compliance (dim 9).
// ─────────────────────────────────────────────────────────────────
const DIMENSIONS = [
  { id: 'borrower_profile', name: 'Borrower profile & track record', weight: 17.5,
    sources: 'corporates · borrowers · CH age/officers · accounts',
    alphaSchema: 'schema_borrower_profile' },
  { id: 'borrower_alm', name: 'Borrower ALM (assets, liabilities, means)', weight: 17.5,
    sources: 'borrowers.kyc_data · ALIE · bank statements · deposit_source',
    alphaSchema: 'schema_borrower_alm' },
  { id: 'guarantors', name: 'Guarantors', weight: 10,
    sources: 'borrowers.pg_required · ai_termsheet_data.pg_from_ubo',
    alphaSchema: 'schema_guarantors' },
  { id: 'property_physical', name: 'Property (physical)', weight: 10,
    sources: 'deal_properties · chimnie · EPC · flood/subsidence',
    alphaSchema: 'schema_property_physical' },
  { id: 'valuation', name: 'Valuation & market comparables', weight: 20,
    sources: 'deal_properties.market_value · chimnie_avm_* · area sales · 5y change',
    alphaSchema: 'schema_valuation' },
  { id: 'use_of_funds', name: 'Use of funds', weight: 5,
    sources: 'deal.purchase_price · refurb_cost · loan_facts',
    alphaSchema: 'schema_use_of_funds' },
  { id: 'exit', name: 'Exit scenario', weight: 10,
    sources: 'exit_strategy · term_months · projected rental · CH accounts',
    alphaSchema: 'schema_exit' },
  { id: 'legal_insurance', name: 'Legal & insurance', weight: 5,
    sources: 'leasehold_remaining · ownership chain · charges · insurance',
    alphaSchema: 'schema_legal_insurance' },
  { id: 'compliance_kyc', name: 'Compliance & KYC', weight: 5,
    sources: 'pep_status · sanctions_status · adverse media',
    alphaSchema: 'schema_compliance_kyc' },
];

// 3 emergent latent layers. PCA loadings are conceptual until alpha runs PCA.
const LATENT_LAYERS = [
  { id: 'valuation_integrity', name: 'Valuation Integrity', weighting: 40,
    drivers: ['valuation', 'property_physical', 'use_of_funds'],
    blurb: 'Whether the portfolio is worth what the deal claims.' },
  { id: 'sponsor_credibility', name: 'Sponsor Credibility & Means', weighting: 35,
    drivers: ['borrower_profile', 'borrower_alm', 'guarantors', 'compliance_kyc'],
    blurb: 'Whether the people behind the deal can deliver and bear loss.' },
  { id: 'refinance_pathway', name: 'Refinance Pathway', weighting: 25,
    drivers: ['exit', 'borrower_profile', 'legal_insurance'],
    blurb: 'Whether the agreed exit is realistically achievable in the term.' },
];

// ─────────────────────────────────────────────────────────────────
// Verdict colour map — matches semantic palette in theme-preview.html.
// ─────────────────────────────────────────────────────────────────
const VERDICT_STYLE = {
  LOW:      { bg: 'rgba(52,211,153,0.12)',  fg: '#34D399', border: 'rgba(52,211,153,0.30)' },
  MODERATE: { bg: 'rgba(96,165,250,0.12)',  fg: '#60A5FA', border: 'rgba(96,165,250,0.30)' },
  ELEVATED: { bg: 'rgba(251,191,36,0.12)',  fg: '#FBBF24', border: 'rgba(251,191,36,0.30)' },
  HIGH:     { bg: 'rgba(248,113,113,0.12)', fg: '#F87171', border: 'rgba(248,113,113,0.30)' },
  CRITICAL: { bg: 'rgba(220,38,38,0.18)',   fg: '#FCA5A5', border: 'rgba(220,38,38,0.45)' },
};
const STATUS_STYLE = {
  pending: { fg: '#94A3B8', bg: 'rgba(148,163,184,0.12)', label: 'PENDING' },
  running: { fg: '#60A5FA', bg: 'rgba(96,165,250,0.12)',  label: 'RUNNING' },
  success: { fg: '#34D399', bg: 'rgba(52,211,153,0.12)',  label: 'SUCCESS' },
  failed:  { fg: '#F87171', bg: 'rgba(248,113,113,0.12)', label: 'FAILED'  },
};

// Module-scope cache so sub-tab clicks don't re-fetch.
let __riskState = {
  dealId: null,
  runs: [],
  activeRunId: null,
  activeRun: null,        // full row when fetched
  activeTab: 'narrative', // narrative | dimensions | latents | telemetry | history
};

// ═════════════════════════════════════════════════════════════════
// PUBLIC ENTRY — called from deal-sections.js master render
// ═════════════════════════════════════════════════════════════════
export async function renderRiskSection(deal, role) {
  if (!deal || !deal.id) return;
  const allowed = ['rm', 'credit', 'compliance', 'admin'];
  if (!allowed.includes(role)) return; // role gating already hides the section

  __riskState.dealId = deal.id;
  // activeTab default is set after loadFullRun, once we know if it's v3.1.
  __riskState.activeTab = 'narrative';

  const host = document.getElementById('risk-content');
  if (!host) return;
  host.innerHTML = `<div style="padding:40px 0;text-align:center;color:#64748B;font-size:13px;">Loading Risk View…</div>`;

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/risk-view/${deal.id}/runs`);
    if (!res.ok) throw new Error(`runs fetch ${res.status}`);
    const data = await res.json();
    __riskState.runs = Array.isArray(data.runs) ? data.runs : [];
  } catch (err) {
    host.innerHTML = renderErrorPanel(err.message);
    return;
  }

  // Choose active run = newest success, or newest of any status.
  const successes = __riskState.runs.filter(r => r.status === 'success');
  const active = successes[0] || __riskState.runs[0] || null;
  __riskState.activeRunId = active ? active.id : null;

  if (active && active.status === 'success') {
    await loadFullRun(active.id);
  } else {
    __riskState.activeRun = active;
  }

  // Default tab: v3.1 runs land on the verdict tab; v3 runs keep narrative.
  __riskState.activeTab = isV31Run(__riskState.activeRun) ? 'verdict' : 'narrative';

  paint(deal, role);
}

// ═════════════════════════════════════════════════════════════════
// FETCH FULL RUN ROW — incl. raw_response markdown
// ═════════════════════════════════════════════════════════════════
async function loadFullRun(runId) {
  if (!__riskState.dealId || !runId) return;
  try {
    const res = await fetchWithAuth(
      `${API_BASE}/api/admin/risk-view/${__riskState.dealId}/runs/${runId}`
    );
    if (!res.ok) throw new Error(`run fetch ${res.status}`);
    const data = await res.json();
    __riskState.activeRun = data.run || null;
    __riskState.activeRunId = runId;
  } catch (err) {
    console.error('[deal-risk] loadFullRun failed:', err);
    showToast(`Risk run ${runId} fetch failed`, 'error');
  }
}

// ═════════════════════════════════════════════════════════════════
// MAIN PAINT
// ═════════════════════════════════════════════════════════════════
function paint(deal, role) {
  const host = document.getElementById('risk-content');
  if (!host) return;

  if (__riskState.runs.length === 0) {
    host.innerHTML = renderEmptyState(deal, role);
    wireTriggerButton(deal);
    return;
  }

  const active = __riskState.activeRun;
  host.innerHTML = `
    ${renderHero(active, deal, role)}
    ${renderRunRail()}
    ${renderSubTabs()}
    <div id="risk-tab-panel" style="padding:0;">${renderActiveTab(deal)}</div>
  `;

  // Update the section-header pill so collapsed state still shows verdict.
  paintHeaderPill(active);

  // Wire interactions
  wireTriggerButton(deal);
  wireRunRailClicks(deal, role);
  wireSubTabClicks(deal);
  wireV31LatentDrivers();
}

// ═════════════════════════════════════════════════════════════════
// SECTION-HEADER VERDICT PILL  (visible even when section collapsed)
// ═════════════════════════════════════════════════════════════════
function paintHeaderPill(activeRun) {
  const pill = document.getElementById('risk-headline-pill');
  if (!pill) return;
  if (!activeRun || activeRun.status !== 'success' || !activeRun.verdict) {
    pill.style.display = 'none';
    return;
  }
  const v = activeRun.verdict.toUpperCase();
  const s = VERDICT_STYLE[v] || VERDICT_STYLE.MODERATE;
  pill.style.display = 'inline-block';
  pill.style.background = s.bg;
  pill.style.color = s.fg;
  pill.style.border = `1px solid ${s.border}`;
  pill.textContent = v;
}

// ═════════════════════════════════════════════════════════════════
// EMPTY STATE — no runs yet
// ═════════════════════════════════════════════════════════════════
function renderEmptyState(deal, role) {
  return `
    <div style="padding:40px 28px;text-align:center;">
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:22px;color:#F1F5F9;margin-bottom:8px;">No risk analysis yet</div>
      <div style="font-size:13px;color:#94A3B8;max-width:520px;margin:0 auto 22px;line-height:1.6;">
        Run the rubric against the canonical matrix to produce the first risk view. Each run is an immutable artefact stamped with rubric &amp; macro versions and the data stage at the moment of analysis.
      </div>
      <button id="risk-trigger-btn" style="padding:11px 22px;background:#D4A853;color:#0B1120;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:.3px;">
        Run Risk Analysis
      </button>
      <div style="margin-top:14px;font-size:11px;color:#64748B;">~£2 / run · Opus 4.6 · ~100s latency</div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════
// HERO — verdict ribbon
// ═════════════════════════════════════════════════════════════════
function renderHero(run, deal, role) {
  if (!run) return '';
  const v = run.verdict ? run.verdict.toUpperCase() : null;
  const vs = v ? (VERDICT_STYLE[v] || VERDICT_STYLE.MODERATE) : null;
  // v3.1 grade code (e.g. "7CD") — used when legacy verdict enum is absent.
  const gmFinal = run && run.grade_matrix && run.grade_matrix.final;
  const gradeCode = (gmFinal && gmFinal.pd != null && gmFinal.lgd && gmFinal.ia)
    ? `${gmFinal.pd}${String(gmFinal.lgd).toUpperCase()}${String(gmFinal.ia).toUpperCase()}`
    : null;
  const gradeBand = gradeCode ? PD_BAND(Number(gmFinal.pd) || 0) : null;
  const stage = run.data_stage ? run.data_stage.replace('_', ' ') : '—';
  const completed = run.completed_at ? new Date(run.completed_at).toLocaleString() : 'in flight';
  const cost = (run.cost_gbp != null) ? `£${Number(run.cost_gbp).toFixed(2)}` : '—';
  const latency = run.latency_ms ? `${(run.latency_ms / 1000).toFixed(1)}s` : '—';
  const tokensIn = run.input_tokens ? Number(run.input_tokens).toLocaleString() : '—';
  const tokensOut = run.output_tokens ? Number(run.output_tokens).toLocaleString() : '—';

  // Headline = first sentence under "Headline:" if present, else first non-empty
  // line of raw_response after the verdict.
  const headline = extractHeadline(run.raw_response);

  return `
    <div style="padding:18px 24px;background:linear-gradient(180deg,#0F172A 0%,#0B1120 100%);border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        ${v ? `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:120px;padding:14px 18px;border-radius:10px;background:${vs.bg};border:1px solid ${vs.border};">
            <div style="font-size:10px;color:${vs.fg};font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.85;">Verdict</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:700;color:${vs.fg};letter-spacing:.5px;line-height:1;margin-top:2px;">${v}</div>
          </div>
        ` : (gradeCode ? `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:120px;padding:14px 18px;border-radius:10px;background:${gradeBand.bg};border:1px solid ${gradeBand.border};">
            <div style="font-size:10px;color:${gradeBand.fg};font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.85;">Grade</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:700;color:${gradeBand.fg};letter-spacing:.5px;line-height:1;margin-top:2px;">${gradeCode}</div>
            <div style="font-size:9px;color:${gradeBand.fg};opacity:.7;text-transform:uppercase;letter-spacing:.4px;margin-top:3px;">PD · LGD · IA</div>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:120px;padding:14px 18px;border-radius:10px;background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.18);">
            <div style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;">Verdict</div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:22px;font-weight:600;color:#94A3B8;margin-top:6px;">—</div>
          </div>
        `)}
        <div style="flex:1;min-width:280px;">
          <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px;">
            Run #${run.id} · ${sanitizeHtml(stage)} · rubric v${run.rubric_version || '?'} ${run.rubric_stale ? '<span style="color:#FBBF24;">(stale)</span>' : ''}
          </div>
          <div style="font-size:14px;color:#F1F5F9;line-height:1.55;font-weight:500;max-width:780px;">
            ${headline ? sanitizeHtml(headline) : '<span style="color:#94A3B8;">No headline parsed.</span>'}
          </div>
          <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:#94A3B8;">
            <span><strong style="color:#CBD5E1;">${completed}</strong></span>
            <span>cost <strong style="color:#D4A853;">${cost}</strong></span>
            <span>latency <strong style="color:#CBD5E1;">${latency}</strong></span>
            <span>tokens <strong style="color:#CBD5E1;">${tokensIn} in / ${tokensOut} out</strong></span>
            <span>by <strong style="color:#CBD5E1;">${sanitizeHtml(run.triggered_by || '—')}</strong></span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          <button id="risk-trigger-btn" style="padding:10px 18px;background:#D4A853;color:#0B1120;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:.3px;">Run Risk Analysis</button>
          <div style="font-size:10px;color:#64748B;">manual trigger · ~£2/run</div>
        </div>
      </div>
    </div>
  `;
}

function extractHeadline(raw) {
  if (!raw) return null;
  // Try "**Headline:** ..." first.
  const m = raw.match(/\*\*\s*Headline\s*:\s*\*\*\s*([^\n]+)/i);
  if (m) return m[1].trim();
  // Fallback: first sentence after Layer 3 heading.
  const m2 = raw.match(/Layer\s*3[\s\S]{0,200}?\n([^\n]+)/i);
  if (m2) return m2[1].replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
  return null;
}

// ═════════════════════════════════════════════════════════════════
// RUN RAIL — horizontal pill row, newest first
// ═════════════════════════════════════════════════════════════════
function renderRunRail() {
  if (__riskState.runs.length === 0) return '';
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 24px;background:#0a0f1a;border-bottom:1px solid rgba(255,255,255,0.06);overflow-x:auto;">
      <span style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:.6px;font-weight:600;flex-shrink:0;">Run history</span>
      ${__riskState.runs.map(r => renderRunPill(r)).join('')}
    </div>
  `;
}

function renderRunPill(r) {
  const isActive = r.id === __riskState.activeRunId;
  const v = r.verdict ? r.verdict.toUpperCase() : null;
  const vs = v ? (VERDICT_STYLE[v] || VERDICT_STYLE.MODERATE) : null;
  const ss = STATUS_STYLE[r.status] || STATUS_STYLE.pending;
  const date = r.completed_at ? new Date(r.completed_at).toLocaleDateString() : 'pending';
  const fg = r.status === 'success' && vs ? vs.fg : ss.fg;
  const bg = r.status === 'success' && vs ? vs.bg : ss.bg;
  const border = isActive
    ? '#D4A853'
    : (r.status === 'success' && vs ? vs.border : 'rgba(255,255,255,0.08)');
  const label = r.status === 'success' ? (v || 'OK') : ss.label;
  const stale = r.rubric_stale ? `<span style="font-size:9px;color:#FBBF24;margin-left:6px;">stale</span>` : '';
  return `
    <button data-run-id="${r.id}" class="risk-rail-pill"
      style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:18px;background:${bg};color:${fg};border:1px solid ${border};font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;transition:all .15s;">
      <span style="font-weight:700;">#${r.id}</span>
      <span>${label}</span>
      <span style="color:#94A3B8;font-weight:500;">· ${sanitizeHtml(date)}</span>
      ${stale}
    </button>
  `;
}

// ═════════════════════════════════════════════════════════════════
// SUB-TABS
// ═════════════════════════════════════════════════════════════════
function renderSubTabs() {
  const tabs = [];
  if (isV31Run(__riskState.activeRun)) {
    tabs.push({ id: 'verdict', label: 'Verdict (v3.1)' });
  }
  tabs.push(
    { id: 'narrative',  label: 'Narrative' },
    { id: 'dimensions', label: '9 Dimensions × 3 Readers' },
    { id: 'latents',    label: '3 Emergent Layers' },
    { id: 'telemetry',  label: 'Telemetry' },
    { id: 'history',    label: 'Append-Only History' },
  );
  return `
    <div style="display:flex;gap:0;padding:0 24px;background:#111827;border-bottom:1px solid rgba(255,255,255,0.06);">
      ${tabs.map(t => {
        const active = t.id === __riskState.activeTab;
        return `
          <button data-risk-tab="${t.id}"
            style="padding:12px 18px;background:transparent;border:none;border-bottom:2px solid ${active ? '#D4A853' : 'transparent'};color:${active ? '#D4A853' : '#94A3B8'};font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.3px;transition:all .15s;">
            ${t.label}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════
// ACTIVE TAB — switch
// ═════════════════════════════════════════════════════════════════
function renderActiveTab(deal) {
  const run = __riskState.activeRun;
  if (!run) return `<div style="padding:30px;text-align:center;color:#94A3B8;">Run not loaded.</div>`;

  switch (__riskState.activeTab) {
    case 'verdict':    return renderV31VerdictTab(run);
    case 'narrative':  return renderNarrativeTab(run);
    case 'dimensions': return renderDimensionsTab(run);
    case 'latents':    return renderLatentsTab(run);
    case 'telemetry':  return renderTelemetryTab(run);
    case 'history':    return renderHistoryTab();
    default:           return isV31Run(run) ? renderV31VerdictTab(run) : renderNarrativeTab(run);
  }
}

// ─── Tab 1: Narrative ────────────────────────────────────────────
function renderNarrativeTab(run) {
  if (!run.raw_response) {
    return `<div style="padding:30px;text-align:center;color:#94A3B8;">No narrative — run status is <strong style="color:#F1F5F9;">${sanitizeHtml(run.status || '?')}</strong>${run.error_message ? ': ' + sanitizeHtml(String(run.error_message).slice(0, 240)) : ''}.</div>`;
  }
  return `
    <div style="padding:24px 30px;max-width:920px;margin:0 auto;">
      <div class="risk-md" style="font-size:13.5px;line-height:1.75;color:#CBD5E1;">
        ${renderMarkdown(run.raw_response)}
      </div>
    </div>
  `;
}

// ─── Tab 2: 9 Dimensions × 3 Readers ─────────────────────────────
function renderDimensionsTab(run) {
  const claudeBy = parseDimensionClaude(run.raw_response);
  return `
    <div style="padding:18px 24px;">
      <div style="display:grid;grid-template-columns:minmax(220px,2.2fr) 70px repeat(3, minmax(220px,2fr));gap:0;border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;background:#0F172A;">
        ${renderDimHeaderRow()}
        ${DIMENSIONS.map((d, i) => renderDimRow(d, i, claudeBy[d.id] || null)).join('')}
      </div>
      <div style="margin-top:14px;font-size:11px;color:#64748B;line-height:1.6;">
        Each row is an independent read. Claude renders the v3 rubric narrative; Alpha (ML schema) and Analyst (human override) populate as those workstreams ship.
      </div>
    </div>
  `;
}

function renderDimHeaderRow() {
  const cellH = 'padding:11px 14px;font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;letter-spacing:.7px;background:#0a0f1a;border-bottom:1px solid rgba(255,255,255,0.08);';
  return `
    <div style="${cellH}">Dimension · matrix sources</div>
    <div style="${cellH}text-align:right;">Weight</div>
    <div style="${cellH}border-left:1px solid rgba(255,255,255,0.06);">Claude (LLM)</div>
    <div style="${cellH}border-left:1px solid rgba(255,255,255,0.06);">Alpha (ML)</div>
    <div style="${cellH}border-left:1px solid rgba(255,255,255,0.06);">Analyst</div>
  `;
}

function renderDimRow(dim, i, claude) {
  const oddBg = i % 2 ? '#0F172A' : '#111827';
  const cell = `padding:14px;background:${oddBg};border-top:1px solid rgba(255,255,255,0.04);`;
  const grade = claude && claude.grade ? claude.grade.toUpperCase() : null;
  const vs = grade ? (VERDICT_STYLE[grade] || VERDICT_STYLE.MODERATE) : null;
  return `
    <div style="${cell}">
      <div style="font-size:13px;color:#F1F5F9;font-weight:600;line-height:1.35;">${sanitizeHtml(dim.name)}</div>
      <div style="font-size:10.5px;color:#64748B;margin-top:4px;line-height:1.5;">${sanitizeHtml(dim.sources)}</div>
    </div>
    <div style="${cell}text-align:right;">
      <div style="font-size:14px;color:#D4A853;font-weight:700;">${dim.weight}%</div>
    </div>
    <div style="${cell}border-left:1px solid rgba(255,255,255,0.06);">
      ${grade ? `
        <span style="display:inline-block;padding:3px 10px;border-radius:10px;background:${vs.bg};color:${vs.fg};border:1px solid ${vs.border};font-size:10px;font-weight:700;letter-spacing:.4px;">${grade}</span>
      ` : `
        <span style="display:inline-block;padding:3px 10px;border-radius:10px;background:rgba(148,163,184,0.10);color:#94A3B8;border:1px solid rgba(148,163,184,0.18);font-size:10px;font-weight:700;letter-spacing:.4px;">UNGRADED</span>
      `}
      ${claude && claude.excerpt ? `
        <div style="font-size:11.5px;color:#CBD5E1;line-height:1.55;margin-top:8px;max-width:38ch;">${sanitizeHtml(claude.excerpt)}</div>
      ` : ''}
    </div>
    <div style="${cell}border-left:1px solid rgba(255,255,255,0.06);">
      <span style="display:inline-block;padding:3px 10px;border-radius:10px;background:rgba(96,165,250,0.10);color:#60A5FA;border:1px solid rgba(96,165,250,0.18);font-size:10px;font-weight:700;letter-spacing:.4px;">PENDING</span>
      <div style="font-size:10.5px;color:#64748B;margin-top:8px;font-family:'Inter',sans-serif;">${dim.alphaSchema}</div>
    </div>
    <div style="${cell}border-left:1px solid rgba(255,255,255,0.06);">
      <span style="display:inline-block;padding:3px 10px;border-radius:10px;background:rgba(148,163,184,0.10);color:#94A3B8;border:1px solid rgba(148,163,184,0.18);font-size:10px;font-weight:700;letter-spacing:.4px;">NO OVERRIDE</span>
      <div style="font-size:10.5px;color:#64748B;margin-top:8px;">— accept Claude grade</div>
    </div>
  `;
}

/**
 * Pull "Grade" + first-sentence excerpt for each dimension out of the v3 rubric
 * Layer-1 table. Returns { dimId: { grade, excerpt } }.
 *
 * The v3 rubric prompt makes Claude emit Layer 1 as either:
 *   - a markdown pipe table:  | # | **Name** | **Grade** | weight | prose |
 *   - or an HTML table:       <tr><td>#</td><td><strong>Name</strong></td><td><strong>Grade</strong></td><td>w</td><td>prose</td></tr>
 *
 * We try both. Bold markers around name/grade are optional in markdown, and
 * in HTML we strip <strong> / inline-styled tags before matching.
 */
function parseDimensionClaude(raw) {
  if (!raw) return {};
  const out = {};
  // Order matters: more specific patterns FIRST. /^property/ at the bottom is
  // a catch-all so per-property rows ("Property — Flat 2, King Henrys Reach")
  // still aggregate into property_physical.
  const map = [
    [/borrower\s+profile/i,                'borrower_profile'],
    [/borrower\s+ALM|assets,?\s+liabilities/i, 'borrower_alm'],
    [/guarantor/i,                         'guarantors'],
    [/valuation/i,                         'valuation'],
    [/use\s+of\s+funds/i,                  'use_of_funds'],
    [/exit\s+(scenario|strategy|pathway)/i, 'exit'],
    [/legal\s+(&|and)\s+insurance/i,       'legal_insurance'],
    [/compliance|KYC|PEP|sanctions/i,      'compliance_kyc'],
    [/^property\b/i,                       'property_physical'],
  ];

  // Worst-of grade aggregation — the v3 rubric splits Property (physical)
  // into one row per property, so we may see 2-4 "Property — Flat X" rows
  // that all map to property_physical. Take the most pessimistic grade and
  // count the others into a "+N more" suffix.
  const GRADE_RANK = {
    pass: 1, low: 2, acceptable: 2, ok: 2,
    moderate: 3, medium: 3,
    elevated: 4, high: 5,
    severe: 6, critical: 7, failure: 8, fail: 8, veto: 9, vetoed: 9,
  };
  const rankOf = (g) => GRADE_RANK[String(g || '').toLowerCase().trim()] ?? 0;

  const stripTags = (s) => String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const tryAssign = (dimName, grade, excerpt) => {
    const cleanName = stripTags(dimName);
    const cleanGrade = stripTags(grade);
    if (!cleanName || !cleanGrade) return;
    const cleanExcerpt = stripTags(excerpt).slice(0, 340);
    for (const [re, id] of map) {
      if (!re.test(cleanName)) continue;
      const existing = out[id];
      if (!existing) {
        out[id] = { grade: cleanGrade, excerpt: cleanExcerpt, _count: 1 };
      } else {
        // Aggregate: keep worst grade, append "+N more" to excerpt.
        const newRank = rankOf(cleanGrade);
        const oldRank = rankOf(existing.grade);
        const winnerGrade = newRank > oldRank ? cleanGrade : existing.grade;
        const winnerExcerpt = newRank > oldRank ? cleanExcerpt : existing.excerpt;
        out[id] = {
          grade: winnerGrade,
          excerpt: winnerExcerpt,
          _count: (existing._count || 1) + 1,
        };
      }
      break;
    }
  };

  // 1. Markdown pipe rows (bold markers around name/grade optional)
  const mdRowRe = /\|\s*\d+\s*\|\s*\*?\*?([^|]+?)\*?\*?\s*\|\s*\*?\*?([^|]+?)\*?\*?\s*\|\s*([^|]*)\|\s*([^|]+?)(?:\||\n)/g;
  let m;
  while ((m = mdRowRe.exec(raw)) !== null) {
    tryAssign(m[1], m[2], m[4]);
  }

  // 2. HTML <tr> rows — match 5+ <td> cells, capture cells 2 (name), 3 (grade), 5 (provenance)
  const htmlRowRe = /<tr\b[^>]*>\s*<td\b[^>]*>\s*\d+\s*<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>[\s\S]*?<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let h;
  while ((h = htmlRowRe.exec(raw)) !== null) {
    tryAssign(h[1], h[2], h[3]);
  }

  // Append "+N more" suffix where multiple rows aggregated into one slot.
  for (const k of Object.keys(out)) {
    if (out[k]._count > 1) {
      out[k].excerpt = `${out[k].excerpt} (+${out[k]._count - 1} more, worst-of shown)`;
    }
    delete out[k]._count;
  }

  return out;
}

// ─── Tab 3: 3 Emergent Layers (PCA bridge) ──────────────────────
function renderLatentsTab(run) {
  return `
    <div style="padding:18px 24px;">
      <div style="padding:14px 18px;background:rgba(212,168,83,0.05);border:1px solid rgba(212,168,83,0.18);border-radius:10px;font-size:12px;color:#CBD5E1;line-height:1.6;margin-bottom:18px;">
        <strong style="color:#D4A853;text-transform:uppercase;letter-spacing:.4px;font-size:11px;">PCA bridge</strong> &nbsp;·&nbsp; The 9 dimensions collapse onto 3 emergent latent factors that drive deal-level risk. Loadings are conceptual until alpha runs PCA on the historical book; the layer narratives below are Claude's read of the v3 rubric output.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;">
        ${LATENT_LAYERS.map(L => renderLatentCard(L, run)).join('')}
      </div>
      <div style="margin-top:18px;">
        ${renderCrossDimCard(run)}
      </div>
    </div>
  `;
}

function renderLatentCard(layer, run) {
  // Layer-2 grade/blurb scrape
  const composite = parseLatentClaude(run.raw_response, layer.id);
  const grade = composite?.grade || null;
  const vs = grade ? (VERDICT_STYLE[grade] || VERDICT_STYLE.MODERATE) : null;

  return `
    <div style="padding:16px;border-radius:10px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <div>
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:16px;color:#F1F5F9;font-weight:600;">${sanitizeHtml(layer.name)}</div>
          <div style="font-size:10.5px;color:#64748B;margin-top:2px;">PCA loading ~${layer.weighting}%</div>
        </div>
        ${grade ? `<span style="padding:3px 10px;border-radius:10px;background:${vs.bg};color:${vs.fg};border:1px solid ${vs.border};font-size:10px;font-weight:700;letter-spacing:.4px;">${grade}</span>` : ''}
      </div>
      <div style="font-size:11.5px;color:#94A3B8;line-height:1.55;margin-bottom:10px;">${sanitizeHtml(layer.blurb)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${layer.drivers.map(d => {
          const dim = DIMENSIONS.find(x => x.id === d);
          return `<span style="font-size:10px;color:#CBD5E1;background:rgba(96,165,250,0.10);border:1px solid rgba(96,165,250,0.18);padding:2px 8px;border-radius:8px;">${sanitizeHtml(dim ? dim.name.split(/[\s&(]/)[0] : d)}</span>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:6px;font-size:10px;">
        <span style="flex:1;padding:5px 8px;border-radius:6px;background:rgba(212,168,83,0.08);border:1px solid rgba(212,168,83,0.18);color:#D4A853;font-weight:600;text-align:center;">Claude ${grade || '—'}</span>
        <span style="flex:1;padding:5px 8px;border-radius:6px;background:rgba(96,165,250,0.10);border:1px solid rgba(96,165,250,0.18);color:#60A5FA;font-weight:600;text-align:center;">Alpha PEND</span>
        <span style="flex:1;padding:5px 8px;border-radius:6px;background:rgba(148,163,184,0.10);border:1px solid rgba(148,163,184,0.18);color:#94A3B8;font-weight:600;text-align:center;">Analyst —</span>
      </div>
      ${composite?.excerpt ? `<div style="font-size:11.5px;color:#CBD5E1;line-height:1.6;margin-top:10px;padding-top:10px;border-top:1px dashed rgba(255,255,255,0.05);">${sanitizeHtml(composite.excerpt)}</div>` : ''}
    </div>
  `;
}

function parseLatentClaude(raw, layerId) {
  if (!raw) return null;
  const map = {
    valuation_integrity: /Composite\s+A[:\s]\s*\*\*Valuation\s+Integrity\*\*([\s\S]+?)(?=Composite\s+B|##|$)/i,
    sponsor_credibility: /Composite\s+B[:\s]\s*\*\*Sponsor[\s\S]+?\*\*([\s\S]+?)(?=Composite\s+C|##|$)/i,
    refinance_pathway:   /Composite\s+C[:\s]\s*\*\*Refinance[\s\S]+?\*\*([\s\S]+?)(?=##|---|$)/i,
  };
  const re = map[layerId];
  if (!re) return null;
  const m = raw.match(re);
  if (!m) return null;
  const block = m[1];
  const gradeM = block.match(/\*\*This\s+composite\s+is\s+(LOW|MODERATE|ELEVATED|HIGH|CRITICAL)\.?\*\*/i)
              || block.match(/\*\*\s*(LOW|MODERATE|ELEVATED|HIGH|CRITICAL)\s*\*\*/i);
  const firstSentence = block.replace(/\s+/g, ' ').replace(/^\s*\*+\s*/, '').trim().split(/(?<=[.])\s/).slice(0, 2).join(' ').slice(0, 480);
  return {
    grade: gradeM ? gradeM[1].toUpperCase() : null,
    excerpt: firstSentence,
  };
}

function renderCrossDimCard(run) {
  const cross = (run.raw_response || '').match(/Cross-Dimensional\s+Interactions[\s\S]+?(?=##|---|$)/i);
  if (!cross) return '';
  return `
    <div style="padding:14px 18px;background:#0F172A;border-radius:10px;border:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:11px;color:#FBBF24;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Cross-Dimensional Interactions</div>
      <div class="risk-md" style="font-size:12px;color:#CBD5E1;line-height:1.7;">${renderMarkdown(cross[0].replace(/^##\s*Cross-Dimensional\s+Interactions/i, ''))}</div>
    </div>
  `;
}

// ─── Tab 4: Telemetry ────────────────────────────────────────────
function renderTelemetryTab(run) {
  const rows = [
    ['Run id',           `#${run.id}`],
    ['Status',           run.status],
    ['Data stage',       run.data_stage],
    ['Triggered by',     run.triggered_by || '—'],
    ['Created at',       fmtTs(run.created_at)],
    ['Completed at',     fmtTs(run.completed_at)],
    ['Latency',          run.latency_ms ? `${(run.latency_ms / 1000).toFixed(2)}s` : '—'],
    ['Model',            run.model],
    ['Temperature',      run.model_temperature],
    ['Max tokens',       run.model_max_tokens],
    ['Input tokens',     run.input_tokens?.toLocaleString() || '—'],
    ['Output tokens',    run.output_tokens?.toLocaleString() || '—'],
    ['Cost (GBP est)',   run.cost_gbp != null ? `£${Number(run.cost_gbp).toFixed(4)}` : '—'],
    ['Rubric prompt id', `#${run.rubric_prompt_id} (v${run.rubric_version || '?'}${run.rubric_stale ? ', stale' : ''})`],
    ['Macro prompt id',  `#${run.macro_prompt_id} (v${run.macro_version || '?'}${run.macro_stale ? ', stale' : ''})`],
    ['Sensitivity calc', run.sensitivity_calculator_version || '—'],
    ['Raw response',     `${run.raw_response ? run.raw_response.length.toLocaleString() : 0} chars`],
    ['Parsed grades',    run.parsed_grades ? 'present' : 'null'],
    ['Error',            run.error_message || '—'],
  ];

  // ─── Provenance: data sources that fed into this run ─────────────────
  // Pulled from input_payload.source_provenance (set by risk-packager).
  // Includes per-block attached counts so RM can audit which signals
  // Opus had visibility on. Counts of 0 mean the relevant block was
  // empty at packaging time (no data pulled yet, or genuinely absent).
  let provenance = null;
  try {
    const ip = run.input_payload;
    const parsed = (typeof ip === 'string') ? JSON.parse(ip) : ip;
    provenance = parsed?.source_provenance || null;
  } catch (_) { /* ignore parse errors */ }

  const provenanceRows = provenance ? [
    ['Properties',           `${provenance.properties_count ?? '—'}`],
    ['Borrowers',            `${provenance.borrowers_count ?? '—'}`],
    ['Companies House',      `${provenance.companies_house_count ?? '—'}`],
    ['Chimnie attached',     `${provenance.chimnie_attached_count ?? 0} of ${provenance.properties_count ?? '?'}`],
    ['Area intel attached',  `${provenance.area_intel_attached_count ?? 0} of ${provenance.properties_count ?? '?'}`],
    ['PTAL attached',        `${provenance.ptal_attached_count ?? 0} of ${provenance.properties_count ?? '?'}`],
    ['PAF verified',         `${provenance.paf_attached_count ?? 0} of ${provenance.properties_count ?? '?'}`],
    ['PropertyData attached', `${provenance.propertydata_attached_count ?? 0} of ${provenance.properties_count ?? '?'}`],
    ['Credit checks',        `${provenance.credit_checks_count ?? '—'}`],
    ['KYC checks',           `${provenance.kyc_checks_count ?? '—'}`],
    ['Valuations',           `${provenance.valuations_count ?? '—'}`],
    ['Directorships',        `${provenance.directorships_count ?? '—'}`],
  ] : null;

  const provenanceBlock = provenanceRows ? `
    <div style="margin-top:18px;">
      <div style="font-size:11px;color:#94A3B8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding:0 4px;">Source provenance — data feeds Opus saw</div>
      <div style="border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;background:#0F172A;">
        ${provenanceRows.map((r, i) => {
          // Highlight zero-attached counts to flag missing-data IA risks
          const valStr = String(r[1]);
          const isZero = /^0(\s|$|\sof)/.test(valStr);
          const valColour = isZero ? '#F87171' : '#CBD5E1';
          return `
            <div style="display:grid;grid-template-columns:200px 1fr;gap:0;padding:9px 16px;background:${i % 2 ? '#0F172A' : '#111827'};border-top:${i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)'};font-size:12px;">
              <div style="color:#94A3B8;font-weight:600;">${sanitizeHtml(r[0])}</div>
              <div style="color:${valColour};font-family:monospace;">${sanitizeHtml(valStr)}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div style="font-size:10px;color:#64748B;margin-top:6px;padding:0 4px;font-style:italic;">Zero-counts in red flag a missing data feed — Opus was graded with this gap. RM should pull the missing source for the next run.</div>
    </div>
  ` : '';

  return `
    <div style="padding:20px 24px;">
      <div style="border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;background:#0F172A;">
        ${rows.map((r, i) => `
          <div style="display:grid;grid-template-columns:200px 1fr;gap:0;padding:9px 16px;background:${i % 2 ? '#0F172A' : '#111827'};border-top:${i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)'};font-size:12px;">
            <div style="color:#94A3B8;font-weight:600;">${sanitizeHtml(r[0])}</div>
            <div style="color:#CBD5E1;font-family:monospace;">${sanitizeHtml(String(r[1] ?? '—'))}</div>
          </div>
        `).join('')}
      </div>
      ${provenanceBlock}
    </div>
  `;
}

function fmtTs(s) { return s ? new Date(s).toLocaleString() : '—'; }

// ─── Tab 5: Append-only History ─────────────────────────────────
function renderHistoryTab() {
  return `
    <div style="padding:20px 24px;">
      <div style="border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;background:#0F172A;">
        <div style="display:grid;grid-template-columns:60px 100px 110px 90px 110px 1fr 110px;gap:0;padding:11px 16px;background:#0a0f1a;font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;letter-spacing:.6px;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div>Run #</div><div>Verdict</div><div>Status</div><div>Stage</div><div>Rubric</div><div>Triggered by</div><div style="text-align:right;">When</div>
        </div>
        ${__riskState.runs.map((r, i) => {
          const v = r.verdict ? r.verdict.toUpperCase() : null;
          const vs = v ? (VERDICT_STYLE[v] || VERDICT_STYLE.MODERATE) : null;
          const ss = STATUS_STYLE[r.status] || STATUS_STYLE.pending;
          const isActive = r.id === __riskState.activeRunId;
          return `
            <div data-run-id="${r.id}" class="risk-history-row" style="display:grid;grid-template-columns:60px 100px 110px 90px 110px 1fr 110px;gap:0;padding:11px 16px;background:${isActive ? 'rgba(212,168,83,0.06)' : (i % 2 ? '#0F172A' : '#111827')};border-top:1px solid rgba(255,255,255,0.04);font-size:12px;cursor:pointer;align-items:center;">
              <div style="color:#F1F5F9;font-weight:700;">#${r.id}</div>
              <div>${v ? `<span style="padding:2px 8px;border-radius:8px;background:${vs.bg};color:${vs.fg};border:1px solid ${vs.border};font-size:10px;font-weight:700;letter-spacing:.4px;">${v}</span>` : '<span style="color:#64748B;">—</span>'}</div>
              <div><span style="padding:2px 8px;border-radius:8px;background:${ss.bg};color:${ss.fg};font-size:10px;font-weight:700;letter-spacing:.4px;">${ss.label}</span></div>
              <div style="color:#CBD5E1;font-size:11.5px;">${sanitizeHtml(r.data_stage || '—')}</div>
              <div style="color:#CBD5E1;font-size:11.5px;">v${r.rubric_version || '?'}${r.rubric_stale ? ' <span style="color:#FBBF24;">·stale</span>' : ''}</div>
              <div style="color:#94A3B8;font-size:11.5px;">${sanitizeHtml(r.triggered_by || '—')}</div>
              <div style="color:#94A3B8;font-size:11px;text-align:right;">${r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div style="font-size:11px;color:#64748B;margin-top:10px;line-height:1.6;">
        Append-only. Failed runs and superseded artefacts are preserved. Click any row to load that run into the verdict + dimensions tabs.
      </div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════
// v3.1 — VERDICT TAB
// PD (1–9) × LGD (A–E) × IA (A–E) verdict ribbon with appetite-zone
// overlay, three emergent latent cards, nine fixed determinant cards,
// and a sticky context sidebar (sector baseline + info request +
// missing data + taxonomy version).
//
// Triggered when the active run carries a `grade_matrix` JSONB blob
// shaped like:
//   {
//     final:        { pd, lgd, ia, headline, rationale, drivers[] },
//     latents:      [{ key, label, pd, lgd, ia, rationale, drivers[] }, …],
//     determinants: { <key>: { pd, lgd, ia, rationale, red_flags[], evidence_refs[] }, … },
//     sector, sector_baseline, info_request, missing_data_summary, taxonomy_version
//   }
// Legacy v3.0 rows (no grade_matrix, only `verdict` HIGH/MED/LOW)
// fall through to the narrative tab unchanged.
// ═════════════════════════════════════════════════════════════════
function isV31Run(run) {
  if (!run) return false;
  const gm = run.grade_matrix || run.parsed_grades;
  if (!gm || typeof gm !== 'object') return false;
  if (!gm.final || typeof gm.final !== 'object') return false;
  return gm.final.pd != null;
}

// PD 1–3 = green, 4–5 = blue, 6–7 = amber, 8–9 = red.
const PD_BAND = (pd) => {
  const n = Number(pd) || 0;
  if (n >= 1 && n <= 3) return { fg: '#34D399', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.30)', label: 'low' };
  if (n <= 5) return { fg: '#60A5FA', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.30)', label: 'moderate' };
  if (n <= 7) return { fg: '#FBBF24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.30)', label: 'elevated' };
  if (n <= 9) return { fg: '#F87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.30)', label: 'high' };
  return { fg: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.18)', label: '—' };
};

// LGD / IA letter A–E, A best.
const LGD_IA_BAND = (letter) => {
  const L = String(letter || '').toUpperCase();
  switch (L) {
    case 'A': return { fg: '#34D399', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.30)' };
    case 'B': return { fg: '#60A5FA', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.30)' };
    case 'C': return { fg: '#FBBF24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.30)' };
    case 'D': return { fg: '#FB923C', bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.30)' };
    case 'E': return { fg: '#F87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.30)' };
    default:  return { fg: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.18)' };
  }
};

// Hardcoded for v1 — promote to risk_taxonomy(kind='appetite_zone') later.
// Preferred = PD 1–4 AND LGD A–B; Stretch = PD 1–6 AND LGD A–C; Decline = else.
const APPETITE_ZONE = (pd, lgd) => {
  const lgdRank = { A: 1, B: 2, C: 3, D: 4, E: 5 }[String(lgd || '').toUpperCase()] || 0;
  const pdN = Number(pd) || 0;
  if (!lgdRank || !pdN) return null;
  if (pdN <= 4 && lgdRank <= 2) return 'preferred';
  if (pdN <= 6 && lgdRank <= 3) return 'stretch';
  return 'decline';
};

const ZONE_STYLE = {
  preferred: { color: 'rgba(52,211,153,0.85)',  bg: 'rgba(52,211,153,0.07)',  label: 'PREFERRED' },
  stretch:   { color: 'rgba(251,191,36,0.85)',  bg: 'rgba(251,191,36,0.06)',  label: 'STRETCH'   },
  decline:   { color: 'rgba(248,113,113,0.85)', bg: 'rgba(248,113,113,0.05)', label: 'DECLINE'   },
};

function renderV31VerdictTab(run) {
  const gm = (run && (run.grade_matrix || run.parsed_grades)) || null;
  if (!gm || typeof gm !== 'object' || !gm.final) {
    return `<div style="padding:30px;text-align:center;color:#94A3B8;font-size:13px;">
      Grade matrix not available for this run. The run may pre-date taxonomy v3.1, or be still in flight.
    </div>`;
  }
  const final = gm.final || {};
  const latents = Array.isArray(gm.latents) ? gm.latents : [];
  const dets = (gm.determinants && typeof gm.determinants === 'object') ? gm.determinants : {};
  const sectorBaseline = gm.sector_baseline || null;
  // info_request: per rubric v4 spec it's a single string ("one concrete ask").
  // Tolerate array-of-strings just in case the model emits one.
  const infoRequest = gm.info_request != null
    ? (Array.isArray(gm.info_request) ? gm.info_request : [gm.info_request])
    : [];
  // missing_data_summary: per spec it's an array of strings. Tolerate plain
  // string fallback.
  const missing = Array.isArray(gm.missing_data_summary)
    ? gm.missing_data_summary
    : (gm.missing_data_summary ? [gm.missing_data_summary] : []);

  return `
    <div style="padding:20px 24px 36px;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:22px;align-items:start;">
      <div style="min-width:0;">
        ${renderV31Ribbon(final)}
        ${renderV31LatentRow(latents, dets)}
        ${renderV31DeterminantGrid(dets)}
      </div>
      <aside style="position:sticky;top:80px;display:flex;flex-direction:column;gap:14px;">
        ${renderV31SectorCard(gm.sector, sectorBaseline)}
        ${renderV31InfoRequest(infoRequest)}
        ${renderV31MissingData(missing)}
        ${renderV31TaxonomyBadge(gm.taxonomy_version)}
      </aside>
    </div>
  `;
}

// ─── v3.1 verdict ribbon: final headline + 9×5 PD×LGD grid + IA badge ────
function renderV31Ribbon(final) {
  const pdN = Number(final.pd) || 0;
  const pdB = PD_BAND(pdN);
  const lgdB = LGD_IA_BAND(final.lgd);
  const iaB = LGD_IA_BAND(final.ia);
  const drivers = Array.isArray(final.drivers) ? final.drivers : [];

  return `
    <div style="padding:22px 24px;border-radius:14px;background:linear-gradient(180deg,#0F172A 0%,#0a0f1a 100%);border:1px solid rgba(212,168,83,0.22);box-shadow:0 4px 24px rgba(0,0,0,0.30);margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px;">Final verdict</div>
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:22px;line-height:1.35;color:#F1F5F9;font-weight:600;">${sanitizeHtml(final.headline || '—')}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          ${renderV31FinalPill('PD', pdN || '—', pdB.label, pdB)}
          ${renderV31FinalPill('LGD', String(final.lgd || '—').toUpperCase(), 'severity', lgdB)}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:18px;align-items:stretch;">
        ${renderV31Grid(pdN, final.lgd)}
        ${renderV31IaBadge(final.ia, iaB)}
      </div>
      ${final.rationale ? `
        <div style="margin-top:18px;padding-top:16px;border-top:1px dashed rgba(255,255,255,0.08);">
          <div style="font-size:13.5px;color:#CBD5E1;line-height:1.7;">${sanitizeHtml(final.rationale)}</div>
        </div>
      ` : ''}
      ${drivers.length ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;">
          <span style="font-size:9.5px;color:#64748B;text-transform:uppercase;letter-spacing:.5px;font-weight:700;align-self:center;margin-right:4px;">drivers</span>
          ${drivers.map(d => `<span style="font-size:10.5px;color:#D4A853;background:rgba(212,168,83,0.08);border:1px solid rgba(212,168,83,0.22);padding:3px 9px;border-radius:8px;font-weight:600;">${sanitizeHtml(d)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderV31FinalPill(label, value, sublabel, b) {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;background:${b.bg};border:1px solid ${b.border};min-width:74px;">
      <div style="font-size:9.5px;color:${b.fg};font-weight:700;text-transform:uppercase;letter-spacing:.8px;opacity:.85;">${label}</div>
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:30px;font-weight:700;color:${b.fg};line-height:1;margin-top:1px;">${sanitizeHtml(String(value))}</div>
      <div style="font-size:9px;color:${b.fg};opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-top:2px;">${sanitizeHtml(sublabel)}</div>
    </div>
  `;
}

// ─── 9×5 PD × LGD grid with appetite-zone overlay + hit cell glow ───────
function renderV31Grid(pd, lgd) {
  const pdN = Number(pd) || 0;
  const lgdU = String(lgd || '').toUpperCase();
  const COLS = ['A', 'B', 'C', 'D', 'E'];

  // Build cells row-by-row (9 rows × 5 cols)
  const cellsByRow = [];
  for (let row = 1; row <= 9; row++) {
    const cells = COLS.map(col => {
      const isHit = (row === pdN && col === lgdU);
      const zone = APPETITE_ZONE(row, col);
      const zoneStyle = zone ? ZONE_STYLE[zone] : null;
      const pdB = PD_BAND(row);
      const cellBg = isHit ? pdB.bg : (zoneStyle ? zoneStyle.bg : 'rgba(255,255,255,0.02)');
      const cellBorder = isHit ? pdB.fg : (zoneStyle ? zoneStyle.color : 'rgba(255,255,255,0.06)');
      const ringStyle = isHit
        ? `box-shadow:0 0 0 2px ${pdB.fg}, 0 0 16px ${pdB.fg}cc;z-index:2;`
        : '';
      const hitOpacity = isHit ? 1 : (zone === 'preferred' ? 1 : zone === 'stretch' ? 0.95 : 0.85);
      return `
        <div title="PD ${row} · LGD ${col}${zone ? ' · ' + zone : ''}"
             style="position:relative;height:24px;border-radius:5px;background:${cellBg};border:1px solid ${cellBorder};opacity:${hitOpacity};${ringStyle}transition:all .2s;">
          ${isHit ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:${pdB.fg};letter-spacing:.4px;">${row}${col}</div>` : ''}
        </div>
      `;
    });
    cellsByRow.push(cells);
  }

  // Column header row (A–E)
  const colHeader = COLS.map(c => {
    const b = LGD_IA_BAND(c);
    return `<div style="font-size:10px;font-weight:700;color:${b.fg};text-align:center;letter-spacing:.5px;opacity:.85;">${c}</div>`;
  }).join('');

  // Row headers (1–9 PD)
  const rows = cellsByRow.map((cells, idx) => {
    const r = idx + 1;
    const b = PD_BAND(r);
    return `<div style="font-size:10px;font-weight:700;color:${b.fg};text-align:right;padding-right:6px;line-height:24px;opacity:.85;">${r}</div>${cells.join('')}`;
  });

  return `
    <div>
      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;font-weight:600;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <span>PD (rows 1–9, low → high) × LGD (cols A–E)</span>
        <span style="display:flex;gap:10px;font-size:9.5px;font-weight:600;letter-spacing:.4px;">
          <span style="color:${ZONE_STYLE.preferred.color};">■ preferred</span>
          <span style="color:${ZONE_STYLE.stretch.color};">■ stretch</span>
          <span style="color:${ZONE_STYLE.decline.color};">■ decline</span>
        </span>
      </div>
      <div style="display:grid;grid-template-columns:20px repeat(5, 1fr);gap:5px;align-items:center;">
        <div></div>${colHeader}
        ${rows.join('')}
      </div>
    </div>
  `;
}

function renderV31IaBadge(ia, iaB) {
  const L = String(ia || '—').toUpperCase();
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 10px;border-radius:10px;background:${iaB.bg};border:1px solid ${iaB.border};">
      <div style="font-size:9.5px;color:${iaB.fg};font-weight:700;text-transform:uppercase;letter-spacing:.9px;opacity:.85;">IA</div>
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:38px;font-weight:700;color:${iaB.fg};line-height:1;margin:4px 0 6px;">${sanitizeHtml(L)}</div>
      <div style="font-size:9px;color:${iaB.fg};opacity:.7;text-align:center;line-height:1.3;letter-spacing:.4px;">information<br>availability</div>
    </div>
  `;
}

// ─── Layer 2: emergent latent factors ─────────────────────────────
function renderV31LatentRow(latents, dets) {
  if (!latents.length) {
    return `
      <div style="padding:18px;border-radius:10px;background:#0F172A;border:1px dashed rgba(255,255,255,0.08);text-align:center;color:#64748B;font-size:12px;margin-bottom:20px;">
        No emergent latent factors emitted by the model for this run.
      </div>
    `;
  }
  const cols = Math.min(latents.length, 3);
  return `
    <div style="margin-bottom:20px;">
      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;font-weight:600;">
        Layer 2 — emergent latent factors (deal-specific, ${latents.length})
      </div>
      <div style="display:grid;grid-template-columns:repeat(${cols}, minmax(0, 1fr));gap:12px;">
        ${latents.map(L => renderV31LatentCard(L, dets)).join('')}
      </div>
    </div>
  `;
}

function renderV31LatentCard(L, dets) {
  const pdB = PD_BAND(L.pd);
  const lgdB = LGD_IA_BAND(L.lgd);
  const iaB = LGD_IA_BAND(L.ia);
  const drivers = Array.isArray(L.drivers) ? L.drivers : [];
  return `
    <div style="padding:14px 16px;border-radius:10px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:10px;min-width:0;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:14.5px;color:#F1F5F9;font-weight:600;line-height:1.3;flex:1;min-width:0;">${sanitizeHtml(L.label || L.key || '—')}</div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <span style="padding:2px 7px;border-radius:6px;background:${pdB.bg};color:${pdB.fg};border:1px solid ${pdB.border};font-size:10px;font-weight:700;">PD ${Number(L.pd) || '—'}</span>
          <span style="padding:2px 7px;border-radius:6px;background:${lgdB.bg};color:${lgdB.fg};border:1px solid ${lgdB.border};font-size:10px;font-weight:700;">LGD ${sanitizeHtml(String(L.lgd || '—'))}</span>
          <span style="padding:2px 7px;border-radius:6px;background:${iaB.bg};color:${iaB.fg};border:1px solid ${iaB.border};font-size:10px;font-weight:700;">IA ${sanitizeHtml(String(L.ia || '—'))}</span>
        </div>
      </div>
      ${L.rationale ? `<div style="font-size:12px;color:#CBD5E1;line-height:1.65;">${sanitizeHtml(L.rationale)}</div>` : ''}
      ${drivers.length ? `
        <div style="padding-top:8px;border-top:1px dashed rgba(255,255,255,0.05);">
          <div style="font-size:9.5px;color:#64748B;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:5px;">Driven by</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            ${drivers.map(d => {
              const isDet = !!dets[d];
              return `<span class="${isDet ? 'risk-det-link' : ''}" data-det-link="${isDet ? escapeAttrV31(d) : ''}" title="${isDet ? 'click to scroll to determinant' : ''}" style="font-size:10px;color:${isDet ? '#60A5FA' : '#94A3B8'};background:${isDet ? 'rgba(96,165,250,0.10)' : 'rgba(148,163,184,0.08)'};border:1px solid ${isDet ? 'rgba(96,165,250,0.22)' : 'rgba(148,163,184,0.15)'};padding:2px 7px;border-radius:6px;cursor:${isDet ? 'pointer' : 'default'};">${sanitizeHtml(d)}</span>`;
            }).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// ─── Layer 1: nine fixed determinant cards ────────────────────────
function renderV31DeterminantGrid(dets) {
  const keys = Object.keys(dets || {});
  if (!keys.length) {
    return `
      <div style="padding:18px;border-radius:10px;background:#0F172A;border:1px dashed rgba(255,255,255,0.08);text-align:center;color:#64748B;font-size:12px;">
        No determinant grades emitted.
      </div>
    `;
  }
  return `
    <div>
      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;font-weight:600;">
        Layer 1 — fixed determinants (${keys.length})
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:12px;">
        ${keys.map(k => renderV31DeterminantCard(k, dets[k])).join('')}
      </div>
    </div>
  `;
}

function renderV31DeterminantCard(key, body) {
  const niceName = humaniseDetKey(key);
  if (!body || typeof body !== 'object') {
    return `<div id="risk-det-${escapeAttrV31(key)}" style="padding:14px;border-radius:10px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);scroll-margin-top:120px;">
      <div style="font-size:12.5px;color:#F1F5F9;font-weight:600;">${sanitizeHtml(niceName)}</div>
      <div style="font-size:11px;color:#64748B;margin-top:6px;">No body returned by model.</div>
    </div>`;
  }
  const pdB = PD_BAND(body.pd);
  const lgdB = LGD_IA_BAND(body.lgd);
  const iaB = LGD_IA_BAND(body.ia);
  const redFlags = Array.isArray(body.red_flags) ? body.red_flags : [];
  const evidence = Array.isArray(body.evidence_refs) ? body.evidence_refs : [];
  return `
    <div id="risk-det-${escapeAttrV31(key)}" style="padding:14px 16px;border-radius:10px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:9px;scroll-margin-top:120px;min-width:0;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
        <div style="font-size:13px;color:#F1F5F9;font-weight:600;line-height:1.3;flex:1;min-width:0;">${sanitizeHtml(niceName)}</div>
        <div style="display:flex;gap:3px;flex-shrink:0;">
          <span style="padding:2px 6px;border-radius:5px;background:${pdB.bg};color:${pdB.fg};border:1px solid ${pdB.border};font-size:9.5px;font-weight:700;">PD ${Number(body.pd) || '—'}</span>
          <span style="padding:2px 6px;border-radius:5px;background:${lgdB.bg};color:${lgdB.fg};border:1px solid ${lgdB.border};font-size:9.5px;font-weight:700;">LGD ${sanitizeHtml(String(body.lgd || '—'))}</span>
          <span style="padding:2px 6px;border-radius:5px;background:${iaB.bg};color:${iaB.fg};border:1px solid ${iaB.border};font-size:9.5px;font-weight:700;">IA ${sanitizeHtml(String(body.ia || '—'))}</span>
        </div>
      </div>
      ${body.rationale ? `<div style="font-size:11.5px;color:#CBD5E1;line-height:1.6;">${sanitizeHtml(body.rationale)}</div>` : ''}
      ${redFlags.length ? `
        <div>
          <div style="font-size:9.5px;color:#F87171;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:4px;">Red flags</div>
          <ul style="margin:0 0 0 16px;padding:0;font-size:11px;color:#FCA5A5;line-height:1.55;">
            ${redFlags.map(rf => `<li style="margin:2px 0;">${sanitizeHtml(String(rf))}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      ${evidence.length ? `
        <div style="padding-top:8px;border-top:1px dashed rgba(255,255,255,0.05);font-size:10px;color:#64748B;line-height:1.9;min-width:0;overflow-wrap:anywhere;word-break:break-all;">
          <div style="font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;line-height:1.4;">Evidence</div>
          ${evidence.map(e => `<code style="background:#0a0f1a;padding:2px 5px;border-radius:3px;color:#94A3B8;font-size:9.5px;font-family:'SF Mono',Menlo,Consolas,monospace;margin-right:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">${sanitizeHtml(String(e))}</code>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function humaniseDetKey(k) {
  return String(k || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeAttrV31(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ─── Sidebar cards ────────────────────────────────────────────────
function renderV31SectorCard(sector, baseline) {
  if (!sector && !baseline) return '';
  const b = baseline || {};
  const pdB = b.pd != null ? PD_BAND(b.pd) : null;
  const lgdB = b.lgd ? LGD_IA_BAND(b.lgd) : null;
  return `
    <div style="padding:14px 16px;border-radius:10px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px;">Sector context</div>
      ${sector ? `<div style="font-size:13px;color:#F1F5F9;font-weight:600;margin-bottom:8px;">${sanitizeHtml(sector)}</div>` : ''}
      ${(pdB || lgdB) ? `
        <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
          ${pdB ? `<span style="padding:2px 7px;border-radius:6px;background:${pdB.bg};color:${pdB.fg};border:1px solid ${pdB.border};font-size:10px;font-weight:700;">baseline PD ${b.pd}</span>` : ''}
          ${lgdB ? `<span style="padding:2px 7px;border-radius:6px;background:${lgdB.bg};color:${lgdB.fg};border:1px solid ${lgdB.border};font-size:10px;font-weight:700;">baseline LGD ${sanitizeHtml(String(b.lgd))}</span>` : ''}
        </div>
      ` : ''}
      ${b.rationale ? `<div style="font-size:11px;color:#CBD5E1;line-height:1.6;">${sanitizeHtml(b.rationale)}</div>` : ''}
    </div>
  `;
}

function renderV31InfoRequest(items) {
  if (!items.length) return '';
  return `
    <div style="padding:14px 16px;border-radius:10px;background:rgba(212,168,83,0.05);border:1px solid rgba(212,168,83,0.20);">
      <div style="font-size:10px;color:#D4A853;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px;">Info request to broker</div>
      <ul style="margin:0 0 0 16px;padding:0;font-size:11.5px;color:#CBD5E1;line-height:1.6;">
        ${items.map(it => {
          const text = typeof it === 'string' ? it : (it && (it.label || it.field || it.ask)) || JSON.stringify(it);
          return `<li style="margin:3px 0;">${sanitizeHtml(text)}</li>`;
        }).join('')}
      </ul>
    </div>
  `;
}

function renderV31MissingData(summary) {
  // summary is now always an array (caller normalizes). Render as bulleted
  // list of items, each item stringified safely.
  if (!Array.isArray(summary) || !summary.length) return '';
  const items = summary.map(it => {
    if (typeof it === 'string') return it;
    if (it && typeof it === 'object') {
      return it.label || it.field || it.note || it.text || JSON.stringify(it);
    }
    return String(it);
  });
  return `
    <div style="padding:14px 16px;border-radius:10px;background:rgba(251,191,36,0.05);border:1px solid rgba(251,191,36,0.20);">
      <div style="font-size:10px;color:#FBBF24;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:8px;">Missing data summary</div>
      <ul style="margin:0 0 0 16px;padding:0;font-size:11.5px;color:#CBD5E1;line-height:1.6;">
        ${items.map(t => `<li style="margin:3px 0;">${sanitizeHtml(t)}</li>`).join('')}
      </ul>
    </div>
  `;
}

function renderV31TaxonomyBadge(version) {
  if (!version) return '';
  return `
    <div style="font-size:10px;color:#64748B;text-align:right;letter-spacing:.4px;">taxonomy ${sanitizeHtml(version)}</div>
  `;
}

// ═════════════════════════════════════════════════════════════════
// MARKDOWN — minimal renderer (headings, bold, italics, lists, tables)
// ═════════════════════════════════════════════════════════════════
function renderMarkdown(md) {
  if (!md) return '';
  // ─── Stash raw HTML table blocks BEFORE markdown processing ───
  // The v3 rubric prompt sometimes makes Claude emit a styled HTML table
  // (`<table>...</table>` or bare `<thead>...</tbody>`) for the Dimension
  // Grades / Layer tables. Without this stash, the per-line guard below only
  // catches lines that START with `<table`/`<thead` etc., and any indented
  // inner HTML falls through to <p>${inlineMd(line)}</p> which HTML-escapes it.
  // Stash with placeholders, run markdown, re-insert verbatim.
  const htmlStash = [];
  const stashHtml = (block) => {
    htmlStash.push(block);
    return `\n___HTMLBLOCK_${htmlStash.length - 1}___\n`;
  };
  let out = md.replace(/\r\n/g, '\n');
  const TBL_OPEN = '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:12.5px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;">';
  // Pass 1: Full <table>...</table>
  out = out.replace(/<table\b[\s\S]*?<\/table>/gi, stashHtml);
  // Pass 2: <thead>...</thead> followed (possibly across blank lines) by <tbody>...</tbody>
  out = out.replace(/<thead\b[\s\S]*?<\/thead>\s*<tbody\b[\s\S]*?<\/tbody>/gi, (block) =>
    stashHtml(`${TBL_OPEN}${block}</table>`)
  );
  // Pass 3: catch-all <thead>...</tbody> sequence (in case the prompt drifts again)
  out = out.replace(/<thead\b[\s\S]*?<\/tbody>/gi, (block) =>
    stashHtml(`${TBL_OPEN}${block}</table>`)
  );
  // Pass 4: orphan <thead>...</thead> with no body
  out = out.replace(/<thead\b[\s\S]*?<\/thead>/gi, (block) =>
    stashHtml(`${TBL_OPEN}${block}</table>`)
  );
  // Pass 5: orphan <tbody>...</tbody> with no head
  out = out.replace(/<tbody\b[\s\S]*?<\/tbody>/gi, (block) =>
    stashHtml(`${TBL_OPEN}${block}</table>`)
  );

  // Tables — basic GFM. Strip leading separator row.
  out = out
    // tables: detect blocks
    .replace(/((?:\|.+\|\n)(?:\|[\s|:-]+\|\n)(?:\|.+\|\n?)+)/g, (block) => {
      const lines = block.trim().split('\n');
      const header = lines[0];
      const body = lines.slice(2);
      const headers = header.replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      const rows = body.map(l => l.replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
      return `<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:12.5px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;">
        <thead><tr>${headers.map(h => `<th style="padding:8px 12px;text-align:left;color:#D4A853;background:#0a0f1a;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid rgba(255,255,255,0.08);">${escapeHtml(h.replace(/\*\*/g, ''))}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${r.map(c => `<td style="padding:8px 12px;color:#CBD5E1;border-top:1px solid rgba(255,255,255,0.04);vertical-align:top;">${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`;
    });

  // Process line by line for headings, lists, blockquotes, paragraphs.
  const lines = out.split('\n');
  const buf = [];
  let inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { buf.push('</ul>'); inUl = false; }
    if (inOl) { buf.push('</ol>'); inOl = false; }
  };
  for (let line of lines) {
    // Re-insert stashed raw HTML blocks
    const ph = line.match(/^___HTMLBLOCK_(\d+)___\s*$/);
    if (ph) { closeLists(); buf.push(htmlStash[Number(ph[1])]); continue; }
    if (/^\s*<\/?(table|thead|tbody|tr|td|th)\b/i.test(line)) { closeLists(); buf.push(line); continue; }
    if (/^---+\s*$/.test(line)) { closeLists(); buf.push('<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:18px 0;">'); continue; }
    let m;
    if ((m = line.match(/^###\s+(.+)$/))) { closeLists(); buf.push(`<h3 style="font-family:'Playfair Display',Georgia,serif;color:#F1F5F9;margin:18px 0 8px;font-size:17px;font-weight:600;">${inlineMd(m[1])}</h3>`); continue; }
    if ((m = line.match(/^##\s+(.+)$/)))  { closeLists(); buf.push(`<h2 style="font-family:'Playfair Display',Georgia,serif;color:#F1F5F9;margin:22px 0 10px;font-size:20px;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">${inlineMd(m[1])}</h2>`); continue; }
    if ((m = line.match(/^#\s+(.+)$/)))   { closeLists(); buf.push(`<h1 style="font-family:'Playfair Display',Georgia,serif;color:#D4A853;margin:24px 0 12px;font-size:24px;font-weight:700;">${inlineMd(m[1])}</h1>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      if (!inUl) { closeLists(); buf.push('<ul style="margin:8px 0 12px 22px;color:#CBD5E1;">'); inUl = true; }
      buf.push(`<li style="margin:4px 0;">${inlineMd(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.+)$/))) {
      if (!inOl) { closeLists(); buf.push('<ol style="margin:8px 0 12px 22px;color:#CBD5E1;">'); inOl = true; }
      buf.push(`<li style="margin:4px 0;">${inlineMd(m[1])}</li>`);
      continue;
    }
    if (/^\s*$/.test(line)) { closeLists(); buf.push(''); continue; }
    closeLists();
    buf.push(`<p style="margin:8px 0;">${inlineMd(line)}</p>`);
  }
  closeLists();
  return buf.join('\n');
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#F1F5F9;">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em style="color:#E5E7EB;">$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#0a0f1a;padding:1px 6px;border-radius:4px;color:#D4A853;font-size:0.9em;">$1</code>');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═════════════════════════════════════════════════════════════════
// ERROR PANEL
// ═════════════════════════════════════════════════════════════════
function renderErrorPanel(msg) {
  return `
    <div style="padding:30px 24px;">
      <div style="padding:14px 18px;border-radius:10px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);color:#FCA5A5;font-size:13px;">
        Risk View failed to load: ${sanitizeHtml(msg)}
      </div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═════════════════════════════════════════════════════════════════
function wireTriggerButton(deal) {
  const btn = document.getElementById('risk-trigger-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const stage = inferDataStage(deal);
    const ok = window.confirm(
      `Trigger a fresh risk run on deal ${deal.id} for stage "${stage}"?\n\n` +
      `This is a manual write action — ~£2 in LLM cost, ~100s latency. ` +
      `Each run is permanent and stamped with current rubric and matrix versions.`
    );
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Dispatching…';
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/risk-runs/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId: deal.id, dataStage: stage }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `${res.status}`);
      }
      showToast(`Risk run #${data.risk_run_id} dispatched`, 'success');
      // Re-render to show running state, and start a poll.
      await renderRiskSection(deal, getCurrentRoleSafe());
      pollUntilSettled(data.risk_run_id, deal);
    } catch (err) {
      showToast(`Trigger failed: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Run Risk Analysis';
    }
  });
}

function pollUntilSettled(runId, deal) {
  let attempts = 0;
  const maxAttempts = 60; // ~3 min at 3s
  const tick = async () => {
    attempts++;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/risk-view/${deal.id}/runs/${runId}`);
      const data = await res.json();
      const st = data.run?.status;
      if (st === 'success' || st === 'failed') {
        await renderRiskSection(deal, getCurrentRoleSafe());
        return;
      }
    } catch { /* swallow, keep polling */ }
    if (attempts < maxAttempts) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

function inferDataStage(deal) {
  const stage = (deal && deal.deal_stage) || 'draft';
  if (['post_completion', 'completed', 'funded'].includes(stage)) return 'post_completion';
  if (['dip_received', 'dip_signed', 'received', 'info_gathering', 'underwriting'].includes(stage)) {
    return stage === 'underwriting' ? 'underwriting' : 'dip';
  }
  return 'underwriting';
}

function getCurrentRoleSafe() {
  try {
    return (window.__currentRole) || 'admin';
  } catch { return 'admin'; }
}

function wireRunRailClicks(deal, role) {
  document.querySelectorAll('.risk-rail-pill, .risk-history-row').forEach(el => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.runId);
      if (!id || id === __riskState.activeRunId) return;
      await loadFullRun(id);
      // Re-evaluate default tab against the newly-loaded run's shape.
      // verdict ↔ narrative is the v3.1 ↔ v3 split; preserve other tabs
      // (dimensions/latents/telemetry/history) the user may have navigated to.
      if (__riskState.activeTab === 'verdict' && !isV31Run(__riskState.activeRun)) {
        __riskState.activeTab = 'narrative';
      } else if (__riskState.activeTab === 'narrative' && isV31Run(__riskState.activeRun)) {
        __riskState.activeTab = 'verdict';
      }
      paint(deal, role);
    });
  });
}

function wireSubTabClicks(deal) {
  document.querySelectorAll('[data-risk-tab]').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.riskTab;
      if (!t || t === __riskState.activeTab) return;
      __riskState.activeTab = t;
      // Re-render only the tab nav + body to avoid blowing away rail/hero.
      const role = getCurrentRoleSafe();
      paint(deal, role);
    });
  });
}

// v3.1 — clicking a latent driver chip scrolls the matching determinant
// card into view and pulses its border. No-op for chips whose key isn't
// a known determinant.
function wireV31LatentDrivers() {
  document.querySelectorAll('.risk-det-link').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-det-link');
      if (!key) return;
      const target = document.getElementById(`risk-det-${key}`);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Pulse highlight
      const prevBorder = target.style.border;
      const prevShadow = target.style.boxShadow;
      target.style.border = '1px solid rgba(96,165,250,0.55)';
      target.style.boxShadow = '0 0 0 2px rgba(96,165,250,0.30), 0 0 18px rgba(96,165,250,0.30)';
      setTimeout(() => {
        target.style.border = prevBorder;
        target.style.boxShadow = prevShadow;
      }, 1200);
    });
  });
}
