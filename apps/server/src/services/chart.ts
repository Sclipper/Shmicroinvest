import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  ACCOUNT_CATEGORIES, COMMERCIAL_CHART, MULTI_CATEGORIES, isValidAccountNumber, nextAccountNumber, normalizeAccountNumber,
  parseChartTemplate, rebuildNestedSet, isProductCategory, isProductReleaseCategory, productAccountTypeFor, stockMessage,
  effectiveConcludeAccountId, type ChartTemplateType, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { getConfig, setConfig } from './config.ts';
import { baseCurrencyId } from './journal.ts';

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
  /** Usable for bank statements (IsForBanks, 01a 4.1). */
  isForBanks?: boolean;
  iban?: string | null;
  /** Editor type radios (03a 1.5): omitted = keep legacy behaviour (currency/product as given). */
  accountType?: 'standard' | 'currency' | 'material';
  /** Material account: product measure and code. */
  measure?: string | null;
  productCode?: string | null;
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

const chartBaseCurrency = (db: DbOrTx, isEuro: boolean) => baseCurrencyId(db, isEuro ? 2026 : 2025);

type AccountRow = typeof s.accounts.$inferSelect;

/** Validation of the account editor (03a 1.6); all Critical, reported together. */
async function validateAccount(db: DbOrTx, parent: AccountRow, input: Partial<AccountInput>, number: string, existing?: AccountRow) {
  const msgs: ValidationMessage[] = [];
  if (!existing || number !== existing.number) {
    if (!isValidAccountNumber(parent.number, number, await accountSeparator(db))) msgs.push(crit('strInvalidAccountNumber'));
    const same = await db.select({ id: s.accounts.id, isHidden: s.accounts.isHidden }).from(s.accounts).where(and(eq(s.accounts.number, number), eq(s.accounts.isEuro, parent.isEuro)));
    const clash = same.find((r) => r.id !== existing?.id);
    if (clash) msgs.push(crit(clash.isHidden ? 'strAccountAlreadyExistsAndIsHidden' : 'strAccountAlreadyExists'));
  }
  const description = input.description ?? existing?.description ?? '';
  if (!description.trim()) msgs.push(crit('strInvalidAccountDescription'));
  const category = input.accountCategoryId === undefined ? (existing?.accountCategoryId ?? parent.accountCategoryId) : input.accountCategoryId;
  const differs = parent.number !== '0' && parent.accountCategoryId != null && category != null && category !== parent.accountCategoryId;
  if (differs) msgs.push(crit('strAccountCategoryDifferentFromParent'));
  const productId = input.productId === undefined ? existing?.productId : input.productId;
  const material = input.accountType === 'material' || (input.accountType === undefined && productId != null);
  if (material && !isProductCategory(category) && !isProductReleaseCategory(category)) msgs.push(crit('strNoMaterialAccount'));
  if (input.accountType === 'material' && !input.measure?.trim()) msgs.push(stockMessage('strProductMeasureError'));
  if (input.accountType === 'currency') {
    const base = await chartBaseCurrency(db, parent.isEuro);
    if (!input.currencyId || input.currencyId === base) msgs.push(stockMessage('strAccountCurrencyNotSelected'));
  }
  // Single-account categories: another account outside this account's own branch already has it.
  const inherited = category != null && category === parent.accountCategoryId;
  const changed = category !== (existing?.accountCategoryId ?? null);
  if (category != null && !differs && !inherited && changed && !(MULTI_CATEGORIES as readonly number[]).includes(category)) {
    const holders = await db.select().from(s.accounts).where(and(eq(s.accounts.accountCategoryId, category), eq(s.accounts.isEuro, parent.isEuro)));
    const sameBranch = (h: AccountRow) => number.startsWith(h.number) || h.number.startsWith(number);
    if (holders.some((h) => h.id !== existing?.id && !sameBranch(h))) msgs.push(crit('strAccountCategoryAlreadyTakenError'));
  }
  if (msgs.length) throw new ApiError(422, 'Сметката не може да бъде записана.', msgs);
  return category ?? null;
}

