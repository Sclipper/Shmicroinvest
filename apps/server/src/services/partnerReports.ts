import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  BGN_PER_EUR, COMPANY_CATEGORIES, EURO_CHANGEOVER_DATE, daysBetweenDates, dec, isOverdue, matchesColumnFilter,
  movementLineDirection, overdueDaysText, ZERO, type Dec,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import { ApiError } from '../lib/errors.ts';
import { accountBalances, accountRuleSql } from './reports.ts';
import { openItems, type OpenItem } from './openItems.ts';

/**
 * Partner and currency statements (spec 05 6): partner debts at three levels,
 * movement of a partner, payments and linked documents, confirmation letter,
 * overdue liabilities, received and issued documents (05 7).
 */

const inList = (ids: readonly number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);
const iso = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`;
const f2 = (d: Dec) => d.toFixed(2);

/** Leva rows of a mixed period are divided by 1.95583 (EUR report). */
function factorSql(endDate: string, dateCol: SQL) {
  return endDate >= EURO_CHANGEOVER_DATE ? sql`(CASE WHEN ${dateCol} < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(BGN_PER_EUR.toString())} ELSE 1 END)` : sql`1`;
}

export const PARTNER_MESSAGES = {
  strPartnerNameMissing: 'Не е въведено име на фирма в поле Партньор!',
  strPartnersAccountMissing: 'Не е избрана сметка, която поддържа работа с партньори!',
} as const;

/* ------------------------------------------------------------------ */
/* Partner and own-company data                                        */
/* ------------------------------------------------------------------ */

export interface PartnerCard {
  id: number; name: string; bulstat: string; vatNumber: string; mol: string; address: string; city: string; phone: string; postalCode: string; iban: string; dueDays: number;
}

/** Partners with their primary address (lowest id when none is primary) and first IBAN. */
export async function partnerCards(db: DbOrTx, ids: number[]): Promise<Map<number, PartnerCard>> {
  const out = new Map<number, PartnerCard>();
  if (!ids.length) return out;
  const companies = await db.select().from(s.companies).where(inArray(s.companies.id, ids));
  const addresses = await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'company'), inArray(s.addresses.ownerId, ids)))
    .orderBy(desc(s.addresses.isPrimary), asc(s.addresses.id));
  const banks = await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'company'), inArray(s.bankAccounts.ownerId, ids))).orderBy(asc(s.bankAccounts.id));
  for (const c of companies) {
    const a = addresses.find((x) => x.ownerId === c.id);
    out.set(c.id, {
      id: c.id, name: c.name, bulstat: c.bulstat ?? '', vatNumber: c.vatNumber ?? '', mol: c.contactName ?? '',
      address: a?.address ?? '', city: a?.city ?? '', phone: a?.phone ?? '', postalCode: a?.postalCode ?? '',
      iban: banks.find((b) => b.ownerId === c.id)?.account ?? '', dueDays: c.dueDays,
    });
  }
  return out;
}

export interface MyCompanyCard { name: string; bulstat: string; vatId: string; mol: string; accountant: string; address: string; city: string; phone: string; email: string }

export async function myCompanyCard(db: DbOrTx): Promise<MyCompanyCard> {
  const [m] = await db.select().from(s.myCompany).limit(1);
  const [a] = m ? await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, m.id))).orderBy(desc(s.addresses.isPrimary), asc(s.addresses.id)).limit(1) : [];
  return {
    name: m?.name ?? '', bulstat: m?.bulstat ?? '', vatId: m?.vatId ?? '', mol: m?.contactName ?? '', accountant: m?.accountant ?? '',
    address: a?.address ?? '', city: a?.city ?? '', phone: a?.phone ?? '', email: m?.email ?? '',
  };
}

/* ------------------------------------------------------------------ */
/* Задължения/вземания по партньори (05 6.2-6.4)                       */
/* ------------------------------------------------------------------ */

export type DebtLevel = 'partner' | 'document' | 'accounting';

export interface PartnerDebtsOptions {
  endDate: string;
  /** Default: 1 January of the end date's year. */
  startDate?: string;
  level: DebtLevel;
  currency?: boolean;
  accountNumber?: string;
  companyIds?: number[];
  documentTypeId?: number;
  documentNumber?: string;
  /** Optional-reference prefix ("Втора забележка"). */
  reference?: string;
  showClosed?: boolean;
  showExpired?: boolean;
  sort?: string;
  filterColumn?: string;
  filterText?: string;
}

export interface PartnerLevelRow { companyId: number; companyName: string; companyBulstat: string; amount: string; currencyAmount: string }

export interface DocumentLevelRow {
  companyId: number; companyName: string; companyBulstat: string; companyDueDays: number; companyBankAccount: string;
  accountingId: number; accountingNumber: string; accountingDate: string; accountNumber: string;
  documentId: number | null; documentNumber: string; documentDate: string; documentTypeId: number | null; documentTypeShortName: string; documentTypePosition: number;
  dueDate: string; amount: string; sumAmount: string; currencyAmount: string; sumCurrencyAmount: string; currencyIso: string; exchangeRate: string;
  term: string; reference: string; optionalReference: string; kind: string;
}

export interface CoveringLine {
  accountingId: number; accountingNumber: string; accountingDate: string; debitAccountNumber: string; creditAccountNumber: string;
  documentNumber: string; documentDate: string; documentTypeShortName: string; coveredAmount: string; coveredCurrencyAmount: string;
}

export interface AccountingLevelRow extends DocumentLevelRow {
  /** The document's own amount (supplier invoice and client invoice positive, payments negative). */
  originalAmount: string;
  originalCurrencyAmount: string;
  /** Remaining open amount with the same sign convention. */
  remainingAmount: string;
  lines: CoveringLine[];
  /** Partner balance (net debit, sign of the partner level). */
  companyAmount: string;
  companyCurrencyAmount: string;
}

const DOC_SORTS: Record<string, (a: DocumentLevelRow, b: DocumentLevelRow) => number> = {
  DocumentDate: (a, b) => a.documentDate.localeCompare(b.documentDate),
  DocumentNumber: (a, b) => a.documentNumber.localeCompare(b.documentNumber, 'bg', { numeric: true }),
  DocumentType: (a, b) => a.documentTypePosition - b.documentTypePosition,
  Amount: (a, b) => dec(a.amount).comparedTo(dec(b.amount)),
  AccountingNumber: (a, b) => a.accountingNumber.localeCompare(b.accountingNumber),
  AccountingDate: (a, b) => a.accountingDate.localeCompare(b.accountingDate),
};

function byPartnerThen<T extends { companyName: string; companyBulstat: string }>(cmp?: (a: T, b: T) => number) {
  return (a: T, b: T) => a.companyName.localeCompare(b.companyName, 'bg') || a.companyBulstat.localeCompare(b.companyBulstat) || (cmp ? cmp(a, b) : 0);
}

function documentRow(i: OpenItem, iban: string): DocumentLevelRow {
  return {
    companyId: i.companyId, companyName: i.companyName, companyBulstat: i.companyBulstat, companyDueDays: i.companyDueDays, companyBankAccount: iban,
    accountingId: i.accountingId, accountingNumber: i.isInitialBalance ? 'Начално салдо' : i.accountingNumber, accountingDate: i.accountingDate, accountNumber: i.accountNumber,
    documentId: i.documentId, documentNumber: i.documentNumber, documentDate: i.documentDate, documentTypeId: i.documentTypeId,
    documentTypeShortName: i.documentTypeShortName, documentTypePosition: i.documentTypePosition,
    dueDate: i.dueDate, amount: i.open, sumAmount: i.booked, currencyAmount: i.openCurrency, sumCurrencyAmount: i.bookedCurrency,
    currencyIso: i.currencyIso, exchangeRate: i.exchangeRate, term: i.term, reference: i.reference, optionalReference: i.optionalReference, kind: i.kind,
  };
}

export async function partnerDebts(db: DbOrTx, o: PartnerDebtsOptions) {
  const startDate = o.startDate ?? yearStart(o.endDate);
  const filter = <T extends object>(rows: T[]) => (o.filterText ? rows.filter((r) => matchesColumnFilter(r as Record<string, unknown>, o.filterColumn ?? 'all', o.filterText!)) : rows);

  if (o.level === 'partner') {
    // 6.2: one net figure over [S, E]; no opening split and no chart filter.
    const conds: SQL[] = [
      sql`ac.account_category_id IN (${inList(COMPANY_CATEGORIES)})`,
      sql`a.accounting_date BETWEEN ${startDate} AND ${o.endDate}`,
    ];
    if (o.accountNumber) conds.push(accountRuleSql(sql`ac.number`, o.accountNumber));
    if (o.companyIds?.length) conds.push(sql`d.company_id IN (${inList(o.companyIds)})`);
    if (o.reference) conds.push(sql`opt.description ILIKE ${o.reference + '%'}`);
    const rows = await queryRows<{ id: number; name: string; bulstat: string; amount: string; cur: string }>(db, sql`
      SELECT co.id, co.name, coalesce(nullif(co.bulstat, ''), co.vat_number, '') AS bulstat,
        SUM((d.amount + d.ref_amount) * d.sign) AS amount, SUM(coalesce(d.currency_amount, 0) * d.sign) AS cur
      FROM accounting_details d
        JOIN accountings a ON a.id = d.accounting_id
        JOIN accounts ac ON ac.id = d.account_id
        JOIN companies co ON co.id = d.company_id
        LEFT JOIN reference_texts opt ON opt.id = a.optional_reference_id
      WHERE ${sql.join(conds, sql` AND `)}
      GROUP BY co.id, co.name, co.bulstat, co.vat_number`);
    let out: PartnerLevelRow[] = rows.map((r) => ({ companyId: r.id, companyName: r.name, companyBulstat: r.bulstat ?? '', amount: f2(dec(r.amount)), currencyAmount: f2(dec(r.cur)) }));
    if (!o.showClosed) out = out.filter((r) => !dec(r.amount).isZero() || (o.currency && !dec(r.currencyAmount).isZero()));
    out = filter(out);
    out.sort(o.sort === 'Amount' ? (a, b) => dec(a.amount).comparedTo(dec(b.amount)) || a.companyName.localeCompare(b.companyName, 'bg') : byPartnerThen());
    return { level: o.level, startDate, endDate: o.endDate, rows: out, total: f2(out.reduce((acc, r) => acc.plus(r.amount), ZERO)), totalCurrency: f2(out.reduce((acc, r) => acc.plus(r.currencyAmount), ZERO)) };
  }

  const items = await openItems(db, {
    startDate, endDate: o.endDate, accountNumber: o.accountNumber, companyIds: o.companyIds,
    documentTypeId: o.documentTypeId, documentNumber: o.documentNumber, optionalReference: o.reference,
    showClosed: o.showClosed,
  });
  // "Показване на документи с изтекъл срок на падеж": due date before the end date (only with closed
  // documents off); entries without a document are kept.
  const kept = o.showExpired && !o.showClosed ? items.filter((i) => !i.documentId || isOverdue(i.dueDate, o.endDate)) : items;
  const cards = await partnerCards(db, [...new Set(kept.map((i) => i.companyId))]);
  const docRows = kept.map((i) => documentRow(i, cards.get(i.companyId)?.iban ?? ''));

  if (o.level === 'document') {
    const out = filter(docRows).sort(byPartnerThen(DOC_SORTS[o.sort ?? 'DocumentDate'] ?? DOC_SORTS.DocumentDate));
    return { level: o.level, startDate, endDate: o.endDate, rows: out, total: f2(out.reduce((acc, r) => acc.plus(r.amount), ZERO)), totalCurrency: f2(out.reduce((acc, r) => acc.plus(r.currencyAmount), ZERO)) };
  }

  // 6.4: per original document the accountings linked through payment allocations.
  const ids = [...new Set(kept.map((i) => i.accountingId))];
  const links = ids.length ? await queryRows<Record<string, unknown>>(db, sql`
    SELECT p.ref_accounting_id, p.payment_accounting_id, p.account_id, p.company_id, p.amount, p.currency_amount,
      o.id AS other_id, o.number AS other_number, o.accounting_date AS other_date,
      doc.number AS doc_number, doc.date AS doc_date, dt.short_name AS doc_type,
      (SELECT da.number FROM accounting_details x JOIN accounts da ON da.id = x.account_id
        WHERE x.accounting_id = o.id AND x.sign = 1 AND (x.account_id = p.account_id OR x.ref_account_id = p.account_id) ORDER BY x.position LIMIT 1) AS debit_number,
      (SELECT ca.number FROM accounting_details x JOIN accounts ca ON ca.id = x.ref_account_id
        WHERE x.accounting_id = o.id AND x.sign = 1 AND (x.account_id = p.account_id OR x.ref_account_id = p.account_id) ORDER BY x.position LIMIT 1) AS credit_number,
      CASE WHEN p.ref_accounting_id IN (${inList(ids)}) THEN p.ref_accounting_id ELSE p.payment_accounting_id END AS original_id
    FROM accounting_payment_details p
      JOIN accountings o ON o.id = CASE WHEN p.ref_accounting_id IN (${inList(ids)}) THEN p.payment_accounting_id ELSE p.ref_accounting_id END
      LEFT JOIN documents doc ON doc.id = o.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
    WHERE (p.ref_accounting_id IN (${inList(ids)}) OR p.payment_accounting_id IN (${inList(ids)}))
      AND o.accounting_date BETWEEN ${startDate} AND ${o.endDate}
    ORDER BY o.accounting_date, o.number`) : [];
  const companyNet = new Map<number, { amt: Dec; cur: Dec }>();
  for (const i of kept) {
    const c = companyNet.get(i.companyId) ?? { amt: ZERO, cur: ZERO };
    companyNet.set(i.companyId, { amt: c.amt.plus(i.open), cur: c.cur.plus(i.openCurrency) });
  }
  const out: AccountingLevelRow[] = kept.map((i, n) => {
    const c = -i.k; // document's own sign (6.4): -1 payable, +1 receivable
    const net = companyNet.get(i.companyId)!;
    return {
      ...docRows[n]!,
      originalAmount: f2(dec(i.booked).times(c)),
      originalCurrencyAmount: f2(dec(i.bookedCurrency).times(c)),
      remainingAmount: f2(dec(i.open).times(c)),
      companyAmount: f2(net.amt),
      companyCurrencyAmount: f2(net.cur),
      lines: links.filter((l) => l.original_id === i.accountingId && l.account_id === i.accountId && (l.company_id == null || l.company_id === i.companyId)).map((l) => ({
        accountingId: l.other_id as number, accountingNumber: str(l.other_number), accountingDate: iso(l.other_date),
        debitAccountNumber: str(l.debit_number), creditAccountNumber: str(l.credit_number),
        documentNumber: str(l.doc_number), documentDate: iso(l.doc_date), documentTypeShortName: str(l.doc_type),
        coveredAmount: f2(dec(l.amount as string)), coveredCurrencyAmount: f2(dec(l.currency_amount as string)),
      })),
    };
  });
  const rows = filter(out).sort(byPartnerThen(DOC_SORTS[o.sort ?? 'AccountingDate'] ?? DOC_SORTS.AccountingDate));
  const partners = new Map(rows.map((r) => [r.companyId, r]));
  const total = [...partners.values()].reduce((acc, r) => acc.plus(r.companyAmount), ZERO);
  const totalCurrency = [...partners.values()].reduce((acc, r) => acc.plus(r.companyCurrencyAmount), ZERO);
  return { level: o.level, startDate, endDate: o.endDate, rows, total: f2(total), totalCurrency: f2(totalCurrency) };
}

/* ------------------------------------------------------------------ */
/* Движение по партньор (05 6.6)                                       */
/* ------------------------------------------------------------------ */

export interface MovementOptions {
  startDate: string;
  endDate: string;
  accountNumber: string;
  companyId: number | null;
  /** 0 all, 1 payables/receivables (increase the balance), 2 payments (settlements). */
  direction?: 0 | 1 | 2;
  currency?: boolean;
  sort?: string;
  filterColumn?: string;
  filterText?: string;
}

export interface MovementRow {
  accountingId: number; accountingNumbers: string; accountingDate: string;
  documentDate: string; documentType: string; documentNumber: string;
  debitAmount: string; creditAmount: string; debitCurrencyAmount: string; creditCurrencyAmount: string; currency: string;
  term: string; reference: string; optionalReference: string;
}

const MOVEMENT_SORTS: Record<string, (a: MovementRow, b: MovementRow) => number> = {
  DocumentDate: (a, b) => a.documentDate.localeCompare(b.documentDate) || a.accountingDate.localeCompare(b.accountingDate),
  AccountingNumber: (a, b) => a.accountingNumbers.localeCompare(b.accountingNumbers),
  AccountingDate: (a, b) => a.accountingDate.localeCompare(b.accountingDate),
  DebitAmount: (a, b) => dec(a.debitAmount).comparedTo(dec(b.debitAmount)),
  CreditAmount: (a, b) => dec(a.creditAmount).comparedTo(dec(b.creditAmount)),
  Term: (a, b) => a.term.localeCompare(b.term, 'bg'),
  DocumentType: (a, b) => a.documentType.localeCompare(b.documentType, 'bg'),
  DocumentNumber: (a, b) => a.documentNumber.localeCompare(b.documentNumber, 'bg', { numeric: true }),
};

export async function partnerMovement(db: DbOrTx, o: MovementOptions) {
  if (!o.companyId) throw new ApiError(400, PARTNER_MESSAGES.strPartnerNameMissing, [{ key: 'strPartnerNameMissing', text: PARTNER_MESSAGES.strPartnerNameMissing, severity: 'critical' }]);
  const [ok] = await queryRows<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM accounts ac WHERE ${accountRuleSql(sql`ac.number`, o.accountNumber)} AND ac.account_category_id IN (${inList(COMPANY_CATEGORIES)})`);
  if (!o.accountNumber || !ok?.n) throw new ApiError(400, PARTNER_MESSAGES.strPartnersAccountMissing, [{ key: 'strPartnersAccountMissing', text: PARTNER_MESSAGES.strPartnersAccountMissing, severity: 'critical' }]);

  const factor = factorSql(o.endDate, sql`a.accounting_date`);
  const lines = await queryRows<Record<string, unknown>>(db, sql`
    SELECT a.id AS accounting_id, a.number, a.accounting_date, d.sign, ac.account_category_id,
      d.amount / ${factor} AS amount, d.ref_amount / ${factor} AS ref_amount, coalesce(d.currency_amount, 0) AS cur, cur.iso_code,
      doc.id AS doc_id, doc.date AS doc_date, dt.short_name AS doc_type, doc.number AS doc_number,
      t.description AS term, r.description AS reference, opt.description AS optional_reference
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts ac ON ac.id = d.account_id
      LEFT JOIN currencies cur ON cur.id = d.currency_id
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN reference_texts opt ON opt.id = a.optional_reference_id
    WHERE d.company_id = ${o.companyId} AND ac.account_category_id IN (${inList(COMPANY_CATEGORIES)})
      AND ${accountRuleSql(sql`ac.number`, o.accountNumber)}
      AND NOT a.is_initial_balance AND a.accounting_date BETWEEN ${o.startDate} AND ${o.endDate}
    ORDER BY a.accounting_date, a.number, a.id, d.position`);

  const groups = new Map<string, MovementRow & { numbers: string[] }>();
  for (const l of lines) {
    const sign = Number(l.sign);
    const dir = movementLineDirection(l.account_category_id as number, sign);
    if (o.direction === 1 && dir !== 'increase') continue;
    if (o.direction === 2 && dir !== 'settlement') continue;
    const docDate = iso(l.doc_date) || iso(l.accounting_date);
    const key = (l.doc_id ? `${docDate}|${str(l.doc_type)}|${str(l.doc_number)}` : `acc:${l.accounting_id}`) + `|${sign}`;
    const g = groups.get(key) ?? {
      accountingId: l.accounting_id as number, accountingNumbers: '', numbers: [], accountingDate: iso(l.accounting_date),
      documentDate: docDate, documentType: str(l.doc_type), documentNumber: str(l.doc_number),
      debitAmount: '0', creditAmount: '0', debitCurrencyAmount: '0', creditCurrencyAmount: '0', currency: str(l.iso_code),
      term: str(l.term), reference: str(l.reference), optionalReference: str(l.optional_reference),
    };
    if (sign > 0) {
      g.debitAmount = dec(g.debitAmount).plus(dec(l.amount as string)).toString();
      g.debitCurrencyAmount = dec(g.debitCurrencyAmount).plus(dec(l.cur as string)).toString();
    } else {
      g.creditAmount = dec(g.creditAmount).plus(dec(l.ref_amount as string)).toString();
      g.creditCurrencyAmount = dec(g.creditCurrencyAmount).plus(dec(l.cur as string)).toString();
    }
    const n = str(l.number);
    if (n && !g.numbers.includes(n)) g.numbers.push(n);
    if (!g.currency && l.iso_code) g.currency = str(l.iso_code);
    groups.set(key, g);
  }
  let rows: MovementRow[] = [...groups.values()].map(({ numbers, ...g }) => ({
    ...g, accountingNumbers: numbers.join(', '),
    debitAmount: f2(dec(g.debitAmount)), creditAmount: f2(dec(g.creditAmount)),
    debitCurrencyAmount: f2(dec(g.debitCurrencyAmount)), creditCurrencyAmount: f2(dec(g.creditCurrencyAmount)),
  }));
  if (o.filterText) rows = rows.filter((r) => matchesColumnFilter(r as unknown as Record<string, unknown>, o.filterColumn ?? 'all', o.filterText!));
  rows.sort(MOVEMENT_SORTS[o.sort ?? 'DocumentDate'] ?? MOVEMENT_SORTS.DocumentDate);

  const balances = await accountBalances(db, o.accountNumber, { startDate: o.startDate, endDate: o.endDate, companyIds: [o.companyId] });
  const cur = await currencyBalances(db, o.accountNumber, o.startDate, o.endDate, o.companyId);
  const sumOf = (k: keyof MovementRow) => f2(rows.reduce((acc, r) => acc.plus(r[k] as string), ZERO));
  const [company] = await db.select({ name: s.companies.name }).from(s.companies).where(eq(s.companies.id, o.companyId));
  const [account] = await db.select({ description: s.accounts.description }).from(s.accounts).where(eq(s.accounts.number, o.accountNumber)).limit(1);
  return {
    companyName: company?.name ?? '', accountDescription: account?.description ?? '',
    opening: { debit: balances.openingDebit, credit: balances.openingCredit, debitCurrency: cur.openingDebit, creditCurrency: cur.openingCredit },
    rows,
    turnover: { debit: sumOf('debitAmount'), credit: sumOf('creditAmount'), debitCurrency: sumOf('debitCurrencyAmount'), creditCurrency: sumOf('creditCurrencyAmount') },
    closing: { debit: balances.closingDebit, credit: balances.closingCredit, debitCurrency: cur.closingDebit, creditCurrency: cur.closingCredit },
  };
}

