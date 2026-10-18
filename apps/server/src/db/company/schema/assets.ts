import { boolean, date, index, integer, numeric, pgTable, smallint, timestamp, varchar } from 'drizzle-orm/pg-core';
import { accounts } from './nomenclatures.ts';
import { accountings } from './journal.ts';

/**
 * Fixed assets and depreciation (spec 03b section 2). Categories, methods and
 * termination types are the fixed lookups of @shmi/core (DEPRECIATION_CATEGORIES,
 * DEPRECIATION_METHODS, TERMINATION_TYPES); ids are stored as integers.
 * Posting links are ON DELETE SET NULL (12.4: the corrected form of Delta's cascades).
 */

const money = (name: string) => numeric(name, { precision: 19, scale: 6 });

/** Location tree (FixedAssetLocations, nested set). Root id 1 is named after the company. */
export const fixedAssetLocations = pgTable('fixed_asset_locations', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: integer('parent_id'),
  leftIndex: integer('left_index').notNull().default(0),
  rightIndex: integer('right_index').notNull().default(0),
  level: integer('level').notNull().default(1),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

/** One plan (САП when isAccounting, else ДАП); two rows per asset. */
export const depreciations = pgTable('depreciations', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  isAccounting: boolean('is_accounting').notNull(),
  methodId: smallint('method_id').notNull().default(1),
  /** Отчетна стойност (gross cost). */
  depreciationAmount: money('depreciation_amount').notNull().default('0'),
  nonDepreciableAmount: money('non_depreciable_amount').notNull().default('0'),
  depreciableAmount: money('depreciable_amount').notNull().default('0'),
  acquisitionDate: date('acquisition_date').notNull(),
  startDate: date('start_date').notNull(),
  /** First day of the last scheduled month; 9999-12-31 without a schedule. */
  endDate: date('end_date').notNull(),
  /** Write-off date; NULL = not written off. */
  finalDate: date('final_date'),
  conservationStartDate: date('conservation_start_date'),
  conservationEndDate: date('conservation_end_date'),
  activePeriodLength: integer('active_period_length').notNull().default(0),
  /** Selected annual rate (0 = "Земи, гори" / not applied). */
  annualRate: numeric('annual_rate', { precision: 19, scale: 15 }).notNull().default('0'),
  /** Plan built by period (life given) or by year percentage. */
  calcType: varchar('calc_type', { length: 10 }).notNull().default('period'),
  note: varchar('note', { length: 1024 }),
  serialNumber: varchar('serial_number', { length: 255 }),
});

export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    inventoryNumber: varchar('inventory_number', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    personInCharge: varchar('person_in_charge', { length: 255 }),
    /** "Амортизация в сметка" (accumulated depreciation, 241/242). */
    debitAccountId: integer('debit_account_id').references(() => accounts.id),
    /** "Разход за амортизация в сметка" (expense, 603). */
    creditAccountId: integer('credit_account_id').references(() => accounts.id),
    /** "Активът се води в сметка" (20x/21x). */
    inventoryAccountId: integer('inventory_account_id').references(() => accounts.id),
    revaluationReserve: money('revaluation_reserve').notNull().default('0'),
    categoryId: smallint('category_id').notNull(),
    accountingDepreciationId: integer('accounting_depreciation_id').notNull().references(() => depreciations.id),
    taxDepreciationId: integer('tax_depreciation_id').notNull().references(() => depreciations.id),
    areDepreciationsSynchronized: boolean('are_depreciations_synchronized').notNull().default(false),
    terminationStatusId: smallint('termination_status_id').notNull().default(1),
    terminationAccountingId: integer('termination_accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
    locationId: integer('location_id').notNull().references(() => fixedAssetLocations.id),
    isEuro: boolean('is_euro').notNull().default(false),
    /** EUR copy made at the changeover: the BGN asset it was converted from. */
    sourceAssetId: integer('source_asset_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_fixed_assets_inventory').on(t.isEuro, t.inventoryNumber), index('ix_fixed_assets_location').on(t.locationId)],
);

export const depreciationYearPlans = pgTable(
  'depreciation_year_plans',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    depreciationId: integer('depreciation_id').notNull().references(() => depreciations.id, { onDelete: 'cascade' }),
    /** 1 January of the year. */
    year: date('year').notNull(),
    percentage: numeric('percentage', { precision: 19, scale: 15 }).notNull().default('0'),
    amount: money('amount').notNull().default('0'),
    revaluationReserve: money('revaluation_reserve').notNull().default('0'),
  },
  (t) => [index('ix_year_plans_depreciation').on(t.depreciationId)],
);

export const depreciationSchedules = pgTable(
  'depreciation_schedules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    depreciationId: integer('depreciation_id').notNull().references(() => depreciations.id, { onDelete: 'cascade' }),
    /** First day of the month. */
    month: date('month').notNull(),
    amount: money('amount').notNull().default('0'),
    isProcessed: boolean('is_processed').notNull().default(false),
    accountingId: integer('accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_schedules_depreciation').on(t.depreciationId), index('ix_schedules_accounting').on(t.accountingId)],
);

export const improvementsHistory = pgTable('improvements_history', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  depreciationId: integer('depreciation_id').notNull().references(() => depreciations.id, { onDelete: 'cascade' }),
  improvementDate: date('improvement_date').notNull(),
  newDepreciationAmount: money('new_depreciation_amount').notNull(),
});

export const revaluationReserves = pgTable('revaluation_reserves', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  fixedAssetId: integer('fixed_asset_id').notNull().references(() => fixedAssets.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  amount: money('amount').notNull(),
  isDeleted: boolean('is_deleted').notNull().default(false),
  /** Posting created by the IAS dialog ("По цена на придобиване"). */
  accountingId: integer('accounting_id').references(() => accountings.id, { onDelete: 'set null' }),
});
