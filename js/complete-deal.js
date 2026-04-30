/**
 * complete-deal.js — "Complete Your Deal" landing screen
 * ──────────────────────────────────────────────────────────────────────────
 * Triggered when a broker hits "Submit anyway — discuss with RM" on the
 * Quick Quote panel. The QQ→deal conversion has already been done server-side
 * by POST /api/broker/quick-quote/:id/convert-to-deal — we land here with
 * the new submission_id + the original qqId.
 *
 * Layout:
 *   ┌── Sticky QQ summary (top) ───────────────────────────────┐
 *   │  Borrower · N properties · £ facility · LTV%             │
 *   └──────────────────────────────────────────────────────────┘
 *   ┌── Primary dropzone ──────────────────────────────────────┐
 *   │  📁 Drop your deal pack — PDF / Word / Excel / images    │
 *   │  Parser fills term, exit, charges, borrower people…      │
 *   └──────────────────────────────────────────────────────────┘
 *   "Don't have a pack? Fill in the matrix manually →"
 *
 * Both paths land on the matrix (screen-deal-detail) which is the
 * canonical edit surface. Manual path = click the link, drop path =
 * upload completes → uploadDealFiles auto-redirects to deal detail.
 */
import { API_BASE } from './config.js';
import { showScreen, showToast, sanitizeHtml, formatNumber } from './utils.js';
import { fetchWithAuth, getCurrentUser, getCurrentRole } from './auth.js';
import { setCurrentDealId } from './state.js';
import { uploadDealFiles } from './documents.js';

let _qqContext = null; // { qqId, dealId, submissionId } — kept so the manual fallback works

/**
 * Public entry point. Called from quick-quote.js after convert-to-deal succeeds.
 */
export async function showCompleteDeal({ qqId, dealId, submissionId }) {
  if (!dealId || !submissionId) {
    showToast('Could not load your deal — please refresh', true);
    return;
  }
  _qqContext = { qqId, dealId, submissionId };
  // Critical: set currentDealId so uploadDealFiles knows where the bytes go
  setCurrentDealId(dealId);

  // User strip
  const u = getCurrentUser();
  const r = getCurrentRole();
  const userInfo = document.getElementById('cd-user-info');
  if (userInfo && u) {
    userInfo.textContent = `${sanitizeHtml(u.first_name)} ${sanitizeHtml(u.last_name)} (${sanitizeHtml(r || 'broker')})`;
  }

  // Default summary while we fetch
  const sumEl = document.getElementById('cd-summary-body');
  if (sumEl) sumEl.innerHTML = '<div style="color:#94A3B8;font-size:13px;">Loading your quote…</div>';

  showScreen('screen-complete-deal');

  // Fetch QQ row + render summary
  if (qqId) {
    try {
      const r = await fetchWithAuth(`${API_BASE}/api/broker/quick-quote/${qqId}`);
      const data = await r.json();
      if (r.ok && data && data.ok && data.quote) {
        renderSummary(data.quote);
      } else {
        // Non-fatal — show minimal summary using submission_id
        if (sumEl) sumEl.innerHTML = `<div style="color:#94A3B8;font-size:13px;">Deal <strong style="color:#F1F5F9;">${sanitizeHtml(submissionId.substring(0, 8))}</strong> created. Drop your deal pack below to fill in the rest.</div>`;
      }
    } catch (err) {
      console.warn('[complete-deal] summary fetch failed:', err.message);
      if (sumEl) sumEl.innerHTML = `<div style="color:#94A3B8;font-size:13px;">Deal <strong style="color:#F1F5F9;">${sanitizeHtml(submissionId.substring(0, 8))}</strong> created. Drop your deal pack below.</div>`;
    }
  }
}

