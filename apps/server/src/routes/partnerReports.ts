import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAnyPermission, requirePermission } from '../session.ts';
import {
  COMPANIES_FILTER_COLUMNS, companiesReport, confirmationLetters, overdues, partnerDebts, partnerMovement, paymentsReport, receivedIssued, type DebtLevel,
} from '../services/partnerReports.ts';
import { cashAndReceivables, cashBook, cashOrders } from '../services/cashReports.ts';

/**
 * Partner and cash reports (spec 05 6, 7). Query parameters follow
 * /reports/*: from, to, account, companyId (comma list), sort, filterColumn, filterText.
 */

const ids = (v?: string) => (v ? v.split(',').map(Number).filter(Boolean) : undefined);
const num = (v?: string) => (v ? Number(v) : undefined);
const flag = (v?: string) => v === '1';
const yearEnd = (y: number) => `${y}-12-31`;
const yearStart = (y: number) => `${y}-01-01`;
const LEVELS: DebtLevel[] = ['partner', 'document', 'accounting'];

export const partnerReportsRoutes = new Hono<AppEnv>()
  /** Справка партньори (spCompaniesReport): groupId (subtree), account (substring), filterColumn + filterText. Also printed from the partners list. */
  .get('/reports/companies', requireAnyPermission('UI_Reporting_Companies', 'UI_Edit_Companies'), async (c) => {
    const q = c.req.query();
    const column = q.filterColumn || '';
    if (column && !(COMPANIES_FILTER_COLUMNS as readonly string[]).includes(column)) throw badRequest('Невалидна колона за филтър.');
    return c.json(await companiesReport(c.var.db, {
      groupId: num(q.groupId), account: q.account || undefined, filterColumn: column as (typeof COMPANIES_FILTER_COLUMNS)[number] | '', filterText: q.filterText || undefined,
    }));
  })
  .get('/reports/partner-debts', requirePermission('UI_Reporting_Companies_PartnersDebtReport'), async (c) => {
    const q = c.req.query();
    const level = LEVELS.includes(q.level as DebtLevel) ? (q.level as DebtLevel) : 'partner';
    return c.json(await partnerDebts(c.var.db, {
      endDate: q.to ?? yearEnd(c.var.year.year), startDate: q.from || undefined, level, currency: flag(q.currency),
      accountNumber: q.account || undefined, companyIds: ids(q.companyId),
      documentTypeId: num(q.documentTypeId), documentNumber: level === 'partner' ? undefined : q.documentNumber || undefined,
      reference: q.reference || undefined, showClosed: flag(q.closed), showExpired: flag(q.expired),
      sort: q.sort || undefined, filterColumn: q.filterColumn || undefined, filterText: q.filterText || undefined,
    }));
  })
  .get('/reports/received-issued', requirePermission('UI_Reporting_Companies_ReceivedAndIssuedDocuments'), async (c) => {
    const q = c.req.query();
    return c.json(await receivedIssued(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year), byExportMonth: flag(q.byExportMonth),
      companyIds: ids(q.companyId), documentTypeId: num(q.documentTypeId), documentNumber: q.documentNumber || undefined,
      transactionTypeId: num(q.transactionTypeId), vatTermId: num(q.vatTermId), sort: q.sort || undefined,
    }));
  })
  .get('/reports/partner-movement', requirePermission('UI_Reporting_Companies_PartnerPaymentsAndDebtsReport'), async (c) => {
    const q = c.req.query();
    const direction = Number(q.direction ?? 0);
    return c.json(await partnerMovement(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year),
      accountNumber: q.account ?? '', companyId: num(q.companyId) ?? null,
      direction: direction === 1 || direction === 2 ? direction : 0, currency: flag(q.currency),
      sort: q.sort || undefined, filterColumn: q.filterColumn || undefined, filterText: q.filterText || undefined,
    }));
  })
  .get('/reports/payments', requirePermission('UI_Reporting_Companies_PaymentsReport'), async (c) => {
    const q = c.req.query();
    return c.json(await paymentsReport(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year),
      companyIds: ids(q.companyId), accountNumber: q.account || undefined,
      documentTypeId: num(q.documentTypeId), documentNumber: q.documentNumber || undefined,
      fromAmount: q.fromAmount || undefined, toAmount: q.toAmount || undefined, term: q.term || undefined, sort: q.sort || undefined,
    }));
  })
  .get('/reports/confirmation-letter', requirePermission('UI_Reporting_Companies_LiabilitiesLetterReport'), async (c) => {
    const q = c.req.query();
    return c.json(await confirmationLetters(c.var.db, {
      endDate: q.to ?? yearEnd(c.var.year.year), startDate: q.from || undefined,
      companyName: q.companyName || undefined, companyIds: ids(q.companyId), minSum: q.minSum || undefined,
    }));
  })
  .get('/reports/overdues', requirePermission('UI_Reporting_Companies_Overdues'), async (c) => {
    const q = c.req.query();
    return c.json(await overdues(c.var.db, {
      endDate: q.to ?? yearEnd(c.var.year.year), startDate: q.from || undefined,
      accountNumber: q.account || undefined, companyIds: ids(q.companyId),
    }));
  })
  .get('/reports/cash-and-receivables', requirePermission('UI_Reporting_CashReports_CashAndReceivables'), async (c) => {
    const q = c.req.query();
    return c.json(await cashAndReceivables(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year), subAccountLevel: num(q.level) ?? 0,
    }));
  })
  .get('/reports/cash-book', requirePermission('UI_Reporting_CashReports_CashBook'), async (c) => {
    const q = c.req.query();
    return c.json(await cashBook(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year),
      accountNumber: q.account || '501', withSubAccounts: flag(q.sub), companyName: q.companyName || undefined,
    }));
  })
  .get('/reports/cash-order', requirePermission('UI_Reporting_CashReports_CashOrder'), async (c) => {
    const q = c.req.query();
    return c.json(await cashOrders(c.var.db, {
      startDate: q.from ?? yearStart(c.var.year.year), endDate: q.to ?? yearEnd(c.var.year.year),
      documentTypeId: num(q.documentTypeId) ?? 8, accountNumber: q.account || '501', companyName: q.companyName || undefined,
      fromNumber: q.fromNumber || undefined, toNumber: q.toNumber || undefined,
    }));
  });
