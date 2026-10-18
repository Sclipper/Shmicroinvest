import { D, dec, round, round2, ZERO, type Dec, type DecInput } from './money.ts';

/**
 * FX revaluation (Преоценка на валути, spec 02c section 2).
 *
 * Every rate assigned to the fixing table (and the single rate of the partner
 * tab) is rounded to 5 decimals, half away from zero. Per account:
 *   NewAmount = round2(curNet * rate)            (signed, half away from zero)
 *   Direction = Positive if NewAmount > bookNet, Negative if <, else Neutral
 *   Sum       = round2(|NewAmount - bookNet|)
 * Positive: Dr the account / Cr the first 724-category account (income).
 * Negative: Dr the first 624-category account (expense) / Cr the account.
 * Rows below 0.01 are not listed; Save needs a row above 0.01.
 */

export const REVALUATION_MESSAGES = {
  strReevaluation: 'Преоценка',
  strReevaluationAccountsNotDefined:
    'Не са дефинирани сметки в категориите Приходи от валутни операции (724) и Разходи по валутни операции (624). Моля, добавете в индивидуалния сметкоплан тези сметки, за да извършвате преоценка.',
  strAccountNotSelectedError: 'Не е избрана сметка за преоценка!',
  strIncorrectCurrencySubAccount: 'Не е въведена валутна подсметка за преоценяване!',
  strZeroReevaluationSumError: 'Сумата за преоценка не може да бъде 0.00!',
  strExchangeRateNotSetError: 'Не е посочен нов валутен курс за сметката - централен курс на БНБ към датата на преоценяването.',
  strActiveAccountReevaluationError: 'Не може да бъде извършена преоценка на активна сметка с кредитно салдо!',
  strPassiveAccountReevaluationError: 'Не може да бъде извършена преоценка на пасивна сметка с дебитно салдо!',
  strCurrenciesServiceUnavailableOrHoliday: 'Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.',
  strPartnerAccountNotSelected: 'Не е избрана сметка, която поддържа работа с партньори!',
} as const;

export type RevaluationDirection = 'neutral' | 'positive' | 'negative';

/** Rate cell rule (CurrencyDTO.Value setter): 5 decimals, half away from zero. */
export function roundRate(rate: DecInput): Dec {
  return round(rate, 5);
}

export interface RevaluationResult {
  bookNet: Dec;
  curNet: Dec;
  rate: Dec;
  newAmount: Dec;
  direction: RevaluationDirection;
  sum: Dec;
  /** |bookNet / curNet| when |curNet| > 0.01, else |bookNet| (display only, unrounded). */
  averageRate: Dec;
}

/** Recalculate (ReevaluationViewModel): one account or one (account, partner) row. */
export function revalue(bookNet: DecInput, curNet: DecInput, rate: DecInput): RevaluationResult {
  const b = dec(bookNet);
  const c = dec(curNet);
  const r = roundRate(rate);
  const newAmount = round2(c.times(r));
  const direction: RevaluationDirection = newAmount.equals(b) ? 'neutral' : newAmount.greaterThan(b) ? 'positive' : 'negative';
  const sum = round2(newAmount.minus(b).abs());
  const averageRate = c.abs().greaterThan('0.01') ? b.div(c).abs() : b.abs();
  return { bookNet: b, curNet: c, rate: r, newAmount, direction, sum, averageRate };
}

/** Grid filter: rows with a sum below 0.01 are removed. */
export const isListedRevaluation = (sum: DecInput) => dec(sum).greaterThanOrEqualTo('0.01');
/** Save enablement: some row with a sum strictly above 0.01. */
export const canSaveRevaluation = (sums: DecInput[]) => sums.some((s) => dec(s).greaterThan('0.01'));

export interface RevaluationLegs {
  debit: 'account' | 'income' | 'expense';
  credit: 'account' | 'income' | 'expense';
  amount: Dec;
}

/** Legs of the memorial order for one row (null for neutral rows). */
export function revaluationLegs(r: RevaluationResult): RevaluationLegs | null {
  if (r.direction === 'neutral' || r.sum.isZero()) return null;
  return r.direction === 'positive'
    ? { debit: 'account', credit: 'income', amount: round2(r.sum) }
    : { debit: 'expense', credit: 'account', amount: round2(r.sum) };
}

/**
 * Partner tab sign checks: an active account (IsActive = true) may not have a
 * credit balance, a passive one (false) not a debit balance.
 */
export function partnerRevaluationCheck(isActive: boolean | null | undefined, bookNet: DecInput): keyof typeof REVALUATION_MESSAGES | null {
  const b = dec(bookNet);
  if (isActive === true && b.lessThan(0)) return 'strActiveAccountReevaluationError';
  if (isActive === false && b.greaterThan(0)) return 'strPassiveAccountReevaluationError';
  return null;
}

/**
 * Central rate in the base currency from an ECB reference rate (units of the
 * foreign currency per 1 EUR): EUR base = 1 / ecb; BGN base = 1.95583 / ecb.
 * Rounded to 5 decimals.
 */
export function rateFromEcb(ecbUnitsPerEur: DecInput, baseIso: 'EUR' | 'BGN', iso: string): Dec {
  if (iso === baseIso) return new D(1);
  const bgnPerEur = new D('1.95583');
  if (iso === 'EUR') return baseIso === 'BGN' ? bgnPerEur : new D(1);
  if (iso === 'BGN') return baseIso === 'EUR' ? roundRate(new D(1).div(bgnPerEur)) : new D(1);
  const e = dec(ecbUnitsPerEur);
  if (e.isZero()) return ZERO;
  return roundRate((baseIso === 'EUR' ? new D(1) : bgnPerEur).div(e));
}
