import { describe, expect, it } from 'vitest';
import {
  ASSET_IMPORT_COLUMNS, checkAssetImport, dapSheetName, findAssetSheets, importedPlanInput, parseAssetCategory, readAssetSheet,
  type AssetImportContext, type ExcelCell, type ExcelSheet,
} from '../src/index.ts';

const sheet = (name: string, rows: ExcelCell[][]): ExcelSheet => ({ name, rowCount: rows.length, cell: (r, c) => rows[r - 1]?.[c - 1] ?? null });

const SAP_HEADER = ['Инвентарен номер', 'Наименование', 'МОЛ', 'Местонахождение', 'Категория', 'Дата на придобиване', 'Дата на въвеждане в експлоатация', 'Крайна дата', 'Към дата',
  'Полезен срок (месеци)', 'Годишна норма (%)', 'Начислена амортизация', 'Остатъчна стойност', 'Амортизируема стойност', 'Преоценъчен резерв', 'Сметка на актива',
  'Сметка за амортизация', 'Разходна сметка', 'Синхронизирани планове'];
const DAP_HEADER = ['InventoryNumber', 'Name', 'DepreciationCategory', 'AcquisitionDate', 'StartDate', 'EndDate', 'ToDate', 'ActivePeriodLength', 'AnnualDepreciationRate', 'AccruedDepreciation', 'ResidualValue', 'DepreciationAmount'];

const sapRow = (inv: string, o: Partial<Record<string, ExcelCell>> = {}): ExcelCell[] => [
  inv, o.name ?? `Актив ${inv}`, 'Иван', o.location ?? '', o.category ?? 'Категория 4', '10.01.2025', o.start ?? '15.01.2025', o.end ?? '', o.to ?? '31.12.2025',
  o.life ?? 24, o.rate ?? '', o.accrued ?? '1100', '0', o.amount ?? '2400', '0', o.account ?? '204', '2414', '603', o.sync ?? 'Да',
];
const dapRow = (inv: string, o: Partial<Record<string, ExcelCell>> = {}): ExcelCell[] => [
  inv, `Актив ${inv}`, 'Категория 4', '10.01.2025', o.start ?? '15.01.2025', o.end ?? '', o.to ?? '31.12.2025', o.life ?? 24, o.rate ?? '', o.accrued ?? '1200', '0', '2400',
];

const ctx = (o: Partial<AssetImportContext> = {}): AssetImportContext => ({
  existingInventoryNumbers: new Set(), accountExists: (n) => ['204', '2414', '603'].includes(n), locationByName: (n) => (n === 'Склад' ? 5 : null), ...o,
});