/** Currency balances of an account (and partner) like spBalancesReportFC: opening, turnover, closing (netted). */
async function currencyBalances(db: DbOrTx, accountNumber: string, startDate: string, endDate: string, companyId?: number | null) {
  const y = Number(startDate.slice(0, 4));
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
  const opening = sql`(a.is_initial_balance OR a.accounting_date < ${startDate})`;
  const [r] = await queryRows<{ od: string; oc: string; dt: string; ct: string }>(db, sql`
    SELECT coalesce(SUM(CASE WHEN ${opening} AND d.sign = 1 THEN coalesce(d.currency_amount, 0) ELSE 0 END), 0) AS od,
      coalesce(SUM(CASE WHEN ${opening} AND d.sign = -1 THEN coalesce(d.currency_amount, 0) ELSE 0 END), 0) AS oc,
      coalesce(SUM(CASE WHEN NOT ${opening} AND d.sign = 1 THEN coalesce(d.currency_amount, 0) ELSE 0 END), 0) AS dt,
      coalesce(SUM(CASE WHEN NOT ${opening} AND d.sign = -1 THEN coalesce(d.currency_amount, 0) ELSE 0 END), 0) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE ${fy ? sql`a.financial_year_id = ${fy.id}` : sql`a.accounting_date >= ${yearStart(startDate)}`} AND a.accounting_date <= ${endDate}
      AND ${accountRuleSql(sql`ac.number`, accountNumber)} ${companyId ? sql`AND d.company_id = ${companyId}` : sql``}`);
  const od = dec(r?.od), oc = dec(r?.oc), dt = dec(r?.dt), ct = dec(r?.ct);
  const net = (a: Dec, b: Dec) => (a.minus(b).greaterThan(0) ? a.minus(b) : ZERO);
  return {
    openingDebit: f2(net(od, oc)), openingCredit: f2(net(oc, od)), debitTurnover: f2(dt), creditTurnover: f2(ct),
    closingDebit: f2(net(od.plus(dt), oc.plus(ct))), closingCredit: f2(net(oc.plus(ct), od.plus(dt))),
  };
}

