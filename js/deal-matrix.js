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

    <!-- SUBMIT FOR REVIEW — prominent CTA for brokers -->
    ${!isInternalUser && currentStage === 'received' ? `
    <div id="matrix-submit-cta" style="padding:14px 26px;background:linear-gradient(135deg,#f0fdf4,#ecfdf5);border-bottom:2px solid #86efac;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:14px;font-weight:700;color:#166534;">Ready to submit?</div>
          <div style="font-size:11px;color:#15803d;margin-top:2px;margin-bottom:10px;">Complete the required fields below, then submit for RM review to proceed to DIP.</div>
          <div id="dip-readiness-checklist" style="display:flex;flex-direction:column;gap:3px;"></div>
        </div>
        <button onclick="window.matrixSubmitForReview && window.matrixSubmitForReview()" style="padding:10px 28px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;background:#94a3b8;color:#fff;box-shadow:0 2px 8px rgba(34,197,94,.3);transition:all .15s;white-space:nowrap;opacity:0.5;" disabled onmouseover="if(!this.disabled)this.style.background='#16a34a'" onmouseout="if(!this.disabled)this.style.background='#22c55e'">
          Submit for RM Review &#8594;
        </button>
      </div>
    </div>
    ` : ''}
    ${!isInternalUser && currentStage !== 'received' ? `
    <div style="padding:10px 26px;background:#eff6ff;border-bottom:2px solid #bfdbfe;text-align:center;">
      <span style="font-size:12px;font-weight:600;color:#1d4ed8;">&#128274; Deal submitted for review — Matrix is read-only</span>
    </div>
    ` : ''}

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

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-guarantors">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Guarantor Details</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Guarantor information will be captured here. Upload guarantor ID and proof of address via the Document Repository.</p>
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
    <div style="border-bottom:1px solid #f1f5f9">
      ${renderSectionHeader('s2', '💰', 'Borrower Financials & AML', 'Income, assets, liabilities, and compliance', [
        renderStatusDot(2, 'under-review'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div id="content-s2" style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Financial Summary (editable at DIP) -->
        ${renderFieldRow('financial-summary', 'Financial Summary', 'Estimated net worth and source of wealth',
          ['under-review', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-financial-summary">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#334155">Financial Summary</div>
                ${canEdit ? '<span style="font-size:8px;color:#2563eb;font-weight:600;background:#eff6ff;padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#64748b;font-weight:600;background:#f1f5f9;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <p style="font-size:11px;color:#64748b;margin:0 0 10px;">Provide an estimate of the borrower's net worth. This is not verified at DIP stage — just an indication for the RM.</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('estimated_net_worth', 'Estimated Net Worth (£)', deal.estimated_net_worth, 'number', canEdit)}
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
          ['under-review', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-assets">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Assets Schedule</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Upload asset statements via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Liabilities -->
        ${renderFieldRow('liabilities', 'Liabilities', 'Mortgages, loans, credit commitments',
          ['submitted', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-liabilities">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Liabilities Schedule</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Upload mortgage statements and credit reports via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Income -->
        ${renderFieldRow('income', 'Income', 'Employment, rental, investment income',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-income">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Income Schedule</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Upload payslips, tax returns, or rental statements via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

        <!-- Expenses -->
        ${renderFieldRow('expenses', 'Expenses', 'Housing, living costs, financial commitments',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-expenses">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Expenses Schedule</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Upload bank statements via Document Repository. Parsed data will auto-populate here.</p>
            </div>
          </div>
        </div>

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

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-refinance-evidence">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Refinance Evidence</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Upload lender DIP, mortgage offer, or broker confirmation via Document Repository.</p>
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

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-legal-security">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Legal & Security</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Title deeds, Land Registry searches, mortgage deed, and legal opinion. Upload via Document Repository — required at Formal Offer stage.</p>
            </div>
          </div>
        </div>

        <!-- Insurance -->
        ${renderFieldRow('insurance', 'Insurance', 'Buildings insurance, landlord insurance',
          ['not-required', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-insurance">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Insurance</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Buildings insurance and landlord insurance evidence. Upload via Document Repository — required at Formal Offer stage.</p>
            </div>
          </div>
        </div>
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

        <!-- Credit Approval — NOT at DIP stage, belongs in Formal Offer -->
        ${renderFieldRow('credit-approval', 'Credit Approval', 'Internal credit committee sign-off',
          ['not-required', 'not-started', isDIPStage ? 'not-started' : 'under-review', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-credit-approval">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:12px">Credit Approval</div>
              <p style="font-size:13px;color:#94a3b8;margin:0;">${isDIPStage ? 'Not required at DIP stage. Credit committee sign-off happens after AI analysis and RM review at the Formal Offer stage.' : 'Internal credit committee sign-off. This is populated automatically after the AI analysis and RM/Credit review.'}</p>
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

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-dip-document">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:8px">Data Information Package (DIP)</div>
              <div style="font-size:13px;color:#64748b;">${deal.dip_signed ? 'Signed and issued.' : deal.dip_issued_at ? 'Issued — awaiting signature.' : 'Will be generated once all required fields are populated.'}</div>
            </div>
          </div>
        </div>

        <!-- Indicative TS -->
        ${renderFieldRow('indicative-ts', 'Indicative Term Sheet', 'Initial lending terms and conditions',
          ['locked', deal.ts_signed ? 'signed' : 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-indicative-ts">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:8px">Indicative Term Sheet</div>
              <div style="font-size:13px;color:#64748b;">${deal.ts_signed ? 'Signed and accepted.' : 'Generated after DIP is signed and commitment fee is paid.'}</div>
            </div>
          </div>
        </div>

        <!-- Formal Offer -->
        ${renderFieldRow('formal-offer', 'Formal Offer Letter', 'Final binding lending terms',
          ['locked', 'locked', deal.fl_signed ? 'signed' : 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-formal-offer">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:8px">Formal Offer Letter</div>
              <div style="font-size:13px;color:#64748b;">${deal.fl_signed ? 'Signed — proceeding to legal.' : 'Issued after underwriting and bank approval.'}</div>
            </div>
          </div>
        </div>

        <!-- Execution & Completion -->
        ${renderFieldRow('execution-completion', 'Execution & Completion', 'Legal docs and completion statement',
          ['locked', 'locked', 'locked', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-execution-completion">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:8px">Execution & Completion</div>
              <div style="font-size:13px;color:#64748b;">Final legal documentation and completion statement. Generated at the execution stage.</div>
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
    <!-- Hidden file input for Upload -->
    <input type="file" id="matrix-parse-file-input" multiple accept=".pdf,.doc,.docx,.xlsx,.xls,.jpg,.jpeg,.png,.txt,.csv" style="display:none" onchange="window.matrixUploadFiles && window.matrixUploadFiles(this.files)" />

    <!-- Paste Broker Pack modal (hidden by default) -->
    <div id="matrix-paste-modal" style="display:none;padding:16px 26px;border-top:1px solid #e2e8f0;background:#f5f3ff;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:14px;font-weight:700;color:#7c3aed;">Paste Broker Pack / Email / WhatsApp</div>
        <button onclick="document.getElementById('matrix-paste-modal').style.display='none'" style="padding:4px 10px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;cursor:pointer;background:#fff;color:#64748b;">Cancel</button>
      </div>
      <textarea id="matrix-paste-text" placeholder="Paste the broker pack, email, or WhatsApp message here..." style="width:100%;min-height:120px;padding:12px;border:1px solid #d8b4fe;border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;outline:none;"></textarea>
      <button onclick="window.matrixParsePastedText && window.matrixParsePastedText()" style="margin-top:10px;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:600;border:none;background:#7c3aed;color:#fff;cursor:pointer;">Parse Text</button>
    </div>

    <!-- Parse progress indicator (hidden by default) -->
    <div id="matrix-parse-progress" style="display:none;padding:16px 26px;border-top:1px solid #e2e8f0;background:#eff6ff;text-align:center;">
      <div style="font-size:14px;font-weight:700;color:#2563eb;margin-bottom:6px;" id="matrix-parse-status">Processing...</div>
      <div style="font-size:12px;color:#64748b;">AI is working. This may take up to 2 minutes.</div>
      <div style="margin-top:10px;height:4px;background:#dbeafe;border-radius:4px;overflow:hidden;"><div style="height:100%;width:0%;background:#2563eb;border-radius:4px;animation:matrixParseBar 90s linear forwards;" id="matrix-parse-bar"></div></div>
    </div>

    <!-- COMPLETENESS INDICATOR -->
    <div id="matrix-completeness-bar" style="padding:14px 26px;border-top:1px solid #e2e8f0;background:#f0fdf4;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;color:#166534;">Matrix Completeness</div>
        <div style="font-size:14px;font-weight:800;color:#166534;" id="matrix-completeness-pct">0%</div>
      </div>
      <div style="height:8px;background:#dcfce7;border-radius:4px;overflow:hidden;">
        <div id="matrix-completeness-fill" style="height:100%;width:0%;background:#22c55e;border-radius:4px;transition:width 0.5s ease;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:#64748b;">
        <span id="matrix-completeness-detail">0 of 0 key fields completed</span>
        <span id="matrix-completeness-status" style="font-weight:600;"></span>
      </div>
    </div>

    <!-- ACTION BUTTONS BAR -->
    <div style="padding:12px 26px;border-top:1px solid #e2e8f0;background:#1e3a5f;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="document.getElementById('matrix-parse-file-input').click()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#2563eb;color:#fff;cursor:pointer;transition:all .12s" title="Step 1: Upload documents for AI categorisation">📤 Upload Documents</button>
        <button onclick="document.getElementById('matrix-paste-modal').style.display='block'" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#7c3aed;color:#fff;cursor:pointer;transition:all .12s" title="Paste broker text for AI parsing">📋 Paste Broker Pack</button>
        <button onclick="window.matrixParseConfirmed && window.matrixParseConfirmed()" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#f59e0b;color:#fff;cursor:pointer;transition:all .12s" title="Step 3: Parse confirmed documents and extract deal data">🔍 Parse Confirmed Docs</button>
        <button onclick="window.matrixSubmitForReview && window.matrixSubmitForReview()" id="matrix-submit-review-btn" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#22c55e;color:#fff;cursor:pointer;transition:all .12s" title="Step 4: Submit deal for RM review">✅ Submit for Review</button>
      </div>
      <div style="display:flex;gap:12px;font-size:8px;color:#cbd5e1">
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

  // ═══════════════════════════════════════════════════════════════════
  // PARSE FUNCTIONS — Upload & Parse, Paste Broker Pack, Re-Parse All
  // ═══════════════════════════════════════════════════════════════════

  function showParseProgress(message) {
    const progress = document.getElementById('matrix-parse-progress');
    const status = document.getElementById('matrix-parse-status');
    const bar = document.getElementById('matrix-parse-bar');
    if (progress) progress.style.display = 'block';
    if (status) status.textContent = message || 'Parsing documents...';
    if (bar) { bar.style.width = '0%'; bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = 'matrixParseBar 90s linear forwards'; }
    // Hide paste modal
    const modal = document.getElementById('matrix-paste-modal');
    if (modal) modal.style.display = 'none';
  }

  function hideParseProgress() {
    const progress = document.getElementById('matrix-parse-progress');
    if (progress) progress.style.display = 'none';
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
    const confColor = confidence >= 80 ? '#22c55e' : confidence >= 50 ? '#f59e0b' : '#dc2626';

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
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:700;color:#1e3a5f;">AI Extraction Results</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${extracted.length} fields extracted from your documents</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${hasNewBorrower ? `<div style="text-align:center;"><div style="font-size:16px;">&#128100;</div><div style="font-size:9px;color:#3b82f6;font-weight:600;">NEW PERSON</div></div>` : ''}
          ${hasNewProperty ? `<div style="text-align:center;"><div style="font-size:16px;">&#127968;</div><div style="font-size:9px;color:#22c55e;font-weight:600;">NEW PROPERTY</div></div>` : ''}
          ${filteredConflictKeys.length > 0 ? `<div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:#dc2626;">${filteredConflictKeys.length}</div><div style="font-size:9px;color:#dc2626;font-weight:600;">CONFLICTS</div></div>` : ''}
          ${confidence != null ? `<div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:${confColor};">${confidence}%</div><div style="font-size:9px;color:#64748b;font-weight:600;">CONFIDENCE</div></div>` : ''}
          <div style="text-align:center;"><div style="font-size:22px;font-weight:800;color:#2563eb;">${extracted.length}</div><div style="font-size:9px;color:#64748b;font-weight:600;">FIELDS</div></div>
        </div>
      </div>`;

    // Show conflicts banner ONLY for non-entity fields
    if (filteredConflictKeys.length > 0) {
      html += `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
          <div style="font-size:13px;font-weight:700;color:#dc2626;margin-bottom:8px;">&#9888; ${filteredConflictKeys.length} Conflicting Field${filteredConflictKeys.length > 1 ? 's' : ''} Detected</div>
          <div style="font-size:11px;color:#7f1d1d;margin-bottom:10px;">Different documents contain different values for these core deal fields. Please select the correct value for each.</div>`;

      for (const field of filteredConflictKeys) {
        const options = _lastConflicts[field];
        const label = FIELD_LABELS[field] || field;
        html += `
          <div style="background:#fff;border:1px solid #fecaca;border-radius:6px;padding:10px 14px;margin-bottom:8px;">
            <div style="font-size:12px;font-weight:700;color:#1e3a5f;margin-bottom:6px;">${label}</div>`;
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const catBadge = opt.category ? `<span style="padding:1px 6px;border-radius:4px;background:#e2e8f0;color:#475569;font-size:9px;font-weight:600;margin-left:6px;">${opt.category.toUpperCase()}</span>` : '';
          const srcName = opt.filename ? `<span style="font-size:10px;color:#94a3b8;margin-left:6px;">from: ${opt.filename.substring(0, 40)}</span>` : '';
          const isWinner = String(opt.value) === String(parsedData[field]);
          html += `
            <div style="display:flex;align-items:center;padding:5px 10px;border-radius:5px;margin-bottom:3px;background:${isWinner ? '#f0fdf4' : '#fff'};border:1px solid ${isWinner ? '#bbf7d0' : '#f1f5f9'};">
              <div style="flex:1;font-size:13px;color:#1e293b;font-weight:${isWinner ? '600' : '400'};">
                ${String(opt.value)}${catBadge}${srcName}
                ${isWinner ? '<span style="font-size:10px;color:#22c55e;font-weight:700;margin-left:8px;">&#10003; SELECTED (highest priority)</span>' : ''}
              </div>
              ${!isWinner ? `<button onclick="window.resolveConflict('${field}', ${i})" style="padding:2px 10px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:#2563eb;color:#fff;">Use This</button>` : ''}
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
          <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;padding:6px 0;border-bottom:1px solid #e2e8f0;margin-bottom:6px;">${sectionName}</div>`;

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
          <div id="new-borrower-card" style="background:linear-gradient(135deg,#eff6ff,#f0f9ff);border:2px solid #3b82f6;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:20px;">&#128100;</span>
              <div>
                <div style="font-size:14px;font-weight:700;color:#1e3a5f;">New Person Detected</div>
                <div style="font-size:11px;color:#64748b;">This document identifies a different person from the current borrower</div>
              </div>
            </div>
            <div style="display:flex;gap:16px;background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Current in Matrix</div>
                <div style="font-size:13px;font-weight:600;color:#1e293b;margin-top:2px;">${sanitizeHtml(matrixBorrower)}</div>
              </div>
              <div style="color:#cbd5e1;font-size:20px;align-self:center;">&#8594;</div>
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;">Parsed from Document</div>
                <div style="font-size:13px;font-weight:600;color:#1e293b;margin-top:2px;">${sanitizeHtml(parsedBorrower)}${sanitizeHtml(parsedCompany)}</div>
                <div style="font-size:10px;color:#64748b;margin-top:1px;">Type: ${sanitizeHtml(parsedType)}</div>
              </div>
            </div>
            <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:8px;">What would you like to do with this person?</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button onclick="window.addParsedAsBorrower('primary')" style="${btnStyle}background:#2563eb;color:#fff;" title="Add as a joint/additional borrower">&#43; Add as Borrower</button>
              <button onclick="window.addParsedAsBorrower('guarantor')" style="${btnStyle}background:#7c3aed;color:#fff;" title="Add as a personal guarantor">&#43; Add as Guarantor</button>
              <button onclick="window.addParsedAsBorrower('director')" style="${btnStyle}background:#0891b2;color:#fff;" title="Add as a company director">&#43; Add as Director</button>
              <button onclick="window.replaceBorrowerFromParsed()" style="${btnStyle}background:#f59e0b;color:#fff;" title="Replace the existing borrower with this person">&#8635; Replace Existing</button>
              <button onclick="document.getElementById('new-borrower-card').style.display='none'" style="${btnStyle}background:#f1f5f9;color:#64748b;" title="Ignore this person">Ignore</button>
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
          <div id="new-property-card" style="background:linear-gradient(135deg,#f0fdf4,#f0fdfa);border:2px solid #22c55e;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:20px;">&#127968;</span>
              <div>
                <div style="font-size:14px;font-weight:700;color:#1e3a5f;">New Property Detected</div>
                <div style="font-size:11px;color:#64748b;">This document references a different property from the current security</div>
              </div>
            </div>
            <div style="display:flex;gap:16px;background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Current in Matrix</div>
                <div style="font-size:13px;font-weight:600;color:#1e293b;margin-top:2px;">${sanitizeHtml(matrixProperty.substring(0, 80))}</div>
              </div>
              <div style="color:#cbd5e1;font-size:20px;align-self:center;">&#8594;</div>
              <div style="flex:1;">
                <div style="font-size:9px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:.5px;">Parsed from Document</div>
                <div style="font-size:13px;font-weight:600;color:#1e293b;margin-top:2px;">${sanitizeHtml(parsedPropertyAddr)}${sanitizeHtml(parsedPostcode)}</div>
                ${parsedAssetType ? `<div style="font-size:10px;color:#64748b;margin-top:1px;">${sanitizeHtml(parsedAssetType)}</div>` : ''}
              </div>
            </div>
            <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:8px;">What would you like to do with this property?</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button onclick="window.addParsedAsProperty()" style="${btnStyle}background:#22c55e;color:#fff;" title="Add as additional security in a portfolio deal">&#43; Add to Portfolio</button>
              <button onclick="window.replacePropertyFromParsed()" style="${btnStyle}background:#f59e0b;color:#fff;" title="Replace the existing property with this one">&#8635; Replace Existing</button>
              <button onclick="document.getElementById('new-property-card').style.display='none'" style="${btnStyle}background:#f1f5f9;color:#64748b;" title="Ignore this property">Ignore</button>
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
        const coreBadge = isCore ? '<span style="padding:1px 5px;border-radius:3px;background:#1e3a5f;color:#fff;font-size:8px;font-weight:700;margin-left:6px;letter-spacing:.3px;">CORE</span>' : '';
        const showConflict = hasConflict && !entityHandled;
        const conflictBadge = showConflict ? '<span style="padding:1px 5px;border-radius:3px;background:#dc2626;color:#fff;font-size:8px;font-weight:700;margin-left:4px;">CONFLICT</span>' : '';
        const rowBorder = showConflict ? 'border:1px solid #fecaca;background:#fef2f2;' : 'border:1px solid #f1f5f9;background:#fff;';

        // Check if Matrix already has a value for this field — suppress overwrite warning if entity card handles it
        const matrixEl = document.getElementById(`mf-${key}`);
        const matrixVal = matrixEl ? matrixEl.value.trim() : '';
        const matrixDiffers = matrixVal && matrixVal !== String(parsedData[key]) && isCore;
        const matrixWarning = (matrixDiffers && !entityHandled) ? `<div style="font-size:10px;color:#f59e0b;margin-top:3px;">&#9888; Matrix has: "${matrixVal.substring(0,40)}" — accepting will overwrite</div>` : '';

        // If entity card is shown, dim the individual accept/reject buttons and add a note
        const entityNote = entityHandled && matrixDiffers ? `<div style="font-size:9px;color:#3b82f6;margin-top:2px;">&#8593; Use the card above to add/replace</div>` : '';

        html += `
          <div style="display:flex;align-items:flex-start;padding:7px 12px;border-radius:6px;margin-bottom:3px;${rowBorder}" id="parsed-row-${key}">
            <div style="width:180px;font-size:12px;color:#64748b;font-weight:600;flex-shrink:0;">${label}${coreBadge}${conflictBadge}</div>
            <div style="flex:1;font-size:13px;color:#1e293b;font-weight:500;">
              ${val}
              ${matrixWarning}
              ${entityNote}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button onclick="window.acceptParsedField('${key}')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:#22c55e;color:#fff;" title="Accept and fill Matrix">&#10003;</button>
              <button onclick="document.getElementById('parsed-row-${key}').style.display='none'" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:#fee2e2;color:#dc2626;" title="Reject this value">&#10005;</button>
            </div>
          </div>`;
      }
      html += `</div>`;
    }

    parserFields.innerHTML = html;
    parserFields.style.display = 'block';
    if (parserActions) parserActions.style.display = 'flex';

    // Remove the "Select a document" placeholder
    const infoBox = parserContent ? parserContent.querySelector('div[style*="background:#eff6ff"]') : null;
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
      confEl.style.color = confidence >= 80 ? '#86efac' : confidence >= 50 ? '#fde68a' : '#fca5a5';
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
          card.innerHTML = `<div style="text-align:center;padding:12px;color:#22c55e;font-weight:700;font-size:13px;">&#10003; ${sanitizeHtml(body.full_name)} added as ${roleLabel}</div>`;
          card.style.borderColor = '#22c55e';
          card.style.background = '#f0fdf4';
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
        if (row) { row.style.background = '#f0fdf4'; row.style.borderColor = '#bbf7d0'; }
      }
    }
    const card = document.getElementById('new-borrower-card');
    if (card) {
      card.innerHTML = `<div style="text-align:center;padding:12px;color:#f59e0b;font-weight:700;font-size:13px;">&#8635; Borrower replaced — ${count} fields updated in Matrix</div>`;
      card.style.borderColor = '#f59e0b';
      card.style.background = '#fffbeb';
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
          card.innerHTML = `<div style="text-align:center;padding:12px;color:#22c55e;font-weight:700;font-size:13px;">&#10003; ${sanitizeHtml(body.address.substring(0, 50))} added to portfolio</div>`;
          card.style.borderColor = '#22c55e';
          card.style.background = '#f0fdf4';
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
        if (row) { row.style.background = '#f0fdf4'; row.style.borderColor = '#bbf7d0'; }
      }
    }
    const card = document.getElementById('new-property-card');
    if (card) {
      card.innerHTML = `<div style="text-align:center;padding:12px;color:#f59e0b;font-weight:700;font-size:13px;">&#8635; Property replaced — ${count} fields updated in Matrix</div>`;
      card.style.borderColor = '#f59e0b';
      card.style.background = '#fffbeb';
    }
    showToast(`Property replaced — ${count} fields updated`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  // ACCEPT PARSED FIELD(S) → push to Matrix inputs + save to DB
  // ═══════════════════════════════════════════════════════════════════
  function pushFieldToMatrix(key, val) {
    const el = document.getElementById(`mf-${key}`);
    if (!el) return false;

    el.value = String(val);
    el.style.borderColor = '#f59e0b';
    el.style.background = '#fffbeb';

    // Add AI badge if not there
    const confidence = _lastParsedData && _lastParsedData.confidence != null ? Math.round(_lastParsedData.confidence * 100) : null;
    const badge = el.parentElement.querySelector('.ai-confidence-badge');
    if (!badge && confidence != null) {
      const badgeColor = confidence >= 80 ? '#22c55e' : confidence >= 50 ? '#f59e0b' : '#dc2626';
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
        row.style.background = '#f0fdf4';
        row.style.borderColor = '#bbf7d0';
        const btns = row.querySelectorAll('button');
        btns.forEach(b => b.remove());
        const accepted = document.createElement('span');
        accepted.style.cssText = 'font-size:10px;font-weight:700;color:#22c55e;';
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
          row.style.background = '#f0fdf4';
          row.style.borderColor = '#bbf7d0';
          const btns = row.querySelectorAll('button');
          btns.forEach(b => b.remove());
          const accepted = document.createElement('span');
          accepted.style.cssText = 'font-size:10px;font-weight:700;color:#22c55e;';
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
    showParseProgress('Parsing confirmed documents — extracting deal data...');

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/parse-confirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deal_id: deal.submission_id })
      });

      hideParseProgress();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Parse failed', 'error');
        return;
      }

      const data = await resp.json();
      if (data.parsed_data) {
        autoPopulateMatrix(data.parsed_data, data.conflicts, data.core_fields);
        const conflictCount = Object.keys(data.conflicts || {}).length;
        const msg = conflictCount > 0
          ? `Parsed ${data.total_documents} documents. ${conflictCount} conflicting fields need your review.`
          : `Parsed ${data.total_documents} documents (${data.confirmed_documents} confirmed). Review extracted fields.`;
        showToast(msg, conflictCount > 0 ? 'warning' : 'success');
      } else {
        showToast(data.message || `${data.total_documents} documents processed. ${data.unconfirmed_documents > 0 ? data.unconfirmed_documents + ' still unconfirmed.' : ''}`, 'info');
      }

      // Refresh Doc Repo to update Parsed status column
      if (typeof window.refreshDocRepo === 'function') {
        window.refreshDocRepo();
      }

      // Recalculate completeness
      calculateCompleteness();
    } catch (e) {
      hideParseProgress();
      console.error('[matrix-parse-confirmed] Error:', e);
      showToast('Connection error during parsing', 'error');
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

  // ═══════════════════════════════════════════════════════════════════
  // DIP READINESS — section-by-section validation
  // ═══════════════════════════════════════════════════════════════════

  // Required fields per section for DIP submission
  const DIP_SECTIONS = {
    'Borrower / KYC': {
      required: ['borrower_name', 'borrower_type'],
      conditional: [
        // If corporate/spv/llp, company name + number are required
        { fields: ['company_name', 'company_number'], when: () => {
          const bt = document.getElementById('mf-borrower_type')?.value;
          return bt && bt !== 'individual';
        }},
        // Must have at least email OR phone
        { fields: ['borrower_email'], atLeastOne: ['borrower_email', 'borrower_phone'] }
      ],
      nice: ['borrower_dob', 'borrower_nationality']
    },
    'Borrower Financials': {
      required: ['estimated_net_worth'],
      nice: ['source_of_wealth']
    },
    'Property / Security': {
      required: ['security_address', 'security_postcode', 'asset_type', 'property_tenure'],
      nice: ['current_value', 'occupancy_status', 'current_use']
    },
    'Loan Terms': {
      required: ['loan_amount', 'term_months', 'interest_servicing', 'loan_purpose'],
      nice: ['ltv_requested', 'drawdown_date', 'use_of_funds']
    },
    'Exit Strategy': {
      required: ['exit_strategy'],
      nice: ['additional_notes']
    },
    'Fees': {
      required: ['arrangement_fee_pct'],
      nice: ['broker_fee_pct', 'commitment_fee']
    }
  };

  // All key fields (flat list for overall completeness)
  const KEY_FIELDS = Object.values(DIP_SECTIONS).flatMap(s => [...(s.required || []), ...(s.nice || [])]);

  /**
   * Check if a Matrix field has a value
   */
  function fieldHasValue(key) {
    const el = document.getElementById(`mf-${key}`);
    return el && el.value && el.value.trim() !== '' && el.value.trim() !== '— Select —';
  }

  /**
   * Calculate DIP readiness — returns { ready, pct, sections: { name: { status, missing, filled, total } } }
   */
  function calculateDipReadiness() {
    const result = { ready: true, sections: {}, totalRequired: 0, totalFilled: 0 };

    for (const [name, config] of Object.entries(DIP_SECTIONS)) {
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

    // Overall completeness (includes nice-to-have fields)
    let allFilled = 0;
    for (const key of KEY_FIELDS) {
      if (fieldHasValue(key)) allFilled++;
    }
    result.pct = Math.round((allFilled / KEY_FIELDS.length) * 100);
    result.requiredPct = result.totalRequired > 0 ? Math.round((result.totalFilled / result.totalRequired) * 100) : 0;

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
    if (detailEl) detailEl.textContent = `${readiness.totalFilled} of ${readiness.totalRequired} required fields completed`;

    if (statusEl) {
      if (readiness.ready) {
        statusEl.textContent = 'Ready for Submission';
        statusEl.style.color = '#22c55e';
      } else if (readiness.requiredPct >= 60) {
        statusEl.textContent = 'Almost Ready';
        statusEl.style.color = '#f59e0b';
      } else {
        statusEl.textContent = 'More Information Needed';
        statusEl.style.color = '#dc2626';
      }
    }

    // Update the CTA section readiness checklist if it exists
    const checklistEl = document.getElementById('dip-readiness-checklist');
    if (checklistEl) {
      let checkHtml = '';
      for (const [name, sec] of Object.entries(readiness.sections)) {
        const icon = sec.status === 'ready' ? '&#10003;' : sec.status === 'partial' ? '&#9888;' : '&#10005;';
        const color = sec.status === 'ready' ? '#22c55e' : sec.status === 'partial' ? '#f59e0b' : '#dc2626';
        const bg = sec.status === 'ready' ? '#f0fdf4' : sec.status === 'partial' ? '#fffbeb' : '#fef2f2';
        const missingText = sec.missing.length > 0
          ? sec.missing.map(k => FIELD_LABELS[k] || k.replace(/_/g, ' ')).join(', ')
          : '';
        checkHtml += `
          <div style="display:flex;align-items:flex-start;gap:8px;padding:5px 10px;border-radius:6px;background:${bg};margin-bottom:3px;">
            <span style="font-size:13px;color:${color};font-weight:700;flex-shrink:0;">${icon}</span>
            <div style="flex:1;">
              <span style="font-size:12px;font-weight:600;color:#1e293b;">${name}</span>
              ${missingText ? `<div style="font-size:10px;color:${color};margin-top:1px;">Missing: ${missingText}</div>` : ''}
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
        submitCta.style.background = '#22c55e';
      } else {
        submitCta.disabled = true;
        submitCta.style.opacity = '0.5';
        submitCta.style.background = '#94a3b8';
      }
    }

    return pct;
  }

  // Recalculate completeness whenever a field is saved
  const origSaveField = window.matrixSaveField;
  window.matrixSaveField = async function(fieldKey, value) {
    await origSaveField(fieldKey, value);
    calculateCompleteness();
  };

  // Initial calculation
  setTimeout(calculateCompleteness, 500);

  // ── If deal is already past 'received' stage, disable submit button and action buttons for brokers ──
  if (currentStage !== 'received' && !isInternalUser) {
    setTimeout(() => {
      const btn = document.getElementById('matrix-submit-review-btn');
      if (btn) {
        btn.innerHTML = '✅ Submitted for Review';
        btn.style.background = '#86efac';
        btn.style.color = '#166534';
        btn.disabled = true;
        btn.style.cursor = 'default';
      }
      // Also show a banner on the completeness bar
      const compBar = document.getElementById('matrix-completeness-bar');
      if (compBar) {
        const banner = document.createElement('div');
        banner.style.cssText = 'background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 14px;margin-top:10px;font-size:12px;color:#1d4ed8;font-weight:600;text-align:center;';
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
          btn.style.background = '#86efac';
          btn.style.color = '#166534';
          btn.disabled = true;
          btn.style.cursor = 'default';
        }

        // Replace the top CTA with confirmation banner
        const cta = document.getElementById('matrix-submit-cta');
        if (cta) {
          cta.style.background = '#eff6ff';
          cta.style.borderColor = '#bfdbfe';
          cta.innerHTML = `<div style="text-align:center;padding:6px;">
            <span style="font-size:13px;font-weight:700;color:#1d4ed8;">&#10003; Deal submitted for RM review${data.notification_sent ? ' — RM has been notified' : ''}</span>
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
