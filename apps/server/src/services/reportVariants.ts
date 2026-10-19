import { sql } from 'drizzle-orm';
import { EURO_CHANGEOVER_DATE, ZERO, dec, type Dec } from '@shmi/core';
import { exec, type DbOrTx } from '../db/provider.ts';
import { badRequest } from '../lib/errors.ts';
import {
  accountBalances, accountRuleSql, ancestorsOf, fyWindowSql, chartMapper, compareAccountNumbers, conversionSql, loadTree, matchesAccount, netDebit, trialBalance, yearOf,
  type LedgerOptions, type TreeAccount, type TrialBalanceOptions, type TrialBalanceRow,
} from './reports.ts';

/**
 * Trial-balance variants of spec 05 section 3.5 (foreign currency, materials,
 * by months), the free-text filter of 3.2 and the "accounts with balances
 * but zero turnover" option of the general ledger (4.1).
 */

type Sums = { od: Dec; oc: Dec; dt: Dec; ct: Dec };
const zero = (): Sums => ({ od: ZERO, oc: ZERO, dt: ZERO, ct: ZERO });
const plus = (a: Sums, b: Sums): Sums => ({ od: a.od.plus(b.od), oc: a.oc.plus(b.oc), dt: a.dt.plus(b.dt), ct: a.ct.plus(b.ct) });
const isZeroSums = (v: Sums) => v.od.minus(v.oc).isZero() && v.dt.isZero() && v.ct.isZero();

function netted(v: Sums) {
  return {
    openingDebit: netDebit(v.od, v.oc), openingCredit: netDebit(v.oc, v.od),
    debitTurnover: v.dt, creditTurnover: v.ct,
    closingDebit: netDebit(v.od.plus(v.dt), v.oc.plus(v.ct)), closingCredit: netDebit(v.oc.plus(v.ct), v.od.plus(v.dt)),
  };
}
const fixed = (n: ReturnType<typeof netted>, places = 2) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.toFixed(places)])) as Record<keyof ReturnType<typeof netted>, string>;

function postingWindow(fy: { id: number; startDate: string } | undefined, o: TrialBalanceOptions) {
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  return {
    dateCol,
    opening: sql`(a.is_initial_balance OR ${dateCol} < ${o.startDate})`,
    where: sql`${fyWindowSql(fy, dateCol, o.startDate)} AND ${dateCol} <= ${o.endDate}
      AND NOT (a.is_initial_balance AND a.is_initial_correspondence)
      ${o.companyIds?.length ? sql`AND d.company_id IN (${sql.join(o.companyIds.map((c) => sql`${c}`), sql`, `)})` : sql``}`,
  };
}

/** Report chart and the account set of a trial balance. */
async function chartContext(db: DbOrTx, o: TrialBalanceOptions) {
  const all = await loadTree(db);
  const isEuro = o.endDate >= EURO_CHANGEOVER_DATE;
  const byId = new Map(all.map((a) => [a.id, a]));
  const chart = all.filter((a) => a.isEuro === isEuro && a.number !== '0');
  const maxLevel = (o.subAccountLevel ?? 0) + 2;
  const listed = (a: TreeAccount) => a.level >= 2 && a.level <= maxLevel
    && (!o.accountNumber || matchesAccount(a.number, o.accountNumber))
    && !(o.withoutOffBalance && a.number.startsWith('9'));
  return { all, isEuro, byId, chart, maxLevel, mapTo: chartMapper(all, isEuro), listed, hasChildren: new Set(chart.map((a) => a.parentId)) };
}

export interface ExtendedRow extends TrialBalanceRow {
  isoCode: string;
  /** Currency amounts (FC) or quantities (MT) in the same six columns. */
  extra: Record<'openingDebit' | 'openingCredit' | 'debitTurnover' | 'creditTurnover' | 'closingDebit' | 'closingCredit', string> | null;
}

