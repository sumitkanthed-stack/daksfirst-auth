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
// 2026-04-29: Royal Mail PAF address autocomplete (PROP-3 widget)
import { mountAddressAutocomplete } from './address-autocomplete.js';
// 2026-04-21: shared display helpers for consistent stage labels across views.
import { getStageLabel, LOAN_PURPOSE_OPTIONS, EXIT_ROUTE_OPTIONS, EXIT_CONFIDENCE_OPTIONS } from './deal-display.js';
// ── Phase 1 Save Section (2026-05-03) — orange-border CSS for dirty inputs.
// See memory project_save_buttons_design_2026_05_03.md. Idempotent inject.
(function _injectMatrixDirtyCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('matrix-dirty-styles')) return;
  const s = document.createElement('style');
  s.id = 'matrix-dirty-styles';
  s.textContent = '.matrix-dirty { box-shadow: 0 0 0 1px rgba(251,146,60,0.65) !important; border-color: rgba(251,146,60,0.85) !important; transition: box-shadow .15s, border-color .15s; }';
  document.head.appendChild(s);
})();
// ── Phase 1 Save Section state — per-section dirty tracking + last-saved
// timestamps + idle-reminder timer + reminder-shown flags. Initialised
// idempotently so module re-imports don't reset live state.
window._matrixDirtyFields   = window._matrixDirtyFields   || { s4: new Set(), s7: new Set() };
window._matrixLastSavedAt   = window._matrixLastSavedAt   || { s4: null,      s7: null };
window._matrixIdleTimer     = window._matrixIdleTimer     || null;
window._matrixReminderShown = window._matrixReminderShown || { s4: false,    s7: false };
// ── Refresh the current deal in-place without kicking back to the dashboard ──
// Preserves BOTH matrix state (content-s1..s8 main sections + detail-* sub-row expands)
// AND legacy deal-sections state (body-* + collapsed class). Also restores scroll position.
//
// IMPORTANT: the matrix is rendered via dynamic `import('./deal-matrix.js').then(...)` inside
// deal-detail.js — that's fire-and-forget, so `await showDealDetail()` resolves BEFORE the
// matrix finishes rendering. We poll for the NEW matrix element to appear before restoring.
async function _refreshDealInPlace(submissionId) {
  try {
    if (typeof showDealDetail === 'function' && submissionId) {
      // ── Capture matrix main sections open (content-sN with maxHeight !== '0px') ──
      const openMatrixSections = [];
      document.querySelectorAll('[id^="content-s"]').forEach(el => {
        const mh = el.style.maxHeight;
        if (mh && mh !== '0px' && mh !== '') openMatrixSections.push(el.id.replace(/^content-/, ''));
      });

      // ── Capture matrix detail sub-rows open ──
      const openMatrixDetails = [];
      document.querySelectorAll('[id^="detail-"]').forEach(el => {
        const mh = el.style.maxHeight;
        if (mh && mh !== '0px' && mh !== '') openMatrixDetails.push(el.id);
      });

      // ── Capture legacy deal-sections state ──
      const expandedLegacySections = [];
      document.querySelectorAll('[id^="body-"]').forEach(el => {
        if (!el.classList.contains('collapsed')) expandedLegacySections.push(el.id.replace(/^body-/, ''));
      });

      const scrollY = window.scrollY || window.pageYOffset || 0;

      // Keep a reference to the OLD matrix element so we can detect when it's been replaced.
      const oldSectionRef = document.getElementById('content-s1');

      await showDealDetail(submissionId);

      // Poll for the NEW matrix to be in place (detected when content-s1 element reference
      // changes, OR 2 seconds have passed as a safety net). The matrix loads asynchronously.
      const doRestore = () => {
        // Restore matrix sections
        if (typeof window.matrixToggleSection === 'function') {
          for (const sid of openMatrixSections) {
            const content = document.getElementById('content-' + sid);
            if (content && (content.style.maxHeight === '0px' || content.style.maxHeight === '')) {
              try { window.matrixToggleSection(sid); } catch (_) {}
            }
          }
        }
        // Restore matrix detail sub-rows
        if (typeof window.matrixToggleDetail === 'function') {
          for (const did of openMatrixDetails) {
            const detail = document.getElementById(did);
            if (detail && (detail.style.maxHeight === '0px' || detail.style.maxHeight === '')) {
              try { window.matrixToggleDetail(did); } catch (_) {}
            }
          }
        }
        // Restore legacy deal-sections
        for (const id of expandedLegacySections) {
          const body = document.getElementById('body-' + id);
          const chevron = document.getElementById('chev-' + id);
          if (body && body.classList.contains('collapsed')) {
            body.classList.remove('collapsed');
            if (chevron) chevron.classList.add('open');
          }
        }
        if (scrollY) window.scrollTo({ top: scrollY, behavior: 'instant' });
      };

      // Poll up to 20 × 100ms = 2s for the new matrix to mount
      let attempts = 20;
      const poll = () => {
        const current = document.getElementById('content-s1');
        // Matrix has remounted when element reference changed, OR (defensive) when the old ref
        // is gone and a new one exists. Also finish if we run out of attempts.
        const remounted = !current || current !== oldSectionRef;
        if (remounted || attempts <= 0) {
          // Give the DOM one more frame to settle, then restore
          setTimeout(doRestore, 80);
          return;
        }
        attempts--;
        setTimeout(poll, 100);
      };
      poll();
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

// Sprint 5 #25 — expose for window._rebuildSusUses (which lives lower in
// this file but needs to call renderEditableField after a loan_purpose change).
if (typeof window !== 'undefined') {
  window.renderEditableField = renderEditableField;
}

// ═══════════════════════════════════════════════════════════════════
// M2b (Matrix-SSOT 2026-04-20) — Requested vs Approved paired field
//
// Each negotiable DIP term has TWO values: what broker asked (requested,
// read-only pill) and what we offer (approved, editable). This helper
// renders both side-by-side with an "Adjusted" badge when they differ.
//
// The Approved field writes to <baseField>_approved via matrixValidateAndSave.
// Requested field is display-only in the matrix (captured at submission).
// ═══════════════════════════════════════════════════════════════════
function renderRequestedApprovedField(baseField, label, requestedVal, approvedVal, inputType, canEdit, options, showApproved) {
  // 2026-04-21: showApproved defaults to true for backwards compat. Pass false
  // for broker pre-submission views — renders Requested only in a single-column
  // wider layout. Approved column (Daksfirst's offer) is RM-stage info and
  // has no reason to appear to a broker filling out their initial ask.
  if (showApproved === undefined) showApproved = true;
  const requestedField = baseField + '_requested';
  const approvedField = baseField + '_approved';

  // Format helper — money/percent/number all get £/% prefixes
  const formatDisplay = (v) => {
    if (v == null || v === '') return '—';
    const s = String(v);
    if (inputType === 'money') return '£' + formatWithCommas(s);
    if (inputType === 'percent') return s + '%';
    return s;
  };

  // Requested pill — grey, read-only, always displayed
  const requestedDisplay = (() => {
    if (inputType === 'select' && options && requestedVal != null) {
      const match = options.find(o => o.value === requestedVal);
      return match ? match.label : String(requestedVal);
    }
    return formatDisplay(requestedVal);
  })();

  // Adjusted badge — shown when approved differs from requested (non-null on both sides).
  // Use numeric comparison for money/percent/number types (NUMERIC(5,2) vs NUMERIC(5,3)
  // serialise as "1.00" vs "1.000" which string-diff would flag incorrectly).
  const isAdjusted = (() => {
    if (requestedVal == null || requestedVal === '') return false;
    if (approvedVal == null || approvedVal === '') return false;
    const numericTypes = ['money', 'number', 'percent'];
    if (numericTypes.includes(inputType)) {
      const a = Number(String(requestedVal).replace(/,/g, ''));
      const b = Number(String(approvedVal).replace(/,/g, ''));
      if (isFinite(a) && isFinite(b)) return Math.abs(a - b) > 0.0001;
    }
    // 'text' type may hold a number (e.g. LTV, Rate, Term). Try numeric first, fall back to string.
    if (inputType === 'text') {
      const a = Number(String(requestedVal).replace(/,/g, ''));
      const b = Number(String(approvedVal).replace(/,/g, ''));
      if (isFinite(a) && isFinite(b)) return Math.abs(a - b) > 0.0001;
    }
    return String(requestedVal).trim() !== String(approvedVal).trim();
  })();
  const adjustedBadge = isAdjusted
    ? '<span style="font-size:8px;color:#FBBF24;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);padding:1px 5px;border-radius:8px;margin-left:6px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;">Adjusted</span>'
    : '';

  // Approved input — reuse renderEditableField but with the approved column name
  const approvedInput = renderEditableField(approvedField, '', approvedVal, inputType, canEdit, options)
    .replace(/<label[^>]*>.*?<\/label>/, '')  // strip the inner label (we have our own above)
    .replace(/margin-bottom:12px/, 'margin-bottom:0'); // remove outer margin

  // 2026-04-21: Requested column is the broker's ASK. Editable by external
  // users (broker/borrower) only. For internal users (RM/admin/credit/
  // compliance), Requested is READ-ONLY — they work in the Approved column.
  // Previously both columns were editable for canEdit=true, which let RM
  // overwrite the broker's submitted ask.
  const _role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
  const _isExternal = !['admin', 'rm', 'credit', 'compliance'].includes(_role || '');
  const requestedEditable = canEdit && _isExternal;
  const requestedInput = requestedEditable
    ? renderEditableField(requestedField, '', requestedVal, inputType, canEdit, options)
        .replace(/<label[^>]*>.*?<\/label>/, '')
        .replace(/margin-bottom:12px/, 'margin-bottom:0')
    : `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:8px;color:#94A3B8;font-size:13px;font-weight:500;">${sanitizeHtml(requestedDisplay)}</div>`;

  // 2026-04-21: single-column layout when showApproved=false (broker pre-submit).
  // No "Requested" heading needed — it's the only value the broker is entering,
  // so the field label itself ("Loan Amount", "LTV", etc.) is self-explanatory.
  if (!showApproved) {
    return `<div style="margin-bottom:14px;">
      <label style="${labelStyle}">${sanitizeHtml(label)}</label>
      ${requestedInput}
    </div>`;
  }

  return `<div style="margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <label style="${labelStyle}margin:0;">${sanitizeHtml(label)}</label>
      ${adjustedBadge}
    </div>
    <div style="display:grid;grid-template-columns:1fr auto 1.2fr;gap:10px;align-items:center;">
      <div>
        <div style="font-size:8px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;font-weight:600;">Requested</div>
        ${requestedInput}
      </div>
      <div style="color:#475569;font-size:14px;padding-top:16px;">→</div>
      <div>
        <div style="font-size:8px;color:#34D399;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;font-weight:700;">Approved</div>
        ${approvedInput}
      </div>
    </div>
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
function renderSectionHeader(sectionId, iconInitial, title, subtitle, statusDots, showRequestInfo = false, showSave = false) {
  // Map icon initials to styles
  const iconStyles = {
    'DM': { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' },
    'B': { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA' },
    'F': { bg: 'rgba(212,168,83,0.15)', color: '#D4A853' },
    'P': { bg: 'rgba(52,211,153,0.1)', color: '#34D399' },
    'U': { bg: 'rgba(20,184,166,0.12)', color: '#14B8A6' }, // M4d: Use of Funds — teal
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

    // Phase 1 Save Section (2026-05-03) — Save button initial render state. Starts disabled
  // with "Saved" label; matrixMarkDirty / matrixSaveSection mutate label + enabled state live.
  const saveBtn = showSave
    ? `<button onclick="event.stopPropagation(); window.matrixSaveSection('${sectionId}')" id="save-btn-${sectionId}" disabled data-section-save="${sectionId}" style="padding:3px 10px;border-radius:4px;font-size:9px;font-weight:700;border:1px solid rgba(52,211,153,0.3);background:rgba(52,211,153,0.05);color:#34D399;cursor:not-allowed;margin-left:6px;white-space:nowrap;opacity:0.5;">Saved</button>`
    : '';

  return `
    <div style="display:grid;grid-template-columns:1fr repeat(4,minmax(125px,155px));cursor:pointer;user-select:none;transition:background .12s;border-bottom:1px solid rgba(255,255,255,0.06)" onclick="window.matrixToggleSection && window.matrixToggleSection('${sectionId}')" data-section-header="${sectionId}">
      <div style="padding:11px 12px 11px 26px;display:flex;align-items:center;gap:8px">
        <div id="chevron-${sectionId}" style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);border-radius:5px;font-size:9px;color:#94A3B8;transition:transform .2s,background .2s;flex-shrink:0;transform:rotate(0deg)">▸</div>
        <div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:${style.bg};border-radius:6px;font-size:12px;font-weight:700;color:${style.color};flex-shrink:0">${iconInitial}</div>
        <span style="font-size:12px;font-weight:700;color:#F1F5F9">${sanitizeHtml(title)}</span>
        <span style="font-size:9px;color:#94A3B8;font-weight:400;margin-left:5px">${sanitizeHtml(subtitle)}</span>
        ${requestInfoBtn}${saveBtn}
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

  // 2026-04-21: Broker's pre-submission view hides RM-only material.
  // Specifically: Approved columns (Daksfirst's offer), Rate (priced by RM),
  // the entire Fee Schedule (RM sets fees), and Day Zero (depends on fees).
  // Post-submission — broker sees both Requested + Approved read-only.
  // Internal roles always see the full view.
  const isPreSubmission = !isInternalUser && brokerEditableStages.includes(currentStage);
  const showApproved = !isPreSubmission;

  // Safe number helpers
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? num(v).toLocaleString() : '0';
  const fmtPct = (v) => num(v) ? num(v).toFixed(1) : '0.0';
  const fmtM = (v) => num(v) ? (num(v) / 1000000).toFixed(1) : '0';

  // ══ 2026-04-30 — SHARED corporate-borrower children-block renderer ══
  // ONE function used by primary corporate, joint corporate, and guarantor cards.
  // Sumit's architectural rule: Borrower (individual or UK corporate) renders the
  // SAME card from any entry point. Three previously-duplicated kidsTable + header
  // blocks now collapse to this single helper. Future improvements propagate
  // automatically to all three call sites.
  //
  // opts: { parentId, parentCompanyName, kids, submissionId, canEdit,
  //         accentColor (hex for + Add Person btn), sameNameSet (optional Set
  //         of normalized names — kids matching get a "Same as Borrower" tag) }
  function _buildSharedCorpChildren(opts) {
    const { parentId, parentCompanyName, kids, submissionId, canEdit, accentColor, sameNameSet } = opts;
    const colspan = canEdit ? 6 : 5;
    const _sameSet = sameNameSet || new Set();

    let kidsHtml;
    if (!kids || kids.length === 0) {
      kidsHtml = '<p style="font-size:11px;color:#FBBF24;margin:6px 0 0 0;">No directors/PSCs captured yet. Click Verify at Companies House to auto-populate.</p>';
    } else {
      let rows = '';
      kids.forEach((k) => {
        const isCorpKid = (k.borrower_type === 'corporate') ||
          (k.full_name && /\b(Ltd|Limited|LLP|PLC|Holdings|Inc|Corp|Corporation|Group)\b/i.test(k.full_name));
        const rBg = k.role === 'director' ? 'rgba(129,140,248,0.1)'
                  : k.role === 'psc' ? 'rgba(56,189,248,0.1)'
                  : k.role === 'ubo' ? 'rgba(167,139,250,0.1)'
                  : 'rgba(255,255,255,0.04)';
        const rCol = k.role === 'director' ? '#818CF8'
                   : k.role === 'psc' ? '#38BDF8'
                   : k.role === 'ubo' ? '#A78BFA'
                   : '#94A3B8';
        const kycCol = k.kyc_status === 'verified' ? '#34D399'
                     : k.kyc_status === 'submitted' ? '#D4A853'
                     : '#F87171';
        const sameTag = _sameSet.has((k.full_name || '').toLowerCase().trim())
          ? ' <span style="font-size:9px;color:#D4A853;background:rgba(212,168,83,0.15);padding:1px 6px;border-radius:8px;margin-left:4px;">Same as Borrower</span>'
          : '';
        rows += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + k.id + '" onclick="window._toggleBorrowerDetail(' + k.id + ')">' +
          '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' +
            sanitizeHtml(k.full_name || '-') + ' <span style="font-size:9px;color:#64748B;text-decoration:none;">&#9660;</span>' + sameTag +
          '</td>' +
          '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + rBg + ';color:' + rCol + ';text-transform:capitalize;">' + (k.role || 'director') + '</span></td>' +
          '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(k.nationality || '—') + '</td>' +
          '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycCol + ';text-transform:capitalize;">' + (k.kyc_status || 'pending') + '</span></td>' +
          '<td style="padding:6px 8px;text-align:center;">' + (k.ch_verified_at ? '<span style="font-size:10px;color:#34D399;font-weight:600;">&#10003;</span>' : '<span style="font-size:10px;color:#64748B;">—</span>') + '</td>' +
          (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
            ((isCorpKid && k.company_number)
              ? '<button onclick="window._chVerifyCorporateParty(' + k.id + ', \'' + submissionId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;margin-right:4px;" title="' + (k.ch_verified_at ? 'Re-verify corporate PSC at Companies House' : 'Verify this corporate PSC at Companies House') + '">' + (k.ch_verified_at ? '&#8635;' : '✓') + ' CH</button>'
              : '') +
            '<button onclick="window.editBorrowerRow(' + k.id + ', \'' + submissionId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
            '<button onclick="window.deleteBorrowerRow(' + k.id + ', \'' + submissionId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
          '</td>' : '') +
        '</tr>';
      });
      kidsHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">' +
        '<thead><tr style="background:rgba(255,255,255,0.04);">' +
          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>' +
          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>' +
          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Nationality</th>' +
          '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>' +
          '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">CH</th>' +
          (canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    return '<div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:6px;">' +
        '<span style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Directors, PSCs &amp; UBOs of ' + sanitizeHtml(parentCompanyName || 'this borrower') + ' — ' + (kids ? kids.length : 0) + '</span>' +
        (canEdit ? '<button onclick="window.addChildToParent(\'' + submissionId + '\', ' + parentId + ')" style="padding:3px 10px;background:' + (accentColor || '#818CF8') + ';color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Person</button>' : '') +
      '</div>' +
      kidsHtml +
    '</div>';
  }


  // ══ M3 Matrix-SSOT 2026-04-20 ══════════════════════════════════════
  // Client-side mirror of services/fee-formulae.js. Keep in sync with the
  // backend helper — both encode the same policy (confirmed with Sumit).
  //
  // DIP fee:        flat £1,000 default (not scaled; "commitment to underwrite")
  // Commitment fee: 0.10% × loan_approved, round DOWN in £2k increments, min £5k
  //                 e.g. £7.5m → 0.10%=£7,500 → round-down £2k = £6,000
  // ═══════════════════════════════════════════════════════════════════
  const DIP_FEE_DEFAULT = 1000;
  const COMMITMENT_FEE_RATE = 0.001;
  const COMMITMENT_FEE_MIN = 5000;
  const COMMITMENT_FEE_INCREMENT = 2000;

  const computeCommitmentFee = (loanApproved) => {
    const n = Number(loanApproved || 0);
    if (!isFinite(n) || n <= 0) return COMMITMENT_FEE_MIN;
    const raw = n * COMMITMENT_FEE_RATE;
    const rounded = Math.floor(raw / COMMITMENT_FEE_INCREMENT) * COMMITMENT_FEE_INCREMENT;
    return Math.max(COMMITMENT_FEE_MIN, rounded);
  };

  const explainCommitmentFee = (loanApproved) => {
    const n = Number(loanApproved || 0);
    if (!isFinite(n) || n <= 0) {
      return 'Set an approved loan amount to compute — minimum £5,000 otherwise.';
    }
    const raw = n * COMMITMENT_FEE_RATE;
    const rounded = Math.floor(raw / COMMITMENT_FEE_INCREMENT) * COMMITMENT_FEE_INCREMENT;
    const final = Math.max(COMMITMENT_FEE_MIN, rounded);
    const parts = [
      `0.10% × £${n.toLocaleString()} = £${raw.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      `round down to £2k = £${rounded.toLocaleString()}`
    ];
    if (rounded < COMMITMENT_FEE_MIN) {
      parts.push(`below £5,000 floor → £${final.toLocaleString()}`);
    }
    return parts.join(' → ');
  };

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
        <span style="font-size:12px;font-weight:600;color:#D4A853">${sanitizeHtml(getStageLabel(deal).toUpperCase())}</span>
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

    <!-- SUBMIT FOR REVIEW — prominent CTA for brokers.
         2026-04-21: 'draft' treated as pre-submit alongside 'received' so brokers
         see the CTA on brand-new deals (which are created in 'draft' stage). -->
    ${!isInternalUser && ['draft', 'received'].includes(currentStage) ? `
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
    ${!isInternalUser && !['draft', 'received'].includes(currentStage) ? `
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

  // Sprint 3 #15 — Borrower exposure widget. Lazy fetches concentration data;
  // shown only for internal users above the Borrower section.
  if (isInternalUser) {
    html += `
      <div id="borrower-exposure-widget" style="margin:0 0 0 0;padding:8px 16px;background:rgba(212,168,83,0.04);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:10px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">🔗 Borrower Portfolio</span>
        <span id="borrower-exposure-summary" style="font-size:12px;color:#94A3B8;">Loading…</span>
        <span id="borrower-exposure-action" style="margin-left:auto;"></span>
      </div>
    `;
    setTimeout(() => window._loadBorrowerExposure && window._loadBorrowerExposure(deal.submission_id), 300);
  }

  html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s1', 'B', 'Borrower / KYC', 'Comprehensive identity verification', [
        renderStatusDot(0, 'not-started', 'dip-sec-s1'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-s1" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Party Relationships analysis (auto-populated after render when 2+ corporate parties on the deal) -->
        <div style="padding:0 26px;"><div id="party-relationships-panel-placeholder"></div></div>

        <!-- Borrower (Primary + Joint + Officers) -->
        ${renderFieldRow('primary-borrower', 'Borrower', 'Primary + joint borrowers, directors, PSCs',
          ['not-started', 'not-started', 'locked', 'locked'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-primary-borrower">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">

              ${(() => {
                // 2026-04-30 — robust corporate detection: borrower_type can be NULL/wrong
                // on legacy deals or deals from older convert-to-deal versions, but
                // deal.company_number is unambiguous — if there's a company number,
                // it IS a corporate borrower regardless of what borrower_type column says.
                const isCorporate = !!(deal.company_number)
                  || ['corporate','spv','ltd','llp','limited'].includes((deal.borrower_type || '').toLowerCase());
                const allBorrowers = deal.borrowers || [];
                // Non-guarantors = rows that COULD belong to the primary borrower context.
                // Excludes: guarantors, any row whose parent is a guarantor OR joint borrower
                // (their officers live under their own party, not under the primary).
                const nonGuarantors = allBorrowers.filter(b => {
                  if (b.role === 'guarantor') return false;
                  if (b.parent_borrower_id) {
                    const parent = allBorrowers.find(p => p.id === b.parent_borrower_id);
                    if (parent && (parent.role === 'guarantor' || parent.role === 'joint' || parent.role === 'primary')) return false;
                  }
                  return true;
                });
                // 2026-04-21 fix — three bugs in filters:
                // (1) chOfficers was requiring !b.parent_borrower_id which excludes
                //     UBOs/Directors/PSCs correctly parented to the primary corporate
                //     (Phase G hierarchical model). Fix: find the primary row first,
                //     then pick its children in the officer-type roles.
                // (2) allChVerified read from empty chOfficers → stayed false → UNVERIFIED
                //     badge even on verified deals.
                // (3) coBorrowers included role='primary' which made section D render
                //     the primary row a SECOND time as "Joint Borrower" (duplicate).
                //
                // Split into semantic groups (corrected):
                //   primaryRow  = the top-level PRIMARY corporate/individual row in deal_borrowers
                //   chOfficers  = directors / PSCs / UBOs / shareholders under the primary row
                //   coBorrowers = JOINT top-level co-borrowers only (primary rendered separately)
                const primaryRow = allBorrowers.find(b => b.role === 'primary' && !b.parent_borrower_id);
                const chOfficers = primaryRow
                  ? allBorrowers.filter(b =>
                      b.parent_borrower_id === primaryRow.id &&
                      ['director','psc','ubo','shareholder'].includes(b.role))
                  : [];
                const coBorrowers = nonGuarantors.filter(b =>
                  b.role === 'joint' && !b.parent_borrower_id
                );
                const allChVerified = chOfficers.length > 0 && chOfficers.every(b => b.ch_verified_at);

                if (isCorporate && deal.company_name) {
                  // ══════════════════════════════════════════════════════════
                  // CORPORATE BORROWER FLOW
                  // Wraps Identity + CH Verify + Directors in a gold-bordered block.
                  // Joint Borrowers (section D) sit OUTSIDE this block so they don't inherit
                  // the gold border (they have their own green-bordered cards).
                  // ══════════════════════════════════════════════════════════
                  return `
                    <div style="border-left:3px solid #D4A853;padding-left:10px;margin-bottom:14px;">
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

                    <!-- ── A.1 SmartSearch KYC/AML (admin-only, primary corporate) ── -->
                    ${(isInternalUser && primaryRow && typeof window._buildSmartSearchPanel === 'function')
                      ? window._buildSmartSearchPanel(primaryRow, deal) : ''}

                    <!-- ── A.2 Experian credit bureau (admin-only, primary corporate) ── -->
                    ${(isInternalUser && primaryRow && typeof window._buildExperianPanel === 'function')
                      ? window._buildExperianPanel(primaryRow, deal) : ''}

                    <!-- ── B. Companies House Verification ── -->
                    ${deal.company_number ? `
                    <div style="margin-bottom:12px;">
                      ${allChVerified && primaryRow ? `
                      <div id="ch-cg-summary-${primaryRow.id}" onclick="window._toggleCorpGuarChDetail('${(deal.company_number || '').replace(/'/g, '')}', ${primaryRow.id})" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);border-radius:8px;cursor:pointer;margin-bottom:10px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                          <span style="color:#34D399;font-size:14px;">&#10003;</span>
                          <span style="font-size:12px;font-weight:700;color:#34D399;">Companies House Verified — ${sanitizeHtml(deal.company_name || '')}</span>
                          <span style="font-size:11px;color:#94A3B8;">— click to view full details</span>
                        </div>
                        <span id="ch-cg-arrow-${primaryRow.id}" style="color:#64748B;font-size:10px;transition:transform .2s;">&#9660;</span>
                      </div>
                      <div id="ch-cg-detail-${primaryRow.id}" style="max-height:0;overflow:hidden;transition:max-height .35s ease;margin-bottom:10px;">
                        <div id="ch-cg-panel-${primaryRow.id}" style="margin-top:4px;"></div>
                      </div>
                      ` : `
                      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
                        <button id="ch-matrix-verify-btn" onclick="window._chVerifyCorporateParty(${primaryRow ? primaryRow.id : 'null'}, '${(deal.submission_id || '').replace(/'/g, '')}')"
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

                    <!-- ── C. Connected Individuals (Directors, PSCs, UBOs) — uses shared _buildSharedCorpChildren helper ── -->
                    <!-- 2026-04-30 — Single source of truth: same children block as guarantor (renderCorpCard) and joint (_jointCorpCard). -->
                    ${_buildSharedCorpChildren({
                      parentId: primaryRow ? primaryRow.id : null,
                      parentCompanyName: deal.company_name,
                      kids: chOfficers,
                      submissionId: deal.submission_id,
                      canEdit: canEdit,
                      accentColor: '#D4A853',
                    })}
                    <div style="font-size:9px;color:#64748B;font-style:italic;margin-top:4px;">Auto-populated from Companies House · individual KYC only</div>
                    </div> <!-- close gold-bordered primary-borrower block; D. Joint Borrowers below is outside this block -->

                    <!-- ── D. Joint Borrowers — other top-level parties on this deal, rendered as cards ── -->
                    ${(() => {
                      const _isCorpType = (t) => ['corporate','spv','ltd','llp','limited','trust','partnership'].includes((t || '').toLowerCase());
                      const childrenOfJoint = (pid) => allBorrowers.filter(b => b.parent_borrower_id === pid);
                      const corpJoints = coBorrowers.filter(b => _isCorpType(b.borrower_type));
                      const indJoints = coBorrowers.filter(b => !_isCorpType(b.borrower_type));
                      const subId = deal.submission_id;
                      const fmtDateJ = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? v : d.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}); };
                      const fieldJ = (label, val, stage) => {
                        const s = val && String(val).trim();
                        return '<div style="margin-bottom:8px;"><div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
                          (s ? '<div style="font-size:12px;color:#F1F5F9;font-weight:500;">' + sanitizeHtml(String(val)) + '</div>'
                             : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained' + (stage ? ' <span style="font-size:9px;color:#334155;">(' + stage + ')</span>' : '') + '</div>') +
                        '</div>';
                      };
                      const statusJ = (label, status) => {
                        const map = { clear:'#34D399', verified:'#34D399', not_screened:'#64748B', not_obtained:'#64748B', none:'#34D399', flagged:'#F87171', active:'#F87171', undischarged:'#F87171', discharged:'#D4A853', obtained:'#D4A853' };
                        const c = map[status] || '#64748B';
                        const bg = c === '#34D399' ? 'rgba(52,211,153,0.1)' : c === '#F87171' ? 'rgba(248,113,113,0.1)' : c === '#D4A853' ? 'rgba(212,168,83,0.1)' : 'rgba(255,255,255,0.04)';
                        return '<div style="margin-bottom:8px;"><div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">' + label + '</div>' +
                          '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + bg + ';color:' + c + ';text-transform:capitalize;">' + (status ? String(status).replace(/_/g,' ') : 'not screened') + '</span></div>';
                      };

                      // Corporate Joint card — identity + CH verify + directors/PSCs table + full-detail lazy panel
                      const _jointCorpCard = (g) => {
                        const kids = childrenOfJoint(g.id);
                        const chV = !!g.ch_verified_at;

                        // SmartSearch + Experian panels (admin-only) — mirror primary corporate borrower (lines 881-886)
                        // Bug-fix 2026-04-28: joint corporate co-borrower card never rendered these at the entity level.
                        const ssPanelJ = (isInternalUser && typeof window._buildSmartSearchPanel === 'function')
                          ? window._buildSmartSearchPanel(g, deal) : '';
                        const expPanelJ = (isInternalUser && typeof window._buildExperianPanel === 'function')
                          ? window._buildExperianPanel(g, deal) : '';

                        const chDetailBlock = chV ? (
                          '<div id="ch-cg-summary-' + g.id + '" onclick="window._toggleCorpGuarChDetail(\'' + (g.company_number || '').replace(/\'/g, '') + '\', ' + g.id + ')" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);border-radius:8px;cursor:pointer;margin-bottom:10px;">' +
                            '<div style="display:flex;align-items:center;gap:8px;"><span style="color:#34D399;font-size:14px;">\u2713</span><span style="font-size:12px;font-weight:700;color:#34D399;">Companies House Verified \u2014 ' + sanitizeHtml(g.company_name || '') + '</span><span style="font-size:11px;color:#94A3B8;">\u2014 click to view full details</span></div>' +
                            '<span id="ch-cg-arrow-' + g.id + '" style="color:#64748B;font-size:10px;transition:transform .2s;">\u25BC</span>' +
                          '</div>' +
                          '<div id="ch-cg-detail-' + g.id + '" style="max-height:0;overflow:hidden;transition:max-height .35s ease;margin-bottom:10px;">' +
                            '<div id="ch-cg-panel-' + g.id + '" style="margin-top:4px;"></div>' +
                          '</div>'
                        ) : '';

                        const kidsTable = kids.length > 0 ?
                          '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">' +
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
                              return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + k.id + '" onclick="window._toggleBorrowerDetail(' + k.id + ')">' +
                                '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' + sanitizeHtml(k.full_name || '-') + ' <span style="font-size:9px;color:#64748B;text-decoration:none;">&#9660;</span></td>' +
                                '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + rBg + ';color:' + rCol + ';text-transform:capitalize;">' + (k.role || 'director') + '</span></td>' +
                                '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(k.nationality || '—') + '</td>' +
                                '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycCol + ';text-transform:capitalize;">' + (k.kyc_status || 'pending') + '</span></td>' +
                                '<td style="padding:6px 8px;text-align:center;">' + (k.ch_verified_at ? '<span style="font-size:10px;color:#34D399;font-weight:600;">&#10003;</span>' : '<span style="font-size:10px;color:#64748B;">—</span>') + '</td>' +
                                (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
                                  // G5.3 Part A — If this is a corporate PSC with a company_number, expose CH verify button
                                  ((k.borrower_type === 'corporate' && k.company_number)
                                    ? '<button onclick="window._chVerifyCorporateParty(' + k.id + ', \'' + subId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;margin-right:4px;" title="' + (k.ch_verified_at ? 'Re-verify corporate PSC at Companies House (includes its directors &amp; PSCs)' : 'Verify this corporate PSC at Companies House') + '">' + (k.ch_verified_at ? '&#8635;' : '\u2713') + ' CH</button>'
                                    : '') +
                                  '<button onclick="window.editBorrowerRow(' + k.id + ', \'' + subId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
                                  '<button onclick="window.deleteBorrowerRow(' + k.id + ', \'' + subId + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
                                '</td>' : '') +
                              '</tr>';
                            }).join('') +
                          '</tbody></table>'
                          : '<p style="font-size:11px;color:#FBBF24;margin:6px 0 0 0;">No directors/PSCs yet. Click Verify at Companies House to auto-populate.</p>';

                        return '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #34D399;border-radius:8px;padding:12px 14px;margin-bottom:10px;">' +
                          '<div style="background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.18);border-radius:6px;padding:10px 14px;margin-bottom:10px;">' +
                            '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px;">' +
                              '<div>' +
                                '<div style="font-size:10px;color:#34D399;text-transform:uppercase;font-weight:700;letter-spacing:.3px;">Joint Borrower (Corporate)</div>' +
                                '<div style="font-size:15px;font-weight:700;color:#F1F5F9;margin-top:3px;">' + sanitizeHtml(g.company_name || g.full_name || 'Unnamed') + '</div>' +
                                '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;color:#94A3B8;">' +
                                  '<span>Co. No: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.company_number || '—') + '</strong></span>' +
                                  '<span>Type: <strong style="color:#E2E8F0;text-transform:capitalize;">' + (g.borrower_type || 'corporate') + '</strong></span>' +
                                  (g.jurisdiction ? '<span>Jurisdiction: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.jurisdiction) + '</strong></span>' : '') +
                                '</div>' +
                              '</div>' +
                              '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
                                (chV
                                  ? '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.15);color:#34D399;">&#10003; CH VERIFIED</span>'
                                    + (canEdit && g.company_number ? '<button onclick="window._chVerifyCorporateParty(' + g.id + ', \'' + subId + '\')" title="Re-run CH verify — updates officers, PSCs, and auto-recurses into corporate PSCs" style="padding:3px 10px;background:rgba(52,211,153,0.1);color:#34D399;border:1px solid rgba(52,211,153,0.3);border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">\u21BB Re-verify</button>' : '')
                                  : (canEdit && g.company_number
                                    ? '<button onclick="window._chVerifyCorporateParty(' + g.id + ', \'' + subId + '\')" style="padding:4px 12px;background:#34D399;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Verify at Companies House</button>'
                                    : '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(251,191,36,0.1);color:#FBBF24;">' + (g.company_number ? 'UNVERIFIED' : 'NO CO. NUMBER') + '</span>')) +
                                (canEdit ? '<button onclick="window.editBorrowerRow(' + g.id + ', \'' + subId + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' : '') +
                                (canEdit ? '<button onclick="window.deleteBorrowerRow(' + g.id + ', \'' + subId + '\')" style="padding:3px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove joint borrower">\u2715</button>' : '') +
                              '</div>' +
                            '</div>' +
                          '</div>' +
                          ssPanelJ +
                          expPanelJ +
                          chDetailBlock +
                          // 2026-04-30 — uses shared _buildSharedCorpChildren helper (same as guarantor + primary)
                          _buildSharedCorpChildren({
                            parentId: g.id,
                            parentCompanyName: g.company_name || 'this joint borrower',
                            kids: kids,
                            submissionId: subId,
                            canEdit: canEdit,
                            accentColor: '#34D399',
                          }) +
                        '</div>';
                      };

                      // Individual Joint card — Alessandra-Cenci 2-col detail with green accent
                      const _jointIndCard = (g) => {
                        const kycCol = g.kyc_status === 'verified' ? '#34D399' : g.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
                        const kycLabel = g.kyc_status === 'verified' ? '\u2713 KYC VERIFIED' : (g.kyc_status || 'pending').toUpperCase();
                        const idDocInner = (g.id_type || g.id_number)
                          ? '<div style="font-size:12px;color:#F1F5F9;font-weight:500;text-transform:capitalize;">' + sanitizeHtml((g.id_type || 'ID').replace(/_/g,' ')) + (g.id_number ? ': ' + sanitizeHtml(g.id_number) : '') + '</div>' +
                            (g.id_expiry ? '<div style="font-size:10px;color:#94A3B8;margin-top:1px;">Expires: ' + fmtDateJ(g.id_expiry) + '</div>' : '')
                          : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(DIP)</span></div>';
                        const creditInner = g.credit_score
                          ? (() => { const sc = g.credit_score >= 700 ? '#34D399' : g.credit_score >= 500 ? '#D4A853' : '#F87171';
                              return '<div style="display:flex;align-items:baseline;gap:6px;">' +
                                '<span style="font-size:18px;font-weight:800;color:' + sc + ';">' + g.credit_score + '</span>' +
                                (g.credit_score_source ? '<span style="font-size:10px;color:#64748B;">' + sanitizeHtml(g.credit_score_source) + '</span>' : '') +
                                (g.credit_score_date ? '<span style="font-size:10px;color:#475569;">(' + fmtDateJ(g.credit_score_date) + ')</span>' : '') +
                              '</div>'; })()
                          : '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained <span style="font-size:9px;color:#334155;">(Underwriting)</span></div>';

                        return '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #34D399;border-radius:8px;padding:12px 14px;margin-bottom:10px;">' +
                          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);flex-wrap:wrap;gap:6px;">' +
                            '<div>' +
                              '<div style="font-size:10px;color:#34D399;text-transform:uppercase;font-weight:700;letter-spacing:.5px;">Joint Co-Borrower (Individual)</div>' +
                              '<div style="font-size:15px;font-weight:700;color:#F1F5F9;margin-top:3px;">' + sanitizeHtml(g.full_name || 'Unnamed') + '</div>' +
                            '</div>' +
                            '<div style="display:flex;gap:6px;align-items:center;">' +
                              '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.1);color:' + kycCol + ';">' + kycLabel + '</span>' +
                              (canEdit ? '<button onclick="window.editBorrowerRow(' + g.id + ', \'' + subId + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' : '') +
                              (canEdit ? '<button onclick="window.deleteBorrowerRow(' + g.id + ', \'' + subId + '\')" style="padding:3px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove">\u2715</button>' : '') +
                            '</div>' +
                          '</div>' +
                          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px;">' +
                            '<div>' +
                              '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Personal Identity</div>' +
                              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                                fieldJ('Date of Birth', fmtDateJ(g.date_of_birth), 'DIP') +
                                fieldJ('Gender', g.gender, 'DIP') +
                                fieldJ('Nationality', g.nationality, 'DIP') +
                                fieldJ('Email', g.email, 'DIP') +
                                fieldJ('Phone', g.phone, 'DIP') +
                              '</div>' +
                              '<div style="margin-bottom:8px;"><div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">ID Document</div>' + idDocInner + '</div>' +
                              fieldJ('Residential Address', g.residential_address || g.address, 'DIP') +
                              statusJ('Address Proof', g.address_proof_status || 'not_obtained') +
                            '</div>' +
                            '<div>' +
                              '<div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Compliance &amp; Verification</div>' +
                              '<div style="margin-bottom:8px;"><div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Credit Score</div>' + creditInner + '</div>' +
                              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;">' +
                                statusJ('CCJs', g.ccj_count > 0 ? (g.ccj_count + ' found') : (g.ccj_count === 0 ? 'None' : 'not_screened')) +
                                statusJ('Bankruptcy', g.bankruptcy_status || 'none') +
                                statusJ('PEP Screening', g.pep_status || 'not_screened') +
                                statusJ('Sanctions', g.sanctions_status || 'not_screened') +
                              '</div>' +
                              fieldJ('Source of Wealth', g.source_of_wealth, 'Underwriting') +
                              fieldJ('Source of Funds', g.source_of_funds, 'Underwriting') +
                            '</div>' +
                          '</div>' +
                        '</div>';
                      };

                      const cardsHtml = corpJoints.map(_jointCorpCard).join('') + indJoints.map(_jointIndCard).join('');
                      return '<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">' +
                        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;">' +
                          '<div>' +
                            '<span style="font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Joint Borrowers \u2014 ' + coBorrowers.length + ' ' + (coBorrowers.length === 1 ? 'Party' : 'Parties') + '</span>' +
                            (coBorrowers.length > 0 ? '<div style="font-size:10px;color:#94A3B8;margin-top:2px;">' + corpJoints.length + ' corporate \u00B7 ' + indJoints.length + ' individual</div>' : '') +
                          '</div>' +
                          (canEdit ? '<button onclick="window.addJointBorrower(\'' + subId + '\')" title="Add another primary/joint co-borrower (NOT a director or guarantor)" style="padding:5px 14px;background:rgba(52,211,153,0.12);color:#34D399;border:1px solid #34D399;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">\u21B3 Add Joint Co-Borrower</button>' : '') +
                        '</div>' +
                        (coBorrowers.length > 0 ? cardsHtml : '<p style="font-size:11px;color:#64748B;margin:4px 0;font-style:italic;">No joint borrowers. Use the button above to add another party as a co-borrower.</p>') +
                      '</div>';
                    })()}
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
                const _isCorp = (t) => ['corporate','spv','ltd','llp','limited'].includes((t || '').toLowerCase());

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
                              // G5.3 Part A — Corporate PSC gets a CH verify button
                              ((k.borrower_type === 'corporate' && k.company_number)
                                ? '<button onclick="window._chVerifyCorporateParty(' + k.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;margin-right:4px;" title="' + (k.ch_verified_at ? 'Re-verify corporate PSC at CH' : 'Verify corporate PSC at CH') + '">' + (k.ch_verified_at ? '&#8635;' : '\u2713') + ' CH</button>'
                                : '') +
                              '<button onclick="window.editBorrowerRow(' + k.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
                              '<button onclick="window.deleteBorrowerRow(' + k.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
                            '</td>' : '') +
                          '</tr>';
                        }).join('') +
                      '</tbody></table>'
                    : '<p style="font-size:11px;color:#FBBF24;margin:6px 0 0 0;">No directors/PSCs captured yet. Add manually or run CH verification (coming).</p>';

                  // SmartSearch + Experian panels (admin-only) — mirror primary corporate borrower (lines 881-886)
                  // Bug-fix 2026-04-28: corporate guarantor card never rendered these at the entity level —
                  // panels were only on the primary borrower + on individual director rows when expanded.
                  const ssPanelG = (isInternalUser && typeof window._buildSmartSearchPanel === 'function')
                    ? window._buildSmartSearchPanel(g, deal) : '';
                  const expPanelG = (isInternalUser && typeof window._buildExperianPanel === 'function')
                    ? window._buildExperianPanel(g, deal) : '';

                  // CH expandable detail block — only shown when verified, lazy-loaded on first click
                  const chDetailBlock = chVerified ? (
                    '<div id="ch-cg-summary-' + g.id + '" onclick="window._toggleCorpGuarChDetail(\'' + (g.company_number || '').replace(/'/g, '') + '\', ' + g.id + ')" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(129,140,248,0.08);border:1px solid rgba(129,140,248,0.25);border-radius:8px;cursor:pointer;margin-bottom:10px;">' +
                      '<div style="display:flex;align-items:center;gap:8px;">' +
                        '<span style="color:#818CF8;font-size:14px;">\u2713</span>' +
                        '<span style="font-size:12px;font-weight:700;color:#818CF8;">Companies House Verified \u2014 ' + sanitizeHtml(g.company_name || '') + '</span>' +
                        '<span style="font-size:11px;color:#94A3B8;">\u2014 click to view full details</span>' +
                      '</div>' +
                      '<span id="ch-cg-arrow-' + g.id + '" style="color:#64748B;font-size:10px;transition:transform .2s;">\u25BC</span>' +
                    '</div>' +
                    '<div id="ch-cg-detail-' + g.id + '" style="max-height:0;overflow:hidden;transition:max-height .35s ease;margin-bottom:10px;">' +
                      '<div id="ch-cg-panel-' + g.id + '" style="margin-top:4px;"></div>' +
                    '</div>'
                  ) : '';

                  // G5.3 Part C — Detect elected-from provenance
                  const gChm = g.ch_match_data || {};
                  const electedFromId = gChm.elected_from_borrower_id || null;
                  const electedFromName = gChm.elected_from_name || null;
                  const electedFromRole = gChm.elected_from_role || null;
                  const electedAtIso = gChm.elected_at || null;
                  const electedBrokerTrace = gChm.broker_trace_required === true;

                  // F2 (2026-04-20): Orphan detection — source PSC may have been deleted
                  // (happens when primary borrower was deleted, cascading its PSC chain,
                  // but the top-level elected guarantor row survived because it's not a child).
                  // Check if the referenced source id still exists in deal.borrowers.
                  const electedSourceExists = electedFromId
                    ? (deal.borrowers || []).some(b => b.id === electedFromId)
                    : true; // no elected id => not elected => not orphan
                  const isOrphan = electedFromId && !electedSourceExists;

                  // Acronym roles (PSC / UBO / LLP) should display uppercase, not title-case
                  const _fmtRole = (r) => {
                    if (!r) return '';
                    const lr = String(r).toLowerCase();
                    if (['psc','ubo','llp','plc'].includes(lr)) return lr.toUpperCase();
                    return lr.charAt(0).toUpperCase() + lr.slice(1);
                  };

                  // F2: Orphan banner — render ABOVE the elected banner when source is gone
                  const orphanBanner = isOrphan
                    ? '<div style="margin-bottom:10px;padding:10px 12px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.4);border-left:3px solid #FB923C;border-radius:6px;">' +
                        '<div style="font-size:10px;color:#FB923C;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">\u26A0 Orphan Guarantor \u2014 Source Deleted</div>' +
                        '<div style="font-size:11px;color:#FED7AA;line-height:1.5;">' +
                          'This guarantor was elected from <strong>' + sanitizeHtml(electedFromName || 'a corporate PSC') + '</strong>, but that source entity is no longer on this deal ' +
                          '(typically because the primary borrower was deleted and cascaded the PSC chain).' +
                        '</div>' +
                        '<div style="font-size:10px;color:#FED7AA;margin-top:6px;">' +
                          'Action: either <strong>delete this guarantor row</strong> if the election is no longer valid, ' +
                          'or <strong>re-add the source entity</strong> and re-elect to restore provenance.' +
                        '</div>' +
                      '</div>'
                    : '';

                  const electedBanner = electedFromId
                    ? '<div style="margin-bottom:10px;padding:8px 12px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.3);border-left:3px solid #A78BFA;border-radius:6px;">' +
                        '<div style="font-size:9px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">\u2696 Elected as Corporate Guarantor</div>' +
                        '<div style="font-size:11px;color:#CBD5E1;line-height:1.5;">' +
                          'Elected from <strong style="color:#E2E8F0;">' + sanitizeHtml(electedFromName || 'source entity') + '</strong>' +
                          (electedFromRole ? ' (was: ' + sanitizeHtml(_fmtRole(electedFromRole)) + ')' : '') +
                          (electedAtIso ? ' \u00B7 <span style="color:#94A3B8;">' + fmtDate(electedAtIso) + '</span>' : '') +
                        '</div>' +
                        (electedBrokerTrace
                          ? '<div style="margin-top:6px;padding:6px 8px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:4px;font-size:10px;color:#FBBF24;">\u26A0 Cross-border entity \u2014 guarantee may require foreign legal opinion / local counsel</div>'
                          : '') +
                      '</div>'
                    : '';

                  return '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid ' + (isOrphan ? '#FB923C' : '#818CF8') + ';border-radius:8px;padding:12px 14px;margin-bottom:12px;">' +
                    orphanBanner +
                    electedBanner +
                    // Identity card
                    '<div style="background:rgba(129,140,248,0.05);border:1px solid rgba(129,140,248,0.18);border-radius:6px;padding:10px 14px;margin-bottom:10px;">' +
                      '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                        '<div>' +
                          '<div style="font-size:10px;color:#818CF8;text-transform:uppercase;font-weight:700;letter-spacing:.3px;">Corporate Guarantor' + (electedFromId ? ' \u00B7 Elected' : '') + '</div>' +
                          '<div style="font-size:15px;font-weight:700;color:#F1F5F9;margin-top:3px;">' + sanitizeHtml(g.company_name || g.full_name || 'Unnamed') + '</div>' +
                          '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;color:#94A3B8;">' +
                            '<span>Co. No: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.company_number || '—') + '</strong></span>' +
                            '<span>Type: <strong style="color:#E2E8F0;text-transform:capitalize;">' + (g.borrower_type || 'corporate') + '</strong></span>' +
                            (g.jurisdiction ? '<span>Jurisdiction: <strong style="color:#E2E8F0;">' + sanitizeHtml(g.jurisdiction) + '</strong></span>' : '') +
                          '</div>' +
                        '</div>' +
                        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
                          (chVerified
                            ? '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(129,140,248,0.15);color:#818CF8;">&#10003; CH VERIFIED</span>'
                            : (canEdit && g.company_number
                              ? '<button onclick="window._chVerifyCorporateParty(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:4px 12px;background:#818CF8;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Verify at Companies House</button>'
                              : '<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(251,191,36,0.1);color:#FBBF24;">' + (g.company_number ? 'UNVERIFIED' : 'NO CO. NUMBER') + '</span>')) +
                          (canEdit ? '<button onclick="window.editBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' : '') +
                          (canEdit ? '<button onclick="window.deleteBorrowerRow(' + g.id + ', \'' + deal.submission_id + '\')" style="padding:3px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="' + (electedFromId ? 'Unelect (remove this corporate guarantor row; source PSC row stays intact)' : 'Remove guarantor') + '">\u2715</button>' : '') +
                        '</div>' +
                      '</div>' +
                    '</div>' +
                    ssPanelG +
                    expPanelG +
                    chDetailBlock +
                    // 2026-04-30 — children block now via shared _buildSharedCorpChildren helper.
                    // Same call pattern in primary, joint, and guarantor — single source of truth.
                    _buildSharedCorpChildren({
                      parentId: g.id,
                      parentCompanyName: g.company_name || 'this guarantor',
                      kids: kids,
                      submissionId: deal.submission_id,
                      canEdit: canEdit,
                      accentColor: '#818CF8',
                      sameNameSet: sameNameIds,
                    }) +
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
        <!-- Sprint 3 #17 — Per-UBO Balance Sheet (NEW) -->
        ${renderFieldRow('balance-sheet', 'Balance Sheet (per UBO)', 'Property portfolio + assets + liabilities + ownership %',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-balance-sheet">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Per-UBO Balance Sheet</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <p style="font-size:11px;color:#94A3B8;margin:0 0 10px 0;font-style:italic;">Each individual borrower / UBO / director / guarantor gets their own balance sheet. Track property portfolio (with rent vs interest = net rental), other assets, and liabilities. Ownership % captures partial / indirect ownership (e.g. 50% jointly with spouse, 30% via SPV).</p>
              ${(typeof window._buildBalanceSheetSection === 'function')
                ? window._buildBalanceSheetSection(deal)
                : '<div style="font-size:11px;color:#F87171;padding:10px;">Balance sheet module not loaded. Refresh the page.</div>'}
            </div>
          </div>
        </div>

        <!-- Sprint 4 #21 — Consolidated A/L + Consolidated Income/Expenses (rollup across all UBOs) -->
        ${renderFieldRow('consolidated-balance-sheet', 'Consolidated A/L + I/E', 'Aggregated across all UBOs (effective shares applied)',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-consolidated-balance-sheet">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Consolidated Balance Sheet + Income/Expenses</div>
                <span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ-ONLY · ROLLUP</span>
              </div>
              <p style="font-size:11px;color:#94A3B8;margin:0 0 10px 0;font-style:italic;">Rollup of every UBO's balance sheet + income/expenses on this deal. Effective shares (ownership %) applied. Edit individual rows in the per-UBO Balance Sheet block above.</p>
              <div id="consolidated-bs-host" style="font-size:12px;color:#94A3B8;padding:6px;">Loading consolidated rollup…</div>
            </div>
          </div>
        </div>

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
                      <th style="text-align:center;padding:6px 4px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);width:24px;" title="Click row to expand property details"></th>
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
                      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="prop-row-${p.id}" onclick="window._togglePropertyExpand(${p.id})">
                      <td style="padding:6px 4px;text-align:center;color:#64748B;font-size:12px;width:24px;transform:rotate(90deg);transition:transform 0.15s;" id="prop-chev-${p.id}">▶</td>
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
                      ${canEdit ? `<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">
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

                // ═══ Chimnie Intelligence panel (2026-04-21) ═══
                // Separate expandable panel below the EPC/LR property intelligence.
                // Internal users only (paid API — broker can't trigger).
                const chimnieHtml = (() => {
                  if (!isInternalUser) return '';
                  const fetched = p.chimnie_fetched_at;
                  const fmtMoney = (n) => n != null && !isNaN(n) ? '\u00A3' + Math.round(Number(n)).toLocaleString() : '\u2014';
                  const fmtPct = (n) => n != null && !isNaN(n) ? Number(n).toFixed(2) + '%' : '\u2014';
                  const pillBg = '#1e3a5f';
                  // ── Collapse/expand state — mirrors EPC Property Intelligence panel ──
                  // Default collapsed when: data fetched AND property is verified (EPC accepted).
                  // Default open in every other case so RM sees the data after fetching / refreshing.
                  const chimnieCollapsed = !!fetched;  // 2026-04-30: collapse by default when data fetched
                  const chimnieBodyDisplay = chimnieCollapsed ? 'none' : 'block';
                  const chimnieSummaryDisplay = chimnieCollapsed ? 'inline' : 'none';
                  const chimnieChevronRotate = chimnieCollapsed ? '' : 'transform:rotate(90deg);';

                  const headerRow = '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;cursor:pointer;" onclick="window._toggleChimniePanel(' + p.id + ')">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span id="chimnie-chevron-' + p.id + '" style="display:inline-block;font-size:10px;color:#64748B;' + chimnieChevronRotate + 'transition:transform 0.15s;">\u25B6</span>' +
                      '<span style="font-size:10px;color:#60A5FA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'Chimnie Intelligence</span>' +
                      (p.chimnie_exact_match === true ? '<span style="font-size:9px;color:#34D399;background:rgba(52,211,153,0.12);padding:1px 6px;border-radius:3px;font-weight:700;">\u2713 EXACT MATCH</span>' :
                       p.chimnie_exact_match === false ? '<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:1px 6px;border-radius:3px;font-weight:700;">\u26A0 FUZZY MATCH</span>' : '') +
                      // Inline summary — shown only when collapsed. Built below after kpi vars are ready; slot in here.
                      '<span id="chimnie-summary-' + p.id + '" style="display:' + chimnieSummaryDisplay + ';font-size:11px;color:#F1F5F9;margin-left:8px;font-weight:400;">__SUMMARY__</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;align-items:center;">' +
                      (fetched ? '<span style="font-size:9px;color:#64748B;">Fetched ' + new Date(fetched).toLocaleDateString('en-GB') + ' · ' + (window._freshAge ? window._freshAge(fetched, 30) : '') + '</span>' : '') +
                      '<button onclick="event.stopPropagation();window._chimnieLookup(' + p.id + ', \'' + subId + '\')" style="padding:3px 10px;background:' + (fetched ? 'rgba(96,165,250,0.12)' : '#60A5FA') + ';color:' + (fetched ? '#60A5FA' : '#111') + ';border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">' + (fetched ? 'Refresh' : 'Fetch') + '</button>' +
                    '</div>' +
                  '</div>';
                  if (!fetched) {
                    // No data yet — replace the summary placeholder with empty string
                    const notFetchedHeader = headerRow.replace('__SUMMARY__', '');
                    return '<div id="chimnie-panel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(96,165,250,0.03);border:1px dashed rgba(96,165,250,0.25);border-radius:6px;">' +
                      notFetchedHeader +
                      '<div id="chimnie-body-' + p.id + '" style="display:block;">' +
                        '<div style="font-size:11px;color:#64748B;margin-top:6px;font-style:italic;">No Chimnie data yet. Click Fetch to pull AVM, flood risk, crime percentile, rental estimate, ownership flags, and the full property dossier.</div>' +
                      '</div>' +
                    '</div>';
                  }
                  // Summary row — AVM / LTV / Flood / Crime
                  const avmRange = (p.chimnie_avm_low && p.chimnie_avm_high)
                    ? fmtMoney(p.chimnie_avm_low) + '\u2013' + fmtMoney(p.chimnie_avm_high)
                    : null;
                  const confColor = p.chimnie_avm_confidence === 'High' ? '#34D399'
                                  : p.chimnie_avm_confidence === 'Medium' ? '#FBBF24'
                                  : p.chimnie_avm_confidence === 'Low' ? '#F87171' : '#94A3B8';
                  // Flood risk thresholds (Daksfirst policy — tune later)
                  const floodRS = Number(p.chimnie_flood_risk_rivers_sea) || 0;
                  const floodSW = Number(p.chimnie_flood_risk_surface_water) || 0;
                  const floodMax = Math.max(floodRS, floodSW);
                  const floodColor = floodMax > 1 ? '#F87171' : floodMax > 0.1 ? '#FBBF24' : '#34D399';
                  const floodLabel = floodMax > 1 ? 'HIGH' : floodMax > 0.1 ? 'MEDIUM' : 'LOW';
                  // Cross-check broker vs Chimnie MV
                  const brokerMV = Number(p.market_value) || 0;
                  const chimnieMid = Number(p.chimnie_avm_mid) || 0;
                  let varianceBadge = '';
                  if (brokerMV > 0 && chimnieMid > 0) {
                    const variance = ((brokerMV - chimnieMid) / chimnieMid) * 100;
                    const absV = Math.abs(variance);
                    if (absV > 15) {
                      varianceBadge = '<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:1px 6px;border-radius:3px;font-weight:700;margin-left:4px;">\u26A0 Broker ' + (variance > 0 ? '+' : '') + variance.toFixed(1) + '% vs AVM</span>';
                    } else if (absV > 5) {
                      varianceBadge = '<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.08);padding:1px 6px;border-radius:3px;font-weight:600;margin-left:4px;">\u00B1' + absV.toFixed(1) + '% vs AVM</span>';
                    }
                  }
                  const kpi = (label, value, extraStyle) => '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;letter-spacing:.3px;">' + label + '</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;' + (extraStyle || '') + '">' + value + '</span></div>';
                  // Red-flag chips
                  const flags = [];
                  // Tier 1 hard-decline signals — surface FIRST so they catch the eye.
                  if (p.chimnie_prebuild === true) flags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.2);padding:2px 7px;border-radius:3px;font-weight:700;border:1px solid #F87171;">\u26A0 PREBUILD — not constructed</span>');
                  if (p.chimnie_has_farmland === true) flags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.2);padding:2px 7px;border-radius:3px;font-weight:700;border:1px solid #F87171;">\u26A0 FARMLAND — excluded asset</span>');
                  if (p.chimnie_overseas_ownership === true) flags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Overseas owner</span>');
                  // Tier 3 — heating/insurance/legal red flags
                  const mainFuelLower = String(p.chimnie_main_fuel || '').toLowerCase();
                  if (mainFuelLower && !mainFuelLower.includes('gas') && !mainFuelLower.includes('mains')) {
                    // Off-grid heating (oil, LPG, electric-only) — affects tenant desirability + insurance
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Off-grid heating: ' + sanitizeHtml(p.chimnie_main_fuel) + '</span>');
                  }
                  if (p.chimnie_has_extension === true && p.chimnie_extension_count >= 1) {
                    flags.push('<span style="font-size:9px;color:#94A3B8;background:rgba(148,163,184,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Extended (' + p.chimnie_extension_count + ') — verify authorised</span>');
                  }
                  if (p.chimnie_has_solar_panels === true) {
                    flags.push('<span style="font-size:9px;color:#34D399;background:rgba(52,211,153,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u2600 Solar panels' + (p.chimnie_solar_panels_shared === true ? ' (shared)' : '') + '</span>');
                  }
                  if (p.chimnie_outbuildings_count != null && p.chimnie_outbuildings_count > 0) {
                    const obArea = Number(p.chimnie_outbuildings_area_sqm) || 0;
                    flags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">' + p.chimnie_outbuildings_count + ' outbuilding' + (p.chimnie_outbuildings_count === 1 ? '' : 's') + (obArea > 0 ? ' · ' + Math.round(obArea) + ' m\u00B2' : '') + '</span>');
                  }
                  // Fire station distance flag — UK home insurance commonly increases premiums beyond 5 miles (~8km)
                  const fireDist = Number(p.chimnie_fire_station_distance_m) || null;
                  if (fireDist != null && fireDist > 8000) {
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Fire station ' + (fireDist / 1000).toFixed(1) + 'km — insurance loading</span>');
                  }
                  // Cross-property concentration — if another property IN THIS DEAL shares our parent UPRN
                  if (p.chimnie_parent_uprn && deal.properties && deal.properties.length > 1) {
                    const siblingsInDeal = deal.properties.filter(other =>
                      other.id !== p.id && other.chimnie_parent_uprn === p.chimnie_parent_uprn
                    );
                    if (siblingsInDeal.length > 0) {
                      flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.15);padding:2px 7px;border-radius:3px;font-weight:700;border:1px solid rgba(251,191,36,0.3);">\u26A0 Block concentration: ' + siblingsInDeal.length + ' sibling' + (siblingsInDeal.length === 1 ? '' : 's') + ' on this deal</span>');
                    }
                  }
                  if (p.chimnie_connected_property_risk && p.chimnie_connected_property_risk !== 'none' && p.chimnie_connected_property_risk !== 'None') {
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Connected risk: ' + sanitizeHtml(p.chimnie_connected_property_risk) + '</span>');
                  }
                  if (p.chimnie_company_ownership === true) flags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u24D8 Company-owned</span>');
                  if (p.chimnie_is_listed === true) flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u24D8 Listed bldg</span>');
                  // 2026-04-21: case-insensitive — Chimnie returns lowercase 'brick', 'stone', 'timber'
                  const constructionLower = String(p.chimnie_construction_material || '').toLowerCase();
                  if (constructionLower && !['brick', 'stone'].includes(constructionLower)) {
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Non-std: ' + sanitizeHtml(p.chimnie_construction_material) + '</span>');
                  }
                  // Occupancy flag — vacant is a risk signal (no rental income, possible long void period).
                  // 2026-04-21: Chimnie returns 'owner-occupier' (not 'owner-occupied'); match both spellings.
                  // Only flag genuinely unusual occupancy — standard values produce no chip.
                  const occupancyLower = String(p.chimnie_occupancy_status || '').toLowerCase();
                  const standardOccupancies = ['owner-occupier', 'owner-occupied', 'tenanted', 'tenant', 'rented', 'let'];
                  if (occupancyLower === 'vacant' || occupancyLower.includes('vacant')) {
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Vacant</span>');
                  } else if (occupancyLower && !standardOccupancies.includes(occupancyLower) && !standardOccupancies.some(s => occupancyLower.includes(s))) {
                    flags.push('<span style="font-size:9px;color:#94A3B8;background:rgba(148,163,184,0.10);padding:2px 7px;border-radius:3px;font-weight:700;">Occ: ' + sanitizeHtml(p.chimnie_occupancy_status) + '</span>');
                  }
                  // Flood target detail — "Buildings" is materially worse than "Grounds"
                  const floodCat = String(p.chimnie_flood_risk_surface_cat || '').toLowerCase();
                  if (floodCat === 'buildings') {
                    flags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Flood target: Buildings</span>');
                  } else if (floodCat === 'grounds') {
                    flags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.08);padding:2px 7px;border-radius:3px;font-weight:600;">Flood target: Grounds</span>');
                  }
                  const flagsHtml = flags.length > 0 ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + flags.join('') + '</div>' : '';

                  // Row 3 builders — physical + bills
                  const typeLabel = p.chimnie_property_subtype || p.chimnie_property_type || '\u2014';
                  // Floor level for flats (e.g. "Floor 2 of 5") — only show when we have storey data
                  const floorLevelLine = (p.chimnie_estimated_floor_level != null && p.chimnie_flat_storey_count != null)
                    ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">Floor ' + p.chimnie_estimated_floor_level + ' of ' + p.chimnie_flat_storey_count + '</div>'
                    : (p.chimnie_estimated_floor_level != null
                      ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">Floor ' + p.chimnie_estimated_floor_level + '</div>'
                      : '');
                  const classificationLine = (p.chimnie_classification && p.chimnie_classification !== 'Residential')
                    ? '<div style="font-size:9px;color:#FBBF24;font-weight:600;margin-top:2px;">' + sanitizeHtml(p.chimnie_classification) + '</div>'
                    : '';
                  const typeDetail = floorLevelLine + classificationLine;
                  const bedsBaths = (p.chimnie_bedrooms != null || p.chimnie_bathrooms != null)
                    ? ((p.chimnie_bedrooms != null ? p.chimnie_bedrooms + ' bed' : '?') + ' \u00B7 ' + (p.chimnie_bathrooms != null ? p.chimnie_bathrooms + ' bath' : '?'))
                      + ((p.chimnie_reception_rooms != null && p.chimnie_reception_rooms > 0) || (p.chimnie_total_rooms != null && p.chimnie_total_rooms > 0)
                        ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' +
                          (p.chimnie_reception_rooms != null && p.chimnie_reception_rooms > 0 ? p.chimnie_reception_rooms + ' reception' + (p.chimnie_reception_rooms === 1 ? '' : 's') : '') +
                          (p.chimnie_total_rooms != null && p.chimnie_total_rooms > 0 ? (p.chimnie_reception_rooms ? ' \u00B7 ' : '') + p.chimnie_total_rooms + ' rooms total' : '') +
                          '</div>'
                        : '')
                    : '\u2014';
                  // Cross-check Chimnie floor area vs EPC floor area — flag >10% variance (possible survey divergence)
                  const faChim = Number(p.chimnie_floor_area_sqm) || 0;
                  const faEpc = Number(p.epc_floor_area) || 0;
                  let faVariance = '';
                  if (faChim > 0 && faEpc > 0) {
                    const vPct = ((faChim - faEpc) / faEpc) * 100;
                    if (Math.abs(vPct) > 10) {
                      faVariance = '<div style="font-size:9px;color:#FBBF24;font-weight:600;margin-top:2px;">\u26A0 ' + (vPct > 0 ? '+' : '') + vPct.toFixed(1) + '% vs EPC</div>';
                    }
                  }
                  // Garden / grounds line — value-add signal for exit pricing
                  const groundsSqm = Number(p.chimnie_grounds_area_sqm) || 0;
                  const gardenLine = (p.chimnie_has_garden === true || groundsSqm > 0)
                    ? '<div style="font-size:9px;color:#34D399;font-weight:500;margin-top:2px;">\u273F Garden' + (groundsSqm > 0 ? ' \u00B7 ' + Math.round(groundsSqm).toLocaleString() + ' m\u00B2 grounds' : '') + '</div>'
                    : '';
                  const faDisplay = faChim > 0
                    ? (faChim.toFixed(0) + ' m\u00B2 <span style="font-size:9px;color:#94A3B8;font-weight:400;">(' + Math.round(faChim * 10.764).toLocaleString() + ' sqft)</span>' + faVariance + gardenLine)
                    : (gardenLine || '\u2014');
                  const ctBand = p.chimnie_council_tax_band ? 'Band ' + sanitizeHtml(p.chimnie_council_tax_band) : '\u2014';
                  // Rebuild cost: show total + £/sqft (computed from floor area).
                  // £/sqft makes variance across properties directly comparable — e.g.
                  // ground-floor flat at £387/sqft vs terrace house at £211/sqft tells
                  // a very different construction-cost story than the raw totals.
                  const rebuildTotal = Number(p.chimnie_rebuild_cost_estimate) || 0;
                  const rebuildSqm = Number(p.chimnie_floor_area_sqm) || 0;
                  const rebuildPsf = (rebuildTotal > 0 && rebuildSqm > 0)
                    ? rebuildTotal / (rebuildSqm * 10.764)
                    : null;
                  const rebuildDisplay = rebuildTotal > 0
                    ? fmtMoney(rebuildTotal) +
                      (rebuildPsf
                        ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">\u00A3' + Math.round(rebuildPsf).toLocaleString() + '/sqft</div>'
                        : '') +
                      ((p.chimnie_rebuild_cost_basic && p.chimnie_rebuild_cost_luxury)
                        ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">Basic ' + fmtMoney(p.chimnie_rebuild_cost_basic) + ' \u00B7 Lux ' + fmtMoney(p.chimnie_rebuild_cost_luxury) + '</div>'
                        : '')
                    : '\u2014';
                  // Transit cell — shows PTAL for London (TfL dataset) as the primary score,
                  // with nearest train/TFL station name + distance (Chimnie) as context.
                  // PTAL 0–1b = red (Very Poor / Poor), 2–3 = amber (Moderate),
                  // 4 = yellow-green (Good), 5–6b = green (Very Good / Excellent).
                  const isLondon = (p.chimnie_region || '').toLowerCase() === 'london';
                  const stationName = p.chimnie_nearest_station_name;
                  const stationDistance = Number(p.chimnie_nearest_station_distance_m) || 0;
                  const ptal = p.chimnie_ptal;

                  // PTAL colour + label
                  const ptalColour = (() => {
                    if (!ptal) return '#94A3B8';
                    if (['0','1a','1b'].includes(ptal)) return '#F87171';      // red
                    if (['2','3'].includes(ptal)) return '#FBBF24';            // amber
                    if (ptal === '4') return '#A3E635';                        // yellow-green
                    if (['5','6a','6b'].includes(ptal)) return '#34D399';      // green
                    return '#94A3B8';
                  })();
                  const ptalWord = (() => {
                    if (!ptal) return '';
                    if (ptal === '0') return 'None';
                    if (ptal === '1a') return 'Very Poor';
                    if (ptal === '1b') return 'Poor';
                    if (ptal === '2') return 'Poor';
                    if (ptal === '3') return 'Moderate';
                    if (ptal === '4') return 'Good';
                    if (ptal === '5') return 'Very Good';
                    if (ptal === '6a') return 'Excellent';
                    if (ptal === '6b') return 'Excellent+';
                    return '';
                  })();

                  // Station sub-line: only built if Chimnie returned station data
                  let stationSub = '';
                  if (stationDistance > 0) {
                    const distLabel = stationDistance < 1000
                      ? stationDistance + 'm'
                      : (stationDistance / 1000).toFixed(1) + 'km';
                    const walkMin = Math.round(stationDistance / 80);
                    stationSub = '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' +
                      (stationName ? sanitizeHtml(stationName) + ' \u00B7 ' : '') +
                      distLabel + ' \u00B7 ~' + walkMin + ' min walk</div>';
                  }

                  let transitDisplay;
                  if (ptal) {
                    // London property with a computed PTAL
                    transitDisplay = '<span style="color:' + ptalColour + ';">PTAL ' + sanitizeHtml(ptal) + '</span>' +
                      (ptalWord ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;font-style:italic;">' + ptalWord + '</div>' : '') +
                      stationSub;
                  } else if (isLondon) {
                    // In London but PTAL lookup failed (off the grid — e.g. Thames, park)
                    transitDisplay = '<span style="color:#94A3B8;font-weight:400;">PTAL n/a</span>' + stationSub;
                  } else if (stationDistance > 0) {
                    // Non-London: PTAL doesn't apply. Show station distance as the headline.
                    const distLabel = stationDistance < 1000
                      ? stationDistance + 'm'
                      : (stationDistance / 1000).toFixed(1) + 'km';
                    const walkMin = Math.round(stationDistance / 80);
                    const distColour = stationDistance < 500 ? '#34D399'
                                     : stationDistance < 1000 ? '#FBBF24'
                                     : '#F87171';
                    transitDisplay = '<span style="color:' + distColour + ';">' + distLabel + '</span>' +
                      (stationName ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + sanitizeHtml(stationName) + ' \u00B7 ~' + walkMin + ' min walk</div>' : '');
                  } else {
                    transitDisplay = '<span style="color:#94A3B8;font-weight:400;">\u2014</span>';
                  }

                  // Metadata strip — identifiers + location, small font at top
                  const metaBits = [];
                  if (p.chimnie_uprn) metaBits.push('UPRN <code style="color:#F1F5F9;">' + sanitizeHtml(p.chimnie_uprn) + '</code>');
                  if (p.chimnie_region) metaBits.push(sanitizeHtml(p.chimnie_region));
                  if (p.chimnie_postcode) metaBits.push(sanitizeHtml(p.chimnie_postcode));
                  const metaStrip = metaBits.length > 0
                    ? '<div style="font-size:10px;color:#64748B;margin-top:6px;">' + metaBits.join(' \u00B7 ') + '</div>'
                    : '';

                  // ── Property Relationships (flat in a block) ──
                  // Shows the block structure for flats: parent UPRN + sibling count.
                  // Important for multi-property deals on the same block (concentration risk).
                  const hasRelationships = p.chimnie_parent_uprn || (p.chimnie_sibling_uprn_count != null && p.chimnie_sibling_uprn_count > 0) || (p.chimnie_subproperty_uprn_count != null && p.chimnie_subproperty_uprn_count > 0);
                  const relationshipsStrip = hasRelationships
                    ? '<div style="margin-top:6px;padding:6px 10px;background:rgba(201,162,39,0.05);border:1px solid rgba(201,162,39,0.18);border-radius:4px;font-size:10px;color:#94A3B8;">' +
                        '<span style="color:#C9A227;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;font-size:9px;">Property Relationships</span>' +
                        (p.chimnie_parent_uprn ? ' \u00B7 Parent block <code style="color:#F1F5F9;">' + sanitizeHtml(p.chimnie_parent_uprn) + '</code>' : '') +
                        (p.chimnie_sibling_uprn_count ? ' \u00B7 ' + p.chimnie_sibling_uprn_count + ' sibling unit' + (p.chimnie_sibling_uprn_count === 1 ? '' : 's') + ' in block' : '') +
                        (p.chimnie_subproperty_uprn_count ? ' \u00B7 ' + p.chimnie_subproperty_uprn_count + ' sub-units contained' : '') +
                      '</div>'
                    : '';

                  // ── Property images + floorplan thumbnails (Tier 3, multi-image) ──
                  // Horizontal strip of up to 6 listing images + all floorplans, each clickable
                  // to open the full-size image in a new tab. Uses the promoted URL arrays
                  // with fallback to the legacy single-URL column.
                  const imgCount = Number(p.chimnie_image_count) || 0;
                  const fpCount = Number(p.chimnie_floorplan_count) || 0;
                  const listingUrls = Array.isArray(p.chimnie_listing_image_urls)
                    ? p.chimnie_listing_image_urls
                    : (p.chimnie_listing_image_url ? [p.chimnie_listing_image_url] : []);
                  const floorplanUrls = Array.isArray(p.chimnie_floorplan_image_urls)
                    ? p.chimnie_floorplan_image_urls
                    : (p.chimnie_floorplan_image_url ? [p.chimnie_floorplan_image_url] : []);
                  const displayListings = listingUrls.slice(0, 6);
                  const remainingListings = Math.max(0, imgCount - displayListings.length);

                  const buildThumb = (url, kind, isFirst) => {
                    const w = isFirst ? 120 : 72;
                    const h = isFirst ? 80 : 54;
                    const bg = kind === 'floorplan' ? 'background:#fff;' : '';
                    return '<a href="' + sanitizeHtml(url) + '" target="_blank" rel="noopener" style="text-decoration:none;flex-shrink:0;" title="Open ' + kind + ' in new tab">' +
                      '<img src="' + sanitizeHtml(url) + '" alt="' + kind + '" loading="lazy" style="width:' + w + 'px;height:' + h + 'px;object-fit:cover;border-radius:4px;border:1px solid rgba(96,165,250,0.2);display:block;' + bg + '" onerror="this.style.display=\'none\'">' +
                    '</a>';
                  };

                  const imageStrip = (displayListings.length > 0 || floorplanUrls.length > 0)
                    ? '<div style="display:flex;gap:6px;align-items:center;margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;overflow-x:auto;">' +
                        displayListings.map((url, i) => buildThumb(url, 'listing', i === 0)).join('') +
                        (remainingListings > 0
                          ? '<div style="flex-shrink:0;width:72px;height:54px;border-radius:4px;border:1px dashed rgba(96,165,250,0.3);display:flex;align-items:center;justify-content:center;color:#60A5FA;font-size:11px;font-weight:700;background:rgba(96,165,250,0.04);">+' + remainingListings + '</div>'
                          : '') +
                        (floorplanUrls.length > 0
                          ? '<div style="width:1px;height:54px;background:rgba(255,255,255,0.08);margin:0 4px;flex-shrink:0;"></div>' +
                            floorplanUrls.map(url => buildThumb(url, 'floorplan', false)).join('')
                          : '') +
                        '<div style="font-size:10px;color:#94A3B8;line-height:1.5;margin-left:auto;white-space:nowrap;padding-left:8px;">' +
                          (imgCount > 0 ? '<div><strong style="color:#F1F5F9;">' + imgCount + '</strong> photo' + (imgCount === 1 ? '' : 's') + '</div>' : '') +
                          (fpCount > 0 ? '<div><strong style="color:#F1F5F9;">' + fpCount + '</strong> floorplan' + (fpCount === 1 ? '' : 's') + '</div>' : '') +
                          '<div style="font-style:italic;margin-top:2px;font-size:9px;">click to open</div>' +
                        '</div>' +
                      '</div>'
                    : '';

                  // ── 5-year value sparkline (Tier 3 / structural) ──
                  // Inline SVG polyline from chimnie_historical_values_compact array.
                  // Shows trajectory SHAPE, not just the % change number. 80x20 px.
                  const sparklineSvg = (() => {
                    const vals = p.chimnie_historical_values_compact;
                    if (!Array.isArray(vals) || vals.length < 2) return '';
                    const w = 80, h = 20, pad = 1;
                    const min = Math.min(...vals), max = Math.max(...vals);
                    const range = (max - min) || 1;
                    const points = vals.map((v, i) => {
                      const x = pad + (i / (vals.length - 1)) * (w - 2 * pad);
                      const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
                      return x.toFixed(1) + ',' + y.toFixed(1);
                    }).join(' ');
                    // Colour based on first vs last: green = rising, red = falling, grey = flat
                    const change = vals[vals.length - 1] - vals[0];
                    const colour = Math.abs(change / vals[0]) < 0.01 ? '#94A3B8'
                                 : change > 0 ? '#34D399' : '#F87171';
                    return '<svg width="' + w + '" height="' + h + '" style="vertical-align:middle;margin-left:4px;" aria-label="5 year value trajectory">' +
                      '<polyline points="' + points + '" fill="none" stroke="' + colour + '" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
                    '</svg>';
                  })();

                  // Inline summary for the collapsed state — three highest-signal
                  // numbers so the RM can eyeball the property without expanding.
                  const summaryBits = [];
                  if (p.chimnie_avm_mid) summaryBits.push('\u00B7 ' + fmtMoney(p.chimnie_avm_mid));
                  if (p.chimnie_ptal) summaryBits.push('PTAL ' + p.chimnie_ptal);
                  if (floodLabel) summaryBits.push('Flood ' + floodLabel);
                  if (p.chimnie_overseas_ownership === true) summaryBits.push('\u26A0 Overseas');
                  const summaryText = summaryBits.join(' \u00B7 ');
                  // Inject the summary into the header's placeholder slot
                  const finalHeaderRow = headerRow.replace('__SUMMARY__', sanitizeHtml(summaryText));

                  return '<div id="chimnie-panel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(96,165,250,0.03);border:1px solid rgba(96,165,250,0.2);border-radius:6px;">' +
                    finalHeaderRow +
                    // Collapsible body — toggled by window._toggleChimniePanel
                    '<div id="chimnie-body-' + p.id + '" style="display:' + chimnieBodyDisplay + ';">' +
                      metaStrip +
                      relationshipsStrip +
                      imageStrip +
                      // Row 1 — valuation + risk
                      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:10px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('AVM', fmtMoney(p.chimnie_avm_mid) + sparklineSvg
                          + (avmRange ? '<div style="font-size:9px;color:#64748B;font-weight:400;margin-top:2px;">' + avmRange + '</div>' : '')
                          + (p.chimnie_avg_proximal_value ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">Area comps avg: ' + fmtMoney(p.chimnie_avg_proximal_value) + '</div>' : '')
                          + varianceBadge) +
                        kpi('Confidence', '<span style="color:' + confColor + ';">' + (p.chimnie_avm_confidence || '\u2014') + '</span>') +
                        kpi('Rental p.c.m.', fmtMoney(p.chimnie_rental_pcm)) +
                        kpi('Flood', '<span style="color:' + floodColor + ';">' + floodLabel + '</span><div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">R/S ' + fmtPct(floodRS) + ' \u00B7 SW ' + fmtPct(floodSW) + '</div>') +
                        kpi('Crime %ile', (() => {
                          if (p.chimnie_crime_percentile_total == null) return '\u2014';
                          const n = Math.round(Number(p.chimnie_crime_percentile_total));
                          // Proper English ordinal suffix: 1st, 2nd, 3rd, 4th, 11th-13th, etc.
                          const mod10 = n % 10, mod100 = n % 100;
                          const suffix = (mod100 >= 11 && mod100 <= 13) ? 'th'
                                       : mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
                          const colour = n >= 75 ? '#34D399' : n >= 40 ? '#FBBF24' : '#F87171';
                          return '<span style="color:' + colour + ';">' + n + suffix + '</span>';
                        })()) +
                      '</div>' +
                      // Row 2 — transaction history + legal
                      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Last Sale', fmtMoney(p.chimnie_last_sale_price)
                          + (p.chimnie_last_sale_date ? '<div style="font-size:9px;color:#64748B;font-weight:400;margin-top:2px;">' + new Date(p.chimnie_last_sale_date).toLocaleDateString('en-GB') + (p.chimnie_years_owned ? ' \u00B7 ' + p.chimnie_years_owned + 'y held' : '') + '</div>' : '')
                          + (p.chimnie_sale_propensity ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">Sale propensity: <span style="color:#F1F5F9;">' + sanitizeHtml(p.chimnie_sale_propensity) + '</span></div>' : '')) +
                        kpi('Tenure', sanitizeHtml(p.chimnie_lease_type || '\u2014')) +
                        kpi('Construction', sanitizeHtml((p.chimnie_construction_material || '\u2014') + (p.chimnie_date_of_construction ? ' \u00B7 ' + p.chimnie_date_of_construction : ''))) +
                        kpi('EPC', (() => {
                          const current = p.chimnie_epc_current;
                          const potential = p.chimnie_epc_potential;
                          const recs = p.chimnie_epc_recommendations;
                          const main = sanitizeHtml((current || '\u2014') + (potential ? ' \u2192 ' + potential : ''));
                          // Compact retrofit summary: "3 recs · £5,400 retrofit"
                          if (Array.isArray(recs) && recs.length > 0) {
                            const totalCost = recs.reduce((s, r) => {
                              const c = r?.cost ?? r?.indicative_cost ?? r?.cost_estimate ?? 0;
                              if (typeof c === 'number') return s + c;
                              if (typeof c === 'string') {
                                const m = c.match(/£?([\d,]+)/);
                                return m ? s + parseInt(m[1].replace(/,/g, ''), 10) : s;
                              }
                              return s;
                            }, 0);
                            const costStr = totalCost > 0 ? ' \u00B7 \u00A3' + totalCost.toLocaleString() : '';
                            return main + '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + recs.length + ' retrofit rec' + (recs.length === 1 ? '' : 's') + costStr + '</div>';
                          }
                          return main;
                        })()) +
                      '</div>' +
                      // Row 3 — physical attributes + bills + rebuild + PTAL (2026-04-21)
                      '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Type', sanitizeHtml(typeLabel) + typeDetail) +
                        kpi('Beds / Baths', bedsBaths) +
                        kpi('Floor Area', faDisplay) +
                        kpi('Council Tax', ctBand) +
                        kpi('Rebuild Cost', rebuildDisplay) +
                        kpi('Transit', transitDisplay) +
                      '</div>' +
                      flagsHtml +
                    '</div>' + // close chimnie-body
                  '</div>';
                })();

                // ═══ Area Intelligence panel (2026-04-21) ═══
                // Separate expandable panel for neighbourhood-level data: sales
                // market velocity, rental market, wealth percentiles, schools,
                // planning constraints, 5y value trajectory. Distinct from
                // Chimnie Intelligence which is property-specific.
                const areaHtml = (() => {
                  if (!isInternalUser) return '';
                  const fetched = p.chimnie_fetched_at;
                  if (!fetched) return ''; // Area data sits inside Chimnie response — no data until Chimnie fetched

                  // Collapse behaviour mirrors EPC + Chimnie
                  const areaCollapsed = !!fetched;  // 2026-04-30: collapse by default when data fetched
                  const areaBodyDisplay = areaCollapsed ? 'none' : 'block';
                  const areaSummaryDisplay = areaCollapsed ? 'inline' : 'none';
                  const areaChevronRotate = areaCollapsed ? '' : 'transform:rotate(90deg);';

                  // ── Helpers (colour coding + formatting) ──
                  const fmtInt = (n) => n != null && !isNaN(n) ? Math.round(Number(n)).toLocaleString() : '\u2014';
                  const fmtMoney = (n) => n != null && !isNaN(n) ? '\u00A3' + Math.round(Number(n)).toLocaleString() : '\u2014';
                  const fmtPct = (n, dp) => n != null && !isNaN(n) ? Number(n).toFixed(dp != null ? dp : 1) + '%' : '\u2014';
                  const ordinal = (n) => {
                    if (n == null) return '\u2014';
                    const r = Math.round(Number(n));
                    const mod10 = r % 10, mod100 = r % 100;
                    const suffix = (mod100 >= 11 && mod100 <= 13) ? 'th'
                                 : mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
                    return r + suffix;
                  };

                  // 2026-04-21: Postgres NUMERIC columns come back from pg as STRINGS
                  // to preserve precision. Coerce every one to Number before math / .toFixed.
                  // Use `?? null` pattern so explicit 0 and false survive correctly.
                  const _num = (v) => (v == null || v === '') ? null : (isNaN(Number(v)) ? null : Number(v));

                  // Market velocity colours
                  const daysSell = _num(p.chimnie_area_days_to_sell);
                  const daysSellColour = daysSell == null ? '#94A3B8'
                                       : daysSell < 60 ? '#34D399' : daysSell < 120 ? '#FBBF24' : '#F87171';
                  const daysRent = _num(p.chimnie_area_days_to_rent);
                  const daysRentColour = daysRent == null ? '#94A3B8'
                                       : daysRent < 21 ? '#34D399' : daysRent < 45 ? '#FBBF24' : '#F87171';
                  // 2026-04-21: Chimnie sales_yoy is an absolute COUNT delta (sales this
                  // 12m minus sales previous 12m), NOT a percentage. Compute the real
                  // percentage from that delta + current count for meaningful comparison.
                  const salesYoY = _num(p.chimnie_area_sales_yoy);
                  const salesCur = _num(p.chimnie_area_sales_12m);
                  // If we have both: previous_total = current - delta, so pct = delta / previous_total
                  const salesYoYPct = (salesYoY != null && salesCur != null && (salesCur - salesYoY) > 0)
                    ? (salesYoY / (salesCur - salesYoY)) * 100
                    : null;
                  const yoyColour = salesYoYPct == null ? '#94A3B8'
                                  : salesYoYPct > 0 ? '#34D399' : salesYoYPct > -10 ? '#FBBF24' : '#F87171';
                  const yoyArrow = salesYoYPct == null ? '' : salesYoYPct > 0 ? '\u25B2 ' : salesYoYPct < 0 ? '\u25BC ' : '\u2013 ';
                  const yoyDisplay = salesYoY == null ? '\u2014'
                                   : '<span style="color:' + yoyColour + ';">' + yoyArrow + (salesYoY > 0 ? '+' : '') + salesYoY + '</span>' +
                                     (salesYoYPct != null ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + (salesYoYPct > 0 ? '+' : '') + salesYoYPct.toFixed(1) + '% vs prev 12m</div>' : '');

                  // Wealth percentile — national
                  const wealthNat = _num(p.chimnie_wealth_pct_national);
                  const wealthColour = wealthNat == null ? '#94A3B8'
                                     : wealthNat >= 75 ? '#34D399' : wealthNat >= 40 ? '#FBBF24' : '#F87171';

                  // 5y value trajectory
                  const fiveY = _num(p.chimnie_5y_value_change_pct);
                  const fiveYColour = fiveY == null ? '#94A3B8'
                                    : fiveY > 0 ? '#34D399' : fiveY > -5 ? '#FBBF24' : '#F87171';
                  const fiveYArrow = fiveY == null ? '' : fiveY > 0 ? '\u25B2 ' : fiveY < 0 ? '\u25BC ' : '';

                  // Ofsted colour
                  const ofstedColour = (r) => {
                    const rl = (r || '').toLowerCase();
                    if (rl.includes('outstanding')) return '#34D399';
                    if (rl.includes('good')) return '#A3E635';
                    if (rl.includes('requires improvement')) return '#FBBF24';
                    if (rl.includes('inadequate') || rl.includes('serious')) return '#F87171';
                    return '#94A3B8';
                  };

                  // Price/sqft context — compare area avg to implied property £/sqft (AVM ÷ floor area)
                  const areaPricePerSqft = Number(p.chimnie_area_price_per_sqft) || null;
                  const propFloorAreaSqft = (Number(p.chimnie_floor_area_sqm) || 0) * 10.764;
                  const propPricePerSqft = (Number(p.chimnie_avm_mid) && propFloorAreaSqft > 0)
                    ? Number(p.chimnie_avm_mid) / propFloorAreaSqft : null;
                  let psfVariance = null;
                  let psfVarianceBadge = '';
                  if (areaPricePerSqft && propPricePerSqft) {
                    psfVariance = ((propPricePerSqft - areaPricePerSqft) / areaPricePerSqft) * 100;
                    const absV = Math.abs(psfVariance);
                    if (absV > 25) {
                      psfVarianceBadge = '<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:1px 6px;border-radius:3px;font-weight:700;margin-left:4px;">\u26A0 ' + (psfVariance > 0 ? '+' : '') + psfVariance.toFixed(0) + '% vs area</span>';
                    } else if (absV > 10) {
                      psfVarianceBadge = '<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.08);padding:1px 6px;border-radius:3px;font-weight:600;margin-left:4px;">\u00B1' + absV.toFixed(0) + '% vs area</span>';
                    }
                  }

                  // ── Row 5 builders (Tier 1+2 — climate / structural / health / noise) ──
                  // Subsidence forecast 2050 — climate-driven. Chimnie uses categorical strings.
                  const subs50 = p.chimnie_subsidence_risk_2050;
                  const subsColour = (() => {
                    const s = (subs50 || '').toLowerCase();
                    if (!s) return '#94A3B8';
                    if (s.includes('high')) return '#F87171';
                    if (s.includes('medium') || s.includes('moderate')) return '#FBBF24';
                    if (s.includes('low') || s.includes('negligible')) return '#34D399';
                    return '#94A3B8';
                  })();
                  const subsidenceCell = subs50
                    ? '<span style="color:' + subsColour + ';">' + sanitizeHtml(subs50) + '</span>' +
                      (p.chimnie_subsidence_risk_2080 ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">2080: ' + sanitizeHtml(p.chimnie_subsidence_risk_2080) + '</div>' : '')
                    : '\u2014';

                  // Tree hazard — value only meaningful when trees are close AND tall
                  const treeDist = _num(p.chimnie_closest_tree_distance_m);
                  const treeHeight = _num(p.chimnie_closest_tree_height_m);
                  const treeHazard = _num(p.chimnie_tree_hazard_index);
                  const treeColour = treeHazard == null ? '#94A3B8'
                                   : treeHazard > 1.0 ? '#F87171'
                                   : treeHazard > 0.3 ? '#FBBF24' : '#34D399';
                  const treeCell = (treeDist != null && treeDist > 0)
                    ? '<span style="color:' + treeColour + ';">' + treeDist.toFixed(0) + 'm away</span>' +
                      (treeHeight ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + treeHeight.toFixed(1) + 'm tall · idx ' + (treeHazard != null ? treeHazard.toFixed(2) : '\u2014') + '</div>' : '')
                    : '<span style="color:#34D399;font-weight:400;">None &lt; 10m</span>';

                  // Radon — show level of protection required if affected
                  const radonCell = p.chimnie_radon_affected === true
                    ? '<span style="color:#FBBF24;">Affected</span>' +
                      (p.chimnie_radon_protection_level ? '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + sanitizeHtml(p.chimnie_radon_protection_level) + '</div>' : '')
                    : p.chimnie_radon_affected === false
                      ? '<span style="color:#34D399;font-weight:400;">Clear</span>'
                      : '\u2014';

                  // Noise (road) — >65 dB starts to affect re-sale
                  const noiseRoad = _num(p.chimnie_noise_road_db);
                  const noiseColour = noiseRoad == null ? '#94A3B8'
                                    : noiseRoad > 65 ? '#F87171'
                                    : noiseRoad > 55 ? '#FBBF24' : '#34D399';
                  const noiseCell = noiseRoad != null
                    ? '<span style="color:' + noiseColour + ';">' + noiseRoad.toFixed(0) + ' dB</span>' +
                      '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">road · rail ' + (_num(p.chimnie_noise_rail_db) != null ? _num(p.chimnie_noise_rail_db).toFixed(0) + 'dB' : '\u2014') + '</div>'
                    : '\u2014';

                  // Elevation + distance from river/coast context
                  const elevMin = _num(p.chimnie_elevation_min_m);
                  const elevMax = _num(p.chimnie_elevation_max_m);
                  const distRiver = _num(p.chimnie_distance_from_river_m);
                  const distCoast = _num(p.chimnie_distance_from_coast_m);
                  const elevCell = (elevMin != null || distRiver != null)
                    ? (elevMin != null ? elevMin.toFixed(0) + (elevMax != null && Math.abs(elevMax - elevMin) > 0.5 ? '\u2013' + elevMax.toFixed(0) : '') + 'm ASL' : '\u2014') +
                      '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' +
                        (distRiver != null ? 'River ' + (distRiver < 1000 ? distRiver + 'm' : (distRiver / 1000).toFixed(1) + 'km') : '') +
                        (distCoast != null && distCoast < 50000 ? ' · Coast ' + (distCoast < 1000 ? distCoast + 'm' : (distCoast / 1000).toFixed(1) + 'km') : '') +
                      '</div>'
                    : '\u2014';

                  // ── Red-flag chips (area-level) ──
                  const areaFlags = [];
                  if (daysSell != null && daysSell > 120) areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Slow exit (' + daysSell + 'd)</span>');
                  if (daysRent != null && daysRent > 45) areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Slow re-let (' + daysRent + 'd)</span>');
                  if (salesYoYPct != null && salesYoYPct < -10) areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Declining market (' + salesYoYPct.toFixed(1) + '% YoY)</span>');
                  if (wealthNat != null && wealthNat < 30) areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Low-wealth area</span>');
                  if (p.chimnie_in_green_belt === true) areaFlags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Green belt</span>');
                  if (p.chimnie_in_aonb === true) areaFlags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">AONB</span>');
                  if (p.chimnie_in_ancient_woodland === true) areaFlags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Ancient woodland</span>');
                  if (p.chimnie_in_common_land === true) areaFlags.push('<span style="font-size:9px;color:#60A5FA;background:rgba(96,165,250,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Common land</span>');
                  if (p.chimnie_in_historic_parks === true) areaFlags.push('<span style="font-size:9px;color:#C9A227;background:rgba(201,162,39,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Historic park/garden</span>');
                  if (p.chimnie_near_historic_landfill === true) areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Historic landfill</span>');
                  if (p.chimnie_in_coal_mining_area === true) areaFlags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Coal mining area</span>');
                  if (p.chimnie_in_world_heritage === true) areaFlags.push('<span style="font-size:9px;color:#C9A227;background:rgba(201,162,39,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">UNESCO World Heritage</span>');
                  if (p.chimnie_sssi_affected === true) areaFlags.push('<span style="font-size:9px;color:#FBBF24;background:rgba(251,191,36,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">SSSI</span>');
                  if (p.chimnie_scheduled_monument_affected === true) areaFlags.push('<span style="font-size:9px;color:#C9A227;background:rgba(201,162,39,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">Scheduled monument</span>');
                  // Ofsted red flag — only when the nearest primary is poor
                  const nearestPrimaryOfsted = (p.chimnie_nearest_primary_ofsted || '').toLowerCase();
                  if (nearestPrimaryOfsted === 'inadequate' || nearestPrimaryOfsted === 'serious weaknesses') {
                    areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Poor local school</span>');
                  }
                  // Tree hazard flag — only when actually close and tall (hazard index > 1)
                  if (treeHazard != null && treeHazard > 1.0) {
                    areaFlags.push('<span style="font-size:9px;color:#F87171;background:rgba(248,113,113,0.12);padding:2px 7px;border-radius:3px;font-weight:700;">\u26A0 Subsidence-risk tree</span>');
                  }
                  const areaFlagsHtml = areaFlags.length > 0 ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + areaFlags.join('') + '</div>' : '';

                  // ── Inline summary (shown when collapsed) ──
                  const areaSummaryBits = [];
                  const laDisplay = p.local_authority || p.chimnie_local_authority;
                  if (laDisplay) areaSummaryBits.push(sanitizeHtml(laDisplay));
                  if (daysSell != null) areaSummaryBits.push(daysSell + 'd sell');
                  if (daysRent != null) areaSummaryBits.push(daysRent + 'd rent');
                  if (salesYoYPct != null) areaSummaryBits.push((salesYoYPct > 0 ? '+' : '') + salesYoYPct.toFixed(0) + '% YoY');
                  if (wealthNat != null) areaSummaryBits.push('Wealth ' + ordinal(wealthNat) + ' %ile');
                  const areaSummaryText = areaSummaryBits.join(' \u00B7 ');

                  // ── Kpi helper (reuse style from Chimnie panel) ──
                  const kpi = (label, value, extraStyle) => '<div><span style="font-size:9px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:2px;letter-spacing:.3px;">' + label + '</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;' + (extraStyle || '') + '">' + value + '</span></div>';

                  // Wealth percentiles — show all 3 tiers as a single cell value
                  const wealthCell = (() => {
                    const nat = p.chimnie_wealth_pct_national;
                    const la = p.chimnie_wealth_pct_local_authority;
                    const pd = p.chimnie_wealth_pct_postcode_district;
                    if (nat == null && la == null && pd == null) return '\u2014';
                    return '<span style="color:' + wealthColour + ';">Nat ' + ordinal(nat) + '</span>' +
                      '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' +
                        (la != null ? 'LA ' + ordinal(la) : '') +
                        (pd != null ? ' \u00B7 PC ' + ordinal(pd) : '') +
                      '</div>';
                  })();

                  // School cell helpers
                  const primaryCell = (() => {
                    if (!p.chimnie_nearest_primary_name && !p.chimnie_nearest_primary_distance_m) return '\u2014';
                    const dist = Number(p.chimnie_nearest_primary_distance_m);
                    const distLabel = dist ? (dist < 1000 ? dist + 'm' : (dist / 1000).toFixed(1) + 'km') : '';
                    const ofsted = p.chimnie_nearest_primary_ofsted;
                    return '<div style="font-size:11px;">' + sanitizeHtml(p.chimnie_nearest_primary_name || '\u2014') + '</div>' +
                      '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + distLabel +
                      (ofsted ? ' \u00B7 <span style="color:' + ofstedColour(ofsted) + ';font-weight:700;">' + sanitizeHtml(ofsted) + '</span>' : '') + '</div>';
                  })();
                  const secondaryCell = (() => {
                    if (!p.chimnie_best_secondary_name) return '\u2014';
                    const dist = Number(p.chimnie_best_secondary_distance_m);
                    const distLabel = dist ? (dist < 1000 ? dist + 'm' : (dist / 1000).toFixed(1) + 'km') : '';
                    const ofsted = p.chimnie_best_secondary_ofsted;
                    const att8 = p.chimnie_best_secondary_att8;
                    return '<div style="font-size:11px;">' + sanitizeHtml(p.chimnie_best_secondary_name || '\u2014') + '</div>' +
                      '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + distLabel +
                      (ofsted ? ' \u00B7 <span style="color:' + ofstedColour(ofsted) + ';font-weight:700;">' + sanitizeHtml(ofsted) + '</span>' : '') +
                      (att8 != null ? ' \u00B7 Att8 ' + Number(att8).toFixed(1) : '') +
                      '</div>';
                  })();

                  const headerRow = '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;cursor:pointer;" onclick="window._toggleAreaPanel(' + p.id + ')">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span id="area-chevron-' + p.id + '" style="display:inline-block;font-size:10px;color:#64748B;' + areaChevronRotate + 'transition:transform 0.15s;">\u25B6</span>' +
                      '<span style="font-size:10px;color:#C9A227;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'Area Intelligence</span>' +
                      '<span id="area-summary-' + p.id + '" style="display:' + areaSummaryDisplay + ';font-size:11px;color:#F1F5F9;margin-left:8px;font-weight:400;">\u00B7 ' + sanitizeHtml(areaSummaryText) + '</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;align-items:center;">' +
                      '<span style="font-size:9px;color:#64748B;">' + sanitizeHtml(p.chimnie_postcode_district || '') + (p.chimnie_is_urban === true ? ' \u00B7 Urban' : p.chimnie_is_urban === false ? ' \u00B7 Rural' : '') + '</span>' +
                    '</div>' +
                  '</div>';

                  return '<div id="area-panel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(201,162,39,0.03);border:1px solid rgba(201,162,39,0.22);border-radius:6px;">' +
                    headerRow +
                    '<div id="area-body-' + p.id + '" style="display:' + areaBodyDisplay + ';">' +
                      // Row 1 — Market velocity (sales + rental)
                      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:10px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Days to Sell', daysSell != null ? '<span style="color:' + daysSellColour + ';">' + daysSell + 'd</span>' : '\u2014') +
                        kpi('Days to Rent', daysRent != null ? '<span style="color:' + daysRentColour + ';">' + daysRent + 'd</span>' : '\u2014') +
                        kpi('Sales (12m)', fmtInt(p.chimnie_area_sales_12m)) +
                        kpi('Sales YoY', yoyDisplay) +
                        kpi('Avg Years Owned', p.chimnie_area_avg_years_owned != null ? Number(p.chimnie_area_avg_years_owned).toFixed(1) + 'y' : '\u2014') +
                      '</div>' +
                      // Row 2 — Pricing context + trajectory
                      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Area £/sqft', areaPricePerSqft ? '\u00A3' + Math.round(areaPricePerSqft).toLocaleString() : '\u2014') +
                        kpi('This Property £/sqft', propPricePerSqft ? '\u00A3' + Math.round(propPricePerSqft).toLocaleString() + psfVarianceBadge : '\u2014') +
                        kpi('5y Trajectory', fiveY != null ? '<span style="color:' + fiveYColour + ';">' + fiveYArrow + (fiveY > 0 ? '+' : '') + fiveY.toFixed(1) + '%</span>' : '\u2014') +
                        kpi('Local Authority', sanitizeHtml(p.local_authority || p.chimnie_local_authority || '\u2014')) +
                      '</div>' +
                      // Row 3 — Wealth + demographics
                      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Wealth %ile', wealthCell) +
                        kpi('Total HHI (MSOA)', fmtMoney(p.chimnie_total_hhi_msoa) + (p.chimnie_total_hhi_msoa ? '<span style="font-size:9px;color:#94A3B8;font-weight:400;"> /yr</span>' : '')) +
                        kpi('Disposable HHI', fmtMoney(p.chimnie_disposable_hhi_msoa) + (p.chimnie_disposable_hhi_msoa ? '<span style="font-size:9px;color:#94A3B8;font-weight:400;"> /yr</span>' : '')) +
                      '</div>' +
                      // Row 4 — Schools + nearest university (student-BTL context)
                      (() => {
                        const uniName = p.chimnie_nearest_university_name;
                        const uniDist = _num(p.chimnie_nearest_university_distance_m);
                        const uniCell = (uniName || uniDist != null)
                          ? '<div style="font-size:11px;">' + sanitizeHtml(uniName || '\u2014') + '</div>' +
                            '<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">' + (uniDist != null ? (uniDist < 1000 ? uniDist + 'm' : (uniDist / 1000).toFixed(1) + 'km') : '\u2014') + '</div>'
                          : '\u2014';
                        return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                          kpi('Nearest Primary', primaryCell) +
                          kpi('Best Secondary (within 5km)', secondaryCell) +
                          kpi('Nearest University', uniCell) +
                        '</div>';
                      })() +
                      // Row 5 — Climate / structural / health / noise (Tier 1+2)
                      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.02);border-radius:4px;">' +
                        kpi('Subsidence 2050', subsidenceCell) +
                        kpi('Tree Hazard', treeCell) +
                        kpi('Radon', radonCell) +
                        kpi('Noise (road)', noiseCell) +
                        kpi('Elevation / Water', elevCell) +
                      '</div>' +
                      areaFlagsHtml +
                    '</div>' + // close area-body
                  '</div>';
                })();

                // ═══ HMLR Title Register panel (2026-04-27) ═══
                // Inline expandable panel — admin-only (paid API). Shows last
                // pulled mode/timestamp/cost, with proprietors + charges +
                // restrictions tables when expanded.
                const hmlrHtml = (() => {
                  if (!isInternalUser) return '';
                  const pulled = p.hmlr_pulled_at;
                  const pulledMode = p.hmlr_pull_mode;
                  const pulledCost = p.hmlr_pulled_cost_pence;
                  const titleNum = p.hmlr_title_number || p.title_number || '';
                  const pullErr = p.hmlr_pull_error;
                  const tenure = p.hmlr_tenure;
                  const cls = p.hmlr_class_of_title;
                  const proprietors = Array.isArray(p.hmlr_proprietors_jsonb) ? p.hmlr_proprietors_jsonb
                                    : (p.hmlr_proprietors_jsonb && typeof p.hmlr_proprietors_jsonb === 'object'
                                         ? (p.hmlr_proprietors_jsonb.proprietors || [])
                                         : []);
                  const charges = Array.isArray(p.hmlr_charges_jsonb) ? p.hmlr_charges_jsonb
                                : (p.hmlr_charges_jsonb && typeof p.hmlr_charges_jsonb === 'object'
                                     ? (p.hmlr_charges_jsonb.charges || [])
                                     : []);
                  const restrictions = Array.isArray(p.hmlr_restrictions_jsonb) ? p.hmlr_restrictions_jsonb
                                     : (p.hmlr_restrictions_jsonb && typeof p.hmlr_restrictions_jsonb === 'object'
                                          ? (p.hmlr_restrictions_jsonb.restrictions || [])
                                          : []);

                  // Status colour: green (mock = no charge but data present), gold (live success),
                  // red (pull error), grey (never pulled).
                  let pillBg, pillFg, pillText;
                  if (pullErr) {
                    pillBg = 'rgba(248,113,113,0.15)'; pillFg = '#F87171'; pillText = 'Error';
                  } else if (pulled && pulledMode === 'live') {
                    pillBg = 'rgba(212,168,83,0.15)'; pillFg = '#D4A853';
                    pillText = 'LIVE \u00B7 \u00A3' + ((pulledCost || 0) / 100).toFixed(2);
                  } else if (pulled && pulledMode === 'test') {
                    pillBg = 'rgba(96,165,250,0.15)'; pillFg = '#60A5FA'; pillText = 'TEST';
                  } else if (pulled) {
                    pillBg = 'rgba(52,211,153,0.12)'; pillFg = '#34D399'; pillText = 'MOCK';
                  } else {
                    pillBg = 'rgba(148,163,184,0.10)'; pillFg = '#94A3B8'; pillText = 'Not pulled';
                  }

                  // Default open if just pulled or has error; collapsed otherwise (less noise)
                  const hmlrCollapsed = !!pulled;  // 2026-04-30: collapse by default when register pulled
                  const hmlrBodyDisplay = hmlrCollapsed ? 'none' : 'block';
                  const hmlrSummaryDisplay = hmlrCollapsed ? 'inline' : 'none';
                  const hmlrChevronRotate = hmlrCollapsed ? '' : 'transform:rotate(90deg);';

                  // Inline summary (when collapsed)
                  let summaryInline = '';
                  if (pulled) {
                    const bits = [];
                    if (titleNum) bits.push('<strong>' + sanitizeHtml(titleNum) + '</strong>');
                    if (tenure) bits.push(sanitizeHtml(tenure));
                    if (proprietors.length) bits.push(proprietors.length + ' proprietor' + (proprietors.length === 1 ? '' : 's'));
                    if (charges.length) bits.push(charges.length + ' charge' + (charges.length === 1 ? '' : 's'));
                    if (restrictions.length) bits.push(restrictions.length + ' restriction' + (restrictions.length === 1 ? '' : 's'));
                    summaryInline = bits.join(' \u00B7 ');
                  } else if (titleNum) {
                    summaryInline = 'Title ' + sanitizeHtml(titleNum) + ' \u2014 not yet pulled';
                  } else {
                    summaryInline = 'No title number on file';
                  }

                  // Header + action buttons
                  const headerRow = '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;cursor:pointer;" onclick="window._toggleHmlrPanel(' + p.id + ')">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span id="hmlr-chevron-' + p.id + '" style="display:inline-block;font-size:10px;color:#64748B;' + hmlrChevronRotate + 'transition:transform 0.15s;">\u25B6</span>' +
                      '<span style="font-size:10px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'HM Land Registry</span>' +
                      '<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:' + pillBg + ';color:' + pillFg + ';">' + pillText + '</span>' +
                      '<span id="hmlr-summary-' + p.id + '" style="display:' + hmlrSummaryDisplay + ';font-size:11px;color:#F1F5F9;margin-left:8px;font-weight:400;">' + summaryInline + '</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;align-items:center;">' +
                      (pulled ? '<span style="font-size:9px;color:#64748B;">Pulled ' + new Date(pulled).toLocaleDateString('en-GB') + ' · ' + (window._freshAge ? window._freshAge(pulled, null) : '') + '</span>' : '') +
                      (titleNum
                        ? '<button onclick="event.stopPropagation();window._hmlrPull(' + p.id + ', \'' + subId + '\', \'' + sanitizeHtml(titleNum).replace(/\'/g, '') + '\')" style="padding:3px 10px;background:' + (pulled ? 'rgba(167,139,250,0.12)' : '#A78BFA') + ';color:' + (pulled ? '#A78BFA' : '#111') + ';border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">' + (pulled ? 'Re-pull' : 'Pull OC1') + '</button>'
                        : '<button onclick="event.stopPropagation();window._hmlrSearch(' + p.id + ', \'' + subId + '\')" style="padding:3px 10px;background:#A78BFA;color:#111;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Search title</button>') +
                    '</div>' +
                  '</div>';

                  // Body — proprietors / charges / restrictions / error
                  let bodyInner = '';
                  if (pullErr) {
                    bodyInner = '<div style="margin-top:8px;padding:8px 10px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:4px;font-size:11px;color:#F87171;">' +
                      '<strong>HMLR pull error:</strong> ' + sanitizeHtml(pullErr) +
                    '</div>';
                  } else if (!pulled) {
                    bodyInner = '<div style="font-size:11px;color:#64748B;margin-top:6px;font-style:italic;">No HMLR data yet. ' +
                      (titleNum ? 'Click <strong>Pull OC1</strong> to fetch the official copy of register (proprietors, charges, restrictions, tenure).'
                                : 'No title number on file. Click <strong>Search title</strong> to find by postcode.') +
                    '</div>';
                  } else {
                    // Top row — title meta
                    const meta = [];
                    if (titleNum) meta.push('<span style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:2px;">Title No</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;">' + sanitizeHtml(titleNum) + '</span>');
                    if (tenure) meta.push('<span style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:2px;">Tenure</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;">' + sanitizeHtml(tenure) + '</span>');
                    if (cls) meta.push('<span style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:2px;">Class</span><span style="font-size:12px;color:#F1F5F9;font-weight:700;">' + sanitizeHtml(cls) + '</span>');
                    const metaRow = meta.length ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-top:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);">' + meta.map(m => '<div>' + m + '</div>').join('') + '</div>' : '';

                    // Proprietors
                    let propsHtml = '';
                    if (proprietors.length) {
                      propsHtml = '<div style="margin-top:8px;"><div style="font-size:9px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Registered Proprietors (' + proprietors.length + ')</div>' +
                        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
                          '<tbody>' +
                          proprietors.map(pr => {
                            const nm = pr.name || pr.proprietor_name || pr.proprietor || '\u2014';
                            const co = pr.company_number ? ' <span style="font-size:9px;color:#94A3B8;">(' + sanitizeHtml(pr.company_number) + ')</span>' : '';
                            const addr = pr.address || pr.proprietor_address || '';
                            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.03);"><td style="padding:4px 6px;color:#F1F5F9;font-weight:600;vertical-align:top;width:40%;">' + sanitizeHtml(nm) + co + '</td>' +
                              '<td style="padding:4px 6px;color:#94A3B8;font-size:10px;">' + sanitizeHtml(addr) + '</td></tr>';
                          }).join('') +
                          '</tbody>' +
                        '</table></div>';
                    }

                    // Charges
                    let chargesHtml = '';
                    if (charges.length) {
                      chargesHtml = '<div style="margin-top:8px;"><div style="font-size:9px;color:#F87171;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Existing Charges (' + charges.length + ')</div>' +
                        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
                          '<tbody>' +
                          charges.map(c => {
                            const lender = c.chargee || c.lender || c.in_favour_of || '\u2014';
                            const dated = c.date || c.charge_date || '';
                            const detail = c.particulars || c.detail || c.notes || '';
                            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.03);"><td style="padding:4px 6px;color:#F1F5F9;font-weight:600;vertical-align:top;width:35%;">' + sanitizeHtml(lender) + '</td>' +
                              '<td style="padding:4px 6px;color:#94A3B8;font-size:10px;">' + sanitizeHtml(detail) + (dated ? ' <span style="color:#64748B;">(' + sanitizeHtml(dated) + ')</span>' : '') + '</td></tr>';
                          }).join('') +
                          '</tbody>' +
                        '</table></div>';
                    }

                    // Restrictions
                    let restrHtml = '';
                    if (restrictions.length) {
                      restrHtml = '<div style="margin-top:8px;"><div style="font-size:9px;color:#FBBF24;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Restrictions (' + restrictions.length + ')</div>' +
                        '<ul style="margin:0;padding:0 0 0 18px;font-size:11px;color:#CBD5E1;">' +
                          restrictions.map(r => {
                            const txt = (typeof r === 'string') ? r : (r.text || r.particulars || r.detail || JSON.stringify(r));
                            return '<li style="margin-bottom:3px;">' + sanitizeHtml(txt) + '</li>';
                          }).join('') +
                        '</ul></div>';
                    }

                    // Empty-state if pulled but nothing found
                    if (!proprietors.length && !charges.length && !restrictions.length) {
                      bodyInner = metaRow + '<div style="font-size:11px;color:#64748B;margin-top:6px;font-style:italic;">No proprietors, charges or restrictions in the returned record.</div>';
                    } else {
                      bodyInner = metaRow + propsHtml + chargesHtml + restrHtml;
                    }

                    // PDF link
                    if (p.hmlr_register_pdf_url) {
                      bodyInner += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);"><a href="' + sanitizeHtml(p.hmlr_register_pdf_url) + '" target="_blank" rel="noopener" style="font-size:11px;color:#A78BFA;font-weight:600;text-decoration:none;">\u2197 View official register PDF</a></div>';
                    }
                  }

                  return '<div id="hmlr-panel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(167,139,250,0.03);border:1px solid rgba(167,139,250,0.2);border-radius:6px;">' +
                    headerRow +
                    '<div id="hmlr-body-' + p.id + '" style="display:' + hmlrBodyDisplay + ';">' +
                      bodyInner +
                    '</div>' +
                  '</div>';
                })();

                const _propIntelStack = '<div id="prop-intel-' + p.id + '" style="margin-top:8px;padding:10px 12px;background:rgba(52,211,153,0.03);border:1px solid ' + borderColor + ';border-radius:6px;">' +
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

                // Sprint 2 #14 — TABBED property card.
                // Replaces 5 stacked panels with one tab strip + active pane.
                // Default tab = Property Intel (matches prior default-open behaviour).
                const _propIntelHtml = _propIntelStack;
                const _intelOk = !!p.property_searched_at;
                const _chimOk = !!p.chimnie_uprn;
                const _areaOk = !!p.chimnie_local_authority;
                const _hmlrOk = !!(p.hmlr_title_number || p.hmlr_searched_at);
                const _pdOk = !!p.pd_pulled_at;

                // ─── Rental tab content (PD-3, 2026-04-29) ───────────────────
                // FRESH-GATE follow-up (2026-04-29): added collapse/expand to match
                // Chimnie/HMLR panels — chevron + inline summary when collapsed.
                const rentalHtml = (() => {
                  if (!isInternalUser) return '';
                  const fmtMoney = (n) => n != null && !isNaN(n) ? '£' + Math.round(Number(n)).toLocaleString() : '—';
                  const fmtPct = (n) => n != null && !isNaN(n) ? Number(n).toFixed(2) + '%' : '—';
                  // Convert PCM to weekly using industry-standard 12/52 factor
                  const pcmToPw = (pcm) => pcm != null && !isNaN(pcm) ? Math.round(Number(pcm) * 12 / 52) : null;
                  const stated = p.market_rent_pcm ?? p.chimnie_rental_pcm ?? null;
                  const aA = p.pd_rental_pcm_asking_avg, aMin = p.pd_rental_pcm_asking_min, aMax = p.pd_rental_pcm_asking_max;
                  const eA = p.pd_rental_pcm_achieved_avg, eMin = p.pd_rental_pcm_achieved_min, eMax = p.pd_rental_pcm_achieved_max;
                  const yld = p.pd_rental_yield_gross_pct;
                  const sample = p.pd_sample_size;
                  const beds = p.pd_beds_filter || p.chimnie_bedrooms || null;

                  // Collapsed by default once data is pulled — RM clicks chevron to expand.
                  // Same pattern as Chimnie + HMLR for visual consistency.
                  const rentalCollapsed = !!p.pd_pulled_at;
                  const rentalBodyDisplay = rentalCollapsed ? 'none' : 'block';
                  const rentalSummaryDisplay = rentalCollapsed ? 'inline' : 'none';
                  const rentalChevronRotate = rentalCollapsed ? '' : 'transform:rotate(90deg);';

                  // Build inline summary — shown when collapsed. Includes stated rent,
                  // gap vs market, and yield. Colours match the deal-position rule.
                  let summaryInline = '';
                  if (p.pd_pulled_at) {
                    const bits = [];
                    if (stated) bits.push('<strong>' + fmtMoney(stated) + '</strong> pcm');
                    if (stated && eA) {
                      const delta = stated - eA;
                      const pct = ((delta / eA) * 100).toFixed(1);
                      const positionColour = delta < -eA*0.10 ? '#F87171' : (delta < 0 ? '#FBBF24' : '#34D399');
                      const tag = delta < -eA*0.10 ? 'BELOW market' : delta < 0 ? 'slightly below' : delta < eA*0.10 ? 'at market' : 'above market';
                      bits.push('<span style="color:' + positionColour + ';">' + (delta >= 0 ? '+' : '') + pct + '% ' + tag + '</span>');
                    } else if (eA) {
                      bits.push('market <strong>' + fmtMoney(eA) + '</strong> pcm');
                    }
                    if (yld != null) bits.push('<strong>' + fmtPct(yld) + '</strong> yield');
                    summaryInline = bits.join(' · ');
                  } else {
                    summaryInline = 'No PropertyData yet';
                  }

                  const headerRow = '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;cursor:pointer;" onclick="window._toggleRentalPanel(' + p.id + ')">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span id="rental-chevron-' + p.id + '" style="display:inline-block;font-size:10px;color:#64748B;' + rentalChevronRotate + 'transition:transform 0.15s;">▶</span>' +
                      '<span style="font-size:10px;color:#FB7185;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">' + propLabel + 'Rental Intelligence (PropertyData)</span>' +
                      (sample ? '<span style="font-size:9px;color:#94A3B8;">' + sample + ' lettings</span>' : '') +
                      '<span id="rental-summary-' + p.id + '" style="display:' + rentalSummaryDisplay + ';font-size:11px;color:#F1F5F9;margin-left:8px;font-weight:400;">' + summaryInline + '</span>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;align-items:center;">' +
                      (p.pd_pulled_at ? '<span style="font-size:9px;color:#64748B;">Fetched ' + new Date(p.pd_pulled_at).toLocaleDateString('en-GB') + ' · ' + (window._freshAge ? window._freshAge(p.pd_pulled_at, 30) : '') + '</span>' : '') +
                      '<button onclick="event.stopPropagation();window._propertyDataPull(' + p.id + ', \'' + subId + '\')" style="padding:3px 10px;background:' + (p.pd_pulled_at ? 'rgba(251,113,133,0.12)' : '#FB7185') + ';color:' + (p.pd_pulled_at ? '#FB7185' : '#111') + ';border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">' + (p.pd_pulled_at ? 'Refresh' : 'Pull rental data') + '</button>' +
                    '</div>' +
                  '</div>';

                  if (!p.pd_pulled_at) {
                    return headerRow + '<div id="rental-body-' + p.id + '" style="display:block;"><div style="font-size:11px;color:#64748B;margin-top:6px;font-style:italic;">No PropertyData yet. Click Pull to fetch postcode rental benchmarks (asking + achieved + yield + comparables).</div></div>';
                  }

                  // Deal-vs-market gap
                  let gapHtml = '';
                  if (stated && eA) {
                    const delta = stated - eA;
                    const pct = ((delta / eA) * 100).toFixed(1);
                    const positionColour = delta < -eA*0.10 ? '#F87171' : (delta < 0 ? '#FBBF24' : '#34D399');
                    const label = delta < -eA*0.10 ? 'BELOW market — likely sitting tenant or below-market deal'
                               : delta < 0 ? 'Slightly below market median'
                               : delta < eA*0.10 ? 'At market median'
                               : 'Above market median (premium tenancy)';
                    gapHtml = '<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;">' +
                      '<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:4px;">Deal Position</div>' +
                      '<div style="display:flex;justify-content:space-between;font-size:12px;color:#F1F5F9;flex-wrap:wrap;gap:6px;">' +
                        '<span>Stated rent: <strong>' + fmtMoney(stated) + '</strong> pcm <span style="color:#94A3B8;font-size:11px;">(' + fmtMoney(pcmToPw(stated)) + ' pw)</span></span>' +
                        '<span>vs market median achieved: <strong>' + fmtMoney(eA) + '</strong> pcm <span style="color:#94A3B8;font-size:11px;">(' + fmtMoney(pcmToPw(eA)) + ' pw)</span></span>' +
                        '<span style="color:' + positionColour + ';">' + (delta >= 0 ? '+' : '') + fmtMoney(Math.abs(delta)) + ' (' + (delta >= 0 ? '+' : '') + pct + '%)</span>' +
                      '</div>' +
                      '<div style="font-size:11px;color:' + positionColour + ';margin-top:4px;font-style:italic;">' + label + '</div>' +
                    '</div>';
                  }

                  // Market benchmarks grid — show both PCM and PW for each value
                  const benchHtml = '<div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
                    '<div style="padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;">' +
                      '<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Asking rent</div>' +
                      '<div style="font-size:14px;color:#F1F5F9;font-weight:600;margin-top:2px;">' + fmtMoney(aA) + ' <span style="font-size:10px;color:#94A3B8;font-weight:400;">pcm</span> · ' + fmtMoney(pcmToPw(aA)) + ' <span style="font-size:10px;color:#94A3B8;font-weight:400;">pw</span> <span style="font-size:10px;color:#94A3B8;font-weight:400;">median</span></div>' +
                      '<div style="font-size:10px;color:#94A3B8;margin-top:2px;">range pcm: ' + fmtMoney(aMin) + '-' + fmtMoney(aMax) + ' · pw: ' + fmtMoney(pcmToPw(aMin)) + '-' + fmtMoney(pcmToPw(aMax)) + '</div>' +
                    '</div>' +
                    '<div style="padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;">' +
                      '<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Achieved rent (est)</div>' +
                      '<div style="font-size:14px;color:#F1F5F9;font-weight:600;margin-top:2px;">' + fmtMoney(eA) + ' <span style="font-size:10px;color:#94A3B8;font-weight:400;">pcm</span> · ' + fmtMoney(pcmToPw(eA)) + ' <span style="font-size:10px;color:#94A3B8;font-weight:400;">pw</span> <span style="font-size:10px;color:#94A3B8;font-weight:400;">median</span></div>' +
                      '<div style="font-size:10px;color:#94A3B8;margin-top:2px;">range pcm: ' + fmtMoney(eMin) + '-' + fmtMoney(eMax) + ' · pw: ' + fmtMoney(pcmToPw(eMin)) + '-' + fmtMoney(pcmToPw(eMax)) + '</div>' +
                    '</div>' +
                  '</div>';

                  // Yield + meta
                  const yieldHtml = '<div style="margin-top:8px;display:flex;gap:12px;font-size:11px;color:#94A3B8;flex-wrap:wrap;">' +
                    (yld != null ? '<span>Gross yield: <strong style="color:#F1F5F9;">' + fmtPct(yld) + '</strong></span>' : '') +
                    (beds ? '<span>Filter: <strong style="color:#F1F5F9;">' + beds + '-bed</strong></span>' : '') +
                    (sample ? '<span>Sample: <strong style="color:#F1F5F9;">' + sample + ' lettings</strong> (90d)</span>' : '') +
                    (p.chimnie_rental_pcm ? '<span>Chimnie estimate: <strong style="color:#60A5FA;">' + fmtMoney(p.chimnie_rental_pcm) + '</strong> pcm</span>' : '') +
                  '</div>';

                  return headerRow + '<div id="rental-body-' + p.id + '" style="display:' + rentalBodyDisplay + ';">' + gapHtml + benchHtml + yieldHtml + '</div>';
                })();
                const _tabBadge = (ok) => ok
                  ? '<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(52,211,153,0.15);color:#34D399;font-weight:700;">✓</span>'
                  : '<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(100,116,139,0.12);color:#64748B;font-weight:700;">—</span>';
                const _mkTab = (key, label, color, ok, isDefault) =>
                  '<div data-prop-tab="' + p.id + '" data-tab-name="' + key + '" data-tab-color="' + color + '" ' +
                  'onclick="window._togglePropTab(' + p.id + ', \'' + key + '\')" ' +
                  'style="padding:8px 14px;font-size:11px;font-weight:500;cursor:pointer;color:' + (isDefault ? color : '#94A3B8') + ';border-bottom:2px solid ' + (isDefault ? color : 'transparent') + ';display:flex;gap:5px;align-items:center;white-space:nowrap;transition:color .15s;">' +
                    label + _tabBadge(ok) +
                  '</div>';
                const _tabStripHtml =
                  '<div id="prop-tabstrip-' + p.id + '" style="display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,0.06);margin-top:10px;background:rgba(255,255,255,0.02);border-radius:6px 6px 0 0;overflow-x:auto;">' +
                    _mkTab('intel',   'Property',  '#34D399', _intelOk, true)  +
                    _mkTab('chimnie', 'Chimnie',   '#60A5FA', _chimOk,  false) +
                    _mkTab('area',    'Area',      '#FBBF24', _areaOk,  false) +
                    _mkTab('rental',  'Rental',    '#FB7185', _pdOk,    false) +
                    _mkTab('hmlr',    'HMLR',      '#A78BFA', _hmlrOk,  false) +
                    _mkTab('rics',    'RICS Val',  '#D4A853', false,    false) +
                  '</div>';
                const _wrapPane = (key, contentHtml, isDefault) =>
                  '<div id="prop-tab-pane-' + p.id + '-' + key + '" data-prop-tab-pane="' + p.id + '" ' +
                  'style="display:' + (isDefault ? 'block' : 'none') + ';padding:0;">' +
                    contentHtml +
                  '</div>';
                const _ricsSlimHtml = (typeof window._buildValuationsPanel === 'function')
                  ? window._buildValuationsPanel(p, deal) : '';

                return _tabStripHtml +
                  '<div id="prop-tab-panes-' + p.id + '" style="border:1px solid rgba(255,255,255,0.04);border-top:none;border-radius:0 0 6px 6px;padding:10px;background:rgba(255,255,255,0.01);">' +
                    _wrapPane('intel',   _propIntelHtml, true)  +
                    _wrapPane('chimnie', chimnieHtml,    false) +
                    _wrapPane('area',    areaHtml,       false) +
                    _wrapPane('rental',  rentalHtml,     false) +
                    _wrapPane('hmlr',    hmlrHtml,       false) +
                    _wrapPane('rics',    _ricsSlimHtml,  false) +
                  '</div>';
              }).map((_html, _i) => {
                // Sprint 2 #14 Simplified C — wrap each property's panels in an
                // expand-div. 2026-04-30: defaults to display:block (was display:none
                // but the toggle function _togglePropertyExpand never existed, so the
                // panel was permanently hidden — "vaporised" bug). Row chevron click
                // now calls _togglePropertyExpand to collapse/expand the whole panel.
                const _pid = deal.properties[_i] && deal.properties[_i].id;
                return '<div id="prop-expand-' + _pid + '" data-prop-expand="' + _pid + '" style="display:block;">' + _html + '</div>';
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

              <!-- Sprint 2 #11 — RICS Valuations per property (lifted from per-property card) -->
              ${isInternalUser ? `
                <div style="margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,0.1);">
                  <div style="font-size:10px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">📋 RICS Valuations (per property)</div>
                  <div style="font-size:11px;color:#94A3B8;margin-bottom:8px;font-style:italic;">Add or edit a RICS valuation for each security property. Lending value here is the LTV anchor for the rubric. 6-month drawdown gate applies.</div>
                  ${(typeof window._buildValuationsMatrixRow === 'function')
                    ? window._buildValuationsMatrixRow(deal)
                    : '<div style="font-size:11px;color:#F87171;">Valuations module not loaded. Refresh the page.</div>'}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ═══════════════════════════════════════════════════════════════════
  // SECTION sg: SECURITY & GUARANTEE STRUCTURE (G5.3.1 — read-only render)
  // Inserted between s3 (Property/Security) and s4 (Loan Terms) per user design.
  // Editable dropdowns + save handlers arrive in G5.3.2.
  // ═══════════════════════════════════════════════════════════════════
  {
    const chargeLabelMap = {
      'first_charge': 'First Legal Charge',
      'second_charge': 'Second Charge',
      'third_charge': 'Third Charge',
      'no_charge': 'No Charge'
    };
    const pgLabelMap = {
      'required': { label: 'Required', bg: 'rgba(34,197,94,0.15)', fg: '#34D399' },
      'waived':   { label: 'Waived',   bg: 'rgba(148,163,184,0.15)', fg: '#94A3B8' },
      'limited':  { label: 'Limited',  bg: 'rgba(251,191,36,0.15)', fg: '#FBBF24' }
    };
    const sgProperties = deal.properties || [];
    const sgBorrowersRaw = deal.borrowers || [];

    // Mirror the backend's groupBorrowersForDip() synthesis: if no row has role='primary'
    // but deal.borrower_company is set (legacy), synthesize a primary corp + UBO officer.
    const sgBorrowers = sgBorrowersRaw.slice();
    const sgHasPrimary = sgBorrowers.some(r => r.role === 'primary' && !r.parent_borrower_id);
    if (!sgHasPrimary && deal && (deal.borrower_company || deal.borrower_name)) {
      const isLegacyCorp = !!(deal.borrower_company || deal.company_number);
      const syntheticPrimaryId = 'legacy-primary-' + (deal.id || 'x');
      sgBorrowers.unshift({
        id: syntheticPrimaryId,
        role: 'primary',
        parent_borrower_id: null,
        full_name: deal.borrower_company || deal.borrower_name,
        borrower_type: isLegacyCorp ? 'corporate' : 'individual',
        company_number: deal.company_number || null,
        nationality: deal.borrower_nationality || null,
        ch_verified_at: null
      });
      if (isLegacyCorp && deal.borrower_name && deal.borrower_name !== deal.borrower_company) {
        sgBorrowers.push({
          id: 'legacy-ubo-' + (deal.id || 'x'),
          role: 'psc',
          parent_borrower_id: syntheticPrimaryId,
          full_name: deal.borrower_name,
          borrower_type: 'individual',
          nationality: deal.borrower_nationality || null,
          ch_match_data: { is_psc: true, officer_role: 'Ultimate Beneficial Owner' }
        });
      }
    }

    const sgCorpBorrowers = sgBorrowers.filter(b => !b.parent_borrower_id && (b.role === 'primary' || b.role === 'joint') && (b.borrower_type || '').toLowerCase() !== 'individual');
    const sgCorpGuarantors = sgBorrowers.filter(b => !b.parent_borrower_id && b.role === 'guarantor' && (b.borrower_type || '').toLowerCase() === 'corporate');
    const sgOfficersByParent = {};
    sgBorrowers.forEach(b => { if (b.parent_borrower_id) { sgOfficersByParent[b.parent_borrower_id] = sgOfficersByParent[b.parent_borrower_id] || []; sgOfficersByParent[b.parent_borrower_id].push(b); } });
    const sgIndividualGuarantors = sgBorrowers.filter(b => !b.parent_borrower_id && b.role === 'guarantor' && (b.borrower_type || '').toLowerCase() !== 'corporate');

    html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('sg', '🛡', 'Security & Guarantee Structure', 'Charges, corporate debentures, personal guarantees', [
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-sg" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <div style="padding:16px 24px 20px;background:#111827;">

          <!-- Charge over Property -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:4px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Charge over Property</div>
          ${sgProperties.length === 0 ? `<div style="padding:10px;color:#64748B;font-size:12px;font-style:italic;">No properties yet — add in the Property / Security section above.</div>` : `
            <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.4px;display:grid;grid-template-columns:32px 1fr 130px 160px 130px 1fr;gap:10px;padding:4px 0;font-weight:700;">
              <div>#</div><div>Property</div><div>Purpose</div><div>Charge Type</div><div>Existing balance</div><div>Encumbrance notes</div>
            </div>
            ${sgProperties.map((p, i) => {
              const balanceVal = p.existing_charge_balance_pence != null
                ? (Number(p.existing_charge_balance_pence) / 100).toFixed(0)
                : '';
              // HMLR-aware placeholders so RM knows whether the field is auto-fed
              // (HMLR has been pulled and we have structured charge data) or
              // manual (HMLR pending — RM types from broker pack).
              const hmlrPulled = !!p.hmlr_pulled_at;
              const hmlrChargesArr = Array.isArray(p.hmlr_charges_jsonb)
                ? p.hmlr_charges_jsonb
                : (p.hmlr_charges_jsonb && p.hmlr_charges_jsonb.charges) || [];
              const hmlrChargeCount = hmlrChargesArr.length;
              const balancePlaceholder = hmlrPulled
                ? (hmlrChargeCount > 0 ? `HMLR: ${hmlrChargeCount} charge${hmlrChargeCount === 1 ? '' : 's'} · enter £`
                                       : 'HMLR clean')
                : '⏳ HMLR pending';
              const notesPlaceholder = hmlrPulled
                ? (hmlrChargeCount > 0 ? `${hmlrChargeCount} charge${hmlrChargeCount === 1 ? '' : 's'} on HMLR · add ERC, restrictions…`
                                       : 'HMLR clean · add notes if needed')
                : '⏳ HMLR pending — note existing charges';
              return `<div style="display:grid;grid-template-columns:32px 1fr 130px 160px 130px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid #2d3748;align-items:center;">
                <div style="background:#374151;color:#D4A853;font-weight:700;font-size:11px;padding:3px 8px;border-radius:3px;text-align:center;">${i + 1}</div>
                <div><div style="font-weight:600;color:#E5E7EB;font-size:12px;">${sanitizeHtml(p.address || 'Address pending')}</div><div style="color:#94A3B8;font-size:10.5px;">${sanitizeHtml(p.postcode || '')}</div></div>
                <div>
                  <select id="sg-purpose-${p.id}" onchange="window.sgSavePropertyPurpose && window.sgSavePropertyPurpose('${deal.submission_id}', ${p.id}, this.value)"
                    style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;"
                    ${!canEdit ? 'disabled' : ''}>
                    <option value="" ${!p.loan_purpose ? 'selected' : ''}>— select —</option>
                    <option value="acquisition" ${p.loan_purpose === 'acquisition' ? 'selected' : ''}>Acquisition</option>
                    <option value="refinance" ${p.loan_purpose === 'refinance' ? 'selected' : ''}>Refinance</option>
                    <option value="equity_release" ${p.loan_purpose === 'equity_release' ? 'selected' : ''}>Equity release</option>
                  </select>
                </div>
                <div>
                  <select id="sg-charge-${p.id}" onchange="window.sgSavePropertyCharge && window.sgSavePropertyCharge('${deal.submission_id}', ${p.id}, this.value)"
                    style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;"
                    ${!canEdit ? 'disabled' : ''}>
                    <option value="first_charge" ${(p.security_charge_type || 'first_charge') === 'first_charge' ? 'selected' : ''}>First Legal Charge</option>
                    <option value="second_charge" ${p.security_charge_type === 'second_charge' ? 'selected' : ''}>Second Charge</option>
                    <option value="third_charge" ${p.security_charge_type === 'third_charge' ? 'selected' : ''}>Third Charge</option>
                    <option value="no_charge" ${p.security_charge_type === 'no_charge' ? 'selected' : ''}>No Charge</option>
                  </select>
                </div>
                <div>
                  <input type="number" id="sg-balance-${p.id}" value="${balanceVal}" min="0" step="1000"
                    placeholder="${sanitizeHtml(balancePlaceholder)}"
                    onblur="window.sgSavePropertyBalance && window.sgSavePropertyBalance('${deal.submission_id}', ${p.id}, this.value)"
                    style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;"
                    ${!canEdit ? 'disabled' : ''}/>
                </div>
                <div>
                  <input type="text" id="sg-encum-${p.id}" value="${sanitizeHtml(p.existing_charges_note || '')}"
                    placeholder="${sanitizeHtml(notesPlaceholder)}"
                    onblur="window.sgSavePropertyEncumbrance && window.sgSavePropertyEncumbrance('${deal.submission_id}', ${p.id}, this.value)"
                    style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;"
                    ${!canEdit ? 'disabled' : ''}/>
                </div>
              </div>`;
            }).join('')}
          `}

          <!-- XCOLL-2 (2026-04-29): Effective LTV + cross-collateral summary -->
          <div id="xcoll-summary-host">${(window._renderXcollSummary || (() => ''))(deal, sgProperties)}</div>

          <!-- Corporate Borrower Security -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:20px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Corporate Borrower Security</div>
          ${sgCorpBorrowers.length === 0 ? `<div style="padding:10px;color:#64748B;font-size:12px;font-style:italic;">No corporate borrowers yet.</div>` : sgCorpBorrowers.map(c => `
            <div style="background:rgba(30,58,138,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:6px;padding:12px 14px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                <div>
                  <div style="color:#DBEAFE;font-weight:700;font-size:13px;">${sanitizeHtml(c.full_name || c.company_name || '—')}</div>
                  <div style="color:#94A3B8;font-size:10.5px;margin-top:2px;">${c.company_number ? 'Co. No: ' + sanitizeHtml(c.company_number) : ''}${c.ch_verified_at ? ' · <span style="color:#34D399;">✓ CH Verified</span>' : ''}</div>
                </div>
                <div style="text-align:right;font-size:11px;min-width:240px;">
                  <div style="margin-bottom:4px;"><span style="color:#94A3B8;font-size:10px;">Fixed &amp; Floating (Debenture):</span> <span style="padding:2px 8px;border-radius:3px;background:rgba(34,197,94,0.15);color:#34D399;font-size:10px;font-weight:700;margin-left:4px;">Required (default)</span></div>
                  <div><span style="color:#94A3B8;font-size:10px;">Share Charge:</span> <span style="padding:2px 8px;border-radius:3px;background:rgba(251,191,36,0.15);color:#FBBF24;font-size:10px;font-weight:700;margin-left:4px;">${deal.requires_share_charge === 'required' ? 'Required' : deal.requires_share_charge === 'not_required' ? 'Not Required' : 'RM to elect'}</span></div>
                </div>
              </div>
              <div style="margin-top:10px;font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Existing Companies House Charges</div>
              <div id="sg-charges-${c.id}" data-company-number="${sanitizeHtml(c.company_number || '')}" style="font-size:11px;padding:6px 0;color:#64748B;font-style:italic;">${c.company_number ? '\u23F3 Loading from Companies House\u2026' : 'No company number — cannot check CH charges'}</div>
            </div>
          `).join('')}

          <!-- Corporate Guarantee (if applicable) -->
          ${sgCorpGuarantors.length > 0 ? `
            <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:20px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Corporate Guarantee</div>
            ${sgCorpGuarantors.map(c => {
              // Inline date formatter — fmtDate is scoped to other render fns, not in this template's scope
              const _sgFmtDate = (v) => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
              const cChm = c.ch_match_data || {};
              const electedFromName = cChm.elected_from_name || null;
              const electedFromRole = cChm.elected_from_role || null;
              const electedAtIso = cChm.elected_at || null;
              const crossBorder = cChm.broker_trace_required === true;
              const roleDisplay = electedFromRole ? String(electedFromRole).toUpperCase() : null;
              const electedLine = electedFromName
                ? `<div style="color:#A78BFA;font-size:10px;margin-top:4px;font-weight:600;">\u2696 Elected from <strong>${sanitizeHtml(electedFromName)}</strong>${roleDisplay ? ` <span style="color:#94A3B8;font-weight:400;">(was: ${sanitizeHtml(roleDisplay)})</span>` : ''}${electedAtIso ? ` <span style="color:#64748B;font-weight:400;">\u00B7 ${_sgFmtDate(electedAtIso)}</span>` : ''}</div>`
                : '';
              const crossBorderPill = crossBorder
                ? `<div style="margin-top:6px;padding:5px 8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:4px;font-size:10px;color:#FBBF24;line-height:1.4;">\u26A0 Cross-border entity \u2014 foreign legal opinion / local counsel likely required for this guarantee</div>`
                : '';
              return `<div style="background:rgba(15,118,110,0.12);border:1px solid rgba(20,184,166,0.3);border-radius:6px;padding:12px 14px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <div style="color:#A7F3D0;font-weight:700;font-size:13px;">${sanitizeHtml(c.full_name || '—')}</div>
                    <div style="color:#94A3B8;font-size:10.5px;margin-top:2px;">${c.company_number ? 'Co. No: ' + sanitizeHtml(c.company_number) : ''}${c.ch_verified_at ? ' · <span style="color:#34D399;">✓ CH Verified</span>' : ''}${electedFromName ? ' · <span style="color:#A78BFA;font-weight:600;">Elected</span>' : ''}</div>
                    ${electedLine}
                  </div>
                  <span style="padding:3px 10px;border-radius:3px;background:rgba(34,197,94,0.15);color:#34D399;font-size:10.5px;font-weight:700;">Unsecured Corporate Guarantee — Required</span>
                </div>
                ${crossBorderPill}
              </div>`;
            }).join('')}
          ` : ''}

          <!-- Personal Guarantees -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:20px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Personal Guarantees</div>
          <p style="font-size:10.5px;color:#94A3B8;margin:4px 0 8px;font-style:italic;">UBOs of corporate borrowers are auto-listed by default. Status editable in G5.3.2.</p>
          ${(() => {
            // Detect corporate entities (can't give PGs — they're corporate guarantor candidates)
            const _isCorpEntity = (person) => {
              if (!person) return false;
              if ((person.borrower_type || '').toLowerCase() === 'corporate') return true;
              const nm = (person.full_name || '').toLowerCase();
              return /\b(ltd|limited|llp|plc|inc|gmbh|ag|sa|srl|pvt|corporation|corp|company|partnership|s\.a\.|b\.v\.)\b\.?$/i.test(nm.trim())
                  || /\bholdings?\b/i.test(nm);
            };

            const pgList = [];
            const corpPscsFound = [];  // PSCs that are corporate entities — flag for RM review
            for (const c of sgCorpBorrowers) {
              const officers = (sgOfficersByParent[c.id] || []).filter(o => o.role === 'psc' || (o.ch_match_data && o.ch_match_data.is_psc));
              for (const o of officers) {
                if (_isCorpEntity(o)) {
                  corpPscsFound.push({ psc: o, corp: c });
                } else {
                  pgList.push({ person: o, linkedToCorp: c, source: 'UBO-linked' });
                }
              }
            }
            for (const i of sgIndividualGuarantors) {
              if (_isCorpEntity(i)) { corpPscsFound.push({ psc: i, corp: null }); continue; }
              pgList.push({ person: i, linkedToCorp: null, source: 'Third-party / Manual' });
            }
            const corpAdvisory = corpPscsFound.length > 0 ? `<div style="background:rgba(251,191,36,0.08);border-left:3px solid #FBBF24;padding:8px 12px;margin:6px 0;border-radius:3px;font-size:10.5px;color:#FBBF24;">
              \u26A0\uFE0F Corporate PSC${corpPscsFound.length > 1 ? 's' : ''} detected: ${corpPscsFound.map(cp => `<strong>${sanitizeHtml(cp.psc.full_name)}</strong>${cp.corp ? ' (PSC of ' + sanitizeHtml(cp.corp.full_name) + ')' : ''}`).join(', ')}. These are corporate entities and cannot provide a Personal Guarantee. RM should assess whether to request a <strong>Corporate Guarantee</strong> deed from them.
            </div>` : '';
            if (pgList.length === 0 && corpPscsFound.length === 0) return `<div style="padding:10px;color:#64748B;font-size:12px;font-style:italic;">No PG providers identified yet. Add corporate borrowers + verify via CH to auto-populate UBOs.</div>`;
            if (pgList.length === 0) return corpAdvisory;
            return corpAdvisory + `<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.4px;display:grid;grid-template-columns:40px 1fr 130px 140px 1fr;gap:10px;padding:4px 0;font-weight:700;">
              <div>#</div><div>Guarantor</div><div>Status</div><div>Limit (£)</div><div>Notes</div>
            </div>
            ${pgList.map((pg, i) => {
              const status = pg.person.pg_status || 'required';
              const pill = pgLabelMap[status] || pgLabelMap.required;
              const isSynthetic = String(pg.person.id || '').startsWith('legacy-');
              const rowSid = deal.submission_id;
              const rowBid = pg.person.id;
              return `<div style="display:grid;grid-template-columns:40px 1fr 130px 140px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid #2d3748;align-items:center;">
                <div style="background:#fff3e0;color:#7a4820;font-weight:700;font-size:10px;padding:3px 8px;border-radius:3px;text-align:center;">G${i + 1}</div>
                <div><div style="font-weight:600;color:#E5E7EB;font-size:12px;">${sanitizeHtml(pg.person.full_name || '—')}</div><div style="color:#94A3B8;font-size:10px;">${pg.linkedToCorp ? 'UBO of ' + sanitizeHtml(pg.linkedToCorp.full_name) : sanitizeHtml(pg.source)}${isSynthetic ? ' · <em style="color:#fbbf24;">Add to Borrowers list to edit</em>' : ''}</div></div>
                <div>
                  ${isSynthetic
                    ? `<span style="padding:3px 10px;border-radius:3px;background:${pill.bg};color:${pill.fg};font-size:10.5px;font-weight:600;">${pill.label}</span>`
                    : `<select id="sg-pg-status-${rowBid}" onchange="window.sgSavePgStatus && window.sgSavePgStatus('${rowSid}', ${rowBid}, this.value)" ${!canEdit ? 'disabled' : ''}
                      style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;">
                      <option value="required" ${status === 'required' ? 'selected' : ''}>Required</option>
                      <option value="waived" ${status === 'waived' ? 'selected' : ''}>Waived</option>
                      <option value="limited" ${status === 'limited' ? 'selected' : ''}>Limited</option>
                    </select>`}
                </div>
                <div>
                  ${isSynthetic
                    ? `<span style="color:#E5E7EB;font-size:11px;">${pg.person.pg_limit_amount ? '£' + Number(pg.person.pg_limit_amount).toLocaleString('en-GB') : '\u2014'}</span>`
                    : `<input type="text" id="sg-pg-limit-${rowBid}" value="${pg.person.pg_limit_amount ? Number(pg.person.pg_limit_amount).toLocaleString('en-GB') : ''}"
                      placeholder="£ if Limited" onblur="window.sgSavePgLimit && window.sgSavePgLimit('${rowSid}', ${rowBid}, this.value)" ${!canEdit ? 'disabled' : ''}
                      style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;" />`}
                </div>
                <div>
                  ${isSynthetic
                    ? `<span style="font-size:10.5px;color:${pg.person.pg_notes ? '#E5E7EB' : '#64748B'};">${pg.person.pg_notes ? sanitizeHtml(pg.person.pg_notes) : '\u2014'}</span>`
                    : `<input type="text" id="sg-pg-notes-${rowBid}" value="${sanitizeHtml(pg.person.pg_notes || '')}"
                      placeholder="Waiver / limit reasoning" onblur="window.sgSavePgNotes && window.sgSavePgNotes('${rowSid}', ${rowBid}, this.value)" ${!canEdit ? 'disabled' : ''}
                      style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:5px 8px;border-radius:4px;font-size:11px;width:100%;" />`}
                </div>
              </div>`;
            }).join('')}`;
          })()}

          <!-- Additional Security -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:20px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Additional Security</div>
          <textarea id="sg-additional-security" placeholder="Any additional security arrangements not captured above — e.g. assignment of rental income, key person insurance, second charge on another asset, etc."
            onblur="window.sgSaveAdditionalSecurity && window.sgSaveAdditionalSecurity('${deal.submission_id}', this.value)"
            ${!canEdit ? 'disabled' : ''}
            style="background:#111827;color:#E5E7EB;border:1px solid #4b5563;padding:8px 10px;border-radius:4px;font-size:11px;width:100%;min-height:60px;font-family:inherit;resize:vertical;">${sanitizeHtml(deal.additional_security_text || '')}</textarea>

          <div style="margin-top:14px;padding:8px 12px;background:rgba(251,191,36,0.08);border-left:3px solid #FBBF24;border-radius:3px;font-size:10.5px;color:#FBBF24;">
            📋 CH charges display (G5.3.3) and PDF pickup (G5.3.4) still queued. All fields above save on change/blur.
          </div>
        </div>
      </div>
    </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTION CONSENT (CONS-2c, 2026-04-29) — Borrower consent capture
  // ═══════════════════════════════════════════════════════════════════
  if (isInternalUser) {
    const sgIndividuals = (deal.borrowers || []).filter((b) =>
      b.borrower_type !== 'corporate' &&
      (b.role === 'borrower' || b.role === 'guarantor' || b.role === 'director' || b.role === 'ubo' || b.role === 'shareholder' || !b.role)
    );
    const brokerAttestedAt = deal.broker_consent_attested_at;
    const brokerAttestLabel = brokerAttestedAt
      ? new Date(brokerAttestedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : null;

    html += `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('sc', '✓', 'Consent & Compliance', 'Borrower consent for credit, KYC, and identity checks', [
        renderStatusDot(0, brokerAttestedAt ? 'complete' : 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-sc" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <div style="padding:16px 24px 20px;background:#111827;">

          <!-- Broker attestation card -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:4px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Broker attestation</div>
          <div style="background:${brokerAttestedAt ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.06)'};border:1px solid ${brokerAttestedAt ? 'rgba(52,211,153,0.30)' : 'rgba(251,191,36,0.30)'};border-radius:6px;padding:12px 14px;margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div>
                <div style="font-size:13px;color:#E5E7EB;font-weight:600;">${brokerAttestedAt ? '✓ Broker has attested consent in fact-find' : '⚠ No broker attestation on record'}</div>
                <div style="font-size:11px;color:#94A3B8;margin-top:3px;">${brokerAttestedAt
                  ? `Attested ${sanitizeHtml(brokerAttestLabel)} · text version ${sanitizeHtml(deal.broker_consent_text_version || 'v1')}`
                  : 'Broker confirms they obtained consent in their FCA-regulated fact-find with the borrower.'}</div>
              </div>
              <button onclick="window.consentRecordBrokerAttestation && window.consentRecordBrokerAttestation('${deal.submission_id}', ${deal.id})"
                ${!canEdit ? 'disabled' : ''}
                style="padding:7px 14px;background:${brokerAttestedAt ? 'rgba(212,168,83,0.15)' : '#D4A853'};color:${brokerAttestedAt ? '#D4A853' : '#111'};border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">
                ${brokerAttestedAt ? 'Re-attest' : 'Record attestation'}
              </button>
            </div>
          </div>

          <!-- Per-borrower email-link consent -->
          <div style="color:#D4A853;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin:18px 0 8px;border-bottom:1px solid #2d3748;padding-bottom:4px;">Direct borrower consent (email link)</div>
          ${sgIndividuals.length === 0 ? `
            <div style="padding:10px;color:#64748B;font-size:12px;font-style:italic;">No individual borrowers/UBOs on this deal yet.</div>
          ` : `
            <div id="consent-borrowers-${deal.id}" style="display:flex;flex-direction:column;gap:8px;">
              ${sgIndividuals.map((b) => `
                <div data-consent-bid="${b.id}" style="background:rgba(255,255,255,0.02);border:1px solid #2d3748;border-radius:5px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                  <div style="min-width:0;flex:1;">
                    <div style="font-size:12px;color:#E5E7EB;font-weight:600;">${sanitizeHtml(b.full_name || b.name || 'Unnamed borrower')}</div>
                    <div style="font-size:10.5px;color:#94A3B8;margin-top:2px;">${sanitizeHtml(b.email || 'No email on file — add before sending link')} <span id="consent-pill-${b.id}" style="margin-left:6px;font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(100,116,139,0.12);color:#64748B;font-weight:700;">CHECKING…</span></div>
                  </div>
                  <button onclick="window.consentSendEmailLink && window.consentSendEmailLink('${deal.submission_id}', ${deal.id}, ${b.id}, '${sanitizeHtml(b.email || '').replace(/'/g, '\\\'')}')"
                    ${!canEdit || !b.email ? 'disabled' : ''}
                    title="${b.email ? 'Send a one-time consent link via email' : 'Add an email address to enable sending'}"
                    style="padding:5px 12px;background:${b.email ? '#60A5FA' : 'rgba(100,116,139,0.15)'};color:${b.email ? '#111' : '#94A3B8'};border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:${b.email ? 'pointer' : 'not-allowed'};white-space:nowrap;">
                    Send consent link
                  </button>
                </div>
              `).join('')}
            </div>
          `}

          <div style="margin-top:14px;padding:8px 12px;background:rgba(96,165,250,0.06);border-left:3px solid #60A5FA;border-radius:3px;font-size:10.5px;color:#94A3B8;">
            ℹ Consent is required for personal credit (Experian Delphi), Hunter Fraud, and SmartSearch identity checks before live mode fires. Commercial Delphi (corporate) does not require consent — fires on public business data only.
          </div>
        </div>
      </div>
    </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // M4d 2026-04-20 — Section reorder:
  // Sections 4 (Loan Terms) and 5 (Exit Strategy) are buffered here and
  // emitted further down in a NEW order: [Use of Funds] → [Exit Strategy]
  // → [Loan Terms & Economics]. Rationale: RM must understand purpose and
  // exit BEFORE pricing loan terms. Section IDs (s4, s5) kept as-is so all
  // downstream references (dip-sec-s4, content-s5, etc.) still work.
  // ═══════════════════════════════════════════════════════════════════

  // ── Buffer: Section 4 (Loan Terms & Economics) — emitted later ──
  const _section4LoanTermsHtml = `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('s4', 'L', 'Loan Terms & Economics', 'Loan structure, fees, Day Zero', [
        renderStatusDot(0, 'not-started', 'dip-sec-s4'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser, true)}

      <div id="content-s4" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Loan Terms -->
        ${renderFieldRow('loan-terms', 'Loan Terms', `Amount: £${fmtMoney(deal.loan_amount)}, Term: ${deal.term_months || '?'} months, Rate: ${deal.rate_requested || 'TBA'}%`,
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-loan-terms">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Loan Structure</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <!-- M2b Matrix-SSOT 2026-04-20: Requested (broker asked) vs Approved (what we offer) per negotiable term.
                   Approved is the canonical value — PDFs/term sheets render Approved only.
                   Editing any Approved value auto-revokes dip_loan_terms_approved (handled server-side). -->
              <p style="font-size:11px;color:#94A3B8;margin:0 0 12px 0;font-style:italic;">
                Broker's ask vs Daksfirst's offer. Edits to the Approved column will revoke the DIP Loan Terms approval stamp and require re-approval.
              </p>

              ${renderRequestedApprovedField(
                'loan_amount', 'Loan Amount (£)',
                deal.loan_amount_requested ?? deal.loan_amount,
                deal.loan_amount_approved ?? deal.loan_amount,
                'money', canEdit, null, showApproved
              )}
              ${renderRequestedApprovedField(
                'ltv', 'LTV (%)',
                deal.ltv_requested,
                deal.ltv_approved ?? deal.ltv_requested,
                'text', canEdit, null, showApproved
              )}
              ${renderRequestedApprovedField(
                'term_months', 'Term (months)',
                deal.term_months_requested ?? deal.term_months,
                deal.term_months_approved ?? deal.term_months,
                'text', canEdit, null, showApproved
              )}
              ${isPreSubmission ? '' : renderRequestedApprovedField(
                'rate', 'Rate (%/month)',
                deal.rate_requested,
                // Default to 1.10% when neither side is set (Daksfirst default rate)
                deal.rate_approved ?? deal.rate_requested ?? '1.10',
                'text', isInternalUser && canEdit, null, showApproved
              )}
              ${renderRequestedApprovedField(
                'interest_servicing', 'Interest Servicing',
                deal.interest_servicing_requested ?? deal.interest_servicing,
                deal.interest_servicing_approved ?? deal.interest_servicing ?? 'retained',
                'select', canEdit,
                [
                  { value: 'retained', label: 'Retained (deducted upfront)' },
                  { value: 'serviced', label: 'Serviced (monthly payments)' },
                  { value: 'rolled', label: 'Rolled Up' }
                ],
                showApproved
              )}

              <!-- Retained Interest Months — sub-parameter of Interest Servicing.
                   Only meaningful when servicing = 'retained'. Default 6 months.
                   Wrapper id used by window._toggleRetainedMonthsVisibility(). -->
              <div id="retained-months-wrapper" style="margin-top:2px;margin-bottom:14px;padding:10px 12px;background:rgba(52,211,153,0.04);border:1px solid rgba(52,211,153,0.12);border-radius:8px;${(deal.interest_servicing_approved ?? deal.interest_servicing ?? 'retained') === 'retained' ? '' : 'display:none;'}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                  <div style="flex:1;">
                    <div style="font-size:9px;color:#34D399;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;font-weight:700;">Retained Interest \u2014 Months</div>
                    <div style="font-size:10.5px;color:#94A3B8;line-height:1.4;">Number of months of interest deducted upfront at drawdown. Daksfirst default: 6 months. Affects Day Zero below.</div>
                  </div>
                  <div style="width:120px;flex-shrink:0;">
                    ${canEdit
                      ? '<input id="mf-retained_interest_months" type="text" inputmode="numeric" data-field="retained_interest_months" data-type="text" style="width:100%;padding:8px 12px;background:#0F172A;border:1px solid rgba(52,211,153,0.25);border-radius:6px;color:#F1F5F9;font-size:14px;font-weight:600;text-align:center;" value="' + (deal.retained_interest_months ?? '6') + '" placeholder="6" onblur="window.matrixValidateAndSave(\'retained_interest_months\', this.value, \'text\')" />'
                      : '<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:6px;color:#CBD5E1;font-size:14px;font-weight:600;text-align:center;">' + (deal.retained_interest_months ?? '6') + '</div>'
                    }
                  </div>
                </div>
              </div>

              <!-- 2026-04-21: Day Zero panel MOVED out of Loan Structure.
                   It now renders AFTER the Fee Schedule section below, because
                   Day Zero depends on fees (arrangement fee) to compute Net
                   Advance — showing it before fees are entered produced
                   meaningless dashes. Also fully hidden pre-submission via
                   the same isPreSubmission guard as Fee Schedule. -->

              <!-- Operational date — not negotiable, single value -->
              <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.04);">
                ${renderEditableField('drawdown_date', 'Target Drawdown', deal.drawdown_date, 'date', canEdit)}
              </div>
              <div id="loan-limit-indicator"></div>
            </div>
          </div>
        </div>

        <!-- Fees (moved from s7 2026-04-20 — lives with Loan Structure and Day Zero to form a single
             Loan Economics block. DIP Loan Terms approval gate covers this entire section.
             2026-04-21: hidden entirely for broker pre-submission (isPreSubmission) —
             RM fills fees, broker doesn't need to see them until RM has set them. -->
        ${isPreSubmission ? '' : `
        ${renderFieldRow('fees', 'Fee Schedule', `Arrangement: ${deal.arrangement_fee_pct ? fmtPct(deal.arrangement_fee_pct) + '%' : '2.00%'}, Broker: ${deal.broker_fee_pct ? fmtPct(deal.broker_fee_pct) + '%' : 'TBA'}, DIP: £${deal.dip_fee ?? 1000}, Commit: £${deal.commitment_fee || 'auto'}`,
          ['not-started', 'not-started', 'not-started', 'not-started'])}`}

        ${isPreSubmission ? '' : `
        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-fees">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Fee Schedule</div>
                ${['rm','admin'].includes(role) ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">RM/ADMIN EDIT</span>' : '<span style="font-size:8px;color:#64748B;font-weight:600;background:#1a2332;padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('arrangement_fee_pct', 'Arrangement Fee (%)', (deal.arrangement_fee_pct != null ? Number(deal.arrangement_fee_pct).toFixed(2) : '2.00'), 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('broker_fee_pct', 'Broker Fee (%)', (deal.broker_fee_pct != null ? Number(deal.broker_fee_pct).toFixed(2) : ''), 'text', ['rm','admin'].includes(role))}

                <!-- M3: Commitment Fee with live formula default + hint -->
                <div style="margin-bottom:12px">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;">
                    <label style="font-size:9px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;" for="mf-commitment_fee">Commitment Fee (£)</label>
                    <span style="font-size:8px;color:#34D399;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);padding:1px 6px;border-radius:8px;font-weight:700;text-transform:uppercase;">Auto-calc</span>
                  </div>
                  ${['rm','admin'].includes(role)
                    ? '<input id="mf-commitment_fee" type="text" inputmode="numeric" data-field="commitment_fee" data-type="money" style="width:100%;padding:8px 12px;background:#0F172A;border:1px solid rgba(52,211,153,0.2);border-radius:8px;color:#F1F5F9;font-size:13px;" value="' + formatWithCommas(String(deal.commitment_fee && Number(deal.commitment_fee) > 0 ? Math.round(Number(deal.commitment_fee)) : computeCommitmentFee(deal.loan_amount_approved ?? deal.loan_amount))) + '" oninput="this.value=this.value.replace(/[^0-9.,]/g,\'\')" onfocus="this.select()" onblur="window.matrixValidateAndSave(\'commitment_fee\', this.value, \'money\')" />'
                    : '<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.04);border-radius:8px;color:#CBD5E1;font-size:13px;">£' + formatWithCommas(String(deal.commitment_fee && Number(deal.commitment_fee) > 0 ? Math.round(Number(deal.commitment_fee)) : computeCommitmentFee(deal.loan_amount_approved ?? deal.loan_amount))) + '</div>'
                  }
                  <div id="commitment-fee-hint" style="font-size:10px;color:#64748B;margin-top:4px;font-style:italic;">${explainCommitmentFee(deal.loan_amount_approved ?? deal.loan_amount)}</div>
                </div>

                ${renderEditableField('dip_fee', 'DIP / Onboarding Fee (£)', deal.dip_fee ?? '1000', 'money', ['rm','admin'].includes(role))}
                ${renderEditableField('exit_fee_pct', 'Exit Fee (%)', (deal.exit_fee_pct != null ? Number(deal.exit_fee_pct).toFixed(2) : '1.00'), 'text', ['rm','admin'].includes(role))}
                ${renderEditableField('extension_fee_pct', 'Extension Fee (%)', (deal.extension_fee_pct != null ? Number(deal.extension_fee_pct).toFixed(2) : '1.00'), 'text', ['rm','admin'].includes(role))}
              </div>
              <p style="font-size:10.5px;color:#94A3B8;margin:12px 0 0 0;font-style:italic;">
                Daksfirst defaults: Arrangement 2.00% \u00B7 DIP Fee £1,000 (flat, not scaled) \u00B7 Exit 1.00% \u00B7 Extension 1.00%.
                Commitment Fee auto-computes from 0.10% × approved loan, rounded down to nearest £2,000, minimum £5,000. RM can override by typing any value.
                Broker Fee is paid from the Arrangement Fee (not additional).
              </p>
            </div>
          </div>
        </div>

        <!-- 2026-04-21: Day Zero panel — moved from inside Loan Structure.
             Renders ONLY when Fee Schedule is visible (i.e., post-submission or
             internal user), and only when loan_amount_approved is populated
             (per _updateDayZeroPanel's internal gate). Logically belongs here:
             Day Zero = Gross Loan − Retained Interest − Arrangement Fee, all of
             which come from the Approved column + Fee Schedule above. -->
        <div style="padding:8px 26px 14px 50px">
          <div id="day-zero-panel" style="padding:12px 14px;background:linear-gradient(135deg, rgba(212,168,83,0.06), rgba(212,168,83,0.02));border:1px solid rgba(212,168,83,0.25);border-radius:8px;">
            <div style="font-size:9px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Day Zero \u2014 Net Advance to Borrower</div>
            <div id="day-zero-rows" style="display:grid;grid-template-columns:1fr auto;row-gap:4px;font-size:12px;color:#CBD5E1;">
              <div>Gross Loan (Approved)</div><div id="dz-gross" style="text-align:right;color:#F1F5F9;font-weight:600;">\u2014</div>
              <div id="dz-retained-label" style="color:#94A3B8;">Less: Retained Interest</div><div id="dz-retained" style="text-align:right;color:#F87171;">\u2014</div>
              <div style="color:#94A3B8;">Less: Arrangement Fee</div><div id="dz-arr" style="text-align:right;color:#F87171;">\u2014</div>
              <div id="dz-cf-credit-label" style="color:#94A3B8;">Plus: Commitment Fee credit <span style="font-size:10px;color:#64748B;">(already paid at Termsheet)</span></div><div id="dz-cf-credit" style="text-align:right;color:#34D399;">\u2014</div>
              <div style="color:#94A3B8;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;margin-top:4px;font-weight:600;">= Net Advance on Day 1</div>
              <div id="dz-net" style="text-align:right;color:#34D399;font-weight:700;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;margin-top:4px;">\u2014</div>
            </div>
            <div id="dz-explain" style="font-size:10px;color:#64748B;margin-top:8px;font-style:italic;">\u2014</div>
          </div>
        </div>
        `}

        <!-- M4d 2026-04-20: Use of Funds extracted to its own section (rendered before Loan Terms).
             Rationale: RM needs purpose + exit understood BEFORE pricing loan terms. -->
      </div>
    </div>
  `;

  // ── Buffer: Section 5 (Exit Strategy) — emitted later ──
  const _section5ExitStrategyHtml = `
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
                ${renderEditableField('exit_route_primary', 'How will you repay?', deal.exit_route_primary, 'select', canEdit, EXIT_ROUTE_OPTIONS)}
                ${renderEditableField('exit_strategy', 'Exit detail (optional — context for combination/other or RM commentary)', deal.exit_strategy, 'textarea', canEdit)}
                ${renderEditableField('additional_notes', 'Additional Notes (internal — not on DIP)', deal.additional_notes, 'textarea', canEdit)}

                ${isInternalUser ? `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,0.1);">
                  <div style="font-size:10px;color:#4EA1FF;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">📊 Structured Exit Plan (RM/Credit underwriting)</div>
                  <div style="font-size:11px;color:#94A3B8;margin-bottom:10px;font-style:italic;">Structured fields the rubric reads to grade exit viability. Captured at IC stage by RM/Credit; cross-checked against valuer's marketability indicators.</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;">
                    ${renderEditableField('exit_route_secondary', 'Secondary route (fallback — RM only)', deal.exit_route_secondary, 'select', canEdit, EXIT_ROUTE_OPTIONS)}
                    ${renderEditableField('exit_target_date', 'Target exit date', deal.exit_target_date, 'date', canEdit)}
                    ${renderEditableField('exit_target_disposal_window_days', 'Disposal window (days)', deal.exit_target_disposal_window_days, 'number', canEdit)}
                    ${renderEditableField('exit_target_refi_lender', 'Target refi lender', deal.exit_target_refi_lender, 'text', canEdit)}
                    ${renderEditableField('exit_target_refi_loan', 'Target refi loan (£)', deal.exit_target_refi_loan, 'money', canEdit)}
                    ${renderEditableField('exit_target_refi_ltv_pct', 'Target refi LTV (%)', deal.exit_target_refi_ltv_pct, 'number', canEdit)}
                    ${renderEditableField('exit_target_refi_rate_pct_pa', 'Target refi rate (% pa)', deal.exit_target_refi_rate_pct_pa, 'number', canEdit)}
                    ${renderEditableField('exit_expected_disposal_proceeds', 'Expected disposal proceeds (£)', deal.exit_expected_disposal_proceeds, 'money', canEdit)}
                    ${renderEditableField('exit_borrower_stated_confidence', 'Borrower-stated confidence', deal.exit_borrower_stated_confidence, 'select', canEdit, EXIT_CONFIDENCE_OPTIONS)}
                    ${renderEditableField('exit_underwriter_assessed_confidence', 'Underwriter-assessed confidence', deal.exit_underwriter_assessed_confidence, 'select', canEdit, EXIT_CONFIDENCE_OPTIONS)}
                  </div>
                  <div style="margin-top:8px;">
                    ${renderEditableField('exit_underwriter_commentary', 'Underwriter commentary (DSCR check, gap vs valuer letting demand, fallback credibility)', deal.exit_underwriter_commentary, 'textarea', canEdit)}
                  </div>
                </div>` : ''}

                ${(() => {
                  // Conditions Precedent panel — broker sees, RM can edit
                  // (piece 3c, 2026-04-30 — auto-seeded from exit-conditions library)
                  const cps = Array.isArray(deal.conditions_precedent) ? deal.conditions_precedent : [];
                  const sum = deal.conditions_precedent_summary || { total: 0 };
                  if (cps.length === 0) {
                    return `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,0.1);">
                      <div style="font-size:10px;color:#10B981;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">📋 Conditions Precedent</div>
                      <p style="font-size:11px;color:#94A3B8;margin:0;font-style:italic;">No conditions yet — auto-seeded when DIP is issued based on chosen exit strategy.</p>
                    </div>`;
                  }
                  const pillFor = (status) => ({
                    open:              { bg: 'rgba(251,191,36,0.15)', fg: '#FBBF24', label: 'OPEN' },
                    evidence_received: { bg: 'rgba(59,130,246,0.15)', fg: '#3B82F6', label: 'EVIDENCE' },
                    satisfied:         { bg: 'rgba(16,185,129,0.15)', fg: '#10B981', label: 'SATISFIED' },
                    waived:            { bg: 'rgba(148,163,184,0.15)', fg: '#94A3B8', label: 'WAIVED' },
                    overridden:        { bg: 'rgba(168,85,247,0.15)', fg: '#A855F7', label: 'OVERRIDDEN' }
                  })[status] || { bg: '#374151', fg: '#94A3B8', label: status };
                  const stageLabel = { dd: 'Due Diligence', pre_completion: 'Pre-Completion', post_completion: 'Post-Completion' };
                  const byStage = {};
                  for (const cp of cps) { (byStage[cp.stage] = byStage[cp.stage] || []).push(cp); }
                  const sid = deal.submission_id;
                  const renderCp = (cp) => {
                    const pill = pillFor(cp.status);
                    const evidenceHint = cp.evidence_doc_type ? `<div style="font-size:10px;color:#94A3B8;margin-top:3px;">📎 ${sanitizeHtml(cp.evidence_doc_type.replace(/_/g, ' '))}</div>` : '';
                    const noteHint = cp.satisfaction_note ? `<div style="font-size:10px;color:#10B981;margin-top:3px;font-style:italic;">✓ ${sanitizeHtml(cp.satisfaction_note)}</div>` : '';
                    const waivedHint = cp.waived_reason ? `<div style="font-size:10px;color:#94A3B8;margin-top:3px;font-style:italic;">⊘ ${sanitizeHtml(cp.waived_reason)}</div>` : '';
                    const overrideHint = cp.override_reason ? `<div style="font-size:10px;color:#A855F7;margin-top:3px;font-style:italic;">⚡ ${sanitizeHtml(cp.override_reason)}</div>` : '';
                    const actions = isInternalUser && cp.status !== 'satisfied' && cp.status !== 'waived' && cp.status !== 'overridden'
                      ? `<div style="display:flex;flex-direction:column;gap:3px;">
                          <button onclick="window.sgUpdateCp && window.sgUpdateCp('${sid}', ${cp.id}, 'satisfied')" style="background:rgba(16,185,129,0.15);color:#10B981;border:1px solid rgba(16,185,129,0.3);padding:3px 6px;border-radius:3px;font-size:9.5px;cursor:pointer;font-weight:600;">Satisfy</button>
                          <button onclick="window.sgUpdateCp && window.sgUpdateCp('${sid}', ${cp.id}, 'waived')"    style="background:rgba(148,163,184,0.15);color:#94A3B8;border:1px solid rgba(148,163,184,0.3);padding:3px 6px;border-radius:3px;font-size:9.5px;cursor:pointer;font-weight:600;">Waive</button>
                          <button onclick="window.sgUpdateCp && window.sgUpdateCp('${sid}', ${cp.id}, 'overridden')" style="background:rgba(168,85,247,0.15);color:#A855F7;border:1px solid rgba(168,85,247,0.3);padding:3px 6px;border-radius:3px;font-size:9.5px;cursor:pointer;font-weight:600;">Override</button>
                        </div>`
                      : (isInternalUser && cp.source === 'manual_rm'
                          ? `<button onclick="window.sgDeleteCp && window.sgDeleteCp('${sid}', ${cp.id})" style="background:rgba(239,68,68,0.1);color:#EF4444;border:1px solid rgba(239,68,68,0.3);padding:3px 6px;border-radius:3px;font-size:9.5px;cursor:pointer;font-weight:600;">Delete</button>`
                          : '<div></div>');
                    return `<div style="display:grid;grid-template-columns:110px 1fr 90px;gap:10px;padding:8px 0;border-bottom:1px solid #2d3748;align-items:start;">
                      <div><span style="display:inline-block;padding:3px 8px;border-radius:3px;background:${pill.bg};color:${pill.fg};font-size:9.5px;font-weight:700;">${pill.label}</span>${cp.source === 'manual_rm' ? '<div style="font-size:9px;color:#94A3B8;margin-top:3px;">Manual</div>' : ''}</div>
                      <div>
                        <div style="font-size:12px;color:#E5E7EB;line-height:1.45;">${sanitizeHtml(cp.text)}</div>
                        ${evidenceHint}${noteHint}${waivedHint}${overrideHint}
                      </div>
                      ${actions}
                    </div>`;
                  };
                  const stageOrder = ['dd', 'pre_completion', 'post_completion'];
                  const sectionHtml = stageOrder.filter(s => byStage[s]).map(s => `
                    <div style="margin-top:10px;">
                      <div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;font-weight:600;">${stageLabel[s] || s}</div>
                      ${byStage[s].map(renderCp).join('')}
                    </div>`).join('');
                  const addBtn = isInternalUser
                    ? `<button onclick="window.sgAddCpManual && window.sgAddCpManual('${sid}')" style="background:rgba(212,168,83,0.15);color:#D4A853;border:1px solid rgba(212,168,83,0.3);padding:4px 10px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:600;">+ Add CP</button>`
                    : '';
                  const summaryPill = `<span style="font-size:9.5px;color:#94A3B8;font-weight:600;">${sum.satisfied || 0}/${sum.total || 0} satisfied${sum.waived ? ` · ${sum.waived} waived` : ''}${sum.overridden ? ` · ${sum.overridden} overridden` : ''}</span>`;
                  return `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,0.1);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                      <div style="font-size:10px;color:#10B981;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">📋 Conditions Precedent ${summaryPill}</div>
                      ${addBtn}
                    </div>
                    <p style="font-size:10.5px;color:#94A3B8;margin:0 0 6px;font-style:italic;">${isInternalUser ? 'Auto-seeded from exit-strategy library at DIP issuance. Mark Satisfied / Waive / Override as evidence comes in.' : 'Conditions to satisfy before completion. Upload evidence via the Documents tab; RM will mark satisfied.'}</p>
                    ${sectionHtml}
                  </div>`;
                })()}

                ${isInternalUser ? `<div style="margin-top:6px;padding-top:10px;border-top:1px dashed rgba(255,255,255,0.1);">
                  <div style="font-size:10px;color:#C9A227;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⚖ DIP Conditions (RM-only)</div>
                  <div style="font-size:11px;color:#94A3B8;margin-bottom:8px;font-style:italic;">Text written here appears on the DIP document sent to the broker. Keep internal chatter in Additional Notes above.</div>
                  ${renderEditableField('dip_notes', 'DIP Conditions', deal.dip_notes, 'textarea', canEdit)}
                </div>` : ''}
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
  // SECTION 3b (NEW 2026-04-20): USE OF FUNDS & PURPOSE
  // Extracted from the old Section 4; now its own approval gate.
  // DOM id = 'uof' to avoid renumbering existing s4..s8 IDs.
  // ═══════════════════════════════════════════════════════════════════

  const _sectionUofHtml = `
    <div style="border-bottom:1px solid rgba(255,255,255,0.06)">
      ${renderSectionHeader('uof', 'U', 'Use of Funds & Purpose', 'What the loan is for — drives the credit narrative', [
        renderStatusDot(0, 'not-started', 'dip-sec-uof'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser)}

      <div id="content-uof" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        ${renderFieldRow('use-of-funds', 'Use of Funds', 'Purpose, deposit source, refurb scope',
          ['not-started', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-use-of-funds">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <div style="font-size:14px;font-weight:700;color:#F1F5F9">Purpose & Use of Funds</div>
                ${canEdit ? '<span style="font-size:8px;color:#D4A853;font-weight:600;background:rgba(212,168,83,0.15);padding:2px 8px;border-radius:4px;">EDITABLE</span>' : '<span style="font-size:8px;color:#94A3B8;font-weight:600;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;">READ ONLY</span>'}
              </div>
              <p style="font-size:11px;color:#94A3B8;margin:0 0 12px 0;font-style:italic;">Approve purpose + use of funds BEFORE moving to Loan Terms. Loan pricing depends on the money story.</p>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
                ${renderEditableField('loan_purpose', 'Loan Purpose *', deal.loan_purpose, 'select', canEdit, LOAN_PURPOSE_OPTIONS)}
                ${renderEditableField('deposit_source', 'Deposit Source', deal.deposit_source, 'text', canEdit)}
                ${renderEditableField('use_of_funds', 'Use of Funds Detail *', deal.use_of_funds, 'textarea', canEdit)}
                ${renderEditableField('refurb_scope', 'Refurb Scope' + (['light_refurb','heavy_refurb'].includes(deal.loan_purpose) ? ' *' : ''), deal.refurb_scope, 'textarea', canEdit)}
                ${renderEditableField('refurb_cost', 'Refurb Cost (£)' + (['light_refurb','heavy_refurb'].includes(deal.loan_purpose) ? ' *' : ''), deal.refurb_cost, 'money', canEdit)}
                ${renderEditableField('purchase_price', 'Purchase Price (£)', deal.purchase_price, 'money', canEdit)}
              </div>

              <!-- ═══════════════════════════════════════════════ -->
              <!-- Sprint 3 #16 — Sources & Uses (must balance)     -->
              <!-- ═══════════════════════════════════════════════ -->
              <div style="margin-top:18px;padding-top:14px;border-top:1px dashed rgba(255,255,255,0.1);">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <div style="font-size:13px;font-weight:700;color:#4EA1FF;">⚖ Sources & Uses</div>
                  <div id="sus-balance-pill" style="font-size:10px;padding:3px 10px;border-radius:10px;background:rgba(100,116,139,0.12);color:#94A3B8;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">— Calculating</div>
                </div>
                <p style="font-size:11px;color:#94A3B8;margin:0 0 10px 0;font-style:italic;">Sources must equal Uses. Auto-totals update as you edit fields. SDLT auto-calculates for purchase deals (residential bands incl. 3% second-home surcharge — override if buyer is non-standard).</p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 22px;">

                  <!-- USES column -->
                  <div>
                    <div style="font-size:10px;color:#FBBF24;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;border-bottom:1px solid rgba(251,191,36,0.25);padding-bottom:4px;">Uses
                      <span id="sus-layout-tag" style="font-size:9px;color:#94A3B8;font-weight:500;text-transform:none;letter-spacing:0;margin-left:8px;">${(() => {
                        // Layout tag = analyst's explicit pick (Sprint 5 #26)
                        // Falls back to loan_purpose-derived hint if not yet picked.
                        const pt = (deal.uses_primary_type || '').toLowerCase();
                        if (pt === 'purchase')  return '· Purchase';
                        if (pt === 'refinance') return '· Refinance';
                        if (pt === 'refurb')    return '· Refurb-only';
                        if (pt === 'other')     return '· Other';
                        const lp = (deal.loan_purpose || '').toLowerCase();
                        const isAcq = ['acquisition','auction_purchase','chain_break'].includes(lp);
                        const isRefi = ['refinance','cash_out','bridge_to_sale','bridge_to_let','development_exit'].includes(lp);
                        const isRefurb = ['light_refurb','heavy_refurb'].includes(lp);
                        const tag = isAcq ? 'Acquisition (suggested)' : isRefi ? 'Refinance (suggested)' : isRefurb ? 'Refurb (suggested)' : 'Pick primary use →';
                        return '· ' + tag;
                      })()}</span>
                    </div>
                    ${(() => {
                      // Sprint 5 #26 (2026-04-28) — Explicit primary-use type dropdown.
                      // Replaces the loan_purpose-driven conditional rebuild that was
                      // unreliable across re-renders. Analyst picks the type from a
                      // dropdown; the amount field below carries a dynamic label and
                      // routes the value to the matching column on save:
                      //   purchase  → purchase_price
                      //   refinance → uses_loan_redemption
                      //   refurb    → refurb_cost
                      //   other     → uses_other_amount
                      // SDLT, Refurb-extra, Legal fees are always visible below
                      // because any of them can apply regardless of primary type
                      // (e.g. refi-with-additional-refurb, SPV transfer SDLT, etc.)
                      const pt = (deal.uses_primary_type || '').toLowerCase();
                      // Default suggestion — derive from loan_purpose so a brand-new
                      // deal still shows a sensible field on first render
                      const lp = (deal.loan_purpose || '').toLowerCase();
                      const suggested = ['refinance','cash_out','bridge_to_sale','bridge_to_let','development_exit'].includes(lp) ? 'refinance'
                                      : ['light_refurb','heavy_refurb'].includes(lp) ? 'refurb'
                                      : ['acquisition','auction_purchase','chain_break'].includes(lp) ? 'purchase'
                                      : '';
                      const activeType = pt || suggested || 'purchase';

                      // Resolve display + storage column + current value per active type
                      const fieldMap = {
                        purchase:  { label: 'Purchase price (£)',                          col: 'purchase_price',        val: deal.purchase_price        },
                        refinance: { label: 'Loan redemption — existing lender payoff (£)', col: 'uses_loan_redemption',  val: deal.uses_loan_redemption  },
                        refurb:    { label: 'Refurb cost (£)',                              col: 'refurb_cost',           val: deal.refurb_cost           },
                        other:     { label: 'Other primary use amount (£)',                 col: 'uses_other_amount',     val: deal.uses_other_amount     }
                      };
                      const fm = fieldMap[activeType] || fieldMap.purchase;

                      // Dropdown options
                      const opts = [
                        { value: 'purchase',  label: 'Purchase price' },
                        { value: 'refinance', label: 'Loan redemption (refinance)' },
                        { value: 'refurb',    label: 'Refurb cost (refurb-only deal)' },
                        { value: 'other',     label: 'Other primary use' }
                      ];
                      const ddOptHtml = opts.map(o =>
                        `<option value="${o.value}" ${o.value === activeType ? 'selected' : ''}>${o.label}</option>`
                      ).join('');
                      const dropdownHtml = canEdit
                        ? `<div style="margin-bottom:12px;">
                             <label style="display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Primary use type *</label>
                             <select id="mf-uses_primary_type" data-field="uses_primary_type" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(251,191,36,0.35);color:#F1F5F9;border-radius:4px;font-size:13px;cursor:pointer;" onchange="window._onPrimaryUseChange()">
                               ${ddOptHtml}
                             </select>
                             ${pt ? '' : '<div style="font-size:10px;color:#94A3B8;margin-top:3px;font-style:italic;">Suggested from Loan Purpose — pick to lock</div>'}
                           </div>`
                        : `<div style="margin-bottom:12px;">
                             <label style="display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Primary use type</label>
                             <input type="hidden" id="mf-uses_primary_type" value="${activeType}">
                             <div style="padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#F1F5F9;border-radius:4px;font-size:13px;">${(opts.find(o => o.value === activeType) || opts[0]).label}</div>
                           </div>`;

                      // The amount field — its data-field changes when the dropdown changes.
                      // We give it a stable DOM id (mf-primary-use-amount) so the change
                      // handler can rebind it without recreating the input.
                      const safeAmt = sanitizeHtml(String(fm.val == null ? '' : fm.val));
                      const amtDisplay = formatWithCommas(safeAmt);
                      const amountHtml = canEdit
                        ? `<div style="margin-bottom:12px;">
                             <label id="primary-use-label" style="display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">${fm.label}</label>
                             <input id="primary-use-amount" type="text" inputmode="numeric" data-field="${fm.col}" data-type="money" value="${amtDisplay}" placeholder="e.g. 1,500,000"
                               style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#F1F5F9;border-radius:4px;font-size:13px;"
                               oninput="this.value=this.value.replace(/[^0-9.,]/g,'')"
                               onfocus="this.select()"
                               onblur="window._savePrimaryUseAmount(this)" />
                           </div>`
                        : `<div style="margin-bottom:12px;">
                             <label id="primary-use-label" style="display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">${fm.label}</label>
                             <div style="padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#F1F5F9;border-radius:4px;font-size:13px;">${amtDisplay ? '£' + amtDisplay : '—'}</div>
                           </div>`;

                      // SDLT auto-calc button only useful for purchase
                      const sdltBtn = (canEdit && activeType === 'purchase')
                        ? `<button onclick="window._autoCalcSdlt(Number((document.getElementById('primary-use-amount')||{}).value || '0'.replace(/,/g,'')) || ${Number(deal.purchase_price) || 0})" style="padding:3px 10px;background:rgba(78,161,255,0.12);color:#4EA1FF;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;margin-bottom:10px;">↻ Auto-calc SDLT from purchase price</button>`
                        : '';

                      return dropdownHtml + amountHtml +
                             renderEditableField('uses_sdlt',       'Stamp Duty / SDLT (£)', deal.uses_sdlt,       'money', canEdit) +
                             sdltBtn +
                             // Show refurb cost separately ONLY if primary type isn't already refurb
                             (activeType !== 'refurb'
                               ? renderEditableField('refurb_cost', 'Refurb cost — additional (£)', deal.refurb_cost, 'money', canEdit)
                               : '') +
                             renderEditableField('uses_legal_fees', 'Legal fees (£)',         deal.uses_legal_fees, 'money', canEdit);
                    })()}
                    <div style="font-size:11px;color:#94A3B8;margin:6px 0 4px 0;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.06);">Lender fees (auto from Loan Terms):</div>
                    <div id="sus-fees-list" style="font-size:11px;color:#CBD5E1;margin-bottom:8px;line-height:1.7;">Loading…</div>
                    ${renderEditableField('uses_other_amount', 'Other uses (£)', deal.uses_other_amount, 'money', canEdit)}
                    ${renderEditableField('uses_other_description', 'Other description', deal.uses_other_description, 'text', canEdit)}
                    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(251,191,36,0.25);font-size:13px;font-weight:700;color:#FBBF24;display:flex;justify-content:space-between;">
                      <span>Total Uses</span>
                      <span id="sus-total-uses">£—</span>
                    </div>
                  </div>

                  <!-- SOURCES column -->
                  <div>
                    <div style="font-size:10px;color:#34D399;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;border-bottom:1px solid rgba(52,211,153,0.25);padding-bottom:4px;">Sources</div>
                    <div style="margin-bottom:12px;">
                      <label style="display:block;font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">Senior secured — Daksfirst loan (£)</label>
                      <div style="padding:8px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:6px;color:#34D399;font-size:13px;font-weight:700;" id="sus-senior-loan">£${Number(deal.loan_amount_approved || deal.loan_amount || 0).toLocaleString()}</div>
                      <div style="font-size:9px;color:#64748B;margin-top:2px;">Auto from Loan Terms (loan_amount_approved). 1st charge on security.</div>
                    </div>
                    ${renderEditableField('sources_second_charge', 'Second charge (£)', deal.sources_second_charge, 'money', canEdit)}
                    ${renderEditableField('sources_equity', 'Borrower equity (£)', deal.sources_equity, 'money', canEdit)}
                    ${renderEditableField('sources_other_amount', 'Other sources (£)', deal.sources_other_amount, 'money', canEdit)}
                    ${renderEditableField('sources_other_description', 'Other description', deal.sources_other_description, 'text', canEdit)}
                    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(52,211,153,0.25);font-size:13px;font-weight:700;color:#34D399;display:flex;justify-content:space-between;">
                      <span>Total Sources</span>
                      <span id="sus-total-sources">£—</span>
                    </div>
                  </div>

                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  // Defer the initial S&U totals calc until DOM is rendered
  setTimeout(() => window._recalcSourcesUses && window._recalcSourcesUses(deal), 400);

  // ═══════════════════════════════════════════════════════════════════
  // EMIT buffered sections in the NEW commercial order:
  //   Use of Funds  →  Exit Strategy  →  Loan Terms & Economics
  // Then Section 6+ continue normally.
  // ═══════════════════════════════════════════════════════════════════
  html += _sectionUofHtml;
  html += _section5ExitStrategyHtml;
  html += _section4LoanTermsHtml;

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
      ${renderSectionHeader('s7', 'C', 'Credit Approval', 'Internal credit committee sign-off', [
        renderStatusDot(0, 'not-started', 'dip-sec-s7'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started'),
        renderStatusDot(0, 'not-started')
      ], isInternalUser, true)}

      <div id="content-s7" style="max-height:0px;overflow:hidden;transition:max-height .35s ease">
        <!-- Credit Approval — NOT at DIP stage, belongs in Formal Offer.
             Fees block moved to s4 (Loan Terms & Economics) on 2026-04-20. -->
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
        ${renderFieldRow('dip-document', 'Decision in Principle (DIP)', 'Initial deal summary and requirements',
          [deal.dip_signed ? 'signed' : 'submitted', 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-dip-document">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Decision in Principle (DIP)</div>
              <div style="font-size:13px;color:#64748B;">${deal.dip_signed ? 'Signed and issued.' : deal.dip_issued_at ? 'Issued — awaiting signature.' : 'Will be generated once all required fields are populated.'}</div>
            </div>
          </div>
        </div>

        <!-- Indicative TS -->
        ${renderFieldRow('indicative-ts', 'Indicative Term Sheet', 'Initial lending terms and conditions',
          [(deal.dip_signed && deal.dip_fee_confirmed) ? 'not-started' : 'locked', deal.ts_signed ? 'signed' : 'not-started', 'not-started', 'not-started'])}

        <div style="max-height:0;overflow:hidden;transition:max-height .3s ease;background:#1a2332" id="detail-indicative-ts">
          <div style="padding:8px 26px 14px 50px">
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px">
              <div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-bottom:8px">Indicative Term Sheet</div>
              <div style="font-size:13px;color:#64748B;">${deal.ts_signed ? 'Signed and accepted.' : (deal.dip_signed && deal.dip_fee_confirmed) ? 'Unlocked — full data verification in progress (HMLR, TruLayer, valuations, ALM, QS reports, title detail).' : 'Unlocks once DIP is signed and onboarding fee is paid.'}</div>
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

  // 2026-04-21: Matrix-internal Document Repository block DELETED.
  // It was a cosmetic duplicate (category tabs + placeholder "Documents will
  // appear here" text + static drop zone) of the real DR accordion on the
  // Dashboard. Real DR lives at #section-doc-repo with live doc list, upload
  // button, AI Parse & Review button, and category filter tabs. Single source
  // of truth for all document-related actions.

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
        <!-- 2026-04-21: Upload Documents + AI Parse & Review buttons moved to
             Document Repository section. Matrix bottom retains only matrix-workflow
             actions (Paste for RM, Submit, Open Incomplete). Keeps cause/effect
             tight: "matrix is complete → submit matrix". -->
        ${isInternalUser || ['draft', 'received'].includes(currentStage) ? `
        <button onclick="document.getElementById('matrix-paste-modal').style.display='block'" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid transparent;background:#D4A853;color:#fff;cursor:pointer;transition:all .12s" title="Paste broker text for AI parsing">Paste Broker Pack</button>
        ` : ''}
        ${['draft', 'received'].includes(currentStage) ? `
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

  // ── Party Relationships analysis (auto-compute after DOM mounts) ──
  // Fires in the background — does not block matrix render. Populates the placeholder div
  // at the top of the Borrower/KYC section when 2+ corporate parties are present on the deal.
  // NOTE: we DON'T gate this on `typeof window._loadAndRenderPartyRelationships === 'function'`
  // because the function assignment happens later in this same synchronous renderDealMatrix pass
  // (window handlers are assigned after container.innerHTML). The setTimeout runs after this
  // whole pass completes, so the function will be available by the time the timer fires.
  setTimeout(() => {
    try {
      if (typeof window._loadAndRenderPartyRelationships === 'function') {
        window._loadAndRenderPartyRelationships(deal);
      } else {
        console.warn('[party-relationships] orchestrator not yet defined when timer fired');
      }
    } catch (err) {
      console.warn('[party-relationships] auto-trigger failed:', err);
    }
  }, 120);

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
      'Fees': 's4',
      'Use of Funds': 'uof',
      'Use of Funds & Purpose': 'uof',
      'AML & Source of Funds': 's2'
    };
    // First close all sections — includes M4d 'uof' slot
    const _allSectionIds = ['s1','s2','s3','s4','s5','s6','s7','s8','uof'];
    for (const sid of _allSectionIds) {
      const content = document.getElementById(`content-${sid}`);
      const chevron = document.getElementById(`chevron-${sid}`);
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

        // M2b (Matrix-SSOT): bi-directional Loan ↔ LTV coupling.
        // portfolioValuation() reads from deal_properties totals; both sides of the
        // equation use the same valuation so the math stays consistent.
        //
        //   loan_amount      → ltv_requested   (legacy single-value pair, still supported)
        //   loan_amount_approved → ltv_approved  (new Approved pair — what RM offers)
        //   ltv_approved     → loan_amount_approved  (back-solve: loan = ltv × val / 100)
        //
        // Requested side is captured at submission, not editable from matrix — no recalc there.
        const _valuation = portfolioValuation();
        const _flashBorder = (elId) => {
          const el2 = document.getElementById(elId);
          if (el2) {
            el2.value = el2.value; // no-op set to trigger repaint in some browsers
            el2.style.borderColor = '#34D399';
            setTimeout(() => { el2.style.borderColor = 'rgba(255,255,255,0.06)'; }, 1200);
          }
          return el2;
        };
        const _silentSave = (key, val) => {
          fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/matrix-fields`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: val })
          }).catch(() => {});
        };

        if (fieldKey === 'loan_amount' && _valuation > 0) {
          const loanVal = parseFloat(stripCommas(String(value))) || 0;
          if (loanVal > 0) {
            const ltv = ((loanVal / _valuation) * 100).toFixed(2);
            const el2 = document.getElementById('mf-ltv_requested');
            if (el2) { el2.value = ltv; _flashBorder('mf-ltv_requested'); }
            deal.ltv_requested = ltv;
            _silentSave('ltv_requested', ltv);
          }
        }

        // 2026-04-21: parallel branch for loan_amount_requested → ltv_requested
        // (broker-editable Requested column; mirrors legacy loan_amount branch
        // above so typing a Requested amount also updates Requested LTV).
        if (fieldKey === 'loan_amount_requested' && _valuation > 0) {
          const loanVal = parseFloat(stripCommas(String(value))) || 0;
          if (loanVal > 0) {
            const ltv = ((loanVal / _valuation) * 100).toFixed(2);
            const el2 = document.getElementById('mf-ltv_requested');
            if (el2) { el2.value = ltv; _flashBorder('mf-ltv_requested'); }
            deal.ltv_requested = ltv;
            _silentSave('ltv_requested', ltv);
          }
        }

        if (fieldKey === 'loan_amount_approved' && _valuation > 0) {
          const loanVal = parseFloat(stripCommas(String(value))) || 0;
          if (loanVal > 0) {
            const ltv = ((loanVal / _valuation) * 100).toFixed(2);
            const el2 = document.getElementById('mf-ltv_approved');
            if (el2) { el2.value = ltv; _flashBorder('mf-ltv_approved'); }
            deal.ltv_approved = ltv;
            _silentSave('ltv_approved', ltv);
          }
        }

        if (fieldKey === 'ltv_approved' && _valuation > 0) {
          const ltvVal = parseFloat(String(value).replace(/[^0-9.]/g, '')) || 0;
          if (ltvVal > 0) {
            const loan = Math.round((ltvVal / 100) * _valuation);
            const el2 = document.getElementById('mf-loan_amount_approved');
            if (el2) { el2.value = formatWithCommas(String(loan)); _flashBorder('mf-loan_amount_approved'); }
            deal.loan_amount_approved = loan;
            _silentSave('loan_amount_approved', loan);
          }
        }

        // ltv_requested → loan_amount back-solve.
        // Keeps legacy flat loan_amount in sync AND — 2026-04-21 — also updates
        // the broker-editable loan_amount_requested column shown in the new
        // single-column pre-submission UI. Mirrors the forward branch above.
        if (fieldKey === 'ltv_requested' && _valuation > 0) {
          const ltvVal = parseFloat(String(value).replace(/[^0-9.]/g, '')) || 0;
          if (ltvVal > 0) {
            const loan = Math.round((ltvVal / 100) * _valuation);
            // Update legacy flat field input (backward compat with older deals)
            const el2 = document.getElementById('mf-loan_amount');
            if (el2) { el2.value = formatWithCommas(String(loan)); _flashBorder('mf-loan_amount'); }
            deal.loan_amount = loan;
            _silentSave('loan_amount', loan);
            // 2026-04-21: also update the Requested column for the new UI
            const el3 = document.getElementById('mf-loan_amount_requested');
            if (el3) { el3.value = formatWithCommas(String(loan)); _flashBorder('mf-loan_amount_requested'); }
            deal.loan_amount_requested = loan;
            _silentSave('loan_amount_requested', loan);
          }
        }

        // Recalculate completeness and loan limit after every save
        calculateCompleteness();
        updateLoanLimitIndicator();

        // M2b: Day Zero panel live-refresh on fee/rate/loan/months/servicing changes
        const _dzTrigger = ['loan_amount', 'loan_amount_approved', 'rate_requested', 'rate_approved',
          'ltv_approved', 'arrangement_fee_pct', 'retained_interest_months',
          'interest_servicing', 'interest_servicing_approved',
          // 2026-04-21: commitment_fee now feeds the Day Zero credit line
          'commitment_fee'];
        if (_dzTrigger.includes(fieldKey) && typeof window._updateDayZeroPanel === 'function') {
          try { window._updateDayZeroPanel(); } catch (_) {}
        }
        // Servicing change → also toggle the Retained Months wrapper visibility
        if (fieldKey === 'interest_servicing_approved' && typeof window._toggleRetainedMonthsVisibility === 'function') {
          try { window._toggleRetainedMonthsVisibility(value); } catch (_) {}
        }
        // M3: Commitment Fee auto-recompute — ALWAYS fires on loan change.
        // Sumit 2026-04-20: formula is canonical; prior RM overrides do not
        // survive a loan amount change (they were valid for the old loan, not
        // this new one). RM can re-override by typing any value after.
        if (['loan_amount_approved', 'loan_amount'].includes(fieldKey)) {
          const newLoan = parseFloat(stripCommas(String(value))) || 0;
          const newFee = computeCommitmentFee(newLoan);
          const feeEl = document.getElementById('mf-commitment_fee');
          const hintEl = document.getElementById('commitment-fee-hint');
          if (feeEl) {
            feeEl.value = formatWithCommas(String(newFee));
            feeEl.style.borderColor = '#34D399';
            setTimeout(() => { feeEl.style.borderColor = 'rgba(52,211,153,0.2)'; }, 1200);
            deal.commitment_fee = newFee;
            _silentSave('commitment_fee', newFee);
          }
          if (hintEl) hintEl.textContent = explainCommitmentFee(newLoan);
        }
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

  // 2026-04-21: Apply Max Loan quick-fill. Role-aware target column:
  //   target='requested' → writes loan_amount_requested (broker's ask)
  //   target='approved'  → writes loan_amount_approved  (RM's offer)
  // Defaults to 'requested' for backward compat.
  window._applyMaxLoan = function(maxLoan, target) {
    if (!maxLoan || maxLoan <= 0) return;
    const column = (target === 'approved') ? 'loan_amount_approved' : 'loan_amount_requested';
    const el = document.getElementById('mf-' + column);
    const formatted = formatWithCommas(String(maxLoan));
    if (el) {
      el.value = formatted;
      el.style.borderColor = '#34D399';
      setTimeout(() => { el.style.borderColor = 'rgba(255,255,255,0.06)'; }, 1200);
    }
    deal[column] = maxLoan;
    // Trigger the normal save path — matrixSaveField also recalculates the
    // corresponding LTV column and updates the loan-limit-indicator.
    window.matrixSaveField(column, String(maxLoan));
  };

  // ═══════════════════════════════════════════════════════════════════
  // G5.3.2 — Security & Guarantee section save handlers
  // Each handler flashes a green border on the source element on success,
  // red on error. Updates in-memory deal object so re-renders show new values.
  // ═══════════════════════════════════════════════════════════════════

  async function _sgFlashSave(elementId, url, body) {
    const el = document.getElementById(elementId);
    try {
      const resp = await fetchWithAuth(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (resp.ok) {
        if (el) { el.style.borderColor = '#34D399'; setTimeout(() => { if (el) el.style.borderColor = '#4b5563'; }, 1200); }
        return true;
      } else {
        if (el) el.style.borderColor = '#F87171';
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Save failed', 'error');
        return false;
      }
    } catch (e) {
      if (el) el.style.borderColor = '#F87171';
      showToast('Connection error', 'error');
      return false;
    }
  }

  // XCOLL-2: helper called after each save to keep the cross-collateral
  // summary panel in sync with the in-memory deal.properties state.
  function _refreshXcollAfterSave() {
    if (window._refreshXcollSummary) {
      window._refreshXcollSummary(deal, deal.properties || []);
    }
  }

  window.sgSavePropertyCharge = async function(submissionId, propertyId, value) {
    const ok = await _sgFlashSave(`sg-charge-${propertyId}`, `${API_BASE}/api/deals/${submissionId}/properties/${propertyId}`, { security_charge_type: value });
    if (ok && Array.isArray(deal.properties)) {
      const p = deal.properties.find(pp => pp.id === propertyId); if (p) p.security_charge_type = value;
      _refreshXcollAfterSave();
    }
  };

  window.sgSavePropertyEncumbrance = async function(submissionId, propertyId, value) {
    const ok = await _sgFlashSave(`sg-encum-${propertyId}`, `${API_BASE}/api/deals/${submissionId}/properties/${propertyId}`, { existing_charges_note: value || null });
    if (ok && Array.isArray(deal.properties)) {
      const p = deal.properties.find(pp => pp.id === propertyId); if (p) p.existing_charges_note = value;
      _refreshXcollAfterSave();
    }
  };

  // XCOLL-1 (2026-04-29): Loan purpose per property
  window.sgSavePropertyPurpose = async function(submissionId, propertyId, value) {
    const ok = await _sgFlashSave(`sg-purpose-${propertyId}`, `${API_BASE}/api/deals/${submissionId}/properties/${propertyId}`, { loan_purpose: value || null });
    if (ok && Array.isArray(deal.properties)) {
      const p = deal.properties.find(pp => pp.id === propertyId); if (p) p.loan_purpose = value || null;
      _refreshXcollAfterSave();
    }
  };

  // XCOLL-1 (2026-04-29): Existing-lender outstanding balance (in pounds, sent as pence)
  window.sgSavePropertyBalance = async function(submissionId, propertyId, value) {
    const pounds = value === '' || value == null ? null : Number(value);
    const pence = (pounds == null || isNaN(pounds)) ? null : Math.round(pounds * 100);
    const ok = await _sgFlashSave(`sg-balance-${propertyId}`, `${API_BASE}/api/deals/${submissionId}/properties/${propertyId}`, { existing_charge_balance_pence: pence });
    if (ok && Array.isArray(deal.properties)) {
      const p = deal.properties.find(pp => pp.id === propertyId); if (p) p.existing_charge_balance_pence = pence;
      _refreshXcollAfterSave();
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // CONS-2c (2026-04-29) — Borrower consent capture handlers
  // ═══════════════════════════════════════════════════════════════════

  // Record broker attestation — RM has confirmed broker obtained consent in
  // their FCA-regulated fact-find. Stamps deal_submissions cols + writes one
  // borrower_consents row per UBO (covering all 4 consent types).
  window.consentRecordBrokerAttestation = async function(submissionId, dealId) {
    const ok = window.confirm(
      'Record broker attestation for deal #' + dealId + '?\n\n' +
      'This certifies that the broker has obtained the borrower\'s consent for credit, KYC, ' +
      'identity, and fraud checks in their FCA-regulated fact-find.\n\n' +
      'A borrower_consents row will be written for every individual borrower/UBO on this deal, ' +
      'covering personal credit, hunter fraud, KYC, and open banking.\n\n' +
      'Confirm?'
    );
    if (!ok) return;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/consent/broker-attest/${dealId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert('Broker attestation failed: ' + (data.error || `HTTP ${res.status}`));
        return;
      }
      showToast(`Broker attestation recorded for ${data.borrowers ? data.borrowers.length : '?'} borrower(s)`, 'success');
      setTimeout(() => _refreshDealInPlace(submissionId), 500);
    } catch (err) {
      console.error('[consent/attest] error:', err);
      alert('Connection error: ' + err.message);
    }
  };

  // Send email-link consent to a specific borrower. RM clicks → backend mints
  // signed token → emails borrower → borrower clicks link → public landing
  // page → confirms → consent rows written automatically.
  window.consentSendEmailLink = async function(submissionId, dealId, borrowerId, email) {
    if (!email) {
      alert('Borrower has no email address on file. Add one in the Borrower section first.');
      return;
    }
    const ok = window.confirm(
      'Send consent link to ' + email + '?\n\n' +
      'The borrower will receive an email with a one-time link (valid 30 days). ' +
      'They click the link, read the consent text, tick the box, and confirm. ' +
      'No login required.\n\n' +
      'Confirm send?'
    );
    if (!ok) return;
    const btn = event && event.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; btn.style.opacity = '0.6'; }
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/consent/send-link/${dealId}/${borrowerId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert('Send failed: ' + (data.error || `HTTP ${res.status}`));
        if (btn) { btn.disabled = false; btn.textContent = 'Send consent link'; btn.style.opacity = '1'; }
        return;
      }
      showToast(`Consent link sent to ${email} (expires in ${data.link_expires_in_days || 30} days)`, 'success');
      if (btn) {
        btn.textContent = 'Sent ✓';
        btn.style.background = 'rgba(52,211,153,0.15)';
        btn.style.color = '#34D399';
      }
    } catch (err) {
      console.error('[consent/send-link] error:', err);
      alert('Connection error: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Send consent link'; btn.style.opacity = '1'; }
    }
  };

  // After deal mounts, fetch consent status and paint per-borrower pills.
  // Called from showDealMatrix (or whatever wires up post-render hooks).
  window.consentLoadStatusPills = async function(submissionId, dealId) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/consent/status/${dealId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;
      const consentRows = data.consent_rows || [];
      // Group by borrower_id, pick best evidence_source for the pill.
      const byBorrower = {};
      consentRows.forEach((r) => {
        if (r.revoked_at) return;
        if (!byBorrower[r.borrower_id]) byBorrower[r.borrower_id] = { sources: new Set(), latestAt: null };
        byBorrower[r.borrower_id].sources.add(r.evidence_source);
        if (!byBorrower[r.borrower_id].latestAt || new Date(r.consented_at) > new Date(byBorrower[r.borrower_id].latestAt)) {
          byBorrower[r.borrower_id].latestAt = r.consented_at;
        }
      });
      // Update pills
      document.querySelectorAll('[id^="consent-pill-"]').forEach((pill) => {
        const bid = Number(pill.id.replace('consent-pill-', ''));
        const state = byBorrower[bid];
        if (!state) {
          pill.style.background = 'rgba(100,116,139,0.12)';
          pill.style.color = '#94A3B8';
          pill.textContent = 'NO CONSENT';
        } else if (state.sources.has('email_link_token')) {
          pill.style.background = 'rgba(52,211,153,0.15)';
          pill.style.color = '#34D399';
          pill.textContent = '✓ EMAIL CONFIRMED';
        } else if (state.sources.has('broker_attestation')) {
          pill.style.background = 'rgba(167,139,250,0.15)';
          pill.style.color = '#A78BFA';
          pill.textContent = '✓ BROKER ATTESTED';
        } else {
          pill.style.background = 'rgba(96,165,250,0.15)';
          pill.style.color = '#60A5FA';
          pill.textContent = state.sources.values().next().value.toUpperCase();
        }
      });
    } catch (err) {
      console.error('[consent/status] error:', err);
    }
  };

  // Auto-load status pills shortly after the deal renders (lets the consent
  // section DOM exist before we try to update pills).
  setTimeout(() => {
    if (window.consentLoadStatusPills && deal && deal.id) {
      window.consentLoadStatusPills(deal.submission_id, deal.id);
    }
  }, 600);

  window.sgSavePgStatus = async function(submissionId, borrowerId, value) {
    const ok = await _sgFlashSave(`sg-pg-status-${borrowerId}`, `${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}`, { pg_status: value });
    if (ok && Array.isArray(deal.borrowers)) {
      const b = deal.borrowers.find(bb => bb.id === borrowerId); if (b) b.pg_status = value;
    }
  };

  window.sgSavePgLimit = async function(submissionId, borrowerId, rawValue) {
    const cleaned = String(rawValue || '').replace(/[£,\s]/g, '');
    const numeric = cleaned === '' ? null : parseFloat(cleaned);
    if (cleaned !== '' && (isNaN(numeric) || numeric < 0)) {
      const el = document.getElementById(`sg-pg-limit-${borrowerId}`);
      if (el) el.style.borderColor = '#F87171';
      showToast('Enter a valid £ amount', 'error');
      return;
    }
    const ok = await _sgFlashSave(`sg-pg-limit-${borrowerId}`, `${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}`, { pg_limit_amount: numeric });
    if (ok && Array.isArray(deal.borrowers)) {
      const b = deal.borrowers.find(bb => bb.id === borrowerId); if (b) b.pg_limit_amount = numeric;
      // Reformat display with commas
      const el = document.getElementById(`sg-pg-limit-${borrowerId}`);
      if (el && numeric !== null) el.value = Number(numeric).toLocaleString('en-GB');
    }
  };

  window.sgSavePgNotes = async function(submissionId, borrowerId, value) {
    const ok = await _sgFlashSave(`sg-pg-notes-${borrowerId}`, `${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}`, { pg_notes: value || null });
    if (ok && Array.isArray(deal.borrowers)) {
      const b = deal.borrowers.find(bb => bb.id === borrowerId); if (b) b.pg_notes = value;
    }
  };

  window.sgSaveAdditionalSecurity = async function(submissionId, value) {
    const ok = await _sgFlashSave('sg-additional-security', `${API_BASE}/api/deals/${submissionId}/matrix-fields`, { additional_security_text: value || '' });
    if (ok) deal.additional_security_text = value;
  };

  // ─── Conditions Precedent handlers (piece 3c, 2026-04-30) ───
  window.sgUpdateCp = async function(submissionId, cpId, newStatus) {
    const body = { status: newStatus };
    if (newStatus === 'waived') {
      const reason = prompt('Reason for waiving this condition:');
      if (!reason || !reason.trim()) return;
      body.waived_reason = reason.trim();
    } else if (newStatus === 'overridden') {
      const reason = prompt('Reason for overriding this condition (audit-grade explanation required):');
      if (!reason || !reason.trim()) return;
      body.override_reason = reason.trim();
    } else if (newStatus === 'satisfied') {
      const note = prompt('Optional note (e.g. evidence reference / doc title):');
      if (note && note.trim()) body.satisfaction_note = note.trim();
    }
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/conditions-precedent/${cpId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (resp.ok) {
        showToast(`Condition ${newStatus}`);
        await _refreshDealInPlace(submissionId);
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Failed to update condition', 'error');
      }
    } catch (e) {
      showToast('Network error: ' + e.message, 'error');
    }
  };

  window.sgAddCpManual = async function(submissionId) {
    const stage = prompt('Stage — type "dd" (Due Diligence), "pre_completion", or "post_completion":');
    if (!stage || !['dd', 'pre_completion', 'post_completion'].includes(stage.trim())) {
      showToast('Invalid stage — must be dd / pre_completion / post_completion', 'error');
      return;
    }
    const text = prompt('Condition text (full description as it should appear to the broker):');
    if (!text || !text.trim()) return;
    const evType = prompt('Evidence document type hint (optional — e.g. "marketing_instruction"):') || null;
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/conditions-precedent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: stage.trim(), text: text.trim(), evidence_doc_type: evType ? evType.trim() : null })
      });
      if (resp.ok) {
        showToast('Manual condition added');
        await _refreshDealInPlace(submissionId);
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Failed to add condition', 'error');
      }
    } catch (e) {
      showToast('Network error: ' + e.message, 'error');
    }
  };

  window.sgDeleteCp = async function(submissionId, cpId) {
    if (!confirm('Delete this manual condition? Auto-seeded conditions cannot be deleted (use Waive or Override instead).')) return;
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/conditions-precedent/${cpId}`, {
        method: 'DELETE'
      });
      if (resp.ok) {
        showToast('Manual condition deleted');
        await _refreshDealInPlace(submissionId);
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Failed to delete condition', 'error');
      }
    } catch (e) {
      showToast('Network error: ' + e.message, 'error');
    }
  };

  // ── G5.3.3 — Lazy-load CH existing charges per corporate in Security section ──
  window.sgLoadCharges = async function() {
    const nodes = document.querySelectorAll('[id^="sg-charges-"][data-company-number]');
    for (const node of nodes) {
      const companyNumber = node.getAttribute('data-company-number');
      if (!companyNumber) { node.innerHTML = `<span style="color:#64748B;">No CH company number</span>`; continue; }
      try {
        const resp = await fetchWithAuth(`${API_BASE}/api/companies-house/charges/${companyNumber}`);
        if (!resp.ok) { node.innerHTML = `<span style="color:#F87171;">Failed to load CH charges (${resp.status})</span>`; continue; }
        const data = await resp.json();
        const charges = (data.charges || []).slice().sort((a, b) => (b.created_on || '').localeCompare(a.created_on || ''));
        if (charges.length === 0) {
          node.innerHTML = `<div style="padding:8px;color:#34D399;background:rgba(34,197,94,0.05);border-radius:3px;text-align:center;">\u2713 No charges registered at Companies House</div>`;
          continue;
        }
        const outstanding = charges.filter(c => c.status === 'outstanding');
        node.innerHTML = charges.map(c => {
          const isOutstanding = c.status === 'outstanding';
          const color = isOutstanding ? '#ef4444' : '#22c55e';
          const bg = isOutstanding ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)';
          const lender = (c.persons_entitled && c.persons_entitled[0] && c.persons_entitled[0].name) || 'Lender unspecified';
          const created = c.created_on ? new Date(c.created_on).toLocaleDateString('en-GB') : '\u2014';
          const satisfied = c.satisfied_on ? new Date(c.satisfied_on).toLocaleDateString('en-GB') : null;
          const badge = isOutstanding
            ? '<span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:3px;font-size:9.5px;font-weight:700;">Credit to Review</span>'
            : '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:3px;font-size:9.5px;font-weight:700;">\u2713 Satisfied</span>';
          return `<div style="background:${bg};border-left:3px solid ${color};padding:7px 12px;margin-top:5px;border-radius:2px;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="color:#E5E7EB;font-weight:600;font-size:11px;">${sanitizeHtml(lender)}</div>
              <div style="color:#94A3B8;font-size:10px;margin-top:1px;">Charge ${sanitizeHtml(c.charge_number || c.charge_code || '')} \u00B7 Created ${created}${satisfied ? ' \u00B7 Satisfied ' + satisfied : ' \u00B7 Outstanding'}</div>
            </div>
            ${badge}
          </div>`;
        }).join('') + (outstanding.length > 0 ? `<div style="margin-top:6px;font-size:10px;color:#FBBF24;font-style:italic;">${outstanding.length} outstanding charge${outstanding.length > 1 ? 's' : ''} — Credit should review before Termsheet issue.</div>` : '');
      } catch (err) {
        node.innerHTML = `<span style="color:#F87171;">Error loading CH charges: ${sanitizeHtml(err.message || 'network')}</span>`;
      }
    }
  };

  // Fire the charges loader after matrix renders (defer to next tick so DOM is in place)
  setTimeout(() => { try { window.sgLoadCharges(); } catch (_) {} }, 150);

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

    // 2026-04-21: "Use Max" quick-fill button. Role-aware target column:
    //   broker (external) → writes to loan_amount_requested (their ask)
    //   RM/internal       → writes to loan_amount_approved  (their offer)
    // Button label reflects the target so the user knows what'll change.
    const _useMaxTarget = isInternalUser ? 'approved' : 'requested';
    const _useMaxLabel = isInternalUser ? 'Use Max &#8594; Approved' : 'Use Max &#8594; Requested';
    const useMaxButton = maxLoan > 0 && canEdit
      ? '<button onclick="window._applyMaxLoan(' + maxLoan + ', \'' + _useMaxTarget + '\')" style="padding:4px 10px;font-size:10px;font-weight:700;background:rgba(52,211,153,0.12);color:#34D399;border:1px solid rgba(52,211,153,0.3);border-radius:5px;cursor:pointer;" title="Auto-fill Loan Amount ' + _useMaxTarget.charAt(0).toUpperCase() + _useMaxTarget.slice(1) + ' with £' + maxLoan.toLocaleString() + '">' + _useMaxLabel + '</button>'
      : '';

    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
      + '<span style="color:#94A3B8;">Max Allowable Loan:</span>'
      + '<div style="display:flex;gap:8px;align-items:center;">'
      + useMaxButton
      + '<span style="font-weight:700;color:' + amtColor + ';">£' + maxLoan.toLocaleString() + '</span>'
      + '</div>'
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

  // ═══════════════════════════════════════════════════════════════════
  // M2b Matrix-SSOT 2026-04-20 — Retained-months conditional visibility + Day Zero readout
  // ═══════════════════════════════════════════════════════════════════

  // Hide/show the Retained Interest Months block based on Interest Servicing = retained
  window._toggleRetainedMonthsVisibility = function(servicingValue) {
    const wrapper = document.getElementById('retained-months-wrapper');
    if (!wrapper) return;
    const shouldShow = (servicingValue === 'retained' || servicingValue == null || servicingValue === '');
    wrapper.style.display = shouldShow ? '' : 'none';
    // When hiding, Day Zero must recompute with retainedInterest=0
    window._updateDayZeroPanel();
  };

  // Live Day Zero readout: Net Advance = Loan − Retained Interest − Arrangement Fee
  // Inputs pulled from current deal object + live form values (matrix is the canonical source).
  window._updateDayZeroPanel = function() {
    const panel = document.getElementById('day-zero-panel');
    if (!panel) return;

    const _num = (v) => {
      const n = parseFloat(String(v == null ? '' : v).replace(/[£,\s]/g, ''));
      return isFinite(n) ? n : 0;
    };
    const _readField = (fieldId) => {
      const el = document.getElementById(fieldId);
      if (el && 'value' in el) return _num(el.value);
      return 0;
    };

    // 2026-04-21: Day Zero is an Approved-side calculation. Pre-DIP (no
    // loan_amount_approved) the panel would render dashes — adds noise to the
    // broker's view without informational value. Hide entirely until RM has
    // entered an Approved loan amount; the panel reappears automatically on
    // next _updateDayZeroPanel() call (fired from matrixSaveField).
    const _approvedLoan = _readField('mf-loan_amount_approved') || _num(deal.loan_amount_approved);
    if (!_approvedLoan || _approvedLoan <= 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';

    const loan = _readField('mf-loan_amount_approved') || _num(deal.loan_amount_approved) || _num(deal.loan_amount);
    const rate = _readField('mf-rate_approved') || _num(deal.rate_approved) || _num(deal.rate_requested) || 1.10;
    const arrFeePct = _readField('mf-arrangement_fee_pct') || _num(deal.arrangement_fee_pct) || 2.00;

    // Interest servicing — check the select's current value
    const servicingEl = document.getElementById('mf-interest_servicing_approved');
    const servicing = servicingEl ? servicingEl.value : (deal.interest_servicing_approved || deal.interest_servicing || 'retained');

    const retainedMonths = servicing === 'retained'
      ? (_readField('mf-retained_interest_months') || _num(deal.retained_interest_months) || 6)
      : 0;

    const retainedInterest = servicing === 'retained' ? loan * (rate / 100) * retainedMonths : 0;
    const arrangementFee = loan * (arrFeePct / 100);

    // 2026-04-21: Commitment Fee is paid at Termsheet acceptance (before Day Zero)
    // and credited against the Arrangement Fee on completion. So on Day 1 the
    // borrower is effectively "up" by the commitment fee amount vs naive
    // Loan − Retained − Arrangement. Read from the matrix input (live) then
    // fall back to the deal object, then to the computed default (£5k policy).
    const _computedCf = (typeof computeCommitmentFee === 'function')
      ? computeCommitmentFee(loan)
      : 5000;
    const commitmentFee = _readField('mf-commitment_fee')
      || _num(deal.commitment_fee)
      || _computedCf
      || 5000;

    const netAdvance = Math.max(0, loan - retainedInterest - arrangementFee + commitmentFee);

    const _fmt = (n) => '£' + Math.round(n).toLocaleString();
    const setText = (id, s) => { const e = document.getElementById(id); if (e) e.textContent = s; };
    const setDisplay = (id, shown) => { const e = document.getElementById(id); if (e) e.style.display = shown ? '' : 'none'; };

    setText('dz-gross', loan > 0 ? _fmt(loan) : '—');
    setText('dz-retained', retainedInterest > 0 ? '−' + _fmt(retainedInterest) : '—');
    setText('dz-arr', arrangementFee > 0 ? '−' + _fmt(arrangementFee) : '—');
    // 2026-04-21: Commitment Fee credit row ALWAYS shows — default £5k policy
    // applies to every deal, and the transparency of displaying it on every DIP
    // is more valuable than hiding the row when it's zero.
    setText('dz-cf-credit', commitmentFee > 0 ? '+' + _fmt(commitmentFee) : '+£0');
    setText('dz-net', loan > 0 ? _fmt(netAdvance) : '—');

    // Retained row styling — grey out when not applicable
    const retainedLabel = document.getElementById('dz-retained-label');
    if (retainedLabel) {
      retainedLabel.style.opacity = servicing === 'retained' ? '1' : '0.4';
      retainedLabel.textContent = servicing === 'retained'
        ? 'Less: Retained Interest (' + retainedMonths + ' months)'
        : 'Less: Retained Interest (n/a — servicing: ' + servicing + ')';
    }

    // Explanation line
    const explain = document.getElementById('dz-explain');
    if (explain) {
      const cfBit = commitmentFee > 0
        ? ' Commitment Fee of £' + Math.round(commitmentFee).toLocaleString() + ' was paid at Termsheet acceptance and is credited back on Day 1 (net against the Arrangement Fee on completion).'
        : '';
      if (loan <= 0) {
        explain.textContent = 'Set an Approved Loan amount to see the Day Zero calculation.';
      } else if (servicing === 'retained') {
        explain.textContent = 'Formula: £' + Math.round(loan).toLocaleString() + ' × ' + rate.toFixed(3) + '%/mo × ' + retainedMonths + ' months = £' + Math.round(retainedInterest).toLocaleString() + ' retained; Arrangement ' + arrFeePct.toFixed(2) + '% = £' + Math.round(arrangementFee).toLocaleString() + '.' + cfBit + ' Valuation/legal costs are paid separately by borrower.';
      } else {
        explain.textContent = 'Interest Servicing is ' + servicing + ' — no upfront interest deduction. Arrangement Fee ' + arrFeePct.toFixed(2) + '% = £' + Math.round(arrangementFee).toLocaleString() + '.' + cfBit;
      }
    }
  };

  // Initial paint + wire it into the save flow (hooked in matrixValidateAndSave below by name)
  requestAnimationFrame(() => {
    try { window._updateDayZeroPanel(); } catch (_) {}
    // Hook Interest Servicing select change so visibility toggles immediately
    const servicingEl = document.getElementById('mf-interest_servicing_approved');
    if (servicingEl && !servicingEl.__daksHooked) {
      servicingEl.addEventListener('change', () => {
        window._toggleRetainedMonthsVisibility(servicingEl.value);
      });
      servicingEl.__daksHooked = true;
    }
  });

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
            ${!isEdit ? `
            <div style="grid-column:1/-1;padding:10px;background:rgba(78,161,255,0.06);border:1px solid rgba(78,161,255,0.2);border-radius:6px;">
              <label style="font-size:10px;color:#60A5FA;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">🔎 Royal Mail PAF address lookup (recommended)</label>
              <div id="pm-paf-mount" style="margin-top:6px;"></div>
              <div style="font-size:10px;color:#64748b;margin-top:4px;font-style:italic;">Type a postcode (e.g. W6 9RH) or part of an address. Pick from the dropdown to auto-fill the fields below + capture UPRN.</div>
            </div>
            ` : ''}
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

    // ─── PAF address autocomplete (new property only) ─────────────────────
    // When user picks a verified address: auto-fill the form fields + stash
    // the udprn in modal scope. After the property is saved (and we have
    // the new property_id), call /admin/property/select-address to attach
    // the PAF metadata (UPRN/UDPRN/lat/lng/raw) to the deal_properties row.
    let _pafSelectedUdprn = null;
    let _pafSelectedAddress = null;
    if (!isEdit) {
      const mountEl = document.getElementById('pm-paf-mount');
      if (mountEl) {
        mountAddressAutocomplete({
          containerEl: mountEl,
          // Don't pass property_id — property doesn't exist yet. Defer the
          // select-address call until after the property save returns its id.
          dealId: null,
          onSelect: (addr) => {
            _pafSelectedUdprn = addr.udprn;
            _pafSelectedAddress = addr;
            // Auto-populate the address + postcode fields
            const addressInput = document.getElementById('pm-address');
            const postcodeInput = document.getElementById('pm-postcode');
            if (addressInput) {
              const parts = [addr.line_1, addr.line_2, addr.line_3, addr.post_town]
                .filter(s => s && String(s).trim());
              addressInput.value = parts.join(', ');
            }
            if (postcodeInput) postcodeInput.value = addr.postcode || '';
          },
        });
      }
    }

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
          // PAF post-save attach (new property only) — fire-and-forget; the
          // property is already saved, this just enriches it. Fail silently
          // if it doesn't work; user sees the address they typed/picked.
          const newPropertyId = data.property?.id || data.id || null;
          if (!isEdit && _pafSelectedUdprn && newPropertyId) {
            try {
              await fetchWithAuth(`${API_BASE}/api/admin/property/select-address`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  property_id: newPropertyId,
                  deal_id: data.property?.deal_id || null,
                  udprn: _pafSelectedUdprn,
                }),
              });
            } catch (pafErr) {
              console.warn('[paf-attach] non-fatal:', pafErr.message);
            }
          }
          document.getElementById('dkf-property-modal').remove();
          showToast(isEdit ? 'Property updated' : (_pafSelectedUdprn ? 'Property added (PAF verified)' : 'Property added'), 'success');
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
    // Decide which roles the user can pick based on context:
    //   - Edit mode: all roles
    //   - Adding a child of a corporate party: director/psc/ubo/shareholder only
    //   - Adding a guarantor (top-level): role is locked to 'guarantor' — hidden from UI
    //   - Generic add: all roles
    const isChildAdd = !isEdit && v && v.parent_borrower_id != null;
    const isGuarantorAdd = !isEdit && v && v.role === 'guarantor' && v.parent_borrower_id == null;
    const isJointAdd = !isEdit && v && ['joint','primary'].includes(v.role) && v.parent_borrower_id == null && v.role !== 'guarantor';
    let allowedRoles;
    if (isChildAdd) {
      // Children of a corporate party can only be director / PSC / UBO / shareholder
      allowedRoles = ['director','psc','ubo','shareholder'];
    } else if (isJointAdd) {
      // Joint borrower flow: only primary / joint — no guarantor or officer roles
      allowedRoles = ['primary','joint'];
    } else {
      allowedRoles = Object.keys(roleOptLabels);
    }
    const roleOpts = allowedRoles.map(r =>
      `<option value="${r}" ${v.role === r ? 'selected' : ''}>${roleOptLabels[r] || r}</option>`
    ).join('');
    // Whether to hide the Role selector entirely (only for top-level guarantor add)
    const hideRoleUI = isGuarantorAdd;

    // Type dropdown — filter based on context:
    //   - Edit mode: all types
    //   - Children (parent_borrower_id set): only Individual (directors/PSCs/UBOs are always people)
    //   - Guarantor add with borrower_type === 'individual': only Individual
    //   - Guarantor add with borrower_type === 'corporate': only corporate-family variants (no Individual)
    //   - Generic add (no defaults): all types
    const allCorpTypes = ['corporate','spv','llp','trust','partnership'];
    let allowedTypes;
    if (isEdit) {
      allowedTypes = ['individual', ...allCorpTypes];
    } else if (isChildAdd) {
      allowedTypes = ['individual'];
    } else if (isGuarantorAdd && v.borrower_type === 'individual') {
      allowedTypes = ['individual'];
    } else if (isGuarantorAdd && allCorpTypes.includes(v.borrower_type)) {
      allowedTypes = allCorpTypes;
    } else {
      allowedTypes = ['individual', ...allCorpTypes];
    }
    // If a specific type is preset and it's not in allowedTypes, fall back to first allowed
    const selectedType = allowedTypes.includes(v.borrower_type) ? v.borrower_type : allowedTypes[0];
    const typeOpts = allowedTypes.map(t =>
      `<option value="${t}" ${selectedType === t ? 'selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
    ).join('');

    // Nationality list — common UK/EU/global nationalities (source: ISO 3166 country name adjective forms)
    const _nationalities = [
      'British','American','Irish','French','German','Italian','Spanish','Portuguese','Dutch','Belgian',
      'Swiss','Austrian','Swedish','Norwegian','Danish','Finnish','Icelandic','Polish','Romanian','Bulgarian',
      'Czech','Slovak','Hungarian','Croatian','Serbian','Slovenian','Greek','Cypriot','Maltese','Turkish',
      'Russian','Ukrainian','Belarusian','Estonian','Latvian','Lithuanian','Luxembourger','Albanian','Bosnian',
      'Indian','Pakistani','Bangladeshi','Sri Lankan','Nepalese','Chinese','Hong Kong','Japanese','South Korean',
      'Taiwanese','Singaporean','Malaysian','Indonesian','Filipino','Thai','Vietnamese','Australian','New Zealander',
      'Canadian','Mexican','Brazilian','Argentine','Chilean','Colombian','Peruvian','Venezuelan',
      'Nigerian','Ghanaian','Kenyan','South African','Egyptian','Moroccan','Algerian','Tunisian','Ethiopian',
      'Lebanese','Jordanian','Syrian','Israeli','Iranian','Iraqi','Saudi','Emirati','Qatari','Kuwaiti','Bahraini','Omani',
      'Afghan','Kazakhstani','Uzbek','Georgian','Armenian','Azerbaijani','Other'
    ];
    const natOpts = '<option value="">— Select —</option>' +
      _nationalities.map(n => `<option value="${n}" ${v.nationality === n ? 'selected' : ''}>${n}</option>`).join('');

    const isCorporateType = (t) => ['corporate','spv','ltd','llp','limited','trust','partnership'].includes(t || '');
    const initialIsCorporate = isCorporateType(v.borrower_type);

    const modalHtml = `
      <div id="dkf-borrower-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1E293B;border:1px solid rgba(212,168,83,0.3);border-radius:12px;padding:24px;width:90%;max-width:520px;max-height:85vh;overflow-y:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="font-size:16px;font-weight:700;color:#F1F5F9;">${title}</span>
            <button onclick="document.getElementById('dkf-borrower-modal').remove()" style="background:none;border:none;color:#94A3B8;font-size:20px;cursor:pointer;">&times;</button>
          </div>

          <!-- Role + Type — Role is hidden (locked) when user clicked a specific Add button for Guarantor -->
          ${hideRoleUI ? `
          <input type="hidden" id="bm-role" value="${v.role || 'guarantor'}" />
          <div style="margin-bottom:10px;">
            <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Type *</label>
            <select id="bm-borrower_type" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
              ${typeOpts}
            </select>
          </div>
          ` : `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
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
          </div>
          `}

          <!-- Corporate-only section — live CH search by name -->
          <div id="bm-corporate-section" style="display:${initialIsCorporate ? 'block' : 'none'};margin-bottom:10px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div style="grid-column:1/-1;position:relative;">
                <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Company Name * <span style="color:#D4A853;font-weight:400;">(type to search Companies House)</span></label>
                <input id="bm-company_name" autocomplete="off" value="${_escAttr(v.company_name || '')}" placeholder="Start typing company name..." style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
                <div id="bm-ch-search-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:#0F172A;border:1px solid rgba(212,168,83,0.4);border-radius:6px;margin-top:2px;max-height:220px;overflow-y:auto;z-index:10001;box-shadow:0 4px 12px rgba(0,0,0,0.4);"></div>
              </div>
              <div>
                <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Company Number *</label>
                <input id="bm-company_number" value="${_escAttr(v.company_number || '')}" placeholder="e.g. 12345678" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
              </div>
              <div>
                <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Jurisdiction</label>
                <input id="bm-jurisdiction" value="${_escAttr(v.jurisdiction || 'England & Wales')}" placeholder="e.g. England & Wales" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
              </div>
            </div>
            <div style="margin-top:8px;font-size:10px;color:#64748B;">Directors, PSCs and registered address will be auto-populated after saving via Companies House verify.</div>
          </div>

          <!-- Individual-only section -->
          <div id="bm-individual-section" style="display:${initialIsCorporate ? 'none' : 'block'};">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
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
                <select id="bm-nationality" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;">
                  ${natOpts}
                </select>
              </div>
              <div style="grid-column:1/-1;">
                <label style="font-size:10px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Residential Address</label>
                <input id="bm-address" value="${_escAttr(v.address || v.residential_address || '')}" placeholder="Full residential address" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:13px;box-sizing:border-box;" />
              </div>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
            <button onclick="document.getElementById('dkf-borrower-modal').remove()" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#94A3B8;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
            <button id="bm-save-btn" style="padding:8px 20px;background:#D4A853;border:none;border-radius:6px;color:#0B1120;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'Save Changes' : `Add ${roleLabel}`}</button>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Toggle individual vs corporate sections when Type changes
    const typeEl = document.getElementById('bm-borrower_type');
    const indSec = document.getElementById('bm-individual-section');
    const corpSec = document.getElementById('bm-corporate-section');
    typeEl.addEventListener('change', () => {
      const corporate = isCorporateType(typeEl.value);
      indSec.style.display = corporate ? 'none' : 'block';
      corpSec.style.display = corporate ? 'block' : 'none';
    });

    // Companies House live search — debounced as user types in company name
    const nameInput = document.getElementById('bm-company_name');
    const numberInput = document.getElementById('bm-company_number');
    const resultsBox = document.getElementById('bm-ch-search-results');
    let _chSearchTimer = null;
    let _chSearchToken = 0;

    const hideResults = () => { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; };

    nameInput.addEventListener('input', () => {
      const q = nameInput.value.trim();
      if (_chSearchTimer) clearTimeout(_chSearchTimer);
      if (q.length < 2) { hideResults(); return; }
      _chSearchToken++;
      const myToken = _chSearchToken;
      _chSearchTimer = setTimeout(async () => {
        try {
          const res = await fetchWithAuth(`${API_BASE}/api/companies-house/search?q=${encodeURIComponent(q)}`);
          if (myToken !== _chSearchToken) return; // stale response
          if (!res.ok) { hideResults(); return; }
          const data = await res.json();
          const results = (data.results || []).slice(0, 8);
          if (results.length === 0) { hideResults(); return; }
          resultsBox.innerHTML = results.map(r => {
            const status = r.company_status ? `<span style="color:${r.company_status === 'active' ? '#34D399' : '#F87171'};font-size:10px;text-transform:capitalize;">${r.company_status}</span>` : '';
            const addr = r.address_snippet ? `<div style="font-size:10px;color:#64748B;margin-top:2px;">${(r.address_snippet + '').replace(/[<>"]/g, '')}</div>` : '';
            return `<div class="bm-ch-hit" data-num="${r.company_number}" data-name="${(r.company_name + '').replace(/"/g, '&quot;')}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div>
                  <div style="font-size:12px;color:#F1F5F9;font-weight:600;">${(r.company_name + '').replace(/[<>"]/g, '')}</div>
                  ${addr}
                </div>
                <div style="text-align:right;white-space:nowrap;">
                  <div style="font-size:11px;color:#D4A853;font-weight:600;">${r.company_number}</div>
                  ${status}
                </div>
              </div>
            </div>`;
          }).join('');
          resultsBox.style.display = 'block';
          // Hook click handlers
          resultsBox.querySelectorAll('.bm-ch-hit').forEach(el => {
            el.addEventListener('mouseenter', () => { el.style.background = 'rgba(212,168,83,0.12)'; });
            el.addEventListener('mouseleave', () => { el.style.background = ''; });
            el.addEventListener('mousedown', (e) => {
              e.preventDefault(); // don't blur the input before click registers
              nameInput.value = el.getAttribute('data-name') || '';
              numberInput.value = el.getAttribute('data-num') || '';
              hideResults();
            });
          });
        } catch (err) { console.warn('[bm-ch-search]', err); hideResults(); }
      }, 300);
    });
    // Hide search results when clicking outside
    nameInput.addEventListener('blur', () => { setTimeout(hideResults, 200); });

    document.getElementById('bm-save-btn').addEventListener('click', async () => {
      const selectedType = document.getElementById('bm-borrower_type').value;
      const isCorp = isCorporateType(selectedType);

      // Common fields
      const payload = {
        role: document.getElementById('bm-role').value,
        borrower_type: selectedType
      };

      // ── Defensive role validation — stops cross-flow accidents (e.g. a joint-borrower save
      //    ending up as a guarantor because something weird happened to the dropdown) ──
      if (isJointAdd && !['primary','joint'].includes(payload.role)) {
        showToast('Joint borrower flow allows only Primary or Joint role', 'error'); return;
      }
      if (isGuarantorAdd && payload.role !== 'guarantor') {
        showToast('Guarantor flow requires role = Guarantor', 'error'); return;
      }
      if (isChildAdd && !['director','psc','ubo','shareholder'].includes(payload.role)) {
        showToast('Directors/PSCs/UBOs/Shareholders are the only valid roles for a child of a corporate party', 'error'); return;
      }

      if (isCorp) {
        // Corporate — only name + number + jurisdiction. Rest will be pulled from CH.
        const cname = document.getElementById('bm-company_name').value.trim();
        const cnum = document.getElementById('bm-company_number').value.trim();
        if (!cname) { showToast('Company Name is required', 'error'); return; }
        if (!cnum) { showToast('Company Number is required', 'error'); return; }
        payload.company_name = cname;
        payload.company_number = cnum;
        payload.full_name = cname; // DB requires full_name NOT NULL — use company name for corporates
        payload.jurisdiction = document.getElementById('bm-jurisdiction').value.trim() || null;
      } else {
        // Individual — personal identity fields only
        const fullName = document.getElementById('bm-full_name').value.trim();
        if (!fullName) { showToast('Full Name is required', 'error'); return; }
        payload.full_name = fullName;
        payload.email = document.getElementById('bm-email').value.trim() || null;
        payload.phone = document.getElementById('bm-phone').value.trim() || null;
        payload.date_of_birth = document.getElementById('bm-dob').value || null;
        payload.nationality = document.getElementById('bm-nationality').value || null;
        payload.address = document.getElementById('bm-address').value.trim() || null;
      }

      // Preserve parent_borrower_id if it was passed as a default
      if (v.parent_borrower_id !== undefined) {
        payload.parent_borrower_id = v.parent_borrower_id;
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
          // Toast reflects the role actually saved (Guarantor / Director / PSC / UBO / Shareholder / Borrower)
          const savedRole = (data.borrower && data.borrower.role) || payload.role || 'borrower';
          const _lbl = { primary:'Borrower', joint:'Joint Borrower', guarantor:'Guarantor', director:'Director', ubo:'UBO', psc:'PSC', shareholder:'Shareholder' };
          const savedLabel = _lbl[savedRole] || 'Borrower';
          showToast(isEdit ? `${savedLabel} updated` : `${savedLabel} added`, 'success');
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

  // Add another top-level co-borrower (primary / joint). Distinct from adding a director/PSC to a company.
  window.addJointBorrower = function(submissionId) {
    _showBorrowerModal(submissionId, null, { role: 'joint' });
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

  // ═══════════════════════════════════════════════════════════════════════
  // PARTY RELATIONSHIPS ANALYSIS (Phase G4)
  // Runs after CH data is loaded for 2+ corporate parties. Detects shared PSCs,
  // shared directors, corporate-entity PSCs pointing to other parties, common
  // registered offices, new-SPV flags, and SIC overlaps.
  // ═══════════════════════════════════════════════════════════════════════

  // Normalize a person's name for cross-party matching (strip titles, punctuation, case).
  function _pr_normalizeName(name) {
    if (!name) return '';
    return String(name).toLowerCase()
      .replace(/,/g, ' ')
      .replace(/\b(mr|mrs|ms|miss|dr|prof|sir|dame|lord|lady)\.?\b/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Normalize a CH registered office address to a postcode-level key for matching.
  function _pr_addressKey(addr) {
    if (!addr || typeof addr !== 'object') return '';
    const pc = (addr.postal_code || '').replace(/\s+/g, '').toUpperCase();
    const line = (addr.address_line_1 || addr.line_1 || '').toLowerCase().trim();
    if (!pc) return '';
    // Match building/floor + postcode — not just postcode alone (same postcode can have many buildings)
    return line + '|' + pc;
  }

  // Format an address for display.
  function _pr_addressDisplay(addr) {
    if (!addr) return '—';
    const parts = [addr.address_line_1 || addr.line_1, addr.locality, addr.postal_code, addr.country].filter(Boolean);
    return parts.join(', ');
  }

  // Core analysis: given an array of { role, company_name, company_number, verification } objects,
  // returns an array of finding objects with { type, severity, ... }.
  function _analyzePartyRelationships(corporateParties) {
    const findings = [];
    if (!Array.isArray(corporateParties) || corporateParties.length < 2) return findings;

    // Flatten all officers + PSCs across parties, tagged with their source party
    const allOfficers = [];
    const allPSCs = [];
    for (const party of corporateParties) {
      const v = party.verification || {};
      (v.officers || []).forEach(o => allOfficers.push(Object.assign({}, o, { _party: party })));
      (v.pscs || []).forEach(p => allPSCs.push(Object.assign({}, p, { _party: party })));
    }

    // ── 1. SHARED PSCs (individuals appearing as PSC at 2+ parties) ──
    const pscByName = {};
    allPSCs.filter(p => p.kind !== 'corporate-entity-with-significant-control' && p.kind !== 'legal-person-with-significant-control').forEach(p => {
      const key = _pr_normalizeName(p.name);
      if (!key) return;
      if (!pscByName[key]) pscByName[key] = [];
      pscByName[key].push(p);
    });
    const sharedPscNames = new Set();
    for (const [key, pscs] of Object.entries(pscByName)) {
      const uniqueCos = [...new Set(pscs.map(p => p._party.company_number))];
      if (uniqueCos.length < 2) continue;
      sharedPscNames.add(key);
      // Group PSCs by company_number so the same person doesn't render twice per company.
      // Merge their natures_of_control into a single set.
      const byCoPSC = {};
      pscs.forEach(p => {
        const cn = p._party.company_number;
        if (!byCoPSC[cn]) byCoPSC[cn] = { party: p._party, natures: new Set() };
        (Array.isArray(p.natures_of_control) ? p.natures_of_control : []).forEach(n => byCoPSC[cn].natures.add(n));
      });
      findings.push({
        type: 'shared_psc', severity: 'high', icon: '\u{1F517}',
        title: 'Shared PSC \u2014 consolidated control',
        person: pscs[0].name,
        instances: Object.values(byCoPSC).map(entry => ({
          company: entry.party.company_name,
          role: entry.party.role,
          natures: [...entry.natures]
        })),
        // TODO: align with Daksfirst Credit Policy v6.0 — generic industry note below
        credit_note: 'Same individual holds significant control in multiple corporate parties. Loan is NOT diversified at UBO level; default correlation should be treated as consolidated.'
      });
    }

    // ── 2. SHARED DIRECTORS (not also PSC — already captured above) ──
    const officerByName = {};
    allOfficers.forEach(o => {
      const key = _pr_normalizeName(o.name);
      if (!key) return;
      if (!officerByName[key]) officerByName[key] = [];
      officerByName[key].push(o);
    });
    for (const [key, officers] of Object.entries(officerByName)) {
      if (sharedPscNames.has(key)) continue; // avoid duplicate with shared-PSC finding
      const uniqueCos = [...new Set(officers.map(o => o._party.company_number))];
      if (uniqueCos.length < 2) continue;
      // Group by company — merge multiple officer roles at the same co (e.g. "director + secretary")
      const byCoOff = {};
      officers.forEach(o => {
        const cn = o._party.company_number;
        if (!byCoOff[cn]) byCoOff[cn] = { party: o._party, officer_roles: new Set() };
        if (o.officer_role) byCoOff[cn].officer_roles.add(o.officer_role);
      });
      findings.push({
        type: 'shared_director', severity: 'medium', icon: '\u{1F465}',
        title: 'Shared Director (no PSC link)',
        person: officers[0].name,
        instances: Object.values(byCoOff).map(entry => ({
          company: entry.party.company_name,
          role: entry.party.role,
          officer_role: [...entry.officer_roles].join(' + ') || 'officer'
        })),
        // TODO: align with Daksfirst Credit Policy v6.0
        credit_note: 'Same individual directs multiple corporate parties without being PSC at each. Governance concentration — possibly a professional / nominee director arrangement.'
      });
    }

    // ── 3. CORPORATE-ENTITY PSC pointing to another party on this deal ──
    // CH returns the corporate PSC name in `name`. Match by normalizing vs other parties' company_name.
    const partiesByNameKey = {};
    corporateParties.forEach(p => {
      const key = _pr_normalizeName(p.company_name);
      if (key) partiesByNameKey[key] = p;
    });
    allPSCs.filter(p => p.kind === 'corporate-entity-with-significant-control').forEach(corpPSC => {
      const key = _pr_normalizeName(corpPSC.name);
      const parent = partiesByNameKey[key];
      if (!parent) return;
      if (parent.company_number === corpPSC._party.company_number) return; // self-reference
      findings.push({
        type: 'corporate_parent', severity: 'high', icon: '\u{1F3E2}',
        title: 'Corporate parent detected',
        parent_party: { name: parent.company_name, role: parent.role, company_number: parent.company_number },
        child_party: { name: corpPSC._party.company_name, role: corpPSC._party.role, company_number: corpPSC._party.company_number },
        natures: Array.isArray(corpPSC.natures_of_control) ? corpPSC.natures_of_control : [],
        // TODO: align with Daksfirst Credit Policy v6.0
        credit_note: 'One party on this deal is listed as a significant-control corporate PSC of another. Parent/subsidiary relationship confirmed. Group guarantee effectively covers upstream cash flows.'
      });
    });

    // ── 4. COMMON REGISTERED OFFICE ──
    const officeGroups = {};
    for (const party of corporateParties) {
      const v = party.verification || {};
      const addr = v.registered_office_address || v.address;
      const key = _pr_addressKey(addr);
      if (!key) continue;
      if (!officeGroups[key]) officeGroups[key] = [];
      officeGroups[key].push({ party, address: addr });
    }
    for (const [key, group] of Object.entries(officeGroups)) {
      if (group.length < 2) continue;
      findings.push({
        type: 'common_office', severity: 'low', icon: '\u{1F3E0}',
        title: 'Common Registered Office',
        address: _pr_addressDisplay(group[0].address),
        parties: group.map(g => ({ name: g.party.company_name, role: g.party.role })),
        // TODO: align with Daksfirst Credit Policy v6.0
        credit_note: 'Shared registered office. Often indicates the same formation agent or an intragroup structure; not conclusive ownership evidence, but worth cross-checking PSCs.'
      });
    }

    // ── 5. NEW SPV (< 6 months since incorporation) ──
    for (const party of corporateParties) {
      const v = party.verification || {};
      if (!v.incorporated_on) continue;
      const ageMs = Date.now() - new Date(v.incorporated_on).getTime();
      const ageMonths = Math.floor(ageMs / (30.44 * 24 * 60 * 60 * 1000));
      if (ageMonths < 0 || ageMonths >= 6) continue;
      findings.push({
        type: 'new_spv', severity: 'medium', icon: '\u{1F4C5}',
        title: 'New SPV',
        party: { name: party.company_name, role: party.role, company_number: party.company_number },
        age_months: ageMonths,
        incorporated_on: v.incorporated_on,
        // TODO: align with Daksfirst Credit Policy v6.0
        credit_note: 'Incorporated less than 6 months ago \u2014 no filed accounts yet (first accounts due ~21 months post-incorporation per Companies Act 2006 s.442). Financial analysis must rely on business plan, bank statements, and director/PSC trading history.'
      });
    }

    // ── 6. SIC CODE overlap ──
    const sicCount = {};
    for (const party of corporateParties) {
      const sics = Array.isArray((party.verification || {}).sic_codes) ? party.verification.sic_codes : [];
      for (const s of sics) {
        if (!sicCount[s]) sicCount[s] = new Set();
        sicCount[s].add(party.company_number);
      }
    }
    const sharedSics = Object.entries(sicCount).filter(([, set]) => set.size >= 2).map(([code, set]) => ({ code, count: set.size }));
    if (sharedSics.length > 0 && corporateParties.length >= 2) {
      findings.push({
        type: 'sic_overlap', severity: 'low', icon: '\u{1F3E2}',
        title: 'SIC overlap across parties',
        shared_sics: sharedSics,
        // TODO: align with Daksfirst Credit Policy v6.0
        credit_note: 'All flagged parties operate in overlapping sectors per their SIC 2007 codes. Indicates portfolio-level exposure \u2014 not sector-diversified.'
      });
    }

    // Sort by severity (high first)
    const sevRank = { high: 3, medium: 2, low: 1 };
    findings.sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0));
    return findings;
  }

  // Render findings as HTML. Returns '' when fewer than 2 corporate parties.
  function _renderPartyRelationshipsPanel(findings, corporateCount, corporateParties) {
    if (corporateCount < 2) return ''; // nothing to compare

    const sevColor = { high: '#F87171', medium: '#FBBF24', low: '#34D399' };
    const sevBg = { high: 'rgba(248,113,113,0.08)', medium: 'rgba(251,191,36,0.06)', low: 'rgba(52,211,153,0.05)' };
    let overallSev = 'low';
    if (findings.some(f => f.severity === 'high')) overallSev = 'high';
    else if (findings.some(f => f.severity === 'medium')) overallSev = 'medium';

    const borderColor = findings.length === 0 ? '#34D399' : sevColor[overallSev];
    const bgColor = findings.length === 0 ? 'rgba(52,211,153,0.04)' : sevBg[overallSev];

    const headerText = findings.length === 0
      ? '\u2713 Parties appear independent'
      : overallSev === 'high' ? 'Review required \u2014 consolidated control detected'
      : overallSev === 'medium' ? 'Review required \u2014 governance overlap'
      : 'Minor overlap \u2014 informational';

    const partiesList = corporateParties.map(p =>
      '<span style="display:inline-block;padding:2px 8px;background:rgba(255,255,255,0.04);border-radius:10px;font-size:10px;color:#CBD5E1;margin-right:4px;">' +
      sanitizeHtml(p.company_name) + ' <span style="color:#64748B;">\u00B7 ' + p.role + '</span></span>'
    ).join('');

    const findingsHtml = findings.length === 0
      ? '<p style="font-size:12px;color:#34D399;margin:8px 0 0 0;">No shared controllers, directors, corporate-parent links, or common offices detected between the ' + corporateCount + ' corporate parties. Parties appear independent based on Companies House records.</p>'
      : findings.map(f => {
          let body = '';
          if (f.type === 'shared_psc' || f.type === 'shared_director') {
            body = '<div style="font-size:12px;color:#F1F5F9;font-weight:700;margin:4px 0 2px;">' + sanitizeHtml(f.person) + '</div>' +
              '<ul style="margin:2px 0 6px 18px;padding:0;font-size:11px;color:#CBD5E1;">' +
              f.instances.map(i => '<li>' + sanitizeHtml(i.company) + ' <span style="color:#64748B;">(' + i.role + (i.officer_role ? ' \u00B7 ' + i.officer_role : '') + ')</span>' +
                (Array.isArray(i.natures) && i.natures.length > 0 ? ' <span style="font-size:10px;color:#94A3B8;">\u2014 ' + i.natures.map(n => sanitizeHtml(n.replace(/-/g, ' '))).join(', ') + '</span>' : '') +
              '</li>').join('') +
              '</ul>';
          } else if (f.type === 'corporate_parent') {
            body = '<div style="font-size:12px;color:#F1F5F9;font-weight:700;margin:4px 0 2px;">' + sanitizeHtml(f.parent_party.name) + ' \u2192 parent of \u2192 ' + sanitizeHtml(f.child_party.name) + '</div>' +
              '<div style="font-size:11px;color:#CBD5E1;margin-bottom:4px;">Roles on deal: ' + f.parent_party.role + ' \u2194 ' + f.child_party.role + '</div>' +
              (f.natures.length > 0 ? '<div style="font-size:10px;color:#94A3B8;">Control type: ' + f.natures.map(n => sanitizeHtml(n.replace(/-/g, ' '))).join(', ') + '</div>' : '');
          } else if (f.type === 'common_office') {
            body = '<div style="font-size:11px;color:#CBD5E1;margin:4px 0 2px;">' + sanitizeHtml(f.address) + '</div>' +
              '<div style="font-size:11px;color:#94A3B8;">Parties: ' + f.parties.map(p => sanitizeHtml(p.name) + ' (' + p.role + ')').join(' \u00B7 ') + '</div>';
          } else if (f.type === 'new_spv') {
            body = '<div style="font-size:12px;color:#F1F5F9;font-weight:700;margin:4px 0 2px;">' + sanitizeHtml(f.party.name) + ' \u00B7 ' + f.party.role + '</div>' +
              '<div style="font-size:11px;color:#CBD5E1;">Incorporated ' + new Date(f.incorporated_on).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) + ' (' + f.age_months + ' month' + (f.age_months === 1 ? '' : 's') + ' old)</div>';
          } else if (f.type === 'sic_overlap') {
            body = '<div style="font-size:11px;color:#CBD5E1;margin:4px 0;">Shared SIC codes: ' +
              f.shared_sics.map(s => '<span style="color:#D4A853;font-family:monospace;font-weight:700;">' + s.code + '</span> <span style="color:#64748B;">(' + s.count + ' parties)</span>').join(' \u00B7 ') + '</div>';
          }
          return '<div style="margin:10px 0;padding:10px 12px;background:' + sevBg[f.severity] + ';border-left:3px solid ' + sevColor[f.severity] + ';border-radius:4px;">' +
            '<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:15px;">' + f.icon + '</span>' +
            '<span style="font-size:12px;font-weight:700;color:' + sevColor[f.severity] + ';text-transform:uppercase;letter-spacing:.3px;">' + sanitizeHtml(f.title) + '</span>' +
            '<span style="font-size:9px;color:#64748B;margin-left:auto;text-transform:uppercase;">' + f.severity + '</span></div>' +
            body +
            '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.05);font-size:11px;color:#94A3B8;font-style:italic;">Credit read: ' + sanitizeHtml(f.credit_note) + '</div>' +
          '</div>';
        }).join('');

    // Default collapsed — severity is conveyed by border colour and header text.
    // Click the header to expand findings. User explicitly asked for this to reduce visual noise.
    const findingCount = findings.length;
    const summaryChip = findingCount > 0
      ? '<span style="font-size:10px;color:' + borderColor + ';font-weight:700;background:' + (bgColor) + ';padding:2px 8px;border-radius:10px;margin-left:8px;">' + findingCount + ' finding' + (findingCount === 1 ? '' : 's') + '</span>'
      : '';

    return '<div id="party-relationships-panel" style="margin:10px 0 14px 0;background:#111827;border:1px solid ' + borderColor + ';border-radius:10px;padding:12px 16px;">' +
      '<div onclick="window._togglePartyRelationships()" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;flex-wrap:wrap;gap:6px;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
            '<span style="font-size:10px;color:' + borderColor + ';text-transform:uppercase;font-weight:700;letter-spacing:.4px;">Party Relationships \u00B7 ' + corporateCount + ' corporate parties</span>' +
            summaryChip +
          '</div>' +
          '<div style="font-size:13px;color:#F1F5F9;font-weight:700;margin-top:2px;">' + headerText + '</div>' +
        '</div>' +
        '<span id="party-rel-chevron" style="color:#64748B;font-size:11px;transition:transform .2s;flex-shrink:0;">\u25BC</span>' +
      '</div>' +
      '<div id="party-rel-body" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);">' +
        '<div style="font-size:10px;color:#64748B;margin-bottom:6px;">' + partiesList + '</div>' +
        findingsHtml +
      '</div>' +
    '</div>';
  }

  // Toggle the Party Relationships panel expand/collapse (default: collapsed).
  window._togglePartyRelationships = function() {
    const body = document.getElementById('party-rel-body');
    const chevron = document.getElementById('party-rel-chevron');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
  };

  // Orchestrator: collect all corporate parties, fetch CH data as needed, analyze, inject panel.
  // Called after deal-matrix HTML is inserted into DOM. Safe to call multiple times.
  window._loadAndRenderPartyRelationships = async function(deal) {
    try {
      if (!deal) return;
      const placeholder = document.getElementById('party-relationships-panel-placeholder');
      if (!placeholder) return;

      const _corpTypesPR = ['corporate','spv','ltd','llp','limited','trust','partnership'];
      const _isCorpPR = (t) => _corpTypesPR.includes((t || '').toLowerCase());

      const parties = [];
      // Primary corporate (stored on deal, not deal_borrowers)
      if (_isCorpPR(deal.borrower_type) && deal.company_number) {
        parties.push({ source: 'primary', role: 'Primary Borrower', company_name: deal.company_name, company_number: deal.company_number, verification: null });
      }
      // Joint + Guarantor corporates from deal_borrowers
      for (const b of (deal.borrowers || [])) {
        if (b.parent_borrower_id) continue; // only top-level parties
        if (!_isCorpPR(b.borrower_type)) continue;
        if (!b.company_number) continue;
        let v = b.ch_match_data;
        if (v && typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
        // Only accept if it looks like a full verification payload (has officers/pscs or company_number)
        if (v && (v.officers || v.pscs || v.company_number)) {
          parties.push({
            source: b.role === 'guarantor' ? 'guarantor' : 'joint',
            role: b.role === 'guarantor' ? 'Corporate Guarantor' : 'Joint Borrower',
            company_name: b.company_name,
            company_number: b.company_number,
            verification: v
          });
        } else {
          // Not CH-verified yet — include placeholder so the count is accurate but skip analysis for this party
          parties.push({
            source: b.role === 'guarantor' ? 'guarantor' : 'joint',
            role: b.role === 'guarantor' ? 'Corporate Guarantor' : 'Joint Borrower',
            company_name: b.company_name,
            company_number: b.company_number,
            verification: null
          });
        }
      }

      // Deduplicate by company_number — same company should never appear twice (e.g. as both
      // Primary AND Joint Borrower — that's a stale data row, not two separate parties).
      // Keep the first occurrence (which is the primary, since we push primary first).
      const seenCoNos = new Set();
      const partiesDeduped = parties.filter(p => {
        const cn = (p.company_number || '').toUpperCase().replace(/\s+/g, '');
        if (!cn) return true;
        if (seenCoNos.has(cn)) {
          console.warn('[party-relationships] duplicate company_number deduped:', cn, p.company_name, '(' + p.role + ')');
          return false;
        }
        seenCoNos.add(cn);
        return true;
      });
      // Replace the array contents
      parties.length = 0;
      partiesDeduped.forEach(p => parties.push(p));

      if (parties.length < 2) {
        placeholder.innerHTML = ''; // hide entirely when only 1 (or 0) corporate parties
        return;
      }

      // Fetch CH data for any party missing verification (typically just the primary)
      const needsFetch = parties.filter(p => !p.verification);
      if (needsFetch.length > 0) {
        placeholder.innerHTML = '<div style="margin:8px 0;padding:10px 12px;background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-size:11px;color:#94A3B8;">Loading Companies House data for relationship analysis\u2026</div>';
        await Promise.all(needsFetch.map(async p => {
          try {
            const resp = await fetchWithAuth(API_BASE + '/api/companies-house/verify/' + encodeURIComponent(p.company_number));
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && data.verification && data.verification.found) {
              p.verification = data.verification;
            }
          } catch (_) { /* ignore */ }
        }));
      }

      const readyParties = parties.filter(p => p.verification);
      if (readyParties.length < 2) {
        placeholder.innerHTML = '<div style="margin:8px 0;padding:10px 12px;background:rgba(251,191,36,0.04);border:1px solid rgba(251,191,36,0.18);border-radius:8px;font-size:11px;color:#FBBF24;">Relationship analysis needs at least 2 corporate parties with completed Companies House verification. Verify the remaining corporate ' + (parties.length - readyParties.length) + ' part' + (parties.length - readyParties.length === 1 ? 'y' : 'ies') + ' to see the analysis.</div>';
        return;
      }

      const findings = _analyzePartyRelationships(readyParties);
      placeholder.innerHTML = _renderPartyRelationshipsPanel(findings, readyParties.length, readyParties);
    } catch (err) {
      console.warn('[party-relationships] analysis failed:', err);
    }
  };

  // Toggle the CH detail panel for a specific corporate guarantor (lazy-loaded on first open)
  // Mirrors _toggleChVerifiedDetail for primary borrower but keyed per-guarantor-id so multiple
  // corporate guarantors each have their own expandable panel.
  window._toggleCorpGuarChDetail = async function(companyNumber, guarantorId) {
    const detail = document.getElementById('ch-cg-detail-' + guarantorId);
    const arrow = document.getElementById('ch-cg-arrow-' + guarantorId);
    const panel = document.getElementById('ch-cg-panel-' + guarantorId);
    if (!detail || !panel) return;
    const isOpen = detail.style.maxHeight !== '0px' && detail.style.maxHeight !== '';

    if (isOpen) {
      detail.style.maxHeight = '0px';
      if (arrow) arrow.style.transform = 'rotate(0deg)';
      return;
    }

    // Expand — lazy-load on first open (cache via data-attribute)
    if (!panel.dataset.loaded && companyNumber) {
      panel.innerHTML = '<div style="padding:12px;text-align:center;color:#94A3B8;font-size:12px;">Loading Companies House data for ' + companyNumber + '\u2026</div>';
      try {
        await renderFullVerification(companyNumber, panel);
        panel.dataset.loaded = '1';
      } catch (e) {
        panel.innerHTML = '<div style="padding:12px;color:#F87171;font-size:12px;">Failed to load \u2014 click to retry</div>';
        panel.dataset.loaded = ''; // allow retry
      }
    }
    detail.style.maxHeight = '4000px';
    if (arrow) arrow.style.transform = 'rotate(180deg)';
  };

  // ═══════════════════════════════════════════════════════════════════
  // G5.3 Part C — Elect corporate PSC as Corporate Guarantor
  // Posts to /elect-as-corporate-guarantor; handles 409 already-elected.
  // ═══════════════════════════════════════════════════════════════════
  window._electAsCorporateGuarantor = async function(borrowerId, submissionId, entityName) {
    if (event && event.stopPropagation) event.stopPropagation();
    const confirmMsg = 'Elect "' + (entityName || 'this entity') + '" as Corporate Guarantor on this deal?\n\n' +
      'A new guarantor row will be created in the Guarantors section, pre-filled with the entity\'s ' +
      'name, company number, and registered address. The source PSC row stays intact.';
    if (!confirm(confirmMsg)) return;

    const btn = event && event.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Electing...'; btn.style.opacity = '0.6'; }

    try {
      const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}/elect-as-corporate-guarantor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const text = await res.text();
      let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }

      if (res.status === 409) {
        // Already elected — informational, not an error
        showToast(data.message || 'Already elected as corporate guarantor on this deal', 'info');
        setTimeout(() => _refreshDealInPlace(submissionId), 400);
        return;
      }
      if (!res.ok) {
        alert('Election failed (' + res.status + '): ' + (data.error || 'Unknown error'));
        if (btn) { btn.disabled = false; btn.textContent = 'Elect as Corporate Guarantor'; btn.style.opacity = '1'; }
        return;
      }
      showToast(data.message || 'Elected as Corporate Guarantor', 'success');
      setTimeout(() => _refreshDealInPlace(submissionId), 400);
    } catch (err) {
      console.error('[elect-as-corporate-guarantor]', err);
      alert('Election error: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Elect as Corporate Guarantor'; btn.style.opacity = '1'; }
    }
  };

  // Per-corporate-guarantor CH verify — fetches company + officers + PSCs from Companies House,
  // creates child borrower rows under this guarantor, and marks it verified.
  window._chVerifyCorporateParty = async function(borrowerId, submissionId) {
    const btn = event && event.target;
    if (!confirm('Run Companies House verification for this corporate party?\n\n' +
                 'This will fetch its directors and PSCs from CH and add them as children of this party.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; btn.style.opacity = '0.6'; }
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}/ch-verify-populate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const text = await res.text();
      let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
      if (!res.ok) {
        alert('CH verify failed (' + res.status + '): ' + (data.error || 'Unknown error'));
        if (btn) { btn.disabled = false; btn.textContent = 'Verify at Companies House'; btn.style.opacity = '1'; }
        return;
      }
      showToast(data.message || 'Companies House verification complete', 'success');
      // Refresh deal in-place so new children + verified badge render
      setTimeout(() => _refreshDealInPlace(submissionId), 400);
    } catch (err) {
      console.error('[ch-verify-populate]', err);
      alert('CH verify error: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Verify at Companies House'; btn.style.opacity = '1'; }
    }
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
    const _delLabels = { primary:'Borrower', joint:'Joint Borrower', guarantor:'Guarantor', director:'Director', ubo:'UBO', psc:'PSC', shareholder:'Shareholder' };
    const partyLabel = bor ? (_delLabels[bor.role] || 'Borrower') : 'Borrower';
    const fullName = bor ? (bor.company_name || bor.full_name || `${partyLabel} #${borrowerId}`) : `${partyLabel} #${borrowerId}`;
    // Warn extra hard if this is a corporate party with children — DB CASCADE will remove them too
    const childCount = bor && deal.borrowers ? deal.borrowers.filter(b => b.parent_borrower_id === borrowerId).length : 0;
    const cascadeWarn = childCount > 0 ? `\n\nWARNING: This will also remove ${childCount} linked ${childCount === 1 ? 'person' : 'people'} (directors / PSCs).` : '';

    if (!confirm(`Remove "${fullName}" (${partyLabel}) from this deal?${cascadeWarn}\n\nThis cannot be undone.`)) return;

    fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers/${borrowerId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          showToast(`${partyLabel} removed`, 'success');
          const row = document.getElementById(`borrower-row-${borrowerId}`);
          if (row) row.remove();
          setTimeout(() => _refreshDealInPlace(submissionId), 1200);
        } else {
          showToast(data.error || `Failed to remove ${partyLabel.toLowerCase()}`, 'error');
        }
      })
      .catch(err => showToast('Failed to remove: ' + err.message, 'error'));
  };

  // ═══════════════════════════════════════════════════════════════════
  // G5.3 Part B — Shared corporate panel renderer
  // Used for:
  //   (a) the inline detail panel when user clicks a corporate row
  //   (b) recursively nested corporate children (Holdings' PSCs that are themselves corp)
  // Reads everything from bor.ch_match_data + deal.borrowers (already in memory);
  // no async fetch. Amber advisory rendered when broker_trace_required is set.
  // ═══════════════════════════════════════════════════════════════════

  window._toggleNestedCorporate = function(panelId) {
    const el = document.getElementById(panelId);
    if (!el) return;
    const arrow = document.getElementById(panelId + '-arrow');
    if (el.style.maxHeight && el.style.maxHeight !== '0px') {
      el.style.maxHeight = '0px';
      el.style.opacity = '0';
      if (arrow) arrow.innerHTML = '\u25B6'; // right
    } else {
      el.style.maxHeight = '4000px';
      el.style.opacity = '1';
      if (arrow) arrow.innerHTML = '\u25BC'; // down
    }
  };

  window._renderCorporatePanelHtml = function(bor, deal, canEdit, nestLevel) {
    nestLevel = nestLevel || 0;
    if (nestLevel > 4) {
      // Recursion guard — should never hit given data depth, but safety first
      return '<div style="padding:8px;color:#64748B;font-size:11px;">Max render depth reached.</div>';
    }

    const _fmtDate = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    };
    const _field = (label, val, stage) => {
      if (val && String(val).trim()) {
        return '<div style="margin-bottom:8px;">' +
          '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
          '<div style="font-size:12px;color:#F1F5F9;font-weight:500;">' + sanitizeHtml(String(val)) + '</div>' +
        '</div>';
      }
      return '<div style="margin-bottom:8px;">' +
        '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">' + label + '</div>' +
        '<div style="font-size:11px;color:#475569;font-style:italic;">Not yet obtained' + (stage ? ' <span style="font-size:9px;color:#334155;">(' + stage + ')</span>' : '') + '</div>' +
      '</div>';
    };

    const chd2 = bor.ch_match_data || {};

    // Find THIS entity's entry in the parent's PSC list (for name, address, identification,
    // natures_of_control). Only meaningful when this row was inserted as a PSC of parent.
    const _parentPscEntry = (function() {
      if (!bor.parent_borrower_id) return null;
      const parentRow = (deal.borrowers || []).find(b => b.id === bor.parent_borrower_id);
      const parentPscs = parentRow && parentRow.ch_match_data && Array.isArray(parentRow.ch_match_data.pscs)
        ? parentRow.ch_match_data.pscs : [];
      const myNameLc = (bor.full_name || '').trim().toLowerCase();
      return parentPscs.find(p => p && p.name && p.name.trim().toLowerCase() === myNameLc) || null;
    })();

    // Company Number: THIS entity's own regnum only.
    // NEVER fall back to chd2.company_number (that's the PARENT's, recorded to say where we found the PSC).
    const companyNo = bor.company_number
      || chd2.psc_own_company_number
      || (chd2.psc_identification && chd2.psc_identification.registration_number)
      || (_parentPscEntry && _parentPscEntry.identification && _parentPscEntry.identification.registration_number)
      || null;

    // Jurisdiction: prefer human-readable country over technical legal_authority code.
    // Order: column → self-verified profile → parent PSC address.country → psc_identification country/authority.
    let jurisdiction = bor.jurisdiction || chd2.jurisdiction || null;
    if (!jurisdiction && _parentPscEntry && _parentPscEntry.address && _parentPscEntry.address.country) {
      jurisdiction = _parentPscEntry.address.country;
    }
    if (!jurisdiction && chd2.psc_identification) {
      jurisdiction = chd2.psc_identification.country_registered || chd2.psc_identification.legal_authority || null;
    }
    if (!jurisdiction && _parentPscEntry && _parentPscEntry.identification) {
      const pid = _parentPscEntry.identification;
      jurisdiction = pid.country_registered || pid.legal_authority || null;
    }
    // Default to England and Wales only if we have a UK registration number
    if (!jurisdiction && companyNo) jurisdiction = 'England and Wales';

    // Registered Address: column → self-verified profile → parent PSC entry address
    let regAddr = bor.address || bor.residential_address || null;
    if (!regAddr && chd2.registered_address && typeof chd2.registered_address === 'object') {
      const ra = chd2.registered_address;
      regAddr = [ra.line_1, ra.line_2, ra.locality, ra.region, ra.postal_code, ra.country]
        .filter(x => x && String(x).trim()).join(', ') || null;
    }
    if (!regAddr && _parentPscEntry && _parentPscEntry.address && typeof _parentPscEntry.address === 'object') {
      const pa = _parentPscEntry.address;
      regAddr = [pa.line_1, pa.line_2, pa.locality, pa.region, pa.postal_code, pa.country]
        .filter(x => x && String(x).trim()).join(', ') || null;
    }

    // Nature of Control: self → psc_natures → parent's pscs[] entry
    let natures = Array.isArray(chd2.natures_of_control) ? chd2.natures_of_control.slice() : [];
    if (natures.length === 0 && Array.isArray(chd2.psc_natures_of_control)) {
      natures = chd2.psc_natures_of_control.slice();
    }
    if (natures.length === 0 && _parentPscEntry && Array.isArray(_parentPscEntry.natures_of_control)) {
      natures = _parentPscEntry.natures_of_control.slice();
    }

    const nestedVer = chd2.nested_verification || null;
    const nestedIns = chd2.nested_inserted || null;
    const brokerTrace = chd2.broker_trace_required === true;
    const brokerReason = chd2.broker_trace_reason || 'This entity cannot be traced further via UK Companies House. Broker to provide the UBO chain.';

    // Nested children: officers + PSCs of this corporate
    const nestedKids = (deal.borrowers || []).filter(b => b.parent_borrower_id === bor.id);
    const chBadge = bor.ch_verified_at
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(52,211,153,0.1);color:#34D399;">\u2713 CH Verified \u2014 ' + sanitizeHtml(bor.ch_matched_role || bor.role || '') + '</span>'
      : '';
    const borderColour = nestLevel === 0 ? '#38BDF8' : (nestLevel === 1 ? '#A78BFA' : (nestLevel === 2 ? '#FBBF24' : '#F87171'));

    // ── Broker trace banner (amber) ──
    const brokerBanner = brokerTrace
      ? '<div style="margin-bottom:10px;padding:10px 12px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-left:3px solid #FBBF24;border-radius:6px;">' +
          '<div style="font-size:10px;color:#FBBF24;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">\u26A0 Broker Input Required \u2014 UBO Chain</div>' +
          '<div style="font-size:11px;color:#FEF3C7;line-height:1.5;">' + sanitizeHtml(brokerReason) + '</div>' +
        '</div>'
      : '';

    // ── Header ──
    const headerHtml =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
        '<div>' +
          '<div style="font-size:10px;color:' + borderColour + ';text-transform:uppercase;font-weight:700;letter-spacing:.3px;">Corporate ' + (bor.role === 'psc' ? 'PSC' : (bor.role || 'Entity').toUpperCase()) + (nestLevel > 0 ? ' \u00B7 Level ' + nestLevel : '') + '</div>' +
          '<div style="font-size:14px;font-weight:700;color:#F1F5F9;margin-top:2px;">' + sanitizeHtml(bor.full_name || 'Unknown Company') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          chBadge +
          '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;color:' + borderColour + ';background:rgba(56,189,248,0.1);text-transform:capitalize;">' + sanitizeHtml(bor.role || 'psc') + '</span>' +
        '</div>' +
      '</div>';

    // ── 2-column top ──
    const topGrid =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px;">' +
        '<div>' +
          '<div style="font-size:9px;color:' + borderColour + ';font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Corporate Identity</div>' +
          _field('Company Number', companyNo, 'CH') +
          _field('Jurisdiction', jurisdiction, 'CH') +
          _field('Registered Address', regAddr, 'CH') +
          (natures.length > 0
            ? '<div style="margin-bottom:8px;">' +
                '<div style="font-size:9px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">Nature of Control</div>' +
                '<div style="font-size:11px;color:#F1F5F9;line-height:1.5;">' + natures.map(n => sanitizeHtml(String(n).replace(/-/g, ' '))).join('<br/>') + '</div>' +
              '</div>'
            : _field('Nature of Control', null, 'CH')) +
        '</div>' +
        '<div>' +
          '<div style="font-size:9px;color:' + borderColour + ';font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">Companies House Verification</div>' +
          _field('CH Verified At', bor.ch_verified_at ? _fmtDate(bor.ch_verified_at) : null, 'Broker') +
          _field('Matched Role', bor.ch_matched_role || null, 'CH') +
          _field('Match Confidence', bor.ch_match_confidence || null, 'CH') +

          // ── Action buttons ──
          (function() {
            const actions = [];
            if (bor.company_number && canEdit) {
              actions.push('<button onclick="event.stopPropagation(); window._chVerifyCorporateParty(' + bor.id + ', \'' + deal.submission_id + '\')" style="padding:4px 12px;background:rgba(52,211,153,0.1);color:#34D399;border:1px solid rgba(52,211,153,0.3);border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">\u21BB Re-verify at CH</button>');
            }

            // ── G5.3 Part C — Elect as Corporate Guarantor ──
            // Eligible: corporate entity, not already a guarantor, not the primary/joint borrower itself,
            // and is a control/ownership relationship (psc/ubo/shareholder) or a recursed corporate.
            const isEligibleRoleForElection = ['psc', 'ubo', 'shareholder'].includes(bor.role);
            const isAlreadyElectedFromThis = !!(chd2.elected_as_corporate_guarantor_id) ||
              (deal.borrowers || []).some(b => b.role === 'guarantor' && b.borrower_type === 'corporate' &&
                b.ch_match_data && b.ch_match_data.elected_from_borrower_id === bor.id);

            if (canEdit && isEligibleRoleForElection && bor.borrower_type === 'corporate') {
              if (isAlreadyElectedFromThis) {
                // Elected pill (not clickable — informational)
                const electedId = chd2.elected_as_corporate_guarantor_id ||
                  ((deal.borrowers || []).find(b => b.role === 'guarantor' && b.borrower_type === 'corporate' &&
                    b.ch_match_data && b.ch_match_data.elected_from_borrower_id === bor.id) || {}).id;
                actions.push('<span style="padding:4px 12px;background:rgba(167,139,250,0.15);color:#A78BFA;border:1px solid rgba(167,139,250,0.35);border-radius:4px;font-size:10px;font-weight:700;" title="Row #' + (electedId || '?') + ' in Guarantors section">\u2713 Elected as Corporate Guarantor</span>');
              } else {
                // Election button with contextual warning
                const warn = [];
                if (nestLevel >= 3) warn.push('Deep ownership chain (level ' + nestLevel + ') — enforcement may need multi-entity legal review');
                if (brokerTrace) warn.push('Cross-border entity — foreign legal opinion may be required');
                const warnHtml = warn.length > 0
                  ? '<div style="margin-top:6px;padding:6px 10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.25);border-radius:4px;font-size:10px;color:#FBBF24;">\u26A0 ' + warn.map(w => sanitizeHtml(w)).join('<br/>\u26A0 ') + '</div>'
                  : '';
                const entityNameEscaped = String(bor.full_name || 'this entity').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                actions.push(
                  '<button onclick="window._electAsCorporateGuarantor(' + bor.id + ', \'' + deal.submission_id + '\', \'' + entityNameEscaped + '\')" style="padding:4px 12px;background:rgba(167,139,250,0.12);color:#A78BFA;border:1px solid rgba(167,139,250,0.35);border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">\u2696 Elect as Corporate Guarantor</button>' +
                  warnHtml
                );
              }
            }

            if (actions.length === 0) return '';
            return '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;">' + actions.join('') + '</div>';
          })() +
        '</div>' +
      '</div>';

    // ── CH Summary pills ──
    const summaryStrip = (function() {
      const riskCol = chd2.risk_score === 'low' ? '#34D399' : chd2.risk_score === 'medium' ? '#FBBF24' : chd2.risk_score === 'high' ? '#F87171' : '#94A3B8';
      const riskBg = riskCol === '#34D399' ? 'rgba(52,211,153,0.1)' : riskCol === '#FBBF24' ? 'rgba(251,191,36,0.1)' : riskCol === '#F87171' ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.04)';
      const statusCol = chd2.company_status === 'active' ? '#34D399' : '#F87171';
      const statusBg = chd2.company_status === 'active' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)';
      const pills = [];
      if (chd2.company_status) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:' + statusBg + ';color:' + statusCol + ';text-transform:capitalize;">' + sanitizeHtml(chd2.company_status) + '</span>');
      if (chd2.age_months != null) {
        const yrs = Math.floor(chd2.age_months / 12);
        const mos = chd2.age_months % 12;
        const ageStr = yrs > 0 ? (yrs + 'y ' + mos + 'm') : (mos + 'm');
        pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.04);color:#CBD5E1;">Age: ' + ageStr + '</span>');
      }
      if (chd2.risk_score) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:' + riskBg + ';color:' + riskCol + ';text-transform:capitalize;">Risk: ' + sanitizeHtml(chd2.risk_score) + '</span>');
      if (chd2.charges_total != null) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.04);color:#CBD5E1;">Charges: ' + chd2.charges_total + ' total / ' + ((chd2.charges_outstanding || []).length) + ' outstanding</span>');
      if (chd2.has_insolvency_history === true) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(248,113,113,0.15);color:#F87171;">\u26A0 Insolvency history</span>');
      if (Array.isArray(chd2.sic_codes) && chd2.sic_codes.length > 0) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.04);color:#94A3B8;">SIC: ' + chd2.sic_codes.join(', ') + '</span>');
      if (chd2.accounts && chd2.accounts.next_due) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.04);color:#94A3B8;">Accounts due: ' + _fmtDate(chd2.accounts.next_due) + (chd2.accounts.overdue ? ' <span style="color:#F87171;">OVERDUE</span>' : '') + '</span>');
      if (chd2.confirmation_statement && chd2.confirmation_statement.next_due) pills.push('<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(255,255,255,0.04);color:#94A3B8;">Conf stmt due: ' + _fmtDate(chd2.confirmation_statement.next_due) + (chd2.confirmation_statement.overdue ? ' <span style="color:#F87171;">OVERDUE</span>' : '') + '</span>');
      if (pills.length === 0) return '';
      return '<div style="margin-top:12px;padding:10px 12px;background:rgba(56,189,248,0.04);border:1px solid rgba(56,189,248,0.15);border-radius:6px;">' +
        '<div style="font-size:9px;color:#38BDF8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">CH Summary</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + pills.join('') + '</div>' +
      '</div>';
    })();

    // ── Outstanding Charges ──
    const chargesHtml = (function() {
      const charges = Array.isArray(chd2.charges_outstanding) ? chd2.charges_outstanding : [];
      if (charges.length === 0) return '';
      return '<div style="margin-top:12px;">' +
        '<div style="font-size:9px;color:#F87171;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Outstanding Charges \u2014 ' + charges.length + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
          '<thead><tr style="background:rgba(248,113,113,0.06);">' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Charge Code</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Created</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Entitled</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Type</th>' +
          '</tr></thead><tbody>' +
          charges.map(c => {
            const entitled = Array.isArray(c.persons_entitled) && c.persons_entitled.length > 0
              ? c.persons_entitled.map(p => sanitizeHtml(p.name || '')).join('; ') : '—';
            const flags = [];
            if (c.particulars && c.particulars.contains_fixed_charge) flags.push('Fixed');
            if (c.particulars && c.particulars.contains_floating_charge) flags.push('Floating');
            if (c.particulars && c.particulars.floating_charge_covers_all) flags.push('All assets');
            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
              '<td style="padding:4px 8px;color:#E2E8F0;font-family:monospace;font-size:10px;">' + sanitizeHtml(c.charge_code || '—') + '</td>' +
              '<td style="padding:4px 8px;color:#94A3B8;">' + (c.created_on ? _fmtDate(c.created_on) : '—') + '</td>' +
              '<td style="padding:4px 8px;color:#E2E8F0;">' + entitled + '</td>' +
              '<td style="padding:4px 8px;color:#94A3B8;">' + (flags.length ? flags.join(' + ') : '—') + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table>' +
      '</div>';
    })();

    // ── Recent Filings (last 5) ──
    const filingsHtml = (function() {
      const filings = Array.isArray(chd2.recent_filings) ? chd2.recent_filings.slice(0, 5) : [];
      if (filings.length === 0) return '';
      const catBg = { mortgage:'rgba(248,113,113,0.08)', accounts:'rgba(56,189,248,0.08)', 'confirmation-statement':'rgba(167,139,250,0.08)', 'officers':'rgba(52,211,153,0.08)' };
      const catCol = { mortgage:'#F87171', accounts:'#38BDF8', 'confirmation-statement':'#A78BFA', 'officers':'#34D399' };
      return '<div style="margin-top:12px;">' +
        '<div style="font-size:9px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Recent Filings \u2014 last ' + filings.length + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
          '<thead><tr style="background:rgba(167,139,250,0.04);">' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Date</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Type</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Category</th>' +
            '<th style="text-align:left;padding:4px 8px;color:#94A3B8;font-size:9px;font-weight:600;text-transform:uppercase;">Description</th>' +
          '</tr></thead><tbody>' +
          filings.map(f => {
            const col = catCol[f.category] || '#94A3B8';
            const bg = catBg[f.category] || 'rgba(255,255,255,0.04)';
            const desc = (f.description || '').replace(/-/g, ' ').replace(/mortgage /, '').replace(/with accounts type group/, '');
            return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
              '<td style="padding:4px 8px;color:#94A3B8;">' + (f.date ? _fmtDate(f.date) : '—') + '</td>' +
              '<td style="padding:4px 8px;color:#E2E8F0;font-family:monospace;font-size:10px;">' + sanitizeHtml(f.type || '—') + '</td>' +
              '<td style="padding:4px 8px;"><span style="padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;background:' + bg + ';color:' + col + ';text-transform:capitalize;">' + sanitizeHtml(f.category || '—') + '</span></td>' +
              '<td style="padding:4px 8px;color:#CBD5E1;">' + sanitizeHtml(desc) + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table>' +
      '</div>';
    })();

    // ── Nested kids with expandable sub-panels ──
    const nestedKidsHtml = (function() {
      if (nestedKids.length === 0) return '';

      // 2026-04-30 — Role gate: nested-PSC drill-down is RM responsibility only.
      // Brokers see the directors/PSCs of THEIR direct borrower (level 0 rows),
      // but cannot expand into nested corporate-PSC chains beyond that.
      const _role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
      const _isInternalUser = ['admin', 'rm', 'credit', 'compliance'].includes(_role);

      // 2026-04-30 — Level-gated rendering:
      //   nestLevel 0..2 (top + 2 levels of nested corporate PSCs) → rich 6-col table
      //     with KYC, Actions, "+ Add Person", "Same as Borrower" tag.
      //   nestLevel >= 3 → compact 4-col grid (Name/Role/Type/CH) — keeps deep PSC
      //     trees readable without flooding the UI with edit buttons at every depth.
      // Restored after Sumit flagged that the original design fell back to 4-col
      // at the deepest level; my first unify pass made it rich at every depth.
      if (nestLevel >= 3) {
        // Brokers never see this depth — drill-down is RM-only.
        if (!_isInternalUser) return '';
        // ── Compact 4-col grid for deep recursion (preserves the original look) ──
        let html = '<div style="margin-top:12px;">' +
          '<div style="font-size:9px;color:#38BDF8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Directors &amp; PSCs of ' + sanitizeHtml(bor.full_name || 'this corporate') + ' — ' + nestedKids.length + '</div>';
        nestedKids.forEach(nk => {
          const isCorpKid = (nk.borrower_type === 'corporate') ||
            (nk.full_name && /\b(Ltd|Limited|LLP|PLC|Holdings|Inc|Corp|Corporation|Group)\b/i.test(nk.full_name));
          const nRoleCol = nk.role === 'director' ? '#818CF8' : nk.role === 'psc' ? '#38BDF8' : nk.role === 'ubo' ? '#A78BFA' : '#94A3B8';
          const nRoleBg = nk.role === 'director' ? 'rgba(129,140,248,0.12)' : nk.role === 'psc' ? 'rgba(56,189,248,0.12)' : nk.role === 'ubo' ? 'rgba(167,139,250,0.12)' : 'rgba(255,255,255,0.04)';
          const nType = isCorpKid ? 'Corporate' : 'Individual';
          const subPanelId = 'ncorp-' + nk.id + '-' + nestLevel;
          const rowStyle = isCorpKid
            ? 'border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;background:rgba(255,255,255,0.01);'
            : 'border-bottom:1px solid rgba(255,255,255,0.04);';
          const rowOnClick = (isCorpKid && _isInternalUser) ? ' onclick="window._toggleNestedCorporate(\'' + subPanelId + '\')"' : '';
          const arrowCell = isCorpKid
            ? '<span id="' + subPanelId + '-arrow" style="display:inline-block;width:12px;color:#64748B;font-size:9px;margin-right:4px;">▶</span>'
            : '<span style="display:inline-block;width:12px;"></span>';
          html += '<div style="display:grid;grid-template-columns:3fr 1fr 1fr 1fr;padding:6px 8px;font-size:11px;' + rowStyle + '"' + rowOnClick + '>' +
            '<div style="color:#E2E8F0;">' + arrowCell + sanitizeHtml(nk.full_name || '—') + '</div>' +
            '<div><span style="padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;background:' + nRoleBg + ';color:' + nRoleCol + ';text-transform:capitalize;">' + sanitizeHtml(nk.role || '—') + '</span></div>' +
            '<div style="color:#94A3B8;">' + nType + '</div>' +
            '<div style="text-align:center;">' + (nk.ch_verified_at ? '<span style="color:#34D399;">✓</span>' : '<span style="color:#64748B;">—</span>') + '</div>' +
          '</div>';
          if (isCorpKid) {
            html += '<div id="' + subPanelId + '" style="max-height:0;overflow:hidden;opacity:0;transition:max-height .3s ease, opacity .25s ease;margin:4px 0 4px 18px;border-left:2px dashed rgba(56,189,248,0.25);padding-left:10px;">' +
              '<div style="background:rgba(15,23,41,0.5);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:10px 12px;">' +
                window._renderCorporatePanelHtml(nk, deal, canEdit, nestLevel + 1) +
              '</div>' +
            '</div>';
          }
        });
        html += '</div>';
        return html;
      }

      // ── Rich 6-col table for nestLevel 0..2 ──
      const _topLevelBorrowers = (deal.borrowers || []).filter(b => !b.parent_borrower_id);
      const _sameNameSet = new Set(_topLevelBorrowers
        .map(p => (p.full_name || '').toLowerCase().trim())
        .filter(Boolean));
      const _colspan = canEdit ? 6 : 5;

      let html = '<div style="margin-top:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<span style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Directors, PSCs &amp; UBOs of ' + sanitizeHtml(bor.full_name || 'this corporate') + ' \u2014 ' + nestedKids.length + '</span>' +
          (canEdit ? '<button onclick="window.addChildToParent(\'' + deal.submission_id + '\', ' + bor.id + ')" style="padding:3px 10px;background:#818CF8;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Person</button>' : '') +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;">' +
          '<thead><tr style="background:rgba(255,255,255,0.04);">' +
            '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Name</th>' +
            '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Role</th>' +
            '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Nationality</th>' +
            '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">KYC</th>' +
            '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">CH</th>' +
            (canEdit ? '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Actions</th>' : '') +
          '</tr></thead><tbody>';

      nestedKids.forEach(nk => {
        const isCorpKid = (nk.borrower_type === 'corporate') ||
          (nk.full_name && /\b(Ltd|Limited|LLP|PLC|Holdings|Inc|Corp|Corporation|Group)\b/i.test(nk.full_name));
        const rBg = nk.role === 'director' ? 'rgba(129,140,248,0.1)' : nk.role === 'psc' ? 'rgba(56,189,248,0.1)' : nk.role === 'ubo' ? 'rgba(167,139,250,0.1)' : 'rgba(255,255,255,0.04)';
        const rCol = nk.role === 'director' ? '#818CF8' : nk.role === 'psc' ? '#38BDF8' : nk.role === 'ubo' ? '#A78BFA' : '#94A3B8';
        const kycCol = nk.kyc_status === 'verified' ? '#34D399' : nk.kyc_status === 'submitted' ? '#D4A853' : '#F87171';
        const sameTag = _sameNameSet.has((nk.full_name || '').toLowerCase().trim())
          ? ' <span style="font-size:9px;color:#D4A853;background:rgba(212,168,83,0.15);padding:1px 6px;border-radius:8px;margin-left:4px;">Same as Borrower</span>'
          : '';
        const subPanelId = 'ncorp-' + nk.id + '-' + nestLevel;
        const kidChd = nk.ch_match_data || {};
        const kidBrokerTrace = kidChd.broker_trace_required === true;
        const kidBrokerPill = kidBrokerTrace
          ? ' <span style="padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(251,191,36,0.15);color:#FBBF24;" title="' + sanitizeHtml(kidChd.broker_trace_reason || '') + '">⚠ Broker</span>'
          : '';

        // Corporate kids -> toggle inline sub-panel; individuals -> toggle borrower detail.
        // Brokers: corporate kids are NOT clickable (no nested PSC drill-down).
        const rowOnClick = isCorpKid
          ? (_isInternalUser ? ' onclick="window._toggleNestedCorporate(\'' + subPanelId + '\')"' : '')
          : ' onclick="window._toggleBorrowerDetail(' + nk.id + ')"';

        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;" id="borrower-row-' + nk.id + '"' + rowOnClick + '>' +
          '<td style="padding:6px 8px;color:#60A5FA;font-weight:600;text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3);">' +
            (isCorpKid ? '<span id="' + subPanelId + '-arrow" style="display:inline-block;width:10px;color:#64748B;font-size:9px;margin-right:4px;">▶</span>' : '') +
            sanitizeHtml(nk.full_name || '-') + ' <span style="font-size:9px;color:#64748B;text-decoration:none;">&#9660;</span>' + sameTag + kidBrokerPill +
          '</td>' +
          '<td style="padding:6px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + rBg + ';color:' + rCol + ';text-transform:capitalize;">' + (nk.role || 'director') + '</span></td>' +
          '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + sanitizeHtml(nk.nationality || '—') + '</td>' +
          '<td style="padding:6px 8px;text-align:center;"><span style="font-size:10px;font-weight:600;color:' + kycCol + ';text-transform:capitalize;">' + (nk.kyc_status || 'pending') + '</span></td>' +
          '<td style="padding:6px 8px;text-align:center;">' + (nk.ch_verified_at ? '<span style="font-size:10px;color:#34D399;font-weight:600;">&#10003;</span>' : '<span style="font-size:10px;color:#64748B;">—</span>') + '</td>' +
          (canEdit ? '<td style="padding:6px 8px;text-align:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
            ((isCorpKid && nk.company_number)
              ? '<button onclick="window._chVerifyCorporateParty(' + nk.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;margin-right:4px;" title="' + (nk.ch_verified_at ? 'Re-verify corporate PSC at CH' : 'Verify corporate PSC at CH') + '">' + (nk.ch_verified_at ? '&#8635;' : '✓') + ' CH</button>'
              : '') +
            '<button onclick="window.editBorrowerRow(' + nk.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;" title="Edit">&#9998;</button>' +
            '<button onclick="window.deleteBorrowerRow(' + nk.id + ', \'' + deal.submission_id + '\')" style="padding:2px 8px;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;background:rgba(248,113,113,0.1);color:#F87171;" title="Delete">&#10005;</button>' +
          '</td>' : '') +
        '</tr>';

        // Recursion sub-panel for corporate kids — RM-only (deep PSC drill-down).
        // Brokers see the row but no expand affordance; they stop at first borrower level.
        if (isCorpKid && _isInternalUser) {
          html += '<tr><td colspan="' + _colspan + '" style="padding:0;border:none;">' +
            '<div id="' + subPanelId + '" style="max-height:0;overflow:hidden;opacity:0;transition:max-height .3s ease, opacity .25s ease;margin:4px 0 4px 18px;border-left:2px dashed rgba(56,189,248,0.25);padding-left:10px;">' +
              '<div style="background:rgba(15,23,41,0.5);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:10px 12px;">' +
                window._renderCorporatePanelHtml(nk, deal, canEdit, nestLevel + 1) +
              '</div>' +
            '</div>' +
          '</td></tr>';
        }
      });

      html += '</tbody></table></div>';
      return html;
    })();

    // ── Recursion advisory ──
    const recursionHtml = nestedVer
      ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.18);border-radius:6px;">' +
          '<div style="font-size:9px;color:#38BDF8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Nested CH Verification</div>' +
          '<div style="font-size:11px;color:#CBD5E1;">Recursed into ' + sanitizeHtml(bor.full_name || 'corporate PSC') + '. ' +
            (nestedIns ? ('Inserted <strong>' + (nestedIns.officers || 0) + '</strong> officers, <strong>' + (nestedIns.pscs || 0) + '</strong> PSCs.') : '') +
          '</div>' +
        '</div>'
      : '';

    return brokerBanner + headerHtml + topGrid + summaryStrip + chargesHtml + filingsHtml + nestedKidsHtml + recursionHtml;
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

    // ── G5.3 Part B: corporate detail panel ──
    // If this borrower is a corporate entity (e.g. corporate PSC like "Cohort Capital Holdings Ltd"),
    // render a corporate-shaped card (Company No, Registered Address, CH verified, PSC nature,
    // nested officers/PSCs from recursion) INSTEAD of the individual Personal Identity layout.
    const _isCorporate = (bor.borrower_type === 'corporate') ||
      (bor.full_name && /\b(Ltd|Limited|LLP|PLC|Holdings|Inc|Corp|Corporation|Group)\b/i.test(bor.full_name));

    // SmartSearch KYC/AML panel — admin-only (2026-04-27).
    // Renders status pills per check_type and action buttons. Reads deal.kyc_checks
    // populated by the admin endpoint.
    const ssPanelHtml = (typeof window._buildSmartSearchPanel === 'function')
      ? window._buildSmartSearchPanel(bor, deal)
      : '';

    // Experian credit bureau panel — admin-only (2026-04-27).
    // Reads deal.credit_checks populated by the admin endpoint. Mirrors the
    // SmartSearch pattern: status pills per product (personal_credit /
    // commercial_delphi / hunter_fraud) + action buttons.
    const expPanelHtml = (typeof window._buildExperianPanel === 'function')
      ? window._buildExperianPanel(bor, deal)
      : '';

    let innerBody;
    if (_isCorporate) {
      // G5.3 Part B Commit 2 — delegate to shared renderer.
      // Renderer handles nested kids with inline expandable sub-panels + broker-trace banner.
      innerBody = window._renderCorporatePanelHtml(bor, deal, canEdit, 0) + ssPanelHtml + expPanelHtml;
    } else {
      // Individual detail (unchanged legacy layout)
      innerBody =
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

        // ── SmartSearch KYC/AML panel (admin-only) ──
        ssPanelHtml +

        // ── Experian credit bureau panel (admin-only) ──
        expPanelHtml;
    }

    const detailHtml = '<tr id="borrower-detail-' + borrowerId + '">' +
      '<td colspan="' + colCount + '" style="padding:0;border-bottom:1px solid rgba(212,168,83,0.15);">' +
        '<div style="max-height:0;overflow:hidden;opacity:0;transition:max-height .3s ease, opacity .25s ease;background:rgba(15,23,41,0.6);border-left:3px solid ' + (_isCorporate ? '#38BDF8' : '#D4A853') + ';" id="borrower-detail-inner-' + borrowerId + '">' +
          '<div style="padding:14px 16px;">' +
            innerBody +
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
        // Corporate panel is much taller (CH summary + charges + filings + nested kids) — give it headroom
        inner.style.maxHeight = _isCorporate ? '2400px' : '600px';
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

      showToast(`${docCount} file${docCount !== 1 ? 's' : ''} uploaded and categorised. Please confirm categories in the Document Repository, then click "AI Parse & Review".`, 'success');

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

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 3 PARSER REFACTOR — Candidate Review UI
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Parse documents for candidate review (Stage 3 entrypoint)
   * Calls /api/smart-parse/deals/:submissionId/parse-for-review
   * Displays showCandidateReview() UI on success
   */
  window.matrixParseForReview = async function() {
    const subId = deal.submission_id;
    if (!subId) {
      showToast('No submission ID found', 'error');
      return;
    }

    showParseProgress('Parsing documents for candidate review…');

    // ── Poll /parse-progress every 2 seconds while the parse runs ──
    let stopPolling = false;
    const progressPoll = (async () => {
      const startedAt = Date.now();
      while (!stopPolling) {
        await new Promise(r => setTimeout(r, 2000));
        if (stopPolling) break;
        try {
          const pr = await fetchWithAuth(`${API_BASE}/api/smart-parse/deals/${subId}/parse-progress`, { method: 'GET' });
          if (!pr.ok) continue;
          const pdata = await pr.json();
          if (!pdata.success || !pdata.progress) continue;
          const p = pdata.progress;
          // Format a status line
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          let msg;
          if (p.stage === 'started') {
            msg = `Reading ${p.totalDocs || '?'} documents (${elapsed}s elapsed)…`;
          } else if (p.stage === 'batches_prepared') {
            msg = `Prepared ${p.totalBatches} batch${p.totalBatches === 1 ? '' : 'es'} · Claude starting…`;
          } else if (p.stage === 'batch_done' || p.stage === 'batch_failed') {
            const pct = Math.round((p.batchesDone / p.totalBatches) * 100);
            const r = p.running || {};
            msg = `Batch ${p.batchesDone} of ${p.totalBatches} (${pct}%) — ${r.corporates || 0} corporate, ${r.individuals || 0} individuals, ${r.properties || 0} properties so far`;
            if (window.floatingProgress && typeof window.floatingProgress.updateBar === 'function') {
              window.floatingProgress.updateBar(pct);
            }
          } else if (p.stage === 'deduping') {
            msg = 'Deduplicating candidates…';
          } else if (p.stage === 'complete') {
            const t = p.totals || {};
            msg = `✓ Done — ${t.corporates || 0} corp, ${t.individuals || 0} ind, ${t.properties || 0} prop`;
          } else {
            msg = p.message || 'Parsing…';
          }
          if (window.floatingProgress && typeof window.floatingProgress.updateMessage === 'function') {
            window.floatingProgress.updateMessage(msg);
          }
        } catch (e) { /* swallow — network blip, next poll will retry */ }
      }
    })();

    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/deals/${subId}/parse-for-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      stopPolling = true;

      if (!resp.ok) {
        if (window.floatingProgress && typeof window.floatingProgress.error === 'function') {
          window.floatingProgress.error({ label: 'Parsing Failed', message: 'Could not parse documents for candidates' });
        }
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Parse for review failed', 'error');
        return;
      }

      const data = await resp.json();
      if (data.success && data.candidates) {
        const c = data.candidates;
        const counts = `${(c.corporate_entities||[]).length} corp · ${(c.individuals||[]).length} ind · ${(c.properties||[]).length} prop`;
        if (window.floatingProgress && typeof window.floatingProgress.complete === 'function') {
          window.floatingProgress.complete({ label: 'Parsing Complete', message: 'Extracted ' + counts + '. Review below.' });
          // Auto-dismiss after 2 seconds so the success state shows briefly
          setTimeout(() => { if (window._fpDismiss) window._fpDismiss(); }, 2000);
        } else {
          hideParseProgress();
        }
        showCandidateReview(data.candidates, data.confidence);
      } else {
        if (window.floatingProgress && typeof window.floatingProgress.error === 'function') {
          window.floatingProgress.error({ label: 'No Candidates', message: 'Parser returned no candidates' });
        }
        showToast(data.error || 'No candidates found', 'error');
      }
    } catch (err) {
      stopPolling = true;
      if (window.floatingProgress && typeof window.floatingProgress.error === 'function') {
        window.floatingProgress.error({ label: 'Parse Error', message: err.message });
      }
      console.error('[matrix-parse-for-review]', err);
      showToast('Failed to parse for review: ' + err.message, 'error');
    }
  };

  /**
   * Display the Candidate Review UI
   * @param {Object} candidates - { corporate_entities, individuals, properties, loan_facts, broker }
   * @param {Number} confidence - 0-1 confidence score
   */
  function showCandidateReview(candidates, confidence) {
    const parserContent = document.getElementById('parser-content');
    if (!parserContent) return;

    const confPercent = Math.round((confidence || 0) * 100);
    const confColor = confidence >= 0.8 ? '#34D399' : confidence >= 0.5 ? '#D4A853' : '#F87171';

    // ── Corporate Entities cards ──
    let corporateHtml = '';
    const corporates = candidates.corporate_entities || [];
    if (corporates.length > 0) {
      for (const corp of corporates) {
        const corpLabel = `C${corporates.indexOf(corp) + 1}`;
        const registered = corp.registered_address ? `<div style="font-size:10px;color:#94A3B8;margin-top:2px;">${sanitizeHtml(corp.registered_address)}</div>` : '';
        const sourceDocs = (corp.source_docs || []).join(', ') || 'unknown';
        const reasoning = (corp.reasoning || '').substring(0, 100) + (corp.reasoning?.length > 100 ? '…' : '');

        corporateHtml += `
          <div style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;margin-bottom:12px;">
            <div style="display:flex;gap:12px;margin-bottom:10px;">
              <div style="flex-shrink:0;width:32px;height:32px;background:rgba(212,168,83,0.2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#D4A853;">${corpLabel}</div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;">${sanitizeHtml(corp.name || 'Unknown')}</div>
                <div style="font-size:10px;color:#94A3B8;margin-top:1px;">Co. No: ${sanitizeHtml(corp.company_number || 'N/A')} · ${sanitizeHtml(corp.jurisdiction || 'Unknown')}</div>
                ${registered}
              </div>
            </div>
            <div style="background:#0f1729;border-radius:6px;padding:10px 12px;margin-bottom:10px;">
              <div style="font-size:10px;color:#94A3B8;margin-bottom:3px;">Source: ${sanitizeHtml(sourceDocs)}</div>
              <div style="font-size:10px;color:#94A3B8;">Reasoning: ${sanitizeHtml(reasoning)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <label style="font-size:10px;color:#CBD5E1;font-weight:600;">ROLE:</label>
              <select class="cand-role-select" data-cand-id="${corp.id}" data-cand-type="corporate" style="flex:1;padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:12px;">
                <option value="primary_borrower">Primary Borrower</option>
                <option value="co_borrower">Co-Borrower</option>
                <option value="corporate_guarantor">Corporate Guarantor</option>
                <option value="ignore">Ignore</option>
              </select>
            </div>
          </div>`;
      }
    }

    // ── Individuals cards ──
    let individualsHtml = '';
    const individuals = candidates.individuals || [];
    if (individuals.length > 0) {
      for (const ind of individuals) {
        const indLabel = `I${individuals.indexOf(ind) + 1}`;
        const hints = (ind.role_hints || []).join(', ') || 'none';
        const pscPct = ind.psc_percentage ? ` · PSC ${ind.psc_percentage}%` : '';
        const sourceDocs = (ind.source_docs || []).join(', ') || 'unknown';
        const reasoning = (ind.reasoning || '').substring(0, 100) + (ind.reasoning?.length > 100 ? '…' : '');

        individualsHtml += `
          <div style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;margin-bottom:12px;">
            <div style="display:flex;gap:12px;margin-bottom:10px;">
              <div style="flex-shrink:0;width:32px;height:32px;background:rgba(52,211,153,0.2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#34D399;">${indLabel}</div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;">${sanitizeHtml(ind.name || 'Unknown')}</div>
                <div style="font-size:10px;color:#94A3B8;margin-top:1px;">
                  ${ind.date_of_birth ? `DOB: ${sanitizeHtml(String(ind.date_of_birth).substring(0, 10))} · ` : ''}
                  ${sanitizeHtml(ind.nationality || 'Unknown')}${pscPct}
                </div>
              </div>
            </div>
            <div style="background:#0f1729;border-radius:6px;padding:10px 12px;margin-bottom:10px;">
              <div style="font-size:10px;color:#94A3B8;margin-bottom:3px;">Hints: ${sanitizeHtml(hints)}</div>
              <div style="font-size:10px;color:#94A3B8;margin-bottom:3px;">Source: ${sanitizeHtml(sourceDocs)}</div>
              <div style="font-size:10px;color:#94A3B8;">Reasoning: ${sanitizeHtml(reasoning)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <label style="font-size:10px;color:#CBD5E1;font-weight:600;">ROLE:</label>
              <select class="cand-role-select" data-cand-id="${ind.id}" data-cand-type="individual" data-linked-corp="${ind.linked_to_corporate_id || ''}" style="flex:1;min-width:140px;padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:12px;">
                <option value="ubo">UBO</option>
                <option value="director">Director</option>
                <option value="pg_from_ubo">PG from UBO</option>
                <option value="third_party_guarantor">3rd Party Guarantor</option>
                <option value="kyc_only">KYC Only</option>
                <option value="ignore">Ignore</option>
              </select>
              <label style="font-size:10px;color:#CBD5E1;font-weight:600;">LINK:</label>
              <select class="cand-link-select" data-cand-id="${ind.id}" style="flex:1;min-width:100px;padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:12px;">
                <option value="">— None —</option>
                ${corporates.map((c, i) => `<option value="${c.id}" ${c.id === ind.linked_to_corporate_id ? 'selected' : ''}>C${i + 1}: ${sanitizeHtml(c.name?.substring(0, 30) || 'Unknown')}</option>`).join('')}
              </select>
            </div>
          </div>`;
      }
    }

    // ── Properties cards ──
    let propertiesHtml = '';
    const properties = candidates.properties || [];
    if (properties.length > 0) {
      for (const prop of properties) {
        const propLabel = `P${properties.indexOf(prop) + 1}`;
        const sourceDocs = (prop.source_docs || []).join(', ') || 'unknown';
        const reasoning = (prop.reasoning || '').substring(0, 100) + (prop.reasoning?.length > 100 ? '…' : '');
        const marketVal = prop.market_value ? `£${Number(prop.market_value).toLocaleString()}` : 'N/A';
        const purchasePrice = prop.purchase_price ? `£${Number(prop.purchase_price).toLocaleString()}` : 'N/A';

        propertiesHtml += `
          <div style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;margin-bottom:12px;">
            <div style="display:flex;gap:12px;margin-bottom:10px;">
              <div style="flex-shrink:0;width:32px;height:32px;background:rgba(148,163,184,0.2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#CBD5E1;">${propLabel}</div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#F1F5F9;">${sanitizeHtml(prop.address || 'Unknown')}</div>
                <div style="font-size:10px;color:#94A3B8;margin-top:1px;">
                  ${prop.postcode ? `${sanitizeHtml(prop.postcode)} · ` : ''}
                  ${sanitizeHtml(prop.tenure || 'N/A')} · ${sanitizeHtml(prop.occupancy_status || 'N/A')}
                </div>
              </div>
            </div>
            <div style="background:#0f1729;border-radius:6px;padding:10px 12px;margin-bottom:10px;">
              <div style="font-size:10px;color:#94A3B8;margin-bottom:3px;">Market: ${marketVal} · Purchase: ${purchasePrice}</div>
              <div style="font-size:10px;color:#94A3B8;margin-bottom:3px;">Source: ${sanitizeHtml(sourceDocs)}</div>
              <div style="font-size:10px;color:#94A3B8;">Reasoning: ${sanitizeHtml(reasoning)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <label style="font-size:10px;color:#CBD5E1;font-weight:600;">ROLE:</label>
              <select class="cand-role-select" data-cand-id="${prop.id}" data-cand-type="property" style="flex:1;padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#F1F5F9;font-size:12px;">
                <option value="security" selected>Security</option>
                <option value="ignore">Ignore</option>
              </select>
            </div>
          </div>`;
      }
    }

    // ── Loan Facts (read-only summary) ──
    const loanFacts = candidates.loan_facts || {};
    const loanAmount = loanFacts.amount_requested ? `£${Number(loanFacts.amount_requested).toLocaleString()}` : 'N/A';
    const termMonths = loanFacts.term_months ? `${loanFacts.term_months} months` : 'N/A';
    const rateMonthly = loanFacts.rate_requested ? `${loanFacts.rate_requested}%/month` : 'N/A';
    const loanPurpose = loanFacts.loan_purpose || 'N/A';
    const exitStrategy = loanFacts.exit_strategy || 'N/A';
    const retainedMonths = loanFacts.retained_months || 0;
    const arrangeFeePct = loanFacts.arrangement_fee_pct || 0;
    const brokerFeePct = loanFacts.broker_fee_pct || 0;

    let html = `
      <div style="background:#0f1729;border:1px solid rgba(212,168,83,0.25);border-radius:10px;padding:20px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <div style="font-size:16px;font-weight:700;color:#F1F5F9;">AI Candidate Review</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="font-size:18px;font-weight:800;color:${confColor};">${confPercent}%</div>
            <div style="font-size:10px;font-weight:600;color:#94A3B8;text-transform:uppercase;">Confidence</div>
          </div>
        </div>
        <div style="font-size:12px;color:#94A3B8;margin-bottom:16px;">Claude parsed your documents. Review each candidate and assign it a role. The Matrix will only populate from candidates you confirm.</div>

        <div style="background:rgba(255,255,255,0.04);border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;margin-top:12px;">
          <!-- Corporate Entities Section -->
          ${corporates.length > 0 ? `
            <div style="margin-bottom:16px;">
              <div style="font-size:12px;font-weight:700;color:#D4A853;text-transform:uppercase;margin-bottom:12px;">Corporate Entities (${corporates.length})</div>
              ${corporateHtml}
            </div>
          ` : ''}

          <!-- Individuals Section -->
          ${individuals.length > 0 ? `
            <div style="margin-bottom:16px;">
              <div style="font-size:12px;font-weight:700;color:#34D399;text-transform:uppercase;margin-bottom:12px;">Individuals (${individuals.length})</div>
              ${individualsHtml}
            </div>
          ` : ''}

          <!-- Properties Section -->
          ${properties.length > 0 ? `
            <div style="margin-bottom:16px;">
              <div style="font-size:12px;font-weight:700;color:#CBD5E1;text-transform:uppercase;margin-bottom:12px;">Properties (${properties.length})</div>
              ${propertiesHtml}
            </div>
          ` : ''}

          <!-- Loan Facts Summary (read-only) -->
          <div style="margin-bottom:16px;">
            <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;margin-bottom:10px;">Loan Facts Summary</div>
            <div style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 16px;">
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:11px;color:#94A3B8;">
                <div><span style="color:#CBD5E1;font-weight:600;">${loanAmount}</span> gross</div>
                <div><span style="color:#CBD5E1;font-weight:600;">${termMonths}</span> term</div>
                <div><span style="color:#CBD5E1;font-weight:600;">${rateMonthly}</span> rate</div>
                <div style="grid-column:1/-1;"><span style="color:#CBD5E1;font-weight:600;">${sanitizeHtml(loanPurpose)}</span> purpose</div>
                <div>Exit: <span style="color:#CBD5E1;font-weight:600;">${sanitizeHtml(exitStrategy)}</span></div>
                <div>Retained: <span style="color:#CBD5E1;font-weight:600;">${retainedMonths}mo</span></div>
                <div>AF: <span style="color:#CBD5E1;font-weight:600;">${arrangeFeePct}%</span></div>
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;">
            <button onclick="document.getElementById('parser-content').innerHTML=''" style="padding:10px 18px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#94A3B8;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
            <button onclick="window.confirmCandidateAssignments()" style="padding:10px 20px;background:#D4A853;color:#0B1120;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Confirm Assignments →</button>
          </div>
        </div>
      </div>`;

    parserContent.innerHTML = html;
    parserContent.style.display = 'block';

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
  }

  /**
   * Read all candidate role assignments from the UI and POST to confirm endpoint
   */
  window.confirmCandidateAssignments = async function() {
    const subId = deal.submission_id;
    if (!subId) {
      showToast('No submission ID found', 'error');
      return;
    }

    const corporateAssignments = [];
    const individualAssignments = [];
    const propertyAssignments = [];

    // Collect corporate assignments
    document.querySelectorAll('.cand-role-select[data-cand-type="corporate"]').forEach(sel => {
      corporateAssignments.push({
        candidate_id: sel.getAttribute('data-cand-id'),
        role: sel.value
      });
    });

    // Collect individual assignments
    document.querySelectorAll('.cand-role-select[data-cand-type="individual"]').forEach(sel => {
      const linkedCorpSelect = document.querySelector(`.cand-link-select[data-cand-id="${sel.getAttribute('data-cand-id')}"]`);
      const linkedCorp = linkedCorpSelect ? linkedCorpSelect.value : '';
      individualAssignments.push({
        candidate_id: sel.getAttribute('data-cand-id'),
        role: sel.value,
        linked_to_corporate_candidate_id: linkedCorp || null
      });
    });

    // Collect property assignments
    document.querySelectorAll('.cand-role-select[data-cand-type="property"]').forEach(sel => {
      propertyAssignments.push({
        candidate_id: sel.getAttribute('data-cand-id'),
        role: sel.value
      });
    });

    const payload = {
      assignments: {
        corporate_entities: corporateAssignments,
        individuals: individualAssignments,
        properties: propertyAssignments
      }
    };

    try {
      floatingProgress.show({
        label: 'Processing Assignments',
        message: 'Confirming candidate assignments and populating matrix...'
      });

      const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/deals/${subId}/confirm-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        floatingProgress.error({ label: 'Confirmation Failed', message: err.error || 'Could not confirm assignments' });
        return;
      }

      const data = await resp.json();
      const summary = data.summary || {};
      const corpCount = summary.corporates_created || 0;
      const indCount = summary.individuals_created || 0;
      const propCount = summary.properties_created || 0;

      floatingProgress.complete({
        label: 'Success',
        message: `Matrix populated: ${corpCount} corporate(s), ${indCount} individual(s), ${propCount} propert${propCount === 1 ? 'y' : 'ies'}`
      });

      // Clear the review UI
      const parserContent = document.getElementById('parser-content');
      if (parserContent) parserContent.innerHTML = '';

      // Reload the Matrix to show populated data
      setTimeout(() => {
        if (typeof window.loadDealIntoMatrix === 'function') {
          window.loadDealIntoMatrix();
        } else {
          location.reload();
        }
      }, 1500);
    } catch (err) {
      console.error('[confirm-candidates]', err);
      floatingProgress.error({ label: 'Connection Error', message: 'Failed to confirm: ' + err.message });
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
    'uof': 'Use of Funds & Purpose',
    's5': 'Exit Strategy',
    's4': 'Loan Terms & Economics',
    's6': 'Legal & Insurance',
    's7': 'Credit Approval',
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
  //
  // 2026-04-21 Step 2 (Option Y): read borrower_type from the canonical
  // deal_borrowers primary row FIRST (confirmed at Gate 3 in the broker flow),
  // falling back to flat deal_submissions field + HTML input only when no
  // hierarchical borrowers exist yet.
  const isCorporate = () => {
    const _corpTypes = ['corporate','spv','ltd','llp','limited','trust','partnership'];
    // Canonical: deal_borrowers primary row (post-Phase G hierarchical model)
    if (deal.borrowers && deal.borrowers.length > 0) {
      const primary = deal.borrowers.find(b => b.role === 'primary' && !b.parent_borrower_id)
                   || deal.borrowers.find(b => b.role === 'primary');
      if (primary && primary.borrower_type) {
        return _corpTypes.includes((primary.borrower_type || '').toLowerCase());
      }
    }
    // Fallback 1: HTML input (pre-confirm flow, broker still editing)
    const bt = document.getElementById('mf-borrower_type')?.value;
    if (bt) return bt !== 'individual';
    // Fallback 2: flat deal_submissions field
    return _corpTypes.includes((deal.borrower_type || '').toLowerCase());
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
  // 2026-04-21: 'draft' added to DIP tier. Deals start in 'draft' while the
  // broker fills the Matrix pre-submission; previously this fell through to
  // the formal tier which demanded every field (7 Loan Terms + 4 Fees + ITS-
  // grade Borrower/KYC) and made every new deal look 'incomplete' by ~11 fields
  // before the broker had even started.
  function getValidationTier() {
    const stage = currentStage || 'received';
    if (['received', 'info_gathering', 'draft'].includes(stage)) return 'dip';
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

      // 2026-04-21: contact fields (email/phone) on a CORPORATE primary live
      // on the UBO/director/PSC child rows, not on the corporate row itself.
      // Walk children when primary is corporate so broker-entered contact info
      // on any child satisfies the atLeastOne email/phone gate. DOB/nationality
      // follow the same pattern — those are individual attributes that apply
      // to the person behind the corporate, not the corporate itself.
      const _primaryCorpTypes = ['corporate','spv','ltd','llp','limited','trust','partnership'];
      const _primaryIsCorp = _primaryCorpTypes.includes((primary.borrower_type || '').toLowerCase());
      const _firstChildWith = (fieldName) => {
        const child = deal.borrowers.find(b =>
          b.parent_borrower_id === primary.id &&
          b[fieldName] && String(b[fieldName]).trim() !== ''
        );
        return child ? child[fieldName] : null;
      };
      const borrowerFieldMap = {
        'borrower_name': primary.full_name,
        'borrower_type': primary.borrower_type,
        'borrower_email': primary.email || (_primaryIsCorp ? _firstChildWith('email') : null),
        'borrower_phone': primary.phone || (_primaryIsCorp ? _firstChildWith('phone') : null),
        'borrower_dob': primary.date_of_birth || (_primaryIsCorp ? _firstChildWith('date_of_birth') : null),
        'borrower_nationality': primary.nationality || (_primaryIsCorp ? _firstChildWith('nationality') : null),
        'company_name': primary.company_name,
        'company_number': primary.company_number
      };
      if (borrowerFieldMap[key] !== undefined && borrowerFieldMap[key] !== null && String(borrowerFieldMap[key]).trim() !== '') {
        return true;
      }
    }

    // Also check the raw deal object for fields that may not have an input element
    if (deal[key] !== null && deal[key] !== undefined && String(deal[key]).trim() !== '') return true;

    // 2026-04-21: paired-column check. Matrix-SSOT stores broker's ask in
    // <field>_requested and RM's offer in <field>_approved. Validator keys
    // like 'loan_amount', 'term_months', 'interest_servicing' pre-date the
    // split and still use the base name — so a broker who fills only
    // Requested (and hasn't had RM touch Approved) would fail completeness.
    // Also handle the 'ltv_requested' → 'ltv_approved' pairing.
    const pairedBaseFields = ['loan_amount', 'term_months', 'interest_servicing', 'rate'];
    if (pairedBaseFields.includes(key)) {
      const req = deal[`${key}_requested`];
      const apr = deal[`${key}_approved`];
      if (req != null && String(req).trim() !== '') return true;
      if (apr != null && String(apr).trim() !== '') return true;
    }
    if (key === 'ltv_requested') {
      const aprLtv = deal['ltv_approved'];
      if (aprLtv != null && String(aprLtv).trim() !== '') return true;
    }
    if (key === 'rate_requested') {
      const aprRate = deal['rate_approved'];
      if (aprRate != null && String(aprRate).trim() !== '') return true;
    }

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
    // 2026-04-30 — Role-gated: brokers don't get blocked on this. Per Sumit's
    // design (memory: feedback_los_vs_lms), broker INFORMS, RM VERIFIES roles
    // against Companies House. So the broker view passes through this gate;
    // internal users (RM/admin/credit/compliance) see it as a real DIP gate.
    const bType = (deal.borrower_type || 'individual').toLowerCase();
    const isCorporateDeal = ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes(bType);
    const _roleForGate = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
    const _isInternalForGate = ['admin', 'rm', 'credit', 'compliance'].includes(_roleForGate);
    if (isCorporateDeal && deal.borrowers && deal.borrowers.length > 0) {
      // Only consider TOP-LEVEL borrowers — children (directors/PSCs/UBOs) are CH
      // verified as a side-effect of the parent's CH verify, but their individual
      // ch_verified_at can lag if they were inserted by a different code path.
      // The DIP gate should fire on top-level corporate parties, not their kids.
      const topLevelCorps = deal.borrowers.filter(b =>
        !b.parent_borrower_id &&
        ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes((b.borrower_type || '').toLowerCase())
      );
      const unverified = topLevelCorps.filter(b => !b.ch_verified_at);
      if (unverified.length > 0 && _isInternalForGate) {
        // Internal-only block: brokers don't see this as a missing field.
        result.ready = false;
        result.chGateBlocked = true;
        result.chUnverifiedCount = unverified.length;
        if (result.sections['Borrower / KYC']) {
          result.sections['Borrower / KYC'].status = 'partial';
          result.sections['Borrower / KYC'].missing.push('ch_role_verification');
          result.totalRequired++;
        }
      } else {
        // Either CH verify passed OR user is broker (gate doesn't apply).
        // Still count it as a filled requirement so totalRequired stays consistent.
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
      // 2026-04-21: alreadySubmitted now correctly excludes 'draft' alongside
      // 'received' — both are pre-submit stages. Previously a draft deal at
      // 100% completeness showed "Submitted — Under Review" falsely.
      const alreadySubmitted = currentStage && !['draft', 'received'].includes(currentStage);
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
      'Fees': 's4',
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
    // 2026-04-21: accept 'draft' as pre-submit alongside 'received'
    const submitCta = document.querySelector('#matrix-submit-cta button');
    if (submitCta && ['draft', 'received'].includes(currentStage)) {
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

    // Collect the fields that DETERMINE completeness for a section at this tier.
    // Step 2 (2026-04-21): this now means required + conditional-that-apply.
    // Nice fields are informational — they no longer block "complete" status
    // (e.g., a corporate borrower doesn't need to supply a date-of-birth to
    // pass Borrower/KYC). Use getTierDisplayFields() if you want the full set
    // including nice for display/counting purposes.
    function getTierFields(sectionName) {
      const cfg = tierSections[sectionName];
      if (!cfg) return [];
      const fields = [...(cfg.required || [])];
      if (Array.isArray(cfg.conditional)) {
        for (const cond of cfg.conditional) {
          // `when` predicate — include fields only if the predicate returns true
          if (typeof cond.when === 'function') {
            try { if (cond.when()) fields.push(...(cond.fields || [])); } catch (_) {}
          } else if (Array.isArray(cond.atLeastOne)) {
            // atLeastOne semantics: include all candidates; fieldHasValue passes
            // if any one is set (getPillStatus's per-field check handles this
            // naturally because "filled" count uses fieldHasValue per key).
            fields.push(...(cond.atLeastOne || []));
          } else if (Array.isArray(cond.fields)) {
            // Unconditional conditional (no `when`, no `atLeastOne`) — include fields
            fields.push(...cond.fields);
          }
        }
      }
      return Array.from(new Set(fields));
    }

    // Used ONLY for informational display (e.g., "X/Y fields" counter)
    // Includes required + conditional-that-apply + nice.
    function getTierDisplayFields(sectionName) {
      const required = getTierFields(sectionName);
      const cfg = tierSections[sectionName];
      const nice = cfg ? (cfg.nice || []) : [];
      return Array.from(new Set([...required, ...nice]));
    }

    // Map section names → section header IDs
    const SECTION_ID_MAP = {
      'Borrower / KYC': 's1',
      'Borrower Financials': 's2',
      'Property / Security': 's3',
      'Loan Terms': 's4',
      'Exit Strategy': 's5',
      'Fees': 's4',
      'AML & Source of Funds': 's2'  // AML fields roll up into s2 header
    };

    // Map field rows → which validation sections they draw from, and which specific fields.
    // 2026-04-21 Step 2: primary-borrower is now borrower-type-aware. Corporate
    // borrowers are measured against corporate fields (name, type, company_name,
    // company_number); individual borrowers against individual fields
    // (name, type, email, phone, dob, nationality). Consumes isCorporate()
    // which reads from the canonical deal_borrowers primary row first.
    const _primaryBorrowerFields = isCorporate()
      ? ['borrower_name', 'borrower_type', 'company_name', 'company_number']
      : ['borrower_name', 'borrower_type', 'borrower_email', 'borrower_phone', 'borrower_dob', 'borrower_nationality'];
    const ROW_SECTION_MAP = {
      'primary-borrower': { section: 'Borrower / KYC', fields: _primaryBorrowerFields },
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

  // ── If deal is past pre-submit stages, disable submit button and show read-only banner for brokers ──
  // 2026-04-21: 'draft' is also pre-submit (like 'received'). Previously this
  // gate was `currentStage !== 'received'` so DRAFT deals got the "Submitted
  // — Matrix is read-only" banner falsely + the disabled button state.
  if (!['draft', 'received'].includes(currentStage) && !isInternalUser) {
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

        // 2026-04-21: full re-render after submit so ALL stage-dependent UI
        // reflects the new state (info_gathering). Previously the function
        // only did manual DOM updates for the submit button + CTA banner,
        // leaving the top STAGE badge, stage pipeline, 'This deal is a
        // draft' banner, Matrix Completeness footer, and bottom Deal
        // Progress bar all stale. _refreshDealInPlace re-fetches deal and
        // re-renders the whole detail view with currentStage='info_gathering'.
        setTimeout(() => {
          try { _refreshDealInPlace(deal.submission_id); } catch (_) {}
        }, 800);
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
      // 2026-04-21: split into independent try/catch per panel so a failure in
      // the reconciliation panel does NOT stomp the successfully-rendered
      // ch-matrix-panel with "Failed to load" (previous bug — user saw Cohort
      // Capital rich panel rendering correctly while Gold Medal showed
      // "Failed to load" because reconciliation threw on empty borrowers[0]).
      if (!window._chVerifiedLoaded && companyNumber) {
        const panel = document.getElementById('ch-matrix-panel');
        const reconPanel = document.getElementById('ch-reconciliation-panel');

        // ── Panel 1: CH Matrix Panel (rich verification — primary content) ──
        if (panel) {
          panel.innerHTML = '<div style="padding:12px;text-align:center;color:#94A3B8;font-size:12px;">Loading Companies House data...</div>';
          try {
            await renderFullVerification(companyNumber, panel);
          } catch (e) {
            console.error('[ch-matrix-panel] renderFullVerification failed:', e && (e.stack || e.message || e));
            panel.innerHTML = '<div style="padding:12px;color:#F87171;font-size:12px;">CH data failed to load — ' + (e && e.message ? sanitizeHtml(e.message) : 'unknown error') + ' — click panel header to retry</div>';
          }
        }

        // ── Panel 2: Reconciliation Panel (independent — does NOT affect panel 1) ──
        if (reconPanel && submissionId) {
          try {
            const [chResp, bResp] = await Promise.all([
              fetchWithAuth(`${API_BASE}/api/companies-house/verify/${companyNumber}`),
              fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/borrowers`)
            ]);
            // Guard .json() in case of 304-with-empty-body / bad JSON
            let chData = {}, bData = {};
            try { chData = await chResp.json(); } catch (je) { console.warn('[ch-reconciliation] CH json parse:', je.message); }
            try { bData = await bResp.json(); } catch (je) { console.warn('[ch-reconciliation] borrowers json parse:', je.message); }

            if (chData.verification?.found && bData.borrowers?.length > 0) {
              // Reconciliation only makes sense for INDIVIDUALS who could legitimately be officers
              // of the primary company. Exclude:
              //   - corporate entities (a company is not a person and can't be a director here)
              //   - guarantors and their children (they belong to a separate party)
              //   - joint borrowers and their children (officers of a different company)
              const _corpTypes = ['corporate','spv','ltd','llp','limited','trust','partnership'];
              const _isCorpType = (t) => _corpTypes.includes((t || '').toLowerCase());
              const _primaryOnly = bData.borrowers.filter(b => {
                if (b.role === 'guarantor' || b.role === 'joint') return false;
                if (_isCorpType(b.borrower_type)) return false;
                if (b.parent_borrower_id) {
                  const parent = bData.borrowers.find(p => p.id === b.parent_borrower_id);
                  if (parent && (parent.role === 'guarantor' || parent.role === 'joint')) return false;
                }
                return true;
              });
              // Only render if there are actually individuals to reconcile against.
              // Empty list is LEGAL (corporate-only deals, UBO-only deals) and must NOT throw.
              if (_primaryOnly.length > 0) {
                renderReconciliation(reconPanel, chData.verification, _primaryOnly, submissionId);
              } else {
                reconPanel.innerHTML = '';  // leave blank, no reconciliation applicable
              }
            }
          } catch (e) {
            console.error('[ch-reconciliation-panel] load failed:', e && (e.stack || e.message || e));
            // Deliberately NOT overwriting ch-matrix-panel — keep rich CH data visible.
            reconPanel.innerHTML = '<div style="padding:12px;color:#FBBF24;font-size:11px;">Role reconciliation could not load (CH data above is fine) — ' + (e && e.message ? sanitizeHtml(e.message) : 'unknown error') + '</div>';
          }
        }

        window._chVerifiedLoaded = true;
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

// ── Toggle the WHOLE rich Property Intelligence wrapper (row chevron) ──────
// 2026-04-30: this is what the table row chevron calls. Toggles the outer
// prop-expand-${id} div which contains the entire tabbed Property Intel card,
// Chimnie, Area Intelligence, HMLR, RICS, Rental Data sub-panels.
// (Was missing — wrapper was display:none with no toggle function = "vaporised" bug.)
window._togglePropertyExpand = function(propertyId) {
  const wrapper = document.getElementById('prop-expand-' + propertyId);
  const chev = document.getElementById('prop-chev-' + propertyId);
  if (!wrapper) return;
  const isOpen = wrapper.style.display !== 'none';
  if (isOpen) {
    wrapper.style.display = 'none';
    if (chev) chev.style.transform = '';
  } else {
    wrapper.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(90deg)';
  }
};

// ── Toggle Property Intelligence INNER card (kept for tabbed-card internal use) ──
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

// 2026-04-30 — ORPHAN HANDLER SWEEP. 11 functions referenced in onclick/onchange
// across the matrix UI but never defined. Audit run via grep — see memory rule
// feedback_pre_commit_orphan_handler_audit. All wired to existing backend routes.

// ─── Generic collapse/expand helper for tabbed sub-panels ───
// Used by Chimnie, Area, HMLR, Rental tabs — all share the {prefix}-body /
// {prefix}-summary / {prefix}-chevron ID convention.
function _genericPanelToggle(prefix, propertyId) {
  const body = document.getElementById(prefix + '-body-' + propertyId);
  const chev = document.getElementById(prefix + '-chevron-' + propertyId);
  const summary = document.getElementById(prefix + '-summary-' + propertyId);
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  if (isCollapsed) {
    body.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(90deg)';
    if (summary) summary.style.display = 'none';
  } else {
    body.style.display = 'none';
    if (chev) chev.style.transform = '';
    if (summary) summary.style.display = 'inline';
  }
}
window._toggleChimniePanel = (id) => _genericPanelToggle('chimnie', id);
window._toggleAreaPanel    = (id) => _genericPanelToggle('area',    id);
window._toggleHmlrPanel    = (id) => _genericPanelToggle('hmlr',    id);
window._toggleRentalPanel  = (id) => _genericPanelToggle('rental',  id);

// ─── _freshAge: relative-date formatter ("3d ago", "2mo ago") ───
window._freshAge = function(iso, staleDays) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '';
  const days = Math.floor(ms / (24*60*60*1000));
  let label;
  if (days < 1) label = '<1d ago';
  else if (days < 30) label = days + 'd ago';
  else if (days < 365) label = Math.floor(days/30) + 'mo ago';
  else label = Math.floor(days/365) + 'y ago';
  // staleDays parameter: if non-null and exceeded, render in amber
  if (staleDays != null && days > staleDays) {
    return '<span style="color:#FBBF24;">' + label + ' · stale</span>';
  }
  return label;
};

// ─── _chimnieLookup: Fetch / Refresh Chimnie data for a property ───
window._chimnieLookup = async function(propertyId, submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/chimnie-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('Chimnie data refreshed');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'Chimnie lookup failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// ─── _hmlrPull: Pull OC1 register PDF for a property by title number ───
window._hmlrPull = async function(propertyId, submissionId, titleNum) {
  if (!confirm('Pull OC1 register from HMLR? This is a paid call (~£18-20).')) return;
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/hmlr/pull/${propertyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title_number: titleNum })
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('OC1 pulled');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'HMLR pull failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// ─── _hmlrSearch: Search HMLR for a title number by postcode/address ───
window._hmlrSearch = async function(propertyId, submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/hmlr/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: propertyId, submission_id: submissionId })
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('HMLR search complete');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'HMLR search failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// ─── _propertyDataPull: Pull rental benchmarks (PropertyData API) ───
window._propertyDataPull = async function(propertyId, submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/property/property-data-pull/${propertyId}`, {
      method: 'POST'
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('Rental data pulled');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'PropertyData pull failed', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// ─── _deleteDraftDeal: hard-delete a draft deal (pre-DIP only — gated server-side) ───
window._deleteDraftDeal = async function(submissionId, btnEl) {
  if (!confirm('Delete this draft deal? This cannot be undone. Only deals in draft stage can be hard-deleted.')) return;
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}`, { method: 'DELETE' });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('Draft deleted');
      // Remove the row from the deals list if present
      if (btnEl) {
        const row = btnEl.closest('tr, .deal-row');
        if (row) row.remove();
      } else {
        window.location.reload();
      }
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'Delete failed (deal may be past DIP — use Withdraw instead)', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// ─── _autoCalcSdlt: UK residential SDLT with +3% additional-property surcharge ───
// Bands as of 2026-04 — verify against HMRC if rates change.
// Standard rates: 0-£250k=0%, £250k-£925k=5%, £925k-£1.5m=10%, £1.5m+=12%.
// +3% surcharge on the WHOLE purchase price for additional dwellings / SPVs.
window._autoCalcSdlt = function(purchasePrice) {
  const price = Number(purchasePrice) || 0;
  if (price <= 0) {
    if (typeof showToast === 'function') showToast('Enter a purchase price first', 'error');
    return;
  }
  // Standard SDLT (residential)
  const bands = [
    { from: 0,        to: 250000,  rate: 0    },
    { from: 250000,   to: 925000,  rate: 0.05 },
    { from: 925000,   to: 1500000, rate: 0.10 },
    { from: 1500000,  to: Infinity, rate: 0.12 }
  ];
  let standardSdlt = 0;
  for (const b of bands) {
    if (price > b.from) {
      const taxable = Math.min(price, b.to) - b.from;
      standardSdlt += taxable * b.rate;
    }
  }
  // +3% surcharge on full price (additional dwelling / SPV)
  const surcharge = price * 0.03;
  const total = Math.round(standardSdlt + surcharge);

  // Write into the SDLT field — id `uses-sdlt` per matrix S&U convention
  const sdltField = document.getElementById('uses-sdlt') || document.querySelector('input[data-field="uses_sdlt"]');
  if (sdltField) {
    sdltField.value = total.toLocaleString('en-GB');
    // Trigger change event so matrixValidateAndSave fires
    sdltField.dispatchEvent(new Event('blur', { bubbles: true }));
    sdltField.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof showToast === 'function') showToast(`SDLT calculated: £${total.toLocaleString('en-GB')}`);
};

// 2026-04-30 — Property Accept / Undo Accept handlers. RM clicks ✓ Accept on
// the Property Intelligence panel header to lock in the search-result data.
// Both routes already exist on backend (/verify + /unverify); these were just
// the missing window.* handlers — same latent-bug pattern as prop-expand.
window._propertyVerify = async function(propertyId, submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/verify`, {
      method: 'POST'
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('Property accepted');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'Failed to accept property', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

window._propertyUnverify = async function(propertyId, submissionId) {
  if (!confirm('Undo Accept on this property? Search data will remain but the verified flag is removed.')) return;
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/unverify`, {
      method: 'POST'
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('Accept undone');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'Failed to undo accept', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// 2026-04-30 — EPC Apply button handler. Reads the broker's pick from the
// epc-picker-${pid} dropdown and POSTs to /select-epc. On success, refreshes
// the deal in place. Was missing — Apply button onclick referenced a function
// that didn't exist (same latent-bug pattern as prop-expand wrapper).
window._propertySelectEpc = async function(propertyId, submissionId) {
  const sel = document.getElementById('epc-picker-' + propertyId);
  if (!sel) {
    if (typeof showToast === 'function') showToast('EPC picker not found', 'error');
    return;
  }
  const lmk_key = sel.value;
  if (!lmk_key) {
    if (typeof showToast === 'function') showToast('Pick an EPC certificate first', 'error');
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/properties/${propertyId}/select-epc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lmk_key })
    });
    if (resp.ok) {
      if (typeof showToast === 'function') showToast('EPC applied');
      await _refreshDealInPlace(submissionId);
    } else {
      const err = await resp.json().catch(() => ({}));
      if (typeof showToast === 'function') showToast(err.error || 'Failed to apply EPC', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Network error: ' + e.message, 'error');
  }
};

// Sprint 2 #14 — Tabbed property card. Switches the active panel between
// Property Intel / Chimnie / Area / HMLR / RICS by toggling pane visibility
// and active tab styling. Each tab carries its semantic colour (green/blue/
// amber/purple/gold) and re-applies it as bottom border + text colour when
// activated; inactive tabs revert to muted slate.
window._togglePropTab = function(propertyId, tabName) {
  // Hide all panes for this property
  document.querySelectorAll('[data-prop-tab-pane="' + propertyId + '"]').forEach(el => {
    el.style.display = 'none';
  });
  // Show the selected pane
  const selPane = document.getElementById('prop-tab-pane-' + propertyId + '-' + tabName);
  if (selPane) selPane.style.display = 'block';
  // Update tab strip styling — active tab gets its semantic colour, others go muted
  document.querySelectorAll('[data-prop-tab="' + propertyId + '"]').forEach(t => {
    const isActive = t.dataset.tabName === tabName;
    const colour = t.dataset.tabColor || '#34D399';
    t.style.color = isActive ? colour : '#94A3B8';
    t.style.borderBottomColor = isActive ? colour : 'transparent';
  });
};

// Sprint 3 #16 — Sources & Uses helpers.
//
// _recalcSourcesUses(deal) — read all S&U input fields from the DOM, sum
//   uses + sources, update the total spans + balance pill. Auto-derives
//   arrangement fee + broker fee from loan_amount_approved × pct (matching
//   the existing fee formulae). Called on page load + on every input blur
//   via a global focusout listener (lazy-installed below).
//
// _autoCalcSdlt(purchasePrice) — compute UK residential SDLT with the
//   standard 3% second-home / additional-property surcharge. Result is
//   written into the SDLT field which auto-saves via the existing
//   matrixValidateAndSave hook. Bands as of 2026-04 — update if HMRC
//   changes them.
window._recalcSourcesUses = function (deal) {
  const $ = (id) => document.getElementById(id);
  const numFromField = (id) => {
    const el = $(id);
    if (!el) return 0;
    const raw = String(el.value || '').replace(/[^0-9.]/g, '');
    return Number(raw) || 0;
  };
  const valFromDeal = (k) => Number((deal && deal[k]) || 0);

  // USES
  // Sprint 5 #26 — the primary-use amount lives in a single input with a
  // dynamic data-field. Read it once and route it into the right bucket
  // so the matching column also gets dropped from its own getter (else
  // we'd double-count).
  const primaryAmt = $('primary-use-amount');
  const primaryCol = primaryAmt ? primaryAmt.getAttribute('data-field') : null;
  const primaryNum = (() => {
    if (!primaryAmt) return 0;
    const r = String(primaryAmt.value || '').replace(/[^0-9.]/g, '');
    return Number(r) || 0;
  })();
  const fromPrimary = (col) => primaryCol === col ? primaryNum : 0;

  const purchasePrice  = fromPrimary('purchase_price')      || numFromField('mf-purchase_price')      || valFromDeal('purchase_price');
  const sdlt           = numFromField('mf-uses_sdlt')       || valFromDeal('uses_sdlt');
  const refurb         = fromPrimary('refurb_cost')         || numFromField('mf-refurb_cost')         || valFromDeal('refurb_cost');
  const legal          = numFromField('mf-uses_legal_fees') || valFromDeal('uses_legal_fees');
  const otherUses      = fromPrimary('uses_other_amount')   || numFromField('mf-uses_other_amount')   || valFromDeal('uses_other_amount');
  const loanRedemption = fromPrimary('uses_loan_redemption')|| numFromField('mf-uses_loan_redemption')|| valFromDeal('uses_loan_redemption');

  // Lender fees auto-derived from loan_amount_approved × pct (matches
  // services/fee-formulae.js convention). DIP fee + commitment fee are
  // already absolute £ values. Default arrangement_fee_pct = 2.0% if unset.
  const loanApproved   = numFromField('mf-loan_amount_approved') || valFromDeal('loan_amount_approved') || valFromDeal('loan_amount');
  const arrFeePct      = numFromField('mf-arrangement_fee_pct') || valFromDeal('arrangement_fee_pct') || 0;
  const brokerFeePct   = numFromField('mf-broker_fee_pct') || valFromDeal('broker_fee_pct') || 0;
  const commitmentFee  = numFromField('mf-commitment_fee') || valFromDeal('commitment_fee');
  const dipFee         = numFromField('mf-dip_fee') || valFromDeal('dip_fee');
  const arrangementFee = (loanApproved * arrFeePct) / 100;
  const brokerFee      = (loanApproved * brokerFeePct) / 100;
  const lenderFeesTotal = arrangementFee + brokerFee + commitmentFee + dipFee;

  const totalUses = purchasePrice + sdlt + refurb + legal + otherUses + lenderFeesTotal + loanRedemption;

  // SOURCES
  const seniorLoan   = numFromField('mf-loan_amount_approved') || loanApproved;
  const secondCharge = numFromField('mf-sources_second_charge') || valFromDeal('sources_second_charge');
  const equity       = numFromField('mf-sources_equity') || valFromDeal('sources_equity');
  const otherSources = numFromField('mf-sources_other_amount') || valFromDeal('sources_other_amount');
  const totalSources = seniorLoan + secondCharge + equity + otherSources;

  // Render the inline lender-fees breakdown
  const feesEl = $('sus-fees-list');
  if (feesEl) {
    const fmt = (v) => '£' + Math.round(v).toLocaleString('en-GB');
    feesEl.innerHTML =
      '<div>· Arrangement fee (' + (arrFeePct || 0).toFixed(2) + '%): <strong>' + fmt(arrangementFee) + '</strong></div>' +
      '<div>· Broker fee ('       + (brokerFeePct || 0).toFixed(2) + '%): <strong>' + fmt(brokerFee) + '</strong></div>' +
      '<div>· Commitment fee: <strong>' + fmt(commitmentFee) + '</strong></div>' +
      '<div>· DIP fee: <strong>' + fmt(dipFee) + '</strong></div>';
  }

  // Update total spans
  const usesEl = $('sus-total-uses');
  if (usesEl) usesEl.textContent = '£' + Math.round(totalUses).toLocaleString('en-GB');
  const srcEl = $('sus-total-sources');
  if (srcEl) srcEl.textContent = '£' + Math.round(totalSources).toLocaleString('en-GB');

  // Balance pill
  const pill = $('sus-balance-pill');
  if (pill) {
    const diff = Math.round(totalSources - totalUses);
    if (totalUses === 0 && totalSources === 0) {
      pill.style.background = 'rgba(100,116,139,0.12)';
      pill.style.color = '#94A3B8';
      pill.textContent = '— No data yet';
    } else if (Math.abs(diff) < 1) {
      pill.style.background = 'rgba(52,211,153,0.15)';
      pill.style.color = '#34D399';
      pill.textContent = '✓ Balanced';
    } else if (diff > 0) {
      pill.style.background = 'rgba(244,183,64,0.15)';
      pill.style.color = '#FBBF24';
      pill.textContent = '⚠ Sources over by £' + diff.toLocaleString('en-GB');
    } else {
      pill.style.background = 'rgba(239,91,91,0.15)';
      pill.style.color = '#F87171';
      pill.textContent = '⚠ Short by £' + Math.abs(diff).toLocaleString('en-GB');
    }
  }
};

// Lazy-install a focusout listener so any S&U field edit re-runs the calc.
if (!window._susFocusoutInstalled) {
  document.addEventListener('focusout', (e) => {
    const id = e.target && e.target.id;
    if (!id || !id.startsWith('mf-')) return;
    const watched = ['purchase_price','uses_sdlt','refurb_cost','uses_legal_fees',
                     'uses_other_amount','uses_loan_redemption',
                     'loan_amount_approved','arrangement_fee_pct',
                     'broker_fee_pct','commitment_fee','dip_fee',
                     'sources_second_charge','sources_equity','sources_other_amount'];
    const field = id.substring(3);
    if (!watched.includes(field)) return;
    if (typeof window._recalcSourcesUses === 'function') {
      // Pass the cached deal if present, else empty object — DOM values still drive totals.
      window._recalcSourcesUses(window.currentDeal || {});
    }
  });
  window._susFocusoutInstalled = true;
}

// Sprint 5 #25 (2026-04-28) — Rebuild the conditional Uses fields when
// loan_purpose changes from the dropdown. Without this, the layout sticks
// at whatever loan_purpose was set at page render (typically "" → Acquisition
// default), even after the user picks Refinance and the value saves.
//
// Reads the new loan_purpose from the dropdown DOM, decides which layout
// applies, and rewrites the inner HTML of #sus-uses-conditional. Field IDs
// (mf-purchase_price, mf-uses_loan_redemption, etc.) stay matrixSaveField-
// compatible so auto-save on blur continues to work.
window._rebuildSusUses = function () {
  const host = document.getElementById('sus-uses-conditional');
  const tag  = document.getElementById('sus-layout-tag');
  if (!host) return;
  const sel = document.getElementById('mf-loan_purpose');
  const lp = ((sel && sel.value) || (window.currentDeal && window.currentDeal.loan_purpose) || '').toLowerCase();
  const deal = window.currentDeal || {};
  // Pick up any in-progress edits in DOM so we don't lose them on rebuild
  const readNum = (k) => {
    const el = document.getElementById('mf-' + k);
    if (!el) return deal[k];
    const raw = String(el.value || '').replace(/[^0-9.]/g, '');
    return raw === '' ? deal[k] : raw;
  };
  const liveDeal = Object.assign({}, deal, {
    purchase_price:        readNum('purchase_price'),
    uses_sdlt:             readNum('uses_sdlt'),
    uses_loan_redemption:  readNum('uses_loan_redemption'),
    refurb_cost:           readNum('refurb_cost'),
    uses_legal_fees:       readNum('uses_legal_fees')
  });
  const canEdit = !!(window.currentCanEdit !== false);

  const isAcq    = ['acquisition','auction_purchase','chain_break'].includes(lp);
  const isRefi   = ['refinance','cash_out','bridge_to_sale','bridge_to_let','development_exit'].includes(lp);
  const isRefurb = ['light_refurb','heavy_refurb'].includes(lp);

  if (tag) {
    const txt = isAcq ? 'Acquisition layout'
              : isRefi ? 'Refinance layout'
              : isRefurb ? 'Refurb layout'
              : 'Generic layout — set Loan Purpose to refine';
    tag.textContent = '· ' + txt;
  }

  // Use the same renderEditableField that the matrix uses so saves still wire
  const ref = (typeof window.renderEditableField === 'function')
    ? window.renderEditableField
    : null;
  if (!ref) {
    // Fall back: trigger a deal refetch + full matrix re-render
    if (typeof window.refreshMatrix === 'function') window.refreshMatrix();
    return;
  }

  let html = '';
  if (isAcq || isRefurb || !lp) {
    html += ref('purchase_price', 'Purchase price (£)', liveDeal.purchase_price, 'money', canEdit);
    html += ref('uses_sdlt', 'Stamp Duty / SDLT (£)', liveDeal.uses_sdlt, 'money', canEdit);
    if (canEdit) {
      html += '<button onclick="window._autoCalcSdlt(' + (Number(liveDeal.purchase_price) || 0) + ')" style="padding:3px 10px;background:rgba(78,161,255,0.12);color:#4EA1FF;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;margin-bottom:10px;">↻ Auto-calc SDLT from purchase price</button>';
    }
  }
  if (isRefi) {
    html += ref('uses_loan_redemption', 'Loan redemption — existing lender payoff (£)', liveDeal.uses_loan_redemption, 'money', canEdit);
    html += ref('uses_sdlt', 'Stamp Duty / SDLT if any (£)', liveDeal.uses_sdlt, 'money', canEdit);
  }
  html += ref('refurb_cost', 'Refurb cost (£)', liveDeal.refurb_cost, 'money', canEdit);
  html += ref('uses_legal_fees', 'Legal fees (£)', liveDeal.uses_legal_fees, 'money', canEdit);

  host.innerHTML = html;

  // Recompute totals after rebuild so the balance pill stays accurate
  setTimeout(() => {
    if (typeof window._recalcSourcesUses === 'function') {
      window._recalcSourcesUses(window.currentDeal || {});
    }
  }, 50);
};

// Watch the loan_purpose dropdown (and any future change to it) and rebuild
// the Uses block. Listens for both 'change' (immediate) and the matrix's
// own 'matrix:fieldSaved' custom event if it exists.
if (!window._loanPurposeWatcherInstalled) {
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'mf-loan_purpose') {
      // Update window.currentDeal so the rebuild reads the new value even
      // before the PUT round-trip completes
      if (window.currentDeal) {
        window.currentDeal.loan_purpose = e.target.value;
      }
      window._rebuildSusUses();
    }
  });
  // If the matrix dispatches a save-success event for any field, also
  // rebuild when loan_purpose was the saved field.
  document.addEventListener('matrix:fieldSaved', (e) => {
    if (e && e.detail && e.detail.field === 'loan_purpose') {
      if (window.currentDeal) {
        window.currentDeal.loan_purpose = e.detail.value;
      }
      window._rebuildSusUses();
    }
  });
  window._loanPurposeWatcherInstalled = true;
}

// Sprint 5 #26 — Explicit "Primary use type" dropdown handlers.
//
// _onPrimaryUseChange — called when the dropdown changes. Saves the new
//   uses_primary_type to the backend, swaps the amount field's data-field
//   attribute + label, repopulates the amount field with the value of the
//   newly active column, and updates the layout tag.
//
// _savePrimaryUseAmount(input) — onblur handler for the amount field.
//   Reads the current data-field, parses the amount, saves via the existing
//   matrixValidateAndSave hook, then re-runs S&U totals.
window._onPrimaryUseChange = function () {
  const dd = document.getElementById('mf-uses_primary_type');
  if (!dd) return;
  const newType = dd.value;
  if (!newType) return;

  // Persist the choice itself
  if (typeof window.matrixSaveField === 'function') {
    window.matrixSaveField('uses_primary_type', newType);
  }

  // Update window.currentDeal so subsequent reads use the new value
  if (window.currentDeal) {
    window.currentDeal.uses_primary_type = newType;
  }

  // Map type → { label, column, value-from-deal }
  const deal = window.currentDeal || {};
  const fieldMap = {
    purchase:  { label: 'Purchase price (£)',                          col: 'purchase_price',        val: deal.purchase_price },
    refinance: { label: 'Loan redemption — existing lender payoff (£)', col: 'uses_loan_redemption',  val: deal.uses_loan_redemption },
    refurb:    { label: 'Refurb cost (£)',                              col: 'refurb_cost',           val: deal.refurb_cost },
    other:     { label: 'Other primary use amount (£)',                 col: 'uses_other_amount',     val: deal.uses_other_amount }
  };
  const fm = fieldMap[newType] || fieldMap.purchase;

  // Update label
  const lbl = document.getElementById('primary-use-label');
  if (lbl) lbl.textContent = fm.label;

  // Update amount input — change data-field + value (without losing what user typed,
  // we re-show the corresponding column's saved value)
  const amt = document.getElementById('primary-use-amount');
  if (amt) {
    amt.setAttribute('data-field', fm.col);
    const v = fm.val == null ? '' : String(fm.val);
    // Format with commas if numeric
    const formatted = v
      ? Number(String(v).replace(/[^0-9.]/g, '')).toLocaleString('en-GB')
      : '';
    amt.value = formatted;
  }

  // Update layout tag
  const tag = document.getElementById('sus-layout-tag');
  if (tag) {
    const txtMap = { purchase: '· Purchase', refinance: '· Refinance', refurb: '· Refurb-only', other: '· Other' };
    tag.textContent = txtMap[newType] || '· ' + newType;
  }

  // Recompute totals
  if (typeof window._recalcSourcesUses === 'function') {
    window._recalcSourcesUses(window.currentDeal || {});
  }
};

window._savePrimaryUseAmount = function (input) {
  if (!input) return;
  const col = input.getAttribute('data-field');
  if (!col) return;
  const raw = String(input.value || '').replace(/[^0-9.]/g, '');
  if (typeof window.matrixValidateAndSave === 'function') {
    window.matrixValidateAndSave(col, raw, 'money');
  }
  // Mirror to window.currentDeal so next dropdown switch sees the latest value
  if (window.currentDeal) {
    const num = Number(raw);
    window.currentDeal[col] = isNaN(num) ? null : num;
  }
};
// ════════════════════════════════════════════════════════════════════════════
// Phase 1 Save Section logic (2026-05-03) — backlog #2.
// Activated for s4 (Loan Terms) + s7 (Credit Approval) only.
// Globals declared at top of file (_matrixDirtyFields / _matrixLastSavedAt /
// _matrixIdleTimer / _matrixReminderShown). DIP tab guard + beforeunload
// land in Paste 3. See memory project_save_buttons_design_2026_05_03.md.
// ════════════════════════════════════════════════════════════════════════════

window.matrixMarkDirty = function (sectionId, fieldKey) {
  if (!window._matrixDirtyFields[sectionId]) {
    window._matrixDirtyFields[sectionId] = new Set();
  }
  window._matrixDirtyFields[sectionId].add(fieldKey);

  // Orange dirty border on the input
  const input = document.querySelector('[data-field="' + fieldKey + '"]');
  if (input) input.classList.add('matrix-dirty');

  // Save button: enable + change to "Save"
  const btn = document.getElementById('save-btn-' + sectionId);
  if (btn) {
    btn.disabled = false;
    btn.style.cursor = 'pointer';
    btn.style.opacity = '1';
    btn.style.background = 'rgba(52,211,153,0.15)';
    btn.textContent = 'Save';
  }

  // Q4: 2-min idle reminder. Reset timer on each markDirty call.
  if (window._matrixIdleTimer) clearTimeout(window._matrixIdleTimer);
  window._matrixIdleTimer = setTimeout(function () {
    if (!window._matrixReminderShown[sectionId] && window._matrixDirtyFields[sectionId] && window._matrixDirtyFields[sectionId].size > 0) {
      window.matrixIdleReminder(sectionId);
      window._matrixReminderShown[sectionId] = true;
    }
  }, 120000);
};

window.matrixSaveSection = async function (sectionId) {
  const dirty = window._matrixDirtyFields[sectionId];
  if (!dirty || dirty.size === 0) return;

  const btn = document.getElementById('save-btn-' + sectionId);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; btn.style.opacity = '0.7'; }

  // Gather current values for all dirty fields
  const payload = {};
  dirty.forEach(function (fieldKey) {
    const input = document.querySelector('[data-field="' + fieldKey + '"]');
    if (input) payload[fieldKey] = input.value;
  });

  // Resolve current deal ID — try multiple lookup patterns
  const dealId = (window.currentDeal && window.currentDeal.submission_id)
    || (window.currentDealId)
    || (document.querySelector('[data-submission-id]') && document.querySelector('[data-submission-id]').dataset.submissionId);
  if (!dealId) {
    if (typeof showToast === 'function') showToast('Cannot save: deal ID missing', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; btn.style.opacity = '1'; }
    return;
  }

  try {
    const res = await fetchWithAuth(API_BASE + '/api/deals/' + dealId + '/matrix-fields', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Success: clear dirty borders, clear set, update label, reset reminder
    dirty.forEach(function (fieldKey) {
      const input = document.querySelector('[data-field="' + fieldKey + '"]');
      if (input) input.classList.remove('matrix-dirty');
    });
    window._matrixDirtyFields[sectionId].clear();
    window._matrixLastSavedAt[sectionId] = new Date();
    window._matrixReminderShown[sectionId] = false;
    if (window._matrixIdleTimer) { clearTimeout(window._matrixIdleTimer); window._matrixIdleTimer = null; }

    if (btn) {
      btn.disabled = true;
      btn.style.cursor = 'not-allowed';
      btn.style.opacity = '0.5';
      btn.style.background = 'rgba(52,211,153,0.05)';
      const t = window._matrixLastSavedAt[sectionId];
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      btn.textContent = 'Saved ' + hh + ':' + mm;
    }
    if (typeof showToast === 'function') showToast('Section saved', 'success');
    // Phase 1.5 — trigger full deal re-render so snapshot reflects new approved values.
    // _refreshDealInPlace is at top of file (module scope, hoisted), preserves expand state.
    setTimeout(function () {
      if (typeof _refreshDealInPlace === 'function') _refreshDealInPlace(dealId);
    }, 250);
  } catch (err) {
    console.error('[matrixSaveSection] failed:', err);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; btn.style.opacity = '1'; }
    if (typeof showToast === 'function') showToast('Save failed: ' + err.message, 'error');
  }
};

window.matrixIdleReminder = function (sectionId) {
  if (window._matrixReminderShown[sectionId]) return;
  const sectionLabel = sectionId === 's4' ? 'Loan Terms' : (sectionId === 's7' ? 'Credit Approval' : sectionId);

  const existing = document.getElementById('matrix-reminder-' + sectionId);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'matrix-reminder-' + sectionId;
  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1f2937;border:1px solid rgba(251,146,60,0.6);color:#FBBF24;padding:12px 16px;border-radius:6px;font-size:12px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:9999;max-width:320px;cursor:pointer;';
  toast.innerHTML = '<div>You have unsaved changes in <span style="color:#FFF">' + sectionLabel + '</span></div><div style="font-size:10px;color:#94A3B8;margin-top:4px;">Click here to scroll · auto-dismiss in 30s</div>';
  toast.onclick = function () {
    const target = document.querySelector('[data-section-header="' + sectionId + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast.remove();
  };
  document.body.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.remove(); }, 30000);
};

window.matrixValidateLocal = function (fieldKey, rawValue, dataType) {
  // Validation only — never writes to backend. Used for s4/s7 RM-numeric
  // fields where the explicit Save button is the persistence path.
  const input = document.querySelector('[data-field="' + fieldKey + '"]');
  if (!input) return;
  input.style.borderColor = '';
  input.title = '';

  if (rawValue == null || rawValue === '') return;

  if (dataType === 'money' || dataType === 'pct' || dataType === 'percent' || dataType === 'rate' || dataType === 'numeric') {
    const cleaned = String(rawValue).replace(/[£$€,%\s]/g, '');
    const n = parseFloat(cleaned);
    if (isNaN(n)) {
      input.style.borderColor = '#F87171';
      input.title = 'Must be a number';
    }
  }
};
// ════════════════════════════════════════════════════════════════════════════
// Phase 1 wiring (2026-05-03) — auto-attach markDirty / validateLocal to
// every editable input inside content-s4 and content-s7. Runs via
// MutationObserver so it survives matrix re-renders without modifying any
// existing render code. Inputs in OTHER sections keep their original
// blur-save behaviour. Idempotent: tagged inputs ([data-phase1-wired]) are
// skipped on subsequent observer ticks.
// ════════════════════════════════════════════════════════════════════════════

window.matrixAutoWirePhase1 = function () {
  if (window._matrixPhase1Observer) return; // already running

  const wireSection = function (sectionId) {
    const container = document.getElementById('content-' + sectionId);
    if (!container) return;
    const inputs = container.querySelectorAll('input[data-field]:not([data-phase1-wired]), select[data-field]:not([data-phase1-wired]), textarea[data-field]:not([data-phase1-wired])');
    inputs.forEach(function (input) {
      const fieldKey = input.getAttribute('data-field');
      const dataType = input.getAttribute('data-type') || 'text';
      const tag = input.tagName.toLowerCase();
      input.setAttribute('data-phase1-wired', '1');
      input.removeAttribute('onblur');
      input.removeAttribute('onchange');

      if (tag === 'select') {
        input.addEventListener('change', function () {
          window.matrixMarkDirty(sectionId, fieldKey);
        });
      } else {
        input.addEventListener('input', function () {
          window.matrixMarkDirty(sectionId, fieldKey);
        });
        input.addEventListener('blur', function () {
          window.matrixValidateLocal(fieldKey, this.value, dataType);
        });
      }
    });
  };

  // Initial sweep + observe future re-renders
  ['s4', 's7'].forEach(wireSection);
  const observer = new MutationObserver(function () {
    ['s4', 's7'].forEach(wireSection);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window._matrixPhase1Observer = observer;
};

// Auto-start when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.matrixAutoWirePhase1);
  } else {
    window.matrixAutoWirePhase1();
  }
}
// ════════════════════════════════════════════════════════════════════════════
// Phase 1 closing (2026-05-03) — beforeunload guard. Browser confirms
// before close/navigate when matrix has unsaved changes in any tracked
// section. Q1=B (hard-block on DIP-section approval) deferred to Phase 1.5
// alongside the planned "Deal Status Bar" quick-nav at top of deal page.
// See memory project_save_buttons_design_2026_05_03.md.
// ════════════════════════════════════════════════════════════════════════════

window.matrixCheckDirty = function () {
  if (!window._matrixDirtyFields) return false;
  return Object.values(window._matrixDirtyFields).some(function (s) { return s && s.size > 0; });
};

window.addEventListener('beforeunload', function (e) {
  if (window.matrixCheckDirty()) {
    e.preventDefault();
    e.returnValue = 'You have unsaved matrix changes.';
    return e.returnValue;
  }
});