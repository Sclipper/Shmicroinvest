import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { requirePermission } from '../session.ts';
import { accountBalances, type PeriodFilter, type TrialBalanceOptions } from '../services/reports.ts';
import {
  TRIAL_BALANCE_FILTER_COLUMNS, trialBalanceByMonths, trialBalanceExtended, trialBalanceFiltered, type TrialBalanceFilterColumn,
} from '../services/reportVariants.ts';

/** Trial-balance variants (spec 05 3.5) and the balances report (4.3). */

function period(q: Record<string, string>, year: number): PeriodFilter {
  const startDate = q.from ?? `${year}-01-01`;
  const endDate = q.to ?? `${year}-12-31`;
  // 05 section 13: inverted dates do not run.
  if (startDate > endDate) throw badRequest('Началната дата е след крайната дата.');
  return { startDate, endDate, byExportMonth: q.byExportMonth === '1', companyIds: q.companyId ? q.companyId.split(',').map(Number) : undefined };
}

function trialOptions(q: Record<string, string>, year: number, defaultLevel = 0): TrialBalanceOptions {
  return {
    ...period(q, year),
    accountNumber: q.account || undefined,
    subAccountLevel: q.level ? Number(q.level) : defaultLevel,
    showZeroRows: q.zero === '1',
    withoutOffBalance: q.offBalance === '0',
  };
}

const TB = 'UI_Reporting_TurnoverReport';

export const reportVariantRoutes = new Hono<AppEnv>()
  /** Standard layout with the free-text filter (Филтър по / Филтър / Търсене във всички нива). */
  .get('/reports/trial-balance-filtered', requirePermission(TB), async (c) => {
    const q = c.req.query();
    const column = (q.filterColumn ?? '') as TrialBalanceFilterColumn;
    if (column && !TRIAL_BALANCE_FILTER_COLUMNS.includes(column as never)) throw badRequest('Невалидна колона за филтър.');
    return c.json(await trialBalanceFiltered(c.var.db, { ...trialOptions(q, c.var.year.year), filterColumn: column, filterText: q.filter, searchAllLevels: q.allLevels === '1' }));
  })
  /** Валутна: default level 5 (spTurnoverReportFC). */
  .get('/reports/trial-balance-fc', requirePermission(TB), async (c) => c.json(await trialBalanceExtended(c.var.db, { ...trialOptions(c.req.query(), c.var.year.year, 5), family: 'currency' })))
  /** Материална (spTurnoverReportMT). */
  .get('/reports/trial-balance-mt', requirePermission(TB), async (c) => c.json(await trialBalanceExtended(c.var.db, { ...trialOptions(c.req.query(), c.var.year.year), family: 'quantity' })))
  /** По периоди (spTurnoverReportM): no partner filter, no off-balance switch. */
  .get('/reports/trial-balance-months', requirePermission(TB), async (c) => {
    const o = trialOptions(c.req.query(), c.var.year.year);
    return c.json(await trialBalanceByMonths(c.var.db, { ...o, companyIds: undefined, withoutOffBalance: false }));
  })
  /** spBalancesReport: opening, turnover and closing of one account (with sub-accounts unless sub=0). */
  .get('/reports/balances', requirePermission('UI_Reporting_AnalyticalReport'), async (c) => {
    const q = c.req.query();
    if (!q.account) throw badRequest('Не е избрана сметка.');
    return c.json(await accountBalances(c.var.db, q.account, period(q, c.var.year.year), q.sub !== '0'));
  });
