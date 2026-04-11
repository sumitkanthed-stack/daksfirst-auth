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
export function renderSnapshot(deal, role) {
  const num = (v) => v != null ? Number(v) : 0;
  const fmtMoney = (v) => num(v) ? '£' + num(v).toLocaleString() : '-';
  const fmtPctVal = (v) => num(v) ? num(v).toFixed(1) + '%' : '-';

  // Address — truncate long multi-property addresses, emphasise location
  const addrEl = document.getElementById('detail-property-address');
  if (addrEl) {
    const rawAddr = deal.security_address || 'N/A';
    const postcode = deal.security_postcode || '';
    // Extract area from postcode (e.g. "W6 9RH" → "W6")
    const pcArea = postcode ? postcode.split(' ')[0] : '';
    // If address is very long (multi-property), truncate and count
    const parts = rawAddr.split(';').map(s => s.trim()).filter(Boolean);
    let displayAddr;
    if (parts.length > 1) {
      // Show first property truncated + count + location
      const first = parts[0].length > 60 ? parts[0].substring(0, 57) + '...' : parts[0];
      displayAddr = `${first} (+${parts.length - 1} more)`;
    } else {
      displayAddr = rawAddr.length > 80 ? rawAddr.substring(0, 77) + '...' : rawAddr;
    }
    if (pcArea) {
      displayAddr += ` · ${pcArea}`;
    }
    addrEl.textContent = sanitizeHtml(displayAddr);
    addrEl.title = sanitizeHtml(rawAddr); // full address on hover
  }

  // Stage badge — brokers see simplified labels
  const isExternal = ['broker', 'borrower'].includes(role);
  const stageLabels = {
    received: 'Received', assigned: isExternal ? 'Received' : 'Assigned', dip_issued: 'DIP Issued',
    info_gathering: isExternal ? 'DIP Requested' : 'Info Gathering', ai_termsheet: 'Indicative Termsheet',
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
    const stageOrder = ['received', 'assigned', 'info_gathering', 'dip_issued', 'ai_termsheet', 'fee_pending', 'fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'];
    const currentIdx = stageOrder.indexOf(stage);
    let phtml = '<span style="font-size:10px;color:#94A3B8;font-weight:600;margin-right:4px;">STAGE</span>';
    stageOrder.forEach((s, i) => {
      const isCurrent = s === stage;
      const isDone = i < currentIdx;
      const bg = isCurrent ? '#D4A853' : isDone ? '#34D399' : 'rgba(255,255,255,0.06)';
      const color = (isCurrent || isDone) ? '#111827' : '#64748B';
      const fw = isCurrent ? 'font-weight:700;' : '';
      phtml += `<span style="padding:3px 10px;border-radius:10px;font-size:10px;background:${bg};color:${color};${fw}">${stageLabels[s] || s}</span>`;
      if (i < stageOrder.length - 1) phtml += '<span style="color:rgba(255,255,255,0.06);font-size:10px;">&rarr;</span>';
    });
    pipeline.innerHTML = phtml;
  }
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT REPOSITORY — Fetch from API and populate table
// ═══════════════════════════════════════════════════════════════
// Store last-used submissionId and role so global handlers can re-render
let _docRepoSubId = null;
let _docRepoRole = null;

export async function renderDocRepo(submissionId, role) {
  const tbody = document.getElementById('doc-repo-tbody');
  const countEl = document.getElementById('doc-repo-count');
  if (!tbody) return;

  // Cache for global handlers
  _docRepoSubId = submissionId;
  _docRepoRole = role;

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
    tbody.innerHTML = '<tr><td colspan="6" style="padding:30px;text-align:center;color:#64748B;">No documents yet. Upload files via the Matrix buttons or forward emails to deals@daksfirst.com</td></tr>';
    return;
  }

  const catColors = {
    kyc: 'background:rgba(96,165,250,0.1);color:#60A5FA;', financial: 'background:#dcfce7;color:#166534;',
    property: 'background:#fef3c7;color:#92400e;', legal: 'background:#f3e8ff;color:#6b21a8;',
    issued: 'background:#e0e7ff;color:#3730a3;', email: 'background:#fce7f3;color:#be185d;',
    other: 'background:#f1f5f9;color:#64748b;'
  };
  const CATEGORIES = ['kyc', 'financial', 'property', 'legal', 'issued', 'email', 'other'];

  // Sort documents by category so they are grouped together
  const catOrder = { kyc: 0, financial: 1, property: 2, legal: 3, issued: 4, email: 5, other: 6 };
  docs.sort((a, b) => {
    const catA = (a.doc_category || a.category || 'other').toLowerCase();
    const catB = (b.doc_category || b.category || 'other').toLowerCase();
    return (catOrder[catA] ?? 6) - (catOrder[catB] ?? 6);
  });

  tbody.innerHTML = docs.map((doc, idx) => {
    const cat = (doc.doc_category || doc.category || 'other').toLowerCase();
    const catStyle = catColors[cat] || catColors.other;
    const name = sanitizeHtml(doc.filename || doc.file_name || doc.original_name || 'Document');
    const size = doc.file_size ? (doc.file_size / 1024 < 1024 ? Math.round(doc.file_size / 1024) + ' KB' : (doc.file_size / 1048576).toFixed(1) + ' MB') : '';
    const uploaded = doc.uploaded_at ? formatDate(doc.uploaded_at) : '-';
    const isConfirmed = !!doc.category_confirmed_at;
    const confirmedBy = doc.category_confirmed_name || '';
    const isParsed = !!doc.parsed_at;
    const docId = doc.id || 0;
    const fileType = (doc.file_type || '').toLowerCase();

    // Category cell: dropdown + confirm for those who can, badge for read-only
    let categoryCell;
    if (canConfirm && !isConfirmed) {
      const options = CATEGORIES.map(c =>
        `<option value="${c}" ${c === cat ? 'selected' : ''}>${c.toUpperCase()}</option>`
      ).join('');
      categoryCell = `
        <select id="doc-cat-${docId}" style="padding:3px 6px;border:1px rgba(255,255,255,0.06);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;${catStyle}">
          ${options}
        </select>
        <button onclick="window.confirmDocCategory(${docId})"
          style="margin-left:6px;padding:3px 10px;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:#34D399;color:#111827;transition:background .15s;"
          onmouseover="this.style.background='#2fb589'" onmouseout="this.style.background='#34D399'"
          title="Confirm this classification">&#10003; Confirm</button>
        <div style="font-size:10px;color:#FBBF24;margin-top:3px;font-style:italic;">AI-suggested &mdash; awaiting confirmation</div>`;
    } else if (canConfirm && isConfirmed) {
      const options = CATEGORIES.map(c =>
        `<option value="${c}" ${c === cat ? 'selected' : ''}>${c.toUpperCase()}</option>`
      ).join('');
      categoryCell = `
        <select id="doc-cat-${docId}" style="padding:3px 6px;border:1px #34D399;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;">
          ${options}
        </select>
        <button onclick="window.confirmDocCategory(${docId})"
          style="margin-left:6px;padding:3px 10px;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,255,255,0.06);color:#94A3B8;transition:background .15s;"
          onmouseover="this.style.background='#34D399';this.style.color='#111827'" onmouseout="this.style.background='rgba(255,255,255,0.06)';this.style.color='#94A3B8'"
          title="Re-classify">&#8635; Update</button>
        <div style="font-size:10px;color:#34D399;margin-top:3px;">&#10003; Confirmed by ${sanitizeHtml(confirmedBy)}</div>`;
    } else if (isConfirmed) {
      categoryCell = `
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${catStyle}">${cat.toUpperCase()}</span>
        <div style="font-size:10px;color:#34D399;margin-top:3px;">&#10003; Confirmed by ${sanitizeHtml(confirmedBy)}</div>`;
    } else {
      categoryCell = `
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${catStyle}">${cat.toUpperCase()}</span>
        <div style="font-size:10px;color:#FBBF24;margin-top:3px;font-style:italic;">AI-suggested</div>`;
    }

    // Determine if viewable inline (images + PDFs)
    const isViewable = fileType.includes('image') || fileType.includes('pdf') || fileType.includes('png') || fileType.includes('jpg') || fileType.includes('jpeg');

    // Has stored parsed data?
    const hasParsedData = doc.parsed_data && typeof doc.parsed_data === 'object' && Object.keys(doc.parsed_data).length > 0;

    // Parse / View Data button
    let parseBtn = '';
    if (hasParsedData) {
      parseBtn = `<button onclick="window.viewDocParsedData(${docId})" style="padding:4px 10px;border:1px #34D399;border-radius:5px;font-size:11px;cursor:pointer;background:rgba(52,211,153,0.1);color:#34D399;margin-right:4px;font-weight:600;" title="View extracted data">&#128202; View Data</button>`;
    } else {
      parseBtn = `<button onclick="window.parseDocById(${docId})" style="padding:4px 10px;border:1px #D4A853;border-radius:5px;font-size:11px;cursor:pointer;background:rgba(212,168,83,0.15);color:#FBBF24;margin-right:4px;font-weight:600;" title="Extract data with AI">&#9889; Parse</button>`;
    }

    return `<tr style="transition:background .1s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">
        <strong>${name}</strong>
        ${size ? '<br><span style="font-size:11px;color:#64748B;">' + size + '</span>' : ''}
      </td>
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">
        ${categoryCell}
      </td>
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);font-size:12px;">${uploaded}</td>
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">
        ${isConfirmed
          ? '<span style="color:#34D399;font-weight:700;font-size:12px;">&#10003; Confirmed</span>'
          : '<span style="color:#FBBF24;font-size:12px;">Pending</span>'}
      </td>
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">
        ${isParsed
          ? '<span style="color:#34D399;font-weight:700;font-size:12px;">&#10003; Parsed</span>'
          : '<span style="color:rgba(255,255,255,0.06);font-size:12px;">&#x2013; Not yet</span>'}
      </td>
      <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);white-space:nowrap;">
        ${parseBtn}
        ${isViewable ? `<button onclick="window.viewDocInline(${docId}, '${sanitizeHtml(name)}', '${fileType}')" style="padding:4px 10px;border:1px rgba(255,255,255,0.06);border-radius:5px;font-size:11px;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;margin-right:4px;font-weight:600;" title="Preview">&#128065; View</button>` : ''}
        <button onclick="window.downloadDocById(${docId})" style="padding:4px 10px;border:1px rgba(255,255,255,0.06);border-radius:5px;font-size:11px;cursor:pointer;background:rgba(212,168,83,0.15);color:#D4A853;font-weight:600;" title="Download">&#128229; Download</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Global handlers for Doc Repo (defined ONCE, outside renderDocRepo) ──

// Confirm category
window.confirmDocCategory = async function(docId) {
  const subId = _docRepoSubId;
  const role = _docRepoRole;
  if (!subId) return;

  const sel = document.getElementById('doc-cat-' + docId);
  if (!sel) return;
  const newCat = sel.value;

  // Disable button to prevent double-click
  const btn = sel.nextElementSibling;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

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
      if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Confirm'; }
    }
  } catch (e) {
    console.error('[doc-repo] Confirm category error:', e);
    showToast('Failed to confirm category', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Confirm'; }
  }
};

// Confirm ALL unconfirmed documents in one go
window.confirmAllDocCategories = async function() {
  const subId = _docRepoSubId;
  const role = _docRepoRole;
  if (!subId) return;

  // Find all unconfirmed doc category selects
  const selects = document.querySelectorAll('[id^="doc-cat-"]');
  let confirmed = 0;
  let failed = 0;

  for (const sel of selects) {
    const docId = sel.id.replace('doc-cat-', '');
    const newCat = sel.value;
    try {
      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/documents/${docId}/confirm-category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_category: newCat })
      });
      if (resp.ok) confirmed++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  if (confirmed > 0) {
    showToast(`${confirmed} document${confirmed !== 1 ? 's' : ''} confirmed${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
    await renderDocRepo(subId, role);
  } else {
    showToast('No documents to confirm', 'error');
  }
};

// Download document by ID
window.downloadDocById = async function(docId) {
  const subId = _docRepoSubId;
  if (!subId || !docId) {
    showToast('Cannot download — deal or document ID missing', 'error');
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/documents/${docId}/download`, { method: 'GET' });
    if (!resp.ok) {
      showToast('Download failed', 'error');
      return;
    }
    const blob = await resp.blob();
    const disposition = resp.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="(.+?)"/);
    const filename = filenameMatch ? filenameMatch[1] : `document-${docId}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    console.error('[doc-repo] Download error:', err);
    showToast('Download error', 'error');
  }
};

// View document inline (modal preview — no new window)
window.viewDocInline = async function(docId, filename, fileType) {
  const subId = _docRepoSubId;
  if (!subId || !docId) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${subId}/documents/${docId}/download`, { method: 'GET' });
    if (!resp.ok) { showToast('Could not load document', 'error'); return; }
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);

    // Create modal overlay
    const modal = document.createElement('div');
    modal.id = 'doc-preview-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;';

    // Header bar
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:90%;max-width:900px;padding:12px 0;';
    header.innerHTML = `
      <div style="color:#F1F5F9;font-size:14px;font-weight:600;">${filename || 'Document Preview'}</div>
      <div style="display:flex;gap:8px;">
        <button onclick="window.downloadDocById(${docId})" style="padding:6px 14px;border:1px solid #F1F5F9;border-radius:6px;font-size:12px;cursor:pointer;background:transparent;color:#F1F5F9;font-weight:600;">&#128229; Download</button>
        <button onclick="document.getElementById('doc-preview-modal').remove()" style="padding:6px 14px;border:none;border-radius:6px;font-size:12px;cursor:pointer;background:#F87171;color:#111827;font-weight:600;">&#10005; Close</button>
      </div>`;
    modal.appendChild(header);

    // Content area
    const content = document.createElement('div');
    content.style.cssText = 'width:90%;max-width:900px;max-height:80vh;background:#1a2332;border-radius:10px;overflow:auto;';

    const ft = (fileType || '').toLowerCase();
    if (ft.includes('pdf')) {
      content.innerHTML = `<iframe src="${blobUrl}" style="width:100%;height:80vh;border:none;border-radius:10px;"></iframe>`;
    } else if (ft.includes('image') || ft.includes('png') || ft.includes('jpg') || ft.includes('jpeg')) {
      content.innerHTML = `<img src="${blobUrl}" style="width:100%;max-height:80vh;object-fit:contain;border-radius:10px;" />`;
    } else {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:#94A3B8;font-size:14px;">Preview not available for this file type. Use the Download button above.</div>`;
    }

    modal.appendChild(content);

    // Close on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) { modal.remove(); URL.revokeObjectURL(blobUrl); }
    });

    // Close on Escape key
    const escHandler = function(e) {
      if (e.key === 'Escape') { modal.remove(); URL.revokeObjectURL(blobUrl); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(modal);
  } catch (err) {
    console.error('[doc-repo] View error:', err);
    showToast('Could not preview document', 'error');
  }
};

