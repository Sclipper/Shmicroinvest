import { sql, type SQL } from 'drizzle-orm';
import { CLIENT_CATEGORIES, COMPANY_CATEGORIES, SUPPLIER_CATEGORIES, dec, type Dec } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, queryRowsBulk, type DbOrTx } from '../db/provider.ts';
import { accountRuleSql } from './reports.ts';

/**
 * Open items of partner accounts (GetCompanyLiabilities / fPartnersDocumentsDebt,
 * spec 05 6.3, 01b 6.4 part B, 02a 10).
 *
 * One item per (accounting, account, partner). The booked amount
 * A = SUM((Amount + RefAmount) * Sign) (debit positive) is adjusted by the
 * payment allocations (accounting_payment_details):
 *   open = A + k * covered - k * used
 * where `covered` = allocations in which this accounting is the liability
 * (RefAccounting) and `used` = allocations in which it is the payment
 * (PaymentAccounting); k = +1 for payable (supplier-like) accounts, -1 for
 * receivable (client-like) accounts. Allocations are matched on the same
 * account and partner, and only count when the other side of the allocation
 * is dated inside the window.
 *
 * Kind: on a client account a debit open amount is a liability (receivable)
 * and a credit one a payment; on a supplier account the other way round.
 */

export type OpenItemKind = 'liability' | 'payment' | 'none';
export type PartnerSide = 'client' | 'supplier';

export interface OpenItemFilter {
  /** Inclusive window of the bookings (and of the other side of every allocation). */
  startDate: string;
  endDate: string;
  /** Restrict bookings to one financial year (the active year for F3 / documents closing). */
  financialYearId?: number;
  /** Account-number rule of reports (05 2.5, with sub-accounts). */
  accountNumber?: string;
  accountIds?: number[];
  companyIds?: number[];
  /** Partner-name pattern (case-insensitive substring). */
  companyName?: string;
  documentTypeId?: number;
  /** Document-number prefix. */
  documentNumber?: string;
  /** Optional-reference prefix. */
  optionalReference?: string;
  /** Chart: true = EUR chart, false = BGN chart; default by the period (EUR only when both dates >= 2026). */
  isEuro?: boolean;
  /** Keep items whose open amount is zero. */
  showClosed?: boolean;
  /** Only liabilities / only payments. */
  kind?: Exclude<OpenItemKind, 'none'>;
  /** Restrict to some accountings. */
  accountingIds?: number[];
}

export interface OpenItem {
  accountingId: number;
  accountingNumber: string;
  accountingDate: string;
  isInitialBalance: boolean;
  accountId: number;
  accountNumber: string;
  accountDescription: string;
  categoryId: number;
  side: PartnerSide;
  /** +1 payable, -1 receivable. */
  k: 1 | -1;
  currencyId: number;
  currencyIso: string;
  companyId: number;
  companyName: string;
  companyBulstat: string;
  companyDueDays: number;
  documentId: number | null;
  documentTypeId: number | null;
  documentTypeName: string;
  documentTypeShortName: string;
  documentTypePosition: number;
  documentNumber: string;
  documentDate: string;
  /** Entry due date, else document date + the partner's due days. */
  dueDate: string;
  term: string;
  reference: string;
  optionalReference: string;
  /** Signed, debit positive. */
  booked: string;
  bookedCurrency: string;
  covered: string;
  coveredCurrency: string;
  used: string;
  usedCurrency: string;
  /** Signed, debit positive. */
  open: string;
  openCurrency: string;
  /** |open| and |openCurrency| */
  openAbs: string;
  openCurrencyAbs: string;
  /** Exchange rate of the booking (|booked| / |bookedCurrency|), 0 for base-currency accounts. */
  exchangeRate: string;
  kind: OpenItemKind;
}