/**
 * Валутна (spTurnoverReportFC) and Материална (spTurnoverReportMT) trial
 * balance: the standard amounts plus currency amounts / quantities. FC lists
 * the foreign-currency accounts (national-currency accounts only as their
 * parents); MT lists the material accounts and their parents.
 */
export async function trialBalanceExtended(db: DbOrTx, o: TrialBalanceOptions & { family: 'currency' | 'quantity' }) {
  const fy = await yearOf(db, o.startDate);
  const w = postingWindow(fy, o);
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const col = o.family === 'currency' ? sql`d.currency_amount` : sql`d.quantity`;
  const res = await exec(db, sql`
    SELECT d.account_id,
      SUM(CASE WHEN ${w.opening} THEN d.amount / ${factor} ELSE 0 END) AS od,
      SUM(CASE WHEN ${w.opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS oc,
      SUM(CASE WHEN NOT ${w.opening} THEN d.amount / ${factor} ELSE 0 END) AS dt,
      SUM(CASE WHEN NOT ${w.opening} THEN d.ref_amount / ${factor} ELSE 0 END) AS ct,
      SUM(CASE WHEN ${w.opening} AND d.sign = 1 THEN coalesce(${col}, 0) ELSE 0 END) AS xod,
      SUM(CASE WHEN ${w.opening} AND d.sign = -1 THEN coalesce(${col}, 0) ELSE 0 END) AS xoc,
      SUM(CASE WHEN NOT ${w.opening} AND d.sign = 1 THEN coalesce(${col}, 0) ELSE 0 END) AS xdt,
      SUM(CASE WHEN NOT ${w.opening} AND d.sign = -1 THEN coalesce(${col}, 0) ELSE 0 END) AS xct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
    WHERE ${w.where}
    GROUP BY d.account_id`);
  const cx = await chartContext(db, o);
  const currencies = await exec(db, sql`SELECT id, iso_code FROM currencies`);
  const iso = new Map((currencies.rows as { id: number; iso_code: string }[]).map((c) => [c.id, c.iso_code]));
  const national = cx.isEuro ? 2 : 1;
  const isTracked = (a: TreeAccount) => (o.family === 'currency' ? a.currencyId !== national : a.productId != null);

  const base = new Map<number, Sums>();
  const extra = new Map<number, Sums>();
  const isoOf = new Map<number, Set<number>>();
  for (const r of res.rows as Record<string, string | number>[]) {
    const acc = cx.mapTo(r.account_id as number);
    if (!acc) continue;
    const b = { od: dec(r.od as string), oc: dec(r.oc as string), dt: dec(r.dt as string), ct: dec(r.ct as string) };
    const x = { od: dec(r.xod as string), oc: dec(r.xoc as string), dt: dec(r.xdt as string), ct: dec(r.xct as string) };
    for (const target of [acc, ...ancestorsOf(acc, cx.byId)]) {
      base.set(target.id, plus(base.get(target.id) ?? zero(), b));
      if (isTracked(acc)) {
        extra.set(target.id, plus(extra.get(target.id) ?? zero(), x));
        const set = isoOf.get(target.id) ?? new Set();
        set.add(acc.currencyId);
        isoOf.set(target.id, set);
      }
    }
  }
  // Accounts in the report: tracked accounts and the ancestors of tracked accounts.
  const trackedIds = new Set(cx.chart.filter(isTracked).map((a) => a.id));
  const withTracked = new Set<number>();
  for (const a of cx.chart) if (trackedIds.has(a.id)) {
    withTracked.add(a.id);
    for (const anc of ancestorsOf(a, cx.byId)) withTracked.add(anc.id);
  }
  const rows: ExtendedRow[] = [];
  for (const a of cx.chart) {
    if (!cx.listed(a) || !withTracked.has(a.id)) continue;
    const v = base.get(a.id) ?? zero();
    const x = extra.get(a.id) ?? zero();
    if (isZeroSums(v) && isZeroSums(x) && !o.showZeroRows) continue;
    const curSet = isoOf.get(a.id);
    const single = curSet && curSet.size === 1 ? [...curSet][0]! : null;
    // Mixed currencies under one parent cannot be summed: the parent shows base amounts only.
    const showExtra = o.family === 'quantity' || single != null || trackedIds.has(a.id);
    rows.push({
      accountId: a.id, number: a.number, description: a.description, englishDescription: a.englishDescription, level: a.level,
      hasChildren: cx.hasChildren.has(a.id) && a.level < cx.maxLevel,
      ...fixed(netted(v)),
      isoCode: o.family === 'currency' ? (single != null ? (iso.get(single) ?? '') : trackedIds.has(a.id) ? (iso.get(a.currencyId) ?? '') : '') : '',
      extra: showExtra ? fixed(netted(x), o.family === 'quantity' ? 3 : 2) : null,
    });
  }
  rows.sort((p, q) => compareAccountNumbers(p.number, q.number));
  return { rows, totals: totalsOf(rows, cx.byId) };
}

