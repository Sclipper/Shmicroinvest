import { and, asc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import {
  dec, generateScheduleDates, SCHEDULE_MESSAGES, validateSchedule, type ScheduleDef, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { baseCurrencyId, saveEntry, type EntryInput, type LineInput } from './journal.ts';
import { reserveNumber } from './sequences.ts';

/** Accounting templates and their schedules (spec 02a 9.1, 9.2). */

export interface TemplateBody {
  name: string;
  documentTypeId?: number | null;
  term?: string | null;
  reference?: string | null;
  optionalReference?: string | null;
  paragraph?: string | null;
  transactionTypeId?: number;
  viesId?: number | null;
  companyId?: number | null;
  debits: LineInput[];
  credits: LineInput[];
  schedule?: ScheduleDef | null;
}

const crit = (key: keyof typeof SCHEDULE_MESSAGES): ValidationMessage => ({ key, text: SCHEDULE_MESSAGES[key], severity: 'critical' });
const nn = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Names are unique within a ledger (BGN templates up to 2025, EUR templates from 2026). */
async function assertName(db: DbOrTx, name: string, isEuro: boolean, exceptId?: number) {
  if (!name.trim()) throw new ApiError(422, SCHEDULE_MESSAGES.strTemplateNameError, [crit('strTemplateNameError')]);
  const same = await db.select({ id: s.accountingTemplates.id }).from(s.accountingTemplates)
    .where(and(sql`lower(trim(${s.accountingTemplates.name})) = lower(${name.trim()})`, eq(s.accountingTemplates.isEuro, isEuro), exceptId ? ne(s.accountingTemplates.id, exceptId) : undefined));
  if (same.length) throw new ApiError(422, SCHEDULE_MESSAGES.strTemplateNameExistWarning, [crit('strTemplateNameExistWarning')]);
}

async function writeLines(db: DbOrTx, templateId: number, body: TemplateBody) {
  await db.delete(s.accountingTemplateDetails).where(eq(s.accountingTemplateDetails.templateId, templateId));
  const lines = [...body.debits.map((l) => ({ l, sign: 1 })), ...body.credits.map((l) => ({ l, sign: -1 }))].filter((x) => x.l.accountId);
  if (!lines.length) return;
  const accs = await db.select().from(s.accounts).where(inArray(s.accounts.id, [...new Set(lines.map((x) => x.l.accountId))]));
  const byId = new Map(accs.map((a) => [a.id, a]));
  const rows = lines.map(({ l, sign }, i) => {
    const a = byId.get(l.accountId);
    if (!a) throw new ApiError(422, 'Въведена е невалидна сметка!', [{ key: 'strInvalidAccount', text: 'Въведена е невалидна сметка!', severity: 'critical' }]);
    return {
      templateId, sign, accountId: a.id, accountNumber: a.number, isEuro: a.isEuro,
      companyId: l.companyId ?? null, vatTermId: l.vatTermId ?? 1, amount: dec(l.amount || '0').toFixed(2), description: nn(l.description),
      currencyId: l.currencyAmount ? a.currencyId : null, currencyAmount: l.currencyAmount ?? null, exchangeRate: l.exchangeRate ?? null,
      productId: l.quantity ? a.productId : null, quantity: l.quantity ?? null, price: l.price ?? null, position: i,
    };
  });
  await db.insert(s.accountingTemplateDetails).values(rows);
}

async function writeSchedule(db: DbOrTx, templateId: number, sched: ScheduleDef | null | undefined) {
  if (sched === undefined) return;
  if (sched === null) {
    await db.delete(s.schedules).where(eq(s.schedules.templateId, templateId));
    return;
  }
  const msgs = validateSchedule(sched);
  if (msgs.length) throw new ApiError(422, msgs[0]!.text, msgs);
  const values = { mode: sched.mode, interval: sched.interval, weekDays: sched.weekDays, months: sched.months, days: sched.days, monthOptions: 0 };
  const [existing] = await db.select().from(s.schedules).where(eq(s.schedules.templateId, templateId));
  if (existing) await db.update(s.schedules).set(values).where(eq(s.schedules.id, existing.id));
  else await db.insert(s.schedules).values({ templateId, ...values });
}

export async function saveTemplate(db: DbOrTx, body: TemplateBody, ctx: { year: ActiveYear; userId: number; date: string }, id?: number) {
  if (id) {
    const [t] = await db.select({ id: s.accountingTemplates.id }).from(s.accountingTemplates).where(eq(s.accountingTemplates.id, id));
    if (!t) throw notFound('Шаблонът');
  }
  await assertName(db, body.name, ctx.year.year >= 2026, id);
  const header = {
    name: body.name.trim().slice(0, 255),
    documentTypeId: body.documentTypeId ?? null,
    termText: nn(body.term), referenceText: nn(body.reference), optionalReferenceText: nn(body.optionalReference), paragraphText: nn(body.paragraph),
    transactionTypeId: body.transactionTypeId ?? 1,
    viesId: body.viesId ?? null,
    companyId: body.companyId ?? null,
    isEuro: ctx.year.year >= 2026,
    userId: ctx.userId,
  };
  let templateId: number;
  if (id) {
    await db.update(s.accountingTemplates).set(header).where(eq(s.accountingTemplates.id, id));
    templateId = id;
  } else {
    const [row] = await db.insert(s.accountingTemplates).values({ ...header, date: ctx.date }).returning({ id: s.accountingTemplates.id });
    templateId = row!.id;
  }
  await writeLines(db, templateId, body);
  await writeSchedule(db, templateId, body.schedule);
  return { id: templateId };
}

export async function listTemplates(db: DbOrTx, q: { q?: string; account?: string; fast?: boolean }, year: ActiveYear) {
  const base = await baseCurrencyId(db, year.year);
  const rows = await db.select({
    id: s.accountingTemplates.id, name: s.accountingTemplates.name, documentTypeId: s.accountingTemplates.documentTypeId,
    documentTypeName: s.documentTypes.name, termText: s.accountingTemplates.termText, referenceText: s.accountingTemplates.referenceText,
    companyId: s.accountingTemplates.companyId, companyName: s.companies.name, transactionTypeId: s.accountingTemplates.transactionTypeId,
  }).from(s.accountingTemplates)
    .leftJoin(s.documentTypes, eq(s.documentTypes.id, s.accountingTemplates.documentTypeId))
    .leftJoin(s.companies, eq(s.companies.id, s.accountingTemplates.companyId))
    // Templates of the ledger of the active year (GetTemplates by IsEuro).
    .where(and(eq(s.accountingTemplates.isEuro, year.year >= 2026), q.q ? ilike(s.accountingTemplates.name, `%${q.q}%`) : undefined))
    .orderBy(asc(s.accountingTemplates.name));
  const ids = rows.map((r) => r.id);
  const details = ids.length
    ? await db.select({ d: s.accountingTemplateDetails, currencyId: s.accounts.currencyId, productId: s.accounts.productId })
      .from(s.accountingTemplateDetails).leftJoin(s.accounts, eq(s.accounts.id, s.accountingTemplateDetails.accountId))
      .where(inArray(s.accountingTemplateDetails.templateId, ids)).orderBy(asc(s.accountingTemplateDetails.position))
    : [];
  const scheduled = new Set(ids.length ? (await db.select({ t: s.schedules.templateId }).from(s.schedules).where(inArray(s.schedules.templateId, ids))).map((r) => r.t) : []);
  const out = rows.map((r) => {
    const lines = details.filter((x) => x.d.templateId === r.id);
    const dr = lines.filter((x) => x.d.sign > 0);
    const cr = lines.filter((x) => x.d.sign < 0);
    const plain = lines.every((x) => x.currencyId === base && x.productId == null);
    const isFast = dr.length === 1 && cr.length === 1 && plain;
    return {
      ...r,
      debitAccounts: dr.map((x) => x.d.accountNumber).join(', '),
      creditAccounts: cr.map((x) => x.d.accountNumber).join(', '),
      amount: dr.reduce((a, x) => a.plus(dec(x.d.amount)), dec(0)).toFixed(2),
      isFast,
      debitAccountId: isFast ? dr[0]!.d.accountId : null,
      creditAccountId: isFast ? cr[0]!.d.accountId : null,
      hasSchedule: scheduled.has(r.id),
    };
  });
  return out.filter((r) => (!q.fast || r.isFast) && (!q.account || [...r.debitAccounts.split(', '), ...r.creditAccounts.split(', ')].some((n) => n === q.account || n.startsWith(`${q.account}/`) || n.startsWith(q.account!))));
}

export async function loadTemplate(db: DbOrTx, id: number) {
  const [t] = await db.select().from(s.accountingTemplates).where(eq(s.accountingTemplates.id, id));
  if (!t) throw notFound('Шаблонът');
  const lines = await db.select().from(s.accountingTemplateDetails).where(eq(s.accountingTemplateDetails.templateId, id)).orderBy(asc(s.accountingTemplateDetails.position));
  const [schedule] = await db.select().from(s.schedules).where(eq(s.schedules.templateId, id));
  const companyName = t.companyId ? (await db.select({ n: s.companies.name }).from(s.companies).where(eq(s.companies.id, t.companyId)))[0]?.n ?? null : null;
  const line = (l: typeof lines[number]) => ({
    accountId: l.accountId, accountNumber: l.accountNumber, amount: dec(l.amount).toFixed(2), companyId: l.companyId, description: l.description,
    vatTermId: l.vatTermId, currencyAmount: l.currencyAmount, exchangeRate: l.exchangeRate, quantity: l.quantity, price: l.price, isEuro: l.isEuro,
  });
  return {
    ...t, companyName,
    term: t.termText ?? '', reference: t.referenceText ?? '', optionalReference: t.optionalReferenceText ?? '', paragraph: t.paragraphText ?? '',
    debits: lines.filter((l) => l.sign > 0).map(line),
    credits: lines.filter((l) => l.sign < 0).map(line),
    schedule: schedule ? { mode: schedule.mode, interval: schedule.interval, weekDays: schedule.weekDays, months: schedule.months, days: schedule.days } : null,
  };
}

/**
 * Entry draft from a template (LoadTemplate), in the loadEntry shape the editor
 * reads with fromServer(). Lines whose account belongs to the other chart
 * (BGN/EUR) are moved to the same-number account of the active chart.
 */
export async function templateDraft(db: DbOrTx, id: number, date: string, year: ActiveYear) {
  const t = await loadTemplate(db, id);
  const isEuro = year.year >= 2026;
  const chart = await db.select({ id: s.accounts.id, number: s.accounts.number, isEuro: s.accounts.isEuro }).from(s.accounts).where(eq(s.accounts.isEuro, isEuro));
  const byNumber = new Map(chart.map((a) => [a.number, a.id]));
  const ids = new Set(chart.map((a) => a.id));
  const map = (lines: typeof t.debits) => lines
    .map((l) => ({ ...l, accountId: l.accountId && ids.has(l.accountId) ? l.accountId : (l.accountNumber ? byNumber.get(l.accountNumber) ?? null : null) }))
    .filter((l) => l.accountId)
    .map((l) => ({
      accountId: l.accountId!, companyId: l.companyId ?? t.companyId ?? null, amount: l.amount, description: l.description, vatTermId: l.vatTermId,
      currencyId: null, currencyAmount: l.currencyAmount, exchangeRate: l.exchangeRate, quantity: l.quantity, price: l.price,
    }));
  return {
    number: '',
    accountingDate: date,
    documentDate: date,
    documentTypeId: t.documentTypeId,
    documentNumber: '',
    companyId: t.companyId,
    companyName: t.companyName,
    term: t.term,
    reference: t.reference,
    optionalReference: t.optionalReference,
    paragraph: t.paragraph,
    transactionTypeId: t.transactionTypeId,
    viesId: t.viesId,
    viesMonth: `${date.slice(0, 7)}-01`,
    dueDate: null,
    isInitialBalance: false,
    isInitialCorrespondence: false,
    source: 'template',
    templateId: t.id,
    templateName: t.name,
    debits: map(t.debits),
    credits: map(t.credits),
  };
}

export async function deleteTemplate(db: DbOrTx, id: number) {
  const [t] = await db.select({ id: s.accountingTemplates.id }).from(s.accountingTemplates).where(eq(s.accountingTemplates.id, id));
  if (!t) throw notFound('Шаблонът');
  // Schedules and their rows cascade; entries already generated stay.
  await db.delete(s.accountingTemplates).where(eq(s.accountingTemplates.id, id));
}

/**
 * GenerateTemplateSchedule for the active year: every unprocessed row of the
 * year is replaced; processed rows (already posted) are kept and their dates are
 * not generated again.
 */
export async function generateSchedule(db: DbOrTx, templateId: number, year: ActiveYear) {
  const [sched] = await db.select().from(s.schedules).where(eq(s.schedules.templateId, templateId));
  if (!sched) throw new ApiError(400, 'Шаблонът няма график за изпълнение.');
  const def = { mode: sched.mode, interval: sched.interval, weekDays: sched.weekDays, months: sched.months, days: sched.days };
  const msgs = validateSchedule(def);
  if (msgs.length) throw new ApiError(422, msgs[0]!.text, msgs);
  let dates: string[];
  try {
    dates = generateScheduleDates(def, year.year);
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
  const inYear = sql`${s.accountingTemplateSchedules.date} >= ${`${year.year}-01-01`} AND ${s.accountingTemplateSchedules.date} <= ${`${year.year}-12-31`}`;
  await db.delete(s.accountingTemplateSchedules).where(and(eq(s.accountingTemplateSchedules.scheduleId, sched.id), eq(s.accountingTemplateSchedules.isProcessed, false), inYear));
  const kept = new Set((await db.select({ d: s.accountingTemplateSchedules.date }).from(s.accountingTemplateSchedules)
    .where(and(eq(s.accountingTemplateSchedules.scheduleId, sched.id), inYear))).map((r) => r.d));
  const fresh = dates.filter((d) => !kept.has(d));
  if (fresh.length) await db.insert(s.accountingTemplateSchedules).values(fresh.map((date) => ({ templateId, scheduleId: sched.id, date, isProcessed: false })));
  return { generated: fresh.length, kept: kept.size };
}

export async function listScheduleRows(db: DbOrTx, q: { from?: string; to?: string; q?: string; processed?: string }) {
  return queryRows<{ id: number; date: string; template_id: number; template_name: string; is_processed: boolean; accounting_id: number | null; accounting_number: string | null }>(db, sql`
    SELECT r.id, r.date, r.template_id, t.name AS template_name, r.is_processed, r.accounting_id, a.number AS accounting_number
    FROM accounting_template_schedules r
    JOIN accounting_templates t ON t.id = r.template_id
    LEFT JOIN accountings a ON a.id = r.accounting_id
    WHERE (${q.from ?? null}::date IS NULL OR r.date >= ${q.from ?? null}::date)
      AND (${q.to ?? null}::date IS NULL OR r.date <= ${q.to ?? null}::date)
      AND (${q.q ? `%${q.q}%` : null}::text IS NULL OR t.name ILIKE ${q.q ? `%${q.q}%` : null}::text)
      AND (${q.processed === 'all' ? null : q.processed === '1'}::boolean IS NULL OR r.is_processed = ${q.processed === '1'})
    ORDER BY r.date, t.name, r.id`).then((rows) => rows.map((r) => ({
    id: r.id, date: r.date, templateId: r.template_id, templateName: r.template_name, isProcessed: r.is_processed, accountingId: r.accounting_id, accountingNumber: r.accounting_number,
  })));
}

const bg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Entry input from a template at a date; a missing document number is taken from the document type's sequence channel. */
export async function entryFromTemplate(db: DbOrTx, templateId: number, date: string, year: ActiveYear, source: string): Promise<EntryInput> {
  const d = await templateDraft(db, templateId, date, year);
  let documentNumber = '';
  if (d.documentTypeId) {
    const [dt] = await db.select().from(s.documentTypes).where(eq(s.documentTypes.id, d.documentTypeId));
    if (dt && dt.sequenceChannel > 0) {
      const r = await reserveNumber(db, dt.sequenceChannel, year.id, async (n) => (await db.select({ id: s.documents.id }).from(s.documents)
        .where(and(eq(s.documents.documentTypeId, dt.id), eq(s.documents.number, n))).limit(1)).length > 0);
      documentNumber = r.number;
    }
  }
  const line = (l: (typeof d.debits)[number]): LineInput => ({
    accountId: l.accountId, amount: l.amount, companyId: l.companyId, description: l.description, vatTermId: l.vatTermId,
    currencyAmount: l.currencyAmount, exchangeRate: l.exchangeRate, quantity: l.quantity, price: l.price,
  });
  return {
    accountingDate: date, documentDate: date, documentTypeId: d.documentTypeId, documentNumber, companyId: d.companyId,
    term: d.term || d.templateName, reference: d.reference || null, optionalReference: d.optionalReference || null, paragraph: d.paragraph || null,
    transactionTypeId: d.transactionTypeId, viesId: d.viesId, source,
    debits: d.debits.map(line), credits: d.credits.map(line),
  };
}

/**
 * Process selected schedule rows (TemplateSchedulesListViewModel). Rows of other
 * years are skipped with a warning; the rest are posted atomically (the caller
 * runs this in one transaction, so one failing row rolls back the batch).
 */
export async function processScheduleRows(db: DbOrTx, ids: number[], ctx: { year: ActiveYear; userId: number; branchId: number }) {
  if (!ids.length) throw new ApiError(400, 'Няма избрани шаблони за осчетоводяване.');
  const rows = await db.select({ r: s.accountingTemplateSchedules, name: s.accountingTemplates.name })
    .from(s.accountingTemplateSchedules).innerJoin(s.accountingTemplates, eq(s.accountingTemplates.id, s.accountingTemplateSchedules.templateId))
    .where(inArray(s.accountingTemplateSchedules.id, ids)).orderBy(asc(s.accountingTemplateSchedules.date));
  const warnings: ValidationMessage[] = [];
  const own = rows.filter((x) => !x.r.isProcessed && Number(x.r.date.slice(0, 4)) === ctx.year.year);
  if (rows.some((x) => Number(x.r.date.slice(0, 4)) !== ctx.year.year)) warnings.push({ key: 'strTemplateSchedulesFromAnotherYearFound', text: SCHEDULE_MESSAGES.strTemplateSchedulesFromAnotherYearFound, severity: 'warning' });
  const entries: { id: number; number: string; date: string }[] = [];
  for (const { r, name } of own) {
    try {
      const input = await entryFromTemplate(db, r.templateId, r.date, ctx.year, 'schedule');
      const saved = await saveEntry(db, input, { year: ctx.year, userId: ctx.userId, branchId: ctx.branchId });
      await db.update(s.accountingTemplateSchedules).set({ isProcessed: true, accountingId: saved.id }).where(eq(s.accountingTemplateSchedules.id, r.id));
      entries.push({ id: saved.id, number: saved.number, date: r.date });
    } catch (e) {
      if (e instanceof ApiError) throw new ApiError(e.status, `Шаблон „${name}“ от ${bg(r.date)}: ${e.message}`, e.messages, e.code);
      throw e;
    }
  }
  const message = entries.length
    ? SCHEDULE_MESSAGES.strOperationsTemplateSchedulesSuccess.replace('{0}', bg(entries[0]!.date)).replace('{1}', bg(entries[entries.length - 1]!.date))
    : '';
  return { processed: entries.length, entries, warnings, message };
}

