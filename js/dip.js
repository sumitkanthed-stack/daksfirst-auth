import { API_BASE } from './config.js';
import { showToast, formatNumber, formatPct, sanitizeHtml, parseFormattedNumber } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId, setDipRemovedProperties, getDipRemovedProperties, addDipRemovedProperty, removeDipRemovedProperty, clearDipRemovedProperties } from './state.js';

/**
 * Approve a property in the DIP (RM confirms it as acceptable security)
 */
export function approveDipProperty(idx) {
  const statusEl = document.getElementById(`dip-prop-status-${idx}`);
  const approveBtn = document.getElementById(`dip-prop-approve-${idx}`);
  if (statusEl) {
    statusEl.innerHTML = '<span style="padding:2px 8px;background:#dcfce7;color:#166534;border-radius:10px;font-size:10px;font-weight:600;">Approved</span>';
  }
  if (approveBtn) {
    approveBtn.disabled = true;
    approveBtn.textContent = 'Approved';
    approveBtn.style.background = '#86efac';
    approveBtn.style.cursor = 'default';
  }
  // Re-validate checklist after property approval
  if (window.validateDipChecklist) window.validateDipChecklist();
}

/**
 * Approve all properties in bulk
 */
export function approveAllDipProperties() {
  const table = document.getElementById('dip-property-table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach((row, i) => {
    // Only approve if not already removed
    if (row.style.opacity !== '0.5') {
      approveDipProperty(i);
    }
  });
}

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
  // Re-validate checklist after property removal
  if (window.validateDipChecklist) window.validateDipChecklist();
}

/**
 * Calculate DIP LTV and update summary with full retained interest logic
 * Default: 6 months interest retained from gross loan
 * Client day zero = gross loan - retained interest - arrangement fee - valuation cost - legal cost
 * Broker fee is disclosed to borrower
 */
