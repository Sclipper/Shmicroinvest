import { describe, expect, it } from 'vitest';
import {
  autoConcludeRow, bgnToEur, concludeTurnover, conversionDifference, distributePercents, isListedConcludeRow, isModeAccount,
  isPercentDistributionAvailable, isSettledPair, matchesConcludeFilter, partnerCarry, planClosing, planClosingA, planClosingB,
  splitBalance, validateClosing, type PlannedEntry,
} from '../src/index.ts';

const show = (e: PlannedEntry) => ({
  debits: e.debits.map((l) => [l.accountId, l.amount.toFixed(2)]),
  credits: e.credits.map((l) => [l.accountId, l.amount.toFixed(2)]),
});

describe('closing modes (02c 3.2)', () => {
  it('selects the source accounts of each mode', () => {
    expect(isModeAccount('economic', '602', 38)).toBe(true);
    expect(isModeAccount('economic', '624', 28)).toBe(false);
    expect(isModeAccount('costs', '624', 28)).toBe(true);
    expect(isModeAccount('costs', '602', 38)).toBe(false);
    expect(isModeAccount('costs', '651', 48)).toBe(false);
    expect(isModeAccount('costs', '611', null)).toBe(true);
    expect(isModeAccount('revenue', '702', null)).toBe(true);
    expect(isModeAccount('revenue', '751', 50)).toBe(false);
    expect(isModeAccount('revenue', '602', 38)).toBe(false);
  });
  it('turnover by mode, hiding rows below 0.01 and the number filter', () => {
    expect(concludeTurnover('economic', '1200', '200').toFixed(2)).toBe('1000.00');
    expect(concludeTurnover('revenue', '0', '500').toFixed(2)).toBe('500.00');
    expect(isListedConcludeRow('0.004')).toBe(false);
    expect(matchesConcludeFilter('602/1', '6021')).toBe(true);
    expect(matchesConcludeFilter('602/1', '60.2')).toBe(true);
    expect(matchesConcludeFilter('701', '60')).toBe(false);
  });
});

describe('algorithm A (no percent distribution)', () => {
  it('acceptance 1: one target at 100 % -> Dr 123 / Cr 602/1 1 000.00', () => {
    const r = planClosingA('economic', [{ accountId: 1, amount: '1000' }], [{ accountId: 123, percent: 100 }]);
    expect(r.map(show)).toEqual([{ debits: [[123, '1000.00']], credits: [[1, '1000.00']] }]);
  });
  it('acceptance 2: 70 % / 30 % on 100.01 -> two entries 70.01 and 30.00', () => {
    const r = planClosingA('costs', [{ accountId: 1, amount: '100.01' }], [{ accountId: 2, percent: 70 }, { accountId: 3, percent: 30 }]);
    expect(r.map(show)).toEqual([
      { debits: [[2, '70.01']], credits: [[1, '70.01']] },
      { debits: [[3, '30.00']], credits: [[1, '30.00']] },
    ]);
  });
  it('acceptance 5: revenue -> Dr 701 / Cr 123', () => {
    const r = planClosingA('revenue', [{ accountId: 701, amount: '500' }], [{ accountId: 123, percent: 100 }]);
    expect(r.map(show)).toEqual([{ debits: [[701, '500.00']], credits: [[123, '500.00']] }]);
  });
  it('acceptance 10: a single target at 150 % posts at most the full amount', () => {
    const r = planClosingA('economic', [{ accountId: 1, amount: '80' }], [{ accountId: 2, percent: 150 }]);
    expect(r.map(show)).toEqual([{ debits: [[2, '80.00']], credits: [[1, '80.00']] }]);
    expect(validateClosing('economic', [{ accountId: 1, amount: '80', turnover: '80' }], [{ accountId: 2, percent: 150 }], false).map((m) => [m.key, m.severity]))
      .toEqual([['strInvalidConcludeAccountsPercent', 'warning']]);
  });
  it('a partial sum (60 %) closes only that part', () => {
    const r = planClosingA('economic', [{ accountId: 1, amount: '100' }, { accountId: 4, amount: '50' }], [{ accountId: 2, percent: 60 }]);
    expect(r.map(show)).toEqual([{ debits: [[2, '90.00']], credits: [[1, '60.00'], [4, '30.00']] }]);
  });
  it('tiny amounts never produce negative lines (corrected D6)', () => {
    const r = planClosingA('economic', [{ accountId: 1, amount: '0.02' }], [1, 2, 3, 4].map((i) => ({ accountId: 10 + i, percent: 25 })));
    const parts = r.map((e) => e.credits[0]!.amount.toFixed(2));
    expect(parts).toEqual(['0.01', '0.01']);
  });
});

