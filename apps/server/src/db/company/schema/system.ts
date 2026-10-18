import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Company database: system, configuration, users and permissions (spec 01b).
 * One company = one database, as in Delta.
 */

export const system = pgTable('system', {
  version: varchar('version', { length: 20 }).primaryKey(),
  productId: integer('product_id').notNull().default(4),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  code: varchar('code', { length: 255 }),
});

/** Key/value settings; user_id NULL = company-wide. */
export const configuration = pgTable(
  'configuration',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    key: varchar('key', { length: 50 }).notNull(),
    value: text('value').notNull(),
    userId: integer('user_id'),
  },
  (t) => [index('ix_configuration_key_user').on(t.key, t.userId)],
);

export const userRoles = pgTable('user_roles', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 50 }).notNull(),
  parentId: integer('parent_id'),
  leftIndex: integer('left_index').notNull().default(0),
  rightIndex: integer('right_index').notNull().default(0),
  level: integer('level').notNull().default(0),
  isReadOnly: boolean('is_read_only').notNull().default(false),
});

export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  /** scrypt hash ("scrypt$N$salt$hash"); empty string = no password. */
  passwordHash: text('password_hash').notNull().default(''),
  userRoleId: integer('user_role_id').notNull().references(() => userRoles.id),
  isDeleted: boolean('is_deleted').notNull().default(false),
  email: varchar('email', { length: 255 }),
});

export const permissions = pgTable(
  'permissions',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    key: varchar('key', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: integer('parent_id'),
    defaultValue: boolean('default_value').notNull().default(true),
    groupOrder: integer('group_order').notNull().default(1),
  },
  (t) => [uniqueIndex('ix_permissions_key').on(t.key)],
);

export const userRolePermissions = pgTable(
  'user_role_permissions',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    permissionId: integer('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
    userRoleId: integer('user_role_id').notNull().references(() => userRoles.id, { onDelete: 'cascade' }),
    value: boolean('value').notNull(),
  },
  (t) => [index('ix_urp_role').on(t.userRoleId), index('ix_urp_permission').on(t.permissionId)],
);

/** Audit log (spec 01b section 8). */
export const dataActivityLog = pgTable(
  'data_activity_log',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    userId: integer('user_id'),
    activity: varchar('activity', { length: 50 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: integer('entity_id'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_activity_created').on(t.createdAt)],
);
