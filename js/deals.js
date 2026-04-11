import { API_BASE, N8N_WEBHOOK } from './config.js';
import { showScreen, showAlert, hideAlert, showToast, formatNumber, formatDate, sanitizeHtml } from './utils.js';
import { getAuthToken, getCurrentUser, getCurrentRole, fetchWithAuth } from './auth.js';
import { setCurrentDealData, setCurrentDealId, getCurrentDealId } from './state.js';

let currentDealTab = 0;
const dealTabIds = ['dt-overview', 'dt-borrower', 'dt-property', 'dt-funds'];

/**
 * Show the deal form for submission
 */
export function showDealForm() {
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();

  if (currentUser) {
    document.getElementById('deal-user-info').textContent =
      `${sanitizeHtml(currentUser.first_name)} ${sanitizeHtml(currentUser.last_name)} (${sanitizeHtml(currentRole || 'user')})`;
  }
  currentDealTab = 0;
  updateDealTabs();

  // Show refurb fields if purpose is refurbishment
  document.getElementById('deal-purpose').addEventListener('change', function() {
    const isRefurb = ['refurbishment', 'dev_exit'].includes(this.value);
    document.getElementById('deal-refurb-fields').style.display = isRefurb ? 'block' : 'none';
  });

  // Show corporate fields if borrower type is not individual
  document.getElementById('deal-borrower-type').addEventListener('change', function() {
    const isCorp = this.value && this.value !== 'individual';
    document.getElementById('deal-corporate-fields').style.display = isCorp ? 'block' : 'none';
  });

  showScreen('screen-deal');
}

/**
 * Switch between deal submission tabs
 */
export function switchDealTab(btn) {
  const tabId = btn.dataset.tab;
  currentDealTab = dealTabIds.indexOf(tabId);
  updateDealTabs();
}

/**
 * Next deal tab
 */
export function dealTabNext() {
  if (currentDealTab < dealTabIds.length - 1) {
    currentDealTab++;
    updateDealTabs();
  }
}

/**
 * Previous deal tab
 */
export function dealTabBack() {
  if (currentDealTab > 0) {
    currentDealTab--;
    updateDealTabs();
  } else {
    showDashboard();
  }
}

/**
 * Update deal tab visibility
 */
export function updateDealTabs() {
  // Tab buttons
  document.querySelectorAll('.deal-tab').forEach((t, i) => {
    t.classList.toggle('active', i === currentDealTab);
  });
  // Tab panels
  dealTabIds.forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', i === currentDealTab);
  });
  // Nav buttons
  document.getElementById('deal-back-btn').textContent = currentDealTab === 0 ? '\u2190 Cancel' : '\u2190 Back';
  document.getElementById('deal-next-btn').style.display = currentDealTab < dealTabIds.length - 1 ? 'inline-block' : 'none';
  document.getElementById('deal-submit-btn').style.display = currentDealTab === dealTabIds.length - 1 ? 'inline-block' : 'none';
  window.scrollTo(0, 0);
}

/**
 * Submit a deal
 */
