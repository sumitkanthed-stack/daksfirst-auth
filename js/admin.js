import { API_BASE } from './config.js';
import { showScreen, showToast, formatNumber, formatPct, formatDate, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentUser, getCurrentRole, setAllAdminDeals, getAllAdminDeals, setCurrentDealId } from './state.js';

/**
 * Show admin panel
 */
export async function showAdminPanel() {
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();

  if (!currentUser) {
    showScreen('screen-login');
    return;
  }

  const nameEl = document.getElementById('admin-user-name') || document.getElementById('user-name-display');
  const roleEl = document.getElementById('admin-role-badge') || document.getElementById('user-role-display');
  if (nameEl) nameEl.textContent = `${sanitizeHtml(currentUser.first_name)} ${sanitizeHtml(currentUser.last_name)}`;
  if (roleEl) roleEl.textContent = currentRole.toUpperCase();

  showScreen('screen-admin');

  // Load initial admin data
  if (currentRole === 'admin') {
    await loadAdminDeals();
    await loadAdminStats();
  } else {
    await loadStaffDeals();
  }
}

/**
 * Switch admin tabs
 */
export function switchAdminTab(tabName) {
  document.querySelectorAll('.admin-nav-item').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));

  const activeBtn = document.querySelector(`.admin-nav-item[onclick*="${tabName}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const activeTab = document.getElementById(`admin-${tabName}`) || document.getElementById(`tab-${tabName}`);
  if (activeTab) activeTab.classList.add('active');

  // Load data for specific tabs
  if (tabName === 'clients') loadAdminUsers();
  if (tabName === 'delegated-authority') loadDelegatedAuthority();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Delegated Authority admin config (2026-04-20, DA Session 2b)
//  Reads from GET /api/admin/config/delegated-authority and fills the form.
//  Save reads the form and PUTs the delta back.
// ═══════════════════════════════════════════════════════════════════════════
export async function loadDelegatedAuthority() {
  const status = document.getElementById('da-save-status');
  if (status) { status.textContent = 'Loading...'; status.style.color = '#94A3B8'; }
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/config/delegated-authority`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast('Failed to load config: ' + (body.error || res.statusText), 'error');
      if (status) { status.textContent = ''; }
      return;
    }
    const data = await res.json();
    const c = data.config || {};

    // Populate form
    const enabledEl = document.getElementById('da-enabled');
    if (enabledEl) enabledEl.checked = !!c.auto_approve_enabled;
    _updateEnabledSlider();
    const maxLoanEl = document.getElementById('da-max-loan');
    if (maxLoanEl) maxLoanEl.value = c.auto_approve_max_loan != null ? Number(c.auto_approve_max_loan) : '';
    const maxLtvEl = document.getElementById('da-max-ltv');
    if (maxLtvEl) maxLtvEl.value = c.auto_approve_max_ltv_pct != null ? Number(c.auto_approve_max_ltv_pct) : '';

    const assetTypes = Array.isArray(c.auto_approve_asset_types) ? c.auto_approve_asset_types.map(t => String(t).toLowerCase()) : [];
    document.querySelectorAll('.da-asset-type').forEach(cb => {
      cb.checked = assetTypes.includes(cb.value.toLowerCase());
    });

    const lastUpd = document.getElementById('da-last-updated');
    if (lastUpd) {
      const when = c.updated_at ? new Date(c.updated_at).toLocaleString('en-GB') : '—';
      lastUpd.textContent = `Last updated: ${when}${c.updated_by ? ` by user #${c.updated_by}` : ''}`;
    }

    if (status) { status.textContent = ''; }
  } catch (err) {
    showToast('Failed to load config: ' + err.message, 'error');
    if (status) { status.textContent = ''; }
  }
}

// Simple visual feedback for the toggle (click on the slider span)
function _updateEnabledSlider() {
  const cb = document.getElementById('da-enabled');
  const slider = document.getElementById('da-enabled-slider');
  if (!cb || !slider) return;
  const inner = slider.querySelector('span');
  if (cb.checked) {
    slider.style.background = '#34D399';
    if (inner) inner.style.left = '25px';
  } else {
    slider.style.background = '#334155';
    if (inner) inner.style.left = '3px';
  }
  // Hook a click handler on the slider (once)
  if (!slider.__hooked) {
    slider.addEventListener('click', () => {
      cb.checked = !cb.checked;
      _updateEnabledSlider();
    });
    slider.__hooked = true;
  }
}

