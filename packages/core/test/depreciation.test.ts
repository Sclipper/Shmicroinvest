import { describe, expect, it } from 'vitest';
import {
  canApplyConservation, planMainDifferences, changeRateFrom, checkImprovement, computeRevaluation, convertScheduleToEur, costAt, dec,
  deriveMethod, DEPRECIATION_METHOD, endOfMonth, firstEditableMonthDate, firstScheduledMonth, generateSchedule,
  isStartMonthIncluded, maxRateForCategory, monthsBetween, monthsFromRate, pendingDefaultPeriod, postingReference,
  rateFromMonths, rateSelection, redistributeYear, revaluationPrefill, sum, accountingLastProcessedDate,
  taxLastProcessedDate, terminateDefaults, terminationLines, TERMINATION, toEur, validateCommonPercent, validatePlan,
  validPercentage, yearPlans, type PlanParams, type ScheduleRow,
} from '../src/index.ts';

const amounts = (rows: { amount: { toFixed: (n: number) => string } }[]) => rows.map((r) => r.amount.toFixed(2));
const total = (rows: { amount: Parameters<typeof dec>[0] }[]) => sum(rows.map((r) => r.amount)).toFixed(2);
const yearSum = (rows: { month: string; amount: Parameters<typeof dec>[0] }[], y: number) => sum(rows.filter((r) => r.month.startsWith(`${y}-`)).map((r) => r.amount)).toFixed(2);
const sap = (o: Partial<PlanParams>): PlanParams => ({ isAccounting: true, startMonthIncluded: false, depreciableAmount: 0, startDate: '2025-01-01', activePeriodLength: 0, ...o });
const dap = (o: Partial<PlanParams>): PlanParams => ({ isAccounting: false, startMonthIncluded: true, depreciableAmount: 0, startDate: '2025-01-01', activePeriodLength: 0, ...o });

/** Plan A (5.5 A): 12 000.00 / 60 months, commissioned 15.03.2025. */
const planA = (o: Partial<PlanParams> = {}) => generateSchedule(sap({ depreciableAmount: '12000', startDate: '2025-03-15', activePeriodLength: 60, ...o }));

describe('rates and useful life (03b 3)', () => {
  it('converts rate to months with banker\'s rounding (3.2 examples)', () => {
    expect([4, 10, 15, 20, 25, 30, 50].map(monthsFromRate)).toEqual([300, 120, 80, 60, 48, 40, 24]);
    expect(monthsFromRate(0)).toBe(0);
    expect(monthsFromRate('33.333333333333333333333333333')).toBe(36);
  });
  it('converts months to rate at full precision', () => {
    expect(rateFromMonths(60).toString()).toBe('20');
    expect(rateFromMonths(36).toFixed(10)).toBe('33.3333333333');
    expect(rateFromMonths(0).toString()).toBe('0');
  });
  it('has the ЗКПО maximum per category (3.1)', () => {
    expect([1, 2, 3, 4, 5, 7, 8].map((c) => maxRateForCategory(c).toString())).toEqual(['4', '30', '10', '50', '25', '15', '0']);
    expect(maxRateForCategory(6).toFixed(4)).toBe('33.3333');
    expect(maxRateForCategory(null).toString()).toBe('50');
  });
  it('maps a rate to the combo selection', () => {
    expect(rateSelection(0)).toBe(0);
    expect(rateSelection(30)).toBe(30);
    expect(rateSelection('33.33')).toBe(-1);
  });
});

describe('start-month rule (03b 5.3)', () => {
  it('САП starts the month after commissioning; unsynchronised ДАП in the month itself', () => {
    expect(isStartMonthIncluded(true, false)).toBe(false);
    expect(isStartMonthIncluded(false, false)).toBe(true);
    expect(isStartMonthIncluded(false, true)).toBe(false);
    expect(firstScheduledMonth('2025-03-15', false)).toBe('2025-04-01');
    expect(firstScheduledMonth('2025-03-15', true)).toBe('2025-03-01');
    // No day proration: the 1st and the 31st give the same month.
    expect(firstScheduledMonth('2025-03-01', false)).toBe(firstScheduledMonth('2025-03-31', false));
  });
  it('monthsBetween ignores the day', () => {
    expect(monthsBetween('2026-06-30', '2025-03-15')).toBe(15);
    expect(monthsBetween('2025-03-01', '2025-03-31')).toBe(0);
  });
});

