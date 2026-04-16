import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════
//  SMART PARSE — Filing Cabinet
//  Broker drops files → picks New Deal or Existing Deal → files are saved →
//  broker is redirected into the deal. No AI calls here.
//  Categorisation & parsing happen inside the deal via the document repo flow.
// ═══════════════════════════════════════════════════════════════════════════

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
 * Handle WhatsApp text submission (not used in new flow but kept for compatibility)
 */
export async function handleWhatsappSubmit() {
  const text = document.getElementById('whatsapp-text-input')?.value.trim();
  if (!text) {
    showToast('Please paste some text first', true);
    return;
  }
  showToast('WhatsApp text noted. Please also upload deal documents.', 'info');
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
            <div style="font-size:11px;color:#94A3B8;">Create a new deal and attach these documents</div>
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
}

/**
 * Handle deal picker confirmation — upload files and redirect
 */
window.confirmDealPicker = async function() {
  const mode = document.querySelector('input[name="dp-mode"]:checked')?.value;
  const existingDealId = document.getElementById('dp-existing-select')?.value;

  if (mode === 'existing' && !existingDealId) {
    showToast('Please select a deal', true);
    return;
  }

  if (!_pendingFiles || _pendingFiles.length === 0) {
    showToast('No files to upload', true);
    return;
  }

  // Disable button and show uploading state
  const btn = document.getElementById('dp-continue-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Uploading...';
  }

  try {
    const formData = new FormData();
    for (const file of _pendingFiles) {
      formData.append('files', file);
    }
    if (mode === 'existing' && existingDealId) {
      formData.append('deal_id', existingDealId);
    }

    const resp = await fetchWithAuth(`${API_BASE}/api/smart-parse/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await resp.json();

    if (!resp.ok) {
      showToast(data.error || 'Upload failed', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
      return;
    }

    // Close modal
    document.getElementById('deal-picker-modal')?.remove();
    _pendingFiles = null;

    // Show success
    showToast(data.message || 'Files uploaded successfully!');

    // Redirect into the deal
    if (data.submission_id) {
      // Small delay so the toast is visible
      setTimeout(() => {
        import('./deal-detail.js').then(m => m.showDealDetail(data.submission_id));
      }, 600);
    }
  } catch (err) {
    console.error('Upload error:', err);
    showToast('Network error. Please try again.', true);
    if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  Legacy exports — kept so other modules that import these don't break.
//  These are no-ops or minimal stubs.
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated — no longer used, kept for import compatibility */
export async function uploadAndParse(files, whatsappText) {
  // Redirect to the new flow
  if (files && files.length > 0) {
    processSmartFiles(files);
  }
}

/** @deprecated */
export function populateSmartParseForm(pd) { /* no-op */ }

/** @deprecated */
export async function populateExistingDealsDropdown() { /* no-op */ }

/** @deprecated */
export function toggleExistingDealSelect() { /* no-op */ }

/** @deprecated */
export function cancelSmartParse() {
  // Hide any leftover UI from old flow
  const reviewEl = document.getElementById('smart-parse-review');
  if (reviewEl) reviewEl.style.display = 'none';
  const progressEl = document.getElementById('smart-upload-progress');
  if (progressEl) progressEl.style.display = 'none';
}

/** @deprecated */
export async function confirmSmartParse() { /* no-op */ }
