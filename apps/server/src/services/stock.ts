import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  averagePrice, dec, getMeasures, isMonthLocked, ISSUE_REPORT_CATEGORIES, JOURNAL_MESSAGES, PRODUCT_ACCOUNT_TYPE, round2,
  STOCK_MESSAGES, STOCK_REPORT_CATEGORIES, stockMessage, validateProduct, weightedAveragePrice, writeOffCost, writeOutValue,
  type DecInput, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { accountDeleteBlockers, addAccount, canAddSubAccount, deleteAccount, isAccountUsed } from './chart.ts';
import { getConfig } from './config.ts';
import { saveEntry } from './journal.ts';
import { compareAccountNumbers } from './reports.ts';

/** Stock (СМЗ) services: products with their accounts, average price, write-offs, material reports (03a 4, 05 7.9). */

const isEuroYear = (year: number) => year >= 2026;

export interface ProductAccountRef { parentId: number | null; parentNumber: string | null; accountId: number; number: string; description: string; accountType: number }
export interface ProductView {
  id: number; name: string; code: string | null; measure: string; price: string;
  incrementAccounts: ProductAccountRef[]; decrementAccounts: ProductAccountRef[];
}

async function productAccounts(db: DbOrTx, productIds: number[], isEuro: boolean) {
  if (!productIds.length) return [];
  return queryRows<{ product_id: number; account_id: number; account_type: number; number: string; description: string; parent_id: number | null; parent_number: string | null }>(db, sql`
    SELECT pa.product_id, pa.account_id, pa.account_type, a.number, a.description, a.parent_id, p.number AS parent_number
    FROM product_accounts pa
    JOIN accounts a ON a.id = pa.account_id
    LEFT JOIN accounts p ON p.id = a.parent_id
    WHERE a.is_euro = ${isEuro} AND pa.product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY a.number`);
}

/** Non-deleted products having at least one account in the active chart (GetNotDeletedProducts). */
export async function listProducts(db: DbOrTx, year: number, q?: string): Promise<ProductView[]> {
  const isEuro = isEuroYear(year);
  const like = q?.trim() ? `%${q.trim()}%` : null;
  const rows = await queryRows<{ id: number; name: string; code: string | null; measure: string; price: string }>(db, sql`
    SELECT p.id, p.name, p.code, p.measure, p.price FROM products p
    WHERE NOT p.is_deleted
      AND EXISTS (SELECT 1 FROM product_accounts pa JOIN accounts a ON a.id = pa.account_id WHERE pa.product_id = p.id AND a.is_euro = ${isEuro})
      ${like ? sql`AND (p.name ILIKE ${like} OR p.code ILIKE ${like})` : sql``}
    ORDER BY p.name, p.id`);
  const links = await productAccounts(db, rows.map((r) => r.id), isEuro);
  return rows.map((r) => {
    const mine = links.filter((l) => l.product_id === r.id).map((l): ProductAccountRef => ({
      parentId: l.parent_id, parentNumber: l.parent_number, accountId: l.account_id, number: l.number, description: l.description, accountType: l.account_type,
    }));
    return {
      ...r,
      incrementAccounts: mine.filter((m) => m.accountType === PRODUCT_ACCOUNT_TYPE.Increment),
      decrementAccounts: mine.filter((m) => m.accountType === PRODUCT_ACCOUNT_TYPE.Decrement),
    };
  });
}

export async function loadProduct(db: DbOrTx, year: number, id: number): Promise<ProductView> {
  const [p] = await db.select().from(s.products).where(eq(s.products.id, id));
  if (!p || p.isDeleted) throw notFound('Стоката');
  const links = await productAccounts(db, [id], isEuroYear(year));
  const refs = links.map((l): ProductAccountRef => ({ parentId: l.parent_id, parentNumber: l.parent_number, accountId: l.account_id, number: l.number, description: l.description, accountType: l.account_type }));
  return {
    id: p.id, name: p.name, code: p.code, measure: p.measure, price: p.price,
    incrementAccounts: refs.filter((m) => m.accountType === PRODUCT_ACCOUNT_TYPE.Increment),
    decrementAccounts: refs.filter((m) => m.accountType === PRODUCT_ACCOUNT_TYPE.Decrement),
  };
}