describe('schedule generation (03b 5.4/5.5)', () => {
  it('A: 12 000 / 60 from April 2025 (acceptance 1)', () => {
    const g = planA();
    expect(g.rows).toHaveLength(60);
    expect(g.rows[0]!.month).toBe('2025-04-01');
    expect(g.rows[0]!.amount.toFixed(2)).toBe('200.00');
    expect(yearSum(g.rows, 2025)).toBe('1800.00');
    for (const y of [2026, 2027, 2028, 2029]) expect(yearSum(g.rows, y)).toBe('2400.00');
    expect(yearSum(g.rows, 2030)).toBe('600.00');
    expect(g.endDate).toBe('2030-03-01');
    expect(total(g.rows)).toBe('12000.00');
    const plans = yearPlans(g.rows, g.base);
    expect(plans.map((p) => p.percentage.toFixed(2))).toEqual(['20.00', '20.00', '20.00', '20.00', '20.00', '20.00']);
    expect(deriveMethod(plans)).toBe(DEPRECIATION_METHOD.Linear);
  });

  it('acceptance 2: the tax plan starts in March unsynchronised, April synchronised', () => {
    expect(generateSchedule(dap({ depreciableAmount: '12000', startDate: '2025-03-15', activePeriodLength: 60 })).rows[0]!.month).toBe('2025-03-01');
    expect(generateSchedule(dap({ startMonthIncluded: false, depreciableAmount: '12000', startDate: '2025-03-15', activePeriodLength: 60 })).rows[0]!.month).toBe('2025-04-01');
  });

  it('B: truncation, remainder in the last month, method Custom (acceptance 3)', () => {
    const g = generateSchedule(sap({ depreciableAmount: '1000', startDate: '2025-01-10', activePeriodLength: 36 }));
    expect(g.rows).toHaveLength(36);
    expect(g.rows[0]!.month).toBe('2025-02-01');
    expect(g.rows.slice(0, 35).every((r) => r.amount.toFixed(2) === '27.77')).toBe(true);
    expect(g.rows[35]!.month).toBe('2028-01-01');
    expect(g.rows[35]!.amount.toFixed(2)).toBe('28.05');
    expect(total(g.rows)).toBe('1000.00');
    expect(g.endDate).toBe('2028-01-01');
    const plans = yearPlans(g.rows, g.base);
    expect(plans.map((p) => p.amount.toFixed(2))).toEqual(['305.47', '333.24', '333.24', '28.05']);
    expect(plans.map((p) => p.percentage.toFixed(3))).toEqual(['33.324', '33.324', '33.324', '33.660']);
    expect(deriveMethod(plans)).toBe(DEPRECIATION_METHOD.Custom);
  });

  it('B′: tax plan, category VI, January commissioning: non-blocking cap warning on 2027', () => {
    const g = generateSchedule(dap({ depreciableAmount: '1000', startDate: '2025-01-10', activePeriodLength: 36 }));
    expect(g.rows[0]!.month).toBe('2025-01-01');
    expect(g.rows).toHaveLength(36);
    expect(yearSum(g.rows, 2025)).toBe('333.24');
    expect(yearSum(g.rows, 2026)).toBe('333.24');
    expect(yearSum(g.rows, 2027)).toBe('333.52');
    const plans = yearPlans(g.rows, g.base);
    expect(plans[2]!.percentage.toFixed(3)).toBe('33.352');
    const msgs = validatePlan({
      isAccounting: false, notApplied: false, depreciationAmount: '1000', nonDepreciableAmount: 0, acquisitionDate: '2025-01-10', startDate: '2025-01-10',
      endDate: g.endDate, activePeriodLength: 36, lastProcessedDate: '2025-01-10', accrued: 0, rows: g.rows, categoryId: 6, startMonthIncluded: true,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ key: 'strYearPercentageExceedsMaximumAllowed', severity: 'warning' });
    expect(msgs[0]!.text).toContain('Данъчни амортизации:');
    expect(msgs[0]!.text).toContain('(33.33%)');
  });

  it('C: 100.10 over 48 months from January (acceptance 4)', () => {
    const g = generateSchedule(dap({ depreciableAmount: '100.10', startDate: '2025-01-05', activePeriodLength: 48 }));
    expect(g.estimate.toFixed(2)).toBe('2.08');
    expect([2025, 2026, 2027].map((y) => yearSum(g.rows, y))).toEqual(['24.96', '24.96', '24.96']);
    expect(yearSum(g.rows, 2028)).toBe('25.22');
    expect(g.rows[47]!.amount.toFixed(2)).toBe('2.34');
    expect(total(g.rows)).toBe('100.10');
  });

  it('D: САП 60 months vs ДАП 40 months at the 30 % maximum (4.1 table)', () => {
    const s = generateSchedule(sap({ depreciableAmount: '12000', startDate: '2025-03-20', activePeriodLength: 60 }));
    const t = generateSchedule(dap({ depreciableAmount: '12000', startDate: '2025-03-20', activePeriodLength: monthsFromRate(30) }));
    const years = [2025, 2026, 2027, 2028, 2029, 2030];
    expect(years.map((y) => yearSum(s.rows, y))).toEqual(['1800.00', '2400.00', '2400.00', '2400.00', '2400.00', '600.00']);
    expect(years.map((y) => yearSum(t.rows, y))).toEqual(['3000.00', '3600.00', '3600.00', '1800.00', '0.00', '0.00']);
    expect(years.map((y) => dec(yearSum(t.rows, y)).minus(yearSum(s.rows, y)).toFixed(2))).toEqual(['1200.00', '1200.00', '1200.00', '-600.00', '-2400.00', '-600.00']);
    expect(t.rows[t.rows.length - 1]!.month).toBe('2028-06-01');
    expect(total(t.rows)).toBe('12000.00');
  });

  it('D: ДАП rows are always processed; САП rows only up to LP', () => {
    const t = generateSchedule(dap({ depreciableAmount: '12000', startDate: '2025-03-20', activePeriodLength: 40 }));
    expect(t.rows.every((r) => r.isProcessed)).toBe(true);
    const s = planA();
    expect(s.rows.some((r) => r.isProcessed)).toBe(false);
  });

  it('F: re-spread with processed months appends a 0.28 stub month (defect D3, recipe R1)', () => {
    const b = generateSchedule(sap({ depreciableAmount: '1000', startDate: '2025-01-10', activePeriodLength: 36 }));
    const posted = b.rows.slice(0, 5);
    expect(total(posted)).toBe('138.85');
    const g = generateSchedule(sap({
      depreciableAmount: '1000', startDate: '2025-01-10', activePeriodLength: 36,
      lastProcessedDate: '2025-06-30', amountByLastProcessedDate: '138.85', processedMonths: posted,
    }));
    expect(g.rows).toHaveLength(37);
    expect(g.rows[35]!.month).toBe('2028-01-01');
    expect(g.rows[35]!.amount.toFixed(2)).toBe('27.77');
    expect(g.rows[36]!.month).toBe('2028-02-01');
    expect(g.rows[36]!.amount.toFixed(2)).toBe('0.28');
    expect(g.endDate).toBe('2028-02-01');
    expect(total(g.rows)).toBe('1000.00');
    expect(g.rows.filter((r) => r.isProcessed)).toHaveLength(5);
  });

  it('keeps the plan when the accrued amount is exactly on the straight line', () => {
    const g = planA({ lastProcessedDate: '2026-06-30', amountByLastProcessedDate: '3000' });
    expect(g.rows).toHaveLength(60);
    expect(g.endDate).toBe('2030-03-01');
    expect(g.rows.filter((r) => r.isProcessed)).toHaveLength(15);
  });

  it('rebuilds the processed months from the accrued amount when they are not given (plan2)', () => {
    const g = generateSchedule(sap({ depreciableAmount: '1000', startDate: '2025-01-10', activePeriodLength: 36, lastProcessedDate: '2025-06-30', amountByLastProcessedDate: '150' }));
    expect(amounts(g.rows.slice(0, 5))).toEqual(['30.00', '30.00', '30.00', '30.00', '30.00']);
    expect(total(g.rows)).toBe('1000.00');
    // Accrued above the straight line: the excess is taken from the last month (16.90).
    expect(g.rows).toHaveLength(36);
    expect(g.rows[35]!.amount.toFixed(2)).toBe('16.90');
  });

  it('keeps months of locked years and regenerates only the editable tail', () => {
    const g = planA({ depreciableAmount: '13200', firstEditableMonthDate: '2026-01-01', lockedMonths: planA().rows.slice(0, 9) });
    expect(amounts(g.rows.slice(0, 9)).every((a) => a === '200.00')).toBe(true);
    // 13 200 - 1 800 = 11 400 over 51 months.
    expect(g.rows[9]!.amount.toFixed(2)).toBe('223.52');
    expect(total(g.rows)).toBe('13200.00');
    expect(g.endDate).toBe('2030-03-01');
  });

  it('no schedule without a life or an amount', () => {
    expect(generateSchedule(sap({ depreciableAmount: '1000', activePeriodLength: 0 })).rows).toEqual([]);
    const g = generateSchedule(sap({ depreciableAmount: '0', activePeriodLength: 12 }));
    expect(g.rows).toEqual([]);
    expect(g.endDate).toBe('9999-12-31');
  });
});

