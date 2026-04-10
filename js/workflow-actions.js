import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId, getDipRemovedProperties, setDipRemovedProperties } from './state.js';

/**
 * Assign RM to a deal
 */
export async function assignRM() {
  const dealId = getCurrentDealId();
  const rmId = document.getElementById('assign-rm-select')?.value;
  if (!rmId) {
    showToast('Please select an RM', true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rm_id: parseInt(rmId) })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'RM assigned successfully');
      await import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to assign RM', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Assign RM and advance to assigned stage
 */
export async function assignRMAndAdvance() {
  const dealId = getCurrentDealId();
  const rmId = document.getElementById('action-rm-select')?.value;
  if (!rmId) {
    showToast('Please select an RM', true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rm_id: parseInt(rmId) })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('RM assigned and stage advanced');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to assign RM', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Assign a reviewer (credit or compliance)
 */
export async function assignReviewer(type) {
  const dealId = getCurrentDealId();
  const selId = type === 'credit' ? 'assign-credit-select' : 'assign-compliance-select';
  const userId = document.getElementById(selId)?.value;
  if (!userId) {
    showToast(`Please select a ${type} reviewer`, true);
    return;
  }
  const body = {};
  if (type === 'credit') body.credit_id = parseInt(userId);
  else body.compliance_id = parseInt(userId);
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/assign-reviewer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || `${type} reviewer assigned successfully`);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || `Failed to assign ${type} reviewer`, true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Advance deal to next stage
 */
export async function advanceStage(newStage) {
  const dealId = getCurrentDealId();
  const comments = document.getElementById('stage-comment')?.value || '';
  if (['approved', 'declined'].includes(newStage)) {
    if (!confirm(`Are you sure you want to ${newStage === 'approved' ? 'APPROVE' : 'DECLINE'} this deal?`)) return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: newStage, comments })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'Deal advanced successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to advance stage', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Confirm fee payment
 */
export async function confirmFee() {
  const dealId = getCurrentDealId();
  const feeType = document.getElementById('fee-type')?.value;
  const amount = document.getElementById('fee-amount')?.value;
  const paymentDate = document.getElementById('fee-date')?.value;
  const paymentRef = document.getElementById('fee-ref')?.value;

  if (!feeType || !amount || !paymentDate) {
    showToast('Fee type, amount and date are required', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_type: feeType, amount: parseFloat(amount), payment_date: paymentDate, payment_ref: paymentRef })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'Fee confirmed successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to confirm fee', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Submit credit recommendation
 */
export async function submitRecommendation(decision) {
  const dealId = getCurrentDealId();
  const comments = document.getElementById('rec-comments')?.value || '';

  if (!comments && decision !== 'approve') {
    showToast('Please provide comments with your recommendation', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/recommendation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, comments })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || `Recommendation (${decision}) submitted`);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit recommendation', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Accept DIP as external user (broker/borrower)
 */
export async function acceptDipExternal() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/borrower-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept_dip' })
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
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/borrower-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept_deal' })
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
  const bankRef = document.getElementById('bank-ref')?.value.trim();

  if (!bankRef) {
    showToast('Please enter a bank reference', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/bank-submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bank_reference: bankRef })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Submitted to GB Bank');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Record bank approval
 */
export async function recordBankApproval() {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('bank-approval-notes')?.value || '';

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/bank-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bank_approval_notes: notes })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Bank approval recorded');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record approval', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Record borrower acceptance
 */
export async function recordBorrowerAcceptance() {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/borrower-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Borrower acceptance recorded');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record acceptance', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Instruct legal
 */
export async function instructLegal() {
  const dealId = getCurrentDealId();
  const firm = document.getElementById('lawyer-firm')?.value;
  const email = document.getElementById('lawyer-email')?.value;
  const contact = document.getElementById('lawyer-contact')?.value;

  if (!firm || !email) {
    showToast('Firm name and email are required', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/instruct-legal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lawyer_firm: firm, lawyer_email: email, lawyer_contact: contact || '', lawyer_reference: '' })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Legal instructed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to instruct legal', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Mark deal as completed
 */
export async function completeDeal() {
  if (!confirm('Are you sure you want to mark this deal as completed?')) return;
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: 'completed' })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal completed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to complete deal', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Decline a deal
 */
export async function declineDeal() {
  if (!confirm('Are you sure you want to decline this deal?')) return;
  const dealId = getCurrentDealId();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: 'declined' })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal declined');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to decline deal', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Withdraw a deal
 */
export async function withdrawDeal() {
  if (!confirm('Are you sure you want to withdraw this deal?')) return;
  const dealId = getCurrentDealId();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: 'withdrawn' })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Deal withdrawn');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to withdraw deal', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Advance stage (simple version)
 */
