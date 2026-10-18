import type { ScreenDef } from './shell/workspace.tsx';
import { ActiveCompany } from './screens/admin/ActiveCompany.tsx';
import { Activity } from './screens/admin/Activity.tsx';
import { ChartSelection } from './screens/admin/ChartSelection.tsx';
import { MyCompany } from './screens/admin/MyCompany.tsx';
import { Countries, Currencies, Dictionary, Products } from './screens/admin/Nomenclatures.tsx';
import { Settings } from './screens/admin/Settings.tsx';
import { Users } from './screens/admin/Users.tsx';
import { Validator } from './screens/admin/Validator.tsx';
import { Years } from './screens/admin/Years.tsx';
import { ApplicationLog, GdprValidator } from './screens/admin/Platform.tsx';

/** Administration and nomenclature screens. */
export const ADMIN_SCREENS: ScreenDef[] = [
  { id: 'years', title: 'Счетоводна година', component: Years, permission: 'UI_Edit_ChangeActiveFinancialYear' },
  { id: 'myCompany', title: 'Моята фирма', component: MyCompany, permission: 'UI_Edit_Administration_MyCompany' },
  { id: 'users', title: 'Потребители', component: Users, permission: 'UI_Edit_Administration_Users' },
  { id: 'settings', title: 'Настройки', component: Settings, permission: 'UI_Other_Settings' },
  { id: 'currencies', title: 'Валути', component: Currencies, permission: 'UI_Edit_Currencies' },
  { id: 'countries', title: 'Държави', component: Countries, permission: 'UI_Edit_Administration_EditTermsAndReferences' },
  { id: 'dictionary', title: 'Основания и забележки', component: Dictionary, permission: 'UI_Edit_Administration_EditTermsAndReferences' },
  { id: 'products', title: 'Дефиниране на СМЗ', component: Products, permission: 'UI_Operations_Products_DefineProducts' },
  { id: 'validator', title: 'Проверка на ДДС номер, ЕИК, ЕГН, IBAN', component: Validator, permission: 'UI_Other_Validator' },
  { id: 'activeCompany', title: 'Активна фирма', component: ActiveCompany, permission: 'UI_File_ActiveCompany' },
  { id: 'activity', title: 'Действия по потребители', component: Activity, permission: 'UI_Reporting_UsersActivitiesReport' },
  { id: 'gdpr', title: 'GDPR проверка', component: GdprValidator, permission: 'UI_Other_GDPRValidator' },
  { id: 'appLog', title: 'Дневник на приложението', component: ApplicationLog, permission: 'UI_Help_ApplicationLog' },
  { id: 'chartSelection', title: 'Избор на сметкоплан', component: ChartSelection, permission: 'UI_Operations_ChartOfAccounts_ChartOfAccountsSelection' },
];