export function calcDipLtv() {
  const loan = parseFormattedNumber(document.getElementById('dip-loan-amount')?.value);
  const val = parseFormattedNumber(document.getElementById('dip-property-value')?.value);
  const term = parseInt(document.getElementById('dip-term')?.value) || 0;
  const rate = parseFloat(document.getElementById('dip-rate')?.value) || 0;
  const arrFee = parseFloat(document.getElementById('dip-arrangement-fee')?.value) || 0;
  const interest = document.getElementById('dip-interest')?.value || 'retained';
  const retainedMonths = parseInt(document.getElementById('dip-retained-months')?.value) || 6;
  const valuationCost = parseFormattedNumber(document.getElementById('dip-valuation-cost')?.value);
  const legalCost = parseFormattedNumber(document.getElementById('dip-legal-cost')?.value);
  const brokerFeePct = parseFloat(document.getElementById('dip-broker-fee')?.value) || 0;

  // Calculate LTV (2 decimal places)
  const ltv = val > 0 ? ((loan / val) * 100) : 0;
  const ltvEl = document.getElementById('dip-ltv');
  if (ltvEl) ltvEl.value = ltv.toFixed(2);

  // Calculate costs
  const totalInterest = loan * (rate / 100) * term;
  const retainedInterest = interest === 'retained' ? loan * (rate / 100) * retainedMonths : 0;
  const arrangementFee = loan * (arrFee / 100);
  const brokerFee = loan * (brokerFeePct / 100);
  const lenderNetArrFee = arrangementFee - brokerFee; // Lender keeps this after paying broker

  // Lender day zero = gross loan - retained interest - arrangement fee (broker fee is INSIDE arr fee)
  const lenderDayZero = loan - retainedInterest - arrangementFee;

  // Client day zero = lender day zero - valuation cost - legal cost (paid by client)
  const clientDayZero = lenderDayZero - valuationCost - legalCost;

  // LTV check
  const ltvOk = ltv <= 75;
  const rateOk = rate >= 0.85;

  // Update fee schedule display fields
  const arrDisplay = document.getElementById('dip-fee-arr-display');
  if (arrDisplay) arrDisplay.textContent = '£' + formatNumber(arrangementFee);
  const brokerDisplay = document.getElementById('dip-fee-broker-display');
  if (brokerDisplay) brokerDisplay.textContent = '£' + formatNumber(brokerFee);
  const valDisplay = document.getElementById('dip-fee-val-display');
  if (valDisplay) valDisplay.textContent = '£' + formatNumber(valuationCost);
  const legalDisplay = document.getElementById('dip-fee-legal-display');
  if (legalDisplay) legalDisplay.textContent = '£' + formatNumber(legalCost);

  const summaryEl = document.getElementById('dip-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>LTV: <strong style="color:${ltvOk ? '#15803d' : '#e53e3e'};">${formatPct(ltv)}%</strong> ${!ltvOk ? '<span style="color:#e53e3e;font-weight:600;">(exceeds 75% max!)</span>' : ''}</div>
        <div>Rate: <strong style="color:${rateOk ? '#15803d' : '#e53e3e'};">${formatPct(rate)}%/m</strong> ${!rateOk ? '<span style="color:#e53e3e;font-weight:600;">(below 0.85% min!)</span>' : ''}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #fbbf24;">
        <div>Gross Loan: <strong>£${formatNumber(loan)}</strong></div>
        <div>Total Interest (${term}m): <strong>£${formatNumber(totalInterest)}</strong></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
        <div>Retained Interest (${retainedMonths}m): <strong style="color:#b45309;">£${formatNumber(retainedInterest)}</strong></div>
        <div>Arrangement Fee (${formatPct(arrFee)}%): <strong>£${formatNumber(arrangementFee)}</strong></div>
      </div>
      ${brokerFeePct > 0 ? `<div style="margin-top:4px;padding:4px 8px;background:#fefce8;border-radius:4px;font-size:12px;">↳ of which Broker (${formatPct(brokerFeePct)}%): <strong>£${formatNumber(brokerFee)}</strong> <span style="color:#6b7280;">(from arrangement fee, not additional)</span> · Lender nets: <strong>£${formatNumber(lenderNetArrFee)}</strong></div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
        <div>Valuation Cost (client): <strong>£${formatNumber(valuationCost)}</strong></div>
        <div>Legal Cost (client): <strong>£${formatNumber(legalCost)}</strong></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;padding-top:8px;border-top:2px solid #92400e;">
        <div>Lender Day Zero: <strong style="font-size:14px;">£${formatNumber(lenderDayZero)}</strong></div>
        <div>Client Day Zero: <strong style="font-size:14px;color:${clientDayZero > 0 ? '#15803d' : '#e53e3e'};">£${formatNumber(clientDayZero)}</strong></div>
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
  const retainedMonths = document.getElementById('dip-retained-months')?.value || '6';
  const valuationCost = document.getElementById('dip-valuation-cost')?.value || '0';
  const legalCost = document.getElementById('dip-legal-cost')?.value || '0';
  const brokerFeePct = document.getElementById('dip-broker-fee')?.value || '0';

  // Corporate borrower fields
  const pgUbo = document.getElementById('dip-pg-ubo')?.value || null;
  const fixedCharge = document.getElementById('dip-fixed-charge')?.value || 'first_charge';
  const uboNames = document.getElementById('dip-ubo-names')?.value || '';

  // Fee schedule
  const feeSchedule = {
    arrangement: { when: document.getElementById('dip-fee-arr-when')?.value || 'on_completion', method: document.getElementById('dip-fee-arr-method')?.value || 'deducted_from_advance' },
    valuation: { when: document.getElementById('dip-fee-val-when')?.value || 'upfront', method: document.getElementById('dip-fee-val-method')?.value || 'direct_payment' },
    legal: { when: document.getElementById('dip-fee-legal-when')?.value || 'on_completion', method: document.getElementById('dip-fee-legal-method')?.value || 'direct_payment' },
    broker: { when: document.getElementById('dip-fee-broker-when')?.value || 'on_completion', method: document.getElementById('dip-fee-broker-method')?.value || 'deducted_from_advance' }
  };

  // Validate
  if (!parseFormattedNumber(loanAmount) || !term || !rate) {
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
          loan_amount: parseFormattedNumber(loanAmount),
          property_value: parseFormattedNumber(propertyValue) || null,
          purchase_price: parseFormattedNumber(purchasePrice) || null,
          ltv: parseFloat(ltv) || null,
          term_months: parseInt(term),
          rate_monthly: parseFloat(rate),
          interest_servicing: interest,
          arrangement_fee_pct: parseFloat(arrFee) || 2,
          retained_months: parseInt(retainedMonths) || 6,
          valuation_cost: parseFormattedNumber(valuationCost),
          legal_cost: parseFormattedNumber(legalCost),
          broker_fee_pct: parseFloat(brokerFeePct) || 0,
          // Corporate borrower / security
          pg_from_ubo: pgUbo,
          fixed_charge: fixedCharge,
          ubo_guarantor_names: uboNames,
          // Fee schedule
          fee_schedule: feeSchedule,
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
      body: JSON.stringify({ fee_amount: parseFormattedNumber(amount) })
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
/**
 * Accept DIP — borrower/broker clicks Accept in-portal
 */
export async function viewDipPdf(submissionId) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/dip-pdf`, { method: 'GET' });
    if (!resp.ok) {
      showToast('Failed to load DIP PDF', true);
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  } catch (err) {
    showToast('Network error loading DIP PDF', true);
  }
}

export async function acceptDip(submissionId) {
  if (!confirm('By accepting this DIP, you confirm your intention to proceed on the terms outlined. Continue?')) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${submissionId}/accept-dip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('DIP accepted successfully');
      // Reload deal view
      const dealId = getCurrentDealId() || submissionId;
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to accept DIP', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

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
      body: JSON.stringify({ fee_type: feeType, amount: parseFormattedNumber(amount), payment_date: paymentDate })
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
      body: JSON.stringify({ new_stage: 'fee_paid', comments: `Fee confirmed: ${feeType} £${formatNumber(parseFormattedNumber(amount))}` })
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
