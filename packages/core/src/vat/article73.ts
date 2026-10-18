import { D, dec, round, round2, ZERO, type Dec, type DecInput } from '../money.ts';
import { SALE_TERMS } from './constants.ts';
import type { VatAccounting } from './model.ts';
import { CATEGORY } from '../categories.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';

/** Coefficient under art. 73 ZDDS (spec 02b 8 and 21). */

/** Numerator terms: taxable supplies giving right to credit. */
export const ARTICLE73_NUMERATOR_TERMS = new Set([7, 8, 10, 11, 16]);

export interface Article73Sums {
  numerator: Dec;
  denominator: Dec;
}

/**
 * N / D: Sign=+1 legs of Sale entries by AccountingDate in [from, to] whose
 * counter account is not a VAT-sales account, each sum rounded to 2 places.
 */
export function article73Sums(list: VatAccounting[], from: string, to: string): Article73Sums {
  let n = ZERO;
  let d = ZERO;
  const all = new Set<number>(SALE_TERMS);
  for (const a of list) {
    if (a.isInitialBalance || a.transactionTypeId !== TRANSACTION_TYPE.Sale) continue;
    if (a.accountingDate < from || a.accountingDate > to) continue;
    for (const l of a.details) {
      if (l.sign !== 1 || l.refAccountCategoryId === CATEGORY.VatSales) continue;
      if (ARTICLE73_NUMERATOR_TERMS.has(l.vatTermId)) n = n.plus(dec(l.amount));
      if (all.has(l.vatTermId)) d = d.plus(dec(l.amount));
    }
  }
  return { numerator: round2(n), denominator: round2(d) };
}

/** Number of decimals of a decimal value as C# would print it. */
function decimals(v: Dec): number {
  return v.decimalPlaces();
}

export interface Article73Ratio {
  /** Exact quotient (N + dN) / (D + dD), 0 when the denominator is 0. */
  exact: Dec;
  /** Getter value: +0.005 bump when the quotient has more than 2 decimals, then round to 2. */
  ratio: Dec;
  /** Plain rounding used by the validation. */
  plain: Dec;
}

export function article73Ratio(numerator: DecInput, denominator: DecInput, dN: DecInput = 0, dD: DecInput = 0): Article73Ratio {
  const num = dec(numerator).plus(dec(dN));
  const den = dec(denominator).plus(dec(dD));
  if (den.isZero()) return { exact: ZERO, ratio: ZERO, plain: ZERO };
  // C# decimal division keeps 28 significant digits.
  const exact = num.div(den).toSignificantDigits(28, D.ROUND_HALF_EVEN);
  const ratio = decimals(exact) > 2 ? round(exact.plus('0.005'), 2) : round(exact, 2);
  return { exact, ratio, plain: round(exact, 2) };
}

/** NonCritical warning when the stored ratio differs from the plainly rounded recomputed ratio. */
export function article73Warning(stored: DecInput, recomputed: Article73Ratio, isNew = false) {
  if (dec(stored).equals(recomputed.plain)) return null;
  const key = isNew ? 'strNotUpdatedNewArticle73RatioWarning' : 'strNotUpdatedArticle73RatioWarning';
  return key as 'strNotUpdatedArticle73RatioWarning' | 'strNotUpdatedNewArticle73RatioWarning';
}

/** Default period: 1 Jan - 31 Dec of (active FY - 1). */
export function article73DefaultPeriod(activeYear: number) {
  return { from: `${activeYear - 1}-01-01`, to: `${activeYear - 1}-12-31` };
}

/** New-ratio period of the annual adjustment: the year after the old ratio's ToDate. */
export function annualAdjustmentPeriod(oldToDate: string) {
  const y = Number(oldToDate.slice(0, 4)) + 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** Base: debit amounts on category-16 accounts of Purchase entries with term 4 (partial credit) in the period. */
export function annualAdjustmentBase(list: VatAccounting[], from: string, to: string): Dec {
  let b = ZERO;
  for (const a of list) {
    if (a.isInitialBalance || a.transactionTypeId !== TRANSACTION_TYPE.Purchase) continue;
    if (a.accountingDate < from || a.accountingDate > to) continue;
    for (const l of a.details) if (l.sign === 1 && l.isVatPurchase && l.vatTermId === 4) b = b.plus(dec(l.amount));
  }
  return b;
}

/** Amount = base x newRatio - base x oldRatio (unrounded). */
export function annualAdjustmentAmount(base: DecInput, oldRatio: DecInput, newRatio: DecInput): Dec {
  return dec(base).times(dec(newRatio)).minus(dec(base).times(dec(oldRatio)));
}
