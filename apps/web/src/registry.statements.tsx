import type { ScreenDef } from './shell/workspace.tsx';
import { FinancialStatements } from './statements/FinancialStatements.tsx';
import { StatementFormulasEditor } from './statements/StatementFormulasEditor.tsx';
import { UserReports } from './statements/UserReports.tsx';

/** Financial statements, their formula editor and the user-defined reports (spec 05 sections 9-10). */
export const STATEMENT_SCREENS: ScreenDef[] = [
  { id: 'financialStatements', title: 'Отчети и баланс', component: FinancialStatements, permission: 'UI_Reporting_FinancialReports' },
  { id: 'statementFormulas', title: 'Редакция на отчети и баланс', component: StatementFormulasEditor, permission: 'UI_Edit_Administration_StatementFormulas' },
  { id: 'userReports', title: 'Мениджър на потребителските справки', component: UserReports, permission: 'UI_Reporting_UserReportsManager' },
];
