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

// ═══════════════════════════════════════════════════════════════════════════
//  DIP v5 helpers — added 2026-04-20 (Commit A).
//  Scaffolding for the template rewrite in Commit B. Unused until the new
//  render path is wired, so adding them is non-breaking.
// ═══════════════════════════════════════════════════════════════════════════

// Whole-pound GBP formatter. £2,000,000 not £2000000.00.
function fmtGBP(n) {
  const v = Number(n);
  if (!isFinite(v)) return '\u00A30';
  return '\u00A3' + Math.round(v).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

// Signed GBP with parentheses for negatives (waterfall deduction style).
function fmtGBPParen(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return fmtGBP(0);
  if (v < 0) return '(' + fmtGBP(-v) + ')';
  return fmtGBP(v);
}

// Format a property address + postcode inline. Avoids duplicating postcode
// when the broker has already written it into the address field.
function fmtAddressLine(address, postcode) {
  const a = (address || '').trim();
  const p = (postcode || '').trim();
  if (!a && !p) return '';
  if (!p) return a;
  if (!a) return p;
  return a.toUpperCase().includes(p.toUpperCase()) ? a : (a + ', ' + p);
}

// Matrix-SSOT resolver — approved value takes precedence, falls back to
// requested, then to default. Used throughout the new renderer so the DIP
// always reflects the current Matrix state.
function matrixValue(dealRow, approvedCol, requestedCol, fallback) {
  if (dealRow == null) return fallback;
  const a = dealRow[approvedCol];
  if (a !== null && a !== undefined && a !== '') return a;
  if (requestedCol) {
    const r = dealRow[requestedCol];
    if (r !== null && r !== undefined && r !== '') return r;
  }
  return fallback;
}

// Gross→Net Day Zero waterfall math. Returns the four line items plus the
// net advance. Respects the admin_config flag cf_credit_against_af — when
// true (default), Commitment Fee paid is credited against Arrangement Fee
// so the deduction shown is net, and Net Advance = gross - retained - (AF - CF).
function computeNetAdvanceWaterfall(opts) {
  const gross = Number(opts.grossLoan) || 0;
  const ratePm = Number(opts.ratePerMonth) || 0;          // e.g. 0.95 meaning 0.95%
  const retainedMonths = Number(opts.retainedMonths) || 0;
  const afPct = Number(opts.arrangementFeePct) || 0;       // e.g. 2.00 meaning 2%
  const cfPaid = Number(opts.commitmentFeePaid) || 0;
  const cfCreditAgainstAf = opts.cfCreditAgainstAf !== false;

  const retainedInterest = Math.round(gross * (ratePm / 100) * retainedMonths);
  const afGross = Math.round(gross * afPct / 100);
  const afNet = cfCreditAgainstAf ? Math.max(0, afGross - cfPaid) : afGross;
  const netAdvance = gross - retainedInterest - afNet;

  return {
    gross,
    retainedInterest,
    retainedMonths,
    ratePm,
    afGross,
    afNet,
    afPct,
    cfPaid,
    cfCreditApplied: cfCreditAgainstAf && cfPaid > 0,
    netAdvance
  };
}

// Default Rate = normal rate + 2 percentage points (per month). Typical UK
// bridging uplift on missed interest, to be shown in Loan Terms matrix.
function computeDefaultRate(ratePm) {
  const v = Number(ratePm);
  if (!isFinite(v)) return null;
  return +(v + 2).toFixed(2);
}

// Ensure uses_of_net_loan always returns an array of rows. Parses JSONB from
// Postgres (which may arrive as string or object). If empty, creates a single
// Day 1 Release row covering the full net advance.
function normaliseUsesOfNetLoan(raw, netAdvance, dealSummary) {
  let rows = raw;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = null; }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return [{
      purpose: 'Day 1 Release — ' + (dealSummary || 'Completion of secured facility'),
      timing: 'On completion',
      amount: Number(netAdvance) || 0
    }];
  }
  return rows.map(function (r) {
    return {
      purpose: r.purpose || r.description || '',
      timing: r.timing || r.when || 'On completion',
      amount: Number(r.amount) || 0
    };
  });
}

// Policy clause HTML from admin_config. Trusted HTML (admin-edited); if the
// string starts with '<' we pass through, otherwise wrap as <p>.
function renderPolicyHtml(raw, fallback) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return fallback || '';
  return s.charAt(0) === '<' ? s : ('<p>' + esc(s) + '</p>');
}
// ═══════════════════════════════════════════════════════════════════════════
//  End DIP v5 helpers.
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════
// G5 — Parties to the Facility (card layout) — 2026-04-20 revised
// Renders Borrowers + Guarantors as paired Corporate+UBO cards or
// single Individual cards. Colour scheme locked with user:
//   - Blue (#eaf1fa) = Corporate Entity
//   - Gold (#fff8e5) = UBO
//   - Amber (#fff3e0) = Individual Guarantor (UBO-linked to a borrower)
//   - Teal (#e0f7f5) = Individual Guarantor (Third-party, unconnected)
//   - Blue+teal-left-border = Corporate Guarantor (distinguishes from Borrower)
//   - Light-blue (#f0f5ff) = Individual Borrower (rare)
// ═══════════════════════════════════════════════════════════════════

function _g5FormatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return ''; }
}

function _g5ChVerifiedText(ch_verified_at) {
  if (!ch_verified_at) return '';
  return `CH Verified \u2713 ${_g5FormatDate(ch_verified_at)}`;
}

function _g5IdVerifiedText(kyc_status) {
  const s = (kyc_status || '').toLowerCase();
  if (s === 'verified')  return 'ID Verified \u2713';
  if (s === 'submitted') return 'ID Under review';
  if (s === 'rejected')  return 'ID Rejected';
  return 'ID Pending Verification';
}

// Get ALL UBOs for a corporate — every PSC. Falls back to single director if no PSCs.
// Returns sorted array (highest % first), so first item is the primary UBO.
function _g5GetUbosForCorporate(officersForThisCorp) {
  if (!officersForThisCorp || officersForThisCorp.length === 0) return [];
  const pscs = officersForThisCorp.filter(o => o.is_psc);
  if (pscs.length > 0) {
    return pscs.slice().sort((a, b) => {
      const parsePct = (p) => { const m = p ? String(p).match(/\d+/) : null; return m ? parseInt(m[0], 10) : 0; };
      return parsePct(b.psc_percentage) - parsePct(a.psc_percentage);
    });
  }
  // No PSCs — fall back to first director
  const directors = officersForThisCorp.filter(o => (o.role_label || '').toLowerCase().includes('director'));
  return directors.length > 0 ? [directors[0]] : [officersForThisCorp[0]];
}

// Classify an individual guarantor: 'ubolinked' if their name matches a PSC/director of any corporate borrower; else 'thirdparty'
function _g5ClassifyIndividualGuarantor(guar, allCorporates, officersByParent) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const guarName = norm(guar.full_name);
  if (!guarName) return { type: 'thirdparty', linkedToCorp: null };
  for (const corp of allCorporates) {
    const officers = officersByParent[corp.id] || [];
    for (const off of officers) {
      if (norm(off.full_name) === guarName) {
        return { type: 'ubolinked', linkedToCorp: corp };
      }
    }
  }
  return { type: 'thirdparty', linkedToCorp: null };
}

// Render the SR badge (e.g. "B1", "G1")
function _g5SrBadge(label) {
  return `<div style="font-size:9.5px;color:#c9a84c;font-weight:700;background:#1a365d;padding:2px 8px;border-radius:2px;display:inline-block;margin-bottom:6px;letter-spacing:0.5px;">${esc(label)}</div>`;
}

// Render a single UBO card (gold)
function _g5RenderUboCard(ubo, isGuarantorCorp) {
  const label = isGuarantorCorp ? 'UBO (Provides Personal Guarantee by default)' : 'Ultimate Beneficial Owner (UBO)';
  const meta = ubo.is_psc
    ? `PSC${ubo.psc_percentage ? ' \u00B7 ' + esc(ubo.psc_percentage) + '% shares' : ''}`
    : esc(ubo.role_label || 'Officer');
  return `<div style="padding:12px 14px;background:#fff8e5;border:1px solid #e8d29d;border-radius:4px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;color:#7a5c00;margin-bottom:4px;">${label}</div>
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;">${esc(ubo.full_name || '\u2014')}</div>
    <div style="font-size:10.5px;color:#555;margin-top:3px;">${meta}</div>
  </div>`;
}

