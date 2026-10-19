import { describe, expect, it } from 'vitest';
import { openingPaymentOutcomes, openingRowKey } from '../src/index.ts';

describe('opening balances with payments (01b 7 strInitialBalancesExistingPaymentWarning/Error)', () => {
  const inv = openingRowKey(5, 1, ' 17 ');
  it('identifies a row by partner and document', () => {
    expect(inv).toBe('5|1|17');
    expect(openingRowKey(5, null, '')).toBe('5|');
    expect(openingRowKey(null)).toBe('0|');
  });
  it('re-links when the row stays on its side with at least the paid amount', () => {
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: '200' }], [{ key: inv, debit: '200', credit: 0 }]))
      .toEqual([{ key: inv, outcome: 'relink' }]);
  });
  it('unlinks (warning) when the row is gone or zero', () => {
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: '200' }], [])).toEqual([{ key: inv, outcome: 'unlink' }]);
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: '200' }], [{ key: inv, debit: '0', credit: '0' }])).toEqual([{ key: inv, outcome: 'unlink' }]);
  });
  it('blocks (error) a row below the paid amount or on the other side', () => {
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: '200' }], [{ key: inv, debit: '199.99', credit: 0 }])).toEqual([{ key: inv, outcome: 'tooSmall' }]);
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: '200' }], [{ key: inv, debit: 0, credit: '600' }])).toEqual([{ key: inv, outcome: 'tooSmall' }]);
  });
  it('ignores rows without payments', () => {
    expect(openingPaymentOutcomes([{ key: inv, debit: '600', credit: 0, paid: 0 }], [])).toEqual([]);
  });
});
