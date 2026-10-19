import { describe, expect, it } from 'vitest';
import { FormulaCalculator, STATEMENT_SEED, chartTemplateAccounts, formulaAccountMatches, templateLevel, type TemplateAccount } from '../src/index.ts';

/**
 * The commercial and ЮЛНЦ chart templates against Delta's seeded statement
 * formulas (seeds/statements.ts): every account a user can post to in classes
 * 1-5 must land in the balance sheet, and the depreciation analytics must mean
 * what the balance sheet and the СДА assume (241/n = depreciation of 20n,
 * 242/n = amortisation of 21n).
 */

type Type = 'commercial' | 'nonProfit';
const TYPES: Type[] = ['commercial', 'nonProfit'];

const BALANCE = STATEMENT_SEED['Баланс']!.filter(([key]) => key.startsWith('b'));
const argsOf = (cells: readonly (readonly string[])[], fn: RegExp) => [...new Set(cells.flatMap((c) => [...c[3]!.matchAll(fn)].map((m) => m[1]!)))];
/** Account arguments of the balance-sheet fdb/fcb cells. */
const BALANCE_ACCOUNTS = argsOf(BALANCE, /\bf[dc]b\(([^)]+)\)/g);
/** Every account argument of every seeded statement. */
const STATEMENT_ACCOUNTS = argsOf(Object.values(STATEMENT_SEED).flat(), /\b(?:idb|icb|fdb|fcb|dt|ct)\(([^)]+)\)/g);

/** Postable (leaf) accounts of classes 1-5, below the group level. */
function postable(type: Type): TemplateAccount[] {
  const accs = chartTemplateAccounts(type);
  const byNumber = new Map(accs.map((a) => [a.number, a]));
  const parents = new Set(accs.map((a) => a.parentNumber));
  return accs.filter((a) => !parents.has(a.number) && /^[1-5]/.test(a.number) && templateLevel(a, byNumber) >= 4);
}

/**
 * Accounts that by nature are always zero at the period end, so no balance
 * cell needs to read them.
 */
const ALWAYS_ZERO: Record<Type, string[]> = {
  // Вътрешни разчети: settlements between units of the same entity. Both legs
  // are booked in this one chart, so the account nets to zero at the period end.
  commercial: ['430'],
  nonProfit: [],
};

/**
 * Sides of an account (D = debit balance, C = credit balance) that Delta's
 * seeded balance sheet reads on one side only. The rows are not "0" in Delta,
 * so they are kept as seeded (see seeds/statements.ts for the deviations).
 */
const ONE_SIDED: Record<Type, string[]> = {
  commercial: [
    '415D', // b31 lists 411/412/414/419 and b33 416; 415 is read only by fcb(41*) in b75.
    '441C', '442C', '443C', '445C', // 441-445 are read only by fdb() in b37 (no liability cell).
  ],
  nonProfit: ['443C', '445C'],
};

describe('chart templates against the seeded balance sheet', () => {
  it.each(TYPES)('%s: every postable account of classes 1-5 is read by a balance-sheet cell', (type) => {
    const missing = postable(type)
      .filter((a) => !ALWAYS_ZERO[type].includes(a.number))
      .filter((a) => !BALANCE_ACCOUNTS.some((arg) => formulaAccountMatches(a.number, arg)))
      .map((a) => a.number);
    expect(missing).toEqual([]);
    // The exclusions are real postable accounts.
    for (const n of ALWAYS_ZERO[type]) expect(postable(type).some((a) => a.number === n), n).toBe(true);
  });

  it.each(TYPES)('%s: a balance on any postable account keeps assets equal to liabilities', (type) => {
    const formulas = Object.fromEntries(STATEMENT_SEED['Баланс']!.map(([key, , , formula]) => [key, formula]));
    const unbalanced: string[] = [];
    for (const a of postable(type)) {
      if (ALWAYS_ZERO[type].includes(a.number)) continue;
      const sides: ('D' | 'C')[] = a.isActive === true ? ['D'] : a.isActive === false ? ['C'] : ['D', 'C'];
      for (const side of sides) {
        // The account against the current result (123), as after closing the period.
        const [d, c] = side === 'D' ? ['100', '0'] : ['0', '100'];
        const accounts = [{ number: a.number, od: d, oc: c, dt: '0', ct: '0' }, { number: '123', od: c, oc: d, dt: '0', ct: '0' }];
        const calc = new FormulaCalculator({ formulas, data: () => ({ accounts, correspondences: [] }) });
        if (!calc.cell('b50').equals(calc.cell('b108'))) unbalanced.push(a.number + side);
      }
    }
    expect(unbalanced).toEqual(ONE_SIDED[type]);
  });

  it.each(TYPES)('%s: 241/n is the depreciation of 20n and 242/n the amortisation of 21n', (type) => {
    const numbers = new Set(chartTemplateAccounts(type).map((a) => a.number));
    const used = STATEMENT_ACCOUNTS.filter((n) => /^24[12]\/\d$/.test(n));
    expect(used.filter((n) => n.startsWith('241/')).sort()).toEqual(['241/3', '241/4', '241/5', '241/6', '241/7', '241/8', '241/9']);
    // Every 241/n the statements read has its asset account 20n.
    for (const n of used.filter((x) => x.startsWith('241/'))) expect(numbers.has(`20${n.slice(4)}`), `${type} ${n}`).toBe(true);
    // Every depreciation analytic of the template is read by the statements and has its asset account.
    const analytics = [...numbers].filter((n) => /^24[12]\//.test(n));
    expect(analytics.length).toBeGreaterThan(7);
    for (const n of analytics) {
      expect(used, `${type} ${n}`).toContain(n);
      expect(numbers.has(`${n.startsWith('241/') ? '20' : '21'}${n.slice(4)}`), `${type} ${n}`).toBe(true);
    }
    expect(numbers.has('241')).toBe(true);
    expect(numbers.has('241/1') || numbers.has('241/2')).toBe(false);
  });

  it('the row captions name what the template accounts are', () => {
    const c = new Map(chartTemplateAccounts('commercial').map((a) => [a.number, a.description]));
    const formula = (key: string) => BALANCE.find(([k]) => k === key)![3];
    expect(formula('b8')).toBe('fdb(201)+fdb(202)');
    expect([c.get('201'), c.get('202')]).toEqual(['Земи (терени)', 'Подобрения върху земи']);
    expect(formula('b9')).toBe('fdb(203)-fcb(241/3)');
    expect([c.get('203'), c.get('241/3')]).toEqual(['Сгради и конструкции', 'Амортизация на сгради и конструкции']);
    expect(formula('b10')).toBe('fdb(206)-fcb(241/6)');
    expect([c.get('206'), c.get('241/6')]).toEqual(['Машини, производствено оборудване и апаратура', 'Амортизация на машини, производствено оборудване и апаратура']);
    expect(formula('b2')).toBe('fdb(211)-fcb(242/1)');
    expect(c.get('211')).toBe('Продукти от развойна дейност');
    expect(c.get('231')).toBe('Положителна търговска репутация');
    expect(c.get('105')).toBe('Премии от емисии');
    expect(c.get('512')).toBe('Изкупени собствени акции');
  });
});
