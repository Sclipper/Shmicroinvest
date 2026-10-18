import { dec, round2, sum } from '../money.ts';
import { lastDayOfMonth, msg, parseDecimalText } from './messages.ts';
import { splitDelimited } from './bankFormats.ts';

/**
 * ТРЗ Pro payroll import (spec 04a 6). Delta reads the ТРЗ Pro SQL Server
 * database with vendor-encrypted formula identifiers; the web version reads
 * the result contract of that query (6.5) from a file instead: one row per
 * department and salary month with the 33 amount columns and the
 * per-department `Dt<column>` / `Kt<column>` accounts.
 */

export interface TrzItem {
  id: number;
  column: string;
  name: string;
  /** Detail rows of 10100, shown only "by details". */
  detailOf?: number;
}

export const TRZ_ITEMS: TrzItem[] = [
  { id: 10100, column: 'ZaplTrudoviIDUK', name: 'Възнаграждения - ТД и ДУК' },
  { id: 10101, column: 'VuznagrajdenieOtraboteniDni', name: 'Възнаграждения за отработени дни', detailOf: 10100 },
  { id: 10102, column: 'DopulnitelniVuznagrajdeniq', name: 'Допълнителни възнаграждения', detailOf: 10100 },
  { id: 10103, column: 'PlatenOtpusk', name: 'Платен отпуск', detailOf: 10100 },
  { id: 10104, column: 'BolnichniOtOsiguritel', name: 'Болнични от осигурител', detailOf: 10100 },
  { id: 10105, column: 'SocialniRazhodi', name: 'Социални разходи', detailOf: 10100 },
  { id: 10106, column: 'ObezshteteniqPoKT', name: 'Обезщетения по КТ', detailOf: 10100 },
  { id: 10200, column: 'VuznagrajdeniqZaGrajdanskiDog', name: 'Възнаграждения - ГД' },
  { id: 10300, column: 'VuznagrajdeniqZaSOL', name: 'Възнаграждения - СОЛ' },
  { id: 20100, column: 'DOOTrudoviIDUKRab', name: 'ДОО - работодател ТД и ДУК' },
  { id: 20200, column: 'DOOTrudoviIDUKSluj', name: 'ДОО - служител ТД и ДУК' },
  { id: 20300, column: 'DOOGrajdanskiDogovoriRab', name: 'ДОО - работодател ГД' },
  { id: 20400, column: 'DOOGrajdanskiDogovoriSluj', name: 'ДОО - лице по ГД' },
  { id: 20500, column: 'DOOSOL', name: 'ДОО - СОЛ' },
  { id: 20600, column: 'DZPOvUPFTrudiDUKRab', name: 'ДЗПО в УПФ - работодател ТД и ДУК' },
  { id: 20700, column: 'DZPOvUPFTrudiDUKSluj', name: 'ДЗПО в УПФ - служител ТД и ДУК' },
  { id: 20800, column: 'DZPOvUPFGrajdanskiRab', name: 'ДЗПО в УПФ - работодател ГД' },
  { id: 20900, column: 'DZPOvUPFGrajdanskiSluj', name: 'ДЗПО в УПФ - лице по ГД' },
  { id: 21000, column: 'DZPOvUPFSOLSluj', name: 'ДЗПО в УПФ - СОЛ' },
  { id: 21100, column: 'UchitelskiPensionenFond', name: 'Учителски пенсионен фонд' },
  { id: 21200, column: 'VnoskiZaFondGVRS', name: 'Вноски за ФГВРС' },
  { id: 21300, column: 'VnoskiZaFondTZPB', name: 'Вноски за фонд ТЗПБ' },
  { id: 21400, column: 'ZOTrudoviIDUKRab', name: 'ЗО - работодател ТД и ДУК' },
  { id: 21500, column: 'ZOTrudoviIDUKSluj', name: 'ЗО - служител ТД и ДУК' },
  { id: 21600, column: 'ZOGrajdanskiDogovoriRab', name: 'ЗО - работодател ГД' },
  { id: 21700, column: 'ZOGrajdanskiDogovoriSluj', name: 'ЗО - лице по ГД' },
  { id: 21800, column: 'ZOSOL', name: 'ЗО - СОЛ' },
  { id: 30100, column: 'DanukPoZDDFLTDiDUK', name: 'Данък по ЗДДФЛ - ТД и ДУК' },
  { id: 30200, column: 'DanukPoZDDFLGrajdanskiDog', name: 'Данък по ЗДДФЛ - ГД' },
  { id: 30300, column: 'DanukPoZDDFLSOL', name: 'Данък по ЗДДФЛ - СОЛ' },
  { id: 30400, column: 'DrugiUdrujkiTDiDUKSluj', name: 'Други удръжки - ТД и ДУК' },
  { id: 30500, column: 'DrugiUdrujkiGrajdanskiDog', name: 'Други удръжки - ГД' },
  { id: 30600, column: 'DrugiUdrujkiSOL', name: 'Други удръжки - СОЛ' },
];

/** Default national-chart accounts the importer needs (6.4), with names for "Дефиниране сега". */
export const TRZ_REQUIRED_ACCOUNTS: { number: string; description: string }[] = [
  { number: '421', description: 'Задължения към персонала' },
  { number: '429', description: 'Други разчети с персонала' },
  { number: '454', description: 'Разчети за други данъци' },
  { number: '461', description: 'Разчети с Държавно обществено осигуряване' },
  { number: '461/1', description: 'ДОО - фонд Пенсии' },
  { number: '461/2', description: 'ДОО - фонд ОЗМ' },
  { number: '461/3', description: 'ДОО - фонд Безработица' },
  { number: '461/4', description: 'ДОО - фонд ТЗПБ' },
  { number: '461/5', description: 'ДОО - фонд ГВРС' },
  { number: '463', description: 'Разчети по допълнително задължително пенсионно осигуряване' },
  { number: '493', description: 'Разчети по лихви' },
  { number: '499', description: 'Други кредитори' },
  { number: '604', description: 'Разходи за заплати /възнаграждения/' },
  { number: '604/1', description: 'Заплати по трудови договори' },
  { number: '604/2', description: 'Възнаграждения по граждански договори' },
  { number: '604/3', description: 'Възнаграждения на СОЛ' },
  { number: '604/4', description: 'Платен отпуск' },
  { number: '604/5', description: 'Обезщетения по КТ' },
  { number: '605', description: 'Разходи за осигуровки' },
  { number: '605/1', description: 'Осигуровки ДОО' },
  { number: '605/2', description: 'Осигуровки ДЗПО' },
  { number: '605/3', description: 'Здравни осигуровки' },
  { number: '605/4', description: 'Учителски пенсионен фонд' },
  { number: '605/5', description: 'Фонд ТЗПБ' },
  { number: '605/6', description: 'Фонд ГВРС' },
  { number: '609', description: 'Други разходи' },
];

export interface TrzDepartmentRow {
  month: string; // yyyy-mm
  code: string;
  name: string;
  amounts: Record<number, string>;
  accounts: Record<number, { debit: string; credit: string }>;
}

