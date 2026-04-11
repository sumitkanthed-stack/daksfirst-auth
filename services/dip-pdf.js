/**
 * DIP PDF Generator — Daksfirst Tight 1-Page Layout
 *
 * Generates a compact, professional Decision in Principle (DIP) PDF
 * that fits on 1-2 pages max. Matches the HTML preview design.
 *
 * - Navy header bar with white DF logo
 * - Gold divider
 * - Compact 2-column grids and tables
 * - Multiple sections: Borrower, Security Schedule, Loan Terms, Fees, etc.
 * - Footer on every page
 */

const PDFDocument = require('pdfkit');

// ── Embedded white DF hexagon logo (PNG, base64) ──
const LOGO_B64 = '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';

// ── Brand Colours ──
const NAVY    = '#1F3864';
const GOLD    = '#C9A227';
const WHITE   = '#FFFFFF';
const LGREY   = '#F8FAFC';
const LGREY2  = '#F3F4F6';
const MGREY   = '#6b7280';
const DGREY   = '#E5E7EB';
const BLACK   = '#000000';
const RED     = '#991b1b';
const REDBG   = '#fef2f2';
const AMBER   = '#fffbeb';
const BLUE    = '#eff6ff';
const TXT     = '#1a1a2e';
const MUTED   = '#555555';
const GREEN   = '#166534';

// ── Helper Functions ──

function money(val) {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return '—';
  return '£' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '—';
  return num.toFixed(2) + '%';
}

function clean(val) {
  if (val === null || val === undefined || val === '') return '—';
  return String(val).trim() || '—';
}

