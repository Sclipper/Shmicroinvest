import { sql, type SQL } from 'drizzle-orm';
import { CATEGORY, type VatAccounting, type VatDetail, type VatPartner } from '@shmi/core';
import { queryRows, type DbOrTx } from '../../db/provider.ts';

/**
 * Loads accountings into the core VAT model (packages/core/src/vat/model.ts):
 * every accounting whose export month or accounting date falls in the window,
 * plus the siblings sharing its number (protocols) and its linked protocol.
 */

export interface VatAccountRef {
  id: number;
  number: string;
  categoryId: number;
  isEuro: boolean;
  isLeaf: boolean;
}

/** Accounts of the VAT categories (16, 17, 35, 36) of both charts. */
export async function vatCategoryAccounts(db: DbOrTx): Promise<VatAccountRef[]> {
  return (await queryRows<{ id: number; number: string; account_category_id: number; is_euro: boolean; is_leaf: boolean }>(db, sql`
    SELECT a.id, a.number, a.account_category_id, a.is_euro,
      NOT EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id) AS is_leaf
    FROM accounts a WHERE a.account_category_id IN (16, 17, 35, 36) ORDER BY a.number, a.id`))
    .map((r) => ({ id: r.id, number: r.number, categoryId: r.account_category_id, isEuro: r.is_euro, isLeaf: r.is_leaf }));
}

/** The VAT account of a category in the chart of the active year (IsEuro = year > 2025). */
export async function vatAccountsForYear(db: DbOrTx, year: number) {
  const all = await vatCategoryAccounts(db);
  const isEuro = year > 2025;
  const pick = (cat: number) => all.find((a) => a.categoryId === cat && a.isEuro === isEuro);
  return { purchases: pick(CATEGORY.VatPurchases), sales: pick(CATEGORY.VatSales), refund: pick(CATEGORY.VatRefundable), payable: pick(CATEGORY.VatPayable) };
}

export interface LoadWindow {
  from: string;
  to: string;
  /** Also load by accounting date (art. 73, protocols). Default true. */
  byAccountingDate?: boolean;
}

const prefixMatcher = (numbers: string[]) => (n: string | null) => !!n && numbers.some((p) => n === p || n.startsWith(p + '/'));

