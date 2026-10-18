import { asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  buildLegs, dec, hasCritical, isCompanyCategory, isLeaf, isMonthLocked, JOURNAL_MESSAGES, linesFromLegs,
  reverseLines, round2, validateEntry, type AccountInfo, type EntryLine, type ValidationMessage, CHANNEL,
  exchangeRateOf, priceOf,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { accountingNumberUsed, reserveNumber } from './sequences.ts';
import { logActivity } from './audit.ts';

export interface LineInput {
  accountId: number;
  amount: string;
  companyId?: number | null;
  description?: string | null;
  vatTermId?: number | null;
  currencyAmount?: string | null;
  exchangeRate?: string | null;
  quantity?: string | null;
  price?: string | null;
}

export interface EntryInput {
  number?: string | null;
  accountingDate: string;
  documentDate?: string | null;
  documentTypeId: number | null;
  documentNumber?: string | null;
  companyId?: number | null;
  term: string;
  reference?: string | null;
  optionalReference?: string | null;
  paragraph?: string | null;
  transactionTypeId?: number;
  viesId?: number | null;
  viesMonth?: string | null;
  dueDate?: string | null;
  isInitialBalance?: boolean;
  isInitialCorrespondence?: boolean;
  source?: string;
  icaType?: number;
  deliveryDescription?: string | null;
  debits: LineInput[];
  credits: LineInput[];
}

export interface SaveContext {
  year: ActiveYear;
  userId: number;
  branchId?: number;
  /** Skip non-critical-only failure; critical messages always block. */
  force?: boolean;
  /** Validation keys to drop (system entries, e.g. revaluation legs that move only the base amount of a currency account). */
  ignoreKeys?: string[];
}

async function resolveDictionary(db: DbOrTx, table: typeof s.terms | typeof s.referenceTexts | typeof s.paragraphs, text: string | null | undefined) {
  const t = text?.trim();
  if (!t) return null;
  const [found] = await db.select({ id: table.id }).from(table).where(eq(table.description, t)).limit(1);
  if (found) return found.id;
  const [row] = await db.insert(table).values({ description: t.slice(0, 255) }).returning({ id: table.id });
  return row!.id;
}

export async function loadAccountInfos(db: DbOrTx, ids: number[], baseCurrencyId: number) {
  const rows = ids.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  const map = new Map<number, AccountInfo & { currencyId: number; productId: number | null; description: string }>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id, number: r.number, isLeaf: isLeaf({ left: r.leftIndex, right: r.rightIndex }) && r.number !== '0',
      categoryId: r.accountCategoryId, isForeignCurrency: r.currencyId !== baseCurrencyId, isMaterial: r.productId != null,
      currencyId: r.currencyId, productId: r.productId, description: r.description,
    });
  }
  return map;
}

export async function baseCurrencyId(db: DbOrTx, year: number) {
  const iso = year >= 2026 ? 'EUR' : 'BGN';
  const [c] = await db.select({ id: s.currencies.id }).from(s.currencies).where(eq(s.currencies.isoCode, iso));
  return c?.id ?? (year >= 2026 ? 2 : 1);
}

function toEntryLine(l: LineInput, headerCompanyId: number | null | undefined, info: (AccountInfo & { currencyId: number; productId: number | null }) | undefined, currencyRates: Map<number, string>): EntryLine {
  const isPartner = info && isCompanyCategory(info.categoryId);
  const amount = round2(l.amount || '0');
  let currency: EntryLine['currency'] = null;
  if (info?.isForeignCurrency) {
    const ca = dec(l.currencyAmount || '0');
    const rate = l.exchangeRate ? dec(l.exchangeRate) : exchangeRateOf(amount, ca);
    currency = { currencyId: info.currencyId, currencyAmount: ca.toFixed(2), exchangeRate: rate.toString(), fixedRate: currencyRates.get(info.currencyId) ?? '1' };
  }
  let material: EntryLine['material'] = null;
  if (info?.isMaterial && info.productId) {
    const q = dec(l.quantity || '0');
    material = { productId: info.productId, quantity: q.toString(), price: (l.price ? dec(l.price) : priceOf(amount, q)).toString() };
  }
  return {
    accountId: l.accountId,
    amount: amount.toFixed(2),
    companyId: isPartner ? (l.companyId ?? headerCompanyId ?? null) : null,
    vatTermId: l.vatTermId ?? 1,
    currency,
    material,
  };
}

export interface SaveResult {
  id: number;
  number: string;
  warnings: ValidationMessage[];
}

