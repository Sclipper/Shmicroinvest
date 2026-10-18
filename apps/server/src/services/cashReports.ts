import { asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  BGN_PER_EUR, CASH_AND_RECEIVABLES_SECTIONS, cashAndReceivablesFormulas, cashOrderAmountInWords, dec, EURO_CHANGEOVER_DATE,
  pairTwoPerRow, ZERO, type Dec,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import { accountBalances, accountRuleSql, trialBalance } from './reports.ts';
import { myCompanyCard } from './partnerReports.ts';

/**
 * Cash reports (spec 05 6.8-6.10, 02c 4): cash book, cash orders PKO/RKO,
 * cash and receivables.
 */

/** Cash-category accounts offered by the account combos (base/foreign cash, other cash). */
export const CASH_CATEGORIES = [21, 26, 58] as const;

const iso = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const f2 = (d: Dec) => d.toFixed(2);
const net = (a: Dec, b: Dec) => (a.minus(b).greaterThan(0) ? a.minus(b) : ZERO);

/** Mixed BGN/EUR period: legacy rows are divided by 1.95583 and their counter accounts mapped to the EUR chart. */
const isMixed = (start: string, end: string) => start < EURO_CHANGEOVER_DATE && end >= EURO_CHANGEOVER_DATE;
function factorSql(endDate: string) {
  return endDate >= EURO_CHANGEOVER_DATE ? sql`(CASE WHEN a.accounting_date < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(BGN_PER_EUR.toString())} ELSE 1 END)` : sql`1`;
}
/** Chart of the posting: EUR chart from 2026-01-01, BGN chart before (the same rule covers pure and mixed periods). */
const chartSql = (alias: string) => sql`${sql.raw(alias)}.is_euro = (a.accounting_date >= ${EURO_CHANGEOVER_DATE})`;

/** Partner of a leg pair: the leg's own partner, else the mirrored leg's (position ± 1). */
const pairCompanySql = sql`coalesce(d.company_id, (SELECT x.company_id FROM accounting_details x
  WHERE x.accounting_id = d.accounting_id AND x.position = d.position + d.sign))`;

/* ------------------------------------------------------------------ */
/* Касова книга (05 6.8)                                               */
/* ------------------------------------------------------------------ */

export interface CashBookOptions {
  startDate: string;
  endDate: string;
  accountNumber: string;
  withSubAccounts?: boolean;
  /** Partner-name pattern (LIKE, empty = all). */
  companyName?: string;
}

export interface CashBookRow {
  accountingId: number; accountingNumber: string; accountingDate: string;
  documentDate: string; documentType: string; documentNumber: string; term: string; companyName: string;
  incomeAmount: string; incomeAccount: string; incomeCurrencyAmount: string; incomeExchangeRate: string;
  expenseAmount: string; expenseAccount: string; expenseCurrencyAmount: string; expenseExchangeRate: string;
  balance: string; currencyBalance: string;
}

export async function cashBook(db: DbOrTx, o: CashBookOptions) {
  const withSub = o.withSubAccounts ?? false;
  const factor = factorSql(o.endDate);
  const mixed = isMixed(o.startDate, o.endDate);
  const pattern = o.companyName?.replace(/%/g, '').trim();
  const partnerCond = pattern ? sql`AND co.name ILIKE ${'%' + pattern + '%'}` : sql``;
  const matchD = accountRuleSql(sql`da.number`, o.accountNumber, withSub);
  const matchC = accountRuleSql(sql`ca.number`, o.accountNumber, withSub);
  // Counter accounts of legacy rows in a mixed period show their mapped EUR number.
  const counter = (alias: string, mapped: string) => mixed
    ? sql`CASE WHEN a.accounting_date < ${EURO_CHANGEOVER_DATE} THEN coalesce(${sql.raw(mapped)}.number, ${sql.raw(alias)}.number) ELSE ${sql.raw(alias)}.number END`
    : sql`${sql.raw(alias)}.number`;
  const rows = await queryRows<Record<string, unknown>>(db, sql`
    SELECT a.id, a.number, a.accounting_date, coalesce(doc.date, a.date) AS doc_date, dt.short_name AS doc_type, doc.number AS doc_number,
      t.description AS term, co.name AS company_name, d.amount / ${factor} AS amount,
      ${counter('da', 'mda')} AS debit_number, ${counter('ca', 'mca')} AS credit_number,
      ${matchD} AS is_income, ${matchC} AS is_expense,
      d.currency_amount AS d_cur, d.exchange_rate AS d_rate, m.currency_amount AS m_cur, m.exchange_rate AS m_rate
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts da ON da.id = d.account_id
      JOIN accounts ca ON ca.id = d.ref_account_id
      LEFT JOIN accounts mda ON mda.id = da.mapped_account_id
      LEFT JOIN accounts mca ON mca.id = ca.mapped_account_id
      LEFT JOIN accounting_details m ON m.accounting_id = d.accounting_id AND m.position = d.position + 1 AND m.sign = -1
      LEFT JOIN companies co ON co.id = coalesce(d.company_id, m.company_id)
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
    WHERE d.sign = 1 AND NOT a.is_initial_balance AND a.accounting_date BETWEEN ${o.startDate} AND ${o.endDate}
      AND (${matchD} OR ${matchC}) AND ${chartSql('da')} ${partnerCond}
    ORDER BY coalesce(doc.date, a.date), doc.document_type_id NULLS FIRST, a.accounting_date, a.number, a.id, d.position`);

  const balances = await cashBookBalances(db, o);
  let running = dec(balances.openingDebit).minus(balances.openingCredit);
  let runningCur = dec(balances.openingDebitCurrency).minus(balances.openingCreditCurrency);
  const out: CashBookRow[] = rows.map((r) => {
    const amount = dec(r.amount as string);
    const income = r.is_income ? amount : ZERO;
    const expense = r.is_expense ? amount : ZERO;
    const incomeCur = r.is_income ? dec(r.d_cur as string) : ZERO;
    const expenseCur = r.is_expense ? dec(r.m_cur as string) : ZERO;
    running = running.plus(income).minus(expense);
    runningCur = runningCur.plus(incomeCur).minus(expenseCur);
    return {
      accountingId: r.id as number, accountingNumber: str(r.number), accountingDate: iso(r.accounting_date),
      documentDate: iso(r.doc_date), documentType: str(r.doc_type), documentNumber: str(r.doc_number), term: str(r.term), companyName: str(r.company_name),
      incomeAmount: f2(income), incomeAccount: r.is_income ? str(r.credit_number) : '',
      incomeCurrencyAmount: f2(incomeCur), incomeExchangeRate: r.is_income && r.d_rate != null ? dec(r.d_rate as string).toString() : '',
      expenseAmount: f2(expense), expenseAccount: r.is_expense ? str(r.debit_number) : '',
      expenseCurrencyAmount: f2(expenseCur), expenseExchangeRate: r.is_expense && r.m_rate != null ? dec(r.m_rate as string).toString() : '',
      balance: f2(running), currencyBalance: f2(runningCur),
    };
  });
  const [acc] = await db.select({ description: s.accounts.description, currencyId: s.accounts.currencyId }).from(s.accounts)
    .where(sql`${s.accounts.number} = ${o.accountNumber} AND ${s.accounts.isEuro} = ${o.endDate >= EURO_CHANGEOVER_DATE}`).limit(1);
  const [cur] = acc ? await db.select({ isoCode: s.currencies.isoCode }).from(s.currencies).where(eq(s.currencies.id, acc.currencyId)) : [];
  const total = (k: keyof CashBookRow) => f2(out.reduce((a, r) => a.plus(r[k] as string), ZERO));
  return {
    myCompanyName: (await myCompanyCard(db)).name,
    accountDescription: acc?.description ?? '', accountCurrency: cur?.isoCode ?? '',
    balances, rows: out,
    totals: {
      income: total('incomeAmount'), expense: total('expenseAmount'),
      incomeCurrency: total('incomeCurrencyAmount'), expenseCurrency: total('expenseCurrencyAmount'),
    },
  };
}

/**
 * spCashBookBalancesSubReport: opening (initial balances or before S), turnover
 * and closing of the cash account from the financial-year start of S. Initial
 * correspondence entries are not excluded; same partner pattern.
 */
export async function cashBookBalances(db: DbOrTx, o: CashBookOptions) {
  const y = Number(o.startDate.slice(0, 4));
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
  const factor = factorSql(o.endDate);
  const pattern = o.companyName?.replace(/%/g, '').trim();
  const partnerCond = pattern ? sql`AND EXISTS (SELECT 1 FROM companies co WHERE co.id = ${pairCompanySql} AND co.name ILIKE ${'%' + pattern + '%'})` : sql``;
  const opening = sql`(a.is_initial_balance OR a.accounting_date < ${o.startDate})`;
  const sum = (cond: SQL, col: SQL) => sql`coalesce(SUM(CASE WHEN ${cond} THEN ${col} ELSE 0 END), 0)`;
  const [r] = await queryRows<Record<string, string>>(db, sql`
    SELECT ${sum(opening, sql`d.amount / ${factor}`)} AS od, ${sum(opening, sql`d.ref_amount / ${factor}`)} AS oc,
      ${sum(sql`NOT ${opening}`, sql`d.amount / ${factor}`)} AS dt, ${sum(sql`NOT ${opening}`, sql`d.ref_amount / ${factor}`)} AS ct,
      ${sum(sql`${opening} AND d.sign = 1`, sql`coalesce(d.currency_amount, 0)`)} AS ocd, ${sum(sql`${opening} AND d.sign = -1`, sql`coalesce(d.currency_amount, 0)`)} AS occ,
      ${sum(sql`NOT ${opening} AND d.sign = 1`, sql`coalesce(d.currency_amount, 0)`)} AS dtc, ${sum(sql`NOT ${opening} AND d.sign = -1`, sql`coalesce(d.currency_amount, 0)`)} AS ctc
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE ${fy ? sql`a.financial_year_id = ${fy.id}` : sql`a.accounting_date >= ${y + '-01-01'}`} AND a.accounting_date <= ${o.endDate}
      AND ${accountRuleSql(sql`ac.number`, o.accountNumber, o.withSubAccounts ?? false)} AND ${chartSql('ac')} ${partnerCond}`);
  const od = dec(r?.od), oc = dec(r?.oc), dt = dec(r?.dt), ct = dec(r?.ct);
  const ocd = dec(r?.ocd), occ = dec(r?.occ), dtc = dec(r?.dtc), ctc = dec(r?.ctc);
  return {
    openingDebit: f2(net(od, oc)), openingCredit: f2(net(oc, od)), debitTurnover: f2(dt), creditTurnover: f2(ct),
    closingDebit: f2(net(od.plus(dt), oc.plus(ct))), closingCredit: f2(net(oc.plus(ct), od.plus(dt))),
    openingDebitCurrency: f2(net(ocd, occ)), openingCreditCurrency: f2(net(occ, ocd)), debitTurnoverCurrency: f2(dtc), creditTurnoverCurrency: f2(ctc),
    closingDebitCurrency: f2(net(ocd.plus(dtc), occ.plus(ctc))), closingCreditCurrency: f2(net(occ.plus(ctc), ocd.plus(dtc))),
  };
}

/* ------------------------------------------------------------------ */
/* Касов ордер ПКО/РКО (05 6.9)                                        */
/* ------------------------------------------------------------------ */

export interface CashOrderOptions {
  startDate: string;
  endDate: string;
  /** 8 = ПКО (default), 9 = РКО. */
  documentTypeId?: number;
  accountNumber: string;
  companyName?: string;
  fromNumber?: string;
  toNumber?: string;
}

export interface CashOrderLine { accountingNumber: string; debitAccount: string; creditAccount: string; amount: string; documentNumber: string; date: string; term: string; companyName: string }

export interface CashOrder {
  accountingId: number; accountingNumber: string; documentNumber: string; documentDate: string; term: string; companyName: string;
  amount: string; amountText: string; currencyAmount: string; isoCode: string; exchangeRate: string; lines: CashOrderLine[];
}

const numericOrNull = (v: string) => (/^\s*-?\d+(\.\d+)?\s*$/.test(v) ? dec(v.trim()) : null);

export async function cashOrders(db: DbOrTx, o: CashOrderOptions) {
  const typeId = o.documentTypeId ?? 8;
  const factor = factorSql(o.endDate);
  const pattern = o.companyName?.replace(/%/g, '').trim();
  const cashMatch = sql`EXISTS (SELECT 1 FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id
    WHERE x.accounting_id = a.id AND ${accountRuleSql(sql`xa.number`, o.accountNumber)} AND xa.is_euro = (a.accounting_date >= ${EURO_CHANGEOVER_DATE}))`;
  const partnerSql = sql`(SELECT co.name FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id ORDER BY x.position LIMIT 1)`;
  const heads = await queryRows<Record<string, unknown>>(db, sql`
    SELECT a.id, a.number, a.accounting_date, doc.number AS doc_number, doc.date AS doc_date, t.description AS term, ${partnerSql} AS company_name,
      (SELECT coalesce(SUM(x.amount), 0) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1) / ${factor} AS amount,
      (SELECT coalesce(SUM(x.currency_amount), 0) FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id
        WHERE x.accounting_id = a.id AND ${accountRuleSql(sql`xa.number`, o.accountNumber)}) AS currency_amount,
      (SELECT c.iso_code FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id JOIN currencies c ON c.id = x.currency_id
        WHERE x.accounting_id = a.id AND ${accountRuleSql(sql`xa.number`, o.accountNumber)} ORDER BY x.position LIMIT 1) AS iso_code,
      (SELECT x.exchange_rate FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id
        WHERE x.accounting_id = a.id AND x.exchange_rate IS NOT NULL AND ${accountRuleSql(sql`xa.number`, o.accountNumber)} ORDER BY x.position LIMIT 1) AS exchange_rate
    FROM accountings a
      JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN terms t ON t.id = a.term_id
    WHERE doc.document_type_id = ${typeId} AND doc.date BETWEEN ${o.startDate} AND ${o.endDate} AND ${cashMatch}
      ${pattern ? sql`AND EXISTS (SELECT 1 FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id AND co.name ILIKE ${'%' + pattern + '%'})` : sql``}
    ORDER BY a.id`);

  // Number bounds compare as decimals; non-numeric numbers are left out when a bound is set
  // (the original raises a conversion error).
  const from = o.fromNumber?.trim() ? numericOrNull(o.fromNumber) : null;
  const to = o.toNumber?.trim() ? numericOrNull(o.toNumber) : null;
  const bounded = Boolean(o.fromNumber?.trim() || o.toNumber?.trim());
  const selected = heads.filter((h) => {
    if (!bounded) return true;
    const n = numericOrNull(str(h.doc_number));
    if (!n) return false;
    return (!from || n.greaterThanOrEqualTo(from)) && (!to || n.lessThanOrEqualTo(to));
  });

  const ids = selected.map((h) => h.id as number);
  const lines = ids.length ? await queryRows<Record<string, unknown>>(db, sql`
    SELECT d.accounting_id, a.number, da.number AS debit_number, ca.number AS credit_number, d.amount / ${factor} AS amount,
      doc.number AS doc_number, coalesce(doc.date, a.date) AS doc_date, t.description AS term, co.name AS company_name
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts da ON da.id = d.account_id
      JOIN accounts ca ON ca.id = d.ref_account_id
      LEFT JOIN accounting_details m ON m.accounting_id = d.accounting_id AND m.position = d.position + 1 AND m.sign = -1
      LEFT JOIN companies co ON co.id = coalesce(d.company_id, m.company_id)
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN terms t ON t.id = a.term_id
    WHERE d.sign = 1 AND d.accounting_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    ORDER BY d.accounting_id, d.position`) : [];

  const orders: CashOrder[] = selected.map((h) => {
    const amount = dec(h.amount as string);
    const docDate = iso(h.doc_date);
    // A legacy amount in a EUR report was converted, so it is spelled in euro (the original's leva wording is a known defect).
    const converted = o.endDate >= EURO_CHANGEOVER_DATE && iso(h.accounting_date) < EURO_CHANGEOVER_DATE;
    return {
      accountingId: h.id as number, accountingNumber: str(h.number), documentNumber: str(h.doc_number), documentDate: docDate,
      term: str(h.term), companyName: str(h.company_name), amount: f2(amount), amountText: cashOrderAmountInWords(amount.toFixed(2), docDate, converted),
      currencyAmount: f2(dec(h.currency_amount as string)), isoCode: str(h.iso_code), exchangeRate: h.exchange_rate != null ? dec(h.exchange_rate as string).toString() : '',
      lines: lines.filter((l) => l.accounting_id === h.id).map((l) => ({
        accountingNumber: str(l.number), debitAccount: str(l.debit_number), creditAccount: str(l.credit_number), amount: f2(dec(l.amount as string)),
        documentNumber: str(l.doc_number), date: iso(l.doc_date), term: str(l.term), companyName: str(l.company_name),
      })),
    };
  });
  const me = await myCompanyCard(db);
  const [docType] = await db.select({ name: s.documentTypes.name, shortName: s.documentTypes.shortName }).from(s.documentTypes).where(eq(s.documentTypes.id, typeId));
  return {
    myCompanyName: me.name, myCompanyBulstat: me.bulstat, documentTypeId: typeId,
    title: typeId === 9 ? 'Разходен касов ордер' : 'Приходен касов ордер', documentTypeShortName: docType?.shortName ?? '',
    orders, rows: pairTwoPerRow(orders),
  };
}

/* ------------------------------------------------------------------ */
/* Касова наличност и вземания (05 6.10)                               */
/* ------------------------------------------------------------------ */

export interface CashAndReceivablesOptions {
  startDate: string;
  endDate: string;
  /** 0 = synthetic, 1..5 analytical level (detailed layout). */
  subAccountLevel?: number;
}

export interface CashAndReceivablesRow {
  accountNumber: string; accountName: string;
  initialDebitBalance: string; initialCreditBalance: string; debitBalance: string; creditBalance: string; finalDebitBalance: string; finalCreditBalance: string;
}

export async function cashAndReceivables(db: DbOrTx, o: CashAndReceivablesOptions) {
  const numbers = [...new Set(CASH_AND_RECEIVABLES_SECTIONS.flatMap((x) => x.accounts))];
  const bal = new Map<string, Awaited<ReturnType<typeof accountBalances>>>();
  for (const n of numbers) bal.set(n, await accountBalances(db, n, { startDate: o.startDate, endDate: o.endDate }));
  const amounts = cashAndReceivablesFormulas((n) => bal.get(n) ?? { closingDebit: 0, closingCredit: 0 });

  const sections = [];
  for (const sec of CASH_AND_RECEIVABLES_SECTIONS) {
    const rows: CashAndReceivablesRow[] = [];
    for (const n of sec.accounts) {
      // Trial-balance levels count the class groups ("5", "50"): synthetic accounts sit at its level 2.
      const tb = await trialBalance(db, { startDate: o.startDate, endDate: o.endDate, accountNumber: n, subAccountLevel: (o.subAccountLevel ?? 0) + 2 });
      // The rows at the chosen level (or leaves above it).
      for (const r of tb.rows.filter((x) => !x.hasChildren)) {
        rows.push({
          accountNumber: r.number, accountName: r.description,
          initialDebitBalance: r.openingDebit, initialCreditBalance: r.openingCredit, debitBalance: r.debitTurnover, creditBalance: r.creditTurnover,
          finalDebitBalance: r.closingDebit, finalCreditBalance: r.closingCredit,
        });
      }
    }
    sections.push({ key: sec.key, title: sec.title, amount: amounts[sec.key], rows });
  }
  const [me] = await db.select({ name: s.myCompany.name }).from(s.myCompany).orderBy(asc(s.myCompany.id)).limit(1);
  return { myCompanyName: me?.name ?? '', startDate: o.startDate, endDate: o.endDate, ...amounts, totalAmount: amounts.total, sections };
}