/* ------------------------------------------------------------------ */
/* Разплащания и обвързани документи (05 7.7 layout)                   */
/* ------------------------------------------------------------------ */

export interface PaymentsReportOptions {
  startDate: string;
  endDate: string;
  companyIds?: number[];
  accountNumber?: string;
  documentTypeId?: number;
  documentNumber?: string;
  fromAmount?: string;
  toAmount?: string;
  term?: string;
  sort?: string;
}

export async function paymentsReport(db: DbOrTx, o: PaymentsReportOptions) {
  const conds: SQL[] = [sql`(ra.accounting_date BETWEEN ${o.startDate} AND ${o.endDate} OR pa.accounting_date BETWEEN ${o.startDate} AND ${o.endDate})`];
  if (o.companyIds?.length) conds.push(sql`p.company_id IN (${inList(o.companyIds)})`);
  if (o.accountNumber) conds.push(accountRuleSql(sql`ac.number`, o.accountNumber));
  if (o.documentTypeId) conds.push(sql`rdoc.document_type_id = ${o.documentTypeId}`);
  if (o.documentNumber) conds.push(sql`rdoc.number ILIKE ${o.documentNumber + '%'}`);
  if (o.fromAmount) conds.push(sql`p.amount >= ${o.fromAmount}`);
  if (o.toAmount) conds.push(sql`p.amount <= ${o.toAmount}`);
  if (o.term) conds.push(sql`(rt.description ILIKE ${'%' + o.term + '%'} OR pt.description ILIKE ${'%' + o.term + '%'})`);
  const order: Record<string, SQL> = {
    Partner: sql`co.name, ra.accounting_date, ra.number, pa.accounting_date`,
    RefDocumentDate: sql`coalesce(rdoc.date, ra.accounting_date), ra.number, pa.accounting_date`,
    RefDocumentNumber: sql`rdoc.number, ra.number, pa.accounting_date`,
    PaymentDate: sql`pa.accounting_date, pa.number`,
  };
  const rows = await queryRows<Record<string, unknown>>(db, sql`
    SELECT p.id, p.amount, p.currency_amount, ac.number AS account_number,
      co.name AS partner_name, coalesce(nullif(co.bulstat, ''), co.vat_number, '') AS partner_bulstat,
      ra.id AS ref_id, ra.number AS ref_number, ra.accounting_date AS ref_date, ra.is_initial_balance AS ref_initial,
      rdt.short_name AS ref_doc_type, rdoc.number AS ref_doc_number, rdoc.date AS ref_doc_date, rt.description AS ref_term, rr.description AS ref_reference,
      (SELECT abs(SUM((x.amount + x.ref_amount) * x.sign)) FROM accounting_details x
        WHERE x.accounting_id = ra.id AND x.account_id = p.account_id AND (p.company_id IS NULL OR x.company_id = p.company_id)) AS ref_amount,
      pa.id AS pay_id, pa.number AS pay_number, pa.accounting_date AS pay_date,
      pdt.short_name AS pay_doc_type, pdoc.number AS pay_doc_number, pdoc.date AS pay_doc_date, pt.description AS pay_term, pr.description AS pay_reference
    FROM accounting_payment_details p
      JOIN accountings ra ON ra.id = p.ref_accounting_id
      JOIN accountings pa ON pa.id = p.payment_accounting_id
      JOIN accounts ac ON ac.id = p.account_id
      LEFT JOIN companies co ON co.id = p.company_id
      LEFT JOIN documents rdoc ON rdoc.id = ra.document_id
      LEFT JOIN document_types rdt ON rdt.id = rdoc.document_type_id
      LEFT JOIN terms rt ON rt.id = ra.term_id
      LEFT JOIN reference_texts rr ON rr.id = ra.reference_id
      LEFT JOIN documents pdoc ON pdoc.id = pa.document_id
      LEFT JOIN document_types pdt ON pdt.id = pdoc.document_type_id
      LEFT JOIN terms pt ON pt.id = pa.term_id
      LEFT JOIN reference_texts pr ON pr.id = pa.reference_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY ${order[o.sort ?? 'Partner'] ?? order.Partner}, p.id`);
  return rows.map((r) => ({
    id: r.id as number,
    accountNumber: str(r.account_number),
    partnerName: str(r.partner_name), partnerBulstat: str(r.partner_bulstat),
    refAccountingId: r.ref_id as number, refAccountingNumber: r.ref_initial ? 'Начално салдо' : str(r.ref_number), refAccountingDate: iso(r.ref_date),
    refAccountingDocumentType: str(r.ref_doc_type), refAccountingDocumentNumber: str(r.ref_doc_number), refAccountingDocumentDate: iso(r.ref_doc_date) || iso(r.ref_date),
    refAccountingAmount: f2(dec(r.ref_amount as string)), refAccountingReference: str(r.ref_reference), refAccountingTerm: str(r.ref_term),
    paymentAccountingId: r.pay_id as number, paymentAccountingNumber: str(r.pay_number), paymentAccountingDate: iso(r.pay_date),
    paymentAccountingDocumentType: str(r.pay_doc_type), paymentAccountingDocumentNumber: str(r.pay_doc_number), paymentAccountingDocumentDate: iso(r.pay_doc_date) || iso(r.pay_date),
    paymentAmount: f2(dec(r.amount as string)), paymentCurrencyAmount: f2(dec(r.currency_amount as string)),
    paymentAccountingReference: str(r.pay_reference), paymentAccountingTerm: str(r.pay_term),
  }));
}

