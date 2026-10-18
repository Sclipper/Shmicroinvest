import { sql, type SQL } from 'drizzle-orm';
import { CLIENT_CATEGORIES, COMPANY_CATEGORIES, SUPPLIER_CATEGORIES, dec, type Dec } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
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

function addDaysIso(date: string, days: number) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const iso = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');

export async function openItems(db: DbOrTx, f: OpenItemFilter): Promise<OpenItem[]> {
  const isEuro = f.isEuro ?? isEuroPeriod(f.startDate, f.endDate);
  const conds: SQL[] = [
    sql`d.company_id IS NOT NULL`,
    sql`ac.account_category_id IN (${inList(COMPANY_CATEGORIES)})`,
    sql`ac.is_euro = ${isEuro}`,
    sql`a.accounting_date >= ${f.startDate}`,
    sql`a.accounting_date <= ${f.endDate}`,
  ];
  if (f.financialYearId) conds.push(sql`a.financial_year_id = ${f.financialYearId}`);
  if (f.accountNumber) conds.push(accountRuleSql(sql`ac.number`, f.accountNumber));
  if (f.accountIds?.length) conds.push(sql`d.account_id IN (${inList(f.accountIds)})`);
  if (f.companyIds?.length) conds.push(sql`d.company_id IN (${inList(f.companyIds)})`);
  if (f.accountingIds?.length) conds.push(sql`d.accounting_id IN (${inList(f.accountingIds)})`);
  const docConds: SQL[] = [];
  if (f.companyName) docConds.push(sql`co.name ILIKE ${'%' + f.companyName + '%'}`);
  if (f.documentTypeId) docConds.push(sql`doc.document_type_id = ${f.documentTypeId}`);
  if (f.documentNumber) docConds.push(sql`doc.number ILIKE ${f.documentNumber + '%'}`);
  if (f.optionalReference) docConds.push(sql`opt.description ILIKE ${f.optionalReference + '%'}`);
  const window = sql`BETWEEN ${f.startDate} AND ${f.endDate}`;

  const rows = await queryRows<Record<string, unknown>>(db, sql`
    WITH lines AS (
      SELECT d.accounting_id, d.account_id, d.company_id,
        SUM((d.amount + d.ref_amount) * d.sign) AS booked,
        SUM(coalesce(d.currency_amount, 0) * d.sign) AS booked_cur
      FROM accounting_details d
        JOIN accountings a ON a.id = d.accounting_id
        JOIN accounts ac ON ac.id = d.account_id
      WHERE ${sql.join(conds, sql` AND `)}
      GROUP BY d.accounting_id, d.account_id, d.company_id
    ),
    covered AS (
      SELECT p.ref_accounting_id AS accounting_id, p.account_id, p.company_id,
        SUM(p.amount) AS amt, SUM(p.currency_amount) AS cur
      FROM accounting_payment_details p JOIN accountings pa ON pa.id = p.payment_accounting_id
      WHERE pa.accounting_date ${window}
      GROUP BY p.ref_accounting_id, p.account_id, p.company_id
    ),
    used AS (
      SELECT p.payment_accounting_id AS accounting_id, p.account_id, p.company_id,
        SUM(p.amount) AS amt, SUM(p.currency_amount) AS cur
      FROM accounting_payment_details p JOIN accountings ra ON ra.id = p.ref_accounting_id
      WHERE ra.accounting_date ${window}
      GROUP BY p.payment_accounting_id, p.account_id, p.company_id
    )
    SELECT l.accounting_id, l.account_id, l.company_id, l.booked, l.booked_cur,
      coalesce(cv.amt, 0) AS covered, coalesce(cv.cur, 0) AS covered_cur,
      coalesce(us.amt, 0) AS used, coalesce(us.cur, 0) AS used_cur,
      a.number AS accounting_number, a.accounting_date, a.is_initial_balance, a.due_date,
      ac.number AS account_number, ac.description AS account_description, ac.account_category_id, ac.currency_id,
      cur.iso_code AS currency_iso,
      co.name AS company_name, coalesce(nullif(co.bulstat, ''), co.vat_number, '') AS company_bulstat, co.due_days,
      doc.id AS document_id, doc.document_type_id, doc.number AS document_number, doc.date AS document_date,
      dt.name AS document_type_name, dt.short_name AS document_type_short_name, dt.position AS document_type_position,
      t.description AS term, r.description AS reference, opt.description AS optional_reference
    FROM lines l
      JOIN accountings a ON a.id = l.accounting_id
      JOIN accounts ac ON ac.id = l.account_id
      JOIN companies co ON co.id = l.company_id
      LEFT JOIN currencies cur ON cur.id = ac.currency_id
      LEFT JOIN covered cv ON cv.accounting_id = l.accounting_id AND cv.account_id = l.account_id AND coalesce(cv.company_id, l.company_id) = l.company_id
      LEFT JOIN used us ON us.accounting_id = l.accounting_id AND us.account_id = l.account_id AND coalesce(us.company_id, l.company_id) = l.company_id
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN reference_texts opt ON opt.id = a.optional_reference_id
    ${docConds.length ? sql`WHERE ${sql.join(docConds, sql` AND `)}` : sql``}
    ORDER BY a.accounting_date, a.number, a.id, ac.number`);

  const out: OpenItem[] = [];
  for (const r of rows) {
    const categoryId = r.account_category_id as number;
    const side = sideOfCategory(categoryId);
    if (!side) continue;
    const k: 1 | -1 = side === 'supplier' ? 1 : -1;
    const booked = dec(r.booked as string), bookedCur = dec(r.booked_cur as string);
    const covered = dec(r.covered as string), coveredCur = dec(r.covered_cur as string);
    const used = dec(r.used as string), usedCur = dec(r.used_cur as string);
    const open = booked.plus(covered.times(k)).minus(used.times(k));
    const openCur = bookedCur.plus(coveredCur.times(k)).minus(usedCur.times(k));
    const kind = kindOf(side, open.toDecimalPlaces(2));
    if (!f.showClosed && open.toDecimalPlaces(2).isZero() && openCur.toDecimalPlaces(2).isZero()) continue;
    if (f.kind && kind !== f.kind) continue;
    const documentDate = iso(r.document_date) || iso(r.accounting_date);
    const dueDays = Number(r.due_days ?? 0);
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
      companyDueDays: dueDays,
      documentId: (r.document_id as number | null) ?? null,
      documentTypeId: (r.document_type_id as number | null) ?? null,
      documentTypeName: (r.document_type_name as string | null) ?? '',
      documentTypeShortName: (r.document_type_short_name as string | null) ?? '',
      documentTypePosition: Number(r.document_type_position ?? 0),
      documentNumber: (r.document_number as string | null) ?? '',
      documentDate,
      dueDate: iso(r.due_date) || addDaysIso(documentDate, dueDays),
      term: (r.term as string | null) ?? '',
      reference: (r.reference as string | null) ?? '',
      optionalReference: (r.optional_reference as string | null) ?? '',
      booked: booked.toFixed(2),
      bookedCurrency: bookedCur.toFixed(2),
      covered: covered.toFixed(2),
      coveredCurrency: coveredCur.toFixed(2),
      used: used.toFixed(2),
      usedCurrency: usedCur.toFixed(2),
      open: open.toFixed(2),
      openCurrency: openCur.toFixed(2),
      openAbs: open.abs().toFixed(2),
      openCurrencyAbs: openCur.abs().toFixed(2),
      exchangeRate: bookedCur.isZero() ? '0' : booked.abs().div(bookedCur.abs()).toDecimalPlaces(6).toString(),
      kind,
    });
  }
  return out;
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
