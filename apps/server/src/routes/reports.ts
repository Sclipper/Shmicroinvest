import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { requirePermission } from '../session.ts';
import { analyticalRegister, chartReport, generalLedger, partnerTurnover, trialBalance, type PeriodFilter } from '../services/reports.ts';

/** Common query parameters: from, to, byExportMonth=1, companyId. */
function period(q: Record<string, string>, year: number): PeriodFilter {
  return {
    startDate: q.from ?? `${year}-01-01`,
    endDate: q.to ?? `${year}-12-31`,
    byExportMonth: q.byExportMonth === '1',
    companyIds: q.companyId ? q.companyId.split(',').map(Number) : undefined,
  };
}

export const reportRoutes = new Hono<AppEnv>()
  .get('/reports/trial-balance', requirePermission('UI_Reporting_TurnoverReport'), async (c) => {
    const q = c.req.query();
    return c.json(await trialBalance(c.var.db, {
      ...period(q, c.var.year.year),
      accountNumber: q.account || undefined,
      subAccountLevel: q.level ? Number(q.level) : 0,
      showZeroRows: q.zero === '1',
      withoutOffBalance: q.offBalance === '0',
    }));
  })
  .get('/reports/general-ledger', requirePermission('UI_Reporting_GeneralLedger'), async (c) => {
    const q = c.req.query();
    return c.json(await generalLedger(c.var.db, {
      ...period(q, c.var.year.year), accountNumber: q.account || undefined,
      subAccountLevel: q.level ? Number(q.level) : 0, withBalances: q.balances !== '0',
    }));
  })
  .get('/reports/analytical', requirePermission('UI_Reporting_AnalyticalReport'), async (c) => {
    const q = c.req.query();
    if (!q.account) return c.json({ error: 'Не е избрана сметка.' }, 400);
    return c.json(await analyticalRegister(c.var.db, { ...period(q, c.var.year.year), accountNumber: q.account, withSub: q.sub !== '0', text: q.text }));
  })
  .get('/reports/partner-turnover', requirePermission('UI_Reporting_Companies'), async (c) => {
    const q = c.req.query();
    if (!q.account) return c.json({ error: 'Не е избрана сметка.' }, 400);
    return c.json(await partnerTurnover(c.var.db, { ...period(q, c.var.year.year), accountNumber: q.account, showZeroRows: q.zero === '1' }));
  })
  .get('/reports/chart', requirePermission('UI_Reporting_ChartOfAccountsReport'), async (c) => {
    const q = c.req.query();
    return c.json(await chartReport(c.var.db, c.var.year.year, q.level ? Number(q.level) : 5, q.account ?? ''));
  });
