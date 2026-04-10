/**
 * DIP DOCX Generator — Daksfirst Branded with VML Letterhead
 *
 * Generates a professional Word document matching the termsheet template:
 * Garamond font, navy/gold branding, VML letterhead injection,
 * branded footer, alternating row colours, amber TBC highlighting.
 *
 * Mirrors termsheet-doc.js structure but with DIP-specific content.
 */

const fs   = require('fs');
const path = require('path');
const JSZip = require('jszip');

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
} = require('docx');

// ── Colours (matches termsheet-doc.js exactly) ───────────────────
const NAVY  = '1F3864';
const GOLD  = 'C9A227';
const LGREY = 'F2F2F2';
const WHITE = 'FFFFFF';
const RED   = 'C00000';
const AMBER = 'E26B0A';
const MGREY = 'D9D9D9';
const BLACK = '000000';

// ── Borders ────────────────────────────────────────────────────────
const thin    = { style: BorderStyle.SINGLE, size: 4,  color: 'CCCCCC' };
const none    = { style: BorderStyle.NONE,   size: 0,  color: 'FFFFFF' };
const allThin = { top: thin, bottom: thin, left: thin, right: thin };
const allNone = { top: none, bottom: none, left: none, right: none };

// ── Page dims ──────────────────────────────────────────────────────
const PAGE_W  = 11906;
const MARGIN  = 1200;
const CONTENT = PAGE_W - MARGIN * 2;

// ── VML Letterhead (loaded once) ──────────────────────────────────
let LH_VML_P       = '';
let LH_IMG         = null;
let LH_FOOTER_XML  = null;
let LH_FOOTER_RELS = null;
let LH_LOADED      = false;

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
    if (!buf) { console.warn('[dip-doc] letterhead_template.docx not found'); return; }

    const zip = await JSZip.loadAsync(buf);
    const imgFile = zip.file('word/media/image1.png');
    if (imgFile) LH_IMG = await imgFile.async('nodebuffer');

    const docXml = await zip.file('word/document.xml').async('string');
    const pMatch = docXml.match(/<w:p[ >][\s\S]*?<\/w:p>/);
    if (pMatch) LH_VML_P = pMatch[0].replace(/r:id="rId7"/g, 'r:id="rIdLH_img"');

    const footerFile = zip.file('word/footer1.xml');
    if (footerFile) LH_FOOTER_XML = await footerFile.async('string');
    const footerRelsFile = zip.file('word/_rels/footer1.xml.rels');
    if (footerRelsFile) LH_FOOTER_RELS = await footerRelsFile.async('string');

    LH_LOADED = true;
    console.log('[dip-doc] VML letterhead loaded OK');
  } catch (e) {
    console.warn('[dip-doc] letterhead load failed:', e.message);
  }
})();

// ── Helpers ────────────────────────────────────────────────────────

const clean = (val) => {
  if (val === null || val === undefined) return '\u2014';
  return String(val)
    .replace(/â€"/g, '\u2014').replace(/â€˜/g, '\u2018').replace(/â€™/g, '\u2019')
    .replace(/â€œ/g, '\u201c').replace(/â€/g, '\u201d').replace(/Â£/g, '\u00a3')
    .replace(/Â·/g, '\u00b7').replace(/âš /g, '\u26a0').replace(/âœ"/g, '\u2713')
    .replace(/âœ—/g, '\u2717')
    .trim() || '\u2014';
};

const money = (val) => {
  if (!val && val !== 0) return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : val;
  if (isNaN(num)) return '\u2014';
  return '\u00A3' + num.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const pct = (val) => {
  if (!val && val !== 0) return '\u2014';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '\u2014';
  return num.toFixed(2) + '%';
};

const cellFn = (text, w, opts = {}) => new TableCell({
  width:   { size: w, type: WidthType.DXA },
  borders: opts.borders || allThin,
  shading: { fill: opts.fill || WHITE, type: ShadingType.CLEAR },
  margins: { top: opts.mt || 80, bottom: opts.mb || 80, left: 120, right: 120 },
  verticalAlign: opts.vAlign || VerticalAlign.CENTER,
  columnSpan: opts.span,
  children: [new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: 0, after: 0 },
    children: [new TextRun({
      text:    clean(text),
      bold:    opts.bold   || false,
      size:    opts.size   || 18,
      color:   opts.color  || BLACK,
      font:    'Garamond',
      italics: opts.italic || false,
    })]
  })]
});

const dipCell = (text, w, i) => {
  const val   = clean(text);
  const isTBC = /^(tbc|unknown|not provided|n\/a|tbd|\u2014)/i.test(val.trim());
  return cellFn(val, w, {
    fill:   isTBC ? 'FFFBEB' : (i % 2 ? LGREY : WHITE),
    color:  isTBC ? AMBER    : BLACK,
    size:   18,
    italic: isTBC,
  });
};

