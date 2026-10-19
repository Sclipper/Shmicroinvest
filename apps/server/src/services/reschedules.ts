import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  dec, DOCUMENT_TYPE, isCompanyCategory, isLeaf, rescheduleMonthEnd, reschedulePeriods, validateReschedule, ZERO,
  type RescheduleAccountInfo,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { saveEntry } from './journal.ts';

/** Разсрочване на приходи/разходи (spec 02a 9.3; report 05 7.7). */

export interface RescheduleBody {
  number?: string | null;
  name: string;
  amount: string;
  documentTypeId?: number | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  fromDate: string;
  toDate: string;
  isRescheduleByDays: boolean;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  companyId?: number | null;
  term?: string | null;
  reference?: string | null;
  sourceAccountingId?: number | null;
}

const nn = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

async function accountInfo(db: DbOrTx, id: number | null | undefined, isEuro: boolean): Promise<RescheduleAccountInfo | null> {
  if (!id) return null;
  const [a] = await db.select().from(s.accounts).where(eq(s.accounts.id, id));
  if (!a || a.isEuro !== isEuro || a.number === '0') return { exists: false, hasSubAccounts: false, categoryId: null, isPartner: false };
  return { exists: true, hasSubAccounts: !isLeaf({ left: a.leftIndex, right: a.rightIndex }), categoryId: a.accountCategoryId, isPartner: isCompanyCategory(a.accountCategoryId) };
}

/** Card + periods; processed periods are kept, the rest regenerated with the remaining amount. */
export async function saveReschedule(db: DbOrTx, body: RescheduleBody, year: ActiveYear, id?: number) {
  const isEuro = year.year >= 2026;
  const debit = await accountInfo(db, body.debitAccountId, isEuro);
  const credit = await accountInfo(db, body.creditAccountId, isEuro);
  const msgs = validateReschedule({ name: body.name, amount: body.amount, fromDate: body.fromDate, toDate: body.toDate, debit, credit, companyId: body.companyId ?? null });
  if (msgs.length) throw new ApiError(422, 'Картонът не може да бъде записан поради следните грешки:', msgs);
  const values = {
    number: nn(body.number), name: body.name.trim(), amount: dec(body.amount).toFixed(2),
    documentTypeId: body.documentTypeId ?? null, documentNumber: nn(body.documentNumber), documentDate: body.documentDate || null,
    fromDate: body.fromDate, toDate: body.toDate, isRescheduleByDays: body.isRescheduleByDays, isRescheduleByMonths: !body.isRescheduleByDays,
    debitAccountId: body.debitAccountId!, creditAccountId: body.creditAccountId!,
    companyId: debit?.isPartner || credit?.isPartner ? body.companyId ?? null : null,
    term: nn(body.term), reference: nn(body.reference), isEuro,
  };
  let rid: number;
  if (id) {
    const [r] = await db.select({ id: s.accountingReschedules.id }).from(s.accountingReschedules).where(eq(s.accountingReschedules.id, id));
    if (!r) throw notFound('Картонът');
    const { number, ...rest } = values;
    await db.update(s.accountingReschedules).set(body.number === undefined ? rest : { ...rest, number }).where(eq(s.accountingReschedules.id, id));
    rid = id;
  } else {
    if (!values.number) {
      const [{ n }] = (await queryRows<{ n: number }>(db, sql`SELECT coalesce(max(CASE WHEN number ~ '^[0-9]+$' THEN number::bigint END), 0)::int + 1 AS n FROM accounting_reschedules`)) as [{ n: number }];
      values.number = String(n);
    }
    const [r] = await db.insert(s.accountingReschedules).values({ ...values, sourceAccountingId: body.sourceAccountingId ?? null }).returning({ id: s.accountingReschedules.id });
    rid = r!.id;
  }
  await regenerateDetails(db, rid);
  return loadReschedule(db, rid);
}

