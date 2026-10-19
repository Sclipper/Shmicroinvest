import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approxMeasure, layoutColumns, needsLandscape, reportAttachmentName, reportCellText, reportDocument, unzipStore, withAttachmentExtension, wrapText,
  type MeasureText, type XlsxSheet,
} from '../src/index.ts';
import { buildReportDocx } from '../src/docx.ts';
import { buildReportPdf, extractPdfText, pdfPageCount } from '../src/pdf.ts';
import { parseTtf, textWidthEm } from '../src/ttf.ts';

const fontDir = path.resolve(import.meta.dirname, '../fonts');
const fonts = { regular: new Uint8Array(readFileSync(path.join(fontDir, 'DejaVuSansCondensed.ttf'))), bold: new Uint8Array(readFileSync(path.join(fontDir, 'DejaVuSansCondensed-Bold.ttf'))) };
/** Every character a width of 0.5 em: predictable layouts. */
const half: MeasureText = (t) => [...t].length * 0.5;

const meta = { title: 'Оборотна ведомост', company: 'Панели ООД, ЕИК 123456789', subtitle: ['от 01.01.2026 до 31.12.2026'] };
const trialSheet = (n: number): XlsxSheet => ({
  name: 'Оборотна ведомост',
  rows: [
    ['Оборотна ведомост на Панели ООД, ЕИК 123456789'], ['от 01.01.2026 до 31.12.2026'], [],
    ['Сметка', 'Наименование', 'Начално салдо Дебит', 'Начално салдо Кредит', 'Обороти Дебит', 'Обороти Кредит', 'Крайно салдо Дебит', 'Крайно салдо Кредит'],
    ...Array.from({ length: n }, (_, i) => [`50${i}`, `Разплащателна сметка в лева № ${i}`, 1000 + i, 0, 1234.5, 0, 2234.5 + i, 0]),
    ['Общо:', '', 1000, 0, 1234.5, 0, 2234.5, 0],
  ],
  boldRows: [0, 3, n + 4],
});

