import { API_BASE } from './config.js';
import { showScreen, showToast, formatNumber, formatPct, formatDate, formatDateTime, sanitizeHtml, attachMoneyFormat, getMoneyValue, parseFormattedNumber } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentUser, getCurrentRole, setCurrentDealData, setCurrentDealId, getCurrentDealId, restoreDipFormState, hasDipFormState } from './state.js';
import { renderDocumentsList } from './documents.js';
import { populateOnboardingData, switchDetailTab } from './onboarding.js';

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
      info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
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

    function setField(elId, value, opts) {
      const el = document.getElementById(elId);
      if (!el) return;
      const v = value || '';
      if (canEdit) {
        const fieldName = opts?.field || elId.replace('detail-', '');
        const type = opts?.type || 'text';
        if (type === 'select' && opts?.options) {
          let selectHtml = '<select data-field="' + fieldName + '" class="intake-editable" style="' + editableStyle + '">';
          opts.options.forEach(o => {
            selectHtml += '<option value="' + o.value + '"' + (o.value === v ? ' selected' : '') + '>' + sanitizeHtml(o.label) + '</option>';
          });
          selectHtml += '</select>';
          el.innerHTML = selectHtml;
        } else if (type === 'textarea') {
          el.innerHTML = '<textarea data-field="' + fieldName + '" class="intake-editable" style="' + editableStyle + 'min-height:50px;resize:vertical;">' + sanitizeHtml(v) + '</textarea>';
        } else {
          el.innerHTML = '<input type="' + type + '" data-field="' + fieldName + '" class="intake-editable" value="' + sanitizeHtml(v) + '" style="' + editableStyle + '">';
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

    setField('detail-loan-amount', String(dLoan || ''), { field: 'loan_amount', display: dLoan ? '£' + formatNumber(dLoan) + (loanIndicative ? ' (INDICATIVE)' : '') : '£0' });
    setField('detail-ltv', String(dLtv || ''), { field: 'ltv_requested', display: dLtv ? formatPct(dLtv) + '%' + (ltvIndicative ? ' (INDICATIVE)' : '') : 'N/A' });
    setField('detail-property-value', String(deal.current_value || ''), { field: 'current_value', display: '£' + formatNumber(deal.current_value || 0) });
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
    setField('detail-prop-value', String(deal.current_value || ''), { field: 'current_value', display: deal.current_value ? '£' + formatNumber(deal.current_value) : 'N/A' });
    setField('detail-prop-purchase', String(deal.purchase_price || ''), { field: 'purchase_price', display: deal.purchase_price ? '£' + formatNumber(deal.purchase_price) : 'N/A' });
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
    setField('detail-refurb-cost', String(deal.refurb_cost || ''), { field: 'refurb_cost', display: deal.refurb_cost ? '£' + formatNumber(deal.refurb_cost) : 'N/A' });
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
    }

    // ── TAB: Documents ──
    renderDocumentsList(deal.documents || []);

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
    const unlockedStages = ['ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
    const isPhase2Unlocked = unlockedStages.includes(stage);

    document.getElementById('phase2-lock').textContent = isPhase2Unlocked ? '\u{1F513}' : '\u{1F512}';

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
    const phase2Tabs = ['kyc', 'financials', 'valuation', 'refurbishment', 'exit', 'aml', 'insurance'];
    phase2Tabs.forEach(t => {
      const lockNotice = document.getElementById(`${t}-lock-notice`);
      const form = document.getElementById(`${t}-form`) || document.getElementById(`${t === 'refurbishment' ? 'refurbishment' : t}-form`);
      if (lockNotice) lockNotice.style.display = isPhase2Unlocked ? 'none' : 'block';
      if (form) form.style.display = isPhase2Unlocked ? 'block' : 'none';
    });

    // Pre-fill Phase 2 forms from onboarding_data if it exists
    if (isPhase2Unlocked && deal.onboarding_data) {
      populateOnboardingData(deal.onboarding_data);
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
    info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
    fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
    bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
    borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
    completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
  };

  // Map each stage to who is responsible for the next action
  const stageResponsibility = {
    received: { who: 'Admin', action: 'Assign to RM' },
    assigned: { who: 'RM', action: 'Issue DIP' },
    dip_issued: { who: 'Credit', action: 'Credit Review' },
    info_gathering: { who: 'Credit', action: 'Generate Termsheet' },
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

  // ── Stage Pipeline Visual ──
  const stageOrder = ['received', 'assigned', 'dip_issued', 'info_gathering', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
  const currentIdx = stageOrder.indexOf(stage);
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:20px;">`;
  stageOrder.forEach((s, i) => {
    const isActive = s === stage;
    const isDone = i < currentIdx;
    const bg = isActive ? '#c9a84c' : isDone ? '#48bb78' : '#e2e8f0';
    const color = (isActive || isDone) ? '#fff' : '#666';
    html += `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:${bg};color:${color};">${stageLabels[s]}</span>`;
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

    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Assignments</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
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

  // ── Fee Tracker (RM / Admin — must be filled BEFORE issuing DIP) ──
  if (['admin', 'rm'].includes(currentRole)) {
    const dipFee = deal.dip_fee_confirmed ? 'Confirmed' : 'Not confirmed';
    const commitFee = deal.commitment_fee_received ? 'Confirmed' : 'Not confirmed';

    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;border-left:4px solid #7c3aed;">
      <h4 style="margin:0 0 4px;color:#7c3aed;">Fee Tracker</h4>
      <p style="margin:0 0 12px;font-size:11px;color:#666;">Enter fee details here first. These will flow into the DIP fee schedule below.</p>
      <div style="display:flex;gap:20px;margin-bottom:12px;">
        <span style="font-size:13px;">DIP Fee: <strong style="color:${deal.dip_fee_confirmed ? '#48bb78' : '#e53e3e'}">${dipFee}</strong></span>
        <span style="font-size:13px;">Commitment Fee: <strong style="color:${deal.commitment_fee_received ? '#48bb78' : '#e53e3e'}">${commitFee}</strong></span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:end;">
        <div>
          <label style="font-size:11px;color:#666;">Fee Type</label>
          <select id="fee-type" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
            <option value="dip_fee">DIP Fee</option>
            <option value="commitment_fee">Commitment Fee</option>
            <option value="arrangement_fee">Arrangement Fee</option>
            <option value="valuation_fee">Valuation Fee</option>
            <option value="legal_fee">Legal Fee</option>
            <option value="broker_fee">Broker Fee</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Amount (£)</label>
          <input type="text" id="fee-amount" placeholder="0" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Payment Date</label>
          <input type="date" id="fee-date" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <div>
          <label style="font-size:11px;color:#666;">Reference</label>
          <input type="text" id="fee-ref" placeholder="Payment ref" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
        </div>
        <button onclick="window.confirmFee && window.confirmFee()" style="padding:8px 16px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Confirm</button>
      </div>
    </div>`;

    // Show existing fees
    if (deal.fees && deal.fees.length > 0) {
      html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
        <h4 style="margin:0 0 12px;">Fee History</h4>
        <table style="width:100%;font-size:13px;border-collapse:collapse;">
          <tr style="border-bottom:1px solid #e2e8f0;"><th style="text-align:left;padding:6px;">Type</th><th style="text-align:left;padding:6px;">Amount</th><th style="text-align:left;padding:6px;">Date</th><th style="text-align:left;padding:6px;">Reference</th><th style="text-align:left;padding:6px;">Confirmed By</th></tr>
          ${deal.fees.map(f => `<tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:6px;">${f.fee_type.replace(/_/g, ' ')}</td><td style="padding:6px;">£${formatNumber(f.amount)}</td><td style="padding:6px;">${formatDate(f.payment_date)}</td><td style="padding:6px;">${sanitizeHtml(f.payment_ref || '-')}</td><td style="padding:6px;">${sanitizeHtml(f.first_name)} ${sanitizeHtml(f.last_name)}</td></tr>`).join('')}
        </table>
      </div>`;
    }
  }

  // ── Borrowers (verify before DIP) ──
  const borrowers = deal.borrowers || [];
  html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
    <h4 style="margin:0 0 12px;">Borrowers (${borrowers.length})</h4>`;

  if (borrowers.length > 0) {
    html += `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:12px;">
      <tr style="border-bottom:1px solid #e2e8f0;"><th style="text-align:left;padding:6px;">Name</th><th style="text-align:left;padding:6px;">Role</th><th style="text-align:left;padding:6px;">Type</th><th style="text-align:left;padding:6px;">Email</th><th style="text-align:left;padding:6px;">KYC</th><th style="padding:6px;"></th></tr>
      ${borrowers.map(b => `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:6px;">${sanitizeHtml(b.full_name)}</td>
        <td style="padding:6px;"><span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${b.role === 'primary' ? '#bee3f8' : '#fefcbf'};color:${b.role === 'primary' ? '#2a4365' : '#744210'}">${b.role}</span></td>
        <td style="padding:6px;">${sanitizeHtml(b.borrower_type)}${b.company_name ? ` (${sanitizeHtml(b.company_name)})` : ''}</td>
        <td style="padding:6px;">${sanitizeHtml(b.email || '-')}</td>
        <td style="padding:6px;"><span style="color:${b.kyc_status === 'verified' ? '#48bb78' : b.kyc_status === 'submitted' ? '#c9a84c' : '#e53e3e'}">${b.kyc_status}</span></td>
        <td style="padding:6px;"><button onclick="window.removeBorrower && window.removeBorrower(${b.id})" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:12px;">×</button></td>
      </tr>`).join('')}
    </table>`;
  }

  html += `<div style="border-top:1px solid #e2e8f0;padding-top:12px;">
    <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Add Borrower</div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;align-items:end;">
      <div><label style="font-size:11px;color:#666;">Full Name *</label><input type="text" id="bw-name" placeholder="Full name" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
      <div><label style="font-size:11px;color:#666;">Role</label><select id="bw-role" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="primary">Primary</option><option value="joint">Joint & Several</option><option value="guarantor">Guarantor</option><option value="director">Director</option></select></div>
      <div><label style="font-size:11px;color:#666;">Type</label><select id="bw-type" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"><option value="individual">Individual</option><option value="corporate">Corporate</option><option value="spv">SPV</option></select></div>
      <div><label style="font-size:11px;color:#666;">Email</label><input type="email" id="bw-email" placeholder="Email" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;"></div>
      <button onclick="window.addBorrower && window.addBorrower()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Add</button>
    </div>
  </div></div>`;

  // ── Properties / Portfolio (verify before DIP) ──
  const properties = deal.properties || [];
  const summary = deal.portfolio_summary || {};
  html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
    <h4 style="margin:0 0 12px;">Properties / Portfolio (${properties.length})</h4>`;

  if (properties.length > 0) {
    html += `<div style="display:flex;gap:16px;margin-bottom:12px;font-size:13px;">
      <span>Total Value: <strong>£${formatNumber(summary.total_market_value || 0)}</strong></span>
      <span>Total GDV: <strong>£${formatNumber(summary.total_gdv || 0)}</strong></span>
    </div>`;
    html += `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:12px;">
      <tr style="border-bottom:1px solid #e2e8f0;"><th style="text-align:left;padding:6px;">Address</th><th style="text-align:left;padding:6px;">Type</th><th style="text-align:left;padding:6px;">Value</th><th style="text-align:left;padding:6px;">GDV</th><th style="text-align:left;padding:6px;">Day 1 LTV</th><th style="text-align:left;padding:6px;">Tenure</th><th style="padding:6px;"></th></tr>
      ${properties.map(p => `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:6px;">${sanitizeHtml(p.address)}${p.postcode ? `, ${sanitizeHtml(p.postcode)}` : ''}</td>
        <td style="padding:6px;">${sanitizeHtml(p.property_type || '-')}</td>
        <td style="padding:6px;">${p.market_value ? '£' + formatNumber(p.market_value) : '-'}</td>
        <td style="padding:6px;">${p.gdv ? '£' + formatNumber(p.gdv) : '-'}</td>
        <td style="padding:6px;">${p.day1_ltv ? formatPct(p.day1_ltv) + '%' : '-'}</td>
        <td style="padding:6px;">${sanitizeHtml(p.tenure || '-')}</td>
        <td style="padding:6px;"><button onclick="window.removeProperty && window.removeProperty(${p.id})" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:12px;">×</button></td>
      </tr>`).join('')}
    </table>`;
  }

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
  </div></div>`;

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

    html += `<div style="background:#f0f5ff;padding:20px;border-radius:8px;margin-bottom:16px;border:2px solid var(--primary);">

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
          <h5 style="margin:0;color:#374151;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Security Schedule &mdash; ${propList.length} ${propList.length === 1 ? 'Property' : 'Properties'}</h5>
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
            <input type="text" value="${propList.length}" style="width:100%;padding:8px;border-radius:4px;${brokerField};font-size:13px;" readonly>
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
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;">
            <div>
              <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Retained Interest (months)</label>
              <input type="number" id="dip-retained-months" value="6" min="0" max="36" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#92400e;">Default: 6 months</span>
            </div>
            <div>
              <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Valuation Cost (£)</label>
              <input type="text" id="dip-valuation-cost" value="0" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#6b7280;">Client pays</span>
            </div>
            <div>
              <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Legal Cost (£)</label>
              <input type="text" id="dip-legal-cost" value="0" style="width:100%;padding:8px;border-radius:4px;${rmField};font-size:13px;">
              <span style="font-size:10px;color:#6b7280;">Client pays</span>
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
              <td style="padding:8px;text-align:right;"><span style="font-size:12px;" id="dip-fee-val-display">£0</span><br><span style="font-size:10px;color:#6b7280;">Auto from cost above</span></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">Upfront</td>
              <td style="padding:8px;font-size:11px;">Direct payment by client</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px;font-weight:600;">Legal Fee</td>
              <td style="padding:8px;text-align:right;"><span style="font-size:12px;" id="dip-fee-legal-display">£0</span><br><span style="font-size:10px;color:#6b7280;">Auto from cost above</span></td>
              <td style="padding:8px;font-size:11px;color:#1e40af;">On completion</td>
              <td style="padding:8px;font-size:11px;">Direct payment by client</td>
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
        propValInputs.forEach(inp => { total += parseFormattedNumber(inp.value); });
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

        // 3. At least one property valuation entered
        let totalPropVal = 0;
        document.querySelectorAll('.dip-prop-valuation').forEach(inp => { totalPropVal += parseFormattedNumber(inp.value); });
        checks.push({ label: 'Property valuation(s) entered', ok: totalPropVal > 0 });

        // 4. All properties approved or removed
        let allPropsHandled = true;
        const propRows = document.querySelectorAll('#dip-property-table tbody tr');
        propRows.forEach((row, i) => {
          if (row.style.opacity !== '0.5') { // not removed
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

  // DIP_ISSUED (Credit or Admin) - Credit Review & In-Principle Approval
  if (stage === 'dip_issued' && ['credit', 'admin'].includes(currentRole)) {
    const dipData = deal.ai_termsheet_data || {};
    html += `<div style="background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #7c3aed;">
      <h4 style="margin:0 0 4px;color:#7c3aed;">Credit Review — In-Principle Decision</h4>
      <p style="margin:0 0 16px;font-size:12px;color:#666;">Review the DIP terms submitted by the RM and provide your in-principle decision.</p>

      <div style="background:#f5f3ff;padding:12px;border-radius:6px;margin-bottom:16px;">
        <h5 style="margin:0 0 8px;font-size:12px;color:#7c3aed;text-transform:uppercase;">DIP Terms Under Review</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;">
          <div>Loan: <strong>£${formatNumber(dipData.loan_amount || deal.loan_amount || 0)}</strong></div>
          <div>LTV: <strong>${formatPct(dipData.ltv || deal.ltv_requested || 0)}%</strong></div>
          <div>Term: <strong>${dipData.term_months || deal.term_months || 'N/A'} months</strong></div>
          <div>Rate: <strong>${formatPct(dipData.rate_monthly || deal.rate_requested || 0)}%/m</strong></div>
          <div>Interest: <strong>${sanitizeHtml(dipData.interest_servicing || deal.interest_servicing || 'N/A')}</strong></div>
          <div>Arr. Fee: <strong>${formatPct(dipData.arrangement_fee_pct || 2)}%</strong></div>
        </div>
        ${dipData.retained_months ? `<div style="margin-top:4px;">Retained Interest: <strong>${dipData.retained_months} months</strong></div>` : ''}
        ${dipData.removed_properties && dipData.removed_properties.length > 0 ? '<div style="margin-top:8px;font-size:12px;color:#991b1b;">Properties removed by RM: ' + dipData.removed_properties.map(p => sanitizeHtml(p.address.substring(0, 40))).join('; ') + '</div>' : ''}
        ${dipData.conditions ? '<div style="margin-top:8px;font-size:12px;"><strong>RM Conditions:</strong> ' + sanitizeHtml(dipData.conditions) + '</div>' : ''}
      </div>

      <!-- Credit can override retained interest -->
      <div style="background:#fff8f0;padding:12px;border-radius:6px;margin-bottom:16px;border:1px solid #f59e0b;">
        <h5 style="margin:0 0 8px;color:#92400e;font-size:11px;text-transform:uppercase;">Credit Override &mdash; Retained Interest</h5>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;align-items:end;">
          <div>
            <label style="font-size:11px;color:#92400e;display:block;margin-bottom:4px;font-weight:600;">Retained Months</label>
            <input type="number" id="credit-retained-months" value="${dipData.retained_months || 6}" min="0" max="36" style="width:100%;padding:8px;border-radius:4px;border:2px solid #7c3aed;font-size:13px;">
          </div>
          <div style="font-size:11px;color:#6b7280;padding-bottom:8px;">Change if credit assessment warrants different retention period (default: 6 months set by RM)</div>
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
        <button onclick="window.creditDecision && window.creditDecision('moreinfo')" style="padding:10px 24px;background:#c9a84c;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">More Info Needed</button>
      </div>
    </div>`;
  }

  // INFO_GATHERING (Credit or Admin) - Generate AI Termsheet
  if (stage === 'info_gathering' && ['credit', 'admin'].includes(currentRole)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Generate AI Termsheet</h4>
      <textarea id="ai-termsheet-data" placeholder="AI termsheet data / notes (optional)" style="width:100%;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:80px;margin-bottom:8px;"></textarea>
      <button onclick="window.generateAiTermsheet && window.generateAiTermsheet()" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Generate Termsheet</button>
    </div>`;
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

  // Generic Decline/Withdraw for all stages (except final stages)
  if (!['completed', 'declined', 'withdrawn'].includes(stage)) {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Deal Status</h4>
      <div style="display:flex;gap:8px;">
        <button onclick="window.withdrawDeal && window.withdrawDeal()" style="padding:8px 16px;background:#f59e0b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Withdraw</button>
      </div>
    </div>`;
  }

  // ── Recommendation (Credit / Compliance) ──
  if (['credit', 'compliance', 'admin'].includes(currentRole)) {
    const existingRec = currentRole === 'credit' ? deal.credit_recommendation : currentRole === 'compliance' ? deal.compliance_recommendation : null;

    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
      <h4 style="margin:0 0 12px;">Recommendation ${existingRec ? `(Current: <span style="color:${existingRec === 'approve' ? '#48bb78' : existingRec === 'decline' ? '#e53e3e' : '#c9a84c'}">${existingRec.toUpperCase()}</span>)` : ''}</h4>
      <div style="margin-bottom:8px;">
        <span style="font-size:13px;">RM: <strong>${sanitizeHtml(deal.rm_recommendation || 'Pending')}</strong></span>
        <span style="margin-left:16px;font-size:13px;">Credit: <strong>${sanitizeHtml(deal.credit_recommendation || 'Pending')}</strong></span>
        <span style="margin-left:16px;font-size:13px;">Compliance: <strong>${sanitizeHtml(deal.compliance_recommendation || 'Pending')}</strong></span>
        <span style="margin-left:16px;font-size:13px;">Final: <strong style="color:${deal.final_decision === 'approve' ? '#48bb78' : deal.final_decision === 'decline' ? '#e53e3e' : '#666'}">${deal.final_decision ? sanitizeHtml(deal.final_decision.toUpperCase()) : 'Pending'}</strong></span>
      </div>
      <div style="display:flex;gap:8px;align-items:end;">
        <textarea id="rec-comments" placeholder="Comments / rationale..." style="flex:1;padding:8px;border-radius:4px;border:1px solid #ddd;font-size:13px;min-height:60px;"></textarea>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button onclick="window.submitRecommendation && window.submitRecommendation('approve')" style="padding:8px 16px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Approve</button>
          <button onclick="window.submitRecommendation && window.submitRecommendation('more_info')" style="padding:8px 16px;background:#c9a84c;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">More Info</button>
          <button onclick="window.submitRecommendation && window.submitRecommendation('decline')" style="padding:8px 16px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Decline</button>
        </div>
      </div>
    </div>`;
  }

  // ── Audit Trail (enriched with stage transitions, elapsed time) ──
  if (deal.audit && deal.audit.length > 0) {
    const auditStageLabels = {
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };

    let auditHtml = '';
    deal.audit.forEach((a, idx) => {
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
        + '<div>' + stageBadge + '<strong>' + sanitizeHtml(a.action.replace(/_/g, ' ')) + '</strong> ' + transitionHtml + '</div>'
        + elapsedBadge
        + '</div>'
        + commentHtml
        + '<div style="color:#999;margin-top:4px;font-size:12px;">'
        + '<strong>' + sanitizeHtml(a.first_name) + ' ' + sanitizeHtml(a.last_name) + '</strong>'
        + ' <span style="padding:1px 6px;background:' + roleBg + ';color:' + roleColor + ';border-radius:3px;font-size:10px;font-weight:600;margin-left:4px;">' + sanitizeHtml(a.role.toUpperCase()) + '</span>'
        + ' &middot; <strong>' + formatDateTime(a.created_at) + '</strong>'
        + '</div></div></div>';
    });

    html += '<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">'
      + '<h4 style="margin:0 0 12px;">Audit Trail</h4>'
      + '<div style="max-height:400px;overflow-y:auto;">' + auditHtml + '</div></div>';
  }

  panel.innerHTML = html;
}

/**
 * Render external workflow controls (for broker/borrower)
 */
export function renderExternalWorkflowControls(deal) {
  const stage = deal.deal_stage || 'received';
  const currentRole = getCurrentRole();
  const panel = document.getElementById('workflow-controls');
  if (!panel) return;

  const stageLabels = {
    received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
    info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
    fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
    bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
    borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
    completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
  };
  const stageOrder = ['received', 'assigned', 'dip_issued', 'info_gathering', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
  const currentIdx = stageOrder.indexOf(stage);

  let html = `<h3 style="margin:0 0 16px;color:var(--primary);">Deal Progress</h3>`;

  // Stage pipeline (read-only)
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:20px;">`;
  stageOrder.forEach((s, i) => {
    const isActive = s === stage;
    const isDone = i < currentIdx;
    const bg = isActive ? '#c9a84c' : isDone ? '#48bb78' : '#e2e8f0';
    const color = (isActive || isDone) ? '#fff' : '#666';
    html += `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:${bg};color:${color};">${stageLabels[s]}</span>`;
  });
  html += `</div>`;

  // Stage-specific messages and actions for broker/borrower
  if (stage === 'received' || stage === 'assigned') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;"><p style="color:#666;font-size:14px;">Your deal is being reviewed by our team. We'll update you once a DIP is issued.</p></div>`;
  } else if (stage === 'dip_issued') {
    html += `<div style="background:#eff6ff;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;"><p style="font-size:14px;margin-bottom:12px;"><strong>DIP Under Credit Review</strong> — Your decision in principle is being reviewed by our credit team. We'll notify you of the outcome shortly.</p></div>`;
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