export async function advanceStageSimple(newStage) {
  const dealId = getCurrentDealId();
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: newStage })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Stage advanced');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to advance stage', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Load law firms
 */
export async function loadLawFirms() {
  const dropdown = document.getElementById('law-firms-dropdown');
  if (dropdown.style.display === 'block') {
    dropdown.style.display = 'none';
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/law-firms`, {
      method: 'GET'
    });
    const data = await resp.json();
    if (data.law_firms && data.law_firms.length > 0) {
      dropdown.innerHTML = data.law_firms.map(f => `
        <div onclick="window.selectLawFirm('${sanitizeHtml(f.firm_name)}', '${sanitizeHtml(f.email)}', '${sanitizeHtml(f.contact_name || '')}')" style="padding:8px;cursor:pointer;border-bottom:1px solid #e2e8f0;font-size:13px;">
          <div style="font-weight:500;">${sanitizeHtml(f.firm_name)}</div>
          <div style="font-size:11px;color:#666;">${sanitizeHtml(f.email)}</div>
        </div>
      `).join('');
      dropdown.style.display = 'block';
    } else {
      dropdown.innerHTML = '<div style="padding:8px;color:#999;font-size:13px;">No law firms onboarded yet</div>';
      dropdown.style.display = 'block';
    }
  } catch (err) {
    console.error('Failed to load law firms:', err);
  }
}

/**
 * Select a law firm from the dropdown
 */
export function selectLawFirm(firm, email, contact) {
  document.getElementById('lawyer-firm').value = firm;
  document.getElementById('lawyer-email').value = email;
  document.getElementById('lawyer-contact').value = contact;
  document.getElementById('law-firms-dropdown').style.display = 'none';
}

/**
 * Confirm fee and advance stage
 */
export async function confirmFeeAndAdvance() {
  const dealId = getCurrentDealId();
  const feeType = document.getElementById('fee-type-action')?.value;
  const amount = document.getElementById('fee-amount-action2')?.value;
  const paymentDate = document.getElementById('fee-date-action')?.value;

  if (!feeType || !amount || !paymentDate) {
    showToast('Fee type, amount and date are required', true);
    return;
  }

  try {
    // Step 1: Confirm the fee payment
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_type: feeType, amount: parseFloat(amount), payment_date: paymentDate })
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(data.error || 'Failed to confirm fee', true);
      return;
    }
    // Step 2: Also advance the stage to fee_paid
    const resp2 = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/stage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_stage: 'fee_paid', comments: `Fee confirmed: ${feeType} £${amount}` })
    });
    if (resp2.ok) {
      showToast('Fee confirmed and stage advanced to Fee Paid');
    } else {
      showToast('Fee confirmed but stage could not be advanced', true);
    }
    import('./deal-detail.js').then(m => m.showDealDetail(dealId));
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Add a borrower to the deal
 */
export async function addBorrower() {
  const dealId = getCurrentDealId();
  const fullName = document.getElementById('bw-name')?.value.trim();

  if (!fullName) {
    showToast('Borrower name is required', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/borrowers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: fullName,
        role: document.getElementById('bw-role')?.value || 'primary',
        borrower_type: document.getElementById('bw-type')?.value || 'individual',
        email: document.getElementById('bw-email')?.value.trim() || null
      })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(`Borrower ${fullName} added`);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to add borrower', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Remove a borrower from the deal
 */
export async function removeBorrower(borrowerId) {
  if (!confirm('Remove this borrower?')) return;
  const dealId = getCurrentDealId();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/borrowers/${borrowerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'Borrower removed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to remove', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Add a property to the deal
 */
export async function addProperty() {
  const dealId = getCurrentDealId();
  const address = document.getElementById('pp-address')?.value.trim();

  if (!address) {
    showToast('Property address is required', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: address,
        property_type: document.getElementById('pp-type')?.value || 'residential',
        market_value: document.getElementById('pp-value')?.value || null,
        gdv: document.getElementById('pp-gdv')?.value || null,
        tenure: document.getElementById('pp-tenure')?.value || 'freehold'
      })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Property added');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to add property', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Remove a property from the deal
 */
export async function removeProperty(propertyId) {
  if (!confirm('Remove this property from the portfolio?')) return;
  const dealId = getCurrentDealId();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/properties/${propertyId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast(data.message || 'Property removed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to remove', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}
