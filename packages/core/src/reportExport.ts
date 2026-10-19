import { formatMoney } from './money.ts';
import type { XlsxCell, XlsxSheet } from './xlsx.ts';

/**
 * Format-neutral report document of the PDF and Word exports of the report
 * viewer (05 11.1; "Изпращане по e-mail" 05 11.3): the same sheets as the
 * Excel export, split into title lines, the column header (repeated on every
 * page) and the body, with the cells formatted as in the printout (amounts
 * "1 234,56", zero amounts blank, numbers right-aligned).
 */

export interface ReportDocMeta {
  /** Report title, e.g. "Оборотна ведомост". */
  title: string;
  /** Company line: name and ЕИК. */
  company: string;
  /** Lines under the title: period, account, filter. */
  subtitle?: string[];
  /** "Дата и час" of the printout (IsVisualizeDateTimeOnReportingEnabled), or null. */
  printedAt?: string | null;
  /** Съставил / Гл. счетоводител / Управител lines at the end (as in print). */
  signatures?: boolean;
}

export interface ReportCell {
  text: string;
  numeric: boolean;
  bold: boolean;
}

export interface ReportRow {
  cells: ReportCell[];
  bold: boolean;
  /** A row with one text (group heading, total label): spans the whole table width. */
  span: boolean;
  /** An empty row: a small gap. */
  blank: boolean;
}

export interface ReportSection {
  name: string;
  /** Text lines above the table (from the leading one-cell rows). */
  titles: string[];
  /** Column header row (repeated on every page), or null. */
  header: ReportCell[] | null;
  rows: ReportRow[];
  columns: number;
  /** Columns holding numbers (right-aligned, never wrapped). */
  numeric: boolean[];
}

export interface ReportDoc {
  meta: ReportDocMeta;
  sections: ReportSection[];
}

/** Text of a cell as printed: amounts "1 234,56" with blank zeroes, integers as is. */
export function reportCellText(raw: XlsxCell): { text: string; numeric: boolean; bold: boolean } {
  const cell = raw !== null && typeof raw === 'object' ? raw : { v: raw ?? null };
  const bold = 'bold' in cell && !!cell.bold;
  const v = cell.v;
  if (v === null || v === undefined || v === '') return { text: '', numeric: false, bold };
  if (typeof v === 'number' && cell.format !== 'text') {
    if (!Number.isFinite(v)) return { text: '', numeric: true, bold };
    if (cell.format === 'integer') return { text: String(Math.round(v)), numeric: true, bold };
    return { text: v === 0 ? '' : formatMoney(v), numeric: true, bold };
  }
  return { text: String(v), numeric: false, bold };
}

const filled = (r: { text: string }[]) => r.filter((c) => c.text.trim() !== '').length;

/** Splits the export sheets of a report into document sections. */
export function reportDocument(meta: ReportDocMeta, sheets: XlsxSheet[]): ReportDoc {
  const dupes = new Set([meta.title, `${meta.title} на ${meta.company}`, ...(meta.subtitle ?? [])].map((t) => t.trim().toLowerCase()));
  const sections = sheets.map((sheet): ReportSection => {
    const boldRows = new Set(sheet.boldRows ?? []);
    const rows = sheet.rows.map((r, i) => {
      const cells = r.map(reportCellText);
      while (cells.length && cells[cells.length - 1]!.text === '' && !cells[cells.length - 1]!.numeric) cells.pop();
      return { cells, bold: boldRows.has(i) };
    });
    let i = 0;
    const titles: string[] = [];
    // Leading one-cell rows are the title block; the report's own title is already in the page header.
    for (; i < rows.length && filled(rows[i]!.cells) <= 1 && !rows[i]!.cells.some((c) => c.numeric && c.text); i++) {
      const text = rows[i]!.cells.map((c) => c.text).join('').trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      if (dupes.has(lower) || lower.startsWith(`${meta.title.toLowerCase()} на `)) continue;
      titles.push(text);
    }
    let header: ReportCell[] | null = null;
    if (i < rows.length && !rows[i]!.cells.some((c) => c.numeric)) {
      header = rows[i]!.cells.map((c) => ({ ...c, bold: true }));
      i++;
    }
    const body: ReportRow[] = rows.slice(i).map((r) => {
      const n = filled(r.cells);
      return { cells: r.cells, bold: r.bold || (n > 0 && r.cells.every((c) => c.bold || c.text === '')), span: n === 1 && r.cells[0]!.text !== '' && !r.cells[0]!.numeric, blank: n === 0 };
    });
    while (body.length && body[body.length - 1]!.blank) body.pop();
    // A loop, not Math.max(...rows): a long report would overflow the argument stack.
    let columns = Math.max(header?.length ?? 0, 1);
    for (const r of body) if (!r.span && r.cells.length > columns) columns = r.cells.length;
    // An amount column: mostly numbers (a text column may hold a stray amount, e.g. an opening balance row).
    const numeric = Array.from({ length: columns }, (_, c) => {
      let numbers = 0;
      let texts = 0;
      for (const r of body) {
        const cell = r.span ? undefined : r.cells[c];
        if (cell?.text) cell.numeric ? numbers++ : texts++;
      }
      return numbers > texts;
    });
    return { name: sheet.name, titles, header, rows: body, columns, numeric };
  });
  return { meta, sections };
}

