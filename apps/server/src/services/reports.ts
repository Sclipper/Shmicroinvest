import { and, eq, sql, type SQL } from 'drizzle-orm';
import { BGN_PER_EUR, COMPANY_CATEGORIES, dec, ZERO, type Dec, EURO_CHANGEOVER_DATE } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import type { DbOrTx } from '../db/provider.ts';

/**
 * Accounting reports (spec 05 sections 2-5): trial balance, general ledger,
 * account card (analytical register), chronological register, chart report.
 */

export interface PeriodFilter {
  startDate: string;
  endDate: string;
  byExportMonth?: boolean;
  companyIds?: number[];
}

/** Account-number rule (05 2.5): equal, or "p/..." sub-account, or prefix when p is shorter than 3 chars. */
export function matchesAccount(number: string, p: string, withSub = true): boolean {
  if (!p) return true;
  if (number === p) return true;
  if (!withSub) return false;
  if (number.startsWith(p + '/')) return true;
  return p.length < 3 && number.startsWith(p);
}

/** Sort key of fAccountsSorted: first part as text, further parts numerically. */
export function accountSortKey(number: string): string {
  const [first, ...rest] = number.split('/');
  return [first!.padEnd(10, ' '), ...rest.map((r) => (/^\d+$/.test(r) ? r.padStart(8, '0') : r.padEnd(8, ' ')))].join('|');
}
export const compareAccountNumbers = (a: string, b: string) => (accountSortKey(a) < accountSortKey(b) ? -1 : accountSortKey(a) > accountSortKey(b) ? 1 : 0);

export const netDebit = (d: Dec, c: Dec) => (d.minus(c).greaterThan(0) ? d.minus(c) : ZERO);

/** EUR report: legacy (pre-2026) amounts are divided by 1.95583. */
export function conversionSql(endDate: string, dateCol: SQL) {
  const convert = endDate >= EURO_CHANGEOVER_DATE;
  return convert ? sql`CASE WHEN ${dateCol} < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(BGN_PER_EUR.toString())} ELSE 1 END` : sql`1`;
}

export async function yearOf(db: DbOrTx, date: string) {
  const y = Number(date.slice(0, 4));
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
  return fy;
}

/**
 * Posting window of the trial-balance family (05 2.3): from the start of the
 * financial year of S (by date, so a mixed period also reads the postings of
 * the next year), excluding initial-balance accountings of other years.
 */
export function fyWindowSql(fy: { id: number; startDate: string } | undefined, dateCol: SQL, startDate: string): SQL {
  return fy ? sql`(${dateCol} >= ${fy.startDate} AND NOT (a.is_initial_balance AND a.financial_year_id <> ${fy.id}))` : sql`${dateCol} >= ${startDate}`;
}

export interface TreeAccount { id: number; parentId: number | null; number: string; description: string; englishDescription: string | null; level: number; isEuro: boolean; categoryId: number | null; currencyId: number; productId: number | null }

export async function loadTree(db: DbOrTx) {
  const rows = await db.select({
    id: s.accounts.id, parentId: s.accounts.parentId, number: s.accounts.number, description: s.accounts.description,
    englishDescription: s.accounts.englishDescription, level: s.accounts.level, isEuro: s.accounts.isEuro,
    categoryId: s.accounts.accountCategoryId, currencyId: s.accounts.currencyId, productId: s.accounts.productId,
  }).from(s.accounts);
  return rows as TreeAccount[];
}

/** Map every account to the account of the report chart (same chart, else same number, else mapped). */
export function chartMapper(all: TreeAccount[], isEuro: boolean) {
  const byId = new Map(all.map((a) => [a.id, a]));
  const reportByNumber = new Map(all.filter((a) => a.isEuro === isEuro).map((a) => [a.number, a]));
  return (id: number): TreeAccount | undefined => {
    const a = byId.get(id);
    if (!a) return undefined;
    if (a.isEuro === isEuro) return a;
    return reportByNumber.get(a.number) ?? a;
  };
}

export function ancestorsOf(a: TreeAccount, byId: Map<number, TreeAccount>) {
  const out: TreeAccount[] = [];
  let p = a.parentId != null ? byId.get(a.parentId) : undefined;
  while (p && p.number !== '0') { out.push(p); p = p.parentId != null ? byId.get(p.parentId) : undefined; }
  return out;
}

export interface TrialBalanceOptions extends PeriodFilter {
  accountNumber?: string;
  /** Deepest tree level shown, counted from the classes: 0 = classes ("5"), 1 = groups ("50"), 2 = synthetic ("501"), 3+ = analytic levels. */
  subAccountLevel?: number;
  showZeroRows?: boolean;
  withoutOffBalance?: boolean;
}

