import { sql } from 'drizzle-orm';
import {
  ADDRESS_TYPES, BANKS, COUNTRIES, CURRENCIES, DEFAULT_ROLES, DOCUMENT_TYPES, ICA_TYPES, PERMISSIONS,
  RESET_YEARLY_CHANNELS, SEEDED_DENIALS, SEQUENCE_CHANNELS, TRANSACTION_TYPES, VAT_TERMS, VIESES,
  type ChartTemplateType,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { hashPassword } from '../lib/password.ts';
import { applyChartTemplate } from './chart.ts';

export const PRODUCT_VERSION = '1.01.089';

export async function fixIdentity(db: DbOrTx, table: string) {
  await db.execute(sql.raw(
    `SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST((SELECT coalesce(max(id), 0) FROM ${table}), 1))`,
  ));
}

export interface NewCompanyOptions {
  companyName: string;
  adminName: string;
  adminPassword: string;
  year: number;
  chartTemplate?: ChartTemplateType | null;
  bulstat?: string;
}

/** Seeds a new company database (spec 01a section 9, 01b section 1). */
export async function seedCompany(db: DbOrTx, o: NewCompanyOptions) {
  await db.insert(s.system).values({ version: PRODUCT_VERSION, productId: 4, companyName: o.companyName, code: '0' });

  // Roles as a nested set: root 1 (left 1, right 10), four children.
  await db.insert(s.userRoles).values(DEFAULT_ROLES.map((r, i) => ({
    id: r.id, name: r.name, parentId: r.parentId, isReadOnly: r.isReadOnly,
    leftIndex: i === 0 ? 1 : 2 * i, rightIndex: i === 0 ? 2 * DEFAULT_ROLES.length : 2 * i + 1, level: i === 0 ? 1 : 2,
  })));
  await fixIdentity(db, 'user_roles');

  await db.insert(s.permissions).values(PERMISSIONS.map(([id, key, name, parentId, groupOrder]) => ({ id, key, name, parentId, groupOrder, defaultValue: true })));
  await fixIdentity(db, 'permissions');
  const idByKey = new Map(PERMISSIONS.map(([id, key]) => [key, id]));
  for (const [role, keys] of Object.entries(SEEDED_DENIALS)) {
    await db.insert(s.userRolePermissions).values(keys.map((k) => ({ userRoleId: Number(role), permissionId: idByKey.get(k)!, value: false })));
  }

  await db.insert(s.users).values({ id: 1, name: o.adminName, passwordHash: await hashPassword(o.adminPassword), userRoleId: 2 });
  await fixIdentity(db, 'users');

  await db.insert(s.configuration).values([
    { key: 'AccountsSeparator', value: '/', userId: null },
    { key: 'ActiveFinancialYear', value: String(o.year), userId: 1 },
    { key: 'IsBindingDocumentsEnabled', value: 'True', userId: null },
    { key: 'IsAutomaticOpenBindingDocumentsEnabled', value: 'False', userId: null },
    { key: 'IsBindingBySumEnabled', value: 'True', userId: null },
  ]);

  const [fy] = await db.insert(s.financialYears).values({ year: o.year, startDate: `${o.year}-01-01` }).returning();

  await db.insert(s.currencies).values(CURRENCIES.map((c) => ({
    id: c.id, isoCode: c.iso, name: c.name, exchangeRate: c.rate, fixedRate: c.rate,
  })));
  await fixIdentity(db, 'currencies');

  await db.insert(s.transactionTypes).values(TRANSACTION_TYPES.map((t) => ({ ...t })));
  await db.insert(s.vieses).values(VIESES.map((v) => ({ ...v })));
  await db.insert(s.vatTerms).values(VAT_TERMS.map((v) => ({ ...v, vatValue: String(v.vatValue) })));
  await db.insert(s.icaTypes).values(ICA_TYPES.map((v) => ({ ...v })));
  await db.insert(s.documentTypes).values(DOCUMENT_TYPES.map((d, i) => ({
    id: d.id, name: d.name, shortName: d.shortName, code: d.code, position: i + 1,
    sequenceChannel: d.channel, isVisible: d.visible,
  })));
  for (const t of ['transaction_types', 'vieses', 'vat_terms', 'ica_types', 'document_types']) await fixIdentity(db, t);

  await db.insert(s.sequences).values(SEQUENCE_CHANNELS.map((channel) => ({
    channel,
    financialYearId: RESET_YEARLY_CHANNELS.has(channel) ? fy!.id : null,
    isNumberResetNextYear: RESET_YEARLY_CHANNELS.has(channel),
  })));

  await db.insert(s.countries).values(COUNTRIES.map((c) => ({ name: c.name, code: c.code, nameInOtherLang: c.nameEn })));
  await db.insert(s.banks).values(BANKS.map((b) => ({ code: b.code, name: b.name })));
  await db.insert(s.addressTypes).values(ADDRESS_TYPES.map((a) => ({ ...a })));
  await fixIdentity(db, 'address_types');

  await db.insert(s.myCompany).values({ id: 1, name: o.companyName, bulstat: o.bulstat ?? '' });
  await fixIdentity(db, 'my_company');
  await db.insert(s.branches).values({ id: 1, code: '0', name: 'Основен Клон' });
  await fixIdentity(db, 'branches');
  await db.insert(s.companyGroups).values({ id: 1, name: 'Основна група', leftIndex: 1, rightIndex: 2, level: 1 });
  await fixIdentity(db, 'company_groups');
  await db.insert(s.productGroups).values({ id: 1, name: 'Основна група', leftIndex: 1, rightIndex: 2, level: 1 });
  await fixIdentity(db, 'product_groups');

  // Two chart roots: BGN (id 1) and EUR (id 2), mapped to each other.
  await db.insert(s.accounts).values([
    { id: 1, number: '0', description: 'Сметкоплан', currencyId: 1, isEuro: false, leftIndex: 1, rightIndex: 2, level: 1, isActive: true },
    { id: 2, number: '0', description: 'Сметкоплан', currencyId: 2, isEuro: true, leftIndex: 1, rightIndex: 2, level: 1, isActive: true },
  ]);
  await db.update(s.accounts).set({ mappedAccountId: 2 }).where(sql`id = 1`);
  await db.update(s.accounts).set({ mappedAccountId: 1 }).where(sql`id = 2`);
  await fixIdentity(db, 'accounts');

  if (o.chartTemplate) await applyChartTemplate(db, o.chartTemplate, o.year >= 2026);
}