export async function submitDeal() {
  hideAlert('deal-alert');
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();
  const authToken = getAuthToken();

  const address = document.getElementById('deal-address').value.trim();
  const loanAmount = document.getElementById('deal-loan-amount').value;
  const purpose = document.getElementById('deal-purpose').value;
  const exit = document.getElementById('deal-exit').value.trim();

  if (!address || !loanAmount || !purpose || !exit) {
    showAlert('deal-alert', 'error', 'Please fill in all required fields across all tabs (address, loan amount, purpose, exit strategy).');
    return;
  }

  if (!authToken) {
    showAlert('deal-alert', 'error', 'You must be logged in to submit a deal.');
    return;
  }

  const dealBtn = document.getElementById('deal-submit-btn');
  dealBtn.disabled = true;
  dealBtn.innerHTML = '<span class="spinner"></span> Submitting...';

  const currentValue = document.getElementById('deal-value').value;
  const ltv = (currentValue && loanAmount) ? ((loanAmount / currentValue) * 100).toFixed(1) : null;

  const body = {
    // Tab 1: Deal Overview
    loan_amount: loanAmount,
    loan_purpose: purpose,
    term_months: document.getElementById('deal-term').value || null,
    interest_servicing: document.getElementById('deal-interest-servicing').value || null,
    drawdown_date: document.getElementById('deal-drawdown-date').value || null,
    exit_strategy: exit,
    existing_charges: document.getElementById('deal-existing-charges').value.trim() || null,
    // Tab 2: Borrower
    borrower_name: document.getElementById('deal-borrower-name')?.value.trim() || (currentRole === 'borrower' ? `${currentUser.first_name} ${currentUser.last_name}` : null),
    borrower_dob: document.getElementById('deal-borrower-dob').value || null,
    borrower_nationality: document.getElementById('deal-borrower-nationality').value.trim() || null,
    borrower_jurisdiction: document.getElementById('deal-borrower-jurisdiction').value.trim() || null,
    borrower_type: document.getElementById('deal-borrower-type').value || null,
    company_name: document.getElementById('deal-company-name')?.value.trim() || null,
    company_number: document.getElementById('deal-company-number')?.value.trim() || null,
    borrower_email: document.getElementById('deal-borrower-email')?.value.trim() || (currentRole === 'borrower' ? currentUser.email : null),
    borrower_phone: document.getElementById('deal-borrower-phone')?.value.trim() || null,
    borrower_company: document.getElementById('deal-borrower-company')?.value.trim() || null,
    broker_fca: document.getElementById('deal-broker-company-number')?.value.trim() || null,
    broker_name: currentRole === 'broker' ? `${currentUser.first_name} ${currentUser.last_name}` : null,
    broker_company: currentRole === 'broker' ? (currentUser.company || null) : null,
    // Tab 3: Property
    security_address: address,
    security_postcode: document.getElementById('deal-postcode').value.trim() || null,
    asset_type: document.getElementById('deal-asset-type').value || null,
    current_value: currentValue || null,
    purchase_price: document.getElementById('deal-purchase-price')?.value || null,
    property_tenure: document.getElementById('deal-tenure').value || null,
    occupancy_status: document.getElementById('deal-occupancy').value || null,
    current_use: document.getElementById('deal-current-use').value || null,
    ltv_requested: ltv,
    // Tab 4: Use of Funds
    use_of_funds: document.getElementById('deal-use-of-funds').value.trim() || null,
    refurb_scope: document.getElementById('deal-refurb-scope')?.value.trim() || null,
    refurb_cost: document.getElementById('deal-refurb-cost')?.value || null,
    deposit_source: document.getElementById('deal-deposit-source')?.value.trim() || null,
    concurrent_transactions: document.getElementById('deal-concurrent')?.value.trim() || null,
    additional_notes: document.getElementById('deal-notes').value.trim() || null,
    documents: []
  };

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await resp.json();

    if (!resp.ok) {
      showAlert('deal-alert', 'error', data.error || 'Submission failed. Please try again.');
      dealBtn.disabled = false;
      dealBtn.textContent = 'Submit Deal \u2192';
      return;
    }

    // Fire webhook to n8n from browser
    const webhookPayload = {
      submissionId: data.deal.submission_id,
      source: 'web_form',
      timestamp: new Date().toISOString(),
      submittedBy: { userId: currentUser.id, email: currentUser.email, role: currentRole },
      borrower: {
        name: body.borrower_name || '', company: body.borrower_company || '',
        email: body.borrower_email || '', phone: body.borrower_phone || '',
        type: body.borrower_type || '', nationality: body.borrower_nationality || '',
        jurisdiction: body.borrower_jurisdiction || ''
      },
      broker: { name: body.broker_name || '', company: body.broker_company || '', fca_number: body.broker_fca || '' },
      security: {
        address: body.security_address || '', postcode: body.security_postcode || '',
        asset_type: body.asset_type || '', current_value: body.current_value || null,
        tenure: body.property_tenure || '', occupancy: body.occupancy_status || ''
      },
      loan: {
        amount: body.loan_amount || null, ltv_requested: body.ltv_requested || null,
        purpose: body.loan_purpose || '', exit_strategy: body.exit_strategy || '',
        term_months: body.term_months || null, interest_servicing: body.interest_servicing || '',
        drawdown_date: body.drawdown_date || null
      },
      use_of_funds: body.use_of_funds || '',
      documents: [],
      additional_notes: body.additional_notes || ''
    };

    fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    }).then(r => console.log('[n8n webhook] Status:', r.status))
      .catch(e => console.warn('[n8n webhook] Failed:', e.message));

    document.getElementById('deal-ref').textContent = `Reference: ${data.deal.submission_id}`;
    dealBtn.disabled = false;
    dealBtn.textContent = 'Submit Deal \u2192';

    // Clear form
    document.querySelectorAll('#screen-deal input, #screen-deal select, #screen-deal textarea').forEach(el => {
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });

    showScreen('screen-deal-success');
  } catch (err) {
    console.error('Deal submission error:', err);
    showAlert('deal-alert', 'error', 'Network error. Please check your connection and try again.');
    dealBtn.disabled = false;
    dealBtn.textContent = 'Submit Deal \u2192';
  }
}

