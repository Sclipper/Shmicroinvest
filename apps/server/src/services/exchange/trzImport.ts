import { and, eq } from 'drizzle-orm';
import {
  DataImportError, TRZ_REQUIRED_ACCOUNTS, critical, isCompanyCategory, msg, round2, trzAccountingDateValid, type ExchangeMessage,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { ApiError } from '../../lib/errors.ts';
import { rebuildAccountsTree } from '../chart.ts';
import { setConfig } from '../config.ts';
import { saveEntry } from '../journal.ts';
import { reserveNumber } from '../sequences.ts';
import { checkDates, loadChart, throwIf } from './common.ts';
import { importChartAccount, type ImportCtx } from './transfer.ts';

export const TRZ_IMPORT_TYPE = 51;

export async function trzMissingAccounts(db: DbOrTx, year: number) {
  const chart = await loadChart(db, year);
  return TRZ_REQUIRED_ACCOUNTS.filter((a) => !chart.byNumber.has(a.number));
}

/** "Дефиниране сега": creates the missing national-chart accounts (parents first). */
export async function trzDefineAccounts(db: DbOrTx, year: number) {
  const chart = await loadChart(db, year);
  const missing = TRZ_REQUIRED_ACCOUNTS.filter((a) => !chart.byNumber.has(a.number));
  for (const a of missing) {
    await importChartAccount(db, chart, { number: a.number, description: a.description }, {
      duplicate: 'reuse',
      fail: (_k, v) => new DataImportError(critical('strInvalidAccountNumberWithParam', v)),
    });
  }
  if (missing.length) await rebuildAccountsTree(db);
  return missing;
}

export interface TrzRowInput { itemId: number; itemName: string; departmentName?: string; amount: string; debit: string; credit: string }
export interface TrzImportInput {
  month: string; // yyyy-mm
  accountingDate: string;
  term: string;
  documentTypeId: number;
  rows: TrzRowInput[];
  confirmReimport?: boolean;
}

/** Validates the grid accounts (6.4). */
export function trzAccountErrors(chart: Awaited<ReturnType<typeof loadChart>>, rows: TrzRowInput[]): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  const seen = new Set<string>();
  const check = (n: string) => {
    const num = n.trim();
    if (seen.has(num)) return;
    seen.add(num);
    const a = chart.byNumber.get(num);
    if (!a) out.push(critical('strInvalidAccountNumberWithParam', num));
    else if (!a.isLeaf) out.push(critical('strSelectedAccountHasSubaccountsWithParam', num));
    else if (a.isForeignCurrency) out.push(critical('strNotAllowedCurrencyAccountWithParam', num));
    else if (isCompanyCategory(a.categoryId)) out.push(critical('strNotAllowedCompanyAccountWithParam', num));
    else if (a.isMaterial) out.push(critical('strNotAllowedMaterialAccountWithParam', num));
  };
  for (const r of rows) {
    if (round2(r.amount || '0').isZero()) continue;
    check(r.debit);
    check(r.credit);
  }
  return out;
}

export async function importTrz(tx: DbOrTx, input: TrzImportInput, ctx: ImportCtx) {
  if (!trzAccountingDateValid(input.accountingDate, input.month, ctx.year.year)) throw new DataImportError(critical('strImportTrzProIncorrectAccountingDate'));
  throwIf(checkDates([input.accountingDate], ctx.year));
  const chart = await loadChart(tx, ctx.year.year);
  const errs = trzAccountErrors(chart, input.rows);
  if (errs.length) throw new DataImportError([critical('strTrzProOperationsImportCantImportData'), ...errs]);
  const start = `${input.month}-01`;
  const [y, m] = input.month.split('-').map(Number);
  const end = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  const prior = await tx.select().from(s.importedPeriods).where(and(eq(s.importedPeriods.importType, TRZ_IMPORT_TYPE), eq(s.importedPeriods.startDate, start)));
  if (prior.length && !input.confirmReimport) throw new ApiError(409, msg('strTrzProOperationsImportIsImportedPeriod'), undefined, 'strTrzProOperationsImportIsImportedPeriod');
  const [period] = await tx.insert(s.importedPeriods).values({ importType: TRZ_IMPORT_TYPE, startDate: start, endDate: end, description: input.term }).returning({ id: s.importedPeriods.id });
  const [dt] = await tx.select().from(s.documentTypes).where(eq(s.documentTypes.id, input.documentTypeId));
  let count = 0;
  for (const r of input.rows) {
    const amount = round2(r.amount || '0');
    if (amount.isZero()) continue;
    const debit = chart.byNumber.get(r.debit.trim())!;
    const credit = chart.byNumber.get(r.credit.trim())!;
    const number = dt?.sequenceChannel ? (await reserveNumber(tx, dt.sequenceChannel, ctx.year.id, async () => false)).number : input.month.slice(5, 7);
    const saved = await saveEntry(tx, {
      accountingDate: input.accountingDate, documentDate: input.accountingDate, viesMonth: input.accountingDate, documentTypeId: input.documentTypeId, documentNumber: number,
      term: input.term, reference: r.itemName, transactionTypeId: 1, source: 'import-trz',
      debits: [{ accountId: debit.id, amount: amount.toFixed(2) }], credits: [{ accountId: credit.id, amount: amount.toFixed(2) }],
    }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
    await tx.update(s.accountings).set({ importedPeriodId: period!.id }).where(eq(s.accountings.id, saved.id));
    count++;
  }
  await setConfig(tx, 'LastTRZProImportPeriod', input.month, ctx.userId);
  return { accountings: count, message: msg('strTrzProOperationsImportFinished', `${input.month.slice(5, 7)}.${input.month.slice(0, 4)}`) };
}
