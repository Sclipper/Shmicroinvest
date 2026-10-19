import ExcelJS from 'exceljs';
import { sum } from '@shmi/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Fixed-assets Excel import (04a 5.5, 03b 14.2): САП sheet + "{name} - ДАП" sheet. */

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany({ year: 2026 });
});
afterAll(async () => t?.close());

const SAP_HEADER = ['Инвентарен номер', 'Наименование', 'МОЛ', 'Местонахождение', 'Категория', 'Дата на придобиване', 'Дата на въвеждане в експлоатация', 'Крайна дата', 'Към дата',
  'Полезен срок (месеци)', 'Годишна норма (%)', 'Начислена амортизация', 'Остатъчна стойност', 'Амортизируема стойност', 'Преоценъчен резерв', 'Сметка на актива',
  'Сметка за амортизация', 'Разходна сметка', 'Синхронизирани планове'];
const DAP_HEADER = ['InventoryNumber', 'Name', 'DepreciationCategory', 'AcquisitionDate', 'StartDate', 'EndDate', 'ToDate', 'ActivePeriodLength', 'AnnualDepreciationRate', 'AccruedDepreciation', 'ResidualValue', 'DepreciationAmount'];

type Row = Partial<Record<'name' | 'location' | 'life' | 'rate' | 'accrued' | 'reserve' | 'account' | 'sync' | 'to' | 'end', string | number>>;
const sapRow = (inv: string, o: Row = {}) => [
  inv, o.name ?? `Машина ${inv}`, 'Иван Петров', o.location ?? '', 'Категория 2', '10.01.2025', '15.01.2025', o.end ?? '', o.to ?? '31.12.2025',
  o.life ?? 24, o.rate ?? '', o.accrued ?? 1100, 0, 2400, o.reserve ?? 0, o.account ?? '203', '241/2', '603', o.sync ?? 'Не',
];
const dapRow = (inv: string, o: Row = {}) => [inv, `Машина ${inv}`, 'Категория 2', '10.01.2025', '15.01.2025', o.end ?? '', o.to ?? '31.12.2025', o.life ?? 24, o.rate ?? '', o.accrued ?? 1200, 0, 2400];