export interface TrialBalanceRow {
  accountId: number;
  number: string;
  description: string;
  englishDescription: string | null;
  level: number;
  hasChildren: boolean;
  openingDebit: string; openingCredit: string;
  debitTurnover: string; creditTurnover: string;
  closingDebit: string; closingCredit: string;
}

/** Trial balance (Оборотна ведомост, spec 05 section 3). */
export async function trialBalance(db: DbOrTx, o: TrialBalanceOptions) {
  const fy = await yearOf(db, o.startDate);
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const opening = sql`(a.is_initial_balance OR ${dateCol} < ${o.startDate})`;
  const companyFilter = o.companyIds?.length ? sql`AND d.company_id IN (${sql.join(o.companyIds.map((c) => sql`${c}`), sql`, `)})` : sql``;
  const yearFilter = fyWindowSql(fy, dateCol, o.startDate);
  const res = await exec(db, sql`
    SELECT d.account_id,
      SUM(CASE WHEN ${opening} THEN d.amount / ${factor} ELSE 0 END) AS od,
      SUM(CASE WHEN ${opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS oc,
      SUM(CASE WHEN NOT ${opening} THEN d.amount / ${factor} ELSE 0 END) AS dt,
      SUM(CASE WHEN NOT ${opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
    WHERE ${yearFilter} AND ${dateCol} <= ${o.endDate}
      AND NOT (a.is_initial_balance AND a.is_initial_correspondence)
      ${companyFilter}
    GROUP BY d.account_id`);
  const sums = (res.rows as { account_id: number; od: string; oc: string; dt: string; ct: string }[]);

  const all = await loadTree(db);
  const isEuro = o.endDate >= EURO_CHANGEOVER_DATE;
  const mapTo = chartMapper(all, isEuro);
  const chart = all.filter((a) => a.isEuro === isEuro && a.number !== '0');
  const byId = new Map(all.map((a) => [a.id, a]));
  const hasChildren = new Set(chart.map((a) => a.parentId));
  const maxLevel = (o.subAccountLevel ?? 0) + 2;

  const agg = new Map<number, { od: Dec; oc: Dec; dt: Dec; ct: Dec }>();
  const add = (id: number, r: { od: Dec; oc: Dec; dt: Dec; ct: Dec }) => {
    const cur = agg.get(id) ?? { od: ZERO, oc: ZERO, dt: ZERO, ct: ZERO };
    agg.set(id, { od: cur.od.plus(r.od), oc: cur.oc.plus(r.oc), dt: cur.dt.plus(r.dt), ct: cur.ct.plus(r.ct) });
  };
  for (const r of sums) {
    const acc = mapTo(r.account_id);
    if (!acc) continue;
    const v = { od: dec(r.od), oc: dec(r.oc), dt: dec(r.dt), ct: dec(r.ct) };
    add(acc.id, v);
    for (const anc of ancestorsOf(acc, byId)) add(anc.id, v);
  }

  const rows: TrialBalanceRow[] = [];
  for (const a of chart) {
    if (a.level < 2 || a.level > maxLevel) continue;
    if (o.accountNumber && !matchesAccount(a.number, o.accountNumber)) continue;
    if (o.withoutOffBalance && a.number.startsWith('9')) continue;
    const v = agg.get(a.id) ?? { od: ZERO, oc: ZERO, dt: ZERO, ct: ZERO };
    const oD = netDebit(v.od, v.oc), oC = netDebit(v.oc, v.od);
    const cD = netDebit(v.od.plus(v.dt), v.oc.plus(v.ct)), cC = netDebit(v.oc.plus(v.ct), v.od.plus(v.dt));
    const zero = oD.isZero() && oC.isZero() && v.dt.isZero() && v.ct.isZero();
    if (zero && !o.showZeroRows) continue;
    rows.push({
      accountId: a.id, number: a.number, description: a.description, englishDescription: a.englishDescription,
      level: a.level, hasChildren: hasChildren.has(a.id) && a.level < maxLevel,
      openingDebit: oD.toFixed(2), openingCredit: oC.toFixed(2),
      debitTurnover: v.dt.toFixed(2), creditTurnover: v.ct.toFixed(2),
      closingDebit: cD.toFixed(2), closingCredit: cC.toFixed(2),
    });
  }
  rows.sort((x, y) => compareAccountNumbers(x.number, y.number));
  // Totals: rows without an ancestor in the result (sub-rows are already folded into their parents).
  const inResult = new Set(rows.map((r) => r.accountId));
  const top = rows.filter((r) => !ancestorsOf(byId.get(r.accountId)!, byId).some((anc) => inResult.has(anc.id)));
  const total = (k: keyof TrialBalanceRow) => top.reduce((acc, r) => acc.plus(dec(r[k] as string)), ZERO).toFixed(2);
  return {
    rows,
    totals: {
      openingDebit: total('openingDebit'), openingCredit: total('openingCredit'),
      debitTurnover: total('debitTurnover'), creditTurnover: total('creditTurnover'),
      closingDebit: total('closingDebit'), closingCredit: total('closingCredit'),
    },
  };
}

