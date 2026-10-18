import { eq, inArray } from 'drizzle-orm';
import { DataImportError, PRODUCT_CATEGORIES, PRODUCT_RELEASE_CATEGORIES, critical, type ExchangeMessageKey } from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { rebuildAccountsTree } from '../chart.ts';
import type { Chart, ImportAccount } from './common.ts';

/** Message keys of the two callers (XML 3.5 and Excel 5.4). */
export interface ProductMessages {
  notFound: (n: string) => DataImportError;
  category: (n: string, allowed: string) => DataImportError;
  type: (n: string) => DataImportError;
  subAccounts: (n: string) => DataImportError;
  noRelease: (name: string) => DataImportError;
}

export const XML_PRODUCT_MESSAGES: ProductMessages = {
  notFound: (n) => new DataImportError(critical('strAccountParentNotFound', n)),
  category: (n) => new DataImportError(critical('strXMLProductAccountCategoryError', n)),
  type: (n) => new DataImportError(critical('strXMLProductAccountTypeError', n)),
  subAccounts: (n) => new DataImportError(critical('strXMLProductAccountSubAccountsError', n)),
  noRelease: (name) => new DataImportError(critical('strProductHasNoReleaseAccount', name)),
};

export function excelProductMessages(row: number, letter: (k: string) => string): ProductMessages {
  const cell = (key: ExchangeMessageKey, col: string, ...rest: string[]) => new DataImportError(critical(key, row, letter(col), ...rest));
  return {
    notFound: (n) => cell('strProductAccountNotFound', 'IncrementAccount', n),
    category: (n, allowed) => cell('strProductAccountCategoryError', 'IncrementAccount', n, allowed),
    type: (n) => cell('strProductAccountTypeError', 'IncrementAccount', n),
    subAccounts: (n) => cell('strProductAccountSubAccountsError', 'IncrementAccount', n),
    noRelease: () => cell('strProductAccountNotFound', 'DecrementAccount', ''),
  };
}

export interface ProductInput { name: string; code: string; measure: string; price: string; supplyAccountNumber: string; releaseAccountNumber?: string | null }

const parentNumber = (n: string, sep = '/') => (n.includes(sep) ? n.slice(0, n.lastIndexOf(sep)) : '');

/**
 * Creates (or reuses) a product with its material sub-accounts (XML 3.5 / Excel 5.4):
 * the supply account becomes the parent of a new `parent/N`; the release
 * account likewise. Mutates `chart` so later rows see the new accounts.
 */
export async function importProduct(db: DbOrTx, chart: Chart, p: ProductInput, m: ProductMessages): Promise<{ productId: number; created: boolean }> {
  const resolveParent = (num: string, allowed: readonly number[]): { parent: ImportAccount; exact: string | null } => {
    const exact = chart.byNumber.get(num);
    const parent = exact ?? chart.byNumber.get(parentNumber(num));
    if (!parent) throw m.notFound(num);
    if (!allowed.includes(parent.categoryId ?? -1)) throw m.category(parent.number, allowed.join(', '));
    if (parent.isForeignCurrency || parent.isMaterial) throw m.type(parent.number);
    const kids = [...chart.byNumber.values()].filter((a) => a.parentId === parent.id);
    if (kids.some((k) => [...chart.byNumber.values()].some((g) => g.parentId === k.id))) throw m.subAccounts(parent.number);
    if (kids.some((k) => !k.isMaterial)) throw m.subAccounts(parent.number);
    return { parent, exact: exact ? null : num };
  };
  const supply = resolveParent(p.supplyAccountNumber.trim(), PRODUCT_CATEGORIES);
  const needsRelease = supply.parent.categoryId === 2 || supply.parent.categoryId === 3;
  const releaseNum = p.releaseAccountNumber?.trim() ?? '';
  if (needsRelease && !releaseNum) throw m.noRelease(p.name);
  const release = releaseNum ? resolveParent(releaseNum, PRODUCT_RELEASE_CATEGORIES) : null;

  // Reuse: same name under the same supply parent.
  const existing = await db.select({ id: s.products.id, name: s.products.name }).from(s.products).where(eq(s.products.name, p.name.trim()));
  if (existing.length) {
    const accs = await db.select().from(s.accounts).where(inArray(s.accounts.productId, existing.map((e) => e.id)));
    const hit = accs.find((a) => a.parentId === supply.parent.id);
    if (hit) return { productId: hit.productId!, created: false };
  }
  const [prod] = await db.insert(s.products).values({ name: p.name.trim().slice(0, 255), code: p.code.trim().slice(0, 50) || null, measure: p.measure.trim().slice(0, 50) || 'бр.', price: p.price || '0' }).returning({ id: s.products.id });
  const productId = prod!.id;
  const makeSub = async (r: { parent: ImportAccount; exact: string | null }, role: number) => {
    let number = r.exact;
    if (!number) {
      const suffixes = [...chart.byNumber.values()].filter((a) => a.parentId === r.parent.id).map((a) => Number(a.number.slice(r.parent.number.length + 1)) || 0);
      number = `${r.parent.number}/${Math.max(0, ...suffixes) + 1}`;
    }
    const [acc] = await db.insert(s.accounts).values({
      parentId: r.parent.id, number, description: p.name.trim().slice(0, 255), accountCategoryId: r.parent.categoryId, currencyId: r.parent.currencyId,
      productId, isEuro: chart.isEuro,
    }).returning();
    chart.byNumber.set(number, { id: acc!.id, number, description: acc!.description, categoryId: acc!.accountCategoryId, currencyId: acc!.currencyId, productId, isForeignCurrency: false, isMaterial: true, isLeaf: true, parentId: r.parent.id });
    r.parent.isLeaf = false;
    await db.insert(s.productAccounts).values({ productId, accountId: acc!.id, accountType: role });
  };
  await makeSub(supply, 1);
  if (release) await makeSub(release, 2);
  await rebuildAccountsTree(db);
  return { productId, created: true };
}
