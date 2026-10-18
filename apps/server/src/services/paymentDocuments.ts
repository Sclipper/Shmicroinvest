import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  documentSumToText, effectiveCurrency, exportToUbb, limitPaymentDocumentFields, normalizeQtty, parseAmount, round2,
  PAYMENT_DOCUMENT_TYPES_DEF, STRING_FIELDS, type ExportResult, type PaymentDocumentFields, type PaymentDocumentTypeId,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { addDays } from '../session.ts';
import { logActivity } from './audit.ts';

/** Payment documents registry (spec 02c 1.6): list, batch save, copy, soft delete, diary, export. */

type Row = typeof s.paymentDocuments.$inferSelect;
const T = s.paymentDocuments;

export interface PaymentDocumentDto extends PaymentDocumentFields {
  id: number;
  documentType: number;
  /** ApplicationDate when added, "YYYY-MM-DDTHH:MM:SS". */
  date: string;
  isDeleted: boolean;
}

export type PaymentDocumentInput = Partial<PaymentDocumentFields> & { id?: number | null };

const naive = (d: Date) => d.toISOString().slice(0, 19);
const fromNaive = (v: string) => new Date(v.length === 10 ? `${v}T00:00:00Z` : `${v}Z`);

/** ApplicationDate.Now: the working date with the current Sofia wall-clock time. */
export function applicationNow(workingDate: string): Date {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_COMPANY ?? 'Europe/Sofia', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  return fromNaive(`${workingDate}T${time}`);
}

export function toDto(r: Row): PaymentDocumentDto {
  const { date, qtty, ...rest } = r;
  return { ...rest, qtty: round2(qtty).toFixed(2), date: naive(date) } as PaymentDocumentDto;
}

const DATE_FIELDS = ['issueDate', 'executionDate', 'documentDate', 'startDate', 'endDate'] as const;
const INT_FIELDS = ['taxes', 'paymentType', 'paymentType2', 'documentTypeCode'] as const;

/**
 * DocumentBaseViewModel.ApplyChanges: copy the view-model fields to the
 * entity (trim IssuePlace, LimitStringField to 50 or the view's MaxLength),
 * the amount as decimal(18,2) and InWords from the amount unless the user
 * typed it on a form that shows the field.
 */
export function entityValues(type: number, input: PaymentDocumentInput) {
  const f: Record<string, unknown> = {};
  for (const k of STRING_FIELDS) {
    const v = input[k];
    f[k] = v === undefined || v === null ? null : String(v);
  }
  for (const k of DATE_FIELDS) f[k] = input[k] ? String(input[k]).slice(0, 10) : null;
  for (const k of INT_FIELDS) {
    const v = input[k];
    f[k] = v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v));
  }
  const limited = limitPaymentDocumentFields(type, f as unknown as PaymentDocumentFields);
  // The currency column is 3 characters wide.
  if (limited.currency) limited.currency = limited.currency.slice(0, 3);
  const amount = parseAmount(normalizeQtty(input.qtty ?? '')) ?? round2(0);
  const qtty = round2(amount).abs().greaterThanOrEqualTo('1e16') ? '0' : round2(amount).toFixed(2);
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
  const typed = def?.editableInWords ? (input.inWords ?? '').trim() : '';
  const inWords = typed || documentSumToText(input.qtty, effectiveCurrency(limited.currency)) || null;
  return { ...limited, qtty, inWords };
}

export interface ListFilter {
  type: number;
  from?: string | null;
  to?: string | null;
  text?: string | null;
  bankId?: number | null;
  includeDeleted?: boolean;
}

export async function listDocuments(db: DbOrTx, f: ListFilter): Promise<PaymentDocumentDto[]> {
  const where: (SQL | undefined)[] = [eq(T.documentType, f.type)];
  if (f.from) where.push(gte(T.date, fromNaive(f.from)));
  if (f.to) where.push(lt(T.date, fromNaive(addDays(f.to.slice(0, 10), 1))));
  if (!f.includeDeleted) where.push(eq(T.isDeleted, false));
  const text = f.text?.trim();
  if (text) {
    const p = `%${text}%`;
    where.push(or(
      ilike(T.personName, p), ilike(T.personIban, p), ilike(T.customer, p), ilike(T.customerIban, p), ilike(T.reason, p),
      ilike(T.reasonEx, p), ilike(T.autorizedPerson, p), ilike(T.duePerson, p), ilike(T.bankName, p),
    ));
  }
  if (f.bankId) {
    const [bank] = await db.select().from(s.banks).where(eq(s.banks.id, f.bankId));
    if (bank) {
      // [I] the original's SelectedBank predicate is not known: a document belongs to a bank by either BIC or the header bank name.
      const code = (bank.code ?? '').toUpperCase();
      where.push(or(
        code ? sql`upper(${T.personBic}) = ${code}` : undefined,
        code ? sql`upper(${T.customerBic}) = ${code}` : undefined,
        bank.name ? ilike(T.bankName, bank.name) : undefined,
      ));
    }
  }
  const rows = await db.select().from(T).where(and(...where)).orderBy(asc(T.date), asc(T.id));
  return rows.map(toDto);
}

export async function getDocument(db: DbOrTx, id: number) {
  const [r] = await db.select().from(T).where(eq(T.id, id));
  return r ? toDto(r) : null;
}

/**
 * DocumentsListViewModel.ApplyChanges: every changed, non-deleted document
 * is written (no validation gate); new ones get Date = ApplicationDate.Now
 * and the document type.
 */
