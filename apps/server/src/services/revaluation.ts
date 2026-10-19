import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  CATEGORY, COMPANY_CATEGORIES, JOURNAL_MESSAGES, REVALUATION_MESSAGES, canSaveRevaluation, currencyDifferencesReport, dec, isCompanyCategory, isListedRevaluation,
  isMonthLocked, partnerRevaluationCheck, rateFromEcb, revaluationLegs, revalue, roundRate, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError } from '../lib/errors.ts';
import { baseCurrencyId, type LineInput } from './journal.ts';
import { MEMORIAL_ORDER, postSystemEntry } from './autoEntries.ts';

/**
 * FX revaluation (Преоценка на валути, spec 02c section 2), corrected
 * variant: a missing or zero rate is never replaced by 1.0 (D3) and all rows
 * are posted in one transaction (D4).
 */

type RevKey = keyof typeof REVALUATION_MESSAGES | 'strWrongAccountingDate' | 'strWrongAccountingMonth';
const TEXTS: Record<RevKey, string> = {
  ...REVALUATION_MESSAGES,
  strWrongAccountingDate: JOURNAL_MESSAGES.strWrongAccountingDate,
  strWrongAccountingMonth: JOURNAL_MESSAGES.strWrongAccountingMonth,
};
const message = (key: RevKey): ValidationMessage => ({ key, text: TEXTS[key], severity: 'critical' });
export const revaluationError = (key: RevKey, status: ApiError['status'] | 503 = 422) =>
  // 503 (rate service unavailable) is outside ApiError's status union; Hono sends any status number.
  new ApiError(status as ApiError['status'], TEXTS[key], [message(key)]);

export interface RevaluationBalance {
  accountId: number;
  accountNumber: string;
  accountDescription: string;
  isActive: boolean | null;
  currencyId: number;
  currencyIso: string;
  companyId: number | null;
  companyName: string | null;
  /** Signed book value in the base currency, debit positive. */
  bookNet: string;
  /** Signed currency amount, debit positive. */
  curNet: string;
}

const inList = (ids: readonly number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);
export const baseIsoOf = (year: number): 'EUR' | 'BGN' => (year >= 2026 ? 'EUR' : 'BGN');

/** First account by number of the FX income (724) and expense (624) categories in the year's chart. */
export async function revaluationAccounts(db: DbOrTx, year: number) {
  const isEuro = year >= 2026;
  const first = async (categoryId: number) => {
    const [a] = await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description }).from(s.accounts)
      .where(and(eq(s.accounts.accountCategoryId, categoryId), eq(s.accounts.isEuro, isEuro)))
      .orderBy(asc(s.accounts.number)).limit(1);
    return a ?? null;
  };
  return { income: await first(CATEGORY.FxIncome), expense: await first(CATEGORY.FxExpense) };
}

interface BalanceQuery { year: ActiveYear; date: string; accountId?: number | null; partner?: boolean; companyId?: number | null }

/** GetAccountReevaluationsBalance / GetPartnersAccountBalance. */
async function balances(db: DbOrTx, q: BalanceQuery): Promise<RevaluationBalance[]> {
  const base = await baseCurrencyId(db, q.year.year);
  const conds = [
    sql`ac.is_euro = ${q.year.year >= 2026}`,
    sql`a.financial_year_id = ${q.year.id}`,
    sql`a.accounting_date <= ${q.date}`,
    sql`NOT a.is_initial_correspondence`,
    sql`ac.currency_id <> ${base}`,
  ];
  if (q.accountId) {
    conds.push(sql`EXISTS (SELECT 1 FROM accounts p WHERE p.id = ${q.accountId} AND ac.left_index >= p.left_index AND ac.right_index <= p.right_index AND p.is_euro = ac.is_euro)`);
  }
  if (q.partner) {
    conds.push(sql`ac.account_category_id IN (${inList(COMPANY_CATEGORIES)})`, sql`d.company_id IS NOT NULL`);
    if (q.companyId) conds.push(sql`d.company_id = ${q.companyId}`);
  } else {
    conds.push(sql`(ac.account_category_id IS NULL OR ac.account_category_id NOT IN (${inList(COMPANY_CATEGORIES)}))`);
  }
  const company = q.partner ? sql`d.company_id` : sql`NULL::int`;
  const rows = await queryRows<Record<string, unknown>>(db, sql`
    SELECT ac.id AS account_id, ac.number, ac.description, ac.is_active, ac.currency_id, cur.iso_code,
      ${company} AS company_id, co.name AS company_name,
      SUM((d.amount + d.ref_amount) * d.sign) AS book,
      SUM(coalesce(d.currency_amount, 0) * d.sign) AS cur
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts ac ON ac.id = d.account_id
      LEFT JOIN currencies cur ON cur.id = ac.currency_id
      LEFT JOIN companies co ON co.id = ${company}
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY ac.id, ac.number, ac.description, ac.is_active, ac.currency_id, cur.iso_code, ${company}, co.name
    ORDER BY ac.number, co.name`);
  return rows.map((r) => ({
    accountId: r.account_id as number,
    accountNumber: r.number as string,
    accountDescription: r.description as string,
    isActive: (r.is_active as boolean | null) ?? null,
    currencyId: r.currency_id as number,
    currencyIso: (r.iso_code as string) ?? '',
    companyId: (r.company_id as number | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
    bookNet: dec(r.book as string).toFixed(2),
    curNet: dec(r.cur as string).toFixed(2),
  }));
}

export const currencyBalances = (db: DbOrTx, year: ActiveYear, date: string, accountId: number | null) =>
  balances(db, { year, date, accountId });
export const partnerBalances = (db: DbOrTx, year: ActiveYear, date: string, accountId: number, companyId: number | null) =>
  balances(db, { year, date, accountId, partner: true, companyId });

// ---- Fixing (rates per currency and date) ----

export interface FixingRate { currencyId: number; iso: string; rate: string | null; source: string | null }

/** Stored rates of the foreign currencies for a date (null when not entered). */
export async function getRates(db: DbOrTx, date: string, year: number, currencyIds?: number[]): Promise<FixingRate[]> {
  const base = await baseCurrencyId(db, year);
  const baseIso = baseIsoOf(year);
  let currencies = await db.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies).orderBy(asc(s.currencies.id));
  currencies = currencies.filter((c) => c.id !== base && (!currencyIds || currencyIds.includes(c.id)));
  const stored = currencies.length ? await db.select().from(s.currencyRates)
    .where(and(eq(s.currencyRates.date, date), eq(s.currencyRates.baseIso, baseIso), inArray(s.currencyRates.currencyId, currencies.map((c) => c.id)))) : [];
  const byId = new Map(stored.map((r) => [r.currencyId, r]));
  return currencies.map((c) => {
    const r = byId.get(c.id);
    return { currencyId: c.id, iso: c.iso, rate: r ? roundRate(r.rate).toString() : null, source: r?.source ?? null };
  });
}

