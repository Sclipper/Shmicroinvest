import { bigint, boolean, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { accounts, companies, currencies, products } from './nomenclatures.ts';
import { users } from './system.ts';
import { accountings, documentTypes, financialYears, sequences, transactionTypes, vieses } from './journal.ts';

/**
 * Journal extras (spec 02a sections 3 and 9, 01a "Templates, schedules,
 * reschedules"): accounting templates with their schedules, revenue/expense
 * reschedule cards, and the per-user numbering series.
 */

const money = (name: string) => numeric(name, { precision: 19, scale: 6 });

/** Шаблон за контиране (AccountingTemplates). Constants only, no placeholders (02a 9.1). */
export const accountingTemplates = pgTable(
  'accounting_templates',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    name: varchar('name', { length: 255 }).notNull(),
    documentTypeId: integer('document_type_id').references(() => documentTypes.id),
    termText: varchar('term_text', { length: 255 }),
    referenceText: varchar('reference_text', { length: 255 }),
    optionalReferenceText: varchar('optional_reference_text', { length: 255 }),
    paragraphText: varchar('paragraph_text', { length: 255 }),
    transactionTypeId: integer('transaction_type_id').notNull().default(1).references(() => transactionTypes.id),
    viesId: integer('vies_id').references(() => vieses.id),
    /** Header partner, stored only after strSaveCompanyWithTemplatePrompt. */
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    date: date('date').notNull(),
    userId: integer('user_id').references(() => users.id),
    isEuro: boolean('is_euro').notNull().default(false),
    isPaymentEnabled: boolean('is_payment_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_accounting_templates_name').on(t.name)],
);

/**
 * Template line. Unlike Delta's leg pairs this keeps the editor shape:
 * sign +1 = debit line, -1 = credit line, amount = the line amount.
 */
export const accountingTemplateDetails = pgTable(
  'accounting_template_details',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    templateId: integer('template_id').notNull().references(() => accountingTemplates.id, { onDelete: 'cascade' }),
    sign: smallint('sign').notNull(),
    accountId: integer('account_id').references(() => accounts.id),
    accountNumber: varchar('account_number', { length: 50 }),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    vatTermId: integer('vat_term_id').notNull().default(1),
    amount: money('amount').notNull().default('0'),
    description: varchar('description', { length: 255 }),
    currencyId: integer('currency_id').references(() => currencies.id),
    currencyAmount: money('currency_amount'),
    exchangeRate: money('exchange_rate'),
    productId: integer('product_id').references(() => products.id),
    quantity: money('quantity'),
    price: money('price'),
    isEuro: boolean('is_euro').notNull().default(false),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('ix_template_details_template').on(t.templateId), index('ix_template_details_account').on(t.accountId)],
);

/**
 * График за изпълнение (Schedules). mode: 0 Daily, 1 Weekly, 2 Monthly,
 * 3 MonthlyExtended (exists but the generator throws, 02a 9.2).
 * months: bit m-1 = month m; days: bit d-1 = day d; weekDays: bit 0 = Monday ... bit 6 = Sunday.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    templateId: integer('template_id').notNull().references(() => accountingTemplates.id, { onDelete: 'cascade' }),
    mode: smallint('mode').notNull().default(2),
    months: integer('months').notNull().default(0),
    days: bigint('days', { mode: 'number' }).notNull().default(0),
    weekDays: integer('week_days').notNull().default(0),
    monthOptions: integer('month_options').notNull().default(0),
    interval: integer('interval').notNull().default(1),
  },
  (t) => [uniqueIndex('ix_schedules_template').on(t.templateId)],
);

/** Generated schedule rows (AccountingTemplateSchedules); processing creates an entry from the template. */
export const accountingTemplateSchedules = pgTable(
  'accounting_template_schedules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    templateId: integer('template_id').notNull().references(() => accountingTemplates.id, { onDelete: 'cascade' }),
    scheduleId: integer('schedule_id').notNull().references(() => schedules.id, { onDelete: 'cascade' }),
    accountingId: integer('accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
    isProcessed: boolean('is_processed').notNull().default(false),
    date: date('date').notNull(),
  },
  (t) => [index('ix_template_schedules_schedule').on(t.scheduleId), index('ix_template_schedules_date').on(t.date)],
);

/** Разсрочване на приходи/разходи (AccountingReschedules, 02a 9.3). */
export const accountingReschedules = pgTable('accounting_reschedules', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  number: varchar('number', { length: 30 }),
  name: text('name'),
  amount: money('amount').notNull(),
  documentTypeId: integer('document_type_id').references(() => documentTypes.id),
  documentNumber: varchar('document_number', { length: 30 }),
  documentDate: date('document_date'),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  debitAccountId: integer('debit_account_id').notNull().references(() => accounts.id),
  creditAccountId: integer('credit_account_id').notNull().references(() => accounts.id),
  companyId: integer('company_id').references(() => companies.id),
  term: text('term'),
  reference: text('reference'),
  isRescheduleByDays: boolean('is_reschedule_by_days').notNull().default(false),
  isRescheduleByMonths: boolean('is_reschedule_by_months').notNull().default(true),
  isEuro: boolean('is_euro').notNull().default(false),
  /** Entry the card was created from ("Разсрочване на приход/разход" in the editor). */
  sourceAccountingId: integer('source_accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
}, (t) => [index('ix_accounting_reschedules_company').on(t.companyId)]);

export const accountingRescheduleDetails = pgTable(
  'accounting_reschedule_details',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    rescheduleId: integer('reschedule_id').notNull().references(() => accountingReschedules.id, { onDelete: 'cascade' }),
    /** First day of the month (by months) or the day (by days) of the period. */
    month: date('month').notNull(),
    amount: money('amount').notNull(),
    isProcessed: boolean('is_processed').notNull().default(false),
    accountingId: integer('accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_reschedule_details_reschedule').on(t.rescheduleId)],
);

/** Active numbering series of a user per year (UserSequences, 06 3.7). */
export const userSequences = pgTable(
  'user_sequences',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sequenceId: integer('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    financialYearId: integer('financial_year_id').references(() => financialYears.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_user_sequences_user').on(t.userId), index('ix_user_sequences_sequence').on(t.sequenceId)],
);