const AMOUNT_KEYS = ['openingDebit', 'openingCredit', 'debitTurnover', 'creditTurnover', 'closingDebit', 'closingCredit'] as const;

/** Totals over the rows that have no ancestor in the result (sub-rows are folded into their parents). */
function totalsOf(rows: TrialBalanceRow[], byId: Map<number, TreeAccount>) {
  const inResult = new Set(rows.map((r) => r.accountId));
  const top = rows.filter((r) => { const a = byId.get(r.accountId); return !a || !ancestorsOf(a, byId).some((anc) => inResult.has(anc.id)); });
  return Object.fromEntries(AMOUNT_KEYS.map((k) => [k, top.reduce((s, r) => s.plus(dec(r[k])), ZERO).toFixed(2)])) as Record<(typeof AMOUNT_KEYS)[number], string>;
}

/** Totals of filtered trial-balance rows: the rows without an ancestor among them. */
export async function trialTotals(db: DbOrTx, rows: TrialBalanceRow[]) {
  const all = await loadTree(db);
  return totalsOf(rows, new Map(all.map((a) => [a.id, a])));
}

export interface MonthRow {
  month: string;
  openingDebit: string; openingCredit: string;
  debitTurnover: string; creditTurnover: string;
  closingDebit: string; closingCredit: string;
}

/**
 * По периоди (spTurnoverReportM): per account the months that have postings;
 * month 1 opens with the account's opening balance, every later month with the
 * previous month's closing; quiet months produce no row.
 */
