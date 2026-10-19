/**
 * Short names of the reports (05 *, "short name"): the default name of the
 * exported file and of the tab. Delta builds the file name as the short name
 * plus the period; the strings are kept as shipped, typos included ("ИнвентKнига"
 * with a Latin K, "контитране"), because customers' scripts may rely on the
 * file names (D-05-7). Keys are the resx keys where the spec gives them; the
 * others (and the standard partner/document names of the partner debts) follow
 * the same pattern.
 */
export const REPORT_SHORT_NAMES = {
  // Оборотна ведомост (05 1)
  strTurnOverStandardShortName: 'ОВ',
  strTurnOverForeignCurrencyShortName: 'ОВ валутна',
  strTurnOverMaterialShortName: 'ОВ СМЗ',
  strTurnOverCompanyShortName: 'ОВ партньори',
  strTurnOverMonthsShortName: 'ОВ по периоди',
  // Главна книга (05 2)
  strGeneralLedgerReportStandardShortName: 'ГлКнига',
  strGeneralLedgerReportWithOpenningBalancesShortName: 'ГлКнига салда',
  // Задължения/вземания по партньори (05 6.4): Тип справка x Ниво на справка
  strPartnerDebtsReportStandardPartnerShortName: 'Задължения вземания',
  strPartnerDebtsReportStandardDocumentShortName: 'Задължения вземания по документ',
  strPartnerDebtsReportStandardAccountingShortName: 'Задължения вземания по контиране',
  strPartnerDebtsReportFCPartnerShortName: 'Задължения вземания валута',
  strPartnerDebtsReportFCDocumentShortName: 'Задължения вземания по документ валута',
  strPartnerDebtsReportFCAccountingShortName: 'Задължения вземания по контитране валута',
  // Касов ордер (05 6.9)
  strCashReportStandardShortName: 'ПКО',
  strCashReportRKOStandardShortName: 'РКО',
  // СМЗ (05 9)
  strPurchaseReportShortName: 'СМЗ Доставки',
  strSaleReportShortName: 'СМЗ Продажби',
  strGoodsMovementReportShortName: 'СМЗ Движение',
  strAveragePriceReportShortName: 'СМЗ СрПретегл ст-т изписване',
  strWriteOutReportShortName: 'СМЗ С-стИзписване продажба',
  // Дълготрайни активи (05 10)
  strInventoryBookShortName: 'ИнвентKнига',
  strDepreciationPlanSapShortName: 'САП',
  strDepreciationPlanDapShortName: 'ДАП',
  strDepreciationPlanRevaluationShortName: 'Преоценка ДА по МСС',
  strMonthlyDepreciationQuotasSapShortName: 'Счет.аморт.квоти',
  strMonthlyDepreciationQuotasDapShortName: 'Дан.аморт.квоти',
  strAssetsByCategoriesShortName: 'ДА НАП',
  strAssetsByCategoriesByAssetsShortName: 'ДА НАП по активи',
} as const;

export type ReportShortNameKey = keyof typeof REPORT_SHORT_NAMES;

/** Short name of "Задължения/вземания по партньори" for its Тип справка (currency) and Ниво на справка. */
export function partnerDebtsShortName(currency: boolean, level: 'partner' | 'document' | 'accounting'): string {
  const lvl = level === 'partner' ? 'Partner' : level === 'document' ? 'Document' : 'Accounting';
  return REPORT_SHORT_NAMES[`strPartnerDebtsReport${currency ? 'FC' : 'Standard'}${lvl}ShortName` as ReportShortNameKey];
}

/** Short name of "Амортизационен план" by plan (sap, dap, ias = revaluation by IAS). */
export function depreciationPlanShortName(type: string): string {
  return REPORT_SHORT_NAMES[type === 'dap' ? 'strDepreciationPlanDapShortName' : type === 'ias' ? 'strDepreciationPlanRevaluationShortName' : 'strDepreciationPlanSapShortName'];
}

/** Short name of "Месечни амортизационни квоти" by plan (sap = accounting, dap = tax). */
export function depreciationQuotasShortName(type: string): string {
  return REPORT_SHORT_NAMES[type === 'dap' ? 'strMonthlyDepreciationQuotasDapShortName' : 'strMonthlyDepreciationQuotasSapShortName'];
}
