/**
 * DIP PDF Generator — Daksfirst Branded with Letterhead
 *
 * Generates a professional PDF matching the termsheet DOCX look:
 * - Letterhead image from letterhead_template.docx
 * - Navy section header bars, gold accents, alternating rows
 * - Garamond-style serif (Helvetica for PDF compat)
 * - Footer with FCA/company info
 *
 * All data is view-only — amendments happen via the web portal.
 */
const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');
const JSZip = require('jszip');

// ── Brand Colours ──
const NAVY    = '#1F3864';
const GOLD    = '#C9A227';
const LGREY   = '#F2F2F2';
const WHITE   = '#FFFFFF';
const RED     = '#C00000';
const MGREY   = '#D9D9D9';
const BLACK   = '#000000';
const AMBER   = '#E26B0A';
const TXT     = '#1a1a2e';
const MUTED   = '#555555';

// ── Letterhead image (loaded once at startup) ──
let LH_IMG = null;
let LH_LOADED = false;

(async () => {
  try {
    const searchPaths = [
      path.join(__dirname, '..', 'letterhead_template.docx'),
      path.join(__dirname, 'letterhead_template.docx'),
      path.join(process.cwd(), 'letterhead_template.docx'),
    ];
    let buf = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) { buf = fs.readFileSync(p); break; }
    }
    if (!buf) { console.warn('[dip-pdf] letterhead_template.docx not found — no logo'); return; }

    const zip = await JSZip.loadAsync(buf);
    const imgFile = zip.file('word/media/image1.png');
    if (imgFile) {
      LH_IMG = await imgFile.async('nodebuffer');
      LH_LOADED = true;
      console.log('[dip-pdf] Letterhead image loaded OK');
    }
  } catch (e) {
    console.warn('[dip-pdf] letterhead load failed:', e.message);
  }
})();

// ── Helpers ──
function money(val) {
  if (!val && val !== 0) return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return '\u2014';
  return '\u00A3' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  if (!val && val !== 0) return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '\u2014';
  return num.toFixed(2) + '%';
}

function clean(val) {
  if (val === null || val === undefined) return '\u2014';
  return String(val).trim() || '\u2014';
}

function feeLine(raw, loanAmt) {
  const v = parseFloat(raw || 0);
  if (isNaN(v) || v === 0) return '\u2014';
  if (v > 0 && v < 50) return money(Math.round(loanAmt * v / 100)) + ' (' + v.toFixed(2) + '%)';
  return money(v);
}

// ═══════════════════════════════════════════════════════════════════
// GENERATE DIP PDF
// ═══════════════════════════════════════════════════════════════════

