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

/** Messages of the "Счетоводна година" dialog and the application date (01b 5, 6.3). */
export const YEAR_MESSAGES = {
  strFinancialYearNotFound: 'Не е намерена счетоводна година {0}!',
  strChangeAccountingYearLockedWarning: 'Избраната счетоводна година е заключена и не може да бъде избрана!',
  strNextFinancialYearConcludePreviousWarning:
    'За да бъде създадена следващата счетоводна година, годината преди нея трябва да бъде приключена. Желаете ли да продължите?',
  strSelect2026yearMessage: 'За да преминете в счетоводна година 2026, годината преди нея трябва да бъде приключена. Желаете ли да продължите?',
  strChangeApplicationDateWithAccountingYearConfirmation:
    'Текущата дата на приложението не може да е в по-ранна година от избраната счетоводна година! За текуща година на приложението ще бъде избрана текущата счетоводна година. Желаете ли да продължите?',
  strHelpCannotDeleteLockedYear: 'Счетоводната година не може да бъде изтрита, защото е заключена за редакция.',
  strHelpCannotDeleteCurrentFinancialYear: 'Текущата счетоводна година не може да бъде изтрита.',
  strHelpCannotDeleteBecauseOfActivePreviousYear: 'Счетоводната година не може да бъде изтрита, защото има активни години преди нея.',
  strDeleteFinancialYearDone: 'Счетоводната година {0} е изтрита успешно!',
  /** Status-bar year without UI_Edit_ChangeActiveFinancialYear (01b 5). */
  strCurrentFinancialYearInfo: 'Текущата счетоводна година е {0}!',
} as const;

/** First year of the EUR ledger; selecting it needs the euro changeover (strSelect2026yearMessage). */
export const EURO_CHANGEOVER_YEAR = 2026;

/**
 * Active year when the user has none stored: the current calendar year,
 * else the latest year before it, else the earliest year.
 */
export function defaultActiveYear(years: number[], today: string): number | null {
  if (!years.length) return null;
  const current = Number(today.slice(0, 4));
  if (years.includes(current)) return current;
  const before = years.filter((y) => y < current);
  return before.length ? Math.max(...before) : Math.min(...years);
}

/** Login guard (OpenLoginWindow, 06 4.1): 2026 without the euro chart falls back to 2025 when it exists. */
export function loginActiveYear(year: number, euroChartReady: boolean, years: number[]): number {
  return year === EURO_CHANGEOVER_YEAR && !euroChartReady && years.includes(EURO_CHANGEOVER_YEAR - 1) ? EURO_CHANGEOVER_YEAR - 1 : year;
}

/** Creating the year after the last one asks for that one to be concluded first (strNextFinancialYearConcludePreviousWarning). */
export function needsPreviousConclusion(years: { year: number; isConcluded: boolean }[], newYear: number): boolean {
  const prev = years.find((y) => y.year === newYear - 1);
  return !!prev && !prev.isConcluded && !years.some((y) => y.year > newYear);
}

/** The working date moved into the chosen year (same day and month; 29 February becomes the 28th), or null when it is already there. */
export function workingDateInYear(workingDate: string, year: number): string | null {
  if (Number(workingDate.slice(0, 4)) === year) return null;
  const md = workingDate.slice(5);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${year}-${md === '02-29' && !leap ? '02-28' : md}`;
}

/** Choosing a year later than the working date's year moves the date and asks first (strChangeApplicationDateWithAccountingYearConfirmation, 01b 5). */
export function yearChangeMovesDateForward(workingDate: string, year: number): boolean {
  return year > Number(workingDate.slice(0, 4));
}