/** Create or replace a journal entry (AccountingViewModel save path, spec 02a section 4). */
export async function saveEntry(db: DbOrTx, input: EntryInput, ctx: SaveContext, existingId?: number): Promise<SaveResult> {
  const fy = ctx.year;
  let existing: typeof s.accountings.$inferSelect | undefined;
  if (existingId) {
    [existing] = await db.select().from(s.accountings).where(eq(s.accountings.id, existingId));
    if (!existing) throw notFound('Контирането');
    if (existing.financialYearId !== fy.id) throw badRequest(JOURNAL_MESSAGES.strWrongAccountingDate);
    if (fy.isLocked) throw badRequest(JOURNAL_MESSAGES.strVoidAccountingLockedYearWarning);
    const oldMonth = Number(existing.accountingDate.slice(5, 7));
    if (isMonthLocked(fy.lockedMonths, oldMonth)) throw badRequest(JOURNAL_MESSAGES.strLockedMonthOperation);
  }

  const baseCur = await baseCurrencyId(db, fy.year);
  const ids = [...new Set([...input.debits, ...input.credits].map((l) => l.accountId))];
  const infos = await loadAccountInfos(db, ids, baseCur);
  const curRows = await db.select({ id: s.currencies.id, fixedRate: s.currencies.fixedRate }).from(s.currencies);
  const rates = new Map(curRows.map((c) => [c.id, c.fixedRate]));
  const debits = input.debits.filter((l) => l.accountId).map((l) => toEntryLine(l, input.companyId, infos.get(l.accountId), rates));
  const credits = input.credits.filter((l) => l.accountId).map((l) => toEntryLine(l, input.companyId, infos.get(l.accountId), rates));

  const messages = validateEntry({
    accountingDate: input.accountingDate,
    documentTypeId: input.documentTypeId,
    documentNumber: input.documentNumber ?? '',
    term: input.term,
    transactionTypeId: input.transactionTypeId ?? 1,
    debits, credits,
    isInitialBalance: input.isInitialBalance,
  }, { activeYear: fy.year, lockedMonths: input.isInitialBalance ? 0 : fy.lockedMonths, accounts: infos });

  if (input.companyId) {
    const [c] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, input.companyId));
    if (!c) messages.push({ key: 'strMissingCompany', text: JOURNAL_MESSAGES.strMissingCompany, severity: 'critical' });
  }
  if (ctx.ignoreKeys?.length) for (let i = messages.length - 1; i >= 0; i--) if (ctx.ignoreKeys.includes(messages[i]!.key)) messages.splice(i, 1);
  if (hasCritical(messages)) throw new ApiError(422, JOURNAL_MESSAGES.strCannotCompleteOperation, messages);

  const termId = await resolveDictionary(db, s.terms, input.term);
  const referenceId = await resolveDictionary(db, s.referenceTexts, input.reference);
  const optionalReferenceId = await resolveDictionary(db, s.referenceTexts, input.optionalReference);
  const paragraphId = await resolveDictionary(db, s.paragraphs, input.paragraph);

  // Document row: shared by every entry with the same type/number/date.
  let documentId: number | null = null;
  const docNumber = input.documentNumber?.trim() ?? '';
  if (input.documentTypeId && (docNumber || input.documentDate)) {
    const docDate = input.documentDate || input.accountingDate;
    if (existing?.documentId) {
      const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.accountings).where(eq(s.accountings.documentId, existing.documentId))) as [{ n: number }];
      if (n === 1) {
        await db.update(s.documents).set({ number: docNumber, date: docDate, documentTypeId: input.documentTypeId }).where(eq(s.documents.id, existing.documentId));
        documentId = existing.documentId;
      }
    }
    if (!documentId) {
      const [d] = await db.insert(s.documents).values({ number: docNumber, date: docDate, documentTypeId: input.documentTypeId }).returning({ id: s.documents.id });
      documentId = d!.id;
    }
  }

  const isOpening = Boolean(input.isInitialBalance || input.isInitialCorrespondence);
  let number = input.number?.trim() ?? existing?.number ?? '';
  let sequenceId = existing?.sequenceId ?? null;
  const warnings = messages.filter((m) => m.severity === 'warning');
  if (!number && !isOpening) {
    const r = await reserveNumber(db, CHANNEL.Accounting, fy.id, (n) => accountingNumberUsed(db, fy.id, n));
    number = r.number;
    sequenceId = r.sequenceId;
  }

  const header = {
    financialYearId: fy.id,
    number,
    date: input.documentDate || input.accountingDate,
    accountingDate: input.accountingDate,
    viesMonth: input.viesMonth || `${input.accountingDate.slice(0, 7)}-01`,
    documentId,
    termId, referenceId, optionalReferenceId, paragraphId,
    transactionTypeId: input.transactionTypeId ?? 1,
    viesId: input.viesId ?? null,
    branchId: ctx.branchId ?? 1,
    userId: ctx.userId,
    sequenceId,
    dueDate: input.dueDate || null,
    isInitialBalance: Boolean(input.isInitialBalance),
    isInitialCorrespondence: Boolean(input.isInitialCorrespondence),
    icaType: input.icaType ?? 0,
    deliveryDescription: input.deliveryDescription ?? null,
    source: input.source ?? existing?.source ?? 'manual',
    updatedAt: new Date(),
  };

  let id: number;
  if (existing) {
    await db.update(s.accountings).set(header).where(eq(s.accountings.id, existing.id));
    await db.delete(s.accountingDetails).where(eq(s.accountingDetails.accountingId, existing.id));
    id = existing.id;
    if (existing.documentId && existing.documentId !== documentId) await deleteOrphanDocument(db, existing.documentId);
  } else {
    const [row] = await db.insert(s.accountings).values(header).returning({ id: s.accountings.id });
    id = row!.id;
    // Usage frequency triggers (01a 12.1): term and reference only.
    if (termId) await db.update(s.terms).set({ usageFrequency: sql`${s.terms.usageFrequency} + 1` }).where(eq(s.terms.id, termId));
    if (referenceId) await db.update(s.referenceTexts).set({ usageFrequency: sql`${s.referenceTexts.usageFrequency} + 1` }).where(eq(s.referenceTexts.id, referenceId));
  }

  const descriptions = new Map<number, string | null | undefined>();
  for (const l of [...input.debits, ...input.credits]) if (l.description) descriptions.set(l.accountId, l.description);
  const legs = buildLegs(debits, credits);
  if (legs.length) {
    await db.insert(s.accountingDetails).values(legs.map((l, i) => ({
      accountingId: id,
      accountId: l.accountId,
      refAccountId: l.refAccountId,
      companyId: l.companyId,
      vatTermId: l.vatTermId,
      amount: l.amount.toFixed(2),
      refAmount: l.refAmount.toFixed(2),
      sign: l.sign,
      description: descriptions.get(l.accountId) ?? null,
      currencyId: l.currency?.currencyId ?? null,
      currencyAmount: l.currency ? dec(l.currency.currencyAmount).toFixed(2) : null,
      exchangeRate: l.currency ? dec(l.currency.exchangeRate).toFixed(6) : null,
      fixedRate: l.currency ? dec(l.currency.fixedRate).toFixed(6) : null,
      productId: l.material?.productId ?? null,
      quantity: l.material ? dec(l.material.quantity).toFixed(6) : null,
      price: l.material ? dec(l.material.price).toFixed(6) : null,
      position: i,
    })));
  }
  await logActivity(db, ctx.userId, existing ? 'edit' : 'add', 'accounting', id, `Контиране ${number}`);
  return { id, number, warnings };
}

