import { API_BASE } from './config.js';
import { showScreen, showToast, formatNumber, formatPct, formatDate, formatDateTime, sanitizeHtml, attachMoneyFormat, getMoneyValue, parseFormattedNumber } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentUser, getCurrentRole, setCurrentDealData, setCurrentDealId, getCurrentDealId, restoreDipFormState, hasDipFormState } from './state.js';
import { renderDocumentsList } from './documents.js';
import { populateOnboardingData, switchDetailTab, injectOnboardingSectionControls } from './onboarding.js';
import { renderDocPanel } from './doc-panel.js';
import { renderDealMatrix } from './deal-matrix.js';

/**
 * Show deal detail screen
 */
export async function showDealDetail(dealId) {
  const authToken = getAuthToken();
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();

  if (!authToken) return;

  try {
    const internalRoles = ['admin', 'rm', 'credit', 'compliance'];
    const isInternal = internalRoles.includes(currentRole);
    const endpoint = isInternal ? `/api/admin/deals/${dealId}` : `/api/deals/${dealId}`;

    const resp = await fetchWithAuth(`${API_BASE}${endpoint}`, {
      method: 'GET'
    });

    const data = await resp.json();

    if (!resp.ok) {
      showToast('Failed to load deal details', true);
      return;
    }

    const deal = data.deal;
    setCurrentDealId(dealId);
    setCurrentDealData(deal);
    window.currentDealId = dealId;
    window.currentDealData = deal;

    // Render document sidebar
    renderDocPanel(deal);

    // Set logged-in user info in header
    document.getElementById('detail-user-name').textContent = `${sanitizeHtml(currentUser.first_name)} ${sanitizeHtml(currentUser.last_name)}`;
    document.getElementById('detail-user-role').textContent = currentRole.toUpperCase();

    // Update breadcrumb
    document.getElementById('breadcrumb-ref').textContent = `${dealId.substring(0, 8)}`;

    // Header
    document.getElementById('detail-property-address').textContent = sanitizeHtml(deal.security_address || 'N/A');
    document.getElementById('detail-ref-id').textContent = dealId;
    document.getElementById('detail-date').textContent = formatDate(deal.created_at);

    // Status badge
    const statusEl = document.getElementById('detail-status-badge');
    statusEl.className = `status-badge status-${deal.status}`;
    statusEl.textContent = sanitizeHtml(deal.status.charAt(0).toUpperCase() + deal.status.slice(1));

    // Stage badge
    const stage = deal.deal_stage || 'received';
    const stageEl = document.getElementById('detail-stage-badge');
    const stageLabels = {
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };
    stageEl.textContent = stageLabels[stage] || sanitizeHtml(stage);
    stageEl.className = `stage-badge stage-${stage}`;

    // ── Helper: make a field editable for internal users or read-only for external ──
    const canEdit = isInternal; // RM, admin, credit, compliance can edit intake fields
    const inputStyle = 'width:100%;padding:5px 8px;border-radius:4px;font-size:13px;font-family:inherit;';
    const editableStyle = inputStyle + 'border:1px solid #c9a84c;background:#fffdf5;';
    const readonlyStyle = inputStyle + 'border:1px solid #e5e7eb;background:#f9fafb;color:#374151;';

    const moneyInputIds = []; // track money fields for post-render formatting

    function setField(elId, value, opts) {
      const el = document.getElementById(elId);
      if (!el) return;
      const v = value || '';
      if (canEdit) {
        const fieldName = opts?.field || elId.replace('detail-', '');
        const type = opts?.type || 'text';
        const inputId = 'intake-' + fieldName; // unique ID for the input
        if (type === 'select' && opts?.options) {
          let selectHtml = '<select id="' + inputId + '" data-field="' + fieldName + '" class="intake-editable" style="' + editableStyle + '">';
          opts.options.forEach(o => {
            selectHtml += '<option value="' + o.value + '"' + (o.value === v ? ' selected' : '') + '>' + sanitizeHtml(o.label) + '</option>';
          });
          selectHtml += '</select>';
          el.innerHTML = selectHtml;
        } else if (type === 'textarea') {
          el.innerHTML = '<textarea id="' + inputId + '" data-field="' + fieldName + '" class="intake-editable" style="' + editableStyle + 'min-height:50px;resize:vertical;">' + sanitizeHtml(v) + '</textarea>';
        } else {
          el.innerHTML = '<input id="' + inputId + '" type="' + type + '" data-field="' + fieldName + '" class="intake-editable" value="' + sanitizeHtml(v) + '" style="' + editableStyle + '">';
          // Track money fields for comma formatting
          if (opts?.money) {
            moneyInputIds.push(inputId);
          }
        }
      } else {
        el.textContent = opts?.display || v || 'N/A';
      }
    }

    // ── TAB: Overview ──
    // Auto-calculate indicative loan & LTV
    const dVal = deal.current_value ? Number(deal.current_value) : null;
    const dPurchase = deal.purchase_price ? Number(deal.purchase_price) : null;
    const dRefurb = deal.refurb_cost ? Number(deal.refurb_cost) : 0;
    let dLoan = deal.loan_amount ? Number(deal.loan_amount) : null;
    let dLtv = deal.ltv_requested ? Number(deal.ltv_requested) : null;
    let loanIndicative = false;
    let ltvIndicative = false;

    if (!dLoan && (dVal || dPurchase)) {
      const maxLtv = dVal ? dVal * 0.75 : Infinity;
      const totalCost = dPurchase ? dPurchase + dRefurb : Infinity;
      const maxLtc = totalCost < Infinity ? totalCost * 0.90 : Infinity;
      const calc = Math.min(maxLtv, maxLtc);
      if (calc < Infinity) {
        dLoan = Math.round(calc);
        loanIndicative = true;
      }
    }

    if (!dLtv && dLoan && dVal && dVal > 0) {
      dLtv = Math.round((dLoan / dVal) * 100);
      ltvIndicative = true;
    }

    setField('detail-loan-amount', String(dLoan || ''), { field: 'loan_amount', money: true, display: dLoan ? '£' + formatNumber(dLoan) + (loanIndicative ? ' (INDICATIVE)' : '') : '£0' });
    setField('detail-ltv', String(dLtv || ''), { field: 'ltv_requested', display: dLtv ? formatPct(dLtv) + '%' + (ltvIndicative ? ' (INDICATIVE)' : '') : 'N/A' });
    setField('detail-property-value', String(deal.current_value || ''), { field: 'current_value', money: true, display: '£' + formatNumber(deal.current_value || 0) });
    setField('detail-loan-purpose', deal.loan_purpose || '', { field: 'loan_purpose', type: 'textarea' });
    setField('detail-term', String(deal.term_months || ''), { field: 'term_months', display: deal.term_months ? deal.term_months + ' months' : 'N/A' });
    setField('detail-interest-servicing', deal.interest_servicing || '', { field: 'interest_servicing', type: 'select', options: [
      { value: 'retained', label: 'Retained' }, { value: 'serviced', label: 'Serviced' }, { value: 'rolled_up', label: 'Rolled Up' }
    ]});
    setField('detail-drawdown-date', deal.drawdown_date ? deal.drawdown_date.substring(0, 10) : '', { field: 'drawdown_date', type: 'date', display: deal.drawdown_date ? formatDate(deal.drawdown_date) : 'N/A' });
    setField('detail-asset-type', deal.asset_type || '', { field: 'asset_type', type: 'select', options: [
      { value: 'residential', label: 'Residential' }, { value: 'commercial', label: 'Commercial' }, { value: 'mixed_use', label: 'Mixed Use' },
      { value: 'land', label: 'Land' }, { value: 'hmo', label: 'HMO' }, { value: 'mufb', label: 'MUFB' }
    ]});
    setField('detail-exit-strategy', deal.exit_strategy || '', { field: 'exit_strategy', type: 'textarea' });
    setField('detail-existing-charges', deal.existing_charges || '', { field: 'existing_charges', type: 'textarea' });
    setField('detail-notes', deal.additional_notes || '', { field: 'additional_notes', type: 'textarea' });

    // ── TAB: Borrower ──
    // Corporate borrower banner
    const bType = (deal.borrower_type || 'individual').toLowerCase();
    const isCorporateDeal = bType === 'corporate' || bType === 'spv' || bType === 'ltd' || bType === 'llp';
    const borrowerTab = document.getElementById('dtab-borrower');
    if (borrowerTab && isCorporateDeal) {
      const banner = document.createElement('div');
      banner.style.cssText = 'margin:0 0 12px;padding:10px 14px;background:#dbeafe;border:1px solid #3b82f6;border-radius:6px;display:flex;justify-content:space-between;align-items:center;';
      banner.innerHTML = '<div><strong style="color:#1e40af;font-size:14px;">CORPORATE BORROWER</strong><br><span style="font-size:13px;">' + sanitizeHtml(deal.company_name || deal.borrower_company || '') + (deal.company_number ? ' &middot; Co. ' + sanitizeHtml(deal.company_number) : '') + '</span></div><div style="text-align:right;"><span style="font-size:11px;color:#6b7280;">UBO / Director</span><br><strong>' + sanitizeHtml(deal.borrower_name || '') + '</strong></div>';
      const panel = borrowerTab.querySelector('.detail-panel');
      if (panel) panel.insertBefore(banner, panel.firstChild);
    }

    setField('detail-borrower-name', deal.borrower_name || '', { field: 'borrower_name' });
    setField('detail-borrower-dob', deal.borrower_dob ? deal.borrower_dob.substring(0, 10) : '', { field: 'borrower_dob', type: 'date', display: deal.borrower_dob ? formatDate(deal.borrower_dob) : 'N/A' });
    setField('detail-borrower-nationality', deal.borrower_nationality || '', { field: 'borrower_nationality' });
    setField('detail-borrower-jurisdiction', deal.borrower_jurisdiction || '', { field: 'borrower_jurisdiction' });
    setField('detail-borrower-type', deal.borrower_type || 'individual', { field: 'borrower_type', type: 'select', options: [
      { value: 'individual', label: 'Individual' }, { value: 'corporate', label: 'Corporate' }, { value: 'spv', label: 'SPV' }, { value: 'llp', label: 'LLP' }
    ]});
    setField('detail-company-name', deal.company_name || '', { field: 'company_name' });
    setField('detail-company-number', deal.company_number || '', { field: 'company_number' });
    setField('detail-borrower-email', deal.borrower_email || '', { field: 'borrower_email', type: 'email' });
    setField('detail-borrower-phone', deal.borrower_phone || '', { field: 'borrower_phone', type: 'tel' });

    // ── TAB: Property ──
    setField('detail-prop-address', deal.security_address || '', { field: 'security_address', type: 'textarea' });
    setField('detail-prop-postcode', deal.security_postcode || '', { field: 'security_postcode' });
    setField('detail-prop-type', deal.asset_type || '', { field: 'asset_type', type: 'select', options: [
      { value: 'residential', label: 'Residential' }, { value: 'commercial', label: 'Commercial' }, { value: 'mixed_use', label: 'Mixed Use' },
      { value: 'land', label: 'Land' }, { value: 'hmo', label: 'HMO' }, { value: 'mufb', label: 'MUFB' }
    ]});
    setField('detail-prop-value', String(deal.current_value || ''), { field: 'current_value', money: true, display: deal.current_value ? '£' + formatNumber(deal.current_value) : 'N/A' });
    setField('detail-prop-purchase', String(deal.purchase_price || ''), { field: 'purchase_price', money: true, display: deal.purchase_price ? '£' + formatNumber(deal.purchase_price) : 'N/A' });
    setField('detail-prop-tenure', deal.property_tenure || '', { field: 'property_tenure', type: 'select', options: [
      { value: 'freehold', label: 'Freehold' }, { value: 'leasehold', label: 'Leasehold' }
    ]});
    setField('detail-prop-occupancy', deal.occupancy_status || '', { field: 'occupancy_status', type: 'select', options: [
      { value: 'vacant', label: 'Vacant' }, { value: 'tenanted', label: 'Tenanted' }, { value: 'owner_occupied', label: 'Owner Occupied' }
    ]});
    setField('detail-prop-use', deal.current_use || '', { field: 'current_use' });

    // ── TAB: Use of Funds ──
    setField('detail-use-of-funds', deal.use_of_funds || '', { field: 'use_of_funds', type: 'textarea' });
    setField('detail-refurb-scope', deal.refurb_scope || '', { field: 'refurb_scope', type: 'textarea' });
    setField('detail-refurb-cost', String(deal.refurb_cost || ''), { field: 'refurb_cost', money: true, display: deal.refurb_cost ? '£' + formatNumber(deal.refurb_cost) : 'N/A' });
    setField('detail-deposit-source', deal.deposit_source || '', { field: 'deposit_source' });
    setField('detail-concurrent', deal.concurrent_transactions || '', { field: 'concurrent_transactions', type: 'textarea' });

    // ── Save Intake Changes button (internal users only) ──
    if (canEdit) {
      const overviewPanel = document.getElementById('dtab-overview');
      if (overviewPanel) {
        const existingSaveBtn = overviewPanel.querySelector('.intake-save-btn');
        if (!existingSaveBtn) {
          const saveDiv = document.createElement('div');
          saveDiv.style.cssText = 'padding:12px 16px;border-top:2px solid var(--primary);margin-top:16px;display:flex;justify-content:space-between;align-items:center;';
          saveDiv.innerHTML = '<span style="font-size:11px;color:#c9a84c;font-weight:600;">Fields highlighted in amber are editable by RM</span><button class="intake-save-btn" onclick="window.saveIntakeChanges && window.saveIntakeChanges()" style="padding:8px 20px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">Save Changes</button>';
          overviewPanel.appendChild(saveDiv);
        }
      }
      // Add save button to each other tab too
      ['dtab-borrower', 'dtab-property', 'dtab-use-of-funds'].forEach(tabId => {
        const tab = document.getElementById(tabId);
        if (tab && !tab.querySelector('.intake-save-btn')) {
          const saveDiv = document.createElement('div');
          saveDiv.style.cssText = 'padding:12px 16px;border-top:2px solid var(--primary);margin-top:16px;text-align:right;';
          saveDiv.innerHTML = '<button class="intake-save-btn" onclick="window.saveIntakeChanges && window.saveIntakeChanges()" style="padding:8px 20px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">Save Changes</button>';
          tab.appendChild(saveDiv);
        }
      });

      // Apply comma formatting to all money input fields
      setTimeout(() => {
        moneyInputIds.forEach(id => attachMoneyFormat(id));
      }, 50);
    }

    // ── TAB: Documents ──
    renderDocumentsList(deal.documents || []);

    // ── TAB: Deal Matrix ──
    renderDealMatrix(deal);

    // ── TAB: Analysis ──
    if (deal.status === 'completed' && deal.analysis_results) {
      const analysisEl = document.getElementById('analysis-content');
      if (analysisEl) {
        analysisEl.innerHTML = '';
        if (deal.analysis_results.credit_memo_url) {
          const link = document.createElement('a');
          link.href = sanitizeHtml(deal.analysis_results.credit_memo_url);
          link.target = '_blank';
          link.className = 'btn btn-primary';
          link.style.marginRight = '10px';
          link.textContent = 'Download Credit Memo';
          analysisEl.appendChild(link);
        }
        if (deal.analysis_results.termsheet_url) {
          const link = document.createElement('a');
          link.href = sanitizeHtml(deal.analysis_results.termsheet_url);
          link.target = '_blank';
          link.className = 'btn btn-primary';
          link.style.marginRight = '10px';
          link.textContent = 'Download Termsheet';
          analysisEl.appendChild(link);
        }
      }
    }

    // ── PHASE 2: Lock/Unlock ──
    // Phase 2 unlocks when onboarding fee is confirmed (not stage-based)
    const isPhase2Unlocked = !!deal.dip_fee_confirmed;
    const phase2LockEl = document.getElementById('phase2-lock');
    if (phase2LockEl) {
      phase2LockEl.textContent = isPhase2Unlocked ? '\u{1F513}' : '\u{1F512}';
    }

    document.querySelectorAll('.phase2-tab').forEach(tab => {
      if (isPhase2Unlocked) {
        tab.classList.remove('locked');
        tab.classList.add('unlocked');
      } else {
        tab.classList.add('locked');
        tab.classList.remove('unlocked');
      }
    });

    // Show/hide Phase 2 forms vs lock notices
    const phase2Tabs = ['kyc', 'financials-aml', 'valuation', 'use-of-funds', 'exit', 'other-conditions'];
    phase2Tabs.forEach(t => {
      const lockNotice = document.getElementById(`${t}-lock-notice`);
      const form = document.getElementById(`${t}-form`);
      if (lockNotice) {
        lockNotice.style.display = isPhase2Unlocked ? 'none' : 'block';
        if (!isPhase2Unlocked) {
          lockNotice.innerHTML = `<span class="lock-icon-large">&#128274;</span>
            <h3>${t.charAt(0).toUpperCase() + t.slice(1)} — Locked</h3>
            <p>This section unlocks after the onboarding fee is confirmed by the RM.</p>`;
        }
      }
      if (form) form.style.display = isPhase2Unlocked ? 'block' : 'none';
    });

    // Pre-fill Phase 2 forms from onboarding_data if it exists
    if (isPhase2Unlocked && deal.onboarding_data) {
      populateOnboardingData(deal.onboarding_data);
    }

    // Inject RM section approval controls and doc upload summaries into each Phase 2 tab
    if (isPhase2Unlocked) {
      injectOnboardingSectionControls(deal);
    }

    // ── WORKFLOW CONTROLS ──
    const workflowPanel = document.getElementById('workflow-controls');
    if (workflowPanel) {
      if (isInternal) {
        workflowPanel.style.display = 'block';
        renderInternalWorkflowControls(deal);
      } else if (['broker', 'borrower'].includes(currentRole)) {
        workflowPanel.style.display = 'block';
        renderExternalWorkflowControls(deal);
      } else {
        workflowPanel.style.display = 'none';
      }
    }

    // Reset to Overview tab
    const overviewTab = document.querySelector('.detail-tab[data-dtab="dtab-overview"]');
    if (overviewTab) switchDetailTab(overviewTab);

    showScreen('screen-deal-detail');
  } catch (err) {
    console.error('Error loading deal detail:', err);
    showToast('Failed to load deal details', true);
  }
}

