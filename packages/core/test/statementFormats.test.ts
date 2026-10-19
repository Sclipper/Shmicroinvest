import { describe, expect, it } from 'vitest';
import {
  ABBREVIATED_BALANCE, ABBREVIATED_OPR, ABBREVIATED_STATEMENTS, FORMAT_2015, FormulaCalculator, GFO_MICRO, STATEMENT_CAPTIONS_EN, STATEMENT_CHECKS,
  STATEMENT_COLUMNS, STATEMENT_COLUMNS_EN, STATEMENT_HEADINGS, STATEMENT_TITLES_EN, STATEMENTS, aggregationKeys, applyStatementFormat,
  buildStatementSeed, captionEn, dec, statementLayout, statementOfKey, statementUnitEn, validateFormula, type AbbreviatedLine, type FormulaDataSet,
  type FormulaPeriod,
} from '../src/index.ts';

const seed = buildStatementSeed();
const keys = new Set(seed.formulas.map((f) => f.key.toLowerCase()));
const formulas = Object.fromEntries(seed.formulas.map((f) => [f.key, f.formula]));

const acc = (number: string, od = 0, oc = 0, dt = 0, ct = 0) => ({ number, od: String(od), oc: String(oc), dt: String(dt), ct: String(ct) });

/** A year with a profit and every balance-sheet section filled (current period). */
const PROFIT: FormulaDataSet = {
  accounts: [
    acc('201', 5000), acc('203', 20000), acc('241/3', 0, 4000, 0, 1000), acc('211', 1500), acc('242/1', 0, 300), acc('231', 600),
    acc('221', 700), acc('224', 800), acc('261', 300), acc('496', 150), acc('613', 0, 0, 900, 0),
    acc('302', 1200, 0, 500, 300), acc('303', 400, 0, 600, 300), acc('304', 3000, 0, 2000, 2500), acc('301', 100), acc('611', 0, 0, 200, 50),
    acc('411', 2500, 0, 6000, 5000), acc('416', 90), acc('453/1', 0, 0, 200, 0), acc('422', 60), acc('512', 50), acc('511', 220),
    acc('501', 1000, 0, 4000, 3500), acc('503', 2000, 0, 5000, 4500), acc('508', 40), acc('651', 90), acc('426', 30),
    acc('101', 0, 10000), acc('105', 0, 500), acc('111', 0, 300), acc('112', 0, 200), acc('119', 0, 70), acc('122', 0, 1500), acc('121', 400),
    acc('123', 0, 0, 1000, 3000), acc('151', 0, 1200), acc('152', 0, 2000), acc('153', 0, 500), acc('412', 0, 350),
    acc('401', 0, 1500, 3000, 3500), acc('421', 0, 0, 800, 1000), acc('454', 0, 0, 0, 150), acc('461', 0, 0, 0, 120), acc('753', 0, 100), acc('751', 0, 80),
    acc('601', 0, 0, 800), acc('602', 0, 0, 900), acc('603', 0, 0, 700), acc('631', 0, 0, 60), acc('604', 0, 0, 1200), acc('605', 0, 0, 250),
    acc('607', 0, 0, 30), acc('609', 0, 0, 50), acc('621', 0, 0, 80), acc('623', 0, 0, 15), acc('624', 0, 0, 30),
    acc('701', 0, 0, 0, 2000), acc('702', 0, 0, 0, 5000), acc('703', 0, 0, 0, 1200), acc('704', 0, 0, 0, 90), acc('709', 0, 0, 0, 100),
    acc('722', 0, 0, 25, 0), acc('724', 0, 0, 0, 40), acc('721', 0, 0, 0, 10), acc('729', 0, 0, 0, 20),
  ],
  correspondences: [
    { debit: '702', credit: '304', amount: '2500' },
    { debit: '703', credit: '211', amount: '120' },
    { debit: '613', credit: '602', amount: '300' },
    { debit: '123', credit: '454', amount: '150' },
    { debit: '123', credit: '459', amount: '35' },
  ],
};

/** A loss year (previous period): the expenses exceed the income. */
const LOSS: FormulaDataSet = {
  accounts: [
    acc('203', 9000), acc('304', 500, 0, 0, 300), acc('411', 400), acc('501', 300, 0, 0, 200), acc('101', 0, 5000), acc('121', 1200),
    acc('123', 0, 0, 2500, 0), acc('401', 0, 2500), acc('152', 0, 3000), acc('305', 900, 0, 0, 600),
    acc('602', 0, 0, 20000), acc('604', 0, 0, 1000), acc('621', 0, 0, 300), acc('702', 0, 0, 0, 2000), acc('729', 0, 0, 0, 5),
  ],
  correspondences: [{ debit: '702', credit: '304', amount: '300' }],
};

