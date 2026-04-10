import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { setSmartParsedData, setSmartParseSessionId, getSmartParsedData, getSmartParseSessionId } from './state.js';

/**
 * Handle smart parse file drop
 */
export function handleSmartDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  const zone = document.getElementById('smart-drop-zone');
  if (zone) zone.classList.remove('active');
  const files = event.dataTransfer.files;
  if (files) processSmartFiles(files);
}

/**
 * Handle smart parse file select
 */
export function handleSmartFileSelect(event) {
  const files = event.target.files;
  if (files) processSmartFiles(files);
}

/**
 * Toggle WhatsApp paste input
 */
export function toggleWhatsappPaste() {
  const textarea = document.getElementById('whatsapp-textarea');
  if (textarea) {
    textarea.style.display = textarea.style.display === 'none' ? 'block' : 'none';
  }
}

/**
 * Handle WhatsApp text submission
 */
export async function handleWhatsappSubmit() {
  const text = document.getElementById('whatsapp-textarea').value.trim();
  if (!text) {
    showToast('Please paste some text', true);
    return;
  }
  await uploadAndParse([], text);
}

/**
 * Process smart parse files
 */
export async function processSmartFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const zone = document.getElementById('smart-drop-zone');
  if (zone) zone.classList.add('active');

  showToast('Processing files...');
  await uploadAndParse(fileList, null);
}

/**
 * Upload and parse files or text
 */
export async function uploadAndParse(fileList, whatsappText) {
  try {
    const formData = new FormData();

    if (fileList && fileList.length > 0) {
      for (let i = 0; i < fileList.length; i++) {
        formData.append('files', fileList[i]);
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

    if (resp.ok) {
      setSmartParsedData(data.parsed_data);
      setSmartParseSessionId(data.session_id);
      populateSmartParseForm(data.parsed_data);
      showToast('Files parsed successfully');
    } else {
      showToast(data.error || 'Parse failed', true);
    }
  } catch (err) {
    showToast('Error parsing files', true);
  }
}

/**
 * Populate smart parse form with parsed data
 */
export function populateSmartParseForm(parsedData) {
  if (!parsedData) return;

  // Deal overview
  if (parsedData.deal) {
    const deal = parsedData.deal;
    if (deal.loan_amount) document.getElementById('parsed-loan-amount').value = deal.loan_amount;
    if (deal.loan_purpose) document.getElementById('parsed-loan-purpose').value = deal.loan_purpose;
    if (deal.exit_strategy) document.getElementById('parsed-exit-strategy').value = deal.exit_strategy;
  }

  // Borrower
  if (parsedData.borrower) {
    const bor = parsedData.borrower;
    if (bor.name) document.getElementById('parsed-borrower-name').value = bor.name;
    if (bor.email) document.getElementById('parsed-borrower-email').value = bor.email;
    if (bor.type) document.getElementById('parsed-borrower-type').value = bor.type;
  }

  // Property
  if (parsedData.property) {
    const prop = parsedData.property;
    if (prop.address) document.getElementById('parsed-property-address').value = prop.address;
    if (prop.postcode) document.getElementById('parsed-property-postcode').value = prop.postcode;
    if (prop.asset_type) document.getElementById('parsed-asset-type').value = prop.asset_type;
    if (prop.current_value) document.getElementById('parsed-property-value').value = prop.current_value;
  }

  // Show form
  const form = document.getElementById('smart-parse-form');
  if (form) form.style.display = 'block';

  // Show populate existing deals dropdown
  populateExistingDealsDropdown();
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
    if (!resp.ok) return;

    const deals = data.deals || [];
    const select = document.getElementById('existing-deal-select');
    if (!select) return;

    select.innerHTML = '<option value="">-- Create New Deal --</option>';
    deals.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.submission_id;
      opt.textContent = `${d.submission_id.substring(0, 8)} - ${d.security_address || 'Unknown'}`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Error loading deals:', err);
  }
}

/**
 * Toggle existing deal selection
 */
export function toggleExistingDealSelect() {
  const mode = document.getElementById('deal-mode').value;
  const selector = document.getElementById('existing-deal-selector');
  if (selector) {
    selector.style.display = mode === 'existing' ? 'block' : 'none';
  }
}

/**
 * Cancel smart parse
 */
export function cancelSmartParse() {
  const zone = document.getElementById('smart-drop-zone');
  if (zone) zone.classList.remove('active');

  const form = document.getElementById('smart-parse-form');
  if (form) form.style.display = 'none';

  const textarea = document.getElementById('whatsapp-textarea');
  if (textarea) {
    textarea.value = '';
    textarea.style.display = 'none';
  }

  setSmartParsedData(null);
  setSmartParseSessionId(null);
}

/**
 * Confirm and apply smart parse data
 */
export async function confirmSmartParse() {
  const mode = document.getElementById('deal-mode').value;
  const sessionId = getSmartParseSessionId();
  const parsedData = getSmartParsedData();

  if (!sessionId || !parsedData) {
    showToast('No parsed data available', true);
    return;
  }

  if (mode === 'new') {
    // Apply to new deal form
    applySmartParseToNewDeal(parsedData);
    showToast('Data applied to new deal form');
  } else if (mode === 'existing') {
    const dealId = document.getElementById('existing-deal-select').value;
    if (!dealId) {
      showToast('Please select an existing deal', true);
      return;
    }
    await applySmartParseToExistingDeal(dealId, parsedData);
  }

  cancelSmartParse();
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
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/apply-smart-parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsed_data: parsedData })
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