// Parse a single document by ID — triggers AI extraction and shows results in Parser section
window.parseDocById = async function(docId) {
  const subId = _docRepoSubId;
  const role = _docRepoRole;
  if (!subId || !docId) return;

  // Show loading state on the button
  const btn = event && event.target ? event.target : null;
  const origText = btn ? btn.innerHTML : '';
  if (btn) { btn.innerHTML = '&#9203; Parsing...'; btn.disabled = true; btn.style.opacity = '0.6'; }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/parse-document/${docId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Parse failed', 'error');
      if (btn) { btn.innerHTML = origText; btn.disabled = false; btn.style.opacity = '1'; }
      return;
    }

    const data = await resp.json();

    if (data.parsed_data && Object.keys(data.parsed_data).length > 0) {
      // Dispatch event so deal-matrix.js can pick it up and show in Parser section
      window.dispatchEvent(new CustomEvent('docParsed', { detail: { docId, filename: data.filename, parsedData: data.parsed_data } }));
      showToast(data.message || 'Document parsed', 'success');
    } else {
      showToast(`No data could be extracted from this document (may be an image/scan).`, 'info');
    }

    // Refresh doc repo to show updated parsed status
    await renderDocRepo(subId, role);
  } catch (err) {
    console.error('[doc-repo] Parse error:', err);
    showToast('Parse error', 'error');
    if (btn) { btn.innerHTML = origText; btn.disabled = false; btn.style.opacity = '1'; }
  }
};

