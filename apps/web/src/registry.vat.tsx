import type { ScreenDef } from './shell/workspace.tsx';
import { Article73 } from './screens/vat/Article73.tsx';
import { IcaReport } from './screens/vat/IcaReport.tsx';
import { NapCheck } from './screens/vat/NapCheck.tsx';
import { DocumentValidation } from './screens/vat/Validation.tsx';
import { VatClosing } from './screens/vat/VatClosing.tsx';
import { VatDiary } from './screens/vat/VatDiary.tsx';
import { VatImport } from './screens/vat/VatImport.tsx';

/** VAT screens (ДДС, spec 02b, 04a 1-2, 05 7). */
export const VAT_SCREENS: ScreenDef[] = [
  { id: 'vatDiary', title: 'ДДС дневници, декларация и VIES', component: VatDiary, permission: 'UI_Reporting_VATDiary' },
  { id: 'vatClosing', title: 'Приключване на ДДС', component: VatClosing, permission: 'UI_Operations_AutoOperations_VAT' },
  { id: 'article73', title: 'Коефициент по чл. 73 от ЗДДС', component: Article73, permission: 'UI_Operations_AutoOperations_VATOperations_VATRatio' },
  { id: 'icaReport', title: 'Протоколи по чл. 117 от ЗДДС', component: IcaReport, permission: 'UI_Reporting_ICAReport' },
  { id: 'vatValidation', title: 'Дублирани и липсващи документи', component: DocumentValidation, permission: 'UI_Reporting_Validation_AccountingsValidation' },
  { id: 'napCheck', title: 'Проверка на документи с файл от НАП', component: NapCheck, permission: 'UI_Reporting_Validation_AccountingsNAPFileValidation' },
  { id: 'vatImport', title: 'Импорт от ДДС Дневници', component: VatImport, permission: 'UI_Operations_Import_VATDiaryImport' },
];
