import { sql } from 'drizzle-orm';
import { dec, INVOICE_DOC_TYPES, sum, TRANSACTION_TYPE, validateVatEntry, type EntryLine, type ValidationMessage } from '@shmi/core';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { vatAccountsForYear } from './load.ts';

/**
 * VAT checks of the accounting save pipeline (spec 02b 12 / 22), called by
 * services/journal.ts saveEntry. Returns Critical/NonCritical messages and
 * the Yes/No confirmations (strAskIfViesMonthIsBeforeDocumentDate, ...).
 */
export async function vatEntryChecks(db: DbOrTx, input: {
  transactionTypeId?: number;
  documentTypeId: number | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  accountingDate: string;
  viesMonth?: string | null;
  companyId?: number | null;
  isInitialBalance?: boolean;
}, debits: EntryLine[], credits: EntryLine[], year: ActiveYear, existingId?: number): Promise<{ messages: ValidationMessage[]; confirm: ValidationMessage[] }> {
  const tt = input.transactionTypeId ?? TRANSACTION_TYPE.NotSet;
  if (input.isInitialBalance) return { messages: [], confirm: [] };
  const isDeal = tt === TRANSACTION_TYPE.Purchase || tt === TRANSACTION_TYPE.Sale;
  const vat = isDeal ? await vatAccountsForYear(db, year.year) : null;

  let duplicateExists = false;
  const number = input.documentNumber?.trim();
  if (isDeal && number && input.documentTypeId != null && INVOICE_DOC_TYPES.has(input.documentTypeId)) {
    const partnerId = input.companyId ?? [...debits, ...credits].find((l) => l.companyId)?.companyId ?? null;
    const partnerFilter = tt === TRANSACTION_TYPE.Purchase
      ? (partnerId ? sql`AND EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id = ${partnerId})` : sql`AND FALSE`)
      : sql``;
    const rows = await queryRows<{ id: number }>(db, sql`
      SELECT a.id FROM accountings a JOIN documents d ON d.id = a.document_id
      WHERE d.document_type_id = ${input.documentTypeId} AND d.number = ${number} AND a.transaction_type_id = ${tt}
        AND a.id <> ${existingId ?? 0} ${partnerFilter} LIMIT 1`);
    duplicateExists = rows.length > 0;
  }

  return validateVatEntry({
    transactionTypeId: tt,
    documentTypeId: input.documentTypeId,
    documentDate: input.documentDate || input.accountingDate,
    viesMonth: input.viesMonth || `${input.accountingDate.slice(0, 7)}-01`,
    debitTotal: sum(debits.map((l) => dec(l.amount))),
    lineTerms: [...debits, ...credits].map((l) => l.vatTermId ?? 1),
    hasVatPurchaseAccount: !vat || !!vat.purchases,
    hasVatSaleAccount: !vat || !!vat.sales,
    duplicateExists,
  });
}
