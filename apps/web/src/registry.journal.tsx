import type { ScreenDef, ScreenProps } from './shell/workspace.tsx';
import { EntryEditor } from './screens/EntryEditor.tsx';
import { FastEntry } from './screens/journal/FastEntry.tsx';
import { InitialCorrespondences } from './screens/journal/InitialCorrespondences.tsx';
import { MassEdit } from './screens/journal/MassEdit.tsx';
import { Reorder } from './screens/journal/Reorder.tsx';
import { Shortcuts } from './screens/settings/Shortcuts.tsx';
import { Templates } from './screens/templates/Templates.tsx';
import { TemplateSchedules } from './screens/templates/TemplateSchedules.tsx';
import { Reschedules } from './screens/templates/Reschedules.tsx';
import { ReschedulesReport } from './screens/templates/ReschedulesReport.tsx';
import { WriteOffs } from './screens/stock/WriteOffs.tsx';
import {
  AveragePriceReport, GoodsMovementReport, InventoryListReport, PurchaseReport, SaleReport, WriteOutReport,
} from './screens/stock/MaterialReports.tsx';

/** Delivery / sale of stock: the entry editor in material mode (spec 07 MaterialDetailsView). */
const DeliveryEditor = (p: ScreenProps) => <EntryEditor {...p} mode="delivery" />;
const SaleEditor = (p: ScreenProps) => <EntryEditor {...p} mode="sale" />;

/** Journal extras, stock operations and material reports (spec 02a, 03a 4, 05 7.9). */
export const JOURNAL_SCREENS: ScreenDef[] = [
  { id: 'fastEntry', title: 'Бързо контиране', component: FastEntry, permission: 'UI_Operations_FastAccounting' },
  { id: 'templates', title: 'Шаблони', component: Templates, permission: 'UI_Operations_Templates' },
  { id: 'templateSchedules', title: 'График с шаблони за осчетоводяване', component: TemplateSchedules, permission: 'UI_Operations_TemplateSchedules' },
  { id: 'reschedules', title: 'Разсрочване на приходи/разходи', component: Reschedules, permission: 'UI_Operations_AccountingReschedules' },
  { id: 'productDelivery', title: 'Доставка на СМЗ', component: DeliveryEditor, permission: 'UI_Operations_Products_Delivery', multi: true },
  { id: 'productSale', title: 'Продажба на СМЗ', component: SaleEditor, permission: 'UI_Operations_Products_Sale', multi: true },
  { id: 'writeOffs', title: 'Изписване на СМЗ', component: WriteOffs, permission: 'UI_Operations_Products_WriteOffs' },
  { id: 'initialCorrespondences', title: 'Начални кореспонденции', component: InitialCorrespondences, permission: 'UI_Operations_ChartOfAccounts_InitialCorrespondence' },
  { id: 'massEdit', title: 'Редакция на контировки', component: MassEdit, permission: 'UI_Edit_Administration_EditAccountings' },
  { id: 'reorder', title: 'Преподреждане на документи', component: Reorder, permission: 'UI_Edit_Administration_ReorderDocuments' },
  { id: 'shortcuts', title: 'Клавишни комбинации', component: Shortcuts, permission: 'UI_Other_Shortcuts' },
  { id: 'purchaseReport', title: 'Доставки', component: PurchaseReport, permission: 'UI_Reporting_MaterialReports_PurchaseReport' },
  { id: 'saleReport', title: 'Продажби', component: SaleReport, permission: 'UI_Reporting_MaterialReports_SaleReport' },
  { id: 'goodsMovementReport', title: 'Движение на стоки', component: GoodsMovementReport, permission: 'UI_Reporting_MaterialReports_GoodsMovementReport' },
  { id: 'writeOutReport', title: 'Стойност за изписване при продажба', component: WriteOutReport, permission: 'UI_Reporting_MaterialReports_WriteOutReport' },
  { id: 'averagePriceReport', title: 'Средно претеглена стойност и изписване', component: AveragePriceReport, permission: 'UI_Reporting_MaterialReports_AveragePriceReport' },
  // No seeded permission key exists for the inventory list; the material-reports group key guards it.
  { id: 'inventoryListReport', title: 'Инвентаризационен опис', component: InventoryListReport, permission: 'UI_Reporting_MaterialReports' },
  { id: 'reschedulesReport', title: 'Разсрочване на приходи и разходи', component: ReschedulesReport, permission: 'UI_Reporting_AccountingReschedules' },
];
