import { describe, expect, it } from 'vitest';
import {
  canHaveConcludeAccount, defaultActiveYear, effectiveConcludeAccountId, loginActiveYear, needsPreviousConclusion, workingDateInYear, yearChangeMovesDateForward,
  isValidAccountNumber, nextAccountNumber, normalizeAccountNumber } from '../src/index.ts';
import {
  rebuildNestedSet, nextSubAccountNumber, lockMonth, unlockMonth, isMonthLocked,
  isValidEik, isValidEgn, isValidEgnChecksum, isValidLnch, isValidIban, amountInWords,
  buildLegs, legBalance, linesFromLegs, round2, validateEntry, parseChartTemplate, COMMERCIAL_CHART,
  reverseLines, formatMoney, parseAmount,
  ACCOUNT_CATEGORIES, BANKS, CHART_TEMPLATE_TYPES, TRZ_REQUIRED_ACCOUNTS, chartTemplateAccounts, chartTemplateSettings, checkChartTemplate, templateLevel,
  type ChartTemplateType,
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

describe('chart-of-accounts templates (01a 7, 03a 1.3)', () => {
  const shape = (type: ChartTemplateType) => {
    const accs = chartTemplateAccounts(type);
    const byNumber = new Map(accs.map((a) => [a.number, a]));
    const levels: Record<number, number> = {};
    for (const a of accs) { const l = templateLevel(a, byNumber); levels[l] = (levels[l] ?? 0) + 1; }
    const withCategory = accs.filter((a) => a.categoryId != null);
    return { accs, byNumber, levels, withCategory, distinct: new Set(withCategory.map((a) => a.categoryId)) };
  };

  it.each(CHART_TEMPLATE_TYPES)('%s: unique numbers, parents listed first, known categories', (type) => {
    const accs = chartTemplateAccounts(type);
    expect(checkChartTemplate(accs)).toEqual([]);
    expect(new Set(accs.map((a) => a.number)).size).toBe(accs.length);
    const numbers = new Set(accs.map((a) => a.number));
    for (const a of accs) if (a.parentNumber !== '0') expect(numbers.has(a.parentNumber), a.number).toBe(true);
    const known = new Set(ACCOUNT_CATEGORIES.map((c) => c.id));
    for (const a of accs) if (a.categoryId != null) expect(known.has(a.categoryId), a.number).toBe(true);
    // Categories that no template attaches (01a 6.3).
    for (const id of [1, 2, 3, 23, 24, 25, 31, 52, 53, 54, 55]) expect(accs.some((a) => a.categoryId === id), `${type} ${id}`).toBe(false);
  });

  it('the checker reports broken trees', () => {
    const bad = parseChartTemplate('4|Разчети\n40|Доставчици\n401|Доставчици|4\n401|Доставчици\n45/1|Без родител\n402/1|Подсметка|10\n402|Аванси|5\n41|Клиенти\n411|Клиенти|99');
    expect(checkChartTemplate(bad)).toEqual([
      '401: duplicate number',
      '45/1: parent 45 missing or listed later',
      '402/1: parent 402 missing or listed later',
      '411: unknown category 99',
    ]);
    expect(checkChartTemplate(parseChartTemplate('4|Разчети\n40|Доставчици\n401|Доставчици|4\n401/1|Аванси|5'))).toEqual(['401/1: category 5 differs from parent 401 (4)']);
  });

  it('commercial: the 61 category attachments on 50 categories of Delta; existing numbers keep their meaning', () => {
    const c = shape('commercial');
    expect(c.withCategory).toHaveLength(61);
    expect(c.distinct.size).toBe(50);
    expect(c.accs.length).toBeGreaterThanOrEqual(300);
    expect(c.levels[2]).toBe(8);
    expect(c.accs.filter((a) => a.categoryId === 40).map((a) => a.number)).toEqual(['604', '604/1', '604/2', '604/3', '604/4', '604/5']);
    expect(c.accs.filter((a) => a.categoryId === 41).map((a) => a.number)).toEqual(['605', '605/1', '605/2', '605/3', '605/4', '605/5', '605/6']);
    expect(c.byNumber.get('411')).toMatchObject({ description: 'Клиенти', categoryId: 10 });
    expect(c.byNumber.get('453/9')).toMatchObject({ categoryId: 36 });
    // The accounts the ТРЗ Pro import needs are part of the template.
    for (const a of TRZ_REQUIRED_ACCOUNTS) expect(c.byNumber.has(a.number), a.number).toBe(true);
  });

  it('non-profit: Delta\'s shape (302 accounts with the root) and category attachments', () => {
    const n = shape('nonProfit');
    expect(n.accs).toHaveLength(301);
    expect(n.levels).toEqual({ 2: 8, 3: 43, 4: 181, 5: 65, 6: 4 });
    expect(n.withCategory).toHaveLength(71);
    expect(n.distinct.size).toBe(47);
    // No internal settlements / related-party suppliers and clients (01a 6.3).
    for (const id of [32, 33, 34]) expect(n.withCategory.some((a) => a.categoryId === id)).toBe(false);
    expect(n.accs.filter((a) => a.categoryId === 45).map((a) => a.number)).toEqual(['609', '609/1', '609/1/1', '609/1/2', '609/1/3', '609/1/4', '609/2']);
    expect(n.accs.filter((a) => a.categoryId === 58).map((a) => a.number)).toEqual(['509', '509/1', '509/9']);
    expect(n.byNumber.get('712')!.description).toBe('Приходи от членски внос');
    expect(n.byNumber.get('714')!.description).toBe('Приходи от дарения');
    expect(n.byNumber.get('754')!.description).toBe('Финансиране на текущата дейност');
  });

  it('budget: 4-digit synthetic accounts under 8 sections and the 31 attachments of 01a 6.3', () => {
    const b = shape('budget');
    expect(b.levels[2]).toBe(8);
    expect(b.levels[3]).toBe(48);
    expect(b.levels[4]).toBe(220);
    expect(b.levels[5]).toBeGreaterThan(850);
    expect(b.levels[6]).toBe(4);
    for (const a of b.accs) if (templateLevel(a, b.byNumber) === 5) expect(a.number, a.number).toMatch(/^\d{4}$/);
    expect(b.withCategory).toHaveLength(31);
    expect(b.distinct.size).toBe(31);
    const at = (n: string) => b.byNumber.get(n)!.categoryId;
    expect([at('4010'), at('4110'), at('5011'), at('5013'), at('4261'), at('4511/1'), at('4511/2'), at('4511/8'), at('4511/9')]).toEqual([4, 10, 21, 22, 30, 16, 17, 35, 36]);
    expect(b.byNumber.get('1001')).toMatchObject({ description: 'Разполагаем капитал', parentNumber: '100' });
    expect(chartTemplateSettings('budget')).toEqual({ IsParagraphEnabled: 'True' });
    expect(chartTemplateSettings('nonProfit')).toEqual({});
  });
});

describe('banks seed (01a 9.2)', () => {
  it('has Delta\'s 46 rows with unique BICs; the first rows keep their positional ids', () => {
    expect(BANKS).toHaveLength(46);
    expect(new Set(BANKS.map((b) => b.code)).size).toBe(46);
    for (const b of BANKS) expect(b.code, b.name).toMatch(/^[A-Z]{4}BG[A-Z0-9]{2}$|^EVIULT2V$/);
    expect(BANKS.slice(0, 3).map((b) => b.code)).toEqual(['BNBGBGSF', 'UNCRBGSF', 'STSABGSF']);
    expect(BANKS[29]!.code).toBe('EVIULT2V');
    expect(BANKS.map((b) => b.code)).toEqual(expect.arrayContaining(['KORPBGSF', 'CBUNBGSF', 'BUIBBGSF', 'CRBABGSF', 'BNBGBGSD']));
  });
});

describe('account numbers (03a 1.5)', () => {
  it('checks the shape under each level', () => {
    expect(isValidAccountNumber('0', '7')).toBe(true);
    expect(isValidAccountNumber('0', '40')).toBe(false);
    expect(isValidAccountNumber('4', '40')).toBe(true);
    expect(isValidAccountNumber('40', '401')).toBe(true);
    expect(isValidAccountNumber('40', '411')).toBe(false);
    expect(isValidAccountNumber('40', '4011')).toBe(false);
    expect(isValidAccountNumber('401', '401/2')).toBe(true);
    expect(isValidAccountNumber('401', '401/x')).toBe(false);
    expect(isValidAccountNumber('401', '4012')).toBe(false);
    expect(isValidAccountNumber('401/2', '401/2/1')).toBe(true);
  });
  it('suggests the next number and normalises separators', () => {
    expect(nextAccountNumber('401', ['401/1', '401/3'])).toBe('401/2');
    expect(nextAccountNumber('40', ['401', '402'])).toBe('400');
    expect(nextAccountNumber('0', ['1', '2'])).toBe('3');
    expect(normalizeAccountNumber('401.2')).toBe('401/2');
    expect(normalizeAccountNumber(' 401 2 ')).toBe('401/2');
  });
});

describe('conclude account (01a 4.1, 07 3.5)', () => {
  it('is available for active and passive accounts only', () => {
    expect(canHaveConcludeAccount(true)).toBe(true);
    expect(canHaveConcludeAccount(false)).toBe(true);
    expect(canHaveConcludeAccount(null)).toBe(false);
  });
  it('is cleared for active-passive accounts and never points at the account itself', () => {
    expect(effectiveConcludeAccountId(10, true, 20)).toBe(20);
    expect(effectiveConcludeAccountId(10, false, 20)).toBe(20);
    expect(effectiveConcludeAccountId(10, null, 20)).toBeNull();
    expect(effectiveConcludeAccountId(10, true, 10)).toBeNull();
    expect(effectiveConcludeAccountId(null, true, 20)).toBe(20);
    expect(effectiveConcludeAccountId(10, true, null)).toBeNull();
  });
});

describe('financial year rules (01b 5, 6.3; 06 4.1)', () => {
  it('defaults to the current year, not the latest', () => {
    expect(defaultActiveYear([2025, 2026, 2027], '2026-10-19')).toBe(2026);
    expect(defaultActiveYear([2024, 2025], '2026-10-19')).toBe(2025);
    expect(defaultActiveYear([2027, 2028], '2026-10-19')).toBe(2027);
    expect(defaultActiveYear([], '2026-10-19')).toBeNull();
  });
  it('falls back from 2026 to 2025 at login while the euro chart is not ready', () => {
    expect(loginActiveYear(2026, false, [2025, 2026])).toBe(2025);
    expect(loginActiveYear(2026, true, [2025, 2026])).toBe(2026);
    expect(loginActiveYear(2026, false, [2026])).toBe(2026);
    expect(loginActiveYear(2027, false, [2025, 2026, 2027])).toBe(2027);
  });
  it('asks to conclude the previous year before creating the next one', () => {
    expect(needsPreviousConclusion([{ year: 2025, isConcluded: false }], 2026)).toBe(true);
    expect(needsPreviousConclusion([{ year: 2025, isConcluded: true }], 2026)).toBe(false);
    expect(needsPreviousConclusion([{ year: 2025, isConcluded: false }], 2024)).toBe(false);
  });
  it('moves the working date into the chosen year and asks when it moves forward', () => {
    expect(workingDateInYear('2026-10-19', 2026)).toBeNull();
    expect(workingDateInYear('2026-10-19', 2027)).toBe('2027-10-19');
    expect(workingDateInYear('2028-02-29', 2027)).toBe('2027-02-28');
    expect(workingDateInYear('2027-02-28', 2028)).toBe('2028-02-28');
    expect(yearChangeMovesDateForward('2026-10-19', 2027)).toBe(true);
    expect(yearChangeMovesDateForward('2026-10-19', 2025)).toBe(false);
    expect(yearChangeMovesDateForward('2026-10-19', 2026)).toBe(false);
  });
});
