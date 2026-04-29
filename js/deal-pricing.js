/**
 * deal-pricing.js — Pricing Recommendation panel for /deal/:id
 * ──────────────────────────────────────────────────────────────
 * PRICE-8 (2026-04-29). Read-only panel surfacing the engine's
 * recommendation alongside the RM's actual numbers. Engine is COACH
 * not GATE — RM stays in control of what lands on the DIP.
 *
 * Architecture:
 *   - POST /api/admin/pricing/preview/:dealId  → envelope
 *   - No persistence (PRICE-9 adds save-to-deal_pricings later)
 *   - Auto-loads on section open (or on deal page load when expanded)
 *   - Falls back gracefully if no v3.1 risk run exists yet
 *
 * Sections rendered:
 *   1. Header card        — risk grade reminder + pricing version pill
 *   2. Recommended levers — 6 chips (rate, upfront, commitment, retained, exit, min term)
 *   3. Cost stack         — 6 lines (CoF debt, structuring, EL, capital, opex, margin)
 *   4. Yield reconcile    — gross / broker / net / required / margin buffer
 *   5. Stress matrix      — 7 scenarios (base + PD/LGD shifts)
 *   6. Whole-loan alt     — collapsible, only if loan ≥£5m
 *   7. Decline banner     — only if decline_flag = true
 *
 * Memory: project_pricing_mvp_shipped_2026_04_29.md, project_pricing_engine_design_2026_04_28.md
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { showToast, sanitizeHtml } from './utils.js';

// ─────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────
function fmtBpsAsPct(bps, decimals = 2) {
  if (bps === null || bps === undefined) return '—';
  return (bps / 100).toFixed(decimals) + '%';
}
function fmtBpsAsPm(bps, decimals = 2) {
  if (bps === null || bps === undefined) return '—';
  return (bps / 100).toFixed(decimals) + '% pm';
}
function fmtMonths(m) {
  if (m === null || m === undefined) return '—';
  return m === 1 ? '1 mo' : (m + ' mo');
}
function fmtPence(pence) {
  if (pence === null || pence === undefined) return '—';
  const gbp = Number(pence) / 100;
  if (gbp >= 1_000_000) return '£' + (gbp / 1_000_000).toFixed(2) + 'm';
  if (gbp >= 1_000)     return '£' + (gbp / 1_000).toFixed(0) + 'k';
  return '£' + gbp.toFixed(0);
}
function fmtBuffer(bps) {
  if (bps === null || bps === undefined) return '—';
  const pct = (bps / 100).toFixed(2);
  return (bps >= 0 ? '+' : '') + pct + '%';
}

// ─────────────────────────────────────────────────────────────────
// Colour palette — matches Daksfirst dark theme
// ─────────────────────────────────────────────────────────────────
const COLOURS = {
  ok:       { bg: 'rgba(52,211,153,0.12)',  fg: '#34D399', border: 'rgba(52,211,153,0.30)' },
  warn:     { bg: 'rgba(251,191,36,0.12)',  fg: '#FBBF24', border: 'rgba(251,191,36,0.30)' },
  bad:      { bg: 'rgba(248,113,113,0.12)', fg: '#F87171', border: 'rgba(248,113,113,0.30)' },
  neutral:  { bg: 'rgba(148,163,184,0.10)', fg: '#94A3B8', border: 'rgba(148,163,184,0.25)' },
  accent:   { bg: 'rgba(96,165,250,0.12)',  fg: '#60A5FA', border: 'rgba(96,165,250,0.30)' },
};

function bufferStyle(bps) {
  if (bps === null || bps === undefined) return COLOURS.neutral;
  if (bps < 0) return COLOURS.bad;
  if (bps < 100) return COLOURS.warn;
  return COLOURS.ok;
}

// ─────────────────────────────────────────────────────────────────
// Renderers (return HTML strings — assembled in renderPricingSection)
// ─────────────────────────────────────────────────────────────────

function renderHeader(env, dealId) {
  const { inputs, pricing_versions, context } = env;
  const sectorLabel = inputs.sector ? inputs.sector.replace(/_/g, ' ') : '—';
  const sectorOrigin = context?.sector_inferred_from || '—';
  return `
    <div style="padding:14px 18px;border-bottom:1px solid rgba(148,163,184,0.15);background:rgba(96,165,250,0.04);">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
          <span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;background:${COLOURS.accent.bg};color:${COLOURS.accent.fg};border:1px solid ${COLOURS.accent.border};">
            PD${inputs.pd} · LGD-${inputs.lgd} · IA-${inputs.ia}
          </span>
          <span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:${COLOURS.neutral.bg};color:${COLOURS.neutral.fg};border:1px solid ${COLOURS.neutral.border};">
            Sector: ${sanitizeHtml(sectorLabel)} <span style="opacity:0.6;">(${sectorOrigin})</span>
          </span>
          <span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:${COLOURS.neutral.bg};color:${COLOURS.neutral.fg};border:1px solid ${COLOURS.neutral.border};">
            Mode: ${sanitizeHtml(inputs.mode)}${inputs.channel === 'direct' ? ' · direct' : ''}
          </span>
          <span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:${COLOURS.neutral.bg};color:${COLOURS.neutral.fg};border:1px solid ${COLOURS.neutral.border};">
            Pricing v${pricing_versions.assumptions} / grid v${pricing_versions.grid} / IA v${pricing_versions.ia_modifiers}
          </span>
          <span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:${COLOURS.neutral.bg};color:${COLOURS.neutral.fg};border:1px solid ${COLOURS.neutral.border};">
            ${fmtPence(inputs.loan_amount_pence)} · ${inputs.term_months} mo
          </span>
          ${inputs.stress_flagged ? `<span style="padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;background:${COLOURS.bad.bg};color:${COLOURS.bad.fg};border:1px solid ${COLOURS.bad.border};">STRESS FLAGGED</span>` : ''}
        </div>
        <button id="pricing-save-btn" data-deal-id="${dealId}"
                style="padding:6px 14px;background:${COLOURS.accent.bg};color:${COLOURS.accent.fg};border:1px solid ${COLOURS.accent.border};border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          💾 Save snapshot
        </button>
      </div>
    </div>
  `;
}

function renderHistoryPanel() {
  return `
    <div style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.10);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
        <span>Recent Snapshots</span>
        <button id="pricing-history-refresh" style="background:none;border:none;color:#60A5FA;cursor:pointer;font-size:11px;font-weight:600;">↻ refresh</button>
      </div>
      <div id="pricing-history-content" style="font-size:13px;color:#94A3B8;">
        <span style="font-style:italic;">Loading…</span>
      </div>
    </div>
  `;
}

function renderRecommended(env) {
  const r = env.recommended;
  const chip = (label, value, sub) => `
    <div style="background:rgba(15,23,42,0.4);border:1px solid rgba(148,163,184,0.15);border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:#64748b;">${label}</div>
      <div style="font-size:18px;font-weight:700;color:#F1F5F9;margin-top:4px;font-variant-numeric:tabular-nums;">${value}</div>
      ${sub ? `<div style="font-size:10px;color:#94A3B8;margin-top:2px;">${sub}</div>` : ''}
    </div>
  `;

  const rateSub = r.rate_capped
    ? `<span style="color:${COLOURS.warn.fg};">capped at ${fmtBpsAsPm(r.rate_ceiling_bps_pm)}</span> (pre-cap ${fmtBpsAsPm(r.rate_pre_ceiling_bps_pm)})`
    : `cap ${fmtBpsAsPm(r.rate_ceiling_bps_pm)}`;
  const minTermSub = r.min_term_source === 'joint_lookup'
    ? '<span style="color:#34D399;">joint LGD×IA lookup</span>'
    : 'grid + IA modifier sum';

  return `
    <div style="padding:16px 18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px;">
        Recommended Levers
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;">
        ${chip('Rate', fmtBpsAsPm(r.rate_bps_pm), rateSub)}
        ${chip('Upfront fee', fmtBpsAsPct(r.upfront_fee_bps), 'paid at drawdown')}
        ${chip('Commitment', fmtBpsAsPct(r.commitment_fee_bps), 'netted off upfront')}
        ${chip('Retained interest', fmtMonths(r.retained_months), 'extracted upfront')}
        ${chip('Exit fee', fmtBpsAsPct(r.exit_fee_bps), 'paid at redemption')}
        ${chip('Min term', fmtMonths(r.min_term_months), minTermSub)}
      </div>
    </div>
  `;
}

function renderCostStack(env) {
  const c = env.cost_stack;
  const row = (label, bps, hint) => {
    const pct = fmtBpsAsPct(bps);
    return `
      <tr>
        <td style="padding:6px 12px;color:#CBD5E1;font-size:13px;">${label}</td>
        <td style="padding:6px 12px;color:#94A3B8;font-size:11px;font-style:italic;">${hint || ''}</td>
        <td style="padding:6px 12px;color:#F1F5F9;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;">${pct}</td>
      </tr>
    `;
  };
  return `
    <div style="padding:16px 18px;border-top:1px solid rgba(148,163,184,0.10);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px;">
        Cost Stack (Annualised APR)
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tbody>
          ${row('Cost of funds (debt)',  c.cof_apr_bps,            `(SONIA ${fmtBpsAsPct(c.sonia_apr_bps)} + GBB ${fmtBpsAsPct(c.gbb_spread_apr_bps)}) × (1 − ${(c.capital_ratio_decimal*100).toFixed(0)}%)`)}
          ${row('Structuring (debt)',     c.structuring_apr_bps,    `30 bps × (1 − ${(c.capital_ratio_decimal*100).toFixed(0)}%)`)}
          ${row('Expected loss',          c.el_apr_bps,             `PD×LGD ${fmtBpsAsPct(c.el_base_bps)}${c.concentration_adder_bps > 0 ? ` + concentration ${fmtBpsAsPct(c.concentration_adder_bps)} (${c.concentration_label})` : ` (concentration ${(c.concentration_pct||0).toFixed(2)}%)`}`)}
          ${row('Capital cost (equity)',  c.capital_cost_apr_bps,   `${(c.capital_ratio_decimal*100).toFixed(0)}% × ${(c.equity_target_decimal*100).toFixed(0)}%`)}
          ${row('Opex',                   c.opex_apr_bps,           c.opex_tier_label ? `tier: ${c.opex_tier_label}` : '')}
          ${row('Margin',                 c.margin_apr_bps,         env.inputs.mode === 'whole_loan' ? 'whole-loan' : 'tier-driven')}
          <tr style="border-top:1px solid rgba(148,163,184,0.20);">
            <td style="padding:8px 12px;color:#F1F5F9;font-size:13px;font-weight:700;">Required yield</td>
            <td></td>
            <td style="padding:8px 12px;color:#F1F5F9;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;">${fmtBpsAsPct(c.required_yield_apr_bps)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderYieldReconcile(env) {
  const c = env.cost_stack;
  const buf = env.margin_buffer_bps;
  const bufColours = bufferStyle(buf);
  return `
    <div style="padding:16px 18px;border-top:1px solid rgba(148,163,184,0.10);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px;">
        Yield Reconciliation
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tbody>
          <tr><td style="padding:5px 12px;color:#CBD5E1;">Gross APR</td>
              <td style="padding:5px 12px;color:#94A3B8;font-size:11px;font-style:italic;">rate × 12 + (upfront + exit) × 12/term</td>
              <td style="padding:5px 12px;text-align:right;color:#F1F5F9;font-variant-numeric:tabular-nums;">${fmtBpsAsPct(env.gross_yield_apr_bps)}</td></tr>
          <tr><td style="padding:5px 12px;color:#CBD5E1;">Less broker</td>
              <td style="padding:5px 12px;color:#94A3B8;font-size:11px;font-style:italic;">${env.broker_bps_one_off} bps one-off, annualised over ${env.inputs.term_months} mo</td>
              <td style="padding:5px 12px;text-align:right;color:#F87171;font-variant-numeric:tabular-nums;">−${fmtBpsAsPct(env.broker_apr_bps)}</td></tr>
          <tr style="border-top:1px solid rgba(148,163,184,0.10);">
              <td style="padding:5px 12px;color:#F1F5F9;font-weight:600;">Net to Daksfirst</td>
              <td></td>
              <td style="padding:5px 12px;text-align:right;color:#F1F5F9;font-weight:600;font-variant-numeric:tabular-nums;">${fmtBpsAsPct(env.net_yield_after_broker_apr_bps)}</td></tr>
          <tr><td style="padding:5px 12px;color:#CBD5E1;">Less required</td>
              <td></td>
              <td style="padding:5px 12px;text-align:right;color:#F87171;font-variant-numeric:tabular-nums;">−${fmtBpsAsPct(c.required_yield_apr_bps)}</td></tr>
          <tr style="border-top:1px solid rgba(148,163,184,0.20);">
              <td style="padding:8px 12px;color:#F1F5F9;font-weight:700;">Margin buffer</td>
              <td></td>
              <td style="padding:8px 12px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:${bufColours.fg};">${fmtBuffer(buf)}</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderStressMatrix(env) {
  const rows = (env.stress_matrix || []).map(s => {
    const bufC = bufferStyle(s.margin_buffer_bps);
    return `
      <tr>
        <td style="padding:6px 12px;color:#CBD5E1;font-weight:${s.scenario === 'base' ? '700' : '500'};">${sanitizeHtml(s.scenario)}</td>
        <td style="padding:6px 12px;color:#94A3B8;text-align:center;">${s.pd_shifted}</td>
        <td style="padding:6px 12px;color:#94A3B8;text-align:center;">${s.lgd_shifted}</td>
        <td style="padding:6px 12px;text-align:right;color:#F1F5F9;font-variant-numeric:tabular-nums;">${fmtBpsAsPct(s.required_yield_apr_bps)}</td>
        <td style="padding:6px 12px;text-align:right;font-variant-numeric:tabular-nums;color:${bufC.fg};font-weight:600;">${fmtBuffer(s.margin_buffer_bps)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="padding:16px 18px;border-top:1px solid rgba(148,163,184,0.10);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px;">
        Stress Matrix (levers fixed; PD/LGD shifted)
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid rgba(148,163,184,0.20);">
            <th style="padding:6px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#64748b;">Scenario</th>
            <th style="padding:6px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#64748b;">PD</th>
            <th style="padding:6px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#64748b;">LGD</th>
            <th style="padding:6px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#64748b;">Required APR</th>
            <th style="padding:6px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#64748b;">Buffer</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderWholeLoanAlt(env) {
  const alt = env.whole_loan_alternative;
  if (!alt) return '';
  const altBufC = bufferStyle(alt.margin_buffer_bps);
  return `
    <div style="padding:16px 18px;border-top:1px solid rgba(148,163,184,0.10);background:rgba(96,165,250,0.03);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${COLOURS.accent.fg};margin-bottom:10px;">
        Whole-Loan Alternative (≥£5m threshold met — off-book, fee-only)
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;font-size:13px;">
        <div><span style="color:#64748b;">Required yield:</span> <span style="color:#F1F5F9;font-weight:600;">${fmtBpsAsPct(alt.cost_stack.required_yield_apr_bps)}</span></div>
        <div><span style="color:#64748b;">Net yield:</span> <span style="color:#F1F5F9;font-weight:600;">${fmtBpsAsPct(alt.net_yield_after_broker_apr_bps)}</span></div>
        <div><span style="color:#64748b;">Margin buffer:</span> <span style="color:${altBufC.fg};font-weight:700;">${fmtBuffer(alt.margin_buffer_bps)}</span></div>
        <div><span style="color:#64748b;">Whole-loan margin:</span> <span style="color:#F1F5F9;font-weight:600;">${fmtBpsAsPct(alt.cost_stack.margin_apr_bps)}</span></div>
      </div>
      <div style="font-size:11px;color:#94A3B8;margin-top:8px;font-style:italic;">
        Compare to warehouse mode above. Whole-loan trades CoF + capital cost for lower margin and direct (no-broker) revenue.
      </div>
    </div>
  `;
}

function renderDeclineBanner(env) {
  if (!env.decline_flag) return '';
  return `
    <div style="padding:14px 18px;background:${COLOURS.bad.bg};border-bottom:1px solid ${COLOURS.bad.border};">
      <div style="font-size:13px;font-weight:700;color:${COLOURS.bad.fg};">⚠ Pricing engine recommends DECLINE</div>
      <div style="font-size:12px;color:#FCA5A5;margin-top:4px;">${sanitizeHtml(env.decline_reason || 'No reason given')}</div>
    </div>
  `;
}

function renderEmpty(message) {
  return `
    <div style="padding:40px 24px;text-align:center;">
      <div style="font-size:13px;color:#94A3B8;">${sanitizeHtml(message)}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────
export async function renderPricingSection(deal, role) {
  const container = document.getElementById('pricing-content');
  if (!container) {
    // Section not in DOM (e.g. role-gated out) — nothing to do
    return;
  }
  if (!deal || !deal.id) {
    container.innerHTML = renderEmpty('No deal loaded.');
    return;
  }

  container.innerHTML = `
    <div style="padding:30px 24px;text-align:center;color:#94A3B8;font-size:13px;">
      <span style="display:inline-block;width:14px;height:14px;border:2px solid #475569;border-top-color:#60A5FA;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:8px;"></span>
      Pricing engine running…
    </div>
    <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
  `;

  let envelope = null;
  try {
    const r = await fetchWithAuth(`${API_BASE}/api/admin/pricing/preview/${deal.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const json = await r.json();
    if (!r.ok || !json.ok) {
      // 422 = no v3.1 risk run; 404 = deal missing; etc.
      const msg = json.error || `HTTP ${r.status}`;
      if (r.status === 422) {
        container.innerHTML = renderEmpty('No settled v3.1 risk run yet. Run risk analysis first, then refresh this section.');
      } else {
        container.innerHTML = renderEmpty('Pricing preview failed: ' + msg);
      }
      return;
    }
    envelope = json.envelope;
  } catch (err) {
    console.error('[deal-pricing] preview failed:', err);
    container.innerHTML = renderEmpty('Pricing preview error: ' + (err.message || err));
    return;
  }

  // Render all sections
  container.innerHTML = `
    ${renderDeclineBanner(envelope)}
    ${renderHeader(envelope, deal.id)}
    ${renderRecommended(envelope)}
    ${renderCostStack(envelope)}
    ${renderYieldReconcile(envelope)}
    ${renderStressMatrix(envelope)}
    ${renderWholeLoanAlt(envelope)}
    ${renderHistoryPanel()}
  `;

  // Update headline pill in section header (if present)
  const headlinePill = document.getElementById('pricing-headline-pill');
  if (headlinePill) {
    const buf = envelope.margin_buffer_bps;
    const bufC = bufferStyle(buf);
    const declineSuffix = envelope.decline_flag ? ' · DECLINE' : '';
    headlinePill.style.display = 'inline-block';
    headlinePill.style.background = bufC.bg;
    headlinePill.style.color = bufC.fg;
    headlinePill.style.border = '1px solid ' + bufC.border;
    headlinePill.textContent = `Buffer ${fmtBuffer(buf)}${declineSuffix}`;
  }

  // Wire up Save button
  const saveBtn = document.getElementById('pricing-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const originalText = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const r = await fetchWithAuth(`${API_BASE}/api/admin/pricing/save/${deal.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const json = await r.json();
        if (!r.ok || !json.ok) {
          showToast('Save failed: ' + (json.error || `HTTP ${r.status}`), 'error');
          saveBtn.textContent = originalText;
          saveBtn.disabled = false;
          return;
        }
        showToast(`Snapshot saved (id ${json.deal_pricing_id})`, 'success');
        saveBtn.textContent = '✓ Saved';
        setTimeout(() => {
          saveBtn.textContent = originalText;
          saveBtn.disabled = false;
        }, 2000);
        // Refresh history
        await loadPricingHistory(deal.id);
      } catch (err) {
        console.error('[deal-pricing] save failed:', err);
        showToast('Save error: ' + (err.message || err), 'error');
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
      }
    });
  }

  // Wire up history refresh
  const refreshBtn = document.getElementById('pricing-history-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadPricingHistory(deal.id));
  }

  // Initial history load (fire-and-forget)
  loadPricingHistory(deal.id);

  // Stash for debugging / export
  window._pricingEnvelope = envelope;
}

// ─────────────────────────────────────────────────────────────────
// History loader — fetched separately, populates "Recent Snapshots"
// ─────────────────────────────────────────────────────────────────
async function loadPricingHistory(dealId) {
  const target = document.getElementById('pricing-history-content');
  if (!target) return;
  target.innerHTML = '<span style="font-style:italic;color:#64748b;">Loading…</span>';

  try {
    const r = await fetchWithAuth(`${API_BASE}/api/admin/pricing/history/${dealId}?limit=10`, { method: 'GET' });
    const json = await r.json();
    if (!r.ok || !json.ok) {
      target.innerHTML = `<span style="color:#F87171;">Error loading history: ${sanitizeHtml(json.error || `HTTP ${r.status}`)}</span>`;
      return;
    }
    const rows = json.history || [];
    if (rows.length === 0) {
      target.innerHTML = '<span style="color:#64748b;font-style:italic;">No snapshots saved yet. Click "Save snapshot" above to record this pricing.</span>';
      return;
    }

    const tableRows = rows.map(h => {
      const buf = h.margin_buffer_bps;
      const bufC = bufferStyle(buf);
      const dt = new Date(h.created_at);
      const ddmm = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const hhmm = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const who = (h.created_by_first || '') + (h.created_by_last ? ' ' + h.created_by_last.charAt(0) : '');
      return `
        <tr>
          <td style="padding:5px 10px;color:#94A3B8;font-size:11px;font-variant-numeric:tabular-nums;">#${h.id}</td>
          <td style="padding:5px 10px;color:#CBD5E1;font-size:12px;">${ddmm} ${hhmm}</td>
          <td style="padding:5px 10px;color:#94A3B8;font-size:11px;">${sanitizeHtml(who.trim() || '—')}</td>
          <td style="padding:5px 10px;color:#94A3B8;font-size:11px;">PD${h.input_pd}·${h.input_lgd}·${h.input_ia}</td>
          <td style="padding:5px 10px;color:#CBD5E1;font-size:12px;font-variant-numeric:tabular-nums;">${fmtBpsAsPm(h.recommended_rate_bps_pm)}</td>
          <td style="padding:5px 10px;text-align:right;font-variant-numeric:tabular-nums;color:${bufC.fg};font-weight:600;font-size:12px;">${fmtBuffer(buf)}</td>
          <td style="padding:5px 10px;text-align:center;">${h.decline_flag ? `<span style="padding:2px 6px;border-radius:6px;font-size:10px;background:${COLOURS.bad.bg};color:${COLOURS.bad.fg};">DECLINE</span>` : ''}${h.override_used ? `<span style="padding:2px 6px;border-radius:6px;font-size:10px;background:${COLOURS.warn.bg};color:${COLOURS.warn.fg};margin-left:4px;">override</span>` : ''}</td>
        </tr>
      `;
    }).join('');

    target.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid rgba(148,163,184,0.20);">
            <th style="padding:5px 10px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">ID</th>
            <th style="padding:5px 10px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">When</th>
            <th style="padding:5px 10px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">By</th>
            <th style="padding:5px 10px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">Grade</th>
            <th style="padding:5px 10px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">Rate</th>
            <th style="padding:5px 10px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">Buffer</th>
            <th style="padding:5px 10px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#64748b;">Flags</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    `;
  } catch (err) {
    console.error('[deal-pricing] history load failed:', err);
    target.innerHTML = `<span style="color:#F87171;">History error: ${sanitizeHtml(err.message || String(err))}</span>`;
  }
}
