/**
 * Companies House Frontend Integration
 *
 * BROKER VIEW: Simple — type company name, pick from dropdown, see a verified badge.
 * INTERNAL VIEW: Full verification panel with risk flags, officers, PSCs, charges
 *                (rendered in deal-detail.js for RM/credit/compliance).
 */

import { API_BASE } from './config.js';
import { fetchWithAuth } from './auth.js';

// ─── State ───────────────────────────────────────────────────────────────────
let _lastVerifiedNumber = null;
let _verificationData = null;
let _searchTimeout = null;

// ─── UK SIC 2007 code → description (source: UK Office for National Statistics
//     Standard Industrial Classification 2007, abbreviated to common codes for
//     property, finance, construction, real estate, professional services). ───
const _SIC_DESCRIPTIONS = {
  // Property / Real estate (most relevant for bridging)
  '41100':'Development of building projects',
  '41201':'Construction of commercial buildings',
  '41202':'Construction of domestic buildings',
  '68100':'Buying and selling of own real estate',
  '68201':'Renting and operating of Housing Association real estate',
  '68202':'Letting and operating of conference and exhibition centres',
  '68209':'Other letting and operating of own or leased real estate',
  '68310':'Real estate agencies',
  '68320':'Management of real estate on a fee or contract basis',
  // Finance / Holding / Investment
  '64110':'Central banking',
  '64190':'Other monetary intermediation',
  '64202':'Activities of production holding companies',
  '64205':'Activities of financial services holding companies',
  '64209':'Activities of other holding companies n.e.c.',
  '64301':'Activities of investment trusts',
  '64302':'Activities of unit trusts',
  '64303':'Activities of venture and development capital companies',
  '64304':'Activities of open-ended investment companies',
  '64305':'Activities of property unit trusts',
  '64306':'Activities of real estate investment trusts',
  '64910':'Financial leasing',
  '64921':'Credit granting by non-deposit taking finance houses',
  '64922':'Activities of mortgage finance companies',
  '64929':'Other credit granting n.e.c.',
  '64991':'Security dealing on own account',
  '64999':'Financial intermediation not elsewhere classified',
  '66110':'Administration of financial markets',
  '66120':'Security and commodity contracts dealing activities',
  '66190':'Other activities auxiliary to financial services',
  '66220':'Activities of insurance agents and brokers',
  '66300':'Fund management activities',
  // Construction / Trade
  '43110':'Demolition','43120':'Site preparation','43210':'Electrical installation',
  '43220':'Plumbing, heat and air-conditioning installation','43290':'Other construction installation',
  '43310':'Plastering','43320':'Joinery installation','43330':'Floor and wall covering',
  '43341':'Painting','43342':'Glazing','43390':'Other building completion and finishing',
  '43991':'Scaffold erection','43999':'Other specialised construction activities n.e.c.',
  // Professional services
  '69101':'Barristers at law','69102':'Solicitors','69109':'Activities of patent and copyright agents',
  '69201':'Accounting and auditing activities','69202':'Bookkeeping activities','69203':'Tax consultancy',
  '70100':'Activities of head offices','70210':'Public relations and communication activities',
  '70221':'Financial management','70229':'Management consultancy activities other than financial management',
  '71111':'Architectural activities','71112':'Urban planning and landscape architectural activities',
  '71121':'Engineering design activities for industrial process','71122':'Engineering related scientific consulting',
  '71129':'Other engineering activities','71200':'Technical testing and analysis',
  // Retail / Hospitality
  '47110':'Retail sale in non-specialised stores (food predominating)',
  '47190':'Other retail sale in non-specialised stores','47910':'Retail sale via mail order or Internet',
  '55100':'Hotels and similar accommodation','55201':'Holiday centres and villages',
  '55300':'Camping grounds, recreational vehicle parks','55900':'Other accommodation',
  '56101':'Licensed restaurants','56102':'Unlicensed restaurants and cafes',
  '56103':'Take-away food shops and mobile food stands','56210':'Event catering activities',
  '56290':'Other food services','56302':'Public houses and bars',
  // Healthcare / Education / Other
  '85100':'Pre-primary education','85200':'Primary education','85310':'General secondary education',
  '86101':'Hospital activities','86210':'General medical practice','86220':'Specialist medical practice',
  '87100':'Residential nursing care activities','87300':'Residential care for the elderly and disabled',
  // Tech / Info
  '62012':'Business and domestic software development','62020':'IT consultancy activities',
  '62090':'Other IT service activities','63110':'Data processing, hosting and related activities',
  // Special / catch-all
  '82990':'Other business support service activities n.e.c.',
  '99999':'Dormant Company',
  '74909':'Other professional, scientific and technical activities n.e.c.',
};
function _sicDescription(code) {
  if (!code) return null;
  const key = String(code).trim();
  return _SIC_DESCRIPTIONS[key] || null;
}