describe('year edits (03b 5.4)', () => {
  it('redistributes a year amount: Truncate per month, rest in the last month', () => {
    expect(amounts(redistributeYear('1000', 12).map((amount) => ({ amount })))).toEqual([...Array(11).fill('83.33'), '83.37']);
  });
});

describe('validations (03b 3.3, 7)', () => {
  const base = {
    isAccounting: true, notApplied: false, depreciationAmount: '12000', nonDepreciableAmount: '0', acquisitionDate: '2025-03-15', startDate: '2025-03-15',
    endDate: '2030-03-01', activePeriodLength: 60, lastProcessedDate: '2025-03-15', accrued: '0', rows: planA().rows, categoryId: 2, startMonthIncluded: false,
  };
  it('a valid plan has no messages', () => {
    expect(validatePlan(base)).toEqual([]);
  });
  it('acceptance 6: life of 11 months is a Critical error', () => {
    const g = planA({ activePeriodLength: 11 });
    const m = validatePlan({ ...base, activePeriodLength: 11, rows: g.rows, endDate: g.endDate });
    expect(m.find((x) => x.key === 'strAccountingDepreciationInvalidPeriodLength')).toMatchObject({
      severity: 'critical', text: 'Счетоводни амортизации: Полезният срок на годност за актива не може да е по-малък от 12 месеца',
    });
  });
  it('missing life, amount, start date before acquisition, missing schedule', () => {
    const m = validatePlan({ ...base, depreciationAmount: '0', activePeriodLength: null, startDate: '2025-03-01', rows: [] }).map((x) => x.key);
    expect(m).toEqual(expect.arrayContaining(['strAccountingDepreciationAmountIsMissing', 'strAccountingDepreciationInvalidStartDate', 'strAccountingDepreciationPeriodLengthIsMissing', 'strAccountingDepreciationScheduleIsMissing']));
  });
  it('schedule sum must match the cost', () => {
    const rows = planA().rows.slice(0, 59);
    const m = validatePlan({ ...base, rows });
    expect(m[0]).toMatchObject({ key: 'strAccountingDepreciationScheduleSumDoesNotMatchAssetAmount', severity: 'critical' });
    expect(m[0]!.text).toContain('(разлика: 200.00)');
  });
  it('acceptance 5: a 31 % tax year on category II is a warning with limit 30.00, not an error', () => {
    const life = monthsFromRate(31);
    const g = generateSchedule(dap({ depreciableAmount: '12000', startDate: '2025-03-15', activePeriodLength: life }));
    const m = validatePlan({ ...base, isAccounting: false, startMonthIncluded: true, activePeriodLength: life, rows: g.rows, endDate: g.endDate });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ key: 'strYearPercentageExceedsMaximumAllowed', severity: 'warning' });
    expect(m[0]!.text).toContain('(30.00%)');
  });
  it('the accounting plan has no rate cap', () => {
    const g = generateSchedule(sap({ depreciableAmount: '12000', startDate: '2025-03-15', activePeriodLength: 24 }));
    expect(validatePlan({ ...base, activePeriodLength: 24, rows: g.rows, endDate: g.endDate })).toEqual([]);
  });
  it('not applied (land): no life or schedule checks', () => {
    expect(validatePlan({ ...base, notApplied: true, activePeriodLength: 0, rows: [], endDate: '9999-12-31', categoryId: 8 })).toEqual([]);
  });
  it('accrued-to-date checks', () => {
    const keys = (manualAccrued: { date: string | null; amount: string | null }) => validatePlan({ ...base, manualAccrued }).map((x) => x.key);
    expect(keys({ date: null, amount: '100' })).toContain('strAccountingDepreciationNoDateForSumByDate');
    expect(keys({ date: '2025-06-30', amount: '0' })).toContain('strAccountingDepreciationZeroSumByDate');
    expect(keys({ date: '2025-06-30', amount: '20000' })).toContain('strAccountingDepreciationInvalidSumByDate');
    expect(keys({ date: '2025-06-30', amount: '12000' })).toContain('strAccountingDepreciationSumByLastProcessedDateReachedTotal');
    expect(keys({ date: '2025-06-30', amount: '500' })).toContain('strAccountingDepreciationAmountByDateDoesNotMatchSchedule');
    expect(keys({ date: '2025-06-30', amount: '600' })).toEqual([]);
  });
  it('bulk change rejects 0 % and more than 50 %', () => {
    expect(validateCommonPercent(0)!.key).toBe('strPercentageEqualsZero');
    expect(validateCommonPercent(51)!.key).toBe('strPercentageMoreThanFifty');
    expect(validateCommonPercent('33.33')).toBeNull();
  });
});

