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
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));cursor:pointer;user-select:none;transition:background .12s;border-bottom:1px solid #f1f5f9" onclick="window.matrixToggleSection && window.matrixToggleSection('${sectionId}')" id="sec-${sectionId}">
      <div style="padding:11px 12px 11px 26px;display:flex;align-items:center;gap:8px">
        <div style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;background:#f1f5f9;border-radius:5px;font-size:9px;color:#64748b;transition:transform .2s,background .2s;flex-shrink:0">▸</div>
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
          <div style="font-size:11px;font-weight:700;color:#334155">${sanitizeHtml(docData.name || 'Document')}</div>
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
  const currentStage = deal.deal_stage || 'dip';

  // Stage mapping
  const stageIndex = { 'dip': 0, 'indicative-ts': 1, 'formal-offer': 2, 'execution': 3 };
  const currentStageIdx = stageIndex[currentStage] || 0;

  // ═══════════════════════════════════════════════════════════════════
  // HEADER & CONTEXT SECTION
  // ═══════════════════════════════════════════════════════════════════

  let html = `
    <!-- Header -->
    <div style="padding:20px 26px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:12px">
      <div style="width:36px;height:36px;background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px">📊</div>
      <div>
        <h2 style="font-size:16px;font-weight:700;color:#0f172a">Deal Information Matrix</h2>
        <div style="font-size:11px;color:#64748b;margin-top:1px">Live status tracking · ${sanitizeHtml(deal.borrower_name || 'Deal')} · £${deal.loan_amount ? (deal.loan_amount / 1000000).toFixed(1) : '0'}M</div>
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
        <span style="font-size:12px;font-weight:600;color:#1e293b">£${deal.loan_amount ? deal.loan_amount.toLocaleString() : '0'}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">LTV</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${deal.ltv_requested ? deal.ltv_requested.toFixed(1) : '0'}%</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Security</span>
        <span style="font-size:12px;font-weight:600;color:#1e293b">${sanitizeHtml(deal.security_address || 'N/A')}</span>
      </div>
      <div style="width:1px;height:24px;background:#e2e8f0"></div>
      <div style="display:flex;flex-direction:column;gap:0">
        <span style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8">Stage</span>
        <span style="font-size:12px;font-weight:600;color:#2563eb">${sanitizeHtml(currentStage.replace(/-/g, ' ').toUpperCase())}</span>
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

  html += `
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s1">
      ${renderSectionHeader('s1', '👤', 'Borrower / KYC', 'Comprehensive identity verification', [
        renderStatusDot(1, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Primary Borrower -->
        ${renderFieldRow('primary-borrower', 'Primary Borrower', 'Name, DOB, nationality, address, ID',
          ['approved', 'not-started', 'locked', 'locked'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#fafbfc" id="detail-primary-borrower">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-size:11px;font-weight:700;color:#334155">Primary Borrower — DIP Stage</div>
                <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Approved by RM</div>
              </div>

              <!-- Borrower type tabs -->
              <div style="display:flex;gap:0;margin-bottom:10px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#1e3a5f;color:#fff;border-right:1px solid #e2e8f0;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('individual')">Individual</div>
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('corporate')">Corporate</div>
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('spv')">SPV</div>
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('llp')">LLP</div>
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;border-right:1px solid #e2e8f0;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('trust')">Trust</div>
                <div style="padding:6px 12px;font-size:9px;font-weight:600;cursor:pointer;background:#f8fafc;color:#64748b;transition:all .12s;text-align:center;flex:1" onclick="window.matrixSwitchBorrowerType && window.matrixSwitchBorrowerType('partnership')">Partnership</div>
              </div>

              <!-- Individual details -->
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:9px;margin-bottom:10px">
                <div><span style="color:#94a3b8">Name:</span> ${sanitizeHtml(deal.borrower_name || 'N/A')}</div>
                <div><span style="color:#94a3b8">Email:</span> ${sanitizeHtml(deal.borrower_email || 'N/A')}</div>
              </div>

              ${isInternalUser ? `
                <div style="display:flex;gap:6px;margin-top:10px">
                  <button style="padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid #e2e8f0;background:#fff;color:#334155;cursor:pointer;transition:all .12s" onclick="window.matrixSendInfoRequest && window.matrixSendInfoRequest('borrower')">Request Info</button>
                </div>
              ` : ''}
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
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s2">
      ${renderSectionHeader('s2', '💰', 'Borrower Financials & AML', 'Income, assets, liabilities, and compliance', [
        renderStatusDot(2, 'under-review'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
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
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: PROPERTY / SECURITY
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s3">
      ${renderSectionHeader('s3', '🏘️', 'Property / Security', 'Property details and valuation', [
        renderStatusDot(1, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Property Details -->
        ${renderFieldRow('property-details', 'Property Details', 'Address, tenure, bedrooms, square footage',
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <!-- Valuation -->
        ${renderFieldRow('property-valuation', 'Valuation', 'Desktop valuation, survey, final valuation',
          ['approved', 'not-started', 'not-started', 'not-started'])}
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: LOAN TERMS & USE OF FUNDS
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s4">
      ${renderSectionHeader('s4', '📋', 'Loan Terms & Use of Funds', 'Loan structure and drawdown', [
        renderStatusDot(2, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Loan Terms -->
        ${renderFieldRow('loan-terms', 'Loan Terms', `Amount: £${deal.loan_amount ? deal.loan_amount.toLocaleString() : '0'}, Term: ${deal.term_months || '12'} months, Rate: ${deal.interest_rate || 'TBA'}%`,
          ['approved', 'not-started', 'not-started', 'not-started'])}

        <!-- Use of Funds -->
        ${renderFieldRow('use-of-funds', 'Use of Funds', 'Refinance, purchase, renovation, other',
          ['approved', 'not-started', 'not-started', 'not-started'])}
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: EXIT STRATEGY
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s5">
      ${renderSectionHeader('s5', '🚪', 'Exit Strategy', 'Refinance or sale plan', [
        renderStatusDot(1, 'submitted'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Exit Strategy -->
        ${renderFieldRow('exit-strategy', 'Exit Strategy', 'Refinance, sale, hold',
          ['submitted', 'not-started', 'not-started', 'not-started'])}

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
    <div style="border-bottom:1px solid #f1f5f9;${isDIPStage ? 'opacity:.45' : ''}" id="sec-s6">
      ${renderSectionHeader('s6', '⚖️', 'Legal & Insurance', 'Security and insurance requirements', [
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required'),
        renderStatusDot(0, 'not-required')
      ])}

      <div style="max-height:${isDIPStage ? '0' : '8000'}px;overflow:hidden;transition:max-height .35s ease;${isDIPStage ? 'display:none' : ''}">
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
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s7">
      ${renderSectionHeader('s7', '💼', 'Commercial', 'Fees and credit approval', [
        renderStatusDot(2, 'approved'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
        <!-- Fees -->
        ${renderFieldRow('fees', 'Fees', 'DIP: £0, Arrangement: £0, Broker: £0, Legal: £0, Valuation: £0',
          ['approved', 'not-started', 'not-started', 'not-started'])}

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
    <div style="border-bottom:1px solid #f1f5f9" id="sec-s8">
      ${renderSectionHeader('s8', '📄', 'Documents Issued', 'Deal documentation status', [
        renderStatusDot(deal.dip_signed ? 1 : 0, deal.dip_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.ts_signed ? 1 : 0, deal.ts_signed ? 'signed' : 'not-started'),
        renderStatusDot(deal.fl_signed ? 1 : 0, deal.fl_signed ? 'signed' : 'not-started'),
        renderStatusDot(0, 'not-started')
      ])}

      <div style="max-height:8000px;overflow:hidden;transition:max-height .35s ease">
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
  // DOCUMENT REPOSITORY
  // ═══════════════════════════════════════════════════════════════════

  html += `
    <div style="padding:16px 26px;border-top:1px solid #e2e8f0;background:#f8fafc">
      <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:10px">Document Repository</div>

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
    const section = document.getElementById(`sec-${sectionId}`);
    if (section) {
      section.classList.toggle('open');
      const chevron = section.querySelector('.sc');
      if (chevron) {
        chevron.style.transform = section.classList.contains('open') ? 'rotate(90deg)' : 'rotate(0)';
        chevron.style.background = section.classList.contains('open') ? '#dbeafe' : '#f1f5f9';
        chevron.style.color = section.classList.contains('open') ? '#2563eb' : '#64748b';
      }
    }
  };

  window.matrixToggleDetail = function(detailId) {
    const detail = document.getElementById(detailId);
    if (detail) {
      detail.classList.toggle('open');
      detail.style.maxHeight = detail.classList.contains('open') ? '1200px' : '0';
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