export async function trialBalanceByMonths(db: DbOrTx, o: TrialBalanceOptions) {
  const fy = await yearOf(db, o.startDate);
  const w = postingWindow(fy, o);
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const res = await exec(db, sql`
    SELECT d.account_id, CASE WHEN ${w.opening} THEN NULL ELSE to_char(${w.dateCol}, 'YYYY-MM') END AS m,
      SUM(d.amount / ${factor}) AS debit, SUM(d.ref_amount / ${factor}) AS credit
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
    WHERE ${w.where}
    GROUP BY 1, 2`);
  const cx = await chartContext(db, o);
  const opening = new Map<number, Sums>();
  const months = new Map<number, Map<string, Sums>>();
  for (const r of res.rows as { account_id: number; m: string | null; debit: string; credit: string }[]) {
    const acc = cx.mapTo(r.account_id);
    if (!acc) continue;
    for (const target of [acc, ...ancestorsOf(acc, cx.byId)]) {
      if (r.m === null) opening.set(target.id, plus(opening.get(target.id) ?? zero(), { od: dec(r.debit), oc: dec(r.credit), dt: ZERO, ct: ZERO }));
      else {
        const mm = months.get(target.id) ?? new Map<string, Sums>();
        mm.set(r.m, plus(mm.get(r.m) ?? zero(), { od: ZERO, oc: ZERO, dt: dec(r.debit), ct: dec(r.credit) }));
        months.set(target.id, mm);
      }
    }
  }
  const out: { accountId: number; number: string; description: string; englishDescription: string | null; level: number; months: MonthRow[] }[] = [];
  for (const a of cx.chart) {
    if (!cx.listed(a)) continue;
    const mm = months.get(a.id);
    if (!mm?.size && !o.showZeroRows) continue;
    const open = opening.get(a.id) ?? zero();
    let bal = open.od.minus(open.oc);
    const list: MonthRow[] = [];
    for (const key of [...(mm?.keys() ?? [])].sort()) {
      const t = mm!.get(key)!;
      const od = bal.greaterThan(0) ? bal : ZERO;
      const oc = bal.lessThan(0) ? bal.negated() : ZERO;
      bal = bal.plus(t.dt).minus(t.ct);
      list.push({
        month: `${key.slice(5, 7)}.${key.slice(0, 4)}`,
        openingDebit: od.toFixed(2), openingCredit: oc.toFixed(2),
        debitTurnover: t.dt.toFixed(2), creditTurnover: t.ct.toFixed(2),
        closingDebit: (bal.greaterThan(0) ? bal : ZERO).toFixed(2), closingCredit: (bal.lessThan(0) ? bal.negated() : ZERO).toFixed(2),
      });
    }
    out.push({ accountId: a.id, number: a.number, description: a.description, englishDescription: a.englishDescription, level: a.level, months: list });
  }
  return out.sort((p, q) => compareAccountNumbers(p.number, q.number));
}

/** "Филтър по" columns of the trial balance layouts (05 3.2, 3.8): standard, foreign currency, materials, partners. */
export const TRIAL_BALANCE_FILTER_COLUMNS = [
  'AccountNumber', 'AccountDescription', 'InitialDebitBalance', 'InitialCreditBalance', 'DebitTurnover', 'CreditTurnover', 'FinalDebitBalance', 'FinalCreditBalance', 'OptionalReference',
  'ISOCode', 'CurrencyInitialDebitBalance', 'CurrencyInitialCreditBalance', 'CurrencyDebitTurnover', 'CurrencyCreditTurnover', 'CurrencyFinalDebitBalance', 'CurrencyFinalCreditBalance',
  'MaterialInitialDebitBalance', 'MaterialInitialCreditBalance', 'MaterialDebitTurnover', 'MaterialCreditTurnover', 'MaterialFinalDebitBalance', 'MaterialFinalCreditBalance',
  'CompanyName',
] as const;
export type TrialBalanceFilterColumn = (typeof TRIAL_BALANCE_FILTER_COLUMNS)[number] | '';
type Column = Exclude<TrialBalanceFilterColumn, ''>;

const BASE_AMOUNTS = ['InitialDebitBalance', 'InitialCreditBalance', 'DebitTurnover', 'CreditTurnover', 'FinalDebitBalance', 'FinalCreditBalance'] as const;
const AMOUNT_OF: Record<(typeof BASE_AMOUNTS)[number], (typeof AMOUNT_KEYS)[number]> = {
  InitialDebitBalance: 'openingDebit', InitialCreditBalance: 'openingCredit', DebitTurnover: 'debitTurnover',
  CreditTurnover: 'creditTurnover', FinalDebitBalance: 'closingDebit', FinalCreditBalance: 'closingCredit',
};

/** Columns searched with "Всички" per layout (the combo's items after "Всички"). */
export const TRIAL_BALANCE_ANY_COLUMNS: Record<'standard' | 'currency' | 'quantity' | 'partners', Column[]> = {
  standard: ['AccountNumber', 'AccountDescription', ...BASE_AMOUNTS],
  currency: ['AccountNumber', 'AccountDescription', 'ISOCode', ...BASE_AMOUNTS.map((c) => `Currency${c}` as Column), ...BASE_AMOUNTS],
  quantity: ['AccountNumber', 'AccountDescription', ...BASE_AMOUNTS.map((c) => `Material${c}` as Column), ...BASE_AMOUNTS],
  partners: ['CompanyName', ...BASE_AMOUNTS],
};