describe('conservation (03b 10)', () => {
  it('E: 12 months without rows push the end to 01.03.2031 (acceptance 20)', () => {
    const g = planA({ lastProcessedDate: '2026-06-30', amountByLastProcessedDate: '3000', conservation: { start: '2026-07-01', end: '2027-07-01' } });
    expect(g.conservationApplied).toBe(true);
    expect(g.rows).toHaveLength(60);
    expect(g.rows.some((r) => r.month >= '2026-07-01' && r.month < '2027-07-01')).toBe(false);
    expect([2025, 2026, 2027, 2028, 2029, 2030, 2031].map((y) => yearSum(g.rows, y))).toEqual(['1800.00', '1200.00', '1200.00', '2400.00', '2400.00', '2400.00', '600.00']);
    expect(g.endDate).toBe('2031-03-01');
    expect(total(g.rows)).toBe('12000.00');
    expect(canApplyConservation({ conservation: { start: '2026-07-01', end: '2027-07-01' }, lastProcessedDate: '2026-06-30', startDate: '2025-03-15', endDate: g.endDate })).toBe(true);
  });
  it('E′: with nothing posted the window is invalid and ignored', () => {
    const g = planA({ conservation: { start: '2026-07-01', end: '2027-07-01' } });
    expect(g.conservationApplied).toBe(false);
    expect(g.endDate).toBe('2030-03-01');
    const m = validatePlan({
      isAccounting: true, notApplied: false, depreciationAmount: '12000', nonDepreciableAmount: 0, acquisitionDate: '2025-03-15', startDate: '2025-03-15',
      endDate: g.endDate, activePeriodLength: 60, lastProcessedDate: '2025-03-15', accrued: 0, rows: g.rows, conservation: { start: '2026-07-01', end: '2027-07-01' }, startMonthIncluded: false,
    });
    expect(m.map((x) => x.key)).toEqual(['strAccountingDepreciationInvalidConservationPeriod']);
  });
});

