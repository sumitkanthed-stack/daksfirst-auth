/**
 * deal-sections.js — Vertical section stack for deal detail view
 * Role-gated sections: Snapshot, Matrix, Doc Repo, Parser, Notes, Analysis, Fee, Funding, Admin
 */
import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { getCurrentRole, getCurrentUser } from './state.js';
import { showToast, sanitizeHtml, formatNumber, formatPct, formatDate } from './utils.js';

// ═══════════════════════════════════════════════════════════════
// ROLE GATING — show/hide sections based on current user role
// ═══════════════════════════════════════════════════════════════
export function applyRoleGating(role) {
  // Map compliance to funding view (funding view = compliance + admin master view)
  const effectiveRole = role === 'compliance' ? 'compliance' : role;

  document.querySelectorAll('.deal-section').forEach(section => {
    const allowedRoles = (section.dataset.roles || '').split(',').map(r => r.trim());
    if (allowedRoles.includes(effectiveRole)) {
      section.classList.remove('hidden-section');
    } else {
      section.classList.add('hidden-section');
    }
  });

  // Admin-only blocks within sections
  const feeAlloc = document.getElementById('fee-allocation-block');
  if (feeAlloc) feeAlloc.style.display = role === 'admin' ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// SECTION TOGGLE
// ═══════════════════════════════════════════════════════════════
window.toggleDealSection = function(sectionId) {
  const body = document.getElementById(`body-${sectionId}`);
  const chevron = document.getElementById(`chev-${sectionId}`);
  if (!body) return;
  const isCollapsed = body.classList.contains('collapsed');
  if (isCollapsed) {
    body.classList.remove('collapsed');
    if (chevron) chevron.classList.add('open');
  } else {
    body.classList.add('collapsed');
    if (chevron) chevron.classList.remove('open');
  }
};

// ═══════════════════════════════════════════════════════════════
// SNAPSHOT — Populate deal summary card
// ═══════════════════════════════════════════════════════════════
export function renderSnapshot(deal) {
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? '£' + num(v).toLocaleString() : '-';
  const fmtPctVal = (v) => num(v) ? num(v).toFixed(1) + '%' : '-';

  // Address
  const addrEl = document.getElementById('detail-property-address');
  if (addrEl) addrEl.textContent = sanitizeHtml(deal.security_address || 'N/A');

  // Stage badge
  const stageLabels = {
    received: 'Received', assigned: 'Assigned', dip_issued: 'DIP Issued',
    info_gathering: 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
    fee_pending: 'Fee Pending', fee_paid: 'Fee Paid', underwriting: 'Underwriting',
    bank_submitted: 'Bank Submitted', bank_approved: 'Bank Approved',
    borrower_accepted: 'Borrower Accepted', legal_instructed: 'Legal Instructed',
    completed: 'Completed', declined: 'Declined', withdrawn: 'Withdrawn'
  };
  const stage = deal.deal_stage || 'received';
  const stageEl = document.getElementById('detail-stage-badge');
  if (stageEl) {
    stageEl.textContent = stageLabels[stage] || stage;
    stageEl.className = 'stage-badge stage-' + stage;
    stageEl.style.cssText = 'padding:4px 12px;border-radius:14px;font-size:11px;font-weight:700;';
  }

  // Status badge
  const statusEl = document.getElementById('detail-status-badge');
  if (statusEl) {
    statusEl.className = 'status-badge status-' + deal.status;
    statusEl.style.cssText = 'padding:4px 12px;border-radius:14px;font-size:11px;font-weight:700;';
    statusEl.textContent = deal.status ? deal.status.charAt(0).toUpperCase() + deal.status.slice(1) : 'Active';
  }

  // Calculate loan & LTV
  const dVal = num(deal.current_value);
  const dPurchase = num(deal.purchase_price);
  const dRefurb = num(deal.refurb_cost);
  let dLoan = num(deal.loan_amount);
  let dLtv = num(deal.ltv_requested);

  if (!dLoan && (dVal || dPurchase)) {
    const maxLtv = dVal ? dVal * 0.75 : Infinity;
    const totalCost = dPurchase ? dPurchase + dRefurb : Infinity;
    const maxLtc = totalCost < Infinity ? totalCost * 0.90 : Infinity;
    const calc = Math.min(maxLtv, maxLtc);
    if (calc < Infinity) dLoan = Math.round(calc);
  }
  if (!dLtv && dLoan && dVal && dVal > 0) {
    dLtv = Math.round((dLoan / dVal) * 100 * 10) / 10;
  }

  // Snapshot grid cells
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('snap-loan', dLoan ? fmtMoney(dLoan) : '-');
  set('snap-ltv', dLtv ? fmtPctVal(dLtv) : '-');

  // Color LTV based on threshold
  const ltvEl = document.getElementById('snap-ltv');
  if (ltvEl && dLtv) {
    ltvEl.style.color = dLtv > 75 ? '#dc2626' : dLtv > 70 ? '#f59e0b' : '#059669';
  }

  set('snap-value', dVal ? fmtMoney(dVal) : '-');
  set('snap-term', deal.term_months ? deal.term_months + ' months' : '-');
  set('snap-rate', num(deal.rate_requested) ? num(deal.rate_requested).toFixed(2) + '% /mo' : '-');

  // Borrower - show company name for corporate, personal name otherwise
  const bType = (deal.borrower_type || 'individual').toLowerCase();
  const isCorporate = ['corporate', 'spv', 'ltd', 'llp'].includes(bType);
  const borrowerDisplay = isCorporate
    ? (deal.company_name || deal.borrower_company || deal.borrower_name || 'N/A') + ' (' + bType.toUpperCase() + ')'
    : (deal.borrower_name || 'N/A');
  set('snap-borrower', borrowerDisplay);

  set('snap-exit', deal.exit_strategy ? (deal.exit_strategy.length > 40 ? deal.exit_strategy.substring(0, 40) + '...' : deal.exit_strategy) : '-');
  set('detail-date', deal.created_at ? formatDate(deal.created_at) : '-');
  set('detail-ref-id', deal.submission_id ? deal.submission_id.substring(0, 8) : '-');

  // Stage pipeline
  const pipeline = document.getElementById('snapshot-pipeline');
  if (pipeline) {
    const stageOrder = ['received', 'assigned', 'dip_issued', 'info_gathering', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
    const currentIdx = stageOrder.indexOf(stage);
    let phtml = '<span style="font-size:10px;color:#64748b;font-weight:600;margin-right:4px;">STAGE</span>';
    stageOrder.forEach((s, i) => {
      const isCurrent = s === stage;
      const isDone = i < currentIdx;
      const bg = isCurrent ? '#c9a84c' : isDone ? '#22c55e' : '#e2e8f0';
      const color = (isCurrent || isDone) ? '#fff' : '#94a3b8';
      const fw = isCurrent ? 'font-weight:700;' : '';
      phtml += `<span style="padding:3px 10px;border-radius:10px;font-size:10px;background:${bg};color:${color};${fw}">${stageLabels[s] || s}</span>`;
      if (i < stageOrder.length - 1) phtml += '<span style="color:#cbd5e1;font-size:10px;">&rarr;</span>';
    });
    pipeline.innerHTML = phtml;
  }
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT REPOSITORY — Fetch from API and populate table
// ═══════════════════════════════════════════════════════════════
export async function renderDocRepo(submissionId, role) {
  const tbody = document.getElementById('doc-repo-tbody');
  const countEl = document.getElementById('doc-repo-count');
  if (!tbody) return;

  const canConfirm = ['broker', 'borrower', 'rm', 'admin'].includes(role);

  // Fetch real documents from deal_documents table via API
  let docs = [];
  if (submissionId) {
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/documents-by-category`, { method: 'GET' });
      if (resp.ok) {
        const data = await resp.json();
        docs = data.documents || [];
      }
    } catch (e) {
      console.warn('[doc-repo] Failed to fetch documents:', e);
    }
  }

  if (countEl) countEl.textContent = docs.length + ' file' + (docs.length !== 1 ? 's' : '');

  if (docs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:30px;text-align:center;color:#94a3b8;">No documents yet. Upload files above or forward emails to deals@daksfirst.com</td></tr>';
    return;
  }

  const catColors = {
    kyc: 'background:#dbeafe;color:#1e40af;', financial: 'background:#dcfce7;color:#166534;',
    property: 'background:#fef3c7;color:#92400e;', legal: 'background:#f3e8ff;color:#6b21a8;',
    issued: 'background:#e0e7ff;color:#3730a3;', email: 'background:#fce7f3;color:#be185d;',
    other: 'background:#f1f5f9;color:#64748b;'
  };
  const CATEGORIES = ['kyc', 'financial', 'property', 'legal', 'issued', 'email', 'other'];

  tbody.innerHTML = docs.map((doc, idx) => {
    const cat = (doc.doc_category || doc.category || 'other').toLowerCase();
    const catStyle = catColors[cat] || catColors.other;
    const name = sanitizeHtml(doc.filename || doc.file_name || doc.original_name || 'Document');
    const size = doc.file_size ? (doc.file_size / 1024 < 1024 ? Math.round(doc.file_size / 1024) + ' KB' : (doc.file_size / 1048576).toFixed(1) + ' MB') : '';
    const uploaded = doc.uploaded_at ? formatDate(doc.uploaded_at) : '-';
    const parsed = doc.auto_parsed || doc.parsed ? true : false;
    const source = doc.source || 'Upload';
    const isConfirmed = !!doc.category_confirmed_at;
    const confirmedBy = doc.category_confirmed_name || '';
    const docId = doc.id || 0;

    // Category cell: dropdown + confirm button for RM/admin, or badge + confirmed state for others
    let categoryCell;
    if (canConfirm && !isConfirmed) {
      // RM/Admin sees dropdown to reclassify + confirm button
      const options = CATEGORIES.map(c =>
        `<option value="${c}" ${c === cat ? 'selected' : ''}>${c.toUpperCase()}</option>`
      ).join('');
      categoryCell = `
        <select id="doc-cat-${docId}" style="padding:3px 6px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;${catStyle}">
          ${options}
        </select>
        <button onclick="window.confirmDocCategory(${docId}, '${submissionId}')"
          style="margin-left:6px;padding:3px 10px;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:#22c55e;color:#fff;transition:background .15s;"
          onmouseover="this.style.background='#16a34a'" onmouseout="this.style.background='#22c55e'"
          title="Confirm this classification">&#10003; Confirm</button>
        <div style="font-size:10px;color:#f59e0b;margin-top:3px;font-style:italic;">AI-suggested &mdash; awaiting RM confirmation</div>`;
    } else if (canConfirm && isConfirmed) {
      // RM/Admin sees confirmed badge + option to reclassify
      const options = CATEGORIES.map(c =>
        `<option value="${c}" ${c === cat ? 'selected' : ''}>${c.toUpperCase()}</option>`
      ).join('');
      categoryCell = `
        <select id="doc-cat-${docId}" style="padding:3px 6px;border:1px solid #d1fae5;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:#dcfce7;color:#166534;">
          ${options}
        </select>
        <button onclick="window.confirmDocCategory(${docId}, '${submissionId}')"
          style="margin-left:6px;padding:3px 10px;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:#e2e8f0;color:#64748b;transition:background .15s;"
          onmouseover="this.style.background='#22c55e';this.style.color='#fff'" onmouseout="this.style.background='#e2e8f0';this.style.color='#64748b'"
          title="Re-confirm with new category">&#8635; Update</button>
        <div style="font-size:10px;color:#22c55e;margin-top:3px;">&#10003; Confirmed by ${sanitizeHtml(confirmedBy)}</div>`;
    } else if (isConfirmed) {
      // Broker/borrower/credit/compliance see confirmed badge (read-only)
      categoryCell = `
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${catStyle}">${cat.toUpperCase()}</span>
        <div style="font-size:10px;color:#22c55e;margin-top:3px;">&#10003; Confirmed by ${sanitizeHtml(confirmedBy)}</div>`;
    } else {
      // Not confirmed, non-RM view — show AI-suggested badge
      categoryCell = `
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${catStyle}">${cat.toUpperCase()}</span>
        <div style="font-size:10px;color:#f59e0b;margin-top:3px;font-style:italic;">AI-suggested</div>`;
    }

    return `<tr style="cursor:pointer;transition:background .1s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">
        <strong>${name}</strong>
        ${size ? '<br><span style="font-size:11px;color:#94a3b8;">' + size + '</span>' : ''}
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">
        ${categoryCell}
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;">${sanitizeHtml(source)}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;">${uploaded}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">
        ${parsed
          ? '<span style="color:#22c55e;font-weight:700;">&#10003; Yes</span>'
          : '<span style="color:#cbd5e1;">&#x2013; No</span>'}
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">
        ${parsed
          ? '<button onclick="window.viewParsedDoc && window.viewParsedDoc(' + idx + ')" style="padding:3px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px;cursor:pointer;background:#fff;color:#1e3a5f;">View Parsed &#8595;</button>'
          : '<button onclick="window.parseDocument && window.parseDocument(' + idx + ')" style="padding:3px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px;cursor:pointer;background:#fff;color:#be185d;">Parse Now</button>'}
        <button onclick="window.downloadDocumentById && window.downloadDocumentById(${docId})" style="padding:3px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px;cursor:pointer;background:#fff;color:#1e3a5f;margin-left:4px;">&#128229;</button>
      </td>
    </tr>`;
  }).join('');

  // ── Global handler for category confirmation ──
  window.confirmDocCategory = async function(docId, subId) {
    const sel = document.getElementById('doc-cat-' + docId);
    if (!sel) return;
    const newCat = sel.value;
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/documents/${docId}/confirm-category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_category: newCat })
      });
      if (resp.ok) {
        showToast('Category confirmed: ' + newCat.toUpperCase(), 'success');
        // Re-render to update UI state
        await renderDocRepo(subId, role);
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(err.error || 'Failed to confirm category', 'error');
      }
    } catch (e) {
      console.error('[doc-repo] Confirm category error:', e);
      showToast('Failed to confirm category', 'error');
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// FEE SECTION — Populate fee table from deal data
// ═══════════════════════════════════════════════════════════════
export function renderFeeSection(deal) {
  const tbody = document.getElementById('fee-table-body');
  if (!tbody) return;

  const num = (v) => v != null ? Number(v) : 0;
  const loan = num(deal.loan_amount);
  const arrangementPct = num(deal.arrangement_fee_pct) || 2.0;
  const brokerPct = num(deal.broker_fee_pct) || 0;
  const rate = num(deal.rate_requested);
  const term = num(deal.term_months);

  if (!loan) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:#94a3b8;">Fee schedule will appear once loan terms are confirmed.</td></tr>';
    return;
  }

  const arrangementFee = Math.round(loan * arrangementPct / 100);
  const brokerFee = brokerPct ? Math.round(loan * brokerPct / 100) : 0;
  const commitmentFee = num(deal.commitment_fee) || 5000;
  const retainedMonths = num(deal.retained_interest_months) || 6;
  const retainedInterest = Math.round(loan * (rate / 100) * retainedMonths);

  const feeStatus = (paid) => paid
    ? '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#dcfce7;color:#166534;">Paid</span>'
    : '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#fef3c7;color:#92400e;">Due</span>';

  const stage = deal.deal_stage || 'received';
  const feePaid = ['fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'].includes(stage);

  tbody.innerHTML = `
    <tr><td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;"><strong>Commitment Fee</strong></td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">&pound;${commitmentFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">On acceptance of Indicative TS</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">${feeStatus(feePaid)}</td></tr>
    <tr><td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;"><strong>Arrangement Fee</strong> (${arrangementPct.toFixed(2)}%)</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">&pound;${arrangementFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">Deducted from advance</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">${feeStatus(false)}</td></tr>
    ${brokerFee ? `<tr><td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;"><strong>Broker Fee</strong> (${brokerPct.toFixed(2)}%)</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">&pound;${brokerFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">From arrangement fee</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">${feeStatus(false)}</td></tr>` : ''}
    <tr><td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;"><strong>Retained Interest</strong> (${retainedMonths}m)</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">&pound;${retainedInterest.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">Deducted from advance</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;">${feeStatus(false)}</td></tr>
  `;

  // Admin fee allocation
  const allocGrid = document.getElementById('fee-allocation-grid');
  if (allocGrid) {
    const netToDaksfirst = arrangementFee - brokerFee;
    allocGrid.innerHTML = `
      <div style="background:#fff;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:11px;">Total Fee Earned</div>
        <div style="font-size:20px;font-weight:800;color:#1e3a5f;">&pound;${arrangementFee.toLocaleString()}</div>
      </div>
      <div style="background:#fff;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:11px;">Broker Payout</div>
        <div style="font-size:20px;font-weight:800;color:#dc2626;">&pound;${brokerFee.toLocaleString()}</div>
      </div>
      <div style="background:#fff;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:11px;">Net to Daksfirst</div>
        <div style="font-size:20px;font-weight:800;color:#22c55e;">&pound;${netToDaksfirst.toLocaleString()}</div>
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════════
// FUNDING SECTION — GBB eligibility check and bucket selection
// ═══════════════════════════════════════════════════════════════
export function renderFundingSection(deal) {
  const num = (v) => v != null ? Number(v) : 0;
  const loan = num(deal.loan_amount);
  const ltv = num(deal.ltv_requested) || (loan && num(deal.current_value) ? Math.round(loan / num(deal.current_value) * 100 * 10) / 10 : 0);
  const term = num(deal.term_months);
  const assetType = (deal.asset_type || '').toLowerCase();
  const address = (deal.security_address || '').toLowerCase();

  // GBB eligibility checks
  const checks = [];
  const isEngland = !address.includes('scotland') && !address.includes('northern ireland');
  checks.push({ label: 'England/Wales', pass: isEngland });
  const isValidAsset = ['residential', 'commercial', 'mixed_use', 'hmo', 'mufb'].includes(assetType);
  checks.push({ label: assetType || 'Asset type', pass: isValidAsset });
  checks.push({ label: 'LTV ' + (ltv ? ltv.toFixed(1) : '?') + '% < 75%', pass: ltv > 0 && ltv <= 75 });
  checks.push({ label: 'Term ' + (term || '?') + 'm ≤ 24m', pass: term > 0 && term <= 24 });
  checks.push({ label: 'Not development', pass: !(deal.loan_purpose || '').toLowerCase().includes('development') });
  checks.push({ label: 'Loan ≥ £500k', pass: loan >= 500000 });
  checks.push({ label: 'Loan ≤ £15m', pass: loan <= 15000000 });

  const allPass = checks.every(c => c.pass);

  // GBB eligibility display
  const eligEl = document.getElementById('gbb-eligibility');
  if (eligEl) {
    const bg = allPass ? '#f0fff4' : '#fef2f2';
    const border = allPass ? '#86efac' : '#fca5a5';
    const label = allPass ? '<strong style="color:#166534;">GBB Eligible &#10003;</strong>' : '<strong style="color:#991b1b;">GBB Issues Found</strong>';
    eligEl.style.display = 'block';
    eligEl.style.background = bg;
    eligEl.style.borderColor = border;
    eligEl.innerHTML = label + '&nbsp;&nbsp;' + checks.map(c =>
      '<span style="margin-left:8px;">' + (c.pass ? '&#10003;' : '&#10007;') + ' ' + sanitizeHtml(c.label) + '</span>'
    ).join('');
  }

  // GBB amounts
  const gbbAmounts = document.getElementById('gbb-amounts');
  if (gbbAmounts && loan) {
    const gbFund = Math.round(loan * 0.9);
    const dfFund = loan - gbFund;
    gbbAmounts.innerHTML = 'GB Bank funds: <strong>&pound;' + gbFund.toLocaleString() + '</strong> &middot; Daksfirst co-fund: <strong>&pound;' + dfFund.toLocaleString() + '</strong>';
  }

  // Auto-select bucket based on eligibility
  if (allPass) {
    window.selectFundingBucket && window.selectFundingBucket('gbb');
  }
}

window.selectFundingBucket = function(bucket) {
  const gbb = document.getElementById('bucket-gbb');
  const wl = document.getElementById('bucket-wl');
  const gbbBadge = document.getElementById('gbb-selected-badge');
  if (bucket === 'gbb') {
    if (gbb) { gbb.style.borderColor = '#1e3a5f'; gbb.style.background = '#f0f5ff'; gbb.style.boxShadow = '0 0 0 3px rgba(30,58,95,0.1)'; }
    if (wl) { wl.style.borderColor = '#e2e8f0'; wl.style.background = ''; wl.style.boxShadow = ''; }
    if (gbbBadge) gbbBadge.style.display = 'inline';
  } else {
    if (wl) { wl.style.borderColor = '#1e3a5f'; wl.style.background = '#f0f5ff'; wl.style.boxShadow = '0 0 0 3px rgba(30,58,95,0.1)'; }
    if (gbb) { gbb.style.borderColor = '#e2e8f0'; gbb.style.background = ''; gbb.style.boxShadow = ''; }
    if (gbbBadge) gbbBadge.style.display = 'none';
  }
};

// ═══════════════════════════════════════════════════════════════
// ADMIN — Assignment section
// ═══════════════════════════════════════════════════════════════
export function renderAdminSection(deal) {
  const container = document.getElementById('admin-assignments');
  if (!container) return;

  const rmName = deal.rm_first ? `${sanitizeHtml(deal.rm_first)} ${sanitizeHtml(deal.rm_last)}` : null;
  const creditName = deal.credit_first ? `${sanitizeHtml(deal.credit_first)} ${sanitizeHtml(deal.credit_last)}` : null;
  const compName = deal.comp_first ? `${sanitizeHtml(deal.comp_first)} ${sanitizeHtml(deal.comp_last)}` : null;

  const badge = (name) => name
    ? `<span style="padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:#dcfce7;color:#166534;">${name}</span>`
    : `<span style="padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:#fee2e2;color:#991b1b;">Unassigned</span>`;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;">
        <div style="font-size:12px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:12px;">Staff Assignments</div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;">
          <span>Relationship Manager</span>${badge(rmName)}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;">
          <span>Credit Analyst</span>${badge(creditName)}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:13px;">
          <span>Compliance Officer</span>${badge(compName)}
        </div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;">
        <div style="font-size:12px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:12px;">Deal Controls</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button onclick="window.advanceDealStage && window.advanceDealStage()" style="width:100%;padding:10px;background:#fff;border:2px solid #1e3a5f;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#1e3a5f;">&#9654; Advance Stage</button>
          <button onclick="window.holdDeal && window.holdDeal()" style="width:100%;padding:10px;background:#fff;border:2px solid #f59e0b;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#92400e;">&#9208; Hold Deal</button>
          <button onclick="window.declineDeal && window.declineDeal()" style="width:100%;padding:10px;background:#fff;border:2px solid #dc2626;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#dc2626;">&#10005; Decline Deal</button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// NOTES / COMMENTS — Basic in-memory thread (DB integration later)
// ═══════════════════════════════════════════════════════════════
const noteColors = { admin: '#dc2626', rm: '#2563eb', credit: '#7c3aed', compliance: '#c9a84c', broker: '#059669', borrower: '#059669' };

export function renderNotesSection(deal) {
  // Notes will come from deal.notes or a separate API later
  const notes = deal.notes || [];
  const thread = document.getElementById('notes-thread');
  const countEl = document.getElementById('notes-count');
  if (!thread) return;

  if (countEl) countEl.textContent = notes.length || '0';

  if (notes.length === 0) {
    thread.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px 0;font-size:13px;">No notes yet. Start the conversation below.</p>';
    return;
  }

  thread.innerHTML = notes.map(n => {
    const initials = (n.author || 'U').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const bg = noteColors[n.role] || '#64748b';
    return `<div style="display:flex;gap:10px;margin-bottom:14px;">
      <div style="width:32px;height:32px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">${initials}</div>
      <div style="flex:1;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;"><strong style="color:#1e293b;">${sanitizeHtml(n.author || 'User')}</strong> &middot; ${sanitizeHtml(n.role || '')} &middot; ${n.date ? formatDate(n.date) : ''}</div>
        <div style="font-size:13px;color:#374151;line-height:1.5;background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;">${sanitizeHtml(n.text || '')}</div>
      </div>
    </div>`;
  }).join('');
}

// Note sending (in-memory for now)
window.sendDealNote = function() {
  const input = document.getElementById('note-input');
  if (!input || !input.value.trim()) return;

  const user = getCurrentUser();
  const role = getCurrentRole();
  const text = input.value.trim();

  // Add to thread visually
  const thread = document.getElementById('notes-thread');
  const emptyMsg = thread ? thread.querySelector('p') : null;
  if (emptyMsg && emptyMsg.textContent.includes('No notes')) emptyMsg.remove();

  const initials = user ? (user.first_name || 'U')[0] + (user.last_name || '')[0] : 'U';
  const bg = noteColors[role] || '#64748b';
  const noteHtml = `<div style="display:flex;gap:10px;margin-bottom:14px;">
    <div style="width:32px;height:32px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">${initials.toUpperCase()}</div>
    <div style="flex:1;">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;"><strong style="color:#1e293b;">${user ? sanitizeHtml(user.first_name + ' ' + user.last_name) : 'You'}</strong> &middot; ${role} &middot; Just now</div>
      <div style="font-size:13px;color:#374151;line-height:1.5;background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0;">${sanitizeHtml(text)}</div>
    </div>
  </div>`;

  if (thread) thread.innerHTML += noteHtml;
  input.value = '';

  // Update count
  const countEl = document.getElementById('notes-count');
  if (countEl) countEl.textContent = String(Number(countEl.textContent || 0) + 1);

  showToast('Note added', 'success');
};

// ═══════════════════════════════════════════════════════════════
// MASTER RENDER — Called from deal-detail.js
// ═══════════════════════════════════════════════════════════════
export async function renderDealSections(deal, role) {
  // 1. Role gating
  applyRoleGating(role);

  // 2. Snapshot
  renderSnapshot(deal);

  // 3. Matrix — handled by deal-matrix.js via dynamic import in deal-detail.js

  // 4. Document Repository — fetch from API using submission_id
  await renderDocRepo(deal.submission_id, role);

  // 5. Notes
  renderNotesSection(deal);

  // 6. Fee
  renderFeeSection(deal);

  // 7. Funding
  renderFundingSection(deal);

  // 8. Admin
  if (role === 'admin') {
    renderAdminSection(deal);
  }
}