function renderSummary(quote) {
  const sumEl = document.getElementById('cd-summary-body');
  if (!sumEl) return;

  const props = (quote.results_jsonb && Array.isArray(quote.results_jsonb.properties))
    ? quote.results_jsonb.properties : [];

  const totalAvm = props.reduce((acc, p) => acc + (Number(p.avm_pence) || 0), 0);
  const acquisitionLoan = Number(quote.loan_amount_pence) || 0;
  const refiTotal = props.reduce((acc, p) => acc + (Number(p.existing_charge_balance_pence) || 0), 0);
  const totalFacility = acquisitionLoan + refiTotal;
  const ltv = (totalAvm > 0 && totalFacility > 0)
    ? ((totalFacility / totalAvm) * 100).toFixed(1)
    : (quote.ltv_pct != null ? Number(quote.ltv_pct).toFixed(1) : null);

  const company = quote.company_name || quote.company_number || 'Borrower pending';
  const propWord = props.length === 1 ? 'property' : 'properties';
  const facilityStr = totalFacility ? `£${formatNumber(Math.round(totalFacility / 100))}` : '£—';
  const ltvStr = ltv ? `${ltv}% LTV` : '';

  // Top headline strip
  let html = `
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;font-size:14px;color:#F1F5F9;">
      <strong style="color:#D4A853;font-size:15px;">${sanitizeHtml(company)}</strong>
      <span style="color:#94A3B8;">·</span>
      <span>${props.length} ${propWord}</span>
      <span style="color:#94A3B8;">·</span>
      <span>${facilityStr} facility</span>
      ${ltvStr ? `<span style="color:#94A3B8;">·</span><span style="color:${parseFloat(ltv) > 75 ? '#F59E0B' : '#10B981'};">${ltvStr}</span>` : ''}
    </div>
  `;

  // Per-property mini-list
  if (props.length > 0) {
    html += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">';
    props.forEach((p) => {
      const addr = p.address_text || p.postcode || 'Address pending';
      const purpose = p.purpose === 'refinance' ? 'Refi' : p.purpose === 'equity_release' ? 'Equity release' : 'Acquisition';
      const avm = p.avm_pence ? `£${formatNumber(Math.round(p.avm_pence / 100))}` : '£—';
      html += `
        <div style="display:flex;align-items:center;gap:10px;font-size:12px;color:#CBD5E1;">
          <span style="color:#64748B;">▸</span>
          <span style="flex:1;">${sanitizeHtml(addr)}</span>
          <span style="color:#94A3B8;font-size:11px;">${purpose}</span>
          <span style="color:#F1F5F9;font-weight:600;">${avm}</span>
        </div>
      `;
    });
    html += '</div>';
  }

  sumEl.innerHTML = html;
}

/* ── Dropzone handlers (cd_ prefix to avoid collision with existing upload-zone in screen-deal-detail) ── */

export function cdHandleDragOver(e) {
  e.preventDefault();
  const z = document.getElementById('cd-upload-zone');
  if (z) z.style.background = '#1f2d44';
}

export function cdHandleDragLeave(e) {
  e.preventDefault();
  const z = document.getElementById('cd-upload-zone');
  if (z) z.style.background = '#0F172A';
}

export function cdHandleDrop(e) {
  e.preventDefault();
  const z = document.getElementById('cd-upload-zone');
  if (z) z.style.background = '#0F172A';
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) uploadDealFiles(files);
}

export function cdHandleFileSelect(e) {
  const files = e.target && e.target.files;
  if (files && files.length) uploadDealFiles(files);
}

/**
 * "Fill manually" fallback — skip the dropzone, open the matrix directly.
 * The deal already has loan_amount, properties, and borrower from the QQ
 * conversion, so the matrix is the right edit surface (not the wizard).
 */
export function cdFillManually() {
  if (!_qqContext || !_qqContext.dealId) {
    showToast('No deal context — please re-open from your dashboard', true);
    return;
  }
  // Lazy-load the matrix entry point so we don't pay its cost up front
  import('./deal-detail.js').then((m) => {
    if (m && typeof m.showDealDetail === 'function') {
      m.showDealDetail(_qqContext.dealId);
    } else {
      showToast('Matrix view unavailable — please refresh', true);
    }
  }).catch((err) => {
    console.error('[complete-deal] matrix load failed:', err);
    showToast('Could not open the matrix — please refresh', true);
  });
}