const calc = new FormulaCalculator({ formulas, data: (p) => (p === 'cp' ? PROFIT : LOSS) });

function check(lines: readonly Omit<AbbreviatedLine, 'column'>[], period: FormulaPeriod) {
  const value = new Map(lines.map((l) => [l.code, calc.expression(l.expr, period)]));
  for (const l of lines.filter((x) => x.parts)) {
    const sum = l.parts!.reduce((s, p) => (p.startsWith('-') ? s.minus(value.get(p.slice(1))!) : s.plus(value.get(p)!)), dec(0));
    expect(sum.toFixed(6), `${l.code} = ${l.parts!.join(' + ')} (${period})`).toBe(value.get(l.code)!.toFixed(6));
  }
  return value;
}

describe('abbreviated statements (Експорт на съкратени отчети)', () => {
  it('are aggregations of seeded national cells only', () => {
    const all = [...ABBREVIATED_STATEMENTS.flatMap((d) => d.lines), ...GFO_MICRO.flatMap((s) => s.lines)];
    for (const l of all) {
      expect(validateFormula(l.expr, (k) => keys.has(k)), `${l.code}: ${l.expr}`).toBeNull();
      for (const k of aggregationKeys(l.expr)) expect(keys.has(k), `${l.code}: ${k}`).toBe(true);
    }
    expect(new Set(all.map((l) => l.code)).size).toBe(all.length);
    for (const d of ABBREVIATED_STATEMENTS) for (const l of d.lines) expect(aggregationKeys(l.expr).every((k) => statementOfKey(k)?.code === d.code), l.code).toBe(true);
    for (const l of all) for (const p of l.parts ?? []) expect(all.some((x) => x.code === p.replace(/^-/, '')), p).toBe(true);
  });

  it('the abbreviated balance adds up to the full balance sheet (both periods)', () => {
    for (const period of ['cp', 'ep'] as const) {
      const v = check(ABBREVIATED_BALANCE.lines, period);
      expect(v.get('sb14')!.toFixed(2)).toBe(calc.cell('b50', period).toFixed(2));
      expect(v.get('sb27')!.toFixed(2)).toBe(calc.cell('b108', period).toFixed(2));
      expect(v.get('sb21')!.toFixed(2)).toBe(calc.cell('b63', period).toFixed(2));
      // Every group of the full balance is in exactly one abbreviated line.
      const groups = ['b1', 'b6', 'b13', 'b21', 'b30', 'b39', 'b43', 'b47', 'b49'];
      expect(groups.reduce((s, k) => s.plus(calc.cell(k, period)), dec(0)).toFixed(2)).toBe(v.get('sb14')!.toFixed(2));
    }
    // The profit year has non-zero figures in every group of the asset side.
    for (const code of ['sb2', 'sb3', 'sb4', 'sb7', 'sb8', 'sb10', 'sb11', 'sb13', 'sb15', 'sb23']) {
      expect(calc.expression(ABBREVIATED_BALANCE.lines.find((l) => l.code === code)!.expr).isZero(), code).toBe(false);
    }
  });

  it('the abbreviated income statement adds up to the full ОПР (profit and loss year)', () => {
    const cp = check(ABBREVIATED_OPR.lines, 'cp');
    expect(cp.get('sr12')!.toFixed(2)).toBe(calc.cell('r31').toFixed(2));
    expect(cp.get('sr22')!.toFixed(2)).toBe(calc.cell('r55').toFixed(2));
    expect(cp.get('sr11')!.isPositive() && !cp.get('sr11')!.isZero()).toBe(true);
    expect(cp.get('sr21')!.isZero()).toBe(true);
    const ep = check(ABBREVIATED_OPR.lines, 'ep');
    expect(ep.get('sr11')!.isZero()).toBe(true);
    expect(ep.get('sr21')!.toFixed(2)).toBe(calc.cell('r54', 'ep').toFixed(2));
    // Expenses 600 (decrease of 305) + 20 000 + 1 000 + 300 (cost of goods sold) + 300 interest; income 2 000 + 5.
    expect(ep.get('sr21')!.toFixed(2)).toBe('20195.00');
    // Both sides of the two-sided form are equal ("Всичко").
    for (const v of [cp, ep]) expect(v.get('sr12')!.toFixed(2)).toBe(v.get('sr22')!.toFixed(2));
  });

  it('ГФО Микро adds up and its result equals the ОПР result', () => {
    for (const period of ['cp', 'ep'] as const) {
      const lines = GFO_MICRO.flatMap((s) => s.lines);
      const v = check(lines, period);
      expect(v.get('m08')!.toFixed(2)).toBe(calc.cell('b50', period).toFixed(2));
      expect(v.get('m19')!.toFixed(2)).toBe(calc.cell('b108', period).toFixed(2));
      expect(v.get('m32')!.toFixed(2)).toBe(calc.cell('r30', period).minus(calc.cell('r54', period)).toFixed(2));
    }
    expect(calc.expression('r30-r54', 'ep').isNegative()).toBe(true);
  });
});

