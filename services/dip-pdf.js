/**
 * DIP PDF Generator — Daksfirst Branded
 * Uses PDFKit with NO footer writes (avoids ghost page creation)
 * Footer text is placed as the last content before doc.end()
 */
const PDFDocument = require('pdfkit');

const BRAND = {
  navy: '#1a365d',
  gold: '#c9a84c',
  textDark: '#1a1a2e',
  textMuted: '#555555',
  border: '#d4d4d4'
};

function money(val) {
  if (!val && val !== 0) return 'N/A';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return 'N/A';
  return '\u00A3' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  if (!val && val !== 0) return 'N/A';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return 'N/A';
  return num.toFixed(2) + '%';
}

async function generateDipPdf(deal, dipData, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 55, right: 55 },
        autoFirstPage: false,
        info: {
          Title: 'DIP - ' + (deal.submission_id || 'Daksfirst'),
          Author: 'Daksfirst Limited',
          Subject: 'Decision in Principle'
        }
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // Add first page manually
      doc.addPage();

      const pw = doc.page.width;
      const pageWidth = pw - 110; // 55 each side
      const L = 55;
      const contentBottom = doc.page.height - 60; // stop content here

      function checkPage(y, needed) {
        if (y + needed > contentBottom) {
          doc.addPage();
          return 60; // top margin
        }
        return y;
      }

      // ─── HEADER BAR ───────────────────────────────────────────
      doc.rect(0, 0, pw, 90).fill(BRAND.navy);
      doc.rect(0, 90, pw, 4).fill(BRAND.gold);

      doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff');
      doc.text('DAKSFIRST', L, 25, { width: pageWidth, lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(BRAND.gold);
      doc.text('Bridging Finance, Built for Professionals', L, 52, { width: pageWidth, lineBreak: false });

      const shortRef = 'DF-' + (deal.submission_id || '').substring(0, 8).toUpperCase();
      doc.font('Helvetica').fontSize(9).fillColor('#cccccc');
      doc.text('Ref: ' + shortRef, L, 70, { width: pageWidth, align: 'right', lineBreak: false });

      // ─── TITLE ────────────────────────────────────────────────
      let y = 115;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.navy);
      doc.text('DECISION IN PRINCIPLE', L, y, { width: pageWidth, align: 'center', lineBreak: false });
      y += 28;
      doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.textMuted);
      doc.text('This document is indicative only and does not constitute a binding offer of finance.', L, y, { width: pageWidth, align: 'center', lineBreak: false });
      y += 22;

      const issuedDate = options.issuedAt
        ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.font('Helvetica').fontSize(10).fillColor(BRAND.textDark);
      doc.text('Date: ' + issuedDate, L, y, { width: pageWidth, align: 'right', lineBreak: false });
      y += 22;

      // ─── BORROWER ─────────────────────────────────────────────
      y = heading(doc, 'BORROWER', L, y, pageWidth);
      const bType = deal.borrower_type || 'individual';
      if (bType === 'company' || bType === 'corporate') {
        y = row(doc, 'Corporate Borrower', deal.company_name || deal.borrower_company || 'N/A', L, y, pageWidth);
        y = row(doc, 'Company Number', deal.company_number || 'N/A', L, y, pageWidth);
        y = row(doc, 'Ultimate Beneficial Owner', deal.borrower_name || 'N/A', L, y, pageWidth);
      } else {
        y = row(doc, 'Borrower', deal.borrower_name || 'N/A', L, y, pageWidth);
      }
      if (dipData && dipData.borrowers && dipData.borrowers.length > 0) {
        for (const b of dipData.borrowers) {
          y = checkPage(y, 18);
          const role = (b.role || 'borrower').charAt(0).toUpperCase() + (b.role || 'borrower').slice(1);
          const kyc = b.kyc_verified ? '  [KYC Verified]' : '  [KYC Pending]';
          y = row(doc, role, (b.name || 'N/A') + kyc, L, y, pageWidth);
        }
      }

      // ─── SECURITY ─────────────────────────────────────────────
      y += 4;
      y = checkPage(y, 110);
      y = heading(doc, 'SECURITY', L, y, pageWidth);
      y = row(doc, 'Property Address', deal.security_address || 'N/A', L, y, pageWidth);
      y = row(doc, 'Postcode', deal.security_postcode || 'N/A', L, y, pageWidth);
      y = row(doc, 'Asset Type', deal.asset_type || 'N/A', L, y, pageWidth);
      y = row(doc, 'Tenure', deal.property_tenure || 'N/A', L, y, pageWidth);
      y = row(doc, 'Current Use', deal.current_use || 'N/A', L, y, pageWidth);

      // ─── LOAN TERMS ───────────────────────────────────────────
      y += 4;
      y = checkPage(y, 140);
      y = heading(doc, 'INDICATIVE LOAN TERMS', L, y, pageWidth);
      y = row(doc, 'Loan Amount', money(dipData?.loan_amount || deal.loan_amount), L, y, pageWidth);
      y = row(doc, 'Property Valuation', money(dipData?.property_value || deal.current_value), L, y, pageWidth);
      y = row(doc, 'Day 1 LTV', pct(dipData?.ltv || deal.ltv_requested), L, y, pageWidth);
      y = row(doc, 'Term', (dipData?.term_months || deal.term_months || 'N/A') + ' months', L, y, pageWidth);
      y = row(doc, 'Interest Rate', (dipData?.rate_monthly || deal.rate_requested || 'N/A') + '% per month', L, y, pageWidth);
      y = row(doc, 'Interest Servicing', dipData?.interest_servicing || deal.interest_servicing || 'Retained', L, y, pageWidth);
      y = row(doc, 'Exit Strategy', dipData?.exit_strategy || deal.exit_strategy || 'N/A', L, y, pageWidth);

      // ─── SECURITY & GUARANTEE ─────────────────────────────────
      y += 4;
      y = checkPage(y, 80);
      y = heading(doc, 'SECURITY & GUARANTEE STRUCTURE', L, y, pageWidth);
      y = row(doc, 'Charge Type', dipData?.fixed_charge || 'First Legal Charge', L, y, pageWidth);
      y = row(doc, 'Debenture', 'Required (for corporate borrowers)', L, y, pageWidth);
      y = row(doc, 'Personal Guarantee', dipData?.pg_ubo || 'Required from UBO', L, y, pageWidth);
      if (dipData?.additional_security) {
        y = row(doc, 'Additional Security', dipData.additional_security, L, y, pageWidth);
      }

      // ─── FEE SCHEDULE ─────────────────────────────────────────
      y += 4;
      y = checkPage(y, 160);
      y = heading(doc, 'FEE SCHEDULE', L, y, pageWidth);

      const c1 = L, c2 = L + 165, c3 = L + 265, c4 = L + 380;

      doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.navy);
      doc.text('Fee', c1, y, { lineBreak: false });
      doc.text('Amount', c2, y, { lineBreak: false });
      doc.text('When Due', c3, y, { lineBreak: false });
      doc.text('Payment Trigger', c4, y, { lineBreak: false });
      y += 13;
      doc.moveTo(L, y).lineTo(L + pageWidth, y).strokeColor(BRAND.gold).lineWidth(1).stroke();
      y += 5;

      const fees = [
        ['Onboarding Fee', money(dipData?.fee_onboarding || 0), 'Before Credit Review', 'Gates credit review', false],
        ['Commitment Fee', money(dipData?.fee_commitment || 0), 'Before Underwriting', 'Gates underwriting', false],
        ['Arrangement Fee', money(dipData?.arrangement_fee || 0), 'On Completion', 'Deducted from advance', false],
        ['  (of which Broker)', money(dipData?.broker_fee || 0), 'From Arrangement Fee', 'Paid to broker', true],
        ['Valuation Fee', money(dipData?.valuation_cost || 0), 'On Instruction', 'Paid to valuer direct', false],
        ['Legal Fee', money(dipData?.legal_cost || 0), 'On Completion', 'Deducted from advance', false]
      ];

      for (const f of fees) {
        y = checkPage(y, 15);
        doc.font(f[4] ? 'Helvetica-Oblique' : 'Helvetica').fontSize(8);
        doc.fillColor(f[4] ? BRAND.textMuted : BRAND.textDark);
        doc.text(f[0], c1, y, { lineBreak: false });
        doc.text(f[1], c2, y, { lineBreak: false });
        doc.text(f[2], c3, y, { lineBreak: false });
        doc.text(f[3], c4, y, { lineBreak: false });
        y += 14;
      }

      // ─── CONDITIONS PRECEDENT ─────────────────────────────────
      y += 6;
      y = checkPage(y, 150);
      y = heading(doc, 'CONDITIONS PRECEDENT', L, y, pageWidth);

      const conds = [
        'Satisfactory independent valuation of the security property',
        'Satisfactory AML/KYC checks on all parties',
        'Satisfactory legal due diligence by Daksfirst\'s appointed solicitors',
        'First legal charge over the property in favour of the lender',
        'Adequate buildings insurance with lender\'s interest noted',
        'Personal guarantee from UBO (for corporate borrowers)',
        'No material adverse change in the borrower\'s circumstances',
        'Payment of all applicable fees as outlined above'
      ];

      doc.font('Helvetica').fontSize(9).fillColor(BRAND.textDark);
      for (const c of conds) {
        y = checkPage(y, 14);
        doc.text('-  ' + c, L + 8, y, { lineBreak: false });
        y += 13;
      }

      // ─── NOTES ────────────────────────────────────────────────
      if (dipData?.notes) {
        y += 6;
        y = checkPage(y, 50);
        y = heading(doc, 'ADDITIONAL NOTES', L, y, pageWidth);
        doc.font('Helvetica').fontSize(9).fillColor(BRAND.textDark);
        doc.text(dipData.notes, L + 8, y, { width: pageWidth - 16 });
        y += doc.heightOfString(dipData.notes, { width: pageWidth - 16 }) + 8;
      }

      // ─── ACCEPTANCE BOX ───────────────────────────────────────
      y += 10;
      y = checkPage(y, 95);
      doc.rect(L, y, pageWidth, 65).lineWidth(1).strokeColor(BRAND.gold).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.navy);
      doc.text('ACCEPTANCE', L + 14, y + 10, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.textDark);
      doc.text('By signing below, the borrower acknowledges receipt of this Decision in Principle and confirms their intention', L + 14, y + 26, { lineBreak: false });
      doc.text('to proceed on the terms outlined above. This DIP is valid for 14 days from the date of issue.', L + 14, y + 38, { lineBreak: false });
      y += 80;

      // Signature lines
      y = checkPage(y, 25);
      doc.moveTo(L, y).lineTo(L + 200, y).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      doc.moveTo(L + 270, y).lineTo(L + pageWidth, y).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(BRAND.textMuted);
      doc.text('Borrower Signature', L, y + 5, { lineBreak: false });
      doc.text('Date', L + 270, y + 5, { lineBreak: false });
      y += 25;

      // ─── DISCLAIMER + COMPANY INFO (as content, not footer) ──
      y += 10;
      y = checkPage(y, 40);
      doc.moveTo(L, y).lineTo(L + pageWidth, y).strokeColor(BRAND.gold).lineWidth(0.5).stroke();
      y += 8;
      doc.font('Helvetica').fontSize(7).fillColor(BRAND.textMuted);
      doc.text('Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com', L, y, { width: pageWidth, align: 'center', lineBreak: false });
      y += 10;
      doc.text('This DIP is indicative only. It is not a formal offer and is subject to full underwriting, valuation and legal due diligence.', L, y, { width: pageWidth, align: 'center', lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function heading(doc, title, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy);
  doc.text(title, x, y, { lineBreak: false });
  y += 15;
  doc.moveTo(x, y).lineTo(x + width, y).strokeColor(BRAND.gold).lineWidth(1.5).stroke();
  return y + 7;
}

function row(doc, label, value, x, y, width) {
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.textMuted);
  doc.text(label, x + 5, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.textDark);
  doc.text(String(value || 'N/A'), x + 190, y, { width: width - 195 });
  const lines = doc.heightOfString(String(value || 'N/A'), { width: width - 195 });
  return y + Math.max(15, lines + 3);
}

module.exports = { generateDipPdf };