export async function regenerateDetails(db: DbOrTx, id: number) {
  const [r] = await db.select().from(s.accountingReschedules).where(eq(s.accountingReschedules.id, id));
  const details = await db.select().from(s.accountingRescheduleDetails).where(eq(s.accountingRescheduleDetails.rescheduleId, id));
  const processed = details.filter((d) => d.isProcessed);
  await db.delete(s.accountingRescheduleDetails).where(and(eq(s.accountingRescheduleDetails.rescheduleId, id), eq(s.accountingRescheduleDetails.isProcessed, false)));
  const done = new Set(processed.map((d) => d.month));
  const remaining = dec(r!.amount).minus(processed.reduce((a, d) => a.plus(dec(d.amount)), ZERO));
  const all = reschedulePeriods({ amount: r!.amount, fromDate: r!.fromDate, toDate: r!.toDate, byDays: r!.isRescheduleByDays });
  const months = all.map((p) => p.month).filter((m) => !done.has(m));
  if (!months.length) return;
  const periods = processed.length
    ? reschedulePeriods({ amount: remaining, fromDate: r!.fromDate, toDate: r!.toDate, byDays: r!.isRescheduleByDays, months })
    : all;
  await db.insert(s.accountingRescheduleDetails).values(periods.map((p) => ({ rescheduleId: id, month: p.month, amount: p.amount, isProcessed: false })));
}

export async function loadReschedule(db: DbOrTx, id: number) {
  const [r] = await db.select().from(s.accountingReschedules).where(eq(s.accountingReschedules.id, id));
  if (!r) throw notFound('Картонът');
  const details = await db.select({ d: s.accountingRescheduleDetails, accountingNumber: s.accountings.number })
    .from(s.accountingRescheduleDetails).leftJoin(s.accountings, eq(s.accountings.id, s.accountingRescheduleDetails.accountingId))
    .where(eq(s.accountingRescheduleDetails.rescheduleId, id)).orderBy(asc(s.accountingRescheduleDetails.month));
  const processed = details.filter((x) => x.d.isProcessed);
  const processedAmount = processed.reduce((a, x) => a.plus(dec(x.d.amount)), ZERO);
  const companyName = r.companyId ? (await db.select({ n: s.companies.name }).from(s.companies).where(eq(s.companies.id, r.companyId)))[0]?.n ?? null : null;
  return {
    ...r, companyName,
    amount: dec(r.amount).toFixed(2),
    lastProcessedMonth: processed.length ? processed[processed.length - 1]!.d.month : null,
    processedAmount: processedAmount.toFixed(2),
    remainingAmount: dec(r.amount).minus(processedAmount).toFixed(2),
    details: details.map((x) => ({ id: x.d.id, month: x.d.month, amount: dec(x.d.amount).toFixed(2), isProcessed: x.d.isProcessed, accountingId: x.d.accountingId, accountingNumber: x.accountingNumber })),
  };
}

export interface RescheduleFilter {
  number?: string; name?: string; documentTypeId?: number; documentNumber?: string;
  debit?: string; credit?: string; from?: string; to?: string; reference?: string;
}

interface Row {
  id: number; number: string | null; name: string | null; amount: string; document_type_id: number | null; document_name: string | null;
  document_number: string | null; document_date: string | null; from_date: string; to_date: string; debit_account: string; credit_account: string;
  company_name: string | null; term: string | null; reference: string | null; last_processed_month: string | null; processed_amount: string;
  processed_amount_by_year: string;
}