/** Balances (spBalancesReport): opening, turnover and closing of an account and its sub-accounts. */
export async function accountBalances(db: DbOrTx, accountNumber: string, o: PeriodFilter, withSub = true) {
  const fy = await yearOf(db, o.startDate);
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const opening = sql`(a.is_initial_balance OR ${dateCol} < ${o.startDate})`;
  const partnerSelected = Boolean(o.companyIds?.length);
  const companyFilter = partnerSelected ? sql`AND d.company_id IN (${sql.join(o.companyIds!.map((c) => sql`${c}`), sql`, `)})` : sql``;
  // Initial correspondences count only when specific partners are selected (fnGetBalances).
  const corrFilter = partnerSelected ? sql`` : sql`AND NOT (a.is_initial_balance AND a.is_initial_correspondence)`;
  const yearFilter = fyWindowSql(fy, dateCol, o.startDate);
  const accFilter = accountRuleSql(sql`ac.number`, accountNumber, withSub);
  const res = await exec(db, sql`
    SELECT
      coalesce(SUM(CASE WHEN ${opening} THEN d.amount / ${factor} ELSE 0 END), 0) AS od,
      coalesce(SUM(CASE WHEN ${opening} THEN d.ref_amount / ${factor} ELSE 0 END), 0) AS oc,
      coalesce(SUM(CASE WHEN NOT ${opening} THEN d.amount / ${factor} ELSE 0 END), 0) AS dt,
      coalesce(SUM(CASE WHEN NOT ${opening} THEN d.ref_amount / ${factor} ELSE 0 END), 0) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE ${yearFilter} AND ${dateCol} <= ${o.endDate} AND ${accFilter} ${corrFilter} ${companyFilter}`);
  const r = res.rows[0] as { od: string; oc: string; dt: string; ct: string };
  const od = dec(r.od), oc = dec(r.oc), dt = dec(r.dt), ct = dec(r.ct);
  return {
    openingDebit: netDebit(od, oc).toFixed(2), openingCredit: netDebit(oc, od).toFixed(2),
    debitTurnover: dt.toFixed(2), creditTurnover: ct.toFixed(2),
    closingDebit: netDebit(od.plus(dt), oc.plus(ct)).toFixed(2), closingCredit: netDebit(oc.plus(ct), od.plus(dt)).toFixed(2),
  };
}

export function accountRuleSql(col: SQL, p: string, withSub = true): SQL {
  if (!p) return sql`true`;
  if (!withSub) return sql`${col} = ${p}`;
  if (p.length < 3) return sql`(${col} = ${p} OR ${col} LIKE ${p + '%'})`;
  return sql`(${col} = ${p} OR ${col} LIKE ${p + '/%'})`;
}

export interface LedgerOptions extends PeriodFilter { accountNumber?: string; subAccountLevel?: number; withBalances?: boolean }

/** General ledger (Главна книга, spec 05 4.1): turnovers per account against each counter account. */
export async function generalLedger(db: DbOrTx, o: LedgerOptions) {
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const accFilter = o.accountNumber ? accountRuleSql(sql`ac.number`, o.accountNumber) : sql`true`;
  const companyFilter = o.companyIds?.length ? sql`AND d.company_id IN (${sql.join(o.companyIds.map((c) => sql`${c}`), sql`, `)})` : sql``;
  const res = await exec(db, sql`
    SELECT d.account_id, d.ref_account_id, SUM(d.amount / ${factor}) AS dt, SUM(d.ref_amount / ${factor}) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE NOT a.is_initial_balance AND ${dateCol} >= ${o.startDate} AND ${dateCol} <= ${o.endDate} AND ${accFilter} ${companyFilter}
    GROUP BY d.account_id, d.ref_account_id`);
  const all = await loadTree(db);
  const byId = new Map(all.map((a) => [a.id, a]));
  const maxLevel = (o.subAccountLevel ?? 0) + 2;
  const rollUp = (id: number) => {
    let a = byId.get(id);
    while (a && a.level > maxLevel && a.parentId != null) a = byId.get(a.parentId);
    return a;
  };
  const groups = new Map<string, { account: TreeAccount; counters: Map<string, { account: TreeAccount; dt: Dec; ct: Dec }> }>();
  for (const r of res.rows as { account_id: number; ref_account_id: number; dt: string; ct: string }[]) {
    const acc = rollUp(r.account_id);
    const ref = rollUp(r.ref_account_id);
    if (!acc || !ref) continue;
    const g = groups.get(acc.number) ?? { account: acc, counters: new Map() };
    const c = g.counters.get(ref.number) ?? { account: ref, dt: ZERO, ct: ZERO };
    c.dt = c.dt.plus(dec(r.dt));
    c.ct = c.ct.plus(dec(r.ct));
    g.counters.set(ref.number, c);
    groups.set(acc.number, g);
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => compareAccountNumbers(a.account.number, b.account.number))) {
    const counters = [...g.counters.values()].sort((a, b) => compareAccountNumbers(a.account.number, b.account.number));
    const totalDebit = counters.reduce((acc, c) => acc.plus(c.dt), ZERO);
    const totalCredit = counters.reduce((acc, c) => acc.plus(c.ct), ZERO);
    out.push({
      number: g.account.number,
      description: g.account.description,
      englishDescription: g.account.englishDescription ?? '',
      counters: counters.map((c) => ({ number: c.account.number, description: c.account.description, englishDescription: c.account.englishDescription ?? '', debit: c.dt.toFixed(2), credit: c.ct.toFixed(2) })),
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      balances: o.withBalances ? await accountBalances(db, g.account.number, o) : undefined,
    });
  }
  return out;
}

