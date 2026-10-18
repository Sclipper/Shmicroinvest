import { describe, expect, it } from 'vitest';
import {
  rebuildNestedSet, nextSubAccountNumber, lockMonth, unlockMonth, isMonthLocked,
  isValidEik, isValidEgn, isValidEgnChecksum, isValidLnch, isValidIban, amountInWords,
  buildLegs, legBalance, linesFromLegs, round2, validateEntry, parseChartTemplate, COMMERCIAL_CHART,
  reverseLines, formatMoney, parseAmount,
} from '../src/index.ts';

describe('nested set rebuild (01a 4.3 worked example)', () => {
  it('numbers siblings in descending order', () => {
    const nodes = [
      { id: 1, parentId: null, number: '0' },
      { id: 2, parentId: 1, number: '4' },
      { id: 3, parentId: 1, number: '5' },
      { id: 4, parentId: 2, number: '41' },
      { id: 5, parentId: 4, number: '411' },
      { id: 6, parentId: 5, number: '411/1' },
      { id: 7, parentId: 99, number: '999' },
    ];
    const r = rebuildNestedSet(nodes);
    expect(r.get(1)).toEqual({ left: 1, right: 12, level: 1 });
    expect(r.get(3)).toEqual({ left: 2, right: 3, level: 2 });
    expect(r.get(2)).toEqual({ left: 4, right: 11, level: 2 });
    expect(r.get(4)).toEqual({ left: 5, right: 10, level: 3 });
    expect(r.get(5)).toEqual({ left: 6, right: 9, level: 4 });
    expect(r.get(6)).toEqual({ left: 7, right: 8, level: 5 });
    expect(r.has(7)).toBe(false);
  });
  it('numbers each chart independently', () => {
    const r = rebuildNestedSet([
      { id: 1, parentId: null, number: '0', isEuro: false },
      { id: 2, parentId: null, number: '0', isEuro: true },
      { id: 3, parentId: 2, number: '501', isEuro: true },
    ]);
    expect(r.get(1)).toEqual({ left: 1, right: 2, level: 1 });
    expect(r.get(3)).toEqual({ left: 2, right: 3, level: 2 });
  });
});

describe('sub-account numbering', () => {
  it('takes the smallest free suffix', () => {
    expect(nextSubAccountNumber('411', ['411/1', '411/3'])).toBe('411/2');
    expect(nextSubAccountNumber('411', [])).toBe('411/1');
    expect(nextSubAccountNumber('411', ['411/1', '411/2', '4111'])).toBe('411/3');
  });
});

describe('month locks (01b 6.1)', () => {
  it('locks and derives IsLocked only at 8190', () => {
    let s = { isLocked: false, lockedMonths: 0 };
    s = lockMonth(s, 1); s = lockMonth(s, 3);
    expect(s.lockedMonths).toBe(10);
    expect(isMonthLocked(10, 2)).toBe(false);
    expect(isMonthLocked(10, 3)).toBe(true);
    for (let m = 1; m <= 12; m++) s = lockMonth(s, m);
    expect(s).toEqual({ isLocked: true, lockedMonths: 8190 });
    s = unlockMonth(s, 5);
    expect(s.isLocked).toBe(false);
    expect(s.lockedMonths).toBe(8190 - 32);
  });
});