const p = (text, opts = {}) => new Paragraph({
  alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
  spacing:   { before: opts.before ?? 60, after: opts.after ?? 60 },
  border:    opts.border,
  shading:   opts.shade ? { fill: opts.shade, type: ShadingType.CLEAR } : undefined,
  children:  [new TextRun({
    text:    clean(text),
    bold:    opts.bold   || false,
    size:    opts.size   || 20,
    color:   opts.color  || BLACK,
    font:    'Garamond',
    italics: opts.italic || false,
  })]
});

const space = (n = 100) => new Paragraph({ spacing: { before: n, after: 0 }, children: [] });

// ═══════════════════════════════════════════════════════════════════
// BUILD DIP DOCX
// ═══════════════════════════════════════════════════════════════════

function buildDip(deal, dipData, options = {}) {
  const ch = [];
  const W  = CONTENT;
  const L  = 3400;
  const R  = W - L;

  const dipRow = (label, value, i) => new TableRow({ children: [
    cellFn(label, L, { bold: true, fill: i % 2 ? LGREY : WHITE, size: 18 }),
    dipCell(value || '\u2014', R, i),
  ]});

  const sectionHeader = (title) => new TableRow({ children: [
    new TableCell({
      width: { size: W, type: WidthType.DXA },
      columnSpan: 2,
      borders: allNone,
      shading: { fill: NAVY, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 18, color: WHITE, font: 'Garamond' })]
      })]
    })
  ]});

  // ── Subtitle with gold underline ──
  ch.push(new Paragraph({
    spacing: { before: 1400, after: 40 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GOLD, space: 4 } },
    children: [new TextRun({
      text: 'Senior Secured Real Estate Credit & Structured Finance',
      bold: false, italics: true, size: 22, color: MGREY, font: 'Garamond',
    })]
  }));

  ch.push(space(60));

  // ── Title ──
  ch.push(p('DECISION IN PRINCIPLE', { bold: true, size: 32, color: NAVY, center: true, before: 0, after: 80 }));

  // ── Disclaimer ──
  ch.push(new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({
      text: 'Please note that this Decision in Principle is indicative only and does not constitute a commitment or an offer by the Lender to provide finance. The decision to provide financing is subject to full underwriting, valuation, due diligence, credit committee approval and final documentation satisfactory to the Lender.',
      bold: false, italics: true, size: 16, color: MGREY, font: 'Garamond',
    })]
  }));

  // ── Date ──
  const dateStr = options.issuedAt
    ? new Date(options.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  ch.push(p(`Date: ${dateStr}`, { bold: true, size: 18, before: 40, after: 100 }));

  // ── Reference ──
  ch.push(p(`Reference: ${deal.submission_id || '\u2014'}`, { bold: true, size: 18, before: 0, after: 60 }));

  // ── Borrower table ──
  const borrowerType = (deal.borrower_type || 'individual').toLowerCase();
  const borrowerRows = [];
  borrowerRows.push(sectionHeader('Borrower Details'));
  let ri = 0;
  borrowerRows.push(dipRow('Borrower Name', deal.borrower_name, ri++));
  if (borrowerType === 'corporate' || deal.borrower_company || deal.company_name) {
    borrowerRows.push(dipRow('Borrower Type', 'Corporate (SPV / Limited Company)', ri++));
    borrowerRows.push(dipRow('Company Name', deal.borrower_company || deal.company_name, ri++));
    borrowerRows.push(dipRow('Company Number', deal.company_number, ri++));
  } else {
    borrowerRows.push(dipRow('Borrower Type', 'Individual', ri++));
  }
  borrowerRows.push(dipRow('Borrower Email', deal.borrower_email, ri++));
  borrowerRows.push(dipRow('Borrower Phone', deal.borrower_phone, ri++));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows: borrowerRows,
  }));
  ch.push(space(80));

  // ── Property & Valuation ──
  const propRows = [];
  propRows.push(sectionHeader('Property & Valuation'));
  ri = 0;
  propRows.push(dipRow('Security Address', deal.security_address, ri++));
  propRows.push(dipRow('Postcode', deal.security_postcode, ri++));
  propRows.push(dipRow('Asset Type', deal.asset_type, ri++));
  propRows.push(dipRow('Property Value (OMV)', money(dipData.property_value || deal.current_value), ri++));
  if (deal.purchase_price) propRows.push(dipRow('Purchase Price', money(deal.purchase_price), ri++));
  propRows.push(dipRow('Tenure', deal.property_tenure, ri++));
  propRows.push(dipRow('Current Use / Occupancy', deal.current_use || deal.occupancy_status, ri++));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows: propRows,
  }));
  ch.push(space(80));

  // ── Indicative Loan Terms ──
  const loanRows = [];
  loanRows.push(sectionHeader('Indicative Loan Terms'));
  ri = 0;
  loanRows.push(dipRow('Gross Loan Amount', money(dipData.loan_amount || deal.loan_amount), ri++));
  loanRows.push(dipRow('Loan To Value (LTV)', pct(dipData.ltv || deal.ltv_requested), ri++));
  loanRows.push(dipRow('Term', (dipData.term_months || deal.term_months || '\u2014') + ' months', ri++));
  loanRows.push(dipRow('Interest Rate', pct(dipData.rate_monthly || deal.rate_requested) + ' per month', ri++));
  loanRows.push(dipRow('Interest Servicing', dipData.interest_servicing || deal.interest_servicing || 'Retained', ri++));
  loanRows.push(dipRow('Exit Strategy', dipData.exit_strategy || deal.exit_strategy, ri++));
  loanRows.push(dipRow('Loan Purpose', deal.loan_purpose, ri++));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows: loanRows,
  }));
  ch.push(space(80));

  // ── Security ──
  const secRows = [];
  secRows.push(sectionHeader('Security'));
  ri = 0;
  secRows.push(dipRow('First Legal Charge', deal.security_address || 'Over the security property', ri++));
  secRows.push(dipRow('Debenture', borrowerType === 'corporate' ? 'Required (corporate borrower)' : 'N/A (individual borrower)', ri++));
  secRows.push(dipRow('Personal Guarantee', borrowerType === 'corporate' ? 'Required from UBO' : 'N/A', ri++));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows: secRows,
  }));
  ch.push(space(80));

  // ── Fee Schedule ──
  const loanAmt = parseFloat(dipData.loan_amount || deal.loan_amount || 0);
  function feeAmt(raw) {
    const v = parseFloat(raw || 0);
    if (isNaN(v)) return 0;
    return v > 0 && v < 50 ? Math.round(loanAmt * v / 100) : v;
  }
  function feeLine(raw) {
    const v = parseFloat(raw || 0);
    if (isNaN(v) || v === 0) return '\u2014';
    if (v > 0 && v < 50) return money(Math.round(loanAmt * v / 100)) + ' (' + v.toFixed(2) + '%)';
    return money(v);
  }

  const feeRows = [];
  feeRows.push(sectionHeader('Fee Schedule'));

  // Fee header row
  feeRows.push(new TableRow({ children: [
    cellFn('Fee', L, { bold: true, fill: NAVY, color: WHITE, size: 16 }),
    cellFn('Amount / When Due', R, { bold: true, fill: NAVY, color: WHITE, size: 16 }),
  ]}));

  ri = 0;
  feeRows.push(dipRow('Onboarding Fee', money(dipData.fee_onboarding || 0) + ' \u2014 Before Credit Review', ri++));
  feeRows.push(dipRow('Commitment Fee', money(dipData.fee_commitment || 0) + ' \u2014 Before Underwriting', ri++));
  feeRows.push(dipRow('Arrangement Fee', feeLine(dipData.arrangement_fee) + ' \u2014 On Completion', ri++));
  feeRows.push(dipRow('  (of which Broker)', feeLine(dipData.broker_fee) + ' \u2014 From Arrangement Fee', ri++));
  feeRows.push(dipRow('Valuation Fee', money(dipData.valuation_cost || 0) + ' \u2014 On Instruction', ri++));
  feeRows.push(dipRow('Legal Fee', money(dipData.legal_cost || 0) + ' \u2014 On Completion', ri++));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows: feeRows,
  }));
  ch.push(space(80));

  // ── Conditions Precedent ──
  const cpRows = [];
  cpRows.push(sectionHeader('Conditions Precedent'));

  const conditions = [
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

  ri = 0;
  conditions.forEach(c => {
    cpRows.push(new TableRow({ children: [
      cellFn((ri + 1) + '.', L * 0.15, { bold: true, fill: ri % 2 ? LGREY : WHITE, size: 18, center: true }),
      cellFn(c, W - L * 0.15, { fill: ri % 2 ? LGREY : WHITE, size: 18 }),
    ]}));
    ri++;
  });

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [Math.round(L * 0.15), W - Math.round(L * 0.15)],
    rows: cpRows,
  }));
  ch.push(space(80));

  // ── Important notice (matches termsheet RED disclaimer) ──
  ch.push(
    space(120),
    p('IMPORTANT NOTICE: THIS DECISION IN PRINCIPLE IS INDICATIVE ONLY AND DOES NOT CONSTITUTE A BINDING OFFER OR COMMITMENT TO LEND. FINAL APPROVAL IS SUBJECT TO FULL UNDERWRITING, VALUATION AND CREDIT COMMITTEE APPROVAL.',
      { size: 16, italic: true, color: RED, center: true, before: 60, after: 60 }),
    space(80),
  );

  // ── Borrower Acceptance ──
  ch.push(p('BORROWER ACKNOWLEDGEMENT', { bold: true, size: 22, color: NAVY, before: 120, after: 60 }));
  ch.push(p(
    'By accepting this Decision in Principle, the Borrower acknowledges their intention ' +
    'to proceed on the terms outlined above. This DIP is valid for 14 days from the date of issue.',
    { size: 18, before: 0, after: 40 }
  ));

  ch.push(space(200));

  // ── Signature lines ──
  const sigCol = Math.floor(W / 2);
  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [sigCol, sigCol],
    rows: [
      new TableRow({ children: [
        cellFn('_________________________', sigCol, { borders: allNone, size: 18, bold: false }),
        cellFn('_________________________', sigCol, { borders: allNone, size: 18, bold: false }),
      ]}),
      new TableRow({ children: [
        cellFn('Borrower Signature', sigCol, { borders: allNone, size: 16, bold: true, color: NAVY }),
        cellFn('For and on behalf of the Lender', sigCol, { borders: allNone, size: 16, bold: true, color: NAVY }),
      ]}),
      new TableRow({ children: [
        cellFn(clean(deal.borrower_name || '[BORROWER NAME]'), sigCol, { borders: allNone, size: 16 }),
        cellFn('Daksfirst Bridging 1 Ltd', sigCol, { borders: allNone, size: 16 }),
      ]}),
      new TableRow({ children: [
        cellFn('Date: _______________', sigCol, { borders: allNone, size: 16 }),
        cellFn('Date: _______________', sigCol, { borders: allNone, size: 16 }),
      ]}),
    ],
  }));

  ch.push(space(120));

  // ── Disclaimer footer ──
  ch.push(p(
    'Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (FCA 937220). ' +
    'Registered office: 8 Hill Street, Mayfair, London W1J 5NG.',
    { size: 14, italic: true, color: '999999', center: true, before: 40, after: 0 }
  ));

  return new Document({
    title: 'Decision in Principle',
    sections: [{
      properties: { page: {
        size:   { width: PAGE_W, height: 16838 },
        margin: { top: 1700, right: MARGIN, bottom: 1440, left: MARGIN }
      }},
      children: ch,
    }]
  });
}