/** "Филтър по" columns of the chronological register and the account card (05 4.2, 5). */
export const JOURNAL_FILTER_COLUMNS = [
  'AccountingNumber', 'AccountingDate', 'DebitAccount', 'DebitAccountDescription', 'CreditAccount', 'CreditAccountDescription', 'Amount',
  'DocumentDate', 'DocumentNumber', 'DocumentType', 'CompanyName', 'Term', 'Reference', 'ViesMonth', 'OptionalReference', 'Paragraph', 'UserName', 'VatTerm',
  'DebitCurrencyAmount', 'DebitExchangeRate', 'CreditCurrencyAmount', 'CreditExchangeRate', 'DebitQuantity', 'DebitPrice', 'CreditQuantity', 'CreditPrice',
] as const;
export type JournalFilterColumn = (typeof JOURNAL_FILTER_COLUMNS)[number];

/** "Сортиране" columns (05 4.2 step 6, 5 step 6). */
export const JOURNAL_SORT_COLUMNS = [
  'AccountingNumber', 'AccountingDate', 'ViesMonth', 'DocumentNumber', 'DocumentDate', 'CompanyName', 'DebitAccount', 'CreditAccount', 'Amount', 'DocumentType', 'Term', 'Reference',
] as const;
export type JournalSortColumn = (typeof JOURNAL_SORT_COLUMNS)[number];

const FILTER_SQL: Record<JournalFilterColumn, SQL> = {
  AccountingNumber: sql`x.number`,
  AccountingDate: sql`to_char(x.accounting_date, 'DD.MM.YYYY')`,
  DebitAccount: sql`x.debit_account`,
  DebitAccountDescription: sql`x.debit_description`,
  CreditAccount: sql`x.credit_account`,
  CreditAccountDescription: sql`x.credit_description`,
  Amount: sql`CAST(round(x.amount, 2) AS text)`,
  DocumentDate: sql`to_char(x.document_date, 'DD.MM.YYYY')`,
  DocumentNumber: sql`x.document_number`,
  DocumentType: sql`x.document_type`,
  CompanyName: sql`x.company_name`,
  Term: sql`x.term`,
  Reference: sql`x.reference`,
  ViesMonth: sql`to_char(x.vies_month, 'MM.YYYY')`,
  OptionalReference: sql`x.optional_reference`,
  Paragraph: sql`x.paragraph`,
  UserName: sql`x.user_name`,
  VatTerm: sql`(x.vat_term_id::text || ' - ' || x.vat_term)`,
  DebitCurrencyAmount: sql`CAST(round(x.debit_currency_amount, 2) AS text)`,
  DebitExchangeRate: sql`CAST(x.debit_exchange_rate AS text)`,
  CreditCurrencyAmount: sql`CAST(round(x.credit_currency_amount, 2) AS text)`,
  CreditExchangeRate: sql`CAST(x.credit_exchange_rate AS text)`,
  DebitQuantity: sql`CAST(x.debit_quantity AS text)`,
  DebitPrice: sql`CAST(x.debit_price AS text)`,
  CreditQuantity: sql`CAST(x.credit_quantity AS text)`,
  CreditPrice: sql`CAST(x.credit_price AS text)`,
};
/** Columns searched when no filter column is chosen ("Всички"). */
const ANY_FILTER: JournalFilterColumn[] = [
  'AccountingNumber', 'AccountingDate', 'DebitAccount', 'DebitAccountDescription', 'CreditAccount', 'CreditAccountDescription', 'Amount',
  'DocumentDate', 'DocumentNumber', 'CompanyName', 'Term', 'Reference', 'OptionalReference', 'Paragraph',
];
const NUMERIC_FILTER = /Amount|Rate|Quantity|Price/;

