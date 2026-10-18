import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  ACCOUNT_CATEGORIES, COMMERCIAL_CHART, nextSubAccountNumber, parseChartTemplate, rebuildNestedSet,
  type ChartTemplateType,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { getConfig, setConfig } from './config.ts';

/** Full rebuild of Left/Right/Level for every chart (spRebuildAccountsTree). */
export async function rebuildAccountsTree(db: DbOrTx) {
  const rows = await db.select({ id: s.accounts.id, parentId: s.accounts.parentId, number: s.accounts.number, isEuro: s.accounts.isEuro }).from(s.accounts);
  const pos = rebuildNestedSet(rows);
  if (pos.size === 0) return;
  // One UPDATE ... FROM (VALUES ...) statement per chunk.
  const entries = [...pos.entries()];
  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    const values = sql.join(chunk.map(([id, p]) => sql`(${id}::int, ${p.left}::int, ${p.right}::int, ${p.level}::int)`), sql`, `);
    await db.execute(sql`
      UPDATE accounts AS a SET left_index = v.l, right_index = v.r, level = v.lv
      FROM (VALUES ${values}) AS v(id, l, r, lv) WHERE a.id = v.id`);
  }
}

export async function chartRoot(db: DbOrTx, isEuro: boolean) {
  const [root] = await db.select().from(s.accounts).where(and(eq(s.accounts.number, '0'), eq(s.accounts.isEuro, isEuro), sql`${s.accounts.parentId} is null`));
  if (!root) throw new ApiError(500, 'Липсва корен на сметкоплана.');
  return root;
}

/**
 * Template selection ("Избор на сметкоплан"): categories are inserted when the
 * table is empty, then template accounts not yet present (by number) are added
 * under their parents and the tree is rebuilt.
 */
export async function applyChartTemplate(db: DbOrTx, type: ChartTemplateType, isEuro: boolean, onlyNumbers?: string[]) {
  if (type !== 'commercial') throw badRequest('Този сметкоплан все още не е наличен. Използвайте "Фирмен (Търговски)".');
  const [{ count }] = (await db.select({ count: sql<number>`count(*)::int` }).from(s.accountCategories)) as [{ count: number }];
  if (count === 0) {
    await db.insert(s.accountCategories).values(
      ACCOUNT_CATEGORIES.map((c) => ({ id: c.id, typeIdentifier: c.id, code: c.code, description: c.description })),
    );
    await db.execute(sql`SELECT setval(pg_get_serial_sequence('account_categories','id'), (SELECT max(id) FROM account_categories))`);
  }
  const root = await chartRoot(db, isEuro);
  const currencyId = root.currencyId;
  let template = parseChartTemplate(COMMERCIAL_CHART);
  if (onlyNumbers) {
    const wanted = new Set(onlyNumbers);
    // Keep ancestors of wanted accounts so the tree stays connected.
    for (const a of template) if (wanted.has(a.number)) {
      let p = a.parentNumber;
      while (p !== '0') { wanted.add(p); p = template.find((t) => t.number === p)?.parentNumber ?? '0'; }
    }
    template = template.filter((a) => wanted.has(a.number));
  }
  const existing = await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.isEuro, isEuro));
  const idByNumber = new Map(existing.map((e) => [e.number, e.id]));
  idByNumber.set('0', root.id);
  let added = 0;
  for (const a of template) {
    if (idByNumber.has(a.number)) continue;
    const parentId = idByNumber.get(a.parentNumber);
    if (!parentId) continue;
    const [row] = await db.insert(s.accounts).values({
      parentId, number: a.number, description: a.description, accountCategoryId: a.categoryId,
      currencyId, isActive: a.isActive, isEuro,
    }).returning({ id: s.accounts.id });
    idByNumber.set(a.number, row!.id);
    added++;
  }
  await rebuildAccountsTree(db);
  await setConfig(db, 'ChartOfAccountsType', type);
  return { added };
}

export interface AccountInput {
  number?: string;
  parentId: number;
  description: string;
  englishDescription?: string | null;
  accountCategoryId?: number | null;
  currencyId?: number;
  productId?: number | null;
  isActive?: boolean | null;
  concludeAccountId?: number | null;
  isHidden?: boolean;
  iban?: string | null;
}

export async function accountSeparator(db: DbOrTx) {
  return (await getConfig(db, 'AccountsSeparator')) ?? '/';
}

export async function suggestSubAccountNumber(db: DbOrTx, parentId: number) {
  const [parent] = await db.select().from(s.accounts).where(eq(s.accounts.id, parentId));
  if (!parent) throw badRequest('Невалидна сметка.');
  const children = await db.select({ number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.parentId, parentId));
  return nextSubAccountNumber(parent.number, children.map((c) => c.number), await accountSeparator(db));
}

