/**
 * Deal Information Matrix Module
 * Renders a comprehensive deal tracking matrix with sections, collapsible fields, and document management
 * Production-ready ES6 module for Daksfirst lending portal
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getCurrentRole } from './state.js';
import { floatingProgress } from './floating-progress.js';
import { renderFullVerification } from './companies-house.js';
import { showDealDetail } from './deal-detail.js';

// ── Refresh the current deal in-place without kicking back to the dashboard ──
// Preserves section expand state and scroll position.
// Falls back to window.location.reload() if showDealDetail can't resolve (defensive).
async function _refreshDealInPlace(submissionId) {
  try {
    if (typeof showDealDetail === 'function' && submissionId) {
      // Capture which sections are currently expanded (body-{id} without .collapsed class)
      const expandedSections = [];
      document.querySelectorAll('[id^="body-"]').forEach(el => {
        if (!el.classList.contains('collapsed')) {
          expandedSections.push(el.id.replace(/^body-/, ''));
        }
      });
      const scrollY = window.scrollY || window.pageYOffset || 0;

      await showDealDetail(submissionId);

      // Restore expand state + scroll after the new DOM settles
      setTimeout(() => {
        for (const id of expandedSections) {
          const body = document.getElementById('body-' + id);
          const chevron = document.getElementById('chev-' + id);
          if (body && body.classList.contains('collapsed')) {
            body.classList.remove('collapsed');
            if (chevron) chevron.classList.add('open');
          }
        }
        if (scrollY) window.scrollTo({ top: scrollY, behavior: 'instant' });
      }, 60);
      return;
    }
  } catch (err) {
    console.warn('[refresh] showDealDetail failed, falling back to reload:', err);
  }
  window.location.reload();
}

// ═══════════════════════════════════════════════════════════════════
// EDITABLE FIELD HELPER — renders input for editable roles, static text for read-only
// ═══════════════════════════════════════════════════════════════════

const EDITABLE_ROLES = ['broker', 'borrower', 'rm', 'admin'];
const inputStyle = 'width:100%;padding:10px 14px;border:1px solid rgba(255,255,255,0.06);border-radius:6px;font-size:14px;color:#F1F5F9;background:#0f1729;transition:border-color .15s;outline:none;font-family:inherit;';
const inputFocusClass = 'matrix-editable';
const readonlyStyle = 'font-size:14px;color:#F1F5F9;padding:8px 0;';
const labelStyle = 'font-size:12px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:5px';

// Format number with commas: 1500000 → "1,500,000"
function formatWithCommas(val) {
  if (!val && val !== 0) return '';
  const num = String(val).replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (!num || isNaN(num)) return String(val);
  const parts = num.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// Strip commas for saving: "1,500,000" → "1500000"
function stripCommas(val) {
  return String(val || '').replace(/,/g, '');
}

// Validation rules per input type
const FIELD_VALIDATORS = {
  money: { regex: /^[\d,]+\.?\d{0,2}$/, msg: 'Enter a valid amount (e.g. 1,500,000)' },
  number: { regex: /^[\d,]+\.?\d*$/, msg: 'Enter a valid number' },
  email: { regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'Enter a valid email address' },
  tel: { regex: /^[\d\s\+\-\(\)]{7,20}$/, msg: 'Enter a valid phone number' },
  date: { regex: /^\d{4}-\d{2}-\d{2}$/, msg: 'Enter date as YYYY-MM-DD' },
  percentage: { regex: /^\d{1,3}(\.\d{1,2})?$/, msg: 'Enter a valid percentage (e.g. 2.5)' }
};

function renderEditableField(dbField, label, value, inputType, canEdit, options) {
  let safeVal = sanitizeHtml(String(value || ''));
  // Date inputs require yyyy-MM-dd — strip ISO time portion if present
  if (inputType === 'date' && safeVal && safeVal.includes('T')) {
    safeVal = safeVal.split('T')[0];
  }
  const id = `mf-${dbField}`;
  const isMoney = inputType === 'money' || inputType === 'number';
  const displayVal = isMoney ? formatWithCommas(safeVal) : safeVal;

  if (!canEdit) {
    // Read-only display — include hidden input so fieldHasValue() works for readiness %
    if (inputType === 'select' && options) {
      const selected = options.find(o => o.value === value);
      return `<div style="margin-bottom:12px">
        <label style="${labelStyle}">${sanitizeHtml(label)}</label>
        <input type="hidden" id="${id}" value="${safeVal}">
        <div style="${readonlyStyle}">${sanitizeHtml(selected ? selected.label : value || '—')}</div>
      </div>`;
    }
    return `<div style="margin-bottom:12px">
      <label style="${labelStyle}">${sanitizeHtml(label)}</label>
      <input type="hidden" id="${id}" value="${safeVal}">
      <div style="${readonlyStyle}">${isMoney && safeVal ? '£' + formatWithCommas(safeVal) : (safeVal || '—')}</div>
    </div>`;
  }

  // Editable input
  if (inputType === 'select' && options) {
    const optHtml = options.map(o => `<option value="${sanitizeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${sanitizeHtml(o.label)}</option>`).join('');
    return `<div style="margin-bottom:12px">
      <label style="${labelStyle}" for="${id}">${sanitizeHtml(label)}</label>
      <select id="${id}" data-field="${dbField}" class="${inputFocusClass}" style="${inputStyle}cursor:pointer;" onchange="window.matrixSaveField('${dbField}', this.value)">
        <option value="">— Select —</option>${optHtml}
      </select>
    </div>`;
  }

  if (inputType === 'textarea') {
    return `<div style="margin-bottom:12px">
      <label style="${labelStyle}" for="${id}">${sanitizeHtml(label)}</label>
      <textarea id="${id}" data-field="${dbField}" class="${inputFocusClass}" style="${inputStyle}min-height:80px;resize:vertical;" onblur="window.matrixValidateAndSave('${dbField}', this.value, 'text')">${safeVal}</textarea>
    </div>`;
  }

  if (isMoney) {
    // Money/number field — shows commas while typing, saves raw number
    return `<div style="margin-bottom:12px">
      <label style="${labelStyle}" for="${id}">${sanitizeHtml(label)}</label>
      <input id="${id}" type="text" inputmode="numeric" data-field="${dbField}" data-type="money" class="${inputFocusClass}" style="${inputStyle}" value="${displayVal}" placeholder="e.g. 1,500,000"
        oninput="this.value=this.value.replace(/[^0-9.,]/g,'')"
        onfocus="this.select()"
        onblur="window.matrixValidateAndSave('${dbField}', this.value, 'money')" />
      <div id="err-${dbField}" style="font-size:10px;color:#F87171;margin-top:2px;display:none;"></div>
    </div>`;
  }

  const typeAttr = inputType || 'text';
  const placeholder = inputType === 'date' ? 'YYYY-MM-DD' : '';
  const dataType = inputType === 'email' ? 'email' : inputType === 'tel' ? 'tel' : inputType === 'date' ? 'date' : 'text';

  return `<div style="margin-bottom:12px">
    <label style="${labelStyle}" for="${id}">${sanitizeHtml(label)}</label>
    <input id="${id}" type="${typeAttr}" data-field="${dbField}" data-type="${dataType}" class="${inputFocusClass}" style="${inputStyle}" value="${safeVal}" placeholder="${placeholder}"
      onblur="window.matrixValidateAndSave('${dbField}', this.value, '${dataType}')" />
    <div id="err-${dbField}" style="font-size:10px;color:#F87171;margin-top:2px;display:none;"></div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - Pill Rendering
// ═══════════════════════════════════════════════════════════════════

const pillStyles = {
  'not-required': 'background:rgba(255,255,255,0.03);color:#64748B;border:1px solid rgba(255,255,255,0.06)',
  'not-started': 'background:rgba(255,255,255,0.03);color:#64748B;border:1px solid rgba(255,255,255,0.06)',
  'submitted': 'background:rgba(212,168,83,0.15);color:#E8C97A;border:1px solid rgba(212,168,83,0.25)',
  'under-review': 'background:rgba(251,191,36,0.1);color:#FBBF24;border:1px solid rgba(251,191,36,0.2)',
  'approved': 'background:rgba(52,211,153,0.1);color:#34D399;border:1px solid rgba(52,211,153,0.2)',
  'finalized': 'background:#34D399;color:#0B1120;border:1px solid #34D399',
  'locked': 'background:#111827;color:#64748B;border:1px solid rgba(255,255,255,0.06)',
  'evidenced': 'background:rgba(212,168,83,0.15);color:#E8C97A;border:1px solid rgba(212,168,83,0.25)',
  'signed': 'background:#34D399;color:#0B1120;border:1px solid #34D399',
  'awaiting-signature': 'background:rgba(212,168,83,0.15);color:#E8C97A;border:1px solid rgba(212,168,83,0.25)',
  'superseded': 'background:rgba(255,255,255,0.03);color:#64748B;border:1px solid rgba(255,255,255,0.06);font-size:8px',
  'overdue': 'background:rgba(248,113,113,0.1);color:#F87171;border:1px solid rgba(248,113,113,0.2);animation:prd 2s ease-in-out infinite',
  'issued': 'background:rgba(212,168,83,0.15);color:#E8C97A;border:1px solid rgba(212,168,83,0.25)'
};

/**
 * Generate inline pill HTML with status styling
 */
function renderPill(status, label = null, icon = '') {
  const displayLabel = label || status.replace(/-/g, ' ').toLowerCase();
  const style = pillStyles[status] || pillStyles['not-started'];
  return `<span style="display:inline-flex;align-items:center;gap:2px;padding:3px 8px;border-radius:5px;font-size:9px;font-weight:600;white-space:nowrap;cursor:pointer;transition:transform .1s,box-shadow .1s;${style}" onclick="if(this.dataset.clickable) window.matrixUpdateFieldStatus && window.matrixUpdateFieldStatus('${status}')">
    ${icon ? icon + ' ' : ''}${sanitizeHtml(displayLabel)}
  </span>`;
}

/**
 * Generate status summary dot for section header
 */
function renderStatusDot(count, status, dotId) {
  const colorMap = {
    'approved': 'rgba(52,211,153,0.1)', 'complete': 'rgba(52,211,153,0.1)',
    'finalized': '#34D399', 'signed': '#34D399',
    'submitted': 'rgba(212,168,83,0.15)',
    'under-review': 'rgba(251,191,36,0.1)', 'incomplete': 'rgba(251,191,36,0.1)',
    'not-started': 'rgba(255,255,255,0.03)', 'not-required': 'rgba(255,255,255,0.03)'
  };
  const color = colorMap[status] || 'rgba(255,255,255,0.03)';
  const textColor = status === 'finalized' || status === 'signed' ? '#0B1120' : (status === 'approved' || status === 'complete') ? '#34D399' : status === 'incomplete' || status === 'under-review' ? '#FBBF24' : '#64748B';
  const idAttr = dotId ? ` id="${dotId}"` : '';
  return `<div${idAttr} style="width:20px;height:20px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;background:${color};color:${textColor}">${count > 0 ? count : '—'}</div>`;
}

/**
 * Generate field row with status pills across stages
 */
