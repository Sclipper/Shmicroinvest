import { D, dec, round2, roundHalfEven, ZERO, type Dec, type DecInput } from './money.ts';

/**
 * Template schedules and reschedule generators (spec 02a 9.2, 9.3).
 *
 * Bitmasks (Schedules table): months bit m-1 = month m (1..12); days bit d-1 =
 * day d (1..31); weekDays bit 0 = Monday ... bit 6 = Sunday.
 */

export const SCHEDULER_MODE = { Daily: 0, Weekly: 1, Monthly: 2, MonthlyExtended: 3 } as const;

export interface ScheduleDef {
  mode: number;
  interval: number;
  weekDays: number;
  months: number;
  days: number;
}

export const SCHEDULE_MESSAGES = {
  strIntervalError: 'Не сте въвели стойност за интервал на графика.',
  strWeekDaysError: 'Не сте избрали нито един ден от седмицата за графика.',
  strMonthsError: 'Не сте избрали нито един месец за графика.',
  strDaysError: 'Не сте избрали нито един ден за графика.',
  strTemplateNameError: 'Не е въведено име на шаблон!',
  strTemplateNameExistWarning: 'Съществува шаблон с това име!',
  strTemplateSchedulesFromAnotherYearFound: 'Шаблоните за осчетоводяване от други счетоводни години няма да бъдат обработени!',
  strOperationsTemplateSchedulesSuccess: 'Осчетоводяване на графика за {0} г. - {1} г. завърши успешно.',
  strProcessTemplateSchedulesPrompt: 'Желаете ли да се извърши осчетоводяване на избраните шаблони?',
  strConfirmTemplateVoid: 'Желаете ли да изтриете избрания шаблон?',
  strSaveCompanyWithTemplatePrompt: 'Желаете ли да запазите избрания партньор в шаблона?',
  strMonthlyExtendedNotSupported: 'Разширеният месечен график не се поддържа.',
} as const;

export interface ScheduleMessage { key: string; text: string; severity: 'critical' }

/** Mask -> sorted list of 1-based positions (count = number of bits considered). */
export function maskToList(mask: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (Math.floor(mask / 2 ** i) % 2 === 1) out.push(i + 1);
  return out;
}

/** 1-based positions -> mask. */
export function listToMask(list: Iterable<number>): number {
  let m = 0;
  for (const p of new Set(list)) if (p >= 1) m += 2 ** (p - 1);
  return m;
}