/* ------------------------------------------------------------------ */
/* Потвърдително писмо (05 6.5) and Просрочени задължения (05 6.7)      */
/* ------------------------------------------------------------------ */

export interface LetterItem {
  accountingId: number; accountNumber: string; documentTypeShortName: string; documentNumber: string; documentDate: string;
  dueDate: string; amount: string; sumAmount: string; currencyAmount: string; currencyIso: string;
  term: string; reference: string; optionalReference: string; overdueDays: number; overdueDaysText: string;
}

export interface PartnerLetter {
  company: PartnerCard;
  items: LetterItem[];
  total: string;
  totalSum: string;
  totalCurrency: string;
}

function letterItem(i: OpenItem, endDate: string, abs: boolean): LetterItem {
  const days = Math.max(0, daysBetweenDates(i.dueDate, endDate));
  const v = (x: string) => (abs ? dec(x).abs().toFixed(2) : x);
  return {
    accountingId: i.accountingId, accountNumber: i.accountNumber,
    // Opening balances without a document show empty document columns.
    documentTypeShortName: i.documentTypeShortName, documentNumber: i.documentNumber, documentDate: i.documentId ? i.documentDate : '',
    dueDate: i.dueDate, amount: v(i.open), sumAmount: v(i.booked), currencyAmount: v(i.openCurrency), currencyIso: i.currencyIso,
    term: i.term, reference: i.reference, optionalReference: i.optionalReference, overdueDays: days, overdueDaysText: overdueDaysText(days),
  };
}

