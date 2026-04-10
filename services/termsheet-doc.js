/**
 * Termsheet DOCX Generator — Daksfirst Branded with VML Letterhead
 *
 * Generates a professional Word document matching the legacy memo-api
 * format: Garamond font, navy/gold branding, VML letterhead injection,
 * branded footer, alternating row colours, amber TBC highlighting.
 *
 * The output is a DOCX buffer that can be:
 *   - Uploaded to OneDrive
 *   - Sent to DocuSign (which accepts DOCX natively)
 *
 * Anchor text "Borrower Signature" and "Guarantor Signature" are NOT needed
 * for DOCX — DocuSign can use coordinate-based or anchor-string tabs.
 * We include text labels for tab placement.
 */

const fs   = require('fs');
const path = require('path');
const JSZip = require('jszip');

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
} = require('docx');

// ── Colours ────────────────────────────────────────────────────────
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
    // Look for letterhead_template.docx in several locations
    const searchPaths = [
      path.join(__dirname, '..', 'letterhead_template.docx'),
      path.join(__dirname, 'letterhead_template.docx'),
      path.join(process.cwd(), 'letterhead_template.docx'),
    ];
    let buf = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) { buf = fs.readFileSync(p); break; }
    }
    if (!buf) { console.warn('[termsheet-doc] letterhead_template.docx not found'); return; }

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
    console.log('[termsheet-doc] VML letterhead loaded OK');
  } catch (e) {
    console.warn('[termsheet-doc] letterhead load failed:', e.message);
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

const condStr = (c) => {
  if (!c) return '';
  if (typeof c === 'string') return clean(c);
  return clean(c.condition || c.text || c.description || c.item || c.title || c.content || c.value || JSON.stringify(c));
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

const tsCell = (text, w, i) => {
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
// BUILD TERMSHEET DOCX
// ═══════════════════════════════════════════════════════════════════

function buildTermsheet(t) {
  const ch = [];
  const W  = CONTENT;
  const L  = 3400;
  const R  = W - L;

  const tsRow = (label, value, i) => new TableRow({ children: [
    cellFn(label, L, { bold: true, fill: i % 2 ? LGREY : WHITE, size: 18 }),
    tsCell(value || '\u2014', R, i),
  ]});

  const tsSection = (title) => new TableRow({ children: [
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

  // HEADER
  ch.push(
    new Paragraph({ spacing: { before: 1400, after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GOLD, space: 4 } },
      children: [new TextRun({ text: 'Senior Secured Real Estate Credit & Structured Finance', bold: false, italics: true, size: 22, color: MGREY, font: 'Garamond' })] }),
    space(60),
    new Paragraph({ spacing: { before: 0, after: 80 }, alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: 'BRIDGE LOAN \u2014 INDICATIVE TERM SHEET', bold: true, size: 32, color: NAVY, font: 'Garamond' })] }),
  );

  // DISCLAIMER
  ch.push(
    p('Please note that the terms set out in this Term Sheet are indicative only and do not constitute, nor should be construed to be, a commitment or an offer by the Lender or any of its affiliates to invest or finance. The decision to arrange or provide financing is subject to due diligence, credit committee approval, board approval, regulatory approvals and final documentation satisfactory to the Lender.',
      { size: 16, italic: true, color: MGREY, before: 60, after: 60 }),
    p(`Date: ${clean(t.date || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}`,
      { bold: true, size: 18, before: 40, after: 100 }),
  );

  // MAIN TABLE
  const rows = [];

  // Parties & Property
  rows.push(tsSection('Parties & Property Details'));
  [
    ['Lender',           t.lender          || 'Daksfirst Bridging 1 Ltd'],
    ['Borrower',         t.borrower],
    ['Guarantor(s)',     t.guarantors],
    ['Security Address', t.securityAddress],
    ['Property Type',    t.propertyType],
    ['Current Use / Tenure', t.tenure],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Valuation & LTV
  rows.push(tsSection('Valuation & Loan-to-Value'));
  [
    ['Open Market Value (OMV)',            t.omv],
    ['Gross Development Value (GDV)',      t.gdv || 'N/A'],
    ['Gross Loan To Value (GLTV)',         t.gltv],
    ['Minimum Security Value Covenant',    t.minSecurityValue || t.omv],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Loan Terms
  rows.push(tsSection('Loan Terms'));
  [
    ['Facility Type',             t.facilityType      || 'Bridge Loan'],
    ['Gross Loan Sum',            t.grossLoan],
    ['Net Loan Sum',              t.netLoan],
    ['Minimum Loan Term',         t.minTerm],
    ['Maximum Loan Term',         t.maxTerm],
    ['Interest Retention Period',  t.interestRetention],
    ['Drawdown Structure',        t.drawdownStructure],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Loan Costs
  rows.push(tsSection('Loan Costs (Calculated on Gross Loan Sum)'));
  [
    ['Arrangement Fee',          t.arrangementFee],
    ['Exit Fee',                 t.exitFee],
    ['Valuation Fee',            t.valuationFee    || 'At cost \u2014 payable by Borrower on instruction'],
    ['Legal Fees (Lender)',      t.legalFees       || 'At cost \u2014 payable by Borrower on completion'],
    ['Broker / Introducer Fee',  t.brokerFee       || 'N/A'],
    ['Loan Underwriting Fee',    t.underwritingFee || '\u00a310,000 payable upfront at point of signing'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Interest Rates
  rows.push(tsSection('Interest Rates'));
  [
    ['Discounted Interest Rate (p/m)', t.discountedRate],
    ['Standard Interest Rate (p/m)',   t.standardRate],
    ['Default Interest Rate (p/m)',    t.defaultRate     || '3.00% per month'],
    ['Non-Utilisation Fee',            t.nonUtilFee      || 'N/A'],
    ['Interest Basis',                 t.interestBasis   || 'Rolled-up / Retained'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Security & Covenants
  rows.push(tsSection('Security & Covenants'));
  [
    ['Security Package',    t.securityPackage    || '1st Legal Charge, Debenture & Personal Guarantee'],
    ['Additional Security', t.additionalSecurity || 'N/A'],
    ['Insurance',           'Borrower to maintain full reinstatement insurance \u2014 Lender noted as interested party'],
    ['SPV Requirement',     t.spvRequired        || 'TBC'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Uses of Net Loan Proceeds
  rows.push(tsSection('Uses of Net Loan Proceeds'));
  [
    ['Day 1 Release',                    t.day1Release],
    ['Staged / Construction Drawdowns',  t.stagedDrawdowns        || 'N/A'],
    ['Retained for Working Capital',     t.retainedWorkingCapital || 'N/A'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Conditions Precedent
  rows.push(tsSection('Conditions Precedent to Drawdown'));
  const cps = Array.isArray(t.conditionsPrecedent) && t.conditionsPrecedent.length > 0
    ? t.conditionsPrecedent
    : [
        'Satisfactory valuation by a Daksfirst-approved RICS surveyor',
        'Satisfactory legal due diligence and title report',
        'Full KYC/AML documentation for all borrowing entities and guarantors',
        'Evidence of buildings insurance naming Daksfirst as interested party',
        'Executed personal guarantee(s) from all directors / beneficial owners',
      ];
  rows.push(new TableRow({ children: [
    cellFn('Conditions Precedent', L, { bold: true, fill: LGREY, size: 18 }),
    new TableCell({
      width: { size: R, type: WidthType.DXA },
      borders: allThin,
      shading: { fill: WHITE, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: cps.map((c) => new Paragraph({
        spacing: { before: 20, after: 20 },
        children: [new TextRun({
          text: `\u2022  ${condStr(c).replace(/^\d+[\.\)]\s*/, '')}`,
          size: 18, font: 'Garamond', color: BLACK,
        })]
      }))
    }),
  ]}));

  // Repayment & Exit
  rows.push(tsSection('Repayment & Exit'));
  [
    ['Repayment Method',      'Bullet repayment at end of term'],
    ['Primary Exit Strategy', t.primaryExit],
    ['Extension Option',      t.extensionOption || 'Available subject to re-valuation and extension fee of 1.00%'],
    ['Prepayment',            t.prepayment      || 'Permitted subject to minimum interest period of 3 months'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  // Lender Bank Details
  rows.push(tsSection('Lender Bank Details'));
  [
    ['Account Name',   'Daksfirst Limited'],
    ['Bank',           'HSBC'],
    ['Account Number', '90300721'],
    ['Sort Code',      '40-02-45'],
    ['IBAN',           'GB64HBUK40024590300721'],
    ['SWIFT / BIC',    'HBUKGB4187M'],
  ].forEach(([l, v], i) => rows.push(tsRow(l, v, i)));

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [L, R],
    rows,
  }));

  // IMPORTANT NOTICE
  ch.push(
    space(120),
    p('IMPORTANT NOTICE: YOU SHOULD NOT ENTER INTO ANY FINANCIAL COMMITMENT(S) BASED ON THESE INITIAL INDICATIVE TERMS. THESE TERMS ARE SUBJECT TO CHANGE AND DO NOT CONSTITUTE A BINDING OFFER OR COMMITMENT.',
      { size: 16, italic: true, color: RED, center: true, before: 60, after: 60 }),
    space(80),
  );

  // SIGNATURE BLOCK — Borrower + Guarantor + Lender (3-column)
  const sigW = Math.floor(W / 3);
  const sigNameBorrower  = clean(t.borrower || '[BORROWER NAME]');
  const sigNameGuarantor = clean(t.guarantors || '[GUARANTOR NAME]');
  const sigFields = ['Authorised Signatory', 'Name (Print)', 'Title / Position', 'Date'];

  const sigCol = (title) => new TableCell({
    width: { size: sigW, type: WidthType.DXA },
    borders: allNone,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [
      new Paragraph({ spacing: { before: 0, after: 40 }, children: [
        new TextRun({ text: title, bold: true, size: 16, color: NAVY, font: 'Garamond' })
      ]}),
      ...sigFields.map(label =>
        new Paragraph({ spacing: { before: 60, after: 20 }, children: [
          new TextRun({ text: `${label}:  `, bold: true, size: 18, font: 'Garamond', color: BLACK }),
          new TextRun({ text: '...............................................', size: 18, font: 'Garamond', color: MGREY }),
        ]})
      ),
    ]
  });

  ch.push(new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [sigW, sigW, sigW],
    rows: [new TableRow({ children: [
      sigCol(`Borrower Signature\n${sigNameBorrower}`),
      sigCol(`Guarantor Signature\n${sigNameGuarantor}`),
      sigCol('FOR AND ON BEHALF OF\nDaksfirst Limited (Lender)'),
    ]})]
  }));

  // Underwriting fee note
  ch.push(
    space(120),
    p('* The Loan Underwriting Fee shall be payable to Daksfirst Limited upon execution of this Term Sheet. The fee shall be refundable only if Daksfirst Limited withdraws the loan offer within ten (10) days from the earlier of receipt of the duly signed Term Sheet and the Loan Underwriting Fee, except where such withdrawal results from circumstances outside the control of Daksfirst Limited.',
      { size: 15, italic: true, color: MGREY, before: 60, after: 40 }),
  );

  return new Document({
    title: 'Indicative Term Sheet',
    sections: [{
      properties: { page: {
        size:   { width: PAGE_W, height: 16838 },
        margin: { top: 1700, right: MARGIN, bottom: 1440, left: MARGIN }
      }},
      children: ch
    }]
  });
}

// ═══════════════════════════════════════════════════════════════════
// GENERATE — Build DOCX + inject VML letterhead
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a branded Termsheet DOCX
 * @param {Object} termsheetData - The ai_termsheet_data.termsheet object
 * @returns {Promise<Buffer>} - DOCX buffer
 */
async function generateTermsheetDocx(termsheetData) {
  let buffer = await Packer.toBuffer(buildTermsheet(termsheetData));

  // Inject VML letterhead if loaded
  if (LH_LOADED && LH_VML_P && LH_IMG) {
    try {
      const zip = await JSZip.loadAsync(buffer);

      // 1. Add letterhead image
      zip.file('word/media/lh_img.png', LH_IMG);

      // 2. Add image relationship
      const relsXml = await zip.file('word/_rels/document.xml.rels').async('string');
      const rIdLine = '<Relationship Id="rIdLH_img" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/lh_img.png"/>';
      const injRels = relsXml.includes('rIdLH_img')
        ? relsXml
        : relsXml.replace('</Relationships>', rIdLine + '</Relationships>');
      zip.file('word/_rels/document.xml.rels', injRels);

      // 3. Inject VML paragraph into document body
      const docXml = await zip.file('word/document.xml').async('string');
      const injDoc = docXml.replace(/<w:body>/, '<w:body>' + LH_VML_P);
      zip.file('word/document.xml', injDoc);

      // 4. Copy footer from letterhead template
      if (LH_FOOTER_XML) {
        zip.file('word/footer1.xml', LH_FOOTER_XML);
        if (LH_FOOTER_RELS) zip.file('word/_rels/footer1.xml.rels', LH_FOOTER_RELS);

        const relsXml2 = await zip.file('word/_rels/document.xml.rels').async('string');
        const footerRel = '<Relationship Id="rIdLH_footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
        const injRels2 = relsXml2.includes('rIdLH_footer')
          ? relsXml2
          : relsXml2.replace('</Relationships>', footerRel + '</Relationships>');
        zip.file('word/_rels/document.xml.rels', injRels2);

        const ctXml = await zip.file('[Content_Types].xml').async('string');
        const footerCT = '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" PartName="/word/footer1.xml"/>';
        const injCT = ctXml.includes('footer1.xml')
          ? ctXml
          : ctXml.replace('</Types>', footerCT + '</Types>');
        zip.file('[Content_Types].xml', injCT);

        const docXml2 = await zip.file('word/document.xml').async('string');
        const injDoc2 = docXml2.replace(/<w:sectPr>/, '<w:sectPr><w:footerReference w:type="default" r:id="rIdLH_footer"/>');
        zip.file('word/document.xml', injDoc2);
      }

      buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      console.log('[termsheet-doc] VML letterhead injected OK');
    } catch (e) {
      console.warn('[termsheet-doc] VML injection failed — serving without letterhead:', e.message);
    }
  }

  return buffer;
}

module.exports = { generateTermsheetDocx };
