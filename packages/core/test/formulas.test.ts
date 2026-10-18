import { describe, expect, it } from 'vitest';
import {
  FormulaCalculator, FormulaSyntaxError, STATEMENT_CHECKS, STATEMENT_SEED, balanceFunction, buildStatementSeed, correspondence,
  formulaAccountMatches, formulaReferences, parseFormula, resolveReference, statementLayout, statementOfKey, statementPeriods,
  statementUnit, toThousands, validateFormula, type FormulaDataSet, type FormulaContext,
} from '../src/index.ts';

/** Small hand-made balance set (amounts in the current period). */
const DATA: FormulaDataSet = {
  accounts: [
    // number, opening debit/credit sums, debit/credit turnover
    { number: '501', od: '1000', oc: '0', dt: '300', ct: '450' }, // closing debit 850
    { number: '503', od: '200', oc: '0', dt: '100', ct: '400' }, // closing credit 100 (overdraft)
    { number: '401/1', od: '0', oc: '0', dt: '0', ct: '0' },
    { number: '401/2', od: '0', oc: '10', dt: '0', ct: '0' }, // closing credit 10
    { number: '401/3', od: '30', oc: '0', dt: '0', ct: '0' }, // closing debit 30
    { number: '601', od: '0', oc: '0', dt: '12400.50', ct: '400.50' },
    { number: '602', od: '0', oc: '0', dt: '75', ct: '0' },
    { number: '701', od: '0', oc: '0', dt: '0', ct: '900' },
    { number: '702', od: '0', oc: '0', dt: '0', ct: '100' },
    { number: '4011', od: '5', oc: '0', dt: '0', ct: '0' }, // must not match "401" (3+ chars never prefix-match)
  ],
  correspondences: [
    { debit: '211', credit: '701', amount: '40' }, // not a 70*/21* pair (debit 21x against credit 70x)
    { debit: '701', credit: '211', amount: '40' },
    { debit: '702', credit: '213', amount: '10' },
    { debit: '702', credit: '304', amount: '7' },
    { debit: '501', credit: '411', amount: '120' },
    { debit: '503', credit: '411/5', amount: '30' },
  ],
};

const calc = (formulas: Record<string, string>, extra: Partial<FormulaContext> = {}, ep: FormulaDataSet = DATA) =>
  new FormulaCalculator({ formulas, data: (p) => (p === 'cp' ? DATA : ep), ...extra });

const v = (formula: string, extra: Partial<FormulaContext> = {}) => calc({ x: formula }, extra).cell('x').toFixed(2);