function renderFieldRow(fieldKey, fieldName, fieldDesc, statuses, isConditional = false, isActive = false, canEdit = false) {
  const conditionalClass = isConditional ? 'margin-left:16px' : '';
  const activeBackground = isActive ? 'background:rgba(212,168,83,0.15)' : '';
  const prefix = isConditional ? '↳ ' : '';

  return `
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));border-top:1px solid rgba(255,255,255,0.04);transition:background .1s;cursor:pointer;${activeBackground}" onclick="window.matrixToggleDetail && window.matrixToggleDetail('detail-${fieldKey}')">
      <div style="padding:8px 12px 8px 50px;display:flex;align-items:center;gap:6px;${conditionalClass}">
        <span style="font-size:12px;width:16px;text-align:center;flex-shrink:0;font-weight:700">L</span>
        <div>
          <div style="font-size:11px;font-weight:500;color:#F1F5F9">${prefix}${sanitizeHtml(fieldName)}</div>
          <span style="font-size:9px;color:#94A3B8;font-weight:400;display:block">${sanitizeHtml(fieldDesc)}</span>
        </div>
      </div>
      ${statuses.map((status, idx) => `
        <div style="padding:8px 5px;display:flex;align-items:center;justify-content:center;${idx === 0 ? 'background:rgba(212,168,83,0.15)' : ''}">
          <span id="${idx === 0 ? 'dip-fpill-' + fieldKey : ''}" data-dip-pill="${idx === 0 ? fieldKey : ''}">${renderPill(status)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Generate collapsible section header
 */
function renderSectionHeader(sectionId, iconInitial, title, subtitle, statusDots, showRequestInfo = false) {
  // Map icon initials to styles
  const iconStyles = {
    'DM': { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' },
    'B': { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' },
    'F': { bg: 'rgba(212,168,83,0.15)', color: '#D4A853' },
    'P': { bg: 'rgba(52,211,153,0.1)', color: '#34D399' },
    'L': { bg: 'rgba(168,85,247,0.1)', color: '#A855F7' },
    'E': { bg: 'rgba(251,146,60,0.1)', color: '#FB923C' },
    'LG': { bg: 'rgba(148,163,184,0.1)', color: '#94A3B8' },
    'C': { bg: 'rgba(212,168,83,0.15)', color: '#D4A853' },
    'D': { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' }
  };
  const style = iconStyles[iconInitial] || { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' };

  const requestInfoBtn = showRequestInfo
    ? `<button onclick="event.stopPropagation(); window.matrixSendInfoRequest('${sectionId}')" style="padding:3px 8px;border-radius:4px;font-size:9px;font-weight:600;border:1px solid rgba(251,191,36,0.3);background:rgba(251,191,36,0.1);color:#FBBF24;cursor:pointer;margin-left:8px;white-space:nowrap;">Request Info</button>`
    : '';

  return `
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));cursor:pointer;user-select:none;transition:background .12s;border-bottom:1px solid rgba(255,255,255,0.06)" onclick="window.matrixToggleSection && window.matrixToggleSection('${sectionId}')" data-section-header="${sectionId}">
      <div style="padding:11px 12px 11px 26px;display:flex;align-items:center;gap:8px">
        <div id="chevron-${sectionId}" style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);border-radius:5px;font-size:9px;color:#94A3B8;transition:transform .2s,background .2s;flex-shrink:0;transform:rotate(0deg)">▸</div>
        <div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:${style.bg};border-radius:6px;font-size:12px;font-weight:700;color:${style.color};flex-shrink:0">${iconInitial}</div>
        <span style="font-size:12px;font-weight:700;color:#F1F5F9">${sanitizeHtml(title)}</span>
        <span style="font-size:9px;color:#94A3B8;font-weight:400;margin-left:5px">${sanitizeHtml(subtitle)}</span>
        ${requestInfoBtn}
      </div>
      ${statusDots.map(dot => `<div style="padding:11px 6px;display:flex;align-items:center;justify-content:center">${dot}</div>`).join('')}
    </div>
  `;
}

/**
 * Generate document detail panel
 */
function renderDocumentDetailPanel(docId, docData, documentTrail = []) {
  const role = getCurrentRole();
  const canVerify = ['admin', 'rm', 'credit', 'compliance'].includes(role);

  const statusBg = docData.status === 'signed' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)';
  const statusColor = docData.status === 'signed' ? '#34D399' : '#F87171';

  return `
    <div style="padding:8px 26px 14px 50px">
      <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700;color:#F1F5F9">${sanitizeHtml(docData.name || 'Document')}</div>
          <div style="font-size:8px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px">${docData.status || 'pending'}</div>
        </div>

        <div style="display:flex;align-items:center;gap:0;margin-bottom:12px;flex-wrap:wrap">
          ${(documentTrail || []).map((stage, idx) => `
            <div style="display:flex;align-items:center;gap:3px;padding:4px 8px;font-size:9px;font-weight:600;border-radius:5px;${stage.completed ? 'background:rgba(52,211,153,0.1);color:#34D399' : 'background:rgba(212,168,83,0.15);color:#E8C97A'}">
              ${stage.completed ? '✓' : '●'} ${sanitizeHtml(stage.label)}
            </div>
            ${idx < documentTrail.length - 1 ? '<span style="color:rgba(255,255,255,0.06);font-size:12px;margin:0 3px">→</span>' : ''}
          `).join('')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:9px;margin-bottom:10px">
          <div><span style="color:#94A3B8">Issued:</span> ${docData.issued_at ? new Date(docData.issued_at).toLocaleDateString() : 'N/A'}</div>
          <div><span style="color:#94A3B8">Reference:</span> ${sanitizeHtml(docData.reference || 'N/A')}</div>
        </div>

        ${canVerify ? `
          <div style="display:flex;gap:6px;margin-top:10px">
            <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.06);background:#111827;color:#F1F5F9;cursor:pointer;transition:all .12s" onclick="window.matrixVerifyDocument && window.matrixVerifyDocument('${docId}')">Verify</button>
            <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.06);background:#D4A853;color:#0B1120;cursor:pointer;transition:all .12s" onclick="window.matrixSendInfoRequest && window.matrixSendInfoRequest('documents')">Request Info</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// FINANCIAL SCHEDULE TABLE RENDERER
// ═══════════════════════════════════════════════════════════════════

const FREQ_LABELS = { one_off: 'One-off', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };
const CAT_LABELS = { asset: 'Asset', liability: 'Liability', income: 'Income', expense: 'Expense' };
const CAT_EXAMPLES = {
  asset: 'e.g. Buy-to-let portfolio, ISA, pension fund, vehicle',
  liability: 'e.g. Mortgage on 123 High St, credit card balance, director\'s loan',
  income: 'e.g. Salary from XYZ Ltd, rental income, dividends',
  expense: 'e.g. Mortgage payment, council tax, school fees'
};

function _renderFinancialTable(deal, category, canEdit) {
  const items = (deal.financials || []).filter(f => f.category === category);
  if (items.length === 0) {
    return `<p style="font-size:12px;color:#6B7280;margin:0;">No ${CAT_LABELS[category]?.toLowerCase() || category}s added yet. ${canEdit ? `Use the "+ Add ${CAT_LABELS[category]}" button above.` : ''}</p>`;
  }

  const totalAmt = items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

  return `
    <div style="margin-bottom:8px;">
      <span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${CAT_LABELS[category]} Schedule — ${items.length} ${items.length === 1 ? 'Item' : 'Items'} — Total: £${totalAmt.toLocaleString()}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:rgba(255,255,255,0.04);">
          <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Description</th>
          <th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Amount (£)</th>
          <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Frequency</th>
          <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Holder / Lender</th>
          <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Source</th>
          ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${items.map(f => {
          const srcColor = f.source === 'parsed' ? '#818CF8' : '#94A3B8';
          const srcBg = f.source === 'parsed' ? 'rgba(129,140,248,0.1)' : 'rgba(255,255,255,0.04)';
          return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);" id="fin-row-${f.id}">
            <td style="padding:6px 8px;color:#F1F5F9;font-weight:500;">${sanitizeHtml(f.description || '-')}</td>
            <td style="padding:6px 8px;color:#F1F5F9;text-align:right;font-variant-numeric:tabular-nums;">${f.amount ? parseFloat(f.amount).toLocaleString() : '—'}</td>
            <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${FREQ_LABELS[f.frequency] || f.frequency || '—'}</td>
            <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(f.holder || '—')}</td>
            <td style="padding:6px 8px;"><span style="padding:2px 6px;border-radius:10px;font-size:9px;font-weight:600;background:${srcBg};color:${srcColor};text-transform:capitalize;">${f.source || 'manual'}</span></td>
            ${canEdit ? `<td style="padding:6px 8px;text-align:center;white-space:nowrap;">
              <button onclick="window.editFinancialRow(${f.id}, '${deal.submission_id}', '${category}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>
              <button onclick="window.deleteFinancialRow(${f.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>
            </td>` : ''}
          </tr>`}).join('')}
      </tbody>
    </table>`;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN RENDER FUNCTION
// ═══════════════════════════════════════════════════════════════════

export async function renderDealMatrix(deal) {
  if (!deal || !deal.submission_id) {
    showToast('Invalid deal data', 'error');
    return;
  }

  // Fetch matrix data from API
  let matrixData = {
    sections: {}
  };

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/matrix/${deal.submission_id}/matrix-summary`);
    if (response.ok) {
      matrixData = await response.json();
    }
  } catch (error) {
    console.log('Matrix data not yet available, using defaults');
  }

  const container = document.getElementById('dtab-matrix-content');
  if (!container) {
    showToast('Matrix container not found', 'error');
    return;
  }

  const role = getCurrentRole();
  const isInternalUser = ['admin', 'rm', 'credit', 'compliance'].includes(role);
  const currentStage = deal.deal_stage || 'received';

  // Brokers can edit during draft and received stages (before submission to RM)
  // After submission (info_gathering+), broker Matrix is read-only — RM/admin can still edit
  const brokerEditableStages = ['draft', 'received'];
  const canEdit = isInternalUser
    ? EDITABLE_ROLES.includes(role)
    : (EDITABLE_ROLES.includes(role) && brokerEditableStages.includes(currentStage));

  // Safe number helpers
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? num(v).toLocaleString() : '0';
  const fmtPct = (v) => num(v) ? num(v).toFixed(1) : '0.0';
  const fmtM = (v) => num(v) ? (num(v) / 1000000).toFixed(1) : '0';

  // Portfolio totals — sum across all properties, fallback to flat deal fields
  const portfolioValuation = () => {
    if (deal.properties && deal.properties.length > 0) {
      return deal.properties.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0);
    }
    return parseFloat(deal.current_value) || 0;
  };
  const portfolioPurchasePrice = () => {
    if (deal.properties && deal.properties.length > 0) {
      return deal.properties.reduce((sum, p) => sum + (parseFloat(p.purchase_price) || 0), 0);
    }
    return parseFloat(deal.purchase_price) || 0;
  };

  // Section visibility gating — brokers only see sections relevant to their deal stage
  // DIP stage: S1 (Borrower), S3 (Property), S4 (Loan), S5 (Exit) — the basics to price a deal
  // Post-termsheet: additionally S2 (Financials/AML), S6 (Legal/Insurance)
  // Internal team: always sees everything
  const dipStages = ['draft', 'received', 'assigned', 'info_gathering', 'dip_issued'];
  const isDIPStage = dipStages.includes(currentStage);
  const postTermsheet = !isDIPStage; // ai_termsheet, fee_pending, fee_paid, underwriting, etc.
  const showFinancialsAML = isInternalUser || postTermsheet;    // S2
  const showLegalInsurance = isInternalUser || postTermsheet;    // S6
  const showCommercial = isInternalUser;                         // S7 — fees are RM/admin only
  const showDocsIssued = isInternalUser || postTermsheet;        // S8

  // Stage mapping — deal_stage values from DB to matrix column index
  // info_gathering is still DIP phase (RM gathering data before DIP complete)
  const stageIndex = {
    'draft': 0, 'received': 0, 'assigned': 0, 'dip_issued': 0, 'info_gathering': 0,
    'ai_termsheet': 1,
    'fee_pending': 2, 'fee_paid': 2, 'underwriting': 2,
    'bank_submitted': 2, 'bank_approved': 2,
    'borrower_accepted': 3, 'legal_instructed': 3, 'completed': 3
  };
  const currentStageIdx = stageIndex[currentStage] ?? 0;

  // ═══════════════════════════════════════════════════════════════════
  // HEADER & CONTEXT SECTION
  // ═══════════════════════════════════════════════════════════════════

  let html = `
    <!-- Context Bar -->
    <div style="padding:12px 26px;background:#1a2332;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;gap:20px;flex-wrap:wrap;align-items:center">
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">Borrower</span>
        <span style="font-size:12px;font-weight:600;color:#F1F5F9">${sanitizeHtml(deal.borrower_name || 'N/A')}</span>
      </div>
      <div style="width:1px;height:24px;background:rgba(255,255,255,0.06)"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">Type</span>
        <span style="font-size:12px;font-weight:600;color:#F1F5F9">${sanitizeHtml(deal.borrower_type || 'Individual')}</span>
      </div>
      <div style="width:1px;height:24px;background:rgba(255,255,255,0.06)"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">Loan</span>
        <span style="font-size:12px;font-weight:600;color:#F1F5F9">£${fmtMoney(deal.loan_amount)}</span>
      </div>
      <div style="width:1px;height:24px;background:rgba(255,255,255,0.06)"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">LTV</span>
        <span style="font-size:12px;font-weight:600;color:#F1F5F9">${fmtPct(deal.ltv_requested)}%</span>
      </div>
      <div style="width:1px;height:24px;background:rgba(255,255,255,0.06)"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">Security</span>
        <span style="font-size:12px;font-weight:600;color:#F1F5F9" title="${sanitizeHtml(deal.security_address || 'N/A')}">${(() => {
          const addr = deal.security_address || 'N/A';
          const pc = deal.security_postcode || '';
          const parts = addr.split(';').map(s => s.trim()).filter(Boolean);
          const count = parts.length;
          // Extract a short location: use postcode, or last meaningful part of address
          const shortLoc = pc || (parts[0] ? parts[0].split(',').pop().trim() : 'N/A');
          if (count > 1) return sanitizeHtml(shortLoc + ' (' + count + ' properties)');
          return sanitizeHtml(shortLoc);
        })()}</span>
      </div>
      <div style="width:1px;height:24px;background:rgba(255,255,255,0.06)"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94A3B8">Stage</span>
        <span style="font-size:12px;font-weight:600;color:#D4A853">${sanitizeHtml(currentStage.replace(/_/g, ' ').toUpperCase())}</span>
      </div>
    </div>

    <!-- Progress Bars — only show the current stage bar, hide future stages -->
    <div id="matrix-tier-bars" style="padding:12px 26px 16px;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="display:flex;align-items:center;gap:10px;margin-top:0">
        <span style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;min-width:82px">DIP</span>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
          <div id="tier-bar-dip-fill" style="height:100%;border-radius:99px;width:0%;background:linear-gradient(90deg,#D4A853,#E8C97A);transition:width .5s ease"></div>
        </div>
        <span id="tier-bar-dip-pct" style="color:#D4A853;font-size:12px;font-weight:600">0%</span>
      </div>
      ${currentStageIdx >= 1 ? `
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Indicative TS</span>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
          <div id="tier-bar-its-fill" style="height:100%;border-radius:99px;width:0%;background:linear-gradient(90deg,#D4A853,#E8C97A);transition:width .5s ease"></div>
        </div>
        <span id="tier-bar-its-pct" style="color:#D4A853;font-size:12px;font-weight:600">0%</span>
      </div>` : ''}
      ${currentStageIdx >= 2 ? `
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Formal Offer</span>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
          <div id="tier-bar-formal-fill" style="height:100%;border-radius:99px;width:0%;background:linear-gradient(90deg,#34D399,#34D399);transition:width .5s ease"></div>
        </div>
        <span id="tier-bar-formal-pct" style="color:#34D399;font-size:12px;font-weight:600">0%</span>
      </div>` : ''}
      ${currentStageIdx >= 3 ? `
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Execution</span>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden">
          <div id="tier-bar-exec-fill" style="height:100%;border-radius:99px;width:0%;background:linear-gradient(90deg,#94A3B8,#94A3B8);transition:width .5s ease"></div>
        </div>
        <span id="tier-bar-exec-pct" style="color:#94A3B8;font-size:12px;font-weight:600">0%</span>
      </div>` : ''}
    </div>

    <!-- SUBMIT FOR REVIEW — prominent CTA for brokers -->
    ${!isInternalUser && currentStage === 'received' ? `
    <div id="matrix-submit-cta" style="padding:14px 26px;background:rgba(52,211,153,0.1);border-bottom:2px solid rgba(52,211,153,0.2);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:14px;font-weight:700;color:#34D399;">Ready to submit?</div>
          <div style="font-size:11px;color:#34D399;margin-top:2px;margin-bottom:10px;">Complete the required fields below, then submit for RM review to proceed to DIP.</div>
          <div id="dip-readiness-checklist" style="display:flex;flex-direction:column;gap:3px;"></div>
        </div>
        <button onclick="window.matrixSubmitForReview && window.matrixSubmitForReview()" style="padding:10px 28px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#64748B;color:#F1F5F9;box-shadow:0 2px 8px rgba(212,168,83,.3);transition:all .15s;white-space:nowrap;opacity:0.5;" disabled onmouseover="if(!this.disabled)this.style.background='#94A3B8'" onmouseout="if(!this.disabled)this.style.background='#34D399'">
          Submit for RM Review &#8594;
        </button>
      </div>
    </div>
    ` : ''}
    ${!isInternalUser && currentStage !== 'received' ? `
    <div style="padding:10px 26px;background:rgba(212,168,83,0.1);border-bottom:2px solid rgba(212,168,83,0.2);text-align:center;">
      <span style="font-size:12px;font-weight:600;color:#E8C97A;">&#x2713; Deal submitted for review — Matrix is read-only</span>
    </div>
    ` : ''}

    <!-- Column Headers -->
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));border-bottom:2px solid rgba(255,255,255,0.06);position:sticky;top:0;background:#0B1120;z-index:20">
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:left;padding-left:26px;color:#94A3B8">Information</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#D4A853;background:rgba(212,168,83,0.15)"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:rgba(212,168,83,0.25);color:#E8C97A">1</span>DIP<span style="font-size:7px;font-weight:800;letter-spacing:1px;color:#D4A853;background:rgba(212,168,83,0.25);padding:1px 5px;border-radius:3px;margin-left:3px;vertical-align:middle">CURRENT</span></div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#E8C97A"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:rgba(212,168,83,0.25);color:#D4A853">2</span>Indicative TS</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#34D399"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:rgba(52,211,153,0.2);color:#34D399">3</span>Formal Offer</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#94A3B8"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:rgba(255,255,255,0.06);color:#F1F5F9">4</span>Execution</div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: BORROWER / KYC
  // ═══════════════════════════════════════════════════════════════════

  // ── Borrower type options for dropdown ──
  const borrowerTypeOpts = [
    { value: 'individual', label: 'Individual' }, { value: 'corporate', label: 'Corporate' },
    { value: 'spv', label: 'SPV' }, { value: 'llp', label: 'LLP' },
    { value: 'trust', label: 'Trust' }, { value: 'partnership', label: 'Partnership' }
  ];

  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s1', 'B', 'Borrower / KYC', 'Comprehensive identity verification', [
        renderStatusDot(0, 'not-started', 'dip-sec-s1'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s1" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Primary Borrower -->
        ${renderFieldRow('primary-borrower', 'Primary Borrower', 'Name, DOB, nationality, address, ID',
          ['not-started', 'not-started', 'locked', 'locked'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-primary-borrower">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">

              ${(() => {
                const isCorporate = ['corporate','spv','ltd','llp'].includes((deal.borrower_type || '').toLowerCase());
                const allBorrowers = deal.borrowers || [];
                // Non-guarantors = primary borrower + its directly linked directors/PSCs.
                // Excludes guarantors AND children of guarantors (those have parent_borrower_id set to a guarantor's id).
                const nonGuarantors = allBorrowers.filter(b => {
                  if (b.role === 'guarantor') return false;
                  // If this row has a parent, check that the parent is not a guarantor
                  if (b.parent_borrower_id) {
                    const parent = allBorrowers.find(p => p.id === b.parent_borrower_id);
                    if (parent && parent.role === 'guarantor') return false;
                  }
                  return true;
                });
                const allChVerified = nonGuarantors.length > 0 && nonGuarantors.every(b => b.ch_verified_at);

                if (isCorporate && deal.company_name) {
                  // ══════════════════════════════════════════════════════════
                  // CORPORATE BORROWER FLOW
                  // ══════════════════════════════════════════════════════════
                  return `
                    <!-- ── A. Corporate Borrower Identity ── -->
                    <div style="background:rgba(212,168,83,0.06);border:1px solid rgba(212,168,83,0.15);border-radius:8px;padding:12px 16px;margin-bottom:12px;">
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div>
                          <div style="font-size:10px;color:#D4A853;text-transform:uppercase;font-weight:600;letter-spacing:.3px;">Primary Borrower (Corporate)</div>
                          <div style="font-size:16px;font-weight:700;color:#F1F5F9;margin-top:3px;">${sanitizeHtml(deal.company_name)}</div>
                          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;">
                            <span style="color:#94A3B8;">Co. No: <strong style="color:#E2E8F0;">${sanitizeHtml(deal.company_number || '—')}</strong></span>
                            <span style="color:#94A3B8;">Type: <strong style="color:#E2E8F0;text-transform:capitalize;">${deal.borrower_type || 'corporate'}</strong></span>
                            <span style="color:#94A3B8;">Jurisdiction: <strong style="color:#E2E8F0;">England & Wales</strong></span>
                          </div>
                        </div>
                        <div style="text-align:right;">
                          ${allChVerified
                            ? '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.1);color:#34D399;">&#10003; CH VERIFIED</span>'
                            : '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(251,191,36,0.1);color:#FBBF24;">UNVERIFIED</span>'
                          }
                        </div>
                      </div>
                    </div>

                    <!-- ── B. Companies House Verification ── -->
                    ${deal.company_number ? `
                    <div style="margin-bottom:12px;">
                      ${allChVerified ? `
                      <div id="ch-verified-summary" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:8px;cursor:pointer;" onclick="window._toggleChVerifiedDetail('${(deal.company_number || '').replace(/'/g, '')}', '${(deal.submission_id || '').replace(/'/g, '')}')">
                        <div style="display:flex;align-items:center;gap:8px;">
                          <span style="color:#34D399;font-size:14px;">&#10003;</span>
                          <span style="font-size:12px;font-weight:700;color:#34D399;">Companies House Verified</span>
                          <span style="font-size:11px;color:#94A3B8;">— All roles confirmed · Click to review</span>
                        </div>
                        <span id="ch-verified-arrow" style="color:#64748B;font-size:10px;transition:transform .2s;">&#9660;</span>
                      </div>
                      <div id="ch-verified-detail" style="max-height:0;overflow:hidden;transition:max-height .35s ease;">
                        <div id="ch-matrix-panel" style="margin-top:8px;"></div>
                        <div id="ch-reconciliation-panel" style="margin-top:8px;"></div>
                      </div>
                      ` : `
                      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                        <button id="ch-matrix-verify-btn" onclick="window._chMatrixVerify('${(deal.company_number || '').replace(/'/g, '')}', '${(deal.submission_id || '').replace(/'/g, '')}')"
                          style="padding:6px 16px;font-size:11px;font-weight:700;background:#D4A853;color:#111;border:none;border-radius:6px;cursor:pointer;">
                          Verify at Companies House
                        </button>
                        <span style="font-size:10px;color:#94A3B8;">Verifies company status, identifies directors, PSCs, and charges</span>
                      </div>
                      <div id="ch-matrix-panel" style="margin-top:8px;"></div>
                      <div id="ch-reconciliation-panel" style="margin-top:8px;"></div>
                      `}
                    </div>
                    ` : ''}

                    <!-- ── C. Connected Individuals (Directors, UBOs, PSCs) ── -->
                    <div style="margin-bottom:4px;">
                      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Directors, UBOs & PSCs — ${nonGuarantors.length} ${nonGuarantors.length === 1 ? 'Person' : 'People'}</span>
                        ${canEdit ? '<button onclick="window.addBorrowerRow(&#39;' + deal.submission_id + '&#39;)" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Person</button>' : ''}
                      </div>
                      ${nonGuarantors.length > 0 ? `
                      <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead>
                          <tr style="background:rgba(255,255,255,0.04);">
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Nationality</th>
                            <th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>
                            <th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">CH</th>
                            ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
                          </tr>
                        </thead>
                        <tbody>
                          ${nonGuarantors.map(b => {
                            const roleColors = { primary:'#34D399', joint:'#34D399', director:'#818CF8', ubo:'#A78BFA', psc:'#38BDF8', shareholder:'#D4A853' };
                            const roleBgs = { primary:'rgba(52,211,153,0.1)', joint:'rgba(52,211,153,0.1)', director:'rgba(129,140,248,0.1)', ubo:'rgba(167,139,250,0.1)', psc:'rgba(56,189,248,0.1)', shareholder:'rgba(212,168,83,0.1)' };
                            const roleColor = roleColors[b.role] || '#94A3B8';
                            const roleBg = roleBgs[b.role] || 'rgba(255,255,255,0.04)';
                            const kycColor = b.kyc_status === 'verified' ? '#34D399' : b.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + b.id + '" onclick="window._toggleBorrowerDetail(' + b.id + ')">' +
                              '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' + sanitizeHtml(b.full_name || '-') + ' <span style="font-size:9px;color:#64748B;text-decoration:none;">&#9660;</span></td>' +
                              '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + roleBg + ';color:' + roleColor + ';text-transform:capitalize;">' + (b.role || 'primary') + '</span></td>' +
                              '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(b.nationality || '—') + '</td>' +
                              '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycColor + ';text-transform:capitalize;">' + (b.kyc_status || 'pending') + '</span></td>' +
                              '<td style="padding:6px 8px;text-align:center;">' + (b.ch_verified_at ? '<span style="font-size:10px;color:#34D399;font-weight:600;">&#10003;</span>' : '<span style="font-size:10px;color:#64748B;">—</span>') + '</td>' +
                              (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
                                '<button onclick="window.editBorrowerRow(' + b.id + ', &#39;' + deal.submission_id + '&#39;)" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
                                '<button onclick="window.deleteBorrowerRow(' + b.id + ', &#39;' + deal.submission_id + '&#39;)" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
                              '</td>' : '') +
                            '</tr>';
                          }).join('')}
                        </tbody>
                      </table>
                      ` : '<p style="font-size:12px;color:#FBBF24;margin:4px 0;">No individuals identified yet. Run Companies House verification or add manually.</p>'}
                    </div>
                  `;
                } else {
                  // ══════════════════════════════════════════════════════════
                  // INDIVIDUAL BORROWER FLOW
                  // ══════════════════════════════════════════════════════════
                  const borrowerList = nonGuarantors;
                  if (borrowerList.length > 0) {
                    return `
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                      <div style="font-size:14px;font-weight:700;color:#F1F5F9">Borrower Details</div>
                      ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : ''}
                    </div>
                    <div style="margin-bottom:4px;">
                      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Borrower Schedule — ${borrowerList.length} ${borrowerList.length === 1 ? 'Party' : 'Parties'}</span>
                        ${canEdit ? '<button onclick="window.addBorrowerRow(&#39;' + deal.submission_id + '&#39;)" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Borrower</button>' : ''}
                      </div>
                      <table style="width:100%;border-collapse:collapse;font-size:12px;">
                        <thead>
                          <tr style="background:rgba(255,255,255,0.04);">
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>
                            <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Email</th>
                            <th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>
                            ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
                          </tr>
                        </thead>
                        <tbody>
                          ${borrowerList.map(b => {
                            const kycColor = b.kyc_status === 'verified' ? '#34D399' : b.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                            const roleColor = b.role === 'primary' ? '#34D399' : b.role === 'joint' ? '#34D399' : '#94A3B8';
                            const roleBg = b.role === 'primary' ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.04)';
                            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + b.id + '" onclick="window._toggleBorrowerDetail(' + b.id + ')">' +
                              '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' + sanitizeHtml(b.full_name || '-') + ' <span style="font-size:9px;color:#64748B;">&#9660;</span></td>' +
                              '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + roleBg + ';color:' + roleColor + ';text-transform:capitalize;">' + (b.role || 'primary') + '</span></td>' +
                              '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(b.email || '-') + '</td>' +
                              '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycColor + ';text-transform:capitalize;">' + (b.kyc_status || 'pending') + '</span></td>' +
                              (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
                                '<button onclick="window.editBorrowerRow(' + b.id + ', &#39;' + deal.submission_id + '&#39;)" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
                                '<button onclick="window.deleteBorrowerRow(' + b.id + ', &#39;' + deal.submission_id + '&#39;)" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
                              '</td>' : '') +
                            '</tr>';
                          }).join('')}
                        </tbody>
                      </table>
                    </div>`;
                  } else {
                    return '';
                  }
                }
              })()}

              ${!(deal.borrowers && deal.borrowers.length > 0) ? `
              <!-- ── No borrowers yet — show flat fields + add button ── -->
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Borrower Details</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : ''}
              </div>
              <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
                <span style="font-size:11px;color:#94A3B8;">${(deal.doc_summary && deal.doc_summary.unparsed > 0) ? 'Borrower details syncing — documents still being parsed.' : (deal.borrower_name ? 'Showing flat borrower fields. Re-parse to populate borrower schedule.' : 'No borrowers added yet.')}</span>
                ${canEdit ? `<button onclick="window.addBorrowerRow('${deal.submission_id}')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Borrower</button>` : ''}
              </div>
              ` : ''}

              <!-- Legacy flat fields — hidden when borrower table exists -->
              <div id="borrower-flat-fields" style="${(deal.borrowers && deal.borrowers.length > 0) ? 'display:none;' : ''}">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                  ${renderEditableField('borrower_type', 'Borrower Type', deal.borrower_type, 'select', canEdit, borrowerTypeOpts)}
                  ${renderEditableField('borrower_name', 'Full Name', deal.borrower_name, 'text', canEdit)}
                  ${renderEditableField('borrower_email', 'Email', deal.borrower_email, 'email', canEdit)}
                  ${renderEditableField('borrower_phone', 'Phone', deal.borrower_phone, 'tel', canEdit)}
                  ${renderEditableField('borrower_dob', 'Date of Birth', deal.borrower_dob, 'date', canEdit)}
                  ${renderEditableField('borrower_nationality', 'Nationality', deal.borrower_nationality, 'text', canEdit)}
                  ${renderEditableField('company_name', 'Company Name', deal.company_name, 'text', canEdit)}
                  ${renderEditableField('company_number', 'Company Number', deal.company_number, 'text', canEdit)}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Guarantor(s) — separate from borrower, supports both corporate and individual deals -->
        ${renderFieldRow('guarantors', 'Guarantor(s)', 'Personal guarantors providing joint & several liability',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-guarantors">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              ${(() => {
                const allB = deal.borrowers || [];
                const _isCorp = (t) => ['corporate','spv','ltd','llp'].includes((t || '').toLowerCase());

                // Top-level guarantors only (parent_borrower_id IS NULL)
                const corpGuarantors = allB.filter(b => !b.parent_borrower_id && b.role === 'guarantor' && _isCorp(b.borrower_type));
                const indGuarantors = allB.filter(b => !b.parent_borrower_id && b.role === 'guarantor' && !_isCorp(b.borrower_type));
                const childrenOf = (pid) => allB.filter(b => b.parent_borrower_id === pid);

                // Count aggregate
                const totalG = corpGuarantors.length + indGuarantors.length;

                // ── Header strip: aggregate ──
                const header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
                  '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:#F1F5F9;">Guarantors</div>' +
                    '<div style="font-size:11px;color:#94A3B8;margin-top:2px;">' + (totalG === 0
                      ? 'No guarantors added yet.'
                      : corpGuarantors.length + ' corporate \u00B7 ' + indGuarantors.length + ' individual') + '</div>' +
                  '</div>' +
                '</div>';

                // ── Corporate Guarantor card renderer ──
                const renderCorpCard = (g) => {
                  const kids = childrenOf(g.id);
                  const chVerified = !!g.ch_verified_at;
                  // Detect if any child matches a primary-borrower director by name (same-person tag)
                  const primaryKids = allB.filter(b => b.parent_borrower_id && b.parent_borrower_id !== g.id);
                  const sameNameIds = new Set(primaryKids.map(p => (p.full_name || '').toLowerCase().trim()).filter(Boolean));

                  const kidsTable = kids.length > 0
                    ? '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">' +
                        '<thead><tr style="background:rgba(255,255,255,0.04);">' +
                          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>' +
                          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>' +
                          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Nationality</th>' +
                          '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>' +
                          '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">CH</th>' +
                          (canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : '') +
                        '</tr></thead><tbody>' +
                        kids.map(k => {
                          const rBg = k.role === 'director' ? 'rgba(129,140,248,0.1)' : k.role === 'psc' ? 'rgba(56,189,248,0.1)' : k.role === 'ubo' ? 'rgba(167,139,250,0.1)' : 'rgba(255,255,255,0.04)';
                          const rCol = k.role === 'director' ? '#818CF8' : k.role === 'psc' ? '#38BDF8' : k.role === 'ubo' ? '#A78BFA' : '#94A3B8';
                          const kycCol = k.kyc_status === 'verified' ? '#34D399' : k.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                          const sameTag = sameNameIds.has((k.full_name || '').toLowerCase().trim())
                            ? ' <span style="font-size:9px;color:#D4A853;background:rgba(212,168,83,0.15);padding:1px 6px;border-radius:8px;margin-left:4px;">Same as Borrower</span>'
                            : '';
                          return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + k.id + '" onclick="window._toggleBorrowerDetail(' + k.id + ')">' +
                            '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' + sanitizeHtml(k.full_name || '-') + ' <span style="font-size:9px;color:#64748B;text-decoration:none;">&#9660;</span>' + sameTag + '</td>' +
                            '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + rBg + ';color:' + rCol + ';text-transform:capitalize;">' + (k.role || 'director') + '</span></td>' +
                            '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(k.nationality || '—') + '</td>' +
                            '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycCol + ';text-transform:capitalize;">' + (k.kyc_status || 'pending') + '</span></td>' +
                            '<td style="padding:6px 8px;text-align:center;">' + (k.ch_verified_at ? '<span style="font-size:10px;color:#34D399;font-weight:600;">&#10003;</span>' : '<span style="font-size:10px;color:#64748B;">—</span>') + '</td>' +
                            (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
                              '<button onclick="window.editBorrowerRow(' + k.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
                              '<button onclick="window.deleteBorrowerRow(' + k.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
                            '</td>' : '') +
                          '</tr>';
                        }).join('') +
                      '</tbody></table>'
                    : '<p style="font-size:11px;color:#FBBF24;margin:6px 0 0 0;">No directors/PSCs captured yet. Add manually or run CH verification (coming).</p>';

                  return '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #818CF8;border-radius:8px;padding:12px 14px;margin-bottom:12px;">' +
                    // Identity card
                    '<div style="background:rgba(129,140,248,0.05);border:1px solid rgba(129,140,248,0.18);border-radius:6px;padding:10px 14px;margin-bottom:10px;">' +
                      '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                        '<div>' +
                          '<div style="font-size:10px;color:#818CF8;text-transform:uppercase;font-weight:700;letter-spacing:.3px;">Corporate Guarantor</div>' +
                          '<div style="font-size:15px;font-weight:700;color:#F1F5F9;margin-top:3px;">' + sanitizeHtml(g.company_name || g.full_name || 'Unnamed') + '</div>' +
                          '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;color:#94A3B8;">' +
                            '<span>Co. No: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.company_number || '—') + '</strong></span>' +
                            '<span>Type: <strong style="color:#E2E8F0;text-transform:capitalize;">' + (g.borrower_type || 'corporate') + '</strong></span>' +
                            (g.jurisdiction ? '<span>Jurisdiction: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.jurisdiction) + '</strong></span>' : '') +
                          '</div>' +
                        '</div>' +
                        '<div style="display:flex;gap:6px;align-items:center;">' +
                          (chVerified
                            ? '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(129,140,248,0.15);color:#818CF8;">&#10003; CH VERIFIED</span>'
                            : '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(251,191,36,0.1);color:#FBBF24;">UNVERIFIED</span>') +
                          (canEdit ? '<button onclick="window.editBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' : '') +
                          (canEdit ? '<button onclick="window.deleteBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove guarantor">\u2715</button>' : '') +
                        '</div>' +
                      '</div>' +
                    '</div>' +
                    // Children block
                    '<div>' +
                      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
                        '<span style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Directors, PSCs &amp; UBOs of ' + sanitizeHtml(g.company_name || 'this guarantor') + ' — ' + kids.length + '</span>' +
                        (canEdit ? '<button onclick="window.addChildToParent(\'' + deal.submission_id + '\', ' + g.id + ')" style="padding:3px 10px;background:#818CF8;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Person</button>' : '') +
                      '</div>' +
                      kidsTable +
                    '</div>' +
                  '</div>';
                };

                // ── Individual Guarantor card renderer (Alessandra-Cenci style 2-col detail) ──
                const fmtDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
                const fieldInline = (label, val, stage) => {
                  const v = val && String(val).trim();
                  return '<div style="margin-bottom:8px;">' +
                    '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
                    (v ? '<div style="font-size:12px;color:#F1F5F9;font-weight:500;">' + sanitizeHtml(String(val)) + '</div>'
                       : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained' + (stage ? ' <span style="font-size:9px;color:#334155;">(' + stage + ')</span>' : '') + '</div>') +
                  '</div>';
                };
                const statusPillInline = (label, status) => {
                  const map = { clear:'#34D399', verified:'#34D399', not_screened:'#64748B', not_obtained:'#64748B', none:'#34D399', flagged:'#F87171', active:'#F87171', undischarged:'#F87171', discharged:'#D4A853', obtained:'#D4A853' };
                  const c = map[status] || '#64748B';
                  const bg = c === '#34D399' ? 'rgba(52,211,153,0.1)' : c === '#F87171' ? 'rgba(248,113,113,0.1)' : c === '#D4A853' ? 'rgba(212,168,83,0.1)' : 'rgba(255,255,255,0.04)';
                  const dstat = status ? String(status).replace(/_/g, ' ') : 'not screened';
                  return '<div style="margin-bottom:8px;">' +
                    '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">' + label + '</div>' +
                    '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + bg + ';color:' + c + ';text-transform:capitalize;">' + dstat + '</span>' +
                  '</div>';
                };
                const renderIndCard = (g) => {
                  const kycCol = g.kyc_status === 'verified' ? '#34D399' : g.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                  const kycLabel = g.kyc_status === 'verified' ? '\u2713 KYC VERIFIED' : (g.kyc_status || 'pending').toUpperCase();
                  const idDocInner = (g.id_type || g.id_number)
                    ? '<div style="font-size:12px;color:#F1F5F9;font-weight:500;text-transform:capitalize;">' + sanitizeHtml((g.id_type || 'ID').replace(/_/g,' ')) + (g.id_number ? ': ' + sanitizeHtml(g.id_number) : '') + '</div>' +
                      (g.id_expiry ? '<div style="font-size:10px;color:#94A3B8;margin-top:1px;">Expires: ' + fmtDate(g.id_expiry) + '</div>' : '')
                    : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(DIP)</span></div>';
                  const creditInner = g.credit_score
                    ? (() => { const sc = g.credit_score >= 700 ? '#34D399' : g.credit_score >= 500 ? '#D4A853' : '#F87171';
                        return '<div style="display:flex;align-items:baseline;gap:6px;">' +
                          '<span style="font-size:18px;font-weight:800;color:' + sc + ';">' + g.credit_score + '</span>' +
                          (g.credit_score_source ? '<span style="font-size:10px;color:#64748B;">' + sanitizeHtml(g.credit_score_source) + '</span>' : '') +
                          (g.credit_score_date ? '<span style="font-size:10px;color:#475569;">(' + fmtDate(g.credit_score_date) + ')</span>' : '') +
                        '</div>'; })()
                    : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(Underwriting)</span></div>';

                  return '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #FBBF24;border-radius:8px;padding:12px 14px;margin-bottom:12px;">' +
                    // Identity header
                    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                      '<div>' +
                        '<div style="font-size:10px;color:#FBBF24;text-transform:uppercase;font-weight:700;letter-spacing:.5px;">Personal Guarantor (Individual)</div>' +
                        '<div style="font-size:15px;font-weight:700;color:#F1F5F9;margin-top:3px;">' + sanitizeHtml(g.full_name || 'Unnamed') + '</div>' +
                      '</div>' +
                      '<div style="display:flex;gap:6px;align-items:center;">' +
                        '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.1);color:' + kycCol + ';">' + kycLabel + '</span>' +
                        (canEdit ? '<button onclick="window.editBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' : '') +
                        (canEdit ? '<button onclick="window.deleteBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove">\u2715</button>' : '') +
                      '</div>' +
                    '</div>' +
                    // 2-column detail grid (Alessandra-Cenci style)
                    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px;">' +
                      // LEFT: Personal Identity
                      '<div>' +
                        '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Personal Identity</div>' +
                        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                          fieldInline('Date of Birth', fmtDate(g.date_of_birth), 'DIP') +
                          fieldInline('Gender', g.gender, 'DIP') +
                          fieldInline('Nationality', g.nationality, 'DIP') +
                          fieldInline('Email', g.email, 'DIP') +
                          fieldInline('Phone', g.phone, 'DIP') +
                        '</div>' +
                        '<div style="margin-bottom:8px;">' +
                          '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">ID Document</div>' +
                          idDocInner +
                        '</div>' +
                        fieldInline('Residential Address', g.residential_address || g.address, 'DIP') +
                        statusPillInline('Address Proof', g.address_proof_status || 'not_obtained') +
                      '</div>' +
                      // RIGHT: Compliance & Verification
                      '<div>' +
                        '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Compliance &amp; Verification</div>' +
                        '<div style="margin-bottom:8px;">' +
                          '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Credit Score</div>' +
                          creditInner +
                        '</div>' +
                        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                          statusPillInline('CCJs', g.ccj_count > 0 ? (g.ccj_count + ' found') : (g.ccj_count === 0 ? 'None' : 'not_screened')) +
                          statusPillInline('Bankruptcy', g.bankruptcy_status || 'none') +
                          statusPillInline('PEP Screening', g.pep_status || 'not_screened') +
                          statusPillInline('Sanctions', g.sanctions_status || 'not_screened') +
                        '</div>' +
                        fieldInline('Source of Wealth', g.source_of_wealth, 'Underwriting') +
                        fieldInline('Source of Funds', g.source_of_funds, 'Underwriting') +
                      '</div>' +
                    '</div>' +
                  '</div>';
                };

                // ── Main body ──
                let body = header;
                if (totalG === 0) {
                  body += '<p style="font-size:12px;color:#FBBF24;margin:0 0 12px 0;">No guarantors added yet. Use the buttons below to add corporate or individual guarantors.</p>';
                } else {
                  body += corpGuarantors.map(renderCorpCard).join('');
                  body += indGuarantors.map(renderIndCard).join('');
                }

                // ── Add buttons ──
                if (canEdit) {
                  body += '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">' +
                    '<button onclick="window.addCorporateGuarantor(\'' + deal.submission_id + '\')" style="padding:8px 14px;font-size:11px;font-weight:700;cursor:pointer;border-radius:6px;border:1px dashed rgba(129,140,248,0.4);background:rgba(129,140,248,0.06);color:#818CF8;">+ Add Corporate Guarantor</button>' +
                    '<button onclick="window.addIndividualGuarantor(\'' + deal.submission_id + '\')" style="padding:8px 14px;font-size:11px;font-weight:700;cursor:pointer;border-radius:6px;border:1px dashed rgba(251,191,36,0.4);background:rgba(251,191,36,0.06);color:#FBBF24;">+ Add Individual Guarantor</button>' +
                  '</div>';
                }
                return body;
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: BORROWER FINANCIALS & AML
  // ═══════════════════════════════════════════════════════════════════

  if (showFinancialsAML) {
  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s2', 'F', 'Borrower Financials & AML', 'Income, assets, liabilities, and compliance', [
        renderStatusDot(0, 'not-started', 'dip-sec-s2'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s2" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Financial Summary (editable at DIP) -->
        ${renderFieldRow('financial-summary', 'Financial Summary', 'Estimated net worth and source of wealth',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-financial-summary">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Financial Summary</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <p style="font-size:11px;color:#94A3B8;margin:0 0 10px;">Provide an estimate of the borrower's net worth. This is not verified at DIP stage — just an indication for the RM.</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('estimated_net_worth', 'Estimated Net Worth (£)', deal.estimated_net_worth, 'money', canEdit)}
                ${renderEditableField('source_of_wealth', 'Source of Wealth', deal.source_of_wealth, 'select', canEdit, [
                  { value: 'employment', label: 'Employment / Salary' },
                  { value: 'business', label: 'Business Ownership' },
                  { value: 'property', label: 'Property Portfolio' },
                  { value: 'investments', label: 'Investments / Trading' },
                  { value: 'inheritance', label: 'Inheritance' },
                  { value: 'other', label: 'Other' }
                ])}
              </div>
            </div>
          </div>
        </div>

        <!-- Assets -->
        ${renderFieldRow('assets', 'Assets', 'Real estate, investments, cash, vehicles',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-assets">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Assets Schedule</div>
                <div style="display:flex;gap:6px;align-items:center;">
                  ${canEdit ? `<button onclick="window.addFinancialRow('${deal.submission_id}','asset')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Asset</button>` : ''}
                  ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
                </div>
              </div>
              ${_renderFinancialTable(deal, 'asset', canEdit)}
            </div>
          </div>
        </div>

        <!-- Liabilities -->
        ${renderFieldRow('liabilities', 'Liabilities', 'Mortgages, loans, credit commitments',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-liabilities">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Liabilities Schedule</div>
                <div style="display:flex;gap:6px;align-items:center;">
                  ${canEdit ? `<button onclick="window.addFinancialRow('${deal.submission_id}','liability')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Liability</button>` : ''}
                  ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
                </div>
              </div>
              ${_renderFinancialTable(deal, 'liability', canEdit)}
            </div>
          </div>
        </div>

        <!-- Income -->
        ${renderFieldRow('income', 'Income', 'Employment, rental, investment income',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-income">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Income Schedule</div>
                <div style="display:flex;gap:6px;align-items:center;">
                  ${canEdit ? `<button onclick="window.addFinancialRow('${deal.submission_id}','income')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Income</button>` : ''}
                  ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
                </div>
              </div>
              ${_renderFinancialTable(deal, 'income', canEdit)}
            </div>
          </div>
        </div>

        <!-- Expenses -->
        ${renderFieldRow('expenses', 'Expenses', 'Housing, living costs, financial commitments',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-expenses">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Expenses Schedule</div>
                <div style="display:flex;gap:6px;align-items:center;">
                  ${canEdit ? `<button onclick="window.addFinancialRow('${deal.submission_id}','expense')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Expense</button>` : ''}
                  ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
                </div>
              </div>
              ${_renderFinancialTable(deal, 'expense', canEdit)}
            </div>
          </div>
        </div>

        <!-- AML & Source of Funds -->
        ${renderFieldRow('aml-source-funds', 'AML & Source of Funds', 'Source of funds, wealth, PEP screening, tax residency',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-aml-source-funds">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Source of Funds & AML</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('deposit_source', 'Source of Deposit / Funds', deal.deposit_source, 'textarea', canEdit)}
                ${renderEditableField('existing_charges', 'Existing Charges', deal.existing_charges, 'textarea', canEdit)}
                ${renderEditableField('concurrent_transactions', 'Concurrent Transactions', deal.concurrent_transactions, 'textarea', canEdit)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  } // end showFinancialsAML

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: PROPERTY / SECURITY
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s3', 'P', 'Property / Security', 'Property details and valuation', [
        renderStatusDot(0, 'not-started', 'dip-sec-s3'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s3" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Property Details -->
        ${renderFieldRow('property-details', 'Property Details', 'Address, tenure, bedrooms, square footage',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-property-details">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Property / Security Details</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>

              ${(deal.properties && deal.properties.length > 0) ? `
              <!-- ── Individual Properties (from deal_properties table — source of truth) ── -->
              <div style="margin-bottom:12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Security Schedule — ${deal.properties.length} ${deal.properties.length === 1 ? 'Property' : 'Properties'}</span>
                  <div style="display:flex;gap:6px;align-items:center;">
                    ${canEdit ? `<button onclick="window.addPropertyRow('${deal.submission_id}')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Property</button>` : ''}
                    <span style="font-size:9px;color:#34D399;background:rgba(52,211,153,0.1);padding:2px 8px;border-radius:4px;font-weight:600;">AUTO-PARSED</span>
                  </div>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                  <thead>
                    <tr style="background:rgba(255,255,255,0.04);">
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">#</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Address</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Postcode</th>
                      <th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Value (£)</th>
                      <th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Purchase (£)</th>
                      <th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);" title="Bedrooms + type: F=Flat, H=House, M=Maisonette, Bg=Bungalow. Derived from EPC habitable rooms (rooms-1).">Unit</th>
                      <th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);" title="Floor area from EPC">Area</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Type</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Tenure</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);" title="Occupancy: vacant / tenanted / regulated / owner-occupied">Occupancy</th>
                      ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
                    </tr>
                  </thead>
                  <tbody>
                    ${deal.properties.map((p, i) => {
                      // Derive unit descriptor (e.g. "3BF", "2BH", "Studio") from EPC rooms + property type
                      const _rooms = parseInt(p.epc_habitable_rooms) || 0;
                      const _pt = (p.epc_property_type || '').toLowerCase();
                      const _letter = _pt.includes('flat') ? 'F' : _pt.includes('maisonette') ? 'M' : _pt.includes('house') ? 'H' : _pt.includes('bungalow') ? 'Bg' : '';
                      const _unit = !_rooms ? '—' : (_rooms === 1 ? 'Studio' : (_rooms - 1) + 'B' + _letter);
                      const _area = p.epc_floor_area ? Number(p.epc_floor_area).toFixed(0) + ' m\u00B2' : '—';
                      // Occupancy — colour-coded by lending risk. Uses existing deal_properties.occupancy column.
                      const _occ = (p.occupancy || '').toLowerCase();
                      const _occColor = _occ.includes('vacant') ? '#34D399'
                                       : _occ.includes('regulated') ? '#F87171'
                                       : (_occ.includes('tenant') || _occ.includes('let') || _occ.includes('rent') || _occ.includes('ast')) ? '#FBBF24'
                                       : _occ.includes('owner') ? '#94A3B8'
                                       : '#64748B';
                      const _occDisplay = p.occupancy ? sanitizeHtml(p.occupancy) : '—';
                      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);" id="prop-row-${p.id}">
                      <td style="padding:6px 8px;color:#F1F5F9;font-weight:600;">${i + 1}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;">${sanitizeHtml(p.address || '-')}</td>
                      <td style="padding:6px 8px;color:#D4A853;font-weight:600;">${sanitizeHtml(p.postcode || '-')}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;text-align:right;font-weight:600;">${p.market_value ? '£' + Number(p.market_value).toLocaleString() : '—'}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;text-align:right;font-weight:600;">${p.purchase_price ? '£' + Number(p.purchase_price).toLocaleString() : '—'}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;text-align:center;font-weight:700;font-size:11px;" title="Derived from EPC: ${_rooms} habitable rooms">${_unit}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;text-align:right;font-size:11px;">${_area}</td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(p.property_type || deal.asset_type || '-')}</td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(p.tenure || deal.property_tenure || '-')}</td>
                      <td style="padding:6px 8px;color:${_occColor};font-size:11px;font-weight:${p.occupancy ? '600' : '400'};text-transform:capitalize;">${_occDisplay}</td>
                      ${canEdit ? `<td style="padding:6px 8px;text-align:center;white-space:nowrap;">
                        <button onclick="window.editPropertyRow(${p.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>
                        <button onclick="window.deletePropertyRow(${p.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>
                      </td>` : ''}
                    </tr>`;}).join('')}
                  </tbody>
                </table>
              </div>
              <!-- ── Property Search Results (EPC, Postcode, Price Paid) ── -->
              ${deal.properties.map((p, i) => {
                const searched = !!p.property_searched_at;
                const verified = !!p.property_verified_at;
                const propLabel = deal.properties.length > 1 ? 'Property ' + (i + 1) + ': ' : '';
                const subId = deal.submission_id;

                // ── State 1: not searched ────────────────────────────────
                if (!searched) {
                  return '<div style="margin-top:8px;padding:8px 12px;background:rgba(212,168,83,0.06);border:1px solid rgba(212,168,83,0.15);border-radius:6px;display:flex;align-items:center;justify-content:space-between;">' +
                    '<div style="font-size:11px;color:#D4A853;">' + propLabel + 'Property data not yet searched</div>' +
                    '<button onclick="window._propertySearch(' + p.id + ', \'' + subId + '\')" style="padding:4px 12px;background:#D4A853;color:#111;border:none;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">Search Property Data</button>' +
                  '</div>';
                }

                // ── Parse match metadata from property_search_data ──────
                let searchData = p.property_search_data || {};
                if (typeof searchData === 'string') { try { searchData = JSON.parse(searchData); } catch (_) { searchData = {}; } }
                const epcBlock = searchData.epc || {};
                const alternatives = Array.isArray(epcBlock.alternative_matches) ? epcBlock.alternative_matches : [];
                const matchConfidence = epcBlock.match_confidence || (p.epc_rating ? 'exact' : 'none');
                const matchNote = epcBlock.match_note || '';
                const hasEpc = !!p.epc_rating;

                // ── Build expanded blocks (shared by exact/ambiguous/verified states) ──
                const epcColor = { A:'#22C55E', B:'#34D399', C:'#86EFAC', D:'#FBBF24', E:'#F97316', F:'#EF4444', G:'#DC2626' };
                const rating = p.epc_rating || null;
                const ratingStyle = rating ? 'background:' + (epcColor[rating] || '#64748B') + ';color:#111;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:800;' : '';

                // MEES compliance (per Energy Efficiency (Private Rented Property) Regs 2015; proposed EPC C is under consultation, not yet law)
                let meesHtml = '';
                if (rating) {
                  const meesCfg = ['A','B','C'].includes(rating)
                    ? { color:'#34D399', bg:'rgba(52,211,153,0.12)', label:'\u2713 Meets MEES (current E + proposed C)' }
                    : ['D','E'].includes(rating)
                      ? { color:'#FBBF24', bg:'rgba(251,191,36,0.12)', label:'\u26A0 Meets current MEES E; may fail proposed C' }
                      : { color:'#F87171', bg:'rgba(248,113,113,0.12)', label:'\u2717 Below MEES \u2014 cannot be let' };
                  meesHtml = '<div style="margin-top:4px;padding:4px 8px;background:' + meesCfg.bg + ';border-radius:4px;display:inline-block;"><span style="font-size:10px;color:' + meesCfg.color + ';font-weight:700;">' + meesCfg.label + '</span></div>';
                }

                // EPC score (numeric 0-100 behind the letter rating) — pull from property_search_data.epc.data
                const epcCurrentScore = epcBlock.data ? epcBlock.data.epc_score : null;
                const epcPotRating = p.epc_potential_rating || (epcBlock.data ? epcBlock.data.potential_rating : null);
                const epcPotScore = epcBlock.data ? epcBlock.data.potential_score : null;
                const epcInspection = p.epc_inspection_date || (epcBlock.data ? epcBlock.data.inspection_date : null);
                // EPC certificate age — UK certs are valid 10 years (Energy Performance of Buildings Regs 2012)
                let inspAgeHtml = '';
                let inspColor = '#F1F5F9';
                if (epcInspection) {
                  const ageYears = Math.floor((Date.now() - new Date(epcInspection).getTime()) / (365.25*24*60*60*1000));
                  if (ageYears >= 10) { inspColor = '#F87171'; inspAgeHtml = ' <span style="color:#F87171;font-weight:700;font-size:10px;">EXPIRED (' + ageYears + 'y)</span>'; }
                  else if (ageYears >= 5) { inspColor = '#FBBF24'; inspAgeHtml = ' <span style="color:#FBBF24;font-size:10px;">(' + ageYears + 'y old)</span>'; }
                  else { inspAgeHtml = ' <span style="color:#94A3B8;font-size:10px;">(' + ageYears + 'y)</span>'; }
                }

                let epcHtml = '';
                if (rating) {
                  const ratingCellInner = '<span style="' + ratingStyle + '">' + rating + '</span>' +
                    (epcCurrentScore ? ' <span style="font-size:10px;color:#94A3B8;">(' + epcCurrentScore + ')</span>' : '');
                  const potentialCell = (epcPotRating && epcPotRating !== rating)
                    ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Potential</span><span style="' + 'background:' + (epcColor[epcPotRating] || '#64748B') + ';color:#111;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:800;' + '">' + epcPotRating + '</span>' + (epcPotScore ? ' <span style="font-size:10px;color:#94A3B8;">(' + epcPotScore + ')</span>' : '') + '</div>'
                    : '';
                  epcHtml = '<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">EPC Rating</span>' + ratingCellInner + '</div>' +
                    potentialCell +
                    (p.epc_floor_area ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Floor Area</span><span style="font-size:12px;color:#F1F5F9;font-weight:600;">' + p.epc_floor_area + ' m\u00B2 (' + Math.round(p.epc_floor_area * 10.764) + ' sq ft)</span></div>' : '') +
                    (p.epc_property_type ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Type (EPC)</span><span style="font-size:12px;color:#F1F5F9;">' + sanitizeHtml(p.epc_property_type) + '</span></div>' : '') +
                    (p.epc_built_form ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Built Form</span><span style="font-size:12px;color:#F1F5F9;">' + sanitizeHtml(p.epc_built_form) + '</span></div>' : '') +
                    (p.epc_construction_age ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Construction</span><span style="font-size:12px;color:#F1F5F9;">' + sanitizeHtml(p.epc_construction_age) + '</span></div>' : '') +
                    (p.epc_habitable_rooms ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Habitable Rooms</span><span style="font-size:12px;color:#F1F5F9;">' + p.epc_habitable_rooms + '</span></div>' : '') +
                    (epcInspection ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Inspected</span><span style="font-size:12px;color:' + inspColor + ';">' + new Date(epcInspection).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) + inspAgeHtml + '</span></div>' : '') +
                    (p.epc_certificate_id ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Cert ID</span><span style="font-size:10px;color:#94A3B8;font-family:monospace;">' + sanitizeHtml(String(p.epc_certificate_id).substring(0,16)) + '\u2026</span></div>' : '') +
                  '</div>' + meesHtml;
                }

                let geoHtml = '';
                if (p.local_authority) {
                  const geoOk = p.in_england_or_wales;
                  const geoBadge = geoOk === false
                    ? '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(248,113,113,0.15);color:#F87171;">OUTSIDE LENDING AREA</span>'
                    : geoOk === true
                      ? '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.1);color:#34D399;">' + sanitizeHtml(p.country || 'England') + '</span>'
                      : '';
                  geoHtml = '<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Local Authority</span><span style="font-size:12px;color:#F1F5F9;">' + sanitizeHtml(p.local_authority) + '</span></div>' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Region</span><span style="font-size:12px;color:#F1F5F9;">' + sanitizeHtml(p.region || '—') + '</span></div>' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Geography</span>' + geoBadge + '</div>' +
                  '</div>';
                }

                let priceHtml = '';
                if (p.last_sale_price) {
                  priceHtml = '<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Last Sale Price</span><span style="font-size:14px;color:#F1F5F9;font-weight:700;">\u00A3' + Number(p.last_sale_price).toLocaleString() + '</span></div>' +
                    '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Sale Date</span><span style="font-size:12px;color:#F1F5F9;">' + (p.last_sale_date ? new Date(p.last_sale_date).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) : '—') + '</span></div>' +
                    (p.market_value && p.last_sale_price ? '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;">Value vs Last Sale</span><span style="font-size:12px;font-weight:600;color:' + (Number(p.market_value) >= Number(p.last_sale_price) ? '#34D399' : '#F87171') + ';">' + (Number(p.market_value) >= Number(p.last_sale_price) ? '+' : '') + Math.round((Number(p.market_value) - Number(p.last_sale_price)) / Number(p.last_sale_price) * 100) + '%</span></div>' : '') +
                  '</div>';
                }

                // ── State 2: searched but no EPC → ambiguous or none, show picker ──
                if (!hasEpc) {
                  let pickerHtml = '';
                  if (alternatives.length > 0) {
                    const opts = alternatives.map(a => {
                      const addr = (a.address || '').replace(/'/g, '&#39;');
                      const tag = (a.epc_rating || '?') + ' \u00B7 ' + (a.floor_area ? a.floor_area + 'm\u00B2' : '?') + ' \u00B7 ' + (a.number_habitable_rooms || '?') + ' rooms';
                      return '<option value="' + sanitizeHtml(a.lmk_key || '') + '">' + sanitizeHtml(addr) + ' \u2014 ' + tag + '</option>';
                    }).join('');
                    pickerHtml = '<div style="margin-top:6px;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">' +
                      '<div style="font-size:10px;color:#94A3B8;margin-bottom:4px;">Pick the correct EPC from ' + alternatives.length + ' candidates at this postcode:</div>' +
                      '<div style="display:flex;gap:6px;align-items:center;">' +
                        '<select id="epc-picker-' + p.id + '" style="flex:1;padding:4px 6px;background:#111;color:#F1F5F9;border:1px solid rgba(255,255,255,0.15);border-radius:4px;font-size:11px;">' +
                          '<option value="">-- Select an EPC certificate --</option>' + opts +
                        '</select>' +
                        '<button onclick="window._propertySelectEpc(' + p.id + ', \'' + subId + '\')" style="padding:4px 10px;background:#D4A853;color:#111;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Apply</button>' +
                      '</div>' +
                    '</div>';
                  }
                  return '<div style="margin-top:8px;padding:10px 12px;background:rgba(251,191,36,0.05);border:1px solid rgba(251,191,36,0.25);border-radius:6px;">' +
                    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
                      '<span style="font-size:10px;color:#FBBF24;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'EPC Match ' + matchConfidence.toUpperCase() + '</span>' +
                      '<button onclick="window._propertySearch(' + p.id + ', \'' + subId + '\')" style="padding:2px 8px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:9px;font-weight:600;cursor:pointer;">Re-Search</button>' +
                    '</div>' +
                    (matchNote ? '<div style="font-size:11px;color:#FBBF24;margin-bottom:6px;">' + sanitizeHtml(matchNote) + '</div>' : '') +
                    (geoHtml ? '<div style="margin-bottom:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);">' + geoHtml + '</div>' : '') +
                    pickerHtml +
                    (priceHtml ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);">' + priceHtml + '</div>' : '') +
                  '</div>';
                }

                // ── State 3: searched with EPC (exact or manually selected) → expanded panel with Accept/Undo ──
                const hasData = epcHtml || geoHtml || priceHtml;
                if (!hasData) return '';

                // Inline summary shown when panel is collapsed
                const summaryBits = [];
                if (p.local_authority) summaryBits.push(sanitizeHtml(p.local_authority));
                const _sunit = (() => {
                  const r = parseInt(p.epc_habitable_rooms) || 0;
                  const pt2 = (p.epc_property_type || '').toLowerCase();
                  const L = pt2.includes('flat') ? 'F' : pt2.includes('maisonette') ? 'M' : pt2.includes('house') ? 'H' : pt2.includes('bungalow') ? 'Bg' : '';
                  return !r ? '' : (r === 1 ? 'Studio' : (r - 1) + 'B' + L);
                })();
                if (_sunit) summaryBits.push(_sunit);
                if (p.epc_floor_area) summaryBits.push(Number(p.epc_floor_area).toFixed(0) + ' m\u00B2');
                if (p.epc_rating) summaryBits.push('EPC ' + p.epc_rating);
                const summaryText = summaryBits.join(' \u00B7 ') || 'Property searched';

                const selectedNote = p.epc_selected_lmk_key ? '<span style="font-size:9px;color:#D4A853;margin-left:6px;">\u00B7 Manually selected</span>' : '';
                const verifiedBadge = verified
                  ? '<span id="prop-accepted-' + p.id + '" style="font-size:10px;color:#34D399;font-weight:800;margin-left:6px;background:rgba(52,211,153,0.15);padding:2px 6px;border-radius:3px;">\u2713 ACCEPTED</span>'
                  : '<span id="prop-accepted-' + p.id + '" style="display:none;font-size:10px;color:#34D399;font-weight:800;margin-left:6px;background:rgba(52,211,153,0.15);padding:2px 6px;border-radius:3px;">\u2713 ACCEPTED</span>';
                const acceptBtn = verified
                  ? '<button id="prop-accept-btn-' + p.id + '" onclick="event.stopPropagation();window._propertyUnverify(' + p.id + ', \'' + subId + '\')" style="padding:3px 12px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Undo Accept</button>'
                  : '<button id="prop-accept-btn-' + p.id + '" onclick="event.stopPropagation();window._propertyVerify(' + p.id + ', \'' + subId + '\')" style="padding:3px 12px;background:#34D399;color:#111;border:none;border-radius:4px;font-size:10px;font-weight:800;cursor:pointer;">\u2713 Accept</button>';
                const borderColor = verified ? 'rgba(52,211,153,0.45)' : 'rgba(52,211,153,0.15)';

                // Default expand state: collapsed if verified, open if not verified
                const bodyDisplay = verified ? 'none' : 'block';
                const summaryDisplay = verified ? 'inline' : 'none';
                const chevronRotate = verified ? '' : 'transform:rotate(90deg);';

                return '<div id="prop-intel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(52,211,153,0.03);border:1px solid ' + borderColor + ';border-radius:6px;">' +
                  '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;cursor:pointer;" onclick="window._togglePropPanel(' + p.id + ')">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span id="prop-chevron-' + p.id + '" style="display:inline-block;font-size:10px;color:#64748B;' + chevronRotate + 'transition:transform 0.15s;">\u25B6</span>' +
                      '<span style="font-size:10px;color:#34D399;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'Property Intelligence</span>' +
                      selectedNote +
                      verifiedBadge +
                      '<span id="prop-summary-' + p.id + '" style="display:' + summaryDisplay + ';font-size:11px;color:#F1F5F9;margin-left:8px;">\u00B7 ' + summaryText + '</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;align-items:center;">' +
                      '<span style="font-size:9px;color:#64748B;">Searched ' + new Date(p.property_searched_at).toLocaleDateString('en-GB') + '</span>' +
                      acceptBtn +
                      '<button onclick="event.stopPropagation();window._propertySearch(' + p.id + ', \'' + subId + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Re-Search</button>' +
                    '</div>' +
                  '</div>' +
                  '<div id="prop-body-' + p.id + '" style="display:' + bodyDisplay + ';">' +
                  (geoHtml ? '<div style="margin-bottom:6px;">' + geoHtml + '</div>' : '') +
                  (epcHtml ? '<div style="margin-bottom:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);">' + epcHtml + '</div>' : '') +
                  (priceHtml ? '<div style="padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);">' + priceHtml + '</div>' : '') +
                  '</div>' + // close prop-body
                '</div>';
              }).join('')}

              <!-- ── Portfolio Summary (aggregates derived from the security schedule) ── -->
              ${(() => {
                const pp = deal.properties;
                const n = pp.length;
                const num = (v) => Number(v) || 0;
                const totalMV = pp.reduce((s, p) => s + num(p.market_value), 0);
                const totalPP = pp.reduce((s, p) => s + num(p.purchase_price), 0);
                const uplift = totalMV - totalPP;
                const upliftPct = totalPP > 0 ? (uplift / totalPP * 100) : 0;
                const totalAreaM2 = pp.reduce((s, p) => s + num(p.epc_floor_area), 0);
                const totalAreaSqft = totalAreaM2 * 10.764;
                const psf = totalAreaSqft > 0 ? (totalMV / totalAreaSqft) : 0;
                // Counters — use deal-level fallback same as Security Schedule rows
                const tenureShort = { freehold: 'FH', leasehold: 'LH', share_of_freehold: 'SoF' };
                const tenureCounts = pp.reduce((acc, p) => {
                  const raw = ((p.tenure || deal.property_tenure) || '').toString().toLowerCase().trim().replace(/\s+/g, '_');
                  if (!raw) return acc;
                  const short = tenureShort[raw] || (raw.charAt(0).toUpperCase() + raw.slice(1));
                  acc[short] = (acc[short] || 0) + 1;
                  return acc;
                }, {});
                const tenureMix = Object.entries(tenureCounts).map(([k, v]) => v + ' ' + k).join(' \u00B7 ') || '—';

                const mixWithFallback = (propKey, dealKey) => {
                  const counts = pp.reduce((acc, p) => {
                    const raw = ((p[propKey] || deal[dealKey]) || '').toString().toLowerCase().trim();
                    if (!raw) return acc;
                    const label = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
                    acc[label] = (acc[label] || 0) + 1;
                    return acc;
                  }, {});
                  return Object.entries(counts).map(([k, v]) => v + ' ' + k).join(' \u00B7 ') || '—';
                };
                const typeMix = mixWithFallback('property_type', 'asset_type');

                // Occupancy — NO deal-level fallback. Each property must be individually known.
                // Deal-level occupancy_status is a placeholder and would mislead credit decisions.
                const occCounts = pp.reduce((acc, p) => {
                  const raw = (p.occupancy || '').toString().toLowerCase().trim();
                  if (!raw) return acc;
                  const label = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
                  acc[label] = (acc[label] || 0) + 1;
                  return acc;
                }, {});
                const occSet = Object.values(occCounts).reduce((s, v) => s + v, 0);
                const occMix = occSet === 0
                  ? '—'
                  : Object.entries(occCounts).map(([k, v]) => v + ' ' + k).join(' \u00B7 ') + (occSet < pp.length ? ' \u00B7 ' + (pp.length - occSet) + ' Unknown' : '');
                // Geography
                const geoFlags = pp.map(p => p.in_england_or_wales);
                const anyOutside = geoFlags.some(f => f === false);
                const allInEnW = geoFlags.every(f => f === true);
                const geoStyle = anyOutside ? 'color:#F87171;font-weight:700;' : allInEnW ? 'color:#34D399;font-weight:600;' : 'color:#94A3B8;';
                const geoText = anyOutside ? '\u2717 Some outside E&W' : allInEnW ? '\u2713 All E&W' : 'Not verified';
                // MEES
                const withEpc = pp.filter(p => p.epc_rating);
                const meesAboveC = withEpc.filter(p => ['A','B','C'].includes(p.epc_rating)).length;
                const meesBelowE = withEpc.filter(p => ['F','G'].includes(p.epc_rating)).length;
                const meesStyle = meesBelowE > 0 ? 'color:#F87171;font-weight:700;' : (meesAboveC === withEpc.length && withEpc.length > 0) ? 'color:#34D399;font-weight:600;' : 'color:#F1F5F9;';
                const meesText = withEpc.length === 0 ? '—'
                               : meesBelowE > 0 ? '\u26A0 ' + meesBelowE + ' below E (unlettable)'
                               : meesAboveC === withEpc.length ? '\u2713 All ' + withEpc.length + ' EPC C+'
                               : meesAboveC + '/' + withEpc.length + ' EPC C+';

                const kpi = (label, value, extraStyle) => '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;letter-spacing:.3px;">' + label + '</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;' + (extraStyle || '') + '">' + value + '</span></div>';

                return '<div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;margin-top:10px;">' +
                  '<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;font-weight:700;letter-spacing:.5px;margin-bottom:8px;">Portfolio Summary \u00B7 ' + n + ' ' + (n === 1 ? 'property' : 'properties') + '</div>' +
                  // Row 1 — money/size aggregates
                  '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:8px;padding:10px 12px;background:rgba(52,211,153,0.03);border:1px solid rgba(52,211,153,0.12);border-radius:6px;">' +
                    kpi('Total Value', '\u00A3' + totalMV.toLocaleString()) +
                    kpi('Total Purchase', '\u00A3' + totalPP.toLocaleString()) +
                    kpi('Value Uplift', (uplift >= 0 ? '+' : '') + '\u00A3' + uplift.toLocaleString() + ' <span style="font-size:10px;color:' + (uplift >= 0 ? '#34D399' : '#F87171') + ';">(' + upliftPct.toFixed(1) + '%)</span>') +
                    kpi('Floor Area', (totalAreaM2 > 0 ? totalAreaM2.toFixed(0) + ' m\u00B2 <span style="font-size:10px;color:#94A3B8;font-weight:400;">(' + Math.round(totalAreaSqft).toLocaleString() + ' sqft)</span>' : '\u2014')) +
                    kpi('\u00A3/sq ft (weighted)', (psf > 0 ? '\u00A3' + Math.round(psf).toLocaleString() : '\u2014')) +
                  '</div>' +
                  // Row 2 — portfolio composition + flags
                  '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:6px;">' +
                    kpi('Tenure Mix', tenureMix) +
                    kpi('Occupancy Mix', occMix) +
                    kpi('Asset Type', typeMix) +
                    kpi('Geography', geoText, geoStyle) +
                    kpi('MEES', meesText, meesStyle) +
                  '</div>' +
                '</div>';
              })()}
              ` : `
              <!-- ── Raw address fields (no deal_properties rows yet) ── -->
              <div style="margin-bottom:8px;padding:8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
                <div>
                  <span style="font-size:10px;color:#FBBF24;font-weight:600;">⚠ Property details not yet synced</span>
                  ${(deal.doc_summary && deal.doc_summary.total > 0) ? `
                  <span style="font-size:10px;color:#94A3B8;margin-left:6px;">(${deal.doc_summary.parsed} of ${deal.doc_summary.total} docs parsed${deal.doc_summary.unparsed > 0 ? ` — ${deal.doc_summary.unparsed} pending` : ''})</span>
                  ` : '<span style="font-size:10px;color:#94A3B8;margin-left:6px;">(no documents uploaded yet)</span>'}
                </div>
                <button onclick="window.reparseProperties && window.reparseProperties('${deal.submission_id}')" style="padding:3px 10px;background:#FBBF24;color:#111827;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;">Re-Parse Properties</button>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('security_address', 'Security Address', deal.security_address, 'text', canEdit)}
                ${renderEditableField('security_postcode', 'Postcode', deal.security_postcode, 'text', canEdit)}
                ${renderEditableField('asset_type', 'Asset Type', deal.asset_type, 'select', canEdit, [
                  { value: 'residential', label: 'Residential' }, { value: 'commercial', label: 'Commercial' },
                  { value: 'mixed_use', label: 'Mixed Use' }, { value: 'hmo', label: 'HMO' },
                  { value: 'mufb', label: 'Multi-Unit Freehold Block' }, { value: 'land', label: 'Land with Planning' }
                ])}
                ${renderEditableField('property_tenure', 'Tenure', deal.property_tenure, 'select', canEdit, [
                  { value: 'freehold', label: 'Freehold' }, { value: 'leasehold', label: 'Leasehold' },
                  { value: 'share_of_freehold', label: 'Share of Freehold' }
                ])}
                ${renderEditableField('occupancy_status', 'Occupancy', deal.occupancy_status, 'text', canEdit)}
                ${renderEditableField('current_use', 'Current Use', deal.current_use, 'text', canEdit)}
              </div>
              `}
            </div>
          </div>
        </div>

        <!-- Valuation -->
        ${renderFieldRow('property-valuation', 'Valuation', 'Desktop valuation, survey, final valuation',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-property-valuation">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Valuation & Pricing</div>
              ${deal.properties && deal.properties.length > 1
                ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                    <div style="margin-bottom:12px">
                      <label style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;display:block">Portfolio Total Value (£)</label>
                      <div style="padding:8px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;color:#34D399;font-size:13px;font-weight:700;">£${portfolioValuation().toLocaleString()}</div>
                      <div style="font-size:9px;color:#64748B;margin-top:3px;">Sum of ${deal.properties.length} properties</div>
                    </div>
                    <div style="margin-bottom:12px">
                      <label style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;display:block">Portfolio Total Purchase Price (£)</label>
                      <div style="padding:8px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;color:#34D399;font-size:13px;font-weight:700;">£${portfolioPurchasePrice().toLocaleString()}</div>
                      <div style="font-size:9px;color:#64748B;margin-top:3px;">Sum of ${deal.properties.length} properties</div>
                    </div>
                  </div>`
                : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                    ${renderEditableField('current_value', 'Current Value (£)', deal.current_value, 'money', canEdit)}
                    ${renderEditableField('purchase_price', 'Purchase Price (£)', deal.purchase_price, 'money', canEdit)}
                  </div>`
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: LOAN TERMS & USE OF FUNDS
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s4', 'L', 'Loan Terms & Use of Funds', 'Loan structure and drawdown', [
        renderStatusDot(0, 'not-started', 'dip-sec-s4'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s4" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Loan Terms -->
        ${renderFieldRow('loan-terms', 'Loan Terms', `Amount: £${fmtMoney(deal.loan_amount)}, Term: ${deal.term_months || '?'} months, Rate: ${deal.rate_requested || 'TBA'}%`,
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-loan-terms">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Loan Structure</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px;">
                ${renderEditableField('loan_amount', 'Loan Amount (£)', deal.loan_amount, 'money', canEdit)}
                <div style="margin-bottom:12px">
                  <div style="display:flex;align-items:center;justify-content:space-between;">
                    <label style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;" for="mf-ltv_requested">LTV Requested (%)</label>
                    ${canEdit ? '<button onclick="window.matrixApplyMaxLoan()" style="font-size:8px;font-weight:600;color:#60A5FA;background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.25);border-radius:4px;padding:1px 6px;cursor:pointer;margin-bottom:4px;" title="Set loan amount to max allowable (75% val / 90% PP)">Max LTV</button>' : ''}
                  </div>
                  ${canEdit
                    ? '<input id="mf-ltv_requested" type="text" data-field="ltv_requested" data-type="text" style="width:100%;padding:8px 12px;background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-radius:8px;color:#F1F5F9;font-size:13px;" value="' + (deal.ltv_requested || '') + '" placeholder="Auto-calculated" onblur="window.matrixValidateAndSave(\'ltv_requested\', this.value, \'text\')" />'
                    : '<input type="hidden" id="mf-ltv_requested" value="' + (deal.ltv_requested || '') + '"><div style="padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.04);border-radius:8px;color:#CBD5E1;font-size:13px;">' + (deal.ltv_requested || '—') + '</div>'
                  }
                  <div id="err-ltv_requested" style="font-size:10px;color:#F87171;margin-top:2px;display:none;"></div>
                </div>
                ${renderEditableField('term_months', 'Term (months)', deal.term_months || '12', 'text', canEdit)}
                ${renderEditableField('rate_requested', 'Rate (%/month)', deal.rate_requested, 'text', isInternalUser && canEdit)}
                ${renderEditableField('interest_servicing', 'Interest Servicing', deal.interest_servicing || 'retained', 'select', canEdit, [
                  { value: 'retained', label: 'Retained (deducted upfront)' },
                  { value: 'serviced', label: 'Serviced (monthly payments)' },
                  { value: 'rolled', label: 'Rolled Up' }
                ])}
                ${renderEditableField('drawdown_date', 'Target Drawdown', deal.drawdown_date, 'date', canEdit)}
              </div>
              <div id="loan-limit-indicator"></div>
            </div>
          </div>
        </div>

        <!-- Use of Funds -->
        ${renderFieldRow('use-of-funds', 'Use of Funds', 'Refinance, purchase, renovation, other',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-use-of-funds">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Purpose & Use of Funds</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('loan_purpose', 'Loan Purpose', deal.loan_purpose, 'select', canEdit, [
                  { value: 'purchase', label: 'Purchase' }, { value: 'refinance', label: 'Refinance' },
                  { value: 'refurbishment', label: 'Refurbishment' }, { value: 'capital_raise', label: 'Capital Raise' },
                  { value: 'auction', label: 'Auction Purchase' }, { value: 'other', label: 'Other' }
                ])}
                ${renderEditableField('use_of_funds', 'Use of Funds Detail', deal.use_of_funds, 'textarea', canEdit)}
                ${renderEditableField('refurb_scope', 'Refurb Scope', deal.refurb_scope, 'textarea', canEdit)}
                ${renderEditableField('refurb_cost', 'Refurb Cost (£)', deal.refurb_cost, 'money', canEdit)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: EXIT STRATEGY
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s5', 'E', 'Exit Strategy', 'Refinance or sale plan', [
        renderStatusDot(0, 'not-started', 'dip-sec-s5'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s5" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Exit Strategy -->
        ${renderFieldRow('exit-strategy', 'Exit Strategy', 'Refinance, sale, hold',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-exit-strategy">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Exit Strategy</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr;gap:8px;">
                ${renderEditableField('exit_strategy', 'Exit Plan', deal.exit_strategy, 'textarea', canEdit)}
                ${renderEditableField('additional_notes', 'Additional Notes', deal.additional_notes, 'textarea', canEdit)}
              </div>
            </div>
          </div>
        </div>

        <!-- Refinance Evidence (conditional) -->
        ${renderFieldRow('refinance-evidence', 'Refinance Evidence', 'Lender offer, pre-approval',
          ['not-started', 'not-started', 'not-started', 'not-started'], true)}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-refinance-evidence">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Refinance Evidence</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Upload lender DIP, mortgage offer, or broker confirmation via Document Repository.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 6: LEGAL & INSURANCE
  // ═══════════════════════════════════════════════════════════════════

  if (showLegalInsurance) {
  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06);${isDIPStage ? 'opacity:.45' : ''}">
      ${renderSectionHeader('s6', 'LG', 'Legal & Insurance', 'Security and insurance requirements', [
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required')
      ], isInternalUser)}

      <div id="content-s6" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Legal / Security -->
        ${renderFieldRow('legal-security', 'Legal / Security', 'Title deeds, searches, mortgage deed',
          ['not-required', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-legal-security">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Legal & Security</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Title deeds, Land Registry searches, mortgage deed, and legal opinion. Upload via Document Repository — required at Formal Offer stage.</p>
            </div>
          </div>
        </div>

        <!-- Insurance -->
        ${renderFieldRow('insurance', 'Insurance', 'Buildings insurance, landlord insurance',
          ['not-required', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-insurance">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Insurance</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Buildings insurance and landlord insurance evidence. Upload via Document Repository — required at Formal Offer stage.</p>
            </div>
          </div>
        </div>

      ${isDIPStage ? `
        <div style="padding:16px 50px;text-align:center">
          <div style="font-size:14px;margin-bottom:3px;font-weight:700">L</div>
          <div style="font-size:10px;font-weight:600;color:#94A3B8">Not required at DIP stage</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.06);margin-top:1px">Will be required for Formal Offer</div>
        </div>
      ` : ''}
      </div>
    </div>
  `;
  } // end showLegalInsurance

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 7: COMMERCIAL
  // ═══════════════════════════════════════════════════════════════════

  if (showCommercial) {
  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s7', 'C', 'Commercial', 'Fees and credit approval', [
        renderStatusDot(0, 'not-started', 'dip-sec-s7'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s7" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Fees -->
        ${renderFieldRow('fees', 'Fees', `Arrangement: ${deal.arrangement_fee_pct ? fmtPct(deal.arrangement_fee_pct) + '%' : 'TBA'}, Broker: ${deal.broker_fee_pct ? fmtPct(deal.broker_fee_pct) + '%' : 'TBA'}`,
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-fees">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Fee Structure</div>
                ${['rm','admin'].includes(role) ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">RM/ADMIN EDIT</span>' : '<span style="font-size:8px;color:#64748B;font-weight:600;background:#1a2332;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('arrangement_fee_pct', 'Arrangement Fee (%)', deal.arrangement_fee_pct, 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('broker_fee_pct', 'Broker Fee (%)', deal.broker_fee_pct, 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('commitment_fee', 'Commitment Fee (£)', deal.commitment_fee, 'money', ['rm','admin'].includes(role))}
                ${renderEditableField('retained_interest_months', 'Retained Interest (months)', deal.retained_interest_months, 'text', ['rm','admin'].includes(role))}
              </div>
            </div>
          </div>
        </div>

        <!-- Credit Approval — NOT at DIP stage, belongs in Formal Offer -->
        ${renderFieldRow('credit-approval', 'Credit Approval', 'Internal credit committee sign-off',
          ['not-required', 'not-started', isDIPStage ? 'not-started' : 'under-review', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-credit-approval">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Credit Approval</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">${isDIPStage ? 'Not required at DIP stage. Credit committee sign-off happens after AI analysis and RM review at the Formal Offer stage.' : 'Internal credit committee sign-off. This is populated automatically after the AI analysis and RM/Credit review.'}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  } // end showCommercial

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 8: DOCUMENTS ISSUED
  // ═══════════════════════════════════════════════════════════════════

  if (showDocsIssued) {
  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s8', 'D', 'Documents Issued', 'Deal documentation status', [
        renderStatusDot(deal.dip_signed ? 1 : 0, deal.dip_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.ts_signed ? 1 : 0, deal.ts_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.fl_signed ? 1 : 0, deal.fl_signed ? 'signed' : 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s8" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- DIP -->
        ${renderFieldRow('dip-document', 'Data Information Package (DIP)', 'Initial deal summary and requirements',
          [deal.dip_signed ? 'signed' : 'submitted', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-dip-document">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Data Information Package (DIP)</div>
              <div style="font-size:13px;color:#64748B;">${deal.dip_signed ? 'Signed and issued.' : deal.dip_issued_at ? 'Issued — awaiting signature.' : 'Will be generated once all required fields are populated.'}</div>
            </div>
          </div>
        </div>

        <!-- Indicative TS -->
        ${renderFieldRow('indicative-ts', 'Indicative Term Sheet', 'Initial lending terms and conditions',
          ['locked', deal.ts_signed ? 'signed' : 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-indicative-ts">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Indicative Term Sheet</div>
              <div style="font-size:13px;color:#64748B;">${deal.ts_signed ? 'Signed and accepted.' : 'Generated after DIP is signed and commitment fee is paid.'}</div>
            </div>
          </div>
        </div>

        <!-- Formal Offer -->
        ${renderFieldRow('formal-offer', 'Formal Offer Letter', 'Final binding lending terms',
          ['locked', 'locked', deal.fl_signed ? 'signed' : 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-formal-offer">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Formal Offer Letter</div>
              <div style="font-size:13px;color:#64748B;">${deal.fl_signed ? 'Signed — proceeding to legal.' : 'Issued after underwriting and bank approval.'}</div>
            </div>
          </div>
        </div>

        <!-- Execution & Completion -->
        ${renderFieldRow('execution-completion', 'Execution & Completion', 'Legal docs and completion statement',
          ['locked', 'locked', 'locked', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-execution-completion">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Execution & Completion</div>
              <div style="font-size:13px;color:#64748B;">Final legal documentation and completion statement. Generated at the execution stage.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  } // end showDocsIssued
  // ═══════════════════════════════════════════════════════════════════
  // DOCUMENT REPOSITORY (within Matrix — categorised view of uploaded docs)
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:16px 26px;border-top:1px solid rgba(255,255,255,0.06);background:#1a2332">
      <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:10px">Document Repository</div>

      <!-- Category tabs -->
      <div style="display:flex;gap:1px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.06);border-radius:6px;overflow:hidden">
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#111827;color:#F1F5F9;border-right:1px solid rgba(255,255,255,0.06);transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('all')">All</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1a2332;color:#64748B;border-right:1px solid rgba(255,255,255,0.06);transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('kyc')">KYC/ID</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1a2332;color:#64748B;border-right:1px solid rgba(255,255,255,0.06);transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('financial')">Financial</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1a2332;color:#64748B;border-right:1px solid rgba(255,255,255,0.06);transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('property')">Property</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1a2332;color:#64748B;border-right:1px solid rgba(255,255,255,0.06);transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('legal')">Legal</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1a2332;color:#64748B;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('issued')">Issued Docs</button>
      </div>

      <!-- Document table placeholder -->
      <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:12px;font-size:9px;color:#64748B;text-align:center">
        <div style="font-size:14px;margin-bottom:4px;font-weight:700">D</div>
        Documents will appear here once uploaded
      </div>

      <!-- Upload drop zone -->
      <div style="border:2px dashed rgba(255,255,255,0.06);border-radius:7px;padding:12px;text-align:center;background:#111827;cursor:pointer;transition:all .12s;margin-top:10px">
        <div style="font-size:18px">📁</div>
        <div style="font-size:10px;color:#64748B;font-weight:500;margin-top:2px">Drop documents here or click to upload</div>
        <div style="font-size:8px;color:#94A3B8;margin-top:1px">PDF, Word, Excel, images supported</div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // AUTO-FILL BAR (BOTTOM)
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <!-- Hidden file input for Upload -->
    <input type="file" id="matrix-parse-file-input" multiple accept=".pdf,.doc,.docx,.xlsx,.xls,.jpg,.jpeg,.png,.txt,.csv" style="display:none" onchange="window.matrixUploadFiles && window.matrixUploadFiles(this.files)" />

    <!-- Paste Broker Pack modal (hidden by default) -->
    <div id="matrix-paste-modal" style="display:none;padding:16px 26px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(212,168,83,0.15);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:700;color:#E8C97A;">Paste Broker Pack / Email / WhatsApp</div>
        <button onclick="document.getElementById('matrix-paste-modal').style.display='none'" style="padding:4px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:5px;font-size:11px;cursor:pointer;background:#111827;color:#64748B;">Cancel</button>
      </div>
      <textarea id="matrix-paste-text" placeholder="Paste the broker pack, email, or WhatsApp message here..." style="width:100%;min-height:120px;padding:12px;border:1px solid rgba(212,168,83,0.25);border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;outline:none;"></textarea>
      <button onclick="window.matrixParsePastedText && window.matrixParsePastedText()" style="margin-top:10px;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:600;border:none;background:#D4A853;color:#fff;cursor:pointer;">Parse Text</button>
    </div>

    <!-- Parse progress indicator (hidden by default) -->
    <div id="matrix-parse-progress" style="display:none;padding:16px 26px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(212,168,83,0.15);text-align:center;">
      <div style="font-size:14px;font-weight:700;color:#D4A853;margin-bottom:6px;" id="matrix-parse-status">Processing...</div>
      <div style="font-size:12px;color:#64748B;">AI is working. This may take up to 2 minutes.</div>
      <div style="margin-top:10px;height:4px;background:rgba(212,168,83,0.25);border-radius:4px;overflow:hidden;"><div style="height:100%;width:0%;background:#D4A853;border-radius:4px;animation:matrixParseBar 90s linear forwards;" id="matrix-parse-bar"></div></div>
    </div>

    <!-- COMPLETENESS INDICATOR -->
    <div id="matrix-completeness-bar" style="padding:14px 26px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(52,211,153,0.1);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;color:#34D399;">Matrix Completeness</div>
        <div style="font-size:14px;font-weight:800;color:#34D399;" id="matrix-completeness-pct">0%</div>
      </div>
      <div style="height:8px;background:rgba(52,211,153,0.1);border-radius:4px;overflow:hidden;">
        <div id="matrix-completeness-fill" style="height:100%;width:0%;background:#34D399;border-radius:4px;transition:width 0.5s ease;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:#64748B;">
        <span id="matrix-completeness-detail">0 of 0 key fields completed</span>
        <span id="matrix-completeness-status" style="font-weight:600;"></span>
      </div>
    </div>

    <!-- ACTION BUTTONS BAR -->
    <div style="padding:12px 26px;border-top:1px solid rgba(255,255,255,0.06);background:#111827;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="document.getElementById('matrix-parse-file-input').click()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#D4A853;color:#fff;cursor:pointer;transition:all .12s" title="Upload supporting documents">Upload Documents</button>
        ${isInternalUser || currentStage === 'received' ? `
        <button onclick="document.getElementById('matrix-paste-modal').style.display='block'" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#D4A853;color:#fff;cursor:pointer;transition:all .12s" title="Paste broker text for AI parsing">Paste Broker Pack</button>
        ` : ''}
        <button onclick="window.matrixParseConfirmed && window.matrixParseConfirmed()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#D4A853;color:#fff;cursor:pointer;transition:all .12s" title="Parse confirmed documents and extract deal data into matrix fields">Parse Confirmed Docs</button>
        ${currentStage === 'received' ? `
        <button onclick="window.matrixSubmitForReview && window.matrixSubmitForReview()" id="matrix-submit-review-btn" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#34D399;color:#fff;cursor:pointer;transition:all .12s" title="Step 4: Submit deal for RM review">Submit for Review</button>
        ` : `
        <button id="matrix-submit-review-btn" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:rgba(52,211,153,0.2);color:#34D399;cursor:default;transition:all .12s" disabled>✅ Submitted for Review</button>
        `}
        <button onclick="window.matrixOpenIncomplete && window.matrixOpenIncomplete()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.1);color:#60A5FA;cursor:pointer;transition:all .12s" title="Expand only sections that have incomplete fields">Open Incomplete</button>
      </div>
      <div style="display:flex;gap:12px;font-size:8px;color:rgba(255,255,255,0.06)">
        <span>Last Parsed: <span id="matrix-last-parsed">never</span></span>
        <span>•</span>
        <span>Fields Auto-Filled: <span id="matrix-fields-filled">0</span></span>
        <span>•</span>
        <span>Confidence: <span id="matrix-confidence">0%</span></span>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // LEGEND
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:12px 26px 16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;flex-wrap:wrap;gap:6px 12px;font-size:8px;color:#64748B">
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:rgba(52,211,153,0.1)"></span>Approved</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:rgba(212,168,83,0.15)"></span>Requested</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:rgba(212,168,83,0.25)"></span>Submitted</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:rgba(255,255,255,0.06)"></span>Not Started</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:rgba(251,191,36,0.1)"></span>Evidenced</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#34D399"></span>Signed</span>
    </div>
  `;

  // Inject into DOM
  container.innerHTML = html;

  // ── Persist sensible defaults if not already set ──
  // Term defaults to 12 months, interest servicing defaults to retained
  (function applyDefaults() {
    const defaults = {};
    if (!deal.term_months) defaults.term_months = '12';
    if (!deal.interest_servicing) defaults.interest_servicing = 'retained';
    if (Object.keys(defaults).length > 0 && deal.submission_id) {
      Object.assign(deal, defaults); // update in-memory
      fetchWithAuth(`${API_BASE}/api/deals/${deal.submission_id}/matrix-fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defaults)
      }).catch(() => {});
    }
  })();

  // ═══════════════════════════════════════════════════════════════════
  // ATTACH GLOBAL FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  window.matrixToggleSection = function(sectionId) {
    const content = document.getElementById(`content-${sectionId}`);
    const chevron = document.getElementById(`chevron-${sectionId}`);
    const header = document.querySelector(`[data-section-header="${sectionId}"]`);
    if (content) {
      const isOpen = content.style.maxHeight !== '0px';
      content.style.maxHeight = isOpen ? '0px' : '8000px';
      content.style.overflow = 'hidden';
      if (chevron) {
        chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
        chevron.style.background = isOpen ? 'rgba(255,255,255,0.06)' : 'rgba(212,168,83,0.25)';
        chevron.style.color = isOpen ? '#94A3B8' : '#D4A853';
      }
      // Highlight open section header
      if (header) {
        header.style.borderLeft = isOpen ? 'none' : '3px solid #D4A853';
        header.style.background = isOpen ? '' : 'rgba(212,168,83,0.06)';
      }
    }
  };

  window.matrixToggleDetail = function(detailId) {
    const detail = document.getElementById(detailId);
    if (detail) {
      const isOpen = detail.style.maxHeight !== '0px';
      detail.style.maxHeight = isOpen ? '0px' : '4000px';
      detail.style.overflow = 'hidden';
      // Highlight the field row that triggered this detail
      const fieldKey = detailId.replace('detail-', '');
      const rows = document.querySelectorAll(`[onclick*="'${detailId}'"]`);
      rows.forEach(row => {
        row.style.borderLeft = isOpen ? 'none' : '3px solid #60A5FA';
        row.style.background = isOpen ? '' : 'rgba(96,165,250,0.06)';
      });
    }
  };

  // ── Open only sections that have incomplete fields ──
  window.matrixOpenIncomplete = function() {
    const readiness = calculateDipReadiness();
    // Map readiness section names to matrix section IDs
    const sectionMap = {
      'Borrower / KYC': 's1',
      'Borrower Financials': 's2',
      'Property / Security': 's3',
      'Loan Terms': 's4',
      'Exit Strategy': 's5',
      'Fees': 's7',
      'AML & Source of Funds': 's2'
    };
    // First close all sections
    for (let i = 1; i <= 8; i++) {
      const content = document.getElementById(`content-s${i}`);
      const chevron = document.getElementById(`chevron-s${i}`);
      if (content) {
        content.style.maxHeight = '0px';
        content.style.overflow = 'hidden';
      }
      if (chevron) {
        chevron.style.transform = 'rotate(0deg)';
        chevron.style.background = 'rgba(255,255,255,0.06)';
        chevron.style.color = '#94A3B8';
      }
    }
    // Open incomplete sections and scroll to first one
    let firstIncomplete = null;
    const opened = new Set();
    const allMissing = [];
    for (const [name, sec] of Object.entries(readiness.sections)) {
      if (sec.status !== 'ready') {
        const sId = sectionMap[name];
        if (sId && !opened.has(sId)) {
          opened.add(sId);
          window.matrixToggleSection(sId);
          if (!firstIncomplete) firstIncomplete = sId;
        }
        if (sec.missing) allMissing.push(...sec.missing);
      }
    }
    // Scroll to first incomplete section
    if (firstIncomplete) {
      const header = document.querySelector(`[data-section-header="${firstIncomplete}"]`);
      if (header) header.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Highlight all missing fields with red border
    if (allMissing.length > 0) {
      setTimeout(() => {
        document.querySelectorAll('.matrix-field-highlight').forEach(el => {
          el.classList.remove('matrix-field-highlight');
          el.style.removeProperty('border-color');
          el.style.removeProperty('box-shadow');
        });
        allMissing.forEach(fieldName => {
          const input = document.querySelector(`[data-field="${fieldName}"]`);
          if (input) {
            input.classList.add('matrix-field-highlight');
            input.style.borderColor = '#F87171';
            input.style.boxShadow = '0 0 0 2px rgba(248,113,113,0.35)';
            setTimeout(() => {
              input.classList.remove('matrix-field-highlight');
              input.style.removeProperty('border-color');
              input.style.removeProperty('box-shadow');
            }, 4000);
          }
        });
      }, 350);
    }
  };

  // ── Scroll to a DIP section from the readiness checklist ──
  window.matrixScrollToSection = function(sectionId, missingFields) {
    const header = document.querySelector(`[data-section-header="${sectionId}"]`);
    const content = document.getElementById(`content-${sectionId}`);
    if (header) {
      // Open section if closed
      if (content && content.style.maxHeight === '0px') {
        window.matrixToggleSection(sectionId);
      }
      // Smooth scroll to section header
      header.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight flash on header
      header.style.background = 'rgba(212,168,83,0.15)';
      setTimeout(() => { header.style.background = ''; }, 1500);

      // Highlight missing fields with red border pulse
      if (missingFields && missingFields.length > 0) {
        // Small delay so section has time to expand
        setTimeout(() => {
          // Clear any previous highlights
          document.querySelectorAll('.matrix-field-highlight').forEach(el => {
            el.classList.remove('matrix-field-highlight');
            el.style.removeProperty('border-color');
            el.style.removeProperty('box-shadow');
          });

          let firstField = null;
          missingFields.forEach(fieldName => {
            const input = document.querySelector(`[data-field="${fieldName}"]`);
            if (input) {
              if (!firstField) firstField = input;
              input.classList.add('matrix-field-highlight');
              input.style.borderColor = '#F87171';
              input.style.boxShadow = '0 0 0 2px rgba(248,113,113,0.35)';
              // Auto-clear after 4 seconds
              setTimeout(() => {
                input.classList.remove('matrix-field-highlight');
                input.style.removeProperty('border-color');
                input.style.removeProperty('box-shadow');
              }, 4000);
            }
          });
          // Scroll to first missing field for precision
          if (firstField) {
            setTimeout(() => {
              firstField.scrollIntoView({ behavior: 'smooth', block: 'center' });
              firstField.focus();
            }, 200);
          }
        }, 350);
      }
    }
  };

  // ── Validate and save — wraps matrixSaveField with type checks ──
  window.matrixValidateAndSave = function(fieldKey, rawValue, dataType) {
    const el = document.getElementById(`mf-${fieldKey}`);
    const errEl = document.getElementById(`err-${fieldKey}`);

    // Clear previous error
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (el) el.style.borderColor = 'rgba(255,255,255,0.06)';

    // Empty is always valid (not a required-check — readiness handles that)
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) {
      window.matrixSaveField(fieldKey, '');
      return;
    }

    // Money: format with commas for display, save raw number
    if (dataType === 'money') {
      const raw = stripCommas(trimmed);
      if (!/^\d+\.?\d{0,2}$/.test(raw)) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Enter a valid amount (e.g. 1,500,000)'; errEl.style.display = 'block'; }
        return;
      }
      // Update display with commas
      if (el) el.value = formatWithCommas(raw);
      window.matrixSaveField(fieldKey, raw);
      return;
    }

    // Email validation
    if (dataType === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Enter a valid email address'; errEl.style.display = 'block'; }
        return;
      }
    }

    // Phone validation
    if (dataType === 'tel') {
      if (!/^[\d\s\+\-\(\)]{7,20}$/.test(trimmed)) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Enter a valid phone number'; errEl.style.display = 'block'; }
        return;
      }
    }

    // Date validation
    if (dataType === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Enter date as YYYY-MM-DD'; errEl.style.display = 'block'; }
        return;
      }
    }

    // Percentage fields
    if (fieldKey.includes('_pct') || fieldKey.includes('ltv')) {
      const num = parseFloat(trimmed);
      if (isNaN(num) || num < 0 || num > 100) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Enter a percentage between 0 and 100'; errEl.style.display = 'block'; }
        return;
      }
    }

    // Term months — minimum 12, max 24
    if (fieldKey === 'term_months') {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 3 || num > 24) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Term must be 3–24 months (standard: 12)'; errEl.style.display = 'block'; }
        return;
      }
    }

    // All good — save
    window.matrixSaveField(fieldKey, trimmed);
  };

  // ── Matrix field auto-save on blur ──
  window.matrixSaveField = async function(fieldKey, value) {
    const submissionId = deal.submission_id;
    if (!submissionId) return;

    const el = document.getElementById(`mf-${fieldKey}`);
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/matrix-fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldKey]: value })
      });

      if (resp.ok) {
        // Flash green border to confirm save
        if (el) {
          el.style.borderColor = '#34D399';
          setTimeout(() => { el.style.borderColor = 'rgba(255,255,255,0.06)'; }, 1200);
        }
        // Update deal object in memory so subsequent calculations use fresh data
        deal[fieldKey] = value;

        // Auto-calculate LTV when loan_amount changes
        if (fieldKey === 'loan_amount') {
          const valuation = portfolioValuation();
          const loanVal = parseFloat(stripCommas(String(value))) || 0;
          if (valuation > 0 && loanVal > 0) {
            const ltv = ((loanVal / valuation) * 100).toFixed(1);
            const ltvEl = document.getElementById('mf-ltv_requested');
            if (ltvEl) {
              ltvEl.value = ltv;
              ltvEl.style.borderColor = '#34D399';
              setTimeout(() => { ltvEl.style.borderColor = 'rgba(255,255,255,0.06)'; }, 1200);
            }
            deal.ltv_requested = ltv;
            // Save LTV to backend too
            fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/matrix-fields`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ltv_requested: ltv })
            }).catch(() => {});
          }
        }

        // Recalculate completeness and loan limit after every save
        calculateCompleteness();
        updateLoanLimitIndicator();
      } else {
        const err = await resp.json().catch(() => ({}));
        if (el) el.style.borderColor = '#F87171';
        showToast(err.error || 'Failed to save field', 'error');
      }
    } catch (e) {
      console.error('[matrix-save] Error saving field:', fieldKey, e);
      if (el) el.style.borderColor = '#F87171';
      showToast('Connection error saving field', 'error');
    }
  };

  // ── Loan limit indicator — updates dynamically after every save ──
  function updateLoanLimitIndicator() {
    const el = document.getElementById('loan-limit-indicator');
    if (!el) return;

    const valuation = portfolioValuation();
    const purchasePrice = portfolioPurchasePrice();
    const loanAmt = parseFloat(stripCommas(String(deal.loan_amount || '0'))) || 0;
    const maxOnVal = valuation ? Math.floor(valuation * 0.75) : 0;
    const maxOnPP = purchasePrice ? Math.floor(purchasePrice * 0.90) : 0;
    const limits = [maxOnVal, maxOnPP].filter(v => v > 0);
    const maxLoan = limits.length > 0 ? Math.min(...limits) : 0;
    const binding = maxLoan === maxOnVal ? '75% of valuation' : '90% of purchase price';
    const overLimit = loanAmt > 0 && maxLoan > 0 && loanAmt > maxLoan;
    const withinLimit = loanAmt > 0 && maxLoan > 0 && !overLimit;
    const actualLtv = valuation > 0 && loanAmt > 0 ? ((loanAmt / valuation) * 100).toFixed(1) : null;

    if (!maxLoan) {
      el.innerHTML = '<div style="font-size:10px;color:#64748B;margin-top:4px;padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:6px;">Max loan will calculate once valuation and/or purchase price are entered.</div>';
      return;
    }

    const borderColor = overLimit ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.2)';
    const bgColor = overLimit ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.08)';
    const amtColor = overLimit ? '#F87171' : '#34D399';

    el.style.marginTop = '6px';
    el.style.padding = '8px 12px';
    el.style.borderRadius = '8px';
    el.style.fontSize = '11px';
    el.style.background = bgColor;
    el.style.border = '1px solid ' + borderColor;

    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">'
      + '<span style="color:#94A3B8;">Max Allowable Loan:</span>'
      + '<span style="font-weight:700;color:' + amtColor + ';">£' + maxLoan.toLocaleString() + '</span>'
      + '</div>'
      + '<div style="font-size:9px;color:#64748B;margin-top:3px;">Based on ' + binding
      + (maxOnVal ? ' · Val: £' + valuation.toLocaleString() + ' × 75% = £' + maxOnVal.toLocaleString() : '')
      + (maxOnPP ? ' · PP: £' + purchasePrice.toLocaleString() + ' × 90% = £' + maxOnPP.toLocaleString() : '')
      + '</div>'
      + (actualLtv ? '<div style="font-size:9px;color:#64748B;margin-top:2px;">Actual Day-1 LTV: ' + actualLtv + '%</div>' : '')
      + (overLimit ? '<div style="font-size:10px;font-weight:600;color:#F87171;margin-top:4px;">⚠ Requested loan exceeds maximum by £' + (loanAmt - maxLoan).toLocaleString() + '</div>' : '')
      + (withinLimit ? '<div style="font-size:10px;font-weight:600;color:#34D399;margin-top:4px;">✓ Within lending policy limits</div>' : '');
  }
  // Render on page load
  updateLoanLimitIndicator();

  // ── Max LTV button — sets loan amount to max allowable ──
  window.matrixApplyMaxLoan = function() {
    const valuation = portfolioValuation();
    const purchasePrice = portfolioPurchasePrice();

    if (!valuation && !purchasePrice) {
      showToast('Need valuation or purchase price to calculate max loan', 'error');
      return;
    }

    const maxOnVal = valuation ? Math.floor(valuation * 0.75) : Infinity;
    const maxOnPP = purchasePrice ? Math.floor(purchasePrice * 0.90) : Infinity;
    const maxLoan = Math.min(maxOnVal, maxOnPP);
    const ltv = valuation > 0 ? ((maxLoan / valuation) * 100).toFixed(1) : '75.0';

    // Set loan amount
    const loanEl = document.getElementById('mf-loan_amount');
    if (loanEl) {
      loanEl.value = formatWithCommas(String(maxLoan));
      window.matrixSaveField('loan_amount', String(maxLoan));
    }

    // Set LTV
    const ltvEl = document.getElementById('mf-ltv_requested');
    if (ltvEl) {
      ltvEl.value = ltv;
      window.matrixSaveField('ltv_requested', ltv);
    }

    showToast(`Max loan set: £${maxLoan.toLocaleString()} (${ltv}% LTV)`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  // PARSE FUNCTIONS — Upload & Parse, Paste Broker Pack, Re-Parse All
  // ═══════════════════════════════════════════════════════════════════

  function showParseProgress(message) {
    floatingProgress.show({ label: 'Parsing Documents', message: message || 'AI is reading your documents...' });
    // Hide paste modal
    const modal = document.getElementById('matrix-paste-modal');
    if (modal) modal.style.display = 'none';
  }

  function hideParseProgress() {
    // Don't dismiss here — let the caller show complete/error instead
  }

  // ═══════════════════════════════════════════════════════════════════
  // FIELD LABELS — human-readable names for parsed keys
  // ═══════════════════════════════════════════════════════════════════
  const FIELD_LABELS = {
    borrower_name: 'Borrower Name', borrower_email: 'Email', borrower_phone: 'Phone',
    borrower_dob: 'Date of Birth', borrower_nationality: 'Nationality', borrower_type: 'Borrower Type',
    company_name: 'Company Name', company_number: 'Company Number',
    ch_role_verification: 'CH Role Verification (verify borrower roles against Companies House)',
    security_address: 'Property Address', security_postcode: 'Postcode',
    asset_type: 'Asset Type', property_tenure: 'Tenure', occupancy_status: 'Occupancy',
    current_use: 'Current Use', current_value: 'Current Value', purchase_price: 'Purchase Price',
    loan_amount: 'Loan Amount', ltv_requested: 'LTV %', term_months: 'Term (months)',
    rate_requested: 'Rate %/month', interest_servicing: 'Interest Servicing',
    drawdown_date: 'Drawdown Date', loan_purpose: 'Purpose', use_of_funds: 'Use of Funds',
    refurb_scope: 'Refurb Scope', refurb_cost: 'Refurb Cost',
    exit_strategy: 'Exit Strategy', additional_notes: 'Notes',
    deposit_source: 'Source of Deposit', existing_charges: 'Existing Charges',
    concurrent_transactions: 'Concurrent Transactions',
    broker_name: 'Broker Name', broker_company: 'Broker Company', broker_fca: 'Broker FCA',
    arrangement_fee_pct: 'Arrangement Fee %', broker_fee_pct: 'Broker Fee %',
    commitment_fee: 'Commitment Fee', retained_interest_months: 'Retained Interest (months)',
    estimated_net_worth: 'Est. Net Worth', source_of_wealth: 'Source of Wealth'
  };

  const FIELD_SECTIONS = {
    'Borrower / KYC': ['borrower_name', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality', 'borrower_type', 'company_name', 'company_number'],
    'Property': ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'occupancy_status', 'current_use', 'current_value', 'purchase_price'],
    'Loan Terms': ['loan_amount', 'ltv_requested', 'term_months', 'rate_requested', 'interest_servicing', 'drawdown_date', 'loan_purpose', 'use_of_funds', 'refurb_scope', 'refurb_cost'],
    'Exit / AML': ['exit_strategy', 'deposit_source', 'existing_charges', 'concurrent_transactions', 'additional_notes'],
    'Broker / Commercial': ['broker_name', 'broker_company', 'broker_fca', 'arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee', 'retained_interest_months']
  };

  const ALL_FIELD_KEYS = Object.values(FIELD_SECTIONS).flat();

  // ═══════════════════════════════════════════════════════════════════
  // SHOW PARSED DATA IN PARSER SECTION — review before accepting
  // ═══════════════════════════════════════════════════════════════════
  let _lastParsedData = null; // store for Accept All
  let _lastConflicts = {};    // store conflicts from multi-doc extraction
  let _lastCoreFields = [];   // core structure fields list from backend
  let _pendingNewBorrower = null;  // stored when entity card renders — survives data overwrites
  let _pendingNewProperty = null;  // stored when entity card renders — survives data overwrites

  // Core structure fields (mirrored from backend — used for UI tagging)
  const CORE_STRUCTURE_FIELDS = [
    'borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone',
    'borrower_dob', 'borrower_nationality',
    'company_name', 'company_number',
    'security_address', 'security_postcode',
    'asset_type', 'property_tenure',
    'loan_purpose'
  ];

  // Entity groupings — fields that belong to a single person or property
  const BORROWER_ENTITY_FIELDS = ['borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality', 'borrower_jurisdiction', 'company_name', 'company_number'];
  const PROPERTY_ENTITY_FIELDS = ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'occupancy_status', 'current_use', 'current_value', 'purchase_price'];

  function showParsedResults(parsedData, conflicts, coreFields) {
    if (!parsedData || typeof parsedData !== 'object') return;
    _lastParsedData = parsedData;
    _lastConflicts = conflicts || {};
    if (coreFields) _lastCoreFields = coreFields;

    const confidence = parsedData.confidence != null ? Math.round(parsedData.confidence * 100) : null;
    const parserFields = document.getElementById('parser-fields');
    const parserActions = document.getElementById('parser-actions');
    const parserContent = document.getElementById('parser-content');
    if (!parserFields) return;

    const extracted = ALL_FIELD_KEYS.filter(k => parsedData[k] != null && parsedData[k] !== '');
    const confColor = confidence >= 80 ? '#34D399' : confidence >= 50 ? '#D4A853' : '#F87171';

    // ── Detect new borrower / property entities FIRST (before conflicts banner) ──
    const matrixBorrowerEl = document.getElementById('mf-borrower_name');
    const matrixBorrower = matrixBorrowerEl ? matrixBorrowerEl.value.trim() : '';
    const parsedBorrower = parsedData.borrower_name ? String(parsedData.borrower_name).trim() : '';
    const hasNewBorrower = matrixBorrower && parsedBorrower && matrixBorrower.toLowerCase() !== parsedBorrower.toLowerCase();

    const matrixPropertyEl = document.getElementById('mf-security_address');
    const matrixProperty = matrixPropertyEl ? matrixPropertyEl.value.trim() : '';
    const parsedPropertyAddr = parsedData.security_address ? String(parsedData.security_address).trim() : '';
    const hasNewProperty = matrixProperty && parsedPropertyAddr && matrixProperty.toLowerCase() !== parsedPropertyAddr.toLowerCase();

    // Filter conflicts — remove borrower/property fields that will be handled by entity cards
    const entityHandledFields = [
      ...(hasNewBorrower ? BORROWER_ENTITY_FIELDS : []),
      ...(hasNewProperty ? PROPERTY_ENTITY_FIELDS : [])
    ];
    const filteredConflictKeys = Object.keys(_lastConflicts).filter(k => !entityHandledFields.includes(k));

    // Build summary header — show only non-entity conflicts count
    let html = `
      <div style="background:rgba(212,168,83,0.15);border:1px solid rgba(212,168,83,0.25);border-radius:8px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:700;color:#111827;">AI Extraction Results</div>
          <div style="font-size:12px;color:#64748B;margin-top:2px;">${extracted.length} fields extracted from your documents</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${hasNewBorrower ? `<div style="text-align:center;"><div style="font-size:16px;">&#34D399;</div><div style="font-size:9px;color:#D4A853;font-weight:600;">NEW PERSON</div></div>` : ''}
          ${hasNewProperty ? `<div style="text-align:center;"><div style="font-size:16px;">&#34D399;</div><div style="font-size:9px;color:#34D399;font-weight:600;">NEW PROPERTY</div></div>` : ''}
          ${filteredConflictKeys.length > 0 ? `<div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:#F87171;">${filteredConflictKeys.length}</div><div style="font-size:9px;color:#F87171;font-weight:600;">CONFLICTS</div></div>` : ''}
          ${confidence != null ? `<div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:${confColor};">${confidence}%</div><div style="font-size:9px;color:#64748B;font-weight:600;">CONFIDENCE</div></div>` : ''}
          <div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:#D4A853;">${extracted.length}</div><div style="font-size:9px;color:#64748B;font-weight:600;">FIELDS</div></div>
        </div>
      </div>`;

    // Show conflicts banner ONLY for non-entity fields
    if (filteredConflictKeys.length > 0) {
      html += `
        <div style="background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2);border-radius:8px;padding:12px 16px;margin-bottom:16px;">
          <div style="font-size:13px;font-weight:700;color:#F87171;margin-bottom:8px;">&#9888; ${filteredConflictKeys.length} Conflicting Field${filteredConflictKeys.length > 1 ? 's' : ''} Detected</div>
          <div style="font-size:11px;color:#F87171;margin-bottom:10px;">Different documents contain different values for these core deal fields. Please select the correct value for each.</div>`;

      for (const field of filteredConflictKeys) {
        const options = _lastConflicts[field];
        const label = FIELD_LABELS[field] || field;
        html += `
          <div style="background:#111827;border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:10px 14px;margin-bottom:8px;">
            <div style="font-size:12px;font-weight:700;color:#111827;margin-bottom:6px;">${label}</div>`;
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const catBadge = opt.category ? `<span style="padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.06);color:#475569;font-size:9px;font-weight:600;margin-left:6px;">${opt.category.toUpperCase()}</span>` : '';
          const srcName = opt.filename ? `<span style="font-size:10px;color:#94A3B8;margin-left:6px;">from: ${opt.filename.substring(0, 40)}</span>` : '';
          const isWinner = String(opt.value) === String(parsedData[field]);
          html += `
            <div style="display:flex;align-items:center;padding:5px 10px;border-radius:5px;margin-bottom:3px;background:${isWinner ? 'rgba(52,211,153,0.1)' : '#fff'};border:1px solid ${isWinner ? 'rgba(52,211,153,0.2)' : '#1a2332'};">
              <div style="flex:1;font-size:13px;color:#F1F5F9;font-weight:${isWinner ? '600' : '400'};">
                ${String(opt.value)}${catBadge}${srcName}
                ${isWinner ? '<span style="font-size:10px;color:#34D399;font-weight:700;margin-left:8px;">&#10003; SELECTED (highest priority)</span>' : ''}
              </div>
              ${!isWinner ? `<button onclick="window.resolveConflict('${field}', ${i})" style="padding:2px 10px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:#D4A853;color:#fff;">Use This</button>` : ''}
            </div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    // Build grouped field table
    for (const [sectionName, fields] of Object.entries(FIELD_SECTIONS)) {
      const sectionFields = fields.filter(k => parsedData[k] != null && parsedData[k] !== '');
      if (sectionFields.length === 0) continue;

      html += `
        <div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.4px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:6px;">${sectionName}</div>`;

      // ── NEW PERSON DETECTED card ──
      if (sectionName === 'Borrower / KYC' && hasNewBorrower) {
        // Snapshot borrower data NOW — _lastParsedData may get overwritten by later events
        _pendingNewBorrower = {
          borrower_name: parsedData.borrower_name,
          borrower_type: parsedData.borrower_type || 'individual',
          borrower_email: parsedData.borrower_email || null,
          borrower_phone: parsedData.borrower_phone || null,
          borrower_dob: parsedData.borrower_dob || null,
          borrower_nationality: parsedData.borrower_nationality || null,
          borrower_jurisdiction: parsedData.borrower_jurisdiction || null,
          company_name: parsedData.company_name || null,
          company_number: parsedData.company_number || null
        };
        console.log('[deal-matrix] Stored _pendingNewBorrower:', _pendingNewBorrower);
        const parsedType = parsedData.borrower_type || 'individual';
        const parsedCompany = parsedData.company_name ? ` (${parsedData.company_name})` : '';
        const btnStyle = 'padding:6px 14px;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s;';
        html += `
          <div id="new-borrower-card" style="background:linear-gradient(135deg,rgba(212,168,83,0.15),rgba(212,168,83,0.1));border:2px solid #D4A853;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:20px;">&#34D399;</span>
              <div>
                <div style="font-size:14px;font-weight:700;color:#111827;">New Person Detected</div>
                <div style="font-size:11px;color:#64748B;">This document identifies a different person from the current borrower</div>
              </div>
            </div>
            <div style="display:flex;gap:16px;background:#111827;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;">Current in Matrix</div>
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;margin-top:2px;">${sanitizeHtml(matrixBorrower)}</div>
              </div>
              <div style="color:rgba(255,255,255,0.06);font-size:20px;align-self:center;">&#8594;</div>
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#D4A853;text-transform:uppercase;letter-spacing:.5px;">Parsed from Document</div>
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;margin-top:2px;">${sanitizeHtml(parsedBorrower)}${sanitizeHtml(parsedCompany)}</div>
                <div style="font-size:10px;color:#64748B;margin-top:1px;">Type: ${sanitizeHtml(parsedType)}</div>
              </div>
            </div>
            <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:8px;">What would you like to do with this person?</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button onclick="window.addParsedAsBorrower('primary')" style="${btnStyle}background:#D4A853;color:#fff;" title="Add as a joint/additional borrower">&#43; Add as Borrower</button>
              <button onclick="window.addParsedAsBorrower('guarantor')" style="${btnStyle}background:#D4A853;color:#fff;" title="Add as a personal guarantor">&#43; Add as Guarantor</button>
              <button onclick="window.addParsedAsBorrower('director')" style="${btnStyle}background:#34D399;color:#fff;" title="Add as a company director">&#43; Add as Director</button>
              <button onclick="window.replaceBorrowerFromParsed()" style="${btnStyle}background:#D4A853;color:#fff;" title="Replace the existing borrower with this person">&#8635; Replace Existing</button>
              <button onclick="document.getElementById('new-borrower-card').style.display='none'" style="${btnStyle}background:#1a2332;color:#64748B;" title="Ignore this person">Ignore</button>
            </div>
          </div>`;
      }

      // ── NEW PROPERTY DETECTED card ──
      if (sectionName === 'Property' && hasNewProperty) {
        // Snapshot property data NOW — _lastParsedData may get overwritten by later events
        _pendingNewProperty = {
          security_address: parsedData.security_address,
          security_postcode: parsedData.security_postcode || null,
          asset_type: parsedData.asset_type || null,
          property_tenure: parsedData.property_tenure || null,
          occupancy_status: parsedData.occupancy_status || null,
          current_use: parsedData.current_use || null,
          current_value: parsedData.current_value || null,
          purchase_price: parsedData.purchase_price || null
        };
        console.log('[deal-matrix] Stored _pendingNewProperty:', _pendingNewProperty);
        const parsedPostcode = parsedData.security_postcode ? `, ${parsedData.security_postcode}` : '';
        const parsedAssetType = parsedData.asset_type ? ` (${parsedData.asset_type})` : '';
        const btnStyle = 'padding:6px 14px;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s;';
        html += `
          <div id="new-property-card" style="background:linear-gradient(135deg,rgba(52,211,153,0.1),rgba(52,211,153,0.1));border:2px solid #34D399;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:20px;">&#34D399;</span>
              <div>
                <div style="font-size:14px;font-weight:700;color:#111827;">New Property Detected</div>
                <div style="font-size:11px;color:#64748B;">This document references a different property from the current security</div>
              </div>
            </div>
            <div style="display:flex;gap:16px;background:#111827;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;">Current in Matrix</div>
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;margin-top:2px;">${sanitizeHtml(matrixProperty.substring(0, 80))}</div>
              </div>
              <div style="color:rgba(255,255,255,0.06);font-size:20px;align-self:center;">&#8594;</div>
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#34D399;text-transform:uppercase;letter-spacing:.5px;">Parsed from Document</div>
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;margin-top:2px;">${sanitizeHtml(parsedPropertyAddr)}${sanitizeHtml(parsedPostcode)}</div>
                ${parsedAssetType ? `<div style="font-size:10px;color:#64748B;margin-top:1px;">${sanitizeHtml(parsedAssetType)}</div>` : ''}
              </div>
            </div>
            <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:8px;">What would you like to do with this property?</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button onclick="window.addParsedAsProperty()" style="${btnStyle}background:#34D399;color:#fff;" title="Add as additional security in a portfolio deal">&#43; Add to Portfolio</button>
              <button onclick="window.replacePropertyFromParsed()" style="${btnStyle}background:#D4A853;color:#fff;" title="Replace the existing property with this one">&#8635; Replace Existing</button>
              <button onclick="document.getElementById('new-property-card').style.display='none'" style="${btnStyle}background:#1a2332;color:#64748B;" title="Ignore this property">Ignore</button>
            </div>
          </div>`;
      }

      for (const key of sectionFields) {
        const label = FIELD_LABELS[key] || key;
        let val = String(parsedData[key]);
        const isCore = CORE_STRUCTURE_FIELDS.includes(key);
        const hasConflict = !!_lastConflicts[key];
        const isBorrowerField = BORROWER_ENTITY_FIELDS.includes(key);
        const isPropertyField = PROPERTY_ENTITY_FIELDS.includes(key);

        // Format currency values
        if (['current_value', 'purchase_price', 'loan_amount', 'refurb_cost', 'commitment_fee'].includes(key) && !isNaN(parseFloat(val.replace(/[£,]/g, '')))) {
          const num = parseFloat(val.replace(/[£,]/g, ''));
          val = '\u00A3' + num.toLocaleString('en-GB');
        }
        if (['ltv_requested', 'rate_requested', 'arrangement_fee_pct', 'broker_fee_pct'].includes(key)) {
          val = val + '%';
        }

        // Check if this field is handled by an entity card (borrower/property)
        const entityHandled = (isBorrowerField && hasNewBorrower) || (isPropertyField && hasNewProperty);

        // Core field badge — suppress CONFLICT badge if entity card handles it
        const coreBadge = isCore ? '<span style="padding:1px 5px;border-radius:3px;background:#111827;color:#fff;font-size:8px;font-weight:700;margin-left:6px;letter-spacing:.3px;">CORE</span>' : '';
        const showConflict = hasConflict && !entityHandled;
        const conflictBadge = showConflict ? '<span style="padding:1px 5px;border-radius:3px;background:#F87171;color:#fff;font-size:8px;font-weight:700;margin-left:4px;">CONFLICT</span>' : '';
        const rowBorder = showConflict ? 'border:1px solid rgba(248,113,113,0.2);background:rgba(248,113,113,0.1);' : 'border:1px solid #1a2332;background:#111827;';

        // Check if Matrix already has a value for this field — suppress overwrite warning if entity card handles it
        const matrixEl = document.getElementById(`mf-${key}`);
        const matrixVal = matrixEl ? matrixEl.value.trim() : '';
        const matrixDiffers = matrixVal && matrixVal !== String(parsedData[key]) && isCore;
        const matrixWarning = (matrixDiffers && !entityHandled) ? `<div style="font-size:10px;color:#D4A853;margin-top:3px;">&#9888; Matrix has: "${matrixVal.substring(0,40)}" — accepting will overwrite</div>` : '';

        // If entity card is shown, dim the individual accept/reject buttons and add a note
        const entityNote = entityHandled && matrixDiffers ? `<div style="font-size:9px;color:#D4A853;margin-top:2px;">&#8593; Use the card above to add/replace</div>` : '';

        html += `
          <div style="display:flex;align-items:flex-start;padding:7px 12px;border-radius:6px;margin-bottom:3px;${rowBorder}" id="parsed-row-${key}">
            <div style="width:180px;font-size:12px;color:#64748B;font-weight:600;flex-shrink:0;">${label}${coreBadge}${conflictBadge}</div>
            <div style="flex:1;font-size:13px;color:#F1F5F9;font-weight:500;">
              ${val}
              ${matrixWarning}
              ${entityNote}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="window.acceptParsedField('${key}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:#34D399;color:#fff;" title="Accept and fill Matrix">&#10003;</button>
              <button onclick="document.getElementById('parsed-row-${key}').style.display='none'" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Reject this value">&#10005;</button>
            </div>
          </div>`;
      }
      html += `</div>`;
    }

    parserFields.innerHTML = html;
    parserFields.style.display = 'block';
    if (parserActions) parserActions.style.display = 'flex';

    // Remove the "Select a document" placeholder
    const infoBox = parserContent ? parserContent.querySelector('div[style*="background:rgba(212,168,83,0.15)"]') : null;
    if (infoBox && infoBox.textContent.includes('Select a document')) infoBox.style.display = 'none';

    // Auto-open Parser section and scroll to it
    const parserBody = document.getElementById('body-parser');
    if (parserBody) {
      parserBody.classList.remove('collapsed');
      parserBody.style.maxHeight = 'none';
    }
    const parserSection = document.getElementById('section-parser');
    if (parserSection) {
      parserSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Update stats bar
    const lastParsed = document.getElementById('matrix-last-parsed');
    const fieldsFilled = document.getElementById('matrix-fields-filled');
    const confEl = document.getElementById('matrix-confidence');
    if (lastParsed) lastParsed.textContent = 'just now';
    if (fieldsFilled) fieldsFilled.textContent = String(extracted.length);
    if (confEl && confidence != null) {
      confEl.textContent = confidence + '%';
      confEl.style.color = confidence >= 80 ? 'rgba(52,211,153,0.2)' : confidence >= 50 ? 'rgba(251,191,36,0.2)' : 'rgba(248,113,113,0.2)';
    }
  }

  // Resolve a conflict — user picks one of the conflicting values
  window.resolveConflict = function(field, optionIndex) {
    if (!_lastConflicts[field] || !_lastConflicts[field][optionIndex]) return;
    const chosen = _lastConflicts[field][optionIndex];
    _lastParsedData[field] = chosen.value;
    // Remove the conflict since it's resolved
    delete _lastConflicts[field];
    // Re-render to update UI
    showParsedResults(_lastParsedData, _lastConflicts);
    showToast(`${FIELD_LABELS[field] || field}: selected "${String(chosen.value).substring(0,30)}" from ${chosen.filename || chosen.category}`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  // ADD PARSED ENTITY → Borrower or Property via API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Add the parsed person as a new borrower/guarantor/director in deal_borrowers
   */
  window.addParsedAsBorrower = async function(role) {
    // Use _pendingNewBorrower (snapshot from render time) — _lastParsedData may have been overwritten
    const src = _pendingNewBorrower || _lastParsedData || {};
    console.log('[deal-matrix] addParsedAsBorrower called, role:', role, '_pendingNewBorrower:', _pendingNewBorrower, '_lastParsedData borrower_name:', _lastParsedData?.borrower_name);
    if (!src.borrower_name) {
      showToast('No borrower data to add', 'error');
      return;
    }
    const subId = deal.submission_id;
    const body = {
      role: role,
      full_name: src.borrower_name,
      borrower_type: src.borrower_type || 'individual',
      email: src.borrower_email || null,
      phone: src.borrower_phone || null,
      date_of_birth: src.borrower_dob || null,
      nationality: src.borrower_nationality || null,
      jurisdiction: src.borrower_jurisdiction || null,
      company_name: src.company_name || null,
      company_number: src.company_number || null
    };
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/borrowers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (data.success) {
        const roleLabel = { primary: 'Borrower', guarantor: 'Guarantor', director: 'Director', joint: 'Joint Borrower' }[role] || role;
        showToast(`${body.full_name} added as ${roleLabel}`, 'success');
        // Hide the entity card and dim borrower field rows (they're now handled)
        const card = document.getElementById('new-borrower-card');
        if (card) {
          card.innerHTML = `<div style="text-align:center;padding:12px;color:#34D399;font-weight:700;font-size:13px;">&#10003; ${sanitizeHtml(body.full_name)} added as ${roleLabel}</div>`;
          card.style.borderColor = '#34D399';
          card.style.background = 'rgba(52,211,153,0.1)';
        }
        // Hide individual borrower field rows since entity was added
        for (const f of BORROWER_ENTITY_FIELDS) {
          const row = document.getElementById(`parsed-row-${f}`);
          if (row) { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; }
        }
      } else {
        showToast(data.error || 'Failed to add borrower', 'error');
      }
    } catch (err) {
      console.error('[deal-matrix] addParsedAsBorrower error:', err);
      showToast('Failed to add borrower: ' + err.message, 'error');
    }
  };

  /**
   * Replace the existing Matrix borrower fields with the parsed person (overwrite)
   */
  window.replaceBorrowerFromParsed = function() {
    const src = _pendingNewBorrower || _lastParsedData;
    if (!src) return;
    let count = 0;
    for (const f of BORROWER_ENTITY_FIELDS) {
      if (src[f] != null && src[f] !== '') {
        if (pushFieldToMatrix(f, src[f])) count++;
        const row = document.getElementById(`parsed-row-${f}`);
        if (row) { row.style.background = 'rgba(52,211,153,0.1)'; row.style.borderColor = 'rgba(52,211,153,0.2)'; }
      }
    }
    const card = document.getElementById('new-borrower-card');
    if (card) {
      card.innerHTML = `<div style="text-align:center;padding:12px;color:#D4A853;font-weight:700;font-size:13px;">&#8635; Borrower replaced — ${count} fields updated in Matrix</div>`;
      card.style.borderColor = '#D4A853';
      card.style.background = 'rgba(251,191,36,0.1)';
    }
    showToast(`Borrower replaced — ${count} fields updated`, 'success');
  };

  /**
   * Add the parsed property as an additional property in deal_properties (portfolio)
   */
  window.addParsedAsProperty = async function() {
    // Use _pendingNewProperty (snapshot from render time) — _lastParsedData may have been overwritten
    const src = _pendingNewProperty || _lastParsedData || {};
    console.log('[deal-matrix] addParsedAsProperty called, _pendingNewProperty:', _pendingNewProperty, '_lastParsedData security_address:', _lastParsedData?.security_address);
    if (!src.security_address) {
      showToast('No property data to add', 'error');
      return;
    }
    const subId = deal.submission_id;
    const body = {
      address: src.security_address,
      postcode: src.security_postcode || null,
      property_type: src.asset_type || null,
      tenure: src.property_tenure || null,
      occupancy: src.occupancy_status || null,
      current_use: src.current_use || null,
      market_value: src.current_value ? parseFloat(String(src.current_value).replace(/[£,]/g, '')) || null : null,
      purchase_price: src.purchase_price ? parseFloat(String(src.purchase_price).replace(/[£,]/g, '')) || null : null
    };
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (data.success) {
        showToast(`Property added to portfolio: ${body.address.substring(0, 40)}`, 'success');
        const card = document.getElementById('new-property-card');
        if (card) {
          card.innerHTML = `<div style="text-align:center;padding:12px;color:#34D399;font-weight:700;font-size:13px;">&#10003; ${sanitizeHtml(body.address.substring(0, 50))} added to portfolio</div>`;
          card.style.borderColor = '#34D399';
          card.style.background = 'rgba(52,211,153,0.1)';
        }
        for (const f of PROPERTY_ENTITY_FIELDS) {
          const row = document.getElementById(`parsed-row-${f}`);
          if (row) { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; }
        }
      } else {
        showToast(data.error || 'Failed to add property', 'error');
      }
    } catch (err) {
      console.error('[deal-matrix] addParsedAsProperty error:', err);
      showToast('Failed to add property: ' + err.message, 'error');
    }
  };

  /**
   * Replace the existing Matrix property fields with the parsed property (overwrite)
   */
  window.replacePropertyFromParsed = function() {
    const src = _pendingNewProperty || _lastParsedData;
    if (!src) return;
    let count = 0;
    for (const f of PROPERTY_ENTITY_FIELDS) {
      if (src[f] != null && src[f] !== '') {
        if (pushFieldToMatrix(f, src[f])) count++;
        const row = document.getElementById(`parsed-row-${f}`);
        if (row) { row.style.background = 'rgba(52,211,153,0.1)'; row.style.borderColor = 'rgba(52,211,153,0.2)'; }
      }
    }
    const card = document.getElementById('new-property-card');
    if (card) {
      card.innerHTML = `<div style="text-align:center;padding:12px;color:#D4A853;font-weight:700;font-size:13px;">&#8635; Property replaced — ${count} fields updated in Matrix</div>`;
      card.style.borderColor = '#D4A853';
      card.style.background = 'rgba(251,191,36,0.1)';
    }
    showToast(`Property replaced — ${count} fields updated`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  // REPARSE PROPERTIES — backfill deal_properties from raw address data
  // ═══════════════════════════════════════════════════════════════════
  window.reparseProperties = async function(submissionId) {
    if (!submissionId) return;

    // Show floating progress bar
    floatingProgress.show({
      label: 'AI Property Extraction',
      message: 'AI is reading documents and extracting property data...',
      steps: ['Triggering parse...', 'Reading documents...', 'Extracting properties...']
    });
    floatingProgress.updateStep(0, 'active');

    // Replace the button with a live progress panel
    const btnEl = event && event.target;
    const containerEl = btnEl ? btnEl.closest('div') : null;
    if (containerEl) {
      containerEl.innerHTML = `
        <div id="dkf-parse-panel" style="background:#1a1a2e;border:1px solid #FBBF24;border-radius:8px;padding:12px;margin:8px 0;min-width:340px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div id="dkf-spinner" style="width:14px;height:14px;border:2px solid #FBBF24;border-top-color:transparent;border-radius:50%;animation:dkf-spin 0.8s linear infinite;flex-shrink:0;"></div>
            <span style="font-size:12px;color:#FBBF24;font-weight:700;" id="dkf-parse-headline">Initialising...</span>
            <span style="font-size:10px;color:#6B7280;margin-left:auto;" id="dkf-parse-elapsed"></span>
          </div>
          <div id="dkf-parse-feed" style="max-height:200px;overflow-y:auto;font-family:'Courier New',monospace;font-size:10px;line-height:1.6;color:#9CA3AF;"></div>
        </div>
        <style>
          @keyframes dkf-spin { to { transform: rotate(360deg); } }
          #dkf-parse-feed .step-done { color: #34D399; }
          #dkf-parse-feed .step-active { color: #FBBF24; }
          #dkf-parse-feed .step-error { color: #F87171; }
        </style>
      `;
    }

    let lastStepCount = 0;

    function renderProgress(progress) {
      const headline = document.getElementById('dkf-parse-headline');
      const elapsed = document.getElementById('dkf-parse-elapsed');
      const feed = document.getElementById('dkf-parse-feed');
      const spinner = document.getElementById('dkf-spinner');
      if (!headline || !feed) return;

      // Update headline
      headline.textContent = progress.message || 'Processing...';

      // Update elapsed timer
      if (progress.elapsed_seconds) {
        const m = Math.floor(progress.elapsed_seconds / 60);
        const s = Math.round(progress.elapsed_seconds % 60);
        elapsed.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
      }

      // Render step feed
      if (progress.steps && progress.steps.length > lastStepCount) {
        for (let i = lastStepCount; i < progress.steps.length; i++) {
          const step = progress.steps[i];
          const icon = step.stage.includes('error') ? 'x' : 'check';
          const cls = step.stage.includes('error') ? 'step-error' : (i === progress.steps.length - 1 && progress.status === 'running') ? 'step-active' : 'step-done';
          const prefix = step.stage.includes('error') ? '\u2717' : '\u2713';
          const line = document.createElement('div');
          line.className = cls;
          line.textContent = `${prefix} [${step.elapsed}] ${step.message}`;
          if (step.detail && Array.isArray(step.detail)) {
            line.textContent += ` (${step.detail.slice(0, 3).join(', ')}${step.detail.length > 3 ? '...' : ''})`;
          }
          feed.appendChild(line);
        }
        lastStepCount = progress.steps.length;
        feed.scrollTop = feed.scrollHeight;
      }

      // Handle completion
      if (progress.status === 'complete') {
        headline.textContent = 'Extraction complete!';
        headline.style.color = '#34D399';
        if (spinner) spinner.style.borderColor = '#34D399';
        if (spinner) spinner.style.animation = 'none';
      } else if (progress.status === 'error') {
        headline.textContent = 'Parse failed — ' + (progress.message || 'unknown error');
        headline.style.color = '#F87171';
        if (spinner) spinner.style.borderColor = '#F87171';
        if (spinner) spinner.style.animation = 'none';
      }
    }

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/reparse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await resp.json();

      if (data.success) {
        floatingProgress.updateStep(0, 'done');
        floatingProgress.updateStep(1, 'active');
        floatingProgress.updateBar(30);
        // Poll progress endpoint every 3 seconds for up to 5 minutes
        let attempts = 0;
        const maxAttempts = 100;
        const pollInterval = setInterval(async () => {
          attempts++;
          try {
            const progResp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/parse-progress`);
            const progData = await progResp.json();
            if (progData.success && progData.progress) {
              renderProgress(progData.progress);

              if (progData.progress.status === 'complete') {
                clearInterval(pollInterval);
                floatingProgress.updateStep(1, 'done');
                floatingProgress.updateStep(2, 'done');
                floatingProgress.complete({ label: 'Extraction Complete', message: 'AI extracted all deal data. Refreshing...' });
                setTimeout(() => _refreshDealInPlace(submissionId), 2500);
              } else if (progData.progress.status === 'error') {
                clearInterval(pollInterval);
                floatingProgress.error({ label: 'Parse Failed', message: progData.progress.message || 'Unknown error' });
              }
            }
            if (attempts >= maxAttempts) {
              clearInterval(pollInterval);
              renderProgress({ status: 'error', message: 'Timed out — please refresh the page', steps: [] });
            }
          } catch (pollErr) {
            console.error('[reparse-poll] Error:', pollErr);
          }
        }, 3000);
      } else {
        renderProgress({ status: 'error', message: data.message || data.error || 'Parse failed', steps: [] });
        floatingProgress.error({ label: 'Parse Failed', message: data.message || data.error || 'Parse failed' });
      }
    } catch (err) {
      console.error('[reparse] Error:', err);
      renderProgress({ status: 'error', message: err.message, steps: [] });
      floatingProgress.error({ label: 'Connection Error', message: 'Failed to trigger parsing: ' + err.message });
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // PROPERTY CRUD — Add / Edit / Delete rows in deal_properties
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Show a modal form pre-populated with property data (null for new)
   */
  function _showPropertyModal(submissionId, existing) {
    const isEdit = !!existing;
    const title = isEdit ? 'Edit Property' : 'Add New Property';
    const v = existing || {};

    // Remove any existing modal
    const old = document.getElementById('dkf-property-modal');
    if (old) old.remove();

    const modalHtml = `
      <div id="dkf-property-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1E293B;border:1px solid rgba(212,168,83,0.3);border-radius:12px;padding:24px;width:90%;max-width:520px;max-height:85vh;overflow-y:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="font-size:16px;font-weight:700;color:#F1F5F9;">${title}</span>
            <button onclick="document.getElementById('dkf-property-modal').remove()" style="background:none;border:none;color:#94A3B8;font-size:20px;cursor:pointer;">&times;</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Address *</label>
              <input id="pm-address" value="${_escAttr(v.address || '')}" placeholder="Full property address" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Postcode</label>
              <input id="pm-postcode" value="${_escAttr(v.postcode || '')}" placeholder="e.g. SW1A 1AA" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Market Value (£)</label>
              <input id="pm-market_value" type="number" value="${v.market_value || ''}" placeholder="e.g. 500000" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Purchase Price (£)</label>
              <input id="pm-purchase_price" type="number" value="${v.purchase_price || ''}" placeholder="e.g. 450000" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Property Type</label>
              <select id="pm-property_type" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                <option value="">— Select —</option>
                <option value="residential" ${v.property_type === 'residential' ? 'selected' : ''}>Residential</option>
                <option value="commercial" ${v.property_type === 'commercial' ? 'selected' : ''}>Commercial</option>
                <option value="mixed_use" ${v.property_type === 'mixed_use' ? 'selected' : ''}>Mixed Use</option>
                <option value="land" ${v.property_type === 'land' ? 'selected' : ''}>Land</option>
                <option value="hmo" ${v.property_type === 'hmo' ? 'selected' : ''}>HMO</option>
                <option value="semi_commercial" ${v.property_type === 'semi_commercial' ? 'selected' : ''}>Semi-Commercial</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Tenure</label>
              <select id="pm-tenure" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                <option value="">— Select —</option>
                <option value="freehold" ${v.tenure === 'freehold' ? 'selected' : ''}>Freehold</option>
                <option value="leasehold" ${v.tenure === 'leasehold' ? 'selected' : ''}>Leasehold</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Occupancy</label>
              <select id="pm-occupancy" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                <option value="">— Select —</option>
                <option value="vacant" ${v.occupancy === 'vacant' ? 'selected' : ''}>Vacant</option>
                <option value="owner_occupied" ${v.occupancy === 'owner_occupied' ? 'selected' : ''}>Owner Occupied</option>
                <option value="tenanted" ${v.occupancy === 'tenanted' ? 'selected' : ''}>Tenanted</option>
                <option value="part_tenanted" ${v.occupancy === 'part_tenanted' ? 'selected' : ''}>Part Tenanted</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Current Use</label>
              <input id="pm-current_use" value="${_escAttr(v.current_use || '')}" placeholder="e.g. BTL, office" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Title Number</label>
              <input id="pm-title_number" value="${_escAttr(v.title_number || '')}" placeholder="e.g. NGL123456" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Notes</label>
              <textarea id="pm-notes" rows="2" placeholder="Any notes about this property..." style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;resize:vertical;box-sizing:border-box;">${_escAttr(v.notes || '')}</textarea>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
            <button onclick="document.getElementById('dkf-property-modal').remove()" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#94A3B8;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
            <button id="pm-save-btn" style="padding:8px 20px;background:#D4A853;border:none;border-radius:6px;color:#0B1120;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'Save Changes' : 'Add Property'}</button>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Wire up save button
    document.getElementById('pm-save-btn').addEventListener('click', async () => {
      const payload = {
        address: document.getElementById('pm-address').value.trim(),
        postcode: document.getElementById('pm-postcode').value.trim() || null,
        market_value: parseFloat(document.getElementById('pm-market_value').value) || null,
        purchase_price: parseFloat(document.getElementById('pm-purchase_price').value) || null,
        property_type: document.getElementById('pm-property_type').value || null,
        tenure: document.getElementById('pm-tenure').value || null,
        occupancy: document.getElementById('pm-occupancy').value || null,
        current_use: document.getElementById('pm-current_use').value.trim() || null,
        title_number: document.getElementById('pm-title_number').value.trim() || null,
        notes: document.getElementById('pm-notes').value.trim() || null
      };

      if (!payload.address) {
        showToast('Property address is required', 'error');
        return;
      }

      const btn = document.getElementById('pm-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const url = isEdit
          ? `${API_BASE}/api/deals/${submissionId}/properties/${existing.id}`
          : `${API_BASE}/api/deals/${submissionId}/properties`;
        const method = isEdit ? 'PUT' : 'POST';

        const resp = await fetchWithAuth(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.success) {
          document.getElementById('dkf-property-modal').remove();
          showToast(isEdit ? 'Property updated' : 'Property added', 'success');
          setTimeout(() => _refreshDealInPlace(submissionId), 800);
        } else {
          showToast(data.error || 'Failed to save property', 'error');
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save Changes' : 'Add Property';
        }
      } catch (err) {
        console.error('[property-save]', err);
        showToast('Failed to save: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save Changes' : 'Add Property';
      }
    });
  }

  /** Escape HTML attribute values */
  function _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  /** Add a new property to this deal */
  window.addPropertyRow = function(submissionId) {
    _showPropertyModal(submissionId, null);
  };

  /** Edit an existing property — fetch current data then show modal */
  window.editPropertyRow = function(propertyId, submissionId) {
    // Find the property in deal.properties array
    const prop = deal.properties ? deal.properties.find(p => p.id === propertyId) : null;
    if (prop) {
      _showPropertyModal(submissionId, prop);
    } else {
      // Fallback: fetch from API
      fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties`)
        .then(r => r.json())
        .then(data => {
          const found = data.properties ? data.properties.find(p => p.id === propertyId) : null;
          if (found) {
            _showPropertyModal(submissionId, found);
          } else {
            showToast('Property not found', 'error');
          }
        })
        .catch(err => showToast('Failed to load property: ' + err.message, 'error'));
    }
  };

  /** Delete a property after confirmation */
  window.deletePropertyRow = function(propertyId, submissionId) {
    const prop = deal.properties ? deal.properties.find(p => p.id === propertyId) : null;
    const label = prop ? (prop.address || `Property #${propertyId}`) : `Property #${propertyId}`;

    if (!confirm(`Delete "${label}"?\n\nThis cannot be undone.`)) return;

    fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showToast('Property deleted', 'success');
          // Remove the row from DOM immediately for instant feedback
          const row = document.getElementById(`prop-row-${propertyId}`);
          if (row) row.remove();
          // Refresh in-place after short delay to update totals and completeness
          setTimeout(() => _refreshDealInPlace(submissionId), 1200);
        } else {
          showToast(data.error || 'Failed to delete property', 'error');
        }
      })
      .catch(err => showToast('Failed to delete: ' + err.message, 'error'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // BORROWER CRUD — Add / Edit / Delete in deal_borrowers
  // ═══════════════════════════════════════════════════════════════════

  function _showBorrowerModal(submissionId, existing, defaults) {
    const isEdit = !!(existing && existing.id);
    const v = existing || defaults || {};
    const defaultRole = v.role || 'primary';
    const _roleLabels = { primary:'Borrower', joint:'Joint Borrower', guarantor:'Guarantor', director:'Director', ubo:'UBO', psc:'PSC', shareholder:'Shareholder' };
    const roleLabel = _roleLabels[defaultRole] || 'Borrower';
    const title = isEdit ? `Edit ${roleLabel}` : `Add ${roleLabel}`;

    const old = document.getElementById('dkf-borrower-modal');
    if (old) old.remove();

    const roleOptLabels = { primary: 'Primary Borrower', joint: 'Joint Borrower', director: 'Director', ubo: 'UBO (Beneficial Owner)', psc: 'PSC (Significant Control)', shareholder: 'Shareholder', guarantor: 'Guarantor' };
    const roleOpts = Object.entries(roleOptLabels).map(([r, label]) =>
      `<option value="${r}" ${v.role === r ? 'selected' : ''}>${label}</option>`
    ).join('');

    const typeOpts = ['individual', 'corporate', 'spv', 'llp', 'trust', 'partnership'].map(t =>
      `<option value="${t}" ${v.borrower_type === t ? 'selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
    ).join('');

    const modalHtml = `
      <div id="dkf-borrower-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1E293B;border:1px solid rgba(212,168,83,0.3);border-radius:12px;padding:24px;width:90%;max-width:520px;max-height:85vh;overflow-y:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="font-size:16px;font-weight:700;color:#F1F5F9;">${title}</span>
            <button onclick="document.getElementById('dkf-borrower-modal').remove()" style="background:none;border:none;color:#94A3B8;font-size:20px;cursor:pointer;">&times;</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Role *</label>
              <select id="bm-role" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                ${roleOpts}
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Type *</label>
              <select id="bm-borrower_type" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                ${typeOpts}
              </select>
            </div>
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Full Name *</label>
              <input id="bm-full_name" value="${_escAttr(v.full_name || '')}" placeholder="Full legal name" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Email</label>
              <input id="bm-email" type="email" value="${_escAttr(v.email || '')}" placeholder="email@example.com" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Phone</label>
              <input id="bm-phone" type="tel" value="${_escAttr(v.phone || '')}" placeholder="+44..." style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Date of Birth</label>
              <input id="bm-dob" type="date" value="${v.date_of_birth ? String(v.date_of_birth).substring(0,10) : ''}" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Nationality</label>
              <input id="bm-nationality" value="${_escAttr(v.nationality || '')}" placeholder="e.g. British" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Company Name</label>
              <input id="bm-company_name" value="${_escAttr(v.company_name || '')}" placeholder="If corporate borrower" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Company Number</label>
              <input id="bm-company_number" value="${_escAttr(v.company_number || '')}" placeholder="e.g. 12345678" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Address</label>
              <input id="bm-address" value="${_escAttr(v.address || '')}" placeholder="Full residential or registered address" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
            <button onclick="document.getElementById('dkf-borrower-modal').remove()" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#94A3B8;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
            <button id="bm-save-btn" style="padding:8px 20px;background:#D4A853;border:none;border-radius:6px;color:#0B1120;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'Save Changes' : `Add ${roleLabel}`}</button>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('bm-save-btn').addEventListener('click', async () => {
      const payload = {
        role: document.getElementById('bm-role').value,
        borrower_type: document.getElementById('bm-borrower_type').value,
        full_name: document.getElementById('bm-full_name').value.trim(),
        email: document.getElementById('bm-email').value.trim() || null,
        phone: document.getElementById('bm-phone').value.trim() || null,
        date_of_birth: document.getElementById('bm-dob').value || null,
        nationality: document.getElementById('bm-nationality').value.trim() || null,
        company_name: document.getElementById('bm-company_name').value.trim() || null,
        company_number: document.getElementById('bm-company_number').value.trim() || null,
        address: document.getElementById('bm-address').value.trim() || null
      };
      // Preserve parent_borrower_id if it was passed as a default (e.g. when adding a director to a specific corporate guarantor)
      if (v.parent_borrower_id !== undefined) {
        payload.parent_borrower_id = v.parent_borrower_id;
      }

      if (!payload.full_name) {
        showToast('Full name is required', 'error');
        return;
      }

      const btn = document.getElementById('bm-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const url = isEdit
          ? `${API_BASE}/api/deals/${submissionId}/borrowers/${existing.id}`
          : `${API_BASE}/api/deals/${submissionId}/borrowers`;
        const method = isEdit ? 'PUT' : 'POST';

        const resp = await fetchWithAuth(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.success) {
          document.getElementById('dkf-borrower-modal').remove();
          showToast(isEdit ? 'Borrower updated' : 'Borrower added', 'success');
          setTimeout(() => _refreshDealInPlace(submissionId), 800);
        } else {
          showToast(data.error || 'Failed to save', 'error');
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save Changes' : `Add ${roleLabel}`;
        }
      } catch (err) {
        console.error('[borrower-save]', err);
        showToast('Failed to save: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save Changes' : `Add ${roleLabel}`;
      }
    });
  }

  window.addBorrowerRow = function(submissionId) {
    _showBorrowerModal(submissionId, null);
  };

  window.addGuarantorRow = function(submissionId) {
    _showBorrowerModal(submissionId, null, { role: 'guarantor' });
  };

  // Add a corporate guarantor (top-level, role=guarantor + corporate type pre-selected)
  window.addCorporateGuarantor = function(submissionId) {
    _showBorrowerModal(submissionId, null, { role: 'guarantor', borrower_type: 'corporate' });
  };

  // Add an individual guarantor (top-level, role=guarantor + individual type pre-selected)
  window.addIndividualGuarantor = function(submissionId) {
    _showBorrowerModal(submissionId, null, { role: 'guarantor', borrower_type: 'individual' });
  };

  // Add a director/PSC/UBO as a child of a specific corporate party (borrower or guarantor)
  window.addChildToParent = function(submissionId, parentBorrowerId) {
    _showBorrowerModal(submissionId, null, {
      role: 'director',
      borrower_type: 'individual',
      parent_borrower_id: parseInt(parentBorrowerId)
    });
  };

  window.editBorrowerRow = function(borrowerId, submissionId) {
    const bor = deal.borrowers ? deal.borrowers.find(b => b.id === borrowerId) : null;
    if (bor) {
      _showBorrowerModal(submissionId, bor);
    } else {
      fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers`)
        .then(r => r.json())
        .then(data => {
          const found = data.borrowers ? data.borrowers.find(b => b.id === borrowerId) : null;
          if (found) {
            _showBorrowerModal(submissionId, found);
          } else {
            showToast('Borrower not found', 'error');
          }
        })
        .catch(err => showToast('Failed to load borrower: ' + err.message, 'error'));
    }
  };

  window.deleteBorrowerRow = function(borrowerId, submissionId) {
    const bor = deal.borrowers ? deal.borrowers.find(b => b.id === borrowerId) : null;
    const label = bor ? (bor.full_name || `Borrower #${borrowerId}`) : `Borrower #${borrowerId}`;

    if (!confirm(`Remove "${label}" from this deal?\n\nThis cannot be undone.`)) return;

    fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showToast('Borrower removed', 'success');
          const row = document.getElementById(`borrower-row-${borrowerId}`);
          if (row) row.remove();
          setTimeout(() => _refreshDealInPlace(submissionId), 1200);
        } else {
          showToast(data.error || 'Failed to remove borrower', 'error');
        }
      })
      .catch(err => showToast('Failed to remove: ' + err.message, 'error'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // TOGGLE BORROWER INLINE DETAIL — expand/collapse below clicked row
  // ═══════════════════════════════════════════════════════════════════

  window._toggleBorrowerDetail = function(borrowerId) {
    const existingPanel = document.getElementById(`borrower-detail-${borrowerId}`);
    if (existingPanel) {
      // Collapse: animate then remove
      existingPanel.style.maxHeight = '0';
      existingPanel.style.opacity = '0';
      setTimeout(() => existingPanel.remove(), 250);
      // Reset row highlight
      const row = document.getElementById(`borrower-row-${borrowerId}`);
      if (row) row.style.background = '';
      return;
    }

    // Close any other open detail panels first
    document.querySelectorAll('[id^="borrower-detail-"]').forEach(el => {
      el.style.maxHeight = '0';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    });
    document.querySelectorAll('[id^="borrower-row-"]').forEach(r => r.style.background = '');

    // Find borrower data
    const bor = deal.borrowers ? deal.borrowers.find(b => b.id === borrowerId) : null;
    if (!bor) return;

    const row = document.getElementById(`borrower-row-${borrowerId}`);
    if (!row) return;

    // Highlight active row
    row.style.background = 'rgba(212,168,83,0.06)';

    // Count columns for colspan
    const colCount = row.querySelectorAll('td').length;

    // ── Build person-centric inline detail panel ──
    const _rc = { primary:'#34D399', joint:'#34D399', guarantor:'#FBBF24', director:'#818CF8', ubo:'#A78BFA', psc:'#38BDF8', shareholder:'#D4A853' };
    const roleColor = _rc[bor.role] || '#94A3B8';
    const chBadge = bor.ch_verified_at
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(52,211,153,0.1);color:#34D399;">&#10003; CH Verified — ' + sanitizeHtml(bor.ch_matched_role || bor.role) + '</span>'
      : '';

    // ── Helpers ──
    const fmtDate = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    // Field renderer: shows value if present, grey placeholder if not
    const field = (label, val, stage) => {
      if (val && String(val).trim()) {
        return '<div style="margin-bottom:8px;">' +
          '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
          '<div style="font-size:12px;color:#F1F5F9;font-weight:500;">' + sanitizeHtml(String(val)) + '</div>' +
        '</div>';
      }
      // Empty — show as pending with stage hint
      const stageLabel = stage || '';
      return '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
        '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained' + (stageLabel ? ' <span style="font-size:9px;color:#334155;">(' + stageLabel + ')</span>' : '') + '</div>' +
      '</div>';
    };

    // Status pill renderer
    const statusPill = (label, status, colorMap) => {
      const map = colorMap || { clear:'#34D399', verified:'#34D399', not_screened:'#64748B', not_obtained:'#64748B', none:'#34D399', flagged:'#F87171', active:'#F87171', undischarged:'#F87171', discharged:'#D4A853', obtained:'#D4A853' };
      const c = map[status] || '#64748B';
      const bg = c === '#34D399' ? 'rgba(52,211,153,0.1)' : c === '#F87171' ? 'rgba(248,113,113,0.1)' : c === '#D4A853' ? 'rgba(212,168,83,0.1)' : 'rgba(255,255,255,0.04)';
      const displayStatus = status ? status.replace(/_/g, ' ') : 'not screened';
      return '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">' + label + '</div>' +
        '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + bg + ';color:' + c + ';text-transform:capitalize;">' + displayStatus + '</span>' +
      '</div>';
    };

    // ── CH Match Data block ──
    let chMatchHtml = '';
    const chd = bor.ch_match_data;
    if (chd && typeof chd === 'object' && Object.keys(chd).length > 0) {
      const items = [];
      if (chd.roles && chd.roles.length) items.push('<strong>Roles:</strong> ' + chd.roles.join(', '));
      if (chd.control) items.push('<strong>Control:</strong> ' + sanitizeHtml(chd.control));
      if (chd.nationality) items.push('<strong>Nationality:</strong> ' + sanitizeHtml(chd.nationality));
      if (chd.appointed) items.push('<strong>Appointed:</strong> ' + sanitizeHtml(chd.appointed));
      if (chd.source) items.push('<strong>Source:</strong> ' + sanitizeHtml(chd.source));
      if (items.length > 0) {
        chMatchHtml = '<div style="margin-top:10px;padding:8px 12px;background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.12);border-radius:6px;">' +
          '<div style="font-size:9px;color:#34D399;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Companies House Match</div>' +
          '<div style="font-size:11px;color:#CBD5E1;line-height:1.6;">' + items.join(' &nbsp;·&nbsp; ') + '</div>' +
        '</div>';
      }
    }

    // ── Credit Score display ──
    let creditHtml = '';
    if (bor.credit_score) {
      const scoreColor = bor.credit_score >= 700 ? '#34D399' : bor.credit_score >= 500 ? '#D4A853' : '#F87171';
      creditHtml = '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Credit Score</div>' +
        '<div style="display:flex;align-items:baseline;gap:6px;">' +
          '<span style="font-size:18px;font-weight:800;color:' + scoreColor + ';">' + bor.credit_score + '</span>' +
          (bor.credit_score_source ? '<span style="font-size:10px;color:#64748B;">' + sanitizeHtml(bor.credit_score_source) + '</span>' : '') +
          (bor.credit_score_date ? '<span style="font-size:10px;color:#475569;">(' + fmtDate(bor.credit_score_date) + ')</span>' : '') +
        '</div>' +
      '</div>';
    } else {
      creditHtml = '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Credit Score</div>' +
        '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(Underwriting)</span></div>' +
      '</div>';
    }

    // ── ID document display ──
    let idDocHtml = '';
    if (bor.id_type || bor.id_number) {
      const idLabel = (bor.id_type || 'ID').replace(/_/g, ' ');
      idDocHtml = '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">ID Document</div>' +
        '<div style="font-size:12px;color:#F1F5F9;font-weight:500;text-transform:capitalize;">' + sanitizeHtml(idLabel) + (bor.id_number ? ': ' + sanitizeHtml(bor.id_number) : '') + '</div>' +
        (bor.id_expiry ? '<div style="font-size:10px;color:#94A3B8;margin-top:1px;">Expires: ' + fmtDate(bor.id_expiry) + '</div>' : '') +
      '</div>';
    } else {
      idDocHtml = '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">ID Document</div>' +
        '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(DIP)</span></div>' +
      '</div>';
    }

    const detailHtml = '<tr id="borrower-detail-' + borrowerId + '">' +
      '<td colspan="' + colCount + '" style="padding:0;border-bottom:1px solid rgba(212,168,83,0.15);">' +
        '<div style="max-height:0;overflow:hidden;opacity:0;transition:max-height .3s ease, opacity .25s ease;background:rgba(15,23,41,0.6);border-left:3px solid #D4A853;" id="borrower-detail-inner-' + borrowerId + '">' +
          '<div style="padding:14px 16px;">' +

            // ── Header: Name + Badges ──
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
              '<div style="font-size:14px;font-weight:700;color:#F1F5F9;">' + sanitizeHtml(bor.full_name || 'Unknown') + '</div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' +
                chBadge +
                '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;color:' + roleColor + ';background:rgba(255,255,255,0.05);text-transform:capitalize;">' + (bor.role || 'primary') + '</span>' +
              '</div>' +
            '</div>' +

            // ── Two-column layout ──
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px;">' +

              // ── LEFT COLUMN: Personal Identity ──
              '<div>' +
                '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Personal Identity</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                  field('Date of Birth', fmtDate(bor.date_of_birth), 'DIP') +
                  field('Gender', bor.gender, 'DIP') +
                  field('Nationality', bor.nationality, 'DIP') +
                  field('Email', bor.email, 'DIP') +
                  field('Phone', bor.phone, 'DIP') +
                '</div>' +
                idDocHtml +
                field('Residential Address', bor.residential_address || bor.address, 'DIP') +
                statusPill('Address Proof', bor.address_proof_status || 'not_obtained') +
              '</div>' +

              // ── RIGHT COLUMN: Compliance & Verification ──
              '<div>' +
                '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Compliance & Verification</div>' +
                creditHtml +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                  statusPill('CCJs', bor.ccj_count > 0 ? bor.ccj_count + ' found' : (bor.ccj_count === 0 ? 'None' : 'not_screened'), { None:'#34D399', 'not_screened':'#64748B' }) +
                  statusPill('Bankruptcy', bor.bankruptcy_status || 'none') +
                  statusPill('PEP Screening', bor.pep_status || 'not_screened') +
                  statusPill('Sanctions', bor.sanctions_status || 'not_screened') +
                '</div>' +
                field('Source of Wealth', bor.source_of_wealth, 'Underwriting') +
                field('Source of Funds', bor.source_of_funds, 'Underwriting') +
              '</div>' +

            '</div>' +

            // ── CH Match Data (bottom) ──
            chMatchHtml +

          '</div>' +
        '</div>' +
      '</td>' +
    '</tr>';

    // Insert after the row
    row.insertAdjacentHTML('afterend', detailHtml);

    // Animate open
    requestAnimationFrame(() => {
      const inner = document.getElementById('borrower-detail-inner-' + borrowerId);
      if (inner) {
        inner.style.maxHeight = '600px';
        inner.style.opacity = '1';
      }
    });
  };

  // ═══════════════════════════════════════════════════════════════════
  // FINANCIAL SCHEDULE CRUD — Add / Edit / Delete in deal_financials
  // ═══════════════════════════════════════════════════════════════════

  function _showFinancialModal(submissionId, category, existing) {
    const isEdit = !!existing;
    const catLabel = CAT_LABELS[category] || category;
    const title = isEdit ? `Edit ${catLabel}` : `Add ${catLabel}`;
    const v = existing || {};

    const old = document.getElementById('dkf-financial-modal');
    if (old) old.remove();

    const freqOpts = ['one_off', 'monthly', 'quarterly', 'annual'].map(f =>
      `<option value="${f}" ${(v.frequency || 'one_off') === f ? 'selected' : ''}>${FREQ_LABELS[f]}</option>`
    ).join('');

    const modalHtml = `
      <div id="dkf-financial-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1E293B;border:1px solid rgba(212,168,83,0.3);border-radius:12px;padding:24px;width:90%;max-width:480px;max-height:85vh;overflow-y:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="font-size:16px;font-weight:700;color:#F1F5F9;">${title}</span>
            <button onclick="document.getElementById('dkf-financial-modal').remove()" style="background:none;border:none;color:#94A3B8;font-size:20px;cursor:pointer;">&times;</button>
          </div>
          <p style="font-size:11px;color:#6B7280;margin:0 0 12px;">${CAT_EXAMPLES[category] || ''}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Description *</label>
              <input id="fm-desc" value="${_escAttr(v.description || '')}" placeholder="${CAT_EXAMPLES[category] || 'Description'}" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Amount (£)</label>
              <input id="fm-amount" type="text" value="${v.amount ? parseFloat(v.amount).toLocaleString() : ''}" placeholder="e.g. 250,000" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Frequency</label>
              <select id="fm-freq" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                ${freqOpts}
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Holder / Lender</label>
              <input id="fm-holder" value="${_escAttr(v.holder || '')}" placeholder="e.g. Barclays, HMRC" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div>
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Reference</label>
              <input id="fm-ref" value="${_escAttr(v.reference || '')}" placeholder="Account / ref number" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
            </div>
            <div style="grid-column:1/-1;">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Notes</label>
              <textarea id="fm-notes" rows="2" placeholder="Additional detail" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;resize:vertical;">${sanitizeHtml(v.notes || '')}</textarea>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
            <button onclick="document.getElementById('dkf-financial-modal').remove()" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#94A3B8;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
            <button id="fm-save-btn" style="padding:8px 20px;background:#D4A853;border:none;border-radius:6px;color:#0B1120;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'Save Changes' : `Add ${catLabel}`}</button>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('fm-save-btn').addEventListener('click', async () => {
      const rawAmt = document.getElementById('fm-amount').value.replace(/,/g, '').trim();
      const payload = {
        category,
        description: document.getElementById('fm-desc').value.trim(),
        amount: rawAmt ? parseFloat(rawAmt) : null,
        frequency: document.getElementById('fm-freq').value,
        holder: document.getElementById('fm-holder').value.trim() || null,
        reference: document.getElementById('fm-ref').value.trim() || null,
        notes: document.getElementById('fm-notes').value.trim() || null
      };

      if (!payload.description) {
        showToast('Description is required', 'error');
        return;
      }

      const btn = document.getElementById('fm-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const url = isEdit
          ? `${API_BASE}/api/deals/${submissionId}/financials/${existing.id}`
          : `${API_BASE}/api/deals/${submissionId}/financials`;
        const method = isEdit ? 'PUT' : 'POST';

        const resp = await fetchWithAuth(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.success) {
          document.getElementById('dkf-financial-modal').remove();
          showToast(isEdit ? `${catLabel} updated` : `${catLabel} added`, 'success');
          setTimeout(() => _refreshDealInPlace(submissionId), 800);
        } else {
          showToast(data.error || `Failed to save ${catLabel.toLowerCase()}`, 'error');
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save Changes' : `Add ${catLabel}`;
        }
      } catch (err) {
        console.error('[financial-save]', err);
        showToast('Failed to save: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save Changes' : `Add ${catLabel}`;
      }
    });
  }

  window.addFinancialRow = function(submissionId, category) {
    _showFinancialModal(submissionId, category, null);
  };

  window.editFinancialRow = function(financialId, submissionId, category) {
    const fin = (deal.financials || []).find(f => f.id === financialId);
    if (fin) {
      _showFinancialModal(submissionId, category, fin);
    } else {
      fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/financials?category=${category}`)
        .then(r => r.json())
        .then(data => {
          const found = (data.financials || []).find(f => f.id === financialId);
          if (found) {
            _showFinancialModal(submissionId, category, found);
          } else {
            showToast('Financial record not found', 'error');
          }
        })
        .catch(err => showToast('Failed to load record: ' + err.message, 'error'));
    }
  };

  window.deleteFinancialRow = function(financialId, submissionId) {
    const fin = (deal.financials || []).find(f => f.id === financialId);
    const label = fin ? (fin.description || `Record #${financialId}`) : `Record #${financialId}`;

    if (!confirm(`Remove "${label}" from this deal?\n\nThis cannot be undone.`)) return;

    fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/financials/${financialId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showToast('Record removed', 'success');
          const row = document.getElementById(`fin-row-${financialId}`);
          if (row) row.remove();
          setTimeout(() => _refreshDealInPlace(submissionId), 1200);
        } else {
          showToast(data.error || 'Failed to remove record', 'error');
        }
      })
      .catch(err => showToast('Failed to remove: ' + err.message, 'error'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // ACCEPT PARSED FIELD(S) → push to Matrix inputs + save to DB
  // ═══════════════════════════════════════════════════════════════════
  function pushFieldToMatrix(key, val) {
    const el = document.getElementById(`mf-${key}`);
    if (!el) return false;

    el.value = String(val);
    el.style.borderColor = '#D4A853';
    el.style.background = 'rgba(251,191,36,0.1)';

    // Add AI badge if not there
    const confidence = _lastParsedData && _lastParsedData.confidence != null ? Math.round(_lastParsedData.confidence * 100) : null;
    const badge = el.parentElement.querySelector('.ai-confidence-badge');
    if (!badge && confidence != null) {
      const badgeColor = confidence >= 80 ? '#34D399' : confidence >= 50 ? '#D4A853' : '#F87171';
      const badgeHtml = document.createElement('div');
      badgeHtml.className = 'ai-confidence-badge';
      badgeHtml.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:4px;font-size:10px;font-weight:600;';
      badgeHtml.innerHTML = `<span style="padding:1px 6px;border-radius:4px;background:${badgeColor};color:#fff;font-size:9px;">AI</span> <span style="color:${badgeColor};">${confidence}%</span>`;
      el.parentElement.appendChild(badgeHtml);
    }

    window.matrixSaveField(key, String(val));
    return true;
  }

  // Accept a single parsed field
  window.acceptParsedField = function(key) {
    if (!_lastParsedData || !_lastParsedData[key]) return;
    if (pushFieldToMatrix(key, _lastParsedData[key])) {
      // Mark row as accepted visually
      const row = document.getElementById(`parsed-row-${key}`);
      if (row) {
        row.style.background = 'rgba(52,211,153,0.1)';
        row.style.borderColor = 'rgba(52,211,153,0.2)';
        const btns = row.querySelectorAll('button');
        btns.forEach(b => b.remove());
        const accepted = document.createElement('span');
        accepted.style.cssText = 'font-size:10px;font-weight:700;color:#34D399;';
        accepted.textContent = '\u2713 Accepted';
        row.querySelector('div:last-child') || row.appendChild(accepted);
        row.appendChild(accepted);
      }
      showToast(`${FIELD_LABELS[key] || key} accepted`, 'success');
    }
  };

  // Accept ALL parsed fields at once (skips unresolved conflicts & entity-level fields)
  window.acceptAllParsed = function() {
    if (!_lastParsedData) return;
    let count = 0;
    let skippedConflicts = 0;
    let skippedEntities = 0;

    // Check if entity cards are still active (not yet resolved)
    const borrowerCardActive = document.getElementById('new-borrower-card')?.style.display !== 'none'
      && document.getElementById('new-borrower-card')?.querySelector('button');
    const propertyCardActive = document.getElementById('new-property-card')?.style.display !== 'none'
      && document.getElementById('new-property-card')?.querySelector('button');

    for (const key of ALL_FIELD_KEYS) {
      if (_lastParsedData[key] != null && _lastParsedData[key] !== '') {
        // Skip fields that still have unresolved conflicts
        if (_lastConflicts[key]) {
          skippedConflicts++;
          continue;
        }
        // Skip borrower fields if the entity card is still unresolved
        if (borrowerCardActive && BORROWER_ENTITY_FIELDS.includes(key)) {
          skippedEntities++;
          continue;
        }
        // Skip property fields if the entity card is still unresolved
        if (propertyCardActive && PROPERTY_ENTITY_FIELDS.includes(key)) {
          skippedEntities++;
          continue;
        }
        if (pushFieldToMatrix(key, _lastParsedData[key])) count++;
        // Mark row
        const row = document.getElementById(`parsed-row-${key}`);
        if (row) {
          row.style.background = 'rgba(52,211,153,0.1)';
          row.style.borderColor = 'rgba(52,211,153,0.2)';
          const btns = row.querySelectorAll('button');
          btns.forEach(b => b.remove());
          const accepted = document.createElement('span');
          accepted.style.cssText = 'font-size:10px;font-weight:700;color:#34D399;';
          accepted.textContent = '\u2713 Accepted';
          row.appendChild(accepted);
        }
      }
    }
    calculateCompleteness();
    const warnings = [];
    if (skippedConflicts > 0) warnings.push(`${skippedConflicts} conflicts`);
    if (skippedEntities > 0) warnings.push(`${skippedEntities} entity fields need action above`);
    const warnMsg = warnings.length > 0 ? ` (${warnings.join(', ')})` : '';
    showToast(`${count} fields accepted and pushed to Matrix${warnMsg}`, warnings.length > 0 ? 'warning' : 'success');

    // Scroll to Matrix section
    const matrixSection = document.getElementById('section-matrix');
    if (matrixSection) {
      setTimeout(() => matrixSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 500);
    }
  };

  // Legacy compatibility — autoPopulateMatrix now routes through Parser display
  function autoPopulateMatrix(parsedData, conflicts, coreFields) {
    showParsedResults(parsedData, conflicts, coreFields);
  }

  // ── Listen for per-document parse events from Doc Repo ──
  // deal-sections.js dispatches 'docParsed' when user clicks Parse or View Data on a doc
  window.addEventListener('docParsed', function(e) {
    const { docId, filename, parsedData } = e.detail || {};
    if (parsedData && typeof parsedData === 'object') {
      console.log(`[deal-matrix] Received parsed data for doc ${docId}: "${filename}"`);
      showParsedResults(parsedData);
    }
  });

  // Step 1: Upload Documents — stores files + AI categorises (no field extraction yet)
  window.matrixUploadFiles = async function(files) {
    if (!files || files.length === 0) return;

    showParseProgress(`Uploading ${files.length} file${files.length > 1 ? 's' : ''} and categorising...`);

    try {
      const formData = new FormData();
      formData.append('deal_id', deal.submission_id);
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }

      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
        method: 'POST',
        body: formData
      });

      hideParseProgress();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Upload failed', 'error');
        return;
      }

      const data = await resp.json();
      const docCount = (data.documents || []).length;

      // If n8n also returned parsed data (backward compat), auto-fill
      if (data.parsed_data) {
        autoPopulateMatrix(data.parsed_data);
      }

      showToast(`${docCount} file${docCount !== 1 ? 's' : ''} uploaded and categorised. Please confirm categories in Document Repository, then click "Parse Confirmed Docs".`, 'success');

      // Refresh the Document Repository section to show new docs with category confirmation
      if (typeof window.refreshDocRepo === 'function') {
        window.refreshDocRepo();
      }
    } catch (e) {
      hideParseProgress();
      console.error('[matrix-upload] Upload error:', e);
      showToast('Connection error during upload', 'error');
    }

    // Reset file input
    const input = document.getElementById('matrix-parse-file-input');
    if (input) input.value = '';
  };

  // Step 3: Parse Confirmed — sends confirmed-category docs to n8n for field extraction
  window.matrixParseConfirmed = async function() {
    floatingProgress.show({
      label: 'Parsing Documents',
      message: 'AI is reading your confirmed documents and extracting deal data...',
      steps: ['Sending documents to AI...', 'Extracting deal fields...', 'Populating matrix...']
    });
    floatingProgress.updateStep(0, 'active');
    floatingProgress.updateBar(10);

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/parse-confirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deal_id: deal.submission_id })
      });

      floatingProgress.updateStep(0, 'done');
      floatingProgress.updateStep(1, 'active');
      floatingProgress.updateBar(60);

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        floatingProgress.error({ label: 'Parse Failed', message: err.error || 'Could not parse documents.' });
        return;
      }

      const data = await resp.json();
      floatingProgress.updateStep(1, 'done');
      floatingProgress.updateStep(2, 'active');
      floatingProgress.updateBar(90);

      if (data.parsed_data) {
        autoPopulateMatrix(data.parsed_data, data.conflicts, data.core_fields);
        const conflictCount = Object.keys(data.conflicts || {}).length;
        const msg = conflictCount > 0
          ? `${data.total_documents} docs parsed. ${conflictCount} conflicting fields need review.`
          : `${data.total_documents} docs parsed (${data.confirmed_documents} confirmed). Fields extracted.`;

        floatingProgress.updateStep(2, 'done');
        floatingProgress.complete({ label: 'Parsing Complete', message: msg });
      } else {
        floatingProgress.complete({
          label: 'Processing Done',
          message: data.message || `${data.total_documents} documents processed.`
        });
      }

      // Refresh Doc Repo to update Parsed status column
      if (typeof window.refreshDocRepo === 'function') {
        window.refreshDocRepo();
      }

      // Recalculate completeness
      calculateCompleteness();
    } catch (e) {
      console.error('[matrix-parse-confirmed] Error:', e);
      floatingProgress.error({ label: 'Connection Error', message: 'Could not reach server. Please try again.' });
    }
  };

  // Paste Broker Pack — text paste flow
  window.matrixParsePastedText = async function() {
    const textarea = document.getElementById('matrix-paste-text');
    const text = textarea ? textarea.value.trim() : '';
    if (!text) {
      showToast('Paste some text first', 'error');
      return;
    }

    showParseProgress('Parsing pasted text...');

    try {
      const formData = new FormData();
      formData.append('deal_id', deal.submission_id);
      formData.append('whatsapp_text', text);

      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
        method: 'POST',
        body: formData
      });

      hideParseProgress();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Parse failed', 'error');
        return;
      }

      const data = await resp.json();
      if (data.parsed_data) {
        autoPopulateMatrix(data.parsed_data);
        if (textarea) textarea.value = '';
      } else {
        showToast('Could not extract structured data from the text.', 'error');
      }
    } catch (e) {
      hideParseProgress();
      console.error('[matrix-parse] Paste error:', e);
      showToast('Connection error during parsing', 'error');
    }
  };

  // Re-Parse All — re-trigger parsing on existing deal documents
  window.matrixReParseAll = async function() {
    showParseProgress('Re-parsing all deal documents...');

    try {
      // Fetch existing documents, then re-upload them for parsing
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${deal.submission_id}/documents-by-category`, { method: 'GET' });
      if (!resp.ok) {
        hideParseProgress();
        showToast('Could not fetch existing documents', 'error');
        return;
      }

      const data = await resp.json();
      const docs = data.documents || [];
      if (docs.length === 0) {
        hideParseProgress();
        showToast('No documents to re-parse. Upload files first.', 'error');
        return;
      }

      // Send deal_id to trigger re-parse of stored documents
      const formData = new FormData();
      formData.append('deal_id', deal.submission_id);
      formData.append('reparse', 'true');

      const parseResp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
        method: 'POST',
        body: formData
      });

      hideParseProgress();

      if (!parseResp.ok) {
        const err = await parseResp.json().catch(() => ({}));
        showToast(err.error || 'Re-parse failed', 'error');
        return;
      }

      const parseData = await parseResp.json();
      if (parseData.parsed_data) {
        autoPopulateMatrix(parseData.parsed_data);
      } else {
        showToast('Re-parse completed but no data extracted.', 'error');
      }
    } catch (e) {
      hideParseProgress();
      console.error('[matrix-reparse] Error:', e);
      showToast('Connection error during re-parse', 'error');
    }
  };

  window.matrixSwitchBorrowerType = function(type) {
    document.querySelectorAll('.bf-group').forEach(g => g.classList.remove('show'));
    const group = document.getElementById(`bt-${type}`);
    if (group) group.classList.add('show');
  };

  window.matrixSwitchRepoTab = function(category) {
    console.log('Switching repo tab to:', category);
  };

  // ── Section name ↔ ID mapping for info requests ──
  const INFO_REQUEST_SECTIONS = {
    's1': 'Borrower / KYC',
    's2': 'Borrower Financials & AML',
    's3': 'Property / Security',
    's4': 'Loan Terms & Use of Funds',
    's5': 'Exit Strategy',
    's6': 'Legal & Insurance',
    's7': 'Commercial',
    's8': 'Documents Issued',
    'borrower': 'Borrower / KYC',
    'documents': 'Documents'
  };

  const SECTION_NAME_TO_ID = {};
  for (const [id, name] of Object.entries(INFO_REQUEST_SECTIONS)) {
    SECTION_NAME_TO_ID[name] = id;
  }

  // ── RM: Show modal to send info request with comment ──
  window.matrixSendInfoRequest = function(section) {
    const role = getCurrentRole();
    if (!['admin', 'rm', 'credit', 'compliance'].includes(role)) {
      showToast('Only internal staff can request information', 'error');
      return;
    }

    const sectionName = INFO_REQUEST_SECTIONS[section] || section;

    // Build section dropdown options
    const sectionOptions = Object.entries(INFO_REQUEST_SECTIONS)
      .filter(([k]) => k.startsWith('s'))
      .map(([k, name]) => `<option value="${name}" ${name === sectionName ? 'selected' : ''}>${name}</option>`)
      .join('');

    // Create modal
    let modal = document.getElementById('info-request-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'info-request-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
    modal.innerHTML = `
      <div style="background:#1a2332;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:480px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="font-size:16px;font-weight:700;color:#F1F5F9;margin-bottom:4px;">Request Information from Broker</div>
        <div style="font-size:11px;color:#94A3B8;margin-bottom:18px;">The broker will see this request and only the relevant section will unlock for editing.</div>

        <label style="font-size:10px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px;">Section</label>
        <select id="ir-section" style="width:100%;padding:10px 12px;background:#0f1729;color:#F1F5F9;border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;margin-bottom:14px;outline:none;">
          ${sectionOptions}
        </select>

        <label style="font-size:10px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px;">What do you need? <span style="color:#F87171;">*</span></label>
        <textarea id="ir-message" rows="4" placeholder="e.g. Please provide proof of funds for the deposit and a recent bank statement showing the source..." style="width:100%;padding:10px 12px;background:#0f1729;color:#F1F5F9;border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;resize:vertical;outline:none;font-family:inherit;"></textarea>

        <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end;">
          <button onclick="document.getElementById('info-request-modal').remove()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94A3B8;cursor:pointer;">Cancel</button>
          <button onclick="window.matrixSubmitInfoRequest()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;border:none;background:#D4A853;color:#0B1120;cursor:pointer;">Send Request</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    // Focus the textarea
    setTimeout(() => document.getElementById('ir-message')?.focus(), 100);
  };

  // ── RM: Submit the info request to backend ──
  window.matrixSubmitInfoRequest = async function() {
    const section = document.getElementById('ir-section')?.value;
    const message = document.getElementById('ir-message')?.value?.trim();

    if (!message) {
      showToast('Please describe what information you need', 'error');
      return;
    }

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/matrix/${deal.submission_id}/info-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, message })
      });

      if (resp.ok) {
        document.getElementById('info-request-modal')?.remove();
        showToast(`Info request sent for ${section}`, 'success');
        // Refresh the info request banner
        await loadInfoRequests();
      } else {
        const err = await resp.json();
        showToast(err.error || 'Failed to send request', 'error');
      }
    } catch (e) {
      showToast('Network error sending request', 'error');
    }
  };

  // ── Load and display info requests (banner for broker, list for RM) ──
  async function loadInfoRequests() {
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/matrix/${deal.submission_id}/info-requests`);
      if (!resp.ok) return;
      const requests = await resp.json();
      renderInfoRequestBanner(requests);
    } catch (e) {
      console.warn('[matrix] Failed to load info requests:', e);
    }
  }

  function renderInfoRequestBanner(requests) {
    const openRequests = requests.filter(r => r.status === 'open');
    const role = getCurrentRole();
    const isBroker = ['broker', 'borrower'].includes(role);

    // Remove existing banner
    const existing = document.getElementById('info-request-banner');
    if (existing) existing.remove();

    if (openRequests.length === 0) return;

    const banner = document.createElement('div');
    banner.id = 'info-request-banner';
    banner.style.cssText = 'padding:14px 26px;background:rgba(251,191,36,0.1);border-top:2px solid rgba(251,191,36,0.3);border-bottom:1px solid rgba(255,255,255,0.06);';

    const title = isBroker
      ? `<div style="font-size:14px;font-weight:700;color:#FBBF24;margin-bottom:8px;">Action Required — ${openRequests.length} item${openRequests.length > 1 ? 's' : ''} requested by your RM</div>`
      : `<div style="font-size:14px;font-weight:700;color:#FBBF24;margin-bottom:8px;">${openRequests.length} open info request${openRequests.length > 1 ? 's' : ''}</div>`;

    let itemsHtml = '';
    for (const req of openRequests) {
      const date = new Date(req.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const sectionId = SECTION_NAME_TO_ID[req.section] || '';

      if (isBroker) {
        itemsHtml += `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.15);border-radius:8px;margin-bottom:6px;">
            <span style="color:#FBBF24;font-size:14px;flex-shrink:0;margin-top:1px;">&#9888;</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:700;color:#F1F5F9;">${sanitizeHtml(req.section)}</div>
              <div style="font-size:12px;color:#CBD5E1;margin-top:2px;">${sanitizeHtml(req.message)}</div>
              <div style="font-size:10px;color:#94A3B8;margin-top:4px;">Requested ${date}</div>
            </div>
            ${sectionId ? `<button onclick="window.matrixScrollToSection('${sectionId}')" style="padding:5px 12px;border-radius:6px;font-size:10px;font-weight:600;border:1px solid rgba(251,191,36,0.3);background:rgba(251,191,36,0.15);color:#FBBF24;cursor:pointer;white-space:nowrap;flex-shrink:0;">Go to Section</button>` : ''}
          </div>`;
      } else {
        itemsHtml += `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.15);border-radius:8px;margin-bottom:6px;">
            <span style="color:#FBBF24;font-size:14px;flex-shrink:0;margin-top:1px;">&#9888;</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:700;color:#F1F5F9;">${sanitizeHtml(req.section)}</div>
              <div style="font-size:12px;color:#CBD5E1;margin-top:2px;">${sanitizeHtml(req.message)}</div>
              <div style="font-size:10px;color:#94A3B8;margin-top:4px;">Requested ${date} by ${sanitizeHtml(req.requested_role || 'RM')}</div>
            </div>
            <button onclick="window.matrixResolveInfoRequest(${req.id})" style="padding:5px 12px;border-radius:6px;font-size:10px;font-weight:600;border:1px solid rgba(52,211,153,0.3);background:rgba(52,211,153,0.15);color:#34D399;cursor:pointer;white-space:nowrap;flex-shrink:0;">Mark Resolved</button>
          </div>`;
      }
    }

    banner.innerHTML = title + itemsHtml;

    // Insert banner right after the completeness bar
    const completenessBar = document.getElementById('matrix-completeness-bar');
    if (completenessBar && completenessBar.parentNode) {
      completenessBar.parentNode.insertBefore(banner, completenessBar.nextSibling);
    }

    // ── Unlock requested sections for broker ──
    if (isBroker) {
      unlockRequestedSections(openRequests);
    }
  }

  // ── Unlock only the sections that have open info requests for broker editing ──
  function unlockRequestedSections(openRequests) {
    const requestedSectionIds = new Set();
    for (const req of openRequests) {
      const sId = SECTION_NAME_TO_ID[req.section];
      if (sId) requestedSectionIds.add(sId);
    }

    // Find all inputs/selects/textareas within requested sections and enable them
    for (const sId of requestedSectionIds) {
      const content = document.getElementById(`content-${sId}`);
      if (content) {
        content.querySelectorAll('input, select, textarea').forEach(el => {
          el.removeAttribute('disabled');
          el.removeAttribute('readonly');
          el.style.opacity = '1';
        });
        // Also remove the read-only overlay if one exists
        const overlay = content.querySelector('.readonly-overlay');
        if (overlay) overlay.remove();
      }
    }
  }

  // ── RM: Resolve an info request ──
  window.matrixResolveInfoRequest = async function(requestId) {
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/matrix/${deal.submission_id}/info-request/${requestId}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });

      if (resp.ok) {
        showToast('Info request marked as resolved', 'success');
        await loadInfoRequests();
      } else {
        showToast('Failed to resolve request', 'error');
      }
    } catch (e) {
      showToast('Network error', 'error');
    }
  };

  // ── Load info requests on initial render ──
  loadInfoRequests();

  window.matrixUpdateFieldStatus = function(fieldKey, stage, newStatus) {
    const role = getCurrentRole();
    if (!['admin', 'rm', 'credit', 'compliance'].includes(role)) {
      showToast('Insufficient permissions', 'error');
      return;
    }
    showToast(`Field ${fieldKey} updated to ${newStatus}`, 'success');
  };

  window.matrixVerifyDocument = function(docId) {
    const role = getCurrentRole();
    if (!['admin', 'rm', 'credit', 'compliance'].includes(role)) {
      showToast('Insufficient permissions', 'error');
      return;
    }
    showToast(`Document ${docId} verified`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  // DIP READINESS — section-by-section validation
  // ═══════════════════════════════════════════════════════════════════

  // ── Stage-aware validation tiers ──
  // DIP = simple (broker fills basics), ITS = detailed, Formal = comprehensive
  const isCorporate = () => {
    const bt = document.getElementById('mf-borrower_type')?.value;
    return bt && bt !== 'individual';
  };

  const STAGE_VALIDATION = {
    // ── DIP: broker submits for RM review ──
    dip: {
      'Borrower / KYC': {
        required: ['borrower_name', 'borrower_type'],
        conditional: [
          { fields: ['company_name', 'company_number'], when: isCorporate },
          { fields: ['borrower_email'], atLeastOne: ['borrower_email', 'borrower_phone'] }
        ],
        nice: ['borrower_dob', 'borrower_nationality']
      },
      'Property / Security': {
        required: ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'current_value', 'occupancy_status', 'current_use'],
        nice: []
      },
      'Loan Terms': {
        required: ['loan_amount', 'drawdown_date'],
        nice: ['ltv_requested', 'term_months', 'interest_servicing', 'loan_purpose', 'use_of_funds']
      },
      'Exit Strategy': {
        required: ['exit_strategy'],
        nice: ['additional_notes']
      }
      // Fees/Commercial excluded from DIP — RM responsibility, not broker
    },

    // ── INDICATIVE TERM SHEET: RM issues ITS — needs more detail ──
    its: {
      'Borrower / KYC': {
        required: ['borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality'],
        conditional: [
          { fields: ['company_name', 'company_number', 'borrower_jurisdiction'], when: isCorporate }
        ]
      },
      'Borrower Financials': {
        required: ['estimated_net_worth', 'source_of_wealth']
      },
      'Property / Security': {
        required: ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'current_value', 'occupancy_status', 'current_use'],
        nice: ['purchase_price']
      },
      'Loan Terms': {
        required: ['loan_amount', 'term_months', 'interest_servicing', 'loan_purpose', 'ltv_requested', 'drawdown_date'],
        nice: ['use_of_funds']
      },
      'Exit Strategy': {
        required: ['exit_strategy'],
        nice: ['additional_notes']
      },
      'Fees': {
        required: ['arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee'],
        nice: ['retained_interest_months']
      },
      'AML & Source of Funds': {
        required: ['deposit_source'],
        nice: ['existing_charges', 'concurrent_transactions']
      }
    },

    // ── FORMAL OFFER: full underwriting — everything required ──
    formal: {
      'Borrower / KYC': {
        required: ['borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality'],
        conditional: [
          { fields: ['company_name', 'company_number', 'borrower_jurisdiction'], when: isCorporate }
        ]
      },
      'Borrower Financials': {
        required: ['estimated_net_worth', 'source_of_wealth']
      },
      'Property / Security': {
        required: ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'current_value', 'occupancy_status', 'current_use', 'purchase_price']
      },
      'Loan Terms': {
        required: ['loan_amount', 'term_months', 'interest_servicing', 'loan_purpose', 'ltv_requested', 'drawdown_date', 'use_of_funds']
      },
      'Exit Strategy': {
        required: ['exit_strategy', 'additional_notes']
      },
      'Fees': {
        required: ['arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee', 'retained_interest_months']
      },
      'AML & Source of Funds': {
        required: ['deposit_source', 'existing_charges', 'concurrent_transactions']
      }
    }
  };

  // Resolve which tier we're in based on deal stage
  function getValidationTier() {
    const stage = currentStage || 'received';
    if (['received', 'info_gathering'].includes(stage)) return 'dip';
    if (['dip_issued', 'ai_termsheet', 'fee_pending'].includes(stage)) return 'its';
    return 'formal'; // underwriting, bank_submission, etc.
  }

  // Get current sections for the active tier
  function getCurrentSections() {
    return STAGE_VALIDATION[getValidationTier()];
  }

  // All key fields (flat list for overall completeness)
  const KEY_FIELDS = Object.values(STAGE_VALIDATION.formal).flatMap(s => [...(s.required || []), ...(s.nice || [])]);

  /**
   * Check if a Matrix field has a value
   */
  function fieldHasValue(key) {
    // First check the HTML input element
    const el = document.getElementById(`mf-${key}`);
    if (el && el.value && el.value.trim() !== '' && el.value.trim() !== '— Select —') return true;

    // If deal has portfolio properties, map deal_properties columns → STAGE_VALIDATION field keys
    // (these fields live in deal_properties table, not flat deal_submissions inputs)
    if (deal.properties && deal.properties.length > 0) {
      const propFieldMap = {
        'security_address': p => p.address,
        'security_postcode': p => p.postcode,
        'current_value': p => p.market_value,
        'purchase_price': p => p.purchase_price,
        'asset_type': p => p.property_type,
        'property_tenure': p => p.tenure,
        'occupancy_status': p => p.occupancy,
        'current_use': p => p.current_use
      };
      if (propFieldMap[key]) {
        // Check first property (for single security) or any property (for portfolio)
        const anyHasValue = deal.properties.some(p => {
          const val = propFieldMap[key](p);
          return val !== null && val !== undefined && String(val).trim() !== '';
        });
        if (anyHasValue) return true;
      }
    }

    // If deal has borrowers in deal_borrowers, map to flat borrower field keys
    if (deal.borrowers && deal.borrowers.length > 0) {
      const primary = deal.borrowers.find(b => b.role === 'primary') || deal.borrowers[0];
      const borrowerFieldMap = {
        'borrower_name': primary.full_name,
        'borrower_type': primary.borrower_type,
        'borrower_email': primary.email,
        'borrower_phone': primary.phone,
        'borrower_dob': primary.date_of_birth,
        'borrower_nationality': primary.nationality,
        'company_name': primary.company_name,
        'company_number': primary.company_number
      };
      if (borrowerFieldMap[key] !== undefined && borrowerFieldMap[key] !== null && String(borrowerFieldMap[key]).trim() !== '') {
        return true;
      }
    }

    // Also check the raw deal object for fields that may not have an input element
    if (deal[key] !== null && deal[key] !== undefined && String(deal[key]).trim() !== '') return true;

    return false;
  }

  /**
   * Calculate readiness for current stage — returns { ready, pct, tier, sections: { name: { status, missing, filled, total } } }
   */
  function calculateDipReadiness() {
    const tier = getValidationTier();
    const sections = getCurrentSections();
    const result = { ready: true, tier, sections: {}, totalRequired: 0, totalFilled: 0 };

    for (const [name, config] of Object.entries(sections)) {
      const section = { status: 'ready', missing: [], filled: 0, total: 0 };

      // Check required fields
      for (const key of config.required) {
        section.total++;
        if (fieldHasValue(key)) {
          section.filled++;
        } else {
          section.missing.push(key);
        }
      }

      // Check conditional fields
      if (config.conditional) {
        for (const cond of config.conditional) {
          if (cond.when && !cond.when()) continue; // condition not met, skip

          if (cond.atLeastOne) {
            // At least one of these must be filled
            section.total++;
            const anyFilled = cond.atLeastOne.some(k => fieldHasValue(k));
            if (anyFilled) {
              section.filled++;
            } else {
              // Push each field individually so highlighting can find them by data-field
              cond.atLeastOne.forEach(k => section.missing.push(k));
            }
          } else if (cond.fields) {
            for (const key of cond.fields) {
              section.total++;
              if (fieldHasValue(key)) {
                section.filled++;
              } else {
                section.missing.push(key);
              }
            }
          }
        }
      }

      // Determine section status
      if (section.missing.length === 0) {
        section.status = 'ready';
      } else if (section.filled > 0) {
        section.status = 'partial';
      } else {
        section.status = 'empty';
      }

      if (section.missing.length > 0) result.ready = false;
      result.totalRequired += section.total;
      result.totalFilled += section.filled;
      result.sections[name] = section;
    }

    // ── CH Role Verification gate for corporate borrowers ──
    const bType = (deal.borrower_type || 'individual').toLowerCase();
    const isCorporateDeal = ['corporate', 'spv', 'ltd', 'llp'].includes(bType);
    if (isCorporateDeal && deal.borrowers && deal.borrowers.length > 0) {
      const unverified = deal.borrowers.filter(b => !b.ch_verified_at);
      if (unverified.length > 0) {
        result.ready = false;
        result.chGateBlocked = true;
        result.chUnverifiedCount = unverified.length;
        // Add to Borrower / KYC section missing
        if (result.sections['Borrower / KYC']) {
          result.sections['Borrower / KYC'].status = 'partial';
          result.sections['Borrower / KYC'].missing.push('ch_role_verification');
          result.totalRequired++;
        }
      } else {
        result.totalRequired++;
        result.totalFilled++;
      }
    }

    // Overall completeness — based on current tier's required fields only (smart, not inflated)
    result.pct = result.totalRequired > 0 ? Math.round((result.totalFilled / result.totalRequired) * 100) : 0;
    result.requiredPct = result.pct; // Same thing now — both based on required fields for current tier

    return result;
  }

  /**
   * Update the completeness bar AND the CTA readiness indicator
   */
  function calculateCompleteness() {
    const readiness = calculateDipReadiness();
    const pct = readiness.pct;

    const pctEl = document.getElementById('matrix-completeness-pct');
    const fillEl = document.getElementById('matrix-completeness-fill');
    const detailEl = document.getElementById('matrix-completeness-detail');
    const statusEl = document.getElementById('matrix-completeness-status');

    if (pctEl) pctEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
    // Green completeness bar when >=75%, gold otherwise
    if (fillEl) fillEl.style.background = pct >= 75 ? '#34D399' : '#D4A853';
    if (pctEl) pctEl.style.color = pct >= 75 ? '#34D399' : '#D4A853';
    if (detailEl) detailEl.textContent = `${readiness.totalFilled} of ${readiness.totalRequired} required fields completed`;

    // Update the DIP tier progress bar to match
    const dipBarFill = document.getElementById('tier-bar-dip-fill');
    const dipBarPct = document.getElementById('tier-bar-dip-pct');
    if (dipBarFill) {
      dipBarFill.style.width = readiness.requiredPct + '%';
      dipBarFill.style.background = readiness.requiredPct >= 75
        ? 'linear-gradient(90deg,#34D399,#6EE7B7)'
        : readiness.requiredPct >= 50
        ? 'linear-gradient(90deg,#D4A853,#E8C97A)'
        : 'linear-gradient(90deg,#F87171,#FCA5A5)';
    }
    if (dipBarPct) {
      dipBarPct.textContent = readiness.requiredPct + '%';
      dipBarPct.style.color = readiness.requiredPct >= 75 ? '#34D399' : readiness.requiredPct >= 50 ? '#D4A853' : '#F87171';
    }

    const tierLabels = { dip: 'DIP Submission', its: 'Indicative Term Sheet', formal: 'Formal Offer' };

    if (statusEl) {
      const tierName = tierLabels[readiness.tier] || 'Submission';
      // If deal is already past received stage, show submitted status instead of "More Info Needed"
      const alreadySubmitted = currentStage && currentStage !== 'received';
      if (alreadySubmitted) {
        statusEl.textContent = 'Submitted — Under Review';
        statusEl.style.color = '#E8C97A';
      } else if (readiness.ready) {
        statusEl.textContent = `Ready for ${tierName}`;
        statusEl.style.color = '#34D399';
      } else if (readiness.requiredPct >= 60) {
        statusEl.textContent = `Almost Ready — ${tierName}`;
        statusEl.style.color = '#D4A853';
      } else {
        statusEl.textContent = `More Info Needed — ${tierName}`;
        statusEl.style.color = '#F87171';
      }
    }

    // Update the CTA section readiness checklist if it exists
    const checklistEl = document.getElementById('dip-readiness-checklist');
    // Map DIP section names → Matrix section IDs for scroll navigation
    const SECTION_SCROLL_MAP = {
      'Borrower / KYC': 's1',
      'Borrower Financials': 's2',
      'Property / Security': 's3',
      'Loan Terms': 's4',
      'Exit Strategy': 's5',
      'Fees': 's7',
      'AML & Source of Funds': 's2'  // AML is within Borrower Financials section
    };
    if (checklistEl) {
      let checkHtml = '';
      for (const [name, sec] of Object.entries(readiness.sections)) {
        const icon = sec.status === 'ready' ? '&#10003;' : sec.status === 'partial' ? '&#9888;' : '&#10005;';
        const color = sec.status === 'ready' ? '#34D399' : sec.status === 'partial' ? '#D4A853' : '#F87171';
        const bg = sec.status === 'ready' ? 'rgba(52,211,153,0.1)' : sec.status === 'partial' ? 'rgba(251,191,36,0.1)' : 'rgba(248,113,113,0.1)';
        const missingText = sec.missing.length > 0
          ? sec.missing.map(k => FIELD_LABELS[k] || k.replace(/_/g, ' ')).join(', ')
          : '';
        const scrollTarget = SECTION_SCROLL_MAP[name] || '';
        const clickable = sec.status !== 'ready' && scrollTarget;
        const cursorStyle = clickable ? 'cursor:pointer;' : '';
        const missingFieldsJson = clickable && sec.missing.length > 0
          ? JSON.stringify(sec.missing).replace(/"/g, '&quot;')
          : '[]';
        const clickHandler = clickable ? `onclick="window.matrixScrollToSection('${scrollTarget}', ${sec.missing.length > 0 ? 'JSON.parse(this.getAttribute(&quot;data-missing&quot;))' : 'null'})" data-missing="${missingFieldsJson}"` : '';
        const hoverTitle = clickable ? `title="Click to go to ${name} section"` : '';
        checkHtml += `
          <div ${clickHandler} ${hoverTitle} style="display:flex;align-items:flex-start;gap:8px;padding:5px 10px;border-radius:6px;background:${bg};margin-bottom:3px;${cursorStyle}transition:opacity .15s;" ${clickable ? 'onmouseover="this.style.opacity=0.8" onmouseout="this.style.opacity=1"' : ''}>
            <span style="font-size:13px;color:${color};font-weight:700;flex-shrink:0;">${icon}</span>
            <div style="flex:1;">
              <span style="font-size:12px;font-weight:600;color:#F1F5F9;">${name}</span>
              ${missingText ? `<div style="font-size:10px;color:${color};margin-top:1px;">Missing: ${missingText}</div>` : ''}
              ${clickable ? '<div style="font-size:9px;color:#D4A853;margin-top:2px;">Click to complete ↓</div>' : ''}
            </div>
          </div>`;
      }
      checklistEl.innerHTML = checkHtml;
    }

    // Enable/disable submit button based on readiness
    const submitCta = document.querySelector('#matrix-submit-cta button');
    if (submitCta && currentStage === 'received') {
      if (readiness.ready) {
        submitCta.disabled = false;
        submitCta.style.opacity = '1';
        submitCta.style.background = '#34D399';
      } else {
        submitCta.disabled = true;
        submitCta.style.opacity = '0.5';
        submitCta.style.background = '#94A3B8';
      }
    }

    // ── Update DIP pills on section headers and field rows ──
    updateDipPills();

    return pct;
  }

  /**
   * Update all DIP column pills (section headers + field rows) based on actual field values
   */
  function updateDipPills() {
    // ── Derive relevant fields from STAGE_VALIDATION for current tier ──
    const tier = getValidationTier();
    const tierSections = STAGE_VALIDATION[tier] || STAGE_VALIDATION.dip;

    // Collect ALL fields (required + nice) for each validation section at this tier
    function getTierFields(sectionName) {
      const cfg = tierSections[sectionName];
      if (!cfg) return [];
      return [...(cfg.required || []), ...(cfg.nice || [])];
    }

    // Map section names → section header IDs
    const SECTION_ID_MAP = {
      'Borrower / KYC': 's1',
      'Borrower Financials': 's2',
      'Property / Security': 's3',
      'Loan Terms': 's4',
      'Exit Strategy': 's5',
      'Fees': 's7',
      'AML & Source of Funds': 's2'  // AML fields roll up into s2 header
    };

    // Map field rows → which validation sections they draw from, and which specific fields
    const ROW_SECTION_MAP = {
      'primary-borrower': { section: 'Borrower / KYC', fields: ['borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality'] },
      'guarantors': { section: null, fields: [] },
      'financial-summary': { section: 'Borrower Financials', fields: ['estimated_net_worth', 'source_of_wealth'] },
      'assets': { section: null, fields: [] },
      'liabilities': { section: null, fields: [] },
      'income': { section: null, fields: [] },
      'expenses': { section: null, fields: [] },
      'aml-source-funds': { section: 'AML & Source of Funds', fields: ['deposit_source', 'existing_charges', 'concurrent_transactions'] },
      'property-details': { section: 'Property / Security', fields: ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'occupancy_status', 'current_use'] },
      'property-valuation': { section: 'Property / Security', fields: ['current_value', 'purchase_price'] },
      'loan-terms': { section: 'Loan Terms', fields: ['loan_amount', 'ltv_requested', 'term_months', 'interest_servicing', 'drawdown_date'] },
      'use-of-funds': { section: 'Loan Terms', fields: ['loan_purpose', 'use_of_funds'] },
      'exit-strategy': { section: 'Exit Strategy', fields: ['exit_strategy', 'additional_notes'] },
      'refinance-evidence': { section: null, fields: [] },
      'fees': { section: 'Fees', fields: ['arrangement_fee_pct', 'broker_fee_pct', 'commitment_fee', 'retained_interest_months'] },
      'credit-approval': { section: null, fields: [] }
    };

    // Helper: determine pill status — only count fields that exist in the current tier
    function getPillStatus(allFields, sectionName) {
      const tierFields = sectionName ? getTierFields(sectionName) : [];
      // Filter: only count fields that matter at this stage
      const relevant = sectionName ? allFields.filter(f => tierFields.includes(f)) : allFields;
      if (!relevant || relevant.length === 0) return { status: 'not-started', count: 0 };
      const filled = relevant.filter(k => fieldHasValue(k)).length;
      if (filled === relevant.length) return { status: 'complete', count: filled };
      if (filled > 0) return { status: 'incomplete', count: filled };
      return { status: 'not-started', count: 0 };
    }

    // Pill colours
    const pillColors = {
      'complete': { bg: 'rgba(52,211,153,0.1)', color: '#34D399' },
      'incomplete': { bg: 'rgba(212,168,83,0.15)', color: '#FBBF24' },
      'not-started': { bg: '#1a2332', color: '#94A3B8' }
    };

    // ── Update section header dots ──
    // Aggregate all tier fields per section header ID
    const secAgg = {};
    for (const [sectionName, secId] of Object.entries(SECTION_ID_MAP)) {
      const fields = getTierFields(sectionName);
      if (!secAgg[secId]) secAgg[secId] = [];
      secAgg[secId].push(...fields);
    }
    for (const [secId, fields] of Object.entries(secAgg)) {
      const el = document.getElementById('dip-sec-' + secId);
      if (!el) continue;
      // Deduplicate
      const unique = [...new Set(fields)];
      const filled = unique.filter(k => fieldHasValue(k)).length;
      const status = unique.length === 0 ? 'not-started' : filled === unique.length ? 'complete' : filled > 0 ? 'incomplete' : 'not-started';
      const c = pillColors[status] || pillColors['not-started'];
      el.style.background = c.bg;
      el.style.color = c.color;
      el.textContent = filled > 0 ? filled : '—';
    }

    // ── Update field row DIP pills ──
    for (const [rowKey, config] of Object.entries(ROW_SECTION_MAP)) {
      const el = document.getElementById('dip-fpill-' + rowKey);
      if (!el) continue;
      const { status } = getPillStatus(config.fields, config.section);
      const pillLabel = status === 'complete' ? 'complete' : status === 'incomplete' ? 'incomplete' : 'not started';
      const pillStatus = status === 'complete' ? 'approved' : status === 'incomplete' ? 'under-review' : 'not-started';
      el.innerHTML = renderPill(pillStatus, pillLabel);
    }
  }

  // Initial completeness calculation on load
  setTimeout(calculateCompleteness, 500);

  // ── If deal is already past 'received' stage, disable submit button and action buttons for brokers ──
  if (currentStage !== 'received' && !isInternalUser) {
    setTimeout(() => {
      const btn = document.getElementById('matrix-submit-review-btn');
      if (btn) {
        btn.innerHTML = '✅ Submitted for Review';
        btn.style.background = 'rgba(52,211,153,0.2)';
        btn.style.color = '#34D399';
        btn.disabled = true;
        btn.style.cursor = 'default';
      }
      // Also show a banner on the completeness bar
      const compBar = document.getElementById('matrix-completeness-bar');
      if (compBar) {
        const banner = document.createElement('div');
        banner.style.cssText = 'background:rgba(212,168,83,0.15);border:1px solid rgba(212,168,83,0.25);border-radius:6px;padding:8px 14px;margin-top:10px;font-size:12px;color:#E8C97A;font-weight:600;text-align:center;';
        banner.textContent = 'This deal has been submitted for RM review. Matrix is now read-only.';
        compBar.appendChild(banner);
      }
    }, 200);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUBMIT FOR REVIEW — Step 4
  // ═══════════════════════════════════════════════════════════════════
  window.matrixSubmitForReview = async function() {
    const readiness = calculateDipReadiness();
    const pct = readiness.pct;

    if (!readiness.ready) {
      // Build a per-section error message
      const incomplete = Object.entries(readiness.sections)
        .filter(([, s]) => s.status !== 'ready')
        .map(([name, s]) => {
          const missing = s.missing.map(k => FIELD_LABELS[k] || k.replace(/_/g, ' ')).join(', ');
          return `• ${name}: missing ${missing}`;
        });
      showToast('Cannot submit yet — please complete all required fields:\n' + incomplete.join('\n'), 'error');
      return;
    }

    // All required fields filled — confirm with user
    if (!confirm('All required sections are complete. Submit this deal for RM review?')) return;

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${deal.submission_id}/submit-for-review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completeness: pct, readiness_sections: readiness.sections })
      });

      if (resp.ok) {
        const data = await resp.json();
        const msg = data.notification_sent
          ? 'Deal submitted for review — RM has been notified via email.'
          : 'Deal submitted for review. No RM assigned yet — an admin will pick it up.';
        showToast(msg, 'success');

        // Update submit button to show submitted state
        const btn = document.getElementById('matrix-submit-review-btn');
        if (btn) {
          btn.innerHTML = '✅ Submitted for Review';
          btn.style.background = 'rgba(52,211,153,0.2)';
          btn.style.color = '#34D399';
          btn.disabled = true;
          btn.style.cursor = 'default';
        }

        // Replace the top CTA with confirmation banner
        const cta = document.getElementById('matrix-submit-cta');
        if (cta) {
          cta.style.background = 'rgba(212,168,83,0.15)';
          cta.style.borderColor = 'rgba(212,168,83,0.25)';
          cta.innerHTML = `<div style="text-align:center;padding:6px;">
            <span style="font-size:13px;font-weight:700;color:#E8C97A;">&#10003; Deal submitted for RM review${data.notification_sent ? ' — RM has been notified' : ''}</span>
          </div>`;
        }
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Failed to submit for review', 'error');
      }
    } catch (e) {
      console.error('[matrix-submit] Error:', e);
      showToast('Connection error', 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // TOGGLE CH VERIFIED DETAIL — collapse/expand CH data after verification
  // ═══════════════════════════════════════════════════════════════════
  window._chVerifiedLoaded = false;
  window._toggleChVerifiedDetail = async function(companyNumber, submissionId) {
    const detail = document.getElementById('ch-verified-detail');
    const arrow = document.getElementById('ch-verified-arrow');
    if (!detail) return;
    const isOpen = detail.style.maxHeight !== '0px' && detail.style.maxHeight !== '';

    if (isOpen) {
      // Collapse
      detail.style.maxHeight = '0px';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
    } else {
      // Expand — lazy-load CH data on first open
      if (!window._chVerifiedLoaded && companyNumber) {
        const panel = document.getElementById('ch-matrix-panel');
        const reconPanel = document.getElementById('ch-reconciliation-panel');
        if (panel) {
          panel.innerHTML = '<div style="padding:12px;text-align:center;color:#94A3B8;font-size:12px;">Loading Companies House data...</div>';
          try {
            await renderFullVerification(companyNumber, panel);
            // Also load reconciliation
            if (reconPanel && submissionId) {
              const [chResp, bResp] = await Promise.all([
                fetchWithAuth(`${API_BASE}/api/companies-house/verify/${companyNumber}`),
                fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers`)
              ]);
              const chData = await chResp.json();
              const bData = await bResp.json();
              if (chData.verification?.found && bData.borrowers?.length > 0) {
                renderReconciliation(reconPanel, chData.verification, bData.borrowers, submissionId);
              }
            }
            window._chVerifiedLoaded = true;
          } catch (e) {
            panel.innerHTML = '<div style="padding:12px;color:#F87171;font-size:12px;">Failed to load — click to retry</div>';
          }
        }
      }
      detail.style.maxHeight = '4000px';
      if (arrow) arrow.style.transform = 'rotate(180deg)';
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // REFRESH DOC REPO — called after upload to refresh document list
  // ═══════════════════════════════════════════════════════════════════
  window.refreshDocRepo = async function() {
    // Dynamic import to avoid circular dependency
    try {
      const { renderDocRepo } = await import('./deal-sections.js');
      const role = getCurrentRole();
      await renderDocRepo(deal.submission_id, role);
    } catch (e) {
      console.warn('[matrix] Could not refresh doc repo:', e);
    }
  };

  // Initialize all sections as closed except first one
  document.querySelectorAll('[id^="sec-s"]').forEach((sec, idx) => {
    if (idx > 0) {
      sec.classList.remove('open');
    }
  });
}

// ── Property Auto-Search (Postcodes.io + EPC + Price Paid) ──────────────────
window._propertySearch = async function(propertyId, submissionId) {
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Searching...'; btn.style.opacity = '0.6'; }

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    // Guard against empty body (upstream error) before calling .json()
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || 'Empty response from server' }; }

    if (!res.ok) {
      alert('Property search failed (' + res.status + '): ' + (data.error || 'Unknown error'));
      if (btn) { btn.disabled = false; btn.textContent = 'Search Property Data'; btn.style.opacity = '1'; }
      return;
    }

    if (data.geo_warning) {
      alert(data.geo_warning);
    }

    // Refresh the deal in place (stays on the matrix view)
    setTimeout(() => _refreshDealInPlace(submissionId), 600);
  } catch (err) {
    console.error('[property-search] Error:', err);
    alert('Property search error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Search Property Data'; btn.style.opacity = '1'; }
  }
};