describe('improvement (03b 9.1)', () => {
  const posted = planA().rows.slice(0, 9);
  it('path A (IAS dialog): 13 200 over 51 months, end unchanged (acceptance 19)', () => {
    const g = generateSchedule(sap({
      depreciableAmount: '15000', startDate: '2025-03-15', activePeriodLength: 60, iasMode: true,
      lastProcessedDate: '2025-12-31', amountByLastProcessedDate: '1800', processedMonths: posted,
    }));
    expect(g.rows).toHaveLength(60);
    expect(amounts(g.rows.slice(0, 9)).every((a) => a === '200.00')).toBe(true);
    expect(g.rows[9]!.month).toBe('2026-01-01');
    expect(g.rows.slice(9, 59).every((r) => r.amount.toFixed(2) === '258.82')).toBe(true);
    expect(g.rows[59]!.month).toBe('2030-03-01');
    expect(g.rows[59]!.amount.toFixed(2)).toBe('259.00');
    expect(g.endDate).toBe('2030-03-01');
    expect(total(g.rows)).toBe('15000.00');
  });
  it('path B (plan editor): quota 250.00 and two appended rows (acceptance 19)', () => {
    const g = generateSchedule(sap({
      depreciableAmount: '15000', startDate: '2025-03-15', activePeriodLength: 60,
      lastProcessedDate: '2025-12-31', amountByLastProcessedDate: '1800', processedMonths: posted,
    }));
    expect(g.rows).toHaveLength(62);
    expect(amounts(g.rows.slice(0, 9)).every((a) => a === '200.00')).toBe(true);
    expect(g.rows.slice(9, 60).every((r) => r.amount.toFixed(2) === '250.00')).toBe(true);
    expect([g.rows[60]!.month, g.rows[60]!.amount.toFixed(2)]).toEqual(['2030-04-01', '250.00']);
    expect([g.rows[61]!.month, g.rows[61]!.amount.toFixed(2)]).toEqual(['2030-05-01', '200.00']);
    expect(g.endDate).toBe('2030-05-01');
    expect(total(g.rows)).toBe('15000.00');
  });
  it('acceptance 10: rules of the add-improvement command', () => {
    const c = { isAccounting: true, depreciationAmount: '12000', nonDepreciableAmount: '0', revaluationReserve: '0', lastProcessedDate: '2025-12-31', startDate: '2025-03-15', notApplied: false };
    expect(checkImprovement({ ...c, newAmount: '12000' })).toBe('strAddImprovementInvalidAmount');
    expect(checkImprovement({ ...c, newAmount: '15000', lastProcessedDate: '2025-03-15' })).toBe('strAddImprovementInvalidDate');
    expect(checkImprovement({ ...c, newAmount: '15000', lastProcessedDate: '2025-03-15', notApplied: true })).toBeNull();
    expect(checkImprovement({ ...c, newAmount: '15000' })).toBeNull();
    expect(checkImprovement({ ...c, depreciationAmount: '0', newAmount: '15000' })).toBe('strAddImprovementAssetAmountNotSet');
    // ДАП limit is the gross cost.
    expect(checkImprovement({ ...c, isAccounting: false, nonDepreciableAmount: '1000', newAmount: '11500' })).toBe('strAddImprovementInvalidAmount');
  });
  it('reports read MAX(NewDepreciationAmount) dated up to the date', () => {
    const imps = [{ date: '2025-03-15', amount: '12000' }, { date: '2025-12-31', amount: '15000' }];
    expect(costAt('15000', imps, '2025-11-30').toFixed(2)).toBe('12000.00');
    expect(costAt('15000', imps, '2025-12-31').toFixed(2)).toBe('15000.00');
    expect(costAt('9000', [], '2025-12-31').toFixed(2)).toBe('9000.00');
  });
});

