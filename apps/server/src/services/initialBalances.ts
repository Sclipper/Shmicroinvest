import { and, eq, inArray, sql } from 'drizzle-orm';
import { D, dec, isCompanyCategory, isLeaf, round2, type ValidationMessage } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import type { ActiveYear } from '../context.ts';
import { baseCurrencyId } from './journal.ts';

/**
 * Opening balances per account (Начални салда, 01b 7; 07 3.5
 * EditSimple/Currency/Material/CompanyAccountInitialBalancesView).
 *
 * Storage follows spConcludeFinancialYear: one accounting per balance row
 * (IsInitialBalance=1, Number ''), two lines on the SAME account (debit line
 * Amount=debit, credit line RefAmount=credit) and an AccountInitialBalances
 * row tying the accounting to the account, partner and document.
 */
export const INITIAL_BALANCE_MESSAGES = {
  strInitialBalancesBothSetError: 'Началните салда в дебит и в кредит са различни от 0. Задайте едно от тях на 0.',
  strInitalBalanceOnSyntheticAccountWarning: 'Препоръчително е началното салдо да бъде разпределено по съответните аналитични на сметката.',
  strInitialBalancesDateMustBeInCurrentYear: 'Избраната дата не може да бъде в друга счетоводна година!',
  strNotCorrectCompanyInitialBalance: 'Не е избран партньор за началното салдо!',
  strInitialBalancesDuplicateError: 'Партньорът е въведен повече от веднъж!',
  strInitialBalancesDuplicateDocumentError: 'Документът е въведен повече от веднъж за партньора!',
  strInitialBalancesEmptyDocumentTypeWithSumError: 'Не е избран тип на документ за въведената сума!',
  strInitialBalancesEmptyDocumentNumberError: 'Не е въведен номер на документ!',
  strInitialBalancesInvalidDocumentNumberError: 'Номерът на документа е невалиден!',
  strInitialBalancesInvalidDocumentDateError: 'Датата на документа е невалидна!',
  strCompanyNotAllowed: 'Сметката не поддържа работа с партньори!',
  strYearLocked: 'Счетоводната година е заключена за редакция!',
} as const;
type Key = keyof typeof INITIAL_BALANCE_MESSAGES;
const msg = (key: Key, severity: ValidationMessage['severity'] = 'critical', prefix = ''): ValidationMessage => ({ key, text: prefix + INITIAL_BALANCE_MESSAGES[key], severity });

export interface BalanceRowInput {
  companyId?: number | null;
  documentTypeId?: number | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  debit?: string | null;
  credit?: string | null;
  currencyDebit?: string | null;
  currencyCredit?: string | null;
  exchangeRate?: string | null;
  quantityDebit?: string | null;
  quantityCredit?: string | null;
}

export interface BalanceRow {
  accountingId: number;
  accountId: number;
  date: string;
  companyId: number | null;
  company: string | null;
  documentTypeId: number | null;
  documentNumber: string | null;
  documentDate: string | null;
  debit: string;
  credit: string;
  currencyDebit: string;
  currencyCredit: string;
  exchangeRate: string | null;
  quantityDebit: string;
  quantityCredit: string;
  price: string | null;
}

/** Editor-managed opening rows of the year (both lines on one account). */
export async function listInitialBalances(db: DbOrTx, year: ActiveYear, accountId?: number) {
  const accFilter = accountId ? sql`AND ib.account_id = ${accountId}` : sql``;
  return queryRows<BalanceRow>(db, sql`
    SELECT a.id AS "accountingId", ib.account_id AS "accountId", a.accounting_date::text AS date,
      ib.company_id AS "companyId", co.name AS company,
      doc.document_type_id AS "documentTypeId", doc.number AS "documentNumber", doc.date::text AS "documentDate",
      coalesce(sum(d.amount) FILTER (WHERE d.sign = 1), 0)::numeric(18,2)::text AS debit,
      coalesce(sum(d.ref_amount) FILTER (WHERE d.sign = -1), 0)::numeric(18,2)::text AS credit,
      coalesce(sum(d.currency_amount) FILTER (WHERE d.sign = 1), 0)::numeric(18,2)::text AS "currencyDebit",
      coalesce(sum(d.currency_amount) FILTER (WHERE d.sign = -1), 0)::numeric(18,2)::text AS "currencyCredit",
      max(d.exchange_rate)::text AS "exchangeRate",
      coalesce(sum(d.quantity) FILTER (WHERE d.sign = 1), 0)::text AS "quantityDebit",
      coalesce(sum(d.quantity) FILTER (WHERE d.sign = -1), 0)::text AS "quantityCredit",
      max(d.price)::text AS price
    FROM account_initial_balances ib
    JOIN accountings a ON a.id = ib.accounting_id
    JOIN accounting_details d ON d.accounting_id = a.id AND d.account_id = ib.account_id
    LEFT JOIN companies co ON co.id = ib.company_id
    LEFT JOIN documents doc ON doc.id = ib.document_id
    WHERE ib.financial_year_id = ${year.id} AND a.is_initial_balance AND NOT a.is_initial_correspondence ${accFilter}
    GROUP BY a.id, ib.account_id, ib.company_id, co.name, doc.document_type_id, doc.number, doc.date
    ORDER BY ib.account_id, co.name NULLS FIRST, doc.date NULLS FIRST, a.id`);
}