export async function loadVatAccountings(db: DbOrTx, w: LoadWindow): Promise<VatAccounting[]> {
  const byDate = w.byAccountingDate === false ? sql`FALSE` : sql`(accounting_date >= ${w.from} AND accounting_date <= ${w.to})`;
  const match: SQL = sql`(vies_month >= ${w.from} AND vies_month <= ${w.to}) OR ${byDate}`;
  const headers = await queryRows<{
    id: number; number: string; financial_year_id: number; accounting_date: string; vies_month: string; transaction_type_id: number;
    vies_id: number | null; ica_type: number; ica_accounting_id: number | null; is_initial_balance: boolean; is_initial_correspondence: boolean;
    document_type_id: number | null; code: string | null; short_name: string | null; document_number: string | null; document_date: string | null;
    branch_code: string | null; term: string | null; reference: string | null; optional_reference: string | null;
  }>(db, sql`
    WITH m AS (SELECT id, financial_year_id, number, ica_accounting_id FROM accountings WHERE ${match})
    SELECT a.id, a.number, a.financial_year_id, a.accounting_date::text AS accounting_date, a.vies_month::text AS vies_month,
      a.transaction_type_id, a.vies_id, a.ica_type, a.ica_accounting_id, a.is_initial_balance, a.is_initial_correspondence,
      doc.document_type_id, dt.code, dt.short_name, doc.number AS document_number, doc.date::text AS document_date,
      b.code AS branch_code, t.description AS term, r.description AS reference, r2.description AS optional_reference
    FROM accountings a
    LEFT JOIN documents doc ON doc.id = a.document_id
    LEFT JOIN document_types dt ON dt.id = doc.document_type_id
    LEFT JOIN branches b ON b.id = a.branch_id
    LEFT JOIN terms t ON t.id = a.term_id
    LEFT JOIN reference_texts r ON r.id = a.reference_id
    LEFT JOIN reference_texts r2 ON r2.id = a.optional_reference_id
    WHERE a.id IN (SELECT id FROM m)
      OR a.id IN (SELECT ica_accounting_id FROM m WHERE ica_accounting_id IS NOT NULL)
      OR a.ica_accounting_id IN (SELECT id FROM m)
      OR (a.number <> '' AND (a.financial_year_id, a.number) IN (SELECT financial_year_id, number FROM m WHERE number <> ''))
    ORDER BY a.id`);
  if (!headers.length) return [];
  const ids = headers.map((h) => h.id);
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);

  const vatAccs = await vatCategoryAccounts(db);
  const isVatPurchase = prefixMatcher(vatAccs.filter((a) => a.categoryId === CATEGORY.VatPurchases).map((a) => a.number));
  const isVatSale = prefixMatcher(vatAccs.filter((a) => a.categoryId === CATEGORY.VatSales).map((a) => a.number));

  const details = await queryRows<{
    accounting_id: number; sign: number; amount: string; ref_amount: string; vat_term_id: number; account_id: number | null;
    number: string | null; cat: number | null; ref_cat: number | null; company_id: number | null; base: boolean;
  }>(db, sql`
    SELECT * FROM (
      SELECT d.accounting_id, d.sign, d.amount::text AS amount, d.ref_amount::text AS ref_amount, d.vat_term_id, d.account_id,
        ac.number, ac.account_category_id AS cat, rc.account_category_id AS ref_cat, d.company_id, FALSE AS base, d.position AS pos, d.id AS did
      FROM accounting_details d
      JOIN accounts ac ON ac.id = d.account_id
      LEFT JOIN accounts rc ON rc.id = d.ref_account_id
      WHERE d.accounting_id IN (${idList})
      UNION ALL
      SELECT v.accounting_id, v.sign, v.amount::text, v.ref_amount::text, v.vat_term_id, NULL, NULL, NULL, NULL, v.company_id, TRUE, 100000, v.id
      FROM vat_base_lines v WHERE v.accounting_id IN (${idList})
    ) x ORDER BY accounting_id, base, pos, did`);
  const ext = await queryRows<{ accounting_id: number; vat_diary_code: string }>(db, sql`
    SELECT accounting_id, vat_diary_code FROM accounting_extended_details WHERE accounting_id IN (${idList}) ORDER BY id`);

  const companyIds = [...new Set(details.map((d) => d.company_id).filter((c): c is number => c != null))];
  const partners = new Map<number, VatPartner>();
  if (companyIds.length) {
    const rows = await queryRows<{ id: number; name: string; vat_number: string | null; bulstat: string | null }>(db, sql`
      SELECT id, name, vat_number, bulstat FROM companies WHERE id IN (${sql.join(companyIds.map((c) => sql`${c}`), sql`, `)})`);
    for (const r of rows) partners.set(r.id, { id: r.id, name: r.name, vatNumber: r.vat_number, bulstat: r.bulstat });
  }

  const byAcc = new Map<number, VatDetail[]>();
  for (const d of details) {
    const list = byAcc.get(d.accounting_id) ?? [];
    list.push({
      sign: d.sign > 0 ? 1 : -1,
      amount: d.amount, refAmount: d.ref_amount, vatTermId: d.vat_term_id,
      accountId: d.account_id, accountNumber: d.number,
      isVatPurchase: d.cat === CATEGORY.VatPurchases || isVatPurchase(d.number),
      isVatSale: d.cat === CATEGORY.VatSales || isVatSale(d.number),
      accountCategoryId: d.cat, refAccountCategoryId: d.ref_cat,
      partner: d.company_id != null ? (partners.get(d.company_id) ?? null) : null,
    });
    byAcc.set(d.accounting_id, list);
  }
  const codes = new Map<number, string[]>();
  for (const e of ext) codes.set(e.accounting_id, [...(codes.get(e.accounting_id) ?? []), e.vat_diary_code]);

  return headers.map((h) => ({
    id: h.id, number: h.number, financialYearId: h.financial_year_id,
    accountingDate: h.accounting_date, viesMonth: h.vies_month,
    transactionTypeId: h.transaction_type_id, documentTypeId: h.document_type_id,
    documentCode: h.code ?? '', documentShortName: h.short_name ?? '', documentNumber: h.document_number ?? '', documentDate: h.document_date ?? h.accounting_date,
    branchCode: h.branch_code ?? '', term: h.term ?? '', reference: h.reference ?? '', optionalReference: h.optional_reference ?? '', viesId: h.vies_id, icaType: h.ica_type, icaAccountingId: h.ica_accounting_id,
    isInitialBalance: h.is_initial_balance, isInitialCorrespondence: h.is_initial_correspondence,
    extendedCodes: codes.get(h.id) ?? [], details: byAcc.get(h.id) ?? [],
  }));
}
