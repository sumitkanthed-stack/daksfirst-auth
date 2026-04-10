import { API_BASE } from './config.js';
import { showToast, sanitizeHtml } from './utils.js';
import { getAuthToken, fetchWithAuth } from './auth.js';
import { getCurrentDealId } from './state.js';

/**
 * Save onboarding tab data
 */
export async function saveOnboardingTab(tabName) {
  const dealId = getCurrentDealId();
  if (!dealId) {
    showToast('No deal selected', true);
    return;
  }

  // Tab form field mappings
  const tabFormMap = {
    kyc: ['kyc-full-name', 'kyc-dob', 'kyc-ni-number', 'kyc-nationality', 'kyc-country-birth', 'kyc-current-address', 'kyc-address-history', 'kyc-pep', 'kyc-source-wealth', 'kyc-source-deposit', 'kyc-ubo-declaration'],
    financials: ['fin-credit-consent', 'fin-adverse', 'fin-mortgage-schedule'],
    valuation: ['val-day1-value', 'val-reinstatement', 'val-gdv', 'val-90day', 'val-180day', 'val-solicitor-firm', 'val-sra-number', 'val-solicitor-partner'],
    refurbishment: ['refurb-contractor-name', 'refurb-contractor-accred', 'refurb-day1', 'refurb-gdv', 'refurb-monitoring'],
    exit_evidence: ['exit-narrative'],
    aml: ['aml-source-wealth', 'aml-pep', 'aml-utr', 'aml-tax-residency', 'aml-broker-ack', 'aml-conflicts'],
    insurance: ['ins-sum-insured']
  };

  const fields = tabFormMap[tabName] || [];
  const data = {};
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) data[id] = el.value;
  });

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/deals/${dealId}/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: tabName, data })
    });

    const result = await resp.json();
    if (resp.ok) {
      showToast(`${tabName.replace(/_/g, ' ')} data saved successfully`);
    } else {
      showToast(result.error || 'Failed to save', true);
    }
  } catch (err) {
    showToast('Network error — could not save', true);
  }
}

/**
 * Populate onboarding form with existing data
 */
export function populateOnboardingData(onboardingData) {
  if (!onboardingData) return;
  Object.keys(onboardingData).forEach(tab => {
    const tabData = onboardingData[tab];
    if (!tabData) return;
    Object.keys(tabData).forEach(fieldId => {
      if (fieldId === 'updated_at') return;
      const el = document.getElementById(fieldId);
      if (el) el.value = sanitizeHtml(tabData[fieldId]);
    });
  });
}

/**
 * Switch detail tabs
 */
export function switchDetailTab(btn) {
  if (!btn) return;
  const tabId = btn.dataset.dtab;

  // Block locked Phase 2 tabs
  if (btn.classList.contains('locked')) {
    showToast('This section unlocks after the termsheet is signed.', true);
    return;
  }

  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('active');
}

/**
 * Check broker onboarding status
 */
export async function checkBrokerOnboardingStatus() {
  const dealId = getCurrentDealId();
  if (!dealId) return;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding-status`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (resp.ok && !data.completed) {
      // Show onboarding modal or prompt
      showBrokerOnboarding();
    }
  } catch (err) {
    console.error('Error checking onboarding status:', err);
  }
}

/**
 * Show broker onboarding modal
 */
export function showBrokerOnboarding() {
  const modal = document.getElementById('broker-onboarding-modal');
  if (modal) {
    modal.style.display = 'block';
    loadBrokerOnboarding();
  }
}

/**
 * Hide broker onboarding modal
 */
export function hideBrokerOnboarding() {
  const modal = document.getElementById('broker-onboarding-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

/**
 * Toggle broker company fields
 */
export function toggleBrokerCompanyFields() {
  const brokerType = document.getElementById('broker-type').value;
  const companyFields = document.getElementById('broker-company-fields');
  if (companyFields) {
    companyFields.style.display = brokerType === 'company' ? 'block' : 'none';
  }
}

/**
 * Load broker onboarding form
 */
export async function loadBrokerOnboarding() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (resp.ok && data.onboarding_data) {
      populateBrokerOnboardingForm(data.onboarding_data);
    }
  } catch (err) {
    console.error('Error loading broker onboarding:', err);
  }
}

/**
 * Populate broker onboarding form
 */
function populateBrokerOnboardingForm(data) {
  const fields = {
    'broker-type': 'broker_type',
    'broker-company-name': 'company_name',
    'broker-company-reg': 'company_registration',
    'broker-fca': 'fca_number',
    'broker-address': 'address',
    'broker-phone': 'phone'
  };

  Object.keys(fields).forEach(inputId => {
    const el = document.getElementById(inputId);
    if (el && data[fields[inputId]]) {
      el.value = sanitizeHtml(data[fields[inputId]]);
    }
  });

  // Toggle company fields
  toggleBrokerCompanyFields();
}

/**
 * Save broker onboarding
 */
export async function saveBrokerOnboarding() {
  const brokerType = document.getElementById('broker-type').value;
  const companyName = document.getElementById('broker-company-name').value.trim();
  const companyReg = document.getElementById('broker-company-reg').value.trim();
  const fca = document.getElementById('broker-fca').value.trim();
  const address = document.getElementById('broker-address').value.trim();
  const phone = document.getElementById('broker-phone').value.trim();

  if (!brokerType || !address || !phone) {
    showToast('Please fill in all required fields', true);
    return;
  }

  if (brokerType === 'company' && (!companyName || !fca)) {
    showToast('Company details required', true);
    return;
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        broker_type: brokerType,
        company_name: companyName || null,
        company_registration: companyReg || null,
        fca_number: fca || null,
        address,
        phone
      })
    });

    const data = await resp.json();
    if (resp.ok) {
      showToast('Broker information saved successfully');
      hideBrokerOnboarding();
    } else {
      showToast(data.error || 'Failed to save', true);
    }
  } catch (err) {
    showToast('Network error', true);
  }
}
