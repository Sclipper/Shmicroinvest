import { customType, integer, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Catalog database (spec 01a section 10): one row per company database.
 * Also holds web sessions, which have no Delta counterpart.
 */
export const companiesCatalog = pgTable('companies_catalog', {
  name: varchar('name', { length: 128 }).primaryKey(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  productId: integer('product_id').notNull().default(4),
  version: varchar('version', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  companyDb: varchar('company_db', { length: 128 }),
  userId: integer('user_id'),
  /** Per-session state: working (application) date offset, active branch. */
  state: jsonb('state').$type<{ appDateOffsetDays?: number; branchId?: number }>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: text('user_agent'),
});

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });

/** Company backups (spec 01b 2): the archive store of "Архивиране" / "Възстановяване". */
export const companyBackups = pgTable('company_backups', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  database: varchar('database', { length: 128 }).notNull(),
  version: varchar('version', { length: 20 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  size: integer('size').notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
