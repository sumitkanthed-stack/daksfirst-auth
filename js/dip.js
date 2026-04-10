import { API_BASE } from './config.js';
import { showToast, formatNumber, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId, setDipRemovedProperties, getDipRemovedProperties, addDipRemovedProperty, removeDipRemovedProperty, clearDipRemovedProperties } from './state.js';

/**
 * Remove a property from DIP
 */
export function removeDipProperty(idx) {
  const row = document.getElementById(`dip-prop-${idx}`);
  if (!row) return;

  const addr = row.querySelectorAll('td')[1].textContent;
  if (!confirm('Remove "' + addr.substring(0, 50) + '..." from this DIP?')) return;

  // Apply visual styling to show removal
  row.style.background = '#fee2e2';
  row.style.textDecoration = 'line-through';
  row.style.opacity = '0.5';
  row.querySelector('button').disabled = true;
  row.querySelector('button').textContent = 'Removed';

  // Track removal in state
  addDipRemovedProperty({ index: idx, address: addr });

  // Update display
  const removed = getDipRemovedProperties();
  const removedDiv = document.getElementById('dip-removed-props');
  if (removedDiv) {
    removedDiv.style.display = 'block';
    removedDiv.innerHTML = '<strong>Removed:</strong> ' + removed.map(p => p.address.substring(0, 40) + '...').join('; ');
  }

  calcDipLtv();
}

/**
 * Calculate DIP LTV and update summary
 */
export function calcDipLtv() {
  const loan = parseFloat(document.getElementById('dip-loan-amount')?.value) || 0;
  const val = parseFloat(document.getElementById('dip-property-value')?.value) || 0;
  const term = parseInt(document.getElementById('dip-term')?.value) || 0;
  const rate = parseFloat(document.getElementById('dip-rate')?.value) || 0;
  const arrFee = parseFloat(document.getElementById('dip-arrangement-fee')?.value) || 0;
  const interest = document.getElementById('dip-interest')?.value || 'retained';

  // Calculate LTV
  const ltv = val > 0 ? ((loan / val) * 100).toFixed(1) : 0;
  const ltvEl = document.getElementById('dip-ltv');
  if (ltvEl) ltvEl.value = ltv;

  // Calculate costs
  const totalInterest = loan * (rate / 100) * term;
  const arrangementFee = loan * (arrFee / 100);
  const netAdvance = interest === 'retained' ? loan - totalInterest - arrangementFee : loan - arrangementFee;

  // LTV check
  const ltvOk = ltv <= 75;
  const rateOk = rate >= 0.85;

  const summaryEl = document.getElementById('dip-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div>LTV: <strong style="color:${ltvOk ? '#15803d' : '#e53e3e'};">${ltv}%</strong> ${!ltvOk ? '(exceeds 75% max!)' : ''}</div>
        <div>Gross Loan: <strong>£${loan.toLocaleString()}</strong></div>
        <div>Net Day 1 Advance: <strong>£${Math.round(netAdvance).toLocaleString()}</strong></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;">
        <div>Total Interest: <strong>£${Math.round(totalInterest).toLocaleString()}</strong> (${term}m @ ${rate}%)</div>
        <div>Arrangement Fee: <strong>£${Math.round(arrangementFee).toLocaleString()}</strong> (${arrFee}%)</div>
        <div>Rate: <strong style="color:${rateOk ? '#15803d' : '#e53e3e'};">${rate}%/m</strong> ${!rateOk ? '(below 0.85% min!)' : ''}</div>
      </div>
    `;
  }
}

/**
 * Issue DIP to broker
 */
export async function issueDip() {
  const dealId = getCurrentDealId();
  const loanAmount = document.getElementById('dip-loan-amount')?.value;
  const propertyValue = document.getElementById('dip-property-value')?.value;
  const ltv = document.getElementById('dip-ltv')?.value;
  const term = document.getElementById('dip-term')?.value;
  const rate = document.getElementById('dip-rate')?.value;
  const interest = document.getElementById('dip-interest')?.value;
  const arrFee = document.getElementById('dip-arrangement-fee')?.value;
  const exitStrategy = document.getElementById('dip-exit')?.value;
  const purpose = document.getElementById('dip-purpose')?.value;
  const notes = document.getElementById('dip-notes')?.value || '';
  const purchasePrice = document.getElementById('dip-purchase-price')?.value;

  // Validate
  if (!loanAmount || !term || !rate) {
    showToast('Please fill in loan amount, term, and rate', true);
    return;
  }
  if (parseFloat(ltv) > 75) {
    if (!confirm('LTV exceeds 75% maximum. Are you sure you want to proceed?')) return;
  }
  if (parseFloat(rate) < 0.85) {
    if (!confirm('Rate is below 0.85% minimum. Are you sure you want to proceed?')) return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/issue-dip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes,
        dip_data: {
          loan_amount: parseFloat(loanAmount),
          property_value: parseFloat(propertyValue) || null,
          purchase_price: parseFloat(purchasePrice) || null,
          ltv: parseFloat(ltv) || null,
          term_months: parseInt(term),
          rate_monthly: parseFloat(rate),
          interest_servicing: interest,
          arrangement_fee_pct: parseFloat(arrFee) || 2,
          exit_strategy: exitStrategy,
          loan_purpose: purpose,
          conditions: notes,
          removed_properties: getDipRemovedProperties()
        }
      })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('DIP issued successfully');
      clearDipRemovedProperties();
      // Reload deal
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to issue DIP', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Submit credit decision (approve/decline/moreinfo)
 */
export async function creditDecision(decision) {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('credit-notes')?.value || '';
  const conditions = document.getElementById('credit-conditions')?.value || '';

  if (!notes && decision !== 'moreinfo') {
    showToast('Please provide credit assessment notes', true);
    return;
  }

  const confirmMsg = decision === 'approve' ? 'Issue In-Principle Approval? This will be visible to the broker/borrower.' :
                     decision === 'decline' ? 'Decline this deal?' : 'Request more information?';
  if (!confirm(confirmMsg)) return;

  try {
    const nextStage = decision === 'approve' ? 'info_gathering' : decision === 'decline' ? 'declined' : 'assigned';

    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/credit-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, notes, conditions, next_stage: nextStage })
    });
    const data = await resp.json();
    if (resp.ok) {
      const msgs = { approve: 'In-Principle Approval issued', decline: 'Deal declined', moreinfo: 'Sent back for more information' };
      showToast(msgs[decision] || 'Decision recorded');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to record decision', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Generate AI termsheet
 */
export async function generateAiTermsheet() {
  const dealId = getCurrentDealId();
  const data = document.getElementById('ai-termsheet-data')?.value || '';
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/generate-ai-termsheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_termsheet_data: data })
    });
    const respData = await resp.json();
    if (resp.ok) {
      showToast('AI termsheet generated');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(respData.error || 'Failed to generate termsheet', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Request fee
 */
export async function requestFee() {
  const dealId = getCurrentDealId();
  const amount = document.getElementById('fee-amount-action')?.value;
  if (!amount) {
    showToast('Please enter a fee amount', true);
    return;
  }
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/request-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_amount: parseFloat(amount) })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Fee requested');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to request fee', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * Confirm fee and advance to fee_paid
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
