import type { ScreenDef } from './shell/workspace.tsx';
import { ChartOfAccounts } from './screens/ChartOfAccounts.tsx';
import { EntryEditor } from './screens/EntryEditor.tsx';
import { Journal } from './screens/Journal.tsx';
import { Partners } from './screens/Partners.tsx';
import { InitialBalances } from './screens/InitialBalances.tsx';
import { REPORT_SCREENS } from './registry.reports.tsx';
import { ADMIN_SCREENS } from './registry.admin.tsx';
import { STATEMENT_SCREENS } from './registry.statements.tsx';

const defs: ScreenDef[] = [
  { id: 'entry', title: 'Контиране', component: EntryEditor, permission: 'UI_Operations_Accounting', multi: true },
  { id: 'journal', title: 'Редакция на контиране', component: Journal, permission: 'UI_Edit_Accountings' },
  { id: 'initialBalances', title: 'Начални салда', component: InitialBalances, permission: 'UI_Operations_ChartOfAccounts_ChartOfAccountsBalance' },
  { id: 'initialBalanceEntries', title: 'Контировки с начални салда', component: () => <Journal initial />, permission: 'UI_Operations_ChartOfAccounts_ChartOfAccountsBalance' },
  { id: 'chart', title: 'Индивидуален сметкоплан', component: ChartOfAccounts, permission: 'UI_Operations_ChartOfAccounts_IndividualChartOfAccounts' },
  { id: 'partners', title: 'Партньори', component: Partners, permission: 'UI_Edit_Companies' },
  ...REPORT_SCREENS,
  ...ADMIN_SCREENS,
  ...STATEMENT_SCREENS,
];

export const SCREENS: Record<string, ScreenDef> = Object.fromEntries(defs.map((d) => [d.id, d]));