describe('formula parser', () => {
  it('parses every seeded statement formula (898 cells)', () => {
    let n = 0;
    for (const cells of Object.values(STATEMENT_SEED)) for (const [, , , f] of cells) {
      expect(() => parseFormula(f), f).not.toThrow();
      n++;
    }
    expect(n).toBe(898);
  });

  it('every reference in the seed resolves to a seeded key, except the upstream s370 defect', () => {
    const keys = new Set(Object.values(STATEMENT_SEED).flatMap((c) => c.map(([k]) => k.toLowerCase())));
    const bad: string[] = [];
    for (const cells of Object.values(STATEMENT_SEED)) for (const [k, , , f] of cells) {
      const err = validateFormula(f, (x) => keys.has(x));
      if (err) bad.push(`${k}: ${err}`);
    }
    // NSI cell s370 "s371+s372+s373+s374" refers to two cells the seed does not contain; they evaluate to 0.
    expect(bad).toEqual(['s370: Непозната формула : s373']);
  });

  it('only k6 uses the function-less account pair', () => {
    const implicit = Object.values(STATEMENT_SEED).flat().filter(([, , , f]) => formulaReferences(parseFormula(f)).implicit).map(([k]) => k);
    expect(implicit).toEqual(['k6']);
  });

  it('builds the expected tree', () => {
    expect(parseFormula('fdb(211)-fcb(242/1)')).toEqual({
      t: 'sum', terms: [{ sign: 1, e: { t: 'fn', fn: 'fdb', account: '211' } }, { sign: -1, e: { t: 'fn', fn: 'fcb', account: '242/1' } }],
    });
    expect(parseFormula('-fdb(121)')).toEqual({ t: 'neg', e: { t: 'fn', fn: 'fdb', account: '121' } });
    expect(parseFormula('ac(70*,21*)')).toEqual({ t: 'ac', debit: '70*', credit: '21*' });
    expect(parseFormula('[r49+r40-r23-r17]').t).toBe('max0');
    expect(parseFormula('{r1-r2}').t).toBe('min0');
    expect(parseFormula(' 0 ')).toEqual({ t: 'num', value: '0' });
    expect(parseFormula('KT(709)')).toEqual({ t: 'fn', fn: 'ct', account: '709' });
  });

  it('rejects malformed formulas with Bulgarian messages', () => {
    expect(() => parseFormula('')).toThrow('Не е въведена формула!');
    expect(() => parseFormula('fdb(501')).toThrow(FormulaSyntaxError);
    expect(() => parseFormula('fdb(501)*2')).toThrow(/Неочакван символ/);
    expect(() => parseFormula('ac(501)')).toThrow(/две сметки/);
    expect(() => parseFormula('fdb(501,502)')).toThrow(/една сметка/);
    expect(() => parseFormula('r1+')).toThrow(/Непълна/);
    expect(() => parseFormula('[r1-r2')).toThrow(/Очаква се „]“/);
    expect(() => parseFormula('dt(5 01)')).toThrow(/Невалидна сметка/);
  });

  it('validates unknown references', () => {
    const has = (k: string) => ['r1', 'b50'].includes(k);
    expect(validateFormula('r1+b50ep', has)).toBeNull();
    expect(validateFormula('r1+r99', has)).toBe('Непозната формула : r99');
    expect(resolveReference('B50CP', has)).toEqual({ key: 'b50', period: 'cp' });
    expect(resolveReference('r1', has)).toEqual({ key: 'r1', period: null });
  });
});

describe('account matching (05 2.5 / 9.5)', () => {
  it('equal, sub-account and the short prefix rule', () => {
    expect(formulaAccountMatches('401', '401')).toBe(true);
    expect(formulaAccountMatches('401/1', '401')).toBe(true);
    expect(formulaAccountMatches('4011', '401')).toBe(false);
    expect(formulaAccountMatches('701', '70*')).toBe(true);
    expect(formulaAccountMatches('709/3', '70')).toBe(true);
    expect(formulaAccountMatches('711', '70*')).toBe(false);
    expect(formulaAccountMatches('453/1', '453/1')).toBe(true);
    expect(formulaAccountMatches('453/12', '453/1')).toBe(false);
    expect(formulaAccountMatches('453.1', '453\\1', '.')).toBe(true);
  });
});

describe('functions (9.5)', () => {
  it('idb / icb: opening balances floored per account then summed', () => {
    expect(balanceFunction('idb', '501', DATA).toFixed(2)).toBe('1000.00');
    expect(balanceFunction('idb', '401', DATA).toFixed(2)).toBe('30.00');
    expect(balanceFunction('icb', '401', DATA).toFixed(2)).toBe('10.00');
    expect(balanceFunction('icb', '501', DATA).toFixed(2)).toBe('0.00');
  });
  it('fdb / fcb: closing balances, never netted across accounts', () => {
    expect(v('fdb(501)')).toBe('850.00');
    expect(v('fcb(503)')).toBe('100.00');
    expect(v('fdb(503)')).toBe('0.00');
    // 50* = 501 (debit 850) and 503 (credit 100): debit side only.
    expect(v('fdb(50*)')).toBe('850.00');
    expect(v('fcb(50*)')).toBe('100.00');
    // Acceptance 9.7: 401/1 closing debit 30 (here 401/3), 401/2 closing credit 10 -> 30.
    expect(v('fdb(401)')).toBe('30.00');
  });
  it('dt / ct: plain turnover sums', () => {
    expect(v('dt(601)')).toBe('12400.50');
    expect(v('ct(601)')).toBe('400.50');
    expect(v('ct(70*)')).toBe('1000.00');
    expect(v('dt(50*)')).toBe('400.00');
  });
  it('ac: debit correspondence with the prefix rule on both sides', () => {
    // Acceptance 9.7: 701 debited against 211 for 40 and 702 against 213 for 10 -> 50.
    expect(v('ac(70*,21*)')).toBe('50.00');
    expect(v('ac(70*,30*)')).toBe('7.00');
    expect(v('ac(50*,411)')).toBe('150.00');
    expect(v('ac(503,411/5)')).toBe('30.00');
    expect(correspondence('21*', '70*', DATA).toFixed(2)).toBe('40.00');
  });
  it('month mode nets without the per-account floor', () => {
    const month: FormulaDataSet = { ...DATA, monthMode: true };
    expect(balanceFunction('fdb', '401', month).toFixed(2)).toBe('20.00');
    expect(balanceFunction('fdb', '50*', month).toFixed(2)).toBe('750.00');
  });
});

