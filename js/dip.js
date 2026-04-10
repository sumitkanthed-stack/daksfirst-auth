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
    // Only approve if not removed (check if valuation input is disabled)
    const valInput = document.getElementById(`dip-prop-val-${i}`);
    if (!valInput || !valInput.disabled) {
      approveDipProperty(i);
    }
  });
}

/**
 * Remove a property from DIP security schedule
 */
export function removeDipProperty(idx) {
  const row = document.getElementById(`dip-prop-${idx}`);
  if (!row) return;

  const addr = row.querySelectorAll('td')[1].textContent;
  if (!confirm('Remove "' + addr.substring(0, 50) + '..." from the security package?')) return;

  // Visual: strike-through, faded
  row.style.background = '#fee2e2';
  row.style.opacity = '0.4';
  row.querySelectorAll('td').forEach(td => td.style.textDecoration = 'line-through');

  // Status → Removed
  const statusEl = document.getElementById(`dip-prop-status-${idx}`);
  if (statusEl) statusEl.innerHTML = '<span style="padding:2px 8px;background:#fee2e2;color:#991b1b;border-radius:10px;font-size:10px;font-weight:600;">Removed</span>';

  // Buttons → replace with "Add Back"
  const actionCell = row.querySelector('td:last-child');
  if (actionCell) {
    actionCell.innerHTML = `<button onclick="window.addBackDipProperty && window.addBackDipProperty(${idx})" style="background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600;">Add Back</button>`;
  }

  // Zero out valuation input for this property
  const valInput = document.getElementById(`dip-prop-val-${idx}`);
  if (valInput) { valInput.dataset.removedVal = valInput.value; valInput.value = '0'; valInput.disabled = true; }

  // Track removal in state
  addDipRemovedProperty({ index: idx, address: addr });

  // Update removed display + header + totals
  updatePropertyScheduleUI();
  calcDipLtv();
  if (window.validateDipChecklist) window.validateDipChecklist();
}

/**
 * Add back a previously removed property
 */
export function addBackDipProperty(idx) {
  const row = document.getElementById(`dip-prop-${idx}`);
  if (!row) return;

  // Restore visual
  row.style.background = '';
  row.style.opacity = '1';
  row.querySelectorAll('td').forEach(td => td.style.textDecoration = 'none');

  // Status → Pending
  const statusEl = document.getElementById(`dip-prop-status-${idx}`);
  if (statusEl) statusEl.innerHTML = '<span style="padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:10px;font-size:10px;">Pending</span>';

  // Restore buttons
  const actionCell = row.querySelector('td:last-child');
  if (actionCell) {
    actionCell.innerHTML = `<button id="dip-prop-approve-${idx}" onclick="window.approveDipProperty && window.approveDipProperty(${idx})" style="background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;margin-right:4px;">Approve</button><button id="dip-prop-remove-${idx}" onclick="window.removeDipProperty && window.removeDipProperty(${idx})" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;">Remove</button>`;
  }

  // Restore valuation
  const valInput = document.getElementById(`dip-prop-val-${idx}`);
  if (valInput) { valInput.value = valInput.dataset.removedVal || '0'; valInput.disabled = false; delete valInput.dataset.removedVal; }

  // Remove from state
  const removed = getDipRemovedProperties();
  const newRemoved = removed.filter(p => p.index !== idx);
  setDipRemovedProperties(newRemoved);

  // Update UI + totals
  updatePropertyScheduleUI();
  calcDipLtv();
  if (window.validateDipChecklist) window.validateDipChecklist();
}

/**
 * Update the security schedule header, removed summary, and total valuation
 */
