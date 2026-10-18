/**
 * Financial year month-lock bitmask (spec 01b section 6.1).
 * Bit m (1..12) = month m locked; bit 0 unused; all months = 8190.
 */
export const ALL_MONTHS_LOCKED = 8190;

export interface YearLockState {
  isLocked: boolean;
  lockedMonths: number;
}

export function isMonthLocked(lockedMonths: number, month: number): boolean {
  return (lockedMonths & (1 << month)) !== 0;
}

export function lockMonth(s: YearLockState, month: number): YearLockState {
  const lockedMonths = s.lockedMonths | (1 << month);
  return { lockedMonths, isLocked: lockedMonths === ALL_MONTHS_LOCKED ? true : s.isLocked };
}

export function unlockMonth(s: YearLockState, month: number): YearLockState {
  // Delta clears IsLocked first, then the bit.
  return { isLocked: false, lockedMonths: s.lockedMonths & ~(1 << month) };
}

export function lockYear(): YearLockState {
  return { isLocked: true, lockedMonths: ALL_MONTHS_LOCKED };
}

export function unlockYear(): YearLockState {
  return { isLocked: false, lockedMonths: 0 };
}

export function lockedMonthList(lockedMonths: number): number[] {
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) if (isMonthLocked(lockedMonths, m)) out.push(m);
  return out;
}

export const MONTH_NAMES_BG = [
  'Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни',
  'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември',
] as const;
export const MONTH_SHORT_BG = ['Ян', 'Фев', 'Мар', 'Апр', 'Май', 'Юни', 'Юли', 'Авг', 'Сеп', 'Окт', 'Ное', 'Дек'] as const;

/**
 * Base (ledger) currency rule: EUR when the active financial year >= 2026, else BGN
 * (spec 01a section 5, CurrencyHelper).
 */
export function baseCurrencyForYear(year: number): 'EUR' | 'BGN' {
  return year >= 2026 ? 'EUR' : 'BGN';
}
