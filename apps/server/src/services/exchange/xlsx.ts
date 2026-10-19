import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import * as cpexcel from 'xlsx/dist/cpexcel.full.mjs';
import { DataImportError, critical, type ExcelCell, type ExcelSheet } from '@shmi/core';

/**
 * Workbook reading / writing: .xlsx through exceljs, legacy BIFF .xls
 * (Excel 97-2003, 04a 5.1 "otherwise 2003") through SheetJS.
 */

XLSX.set_cptable(cpexcel);

/** OLE2 compound file (BIFF .xls) signature D0 CF 11 E0. */
const isOle2 = (b: Uint8Array) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

/** Excel serial date -> UTC midnight-based Date (1900 date system, as the import's OADate). */
function serialToDate(v: number): Date {
  const p = XLSX.SSF.parse_date_code(v);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, Math.floor(p.S)));
}

function legacyCell(c: XLSX.CellObject | undefined): ExcelCell {
  if (!c || c.v === undefined || c.v === null) return null;
  if (c.t === 'e' || c.t === 'z') return null;
  if (c.t === 'n' && typeof c.v === 'number' && c.z && XLSX.SSF.is_date(c.z)) return serialToDate(c.v);
  if (c.v instanceof Date) return c.v;
  return c.v as string | number | boolean;
}

function readLegacyWorkbook(bytes: Uint8Array): ExcelSheet[] {
  let wb: XLSX.WorkBook;
  try {
    // A damaged compound file would otherwise be read as one text cell.
    const cfb = XLSX.CFB.read(bytes, { type: 'array' });
    if (!XLSX.CFB.find(cfb, 'Workbook') && !XLSX.CFB.find(cfb, 'Book')) throw new Error('no workbook stream');
    wb = XLSX.read(bytes, { type: 'array', cellNF: true, cellDates: false });
  } catch {
    throw new DataImportError(critical('strWrongFileOrBrokenStructures'));
  }
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const ref = ws['!ref'];
    const rowCount = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
    return { name, rowCount, cell: (row: number, col: number) => legacyCell(ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })] as XLSX.CellObject | undefined) };
  });
}

function plain(v: ExcelJS.CellValue): ExcelCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return plain(v.result as ExcelJS.CellValue);
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return null;
  }
  return String(v);
}

export async function readWorkbook(bytes: Uint8Array): Promise<ExcelSheet[]> {
  if (isOle2(bytes)) return readLegacyWorkbook(bytes);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw new DataImportError(critical('strWrongFileOrBrokenStructures'));
  }
  return wb.worksheets.map((ws) => ({
    name: ws.name,
    rowCount: ws.rowCount,
    cell: (row: number, col: number) => plain(ws.getRow(row).getCell(col).value),
  }));
}

/** Sheet -> string grid (bank statements in Excel). */
export function sheetTable(sheet: ExcelSheet): string[][] {
  const out: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row: string[] = [];
    let last = 0;
    for (let c = 1; c <= 60; c++) {
      const v = sheet.cell(r, c);
      let t = '';
      if (v instanceof Date) t = `${String(v.getUTCDate()).padStart(2, '0')}.${String(v.getUTCMonth() + 1).padStart(2, '0')}.${v.getUTCFullYear()}`;
      else if (v !== null && v !== undefined) t = String(v);
      row.push(t);
      if (t.trim()) last = c;
    }
    out.push(row.slice(0, last));
  }
  return out;
}

export async function writeWorkbook(sheets: { name: string; header?: string[]; rows: unknown[][] }[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Microinvest Делта Pro';
  wb.created = new Date();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31));
    if (sh.header) {
      const r = ws.addRow(sh.header);
      r.font = { bold: true };
    }
    for (const row of sh.rows) ws.addRow(row.map((v) => (v === undefined ? null : v)) as ExcelJS.CellValue[]);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