/**
 * Render internal workflow controls (for admin, RM, credit, compliance)
 */
export function renderInternalWorkflowControls(deal) {
  const currentRole = getCurrentRole();
  const authToken = getAuthToken();
  const panel = document.getElementById('workflow-controls');
  if (!panel) return;

  const stage = deal.deal_stage || 'received';
  const stageLabels = {
    received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
    info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
    fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
    bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
    borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
    completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
  };

  // ── Accordion helper functions ──
  const accordion = (id, title, icon, defaultOpen = false) => {
    return `<div class="wf-section" style="background:#fff;border-radius:8px;margin-bottom:12px;border:1px solid #e5e7eb;overflow:hidden;">
    <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('.wf-chevron').textContent=this.nextElementSibling.style.display==='none'?'▸':'▾'"
         style="padding:12px 16px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:#f8fafc;border-bottom:1px solid #e5e7eb;user-select:none;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:14px;">${icon}</span>
        <h4 style="margin:0;font-size:14px;color:#1e293b;">${title}</h4>
      </div>
      <span class="wf-chevron" style="color:#94a3b8;font-size:14px;">${defaultOpen ? '▾' : '▸'}</span>
    </div>
    <div id="${id}" style="display:${defaultOpen ? 'block' : 'none'};padding:16px;">`;
  };
  const accordionEnd = () => `</div></div>`;


  // Map each stage to who is responsible for the next action
  const stageResponsibility = {
    received: { who: 'Admin', action: 'Assign to RM' },
    assigned: { who: 'RM', action: 'Issue DIP' },
    dip_issued: { who: 'Credit → Borrower', action: 'Credit Review then Borrower Accept' },
    info_gathering: { who: 'RM', action: 'Generate Indicative Termsheet' },
    ai_termsheet: { who: 'RM', action: 'Request Fee' },
    fee_pending: { who: 'RM / Broker', action: 'Confirm Fee Payment' },
    fee_paid: { who: 'RM', action: 'Start Underwriting' },
    underwriting: { who: 'RM', action: 'Submit to Bank' },
    bank_submitted: { who: 'Admin', action: 'Record Bank Decision' },
    bank_approved: { who: 'Borrower', action: 'Accept Terms' },
    borrower_accepted: { who: 'RM', action: 'Instruct Legal' },
    legal_instructed: { who: 'Admin', action: 'Complete Deal' },
    completed: { who: '-', action: 'Deal Complete' },
    declined: { who: '-', action: 'Deal Declined' },
    withdrawn: { who: '-', action: 'Deal Withdrawn' }
  };
  const responsibility = stageResponsibility[stage] || { who: '-', action: '-' };

  let html = `<h3 style="margin:0 0 4px;color:var(--primary);">Deal Workflow</h3>`;
  if (!['completed', 'declined', 'withdrawn'].includes(stage)) {
    html += `<div style="margin-bottom:16px;padding:8px 14px;background:#eef2ff;border-radius:6px;border-left:4px solid var(--primary);font-size:13px;">
      Next action: <strong>${sanitizeHtml(responsibility.action)}</strong> &mdash; Responsibility: <strong style="color:var(--primary);">${sanitizeHtml(responsibility.who)}</strong>
    </div>`;
  }

  // ── Role Guidance Banner ──
  if (currentRole === 'rm') {
    html += `<div style="margin-bottom:12px;padding:10px 14px;background:#dbeafe;border-radius:6px;border-left:4px solid #2563eb;font-size:12px;color:#1e40af;">
      <strong>RM View</strong> — You manage borrower data, property details, fees and DIP terms. Ensure all information is accurate before issuing the DIP to credit for review.
    </div>`;
  } else if (currentRole === 'credit') {
    html += `<div style="margin-bottom:12px;padding:10px 14px;background:#f5f3ff;border-radius:6px;border-left:4px solid #7c3aed;font-size:12px;color:#6b21a8;">
      <strong>Credit View</strong> — You review the deal for risk and creditworthiness. You can override rate, fees, LTV and retained interest. Borrower and property data is managed by the RM.
    </div>`;
  } else if (currentRole === 'compliance') {
    html += `<div style="margin-bottom:12px;padding:10px 14px;background:#fefce8;border-radius:6px;border-left:4px solid #ca8a04;font-size:12px;color:#854d0e;">
      <strong>Compliance View</strong> — You review the deal for regulatory compliance, AML and KYC. Borrower and property data is managed by the RM.
    </div>`;
  }

  // ── Stage Pipeline Visual (Grouped Phases) ──
  const stageOrder = ['received', 'assigned', 'dip_issued', 'info_gathering', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
  const currentIdx = stageOrder.indexOf(stage);
  const phases = [
    { label: 'Pre-DIP', stages: ['received', 'assigned', 'dip_issued'] },
    { label: 'Onboarding', stages: ['info_gathering', 'ai_termsheet'] },
    { label: 'Completion', stages: ['fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'] }
  ];

  html += `<div style="display:flex;gap:16px;margin-bottom:20px;">`;
  phases.forEach(phase => {
    const phaseActive = phase.stages.includes(stage);
    const phaseDone = phase.stages.every((s) => stageOrder.indexOf(s) < currentIdx);
    const phaseBg = phaseDone ? '#dcfce7' : phaseActive ? '#eff6ff' : '#f8fafc';
    const phaseBorder = phaseDone ? '#86efac' : phaseActive ? '#93c5fd' : '#e5e7eb';
    html += `<div style="flex:1;padding:10px;border-radius:8px;background:${phaseBg};border:1px solid ${phaseBorder};">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;color:#6b7280;margin-bottom:6px;">${phase.label}</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px;">`;
    phase.stages.forEach((s, i) => {
      const isActive = s === stage;
      const isDone = stageOrder.indexOf(s) < currentIdx;
      const bg = isActive ? '#c9a84c' : isDone ? '#48bb78' : '#e2e8f0';
      const color = (isActive || isDone) ? '#fff' : '#666';
      html += `<span style="padding:3px 8px;border-radius:10px;font-size:10px;background:${bg};color:${color};white-space:nowrap;">${stageLabels[s]}</span>`;
    });
    html += `</div></div>`;
  });
  html += `</div>`;

  // ── Assignment Section (Admin only) ──
  if (currentRole === 'admin') {
    const rmName = deal.rm_first ? `${sanitizeHtml(deal.rm_first)} ${sanitizeHtml(deal.rm_last)}` : null;
    const creditName = deal.credit_first ? `${sanitizeHtml(deal.credit_first)} ${sanitizeHtml(deal.credit_last)}` : null;
    const compName = deal.comp_first ? `${sanitizeHtml(deal.comp_first)} ${sanitizeHtml(deal.comp_last)}` : null;

    const assignedBadge = (name) => name
      ? `<span style="display:inline-block;padding:3px 10px;background:#dcfce7;color:#166534;border-radius:12px;font-size:12px;font-weight:600;border:1px solid #86efac;">${name}</span>`
      : `<span style="display:inline-block;padding:3px 10px;background:#fee2e2;color:#991b1b;border-radius:12px;font-size:12px;font-weight:600;border:1px solid #fca5a5;">Unassigned</span>`;

    html += accordion('wf-assignments', 'Assignments', '👥', false);
    html += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div>
          <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">Relationship Manager</label>
          <div style="display:flex;gap:8px;">
            <select id="assign-rm-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
              <option value="">-- Select RM --</option>
            </select>
            <button onclick="window.assignRM && window.assignRM()" style="padding:6px 12px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Assign</button>
          </div>
          <div style="margin-top:6px;">${assignedBadge(rmName)}</div>
        </div>
        <div>
          <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">Credit Analyst</label>
          <div style="display:flex;gap:8px;">
            <select id="assign-credit-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
              <option value="">-- Select --</option>
            </select>
            <button onclick="window.assignReviewer && window.assignReviewer('credit')" style="padding:6px 12px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Assign</button>
          </div>
          <div style="margin-top:6px;">${assignedBadge(creditName)}</div>
        </div>
        <div>
          <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">Compliance</label>
          <div style="display:flex;gap:8px;">
            <select id="assign-compliance-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
              <option value="">-- Select --</option>
            </select>
            <button onclick="window.assignReviewer && window.assignReviewer('compliance')" style="padding:6px 12px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Assign</button>
          </div>
          <div style="margin-top:6px;">${assignedBadge(compName)}</div>
        </div>
      </div>
    </div>`;
    html += accordionEnd();

    // Populate staff dropdowns
    setTimeout(async () => {
      try {
        const resp = await fetchWithAuth(`${API_BASE}/api/admin/staff`);
        const data = await resp.json();
        if (data.staff) {
          const rmSel = document.getElementById('assign-rm-select');
          const crSel = document.getElementById('assign-credit-select');
          const coSel = document.getElementById('assign-compliance-select');
          data.staff.forEach(s => {
            const opt = `<option value="${s.id}">${sanitizeHtml(s.first_name)} ${sanitizeHtml(s.last_name)} (${s.role.toUpperCase()})</option>`;
            if (['rm', 'admin'].includes(s.role) && rmSel) rmSel.innerHTML += opt;
            if (['credit', 'admin'].includes(s.role) && crSel) crSel.innerHTML += opt;
            if (['compliance', 'admin'].includes(s.role) && coSel) coSel.innerHTML += opt;
          });
        }
      } catch(e) { console.error('Failed to load staff:', e); }
    }, 100);
  }

  // ── Borrowers (verify before DIP) ──
  const borrowers = deal.borrowers || [];
  const canEditBorrowers = ['admin', 'rm'].includes(currentRole);
  html += accordion('wf-borrowers', `Borrowers (${borrowers.length})`, '👤', false);

  if (borrowers.length > 0) {
    html += `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:12px;">
      <tr style="border-bottom:1px solid #e2e8f0;"><th style="text-align:left;padding:6px;">Name</th><th style="text-align:left;padding:6px;">Role</th><th style="text-align:left;padding:6px;">Type</th><th style="text-align:left;padding:6px;">Email</th><th style="text-align:left;padding:6px;">KYC</th>${canEditBorrowers ? '<th style="padding:6px;"></th>' : ''}</tr>
      ${borrowers.map(b => `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:6px;">${sanitizeHtml(b.full_name)}</td>
        <td style="padding:6px;"><span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${b.role === 'primary' ? '#bee3f8' : '#fefcbf'};color:${b.role === 'primary' ? '#2a4365' : '#744210'}">${b.role}</span></td>
        <td style="padding:6px;">${sanitizeHtml(b.borrower_type)}${b.company_name ? ` (${sanitizeHtml(b.company_name)})` : ''}</td>
        <td style="padding:6px;">${sanitizeHtml(b.email || '-')}</td>
        <td style="padding:6px;"><span style="color:${b.kyc_status === 'verified' ? '#48bb78' : b.kyc_status === 'submitted' ? '#c9a84c' : '#e53e3e'}">${b.kyc_status}</span></td>
        ${canEditBorrowers ? `<td style="padding:6px;"><button onclick="window.removeBorrower && window.removeBorrower(${b.id})" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:12px;">×</button></td>` : ''}
      </tr>`).join('')}
    </table>`;
  }

  if (canEditBorrowers) {
    html += `<div style="border-top:1px solid #e2e8f0;padding-top:12px;">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Add Borrower</div>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div><label style="font-size:11px;color:#666;">Full Name *</label><input type="text" id="bw-name" placeholder="Full name" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
        <div><label style="font-size:11px;color:#666;">Role</label><select id="bw-role" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="primary">Primary</option><option value="joint">Joint & Several</option><option value="guarantor">Guarantor</option><option value="director">Director</option></select></div>
        <div><label style="font-size:11px;color:#666;">Type</label><select id="bw-type" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="individual">Individual</option><option value="corporate">Corporate</option><option value="spv">SPV</option></select></div>
        <div><label style="font-size:11px;color:#666;">Email</label><input type="email" id="bw-email" placeholder="Email" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
        <button onclick="window.addBorrower && window.addBorrower()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Add</button>
      </div>
    </div>`;
  }
  html += accordionEnd();

  // ── Properties / Portfolio (verify before DIP) ──
  const properties = deal.properties || [];
  const summary = deal.portfolio_summary || {};
  const canEditProperties = ['admin', 'rm'].includes(currentRole);
  html += accordion('wf-properties', `Properties / Portfolio (${properties.length})`, '🏠', false);

  if (properties.length > 0) {
    html += `<div style="display:flex;gap:16px;margin-bottom:12px;font-size:13px;">
      <span>Total Value: <strong>£${formatNumber(summary.total_market_value || 0)}</strong></span>
      <span>Total GDV: <strong>£${formatNumber(summary.total_gdv || 0)}</strong></span>
    </div>`;
    html += `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:12px;">
      <tr style="border-bottom:1px solid #e2e8f0;"><th style="text-align:left;padding:6px;">Address</th><th style="text-align:left;padding:6px;">Type</th><th style="text-align:left;padding:6px;">Value</th><th style="text-align:left;padding:6px;">GDV</th><th style="text-align:left;padding:6px;">Day 1 LTV</th><th style="text-align:left;padding:6px;">Tenure</th>${canEditProperties ? '<th style="padding:6px;"></th>' : ''}</tr>
      ${properties.map(p => `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:6px;">${sanitizeHtml(p.address)}${p.postcode ? `, ${sanitizeHtml(p.postcode)}` : ''}</td>
        <td style="padding:6px;">${sanitizeHtml(p.property_type || '-')}</td>
        <td style="padding:6px;">${p.market_value ? '£' + formatNumber(p.market_value) : '-'}</td>
        <td style="padding:6px;">${p.gdv ? '£' + formatNumber(p.gdv) : '-'}</td>
        <td style="padding:6px;">${p.day1_ltv ? formatPct(p.day1_ltv) + '%' : '-'}</td>
        <td style="padding:6px;">${sanitizeHtml(p.tenure || '-')}</td>
        ${canEditProperties ? `<td style="padding:6px;"><button onclick="window.removeProperty && window.removeProperty(${p.id})" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:12px;">×</button></td>` : ''}
      </tr>`).join('')}
    </table>`;
  }

  if (canEditProperties) {
    html += `<div style="border-top:1px solid #e2e8f0;padding-top:12px;">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Add Property</div>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div><label style="font-size:11px;color:#666;">Address *</label><input type="text" id="pp-address" placeholder="Full address" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
        <div><label style="font-size:11px;color:#666;">Type</label><select id="pp-type" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="residential">Residential</option><option value="commercial">Commercial</option><option value="mixed_use">Mixed Use</option><option value="land">Land</option></select></div>
        <div><label style="font-size:11px;color:#666;">Market Value (£)</label><input type="number" id="pp-value" placeholder="0" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
        <div><label style="font-size:11px;color:#666;">GDV (£)</label><input type="number" id="pp-gdv" placeholder="0" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
        <div><label style="font-size:11px;color:#666;">Tenure</label><select id="pp-tenure" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option></select></div>
        <button onclick="window.addProperty && window.addProperty()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Add</button>
      </div>
    </div>`;
  }
  html += accordionEnd();

  // ── Stage-Specific Actions ──

  // RECEIVED (Admin only)
  if (stage === 'received' && currentRole === 'admin') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Assign to RM</h4>
      <div style="display:flex;gap:8px;">
        <select id="action-rm-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
          <option value="">-- Select RM --</option>
        </select>
        <button onclick="window.assignRMAndAdvance && window.assignRMAndAdvance()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Assign & Advance</button>
      </div>
    </div>`;
    setTimeout(async () => {
      try {
        const resp = await fetchWithAuth(`${API_BASE}/api/admin/staff`);
        const data = await resp.json();
        if (data.staff) {
          const sel = document.getElementById('action-rm-select');
          if (sel) {
            data.staff.filter(s => ['rm', 'admin'].includes(s.role)).forEach(s => {
              sel.innerHTML += `<option value="${s.id}">${sanitizeHtml(s.first_name)} ${sanitizeHtml(s.last_name)}</option>`;
            });
          }
        }
      } catch(e) { console.error('Failed to load staff:', e); }
    }, 100);
  }

  // Credit Query Banner — show when credit sent deal back for more info
  if (stage === 'assigned' && ['rm', 'admin'].includes(currentRole)) {
    const tsData = deal.ai_termsheet_data || {};
    if (tsData.credit_query && !tsData.credit_query.resolved) {
      html += `<div style="background:#fef3c7;padding:20px;border-radius:8px;margin-bottom:16px;border:2px solid #f59e0b;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:24px;">⚠️</span>
          <h4 style="margin:0;color:#92400e;font-size:16px;">Credit Team Query — Action Required</h4>
        </div>
        <div style="background:#fff;padding:14px;border-radius:6px;border-left:4px solid #f59e0b;margin-bottom:14px;">
          <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#78350f;">"${sanitizeHtml(tsData.credit_query.question)}"</p>
          <p style="margin:0;font-size:11px;color:#92400e;">— Credit Team, ${tsData.credit_query.asked_at ? new Date(tsData.credit_query.asked_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
        </div>
        <label style="font-size:12px;color:#92400e;display:block;margin-bottom:6px;font-weight:600;">Your Response</label>
        <textarea id="rm-query-response" placeholder="Respond to credit's query here. This will be logged and visible to the credit team when you re-issue the DIP..." style="width:100%;padding:10px;border-radius:6px;border:2px solid #f59e0b;font-size:13px;min-height:100px;resize:vertical;"></textarea>
        <div style="display:flex;gap:10px;margin-top:12px;">
          <button onclick="window.respondToCreditQuery && window.respondToCreditQuery()" style="padding:10px 20px;background:#15803d;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">Submit Response & Continue to DIP</button>
        </div>
        ${tsData.credit_query_history && tsData.credit_query_history.length > 0 ? '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #fcd34d;"><h5 style="margin:0 0 8px;font-size:11px;color:#92400e;text-transform:uppercase;">Previous Queries</h5>' + tsData.credit_query_history.map(q => '<div style="background:#fff;padding:8px 12px;border-radius:4px;margin-bottom:6px;font-size:12px;"><strong style="color:#92400e;">Q:</strong> ' + sanitizeHtml(q.question) + '<br><strong style="color:#15803d;">A:</strong> ' + sanitizeHtml(q.response || 'No response') + '<br><span style="font-size:10px;color:#999;">' + (q.asked_at ? new Date(q.asked_at).toLocaleDateString('en-GB') : '') + '</span></div>').join('') + '</div>' : ''}
      </div>`;
    }
  }

  // ASSIGNED (RM or Admin) - Issue DIP
  if (stage === 'assigned' && ['rm', 'admin'].includes(currentRole)) {
    const dipLoan = deal.loan_amount || '';
    const dipLtv = deal.ltv_requested || '';
    const dipTerm = deal.term_months || '';
    const dipRate = deal.rate_requested || '0.95';
    const dipVal = deal.current_value || '';
    const dipPurchase = deal.purchase_price || '';
    const dipExit = sanitizeHtml(deal.exit_strategy || '');
    const dipPurpose = sanitizeHtml(deal.loan_purpose || '');
    const dipInterest = deal.interest_servicing || 'retained';

    // Parse multiple properties from address
    const fullAddr = sanitizeHtml(deal.security_address || '');
    const propList = fullAddr.includes(';') ? fullAddr.split(';').map(a => a.trim()).filter(Boolean) : [fullAddr];
    const postcodes = (deal.security_postcode || '').split(',').map(p => p.trim()).filter(Boolean);

    // Borrower type logic
    const bType = (deal.borrower_type || 'individual').toLowerCase();
    const isCorporate = bType === 'corporate' || bType === 'spv' || bType === 'ltd' || bType === 'llp';
    const borrowerTypeLabel = isCorporate ? 'Corporate Borrower' : 'Individual Borrower';
    const borrowerTypeBadge = isCorporate
      ? '<span style="padding:2px 8px;background:#dbeafe;color:#1e40af;border-radius:10px;font-size:11px;font-weight:600;">CORPORATE</span>'
      : '<span style="padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:10px;font-size:11px;font-weight:600;">INDIVIDUAL</span>';

    // CSS helper classes
    const brokerField = 'background:#f9fafb;border:1px solid #e5e7eb;color:#374151;cursor:not-allowed;';
    const rmField = 'background:#fff;border:2px solid var(--primary);';
    const rmLabel = '<span style="font-size:9px;background:#1e3a5f;color:#fff;padding:1px 5px;border-radius:3px;margin-left:4px;">RM TO CONFIRM</span>';

    // DF logo — use the actual logo image with SVG fallback
    const dfLogoHtml = `<div style="display:inline-flex;align-items:center;">
      <img src="/logo.PNG" alt="Daksfirst" style="height:44px;" id="dip-logo-img"
        onerror="this.style.display='none';document.getElementById('dip-logo-fallback').style.display='inline-block';">
      <svg id="dip-logo-fallback" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:40px;height:40px;display:none;">
        <path d="M50 3 L93 27 L93 73 L50 97 L7 73 L7 27 Z" fill="none" stroke="#1a365d" stroke-width="3.5"/>
        <path d="M30 35 L30 65 L42 65 Q55 65 55 50 Q55 35 42 35 Z M35 40 L41 40 Q49 40 49 50 Q49 60 41 60 L35 60 Z" fill="#1a365d"/>
        <path d="M53 35 L53 65 L58 65 L58 52 L68 52 L68 48 L58 48 L58 40 L70 40 L70 35 Z" fill="#1a365d"/>
      </svg>
    </div>`;

    html += accordion('wf-dip-form', 'DIP Form', '📋', true);
    html += `<div style="background:#f0f5ff;padding:20px;border-radius:8px;border:2px solid var(--primary);">

      <!-- ═══ DIP HEADER WITH LOGO ═══ -->
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px;padding-bottom:12px;border-bottom:2px solid var(--primary);">
        ${dfLogoHtml}
        <div style="flex:1;">
          <h4 style="margin:0;color:var(--primary);font-size:18px;">Decision In Principle (DIP)</h4>
          <div style="font-size:11px;color:#666;margin-top:2px;">Daksfirst Limited &mdash; FCA 937220 &mdash; 8 Hill Street, Mayfair, London W1J 5NG</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-align:right;">
          <span style="background:#e5e7eb;color:#6b7280;padding:3px 8px;border-radius:4px;">Grey = Borrower input</span>
          <span style="background:#1e3a5f;color:#fff;padding:3px 8px;border-radius:4px;">Blue border = RM to confirm</span>
        </div>
      </div>
      <p style="margin:0 0 16px;font-size:12px;color:#666;">Review the borrower-submitted data and confirm the loan terms. Fields with blue borders require your input/confirmation.</p>

      <!-- ═══ BORROWER DETAILS ═══ -->
      <div style="background:#f9fafb;padding:14px;border-radius:6px;margin-bottom:16px;border:1px solid #e5e7eb;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h5 style="margin:0;color:#374151;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Borrower &mdash; ${borrowerTypeLabel}</h5>
          ${borrowerTypeBadge}
        </div>
        ${isCorporate ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;margin-bottom:12px;">
          <div style="padding:10px;background:#eff6ff;border-radius:6px;border:1px solid #bfdbfe;">
            <span style="font-size:10px;color:#1e40af;display:block;font-weight:600;">Corporate Entity</span>
            <strong style="font-size:14px;">${sanitizeHtml(deal.borrower_company || deal.company_name || 'N/A')}</strong>
            ${deal.company_number ? '<div style="font-size:11px;color:#6b7280;margin-top:2px;">Co. No: ' + sanitizeHtml(deal.company_number) + '</div>' : ''}
          </div>
          <div style="padding:10px;background:#fef3c7;border-radius:6px;border:1px solid #fbbf24;">
            <span style="font-size:10px;color:#92400e;display:block;font-weight:600;">Ultimate Beneficial Owner (UBO)</span>
            <strong style="font-size:14px;">${sanitizeHtml(deal.borrower_name || 'N/A')}</strong>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">${sanitizeHtml(deal.borrower_email || '')} ${deal.borrower_phone ? '&middot; ' + sanitizeHtml(deal.borrower_phone) : ''}</div>
          </div>
        </div>
        ` : `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;margin-bottom:12px;">
          <div><span style="font-size:10px;color:#6b7280;display:block;">Name</span><strong>${sanitizeHtml(deal.borrower_name || 'N/A')}</strong></div>
          <div><span style="font-size:10px;color:#6b7280;display:block;">Email</span>${sanitizeHtml(deal.borrower_email || 'N/A')}</div>
          <div><span style="font-size:10px;color:#6b7280;display:block;">Phone</span>${sanitizeHtml(deal.borrower_phone || 'N/A')}</div>
        </div>
        `}

        <!-- All Borrowers / Guarantors on this deal -->
        ${borrowers.length > 0 ? `
        <div style="margin-top:8px;padding-top:10px;border-top:1px solid #e5e7eb;">
          <h5 style="margin:0 0 8px;color:#374151;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Parties to the DIP (${borrowers.length})</h5>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <tr style="background:#f3f4f6;">
              <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;">Name</th>
              <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;">Role</th>
              <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;">Type</th>
              <th style="text-align:center;padding:5px 8px;border-bottom:1px solid #e5e7eb;">KYC Status</th>
              <th style="text-align:center;padding:5px 8px;border-bottom:1px solid #e5e7eb;">DIP Status</th>
            </tr>
            ${borrowers.map(b => '<tr style="border-bottom:1px solid #f0f0f0;">' +
              '<td style="padding:5px 8px;font-weight:600;">' + sanitizeHtml(b.full_name || '') + '</td>' +
              '<td style="padding:5px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;background:' + (b.role === 'primary' ? '#bee3f8' : b.role === 'guarantor' ? '#fef3c7' : '#e5e7eb') + ';color:' + (b.role === 'primary' ? '#2a4365' : b.role === 'guarantor' ? '#744210' : '#374151') + ';">' + sanitizeHtml(b.role || 'primary') + '</span></td>' +
              '<td style="padding:5px 8px;">' + sanitizeHtml(b.borrower_type || 'individual') + (b.company_name ? ' (' + sanitizeHtml(b.company_name) + ')' : '') + '</td>' +
              '<td style="padding:5px 8px;text-align:center;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + (b.kyc_status === 'verified' ? '#dcfce7;color:#166534' : '#fef3c7;color:#92400e') + ';">' + (b.kyc_status === 'verified' ? 'Verified' : 'KYC Pending') + '</span></td>' +
              '<td style="padding:5px 8px;text-align:center;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + (b.kyc_status === 'verified' ? '#dcfce7;color:#166534">Included' : '#fef3c7;color:#92400e">Consent Pending') + '</span></td>' +
            '</tr>').join('')}
          </table>
        </div>
        ` : ''}

        <!-- Security & Guarantee Structure -->
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb;">
          <h5 style="margin:0 0 8px;color:#1e40af;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Security & Guarantee Structure ${rmLabel}</h5>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
            <div>
              <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Security Charge</label>
              <select id="dip-fixed-charge" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
                <option value="first_and_debenture" selected>First Charge + Debenture</option>
                <option value="first_charge">First Legal Charge only</option>
                <option value="debenture">Debenture only</option>
                <option value="second_charge">Second Charge</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Personal Guarantee</label>
              <select id="dip-pg-ubo" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
                <option value="required" selected>PG from UBO — Required</option>
                <option value="limited">Limited Guarantee</option>
                <option value="waived">Waived (state reason in notes)</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Additional Security</label>
              <input type="text" id="dip-additional-security" placeholder="e.g. Second charge on another asset" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#6b7280;">RM to add if applicable</span>
            </div>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">UBO / Guarantor Name(s)</label>
            <input type="text" id="dip-ubo-names" placeholder="Full legal name(s) of UBO / guarantor(s)" value="${sanitizeHtml(deal.borrower_name || '')}" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
            <span style="font-size:10px;color:#6b7280;">Must match title holder(s) on the property</span>
          </div>
        </div>
      </div>

      <!-- ═══ PROPERTY SCHEDULE (RM approves each property) ═══ -->
      <div style="background:#fff;padding:14px;border-radius:6px;margin-bottom:16px;border:1px solid #e5e7eb;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h5 id="dip-schedule-header" style="margin:0;color:#374151;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Security Schedule &mdash; ${propList.length} ${propList.length === 1 ? 'Property' : 'Properties'}</h5>
          ${propList.length > 1 ? `<button onclick="window.approveAllDipProperties && window.approveAllDipProperties()" style="padding:5px 14px;background:#15803d;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">Approve All</button>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;" id="dip-property-table">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">#</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">Address</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">Postcode</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;">Valuation (£)</th>
              <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;">Status</th>
              <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #e5e7eb;width:160px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${propList.map((addr, i) => `<tr id="dip-prop-${i}">
              <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-weight:600;">${i + 1}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;">${sanitizeHtml(addr)}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;">${sanitizeHtml(postcodes[i] || postcodes[0] || '-')}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;">
                <input type="text" id="dip-prop-val-${i}" class="dip-prop-valuation" value="0" placeholder="0" style="width:100%;padding:6px;border-radius:4px;border:2px solid var(--primary);font-size:12px;max-width:120px;">
              </td>
              <td id="dip-prop-status-${i}" style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;"><span style="padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:10px;font-size:10px;">Pending</span></td>
              <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;">
                <button id="dip-prop-approve-${i}" onclick="window.approveDipProperty && window.approveDipProperty(${i})" style="background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;margin-right:4px;">Approve</button>
                <button id="dip-prop-remove-${i}" onclick="window.removeDipProperty && window.removeDipProperty(${i})" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;">Remove</button>
              </td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr style="background:#f0f5ff;font-weight:600;">
              <td colspan="3" style="padding:8px;text-align:right;font-size:12px;">Total Valuation:</td>
              <td style="padding:8px;font-size:13px;color:var(--primary);" id="dip-prop-val-total">£0</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
        <div id="dip-removed-props" style="margin-top:6px;font-size:11px;color:#991b1b;display:none;"></div>
        <div style="margin-top:8px;font-size:12px;color:#6b7280;">Asset Type: <strong>${sanitizeHtml(deal.asset_type || 'N/A')}</strong></div>
      </div>

      <!-- ═══ VALUATION SUMMARY (auto-summed from per-property inputs) ═══ -->
      <div style="background:#f9fafb;padding:14px;border-radius:6px;margin-bottom:16px;border:1px solid #e5e7eb;">
        <h5 style="margin:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Valuation Summary</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:4px;">Total Property Value (£) <span style="font-size:9px;background:#dcfce7;color:#166534;padding:1px 5px;border-radius:3px;">Auto-summed</span></label>
            <input type="text" id="dip-property-value" value="${dipVal}" style="width:100%;padding:8px;border-radius:4px;background:#f0fff4;border:1px solid #86efac;font-size:13px;font-weight:600;" readonly>
          </div>
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:4px;">Purchase Price (£)</label>
            <input type="text" id="dip-purchase-price" value="${dipPurchase}" style="width:100%;padding:8px;border-radius:4px;${brokerField};font-size:13px;" readonly>
          </div>
          <div>
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:4px;">Number of Properties</label>
            <input type="text" id="dip-num-properties" value="${propList.length}" style="width:100%;padding:8px;border-radius:4px;${brokerField};font-size:13px;" readonly>
          </div>
        </div>
        <p style="margin:8px 0 0;font-size:10px;color:#6b7280;">Total property value is auto-calculated from individual property valuations entered above. Enter each property's valuation in the Security Schedule.</p>
      </div>

      <!-- ═══ LOAN TERMS (RM CONFIRMS) ═══ -->
      <div style="background:#fff;padding:14px;border-radius:6px;margin-bottom:16px;border:2px solid var(--primary);">
        <h5 style="margin:0 0 10px;color:var(--primary);font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Loan Terms ${rmLabel}</h5>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Loan Amount (£) *</label>
            <input type="text" id="dip-loan-amount" value="${dipLoan}" placeholder="Confirm loan amount" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Term (months) *</label>
            <input type="number" id="dip-term" value="${dipTerm}" placeholder="e.g. 12" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Rate (%/month) *</label>
            <input type="number" step="0.01" id="dip-rate" value="${dipRate}" placeholder="Min 0.85" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
            <span style="font-size:10px;color:#92400e;">Min 0.85%</span>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Interest Servicing *</label>
            <select id="dip-interest" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <option value="retained" ${dipInterest === 'retained' ? 'selected' : ''}>Retained</option>
              <option value="serviced" ${dipInterest === 'serviced' ? 'selected' : ''}>Serviced</option>
              <option value="rolled_up" ${dipInterest === 'rolled_up' ? 'selected' : ''}>Rolled Up</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">Arrangement Fee (%)</label>
            <input type="number" step="0.01" id="dip-arrangement-fee" value="2.00" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:4px;">LTV (%)</label>
            <input type="number" step="0.01" id="dip-ltv" value="${dipLtv}" style="width:100%;padding:8px;border-radius:4px;background:#f0fff4;border:1px solid #86efac;font-size:13px;" readonly>
            <span style="font-size:10px;color:#15803d;">Auto-calculated &middot; Max 75%</span>
          </div>
        </div>

        <!-- ═══ RETAINED INTEREST & CLIENT COSTS ═══ -->
        <div style="background:#fff8f0;padding:12px;border-radius:6px;margin-bottom:12px;border:1px solid #f59e0b;">
          <h5 style="margin:0 0 10px;color:#92400e;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Day Zero Calculation ${rmLabel}</h5>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Retained Interest (months)</label>
              <input type="number" id="dip-retained-months" value="6" min="0" max="36" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#92400e;">Default: 6 months</span>
            </div>
            <div>
              <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Broker Fee (%)</label>
              <input type="number" step="0.01" id="dip-broker-fee" value="0" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#b45309;font-weight:600;">Paid from Arrangement Fee (not additional)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ FEE SCHEDULE (RM sets all fees — disclosed to borrower in DIP) ═══ -->
      <div style="background:#fff;padding:14px;border-radius:6px;margin-bottom:16px;border:2px solid #7c3aed;">
        <h5 style="margin:0 0 4px;color:#7c3aed;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Fee Schedule ${rmLabel}</h5>
        <p style="margin:0 0 12px;font-size:11px;color:#666;">All fees disclosed to borrower. No fee required before DIP issuance. Amounts set by RM.</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f5f3ff;">
              <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #7c3aed;">Fee Type</th>
              <th style="text-align:right;padding:6px 8px;border-bottom:2px solid #7c3aed;">Amount (£)</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #7c3aed;">When Due</th>
              <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #7c3aed;">Payment Trigger</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px;font-weight:600;">Onboarding / DIP Fee</td>
              <td style="padding:8px;text-align:right;"><input type="text" id="dip-fee-onboarding" value="0" style="width:90px;padding:4px 6px;border-radius:4px;${rmField};font-size:12px;text-align:right;"></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">After DIP acceptance</td>
              <td style="padding:8px;font-size:11px;">Before Credit Review</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px;font-weight:600;">Commitment Fee</td>
              <td style="padding:8px;text-align:right;"><input type="text" id="dip-fee-commitment" value="0" style="width:90px;padding:4px 6px;border-radius:4px;${rmField};font-size:12px;text-align:right;"></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">After Termsheet acceptance</td>
              <td style="padding:8px;font-size:11px;">Before Underwriting</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;background:#fefce8;">
              <td style="padding:8px;font-weight:600;">Arrangement Fee<br><span style="font-size:10px;color:#6b7280;font-weight:400;">(includes broker fee below)</span></td>
              <td style="padding:8px;text-align:right;"><span style="font-size:12px;font-weight:600;" id="dip-fee-arr-display">£0</span><br><span style="font-size:10px;color:#6b7280;">Auto from % above</span></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">On completion</td>
              <td style="padding:8px;font-size:11px;">Deducted from advance</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;background:#fefce8;">
              <td style="padding:8px;font-weight:400;padding-left:24px;color:#92400e;">↳ of which Broker Fee</td>
              <td style="padding:8px;text-align:right;"><span style="font-size:12px;color:#92400e;" id="dip-fee-broker-display">£0</span><br><span style="font-size:10px;color:#6b7280;">Paid from arrangement</span></td>
              <td style="padding:8px;font-size:11px;color:#92400e;">On completion</td>
              <td style="padding:8px;font-size:11px;color:#92400e;">From arrangement fee</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px;font-weight:600;">Valuation Fee</td>
              <td style="padding:8px;text-align:right;"><input type="text" id="dip-valuation-cost" value="0" style="width:90px;padding:4px 6px;border-radius:4px;${rmField};font-size:12px;text-align:right;"></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">Upfront</td>
              <td style="padding:8px;font-size:11px;">Direct payment by client</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px;font-weight:600;">Legal Fee</td>
              <td style="padding:8px;text-align:right;"><input type="text" id="dip-legal-cost" value="0" style="width:90px;padding:4px 6px;border-radius:4px;${rmField};font-size:12px;text-align:right;"></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">On completion</td>
              <td style="padding:8px;font-size:11px;">Deducted from advance</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ═══ PURPOSE & EXIT (broker-sourced) ═══ -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div>
          <label style="font-size:11px;color:#666;display:block;margin-bottom:4px;">Loan Purpose</label>
          <textarea id="dip-purpose" style="width:100%;padding:8px;border-radius:4px;${brokerField};font-size:13px;min-height:60px;" readonly>${dipPurpose}</textarea>
        </div>
        <div>
          <label style="font-size:11px;color:#666;display:block;margin-bottom:4px;">Exit Strategy</label>
          <textarea id="dip-exit" style="width:100%;padding:8px;border-radius:4px;${brokerField};font-size:13px;min-height:60px;" readonly>${dipExit}</textarea>
        </div>
      </div>

      <!-- ═══ RM CONDITIONS ═══ -->
      <div style="margin-bottom:16px;">
        <label style="font-size:11px;color:#1e3a5f;display:block;margin-bottom:4px;font-weight:600;">DIP Conditions / RM Notes ${rmLabel}</label>
        <textarea id="dip-notes" placeholder="Special conditions, valuation requirements, additional info needed..." style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;min-height:80px;"></textarea>
      </div>

      <!-- ═══ LIVE SUMMARY ═══ -->
      <div style="background:#fffdf5;padding:14px;border-radius:6px;border:1px solid #fbbf24;margin-bottom:16px;">
        <strong style="font-size:12px;color:#92400e;">DIP Financial Summary (live):</strong>
        <div id="dip-summary" style="font-size:13px;margin-top:8px;color:#333;"></div>
      </div>

      <!-- ═══ PRE-ISSUE CHECKLIST ═══ -->
      <div style="background:#fff;padding:14px;border-radius:6px;margin-bottom:16px;border:2px solid #1e3a5f;">
        <h5 style="margin:0 0 10px;color:#1e3a5f;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Pre-Issue Checklist</h5>
        <p style="margin:0 0 10px;font-size:11px;color:#666;">All items must be satisfied before the DIP can be issued.</p>
        <div id="dip-checklist" style="font-size:12px;line-height:2;"></div>
      </div>

      <div style="display:flex;gap:12px;align-items:center;">
        <button id="btn-issue-dip" onclick="window.issueDip && window.issueDip()" disabled style="padding:10px 24px;background:#9ca3af;color:white;border:none;border-radius:4px;cursor:not-allowed;font-weight:600;font-size:14px;transition:all 0.2s;">Issue DIP to ${deal.broker_id || deal.broker_name ? 'Broker' : 'Borrower'}</button>
        <button onclick="window.declineDeal && window.declineDeal()" style="padding:10px 24px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">Decline Deal</button>
        <span id="dip-checklist-count" style="font-size:11px;color:#9ca3af;margin-left:8px;"></span>
      </div>

      <!-- ═══ DISCLAIMER ═══ -->
      <div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb;">
        <p style="margin:0;font-size:10px;color:#6b7280;line-height:1.5;">
          <strong>Disclaimer:</strong> This Decision In Principle (DIP) is issued by Daksfirst Limited and is indicative only. It does not constitute a formal offer of finance and is subject to satisfactory due diligence, valuation, legal review, and final credit approval. All terms stated herein are subject to change. Daksfirst Limited reserves the right to withdraw or amend this DIP at any time prior to the issuance of a formal facility letter. The borrower should not rely on this DIP as a guarantee of funding. Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA No. 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.
        </p>
      </div>
    </div>`;
    html += accordionEnd();

    // Auto-calculate DIP summary after render + attach money formatting
    setTimeout(() => {
      // Attach comma formatting to money fields
      ['dip-loan-amount', 'dip-purchase-price', 'dip-valuation-cost', 'dip-legal-cost', 'dip-fee-onboarding', 'dip-fee-commitment'].forEach(id => {
        attachMoneyFormat(id);
      });

      // Attach comma formatting to per-property valuation inputs + auto-sum
      const propValInputs = document.querySelectorAll('.dip-prop-valuation');
      const updatePropValTotal = () => {
        let total = 0;
        propValInputs.forEach(inp => {
          // Skip removed/disabled property valuations
          if (!inp.disabled) total += parseFormattedNumber(inp.value);
        });
        const totalEl = document.getElementById('dip-prop-val-total');
        if (totalEl) totalEl.textContent = '£' + formatNumber(total);
        // Update the dip-property-value readonly field with the sum
        const pvEl = document.getElementById('dip-property-value');
        if (pvEl) {
          pvEl.value = formatNumber(total);
          pvEl.setAttribute('data-raw', total);
        }
        // Trigger LTV recalculation
        if (window.calcDipLtv) window.calcDipLtv();
      };
      propValInputs.forEach(inp => {
        attachMoneyFormat(inp.id);
        inp.addEventListener('input', updatePropValTotal);
        inp.addEventListener('change', updatePropValTotal);
      });

      // ── DIP Pre-Issue Checklist Validator ──
      const validateDipChecklist = () => {
        const checks = [];
        const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
        const money = (id) => parseFormattedNumber(val(id));

        // 1. Loan Amount
        const loanAmt = money('dip-loan-amount');
        checks.push({ label: 'Loan amount entered', ok: loanAmt > 0 });

        // 2. Loan within limits (£500k–£15m)
        checks.push({ label: 'Loan within £500k – £15m range', ok: loanAmt >= 500000 && loanAmt <= 15000000 });

        // 3. At least one active property valuation entered
        let totalPropVal = 0;
        document.querySelectorAll('.dip-prop-valuation').forEach(inp => { if (!inp.disabled) totalPropVal += parseFormattedNumber(inp.value); });
        checks.push({ label: 'Property valuation(s) entered', ok: totalPropVal > 0 });

        // 4. All properties approved or removed
        let allPropsHandled = true;
        const propRows = document.querySelectorAll('#dip-property-table tbody tr');
        propRows.forEach((row, i) => {
          const valInput = document.getElementById('dip-prop-val-' + i);
          const isRemoved = valInput && valInput.disabled;
          if (!isRemoved) { // only check active properties
            const statusEl = document.getElementById('dip-prop-status-' + i);
            if (statusEl && !statusEl.innerHTML.includes('Approved')) allPropsHandled = false;
          }
        });
        checks.push({ label: 'All properties approved or removed', ok: allPropsHandled });

        // 5. LTV within limit
        const ltv = parseFloat(val('dip-ltv')) || 0;
        checks.push({ label: 'LTV ≤ 75%', ok: ltv > 0 && ltv <= 75 });

        // 6. Term entered
        const term = parseInt(val('dip-term')) || 0;
        checks.push({ label: 'Term entered (3–24 months)', ok: term >= 3 && term <= 24 });

        // 7. Rate entered and meets minimum
        const rate = parseFloat(val('dip-rate')) || 0;
        checks.push({ label: 'Rate ≥ 0.85%/month', ok: rate >= 0.85 });

        // 8. Interest servicing selected
        checks.push({ label: 'Interest servicing selected', ok: !!val('dip-interest') });

        // 9. Arrangement fee entered
        const arrFee = parseFloat(val('dip-arrangement-fee')) || 0;
        checks.push({ label: 'Arrangement fee set', ok: arrFee > 0 });

        // 10. Retained interest months set (if retained)
        const interestType = val('dip-interest');
        if (interestType === 'retained') {
          const retMo = parseInt(val('dip-retained-months')) || 0;
          checks.push({ label: 'Retained interest months set', ok: retMo > 0 });
        }

        // 11. Corporate borrower: PG and fixed charge set
        const pgEl = document.getElementById('dip-pg-ubo');
        if (pgEl) {
          checks.push({ label: 'Personal Guarantee from UBO selected', ok: !!pgEl.value });
          const fcEl = document.getElementById('dip-fixed-charge');
          checks.push({ label: 'Fixed Charge type selected', ok: !!fcEl?.value });
          const uboEl = document.getElementById('dip-ubo-names');
          checks.push({ label: 'UBO / Guarantor names entered', ok: !!(uboEl?.value?.trim()) });
        }

        // 12. Onboarding fee amount set
        const onboardingFee = money('dip-fee-onboarding');
        checks.push({ label: 'Onboarding / DIP fee amount set', ok: onboardingFee > 0 });

        // 13. Exit strategy provided
        checks.push({ label: 'Exit strategy provided', ok: !!val('dip-exit') });

        // 14. Loan purpose provided
        checks.push({ label: 'Loan purpose provided', ok: !!val('dip-purpose') });

        // Render checklist
        const checklistEl = document.getElementById('dip-checklist');
        const allPassed = checks.every(c => c.ok);
        const passCount = checks.filter(c => c.ok).length;

        if (checklistEl) {
          checklistEl.innerHTML = checks.map(c =>
            '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">' +
              '<span style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;' +
              (c.ok ? 'background:#dcfce7;color:#166534;">' + '✓' : 'background:#fee2e2;color:#991b1b;">' + '✗') +
              '</span>' +
              '<span style="color:' + (c.ok ? '#166534' : '#991b1b') + ';font-weight:' + (c.ok ? '400' : '600') + ';">' + c.label + '</span>' +
            '</div>'
          ).join('');
        }

        // Update counter
        const countEl = document.getElementById('dip-checklist-count');
        if (countEl) countEl.textContent = passCount + '/' + checks.length + ' complete';

        // Enable/disable Issue button
        const btn = document.getElementById('btn-issue-dip');
        if (btn) {
          if (allPassed) {
            btn.disabled = false;
            btn.style.background = 'var(--primary)';
            btn.style.cursor = 'pointer';
          } else {
            btn.disabled = true;
            btn.style.background = '#9ca3af';
            btn.style.cursor = 'not-allowed';
          }
        }
      };

      // Wire up checklist validation to all relevant fields
      window.validateDipChecklist = validateDipChecklist;

      if (window.calcDipLtv) {
        window.calcDipLtv();
        ['dip-loan-amount', 'dip-property-value', 'dip-term', 'dip-rate', 'dip-arrangement-fee', 'dip-interest', 'dip-retained-months', 'dip-valuation-cost', 'dip-legal-cost', 'dip-broker-fee'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.addEventListener('input', window.calcDipLtv);
          if (el) el.addEventListener('change', window.calcDipLtv);
        });
      }

      // Attach checklist validation to all DIP form fields
      ['dip-loan-amount', 'dip-property-value', 'dip-term', 'dip-rate', 'dip-arrangement-fee', 'dip-interest', 'dip-retained-months', 'dip-valuation-cost', 'dip-legal-cost', 'dip-broker-fee', 'dip-exit', 'dip-purpose', 'dip-pg-ubo', 'dip-fixed-charge', 'dip-ubo-names', 'dip-notes', 'dip-fee-onboarding', 'dip-fee-commitment'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('input', validateDipChecklist);
          el.addEventListener('change', validateDipChecklist);
        }
      });
      document.querySelectorAll('.dip-prop-valuation').forEach(inp => {
        inp.addEventListener('input', validateDipChecklist);
        inp.addEventListener('change', validateDipChecklist);
      });

      // Restore DIP form state if saved (e.g. after add/remove borrower)
      if (hasDipFormState()) {
        restoreDipFormState();
        // Re-trigger calculations with restored values
        if (window.calcDipLtv) window.calcDipLtv();
        updatePropValTotal();
      }

      // Run initial checklist validation
      validateDipChecklist();
    }, 100);
  }

  // DIP_ISSUED — Acceptance status banner for all internal users
  const isInternal = ['admin', 'rm', 'credit', 'compliance'].includes(currentRole);
  if (stage === 'dip_issued' && isInternal) {
    const dipAccepted = deal.dip_signed;
    const creditApproved = deal.credit_recommendation === 'approve';
    let dsBannerBg, dsBorderCol, dsIcon, dsLabel;
    if (dipAccepted) {
      dsBannerBg = '#f0fff4'; dsBorderCol = '#48bb78'; dsIcon = '✅'; dsLabel = 'DIP Accepted by Borrower';
    } else if (creditApproved) {
      dsBannerBg = '#eff6ff'; dsBorderCol = '#3b82f6'; dsIcon = '✅'; dsLabel = 'Credit Approved — Awaiting Borrower Acceptance';
    } else {
      dsBannerBg = '#fffbeb'; dsBorderCol = '#f59e0b'; dsIcon = '⏳'; dsLabel = 'DIP Issued — Awaiting Credit Review';
    }

    html += '<div style="background:' + dsBannerBg + ';padding:12px 16px;border-radius:8px;margin-bottom:12px;border-left:4px solid ' + dsBorderCol + ';display:flex;align-items:center;justify-content:space-between;">' +
      '<div><span style="font-size:16px;margin-right:8px;">' + dsIcon + '</span><strong style="font-size:13px;">' + dsLabel + '</strong>' +
      (deal.dip_signed_at ? '<span style="font-size:10px;color:#999;margin-left:10px;">Accepted: ' + new Date(deal.dip_signed_at).toLocaleDateString('en-GB') + '</span>' : '') +
      '</div><div style="display:flex;gap:8px;">' +
      '<button onclick="viewDipPdf(\'' + sanitizeHtml(deal.submission_id) + '\')" style="padding:4px 12px;background:#1a365d;color:white;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">View DIP</button>' +
      '</div></div>';
  }

  // DIP_ISSUED (Credit or Admin) - Credit Review & In-Principle Approval
  // Only show if credit has NOT yet decided (pending/moreinfo = show, approve/decline = don't show)
  const creditAlreadyDecided = ['approve', 'decline'].includes(deal.credit_recommendation);
  if (stage === 'dip_issued' && ['credit', 'admin'].includes(currentRole) && !creditAlreadyDecided) {
    const dipData = deal.ai_termsheet_data || {};
    html += accordion('wf-credit-review', 'Credit Review', '👁️', true);
    html += `<div style="background:#fff;padding:16px;border-radius:8px;border:2px solid #7c3aed;">
      <h4 style="margin:0 0 4px;color:#7c3aed;">Credit Review — In-Principle Decision</h4>
      <p style="margin:0 0 16px;font-size:12px;color:#666;">Review the DIP terms submitted by the RM and provide your in-principle decision.</p>

      <div style="background:#f5f3ff;padding:12px;border-radius:6px;margin-bottom:16px;">
        <h5 style="margin:0 0 8px;font-size:12px;color:#7c3aed;text-transform:uppercase;">DIP Terms — RM Proposed</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;">
          <div>Loan: <strong>£${formatNumber(dipData.loan_amount || deal.loan_amount || 0)}</strong></div>
          <div>LTV: <strong>${formatPct(dipData.ltv || deal.ltv_requested || 0)}%</strong> ${dipData.credit_override_ltv ? '<span style="color:#7c3aed;font-size:11px;">(Credit: ' + formatPct(dipData.credit_override_ltv) + '%)</span>' : ''}</div>
          <div>Term: <strong>${dipData.term_months || deal.term_months || 'N/A'} months</strong></div>
          <div>Rate: <strong>${formatPct(dipData.rate_monthly || deal.rate_requested || 0)}%/m</strong> ${dipData.credit_override_rate ? '<span style="color:#7c3aed;font-size:11px;">(Credit: ' + formatPct(dipData.credit_override_rate) + '%/m)</span>' : ''}</div>
          <div>Interest: <strong>${sanitizeHtml(dipData.interest_servicing || deal.interest_servicing || 'N/A')}</strong></div>
          <div>Arr. Fee: <strong>${formatPct(dipData.arrangement_fee_pct || 2)}%</strong> ${dipData.credit_override_arr_fee ? '<span style="color:#7c3aed;font-size:11px;">(Credit: ' + formatPct(dipData.credit_override_arr_fee) + '%)</span>' : ''}</div>
        </div>
        ${dipData.retained_months ? `<div style="margin-top:4px;">Retained Interest: <strong>${dipData.retained_months} months</strong></div>` : ''}
        ${dipData.removed_properties && dipData.removed_properties.length > 0 ? '<div style="margin-top:8px;font-size:12px;color:#991b1b;">Properties removed by RM: ' + dipData.removed_properties.map(p => sanitizeHtml(p.address.substring(0, 40))).join('; ') + '</div>' : ''}
        ${dipData.conditions ? '<div style="margin-top:8px;font-size:12px;"><strong>RM Conditions:</strong> ' + sanitizeHtml(dipData.conditions) + '</div>' : ''}
      </div>

      <!-- Credit Overrides — rate, fees, LTV, retained interest -->
      <div style="background:#fff8f0;padding:14px;border-radius:6px;margin-bottom:16px;border:1px solid #f59e0b;">
        <h5 style="margin:0 0 10px;color:#92400e;font-size:11px;text-transform:uppercase;">Credit Overrides — Adjust Terms If Required</h5>
        <p style="margin:0 0 12px;font-size:11px;color:#92400e;">Only change values if you disagree with the RM's proposed terms. Leave unchanged to accept as-is.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;">
          <div>
            <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Rate (%/month)</label>
            <input type="number" id="credit-override-rate" value="${dipData.credit_override_rate || dipData.rate_monthly || deal.rate_requested || 0.95}" min="0" max="5" step="0.05" style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Max LTV (%)</label>
            <input type="number" id="credit-override-ltv" value="${dipData.credit_override_ltv || dipData.ltv || deal.ltv_requested || 70}" min="0" max="80" step="1" style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Arrangement Fee (%)</label>
            <input type="number" id="credit-override-arr-fee" value="${dipData.credit_override_arr_fee || dipData.arrangement_fee_pct || dipData.arrangement_fee || 2}" min="0" max="10" step="0.25" style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Retained Months</label>
            <input type="number" id="credit-retained-months" value="${dipData.retained_months || 6}" min="0" max="36" style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;">
          </div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-size:11px;color:#7c3aed;display:block;margin-bottom:4px;font-weight:600;">Credit Assessment Notes *</label>
        <textarea id="credit-notes" placeholder="Your credit assessment, risk observations, conditions..." style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;min-height:100px;"></textarea>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-size:11px;color:#7c3aed;display:block;margin-bottom:4px;font-weight:600;">Conditions of Approval (if approving)</label>
        <textarea id="credit-conditions" placeholder="e.g. Subject to satisfactory valuation, clear title search..." style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;"></textarea>
      </div>

      <div style="display:flex;gap:12px;">
        <button onclick="window.creditDecision && window.creditDecision('approve')" style="padding:10px 24px;background:#15803d;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">Approve In-Principle</button>
        <button onclick="window.creditDecision && window.creditDecision('decline')" style="padding:10px 24px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">Decline</button>
        <button id="btn-moreinfo" onclick="document.getElementById('moreinfo-modal').style.display='flex'" style="padding:10px 24px;background:#c9a84c;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">More Info Needed</button>
      </div>

      <!-- ═══ MORE INFO MODAL ═══ -->
      <div id="moreinfo-modal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:12px;padding:28px;max-width:560px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#92400e;font-size:18px;">Request More Information</h3>
            <button onclick="document.getElementById('moreinfo-modal').style.display='none'" style="background:none;border:none;font-size:22px;cursor:pointer;color:#999;">&times;</button>
          </div>
          <p style="margin:0 0 12px;font-size:13px;color:#666;">Describe what additional information you need from the RM. This will be sent back to them as a query and the deal will return to their queue.</p>
          <textarea id="moreinfo-question" placeholder="e.g. Please clarify the exit strategy timeline. What is the expected completion date for the refinance?&#10;&#10;Also need confirmation on the company structure and UBO details..." style="width:100%;padding:12px;border-radius:6px;border:2px solid #f59e0b;font-size:13px;min-height:140px;resize:vertical;"></textarea>
          <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">
            <button onclick="document.getElementById('moreinfo-modal').style.display='none'" style="padding:10px 20px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>
            <button onclick="window.submitMoreInfo && window.submitMoreInfo()" style="padding:10px 20px;background:#c9a84c;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Send Query to RM</button>
          </div>
        </div>
      </div>
    </div>`;
    html += accordionEnd();
  }

  // DIP_ISSUED — Credit has already decided: show read-only summary
  if (stage === 'dip_issued' && ['credit', 'admin'].includes(currentRole) && creditAlreadyDecided) {
    const dipData = deal.ai_termsheet_data || {};
    const cd = dipData.credit_decision || {};
    const decColor = deal.credit_recommendation === 'approve' ? '#15803d' : '#e53e3e';
    const decLabel = deal.credit_recommendation === 'approve' ? 'APPROVED' : 'DECLINED';
    html += accordion('wf-credit-decision', 'Credit Decision (read-only)', '📋', false);
    html += `<div style="background:#fff;padding:16px;border-radius:8px;border:2px solid ${decColor};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h4 style="margin:0;color:${decColor};">Credit Decision: ${decLabel}</h4>
        <span style="font-size:11px;color:#6b7280;">${cd.decided_at ? new Date(cd.decided_at).toLocaleDateString('en-GB') + ' ' + new Date(cd.decided_at).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}) : ''}</span>
      </div>
      ${cd.notes ? '<div style="font-size:13px;margin-bottom:8px;"><strong>Assessment:</strong> ' + sanitizeHtml(cd.notes) + '</div>' : ''}
      ${cd.conditions ? '<div style="font-size:13px;margin-bottom:8px;"><strong>Conditions:</strong> ' + sanitizeHtml(cd.conditions) + '</div>' : ''}
      <div style="display:flex;gap:16px;font-size:12px;color:#6b7280;flex-wrap:wrap;">
        ${dipData.credit_override_rate ? '<span>Rate override: <strong style="color:#7c3aed;">' + formatPct(dipData.credit_override_rate) + '%/m</strong></span>' : ''}
        ${dipData.credit_override_ltv ? '<span>LTV override: <strong style="color:#7c3aed;">' + formatPct(dipData.credit_override_ltv) + '%</strong></span>' : ''}
        ${dipData.credit_override_arr_fee ? '<span>Arr. Fee override: <strong style="color:#7c3aed;">' + formatPct(dipData.credit_override_arr_fee) + '%</strong></span>' : ''}
        ${dipData.retained_months ? '<span>Retained: <strong>' + dipData.retained_months + ' months</strong></span>' : ''}
      </div>
      <p style="margin:12px 0 0;font-size:11px;color:#9ca3af;">Awaiting borrower acceptance. Credit decision is final — no further action required.</p>
    </div>`;
    html += accordionEnd();
  }

  // INFO_GATHERING — Onboarding Fee Gate + Section Approval Summary + AI Termsheet generation
  if (stage === 'info_gathering' && isInternal) {
    const dipFeeConfirmed = !!deal.dip_fee_confirmed;
    const obApproval = deal.onboarding_approval || {};
    const allSections = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    const approvedCount = allSections.filter(s => obApproval[s] && obApproval[s].approved).length;
    const allApproved = approvedCount === allSections.length;
    const rmSignedOff = !!deal.rm_signoff_at;
    const creditSignedOff = !!deal.credit_signoff_at;
    const aiData = deal.ai_termsheet_data || {};
    const creditSignoffDecision = aiData.credit_signoff ? aiData.credit_signoff.decision : null;

    html += accordion('wf-info-gathering', 'Info Gathering Steps', '✓', true);

    // Step 1: Onboarding Fee
    html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid ${dipFeeConfirmed ? '#22c55e' : '#f59e0b'};">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h4 style="margin:0;color:${dipFeeConfirmed ? '#15803d' : '#92400e'};">Step 1: Onboarding Fee</h4>
          <p style="margin:4px 0 0;font-size:12px;color:#666;">${dipFeeConfirmed ? 'Fee confirmed — full onboarding is unlocked.' : 'The onboarding fee must be confirmed before the borrower/broker can complete full onboarding.'}</p>
        </div>`;
    if (!dipFeeConfirmed && ['rm', 'admin'].includes(currentRole)) {
      html += `<button onclick="window.confirmOnboardingFee()" style="padding:8px 16px;background:#f59e0b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Confirm Fee Received</button>`;
    } else if (dipFeeConfirmed) {
      html += `<span style="font-size:20px;">&#10003;</span>`;
    }
    html += `</div></div>`;

    // Step 2: Onboarding Section Approval Summary
    if (dipFeeConfirmed) {
      const sectionLabels = { kyc: 'KYC', financials_aml: 'Financials / AML', valuation: 'Valuation', use_of_funds: 'Use of Funds', exit_evidence: 'Exit Evidence', other_conditions: 'Other Conditions' };
      html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid ${allApproved ? '#22c55e' : '#3b82f6'};">
        <h4 style="margin:0 0 12px;color:${allApproved ? '#15803d' : '#1e40af'};">Step 2: Onboarding Sections (${approvedCount}/${allSections.length} approved)</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;">`;
      allSections.forEach(s => {
        const isOK = obApproval[s] && obApproval[s].approved;
        html += `<div style="padding:6px 10px;border-radius:6px;font-size:12px;font-weight:600;text-align:center;
          background:${isOK ? '#dcfce7' : '#fef3c7'};color:${isOK ? '#15803d' : '#92400e'};">
          ${isOK ? '&#10003;' : '&#9711;'} ${sectionLabels[s] || s}</div>`;
      });
      html += `</div>
        <p style="margin:10px 0 0;font-size:11px;color:#9ca3af;">Review and approve each section in the Full Onboarding tabs above. All 6 must be approved before analysis can proceed.</p>
      </div>`;

      // Step 3: Generate AI Termsheet (only when all sections approved)
      if (allApproved && !deal.ai_termsheet_generated_at) {
        html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid var(--primary);">
          <h4 style="margin:0 0 8px;color:var(--primary);">Step 3: Generate Indicative Termsheet</h4>
          <p style="margin:0 0 12px;font-size:12px;color:#666;">All onboarding sections are approved. Submit the deal for analysis. All uploaded documents and data will be reviewed to generate a draft termsheet with proposed terms.</p>
          <textarea id="ai-termsheet-data" placeholder="Additional notes for analysis (optional)" style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;margin-bottom:8px;"></textarea>
          <button onclick="window.generateAiTermsheet && window.generateAiTermsheet()" style="padding:10px 20px;background:var(--primary);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Generate Indicative Termsheet</button>
        </div>`;
      }

      // Step 4: RM Sign-off on AI Termsheet (only if all sections approved AND AI generated)
      if (allApproved && deal.ai_termsheet_generated_at && !rmSignedOff) {
        if (['rm', 'admin'].includes(currentRole)) {
          html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #3b82f6;">
            <h4 style="margin:0 0 8px;color:#1e40af;">Step 4: RM Sign-off</h4>
            <p style="margin:0 0 12px;font-size:12px;color:#666;">Analysis complete. Review the proposed terms and sign off to send to Credit for final approval.</p>
            <textarea id="rm-signoff-notes" placeholder="RM comments / adjustments (optional)" style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;margin-bottom:8px;"></textarea>
            <button onclick="window.rmSignoff()" style="padding:10px 20px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">RM Sign-off — Send to Credit</button>
          </div>`;
        } else {
          html += `<div style="background:#fef3c7;padding:12px 16px;border-radius:8px;margin-bottom:16px;border-left:4px solid #f59e0b;">
            <strong>Awaiting RM Sign-off</strong> — The RM needs to review and sign off on the indicative termsheet before Credit can review.
          </div>`;
        }
      }

      // Step 4 done indicator
      if (allApproved && rmSignedOff) {
        html += `<div style="background:#dcfce7;padding:12px 16px;border-radius:8px;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">&#10003;</span>
          <div><strong style="color:#15803d;">RM Signed Off</strong>
          <span style="font-size:11px;color:#666;"> — ${new Date(deal.rm_signoff_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</span></div>
        </div>`;
      }

      // Step 5: Credit Sign-off (only if all prior steps complete)
      if (allApproved && deal.ai_termsheet_generated_at && rmSignedOff && !creditSignedOff) {
        if (['credit', 'admin'].includes(currentRole)) {
          html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #7c3aed;">
            <h4 style="margin:0 0 8px;color:#7c3aed;">Step 5: Credit Sign-off</h4>
            <p style="margin:0 0 12px;font-size:12px;color:#666;">RM has signed off. Review the indicative termsheet and the full onboarding pack. Approve, decline, or request more info.</p>
            <textarea id="credit-signoff-notes" placeholder="Credit comments / conditions (optional)" style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;margin-bottom:8px;"></textarea>
            <div style="display:flex;gap:8px;">
              <button onclick="window.creditSignoff('approve')" style="padding:8px 16px;background:#22c55e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Approve</button>
              <button onclick="window.creditSignoff('moreinfo')" style="padding:8px 16px;background:#f59e0b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">More Info</button>
              <button onclick="window.creditSignoff('decline')" style="padding:8px 16px;background:#ef4444;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Decline</button>
            </div>
          </div>`;
        } else {
          html += `<div style="background:#f5f3ff;padding:12px 16px;border-radius:8px;margin-bottom:16px;border-left:4px solid #7c3aed;">
            <strong>Awaiting Credit Sign-off</strong> — RM has signed off. Credit team is reviewing.
          </div>`;
        }
      }

      // Step 5 done indicator
      if (allApproved && creditSignedOff) {
        const csDecColor = creditSignoffDecision === 'approve' ? '#15803d' : creditSignoffDecision === 'decline' ? '#ef4444' : '#f59e0b';
        const csDecLabel = creditSignoffDecision === 'approve' ? 'APPROVED' : creditSignoffDecision === 'decline' ? 'DECLINED' : 'MORE INFO REQUESTED';
        html += `<div style="background:${creditSignoffDecision === 'approve' ? '#dcfce7' : creditSignoffDecision === 'decline' ? '#fee2e2' : '#fef3c7'};padding:12px 16px;border-radius:8px;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;color:${csDecColor};">${creditSignoffDecision === 'approve' ? '&#10003;' : creditSignoffDecision === 'decline' ? '&#10007;' : '&#9888;'}</span>
          <div><strong style="color:${csDecColor};">Credit ${csDecLabel}</strong>
          <span style="font-size:11px;color:#666;"> — ${new Date(deal.credit_signoff_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</span></div>
        </div>`;
      }
    }
    html += accordionEnd();
  }

  // AI_TERMSHEET — Show AI analysis summary
  if (stage === 'ai_termsheet' && ['rm', 'credit', 'admin'].includes(currentRole)) {
    const aiGenAt = deal.ai_termsheet_generated_at;
    const aiData = deal.ai_termsheet_data || {};
    html += accordion('wf-ai-termsheet', 'Indicative Termsheet', '📋', true);
    html += `<div style="background:#f0fdf4;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #22c55e;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:22px;">🤖</span>
        <div>
          <h4 style="margin:0;color:#15803d;">Indicative Termsheet Generated</h4>
          ${aiGenAt ? `<div style="font-size:12px;color:#666;">Generated on ${new Date(aiGenAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}</div>` : ''}
        </div>
      </div>
      <p style="margin:0 0 8px;font-size:13px;color:#555;">All onboarding documents have been analysed and a draft termsheet has been generated. The RM and Credit team signed off on the analysis. Next step: issue the formal termsheet document.</p>
      ${deal.rm_signoff_at ? `<div style="font-size:12px;color:#15803d;margin-bottom:4px;">✓ RM signed off ${new Date(deal.rm_signoff_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div>` : ''}
      ${deal.credit_signoff_at ? `<div style="font-size:12px;color:#15803d;">✓ Credit signed off ${new Date(deal.credit_signoff_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div>` : ''}
    </div>`;
  }

  // AI_TERMSHEET — Issue Termsheet DOCX + Download
  if (stage === 'ai_termsheet' && ['rm', 'credit', 'admin'].includes(currentRole)) {
    const tsIssuedAt = deal.ts_issued_at;
    const tsDocUrl = deal.ts_pdf_url;
    html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid var(--primary);">
      <h4 style="margin:0 0 12px;color:var(--primary);">Termsheet Document</h4>`;

    if (tsIssuedAt) {
      // Already issued — show download link
      html += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <span style="font-size:20px;">✅</span>
        <div>
          <div style="font-weight:600;color:#15803d;">Termsheet Issued</div>
          <div style="font-size:12px;color:#666;">Issued on ${new Date(tsIssuedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
        </div>
      </div>`;
      if (tsDocUrl) {
        html += `<a href="${sanitizeHtml(tsDocUrl)}" target="_blank" style="display:inline-block;padding:8px 16px;background:#047857;color:white;border-radius:4px;text-decoration:none;font-weight:600;font-size:13px;margin-right:8px;">Download Termsheet DOCX</a>`;
      }
      html += `<button onclick="window.issueTermsheet && window.issueTermsheet()" style="padding:8px 16px;background:#f59e0b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">Re-generate Termsheet</button>`;
    } else {
      // Not yet issued — show generate button
      html += `<p style="margin:0 0 12px;font-size:13px;color:#666;">Generate the formal termsheet document (DOCX). This will be uploaded to OneDrive and sent via DocuSign to the borrower for signing.</p>
        <button onclick="window.issueTermsheet && window.issueTermsheet()" style="padding:10px 20px;background:var(--primary);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px;">Issue Termsheet DOCX</button>`;
    }
    html += `</div>`;
  }

  // AI_TERMSHEET (RM or Admin) - Request Fee
  if (stage === 'ai_termsheet' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Request Fee</h4>
      <div style="display:flex;gap:8px;align-items:end;">
        <div style="flex:1;">
          <label style="font-size:11px;color:#666;display:block;margin-bottom:4px;">Fee Amount (£)</label>
          <input type="number" id="fee-amount-action" placeholder="0.00" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <button onclick="window.requestFee && window.requestFee()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Request Fee</button>
      </div>
    </div>`;
    html += accordionEnd();
  }

  // FEE_PENDING (RM or Admin) - Confirm Fee
  if (stage === 'fee_pending' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Confirm Fee Payment</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div>
          <label style="font-size:11px;color:#666;">Fee Type</label>
          <select id="fee-type-action" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
            <option value="dip_fee">DIP Fee</option>
            <option value="commitment_fee">Commitment Fee</option>
            <option value="arrangement_fee">Arrangement Fee</option>
            <option value="valuation_fee">Valuation Fee</option>
            <option value="legal_fee">Legal Fee</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Amount (£)</label>
          <input type="number" id="fee-amount-action2" placeholder="0.00" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Payment Date</label>
          <input type="date" id="fee-date-action" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <button onclick="window.confirmFeeAndAdvance && window.confirmFeeAndAdvance()" style="padding:8px 16px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Confirm</button>
      </div>
    </div>`;
  }

  // FEE_PAID (RM or Admin) - Start Underwriting
  if (stage === 'fee_paid' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Next Stage</h4>
      <button onclick="window.advanceStageSimple && window.advanceStageSimple('underwriting')" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Start Underwriting</button>
    </div>`;
  }

  // UNDERWRITING (RM or Admin) - Submit to Bank
  if (stage === 'underwriting' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Submit to GB Bank</h4>
      <div style="display:flex;gap:8px;">
        <input type="text" id="bank-ref" placeholder="Bank reference" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        <button onclick="window.submitToBank && window.submitToBank()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Submit</button>
      </div>
    </div>`;
  }

  // BANK_SUBMITTED (Admin) - Record Bank Approval
  if (stage === 'bank_submitted' && currentRole === 'admin') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Bank Decision</h4>
      <textarea id="bank-approval-notes" placeholder="Bank approval notes (optional)" style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;margin-bottom:8px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button onclick="window.recordBankApproval && window.recordBankApproval()" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Bank Approved</button>
        <button onclick="window.declineDeal && window.declineDeal()" style="padding:8px 16px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Bank Declined</button>
      </div>
    </div>`;
  }

  // BANK_APPROVED (RM or Admin) - Record Borrower Acceptance
  if (stage === 'bank_approved' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Awaiting Borrower Acceptance</h4>
      <p style="font-size:13px;color:#666;margin-bottom:12px;">Awaiting borrower to accept terms or record acceptance if received offline.</p>
      <button onclick="window.recordBorrowerAcceptance && window.recordBorrowerAcceptance()" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Record Borrower Acceptance</button>
    </div>`;
  }

  // BORROWER_ACCEPTED (RM or Admin) - Instruct Legal
  if (stage === 'borrower_accepted' && ['rm', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Instruct Legal</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div>
          <label style="font-size:11px;color:#666;">Firm Name *</label>
          <input type="text" id="lawyer-firm" placeholder="Law firm name" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Lawyer Email *</label>
          <input type="email" id="lawyer-email" placeholder="Email" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Contact Name</label>
          <input type="text" id="lawyer-contact" placeholder="Contact name" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <button onclick="window.instructLegal && window.instructLegal()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Instruct</button>
      </div>
      <p style="font-size:11px;color:#999;margin-top:8px;">Optionally: <a href="#" onclick="window.loadLawFirms && window.loadLawFirms(); return false;" style="color:var(--primary);">Select from onboarded firms</a></p>
      <div id="law-firms-dropdown" style="display:none;margin-top:8px;padding:8px;background:white;border:1px solid #ddd;border-radius:4px;max-height:200px;overflow-y:auto;">
        <!-- Populated by loadLawFirms() -->
      </div>
    </div>`;
  }

  // LEGAL_INSTRUCTED (Admin) - Complete Deal
  if (stage === 'legal_instructed' && currentRole === 'admin') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Complete Deal</h4>
      <button onclick="window.completeDeal && window.completeDeal()" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Mark as Completed</button>
    </div>`;
  }

  // Withdraw — only for admin/RM (lender withdraws offer) or broker/borrower (applicant withdraws application)
  // Credit team uses Decline, not Withdraw. Final stages excluded.
  if (!['completed', 'declined', 'withdrawn'].includes(stage) && ['admin', 'rm', 'broker', 'borrower'].includes(currentRole)) {
    const withdrawLabel = ['broker', 'borrower'].includes(currentRole) ? 'Withdraw Application' : 'Withdraw Deal';
    html += accordion('wf-withdraw', withdrawLabel, '🚫', false);
    html += `<div style="display:flex;gap:8px;">
        <button onclick="window.withdrawDeal && window.withdrawDeal()" style="padding:8px 16px;background:#f59e0b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">${withdrawLabel}</button>
      </div>`;
    html += accordionEnd();
  }

  // ── Fee Tracker (visible to internal users at all stages from dip_issued onwards) ──
  const feeStages = ['dip_issued','info_gathering','ai_termsheet','fee_pending','fee_paid','underwriting','bank_submitted','bank_approved','borrower_accepted','legal_instructed','completed'];
  const canEditFees = ['admin', 'rm'].includes(currentRole);
  if (isInternal && feeStages.includes(stage)) {
    const fd = deal.ai_termsheet_data || {};
    const loanAmt = parseFloat(fd.loan_amount || deal.loan_amount || 0);
    const arrPct = parseFloat(fd.arrangement_fee || 0);
    const brkPct = parseFloat(fd.broker_fee || 0);
    const arrAmt = arrPct > 0 && arrPct < 50 ? Math.round(loanAmt * arrPct / 100) : arrPct;
    const brkAmt = brkPct > 0 && brkPct < 50 ? Math.round(loanAmt * brkPct / 100) : brkPct;
    // Fees locked at dip_issued (already in borrower's DIP document) — editable again after info_gathering
    const dipFeesLocked = stage === 'dip_issued';
    const feesEditable = canEditFees && !dipFeesLocked;
    const feeInputStyle = feesEditable
      ? 'width:90px;padding:4px;border-radius:4px;border:1px solid #ddd;font-size:12px;text-align:right;'
      : 'width:90px;padding:4px;border-radius:4px;border:1px solid #e5e7eb;font-size:12px;text-align:right;background:#f9fafb;color:#374151;cursor:not-allowed;';
    const feeReadonly = feesEditable ? '' : 'readonly';

    html += accordion('wf-fee-tracker', 'Fee Tracker', '💷', true);
    html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #7c3aed;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h4 style="margin:0;color:#7c3aed;font-size:14px;">Fee Tracker ${dipFeesLocked ? '<span style="font-size:10px;color:#f59e0b;font-weight:400;margin-left:8px;">Locked — DIP issued to borrower with these terms</span>' : !canEditFees ? '<span style="font-size:10px;color:#6b7280;font-weight:400;margin-left:8px;">Read-only — RM manages fees</span>' : ''}</h4>
        ${feesEditable ? '<button onclick="window.updateFees && window.updateFees()" style="padding:6px 14px;background:#7c3aed;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">Save Fee Changes</button>' : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f5f3ff;">
            <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #7c3aed;">Fee</th>
            <th style="text-align:right;padding:6px 8px;border-bottom:2px solid #7c3aed;">Amount (£)</th>
            <th style="text-align:center;padding:6px 8px;border-bottom:2px solid #7c3aed;">Status</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #7c3aed;">When Due</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;">Onboarding Fee</td>
            <td style="padding:8px;text-align:right;"><input type="text" id="ft-onboarding" value="${fd.fee_onboarding || 0}" style="${feeInputStyle}" ${feeReadonly}></td>
            <td style="padding:8px;text-align:center;">${deal.fee_paid_onboarding ? '<span style="color:#15803d;font-weight:600;">Paid</span>' : '<span style="color:#f59e0b;">Pending</span>'}</td>
            <td style="padding:8px;font-size:11px;">After DIP acceptance</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;">Commitment Fee</td>
            <td style="padding:8px;text-align:right;"><input type="text" id="ft-commitment" value="${fd.fee_commitment || 0}" style="${feeInputStyle}" ${feeReadonly}></td>
            <td style="padding:8px;text-align:center;">${deal.fee_paid_commitment ? '<span style="color:#15803d;font-weight:600;">Paid</span>' : '<span style="color:#f59e0b;">Pending</span>'}</td>
            <td style="padding:8px;font-size:11px;">After Termsheet acceptance</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;background:#fefce8;">
            <td style="padding:8px;font-weight:600;">Arrangement Fee (${arrPct > 0 && arrPct < 50 ? arrPct.toFixed(2) + '%' : ''})</td>
            <td style="padding:8px;text-align:right;font-weight:600;">£${formatNumber(arrAmt)}</td>
            <td style="padding:8px;text-align:center;"><span style="color:#6b7280;">On completion</span></td>
            <td style="padding:8px;font-size:11px;">Deducted from advance</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;background:#fefce8;">
            <td style="padding:8px;padding-left:24px;color:#92400e;">↳ of which Broker (${brkPct > 0 && brkPct < 50 ? brkPct.toFixed(2) + '%' : ''})</td>
            <td style="padding:8px;text-align:right;color:#92400e;">£${formatNumber(brkAmt)}</td>
            <td style="padding:8px;text-align:center;"><span style="color:#6b7280;">On completion</span></td>
            <td style="padding:8px;font-size:11px;color:#92400e;">From arrangement fee</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;">Valuation Fee</td>
            <td style="padding:8px;text-align:right;"><input type="text" id="ft-valuation" value="${fd.valuation_cost || 0}" style="${feeInputStyle}" ${feeReadonly}></td>
            <td style="padding:8px;text-align:center;">${deal.fee_paid_valuation ? '<span style="color:#15803d;font-weight:600;">Paid</span>' : '<span style="color:#f59e0b;">Pending</span>'}</td>
            <td style="padding:8px;font-size:11px;">Upfront</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;">Legal Fee</td>
            <td style="padding:8px;text-align:right;"><input type="text" id="ft-legal" value="${fd.legal_cost || 0}" style="${feeInputStyle}" ${feeReadonly}></td>
            <td style="padding:8px;text-align:center;">${deal.fee_paid_legal ? '<span style="color:#15803d;font-weight:600;">Paid</span>' : '<span style="color:#f59e0b;">Pending</span>'}</td>
            <td style="padding:8px;font-size:11px;">On completion</td>
          </tr>
        </tbody>
      </table>
    </div>`;
    html += accordionEnd();
  }

  // ── Terms Comparison Tracker ──
  // Shows side-by-side DIP → Indicative Termsheet → Final terms
  if (['admin', 'rm', 'credit', 'compliance'].includes(currentRole)) {
    html += accordion('wf-terms-tracker', 'Terms Tracker', '📊', false);
    html += `<div id="terms-tracker-content" style="background:#fff;padding:16px;border-radius:8px;margin-bottom:8px;border:1px solid #e5e7eb;">
      <div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px;">Loading terms tracker...</div>
    </div>`;
    html += accordionEnd();
  }

  // ── Recommendation Status & Actions ──
  // At dip_issued: Credit Review panel above handles the decision — only show read-only status summary
  // At later stages: show full recommendation panel with buttons for compliance/admin
  const rmStatus = deal.dip_issued_at ? 'DIP Issued' : (deal.rm_recommendation || 'Pending');
  const creditStatus = deal.credit_recommendation || 'Pending';
  const complianceStatus = deal.compliance_recommendation || 'Pending';

  if (['credit', 'compliance', 'admin'].includes(currentRole)) {
    // Always show the status summary
    html += accordion('wf-decision-status', 'Decision Status', '✔️', true);
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Decision Status</h4>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px;">
        <span style="font-size:13px;">RM: <strong style="color:${rmStatus === 'DIP Issued' ? '#2563eb' : '#666'}">${sanitizeHtml(rmStatus)}</strong></span>
        <span style="font-size:13px;">Credit: <strong style="color:${creditStatus === 'approve' ? '#15803d' : creditStatus === 'decline' ? '#e53e3e' : creditStatus === 'moreinfo' ? '#c9a84c' : '#666'}">${sanitizeHtml(creditStatus === 'approve' ? 'Approved' : creditStatus === 'decline' ? 'Declined' : creditStatus === 'moreinfo' ? 'More Info Requested' : creditStatus)}</strong></span>
        <span style="font-size:13px;">Compliance: <strong style="color:${complianceStatus === 'approve' ? '#15803d' : complianceStatus === 'decline' ? '#e53e3e' : '#666'}">${sanitizeHtml(complianceStatus === 'approve' ? 'Approved' : complianceStatus === 'decline' ? 'Declined' : complianceStatus)}</strong></span>
        <span style="font-size:13px;">Final: <strong style="color:${deal.final_decision === 'approve' ? '#15803d' : deal.final_decision === 'decline' ? '#e53e3e' : '#666'}">${deal.final_decision ? sanitizeHtml(deal.final_decision.toUpperCase()) : 'Pending'}</strong></span>
      </div>`;

    // Only show action buttons at stages AFTER dip_issued (e.g. underwriting, bank review) or if this role hasn't decided yet
    const showRecButtons = (stage !== 'dip_issued') || (currentRole === 'compliance' && !deal.compliance_recommendation);
    if (showRecButtons) {
      html += `<div style="display:flex;gap:8px;align-items:end;">
        <textarea id="rec-comments" placeholder="Comments / rationale..." style="flex:1;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;"></textarea>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button onclick="window.submitRecommendation && window.submitRecommendation('approve')" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Approve</button>
          <button onclick="window.submitRecommendation && window.submitRecommendation('more_info')" style="padding:8px 16px;background:#c9a84c;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">More Info</button>
          <button onclick="window.submitRecommendation && window.submitRecommendation('decline')" style="padding:8px 16px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Decline</button>
        </div>
      </div>`;
    } else {
      html += `<p style="margin:0;font-size:11px;color:#9ca3af;">No further action required at this stage.</p>`;
    }
    html += accordionEnd();
  }

  // ── Audit Trail (enriched with stage transitions, elapsed time) ──
  if (deal.audit && deal.audit.length > 0) {
    const auditStageLabels = {
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };

    // Group consecutive identical actions
    const groupedAudit = [];
    deal.audit.forEach((a, idx) => {
      const prev = groupedAudit[groupedAudit.length - 1];
      if (prev && prev.action === a.action && prev.to_value === a.to_value && prev.first_name === a.first_name) {
        prev.count = (prev.count || 1) + 1;
        prev.last_at = a.created_at;
      } else {
        groupedAudit.push({ ...a, count: 1, last_at: a.created_at });
      }
    });

    let auditHtml = '';
    groupedAudit.forEach((a, idx) => {
      let details = {};
      try { details = a.details ? (typeof a.details === 'string' ? JSON.parse(a.details) : a.details) : {}; } catch(e) { details = {}; }
      const isStageChange = a.action === 'stage_change' || (a.from_value && a.to_value && auditStageLabels[a.to_value]);
      const fromLabel = auditStageLabels[a.from_value] || a.from_value || '';
      const toLabel = auditStageLabels[a.to_value] || a.to_value || '';

      let elapsedStr = '';
      if (idx > 0) {
        const prevTime = new Date(deal.audit[idx - 1].created_at).getTime();
        const thisTime = new Date(a.created_at).getTime();
        const diffMs = thisTime - prevTime;
        if (diffMs > 0) {
          const diffMins = Math.floor(diffMs / 60000);
          const diffHrs = Math.floor(diffMins / 60);
          const diffDays = Math.floor(diffHrs / 24);
          if (diffDays > 0) elapsedStr = diffDays + 'd ' + (diffHrs % 24) + 'h later';
          else if (diffHrs > 0) elapsedStr = diffHrs + 'h ' + (diffMins % 60) + 'm later';
          else elapsedStr = diffMins + 'm later';
        }
      }

      const dotColor = isStageChange ? '#3b82f6' : a.action.includes('decline') || a.action.includes('remove') ? '#e53e3e' : a.action.includes('approve') || a.action.includes('confirm') ? '#15803d' : '#c9a84c';
      const roleBg = a.role === 'admin' ? '#fee2e2' : a.role === 'rm' ? '#dbeafe' : a.role === 'credit' ? '#f5f3ff' : a.role === 'compliance' ? '#fef3c7' : '#f3f4f6';
      const roleColor = a.role === 'admin' ? '#991b1b' : a.role === 'rm' ? '#1e40af' : a.role === 'credit' ? '#6b21a8' : a.role === 'compliance' ? '#92400e' : '#374151';

      let transitionHtml = '';
      if (a.from_value && a.to_value) {
        transitionHtml = '<span style="color:#666;"> ' + sanitizeHtml(fromLabel) + ' <span style="color:#3b82f6;font-weight:600;">&rarr;</span> ' + sanitizeHtml(toLabel) + '</span>';
      } else if (a.to_value) {
        transitionHtml = '<span style="color:#666;">&rarr; ' + sanitizeHtml(toLabel) + '</span>';
      }

      const connectorLine = idx < deal.audit.length - 1 ? '<div style="width:1px;flex:1;background:#e5e7eb;min-height:20px;"></div>' : '';
      const stageBadge = isStageChange ? '<span style="display:inline-block;padding:2px 8px;background:#eff6ff;color:#1e40af;border-radius:4px;font-size:11px;font-weight:600;margin-bottom:4px;">STAGE CHANGE</span> ' : '';
      const elapsedBadge = elapsedStr ? '<span style="font-size:10px;color:#9ca3af;background:#f3f4f6;padding:2px 6px;border-radius:3px;white-space:nowrap;">' + elapsedStr + '</span>' : '';
      const commentHtml = details.comments ? '<div style="color:#666;margin-top:4px;padding:6px 8px;background:#f9fafb;border-radius:4px;border-left:3px solid #e5e7eb;font-size:12px;">' + sanitizeHtml(details.comments) + '</div>' : '';

      auditHtml += '<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;">'
        + '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0;">'
        + '<div style="width:10px;height:10px;border-radius:50%;background:' + dotColor + ';margin-top:4px;' + (isStageChange ? 'box-shadow:0 0 0 3px ' + dotColor + '33;' : '') + '"></div>'
        + connectorLine
        + '</div>'
        + '<div style="flex:1;">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;">'
        + '<div>' + stageBadge + '<strong>' + sanitizeHtml(a.action.replace(/_/g, ' ')) + '</strong>' + (a.count > 1 ? ' <span style="display:inline-block;padding:1px 6px;background:#f3f4f6;border-radius:3px;font-size:11px;color:#666;margin-left:4px;">×' + a.count + '</span>' : '') + ' ' + transitionHtml + '</div>'
        + elapsedBadge
        + '</div>'
        + commentHtml
        + '<div style="color:#999;margin-top:4px;font-size:12px;">'
        + '<strong>' + sanitizeHtml(a.first_name) + ' ' + sanitizeHtml(a.last_name) + '</strong>'
        + ' <span style="padding:1px 6px;background:' + roleBg + ';color:' + roleColor + ';border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">' + sanitizeHtml(a.role.toUpperCase()) + '</span>'
        + ' &middot; <strong>' + formatDateTime(a.created_at) + '</strong>'
        + '</div></div></div>';
    });

    html += accordion('wf-audit-trail', 'Audit Trail', '📜', false);
    html += '<div style="max-height:400px;overflow-y:auto;">' + auditHtml + '</div>';
    html += accordionEnd();
  }

  panel.innerHTML = html;

  // ── Load Terms Tracker data (async) ──
  if (['admin', 'rm', 'credit', 'compliance'].includes(currentRole)) {
    loadTermsTracker(deal.submission_id);
  }

  // ── Load field locks for inline edit indicators ──
  loadFieldLocks(deal.submission_id);
}

/**
 * Fetch and render the Terms Comparison Tracker
 */
async function loadTermsTracker(submissionId) {
  const container = document.getElementById('terms-tracker-content');
  if (!container) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/terms-tracker`);
    if (!resp.ok) {
      container.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:13px;">Terms tracker not available yet.</div>';
      return;
    }
    const data = await resp.json();
    const { stages, rows, variances, locks } = data;

    // Determine which columns to show
    const hasDip = stages.dip?.exists;
    const hasTs = stages.termsheet?.exists;
    const hasFinal = stages.final?.exists;

    if (!hasDip && !hasTs && !hasFinal) {
      container.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:13px;">No snapshots captured yet. Terms tracking begins when the DIP is signed.</div>';
      return;
    }

    const fmtVal = (val, format) => {
      if (val === null || val === undefined || val === '') return '<span style="color:#cbd5e1;">—</span>';
      if (format === 'currency') return '£' + Number(val).toLocaleString('en-GB', { minimumFractionDigits: 0 });
      if (format === 'pct') return Number(val).toFixed(2) + '%';
      if (format === 'months') return val + ' mo';
      return sanitizeHtml(String(val));
    };

    let colCount = 2; // field + current
    if (hasDip) colCount++;
    if (hasTs) colCount++;
    if (hasFinal) colCount++;

    let tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#f1f5f9;border-bottom:2px solid #e2e8f0;">
          <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569;">Field</th>
          ${hasDip ? '<th style="padding:8px 10px;text-align:right;font-weight:600;color:#2563eb;">DIP</th>' : ''}
          ${hasTs ? '<th style="padding:8px 10px;text-align:right;font-weight:600;color:#7c3aed;">Indicative TS</th>' : ''}
          ${hasFinal ? '<th style="padding:8px 10px;text-align:right;font-weight:600;color:#15803d;">Bank Submit</th>' : ''}
          <th style="padding:8px 10px;text-align:right;font-weight:600;color:#64748b;">Current</th>
        </tr>
      </thead>
      <tbody>`;

    for (const row of rows) {
      const changed = row.changed;
      const rowBg = changed ? 'background:#fef3c7;' : '';
      const changeIcon = changed ? ' <span title="Value changed between stages" style="color:#f59e0b;cursor:help;">⚠</span>' : '';

      tableHtml += `<tr style="border-bottom:1px solid #f1f5f9;${rowBg}">
        <td style="padding:6px 10px;font-weight:500;color:#1e293b;">${sanitizeHtml(row.field)}${changeIcon}</td>
        ${hasDip ? `<td style="padding:6px 10px;text-align:right;color:#2563eb;">${fmtVal(row.dip, row.format)}</td>` : ''}
        ${hasTs ? `<td style="padding:6px 10px;text-align:right;color:#7c3aed;">${fmtVal(row.termsheet, row.format)}</td>` : ''}
        ${hasFinal ? `<td style="padding:6px 10px;text-align:right;color:#15803d;">${fmtVal(row.final, row.format)}</td>` : ''}
        <td style="padding:6px 10px;text-align:right;color:#64748b;">${fmtVal(row.current, row.format)}</td>
      </tr>`;
    }

    tableHtml += '</tbody></table>';

    // Variance summary
    let varianceHtml = '';
    if (variances.dip_to_termsheet?.length > 0) {
      varianceHtml += `<div style="margin-top:12px;padding:10px;background:#fffbeb;border:1px solid #fbbf24;border-radius:6px;">
        <div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:4px;">DIP → Termsheet Variances (${variances.dip_to_termsheet.length})</div>
        ${variances.dip_to_termsheet.map(v => `<div style="font-size:11px;color:#78350f;">${sanitizeHtml(v.field)}: ${v.DIP ?? '—'} → ${v.Termsheet ?? '—'}</div>`).join('')}
      </div>`;
    }
    if (variances.termsheet_to_final?.length > 0) {
      varianceHtml += `<div style="margin-top:8px;padding:10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;">
        <div style="font-size:12px;font-weight:600;color:#991b1b;margin-bottom:4px;">Termsheet → Final Variances (${variances.termsheet_to_final.length})</div>
        ${variances.termsheet_to_final.map(v => `<div style="font-size:11px;color:#7f1d1d;">${sanitizeHtml(v.field)}: ${v.Termsheet ?? '—'} → ${v.Final ?? '—'}</div>`).join('')}
      </div>`;
    }

    // Lock status
    let lockHtml = '';
    if (locks && locks.locked.length > 0) {
      const tier1Locked = locks.locked.filter(f => ['borrower_name','borrower_company','security_address','asset_type'].includes(f));
      const tier2Locked = locks.locked.filter(f => ['loan_amount','ltv_requested','current_value','rate_requested','term_months'].includes(f));
      lockHtml = `<div style="margin-top:12px;padding:10px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;font-size:11px;color:#166534;">
        🔒 <strong>${locks.locked.length} field(s) locked</strong>
        ${tier1Locked.length > 0 ? ' — Identity fields locked (DIP signed)' : ''}
        ${tier2Locked.length > 0 ? ' — Commercial fields locked (Indicative TS issued)' : ''}
      </div>`;
    }

    // Stage timestamps
    let stageTimeline = '<div style="display:flex;gap:16px;margin-bottom:12px;">';
    if (hasDip) stageTimeline += `<div style="font-size:11px;color:#2563eb;">DIP: ${new Date(stages.dip.captured_at).toLocaleDateString('en-GB')}</div>`;
    if (hasTs) stageTimeline += `<div style="font-size:11px;color:#7c3aed;">Termsheet: ${new Date(stages.termsheet.captured_at).toLocaleDateString('en-GB')}</div>`;
    if (hasFinal) stageTimeline += `<div style="font-size:11px;color:#15803d;">Bank Submit: ${new Date(stages.final.captured_at).toLocaleDateString('en-GB')}</div>`;
    stageTimeline += '</div>';

    container.innerHTML = stageTimeline + tableHtml + varianceHtml + lockHtml;

  } catch (err) {
    console.error('[terms-tracker] Load error:', err);
    container.innerHTML = '<div style="padding:12px;color:#ef4444;font-size:12px;">Failed to load terms tracker.</div>';
  }
}

/**
 * Fetch field locks and apply visual indicators to inline edit fields
 */
async function loadFieldLocks(submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/field-locks`);
    if (!resp.ok) return;
    const { locked, reasons } = await resp.json();
    if (!locked || locked.length === 0) return;

    // Find all inline-edit inputs and disable locked ones
    for (const field of locked) {
      const input = document.querySelector(`[data-field="${field}"]`);
      if (input) {
        input.disabled = true;
        input.style.background = '#f1f5f9';
        input.style.cursor = 'not-allowed';
        input.title = reasons[field] || 'Field locked';
        // Add lock icon
        const lockIcon = document.createElement('span');
        lockIcon.innerHTML = '🔒';
        lockIcon.style.cssText = 'font-size:10px;margin-left:4px;cursor:help;';
        lockIcon.title = reasons[field] || 'Field locked';
        if (input.nextElementSibling?.innerHTML !== '🔒') {
          input.parentNode.insertBefore(lockIcon, input.nextSibling);
        }
      }
    }
  } catch (err) {
    console.error('[field-locks] Load error:', err);
  }
}

/**
 * Render external workflow controls (for broker/borrower)
 */
export function renderExternalWorkflowControls(deal) {
  const stage = deal.deal_stage || 'received';
  const currentRole = getCurrentRole();
  const panel = document.getElementById('workflow-controls');
  if (!panel) return;

  // Borrower/broker sees simplified stages — internal steps are hidden
  const extStageLabels = {
    submitted: 'Submitted',
    dip_issued: 'DIP Issued',
    fee_required: 'Fee Required',
    processing: 'Processing',
    approved: 'Approved',
    legal: 'Legal',
    completed: 'Completed'
  };
  const extStageOrder = ['submitted', 'dip_issued', 'fee_required', 'processing', 'approved', 'legal', 'completed'];

  // Map internal stages → simplified borrower stage
  const stageMap = {
    received: 'submitted', assigned: 'submitted',
    dip_issued: 'dip_issued',
    info_gathering: 'dip_issued', ai_termsheet: 'dip_issued',
    fee_pending: 'fee_required', fee_paid: 'processing',
    underwriting: 'processing', bank_submitted: 'processing',
    bank_approved: 'approved', borrower_accepted: 'approved',
    legal_instructed: 'legal',
    completed: 'completed'
  };
  const extStage = stageMap[stage] || 'submitted';
  const currentIdx = extStageOrder.indexOf(extStage);

  let html = `<h3 style="margin:0 0 16px;color:var(--primary);">Deal Progress</h3>`;

  // Stage pipeline (read-only, simplified)
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:20px;">`;
  extStageOrder.forEach((s, i) => {
    const isActive = s === extStage;
    const isDone = i < currentIdx;
    const bg = isActive ? '#c9a84c' : isDone ? '#48bb78' : '#e2e8f0';
    const color = (isActive || isDone) ? '#fff' : '#666';
    html += `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:${bg};color:${color};">${extStageLabels[s]}</span>`;
  });
  html += `</div>`;

  // Stage-specific messages and actions for broker/borrower
  if (stage === 'received' || stage === 'assigned') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;"><p style="color:#666;font-size:14px;">Your deal is being reviewed by our team. We'll update you once a DIP is issued.</p></div>`;
  } else if (stage === 'dip_issued') {
    const dipAccepted = deal.dip_signed;
    const creditApproved = deal.credit_recommendation === 'approve';

    const viewDipBtn = '<button onclick="viewDipPdf(\'' + sanitizeHtml(deal.submission_id) + '\')" style="display:inline-block;padding:8px 18px;background:#1a365d;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;margin-right:8px;">View DIP</button>';

    if (dipAccepted) {
      // DIP has been accepted in-portal
      html += '<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;">' +
        '<p style="font-size:14px;margin-bottom:12px;"><strong>DIP Accepted</strong> — You have accepted the Decision in Principle. Our team is now proceeding with your application.</p>' +
        viewDipBtn +
        '</div>';
    } else if (!creditApproved) {
      // Credit hasn't approved yet — borrower must wait
      html += '<div style="background:#fffbeb;padding:16px;border-radius:8px;border-left:4px solid #f59e0b;">' +
        '<p style="font-size:14px;margin-bottom:4px;"><strong>DIP Under Review</strong></p>' +
        '<p style="font-size:13px;color:#555;">Your deal is currently being reviewed by our credit team. You will be notified once a decision has been made and your DIP is ready for acceptance.</p>' +
        '</div>';
    } else {
      // Credit approved — show DIP PDF and Accept button
      html += '<div style="background:#eff6ff;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;">' +
        '<p style="font-size:14px;margin-bottom:8px;"><strong>DIP Approved — Please Review & Accept</strong></p>' +
        '<p style="font-size:13px;color:#555;margin-bottom:12px;">Your Decision in Principle has been approved by our credit team. Please review the DIP document below and click Accept to proceed with your application.</p>' +
        viewDipBtn +
        '<button onclick="acceptDip(\'' + sanitizeHtml(deal.submission_id) + '\')" style="display:inline-block;padding:8px 18px;background:#047857;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Accept DIP</button>' +
        '<div style="margin-top:12px;padding:10px;background:#f7fafc;border-radius:6px;font-size:12px;color:#4a5568;">By clicking Accept, you confirm your intention to proceed on the terms outlined in the DIP. This is valid for 14 days from the date of issue.</div>' +
        '</div>';
    }
  } else if (stage === 'info_gathering') {
    const dipData = deal.ai_termsheet_data || {};
    const extLoan = dipData.loan_amount || deal.loan_amount || 0;
    const extRate = dipData.rate_monthly || deal.rate_requested || 0;
    const extTerm = dipData.term_months || deal.term_months || 0;
    const extArrFee = dipData.arrangement_fee_pct || 2;
    const extRetainedMo = dipData.retained_months || 6;
    const extRetainedInt = extLoan * (extRate / 100) * extRetainedMo;
    const extArrFeeAmt = extLoan * (extArrFee / 100);
    const extValCost = dipData.valuation_cost || 0;
    const extLegalCost = dipData.legal_cost || 0;
    const extBrokerFeePct = dipData.broker_fee_pct || 0;
    const extBrokerFee = extLoan * (extBrokerFeePct / 100);
    const extClientDayZero = extLoan - extRetainedInt - extArrFeeAmt - extValCost - extLegalCost;

    html += `<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;margin-bottom:16px;">
      <p style="font-size:14px;margin-bottom:12px;"><strong>DIP Approved!</strong> — We have approved a Decision in Principle for your deal.</p>

      <div style="background:#fff;padding:12px;border-radius:6px;margin-bottom:12px;border:1px solid #d1fae5;">
        <h5 style="margin:0 0 8px;font-size:12px;color:#047857;text-transform:uppercase;font-weight:600;">Approved Terms</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;">
          <div>Gross Loan: <strong>£${formatNumber(extLoan)}</strong></div>
          <div>LTV: <strong>${formatPct(dipData.ltv || deal.ltv_requested || 0)}%</strong></div>
          <div>Term: <strong>${extTerm} months</strong></div>
          <div>Rate: <strong>${formatPct(extRate)}%/m</strong></div>
          <div>Interest: <strong>${sanitizeHtml(dipData.interest_servicing || deal.interest_servicing || 'Retained')}</strong></div>
          <div>Arr. Fee: <strong>${formatPct(extArrFee)}%</strong></div>
        </div>

        <div style="margin-top:10px;padding-top:10px;border-top:1px solid #d1fae5;">
          <h5 style="margin:0 0 8px;font-size:12px;color:#047857;text-transform:uppercase;font-weight:600;">Day Zero Breakdown</h5>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;">
            <div>Retained Interest (${extRetainedMo}m): <strong>£${formatNumber(extRetainedInt)}</strong></div>
            <div>Arrangement Fee: <strong>£${formatNumber(extArrFeeAmt)}</strong></div>
            ${extValCost > 0 ? `<div>Valuation Cost: <strong>£${formatNumber(extValCost)}</strong></div>` : ''}
            ${extLegalCost > 0 ? `<div>Legal Cost: <strong>£${formatNumber(extLegalCost)}</strong></div>` : ''}
          </div>
          ${extBrokerFeePct > 0 ? `<div style="margin-top:6px;font-size:13px;padding:6px 8px;background:#fffbeb;border-radius:4px;">Broker Fee (${formatPct(extBrokerFeePct)}%): <strong>£${formatNumber(extBrokerFee)}</strong></div>` : ''}
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #d1fae5;font-size:14px;">
            Net Day Zero to Client: <strong style="color:#047857;font-size:16px;">£${formatNumber(extClientDayZero)}</strong>
          </div>
        </div>

        ${dipData.credit_decision && dipData.credit_decision.conditions ? '<div style="margin-top:8px;font-size:12px;"><strong>Conditions:</strong> ' + sanitizeHtml(dipData.credit_decision.conditions) + '</div>' : ''}
      </div>

      <button onclick="window.acceptDipExternal && window.acceptDipExternal()" style="padding:10px 24px;background:#48bb78;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px;">Accept DIP & Continue</button>
    </div>`;
  } else if (stage === 'ai_termsheet') {
    html += `<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;"><p style="font-size:14px;"><strong>Termsheet Generated</strong> — An initial termsheet has been prepared. A fee will be requested shortly to proceed with formal underwriting.</p></div>`;
  } else if (stage === 'fee_pending') {
    html += `<div style="background:#fffbeb;padding:16px;border-radius:8px;border-left:4px solid #f59e0b;"><p style="font-size:14px;"><strong>Fee Payment Required</strong> — Please arrange payment of the requested fee to proceed. Amount: <strong>£${formatNumber(deal.fee_requested_amount || 0)}</strong></p></div>`;
  } else if (stage === 'fee_paid' || stage === 'underwriting') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;"><p style="font-size:14px;"><strong>Underwriting in Progress</strong> — Our team is conducting formal underwriting. We may contact you for additional information.</p></div>`;
  } else if (stage === 'bank_submitted') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;"><p style="font-size:14px;"><strong>Submitted to Bank</strong> — Your deal has been submitted to our funding partner for approval. We'll notify you of the outcome.</p></div>`;
  } else if (stage === 'bank_approved') {
    html += `<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;">
      <p style="font-size:14px;margin-bottom:12px;"><strong>Bank Approved!</strong> — Your deal has been approved. Please confirm your acceptance below to proceed to legal.</p>
      <button onclick="window.acceptDealExternal && window.acceptDealExternal()" style="padding:10px 24px;background:#48bb78;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px;">Accept Terms & Proceed</button>
    </div>`;
  } else if (stage === 'borrower_accepted') {
    html += `<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;"><p style="font-size:14px;"><strong>Terms Accepted</strong> — Legal is being instructed. You'll receive details from the appointed law firm shortly.</p></div>`;
  } else if (stage === 'legal_instructed') {
    html += `<div style="background:#eff6ff;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;">
      <p style="font-size:14px;"><strong>Legal Instructed</strong> — Your deal is in the hands of the legal team.</p>
      ${deal.lawyer_firm ? `<p style="color:#666;margin-top:8px;">Law Firm: <strong>${sanitizeHtml(deal.lawyer_firm)}</strong></p>` : ''}
    </div>`;
  } else if (stage === 'completed') {
    html += `<div style="background:#f0fff4;padding:16px;border-radius:8px;border-left:4px solid #48bb78;">
      <p style="font-size:14px;"><strong>Deal Completed!</strong> — Congratulations, your deal has been successfully completed. Documents will be available in your portal.</p>
    </div>`;
  } else if (stage === 'declined') {
    html += `<div style="background:#fee2e2;padding:16px;border-radius:8px;border-left:4px solid #e53e3e;">
      <p style="font-size:14px;"><strong>Deal Declined</strong> — Unfortunately, your deal has been declined. Please contact our team for further details.</p>
    </div>`;
  } else if (stage === 'withdrawn') {
    html += `<div style="background:#fee2e2;padding:16px;border-radius:8px;border-left:4px solid #e53e3e;">
      <p style="font-size:14px;"><strong>Deal Withdrawn</strong> — This deal has been withdrawn. If you have any questions, please contact our team.</p>
    </div>`;
  }

  panel.innerHTML = html;
}