async function rows(db: DbOrTx, f: RescheduleFilter, isEuro: boolean, upTo: string | null, year: number) {
  const like = (v?: string) => (v ? `%${v}%` : null);
  return queryRows<Row>(db, sql`
    SELECT r.id, r.number, r.name, r.amount, r.document_type_id, dt.name AS document_name, r.document_number, r.document_date,
      r.from_date, r.to_date, da.number AS debit_account, ca.number AS credit_account, c.name AS company_name, r.term, r.reference,
      (SELECT max(d.month) FROM accounting_reschedule_details d WHERE d.reschedule_id = r.id AND d.is_processed
         AND (${upTo}::date IS NULL OR d.month <= ${upTo}::date)) AS last_processed_month,
      (SELECT coalesce(sum(d.amount), 0) FROM accounting_reschedule_details d WHERE d.reschedule_id = r.id AND d.is_processed
         AND (${upTo}::date IS NULL OR d.month <= ${upTo}::date)) AS processed_amount,
      (SELECT coalesce(sum(d.amount), 0) FROM accounting_reschedule_details d WHERE d.reschedule_id = r.id AND d.is_processed
         AND extract(year FROM d.month) = ${year} AND (${upTo}::date IS NULL OR d.month <= ${upTo}::date)) AS processed_amount_by_year
    FROM accounting_reschedules r
    JOIN accounts da ON da.id = r.debit_account_id
    JOIN accounts ca ON ca.id = r.credit_account_id
    LEFT JOIN document_types dt ON dt.id = r.document_type_id
    LEFT JOIN companies c ON c.id = r.company_id
    WHERE r.is_euro = ${isEuro}
      AND (${f.number || null}::text IS NULL OR r.number ILIKE ${f.number ? `${f.number}%` : null}::text)
      AND (${like(f.name)}::text IS NULL OR r.name ILIKE ${like(f.name)}::text)
      AND (${f.documentTypeId ?? null}::int IS NULL OR r.document_type_id = ${f.documentTypeId ?? null}::int)
      AND (${like(f.documentNumber)}::text IS NULL OR r.document_number ILIKE ${like(f.documentNumber)}::text)
      AND (${f.debit || null}::text IS NULL OR da.number = ${f.debit || null}::text OR da.number LIKE ${f.debit ? `${f.debit}/%` : null}::text)
      AND (${f.credit || null}::text IS NULL OR ca.number = ${f.credit || null}::text OR ca.number LIKE ${f.credit ? `${f.credit}/%` : null}::text)
      AND (${like(f.reference)}::text IS NULL OR r.term ILIKE ${like(f.reference)}::text OR r.reference ILIKE ${like(f.reference)}::text)
      AND (${f.to || null}::date IS NULL OR r.from_date <= ${f.to || null}::date)
      AND (${f.from || null}::date IS NULL OR r.to_date >= ${f.from || null}::date)
    ORDER BY r.id`);
}

const toApi = (r: Row) => ({
  id: r.id, number: r.number, name: r.name, amount: dec(r.amount).toFixed(2), documentTypeId: r.document_type_id, documentName: r.document_name,
  documentNumber: r.document_number, documentDate: r.document_date, fromDate: r.from_date, toDate: r.to_date,
  debitAccount: r.debit_account, creditAccount: r.credit_account, companyName: r.company_name, term: r.term, reference: r.reference,
  lastProcessedMonth: r.last_processed_month, processedAmount: dec(r.processed_amount).toFixed(2),
  remainingAmount: dec(r.amount).minus(dec(r.processed_amount)).toFixed(2), processedAmountByFinYear: dec(r.processed_amount_by_year).toFixed(2),
});

export async function listReschedules(db: DbOrTx, f: RescheduleFilter, year: ActiveYear) {
  return (await rows(db, f, year.year >= 2026, null, year.year)).map(toApi);
}

const SORTS: Record<string, (a: ReturnType<typeof toApi>, b: ReturnType<typeof toApi>) => number> = {
  number: (a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'bg', { numeric: true }),
  name: (a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'bg'),
  startDate: (a, b) => a.fromDate.localeCompare(b.fromDate),
  documentDate: (a, b) => (a.documentDate ?? '').localeCompare(b.documentDate ?? ''),
  processed: (a, b) => dec(a.processedAmount).comparedTo(dec(b.processedAmount)),
  remaining: (a, b) => dec(a.remainingAmount).comparedTo(dec(b.remainingAmount)),
};

