/**
 * Document Repository Sidebar — role-based, section-organised, with upload + download
 */
import { API_BASE } from './config.js';
import { fetchWithAuth, getAuthToken } from './auth.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getCurrentDealId, getCurrentRole } from './state.js';

// ═══════════════════════════════════════════════════════════════
//  Section definitions: who can view, who can upload
// ═══════════════════════════════════════════════════════════════
// Ordered to match deal lifecycle: submission → DIP → onboarding → termsheet → completion
const SECTION_DEFS = [
  {
    key: 'initial', label: '1. Initial Submission', icon: '\u{1F4CB}',
    owners: ['broker'],
    viewers: ['broker', 'borrower', 'rm', 'credit', 'compliance', 'admin'],
    category: 'general', phase: 1
  },
  {
    key: 'dip', label: '2. DIP Document', icon: '\u{1F4C4}',
    owners: [],
    viewers: ['broker', 'borrower', 'rm', 'credit', 'compliance', 'admin'],
    category: null, system: true, phase: 1
  },
  {
    key: 'kyc', label: '3. KYC / Identity', icon: '\u{1FAAA}',
    owners: ['borrower', 'broker'],
    viewers: ['broker', 'borrower', 'rm', 'credit', 'compliance', 'admin'],
    category: 'kyc', phase: 2
  },
  {
    key: 'financials_aml', label: '4. Financials / AML', icon: '\u{1F4B7}',
    owners: ['broker', 'borrower'],
    viewers: ['broker', 'borrower', 'rm', 'compliance', 'credit', 'admin'],
    category: 'financials_aml', phase: 2
  },
  {
    key: 'valuation', label: '5. Valuation', icon: '\u{1F3E0}',
    owners: ['broker', 'rm'],
    viewers: ['broker', 'rm', 'credit', 'admin'],
    category: 'valuation', phase: 2
  },
  {
    key: 'use_of_funds', label: '6. Use of Funds', icon: '\u{1F4B0}',
    owners: ['broker'],
    viewers: ['broker', 'rm', 'credit', 'admin'],
    category: 'use_of_funds', phase: 2
  },
  {
    key: 'exit_evidence', label: '7. Exit Evidence', icon: '\u{1F6AA}',
    owners: ['broker'],
    viewers: ['broker', 'rm', 'credit', 'admin'],
    category: 'exit_evidence', phase: 2
  },
  {
    key: 'other_conditions', label: '8. Other Conditions', icon: '\u{1F6E1}',
    owners: ['borrower', 'broker', 'rm'],
    viewers: ['broker', 'borrower', 'rm', 'credit', 'compliance', 'admin'],
    category: 'other_conditions', phase: 2
  },
  {
    key: 'termsheet', label: '9. Termsheet', icon: '\u{1F4DD}',
    owners: [],
    viewers: ['rm', 'credit', 'admin'],
    category: null, system: true, phase: 3
  },
  {
    key: 'post_completion', label: '10. Post-Completion', icon: '\u{2705}',
    owners: ['rm'],
    viewers: ['broker', 'borrower', 'rm', 'credit', 'compliance', 'admin'],
    category: 'post_completion', phase: 4
  }
];

let expandedSection = null;

/**
 * Render the full document sidebar for a deal
 */
