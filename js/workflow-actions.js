import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId, getDipRemovedProperties, setDipRemovedProperties } from './state.js';

/**
 * Assign RM to a deal
 */
export async function assignRM() {
  const dealId = getCurrentDealId();
  const rmId = document.getElementById('assign-rm-select').value;
  if (!rmId) {
    showToast('Please select an RM', true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign-rm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rm_id: rmId })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('RM assigned successfully');
      document.getElementById('assign-rm-select').value = '';
    } else {
      showToast(data.error || 'Failed to assign RM', true);
    }
  } catch (err) {
    showToast('Error assigning RM', true);
  }
}

/**
 * Assign RM and advance to assigned stage
 */
export async function assignRMAndAdvance() {
  const dealId = getCurrentDealId();
  const rmId = document.getElementById('action-rm-select').value;
  if (!rmId) {
    showToast('Please select an RM', true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign-and-advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rm_id: rmId, new_stage: 'assigned' })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('RM assigned and deal advanced');
      // Reload deal detail
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to assign and advance', true);
    }
  } catch (err) {
    showToast('Error assigning RM', true);
  }
}

/**
 * Assign a reviewer (credit or compliance)
 */
export async function assignReviewer(type) {
  const dealId = getCurrentDealId();
  const selectId = type === 'credit' ? 'assign-credit-select' : 'assign-compliance-select';
  const reviewerId = document.getElementById(selectId).value;
  if (!reviewerId) {
    showToast(`Please select a ${type} analyst`, true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign-reviewer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer_id: reviewerId, reviewer_type: type })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`${type} analyst assigned successfully`);
      document.getElementById(selectId).value = '';
    } else {
      showToast(data.error || `Failed to assign ${type} analyst`, true);
    }
  } catch (err) {
    showToast(`Error assigning ${type} analyst`, true);
  }
}

/**
 * Advance deal to next stage
 */
export async function advanceStage(newStage) {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: newStage })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal advanced successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to advance deal', true);
    }
  } catch (err) {
    showToast('Error advancing deal', true);
  }
}

/**
 * Confirm fee payment
 */
export async function confirmFee() {
  const dealId = getCurrentDealId();
  const feeType = document.getElementById('fee-type-action').value;
  const feeAmount = document.getElementById('fee-amount-action2').value;
  const feeDate = document.getElementById('fee-date-action').value;

  if (!feeAmount || !feeDate) {
    showToast('Please fill in all fee fields', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/confirm-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_type: feeType, fee_amount: feeAmount, fee_date: feeDate })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Fee confirmed successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to confirm fee', true);
    }
  } catch (err) {
    showToast('Error confirming fee', true);
  }
}

/**
 * Submit credit recommendation
 */
export async function submitRecommendation(decision) {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('credit-notes').value.trim();
  const conditions = document.getElementById('credit-conditions').value.trim();

  if (!notes) {
    showToast('Please provide credit assessment notes', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/credit-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, notes, conditions })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`Credit decision (${decision}) submitted`);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit credit decision', true);
    }
  } catch (err) {
    showToast('Error submitting credit decision', true);
  }
}

/**
 * Accept DIP as external user (broker/borrower)
 */
export async function acceptDipExternal() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/accept-dip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('DIP accepted successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to accept DIP', true);
    }
  } catch (err) {
    showToast('Error accepting DIP', true);
  }
}

/**
 * Accept deal terms as external user
 */
export async function acceptDealExternal() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/accept-deal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal accepted successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to accept deal', true);
    }
  } catch (err) {
    showToast('Error accepting deal', true);
  }
}

/**
 * Submit deal to bank
 */
export async function submitToBank() {
  const dealId = getCurrentDealId();
  const bankRef = document.getElementById('bank-ref').value.trim();

  if (!bankRef) {
    showToast('Please enter a bank reference', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/submit-to-bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bank_reference: bankRef })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal submitted to bank');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit to bank', true);
    }
  } catch (err) {
    showToast('Error submitting to bank', true);
  }
}

/**
 * Record bank approval
 */
export async function recordBankApproval() {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('bank-approval-notes').value.trim();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/bank-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Bank approval recorded');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record bank approval', true);
    }
  } catch (err) {
    showToast('Error recording bank approval', true);
  }
}

/**
 * Record borrower acceptance
 */
export async function recordBorrowerAcceptance() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/borrower-acceptance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Borrower acceptance recorded');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record borrower acceptance', true);
    }
  } catch (err) {
    showToast('Error recording borrower acceptance', true);
  }
}

/**
 * Instruct legal
 */
export async function instructLegal() {
  const dealId = getCurrentDealId();
  const lawFirmId = document.getElementById('law-firm-select').value;
  const notes = document.getElementById('legal-notes').value.trim();

  if (!lawFirmId) {
    showToast('Please select a law firm', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/instruct-legal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ law_firm_id: lawFirmId, notes })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Legal firm instructed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to instruct legal', true);
    }
  } catch (err) {
    showToast('Error instructing legal', true);
  }
}

/**
 * Mark deal as completed
 */
export async function completeDeal() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal marked as completed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to complete deal', true);
    }
  } catch (err) {
    showToast('Error completing deal', true);
  }
}

/**
 * Decline a deal
 */
export async function declineDeal() {
  const dealId = getCurrentDealId();
  const reason = prompt('Enter decline reason:');
  if (!reason) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decline_reason: reason })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal declined');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to decline deal', true);
    }
  } catch (err) {
    showToast('Error declining deal', true);
  }
}

/**
 * Withdraw a deal
 */
export async function withdrawDeal() {
  const dealId = getCurrentDealId();
  const reason = prompt('Enter withdrawal reason:');
  if (!reason) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ withdraw_reason: reason })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal withdrawn');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to withdraw deal', true);
    }
  } catch (err) {
    showToast('Error withdrawing deal', true);
  }
}

/**
 * Advance stage (simple version)
 */
export async function advanceStageSimple(newStage) {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: newStage })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal advanced successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to advance deal', true);
    }
  } catch (err) {
    showToast('Error advancing deal', true);
  }
}