// ═══════════════════════════════════════════════════════════════════
// GENERATE + VML INJECT
// ═══════════════════════════════════════════════════════════════════

async function generateDipDocx(deal, dipData, options = {}) {
  let buffer = await Packer.toBuffer(buildDip(deal, dipData, options));

  // Inject VML letterhead if loaded
  if (LH_LOADED && LH_VML_P && LH_IMG) {
    try {
      const zip = await JSZip.loadAsync(buffer);

      zip.file('word/media/lh_img.png', LH_IMG);

      const relsXml = await zip.file('word/_rels/document.xml.rels').async('string');
      const rIdLine = '<Relationship Id="rIdLH_img" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/lh_img.png"/>';
      const injRels = relsXml.includes('rIdLH_img') ? relsXml : relsXml.replace('</Relationships>', rIdLine + '</Relationships>');
      zip.file('word/_rels/document.xml.rels', injRels);

      const docXml = await zip.file('word/document.xml').async('string');
      zip.file('word/document.xml', docXml.replace(/<w:body>/, '<w:body>' + LH_VML_P));

      if (LH_FOOTER_XML) {
        zip.file('word/footer1.xml', LH_FOOTER_XML);
        if (LH_FOOTER_RELS) zip.file('word/_rels/footer1.xml.rels', LH_FOOTER_RELS);

        const relsXml2 = await zip.file('word/_rels/document.xml.rels').async('string');
        const footerRel = '<Relationship Id="rIdLH_footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
        zip.file('word/_rels/document.xml.rels',
          relsXml2.includes('rIdLH_footer') ? relsXml2 : relsXml2.replace('</Relationships>', footerRel + '</Relationships>'));

        const ctXml = await zip.file('[Content_Types].xml').async('string');
        const footerCT = '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" PartName="/word/footer1.xml"/>';
        zip.file('[Content_Types].xml',
          ctXml.includes('footer1.xml') ? ctXml : ctXml.replace('</Types>', footerCT + '</Types>'));

        const docXml2 = await zip.file('word/document.xml').async('string');
        zip.file('word/document.xml',
          docXml2.replace(/<w:sectPr>/, '<w:sectPr><w:footerReference w:type="default" r:id="rIdLH_footer"/>'));
      }

      buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      console.log('[dip-doc] VML letterhead injected OK');
    } catch (e) {
      console.warn('[dip-doc] VML injection failed — serving without letterhead:', e.message);
    }
  }

  return buffer;
}

module.exports = { generateDipDocx };