async function groupLetters(db: DbOrTx, items: OpenItem[], endDate: string, abs: boolean): Promise<PartnerLetter[]> {
  const cards = await partnerCards(db, [...new Set(items.map((i) => i.companyId))]);
  const map = new Map<number, PartnerLetter>();
  for (const i of items) {
    const l = map.get(i.companyId) ?? { company: cards.get(i.companyId)!, items: [], total: '0.00', totalSum: '0.00', totalCurrency: '0.00' };
    const it = letterItem(i, endDate, abs);
    l.items.push(it);
    l.total = f2(dec(l.total).plus(it.amount));
    l.totalSum = f2(dec(l.totalSum).plus(it.sumAmount));
    l.totalCurrency = f2(dec(l.totalCurrency).plus(it.currencyAmount));
    map.set(i.companyId, l);
  }
  return [...map.values()].sort((a, b) => a.company.name.localeCompare(b.company.name, 'bg'));
}

export interface LetterOptions {
  endDate: string;
  startDate?: string;
  /** Partner-name pattern (the original filters this report by name with LIKE). */
  companyName?: string;
  companyIds?: number[];
  minSum?: string;
}

/** Confirmation letter: open items of every partner account; signed amounts (receivable +, payable -), |amount| >= minSum. */
export async function confirmationLetters(db: DbOrTx, o: LetterOptions) {
  const startDate = o.startDate ?? yearStart(o.endDate);
  const pattern = o.companyName?.replace(/%/g, '').trim();
  const items = (await openItems(db, { startDate, endDate: o.endDate, companyName: pattern || undefined, companyIds: o.companyIds }))
    .filter((i) => dec(i.open).abs().greaterThanOrEqualTo(dec(o.minSum || 0)));
  return { myCompany: await myCompanyCard(db), startDate, endDate: o.endDate, letters: await groupLetters(db, items, o.endDate, false) };
}