const SORT_SQL: Record<JournalSortColumn, SQL> = {
  AccountingNumber: sql`x.number`,
  AccountingDate: sql`x.accounting_date`,
  ViesMonth: sql`x.vies_month`,
  DocumentNumber: sql`x.document_number`,
  DocumentDate: sql`x.document_date`,
  CompanyName: sql`x.company_name`,
  DebitAccount: sql`x.debit_account`,
  CreditAccount: sql`x.credit_account`,
  Amount: sql`x.amount`,
  DocumentType: sql`x.document_type`,
  Term: sql`x.term`,
  Reference: sql`x.reference`,
};

export interface JournalLineFilter extends PeriodFilter {
  debitAccount?: string;
  debitWithSub?: boolean;
  creditAccount?: string;
  creditWithSub?: boolean;
  /** "Без сметки в дебита / кредита": exact account numbers removed after the account filter. */
  excludedDebitAccounts?: string[];
  excludedCreditAccounts?: string[];
  account?: string;
  accountWithSub?: boolean;
  fromNumber?: string;
  toNumber?: string;
  documentTypeId?: number;
  documentNumber?: string;
  transactionTypeId?: number;
  vatTermId?: number;
  /** Free text; with filterColumn only that column is searched. */
  text?: string;
  filterColumn?: JournalFilterColumn | '';
  sortColumn?: JournalSortColumn | '';
  /** Валутна / Материална: only lines with a currency amount / quantity on either side. */
  family?: 'standard' | 'currency' | 'quantity';
  /**
   * Mixed period (end on/after 2026): pre-2026 postings are shown with their
   * mapped EUR accounts and the account filters compare the mapped numbers
   * (chronological register, 05 5 step 8). The account card keeps the
   * accounts' own numbers (05 4.2 step 7).
   */
  mapToReportChart?: boolean;
  limit?: number;
}

const idList = (ids: number[]) => sql.join(ids.map((c) => sql`${c}`), sql`, `);
const textList = (v: string[]) => sql.join(v.map((c) => sql`${c}`), sql`, `);