/** spAccountingReschedulesReport: values as of the period end (processed periods up to the end month). */
export async function reschedulesReport(db: DbOrTx, f: RescheduleFilter & { sort?: string }, year: ActiveYear) {
  const list = (await rows(db, f, year.year >= 2026, f.to ? `${f.to.slice(0, 7)}-01` : null, year.year)).map(toApi);
  list.sort(SORTS[f.sort ?? 'number'] ?? SORTS.number!);
  const total = (k: 'amount' | 'processedAmount' | 'remainingAmount' | 'processedAmountByFinYear') => list.reduce((a, r) => a.plus(dec(r[k])), ZERO).toFixed(2);
  return { rows: list, totals: { amount: total('amount'), processedAmount: total('processedAmount'), remainingAmount: total('remainingAmount'), processedAmountByFinYear: total('processedAmountByFinYear') } };
}

export async function deleteReschedule(db: DbOrTx, id: number) {
  const [r] = await db.select({ id: s.accountingReschedules.id }).from(s.accountingReschedules).where(eq(s.accountingReschedules.id, id));
  if (!r) throw notFound('Картонът');
  await db.delete(s.accountingReschedules).where(eq(s.accountingReschedules.id, id));
}

/**
 * Post every unprocessed period of the active year up to `toMonth` (inclusive):
 * one memorial order per period, dated the last day of the period month,
 * Dr debit / Cr credit for the period amount. Runs inside the caller's
 * transaction, so a locked month or any other critical error rolls back the batch.
 */
export async function processReschedules(db: DbOrTx, toMonth: string, ids: number[] | undefined, ctx: { year: ActiveYear; userId: number; branchId: number }) {
  const isEuro = ctx.year.year >= 2026;
  const limit = `${toMonth}-01`;
  const cards = await db.select().from(s.accountingReschedules)
    .where(and(eq(s.accountingReschedules.isEuro, isEuro), ids?.length ? inArray(s.accountingReschedules.id, ids) : undefined));
  const created: { id: number; number: string; rescheduleId: number; month: string }[] = [];
  for (const card of cards) {
    const periods = await db.select().from(s.accountingRescheduleDetails)
      .where(and(eq(s.accountingRescheduleDetails.rescheduleId, card.id), eq(s.accountingRescheduleDetails.isProcessed, false),
        sql`${s.accountingRescheduleDetails.month} <= ${limit}::date`, sql`extract(year FROM ${s.accountingRescheduleDetails.month}) = ${ctx.year.year}`))
      .orderBy(asc(s.accountingRescheduleDetails.month));
    const docType = card.documentTypeId ? (await db.select().from(s.documentTypes).where(eq(s.documentTypes.id, card.documentTypeId)))[0] : undefined;
    // spec 03b (AccountingRequestsListViewModel): reference "Разсрочване по {тип документ} №{номер}".
    const reference = docType ? `Разсрочване по ${docType.name} №${card.documentNumber ?? ''}` : 'Разсрочване';
    for (const p of periods) {
      const date = rescheduleMonthEnd(p.month);
      try {
        const saved = await saveEntry(db, {
          accountingDate: date, documentDate: date, documentTypeId: DOCUMENT_TYPE.MemorialOrder, documentNumber: '',
          companyId: card.companyId, term: card.term || card.name || 'Разсрочване', reference, source: 'reschedule',
          debits: [{ accountId: card.debitAccountId, amount: dec(p.amount).toFixed(2), companyId: card.companyId }],
          credits: [{ accountId: card.creditAccountId, amount: dec(p.amount).toFixed(2), companyId: card.companyId }],
        }, { year: ctx.year, userId: ctx.userId, branchId: ctx.branchId });
        await db.update(s.accountingRescheduleDetails).set({ isProcessed: true, accountingId: saved.id }).where(eq(s.accountingRescheduleDetails.id, p.id));
        created.push({ id: saved.id, number: saved.number, rescheduleId: card.id, month: p.month });
      } catch (e) {
        if (e instanceof ApiError) throw new ApiError(e.status, `Картон ${card.number ?? ''} „${card.name ?? ''}“, месец ${p.month.slice(5, 7)}.${p.month.slice(0, 4)}: ${e.message}`, e.messages, e.code);
        throw e;
      }
    }
  }
  return { created };
}
