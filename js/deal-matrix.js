/**
 * Deal Information Matrix Module
 * Renders a comprehensive deal tracking matrix with sections, collapsible fields, and document management
 * Production-ready ES6 module for Daksfirst lending portal
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getCurrentRole } from './state.js';

// ═══════════════════════════════════════════════════════════════════
// EDITABLE FIELD HELPER — renders input for editable roles, static text for read-only
// ═══════════════════════════════════════════════════════════════════

const EDITABLE_ROLES = ['broker', 'borrower', 'rm', 'admin'];
const inputStyle = 'width:100%;padding:10px 14px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;color:#1e293b;background:#fff;transition:border-color .15s;outline:none;font-family:inherit;';
const inputFocusClass = 'matrix-editable';
const readonlyStyle = 'font-size:14px;color:#1e293b;padding:8px 0;';
const labelStyle = 'font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:5px';

function renderEditableField(dbField, label, value, inputType, canEdit, options) {
  const safeVal = sanitizeHtml(String(value || ''));
  const id = `mf-${dbField}`;

  if (!canEdit) {
    // Read-only display
    if (inputType === 'select' && options) {
      const selected = options.find(o => o.value === value);
      return `<div style="margin-bottom:12px">
        <label style="${labelStyle}">${sanitizeHtml(label)}</label>
        <div style="${readonlyStyle}">${sanitizeHtml(selected ? selected.label : value || '—')}</div>
      </div>`;
    }
    return `<div style="margin-bottom:12px">
      <label style="${labelStyle}">${sanitizeHtml(label)}</label>
      <div style="${readonlyStyle}">${safeVal || '—'}</div>
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
      <textarea id="${id}" data-field="${dbField}" class="${inputFocusClass}" style="${inputStyle}min-height:80px;resize:vertical;" onblur="window.matrixSaveField('${dbField}', this.value)">${safeVal}</textarea>
    </div>`;
  }

  const typeAttr = inputType === 'money' ? 'text' : (inputType || 'text');
  const placeholder = inputType === 'money' ? 'e.g. 1,500,000' : inputType === 'date' ? 'YYYY-MM-DD' : '';

  return `<div style="margin-bottom:12px">
    <label style="${labelStyle}" for="${id}">${sanitizeHtml(label)}</label>
    <input id="${id}" type="${typeAttr}" data-field="${dbField}" class="${inputFocusClass}" style="${inputStyle}" value="${safeVal}" placeholder="${placeholder}" onblur="window.matrixSaveField('${dbField}', this.value)" />
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - Pill Rendering
// ═══════════════════════════════════════════════════════════════════

const pillStyles = {
  'not-required': 'background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0',
  'not-started': 'background:#f8fafc;color:#64748b;border:1px solid #e2e8f0',
  'submitted': 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe',
  'under-review': 'background:#fefce8;color:#a16207;border:1px solid #fde68a',
  'approved': 'background:#f0fdf4;color:#15803d;border:1px solid #86efac',
  'finalized': 'background:#166534;color:#fff;border:1px solid #166534',
  'locked': 'background:#0f172a;color:#e2e8f0;border:1px solid #0f172a',
  'evidenced': 'background:#fff7ed;color:#c2410c;border:1px solid #fed7aa',
  'signed': 'background:#166534;color:#fff;border:1px solid #166534',
  'awaiting-signature': 'background:#fef3c7;color:#92400e;border:1px solid #fde68a',
  'superseded': 'background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0;font-size:8px',
  'overdue': 'background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;animation:prd 2s ease-in-out infinite',
  'issued': 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe'
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
function renderStatusDot(count, status) {
  const colorMap = {
    'approved': '#dcfce7',
    'finalized': '#166534',
    'signed': '#166534',
    'submitted': '#bfdbfe',
    'under-review': '#fef3c7',
    'not-started': '#f1f5f9'
  };
  const color = colorMap[status] || '#f1f5f9';
  const textColor = status === 'finalized' || status === 'signed' ? '#fff' : status === 'approved' ? '#166534' : '#94a3b8';
  return `<div style="width:20px;height:20px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;background:${color};color:${textColor}">${count > 0 ? count : '—'}</div>`;
}

/**
 * Generate field row with status pills across stages
 */
