import { dec, round, round2, ZERO, type Dec, type DecInput } from './money.ts';
import { PRODUCT_CATEGORIES, PRODUCT_RELEASE_CATEGORIES } from './categories.ts';
import type { ValidationMessage } from './journal.ts';

/** Stock (СМЗ): weighted-average price, write-offs, product rules (spec 03a 4, 05 7.9). */

export const STOCK_MESSAGES = {
  strProductNameError: 'Не е въведено име на стока, материал или продукция!',
  strProductMeasureError: 'Не е въведена мярка на стока, материал или продукция!',
  strNoIncrementAccountsAttached: 'Не е прикачена нито една счетоводна сметка за доставка!',
  strNoDecrementAccountsAttached: 'Не е прикачена нито една счетоводна сметка за реализация!',
  strAccountDoesNotSupportProducts: 'Избраната сметка не може да бъде добавена, тъй като не поддържа работа с продукти/стоки/материали!',
  strAccountHasSubAccountError: 'Сметката не може да бъде изтрита, защото има поне една подсметка.',
  strAccountAlreadyInUseWithProductError: 'Сметката не може да бъде изтрита, защото участва в операции.',
  strDeleteProductWarning: 'Желаете ли да изтриете избраната стока/материал?',
  strProductInUseError: 'Стоката не може да бъде изтрита, защото се използва в извършени операции.',
  strApplyProductChangesWarning: 'Промените... ще бъдат запазени. Желаете ли да запазите промените?',
  strNoMaterialAccount: 'Сметката не може да бъде от тип материална, тъй като не поддържа работа с продукти/стоки/материали...',
  strAccountCurrencyNotSelected: 'Моля, изберете тип на валута на валутната сметка...',
  strInvalidAccountNumber: 'Невалиден номер на сметка!',
  strAccountAlreadyExists: 'Вече съществува сметка със зададения номер.',
  strAccountAlreadyExistsAndIsHidden: 'Вече съществува сметка със зададения номер. Сметката е маркирана като неизползвана.',
  strInvalidAccountDescription: 'Въведете описание на сметката.',
  strAccountCategoryDifferentFromParent: 'Избраната категория на подсметката се различава от категорията на главната сметка.',
  strCanNotAddSubAccount: 'Не е позволено създаването на подсметка на избраната сметка!',
  strCopyAccountsConfirm: 'Желаете ли да копирате избраните сметки?',
  strProductsWriteOff: 'Изписване на стоки по отчетна стойност',
} as const;

export type StockMessageKey = keyof typeof STOCK_MESSAGES;
export const stockMessage = (key: StockMessageKey, severity: ValidationMessage['severity'] = 'critical'): ValidationMessage => ({ key, text: STOCK_MESSAGES[key], severity });

/** ProductAccounts.AccountType: 0 Increment, 1 Decrement, 2 None. */
export const PRODUCT_ACCOUNT_TYPE = { Increment: 0, Decrement: 1, None: 2 } as const;

export const isProductCategory = (c: number | null | undefined) => c != null && (PRODUCT_CATEGORIES as readonly number[]).includes(c);
export const isProductReleaseCategory = (c: number | null | undefined) => c != null && (PRODUCT_RELEASE_CATEGORIES as readonly number[]).includes(c);

/** Account type of a product account by its category (chart editor ApplyChanges: Decrement for release categories, else Increment). */
export function productAccountTypeFor(categoryId: number | null | undefined): 0 | 1 {
  return isProductReleaseCategory(categoryId) ? PRODUCT_ACCOUNT_TYPE.Decrement : PRODUCT_ACCOUNT_TYPE.Increment;
}

/** Stock-type categories (debit = receipt) and issue-type categories (credit = issue), spec 05 7.9. */
export const STOCK_REPORT_CATEGORIES = [1, 2, 3, 52] as const;
export const ISSUE_REPORT_CATEGORIES = [23, 24, 25, 31, 53] as const;

/** Default units (GetMeasures, 03a 4.2). */
export const DEFAULT_MEASURES = ['бр.', 'кг.', 'пакет', 'каса', 'опаковка', 'литър', 'стек', 'кашон'] as const;