export async function productMeasures(db: DbOrTx) {
  const rows = await db.select({ measure: s.products.measure }).from(s.products).where(eq(s.products.isDeleted, false));
  return getMeasures(rows.map((r) => r.measure));
}

export interface ProductInput {
  name: string;
  code?: string | null;
  measure: string;
  price?: string;
  /** Parent accounts "за доставка" (increment) and "за реализация" (decrement). */
  incrementAccountIds: number[];
  decrementAccountIds: number[];
}

/**
 * Save a product (03a 4.3): for every chosen parent account a leaf
 * sub-account named after the product is created (AddProductSubAccount, 01a
 * 4.5) together with its ProductAccounts row; parents removed from a list
 * lose that sub-account (with the account delete checks).
 */
export async function saveProduct(db: DbOrTx, year: number, input: ProductInput, id?: number) {
  const isEuro = isEuroYear(year);
  const parentIds = [...new Set([...input.incrementAccountIds, ...input.decrementAccountIds])];
  const parents = parentIds.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, parentIds)) : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  const pick = (ids: number[]) => ids.map((i) => byId.get(i)).filter((a) => a !== undefined);
  const inc = pick(input.incrementAccountIds);
  const decr = pick(input.decrementAccountIds);
  const messages: ValidationMessage[] = validateProduct({
    name: input.name, measure: input.measure,
    incrementAccounts: inc.map((a) => ({ categoryId: a.accountCategoryId })),
    decrementAccounts: decr.map((a) => ({ categoryId: a.accountCategoryId })),
  });
  if (inc.length !== input.incrementAccountIds.length || decr.length !== input.decrementAccountIds.length
    || [...inc, ...decr].some((a) => a.isEuro !== isEuro || a.number === '0')) {
    if (!messages.some((m) => m.key === 'strAccountDoesNotSupportProducts')) messages.push(stockMessage('strAccountDoesNotSupportProducts'));
  }
  for (const a of [...inc, ...decr]) {
    if (!(await canAddSubAccount(db, a))) messages.push({ key: 'strCanNotAddSubAccount', text: `${STOCK_MESSAGES.strCanNotAddSubAccount} (${a.number})`, severity: 'critical' });
  }
  if (messages.length) throw new ApiError(422, 'Стоката не може да бъде записана поради следните грешки:', messages);

  const name = input.name.trim();
  const values = { name, code: input.code?.trim() || null, measure: input.measure.trim(), ...(input.price !== undefined ? { price: dec(input.price).toFixed(6) } : {}) };
  let productId: number;
  if (id) {
    const [p] = await db.select().from(s.products).where(eq(s.products.id, id));
    if (!p || p.isDeleted) throw notFound('Стоката');
    await db.update(s.products).set(values).where(eq(s.products.id, id));
    productId = id;
  } else {
    const [p] = await db.insert(s.products).values(values).returning({ id: s.products.id });
    productId = p!.id;
  }

  const current = await productAccounts(db, [productId], isEuro);
  const wanted: { parentId: number; type: 0 | 1 }[] = [
    ...inc.map((a) => ({ parentId: a.id, type: PRODUCT_ACCOUNT_TYPE.Increment })),
    ...decr.map((a) => ({ parentId: a.id, type: PRODUCT_ACCOUNT_TYPE.Decrement })),
  ];
  // Remove links whose parent left the list.
  for (const c of current) {
    if (wanted.some((w) => w.parentId === c.parent_id && w.type === c.account_type)) continue;
    const kids = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.parentId, c.account_id));
    if (kids.length) throw badRequest(`${STOCK_MESSAGES.strAccountHasSubAccountError} (${c.number})`);
    if (await isAccountUsed(db, c.account_id)) throw badRequest(`${STOCK_MESSAGES.strAccountAlreadyInUseWithProductError} (${c.number})`);
    const blockers = await accountDeleteBlockers(db, c.account_id);
    if (blockers.length) throw badRequest(`${blockers[0]} (${c.number})`);
    await deleteAccount(db, c.account_id);
  }
  // Add sub-accounts for new parents.
  for (const w of wanted) {
    if (current.some((c) => c.parent_id === w.parentId && c.account_type === w.type)) continue;
    const parent = byId.get(w.parentId)!;
    const row = await addAccount(db, {
      parentId: parent.id, description: name, accountCategoryId: parent.accountCategoryId, currencyId: parent.currencyId, productId,
      isActive: parent.isActive,
    });
    await db.insert(s.productAccounts).values({ productId, accountId: row.id, accountType: w.type });
  }
  // Every product account follows the product name.
  await db.execute(sql`UPDATE accounts SET description = ${name} WHERE product_id = ${productId} AND description <> ${name}`);
  return loadProduct(db, year, productId);
}