export async function saveDocuments(db: DbOrTx, userId: number, type: number, docs: PaymentDocumentInput[], now: Date) {
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
  const ids: number[] = [];
  for (const d of docs) {
    const values = entityValues(type, d);
    if (d.id) {
      const [cur] = await db.select({ id: T.id, isDeleted: T.isDeleted, documentType: T.documentType }).from(T).where(eq(T.id, d.id));
      if (!cur || cur.documentType !== type) throw new Error(`payment document ${d.id} not of type ${type}`);
      if (cur.isDeleted) continue;
      await db.update(T).set(values).where(eq(T.id, d.id));
      await logActivity(db, userId, 'edit', def.entityType, d.id, values.personName ?? values.customer ?? undefined);
      ids.push(d.id);
    } else {
      const [row] = await db.insert(T).values({ ...values, documentType: type, date: now }).returning({ id: T.id });
      await logActivity(db, userId, 'add', def.entityType, row!.id, values.personName ?? values.customer ?? undefined);
      ids.push(row!.id);
    }
  }
  const rows = ids.length ? await db.select().from(T).where(inArray(T.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, toDto(r)]));
  return ids.map((id) => byId.get(id)!);
}

/** "Нов документ от избрания": a clone without id, dated now; saved by the next ApplyChanges. */
export function copyDraft(src: PaymentDocumentDto, now: Date): Omit<PaymentDocumentDto, 'id'> & { id: null } {
  return { ...src, id: null, date: naive(now), isDeleted: false };
}

export async function softDelete(db: DbOrTx, userId: number, type: number, ids: number[]) {
  if (!ids.length) return 0;
  const rows = await db.update(T).set({ isDeleted: true })
    .where(and(inArray(T.id, ids), eq(T.documentType, type), eq(T.isDeleted, false))).returning({ id: T.id });
  const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
  for (const r of rows) await logActivity(db, userId, 'delete', def.entityType, r.id);
  return rows.length;
}

/** spPaymentsDiary: non-deleted documents of the id list, ordered by Date. */
export async function paymentsDiary(db: DbOrTx, ids: number[]) {
  if (!ids.length) return [];
  const rows = await db.select().from(T).where(and(inArray(T.id, ids), eq(T.isDeleted, false))).orderBy(asc(T.date), asc(T.id));
  return rows.map((r) => ({
    id: r.id,
    documentType: r.documentType,
    typeDescription: PAYMENT_DOCUMENT_TYPES_DEF[r.documentType as PaymentDocumentTypeId]?.description ?? '',
    customerIban: r.customerIban,
    receiver: r.personName,
    personIban: r.personIban,
    reason: r.reason,
    qtty: round2(r.qtty).toFixed(2),
    date: naive(r.date),
    personBic: r.personBic,
  }));
}

const distinct = (vals: (string | null)[]) => [...new Set(vals.map((v) => (v ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'bg'));

/** PersonNameList / PersonIBANList (same type), Orderers and OrderersIBANs from "Моята фирма". */
export async function suggestions(db: DbOrTx, type: number) {
  const used = await db.selectDistinct({ name: T.personName, iban: T.personIban }).from(T)
    .where(and(eq(T.documentType, type), eq(T.isDeleted, false)));
  const [my] = await db.select().from(s.myCompany).limit(1);
  const ibans = my
    ? await db.select({ account: s.bankAccounts.account }).from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.ownerType, 'my'), eq(s.bankAccounts.ownerId, my.id))).orderBy(asc(s.bankAccounts.id))
    : [];
  return {
    personNames: distinct(used.map((u) => u.name)),
    personIbans: distinct(used.map((u) => u.iban)),
    orderers: my ? [...new Set([my.contactName, my.name, my.accountant].map((v) => (v ?? '').trim()).filter(Boolean))] : [],
    orderersIbans: [...new Set(ibans.map((b) => b.account.trim()).filter(Boolean))],
  };
}

/**
 * "Банкови клонове" chooser: the header blocks (bank, branch, address, place)
 * already used on documents, most recent first.
 */
export async function recentBranches(db: DbOrTx) {
  const rows = await db.select({ bankName: T.bankName, bankBranch: T.bankBranch, bankAddress: T.bankAddress, issuePlace: T.issuePlace, date: T.date })
    .from(T).where(sql`coalesce(${T.bankName}, '') <> '' or coalesce(${T.bankBranch}, '') <> ''`).orderBy(desc(T.date));
  const seen = new Set<string>();
  const out: { bankName: string | null; bankBranch: string | null; bankAddress: string | null; issuePlace: string | null }[] = [];
  for (const r of rows) {
    const k = [r.bankName, r.bankBranch, r.bankAddress].join('\u0001');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ bankName: r.bankName, bankBranch: r.bankBranch, bankAddress: r.bankAddress, issuePlace: r.issuePlace });
  }
  return out;
}

/** Export of the checked documents to the UBB file (1.8). */
export async function exportDocuments(db: DbOrTx, userId: number, type: number, ids: number[], bankId: number | null): Promise<ExportResult> {
  const [bank] = bankId ? await db.select().from(s.banks).where(eq(s.banks.id, bankId)) : [];
  const rows = ids.length ? await db.select().from(T).where(and(inArray(T.id, ids), eq(T.documentType, type))).orderBy(asc(T.date), asc(T.id)) : [];
  const result = exportToUbb(type, bank?.code ?? null, rows.map(toDto));
  if (result.ok) {
    const def = PAYMENT_DOCUMENT_TYPES_DEF[type as PaymentDocumentTypeId];
    for (const r of rows.filter((x) => !x.isDeleted)) await logActivity(db, userId, 'export', def.entityType, r.id, result.fileName);
  }
  return result;
}
