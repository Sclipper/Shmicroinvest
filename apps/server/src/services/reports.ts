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

const netDebit = (d: Dec, c: Dec) => (d.minus(c).greaterThan(0) ? d.minus(c) : ZERO);

/** EUR report: legacy (pre-2026) amounts are divided by 1.95583. */
function conversionSql(endDate: string, dateCol: SQL) {
  const convert = endDate >= EURO_CHANGEOVER_DATE;
  return convert ? sql`CASE WHEN ${dateCol} < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(BGN_PER_EUR.toString())} ELSE 1 END` : sql`1`;
}

async function yearOf(db: DbOrTx, date: string) {
  const y = Number(date.slice(0, 4));
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
  return fy;
}

interface TreeAccount { id: number; parentId: number | null; number: string; description: string; englishDescription: string | null; level: number; isEuro: boolean; categoryId: number | null; currencyId: number; productId: number | null }

async function loadTree(db: DbOrTx) {
  const rows = await db.select({
    id: s.accounts.id, parentId: s.accounts.parentId, number: s.accounts.number, description: s.accounts.description,
    englishDescription: s.accounts.englishDescription, level: s.accounts.level, isEuro: s.accounts.isEuro,
    categoryId: s.accounts.accountCategoryId, currencyId: s.accounts.currencyId, productId: s.accounts.productId,
  }).from(s.accounts);
  return rows as TreeAccount[];
}

/** Map every account to the account of the report chart (same chart, else same number, else mapped). */
function chartMapper(all: TreeAccount[], isEuro: boolean) {
  const byId = new Map(all.map((a) => [a.id, a]));
  const reportByNumber = new Map(all.filter((a) => a.isEuro === isEuro).map((a) => [a.number, a]));
  return (id: number): TreeAccount | undefined => {
    const a = byId.get(id);
    if (!a) return undefined;
    if (a.isEuro === isEuro) return a;
    return reportByNumber.get(a.number) ?? a;
  };
}

function ancestorsOf(a: TreeAccount, byId: Map<number, TreeAccount>) {
  const out: TreeAccount[] = [];
  let p = a.parentId != null ? byId.get(a.parentId) : undefined;
  while (p && p.number !== '0') { out.push(p); p = p.parentId != null ? byId.get(p.parentId) : undefined; }
  return out;
}

export interface TrialBalanceOptions extends PeriodFilter {
  accountNumber?: string;
  /** 0 = synthetic, 1..5 analytical levels. */
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
  const yearFilter = fy ? sql`a.financial_year_id = ${fy.id}` : sql`${dateCol} >= ${o.startDate}`;
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
  const yearFilter = fy ? sql`a.financial_year_id = ${fy.id}` : sql`${dateCol} >= ${o.startDate}`;
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
      counters: counters.map((c) => ({ number: c.account.number, description: c.account.description, debit: c.dt.toFixed(2), credit: c.ct.toFixed(2) })),
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      balances: o.withBalances ? await accountBalances(db, g.account.number, o) : undefined,
    });
  }
  return out;
}

export interface JournalLineFilter extends PeriodFilter {
  debitAccount?: string;
  debitWithSub?: boolean;
  creditAccount?: string;
  creditWithSub?: boolean;
  account?: string;
  accountWithSub?: boolean;
  fromNumber?: string;
  toNumber?: string;
  documentTypeId?: number;
  documentNumber?: string;
  transactionTypeId?: number;
  vatTermId?: number;
  text?: string;
  limit?: number;
}