describe('revaluation / impairment (03b 9.2, 9.3)', () => {
  // Cost 10 000, life 50, commissioned 15.10.2024, quota 200.00 from November 2024.
  const plan = () => generateSchedule(sap({ depreciableAmount: '10000', startDate: '2024-10-15', activePeriodLength: 50 }));
  it('base plan ends on 01.12.2028', () => {
    expect(plan().endDate).toBe('2028-12-01');
    expect(plan().rows[0]!.amount.toFixed(2)).toBe('200.00');
  });
  it('(a) impairment 6 000 -> 5 000: NRR -1 000, Dt 631, 30 months of 166.66, last 166.86 (acceptance 14)', () => {
    expect(revaluationPrefill('10000', '4000').toFixed(2)).toBe('6000.00');
    const r = computeRevaluation({ newAmount: '5000', depreciableAmount: '10000', accrued: '4000', currentReserve: '0' });
    expect(r.error).toBeNull();
    expect(r.nrr.toFixed(2)).toBe('-1000.00');
    expect(r.postingAmount.toFixed(2)).toBe('1000.00');
    expect(r.isDecrease).toBe(true);
    const posted = plan().rows.slice(0, 20);
    const g = generateSchedule(sap({
      depreciableAmount: '10000', revaluationReserve: '-1000', startDate: '2024-10-15', activePeriodLength: 50, iasMode: true,
      lastProcessedDate: '2026-06-30', amountByLastProcessedDate: '4000', processedMonths: posted,
    }));
    const after = g.rows.filter((x) => x.month >= '2026-07-01');
    expect(after).toHaveLength(30);
    expect(after.slice(0, 29).every((x) => x.amount.toFixed(2) === '166.66')).toBe(true);
    expect(after[29]!.amount.toFixed(2)).toBe('166.86');
    expect(g.endDate).toBe('2028-12-01');
    expect([yearSum(g.rows, 2026), yearSum(g.rows, 2027), yearSum(g.rows, 2028)]).toEqual([dec(2400).plus('999.96').minus(1200).toFixed(2), '1999.92', '2000.12']);
    expect(dec(yearSum(after, 2026)).toFixed(2)).toBe('999.96');
  });
  it('(b) reversal in a later year: +600, total -400, 23 months of 192.75, last 192.88 (acceptance 18)', () => {
    const accrued = dec(4000).plus(dec('166.66').times(7));
    expect(accrued.toFixed(2)).toBe('5166.62');
    const prefill = revaluationPrefill('10000', accrued);
    expect(prefill.toFixed(2)).toBe('4833.38');
    const r = computeRevaluation({ newAmount: prefill.plus(600), depreciableAmount: '10000', accrued, currentReserve: '-1000' });
    expect(r.error).toBeNull();
    expect(r.nrr.toFixed(2)).toBe('600.00');
    expect(r.isDecrease).toBe(false);
    expect(r.postingAmount.toFixed(2)).toBe('600.00');
    expect(r.totalReserve.toFixed(2)).toBe('-400.00');
    const g = generateSchedule(sap({
      depreciableAmount: '10000', revaluationReserve: '-400', startDate: '2024-10-15', activePeriodLength: 50, iasMode: true,
      lastProcessedDate: '2027-01-31', amountByLastProcessedDate: accrued,
    }));
    const after = g.rows.filter((x) => x.month >= '2027-02-01');
    expect(after).toHaveLength(23);
    expect(after[0]!.amount.toFixed(2)).toBe('192.75');
    expect(after[22]!.amount.toFixed(2)).toBe('192.88');
    expect(g.endDate).toBe('2028-12-01');
  });
  it('(c) refusals (acceptance 17)', () => {
    const r = (newAmount: string) => computeRevaluation({ newAmount, depreciableAmount: '10000', accrued: '4000', currentReserve: '0' }).error;
    expect(r('0')).toBe('strAmountIsLessThanRevaluationReserve');
    expect(r('7000')).toBe('strAmountIsLessThanRevaluationReserve');
    expect(r('-1')).toBe('strNegativeRevaluationReserve');
    expect(r('6000.01')).toBe('strAmountIsLessThanRevaluationReserve');
  });
  it('(d) a second operation in the same year measures NRR without the reserve (defect D1 compatible)', () => {
    const r = computeRevaluation({ newAmount: '4500', depreciableAmount: '10000', accrued: '4000', currentReserve: '-1000' });
    expect(r.nrr.toFixed(2)).toBe('-1500.00');
    expect(r.postingAmount.toFixed(2)).toBe('1500.00');
  });
  it('4.1: impairment of 1 000 on 31.12.2026 re-spreads 6 800 over 39 months', () => {
    const s = generateSchedule(sap({ depreciableAmount: '12000', startDate: '2025-03-20', activePeriodLength: 60 }));
    const posted = s.rows.slice(0, 21);
    expect(total(posted)).toBe('4200.00');
    const g = generateSchedule(sap({
      depreciableAmount: '12000', revaluationReserve: '-1000', startDate: '2025-03-20', activePeriodLength: 60, iasMode: true,
      lastProcessedDate: '2026-12-31', amountByLastProcessedDate: '4200', processedMonths: posted,
    }));
    const after = g.rows.slice(21);
    expect(after).toHaveLength(39);
    expect(after[0]!.amount.toFixed(2)).toBe('174.35');
    expect(after[38]!.month).toBe('2030-03-01');
    expect(after[38]!.amount.toFixed(2)).toBe('174.70');
  });
});

