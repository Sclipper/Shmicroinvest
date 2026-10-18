import { describe, expect, it } from 'vitest';
import {
  SCHEDULER_MODE, generateScheduleDates, listToMask, maskToList, validateSchedule, reschedulePeriods, splitRescheduleAmount,
  rescheduleMonths, periodDaysInMonth, rescheduleMonthEnd, validateReschedule, type RescheduleAccountInfo,
} from '../src/index.ts';

const monthly = (months: number[], days: number[]) => ({ mode: SCHEDULER_MODE.Monthly, interval: 1, weekDays: 0, months: listToMask(months), days: listToMask(days) });

describe('schedule bitmasks', () => {
  it('round-trips positions', () => {
    expect(listToMask([1, 3, 12])).toBe(1 + 4 + 2048);
    expect(maskToList(listToMask([1, 3, 12]), 12)).toEqual([1, 3, 12]);
    expect(maskToList(listToMask([31]), 31)).toEqual([31]);
  });
});

describe('schedule generators (02a 9.2)', () => {
  it('monthly months 1-12 day 5 in 2026 gives 12 rows on the 5th (acceptance)', () => {
    const dates = generateScheduleDates(monthly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [5]), 2026);
    expect(dates).toHaveLength(12);
    expect(dates.every((d) => d.endsWith('-05') && d.startsWith('2026-'))).toBe(true);
    expect(dates[0]).toBe('2026-01-05');
    expect(dates[11]).toBe('2026-12-05');
  });

  it('monthly skips days that do not exist in a month', () => {
    expect(generateScheduleDates(monthly([2, 4], [30, 31]), 2026)).toEqual(['2026-04-30']);
  });

  it('daily with interval starts on 1 January', () => {
    const d = generateScheduleDates({ mode: SCHEDULER_MODE.Daily, interval: 100, weekDays: 0, months: 0, days: 0 }, 2026);
    expect(d).toEqual(['2026-01-01', '2026-04-11', '2026-07-20', '2026-10-28']);
    expect(generateScheduleDates({ mode: SCHEDULER_MODE.Daily, interval: 1, weekDays: 0, months: 0, days: 0 }, 2024)).toHaveLength(366);
  });

  it('weekly counts weeks from the Monday-based week containing 1 January', () => {
    // 1 Jan 2026 is a Thursday; the anchor week starts Mon 29 Dec 2025.
    const d = generateScheduleDates({ mode: SCHEDULER_MODE.Weekly, interval: 2, weekDays: listToMask([1, 4]), months: 0, days: 0 }, 2026);
    expect(d.slice(0, 4)).toEqual(['2026-01-01', '2026-01-12', '2026-01-15', '2026-01-26']);
    expect(d.every((x) => x.startsWith('2026-'))).toBe(true);
  });

  it('monthly extended throws', () => {
    expect(() => generateScheduleDates({ mode: SCHEDULER_MODE.MonthlyExtended, interval: 1, weekDays: 0, months: 1, days: 1 }, 2026)).toThrow();
  });

  it('validates the schedule form', () => {
    const keys = (s: Parameters<typeof validateSchedule>[0]) => validateSchedule(s).map((m) => m.key);
    expect(keys({ mode: SCHEDULER_MODE.Daily, interval: 0, weekDays: 0, months: 0, days: 0 })).toEqual(['strIntervalError']);
    expect(keys({ mode: SCHEDULER_MODE.Daily, interval: 10000, weekDays: 0, months: 0, days: 0 })).toEqual(['strIntervalError']);
    expect(keys({ mode: SCHEDULER_MODE.Weekly, interval: 1, weekDays: 0, months: 0, days: 0 })).toEqual(['strWeekDaysError']);
    expect(keys(monthly([], []))).toEqual(['strMonthsError', 'strDaysError']);
    expect(keys(monthly([1], [1]))).toEqual([]);
    expect(validateSchedule(monthly([], [1]))[0]!.text).toBe('Не сте избрали нито един месец за графика.');
  });
});

