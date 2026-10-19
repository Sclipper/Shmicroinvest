import { describe, expect, it } from 'vitest';
import { mergeSavedFilter } from '../src/index.ts';

describe('saved report filters (05 1.2)', () => {
  const defaults = { from: '2026-01-01', to: '2026-12-31', account: '', level: 2, zero: false, companyId: null as number | null, companyName: '' as string | null, ids: [] as number[] };

  it('restores known keys of the same type and ignores the rest', () => {
    const r = mergeSavedFilter(defaults, { account: '501', level: '3', zero: true, companyId: 7, companyName: null, ids: [1, 2], gone: 'x' }, 2026);
    expect(r).toEqual({ ...defaults, account: '501', zero: true, companyId: 7, companyName: null, ids: [1, 2] });
  });

  it('restores the period of the active year only, and only as a pair', () => {
    expect(mergeSavedFilter(defaults, { from: '2026-03-01', to: '2026-03-31' }, 2026)).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });
    expect(mergeSavedFilter(defaults, { from: '2025-03-01', to: '2025-03-31' }, 2026)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(mergeSavedFilter(defaults, { from: '2025-12-01', to: '2026-01-31' }, 2026)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('keeps the defaults when nothing is saved', () => {
    expect(mergeSavedFilter(defaults, null, 2026)).toBe(defaults);
  });
});
