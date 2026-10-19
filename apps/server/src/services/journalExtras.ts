import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  CHANNEL, dec, distributeExpenses, fastRowAccountMessages, fastRowDuplicates, fastRowTransactionType, formatMessage,
  group60ClosingDrafts, hasCritical, isCompanyCategory, isMonthLocked, JOURNAL_EXTRA_MESSAGES as X, JOURNAL_MESSAGES,
  reorderNumbers, round2, TRANSACTION_TYPE, validateEntry, validateAttachment, validateMassEdit, isClientCategory, PAYMENT_ACCOUNT_CATEGORIES, PAYMENT_CATEGORIES,
  type FastRow, type MassEditAccount, type MassEditChanges, type MassEditEntry, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { getBoolConfig } from './config.ts';
import { baseCurrencyId, deleteEntry, loadAccountInfos, loadEntry, reversalDraft, saveEntry, type EntryInput, type LineInput, type SaveContext } from './journal.ts';
import { findSequence, formatSequenceNumber, reserveNumber } from './sequences.ts';
import { logActivity } from './audit.ts';

type Loaded = Awaited<ReturnType<typeof loadEntry>>;
const crit = (key: keyof typeof X, ...args: (string | number)[]): ValidationMessage => ({ key, text: formatMessage(X[key], ...args), severity: 'critical' });

/** Editor-shape entry (loadEntry output) -> save input. */
export function toEntryInput(e: Omit<Loaded, 'id'> & { id?: unknown }): EntryInput {
  const line = (l: Loaded['debits'][number]): LineInput => ({
    accountId: l.accountId, amount: l.amount, companyId: l.companyId, description: l.description, vatTermId: l.vatTermId,
    currencyAmount: l.currencyAmount, exchangeRate: l.exchangeRate, quantity: l.quantity, price: l.price,
  });
  return {
    number: null, accountingDate: e.accountingDate, documentDate: e.documentDate, documentTypeId: e.documentTypeId,
    documentNumber: e.documentNumber, companyId: e.companyId, term: e.term, reference: e.reference, optionalReference: e.optionalReference,
    paragraph: e.paragraph, transactionTypeId: e.transactionTypeId, viesId: e.viesId, viesMonth: null, dueDate: e.dueDate,
    isInitialBalance: e.isInitialBalance, isInitialCorrespondence: e.isInitialCorrespondence, source: e.source,
    debits: e.debits.map(line), credits: e.credits.map(line),
  };
}

// ---------------------------------------------------------------------------
// 7. List filter (AccountingFilter), shared by the journal list and mass edit

export type EntryFilter = Record<string, string | undefined>;

/** WHERE conditions of the journal list. Aliases: a = accountings, doc = documents, t = terms, r = reference_texts. */
export function entryFilterConditions(q: EntryFilter, year: ActiveYear): SQL[] {
  const from = q.from || `${year.year}-01-01`;
  const to = q.to || `${year.year}-12-31`;
  if (Number(from.slice(0, 4)) !== year.year) throw badRequest(X.strWrongStartDate, 'strWrongStartDate');
  if (Number(to.slice(0, 4)) !== year.year) throw badRequest(X.strWrongEndDate, 'strWrongEndDate');
  const conds: SQL[] = [sql`a.financial_year_id = ${year.id}`, sql`a.accounting_date >= ${from}`, sql`a.accounting_date <= ${to}`];
  if (q.initial === '1') conds.push(sql`a.is_initial_balance`);
  else if (q.initial !== 'all') conds.push(sql`NOT a.is_initial_balance`);
  if (q.numberFrom && /^\d+$/.test(q.numberFrom)) conds.push(sql`(CASE WHEN a.number ~ '^[0-9]+$' THEN a.number::numeric END) >= ${q.numberFrom}::numeric`);
  if (q.numberTo && /^\d+$/.test(q.numberTo)) conds.push(sql`(CASE WHEN a.number ~ '^[0-9]+$' THEN a.number::numeric END) <= ${q.numberTo}::numeric`);
  if (q.documentTypeId) conds.push(sql`doc.document_type_id = ${Number(q.documentTypeId)}`);
  if (q.documentNumber) conds.push(sql`doc.number ILIKE ${`%${q.documentNumber}%`}`);
  if (q.companyId) conds.push(sql`EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id = ${Number(q.companyId)})`);
  const accountSide = (number: string, sign: number | null) => {
    const like = `${number}/%`;
    return sql`EXISTS (SELECT 1 FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id WHERE x.accounting_id = a.id
      AND (xa.number = ${number} OR xa.number LIKE ${like} OR xa.number LIKE ${`${number}%`}) ${sign === null ? sql`` : sql`AND x.sign = ${sign}`})`;
  };
  if (q.account) conds.push(accountSide(q.account.trim(), null));
  if (q.debit) conds.push(accountSide(q.debit.trim(), 1));
  if (q.credit) conds.push(accountSide(q.credit.trim(), -1));
  const total = sql`(SELECT coalesce(sum(x.amount), 0) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1)`;
  if (q.amount) conds.push(sql`${total} = ${q.amount}::numeric`);
  if (q.amountFrom) conds.push(sql`${total} >= ${q.amountFrom}::numeric`);
  if (q.amountTo) conds.push(sql`${total} <= ${q.amountTo}::numeric`);
  if (q.term) conds.push(sql`t.description ILIKE ${`%${q.term}%`}`);
  if (q.reference) conds.push(sql`r.description ILIKE ${`%${q.reference}%`}`);
  if (q.transactionTypeId) conds.push(sql`a.transaction_type_id = ${Number(q.transactionTypeId)}`);
  if (q.vatTermId) conds.push(sql`EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.vat_term_id = ${Number(q.vatTermId)})`);
  if (q.viesMonth) conds.push(sql`to_char(a.vies_month, 'YYYY-MM') = ${q.viesMonth.slice(0, 7)}`);
  if (q.icaType) conds.push(sql`a.ica_type = ${Number(q.icaType)}`);
  if (q.hasAttachments === '1') conds.push(sql`EXISTS (SELECT 1 FROM accounting_attachments x WHERE x.accounting_id = a.id)`);
  if (q.text) {
    const like = `%${q.text}%`;
    conds.push(sql`(a.number ILIKE ${like} OR t.description ILIKE ${like} OR r.description ILIKE ${like} OR doc.number ILIKE ${like}
      OR EXISTS (SELECT 1 FROM accounting_details x LEFT JOIN companies xc ON xc.id = x.company_id WHERE x.accounting_id = a.id AND xc.name ILIKE ${like}))`);
  }
  return conds;
}

