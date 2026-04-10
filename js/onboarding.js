import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId, getCurrentRole } from './state.js';

/**
 * Save onboarding tab data
 */
export async function saveOnboardingTab(tabName) {
  const dealId = getCurrentDealId();
  if (!dealId) {
    showToast('No deal selected', true);
    return;
  }

  // Tab form field mappings (5 onboarding sections)
  const tabFormMap = {
    kyc: ['kyc-full-name', 'kyc-dob', 'kyc-ni-number', 'kyc-nationality', 'kyc-country-birth', 'kyc-current-address', 'kyc-address-history', 'kyc-pep', 'kyc-source-wealth', 'kyc-source-deposit', 'kyc-ubo-declaration'],
    financials_aml: ['fin-credit-consent', 'fin-adverse', 'fin-mortgage-schedule', 'aml-source-wealth', 'aml-pep', 'aml-utr', 'aml-tax-residency', 'aml-broker-ack', 'aml-conflicts'],
    valuation: ['val-day1-value', 'val-reinstatement', 'val-gdv', 'val-90day', 'val-180day', 'val-solicitor-firm', 'val-sra-number', 'val-solicitor-partner'],
    use_of_funds: ['refurb-contractor-name', 'refurb-contractor-accred', 'refurb-day1', 'refurb-gdv', 'refurb-monitoring', 'uof-redemption-statement', 'uof-schedule-costs'],
    exit_evidence: ['exit-narrative'],
    other_conditions: ['ins-sum-insured', 'oc-sec106', 'oc-planning-conditions', 'oc-other-notes']
  };

  const fields = tabFormMap[tabName] || [];
  const data = {};
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) data[id] = el.value;
  });

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: tabName, data })
    });

    const result = await resp.json();
    if (resp.ok) {
      showToast(`${tabName.replace(/_/g, ' ')} data saved successfully`);
    } else {
      showToast(result.error || 'Failed to save', true);
    }
  } catch (err) {
    showToast('Network error — could not save', true);
  }
}

/**
 * AI Auto-Fill — read uploaded docs and extract data into form fields
 */
