import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_BANK_TEMPLATES, DOCUMENT_TYPE, KEYWORDS, POS_SERVICE_PARTNER, DataImportError, autoBindDocuments, bankModelProperties, critical, dec,
  decodeText, defaultTemplateTokens, isClientCategory, isCompanyCategory, isLeaf, mapStatementRows, mapperForBank, mergeBankRows, msg,
  normalizeIban, parseBankStatement, parseIbanList, round2, tokenizeCondition, validateBankRow, validateCondition, warning,
  type BankTemplateDef, type ExchangeMessage, type ConditionToken, type MappedBankRow, type MergeCriteria, type OpenDocument,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { ApiError } from '../../lib/errors.ts';
import { getBoolConfig, getConfig } from '../config.ts';
import { saveEntry } from '../journal.ts';
import { addPartnerIbans, checkDates, loadChart, throwIf } from './common.ts';
import { readWorkbook, sheetTable } from './xlsx.ts';
import type { ImportCtx } from './transfer.ts';

export const EXCLUDED_IBANS_KEY = 'BankImportExcludedIbans';

// ---------------------------------------------------------------------------
// Keywords

export async function keywords(db: DbOrTx) {
  let rows = await db.select().from(s.bankImportKeywords).orderBy(asc(s.bankImportKeywords.id));
  if (!rows.length && !(await getConfig(db, 'BankImportKeywordsSeeded'))) {
    await db.insert(s.bankImportKeywords).values(KEYWORDS.map((word) => ({ word })));
    await db.insert(s.configuration).values({ key: 'BankImportKeywordsSeeded', value: 'True', userId: null });
    rows = await db.select().from(s.bankImportKeywords).orderBy(asc(s.bankImportKeywords.id));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Own bank accounts

export async function ownBankAccounts(db: DbOrTx) {
  const rows = await db.select({
    id: s.bankAccounts.id, account: s.bankAccounts.account, bankId: s.bankAccounts.bankId, accountId: s.bankAccounts.bankStatementAccountId, isEuro: s.bankAccounts.isEuro,
    bankCode: s.banks.code, bankName: s.banks.name, accountNumber: s.accounts.number, accountDescription: s.accounts.description, currencyIso: s.currencies.isoCode,
  }).from(s.bankAccounts)
    .leftJoin(s.banks, eq(s.banks.id, s.bankAccounts.bankId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.bankAccounts.bankStatementAccountId))
    .leftJoin(s.currencies, eq(s.currencies.id, s.accounts.currencyId))
    .where(eq(s.bankAccounts.ownerType, 'my'))
    .orderBy(asc(s.bankAccounts.id));
  return rows;
}

// ---------------------------------------------------------------------------
// Templates

export interface TemplateInput {
  bankId: number;
  name: string;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  termText?: string;
  referenceText?: string;
  companyId?: number | null;
  isOwnAccounts?: boolean;
  mergeRowsOnImport?: boolean;
  priority?: number;
  formula: ConditionToken[] | string;
}

const toTokens = (f: ConditionToken[] | string) => (typeof f === 'string' ? tokenizeCondition(f) : f);

/** Editor validation (03a 9.4). */
export async function validateTemplate(db: DbOrTx, t: TemplateInput): Promise<ExchangeMessage[]> {
  const out: ExchangeMessage[] = [];
  if (!t.name?.trim()) out.push(critical('strMissingTemplateName'));
  let tokens: ConditionToken[] = [];
  try {
    tokens = toTokens(t.formula);
  } catch (e) {
    out.push(critical('strInvalidFomula', (e as Error).message));
  }
  if (tokens.length < 2) out.push(critical('strMissingCondition'));
  else {
    const err = validateCondition(tokens);
    if (err) out.push(critical('strInvalidFomula', err));
  }
  const ids = [t.debitAccountId, t.creditAccountId].filter((x): x is number => !!x);
  const accs = ids.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  if (!accs.length) out.push(critical('strMissingValidDebitOrCreditAccount'));
  for (const a of accs) if (!isLeaf({ left: a.leftIndex, right: a.rightIndex })) out.push(critical('strSelectedAccountHasAtLeastOneSubAccount'));
  if (t.mergeRowsOnImport && !t.companyId) out.push(warning('strMergeRowsValidationError'));
  return out;
}

/** Sign of a template detail (9.2): +1 when the debit account is set, -1 when only the credit account is. */
function detailFor(debitId: number | null | undefined, creditId: number | null | undefined) {
  return debitId ? { sign: 1, accountId: debitId, refAccountId: null } : { sign: -1, accountId: null, refAccountId: creditId ?? null };
}

export async function saveTemplate(db: DbOrTx, t: TemplateInput, userId: number, id?: number) {
  const msgs = await validateTemplate(db, t);
  if (msgs.some((m) => m.severity === 'critical')) throw new ApiError(422, msgs.find((m) => m.severity === 'critical')!.text, msgs);
  const merge = t.mergeRowsOnImport && !!t.companyId;
  const values = {
    bankId: t.bankId, name: t.name.trim(), termText: t.termText?.trim() ?? '', referenceText: t.referenceText?.trim() ?? '', companyId: t.companyId ?? null,
    priority: t.priority && t.priority < 10 ? t.priority : 10, isOwnAccounts: !!t.isOwnAccounts, mergeRowsOnImport: merge, formula: toTokens(t.formula), userId,
  };
  const accs = await db.select().from(s.accounts).where(inArray(s.accounts.id, [t.debitAccountId, t.creditAccountId].filter((x): x is number => !!x)));
  const isEuro = accs[0]?.isEuro ?? false;
  let templateId: number;
  if (id) {
    await db.update(s.bankTemplates).set(values).where(eq(s.bankTemplates.id, id));
    templateId = id;
  } else {
    const [row] = await db.insert(s.bankTemplates).values({ ...values, defaultFormula: values.formula }).returning({ id: s.bankTemplates.id });
    templateId = row!.id;
  }
  const d = detailFor(t.debitAccountId, t.creditAccountId);
  const [existing] = await db.select().from(s.bankTemplateDetails).where(and(eq(s.bankTemplateDetails.templateId, templateId), eq(s.bankTemplateDetails.isEuro, isEuro)));
  const detail = { ...d, accountNumber: null, companyId: t.companyId ?? null };
  if (existing) await db.update(s.bankTemplateDetails).set(detail).where(eq(s.bankTemplateDetails.id, existing.id));
  else await db.insert(s.bankTemplateDetails).values({ templateId, isEuro, ...detail });
  return { id: templateId, warnings: msgs.filter((m) => m.severity === 'warning') };
}

export async function listTemplates(db: DbOrTx, bankId: number | null, isEuro: boolean) {
  const rows = await db.select().from(s.bankTemplates).where(bankId ? eq(s.bankTemplates.bankId, bankId) : undefined).orderBy(asc(s.bankTemplates.priority), asc(s.bankTemplates.id));
  const ids = rows.map((r) => r.id);
  const details = ids.length ? await db.select().from(s.bankTemplateDetails).where(inArray(s.bankTemplateDetails.templateId, ids)) : [];
  const accs = await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts);
  const no = new Map(accs.map((a) => [a.id, a.number]));
  return rows.map((r) => {
    const d = details.find((x) => x.templateId === r.id && x.isEuro === isEuro) ?? null;
    return {
      ...r,
      detail: d,
      debitAccountId: d?.sign === 1 ? d.accountId : null,
      creditAccountId: d?.sign === -1 ? d.refAccountId : null,
      debitAccountNumber: d?.sign === 1 ? (d.accountId ? no.get(d.accountId) : d.accountNumber) ?? null : null,
      creditAccountNumber: d?.sign === -1 ? (d.refAccountId ? no.get(d.refAccountId) : d.accountNumber) ?? null : null,
      formulaText: r.formula.map((t) => (t.type === 'string' ? `"${t.value}"` : t.value)).join(' '),
    };
  });
}

/** Seeded defaults (03a 9.1, 9.2): one template per rule with a BGN and an EUR detail. */
export async function addDefaultTemplates(db: DbOrTx, bankId: number, userId: number) {
  const have = await db.select({ id: s.bankTemplates.id }).from(s.bankTemplates).where(eq(s.bankTemplates.bankId, bankId));
  if (have.length) return 0;
  const accs = await db.select({ id: s.accounts.id, number: s.accounts.number, isEuro: s.accounts.isEuro }).from(s.accounts);
  const find = (n: string | undefined, isEuro: boolean) => (n ? accs.find((a) => a.number === n && a.isEuro === isEuro)?.id ?? null : null);
  let pos: number | null = null;
  for (const d of DEFAULT_BANK_TEMPLATES) {
    let companyId: number | null = null;
    if (d.posPartner) {
      if (pos === null) {
        const [p] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.name, POS_SERVICE_PARTNER)).limit(1);
        pos = p?.id ?? (await db.insert(s.companies).values({ name: POS_SERVICE_PARTNER }).returning({ id: s.companies.id }))[0]!.id;
      }
      companyId = pos;
    }
    const tokens = defaultTemplateTokens(d);
    const [t] = await db.insert(s.bankTemplates).values({
      bankId, name: d.name, termText: d.name.toLowerCase(), priority: d.priority, formula: tokens, defaultFormula: tokens, userId, companyId,
    }).returning({ id: s.bankTemplates.id });
    for (const isEuro of [false, true]) {
      const debit = find(d.debit, isEuro);
      const credit = find(d.credit, isEuro);
      const sign = debit ? 1 : credit ? -1 : d.debit ? 1 : -1;
      await db.insert(s.bankTemplateDetails).values({
        templateId: t!.id, isEuro, sign, accountId: sign === 1 ? debit : null, refAccountId: sign === -1 ? credit : null,
        accountNumber: debit || credit ? null : (d.debit ?? d.credit ?? null), companyId,
      });
    }
  }
  return DEFAULT_BANK_TEMPLATES.length;
}