async function workbook(sap: unknown[][], dap: unknown[][] | null, name = 'Активи') {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet(name);
  for (const r of [SAP_HEADER, ...sap]) a.addRow(r);
  if (dap) {
    const d = wb.addWorksheet(`${name} - ДАП`);
    for (const r of [DAP_HEADER, ...dap]) d.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const upload = async (contentBase64: string) => t.call('POST', '/assets/import-excel', { fileName: 'активи.xlsx', contentBase64 });
const assetCount = async () => ((await t.call('GET', '/assets')).body as unknown[]).length;

type Month = { month: string; amount: string; isProcessed: boolean; accountingId: number | null };
type Plan = { months: Month[]; accrued: string; lastProcessedDate: string; endDate: string; revaluationReserve: string };

describe('fixed-assets Excel import', () => {
  it('imports both plans with the accrued amounts up to ToDate (IAS mode)', async () => {
    await t.call('POST', '/asset-locations', { name: 'Склад', parentId: 1 });
    const r = await upload(await workbook(
      [sapRow('12', { location: 'Склад' }), sapRow('13', { location: 'Мазе', life: '', rate: 50, sync: 'Да' })],
      [dapRow('12'), dapRow('13', { life: '', rate: 50 })],
    ));
    expect(r.status, r.text).toBe(200);
    expect(r.body.imported).toBe(2);
    expect(r.body.message).toBe('Импортирани дълготрайни активи: 2.');
    expect(r.body.warnings.map((w: { key: string }) => w.key)).toContain('strFixedAssetLocationNotFound');

    const a = (await t.call('GET', `/assets/${r.body.ids[0]}`)).body as { inventoryNumber: string; accounting: Plan; tax: Plan; locationId: number; personInCharge: string };
    // Numeric inventory numbers are padded to the sequence length (10).
    expect(a.inventoryNumber).toBe('0000000012');
    expect(a.personInCharge).toBe('Иван Петров');
    // САП: Feb-Dec 2025 processed with 1 100.00, the remaining 1 300.00 over the 13 remaining months.
    expect(a.accounting.lastProcessedDate.slice(0, 7)).toBe('2025-12');
    expect(a.accounting.accrued).toBe('1100.00');
    const sapLater = a.accounting.months.filter((m) => m.month >= '2026-01-01');
    expect(sapLater).toHaveLength(13);
    expect(sapLater.every((m) => m.amount === '100.00' && !m.isProcessed)).toBe(true);
    expect(a.accounting.months.filter((m) => m.month < '2026-01-01').every((m) => m.isProcessed && m.accountingId === null)).toBe(true);
    // ДАП (start month included): 12 months processed, 1 200.00 left over 12 months.
    expect(sum(a.tax.months.filter((m) => m.month < '2026-01-01').map((m) => m.amount)).toFixed(2)).toBe('1200.00');
    const dapLater = a.tax.months.filter((m) => m.month >= '2026-01-01');
    expect(dapLater).toHaveLength(12);
    expect(dapLater.every((m) => m.amount === '100.00')).toBe(true);

    // 50 % -> 24 months; synchronised plans.
    const b = (await t.call('GET', `/assets/${r.body.ids[1]}`)).body as { inventoryNumber: string; synchronized?: boolean; areDepreciationsSynchronized?: boolean; accounting: Plan };
    expect(b.inventoryNumber).toBe('0000000013');
    expect(b.accounting.months.filter((m) => m.month >= '2026-01-01')).toHaveLength(13);
  });

  it('the revaluation reserve goes into the САП year plan and the remaining base', async () => {
    const r = await upload(await workbook([sapRow('20', { reserve: 260 })], [dapRow('20')]));
    expect(r.status, r.text).toBe(200);
    const a = (await t.call('GET', `/assets/${r.body.ids[0]}`)).body as { revaluationReserve: string; accounting: Plan };
    expect(a.revaluationReserve).toBe('260.00');
    const later = a.accounting.months.filter((m) => m.month >= '2026-01-01');
    expect(later).toHaveLength(13);
    expect(later.every((m) => m.amount === '120.00')).toBe(true);
  });

  it('every cross-sheet error blocks the import and is reported together', async () => {
    const before = await assetCount();
    const r = await upload(await workbook(
      [sapRow('12'), sapRow('30', { account: '999' }), sapRow('31', { life: '' }), sapRow('32', { end: '01.01.2024' })],
      [dapRow('12'), dapRow('30'), dapRow('31', { life: '' }), dapRow('32'), dapRow('33')],
    ));
    expect(r.status).toBe(422);
    expect(r.body.error.startsWith('Импортът не може да бъде извършен поради следните причини:')).toBe(true);
    expect(r.body.messages.map((m: { key: string }) => m.key)).toEqual([
      'strFixedAssetInventoryNumberNotInSap',
      'strFixedAssetInventoryNumbersExistsInDatabase',
      'strInvalidAccountNumberInExcelCellFixedAsset',
      'strInvalidDataFormatInExcelCellFixedAssetActivePeriodLength',
      'strInvalidDataFormatInExcelCellFixedAssetActivePeriodLength',
      'strFixedAssetEndDateEndDateIsBeforeStartDate',
      'strFixedAssetEndDateIsAfterEndDate',
    ]);
    expect(r.body.messages[2].text).toBe('Невалидни данни в клетка P3. Не е намерена сметка с номер: 999.');
    expect(await assetCount()).toBe(before);
  });

  it('a workbook without the ДАП sheet and a bad cell are rejected', async () => {
    const r = await upload(await workbook([sapRow('40')], null));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Не е намерен таб с информация за ДАП в импортирания файл.');
    const bad = await upload(await workbook([sapRow('41', { to: 'вчера' })], [dapRow('41')]));
    expect(bad.status).toBe(422);
    expect(bad.body.messages[0].text).toBe('Невалидни данни в клетка I2 (таб САП): вчера.');
  });

  it('the template has the САП and "САП - ДАП" sheets', async () => {
    const res = await t.app.request('/api/assets/import-excel/template', { headers: { cookie: t.session.get() } });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['САП', 'САП - ДАП']);
    expect(wb.worksheets[0]!.getRow(1).getCell(1).value).toBe('Инвентарен номер');
    expect(wb.worksheets[1]!.actualColumnCount).toBe(12);
  });
});
