import { API_BASE } from './config.js';
import { showScreen, showToast, formatNumber, formatDate, sanitizeHtml } from './utils.js';
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

  document.getElementById('user-name-display').textContent = `${sanitizeHtml(currentUser.first_name)} ${sanitizeHtml(currentUser.last_name)}`;
  document.getElementById('user-role-display').textContent = currentRole.toUpperCase();

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

  const activeTab = document.getElementById(`tab-${tabName}`);
  if (activeTab) activeTab.classList.add('active');
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
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
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
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
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

  deals.forEach(deal => {
    const row = document.createElement('tr');
    row.onclick = () => {
      setCurrentDealId(deal.submission_id);
      import('./deal-detail.js').then(m => m.showDealDetail(deal.submission_id));
    };
    row.style.cursor = 'pointer';

    const stage = deal.deal_stage || 'received';
    const rmName = deal.rm_first ? `${sanitizeHtml(deal.rm_first)} ${sanitizeHtml(deal.rm_last)}` : '-';
    const creditName = deal.credit_first ? `${sanitizeHtml(deal.credit_first)} ${sanitizeHtml(deal.credit_last)}` : '-';
    const compName = deal.comp_first ? `${sanitizeHtml(deal.comp_first)} ${sanitizeHtml(deal.comp_last)}` : '-';

    row.innerHTML = `
      <td class="pipe-cell"><span class="deal-ref">${sanitizeHtml(deal.submission_id.substring(0, 8))}</span></td>
      <td class="pipe-cell"><span class="deal-address">${sanitizeHtml(deal.security_address || '-')}</span></td>
      <td class="pipe-cell">£${formatNumber(deal.loan_amount || 0)}</td>
      <td class="pipe-cell">${deal.ltv_requested || '-'}%</td>
      <td class="pipe-cell"><span class="pipe-tag">${sanitizeHtml(stageLabels[stage] || stage)}</span></td>
      <td class="pipe-cell"><span class="pipe-role">${sanitizeHtml(rmName)}</span></td>
      <td class="pipe-cell"><span class="pipe-role">${sanitizeHtml(creditName)}</span></td>
      <td class="pipe-cell"><span class="pipe-role">${sanitizeHtml(compName)}</span></td>
      <td class="pipe-cell"><span class="status-badge status-${deal.status}">${sanitizeHtml(deal.status)}</span></td>
      <td class="pipe-cell">${formatDate(deal.created_at)}</td>
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
    const rmMatch = !filterRm || (deal.rm_id && deal.rm_id.toString() === filterRm);
    const searchMatch = !filterSearch ||
      (deal.security_address && deal.security_address.toLowerCase().includes(filterSearch)) ||
      (deal.borrower_name && deal.borrower_name.toLowerCase().includes(filterSearch)) ||
      deal.submission_id.includes(filterSearch);

    return stageMatch && assetMatch && rmMatch && searchMatch;
  });

  const tbody = document.getElementById('admin-deals-tbody');
  if (tbody) {
    const stageLabels = {
      received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
      info_gathering: 'Info Gathering', ai_termsheet: 'AI Termsheet',
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
        <td><span class="role-badge">${sanitizeHtml(user.role.toUpperCase())}</span></td>
        <td>${sanitizeHtml(user.company || '-')}</td>
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

    // Update stat cards
    document.getElementById('stat-total').textContent = stats.total_deals || 0;
    document.getElementById('stat-processing').textContent = stats.processing || 0;
    document.getElementById('stat-completed').textContent = stats.completed || 0;
    document.getElementById('stat-declined').textContent = stats.declined || 0;
  } catch (err) {
    console.error('Error loading stats:', err);
  }
}

/**
 * Create a new internal user (admin only)
 */
export async function createInternalUser() {
  const firstName = document.getElementById('new-user-firstname').value.trim();
  const lastName = document.getElementById('new-user-lastname').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const role = document.getElementById('new-user-role').value;
  const password = document.getElementById('new-user-password').value.trim();

  if (!firstName || !lastName || !email || !role || !password) {
    showToast('Please fill in all fields', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, role, password })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('User created successfully');
      // Clear form
      document.getElementById('new-user-firstname').value = '';
      document.getElementById('new-user-lastname').value = '';
      document.getElementById('new-user-email').value = '';
      document.getElementById('new-user-password').value = '';
      // Reload users list
      await loadAdminUsers();
    } else {
      showToast(data.error || 'Failed to create user', true);
    }
  } catch (err) {
    showToast('Error creating user', true);
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