function updatePropertyScheduleUI() {
  const table = document.getElementById('dip-property-table');
  if (!table) return;
  const allRows = table.querySelectorAll('tbody tr');
  const totalProps = allRows.length;
  const removed = getDipRemovedProperties();
  const removedCount = removed.length;
  const activeCount = totalProps - removedCount;

  // Update header text
  const headerEl = document.getElementById('dip-schedule-header');
  if (headerEl) {
    if (removedCount > 0) {
      headerEl.innerHTML = `Security Schedule &mdash; <span style="color:#15803d;font-weight:700;">${activeCount}</span> of ${totalProps} Accepted`;
    } else {
      headerEl.innerHTML = `Security Schedule &mdash; ${totalProps} ${totalProps === 1 ? 'Property' : 'Properties'}`;
    }
  }

  // Update removed properties display
  const removedDiv = document.getElementById('dip-removed-props');
  if (removedDiv) {
    if (removedCount > 0) {
      removedDiv.style.display = 'block';
      removedDiv.innerHTML = '<strong style="color:#991b1b;">Removed from security:</strong> ' + removed.map(p => sanitizeHtml(p.address.substring(0, 40)) + '...').join('; ');
    } else {
      removedDiv.style.display = 'none';
      removedDiv.innerHTML = '';
    }
  }

  // Update total valuation (only active properties)
  let total = 0;
  allRows.forEach((row, i) => {
    const isRemoved = removed.some(p => p.index === i);
    if (!isRemoved) {
      const valInput = document.getElementById(`dip-prop-val-${i}`);
      if (valInput) total += parseFormattedNumber(valInput.value) || 0;
    }
  });
  const totalEl = document.getElementById('dip-prop-val-total');
  if (totalEl) totalEl.textContent = '£' + formatNumber(total);

  // Update the auto-summed property value field
  const propValueInput = document.getElementById('dip-property-value');
  if (propValueInput) propValueInput.value = formatNumber(total);

  // Update number of properties field
  const numPropsInput = document.getElementById('dip-num-properties');
  if (numPropsInput) numPropsInput.value = removedCount > 0 ? `${activeCount} of ${totalProps}` : totalProps;
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
 * Submit credit decision (approve/decline only — moreinfo uses submitMoreInfo)
 */
export async function creditDecision(decision) {
  const dealId = getCurrentDealId();
  const notes = document.getElementById('credit-notes')?.value || '';
  const conditions = document.getElementById('credit-conditions')?.value || '';
  const retainedMonths = document.getElementById('credit-retained-months')?.value;

  // ── Decline: require a reason ──
  if (decision === 'decline') {
    if (!notes) {
      showToast('Please provide a reason for declining in the Credit Assessment Notes', true);
      return;
    }
    if (!confirm('Decline this deal? This decision will be final.\n\nReason: ' + notes.substring(0, 200))) return;
  }

  // ── Approve: require notes ──
  if (decision === 'approve') {
    if (!notes) {
      showToast('Please provide credit assessment notes before approving', true);
      return;
    }
    if (!confirm('Issue In-Principle Approval?\n\nThis will be visible to the borrower once approved.')) return;
  }

  try {
    const body = { decision, notes, conditions };
    if (retainedMonths !== undefined && retainedMonths !== null) {
      body.retained_months = parseInt(retainedMonths, 10);
    }

    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/credit-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (resp.ok) {
      const msgs = {
        approve: 'In-Principle Approval issued — awaiting borrower acceptance',
        decline: 'Deal declined',
      };
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
 * Submit More Info request — credit sends a query back to the RM
 * Called from the More Info modal (not browser prompt)
 */
export async function submitMoreInfo() {
  const dealId = getCurrentDealId();
  const question = document.getElementById('moreinfo-question')?.value || '';
  const creditNotes = document.getElementById('credit-notes')?.value || '';

  if (!question.trim()) {
    showToast('Please describe what information you need from the RM', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/credit-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'moreinfo',
        notes: question,
        conditions: creditNotes
      })
    });
    const data = await resp.json();
    if (resp.ok) {
      // Close modal
      const modal = document.getElementById('moreinfo-modal');
      if (modal) modal.style.display = 'none';
      showToast('Query sent to RM — deal returned to their queue');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to send query', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}

/**
 * RM responds to a credit query and can then re-issue DIP
 */
export async function respondToCreditQuery() {
  const dealId = getCurrentDealId();
  const response = document.getElementById('rm-query-response')?.value || '';

  if (!response.trim()) {
    showToast('Please provide a response to the credit query', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/respond-credit-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response })
    });
    const data = await resp.json();
    if (resp.ok) {
      showToast('Response recorded — you can now re-issue the DIP');
      import('./deal-detail.js').then(m => m.showDealDetail(dealId));
    } else {
      showToast(data.error || 'Failed to submit response', true);
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
    window.open(url, '_blank');  // Opens PDF in browser viewer
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
