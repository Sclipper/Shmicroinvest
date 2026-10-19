import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAnyPermission, requirePermission } from '../session.ts';
import {
  JOURNAL_FILTER_COLUMNS, JOURNAL_SORT_COLUMNS, analyticalRegister, chartReport, compareAccountNumbers, generalLedger, partnerTurnover, trialBalance,
  type JournalFilterColumn, type JournalLineFilter, type JournalSortColumn, type PeriodFilter,
} from '../services/reports.ts';
import { TRIAL_BALANCE_ANY_COLUMNS, filterTrialRows, ledgerZeroTurnoverAccounts, trialFilterColumn } from '../services/reportVariants.ts';

/** Common query parameters: from, to, byExportMonth=1, companyId (comma list). */
function period(q: Record<string, string>, year: number): PeriodFilter {
  return {
    startDate: q.from ?? `${year}-01-01`,
    endDate: q.to ?? `${year}-12-31`,
    byExportMonth: q.byExportMonth === '1',
    companyIds: q.companyId ? q.companyId.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined,
  };
}

const list = (v: string | undefined) => (v ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const optNumber = (v: string | undefined) => (v ? Number(v) || undefined : undefined);

function filterColumn(v: string | undefined): JournalFilterColumn | '' {
  if (!v) return '';
  if (!(JOURNAL_FILTER_COLUMNS as readonly string[]).includes(v)) throw badRequest('Невалидна колона за филтър.');
  return v as JournalFilterColumn;
}
function sortColumn(v: string | undefined): JournalSortColumn | '' {
  if (!v) return '';
  if (!(JOURNAL_SORT_COLUMNS as readonly string[]).includes(v)) throw badRequest('Невалидна колона за сортиране.');
  return v as JournalSortColumn;
}
const family = (v: string | undefined) => (v === 'currency' || v === '1' ? 'currency' : v === 'quantity' || v === '2' ? 'quantity' : 'standard');

/**
 * Filters of the chronological register (05 5): debit/credit account each with
 * "С подсметките" (debitSub=0 / creditSub=0 turn it off), the excluded lists,
 * entry-number range, partner(s), document type and number, transaction type,
 * VAT operation, "Филтър по" (filterColumn + text), sort and report type.
 */
export function journalFilterFromQuery(q: Record<string, string>, year: number): JournalLineFilter {
  const p = period(q, year);
  if (p.startDate > p.endDate) throw badRequest('Началната дата е след крайната дата.');
  return {
    ...p,
    debitAccount: q.debit || undefined, debitWithSub: q.debitSub !== '0',
    creditAccount: q.credit || undefined, creditWithSub: q.creditSub !== '0',
    excludedDebitAccounts: list(q.excludeDebit), excludedCreditAccounts: list(q.excludeCredit),
    account: q.account || undefined, accountWithSub: q.sub !== '0',
    fromNumber: q.fromNumber || undefined, toNumber: q.toNumber || undefined,
    documentTypeId: optNumber(q.documentTypeId), documentNumber: q.documentNumber?.trim() || undefined,
    transactionTypeId: optNumber(q.transactionTypeId), vatTermId: optNumber(q.vatTermId),
    text: q.text, filterColumn: filterColumn(q.filterColumn), sortColumn: sortColumn(q.sort),
    family: family(q.type),
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
    const o = {
      ...period(q, c.var.year.year), accountNumber: q.account || undefined,
      subAccountLevel: q.level ? Number(q.level) : 0, withBalances: q.balances !== '0',
    };
    const groups = await generalLedger(c.var.db, o);
    // "Включване на сметки със салда и с нулеви обороти" (with balances only, 05 4.1).
    if (o.withBalances && q.zero === '1') {
      groups.push(...(await ledgerZeroTurnoverAccounts(c.var.db, o, new Set(groups.map((g) => g.number)))));
      groups.sort((a, b) => compareAccountNumbers(a.number, b.number));
    }
    return c.json(groups);
  })
  /** Account card (05 4.2): type=standard|currency|quantity, sub=0, filterColumn + text, sort. */
  .get('/reports/analytical', requirePermission('UI_Reporting_AnalyticalReport'), async (c) => {
    const q = c.req.query();
    if (!q.account) return c.json({ error: 'Не е избрана сметка.' }, 400);
    return c.json(await analyticalRegister(c.var.db, {
      ...period(q, c.var.year.year), accountNumber: q.account, withSub: q.sub !== '0',
      text: q.text, filterColumn: filterColumn(q.filterColumn), sortColumn: sortColumn(q.sort), reportType: family(q.type),
    }));
  })
  .get('/reports/partner-turnover',
    // Shared by the trial balance "По партньори" (UI_Reporting_TurnoverReport) and the
    // "Оборотна ведомост по партньори" screen under Справки > Фирми (its partner-debts key).
    requireAnyPermission('UI_Reporting_TurnoverReport', 'UI_Reporting_Companies_PartnersDebtReport'), async (c) => {
      const q = c.req.query();
      if (!q.account) return c.json({ error: 'Не е избрана сметка.' }, 400);
      const column = trialFilterColumn(q.filterColumn, 'partners');
      const rows = await partnerTurnover(c.var.db, { ...period(q, c.var.year.year), accountNumber: q.account, showZeroRows: q.zero === '1' });
      return c.json(filterTrialRows(rows, column, q.filter, TRIAL_BALANCE_ANY_COLUMNS.partners));
    })
  .get('/reports/chart', requirePermission('UI_Reporting_ChartOfAccountsReport'), async (c) => {
    const q = c.req.query();
    return c.json(await chartReport(c.var.db, c.var.year.year, q.level ? Number(q.level) : 5, q.account ?? ''));
  });