// ── Toggle Property Intelligence panel expand/collapse ─────────────────────
// Pure DOM, no API call. Flip the body display, rotate the chevron, show/hide inline summary.
window._togglePropPanel = function(propertyId) {
  const body = document.getElementById('prop-body-' + propertyId);
  const chevron = document.getElementById('prop-chevron-' + propertyId);
  const summary = document.getElementById('prop-summary-' + propertyId);
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  if (isCollapsed) {
    body.style.display = 'block';
    if (summary) summary.style.display = 'none';
    if (chevron) chevron.style.transform = 'rotate(90deg)';
  } else {
    body.style.display = 'none';
    if (summary) summary.style.display = 'inline';
    if (chevron) chevron.style.transform = '';
  }
};

// ── Accept the current EPC match (lock property) ────────────────────────────
// Silent local update — no page refresh. Marks verified in DB, updates local DOM:
// shows Accepted badge, swaps button to Undo, collapses body to inline summary.
window._propertyVerify = async function(propertyId, submissionId) {
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Accepting...'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const text = await res.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) {
      alert('Accept failed (' + res.status + '): ' + (data.error || 'Unknown'));
      if (btn) { btn.disabled = false; btn.textContent = '\u2713 Accept'; btn.style.opacity = '1'; }
      return;
    }
    // ── Local DOM update: badge, border, button swap, collapse body ──
    const panel = document.getElementById('prop-intel-' + propertyId);
    if (panel) panel.style.borderColor = 'rgba(52,211,153,0.45)';
    const badge = document.getElementById('prop-accepted-' + propertyId);
    if (badge) badge.style.display = 'inline-block';
    const body = document.getElementById('prop-body-' + propertyId);
    const summary = document.getElementById('prop-summary-' + propertyId);
    const chevron = document.getElementById('prop-chevron-' + propertyId);
    if (body) body.style.display = 'none';
    if (summary) summary.style.display = 'inline';
    if (chevron) chevron.style.transform = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Undo Accept';
      btn.style.background = 'rgba(212,168,83,0.15)';
      btn.style.color = '#D4A853';
      btn.style.opacity = '1';
      btn.setAttribute('onclick', "event.stopPropagation();window._propertyUnverify(" + propertyId + ", '" + submissionId + "')");
    }
    showToast('Property accepted', 'success');
  } catch (err) {
    console.error('[property-verify] Error:', err);
    alert('Accept error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '\u2713 Accept'; btn.style.opacity = '1'; }
  }
};

