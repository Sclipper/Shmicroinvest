import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  ACCOUNT_CATEGORIES, COMMERCIAL_CHART, MULTI_CATEGORIES, PRODUCT_CATEGORIES, isValidAccountNumber, nextAccountNumber, normalizeAccountNumber,
  parseChartTemplate, rebuildNestedSet, type ChartTemplateType, type ValidationMessage,
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
  return nextAccountNumber(parent.number, children.map((c) => c.number), await accountSeparator(db));
}

/** Chart editor messages (03a 1.6, 1.7, 1.8). */
export const CHART_MESSAGES = {
  strInvalidAccountNumber: 'Невалиден номер на сметка!',
  strAccountAlreadyExists: 'Вече съществува сметка със зададения номер.',
  strAccountAlreadyExistsAndIsHidden: 'Вече съществува сметка със зададения номер. Сметката е маркирана като „Сметката не се ползва“.',
  strInvalidAccountDescription: 'Въведете описание на сметката.',
  strNoMaterialAccount: 'Сметката не може да бъде от тип материална, тъй като не поддържа работа с продукти/стоки/материали.',
  strAccountCategoryDifferentFromParent: 'Избраната категория на подсметката се различава от категорията на главната сметка.',
  strAccountCategoryAlreadyTakenError: 'Вече съществува сметка, попадаща в избраната категория.',
  strCanNotAddSubAccount: 'Не е позволено създаването на подсметка на избраната сметка!',
  strAccountCannotBeDeleted: 'Сметката не може да бъде изтрита!',
} as const;
const crit = (key: keyof typeof CHART_MESSAGES, extra = ''): ValidationMessage => ({ key, text: CHART_MESSAGES[key] + extra, severity: 'critical' });

type AccountRow = typeof s.accounts.$inferSelect;

async function validateAccount(db: DbOrTx, o: { parent: AccountRow; self?: AccountRow; number: string; description: string; categoryId: number | null; productId: number | null }) {
  const out: ValidationMessage[] = [];
  const sep = await accountSeparator(db);
  if (!isValidAccountNumber(o.parent.number, o.number, sep)) out.push(crit('strInvalidAccountNumber'));
  const [dup] = await db.select().from(s.accounts).where(and(eq(s.accounts.number, o.number), eq(s.accounts.isEuro, o.parent.isEuro)));
  if (dup && dup.id !== o.self?.id) out.push(crit(dup.isHidden ? 'strAccountAlreadyExistsAndIsHidden' : 'strAccountAlreadyExists'));
  if (!o.description.trim()) out.push(crit('strInvalidAccountDescription'));
  if (o.productId != null && !(PRODUCT_CATEGORIES as readonly number[]).includes(o.categoryId ?? -1)) out.push(crit('strNoMaterialAccount'));
  if (o.categoryId != null && o.parent.accountCategoryId != null && o.parent.number !== '0' && o.categoryId !== o.parent.accountCategoryId) {
    out.push(crit('strAccountCategoryDifferentFromParent'));
  }
  const inherited = o.categoryId != null && o.categoryId === o.parent.accountCategoryId;
  const changed = o.categoryId !== (o.self?.accountCategoryId ?? null);
  if (o.categoryId != null && !inherited && changed && !(MULTI_CATEGORIES as readonly number[]).includes(o.categoryId)) {
    // Another account outside this account's own branch already has the category.
    const holders = await db.select().from(s.accounts).where(and(eq(s.accounts.accountCategoryId, o.categoryId), eq(s.accounts.isEuro, o.parent.isEuro)));
    const sameBranch = (h: AccountRow) => o.number.startsWith(h.number) || h.number.startsWith(o.number);
    if (holders.some((h) => h.id !== o.self?.id && !sameBranch(h))) out.push(crit('strAccountCategoryAlreadyTakenError'));
  }
  if (out.length) throw new ApiError(422, 'Сметката не може да бъде записана.', out);
}

/** Add-sub rule (CanAddSub): the parent is neither material nor in foreign currency. */
async function assertCanAddSub(db: DbOrTx, parent: AccountRow) {
  const [root] = await db.select().from(s.accounts).where(and(eq(s.accounts.number, '0'), eq(s.accounts.isEuro, parent.isEuro)));
  if (parent.productId != null || (parent.number !== '0' && root && parent.currencyId !== root.currencyId)) {
    throw new ApiError(422, CHART_MESSAGES.strCanNotAddSubAccount, [crit('strCanNotAddSubAccount')]);
  }
}