export interface OverduesOptions {
  endDate: string;
  startDate?: string;
  accountNumber?: string;
  companyIds?: number[];
}

/**
 * Overdue liabilities. Corrected defect 02c D2: the due date (the entry's own
 * due date, else document date + partner due days) is compared with the report
 * end date (date part, strict), not with the server clock; one address per partner.
 */
export async function overdues(db: DbOrTx, o: OverduesOptions) {
  const startDate = o.startDate ?? yearStart(o.endDate);
  const items = (await openItems(db, { startDate, endDate: o.endDate, accountNumber: o.accountNumber, companyIds: o.companyIds, kind: 'liability' }))
    .filter((i) => isOverdue(i.dueDate, o.endDate));
  return { myCompany: await myCompanyCard(db), startDate, endDate: o.endDate, letters: await groupLetters(db, items, o.endDate, true) };
}

/* ------------------------------------------------------------------ */
/* Получени и издадени документи (05 7)                               */
/* ------------------------------------------------------------------ */

export interface ReceivedIssuedOptions {
  startDate: string;
  endDate: string;
  byExportMonth?: boolean;
  companyIds?: number[];
  documentTypeId?: number;
  documentNumber?: string;
  transactionTypeId?: number;
  /** VAT term; 19 = all sale terms (7-18), 20 = all purchase terms (2-6). */
  vatTermId?: number;
  sort?: string;
}

