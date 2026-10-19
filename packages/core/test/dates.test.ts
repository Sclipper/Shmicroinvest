import { describe, expect, it } from 'vitest';
import { isoToBg, parseBgDate, periodPresets } from '../src/index.ts';

describe('Bulgarian date entry', () => {
  it('accepts the usual typed forms', () => {
    expect(parseBgDate('05.03.2026')).toBe('2026-03-05');
    expect(parseBgDate('5.3.26')).toBe('2026-03-05');
    expect(parseBgDate('5/3/2026')).toBe('2026-03-05');
    expect(parseBgDate('050326')).toBe('2026-03-05');
    expect(parseBgDate('05032026')).toBe('2026-03-05');
    expect(parseBgDate('2026-03-05')).toBe('2026-03-05');
    expect(parseBgDate('5.3', 2027)).toBe('2027-03-05');
  });
  it('reads day before month and rejects impossible dates', () => {
    expect(parseBgDate('12.01.2026')).toBe('2026-01-12');
    expect(parseBgDate('29.02.2026')).toBeNull();
    expect(parseBgDate('29.02.2028')).toBe('2028-02-29');
    expect(parseBgDate('31.04.2026')).toBeNull();
    expect(parseBgDate('abc')).toBeNull();
    expect(parseBgDate('')).toBeNull();
  });
  it('formats ISO dates as dd.mm.yyyy', () => {
    expect(isoToBg('2026-01-12')).toBe('12.01.2026');
    expect(isoToBg('')).toBe('');
  });
});

describe('period picker presets (05 1.4)', () => {
  it('fills the accounting periods from the financial year start date and the months from the working date', () => {
    const p = periodPresets({ year: 2026, startDate: '2026-03-15' }, '2026-03-20', '2025-01-01');
    const by = new Map(p.map((x) => [x.id, [x.from, x.to]]));
    expect(p.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, ...Array.from({ length: 12 }, (_, i) => 101 + i)]);
    expect(by.get(1)).toEqual(['2026-03-15', '2026-12-31']);
    expect(by.get(2)).toEqual(['2026-01-01', '2026-12-31']);
    expect(by.get(3)).toEqual(['2026-03-15', '2026-03-31']);
    expect(by.get(4)).toEqual(['2026-03-01', '2026-03-31']);
    expect(by.get(5)).toEqual(['2025-01-01', '2025-12-31']);
    expect(by.get(6)).toEqual(['2026-01-01', '2026-03-31']);
    expect(by.get(102)).toEqual(['2026-02-01', '2026-02-28']);
  });
  it('the calendar month follows the working date even in another year; the accounting month stays in the active year', () => {
    const p = periodPresets({ year: 2025, startDate: '2025-01-01' }, '2026-10-19');
    const by = new Map(p.map((x) => [x.id, [x.from, x.to]]));
    expect(by.get(3)).toEqual(['2025-10-01', '2025-10-31']);
    expect(by.get(4)).toEqual(['2026-10-01', '2026-10-31']);
    expect(by.get(5)).toEqual(['2024-01-01', '2024-12-31']);
  });
});
