import { boolean, index, integer, numeric, pgTable, smallint, text, timestamp, varchar } from 'drizzle-orm/pg-core';

/** Master data (spec 01a section 3, 03a). Money columns are numeric(19,6) like Delta's decimal(19,6). */

const money = (name: string) => numeric(name, { precision: 19, scale: 6 });

export const currencies = pgTable('currencies', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  isoCode: varchar('iso_code', { length: 50 }).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  exchangeRate: money('exchange_rate').notNull().default('1'),
  fixedRate: money('fixed_rate').notNull().default('1'),
  rateDate: varchar('rate_date', { length: 10 }),
});

export const accountCategories = pgTable('account_categories', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  typeIdentifier: smallint('type_identifier').notNull(),
  code: varchar('code', { length: 50 }),
  description: varchar('description', { length: 255 }),
});

export const productGroups = pgTable('product_groups', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 50 }).notNull(),
  parentId: integer('parent_id'),
  leftIndex: integer('left_index').notNull().default(0),
  rightIndex: integer('right_index').notNull().default(0),
  level: integer('level').notNull().default(0),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const products = pgTable('products', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  measure: varchar('measure', { length: 50 }).notNull(),
  price: money('price').notNull().default('0'),
  groupId: integer('group_id').notNull().default(1),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const accounts = pgTable(
  'accounts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    parentId: integer('parent_id'),
    leftIndex: integer('left_index').notNull().default(0),
    rightIndex: integer('right_index').notNull().default(0),
    level: integer('level').notNull().default(0),
    accountCategoryId: integer('account_category_id'),
    number: varchar('number', { length: 50 }).notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    englishDescription: varchar('english_description', { length: 255 }),
    currencyId: integer('currency_id').notNull(),
    productId: integer('product_id'),
    /** Account nature: true = active, false = passive, null = active-passive. */
    isActive: boolean('is_active'),
    concludeAccountId: integer('conclude_account_id'),
    isHidden: boolean('is_hidden').notNull().default(false),
    isForBanks: boolean('is_for_banks').notNull().default(false),
    isExported: boolean('is_exported').notNull().default(false),
    isEuro: boolean('is_euro').notNull().default(false),
    mappedAccountId: integer('mapped_account_id'),
    iban: varchar('iban', { length: 50 }),
  },
  (t) => [
    index('ix_accounts_parent').on(t.parentId),
    index('ix_accounts_left').on(t.leftIndex),
    index('ix_accounts_number').on(t.isEuro, t.number),
    index('ix_accounts_category').on(t.accountCategoryId),
  ],
);

/** Increment / decrement stock role of a material account. */
export const productAccounts = pgTable('product_accounts', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  accountType: smallint('account_type').notNull().default(2),
});

export const companyGroups = pgTable('company_groups', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 50 }).notNull(),
  parentId: integer('parent_id'),
  leftIndex: integer('left_index').notNull().default(0),
  rightIndex: integer('right_index').notNull().default(0),
  level: integer('level').notNull().default(0),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

/** Partners (Партньори). */
export const companies = pgTable(
  'companies',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    name: varchar('name', { length: 255 }).notNull(),
    contactName: varchar('contact_name', { length: 255 }),
    bulstat: varchar('bulstat', { length: 50 }),
    vatNumber: varchar('vat_number', { length: 50 }),
    isVat: boolean('is_vat').notNull().default(false),
    /** "Партньорът се използва често" flag; sorts the list. */
    priority: smallint('priority').notNull().default(0),
    groupId: integer('group_id').notNull().default(1),
    isDeleted: boolean('is_deleted').notNull().default(false),
    dueDays: integer('due_days').notNull().default(0),
    email: varchar('email', { length: 255 }),
    isNotUsing: boolean('is_not_using').notNull().default(false),
    nameInOtherLanguage: text('name_in_other_language'),
    code: text('code'),
    lastModifiedDate: timestamp('last_modified_date', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_companies_name').on(t.name), index('ix_companies_bulstat').on(t.bulstat)],
);

/** Accounts a partner may be used with. */
export const companyAccounts = pgTable('company_accounts', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
});

export const addressTypes = pgTable('address_types', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  description: varchar('description', { length: 255 }).notNull(),
});

export const countries = pgTable('countries', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 80 }).notNull(),
  code: varchar('code', { length: 3 }).notNull(),
  nameInOtherLang: varchar('name_in_other_lang', { length: 80 }).notNull().default(''),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const addresses = pgTable('addresses', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  ownerType: varchar('owner_type', { length: 10 }).notNull(), // 'company' | 'my' | 'branch'
  ownerId: integer('owner_id').notNull(),
  address: varchar('address', { length: 255 }),
  address1: varchar('address1', { length: 255 }),
  city: varchar('city', { length: 50 }),
  city1: varchar('city1', { length: 50 }),
  phone: varchar('phone', { length: 100 }),
  postalCode: varchar('postal_code', { length: 10 }),
  isPrimary: boolean('is_primary').notNull().default(false),
  addressTypeId: integer('address_type_id'),
  countryId: integer('country_id'),
}, (t) => [index('ix_addresses_owner').on(t.ownerType, t.ownerId)]);

export const banks = pgTable('banks', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  code: varchar('code', { length: 50 }),
  name: varchar('name', { length: 255 }),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const bankAccounts = pgTable('bank_accounts', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  ownerType: varchar('owner_type', { length: 10 }).notNull(), // 'company' | 'my'
  ownerId: integer('owner_id').notNull(),
  bankId: integer('bank_id'),
  account: varchar('account', { length: 50 }).notNull(),
  bankStatementAccountId: integer('bank_statement_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  isOnlineAccount: boolean('is_online_account').notNull().default(false),
  isEuro: boolean('is_euro').notNull().default(false),
}, (t) => [index('ix_bank_accounts_owner').on(t.ownerType, t.ownerId)]);

export const branches = pgTable('branches', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  contactName: varchar('contact_name', { length: 255 }),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const myCompany = pgTable('my_company', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  name1: varchar('name1', { length: 255 }),
  contactName: varchar('contact_name', { length: 255 }),
  contactName1: varchar('contact_name1', { length: 255 }),
  contactPosition: varchar('contact_position', { length: 255 }),
  accountant: varchar('accountant', { length: 255 }).notNull().default(''),
  accountant1: varchar('accountant1', { length: 255 }),
  email: varchar('email', { length: 255 }),
  bulstat: varchar('bulstat', { length: 50 }).notNull().default(''),
  vatId: varchar('vat_id', { length: 50 }),
  vatDeclarationSubscriberName: varchar('vat_declaration_subscriber_name', { length: 255 }),
  vatDeclarationSubscriberEgn: varchar('vat_declaration_subscriber_egn', { length: 50 }),
  vatDeclarationSubscriberPosition: varchar('vat_declaration_subscriber_position', { length: 255 }),
  /** 1 = Представляващ, 2 = Пълномощник */
  vatDeclarationSubscriberRole: integer('vat_declaration_subscriber_role'),
  isVat: boolean('is_vat').notNull().default(false),
  isNotVat: boolean('is_not_vat').notNull().default(false),
});