export async function saveRates(db: DbOrTx, date: string, year: number, rates: { currencyId: number; rate: string }[], source = 'manual') {
  const baseIso = baseIsoOf(year);
  for (const r of rates) {
    const rate = roundRate(r.rate);
    if (rate.lessThanOrEqualTo(0)) continue;
    await db.insert(s.currencyRates).values({ currencyId: r.currencyId, date, baseIso, rate: rate.toFixed(6), source })
      .onConflictDoUpdate({
        target: [s.currencyRates.currencyId, s.currencyRates.date, s.currencyRates.baseIso],
        set: { rate: rate.toFixed(6), source, updatedAt: new Date() },
      });
  }
}

/**
 * ECB reference rates for a date, converted to the year's base currency.
 * Any failure (network, timeout, holiday without a fixing, unknown currency)
 * is reported as strCurrenciesServiceUnavailableOrHoliday; there is no 1.0
 * fallback (corrected D3).
 */
export async function downloadRates(db: DbOrTx, date: string, year: number): Promise<FixingRate[]> {
  const url = process.env.ECB_RATES_URL ?? 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
  const unavailable = () => revaluationError('strCurrenciesServiceUnavailableOrHoliday', 503);
  let xml: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw unavailable();
    xml = await res.text();
  } catch {
    throw unavailable();
  }
  const day = new RegExp(`<Cube\\s+time=['"]${date}['"]\\s*>([\\s\\S]*?)</Cube>`).exec(xml);
  if (!day) throw unavailable();
  const ecb = new Map<string, string>();
  for (const m of day[1]!.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) ecb.set(m[1]!, m[2]!);
  const baseIso = baseIsoOf(year);
  const out: { currencyId: number; rate: string }[] = [];
  for (const c of await getRates(db, date, year)) {
    if (c.iso === 'EUR' || c.iso === 'BGN') out.push({ currencyId: c.currencyId, rate: rateFromEcb(0, baseIso, c.iso).toString() });
    else if (ecb.has(c.iso)) out.push({ currencyId: c.currencyId, rate: rateFromEcb(ecb.get(c.iso)!, baseIso, c.iso).toString() });
  }
  if (!out.length) throw unavailable();
  await saveRates(db, date, year, out, 'ecb');
  return getRates(db, date, year);
}

// ---- Posting ----

export interface RevaluationRequest {
  tab: 'currency' | 'partner';
  date: string;
  accountId?: number | null;
  /** Currency tab: "Преоценка на всички валутни сметки". */
  all?: boolean;
  companyId?: number | null;
  term?: string;
  reference?: string | null;
  /** Currency tab: the fixing per currency. */
  rates?: { currencyId: number; rate: string }[];
  /** Partner tab: the single new rate. */
  rate?: string | null;
}

export interface RevaluationPreviewRow extends RevaluationBalance {
  rate: string;
  newAmount: string;
  averageRate: string;
  direction: 'neutral' | 'positive' | 'negative';
  sum: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
}

