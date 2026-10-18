import { index, integer, numeric, pgTable, smallint } from 'drizzle-orm/pg-core';
import { accountings, vatTerms } from './journal.ts';
import { companies } from './nomenclatures.ts';

const money = (name: string) => numeric(name, { precision: 19, scale: 6 });

/**
 * Account-less protocol rows (spec 02b 7.1, 19: AccountingDetails with
 * AccountID NULL). Delta stores them as details without an account; here they
 * live in their own table so balances and the shared leg model never see a
 * NULL account. They feed only the VAT diaries (base columns).
 */
export const vatBaseLines = pgTable(
  'vat_base_lines',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    accountingId: integer('accounting_id').notNull().references(() => accountings.id, { onDelete: 'cascade' }),
    sign: smallint('sign').notNull(),
    vatTermId: integer('vat_term_id').notNull().references(() => vatTerms.id),
    amount: money('amount').notNull().default('0'),
    refAmount: money('ref_amount').notNull().default('0'),
    companyId: integer('company_id').references(() => companies.id),
  },
  (t) => [index('ix_vat_base_lines_accounting').on(t.accountingId)],
);
