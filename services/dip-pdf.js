/**
 * DIP PDF Generator — Daksfirst
 *
 * v3 — Polished layout matching the portal HTML rendering.
 * Generous spacing, larger cells, better visual hierarchy.
 * Fully dynamic, handles any deal shape.
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
const AMBERTXT= '#92400e';
const BLUE    = '#eff6ff';
const TXT     = '#1a1a2e';
const GREEN   = '#166534';
const GREENBG = '#f0fdf4';
const BLUEBG  = '#eff6ff';
const PURPLEBG= '#faf5ff';

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

      // ── Dimensions ──
      const pw = doc.page.width;   // 595
      const ph = doc.page.height;  // 842
      const M = 32;                // side margin (slightly tighter for more content width)
      const W = pw - M * 2;       // ~531
      const FOOTER_ZONE = 52;
      let y = 0;
      let pageNum = 1;

      // ── Derived data ──
      const dealRef = dealRefFromId(deal.submission_id, deal.created_at);
      const bType = (deal.borrower_type || 'individual').toLowerCase();
      const isCorp = ['corporate', 'spv', 'ltd', 'llp', 'limited'].includes(bType);
      const addresses = (deal.security_address || '').split(';').filter(a => a.trim());
      const postcodes = (deal.security_postcode || '').split(',').filter(p => p.trim());
      const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);
      const halfW = (W - 6) / 2;

      // ────────────────────────────────────────────────────
      // REUSABLE DRAWING HELPERS
      // ────────────────────────────────────────────────────

      function checkPage(needed) {
        if (y + needed > ph - FOOTER_ZONE) {
          addFooter();
          doc.addPage();
          pageNum++;
          y = 20;
        }
      }

      function addFooter() {
        const fy = ph - 46;
        doc.moveTo(M, fy).lineTo(M + W, fy).strokeColor(GOLD).lineWidth(1.5).stroke();
        doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
        doc.text(
          'Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com',
          M, fy + 3, { width: W, align: 'center' }
        );
        doc.text(
          'This DIP is indicative only and does not constitute a formal offer. Subject to full underwriting, valuation & legal due diligence.',
          M, fy + 10, { width: W, align: 'center' }
        );
      }

      /** Full-width section bar — taller, more prominent */
      function sectionBar(text, bgColor) {
        bgColor = bgColor || NAVY;
        checkPage(18);
        doc.rect(M, y, W, 16).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
        doc.text(text.toUpperCase(), M + 8, y + 3.5, { width: W - 16 });
        y += 18;
      }

      /** Half-width section bar at a specific X */
      function sectionBarAt(text, xPos, width, bgColor) {
        bgColor = bgColor || NAVY;
        doc.rect(xPos, y, width, 16).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE);
        doc.text(text.toUpperCase(), xPos + 8, y + 3.5, { width: width - 16 });
      }

      /** Draw a 2-column grid with generous cell heights matching HTML style */
      function drawGrid(items, opts) {
        opts = opts || {};
        const cellH = opts.cellH || 22;
        const rows = Math.ceil(items.length / 2);
        checkPage(rows * cellH + 6);

        items.forEach((item, idx) => {
          const row = Math.floor(idx / 2);
          const col = idx % 2;
          const cx = M + col * (halfW + 6);
          const cy = y + row * cellH;
          const highlight = item[2] === true;
          const bg = highlight ? BLUE : (col === 0 ? WHITE : LGREY);

          doc.rect(cx, cy, halfW, cellH).fill(bg);
          // Thin border on bottom only for cleaner look
          doc.moveTo(cx, cy + cellH).lineTo(cx + halfW, cy + cellH).strokeColor(DGREY).lineWidth(0.5).stroke();

          // Label
          doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
          doc.text(item[0], cx + 8, cy + 3, { width: halfW - 16 });

          // Value — larger, bolder
          const valSize = highlight ? 11 : 9;
          doc.font('Helvetica-Bold').fontSize(valSize).fillColor(highlight ? NAVY : TXT);
          doc.text(clean(item[1]), cx + 8, cy + 11, { width: halfW - 16 });
        });

        y += rows * cellH + 6;
      }

      /** Draw a data table with header and dynamic rows */
      function drawTable(cols, rows, opts) {
        opts = opts || {};
        const rowH = opts.rowH || 11;
        const headerH = opts.headerH || 11;

        // Header
        checkPage(headerH + rowH * Math.min(rows.length, 2));
        doc.rect(M, y, W, headerH).fill(LGREY2);
        doc.moveTo(M, y + headerH).lineTo(M + W, y + headerH).strokeColor(DGREY).lineWidth(0.5).stroke();
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        let cx = M;
        cols.forEach(col => {
          doc.text(col.label, cx + 6, y + 3, { width: col.width - 12, align: col.align || 'left' });
          cx += col.width;
        });
        y += headerH;

        // Rows
        rows.forEach((row, ridx) => {
          checkPage(rowH);
          const highlight = opts.highlightFn ? opts.highlightFn(ridx, row) : false;
          const bg = highlight ? AMBER : (ridx % 2 === 0 ? WHITE : LGREY2);
          doc.rect(M, y, W, rowH).fill(bg);
          doc.moveTo(M, y + rowH).lineTo(M + W, y + rowH).strokeColor(DGREY).lineWidth(0.3).stroke();

          cx = M;
          row.forEach((val, cidx) => {
            const col = cols[cidx];
            const isFirst = cidx === 0;
            doc.font(isFirst && !highlight ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(TXT);
            doc.text(String(val), cx + 6, y + 2.5, { width: col.width - 12, align: col.align || 'left' });
            cx += col.width;
          });
          y += rowH;
        });
      }

      /** Small coloured badge (for role/status) */
      function drawBadge(text, x, bY, bgColor, textColor) {
        doc.font('Helvetica-Bold').fontSize(6);
        const badgeW = doc.widthOfString(text) + 12;
        doc.rect(x, bY, badgeW, 10).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(6).fillColor(textColor);
        doc.text(text, x + 6, bY + 2, { width: badgeW - 12 });
        return badgeW;
      }


      // ════════════════════════════════════════════════════
      //  HEADER — Taller, prominent logo
      // ════════════════════════════════════════════════════
      const headerH = 52;
      doc.rect(0, 0, pw, headerH).fill(NAVY);

      // Logo
      try {
        const logoBuf = Buffer.from(LOGO_B64, 'base64');
        doc.image(logoBuf, M, 8, { width: 36, height: 36 });
      } catch (e) { /* continue without logo */ }

      // Company name + tagline
      doc.font('Helvetica-Bold').fontSize(16).fillColor(WHITE);
      doc.text('DAKSFIRST', M + 44, 10, { width: 200 });
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(GOLD);
      doc.text('Bridging Finance, Built for Professionals', M + 44, 30, { width: 220 });

      // Right side info
      doc.font('Helvetica').fontSize(7).fillColor(WHITE);
      doc.text('8 Hill Street, Mayfair, London W1J 5NG', M + W - 155, 12, { width: 150, align: 'right' });
      doc.fontSize(7).fillColor(GOLD);
      doc.text('FCA 937220  |  portal@daksfirst.com', M + W - 155, 30, { width: 150, align: 'right' });

      y = headerH;

      // ── Gold divider ──
      doc.rect(0, y, pw, 3).fill(GOLD);
      y += 6;

      // ── Title block ──
      doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY);
      doc.text('DECISION IN PRINCIPLE', M, y, { width: W, align: 'center' });
      y += 18;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MGREY);
      doc.text('Senior Secured Real Estate Credit & Structured Finance', M, y, { width: W, align: 'center' });
      y += 14;

      // ── Reference strip ──
      checkPage(18);
      doc.rect(M, y, W, 16).fill(LGREY);
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(M, y + 16).lineTo(M + W, y + 16).strokeColor(DGREY).lineWidth(0.5).stroke();

      // Ref (left, in a box)
      doc.rect(M + 6, y + 2, 95, 12).lineWidth(1).strokeColor(NAVY).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
      doc.text(dealRef, M + 10, y + 3, { width: 87, align: 'center' });

      // Date (center)
      doc.font('Helvetica').fontSize(8).fillColor(MGREY);
      const issueDate = options.issuedAt
        ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.text('Issued: ' + issueDate, M + W / 2 - 55, y + 3, { width: 110, align: 'center' });

      // Badge (right)
      const badgeText = isCorp ? 'CORPORATE SPV' : 'INDIVIDUAL';
      const badgeBg = isCorp ? '#dbeafe' : GREENBG;
      const badgeColor = isCorp ? NAVY : GREEN;
      const btW = doc.widthOfString(badgeText, { font: 'Helvetica-Bold', fontSize: 7 }) + 14;
      doc.rect(M + W - btW - 4, y + 2, btW, 12).fill(badgeBg);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(badgeColor);
      doc.text(badgeText, M + W - btW + 3, y + 4, { width: btW - 14 });

      y += 20;


      // ══════════════════════════════════════════════
      //  1. BORROWER DETAILS
      // ══════════════════════════════════════════════
      sectionBar('BORROWER DETAILS');

      const bCellH = 36;
      checkPage(bCellH + 8);

      if (isCorp) {
        // Left: Corporate entity
        doc.rect(M, y, halfW, bCellH).fill(BLUEBG);
        doc.moveTo(M, y + bCellH).lineTo(M + halfW, y + bCellH).strokeColor(DGREY).lineWidth(0.5).stroke();
        doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
        doc.text('CORPORATE ENTITY', M + 8, y + 4, { width: halfW - 16 });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_company || deal.company_name), M + 8, y + 13, { width: halfW - 16 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        doc.text('Co. No: ' + clean(deal.company_number), M + 8, y + 25, { width: halfW - 16 });

        // Right: UBO
        doc.rect(M + halfW + 6, y, halfW, bCellH).fill(AMBER);
        doc.moveTo(M + halfW + 6, y + bCellH).lineTo(M + halfW + 6 + halfW, y + bCellH).strokeColor(DGREY).lineWidth(0.5).stroke();
        doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
        doc.text('ULTIMATE BENEFICIAL OWNER (UBO)', M + halfW + 14, y + 4, { width: halfW - 16 });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_name), M + halfW + 14, y + 13, { width: halfW - 16 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        const contact = [clean(deal.borrower_email), clean(deal.borrower_phone)].filter(v => v !== '—').join(' \u2022 ') || '—';
        doc.text(contact, M + halfW + 14, y + 25, { width: halfW - 16 });
      } else {
        // Individual — full width
        doc.rect(M, y, W, bCellH).fill(BLUEBG);
        doc.moveTo(M, y + bCellH).lineTo(M + W, y + bCellH).strokeColor(DGREY).lineWidth(0.5).stroke();
        doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
        doc.text('BORROWER', M + 8, y + 4, { width: W - 16 });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY);
        doc.text(clean(deal.borrower_name), M + 8, y + 13, { width: W - 16 });
        doc.font('Helvetica').fontSize(7).fillColor(MGREY);
        const contact = [clean(deal.borrower_email), clean(deal.borrower_phone)].filter(v => v !== '—').join(' \u2022 ') || '—';
        doc.text(contact, M + 8, y + 25, { width: W - 16 });
      }
      y += bCellH + 4;

      // Parties sub-table with role badges
      if (dipData.borrowers && dipData.borrowers.length > 1) {
        checkPage(14 + dipData.borrowers.length * 12);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(MGREY);
        doc.text('PARTIES TO THE DIP', M + 8, y, { width: W - 16 });
        y += 11;

        // Mini header
        doc.rect(M, y, W, 10).fill(LGREY2);
        doc.font('Helvetica-Bold').fontSize(6).fillColor(MGREY);
        doc.text('Name', M + 8, y + 2, { width: W * 0.4 });
        doc.text('Role', M + W * 0.4 + 8, y + 2, { width: W * 0.3 });
        doc.text('KYC', M + W * 0.7 + 8, y + 2, { width: W * 0.3 - 16 });
        y += 10;

        dipData.borrowers.forEach((bor, idx) => {
          checkPage(12);
          doc.rect(M, y, W, 11).fill(idx % 2 === 0 ? WHITE : LGREY2);
          doc.font('Helvetica').fontSize(7).fillColor(TXT);
          doc.text(clean(bor.name), M + 8, y + 2, { width: W * 0.4 });

          // Role badge
          const roleText = bor.role || '—';
          const roleBg = roleText.toLowerCase() === 'primary' ? GREENBG : (roleText.toLowerCase() === 'guarantor' ? BLUEBG : LGREY2);
          const roleColor = roleText.toLowerCase() === 'primary' ? GREEN : (roleText.toLowerCase() === 'guarantor' ? NAVY : TXT);
          drawBadge(roleText, M + W * 0.4 + 8, y + 1, roleBg, roleColor);

          // KYC badge
          const kycText = bor.kyc_verified ? 'Verified' : 'Pending';
          const kycBg = bor.kyc_verified ? GREENBG : AMBER;
          const kycColor = bor.kyc_verified ? GREEN : AMBERTXT;
          drawBadge(kycText, M + W * 0.7 + 8, y + 1, kycBg, kycColor);

          y += 11;
        });
        y += 4;
      }


      // ══════════════════════════════════════════════
      //  2. SECURITY SCHEDULE
      // ══════════════════════════════════════════════
      const propCount = addresses.length || 1;
      sectionBar('SECURITY SCHEDULE \u2014 ' + propCount + ' PROPERT' + (propCount === 1 ? 'Y' : 'IES'));

      // Property table
      const totalPropertyVal = parseFloat(dipData.property_value || deal.property_value || deal.estimated_value || 0);
      const propCols = [
        { label: '#', width: 24 },
        { label: 'ADDRESS', width: W * 0.50 },
        { label: 'POSTCODE', width: 65 },
        { label: 'VALUATION (\u00A3)', width: W - 24 - W * 0.50 - 65, align: 'right' }
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
            const perProp = Math.floor(totalPropertyVal / addresses.length);
            val = (idx === addresses.length - 1) ? totalPropertyVal - perProp * (addresses.length - 1) : perProp;
          }
          totalVal += val;
          propRows.push([String(idx + 1), clean(addr.trim()), clean(pc.trim()), money(val)]);
        });
      } else {
        totalVal = totalPropertyVal;
        propRows.push(['1', clean(deal.security_address || 'TBC'), clean(deal.security_postcode || '—'), money(totalPropertyVal)]);
      }

      drawTable(propCols, propRows, { rowH: 12 });

      // Total row — prominent
      checkPage(14);
      doc.rect(M, y, W, 13).fill(BLUE);
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(NAVY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
      doc.text('Total Portfolio Valuation', M + 8, y + 3, { width: W * 0.6 });
      doc.text(money(totalVal || totalPropertyVal), M + W * 0.6, y + 3, { width: W * 0.4 - 8, align: 'right' });
      y += 16;

      // Asset details grid
      const assetItems = [
        ['ASSET TYPE', humanize(deal.asset_type)],
        ['TENURE', humanize(deal.property_tenure)],
        ['PURCHASE PRICE', money(deal.purchase_price)],
        ['CURRENT USE / OCCUPANCY', clean(deal.current_use || deal.occupancy_status)]
      ].filter(item => item[1] !== '—');

      if (assetItems.length > 0) drawGrid(assetItems, { cellH: 22 });


      // ══════════════════════════════════════════════
      //  3. INDICATIVE LOAN TERMS
      // ══════════════════════════════════════════════
      sectionBar('INDICATIVE LOAN TERMS');

      const loanTermItems = [
        ['GROSS LOAN AMOUNT', money(dipData.loan_amount || deal.loan_amount), true],
        ['LOAN TO VALUE (LTV)', pct(dipData.ltv || deal.ltv_requested), true],
        ['TERM', clean(dipData.term_months || deal.term_months) + ' months', false],
        ['INTEREST RATE', pct(dipData.rate_monthly || deal.rate_requested) + ' per month', false],
        ['INTEREST SERVICING', clean(dipData.interest_servicing || 'Retained'), false],
        ['RETAINED INTEREST PERIOD', clean(dipData.retained_months || '—') + ' months', false],
        ['EXIT STRATEGY', clean(dipData.exit_strategy || deal.exit_strategy), false],
        ['LOAN PURPOSE', clean(deal.loan_purpose), false]
      ];

      drawGrid(loanTermItems, { cellH: 22 });


      // ══════════════════════════════════════════════
      //  4. SECURITY & GUARANTEES | CONDITIONS PRECEDENT
      // ══════════════════════════════════════════════
      const secItems = [
        ['FIRST LEGAL CHARGE', addresses.length > 1 ? 'Over all ' + addresses.length + ' security properties' : 'Over the security property'],
        ['DEBENTURE', isCorp ? 'Required (corporate borrower)' : 'N/A'],
        ['PERSONAL GUARANTEE', isCorp ? 'Required from UBO' : 'N/A']
      ];

      const cpItems = [
        'Satisfactory independent valuation',
        'Clear title search \u2014 no encumbrances',
        'Legal due diligence by Lender\'s solicitors',
        'First legal charge in favour of Lender',
        'Buildings insurance \u2014 Lender\'s interest noted'
      ];
      if (isCorp) {
        cpItems.push('Personal guarantee from UBO');
        cpItems.push('Debenture over corporate assets');
      }
      cpItems.push('KYC/AML documentation for all parties');
      cpItems.push('Evidence of source of deposit & funds');
      cpItems.push('Payment of all applicable fees');

      const secRowH = 14;
      const cpRowH = 11;
      const leftH = 16 + secItems.length * secRowH;
      const rightH = 16 + cpItems.length * cpRowH;
      const sideH = Math.max(leftH, rightH);

      checkPage(sideH + 6);
      const sby = y;

      // LEFT column
      sectionBarAt('SECURITY & GUARANTEES', M, halfW);
      let ly = sby + 18;
      secItems.forEach((item, idx) => {
        doc.rect(M, ly, halfW, secRowH).fill(idx % 2 === 0 ? WHITE : LGREY2);
        doc.moveTo(M, ly + secRowH).lineTo(M + halfW, ly + secRowH).strokeColor(DGREY).lineWidth(0.3).stroke();
        doc.font('Helvetica').fontSize(5.5).fillColor(MGREY);
        doc.text(item[0], M + 8, ly + 1, { width: halfW - 16 });
        doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT);
        doc.text(clean(item[1]), M + 8, ly + 7, { width: halfW - 16 });
        ly += secRowH;
      });

      // RIGHT column
      sectionBarAt('CONDITIONS PRECEDENT', M + halfW + 6, halfW);
      let ry = sby + 18;
      cpItems.forEach((c, idx) => {
        doc.rect(M + halfW + 6, ry, halfW, cpRowH).fill(idx % 2 === 0 ? WHITE : LGREY2);
        doc.moveTo(M + halfW + 6, ry + cpRowH).lineTo(M + halfW + 6 + halfW, ry + cpRowH).strokeColor(DGREY).lineWidth(0.3).stroke();
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY);
        doc.text((idx + 1) + '.', M + halfW + 10, ry + 2.5, { width: 14 });
        doc.font('Helvetica').fontSize(7).fillColor(TXT);
        doc.text(c, M + halfW + 24, ry + 2.5, { width: halfW - 26 });
        ry += cpRowH;
      });

      y = Math.max(ly, ry) + 6;


      // ══════════════════════════════════════════════
      //  5. FEE SCHEDULE
      // ══════════════════════════════════════════════
      sectionBar('FEE SCHEDULE');

      const arrFee = parseFloat(dipData.arrangement_fee || deal.arrangement_fee || 2);
      const brkFee = parseFloat(dipData.broker_fee || deal.broker_fee || 1);

      const feeCols = [
        { label: 'FEE', width: 115 },
        { label: 'AMOUNT', width: 100 },
        { label: 'WHEN DUE', width: 110 },
        { label: 'PAYMENT', width: W - 325 }
      ];
      const feeRows = [
        ['Onboarding Fee',   money(dipData.fee_onboarding || 0), 'After DIP acceptance', 'Before Credit Review'],
        ['Commitment Fee',   money(dipData.fee_commitment || 0), 'After Termsheet',      'Before Underwriting'],
        ['Arrangement Fee',  feeLine(arrFee, loanAmt),           'On completion',         'Deducted from advance'],
        ['    of which Broker', feeLine(brkFee, loanAmt),        'On completion',         'From arrangement fee'],
        ['Exit Fee',         pct(1.00) + ' of loan',             'On redemption',         'Payable on exit'],
        ['Extension Fee',    pct(1.00) + ' of loan',             'If term extended',      'Per extension period']
      ];

      drawTable(feeCols, feeRows, {
        rowH: 11,
        highlightFn: (idx) => idx === 2 || idx === 3
      });
      y += 4;


      // ══════════════════════════════════════════════
      //  6. THIRD-PARTY COSTS
      // ══════════════════════════════════════════════
      sectionBar('ESTIMATED THIRD-PARTY COSTS', MGREY);

      doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(MGREY);
      doc.text('These are not Daksfirst fees. Third-party costs borne by borrower, disclosed for budgeting only.', M + 8, y, { width: W - 16 });
      y += 12;

      const tpCols = [
        { label: 'COST', width: 115 },
        { label: 'EST. AMOUNT', width: 100 },
        { label: 'NOTE', width: W - 215 }
      ];
      const tpRows = [
        ['Valuation Fee', money(dipData.valuation_cost || 0), 'Paid directly by client to valuer'],
        ['Legal Fee',     money(dipData.legal_cost || 0),     'Via undertaking from client\'s solicitors']
      ];
      drawTable(tpCols, tpRows, { rowH: 11 });
      y += 4;


      // ══════════════════════════════════════════════
      //  7-9. BOTTOM BLOCK: Payment + Notice + Ack + Signatures
      //  Treated as one unit so it never splits across pages
      // ══════════════════════════════════════════════
      const bankLines = [
        ['Account Name:', 'Daksfirst Limited'],
        ['Bank:', 'HSBC'],
        ['Account No:', '90300721'],
        ['Sort Code:', '40-02-45'],
        ['IBAN:', 'GB64HBUK40024590300721'],
        ['Reference:', dealRef]
      ];
      const payBoxH = Math.max(40, bankLines.length * 6 + 10);
      // Total height: section bar(18) + payBox + gap(6) + notice(22) + ack(26) + sigs(40) + fca(14) ≈ 170
      const bottomBlockH = 18 + payBoxH + 6 + 22 + 28 + 42 + 14;
      checkPage(bottomBlockH);

      // ── PAYMENT DETAILS ──
      sectionBar('HOW TO PROCEED \u2014 PAYMENT DETAILS', GREEN);

      // Left: instructions
      doc.rect(M, y, halfW, payBoxH).fill(WHITE);
      doc.moveTo(M, y).lineTo(M + halfW, y).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(M, y + payBoxH).lineTo(M + halfW, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(M, y).lineTo(M, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(M + halfW, y).lineTo(M + halfW, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('To proceed, remit the Onboarding/DIP Fee below. Quote the deal reference as payment reference.', M + 8, y + 5, { width: halfW - 16 });
      doc.font('Helvetica-Oblique').fontSize(6).fillColor(MGREY);
      doc.text('Upon receipt, Daksfirst will commence credit review.', M + 8, y + 24, { width: halfW - 16 });

      // Right: bank details
      const bankX = M + halfW + 6;
      doc.rect(bankX, y, halfW, payBoxH).fill(LGREY);
      doc.moveTo(bankX, y).lineTo(bankX + halfW, y).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(bankX, y + payBoxH).lineTo(bankX + halfW, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(bankX, y).lineTo(bankX, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      doc.moveTo(bankX + halfW, y).lineTo(bankX + halfW, y + payBoxH).strokeColor(DGREY).lineWidth(0.5).stroke();
      let bankY = y + 5;
      bankLines.forEach(line => {
        doc.font('Helvetica').fontSize(6.5).fillColor(MGREY);
        doc.text(line[0], bankX + 8, bankY, { width: 70 });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY);
        doc.text(line[1], bankX + 80, bankY, { width: halfW - 90 });
        bankY += 5.5;
      });
      y += payBoxH + 6;

      // ── RED NOTICE ──
      doc.rect(M, y, W, 18).fill(REDBG);
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor('#fca5a5').lineWidth(1).stroke();
      doc.moveTo(M, y + 18).lineTo(M + W, y + 18).strokeColor('#fca5a5').lineWidth(1).stroke();
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED);
      doc.text(
        'IMPORTANT NOTICE: This Decision in Principle is indicative only and does not constitute a binding offer or commitment to lend. Final approval is subject to full underwriting, valuation and credit committee approval.',
        M + 8, y + 3, { width: W - 16, align: 'center' }
      );
      y += 22;

      // ── ACKNOWLEDGEMENT ──
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY);
      doc.text('BORROWER ACKNOWLEDGEMENT', M, y, { width: W });
      y += 10;
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('By accepting this DIP, the Borrower acknowledges intention to proceed on the terms above. This DIP is valid for 14 days from the date of issue.', M, y, { width: W });
      y += 16;

      // ── SIGNATURES ──
      const sigW = (W - 6) / 2;

      doc.moveTo(M, y + 16).lineTo(M + sigW, y + 16).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('Borrower Signature', M, y + 18);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text(clean(deal.borrower_name), M, y + 25);
      if (isCorp) doc.text(clean(deal.borrower_company || deal.company_name), M, y + 31);

      const sigX2 = M + sigW + 6;
      doc.moveTo(sigX2, y + 16).lineTo(sigX2 + sigW, y + 16).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY);
      doc.text('For and on behalf of the Lender', sigX2, y + 18);
      doc.font('Helvetica').fontSize(7).fillColor(TXT);
      doc.text('Daksfirst Bridging 1 Ltd', sigX2, y + 25);
      y += 40;

      // ── FCA ──
      y += 4;
      doc.font('Helvetica-Oblique').fontSize(5.5).fillColor(MGREY);
      doc.text('Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.', M, y, { width: W, align: 'center' });

      // Footer
      addFooter();

      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDipPdf };
