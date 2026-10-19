import { dec, type Dec } from '../money.ts';
import { DEPRECIATION_CATEGORY, isStartMonthIncluded, monthsBetween, monthsFromRate } from '../depreciation.ts';
import { cellDate, cellDecimal, cellText, columnLetters, type ExcelSheet } from './excelImport.ts';
import type { ExchangeMessage } from './messages.ts';

/**
 * Fixed-assets Excel importer (spec 04a 5.5, ExcelFixedAssetsImportProvider;
 * 03b 14.2 AddDepreciationToFixedAssetAndSave). The workbook has the
 * accounting-depreciation sheet (САП) and the tax sheet named
 * "{САП sheet name} - ДАП". Row 1 of each sheet is the header (a column is
 * bound by its property name or its caption), data from row 2. All checks
 * between the sheets block the import and are reported together under
 * strImportCouldNotBeDone.
 */

export const ASSET_IMPORT_MESSAGES = {
  strSap: 'САП',
  strDap: 'ДАП',
  strYes: 'Да',
  strNo: 'Не',
  strLandAndForests: 'Земи и гори',
  strImportCouldNotBeDone: 'Импортът не може да бъде извършен поради следните причини:',
  strFixedAssetImportSheetDapNotFound: 'Не е намерен таб с информация за ДАП в импортирания файл.',
  strFixedAssetImportNoData: 'В импортирания файл няма дълготрайни активи.', // no text
  strFixedAssetInventoryNumberNotInDap: 'Активът с инвентарен номер {0} е въведен в таб САП, но липсва в таб ДАП.', // no text
  strFixedAssetInventoryNumberNotInSap: 'Активът с инвентарен номер {0} е въведен в таб ДАП, но липсва в таб САП.', // no text
  strFixedAssetInventoryNumbersDuplicates: 'Инвентарният номер {0} се повтаря в таб {1}.', // no text
  strFixedAssetInventoryNumbersExistsInDatabase: 'Вече съществува актив с инвентарен номер {0}.', // no text
  strFixedAssetLastProcessedDateError: 'Ред {0} ({1}), инв. № {2}: датата, към която са начислени амортизациите, е преди датата на въвеждане в експлоатация.', // no text
  strFixedAssetEndDateIsAfterEndDate: 'Ред {0} ({1}), инв. № {2}: датата, към която са начислени амортизациите, е след крайната дата на амортизационния план.', // no text
  strFixedAssetEndDateEndDateIsBeforeStartDate: 'Ред {0} ({1}), инв. № {2}: крайната дата е преди датата на въвеждане в експлоатация.', // no text
  strInvalidDataFormatInExcelCellFixedAssetActivePeriodLength: 'Ред {0} ({1}), инв. № {2}: не е въведена валидна крайна дата, полезен срок или годишна амортизационна норма.', // no text
  strInvalidDataFormatInExcelCellFixedAsset: 'Невалидни данни в клетка {1}{0} (таб {2}): {3}.', // no text
  strInvalidAccountNumberInExcelCellFixedAsset: 'Невалидни данни в клетка {1}{0}. Не е намерена сметка с номер: {2}.', // no text
  strFixedAssetLocationNotFound: 'Ред {0}: не е намерено местонахождение „{1}“. Активът ще бъде записан в основната група.', // no text
  strFixedAssetsImported: 'Импортирани дълготрайни активи: {0}.', // no text
} as const;
export type AssetImportMessageKey = keyof typeof ASSET_IMPORT_MESSAGES;

export function assetImportMsg(key: AssetImportMessageKey, ...args: (string | number)[]): string {
  return ASSET_IMPORT_MESSAGES[key].replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}
const err = (key: AssetImportMessageKey, ...args: (string | number)[]): ExchangeMessage => ({ key, text: assetImportMsg(key, ...args), severity: 'critical' });
const warn = (key: AssetImportMessageKey, ...args: (string | number)[]): ExchangeMessage => ({ key, text: assetImportMsg(key, ...args), severity: 'warning' });

export interface AssetImportColumn { key: string; caption: string; length?: number; aliases?: string[]; sapOnly?: boolean }

/** Columns of 04a 5.5 with their lengths; the ДАП sheet repeats the plan columns. */
export const ASSET_IMPORT_COLUMNS: AssetImportColumn[] = [
  { key: 'InventoryNumber', caption: 'Инвентарен номер', length: 30, aliases: ['инв. номер', 'инв. №'] },
  { key: 'Name', caption: 'Наименование', length: 254, aliases: ['име'] },
  { key: 'MOL', caption: 'МОЛ', length: 254, sapOnly: true, aliases: ['материално отговорно лице'] },
  { key: 'Location', caption: 'Местонахождение', length: 50, sapOnly: true, aliases: ['група'] },
  { key: 'DepreciationCategory', caption: 'Категория', length: 50, aliases: ['данъчна категория', 'амортизационна категория'] },
  { key: 'AcquisitionDate', caption: 'Дата на придобиване' },
  { key: 'StartDate', caption: 'Дата на въвеждане в експлоатация', aliases: ['начална дата', 'дата на въвеждане'] },
  { key: 'EndDate', caption: 'Крайна дата' },
  { key: 'ToDate', caption: 'Към дата', aliases: ['начислени към дата'] },
  { key: 'ActivePeriodLength', caption: 'Полезен срок (месеци)', length: 10, aliases: ['полезен срок'] },
  { key: 'AnnualDepreciationRate', caption: 'Годишна норма (%)', length: 3, aliases: ['годишна норма', 'годишна амортизационна норма'] },
  { key: 'AccruedDepreciation', caption: 'Начислена амортизация', length: 15, aliases: ['начислени амортизации'] },
  { key: 'ResidualValue', caption: 'Остатъчна стойност', length: 15, aliases: ['неамортизируема част'] },
  { key: 'DepreciationAmount', caption: 'Амортизируема стойност', length: 19, aliases: ['стойност', 'отчетна стойност'] },
  { key: 'RevaluationReserve', caption: 'Преоценъчен резерв', length: 15, sapOnly: true },
  { key: 'AssetAccount', caption: 'Сметка на актива', length: 50, sapOnly: true, aliases: ['инвентарна сметка'] },
  { key: 'DepreciationAccount', caption: 'Сметка за амортизация', length: 50, sapOnly: true },
  { key: 'ExpenseForDepreciationAccount', caption: 'Разходна сметка', length: 50, sapOnly: true, aliases: ['сметка за разходи за амортизация'] },
  { key: 'AreDepreciationsSynchronized', caption: 'Синхронизирани планове', length: 2, sapOnly: true, aliases: ['синхронизирани'] },
];

/** The ДАП sheet of a САП sheet: "{name} - ДАП". */
export const dapSheetName = (sapName: string) => `${sapName} - ${ASSET_IMPORT_MESSAGES.strDap}`;

/** First sheet whose "- ДАП" twin exists (САП = that sheet). */
export function findAssetSheets(sheets: ExcelSheet[]): { sap: ExcelSheet; dap: ExcelSheet } | null {
  for (const s of sheets) {
    const dap = sheets.find((x) => x.name.trim().toLowerCase() === dapSheetName(s.name.trim()).toLowerCase());
    if (dap) return { sap: s, dap };
  }
  return null;
}

/** Depreciation category from "Категория N" (arabic or roman), the seeded description, a plain number or "Земи и гори". */
export function parseAssetCategory(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === ASSET_IMPORT_MESSAGES.strLandAndForests.toLowerCase()) return DEPRECIATION_CATEGORY.LandAndForests;
  const roman: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
  const m = /^(?:категория\s*)?([ivx]+|\d+)(?:\s*[-.].*)?$/i.exec(t);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : roman[m[1]!.toLowerCase()] ?? null;
  return n && n >= 1 && n <= 8 ? n : null;
}

export interface ImportedPlan {
  acquisitionDate: string;
  startDate: string;
  endDate: string | null;
  /** Last processed date (the accrued amount is up to it). */
  toDate: string | null;
  activePeriodLength: number | null;
  annualRate: string | null;
  accrued: string;
  residualValue: string;
  depreciationAmount: string;
}

export interface ImportedAssetRow {
  row: number;
  inventoryNumber: string;
  name: string;
  mol: string;
  location: string;
  categoryId: number | null;
  assetAccount: string;
  depreciationAccount: string;
  expenseAccount: string;
  synchronized: boolean;
  revaluationReserve: string;
  plan: ImportedPlan;
}

export interface ImportedFixedAsset extends Omit<ImportedAssetRow, 'plan' | 'row'> {
  sapRow: number;
  dapRow: number;
  sap: ImportedPlan;
  dap: ImportedPlan;
  locationId: number | null;
}

/** Reads one sheet (САП or ДАП) by its header row; cell format errors are returned, not thrown. */
export function readAssetSheet(sheet: ExcelSheet, isSap: boolean): { rows: ImportedAssetRow[]; errors: ExchangeMessage[]; letters: Record<string, string> } {
  const lookup = new Map<string, string>();
  for (const c of ASSET_IMPORT_COLUMNS) {
    if (!isSap && c.sapOnly) continue;
    for (const n of [c.key, c.caption, ...(c.aliases ?? [])]) lookup.set(n.trim().toLowerCase(), c.key);
  }
  const cols = new Map<string, number>();
  for (let col = 1; col <= 60; col++) {
    const k = lookup.get(cellText(sheet.cell(1, col)).toLowerCase());
    if (k && !cols.has(k)) cols.set(k, col);
  }
  const tab = isSap ? ASSET_IMPORT_MESSAGES.strSap : ASSET_IMPORT_MESSAGES.strDap;
  const errors: ExchangeMessage[] = [];
  const rows: ImportedAssetRow[] = [];
  const def = new Map(ASSET_IMPORT_COLUMNS.map((c) => [c.key, c]));
  for (let r = 2; r <= sheet.rowCount; r++) {
    const raw = (k: string) => (cols.has(k) ? sheet.cell(r, cols.get(k)!) : null);
    if ([...cols.keys()].every((k) => cellText(raw(k)) === '')) continue;
    const bad = (k: string) => errors.push(err('strInvalidDataFormatInExcelCellFixedAsset', r, columnLetters(cols.get(k) ?? 1), tab, cellText(raw(k))));
    const text = (k: string) => cellText(raw(k), def.get(k)?.length);
    const date = (k: string, required: boolean) => {
      const v = raw(k);
      if (cellText(v) === '') {
        if (required) bad(k);
        return null;
      }
      const d = cellDate(v);
      if (!d) bad(k);
      return d;
    };
    const amount = (k: string, required = false): Dec | null => {
      const v = raw(k);
      if (cellText(v) === '') {
        if (required) bad(k);
        return null;
      }
      const d = cellDecimal(typeof v === 'string' ? v.replace(',', '.') : v);
      if (!d || d.isNegative()) {
        bad(k);
        return null;
      }
      return d;
    };
    const inventoryNumber = text('InventoryNumber');
    if (!inventoryNumber) bad('InventoryNumber');
    const name = text('Name');
    if (isSap && !name) bad('Name');
    const catText = text('DepreciationCategory');
    const categoryId = parseAssetCategory(catText);
    if (isSap && categoryId === null) bad('DepreciationCategory');
    const syncText = text('AreDepreciationsSynchronized').toLowerCase();
    const synchronized = syncText === '' || syncText === ASSET_IMPORT_MESSAGES.strYes.toLowerCase();
    if (isSap && syncText && !synchronized && syncText !== ASSET_IMPORT_MESSAGES.strNo.toLowerCase()) bad('AreDepreciationsSynchronized');
    const life = amount('ActivePeriodLength');
    const rate = amount('AnnualDepreciationRate');
    if (life && !life.isInteger()) bad('ActivePeriodLength');
    const acquisitionDate = date('AcquisitionDate', true);
    const startDate = date('StartDate', true);
    const depreciationAmount = amount('DepreciationAmount', true);
    rows.push({
      row: r, inventoryNumber, name, mol: text('MOL'), location: text('Location'), categoryId,
      assetAccount: text('AssetAccount'), depreciationAccount: text('DepreciationAccount'), expenseAccount: text('ExpenseForDepreciationAccount'),
      synchronized, revaluationReserve: (amount('RevaluationReserve') ?? dec(0)).toFixed(2),
      plan: {
        acquisitionDate: acquisitionDate ?? '', startDate: startDate ?? '', endDate: date('EndDate', false), toDate: date('ToDate', false),
        activePeriodLength: life && life.isInteger() && life.greaterThan(0) ? life.toNumber() : null,
        annualRate: rate && rate.greaterThan(0) ? rate.toString() : null,
        accrued: (amount('AccruedDepreciation') ?? dec(0)).toFixed(2), residualValue: (amount('ResidualValue') ?? dec(0)).toFixed(2),
        depreciationAmount: (depreciationAmount ?? dec(0)).toFixed(2),
      },
    });
  }
  return { rows, errors, letters: Object.fromEntries([...cols].map(([k, c]) => [k, columnLetters(c)])) };
}