const PAYABLE = [4, 6, 7, 8, 9, 20, 33, 54];
const RECEIVABLE = [10, 12, 13, 14, 15, 19, 34, 55];

export async function receivedIssued(db: DbOrTx, o: ReceivedIssuedOptions) {
  const factor = factorSql(o.endDate, sql`a.accounting_date`);
  const window = o.byExportMonth
    ? sql`a.vies_month BETWEEN ${o.startDate.slice(0, 8) + '01'} AND ${o.endDate}`
    : sql`a.accounting_date BETWEEN ${o.startDate} AND ${o.endDate} AND coalesce(doc.date, a.accounting_date) BETWEEN ${o.startDate} AND ${o.endDate}`;
  const conds: SQL[] = [sql`d.sign = 1`, sql`NOT a.is_initial_balance`, window];
  if (o.documentTypeId) conds.push(sql`doc.document_type_id = ${o.documentTypeId}`);
  if (o.documentNumber) conds.push(sql`doc.number ILIKE ${o.documentNumber + '%'}`);
  if (o.transactionTypeId) conds.push(sql`a.transaction_type_id = ${o.transactionTypeId}`);
  if (!o.byExportMonth) conds.push(sql`da.is_euro = (a.accounting_date >= ${EURO_CHANGEOVER_DATE})`);
  const legs = await queryRows<Record<string, unknown>>(db, sql`
    SELECT a.id AS accounting_id, a.number, a.accounting_date, a.vies_month, a.transaction_type_id,
      d.amount / ${factor} AS amount, d.vat_term_id, vt.description AS vat_term,
      da.number AS debit_number, ca.number AS credit_number, da.account_category_id AS dcat, ca.account_category_id AS ccat,
      coalesce(d.company_id, (SELECT m.company_id FROM accounting_details m WHERE m.accounting_id = d.accounting_id AND m.sign = -1
        AND m.account_id = d.ref_account_id AND m.ref_account_id = d.account_id AND m.company_id IS NOT NULL LIMIT 1)) AS company_id,
      doc.date AS doc_date, doc.number AS doc_number, dt.short_name AS doc_type,
      t.description AS term, r.description AS reference, opt.description AS optional_reference
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts da ON da.id = d.account_id
      JOIN accounts ca ON ca.id = d.ref_account_id
      LEFT JOIN vat_terms vt ON vt.id = d.vat_term_id
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN reference_texts opt ON opt.id = a.optional_reference_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.accounting_date, a.number, d.position`);
  const companyIds = new Set<number>();
  const byAcc = new Map<number, Record<string, unknown>[]>();
  for (const l of legs) {
    const id = l.accounting_id as number;
    byAcc.set(id, [...(byAcc.get(id) ?? []), l]);
  }
  interface Row {
    accountingId: number; accountingNumber: string; accountingDate: string; debitNumber: string; creditNumber: string;
    docDate: string; docType: string; docNumber: string; companyId: number | null; company: string;
    taxBase: string; vatAmount: string; amount: string; term: string; deal: string; viesMonth: string; vatTerm: string; reference: string; optionalReference: string;
  }
  const out: Row[] = [];
  const saleTerms = (id: number) => id >= 7 && id <= 18;
  const purchaseTerms = (id: number) => id >= 2 && id <= 6;
  for (const [id, ls] of byAcc) {
    const first = ls[0]!;
    const purchase = ls.filter((l) => PAYABLE.includes(Number(l.ccat)));
    const sale = ls.filter((l) => RECEIVABLE.includes(Number(l.dcat)));
    let deal: 'Покупка' | 'Продажба' | null = null;
    if (purchase.length && sale.length) {
      const tt = Number(first.transaction_type_id);
      deal = tt === 2 ? 'Покупка' : tt === 3 ? 'Продажба' : null;
    } else if (purchase.length) deal = 'Покупка';
    else if (sale.length) deal = 'Продажба';
    if (!deal) continue;
    const sel = deal === 'Покупка' ? purchase : sale;
    const companyId = (sel.find((l) => l.company_id != null)?.company_id as number | undefined) ?? null;
    if (o.companyIds?.length && (!companyId || !o.companyIds.includes(companyId))) continue;
    if (o.vatTermId) {
      const match = (v: number) => (o.vatTermId === 19 ? saleTerms(v) : o.vatTermId === 20 ? purchaseTerms(v) : v === o.vatTermId);
      if (!ls.some((l) => match(Number(l.vat_term_id)))) continue;
    }
    const amount = sel.reduce((acc, l) => acc.plus(dec(l.amount as string)), ZERO);
    const vat = sel.filter((l) => Number(l.dcat) === 16 || [17, 61].includes(Number(l.ccat))).reduce((acc, l) => acc.plus(dec(l.amount as string)), ZERO);
    if (companyId) companyIds.add(companyId);
    const uniq = (k: string) => [...new Set(sel.map((l) => str(l[k])).filter(Boolean))].join(', ');
    out.push({
      accountingId: id, accountingNumber: str(first.number), accountingDate: iso(first.accounting_date),
      debitNumber: uniq('debit_number'), creditNumber: uniq('credit_number'),
      docDate: iso(first.doc_date) || iso(first.accounting_date), docType: str(first.doc_type), docNumber: str(first.doc_number),
      companyId, company: '', taxBase: f2(amount.minus(vat)), vatAmount: f2(vat), amount: f2(amount),
      term: str(first.term), deal, viesMonth: iso(first.vies_month),
      vatTerm: [...new Set(ls.filter((l) => Number(l.vat_term_id) > 1).map((l) => str(l.vat_term)))].join('; '),
      reference: str(first.reference), optionalReference: str(first.optional_reference),
    });
  }
  const cards = await partnerCards(db, [...companyIds]);
  for (const r of out) r.company = r.companyId ? cards.get(r.companyId)?.name ?? '' : '';
  const sorts: Record<string, (a: Row, b: Row) => number> = {
    DocumentNumber: (a, b) => a.docNumber.localeCompare(b.docNumber, 'bg', { numeric: true }) || a.docDate.localeCompare(b.docDate),
    DocumentDate: (a, b) => a.docDate.localeCompare(b.docDate) || a.docNumber.localeCompare(b.docNumber, 'bg', { numeric: true }),
    AccountingDate: (a, b) => a.accountingDate.localeCompare(b.accountingDate) || a.accountingNumber.localeCompare(b.accountingNumber),
    AccountingNumber: (a, b) => a.accountingNumber.localeCompare(b.accountingNumber),
    ViesMonth: (a, b) => a.viesMonth.localeCompare(b.viesMonth) || a.docDate.localeCompare(b.docDate),
  };
  out.sort(sorts[o.sort ?? 'DocumentNumber'] ?? sorts.DocumentNumber);
  return out;
}