// Render a Corporate + multiple UBOs paired row. UBOs stacked in the right column.
function _g5RenderCorpPair(corp, ubos, srLabel, isGuarantor) {
  const corpStyle = isGuarantor
    ? 'background:#eaf1fa;border:1px solid #b8cfe8;border-left:4px solid #0f766e;'
    : 'background:#eaf1fa;border:1px solid #b8cfe8;';
  const corpLabel = isGuarantor ? 'Corporate Guarantor' : 'Corporate Entity';
  const corpLabelColor = isGuarantor ? '#0f5857' : '#1a365d';

  const corpMeta = [];
  if (corp.company_number) corpMeta.push(`Co. No: ${esc(corp.company_number)}`);
  const chText = _g5ChVerifiedText(corp.ch_verified_at);
  if (chText) corpMeta.push(`<span style="color:#166534;font-weight:600;">${chText}</span>`);

  // Right column: stack of UBO cards, or placeholder if none
  let uboColumnHtml;
  if (Array.isArray(ubos) && ubos.length > 0) {
    uboColumnHtml = `<div style="display:flex;flex-direction:column;gap:6px;">
      ${ubos.map(u => _g5RenderUboCard(u, isGuarantor)).join('')}
    </div>`;
  } else {
    uboColumnHtml = `<div style="padding:12px 14px;background:#fff8e5;border:1px dashed #e8d29d;border-radius:4px;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;color:#7a5c00;margin-bottom:4px;">UBO</div>
      <div style="font-size:11px;color:#999;font-style:italic;">To be identified on Companies House verification</div>
    </div>`;
  }

  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;align-items:start;">
    <div style="padding:12px 14px;${corpStyle}border-radius:4px;font-family:Arial,Helvetica,sans-serif;">
      ${_g5SrBadge(srLabel)}
      <div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;color:${corpLabelColor};margin-bottom:2px;">${corpLabel}</div>
      <div style="font-size:13px;font-weight:700;color:#1a1a2e;line-height:1.2;">${esc(corp.full_name || '\u2014')}</div>
      ${corpMeta.length > 0 ? `<div style="font-size:10.5px;color:#555;margin-top:3px;">${corpMeta.join(' \u00B7 ')}</div>` : ''}
    </div>
    ${uboColumnHtml}
  </div>`;
}

// Render a single Individual card (Borrower or Guarantor — style varies)
function _g5RenderIndividualCard(person, srLabel, variant, extraMeta) {
  const styles = {
    borrower:   { bg: '#f0f5ff', border: '#b8d4ff', labelColor: '#1e3a5f', label: 'Individual Borrower' },
    ubolinked:  { bg: '#fff3e0', border: '#f3c38c', labelColor: '#7a4820', label: 'Individual Guarantor \u2014 UBO-linked' },
    thirdparty: { bg: '#e0f7f5', border: '#8bcfca', labelColor: '#0f5857', label: 'Individual Guarantor \u2014 Third Party' }
  };
  const s = styles[variant] || styles.ubolinked;

  const metaParts = [];
  if (extraMeta) metaParts.push(extraMeta);
  if (person.nationality) metaParts.push(esc(person.nationality));
  metaParts.push(_g5IdVerifiedText(person.kyc_status));
  const metaLine = metaParts.join(' \u00B7 ');

  return `<div style="margin-bottom:10px;">
    <div style="padding:12px 14px;background:${s.bg};border:1px solid ${s.border};border-radius:4px;font-family:Arial,Helvetica,sans-serif;">
      ${_g5SrBadge(srLabel)}
      <div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;color:${s.labelColor};margin-bottom:2px;">${s.label}</div>
      <div style="font-size:13px;font-weight:700;color:#1a1a2e;line-height:1.2;">${esc(person.full_name || '\u2014')}</div>
      <div style="font-size:10.5px;color:#555;margin-top:3px;">${metaLine}</div>
    </div>
  </div>`;
}

// Top-level: render full "Parties to the Facility" section (Borrowers + Guarantors)
function _g5RenderPartiesSection(dipData) {
  const g = dipData && dipData.parties_grouped;
  if (!g) return null;  // caller falls back to legacy rendering

  const allCorpBorrowers = [...(g.primary || []), ...(g.joint || [])];
  const corpGuarantors = g.corporate_guarantors || [];
  const indGuarantors = g.individual_guarantors || [];
  const officersByParent = g.officers_by_parent || {};

  const anyParties = allCorpBorrowers.length > 0 || corpGuarantors.length > 0 || indGuarantors.length > 0;
  if (!anyParties) return null;

  // BORROWERS — stack all UBOs next to each corporate (Q1.a per user)
  const borrowerUbosByCorpId = {};  // track UBOs to auto-list as Individual Guarantors
  let borrowersHtml = '';
  let bIdx = 1;
  for (const corp of allCorpBorrowers) {
    const corpIsCorporate = (corp.borrower_type || '').toLowerCase() !== 'individual';
    if (corpIsCorporate) {
      const ubos = _g5GetUbosForCorporate(officersByParent[corp.id]);
      borrowerUbosByCorpId[corp.id] = { corp, ubos };
      borrowersHtml += _g5RenderCorpPair(corp, ubos, `B${bIdx}`, false);
    } else {
      borrowersHtml += _g5RenderIndividualCard(corp, `B${bIdx}`, 'borrower', null);
    }
    bIdx++;
  }

  // GUARANTORS
  let guarantorsHtml = '';
  let gIdx = 1;
  // Corporate guarantors first (with their UBOs paired)
  for (const corp of corpGuarantors) {
    const ubos = _g5GetUbosForCorporate(officersByParent[corp.id]);
    guarantorsHtml += _g5RenderCorpPair(corp, ubos, `G${gIdx}`, true);
    gIdx++;
  }

  // Auto-add each borrower's UBOs as Individual Guarantors (Q2 per user: default all PSCs
  // become PG providers; RM can drop post-discussion).
  // Deduplicate against any manual individual_guarantors to avoid double-listing.
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const manualGuarantorNames = new Set(indGuarantors.map(g => normName(g.full_name)));

  for (const corpId of Object.keys(borrowerUbosByCorpId)) {
    const { corp, ubos } = borrowerUbosByCorpId[corpId];
    for (const ubo of ubos) {
      if (manualGuarantorNames.has(normName(ubo.full_name))) continue; // skip dupes
      // Build a pseudo-guarantor record from the UBO officer row
      const pseudoGuarantor = {
        id: `auto-ubo-guar-${ubo.id}`,
        full_name: ubo.full_name,
        nationality: ubo.nationality,
        kyc_status: 'pending'  // KYC on UBOs is checked during underwriting
      };
      guarantorsHtml += _g5RenderIndividualCard(pseudoGuarantor, `G${gIdx}`, 'ubolinked',
        `UBO of ${esc(corp.full_name)}${ubo.is_psc && ubo.psc_percentage ? ' \u00B7 PSC ' + esc(ubo.psc_percentage) + '%' : ''}`);
      gIdx++;
    }
  }

  // Then any manually-added individual guarantors — classify as ubolinked vs thirdparty
  for (const ind of indGuarantors) {
    const classified = _g5ClassifyIndividualGuarantor(ind, allCorpBorrowers.concat(corpGuarantors), officersByParent);
    const variant = classified.type;
    const extraMeta = classified.linkedToCorp ? `UBO of ${esc(classified.linkedToCorp.full_name)}` : 'Third-party PG provider';
    guarantorsHtml += _g5RenderIndividualCard(ind, `G${gIdx}`, variant, extraMeta);
    gIdx++;
  }

  // Assemble section
  const borrowersSection = borrowersHtml ? `
    <div style="color:#1a365d;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.8px;margin:8px 0 6px;font-family:Arial,Helvetica,sans-serif;">Borrowers</div>
    ${borrowersHtml}` : '';

  const guarantorsSection = guarantorsHtml ? `
    <div style="color:#1a365d;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.8px;margin:14px 0 6px;font-family:Arial,Helvetica,sans-serif;">Guarantors</div>
    ${guarantorsHtml}
    <p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#888;font-style:italic;">By default, the UBO of each corporate Borrower is named as an Individual Guarantor providing a Personal Guarantee. This default may be amended during underwriting.</p>` : '';

  return `<div style="background:#1a365d;color:#fff;padding:8px 16px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-radius:2px 2px 0 0;margin-top:14px;">Parties to the Facility</div>
  <div style="padding:14px 16px 18px;background:#fafafa;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 2px 2px;">
    ${borrowersSection}
    ${guarantorsSection}
  </div>`;
}

