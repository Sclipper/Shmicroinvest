import { and, eq, or, sql } from 'drizzle-orm';
import { CATEGORY, decodeCp1251, fmtMessage, parseDiaryFile, TRANSACTION_TYPE, VAT_MESSAGES, type ImportedDocument } from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { saveEntry } from '../journal.ts';

/**
 * "Импорт от ДДС Дневници" (VATDiaryOperationsImportProvider, spec 04a 2):
 * POKUPKI.TXT / PRODAGBI.TXT lines back to accountings.
 */

export interface ImportAccounts {
  expense: number;
  vatPurchases: number | null;
  suppliers: number;
  customers: number;
  revenue: number;
  vatSales: number | null;
}

/** Leaf account of a category (else by number) in the chart of the active year. */
async function accountFor(db: DbOrTx, isEuro: boolean, category: number, number: string): Promise<number | null> {
  const rows = await queryRows<{ id: number }>(db, sql`
    SELECT a.id FROM accounts a
    WHERE a.is_euro = ${isEuro} AND (a.account_category_id = ${category} OR (a.number = ${number} AND a.account_category_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id)
    ORDER BY (a.account_category_id = ${category}) DESC NULLS LAST, a.number LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** Default accounts of the wizard: categories 602 / 453/1 / 401 and 411 / 703 / 453/2. */
export async function importDefaultAccounts(db: DbOrTx, year: number): Promise<Partial<ImportAccounts>> {
  const e = year > 2025;
  return {
    expense: (await accountFor(db, e, 38, '602')) ?? undefined,
    vatPurchases: await accountFor(db, e, CATEGORY.VatPurchases, '453/1'),
    suppliers: (await accountFor(db, e, CATEGORY.Suppliers, '401')) ?? undefined,
    customers: (await accountFor(db, e, CATEGORY.Customers, '411')) ?? undefined,
    revenue: (await accountFor(db, e, 25, '703')) ?? undefined,
    vatSales: await accountFor(db, e, CATEGORY.VatSales, '453/2'),
  };
}

const stripCountry = (v: string) => v.trim().replace(/^[A-Za-z]{2}/, '');

async function partnerFor(db: DbOrTx, vat: string, name: string, accountId: number, created: { n: number }) {
  const id = vat.trim();
  let companyId: number | null = null;
  if (id) {
    const [c] = await db.select({ id: s.companies.id }).from(s.companies)
      .where(and(eq(s.companies.isDeleted, false), or(eq(s.companies.vatNumber, id), eq(s.companies.bulstat, id), eq(s.companies.bulstat, stripCountry(id)))));
    companyId = c?.id ?? null;
  }
  if (!companyId && name.trim()) {
    const [c] = await db.select({ id: s.companies.id }).from(s.companies).where(and(eq(s.companies.isDeleted, false), eq(s.companies.name, name.trim())));
    companyId = c?.id ?? null;
  }
  if (!companyId) {
    const isVat = /^[A-Za-z]{2}/.test(id);
    const [c] = await db.insert(s.companies).values({
      name: name.trim() || id || 'Партньор', vatNumber: isVat ? id : null, bulstat: id ? stripCountry(id) : null, isVat,
    }).returning({ id: s.companies.id });
    companyId = c!.id;
    created.n++;
  }
  const [link] = await db.select().from(s.companyAccounts).where(and(eq(s.companyAccounts.companyId, companyId), eq(s.companyAccounts.accountId, accountId)));
  if (!link) await db.insert(s.companyAccounts).values({ companyId, accountId });
  return companyId;
}

const lastDay = (yyyymm: string) => {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Posts parsed diary documents. One accounting per posting (two when a purchase line has two VAT terms). */
export async function importDocuments(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, docs: ImportedDocument[], acc: ImportAccounts) {
  const created: { id: number; number: string; lineNumber: number; kind: string }[] = [];
  const partners = { n: 0 };
  for (const d of docs) {
    const viesMonth = `${d.line.period.slice(0, 4)}-${d.line.period.slice(4, 6)}-01`;
    const inYear = (date: string) => Number(date.slice(0, 4)) === ctx.year.year;
    const accountingDate = inYear(d.line.documentDate) ? d.line.documentDate : inYear(lastDay(d.line.period)) ? lastDay(d.line.period) : null;
    if (!accountingDate) throw new ApiError(422, `${VAT_MESSAGES.strWrongAccountingDate} (${d.kind === 'purchase' ? 'POKUPKI' : 'PRODAGBI'}, ред ${d.lineNumber})`);
    const isPurchase = d.kind === 'purchase';
    const partnerAccount = isPurchase ? acc.suppliers : acc.customers;
    const companyId = await partnerFor(db, d.line.partnerVat, d.line.partnerName, partnerAccount, partners);
    for (const p of d.postings) {
      const vatAccount = isPurchase ? acc.vatPurchases : acc.vatSales;
      if (!p.vat.isZero() && !vatAccount) throw new ApiError(422, fmtMessage('strVATNotAllowedInOperationErrorWithRowNumber', d.lineNumber, p.vat.toFixed(2)));
      const total = p.sum.plus(p.vat);
      if (total.isZero() && p.sum.isZero()) continue;
      const side = [
        { accountId: isPurchase ? acc.expense : acc.revenue, amount: p.sum.toFixed(2), vatTermId: p.vatTermId },
        ...(!p.vat.isZero() ? [{ accountId: vatAccount!, amount: p.vat.toFixed(2), vatTermId: p.vatTermId }] : []),
      ];
      const partnerLine = [{ accountId: partnerAccount, amount: total.toFixed(2), vatTermId: p.vatTermId, companyId }];
      const res = await saveEntry(db, {
        accountingDate, documentDate: d.line.documentDate, documentTypeId: d.documentTypeId, documentNumber: d.line.documentNumber,
        companyId, term: d.line.description || (isPurchase ? VAT_MESSAGES.strProductsDelivery : VAT_MESSAGES.strProductsSale),
        transactionTypeId: isPurchase ? TRANSACTION_TYPE.Purchase : TRANSACTION_TYPE.Sale, viesMonth, viesId: 1, source: 'vat-import',
        debits: isPurchase ? side : partnerLine,
        credits: isPurchase ? partnerLine : side,
      }, { ...ctx, force: true });
      created.push({ id: res.id, number: res.number, lineNumber: d.lineNumber, kind: d.kind });
    }
  }
  return { created, partnersCreated: partners.n };
}

export interface DiaryImportInput {
  /** File contents (cp1251 bytes). */
  purchases: Uint8Array | null;
  sales: Uint8Array | null;
  from?: string;
  to?: string;
  accounts?: Partial<ImportAccounts>;
}

export async function resolveImportAccounts(db: DbOrTx, year: number, overrides: Partial<ImportAccounts> = {}): Promise<ImportAccounts> {
  const d = { ...(await importDefaultAccounts(db, year)), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) } as Partial<ImportAccounts>;
  if (!d.expense || !d.suppliers || !d.customers || !d.revenue) throw new ApiError(422, 'Не са избрани сметки за импорт (Разходи за външни услуги, Доставчици, Клиенти, Продажби).');
  return { expense: d.expense, suppliers: d.suppliers, customers: d.customers, revenue: d.revenue, vatPurchases: d.vatPurchases ?? null, vatSales: d.vatSales ?? null };
}

export async function importVatDiaries(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, input: DiaryImportInput) {
  if (!input.purchases || !input.sales) throw new ApiError(422, VAT_MESSAGES.strFileNotFound);
  const period = { from: input.from ?? '1900-01-01', to: input.to ?? '2100-01-01' };
  const p = parseDiaryFile(decodeCp1251(input.purchases), 'purchase', period);
  if (p.error) throw new ApiError(422, `POKUPKI.TXT: ${p.error}`);
  const sl = parseDiaryFile(decodeCp1251(input.sales), 'sale', period);
  if (sl.error) throw new ApiError(422, `PRODAGBI.TXT: ${sl.error}`);
  const acc = await resolveImportAccounts(db, ctx.year.year, input.accounts);
  const res = await importDocuments(db, ctx, [...p.documents, ...sl.documents], acc);
  return { purchases: p.documents.length, sales: sl.documents.length, accountings: res.created.length, partnersCreated: res.partnersCreated, created: res.created };
}
