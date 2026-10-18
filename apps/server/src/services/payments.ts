import { eq, inArray, or, sql } from 'drizzle-orm';
import {
  CATEGORY, JOURNAL_MESSAGES, PAYMENT_MESSAGES, allocateWalk, dec, isCompanyCategory, isMonthLocked, paymentMessage, round2,
  validatePaymentAllocations, ZERO, type Dec, type PaymentMessageKey, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { CASH_PAYMENT, CASH_RECEIPT, postSystemEntry } from './autoEntries.ts';
import { baseCurrencyId, type SaveContext } from './journal.ts';
import { insertPaymentLinks, openItems, sideOfCategory, type OpenItem, type PartnerSide } from './openItems.ts';
import { getConfig, setConfig } from './config.ts';
import { logActivity } from './audit.ts';

/**
 * Payments (Разплащания F3, spec 07 3.3), binding of documents (02a 8.2),
 * automatic payment from the entry editor (02a 4.3). Allocation rows are
 * AccountingPaymentDetails (see services/openItems.ts for the open-item rule).
 */

export const BANK_STATEMENT = 11;

type Msg = ValidationMessage;
const crit = (key: string, text: string): Msg => ({ key, text, severity: 'critical' });
const pm = (key: PaymentMessageKey, ...args: (string | number)[]): Msg => crit(key, paymentMessage(key, ...args));

export function fail(messages: Msg[]): never {
  throw new ApiError(422, JOURNAL_MESSAGES.strCannotCompleteOperation, messages);
}

/** Accounting date must be in the active year and in an unlocked month (01b 6.2). */
export function dateMessages(year: ActiveYear, date: string): Msg[] {
  if (Number(date.slice(0, 4)) !== year.year) return [crit('strWrongAccountingDate', JOURNAL_MESSAGES.strWrongAccountingDate)];
  if (year.isLocked || isMonthLocked(year.lockedMonths, Number(date.slice(5, 7)))) return [crit('strWrongAccountingMonth', JOURNAL_MESSAGES.strWrongAccountingMonth)];
  return [];
}

/** Changing links of an entry dated in a locked month/year is refused (strLockedMonthOperation). */
export async function assertEntriesEditable(db: DbOrTx, accountingIds: number[]) {
  if (!accountingIds.length) return;
  const rows = await queryRows<{ accounting_date: string | Date; is_locked: boolean; locked_months: number }>(db, sql`
    SELECT a.accounting_date, fy.is_locked, fy.locked_months FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id
    WHERE a.id IN (${sql.join(accountingIds.map((i) => sql`${i}`), sql`, `)})`);
  for (const r of rows) {
    const d = String(r.accounting_date instanceof Date ? r.accounting_date.toISOString() : r.accounting_date);
    if (r.is_locked || isMonthLocked(r.locked_months, Number(d.slice(5, 7)))) {
      throw new ApiError(400, JOURNAL_MESSAGES.strLockedMonthOperation, [crit('strLockedMonthOperation', JOURNAL_MESSAGES.strLockedMonthOperation)]);
    }
  }
}

const yearWindow = (year: ActiveYear) => ({ startDate: `${year.year}-01-01`, endDate: `${year.year}-12-31`, financialYearId: year.id, isEuro: year.year >= 2026 });

export const docLabel = (i: OpenItem) => [i.documentTypeShortName, i.documentNumber].filter(Boolean).join(' ') || (i.isInitialBalance ? 'Начално салдо' : `Контиране ${i.accountingNumber}`);

/* ------------------------------------------------------------------ */
/* Lists                                                                */
/* ------------------------------------------------------------------ */

export type PartnerTab = 'all' | 'suppliers' | 'clients';

export interface PartnerBalance {
  companyId: number;
  companyName: string;
  companyBulstat: string;
  balance: string;
  currencyBalance: string;
  liabilities: number;
  payments: number;
}

/** Left pane of F3: partners with open items, by tab Фирми / Доставчици / Клиенти. */
export async function partnersWithBalances(db: DbOrTx, year: ActiveYear, o: { tab?: PartnerTab; accountNumber?: string; inCurrency?: boolean; q?: string }) {
  const base = await baseCurrencyId(db, year.year);
  const items = await openItems(db, { ...yearWindow(year), accountNumber: o.accountNumber || undefined, companyName: o.q || undefined });
  const map = new Map<number, PartnerBalance & { b: Dec; c: Dec }>();
  for (const i of items) {
    if (o.tab === 'suppliers' && i.side !== 'supplier') continue;
    if (o.tab === 'clients' && i.side !== 'client') continue;
    if (o.inCurrency && i.currencyId === base) continue;
    const cur = map.get(i.companyId) ?? { companyId: i.companyId, companyName: i.companyName, companyBulstat: i.companyBulstat, balance: '', currencyBalance: '', liabilities: 0, payments: 0, b: ZERO, c: ZERO };
    cur.b = cur.b.plus(dec(i.open));
    cur.c = cur.c.plus(dec(i.openCurrency));
    if (i.kind === 'liability') cur.liabilities++;
    if (i.kind === 'payment') cur.payments++;
    map.set(i.companyId, cur);
  }
  return [...map.values()]
    .map(({ b, c, ...r }) => ({ ...r, balance: b.toFixed(2), currencyBalance: c.toFixed(2) }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName, 'bg'));
}

export interface LinkRow {
  id: number;
  paymentAccountingId: number;
  refAccountingId: number;
  accountId: number;
  accountNumber: string;
  companyId: number | null;
  companyName: string;
  amount: string;
  currencyAmount: string;
  refNumber: string;
  refDate: string;
  refDocumentType: string;
  refDocumentNumber: string;
  refDocumentDate: string;
  refTerm: string;
  refAmount: string;
  paymentNumber: string;
  paymentDate: string;
  paymentDocumentType: string;
  paymentDocumentNumber: string;
  paymentDocumentDate: string;
  paymentTerm: string;
  paymentAmount: string;
}

export interface LinkFilter {
  companyId?: number;
  accountingId?: number;
  accountingIds?: number[];
  startDate?: string;
  endDate?: string;
  term?: string;
  documentTypeId?: number;
  documentNumber?: string;
}

/** Links between liability and payment entries (EditPaymentsView, 07 3.3). */
export async function listLinks(db: DbOrTx, f: LinkFilter): Promise<LinkRow[]> {
  const conds = [sql`true`];
  if (f.companyId) conds.push(sql`p.company_id = ${f.companyId}`);
  if (f.accountingId) conds.push(sql`(p.payment_accounting_id = ${f.accountingId} OR p.ref_accounting_id = ${f.accountingId})`);
  if (f.accountingIds?.length) {
    const ids = sql.join(f.accountingIds.map((i) => sql`${i}`), sql`, `);
    conds.push(sql`(p.payment_accounting_id IN (${ids}) OR p.ref_accounting_id IN (${ids}))`);
  }
  if (f.startDate) conds.push(sql`(pa.accounting_date >= ${f.startDate} OR ra.accounting_date >= ${f.startDate})`);
  if (f.endDate) conds.push(sql`(pa.accounting_date <= ${f.endDate} OR ra.accounting_date <= ${f.endDate})`);
  if (f.term) conds.push(sql`(pt.description ILIKE ${'%' + f.term + '%'} OR rt.description ILIKE ${'%' + f.term + '%'})`);
  if (f.documentTypeId) conds.push(sql`(pd.document_type_id = ${f.documentTypeId} OR rd.document_type_id = ${f.documentTypeId})`);
  if (f.documentNumber) conds.push(sql`(pd.number ILIKE ${f.documentNumber + '%'} OR rd.number ILIKE ${f.documentNumber + '%'})`);
  const rows = await queryRows<Record<string, unknown>>(db, sql`
    SELECT p.id, p.payment_accounting_id, p.ref_accounting_id, p.account_id, ac.number AS account_number, p.company_id, co.name AS company_name,
      p.amount, p.currency_amount,
      ra.number AS ref_number, ra.accounting_date AS ref_date, rdt.short_name AS ref_document_type, rd.number AS ref_document_number, rd.date AS ref_document_date, rt.description AS ref_term,
      (SELECT sum(x.amount) FROM accounting_details x WHERE x.accounting_id = ra.id AND x.sign = 1) AS ref_amount,
      pa.number AS payment_number, pa.accounting_date AS payment_date, pdt.short_name AS payment_document_type, pd.number AS payment_document_number, pd.date AS payment_document_date, pt.description AS payment_term,
      (SELECT sum(x.amount) FROM accounting_details x WHERE x.accounting_id = pa.id AND x.sign = 1) AS payment_amount
    FROM accounting_payment_details p
      JOIN accountings pa ON pa.id = p.payment_accounting_id
      JOIN accountings ra ON ra.id = p.ref_accounting_id
      JOIN accounts ac ON ac.id = p.account_id
      LEFT JOIN companies co ON co.id = p.company_id
      LEFT JOIN documents pd ON pd.id = pa.document_id LEFT JOIN document_types pdt ON pdt.id = pd.document_type_id
      LEFT JOIN documents rd ON rd.id = ra.document_id LEFT JOIN document_types rdt ON rdt.id = rd.document_type_id
      LEFT JOIN terms pt ON pt.id = pa.term_id LEFT JOIN terms rt ON rt.id = ra.term_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY ra.accounting_date, ra.number, pa.accounting_date, p.id`);
  const d = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
  const t = (v: unknown) => (v as string | null) ?? '';
  return rows.map((r) => ({
    id: r.id as number,
    paymentAccountingId: r.payment_accounting_id as number,
    refAccountingId: r.ref_accounting_id as number,
    accountId: r.account_id as number,
    accountNumber: t(r.account_number),
    companyId: (r.company_id as number | null) ?? null,
    companyName: t(r.company_name),
    amount: dec(r.amount as string).toFixed(2),
    currencyAmount: dec(r.currency_amount as string).toFixed(2),
    refNumber: t(r.ref_number), refDate: d(r.ref_date), refDocumentType: t(r.ref_document_type), refDocumentNumber: t(r.ref_document_number),
    refDocumentDate: d(r.ref_document_date), refTerm: t(r.ref_term), refAmount: dec(r.ref_amount as string).toFixed(2),
    paymentNumber: t(r.payment_number), paymentDate: d(r.payment_date), paymentDocumentType: t(r.payment_document_type), paymentDocumentNumber: t(r.payment_document_number),
    paymentDocumentDate: d(r.payment_document_date), paymentTerm: t(r.payment_term), paymentAmount: dec(r.payment_amount as string).toFixed(2),
  }));
}

export interface PartnerOpenItemsFilter {
  companyId: number;
  accountNumber?: string;
  accountId?: number;
  /** Document-date window of the centre/right lists. */
  from?: string;
  to?: string;
  documentNumber?: string;
  inCurrency?: boolean;
}

/** Centre and right panes of F3: open liabilities/claims and existing (unallocated) payments of a partner. */
export async function partnerOpenItems(db: DbOrTx, year: ActiveYear, f: PartnerOpenItemsFilter) {
  const base = await baseCurrencyId(db, year.year);
  const items = (await openItems(db, {
    ...yearWindow(year), companyIds: [f.companyId], accountNumber: f.accountNumber || undefined,
    accountIds: f.accountId ? [f.accountId] : undefined, documentNumber: f.documentNumber || undefined,
  })).filter((i) => (!f.from || i.documentDate >= f.from) && (!f.to || i.documentDate <= f.to) && (!f.inCurrency || i.currencyId !== base));
  const links = await listLinks(db, { accountingIds: items.map((i) => i.accountingId) });
  const withLinks = (i: OpenItem) => ({
    ...i,
    label: docLabel(i),
    links: links.filter((l) => (i.kind === 'payment' ? l.paymentAccountingId === i.accountingId : l.refAccountingId === i.accountingId) && l.accountId === i.accountId),
  });
  return {
    liabilities: items.filter((i) => i.kind === 'liability').map(withLinks),
    payments: items.filter((i) => i.kind === 'payment').map(withLinks),
    balance: items.reduce((a, i) => a.plus(dec(i.open)), ZERO).toFixed(2),
    currencyBalance: items.reduce((a, i) => a.plus(dec(i.openCurrency)), ZERO).toFixed(2),
  };
}

/* ------------------------------------------------------------------ */
/* Binding                                                              */
/* ------------------------------------------------------------------ */

export interface BindRow { accountingId: number; amount?: string | null; currencyAmount?: string | null }

export interface BindInput {
  accountId: number;
  companyId: number;
  liabilities: BindRow[];
  payments: BindRow[];
}

async function loadAccount(db: DbOrTx, id: number) {
  const [a] = await db.select().from(s.accounts).where(eq(s.accounts.id, id));
  if (!a) throw notFound('Сметката');
  return a;
}

/** Selected open items of one account and partner; refuses rows that are not open of the expected kind. */
async function selectedItems(db: DbOrTx, year: ActiveYear, accountId: number, companyId: number, rows: BindRow[], kind: 'liability' | 'payment') {
  if (!rows.length) return [];
  const items = await openItems(db, { ...yearWindow(year), accountIds: [accountId], companyIds: [companyId], accountingIds: rows.map((r) => r.accountingId), kind });
  const byId = new Map(items.map((i) => [i.accountingId, i]));
  return rows.map((r) => {
    const it = byId.get(r.accountingId);
    if (!it) fail([pm('strDifferentPartnerOrAccount')]);
    const want = r.amount ? round2(r.amount) : dec(it.openAbs);
    const cur = r.currencyAmount ? round2(r.currencyAmount) : dec(it.openAbs).isZero() ? ZERO : round2(dec(it.openCurrencyAbs).times(want).div(dec(it.openAbs)));
    return { item: it, amount: want, currencyAmount: cur };
  });
}

/**
 * Binds liabilities with existing payments (Обвързване): cursor walk in date
 * order, never above the open amounts. Returns the written links.
 */
export async function bindDocuments(db: DbOrTx, year: ActiveYear, input: BindInput, userId: number) {
  const acc = await loadAccount(db, input.accountId);
  if (!isCompanyCategory(acc.accountCategoryId)) fail([pm('strDifferentPartnerOrAccount')]);
  if (!input.liabilities.length) fail([pm('strNoDocumentsSelected')]);
  if (!input.payments.length) fail([pm('strNoPaymentsSelected')]);
  const ls = await selectedItems(db, year, input.accountId, input.companyId, input.liabilities, 'liability');
  const ps = await selectedItems(db, year, input.accountId, input.companyId, input.payments, 'payment');
  const base = await baseCurrencyId(db, year.year);
  const msgs = validatePaymentAllocations(ls.reduce((a, l) => a.plus(l.amount), ZERO), ls.map((l) => ({ label: docLabel(l.item), amount: l.amount, open: l.item.openAbs, exchangeRate: l.item.exchangeRate })), acc.currencyId !== base)
    .filter((m) => m.key !== 'strAllocationExceedsPayment');
  for (const p of ps) if (p.amount.greaterThan(dec(p.item.openAbs))) msgs.push({ key: 'strPaymentExceedsOpenAmount', text: paymentMessage('strPaymentExceedsOpenAmount', docLabel(p.item), p.item.openAbs) });
  if (msgs.length) fail(msgs.map((m) => crit(m.key, m.text)));
  await assertEntriesEditable(db, ps.map((p) => p.item.accountingId));
  const byDate = <T extends { item: OpenItem }>(a: T, b: T) => (a.item.accountingDate < b.item.accountingDate ? -1 : a.item.accountingDate > b.item.accountingDate ? 1 : a.item.accountingId - b.item.accountingId);
  ls.sort(byDate);
  ps.sort(byDate);
  const allocs = allocateWalk(
    ls.map((l) => ({ id: l.item, amount: l.amount, currencyAmount: l.currencyAmount })),
    ps.map((p) => ({ id: p.item, amount: p.amount })),
  );
  const docs = await documentIds(db, ps.map((p) => p.item.accountingId));
  const written = await insertPaymentLinks(db, allocs.map((a) => ({
    paymentAccountingId: a.paymentId.accountingId,
    refAccountingId: a.liabilityId.accountingId,
    documentId: docs.get(a.paymentId.accountingId) ?? null,
    accountId: input.accountId,
    companyId: input.companyId,
    amount: a.amount.toFixed(2),
    currencyAmount: a.currencyAmount.toFixed(2),
  })));
  await logActivity(db, userId, 'add', 'payment', null, `Обвързване на ${written.length} документа`);
  return written;
}

async function documentIds(db: DbOrTx, accountingIds: number[]) {
  if (!accountingIds.length) return new Map<number, number | null>();
  const rows = await db.select({ id: s.accountings.id, documentId: s.accountings.documentId }).from(s.accountings).where(inArray(s.accountings.id, accountingIds));
  return new Map(rows.map((r) => [r.id, r.documentId]));
}

/* ------------------------------------------------------------------ */
/* New payment (NewPaymentView)                                         */
/* ------------------------------------------------------------------ */

export interface NewPaymentInput {
  companyId: number;
  /** Partner account (the account of the paid documents). */
  accountId: number;
  /** Cash / bank account. */
  paymentAccountId: number;
  date: string;
  documentTypeId?: number | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  term: string;
  reference?: string | null;
  amount: string;
  currencyAmount?: string | null;
  exchangeRate?: string | null;
  allocations: BindRow[];
}

/** Default payment document: ПКО/РКО for cash accounts, bank statement otherwise. */
export function defaultPaymentDocumentType(side: PartnerSide, paymentAccountCategory: number | null) {
  const cash = paymentAccountCategory === CATEGORY.CashBase || paymentAccountCategory === CATEGORY.CashForeign;
  if (!cash) return BANK_STATEMENT;
  return side === 'client' ? CASH_RECEIPT : CASH_PAYMENT;
}

/**
 * Creates the paying entry (client: Dr payment account / Cr partner account;
 * supplier: Dr partner account / Cr payment account) and allocates it to the
 * selected liabilities, in one transaction.
 */
export async function createPayment(db: DbOrTx, ctx: SaveContext, input: NewPaymentInput) {
  const year = ctx.year;
  const msgs: Msg[] = [...dateMessages(year, input.date)];
  const acc = await loadAccount(db, input.accountId);
  const side = sideOfCategory(acc.accountCategoryId);
  if (!side) fail([pm('strDifferentPartnerOrAccount')]);
  if (!input.paymentAccountId) msgs.push(pm('strPaymentAccountMissing'));
  const amount = round2(input.amount || '0');
  if (amount.lessThanOrEqualTo(0)) msgs.push(pm('strPaymentAmountMissing'));
  const payAcc = input.paymentAccountId ? await loadAccount(db, input.paymentAccountId) : null;
  if (payAcc && isCompanyCategory(payAcc.accountCategoryId)) msgs.push(pm('strPaymentAccountMissing'));
  const base = await baseCurrencyId(db, year.year);
  const ls = await selectedItems(db, year, input.accountId, input.companyId, input.allocations, 'liability');
  msgs.push(...validatePaymentAllocations(amount, ls.map((l) => ({ label: docLabel(l.item), amount: l.amount, open: l.item.openAbs, exchangeRate: l.item.exchangeRate })), acc.currencyId !== base)
    .map((m) => crit(m.key, m.text)));
  if (msgs.length) fail(msgs);

  const currencyAmount = input.currencyAmount ? round2(input.currencyAmount).toFixed(2) : null;
  const exchangeRate = input.exchangeRate || null;
  const line = (accountId: number, foreign: boolean, companyId: number | null) => ({
    accountId, amount: amount.toFixed(2), companyId,
    currencyAmount: foreign ? currencyAmount : null, exchangeRate: foreign ? exchangeRate : null,
  });
  const partnerLine = line(input.accountId, acc.currencyId !== base, input.companyId);
  const paymentLine = line(payAcc!.id, payAcc!.currencyId !== base, null);
  const documentTypeId = input.documentTypeId ?? defaultPaymentDocumentType(side, payAcc!.accountCategoryId);
  const saved = await postSystemEntry(db, {
    accountingDate: input.date,
    documentDate: input.documentDate || input.date,
    documentTypeId,
    documentNumber: input.documentNumber?.trim() ? input.documentNumber.trim() : undefined,
    companyId: input.companyId,
    term: input.term,
    reference: input.reference ?? null,
    source: 'payment',
    debits: [side === 'client' ? paymentLine : partnerLine],
    credits: [side === 'client' ? partnerLine : paymentLine],
  }, ctx);
  const [entry] = await db.select({ documentId: s.accountings.documentId }).from(s.accountings).where(eq(s.accountings.id, saved.id));
  const links = await insertPaymentLinks(db, ls.map((l) => ({
    paymentAccountingId: saved.id,
    refAccountingId: l.item.accountingId,
    documentId: entry?.documentId ?? null,
    accountId: input.accountId,
    companyId: input.companyId,
    amount: l.amount.toFixed(2),
    currencyAmount: l.currencyAmount.toFixed(2),
  })));
  return { ...saved, links };
}

/* ------------------------------------------------------------------ */
/* Links: delete                                                        */
/* ------------------------------------------------------------------ */

export async function deleteLink(db: DbOrTx, id: number, userId: number) {
  const [l] = await db.select().from(s.accountingPaymentDetails).where(eq(s.accountingPaymentDetails.id, id));
  if (!l) throw notFound('Връзката');
  await assertEntriesEditable(db, [l.paymentAccountingId]);
  await db.delete(s.accountingPaymentDetails).where(eq(s.accountingPaymentDetails.id, id));
  await logActivity(db, userId, 'delete', 'payment', id, 'Изтриване на връзка между документи');
}

/** "Изтриване на връзки": all links of the given accountings (as liability or payment). */
export async function deleteLinksOf(db: DbOrTx, accountingIds: number[], userId: number) {
  if (!accountingIds.length) return 0;
  const rows = await db.select().from(s.accountingPaymentDetails)
    .where(or(inArray(s.accountingPaymentDetails.paymentAccountingId, accountingIds), inArray(s.accountingPaymentDetails.refAccountingId, accountingIds)));
  await assertEntriesEditable(db, [...new Set(rows.map((r) => r.paymentAccountingId))]);
  if (rows.length) await db.delete(s.accountingPaymentDetails).where(inArray(s.accountingPaymentDetails.id, rows.map((r) => r.id)));
  await logActivity(db, userId, 'delete', 'payment', null, `Изтриване на ${rows.length} връзки между документи`);
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Entry editor: auto payment and binding                               */
/* ------------------------------------------------------------------ */

export interface AutoPaymentOptions {
  paymentAccountId: number | null;
  documentTypeId?: number | null;
  documentNumber?: string | null;
}

export interface EntryLinesForCheck {
  accountingDate?: string;
  lines: { accountId: number; companyId?: number | null }[];
  companyId?: number | null;
}

/** Pre-save checks of "Автоматично разплащане" (02a 4.3). */
export async function validateAutoPayment(db: DbOrTx, o: AutoPaymentOptions, e: EntryLinesForCheck): Promise<Msg[]> {
  const msgs: Msg[] = [];
  const [payAcc] = o.paymentAccountId ? await db.select().from(s.accounts).where(eq(s.accounts.id, o.paymentAccountId)) : [];
  if (!payAcc || isCompanyCategory(payAcc.accountCategoryId)) msgs.push(pm('strPaymentAccountMissing'));
  const ids = [...new Set(e.lines.map((l) => l.accountId))];
  const accs = ids.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  const side = accs.map((a) => sideOfCategory(a.accountCategoryId)).find(Boolean);
  if (!side) msgs.push(pm('strNoPartnerLineForPayment'));
  const typeId = o.documentTypeId ?? (side && payAcc ? defaultPaymentDocumentType(side, payAcc.accountCategoryId) : null);
  let channel = 0;
  if (typeId) {
    const [t] = await db.select({ channel: s.documentTypes.sequenceChannel }).from(s.documentTypes).where(eq(s.documentTypes.id, typeId));
    channel = t?.channel ?? 0;
  }
  // ПКО/РКО take the next number of their channel; other payment documents need one.
  if (!o.documentNumber?.trim() && !channel) msgs.push(crit('strMissingDocumentNumberInPayment', PAYMENT_MESSAGES.strMissingDocumentNumberInPayment));
  return msgs;
}

/**
 * Auto payment for a saved entry: for every open liability item of the entry
 * (its partner lines) a payment entry for the whole open amount is created on
 * the payment account and bound to it.
 */
export async function autoPayment(db: DbOrTx, ctx: SaveContext, entryId: number, o: AutoPaymentOptions & { date?: string | null }) {
  const [entry] = await db.select().from(s.accountings).where(eq(s.accountings.id, entryId));
  if (!entry) throw notFound('Контирането');
  const items = await openItems(db, { ...yearWindow(ctx.year), accountingIds: [entryId], kind: 'liability' });
  if (!items.length) fail([pm('strNoPartnerLineForPayment')]);
  const term = entry.termId ? (await db.select().from(s.terms).where(eq(s.terms.id, entry.termId)))[0]?.description ?? '' : '';
  const reference = entry.referenceId ? (await db.select().from(s.referenceTexts).where(eq(s.referenceTexts.id, entry.referenceId)))[0]?.description ?? null : null;
  const out = [];
  for (const it of items) {
    out.push(await createPayment(db, ctx, {
      companyId: it.companyId,
      accountId: it.accountId,
      paymentAccountId: o.paymentAccountId!,
      date: o.date || entry.accountingDate,
      documentTypeId: o.documentTypeId ?? null,
      documentNumber: o.documentNumber ?? null,
      term: term || 'Разплащане',
      reference,
      amount: it.openAbs,
      currencyAmount: dec(it.openCurrencyAbs).isZero() ? null : it.openCurrencyAbs,
      exchangeRate: dec(it.openCurrencyAbs).isZero() ? null : it.exchangeRate,
      allocations: [{ accountingId: it.accountingId }],
    }));
  }
  if (o.paymentAccountId) await setConfig(db, 'PaymentAccount', String(o.paymentAccountId), ctx.userId);
  return out;
}

/**
 * Binding from the entry editor (Обвързване, BindingDocumentsView): the saved
 * entry is bound with the chosen documents of the same account and partner;
 * an entry that is a payment covers the chosen liabilities, an entry that is a
 * liability is covered by the chosen payments.
 */
export async function bindEntry(db: DbOrTx, year: ActiveYear, entryId: number, documents: BindRow[], userId: number) {
  if (!documents.length) fail([pm('strNoDocumentsSelected')]);
  const all = await openItems(db, { ...yearWindow(year), accountingIds: [entryId, ...documents.map((d) => d.accountingId)] });
  const docIds = new Set(documents.map((d) => d.accountingId));
  const chosen = all.filter((i) => docIds.has(i.accountingId) && i.accountingId !== entryId);
  if (!chosen.length) fail([pm('strNoDocumentsSelected')]);
  const { accountId, companyId } = chosen[0]!;
  if (chosen.some((c) => c.accountId !== accountId || c.companyId !== companyId)) fail([pm('strDifferentPartnerOrAccount')]);
  const own = all.find((i) => i.accountingId === entryId && i.accountId === accountId && i.companyId === companyId && i.kind !== 'none');
  if (!own) fail([pm('strDifferentPartnerOrAccount')]);
  const rows = documents.filter((d) => d.accountingId !== entryId);
  const self: BindRow = { accountingId: entryId };
  if (own.kind === 'payment') {
    if (chosen.some((c) => c.kind !== 'liability')) fail([pm('strDifferentPartnerOrAccount')]);
    // The payment caps the allocation: Σ chosen must not exceed it.
    const total = rows.reduce((a, r) => a.plus(r.amount ? round2(r.amount) : dec(chosen.find((c) => c.accountingId === r.accountingId)!.openAbs)), ZERO);
    if (total.greaterThan(dec(own.openAbs))) fail([pm('strAllocationExceedsPayment')]);
    return bindDocuments(db, year, { accountId, companyId, liabilities: rows, payments: [self] }, userId);
  }
  if (chosen.some((c) => c.kind !== 'payment')) fail([pm('strDifferentPartnerOrAccount')]);
  return bindDocuments(db, year, { accountId, companyId, liabilities: [self], payments: rows }, userId);
}

/** Open documents a new entry can be bound with: both kinds for one account and partner. */
export async function bindCandidates(db: DbOrTx, year: ActiveYear, accountId: number, companyId: number, excludeAccountingId?: number) {
  const items = await openItems(db, { ...yearWindow(year), accountIds: [accountId], companyIds: [companyId] });
  return items.filter((i) => i.accountingId !== excludeAccountingId).map((i) => ({ ...i, label: docLabel(i) }));
}

export async function paymentSettings(db: DbOrTx, userId: number) {
  const v = await getConfig(db, 'PaymentAccount', userId);
  return { paymentAccountId: v ? Number(v) : null };
}

export async function setPaymentAccount(db: DbOrTx, userId: number, paymentAccountId: number | null) {
  await setConfig(db, 'PaymentAccount', paymentAccountId ? String(paymentAccountId) : '', userId);
}