// ---------------------------------------------------------------------------
// Statement parsing and mapping

export interface ParseOptions {
  bankAccountId: number;
  termProperty?: string;
  referenceProperty?: string;
  mergeCriteria?: MergeCriteria;
  autoBind?: boolean;
}

async function partnerIndex(db: DbOrTx) {
  const comps = await db.select({ id: s.companies.id, name: s.companies.name }).from(s.companies).where(eq(s.companies.isDeleted, false));
  const ibans = await db.select({ ownerId: s.bankAccounts.ownerId, account: s.bankAccounts.account }).from(s.bankAccounts).where(eq(s.bankAccounts.ownerType, 'company'));
  const excluded = parseIbanList(await getConfig(db, EXCLUDED_IBANS_KEY));
  const byName = new Map(comps.map((c) => [c.name.trim().toLowerCase(), c]));
  const byId = new Map(comps.map((c) => [c.id, c]));
  const byIban = new Map<string, { id: number; name: string }>();
  for (const b of ibans) {
    const iban = normalizeIban(b.account);
    const c = byId.get(b.ownerId);
    if (c && iban && !excluded.has(iban) && !byIban.has(iban)) byIban.set(iban, c);
  }
  const findCompany = (iban: string, name: string) => {
    const i = normalizeIban(iban);
    if (i && !excluded.has(i) && byIban.has(i)) return byIban.get(i)!;
    return byName.get(name.trim().toLowerCase()) ?? null;
  };
  const isPartnerValue = (v: string) => {
    const t = v.trim();
    if (!t) return false;
    const i = normalizeIban(t);
    if (excluded.has(i)) return false;
    return byIban.has(i) || byName.has(t.toLowerCase());
  };
  return { findCompany, isPartnerValue };
}

