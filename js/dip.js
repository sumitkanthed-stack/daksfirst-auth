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

  const address = row.children[1].textContent || '';
  const postcode = row.children[2].textContent || '';

  addDipRemovedProperty({ address, postcode, index: idx });
  row.style.display = 'none';

  // Update display
  const removed = getDipRemovedProperties();
  const div = document.getElementById('dip-removed-props');
  if (div) {
    if (removed.length > 0) {
      div.style.display = 'block';
      div.textContent = `Properties removed: ${removed.map(p => p.address).join('; ')}`;
    } else {
      div.style.display = 'none';
    }
  }

  calcDipLtv();
}

/**
 * Calculate DIP LTV and update summary
 */
export function calcDipLtv() {
  const loanEl = document.getElementById('dip-loan-amount');
  const termEl = document.getElementById('dip-term');
  const rateEl = document.getElementById('dip-rate');
  const feeEl = document.getElementById('dip-arrangement-fee');
  const ltvEl = document.getElementById('dip-ltv');
  const valEl = document.getElementById('dip-property-value');
  const summaryEl = document.getElementById('dip-summary');

  if (!loanEl || !termEl || !rateEl || !feeEl || !ltvEl || !valEl) return;

  const loan = Number(loanEl.value) || 0;
  const term = Number(termEl.value) || 1;
  const rate = Number(rateEl.value) || 0.95;
  const fee = Number(feeEl.value) || 2;
  const val = Number(valEl.value) || 1;

  // Calculate LTV
  let ltv = 0;
  if (val > 0) {
    ltv = Math.round((loan / val) * 100);
  }

  ltvEl.value = ltv;

  // Calculate monthly interest cost
  const monthlyRate = rate / 100;
  const monthlyInterest = loan * monthlyRate;
  const totalInterest = monthlyInterest * term;
  const totalFee = loan * (fee / 100);
  const totalCost = totalFee + totalInterest;

  // Update summary
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;">
        <div>Loan Amount: <strong>£${formatNumber(loan)}</strong></div>
        <div>LTV: <strong>${ltv}%</strong></div>
        <div>Term: <strong>${term} months</strong></div>
        <div>Rate: <strong>${rate.toFixed(2)}%/month</strong></div>
        <div>Monthly Interest: <strong>£${formatNumber(Math.round(monthlyInterest))}</strong></div>
        <div>Total Interest: <strong>£${formatNumber(Math.round(totalInterest))}</strong></div>
        <div>Arrangement Fee: <strong>£${formatNumber(Math.round(totalFee))}</strong></div>
        <div>Total Cost: <strong>£${formatNumber(Math.round(totalCost))}</strong></div>
      </div>
    `;
  }
}

/**
 * Issue DIP to broker
 */
export async function issueDip() {
  const dealId = getCurrentDealId();
  const loan = document.getElementById('dip-loan-amount').value;
  const term = document.getElementById('dip-term').value;
  const rate = document.getElementById('dip-rate').value;
  const interest = document.getElementById('dip-interest').value;
  const fee = document.getElementById('dip-arrangement-fee').value;
  const notes = document.getElementById('dip-notes').value.trim();
  const removed = getDipRemovedProperties();

  if (!loan || !term || !rate) {
    showToast('Please fill in all required DIP fields', true);
    return;
  }

  if (Number(rate) < 0.85) {
    showToast('Rate must be at least 0.85%', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/issue-dip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loan_amount: loan,
        term_months: term,
        rate_monthly: rate,
        interest_servicing: interest,
        arrangement_fee_pct: fee,
        conditions: notes,
        removed_properties: removed
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
    showToast('Error issuing DIP', true);
  }
}

/**
 * Submit credit decision (approve/decline/moreinfo)
 */
export async function creditDecision(decision) {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('credit-notes').value.trim();
  const conditions = document.getElementById('credit-conditions').value.trim();

  if (!notes) {
    showToast('Please provide assessment notes', true);
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
      showToast(`Credit decision submitted: ${decision}`);
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit decision', true);
    }
  } catch (err) {
    showToast('Error submitting credit decision', true);
  }
}

/**
 * Generate AI termsheet
 */
export async function generateAiTermsheet() {
  const dealId = getCurrentDealId();
  const data = document.getElementById('ai-termsheet-data').value.trim();

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/generate-termsheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsheet_data: data })
    });

    const result = await resp.json();
    if (resp.ok) {
      showToast('Termsheet generated successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(result.error || 'Failed to generate termsheet', true);
    }
  } catch (err) {
    showToast('Error generating termsheet', true);
  }
}

/**
 * Request fee
 */
export async function requestFee() {
  const dealId = getCurrentDealId();
  const amount = document.getElementById('fee-amount-action').value;

  if (!amount) {
    showToast('Please enter a fee amount', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/request-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_amount: amount })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('Fee requested successfully');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to request fee', true);
    }
  } catch (err) {
    showToast('Error requesting fee', true);
  }
}

/**
 * Confirm fee and advance to fee_paid
 */
export async function confirmFeeAndAdvance() {
  const dealId = getCurrentDealId();
  const feeType = document.getElementById('fee-type-action').value;
  const amount = document.getElementById('fee-amount-action2').value;
  const feeDate = document.getElementById('fee-date-action').value;

  if (!amount || !feeDate) {
    showToast('Please fill in all fee fields', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/admin/deals/${dealId}/confirm-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fee_type: feeType, fee_amount: amount, fee_date: feeDate })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('Fee confirmed');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to confirm fee', true);
    }
  } catch (err) {
    showToast('Error confirming fee', true);
  }
}