// Render the Security and Guarantee Structure section (blue header, bulleted list)
function _g5RenderSecuritySection(dipData, deal) {
  const g = dipData && dipData.parties_grouped;
  const propCount = (dipData.properties || []).length || 1;
  const propLabel = propCount === 1 ? 'Property' : `${propCount} Properties`;

  const corpBorrowers = g ? [...(g.primary || []), ...(g.joint || [])].filter(b => (b.borrower_type || '').toLowerCase() !== 'individual') : [];
  const corpGuarantors = g ? (g.corporate_guarantors || []) : [];
  const officersByParent = g ? (g.officers_by_parent || {}) : {};

  const corpBorrowerNames = corpBorrowers.map(c => esc(c.full_name)).join(', ') || '\u2014';
  const corpGuarantorNames = corpGuarantors.map(c => esc(c.full_name)).join(', ');

  // Build PG list from all corporate borrowers' UBOs (Q2: all PSCs auto-listed)
  // G5.3.4: per-UBO status from deal_borrowers.pg_status (required/waived/limited)
  //         and pg_limit_amount / pg_notes when set. Look up by matching name.
  // Filter out corporate PSCs — they can't give Personal Guarantees (would need Corporate Guarantee deed).
  const _isCorpEntity = (person) => {
    if (!person) return false;
    if ((person.borrower_type || '').toLowerCase() === 'corporate') return true;
    const nm = (person.full_name || '').toLowerCase().trim();
    return /\b(ltd|limited|llp|plc|inc|gmbh|ag|sa|srl|pvt|corporation|corp|company|partnership)\b\.?$/i.test(nm)
        || /\bholdings?\b/i.test(nm);
  };
  const pgLines = [];
  const corporatePscsAsGuarantors = [];
  const allBorrowersForLookup = (dipData.parties_grouped && dipData.parties_grouped.individual_guarantors) || [];
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  for (const corp of corpBorrowers) {
    const ubos = _g5GetUbosForCorporate(officersByParent[corp.id]);
    for (const u of ubos) {
      if (_isCorpEntity(u)) {
        corporatePscsAsGuarantors.push({ psc: u, corp });
        continue;  // skip — corporate PSC cannot give PG
      }
      // Find the matching formal individual_guarantor row for this UBO (by name) to read pg_status
      const uboLower = normName(u.full_name);
      const match = allBorrowersForLookup.find(ig => normName(ig.full_name) === uboLower);
      const status = (match && match.pg_status) || u.pg_status || 'required';
      const limitAmt = (match && match.pg_limit_amount) || u.pg_limit_amount;
      const notes = (match && match.pg_notes) || u.pg_notes;

      const statusBadge = status === 'waived'
        ? ' <span style="color:#6b7280;font-weight:600;">(Waived)</span>'
        : status === 'limited'
        ? ` <span style="color:#92400e;font-weight:600;">(Limited${limitAmt ? ' to £' + Number(limitAmt).toLocaleString('en-GB') : ''})</span>`
        : '';
      const notesBit = notes ? ` <span style="color:#777;font-style:italic;">— ${esc(notes)}</span>` : '';

      pgLines.push(`${esc(u.full_name)}${statusBadge} <span style="color:#666;">(UBO of ${esc(corp.full_name)}${u.is_psc && u.psc_percentage ? ', PSC ' + esc(u.psc_percentage) + '%' : ''})</span>${notesBit}`);
    }
  }

  // Share charge state — prefer dip_data override, fall back to native column on deal
  const shareChargeVal = dipData.requires_share_charge || (deal && deal.requires_share_charge) || null;
  const shareChargeState = (shareChargeVal === 'required' || shareChargeVal === true)
    ? { label: 'Required', bg: '#d1fae5', fg: '#065f46' }
    : (shareChargeVal === 'not_required' || shareChargeVal === false)
    ? { label: 'Not Required', bg: '#f3f4f6', fg: '#6b7280' }
    : { label: 'RM to elect', bg: '#fef3c7', fg: '#92400e' };

  const rowStyle = 'padding:8px 12px;margin-bottom:5px;background:#fff;border-left:3px solid #1a365d;border-radius:2px;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;display:flex;justify-content:space-between;align-items:center;';
  const statusPill = (label, bg, fg) => `<span style="font-size:10px;padding:2px 8px;border-radius:3px;font-weight:700;letter-spacing:0.3px;background:${bg};color:${fg};">${label}</span>`;

  const items = [];

  // G5.3.4 — read per-property charge type from deal_properties; fall back to "First Legal Charge"
  const chargeTypeMap = {
    'first_charge': 'First Legal Charge',
    'second_charge': 'Second Charge',
    'third_charge': 'Third Charge',
    'no_charge': 'No Charge'
  };
  const propsByCharge = {};
  for (const p of (dipData.properties || [])) {
    const ct = p.security_charge_type || 'first_charge';
    if (!propsByCharge[ct]) propsByCharge[ct] = [];
    propsByCharge[ct].push(p);
  }
  // Render one row per distinct charge type (so mixed-charge deals show explicitly)
  const chargeOrder = ['first_charge', 'second_charge', 'third_charge', 'no_charge'];
  for (const ct of chargeOrder) {
    const group = propsByCharge[ct];
    if (!group || group.length === 0) continue;
    const label = chargeTypeMap[ct];
    const suffix = group.length === (dipData.properties || []).length ? propLabel : `${group.length} Propert${group.length === 1 ? 'y' : 'ies'}`;
    const addressList = group.length <= 2 ? ' <span style="color:#666;font-size:10px;">(' + group.map(p => esc(p.address || p.postcode || '')).join(', ') + ')</span>' : '';
    const pill = ct === 'no_charge'
      ? statusPill('Not Applicable', '#f3f4f6', '#6b7280')
      : statusPill('Required', '#d1fae5', '#065f46');
    items.push(`<div style="${rowStyle}">
      <span><strong>${label}</strong> over ${suffix}${addressList}</span>
      ${pill}
    </div>`);
  }

  if (corpBorrowers.length > 0) {
    items.push(`<div style="${rowStyle}">
      <span><strong>Fixed &amp; Floating Charge</strong> over Corporate Borrower${corpBorrowers.length > 1 ? 's' : ''} <span style="color:#666;font-size:10px;">(${corpBorrowerNames})</span></span>
      ${statusPill('Required', '#d1fae5', '#065f46')}
    </div>`);
  }

  if (corpBorrowers.length > 0) {
    items.push(`<div style="${rowStyle}">
      <span><strong>Share Charge</strong> over Corporate Borrower${corpBorrowers.length > 1 ? 's' : ''} <span style="color:#888;font-size:10px;">(if elected by RM)</span></span>
      ${statusPill(shareChargeState.label, shareChargeState.bg, shareChargeState.fg)}
    </div>`);
  }

  if (corpGuarantors.length > 0) {
    items.push(`<div style="${rowStyle}">
      <span><strong>Corporate Guarantee</strong> <span style="color:#888;font-size:10px;">(unsecured)</span> from ${corpGuarantorNames}</span>
      ${statusPill('Required', '#d1fae5', '#065f46')}
    </div>`);
  }

  // G5.3 — Advisory if corporate PSC detected (cannot give PG, may need Corporate Guarantee)
  if (corporatePscsAsGuarantors.length > 0) {
    const list = corporatePscsAsGuarantors.map(cp => `<strong>${esc(cp.psc.full_name)}</strong> (PSC of ${esc(cp.corp.full_name)})`).join('; ');
    items.push(`<div style="${rowStyle}flex-direction:column;align-items:flex-start;background:#fef3c7;border-left:3px solid #f59e0b;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <span><strong>Corporate PSC Detected</strong> \u2014 RM to assess Corporate Guarantee</span>
        ${statusPill('RM Review', '#fef3c7', '#92400e')}
      </div>
      <div style="margin-top:4px;font-size:10.5px;color:#7a4820;">${list}. These are corporate entities (PSCs) and cannot provide a Personal Guarantee. RM should determine whether to request a Corporate Guarantee deed.</div>
    </div>`);
  }

  if (pgLines.length > 0) {
    items.push(`<div style="${rowStyle}flex-direction:column;align-items:flex-start;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <span><strong>Personal Guarantee</strong> from respective UBOs</span>
        ${statusPill('Required', '#d1fae5', '#065f46')}
      </div>
      <ul style="margin:6px 0 0;padding-left:20px;font-size:11px;color:#333;">
        ${pgLines.map(l => `<li style="padding:2px 0;"><strong>${l.split('<span')[0]}</strong>${l.includes('<span') ? '<span' + l.split('<span')[1] : ''}</li>`).join('')}
      </ul>
    </div>`);
  }

  // G5.3.4 — Additional Security (free text, only render if set)
  const addlSec = (dipData.additional_security_text || (deal && deal.additional_security_text) || '').trim();
  if (addlSec) {
    items.push(`<div style="${rowStyle}flex-direction:column;align-items:flex-start;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <span><strong>Additional Security</strong></span>
        ${statusPill('Required', '#d1fae5', '#065f46')}
      </div>
      <div style="margin-top:4px;font-size:11px;color:#333;line-height:1.4;">${esc(addlSec)}</div>
    </div>`);
  }

  return `<div style="background:#1a365d;color:#fff;padding:8px 16px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-radius:2px 2px 0 0;margin-top:14px;">Security and Guarantee Structure</div>
  <div style="padding:14px 16px;background:#fafafa;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 2px 2px;">
    ${items.join('')}
  </div>`;
}


// ═══════════════════════════════════════════════════════════════════
// BUILD HTML
// ═══════════════════════════════════════════════════════════════════

function buildDipHtml(deal, dipData, options) {
  // Data extraction with Matrix-SSOT fallback
  const dealRef = dealRefFromId(deal.submission_id, deal.created_at);
  const grossLoan = parseFloat(deal.loan_amount_approved || deal.loan_amount || 0);
  const loanTerm = parseFloat(deal.term_months || 12);
  const ratePerMonth = parseFloat(deal.rate_approved || deal.rate_approved || 0.95) / 100;
  const retainedMonths = deal.retained_interest_months || dipData.retained_months || 6;
  const arrangementFeePct = parseFloat(deal.arrangement_fee_pct || dipData.arrangement_fee_pct || 2);
  const commitmentFee = parseFloat(deal.commitment_fee || dipData.fee_commitment || 0);
  const dipFee = parseFloat(deal.dip_fee || dipData.fee_onboarding || 1000);
  const brokerFeePct = parseFloat(deal.broker_fee_pct || dipData.broker_fee_pct || 0);
  const minValueCovenant = parseFloat(deal.min_value_covenant || dipData.min_value_covenant || 0);
  const minLoanTerm = parseFloat(deal.min_loan_term || 3);
  const dayCountBasis = deal.day_count_basis || '360';
  const requiresShareCharge = deal.requires_share_charge === true;
  const defaultRate = ratePerMonth * 100 + 2;

  // Property schedule
  const properties = (dipData.properties || []).map((p, idx) => ({
    num: idx + 1,
    address: p.address || '',
    postcode: p.postcode || '',
    tenure: p.tenure || '\u2014',
    value: parseFloat(p.market_value || 0)
  }));
  const totalPortfolioValue = properties.reduce((sum, p) => sum + p.value, 0);

  // Loan Terms grid data
  const ltv = totalPortfolioValue > 0 ? (grossLoan / totalPortfolioValue * 100) : 0;
  const interestServicing = retainedMonths > 0 ? `Retained (${retainedMonths} mo)` : 'Serviced Monthly';

  // Parties rendering via G5
  const partiesHtml = _g5RenderPartiesSection(dipData);

  // Issue date
  const issueDate = options.issuedAt
    ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Admin config fallback
  const adminConfig = options.adminConfig || {};
  const FALLBACK_CF = `<ul>
<li><strong>If the deal completes:</strong> the Commitment Fee is credited against the Arrangement Fee payable on completion (Borrower does not pay twice).</li>
<li><strong>If the Borrower withdraws, or if information provided is misrepresented, or if the valuation does not support the proposed lending, or if KYC / AML is not satisfactory:</strong> the Commitment Fee is <strong>forfeited</strong>.</li>
<li><strong>If Daksfirst withdraws for reasons wholly within its own control:</strong> the Commitment Fee <em>may be refunded</em> at Daksfirst's discretion.</li>
</ul>`;

  const FALLBACK_REG = `<p><strong>Regulatory Disclosure &amp; Nature of Facility.</strong> Daksfirst Limited is a private limited company registered in England and Wales under company number <strong>11626401</strong>, with registered office at 8 Hill Street, Mayfair, London W1J 5NG. Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (<strong>FCA No. 937220</strong>).</p>
<p><strong>This facility is an unregulated mortgage contract.</strong> The Borrower is a corporate entity and the secured property is held for investment / commercial purposes, not for occupation by the Borrower or a related individual. Accordingly, the protections afforded to consumers under FCA rules &mdash; including access to the Financial Ombudsman Service and the Financial Services Compensation Scheme (FSCS) &mdash; do not apply to this transaction.</p>
<p>Daksfirst reserves the right to withdraw or amend this DIP at any time prior to the issuance of a binding Facility Letter. The Borrower should not rely on this DIP as a guarantee of funding.</p>`;

  // Compute waterfall
  const waterfallCalc = computeNetAdvanceWaterfall({
    grossLoan,
    ratePerMonth,
    retainedMonths,
    arrangementFeePct,
    commitmentFeePaid: commitmentFee,
    cfCreditAgainstAf: adminConfig?.cf_credit_against_af !== false
  });

  // Broker name
  const brokerName = deal.broker_company || dipData.broker_firm || '[Broker Firm]';

  // Build HTML
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DIP - ${dealRef}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #222;
    font-size: 10px;
    line-height: 1.42;
    margin: 0;
    padding: 0;
  }
  .page {
    width: 210mm;
    height: 297mm;
    background: #fff;
    margin: 0 auto 24px;
    padding: 0 16mm 28mm 16mm;
    position: relative;
    overflow: hidden;
    page-break-after: always;
  }
  .page:last-child { page-break-after: auto; }

  /* Brand header */
  .brand {
    background: #1a3a5c;
    color: #fff;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9mm 16mm 7mm 16mm;
    margin: 0 -16mm 10px -16mm;
    border-bottom: 3px solid #c9a456;
  }
  .brand-left { display: flex; align-items: center; gap: 12px; }
  .brand-logo { flex: 0 0 58px; width: 58px; height: 58px; display: block; }
  .brand-text { padding-top: 1px; }
  .brand-name { font-size: 20px; font-weight: 800; letter-spacing: 1.4px; color: #fff; line-height: 1; }
  .brand-tagline { font-size: 10px; font-style: italic; color: #c9a456; margin-top: 3px; }
  .brand-right { text-align: right; font-size: 9.5px; color: #fff; line-height: 1.5; }
  .brand-right .deal-ref { font-weight: 700; font-size: 11px; }
  .brand-right .issued { color: #c9a456; font-weight: 600; }

  /* Title bar */
  .title-bar { text-align: center; margin: 14px 0 8px; page-break-after: avoid; }
  .title-bar h1 { margin: 0; color: #0f2a4a; font-size: 17px; font-weight: 700; }
  .title-bar .sub { font-size: 9px; color: #6b7280; margin-top: 3px; }
  .title-bar .ver { color: #aaa; }

  /* Ref strip */
  .ref-strip {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: 1.5px solid #1a3a5c;
    border-radius: 4px;
    padding: 7px 12px;
    margin-bottom: 7px;
    page-break-inside: avoid;
    page-break-after: avoid;
  }
  .ref-strip .ref { font-weight: 700; color: #0f2a4a; font-size: 12px; }
  .ref-strip .issued { font-size: 9.5px; }
  .ref-strip .badge { background: #1a3a5c; color: #fff; font-weight: 700; font-size: 9px; padding: 4px 10px; border-radius: 3px; letter-spacing: 0.8px; }

  .preamble { font-size: 9.5px; color: #333; margin-bottom: 8px; line-height: 1.5; page-break-after: avoid; }

  /* Sections */
  .section { page-break-inside: avoid; break-inside: avoid; margin-top: 8px; }
  .section-bar {
    background: #0f2a4a;
    color: #fff;
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 0.8px;
    padding: 6px 10px;
    border-radius: 3px 3px 0 0;
  }
  .section-body {
    border: 1px solid #e5e7ec;
    border-top: 0;
    padding: 9px 10px;
    border-radius: 0 0 3px 3px;
  }

  /* Parties */
  .parties-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .party-card {
    border: 1px solid #e5e7ec;
    border-left: 3px solid #1a3a5c;
    border-radius: 3px;
    padding: 7px 9px;
  }
  .party-card.guarantor { border-left-color: #c9a456; background: #fffdf7; }
  .party-tag {
    display: inline-block;
    background: #1a3a5c;
    color: #fff;
    font-weight: 700;
    font-size: 8.5px;
    padding: 2px 6px;
    border-radius: 2px;
    margin-bottom: 5px;
    letter-spacing: 0.5px;
  }
  .party-tag.g { background: #c9a456; }
  .party-role { font-size: 8px; color: #6b7280; letter-spacing: 0.6px; font-weight: 600; text-transform: uppercase; margin-bottom: 2px; }
  .party-name { font-weight: 700; font-size: 11.5px; color: #0f2a4a; margin-bottom: 2px; }
  .party-meta { font-size: 9px; color: #444; margin-bottom: 1px; }

  /* Security rows */
  .sec-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #e5e7ec; font-size: 9.5px; }
  .sec-row:last-child { border-bottom: 0; }
  .sec-row .label strong { color: #0f2a4a; }
  .status { font-size: 8.5px; font-weight: 700; padding: 2px 7px; border-radius: 3px; letter-spacing: 0.5px; }
  .status.req { background: #e5f3ea; color: #2e8f4e; }

  /* Tables */
  .sched-table {
    width: 100%;
    border-collapse: collapse;
  }
  .sched-table th {
    background: #f4f6f9;
    color: #0f2a4a;
    font-size: 8.5px;
    padding: 5px 8px;
    text-align: left;
    border-bottom: 1px solid #e5e7ec;
    letter-spacing: 0.5px;
    font-weight: 700;
  }
  .sched-table td {
    padding: 5px 8px;
    border-bottom: 1px solid #e5e7ec;
    font-size: 9.5px;
  }
  .sched-table .num { width: 22px; color: #6b7280; }
  .sched-table .val { text-align: right; font-weight: 600; }
  .sched-table tr.total td { background: #f8fafc; font-weight: 700; color: #0f2a4a; border-bottom: 0; }

  .sched-footer { display: flex; justify-content: space-between; font-size: 9px; margin-top: 5px; padding-top: 5px; border-top: 1px dashed #e5e7ec; color: #333; }
  .sched-footer strong { color: #0f2a4a; }

  .omv-note { margin-top: 6px; padding: 6px 9px; background: #fef9e7; border-left: 3px solid #c9a456; border-radius: 0 3px 3px 0; font-size: 8.5px; color: #5a4a1a; line-height: 1.5; }
  .omv-note strong { color: #0f2a4a; }

  /* Loan Terms grid */
  .lt-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .lt-cell {
    border: 1px solid #e5e7ec;
    border-radius: 3px;
    padding: 5px 7px;
    min-height: 40px;
  }
  .lt-cell.lt-default {
    background: #fff1f0;
    border-color: #e5a7a2;
  }
  .lt-cell.lt-default .lt-label { color: #b42318; }
  .lt-cell.lt-default .lt-value { color: #b42318; }
  .lt-cell.lt-default .lt-hint { color: #8a2b23; }
  .lt-label { font-size: 8px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .lt-value { font-size: 11px; font-weight: 700; color: #0f2a4a; }
  .lt-hint { font-size: 8px; color: #6b7280; margin-top: 1px; }

  /* Waterfall */
  .waterfall {
    background: #fef4e0;
    border: 1px solid #b45309;
    border-radius: 3px;
    padding: 8px 12px;
    margin-top: 7px;
    page-break-inside: avoid;
  }
  .waterfall-title { font-size: 9.5px; font-weight: 700; color: #b45309; letter-spacing: 0.7px; margin-bottom: 5px; }
  .waterfall-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 10px; }
  .waterfall-row.deduction { color: #7c2d12; }
  .waterfall-row .amount { font-weight: 700; font-family: 'SF Mono', Consolas, monospace; font-size: 10.5px; }
  .waterfall-row.total {
    border-top: 2px solid #b45309;
    margin-top: 5px;
    padding-top: 5px;
    font-size: 11.5px;
    font-weight: 700;
    color: #0f2a4a;
  }
  .waterfall-row.total .amount {
    background: #0f2a4a;
    color: #fff;
    padding: 2px 10px;
    border-radius: 3px;
    font-size: 11px;
  }

  /* Uses table */
  .uses-table {
    width: 100%;
    border-collapse: collapse;
  }
  .uses-table th {
    background: #f4f6f9;
    color: #0f2a4a;
    font-size: 8.5px;
    padding: 5px 8px;
    text-align: left;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #e5e7ec;
    font-weight: 700;
  }
  .uses-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #e5e7ec;
    font-size: 9.5px;
    vertical-align: top;
  }
  .uses-table .num { width: 22px; color: #6b7280; }
  .uses-table .val { text-align: right; font-weight: 600; color: #0f2a4a; width: 90px; }
  .uses-table tr.total td {
    background: #eef4ff;
    font-weight: 700;
    color: #0f2a4a;
    border-bottom: 0;
    border-top: 2px solid #1a3a5c;
  }
  .uses-note { margin-top: 7px; padding: 5px 10px; background: #f7f9fc; border-left: 3px solid #1a3a5c; border-radius: 0 3px 3px 0; font-size: 8.5px; color: #555; line-height: 1.5; font-style: italic; }

  /* Fee table */
  .fee-table { width: 100%; border-collapse: collapse; }
  .fee-table th {
    background: #f4f6f9;
    color: #0f2a4a;
    font-size: 8.5px;
    padding: 5px 8px;
    text-align: left;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #e5e7ec;
    font-weight: 700;
  }
  .fee-table td {
    padding: 5px 8px;
    border-bottom: 1px solid #e5e7ec;
    font-size: 9.5px;
  }
  .fee-table td.amt { font-weight: 700; color: #0f2a4a; }
  .fee-table tr.highlight td { background: #fffdf7; }
  .fee-table .sub-row td { padding-left: 20px; color: #6b7280; font-style: italic; }
  .fee-note { font-size: 8.5px; font-style: italic; color: #6b7280; margin-top: 7px; }

  .cf-treatment {
    margin-top: 8px;
    background: #fef9e7;
    border: 1px solid #c9a456;
    border-radius: 3px;
    padding: 8px 12px;
  }
  .cf-treatment .cf-title {
    font-size: 9px;
    font-weight: 700;
    color: #0f2a4a;
    letter-spacing: 0.6px;
    margin-bottom: 5px;
  }
  .cf-treatment ul { margin: 0; padding-left: 15px; font-size: 9px; line-height: 1.5; }
  .cf-treatment ul li { margin-bottom: 3px; color: #3a3a3a; }
  .cf-treatment ul li strong { color: #0f2a4a; }

  /* Conditions precedent */
  .cp-list { column-count: 2; column-gap: 20px; font-size: 9.5px; margin: 3px 0 0; padding-left: 18px; }
  .cp-list li { margin-bottom: 2px; break-inside: avoid; }

  /* Next steps */
  .ns-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 8px; }
  .ns-steps { border: 1px solid #e5e7ec; border-radius: 3px; padding: 8px 10px; }
  .ns-steps ol { margin: 0; padding-left: 16px; font-size: 9.5px; }
  .ns-steps ol li { margin-bottom: 4px; line-height: 1.5; }
  .ns-steps ol li strong { color: #0f2a4a; }

  .pay-box {
    border: 2px solid #2e8f4e;
    background: #f4fbf6;
    border-radius: 3px;
    padding: 8px 10px;
  }
  .pay-box h4 {
    margin: 0 0 5px;
    color: #2e8f4e;
    font-size: 9.5px;
    letter-spacing: 0.5px;
  }
  .pay-box table {
    width: 100%;
    font-size: 9.5px;
    border-collapse: collapse;
  }
  .pay-box td {
    padding: 1.5px 0;
    vertical-align: top;
  }
  .pay-box td:first-child {
    color: #6b7280;
    width: 78px;
  }
  .pay-box td:last-child { font-weight: 700; color: #0f2a4a; }

  /* Notice + ack */
  .notice {
    background: #fff1f0;
    border: 1px solid #b42318;
    border-radius: 3px;
    padding: 7px 12px;
    text-align: center;
    font-size: 9px;
    color: #b42318;
    font-weight: 700;
    margin-top: 8px;
    page-break-inside: avoid;
  }

  .ack { margin-top: 8px; page-break-inside: avoid; }
  .ack-content { font-size: 9.5px; margin-bottom: 12px; }

  .ack-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
    margin-top: 6px;
  }
  .ack-row-two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 6px;
  }

  .sig-card {
    border: 1px solid #e5e7ec;
    border-top: 3px solid #1a3a5c;
    border-radius: 2px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    background: #fcfcfd;
  }

  .sig-role {
    font-size: 8.5px;
    font-weight: 700;
    color: #0f2a4a;
    letter-spacing: 1.2px;
    text-align: center;
    background: #eef3f9;
    padding: 3px 0;
    border-radius: 2px;
    margin-bottom: 9px;
  }

  .sig-entity {
    flex: 0 0 auto;
    min-height: 42px;
    text-align: center;
    padding-bottom: 8px;
    border-bottom: 1px dashed #e5e7ec;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
  }
  .sig-entity .entity-name {
    font-size: 10.5px;
    font-weight: 700;
    color: #0f2a4a;
    line-height: 1.25;
  }
  .sig-entity .entity-cap {
    font-size: 8px;
    font-style: italic;
    color: #6b7280;
    margin-top: 3px;
    line-height: 1.35;
  }

  .sig-field { margin-top: 8px; }
  .sig-field:first-of-type { margin-top: 0; }
  .sig-field .sig-label {
    font-size: 7.5px;
    font-weight: 700;
    color: #6b7280;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  .sig-field .sig-line {
    border-bottom: 1px solid #5a5a5a;
    height: 12px;
  }
  .sig-field.sig-signature .sig-line { height: 22px; }

  .ack-stamp {
    margin-top: 10px;
    border: 1px dashed #bbb;
    border-radius: 3px;
    padding: 6px 10px;
    font-size: 8px;
    color: #6b7280;
    text-align: center;
    font-style: italic;
  }

  .disclaimer {
    font-size: 8px;
    color: #6b7280;
    margin-top: 8px;
    line-height: 1.55;
    padding: 7px 10px;
    background: #f8f9fb;
    border-radius: 3px;
    page-break-inside: avoid;
  }

  /* Page footer */
  .page-footer {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1a3a5c;
    color: #fff;
    padding: 6mm 16mm 6mm 16mm;
    border-top: 3px solid #c9a456;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    font-size: 7.8px;
    line-height: 1.5;
  }
  .page-footer .corp { flex: 1; padding-right: 10mm; }
  .page-footer .corp .legal-line { color: #fff; margin-bottom: 2px; }
  .page-footer .corp .legal-line strong { color: #fff; font-weight: 700; }
  .page-footer .corp .legal-line .label { color: #c9a456; font-weight: 600; }
  .page-footer .corp .policies { color: #cdd5e0; font-size: 7.3px; margin-top: 3px; font-style: italic; }
  .page-footer .corp .policies a { color: #c9a456; text-decoration: none; }
  .page-footer .pnum { text-align: right; flex: 0 0 auto; font-size: 8.5px; }
  .page-footer .pnum .web { color: #c9a456; font-weight: 700; }
  .page-footer .pnum .page-num { color: #fff; font-weight: 600; margin-top: 2px; }
</style>
</head>
<body>

<!-- ══════════════════════════ PAGE 1 ══════════════════════════ -->
<div class="page">
  <div class="brand">
    <div class="brand-left">
      <img class="brand-logo" alt="Daksfirst" src="data:image/png;base64,${LOGO_B64}">
      <div class="brand-text">
        <div class="brand-name">DAKSFIRST</div>
        <div class="brand-tagline">Bridging Finance</div>
      </div>
    </div>
    <div class="brand-right">
      <div class="deal-ref">Deal Ref: ${esc(dealRef)}</div>
      <div class="issued">Issued: ${esc(issueDate)} · Valid 14 days</div>
    </div>
  </div>

  <div class="title-bar">
    <h1>Decision In Principle (DIP)</h1>
    <div class="sub">Indicative terms — subject to full underwriting, valuation &amp; credit approval <span class="ver">[v5.0]</span></div>
  </div>

  <div class="ref-strip">
    <div class="ref">${esc(dealRef)}</div>
    <div class="issued">Borrower type: <strong>${deal.borrower_type ? deal.borrower_type.toUpperCase() : 'CORPORATE'}</strong> &nbsp;|&nbsp; Portfolio: <strong>${properties.length} ${properties.length === 1 ? 'Property' : 'Properties'}</strong></div>
    <div class="badge">${deal.borrower_type ? deal.borrower_type.toUpperCase() : 'CORPORATE'}</div>
  </div>

  <div class="preamble">
    This Decision in Principle sets out the indicative terms under which Daksfirst may provide senior secured finance. All terms are subject to full underwriting, valuation, and credit approval.
  </div>

  <!-- PARTIES -->
  <div class="section">
    <div class="section-bar">PARTIES TO THE FACILITY</div>
    <div class="section-body">
      ${partiesHtml || '<div style="font-size:9.5px;color:#666;">Parties section pending G5 data.</div>'}
    </div>
  </div>

  <!-- SECURITY STRUCTURE -->
  <div class="section">
    <div class="section-bar">SECURITY &amp; GUARANTEE STRUCTURE</div>
    <div class="section-body">
      <div class="sec-row"><div class="label"><strong>First Legal Charge</strong> over ${properties.length} ${properties.length === 1 ? 'Property' : 'Properties'}</div><div class="status req">REQUIRED</div></div>
      <div class="sec-row"><div class="label"><strong>Fixed &amp; Floating Charge (Debenture)</strong></div><div class="status req">REQUIRED</div></div>
      <div class="sec-row"><div class="label"><strong>Personal Guarantee</strong> from UBO(s)</div><div class="status req">REQUIRED</div></div>
      ${requiresShareCharge ? `<div class="sec-row"><div class="label"><strong>Share Charge</strong></div><div class="status req">REQUIRED</div></div>` : ''}
    </div>
  </div>

  <!-- SECURITY SCHEDULE -->
  <div class="section">
    <div class="section-bar">SECURITY SCHEDULE — ${properties.length} ${properties.length === 1 ? 'PROPERTY' : 'PROPERTIES'}</div>
    <div class="section-body">
      <table class="sched-table">
        <thead><tr><th class="num">#</th><th>Address</th><th>Postcode</th><th>Tenure</th><th class="val">Value as Supplied (£)</th></tr></thead>
        <tbody>
          ${properties.map(p => `<tr><td class="num">${p.num}</td><td>${esc(p.address)}</td><td>${esc(p.postcode)}</td><td>${esc(p.tenure)}</td><td class="val">${fmtGBP(p.value)}</td></tr>`).join('')}
          <tr class="total"><td></td><td colspan="3">Total Portfolio Value (as supplied)</td><td class="val">${fmtGBP(totalPortfolioValue)}</td></tr>
        </tbody>
      </table>
      <div class="sched-footer">
        <div>Asset Type: <strong>Residential</strong></div>
        <div>Purchase Price: <strong>${fmtGBP(0)}</strong></div>
        <div>LTV (on supplied value): <strong>${ltv.toFixed(2)}%</strong></div>
      </div>
      <div class="omv-note">
        <strong>Note on valuation:</strong> Values shown are <em>as supplied by the broker / borrower</em>. Final lending decision and LTV will be based on the <strong>180-day Open Market Value (180-day OMV)</strong> from an independent RICS valuer instructed by Daksfirst.
      </div>
    </div>
  </div>

  <!-- LOAN TERMS -->
  <div class="section">
    <div class="section-bar">INDICATIVE LOAN TERMS</div>
    <div class="section-body">
      <div class="lt-grid">
        <div class="lt-cell"><div class="lt-label">Loan Amount</div><div class="lt-value">${fmtGBP(grossLoan)}</div></div>
        <div class="lt-cell"><div class="lt-label">Term</div><div class="lt-value">${loanTerm} months</div><div class="lt-hint">Min ${minLoanTerm} months</div></div>
        <div class="lt-cell"><div class="lt-label">Rate</div><div class="lt-value">${(ratePerMonth * 100).toFixed(2)}% p.m.</div><div class="lt-hint">Min 0.85% · 360-day basis</div></div>
        <div class="lt-cell lt-default"><div class="lt-label">Default Rate</div><div class="lt-value">${defaultRate.toFixed(2)}% p.m.</div><div class="lt-hint">Rate + 2%</div></div>

        <div class="lt-cell"><div class="lt-label">Gross LTV</div><div class="lt-value">${ltv.toFixed(2)}%</div><div class="lt-hint">Max 75%</div></div>
        <div class="lt-cell"><div class="lt-label">Min Value Covenant</div><div class="lt-value">${fmtGBP(minValueCovenant || totalPortfolioValue)}</div><div class="lt-hint">Portfolio floor</div></div>
        <div class="lt-cell"><div class="lt-label">Interest Servicing</div><div class="lt-value" style="font-size:10.5px;">${interestServicing}</div></div>
        <div class="lt-cell"><div class="lt-label">Arrangement Fee</div><div class="lt-value">${arrangementFeePct.toFixed(2)}%</div></div>

        <div class="lt-cell"><div class="lt-label">Loan Purpose</div><div class="lt-value" style="font-size:10.5px;">Purchase</div></div>
        <div class="lt-cell" style="grid-column: span 3;"><div class="lt-label">Exit Strategy</div><div class="lt-value" style="font-size:10.5px;">Refinance</div></div>
      </div>
    </div>
  </div>

  <div class="page-footer">
    <div class="corp">
      <div class="legal-line"><strong>Daksfirst Limited</strong> · 8 Hill Street, Mayfair, London W1J 5NG</div>
      <div class="legal-line"><span class="label">Co. Reg</span> 11626401 · <span class="label">FCA</span> 937220 · portal@daksfirst.com</div>
      <div class="policies">T&Cs, AML & Privacy Policies — see website</div>
    </div>
    <div class="pnum">
      <div class="web">www.daksfirst.com</div>
      <div class="page-num">Page 1 of 3</div>
    </div>
  </div>
</div>

<!-- ══════════════════════════ PAGE 2 ══════════════════════════ -->
<div class="page">
  <div class="brand">
    <div class="brand-left">
      <img class="brand-logo" alt="Daksfirst" src="data:image/png;base64,${LOGO_B64}">
      <div class="brand-text">
        <div class="brand-name">DAKSFIRST</div>
        <div class="brand-tagline">Bridging Finance</div>
      </div>
    </div>
    <div class="brand-right">
      <div class="deal-ref">Deal Ref: ${esc(dealRef)}</div>
      <div class="issued">Page 2 of 3</div>
    </div>
  </div>

  <!-- DAY ZERO WATERFALL -->
  <div class="section">
    <div class="section-bar">DAY ZERO — NET ADVANCE ON COMPLETION</div>
    <div class="section-body" style="padding: 0;">
      <div class="waterfall" style="margin: 0; border-radius: 0; border: 0;">
        <div class="waterfall-row"><div>Gross Loan</div><div class="amount">${fmtGBP(waterfallCalc.gross)}</div></div>
        <div class="waterfall-row deduction"><div>Less: Retained Interest (${retainedMonths} months × ${(ratePerMonth*100).toFixed(2)}%, ${dayCountBasis}-day basis)</div><div class="amount">${fmtGBPParen(-waterfallCalc.retainedInterest)}</div></div>
        <div class="waterfall-row deduction">
          <div>Less: Arrangement Fee <span style="font-weight:400;font-size:9px;">(${arrangementFeePct.toFixed(2)}% = ${fmtGBP(grossLoan * arrangementFeePct / 100)}${commitmentFee > 0 ? ', net of ' + fmtGBP(commitmentFee) + ' Commitment Fee credit' : ''})</span></div>
          <div class="amount">${fmtGBPParen(-waterfallCalc.afNet)}</div>
        </div>
        <div class="waterfall-row total"><div>Net Advance to Borrower</div><div class="amount">${fmtGBP(waterfallCalc.netAdvance)}</div></div>
      </div>
      <div style="background:#fefcf5; padding:6px 14px; font-size:8.5px; color:#5a4a1a; font-style:italic; border-top: 1px solid #b45309; border-radius: 0 0 3px 3px;">
        ${commitmentFee > 0 ? `Commitment Fee of ${fmtGBP(commitmentFee)} paid at Term Sheet acceptance is credited against the Arrangement Fee above. ` : ''}Net Advance is on the Gross Loan and excludes solicitors' costs, valuation fees, and disbursements — all borne directly by the Borrower.
      </div>
    </div>
  </div>

  <!-- USES OF NET LOAN -->
  <div class="section">
    <div class="section-bar">USES OF NET LOAN</div>
    <div class="section-body">
      <table class="uses-table">
        <thead><tr><th>#</th><th>Purpose</th><th>Timing</th><th class="val">Amount</th></tr></thead>
        <tbody>
          <tr><td class="num">1</td><td><strong>Day 1 Release</strong> — Purchase of security properties</td><td>On completion</td><td class="val">${fmtGBP(waterfallCalc.netAdvance)}</td></tr>
          <tr class="total"><td></td><td colspan="2">TOTAL — must match Net Advance</td><td class="val">${fmtGBP(waterfallCalc.netAdvance)}</td></tr>
        </tbody>
      </table>
      <div class="uses-note">For refurbishment / development-bridging deals, Uses of Net Loan will split across Day 1 release + staged draws (paid against surveyor-certified invoices) + retention. Drawdown timing is set in the Facility Letter.</div>
    </div>
  </div>

  <!-- FEE SCHEDULE -->
  <div class="section">
    <div class="section-bar">FEE SCHEDULE</div>
    <div class="section-body">
      <table class="fee-table">
        <thead><tr><th>Fee</th><th>Amount</th><th>When Due</th><th>Payment Trigger</th></tr></thead>
        <tbody>
          <tr class="highlight"><td><strong>Onboarding / DIP Fee</strong></td><td class="amt">${fmtGBP(dipFee)}</td><td>On DIP acceptance</td><td>Required before Credit Review</td></tr>
          <tr><td><strong>Commitment Fee</strong></td><td class="amt">${fmtGBP(commitmentFee)}</td><td>On Termsheet acceptance</td><td>Required before Underwriting</td></tr>
          <tr><td><strong>Arrangement Fee</strong></td><td class="amt">${fmtGBP(grossLoan * arrangementFeePct / 100)} (${arrangementFeePct.toFixed(2)}%)</td><td>On completion</td><td>Deducted from advance</td></tr>
          ${brokerFeePct > 0 && deal.broker_id ? `<tr class="sub-row"><td>↳ of which Broker Fee</td><td>—</td><td>On completion</td><td>From arrangement fee</td></tr>` : ''}
          <tr><td><strong>Exit Fee</strong></td><td class="amt">1.00% of loan</td><td>On redemption</td><td>Payable at exit</td></tr>
          <tr><td><strong>Extension Fee</strong></td><td class="amt">1.00% of loan</td><td>If term extended</td><td>Per extension period agreed</td></tr>
        </tbody>
      </table>
      <div class="cf-treatment">
        <div class="cf-title">COMMITMENT FEE — TREATMENT ON DEAL OUTCOME</div>
        ${adminConfig.cf_treatment_clause_html || FALLBACK_CF}
      </div>
      <div class="fee-note"><strong>Third-party costs</strong> (valuation, Lender's solicitors) are borne directly by the Borrower. Estimates provided at Term Sheet stage once valuer and solicitors are instructed.</div>
    </div>
  </div>

  <div class="page-footer">
    <div class="corp">
      <div class="legal-line"><strong>Daksfirst Limited</strong> · 8 Hill Street, Mayfair, London W1J 5NG</div>
      <div class="legal-line"><span class="label">Co. Reg</span> 11626401 · <span class="label">FCA</span> 937220 · portal@daksfirst.com</div>
      <div class="policies">T&Cs, AML & Privacy Policies — see website</div>
    </div>
    <div class="pnum">
      <div class="web">www.daksfirst.com</div>
      <div class="page-num">Page 2 of 3</div>
    </div>
  </div>
</div>

<!-- ══════════════════════════ PAGE 3 ══════════════════════════ -->
<div class="page">
  <div class="brand">
    <div class="brand-left">
      <img class="brand-logo" alt="Daksfirst" src="data:image/png;base64,${LOGO_B64}">
      <div class="brand-text">
        <div class="brand-name">DAKSFIRST</div>
        <div class="brand-tagline">Bridging Finance</div>
      </div>
    </div>
    <div class="brand-right">
      <div class="deal-ref">Deal Ref: ${esc(dealRef)}</div>
      <div class="issued">Page 3 of 3</div>
    </div>
  </div>

  <!-- CONDITIONS PRECEDENT -->
  <div class="section">
    <div class="section-bar">CONDITIONS PRECEDENT</div>
    <div class="section-body">
      <ol class="cp-list">
        <li>Satisfactory independent valuation (180-day OMV)</li>
        <li>Clear title search — no encumbrances</li>
        <li>Legal due diligence by Lender's solicitors</li>
        <li>First legal charge in favour of Lender</li>
        <li>Buildings insurance — Lender's interest noted</li>
        <li>Personal guarantee from UBO(s)</li>
        <li>Debenture over corporate assets</li>
        <li>KYC / AML documentation for all parties</li>
        <li>Evidence of source of deposit &amp; funds</li>
        <li>Payment of all applicable fees</li>
      </ol>
    </div>
  </div>

  <!-- NEXT STEPS -->
  <div class="section">
    <div class="section-bar">NEXT STEPS — TO PROCEED</div>
    <div class="section-body">
      <div class="ns-grid">
        <div class="ns-steps">
          <ol>
            <li>Remit the <strong>Onboarding / DIP Fee of ${fmtGBP(dipFee)}</strong> to the account on the right, quoting reference <strong>${esc(dealRef)}</strong>.</li>
            <li>On receipt, Daksfirst will commence <strong>credit review</strong> (typical turnaround 5–7 working days).</li>
            <li>On credit clearance, Daksfirst will issue a <strong>binding Term Sheet</strong> and instruct valuer &amp; solicitors.</li>
          </ol>
        </div>
        <div class="pay-box">
          <h4>PAYMENT DETAILS — DIP FEE</h4>
          <table>
            <tr><td>Account Name</td><td>Daksfirst Limited</td></tr>
            <tr><td>Bank</td><td>HSBC</td></tr>
            <tr><td>Account No</td><td>90300721</td></tr>
            <tr><td>Sort Code</td><td>40-02-45</td></tr>
            <tr><td>IBAN</td><td style="font-size:9px;">GB64HBUK40024590300721</td></tr>
            <tr><td>Reference</td><td>${esc(dealRef)}</td></tr>
          </table>
        </div>
      </div>
    </div>
  </div>

  <div class="notice">
    <div style="font-size:10.5px; margin-bottom:4px;">IMPORTANT NOTICE</div>
    <div style="font-weight:600; font-size:9px; line-height:1.55;">
      This Decision in Principle is indicative only and does not constitute a binding offer or commitment to lend. Final approval is subject to full underwriting, valuation, and credit committee approval. <span style="text-transform:uppercase;">You should not enter into any financial commitments based on this DIP. Seek independent legal advice before signing.</span>
    </div>
  </div>

  <div class="ack section">
    <div class="section-bar">EXECUTION &amp; ACKNOWLEDGEMENT</div>
    <div class="section-body">
      <div class="ack-content">By countersigning below, the Borrower acknowledges intention to proceed on the terms above. This DIP is valid for <strong>14 days</strong> from the date of issue.</div>
      <div class="${deal.broker_id ? 'ack-row' : 'ack-row-two'}">
        <div class="sig-card">
          <div class="sig-role">BORROWER</div>
          <div class="sig-entity">
            <div class="entity-name">${esc(deal.borrower_name || 'Borrower')}</div>
            <div class="entity-cap">The Borrower, by its duly authorised signatory and UBO</div>
          </div>
          <div class="sig-field"><div class="sig-label">Name</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Title</div><div class="sig-line"></div></div>
          <div class="sig-field sig-signature"><div class="sig-label">Signature</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Date &amp; Time</div><div class="sig-line"></div></div>
        </div>
        ${deal.broker_id ? `<div class="sig-card">
          <div class="sig-role">INTRODUCING BROKER</div>
          <div class="sig-entity">
            <div class="entity-name">${esc(brokerName)}</div>
            <div class="entity-cap">The Introducing Broker, by its duly authorised signatory</div>
          </div>
          <div class="sig-field"><div class="sig-label">Name</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Title</div><div class="sig-line"></div></div>
          <div class="sig-field sig-signature"><div class="sig-label">Signature</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Date &amp; Time</div><div class="sig-line"></div></div>
        </div>` : ''}
        <div class="sig-card">
          <div class="sig-role">LENDER</div>
          <div class="sig-entity">
            <div class="entity-name">Daksfirst Limited</div>
            <div class="entity-cap">For and on behalf of the Lender, as Originator and Security Agent</div>
          </div>
          <div class="sig-field"><div class="sig-label">Name</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Title</div><div class="sig-line"></div></div>
          <div class="sig-field sig-signature"><div class="sig-label">Signature</div><div class="sig-line"></div></div>
          <div class="sig-field"><div class="sig-label">Date &amp; Time</div><div class="sig-line"></div></div>
        </div>
      </div>
      <div class="ack-stamp">Electronic signatures via DocuSign apply the same legal effect as wet-ink signatures under the UK Electronic Communications Act 2000.</div>
    </div>
  </div>

  <div class="disclaimer">
    ${adminConfig.regulatory_disclosure_html || FALLBACK_REG}
  </div>

  <div class="page-footer">
    <div class="corp">
      <div class="legal-line"><strong>Daksfirst Limited</strong> · 8 Hill Street, Mayfair, London W1J 5NG</div>
      <div class="legal-line"><span class="label">Co. Reg</span> 11626401 · <span class="label">FCA</span> 937220 · portal@daksfirst.com</div>
      <div class="policies">T&Cs, AML & Privacy Policies — see website</div>
    </div>
    <div class="pnum">
      <div class="web">www.daksfirst.com</div>
      <div class="page-num">Page 3 of 3</div>
    </div>
  </div>
</div>

</body>
</html>`;
}


// ═══════════════════════════════════════════════════════════════════
// GENERATE DIP PDF — Puppeteer HTML-to-PDF
// ═══════════════════════════════════════════════════════════════════

async function generateDipPdf(deal, dipData = {}, options = {}) {
  console.log('[dip-pdf] TEMPLATE VERSION: v5.0 — generating PDF for', deal.submission_id);
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
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

module.exports = { generateDipPdf };
