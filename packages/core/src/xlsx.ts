import { crc32, zipCryptoDecrypt, ZipPasswordError, zipStore } from './zip.ts';
/**
 * Minimal Office Open XML workbook writer (spec 05 11.1, Excel export of the
 * report grids). Produces a real .xlsx: a ZIP archive (stored, no
 * compression) with inline strings, numbers with a "# ##0.00" format, bold
 * rows, column widths and merged cells. No dependencies; runs in the browser
 * and in Node.
 */

export type XlsxCell = string | number | null | undefined | { v: string | number | null; bold?: boolean; format?: 'amount' | 'integer' | 'text' };

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Merged ranges such as "A1:H1". */
  merges?: string[];
  /** Zero-based indices of rows printed in bold. */
  boldRows?: number[];
}

/* ---------------- SpreadsheetML ---------------- */

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Column letters: 0 -> A, 26 -> AA. */
export function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Style ids: 0 normal, 1 bold, 2 amount, 3 bold amount, 4 integer, 5 bold integer.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet: XlsxSheet): string {
  const bold = new Set(sheet.boldRows ?? []);
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((raw, c) => {
      const cell = raw !== null && typeof raw === 'object' ? raw : { v: raw ?? null };
      if (cell.v === null || cell.v === undefined || cell.v === '') return '';
      const ref = `${columnName(c)}${r + 1}`;
      const isBold = bold.has(r) || ('bold' in cell && cell.bold);
      if (typeof cell.v === 'number' && cell.format !== 'text') {
        const style = cell.format === 'integer' ? (isBold ? 5 : 4) : isBold ? 3 : 2;
        return `<c r="${ref}" s="${style}"><v>${Number.isFinite(cell.v) ? cell.v : 0}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${isBold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(String(cell.v))}</t></is></c>`;
    });
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  });
  const cols = sheet.widths?.length ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rows.join('')}</sheetData>${merges}<pageSetup orientation="landscape" paperSize="9"/></worksheet>`;
}

/** Sheet names: max 31 chars, no []:*?/\ and unique. */
function sheetNames(sheets: XlsxSheet[]) {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let base = (s.name || `Лист${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Builds an .xlsx workbook. */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) sheets = [{ name: 'Лист1', rows: [] }];
  const enc = new TextEncoder();
  const names = sheetNames(sheets);
  const files: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, text: string) => files.push({ name, data: enc.encode(text) });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml', STYLES);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zipStore(files);
}

/** Reads the entries of a stored ZIP (used by tests and to verify exports). */
/** Reads stored (uncompressed) entries; encrypted entries (ZipCrypto) need `password`. */
export function unzipStore(data: Uint8Array, password?: string | null): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();
  let p = 0;
  while (p + 30 <= data.length && view.getUint32(p, true) === 0x04034b50) {
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const extra = view.getUint16(p + 28, true);
    const name = dec.decode(data.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    const flags = view.getUint16(p + 6, true);
    const crc = view.getUint32(p + 14, true);
    let body = data.subarray(start, start + size);
    if (flags & 1) {
      if (!password) throw new ZipPasswordError('missing');
      body = zipCryptoDecrypt(body, password, flags & 0x08 ? view.getUint8(p + 11) : crc >>> 24);
    }
    if (crc32(body) !== crc) {
      if (flags & 1) throw new ZipPasswordError('wrong');
      throw new Error(`CRC mismatch in ${name}`);
    }
    out.set(name, body);
    p = start + size;
  }
  return out;
}