async function generateDipPdf(deal, dipData, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 55, right: 55 },
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

      const pw = doc.page.width;      // ~595
      const ph = doc.page.height;     // ~842
      const M  = 55;                  // margin
      const W  = pw - M * 2;         // content width ~485
      const LABEL_W = 180;
      const VALUE_X = M + LABEL_W + 10;
      const VALUE_W = W - LABEL_W - 10;
      const contentBottom = ph - 70;
      let y = 0;
      let rowIdx = 0;
      let pageNum = 1;

      // ── Page check ──
      function checkPage(needed) {
        if (y + needed > contentBottom) {
          addFooter();
          doc.addPage();
          pageNum++;
          y = 55;
        }
      }

      // ── Footer (on each page) ──
      function addFooter() {
        doc.save();
        // Gold line
        doc.moveTo(M, ph - 55).lineTo(M + W, ph - 55).strokeColor(GOLD).lineWidth(0.8).stroke();
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
        doc.text('Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com', M, ph - 48, { width: W, align: 'center' });
        doc.text('This DIP is indicative only and does not constitute a formal offer. Subject to full underwriting, valuation & legal due diligence.', M, ph - 38, { width: W, align: 'center' });
        doc.restore();
      }

      // ── Letterhead / Header ──
      if (LH_LOADED && LH_IMG) {
        // Place letterhead image at top (scaled to fit page width)
        try {
          doc.image(LH_IMG, 0, 0, { width: pw, height: 95 });
          y = 100;
        } catch (e) {
          // Fallback: navy bar
          doc.rect(0, 0, pw, 90).fill(NAVY);
          doc.rect(0, 90, pw, 4).fill(GOLD);
          doc.font('Helvetica-Bold').fontSize(22).fillColor(WHITE);
          doc.text('DAKSFIRST', M, 25, { width: W });
          doc.font('Helvetica').fontSize(10).fillColor(GOLD);
          doc.text('Bridging Finance, Built for Professionals', M, 52, { width: W });
          y = 100;
        }
      } else {
        // Navy bar header
        doc.rect(0, 0, pw, 90).fill(NAVY);
        doc.rect(0, 90, pw, 4).fill(GOLD);
        doc.font('Helvetica-Bold').fontSize(22).fillColor(WHITE);
        doc.text('DAKSFIRST', M, 25, { width: W });
        doc.font('Helvetica').fontSize(10).fillColor(GOLD);
        doc.text('Bridging Finance, Built for Professionals', M, 52, { width: W });
        y = 100;
      }

      // ── Subtitle + Gold divider ──
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MGREY);
      doc.text('Senior Secured Real Estate Credit & Structured Finance', M, y, { width: W });
      y += 14;
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(GOLD).lineWidth(2).stroke();
      y += 12;

      // ── Title ──
      doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY);
      doc.text('DECISION IN PRINCIPLE', M, y, { width: W, align: 'center' });
      y += 28;

      // ── Disclaimer ──
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MGREY);
      doc.text('Please note that this Decision in Principle is indicative only and does not constitute a commitment or an offer by the Lender to provide finance. The decision to provide financing is subject to full underwriting, valuation, due diligence, credit committee approval and final documentation satisfactory to the Lender.', M, y, { width: W, align: 'center' });
      y += 34;

      // ── Date & Reference ──
      const dateStr = options.issuedAt
        ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TXT);
      doc.text('Date: ' + dateStr, M, y, { width: W });
      y += 14;
      doc.text('Reference: ' + clean(deal.submission_id), M, y, { width: W });
      y += 20;

      // ═══ SECTION HEADER BAR (navy background, white text) ═══
      function sectionBar(title) {
        checkPage(30);
        doc.rect(M, y, W, 20).fill(NAVY);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
        doc.text(title.toUpperCase(), M + 8, y + 5, { width: W - 16 });
        y += 24;
        rowIdx = 0;
      }

      // ═══ DATA ROW (alternating background) ═══
      function dataRow(label, value) {
        checkPage(18);
        const val = clean(value);
        const isTBC = /^(tbc|unknown|not provided|n\/a|tbd|\u2014)/i.test(val.trim());
        const bgColor = isTBC ? '#FFFBEB' : (rowIdx % 2 === 0 ? WHITE : LGREY);

        doc.rect(M, y, W, 16).fill(bgColor);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(TXT);
        doc.text(label, M + 6, y + 4, { width: LABEL_W - 6 });
        doc.font('Helvetica').fontSize(8).fillColor(isTBC ? AMBER : TXT);
        doc.text(val, VALUE_X, y + 4, { width: VALUE_W });
        y += 16;
        rowIdx++;
      }

      // ═══ BORROWER DETAILS ═══
      sectionBar('Borrower Details');
      const bType = (deal.borrower_type || 'individual').toLowerCase();
      const isCorporate = bType === 'corporate' || bType === 'spv' || bType === 'ltd' || bType === 'llp';
      dataRow('Borrower Name', deal.borrower_name);
      if (isCorporate || deal.borrower_company || deal.company_name) {
        dataRow('Borrower Type', 'Corporate (SPV / Limited Company)');
        dataRow('Company Name', deal.borrower_company || deal.company_name);
        dataRow('Company Number', deal.company_number);
      } else {
        dataRow('Borrower Type', 'Individual');
      }
      dataRow('Borrower Email', deal.borrower_email);
      dataRow('Borrower Phone', deal.borrower_phone);
      y += 6;

      // ═══ PROPERTY & VALUATION ═══
      sectionBar('Property & Valuation');
      dataRow('Security Address', deal.security_address);
      dataRow('Postcode', deal.security_postcode);
      dataRow('Asset Type', deal.asset_type);
      dataRow('Property Value (OMV)', money(dipData.property_value || deal.current_value));
      if (deal.purchase_price) dataRow('Purchase Price', money(deal.purchase_price));
      dataRow('Tenure', deal.property_tenure);
      dataRow('Current Use / Occupancy', deal.current_use || deal.occupancy_status);
      y += 6;

      // ═══ INDICATIVE LOAN TERMS ═══
      sectionBar('Indicative Loan Terms');
      dataRow('Gross Loan Amount', money(dipData.loan_amount || deal.loan_amount));
      dataRow('Loan To Value (LTV)', pct(dipData.ltv || deal.ltv_requested));
      dataRow('Term', (dipData.term_months || deal.term_months || '\u2014') + ' months');
      dataRow('Interest Rate', pct(dipData.rate_monthly || deal.rate_requested) + ' per month');
      dataRow('Interest Servicing', dipData.interest_servicing || deal.interest_servicing || 'Retained');
      if (dipData.retained_months) dataRow('Retained Interest Period', dipData.retained_months + ' months');
      dataRow('Exit Strategy', dipData.exit_strategy || deal.exit_strategy);
      dataRow('Loan Purpose', deal.loan_purpose);
      y += 6;

      // ═══ SECURITY ═══
      sectionBar('Security');
      dataRow('First Legal Charge', deal.security_address || 'Over the security property');
      dataRow('Debenture', isCorporate ? 'Required (corporate borrower)' : 'N/A (individual borrower)');
      dataRow('Personal Guarantee', isCorporate ? 'Required from UBO' : 'N/A');
      if (dipData.additional_security) dataRow('Additional Security', dipData.additional_security);
      y += 6;

      // ═══ FEE SCHEDULE ═══
      const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);
      sectionBar('Fee Schedule');
      // Fee sub-header
      doc.rect(M, y, W, 14).fill(NAVY);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE);
      doc.text('Fee', M + 6, y + 3, { width: LABEL_W });
      doc.text('Amount / When Due', VALUE_X, y + 3, { width: VALUE_W });
      y += 16;
      rowIdx = 0;

      dataRow('Onboarding Fee', money(dipData.fee_onboarding || 0) + ' \u2014 Before Credit Review');
      dataRow('Commitment Fee', money(dipData.fee_commitment || 0) + ' \u2014 Before Underwriting');
      dataRow('Arrangement Fee', feeLine(dipData.arrangement_fee, loanAmt) + ' \u2014 On Completion');
      dataRow('  (of which Broker)', feeLine(dipData.broker_fee, loanAmt) + ' \u2014 From Arrangement Fee');
      dataRow('Valuation Fee', money(dipData.valuation_cost || 0) + ' \u2014 On Instruction');
      dataRow('Legal Fee', money(dipData.legal_cost || 0) + ' \u2014 On Completion');
      y += 6;

      // ═══ CONDITIONS PRECEDENT ═══
      sectionBar('Conditions Precedent');
      const conds = [
        'Satisfactory independent valuation of the security property',
        'Clear title search with no undisclosed encumbrances',
        'Satisfactory legal due diligence by Daksfirst\'s appointed solicitors',
        'First legal charge over the property in favour of the Lender',
        'Comprehensive buildings insurance with Lender\'s interest noted',
        'Personal guarantee from UBO (for corporate borrowers)',
        'Satisfactory KYC/AML documentation for all parties',
        'Evidence of source of deposit and funds',
        'Payment of all applicable fees as outlined above',
      ];
      conds.forEach((c, i) => {
        checkPage(16);
        const bg = i % 2 === 0 ? WHITE : LGREY;
        doc.rect(M, y, W, 14).fill(bg);
        doc.font('Helvetica').fontSize(7.5).fillColor(TXT);
        doc.text((i + 1) + '.', M + 6, y + 3, { width: 18 });
        doc.text(c, M + 24, y + 3, { width: W - 30 });
        y += 14;
      });
      y += 8;

      // ═══ IMPORTANT NOTICE (RED) ═══
      checkPage(40);
      doc.rect(M, y, W, 32).fill('#FFF5F5').stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(RED);
      doc.text('IMPORTANT NOTICE: THIS DECISION IN PRINCIPLE IS INDICATIVE ONLY AND DOES NOT CONSTITUTE A BINDING OFFER OR COMMITMENT TO LEND. FINAL APPROVAL IS SUBJECT TO FULL UNDERWRITING, VALUATION AND CREDIT COMMITTEE APPROVAL.', M + 8, y + 6, { width: W - 16, align: 'center' });
      y += 40;

      // ═══ BORROWER ACKNOWLEDGEMENT ═══
      checkPage(60);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY);
      doc.text('BORROWER ACKNOWLEDGEMENT', M, y, { width: W });
      y += 16;
      doc.font('Helvetica').fontSize(8.5).fillColor(TXT);
      doc.text('By accepting this Decision in Principle, the Borrower acknowledges their intention to proceed on the terms outlined above. This DIP is valid for 14 days from the date of issue.', M, y, { width: W });
      y += 30;

      // ═══ SIGNATURE BLOCK ═══
      checkPage(60);
      const sigW = (W - 30) / 2;
      // Borrower
      doc.moveTo(M, y + 20).lineTo(M + sigW, y + 20).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY);
      doc.text('Borrower Signature', M, y + 24);
      doc.font('Helvetica').fontSize(7.5).fillColor(TXT);
      doc.text(clean(deal.borrower_name || '[BORROWER NAME]'), M, y + 34);
      doc.text('Date: ________________', M, y + 44);

      // Lender
      const lx = M + sigW + 30;
      doc.moveTo(lx, y + 20).lineTo(lx + sigW, y + 20).strokeColor(MGREY).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY);
      doc.text('For and on behalf of the Lender', lx, y + 24);
      doc.font('Helvetica').fontSize(7.5).fillColor(TXT);
      doc.text('Daksfirst Bridging 1 Ltd', lx, y + 34);
      doc.text('Date: ________________', lx, y + 44);
      y += 60;

      // ═══ FCA DISCLAIMER ═══
      checkPage(20);
      doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(MUTED);
      doc.text('Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA 937220). Registered office: 8 Hill Street, Mayfair, London W1J 5NG.', M, y, { width: W, align: 'center' });

      // Add footer to last page
      addFooter();

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDipPdf };
