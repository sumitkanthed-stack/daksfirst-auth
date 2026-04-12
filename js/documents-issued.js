/**
 * Documents Issued Panel — Daksfirst
 *
 * Prominent panel rendered between Deal Header and Tabs.
 * Shows DIP, Indicative TS, Formal Offer, Completion Pack
 * with status, dates, expiry, version, actions.
 *
 * Replaces: Section 8 in deal-matrix.js + Document Repository
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';
import { showToast, formatDate, sanitizeHtml } from './utils.js';
import { getCurrentRole } from './state.js';

// ═══════════════════════════════════════════════════════════════════
// DEAL REFERENCE GENERATOR
// ═══════════════════════════════════════════════════════════════════

function dealRefFromId(submissionId, createdAt) {
  if (!submissionId || !createdAt) return 'DAK-XXXX-XXXX';
  const date = new Date(createdAt);
  const yyyy = date.getFullYear();
  const seq = String(submissionId).substring(0, 4).toUpperCase();
  return `DAK-${yyyy}-${seq}`;
}

// ═══════════════════════════════════════════════════════════════════
// STATUS LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Determine document states from deal data.
 * Returns an object with status, dates, version, actions for each doc type.
 */
function resolveDocStates(deal) {
  const stage = deal.deal_stage || 'received';
  const now = new Date();

  // ── DIP ──
  const dipStatus = resolveDipStatus(deal, stage);
  const dipIssuedAt = deal.dip_issued_at || null;
  const dipExpiresAt = dipIssuedAt ? addDays(new Date(dipIssuedAt), 14) : null;
  const dipExpired = dipExpiresAt && now > dipExpiresAt;
  const dipVersion = deal.dip_version || 1;

  // ── Indicative Termsheet ──
  const tsUnlocked = ['fee_paid', 'ai_termsheet', 'underwriting', 'bank_submitted', 'bank_approved',
    'borrower_accepted', 'legal_instructed', 'completed'].includes(stage) || deal.ts_issued;
  const tsStatus = resolveTermsheetStatus(deal, tsUnlocked);
  const tsIssuedAt = deal.ts_issued_at || null;
  const tsExpiresAt = tsIssuedAt ? addDays(new Date(tsIssuedAt), 30) : null;

  // ── Formal Offer ──
  const foUnlocked = ['bank_approved', 'borrower_accepted', 'legal_instructed', 'completed'].includes(stage) || deal.fl_issued;
  const foStatus = resolveFormalOfferStatus(deal, foUnlocked);
  const foIssuedAt = deal.fl_issued_at || null;

  // ── Completion Pack ──
  const cpUnlocked = ['legal_instructed', 'completed'].includes(stage);
  const cpStatus = cpUnlocked ? (deal.completed_at ? 'completed' : 'in-progress') : 'locked';

  return {
    dip: {
      name: 'DIP',
      fullName: 'Data Information Package',
      status: dipExpired && dipStatus !== 'accepted' ? 'expired' : dipStatus,
      issuedAt: dipIssuedAt,
      expiresAt: dipExpiresAt ? dipExpiresAt.toISOString() : null,
      version: dipVersion,
      feeDue: deal.dip_fee || null,
      feePaid: deal.dip_fee_paid || false,
      canView: !!dipIssuedAt,
      actionLabel: getDipAction(dipStatus, deal),
      actionType: getDipActionType(dipStatus, deal)
    },
    indicativeTs: {
      name: 'Indicative Termsheet',
      fullName: 'Initial lending terms & conditions',
      status: tsStatus,
      issuedAt: tsIssuedAt,
      expiresAt: tsExpiresAt ? tsExpiresAt.toISOString() : null,
      version: deal.ts_version || 1,
      feeDue: deal.commitment_fee || null,
      feePaid: deal.commitment_fee_paid || false,
      canView: !!tsIssuedAt,
      unlockReason: !tsUnlocked ? 'Requires DIP accepted + fee paid' : null,
      actionLabel: tsUnlocked && tsIssuedAt ? 'View PDF' : null,
      actionType: 'view'
    },
    formalOffer: {
      name: 'Formal Offer',
      fullName: 'Binding lending terms (DocuSign)',
      status: foStatus,
      issuedAt: foIssuedAt,
      expiresAt: null,
      version: deal.fl_version || 1,
      canView: !!foIssuedAt,
      unlockReason: !foUnlocked ? 'Requires credit approval' : null,
      actionLabel: foUnlocked && foIssuedAt ? 'View PDF' : null,
      actionType: 'view'
    },
    completionPack: {
      name: 'Completion Pack',
      fullName: 'Legal docs & completion statement',
      status: cpStatus,
      issuedAt: deal.completed_at || null,
      expiresAt: null,
      version: 1,
      canView: !!deal.completed_at,
      unlockReason: !cpUnlocked ? 'Requires signed offer' : null,
      actionLabel: null,
      actionType: null
    }
  };
}

function resolveDipStatus(deal, stage) {
  if (deal.dip_signed) return 'accepted';
  if (deal.dip_issued || deal.dip_issued_at) {
    if (deal.dip_fee_paid) return 'fee-paid';
    return 'issued';
  }
  if (['dip_issued', 'info_gathering'].includes(stage)) return 'issued';
  if (stage === 'received' || stage === 'assigned') return 'pending';
  return 'pending';
}

function resolveTermsheetStatus(deal, unlocked) {
  if (!unlocked) return 'locked';
  if (deal.ts_signed) return 'signed';
  if (deal.ts_issued || deal.ts_issued_at) return 'issued';
  return 'not-started';
}

function resolveFormalOfferStatus(deal, unlocked) {
  if (!unlocked) return 'locked';
  if (deal.fl_signed) return 'signed';
  if (deal.fl_issued || deal.fl_issued_at) return 'issued';
  return 'not-started';
}

function getDipAction(status, deal) {
  if (status === 'issued' && !deal.dip_fee_paid) return 'Accept & Pay Fee';
  if (status === 'issued' && deal.dip_fee_paid) return 'Accept DIP';
  if (status === 'accepted') return 'View PDF';
  if (status === 'fee-paid') return 'Accept DIP';
  return null;
}

function getDipActionType(status, deal) {
  if (status === 'issued' || status === 'fee-paid') return 'cta';
  if (status === 'accepted') return 'view';
  return null;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  const diff = Math.ceil((target - now) / (1000 * 60 * 60 * 24));
  return diff;
}

// ═══════════════════════════════════════════════════════════════════
// STATUS DISPLAY CONFIG
// ═══════════════════════════════════════════════════════════════════

const statusConfig = {
  'pending':      { label: 'Pending',          bg: 'rgba(100,116,139,0.08)', color: '#64748b', border: 'rgba(100,116,139,0.15)' },
  'issued':       { label: 'Issued',           bg: 'rgba(59,130,246,0.1)',   color: '#3b82f6', border: 'rgba(59,130,246,0.25)' },
  'fee-paid':     { label: 'Fee Paid',         bg: 'rgba(52,211,153,0.1)',   color: '#34D399', border: 'rgba(52,211,153,0.25)' },
  'accepted':     { label: 'Accepted',         bg: 'rgba(52,211,153,0.12)',  color: '#22c55e', border: 'rgba(52,211,153,0.3)' },
  'expired':      { label: 'Expired',          bg: 'rgba(248,113,113,0.1)',  color: '#F87171', border: 'rgba(248,113,113,0.3)' },
  'signed':       { label: 'Signed',           bg: 'rgba(22,101,52,0.15)',   color: '#22c55e', border: 'rgba(22,101,52,0.3)' },
  'not-started':  { label: 'Not Started',      bg: 'rgba(100,116,139,0.06)', color: '#475569', border: 'rgba(100,116,139,0.12)' },
  'locked':       { label: 'Locked',           bg: 'rgba(100,116,139,0.06)', color: '#475569', border: 'rgba(100,116,139,0.12)' },
  'in-progress':  { label: 'In Progress',      bg: 'rgba(251,191,36,0.1)',   color: '#FBBF24', border: 'rgba(251,191,36,0.25)' },
  'completed':    { label: 'Completed',        bg: 'rgba(22,101,52,0.15)',   color: '#22c55e', border: 'rgba(22,101,52,0.3)' },
  'action':       { label: 'Action Required',  bg: 'rgba(248,113,113,0.1)',  color: '#F87171', border: 'rgba(248,113,113,0.3)' }
};

function getStatusStyle(status) {
  return statusConfig[status] || statusConfig['not-started'];
}

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════

/**
 * Render the Documents Issued panel into the container.
 * Called from deal-detail.js after deal data is loaded.
 */
export function renderDocumentsIssued(deal) {
  const container = document.getElementById('documents-issued-panel');
  if (!container) return;

  const dealRef = dealRefFromId(deal.submission_id || deal.id, deal.created_at);
  const docs = resolveDocStates(deal);
  const role = getCurrentRole();
  const isInternal = ['admin', 'rm', 'credit', 'compliance'].includes(role);

  container.innerHTML = `
    <div class="docs-issued-wrapper">
      <!-- Header -->
      <div class="docs-issued-header">
        <div class="docs-issued-header-left">
          <div class="docs-issued-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
            </svg>
          </div>
          <div>
            <div class="docs-issued-title">Documents Issued</div>
            <div class="docs-issued-subtitle">Formal documents on this deal</div>
          </div>
        </div>
        <div class="docs-issued-ref">${sanitizeHtml(dealRef)}</div>
      </div>

      <!-- Cards Grid -->
      <div class="docs-issued-grid">
        ${renderDocCard(docs.dip, deal, 'dip', isInternal)}
        ${renderDocCard(docs.indicativeTs, deal, 'ts', isInternal)}
        ${renderDocCard(docs.formalOffer, deal, 'fo', isInternal)}
        ${renderDocCard(docs.completionPack, deal, 'cp', isInternal)}
      </div>
    </div>
  `;

  // Bind action buttons
  bindDocActions(deal, docs);
}