/** Pair-style rows: Sign = +1 legs (debit account / credit account / amount), the credit side's currency/quantity from the mirrored -1 leg. */
export async function journalLines(db: DbOrTx, o: JournalLineFilter) {
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const remap = (o.mapToReportChart ?? false) && o.endDate >= EURO_CHANGEOVER_DATE;
  // The mapped EUR account of a pre-2026 BGN-chart posting: Accounts.MappedAccountID, else the EUR account with the same number.
  const mapped = (alias: string, own: string) => remap
    ? sql.raw(`a.accounting_date < '${EURO_CHANGEOVER_DATE}' AND NOT ${own}.is_euro AND ${alias}.id = coalesce(${own}.mapped_account_id,
        (SELECT e.id FROM accounts e WHERE e.is_euro AND e.number = ${own}.number ORDER BY e.id LIMIT 1))`)
    : sql`false`;
  const inner: SQL[] = [sql`d.sign = 1`, sql`NOT a.is_initial_balance`, sql`${dateCol} >= ${o.startDate}`, sql`${dateCol} <= ${o.endDate}`];
  if (o.companyIds?.length) inner.push(sql`co.id IN (${idList(o.companyIds)})`);
  if (o.fromNumber) inner.push(sql`a.number >= ${o.fromNumber}`);
  if (o.toNumber) inner.push(sql`a.number <= ${o.toNumber}`);
  if (o.documentTypeId) inner.push(sql`doc.document_type_id = ${o.documentTypeId}`);
  if (o.documentNumber) inner.push(sql`doc.number = ${o.documentNumber}`);
  if (o.transactionTypeId) inner.push(sql`a.transaction_type_id = ${o.transactionTypeId}`);
  if (o.vatTermId) inner.push(sql`vt.id = ${o.vatTermId}`);
  if (o.family === 'currency') inner.push(sql`(d.currency_amount IS NOT NULL OR m.currency_amount IS NOT NULL)`);
  if (o.family === 'quantity') inner.push(sql`(d.quantity IS NOT NULL OR m.quantity IS NOT NULL)`);

  const outer: SQL[] = [sql`true`];
  if (o.debitAccount) outer.push(accountRuleSql(sql`x.debit_account`, o.debitAccount, o.debitWithSub ?? true));
  if (o.creditAccount) outer.push(accountRuleSql(sql`x.credit_account`, o.creditAccount, o.creditWithSub ?? true));
  if (o.account) outer.push(sql`(${accountRuleSql(sql`x.debit_account`, o.account, o.accountWithSub ?? true)} OR ${accountRuleSql(sql`x.credit_account`, o.account, o.accountWithSub ?? true)})`);
  const excludedDebit = (o.excludedDebitAccounts ?? []).map((v) => v.trim()).filter(Boolean);
  const excludedCredit = (o.excludedCreditAccounts ?? []).map((v) => v.trim()).filter(Boolean);
  if (excludedDebit.length) outer.push(sql`x.debit_account NOT IN (${textList(excludedDebit)})`);
  if (excludedCredit.length) outer.push(sql`x.credit_account NOT IN (${textList(excludedCredit)})`);
  const text = o.text?.trim();
  if (text) {
    const like = `%${text}%`;
    const numeric = `%${text.replace(/\s/g, '').replace(',', '.')}%`;
    const columns = o.filterColumn ? [o.filterColumn] : ANY_FILTER;
    outer.push(sql`(${sql.join(columns.map((c) => (NUMERIC_FILTER.test(c) ? sql`${FILTER_SQL[c]} LIKE ${numeric}` : sql`${FILTER_SQL[c]} ILIKE ${like}`)), sql` OR `)})`);
  }
  const order = o.sortColumn
    ? sql`x.fy_year, ${SORT_SQL[o.sortColumn]}, x.number, x.position, x.detail_id`
    : sql`x.accounting_date, x.number, x.position, x.detail_id`;
  const res = await exec(db, sql`
    WITH x AS (
      SELECT d.id AS detail_id, a.id AS accounting_id, fy.year AS fy_year, a.number, a.accounting_date, a.vies_month, d.position,
        coalesce(dm.number, da.number) AS debit_account, coalesce(dm.description, da.description) AS debit_description,
        coalesce(dm.english_description, da.english_description) AS debit_english,
        coalesce(cm.number, ca.number) AS credit_account, coalesce(cm.description, ca.description) AS credit_description,
        coalesce(cm.english_description, ca.english_description) AS credit_english,
        d.amount / ${factor} AS amount,
        d.currency_amount AS debit_currency_amount, d.exchange_rate AS debit_exchange_rate, d.quantity AS debit_quantity, d.price AS debit_price,
        m.currency_amount AS credit_currency_amount, m.exchange_rate AS credit_exchange_rate, m.quantity AS credit_quantity, m.price AS credit_price,
        dcur.iso_code AS debit_currency, ccur.iso_code AS credit_currency,
        co.name AS company_name, coalesce(nullif(co.vat_number, ''), co.bulstat) AS company_vat,
        dt.short_name AS document_type, doc.date AS document_date, doc.number AS document_number,
        t.description AS term, r.description AS reference, orf.description AS optional_reference, pg.description AS paragraph,
        vt.id AS vat_term_id, vt.description AS vat_term, a.transaction_type_id, u.name AS user_name
      FROM accounting_details d
        JOIN accountings a ON a.id = d.accounting_id
        JOIN financial_years fy ON fy.id = a.financial_year_id
        JOIN accounts da ON da.id = d.account_id
        JOIN accounts ca ON ca.id = d.ref_account_id
        LEFT JOIN LATERAL (SELECT mm.vat_term_id, mm.currency_id, mm.currency_amount, mm.exchange_rate, mm.quantity, mm.price FROM accounting_details mm
          WHERE mm.accounting_id = d.accounting_id AND mm.sign = -1 AND mm.account_id = d.ref_account_id AND mm.ref_account_id = d.account_id
          ORDER BY abs(mm.position - d.position - 1), mm.id LIMIT 1) m ON true
        LEFT JOIN accounts dm ON ${mapped('dm', 'da')}
        LEFT JOIN accounts cm ON ${mapped('cm', 'ca')}
        LEFT JOIN currencies dcur ON dcur.id = d.currency_id
        LEFT JOIN currencies ccur ON ccur.id = m.currency_id
        LEFT JOIN companies co ON co.id = coalesce(d.company_id, (SELECT mc.company_id FROM accounting_details mc WHERE mc.accounting_id = d.accounting_id AND mc.sign = -1
          AND mc.account_id = d.ref_account_id AND mc.ref_account_id = d.account_id AND mc.company_id IS NOT NULL LIMIT 1))
        LEFT JOIN documents doc ON doc.id = a.document_id
        LEFT JOIN document_types dt ON dt.id = doc.document_type_id
        LEFT JOIN terms t ON t.id = a.term_id
        LEFT JOIN reference_texts r ON r.id = a.reference_id
        LEFT JOIN reference_texts orf ON orf.id = a.optional_reference_id
        LEFT JOIN paragraphs pg ON pg.id = a.paragraph_id
        -- The pair's VAT operation: the debit leg's, or the credit leg's when the debit leg has the default term 1.
        LEFT JOIN vat_terms vt ON vt.id = CASE WHEN d.vat_term_id = 1 AND m.vat_term_id IS NOT NULL THEN m.vat_term_id ELSE d.vat_term_id END
        LEFT JOIN users u ON u.id = a.user_id
      WHERE ${sql.join(inner, sql` AND `)}
    )
    SELECT * FROM x WHERE ${sql.join(outer, sql` AND `)}
    ORDER BY ${order}
    LIMIT ${o.limit ?? 20000}`);
  const str = (v: unknown) => (v as string | null) ?? '';
  const num = (v: unknown, places?: number) => (v === null || v === undefined ? null : places === undefined ? String(v) : dec(v as string).toFixed(places));
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    detailId: r.detail_id as number,
    accountingId: r.accounting_id as number,
    financialYear: r.fy_year as number,
    number: r.number as string,
    accountingDate: String(r.accounting_date).slice(0, 10),
    viesMonth: String(r.vies_month).slice(0, 10),
    debitAccount: r.debit_account as string,
    debitDescription: r.debit_description as string,
    debitEnglishDescription: str(r.debit_english),
    creditAccount: r.credit_account as string,
    creditDescription: r.credit_description as string,
    creditEnglishDescription: str(r.credit_english),
    amount: dec(r.amount as string).toFixed(2),
    /** Debit leg's raw currency / quantity values (kept for existing callers). */
    currencyAmount: num(r.debit_currency_amount),
    exchangeRate: num(r.debit_exchange_rate),
    quantity: num(r.debit_quantity),
    price: num(r.debit_price),
    debitCurrency: str(r.debit_currency),
    debitCurrencyAmount: num(r.debit_currency_amount, 2),
    debitExchangeRate: num(r.debit_exchange_rate, 5),
    creditCurrency: str(r.credit_currency),
    creditCurrencyAmount: num(r.credit_currency_amount, 2),
    creditExchangeRate: num(r.credit_exchange_rate, 5),
    debitQuantity: num(r.debit_quantity, 3),
    debitPrice: num(r.debit_price, 3),
    creditQuantity: num(r.credit_quantity, 3),
    creditPrice: num(r.credit_price, 3),
    companyName: str(r.company_name),
    companyVat: str(r.company_vat),
    documentType: str(r.document_type),
    documentDate: r.document_date ? String(r.document_date).slice(0, 10) : '',
    documentNumber: str(r.document_number),
    term: str(r.term),
    reference: str(r.reference),
    optionalReference: str(r.optional_reference),
    paragraph: str(r.paragraph),
    transactionTypeId: r.transaction_type_id as number,
    vatTermId: r.vat_term_id as number | null,
    vatTerm: r.vat_term ? `${r.vat_term_id} - ${r.vat_term}` : '',
    userName: str(r.user_name),
  }));
}

