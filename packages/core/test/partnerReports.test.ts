import { describe, expect, it } from 'vitest';
import {
  cashAndReceivablesDefaultLimit, cashAndReceivablesFormulas, cashAndReceivablesLimitWarning, cashOrderAmountInWords, daysBetweenDates, isOverdue, matchesColumnFilter, movementLineDirection,
  overdueDaysText, pairTwoPerRow,
} from '../src/index.ts';

describe('partner reports helpers (spec 05 6)', () => {
  it('overdue days text: "1 ден", "N дни", empty for 0', () => {
    expect(overdueDaysText(0)).toBe('');
    expect(overdueDaysText(1)).toBe('1 ден');
    expect(overdueDaysText(2)).toBe('2 дни');
    expect(overdueDaysText(31)).toBe('31 дни');
  });

  it('overdue test is against the end date, date part only, strict', () => {
    expect(isOverdue('2026-03-10', '2026-03-10')).toBe(false);
    expect(isOverdue('2026-03-09', '2026-03-10')).toBe(true);
    expect(isOverdue('2026-03-09T00:00:00', '2026-03-10T23:59')).toBe(true);
    expect(daysBetweenDates('2026-02-27', '2026-03-01')).toBe(2);
    expect(daysBetweenDates('2026-03-29', '2026-03-30')).toBe(1); // across DST change
  });

  it('pairs cash orders two per printed row', () => {
    expect(pairTwoPerRow([1, 2, 3])).toEqual([{ first: 1, second: 2 }, { first: 3, second: null }]);
    expect(pairTwoPerRow([])).toEqual([]);
  });

  it('classifies movement lines by category and side', () => {
    expect(movementLineDirection(4, -1)).toBe('increase'); // supplier invoice credits 401
    expect(movementLineDirection(4, 1)).toBe('settlement'); // payment debits 401
    expect(movementLineDirection(10, 1)).toBe('increase'); // sale debits 411
    expect(movementLineDirection(10, -1)).toBe('settlement');
    expect(movementLineDirection(19, 1)).toBe('increase'); // other debtors are receivable
    expect(movementLineDirection(20, -1)).toBe('increase'); // other creditors are payable
    expect(movementLineDirection(21, 1)).toBeNull();
  });

  it('cash and receivables formulas cr1..cr3', () => {
    const bal: Record<string, { closingDebit: string; closingCredit: string }> = {
      '501': { closingDebit: '1000.00', closingCredit: '0.00' },
      '502': { closingDebit: '250.50', closingCredit: '0.00' },
      '493': { closingDebit: '300.00', closingCredit: '100.00' },
      '422': { closingDebit: '80.00', closingCredit: '30.00' },
      '429': { closingDebit: '20.00', closingCredit: '5.00' },
    };
    const r = cashAndReceivablesFormulas((n) => bal[n] ?? { closingDebit: 0, closingCredit: 0 });
    expect(r).toEqual({ availableCash: '1250.50', ownersReceivables: '200.00', workersReceivables: '70.00', total: '1520.50' });
  });

  it('cash order amount in words is capitalised and picks the currency by date', () => {
    expect(cashOrderAmountInWords('123.45', '2026-02-01')).toBe('Сто двадесет и три евро и 45 цента');
    expect(cashOrderAmountInWords('2', '2025-12-31')).toBe('Два лв.');
    expect(cashOrderAmountInWords('1200', '2026-01-01')).toBe('Хиляда и двеста евро');
    expect(cashOrderAmountInWords('0.50', '2026-01-05')).toBe('Нула евро и 50 цента');
    expect(cashOrderAmountInWords('10', '2025-06-01', true)).toBe('Десет евро');
  });

  it('column filter of the partner reports', () => {
    const row = { companyName: 'Доставчик ООД', amount: '1234.50' };
    expect(matchesColumnFilter(row, 'companyName', 'доставчик')).toBe(true);
    expect(matchesColumnFilter(row, 'companyName', '1234')).toBe(false);
    expect(matchesColumnFilter(row, 'amount', '1234,5')).toBe(true);
    expect(matchesColumnFilter(row, 'all', 'ООД')).toBe(true);
    expect(matchesColumnFilter(row, 'all', '')).toBe(true);
  });
});

describe('cash and receivables legal limit (strCashAndReceivablesLimitExceeded)', () => {
  it('default limit 10 000 лв, 5 112,92 EUR from 2026; warns only above the limit; 0 switches it off', () => {
    expect(cashAndReceivablesDefaultLimit(2025)).toBe('10000.00');
    expect(cashAndReceivablesDefaultLimit(2026)).toBe('5112.92');
    expect(cashAndReceivablesLimitWarning('5112.92', '5112.92', 'EUR')).toBeNull();
    expect(cashAndReceivablesLimitWarning('6000', '5112.92', 'EUR')).toBe(
      'Общата сума на касовите наличности и вземанията от собственици и от работници, служители и подотчетни лица (6 000,00 EUR) надвишава допустимия лимит от 5 112,92 EUR.',
    );
    expect(cashAndReceivablesLimitWarning('6000', '0', 'EUR')).toBeNull();
  });
});
