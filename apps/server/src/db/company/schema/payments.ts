import { boolean, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { currencies } from './nomenclatures.ts';

/**
 * Payment documents (Платежни документи, spec 02c 1.2): one table for every
 * form type, discriminated by `documentType` (= the C# PaymentDocumentType
 * identifier 1..8, i.e. EnumPaymentDocumentTypes.RowID - 1). No business
 * number exists; rows are soft-deleted.
 */
export const paymentDocuments = pgTable(
  'payment_documents',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    /** 1 Order, 2 Due, 3 OrderCredit, 4 OrderDebit, 5 BudgetDue, 6 BudgetOrder, 7 Transire, 8 OrderMassPayment. */
    documentType: smallint('document_type').notNull(),
    bankName: varchar('bank_name', { length: 50 }),
    bankBranch: varchar('bank_branch', { length: 50 }),
    bankAddress: varchar('bank_address', { length: 50 }),
    issuePlace: varchar('issue_place', { length: 50 }),
    issueDate: date('issue_date'),
    personName: varchar('person_name', { length: 50 }),
    personIban: varchar('person_iban', { length: 50 }),
    personBank: varchar('person_bank', { length: 50 }),
    personBic: varchar('person_bic', { length: 50 }),
    currency: varchar('currency', { length: 3 }),
    qtty: numeric('qtty', { precision: 18, scale: 2 }).notNull().default('0'),
    inWords: text('in_words'),
    autorizedPerson: varchar('autorized_person', { length: 50 }),
    idNumber: varchar('id_number', { length: 50 }),
    egn: varchar('egn', { length: 50 }),
    lnch: varchar('lnch', { length: 50 }),
    receivedBy: varchar('received_by', { length: 50 }),
    customer: varchar('customer', { length: 70 }),
    customerIban: varchar('customer_iban', { length: 50 }),
    customerBic: varchar('customer_bic', { length: 50 }),
    duePerson: varchar('due_person', { length: 50 }),
    reason: varchar('reason', { length: 70 }),
    reasonEx: varchar('reason_ex', { length: 70 }),
    executionDate: date('execution_date'),
    taxes: integer('taxes'),
    paymentSystem: varchar('payment_system', { length: 50 }),
    paymentType: integer('payment_type'),
    paymentType2: integer('payment_type2'),
    documentDate: date('document_date'),
    documentTypeCode: integer('document_type_code'),
    documentNumber: varchar('document_number', { length: 50 }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    bulstat: varchar('bulstat', { length: 50 }),
    ebkParagraph: varchar('ebk_paragraph', { length: 50 }),
    kid: varchar('kid', { length: 50 }),
    budgetCode: varchar('budget_code', { length: 50 }),
    sebra: varchar('sebra', { length: 50 }),
    /** Set to the application date when the document is added; the registry filters on it. */
    date: timestamp('date', { withTimezone: false }).notNull().defaultNow(),
    rowsCount: varchar('rows_count', { length: 50 }),
    controlCode: varchar('control_code', { length: 50 }),
    isDeleted: boolean('is_deleted').notNull().default(false),
  },
  (t) => [index('ix_payment_documents_type_date').on(t.documentType, t.date)],
);

/**
 * BNB/central exchange rates remembered per currency and date (fixing used by
 * FX revaluation, spec 02c 2.3). Rates are units of the base currency per one
 * unit of the foreign currency, stored with 5 decimals.
 */
export const currencyRates = pgTable(
  'currency_rates',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    currencyId: integer('currency_id').notNull().references(() => currencies.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** Base currency of the rate: 'EUR' from 2026, 'BGN' before. */
    baseIso: varchar('base_iso', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 19, scale: 6 }).notNull(),
    source: varchar('source', { length: 20 }).notNull().default('manual'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ix_currency_rates_currency_date').on(t.currencyId, t.date, t.baseIso)],
);