/** Defaults plus distinct existing measures (lower-cased, trimmed, sorted) not already present. */
export function getMeasures(existing: (string | null | undefined)[]): string[] {
  const out: string[] = [...DEFAULT_MEASURES];
  const extra = new Set<string>();
  for (const m of existing) {
    const v = (m ?? '').trim().toLowerCase();
    if (v && !out.includes(v)) extra.add(v);
  }
  return [...out, ...[...extra].sort((a, b) => a.localeCompare(b, 'bg'))];
}

export interface ProductDraft {
  name: string;
  measure: string;
  incrementAccounts: { categoryId: number | null }[];
  decrementAccounts: { categoryId: number | null }[];
}

/**
 * Product validation (03a 4.3). strNoDecrementAccountsAttached "may be
 * suppressed": it is only raised when `requireDecrement` is set (materials used
 * in production have no sales account).
 */
export function validateProduct(p: ProductDraft, opts: { requireDecrement?: boolean } = {}): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  if (!p.name.trim()) out.push(stockMessage('strProductNameError'));
  if (!p.measure.trim()) out.push(stockMessage('strProductMeasureError'));
  if (p.incrementAccounts.length === 0) out.push(stockMessage('strNoIncrementAccountsAttached'));
  if (opts.requireDecrement && p.decrementAccounts.length === 0) out.push(stockMessage('strNoDecrementAccountsAttached'));
  if (p.incrementAccounts.some((a) => !isProductCategory(a.categoryId)) || p.decrementAccounts.some((a) => !isProductReleaseCategory(a.categoryId))) {
    out.push(stockMessage('strAccountDoesNotSupportProducts'));
  }
  return out;
}

export interface StockMovement {
  /** Sum of Amount of the Sign = +1 lines (receipts). */
  amountIn: DecInput;
  qtyIn: DecInput;
  /** Sum of RefAmount of the Sign = -1 lines (issues). */
  amountOut: DecInput;
  qtyOut: DecInput;
}

/**
 * GetAveragePrice (03a 4.5): amounts rounded to cents away from zero, the
 * quotient rounded to `decimals` (QuantityFormat) and negated when the net
 * amount or quantity is negative (bug-compatible sign rule).
 */
export function averagePrice(m: StockMovement, decimals = 3): Dec {
  const amount = round2(m.amountIn).minus(round2(m.amountOut));
  const qty = dec(m.qtyIn).minus(dec(m.qtyOut));
  let avg = qty.isZero() ? ZERO : round(amount.div(qty), decimals);
  if (amount.isNegative() || qty.isNegative()) avg = avg.negated();
  return avg;
}

/** Cost of a write-off: average price x quantity, rounded to cents. */
export function writeOffCost(avgPrice: DecInput, quantity: DecInput): Dec {
  return round2(dec(avgPrice).times(dec(quantity)));
}

/**
 * Weighted average of all receipts (spAveragePriceMaterialReport, 05 7.9):
 * (opening value + debit turnover) / (opening quantity + debit quantity), 0 when that quantity is 0.
 */
export function weightedAveragePrice(openingValue: DecInput, openingQty: DecInput, debitValue: DecInput, debitQty: DecInput, decimals = 6): Dec {
  const q = dec(openingQty).plus(dec(debitQty));
  return q.isZero() ? ZERO : round(dec(openingValue).plus(dec(debitValue)).div(q), decimals);
}

/** spWriteOutMaterialReport: AveragePrice = (opening + booked value)/(opening + booked qty); WriteOff = AveragePrice x ChargedQty. */
export function writeOutValue(r: { openingValue: DecInput; openingQty: DecInput; bookedValue: DecInput; bookedQty: DecInput; chargedQty: DecInput }, decimals = 6) {
  const averagePrice = weightedAveragePrice(r.openingValue, r.openingQty, r.bookedValue, r.bookedQty, decimals);
  return { averagePrice, writeOff: writeOffCost(averagePrice, r.chargedQty) };
}

/** Line value of a material row: round2(quantity x price). */
export function materialAmount(quantity: DecInput, price: DecInput): Dec {
  return round2(dec(quantity).times(dec(price)));
}