describe('algorithm B (percent distribution)', () => {
  it('worked example: 100.01 at 70 % / 30 % -> Dr 70.01, Dr 30.00, Cr 100.01', () => {
    expect(show(planClosingB('costs', { accountId: 1, amount: '100.01' }, [{ accountId: 2, percent: 70 }, { accountId: 3, percent: 30 }])))
      .toEqual({ debits: [[2, '70.01'], [3, '30.00']], credits: [[1, '100.01']] });
  });
  it('acceptance 7: 60 % / 40 % on 100.00', () => {
    expect(show(planClosingB('economic', { accountId: 1, amount: '100' }, [{ accountId: 2, percent: 60 }, { accountId: 3, percent: 40 }])))
      .toEqual({ debits: [[2, '60.00'], [3, '40.00']], credits: [[1, '100.00']] });
  });
  it('worked example: 0.05 at 50 % / 50 % -> 0.03 and 0.02', () => {
    expect(show(planClosingB('costs', { accountId: 1, amount: '0.05' }, [{ accountId: 2, percent: 50 }, { accountId: 3, percent: 50 }])))
      .toEqual({ debits: [[2, '0.03'], [3, '0.02']], credits: [[1, '0.05']] });
  });
  it('acceptance 6 (corrected D7): 60 % / 30 % is refused instead of a silent no-op', () => {
    const m = validateClosing('economic', [{ accountId: 1, amount: '100', turnover: '100' }], [{ accountId: 2, percent: 60 }, { accountId: 3, percent: 30 }], true);
    expect(m.filter((x) => x.severity === 'critical').map((x) => x.key)).toEqual(['strInvalidSumPercentDistribution']);
    // Without percent distribution the same targets are valid (A closes 90 %).
    expect(validateClosing('economic', [{ accountId: 1, amount: '100', turnover: '100' }], [{ accountId: 2, percent: 60 }, { accountId: 3, percent: 30 }], false)).toEqual([]);
  });
  it('acceptance 8: two sources -> no percent distribution', () => {
    const targets = [{ accountId: 2, percent: 50 }, { accountId: 3, percent: 50 }];
    expect(isPercentDistributionAvailable('economic', 2, targets)).toBe(false);
    expect(isPercentDistributionAvailable('economic', 1, targets)).toBe(true);
    expect(isPercentDistributionAvailable('revenue', 1, targets)).toBe(false);
    expect(planClosing('economic', [{ accountId: 1, amount: 10 }, { accountId: 4, amount: 10 }], targets, true)).toHaveLength(2);
  });
});

describe('closing validation', () => {
  it('reports the spec keys', () => {
    const keys = (m: ReturnType<typeof validateClosing>) => m.map((x) => x.key);
    expect(keys(validateClosing('economic', [], [{ accountId: 2, percent: 100 }], false))).toEqual(['strInvalidConcludeAccountsNumber']);
    expect(keys(validateClosing('economic', [{ accountId: 1, amount: '120', turnover: '100' }], [{ accountId: 2, percent: 100 }], false))).toEqual(['strInvalidConcludeAmount']);
    expect(keys(validateClosing('economic', [{ accountId: 1, amount: '10', turnover: '100' }], [{ accountId: null, percent: 100 }], false))).toEqual(['strInvalidConcludeToAccount']);
    expect(keys(validateClosing('economic', [{ accountId: 1, amount: '10' }], [{ accountId: 2, percent: 70 }, { accountId: 3, percent: 40 }], false))).toEqual(['strInvalidSumPercent']);
    const w = validateClosing('economic', [{ accountId: 1, amount: '10', number: '602', hasInitialBalance: true }], [{ accountId: 2, percent: 100 }], false);
    expect(w).toEqual([{ key: 'strInitialBalanceWarning', severity: 'warning', text: 'Следните сметки имат начални салда: 602.' }]);
  });
  it('auto distribution: 100 * T_i / ΣT', () => {
    expect(distributePercents(['300', '100']).map((p) => p.toString())).toEqual(['75', '25']);
    expect(distributePercents(['0', '0']).map((p) => p.toString())).toEqual(['0', '0']);
  });
});

describe('automatic closing (02c 3.3)', () => {
  it('closes active debit and passive credit surpluses only', () => {
    expect(autoConcludeRow(true, '500', '100')).toMatchObject({ debit: 'conclude', credit: 'account' });
    expect(autoConcludeRow(true, '500', '100')!.amount.toFixed(2)).toBe('400.00');
    expect(autoConcludeRow(false, '0', '300')).toMatchObject({ debit: 'account', credit: 'conclude' });
    expect(autoConcludeRow(true, '100', '300')).toBeNull();
    expect(autoConcludeRow(false, '300', '100')).toBeNull();
    expect(autoConcludeRow(null, '300', '100')).toBeNull();
    expect(autoConcludeRow(true, '100', '100')).toBeNull();
  });
});

describe('year-end transfer rules (01b 6.4)', () => {
  it('worked example: 501 1000 + 250 - 400 = 850 debit', () => {
    const b = splitBalance('850');
    expect([b.debit.toFixed(2), b.credit.toFixed(2)]).toEqual(['850.00', '0.00']);
    const s = splitBalance('-400');
    expect([s.debit.toFixed(2), s.credit.toFixed(2)]).toEqual(['0.00', '400.00']);
  });
  it('partner documents carry their open amount; credit notes stay on their side as negatives', () => {
    expect(partnerCarry('-400', 4, false).credit.toFixed(2)).toBe('400.00');
    expect(partnerCarry('400', 10, false).debit.toFixed(2)).toBe('400.00');
    expect(partnerCarry('-50', 10, true).debit.toFixed(2)).toBe('-50.00');
    expect(partnerCarry('50', 4, true).credit.toFixed(2)).toBe('-50.00');
    expect(partnerCarry('50', 10, true).debit.toFixed(2)).toBe('50.00');
  });
  it('settled partners vanish', () => {
    expect(isSettledPair('0', '0')).toBe(true);
    expect(isSettledPair('0.0000001', '0')).toBe(true);
    expect(isSettledPair('0.01', '0')).toBe(false);
    expect(isSettledPair('0', '0', '1')).toBe(false);
  });
  it('euro conversion and the rounding difference', () => {
    expect(bgnToEur('1000').toFixed(2)).toBe('511.29');
    expect(bgnToEur('195.583').toFixed(2)).toBe('100.00');
    // 1000 BGN debit vs 600 + 400 BGN credit: 511.29 vs 306.78 + 204.52 = 511.30
    const rows = [{ debit: bgnToEur('1000'), credit: bgnToEur(0) }, { debit: bgnToEur(0), credit: bgnToEur('600') }, { debit: bgnToEur(0), credit: bgnToEur('400') }];
    expect(conversionDifference(rows).toFixed(2)).toBe('0.01');
  });
});