/**
 * Show the dashboard
 */
export async function showDashboard() {
  const authToken = getAuthToken();
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();

  if (!authToken || !currentUser) {
    showScreen('screen-login');
    return;
  }

  // Update header
  const fullName = `${sanitizeHtml(currentUser.first_name)} ${sanitizeHtml(currentUser.last_name)}`;
  document.getElementById('user-name-display').textContent = fullName;
  document.getElementById('user-role-display').textContent = currentRole.toUpperCase();
  const detailNameEl = document.getElementById('detail-user-name');
  const detailRoleEl = document.getElementById('detail-user-role');
  if (detailNameEl) detailNameEl.textContent = fullName;
  if (detailRoleEl) detailRoleEl.textContent = currentRole.toUpperCase();

  // Update sidebar
  const sidebarName = document.getElementById('sidebar-user-name');
  const sidebarRole = document.getElementById('sidebar-role-badge');
  const sidebarAdmin = document.getElementById('sidebar-admin-section');
  if (sidebarName) sidebarName.textContent = fullName;
  if (sidebarRole) sidebarRole.textContent = currentRole.toUpperCase();
  if (sidebarAdmin) sidebarAdmin.style.display = ['rm', 'admin', 'credit', 'compliance'].includes(currentRole) ? 'block' : 'none';

  showScreen('screen-dashboard');
  await loadUserDeals();

  // Check broker onboarding status if needed
  if (currentRole === 'broker') {
    // Lazy import
    import('./onboarding.js').then(m => m.checkBrokerOnboardingStatus?.());
  }
}

/**
 * Load all deals for the current user
 */
