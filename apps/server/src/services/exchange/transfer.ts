import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  DataImportError, ZERO, accountingLines, critical, dec, isCompanyCategory, msg, operationToLines, round2, warning, XML_OPERATION_CATEGORIES,
  type ClosingMode, type Dec, type ExchangeMessage, type TdAccounting, type TdCompany, type TdDetail, type TransferData, CHANNEL, DOCUMENT_TYPE,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { CompanyDb, DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { rebuildAccountsTree } from '../chart.ts';
import { saveEntry, type LineInput } from '../journal.ts';
import { documentNumberUsed } from '../autoEntries.ts';
import { closeDocumentsForImport } from '../documentsClosing.ts';
import { reserveNumber } from '../sequences.ts';
import { checkDates, currencyIdsByIso, findOrCreatePartner, loadChart, throwIf, type Chart, type ImportAccount } from './common.ts';
import { XML_PRODUCT_MESSAGES, importProduct } from './products.ts';

export interface ImportCtx { year: ActiveYear; userId: number; today: string }

// ---------------------------------------------------------------------------
// Accounts (3.5 / Excel 5.4)

export interface ChartAccountInput { number: string; description: string; englishDescription?: string; currency?: string; categoryId?: number | null; isActive?: boolean | null }

/**
 * Adds an account of the active chart; an existing number is reused untouched (XML), refused
 * (Excel, conflict mode Error) or updated (Excel, conflict mode Update: names, category and
 * character; the currency of an existing account cannot change).
 */
export async function importChartAccount(db: DbOrTx, chart: Chart, a: ChartAccountInput, opts: { duplicate: 'reuse' | 'update' | DataImportError; fail: (key: 'currency' | 'category' | 'parent' | 'synthetic', value: string) => DataImportError }) {
  const number = a.number.trim();
  const existing = chart.byNumber.get(number);
  const isos = await currencyIdsByIso(db);
  if (existing) {
    if (opts.duplicate === 'reuse') return { account: existing, created: false, updated: false };
    if (opts.duplicate !== 'update') throw opts.duplicate;
    const iso = a.currency?.trim().toUpperCase();
    if (iso && isos.get(iso) !== existing.currencyId) throw opts.fail('currency', iso);
    if (a.categoryId != null && !chart.categories.some((c) => c.id === a.categoryId)) throw opts.fail('category', String(a.categoryId));
    const set: Partial<typeof s.accounts.$inferInsert> = { description: a.description.trim().slice(0, 255) };
    if (a.englishDescription?.trim()) set.englishDescription = a.englishDescription.trim().slice(0, 255);
    if (a.categoryId != null) set.accountCategoryId = a.categoryId;
    if (a.isActive != null) set.isActive = a.isActive;
    await db.update(s.accounts).set(set).where(eq(s.accounts.id, existing.id));
    existing.description = set.description!;
    if (a.categoryId != null) existing.categoryId = a.categoryId;
    return { account: existing, created: false, updated: true };
  }
  const iso = (a.currency?.trim() || (chart.isEuro ? 'EUR' : 'BGN')).toUpperCase();
  const currencyId = isos.get(iso);
  if (!currencyId) throw opts.fail('currency', iso);
  if (a.categoryId != null && !chart.categories.some((c) => c.id === a.categoryId)) throw opts.fail('category', String(a.categoryId));
  const parentNo = number.includes('/') ? number.slice(0, number.lastIndexOf('/')) : '';
  const parent = parentNo ? chart.byNumber.get(parentNo) : chart.root;
  if (!parent) throw opts.fail('parent', number);
  if (!parentNo && currencyId !== chart.baseCurrencyId) throw opts.fail('synthetic', number);
  const [row] = await db.insert(s.accounts).values({
    parentId: parent.id, number, description: a.description.trim().slice(0, 255), englishDescription: a.englishDescription?.trim().slice(0, 255) ?? '',
    accountCategoryId: a.categoryId ?? (parentNo ? parent.categoryId : null), currencyId, isActive: a.isActive ?? null, isEuro: chart.isEuro,
  }).returning();
  const acc: ImportAccount = {
    id: row!.id, number, description: row!.description, categoryId: row!.accountCategoryId, currencyId, productId: null,
    isForeignCurrency: currencyId !== chart.baseCurrencyId, isMaterial: false, isLeaf: true, parentId: parent.id,
  };
  parent.isLeaf = false;
  chart.byNumber.set(number, acc);
  chart.byId.set(acc.id, acc);
  return { account: acc, created: true, updated: false };
}

const xmlAccountFail = (number: string) => (key: 'currency' | 'category' | 'parent' | 'synthetic', value: string) => {
  if (key === 'currency') return new DataImportError(critical('strXMLImportInvalidCurrencyForAccount', value, number));
  if (key === 'category') return new DataImportError(critical('strXMLImportInvalidCategory', value, number));
  if (key === 'synthetic') return new DataImportError(critical('strXMLImportSynteticAccountCurrency', number));
  return new DataImportError(critical('strAccountParentNotFound', number));
};

// ---------------------------------------------------------------------------
// Partners

export function tdPartner(c: TdCompany, accountIds: number[] = []) {
  const ibans = c.bankAccounts.length ? c.bankAccounts.map((b) => b.accountNumber) : c.legacyBankAccount ? [c.legacyBankAccount.accountNumber] : [];
  return {
    name: c.name, contactName: c.contactName, bulstat: c.bulstat, vatNumber: c.vatNumber, ibans,
    address: c.address ? { city: c.address.city, address: c.address.location, phone: c.address.phone, postalCode: c.address.postalCode } : null,
    accountIds,
  };
}

// ---------------------------------------------------------------------------
// Import

export interface XmlImportResult {
  accounts: number;
  partners: number;
  products: number;
  accountings: number;
  warnings: ExchangeMessage[];
  /** Payment pairs written by the documents closing after the import. */
  closedPairs?: number;
}

/** Category -> account mapping of wizard step 2 (default: account whose code equals the category's code). */
export async function xmlCategoryDefaults(db: DbOrTx, year: number) {
  const chart = await loadChart(db, year);
  return XML_OPERATION_CATEGORIES.map((c) => {
    const a = chart.byCategory(c.id);
    return { categoryId: c.id, name: c.name, accountId: a?.id ?? null, accountNumber: a?.number ?? null };
  });
}

/**
 * Imports a TransferData file (3.5): accounts, partners, products, then
 * accountings and operations; each set in its own transaction, a failing set
 * aborts the remaining ones (earlier sets stay saved). With closeDocuments
 * the imported accountings are closed against the open items after the save.
 */
export async function importTransferData(db: CompanyDb, data: TransferData, ctx: ImportCtx, categoryMap: Record<number, number | null> = {}, opts: { closeDocuments?: ClosingMode | null } = {}): Promise<XmlImportResult> {
  const result: XmlImportResult = { accounts: 0, partners: 0, products: 0, accountings: 0, warnings: [] };
  const fy = ctx.year;
  if (data.accounts?.length) {
    await db.transaction(async (tx) => {
      const chart = await loadChart(tx, fy.year);
      const sorted = [...data.accounts!].sort((a, b) => a.number.split('/').length - b.number.split('/').length);
      for (const a of sorted) {
        const r = await importChartAccount(tx, chart, { number: a.number, description: a.description, currency: a.currency, categoryId: a.category ?? null, isActive: a.isActive ?? null }, { duplicate: 'reuse', fail: xmlAccountFail(a.number) });
        if (r.created) result.accounts++;
      }
      await rebuildAccountsTree(tx);
    });
  }
  if (data.companies?.length) {
    await db.transaction(async (tx) => {
      const chart = await loadChart(tx, fy.year);
      for (const c of data.companies!) {
        const ids = c.companyAccounts.map((n) => {
          const a = chart.byNumber.get(n.trim());
          if (!a) throw new DataImportError(critical('strAccountNotFound', n));
          return a.id;
        });
        const r = await findOrCreatePartner(tx, tdPartner(c, ids));
        if (r?.created) result.partners++;
      }
    });
  }
  if (data.products?.length) {
    await db.transaction(async (tx) => {
      const chart = await loadChart(tx, fy.year);
      for (const p of data.products!) {
        const r = await importProduct(tx, chart, p, XML_PRODUCT_MESSAGES);
        if (r.created) result.products++;
      }
    });
  }
  const accountings = [...(data.accountings ?? [])];
  const ops = data.operations ?? [];
  if (accountings.length || ops.length) {
    await db.transaction(async (tx) => {
      const chart = await loadChart(tx, fy.year);
      const isos = await currencyIdsByIso(tx);
      // Operations -> accountings with the category mapping.
      for (const op of ops) {
        const lines = operationToLines(op);
        const toDetail = (direction: 'Debit' | 'Credit') => (l: { categoryId: number; amount: string; vatTerm: number }): TdDetail => {
          const mapped = categoryMap[l.categoryId] !== undefined ? (categoryMap[l.categoryId] ? chart.byId.get(categoryMap[l.categoryId]!) : null) : chart.byCategory(l.categoryId);
          if (!mapped) throw new DataImportError(critical('strXMLImportInvalidAccount', XML_OPERATION_CATEGORIES.find((c) => c.id === l.categoryId)?.name ?? String(l.categoryId)));
          return { accountNumber: mapped.number, amount: l.amount, direction, vatTerm: l.vatTerm };
        };
        accountings.push({
          accountingDate: op.date, viesMonth: op.viesMonth, term: op.term, reference: op.reference, vies: 1, vatTerm: op.vatTerm,
          document: op.document, company: op.company, ica: op.ica, line: op.line,
          details: [...lines.debits.map(toDetail('Debit')), ...lines.credits.map(toDetail('Credit'))],
        });
      }
      const dates = accountings.map((a) => a.accountingDate ?? ctx.today);
      for (const d of dates) if (Number(d.slice(0, 4)) !== fy.year) throw new DataImportError(critical('strOperationDateInDifferentFY', d.split('-').reverse().join('.'), 0));
      throwIf(checkDates(dates, fy));
      const viesIds = new Set((await tx.select({ id: s.vieses.id }).from(s.vieses)).map((v) => v.id));
      const cache = new Map<string, number>();
      const imported: number[] = [];
      for (const acc of accountings) {
        if (!viesIds.has(acc.vies)) throw new DataImportError(critical('strXMLImportInvalidVies', acc.vies));
        imported.push((await importAccounting(tx, chart, acc, isos, ctx, cache)).id);
        result.accountings++;
      }
      // Optional documents closing after the save (IsDocumentsClosingEnabled / SelectedWayOfSearching).
      if (opts.closeDocuments) result.closedPairs = (await closeDocumentsForImport(tx, fy, imported, ctx.userId, opts.closeDocuments)).length;
    });
  }
  return result;
}

async function importAccounting(tx: DbOrTx, chart: Chart, acc: TdAccounting, isos: Map<string, number>, ctx: ImportCtx, cache: Map<string, number>) {
  const lines = accountingLines(acc, new Set(isos.keys()));
  const resolve = (n: string) => {
    const a = chart.byNumber.get(n.trim());
    if (!a) throw new DataImportError(critical('strAccountNotFound', n));
    return a;
  };
  const toLine = (l: (typeof lines.debits)[number]): LineInput & { _acc: ImportAccount } => {
    const a = resolve(l.accountNumber);
    if (a.isMaterial !== !!l.material) throw new DataImportError(critical('strXMLImportInvalidProductAccount', a.number));
    return {
      _acc: a, accountId: a.id, amount: l.amount, vatTermId: l.vatTerm,
      currencyAmount: l.currency?.currencyAmount ?? null, exchangeRate: l.currency?.exchangeRate ?? null,
      quantity: l.material?.quantity ?? null, price: l.material?.price ?? null,
    };
  };
  const debits = lines.debits.map(toLine);
  const credits = lines.credits.map(toLine);
  const partnerAccounts = [...debits, ...credits].filter((l) => isCompanyCategory(l._acc.categoryId)).map((l) => l.accountId);
  const partner = acc.company ? await findOrCreatePartner(tx, tdPartner(acc.company, partnerAccounts), cache) : null;
  const date = acc.accountingDate ?? ctx.today;
  const strip = (l: LineInput & { _acc?: ImportAccount }): LineInput => {
    const { _acc, ...rest } = l;
    void _acc;
    return rest;
  };
  const saved = await saveEntry(tx, {
    accountingDate: date, documentDate: acc.document?.date ?? date, documentTypeId: acc.document?.documentType ?? null, documentNumber: acc.document?.number ?? '',
    companyId: partner?.id ?? null, term: acc.term ?? '', reference: acc.reference ?? null, optionalReference: acc.optionalReference ?? null,
    transactionTypeId: lines.transactionTypeId, viesId: acc.vies, viesMonth: acc.viesMonth ?? null, dueDate: acc.dueDate ?? null, source: 'import-xml',
    number: acc.number?.trim() || null, debits: debits.map(strip), credits: credits.map(strip),
  }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
  if (acc.ica) {
    const ica = acc.ica;
    const vatSale = chart.byCategory(17);
    const debitAcc = ica.terminateAssetCreditAccount ? chart.byNumber.get(ica.terminateAssetCreditAccount.trim()) : chart.byCategory(16);
    let number = ica.document.number?.trim() ?? '';
    if (!number && ica.document.documentType === DOCUMENT_TYPE.VatProtocol) {
      number = (await reserveNumber(tx, CHANNEL.VatProtocol, ctx.year.id, (n) => documentNumberUsed(tx, DOCUMENT_TYPE.VatProtocol, ctx.year.id, n))).number;
    }
    // Protocols without VAT (call-off stock, 163a, bread/flour) are imported too (04a 3.7 step 8).
    const vat = round2(ica.vatAmount ?? 0).toFixed(2);
    if (vatSale && debitAcc) {
      const icaEntry = await saveEntry(tx, {
        accountingDate: date, documentDate: ica.document.date ?? date, documentTypeId: ica.document.documentType, documentNumber: number,
        companyId: partner?.id ?? null, term: ica.term ?? '', reference: ica.reference ?? null, transactionTypeId: 2, viesMonth: ica.viesMonth ?? null,
        icaType: ica.icaType, deliveryDescription: ica.deliveryDescription ?? null, source: 'import-xml',
        debits: [{ accountId: debitAcc.id, amount: vat, vatTermId: ica.operationByVat || 2 }], credits: [{ accountId: vatSale.id, amount: vat, vatTermId: ica.operationByVat || 2 }],
      }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
      await tx.update(s.accountings).set({ icaAccountingId: icaEntry.id, icaType: ica.icaType }).where(eq(s.accountings.id, saved.id));
      if (ica.icaType163a) await tx.insert(s.accountingExtendedDetails).values({ accountingId: icaEntry.id, vatDiaryCode: String(ica.icaType163a).padStart(2, '0') });
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Export (3.4)

export interface XmlExportFilter { from: string; to: string; startNumber?: string | null; endNumber?: string | null }

export async function exportTransferData(db: DbOrTx, f: XmlExportFilter): Promise<{ data: TransferData; skippedManyToMany: number }> {
  const conds = [gte(s.accountings.accountingDate, f.from), lte(s.accountings.accountingDate, f.to)];
  if (f.startNumber?.trim()) conds.push(sql`${s.accountings.number} >= ${f.startNumber.trim()}`);
  if (f.endNumber?.trim()) conds.push(sql`${s.accountings.number} <= ${f.endNumber.trim()}`);
  const heads = await db.select().from(s.accountings).where(and(...conds)).orderBy(asc(s.accountings.accountingDate), asc(s.accountings.id));
  if (!heads.length) return { data: { accountings: [] }, skippedManyToMany: 0 };
  const ids = heads.map((h) => h.id);
  const details = await db.select().from(s.accountingDetails).where(inArray(s.accountingDetails.accountingId, ids)).orderBy(asc(s.accountingDetails.position), asc(s.accountingDetails.id));
  const accRows = await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts);
  const accNo = new Map(accRows.map((a) => [a.id, a.number]));
  const curRows = await db.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies);
  const curIso = new Map(curRows.map((c) => [c.id, c.iso]));
  const prodRows = await db.select({ id: s.products.id, name: s.products.name }).from(s.products);
  const prodName = new Map(prodRows.map((p) => [p.id, p.name]));
  const docIds = [...new Set(heads.map((h) => h.documentId).filter((x): x is number => !!x))];
  const docs = docIds.length ? await db.select().from(s.documents).where(inArray(s.documents.id, docIds)) : [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  const dict = async (t: typeof s.terms) => new Map((await db.select().from(t)).map((r) => [r.id, r.description]));
  const terms = await dict(s.terms);
  const refs = await dict(s.referenceTexts);
  const companyIds = [...new Set(details.map((d) => d.companyId).filter((x): x is number => !!x))];
  const companies = companyIds.length ? await db.select().from(s.companies).where(inArray(s.companies.id, companyIds)) : [];
  const banksAcc = companyIds.length ? await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'company'), inArray(s.bankAccounts.ownerId, companyIds))) : [];
  const bankRows = await db.select().from(s.banks);
  const bankById = new Map(bankRows.map((b) => [b.id, b]));
  const byAcc = new Map<number, typeof details>();
  for (const d of details) byAcc.set(d.accountingId, [...(byAcc.get(d.accountingId) ?? []), d]);
  const icaIds = heads.filter((h) => h.icaAccountingId).map((h) => h.icaAccountingId!);
  const icaHeads = icaIds.length ? await db.select().from(s.accountings).where(inArray(s.accountings.id, icaIds)) : [];
  const icaSet = new Set(icaIds);
  const icaDetails = icaIds.length ? await db.select().from(s.accountingDetails).where(inArray(s.accountingDetails.accountingId, icaIds)) : [];
  const icaDocIds = icaHeads.map((h) => h.documentId).filter((x): x is number => !!x);
  const icaDocs = icaDocIds.length ? await db.select().from(s.documents).where(inArray(s.documents.id, icaDocIds)) : [];
  const icaExt = icaIds.length ? await db.select().from(s.accountingExtendedDetails).where(inArray(s.accountingExtendedDetails.accountingId, icaIds)) : [];

  const out: TdAccounting[] = [];
  let skipped = 0;
  for (const h of heads) {
    if (icaSet.has(h.id)) continue; // exported inside its main accounting
    const legs = byAcc.get(h.id) ?? [];
    const dAcc = new Set(legs.filter((l) => l.sign === 1).map((l) => l.accountId));
    const cAcc = new Set(legs.filter((l) => l.sign === -1).map((l) => l.accountId));
    if (dAcc.size > 1 && cAcc.size > 1) {
      skipped++;
      continue;
    }
    // Group by (account, sign, VAT term); sums in decimal (amount = Amount + RefAmount).
    const groups = new Map<string, { d: TdDetail; amount: Dec; cur: Dec; qty: Dec }>();
    for (const l of legs) {
      const key = `${l.accountId}|${l.sign}|${l.vatTermId}`;
      let g = groups.get(key);
      if (!g) {
        const d: TdDetail = { accountNumber: accNo.get(l.accountId) ?? '', amount: '0', direction: l.sign === 1 ? 'Debit' : 'Credit', vatTerm: l.vatTermId };
        if (l.currencyId) d.currency = { currency: curIso.get(l.currencyId) ?? '', currencyAmount: '0', exchangeRate: l.exchangeRate ?? '0', fixedRate: l.fixedRate ?? '0' };
        if (l.productId) d.material = { productName: prodName.get(l.productId), quantity: '0', price: l.price ?? '0' };
        g = { d, amount: ZERO, cur: ZERO, qty: ZERO };
        groups.set(key, g);
      }
      g.amount = g.amount.plus(dec(l.amount)).plus(dec(l.refAmount));
      g.cur = g.cur.plus(dec(l.currencyAmount ?? 0));
      g.qty = g.qty.plus(dec(l.quantity ?? 0));
    }
    for (const g of groups.values()) {
      g.d.amount = round2(g.amount).toFixed(2);
      if (g.d.currency) g.d.currency.currencyAmount = round2(g.cur).toFixed(2);
      if (g.d.material) g.d.material.quantity = g.qty.toDecimalPlaces(6).toFixed(6);
    }
    const companyId = legs.find((l) => l.companyId)?.companyId;
    const company = companies.find((c) => c.id === companyId);
    const doc = h.documentId ? docById.get(h.documentId) : undefined;
    const item: TdAccounting = {
      accountingDate: h.accountingDate, dueDate: h.dueDate ?? undefined, number: h.number, reference: h.referenceId ? refs.get(h.referenceId) : undefined,
      optionalReference: h.optionalReferenceId ? refs.get(h.optionalReferenceId) : undefined, term: h.termId ? terms.get(h.termId) ?? '' : '',
      vies: h.viesId ?? 1, viesMonth: h.viesMonth, vatTerm: 0,
      document: doc ? { documentType: doc.documentTypeId, number: doc.number, date: doc.date } : undefined,
      company: company ? {
        name: company.name, bulstat: company.bulstat ?? undefined, vatNumber: company.vatNumber ?? undefined, companyAccounts: [],
        bankAccounts: banksAcc.filter((b) => b.ownerId === company.id).map((b) => ({ bankName: (b.bankId && bankById.get(b.bankId)?.name) || '', bankCode: (b.bankId && bankById.get(b.bankId)?.code) || '', accountNumber: b.account })),
      } : undefined,
      details: [...groups.values()].map((g) => g.d),
    };
    if (h.icaAccountingId) {
      const ih = icaHeads.find((x) => x.id === h.icaAccountingId);
      if (ih) {
        const il = icaDetails.filter((d) => d.accountingId === ih.id);
        const firstDebit = il.find((d) => d.sign === 1);
        const idoc = icaDocs.find((d) => d.id === ih.documentId);
        const code = icaExt.find((e) => e.accountingId === ih.id)?.vatDiaryCode;
        item.ica = {
          icaType: ih.icaType, viesMonth: ih.viesMonth, deliveryDescription: ih.deliveryDescription ?? undefined, reference: ih.referenceId ? refs.get(ih.referenceId) : undefined,
          term: ih.termId ? terms.get(ih.termId) : undefined, vatAmount: firstDebit ? round2(dec(firstDebit.amount).plus(dec(firstDebit.refAmount))).toFixed(2) : '0.00',
          document: idoc ? { documentType: idoc.documentTypeId, number: idoc.number, date: idoc.date } : { documentType: DOCUMENT_TYPE.VatProtocol, number: '', date: ih.accountingDate },
          icaType163a: code && /^\d+$/.test(code) ? Number(code) : 0, operationByVat: firstDebit?.vatTermId, terminateAssetCreditAccount: firstDebit ? accNo.get(firstDebit.accountId) : undefined,
        };
      }
    }
    out.push(item);
  }
  return { data: { accountings: out }, skippedManyToMany: skipped };
}

export const XML_EXPORT_MESSAGES = {
  empty: () => msg('strExportHaveNoAccountingsForSelectedCriteria'),
  writeOff: () => warning('strFilterHasWriteOffAccountings'),
};
