import { API_BASE } from './config.js';
import { showScreen, showToast, formatNumber, formatDate, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentUser, getCurrentRole, setCurrentDealData, setCurrentDealId, getCurrentDealId } from './state.js';
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

    const loanEl = document.getElementById('detail-loan-amount');
    loanEl.innerHTML = dLoan
      ? `£${formatNumber(dLoan)}${loanIndicative ? ' <span style="font-size:0.75em;color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:4px;margin-left:6px;">INDICATIVE MAX</span>' : ''}`
      : '£0';

    const ltvEl = document.getElementById('detail-ltv');
    ltvEl.innerHTML = dLtv
      ? `${dLtv}%${ltvIndicative ? ' <span style="font-size:0.75em;color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:4px;margin-left:6px;">INDICATIVE</span>' : ''}`
      : 'N/A';

    document.getElementById('detail-property-value').textContent = `£${formatNumber(deal.current_value || 0)}`;
    document.getElementById('detail-loan-purpose').textContent = sanitizeHtml(deal.loan_purpose || 'N/A');
    document.getElementById('detail-term').textContent = deal.term_months ? deal.term_months + ' months' : 'N/A';
    document.getElementById('detail-interest-servicing').textContent = sanitizeHtml(deal.interest_servicing || 'N/A');
    document.getElementById('detail-drawdown-date').textContent = deal.drawdown_date ? formatDate(deal.drawdown_date) : 'N/A';
    document.getElementById('detail-asset-type').textContent = sanitizeHtml(deal.asset_type || 'N/A');
    document.getElementById('detail-exit-strategy').textContent = sanitizeHtml(deal.exit_strategy || 'N/A');
    document.getElementById('detail-existing-charges').textContent = sanitizeHtml(deal.existing_charges || 'None disclosed');
    document.getElementById('detail-notes').textContent = sanitizeHtml(deal.additional_notes || 'No notes');

    // ── TAB: Borrower ──
    document.getElementById('detail-borrower-name').textContent = sanitizeHtml(deal.borrower_name || 'N/A');
    document.getElementById('detail-borrower-dob').textContent = deal.borrower_dob ? formatDate(deal.borrower_dob) : 'N/A';
    document.getElementById('detail-borrower-nationality').textContent = sanitizeHtml(deal.borrower_nationality || 'N/A');
    document.getElementById('detail-borrower-jurisdiction').textContent = sanitizeHtml(deal.borrower_jurisdiction || 'N/A');
    document.getElementById('detail-borrower-type').textContent = sanitizeHtml(deal.borrower_type || 'N/A');
    document.getElementById('detail-company-name').textContent = sanitizeHtml(deal.company_name || 'N/A');
    document.getElementById('detail-company-number').textContent = sanitizeHtml(deal.company_number || 'N/A');
    document.getElementById('detail-borrower-email').textContent = sanitizeHtml(deal.borrower_email || 'N/A');
    document.getElementById('detail-borrower-phone').textContent = sanitizeHtml(deal.borrower_phone || 'N/A');

    // ── TAB: Property ──
    document.getElementById('detail-prop-address').textContent = sanitizeHtml(deal.security_address || 'N/A');
    document.getElementById('detail-prop-postcode').textContent = sanitizeHtml(deal.security_postcode || 'N/A');
    document.getElementById('detail-prop-type').textContent = sanitizeHtml(deal.asset_type || 'N/A');
    document.getElementById('detail-prop-value').textContent = deal.current_value ? `£${formatNumber(deal.current_value)}` : 'N/A';
    document.getElementById('detail-prop-purchase').textContent = deal.purchase_price ? `£${formatNumber(deal.purchase_price)}` : 'N/A';
    document.getElementById('detail-prop-tenure').textContent = sanitizeHtml(deal.property_tenure || 'N/A');
    document.getElementById('detail-prop-occupancy').textContent = sanitizeHtml(deal.occupancy_status || 'N/A');
    document.getElementById('detail-prop-use').textContent = sanitizeHtml(deal.current_use || 'N/A');

    // ── TAB: Use of Funds ──
    document.getElementById('detail-use-of-funds').textContent = sanitizeHtml(deal.use_of_funds || 'N/A');
    document.getElementById('detail-refurb-scope').textContent = sanitizeHtml(deal.refurb_scope || 'N/A');
    document.getElementById('detail-refurb-cost').textContent = deal.refurb_cost ? `£${formatNumber(deal.refurb_cost)}` : 'N/A';
    document.getElementById('detail-deposit-source').textContent = sanitizeHtml(deal.deposit_source || 'N/A');
    document.getElementById('detail-concurrent').textContent = sanitizeHtml(deal.concurrent_transactions || 'None');

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
  // This is a simplified version. The full version needs to be comprehensive.
  // In a production app, this would be much longer and handle all the stage-specific logic
  const currentRole = getCurrentRole();
  const panel = document.getElementById('workflow-controls');
  if (!panel) return;

  const stage = deal.deal_stage || 'received';

  let html = `<h3 style="margin:0 0 16px;color:var(--primary);">Deal Workflow</h3>`;

  // Stage pipeline visual
  const stageOrder = ['received', 'assigned', 'dip_issued', 'info_gathering', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
  const stageLabels = {
    received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
    info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
    fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
    bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
    borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
    completed: 'Completed'
  };

  const currentIdx = stageOrder.indexOf(stage);
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:20px;">`;
  stageOrder.forEach((s, i) => {
    const isActive = s === stage;
    const isDone = i < currentIdx;
    const bg = isActive ? '#c9a84c' : isDone ? '#48bb78' : '#e2e8f0';
    const color = (isActive || isDone) ? '#fff' : '#666';
    html += `<span style="padding:4px 10px;border-radius:12px;font-size:11px;background:${bg};color:${color};">${stageLabels[s] || s}</span>`;
  });
  html += `</div>`;

  // Stage-specific actions (simplified - real version would have much more)
  if (currentRole === 'admin') {
    if (stage === 'received') {
      html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;margin-bottom:16px;">
        <h4 style="margin:0 0 12px;">Assign to RM</h4>
        <div style="display:flex;gap:8px;">
          <select id="action-rm-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;font-size:13px;">
            <option value="">-- Select RM --</option>
          </select>
          <button onclick="window.assignRMAndAdvance ? window.assignRMAndAdvance() : alert('Function not available')" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Assign & Advance</button>
        </div>
      </div>`;
    }
  }

  html += `<button onclick="window.location.reload()" style="padding:8px 16px;background:#666;color:white;border:none;border-radius:4px;cursor:pointer;">Refresh Deal</button>`;

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

  let html = `<h3 style="margin:0 0 16px;color:var(--primary);">Your Actions</h3>`;

  // DIP stage actions for external users
  if (stage === 'dip_issued' && ['broker', 'borrower'].includes(currentRole)) {
    html += `<div style="background:#f0f5ff;padding:16px;border-radius:8px;margin-bottom:16px;border:2px solid #c9a84c;">
      <h4 style="margin:0 0 12px;">Decision In Principle Issued</h4>
      <p style="margin:0 0 16px;font-size:13px;color:#666;">You can now review the DIP terms and decide whether to proceed.</p>
      <button onclick="window.acceptDipExternal ? window.acceptDipExternal() : alert('Function not available')" style="padding:10px 24px;background:#48bb78;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;margin-right:8px;">Accept DIP</button>
      <button onclick="if(confirm('Are you sure you want to decline this DIP?')) window.declineDeal ? window.declineDeal() : alert('Function not available')" style="padding:10px 24px;background:#e53e3e;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Decline</button>
    </div>`;
  }

  // Borrower acceptance stage
  if (stage === 'borrower_accepted' && currentRole === 'borrower') {
    html += `<div style="background:#f7fafc;padding:16px;border-radius:8px;">
      <h4 style="margin:0 0 12px;">Deal Acceptance</h4>
      <p style="margin:0 0 16px;font-size:13px;color:#666;">You have accepted these terms. The deal is now proceeding to legal instruction.</p>
    </div>`;
  }

  panel.innerHTML = html;
}
