import { boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import type { FormulaToken } from '@shmi/core';
import { accounts, banks, companies } from './nomenclatures.ts';
import { users } from './system.ts';

/**
 * Data exchange (spec 04a, 04b, 03a 9): bank-statement posting rules,
 * invoice keywords, imported periods (ТРЗ Pro) and report-export definitions.
 */

/** Bank posting rules (AccountingTemplates with a BankID, 03a 9). The condition is kept as its token list. */
export const bankTemplates = pgTable('bank_templates', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  bankId: integer('bank_id').notNull().references(() => banks.id),
  name: varchar('name', { length: 255 }).notNull(),
  termText: varchar('term_text', { length: 255 }).notNull().default(''),
  referenceText: varchar('reference_text', { length: 255 }).notNull().default(''),
  optionalReferenceText: varchar('optional_reference_text', { length: 255 }).notNull().default(''),
  documentTypeId: integer('document_type_id'),
  companyId: integer('company_id').references(() => companies.id),
  /** Lowest first; 10 = not prioritised. */
  priority: smallint('priority').notNull().default(10),
  isOwnAccounts: boolean('is_own_accounts').notNull().default(false),
  mergeRowsOnImport: boolean('merge_rows_on_import').notNull().default(false),
  isPaymentEnabled: boolean('is_payment_enabled').notNull().default(false),
  formula: jsonb('formula').$type<FormulaToken[]>().notNull().default([]),
  defaultFormula: jsonb('default_formula').$type<FormulaToken[]>().notNull().default([]),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ix_bank_templates_bank').on(t.bankId)]);

/** One detail per chart (IsEuro false = BGN chart, true = EUR chart). */
export const bankTemplateDetails = pgTable('bank_template_details', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  templateId: integer('template_id').notNull().references(() => bankTemplates.id, { onDelete: 'cascade' }),
  isEuro: boolean('is_euro').notNull().default(false),
  /** +1 outflow rule (counter-account debited), -1 inflow rule. */
  sign: smallint('sign').notNull().default(1),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  refAccountId: integer('ref_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  /** Account number kept when the number does not resolve in that chart. */
  accountNumber: varchar('account_number', { length: 50 }),
  companyId: integer('company_id').references(() => companies.id),
  vatTermId: integer('vat_term_id').notNull().default(1),
}, (t) => [index('ix_bank_template_details_template').on(t.templateId)]);

/** KeyWords: invoice-number keywords for auto-binding (04b 1.2). */
export const bankImportKeywords = pgTable('bank_import_keywords', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  word: varchar('word', { length: 50 }).notNull(),
});

/** ImportedPeriods (ТРЗ Pro, ImportType 51). */
export const importedPeriods = pgTable('imported_periods', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  importType: smallint('import_type').notNull(),
  startDate: varchar('start_date', { length: 10 }).notNull(),
  endDate: varchar('end_date', { length: 10 }).notNull(),
  importDate: timestamp('import_date', { withTimezone: true }).notNull().defaultNow(),
  description: varchar('description', { length: 255 }),
});

/** "Експорт към външни системи" definitions (the Reports folder of Delta, stored per company). */
export const exportReports = pgTable('export_reports', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  definition: text('definition').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