// ── Undo the accept (re-editable) ───────────────────────────────────────────
// Also a silent local update — no page refresh.
window._propertyUnverify = async function(propertyId, submissionId) {
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Undoing...'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/unverify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const text = await res.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) {
      alert('Undo failed (' + res.status + '): ' + (data.error || 'Unknown'));
      if (btn) { btn.disabled = false; btn.textContent = 'Undo Accept'; btn.style.opacity = '1'; }
      return;
    }
    // ── Local DOM update: hide badge, button swap, re-expand body ──
    const panel = document.getElementById('prop-intel-' + propertyId);
    if (panel) panel.style.borderColor = 'rgba(52,211,153,0.15)';
    const badge = document.getElementById('prop-accepted-' + propertyId);
    if (badge) badge.style.display = 'none';
    const body = document.getElementById('prop-body-' + propertyId);
    const summary = document.getElementById('prop-summary-' + propertyId);
    const chevron = document.getElementById('prop-chevron-' + propertyId);
    if (body) body.style.display = 'block';
    if (summary) summary.style.display = 'none';
    if (chevron) chevron.style.transform = 'rotate(90deg)';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '\u2713 Accept';
      btn.style.background = '#34D399';
      btn.style.color = '#111';
      btn.style.opacity = '1';
      btn.setAttribute('onclick', "event.stopPropagation();window._propertyVerify(" + propertyId + ", '" + submissionId + "')");
    }
    showToast('Property reset to editable', 'success');
  } catch (err) {
    console.error('[property-unverify] Error:', err);
    alert('Undo error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Undo Accept'; btn.style.opacity = '1'; }
  }
};

