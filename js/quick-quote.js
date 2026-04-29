/**
 * js/quick-quote.js — Broker Quick Quote frontend · QQ-3 (2026-04-29)
 *
 * Wires the dashboard's #qq-section panel:
 *   - Toggle button shows/hides the form
 *   - Form submit posts to /api/broker/quick-quote
 *   - Result panel renders verdict + KPI cards + CTA
 *
 * Loaded as a module by app.js bootstrapping.
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';

function fmtMoneyPence(pence) {
  if (pence == null || isNaN(pence)) return '—';
  const pounds = Math.round(Number(pence) / 100);
  return '£' + pounds.toLocaleString('en-GB');
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(1) + '%';
}

function fmtRate(bps) {
  if (bps == null || isNaN(bps)) return '—';
  return (Number(bps) / 100).toFixed(3) + '% pm';
}

function showQqResult(html) {
  const host = document.getElementById('qq-result-container');
  if (!host) return;
  host.innerHTML = html;
  host.style.display = 'block';
}

function hideQqResult() {
  const host = document.getElementById('qq-result-container');
  if (host) {
    host.innerHTML = '';
    host.style.display = 'none';
  }
}

function setBusy(busy) {
  const btn = document.getElementById('qq-submit');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Calculating…' : 'Get instant quote';
    btn.style.opacity = busy ? '0.6' : '1';
  }
}

function buildResultHtml(data) {
  const v = data.verdict || {};
  const p = data.property || {};
  const c = data.company || null;
  const pr = data.pricing || null;

  const verdictColor = v.eligible ? '#34D399' : '#FBBF24';
  const verdictBg    = v.eligible ? 'rgba(52,211,153,0.10)' : 'rgba(251,191,36,0.10)';
  const verdictBorder = v.eligible ? 'rgba(52,211,153,0.35)' : 'rgba(251,191,36,0.35)';
  const verdictIcon = v.eligible ? '✓' : '⚠';

  const kpiCard = (label, value, sub) => `
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:12px 14px;">
      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${label}</div>
      <div style="font-size:18px;color:#F1F5F9;font-weight:700;margin-top:4px;font-family:'Playfair Display',serif;">${value}</div>
      ${sub ? `<div style="font-size:10px;color:#64748B;margin-top:2px;">${sub}</div>` : ''}
    </div>`;

  return `
    <div style="background:${verdictBg};border:1px solid ${verdictBorder};border-radius:8px;padding:14px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span style="font-size:22px;color:${verdictColor};">${verdictIcon}</span>
          <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${verdictColor};">${v.eligible ? 'Looks fundable' : 'Needs more security or structure'}</span>
        </div>
        <div style="font-size:13px;color:#E5E7EB;line-height:1.5;">${v.reason || ''}</div>
      </div>
      ${v.eligible ? `<button id="qq-submit-deal" type="button" style="background:#D4A853;color:#111;border:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;" data-quick-quote-id="${data.quick_quote_id}">Submit full deal pack →</button>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px;margin-bottom:12px;">
      ${kpiCard('AVM', fmtMoneyPence(p.avm_pence), p.property_type || (p.avm_pence ? '' : 'No AVM available'))}
      ${kpiCard('Effective LTV', fmtPct(v.ltv_pct), v.ltv_pct == null ? 'Needs valuation' : '')}
      ${pr ? kpiCard('Indicative rate', fmtRate(pr.rate_bps_pm), `at typical PD5/LGDC/IAC grade · min term ${pr.min_term_months || '?'}m`) : kpiCard('Indicative rate', '—', 'Pricing not run (LTV or company gate)')}
      ${p.rental_pcm_pence ? kpiCard('Estimated rental', fmtMoneyPence(p.rental_pcm_pence) + '/m', `gross yield ${p.yield_gross_pct ?? '?'}%`) : ''}
    </div>

    ${c ? `
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:6px;padding:10px 14px;font-size:12px;color:#94A3B8;display:flex;gap:18px;flex-wrap:wrap;align-items:center;">
        <span><strong style="color:#E5E7EB;">${c.name || c.number}</strong></span>
        <span>${c.number}</span>
        <span>Status: <strong style="color:${c.status === 'active' ? '#34D399' : '#F87171'};">${c.status || '—'}</strong></span>
        ${c.age_years != null ? `<span>${c.age_years} yrs trading</span>` : ''}
      </div>
    ` : ''}

    <div style="margin-top:10px;padding:8px 12px;background:rgba(96,165,250,0.04);border-left:3px solid #60A5FA;border-radius:3px;font-size:10.5px;color:#94A3B8;">
      ℹ Quick Quote uses default mid-grade (PD5/LGDC/IAC) for indicative pricing. Final rate depends on full underwriting (RICS valuation, full credit + KYC, IC review).
    </div>
  `;
}

async function handleQqSubmit(e) {
  e.preventDefault();
  hideQqResult();

  const postcode = (document.getElementById('qq-postcode')?.value || '').trim().toUpperCase();
  const address  = (document.getElementById('qq-address')?.value  || '').trim();
  const cn       = (document.getElementById('qq-company-number')?.value || '').trim().toUpperCase();
  const cname    = (document.getElementById('qq-company-name')?.value   || '').trim();
  const amt      = (document.getElementById('qq-loan-amount')?.value    || '').trim();
  const purpose  = document.getElementById('qq-purpose')?.value;
  const date     = document.getElementById('qq-drawdown-date')?.value;

  if (!postcode || !amt || !purpose) {
    showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Please fill in postcode, loan amount, and purpose.</div>`);
    return;
  }

  setBusy(true);
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/broker/quick-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postcode,
        address_text: address || null,
        company_number: cn || null,
        company_name_input: cname || null,
        loan_amount: Number(amt),
        purpose,
        drawdown_target_date: date || null,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Quote failed: ${data.error || res.status}</div>`);
      return;
    }
    showQqResult(buildResultHtml(data));
    // Wire the "Submit full deal pack" CTA
    const ctaBtn = document.getElementById('qq-submit-deal');
    if (ctaBtn) {
      ctaBtn.addEventListener('click', () => {
        const qqid = ctaBtn.getAttribute('data-quick-quote-id');
        // Pre-fill flow comes in QQ-4 — for now route to the existing form
        // and stash the quick_quote_id in sessionStorage so the form can pick it up.
        try { sessionStorage.setItem('qq_pending_id', qqid); } catch (_) {}
        if (typeof window.showDealForm === 'function') {
          window.showDealForm();
        } else {
          alert('Submission form unavailable. Please refresh the page.');
        }
      });
    }
  } catch (err) {
    console.error('[quick-quote] error:', err);
    showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Connection error: ${err.message}</div>`);
  } finally {
    setBusy(false);
  }
}

export function initQuickQuote() {
  const toggle = document.getElementById('qq-toggle');
  const formContainer = document.getElementById('qq-form-container');
  const cancel = document.getElementById('qq-cancel');
  const form = document.getElementById('qq-form');
  if (!toggle || !formContainer || !form) return;  // Section not in DOM (older page or different role)

  toggle.addEventListener('click', () => {
    const isOpen = formContainer.style.display !== 'none';
    if (isOpen) {
      formContainer.style.display = 'none';
      hideQqResult();
      toggle.textContent = 'Open quote form';
    } else {
      formContainer.style.display = 'block';
      toggle.textContent = 'Close';
    }
  });

  if (cancel) cancel.addEventListener('click', () => {
    formContainer.style.display = 'none';
    hideQqResult();
    toggle.textContent = 'Open quote form';
  });

  form.addEventListener('submit', handleQqSubmit);
}
