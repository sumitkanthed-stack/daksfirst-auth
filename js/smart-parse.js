import { API_BASE } from './config.js';
import { showToast, sanitizeHtml, formatNumber } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { setSmartParsedData, setSmartParseSessionId, getSmartParsedData, getSmartParseSessionId } from './state.js';

/**
 * Handle smart parse file drop
 */
export function handleSmartDrop(event) {
  event.preventDefault();
  event.currentTarget.style.borderColor = '#D4A853';
  event.currentTarget.style.background = 'rgba(212,168,83,0.15)';
  const files = event.dataTransfer.files;
  if (files.length > 0) processSmartFiles(files);
}

/**
 * Handle smart parse file select
 */
export function handleSmartFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) processSmartFiles(files);
  event.target.value = ''; // Reset so same file can be selected again
}

/**
 * Toggle WhatsApp paste input
 */
export function toggleWhatsappPaste() {
  const area = document.getElementById('whatsapp-paste-area');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

/**
 * Handle WhatsApp text submission
 */
export async function handleWhatsappSubmit() {
  const text = document.getElementById('whatsapp-text-input')?.value.trim();
  if (!text) {
    showToast('Please paste some text first', true);
    return;
  }
  await uploadAndParse(null, text);
}

/**
 * Process smart parse files — show deal picker first
 */
let _pendingFiles = null;

export async function processSmartFiles(fileList) {
  const files = Array.from(fileList);
  const maxSize = 25 * 1024 * 1024; // 25MB per file
  const validFiles = files.filter(f => f.size <= maxSize);

  if (validFiles.length === 0) {
    showToast('All files exceed the 25MB limit', true);
    return;
  }

  // Store files and show deal picker modal
  _pendingFiles = validFiles;
  showDealPickerModal(validFiles);
}

/**
 * Show modal asking: new deal or existing deal?
 */
async function showDealPickerModal(files) {
  // Fetch existing deals to populate the dropdown
  let existingDeals = [];
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals`, { method: 'GET' });
    if (resp.ok) {
      const data = await resp.json();
      existingDeals = (data.deals || []).filter(d => !['completed', 'declined', 'withdrawn'].includes(d.deal_stage));
    }
  } catch (e) { /* proceed with empty list */ }

  const fileListHtml = files.map(f => {
    const sizeStr = (f.size / 1024 / 1024).toFixed(2);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
      <div style="width:6px;height:6px;border-radius:50%;background:#D4A853;flex-shrink:0;"></div>
      <span style="font-size:12px;color:#F1F5F9;flex:1;">${sanitizeHtml(f.name)}</span>
      <span style="font-size:11px;color:#64748B;">${sizeStr} MB</span>
    </div>`;
  }).join('');

  const dealOptions = existingDeals.map(d => {
    const borrower = d.borrower_name || 'No borrower';
    const loan = d.loan_amount ? ' · £' + (Number(d.loan_amount) / 1000).toFixed(0) + 'k' : '';
    const ref = d.submission_id.substring(0, 8);
    return `<option value="${sanitizeHtml(d.submission_id)}">${sanitizeHtml(ref)} — ${sanitizeHtml(borrower)}${loan}</option>`;
  }).join('');

  let modal = document.getElementById('deal-picker-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'deal-picker-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
  modal.innerHTML = `
    <div style="background:#1a2332;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:500px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="font-size:16px;font-weight:700;color:#F1F5F9;margin-bottom:4px;">${files.length} file${files.length > 1 ? 's' : ''} ready to upload</div>
      <div style="font-size:11px;color:#94A3B8;margin-bottom:14px;">Where should these documents go?</div>

      <div style="background:#0f1729;border-radius:8px;padding:10px 12px;margin-bottom:16px;max-height:120px;overflow-y:auto;">
        ${fileListHtml}
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">
        <label style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0f1729;border:2px solid rgba(212,168,83,0.3);border-radius:8px;cursor:pointer;transition:all .15s;" onclick="document.getElementById('dp-new').checked=true;document.getElementById('dp-existing-select').style.display='none';">
          <input type="radio" name="dp-mode" id="dp-new" value="new" checked style="accent-color:#D4A853;">
          <div>
            <div style="font-size:13px;font-weight:700;color:#F1F5F9;">New Deal</div>
            <div style="font-size:11px;color:#94A3B8;">AI will extract deal details and create a new submission</div>
          </div>
        </label>

        <label style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0f1729;border:2px solid rgba(255,255,255,0.06);border-radius:8px;cursor:pointer;transition:all .15s;" onclick="document.getElementById('dp-existing').checked=true;document.getElementById('dp-existing-select').style.display='block';">
          <input type="radio" name="dp-mode" id="dp-existing" value="existing" style="accent-color:#D4A853;">
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:700;color:#F1F5F9;">Existing Deal</div>
            <div style="font-size:11px;color:#94A3B8;">Add documents to a deal already in progress</div>
          </div>
        </label>

        <select id="dp-existing-select" style="display:none;width:100%;padding:10px 12px;background:#0f1729;color:#F1F5F9;border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;outline:none;">
          <option value="">— Select a deal —</option>
          ${dealOptions}
        </select>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button onclick="document.getElementById('deal-picker-modal').remove()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94A3B8;cursor:pointer;">Cancel</button>
        <button onclick="window.confirmDealPicker()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;border:none;background:#D4A853;color:#0B1120;cursor:pointer;">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

/**
 * Handle deal picker confirmation
 */
window.confirmDealPicker = async function() {
  const mode = document.querySelector('input[name="dp-mode"]:checked')?.value;
  const existingDealId = document.getElementById('dp-existing-select')?.value;

  if (mode === 'existing' && !existingDealId) {
    showToast('Please select a deal', true);
    return;
  }

  document.getElementById('deal-picker-modal')?.remove();

  if (mode === 'existing' && existingDealId) {
    // Upload docs to existing deal's document repository
    await uploadDocsToExistingDeal(existingDealId, _pendingFiles);
  } else {
    // Original flow — show file list and parse for new deal
    showFileListAndParse(_pendingFiles);
  }
  _pendingFiles = null;
};

/**
 * Upload documents to an existing deal
 */
async function uploadDocsToExistingDeal(dealId, files) {
  showToast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''} to deal...`, 'info');

  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('category', 'uncategorised');
      formData.append('section', 'general');

      const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/documents`, {
        method: 'POST',
        body: formData
      });

      if (resp.ok) {
        showToast(`Uploaded: ${file.name}`, 'success');
      } else {
        showToast(`Failed to upload: ${file.name}`, true);
      }
    } catch (e) {
      showToast(`Error uploading: ${file.name}`, true);
    }
  }

  showToast('All documents uploaded. Opening deal...', 'success');
  // Navigate to the deal
  setTimeout(() => {
    import('./deal-detail.js').then(m => m.showDealDetail(dealId));
  }, 1000);
}

/**
 * Original flow: show file list progress and parse for new deal
 */
function showFileListAndParse(files) {
  const progressDiv = document.getElementById('smart-upload-progress');
  const fileListDiv = document.getElementById('smart-file-list');
  progressDiv.style.display = 'block';

  fileListDiv.innerHTML = files.map(f => {
    const icon = f.type.includes('pdf') ? '📄' : f.type.includes('word') || f.name.endsWith('.docx') ? '📝' : f.type.includes('sheet') || f.name.endsWith('.xlsx') || f.name.endsWith('.csv') ? '📊' : f.type.includes('image') ? '🖼️' : '📎';
    const sizeStr = (f.size / 1024 / 1024).toFixed(2);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px rgba(255,255,255,0.06);">
      <span style="font-size:20px;">${icon}</span>
      <div style="flex:1;"><div style="font-weight:500;font-size:0.9rem;color:#F1F5F9;">${f.name}</div><div style="font-size:0.8rem;color:#64748B;">${sizeStr} MB</div></div>
      <span style="color:#34D399;font-size:0.8rem;">Ready</span>
    </div>`;
  }).join('');

  const whatsappText = document.getElementById('whatsapp-text-input')?.value.trim() || null;
  uploadAndParse(files, whatsappText);
}

