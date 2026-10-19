import { bigint, boolean, customType, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { accounts, companies, currencies, products } from './nomenclatures.ts';
import { users } from './system.ts';

const money = (name: string) => numeric(name, { precision: 19, scale: 6 });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });

/** Financial years with the month-lock bitmask (spec 01b section 6). */
export const financialYears = pgTable(
  'financial_years',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    year: integer('year').notNull(),
    startDate: date('start_date').notNull(),
    isConcluded: boolean('is_concluded').notNull().default(false),
    isLocked: boolean('is_locked').notNull().default(false),
    lockedMonths: integer('locked_months').notNull().default(0),
  },
  (t) => [uniqueIndex('ix_financial_years_year').on(t.year)],
);

export const transactionTypes = pgTable('transaction_types', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  description: varchar('description', { length: 50 }).notNull(),
});

export const vieses = pgTable('vieses', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  description: varchar('description', { length: 100 }).notNull(),
});

export const vatTerms = pgTable('vat_terms', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  transactionTypeId: integer('transaction_type_id').notNull().references(() => transactionTypes.id),
  description: varchar('description', { length: 100 }).notNull(),
  vatValue: numeric('vat_value', { precision: 18, scale: 0 }).notNull(),
  defaultViesId: integer('default_vies_id').notNull().references(() => vieses.id),
});

export const icaTypes = pgTable('ica_types', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 200 }).notNull(),
});

export const documentTypes = pgTable('document_types', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 200 }).notNull(),
  shortName: varchar('short_name', { length: 50 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),
  position: integer('position').notNull().default(0),
  isEditable: boolean('is_editable').notNull().default(false),
  sequenceChannel: integer('sequence_channel').notNull().default(0),
  isVisible: boolean('is_visible').notNull().default(true),
});

/** Numbering series per channel and financial year (spec 02a section 3). */
export const sequences = pgTable(
  'sequences',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    channel: integer('channel').notNull(),
    financialYearId: integer('financial_year_id').references(() => financialYears.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 50 }).notNull().default('[#]'),
    lastNumber: bigint('last_number', { mode: 'number' }).notNull().default(0),
    numericLength: integer('numeric_length').notNull().default(10),
    isNumberResetNextYear: boolean('is_number_reset_next_year').notNull().default(false),
  },
  (t) => [index('ix_sequences_channel').on(t.channel, t.financialYearId)],
);

export const documents = pgTable(
  'documents',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    date: date('date').notNull(),
    number: varchar('number', { length: 50 }).notNull(),
    documentTypeId: integer('document_type_id').notNull().references(() => documentTypes.id),
  },
  (t) => [index('ix_documents_number').on(t.number), index('ix_documents_type').on(t.documentTypeId)],
);

/** Autocomplete dictionaries: Основание, Забележка, Параграф. */
const dictionary = (name: string) =>
  pgTable(name, {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    description: varchar('description', { length: 255 }).notNull(),
    isHidden: boolean('is_hidden').notNull().default(false),
    usageFrequency: integer('usage_frequency').notNull().default(0),
  });
export const terms = dictionary('terms');
export const referenceTexts = dictionary('reference_texts');
export const paragraphs = dictionary('paragraphs');


/** Journal header (Контиране, spec 01a 8.1). */
export const accountings = pgTable(
  'accountings',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    financialYearId: integer('financial_year_id').notNull().references(() => financialYears.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 30 }).notNull().default(''),
    date: date('date').notNull(),
    accountingDate: date('accounting_date').notNull(),
    viesMonth: date('vies_month').notNull(),
    documentId: integer('document_id').references(() => documents.id),
    termId: integer('term_id').references(() => terms.id),
    referenceId: integer('reference_id').references(() => referenceTexts.id),
    optionalReferenceId: integer('optional_reference_id').references(() => referenceTexts.id),
    paragraphId: integer('paragraph_id').references(() => paragraphs.id),
    transactionTypeId: integer('transaction_type_id').notNull().default(1).references(() => transactionTypes.id),
    viesId: integer('vies_id').references(() => vieses.id),
    branchId: integer('branch_id').notNull().default(1),
    userId: integer('user_id').references(() => users.id),
    sequenceId: integer('sequence_id').references(() => sequences.id),
    dueDate: date('due_date'),
    isInitialBalance: boolean('is_initial_balance').notNull().default(false),
    isInitialCorrespondence: boolean('is_initial_correspondence').notNull().default(false),
    icaType: smallint('ica_type').notNull().default(0),
    icaAccountingId: integer('ica_accounting_id'),
    deliveryDescription: text('delivery_description'),
    importedPeriodId: integer('imported_period_id'),
    /** Free-form origin marker: 'manual', 'reversal', 'vat-close', 'depreciation', 'import', ... */
    source: varchar('source', { length: 30 }).notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_accountings_number').on(t.number),
    index('ix_accountings_date').on(t.accountingDate),
    index('ix_accountings_year').on(t.financialYearId),
    index('ix_accountings_document').on(t.documentId),
    index('ix_accountings_vies_month').on(t.viesMonth),
  ],
);