export async function saveDelegatedAuthority() {
  const status = document.getElementById('da-save-status');
  if (status) { status.textContent = 'Saving...'; status.style.color = '#D4A853'; }

  const enabledEl = document.getElementById('da-enabled');
  const maxLoanEl = document.getElementById('da-max-loan');
  const maxLtvEl = document.getElementById('da-max-ltv');
  const assetCheckboxes = Array.from(document.querySelectorAll('.da-asset-type'));

  const body = {
    auto_approve_enabled: !!enabledEl?.checked,
    auto_approve_max_loan: Number(maxLoanEl?.value),
    auto_approve_max_ltv_pct: Number(maxLtvEl?.value),
    auto_approve_asset_types: assetCheckboxes.filter(cb => cb.checked).map(cb => cb.value)
  };

  // Client-side sanity — match server validation so the user gets faster feedback
  if (!isFinite(body.auto_approve_max_loan) || body.auto_approve_max_loan <= 0) {
    if (status) { status.textContent = '✗ Max loan must be a positive number'; status.style.color = '#F87171'; }
    return;
  }
  if (!isFinite(body.auto_approve_max_ltv_pct) || body.auto_approve_max_ltv_pct <= 0 || body.auto_approve_max_ltv_pct > 100) {
    if (status) { status.textContent = '✗ Max LTV must be between 0 and 100'; status.style.color = '#F87171'; }
    return;
  }
  if (body.auto_approve_enabled && body.auto_approve_asset_types.length === 0) {
    if (status) { status.textContent = '✗ Select at least one asset type (or disable auto-routing)'; status.style.color = '#F87171'; }
    return;
  }

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/admin/config/delegated-authority`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (status) { status.textContent = '✗ ' + (data.error || 'Save failed'); status.style.color = '#F87171'; }
      return;
    }
    showToast('Auto-routing config saved', 'success');
    if (status) { status.textContent = '✓ Saved'; status.style.color = '#34D399'; }
    // Refresh to pick up server-side updated_at
    await loadDelegatedAuthority();
  } catch (err) {
    if (status) { status.textContent = '✗ ' + err.message; status.style.color = '#F87171'; }
  }
}

// Register as globals so onclick handlers in index.html can reach them
if (typeof window !== 'undefined') {
  window.loadDelegatedAuthority = loadDelegatedAuthority;
  window.saveDelegatedAuthority = saveDelegatedAuthority;
}

/**
 * Load all deals for admin view (pipeline)
 */
export async function loadAdminDeals() {
  const currentRole = getCurrentRole();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Failed to load deals:', data.error);
      return;
    }

    const deals = data.deals || [];
    setAllAdminDeals(deals);

    // Render pipeline
    const tbody = document.getElementById('admin-deals-tbody');
    if (!tbody) return;

    const stageLabels = {
      draft: 'Draft', received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };

    renderPipelineRows(deals, tbody, stageLabels);
  } catch (err) {
    console.error('Error loading admin deals:', err);
  }
}

/**
 * Load staff deals (for non-admin internal users)
 */
export async function loadStaffDeals() {
  const currentUser = getCurrentUser();
  const currentRole = getCurrentRole();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/staff/deals`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Failed to load staff deals:', data.error);
      return;
    }

    const deals = data.deals || [];
    setAllAdminDeals(deals);

    const tbody = document.getElementById('admin-deals-tbody');
    if (!tbody) return;

    const stageLabels = {
      draft: 'Draft', received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };

    renderPipelineRows(deals, tbody, stageLabels);
  } catch (err) {
    console.error('Error loading staff deals:', err);
  }
}

/**
 * Render pipeline table rows
 */