// ─── Init: attach event listeners to deal form fields (broker view) ──────────
export function initCompaniesHouse() {
  const companyNumberField = document.getElementById('deal-company-number');
  const companyNameField = document.getElementById('deal-company-name');

  if (!companyNumberField) return;

  // Inject a small verification badge container next to company number
  const corporateFields = document.getElementById('deal-corporate-fields');
  if (corporateFields && !document.getElementById('ch-verification-badge')) {
    const badge = document.createElement('div');
    badge.id = 'ch-verification-badge';
    badge.style.cssText = 'display:none;margin-top:6px;';
    corporateFields.appendChild(badge);
  }

  // Auto-verify on blur (when user tabs out of company number field)
  companyNumberField.addEventListener('blur', () => {
    const num = companyNumberField.value.trim();
    if (num.length >= 6 && num !== _lastVerifiedNumber) {
      verifyCompanyBroker(num);
    }
  });

  // Also verify on Enter key
  companyNumberField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const num = companyNumberField.value.trim();
      if (num.length >= 6) verifyCompanyBroker(num);
    }
  });

  // Company name search with debounce
  companyNameField?.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    const q = companyNameField.value.trim();
    if (q.length >= 3) {
      _searchTimeout = setTimeout(() => searchCompany(q), 400);
    } else {
      hideSearchResults();
    }
  });

  console.log('[companies-house] Frontend initialized');
}

// ─── Search companies by name (broker dropdown) ─────────────────────────────
async function searchCompany(query) {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/companies-house/search?q=${encodeURIComponent(query)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      showSearchResults(data.results);
    } else {
      hideSearchResults();
    }
  } catch (err) {
    console.error('[companies-house] Search failed:', err);
  }
}

function showSearchResults(results) {
  let dropdown = document.getElementById('ch-search-dropdown');
  const nameField = document.getElementById('deal-company-name');
  if (!nameField) return;

  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'ch-search-dropdown';
    dropdown.style.cssText = `
      position:absolute;z-index:100;background:#1a2332;border:1px solid rgba(212,168,83,0.3);
      border-radius:8px;max-height:240px;overflow-y:auto;width:100%;margin-top:2px;
      box-shadow:0 4px 12px rgba(0,0,0,0.3);
    `;
    nameField.parentElement.style.position = 'relative';
    nameField.parentElement.appendChild(dropdown);
  }

  dropdown.innerHTML = results.slice(0, 6).map(r => {
    const statusColor = r.company_status === 'active' ? '#34D399' : '#F87171';
    return `
      <div class="ch-search-item" data-number="${r.company_number}" data-name="${r.company_name}"
           style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);transition:background .15s;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:13px;font-weight:600;color:#F1F5F9;">${r.company_name}</span>
          <span style="font-size:10px;font-weight:600;color:${statusColor};text-transform:uppercase;">${r.company_status || ''}</span>
        </div>
        <div style="font-size:11px;color:#94A3B8;margin-top:2px;">${r.company_number} · ${r.date_of_creation || ''}</div>
      </div>
    `;
  }).join('');

  dropdown.style.display = 'block';

  // Attach click handlers
  dropdown.querySelectorAll('.ch-search-item').forEach(item => {
    item.addEventListener('mouseenter', () => item.style.background = 'rgba(212,168,83,0.1)');
    item.addEventListener('mouseleave', () => item.style.background = 'transparent');
    item.addEventListener('click', () => {
      const num = item.dataset.number;
      const name = item.dataset.name;
      nameField.value = name;
      document.getElementById('deal-company-number').value = num;
      hideSearchResults();
      verifyCompanyBroker(num);
    });
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', function closeDropdown(e) {
    if (!dropdown.contains(e.target) && e.target !== nameField) {
      hideSearchResults();
      document.removeEventListener('click', closeDropdown);
    }
  });
}