async function deleteOrphanDocument(db: DbOrTx, documentId: number) {
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.accountings).where(eq(s.accountings.documentId, documentId))) as [{ n: number }];
  const [{ m }] = (await db.select({ m: sql<number>`count(*)::int` }).from(s.accountingPaymentDetails).where(eq(s.accountingPaymentDetails.documentId, documentId))) as [{ m: number }];
  if (n === 0 && m === 0) await db.delete(s.documents).where(eq(s.documents.id, documentId));
}

/** Void (Изтриване, spec 02a 5.1, 01a 8.6). */
export async function deleteEntry(db: DbOrTx, id: number, year: ActiveYear, userId: number) {
  const [e] = await db.select().from(s.accountings).where(eq(s.accountings.id, id));
  if (!e) throw notFound('Контирането');
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, e.financialYearId));
  if (fy?.isLocked) throw badRequest(JOURNAL_MESSAGES.strVoidAccountingLockedYearWarning);
  if (fy && isMonthLocked(fy.lockedMonths, Number(e.accountingDate.slice(5, 7)))) throw badRequest(JOURNAL_MESSAGES.strLockedMonthOperation);
  void year;
  await db.delete(s.accountingPaymentDetails).where(or(eq(s.accountingPaymentDetails.paymentAccountingId, id), eq(s.accountingPaymentDetails.refAccountingId, id)));
  await db.delete(s.accountings).where(eq(s.accountings.id, id));
  if (e.documentId) await deleteOrphanDocument(db, e.documentId);
  await logActivity(db, userId, 'delete', 'accounting', id, `Контиране ${e.number}`);
}