// ---------------------------------------------------------------------------
// 5.3 copy, 7 prev/next, 4.4 duplicate document

/** "Ново контиране от избраното": same lines/partner/document fields, new number, working date. */
export async function copyDraft(db: DbOrTx, id: number, workingDate: string) {
  const e = await loadEntry(db, id);
  return { ...e, id: undefined, version: undefined, number: '', accountingDate: workingDate, viesMonth: `${workingDate.slice(0, 7)}-01`, source: 'manual', isInitialBalance: false, isInitialCorrespondence: false };
}

/** GetPrev/NextAccounting: neighbour in the list order (date, number, id) within the active year. */
export async function neighbor(db: DbOrTx, year: ActiveYear, id: number, dir: 'prev' | 'next') {
  const [cur] = await db.select().from(s.accountings).where(eq(s.accountings.id, id));
  if (!cur) throw notFound('Контирането');
  const key = sql`(a.accounting_date, a.number, a.id)`;
  const pivot = sql`(${cur.accountingDate}::date, ${cur.number}::varchar, ${cur.id}::int)`;
  const r = await exec(db, sql`SELECT a.id, a.number FROM accountings a
    WHERE a.financial_year_id = ${year.id} AND a.is_initial_balance = ${cur.isInitialBalance}
      AND ${key} ${dir === 'next' ? sql`>` : sql`<`} ${pivot}
    ORDER BY a.accounting_date ${dir === 'next' ? sql`ASC` : sql`DESC`}, a.number ${dir === 'next' ? sql`ASC` : sql`DESC`}, a.id ${dir === 'next' ? sql`ASC` : sql`DESC`}
    LIMIT 1`);
  return (r.rows[0] as { id: number; number: string } | undefined) ?? null;
}

/** strDuplicatedDocumentWarning: same document type and number (and partner and transaction type when given). */
export async function duplicateDocuments(db: DbOrTx, p: { documentTypeId: number; documentNumber: string; companyId?: number | null; transactionTypeId?: number | null; excludeId?: number | null }) {
  const conds: SQL[] = [sql`doc.document_type_id = ${p.documentTypeId}`, sql`doc.number = ${p.documentNumber.trim()}`];
  if (p.transactionTypeId) conds.push(sql`a.transaction_type_id = ${p.transactionTypeId}`);
  if (p.companyId) conds.push(sql`EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id = ${p.companyId})`);
  if (p.excludeId) conds.push(sql`a.id <> ${p.excludeId}`);
  const r = await exec(db, sql`SELECT a.id, a.number, a.accounting_date FROM accountings a JOIN documents doc ON doc.id = a.document_id WHERE ${sql.join(conds, sql` AND `)} ORDER BY a.id LIMIT 20`);
  return r.rows as { id: number; number: string; accounting_date: string }[];
}

// ---------------------------------------------------------------------------
// 5.1 void with linked-data checks, 5.2 reversal without preview