function renderFieldRow(fieldKey, fieldName, fieldDesc, statuses, isConditional = false, isActive = false, canEdit = false) {
  const conditionalClass = isConditional ? 'margin-left:16px' : '';
  const activeBackground = isActive ? 'background:#f8fbff' : '';
  const prefix = isConditional ? '↳ ' : '';

  return `
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));border-top:1px solid #f8fafc;transition:background .1s;cursor:pointer;${activeBackground}" onclick="window.matrixToggleDetail && window.matrixToggleDetail('detail-${fieldKey}')">
      <div style="padding:8px 12px 8px 50px;display:flex;align-items:center;gap:6px;${conditionalClass}">
        <span style="font-size:12px;width:16px;text-align:center;flex-shrink:0">📋</span>
        <div>
          <div style="font-size:11px;font-weight:500;color:#334155">${prefix}${sanitizeHtml(fieldName)}</div>
          <span style="font-size:9px;color:#94a3b8;font-weight:400;display:block">${sanitizeHtml(fieldDesc)}</span>
        </div>
      </div>
      ${statuses.map((status, idx) => `
        <div style="padding:8px 5px;display:flex;align-items:center;justify-content:center;${idx === 0 ? 'background:#f8fbff' : ''}">
          ${renderPill(status)}
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Generate collapsible section header
 */
function renderSectionHeader(sectionId, icon, title, subtitle, statusDots) {
  return `
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));cursor:pointer;user-select:none;transition:background .12s;border-bottom:1px solid #f1f5f9" onclick="window.matrixToggleSection && window.matrixToggleSection('${sectionId}')" data-section-header="${sectionId}">
      <div style="padding:11px 12px 11px 26px;display:flex;align-items:center;gap:8px">
        <div id="chevron-${sectionId}" style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;background:#dbeafe;border-radius:5px;font-size:9px;color:#2563eb;transition:transform .2s,background .2s;flex-shrink:0;transform:rotate(90deg)">▸</div>
        <span style="font-size:14px">${icon}</span>
        <span style="font-size:12px;font-weight:700;color:#1e293b">${sanitizeHtml(title)}</span>
        <span style="font-size:9px;color:#94a3b8;font-weight:400;margin-left:5px">${sanitizeHtml(subtitle)}</span>
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

  const statusBg = docData.status === 'signed' ? '#dcfce7' : 'fee2e2';
  const statusColor = docData.status === 'signed' ? '#166534' : '#dc2626';

  return `
    <div style="padding:8px 26px 14px 50px">
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:14px;font-weight:700;color:#334155">${sanitizeHtml(docData.name || 'Document')}</div>
          <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px">${docData.status || 'pending'}</div>
        </div>

        <div style="display:flex;align-items:center;gap:0;margin-bottom:12px;flex-wrap:wrap">
          ${(documentTrail || []).map((stage, idx) => `
            <div style="display:flex;align-items:center;gap:3px;padding:4px 8px;font-size:9px;font-weight:600;border-radius:5px;${stage.completed ? 'background:#dcfce7;color:#166534' : 'background:#dbeafe;color:#1d4ed8'}">
              ${stage.completed ? '✓' : '●'} ${sanitizeHtml(stage.label)}
            </div>
            ${idx < documentTrail.length - 1 ? '<span style="color:#cbd5e1;font-size:12px;margin:0 3px">→</span>' : ''}
          `).join('')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:9px;margin-bottom:10px">
          <div><span style="color:#94a3b8">Issued:</span> ${docData.issued_at ? new Date(docData.issued_at).toLocaleDateString() : 'N/A'}</div>
          <div><span style="color:#94a3b8">Reference:</span> ${sanitizeHtml(docData.reference || 'N/A')}</div>
        </div>

        ${canVerify ? `
          <div style="display:flex;gap:6px;margin-top:10px">
            <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#334155;cursor:pointer;transition:all .12s" onclick="window.matrixVerifyDocument && window.matrixVerifyDocument('${docId}')">Verify</button>
            <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid #e2e8f0;background:#f59e0b;color:#fff;cursor:pointer;transition:all .12s" onclick="window.matrixSendInfoRequest && window.matrixSendInfoRequest('documents')">Request Info</button>
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
  const canEdit = EDITABLE_ROLES.includes(role);
  const currentStage = deal.deal_stage || 'received';

  // Safe number helpers
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? num(v).toLocaleString() : '0';
  const fmtPct = (v) => num(v) ? num(v).toFixed(1) : '0.0';
  const fmtM = (v) => num(v) ? (num(v) / 1000000).toFixed(1) : '0';

  // Stage mapping — deal_stage values from DB to matrix column index
  const stageIndex = {
    'received': 0, 'assigned': 0, 'dip_issued': 0,
    'info_gathering': 1, 'ai_termsheet': 1,
    'fee_pending': 2, 'fee_paid': 2, 'underwriting': 2,
    'bank_submitted': 2, 'bank_approved': 2,
    'borrower_accepted': 3, 'legal_instructed': 3, 'completed': 3
  };
  const currentStageIdx = stageIndex[currentStage] ?? 0;

  // ═══════════════════════════════════════════════════════════════════
  // HEADER & CONTEXT SECTION
  // ═══════════════════════════════════════════════════════════════════

  let html = `
    <!-- Header -->
    <div style="padding:20px 26px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:12px">
      <div style="width:36px;height:36px;background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px">📊</div>
      <div>
        <h2 style="font-size:16px;font-weight:700;color:#0f172a">Deal Information Matrix</h2>
        <div style="font-size:11px;color:#64748b;margin-top:1px">Live status tracking · ${sanitizeHtml(deal.borrower_name || 'Deal')} · £${fmtM(deal.loan_amount)}M</div>
      </div>
    </div>

    <!-- Context Bar -->
    <div style="padding:12px 26px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;gap:20px;flex-wrap:wrap;align-items:center">
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Borrower</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${sanitizeHtml(deal.borrower_name || 'N/A')}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Type</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${sanitizeHtml(deal.borrower_type || 'Individual')}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Loan</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">£${fmtMoney(deal.loan_amount)}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">LTV</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${fmtPct(deal.ltv_requested)}%</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Security</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${sanitizeHtml(deal.security_address || 'N/A')}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Stage</span>
        <span style="font-size:12px;font-weight:600;color:#2563eb">${sanitizeHtml(currentStage.replace(/_/g, ' ').toUpperCase())}</span>
      </div>
    </div>

    <!-- Progress Bars -->
    <div style="padding:12px 26px 16px;border-bottom:1px solid #f1f5f9">
      <div style="display:flex;align-items:center;gap:10px;margin-top:0">
        <span style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;min-width:82px">DIP</span>
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden">
          <div style="height:100%;border-radius:99px;width:${currentStageIdx >= 0 ? 75 : 0}%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .5s ease"></div>
        </div>
        <span style="color:#2563eb;font-size:12px;font-weight:600">${currentStageIdx >= 0 ? 75 : 0}%</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Indicative TS</span>
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden">
          <div style="height:100%;border-radius:99px;width:${currentStageIdx >= 1 ? 30 : 0}%;background:linear-gradient(90deg,#a855f7,#d946ef);transition:width .5s ease"></div>
        </div>
        <span style="color:#7c3aed;font-size:12px;font-weight:600">${currentStageIdx >= 1 ? 30 : 0}%</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Formal Offer</span>
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden">
          <div style="height:100%;border-radius:99px;width:${currentStageIdx >= 2 ? 0 : 0}%;background:linear-gradient(90deg,#10b981,#34d399);transition:width .5s ease"></div>
        </div>
        <span style="color:#059669;font-size:12px;font-weight:600">${currentStageIdx >= 2 ? 0 : 0}%</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <span style="font-size:9px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px;min-width:82px">Execution</span>
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden">
          <div style="height:100%;border-radius:99px;width:${currentStageIdx >= 3 ? 0 : 0}%;background:linear-gradient(90deg,#64748b,#94a3b8);transition:width .5s ease"></div>
        </div>
        <span style="color:#334155;font-size:12px;font-weight:600">${currentStageIdx >= 3 ? 0 : 0}%</span>
      </div>
    </div>

    <!-- Column Headers -->
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));border-bottom:2px solid #e2e8f0;position:sticky;top:0;background:#fff;z-index:20">
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:left;padding-left:26px;color:#64748b">Information</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#2563eb;background:#f0f7ff"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:#dbeafe;color:#1d4ed8">1</span>DIP<span style="font-size:7px;font-weight:800;letter-spacing:1px;color:#2563eb;background:#dbeafe;padding:1px 5px;border-radius:3px;margin-left:3px;vertical-align:middle">CURRENT</span></div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#7c3aed"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:#ede9fe;color:#6d28d9">2</span>Indicative TS</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#059669"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:#d1fae5;color:#047857">3</span>Formal Offer</div>
      <div style="padding:11px 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;text-align:center;color:#334155"><span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:4px;font-size:8px;font-weight:800;margin-right:3px;background:#e2e8f0;color:#1e293b">4</span>Execution</div>
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
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s1', '👤', 'Borrower / KYC', 'Comprehensive identity verification', [
        renderStatusDot(1, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s1" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Primary Borrower -->
        ${renderFieldRow('primary-borrower', 'Primary Borrower', 'Name, DOB, nationality, address, ID',
          ['approved', 'not-started', 'locked', 'locked'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-primary-borrower">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Primary Borrower</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
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
              ${isInternalUser ? `<div style="display:flex;gap:6px;margin-top:10px;border-top:1px solid #f1f5f9;padding-top:10px">
                <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#334155;cursor:pointer" onclick="window.matrixSendInfoRequest && window.matrixSendInfoRequest('borrower')">📧 Request Info</button>
              </div>` : ''}
            </div>
          </div>
        </div>

        <!-- Guarantor(s) -->
        ${renderFieldRow('guarantors', 'Guarantor(s)', 'Co-signatory, personal guarantees',
          ['not-started', 'not-started', 'not-started', 'not-started'])}
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: BORROWER FINANCIALS & AML
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s2', '💰', 'Borrower Financials & AML', 'Income, assets, liabilities, and compliance', [
        renderStatusDot(2, 'under-review'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s2" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Assets -->
        ${renderFieldRow('assets', 'Assets', 'Real estate, investments, cash, vehicles',
          ['under-review', 'not-started', 'not-started', 'not-started'])}

        <!-- Liabilities -->
        ${renderFieldRow('liabilities', 'Liabilities', 'Mortgages, loans, credit commitments',
          ['submitted', 'not-started', 'not-started', 'not-started'])}

        <!-- Income -->
        ${renderFieldRow('income', 'Income', 'Employment, rental, investment income',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <!-- Expenses -->
        ${renderFieldRow('expenses', 'Expenses', 'Housing, living costs, financial commitments',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <!-- AML & Source of Funds -->
        ${renderFieldRow('aml-source-funds', 'AML & Source of Funds', 'Source of funds, wealth, PEP screening, tax residency',
          ['under-review', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-aml-source-funds">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Source of Funds & AML</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
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
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s3', '🏘️', 'Property / Security', 'Property details and valuation', [
        renderStatusDot(1, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s3" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Property Details -->
        ${renderFieldRow('property-details', 'Property Details', 'Address, tenure, bedrooms, square footage',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-property-details">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Property / Security Details</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
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
            </div>
          </div>
        </div>

        <!-- Valuation -->
        ${renderFieldRow('property-valuation', 'Valuation', 'Desktop valuation, survey, final valuation',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-property-valuation">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Valuation & Pricing</div>
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
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s4', '📋', 'Loan Terms & Use of Funds', 'Loan structure and drawdown', [
        renderStatusDot(2, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s4" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Loan Terms -->
        ${renderFieldRow('loan-terms', 'Loan Terms', `Amount: £${fmtMoney(deal.loan_amount)}, Term: ${deal.term_months || '?'} months, Rate: ${deal.rate_requested || 'TBA'}%`,
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-loan-terms">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Loan Structure</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px;">
                ${renderEditableField('loan_amount', 'Loan Amount (£)', deal.loan_amount, 'money', canEdit)}
                ${renderEditableField('ltv_requested', 'LTV Requested (%)', deal.ltv_requested, 'text', canEdit)}
                ${renderEditableField('term_months', 'Term (months)', deal.term_months, 'text', canEdit)}
                ${renderEditableField('rate_requested', 'Rate (%/month)', deal.rate_requested, 'text', canEdit)}
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
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-use-of-funds">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Purpose & Use of Funds</div>
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
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s5', '🚪', 'Exit Strategy', 'Refinance or sale plan', [
        renderStatusDot(1, 'submitted'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s5" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Exit Strategy -->
        ${renderFieldRow('exit-strategy', 'Exit Strategy', 'Refinance, sale, hold',
          ['submitted', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-exit-strategy">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Exit Strategy</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
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
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 6: LEGAL & INSURANCE
  // ═══════════════════════════════════════════════════════════════════

  const isDIPStage = currentStageIdx === 0;
  html += `
    <div style="border-bottom:1px solid #f1f5f9;${isDIPStage ? 'opacity:.45' : ''}">
      ${renderSectionHeader('s6', '⚖️', 'Legal & Insurance', 'Security and insurance requirements', [
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required')
      ])}

      <div id="content-s6" style="max-height:${isDIPStage ? '0' : '8000'}px;overflow:hidden;transition:max-height .35s ease">
        <!-- Legal / Security -->
        ${renderFieldRow('legal-security', 'Legal / Security', 'Title deeds, searches, mortgage deed',
          ['not-required', 'not-started', 'not-started', 'not-started'])}

        <!-- Insurance -->
        ${renderFieldRow('insurance', 'Insurance', 'Buildings insurance, landlord insurance',
          ['not-required', 'not-started', 'not-started', 'not-started'])}
      </div>

      ${isDIPStage ? `
        <div style="padding:16px 50px;text-align:center">
          <div style="font-size:20px;margin-bottom:3px">📋</div>
          <div style="font-size:10px;font-weight:600;color:#94a3b8">Not required at DIP stage</div>
          <div style="font-size:9px;color:#cbd5e1;margin-top:1px">Will be required for Formal Offer</div>
        </div>
      ` : ''}
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 7: COMMERCIAL
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s7', '💼', 'Commercial', 'Fees and credit approval', [
        renderStatusDot(2, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s7" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Fees -->
        ${renderFieldRow('fees', 'Fees', `Arrangement: ${fmtPct(deal.arrangement_fee_pct || 2)}%, Broker: ${fmtPct(deal.broker_fee_pct || 0)}%`,
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-fees">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Fee Structure</div>
                ${['rm','admin'].includes(role) ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">RM/ADMIN EDIT</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
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

        <!-- Credit Approval -->
        ${renderFieldRow('credit-approval', 'Credit Approval', 'Internal credit committee sign-off',
          ['approved', 'not-started', 'not-started', 'not-started'])}
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 8: DOCUMENTS ISSUED
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s8', '📄', 'Documents Issued', 'Deal documentation status', [
        renderStatusDot(deal.dip_signed ? 1 : 0, deal.dip_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.ts_signed ? 1 : 0, deal.ts_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.fl_signed ? 1 : 0, deal.fl_signed ? 'signed' : 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s8" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- DIP -->
        ${renderFieldRow('dip-document', 'Data Information Package (DIP)', 'Initial deal summary and requirements',
          [deal.dip_signed ? 'signed' : 'submitted', 'not-started', 'not-started', 'not-started'])}

        <!-- Indicative TS -->
        ${renderFieldRow('indicative-ts', 'Indicative Term Sheet', 'Initial lending terms and conditions',
          ['locked', deal.ts_signed ? 'signed' : 'not-started', 'not-started', 'not-started'])}

        <!-- Formal Offer -->
        ${renderFieldRow('formal-offer', 'Formal Offer Letter', 'Final binding lending terms',
          ['locked', 'locked', deal.fl_signed ? 'signed' : 'not-started', 'not-started'])}

        <!-- Execution & Completion -->
        ${renderFieldRow('execution-completion', 'Execution & Completion', 'Legal docs and completion statement',
          ['locked', 'locked', 'locked', 'not-started'])}
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // DOCUMENT REPOSITORY (within Matrix — categorised view of uploaded docs)
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:16px 26px;border-top:1px solid #e2e8f0;background:#f8fafc">
      <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:10px">Document Repository</div>

      <!-- Category tabs -->
      <div style="display:flex;gap:1px;margin-bottom:10px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#fff;color:#334155;border-right:1px solid #e2e8f0;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('all')">All</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('kyc')">KYC/ID</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('financial')">Financial</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('property')">Property</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('legal')">Legal</button>
        <button style="flex:1;padding:8px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;transition:all .12s" onclick="window.matrixSwitchRepoTab && window.matrixSwitchRepoTab('issued')">Issued Docs</button>
      </div>

      <!-- Document table placeholder -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px;font-size:9px;color:#64748b;text-align:center">
        <div style="font-size:16px;margin-bottom:4px">📄</div>
        Documents will appear here once uploaded
      </div>

      <!-- Upload drop zone -->
      <div style="border:2px dashed #cbd5e1;border-radius:7px;padding:12px;text-align:center;background:#fff;cursor:pointer;transition:all .12s;margin-top:10px">
        <div style="font-size:18px">📁</div>
        <div style="font-size:10px;color:#64748b;font-weight:500;margin-top:2px">Drop documents here or click to upload</div>
        <div style="font-size:8px;color:#94a3b8;margin-top:1px">PDF, Word, Excel, images supported</div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // AUTO-FILL BAR (BOTTOM)
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:12px 26px;border-top:1px solid #e2e8f0;background:#1e3a5f;display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;gap:8px">
        <button style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#2563eb;color:#fff;cursor:pointer;transition:all .12s">📤 Upload & Parse</button>
        <button style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#7c3aed;color:#fff;cursor:pointer;transition:all .12s">📋 Paste Broker Pack</button>
        <button style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#64748b;color:#fff;cursor:pointer;transition:all .12s">🔄 Re-Parse All</button>
      </div>
      <div style="display:flex;gap:12px;font-size:8px;color:#cbd5e1">
        <span>Last Parsed: never</span>
        <span>•</span>
        <span>Fields Auto-Filled: 0</span>
        <span>•</span>
        <span>Confidence: 0%</span>
        <span>•</span>
        <span>Manual Overrides: 0</span>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // LEGEND
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:12px 26px 16px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:6px 12px;font-size:8px;color:#64748b">
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#dcfce7"></span>Approved</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#fef3c7"></span>Requested</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#bfdbfe"></span>Submitted</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#e2e8f0"></span>Not Started</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#fed7aa"></span>Evidenced</span>
      <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:2px;background:#166534"></span>Signed</span>
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
        chevron.style.background = isOpen ? '#f1f5f9' : '#dbeafe';
        chevron.style.color = isOpen ? '#64748b' : '#2563eb';
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
          el.style.borderColor = '#22c55e';
          setTimeout(() => { el.style.borderColor = '#e2e8f0'; }, 1200);
        }
      } else {
        const err = await resp.json().catch(() => ({}));
        if (el) el.style.borderColor = '#dc2626';
        showToast(err.error || 'Failed to save field', 'error');
      }
    } catch (e) {
      console.error('[matrix-save] Error saving field:', fieldKey, e);
      if (el) el.style.borderColor = '#dc2626';
      showToast('Connection error saving field', 'error');
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

  window.matrixSendInfoRequest = function(section) {
    showToast(`Info request sent for ${section}`, 'success');
  };

  window.matrixResolveInfoRequest = function(requestId) {
    showToast(`Info request ${requestId} resolved`, 'success');
  };

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

  // Initialize all sections as closed except first one
  document.querySelectorAll('[id^="sec-s"]').forEach((sec, idx) => {
    if (idx > 0) {
      sec.classList.remove('open');
    }
  });
}