export function renderPipelineRows(deals, tbody, stageLabels) {
  tbody.innerHTML = '';

  const countEl = document.getElementById('admin-deals-count');
  if (countEl) countEl.textContent = `${deals.length} deal${deals.length !== 1 ? 's' : ''}`;

  deals.forEach(deal => {
    const row = document.createElement('tr');
    row.style.cursor = 'pointer';
    row.onclick = () => {
      setCurrentDealId(deal.submission_id);
      import('./deal-detail.js').then(m => m.showDealDetail(deal.submission_id));
    };

    // Borrower
    const borrowerDisplay = deal.borrower_name
      ? `<strong>${sanitizeHtml(deal.borrower_name)}</strong>${deal.borrower_company ? `<br><span class="pipe-sub">${sanitizeHtml(deal.borrower_company)}</span>` : ''}${deal.borrower_type ? `<br><span class="pipe-tag">${sanitizeHtml(deal.borrower_type.toUpperCase())}</span>` : ''}`
      : '<span class="pipe-empty">-</span>';

    // Broker
    const brokerDisplay = deal.broker_name
      ? `<strong>${sanitizeHtml(deal.broker_name)}</strong>${deal.broker_company ? `<br><span class="pipe-sub">${sanitizeHtml(deal.broker_company)}</span>` : ''}`
      : '<span class="pipe-empty">-</span>';

    // Security
    const address = deal.security_address || '-';
    const shortAddr = address.length > 35 ? sanitizeHtml(address.substring(0, 35)) + '...' : sanitizeHtml(address);
    const assetTypes = { residential: 'Resi', commercial: 'Comm', mixed_use: 'Mixed', land: 'Land', hmo: 'HMO', development: 'Dev', flat: 'Flat', mufb: 'MUFB' };
    const assetLabel = assetTypes[deal.asset_type] || deal.asset_type || '';
    const securityDisplay = `<span title="${sanitizeHtml(address)}">${shortAddr}</span>${deal.security_postcode || assetLabel ? `<br><span class="pipe-sub">${sanitizeHtml(deal.security_postcode || '')}${deal.security_postcode && assetLabel ? ' · ' : ''}${assetLabel ? '<span class="pipe-tag">' + sanitizeHtml(assetLabel) + '</span>' : ''}</span>` : ''}`;

    // Notional (loan amount + current value)
    const loanAmt = deal.loan_amount ? `£${formatNumber(deal.loan_amount)}` : '-';
    const valuation = deal.current_value ? `Val: £${formatNumber(deal.current_value)}` : '';
    const notionalDisplay = `<strong>${loanAmt}</strong>${valuation ? `<br><span class="pipe-sub">${valuation}</span>` : ''}`;

    // LTV (2 decimal places)
    let ltvDisplay = '-';
    if (deal.ltv_requested) {
      ltvDisplay = `<strong>${formatPct(deal.ltv_requested)}%</strong>`;
    } else if (deal.loan_amount && deal.current_value && Number(deal.current_value) > 0) {
      const calcLtv = (Number(deal.loan_amount) / Number(deal.current_value)) * 100;
      ltvDisplay = `<strong>${formatPct(calcLtv)}%</strong><br><span class="pipe-sub">calc</span>`;
    }

    // Term
    const termDisplay = deal.term_months ? `${deal.term_months}m` : '-';

    // Drawdown
    const drawdownDisplay = deal.drawdown_date ? formatDate(deal.drawdown_date) : '<span class="pipe-empty">TBC</span>';

    // Stage
    const stage = deal.deal_stage || 'received';
    const stageDisplay = `<span class="stage-badge stage-${stage}">${sanitizeHtml(stageLabels[stage] || stage)}</span>`;

    // Team (RM, Credit, Compliance)
    const rmName = deal.rm_first ? `${sanitizeHtml(deal.rm_first)} ${sanitizeHtml(deal.rm_last)}` : null;
    const creditName = deal.credit_first ? `${sanitizeHtml(deal.credit_first)} ${sanitizeHtml(deal.credit_last)}` : null;
    const compName = deal.comp_first ? `${sanitizeHtml(deal.comp_first)} ${sanitizeHtml(deal.comp_last)}` : null;
    let teamHtml = '';
    if (rmName) {
      teamHtml += `<span class="pipe-role">RM:</span> ${rmName}`;
    } else {
      teamHtml += '<span style="color:#F87171;font-weight:600;">No RM</span>';
    }
    if (creditName) teamHtml += `<br><span class="pipe-role">CR:</span> ${creditName}`;
    if (compName) teamHtml += `<br><span class="pipe-role">CO:</span> ${compName}`;

    // Updated
    const updatedDisplay = deal.updated_at ? formatDate(deal.updated_at) : formatDate(deal.created_at);

    row.innerHTML = `
      <td><span class="deal-ref">${sanitizeHtml(deal.submission_id.substring(0, 8))}</span></td>
      <td class="pipe-cell">${borrowerDisplay}</td>
      <td class="pipe-cell">${brokerDisplay}</td>
      <td class="pipe-cell">${securityDisplay}</td>
      <td class="pipe-cell" style="white-space:nowrap;">${notionalDisplay}</td>
      <td class="pipe-cell" style="text-align:center;">${ltvDisplay}</td>
      <td class="pipe-cell" style="text-align:center;">${termDisplay}</td>
      <td class="pipe-cell" style="white-space:nowrap;">${drawdownDisplay}</td>
      <td class="pipe-cell">${stageDisplay}</td>
      <td class="pipe-cell">${teamHtml}</td>
      <td class="pipe-cell" style="white-space:nowrap;font-size:0.85em;">${updatedDisplay}</td>
    `;
    tbody.appendChild(row);
  });
}

/**
 * Update admin deals filter (by stage, status, RM, search)
 */