const inList = (ids: readonly number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

export const isEuroPeriod = (start: string, end: string) => start >= '2026-01-01' && end >= '2026-01-01';

export function sideOfCategory(categoryId: number | null | undefined): PartnerSide | null {
  if (categoryId == null) return null;
  if ((CLIENT_CATEGORIES as readonly number[]).includes(categoryId)) return 'client';
  if ((SUPPLIER_CATEGORIES as readonly number[]).includes(categoryId)) return 'supplier';
  return null;
}

/** AccountBalanceHelper.IsLiability / IsPayment (02a 10). */
export function kindOf(side: PartnerSide, open: Dec): OpenItemKind {
  if (open.isZero()) return 'none';
  if (side === 'client') return open.greaterThan(0) ? 'liability' : 'payment';
  return open.lessThan(0) ? 'liability' : 'payment';
}

const iso = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

/**
 * The shared part of the open-item queries: the CTEs (lines = booked amount per
 * item, covered / used = its allocations), the joins of an item row and the
 * conditions on the joined document / partner.
 */
async function openItemsCte(db: DbOrTx, f: OpenItemFilter): Promise<SQL> {
  const isEuro = f.isEuro ?? isEuroPeriod(f.startDate, f.endDate);
  // The partner accounts first, as constants: the planner then knows how many legs they have
  // (a join on the category made it expect a few and look every entry up one by one).
  const accConds: SQL[] = [sql`ac.account_category_id IN (${inList([...CLIENT_CATEGORIES, ...SUPPLIER_CATEGORIES])})`, sql`ac.is_euro = ${isEuro}`];
  if (f.accountNumber) accConds.push(accountRuleSql(sql`ac.number`, f.accountNumber));
  if (f.accountIds?.length) accConds.push(sql`ac.id IN (${inList(f.accountIds)})`);
  const accountIds = (await queryRows<{ id: number }>(db, sql`SELECT ac.id FROM accounts ac WHERE ${sql.join(accConds, sql` AND `)} ORDER BY ac.id`)).map((r) => r.id);
  const conds: SQL[] = [
    sql`d.company_id IS NOT NULL`,
    accountIds.length ? sql`d.account_id IN (${inList(accountIds)})` : sql`false`,
    sql`a.accounting_date >= ${f.startDate}`,
    sql`a.accounting_date <= ${f.endDate}`,
  ];
  if (f.financialYearId) conds.push(sql`a.financial_year_id = ${f.financialYearId}`);
  if (f.companyIds?.length) conds.push(sql`d.company_id IN (${inList(f.companyIds)})`);
  if (f.accountingIds?.length) conds.push(sql`d.accounting_id IN (${inList(f.accountingIds)})`);
  const docConds: SQL[] = [];
  if (f.companyName) docConds.push(sql`co.name ILIKE ${'%' + f.companyName + '%'}`);
  if (f.documentTypeId) docConds.push(sql`doc.document_type_id = ${f.documentTypeId}`);
  if (f.documentNumber) docConds.push(sql`doc.number ILIKE ${f.documentNumber + '%'}`);
  if (f.optionalReference) docConds.push(sql`opt.description ILIKE ${f.optionalReference + '%'}`);
  const window = sql`BETWEEN ${f.startDate} AND ${f.endDate}`;
  // Allocations of the selected items only when the items are a few (a partner's, an entry's);
  // for a whole period the window alone is cheaper.
  const narrow = Boolean(f.companyIds?.length || f.accountingIds?.length || f.accountIds?.length);
  const only = (col: SQL) => (narrow ? sql`AND ${col} IN (SELECT accounting_id FROM lines)` : sql``);
  // lines carries the entry and account columns (grouped by their keys), so the item query does
  // not look every entry and account up again.
  const ctes = sql`
    WITH lines AS (
      SELECT a.id AS accounting_id, ac.id AS account_id, d.company_id,
        SUM((d.amount + d.ref_amount) * d.sign) AS booked,
        SUM(coalesce(d.currency_amount, 0) * d.sign) AS booked_cur,
        a.number AS accounting_number, a.accounting_date, a.is_initial_balance, a.due_date,
        a.document_id, a.term_id, a.reference_id, a.optional_reference_id,
        ac.number AS account_number, ac.description AS account_description, ac.account_category_id, ac.currency_id
      FROM accounting_details d
        JOIN accountings a ON a.id = d.accounting_id
        JOIN accounts ac ON ac.id = d.account_id
      WHERE ${sql.join(conds, sql` AND `)}
      GROUP BY a.id, ac.id, d.company_id
    ),
    covered AS (
      SELECT p.ref_accounting_id AS accounting_id, p.account_id, p.company_id,
        SUM(p.amount) AS amt, SUM(p.currency_amount) AS cur
      FROM accounting_payment_details p JOIN accountings pa ON pa.id = p.payment_accounting_id
      WHERE pa.accounting_date ${window} ${only(sql`p.ref_accounting_id`)}
      GROUP BY p.ref_accounting_id, p.account_id, p.company_id
    ),
    used AS (
      SELECT p.payment_accounting_id AS accounting_id, p.account_id, p.company_id,
        SUM(p.amount) AS amt, SUM(p.currency_amount) AS cur
      FROM accounting_payment_details p JOIN accountings ra ON ra.id = p.ref_accounting_id
      WHERE ra.accounting_date ${window} ${only(sql`p.payment_accounting_id`)}
      GROUP BY p.payment_accounting_id, p.account_id, p.company_id
    )`;
  const client = sql`l.account_category_id IN (${inList(CLIENT_CATEGORIES)})`;
  // k = -1 receivable (a client category wins, like sideOfCategory), +1 payable.
  const k = sql`(CASE WHEN ${client} THEN -1 ELSE 1 END)`;
  // (The accounts are all client or supplier ones already: the condition again here would be
  // pushed into lines and multiply the estimate down to a few rows.)
  const itemConds: SQL[] = [...docConds, sql`true`];
  // items: one row per open item with its open amounts (rounded to cents for the closed / kind rules).
  return sql`${ctes},
    items AS (
      SELECT l.*, ${client} AS is_client,
        coalesce(cv.amt, 0) AS covered, coalesce(cv.cur, 0) AS covered_cur,
        coalesce(us.amt, 0) AS used, coalesce(us.cur, 0) AS used_cur,
        l.booked + ${k} * coalesce(cv.amt, 0) - ${k} * coalesce(us.amt, 0) AS open_raw,
        l.booked_cur + ${k} * coalesce(cv.cur, 0) - ${k} * coalesce(us.cur, 0) AS open_cur_raw,
        round(l.booked + ${k} * coalesce(cv.amt, 0) - ${k} * coalesce(us.amt, 0), 2) AS open2,
        round(l.booked_cur + ${k} * coalesce(cv.cur, 0) - ${k} * coalesce(us.cur, 0), 2) AS open_cur2,
        cur.iso_code AS currency_iso,
        co.name AS company_name, coalesce(nullif(co.bulstat, ''), co.vat_number, '') AS company_bulstat, co.due_days,
        doc.document_type_id, doc.number AS document_number, doc.date AS document_date,
        dt.name AS document_type_name, dt.short_name AS document_type_short_name, dt.position AS document_type_position,
        t.description AS term, r.description AS reference, opt.description AS optional_reference
      FROM lines l
        JOIN companies co ON co.id = l.company_id
        LEFT JOIN currencies cur ON cur.id = l.currency_id
        LEFT JOIN covered cv ON cv.accounting_id = l.accounting_id AND cv.account_id = l.account_id AND coalesce(cv.company_id, l.company_id) = l.company_id
        LEFT JOIN used us ON us.accounting_id = l.accounting_id AND us.account_id = l.account_id AND coalesce(us.company_id, l.company_id) = l.company_id
        LEFT JOIN documents doc ON doc.id = l.document_id
        LEFT JOIN document_types dt ON dt.id = doc.document_type_id
        LEFT JOIN terms t ON t.id = l.term_id
        LEFT JOIN reference_texts r ON r.id = l.reference_id
        LEFT JOIN reference_texts opt ON opt.id = l.optional_reference_id
      WHERE ${sql.join(itemConds, sql` AND `)}
    )`;
}

/** Item conditions of the closed-item rule (both open amounts zero in cents) and of the kind. */
function openRuleConds(f: { showClosed?: boolean; kind?: OpenItemKind }): SQL[] {
  const conds: SQL[] = [];
  if (!f.showClosed) conds.push(sql`NOT (open2 = 0 AND open_cur2 = 0)`);
  // kindOf: on a client account a debit open amount is a liability, on a supplier account a credit one.
  if (f.kind === 'liability') conds.push(sql`open2 <> 0 AND (open2 > 0) = is_client`);
  if (f.kind === 'payment') conds.push(sql`open2 <> 0 AND (open2 > 0) <> is_client`);
  return conds;
}
const whereAll = (conds: SQL[]) => (conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``);
/** Decimal#toFixed(2) in SQL (half away from zero; a negative amount that rounds to zero keeps its sign). */
const fixed2 = (x: SQL) => sql`(CASE WHEN ${x} < 0 AND round(${x}, 2) = 0 THEN '-0.00' ELSE round(${x}, 2)::text END)`;

export async function openItems(db: DbOrTx, f: OpenItemFilter): Promise<OpenItem[]> {
  // A partner's or an entry's items are a few rows; a period's can be tens of thousands.
  const few = Boolean(f.companyIds?.length || f.accountingIds?.length || f.accountIds?.length);
  const rows = await (few ? queryRows : queryRowsBulk)<Record<string, unknown>>(db, sql`
    ${await openItemsCte(db, f)}
    SELECT accounting_id, account_id, company_id,
      -- The amounts as the 2-decimal strings of the item, computed here (tens of thousands of rows).
      ${fixed2(sql`booked`)} AS booked, ${fixed2(sql`booked_cur`)} AS booked_cur, ${fixed2(sql`covered`)} AS covered, ${fixed2(sql`covered_cur`)} AS covered_cur,
      ${fixed2(sql`used`)} AS used, ${fixed2(sql`used_cur`)} AS used_cur, ${fixed2(sql`open_raw`)} AS open, ${fixed2(sql`open_cur_raw`)} AS open_cur,
      round(abs(open_raw), 2)::text AS open_abs, round(abs(open_cur_raw), 2)::text AS open_cur_abs,
      CASE WHEN booked_cur <> 0 THEN booked END AS rate_booked, CASE WHEN booked_cur <> 0 THEN booked_cur END AS rate_booked_cur,
      accounting_number, accounting_date, is_initial_balance,
      account_number, account_description, account_category_id, currency_id, currency_iso,
      company_name, company_bulstat, coalesce(due_days, 0) AS due_days,
      document_id, document_type_id, document_number,
      coalesce(document_date, accounting_date)::text AS document_date,
      coalesce(due_date, coalesce(document_date, accounting_date) + coalesce(due_days, 0))::text AS due_date,
      document_type_name, document_type_short_name, document_type_position,
      term, reference, optional_reference
    FROM items
    ${whereAll(openRuleConds(f))}
    ORDER BY accounting_date, accounting_number, accounting_id, account_number`);

  const out: OpenItem[] = [];
  for (const r of rows) {
    const categoryId = r.account_category_id as number;
    const side = sideOfCategory(categoryId);
    if (!side) continue;
    const k: 1 | -1 = side === 'supplier' ? 1 : -1;
    const open = r.open as string;
    // kindOf on the open amount in cents (the closed and kind rules are applied in the query).
    const kind: OpenItemKind = open === '0.00' || open === '-0.00' ? 'none' : (open[0] !== '-') === (side === 'client') ? 'liability' : 'payment';
    const rateCur = r.rate_booked_cur as string | null;
    out.push({
      accountingId: r.accounting_id as number,
      accountingNumber: (r.accounting_number as string) ?? '',
      accountingDate: iso(r.accounting_date),
      isInitialBalance: Boolean(r.is_initial_balance),
      accountId: r.account_id as number,
      accountNumber: r.account_number as string,
      accountDescription: r.account_description as string,
      categoryId,
      side,
      k,
      currencyId: r.currency_id as number,
      currencyIso: (r.currency_iso as string) ?? '',
      companyId: r.company_id as number,
      companyName: r.company_name as string,
      companyBulstat: (r.company_bulstat as string) ?? '',
      companyDueDays: Number(r.due_days),
      documentId: (r.document_id as number | null) ?? null,
      documentTypeId: (r.document_type_id as number | null) ?? null,
      documentTypeName: (r.document_type_name as string | null) ?? '',
      documentTypeShortName: (r.document_type_short_name as string | null) ?? '',
      documentTypePosition: Number(r.document_type_position ?? 0),
      documentNumber: (r.document_number as string | null) ?? '',
      documentDate: r.document_date as string,
      dueDate: r.due_date as string,
      term: (r.term as string | null) ?? '',
      reference: (r.reference as string | null) ?? '',
      optionalReference: (r.optional_reference as string | null) ?? '',
      booked: r.booked as string,
      bookedCurrency: r.booked_cur as string,
      covered: r.covered as string,
      coveredCurrency: r.covered_cur as string,
      used: r.used as string,
      usedCurrency: r.used_cur as string,
      open,
      openCurrency: r.open_cur as string,
      openAbs: r.open_abs as string,
      openCurrencyAbs: r.open_cur_abs as string,
      exchangeRate: rateCur == null ? '0' : dec(r.rate_booked as string).abs().div(dec(rateCur).abs()).toDecimalPlaces(6).toString(),
      kind,
    });
  }
  return out;
}

export interface OpenItemPartnerTotal {
  companyId: number;
  companyName: string;
  companyBulstat: string;
  /** Σ open (debit positive) and Σ open currency of the partner's items. */
  balance: string;
  currencyBalance: string;
  /** Open items by kind. */
  liabilities: number;
  payments: number;
}

/**
 * openItems summed per partner in SQL (the F3 partner list): the same items,
 * open amounts, closed-item rule and kinds as openItems, without reading every
 * item. `side` keeps the items of one side; `excludeCurrencyId` drops the items
 * of accounts in that currency. Partners come in the order of their first item.
 */
export async function openItemPartnerTotals(db: DbOrTx, f: Omit<OpenItemFilter, 'kind'> & { side?: PartnerSide; excludeCurrencyId?: number }): Promise<OpenItemPartnerTotal[]> {
  const conds = openRuleConds(f);
  if (f.side === 'client') conds.push(sql`is_client`);
  if (f.side === 'supplier') conds.push(sql`NOT is_client`);
  if (f.excludeCurrencyId != null) conds.push(sql`currency_id IS DISTINCT FROM ${f.excludeCurrencyId}`);
  const rows = await queryRows<{ company_id: number; company_name: string; company_bulstat: string | null; balance: string; currency_balance: string; liabilities: number; payments: number }>(db, sql`
    ${await openItemsCte(db, f)}
    SELECT company_id, company_name, company_bulstat,
      SUM(booked + (CASE WHEN is_client THEN -1 ELSE 1 END) * (covered - used)) AS balance,
      SUM(booked_cur + (CASE WHEN is_client THEN -1 ELSE 1 END) * (covered_cur - used_cur)) AS currency_balance,
      (count(*) FILTER (WHERE open2 <> 0 AND (open2 > 0) = is_client))::int AS liabilities,
      (count(*) FILTER (WHERE open2 <> 0 AND (open2 > 0) <> is_client))::int AS payments
    FROM items
    ${whereAll(conds)}
    GROUP BY company_id, company_name, company_bulstat
    -- partners in the order of their first item (the item order of openItems)
    ORDER BY min(ARRAY[accounting_date::text, accounting_number::text, lpad(accounting_id::text, 12, '0'), account_number::text])`);
  return rows.map((r) => ({
    companyId: r.company_id, companyName: r.company_name, companyBulstat: r.company_bulstat ?? '',
    balance: dec(r.balance).toFixed(2), currencyBalance: dec(r.currency_balance).toFixed(2), liabilities: r.liabilities, payments: r.payments,
  }));
}

export interface PaymentLinkInput {
  /** The paying accounting (PaymentAccounting). */
  paymentAccountingId: number;
  /** The liability accounting (RefAccounting). */
  refAccountingId: number;
  /** Document of the payment entry. */
  documentId: number | null;
  /** Partner account (the payment entry's account). */
  accountId: number;
  companyId: number | null;
  amount: string;
  currencyAmount?: string;
}

/** Writes allocation rows (AccountingPaymentDetail). Amounts are positive. */
export async function insertPaymentLinks(db: DbOrTx, links: PaymentLinkInput[]) {
  const rows = links.filter((l) => !dec(l.amount).isZero() || !dec(l.currencyAmount ?? 0).isZero());
  if (!rows.length) return [];
  return db.insert(s.accountingPaymentDetails).values(rows.map((l) => ({
    paymentAccountingId: l.paymentAccountingId,
    refAccountingId: l.refAccountingId,
    documentId: l.documentId,
    accountId: l.accountId,
    companyId: l.companyId,
    amount: dec(l.amount).abs().toFixed(2),
    currencyAmount: dec(l.currencyAmount ?? 0).abs().toFixed(2),
  }))).returning();
}