type FilterableRow = Partial<Record<(typeof AMOUNT_KEYS)[number], string>> & {
  number?: string; description?: string; isoCode?: string; companyName?: string; optionalReference?: string;
  extra?: Partial<Record<(typeof AMOUNT_KEYS)[number], string>> | null;
};

function columnValue(r: FilterableRow, c: Column): string | undefined {
  switch (c) {
    case 'AccountNumber': return r.number;
    case 'AccountDescription': return r.description;
    case 'ISOCode': return r.isoCode;
    case 'CompanyName': return r.companyName;
    case 'OptionalReference': return r.optionalReference;
    default: {
      const base = c.replace(/^(Currency|Material)/, '') as (typeof BASE_AMOUNTS)[number];
      return c === base ? r[AMOUNT_OF[base]] : r.extra?.[AMOUNT_OF[base]];
    }
  }
}

/** "Филтър по" column of a trial-balance layout; 400 for a column the layout does not have. */
export function trialFilterColumn(v: string | undefined, layout: keyof typeof TRIAL_BALANCE_ANY_COLUMNS): TrialBalanceFilterColumn {
  const column = (v ?? '') as TrialBalanceFilterColumn;
  if (!column) return '';
  const allowed = layout === 'standard' ? [...TRIAL_BALANCE_ANY_COLUMNS.standard, 'OptionalReference'] : TRIAL_BALANCE_ANY_COLUMNS[layout];
  if (!TRIAL_BALANCE_FILTER_COLUMNS.includes(column as never) || !allowed.includes(column as never)) throw badRequest('Невалидна колона за филтър.');
  return column;
}

/**
 * Free-text filter of a trial-balance layout: LIKE '%x%' on the chosen
 * column, or on any column of the layout; amounts are matched as the text of
 * the stored decimal (a typed decimal comma counts as the point).
 */
export function filterTrialRows<R extends FilterableRow>(rows: R[], column: TrialBalanceFilterColumn, text: string | undefined, any: Column[]): R[] {
  const q = text?.trim().toLowerCase();
  if (!q) return rows;
  const numeric = q.replace(/\s/g, '').replace(',', '.');
  const cols = column ? [column] : any;
  return rows.filter((r) => cols.some((c) => {
    const v = columnValue(r, c);
    if (v === undefined || v === null) return false;
    const s = String(v).toLowerCase();
    return s.includes(q) || (/^-?[\d.]+$/.test(s) && s.includes(numeric));
  }));
}

/**
 * Standard trial balance with the free-text filter ("Филтър по" / "Филтър",
 * LIKE '%x%' on the chosen column or any column), "Търсене във всички нива
 * на сметкоплана" (description matches at any depth, returned with their
 * ancestors and descendants) and "Втора забележка" (OptionalReference: the
 * rows are split per matching optional reference, 05 3.3).
 */