describe('operators and cells (9.4)', () => {
  it('evaluates + and - left to right with leading signs', () => {
    expect(v('10-3-2')).toBe('5.00');
    expect(v('-10+3')).toBe('-7.00');
    expect(v('+dt(602)')).toBe('75.00');
    expect(v('1.5+0.25')).toBe('1.75');
  });
  it('[ ] clamps to max(x,0) and { } to min(x,0) (acceptance 9.7)', () => {
    const c = calc({ r1: '5', r2: '8', a: '[r1-r2]', b: '{r1-r2}', c: '[r2-r1]', d: '{r2-r1}' });
    expect(c.cell('a').toFixed(2)).toBe('0.00');
    expect(c.cell('b').toFixed(2)).toBe('-3.00');
    expect(c.cell('c').toFixed(2)).toBe('3.00');
    expect(c.cell('d').toFixed(2)).toBe('0.00');
  });
  it('cell references are case-insensitive and cached', () => {
    const c = calc({ r3: 'dt(601)', r4: 'dt(602)', r2: 'R3+r4' });
    expect(c.cell('r2').toFixed(2)).toBe('12475.50');
    expect(c.cell('R2').toFixed(2)).toBe('12475.50');
  });
  it('profit and loss clamps are mirrored (9.7)', () => {
    const f = { r40: 'ct(70*)', r17: 'dt(60*)', r49: '0', r23: '0', r24: '[r49+r40-r23-r17]', r50: '[r23+r17-r49-r40]' };
    const c = calc(f);
    expect(c.cell('r24').toFixed(2)).toBe('0.00');
    expect(c.cell('r50').toFixed(2)).toBe('11475.50');
  });
  it('parentheses group in verification expressions', () => {
    const c = calc({ k1: '3', k2: '4', b1: '10' });
    expect(c.expression('b1-(k1+k2)').toFixed(2)).toBe('3.00');
    expect(c.expression('B1CP-(K1CP+K2CP)').toFixed(2)).toBe('3.00');
  });
  it('the function-less pair of k6 evaluates as ac and is reported', () => {
    const c = calc({ k6: 'ac(426,101)+(70*,21*)' });
    expect(c.cell('k6').toFixed(2)).toBe('50.00');
    expect(c.issues.map((i) => i.message)[0]).toMatch(/ac\(70\*,21\*\)/);
  });
  it('replaces the separator placeholder', () => {
    const data: FormulaDataSet = { accounts: [{ number: '453.1', od: '0', oc: '0', dt: '5', ct: '0' }], correspondences: [] };
    const c = new FormulaCalculator({ formulas: { x: 'dt(453\\1)' }, data: () => data, separator: '.' });
    expect(c.cell('x').toFixed(2)).toBe('5.00');
  });
  it('reports unknown keys and empty formulas, value 0', () => {
    const c = calc({ a: 'r999+1', e: '  ' });
    expect(c.cell('a').toFixed(2)).toBe('1.00');
    expect(c.cell('e').toFixed(2)).toBe('0.00');
    expect(c.issues.map((i) => i.message)).toEqual(['Непозната формула : r999', 'Не е въведена формула!']);
    expect(c.cell('zzz').toFixed(2)).toBe('0.00');
  });
  it('stops circular references with one message', () => {
    const c = calc({ a: 'b+1', b: 'a+1', z: 'a' });
    expect(c.cell('a').toFixed(2)).toBe('2.00');
    c.cell('z');
    expect(c.circular).toBe(true);
    expect(c.issues.filter((i) => /кръгова/.test(i.message))).toHaveLength(1);
  });
  it('the loop guard caps evaluations at 1 000', () => {
    const big = Array.from({ length: 1200 }, () => '1').join('+');
    const c = calc({ a: big });
    expect(c.cell('a').toFixed(0)).toBe('999');
    expect(c.circular).toBe(true);
  });
});