export async function aiAutoFill(section) {
  const dealId = getCurrentDealId();
  if (!dealId) {
    showToast('No deal selected', true);
    return;
  }

  const btn = document.getElementById(`ai-fill-${section}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Reading Documents...';
  }

  try {
    showToast('Reading your documents and extracting data...');
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/ai-extract/${section}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await resp.json();
    if (resp.ok && data.extracted) {
      const fields = Object.entries(data.extracted);
      if (fields.length === 0) {
        showToast('AI could not extract data — try uploading clearer documents', true);
        return;
      }

      // Auto-fill each field with extracted data
      let filled = 0;
      fields.forEach(([fieldId, value]) => {
        const el = document.getElementById(fieldId);
        if (el && value) {
          // Highlight the field to show it was AI-filled
          el.value = value;
          el.style.borderColor = '#10b981';
          el.style.backgroundColor = '#f0fdf4';
          setTimeout(() => {
            el.style.borderColor = '';
            el.style.backgroundColor = '';
          }, 5000);
          filled++;
        }
      });

      showToast(`AI filled ${filled} field(s) from ${section.replace(/_/g, ' ')} documents. Please review before saving.`);
    } else {
      showToast(data.error || data.message || 'Auto-fill extraction failed', true);
    }
  } catch (err) {
    console.error('[ai-auto-fill] Error:', err);
    showToast('Network error during extraction', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '&#x1F916; Auto-Fill from Documents';
    }
  }
}

/**
 * Populate onboarding form with existing data
 */
export function populateOnboardingData(onboardingData) {
  if (!onboardingData) return;
  Object.keys(onboardingData).forEach(tab => {
    const tabData = onboardingData[tab];
    if (!tabData) return;
    Object.keys(tabData).forEach(fieldId => {
      if (fieldId === 'updated_at') return;
      const el = document.getElementById(fieldId);
      if (el) el.value = sanitizeHtml(tabData[fieldId]);
    });
  });
}

/**
 * Switch detail tabs
 */
export function switchDetailTab(btn) {
  if (!btn) return;
  const tabId = btn.dataset.dtab;

  // Block locked Phase 2 tabs
  if (btn.classList.contains('locked')) {
    showToast('This section unlocks after the onboarding fee is confirmed.', true);
    return;
  }

  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('active');
}

/**
 * Check broker onboarding status
 */
export async function checkBrokerOnboardingStatus() {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (resp.ok && !data.completed) {
      // Show onboarding modal or prompt
      showBrokerOnboarding();
    }
  } catch (err) {
    console.error('Error checking onboarding status:', err);
  }
}

/**
 * Show broker onboarding modal
 */
export function showBrokerOnboarding() {
  const modal = document.getElementById('broker-onboarding-modal');
  if (modal) {
    modal.style.display = 'block';
    loadBrokerOnboarding();
  }
}

/**
 * Hide broker onboarding modal
 */
export function hideBrokerOnboarding() {
  const modal = document.getElementById('broker-onboarding-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

/**
 * Toggle broker company fields
 */
export function toggleBrokerCompanyFields() {
  const isCompany = document.getElementById('bonb-is-company')?.checked;
  const companyFields = document.getElementById('broker-company-fields');
  if (companyFields) {
    companyFields.style.display = isCompany ? 'block' : 'none';
  }
}

/**
 * Load broker onboarding form (pre-fill from saved data)
 */
export async function loadBrokerOnboarding() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (resp.ok && data.onboarding) {
      const o = data.onboarding;
      if (o.individual_name) {
        document.getElementById('bonb-name').value = sanitizeHtml(o.individual_name);
      }
      if (o.date_of_birth) {
        document.getElementById('bonb-dob').value = o.date_of_birth.substring(0, 10);
      }
      if (o.is_company) {
        const checkbox = document.getElementById('bonb-is-company');
        if (checkbox) checkbox.checked = true;
        const companyFields = document.getElementById('broker-company-fields');
        if (companyFields) companyFields.style.display = 'block';
        if (o.company_name) {
          document.getElementById('bonb-company-name').value = sanitizeHtml(o.company_name);
        }
        if (o.company_number) {
          document.getElementById('bonb-company-number').value = sanitizeHtml(o.company_number);
        }
      }
      if (o.bank_name) {
        document.getElementById('bonb-bank-name').value = sanitizeHtml(o.bank_name);
      }
      if (o.bank_account_name) {
        document.getElementById('bonb-account-name').value = sanitizeHtml(o.bank_account_name);
      }
      if (o.bank_sort_code) {
        document.getElementById('bonb-sort-code').value = sanitizeHtml(o.bank_sort_code);
      }
      if (o.bank_account_no) {
        document.getElementById('bonb-account-no').value = sanitizeHtml(o.bank_account_no);
      }
    }
  } catch (err) {
    console.error('Error loading broker onboarding:', err);
  }
}

/**
 * Save broker onboarding (KYC + bank details)
 */
/**
 * Inject RM approval controls, doc upload zones, and status badges into each Phase 2 tab
 */
export function injectOnboardingSectionControls(deal) {
  const approval = deal.onboarding_approval || {};
  const currentRole = getCurrentRole() || 'broker';
  const isRM = ['rm', 'admin'].includes(currentRole);
  const isInternal = ['rm', 'admin', 'credit', 'compliance'].includes(currentRole);

  // Section config: key → { tabFormId, label, category } — 5 onboarding sections
  const sections = {
    kyc:              { formId: 'kyc-form',              label: 'KYC / Identity',     category: 'kyc' },
    financials_aml:   { formId: 'financials-aml-form',   label: 'Financials / AML',   category: 'financials_aml' },
    valuation:        { formId: 'valuation-form',        label: 'Valuation',          category: 'valuation' },
    use_of_funds:     { formId: 'use-of-funds-form',     label: 'Use of Funds',       category: 'use_of_funds' },
    exit_evidence:    { formId: 'exit-form',             label: 'Exit Evidence',      category: 'exit_evidence' },
    other_conditions: { formId: 'other-conditions-form', label: 'Other Conditions',   category: 'other_conditions' }
  };

  Object.entries(sections).forEach(([key, cfg]) => {
    const form = document.getElementById(cfg.formId);
    if (!form) return;

    // Remove any previously injected controls
    form.querySelectorAll('.onboarding-section-controls').forEach(el => el.remove());

    const sectionApproval = approval[key];
    const isApproved = sectionApproval && sectionApproval.approved;

    // Build the control bar
    const controlBar = document.createElement('div');
    controlBar.className = 'onboarding-section-controls';
    controlBar.style.cssText = 'background:#f8fafc;border:2px solid ' + (isApproved ? '#22c55e' : '#e2e8f0') + ';border-radius:8px;padding:12px 16px;margin-bottom:16px;';

    let controlHtml = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">`;
    controlHtml += `<div style="display:flex;align-items:center;gap:8px;">`;

    if (isApproved) {
      const approvedDate = new Date(sectionApproval.approved_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      controlHtml += `<span style="display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#15803d;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;">
        <span style="font-size:14px;">&#10003;</span> RM Approved — ${approvedDate}</span>`;
      if (sectionApproval.notes) {
        controlHtml += `<span style="font-size:11px;color:#666;">Note: ${sanitizeHtml(sectionApproval.notes)}</span>`;
      }
    } else {
      controlHtml += `<span style="display:inline-flex;align-items:center;gap:4px;background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;">
        <span style="font-size:14px;">&#9711;</span> Pending RM Review</span>`;
    }
    controlHtml += `</div>`;

    // RM can approve/unapprove sections
    if (isRM && !isApproved) {
      controlHtml += `<button onclick="window.approveOnboardingSection('${key}')"
        style="padding:6px 14px;background:#22c55e;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">
        Approve ${cfg.label}</button>`;
    } else if (isRM && isApproved) {
      controlHtml += `<button onclick="window.approveOnboardingSection('${key}', false)"
        style="padding:6px 14px;background:#ef4444;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">
        Revoke Approval</button>`;
    }
    controlHtml += `</div>`;

    // Document upload zone
    controlHtml += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-size:12px;font-weight:600;color:#374151;">Uploaded Documents — ${cfg.label}</span>
        <label style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--primary);color:white;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">
          <input type="file" multiple style="display:none;" onchange="window.uploadSectionDocs('${key}', this.files)">
          + Upload Files
        </label>
      </div>
      <div id="section-docs-${key}" style="font-size:12px;color:#6b7280;">Loading...</div>
    </div>`;

    controlBar.innerHTML = controlHtml;
    form.insertBefore(controlBar, form.firstChild);
  });

  // Load document counts for each section
  loadSectionDocuments(deal.submission_id);
}

/**
 * Load and display documents per onboarding section
 */
async function loadSectionDocuments(submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/documents-by-category`, { method: 'GET' });
    const data = await resp.json();
    if (!resp.ok) return;

    const docsByCategory = {};
    (data.documents || []).forEach(doc => {
      const cat = doc.doc_category || 'general';
      if (!docsByCategory[cat]) docsByCategory[cat] = [];
      docsByCategory[cat].push(doc);
    });

    const sectionKeys = ['kyc', 'financials_aml', 'valuation', 'use_of_funds', 'exit_evidence', 'other_conditions'];
    sectionKeys.forEach(key => {
      const container = document.getElementById(`section-docs-${key}`);
      if (!container) return;

      const docs = docsByCategory[key] || [];
      if (docs.length === 0) {
        container.innerHTML = '<span style="color:#9ca3af;">No documents uploaded yet</span>';
        return;
      }

      container.innerHTML = docs.map(doc => {
        const size = doc.file_size ? `(${(doc.file_size / 1024).toFixed(0)} KB)` : '';
        const date = new Date(doc.uploaded_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
        const downloadLink = doc.onedrive_download_url
          ? `<a href="${sanitizeHtml(doc.onedrive_download_url)}" target="_blank" style="color:var(--primary);text-decoration:none;">&#8595;</a>`
          : '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #f1f5f9;">
          <span style="color:#374151;">${sanitizeHtml(doc.filename)} <span style="color:#9ca3af;">${size}</span></span>
          <span style="color:#9ca3af;font-size:11px;">${date} ${downloadLink}</span>
        </div>`;
      }).join('');
    });
  } catch (err) {
    console.error('[loadSectionDocuments] Error:', err);
  }
}

/**
 * Upload documents with category for an onboarding section
 */
export async function uploadSectionDocs(sectionKey, files) {
  const dealId = getCurrentDealId();
  if (!dealId || !files || files.length === 0) return;

  const formData = new FormData();
  formData.append('category', sectionKey);
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    showToast(`Uploading ${files.length} file(s) to ${sectionKey.replace(/_/g, ' ')}...`);
    const token = getAuthToken();
    const resp = await fetch(`${API_BASE}/api/deals/${dealId}/upload-categorised`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`${data.documents.length} file(s) uploaded successfully`);
      // Reload deal to refresh doc list
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Upload failed', true);
    }
  } catch (err) {
    showToast('Network error uploading files', true);
  }
}

/**
 * Approve (or revoke) an onboarding section
 */
export async function approveOnboardingSection(sectionKey, approved = true) {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  const action = approved ? 'approve' : 'revoke approval for';
  if (!confirm(`Are you sure you want to ${action} the ${sectionKey.replace(/_/g, ' ')} section?`)) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/approve-onboarding-section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: sectionKey, approved })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`${sectionKey.replace(/_/g, ' ')} ${approved ? 'approved' : 'approval revoked'}`);
      if (data.all_sections_approved) {
        showToast('All onboarding sections approved! You can now generate the indicative termsheet.', false);
      }
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to update approval', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Confirm onboarding fee (RM action — unlocks Phase 2)
 */
export async function confirmOnboardingFee() {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  if (!confirm('Confirm that the onboarding fee has been received? This will unlock the full onboarding section for the deal.')) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/confirm-onboarding-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Onboarding fee confirmed — Full Onboarding is now unlocked!');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to confirm fee', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * RM sign-off on AI termsheet
 */
export async function rmSignoff() {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  const notes = document.getElementById('rm-signoff-notes')?.value || '';
  if (!confirm('Sign off on the AI-generated termsheet? This will send it to Credit for final review.')) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/rm-signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('RM sign-off recorded. Termsheet sent to Credit for review.');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to sign off', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Credit sign-off on AI termsheet
 */
export async function creditSignoff(decision) {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  const notes = document.getElementById('credit-signoff-notes')?.value || '';
  const labels = { approve: 'approve', decline: 'decline', moreinfo: 'request more information on' };
  if (!confirm(`Are you sure you want to ${labels[decision] || decision} this termsheet?`)) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/credit-signoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, notes })
    });
    const data = await resp.json();
    if (resp.ok) {
      const msg = decision === 'approve'
        ? 'Credit approved — termsheet ready for formal issuance!'
        : decision === 'decline'
          ? 'Credit declined the termsheet.'
          : 'More info requested — RM will need to address queries.';
      showToast(msg);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record decision', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

export async function saveBrokerOnboarding() {
  const name = document.getElementById('bonb-name')?.value.trim();
  const dob = document.getElementById('bonb-dob')?.value;
  const isCompany = document.getElementById('bonb-is-company')?.checked;
  const companyName = document.getElementById('bonb-company-name')?.value.trim();
  const companyNumber = document.getElementById('bonb-company-number')?.value.trim();
  const bankName = document.getElementById('bonb-bank-name')?.value.trim();
  const accountName = document.getElementById('bonb-account-name')?.value.trim();
  const sortCode = document.getElementById('bonb-sort-code')?.value.trim();
  const accountNo = document.getElementById('bonb-account-no')?.value.trim();

  if (!name || !bankName || !accountName || !sortCode || !accountNo) {
    showToast('Please fill in all required fields (name, bank details)', true);
    return;
  }

  const btn = document.getElementById('bonb-submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        individual_name: name,
        date_of_birth: dob || null,
        is_company: isCompany || false,
        company_name: companyName || null,
        company_number: companyNumber || null,
        bank_name: bankName,
        bank_sort_code: sortCode,
        bank_account_no: accountNo,
        bank_account_name: accountName
      })
    });

    const data = await resp.json();
    if (resp.ok) {
      const successEl = document.getElementById('bonb-success');
      if (successEl) successEl.style.display = 'block';
      showToast('Broker onboarding submitted for review');
    } else {
      showToast(data.error || 'Failed to save', true);
    }
  } catch (err) {
    showToast('Network error', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save & Submit for Review';
    }
  }
}
