import type { ScreenDef } from './shell/workspace.tsx';
import { BankImport, BankTemplates } from './screens/exchange/Bank.tsx';
import { BackupScreen, ChooseCompany, EuroConversion, ReportExports, RestoreScreen } from './screens/exchange/Company.tsx';
import { DeltaConversion, ExcelImport, TextImport, TrzImport, XmlExport, XmlImport } from './screens/exchange/Imports.tsx';

/** Data exchange and database operations (spec 04a, 04b, 01b 1-2). */
export const EXCHANGE_SCREENS: ScreenDef[] = [
  { id: 'textImport', title: 'Импорт от текстов файл', component: TextImport, permission: 'UI_Operations_Import_TXTImport' },
  { id: 'excelImport', title: 'Импорт от Excel', component: ExcelImport, permission: 'UI_Operations_Import_ExcelImport' },
  { id: 'xmlImport', title: 'Импорт от XML', component: XmlImport, permission: 'UI_Operations_Import_XMLImport' },
  { id: 'xmlExport', title: 'Експорт към XML', component: XmlExport, permission: 'UI_Operations_Export_XMLExport' },
  { id: 'trzImport', title: 'Импорт от ТРЗ Pro', component: TrzImport, permission: 'UI_Operations_Import_TRZProImport' },
  { id: 'bankImport', title: 'Импорт на банкови извлечения', component: BankImport, permission: 'UI_Operations_BankStatements_BankStatementsImport' },
  { id: 'bankTemplates', title: 'Шаблони за банков импорт', component: BankTemplates, permission: 'UI_Operations_BankStatements_BankTemplatesImport' },
  { id: 'backup', title: 'Архивиране на фирма', component: BackupScreen, permission: 'UI_File_BackupDatabase' },
  { id: 'restore', title: 'Възстановяване на фирма', component: RestoreScreen, permission: 'UI_File_RestoreDatabaseBackup' },
  { id: 'chooseCompany', title: 'Избор на фирма', component: ChooseCompany, permission: 'UI_File_ChooseCompany' },
  { id: 'euroConversion', title: 'Конвертиране към евро', component: EuroConversion, permission: 'UI_Edit_Administration' },
  { id: 'reportExports', title: 'Експорт към външни системи', component: ReportExports, permission: 'UI_Reporting' },
  { id: 'deltaConversion', title: 'Импорт от Microinvest Делта', component: DeltaConversion, permission: 'UI_Edit_Administration_DeltaConversion' },
];