export interface AssetImportContext {
  /** Inventory numbers already in the database (current ledger). */
  existingInventoryNumbers: Set<string>;
  /** Normalises an inventory number like the save does (left-padded to the sequence length). */
  normalizeInventoryNumber?: (n: string) => string;
  accountExists: (number: string) => boolean;
  /** Location (asset group) id by name, null when not found. */
  locationByName: (name: string) => number | null;
  /** Column letters of the САП sheet (for the account messages). */
  sapLetters?: Record<string, string>;
}

/** Plan dates of 04a 5.5: end/last-processed order and a usable end date, life or rate. */
function planChecks(p: ImportedPlan, row: number, tab: string, inv: string): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  if (!p.startDate) return out;
  if (p.endDate && p.endDate < p.startDate) out.push(err('strFixedAssetEndDateEndDateIsBeforeStartDate', row, tab, inv));
  if (p.toDate && p.toDate < p.startDate && !dec(p.accrued).isZero()) out.push(err('strFixedAssetLastProcessedDateError', row, tab, inv));
  if (p.toDate && p.endDate && p.toDate > p.endDate && monthsBetween(p.toDate, p.endDate) > 0) out.push(err('strFixedAssetEndDateIsAfterEndDate', row, tab, inv));
  if (!dec(p.accrued).isZero() && !p.toDate) out.push(err('strFixedAssetLastProcessedDateError', row, tab, inv));
  const endOk = !!p.endDate && p.endDate >= p.startDate;
  if (!p.activePeriodLength && !p.annualRate && !endOk) out.push(err('strInvalidDataFormatInExcelCellFixedAssetActivePeriodLength', row, tab, inv));
  return out;
}

/**
 * Cross-sheet checks (04a 5.5): every inventory number in both sheets, no
 * duplicates, none in the database, dates in order, a usable end date / life /
 * rate, known accounts. Errors block the whole import; an unknown location is
 * only a warning (the asset goes to the top group).
 */
