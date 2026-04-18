/**
 * Broker Sidebar Command Centre
 * Renders 5 widgets: Onboarding, Pipeline, Quick Actions, Earnings, CRM Clients
 */
import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { getCurrentUser, getCurrentRole } from './state.js';
import { formatNumber, sanitizeHtml } from './utils.js';

let _sidebarData = null;

/**
 * Initialize broker sidebar — call after login/dashboard load
 */
export async function initBrokerSidebar() {
  const role = getCurrentRole();
  const container = document.getElementById('broker-sidebar-widgets');
  if (!container) return;

  // Only show for brokers
  if (role !== 'broker') {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = '<div style="padding:8px 12px;color:#64748B;font-size:11px;">Loading...</div>';

  try {
    // Fetch onboarding + deals + clients in parallel
    const [onbResp, dealsResp, clientsResp] = await Promise.all([
      fetchWithAuth(`${API_BASE}/api/broker/onboarding`, { method: 'GET' }),
      fetchWithAuth(`${API_BASE}/api/deals`, { method: 'GET' }),
      fetchWithAuth(`${API_BASE}/api/broker/clients`, { method: 'GET' })
    ]);

    const onbData = await onbResp.json();
    const dealsData = await dealsResp.json();
    const clientsData = await clientsResp.json();

    _sidebarData = {
      onboarding: onbData.onboarding || {},
      deals: dealsData.deals || [],
      clients: clientsData.clients || []
    };

    renderSidebarWidgets(container);
  } catch (err) {
    console.error('[broker-sidebar] Error:', err);
    container.innerHTML = '<div style="padding:8px 12px;color:#F87171;font-size:11px;">Failed to load</div>';
  }
}

/**
 * Render all 5 widgets
 */
function renderSidebarWidgets(container) {
  const { onboarding, deals, clients } = _sidebarData;

  container.innerHTML = `
    ${renderOnboardingWidget(onboarding)}
    ${renderPipelineWidget(deals)}
    ${renderClientsWidget(clients)}
    ${renderQuickActions()}
    ${renderEarningsWidget(deals)}
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WIDGET 1: ONBOARDING CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════
function renderOnboardingWidget(onb) {
  const checks = [
    { label: 'Personal Details', done: !!(onb.individual_name && onb.date_of_birth) },
    { label: 'ID Document', done: !!onb.passport_doc_id },
    { label: 'Proof of Address', done: !!onb.proof_of_address_doc_id },
    { label: 'Bank Details', done: !!(onb.bank_name && onb.bank_sort_code && onb.bank_account_no) },
    { label: 'Company Details', done: onb.is_company ? !!(onb.company_name && onb.company_number && onb.incorporation_doc_id) : true }
  ];

  const displayChecks = onb.is_company === false ? checks.filter(c => c.label !== 'Company Details') : checks;
  const completed = displayChecks.filter(c => c.done).length;
  const total = displayChecks.length;
  const pct = Math.round((completed / total) * 100);

  const statusColors = {
    pending: { bg: '#FEF3C7', text: '#92400E', label: 'Not Started' },
    submitted: { bg: '#DBEAFE', text: '#1E40AF', label: 'Submitted' },
    under_review: { bg: '#E0E7FF', text: '#3730A3', label: 'Under Review' },
    approved: { bg: '#D1FAE5', text: '#065F46', label: 'Approved' },
    rejected: { bg: '#FEE2E2', text: '#991B1B', label: 'Action Required' }
  };
  const status = statusColors[onb.status] || statusColors.pending;

  if (onb.status === 'approved') {
    return `
      <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="font-size:14px;">✓</span>
          <span style="font-size:11px;font-weight:600;color:#34D399;text-transform:uppercase;letter-spacing:0.5px;">Verified Broker</span>
        </div>
        <div style="font-size:10px;color:#64748B;">KYC approved — you can submit deals</div>
      </div>
    `;
  }

  return `
    <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748B;">Onboarding</span>
        <span style="font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;background:${status.bg};color:${status.text};">${status.label}</span>
      </div>
      <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;margin-bottom:8px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${pct === 100 ? '#34D399' : '#D4A853'};border-radius:2px;transition:width .3s;"></div>
      </div>
      <div style="font-size:10px;color:#94A3B8;margin-bottom:8px;">${completed}/${total} completed</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${displayChecks.map(c => `
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;${c.done ? 'background:#34D399;color:#fff;' : 'background:rgba(255,255,255,0.06);color:#475569;border:1px solid #334155;'}">${c.done ? '✓' : ''}</span>
            <span style="font-size:11px;color:${c.done ? '#94A3B8' : '#E2E8F0'};${c.done ? 'text-decoration:line-through;opacity:0.7;' : ''}">${c.label}</span>
          </div>
        `).join('')}
      </div>
      ${pct < 100 ? `<button onclick="import('./onboarding.js').then(m => m.openOnboardingModal && m.openOnboardingModal())" style="margin-top:10px;width:100%;padding:6px;border:none;border-radius:6px;background:rgba(212,168,83,0.15);color:#D4A853;font-size:11px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:background .15s;" onmouseover="this.style.background='rgba(212,168,83,0.25)'" onmouseout="this.style.background='rgba(212,168,83,0.15)'">Complete Setup →</button>` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WIDGET 2: DEAL PIPELINE
// ═══════════════════════════════════════════════════════════════════════════
function renderPipelineWidget(deals) {
  const active = deals.filter(d => !['completed', 'declined', 'withdrawn', 'draft'].includes(d.deal_stage));
  const drafts = deals.filter(d => d.deal_stage === 'draft');
  const completed = deals.filter(d => d.deal_stage === 'completed' || d.status === 'completed');
  const totalPipeline = active.reduce((sum, d) => sum + (Number(d.loan_amount) || 0), 0);

  const stages = [
    { label: 'DIP', count: deals.filter(d => ['received', 'assigned', 'info_gathering', 'dip_issued'].includes(d.deal_stage)).length, color: '#60A5FA' },
    { label: 'Term Sheet', count: deals.filter(d => ['ai_termsheet', 'fee_pending', 'fee_paid'].includes(d.deal_stage)).length, color: '#D4A853' },
    { label: 'Underwriting', count: deals.filter(d => ['underwriting', 'bank_submitted', 'bank_approved'].includes(d.deal_stage)).length, color: '#A78BFA' },
    { label: 'Legal/Complete', count: deals.filter(d => ['borrower_accepted', 'legal_instructed', 'completed'].includes(d.deal_stage)).length, color: '#34D399' }
  ];

  return `
    <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748B;margin-bottom:10px;">Pipeline</div>
      <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:4px;">
        <span style="font-size:20px;font-weight:700;color:#F1F5F9;font-family:'Playfair Display',serif;">£${totalPipeline >= 1000000 ? (totalPipeline / 1000000).toFixed(1) + 'm' : formatNumber(totalPipeline)}</span>
      </div>
      <div style="font-size:10px;color:#64748B;margin-bottom:12px;">${active.length} active · ${drafts.length} draft${drafts.length !== 1 ? 's' : ''} · ${completed.length} completed</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${stages.filter(s => s.count > 0).map(s => `
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:6px;height:6px;border-radius:50%;background:${s.color};flex-shrink:0;"></div>
            <span style="font-size:11px;color:#94A3B8;flex:1;">${s.label}</span>
            <span style="font-size:11px;font-weight:600;color:#E2E8F0;">${s.count}</span>
          </div>
        `).join('')}
        ${stages.every(s => s.count === 0) ? '<div style="font-size:11px;color:#475569;font-style:italic;">No active deals yet</div>' : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WIDGET 3: CRM CLIENTS
// ═══════════════════════════════════════════════════════════════════════════
function renderClientsWidget(clients) {
  const stageLabels = {
    draft: 'Draft', received: 'Received', assigned: 'Assigned', info_gathering: 'Info Gathering',
    dip_issued: 'DIP Issued', ai_termsheet: 'Term Sheet', fee_pending: 'Fee Pending',
    fee_paid: 'Fee Paid', underwriting: 'UW', bank_submitted: 'Bank Sub',
    bank_approved: 'Bank OK', borrower_accepted: 'Accepted', legal_instructed: 'Legal',
    completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
  };

  const stageColors = {
    draft: '#64748B', received: '#60A5FA', assigned: '#60A5FA', info_gathering: '#60A5FA',
    dip_issued: '#60A5FA', ai_termsheet: '#D4A853', fee_pending: '#D4A853',
    fee_paid: '#D4A853', underwriting: '#A78BFA', bank_submitted: '#A78BFA',
    bank_approved: '#A78BFA', borrower_accepted: '#34D399', legal_instructed: '#34D399',
    completed: '#34D399', declined: '#F87171', withdrawn: '#64748B'
  };

  // Initials from name
  const initials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
  };

  // Avatar background based on name hash
  const avatarColor = (name) => {
    const colors = ['#D4A853', '#60A5FA', '#A78BFA', '#34D399', '#F472B6', '#FB923C'];
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  return `
    <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748B;">My Clients</span>
        <span style="font-size:10px;font-weight:600;color:#94A3B8;">${clients.length}</span>
      </div>
      ${clients.length === 0 ? `
        <div style="font-size:11px;color:#475569;font-style:italic;text-align:center;padding:8px 0;">Your borrowers will appear here after you submit deals</div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:2px;" id="crm-client-list">
          ${clients.slice(0, 4).map((c, idx) => {
            const latestDeal = (c.deals && c.deals[0]) || {};
            const latestStage = latestDeal.deal_stage || 'draft';
            return `
              <div onclick="window._toggleClientExpand(${idx})" style="cursor:pointer;border-radius:6px;transition:background .15s;padding:6px 8px;" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="if(!this.classList.contains('expanded'))this.style.background='none'">
                <!-- Collapsed: avatar + name + latest stage -->
                <div style="display:flex;align-items:center;gap:8px;">
                  <div style="width:26px;height:26px;border-radius:50%;background:${avatarColor(c.client_name)};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#0B1120;flex-shrink:0;">${initials(c.client_name)}</div>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:11px;font-weight:500;color:#E2E8F0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sanitizeHtml(c.client_name)}</div>
                    <div style="display:flex;align-items:center;gap:4px;margin-top:1px;">
                      <span style="font-size:9px;color:${stageColors[latestStage] || '#64748B'};">${stageLabels[latestStage] || latestStage}</span>
                      <span style="font-size:9px;color:#475569;">· ${c.deal_count} deal${c.deal_count != 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <span id="crm-chevron-${idx}" style="font-size:10px;color:#475569;transition:transform .2s;">▸</span>
                </div>
                <!-- Expanded detail (hidden by default) -->
                <div id="crm-detail-${idx}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);">
                  ${c.email ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-size:10px;color:#475569;width:12px;">✉</span><span style="font-size:10px;color:#94A3B8;word-break:break-all;">${sanitizeHtml(c.email)}</span></div>` : ''}
                  ${c.phone ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-size:10px;color:#475569;width:12px;">☎</span><span style="font-size:10px;color:#94A3B8;">${sanitizeHtml(c.phone)}</span></div>` : ''}
                  ${c.company_name ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-size:10px;color:#475569;width:12px;">◆</span><span style="font-size:10px;color:#94A3B8;">${sanitizeHtml(c.company_name)}</span></div>` : ''}
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <span style="font-size:10px;color:#475569;width:12px;">£</span>
                    <span style="font-size:10px;color:#94A3B8;">£${formatNumber(Number(c.total_loan_value) || 0)} total pipeline</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:10px;color:#475569;width:12px;">📄</span>
                    <span style="font-size:10px;color:#94A3B8;">${c.total_documents || 0} document${(c.total_documents || 0) != 1 ? 's' : ''} uploaded</span>
                  </div>
                  <!-- Per-deal mini list -->
                  ${(c.deals || []).length > 1 ? `
                    <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.03);">
                      <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Deals</div>
                      ${(c.deals || []).slice(0, 3).map(d => `
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
                          <span style="font-size:10px;color:#94A3B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;">${sanitizeHtml((d.security_address || '').split(',')[0] || 'Deal')}</span>
                          <span style="font-size:9px;font-weight:500;color:${stageColors[d.deal_stage] || '#64748B'};">${stageLabels[d.deal_stage] || d.deal_stage}</span>
                        </div>
                      `).join('')}
                      ${(c.deals || []).length > 3 ? `<div style="font-size:9px;color:#475569;font-style:italic;">+${(c.deals || []).length - 3} more</div>` : ''}
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
          }).join('')}
          ${clients.length > 4 ? `
            <div style="padding:4px 8px;font-size:10px;color:#64748B;font-style:italic;">${clients.length - 4} more client${clients.length - 4 !== 1 ? 's' : ''}...</div>
          ` : ''}
        </div>
      `}
    </div>
  `;
}

// Toggle expand/collapse for CRM client cards
window._toggleClientExpand = function(idx) {
  const detail = document.getElementById(`crm-detail-${idx}`);
  const chevron = document.getElementById(`crm-chevron-${idx}`);
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
};

// ═══════════════════════════════════════════════════════════════════════════
//  WIDGET 4: QUICK ACTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderQuickActions() {
  return `
    <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748B;margin-bottom:10px;">Quick Actions</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <button onclick="window.showDealForm && window.showDealForm()" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:6px;background:rgba(212,168,83,0.12);color:#D4A853;font-size:11px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;text-align:left;transition:background .15s;" onmouseover="this.style.background='rgba(212,168,83,0.22)'" onmouseout="this.style.background='rgba(212,168,83,0.12)'">
          <span style="font-size:14px;">+</span> New Deal Submission
        </button>
        <button onclick="window.showDashboard && window.showDashboard()" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:6px;background:rgba(96,165,250,0.08);color:#60A5FA;font-size:11px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;text-align:left;transition:background .15s;" onmouseover="this.style.background='rgba(96,165,250,0.18)'" onmouseout="this.style.background='rgba(96,165,250,0.08)'">
          <span style="font-size:13px;">⟳</span> View My Deals
        </button>
        <button onclick="window.open('mailto:portal@daksfirst.com','_blank')" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:6px;background:rgba(167,139,250,0.08);color:#A78BFA;font-size:11px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;text-align:left;transition:background .15s;" onmouseover="this.style.background='rgba(167,139,250,0.18)'" onmouseout="this.style.background='rgba(167,139,250,0.08)'">
          <span style="font-size:13px;">✉</span> Contact Your RM
        </button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WIDGET 5: EARNINGS TRACKER
// ═══════════════════════════════════════════════════════════════════════════
function renderEarningsWidget(deals) {
  const PROC_FEE_PCT = 0.01;

  const completed = deals.filter(d => d.deal_stage === 'completed' || d.status === 'completed');
  const active = deals.filter(d => !['completed', 'declined', 'withdrawn', 'draft'].includes(d.deal_stage));

  const earned = completed.reduce((sum, d) => sum + ((Number(d.loan_amount) || 0) * PROC_FEE_PCT), 0);
  const pending = active.reduce((sum, d) => sum + ((Number(d.loan_amount) || 0) * PROC_FEE_PCT), 0);
  const total = earned + pending;

  const target = Math.max(50000, Math.ceil(total / 50000) * 50000);
  const progressPct = total > 0 ? Math.min(100, Math.round((total / target) * 100)) : 0;

  return `
    <div class="sidebar-widget" style="padding:12px;margin:0 8px 8px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#64748B;">Earnings</span>
        <span style="font-size:9px;color:#475569;">Est. @ 1% proc</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <div style="flex:1;padding:8px;border-radius:6px;background:rgba(52,211,153,0.08);text-align:center;">
          <div style="font-size:9px;color:#34D399;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Earned</div>
          <div style="font-size:14px;font-weight:700;color:#34D399;">£${formatNumber(Math.round(earned))}</div>
        </div>
        <div style="flex:1;padding:8px;border-radius:6px;background:rgba(212,168,83,0.08);text-align:center;">
          <div style="font-size:9px;color:#D4A853;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Pipeline</div>
          <div style="font-size:14px;font-weight:700;color:#D4A853;">£${formatNumber(Math.round(pending))}</div>
        </div>
      </div>
      ${total > 0 ? `
        <div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:10px;color:#64748B;">Progress to £${formatNumber(target)}</span>
          <span style="font-size:10px;font-weight:600;color:#E2E8F0;">${progressPct}%</span>
        </div>
        <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${progressPct}%;background:linear-gradient(90deg,#D4A853,#34D399);border-radius:2px;transition:width .3s;"></div>
        </div>
      ` : `
        <div style="font-size:11px;color:#475569;font-style:italic;text-align:center;">Submit your first deal to start tracking</div>
      `}
    </div>
  `;
}

/**
 * Refresh sidebar data (call after deal changes)
 */
export async function refreshBrokerSidebar() {
  await initBrokerSidebar();
}