/** Material account: create or update its product and the ProductAccounts link (03a 1.6 ApplyChanges). */
async function upsertAccountProduct(db: DbOrTx, account: AccountRow, input: Partial<AccountInput>) {
  const name = account.description;
  if (account.productId) {
    await db.update(s.products).set({ name, code: input.productCode ?? null, measure: input.measure!.trim() }).where(eq(s.products.id, account.productId));
    // The other accounts of the product follow the new name.
    const others = await db.select({ accountId: s.productAccounts.accountId }).from(s.productAccounts).where(eq(s.productAccounts.productId, account.productId));
    const ids = others.map((o) => o.accountId).filter((id) => id !== account.id);
    if (ids.length) await db.update(s.accounts).set({ description: name }).where(inArray(s.accounts.id, ids));
    const [link] = await db.select().from(s.productAccounts).where(and(eq(s.productAccounts.productId, account.productId), eq(s.productAccounts.accountId, account.id)));
    if (!link) await db.insert(s.productAccounts).values({ productId: account.productId, accountId: account.id, accountType: productAccountTypeFor(account.accountCategoryId) });
    return account.productId;
  }
  const [p] = await db.insert(s.products).values({ name, code: input.productCode ?? null, measure: input.measure!.trim() }).returning({ id: s.products.id });
  await db.insert(s.productAccounts).values({ productId: p!.id, accountId: account.id, accountType: productAccountTypeFor(account.accountCategoryId) });
  await db.update(s.accounts).set({ productId: p!.id }).where(eq(s.accounts.id, account.id));
  return p!.id;
}

/** Drop the product link of an account that stops being material; the product is soft-deleted when it has no accounts left. */
async function dropAccountProduct(db: DbOrTx, account: AccountRow) {
  if (!account.productId) return;
  await db.delete(s.productAccounts).where(and(eq(s.productAccounts.productId, account.productId), eq(s.productAccounts.accountId, account.id)));
  await db.update(s.accounts).set({ productId: null }).where(eq(s.accounts.id, account.id));
  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(s.productAccounts).where(eq(s.productAccounts.productId, account.productId));
  if ((left?.n ?? 0) === 0) await db.update(s.products).set({ isDeleted: true }).where(eq(s.products.id, account.productId));
}

/** CanAddSub (03a 1.6, partial): parent not material and not a foreign-currency account. */
export async function canAddSubAccount(db: DbOrTx, parent: AccountRow) {
  if (parent.productId != null) return false;
  if (parent.number !== '0' && parent.currencyId !== (await chartBaseCurrency(db, parent.isEuro))) return false;
  return true;
}

const cannotAddSub = () => new ApiError(422, CHART_MESSAGES.strCanNotAddSubAccount, [crit('strCanNotAddSubAccount')]);

export async function addAccount(db: DbOrTx, input: AccountInput) {
  const [parent] = await db.select().from(s.accounts).where(eq(s.accounts.id, input.parentId));
  if (!parent) throw badRequest('Невалидна сметка.');
  const sep = await accountSeparator(db);
  const number = input.number?.trim() ? normalizeAccountNumber(input.number, sep) : await suggestSubAccountNumber(db, parent.id);
  if (parent.number !== '0' && !(await canAddSubAccount(db, parent))) throw cannotAddSub();
  const category = await validateAccount(db, parent, input, number);
  if (await isAccountUsed(db, parent.id)) {
    throw badRequest(`Сметка ${parent.number} има осчетоводени операции и не може да има подсметки.`);
  }
  const base = await chartBaseCurrency(db, parent.isEuro);
  const currencyId = input.accountType === 'currency' ? input.currencyId! : input.accountType ? base : (input.currencyId ?? parent.currencyId);
  const isActive = input.isActive === undefined ? parent.isActive : input.isActive;
  const [row] = await db.insert(s.accounts).values({
    parentId: parent.id,
    number,
    description: input.description.trim(),
    englishDescription: input.englishDescription ?? '',
    accountCategoryId: category,
    currencyId,
    productId: input.productId ?? null,
    isActive,
    concludeAccountId: effectiveConcludeAccountId(null, isActive, await checkConcludeAccount(db, parent.isEuro, input.concludeAccountId ?? null)),
    isHidden: input.isHidden ?? false,
    isForBanks: input.isForBanks ?? false,
    isEuro: parent.isEuro,
    iban: input.iban ?? null,
  }).returning();
  if (input.accountType === 'material') row!.productId = await upsertAccountProduct(db, row!, input);
  await rebuildAccountsTree(db);
  return row!;
}