describe('reschedule generators (02a 9.3, defect J1)', () => {
  it('splits by months with half-to-even rounding and the remainder on the last period', () => {
    // 0.375 / 3 = 0.125 per month: to-even gives 0.12, the last takes 0.13.
    const p = reschedulePeriods({ amount: '0.375', fromDate: '2026-01-10', toDate: '2026-03-20', byDays: false });
    expect(p.map((x) => x.month)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(p.map((x) => x.amount)).toEqual(['0.12', '0.12', '0.14']);
    const corrected = reschedulePeriods({ amount: '0.375', fromDate: '2026-01-10', toDate: '2026-03-20', byDays: false, corrected: true });
    expect(corrected.map((x) => x.amount)).toEqual(['0.13', '0.13', '0.12']);
  });

  it('1200 over 12 months gives 100 each', () => {
    const p = reschedulePeriods({ amount: '1200', fromDate: '2026-01-01', toDate: '2026-12-31', byDays: false });
    expect(p).toHaveLength(12);
    expect(p.every((x) => x.amount === '100.00')).toBe(true);
  });

  it('100 over 3 months: 33.33, 33.33, 33.34', () => {
    expect(reschedulePeriods({ amount: '100', fromDate: '2026-04-01', toDate: '2026-06-30', byDays: false }).map((x) => x.amount)).toEqual(['33.33', '33.33', '33.34']);
  });

  it('handles a single period (n = 1) without division by zero', () => {
    expect(reschedulePeriods({ amount: '50', fromDate: '2026-05-03', toDate: '2026-05-03', byDays: false })).toEqual([{ month: '2026-05-01', amount: '50.00' }]);
    expect(reschedulePeriods({ amount: '50', fromDate: '2026-05-03', toDate: '2026-05-03', byDays: true })).toEqual([{ month: '2026-05-01', amount: '50.00' }]);
  });

  it('splits by days in proportion to the days per month, floored, remainder last', () => {
    // 15.01-14.03.2026 = 17 + 28 + 14 = 59 days; 100 * 17/59 = 28.813.. -> 28.81; 100*28/59 = 47.457 -> 47.45.
    const p = reschedulePeriods({ amount: '100', fromDate: '2026-01-15', toDate: '2026-03-14', byDays: true });
    expect(p.map((x) => x.amount)).toEqual(['28.81', '47.45', '23.74']);
    expect(periodDaysInMonth('2026-01-15', '2026-03-14', '2026-02-01')).toBe(28);
  });

  it('sums always equal the amount', () => {
    for (const [a, f, t, d] of [['999.99', '2026-01-01', '2026-07-31', false], ['1000', '2026-02-11', '2026-11-03', true]] as const) {
      const p = reschedulePeriods({ amount: a, fromDate: f, toDate: t, byDays: d });
      expect(p.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0)).toBe(Math.round(Number(a) * 100));
    }
  });

  it('helpers', () => {
    expect(rescheduleMonths('2025-11-15', '2026-02-01')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(rescheduleMonthEnd('2028-02-10')).toBe('2028-02-29');
    expect(splitRescheduleAmount('10', [1, 1, 1], 'halfEven').map((x) => x.toFixed(2))).toEqual(['3.33', '3.33', '3.34']);
  });

  it('validates the card', () => {
    const acc = (categoryId: number | null, extra: Partial<RescheduleAccountInfo> = {}): RescheduleAccountInfo => ({ exists: true, hasSubAccounts: false, categoryId, isPartner: false, ...extra });
    const keys = (c: Partial<Parameters<typeof validateReschedule>[0]>) => validateReschedule({ name: 'Наем', amount: '1200', fromDate: '2026-01-01', toDate: '2026-12-31', debit: acc(38), credit: acc(48), companyId: null, ...c }).map((m) => m.key);
    expect(keys({})).toEqual([]);
    expect(keys({ name: ' ', amount: '0' })).toEqual(['strInvalidAccountingRescheduleName', 'strInvalidAccountingRescheduleAmount']);
    expect(keys({ debit: null, credit: null })).toEqual(['strDebitAccountIsMissing', 'strCreditAccountIsMissing']);
    expect(keys({ debit: acc(null, { exists: false }) })).toEqual(['strMissingValidDebitAccount']);
    expect(keys({ credit: acc(48, { hasSubAccounts: true }) })).toEqual(['strCreditAccountHasSubAccounts']);
    expect(keys({ debit: acc(38), credit: acc(22) })).toEqual(['strInvalidAccountingRescheduleDebitAccount', 'strInvalidAccountingRescheduleCreditAccount']);
    expect(keys({ debit: acc(50), credit: acc(10, { isPartner: true }) })).toEqual(['strCompanyIsMissing']);
    expect(keys({ fromDate: '2026-05-01', toDate: '2026-04-01' })).toEqual(['strInvalidReschedulePeriod']);
    expect(validateReschedule({ name: '', amount: '1', fromDate: '2026-01-01', toDate: '2026-01-31', debit: acc(48), credit: acc(48), companyId: null })[0]!.text).toBe('Не е попълнено име на картона');
  });
});
