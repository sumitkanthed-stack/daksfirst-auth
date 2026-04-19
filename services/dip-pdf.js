/**
 * DIP PDF Generator — Daksfirst
 *
 * v4 — Puppeteer-based HTML-to-PDF.
 * Renders the same HTML/CSS the portal uses, so the PDF is pixel-perfect.
 * No more manual X/Y positioning — the browser does all the layout.
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// ── Keep a browser instance alive to avoid cold-start on every PDF ──
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
  return _browser;
}

// ── Embedded white DF hexagon logo (PNG, base64) ──
const LOGO_B64 = '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';

// ── Helpers ──

function money(val) {
  if (val === null || val === undefined || val === '') return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return '\u2014';
  return '\u00A3' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  if (val === null || val === undefined || val === '') return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '\u2014';
  return num.toFixed(2) + '%';
}

function clean(val) {
  if (val === null || val === undefined || val === '') return '\u2014';
  return String(val).trim() || '\u2014';
}

function humanize(val) {
  if (!val) return '\u2014';
  return String(val).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dealRefFromId(submissionId, createdAt) {
  if (!submissionId || !createdAt) return 'DF-XXXX-XXXX';
  const date = new Date(createdAt);
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const xxxx = String(submissionId).substring(0, 4).toUpperCase();
  return `DF-${yy}${mm}-${xxxx}`;
}

function feeLine(raw, loanAmt) {
  const v = parseFloat(raw || 0);
  if (isNaN(v) || v === 0) return '\u2014';
  if (v > 0 && v < 50) return money(Math.round(loanAmt * v / 100)) + ' (' + v.toFixed(2) + '%)';
  return money(v);
}


// ═══════════════════════════════════════════════════════════════════
// G5 — Option B party rendering helpers (2026-04-20)
// Used by both the DIP PDF (here) and the Termsheet PDF (G5.4).
// Colours mirror the matrix UI per G5 Q4 answer.
// ═══════════════════════════════════════════════════════════════════

function _g5RolePill(label, bgColor, fgColor) {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:3px;background:${bgColor};color:${fgColor};font-size:9.5px;font-weight:700;letter-spacing:0.3px;">${esc(label)}</span>`;
}

function _g5FormatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

function _g5KycBadge(status) {
  const s = (status || '').toLowerCase();
  if (s === 'verified')  return `<span style="color:#166534;font-weight:600;">\u2713 Verified (KYC pack)</span>`;
  if (s === 'submitted') return `<span style="color:#92400e;">\u23F3 Under review</span>`;
  if (s === 'rejected')  return `<span style="color:#991b1b;">\u2717 Rejected</span>`;
  return `<span style="color:#6b7280;">\u2014 KYC pending</span>`;
}

function _g5ChVerifiedCell(ch_verified_at) {
  if (!ch_verified_at) return `<span style="color:#6b7280;">\u2014</span>`;
  return `<span style="color:#166534;font-weight:600;">\u2713 ${_g5FormatDate(ch_verified_at)}</span>`;
}

// Render the "Parties to the Facility" corporate-party table
function _g5RenderCorporatePartiesTable(corporateParties) {
  if (!corporateParties || corporateParties.length === 0) return '';
  const rows = corporateParties.map(p => {
    const pill = _g5RolePill(p.label, p.bgColor, p.fgColor);
    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:7px 10px;font-size:11px;">${pill}</td>
      <td style="padding:7px 10px;font-size:11.5px;">${esc(p.full_name || '\u2014')}</td>
      <td style="padding:7px 10px;font-size:11px;">${esc(p.company_number || '\u2014')}</td>
      <td style="padding:7px 10px;font-size:11px;">${_g5ChVerifiedCell(p.ch_verified_at)}</td>
    </tr>`;
  }).join('');

  return `<table style="width:100%;border-collapse:collapse;margin:4px 0 10px;font-family:Arial,Helvetica,sans-serif;">
    <thead>
      <tr style="background:#f1f5f9;">
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Role</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Name</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Company No</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">CH Verified</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Render the Individual Guarantors sub-block (separate table per G5 Q2)
function _g5RenderIndividualGuarantorsBlock(individualGuarantors) {
  if (!individualGuarantors || individualGuarantors.length === 0) return '';
  const rows = individualGuarantors.map(g => `<tr style="border-bottom:1px solid #f1f5f9;">
    <td style="padding:7px 10px;font-size:11.5px;font-weight:600;">${esc(g.full_name || '\u2014')}</td>
    <td style="padding:7px 10px;font-size:11px;">${esc(g.nationality || '\u2014')}</td>
    <td style="padding:7px 10px;font-size:11px;">${_g5KycBadge(g.kyc_status)}</td>
    <td style="padding:7px 10px;font-size:11px;">${esc(g.address || '\u2014')}</td>
  </tr>`).join('');

  return `<h5 style="margin:14px 0 6px;color:#1e3a5f;font-size:11.5px;text-transform:uppercase;letter-spacing:0.5px;">Individual Guarantors</h5>
  <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#555;font-style:italic;">Natural persons providing a personal guarantee in their own capacity. Full KYC details held in the internal file.</p>
  <table style="width:100%;border-collapse:collapse;margin:4px 0 10px;font-family:Arial,Helvetica,sans-serif;">
    <thead>
      <tr style="background:#f1f5f9;">
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Name</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Citizenship</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">ID Verified</th>
        <th style="text-align:left;padding:6px 10px;font-size:9.5px;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Address for Service of Notice</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Top-level: decide between Option B layout (new) vs legacy rendering (backward compat)
function _g5RenderPartiesSection(dipData) {
  const g = dipData && dipData.parties_grouped;
  if (!g) return null;  // caller falls back to legacy rendering

  // Build corporate parties list with colour-coded role labels per G5 Q4 answer
  const corporate = [
    ...g.primary.map(p => ({ ...p, label: 'Primary Borrower',      bgColor: '#fef3c7', fgColor: '#92400e' })),
    ...g.joint.map(p =>   ({ ...p, label: 'Joint Co-Borrower',     bgColor: '#d1fae5', fgColor: '#065f46' })),
    ...g.corporate_guarantors.map(p => ({ ...p, label: 'Corporate Guarantor', bgColor: '#e9d8fd', fgColor: '#553c9a' }))
  ];

  const individuals = g.individual_guarantors || [];
  const anyParties = corporate.length > 0 || individuals.length > 0;
  if (!anyParties) return null;

  return `<div style="margin-top:8px;padding-top:10px;border-top:1px solid #e5e7eb;">
    <h5 style="margin:0 0 4px;color:#374151;font-size:11.5px;text-transform:uppercase;letter-spacing:0.5px;">Parties to the Facility</h5>
    <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#555;font-style:italic;">Legal parties bound by this indicative facility as at the date of issue.</p>
    ${_g5RenderCorporatePartiesTable(corporate)}
    ${_g5RenderIndividualGuarantorsBlock(individuals)}
  </div>`;
}


// ═══════════════════════════════════════════════════════════════════
// BUILD HTML
// ═══════════════════════════════════════════════════════════════════

function buildDipHtml(deal, dipData, options) {
  const dealRef = dealRefFromId(deal.submission_id, deal.created_at);
  const bType = (deal.borrower_type || 'individual').toLowerCase();
  const isCorp = ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes(bType);
  const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);
  // Fee resolution order (single-source-of-truth pass 2026-04-20):
  // 1. dipData.*_pct — explicit override from the DIP issue form
  // 2. deal.*_pct — native columns on deal_submissions, written by matrix inline edit
  // 3. dipData.arrangement_fee / broker_fee / deal.arrangement_fee — legacy JSONB / legacy columns
  // 4. default (2% arrangement, 0% broker)
  const arrFee = parseFloat(dipData.arrangement_fee_pct || deal.arrangement_fee_pct || dipData.arrangement_fee || deal.arrangement_fee || 2);
  const brkFee = parseFloat(dipData.broker_fee_pct || deal.broker_fee_pct || dipData.broker_fee || 0);
  const totalPropertyVal = parseFloat(dipData.property_value || deal.property_value || deal.estimated_value || 0);

  const issueDate = options.issuedAt
    ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Build property rows — deal_properties table is the single source of truth (Claude-parsed)
  const dbProperties = dipData.properties || [];

  let propRowsHtml = '';
  let totalVal = 0;
  const propCount = dbProperties.length || 1;

  if (dbProperties.length > 0) {
    // Claude has parsed — use deal_properties directly
    dbProperties.forEach((prop, idx) => {
      const val = parseFloat(prop.market_value || 0);
      totalVal += val;
      propRowsHtml += `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:6px 8px;font-weight:600;">${idx + 1}</td>
        <td style="padding:6px 8px;">${esc((prop.address || '').trim())}</td>
        <td style="padding:6px 8px;">${esc((prop.postcode || '\u2014').trim())}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600;">${money(val)}</td>
      </tr>`;
    });
  } else {
    // Not yet parsed — show raw data as single row (no regex, no guessing)
    totalVal = totalPropertyVal;
    propRowsHtml = `<tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:6px 8px;font-weight:600;">1</td>
      <td style="padding:6px 8px;">${esc(deal.security_address || 'TBC')}</td>
      <td style="padding:6px 8px;">${esc(fullPostcode)}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;">${money(totalPropertyVal)}</td>
    </tr>`;
  }
  if (!totalVal) totalVal = totalPropertyVal;

  // Borrower type badge
  const borrowerTypeBadge = isCorp
    ? `<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:#dbeafe;color:#1e3a5f;">${esc(bType.toUpperCase())}</span>`
    : `<span style="padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;background:#dcfce7;color:#166534;">INDIVIDUAL</span>`;

  // Parties table — G5 Option B (parties_grouped) with legacy fallback
  let partiesHtml = _g5RenderPartiesSection(dipData);
  if (partiesHtml === null && dipData.borrowers && dipData.borrowers.length > 0) {
    // Legacy fallback rendering — used only if parties_grouped is missing (shouldn't happen post-G5.1)
    partiesHtml = `
    <div style="margin-top:8px;padding-top:10px;border-top:1px solid #e5e7eb;">
      <h5 style="margin:0 0 8px;color:#374151;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Parties to the DIP (${dipData.borrowers.length})</h5>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr style="background:#f3f4f6;">
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;">Name</th>
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;">Role</th>
          <th style="text-align:center;padding:5px 8px;border-bottom:1px solid #e5e7eb;">KYC Status</th>
        </tr>
        ${dipData.borrowers.map(b => {
          const roleBg = (b.role || '').toLowerCase() === 'primary' ? '#bee3f8' : (b.role || '').toLowerCase() === 'guarantor' ? '#fef3c7' : '#e5e7eb';
          const roleColor = (b.role || '').toLowerCase() === 'primary' ? '#2a4365' : (b.role || '').toLowerCase() === 'guarantor' ? '#744210' : '#374151';
          const kycOk = b.kyc_verified || b.kyc_status === 'verified';
          return `<tr style="border-bottom:1px solid #f0f0f0;">
            <td style="padding:5px 8px;font-weight:600;">${esc(b.name || b.full_name || '')}</td>
            <td style="padding:5px 8px;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;background:${roleBg};color:${roleColor};">${esc(b.role || 'primary')}</span></td>
            <td style="padding:5px 8px;text-align:center;"><span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${kycOk ? '#dcfce7;color:#166534' : '#fef3c7;color:#92400e'};">${kycOk ? 'Verified' : 'KYC Pending'}</span></td>
          </tr>`;
        }).join('')}
      </table>
    </div>`;
  }
  if (partiesHtml === null) partiesHtml = '';

  // Security items — issueDip saves fixed_charge / pg_from_ubo
  const securityCharge = esc(humanize(dipData.fixed_charge || dipData.security_charge || 'first_and_debenture'));
  const pgRaw = dipData.pg_from_ubo || (isCorp ? 'required' : null);
  const personalGuarantee = pgRaw === 'required' ? 'Required from UBO' : pgRaw === 'limited' ? 'Limited Guarantee' : pgRaw === 'waived' ? 'Waived' : (isCorp ? 'Required from UBO' : 'N/A');
  const debenture = isCorp ? 'Required (corporate borrower)' : 'N/A';

  // Conditions precedent
  const cpItems = [
    'Satisfactory independent valuation',
    'Clear title search \u2014 no encumbrances',
    'Legal due diligence by Lender\u2019s solicitors',
    'First legal charge in favour of Lender',
    'Buildings insurance \u2014 Lender\u2019s interest noted'
  ];
  if (isCorp) {
    cpItems.push('Personal guarantee from UBO');
    cpItems.push('Debenture over corporate assets');
  }
  cpItems.push('KYC/AML documentation for all parties');
  cpItems.push('Evidence of source of deposit & funds');
  cpItems.push('Payment of all applicable fees');

  const cpHtml = cpItems.map((c, i) => `<div style="padding:2px 0;border-bottom:1px solid #f3f4f6;display:flex;gap:4px;font-size:11px;">
    <span style="color:#1e3a5f;font-weight:600;min-width:16px;">${i + 1}.</span>
    <span>${esc(c)}</span>
  </div>`).join('');

  // Fee rows
  const feeRows = [
    { name: 'Onboarding / DIP Fee', amount: money(dipData.fee_onboarding || 0), when: 'After DIP acceptance', trigger: 'Before Credit Review' },
    { name: 'Commitment Fee', amount: money(dipData.fee_commitment || 0), when: 'After Termsheet acceptance', trigger: 'Before Underwriting' },
    { name: 'Arrangement Fee', amount: feeLine(arrFee, loanAmt), when: 'On completion', trigger: 'Deducted from advance', highlight: true },
    { name: '\u21B3 of which Broker Fee', amount: feeLine(brkFee, loanAmt), when: 'On completion', trigger: 'From arrangement fee', highlight: true, sub: true },
    { name: 'Exit Fee', amount: '1.00% of loan', when: 'On redemption', trigger: 'Payable on exit' },
    { name: 'Extension Fee', amount: '1.00% of loan', when: 'If term extended', trigger: 'Per extension period agreed' }
  ];

  const feeRowsHtml = feeRows.map(f => `<tr style="border-bottom:1px solid #f3f4f6;${f.highlight ? 'background:#fefce8;' : ''}">
    <td style="padding:5px 6px;${f.sub ? 'padding-left:20px;color:#92400e;' : 'font-weight:600;'}">${esc(f.name)}</td>
    <td style="padding:5px 6px;text-align:right;font-weight:600;${f.sub ? 'color:#92400e;' : ''}">${f.amount}</td>
    <td style="padding:5px 6px;font-size:10px;color:#60A5FA;">${esc(f.when)}</td>
    <td style="padding:5px 6px;font-size:10px;">${esc(f.trigger)}</td>
  </tr>`).join('');

  // DIP conditions / notes
  const dipNotes = dipData.conditions || dipData.notes || '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    size: A4;
    margin: 0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a2e;
    font-size: 13px;
    line-height: 1.4;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  .page-wrapper {
    width: 210mm;
    padding: 0;
  }

  /* ── HEADER BAR ── */
  .header-bar {
    background: #1F3864;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header-bar img { width: 38px; height: 38px; }
  .header-bar .title-area { flex: 1; }
  .header-bar h1 { color: #fff; font-size: 18px; margin: 0; letter-spacing: 1px; }
  .header-bar .tagline { color: #C9A227; font-size: 8px; font-style: italic; margin-top: 2px; }
  .header-bar .info-right { text-align: right; font-size: 7.5px; }
  .header-bar .info-right .addr { color: #fff; }
  .header-bar .info-right .fca { color: #C9A227; margin-top: 2px; }

  .gold-bar { height: 2px; background: #C9A227; }

  /* ── DIP BODY ── */
  .dip-body {
    background: #f0f5ff;
    padding: 14px 24px;
  }

  .dip-title {
    text-align: center;
    margin-bottom: 4px;
    padding-bottom: 8px;
    border-bottom: 2px solid #2563eb;
  }
  .dip-title h2 { font-size: 16px; color: #1e3a5f; margin: 0 0 1px; }
  .dip-title .subtitle { font-size: 9px; color: #4b5563; }

  /* Reference strip */
  .ref-strip {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    font-size: 11px;
  }
  .ref-strip .deal-ref {
    font-weight: 700;
    font-size: 12px;
    color: #1e3a5f;
    padding: 3px 10px;
    border: 2px solid #1e3a5f;
    border-radius: 4px;
  }
  .ref-strip .date { color: #6b7280; }

  .intro-text { margin: 0 0 10px; font-size: 11px; color: #4b5563; }

  /* ── SECTION BLOCKS ── */
  .section {
    background: #f9fafb;
    padding: 10px;
    border-radius: 5px;
    margin-bottom: 10px;
    border: 1px solid #e5e7eb;
  }
  .section.blue {
    background: #f0f5ff;
    border: 2px solid #2563eb;
  }
  .section.purple {
    background: #faf5ff;
    border: 2px solid #7c3aed;
  }
  .section.amber {
    background: #fffbeb;
    border: 1px solid #f59e0b;
  }
  .section.green-border {
    background: #f0fdf4;
    border: 2px solid #16a34a;
  }

  /* ── Section heading bar (full-width coloured strip) ── */
  .section-bar {
    background: #1F3864;
    color: #fff;
    padding: 5px 12px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-radius: 4px 4px 0 0;
    margin-bottom: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .section-bar.purple { background: #7c3aed; }
  .section-bar.green { background: #16a34a; }
  .section-bar.grey { background: #6b7280; }
  .section-bar.amber { background: #92400e; }
  .section-bar + .section { border-top-left-radius: 0; border-top-right-radius: 0; margin-top: 0; }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 7px;
  }
  .section-header h5 {
    margin: 0;
    color: #374151;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .section-header.navy h5 { color: #1e3a5f; }
  .section-header.purple h5 { color: #7c3aed; }
  .section-header.amber h5 { color: #92400e; }
  .section-header.grey h5 { color: #6b7280; }

  /* ── GRID ── */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 8px;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 8px;
  }

  .field-box {
    padding: 7px 8px;
    border-radius: 5px;
    background: #fff;
    border: 1px solid #e5e7eb;
  }
  .field-box.blue { background: #eff6ff; border-color: #bfdbfe; }
  .field-box.amber { background: #fef3c7; border-color: #fbbf24; }
  .field-box.green { background: #f0fff4; border-color: #86efac; }

  .field-label {
    font-size: 9px;
    color: #6b7280;
    display: block;
    font-weight: 600;
    margin-bottom: 1px;
  }
  .field-label.blue { color: #1e40af; }
  .field-label.amber { color: #92400e; }
  .field-label.navy { color: #374151; font-weight: 600; }
  .field-label.green { color: #15803d; }

  .field-value {
    font-size: 13px;
    font-weight: 700;
    color: #1a1a2e;
  }
  .field-value.navy { color: #1e3a5f; }
  .field-sub { font-size: 10px; color: #6b7280; margin-top: 1px; }

  /* ── TABLES ── */
  table.dip-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  table.dip-table thead tr { background: #f3f4f6; }
  table.dip-table th {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid #e5e7eb;
    font-weight: 600;
    font-size: 10px;
    color: #6b7280;
  }
  table.dip-table td {
    padding: 4px 6px;
    border-bottom: 1px solid #f3f4f6;
  }

  /* ── BADGES ── */
  .badge {
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 9px;
    font-weight: 600;
    display: inline-block;
  }

  /* ── BOTTOM BLOCK ── */
  .red-notice {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    padding: 8px 12px;
    border-radius: 5px;
    margin-bottom: 8px;
    text-align: center;
  }
  .red-notice p {
    font-size: 9px;
    color: #991b1b;
    font-weight: 600;
    margin: 0;
    line-height: 1.4;
  }

  .sig-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-top: 10px;
  }
  .sig-block {
    border-top: 1px solid #6b7280;
    padding-top: 4px;
  }
  .sig-block .label { font-size: 9px; font-weight: 700; color: #1e3a5f; }
  .sig-block .name { font-size: 10px; color: #374151; margin-top: 1px; }

  /* ── FOOTER ── */
  .footer-bar {
    border-top: 2px solid #C9A227;
    padding: 6px 24px;
    text-align: center;
    font-size: 7px;
    color: #6b7280;
    line-height: 1.5;
    margin-top: 8px;
  }

  .disclaimer {
    margin-top: 10px;
    padding: 8px 10px;
    background: #f9fafb;
    border-radius: 5px;
    border: 1px solid #e5e7eb;
  }
  .disclaimer p {
    margin: 0;
    font-size: 9px;
    color: #6b7280;
    line-height: 1.4;
  }

  /* ── PAGE BREAK CONTROL ── */
  .section-bar { break-after: avoid; }
  .section-bar + .section { break-before: avoid; }

  /* Ensure colour-printing on all browsers */
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
</style>
</head>
<body>
<div class="page-wrapper">

  <!-- ═══ HEADER ═══ -->
  <div class="header-bar">
    <img src="data:image/png;base64,${LOGO_B64}" alt="DF">
    <div class="title-area">
      <h1>DAKSFIRST</h1>
      <div class="tagline">Bridging Finance, Built for Professionals</div>
    </div>
    <div class="info-right">
      <div class="addr">8 Hill Street, Mayfair, London W1J 5NG</div>
      <div class="fca">FCA 937220 &nbsp;|&nbsp; portal@daksfirst.com</div>
    </div>
  </div>
  <div class="gold-bar"></div>

  <!-- ═══ BODY ═══ -->
  <div class="dip-body">

    <div class="dip-title">
      <h2>Decision In Principle (DIP)</h2>
      <div class="subtitle">Daksfirst Limited &mdash; FCA 937220 &mdash; 8 Hill Street, Mayfair, London W1J 5NG <span style="color:#C9A227;font-size:7px;">[v4.2]</span></div>
    </div>

    <div class="ref-strip">
      <span class="deal-ref">${esc(dealRef)}</span>
      <span class="date">Issued: ${esc(issueDate)}</span>
      ${borrowerTypeBadge}
    </div>

    <p class="intro-text">This Decision in Principle sets out the indicative terms under which Daksfirst Limited may provide senior secured finance. All terms are subject to full underwriting, valuation, and credit approval.</p>

    <!-- ═══ BORROWER DETAILS ═══ -->
    <div class="section-bar"><span>Borrower Details</span>${borrowerTypeBadge}</div>
    <div class="section">

      ${isCorp ? `
      <div class="grid-2">
        <div class="field-box blue">
          <span class="field-label blue">Corporate Entity</span>
          <div class="field-value">${esc(clean(deal.borrower_company || deal.company_name))}</div>
          ${deal.company_number ? `<div class="field-sub">Co. No: ${esc(deal.company_number)}</div>` : ''}
        </div>
        <div class="field-box amber">
          <span class="field-label amber">Ultimate Beneficial Owner (UBO)</span>
          <div class="field-value">${esc(clean(deal.borrower_name))}</div>
          <div class="field-sub">${esc(clean(deal.borrower_email))} ${deal.borrower_phone ? '&middot; ' + esc(deal.borrower_phone) : ''}</div>
        </div>
      </div>
      ` : `
      <div class="grid-3">
        <div class="field-box">
          <span class="field-label">Name</span>
          <div class="field-value">${esc(clean(deal.borrower_name))}</div>
        </div>
        <div class="field-box">
          <span class="field-label">Email</span>
          <div class="field-value" style="font-size:12px;">${esc(clean(deal.borrower_email))}</div>
        </div>
        <div class="field-box">
          <span class="field-label">Phone</span>
          <div class="field-value">${esc(clean(deal.borrower_phone))}</div>
        </div>
      </div>
      `}

      ${partiesHtml}

      <!-- Security & Guarantee Structure -->
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb;">
        <h5 style="margin:0 0 8px;color:#1e3a5f;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Security &amp; Guarantee Structure</h5>
        <div class="grid-3">
          <div class="field-box">
            <span class="field-label navy">Security Charge</span>
            <div class="field-value" style="font-size:13px;">${securityCharge}</div>
          </div>
          <div class="field-box">
            <span class="field-label navy">Personal Guarantee</span>
            <div class="field-value" style="font-size:13px;">${esc(personalGuarantee)}</div>
          </div>
          <div class="field-box">
            <span class="field-label navy">Additional Security</span>
            <div class="field-value" style="font-size:13px;">${esc(clean(dipData.additional_security || '\u2014'))}</div>
          </div>
        </div>
        ${isCorp ? `<div class="field-box" style="margin-top:8px;">
          <span class="field-label navy">UBO / Guarantor Name(s)</span>
          <div class="field-value" style="font-size:13px;">${esc(clean(dipData.ubo_guarantor_names || deal.borrower_name))}</div>
        </div>` : ''}
      </div>
    </div>

    <!-- ═══ SECURITY SCHEDULE ═══ -->
    <div class="section-bar">Security Schedule &mdash; ${propCount} ${propCount === 1 ? 'Property' : 'Properties'}</div>
    <div class="section">
      <table class="dip-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Address</th>
            <th>Postcode</th>
            <th style="text-align:right;">Valuation (&pound;)</th>
          </tr>
        </thead>
        <tbody>
          ${propRowsHtml}
        </tbody>
        <tfoot>
          <tr style="background:#f0f5ff;font-weight:600;">
            <td colspan="3" style="padding:8px;text-align:right;font-size:12px;">Total Portfolio Valuation:</td>
            <td style="padding:8px;text-align:right;font-size:13px;color:#1e3a5f;font-weight:700;">${money(totalVal || totalPropertyVal)}</td>
          </tr>
        </tfoot>
      </table>
      <div style="margin-top:8px;font-size:12px;color:#6b7280;">Asset Type: <strong>${esc(humanize(deal.asset_type))}</strong> &nbsp;|&nbsp; Tenure: <strong>${esc(humanize(deal.property_tenure))}</strong></div>
    </div>

    <!-- ═══ VALUATION SUMMARY ═══ -->
    <div class="section-bar">Valuation Summary</div>
    <div class="section">
      <div class="grid-3">
        <div class="field-box green">
          <span class="field-label green">Total Property Value (&pound;)</span>
          <div class="field-value">${money(totalVal || totalPropertyVal)}</div>
        </div>
        <div class="field-box">
          <span class="field-label">Purchase Price (&pound;)</span>
          <div class="field-value">${money(dipData.purchase_price || deal.purchase_price)}</div>
        </div>
        <div class="field-box">
          <span class="field-label">Number of Properties</span>
          <div class="field-value">${propCount}</div>
        </div>
      </div>
    </div>

    <!-- ═══ LOAN TERMS ═══ -->
    <div class="section-bar">Indicative Loan Terms</div>
    <div class="section blue">
      <div class="grid-3">
        <div class="field-box blue">
          <span class="field-label navy">Loan Amount (&pound;)</span>
          <div class="field-value navy">${money(dipData.loan_amount || deal.loan_amount)}</div>
        </div>
        <div class="field-box">
          <span class="field-label navy">Term (months)</span>
          <div class="field-value">${esc(clean(dipData.term_months || deal.term_months))}</div>
        </div>
        <div class="field-box">
          <span class="field-label navy">Rate (%/month)</span>
          <div class="field-value">${pct(dipData.rate_monthly || deal.rate_requested)}</div>
          <div class="field-sub" style="color:#92400e;">Min 0.85%</div>
        </div>
      </div>
      <div class="grid-3">
        <div class="field-box">
          <span class="field-label navy">Interest Servicing</span>
          <div class="field-value">${esc(humanize(dipData.interest_servicing || 'retained'))}</div>
        </div>
        <div class="field-box">
          <span class="field-label navy">Arrangement Fee (%)</span>
          <div class="field-value">${arrFee.toFixed(2)}%</div>
        </div>
        <div class="field-box green">
          <span class="field-label green">LTV (%)</span>
          <div class="field-value">${pct(dipData.ltv || deal.ltv_requested)}</div>
          <div class="field-sub" style="color:#15803d;">Auto-calculated &middot; Max 75%</div>
        </div>
      </div>

      <!-- Day Zero Calculation (inline sub-section, stays inside Loan Terms) -->
      <div style="margin-top:10px;padding:10px;background:#fffbeb;border:1px solid #f59e0b;border-radius:5px;">
        <h5 style="margin:0 0 8px;color:#92400e;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;">Day Zero Calculation</h5>
        <div class="grid-2">
          <div class="field-box">
            <span class="field-label amber">Retained Interest (months)</span>
            <div class="field-value">${esc(clean(dipData.retained_months || '6'))}</div>
          </div>
          <div class="field-box">
            <span class="field-label amber">Broker Fee (%)</span>
            <div class="field-value">${brkFee.toFixed(2)}%</div>
            <div class="field-sub" style="color:#b45309;font-weight:600;">Paid from Arrangement Fee (not additional)</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ FEE SCHEDULE ═══ -->
    <div class="section-bar purple">Fee Schedule</div>
    <div class="section purple">
      <p style="margin:0 0 12px;font-size:11px;color:#4b5563;">All fees disclosed to borrower. No fee required before DIP issuance.</p>
      <table class="dip-table">
        <thead>
          <tr style="background:#f5f3ff;">
            <th style="border-bottom:2px solid #7c3aed;">Fee Type</th>
            <th style="text-align:right;border-bottom:2px solid #7c3aed;">Amount (&pound;)</th>
            <th style="border-bottom:2px solid #7c3aed;">When Due</th>
            <th style="border-bottom:2px solid #7c3aed;">Payment Trigger</th>
          </tr>
        </thead>
        <tbody>
          ${feeRowsHtml}
        </tbody>
      </table>
    </div>

    <!-- ═══ THIRD-PARTY COSTS ═══ -->
    <div class="section-bar grey">Estimated Third-Party Costs</div>
    <div class="section">
      <p style="margin:0 0 12px;font-size:11px;color:#6b7280;font-style:italic;">These are not Daksfirst fees. Third-party costs borne directly by the borrower, disclosed for budgeting purposes only.</p>
      <table class="dip-table">
        <thead>
          <tr>
            <th>Cost</th>
            <th style="text-align:right;">Estimated (&pound;)</th>
            <th>Payable To</th>
            <th>Payment Method</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;font-weight:600;">Valuation</td>
            <td style="padding:8px;text-align:right;">${money(dipData.valuation_cost || 0)}</td>
            <td style="padding:8px;font-size:11px;">Independent valuer</td>
            <td style="padding:8px;font-size:11px;">Paid directly by client to valuer</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6;">
            <td style="padding:8px;font-weight:600;">Legal (Lender&rsquo;s solicitors)</td>
            <td style="padding:8px;text-align:right;">${money(dipData.legal_cost || 0)}</td>
            <td style="padding:8px;font-size:11px;">Daksfirst&rsquo;s appointed solicitors</td>
            <td style="padding:8px;font-size:11px;">Via undertaking from client&rsquo;s solicitors</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ═══ PURPOSE & EXIT ═══ -->
    <div class="grid-2" style="margin-bottom:16px;">
      <div class="field-box">
        <span class="field-label">Loan Purpose</span>
        <div style="font-size:13px;margin-top:4px;color:#374151;line-height:1.5;">${esc(clean(dipData.loan_purpose || deal.loan_purpose))}</div>
      </div>
      <div class="field-box">
        <span class="field-label">Exit Strategy</span>
        <div style="font-size:13px;margin-top:4px;color:#374151;line-height:1.5;">${esc(clean(dipData.exit_strategy || deal.exit_strategy))}</div>
      </div>
    </div>

    ${dipNotes ? `
    <div class="field-box" style="margin-bottom:16px;">
      <span class="field-label navy">DIP Conditions / RM Notes</span>
      <div style="font-size:13px;margin-top:4px;color:#374151;line-height:1.5;">${esc(dipNotes)}</div>
    </div>
    ` : ''}

    <!-- ═══ SECURITY & GUARANTEES + CONDITIONS PRECEDENT (side by side) ═══ -->
    <div class="grid-2" style="margin-bottom:10px;">
      <div>
        <div class="section-bar">Security &amp; Guarantees</div>
        <div class="section" style="margin-bottom:0;border-top-left-radius:0;border-top-right-radius:0;">
        <div class="field-box" style="margin-bottom:8px;">
          <span class="field-label">First Legal Charge</span>
          <div style="font-size:12px;font-weight:600;">${propCount > 1 ? 'Over all ' + propCount + ' security properties' : 'Over the security property'}</div>
        </div>
        <div class="field-box" style="margin-bottom:8px;">
          <span class="field-label">Debenture</span>
          <div style="font-size:12px;font-weight:600;">${esc(debenture)}</div>
        </div>
        <div class="field-box">
          <span class="field-label">Personal Guarantee</span>
          <div style="font-size:12px;font-weight:600;">${esc(personalGuarantee)}</div>
        </div>
        </div>
      </div>
      <div>
        <div class="section-bar">Conditions Precedent</div>
        <div class="section" style="margin-bottom:0;border-top-left-radius:0;border-top-right-radius:0;">
        <div style="font-size:12px;">${cpHtml}</div>
        </div>
      </div>
    </div>

    <!-- ═══ BOTTOM BLOCK — stays together, never splits ═══ -->
    <div class="bottom-block">

      <!-- ═══ HOW TO PROCEED — PAYMENT DETAILS ═══ -->
      <div class="section-bar green">How to Proceed &mdash; Payment Details</div>
      <div class="section green-border" style="border-top-left-radius:0;border-top-right-radius:0;">
        <div class="grid-2">
          <div class="field-box">
            <p style="font-size:12px;color:#374151;margin:0;line-height:1.6;">To proceed, remit the Onboarding/DIP Fee below. Quote the deal reference <strong>${esc(dealRef)}</strong> as payment reference.</p>
            <p style="font-size:11px;color:#6b7280;margin-top:6px;font-style:italic;">Upon receipt, Daksfirst will commence credit review.</p>
          </div>
          <div style="background:#f8fafc;padding:10px;border-radius:6px;border:1px solid #e5e7eb;">
            <table style="width:100%;font-size:11px;">
              <tr><td style="color:#6b7280;padding:2px 0;width:100px;">Account Name:</td><td style="font-weight:600;color:#1e3a5f;">Daksfirst Limited</td></tr>
              <tr><td style="color:#6b7280;padding:2px 0;">Bank:</td><td style="font-weight:600;color:#1e3a5f;">HSBC</td></tr>
              <tr><td style="color:#6b7280;padding:2px 0;">Account No:</td><td style="font-weight:600;color:#1e3a5f;">90300721</td></tr>
              <tr><td style="color:#6b7280;padding:2px 0;">Sort Code:</td><td style="font-weight:600;color:#1e3a5f;">40-02-45</td></tr>
              <tr><td style="color:#6b7280;padding:2px 0;">IBAN:</td><td style="font-weight:600;color:#1e3a5f;">GB64HBUK40024590300721</td></tr>
              <tr><td style="color:#6b7280;padding:2px 0;">Reference:</td><td style="font-weight:600;color:#1e3a5f;">${esc(dealRef)}</td></tr>
            </table>
          </div>
        </div>
      </div>

      <!-- ═══ RED NOTICE ═══ -->
      <div class="red-notice">
        <p>IMPORTANT NOTICE: This Decision in Principle is indicative only and does not constitute a binding offer or commitment to lend. Final approval is subject to full underwriting, valuation and credit committee approval.</p>
      </div>

      <!-- ═══ ACKNOWLEDGEMENT ═══ -->
      <div style="margin-bottom:8px;">
        <h5 style="margin:0 0 4px;color:#1e3a5f;font-size:11px;font-weight:700;">BORROWER ACKNOWLEDGEMENT</h5>
        <p style="font-size:11px;color:#374151;line-height:1.4;">By accepting this DIP, the Borrower acknowledges intention to proceed on the terms above. This DIP is valid for 14 days from the date of issue.</p>
      </div>

      <!-- ═══ SIGNATURES ═══ -->
      <div class="sig-row">
        <div class="sig-block">
          <div class="label">Borrower Signature</div>
          <div class="name">${esc(clean(deal.borrower_name))}</div>
          ${isCorp ? `<div class="name" style="font-size:10px;color:#6b7280;">${esc(clean(deal.borrower_company || deal.company_name))}</div>` : ''}
        </div>
        <div class="sig-block">
          <div class="label">For and on behalf of the Lender</div>
          <div class="name">Daksfirst Bridging 1 Ltd</div>
        </div>
      </div>

      <!-- ═══ DISCLAIMER ═══ -->
      <div class="disclaimer">
        <p><strong>Disclaimer:</strong> This Decision In Principle (DIP) is issued by Daksfirst Limited and is indicative only. It does not constitute a formal offer of finance and is subject to satisfactory due diligence, valuation, legal review, and final credit approval. All terms stated herein are subject to change. Daksfirst Limited reserves the right to withdraw or amend this DIP at any time prior to the issuance of a formal facility letter. The borrower should not rely on this DIP as a guarantee of funding. Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA No. 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.</p>
      </div>

    </div><!-- .bottom-block -->

  </div><!-- .dip-body -->

</div>
</body>
</html>`;
}


// ═══════════════════════════════════════════════════════════════════
// GENERATE DIP PDF — Puppeteer HTML-to-PDF
// ═══════════════════════════════════════════════════════════════════

async function generateDipPdf(deal, dipData = {}, options = {}) {
  console.log('[dip-pdf] TEMPLATE VERSION: v4.2 — generating PDF for', deal.submission_id);
  console.log('[dip-pdf] DATA DUMP:', JSON.stringify({
    properties_count: (dipData.properties || []).length,
    properties: (dipData.properties || []).map(p => ({ addr: (p.address||'').substring(0,30), pc: p.postcode, val: p.market_value })),
    broker_fee_pct: dipData.broker_fee_pct,
    broker_fee: dipData.broker_fee,
    arrangement_fee_pct: dipData.arrangement_fee_pct,
    arrangement_fee: dipData.arrangement_fee,
    deal_arr_fee: deal.arrangement_fee,
    security_address: (deal.security_address || '').substring(0,60),
    security_postcode: deal.security_postcode,
    fee_onboarding: dipData.fee_onboarding,
    fee_commitment: dipData.fee_commitment,
    pg_from_ubo: dipData.pg_from_ubo,
    fixed_charge: dipData.fixed_charge,
    security_charge: dipData.security_charge
  }));
  const html = buildDipHtml(deal, dipData, options);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '32px', left: '0' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%;padding:0 24px;font-family:Arial,sans-serif;border-top:2px solid #C9A227;">
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px;">
            <span style="font-size:7px;color:#6b7280;">Daksfirst Limited | 8 Hill Street, Mayfair, London W1J 5NG | FCA 937220 | portal@daksfirst.com</span>
            <span style="font-size:7px;color:#6b7280;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>
        </div>`
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

module.exports = { generateDipPdf };