/**
 * Upload and parse files or text
 */
export async function uploadAndParse(files, whatsappText) {
  const progressDiv = document.getElementById('smart-upload-progress');
  const statusDiv = document.getElementById('smart-upload-status');
  progressDiv.style.display = 'block';

  statusDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;"><span class="spinner" style="border-color:rgba(212,168,83,0.2);border-top-color:#D4A853;width:20px;height:20px;"></span> Uploading & parsing with AI... This may take up to 2 minutes.</div>';

  try {
    const formData = new FormData();
    if (files) {
      for (const file of files) {
        formData.append('files', file);
      }
    }
    if (whatsappText) {
      formData.append('whatsapp_text', whatsappText);
    }

    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await resp.json();

    if (!resp.ok) {
      statusDiv.innerHTML = `<span style="color:#F87171;">${data.error || 'Upload failed'}</span>`;
      return;
    }

    setSmartParseSessionId(data.parse_session_id);

    if (data.parsed_data) {
      // AI returned parsed data — show review form
      setSmartParsedData(data.parsed_data);
      populateSmartParseForm(data.parsed_data);
      statusDiv.innerHTML = '<span style="color:#34D399;font-weight:600;">AI parsing complete! Review the extracted data below.</span>';
    } else {
      // No AI parsing configured — show empty review form for manual entry
      setSmartParsedData({});
      statusDiv.innerHTML = '<span style="color:#D4A853;">Files uploaded. AI parsing not configured — please fill in details manually.</span>';
    }

    // Show the review form
    document.getElementById('smart-parse-review').style.display = 'block';

    // Populate existing deals dropdown
    populateExistingDealsDropdown();

    // Scroll to review
    document.getElementById('smart-parse-review').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    console.error('Smart parse error:', err);
    statusDiv.innerHTML = '<span style="color:#F87171;">Network error. Please try again.</span>';
  }
}

