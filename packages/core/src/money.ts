import Decimal from 'decimal.js';

/**
 * Money and quantity arithmetic.
 *
 * Delta stores money as decimal(19,6) and rounds half away from zero unless a
 * screen says otherwise (spec 02a section 2). Values travel through the API as
 * strings so no precision is lost in JSON.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecInput = Dec | string | number;

export const ZERO = new D(0);

export function dec(v: DecInput | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return ZERO;
  return v instanceof D ? v : new D(v);
}

/** Round half away from zero (Decimal.ROUND_HALF_UP is away from zero for negatives too). */
export function round(v: DecInput, places = 2): Dec {
  return dec(v).toDecimalPlaces(places, D.ROUND_HALF_UP);
}

export const round2 = (v: DecInput) => round(v, 2);

/** Banker's rounding (to even); used only where the spec documents it (reschedules, J1). */
export function roundHalfEven(v: DecInput, places = 2): Dec {
  return dec(v).toDecimalPlaces(places, D.ROUND_HALF_EVEN);
}

export function sum(values: Iterable<DecInput>): Dec {
  let acc = ZERO;
  for (const v of values) acc = acc.plus(dec(v));
  return acc;
}

/** Canonical string for storage/transport: fixed 2 places for money by default. */
export function fmt(v: DecInput, places = 2): string {
  return round(v, places).toFixed(places);
}

/** Human formatting with Bulgarian grouping: 1 234 567,89 */
export function formatMoney(v: DecInput, places = 2): string {
  const s = round(v, places).toFixed(places);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + grouped + (frac ? ',' + frac : '');
}

/** Parse user input that may use a comma decimal separator and spaces. */
export function parseAmount(input: string): Dec | null {
  const s = input.replace(/[\s ]/g, '').replace(',', '.');
  if (s === '' || s === '-' ) return null;
  if (!/^-?\d*(\.\d*)?$/.test(s)) return null;
  try {
    return new D(s === '.' ? '0' : s);
  } catch {
    return null;
  }
}

export function isZero(v: DecInput): boolean {
  return dec(v).isZero();
}

/** BGN -> EUR fixed conversion rate (official, used by the Euro changeover). */
export const BGN_PER_EUR = new D('1.95583');
export const EURO_CHANGEOVER_DATE = '2026-01-01';
