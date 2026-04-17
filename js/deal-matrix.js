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

  // Brokers can only edit during 'received' stage (before submission to RM)
  // After submission (info_gathering+), broker Matrix is read-only — RM/admin can still edit
  const brokerEditableStages = ['received'];
  const canEdit = isInternalUser
    ? EDITABLE_ROLES.includes(role)
    : (EDITABLE_ROLES.includes(role) && brokerEditableStages.includes(currentStage));

  // Safe number helpers
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? num(v).toLocaleString() : '0';
  const fmtPct = (v) => num(v) ? num(v).toFixed(1) : '0.0';
  const fmtM = (v) => num(v) ? (num(v) / 1000000).toFixed(1) : '0';

  // Stage mapping — deal_stage values from DB to matrix column index
  // info_gathering is still DIP phase (RM gathering data before DIP complete)
  const stageIndex = {
    'received': 0, 'assigned': 0, 'dip_issued': 0, 'info_gathering': 0,
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
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Borrower Structure</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>

              ${(deal.borrowers && deal.borrowers.length > 0) ? `
              <!-- ── Borrower Portfolio Table (from deal_borrowers — source of truth) ── -->
              <div style="margin-bottom:12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Borrower Schedule — ${deal.borrowers.length} ${deal.borrowers.length === 1 ? 'Party' : 'Parties'}</span>
                  <div style="display:flex;gap:6px;align-items:center;">
                    ${canEdit ? `<button onclick="window.addBorrowerRow('${deal.submission_id}')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Borrower / Guarantor</button>` : ''}
                  </div>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                  <thead>
                    <tr style="background:rgba(255,255,255,0.04);">
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Type</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Company</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Email</th>
                      <th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>
                      ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
                    </tr>
                  </thead>
                  <tbody>
                    ${deal.borrowers.map(b => {
                      const roleColor = b.role === 'primary' ? '#34D399' : b.role === 'guarantor' ? '#FBBF24' : b.role === 'director' ? '#818CF8' : '#94A3B8';
                      const roleBg = b.role === 'primary' ? 'rgba(52,211,153,0.1)' : b.role === 'guarantor' ? 'rgba(251,191,36,0.1)' : b.role === 'director' ? 'rgba(129,140,248,0.1)' : 'rgba(255,255,255,0.04)';
                      const kycColor = b.kyc_status === 'verified' ? '#34D399' : b.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);" id="borrower-row-${b.id}">
                      <td style="padding:6px 8px;color:#F1F5F9;font-weight:600;">${sanitizeHtml(b.full_name || '-')}</td>
                      <td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${roleBg};color:${roleColor};text-transform:capitalize;">${b.role || 'primary'}</span></td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;text-transform:capitalize;">${sanitizeHtml(b.borrower_type || 'individual')}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;font-size:11px;">${b.company_name ? sanitizeHtml(b.company_name) + (b.company_number ? ` <span style="color:#94A3B8">(${sanitizeHtml(b.company_number)})</span>` : '') : '—'}</td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(b.email || '-')}</td>
                      <td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:${kycColor};text-transform:capitalize;">${b.kyc_status || 'pending'}</span></td>
                      ${canEdit ? `<td style="padding:6px 8px;text-align:center;white-space:nowrap;">
                        <button onclick="window.editBorrowerRow(${b.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>
                        <button onclick="window.deleteBorrowerRow(${b.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>
                      </td>` : ''}
                    </tr>`}).join('')}
                  </tbody>
                </table>
              </div>
              <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;margin-top:4px;">
                <span style="font-size:10px;color:#6B7280;">Primary borrower flat fields (kept in sync with deal record):</span>
              </div>
              ` : `
              <!-- ── No borrowers in deal_borrowers yet — show flat fields + add button ── -->
              <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
                <span style="font-size:11px;color:#94A3B8;">No borrowers added yet.</span>
                ${canEdit ? `<button onclick="window.addBorrowerRow('${deal.submission_id}')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Borrower</button>` : ''}
              </div>
              `}
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

        <!-- Guarantor(s) — now part of borrower table above, keeping row for backward compat -->
        ${renderFieldRow('guarantors', 'Guarantor(s) / UBOs', 'Directors, personal guarantors, joint & several',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-guarantors">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Guarantor & UBO Details</div>
              ${(deal.borrowers && deal.borrowers.filter(b => b.role !== 'primary').length > 0) ? `
              <p style="font-size:12px;color:#34D399;margin:0 0 8px;">&#10003; ${deal.borrowers.filter(b => b.role !== 'primary').length} non-primary party(ies) registered above.</p>
              <p style="font-size:11px;color:#94A3B8;margin:0;">To add more guarantors, directors, or UBOs use the "+ Add Borrower / Guarantor" button in the Borrower Structure section above.</p>
              ` : `
              <p style="font-size:12px;color:#FBBF24;margin:0 0 8px;">No guarantors or UBOs added yet.</p>
              <p style="font-size:11px;color:#94A3B8;margin:0;">Use the "+ Add Borrower / Guarantor" button in the Borrower Structure section above to add directors, personal guarantors, or UBOs who need to sign joint and several.</p>
              `}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: BORROWER FINANCIALS & AML
  // ═══════════════════════════════════════════════════════════════════

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
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Assets Schedule</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Upload asset statements via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Liabilities -->
        ${renderFieldRow('liabilities', 'Liabilities', 'Mortgages, loans, credit commitments',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-liabilities">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Liabilities Schedule</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Upload mortgage statements and credit reports via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Income -->
        ${renderFieldRow('income', 'Income', 'Employment, rental, investment income',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-income">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Income Schedule</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Upload payslips, tax returns, or rental statements via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Expenses -->
        ${renderFieldRow('expenses', 'Expenses', 'Housing, living costs, financial commitments',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-expenses">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:12px">Expenses Schedule</div>
              <p style="font-size:13px;color:#94A3B8;margin:0;">Upload bank statements via Document Repository. Parsed data will auto-populate here.</p>
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
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Type</th>
                      <th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Tenure</th>
                      ${canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : ''}
                    </tr>
                  </thead>
                  <tbody>
                    ${deal.properties.map((p, i) => `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);" id="prop-row-${p.id}">
                      <td style="padding:6px 8px;color:#F1F5F9;font-weight:600;">${i + 1}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;">${sanitizeHtml(p.address || '-')}</td>
                      <td style="padding:6px 8px;color:#D4A853;font-weight:600;">${sanitizeHtml(p.postcode || '-')}</td>
                      <td style="padding:6px 8px;color:#F1F5F9;text-align:right;font-weight:600;">${p.market_value ? '£' + Number(p.market_value).toLocaleString() : '—'}</td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(p.property_type || deal.asset_type || '-')}</td>
                      <td style="padding:6px 8px;color:#94A3B8;font-size:11px;">${sanitizeHtml(p.tenure || deal.property_tenure || '-')}</td>
                      ${canEdit ? `<td style="padding:6px 8px;text-align:center;white-space:nowrap;">
                        <button onclick="window.editPropertyRow(${p.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>
                        <button onclick="window.deletePropertyRow(${p.id}, '${deal.submission_id}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>
                      </td>` : ''}
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>
              <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;margin-top:4px;">
                <span style="font-size:10px;color:#6B7280;">Shared property details (applies to all properties):</span>
              </div>
              ` : `
              <!-- ── Raw address fields (no deal_properties rows yet) ── -->
              <div style="margin-bottom:8px;padding:8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;">
                <span style="font-size:10px;color:#FBBF24;font-weight:600;">⚠ Awaiting AI property parsing — showing raw data</span>
                <button onclick="window.reparseProperties && window.reparseProperties('${deal.submission_id}')" style="margin-left:8px;padding:3px 10px;background:#FBBF24;color:#111827;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Ask Claude to Parse</button>
              </div>
              `}
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${(deal.properties && deal.properties.length > 0) ? '' : `
                ${renderEditableField('security_address', 'Security Address', deal.security_address, 'text', canEdit)}
                ${renderEditableField('security_postcode', 'Postcode', deal.security_postcode, 'text', canEdit)}
                `}
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
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('current_value', 'Current Value (£)', deal.current_value, 'money', canEdit)}
                ${renderEditableField('purchase_price', 'Purchase Price (£)', deal.purchase_price, 'money', canEdit)}
              </div>
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
                ${renderEditableField('ltv_requested', 'LTV Requested (%)', deal.ltv_requested, 'text', canEdit)}
                ${renderEditableField('term_months', 'Term (months)', deal.term_months, 'text', canEdit)}
                ${renderEditableField('rate_requested', 'Rate (%/month)', deal.rate_requested, 'text', isInternalUser && canEdit)}
                ${renderEditableField('interest_servicing', 'Interest Servicing', deal.interest_servicing, 'select', canEdit, [
                  { value: 'retained', label: 'Retained (deducted upfront)' },
                  { value: 'serviced', label: 'Serviced (monthly payments)' },
                  { value: 'rolled', label: 'Rolled Up' }
                ])}
                ${renderEditableField('drawdown_date', 'Target Drawdown', deal.drawdown_date, 'date', canEdit)}
              </div>
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

  const isDIPStage = currentStageIdx === 0;
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

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 7: COMMERCIAL
  // ═══════════════════════════════════════════════════════════════════

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
        ${renderFieldRow('fees', 'Fees', `Arrangement: ${fmtPct(deal.arrangement_fee_pct || 2)}%, Broker: ${fmtPct(deal.broker_fee_pct || 0)}%`,
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-fees">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Fee Structure</div>
                ${['rm','admin'].includes(role) ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">RM/ADMIN EDIT</span>' : '<span style="font-size:8px;color:#64748B;font-weight:600;background:#1a2332;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('arrangement_fee_pct', 'Arrangement Fee (%)', deal.arrangement_fee_pct || '2.0', 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('broker_fee_pct', 'Broker Fee (%)', deal.broker_fee_pct || '0', 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('commitment_fee', 'Commitment Fee (£)', deal.commitment_fee || '5000', 'money', ['rm','admin'].includes(role))}
                ${renderEditableField('retained_interest_months', 'Retained Interest (months)', deal.retained_interest_months || '6', 'text', ['rm','admin'].includes(role))}
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

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 8: DOCUMENTS ISSUED
  // ═══════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════
  // ATTACH GLOBAL FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  window.matrixToggleSection = function(sectionId) {
    const content = document.getElementById(`content-${sectionId}`);
    const chevron = document.getElementById(`chevron-${sectionId}`);
    if (content) {
      const isOpen = content.style.maxHeight !== '0px';
      content.style.maxHeight = isOpen ? '0px' : '8000px';
      content.style.overflow = 'hidden';
      if (chevron) {
        chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
        chevron.style.background = isOpen ? 'rgba(255,255,255,0.06)' : 'rgba(212,168,83,0.25)';
        chevron.style.color = isOpen ? '#94A3B8' : '#D4A853';
      }
    }
  };

  window.matrixToggleDetail = function(detailId) {
    const detail = document.getElementById(detailId);
    if (detail) {
      const isOpen = detail.style.maxHeight !== '0px';
      detail.style.maxHeight = isOpen ? '0px' : '1200px';
      detail.style.overflow = 'hidden';
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
    for (const [name, sec] of Object.entries(readiness.sections)) {
      if (sec.status !== 'ready') {
        const sId = sectionMap[name];
        if (sId && !opened.has(sId)) {
          opened.add(sId);
          window.matrixToggleSection(sId);
          if (!firstIncomplete) firstIncomplete = sId;
        }
      }
    }
    // Scroll to first incomplete section
    if (firstIncomplete) {
      const header = document.querySelector(`[data-section-header="${firstIncomplete}"]`);
      if (header) header.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // ── Scroll to a DIP section from the readiness checklist ──
  window.matrixScrollToSection = function(sectionId) {
    const header = document.querySelector(`[data-section-header="${sectionId}"]`);
    const content = document.getElementById(`content-${sectionId}`);
    if (header) {
      // Open section if closed
      if (content && content.style.maxHeight === '0px') {
        window.matrixToggleSection(sectionId);
      }
      // Smooth scroll to section header
      header.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight flash
      header.style.background = 'rgba(212,168,83,0.15)';
      setTimeout(() => { header.style.background = ''; }, 1500);
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

    // Term months — sanity check
    if (fieldKey === 'term_months') {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1 || num > 60) {
        if (el) el.style.borderColor = '#F87171';
        if (errEl) { errEl.textContent = 'Term must be 1–60 months'; errEl.style.display = 'block'; }
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
        // Recalculate completeness after every save
        calculateCompleteness();
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
                floatingProgress.complete({ label: 'Extraction Complete', message: 'AI extracted all deal data. Reloading...' });
                setTimeout(() => window.location.reload(), 2500);
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
          setTimeout(() => window.location.reload(), 800);
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
          // Reload after short delay to refresh totals and completeness
          setTimeout(() => window.location.reload(), 1200);
        } else {
          showToast(data.error || 'Failed to delete property', 'error');
        }
      })
      .catch(err => showToast('Failed to delete: ' + err.message, 'error'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // BORROWER CRUD — Add / Edit / Delete in deal_borrowers
  // ═══════════════════════════════════════════════════════════════════

  function _showBorrowerModal(submissionId, existing) {
    const isEdit = !!existing;
    const title = isEdit ? 'Edit Borrower / Guarantor' : 'Add Borrower / Guarantor';
    const v = existing || {};

    const old = document.getElementById('dkf-borrower-modal');
    if (old) old.remove();

    const roleOpts = ['primary', 'joint', 'guarantor', 'director'].map(r =>
      `<option value="${r}" ${v.role === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`
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
            <button id="bm-save-btn" style="padding:8px 20px;background:#D4A853;border:none;border-radius:6px;color:#0B1120;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'Save Changes' : 'Add Borrower'}</button>
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
          setTimeout(() => window.location.reload(), 800);
        } else {
          showToast(data.error || 'Failed to save borrower', 'error');
          btn.disabled = false;
          btn.textContent = isEdit ? 'Save Changes' : 'Add Borrower';
        }
      } catch (err) {
        console.error('[borrower-save]', err);
        showToast('Failed to save: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save Changes' : 'Add Borrower';
      }
    });
  }

  window.addBorrowerRow = function(submissionId) {
    _showBorrowerModal(submissionId, null);
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
          setTimeout(() => window.location.reload(), 1200);
        } else {
          showToast(data.error || 'Failed to remove borrower', 'error');
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
      'Borrower Financials': {
        required: ['estimated_net_worth'],
        nice: ['source_of_wealth']
      },
      'Property / Security': {
        required: ['security_address', 'security_postcode', 'asset_type', 'property_tenure', 'current_value', 'occupancy_status', 'current_use'],
        nice: []
      },
      'Loan Terms': {
        required: ['loan_amount', 'ltv_requested', 'term_months', 'interest_servicing', 'loan_purpose', 'use_of_funds', 'drawdown_date'],
        nice: []
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
              section.missing.push(cond.atLeastOne.join(' or '));
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
        const clickHandler = clickable ? `onclick="window.matrixScrollToSection('${scrollTarget}')"` : '';
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