describe('last processed date and locks (03b 4.1, 7, 8)', () => {
  const rows = [
    { month: '2025-04-01', amount: '200', isProcessed: true, accountingDate: '2025-04-30' },
    { month: '2025-05-01', amount: '200', isProcessed: true, accountingDate: null },
    { month: '2025-06-01', amount: '200', isProcessed: false },
  ];
  it('САП: posting date of the last processed row, its MonthDate when unposted, else StartDate', () => {
    expect(accountingLastProcessedDate(rows.slice(0, 1), '2025-03-15')).toBe('2025-04-30');
    expect(accountingLastProcessedDate(rows, '2025-03-15')).toBe('2025-05-01');
    expect(accountingLastProcessedDate([], '2025-03-15')).toBe('2025-03-15');
  });
  it('ДАП: end of the month of the last row <= application date (plan D at 10.11.2025 -> 30.11.2025, 2 700.00)', () => {
    const t = generateSchedule(dap({ depreciableAmount: '12000', startDate: '2025-03-20', activePeriodLength: 40 }));
    const lp = taxLastProcessedDate(t.rows, '2025-03-20', '2025-11-10');
    expect(lp).toBe('2025-11-30');
    expect(sum(t.rows.filter((r) => r.month <= lp).map((r) => r.amount)).toFixed(2)).toBe('2700.00');
    expect(taxLastProcessedDate(t.rows, '2025-03-20', '2025-02-10')).toBe('2025-03-20');
  });
  it('FirstEditableMonthDate', () => {
    expect(firstEditableMonthDate(2025, '2024-05-10')).toBe('2026-01-01');
    expect(firstEditableMonthDate(null, '2024-05-10')).toBe('2024-05-10');
  });
});

