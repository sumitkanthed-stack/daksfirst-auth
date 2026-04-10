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
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
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
  const isCompany = document.getElementById('bonb-is-company')?.checked;
  const companyFields = document.getElementById('broker-company-fields');
  if (companyFields) {
    companyFields.style.display = isCompany ? 'block' : 'none';
  }
}

/**
 * Load broker onboarding form (pre-fill from saved data)
 */
export async function loadBrokerOnboarding() {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'GET'
    });

    const data = await resp.json();
    if (resp.ok && data.onboarding) {
      const o = data.onboarding;
      if (o.individual_name) {
        document.getElementById('bonb-name').value = sanitizeHtml(o.individual_name);
      }
      if (o.date_of_birth) {
        document.getElementById('bonb-dob').value = o.date_of_birth.substring(0, 10);
      }
      if (o.is_company) {
        const checkbox = document.getElementById('bonb-is-company');
        if (checkbox) checkbox.checked = true;
        const companyFields = document.getElementById('broker-company-fields');
        if (companyFields) companyFields.style.display = 'block';
        if (o.company_name) {
          document.getElementById('bonb-company-name').value = sanitizeHtml(o.company_name);
        }
        if (o.company_number) {
          document.getElementById('bonb-company-number').value = sanitizeHtml(o.company_number);
        }
      }
      if (o.bank_name) {
        document.getElementById('bonb-bank-name').value = sanitizeHtml(o.bank_name);
      }
      if (o.bank_account_name) {
        document.getElementById('bonb-account-name').value = sanitizeHtml(o.bank_account_name);
      }
      if (o.bank_sort_code) {
        document.getElementById('bonb-sort-code').value = sanitizeHtml(o.bank_sort_code);
      }
      if (o.bank_account_no) {
        document.getElementById('bonb-account-no').value = sanitizeHtml(o.bank_account_no);
      }
    }
  } catch (err) {
    console.error('Error loading broker onboarding:', err);
  }
}

/**
 * Save broker onboarding (KYC + bank details)
 */
export async function saveBrokerOnboarding() {
  const name = document.getElementById('bonb-name')?.value.trim();
  const dob = document.getElementById('bonb-dob')?.value;
  const isCompany = document.getElementById('bonb-is-company')?.checked;
  const companyName = document.getElementById('bonb-company-name')?.value.trim();
  const companyNumber = document.getElementById('bonb-company-number')?.value.trim();
  const bankName = document.getElementById('bonb-bank-name')?.value.trim();
  const accountName = document.getElementById('bonb-account-name')?.value.trim();
  const sortCode = document.getElementById('bonb-sort-code')?.value.trim();
  const accountNo = document.getElementById('bonb-account-no')?.value.trim();

  if (!name || !bankName || !accountName || !sortCode || !accountNo) {
    showToast('Please fill in all required fields (name, bank details)', true);
    return;
  }

  const btn = document.getElementById('bonb-submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
  }

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/broker/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        individual_name: name,
        date_of_birth: dob || null,
        is_company: isCompany || false,
        company_name: companyName || null,
        company_number: companyNumber || null,
        bank_name: bankName,
        bank_sort_code: sortCode,
        bank_account_no: accountNo,
        bank_account_name: accountName
      })
    });

    const data = await resp.json();
    if (resp.ok) {
      const successEl = document.getElementById('bonb-success');
      if (successEl) successEl.style.display = 'block';
      showToast('Broker onboarding submitted for review');
    } else {
      showToast(data.error || 'Failed to save', true);
    }
  } catch (err) {
    showToast('Network error', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save & Submit for Review';
    }
  }
}
