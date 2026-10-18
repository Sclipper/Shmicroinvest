import type { ScreenDef } from './shell/workspace.tsx';
import { Analytical } from './reports/Analytical.tsx';
import { ChartReport } from './reports/ChartReport.tsx';
import { Chronological } from './reports/Chronological.tsx';
import { GeneralLedger } from './reports/GeneralLedger.tsx';
import { PartnerTurnover } from './reports/PartnerTurnover.tsx';
import { TrialBalance } from './reports/TrialBalance.tsx';

/** Report screens (Справки). */
export const REPORT_SCREENS: ScreenDef[] = [
  { id: 'trialBalance', title: 'Оборотна ведомост', component: TrialBalance, permission: 'UI_Reporting_TurnoverReport' },
  { id: 'chronological', title: 'Хронологичен регистър', component: Chronological, permission: 'UI_Reporting_ChronologicalReport' },
  { id: 'analytical', title: 'Аналитичен регистър', component: Analytical, permission: 'UI_Reporting_AnalyticalReport' },
  { id: 'generalLedger', title: 'Главна книга', component: GeneralLedger, permission: 'UI_Reporting_GeneralLedger' },
  { id: 'partnerTurnover', title: 'Задължения/вземания по партньори', component: PartnerTurnover, permission: 'UI_Reporting_Companies_PartnersDebtReport' },
  { id: 'chartReport', title: 'Индивидуален сметкоплан (справка)', component: ChartReport, permission: 'UI_Reporting_ChartOfAccountsReport' },
];