const MONTH_RE = /^(\d{1,2})[./-](\d{4})$|^(\d{4})-(\d{2})(-\d{2})?$/;
function parseMonth(s: string): string | null {
  const m = MONTH_RE.exec(s.trim());
  if (!m) return null;
  const y = m[2] ?? m[3]!;
  const mo = Number(m[1] ?? m[4]);
  if (mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, '0')}`;
}

/** Reads the department/month feed (CSV or TXT; ';', ',', tab or '|'). Unknown columns are ignored. */
export function parseTrzFeed(text: string): TrzDepartmentRow[] {
  const table = splitDelimited(text);
  if (!table.length) return [];
  const head = table[0]!.map((h) => h.trim());
  const idx = (name: string) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const monthCol = [idx('Month'), idx('Месец'), idx('Period')].find((i) => i >= 0) ?? -1;
  const codeCol = [idx('Code'), idx('Код')].find((i) => i >= 0) ?? -1;
  const nameCol = [idx('Name'), idx('Отдел'), idx('Име')].find((i) => i >= 0) ?? -1;
  const out: TrzDepartmentRow[] = [];
  for (const cells of table.slice(1)) {
    const month = monthCol >= 0 ? parseMonth(cells[monthCol] ?? '') : null;
    if (!month) continue;
    const row: TrzDepartmentRow = { month, code: codeCol >= 0 ? (cells[codeCol] ?? '').trim() : '', name: nameCol >= 0 ? (cells[nameCol] ?? '').trim() : '', amounts: {}, accounts: {} };
    for (const it of TRZ_ITEMS) {
      const ai = [idx(it.column), idx(String(it.id))].find((i) => i >= 0) ?? -1;
      const v = ai >= 0 ? parseDecimalText(cells[ai] ?? '') : null;
      row.amounts[it.id] = v ? round2(v).toFixed(2) : '0.00';
      const di = [idx(`Dt${it.column}`), idx(`Dt${it.id}`)].find((i) => i >= 0) ?? -1;
      const ki = [idx(`Kt${it.column}`), idx(`Kt${it.id}`)].find((i) => i >= 0) ?? -1;
      row.accounts[it.id] = { debit: di >= 0 ? (cells[di] ?? '').trim() : '', credit: ki >= 0 ? (cells[ki] ?? '').trim() : '' };
    }
    out.push(row);
  }
  return out;
}

/** Distinct salary months of the feed in the given financial year (GetAvailableSalaryMonths). */
export function trzAvailableMonths(rows: TrzDepartmentRow[], year: number): string[] {
  return [...new Set(rows.map((r) => r.month).filter((m) => Number(m.slice(0, 4)) === year))].sort();
}

/**
 * Rolls departments up to `level` (0 = top): groups by the first 3 x (level + 1)
 * characters of the hierarchical code. Accounts of the group come from its
 * first department.
 */
export function trzAggregate(rows: TrzDepartmentRow[], month: string, level: number): TrzDepartmentRow[] {
  const len = 3 * (level + 1);
  const groups = new Map<string, TrzDepartmentRow>();
  for (const r of rows.filter((x) => x.month === month)) {
    const key = r.code.slice(0, len);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...r, code: key, amounts: { ...r.amounts }, accounts: { ...r.accounts } });
    } else {
      for (const it of TRZ_ITEMS) g.amounts[it.id] = dec(g.amounts[it.id] ?? '0').plus(r.amounts[it.id] ?? '0').toFixed(2);
      if (r.code.length === len) g.name = r.name;
    }
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export interface TrzGridRow {
  key: string;
  departmentCode: string;
  departmentName: string;
  itemId: number;
  itemName: string;
  amount: string;
  debit: string;
  credit: string;
}

/** Posting grid: by details the six 10101-10106 rows replace the 10100 header; zero rows are kept (skipped on save). */
export function trzGrid(departments: TrzDepartmentRow[], byDetails: boolean): TrzGridRow[] {
  const items = TRZ_ITEMS.filter((it) => (byDetails ? it.id !== 10100 : it.detailOf === undefined));
  const out: TrzGridRow[] = [];
  for (const d of departments) {
    for (const it of items) {
      const acc = d.accounts[it.id] ?? { debit: '', credit: '' };
      const fallback = it.detailOf ? d.accounts[it.detailOf] : undefined;
      out.push({
        key: `${d.code}:${it.id}`, departmentCode: d.code, departmentName: d.name, itemId: it.id, itemName: it.name,
        amount: d.amounts[it.id] ?? '0.00', debit: acc.debit || fallback?.debit || '', credit: acc.credit || fallback?.credit || '',
      });
    }
  }
  return out;
}

export const trzDefaultTerm = (month: string) => msg('strDefaultTRZProImportOperationsTerm', `${month.slice(5, 7)}.${month.slice(0, 4)}`);
export const trzDefaultAccountingDate = (month: string) => lastDayOfMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));

/** Accounting date must be on/after the first of the salary month and in the active year. */
export function trzAccountingDateValid(date: string, month: string, activeYear: number): boolean {
  return date >= `${month}-01` && Number(date.slice(0, 4)) === activeYear;
}

export function trzTotal(rows: TrzGridRow[]) {
  return sum(rows.map((r) => r.amount)).toFixed(2);
}