/**
 * Populate smart parse form with parsed data
 */
export function populateSmartParseForm(pd) {
  if (!pd) return;

  // Auto-calculate indicative loan amount and LTV if not provided
  // Rule: Max 75% LTV (of value) or 90% LTC (of purchase price + refurb), whichever is LOWER
  const currentVal = pd.current_value ? parseFloat(String(pd.current_value).replace(/[£$,]/g, '')) : null;
  const purchasePrice = pd.purchase_price ? parseFloat(String(pd.purchase_price).replace(/[£$,]/g, '')) : null;
  const refurbCost = pd.refurb_cost ? parseFloat(String(pd.refurb_cost).replace(/[£$,]/g, '')) : 0;
  let loanIsIndicative = false;
  let ltvIsIndicative = false;

  if (!pd.loan_amount && (currentVal || purchasePrice)) {
    const maxByLtv = currentVal ? currentVal * 0.75 : Infinity;
    const totalCost = purchasePrice ? purchasePrice + refurbCost : Infinity;
    const maxByLtc = totalCost < Infinity ? totalCost * 0.90 : Infinity;
    const indicativeLoan = Math.min(maxByLtv, maxByLtc);
    if (indicativeLoan < Infinity) {
      pd.loan_amount = Math.round(indicativeLoan);
      loanIsIndicative = true;
    }
  }
  if (!pd.ltv_requested && pd.loan_amount && currentVal && currentVal > 0) {
    pd.ltv_requested = Math.round((parseFloat(pd.loan_amount) / currentVal) * 100);
    ltvIsIndicative = true;
  }

  const fieldMap = {
    'sp-borrower-name': pd.borrower_name, 'sp-borrower-company': pd.borrower_company,
    'sp-borrower-email': pd.borrower_email, 'sp-borrower-phone': pd.borrower_phone,
    'sp-broker-name': pd.broker_name, 'sp-broker-company': pd.broker_company,
    'sp-security-address': pd.security_address, 'sp-postcode': pd.security_postcode,
    'sp-asset-type': pd.asset_type, 'sp-current-value': pd.current_value,
    'sp-purchase-price': pd.purchase_price, 'sp-loan-amount': pd.loan_amount,
    'sp-ltv': pd.ltv_requested, 'sp-loan-purpose': pd.loan_purpose,
    'sp-term': pd.term_months, 'sp-rate': pd.rate_requested,
    'sp-exit-strategy': pd.exit_strategy, 'sp-use-of-funds': pd.use_of_funds,
    'sp-notes': pd.additional_notes
  };
  for (const [id, val] of Object.entries(fieldMap)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }

  // Mark indicative fields with a visual cue
  if (loanIsIndicative) {
    const loanEl = document.getElementById('sp-loan-amount');
    if (loanEl) {
      loanEl.style.borderColor = '#D4A853';
      loanEl.style.background = 'rgba(212,168,83,0.15)';
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#FBBF24;margin-top:2px;';
      hint.textContent = 'Indicative max — 75% LTV or 90% LTC (whichever lower). RM to confirm in DIP.';
      loanEl.parentNode.appendChild(hint);
    }
  }
  if (ltvIsIndicative) {
    const ltvEl = document.getElementById('sp-ltv');
    if (ltvEl) {
      ltvEl.style.borderColor = '#D4A853';
      ltvEl.style.background = 'rgba(212,168,83,0.15)';
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#FBBF24;margin-top:2px;';
      hint.textContent = 'Indicative — calculated from loan/value. Max 75%.';
      ltvEl.parentNode.appendChild(hint);
    }
  }

  // Show confidence if available
  if (pd.confidence) {
    const confDiv = document.getElementById('sp-confidence');
    const pct = Math.round(pd.confidence * 100);
    const color = pct >= 80 ? '#34D399' : pct >= 50 ? '#D4A853' : '#F87171';
    confDiv.style.display = 'block';
    confDiv.style.background = pct >= 80 ? 'rgba(52,211,153,0.1)' : pct >= 50 ? 'rgba(212,168,83,0.15)' : 'rgba(248,113,113,0.1)';
    confDiv.style.borderLeft = `4px solid ${color}`;
    confDiv.innerHTML = `AI Confidence: <strong style="color:${color};">${pct}%</strong> — ${pct >= 80 ? 'High confidence extraction.' : pct >= 50 ? 'Some fields may need manual correction.' : 'Low confidence — please verify all fields carefully.'}`;
  }
}

