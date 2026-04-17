import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { floatingProgress } from './floating-progress.js';

// ═══════════════════════════════════════════════════════════════════════════
//  SMART PARSE — Filing Cabinet with Staging Area
//  Broker drops files → picks New Deal or Existing Deal → files stage on page
//  → broker can add more files, paste text, add notes → Submit when ready
//  → deal created/updated, broker redirected into the deal
// ═══════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────
let _stagedFiles = [];          // Array of File objects waiting to be uploaded
let _dealMode = null;           // 'new' or 'existing'
let _existingDealId = null;     // submission_id if existing deal
let _stagingActive = false;     // Whether the staging area is visible

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
 * Handle WhatsApp text submission — just show it in staging, don't upload yet
 */
export async function handleWhatsappSubmit() {
  const text = document.getElementById('whatsapp-text-input')?.value.trim();
  if (!text) {
    showToast('Please paste some text first', true);
    return;
  }
  if (!_stagingActive) {
    // Need to pick deal mode first
    showDealPickerModal([], text);
    return;
  }
  // Already staging — just refresh the staging area to show the text
  renderStagingArea();
  showToast('Text added to your submission');
}

/**
 * Process smart parse files
 */
export async function processSmartFiles(fileList) {
  const files = Array.from(fileList);
  const maxSize = 25 * 1024 * 1024;
  const validFiles = files.filter(f => f.size <= maxSize);
  const oversized = files.filter(f => f.size > maxSize);

  if (oversized.length > 0) {
    showToast(`${oversized.length} file${oversized.length > 1 ? 's' : ''} exceeded 25MB limit and were skipped`, true);
  }
  if (validFiles.length === 0) return;

  if (!_stagingActive) {
    // First drop — show deal picker, then stage
    showDealPickerModal(validFiles);
  } else {
    // Already staging — add files directly
    _stagedFiles.push(...validFiles);
    renderStagingArea();
    showToast(`${validFiles.length} file${validFiles.length > 1 ? 's' : ''} added`);
  }
}

/**
 * Show modal asking: new deal or existing deal?
 */
