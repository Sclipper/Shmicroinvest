import { describe, expect, it } from 'vitest';
import { REPORT_SHORT_NAMES, depreciationPlanShortName, depreciationQuotasShortName, partnerDebtsShortName } from '../src/index.ts';

describe('report short names (05, default file and tab names)', () => {
  it('keeps the shipped strings, typos included (D-05-7)', () => {
    expect(REPORT_SHORT_NAMES.strTurnOverMaterialShortName).toBe('ОВ СМЗ');
    expect(REPORT_SHORT_NAMES.strGeneralLedgerReportStandardShortName).toBe('ГлКнига');
    expect(REPORT_SHORT_NAMES.strCashReportStandardShortName).toBe('ПКО');
    expect(REPORT_SHORT_NAMES.strCashReportRKOStandardShortName).toBe('РКО');
    expect(REPORT_SHORT_NAMES.strGoodsMovementReportShortName).toBe('СМЗ Движение');
    // "ИнвентKнига" with a Latin K.
    expect(REPORT_SHORT_NAMES.strInventoryBookShortName).toBe('ИнвентKнига');
    expect(/[A-Za-z]/.test(REPORT_SHORT_NAMES.strInventoryBookShortName)).toBe(true);
  });

  it('partner debts: one name per Тип справка and Ниво на справка', () => {
    expect(partnerDebtsShortName(false, 'accounting')).toBe('Задължения вземания по контиране');
    expect(partnerDebtsShortName(true, 'partner')).toBe('Задължения вземания валута');
    expect(partnerDebtsShortName(true, 'document')).toBe('Задължения вземания по документ валута');
    expect(partnerDebtsShortName(true, 'accounting')).toBe('Задължения вземания по контитране валута');
    expect(new Set((['partner', 'document', 'accounting'] as const).flatMap((l) => [partnerDebtsShortName(false, l), partnerDebtsShortName(true, l)])).size).toBe(6);
  });

  it('fixed assets: plan and quotas by plan', () => {
    expect([depreciationPlanShortName('sap'), depreciationPlanShortName('dap'), depreciationPlanShortName('ias')]).toEqual(['САП', 'ДАП', 'Преоценка ДА по МСС']);
    expect([depreciationQuotasShortName('sap'), depreciationQuotasShortName('dap')]).toEqual(['Счет.аморт.квоти', 'Дан.аморт.квоти']);
  });
});