export async function addAccount(db: DbOrTx, input: AccountInput) {
  const [parent] = await db.select().from(s.accounts).where(eq(s.accounts.id, input.parentId));
  if (!parent) throw badRequest('Невалидна сметка.');
  const sep = await accountSeparator(db);
  const number = input.number?.trim() ? normalizeAccountNumber(input.number, sep) : await suggestSubAccountNumber(db, parent.id);
  await assertCanAddSub(db, parent);
  await validateAccount(db, { parent, number, description: input.description, categoryId: input.accountCategoryId === undefined ? parent.accountCategoryId : input.accountCategoryId, productId: input.productId ?? null });
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
  if (input.number) input.number = normalizeAccountNumber(input.number, await accountSeparator(db));
  const [parent] = acc.parentId != null ? await db.select().from(s.accounts).where(eq(s.accounts.id, acc.parentId)) : [];
  if (parent) {
    await validateAccount(db, {
      parent, self: acc, number: input.number ?? acc.number, description: input.description ?? acc.description,
      categoryId: input.accountCategoryId === undefined ? acc.accountCategoryId : input.accountCategoryId,
      productId: input.productId === undefined ? acc.productId : input.productId,
    });
  }
  if (input.number && input.number !== acc.number) {
    if (used) throw badRequest('Номерът на сметка с осчетоводени операции не може да бъде променян.');
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

/** Reasons that block deleting an account (03a 1.8 DeleteAccount). */
export async function deleteBlockers(db: DbOrTx, id: number) {
  const out: string[] = [];
  const children = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
  if (children.length) out.push('Сметката има подсметки.');
  if (await isAccountUsed(db, id)) out.push('Сметката участва в операции.');
  // Tables added by other modules (templates, fixed assets, reschedules) are checked when present.
  for (const [table, cols, text] of [
    ['accounting_templates_details', ['account_id', 'ref_account_id'], 'Сметката участва в шаблони за контиране.'],
    ['fixed_assets', ['debit_account_id', 'credit_account_id', 'inventory_account_id'], 'Сметката участва в дълготрайни активи.'],
    ['accounting_reschedules', ['debit_account_id', 'credit_account_id'], 'Сметката участва в разсрочвания.'],
  ] as const) {
    const existing = (await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`)) as unknown as { rows: { column_name: string }[] };
    const present = cols.filter((c) => existing.rows.some((r) => r.column_name === c));
    if (!present.length) continue;
    const res = (await db.execute(sql.raw(`SELECT 1 FROM ${table} WHERE ${present.map((c) => `${c} = ${Number(id)}`).join(' OR ')} LIMIT 1`))) as unknown as { rows: unknown[] };
    if (res.rows.length) out.push(text);
  }
  return out;
}

/** What the delete confirmation must mention (03a 1.8). */
export async function deleteInfo(db: DbOrTx, id: number) {
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(s.companyAccounts).where(eq(s.companyAccounts.accountId, id));
  const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(s.bankAccounts).where(eq(s.bankAccounts.bankStatementAccountId, id));
  return { hasPartners: (p?.n ?? 0) > 0, hasBankAccount: (b?.n ?? 0) > 0, blockers: await deleteBlockers(db, id) };
}

/**
 * "Move" is copy (03a 1.7): copies the subtree of an account under a target
 * with newly generated numbers (description, currency, nature and category).
 */
export async function copyAccounts(db: DbOrTx, sourceId: number, targetId: number) {
  const [src] = await db.select().from(s.accounts).where(eq(s.accounts.id, sourceId));
  const [target] = await db.select().from(s.accounts).where(eq(s.accounts.id, targetId));
  if (!src || !target || src.number === '0') throw badRequest('Невалидна сметка.');
  if (target.number.startsWith(src.number) && src.isEuro === target.isEuro) throw new ApiError(422, CHART_MESSAGES.strCanNotAddSubAccount, [crit('strCanNotAddSubAccount')]);
  await assertCanAddSub(db, target);
  if (await isAccountUsed(db, target.id)) throw new ApiError(422, CHART_MESSAGES.strCanNotAddSubAccount, [crit('strCanNotAddSubAccount')]);
  const all = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, src.isEuro));
  const sep = await accountSeparator(db);
  let copied = 0;
  const copyNode = async (node: AccountRow, parent: AccountRow) => {
    const siblings = await db.select({ number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.parentId, parent.id));
    const number = nextAccountNumber(parent.number, siblings.map((x) => x.number), sep);
    const [row] = await db.insert(s.accounts).values({
      parentId: parent.id, number, description: node.description, englishDescription: node.englishDescription,
      accountCategoryId: node.accountCategoryId ?? parent.accountCategoryId, currencyId: node.currencyId, isActive: node.isActive, isEuro: parent.isEuro,
    }).returning();
    copied++;
    for (const child of all.filter((a) => a.parentId === node.id).sort((a, b) => a.number.localeCompare(b.number))) await copyNode(child, row!);
  };
  await copyNode(src, target);
  await rebuildAccountsTree(db);
  return { copied };
}

/** Delete rules (spec 01a 4.4): refused when it has sub-accounts or is used. */
export async function deleteAccount(db: DbOrTx, id: number) {
  const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, id));
  if (!acc) throw badRequest('Невалидна сметка.');
  if (acc.number === '0') throw badRequest('Коренът на сметкоплана не може да бъде изтрит.');
  const reasons = await deleteBlockers(db, id);
  if (reasons.length) throw new ApiError(422, CHART_MESSAGES.strAccountCannotBeDeleted, reasons.map((r) => ({ key: 'strAccountCannotBeDeleted', text: r, severity: 'critical' as const })));
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