/* ------------------------------------------------------------------ */
/* Column layout                                                       */
/* ------------------------------------------------------------------ */

/** Width of a text in em (1 = the font size). */
export type MeasureText = (text: string, bold: boolean) => number;

export interface ColumnLayout {
  fontSize: number;
  /** Column widths in points (cell padding included). */
  widths: number[];
}

export const CELL_PADDING = 6;
const FONT_SIZES = [8, 7.5, 7, 6.5, 6];
/** A text column wraps at words; very long words are cut at this width (em). */
const MAX_WORD_EM = 12;

interface ColumnNeeds {
  /** Width without any wrapping. */
  want: number[];
  /** Width with the header wrapped at words. */
  nat: number[];
  /** Narrowest width: text columns wrapped at words, numbers never. */
  min: number[];
}

function columnNeeds(s: ReportSection, measure: MeasureText): ColumnNeeds {
  const want: number[] = Array(s.columns).fill(0);
  const nat: number[] = Array(s.columns).fill(0);
  const min: number[] = Array(s.columns).fill(0);
  const longestWord = (t: string, bold: boolean) => Math.min(MAX_WORD_EM, Math.max(0, ...t.split(/\s+/).map((w) => measure(w, bold))));
  for (let c = 0; c < s.columns; c++) {
    const h = s.header?.[c];
    const hFull = h ? measure(h.text, true) : 0;
    const hWord = h ? longestWord(h.text, true) : 0;
    let body = 0;
    let word = 0;
    for (const r of s.rows) {
      if (r.span || r.blank) continue;
      const cell = r.cells[c];
      if (!cell || !cell.text) continue;
      const bold = r.bold || cell.bold;
      body = Math.max(body, measure(cell.text, bold));
      word = Math.max(word, cell.numeric ? measure(cell.text, bold) : longestWord(cell.text, bold));
    }
    // Long free texts (основание, наименование) are not worth a whole line of the page.
    if (!s.numeric[c]) body = Math.min(body, 40);
    want[c] = Math.max(body, hFull, 1.5);
    nat[c] = Math.max(body, hWord, 1.5);
    min[c] = s.numeric[c] ? nat[c]! : Math.max(Math.min(word, nat[c]!), hWord, Math.min(4, nat[c]!));
  }
  return { want, nat, min };
}

const total = (ems: number[], size: number) => ems.reduce((a, w) => a + w * size + CELL_PADDING, 0);

/** Whether the section needs a landscape page: it does not fit a portrait page at the default size unwrapped. */
export function needsLandscape(s: ReportSection, measure: MeasureText, portraitWidth: number): boolean {
  const n = columnNeeds(s, measure);
  return total(n.want, FONT_SIZES[0]!) > portraitWidth;
}

/**
 * Column widths of a section for the available width: natural widths when
 * they fit (grown towards the unwrapped header), else the text columns wrap,
 * else a smaller font (down to 6 pt), finally a font scaled to fit.
 */
export function layoutColumns(s: ReportSection, measure: MeasureText, available: number): ColumnLayout {
  const n = columnNeeds(s, measure);
  const at = (size: number, from: number[], to: number[], k: number) => from.map((f, i) => (f + (to[i]! - f) * k) * size + CELL_PADDING);
  for (const size of FONT_SIZES) {
    const nat = total(n.nat, size);
    if (nat <= available) {
      const want = total(n.want, size);
      const k = want <= available ? 1 : (available - nat) / (want - nat);
      return { fontSize: size, widths: at(size, n.nat, n.want, k) };
    }
    const min = total(n.min, size);
    if (min <= available) return { fontSize: size, widths: at(size, n.nat, n.min, (nat - available) / (nat - min)) };
  }
  const sumMin = n.min.reduce((a, b) => a + b, 0);
  const size = Math.max(3, Math.floor(((available - s.columns * CELL_PADDING) / sumMin) * 100) / 100);
  return { fontSize: size, widths: at(size, n.nat, n.min, 1) };
}

/** Splits a text into lines no wider than `width` em (breaks at spaces, cuts long words). */
export function wrapText(text: string, width: number, measure: (t: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
      // A single word wider than the column: cut it.
      while (measure(line) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

const charWidth = (ch: string) => (/[ .,:;!|il'1]/.test(ch) ? 0.3 : /[MWШЩЖЮмшщжю@%]/.test(ch) ? 0.85 : /[A-ZА-Я0-9]/.test(ch) ? 0.62 : 0.52);
/** Widths of the BMP characters seen so far, 0 = not yet (the regular expressions per character dominated long exports). */
const charWidths = new Float64Array(0x10000);

/** Approximate text width (em) for formats measured by their viewer (Word). */
export const approxMeasure: MeasureText = (text, bold) => {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      // A surrogate pair is one character (as for..of counted it).
      if (code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
      }
      w += 0.52;
      continue;
    }
    let cw = charWidths[code]!;
    if (cw === 0) charWidths[code] = cw = charWidth(text[i]!);
    w += cw;
  }
  return bold ? w * 1.06 : w;
};