describe('identifier validators', () => {
  it('EIK examples from the spec', () => {
    expect(isValidEik('123456786')).toBe(true);
    expect(isValidEik('123456787')).toBe(false);
    expect(isValidEik('831903180')).toBe(true);
    expect(isValidEik('831903183')).toBe(false);
    expect(isValidEik('100000550')).toBe(true);
    expect(isValidEik('100000086')).toBe(true);
    expect(isValidEik('175074752')).toBe(true);
    expect(isValidEik('12345678')).toBe(false);
  });
  it('EGN with date check', () => {
    expect(isValidEgn('8001011236')).toBe(false === isValidEgnChecksum('8001011236') ? false : true);
    expect(isValidEgnChecksum('8102291238')).toBe(true);
    expect(isValidEgn('8102291238')).toBe(false);
  });
  it('LNCH', () => {
    expect(isValidLnch('1234567893')).toBe(true);
    expect(isValidLnch('1234567890')).toBe(false);
  });
  it('IBAN', () => {
    expect(isValidIban('BG80BNBG96611020345678')).toBe(true);
    expect(isValidIban('bg80 bnbg 9661 1020 3456 78')).toBe(true);
    expect(isValidIban('BG00BNBG96611020345678')).toBe(false);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });
});

describe('amount in words (02c 1.10 vectors)', () => {
  const cases: [string, string, string][] = [
    ['0.50', 'EUR', 'нула евро и 50 цента'],
    ['1.00', 'EUR', 'един евро'],
    ['1.00', 'BGN', 'един лв.'],
    ['2.00', 'EUR', 'два евро'],
    ['123.45', 'EUR', 'сто двадесет и три евро и 45 цента'],
    ['300', 'BGN', 'триста лв.'],
    ['1000.01', 'BGN', 'хиляда лв. и 1 ст.'],
    ['1001', 'EUR', 'хиляда и един евро'],
    ['1100', '', 'хиляда и сто'],
    ['1105', '', 'хиляда сто и пет'],
    ['1121', '', 'хиляда сто двадесет и един'],
    ['2000', '', 'две хиляди'],
    ['2345.67', 'EUR', 'две хиляди триста четиридесет и пет евро и 67 цента'],
    ['12345', '', 'дванадесет хиляди триста четиридесет и пет'],
    ['21000', '', 'двадесет и една хиляди'],
    ['101101', '', 'сто и една хиляди сто и един'],
    ['1000000', '', 'един милион'],
    ['1000001', '', 'един милион и един'],
    ['3500000', '', 'три милиона и петстотин хиляди'],
    ['1000000000', '', 'един милиард'],
    ['999999999999', '', 'деветстотин деветдесет и девет милиарда деветстотин деветдесет и девет милиона деветстотин деветдесет и девет хиляди деветстотин деветдесет и девет'],
  ];
  for (const [n, c, expected] of cases) {
    it(`${n} ${c}`, () => expect(amountInWords(n, c)).toBe(expected));
  }
  it('capitalizes and rejects >= 1e12', () => {
    expect(amountInWords('1200', 'EUR', { capitalize: true })).toBe('Хиляда и двеста евро');
    expect(amountInWords('1000000000000', 'EUR')).toBe('');
  });
});

describe('journal legs (01a 8.2, 02a 1.1-1.2)', () => {
  it('stores Dr 411 / Cr 703 as two mirrored legs', () => {
    const legs = buildLegs([{ accountId: 411, amount: '100' }], [{ accountId: 703, amount: '100' }]);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ accountId: 411, refAccountId: 703, sign: 1 });
    expect(legs[0]!.amount.toFixed(2)).toBe('100.00');
    expect(legs[1]).toMatchObject({ accountId: 703, refAccountId: 411, sign: -1 });
    expect(legs[1]!.refAmount.toFixed(2)).toBe('100.00');
    expect(legBalance(legs).isZero()).toBe(true);
    expect(legBalance(legs.filter((l) => l.accountId === 411)).toFixed(2)).toBe('100.00');
  });
  it('1 debit / 2 credits gives 4 rows and loads back as 1/2', () => {
    const legs = buildLegs([{ accountId: 1, amount: '100' }], [{ accountId: 2, amount: '60' }, { accountId: 3, amount: '40' }]);
    expect(legs).toHaveLength(4);
    const back = linesFromLegs(legs.map((l) => ({ ...l, companyId: null })));
    expect(back.debits).toHaveLength(1);
    expect(back.debits[0]!.amount.toFixed(2)).toBe('100.00');
    expect(back.credits.map((c) => c.amount.toFixed(2))).toEqual(['60.00', '40.00']);
  });
  it('splits a currency leg on the single side with the remainder on the last pair', () => {
    const legs = buildLegs(
      [{ accountId: 1, amount: '100', currency: { currencyId: 3, currencyAmount: '50', exchangeRate: '2', fixedRate: '1' } }],
      [{ accountId: 2, amount: '33.33' }, { accountId: 3, amount: '66.67' }],
    );
    const debitLegs = legs.filter((l) => l.sign === 1);
    expect(debitLegs.map((l) => l.currency!.currencyAmount)).toEqual(['16.67', '33.33']);
  });
  it('reversal negates amounts but keeps accounts', () => {
    const r = reverseLines([{ accountId: 411, amount: '120' }]);
    expect(r[0]).toMatchObject({ accountId: 411, amount: '-120.00' });
  });
});

describe('journal validation (02a 4.3)', () => {
  const accounts = new Map([
    [1, { id: 1, number: '411', isLeaf: true, categoryId: 10, isForeignCurrency: false, isMaterial: false }],
    [2, { id: 2, number: '703', isLeaf: true, categoryId: null, isForeignCurrency: false, isMaterial: false }],
    [3, { id: 3, number: '70', isLeaf: false, categoryId: null, isForeignCurrency: false, isMaterial: false }],
  ]);
  const base = {
    accountingDate: '2026-03-15', documentTypeId: 1, documentNumber: '55', term: 'Продажба',
    transactionTypeId: 3, debits: [{ accountId: 1, amount: '100', companyId: 7 }], credits: [{ accountId: 2, amount: '100' }],
  };
  const ctx = { activeYear: 2026, lockedMonths: 0, accounts };
  const keys = (e: object, c = ctx) => validateEntry({ ...base, ...e }, c).filter((m) => m.severity === 'critical').map((m) => m.key);
  it('accepts a valid entry', () => expect(keys({})).toEqual([]));
  it('rejects unbalanced sums', () => expect(keys({ credits: [{ accountId: 2, amount: '99.99' }] })).toContain('strInvalidDebitCreditAmounts'));
  it('rejects a locked month', () => expect(keys({}, { ...ctx, lockedMonths: 8 })).toEqual(['strWrongAccountingMonth']));
  it('rejects another year', () => expect(keys({ accountingDate: '2025-12-31' })).toEqual(['strWrongAccountingDate']));
  it('requires a partner on partner accounts', () => expect(keys({ debits: [{ accountId: 1, amount: '100' }] })).toEqual(['strMissingCompany']));
  it('rejects synthetic accounts', () => expect(keys({ credits: [{ accountId: 3, amount: '100' }] })).toEqual(['strAccountNotLeaf']));
  it('requires a term', () => expect(keys({ term: ' ' })).toEqual(['strMissingTerm']));
});

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(round2('195.583').toFixed(2)).toBe('195.58');
    expect(round2('10.005').toFixed(2)).toBe('10.01');
    expect(round2('-10.005').toFixed(2)).toBe('-10.01');
  });
  it('formats and parses Bulgarian style', () => {
    expect(formatMoney('1234567.891')).toBe('1 234 567,89');
    expect(parseAmount('1 234,5')!.toFixed(2)).toBe('1234.50');
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('commercial chart template', () => {
  it('parses and every parent exists', () => {
    const accs = parseChartTemplate(COMMERCIAL_CHART);
    const numbers = new Set(accs.map((a) => a.number));
    expect(accs.length).toBeGreaterThan(200);
    for (const a of accs) if (a.parentNumber !== '0') expect(numbers.has(a.parentNumber), a.number).toBe(true);
    expect(accs.find((a) => a.number === '453/1')!.categoryId).toBe(16);
    expect(new Set(accs.map((a) => a.number)).size).toBe(accs.length);
  });
});
