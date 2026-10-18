import { describe, expect, it } from 'vitest';
import {
  averagePrice, getMeasures, materialAmount, productAccountTypeFor, STOCK_MESSAGES, validateProduct, weightedAveragePrice,
  writeOffCost, writeOutValue,
} from '../src/index.ts';

describe('stock: weighted average price (03a 4.5)', () => {
  it('worked example: in 10 for 100.00, out 4 for 40.00 -> 10.00', () => {
    expect(averagePrice({ amountIn: '100', qtyIn: '10', amountOut: '40', qtyOut: '4' }).toFixed(3)).toBe('10.000');
  });
  it('worked example: in 5 for 50, out 6 for 60 -> amount -10, qty -1, negated quotient -10', () => {
    expect(averagePrice({ amountIn: '50', qtyIn: '5', amountOut: '60', qtyOut: '6' }).toString()).toBe('-10');
  });
  it('is 0 when the net quantity is 0', () => {
    expect(averagePrice({ amountIn: '50', qtyIn: '5', amountOut: '45', qtyOut: '5' }).toString()).toBe('0');
  });
  it('rounds amounts to cents and the quotient to QuantityFormat decimals away from zero', () => {
    // 100.005 -> 100.01 ; 100.01 / 3 = 33.33666.. -> 33.337 (3 decimals), 33.34 (2 decimals)
    expect(averagePrice({ amountIn: '100.005', qtyIn: '3', amountOut: '0', qtyOut: '0' }).toFixed(3)).toBe('33.337');
    expect(averagePrice({ amountIn: '100.005', qtyIn: '3', amountOut: '0', qtyOut: '0' }, 2).toFixed(2)).toBe('33.34');
  });
  it('negative amount with positive quantity flips to positive (bug-compatible sign rule)', () => {
    expect(averagePrice({ amountIn: '10', qtyIn: '5', amountOut: '20', qtyOut: '3' }).toString()).toBe('5');
  });
  it('write-off cost = round2(avg x qty)', () => {
    expect(writeOffCost('10.333', '3').toFixed(2)).toBe('31.00');
    expect(writeOffCost('1.005', '1').toFixed(2)).toBe('1.01');
    expect(materialAmount('3', '1.01').toFixed(2)).toBe('3.03');
  });
});

describe('stock: report formulas (05 7.9)', () => {
  it('average price report = (opening value + debit turnover) / (opening qty + debit qty)', () => {
    expect(weightedAveragePrice('50', '5', '150', '10').toFixed(2)).toBe('13.33');
    expect(weightedAveragePrice('0', '0', '0', '0').toString()).toBe('0');
  });
  it('write-out: avg of opening + booked, write-off = avg x charged quantity', () => {
    const r = writeOutValue({ openingValue: '100', openingQty: '10', bookedValue: '220', bookedQty: '10', chargedQty: '4' });
    expect(r.averagePrice.toFixed(2)).toBe('16.00');
    expect(r.writeOff.toFixed(2)).toBe('64.00');
  });
});

describe('stock: products (03a 4.2-4.3)', () => {
  it('measures: defaults plus distinct lower-cased existing values', () => {
    const m = getMeasures([' Кг. ', 'М2', 'бр.', 'м2', null, 'тон']);
    expect(m.slice(0, 8)).toEqual(['бр.', 'кг.', 'пакет', 'каса', 'опаковка', 'литър', 'стек', 'кашон']);
    expect(m.slice(8)).toEqual(['м2', 'тон']);
  });
  it('validation messages', () => {
    const keys = validateProduct({ name: ' ', measure: '', incrementAccounts: [], decrementAccounts: [] }, { requireDecrement: true }).map((m) => m.key);
    expect(keys).toEqual(['strProductNameError', 'strProductMeasureError', 'strNoIncrementAccountsAttached', 'strNoDecrementAccountsAttached']);
    expect(STOCK_MESSAGES.strProductNameError).toBe('Не е въведено име на стока, материал или продукция!');
    // decrement list is optional unless required
    expect(validateProduct({ name: 'Стока', measure: 'бр.', incrementAccounts: [{ categoryId: 3 }], decrementAccounts: [] })).toEqual([]);
    // 411 (Клиенти) is not a product account
    expect(validateProduct({ name: 'Стока', measure: 'бр.', incrementAccounts: [{ categoryId: 10 }], decrementAccounts: [] }).map((m) => m.key)).toEqual(['strAccountDoesNotSupportProducts']);
    expect(validateProduct({ name: 'Стока', measure: 'бр.', incrementAccounts: [{ categoryId: 3 }], decrementAccounts: [{ categoryId: 3 }] }).map((m) => m.key)).toEqual(['strAccountDoesNotSupportProducts']);
  });
  it('account type: Decrement for release categories, else Increment', () => {
    expect(productAccountTypeFor(3)).toBe(0);
    expect(productAccountTypeFor(1)).toBe(0);
    expect(productAccountTypeFor(24)).toBe(1);
    expect(productAccountTypeFor(53)).toBe(1);
  });
});