/** Load an entry in editor shape: header + debit lines + credit lines. */
export async function loadEntry(db: DbOrTx, id: number) {
  const [e] = await db.select().from(s.accountings).where(eq(s.accountings.id, id));
  if (!e) throw notFound('Контирането');
  const details = await db.select().from(s.accountingDetails).where(eq(s.accountingDetails.accountingId, id)).orderBy(asc(s.accountingDetails.position));
  const doc = e.documentId ? (await db.select().from(s.documents).where(eq(s.documents.id, e.documentId)))[0] : undefined;
  const text = async (table: typeof s.terms, tid: number | null) => (tid ? (await db.select().from(table).where(eq(table.id, tid)))[0]?.description ?? '' : '');
  const grouped = linesFromLegs(details.map((d) => ({ ...d, accountId: d.accountId, amount: d.amount, refAmount: d.refAmount, sign: d.sign, companyId: d.companyId })));
  const toLine = (g: (typeof grouped.debits)[number]) => {
    const first = g.legs[0]!;
    const currencyAmount = g.legs.reduce((acc, l) => acc.plus(dec(l.currencyAmount ?? '0')), dec(0));
    const quantity = g.legs.reduce((acc, l) => acc.plus(dec(l.quantity ?? '0')), dec(0));
    return {
      accountId: g.accountId,
      companyId: g.companyId,
      amount: g.amount.toFixed(2),
      description: first.description,
      vatTermId: first.vatTermId,
      currencyId: first.currencyId,
      currencyAmount: first.currencyId ? currencyAmount.toFixed(2) : null,
      exchangeRate: first.exchangeRate,
      quantity: first.productId ? quantity.toString() : null,
      price: first.price,
    };
  };
  const companyId = details.find((d) => d.companyId)?.companyId ?? null;
  return {
    id: e.id,
    number: e.number,
    accountingDate: e.accountingDate,
    documentDate: doc?.date ?? e.date,
    documentTypeId: doc?.documentTypeId ?? null,
    documentNumber: doc?.number ?? '',
    companyId,
    term: await text(s.terms, e.termId),
    reference: await text(s.referenceTexts, e.referenceId),
    optionalReference: await text(s.referenceTexts, e.optionalReferenceId),
    paragraph: await text(s.paragraphs, e.paragraphId),
    transactionTypeId: e.transactionTypeId,
    viesId: e.viesId,
    viesMonth: e.viesMonth,
    dueDate: e.dueDate,
    isInitialBalance: e.isInitialBalance,
    isInitialCorrespondence: e.isInitialCorrespondence,
    source: e.source,
    financialYearId: e.financialYearId,
    debits: grouped.debits.map(toLine),
    credits: grouped.credits.map(toLine),
  };
}

/** Reversal draft (Сторно, spec 02a 5.2). Returned unsaved so the user can review it. */
export async function reversalDraft(db: DbOrTx, id: number, workingDate: string) {
  const e = await loadEntry(db, id);
  const docType = e.documentTypeId ? (await db.select().from(s.documentTypes).where(eq(s.documentTypes.id, e.documentTypeId)))[0] : undefined;
  const flip = <T extends { amount: string; currencyAmount: string | null; quantity: string | null; accountId: number }>(lines: T[]) => {
    const rev = reverseLines(lines.map((l) => ({
      accountId: l.accountId, amount: l.amount,
      currency: l.currencyAmount ? { currencyId: 0, currencyAmount: l.currencyAmount, exchangeRate: '0', fixedRate: '0' } : null,
      material: l.quantity ? { productId: 0, quantity: l.quantity, price: '0' } : null,
    })));
    return lines.map((l, i) => ({
      ...l,
      amount: String(rev[i]!.amount),
      currencyAmount: rev[i]!.currency ? String(rev[i]!.currency!.currencyAmount) : l.currencyAmount,
      quantity: rev[i]!.material ? String(rev[i]!.material!.quantity) : l.quantity,
    }));
  };
  return {
    ...e,
    id: undefined,
    number: '',
    accountingDate: workingDate,
    term: JOURNAL_MESSAGES.strReversalOperation,
    reference: docType ? `${docType.name} ${e.documentNumber}`.trim() : '',
    source: 'reversal',
    debits: flip(e.debits),
    credits: flip(e.credits),
  };
}

export async function entryYearCheck(db: DbOrTx, id: number) {
  const [e] = await db.select({ fy: s.accountings.financialYearId }).from(s.accountings).where(eq(s.accountings.id, id));
  return e?.fy;
}