export async function renderDocPanel(deal) {
  const sidebar = document.getElementById('deal-doc-sidebar');
  if (!sidebar) return;

  sidebar.style.display = 'flex';

  const role = getCurrentRole() || 'broker';
  const stage = deal.deal_stage || 'received';
  const approval = deal.onboarding_approval || {};

  // Fetch all documents grouped by category
  let docsByCategory = {};
  let systemDocs = {};
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${deal.submission_id}/documents-by-category`, { method: 'GET' });
    const data = await resp.json();
    if (resp.ok) {
      (data.documents || []).forEach(doc => {
        const cat = doc.doc_category || 'general';
        if (!docsByCategory[cat]) docsByCategory[cat] = [];
        docsByCategory[cat].push(doc);
      });
    }
  } catch (err) {
    console.error('[doc-panel] Failed to load docs:', err);
  }

  // Merge legacy docs from deal.documents JSONB (initial submission uploads)
  if (deal.documents && Array.isArray(deal.documents)) {
    if (!docsByCategory['general']) docsByCategory['general'] = [];
    const existingNames = new Set(docsByCategory['general'].map(d => d.filename));
    deal.documents.forEach(doc => {
      const fname = doc.filename || doc.original_name || 'Document';
      if (!existingNames.has(fname)) {
        docsByCategory['general'].push({
          filename: fname,
          onedrive_download_url: doc.onedrive_download_url || doc.download_url || doc.url,
          uploaded_at: doc.uploaded_at || deal.created_at,
          file_size: doc.file_size || doc.size,
          _by: 'Broker'
        });
      }
    });
  }

  // Build system docs (DIP PDF, Termsheet)
  if (deal.dip_pdf_url) {
    systemDocs.dip = [{ filename: `DIP_${deal.submission_id.substring(0,8)}.pdf`, onedrive_download_url: deal.dip_pdf_url, uploaded_at: deal.dip_issued_at, _by: 'System' }];
  }
  if (deal.ts_pdf_url) {
    systemDocs.termsheet = [{ filename: `Termsheet_${deal.submission_id.substring(0,8)}.docx`, onedrive_download_url: deal.ts_pdf_url, uploaded_at: deal.ts_issued_at, _by: 'System' }];
  }

  // Determine which phases are unlocked
  const phase2Unlocked = !!deal.dip_fee_confirmed;
  const completedStages = ['completed'];
  const phase4Unlocked = completedStages.includes(stage);

  // Count totals
  let totalDocs = 0;
  let approvedCount = 0;
  const onboardingSections = SECTION_DEFS.filter(s => s.phase === 2);
  onboardingSections.forEach(s => {
    if (approval[s.key] && approval[s.key].approved) approvedCount++;
  });

  // Render header
  const summaryEl = document.getElementById('doc-panel-summary');

  // Render sections
  const container = document.getElementById('doc-panel-sections');
  let html = '';

  SECTION_DEFS.forEach(section => {
    const canView = section.viewers.includes(role) || role === 'admin';
    const canUpload = (section.owners.includes(role) || role === 'admin') && !section.system;
    const isGreyed = !canView;
    const isLocked = section.phase === 2 && !phase2Unlocked;
    const isLockedP4 = section.phase === 4 && !phase4Unlocked;

    // Get docs for this section
    let docs = [];
    if (section.system) {
      docs = systemDocs[section.key] || [];
    } else {
      docs = docsByCategory[section.category] || [];
    }
    totalDocs += docs.length;

    // Approval status for phase 2 sections
    const sectionApproval = section.phase === 2 ? approval[section.key] : null;
    const isApproved = sectionApproval && sectionApproval.approved;

    // CSS classes
    let headerClass = 'doc-section-header';
    if (expandedSection === section.key) headerClass += ' expanded';
    if (isApproved) headerClass += ' approved';
    else if (section.phase === 2 && !section.system) headerClass += ' pending';
    if (section.system) headerClass += ' system';

    const sectionClass = 'doc-section' + (isGreyed || isLocked || isLockedP4 ? ' greyed' : '');

    html += `<div class="${sectionClass}" data-section="${section.key}">`;
    html += `<div class="${headerClass}" onclick="window.toggleDocSection('${section.key}')">`;
    html += `<div class="doc-section-label">`;
    html += `<span style="font-size:14px;">${section.icon}</span>`;
    html += `<span>${section.label}</span>`;

    // Status badge
    if (isLocked) {
      html += `<span class="doc-section-badge pend">Locked</span>`;
    } else if (isLockedP4) {
      html += `<span class="doc-section-badge pend">Post-Close</span>`;
    } else if (isApproved) {
      html += `<span class="doc-section-badge ok">Approved</span>`;
    } else if (section.phase === 2 && !section.system) {
      html += `<span class="doc-section-badge pend">Pending</span>`;
    }
    html += `</div>`;

    // Right side: count + chevron
    html += `<div style="display:flex;align-items:center;gap:6px;">`;
    if (docs.length > 0) {
      html += `<span class="doc-count-pill">${docs.length}</span>`;
    }
    html += `<span style="font-size:11px;color:#9ca3af;">${expandedSection === section.key ? '\u25B2' : '\u25BC'}</span>`;
    html += `</div>`;
    html += `</div>`; // close header

    // Expanded body
    if (expandedSection === section.key && canView && !isLocked && !isLockedP4) {
      html += `<div class="doc-section-body">`;

      if (docs.length === 0) {
        html += `<div class="doc-empty">No documents uploaded</div>`;
      } else {
        docs.forEach(doc => {
          const size = doc.file_size ? `(${(doc.file_size / 1024).toFixed(0)} KB)` : '';
          const date = doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
          const by = doc._by || '';
          const dlUrl = doc.onedrive_download_url;

          html += `<div class="doc-file-row">`;
          html += `<div>`;
          html += `<div class="doc-file-name">${sanitizeHtml(doc.filename)}</div>`;
          html += `<div class="doc-file-meta">${[size, date, by].filter(Boolean).join(' \u00B7 ')}</div>`;
          html += `</div>`;
          if (dlUrl) {
            html += `<a href="${sanitizeHtml(dlUrl)}" target="_blank" class="doc-file-dl" title="Download">\u2193</a>`;
          }
          html += `</div>`;
        });
      }

      // Upload zone (only for owners, not system sections)
      if (canUpload && !isLocked && !isLockedP4) {
        html += `<label class="doc-upload-zone">`;
        html += `<input type="file" multiple style="display:none;" onchange="window.uploadToDocPanel('${section.category}', this.files)">`;
        html += `+ Upload to ${section.label}`;
        html += `</label>`;
      }

      html += `</div>`; // close body
    }

    html += `</div>`; // close section
  });

  container.innerHTML = html;

  // Update summary
  if (summaryEl) {
    summaryEl.textContent = `${totalDocs} file${totalDocs !== 1 ? 's' : ''} \u00B7 ${approvedCount}/${onboardingSections.length} sections approved`;
  }

  // Footer
  const footerEl = document.getElementById('doc-panel-footer');
  if (footerEl) {
    const visibleCount = SECTION_DEFS.filter(s => s.viewers.includes(role) || role === 'admin').length;
    footerEl.innerHTML = `<span>Viewing as: <strong style="color:var(--primary);">${role.toUpperCase()}</strong></span>
      <span>${visibleCount}/${SECTION_DEFS.length} sections visible</span>`;
  }
}

/**
 * Toggle a section open/closed
 */
export function toggleDocSection(key) {
  expandedSection = expandedSection === key ? null : key;
  // Re-render with current deal data
  const deal = window.currentDealData;
  if (deal) renderDocPanel(deal);
}

/**
 * Upload files via the doc panel
 */
export async function uploadToDocPanel(category, files) {
  const dealId = getCurrentDealId();
  if (!dealId || !files || files.length === 0) return;

  const formData = new FormData();
  formData.append('category', category);
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    showToast(`Uploading ${files.length} file(s)...`);
    const token = getAuthToken();
    const resp = await fetch(`${API_BASE}/api/deals/${dealId}/upload-categorised`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`${data.documents.length} file(s) uploaded`);
      // Re-render panel
      const deal = window.currentDealData;
      if (deal) renderDocPanel(deal);
    } else {
      showToast(data.error || 'Upload failed', true);
    }
  } catch (err) {
    showToast('Network error uploading', true);
  }
}

/**
 * Hide the doc panel (e.g. when leaving deal detail)
 */
export function hideDocPanel() {
  const sidebar = document.getElementById('deal-doc-sidebar');
  if (sidebar) sidebar.style.display = 'none';
  expandedSection = null;
}