export async function trialBalanceFiltered(db: DbOrTx, o: TrialBalanceOptions & { filterColumn?: TrialBalanceFilterColumn; filterText?: string; searchAllLevels?: boolean }) {
  const text = o.filterText?.trim().toLowerCase();
  if (!text) return trialBalance(db, o);
  const all = await loadTree(db);
  const byId = new Map(all.map((a) => [a.id, a]));
  const like = (v: string) => v.toLowerCase().includes(text);
  if (o.filterColumn === 'OptionalReference') {
    const refs = await exec(db, sql`
      SELECT DISTINCT r.id, r.description FROM accountings a JOIN reference_texts r ON r.id = a.optional_reference_id
      WHERE r.description ILIKE ${`%${o.filterText!.trim()}%`} AND a.accounting_date <= ${o.endDate}
      ORDER BY r.description`);
    const rows: (TrialBalanceRow & { optionalReference: string })[] = [];
    let totals = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, ZERO])) as Record<(typeof AMOUNT_KEYS)[number], Dec>;
    for (const ref of refs.rows as { id: number; description: string }[]) {
      const part = await trialBalance(db, { ...o, postingFilter: sql`a.optional_reference_id = ${ref.id}` });
      rows.push(...part.rows.map((r) => ({ ...r, optionalReference: ref.description })));
      totals = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, totals[k].plus(dec(part.totals[k]))])) as typeof totals;
    }
    rows.sort((p, q) => compareAccountNumbers(p.number, q.number) || (p.optionalReference < q.optionalReference ? -1 : p.optionalReference > q.optionalReference ? 1 : 0));
    return { rows, totals: Object.fromEntries(AMOUNT_KEYS.map((k) => [k, totals[k].toFixed(2)])) as Record<(typeof AMOUNT_KEYS)[number], string> };
  }
  if (o.searchAllLevels && o.filterColumn === 'AccountDescription') {
    const full = await trialBalance(db, { ...o, subAccountLevel: 5 });
    const hits = full.rows.filter((r) => like(r.description));
    const keep = new Set<number>();
    for (const h of hits) {
      keep.add(h.accountId);
      for (const anc of ancestorsOf(byId.get(h.accountId)!, byId)) keep.add(anc.id);
      for (const r of full.rows) if (ancestorsOf(byId.get(r.accountId)!, byId).some((x) => x.id === h.accountId)) keep.add(r.accountId);
    }
    const rows = full.rows.filter((r) => keep.has(r.accountId));
    return { rows, totals: totalsOf(rows, byId) };
  }
  const base = await trialBalance(db, o);
  const rows = filterTrialRows(base.rows, o.filterColumn ?? '', o.filterText, TRIAL_BALANCE_ANY_COLUMNS.standard);
  return { rows, totals: totalsOf(rows, byId) };
}

/**
 * General ledger "Включване на сметки със салда и с нулеви обороти": adds the
 * accounts that have an opening balance in the financial year but no turnover
 * in the period, each with its balances (spBalancesReport).
 */
export async function ledgerZeroTurnoverAccounts(db: DbOrTx, o: LedgerOptions, present: Set<string>) {
  const fy = await yearOf(db, o.startDate);
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const accFilter = o.accountNumber ? accountRuleSql(sql`ac.number`, o.accountNumber) : sql`true`;
  const res = await exec(db, sql`
    SELECT DISTINCT d.account_id FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE ${fyWindowSql(fy, dateCol, o.startDate)} AND ${dateCol} <= ${o.endDate}
      AND (a.is_initial_balance OR ${dateCol} < ${o.startDate}) AND NOT (a.is_initial_balance AND a.is_initial_correspondence) AND ${accFilter}`);
  const all = await loadTree(db);
  const byId = new Map(all.map((a) => [a.id, a]));
  const maxLevel = (o.subAccountLevel ?? 0) + 2;
  const found = new Map<string, TreeAccount>();
  for (const r of res.rows as { account_id: number }[]) {
    let a = byId.get(r.account_id);
    while (a && a.level > maxLevel && a.parentId != null) a = byId.get(a.parentId);
    if (a && !present.has(a.number)) found.set(a.number, a);
  }
  const out = [];
  for (const a of [...found.values()].sort((p, q) => compareAccountNumbers(p.number, q.number))) {
    const balances = await accountBalances(db, a.number, o);
    if ([balances.openingDebit, balances.openingCredit].every((v) => v === '0.00')) continue;
    out.push({ number: a.number, description: a.description, englishDescription: a.englishDescription ?? '', counters: [] as { number: string; description: string; englishDescription: string; debit: string; credit: string }[], totalDebit: '0.00', totalCredit: '0.00', balances });
  }
  return out;
}