export function checkAssetImport(sap: ImportedAssetRow[], dap: ImportedAssetRow[], ctx: AssetImportContext): { assets: ImportedFixedAsset[]; errors: ExchangeMessage[]; warnings: ExchangeMessage[] } {
  const errors: ExchangeMessage[] = [];
  const warnings: ExchangeMessage[] = [];
  const norm = ctx.normalizeInventoryNumber ?? ((n: string) => n);
  const dups = (rows: ImportedAssetRow[], tab: string) => {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const r of rows) {
      const n = norm(r.inventoryNumber);
      if (!r.inventoryNumber) continue;
      if (seen.has(n) && !reported.has(n)) {
        reported.add(n);
        errors.push(err('strFixedAssetInventoryNumbersDuplicates', r.inventoryNumber, tab));
      }
      seen.add(n);
    }
  };
  dups(sap, ASSET_IMPORT_MESSAGES.strSap);
  dups(dap, ASSET_IMPORT_MESSAGES.strDap);
  const dapBy = new Map(dap.filter((r) => r.inventoryNumber).map((r) => [norm(r.inventoryNumber), r]));
  const sapBy = new Map(sap.filter((r) => r.inventoryNumber).map((r) => [norm(r.inventoryNumber), r]));
  for (const r of sap) if (r.inventoryNumber && !dapBy.has(norm(r.inventoryNumber))) errors.push(err('strFixedAssetInventoryNumberNotInDap', r.inventoryNumber));
  for (const r of dap) if (r.inventoryNumber && !sapBy.has(norm(r.inventoryNumber))) errors.push(err('strFixedAssetInventoryNumberNotInSap', r.inventoryNumber));
  for (const r of sap) if (r.inventoryNumber && ctx.existingInventoryNumbers.has(norm(r.inventoryNumber))) errors.push(err('strFixedAssetInventoryNumbersExistsInDatabase', norm(r.inventoryNumber)));

  const assets: ImportedFixedAsset[] = [];
  const letter = (key: string) => ctx.sapLetters?.[key] ?? key;
  for (const s of sap) {
    if (!s.inventoryNumber) continue;
    errors.push(...planChecks(s.plan, s.row, ASSET_IMPORT_MESSAGES.strSap, s.inventoryNumber));
    for (const [acc, col] of [[s.assetAccount, 'AssetAccount'], [s.depreciationAccount, 'DepreciationAccount'], [s.expenseAccount, 'ExpenseForDepreciationAccount']] as const) {
      if (acc && !ctx.accountExists(acc)) errors.push(err('strInvalidAccountNumberInExcelCellFixedAsset', s.row, letter(col), acc));
    }
    if (!s.assetAccount) errors.push(err('strInvalidAccountNumberInExcelCellFixedAsset', s.row, letter('AssetAccount'), ''));
    const d = dapBy.get(norm(s.inventoryNumber));
    if (d) errors.push(...planChecks(d.plan, d.row, ASSET_IMPORT_MESSAGES.strDap, d.inventoryNumber));
    let locationId: number | null = null;
    if (s.location) {
      locationId = ctx.locationByName(s.location);
      if (locationId === null) warnings.push(warn('strFixedAssetLocationNotFound', s.row, s.location));
    }
    if (!d) continue;
    const { row, plan, ...rest } = s;
    assets.push({ ...rest, inventoryNumber: norm(s.inventoryNumber), sapRow: row, dapRow: d.row, sap: plan, dap: { ...d.plan }, locationId });
  }
  return { assets, errors, warnings };
}

/**
 * Plan input of an imported plan (03b 14.2): built "BasedOnPeriod" on the
 * useful life (ActivePeriodLength, else the months of the annual rate, else
 * the months up to the end date), with the accrued amount up to ToDate as the
 * processed part (AmountByLastProcessedDate).
 */
export function importedPlanInput(p: ImportedPlan, isAccounting: boolean, synchronized: boolean) {
  const included = isStartMonthIncluded(isAccounting, synchronized);
  const fromEnd = p.endDate && p.endDate >= p.startDate ? monthsBetween(p.endDate, p.startDate) + (included ? 1 : 0) : null;
  const life = p.activePeriodLength ?? (p.annualRate ? monthsFromRate(p.annualRate) : fromEnd);
  const accrued = dec(p.accrued);
  return {
    depreciationAmount: p.depreciationAmount,
    nonDepreciableAmount: p.residualValue,
    acquisitionDate: p.acquisitionDate,
    startDate: p.startDate,
    calcType: 'period' as const,
    activePeriodLength: life,
    annualRate: null,
    manualAccrued: !accrued.isZero() && p.toDate ? { date: p.toDate, amount: accrued.toFixed(2) } : null,
  };
}