async function checkRequest(db: DbOrTx, year: ActiveYear, r: RevaluationRequest) {
  const accounts = await revaluationAccounts(db, year.year);
  if (!accounts.income || !accounts.expense) throw revaluationError('strReevaluationAccountsNotDefined');
  const base = await baseCurrencyId(db, year.year);
  if (r.tab === 'currency' ? !r.all && !r.accountId : !r.accountId) throw revaluationError('strAccountNotSelectedError');
  if (r.accountId && !(r.tab === 'currency' && r.all)) {
    const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, r.accountId));
    if (!acc) throw revaluationError('strAccountNotSelectedError');
    if (r.tab === 'partner' && !isCompanyCategory(acc.accountCategoryId)) throw revaluationError('strPartnerAccountNotSelected');
    const hasForeign = await queryRows<{ n: number }>(db, sql`
      SELECT count(*)::int AS n FROM accounts c WHERE c.left_index >= ${acc.leftIndex} AND c.right_index <= ${acc.rightIndex}
        AND c.is_euro = ${acc.isEuro} AND c.currency_id <> ${base}`);
    if (!hasForeign[0]?.n) throw revaluationError('strIncorrectCurrencySubAccount');
  }
  const [y, m] = r.date.split('-').map(Number);
  if (y !== year.year) throw revaluationError('strWrongAccountingDate');
  if (isMonthLocked(year.lockedMonths, m!)) throw revaluationError('strWrongAccountingMonth');
  return accounts as { income: NonNullable<typeof accounts.income>; expense: NonNullable<typeof accounts.expense> };
}

/** Balances with the given rates applied (the grid of either tab). Rows below 0.01 are dropped. */
export async function previewRevaluation(db: DbOrTx, year: ActiveYear, r: RevaluationRequest, opts: { requireRates: boolean }) {
  const accounts = await checkRequest(db, year, r);
  const rows = r.tab === 'currency'
    ? await currencyBalances(db, year, r.date, r.all ? null : r.accountId ?? null)
    : await partnerBalances(db, year, r.date, r.accountId!, r.companyId ?? null);
  const rateOf = new Map((r.rates ?? []).map((x) => [x.currencyId, x.rate]));
  const out: RevaluationPreviewRow[] = [];
  for (const b of rows) {
    const raw = r.tab === 'partner' ? r.rate : rateOf.get(b.currencyId);
    const rate = raw ? roundRate(raw) : null;
    if (!rate || rate.lessThanOrEqualTo(0)) {
      if (opts.requireRates) throw revaluationError('strExchangeRateNotSetError');
      continue;
    }
    if (r.tab === 'partner') {
      const bad = partnerRevaluationCheck(b.isActive, b.bookNet);
      if (bad) throw revaluationError(bad);
    }
    const v = revalue(b.bookNet, b.curNet, rate);
    if (!isListedRevaluation(v.sum)) continue;
    const legs = revaluationLegs(v);
    const side = (x: 'account' | 'income' | 'expense' | undefined) =>
      x === 'account' ? b.accountId : x === 'income' ? accounts.income.id : x === 'expense' ? accounts.expense.id : null;
    out.push({
      ...b, rate: v.rate.toString(), newAmount: v.newAmount.toFixed(2), averageRate: v.averageRate.toDecimalPlaces(5).toString(),
      direction: v.direction, sum: v.sum.toFixed(2), debitAccountId: side(legs?.debit), creditAccountId: side(legs?.credit),
    });
  }
  return { accounts, rows: out };
}

/**
 * Posts one Мемориален ордер per revalued row with consecutive numbers of the
 * МО channel, all in one transaction. The currency-account leg carries a zero
 * currency amount (only the base value moves).
 */
export async function postRevaluation(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, r: RevaluationRequest) {
  const { rows, accounts } = await previewRevaluation(db, ctx.year, r, { requireRates: true });
  const sums = rows.map((x) => x.sum);
  if (!rows.length || !canSaveRevaluation(sums)) throw revaluationError('strZeroReevaluationSumError');
  if (r.tab === 'currency' && r.rates?.length) await saveRates(db, r.date, ctx.year.year, r.rates);
  const posted: { id: number; number: string; accountId: number; companyId: number | null; direction: string; amount: string }[] = [];
  for (const row of rows) {
    if (!row.debitAccountId || !row.creditAccountId || dec(row.sum).isZero()) continue;
    const leg = (accountId: number): LineInput => accountId === row.accountId
      ? { accountId, amount: row.sum, currencyAmount: '0', exchangeRate: '0', companyId: row.companyId }
      : { accountId, amount: row.sum };
    const res = await postSystemEntry(db, {
      accountingDate: r.date,
      documentDate: r.date,
      documentTypeId: MEMORIAL_ORDER,
      companyId: row.companyId,
      term: r.term?.trim() || REVALUATION_MESSAGES.strReevaluation,
      reference: r.reference ?? null,
      source: 'revaluation',
      debits: [leg(row.debitAccountId)],
      credits: [leg(row.creditAccountId)],
    }, { ...ctx, ignoreKeys: ['strForeignCurrencyRequired'] });
    posted.push({ id: res.id, number: res.number, accountId: row.accountId, companyId: row.companyId, direction: row.direction, amount: row.sum });
  }
  const postedRows = rows.filter((row) => row.debitAccountId && row.creditAccountId && !dec(row.sum).isZero());
  return { entries: posted, differences: currencyDifferencesReport(postedRows, accounts) };
}