// View already-parsed data for a document — loads from API and shows in Parser section
window.viewDocParsedData = async function(docId) {
  const subId = _docRepoSubId;
  if (!subId || !docId) return;

  try {
    // Call parse-document endpoint which returns cached data if available
    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/parse-document/${docId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Could not load parsed data', 'error');
      return;
    }

    const data = await resp.json();

    if (data.parsed_data && Object.keys(data.parsed_data).length > 0) {
      window.dispatchEvent(new CustomEvent('docParsed', { detail: { docId, filename: data.filename, parsedData: data.parsed_data } }));
      showToast(`Showing extracted data for "${data.filename}"`, 'success');
    } else {
      showToast('No parsed data available for this document', 'info');
    }
  } catch (err) {
    console.error('[doc-repo] View parsed data error:', err);
    showToast('Could not load parsed data', 'error');
  }
};

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
    tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:#64748B;">Fee schedule will appear once loan terms are confirmed.</td></tr>';
    return;
  }

  const arrangementFee = Math.round(loan * arrangementPct / 100);
  const brokerFee = brokerPct ? Math.round(loan * brokerPct / 100) : 0;
  const commitmentFee = num(deal.commitment_fee) || 5000;
  const retainedMonths = num(deal.retained_interest_months) || 6;
  const retainedInterest = Math.round(loan * (rate / 100) * retainedMonths);

  const feeStatus = (paid) => paid
    ? '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(52,211,153,0.1);color:#34D399;">Paid</span>'
    : '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(251,191,36,0.1);color:#FBBF24;">Due</span>';

  const stage = deal.deal_stage || 'received';
  const feePaid = ['fee_paid', 'underwriting', 'bank_submitted', 'bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'].includes(stage);

  tbody.innerHTML = `
    <tr><td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);"><strong>Commitment Fee</strong></td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);text-align:right;">&pound;${commitmentFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">On acceptance of Indicative TS</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">${feeStatus(feePaid)}</td></tr>
    <tr><td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);"><strong>Arrangement Fee</strong> (${arrangementPct.toFixed(2)}%)</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);text-align:right;">&pound;${arrangementFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">Deducted from advance</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">${feeStatus(false)}</td></tr>
    ${brokerFee ? `<tr><td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);"><strong>Broker Fee</strong> (${brokerPct.toFixed(2)}%)</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);text-align:right;">&pound;${brokerFee.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">From arrangement fee</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">${feeStatus(false)}</td></tr>` : ''}
    <tr><td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);"><strong>Retained Interest</strong> (${retainedMonths}m)</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);text-align:right;">&pound;${retainedInterest.toLocaleString()}</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">Deducted from advance</td>
        <td style="padding:10px 16px;border-bottom:1px rgba(255,255,255,0.06);">${feeStatus(false)}</td></tr>
  `;

  // Admin fee allocation
  const allocGrid = document.getElementById('fee-allocation-grid');
  if (allocGrid) {
    const netToDaksfirst = arrangementFee - brokerFee;
    allocGrid.innerHTML = `
      <div style="background:#1e293b;padding:12px;border-radius:6px;border:1px rgba(255,255,255,0.06);">
        <div style="color:#94A3B8;font-size:11px;">Total Fee Earned</div>
        <div style="font-size:20px;font-weight:800;color:#D4A853;">&pound;${arrangementFee.toLocaleString()}</div>
      </div>
      <div style="background:#1e293b;padding:12px;border-radius:6px;border:1px rgba(255,255,255,0.06);">
        <div style="color:#94A3B8;font-size:11px;">Broker Payout</div>
        <div style="font-size:20px;font-weight:800;color:#F87171;">&pound;${brokerFee.toLocaleString()}</div>
      </div>
      <div style="background:#1e293b;padding:12px;border-radius:6px;border:1px rgba(255,255,255,0.06);">
        <div style="color:#94A3B8;font-size:11px;">Net to Daksfirst</div>
        <div style="font-size:20px;font-weight:800;color:#34D399;">&pound;${netToDaksfirst.toLocaleString()}</div>
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
    const bg = allPass ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)';
    const border = allPass ? '#34D399' : '#F87171';
    const label = allPass ? '<strong style="color:#34D399;">GBB Eligible &#10003;</strong>' : '<strong style="color:#F87171;">GBB Issues Found</strong>';
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
    if (gbb) { gbb.style.borderColor = 'rgba(212,168,83,0.25)'; gbb.style.background = 'rgba(212,168,83,0.08)'; gbb.style.boxShadow = '0 0 0 3px rgba(212,168,83,0.15)'; }
    if (wl) { wl.style.borderColor = 'rgba(255,255,255,0.06)'; wl.style.background = ''; wl.style.boxShadow = ''; }
    if (gbbBadge) gbbBadge.style.display = 'inline';
  } else {
    if (wl) { wl.style.borderColor = 'rgba(212,168,83,0.25)'; wl.style.background = 'rgba(212,168,83,0.08)'; wl.style.boxShadow = '0 0 0 3px rgba(212,168,83,0.15)'; }
    if (gbb) { gbb.style.borderColor = 'rgba(255,255,255,0.06)'; gbb.style.background = ''; gbb.style.boxShadow = ''; }
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
    ? `<span style="padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(52,211,153,0.1);color:#34D399;">${name}</span>`
    : `<span style="padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(248,113,113,0.1);color:#F87171;">Unassigned</span>`;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="background:#1a2332;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:16px;">
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
      <div style="background:#1a2332;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:16px;">
        <div style="font-size:12px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:12px;">Deal Controls</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button onclick="window.advanceDealStage && window.advanceDealStage()" style="width:100%;padding:10px;background:#111827;border:2px solid #1e3a5f;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#94A3B8;">&#9654; Advance Stage</button>
          <button onclick="window.holdDeal && window.holdDeal()" style="width:100%;padding:10px;background:#111827;border:2px solid #f59e0b;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#92400e;">&#9208; Hold Deal</button>
          <button onclick="window.declineDeal && window.declineDeal()" style="width:100%;padding:10px;background:#111827;border:2px solid #dc2626;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:#dc2626;">&#10005; Decline Deal</button>
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
    thread.innerHTML = '<p style="color:#64748B;text-align:center;padding:20px 0;font-size:13px;">No notes yet. Start the conversation below.</p>';
    return;
  }

  thread.innerHTML = notes.map(n => {
    const initials = (n.author || 'U').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const bg = noteColors[n.role] || '#64748B';
    return `<div style="display:flex;gap:10px;margin-bottom:14px;">
      <div style="width:32px;height:32px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#111827;flex-shrink:0;">${initials}</div>
      <div style="flex:1;">
        <div style="font-size:11px;color:#64748B;margin-bottom:4px;"><strong style="color:#F1F5F9;">${sanitizeHtml(n.author || 'User')}</strong> &middot; ${sanitizeHtml(n.role || '')} &middot; ${n.date ? formatDate(n.date) : ''}</div>
        <div style="font-size:13px;color:#F1F5F9;line-height:1.5;background:#1e293b;padding:10px 14px;border-radius:8px;border:1px rgba(255,255,255,0.06);">${sanitizeHtml(n.text || '')}</div>
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
  const bg = noteColors[role] || '#64748B';
  const noteHtml = `<div style="display:flex;gap:10px;margin-bottom:14px;">
    <div style="width:32px;height:32px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#111827;flex-shrink:0;">${initials.toUpperCase()}</div>
    <div style="flex:1;">
      <div style="font-size:11px;color:#64748B;margin-bottom:4px;"><strong style="color:#F1F5F9;">${user ? sanitizeHtml(user.first_name + ' ' + user.last_name) : 'You'}</strong> &middot; ${role} &middot; Just now</div>
      <div style="font-size:13px;color:#F1F5F9;line-height:1.5;background:#1e293b;padding:10px 14px;border-radius:8px;border:1px rgba(255,255,255,0.06);">${sanitizeHtml(text)}</div>
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
  renderSnapshot(deal, role);

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