describe('fixed-assets Excel import (04a 5.5)', () => {
  it('the ДАП sheet is "{САП} - ДАП"', () => {
    const sap = sheet('Активи', [SAP_HEADER]);
    const dap = sheet('Активи - ДАП', [DAP_HEADER]);
    expect(dapSheetName('Активи')).toBe('Активи - ДАП');
    expect(findAssetSheets([dap, sap])).toEqual({ sap, dap });
    expect(findAssetSheets([sap])).toBeNull();
  });

  it('categories: "Категория N", roman, the description, "Земи и гори"', () => {
    expect(parseAssetCategory('Категория 4')).toBe(4);
    expect(parseAssetCategory('категория IV')).toBe(4);
    expect(parseAssetCategory('II - Машини, оборудване')).toBe(2);
    expect(parseAssetCategory('Земи и гори')).toBe(8);
    expect(parseAssetCategory('Категория 9')).toBeNull();
    expect(parseAssetCategory('')).toBeNull();
  });

  it('reads both sheets by caption or property name; cell errors name the cell', () => {
    const s = readAssetSheet(sheet('САП', [SAP_HEADER, sapRow('1'), sapRow('2', { location: 'Склад', sync: 'Не', start: 'хх' })]), true);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0]).toMatchObject({ inventoryNumber: '1', categoryId: 4, synchronized: true, assetAccount: '204', plan: { startDate: '2025-01-15', toDate: '2025-12-31', activePeriodLength: 24, accrued: '1100.00', depreciationAmount: '2400.00' } });
    expect(s.rows[1]!.synchronized).toBe(false);
    expect(s.errors.map((e) => e.text)).toEqual(['Невалидни данни в клетка G3 (таб САП): хх.']);
    expect(s.letters.AssetAccount).toBe('P');
    const d = readAssetSheet(sheet('САП - ДАП', [DAP_HEADER, dapRow('1')]), false);
    expect(d.rows[0]!.plan).toMatchObject({ accrued: '1200.00', activePeriodLength: 24 });
    expect(ASSET_IMPORT_COLUMNS.find((c) => c.key === 'InventoryNumber')!.length).toBe(30);
  });

  it('cross-sheet checks block the import together', () => {
    const sap = readAssetSheet(sheet('САП', [SAP_HEADER, sapRow('1'), sapRow('2'), sapRow('2'), sapRow('3', { account: '999' }), sapRow('4', { life: '', end: '', rate: '' }), sapRow('5', { end: '01.01.2024' }), sapRow('6', { to: '01.12.2024' }), sapRow('7', { end: '31.03.2025' })]), true);
    const dap = readAssetSheet(sheet('САП - ДАП', [DAP_HEADER, dapRow('1'), dapRow('2'), dapRow('3'), dapRow('4'), dapRow('5'), dapRow('6'), dapRow('7'), dapRow('8')]), false);
    const r = checkAssetImport(sap.rows, dap.rows, ctx({ existingInventoryNumbers: new Set(['1']), sapLetters: sap.letters }));
    expect(r.errors.map((e) => e.key)).toEqual([
      'strFixedAssetInventoryNumbersDuplicates',
      'strFixedAssetInventoryNumberNotInSap',
      'strFixedAssetInventoryNumbersExistsInDatabase',
      'strInvalidAccountNumberInExcelCellFixedAsset',
      'strInvalidDataFormatInExcelCellFixedAssetActivePeriodLength',
      'strFixedAssetEndDateEndDateIsBeforeStartDate',
      'strFixedAssetEndDateIsAfterEndDate',
      'strFixedAssetLastProcessedDateError',
      'strFixedAssetEndDateIsAfterEndDate',
    ]);
    expect(r.errors[3]!.text).toBe('Невалидни данни в клетка P5. Не е намерена сметка с номер: 999.');
    expect(r.errors[1]!.text).toContain('8');
    const missing = checkAssetImport(sap.rows.slice(0, 1), [], ctx());
    expect(missing.errors.map((e) => e.key)).toEqual(['strFixedAssetInventoryNumberNotInDap']);
  });

  it('unknown location is a warning; inventory numbers are normalised', () => {
    const sap = readAssetSheet(sheet('САП', [SAP_HEADER, sapRow('12', { location: 'Склад' }), sapRow('13', { location: 'Мазе' })]), true);
    const dap = readAssetSheet(sheet('САП - ДАП', [DAP_HEADER, dapRow('0012'), dapRow('13')]), false);
    const r = checkAssetImport(sap.rows, dap.rows, ctx({ normalizeInventoryNumber: (n) => n.padStart(6, '0') }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.text)).toEqual(['Ред 3: не е намерено местонахождение „Мазе“. Активът ще бъде записан в основната група.']);
    expect(r.assets.map((a) => [a.inventoryNumber, a.locationId, a.sap.accrued, a.dap.accrued])).toEqual([['000012', 5, '1100.00', '1200.00'], ['000013', null, '1100.00', '1200.00']]);
  });

  it('plan input: life, else rate, else the end date; accrued up to ToDate', () => {
    const base = { acquisitionDate: '2025-01-10', startDate: '2025-01-15', toDate: '2025-12-31', accrued: '1100.00', residualValue: '0.00', depreciationAmount: '2400.00' };
    expect(importedPlanInput({ ...base, endDate: null, activePeriodLength: 24, annualRate: null }, true, true)).toMatchObject({ calcType: 'period', activePeriodLength: 24, manualAccrued: { date: '2025-12-31', amount: '1100.00' } });
    expect(importedPlanInput({ ...base, endDate: null, activePeriodLength: null, annualRate: '50' }, true, true)).toMatchObject({ calcType: 'period', activePeriodLength: 24 });
    // САП starts the month after the start date; ДАП (not synchronised) includes it.
    expect(importedPlanInput({ ...base, endDate: '2027-01-01', activePeriodLength: null, annualRate: null }, true, false).activePeriodLength).toBe(24);
    expect(importedPlanInput({ ...base, endDate: '2026-12-01', activePeriodLength: null, annualRate: null }, false, false).activePeriodLength).toBe(24);
    expect(importedPlanInput({ ...base, accrued: '0.00', endDate: null, activePeriodLength: 24, annualRate: null }, true, true).manualAccrued).toBeNull();
  });
});