export type JournalLine = Awaited<ReturnType<typeof journalLines>>[number];

export interface AnalyticalOptions extends PeriodFilter {
  accountNumber: string;
  withSub?: boolean;
  text?: string;
  filterColumn?: JournalFilterColumn | '';
  sortColumn?: JournalSortColumn | '';
  /** Тип справка: Стандартна (running balance), Валутна (currency amount and rate), Материална (quantity and price). */
  reportType?: 'standard' | 'currency' | 'quantity';
}

/**
 * Account card (Аналитичен регистър, spec 05 4.2). The running balance here
 * advances on every printed line, including sub-account lines (the original
 * only tracks the account itself and leaves sub-account lines blank). It is
 * built on all lines in posting order before the free-text filter and the
 * sort are applied, so neither changes it.
 */
export async function analyticalRegister(db: DbOrTx, o: AnalyticalOptions) {
  const withSub = o.withSub ?? true;
  const opening = await accountBalances(db, o.accountNumber, o, withSub);
  const base: JournalLineFilter = { ...o, account: o.accountNumber, accountWithSub: withSub, text: undefined, filterColumn: undefined, sortColumn: undefined };
  const all = await journalLines(db, base);
  let bal = dec(opening.openingDebit).minus(dec(opening.openingCredit));
  const isMine = (n: string) => matchesAccount(n, o.accountNumber, withSub);
  let dt = ZERO, ct = ZERO;
  const running = new Map<number, { balanceDebit: string; balanceCredit: string }>();
  for (const l of all) {
    const amt = dec(l.amount);
    const debitSide = isMine(l.debitAccount);
    const creditSide = isMine(l.creditAccount);
    // A line between two sub-accounts of the same account moves nothing.
    if (debitSide && !creditSide) { bal = bal.plus(amt); dt = dt.plus(amt); }
    else if (creditSide && !debitSide) { bal = bal.minus(amt); ct = ct.plus(amt); }
    else { dt = dt.plus(amt); ct = ct.plus(amt); }
    running.set(l.detailId, { balanceDebit: bal.greaterThan(0) ? bal.toFixed(2) : '0.00', balanceCredit: bal.lessThan(0) ? bal.negated().toFixed(2) : '0.00' });
  }
  const shown = o.text?.trim() || o.sortColumn
    ? await journalLines(db, { ...base, text: o.text, filterColumn: o.filterColumn, sortColumn: o.sortColumn })
    : all;
  const lines = shown.map((l) => ({ ...l, ...running.get(l.detailId)! }));
  // Currency / quantity totals of the card's own side (Валутна / Материална).
  const sideSum = (pick: (l: JournalLine) => string | null, side: 'debit' | 'credit') =>
    lines.reduce((acc, l) => {
      const v = pick(l);
      return isMine(side === 'debit' ? l.debitAccount : l.creditAccount) && v ? acc.plus(dec(v)) : acc;
    }, ZERO);
  const [acc] = await db.select({ description: s.accounts.description, englishDescription: s.accounts.englishDescription }).from(s.accounts)
    .where(and(eq(s.accounts.number, o.accountNumber), eq(s.accounts.isEuro, o.endDate >= EURO_CHANGEOVER_DATE))).limit(1);
  return {
    reportType: o.reportType ?? 'standard',
    accountDescription: acc?.description ?? '',
    accountEnglishDescription: acc?.englishDescription ?? '',
    opening,
    lines,
    turnover: { debit: dt.toFixed(2), credit: ct.toFixed(2) },
    closing: { debit: bal.greaterThan(0) ? bal.toFixed(2) : '0.00', credit: bal.lessThan(0) ? bal.negated().toFixed(2) : '0.00' },
    currencyTotals: { debit: sideSum((l) => l.debitCurrencyAmount, 'debit').toFixed(2), credit: sideSum((l) => l.creditCurrencyAmount, 'credit').toFixed(2) },
    quantityTotals: { debit: sideSum((l) => l.debitQuantity, 'debit').toFixed(3), credit: sideSum((l) => l.creditQuantity, 'credit').toFixed(3) },
  };
}