describe('the 2015 forms', () => {
  const layout = (code: 'balance' | 'opr') => statementLayout(code, seed.rows.filter((r) => r.statement === code), seed.formulas.filter((f) => statementOfKey(f.key)?.code === code));
  it('hide the extraordinary and ordinary-activity rows and renumber the result lines', () => {
    const full = layout('opr');
    const f2015 = applyStatementFormat(full, 'f2015');
    expect(f2015).toHaveLength(full.length - FORMAT_2015.hidden.size);
    const label = (key: string) => f2015.find((r) => Object.values(r.cells).some((c) => c.key === key))?.description;
    expect(label('r24')).toBeUndefined();
    expect(label('r25')).toBeUndefined();
    expect(label('r27')).toBe('8. Счетоводна печалба (общо приходи - общо разходи)');
    expect(label('r30')).toBe('11. Печалба (8-9-10)');
    expect(label('r33')).toBe('а) продукция');
    expect(applyStatementFormat(full, 'national')).toBe(full);
    // The hidden cells are not part of any printed total (the seeded totals already leave them out).
    for (const f of seed.formulas.filter((x) => !FORMAT_2015.hidden.has(x.key))) {
      for (const h of FORMAT_2015.hidden) expect(new RegExp(`\\b${h}\\b`).test(f.formula), `${f.key} uses ${h}`).toBe(false);
    }
  });
  it('relabel the associated undertakings in the balance sheet', () => {
    const b = applyStatementFormat(layout('balance'), 'f2015');
    expect(b).toHaveLength(layout('balance').length);
    expect(b.find((r) => r.cells.BalansCol1?.key === 'b16')!.description).toBe('3. Акции и дялове в асоциирани предприятия');
    for (const k of Object.keys(FORMAT_2015.labels)) expect(keys.has(k), k).toBe(true);
  });
});

describe('English statements', () => {
  it('translate every seeded caption, heading, column and title', () => {
    for (const r of seed.rows) expect(captionEn(r.description), r.description).not.toBe(r.description);
    for (const hs of Object.values(STATEMENT_HEADINGS)) for (const h of hs) expect(STATEMENT_CAPTIONS_EN[h], h).toBeTruthy();
    for (const l of Object.values(FORMAT_2015.labels)) expect(captionEn(l), l).not.toBe(l);
    for (const c of STATEMENT_COLUMNS) expect(STATEMENT_COLUMNS_EN[c.identifier], c.identifier).toBeTruthy();
    for (const s of STATEMENTS) expect(STATEMENT_TITLES_EN[s.code].title).toBeTruthy();
    expect(captionEn('Сума на актива (А+Б+В+Г)')).toBe('Total assets (A+B+C+D)');
    expect(captionEn('Непознат ред')).toBe('Непознат ред');
    expect(statementUnitEn(2026, true)).toBe('thousand EUR');
    expect(statementUnitEn(2025, false)).toBe('BGN');
  });
});

describe('previous-year checks (_2)', () => {
  it('mirror the current-year checks over the EP cells', () => {
    const byId = new Map(STATEMENT_CHECKS.map((c) => [c.id, c]));
    const previous = STATEMENT_CHECKS.filter((c) => c.id.endsWith('_2'));
    expect(previous.map((c) => c.id)).toEqual(['balance_2', 'result_2', 'cash_2', 'equity_2', 'equity_result_2', 'capital_2', 'premium_2', 'revaluation_2', 'reserves_2', 'profit_2']);
    for (const c of previous) {
      const cur = byId.get(c.id.slice(0, -2))!;
      expect(c.formulas).toEqual(cur.formulas.map((f) => f.replace(/CP\b/g, 'EP')));
      expect(c.message).toContain('(предходна година)');
      for (const f of c.formulas) expect(validateFormula(f, (k) => keys.has(k)), f).toBeNull();
    }
    expect(byId.get('reserves_2')!.formulas).toEqual(['B58EP-(K70EP+K88EP+K106EP+K124EP)']);
    expect(byId.get('cash_2')!.severity).toBe('warning');
  });
});