/** The conclude account must be an account of the same chart. */
async function checkConcludeAccount(db: DbOrTx, isEuro: boolean, id: number | null) {
  if (id == null) return null;
  const [c] = await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts).where(and(eq(s.accounts.id, id), eq(s.accounts.isEuro, isEuro)));
  if (!c || c.number === '0') throw badRequest('Невалидна сметка за приключване.');
  return c.id;
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
  const [parent] = acc.parentId ? await db.select().from(s.accounts).where(eq(s.accounts.id, acc.parentId)) : [];
  const used = await isAccountUsed(db, id);
  const number = input.number?.trim() ? normalizeAccountNumber(input.number, await accountSeparator(db)) : acc.number;
  if (number !== acc.number) {
    if (used) throw badRequest('Номерът на сметка с осчетоводени операции не може да бъде променян.');
    const children = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
    if (children.length) throw badRequest('Номерът на сметка с подсметки не може да бъде променян.');
  }
  if (parent) await validateAccount(db, parent, input, number, acc);
  const base = await chartBaseCurrency(db, acc.isEuro);
  let currencyId = input.currencyId ?? acc.currencyId;
  if (input.accountType === 'standard' || input.accountType === 'material') currencyId = base;
  const becomesMaterial = input.accountType === 'material';
  const stopsMaterial = input.accountType !== undefined && input.accountType !== 'material' && acc.productId != null;
  // Type, currency and measure lock once postings exist (CanModifyLockableProperties).
  if (used && (currencyId !== acc.currencyId || (becomesMaterial && !acc.productId) || stopsMaterial
    || (input.productId !== undefined && input.productId !== acc.productId))) {
    throw badRequest('Валутата и материалността на сметка с осчетоводени операции не могат да бъдат променяни.');
  }
  if (becomesMaterial || input.accountType === 'currency') {
    const kids = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
    if (kids.length || acc.level <= 2) throw badRequest('Типът може да се променя само на аналитична сметка без подсметки.');
  }
  const isActive = input.isActive === undefined ? acc.isActive : input.isActive;
  const concludeAccountId = input.concludeAccountId === undefined ? acc.concludeAccountId : await checkConcludeAccount(db, acc.isEuro, input.concludeAccountId);
  const [row] = await db.update(s.accounts).set({
    number,
    description: input.description?.trim() ?? acc.description,
    englishDescription: input.englishDescription ?? acc.englishDescription,
    accountCategoryId: input.accountCategoryId === undefined ? acc.accountCategoryId : input.accountCategoryId,
    currencyId,
    productId: input.productId === undefined ? acc.productId : input.productId,
    isActive,
    concludeAccountId: effectiveConcludeAccountId(acc.id, isActive, concludeAccountId),
    isHidden: input.isHidden ?? acc.isHidden,
    isForBanks: input.isForBanks ?? acc.isForBanks,
    iban: input.iban === undefined ? acc.iban : input.iban,
  }).where(eq(s.accounts.id, id)).returning();
  if (becomesMaterial) row!.productId = await upsertAccountProduct(db, row!, input);
  else if (stopsMaterial) {
    await dropAccountProduct(db, acc);
    row!.productId = null;
  } else if (row!.productId && row!.description !== acc.description) {
    // Renaming a product account renames the product and its other accounts.
    await db.update(s.products).set({ name: row!.description }).where(eq(s.products.id, row!.productId));
    const others = await db.select({ accountId: s.productAccounts.accountId }).from(s.productAccounts).where(eq(s.productAccounts.productId, row!.productId));
    const ids = others.map((o) => o.accountId).filter((x) => x !== id);
    if (ids.length) await db.update(s.accounts).set({ description: row!.description }).where(inArray(s.accounts.id, ids));
  }
  if (number !== acc.number) await rebuildAccountsTree(db);
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
    ['accounting_template_details', ['account_id'], 'Сметката участва в шаблони за контиране.'],
    ['fixed_assets', ['debit_account_id', 'credit_account_id', 'inventory_account_id'], 'Сметката участва в дълготрайни активи.'],
    ['accounting_reschedules', ['debit_account_id', 'credit_account_id'], 'Сметката участва в разсрочвания.'],
    ['bank_template_details', ['account_id', 'ref_account_id'], 'Сметката участва в шаблони за банков импорт.'],
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