/** Partner turnover (ОВ по партньори, spec 05 3.5 P). */
export async function partnerTurnover(db: DbOrTx, o: PeriodFilter & { accountNumber: string; showZeroRows?: boolean }) {
  const fy = await yearOf(db, o.startDate);
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const opening = sql`(a.is_initial_balance OR ${dateCol} < ${o.startDate})`;
  const yearFilter = fyWindowSql(fy, dateCol, o.startDate);
  const companyFilter = o.companyIds?.length ? sql`AND d.company_id IN (${sql.join(o.companyIds.map((c) => sql`${c}`), sql`, `)})` : sql``;
  const res = await exec(db, sql`
    SELECT co.id, co.name, coalesce(nullif(co.vat_number, ''), co.bulstat) AS vat,
      SUM(CASE WHEN ${opening} THEN d.amount / ${factor} ELSE 0 END) AS od,
      SUM(CASE WHEN ${opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS oc,
      SUM(CASE WHEN NOT ${opening} THEN d.amount / ${factor} ELSE 0 END) AS dt,
      SUM(CASE WHEN NOT ${opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts ac ON ac.id = d.account_id JOIN companies co ON co.id = d.company_id
    WHERE ${yearFilter} AND ${dateCol} <= ${o.endDate} AND ${accountRuleSql(sql`ac.number`, o.accountNumber)}
      AND ac.account_category_id IN (${sql.join(COMPANY_CATEGORIES.map((c) => sql`${c}`), sql`, `)})
      AND NOT (a.is_initial_balance AND a.is_initial_correspondence) ${companyFilter}
    GROUP BY co.id, co.name, co.vat_number, co.bulstat ORDER BY co.name`);
  return (res.rows as { id: number; name: string; vat: string | null; od: string; oc: string; dt: string; ct: string }[]).map((r) => {
    const od = dec(r.od), oc = dec(r.oc), dt = dec(r.dt), ct = dec(r.ct);
    return {
      companyId: r.id, companyName: r.name, vat: r.vat ?? '',
      openingDebit: netDebit(od, oc).toFixed(2), openingCredit: netDebit(oc, od).toFixed(2),
      debitTurnover: dt.toFixed(2), creditTurnover: ct.toFixed(2),
      closingDebit: netDebit(od.plus(dt), oc.plus(ct)).toFixed(2), closingCredit: netDebit(oc.plus(ct), od.plus(dt)).toFixed(2),
    };
  }).filter((r) => o.showZeroRows || ![r.openingDebit, r.openingCredit, r.debitTurnover, r.creditTurnover].every((v) => v === '0.00'));
}

/** Individual chart of accounts report (spec 05 4.4). */
export async function chartReport(db: DbOrTx, year: number, subAccountLevel = 5, accountNumber = '') {
  const rows = await db.select({ number: s.accounts.number, description: s.accounts.description, englishDescription: s.accounts.englishDescription, level: s.accounts.level })
    .from(s.accounts).where(and(eq(s.accounts.isEuro, year >= 2026), sql`${s.accounts.level} BETWEEN 2 AND ${subAccountLevel + 2}`));
  return rows.filter((r) => matchesAccount(r.number, accountNumber)).sort((a, b) => compareAccountNumbers(a.number, b.number));
}