export function updateAdminDealsFilter() {
  const allDeals = getAllAdminDeals();
  const filterStage = document.getElementById('admin-filter-stage').value;
  const filterAsset = document.getElementById('admin-filter-asset').value;
  const filterRm = document.getElementById('admin-filter-rm').value;
  const filterSearch = document.getElementById('admin-filter-search').value.toLowerCase();

  const filtered = allDeals.filter(deal => {
    const stage = deal.deal_stage || 'received';
    const stageMatch = !filterStage || stage === filterStage;
    const assetMatch = !filterAsset || deal.asset_type === filterAsset;
    const rmMatch = !filterRm || (filterRm === 'unassigned' ? !deal.rm_first : (deal.assigned_rm && deal.assigned_rm.toString() === filterRm));
    let searchMatch = true;
    if (filterSearch) {
      const searchable = [
        deal.submission_id, deal.borrower_name, deal.borrower_company,
        deal.broker_name, deal.broker_company, deal.security_address,
        deal.security_postcode, deal.loan_purpose
      ].filter(Boolean).join(' ').toLowerCase();
      searchMatch = searchable.includes(filterSearch);
    }

    return stageMatch && assetMatch && rmMatch && searchMatch;
  });

  const tbody = document.getElementById('admin-deals-tbody');
  if (tbody) {
    const stageLabels = {
      draft: 'Draft', received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
      fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
      bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
      borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
      completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
    };
    renderPipelineRows(filtered, tbody, stageLabels);
  }
}

/**
 * Load admin users for management
 */
export async function loadAdminUsers() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/users`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Failed to load users:', data.error);
      return;
    }

    const users = data.users || [];
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    users.forEach(user => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${sanitizeHtml(user.first_name)} ${sanitizeHtml(user.last_name)}</td>
        <td>${sanitizeHtml(user.email)}</td>
        <td>${sanitizeHtml(user.company || 'N/A')}</td>
        <td><span class="role-badge">${sanitizeHtml(user.role)}</span></td>
        <td>${sanitizeHtml(user.fca_number || user.company_number || '-')}</td>
        <td>${user.deals_count || 0}</td>
        <td>${formatDate(user.created_at)}</td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading users:', err);
  }
}

/**
 * Load admin stats
 */
export async function loadAdminStats() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/stats`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (!resp.ok) return;

    const stats = data.stats || {};

    // Update stat cards (try both old and new IDs)
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('analytics-total-deals', stats.total_deals || 0);
    setEl('analytics-approval-rate', stats.approval_rate ? formatPct(stats.approval_rate) + '%' : '0.00%');
    setEl('analytics-avg-ltv', stats.avg_ltv ? formatPct(stats.avg_ltv) + '%' : '0.00%');
    setEl('stat-total', stats.total_deals || 0);
    setEl('stat-processing', stats.processing || 0);
    setEl('stat-completed', stats.completed || 0);
    setEl('stat-declined', stats.declined || 0);
  } catch (err) {
    console.error('Error loading stats:', err);
  }
}

/**
 * Create a new internal user (admin only)
 */
export async function createInternalUser() {
  const firstName = document.getElementById('cu-first-name')?.value.trim();
  const lastName = document.getElementById('cu-last-name')?.value.trim();
  const email = document.getElementById('cu-email')?.value.trim();
  const role = document.getElementById('cu-role')?.value;
  const phone = document.getElementById('cu-phone')?.value.trim();
  const password = document.getElementById('cu-password')?.value.trim();

  if (!firstName || !lastName || !email || !role || !password) {
    showToast('Please fill in all required fields', true);
    return;
  }

  const btn = document.getElementById('cu-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, role, phone, password })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('User created successfully');
      // Show success message
      const successEl = document.getElementById('cu-success');
      const detailEl = document.getElementById('cu-success-detail');
      if (successEl) successEl.style.display = 'block';
      if (detailEl) detailEl.textContent = `${firstName} ${lastName} (${role}) — ${email}`;
      // Clear form
      document.getElementById('cu-first-name').value = '';
      document.getElementById('cu-last-name').value = '';
      document.getElementById('cu-email').value = '';
      document.getElementById('cu-phone').value = '';
      document.getElementById('cu-password').value = '';
      // Reload users list
      await loadAdminUsers();
    } else {
      showToast(data.error || 'Failed to create user', true);
    }
  } catch (err) {
    showToast('Error creating user', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
  }
}

/**
 * Populate RM filter dropdown
 */
export function populateRmFilter(deals) {
  const rms = new Map();
  deals.forEach(d => {
    if (d.rm_id && d.rm_first) {
      rms.set(d.rm_id, `${d.rm_first} ${d.rm_last}`);
    }
  });

  const select = document.getElementById('admin-filter-rm');
  if (select) {
    const current = select.value;
    select.innerHTML = '<option value="">All RMs</option>';
    rms.forEach((name, id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      select.appendChild(opt);
    });
    select.value = current;
  }
}