/** Why an account cannot be deleted (01a 4.4): sub-accounts, journal lines, templates, reschedules. */
export async function accountDeleteBlockers(db: DbOrTx, id: number) {
  const reasons: string[] = [];
  const children = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, id));
  if (children.length) reasons.push('Сметката не може да бъде изтрита, защото има подсметки.');
  if (await isAccountUsed(db, id)) reasons.push('Сметката не може да бъде изтрита, защото участва в операции.');
  const [t] = (await exec(db, sql`SELECT count(*)::int AS n FROM accounting_template_details WHERE account_id = ${id}`)).rows as { n: number }[];
  if ((t?.n ?? 0) > 0) reasons.push('Сметката не може да бъде изтрита, защото участва в шаблон за контиране.');
  const [r] = (await exec(db, sql`SELECT count(*)::int AS n FROM accounting_reschedules WHERE debit_account_id = ${id} OR credit_account_id = ${id}`)).rows as { n: number }[];
  if ((r?.n ?? 0) > 0) reasons.push('Сметката не може да бъде изтрита, защото участва в картон за разсрочване.');
  return reasons;
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
  await db.delete(s.productAccounts).where(eq(s.productAccounts.accountId, id));
  await db.delete(s.accounts).where(eq(s.accounts.id, id));
  if (acc.productId) {
    const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(s.productAccounts).where(eq(s.productAccounts.productId, acc.productId));
    if ((left?.n ?? 0) === 0) await db.update(s.products).set({ isDeleted: true }).where(eq(s.products.id, acc.productId));
  }
  await rebuildAccountsTree(db);
}

/**
 * Account templates (F4, ChooseAccountTemplateCommand, 03a 1.6): accounts of
 * the commercial template that are not in the chart yet.
 */
export async function accountTemplates(db: DbOrTx, isEuro: boolean, q?: string) {
  const existing = await db.select({ number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.isEuro, isEuro));
  const have = new Set(existing.map((e) => e.number));
  const needle = q?.trim().toLowerCase() ?? '';
  return parseChartTemplate(COMMERCIAL_CHART)
    .filter((a) => !have.has(a.number))
    .filter((a) => !needle || a.number.startsWith(needle) || a.description.toLowerCase().includes(needle))
    .map((a) => ({ number: a.number, description: a.description, categoryId: a.categoryId, isActive: a.isActive, parentNumber: a.parentNumber }));
}

/**
 * Copy sub-accounts (03a 1.7 "Move is copy"): each selected subtree is copied
 * under the target with newly generated numbers; description, currency
 * (matched by ISO code in the target chart), nature and category are copied.
 */
export async function copyAccounts(db: DbOrTx, ids: number[], targetId: number) {
  const [target] = await db.select().from(s.accounts).where(eq(s.accounts.id, targetId));
  if (!target) throw badRequest('Невалидна сметка.');
  if (target.number === '0') throw cannotAddSub();
  if (!(await canAddSubAccount(db, target)) || (target.number !== '0' && (await isAccountUsed(db, target.id)))) throw cannotAddSub();
  const all = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, target.isEuro));
  const kids = new Map<number, AccountRow[]>();
  for (const a of all) if (a.parentId != null) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
  const currencies = await db.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies);
  const isoById = new Map(currencies.map((c) => [c.id, c.iso]));
  const idByIso = new Map(currencies.map((c) => [c.iso, c.id]));
  const sep = await accountSeparator(db);
  // A selected account inside another selected subtree is copied with its ancestor only.
  const selected = new Set(ids);
  const ancestorSelected = (a: AccountRow) => {
    let p = a.parentId;
    while (p != null) {
      if (selected.has(p)) return true;
      p = all.find((x) => x.id === p)?.parentId ?? null;
    }
    return false;
  };
  const sources = all.filter((a) => selected.has(a.id) && !ancestorSelected(a));
  if (!sources.length) throw badRequest('Няма избрани сметки за копиране.');
  for (const src of sources) {
    // Copying a subtree into itself would loop forever.
    let p: number | null = target.id;
    while (p != null) {
      if (p === src.id) throw cannotAddSub();
      p = all.find((x) => x.id === p)?.parentId ?? null;
    }
  }
  let copied = 0;
  const copyNode = async (src: AccountRow, parent: { id: number; number: string }) => {
    const siblings = await db.select({ number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.parentId, parent.id));
    const number = nextAccountNumber(parent.number, siblings.map((x) => x.number), sep);
    const currencyId = idByIso.get(isoById.get(src.currencyId) ?? '') ?? src.currencyId;
    const [row] = await db.insert(s.accounts).values({
      parentId: parent.id, number, description: src.description, englishDescription: src.englishDescription,
      accountCategoryId: src.accountCategoryId ?? target.accountCategoryId, currencyId, isActive: src.isActive, isEuro: target.isEuro,
    }).returning({ id: s.accounts.id, number: s.accounts.number });
    copied++;
    for (const k of (kids.get(src.id) ?? []).sort((a, b) => (a.number < b.number ? -1 : 1))) await copyNode(k, row!);
  };
  for (const src of sources) await copyNode(src, target);
  await rebuildAccountsTree(db);
  return { copied };
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