// ── Manually select an EPC from the picker dropdown ─────────────────────────
window._propertySelectEpc = async function(propertyId, submissionId) {
  const btn = event && event.target;
  const select = document.getElementById('epc-picker-' + propertyId);
  const lmkKey = select ? select.value : '';
  if (!lmkKey) { alert('Pick an EPC certificate from the dropdown first.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/select-epc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lmk_key: lmkKey })
    });
    const text = await res.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) {
      alert('EPC selection failed (' + res.status + '): ' + (data.error || 'Unknown'));
      if (btn) { btn.disabled = false; btn.textContent = 'Apply'; btn.style.opacity = '1'; }
      return;
    }
    setTimeout(() => _refreshDealInPlace(submissionId), 500);
  } catch (err) {
    console.error('[select-epc] Error:', err);
    alert('EPC selection error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; btn.style.opacity = '1'; }
  }
};

// ── Companies House verify + borrower reconciliation from matrix ─────────────
window._chMatrixVerify = async function(companyNumber, submissionId) {
  const btn = document.getElementById('ch-matrix-verify-btn');
  const panel = document.getElementById('ch-matrix-panel');
  const reconPanel = document.getElementById('ch-reconciliation-panel');
  if (!panel) return;

  if (btn) { btn.textContent = 'Verifying...'; btn.disabled = true; }

  try {
    // 1. Run CH verification
    await renderFullVerification(companyNumber, panel);
    if (btn) btn.style.display = 'none';

    // 2. Fetch CH data + borrowers for reconciliation
    if (reconPanel && submissionId) {
      const [chResp, bResp] = await Promise.all([
        fetchWithAuth(`${API_BASE}/api/companies-house/verify/${companyNumber}`),
        fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers`)
      ]);
      const chData = await chResp.json();
      const bData = await bResp.json();

      if (chData.verification?.found && bData.borrowers?.length > 0) {
        renderReconciliation(reconPanel, chData.verification, bData.borrowers, submissionId);
      }
    }
  } catch (e) {
    console.error('[ch-verify] Error:', e);
    if (btn) { btn.textContent = 'Error — retry'; btn.disabled = false; btn.style.background = '#F87171'; }
  }
};

/**
 * Render borrower ↔ Companies House reconciliation panel
 * Auto-matches borrowers against directors/PSCs by name similarity
 */
function renderReconciliation(container, chData, borrowers, submissionId) {
  const officers = chData.officers || [];
  const pscs = chData.pscs || [];

  // Build CH person list (directors + PSCs deduplicated)
  const chPersons = [];
  officers.filter(o => o.officer_role === 'director').forEach(o => {
    chPersons.push({ name: o.name, roles: ['Director'], appointed: o.appointed_on, nationality: o.nationality, source: 'officer' });
  });
  pscs.forEach(p => {
    const existing = chPersons.find(c => nameMatch(c.name, p.name));
    if (existing) {
      existing.roles.push('PSC');
      existing.control = (p.natures_of_control || []).map(n => n.replace(/-/g, ' ')).join(', ');
    } else {
      chPersons.push({ name: p.name, roles: ['PSC'], nationality: p.nationality, control: (p.natures_of_control || []).map(n => n.replace(/-/g, ' ')).join(', '), source: 'psc' });
    }
  });

  // Match each borrower against CH persons
  const matches = borrowers.map(b => {
    const match = chPersons.find(c => nameMatch(c.name, b.full_name));
    return {
      borrower: b,
      chMatch: match || null,
      confidence: match ? 'matched' : 'no_match',
      suggestedRole: match ? (match.roles.includes('Director') ? 'director' : 'primary') : (b.role === 'primary' ? 'guarantor' : b.role),
      alreadyVerified: !!b.ch_verified_at
    };
  });

  // Check if all already verified
  if (matches.every(m => m.alreadyVerified)) {
    container.innerHTML = `
      <div style="background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.3);border-radius:10px;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:#34D399;font-size:16px;">&#10003;</span>
          <div>
            <span style="font-size:13px;font-weight:700;color:#34D399;">All Borrower Roles Verified</span>
            <div style="font-size:11px;color:#94A3B8;margin-top:2px;">Verified by ${borrowers[0].ch_verified_by ? 'RM' : 'system'} on ${new Date(borrowers[0].ch_verified_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Render reconciliation table
  const roleOptions = ['director', 'ubo', 'psc', 'shareholder', 'primary', 'joint', 'guarantor'];

  container.innerHTML = `
    <div style="background:rgba(212,168,83,0.06);border:1px solid rgba(212,168,83,0.25);border-radius:10px;overflow:hidden;margin-top:4px;">
      <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:13px;font-weight:700;color:#D4A853;">Borrower Role Verification</div>
          <div style="font-size:11px;color:#94A3B8;margin-top:2px;">Cross-referenced against Companies House. Confirm each person's role before proceeding to DIP.</div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:rgba(255,255,255,0.03);">
            <th style="text-align:left;padding:8px 12px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Borrower</th>
            <th style="text-align:left;padding:8px 12px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">CH Match</th>
            <th style="text-align:center;padding:8px 12px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Status</th>
            <th style="text-align:left;padding:8px 12px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Confirmed Role</th>
            <th style="text-align:center;padding:8px 12px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${matches.map((m, idx) => {
            const matchColor = m.confidence === 'matched' ? '#34D399' : '#FBBF24';
            const matchIcon = m.confidence === 'matched' ? '&#10003;' : '&#9888;';
            const matchText = m.chMatch
              ? m.chMatch.roles.join(' + ') + (m.chMatch.control ? ` (${m.chMatch.control})` : '')
              : 'Not found in company records';

            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);" id="ch-recon-row-${idx}">
              <td style="padding:8px 12px;">
                <div style="font-size:12px;font-weight:600;color:#F1F5F9;">${sanitizeHtml(m.borrower.full_name)}</div>
                <div style="font-size:10px;color:#64748B;">Current: ${m.borrower.role || 'primary'} · ${m.borrower.borrower_type || 'individual'}</div>
              </td>
              <td style="padding:8px 12px;">
                <div style="font-size:11px;color:${matchColor};font-weight:600;">${matchText}</div>
                ${m.chMatch ? `<div style="font-size:10px;color:#64748B;">${m.chMatch.nationality || ''} ${m.chMatch.appointed ? '· Since ' + m.chMatch.appointed : ''}</div>` : ''}
              </td>
              <td style="padding:8px 12px;text-align:center;">
                <span style="font-size:14px;color:${matchColor};">${matchIcon}</span>
              </td>
              <td style="padding:8px 12px;">
                <select id="ch-role-${idx}" style="padding:5px 8px;background:#0f1729;border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:11px;font-weight:600;">
                  ${roleOptions.map(r => `<option value="${r}" ${r === m.suggestedRole ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px 12px;text-align:center;">
                ${m.alreadyVerified
                  ? '<span style="font-size:10px;color:#34D399;font-weight:600;">Verified</span>'
                  : `<span style="font-size:10px;color:#94A3B8;">Pending</span>`
                }
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:flex-end;gap:8px;">
        <button id="ch-confirm-roles-btn"
          style="padding:8px 20px;font-size:12px;font-weight:700;background:#34D399;color:#111;border:none;border-radius:6px;cursor:pointer;transition:background .15s;"
          onmouseover="this.style.background='#2DD48A'" onmouseout="this.style.background='#34D399'">
          Confirm All Roles &#10003;
        </button>
      </div>
    </div>
  `;

  // Attach click handler with match data stored in closure (avoids JSON-in-onclick issues)
  const _confirmMatchData = matches.map((m, i) => ({
    idx: i,
    borrower_id: m.borrower.id,
    full_name: m.borrower.full_name,
    ch_match: m.chMatch,
    confidence: m.confidence
  }));

  requestAnimationFrame(() => {
    const confirmBtn = document.getElementById('ch-confirm-roles-btn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        window._chConfirmRoles(submissionId, _confirmMatchData);
      });
    }
  });
}

/**
 * Name matching — normalise and compare (Companies House uses UPPERCASE, SURNAME FIRST)
 */
function nameMatch(chName, borrowerName) {
  if (!chName || !borrowerName) return false;
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(chName);
  const b = norm(borrowerName);

  // Exact match
  if (a === b) return true;

  // CH format is often "SURNAME, Firstname" — try reversing
  const aParts = a.split(/[, ]+/).filter(Boolean);
  const bParts = b.split(/\s+/).filter(Boolean);

  // Check if all parts of one appear in the other (order-agnostic)
  const aSet = new Set(aParts);
  const bSet = new Set(bParts);

  if (bParts.length >= 2 && bParts.every(p => aSet.has(p))) return true;
  if (aParts.length >= 2 && aParts.every(p => bSet.has(p))) return true;

  return false;
}

/**
 * RM confirms all borrower roles
 */
window._chConfirmRoles = async function(submissionId, matchData) {
  const btn = document.getElementById('ch-confirm-roles-btn');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  try {
    const verifications = matchData.map(m => {
      const roleEl = document.getElementById(`ch-role-${m.idx}`);
      return {
        borrower_id: m.borrower_id,
        confirmed_role: roleEl ? roleEl.value : null,
        ch_matched_role: m.ch_match ? m.ch_match.roles.join(', ') : 'no_match',
        ch_match_confidence: m.confidence,
        ch_match_data: m.ch_match || {}
      };
    });

    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers/verify-roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verifications })
    });

    const data = await resp.json();

    if (!resp.ok) {
      if (btn) { btn.textContent = 'Error — retry'; btn.disabled = false; btn.style.background = '#F87171'; }
      showToast(data.error || 'Failed to verify roles', 'error');
      return;
    }

    // Update UI to show verified state
    const reconPanel = document.getElementById('ch-reconciliation-panel');
    if (reconPanel) {
      reconPanel.innerHTML = `
        <div style="background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.3);border-radius:10px;padding:14px 16px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="color:#34D399;font-size:16px;">&#10003;</span>
            <div>
              <span style="font-size:13px;font-weight:700;color:#34D399;">All ${data.count} Borrower Roles Verified</span>
              <div style="font-size:11px;color:#94A3B8;margin-top:2px;">
                ${data.verified.map(v => `${sanitizeHtml(v.full_name)}: <strong>${v.role}</strong> (CH: ${v.ch_matched_role || 'no match'})`).join(' · ')}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Update borrower table rows to reflect new roles
    for (const v of data.verified) {
      const row = document.getElementById(`borrower-row-${v.id}`);
      if (row) {
        const roleTd = row.children[1];
        if (roleTd) {
          const _rColors = { primary:'#34D399', joint:'#34D399', guarantor:'#FBBF24', director:'#818CF8', ubo:'#A78BFA', psc:'#38BDF8', shareholder:'#D4A853' };
          const _rBgs = { primary:'rgba(52,211,153,0.1)', joint:'rgba(52,211,153,0.1)', guarantor:'rgba(251,191,36,0.1)', director:'rgba(129,140,248,0.1)', ubo:'rgba(167,139,250,0.1)', psc:'rgba(56,189,248,0.1)', shareholder:'rgba(212,168,83,0.1)' };
          const roleColor = _rColors[v.role] || '#94A3B8';
          const roleBg = _rBgs[v.role] || 'rgba(255,255,255,0.04)';
          roleTd.innerHTML = `<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${roleBg};color:${roleColor};text-transform:capitalize;">${v.role}</span>`;
        }
      }
    }

    // Recalculate completeness to reflect verified state
    if (typeof calculateCompleteness === 'function') calculateCompleteness();

    showToast(`${data.count} borrower roles verified and saved`, 'success');

    // Refresh in-place after 2s so the page renders with the verified state (collapsible summary bar)
    setTimeout(() => _refreshDealInPlace(submissionId), 2000);

  } catch (e) {
    console.error('[ch-confirm-roles] Error:', e);
    if (btn) { btn.textContent = 'Error — retry'; btn.disabled = false; btn.style.background = '#F87171'; }
    showToast('Network error — please try again', 'error');
  }
};
