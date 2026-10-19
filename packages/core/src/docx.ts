import { approxMeasure, layoutColumns, needsLandscape, type ReportCell, type ReportDoc, type ReportRow, type ReportSection } from './reportExport.ts';
import { zipStore } from './zip.ts';

/**
 * Word export of the report viewer (05 11.1): a .docx (WordprocessingML in a
 * stored ZIP) with the company line, title, period lines and one table per
 * report sheet: the column header repeats on every page, amounts are
 * right-aligned, total rows bold, one-text rows span the table. A4, landscape
 * when the table is wide. No dependencies; runs in the browser and in Node.
 */

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const A4_TWIPS = [11906, 16838];
const MARGIN_TWIPS = 567; // 1 cm
const twips = (pt: number) => Math.round(pt * 20);

function run(text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) {
  const props = `${opts.bold ? '<w:b/>' : ''}${opts.color ? `<w:color w:val="${opts.color}"/>` : ''}${opts.size ? `<w:sz w:val="${Math.round(opts.size * 2)}"/><w:szCs w:val="${Math.round(opts.size * 2)}"/>` : ''}`;
  const lines = text.split(/\r?\n/);
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${lines.map((l, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(l)}</w:t>`).join('')}</w:r>`;
}

function para(text: string, opts: { bold?: boolean; size?: number; align?: 'left' | 'right' | 'center'; after?: number; color?: string; keepNext?: boolean; pageBreak?: boolean } = {}) {
  const ppr = `${opts.keepNext ? '<w:keepNext/>' : ''}${opts.pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="${opts.after ?? 0}"/>${opts.align && opts.align !== 'left' ? `<w:jc w:val="${opts.align}"/>` : ''}`;
  return `<w:p><w:pPr>${ppr}</w:pPr>${text ? run(text, opts) : ''}</w:p>`;
}

function cell(c: ReportCell | undefined, width: number, opts: { bold: boolean; size: number; align: 'left' | 'right' | 'center'; span?: number; fill?: string }) {
  const tcPr = `<w:tcW w:w="${width}" w:type="dxa"/>${opts.span && opts.span > 1 ? `<w:gridSpan w:val="${opts.span}"/>` : ''}${opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : ''}`;
  return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${para(c?.text ?? '', { bold: opts.bold || !!c?.bold, size: opts.size, align: opts.align })}</w:tc>`;
}

function table(s: ReportSection, widthTwips: number) {
  const { fontSize, widths } = layoutColumns(s, approxMeasure, widthTwips / 20);
  const cols = widths.map(twips);
  const tableW = cols.reduce((a, b) => a + b, 0);
  const row = (r: ReportRow) => {
    if (r.blank) return `<w:tr>${cell(undefined, tableW, { bold: false, size: fontSize, align: 'left', span: s.columns })}</w:tr>`;
    if (r.span) return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(r.cells[0], tableW, { bold: r.bold, size: fontSize, align: 'left', span: s.columns })}</w:tr>`;
    return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cols.map((w, c) => cell(r.cells[c], w, { bold: r.bold, size: fontSize, align: r.cells[c]?.numeric ? 'right' : 'left' })).join('')}</w:tr>`;
  };
  const header = s.header ? `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${cols.map((w, c) => cell(s.header![c], w, { bold: true, size: fontSize, align: 'center', fill: 'E2E8F0' })).join('')}</w:tr>` : '';
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="8C99A8"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${tableW}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="15" w:type="dxa"/><w:left w:w="57" w:type="dxa"/><w:bottom w:w="15" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${s.rows.map(row).join('')}</w:tbl>`;
}

/** Builds the .docx of a report document. */
export function buildReportDocx(doc: ReportDoc): Uint8Array {
  const portrait = A4_TWIPS[0]! - 2 * MARGIN_TWIPS;
  const landscape = doc.sections.some((s) => needsLandscape(s, approxMeasure, portrait / 20));
  const [pageW, pageH] = landscape ? [A4_TWIPS[1]!, A4_TWIPS[0]!] : A4_TWIPS;
  const width = pageW! - 2 * MARGIN_TWIPS;
  const m = doc.meta;
  const body: string[] = [];
  body.push(`<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${width}"/></w:tabs><w:spacing w:before="0" w:after="40"/></w:pPr>${run(m.company, { size: 8, color: '475569' })}${m.printedAt ? `<w:r><w:tab/></w:r>${run(`Дата и час: ${m.printedAt}`, { size: 8, color: '475569' })}` : ''}</w:p>`);
  body.push(para(m.title, { bold: true, size: 14, after: 40 }));
  for (const line of m.subtitle ?? []) if (line.trim()) body.push(para(line, { size: 9, after: 20 }));
  body.push(para('', { size: 6, after: 60 }));
  doc.sections.forEach((s, i) => {
    if (doc.sections.length > 1 && s.name) body.push(para(s.name, { bold: true, size: 11, after: 60, keepNext: true, pageBreak: i > 0 }));
    else if (i > 0) body.push(para('', { pageBreak: true }));
    for (const t of s.titles) body.push(para(t, { size: 9, after: 20, keepNext: true }));
    if (s.header || s.rows.length) {
      body.push(table(s, width));
      body.push(para('', { size: 6, after: 60 }));
    }
  });
  if (m.signatures) {
    body.push(para('', { after: 200 }));
    body.push(`<w:p><w:pPr><w:tabs><w:tab w:val="center" w:pos="${Math.round(width / 2)}"/><w:tab w:val="right" w:pos="${width}"/></w:tabs></w:pPr>${run('Съставил: ....................', { size: 8 })}<w:r><w:tab/></w:r>${run('Гл. счетоводител: ....................', { size: 8 })}<w:r><w:tab/></w:r>${run('Управител: ....................', { size: 8 })}</w:p>`);
  }
  const sect = `<w:sectPr><w:pgSz w:w="${pageW}" w:h="${pageH}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="284" w:footer="284" w:gutter="0"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}${sect}</w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="bg-BG"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(m.title)}</dc:title><dc:creator>${xmlEsc(m.company)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
  const e = new TextEncoder();
  const file = (name: string, text: string) => ({ name, data: e.encode(text) });
  return zipStore([
    file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    file('word/document.xml', documentXml),
    file('word/styles.xml', styles),
    file('docProps/core.xml', core),
  ]);
}