describe('periods (cp / ep, 9.2, 9.6)', () => {
  const prev: FormulaDataSet = { accounts: [{ number: '501', od: '0', oc: '0', dt: '195.583', ct: '0' }], correspondences: [] };
  it('ep suffix evaluates in the previous period; nested refs follow', () => {
    const c = calc({ b45: 'fdb(501)', b44: 'b45', x: 'b44ep' }, {}, prev);
    expect(c.cell('b44').toFixed(2)).toBe('850.00');
    expect(c.cell('b44', 'ep').toFixed(3)).toBe('195.583');
    expect(c.cell('x').toFixed(3)).toBe('195.583');
  });
  it('2026 previous-period values are divided by 1.95583 once', () => {
    const c = calc({ b45: 'fdb(501)', b44: 'b45', x: 'b44ep+0' }, { convertPrevious: true }, prev);
    expect(c.cell('b44', 'ep').toFixed(2)).toBe('100.00');
    expect(c.cell('x').toFixed(2)).toBe('100.00');
    expect(c.cell('b44').toFixed(2)).toBe('850.00');
  });
  it('stored previous-period values replace the computation', () => {
    const c = calc({ b45: 'fdb(501)', b44: 'b45' }, { usePreviousPeriodValues: true, lastPeriodValues: { b44: '777.5' }, convertPrevious: true }, prev);
    expect(c.cell('b44', 'ep').toFixed(2)).toBe('777.50');
    expect(c.cell('b45', 'ep').toFixed(2)).toBe('0.00');
  });
  it('the whole previous financial year by default', () => {
    const fy = (y: number) => (y >= 2024 ? `${y}-01-01` : null);
    expect(statementPeriods({ start: '2026-01-01', end: '2026-12-31', fyStart: fy })).toEqual({
      cp: { start: '2026-01-01', end: '2026-12-31' }, ep: { start: '2025-01-01', end: '2025-12-31' }, convertPrevious: true,
    });
    // Previous year without a financial-year row: 1 January.
    expect(statementPeriods({ start: '2024-03-01', end: '2024-06-30', fyStart: fy }).ep).toEqual({ start: '2023-01-01', end: '2023-12-31' });
  });
  it('the same interval of the previous year, with the leap-day rule', () => {
    const fy = (y: number) => `${y}-01-01`;
    expect(statementPeriods({ start: '2025-01-01', end: '2025-02-28', sameIntervalPreviousYear: true, fyStart: fy }).ep).toEqual({ start: '2024-01-01', end: '2024-02-29' });
    expect(statementPeriods({ start: '2026-04-01', end: '2026-06-30', sameIntervalPreviousYear: true, fyStart: fy }).ep).toEqual({ start: '2025-04-01', end: '2025-06-30' });
  });
  it('clamps a start before the financial-year start', () => {
    const r = statementPeriods({ start: '2025-12-01', end: '2026-03-31', fyStart: (y) => (y === 2025 ? '2025-12-15' : `${y}-01-01`) });
    expect(r.cp.start).toBe('2025-12-15');
    expect(r.convertPrevious).toBe(false);
  });
  it('in thousands rounds half away from zero', () => {
    expect(toThousands('12400.50').toFixed(0)).toBe('12');
    expect(toThousands('1500').toFixed(0)).toBe('2');
    expect(toThousands('-1500').toFixed(0)).toBe('-2');
    expect(toThousands('499.99').toFixed(0)).toBe('0');
  });
  it('unit labels by end year', () => {
    expect(statementUnit(2026, false)).toBe('евро');
    expect(statementUnit(2026, true)).toBe('хил. евро');
    expect(statementUnit(2025, false)).toBe('лв.');
    expect(statementUnit(2025, true)).toBe('хил. лв.');
  });
});