/** Delete (03a 4.4): blocked when any journal line references the product; otherwise soft delete and remove its accounts. */
export async function deleteProduct(db: DbOrTx, id: number) {
  const [p] = await db.select().from(s.products).where(eq(s.products.id, id));
  if (!p || p.isDeleted) throw notFound('Стоката');
  const used = await db.select({ id: s.accountingDetails.id }).from(s.accountingDetails).where(eq(s.accountingDetails.productId, id)).limit(1);
  if (used.length) throw badRequest(STOCK_MESSAGES.strProductInUseError);
  const accs = await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts).where(eq(s.accounts.productId, id));
  for (const a of accs) {
    const blockers = await accountDeleteBlockers(db, a.id);
    if (blockers.length) throw badRequest(`${blockers[0]} (${a.number})`);
  }
  await db.update(s.products).set({ isDeleted: true }).where(eq(s.products.id, id));
  for (const a of accs) await deleteAccount(db, a.id);
}

/** Products offered in the delivery / sale material dialog with their increment / decrement accounts. */
export async function stockProducts(db: DbOrTx, year: number, mode: 'delivery' | 'sale', q?: string) {
  const type = mode === 'delivery' ? PRODUCT_ACCOUNT_TYPE.Increment : PRODUCT_ACCOUNT_TYPE.Decrement;
  const list = await listProducts(db, year, q);
  return list
    .map((p) => ({
      id: p.id, name: p.name, code: p.code, measure: p.measure, price: p.price,
      accounts: (type === 0 ? p.incrementAccounts : p.decrementAccounts).map((a) => ({ accountId: a.accountId, number: a.number, description: a.description, accountType: a.accountType })),
    }))
    .filter((p) => p.accounts.length > 0);
}

async function quantityDecimals(db: DbOrTx) {
  const v = Number(await getConfig(db, 'QuantityFormat'));
  return Number.isInteger(v) && v >= 0 && v <= 9 ? v : 3;
}

/** Stock account of a product: its first increment account in the active chart. */
async function stockAccountOf(db: DbOrTx, productId: number, isEuro: boolean) {
  const links = await productAccounts(db, [productId], isEuro);
  return links.find((l) => l.account_type === PRODUCT_ACCOUNT_TYPE.Increment) ?? null;
}

/** GetAveragePrice(account, year, toDate) (03a 4.5). */
export async function accountAveragePrice(db: DbOrTx, accountId: number, financialYearId: number, toDate: string) {
  const [m] = await queryRows<{ amount_in: string; qty_in: string; amount_out: string; qty_out: string }>(db, sql`
    SELECT coalesce(sum(CASE WHEN d.sign = 1 THEN d.amount END), 0) AS amount_in,
           coalesce(sum(CASE WHEN d.sign = 1 THEN d.quantity END), 0) AS qty_in,
           coalesce(sum(CASE WHEN d.sign = -1 THEN d.ref_amount END), 0) AS amount_out,
           coalesce(sum(CASE WHEN d.sign = -1 THEN d.quantity END), 0) AS qty_out
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
    WHERE d.account_id = ${accountId} AND a.financial_year_id = ${financialYearId} AND a.accounting_date <= ${toDate}`);
  return { ...m!, price: averagePrice({ amountIn: m!.amount_in, qtyIn: m!.qty_in, amountOut: m!.amount_out, qtyOut: m!.qty_out }, await quantityDecimals(db)) };
}