function renderDocCard(doc, deal, key, isInternal) {
  const isLocked = doc.status === 'locked';
  const hasAction = doc.actionLabel && doc.actionType === 'cta';
  const statusStyle = getStatusStyle(hasAction ? 'action' : doc.status);
  const isActive = !isLocked && doc.status !== 'not-started';
  const expiryDays = daysUntil(doc.expiresAt);
  const expiryUrgent = expiryDays !== null && expiryDays <= 5 && expiryDays > 0;
  const expiryExpired = expiryDays !== null && expiryDays <= 0;

  return `
    <div class="docs-issued-card ${isLocked ? 'locked' : ''} ${isActive ? 'active' : ''}" id="doc-card-${key}">
      <!-- Card Header: Name + Status -->
      <div class="docs-card-header">
        <div>
          <div class="docs-card-name">
            ${sanitizeHtml(doc.name)}
            ${doc.version > 1 ? `<span class="docs-version-badge">v${doc.version}</span>` : ''}
          </div>
          <div class="docs-card-desc">${sanitizeHtml(doc.fullName)}</div>
        </div>
        <span class="docs-status-badge" style="background:${statusStyle.bg};color:${statusStyle.color};border:1px solid ${statusStyle.border}${hasAction ? ';animation:docsPulse 2s infinite' : ''}">
          ${sanitizeHtml(statusStyle.label)}
        </span>
      </div>

      ${isLocked ? `
        <!-- Locked State -->
        <div class="docs-card-locked">
          <span class="docs-lock-icon">&#128274;</span>
          <span>${sanitizeHtml(doc.unlockReason || 'Requires previous stage')}</span>
        </div>
      ` : `
        <!-- Meta Rows -->
        <div class="docs-card-meta">
          ${doc.issuedAt ? `
            <div class="docs-meta-row">
              <span class="docs-meta-label">Issued</span>
              <span class="docs-meta-value">${formatDate(doc.issuedAt)}</span>
            </div>
          ` : `
            <div class="docs-meta-row">
              <span class="docs-meta-label">Status</span>
              <span class="docs-meta-value" style="color:#64748b">Awaiting issuance</span>
            </div>
          `}
          ${doc.expiresAt ? `
            <div class="docs-meta-row">
              <span class="docs-meta-label">Expires</span>
              <span class="docs-meta-value ${expiryUrgent ? 'warn' : ''} ${expiryExpired ? 'expired' : ''}">
                ${formatDate(doc.expiresAt)}${expiryDays !== null ? ` (${expiryExpired ? 'EXPIRED' : expiryDays + ' days'})` : ''}
              </span>
            </div>
          ` : ''}
          ${doc.feeDue && !doc.feePaid ? `
            <div class="docs-meta-row">
              <span class="docs-meta-label">Fee Due</span>
              <span class="docs-meta-value">&pound;${Number(doc.feeDue).toLocaleString('en-GB')}</span>
            </div>
          ` : ''}
          ${doc.feeDue && doc.feePaid ? `
            <div class="docs-meta-row">
              <span class="docs-meta-label">Fee</span>
              <span class="docs-meta-value" style="color:#22c55e">&pound;${Number(doc.feeDue).toLocaleString('en-GB')} Paid &#10003;</span>
            </div>
          ` : ''}
        </div>
      `}

      <!-- Actions -->
      <div class="docs-card-actions">
        ${hasAction ? `
          <button class="docs-btn docs-btn-cta" id="doc-action-${key}">${sanitizeHtml(doc.actionLabel)}</button>
        ` : ''}
        ${doc.canView ? `
          <button class="docs-btn docs-btn-outline" id="doc-view-${key}">View PDF</button>
        ` : ''}
        ${!hasAction && !doc.canView && !isLocked ? `
          <button class="docs-btn docs-btn-disabled" disabled>Not yet available</button>
        ` : ''}
        ${isLocked ? `
          <button class="docs-btn docs-btn-disabled" disabled>Locked</button>
        ` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════

function bindDocActions(deal, docs) {
  // DIP Accept action
  const dipActionBtn = document.getElementById('doc-action-dip');
  if (dipActionBtn) {
    dipActionBtn.addEventListener('click', () => handleDipAccept(deal));
  }

  // DIP View
  const dipViewBtn = document.getElementById('doc-view-dip');
  if (dipViewBtn) {
    dipViewBtn.addEventListener('click', () => handleViewDocument(deal, 'dip'));
  }

  // TS View
  const tsViewBtn = document.getElementById('doc-view-ts');
  if (tsViewBtn) {
    tsViewBtn.addEventListener('click', () => handleViewDocument(deal, 'termsheet'));
  }

  // FO View
  const foViewBtn = document.getElementById('doc-view-fo');
  if (foViewBtn) {
    foViewBtn.addEventListener('click', () => handleViewDocument(deal, 'formal_offer'));
  }
}

async function handleDipAccept(deal) {
  const dealId = deal.submission_id || deal.id;
  if (!confirm('By accepting the DIP, you confirm that all information provided is accurate and agree to the terms outlined. Continue?')) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/dip/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted: true })
    });

    if (resp.ok) {
      showToast('DIP accepted successfully');
      // Refresh the panel
      const updated = await resp.json();
      if (updated.deal) {
        renderDocumentsIssued(updated.deal);
      } else {
        // Reload deal data
        location.reload();
      }
    } else {
      const err = await resp.json().catch(() => ({}));
      showToast(err.message || 'Failed to accept DIP', true);
    }
  } catch (e) {
    showToast('Network error — please try again', true);
  }
}

async function handleViewDocument(deal, docType) {
  const dealId = deal.submission_id || deal.id;
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/documents/issued/${docType}`, {
      method: 'GET'
    });

    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } else {
      showToast('Document not available yet', true);
    }
  } catch (e) {
    showToast('Failed to load document', true);
  }
}