/** Pair-style rows: Sign = +1 legs (debit account / credit account / amount). */
export async function journalLines(db: DbOrTx, o: JournalLineFilter) {
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const conds: SQL[] = [sql`d.sign = 1`, sql`NOT a.is_initial_balance`, sql`${dateCol} >= ${o.startDate}`, sql`${dateCol} <= ${o.endDate}`];
  if (o.debitAccount) conds.push(accountRuleSql(sql`da.number`, o.debitAccount, o.debitWithSub ?? true));
  if (o.creditAccount) conds.push(accountRuleSql(sql`ca.number`, o.creditAccount, o.creditWithSub ?? true));
  if (o.account) conds.push(sql`(${accountRuleSql(sql`da.number`, o.account, o.accountWithSub ?? true)} OR ${accountRuleSql(sql`ca.number`, o.account, o.accountWithSub ?? true)})`);
  if (o.companyIds?.length) conds.push(sql`co.id IN (${sql.join(o.companyIds.map((c) => sql`${c}`), sql`, `)})`);
  if (o.fromNumber) conds.push(sql`a.number >= ${o.fromNumber}`);
  if (o.toNumber) conds.push(sql`a.number <= ${o.toNumber}`);
  if (o.documentTypeId) conds.push(sql`doc.document_type_id = ${o.documentTypeId}`);
  if (o.documentNumber) conds.push(sql`doc.number = ${o.documentNumber}`);
  if (o.transactionTypeId) conds.push(sql`a.transaction_type_id = ${o.transactionTypeId}`);
  if (o.vatTermId) conds.push(sql`d.vat_term_id = ${o.vatTermId}`);
  if (o.text) {
    const like = `%${o.text}%`;
    conds.push(sql`(a.number ILIKE ${like} OR t.description ILIKE ${like} OR r.description ILIKE ${like} OR doc.number ILIKE ${like} OR co.name ILIKE ${like} OR da.number ILIKE ${like} OR ca.number ILIKE ${like} OR CAST(d.amount AS text) LIKE ${like})`);
  }
  const res = await exec(db, sql`
    SELECT d.id AS detail_id, a.id AS accounting_id, a.number, a.accounting_date, a.vies_month,
      da.number AS debit_account, da.description AS debit_description,
      ca.number AS credit_account, ca.description AS credit_description,
      d.amount / ${factor} AS amount, d.currency_amount, d.exchange_rate, d.quantity, d.price,
      co.name AS company_name, coalesce(co.vat_number, co.bulstat) AS company_vat,
      dt.short_name AS document_type, doc.date AS document_date, doc.number AS document_number,
      t.description AS term, r.description AS reference, vt.id AS vat_term_id, vt.description AS vat_term, u.name AS user_name
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts da ON da.id = d.account_id
      JOIN accounts ca ON ca.id = d.ref_account_id
      LEFT JOIN companies co ON co.id = coalesce(d.company_id, (SELECT m.company_id FROM accounting_details m WHERE m.accounting_id = d.accounting_id AND m.sign = -1
        AND m.account_id = d.ref_account_id AND m.ref_account_id = d.account_id AND m.company_id IS NOT NULL LIMIT 1))
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN vat_terms vt ON vt.id = d.vat_term_id
      LEFT JOIN users u ON u.id = a.user_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.accounting_date, a.number, d.position
    LIMIT ${o.limit ?? 20000}`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    detailId: r.detail_id as number,
    accountingId: r.accounting_id as number,
    number: r.number as string,
    accountingDate: String(r.accounting_date).slice(0, 10),
    viesMonth: String(r.vies_month).slice(0, 10),
    debitAccount: r.debit_account as string,
    debitDescription: r.debit_description as string,
    creditAccount: r.credit_account as string,
    creditDescription: r.credit_description as string,
    amount: dec(r.amount as string).toFixed(2),
    currencyAmount: r.currency_amount as string | null,
    exchangeRate: r.exchange_rate as string | null,
    quantity: r.quantity as string | null,
    price: r.price as string | null,
    companyName: (r.company_name as string | null) ?? '',
    companyVat: (r.company_vat as string | null) ?? '',
    documentType: (r.document_type as string | null) ?? '',
    documentDate: r.document_date ? String(r.document_date).slice(0, 10) : '',
    documentNumber: (r.document_number as string | null) ?? '',
    term: (r.term as string | null) ?? '',
    reference: (r.reference as string | null) ?? '',
    vatTerm: r.vat_term ? `${r.vat_term_id} - ${r.vat_term}` : '',
    userName: (r.user_name as string | null) ?? '',
  }));
}

/**
 * Account card (Аналитичен регистър, spec 05 4.2). The running balance here
 * advances on every printed line, including sub-account lines (the original
 * only tracks the account itself and leaves sub-account lines blank).
 */
export async function analyticalRegister(db: DbOrTx, o: PeriodFilter & { accountNumber: string; withSub?: boolean; text?: string }) {
  const opening = await accountBalances(db, o.accountNumber, o, o.withSub ?? true);
  const lines = await journalLines(db, { ...o, account: o.accountNumber, accountWithSub: o.withSub ?? true });
  let bal = dec(opening.openingDebit).minus(dec(opening.openingCredit));
  const isMine = (n: string) => matchesAccount(n, o.accountNumber, o.withSub ?? true);
  let dt = ZERO, ct = ZERO;
  const out = lines.map((l) => {
    const amt = dec(l.amount);
    const debitSide = isMine(l.debitAccount);
    const creditSide = isMine(l.creditAccount);
    // A line between two sub-accounts of the same account moves nothing.
    if (debitSide && !creditSide) { bal = bal.plus(amt); dt = dt.plus(amt); }
    else if (creditSide && !debitSide) { bal = bal.minus(amt); ct = ct.plus(amt); }
    else { dt = dt.plus(amt); ct = ct.plus(amt); }
    return { ...l, balanceDebit: bal.greaterThan(0) ? bal.toFixed(2) : '0.00', balanceCredit: bal.lessThan(0) ? bal.negated().toFixed(2) : '0.00' };
  });
  const [acc] = await db.select({ description: s.accounts.description }).from(s.accounts).where(eq(s.accounts.number, o.accountNumber)).limit(1);
  return {
    accountDescription: acc?.description ?? '',
    opening,
    lines: o.text ? out.filter((l) => JSON.stringify(l).toLowerCase().includes(o.text!.toLowerCase())) : out,
    turnover: { debit: dt.toFixed(2), credit: ct.toFixed(2) },
    closing: { debit: bal.greaterThan(0) ? bal.toFixed(2) : '0.00', credit: bal.lessThan(0) ? bal.negated().toFixed(2) : '0.00' },
  };
}

/** Partner turnover (ОВ по партньори, spec 05 3.5 P). */
export async function partnerTurnover(db: DbOrTx, o: PeriodFilter & { accountNumber: string; showZeroRows?: boolean }) {
  const fy = await yearOf(db, o.startDate);
  const dateCol = o.byExportMonth ? sql`a.vies_month` : sql`a.accounting_date`;
  const factor = conversionSql(o.endDate, sql`a.accounting_date`);
  const opening = sql`(a.is_initial_balance OR ${dateCol} < ${o.startDate})`;
  const yearFilter = fy ? sql`a.financial_year_id = ${fy.id}` : sql`${dateCol} >= ${o.startDate}`;
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