export async function loadTemplateDefs(db: DbOrTx, bankId: number, isEuro: boolean): Promise<BankTemplateDef[]> {
  const list = await listTemplates(db, bankId, isEuro);
  return list.map((t) => ({
    id: t.id, name: t.name, priority: t.priority, formula: t.formula.length ? t.formula : t.defaultFormula, termText: t.termText, referenceText: t.referenceText,
    companyId: t.companyId, isOwnAccounts: t.isOwnAccounts, mergeRowsOnImport: t.mergeRowsOnImport,
    detail: t.detail ? { sign: t.detail.sign === 1 ? 1 : -1, accountId: t.detail.accountId, refAccountId: t.detail.refAccountId, accountNumber: t.detail.accountNumber } : null,
  }));
}

const bgDay = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d ?? '');

export async function parseStatementFile(db: DbOrTx, file: { fileName: string; bytes: Uint8Array }, o: ParseOptions, ctx: ImportCtx) {
  const [ba] = (await ownBankAccounts(db)).filter((b) => b.id === o.bankAccountId);
  if (!ba) throw new DataImportError(critical('strWrongFileOrBrokenStructures'));
  if (!ba.accountId) throw new DataImportError(critical('strMissingAccountingAccount'));
  const isXlsx = /\.xlsx$/i.test(file.fileName) || (file.bytes[0] === 0x50 && file.bytes[1] === 0x4b);
  const parsed = isXlsx
    ? parseBankStatement({ table: sheetTable((await readWorkbook(file.bytes))[0]!) }, ba.bankCode)
    : parseBankStatement({ text: decodeText(file.bytes) }, ba.bankCode);
  if (!parsed || !parsed.rows.length) throw new DataImportError(critical('strWrongFileOrBrokenStructures'));
  if (parsed.currency && ba.currencyIso && parsed.currency.toUpperCase() !== ba.currencyIso.trim().toUpperCase()) throw new DataImportError(critical('strCurrenciesAreNotTheSame'));
  const years = new Set(parsed.rows.map((r) => Number(r.date.slice(0, 4))));
  if (years.size !== 1 || !years.has(ctx.year.year)) throw new DataImportError(critical('strBankStatementDatesInDifferentYear'));

  const chart = await loadChart(db, ctx.year.year);
  const bankAcc = chart.byId.get(ba.accountId);
  const isForeign = !!bankAcc?.isForeignCurrency;
  const [cur] = bankAcc ? await db.select().from(s.currencies).where(eq(s.currencies.id, bankAcc.currencyId)) : [];
  const pidx = await partnerIndex(db);
  const templates = ba.bankId ? await loadTemplateDefs(db, ba.bankId, chart.isEuro) : [];
  let rows = mapStatementRows(parsed.rows, {
    bankAccountId: ba.accountId, templates, accountByNumber: (n) => chart.byNumber.get(n)?.id ?? null,
    isCompanyAccount: (id) => isCompanyCategory(chart.byId.get(id)?.categoryId), findCompany: pidx.findCompany, isPartnerValue: pidx.isPartnerValue,
    termProperty: o.termProperty, referenceProperty: o.referenceProperty, isForeignCurrency: isForeign, currencyRate: () => cur?.fixedRate ?? cur?.exchangeRate ?? null,
  });
  if (o.mergeCriteria && o.mergeCriteria !== 'none') rows = mergeBankRows(rows, o.mergeCriteria, new Set(templates.filter((t) => t.mergeRowsOnImport).map((t) => t.id)));
  const words = (await keywords(db)).map((k) => k.word);
  const bySum = await getBoolConfig(db, 'IsBindingBySumEnabled', true);
  const withDocs = await Promise.all(rows.map(async (r) => {
    let documents: (OpenDocument & { selected: boolean })[] = [];
    const partnerAcc = [r.debitAccountId, r.creditAccountId].find((id) => id && isCompanyCategory(chart.byId.get(id)?.categoryId));
    if (o.autoBind !== false && r.companyId && partnerAcc) {
      const isClient = isClientCategory(chart.byId.get(partnerAcc)?.categoryId);
      const open = await openDocuments(db, r.companyId, partnerAcc, isClient ? 1 : -1);
      const chosen = new Set(autoBindDocuments(r.reason, r.postAmount, open, words, bySum));
      documents = open.map((d, i) => ({ ...d, selected: chosen.has(i) }));
    }
    return { ...r, documents };
  }));
  const [last] = await db.select({ d: sql<string>`max(${s.accountings.accountingDate})` }).from(s.accountingDetails)
    .innerJoin(s.accountings, eq(s.accountings.id, s.accountingDetails.accountingId)).where(eq(s.accountingDetails.accountId, ba.accountId));
  return {
    header: msg('strBankStatementImportHeader', ba.account, ba.bankName ?? '', ba.accountNumber ?? '', bgDay(parsed.from), bgDay(parsed.to)),
    bankAccount: ba, format: parsed.format, model: parsed.model, currency: parsed.currency ?? ba.currencyIso, from: parsed.from, to: parsed.to,
    openingBalance: parsed.openingBalance, closingBalance: parsed.closingBalance, lastAccountingDate: last?.d ?? null,
    properties: bankModelProperties(ba.bankCode), mapper: mapperForBank(ba.bankCode).id, rows: withDocs,
  };
}

