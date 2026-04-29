/**
 * address-autocomplete.js — Royal Mail PAF lookup widget · PROP-3 (2026-04-29)
 *
 * Drop-in autocomplete component. RM types a postcode (or partial address);
 * dropdown shows verified PAF addresses; on select, calls `onSelect(address)`
 * with the full PAF object (including UPRN, UDPRN, lat/lng, etc.).
 *
 * Usage:
 *   import { mountAddressAutocomplete } from './address-autocomplete.js';
 *   mountAddressAutocomplete({
 *     containerEl: document.getElementById('paf-input-mount'),
 *     onSelect: (address, opts) => {
 *       // address has line_1, post_town, postcode, uprn, udprn, lat, lng, etc.
 *       // opts.persisted: true if address was saved to deal_properties
 *     },
 *     propertyId: 107,   // optional; if set, /select-address persists to deal_properties
 *     dealId: 32,        // optional; for audit trail
 *   });
 *
 * Behaviour:
 *   - User types → debounced 250ms → calls /admin/property/postcode-lookup
 *     if input looks like a postcode (regex), else /admin/property/autocomplete
 *   - Dropdown shows up to 10 matches
 *   - Click a match → calls /admin/property/select-address (resolves UDPRN to
 *     full address + persists if propertyId set) → fires onSelect callback
 *   - Esc / click-outside dismisses dropdown
 *
 * Auth: uses sessionStorage.daksfirst_token (matches admin pages pattern).
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { sanitizeHtml } from './utils.js';

const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;

export function mountAddressAutocomplete({ containerEl, onSelect, propertyId = null, dealId = null, placeholder = 'Type postcode or address (e.g. W6 9RH or 129 Rann)' }) {
  if (!containerEl) {
    console.warn('[address-autocomplete] containerEl required');
    return null;
  }

  containerEl.innerHTML = `
    <div class="paf-autocomplete" style="position:relative;">
      <input type="text"
             class="paf-input"
             placeholder="${sanitizeHtml(placeholder)}"
             autocomplete="off"
             style="width:100%;padding:8px 12px;background:#0b0e13;color:#F1F5F9;border:1px solid #2a3340;border-radius:6px;font-size:13px;font-family:inherit;">
      <div class="paf-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#151a21;border:1px solid #2a3340;border-radius:6px;margin-top:4px;max-height:280px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,0.4);"></div>
      <div class="paf-status" style="font-size:11px;color:#64748b;margin-top:4px;font-style:italic;"></div>
    </div>
  `;

  const inputEl = containerEl.querySelector('.paf-input');
  const dropdownEl = containerEl.querySelector('.paf-dropdown');
  const statusEl = containerEl.querySelector('.paf-status');

  let debounceTimer = null;
  let lastResults = [];

  inputEl.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = inputEl.value.trim();
    if (q.length < 2) {
      hideDropdown();
      statusEl.textContent = '';
      return;
    }
    statusEl.textContent = 'Searching…';
    debounceTimer = setTimeout(() => doLookup(q), 250);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!containerEl.contains(e.target)) hideDropdown();
  });

  async function doLookup(q) {
    const isPostcode = POSTCODE_REGEX.test(q);
    try {
      const url = isPostcode
        ? `${API_BASE}/api/admin/property/postcode-lookup?postcode=${encodeURIComponent(q)}`
        : `${API_BASE}/api/admin/property/autocomplete?q=${encodeURIComponent(q)}`;
      const r = await fetchWithAuth(url, { method: 'GET' });
      const json = await r.json();
      if (!r.ok || !json.ok) {
        statusEl.textContent = `Error: ${json.error || `HTTP ${r.status}`}`;
        hideDropdown();
        return;
      }

      // Postcode lookup returns { addresses: [...] }; autocomplete returns { suggestions: [...] }
      const items = isPostcode
        ? (json.addresses || []).map(a => ({
            label: `${a.line_1}${a.line_2 ? ', ' + a.line_2 : ''}, ${a.post_town}, ${a.postcode}`,
            udprn: a.udprn,
            address: a,  // full address available on click
          }))
        : (json.suggestions || []).map(s => ({
            label: s.suggestion,
            udprn: s.udprn,
            address: null,  // will be resolved on click
          }));

      lastResults = items;
      renderDropdown(items, json.mode);
      statusEl.textContent = items.length === 0
        ? `No addresses found ${isPostcode ? `for ${q}` : 'matching ' + q}`
        : `${items.length} match${items.length === 1 ? '' : 'es'} (mode: ${json.mode})`;
    } catch (err) {
      statusEl.textContent = `Network error: ${err.message}`;
      hideDropdown();
    }
  }

  function renderDropdown(items, mode) {
    if (items.length === 0) {
      hideDropdown();
      return;
    }
    dropdownEl.innerHTML = items.map((item, i) => `
      <div class="paf-option"
           data-idx="${i}"
           style="padding:8px 12px;cursor:pointer;font-size:13px;color:#CBD5E1;border-bottom:1px solid rgba(42,51,64,0.5);">
        ${sanitizeHtml(item.label)}
        <span style="float:right;font-size:11px;color:#64748b;">UDPRN ${item.udprn}</span>
      </div>
    `).join('');
    dropdownEl.style.display = 'block';

    dropdownEl.querySelectorAll('.paf-option').forEach(el => {
      el.addEventListener('mouseover', () => { el.style.background = 'rgba(78,161,255,0.08)'; });
      el.addEventListener('mouseout',  () => { el.style.background = ''; });
      el.addEventListener('click', async () => {
        const idx = Number(el.dataset.idx);
        const item = lastResults[idx];
        if (!item) return;

        // If we have the full address already (postcode lookup), call select-address
        // to persist + audit. If we only have UDPRN (autocomplete), resolve via select-address.
        statusEl.textContent = 'Resolving address…';
        hideDropdown();
        try {
          const r = await fetchWithAuth(`${API_BASE}/api/admin/property/select-address`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udprn: item.udprn, property_id: propertyId, deal_id: dealId }),
          });
          const json = await r.json();
          if (!r.ok || !json.ok) {
            statusEl.textContent = `Resolve failed: ${json.error || `HTTP ${r.status}`}`;
            return;
          }
          inputEl.value = `${json.address.line_1}, ${json.address.post_town}, ${json.address.postcode}`;
          statusEl.textContent = `✓ ${json.persisted ? 'Saved to property' : 'Address verified'} (UPRN ${json.address.uprn || '—'}, mode: ${json.mode})`;
          if (typeof onSelect === 'function') {
            onSelect(json.address, { persisted: json.persisted, mode: json.mode, cost_pence: json.cost_pence });
          }
        } catch (err) {
          statusEl.textContent = `Error: ${err.message}`;
        }
      });
    });
  }

  function hideDropdown() {
    dropdownEl.style.display = 'none';
    dropdownEl.innerHTML = '';
  }

  return {
    setValue(v) { inputEl.value = v; },
    clear() { inputEl.value = ''; hideDropdown(); statusEl.textContent = ''; },
    focus() { inputEl.focus(); },
  };
}
