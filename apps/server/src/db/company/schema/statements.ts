import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Financial statements and user-defined reports (spec 01a "Reporting
 * definitions and formulas", 05 sections 9-10).
 */

/** StatementReportRows: printed row captions (OPRRow1 ...). */
export const statementReportRows = pgTable('statement_report_rows', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  identifier: varchar('identifier', { length: 50 }).notNull(),
  description: text('description').notNull(),
  order: integer('order').notNull(),
});

/** StatementReportColumns: column captions (BalansCol1 Актив ...). */
export const statementReportColumns = pgTable('statement_report_columns', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  identifier: varchar('identifier', { length: 50 }).notNull(),
  description: text('description').notNull(),
  order: integer('order').notNull(),
});

/** StatementFormulas: one cell per row/column; Formula is user-editable, DefaultFormula the factory value. */
export const statementFormulas = pgTable(
  'statement_formulas',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    key: varchar('key', { length: 20 }).notNull(),
    statementReportRowId: integer('statement_report_row_id').notNull().default(0).references(() => statementReportRows.id, { onUpdate: 'cascade' }),
    statementReportColumnId: integer('statement_report_column_id').notNull().default(0).references(() => statementReportColumns.id, { onUpdate: 'cascade' }),
    formula: text('formula').notNull(),
    defaultFormula: text('default_formula').notNull(),
    /** Previous-period figure entered by hand ("Предходна година в основна валута"). */
    valueLastPeriod: numeric('value_last_period', { precision: 19, scale: 6 }).notNull().default('0'),
    /** Order of the seed (Appendix A), which is the printed order. */
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('ix_statement_formulas_key').on(t.key),
    index('ix_statement_formulas_row').on(t.statementReportRowId),
    index('ix_statement_formulas_column').on(t.statementReportColumnId),
  ],
);

/**
 * Formulas (05 10.1). The original stores an operation tree in
 * FormulaDependencies; here a value formula keeps its DSL text in
 * `expression` and a filter formula its condition list in `filter`.
 * FormulaType: 1 UsersFormula, 5 StatementFormula, 8 FilterFormula.
 */
export const formulas = pgTable('formulas', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  key: varchar('key', { length: 50 }).notNull(),
  statementFormulaId: integer('statement_formula_id').references(() => statementFormulas.id, { onDelete: 'set null' }),
  isVisible: boolean('is_visible').notNull().default(false),
  isOnlyPositive: boolean('is_only_positive').notNull().default(false),
  isCurrencyAmount: boolean('is_currency_amount').notNull().default(false),
  isQuantityAmount: boolean('is_quantity_amount').notNull().default(false),
  formulaType: integer('formula_type').notNull().default(1),
  expression: text('expression').notNull().default(''),
  filter: jsonb('filter'),
});

/** UserReports: Format 1 = one value column, 2 = two columns, 3 = by months. */
export const userReports = pgTable('user_reports', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  description: text('description'),
  format: integer('format'),
});

export const userReportColumns = pgTable(
  'user_report_columns',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    name: text('name').notNull(),
    reportId: integer('report_id').notNull().references(() => userReports.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [index('ix_user_report_columns_report').on(t.reportId)],
);

export const userReportRows = pgTable(
  'user_report_rows',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    name: text('name'),
    number: integer('number'),
    formulaId: integer('formula_id').references(() => formulas.id, { onDelete: 'cascade' }),
    filterFormulaId: integer('filter_formula_id').references(() => formulas.id, { onDelete: 'set null' }),
    columnId: integer('column_id').notNull().references(() => userReportColumns.id, { onDelete: 'cascade' }),
  },
  (t) => [index('ix_user_report_rows_formula').on(t.formulaId), index('ix_user_report_rows_column').on(t.columnId)],
);