/** Open documents of a partner on a partner account (debit side for clients, credit side for suppliers). */
export async function openDocuments(db: DbOrTx, companyId: number, accountId: number, sign: 1 | -1): Promise<OpenDocument[]> {
  const rows = (await db.execute(sql`
    SELECT a.id, coalesce(doc.number, '') AS number, doc.document_type_id AS type,
      sum(CASE WHEN ${sign} = 1 THEN d.amount ELSE d.ref_amount END) AS total,
      coalesce((SELECT sum(p.amount) FROM accounting_payment_details p WHERE p.ref_accounting_id = a.id AND p.account_id = ${accountId}), 0) AS paid
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id LEFT JOIN documents doc ON doc.id = a.document_id
    WHERE d.company_id = ${companyId} AND d.account_id = ${accountId} AND d.sign = ${sign}
    GROUP BY a.id, doc.number, doc.document_type_id, a.accounting_date ORDER BY a.accounting_date, a.id`)) as unknown as { rows: { id: number; number: string; type: number | null; total: string; paid: string }[] };
  return rows.rows
    .map((r) => ({ accountingId: r.id, documentNumber: r.number, amount: round2(dec(r.total).minus(r.paid)).toFixed(2), isInvoice: r.type === DOCUMENT_TYPE.Invoice }))
    .filter((d) => dec(d.amount).greaterThan(0));
}

export interface PostRow {
  index: number;
  date: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
  companyId: number | null;
  companyName?: string;
  term: string;
  reference?: string;
  postAmount: string;
  currencyAmount?: string | null;
  exchangeRate?: string | null;
  templateId?: number | null;
  isOwnAccounts?: boolean;
  documents?: number[];
}

/** Apply (1.8, 1.10): validates the given rows; posts every row without critical errors. */
export async function postStatementRows(db: DbOrTx, rows: PostRow[], o: { customDocumentNumber?: string; ownAccountsTransfer?: boolean; force?: boolean }, ctx: ImportCtx) {
  const chart = await loadChart(db, ctx.year.year);
  const info = (id: number) => {
    const a = chart.byId.get(id);
    return a ? { isLeaf: a.isLeaf, isCompany: isCompanyCategory(a.categoryId) } : null;
  };
  const results: { index: number; status: 'posted' | 'skipped' | 'error'; id?: number; messages: ExchangeMessage[] }[] = [];
  const checks = rows.map((r) => ({ r, msgs: validateBankRow({ ...r, companyName: r.companyName ?? '' }, { activeYear: ctx.year.year, accountInfo: info }) }));
  throwIf(checkDates(rows.map((r) => r.date).filter(Boolean), ctx.year));
  if (!o.force && checks.some((c) => c.msgs.some((m) => m.severity === 'warning')) && !checks.some((c) => c.msgs.some((m) => m.severity === 'critical'))) {
    throw new ApiError(409, checks.flatMap((c) => c.msgs).find((m) => m.severity === 'warning')!.text, checks.flatMap((c) => c.msgs), 'confirm');
  }
  for (const { r, msgs } of checks) {
    if (msgs.some((m) => m.severity === 'critical')) {
      results.push({ index: r.index, status: 'error', messages: msgs });
      continue;
    }
    if (o.ownAccountsTransfer === false && r.isOwnAccounts) {
      results.push({ index: r.index, status: 'skipped', messages: [] });
      continue;
    }
    const docNumber = o.customDocumentNumber?.trim() || String(Number(r.date.slice(5, 7)));
    const dAcc = chart.byId.get(r.debitAccountId!)!;
    const cAcc = chart.byId.get(r.creditAccountId!)!;
    const amount = round2(r.postAmount).toFixed(2);
    const cur = (a: typeof dAcc) => (a.isForeignCurrency ? { currencyAmount: r.currencyAmount ?? null, exchangeRate: r.exchangeRate ?? null } : {});
    const saved = await saveEntry(db, {
      accountingDate: r.date, documentDate: r.date, documentTypeId: DOCUMENT_TYPE.BankStatement, documentNumber: docNumber, companyId: r.companyId,
      term: r.term, reference: r.reference || null, transactionTypeId: 1, source: 'bank-import',
      debits: [{ accountId: dAcc.id, amount, ...cur(dAcc) }], credits: [{ accountId: cAcc.id, amount, ...cur(cAcc) }],
    }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
    // Payment binding of the selected documents.
    const partnerAcc = isCompanyCategory(dAcc.categoryId) ? dAcc : isCompanyCategory(cAcc.categoryId) ? cAcc : null;
    if (r.documents?.length && partnerAcc && r.companyId) {
      const open = await openDocuments(db, r.companyId, partnerAcc.id, isClientCategory(partnerAcc.categoryId) ? 1 : -1);
      let left = dec(amount);
      for (const accId of r.documents) {
        const doc = open.find((d) => d.accountingId === accId);
        if (!doc || !left.greaterThan(0)) continue;
        const pay = dec(doc.amount).lessThan(left) ? dec(doc.amount) : left;
        const [h] = await db.select({ documentId: s.accountings.documentId }).from(s.accountings).where(eq(s.accountings.id, accId));
        await db.insert(s.accountingPaymentDetails).values({ paymentAccountingId: saved.id, refAccountingId: accId, documentId: h?.documentId ?? null, accountId: partnerAcc.id, companyId: r.companyId, amount: pay.toFixed(2) });
        left = left.minus(pay);
      }
    }
    results.push({ index: r.index, status: 'posted', id: saved.id, messages: msgs });
  }
  return { results, posted: results.filter((x) => x.status === 'posted').length };
}

export async function bindIbanToPartner(db: DbOrTx, companyId: number, iban: string) {
  await addPartnerIbans(db, companyId, [normalizeIban(iban)]);
}

export type { MappedBankRow };
