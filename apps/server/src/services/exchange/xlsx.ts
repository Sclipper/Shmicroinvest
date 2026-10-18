import ExcelJS from 'exceljs';
import { DataImportError, critical, type ExcelCell, type ExcelSheet } from '@shmi/core';

/** xlsx reading / writing (exceljs). Legacy BIFF .xls files are not supported. */

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
