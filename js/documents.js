import { API_BASE } from './config.js';
import { showToast, formatDate, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId } from './state.js';

/**
 * Render documents list with download links
 */
export function renderDocumentsList(documents) {
  const list = document.getElementById('documents-list');
  if (!list) return;

  list.innerHTML = '';

  if (!documents || documents.length === 0) {
    list.innerHTML = '<p style="color: var(--text-light); text-align: center; padding: 20px;">No documents uploaded yet.</p>';
    return;
  }

  const dealId = getCurrentDealId();
  documents.forEach((doc, idx) => {
    const item = document.createElement('div');
    item.className = 'document-item';
    const icon = getDocumentIcon(doc.file_type || '');

    // Use backend download endpoint (works even if OneDrive is down)
    const downloadUrl = `${API_BASE}/api/deals/${dealId}/documents/${doc.id}/download`;

    item.innerHTML = `
      <div class="document-info">
        <div class="document-icon">${icon}</div>
        <div class="document-details">
          <div class="document-name">${sanitizeHtml(doc.filename || doc.file_name || 'Unknown')}</div>
          <div class="document-meta">${((doc.file_size || 0) / 1024 / 1024).toFixed(2)} MB · ${formatDate(doc.uploaded_at)}</div>
        </div>
      </div>
      <div class="document-actions">
        ${isImageType(doc.file_type) ? `<button onclick="window.viewDocumentInline(${doc.id})" class="btn-sm" style="margin-right:4px;">View</button>` : ''}
        <button onclick="window.downloadDocumentById(${doc.id})" class="btn-sm btn-download">Download</button>
      </div>
    `;
    list.appendChild(item);
  });
}

/**
 * Get document icon based on file type
 */
export function getDocumentIcon(fileType) {
  const type = fileType.toLowerCase();
  if (type.includes('pdf')) return '📄';
  if (type.includes('word') || type.includes('doc')) return '📝';
  if (type.includes('sheet') || type.includes('xls')) return '📊';
  if (type.includes('image') || type.includes('jpg') || type.includes('png')) return '🖼️';
  if (type.includes('video')) return '🎥';
  if (type.includes('zip') || type.includes('compress')) return '📦';
  return '📎';
}

/**
 * Handle document drag over
 */
export function handleDocumentDragOver(e) {
  e.preventDefault();
  const zone = document.getElementById('upload-zone');
  if (zone) zone.classList.add('active');
}

/**
 * Handle document drag leave
 */
export function handleDocumentDragLeave(e) {
  e.preventDefault();
  const zone = document.getElementById('upload-zone');
  if (zone) zone.classList.remove('active');
}

/**
 * Handle document drop
 */
export function handleDocumentDrop(e) {
  e.preventDefault();
  const zone = document.getElementById('upload-zone');
  if (zone) zone.classList.remove('active');
  const files = e.dataTransfer.files;
  if (files) uploadDealFiles(files);
}

/**
 * Handle file select from input
 */
export function handleFileSelect(e) {
  const files = e.target.files;
  if (files) uploadDealFiles(files);
}

/**
 * Upload deal files to OneDrive
 */
export async function uploadDealFiles(files) {
  const dealId = getCurrentDealId();
  if (!dealId) {
    showToast('No deal selected', true);
    return;
  }

  if (files.length === 0) return;

  const uploadBtn = document.getElementById('upload-btn');
  if (uploadBtn) {
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
  }

  try {
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/upload-documents`, {
      method: 'POST',
      body: formData
    });

    const data = await resp.json();

    if (resp.ok) {
      showToast(`${files.length} file(s) uploaded successfully`);
      // Reload deal details
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Upload failed', true);
    }
  } catch (err) {
    showToast('Error uploading files', true);
  } finally {
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload Documents';
    }
  }
}

/**
 * Check if a mimetype is an image
 */
function isImageType(fileType) {
  if (!fileType) return false;
  return fileType.includes('image') || fileType.includes('jpg') || fileType.includes('png') || fileType.includes('gif');
}

/**
 * Download a document via backend endpoint (works without OneDrive)
 */
export async function downloadDocumentById(docId) {
  const dealId = getCurrentDealId();
  if (!dealId || !docId) {
    showToast('Cannot download — deal or document ID missing', true);
    return;
  }
  try {
    const token = getAuthToken();
    const url = `${API_BASE}/api/deals/${dealId}/documents/${docId}/download`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) {
      showToast('Download failed', true);
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
    showToast('Download error', true);
  }
}

/**
 * View document inline (images only, via backend download)
 */
export async function viewDocumentInline(docId) {
  const dealId = getCurrentDealId();
  if (!dealId || !docId) return;

  try {
    const token = getAuthToken();
    const url = `${API_BASE}/api/deals/${dealId}/documents/${docId}/download`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok) { showToast('Could not load document', true); return; }
    const blob = await resp.blob();
    const imgUrl = URL.createObjectURL(blob);

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center;';

    const container = document.createElement('div');
    container.style.cssText = 'max-width:90%;max-height:90%;background:white;border-radius:8px;padding:20px;text-align:center;position:relative;';

    const img = document.createElement('img');
    img.src = imgUrl;
    img.style.cssText = 'max-width:100%;max-height:70vh;border-radius:4px;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:#e53e3e;color:white;border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;font-size:18px;';
    closeBtn.onclick = () => { modal.remove(); URL.revokeObjectURL(imgUrl); };

    container.appendChild(closeBtn);
    container.appendChild(img);
    modal.appendChild(container);
    modal.onclick = (e) => { if (e.target === modal) { modal.remove(); URL.revokeObjectURL(imgUrl); } };
    document.body.appendChild(modal);
  } catch (err) {
    showToast('Error viewing document', true);
  }
}