export async function productAveragePrice(db: DbOrTx, year: ActiveYear, productId: number, date: string) {
  const acc = await stockAccountOf(db, productId, isEuroYear(year.year));
  if (!acc) return { productId, accountId: null, price: '0' };
  const r = await accountAveragePrice(db, acc.account_id, year.id, date);
  return { productId, accountId: acc.account_id, price: r.price.toString(), quantity: dec(r.qty_in).minus(dec(r.qty_out)).toString(), amount: round2(r.amount_in).minus(round2(r.amount_out)).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Write-offs (Изписване на СМЗ, WriteOffsViewModel)

/** Account-number filter in SQL with the 05 2.5 rule (equal, sub-account, or prefix when shorter than 3). */
export function accountNumberSql(col: SQL, p: string | undefined | null): SQL {
  const v = p?.trim();
  if (!v) return sql`TRUE`;
  return sql`(${col} = ${v} OR ${col} LIKE ${v + '/%'} OR (length(${v}) < 3 AND ${col} LIKE ${v + '%'}))`;
}

export interface WriteOffFilter { from: string; to: string; account?: string; date: string }

export interface WriteOffRow {
  productId: number; productName: string; measure: string; decrementAccountId: number; decrementAccount: string;
  stockAccountId: number | null; stockAccount: string | null; quantity: string; averagePrice: string; deliveryAmount: string; saleAmount: string;
}

export async function writeOffCandidates(db: DbOrTx, year: ActiveYear, f: WriteOffFilter): Promise<WriteOffRow[]> {
  const isEuro = isEuroYear(year.year);
  const rows = await queryRows<{ product_id: number; name: string; measure: string; account_id: number; number: string; sold: string; returned: string; sale_amount: string }>(db, sql`
    SELECT p.id AS product_id, p.name, p.measure, acc.id AS account_id, acc.number,
      coalesce(sum(CASE WHEN d.sign = -1 THEN d.quantity END), 0) AS sold,
      coalesce(sum(CASE WHEN d.sign = 1 THEN d.quantity END), 0) AS returned,
      coalesce(sum(CASE WHEN d.sign = -1 THEN d.ref_amount END), 0) AS sale_amount
    FROM product_accounts pa
    JOIN accounts acc ON acc.id = pa.account_id
    JOIN products p ON p.id = pa.product_id
    JOIN accounting_details d ON d.account_id = acc.id
    JOIN accountings a ON a.id = d.accounting_id
    WHERE pa.account_type = ${PRODUCT_ACCOUNT_TYPE.Decrement} AND acc.is_euro = ${isEuro}
      AND a.financial_year_id = ${year.id} AND NOT a.is_initial_balance
      AND a.accounting_date >= ${f.from} AND a.accounting_date <= ${f.to}
      AND ${accountNumberSql(sql`acc.number`, f.account)}
    GROUP BY p.id, p.name, p.measure, acc.id, acc.number
    ORDER BY p.name, acc.number`);
  const out: WriteOffRow[] = [];
  for (const r of rows) {
    const qty = dec(r.sold).minus(dec(r.returned));
    if (qty.lte(0)) continue;
    const stock = await stockAccountOf(db, r.product_id, isEuro);
    const avg = stock ? (await accountAveragePrice(db, stock.account_id, year.id, f.date)).price : dec(0);
    out.push({
      productId: r.product_id, productName: r.name, measure: r.measure, decrementAccountId: r.account_id, decrementAccount: r.number,
      stockAccountId: stock?.account_id ?? null, stockAccount: stock?.number ?? null, quantity: qty.toString(), averagePrice: avg.toString(),
      deliveryAmount: writeOffCost(avg, qty).toFixed(2), saleAmount: round2(r.sale_amount).toFixed(2),
    });
  }
  return out;
}

/**
 * Запис of the write-off screen: one memorial-order entry per product
 * Dr decrement account / Cr stock account for avg x quantity (both legs
 * carry the quantity, so the sold quantity nets to zero on the sales account).
 */
export async function createWriteOffs(db: DbOrTx, year: ActiveYear, userId: number, f: WriteOffFilter, productIds?: number[]) {
  if (Number(f.date.slice(0, 4)) !== year.year) throw badRequest(JOURNAL_MESSAGES.strWrongAccountingDate);
  if (year.isLocked || isMonthLocked(year.lockedMonths, Number(f.date.slice(5, 7)))) throw badRequest(JOURNAL_MESSAGES.strLockedMonthOperation);
  const rows = (await writeOffCandidates(db, year, f)).filter((r) => !productIds || productIds.includes(r.productId));
  if (!rows.length) throw badRequest('Няма стоки за изписване за избрания период.');
  const missing = rows.find((r) => !r.stockAccountId);
  if (missing) throw badRequest(`${STOCK_MESSAGES.strNoIncrementAccountsAttached} (${missing.productName})`);
  const created: { id: number; number: string; productId: number }[] = [];
  for (const r of rows) {
    const line = (accountId: number) => ({ accountId, amount: r.deliveryAmount, quantity: r.quantity, price: r.averagePrice });
    const res = await saveEntry(db, {
      accountingDate: f.date, documentDate: f.date, documentTypeId: 10, documentNumber: '',
      term: STOCK_MESSAGES.strProductsWriteOff, reference: r.productName, source: 'write-off',
      debits: [line(r.decrementAccountId)], credits: [line(r.stockAccountId!)],
    }, { year, userId });
    created.push({ id: res.id, number: res.number, productId: r.productId });
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Material reports (05 7.9)

export interface MaterialFilter {
  from: string; to: string; account?: string; productName?: string; nameExact?: boolean; productCode?: string;
  companyName?: string; documentTypeId?: number; documentNumber?: string; fromNumber?: string; toNumber?: string;
}

const categorySql = (cats: readonly number[]) => sql`coalesce(acc.account_category_id, par.account_category_id) IN (${sql.join(cats.map((c) => sql`${c}`), sql`, `)})`;

function productFilterSql(f: MaterialFilter): SQL[] {
  const conds: SQL[] = [accountNumberSql(sql`acc.number`, f.account)];
  if (f.productName?.trim()) conds.push(f.nameExact ? sql`lower(p.name) = lower(${f.productName.trim()})` : sql`p.name ILIKE ${'%' + f.productName.trim() + '%'}`);
  if (f.productCode?.trim()) conds.push(sql`p.code ILIKE ${'%' + f.productCode.trim() + '%'}`);
  return conds;
}

const partnerSql = sql`(SELECT co.name FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id ORDER BY x.position LIMIT 1)`;

function lineFilterSql(f: MaterialFilter): SQL[] {
  const conds = productFilterSql(f);
  if (f.companyName?.trim()) conds.push(sql`${partnerSql} ILIKE ${'%' + f.companyName.trim() + '%'}`);
  if (f.documentTypeId) conds.push(sql`doc.document_type_id = ${f.documentTypeId}`);
  if (f.documentNumber?.trim()) conds.push(sql`doc.number ILIKE ${'%' + f.documentNumber.trim() + '%'}`);
  return conds;
}

const MATERIAL_FROM = sql`
  FROM accounting_details d
  JOIN accountings a ON a.id = d.accounting_id
  JOIN accounts acc ON acc.id = d.account_id
  LEFT JOIN accounts par ON par.id = acc.parent_id
  JOIN products p ON p.id = d.product_id
  LEFT JOIN documents doc ON doc.id = a.document_id
  LEFT JOIN document_types dt ON dt.id = doc.document_type_id
  LEFT JOIN terms t ON t.id = a.term_id`;

/** Доставки / Продажби (spDeliverySaleMaterialReport). */
export async function deliverySaleReport(db: DbOrTx, year: number, f: MaterialFilter, isPurchase: boolean) {
  const conds = [
    sql`acc.is_euro = ${isEuroYear(year)}`, sql`NOT a.is_initial_balance`, sql`a.accounting_date >= ${f.from}`, sql`a.accounting_date <= ${f.to}`,
    isPurchase ? sql`d.sign = 1` : sql`d.sign = -1`, categorySql(isPurchase ? STOCK_REPORT_CATEGORIES : ISSUE_REPORT_CATEGORIES), ...lineFilterSql(f),
  ];
  if (f.fromNumber?.trim()) conds.push(sql`(a.number ~ '^[0-9]+$' AND a.number::bigint >= ${Number(f.fromNumber)})`);
  if (f.toNumber?.trim()) conds.push(sql`(a.number ~ '^[0-9]+$' AND a.number::bigint <= ${Number(f.toNumber)})`);
  return queryRows<Record<string, string | null>>(db, sql`
    SELECT a.number AS accounting_number, a.accounting_date, acc.number AS account_number, acc.description AS account_description,
      acc.english_description, p.code AS product_code, p.name AS product_name, p.measure AS product_measure,
      d.quantity, d.price, ${partnerSql} AS company_name, doc.number AS document_number, doc.date AS document_date, dt.name AS document_type,
      ${isPurchase ? sql`d.amount` : sql`d.ref_amount`} AS amount
    ${MATERIAL_FROM}
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.accounting_date, a.number, d.position`);
}

/** Движение на стоки (spGoodsMovementMaterialReport): receipts on stock accounts, issues on issue accounts (negative quantity). */
export async function goodsMovementReport(db: DbOrTx, year: number, f: MaterialFilter) {
  const conds = [
    sql`acc.is_euro = ${isEuroYear(year)}`, sql`NOT a.is_initial_balance`, sql`a.accounting_date >= ${f.from}`, sql`a.accounting_date <= ${f.to}`,
    sql`((d.sign = 1 AND ${categorySql(STOCK_REPORT_CATEGORIES)}) OR (d.sign = -1 AND ${categorySql(ISSUE_REPORT_CATEGORIES)}))`, ...lineFilterSql(f),
  ];
  return queryRows<Record<string, string | null>>(db, sql`
    SELECT p.name AS product_name, acc.english_description, p.code AS product_code, p.measure AS product_measure, acc.number AS account_number,
      d.price, sum(d.quantity * d.sign) AS quantity, sum((d.amount + d.ref_amount) * d.sign) AS amount,
      dt.name AS document_type, doc.number AS document_number, doc.date AS document_date, ${partnerSql} AS company_name, t.description AS term,
      min(a.accounting_date) AS accounting_date
    ${MATERIAL_FROM}
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY p.name, acc.english_description, p.code, p.measure, acc.number, d.price, dt.name, doc.number, doc.date, a.id, t.description
    ORDER BY min(a.accounting_date), p.name`);
}

interface Balances {
  account_id: number; account_number: string; account_description: string; english_description: string | null; product_name: string; product_code: string | null; measure: string;
  opening_value: string; opening_qty: string; debit_value: string; debit_qty: string; credit_value: string; credit_qty: string;
}

/** Opening / turnover per stock account and product of the active chart. */
async function stockBalances(db: DbOrTx, fy: ActiveYear, f: MaterialFilter, openingSql: SQL, includeCorrespondence: boolean) {
  const conds = [sql`acc.is_euro = ${isEuroYear(fy.year)}`, sql`a.financial_year_id = ${fy.id}`, sql`a.accounting_date <= ${f.to}`, categorySql(STOCK_REPORT_CATEGORIES), ...productFilterSql(f)];
  if (!includeCorrespondence) conds.push(sql`NOT (a.is_initial_balance AND a.is_initial_correspondence)`);
  const turnover = sql`(NOT (${openingSql}) AND a.accounting_date >= ${f.from})`;
  const rows = await queryRows<Balances>(db, sql`
    SELECT acc.id AS account_id, acc.number AS account_number, acc.description AS account_description, acc.english_description,
      p.name AS product_name, p.code AS product_code, p.measure,
      coalesce(sum(CASE WHEN ${openingSql} THEN (d.amount + d.ref_amount) * d.sign END), 0) AS opening_value,
      coalesce(sum(CASE WHEN ${openingSql} THEN d.quantity * d.sign END), 0) AS opening_qty,
      coalesce(sum(CASE WHEN ${turnover} AND d.sign = 1 THEN d.amount END), 0) AS debit_value,
      coalesce(sum(CASE WHEN ${turnover} AND d.sign = 1 THEN d.quantity END), 0) AS debit_qty,
      coalesce(sum(CASE WHEN ${turnover} AND d.sign = -1 THEN d.ref_amount END), 0) AS credit_value,
      coalesce(sum(CASE WHEN ${turnover} AND d.sign = -1 THEN d.quantity END), 0) AS credit_qty
    ${MATERIAL_FROM}
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY acc.id, acc.number, acc.description, acc.english_description, p.name, p.code, p.measure`);
  return rows.sort((x, y) => compareAccountNumbers(x.account_number, y.account_number) || x.product_name.localeCompare(y.product_name, 'bg'));
}

const money = (v: DecInput) => round2(v).toFixed(2);
const qty = (v: DecInput) => dec(v).toString();

/** Средно претеглена стойност и изписване (spAveragePriceMaterialReport). */
export async function averagePriceReport(db: DbOrTx, fy: ActiveYear, f: MaterialFilter) {
  const rows = await stockBalances(db, fy, f, sql`(a.is_initial_balance OR a.accounting_date < ${f.from})`, false);
  return rows.map((r) => {
    const avg = weightedAveragePrice(r.opening_value, r.opening_qty, r.debit_value, r.debit_qty);
    const finalValue = dec(r.opening_value).plus(r.debit_value).minus(r.credit_value);
    const finalQty = dec(r.opening_qty).plus(r.debit_qty).minus(r.credit_qty);
    return {
      accountId: r.account_id, accountNumber: r.account_number, accountDescription: r.account_description, englishDescription: r.english_description,
      productName: r.product_name, code: r.product_code, measure: r.measure,
      materialInitialBalance: qty(r.opening_qty), initialBalance: money(r.opening_value),
      debitTurnover: money(r.debit_value), creditTurnover: money(r.credit_value),
      materialDebitTurnover: qty(r.debit_qty), materialCreditTurnover: qty(r.credit_qty),
      averagePrice: avg.toDecimalPlaces(6).toString(), writeOutValue: writeOffCost(avg, r.credit_qty).toFixed(2),
      finalBalance: money(finalValue), materialFinalBalance: qty(finalQty),
    };
  });
}

/** Стойност за изписване при продажба (spWriteOutMaterialReport): stock accounts of type 0. */
export async function writeOutReport(db: DbOrTx, fy: ActiveYear, f: MaterialFilter) {
  const rows = await stockBalances(db, fy, { ...f }, sql`(a.is_initial_balance OR a.is_initial_correspondence OR a.accounting_date < ${f.from})`, true);
  const typed = await queryRows<{ account_id: number }>(db, sql`SELECT account_id FROM product_accounts WHERE account_type = ${PRODUCT_ACCOUNT_TYPE.Increment}`);
  const stockIds = new Set(typed.map((t) => t.account_id));
  return rows.filter((r) => stockIds.has(r.account_id)).map((r) => {
    const w = writeOutValue({ openingValue: r.opening_value, openingQty: r.opening_qty, bookedValue: r.debit_value, bookedQty: r.debit_qty, chargedQty: r.credit_qty });
    return {
      accountNumber: r.account_number, productName: r.product_name, englishDescription: r.english_description, productCode: r.product_code, measure: r.measure,
      initialBalance: money(r.opening_value), initialBalanceQtty: qty(r.opening_qty), bookedSum: money(r.debit_value), bookedQtty: qty(r.debit_qty),
      averagePrice: w.averagePrice.toString(), chargedQtty: qty(r.credit_qty), writeOff: w.writeOff.toFixed(2),
    };
  });
}

/**
 * Инвентаризационен опис (spInventoryListReport) at toDate: opening = the
 * initial balances of the year, then every posting up to toDate. With
 * `withoutZero` only rows with a non-zero quantity or value are returned
 * (the sensible reading of "Без нулеви салда"; Delta's flag is inverted).
 */
export async function inventoryListReport(db: DbOrTx, fy: ActiveYear, f: { toDate: string; account?: string; withoutZero?: boolean }) {
  const rows = await stockBalances(db, fy, { from: `${fy.year}-01-01`, to: f.toDate, account: f.account }, sql`a.is_initial_balance`, false);
  return rows.map((r, i) => {
    const finalValue = dec(r.opening_value).plus(r.debit_value).minus(r.credit_value);
    const finalQty = dec(r.opening_qty).plus(r.debit_qty).minus(r.credit_qty);
    return {
      no: i + 1, accountId: r.account_id, accountNumber: r.account_number, accountDescription: r.account_description, englishDescription: r.english_description,
      productName: r.product_name, productMeasure: r.measure, finalBalance: money(finalValue), materialFinalBalance: qty(finalQty),
      averagePrice: finalQty.isZero() ? '0' : finalValue.div(finalQty).toDecimalPlaces(6).toString(),
    };
  }).filter((r) => !f.withoutZero || !dec(r.finalBalance).isZero() || !dec(r.materialFinalBalance).isZero())
    .map((r, i) => ({ ...r, no: i + 1 }));
}

export async function productOptions(db: DbOrTx, year: number) {
  const rows = await listProducts(db, year);
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code })).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
}