describe('report document (PDF / Word export, 05 11.1)', () => {
  it('formats cells as the printout: amounts with spaces, blank zeroes, integers, text', () => {
    expect(reportCellText(1234567.5)).toEqual({ text: '1 234 567,50', numeric: true, bold: false });
    expect(reportCellText(0).text).toBe('');
    expect(reportCellText(-12.3).text).toBe('-12,30');
    expect(reportCellText({ v: 42, format: 'integer', bold: true })).toEqual({ text: '42', numeric: true, bold: true });
    expect(reportCellText({ v: 501, format: 'text' })).toEqual({ text: '501', numeric: false, bold: false });
    expect(reportCellText(null).text).toBe('');
  });

  it('splits a sheet into titles, the column header and the rows; drops the repeated title and period', () => {
    const doc = reportDocument(meta, [
      { name: 'А', rows: [['Оборотна ведомост на Панели ООД, ЕИК 123456789'], ['от 01.01.2026 до 31.12.2026'], [], ['Сметка 411 Клиенти'], [], ['Дата', 'Документ', 'Сума'], ['Група'], ['01.02.2026', 'Ф-1', 120], [], ['Общо:', '', 120], [], []], boldRows: [9] },
    ]);
    const s = doc.sections[0]!;
    expect(s.titles).toEqual(['Сметка 411 Клиенти']);
    expect(s.header!.map((c) => c.text)).toEqual(['Дата', 'Документ', 'Сума']);
    expect(s.rows.map((r) => [r.cells[0]?.text ?? '', r.span, r.blank, r.bold])).toEqual([
      ['Група', true, false, false], ['01.02.2026', false, false, false], ['', false, true, false], ['Общо:', false, false, true],
    ]);
    expect(s.columns).toBe(3);
    expect(s.numeric).toEqual([false, false, true]);
  });

  it('an amount column is one with mostly numbers (a stray amount in a text column does not count)', () => {
    const s = reportDocument(meta, [{ name: 'x', rows: [['Вид', 'Партньор', 'Сума'], ['Начално салдо', 1200, 0], ['Ф-1', 'Клиент А', 10], ['Ф-2', 'Клиент Б', 20]] }]).sections[0]!;
    expect(s.numeric).toEqual([false, false, true]);
    expect(s.rows[0]!.cells[1]).toMatchObject({ text: '1 200,00', numeric: true });
  });

  it('a sheet starting with numbers has no header row', () => {
    const s = reportDocument(meta, [{ name: 'x', rows: [['Каса', 10], ['Банка', 20]] }]).sections[0]!;
    expect(s.header).toBeNull();
    expect(s.rows).toHaveLength(2);
  });

  it('lays out columns: natural widths when they fit, then wrapped text columns, then a smaller font', () => {
    const s = reportDocument(meta, [{ name: 'x', rows: [['Сметка', 'Наименование', 'Сума'], ['501', 'Каса в лева', 1234.5]] }]).sections[0]!;
    // Natural: max(header, body) em at 8 pt + 6 pt padding.
    const fit = layoutColumns(s, half, 500);
    expect(fit.fontSize).toBe(8);
    expect(fit.widths.map(Math.round)).toEqual([3 * 8 + 6, 6 * 8 + 6, 4 * 8 + 6]);

    const wide = reportDocument(meta, [{ name: 'x', rows: [['Основание', 'Сума'], ['дълъг текст '.repeat(10).trim(), 1]] }]).sections[0]!;
    const wrapped = layoutColumns(wide, half, 200);
    expect(wrapped.fontSize).toBe(8);
    expect(wrapped.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(200, 5);
    // The amount column keeps its natural width.
    expect(wrapped.widths[1]).toBeCloseTo(2 * 8 + 6, 5);

    const many = reportDocument(meta, [{ name: 'x', rows: [Array.from({ length: 12 }, (_, i) => `К${i}`), Array.from({ length: 12 }, () => 12345678.9)] }]).sections[0]!;
    const small = layoutColumns(many, half, 600);
    expect(small.fontSize).toBeLessThan(8);
    expect(small.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600);
    expect(needsLandscape(many, half, 539)).toBe(true);
    expect(needsLandscape(s, half, 539)).toBe(false);
  });

  it('wraps text at spaces and cuts words longer than the column', () => {
    const m = (t: string) => t.length;
    expect(wrapText('едно две три', 8, m)).toEqual(['едно две', 'три']);
    expect(wrapText('абвгдежзий', 4, m)).toEqual(['абвг', 'дежз', 'ий']);
    expect(wrapText('ред 1\nред 2', 20, m)).toEqual(['ред 1', 'ред 2']);
  });

  it('names the e-mail attachment with the chosen format', () => {
    expect(reportAttachmentName('Оборотна ведомост', '2026-12-31', 'pdf')).toBe('Оборотна ведомост 2026.12.31.pdf');
    expect(reportAttachmentName('Оборотна ведомост', '2026-12-31')).toBe('Оборотна ведомост 2026.12.31.xlsx');
    expect(withAttachmentExtension('Оборотна ведомост 2026.12.31.pdf', 'xlsx', 'x')).toBe('Оборотна ведомост 2026.12.31.xlsx');
    expect(withAttachmentExtension('отчет', 'pdf', 'x')).toBe('отчет.pdf');
    expect(withAttachmentExtension(' ', 'pdf', 'Оборотна ведомост')).toBe('Оборотна ведомост.pdf');
  });
});

describe('TrueType reader', () => {
  it('maps Cyrillic and Latin to glyphs with advances', () => {
    const f = parseTtf(fonts.regular);
    expect(f.unitsPerEm).toBe(2048);
    expect(f.postscriptName).toBe('DejaVuSansCondensed');
    for (const ch of 'АБВабвЪъЮюЯяAz09€№') expect(f.glyph(ch.codePointAt(0)!), ch).toBeGreaterThan(0);
    expect(f.glyph(0x4e2d)).toBe(0); // no CJK
    expect(textWidthEm(f, 'ШШ')).toBeCloseTo(2 * textWidthEm(f, 'Ш'), 6);
    expect(textWidthEm(f, 'i')).toBeLessThan(textWidthEm(f, 'Ш'));
  });
});

describe('PDF export', () => {
  it('writes a valid PDF with the embedded font, searchable Cyrillic text and a repeated header', async () => {
    const doc = reportDocument({ ...meta, printedAt: '19.10.2026 10:15', signatures: true }, [trialSheet(120)]);
    const pdf = await buildReportPdf(doc, fonts);
    if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, pdf);
    const head = new TextDecoder().decode(pdf.subarray(0, 8));
    expect(head).toBe('%PDF-1.7');
    const tail = new TextDecoder().decode(pdf.subarray(pdf.length - 40));
    expect(tail).toMatch(/startxref\n\d+\n%%EOF\n$/);
    // The xref offset points at the xref table and each entry at its object.
    const raw = Buffer.from(pdf).toString('latin1');
    const startxref = Number(/startxref\n(\d+)/.exec(raw)![1]);
    expect(raw.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...raw.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    entries.forEach((o, i) => expect(raw.slice(o, o + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(raw).toContain('/Subtype /CIDFontType2');
    expect(raw).toContain('/FontFile2');
    // 8 columns: landscape A4.
    expect(raw).toContain('/MediaBox [0 0 841.89 595.28]');
    const pages = pdfPageCount(pdf);
    expect(pages).toBeGreaterThan(2);
    const text = await extractPdfText(pdf);
    expect(text).toContain('Оборотна ведомост');
    expect(text).toContain('Панели ООД, ЕИК 123456789');
    expect(text).toContain('от 01.01.2026 до 31.12.2026');
    expect(text).toContain('Дата и час: 19.10.2026 10:15');
    expect(text).toContain('Разплащателна сметка в лева № 119');
    expect(text).toContain('2 353,50');
    expect(text).toContain('Общо:');
    expect(text).toContain('Управител: ....................');
    expect(text).toContain(`Страница ${pages} от ${pages}`);
    // The column header is on every page; the title rows of the sheet are not repeated as rows.
    expect(text.filter((t) => t === 'Сметка')).toHaveLength(pages);
    expect(text.filter((t) => t === 'Оборотна ведомост')).toHaveLength(1);
  });

  it('a narrow report is portrait; characters outside the font become "?"; one page per sheet', async () => {
    const doc = reportDocument({ title: 'Каса', company: 'Ф' }, [
      { name: 'Първи', rows: [['Дата', 'Сума'], ['01.02.2026 中', 10]] },
      { name: 'Втори', rows: [['Дата', 'Сума'], ['02.02.2026', 20]] },
    ]);
    const pdf = await buildReportPdf(doc, fonts, { compress: false });
    const raw = Buffer.from(pdf).toString('latin1');
    expect(raw).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(pdfPageCount(pdf)).toBe(2);
    const text = await extractPdfText(pdf);
    expect(text).toContain('01.02.2026 ?');
    expect(text).toContain('Първи');
    expect(text).toContain('Втори');
  });
});

describe('Word export', () => {
  it('writes a .docx with the title and a table with a repeated header row', () => {
    const doc = reportDocument({ ...meta, signatures: true }, [trialSheet(3)]);
    const docx = buildReportDocx(doc);
    const files = unzipStore(docx);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']));
    const xml = new TextDecoder().decode(files.get('word/document.xml'));
    expect(xml).toContain('<w:t xml:space="preserve">Оборотна ведомост</w:t>');
    expect(xml).toContain('Панели ООД, ЕИК 123456789');
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml).toContain('Начално салдо Дебит');
    expect(xml).toContain('1 234,50');
    expect(xml).toContain('w:orient="landscape"');
    expect(xml.match(/<w:tr>/g)).toHaveLength(1 + 3 + 1); // header, 3 accounts, Общо
    expect(xml).toContain('Управител: ....................');
    // Widths come from the same column layout as the PDF.
    const { widths } = layoutColumns(doc.sections[0]!, approxMeasure, (16838 - 2 * 567) / 20);
    expect(xml).toContain(`<w:gridCol w:w="${Math.round(widths[0]! * 20)}"/>`);
  });
});