function hideSearchResults() {
  const dropdown = document.getElementById('ch-search-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

// ─── Broker verification: simple badge only ──────────────────────────────────
async function verifyCompanyBroker(companyNumber) {
  const badge = document.getElementById('ch-verification-badge');
  if (!badge) return;

  _lastVerifiedNumber = companyNumber;
  badge.style.display = 'block';
  badge.innerHTML = `
    <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(212,168,83,0.08);border:1px solid rgba(212,168,83,0.2);border-radius:8px;">
      <div style="width:14px;height:14px;border:2px solid rgba(212,168,83,0.3);border-top-color:#D4A853;border-radius:50%;animation:spin .6s linear infinite;"></div>
      <span style="font-size:12px;color:#D4A853;font-weight:600;">Verifying at Companies House...</span>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/companies-house/verify/${companyNumber}`);
    const data = await resp.json();

    if (!resp.ok || !data.verification?.found) {
      badge.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:8px;">
          <span style="color:#F87171;font-size:14px;">&#10007;</span>
          <span style="font-size:12px;color:#F87171;font-weight:600;">Company not found at Companies House</span>
        </div>
      `;
      _verificationData = null;
      return;
    }

    _verificationData = data.verification;
    const v = data.verification;

    // Auto-populate company name if empty
    const nameField = document.getElementById('deal-company-name');
    if (nameField && !nameField.value.trim()) {
      nameField.value = v.company_name;
    }

    // Simple broker badge — just verified status + company name confirmation
    if (v.company_status === 'active') {
      badge.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.3);border-radius:8px;">
          <span style="color:#34D399;font-size:16px;">&#10003;</span>
          <div>
            <span style="font-size:12px;color:#34D399;font-weight:700;">Verified</span>
            <span style="font-size:12px;color:#94A3B8;margin-left:6px;">${v.company_name} · Active · Est. ${v.date_of_creation || 'N/A'}</span>
          </div>
        </div>
      `;
    } else {
      // Company exists but is not active — warn the broker
      badge.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:8px;">
          <span style="color:#F87171;font-size:16px;">&#9888;</span>
          <div>
            <span style="font-size:12px;color:#F87171;font-weight:700;">${v.company_name}</span>
            <span style="font-size:12px;color:#F87171;margin-left:6px;">· Status: ${(v.company_status || 'unknown').toUpperCase()}</span>
            <div style="font-size:11px;color:#94A3B8;margin-top:2px;">This company is not active. Please check the company number.</div>
          </div>
        </div>
      `;
    }

  } catch (err) {
    console.error('[companies-house] Verify failed:', err);
    badge.innerHTML = `
      <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:8px;">
        <span style="color:#F87171;font-size:14px;">&#9888;</span>
        <span style="font-size:12px;color:#F87171;font-weight:600;">Could not verify — please try again</span>
      </div>
    `;
  }
}

// ─── Full verification panel for internal team (called from deal-detail.js) ──
export async function renderFullVerification(companyNumber, containerEl) {
  if (!containerEl) return;

  containerEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:12px;">
      <div style="width:16px;height:16px;border:2px solid rgba(212,168,83,0.3);border-top-color:#D4A853;border-radius:50%;animation:spin .6s linear infinite;"></div>
      <span style="font-size:13px;color:#D4A853;font-weight:600;">Running full Companies House verification...</span>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/companies-house/verify/${companyNumber}`);
    const data = await resp.json();

    if (!resp.ok || !data.verification?.found) {
      containerEl.innerHTML = `
        <div style="padding:12px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:10px;">
          <span style="color:#F87171;font-weight:600;">&#10007; Company ${companyNumber} not found at Companies House</span>
        </div>
      `;
      return;
    }

    containerEl.innerHTML = buildFullPanel(data.verification);

  } catch (err) {
    containerEl.innerHTML = `
      <div style="padding:12px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:10px;">
        <span style="color:#F87171;font-weight:600;">&#9888; Verification failed — ${err.message}</span>
      </div>
    `;
  }
}

