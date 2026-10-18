import { describe, expect, it } from 'vitest';
import { isoToBg, parseBgDate } from '../src/index.ts';

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
