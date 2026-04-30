/**
 * js/quick-quote.js — Broker Quick Quote frontend · QQ bundle (2026-04-29)
 *
 * Multi-property quick quote with portfolio-level effective LTV.
 * Drops the drawdown-date field — borrowers want money now anyway.
 *
 * Form structure:
 *   - Properties list (1..N) — postcode + address + purpose + optional balance + optional manual AVM
 *   - Borrower company (number + name with autocomplete)
 *   - Total loan amount
 *
 * Backend: POST /api/broker/quick-quote with { properties: [...], company_number, loan_amount }.
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';

let nextPropId = 1;

function fmtMoneyPence(pence) {
  if (pence == null || isNaN(pence)) return '—';
  return '£' + Math.round(Number(pence) / 100).toLocaleString('en-GB');
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(1) + '%';
}
function fmtRate(bps) {
  if (bps == null || isNaN(bps)) return '—';
  return (Number(bps) / 100).toFixed(3) + '% pm';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function showQqResult(html) {
  const host = document.getElementById('qq-result-container');
  if (!host) return;
  host.innerHTML = html;
  host.style.display = 'block';
}
function hideQqResult() {
  const host = document.getElementById('qq-result-container');
  if (host) { host.innerHTML = ''; host.style.display = 'none'; }
}
function setBusy(busy) {
  const btn = document.getElementById('qq-submit');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Calculating…' : 'Get instant quote';
    btn.style.opacity = busy ? '0.6' : '1';
  }
}

// Comma-format money inputs
function attachCommaFormatter(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const raw = input.value.replace(/[^\d]/g, '');
    if (!raw) { input.value = ''; return; }
    const formatted = Number(raw).toLocaleString('en-GB');
    const cursorPos = input.selectionStart;
    let digitsBeforeCursor = 0;
    for (let i = 0; i < cursorPos; i++) if (/\d/.test(input.value[i])) digitsBeforeCursor++;
    input.value = formatted;
    let newCursor = 0, seen = 0;
    for (let i = 0; i < formatted.length && seen < digitsBeforeCursor; i++) {
      if (/\d/.test(formatted[i])) seen++;
      newCursor = i + 1;
    }
    try { input.setSelectionRange(newCursor, newCursor); } catch (_) {}
  });
}

// ─── Property row template ───────────────────────────────────────────────
// Each property has its own postcode, address, purpose, charge-type (auto-derived
// from purpose), optional existing balance (refi/equity release), optional
// manual AVM. Adds an autocomplete dropdown attached to the postcode input.
function renderPropertyRow(idx) {
  return `
    <div data-prop-row="${idx}" style="background:rgba(255,255,255,0.02);border:1px solid #2d3748;border-radius:6px;padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-size:11px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Property ${idx}</div>
        ${idx > 1 ? `<button type="button" data-remove-prop="${idx}" style="background:transparent;border:none;color:#F87171;font-size:11px;cursor:pointer;text-decoration:underline;">Remove</button>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:140px 1fr;gap:10px;margin-bottom:10px;">
        <div style="position:relative;">
          <label style="display:block;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:4px;">Postcode</label>
          <input data-prop-postcode="${idx}" type="text" placeholder="e.g. W6 9RH" required maxlength="8"
            style="width:100%;background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:12px;text-transform:uppercase;" />
        </div>
        <div>
          <label style="display:block;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:4px;">Address (pick from dropdown or edit)</label>
          <input data-prop-address="${idx}" type="text" placeholder="House number, street"
            style="width:100%;background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:12px;" />
          <input data-prop-uprn="${idx}" type="hidden" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:4px;">Purpose</label>
          <select data-prop-purpose="${idx}" required
            style="width:100%;background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:12px;">
            <option value="">— select —</option>
            <option value="acquisition">Acquisition (1st charge)</option>
            <option value="refinance">Refinance (1st after redemption)</option>
            <option value="equity_release">Equity release (2nd charge)</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:4px;">Existing charge balance (£)</label>
          <input data-prop-balance="${idx}" type="text" inputmode="numeric" placeholder="If refinance / equity release"
            style="width:100%;background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:12px;" />
        </div>
        <div>
          <label style="display:block;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:4px;">Manual AVM override (£, optional)</label>
          <input data-prop-manual-avm="${idx}" type="text" inputmode="numeric" placeholder="Use if Chimnie has no AVM"
            style="width:100%;background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:12px;" />
        </div>
      </div>
    </div>
  `;
}

function addPropertyRow() {
  const list = document.getElementById('qq-properties-list');
  if (!list) return;
  const idx = nextPropId++;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderPropertyRow(idx);
  list.appendChild(wrapper.firstElementChild);
  // Comma-format the money inputs in the new row
  const balanceEl = list.querySelector(`[data-prop-balance="${idx}"]`);
  const avmEl = list.querySelector(`[data-prop-manual-avm="${idx}"]`);
  attachCommaFormatter(balanceEl);
  attachCommaFormatter(avmEl);
  // Autocomplete on the new postcode input
  const pcEl = list.querySelector(`[data-prop-postcode="${idx}"]`);
  const addrEl = list.querySelector(`[data-prop-address="${idx}"]`);
  attachPostcodeAutocomplete(pcEl, addrEl);
}

function removePropertyRow(idx) {
  const row = document.querySelector(`[data-prop-row="${idx}"]`);
  if (row) row.remove();
}

// ─── Postcode autocomplete (per-input) ────────────────────────────────────
function attachPostcodeAutocomplete(pcInput, addrInput) {
  if (!pcInput) return;
  pcInput.parentNode.style.position = 'relative';
  let dropdown = pcInput.parentNode.querySelector('.qq-pc-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'qq-pc-dropdown';
    dropdown.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;background:#151a21;border:1px solid #2a3340;border-radius:6px;margin-top:4px;max-height:280px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:13px;min-width:300px;';
    pcInput.parentNode.appendChild(dropdown);
  }
  const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  let timer = null, lastQ = '';

  function hide() { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }

  pcInput.addEventListener('input', () => {
    const q = pcInput.value.trim().toUpperCase();
    if (q === lastQ) return;
    lastQ = q;
    if (timer) clearTimeout(timer);
    if (!POSTCODE_RE.test(q)) { hide(); return; }
    timer = setTimeout(async () => {
      try {
        const r = await fetchWithAuth(`${API_BASE}/api/broker/postcode-lookup?postcode=${encodeURIComponent(q)}`);
        const json = await r.json();
        if (!r.ok || !json.ok) { hide(); return; }
        const addresses = json.addresses || [];
        if (!addresses.length) { hide(); return; }
        dropdown.innerHTML = addresses.map((a, i) =>
          `<div data-pc-idx="${i}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #2a3340;color:#E5E7EB;">${escapeHtml((a.line_1 || '') + (a.line_2 ? ', ' + a.line_2 : '') + (a.post_town ? ', ' + a.post_town : ''))}</div>`
        ).join('') + (addresses.length > 20 ? `<div style="padding:6px 12px;font-size:11px;color:#64748B;background:#0e131a;text-align:center;">${addresses.length} addresses · scroll for more</div>` : '');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('[data-pc-idx]').forEach((el) => {
          el.addEventListener('mouseover', () => el.style.background = '#1e2531');
          el.addEventListener('mouseout',  () => el.style.background = 'transparent');
          el.addEventListener('click', () => {
            const idx = Number(el.getAttribute('data-pc-idx'));
            const a = addresses[idx];
            if (a) {
              if (addrInput) {
                const line = [a.line_1, a.line_2, a.line_3, a.post_town].filter(Boolean).join(', ');
                addrInput.value = line;
              }
              if (a.postcode) pcInput.value = a.postcode;
              // Stash UPRN on the property row's hidden input so the backend
              // can use chimnie.lookupByUprn (more reliable than fuzzy match)
              const rowEl = pcInput.closest('[data-prop-row]');
              if (rowEl) {
                const uprnInput = rowEl.querySelector('[data-prop-uprn]');
                if (uprnInput) uprnInput.value = a.uprn || '';
              }
            }
            hide();
          });
        });
      } catch (err) {
        console.warn('[qq/postcode] lookup failed:', err.message);
        hide();
      }
    }, 250);
  });

  document.addEventListener('click', (e) => {
    if (!pcInput.parentNode.contains(e.target)) hide();
  });
}

// ─── Company autocomplete (Companies House search) ────────────────────────
function attachCompanyAutocomplete() {
  const numInput = document.getElementById('qq-company-number');
  const nameInput = document.getElementById('qq-company-name');
  if (!numInput && !nameInput) return;
  let dropdown = document.querySelector('.qq-co-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'qq-co-dropdown';
    dropdown.style.cssText = 'display:none;position:absolute;background:#151a21;border:1px solid #2a3340;border-radius:6px;margin-top:4px;max-height:280px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-size:13px;';
    document.body.appendChild(dropdown);
  }
  let activeInput = null, timer = null, lastQ = '';
  function hide() { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  function positionUnder(el) {
    const r = el.getBoundingClientRect();
    dropdown.style.top  = (window.scrollY + r.bottom) + 'px';
    dropdown.style.left = (window.scrollX + r.left) + 'px';
    dropdown.style.width = r.width + 'px';
  }
  async function lookup(q) {
    try {
      const r = await fetchWithAuth(`${API_BASE}/api/companies-house/search?q=${encodeURIComponent(q)}`);
      const json = await r.json();
      if (!r.ok || !json.success) { hide(); return; }
      const results = (json.results || []).slice(0, 10);
      if (!results.length) { hide(); return; }
      dropdown.innerHTML = results.map((c, i) =>
        `<div data-co-idx="${i}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #2a3340;color:#E5E7EB;">
           <div style="font-weight:600;">${escapeHtml(c.title || c.company_name || '')}</div>
           <div style="font-size:11px;color:#94A3B8;">${escapeHtml(c.company_number || '')} · ${escapeHtml(c.company_status || '')}</div>
         </div>`
      ).join('');
      if (activeInput) positionUnder(activeInput);
      dropdown.style.display = 'block';
      dropdown.querySelectorAll('[data-co-idx]').forEach((el) => {
        el.addEventListener('mouseover', () => el.style.background = '#1e2531');
        el.addEventListener('mouseout',  () => el.style.background = 'transparent');
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const idx = Number(el.getAttribute('data-co-idx'));
          const c = results[idx];
          if (c) {
            if (numInput)  numInput.value  = c.company_number || '';
            if (nameInput) nameInput.value = c.title || c.company_name || '';
          }
          hide();
        });
      });
    } catch (err) {
      console.warn('[qq/company] search failed:', err.message);
      hide();
    }
  }
  function onInput(e) {
    activeInput = e.target;
    const q = activeInput.value.trim();
    if (q === lastQ) return;
    lastQ = q;
    if (timer) clearTimeout(timer);
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(() => lookup(q), 300);
  }
  if (numInput)  { numInput.addEventListener('input', onInput);  numInput.addEventListener('focus', onInput); }
  if (nameInput) { nameInput.addEventListener('input', onInput); nameInput.addEventListener('focus', onInput); }
  document.addEventListener('click', (e) => {
    if (e.target !== numInput && e.target !== nameInput && !dropdown.contains(e.target)) hide();
  });
}

// ─── Result rendering ─────────────────────────────────────────────────────
function buildResultHtml(data) {
  const v = data.verdict || {};
  const cc = data.cross_collateral || null;
  const properties = data.properties || [];
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

  const propertyRows = properties.map((p, i) => {
    const isFirstCharge = (p.charge_type || 'first_charge') === 'first_charge';
    const chargeBadge = isFirstCharge
      ? '<span style="background:rgba(212,168,83,0.15);color:#D4A853;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;">1ST</span>'
      : '<span style="background:rgba(167,139,250,0.15);color:#A78BFA;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;">2ND · COMFORT</span>';
    const avmLabel = p.avm_source === 'broker_estimate' ? 'broker estimate'
                  : (p.avm_source === 'chimnie' ? 'Chimnie AVM' : 'no AVM');
    return `
      <div style="display:grid;grid-template-columns:1fr auto auto;gap:12px;padding:8px 12px;border-bottom:1px solid #2d3748;font-size:12px;align-items:center;">
        <div>
          <div style="color:#E5E7EB;font-weight:500;">${escapeHtml(p.address_text || p.postcode || `Property ${i+1}`)}</div>
          <div style="font-size:10px;color:#94A3B8;">${escapeHtml(p.postcode || '')} · ${escapeHtml(p.purpose || '')} ${chargeBadge}</div>
        </div>
        <div style="text-align:right;">
          <div style="color:#F1F5F9;font-weight:600;">${fmtMoneyPence(p.avm_pence)}</div>
          <div style="font-size:10px;color:#64748B;">${avmLabel}</div>
        </div>
        <div style="text-align:right;min-width:100px;">
          <div style="color:#94A3B8;font-size:10px;">contributes to LTV</div>
          <div style="color:${isFirstCharge ? '#34D399' : '#94A3B8'};font-weight:600;">${isFirstCharge ? fmtMoneyPence(p.avm_pence) : '£0 (comfort)'}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div style="background:${verdictBg};border:1px solid ${verdictBorder};border-radius:8px;padding:14px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span style="font-size:22px;color:${verdictColor};">${verdictIcon}</span>
          <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${verdictColor};">${v.eligible ? 'Looks fundable' : 'Needs more security or structure'}</span>
        </div>
        <div style="font-size:13px;color:#E5E7EB;line-height:1.5;">${escapeHtml(v.reason || '')}</div>
      </div>
      ${v.eligible ? `<button id="qq-submit-deal" type="button" style="background:#D4A853;color:#111;border:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;" data-quick-quote-id="${data.quick_quote_id}">Submit full deal pack →</button>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px;margin-bottom:14px;">
      ${kpiCard('Effective LTV', fmtPct(v.ltv_pct), cc ? `${fmtMoneyPence(cc.daksfirst_exposure_pence)} / ${fmtMoneyPence(cc.effective_security_value_pence)} (1st charges only)` : 'Needs valuation')}
      ${kpiCard('Indicative rate', pr ? fmtRate(pr.rate_bps_pm) : '—', pr ? `at typical PD5/LGDC/IAC · min term ${pr.min_term_months || '?'}m` : 'Pricing not run')}
      ${cc && cc.comfort_security_value_pence > 0 ? kpiCard('2nd-charge comfort', fmtMoneyPence(cc.comfort_security_value_pence), `${cc.second_charge_count} property — not in LTV`) : ''}
      ${cc && cc.refinance_count > 0 ? kpiCard('Refi redemptions', fmtMoneyPence(cc.total_existing_redemptions_pence), `${cc.refinance_count} ${cc.refinance_count === 1 ? 'property' : 'properties'} · auto in S&U`) : ''}
    </div>

    ${cc && cc.refi_redemptions_added_pence > 0 ? `
      <div style="background:rgba(167,139,250,0.05);border:1px solid rgba(167,139,250,0.25);border-radius:6px;padding:10px 14px;margin-bottom:14px;">
        <div style="font-size:10px;color:#A78BFA;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:6px;">Total Daksfirst facility breakdown</div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#E5E7EB;padding:3px 0;">
          <span>Acquisition / new money</span>
          <span style="font-weight:600;">${fmtMoneyPence(cc.acquisition_loan_pence)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#E5E7EB;padding:3px 0;">
          <span>+ Refi redemption${cc.refinance_count === 1 ? '' : 's'}</span>
          <span style="font-weight:600;color:#A78BFA;">${fmtMoneyPence(cc.refi_redemptions_added_pence)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#F1F5F9;padding:6px 0 0;border-top:1px solid rgba(167,139,250,0.2);margin-top:4px;">
          <span style="font-weight:700;">= Total Daksfirst facility</span>
          <span style="font-weight:700;font-family:'Playfair Display',serif;">${fmtMoneyPence(cc.total_facility_pence)}</span>
        </div>
      </div>
    ` : ''}

    <div style="background:rgba(255,255,255,0.02);border:1px solid #2d3748;border-radius:6px;margin-bottom:14px;">
      <div style="padding:8px 12px;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;border-bottom:1px solid #2d3748;background:rgba(255,255,255,0.02);">Portfolio (${properties.length} ${properties.length === 1 ? 'property' : 'properties'})</div>
      ${propertyRows}
    </div>

    ${c ? `
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:6px;padding:10px 14px;font-size:12px;color:#94A3B8;display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <span><strong style="color:#E5E7EB;">${escapeHtml(c.name || c.number || '')}</strong></span>
        <span>${escapeHtml(c.number || '')}</span>
        <span>Status: <strong style="color:${c.status === 'active' ? '#34D399' : '#F87171'};">${escapeHtml(c.status || '—')}</strong></span>
        ${c.age_years != null ? `<span>${c.age_years} yrs trading</span>` : ''}
      </div>
    ` : ''}

    <div style="padding:8px 12px;background:rgba(96,165,250,0.04);border-left:3px solid #60A5FA;border-radius:3px;font-size:10.5px;color:#94A3B8;">
      ℹ Quick Quote uses default mid-grade (PD5/LGDC/IAC). Final rate depends on full underwriting (RICS valuation, full credit + KYC, IC review).
    </div>
  `;
}

// ─── Form gathering + submission ───────────────────────────────────────────
function gatherProperties() {
  const rows = document.querySelectorAll('[data-prop-row]');
  const list = [];
  rows.forEach((row) => {
    const idx = row.getAttribute('data-prop-row');
    const get = (sel) => row.querySelector(sel)?.value;
    const postcode = (get(`[data-prop-postcode="${idx}"]`) || '').trim().toUpperCase();
    const address  = (get(`[data-prop-address="${idx}"]`)  || '').trim();
    const uprn     = (get(`[data-prop-uprn="${idx}"]`)     || '').trim();
    const purpose  = get(`[data-prop-purpose="${idx}"]`);
    const balance  = (get(`[data-prop-balance="${idx}"]`)  || '').replace(/,/g, '').trim();
    const manual   = (get(`[data-prop-manual-avm="${idx}"]`) || '').replace(/,/g, '').trim();
    if (!postcode || !purpose) return;  // skip incomplete rows
    list.push({
      postcode,
      address_text: address || null,
      paf_uprn: uprn || null,            // captured when broker picks from PAF dropdown
      purpose,
      existing_charge_balance: balance ? Number(balance) : null,
      manual_avm: manual ? Number(manual) : null,
    });
  });
  return list;
}

async function handleQqSubmit(e) {
  e.preventDefault();
  hideQqResult();

  const properties = gatherProperties();
  const cn       = (document.getElementById('qq-company-number')?.value || '').trim().toUpperCase();
  const cname    = (document.getElementById('qq-company-name')?.value   || '').trim();
  const amt      = (document.getElementById('qq-loan-amount')?.value    || '').replace(/,/g, '').trim();

  if (!properties.length) {
    showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Add at least one property with postcode + purpose.</div>`);
    return;
  }
  if (!amt) {
    showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Total loan amount required.</div>`);
    return;
  }

  setBusy(true);
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/broker/quick-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties,
        company_number: cn || null,
        company_name_input: cname || null,
        loan_amount: Number(amt),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Quote failed: ${escapeHtml(data.error || String(res.status))}</div>`);
      return;
    }
    showQqResult(buildResultHtml(data));
    const ctaBtn = document.getElementById('qq-submit-deal');
    if (ctaBtn) {
      ctaBtn.addEventListener('click', async () => {
        const qqid = ctaBtn.getAttribute('data-quick-quote-id');
        if (!qqid) return;
        ctaBtn.disabled = true;
        ctaBtn.textContent = 'Creating deal…';
        ctaBtn.style.opacity = '0.6';
        try {
          // Convert the quote into a real deal record (skips the multi-tab
          // submission form — broker already gave us everything we need)
          const r = await fetchWithAuth(`${API_BASE}/api/broker/quick-quote/${qqid}/convert-to-deal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          const d = await r.json();
          if (!r.ok || !d.ok) {
            alert('Couldn\'t convert quote to deal: ' + (d.error || r.status));
            ctaBtn.disabled = false;
            ctaBtn.textContent = 'Submit full deal pack →';
            ctaBtn.style.opacity = '1';
            return;
          }
          if (typeof window.showToast === 'function') {
            window.showToast(d.message || `Deal ${d.submission_id} created — drop documents below`, 'success');
          }
          // Navigate to the dashboard so the broker sees their new deal in the
          // "My Deals" list and can click into it for documents. Refresh deals
          // first so the new row appears immediately.
          if (typeof window.showDashboard === 'function') {
            await window.showDashboard();
          }
        } catch (err) {
          console.error('[qq/convert] error:', err);
          alert('Connection error: ' + err.message);
          ctaBtn.disabled = false;
          ctaBtn.textContent = 'Submit full deal pack →';
          ctaBtn.style.opacity = '1';
        }
      });
    }
  } catch (err) {
    console.error('[quick-quote] error:', err);
    showQqResult(`<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.3);padding:10px 14px;border-radius:6px;color:#F87171;font-size:13px;">Connection error: ${escapeHtml(err.message)}</div>`);
  } finally {
    setBusy(false);
  }
}

export function initQuickQuote() {
  const toggle = document.getElementById('qq-toggle');
  const formContainer = document.getElementById('qq-form-container');
  const cancel = document.getElementById('qq-cancel');
  const form = document.getElementById('qq-form');
  const addPropBtn = document.getElementById('qq-add-property');
  const propList = document.getElementById('qq-properties-list');
  if (!toggle || !formContainer || !form || !propList) return;

  // Seed first property row
  if (propList.children.length === 0) addPropertyRow();

  attachCompanyAutocomplete();
  attachCommaFormatter(document.getElementById('qq-loan-amount'));

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

  if (addPropBtn) addPropBtn.addEventListener('click', () => addPropertyRow());

  // Delegated remove handler
  propList.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('[data-remove-prop]')) {
      const idx = t.getAttribute('data-remove-prop');
      removePropertyRow(idx);
    }
  });

  form.addEventListener('submit', handleQqSubmit);
}