describe('write-off (03b 11)', () => {
  const byRole = (l: ReturnType<typeof terminationLines>) => l.map((x) => `${x.side === 'debit' ? 'Dt' : 'Kt'} ${x.role} ${x.amount.toFixed(2)}`);
  it('acceptance 11: wasted 12 000 with 7 200 accrued', () => {
    expect(byRole(terminationLines({ type: TERMINATION.Wasted, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '7200', reserve: '0' })))
      .toEqual(['Dt depreciation 7200.00', 'Dt operation 4800.00', 'Kt inventory 12000.00']);
  });
  it('sold: identical entry (proceeds not posted)', () => {
    expect(byRole(terminationLines({ type: TERMINATION.Sold, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '7200', reserve: '0' })))
      .toEqual(['Dt depreciation 7200.00', 'Dt operation 4800.00', 'Kt inventory 12000.00']);
  });
  it('expired with residual 1 000', () => {
    expect(byRole(terminationLines({ type: TERMINATION.Expired, depreciableAmount: '11000', nonDepreciableAmount: '1000', accrued: '11000', reserve: '0' })))
      .toEqual(['Dt depreciation 11000.00', 'Dt operation 1000.00', 'Kt inventory 12000.00']);
  });
  it('revalued (reserve -1 000), wasted, accrued 6 000', () => {
    expect(byRole(terminationLines({ type: TERMINATION.Wasted, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '6000', reserve: '-1000' })))
      .toEqual(['Dt depreciation 6000.00', 'Dt operation 5000.00', 'Dt revaluation 1000.00', 'Kt inventory 12000.00']);
  });
  it('a positive reserve is credited (defect D7 corrected) and the entry balances', () => {
    const l = terminationLines({ type: TERMINATION.Wasted, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '6000', reserve: '500' });
    const dt = sum(l.filter((x) => x.side === 'debit').map((x) => x.amount));
    const kt = sum(l.filter((x) => x.side === 'credit').map((x) => x.amount));
    expect(dt.toFixed(2)).toBe(kt.toFixed(2));
    expect(byRole(l)).toContain('Kt revaluation 500.00');
  });
  it('mid-month wasted (11.3): Dt 241 2 800, Dt expense 9 200', () => {
    expect(byRole(terminationLines({ type: TERMINATION.Wasted, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '2800', reserve: '0' })))
      .toEqual(['Dt depreciation 2800.00', 'Dt operation 9200.00', 'Kt inventory 12000.00']);
  });
  it('"Без операция" creates no entry', () => {
    expect(terminationLines({ type: TERMINATION.NoOperation, depreciableAmount: '12000', nonDepreciableAmount: '0', accrued: '0', reserve: '0' })).toEqual([]);
  });
  it('acceptance 21: DAP date defaults to the 1st of the SAP LP month; operation "Без операция" before the end month', () => {
    expect(terminateDefaults('2026-05-31', '2026-06-30', '2030-03-01', '2026-06-15')).toEqual({ sapDate: '2026-05-31', dapDate: '2026-05-01', operation: TERMINATION.NoOperation });
    expect(terminateDefaults('2026-05-31', '2026-04-30', '2030-03-01', '2026-06-15').dapDate).toBe('2026-04-30');
    expect(terminateDefaults('2030-03-31', '2030-03-31', '2030-03-01', '2030-04-15').operation).toBe(TERMINATION.Expired);
  });
});

describe('monthly posting (03b 12)', () => {
  it('default period of the pending list', () => {
    expect(pendingDefaultPeriod(2026, '2026-06-15')).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(pendingDefaultPeriod(2025, '2026-06-15')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
  it('reference "{name}; {inv}"', () => {
    expect(postingReference('Машина', '0000000001')).toBe('Машина; 0000000001');
  });
  it('end of month', () => {
    expect(endOfMonth('2025-04-01')).toBe('2025-04-30');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });
});

describe('EUR changeover (03b 13)', () => {
  it('acceptance 15: 12 000 BGN -> 6 135.50 EUR, accrued 920.33, December 2026 = 102.24', () => {
    expect(toEur('12000').toFixed(2)).toBe('6135.50');
    expect(toEur('200').toFixed(2)).toBe('102.26');
    const rows: ScheduleRow[] = planA().rows.map((r, i) => ({ ...r, isProcessed: i < 9 }));
    const eur = convertScheduleToEur(rows, '12000');
    expect(eur).toHaveLength(60);
    expect(eur[0]!.amount.toFixed(2)).toBe('102.26');
    expect(eur[8]!.amount.toFixed(2)).toBe('102.25');
    expect(total(eur.slice(0, 9))).toBe('920.33');
    expect(eur.find((r) => r.month === '2026-12-01')!.amount.toFixed(2)).toBe('102.24');
    expect(yearSum(eur, 2026)).toBe('1227.10');
    expect(total(eur)).toBe('6135.50');
    expect(eur.filter((r) => r.isProcessed)).toHaveLength(9);
  });
  it('takes the percentage of the last non-zero year', () => {
    expect(validPercentage([{ percentage: '20' }, { percentage: '25' }, { percentage: '0' }]).toString()).toBe('25');
  });
});

describe('bulk rate change (03b 14.3)', () => {
  it('applies the new rate from 1 January of the active year', () => {
    const rows = planA().rows;
    const out = changeRateFrom(rows, '12000', 30, 2026, '2025-04-01');
    expect(yearSum(out, 2025)).toBe('1800.00');
    expect(out.find((r) => r.month === '2026-01-01')!.amount.toFixed(2)).toBe('300.00');
    expect(total(out)).toBe('12000.00');
  });
});

describe('planMainDifferences (03b 4)', () => {
  const p = { depreciationAmount: '1200.00', acquisitionDate: '2026-02-01', startDate: '2026-02-01' };
  it('compares cost and dates only, as numbers', () => {
    expect(planMainDifferences(p, { ...p, depreciationAmount: '1200' })).toEqual([]);
    expect(planMainDifferences(p, { ...p, depreciationAmount: '1200.01', startDate: '2026-03-01' })).toEqual(['стойност', 'начало на амортизация']);
    expect(planMainDifferences(p, { ...p, acquisitionDate: '2026-01-31' })).toEqual(['дата на придобиване']);
  });
});