export async function loadUserDeals() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals`, {
      method: 'GET'
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Failed to load deals:', data.error);
      return;
    }

    const deals = data.deals || [];

    // Update stats — broker-quality dashboard
    if (deals.length > 0) {
      document.getElementById('stats-container').style.display = 'grid';
      document.getElementById('deals-empty').style.display = 'none';
      document.getElementById('deals-table-container').style.display = 'block';

      const active = deals.filter(d => !['completed', 'declined', 'withdrawn'].includes(d.status) && !['completed', 'declined', 'withdrawn'].includes(d.deal_stage));
      const completed = deals.filter(d => d.status === 'completed' || d.deal_stage === 'completed');
      const declined = deals.filter(d => d.status === 'declined' || d.deal_stage === 'declined');
      const totalPipeline = active.reduce((sum, d) => sum + (Number(d.loan_amount) || 0), 0);
      const awaitingAction = deals.filter(d => ['received', 'info_gathering'].includes(d.deal_stage)).length;

      // Update stat cards with richer data
      const statsContainer = document.getElementById('stats-container');
      statsContainer.innerHTML = `
        <div class="stat-card" style="border-left:3px solid #D4A853;">
          <div class="stat-label">TOTAL PIPELINE</div>
          <div class="stat-value" style="font-family:'Playfair Display',serif;">£${totalPipeline >= 1000000 ? (totalPipeline / 1000000).toFixed(1) + 'm' : formatNumber(totalPipeline)}</div>
          <div style="font-size:11px;color:#94A3B8;margin-top:4px;">${active.length} active deal${active.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="stat-card processing" style="border-left:3px solid #34D399;">
          <div class="stat-label">ACTIVE DEALS</div>
          <div class="stat-value" style="font-family:'Playfair Display',serif;">${active.length}</div>
          <div style="font-size:11px;color:#94A3B8;margin-top:4px;">${awaitingAction ? awaitingAction + ' awaiting action' : 'All progressing'}</div>
        </div>
        <div class="stat-card" style="border-left:3px solid #60A5FA;">
          <div class="stat-label">COMPLETED</div>
          <div class="stat-value" style="font-family:'Playfair Display',serif;">${completed.length}</div>
        </div>
        <div class="stat-card declined" style="border-left:3px solid #F87171;">
          <div class="stat-label">DECLINED</div>
          <div class="stat-value" style="font-family:'Playfair Display',serif;">${declined.length}</div>
        </div>
      `;

      // Stage labels for table
      const stageLabels = {
        received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
        info_gathering: 'Info Gathering', ai_termsheet: 'ITS Issued',
        fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
        bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
        borrower_accepted: 'Accepted', legal_instructed: 'Legal',
        completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
      };

      // Upgrade table headers
      const thead = document.querySelector('#deals-table-container thead tr');
      if (thead) {
        thead.innerHTML = `
          <th>Reference</th>
          <th>Borrower</th>
          <th>Loan Amount</th>
          <th>LTV</th>
          <th>Stage</th>
          <th>Updated</th>
          <th></th>
        `;
      }

      // Populate table with richer rows
      const tbody = document.getElementById('deals-tbody');
      tbody.innerHTML = '';
      deals.forEach(deal => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.onclick = () => import('./deal-detail.js').then(m => m.showDealDetail(deal.submission_id));

        const stage = deal.deal_stage || 'received';
        const stageLabel = stageLabels[stage] || stage;
        const borrower = deal.borrower_name || deal.security_address?.substring(0, 30) || '-';
        const loanStr = deal.loan_amount ? '£' + formatNumber(deal.loan_amount) : '-';
        const ltvStr = deal.ltv_requested ? deal.ltv_requested + '%' : '-';
        const updatedStr = formatDate(deal.updated_at || deal.created_at);

        row.innerHTML = `
          <td><span class="deal-ref">${sanitizeHtml(deal.submission_id.substring(0, 8))}</span></td>
          <td><strong style="color:#F1F5F9;">${sanitizeHtml(borrower)}</strong></td>
          <td style="white-space:nowrap;">${loanStr}</td>
          <td style="text-align:center;">${ltvStr}</td>
          <td><span class="stage-badge stage-${stage}">${sanitizeHtml(stageLabel)}</span></td>
          <td style="font-size:0.85em;">${updatedStr}</td>
          <td><button class="btn btn-small" style="padding:4px 12px;font-size:11px;font-weight:600;background:rgba(212,168,83,0.15);color:#D4A853;border:1px solid rgba(212,168,83,0.3);border-radius:6px;cursor:pointer;" onclick="event.stopPropagation();">View →</button></td>
        `;
        tbody.appendChild(row);
      });
    } else {
      document.getElementById('stats-container').style.display = 'none';
      document.getElementById('deals-empty').style.display = 'block';
      document.getElementById('deals-table-container').style.display = 'none';
    }
  } catch (err) {
    console.error('Error loading deals:', err);
  }
}

/**
 * Export to handle module chaining for window.selectLawFirm
 */
export function selectLawFirm(firm, email, contact) {
  document.getElementById('lawyer-firm').value = firm;
  document.getElementById('lawyer-email').value = email;
  document.getElementById('lawyer-contact').value = contact;
  document.getElementById('law-firms-dropdown').style.display = 'none';
}