export async function voidCheck(db: DbOrTx, ids: number[]) {
  if (!ids.length) return [];
  const rows = await db.select({ e: s.accountings, fy: s.financialYears }).from(s.accountings)
    .innerJoin(s.financialYears, eq(s.financialYears.id, s.accountings.financialYearId)).where(inArray(s.accountings.id, ids));
  const links = await exec(db, sql`
    SELECT p.payment_accounting_id, p.ref_accounting_id, pa.number AS payment_number, ra.number AS ref_number
    FROM accounting_payment_details p JOIN accountings pa ON pa.id = p.payment_accounting_id JOIN accountings ra ON ra.id = p.ref_accounting_id
    WHERE p.payment_accounting_id IN ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`} OR p.ref_accounting_id IN ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}`);
  const L = links.rows as { payment_accounting_id: number; ref_accounting_id: number; payment_number: string; ref_number: string }[];
  return rows.map(({ e, fy }) => ({
    id: e.id,
    number: e.number,
    lockedYear: fy.isLocked,
    lockedMonth: !e.isInitialBalance && isMonthLocked(fy.lockedMonths, Number(e.accountingDate.slice(5, 7))),
    // This entry pays liabilities -> strLiabilityAccountingAttachedWarning; it is paid by others -> strPaymentAccountingAttachedWarning.
    liabilityNumbers: [...new Set(L.filter((l) => l.payment_accounting_id === e.id).map((l) => l.ref_number))],
    paymentNumbers: [...new Set(L.filter((l) => l.ref_accounting_id === e.id).map((l) => l.payment_number))],
    depreciation: e.source === 'depreciation',
  }));
}

export async function voidMany(db: DbOrTx, ids: number[], year: ActiveYear, userId: number) {
  const checks = await voidCheck(db, ids);
  if (checks.length !== ids.length) throw notFound('Контирането');
  if (checks.some((c) => c.lockedYear)) throw badRequest(JOURNAL_MESSAGES.strVoidAccountingLockedYearWarning);
  if (checks.some((c) => c.lockedMonth)) throw badRequest(JOURNAL_MESSAGES.strLockedMonthOperation);
  for (const id of ids) await deleteEntry(db, id, year, userId);
  return { deleted: ids.length };
}

export async function saveReversal(db: DbOrTx, id: number, workingDate: string, ctx: SaveContext) {
  const draft = await reversalDraft(db, id, workingDate);
  return saveEntry(db, toEntryInput(draft as unknown as Loaded), ctx);
}

// ---------------------------------------------------------------------------
// 4.6 attachments

export async function listAttachments(db: DbOrTx, accountingId: number) {
  return db.select({ id: s.accountingAttachments.id, fileName: s.accountingAttachments.fileName, description: s.accountingAttachments.description, mimeType: s.accountingAttachments.mimeType, size: s.accountingAttachments.size })
    .from(s.accountingAttachments).where(eq(s.accountingAttachments.accountingId, accountingId)).orderBy(asc(s.accountingAttachments.id));
}

export async function addAttachment(db: DbOrTx, accountingId: number, a: { fileName: string; mimeType?: string | null; description?: string | null; data: Uint8Array }, userId: number) {
  if (!(await getBoolConfig(db, 'IsAllowAccountingAttachments', false))) throw badRequest('Прикачването на файлове е изключено в Настройки.');
  const [e] = await db.select({ id: s.accountings.id, number: s.accountings.number }).from(s.accountings).where(eq(s.accountings.id, accountingId));
  if (!e) throw notFound('Контирането');
  const errs = validateAttachment(a.fileName, a.data.byteLength);
  if (errs.length) throw new ApiError(422, errs[0]!.text, errs);
  const [row] = await db.insert(s.accountingAttachments).values({
    accountingId, fileName: a.fileName.slice(0, 1000), mimeType: (a.mimeType || 'application/octet-stream').slice(0, 255),
    description: (a.description ?? '').slice(0, 255), size: a.data.byteLength, data: a.data,
  }).returning({ id: s.accountingAttachments.id });
  await logActivity(db, userId, 'edit', 'accounting', accountingId, `Прикачен файл ${a.fileName} към контиране ${e.number}`);
  return { id: row!.id };
}

// ---------------------------------------------------------------------------
// 6. Mass edit

export interface MassEditInput extends MassEditChanges {
  ids: number[];
}

async function attachedNumbers(db: DbOrTx, ids: number[]) {
  const out = new Map<number, string[]>();
  if (!ids.length) return out;
  const list = sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
  const r = await exec(db, sql`
    SELECT p.payment_accounting_id AS id, ra.number FROM accounting_payment_details p JOIN accountings ra ON ra.id = p.ref_accounting_id WHERE p.payment_accounting_id IN ${list}
    UNION SELECT p.ref_accounting_id AS id, pa.number FROM accounting_payment_details p JOIN accountings pa ON pa.id = p.payment_accounting_id WHERE p.ref_accounting_id IN ${list}`);
  for (const row of r.rows as { id: number; number: string }[]) out.set(row.id, [...(out.get(row.id) ?? []), row.number]);
  return out;
}

async function resolveText(db: DbOrTx, table: typeof s.terms | typeof s.referenceTexts | typeof s.paragraphs, text: string | null | undefined) {
  const t = text?.trim();
  if (!t) return null;
  const [found] = await db.select({ id: table.id }).from(table).where(eq(table.description, t)).limit(1);
  if (found) return found.id;
  const [row] = await db.insert(table).values({ description: t.slice(0, 255) }).returning({ id: table.id });
  return row!.id;
}

/** Validates (02a 6.2) and applies (6.3) a mass edit in one transaction. */
export async function massEdit(db: DbOrTx, input: MassEditInput, year: ActiveYear, userId: number) {
  const ids = [...new Set(input.ids)];
  const heads = ids.length ? await db.select().from(s.accountings).where(inArray(s.accountings.id, ids)) : [];
  const details = ids.length ? await db.select().from(s.accountingDetails).where(inArray(s.accountingDetails.accountingId, ids)) : [];
  const accountRows = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, year.year >= 2026));
  const base = await baseCurrencyId(db, year.year);
  const infos = await loadAccountInfos(db, accountRows.map((a) => a.id), base);
  const byId = new Map(accountRows.map((a) => [a.id, a]));
  const accounts = new Map<string, MassEditAccount>();
  for (const a of accountRows) {
    const i = infos.get(a.id)!;
    accounts.set(a.number, { number: a.number, isLeaf: i.isLeaf, isForeignCurrency: i.isForeignCurrency, currencyId: a.currencyId, isMaterial: i.isMaterial, isCompany: isCompanyCategory(a.accountCategoryId) });
  }
  const attached = await attachedNumbers(db, ids);
  const entries: MassEditEntry[] = heads.map((h) => {
    const ds = details.filter((d) => d.accountingId === h.id);
    return {
      id: h.id, number: h.number, isMonthLocked: year.isLocked || isMonthLocked(year.lockedMonths, Number(h.accountingDate.slice(5, 7))),
      hasDocument: h.documentId != null, hasCompanyLine: ds.some((d) => isCompanyCategory(byId.get(d.accountId)?.accountCategoryId)),
      attachedNumbers: attached.get(h.id) ?? [],
      details: ds.map((d) => ({ accountNumber: byId.get(d.accountId)?.number ?? '', sign: d.sign })),
    };
  });
  if (heads.some((h) => h.financialYearId !== year.id)) throw badRequest(JOURNAL_MESSAGES.strWrongAccountingDate);
  if (input.newCompanyId) {
    const [c] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, input.newCompanyId));
    if (!c) throw new ApiError(422, X.strEditAccountings, [{ key: 'strMissingCompany', text: JOURNAL_MESSAGES.strMissingCompany, severity: 'critical' }]);
  }
  const messages = validateMassEdit(entries, input, { activeYear: year.year, accounts });
  if (messages.length) throw new ApiError(422, X.strEditAccountings, messages);

  const termId = await resolveText(db, s.terms, input.newTerm);
  const referenceId = await resolveText(db, s.referenceTexts, input.newReference);
  const optionalReferenceId = await resolveText(db, s.referenceTexts, input.newOptionalReference);
  const paragraphId = await resolveText(db, s.paragraphs, input.newParagraph);
  const fromCredit = !!input.fromCreditAccount?.trim();
  const fromNumber = (fromCredit ? input.fromCreditAccount : input.fromDebitAccount)?.trim() ?? '';
  const fromAcc = accountRows.find((a) => a.number === fromNumber);
  const toAcc = input.newAccount?.trim() ? accountRows.find((a) => a.number === input.newAccount!.trim()) : undefined;
  const sideSign = fromCredit ? -1 : 1;

  for (const h of heads) {
    const patch: Partial<typeof s.accountings.$inferInsert> = { updatedAt: new Date() };
    if (paragraphId) patch.paragraphId = paragraphId;
    if (optionalReferenceId) patch.optionalReferenceId = optionalReferenceId;
    if (termId) patch.termId = termId;
    if (referenceId) patch.referenceId = referenceId;
    if (input.newAccountingDate) patch.accountingDate = input.newAccountingDate;
    if (input.newViesMonth) patch.viesMonth = `${input.newViesMonth.slice(0, 7)}-01`;
    await db.update(s.accountings).set(patch).where(eq(s.accountings.id, h.id));
    if (input.newDocumentDate && h.documentId) {
      await db.update(s.documents).set({ date: input.newDocumentDate }).where(eq(s.documents.id, h.documentId));
      await db.update(s.accountings).set({ date: input.newDocumentDate }).where(eq(s.accountings.id, h.id));
    }
    const ds = details.filter((d) => d.accountingId === h.id);
    for (const d of ds) {
      const set: Partial<typeof s.accountingDetails.$inferInsert> = {};
      let accountId = d.accountId;
      if (fromAcc && toAcc) {
        if (d.accountId === fromAcc.id && d.sign === sideSign) {
          set.accountId = toAcc.id;
          accountId = toAcc.id;
          if (!isCompanyCategory(toAcc.accountCategoryId)) set.companyId = null;
        }
        // Counterpart legs name the replaced account in RefAccountID [I, recipe A5].
        if (d.refAccountId === fromAcc.id && d.sign === -sideSign) set.refAccountId = toAcc.id;
      }
      if (input.newCompanyId && isCompanyCategory(byId.get(accountId)?.accountCategoryId)) set.companyId = input.newCompanyId;
      if (Object.keys(set).length) await db.update(s.accountingDetails).set(set).where(eq(s.accountingDetails.id, d.id));
    }
    await logActivity(db, userId, 'edit', 'accounting', h.id, `Редакция на контировки: ${h.number}`);
  }
  return { updated: heads.length };
}

// ---------------------------------------------------------------------------
// 8.1 Fast entry

export interface FastEntryRow {
  templateId?: number | null;
  documentTypeId: number | null;
  documentNumber: string;
  date: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
  amount: string;
  debitVatTermId?: number | null;
  creditVatTermId?: number | null;
  companyId?: number | null;
  term: string;
  paymentAccountId?: number | null;
}

export interface RowMessage extends ValidationMessage {
  row: number;
}

/** Validates all rows; returns messages per row (critical = blocks the batch). */
export async function validateFastEntry(db: DbOrTx, rows: FastEntryRow[], year: ActiveYear): Promise<{ messages: RowMessage[]; inputs: EntryInput[] }> {
  const base = await baseCurrencyId(db, year.year);
  const ids = [...new Set(rows.flatMap((r) => [r.debitAccountId, r.creditAccountId, r.paymentAccountId].filter((x): x is number => !!x)))];
  const infos = await loadAccountInfos(db, ids, base);
  const vatTerms = new Map((await db.select().from(s.vatTerms)).map((v) => [v.id, v]));
  const docTypes = new Map((await db.select().from(s.documentTypes)).map((d) => [d.id, d]));
  const trTypes = new Map((await db.select().from(s.transactionTypes)).map((t) => [t.id, t.description]));
  const messages: RowMessage[] = [];
  const add = (row: number, m: ValidationMessage) => messages.push({ ...m, row, text: `Ред ${row + 1}: ${m.text}` });
  const info = (id: number | null | undefined) => (id ? infos.get(id) : undefined);
  const fastRows: FastRow[] = rows.map((r) => {
    const tt = fastRowTransactionType(vatTerms.get(r.debitVatTermId ?? 1)?.transactionTypeId ?? null, vatTerms.get(r.creditVatTermId ?? 1)?.transactionTypeId ?? null);
    const acc = (id: number | null | undefined) => {
      const a = info(id);
      return a ? { number: a.number, isLeaf: a.isLeaf, isForeignCurrency: a.isForeignCurrency, isMaterial: a.isMaterial, isCompany: isCompanyCategory(a.categoryId) } : undefined;
    };
    return { documentTypeId: r.documentTypeId, documentNumber: r.documentNumber ?? '', transactionTypeId: tt, companyId: r.companyId ?? null, debit: acc(r.debitAccountId), credit: acc(r.creditAccountId) };
  });
  const inputs: EntryInput[] = [];
  for (const [i, r] of rows.entries()) {
    const f = fastRows[i]!;
    for (const m of fastRowAccountMessages(f)) add(i, m);
    const input: EntryInput = {
      accountingDate: r.date, documentDate: r.date, documentTypeId: r.documentTypeId, documentNumber: r.documentNumber, companyId: r.companyId ?? null,
      term: r.term ?? '', transactionTypeId: f.transactionTypeId, source: 'fast',
      debits: r.debitAccountId ? [{ accountId: r.debitAccountId, amount: r.amount, companyId: r.companyId ?? null, vatTermId: r.debitVatTermId ?? 1 }] : [],
      credits: r.creditAccountId ? [{ accountId: r.creditAccountId, amount: r.amount, companyId: r.companyId ?? null, vatTermId: r.creditVatTermId ?? 1 }] : [],
    };
    inputs.push(input);
    const lineOf = (id: number | null) => (id ? [{ accountId: id, amount: round2(r.amount || '0').toFixed(2), companyId: isCompanyCategory(info(id)?.categoryId) ? r.companyId ?? null : null }] : []);
    for (const m of validateEntry({
      accountingDate: r.date || '', documentTypeId: r.documentTypeId, documentNumber: r.documentNumber ?? '', term: r.term ?? '', transactionTypeId: f.transactionTypeId,
      debits: lineOf(r.debitAccountId), credits: lineOf(r.creditAccountId),
    }, { activeYear: year.year, lockedMonths: year.lockedMonths, accounts: infos })) {
      if (m.key === 'strMaterialRequired' || m.key === 'strForeignCurrencyRequired') continue;
      add(i, m);
    }
    if (r.paymentAccountId) {
      const p = info(r.paymentAccountId);
      if (!p || ![...PAYMENT_CATEGORIES, ...PAYMENT_ACCOUNT_CATEGORIES].includes((p.categoryId ?? -1) as never) || !p.isLeaf) add(i, { key: 'strInvalidAccount', text: JOURNAL_MESSAGES.strInvalidAccount, severity: 'critical' });
      if (!r.companyId || !(f.debit?.isCompany || f.credit?.isCompany)) add(i, { key: 'strMissingCompany', text: JOURNAL_MESSAGES.strMissingCompany, severity: 'critical' });
    }
  }
  const dupRows = fastRowDuplicates(fastRows, (id) => docTypes.get(id)?.name ?? String(id));
  for (const [i, ms] of dupRows) for (const m of ms) add(i, m);
  // Against the database: warnings the user confirms.
  for (const [i, f] of fastRows.entries()) {
    if (f.documentTypeId == null || !f.documentNumber.trim()) continue;
    const purchase = f.transactionTypeId === TRANSACTION_TYPE.Purchase;
    const found = await duplicateDocuments(db, { documentTypeId: f.documentTypeId, documentNumber: f.documentNumber, transactionTypeId: f.transactionTypeId, companyId: purchase ? f.companyId : null });
    if (!found.length) continue;
    const dt = docTypes.get(f.documentTypeId)?.name ?? '';
    const tt = trTypes.get(f.transactionTypeId) ?? '';
    if (purchase) {
      const [c] = f.companyId ? await db.select({ name: s.companies.name }).from(s.companies).where(eq(s.companies.id, f.companyId)) : [];
      add(i, { key: 'strDuplicatedPurchaseDocumentExistsWithParams', severity: 'warning', text: formatMessage(X.strDuplicatedPurchaseDocumentExistsWithParams, f.documentNumber.trim(), dt, tt, c?.name ?? '') });
    } else {
      add(i, { key: 'strDuplicatedSaleDocumentExistsWithParams', severity: 'warning', text: formatMessage(X.strDuplicatedSaleDocumentExistsWithParams, f.documentNumber.trim(), dt, tt) });
    }
  }
  return { messages, inputs };
}

/** Saves all rows atomically (the caller runs it in one transaction); optional payment entry per row. */
export async function saveFastEntry(db: DbOrTx, rows: FastEntryRow[], ctx: SaveContext, force: boolean) {
  if (!rows.length) throw badRequest('Няма въведени редове.');
  const { messages, inputs } = await validateFastEntry(db, rows, ctx.year);
  if (hasCritical(messages)) throw new ApiError(422, JOURNAL_MESSAGES.strCannotCompleteOperation, messages);
  const warnings = messages.filter((m) => m.severity === 'warning');
  if (warnings.length && !force) throw new ApiError(409, 'Желаете ли продължение?', warnings, 'confirm');
  const saved: { id: number; number: string; paymentId?: number }[] = [];
  const base = await baseCurrencyId(db, ctx.year.year);
  for (const [i, input] of inputs.entries()) {
    const r = await saveEntry(db, input, ctx);
    const row = rows[i]!;
    const out: (typeof saved)[number] = { id: r.id, number: r.number };
    if (row.paymentAccountId && row.companyId) {
      const partnerLine = [...input.debits.map((l) => ({ ...l, side: 'debit' as const })), ...input.credits.map((l) => ({ ...l, side: 'credit' as const }))];
      const infos = await loadAccountInfos(db, partnerLine.map((l) => l.accountId), base);
      const p = partnerLine.find((l) => isCompanyCategory(infos.get(l.accountId)?.categoryId))!;
      // A receivable (debit on a client account) is collected: Dr payment / Cr partner; a liability is paid: Dr partner / Cr payment.
      const collect = p.side === 'debit' || isClientCategory(infos.get(p.accountId)?.categoryId);
      const docType = collect ? 8 : 9;
      const channel = collect ? CHANNEL.Pko : CHANNEL.Rko;
      const docNumber = (await reserveNumber(db, channel, ctx.year.id, async () => false, ctx.userId)).number;
      const amount = round2(row.amount).toFixed(2);
      const pay = await saveEntry(db, {
        accountingDate: row.date, documentDate: row.date, documentTypeId: docType, documentNumber: docNumber, companyId: row.companyId,
        term: row.term || (collect ? 'Плащане от клиент' : 'Плащане към доставчик'), source: 'fast-payment',
        debits: [{ accountId: collect ? row.paymentAccountId : p.accountId, amount, companyId: row.companyId }],
        credits: [{ accountId: collect ? p.accountId : row.paymentAccountId, amount, companyId: row.companyId }],
      }, ctx);
      const [payDoc] = await db.select({ documentId: s.accountings.documentId }).from(s.accountings).where(eq(s.accountings.id, pay.id));
      await db.insert(s.accountingPaymentDetails).values({ paymentAccountingId: pay.id, refAccountingId: r.id, documentId: payDoc?.documentId ?? null, accountId: p.accountId, companyId: row.companyId, amount, currencyAmount: '0' });
      out.paymentId = pay.id;
    }
    saved.push(out);
  }
  return { saved, warnings };
}

// ---------------------------------------------------------------------------
// 3. Renumbering (Преподреждане на документи)

export const REORDER_TYPES = {
  accounting: { channel: CHANNEL.Accounting, documentTypeId: null, label: 'Контиране' },
  pko: { channel: CHANNEL.Pko, documentTypeId: 8, label: 'ПКО' },
  rko: { channel: CHANNEL.Rko, documentTypeId: 9, label: 'РКО' },
  mo: { channel: CHANNEL.Mo, documentTypeId: 10, label: 'Мемориален ордер' },
} as const;

export async function reorder(db: DbOrTx, type: keyof typeof REORDER_TYPES, by: 'number' | 'date', year: ActiveYear, userId: number) {
  // BaseReorderType: any lock in the year disables renumbering (01b 6.2).
  if (year.isLocked || year.lockedMonths !== 0) throw badRequest(X.strLockedMonthOperation);
  const t = REORDER_TYPES[type];
  const seq = await findSequence(db, t.channel, year.id, userId);
  if (!seq) throw badRequest(`Няма номерация за канал ${t.channel}.`);
  let count = 0;
  if (t.documentTypeId === null) {
    const rows = await db.select({ id: s.accountings.id, number: s.accountings.number, date: s.accountings.accountingDate }).from(s.accountings)
      .where(and(eq(s.accountings.financialYearId, year.id), eq(s.accountings.isInitialBalance, false), ne(s.accountings.number, '')));
    const r = reorderNumbers(rows, by);
    for (const row of rows) await db.update(s.accountings).set({ number: formatSequenceNumber(seq, r.numbers.get(row.id)!), updatedAt: new Date() }).where(eq(s.accountings.id, row.id));
    count = r.count;
  } else {
    const docs = (await exec(db, sql`SELECT DISTINCT d.id, d.number, d.date FROM documents d JOIN accountings a ON a.document_id = d.id
      WHERE a.financial_year_id = ${year.id} AND d.document_type_id = ${t.documentTypeId}`)).rows as { id: number; number: string; date: string }[];
    const r = reorderNumbers(docs.map((d) => ({ ...d, date: String(d.date).slice(0, 10) })), by);
    for (const d of docs) await db.update(s.documents).set({ number: formatSequenceNumber(seq, r.numbers.get(d.id)!) }).where(eq(s.documents.id, d.id));
    count = r.count;
  }
  await db.update(s.sequences).set({ lastNumber: count }).where(eq(s.sequences.id, seq.id));
  await logActivity(db, userId, 'edit', 'accounting', null, `Преподреждане: ${t.label} по ${by === 'number' ? 'номер' : 'дата'}`);
  return { count, message: X.strReorderAccountingsComplete };
}

// ---------------------------------------------------------------------------
// 4.7 group-60 closing drafts, expenses distribution draft

export async function group60Drafts(db: DbOrTx, id: number) {
  const enabled = await getBoolConfig(db, 'IsAllowAccountingAutomaticEnd', false);
  const separate = enabled && (await getBoolConfig(db, 'IsShowSeperateAccountingsForeachAccountGroup60', false));
  const e = await loadEntry(db, id);
  const accs = e.debits.length ? await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts).where(inArray(s.accounts.id, e.debits.map((l) => l.accountId))) : [];
  const num = new Map(accs.map((a) => [a.id, a.number]));
  const drafts = group60ClosingDrafts({
    accountingDate: e.accountingDate, documentDate: e.documentDate, term: e.term, reference: e.reference, optionalReference: e.optionalReference,
    debits: e.debits.map((l) => ({ accountId: l.accountId, accountNumber: num.get(l.accountId) ?? '', amount: l.amount, companyId: l.companyId })),
  }, { enabled, separate });
  const blank = { companyId: null, description: '', vatTermId: 1, currencyAmount: null, exchangeRate: null, quantity: null, price: null };
  return drafts.map((d) => ({
    number: '', accountingDate: d.accountingDate, documentDate: d.documentDate, documentTypeId: d.documentTypeId, documentNumber: '',
    companyId: null, term: d.term, reference: d.reference, optionalReference: d.optionalReference, paragraph: '', transactionTypeId: d.transactionTypeId,
    viesId: null, viesMonth: `${d.accountingDate.slice(0, 7)}-01`, dueDate: null, isInitialBalance: false, source: 'group60',
    debits: [{ ...blank, accountId: null, amount: '' }],
    credits: d.credits.map((c) => ({ ...blank, accountId: c.accountId, amount: c.amount, companyId: c.companyId })),
  }));
}

export async function expensesDraft(db: DbOrTx, id: number, p: { amount: string; side: 'debit' | 'credit'; base: 'amount' | 'quantity' }, year: ActiveYear, workingDate: string) {
  const e = await loadEntry(db, id);
  const lines = p.side === 'debit' ? e.debits : e.credits;
  const infos = await loadAccountInfos(db, lines.map((l) => l.accountId), await baseCurrencyId(db, year.year));
  let shares;
  try {
    shares = distributeExpenses(p.amount, lines.map((l) => ({ accountId: l.accountId, amount: l.amount, quantity: l.quantity, isMaterial: infos.get(l.accountId)?.isMaterial })), p.base);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  const partner = new Map(lines.map((l) => [l.accountId, l.companyId]));
  const blank = { description: '', vatTermId: 1, currencyAmount: null, exchangeRate: null, quantity: null, price: null };
  const distributed = shares.map((x) => ({ ...blank, accountId: x.accountId, companyId: partner.get(x.accountId) ?? null, amount: x.amount.toFixed(2), quantity: infos.get(x.accountId)?.isMaterial ? '0' : null }));
  const other = [{ ...blank, accountId: null, companyId: null, amount: round2(p.amount).toFixed(2) }];
  return {
    number: '', accountingDate: workingDate, documentDate: workingDate, documentTypeId: e.documentTypeId, documentNumber: '', companyId: null,
    term: e.term, reference: formatMessage(X.strExpensesDistributionReferenceText, e.number), optionalReference: '', paragraph: '',
    transactionTypeId: e.transactionTypeId, viesId: null, viesMonth: `${workingDate.slice(0, 7)}-01`, dueDate: null, isInitialBalance: false, source: 'expenses',
    debits: p.side === 'debit' ? distributed : other,
    credits: p.side === 'debit' ? other : distributed,
  };
}

// ---------------------------------------------------------------------------
// 01b 7 initial correspondences (Начални кореспонденции, Alt+Y)

export interface CorrespondenceInput {
  date?: string | null;
  debitAccountId: number;
  creditAccountId: number;
  amount: string;
  debitCompanyId?: number | null;
  creditCompanyId?: number | null;
  documentTypeId?: number | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  debitCurrencyAmount?: string | null;
  creditCurrencyAmount?: string | null;
  debitQuantity?: string | null;
  creditQuantity?: string | null;
}

export function correspondenceToEntry(c: CorrespondenceInput, year: ActiveYear): EntryInput {
  const date = c.date || year.startDate;
  return {
    accountingDate: date, documentDate: c.documentDate || date, documentTypeId: c.documentTypeId ?? null, documentNumber: c.documentNumber ?? '',
    term: '', isInitialBalance: true, isInitialCorrespondence: true, source: 'initial-correspondence',
    debits: [{ accountId: c.debitAccountId, amount: c.amount, companyId: c.debitCompanyId ?? null, currencyAmount: c.debitCurrencyAmount ?? null, quantity: c.debitQuantity ?? null }],
    credits: [{ accountId: c.creditAccountId, amount: c.amount, companyId: c.creditCompanyId ?? null, currencyAmount: c.creditCurrencyAmount ?? null, quantity: c.creditQuantity ?? null }],
  };
}

export async function listCorrespondences(db: DbOrTx, year: ActiveYear) {
  const r = await exec(db, sql`
    SELECT a.id, a.accounting_date AS date, doc.document_type_id, dt.short_name AS document_type, doc.number AS document_number, doc.date AS document_date,
      dl.account_id AS debit_account_id, da.number AS debit_account, da.description AS debit_description, dl.company_id AS debit_company_id, dc.name AS debit_company,
      cl.account_id AS credit_account_id, ca.number AS credit_account, ca.description AS credit_description, cl.company_id AS credit_company_id, cc.name AS credit_company,
      dl.amount, dl.currency_amount AS debit_currency_amount, cl.currency_amount AS credit_currency_amount, dl.quantity AS debit_quantity, cl.quantity AS credit_quantity
    FROM accountings a
    JOIN accounting_details dl ON dl.accounting_id = a.id AND dl.sign = 1
    JOIN accounting_details cl ON cl.accounting_id = a.id AND cl.sign = -1 AND cl.position = dl.position + 1
    JOIN accounts da ON da.id = dl.account_id JOIN accounts ca ON ca.id = cl.account_id
    LEFT JOIN companies dc ON dc.id = dl.company_id LEFT JOIN companies cc ON cc.id = cl.company_id
    LEFT JOIN documents doc ON doc.id = a.document_id LEFT JOIN document_types dt ON dt.id = doc.document_type_id
    WHERE a.financial_year_id = ${year.id} AND a.is_initial_balance AND a.is_initial_correspondence
    ORDER BY da.number, ca.number, a.id`);
  const rows = r.rows as Record<string, unknown>[];
  // Account totals with nested analytic (partner) rows: Сметка, Описание, Дебит, Кредит.
  const totals = new Map<string, { account: string; description: string; debit: ReturnType<typeof dec>; credit: ReturnType<typeof dec>; partners: Map<string, { name: string; debit: ReturnType<typeof dec>; credit: ReturnType<typeof dec> }> }>();
  const bump = (account: string, description: string, company: string | null, side: 'debit' | 'credit', amount: string) => {
    const t = totals.get(account) ?? { account, description, debit: dec(0), credit: dec(0), partners: new Map() };
    t[side] = t[side].plus(dec(amount));
    if (company) {
      const p = t.partners.get(company) ?? { name: company, debit: dec(0), credit: dec(0) };
      p[side] = p[side].plus(dec(amount));
      t.partners.set(company, p);
    }
    totals.set(account, t);
  };
  for (const row of rows) {
    bump(String(row.debit_account), String(row.debit_description), (row.debit_company as string) ?? null, 'debit', String(row.amount));
    bump(String(row.credit_account), String(row.credit_description), (row.credit_company as string) ?? null, 'credit', String(row.amount));
  }
  const accounts = [...totals.values()].sort((a, b) => (a.account < b.account ? -1 : 1)).map((t) => ({
    account: t.account, description: t.description, debit: t.debit.toFixed(2), credit: t.credit.toFixed(2),
    partners: [...t.partners.values()].map((p) => ({ name: p.name, debit: p.debit.toFixed(2), credit: p.credit.toFixed(2) })),
  }));
  return { date: year.startDate, rows, accounts };
}

export async function assertCorrespondence(db: DbOrTx, id: number, year: ActiveYear) {
  const [e] = await db.select().from(s.accountings).where(eq(s.accountings.id, id));
  if (!e || !e.isInitialCorrespondence || e.financialYearId !== year.id) throw notFound('Кореспонденцията');
  return e;
}

/** Entries of the active year that are payment- or template-linked (used by the list "attachments/links" columns). */
export async function entryFlags(db: DbOrTx, ids: number[]) {
  if (!ids.length) return new Map<number, { attachments: number }>();
  const r = await db.select({ id: s.accountingAttachments.accountingId, n: sql<number>`count(*)::int` }).from(s.accountingAttachments)
    .where(inArray(s.accountingAttachments.accountingId, ids)).groupBy(s.accountingAttachments.accountingId);
  return new Map(r.map((x) => [x.id, { attachments: x.n }]));
}