/**
 * Populate existing deals dropdown
 */
export async function populateExistingDealsDropdown() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals`, {
      method: 'GET'
    });
    const data = await resp.json();
    if (data.deals && data.deals.length > 0) {
      const sel = document.getElementById('smart-existing-deal');
      sel.innerHTML = '<option value="">-- Select a deal to update --</option>';
      data.deals.forEach(d => {
        sel.innerHTML += `<option value="${d.submission_id}">${d.submission_id.substring(0,8)} — ${d.security_address || d.borrower_name || 'Untitled'} (£${formatNumber(d.loan_amount || 0)})</option>`;
      });
    }
  } catch (err) {
    console.error('Error loading deals:', err);
  }
}

/**
 * Toggle existing deal selection
 */
export function toggleExistingDealSelect() {
  const sel = document.getElementById('smart-existing-deal');
  const mode = document.querySelector('input[name="smart-mode"]:checked')?.value;
  sel.style.display = mode === 'existing' ? 'block' : 'none';
}

/**
 * Cancel smart parse
 */
export function cancelSmartParse() {
  document.getElementById('smart-parse-review').style.display = 'none';
  document.getElementById('smart-upload-progress').style.display = 'none';
  // Clear form
  document.querySelectorAll('#smart-parse-review input, #smart-parse-review textarea, #smart-parse-review select').forEach(el => {
    if (el.type === 'radio') return;
    el.value = el.tagName === 'SELECT' ? '' : '';
  });
  setSmartParsedData(null);
  setSmartParseSessionId(null);
}

/**
 * Confirm and apply smart parse data
 */
export async function confirmSmartParse() {
  // Collect form values
  const parsed_data = {
    borrower_name: document.getElementById('sp-borrower-name')?.value || null,
    borrower_company: document.getElementById('sp-borrower-company')?.value || null,
    borrower_email: document.getElementById('sp-borrower-email')?.value || null,
    borrower_phone: document.getElementById('sp-borrower-phone')?.value || null,
    broker_name: document.getElementById('sp-broker-name')?.value || null,
    broker_company: document.getElementById('sp-broker-company')?.value || null,
    security_address: document.getElementById('sp-security-address')?.value || null,
    security_postcode: document.getElementById('sp-postcode')?.value || null,
    asset_type: document.getElementById('sp-asset-type')?.value || null,
    current_value: document.getElementById('sp-current-value')?.value || null,
    purchase_price: document.getElementById('sp-purchase-price')?.value || null,
    loan_amount: document.getElementById('sp-loan-amount')?.value || null,
    ltv_requested: document.getElementById('sp-ltv')?.value || null,
    loan_purpose: document.getElementById('sp-loan-purpose')?.value || null,
    term_months: document.getElementById('sp-term')?.value || null,
    rate_requested: document.getElementById('sp-rate')?.value || null,
    exit_strategy: document.getElementById('sp-exit-strategy')?.value || null,
    use_of_funds: document.getElementById('sp-use-of-funds')?.value || null,
    additional_notes: document.getElementById('sp-notes')?.value || null
  };

  // Validate required fields
  if (!parsed_data.security_address && !parsed_data.loan_amount && !parsed_data.loan_purpose) {
    showToast('Please fill in at least: security address, loan amount, or loan purpose', true);
    return;
  }

  const mode = document.querySelector('input[name="smart-mode"]:checked')?.value;
  const existingDealId = mode === 'existing' ? document.getElementById('smart-existing-deal')?.value : null;

  if (mode === 'existing' && !existingDealId) {
    showToast('Please select an existing deal to update', true);
    return;
  }

  const btn = document.getElementById('sp-confirm-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting...';

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parsed_data,
        deal_id: existingDealId || null,
        parse_session_id: getSmartParseSessionId()
      })
    });

    const data = await resp.json();

    if (resp.ok) {
      showToast(data.message || 'Deal submitted successfully!');
      cancelSmartParse();
      // Reload deals list
      import('./deals.js').then(m => m.loadUserDeals());
      // If new deal was created, go to it
      if (data.deal && data.deal.submission_id) {
        import('./deal-detail.js').then(m => m.showDealDetail(data.deal.submission_id));
      }
    } else {
      showToast(data.error || 'Failed to submit deal', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }

  btn.disabled = false;
  btn.textContent = 'Confirm & Submit Deal';
}

/**
 * Apply smart parse data to new deal form
 */
function applySmartParseToNewDeal(parsedData) {
  // Navigate to deal form
  import('./deals.js').then(m => m.showDealForm());

  // Apply data to form fields
  setTimeout(() => {
    if (parsedData.deal) {
      const deal = parsedData.deal;
      if (deal.loan_amount) {
        const el = document.getElementById('deal-loan-amount');
        if (el) el.value = deal.loan_amount;
      }
      if (deal.loan_purpose) {
        const el = document.getElementById('deal-purpose');
        if (el) el.value = deal.loan_purpose;
      }
      if (deal.exit_strategy) {
        const el = document.getElementById('deal-exit');
        if (el) el.value = deal.exit_strategy;
      }
    }

    if (parsedData.borrower) {
      const bor = parsedData.borrower;
      if (bor.name) {
        const el = document.getElementById('deal-borrower-name');
        if (el) el.value = bor.name;
      }
      if (bor.email) {
        const el = document.getElementById('deal-borrower-email');
        if (el) el.value = bor.email;
      }
    }

    if (parsedData.property) {
      const prop = parsedData.property;
      if (prop.address) {
        const el = document.getElementById('deal-address');
        if (el) el.value = prop.address;
      }
      if (prop.postcode) {
        const el = document.getElementById('deal-postcode');
        if (el) el.value = prop.postcode;
      }
      if (prop.current_value) {
        const el = document.getElementById('deal-value');
        if (el) el.value = prop.current_value;
      }
    }
  }, 100);
}

/**
 * Apply smart parse data to existing deal
 */
async function applySmartParseToExistingDeal(dealId, parsedData) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsed_data: parsedData, deal_id: dealId })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('Smart parse data applied to deal');
      // Reload deal detail
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to apply data', true);
    }
  } catch (err) {
    showToast('Error applying smart parse data', true);
  }
}