async function showDealPickerModal(files, pastedText) {
  // Fetch existing deals
  let existingDeals = [];
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals`, { method: 'GET' });
    if (resp.ok) {
      const data = await resp.json();
      existingDeals = (data.deals || []).filter(d => !['completed', 'declined', 'withdrawn'].includes(d.deal_stage));
    }
  } catch (e) { /* proceed with empty list */ }

  const fileListHtml = files.length > 0 ? files.map(f => {
    const sizeStr = (f.size / 1024 / 1024).toFixed(2);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
      <div style="width:6px;height:6px;border-radius:50%;background:#D4A853;flex-shrink:0;"></div>
      <span style="font-size:12px;color:#F1F5F9;flex:1;">${sanitizeHtml(f.name)}</span>
      <span style="font-size:11px;color:#64748B;">${sizeStr} MB</span>
    </div>`;
  }).join('') : '<div style="padding:8px 0;font-size:12px;color:#94A3B8;">Text content ready to submit</div>';

  const dealOptions = existingDeals.map(d => {
    const borrower = d.borrower_name || 'No borrower';
    const loan = d.loan_amount ? ' \u00b7 \u00a3' + (Number(d.loan_amount) / 1000).toFixed(0) + 'k' : '';
    const ref = d.submission_id.substring(0, 8);
    return `<option value="${sanitizeHtml(d.submission_id)}">${sanitizeHtml(ref)} \u2014 ${sanitizeHtml(borrower)}${loan}</option>`;
  }).join('');

  let modal = document.getElementById('deal-picker-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'deal-picker-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
  modal.innerHTML = `
    <div style="background:#1a2332;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:500px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="font-size:16px;font-weight:700;color:#F1F5F9;margin-bottom:4px;">${files.length > 0 ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' ready' : 'Text ready'}</div>
      <div style="font-size:11px;color:#94A3B8;margin-bottom:14px;">Where should this go?</div>

      <div style="background:#0f1729;border-radius:8px;padding:10px 12px;margin-bottom:16px;max-height:120px;overflow-y:auto;">
        ${fileListHtml}
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">
        <label style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0f1729;border:2px solid rgba(212,168,83,0.3);border-radius:8px;cursor:pointer;" onclick="document.getElementById('dp-new').checked=true;document.getElementById('dp-existing-select').style.display='none';">
          <input type="radio" name="dp-mode" id="dp-new" value="new" checked style="accent-color:#D4A853;">
          <div>
            <div style="font-size:13px;font-weight:700;color:#F1F5F9;">New Deal</div>
            <div style="font-size:11px;color:#94A3B8;">Create a new deal and attach these documents</div>
          </div>
        </label>

        <label style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#0f1729;border:2px solid rgba(255,255,255,0.06);border-radius:8px;cursor:pointer;" onclick="document.getElementById('dp-existing').checked=true;document.getElementById('dp-existing-select').style.display='block';">
          <input type="radio" name="dp-mode" id="dp-existing" value="existing" style="accent-color:#D4A853;">
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:700;color:#F1F5F9;">Existing Deal</div>
            <div style="font-size:11px;color:#94A3B8;">Add documents to a deal already in progress</div>
          </div>
        </label>

        <select id="dp-existing-select" style="display:none;width:100%;padding:10px 12px;background:#0f1729;color:#F1F5F9;border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:13px;outline:none;">
          <option value="">\u2014 Select a deal \u2014</option>
          ${dealOptions}
        </select>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button onclick="document.getElementById('deal-picker-modal').remove()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#94A3B8;cursor:pointer;">Cancel</button>
        <button id="dp-continue-btn" onclick="window.confirmDealPicker()" style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;border:none;background:#D4A853;color:#0B1120;cursor:pointer;">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Store files and text for after modal confirms
  window._dpPendingFiles = files;
  window._dpPendingText = pastedText || null;
}

/**
 * Handle deal picker confirmation — activate staging area
 */
window.confirmDealPicker = function() {
  const mode = document.querySelector('input[name="dp-mode"]:checked')?.value;
  const existingDealId = document.getElementById('dp-existing-select')?.value;

  if (mode === 'existing' && !existingDealId) {
    showToast('Please select a deal', true);
    return;
  }

  // Set state
  _dealMode = mode;
  _existingDealId = (mode === 'existing') ? existingDealId : null;
  _stagingActive = true;

  // Add pending files to staging
  if (window._dpPendingFiles && window._dpPendingFiles.length > 0) {
    _stagedFiles.push(...window._dpPendingFiles);
  }

  // If there was pending pasted text, put it in the textarea
  if (window._dpPendingText) {
    const textarea = document.getElementById('whatsapp-text-input');
    if (textarea) {
      textarea.value = window._dpPendingText;
      document.getElementById('whatsapp-paste-area').style.display = 'block';
    }
  }

  window._dpPendingFiles = null;
  window._dpPendingText = null;

  // Close modal
  document.getElementById('deal-picker-modal')?.remove();

  // Show staging area
  renderStagingArea();
};

/**
 * Render the staging area — shows staged files, text, notes, and submit button
 */
function renderStagingArea() {
  const container = document.getElementById('smart-upload-progress');
  container.style.display = 'block';

  const whatsappText = document.getElementById('whatsapp-text-input')?.value.trim() || '';
  const modeLabel = _dealMode === 'existing'
    ? `Adding to existing deal (${_existingDealId?.substring(0, 8)})`
    : 'Creating a new deal';

  const fileRows = _stagedFiles.map((f, i) => {
    const icon = f.type.includes('pdf') ? '\ud83d\udcc4' : f.type.includes('word') || f.name.endsWith('.docx') ? '\ud83d\udcdd' : f.type.includes('sheet') || f.name.endsWith('.xlsx') || f.name.endsWith('.csv') ? '\ud83d\udcca' : f.type.includes('image') ? '\ud83d\uddbc\ufe0f' : '\ud83d\udcce';
    const sizeStr = (f.size / 1024 / 1024).toFixed(2);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <span style="font-size:18px;">${icon}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:500;font-size:13px;color:#F1F5F9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sanitizeHtml(f.name)}</div>
        <div style="font-size:11px;color:#64748B;">${sizeStr} MB</div>
      </div>
      <button onclick="window.removeStagedFile(${i})" style="background:none;border:none;color:#F87171;cursor:pointer;font-size:16px;padding:4px 8px;" title="Remove">\u2715</button>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div style="background:#1a2332;border:1px solid rgba(212,168,83,0.3);border-radius:12px;overflow:hidden;margin-top:12px;">
      <!-- Header -->
      <div style="padding:14px 16px;background:rgba(212,168,83,0.08);border-bottom:1px solid rgba(212,168,83,0.2);display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:700;color:#D4A853;">${_stagedFiles.length} file${_stagedFiles.length !== 1 ? 's' : ''} staged</div>
          <div style="font-size:11px;color:#94A3B8;margin-top:2px;">${modeLabel}</div>
        </div>
        <button onclick="window.cancelStaging()" style="background:none;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#94A3B8;padding:4px 12px;font-size:11px;cursor:pointer;">Cancel</button>
      </div>

      <!-- File list -->
      <div style="max-height:240px;overflow-y:auto;">
        ${fileRows || '<div style="padding:16px;text-align:center;color:#64748B;font-size:13px;">No files yet \u2014 drop files above to add them</div>'}
      </div>

      <!-- Add more prompt -->
      <div style="padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
        <span style="font-size:12px;color:#64748B;">Drop more files above or </span>
        <a href="#" onclick="document.getElementById('smart-file-input').click(); return false;" style="font-size:12px;color:#D4A853;text-decoration:none;">browse to add more</a>
      </div>

      ${whatsappText ? `
      <!-- Pasted text preview -->
      <div style="padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:11px;color:#94A3B8;margin-bottom:4px;">Pasted text included:</div>
        <div style="font-size:12px;color:#CBD5E1;background:#0f1729;padding:8px 10px;border-radius:6px;max-height:60px;overflow:hidden;text-overflow:ellipsis;">${sanitizeHtml(whatsappText.substring(0, 200))}${whatsappText.length > 200 ? '...' : ''}</div>
      </div>` : ''}

      <!-- Notes -->
      <div style="padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);">
        <textarea id="staging-notes" placeholder="Add any notes for the deal team (optional)..." style="width:100%;min-height:60px;padding:10px;background:#0f1729;color:#F1F5F9;border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box;"></textarea>
      </div>

      <!-- Submit -->
      <div style="padding:14px 16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:10px;justify-content:flex-end;">
        <button id="staging-submit-btn" onclick="window.submitStagedDeal()" style="padding:10px 28px;border-radius:8px;font-size:14px;font-weight:700;border:none;background:#D4A853;color:#0B1120;cursor:pointer;" ${_stagedFiles.length === 0 ? 'disabled style="opacity:0.5;"' : ''}>
          ${_dealMode === 'existing' ? 'Add to Deal' : 'Submit Deal'}
        </button>
      </div>
    </div>
  `;

  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Remove a staged file
 */
window.removeStagedFile = function(index) {
  _stagedFiles.splice(index, 1);
  renderStagingArea();
};

/**
 * Cancel staging — clear everything
 */
window.cancelStaging = function() {
  _stagedFiles = [];
  _dealMode = null;
  _existingDealId = null;
  _stagingActive = false;
  const container = document.getElementById('smart-upload-progress');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  const textarea = document.getElementById('whatsapp-text-input');
  if (textarea) textarea.value = '';
  document.getElementById('whatsapp-paste-area').style.display = 'none';
};

/**
 * Submit staged files + text + notes — upload to backend, redirect to deal
 */
window.submitStagedDeal = async function() {
  if (_stagedFiles.length === 0) {
    showToast('Please add at least one file', true);
    return;
  }

  const btn = document.getElementById('staging-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  // Show floating progress bar
  floatingProgress.show({
    label: 'Submitting Deal',
    message: `Uploading ${_stagedFiles.length} file${_stagedFiles.length !== 1 ? 's' : ''}...`,
    steps: ['Upload documents', 'AI sorting documents', 'Opening deal']
  });
  floatingProgress.updateStep(0, 'active');
  floatingProgress.updateBar(10);

  try {
    const formData = new FormData();
    for (const file of _stagedFiles) {
      formData.append('files', file);
    }
    if (_dealMode === 'existing' && _existingDealId) {
      formData.append('deal_id', _existingDealId);
    }

    // Include WhatsApp/pasted text
    const whatsappText = document.getElementById('whatsapp-text-input')?.value.trim();
    if (whatsappText) {
      formData.append('whatsapp_text', whatsappText);
    }

    // Include notes
    const notes = document.getElementById('staging-notes')?.value.trim();
    if (notes) {
      formData.append('notes', notes);
    }

    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await resp.json();

    if (!resp.ok) {
      floatingProgress.error({ label: 'Upload Failed', message: data.error || 'Please try again.' });
      showToast(data.error || 'Upload failed', true);
      btn.disabled = false;
      btn.textContent = _dealMode === 'existing' ? 'Add to Deal' : 'Submit Deal';
      return;
    }

    // Step 1 done — upload complete
    floatingProgress.updateStep(0, 'done');
    floatingProgress.updateBar(40);

    // Step 2 — AI categorisation
    const submissionId = data.submission_id;
    floatingProgress.updateStep(1, 'active');
    floatingProgress.updateMessage('AI is sorting your documents into categories...');
    btn.textContent = 'AI is sorting your documents...';

    if (submissionId) {
      try {
        await fetchWithAuth(`${API_BASE}/api/smart-parse/categorise-docs/${submissionId}`, {
          method: 'POST'
        });
      } catch (catErr) {
        console.warn('[staging] AI categorisation request failed:', catErr.message);
      }
    }

    floatingProgress.updateStep(1, 'done');
    floatingProgress.updateBar(70);

    // Step 3 — redirect to deal
    floatingProgress.updateStep(2, 'active');
    floatingProgress.updateMessage('Opening your deal...');

    showToast(data.message || 'Deal submitted! AI is sorting your documents...');
    window.cancelStaging();

    if (submissionId) {
      setTimeout(() => {
        import('./deal-detail.js').then(m => {
          m.showDealDetail(submissionId);
          setTimeout(() => {
            const docTab = document.querySelector('[data-tab="dtab-docs"]') || document.querySelector('[onclick*="dtab-docs"]');
            if (docTab) docTab.click();
            floatingProgress.updateStep(2, 'done');
            floatingProgress.complete({ label: 'Deal Ready', message: 'Documents uploaded and sorted.' });
          }, 1500);
        });
      }, 800);
    } else {
      floatingProgress.updateStep(2, 'done');
      floatingProgress.complete({ label: 'Done', message: 'Documents uploaded successfully.' });
    }
  } catch (err) {
    console.error('Upload error:', err);
    floatingProgress.error({ label: 'Upload Error', message: 'Network error. Please try again.' });
    showToast('Network error. Please try again.', true);
    btn.disabled = false;
    btn.textContent = _dealMode === 'existing' ? 'Add to Deal' : 'Submit Deal';
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  Legacy exports — kept so other modules that import these don't break
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated — no longer used */
export async function uploadAndParse(files, whatsappText) {
  if (files && files.length > 0) processSmartFiles(files);
}

/** @deprecated */
export function populateSmartParseForm(pd) { /* no-op */ }

/** @deprecated */
export async function populateExistingDealsDropdown() { /* no-op */ }

/** @deprecated */
export function toggleExistingDealSelect() { /* no-op */ }

/** @deprecated */
export function cancelSmartParse() {
  window.cancelStaging();
}

/** @deprecated */
export async function confirmSmartParse() { /* no-op */ }
