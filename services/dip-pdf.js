/**
 * DIP PDF Generator — Daksfirst Branded
 * Generates a professional DIP letter as a PDF buffer using PDFKit
 */
const PDFDocument = require('pdfkit');

const BRAND = {
  navy: '#1a365d',
  gold: '#c9a84c',
  darkGold: '#a88a3c',
  lightBg: '#f8f6f0',
  textDark: '#1a1a2e',
  textMuted: '#555555',
  border: '#d4d4d4'
};

/**
 * Format a number as £X,XXX
 */
function money(val) {
  if (!val && val !== 0) return 'N/A';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return 'N/A';
  return '£' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  if (!val && val !== 0) return 'N/A';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return 'N/A';
  return num.toFixed(2) + '%';
}

/**
 * Generate DIP PDF and return as Buffer
 * @param {Object} deal - The deal_submissions row
 * @param {Object} dipData - The structured DIP data from the form
 * @param {Object} options - { issuedBy, issuedAt }
 * @returns {Promise<Buffer>}
 */
async function generateDipPdf(deal, dipData, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 55, right: 55 },
        info: {
          Title: `DIP - ${deal.submission_id || 'Daksfirst'}`,
          Author: 'Daksfirst Limited',
          Subject: 'Decision in Principle',
          Creator: 'Daksfirst Portal'
        }
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const leftMargin = doc.page.margins.left;

      // ─── HEADER ───────────────────────────────────────────────
      // Navy bar
      doc.rect(0, 0, doc.page.width, 90).fill(BRAND.navy);
      // Gold accent line
      doc.rect(0, 90, doc.page.width, 4).fill(BRAND.gold);

      // Company name in header
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff');
      doc.text('DAKSFIRST', leftMargin, 25, { width: pageWidth });
      doc.font('Helvetica').fontSize(10).fillColor(BRAND.gold);
      doc.text('Bridging Finance, Built for Professionals', leftMargin, 52, { width: pageWidth });

      // Deal reference top-right
      doc.font('Helvetica').fontSize(9).fillColor('#cccccc');
      doc.text(`Ref: ${deal.submission_id || 'N/A'}`, leftMargin, 70, { width: pageWidth, align: 'right' });

      // ─── TITLE ────────────────────────────────────────────────
      doc.moveDown(2);
      const titleY = 115;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.navy);
      doc.text('DECISION IN PRINCIPLE', leftMargin, titleY, { width: pageWidth, align: 'center' });

      doc.font('Helvetica').fontSize(10).fillColor(BRAND.textMuted);
      doc.text('This document is indicative only and does not constitute a binding offer of finance.', leftMargin, titleY + 28, { width: pageWidth, align: 'center' });

      // Date
      const issuedDate = options.issuedAt ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      doc.font('Helvetica').fontSize(10).fillColor(BRAND.textDark);
      doc.text(`Date: ${issuedDate}`, leftMargin, titleY + 52, { width: pageWidth, align: 'right' });

      // ─── BORROWER SECTION ─────────────────────────────────────
      let y = titleY + 78;
      y = sectionHeader(doc, 'BORROWER', leftMargin, y, pageWidth);

      const borrowerType = deal.borrower_type || 'individual';
      if (borrowerType === 'company' || borrowerType === 'corporate') {
        y = tableRow(doc, 'Corporate Borrower', deal.company_name || deal.borrower_company || 'N/A', leftMargin, y, pageWidth);
        y = tableRow(doc, 'Company Number', deal.company_number || 'N/A', leftMargin, y, pageWidth);
        y = tableRow(doc, 'Ultimate Beneficial Owner (UBO)', deal.borrower_name || 'N/A', leftMargin, y, pageWidth);
      } else {
        y = tableRow(doc, 'Borrower', deal.borrower_name || 'N/A', leftMargin, y, pageWidth);
      }

      // Additional borrowers from dipData
      if (dipData && dipData.borrowers && dipData.borrowers.length > 0) {
        for (const b of dipData.borrowers) {
          const roleLabel = (b.role || 'borrower').charAt(0).toUpperCase() + (b.role || 'borrower').slice(1);
          const kycStatus = b.kyc_verified ? 'KYC Verified' : 'KYC Pending';
          y = tableRow(doc, `${roleLabel}`, `${b.name || 'N/A'} — ${kycStatus}`, leftMargin, y, pageWidth);
        }
      }

      // ─── SECURITY SECTION ─────────────────────────────────────
      y += 8;
      y = sectionHeader(doc, 'SECURITY', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Property Address', deal.security_address || 'N/A', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Postcode', deal.security_postcode || 'N/A', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Asset Type', deal.asset_type || 'N/A', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Tenure', deal.property_tenure || 'N/A', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Current Use', deal.current_use || 'N/A', leftMargin, y, pageWidth);

      // ─── LOAN TERMS ───────────────────────────────────────────
      y += 8;
      y = sectionHeader(doc, 'INDICATIVE LOAN TERMS', leftMargin, y, pageWidth);

      const loanAmount = dipData?.loan_amount || deal.loan_amount;
      const propertyValue = dipData?.property_value || deal.current_value;
      const termMonths = dipData?.term_months || deal.term_months;
      const rateMonthly = dipData?.rate_monthly || deal.rate_requested;
      const ltv = dipData?.ltv || deal.ltv_requested;
      const interestServicing = dipData?.interest_servicing || deal.interest_servicing || 'Retained';
      const exitStrategy = dipData?.exit_strategy || deal.exit_strategy;

      y = tableRow(doc, 'Loan Amount', money(loanAmount), leftMargin, y, pageWidth);
      y = tableRow(doc, 'Property Valuation', money(propertyValue), leftMargin, y, pageWidth);
      y = tableRow(doc, 'Day 1 LTV', pct(ltv), leftMargin, y, pageWidth);
      y = tableRow(doc, 'Term', `${termMonths || 'N/A'} months`, leftMargin, y, pageWidth);
      y = tableRow(doc, 'Interest Rate', `${rateMonthly || 'N/A'}% per month`, leftMargin, y, pageWidth);
      y = tableRow(doc, 'Interest Servicing', interestServicing, leftMargin, y, pageWidth);
      y = tableRow(doc, 'Exit Strategy', exitStrategy || 'N/A', leftMargin, y, pageWidth);

      // ─── SECURITY & GUARANTEE ─────────────────────────────────
      y += 8;
      y = sectionHeader(doc, 'SECURITY & GUARANTEE STRUCTURE', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Charge Type', dipData?.fixed_charge || 'First Legal Charge', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Debenture', 'Required (for corporate borrowers)', leftMargin, y, pageWidth);
      y = tableRow(doc, 'Personal Guarantee', dipData?.pg_ubo || 'Required from UBO', leftMargin, y, pageWidth);
      if (dipData?.additional_security) {
        y = tableRow(doc, 'Additional Security', dipData.additional_security, leftMargin, y, pageWidth);
      }

      // ─── Check if we need a new page ──────────────────────────
      if (y > 620) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      // ─── FEE SCHEDULE ─────────────────────────────────────────
      y += 8;
      y = sectionHeader(doc, 'FEE SCHEDULE', leftMargin, y, pageWidth);

      // Fee table header
      doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.navy);
      const col1 = leftMargin;
      const col2 = leftMargin + 150;
      const col3 = leftMargin + 280;
      const col4 = leftMargin + 390;
      doc.text('Fee', col1, y, { width: 145 });
      doc.text('Amount', col2, y, { width: 125 });
      doc.text('When Due', col3, y, { width: 105 });
      doc.text('Payment Trigger', col4, y, { width: 95 });
      y += 14;
      doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).strokeColor(BRAND.gold).lineWidth(1).stroke();
      y += 6;

      // Fee rows
      const arrangementFee = dipData?.arrangement_fee || 0;
      const brokerFee = dipData?.broker_fee || 0;
      const valuationFee = dipData?.valuation_cost || 0;
      const legalFee = dipData?.legal_cost || 0;
      const onboardingFee = dipData?.fee_onboarding || 0;
      const commitmentFee = dipData?.fee_commitment || 0;

      const fees = [
        { name: 'Onboarding Fee', amount: money(onboardingFee), when: 'Before Credit Review', trigger: 'Gates credit review' },
        { name: 'Commitment Fee', amount: money(commitmentFee), when: 'Before Underwriting', trigger: 'Gates underwriting' },
        { name: 'Arrangement Fee', amount: money(arrangementFee), when: 'On Completion', trigger: 'Deducted from advance' },
        { name: '  ↳ of which Broker Fee', amount: money(brokerFee), when: '(from Arrangement Fee)', trigger: 'Paid to broker on completion' },
        { name: 'Valuation Fee', amount: money(valuationFee), when: 'On Instruction', trigger: 'Paid to valuer direct' },
        { name: 'Legal Fee', amount: money(legalFee), when: 'On Completion', trigger: 'Deducted from advance' }
      ];

      doc.font('Helvetica').fontSize(8).fillColor(BRAND.textDark);
      for (const fee of fees) {
        const isBrokerSub = fee.name.startsWith('  ');
        if (isBrokerSub) doc.fillColor(BRAND.textMuted);
        else doc.fillColor(BRAND.textDark);

        doc.text(fee.name, col1, y, { width: 145 });
        doc.text(fee.amount, col2, y, { width: 125 });
        doc.text(fee.when, col3, y, { width: 105 });
        doc.text(fee.trigger, col4, y, { width: 95 });
        y += 14;
      }

      // ─── Check page again ─────────────────────────────────────
      if (y > 620) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      // ─── CONDITIONS PRECEDENT ─────────────────────────────────
      y += 10;
      y = sectionHeader(doc, 'CONDITIONS PRECEDENT', leftMargin, y, pageWidth);

      const conditions = [
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
      for (const cond of conditions) {
        doc.text('•  ' + cond, leftMargin + 10, y, { width: pageWidth - 20 });
        y += 15;
      }

      // ─── NOTES ────────────────────────────────────────────────
      if (dipData?.notes) {
        y += 8;
        y = sectionHeader(doc, 'ADDITIONAL NOTES', leftMargin, y, pageWidth);
        doc.font('Helvetica').fontSize(9).fillColor(BRAND.textDark);
        doc.text(dipData.notes, leftMargin + 10, y, { width: pageWidth - 20 });
        y += doc.heightOfString(dipData.notes, { width: pageWidth - 20 }) + 10;
      }

      // ─── Check page ───────────────────────────────────────────
      if (y > 650) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      // ─── ACCEPTANCE ───────────────────────────────────────────
      y += 15;
      doc.rect(leftMargin, y, pageWidth, 80).lineWidth(1).strokeColor(BRAND.gold).stroke();
      y += 10;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.navy);
      doc.text('ACCEPTANCE', leftMargin + 15, y, { width: pageWidth - 30 });
      y += 18;
      doc.font('Helvetica').fontSize(9).fillColor(BRAND.textDark);
      doc.text('By signing below, the borrower acknowledges receipt of this Decision in Principle and confirms their intention to proceed on the terms outlined above. This DIP is valid for 14 days from the date of issue.', leftMargin + 15, y, { width: pageWidth - 30 });
      y += 40;

      // Signature lines
      y += 25;
      const sigLineY = y;
      doc.moveTo(leftMargin, sigLineY).lineTo(leftMargin + 200, sigLineY).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      doc.moveTo(leftMargin + 270, sigLineY).lineTo(leftMargin + pageWidth, sigLineY).stroke();

      doc.font('Helvetica').fontSize(8).fillColor(BRAND.textMuted);
      doc.text('Borrower Signature', leftMargin, sigLineY + 5, { width: 200 });
      doc.text('Date', leftMargin + 270, sigLineY + 5, { width: 200 });

      // ─── FOOTER ───────────────────────────────────────────────
      const footerY = doc.page.height - 50;
      doc.rect(0, footerY - 5, doc.page.width, 55).fill(BRAND.navy);
      doc.font('Helvetica').fontSize(7).fillColor('#cccccc');
      doc.text(
        'Daksfirst Limited | 8 Hill Street, Mayfair, London W1J 5NG | FCA Reg: 937220 | portal@daksfirst.com',
        0, footerY + 5,
        { width: doc.page.width, align: 'center' }
      );
      doc.text(
        'This document is a Decision in Principle only. It is not a formal offer of finance and is subject to full underwriting, valuation and legal due diligence.',
        0, footerY + 18,
        { width: doc.page.width, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── HELPER: Section Header ─────────────────────────────────────
function sectionHeader(doc, title, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy);
  doc.text(title, x, y, { width });
  y += 16;
  doc.moveTo(x, y).lineTo(x + width, y).strokeColor(BRAND.gold).lineWidth(1.5).stroke();
  y += 8;
  return y;
}

// ─── HELPER: Table Row ──────────────────────────────────────────
function tableRow(doc, label, value, x, y, width) {
  const labelWidth = 180;
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.textMuted);
  doc.text(label, x + 5, y, { width: labelWidth });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.textDark);
  doc.text(value || 'N/A', x + labelWidth + 10, y, { width: width - labelWidth - 15 });
  return y + 16;
}

module.exports = { generateDipPdf };