function humanize(val) {
  if (!val) return '—';
  return String(val)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function dealRefFromId(submissionId, createdAt) {
  if (!submissionId || !createdAt) return 'DF-XXXX-XXXX';
  const date = new Date(createdAt);
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const xxxx = String(submissionId).substring(0, 4).toUpperCase();
  return `DF-${yy}${mm}-${xxxx}`;
}

// ═══════════════════════════════════════════════════════════════════
// GENERATE DIP PDF
// ═══════════════════════════════════════════════════════════════════

async function generateDipPdf(deal, dipData = {}, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: false,
        info: {
          Title: 'Decision in Principle - ' + (deal.submission_id || 'Daksfirst'),
          Author: 'Daksfirst Limited',
          Subject: 'Decision in Principle',
          Creator: 'Daksfirst Portal'
        }
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      doc.addPage();

      // ── Page dimensions ──
      const pw = doc.page.width;  // 595
      const ph = doc.page.height; // 842
      const M = 40;               // side margin
      const W = pw - M * 2;       // content width ~515
      let y = 0;
      let pageNum = 1;

      // ── Deal reference ──
      const dealRef = dealRefFromId(deal.submission_id, deal.created_at);

      // ── Helper: check if page needs break ──
      function checkPage(needed) {
        if (y + needed > ph - 60) {
          addFooter(pageNum);
          doc.addPage();
          pageNum++;
          y = 45;
        }
      }

      // ── Helper: page footer ──
      function addFooter(pNum) {
        const fy = ph - 50;
        // Gold line
        doc.moveTo(M, fy).lineTo(M + W, fy).strokeColor(GOLD).lineWidth(2).stroke();
        // Footer text
        doc.font('Helvetica').fontSize(6).fillColor(MGREY);
        doc.text(
          'Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com',
          M, fy + 4, { width: W, align: 'center' }
        );
        doc.fontSize(6);
        doc.text(
          'This DIP is indicative only and does not constitute a formal offer. Subject to full underwriting, valuation & legal due diligence.',
          M, fy + 12, { width: W, align: 'center' }
        );
      }

      // ── Header Bar (navy, ~45px) ──
      doc.rect(0, 0, pw, 45).fill(NAVY);

      // Logo (embed on left)
      try {
        const logoBuf = Buffer.from(LOGO_B64, 'base64');
        doc.image(logoBuf, M, 7, { width: 32, height: 32 });
      } catch (e) {
        console.warn('[dip-pdf] Logo embedding failed:', e.message);
      }

      // Company name + tagline (center-left after logo)
      doc.font('Helvetica-Bold').fontSize(14).fillColor(WHITE);
      doc.text('DAKSFIRST', M + 38, 9, { width: 150 });
      doc.font('Helvetica').fontSize(8).fillColor(GOLD);
      doc.text('Bridging Finance, Built for Professionals', M + 38, 27, { width: 150 });

      // Contact info (right side)
      doc.font('Helvetica').fontSize(7).fillColor(WHITE);
      doc.text('8 Hill Street, Mayfair, London W1J 5NG', M + W - 140, 10, { width: 135, align: 'right' });
      doc.fontSize(7).fillColor(GOLD);
      doc.text('FCA 937220  |  portal@daksfirst.com', M + W - 140, 26, { width: 135, align: 'right' });

      y = 48;

      // ── Gold divider ──
      doc.moveTo(0, y).lineTo(pw, y).strokeColor(GOLD).lineWidth(3).stroke();
      y += 6;

      // ── Title + Tagline ──
      doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY);
      doc.text('DECISION IN PRINCIPLE', M, y, { width: W, align: 'center' });
      y += 16;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MGREY);
      doc.text('Senior Secured Real Estate Credit & Structured Finance', M, y, { width: W, align: 'center' });
      y += 10;

      // ── Reference strip ──
      checkPage(14);
      doc.rect(0, y, pw, 12).fill(LGREY).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
      doc.text(dealRef, M + 8, y + 1, { width: 100 });
      doc.font('Helvetica').fontSize(8).fillColor(MGREY);
      const issueDate = options.issuedAt
        ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.text('Issued: ' + issueDate, M + W / 2 - 40, y + 2, { width: 80, align: 'center' });

      const bType = (deal.borrower_type || 'individual').toLowerCase();
      const isCorp = bType === 'corporate' || bType === 'spv' || bType === 'ltd' || bType === 'llp';
      const badgeText = isCorp ? 'CORPORATE SPV' : 'INDIVIDUAL';
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text(badgeText, M + W - 120, y + 3, { width: 110, align: 'right' });

      y += 14;

      // ── BORROWER DETAILS ──
      checkPage(50);
      sectionBar('BORROWER DETAILS', y);
      y += 14;

      // 2-column grid: Corporate (blue) | UBO (amber)
      const cellH = 28;
      const cellW = (W - 4) / 2;

      // Left: Corporate
      doc.rect(M, y, cellW, cellH).fill(BLUE).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
      doc.text('CORPORATE ENTITY', M + 6, y + 2, { width: cellW - 12 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
      doc.text(clean(deal.borrower_company || deal.company_name), M + 6, y + 10, { width: cellW - 12 });
      doc.font('Helvetica').fontSize(7).fillColor(MGREY);
      doc.text('Co. No: ' + clean(deal.company_number), M + 6, y + 20, { width: cellW - 12 });

      // Right: UBO
      doc.rect(M + cellW + 4, y, cellW, cellH).fill(AMBER).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
      doc.text('ULTIMATE BENEFICIAL OWNER', M + cellW + 10, y + 2, { width: cellW - 12 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
      doc.text(clean(deal.borrower_name), M + cellW + 10, y + 10, { width: cellW - 12 });
      doc.font('Helvetica').fontSize(7).fillColor(MGREY);
      const contactInfo = clean(deal.borrower_email) + ' • ' + clean(deal.borrower_phone);
      doc.text(contactInfo.replace('— • —', '—'), M + cellW + 10, y + 20, { width: cellW - 12 });

      y += cellH + 4;

      // If borrowers array, add Parties sub-table
      if (dipData.borrowers && dipData.borrowers.length > 1) {
        checkPage(40);
        doc.rect(M, y, W, 2).fill(LGREY2);
        y += 2;
        doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
        doc.text('PARTIES TO THE DIP', M + 6, y, { width: W - 12 });
        y += 10;

        // Mini table: Name | Role | KYC
        dipData.borrowers.forEach((bor, idx) => {
          const rowBg = idx % 2 === 0 ? WHITE : LGREY2;
          doc.rect(M, y, W, 8).fill(rowBg);
          doc.font('Helvetica').fontSize(7).fillColor(TXT);
          doc.text(clean(bor.name), M + 6, y + 2, { width: W / 3 });
          doc.text(bor.role || '—', M + W / 3 + 6, y + 2, { width: W / 3 });
          doc.text(bor.kyc_verified ? 'Verified' : 'Pending', M + 2 * W / 3 + 6, y + 2, { width: W / 3 - 12 });
          y += 8;
        });
        y += 4;
      }

      // ── SECURITY SCHEDULE ──
      checkPage(80);
      sectionBar('SECURITY SCHEDULE', y);
      y += 14;

      // Parse security address & postcode (semicolon-separated)
      const addresses = (deal.security_address || '').split(';').filter(a => a.trim());
      const postcodes = (deal.security_postcode || '').split(',').filter(p => p.trim());

      // Property table header
      const tableColWidths = [20, W * 0.45, 60, 80];
      doc.rect(M, y, W, 8).fill(LGREY2);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
      doc.text('#', M + 2, y + 1, { width: 18 });
      doc.text('ADDRESS', M + 22, y + 1, { width: tableColWidths[1] - 4 });
      doc.text('POSTCODE', M + tableColWidths[0] + tableColWidths[1] + 4, y + 1, { width: 58 });
      doc.text('VALUATION', M + tableColWidths[0] + tableColWidths[1] + 62 + 2, y + 1, { width: 76, align: 'right' });
      y += 8;

      // Property rows
      let totalVal = 0;
      addresses.forEach((addr, idx) => {
        const postcode = postcodes[idx] || '—';
        const val = dipData.property_values && dipData.property_values[idx]
          ? dipData.property_values[idx]
          : (idx === 0 && dipData.property_value ? dipData.property_value : 0);
        totalVal += parseFloat(val || 0);

        const rowBg = idx % 2 === 0 ? WHITE : LGREY2;
        doc.rect(M, y, W, 10).fill(rowBg);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT);
        doc.text(String(idx + 1), M + 2, y + 2, { width: 18 });
        doc.font('Helvetica').fontSize(7).fillColor(TXT);
        doc.text(clean(addr.trim()), M + 22, y + 2, { width: tableColWidths[1] - 4 });
        doc.text(clean(postcode.trim()), M + tableColWidths[0] + tableColWidths[1] + 4, y + 2, { width: 58 });
        doc.text(money(val), M + tableColWidths[0] + tableColWidths[1] + 62 + 2, y + 2, { width: 76, align: 'right' });
        y += 10;
      });

      // Total row
      doc.rect(M, y, W, 8).fill(BLUE);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('TOTAL PORTFOLIO VALUATION', M + tableColWidths[0] + tableColWidths[1] + 4, y + 1, { width: 118 });
      doc.text(money(totalVal || dipData.property_value), M + tableColWidths[0] + tableColWidths[1] + 62 + 2, y + 1, { width: 76, align: 'right' });
      y += 8;
      y += 4;

      // Asset detail grid below property table
      checkPage(22);
      const assetH = 5.5;
      const assetW = (W - 2) / 2;
      const assetDetails = [
        ['ASSET TYPE', humanize(deal.asset_type)],
        ['TENURE', clean(deal.property_tenure)],
        ['PURCHASE PRICE', money(deal.purchase_price)],
        ['CURRENT USE / OCCUPANCY', clean(deal.current_use || deal.occupancy_status)]
      ];

      assetDetails.forEach((item, idx) => {
        const row = Math.floor(idx / 2);
        const col = idx % 2;
        const cellX = M + col * (assetW + 2);
        const cellY = y + row * (assetH + 0.5);

        const isBg = idx % 2 === 1;
        doc.rect(cellX, cellY, assetW, assetH).fill(isBg ? LGREY : WHITE).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text(item[0], cellX + 3, cellY + 0.5, { width: assetW - 6 });
        doc.font('Helvetica').fontSize(7).fillColor(TXT);
        doc.text(clean(item[1]), cellX + 3, cellY + 3, { width: assetW - 6 });
      });
      y += 12;
      y += 3;

      // ── INDICATIVE LOAN TERMS ──
      checkPage(60);
      sectionBar('INDICATIVE LOAN TERMS', y);
      y += 14;

      const loanTerms = [
        ['GROSS LOAN AMOUNT', money(dipData.loan_amount || deal.loan_amount), true],
        ['LTV', pct(dipData.ltv || deal.ltv_requested), true],
        ['TERM', clean(dipData.term_months || deal.term_months) + ' months', false],
        ['INTEREST RATE', pct(dipData.rate_monthly || deal.rate_requested) + ' per month', false],
        ['INTEREST SERVICING', clean(dipData.interest_servicing || 'Retained'), false],
        ['RETAINED PERIOD', (dipData.retained_months || '—') + ' months', false],
        ['EXIT STRATEGY', clean(dipData.exit_strategy || deal.exit_strategy), false],
        ['LOAN PURPOSE', clean(deal.loan_purpose), false]
      ];

      loanTerms.forEach((item, idx) => {
        const row = Math.floor(idx / 2);
        const col = idx % 2;
        const cellX = M + col * (assetW + 2);
        const cellY = y + row * 10;

        const highlight = item[2] === true;
        const bg = highlight ? BLUE : (idx % 2 === 1 ? LGREY : WHITE);
        doc.rect(cellX, cellY, assetW, 10).fill(bg).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text(item[0], cellX + 3, cellY + 1, { width: assetW - 6 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(highlight ? NAVY : TXT);
        doc.text(clean(item[1]), cellX + 3, cellY + 4.5, { width: assetW - 6 });
      });
      y += 40 + 4;

      // ── TWO-COLUMN: SECURITY & GUARANTEES | CONDITIONS PRECEDENT ──
      checkPage(100);
      const colW = (W - 4) / 2;

      // LEFT: Security & Guarantees
      sectionBarPos('SECURITY & GUARANTEES', M, y, colW);
      y += 12;

      const secItems = [
        ['FIRST LEGAL CHARGE', clean(deal.security_address ? 'Over all ' + addresses.length + ' properties' : 'Over the security property')],
        ['DEBENTURE', isCorp ? 'Required (corporate borrower)' : 'N/A'],
        ['PERSONAL GUARANTEE', isCorp ? 'Required from UBO' : 'N/A']
      ];

      secItems.forEach((item, idx) => {
        const bg = idx % 2 === 0 ? WHITE : LGREY2;
        doc.rect(M, y, colW, 10).fill(bg).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text(item[0], M + 3, y + 1, { width: colW - 6 });
        doc.font('Helvetica').fontSize(7).fillColor(TXT);
        doc.text(clean(item[1]), M + 3, y + 4.5, { width: colW - 6 });
        y += 10;
      });

      // RIGHT: Conditions Precedent (overlapping y)
      y -= 30;
      sectionBarPos('CONDITIONS PRECEDENT', M + colW + 4, y, colW);
      y += 12;

      const conditions = [
        'Satisfactory independent valuation',
        'Clear title search — no encumbrances',
        'Legal due diligence by Lender\'s solicitors',
        'First legal charge in favour of Lender',
        'Buildings insurance — Lender\'s interest noted',
        'Personal guarantee from UBO',
        'KYC/AML documentation for all parties',
        'Evidence of source of deposit & funds',
        'Payment of all applicable fees'
      ];

      conditions.forEach((c, idx) => {
        const bg = idx % 2 === 0 ? WHITE : LGREY2;
        doc.rect(M + colW + 4, y, colW, 9).fill(bg).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(NAVY);
        doc.text((idx + 1) + '.', M + colW + 7, y + 1.5, { width: 10 });
        doc.font('Helvetica').fontSize(6.5).fillColor(TXT);
        doc.text(c, M + colW + 20, y + 1.5, { width: colW - 23 });
        y += 9;
      });

      y += 4;

      // ── FEE SCHEDULE ──
      checkPage(80);
      sectionBar('FEE SCHEDULE', y);
      y += 14;

      const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);

      // Fee table header
      doc.rect(M, y, W, 8).fill(LGREY2);
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MGREY);
      doc.text('FEE', M + 3, y + 1.5, { width: 100 });
      doc.text('AMOUNT', M + 110, y + 1.5, { width: 80 });
      doc.text('WHEN DUE', M + 200, y + 1.5, { width: 90 });
      doc.text('PAYMENT', M + 300, y + 1.5, { width: W - 310 });
      y += 8;

      const fees = [
        ['Onboarding Fee', money(dipData.fee_onboarding || 0), 'After DIP acceptance', 'Before Credit Review', false],
        ['Commitment Fee', money(dipData.fee_commitment || 0), 'After Termsheet', 'Before Underwriting', false],
        ['Arrangement Fee', feeLine(dipData.arrangement_fee, loanAmt), 'On completion', 'Deducted from advance', true],
        ['  └─ of which Broker', feeLine(dipData.broker_fee, loanAmt), 'On completion', 'From arrangement fee', true],
        ['Exit Fee', pct(1.00) + ' of loan', 'On redemption', 'Payable on exit', false],
        ['Extension Fee', pct(1.00) + ' of loan', 'If term extended', 'Per extension period', false]
      ];

      fees.forEach((f, idx) => {
        const bg = f[4] ? AMBER : (idx % 2 === 0 ? WHITE : LGREY2);
        doc.rect(M, y, W, 8).fill(bg);
        doc.font(f[4] ? 'Helvetica' : 'Helvetica-Bold').fontSize(6.5).fillColor(TXT);
        doc.text(f[0], M + 3, y + 1.5, { width: 107 });
        doc.font('Helvetica').fontSize(6.5).fillColor(TXT);
        doc.text(f[1], M + 110, y + 1.5, { width: 90 });
        doc.text(f[2], M + 200, y + 1.5, { width: 100 });
        doc.text(f[3], M + 300, y + 1.5, { width: W - 310 });
        y += 8;
      });
      y += 4;

      // ── THIRD-PARTY COSTS ──
      checkPage(50);
      sectionBar('ESTIMATED THIRD-PARTY COSTS', y, MGREY);
      y += 14;

      doc.font('Helvetica-Oblique').fontSize(7).fillColor(MGREY);
      doc.text('These are not Daksfirst fees. Third-party costs borne by borrower, disclosed for budgeting only.', M + 3, y, { width: W - 6 });
      y += 12;

      const tpCosts = [
        ['Valuation Fee', money(dipData.valuation_cost || 0), 'Paid directly by client to valuer'],
        ['Legal Fee', money(dipData.legal_cost || 0), 'Via undertaking from client\'s solicitors']
      ];

      tpCosts.forEach((c, idx) => {
        const bg = idx % 2 === 0 ? WHITE : LGREY2;
        doc.rect(M, y, W, 8).fill(bg);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(TXT);
        doc.text(c[0], M + 3, y + 1.5, { width: 100 });
        doc.font('Helvetica').fontSize(6.5).fillColor(TXT);
        doc.text(c[1], M + 110, y + 1.5, { width: 80 });
        doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
        doc.text(c[2], M + 200, y + 1.5, { width: W - 210 });
        y += 8;
      });
      y += 6;

      // ── PAYMENT DETAILS ──
      checkPage(50);
      sectionBar('HOW TO PROCEED — PAYMENT DETAILS', y, GREEN);
      y += 14;

      // 2-column: instructions | bank details
      const instructH = 22;
      doc.rect(M, y, (W - 2) / 2, instructH).fill(WHITE).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('To proceed, remit the Onboarding/DIP Fee below. Quote the deal reference as payment reference.', M + 3, y + 2, { width: (W - 2) / 2 - 6 });
      doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
      doc.text('Upon receipt, Daksfirst will commence credit review.', M + 3, y + 13, { width: (W - 2) / 2 - 6 });

      // Bank details
      doc.rect(M + (W - 2) / 2 + 2, y, (W - 2) / 2, instructH).fill(LGREY).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica').fontSize(6.5).fillColor(MGREY);
      const bankLines = [
        ['Account Name:', 'Daksfirst Limited'],
        ['Bank:', 'HSBC'],
        ['Account No:', '90300721'],
        ['Sort Code:', '40-02-45'],
        ['IBAN:', 'GB64HBUK40024590300721'],
        ['Reference:', dealRef]
      ];
      let by = y + 2;
      bankLines.forEach(line => {
        doc.text(line[0], M + (W - 2) / 2 + 5, by, { width: 70 });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY);
        doc.text(line[1], M + (W - 2) / 2 + 75, by, { width: (W - 2) / 2 - 80 });
        doc.font('Helvetica').fontSize(6.5).fillColor(MGREY);
        by += 3.5;
      });

      y += instructH + 4;

      // ── RED NOTICE BOX ──
      checkPage(20);
      doc.rect(M, y, W, 16).fill(REDBG).stroke({ color: '#fca5a5', width: 1 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED);
      doc.text('IMPORTANT NOTICE: This Decision in Principle is indicative only and does not constitute a binding offer or commitment to lend. Final approval is subject to full underwriting, valuation and credit committee approval.', M + 4, y + 2, { width: W - 8, align: 'center' });
      y += 18;

      // ── BORROWER ACKNOWLEDGEMENT ──
      checkPage(24);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
      doc.text('BORROWER ACKNOWLEDGEMENT', M, y, { width: W });
      y += 8;
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('By accepting this DIP, the Borrower acknowledges intention to proceed on the terms above. This DIP is valid for 14 days from the date of issue.', M, y, { width: W });
      y += 12;

      // ── SIGNATURE BLOCK ──
      checkPage(28);
      const sigW = (W - 4) / 2;

      // Borrower signature
      doc.moveTo(M, y + 14).lineTo(M + sigW, y + 14).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('Borrower Signature', M, y + 16);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text(clean(deal.borrower_name), M, y + 22);
      doc.text(clean(deal.borrower_company || deal.company_name), M, y + 27);

      // Lender signature
      const sigX2 = M + sigW + 4;
      doc.moveTo(sigX2, y + 14).lineTo(sigX2 + sigW, y + 14).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('For and on behalf of the Lender', sigX2, y + 16);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('Daksfirst Bridging 1 Ltd', sigX2, y + 22);

      y += 32;

      // ── FCA DISCLAIMER ──
      checkPage(8);
      doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
      doc.text('Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.', M, y, { width: W, align: 'center' });

      // ── Add footer ──
      addFooter(pageNum);

      doc.end();

      // ── Helper: section bar (with optional bg color) ──
      function sectionBar(text, yPos, bgColor = NAVY) {
        doc.rect(M, yPos, W, 12).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE);
        doc.text(text.toUpperCase(), M + 4, yPos + 2, { width: W - 8 });
      }

      function sectionBarPos(text, xPos, yPos, width, bgColor = NAVY) {
        doc.rect(xPos, yPos, width, 12).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE);
        doc.text(text.toUpperCase(), xPos + 4, yPos + 2, { width: width - 8 });
      }

      function feeLine(raw, loanAmt) {
        const v = parseFloat(raw || 0);
        if (isNaN(v) || v === 0) return '—';
        if (v > 0 && v < 50) return money(Math.round(loanAmt * v / 100)) + ' (' + v.toFixed(2) + '%)';
        return money(v);
      }

    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDipPdf };
