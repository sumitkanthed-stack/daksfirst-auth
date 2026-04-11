/**
 * DIP PDF Generator — Daksfirst
 *
 * Fully dynamic, data-driven layout.
 * Handles any deal shape: variable property counts, borrower types,
 * missing fields, long text, and automatic page breaks.
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
const RED     = '#991b1b';
const REDBG   = '#fef2f2';
const AMBER   = '#fffbeb';
const BLUE    = '#eff6ff';
const TXT     = '#1a1a2e';
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

function feeLine(raw, loanAmt) {
  const v = parseFloat(raw || 0);
  if (isNaN(v) || v === 0) return '—';
  // Treat values under 50 as percentages
  if (v > 0 && v < 50) return money(Math.round(loanAmt * v / 100)) + ' (' + v.toFixed(2) + '%)';
  return money(v);
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
      const pw = doc.page.width;   // 595
      const ph = doc.page.height;  // 842
      const M = 40;                // side margin
      const W = pw - M * 2;       // content width ~515
      const FOOTER_ZONE = 55;     // reserved for footer
      let y = 0;
      let pageNum = 1;

      // ── Deal reference ──
      const dealRef = dealRefFromId(deal.submission_id, deal.created_at);

      // ── Borrower type ──
      const bType = (deal.borrower_type || 'individual').toLowerCase();
      const isCorp = ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes(bType);

      // ── Parse addresses ──
      const addresses = (deal.security_address || '').split(';').filter(a => a.trim());
      const postcodes = (deal.security_postcode || '').split(',').filter(p => p.trim());

      // ── Loan amount (used in fees) ──
      const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);

      // ────────────────────────────────────────────────────
      // REUSABLE DRAWING HELPERS
      // ────────────────────────────────────────────────────

      /** Check if `needed` px fits, else new page */
      function checkPage(needed) {
        if (y + needed > ph - FOOTER_ZONE) {
          addFooter(pageNum);
          doc.addPage();
          pageNum++;
          y = 20;
        }
      }

      /** Draw page footer */
      function addFooter(pNum) {
        const fy = ph - 50;
        doc.moveTo(M, fy).lineTo(M + W, fy).strokeColor(GOLD).lineWidth(2).stroke();
        doc.font('Helvetica').fontSize(6).fillColor(MGREY);
        doc.text(
          'Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com',
          M, fy + 4, { width: W, align: 'center' }
        );
        doc.text(
          'This DIP is indicative only and does not constitute a formal offer. Subject to full underwriting, valuation & legal due diligence.',
          M, fy + 12, { width: W, align: 'center' }
        );
      }

      /** Full-width section bar */
      function sectionBar(text, bgColor) {
        bgColor = bgColor || NAVY;
        checkPage(14);
        doc.rect(M, y, W, 12).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE);
        doc.text(text.toUpperCase(), M + 4, y + 2, { width: W - 8 });
        y += 13;
      }

      /** Partial-width section bar at specific X */
      function sectionBarAt(text, xPos, width, bgColor) {
        bgColor = bgColor || NAVY;
        doc.rect(xPos, y, width, 12).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE);
        doc.text(text.toUpperCase(), xPos + 4, y + 2, { width: width - 8 });
      }

      /**
       * Draw a 2-column key/value grid from an array.
       * items: [[label, value, highlight?], ...]
       * Returns nothing — advances y automatically.
       */
      function drawGrid(items, cellH) {
        cellH = cellH || 14;
        const halfW = (W - 2) / 2;
        const rows = Math.ceil(items.length / 2);
        checkPage(rows * cellH + 4);

        items.forEach((item, idx) => {
          const row = Math.floor(idx / 2);
          const col = idx % 2;
          const cx = M + col * (halfW + 2);
          const cy = y + row * cellH;
          const highlight = item[2] === true;
          const bg = highlight ? BLUE : (col === 1 ? LGREY : WHITE);

          doc.rect(cx, cy, halfW, cellH).fill(bg).stroke({ color: DGREY, width: 0.5 });
          doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
          doc.text(item[0], cx + 4, cy + 1, { width: halfW - 8 });
          doc.font('Helvetica-Bold').fontSize(highlight ? 8.5 : 7.5).fillColor(highlight ? NAVY : TXT);
          doc.text(clean(item[1]), cx + 4, cy + 7, { width: halfW - 8 });
        });

        y += rows * cellH + 4;
      }

      /**
       * Draw a table from an array of row arrays.
       * cols: [{label, width, align?}]  rows: [[val, val, ...]]
       * Options: headerBg, rowH, highlightFn(rowIdx, rowData)
       */
      function drawTable(cols, rows, opts) {
        opts = opts || {};
        const rowH = opts.rowH || 9;
        const headerH = opts.headerH || 9;

        // Header
        checkPage(headerH + rowH * Math.min(rows.length, 3));
        doc.rect(M, y, W, headerH).fill(opts.headerBg || LGREY2);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MGREY);
        let cx = M;
        cols.forEach(col => {
          doc.text(col.label, cx + 3, y + 1.5, { width: col.width - 6, align: col.align || 'left' });
          cx += col.width;
        });
        y += headerH;

        // Rows
        rows.forEach((row, ridx) => {
          checkPage(rowH);
          const highlight = opts.highlightFn ? opts.highlightFn(ridx, row) : false;
          const bg = highlight ? AMBER : (ridx % 2 === 0 ? WHITE : LGREY2);
          doc.rect(M, y, W, rowH).fill(bg);

          cx = M;
          row.forEach((val, cidx) => {
            const col = cols[cidx];
            const isFirst = cidx === 0;
            doc.font(isFirst && !highlight ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5).fillColor(TXT);
            doc.text(String(val), cx + 3, y + 1.5, { width: col.width - 6, align: col.align || 'left' });
            cx += col.width;
          });
          y += rowH;
        });
      }


      // ════════════════════════════════════════════════════
      //  PAGE CONTENT
      // ════════════════════════════════════════════════════

      // ── HEADER BAR ──
      doc.rect(0, 0, pw, 45).fill(NAVY);
      try {
        const logoBuf = Buffer.from(LOGO_B64, 'base64');
        doc.image(logoBuf, M, 7, { width: 32, height: 32 });
      } catch (e) { /* logo failed, continue */ }

      doc.font('Helvetica-Bold').fontSize(14).fillColor(WHITE);
      doc.text('DAKSFIRST', M + 38, 9, { width: 150 });
      doc.font('Helvetica').fontSize(8).fillColor(GOLD);
      doc.text('Bridging Finance, Built for Professionals', M + 38, 27, { width: 200 });

      doc.font('Helvetica').fontSize(7).fillColor(WHITE);
      doc.text('8 Hill Street, Mayfair, London W1J 5NG', M + W - 145, 10, { width: 140, align: 'right' });
      doc.fontSize(7).fillColor(GOLD);
      doc.text('FCA 937220  |  portal@daksfirst.com', M + W - 145, 26, { width: 140, align: 'right' });

      y = 48;

      // ── GOLD DIVIDER ──
      doc.moveTo(0, y).lineTo(pw, y).strokeColor(GOLD).lineWidth(3).stroke();
      y += 6;

      // ── TITLE ──
      doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY);
      doc.text('DECISION IN PRINCIPLE', M, y, { width: W, align: 'center' });
      y += 16;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MGREY);
      doc.text('Senior Secured Real Estate Credit & Structured Finance', M, y, { width: W, align: 'center' });
      y += 12;

      // ── REFERENCE STRIP ──
      checkPage(14);
      doc.rect(0, y, pw, 12).fill(LGREY).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
      doc.text(dealRef, M + 8, y + 1, { width: 100 });

      doc.font('Helvetica').fontSize(8).fillColor(MGREY);
      const issueDate = options.issuedAt
        ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.text('Issued: ' + issueDate, M + W / 2 - 50, y + 2, { width: 100, align: 'center' });

      const badgeText = isCorp ? 'CORPORATE SPV' : 'INDIVIDUAL';
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text(badgeText, M + W - 120, y + 3, { width: 110, align: 'right' });
      y += 15;


      // ══════════════════════════════════════════════
      //  1. BORROWER DETAILS
      // ══════════════════════════════════════════════
      sectionBar('BORROWER DETAILS');

      const halfW = (W - 4) / 2;
      const bCellH = 30;
      checkPage(bCellH + 6);

      if (isCorp) {
        // Left: Corporate
        doc.rect(M, y, halfW, bCellH).fill(BLUE).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text('CORPORATE ENTITY', M + 6, y + 2, { width: halfW - 12 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_company || deal.company_name), M + 6, y + 10, { width: halfW - 12 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        doc.text('Co. No: ' + clean(deal.company_number), M + 6, y + 21, { width: halfW - 12 });

        // Right: UBO
        doc.rect(M + halfW + 4, y, halfW, bCellH).fill(AMBER).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text('ULTIMATE BENEFICIAL OWNER', M + halfW + 10, y + 2, { width: halfW - 16 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_name), M + halfW + 10, y + 10, { width: halfW - 16 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        const contact = [clean(deal.borrower_email), clean(deal.borrower_phone)].filter(v => v !== '—').join(' • ') || '—';
        doc.text(contact, M + halfW + 10, y + 21, { width: halfW - 16 });
      } else {
        // Individual — full width
        doc.rect(M, y, W, bCellH).fill(BLUE).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text('BORROWER', M + 6, y + 2, { width: W - 12 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_name), M + 6, y + 10, { width: W - 12 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        const contact = [clean(deal.borrower_email), clean(deal.borrower_phone)].filter(v => v !== '—').join(' • ') || '—';
        doc.text(contact, M + 6, y + 21, { width: W - 12 });
      }
      y += bCellH + 3;

      // Parties sub-table (only if multiple borrowers)
      if (dipData.borrowers && dipData.borrowers.length > 1) {
        checkPage(12 + dipData.borrowers.length * 9);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
        doc.text('PARTIES TO THE DIP', M + 6, y, { width: W - 12 });
        y += 10;

        dipData.borrowers.forEach((bor, idx) => {
          checkPage(9);
          doc.rect(M, y, W, 8).fill(idx % 2 === 0 ? WHITE : LGREY2);
          doc.font('Helvetica').fontSize(7).fillColor(TXT);
          doc.text(clean(bor.name), M + 6, y + 1, { width: W / 3 });
          doc.text(bor.role || '—', M + W / 3 + 6, y + 1, { width: W / 3 });
          doc.text(bor.kyc_verified ? 'Verified' : 'Pending', M + 2 * W / 3 + 6, y + 1, { width: W / 3 - 12 });
          y += 8;
        });
        y += 3;
      }


      // ══════════════════════════════════════════════
      //  2. SECURITY SCHEDULE
      // ══════════════════════════════════════════════
      sectionBar('SECURITY SCHEDULE');

      // Property table — dynamic rows
      const totalPropertyVal = parseFloat(dipData.property_value || deal.property_value || deal.estimated_value || 0);
      const propCols = [
        { label: '#', width: 22 },
        { label: 'ADDRESS', width: W * 0.45 },
        { label: 'POSTCODE', width: 65 },
        { label: 'VALUATION', width: W - 22 - W * 0.45 - 65, align: 'right' }
      ];

      const propRows = [];
      let totalVal = 0;
      if (addresses.length > 0) {
        addresses.forEach((addr, idx) => {
          const pc = postcodes[idx] || '—';
          let val;
          if (dipData.property_values && dipData.property_values[idx]) {
            val = parseFloat(dipData.property_values[idx]);
          } else if (addresses.length === 1) {
            val = totalPropertyVal;
          } else {
            // Split evenly — last property gets remainder so total is exact
            const perProp = Math.floor(totalPropertyVal / addresses.length);
            val = (idx === addresses.length - 1) ? totalPropertyVal - perProp * (addresses.length - 1) : perProp;
          }
          totalVal += val;
          propRows.push([String(idx + 1), clean(addr.trim()), clean(pc.trim()), money(val)]);
        });
      } else {
        // No addresses parsed — show single row with whatever data we have
        totalVal = totalPropertyVal;
        propRows.push(['1', clean(deal.security_address || 'TBC'), clean(deal.security_postcode || '—'), money(totalPropertyVal)]);
      }

      drawTable(propCols, propRows, { rowH: 10 });

      // Total row
      checkPage(10);
      doc.rect(M, y, W, 9).fill(BLUE);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('TOTAL PORTFOLIO VALUATION', M + 6, y + 1.5, { width: W * 0.6 });
      doc.text(money(totalVal || totalPropertyVal), M + W * 0.6, y + 1.5, { width: W * 0.4 - 6, align: 'right' });
      y += 11;

      // Asset details grid — dynamic
      const assetItems = [
        ['ASSET TYPE', humanize(deal.asset_type)],
        ['TENURE', humanize(deal.property_tenure)],
        ['PURCHASE PRICE', money(deal.purchase_price)],
        ['CURRENT USE / OCCUPANCY', clean(deal.current_use || deal.occupancy_status)]
      ].filter(item => item[1] !== '—'); // only show fields that have data

      if (assetItems.length > 0) drawGrid(assetItems, 14);


      // ══════════════════════════════════════════════
      //  3. INDICATIVE LOAN TERMS
      // ══════════════════════════════════════════════
      sectionBar('INDICATIVE LOAN TERMS');

      const loanTermItems = [
        ['GROSS LOAN AMOUNT', money(dipData.loan_amount || deal.loan_amount), true],
        ['LTV', pct(dipData.ltv || deal.ltv_requested), true],
        ['TERM', clean(dipData.term_months || deal.term_months) + ' months', false],
        ['INTEREST RATE', pct(dipData.rate_monthly || deal.rate_requested) + ' per month', false],
        ['INTEREST SERVICING', clean(dipData.interest_servicing || 'Retained'), false],
        ['RETAINED PERIOD', clean(dipData.retained_months || '—') + ' months', false],
        ['EXIT STRATEGY', clean(dipData.exit_strategy || deal.exit_strategy), false],
        ['LOAN PURPOSE', clean(deal.loan_purpose), false]
      ];

      drawGrid(loanTermItems, 14);


      // ══════════════════════════════════════════════
      //  4. SECURITY & GUARANTEES | CONDITIONS PRECEDENT (side-by-side)
      // ══════════════════════════════════════════════

      // Build both arrays first so we can compute height
      const secItems = [
        ['FIRST LEGAL CHARGE', addresses.length > 1 ? 'Over all ' + addresses.length + ' properties' : 'Over the security property'],
        ['DEBENTURE', isCorp ? 'Required (corporate borrower)' : 'N/A'],
        ['PERSONAL GUARANTEE', isCorp ? 'Required from UBO' : 'N/A']
      ];

      const cpItems = [
        'Satisfactory independent valuation',
        'Clear title search — no encumbrances',
        'Legal due diligence by Lender\'s solicitors',
        'First legal charge in favour of Lender',
        'Buildings insurance — Lender\'s interest noted'
      ];
      if (isCorp) {
        cpItems.push('Personal guarantee from UBO');
        cpItems.push('Debenture over corporate assets');
      }
      cpItems.push('KYC/AML documentation for all parties');
      cpItems.push('Evidence of source of deposit & funds');
      cpItems.push('Payment of all applicable fees');

      const secRowH = 11;
      const cpRowH = 9;
      const leftHeight = 12 + secItems.length * secRowH;
      const rightHeight = 12 + cpItems.length * cpRowH;
      const sideBySideH = Math.max(leftHeight, rightHeight);
      const colW = (W - 4) / 2;

      checkPage(sideBySideH + 4);
      const sby = y; // anchor Y

      // LEFT: Security
      sectionBarAt('SECURITY & GUARANTEES', M, colW);
      let ly = sby + 12;
      secItems.forEach((item, idx) => {
        doc.rect(M, ly, colW, secRowH).fill(idx % 2 === 0 ? WHITE : LGREY2).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text(item[0], M + 3, ly + 1, { width: colW - 6 });
        doc.font('Helvetica').fontSize(7).fillColor(TXT);
        doc.text(clean(item[1]), M + 3, ly + 5, { width: colW - 6 });
        ly += secRowH;
      });

      // RIGHT: CPs
      sectionBarAt('CONDITIONS PRECEDENT', M + colW + 4, colW);
      let ry = sby + 12;
      cpItems.forEach((c, idx) => {
        doc.rect(M + colW + 4, ry, colW, cpRowH).fill(idx % 2 === 0 ? WHITE : LGREY2).stroke({ color: DGREY, width: 0.5 });
        doc.font('Helvetica-Bold').fontSize(6).fillColor(NAVY);
        doc.text((idx + 1) + '.', M + colW + 7, ry + 1.5, { width: 12 });
        doc.font('Helvetica').fontSize(6.5).fillColor(TXT);
        doc.text(c, M + colW + 20, ry + 1.5, { width: colW - 23 });
        ry += cpRowH;
      });

      y = Math.max(ly, ry) + 4;


      // ══════════════════════════════════════════════
      //  5. FEE SCHEDULE
      // ══════════════════════════════════════════════
      sectionBar('FEE SCHEDULE');

      const arrFee = parseFloat(dipData.arrangement_fee || deal.arrangement_fee || 2);
      const brkFee = parseFloat(dipData.broker_fee || deal.broker_fee || 1);

      const feeCols = [
        { label: 'FEE', width: 110 },
        { label: 'AMOUNT', width: 95 },
        { label: 'WHEN DUE', width: 105 },
        { label: 'PAYMENT', width: W - 310 }
      ];
      const feeRows = [
        ['Onboarding Fee',   money(dipData.fee_onboarding || 0), 'After DIP acceptance', 'Before Credit Review'],
        ['Commitment Fee',   money(dipData.fee_commitment || 0), 'After Termsheet',      'Before Underwriting'],
        ['Arrangement Fee',  feeLine(arrFee, loanAmt),           'On completion',         'Deducted from advance'],
        ['    of which Broker', feeLine(brkFee, loanAmt),       'On completion',         'From arrangement fee'],
        ['Exit Fee',         pct(1.00) + ' of loan',             'On redemption',         'Payable on exit'],
        ['Extension Fee',    pct(1.00) + ' of loan',             'If term extended',      'Per extension period']
      ];

      drawTable(feeCols, feeRows, {
        rowH: 9,
        highlightFn: (idx) => idx === 2 || idx === 3
      });
      y += 2;


      // ══════════════════════════════════════════════
      //  6. THIRD-PARTY COSTS
      // ══════════════════════════════════════════════
      sectionBar('ESTIMATED THIRD-PARTY COSTS', MGREY);

      doc.font('Helvetica-Oblique').fontSize(7).fillColor(MGREY);
      doc.text('These are not Daksfirst fees. Third-party costs borne by borrower, disclosed for budgeting only.', M + 3, y, { width: W - 6 });
      y += 11;

      const tpCols = [
        { label: 'COST', width: 110 },
        { label: 'EST. AMOUNT', width: 95 },
        { label: 'NOTE', width: W - 205 }
      ];
      const tpRows = [
        ['Valuation Fee', money(dipData.valuation_cost || 0), 'Paid directly by client to valuer'],
        ['Legal Fee',     money(dipData.legal_cost || 0),     'Via undertaking from client\'s solicitors']
      ];
      drawTable(tpCols, tpRows, { rowH: 9 });
      y += 3;


      // ══════════════════════════════════════════════
      //  7. PAYMENT DETAILS
      // ══════════════════════════════════════════════
      sectionBar('HOW TO PROCEED — PAYMENT DETAILS', GREEN);

      const payHalfW = (W - 4) / 2;
      const bankLines = [
        ['Account Name:', 'Daksfirst Limited'],
        ['Bank:', 'HSBC'],
        ['Account No:', '90300721'],
        ['Sort Code:', '40-02-45'],
        ['IBAN:', 'GB64HBUK40024590300721'],
        ['Reference:', dealRef]
      ];
      const payBoxH = Math.max(30, bankLines.length * 5 + 6);
      checkPage(payBoxH + 4);

      // Left: instructions
      doc.rect(M, y, payHalfW, payBoxH).fill(WHITE).stroke({ color: DGREY, width: 0.5 });
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('To proceed, remit the Onboarding/DIP Fee below. Quote the deal reference as payment reference.', M + 4, y + 3, { width: payHalfW - 8 });
      doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
      doc.text('Upon receipt, Daksfirst will commence credit review.', M + 4, y + 18, { width: payHalfW - 8 });

      // Right: bank details
      const bankX = M + payHalfW + 4;
      doc.rect(bankX, y, payHalfW, payBoxH).fill(LGREY).stroke({ color: DGREY, width: 0.5 });
      let bankY = y + 3;
      bankLines.forEach(line => {
        doc.font('Helvetica').fontSize(6.5).fillColor(MGREY);
        doc.text(line[0], bankX + 4, bankY, { width: 65 });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY);
        doc.text(line[1], bankX + 70, bankY, { width: payHalfW - 78 });
        bankY += 5;
      });
      y += payBoxH + 5;


      // ══════════════════════════════════════════════
      //  8. RED NOTICE
      // ══════════════════════════════════════════════
      checkPage(20);
      doc.rect(M, y, W, 16).fill(REDBG).stroke({ color: '#fca5a5', width: 1 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED);
      doc.text(
        'IMPORTANT NOTICE: This Decision in Principle is indicative only and does not constitute a binding offer or commitment to lend. Final approval is subject to full underwriting, valuation and credit committee approval.',
        M + 4, y + 2, { width: W - 8, align: 'center' }
      );
      y += 19;


      // ══════════════════════════════════════════════
      //  9. ACKNOWLEDGEMENT + SIGNATURES
      // ══════════════════════════════════════════════
      checkPage(50);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
      doc.text('BORROWER ACKNOWLEDGEMENT', M, y, { width: W });
      y += 9;
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('By accepting this DIP, the Borrower acknowledges intention to proceed on the terms above. This DIP is valid for 14 days from the date of issue.', M, y, { width: W });
      y += 14;

      // Signature block
      checkPage(34);
      const sigW = (W - 4) / 2;

      doc.moveTo(M, y + 14).lineTo(M + sigW, y + 14).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('Borrower Signature', M, y + 16);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text(clean(deal.borrower_name), M, y + 23);
      if (isCorp) doc.text(clean(deal.borrower_company || deal.company_name), M, y + 29);

      const sigX2 = M + sigW + 4;
      doc.moveTo(sigX2, y + 14).lineTo(sigX2 + sigW, y + 14).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('For and on behalf of the Lender', sigX2, y + 16);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('Daksfirst Bridging 1 Ltd', sigX2, y + 23);
      y += 34;

      // ── FCA DISCLAIMER ──
      y += 4;
      checkPage(12);
      doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
      doc.text('Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.', M, y, { width: W, align: 'center' });

      // ── FOOTER ──
      addFooter(pageNum);

      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDipPdf };
