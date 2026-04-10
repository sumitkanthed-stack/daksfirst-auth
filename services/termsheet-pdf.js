/**
 * Termsheet PDF Generator — Daksfirst Branded
 * Uses the full ai_termsheet_data (Claude/Perplexity analysis output)
 * to produce a formal, signable Term Sheet.
 *
 * The ai_termsheet_data.termsheet object contains the structured terms.
 * Additional sections (risks, conditions, market analysis) are pulled
 * from the broader analysis data.
 *
 * Anchor strings "Borrower Signature" and "Guarantor Signature"
 * are placed for DocuSign tab detection.
 */
const PDFDocument = require('pdfkit');

const BRAND = {
  navy: '#1a365d',
  gold: '#c9a84c',
  textDark: '#1a1a2e',
  textMuted: '#555555',
  border: '#d4d4d4',
  lightBg: '#f7fafc'
};

const PAGE = { width: 595.28, height: 841.89, margin: 50 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const CONTENT_BOTTOM = PAGE.height - PAGE.margin - 40;

function money(val) {
  if (!val && val !== 0) return 'N/A';
  if (typeof val === 'string' && val.startsWith('\u00A3')) return val; // Already formatted
  const num = typeof val === 'string' ? parseFloat(val.replace(/[£,]/g, '')) : val;
  if (isNaN(num)) return String(val || 'N/A');
  return '\u00A3' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function safe(val) { return String(val || 'N/A'); }

/**
 * Generate a formal Termsheet PDF from ai_termsheet_data
 * @param {Object} deal - Full deal_submissions row
 * @param {Object} aiData - The full ai_termsheet_data JSON
 * @param {Object} options - { issuedBy, issuedAt }
 * @returns {Promise<Buffer>}
 */
async function generateTermsheetPdf(deal, aiData, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      autoFirstPage: false,
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: {
        Title: `Daksfirst Term Sheet — ${deal.submission_id}`,
        Author: 'Daksfirst Limited',
        Subject: 'Indicative Term Sheet'
      }
    });

    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Pull the structured termsheet from the AI output
    const ts = aiData.termsheet || {};
    const exec = aiData.executiveSummary || {};
    const risks = aiData.risks || [];
    const conditions = ts.conditionsPrecedent || aiData.conditions || [];
    const financial = aiData.financial || [];
    const sensitivity = aiData.sensitivityAnalysis || {};
    const screening = aiData.screeningResults || {};
    const borrowerGrade = aiData.borrowerRiskGrade || {};
    const servicing = aiData.servicingAssessment || {};

    let y = PAGE.margin;
    let pageNum = 0;

    function newPage() {
      doc.addPage();
      pageNum++;
      y = PAGE.margin;
      return y;
    }

    function checkPage(needed) {
      if (y + needed > CONTENT_BOTTOM) {
        doc.fontSize(8).fillColor(BRAND.textMuted)
          .text(`Page ${pageNum}`, PAGE.margin, PAGE.height - PAGE.margin - 10, { lineBreak: false, width: CONTENT_W, align: 'center' });
        return newPage();
      }
      return y;
    }

    function heading(title) {
      y = checkPage(30);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND.navy)
        .text(title, PAGE.margin, y, { lineBreak: false });
      y += 16;
      doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + CONTENT_W, y).strokeColor(BRAND.gold).lineWidth(1.5).stroke();
      y += 10;
      return y;
    }

    function subheading(title) {
      y = checkPage(20);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(BRAND.navy)
        .text(title, PAGE.margin + 8, y, { lineBreak: false });
      y += 14;
      return y;
    }

    function row(label, value, indent = 0) {
      y = checkPage(18);
      const labelX = PAGE.margin + 8 + indent;
      const valueX = PAGE.margin + 190;
      doc.fontSize(9.5).font('Helvetica').fillColor(BRAND.textMuted)
        .text(label, labelX, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fillColor(BRAND.textDark)
        .text(safe(value), valueX, y, { lineBreak: false, width: CONTENT_W - 200 });
      y += 16;
      return y;
    }

    function bulletItem(text) {
      y = checkPage(14);
      doc.fontSize(8.5).font('Helvetica').fillColor(BRAND.textDark)
        .text('  -  ' + text, PAGE.margin + 8, y, { lineBreak: false, width: CONTENT_W - 20 });
      y += 13;
    }

    // Identifiers
    const shortRef = 'DF-' + (deal.submission_id || '').substring(0, 8).toUpperCase();
    const memoRef = aiData.memoRef || shortRef;
    const issueDate = new Date(options.issuedAt || Date.now());
    const dateStr = issueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // ═══════════════════════════════════════════════════════════════
    // PAGE 1 — HEADER + PARTIES + FACILITY
    // ═══════════════════════════════════════════════════════════════
    newPage();

    // Navy header bar
    doc.rect(0, 0, PAGE.width, 70).fill(BRAND.navy);
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
      .text('DAKSFIRST', PAGE.margin, 16, { lineBreak: false });
    doc.fontSize(9).font('Helvetica').fillColor('#cccccc')
      .text('Bridging Finance, Built for Professionals', PAGE.margin, 42, { lineBreak: false });
    doc.fontSize(8).fillColor('#cccccc')
      .text('Ref: ' + memoRef, PAGE.width - PAGE.margin - 150, 22, { lineBreak: false, width: 150, align: 'right' });
    doc.fontSize(7).fillColor('#999999')
      .text(aiData.decision ? 'Decision: ' + aiData.decision : '', PAGE.width - PAGE.margin - 150, 36, { lineBreak: false, width: 150, align: 'right' });

    // Gold accent
    doc.rect(0, 70, PAGE.width, 3).fill(BRAND.gold);
    y = 90;

    // Title
    doc.fontSize(20).font('Helvetica-Bold').fillColor(BRAND.navy)
      .text('INDICATIVE TERM SHEET', PAGE.margin, y, { lineBreak: false, width: CONTENT_W, align: 'center' });
    y += 26;
    doc.fontSize(9).font('Helvetica').fillColor(BRAND.textMuted)
      .text('This Term Sheet sets out the indicative terms on which the Lender is prepared to make', PAGE.margin, y, { lineBreak: false, width: CONTENT_W, align: 'center' });
    y += 12;
    doc.text('available a bridging loan facility, subject to satisfactory completion of all conditions precedent.', PAGE.margin, y, { lineBreak: false, width: CONTENT_W, align: 'center' });
    y += 18;
    doc.fontSize(9).font('Helvetica').fillColor(BRAND.textDark)
      .text('Date: ' + dateStr, PAGE.width - PAGE.margin - 200, y, { lineBreak: false, width: 200, align: 'right' });
    y += 22;

    // ── PARTIES ──
    heading('PARTIES');
    row('Lender', ts.lender || 'Daksfirst Limited');
    row('Borrower', ts.borrower || deal.company_name || deal.borrower_name);
    if (deal.company_number) row('Company Number', deal.company_number);
    row('Guarantor(s)', ts.guarantors || 'As per credit approval');
    if (deal.broker_name) {
      row('Introducing Broker', deal.broker_name + (deal.broker_company ? ' (' + deal.broker_company + ')' : ''));
    }
    y += 4;

    // ── FACILITY ──
    heading('FACILITY');
    row('Facility Type', ts.facilityType || 'Bridge Loan');
    row('Gross Loan Amount', money(ts.grossLoan) !== 'N/A' ? money(ts.grossLoan) : money(deal.loan_amount));
    if (ts.netLoan) row('Net Loan Amount', money(ts.netLoan));
    row('Purpose', deal.loan_purpose || ts.purpose || 'Bridge finance');
    row('Minimum Term', safe(ts.minTerm));
    row('Maximum Term', safe(ts.maxTerm));
    y += 4;

    // ── PRICING ──
    heading('PRICING');
    if (ts.discountedRate) row('Discounted Rate', ts.discountedRate + ' per month');
    row('Standard Rate', safe(ts.standardRate) + (ts.standardRate && !ts.standardRate.includes('month') ? ' per month' : ''));
    row('Default Rate', safe(ts.defaultRate));
    row('Interest Basis', ts.interestBasis || 'Rolled-up');
    if (ts.interestRetention) row('Interest Retention', ts.interestRetention);
    if (ts.nonUtilFee) row('Non-Utilisation Fee', ts.nonUtilFee);
    y += 4;

    // ── SECURITY ──
    heading('SECURITY');
    row('Property Address', ts.securityAddress || deal.security_address);
    row('Property Type', ts.propertyType || deal.asset_type);
    row('Tenure', ts.tenure || deal.property_tenure || 'TBC');
    row('Open Market Value', money(ts.omv) !== 'N/A' ? money(ts.omv) : money(deal.current_value));
    if (ts.gdv) row('Gross Development Value', money(ts.gdv));
    row('Gross LTV', safe(ts.gltv));
    if (ts.minSecurityValue) row('Min Security Value', money(ts.minSecurityValue));
    row('Security Package', ts.securityPackage || 'First Legal Charge');
    if (ts.additionalSecurity) row('Additional Security', ts.additionalSecurity);
    if (ts.spvRequired) row('SPV Required', ts.spvRequired);
    y += 4;

    // ── DRAWDOWN STRUCTURE ──
    if (ts.drawdownStructure || ts.day1Release || ts.stagedDrawdowns) {
      heading('DRAWDOWN STRUCTURE');
      if (ts.day1Release) row('Day 1 Release', money(ts.day1Release));
      if (ts.stagedDrawdowns) row('Staged Drawdowns', ts.stagedDrawdowns);
      if (ts.retainedWorkingCapital) row('Retained Working Capital', money(ts.retainedWorkingCapital));
      if (ts.drawdownStructure) row('Structure', ts.drawdownStructure);
      y += 4;
    }

    // ── FEE SCHEDULE ──
    heading('FEE SCHEDULE');

    // Table header
    y = checkPage(22);
    const cols = [PAGE.margin + 8, PAGE.margin + 180, PAGE.margin + 310];
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(BRAND.navy);
    doc.text('Fee', cols[0], y, { lineBreak: false });
    doc.text('Amount', cols[1], y, { lineBreak: false });
    doc.text('When Due', cols[2], y, { lineBreak: false });
    y += 14;
    doc.moveTo(cols[0], y).lineTo(PAGE.margin + CONTENT_W - 8, y).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    y += 6;

    function feeRow(name, amount, when, italic) {
      y = checkPage(15);
      doc.fontSize(8.5).font(italic ? 'Helvetica-Oblique' : 'Helvetica').fillColor(italic ? BRAND.textMuted : BRAND.textDark);
      doc.text(name, cols[0] + (italic ? 10 : 0), y, { lineBreak: false });
      doc.text(safe(amount), cols[1], y, { lineBreak: false });
      doc.font('Helvetica').fillColor(BRAND.textMuted);
      doc.text(safe(when), cols[2], y, { lineBreak: false });
      y += 14;
    }

    feeRow('Arrangement Fee', ts.arrangementFee, 'On Completion');
    if (ts.brokerFee) feeRow('(of which Broker Fee)', ts.brokerFee, 'From Arrangement Fee', true);
    if (ts.underwritingFee) feeRow('Underwriting Fee', ts.underwritingFee, 'Upfront on signing');
    if (ts.valuationFee) feeRow('Valuation Fee', ts.valuationFee, 'On Instruction');
    if (ts.legalFees) feeRow('Legal Fees', ts.legalFees, 'On Completion');
    if (ts.exitFee) feeRow('Exit Fee', ts.exitFee, 'On Redemption');
    y += 6;

    // ── EXIT STRATEGY ──
    heading('EXIT STRATEGY');
    row('Primary Exit', ts.primaryExit || deal.exit_strategy || 'N/A');
    if (ts.extensionOption) row('Extension Option', ts.extensionOption);
    if (ts.prepayment) row('Prepayment', ts.prepayment);

    // Exit viability from sensitivity analysis
    const exit = sensitivity.exitViability || {};
    if (exit.refinanceFeasible) row('Refinance Feasible', exit.refinanceFeasible);
    if (exit.saleExitFeasible) row('Sale Exit Feasible', exit.saleExitFeasible);
    if (exit.exitRiskRating) row('Exit Risk Rating', exit.exitRiskRating);
    y += 4;

    // ── BORROWER RISK GRADE (if available) ──
    if (borrowerGrade.grade) {
      heading('BORROWER RISK ASSESSMENT');
      row('Risk Grade', borrowerGrade.grade + ' — ' + (borrowerGrade.descriptor || ''));
      if (borrowerGrade.creditScore) row('Credit Score', borrowerGrade.creditScore);
      if (borrowerGrade.incomeStrength) row('Income Strength', borrowerGrade.incomeStrength);
      if (borrowerGrade.assetStrength) row('Asset Strength', borrowerGrade.assetStrength);
      if (borrowerGrade.experienceScore) row('Experience', borrowerGrade.experienceScore);
      if (borrowerGrade.rationale) {
        y = checkPage(20);
        doc.fontSize(8.5).font('Helvetica-Oblique').fillColor(BRAND.textMuted)
          .text(borrowerGrade.rationale, PAGE.margin + 8, y, { lineBreak: false, width: CONTENT_W - 16 });
        y += 18;
      }
      y += 4;
    }

    // ── KEY FINANCIAL METRICS ──
    if (financial.length > 0) {
      heading('KEY FINANCIAL METRICS');
      for (const f of financial) {
        if (f.metric && f.scenarioA) {
          row(f.metric, f.scenarioA);
        }
      }
      y += 4;
    }

    // ── KEY RISKS & MITIGANTS (top 5) ──
    if (risks.length > 0) {
      heading('KEY RISKS & MITIGANTS');

      y = checkPage(20);
      const rCols = [PAGE.margin + 8, PAGE.margin + 60, PAGE.margin + 200, PAGE.margin + 280];
      doc.fontSize(8).font('Helvetica-Bold').fillColor(BRAND.navy);
      doc.text('#', rCols[0], y, { lineBreak: false });
      doc.text('Risk', rCols[1], y, { lineBreak: false });
      doc.text('Severity', rCols[2], y, { lineBreak: false });
      doc.text('Mitigant', rCols[3], y, { lineBreak: false });
      y += 12;
      doc.moveTo(rCols[0], y).lineTo(PAGE.margin + CONTENT_W - 8, y).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      y += 5;

      const topRisks = risks.slice(0, 5);
      for (const r of topRisks) {
        y = checkPage(28);
        doc.fontSize(8).font('Helvetica').fillColor(BRAND.textDark);
        doc.text(String(r.num || ''), rCols[0], y, { lineBreak: false });
        doc.font('Helvetica-Bold').text(safe(r.risk), rCols[1], y, { lineBreak: false, width: 135 });
        // Severity colour
        const sevColor = r.severity === 'Critical' ? '#dc2626' : r.severity === 'High' ? '#ea580c' : r.severity === 'Medium' ? '#d97706' : '#059669';
        doc.font('Helvetica-Bold').fillColor(sevColor).text(safe(r.severity), rCols[2], y, { lineBreak: false });
        doc.font('Helvetica').fillColor(BRAND.textMuted).text(safe(r.mitigant), rCols[3], y, { lineBreak: false, width: CONTENT_W - 290 });
        y += 22;
      }
      y += 4;
    }

    // ── CONDITIONS PRECEDENT ──
    heading('CONDITIONS PRECEDENT');
    if (conditions.length > 0) {
      for (const cp of conditions) {
        bulletItem(cp);
      }
    } else {
      // Standard CPs
      const stdCPs = [
        'Satisfactory independent valuation of the security property',
        'Satisfactory AML/KYC checks on all parties',
        'Satisfactory legal due diligence by the Lender\'s appointed solicitors',
        'First legal charge over the property in favour of the Lender',
        'Adequate buildings insurance with Lender\'s interest noted',
        'Personal guarantee from all named guarantor(s)',
        'No material adverse change in the Borrower\'s circumstances',
        'Payment of all applicable fees as outlined above',
        'Certified board resolution authorising the borrowing (corporate borrowers)'
      ];
      for (const cp of stdCPs) { bulletItem(cp); }
    }
    y += 6;

    // ── GENERAL TERMS ──
    heading('GENERAL TERMS');
    const generalTerms = [
      'This Term Sheet is indicative only and does not constitute a binding commitment to lend.',
      'The facility is subject to satisfactory completion of all conditions precedent.',
      'The Lender reserves the right to withdraw or amend this Term Sheet at any time prior to completion.',
      'All fees are non-refundable once paid unless otherwise stated.',
      'Interest accrues from the date of drawdown. Default interest applies at the default rate above.',
      'The Borrower bears all transaction costs including legal, valuation and insurance.',
      'This Term Sheet is governed by the laws of England and Wales.',
      'This Term Sheet is valid for 14 days from the date of issue.'
    ];
    for (const t of generalTerms) { bulletItem(t); }
    y += 10;

    // ── ACCEPTANCE & SIGNATURES ──
    heading('ACCEPTANCE');

    y = checkPage(28);
    doc.fontSize(9).font('Helvetica').fillColor(BRAND.textDark)
      .text('By signing below, the parties acknowledge and accept the indicative terms set out in this', PAGE.margin + 8, y, { lineBreak: false, width: CONTENT_W - 16 });
    y += 13;
    doc.text('Term Sheet and confirm their intention to proceed to formal facility documentation.', PAGE.margin + 8, y, { lineBreak: false, width: CONTENT_W - 16 });
    y += 30;

    // Borrower signature
    y = checkPage(65);
    doc.moveTo(PAGE.margin + 8, y + 20).lineTo(PAGE.margin + 220, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.moveTo(PAGE.margin + 280, y + 20).lineTo(PAGE.margin + CONTENT_W - 8, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.fontSize(8.5).font('Helvetica').fillColor(BRAND.textMuted)
      .text('Borrower Signature', PAGE.margin + 8, y + 26, { lineBreak: false });
    doc.text('Date', PAGE.margin + 280, y + 26, { lineBreak: false });
    const borrowerLabel = ts.borrower || deal.company_name || deal.borrower_name || 'The Borrower';
    doc.fontSize(8).fillColor(BRAND.textMuted)
      .text('For and on behalf of: ' + borrowerLabel, PAGE.margin + 8, y + 40, { lineBreak: false });
    y += 65;

    // Guarantor signature
    y = checkPage(65);
    doc.moveTo(PAGE.margin + 8, y + 20).lineTo(PAGE.margin + 220, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.moveTo(PAGE.margin + 280, y + 20).lineTo(PAGE.margin + CONTENT_W - 8, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.fontSize(8.5).font('Helvetica').fillColor(BRAND.textMuted)
      .text('Guarantor Signature', PAGE.margin + 8, y + 26, { lineBreak: false });
    doc.text('Date', PAGE.margin + 280, y + 26, { lineBreak: false });
    doc.fontSize(8).fillColor(BRAND.textMuted)
      .text(ts.guarantors || 'Personal Guarantor', PAGE.margin + 8, y + 40, { lineBreak: false });
    y += 65;

    // Lender signature
    y = checkPage(65);
    doc.moveTo(PAGE.margin + 8, y + 20).lineTo(PAGE.margin + 220, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.moveTo(PAGE.margin + 280, y + 20).lineTo(PAGE.margin + CONTENT_W - 8, y + 20).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    doc.fontSize(8.5).font('Helvetica').fillColor(BRAND.textMuted)
      .text('For and on behalf of Daksfirst Limited', PAGE.margin + 8, y + 26, { lineBreak: false });
    doc.text('Date', PAGE.margin + 280, y + 26, { lineBreak: false });
    y += 70;

    // ── FOOTER ──
    y = checkPage(40);
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + CONTENT_W, y).strokeColor(BRAND.border).lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(7.5).font('Helvetica').fillColor(BRAND.textMuted)
      .text('Daksfirst Limited  |  8 Hill Street, Mayfair, London W1J 5NG  |  FCA Reg: 937220  |  portal@daksfirst.com', PAGE.margin, y, { lineBreak: false, width: CONTENT_W, align: 'center' });
    y += 12;
    doc.text('This Term Sheet is indicative only. It does not constitute a formal offer and is subject to full underwriting, valuation and legal due diligence.', PAGE.margin, y, { lineBreak: false, width: CONTENT_W, align: 'center' });

    // Page number
    doc.fontSize(8).fillColor(BRAND.textMuted)
      .text(`Page ${pageNum}`, PAGE.margin, PAGE.height - PAGE.margin - 10, { lineBreak: false, width: CONTENT_W, align: 'center' });

    doc.end();
  });
}

module.exports = { generateTermsheetPdf };