/* ------------------------------------------------------------------ */
/* Справка партньори (spCompaniesReport, 05 7.7)                       */
/* ------------------------------------------------------------------ */

/** "Филтър по" columns of the partners register, in the order of the original combo. */
export const COMPANIES_FILTER_COLUMNS = [
  'CompanyNameAndBulstat', 'BulstatAndVATNumber', 'CompanyName', 'VatNumber', 'Bulstat', 'ContactName', 'City', 'Address', 'PostalCode', 'Phone', 'Email', 'LastModifiedDate',
] as const;
export type CompaniesFilterColumn = (typeof COMPANIES_FILTER_COLUMNS)[number];

export interface CompaniesReportOptions {
  /** Partner group: the group and its whole subtree. */
  groupId?: number;
  /** Substring of the partner's joined account numbers. */
  account?: string;
  filterColumn?: CompaniesFilterColumn | '';
  filterText?: string;
}

export interface CompaniesReportRow {
  companyId: number;
  companyName: string;
  groupId: number;
  vatNumber: string;
  bulstat: string;
  contactName: string;
  country: string;
  city: string;
  address: string;
  postalCode: string;
  phone: string;
  email: string;
  /** "Дата на създаване" (LastModifiedDate), yyyy-mm-dd. */
  lastModifiedDate: string;
  /** Linked accounts, "; "-delimited (@pAccountsDelimiter). */
  accountNumbers: string;
  ibans: string;
}

const ACCOUNTS_DELIMITER = '; ';
const bgDay = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

/**
 * Partners register: every non-deleted partner with its first address
 * (lowest id), linked accounts and IBANs; group filter on the group's
 * subtree, account filter as a substring of the joined account list, the
 * free-text filter on one column or any. Ordered by name; no euro dependency.
 */
export async function companiesReport(db: DbOrTx, o: CompaniesReportOptions): Promise<CompaniesReportRow[]> {
  const group = o.groupId && o.groupId !== 1
    ? sql`AND co.group_id IN (WITH RECURSIVE g AS (SELECT id FROM company_groups WHERE id = ${o.groupId} UNION ALL SELECT c.id FROM company_groups c JOIN g ON c.parent_id = g.id) SELECT id FROM g)`
    : sql``;
  const rows = await queryRows<{
    id: number; name: string; group_id: number; vat_number: string | null; bulstat: string | null; contact_name: string | null; email: string | null;
    last_modified: string; country: string | null; city: string | null; address: string | null; postal_code: string | null; phone: string | null;
    accounts: string | null; ibans: string | null;
  }>(db, sql`
    SELECT co.id, co.name, co.group_id, co.vat_number, co.bulstat, co.contact_name, co.email,
      to_char(co.last_modified_date, 'YYYY-MM-DD') AS last_modified,
      ad.country, ad.city, ad.address, ad.postal_code, ad.phone,
      (SELECT string_agg(ac.number, ${ACCOUNTS_DELIMITER} ORDER BY ac.number) FROM company_accounts ca JOIN accounts ac ON ac.id = ca.account_id WHERE ca.company_id = co.id) AS accounts,
      (SELECT string_agg(b.account, ${ACCOUNTS_DELIMITER} ORDER BY b.id) FROM bank_accounts b WHERE b.owner_type = 'company' AND b.owner_id = co.id) AS ibans
    FROM companies co
    LEFT JOIN LATERAL (
      SELECT cn.name AS country, a.city, a.address, a.postal_code, a.phone FROM addresses a LEFT JOIN countries cn ON cn.id = a.country_id
      WHERE a.owner_type = 'company' AND a.owner_id = co.id ORDER BY a.id LIMIT 1
    ) ad ON TRUE
    WHERE NOT co.is_deleted ${group}
    ORDER BY co.name, co.id`);
  const account = o.account?.trim();
  return rows
    .map((r): CompaniesReportRow => ({
      companyId: r.id, companyName: r.name, groupId: r.group_id, vatNumber: r.vat_number ?? '', bulstat: r.bulstat ?? '', contactName: r.contact_name ?? '',
      country: r.country ?? '', city: r.city ?? '', address: r.address ?? '', postalCode: r.postal_code ?? '', phone: r.phone ?? '', email: r.email ?? '',
      lastModifiedDate: r.last_modified, accountNumbers: r.accounts ?? '', ibans: r.ibans ?? '',
    }))
    .filter((r) => !account || r.accountNumbers.includes(account))
    .filter((r) => matchesColumnFilter({
      CompanyNameAndBulstat: `${r.companyName} ${r.bulstat}`, BulstatAndVATNumber: `${r.bulstat} ${r.vatNumber}`, CompanyName: r.companyName, VatNumber: r.vatNumber,
      Bulstat: r.bulstat, ContactName: r.contactName, City: r.city, Address: r.address, PostalCode: r.postalCode, Phone: r.phone, Email: r.email,
      LastModifiedDate: `${r.lastModifiedDate} ${bgDay(r.lastModifiedDate)}`,
    }, o.filterColumn ?? '', o.filterText ?? ''));
}