describe('statement seed and layout (9.3)', () => {
  const seed = buildStatementSeed();
  it('has 898 formulas, 289 rows and 36 columns', () => {
    expect(seed.formulas).toHaveLength(898);
    expect(seed.rows).toHaveLength(289);
    expect(seed.columns).toHaveLength(36);
    const count = (p: string) => seed.formulas.filter((f) => statementOfKey(f.key)?.prefix === p).length;
    expect([count('r'), count('p'), count('b'), count('k'), count('s'), count('cr')]).toEqual([65, 56, 151, 198, 425, 3]);
    expect(new Set(seed.formulas.map((f) => f.key.toLowerCase())).size).toBe(898);
  });
  it('keeps the seed verbatim', () => {
    const byKey = new Map(seed.formulas.map((f) => [f.key, f]));
    expect(byKey.get('r33')!.formula).toBe('ct(701)-ac(123,701)');
    expect(byKey.get('b131')!.formula).toBe('fdb(503)+fdb(504)');
    expect(byKey.get('p10')!.formula).toBe('ac(50*,269)-ac(50*,229)');
    expect(byKey.get('k6')!.formula).toBe('ac(426,101)+ac(31*,101)+(30*,101)+ac(50*,101)+ac(22*,101)+ac(21*,101)+ac(20*,101)');
    expect(seed.rows.find((r) => r.identifier === 'OPRRow1')!.description).toBe('1. Намаление на запасите от продукция и незавършено производство');
  });
  it('groups cells of one printed row (ОПП, ОСК, СДА)', () => {
    const row = (key: string) => seed.formulas.find((f) => f.key === key)!.rowIdentifier;
    expect(row('p1')).toBe(row('p28'));
    expect(row('p26')).toBe(row('p55'));
    expect(row('p5')).not.toBe(row('p14'));
    expect(row('k1')).toBe(row('k181'));
    expect(row('s1')).toBe(row('s309'));
    expect(seed.rows.filter((r) => r.statement === 'osk')).toHaveLength(18);
    expect(seed.rows.filter((r) => r.statement === 'sda')).toHaveLength(25);
  });
  it('lays out headings and moves the nominal-value rows', () => {
    const rows = seed.rows.filter((r) => r.statement === 'balance');
    const cells = seed.formulas.filter((f) => statementOfKey(f.key)?.code === 'balance');
    const layout = statementLayout('balance', rows, cells);
    const keys = layout.map((r) => Object.values(r.cells)[0]!.key);
    expect(keys.indexOf('b20a')).toBe(keys.indexOf('b20') + 1);
    expect(keys.indexOf('b41a')).toBe(keys.indexOf('b41') + 1);
    expect(layout.find((r) => r.cells.BalansCol1?.key === 'b2')!.headings).toEqual(['Б. НЕТЕКУЩИ (ДЪЛГОТРАЙНИ) АКТИВИ', 'I. Нематериални активи']);
    expect(layout.find((r) => r.cells.BalansCol1?.key === 'b50')!.bold).toBe(true);
  });
  it('verification checks reference seeded cells only', () => {
    const keys = new Set(seed.formulas.map((f) => f.key.toLowerCase()));
    for (const c of STATEMENT_CHECKS) for (const f of c.formulas) expect(validateFormula(f, (k) => keys.has(k)), f).toBeNull();
  });
});