/** ScheduleViewModel validation (02a 9.2). Interval: 1..9999 (MaxLength 4). */
export function validateSchedule(s: ScheduleDef): ScheduleMessage[] {
  const out: ScheduleMessage[] = [];
  const add = (key: keyof typeof SCHEDULE_MESSAGES) => out.push({ key, text: SCHEDULE_MESSAGES[key], severity: 'critical' });
  if (s.mode === SCHEDULER_MODE.Daily || s.mode === SCHEDULER_MODE.Weekly) {
    if (!Number.isInteger(s.interval) || s.interval < 1 || s.interval > 9999) add('strIntervalError');
  }
  if (s.mode === SCHEDULER_MODE.Weekly && maskToList(s.weekDays, 7).length === 0) add('strWeekDaysError');
  if (s.mode === SCHEDULER_MODE.Monthly) {
    if (maskToList(s.months, 12).length === 0) add('strMonthsError');
    if (maskToList(s.days, 31).length === 0) add('strDaysError');
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
export const scheduleMonthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * SchedulerService generators for one financial year (dates as yyyy-mm-dd, ascending).
 * - Daily: Jan 1, then every `interval` days.
 * - Weekly: the selected weekdays of every `interval`-th week; weeks are counted
 *   Monday-based from the week that contains Jan 1 (anchor is [U] in the spec, recipe A2).
 * - Monthly: every selected month x every selected day; a day that does not exist
 *   in a month (e.g. 31 in April) is skipped. The interval is not used.
 * - MonthlyExtended throws, as in Delta.
 */
export function generateScheduleDates(s: ScheduleDef, year: number): string[] {
  const out: string[] = [];
  const end = utc(year, 12, 31).getTime();
  if (s.mode === SCHEDULER_MODE.Daily) {
    const step = Math.max(1, s.interval);
    for (let t = utc(year, 1, 1); t.getTime() <= end; t = new Date(t.getTime() + step * 86400000)) out.push(iso(t));
    return out;
  }
  if (s.mode === SCHEDULER_MODE.Weekly) {
    const step = Math.max(1, s.interval);
    const jan1 = utc(year, 1, 1);
    const monday = new Date(jan1.getTime() - ((jan1.getUTCDay() + 6) % 7) * 86400000);
    const days = maskToList(s.weekDays, 7);
    for (let w = 0; ; w += step) {
      const weekStart = monday.getTime() + w * 7 * 86400000;
      if (weekStart > end) break;
      for (const d of days) {
        const t = new Date(weekStart + (d - 1) * 86400000);
        if (t.getUTCFullYear() === year) out.push(iso(t));
      }
    }
    return out;
  }
  if (s.mode === SCHEDULER_MODE.Monthly) {
    const days = maskToList(s.days, 31);
    for (const m of maskToList(s.months, 12)) {
      for (const d of days) if (d <= scheduleMonthDays(year, m)) out.push(`${year}-${pad(m)}-${pad(d)}`);
    }
    return out;
  }
  throw new Error(SCHEDULE_MESSAGES.strMonthlyExtendedNotSupported);
}

// ---------------------------------------------------------------------------
// Reschedules (Разсрочване на приходи/разходи, 02a 9.3)

export const RESCHEDULE_MESSAGES = {
  strInvalidAccountingRescheduleName: 'Не е попълнено име на картона',
  strInvalidAccountingRescheduleAmount: 'Не е попълнена стойност за разсрочване',
  strDebitAccountIsMissing: 'Не е попълнена сметка Дебит',
  strCreditAccountIsMissing: 'Не е попълнена сметка Кредит',
  strMissingValidDebitAccount: 'Не е въведена валидна сметка за дебит!',
  strMissingValidCreditAccount: 'Не е въведена валидна сметка за кредит!',
  strCompanyIsMissing: 'Не е попълнен Партньор',
  strInvalidAccountingRescheduleDebitAccount: 'Категорията на сметка Дебит не отговаря на условията за разсрочване',
  strInvalidAccountingRescheduleCreditAccount: 'Категорията на сметка Кредит не отговаря на условията за разсрочване',
  strDebitAccountHasSubAccounts: 'Към посочената сметка в поле Дебит има създадени подсметки в Индивидуален сметкоплан.',
  strCreditAccountHasSubAccounts: 'Към посочената сметка в поле Кредит има създадени подсметки в Индивидуален сметкоплан.',
  /** Own wording: the spec has no message for an inverted period. */
  strInvalidReschedulePeriod: 'Началната дата на периода е след крайната дата.',
  strConfirmVoidAccountingReschedule: 'Желаете ли да изтриете избрания картон? Ще бъде изгубена връзката между контировките и картона за разсрочване',
} as const;

/** Deferred-expense (651, 652) and deferred-income (751, 752) categories. */
export const DEFERRAL_CATEGORIES = [48, 49, 50, 51] as const;

export interface RescheduleAccountInfo {
  /** false = the account id does not exist in the active chart. */
  exists: boolean;
  hasSubAccounts: boolean;
  categoryId: number | null;
  isPartner: boolean;
}

export interface RescheduleCardInput {
  name: string;
  amount: DecInput | null;
  fromDate: string;
  toDate: string;
  debit: RescheduleAccountInfo | null;
  credit: RescheduleAccountInfo | null;
  companyId: number | null;
}

/**
 * AccountingRescheduleViewModel validation. The category condition is [I]: the
 * card is valid when the debit or the credit account belongs to a deferral
 * category (48-51); otherwise both category messages are reported.
 */
export function validateReschedule(c: RescheduleCardInput): ScheduleMessage[] {
  const out: ScheduleMessage[] = [];
  const add = (key: keyof typeof RESCHEDULE_MESSAGES) => out.push({ key, text: RESCHEDULE_MESSAGES[key], severity: 'critical' });
  if (!c.name.trim()) add('strInvalidAccountingRescheduleName');
  if (c.amount === null || c.amount === '' || dec(c.amount).isZero()) add('strInvalidAccountingRescheduleAmount');
  if (!c.debit) add('strDebitAccountIsMissing');
  else if (!c.debit.exists) add('strMissingValidDebitAccount');
  else if (c.debit.hasSubAccounts) add('strDebitAccountHasSubAccounts');
  if (!c.credit) add('strCreditAccountIsMissing');
  else if (!c.credit.exists) add('strMissingValidCreditAccount');
  else if (c.credit.hasSubAccounts) add('strCreditAccountHasSubAccounts');
  if (c.debit?.exists && c.credit?.exists) {
    const ok = (a: RescheduleAccountInfo) => a.categoryId != null && (DEFERRAL_CATEGORIES as readonly number[]).includes(a.categoryId);
    if (!ok(c.debit) && !ok(c.credit)) {
      add('strInvalidAccountingRescheduleDebitAccount');
      add('strInvalidAccountingRescheduleCreditAccount');
    }
  }
  if ((c.debit?.isPartner || c.credit?.isPartner) && !c.companyId) add('strCompanyIsMissing');
  if (c.fromDate && c.toDate && c.fromDate > c.toDate) add('strInvalidReschedulePeriod');
  return out;
}

export type RescheduleRounding = 'halfEven' | 'awayFromZero' | 'floor';

/**
 * Split `amount` by weights; every share but the last is rounded with `rounding`,
 * the last takes the remainder so the shares sum to the whole. One weight = whole
 * amount (no division by zero).
 */
export function splitRescheduleAmount(amount: DecInput, weights: number[], rounding: RescheduleRounding): Dec[] {
  const total = dec(amount);
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.reduce((a, b) => a + b, 0);
  const out: Dec[] = [];
  let used = ZERO;
  for (let i = 0; i < n - 1; i++) {
    const raw = w === 0 ? ZERO : total.times(weights[i]!).div(w);
    const share = rounding === 'halfEven' ? roundHalfEven(raw) : rounding === 'floor' ? raw.toDecimalPlaces(2, D.ROUND_DOWN) : round2(raw);
    out.push(share);
    used = used.plus(share);
  }
  out.push(total.minus(used));
  return out;
}

/** Month starts (yyyy-mm-01) from the month of `from` to the month of `to`, inclusive. */
export function rescheduleMonths(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}-01`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Days of [from, to] (inclusive) that fall in the month starting at `monthStart`. */
export function periodDaysInMonth(from: string, to: string, monthStart: string): number {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const first = `${monthStart.slice(0, 8)}01`;
  const last = `${monthStart.slice(0, 8)}${pad(scheduleMonthDays(y, m))}`;
  const a = from > first ? from : first;
  const b = to < last ? to : last;
  if (a > b) return 0;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
}

export interface ReschedulePeriod { month: string; amount: string }

/**
 * Period amounts of a reschedule card.
 * - By months: equal split per month, each period rounded half-to-even
 *   (bug-compatible J1, `corrected` = half away from zero), last takes the remainder.
 * - By days: per month in proportion to the number of the period's days in it,
 *   floored to cents (the by-criteria generators), last takes the remainder.
 * `months` restricts the generation to the given month starts (used to spread a
 * remaining amount over the unprocessed periods).
 */
export function reschedulePeriods(o: { amount: DecInput; fromDate: string; toDate: string; byDays: boolean; corrected?: boolean; months?: string[] }): ReschedulePeriod[] {
  const months = o.months ?? rescheduleMonths(o.fromDate, o.toDate);
  if (!months.length) return [];
  const weights = o.byDays ? months.map((m) => periodDaysInMonth(o.fromDate, o.toDate, m)) : months.map(() => 1);
  const rounding: RescheduleRounding = o.byDays ? 'floor' : o.corrected ? 'awayFromZero' : 'halfEven';
  return splitRescheduleAmount(o.amount, weights, rounding).map((a, i) => ({ month: months[i]!, amount: a.toFixed(2) }));
}

/** Last day of the month of a date (yyyy-mm-dd). */
export function rescheduleMonthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${date.slice(0, 8)}${pad(scheduleMonthDays(y, m))}`;
}