export async function addAccount(db: DbOrTx, input: AccountInput) {
  const [parent] = await db.select().from(s.accounts).where(eq(s.accounts.id, input.parentId));
  if (!parent) throw badRequest('Невалидна сметка.');
  const number = (input.number?.trim() || (await suggestSubAccountNumber(db, parent.id)));
  await assertNumberFree(db, number, parent.isEuro);
  if (parent.number !== '0' && !(number > parent.number && number.startsWith(parent.number))) {
    throw badRequest(`Номерът на подсметката трябва да започва с номера на сметка ${parent.number}.`);
  }
  if (await isAccountUsed(db, parent.id)) {
    throw badRequest(`Сметка ${parent.number} има осчетоводени операции и не може да има подсметки.`);
  }
  const [row] = await db.insert(s.accounts).values({
    parentId: parent.id,
    number,
    description: input.description.trim(),
    englishDescription: input.englishDescription ?? '',
    accountCategoryId: input.accountCategoryId ?? parent.accountCategoryId,
    currencyId: input.currencyId ?? parent.currencyId,
    productId: input.productId ?? null,
    isActive: input.isActive === undefined ? parent.isActive : input.isActive,
    concludeAccountId: input.concludeAccountId ?? null,
    isHidden: input.isHidden ?? false,
    isEuro: parent.isEuro,
    iban: input.iban ?? null,
  }).returning();
  await rebuildAccountsTree(db);
  return row!;
}

async function assertNumberFree(db: DbOrTx, number: string, isEuro: boolean, exceptId?: number) {
  const rows = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.number, number), eq(s.accounts.isEuro, isEuro)));
  if (rows.some((r) => r.id !== exceptId)) throw new ApiError(409, `Вече съществува сметка с номер ${number}.`);
}

export async function isAccountUsed(db: DbOrTx, accountId: number) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(s.accountingDetails)
    .where(or(eq(s.accountingDetails.accountId, accountId), eq(s.accountingDetails.refAccountId, accountId)));
  return (r?.n ?? 0) > 0;
}

export async function editAccount(db: DbOrTx, id: number, input: Partial<AccountInput>) {
  const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, id));
  if (!acc) throw badRequest('Невалидна сметка.');
  if (acc.number === '0') throw badRequest('Коренът на сметкоплана не може да се редактира.');
  const used = await isAccountUsed(db, id);
  if (input.number && input.number !== acc.number) {
    if (used) throw badRequest('Номерът на сметка с осчетоводени операции не може да бъде променян.');
    await assertNumberFree(db, input.number, acc.isEuro, id);
    const children = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
    if (children.length) throw badRequest('Номерът на сметка с подсметки не може да бъде променян.');
  }
  // Type, currency and measure lock once postings exist (CanModifyLockableProperties).
  if (used && ((input.currencyId !== undefined && input.currencyId !== acc.currencyId) || (input.productId !== undefined && input.productId !== acc.productId))) {
    throw badRequest('Валутата и материалността на сметка с осчетоводени операции не могат да бъдат променяни.');
  }
  const [row] = await db.update(s.accounts).set({
    number: input.number?.trim() ?? acc.number,
    description: input.description?.trim() ?? acc.description,
    englishDescription: input.englishDescription ?? acc.englishDescription,
    accountCategoryId: input.accountCategoryId === undefined ? acc.accountCategoryId : input.accountCategoryId,
    currencyId: input.currencyId ?? acc.currencyId,
    productId: input.productId === undefined ? acc.productId : input.productId,
    isActive: input.isActive === undefined ? acc.isActive : input.isActive,
    concludeAccountId: input.concludeAccountId === undefined ? acc.concludeAccountId : input.concludeAccountId,
    isHidden: input.isHidden ?? acc.isHidden,
    iban: input.iban === undefined ? acc.iban : input.iban,
  }).where(eq(s.accounts.id, id)).returning();
  return row!;
}

/** Delete rules (spec 01a 4.4): refused when it has sub-accounts or is used. */
export async function deleteAccount(db: DbOrTx, id: number) {
  const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, id));
  if (!acc) throw badRequest('Невалидна сметка.');
  if (acc.number === '0') throw badRequest('Коренът на сметкоплана не може да бъде изтрит.');
  const children = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
  if (children.length) throw badRequest('Сметката не може да бъде изтрита, защото има подсметки.');
  if (await isAccountUsed(db, id)) throw badRequest('Сметката не може да бъде изтрита, защото участва в операции.');
  await db.update(s.accounts).set({ mappedAccountId: null }).where(eq(s.accounts.mappedAccountId, id));
  await db.update(s.accounts).set({ concludeAccountId: null }).where(eq(s.accounts.concludeAccountId, id));
  await db.delete(s.companyAccounts).where(eq(s.companyAccounts.accountId, id));
  await db.update(s.bankAccounts).set({ bankStatementAccountId: null }).where(eq(s.bankAccounts.bankStatementAccountId, id));
  await db.delete(s.accounts).where(eq(s.accounts.id, id));
  await rebuildAccountsTree(db);
}

/** Accounts of the chart used by a given year, with derived flags. */
export async function loadChart(db: DbOrTx, isEuro: boolean) {
  const rows = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, isEuro)).orderBy(s.accounts.number);
  return rows;
}

export async function accountsByIds(db: DbOrTx, ids: number[]) {
  if (!ids.length) return [];
  return db.select().from(s.accounts).where(inArray(s.accounts.id, ids));
}