// ─── Build the full internal panel ───────────────────────────────────────────
function buildFullPanel(v) {
  const riskColors = {
    low: { bg: 'rgba(52,211,153,0.1)', border: '#34D399', text: '#34D399', icon: '&#10003;' },
    medium: { bg: 'rgba(251,191,36,0.1)', border: '#FBBF24', text: '#FBBF24', icon: '&#9888;' },
    high: { bg: 'rgba(248,113,113,0.1)', border: '#F87171', text: '#F87171', icon: '&#9888;' },
    critical: { bg: 'rgba(239,68,68,0.15)', border: '#EF4444', text: '#EF4444', icon: '&#10007;' }
  };
  const rc = riskColors[v.risk_score] || riskColors.medium;

  // Address
  const addr = v.registered_address;
  const addrStr = addr ? [addr.line_1, addr.line_2, addr.locality, addr.region, addr.postal_code].filter(Boolean).join(', ') : 'Not available';

  // Directors
  const directors = v.officers?.filter(o => o.officer_role === 'director') || [];
  const directorsHtml = directors.length > 0
    ? directors.map(d => `
        <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="font-size:12px;font-weight:600;color:#E2E8F0;">${d.name}</span>
          <span style="font-size:11px;color:#94A3B8;">${d.nationality || ''} · Since ${d.appointed_on || 'N/A'}</span>
        </div>`).join('')
    : '<span style="font-size:12px;color:#94A3B8;">No active directors</span>';

  // PSCs
  const pscsHtml = v.pscs?.length > 0
    ? v.pscs.map(p => `
        <div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="font-size:12px;font-weight:600;color:#E2E8F0;">${p.name}</span>
          <div style="font-size:10px;color:#64748B;">${(p.natures_of_control || []).map(n => n.replace(/-/g, ' ')).join(', ')}</div>
        </div>`).join('')
    : '<span style="font-size:12px;color:#94A3B8;">No PSCs found</span>';

  // Charges
  const chargesHtml = v.charges_outstanding?.length > 0
    ? v.charges_outstanding.map(c => `
        <div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="font-size:12px;color:#E2E8F0;">${(c.persons_entitled || []).map(p => p.name).join(', ') || 'Unknown'}</span>
          <div style="font-size:10px;color:#64748B;">Created: ${c.created_on || 'N/A'} · ${c.particulars?.contains_fixed_charge ? 'Fixed' : ''}${c.particulars?.contains_floating_charge ? ' + Floating' : ''}</div>
        </div>`).join('')
    : '<span style="font-size:12px;color:#94A3B8;">No outstanding charges</span>';

  // Risk flags
  const flagsHtml = v.risk_flags?.length > 0
    ? v.risk_flags.map(f => {
        const fc = riskColors[f.severity] || riskColors.medium;
        return `<div style="display:flex;gap:6px;padding:5px 0;">
          <span style="color:${fc.text};font-size:12px;">${fc.icon}</span>
          <div><div style="font-size:12px;font-weight:600;color:${fc.text};">${f.flag}</div>
          <div style="font-size:11px;color:#94A3B8;">${f.detail}</div></div>
        </div>`;
      }).join('')
    : '<span style="font-size:12px;color:#34D399;">&#10003; No risk flags</span>';

  // Compact accounts summary
  const acctStatus = v.accounts?.overdue ? '<span style="color:#F87171;">Accts OVERDUE</span>' : `Accts: ${v.accounts?.last_made_up_to || 'Not filed'}`;
  const csStatus = v.confirmation_statement?.overdue ? '<span style="color:#F87171;">CS OVERDUE</span>' : `CS: ${v.confirmation_statement?.last_made_up_to || 'Not filed'}`;

  // Accounts & CS detail
  const acctDate = v.accounts?.last_made_up_to || 'Not filed';
  const acctNext = v.accounts?.next_due ? `Next due: ${v.accounts.next_due}` : '';
  const acctOverdue = v.accounts?.overdue;
  const csDate = v.confirmation_statement?.last_made_up_to || 'Not filed';
  const csNext = v.confirmation_statement?.next_due ? `Next due: ${v.confirmation_statement.next_due}` : '';
  const csOverdue = v.confirmation_statement?.overdue;

  return `
    <div style="display:grid;grid-template-columns:1fr 280px;gap:8px;">
      <!-- LEFT: Company info + expandable sections -->
      <div style="background:${rc.bg};border:1px solid ${rc.border};border-radius:8px;overflow:hidden;">
        <!-- Header -->
        <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:15px;">${rc.icon}</span>
            <div>
              <span style="font-size:13px;font-weight:700;color:#F1F5F9;">${v.company_name}</span>
              <div style="font-size:10px;color:#94A3B8;">${v.company_number} · ${v.company_type || 'ltd'} · Est. ${v.date_of_creation || ''}${v.age_months != null ? ` (${v.age_months} months)` : ''}</div>
            </div>
          </div>
          <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${rc.text};border:1px solid ${rc.border};padding:2px 8px;border-radius:10px;white-space:nowrap;">${v.risk_score} risk</span>
        </div>

        <!-- Stats row -->
        <div style="padding:6px 14px;display:flex;flex-wrap:wrap;gap:12px;border-top:1px solid rgba(255,255,255,0.04);font-size:11px;">
          <span style="color:${v.company_status === 'active' ? '#34D399' : '#F87171'};font-weight:700;">${(v.company_status || '').toUpperCase()}</span>
          <span style="color:#94A3B8;">Dir: <strong style="color:#E2E8F0;">${v.director_count}</strong></span>
          <span style="color:#94A3B8;">PSC: <strong style="color:#E2E8F0;">${v.psc_count}</strong></span>
          <span style="color:#94A3B8;">Charges: <strong style="color:${v.charges_outstanding?.length > 0 ? '#FBBF24' : '#34D399'};">${v.charges_outstanding?.length || 0} outstanding</strong></span>
        </div>

        <!-- Address -->
        <div style="padding:4px 14px 6px;font-size:10px;color:#64748B;border-top:1px solid rgba(255,255,255,0.04);">
          <span style="text-transform:uppercase;font-weight:600;letter-spacing:.3px;">Registered Address:</span> <span style="color:#CBD5E1;">${addrStr}</span>
        </div>

        <!-- SIC Codes — what the company is registered to do (UK ONS SIC 2007) -->
        ${(v.sic_codes && v.sic_codes.length > 0) ? `
        <div style="padding:6px 14px 8px;font-size:10px;border-top:1px solid rgba(255,255,255,0.04);background:rgba(212,168,83,0.04);">
          <span style="text-transform:uppercase;font-weight:600;letter-spacing:.3px;color:#D4A853;">SIC Codes — Permitted Activities</span>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:3px;">
            ${v.sic_codes.map(code => {
              const desc = _sicDescription(code);
              return `<div style="display:flex;gap:8px;align-items:flex-start;font-size:11px;">
                <span style="color:#D4A853;font-weight:700;font-family:monospace;min-width:50px;">${code}</span>
                <span style="color:${desc ? '#CBD5E1' : '#64748B'};${desc ? '' : 'font-style:italic;'}">${desc || 'Unknown SIC code (not in our reference list)'}</span>
              </div>`;
            }).join('')}
          </div>
        </div>
        ` : ''}

        <!-- Expandable sections — scope-aware (this) so multiple panels on one page don't collide -->
        <div style="border-top:1px solid rgba(255,255,255,0.04);">
          <div onclick="window._toggleChSection('risks', this)" style="padding:6px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.03);">
            <span style="font-size:11px;font-weight:600;color:#E2E8F0;">Risk Flags (${v.risk_flags?.length || 0})</span>
            <span class="ch-arrow-risks" style="color:#64748B;font-size:9px;transition:transform .2s;">&#9660;</span>
          </div>
          <div class="ch-body-risks" style="display:none;padding:4px 14px 8px;">${flagsHtml}</div>

          <div onclick="window._toggleChSection('directors', this)" style="padding:6px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.03);">
            <span style="font-size:11px;font-weight:600;color:#E2E8F0;">Directors (${directors.length})</span>
            <span class="ch-arrow-directors" style="color:#64748B;font-size:9px;transition:transform .2s;">&#9660;</span>
          </div>
          <div class="ch-body-directors" style="display:none;padding:4px 14px 8px;">${directorsHtml}</div>

          <div onclick="window._toggleChSection('pscs', this)" style="padding:6px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.03);">
            <span style="font-size:11px;font-weight:600;color:#E2E8F0;">Persons with Significant Control (${v.psc_count})</span>
            <span class="ch-arrow-pscs" style="color:#64748B;font-size:9px;transition:transform .2s;">&#9660;</span>
          </div>
          <div class="ch-body-pscs" style="display:none;padding:4px 14px 8px;">${pscsHtml}</div>

          <div onclick="window._toggleChSection('charges', this)" style="padding:6px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;font-weight:600;color:#E2E8F0;">Outstanding Charges (${v.charges_outstanding?.length || 0})</span>
            <span class="ch-arrow-charges" style="color:#64748B;font-size:9px;transition:transform .2s;">&#9660;</span>
          </div>
          <div class="ch-body-charges" style="display:none;padding:4px 14px 8px;">${chargesHtml}</div>
        </div>
      </div>

      <!-- RIGHT: Accounts, CS, and source info -->
      <div style="display:flex;flex-direction:column;gap:8px;">
        <!-- Last Accounts -->
        <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;">
          <div style="font-size:10px;color:#64748B;text-transform:uppercase;font-weight:600;letter-spacing:.3px;margin-bottom:4px;">Last Accounts</div>
          <div style="font-size:14px;font-weight:700;color:${acctOverdue ? '#F87171' : '#F1F5F9'};">${acctOverdue ? 'OVERDUE' : acctDate}</div>
          ${acctNext ? `<div style="font-size:10px;color:#94A3B8;margin-top:2px;">${acctNext}</div>` : ''}
        </div>

        <!-- Confirmation Statement -->
        <div style="background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 14px;">
          <div style="font-size:10px;color:#64748B;text-transform:uppercase;font-weight:600;letter-spacing:.3px;margin-bottom:4px;">Confirmation Statement</div>
          <div style="font-size:14px;font-weight:700;color:${csOverdue ? '#F87171' : '#F1F5F9'};">${csDate}</div>
          ${csNext ? `<div style="font-size:10px;color:#94A3B8;margin-top:2px;">${csNext}</div>` : ''}
        </div>

        <!-- Source -->
        <div style="text-align:right;padding:4px 0;">
          <span style="font-size:9px;color:#64748B;">Source: Companies House API · ${v.api_time_ms}ms</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Toggle expandable sections (scoped to the clicked panel) ────────────────
// Multiple panels (primary borrower + each corporate guarantor) can exist on one page,
// so we can't use getElementById — we walk from the clicked header to its sibling body.
window._toggleChSection = function(section, clickedEl) {
  let body = null;
  let arrow = null;
  if (clickedEl && clickedEl.nextElementSibling) {
    // Adjacent to the clicked header
    body = clickedEl.nextElementSibling;
    arrow = clickedEl.querySelector('.ch-arrow-' + section);
  } else if (clickedEl && clickedEl.parentElement) {
    // Fallback: search within the nearest panel container
    body = clickedEl.parentElement.querySelector('.ch-body-' + section);
    arrow = clickedEl.parentElement.querySelector('.ch-arrow-' + section);
  }
  // Last-resort fallback for legacy callers still passing just the section name
  if (!body) body = document.querySelector('.ch-body-' + section) || document.getElementById('ch-body-' + section);
  if (!arrow) arrow = document.querySelector('.ch-arrow-' + section) || document.getElementById('ch-arrow-' + section);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (arrow) arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
};

// ─── Export verification data for deal submission ────────────────────────────
export function getVerificationData() {
  return _verificationData;
}