/** Opening totals per account from every opening entry of the year (incl. ones posted through the journal). */
export async function openingTotals(db: DbOrTx, year: ActiveYear) {
  return queryRows<{ accountId: number; debit: string; credit: string }>(db, sql`
    SELECT d.account_id AS "accountId", sum(d.amount)::numeric(18,2)::text AS debit, sum(d.ref_amount)::numeric(18,2)::text AS credit
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
    WHERE a.financial_year_id = ${year.id} AND a.is_initial_balance AND NOT a.is_initial_correspondence
    GROUP BY d.account_id`);
}

/** Replaces the opening balances of one account. Returns non-critical warnings. */
export async function saveInitialBalances(db: DbOrTx, year: ActiveYear, ctx: { userId: number; branchId: number; force?: boolean }, accountId: number, date: string, rows: BalanceRowInput[]) {
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, year.id));
  if (fy!.isLocked) throw badRequest(INITIAL_BALANCE_MESSAGES.strYearLocked);
  const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, accountId));
  if (!acc || acc.number === '0') throw badRequest('Невалидна сметка.');

  const messages: ValidationMessage[] = [];
  if (date.slice(0, 4) !== String(fy!.year)) messages.push(msg('strInitialBalancesDateMustBeInCurrentYear'));
  const isPartner = isCompanyCategory(acc.accountCategoryId);
  const isCurrency = acc.currencyId !== (await baseCurrencyId(db, fy!.year));
  const isMaterial = acc.productId != null;

  const seen = new Set<string>();
  const clean = rows.map((r, i) => {
    const line = rows.length > 1 ? `Ред ${i + 1}: ` : '';
    const debit = round2(r.debit || '0');
    const credit = round2(r.credit || '0');
    if (!debit.isZero() && !credit.isZero()) messages.push(msg('strInitialBalancesBothSetError', 'critical', line));
    const hasDoc = !!(r.documentTypeId || r.documentNumber?.trim());
    if (isPartner) {
      if (!r.companyId) messages.push(msg('strNotCorrectCompanyInitialBalance', 'critical', line));
      if (hasDoc) {
        if (!r.documentTypeId) messages.push(msg('strInitialBalancesEmptyDocumentTypeWithSumError', 'critical', line));
        if (!r.documentNumber?.trim()) messages.push(msg('strInitialBalancesEmptyDocumentNumberError', 'critical', line));
        else if (r.documentNumber.trim().length > 50) messages.push(msg('strInitialBalancesInvalidDocumentNumberError', 'critical', line));
        if (r.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.documentDate)) messages.push(msg('strInitialBalancesInvalidDocumentDateError', 'critical', line));
      }
      const key = hasDoc ? `${r.companyId}|${r.documentTypeId}|${r.documentNumber?.trim()}` : `${r.companyId}|`;
      if (seen.has(key)) messages.push(msg(hasDoc ? 'strInitialBalancesDuplicateDocumentError' : 'strInitialBalancesDuplicateError', 'critical', line));
      seen.add(key);
    } else if (r.companyId) messages.push(msg('strCompanyNotAllowed', 'critical', line));
    const cur = (v: string | null | undefined) => (isCurrency ? dec(v || '0').toDecimalPlaces(2, D.ROUND_HALF_UP) : null);
    const qty = (v: string | null | undefined) => (isMaterial ? dec(v || '0') : null);
    return { r, debit, credit, cd: cur(r.currencyDebit), cc: cur(r.currencyCredit), qd: qty(r.quantityDebit), qc: qty(r.quantityCredit), hasDoc };
  });
  if (!isLeaf({ left: acc.leftIndex, right: acc.rightIndex }) && clean.some((c) => !c.debit.isZero() || !c.credit.isZero())) {
    messages.push(msg('strInitalBalanceOnSyntheticAccountWarning', 'warning'));
  }
  if (messages.some((m) => m.severity === 'critical')) throw new ApiError(422, 'Началните салда не могат да бъдат записани.', messages);
  const warnings = messages.filter((m) => m.severity === 'warning');
  if (warnings.length && !ctx.force) throw new ApiError(422, 'Началните салда са с предупреждения.', warnings, 'warnings');

  await deleteInitialBalances(db, year, accountId);
  const [cur] = isCurrency ? await db.select().from(s.currencies).where(eq(s.currencies.id, acc.currencyId)) : [];
  for (const c of clean) {
    if (c.debit.isZero() && c.credit.isZero() && !(c.cd && !c.cd.isZero()) && !(c.cc && !c.cc.isZero()) && !(c.qd && !c.qd.isZero()) && !(c.qc && !c.qc.isZero())) continue;
    let documentId: number | null = null;
    if (c.hasDoc) {
      const docDate = c.r.documentDate || date;
      const number = c.r.documentNumber!.trim();
      const [existing] = await db.select({ id: s.documents.id }).from(s.documents)
        .where(and(eq(s.documents.number, number), eq(s.documents.documentTypeId, c.r.documentTypeId!), eq(s.documents.date, docDate)));
      documentId = existing?.id ?? (await db.insert(s.documents).values({ number, documentTypeId: c.r.documentTypeId!, date: docDate }).returning({ id: s.documents.id }))[0]!.id;
    }
    const [a] = await db.insert(s.accountings).values({
      financialYearId: year.id, number: '', date, accountingDate: date, viesMonth: date, documentId,
      isInitialBalance: true, isInitialCorrespondence: false, transactionTypeId: 1, branchId: ctx.branchId, userId: ctx.userId,
    }).returning({ id: s.accountings.id });
    const amount = c.debit.plus(c.credit);
    const ca = (c.cd ?? dec(0)).plus(c.cc ?? 0);
    const rate = isCurrency ? (c.r.exchangeRate ? dec(c.r.exchangeRate) : ca.isZero() ? dec(0) : amount.div(ca)).toDecimalPlaces(5).toString() : null;
    const q = (c.qd ?? dec(0)).plus(c.qc ?? 0);
    const price = isMaterial ? (q.isZero() ? dec(0) : amount.div(q)).toDecimalPlaces(4).toString() : null;
    const common = {
      accountingId: a!.id, accountId, refAccountId: accountId, companyId: isPartner ? c.r.companyId ?? null : null, vatTermId: 1,
      currencyId: isCurrency ? acc.currencyId : null, exchangeRate: rate, fixedRate: isCurrency ? cur?.fixedRate ?? null : null,
      productId: isMaterial ? acc.productId : null, price,
    };
    await db.insert(s.accountingDetails).values([
      { ...common, amount: c.debit.toFixed(2), refAmount: '0', sign: 1, position: 0, currencyAmount: c.cd?.toFixed(2) ?? null, quantity: c.qd?.toString() ?? null },
      { ...common, amount: '0', refAmount: c.credit.toFixed(2), sign: -1, position: 1, currencyAmount: c.cc?.toFixed(2) ?? null, quantity: c.qc?.toString() ?? null },
    ]);
    await db.insert(s.accountInitialBalances).values({ accountId, accountingId: a!.id, companyId: isPartner ? c.r.companyId ?? null : null, documentId, financialYearId: year.id });
  }
  return { warnings };
}

export async function deleteInitialBalances(db: DbOrTx, year: ActiveYear, accountId: number) {
  const ids = (await db.select({ id: s.accountInitialBalances.accountingId }).from(s.accountInitialBalances)
    .innerJoin(s.accountings, eq(s.accountings.id, s.accountInitialBalances.accountingId))
    .where(and(eq(s.accountInitialBalances.accountId, accountId), eq(s.accountInitialBalances.financialYearId, year.id), eq(s.accountings.isInitialCorrespondence, false))))
    .map((r) => r.id);
  if (ids.length) await db.delete(s.accountings).where(inArray(s.accountings.id, ids));
}