/**
 * Journal leg (spec 01a 8.2). Delta keeps the currency and quantity legs in
 * separate 1:0..1 tables; here they are nullable columns on the leg.
 */
export const accountingDetails = pgTable(
  'accounting_details',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    accountingId: integer('accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    refAccountId: integer('ref_account_id').notNull().references(() => accounts.id),
    companyId: integer('company_id').references(() => companies.id),
    vatTermId: integer('vat_term_id').notNull().default(1).references(() => vatTerms.id),
    amount: money('amount').notNull().default('0'),
    refAmount: money('ref_amount').notNull().default('0'),
    sign: smallint('sign').notNull(),
    description: varchar('description', { length: 255 }),
    currencyId: integer('currency_id').references(() => currencies.id),
    currencyAmount: money('currency_amount'),
    exchangeRate: money('exchange_rate'),
    fixedRate: money('fixed_rate'),
    productId: integer('product_id').references(() => products.id),
    quantity: money('quantity'),
    price: money('price'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('ix_details_accounting').on(t.accountingId),
    index('ix_details_account').on(t.accountId),
    index('ix_details_company').on(t.companyId),
    // The credit-side account filters of the registers (Кредит / "сметка" on either side).
    index('ix_details_ref_account').on(t.refAccountId),
  ],
);

// The accounting_id indexes below: deleting entries (a re-concluded year drops all of its
// opening entries) cascades into these tables, a scan of each per entry without them.
export const accountingExtendedDetails = pgTable('accounting_extended_details', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  accountingId: integer('accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
  vatDiaryCode: varchar('vat_diary_code', { length: 5 }).notNull(),
}, (t) => [index('ix_extended_details_accounting').on(t.accountingId)]);

export const accountingAttachments = pgTable('accounting_attachments', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  accountingId: integer('accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
  description: varchar('description', { length: 255 }).notNull().default(''),
  fileName: varchar('file_name', { length: 1000 }).notNull(),
  mimeType: varchar('mime_type', { length: 255 }).notNull().default('application/octet-stream'),
  size: integer('size').notNull().default(0),
  data: bytea('data').notNull(),
}, (t) => [index('ix_attachments_accounting').on(t.accountingId)]);

/** Payment-to-liability matching (spec 02c). */
export const accountingPaymentDetails = pgTable(
  'accounting_payment_details',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    paymentAccountingId: integer('payment_accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
    refAccountingId: integer('ref_accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
    documentId: integer('document_id').references(() => documents.id),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    companyId: integer('company_id').references(() => companies.id),
    amount: money('amount').notNull(),
    currencyAmount: money('currency_amount').notNull().default('0'),
  },
  // ix_apd_document: deleting a document that no entry uses any more checks the links.
  (t) => [index('ix_apd_payment').on(t.paymentAccountingId), index('ix_apd_ref').on(t.refAccountingId), index('ix_apd_document').on(t.documentId)],
);

export const accountInitialBalances = pgTable('account_initial_balances', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  accountingId: integer('accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
  companyId: integer('company_id').references(() => companies.id),
  documentId: integer('document_id').references(() => documents.id),
  financialYearId: integer('financial_year_id').notNull().references(() => financialYears.id, { onDelete: 'cascade' }),
}, (t) => [index('ix_initial_balances_accounting').on(t.accountingId)]);
