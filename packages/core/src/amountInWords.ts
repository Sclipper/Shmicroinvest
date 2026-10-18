import { dec, type DecInput } from './money.ts';

/**
 * Amount in words, Bulgarian (spec 02c 1.10). Matches the test vectors of the
 * spec: "и" goes before the last component of each group and before a
 * single-component final group; the thousands group uses feminine "една"/"две";
 * cents are printed as digits.
 */

const UNITS_M = ['', 'един', 'два', 'три', 'четири', 'пет', 'шест', 'седем', 'осем', 'девет'];
const UNITS_F = ['', 'една', 'две', 'три', 'четири', 'пет', 'шест', 'седем', 'осем', 'девет'];
const TEENS = ['десет', 'единадесет', 'дванадесет', 'тринадесет', 'четиринадесет', 'петнадесет', 'шестнадесет', 'седемнадесет', 'осемнадесет', 'деветнадесет'];
const TENS = ['', '', 'двадесет', 'тридесет', 'четиридесет', 'петдесет', 'шестдесет', 'седемдесет', 'осемдесет', 'деветдесет'];
const HUNDREDS = ['', 'сто', 'двеста', 'триста', 'четиристотин', 'петстотин', 'шестстотин', 'седемстотин', 'осемстотин', 'деветстотин'];

const CURRENCY_WORDS: Record<string, { one: string; many: string; centOne: string; centMany: string }> = {
  BGN: { one: 'лв.', many: 'лв.', centOne: 'ст.', centMany: 'ст.' },
  EUR: { one: 'евро', many: 'евро', centOne: 'цент', centMany: 'цента' },
  USD: { one: 'долар', many: 'долара', centOne: 'цент', centMany: 'цента' },
  CHF: { one: 'франк', many: 'франка', centOne: 'сантим', centMany: 'сантима' },
  GBP: { one: 'лира', many: 'лири', centOne: 'пени', centMany: 'пени' },
};

function groupComponents(n: number, feminine: boolean): string[] {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const parts: string[] = [];
  if (h) parts.push(HUNDREDS[h]!);
  if (t === 1) parts.push(TEENS[u]!);
  else {
    if (t) parts.push(TENS[t]!);
    if (u) parts.push((feminine ? UNITS_F : UNITS_M)[u]!);
  }
  return parts;
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(' ') + ' и ' + parts[parts.length - 1];
}

/** Integer part in words (0 <= n < 1e12). */
export function integerToWords(n: number): string {
  if (n === 0) return 'нула';
  const scales = [
    { value: 1e9, one: 'един милиард', many: 'милиарда', feminine: false },
    { value: 1e6, one: 'един милион', many: 'милиона', feminine: false },
    { value: 1e3, one: 'хиляда', many: 'хиляди', feminine: true },
    { value: 1, one: '', many: '', feminine: false },
  ];
  const groups: { parts: string[] }[] = [];
  let rest = n;
  for (const s of scales) {
    const g = Math.floor(rest / s.value);
    rest -= g * s.value;
    if (g === 0) continue;
    if (s.value === 1) {
      groups.push({ parts: groupComponents(g, false) });
    } else if (g === 1) {
      groups.push({ parts: [s.one] });
    } else {
      const parts = groupComponents(g, s.feminine);
      parts[parts.length - 1] += ' ' + s.many;
      groups.push({ parts });
    }
  }
  const words: string[] = [];
  groups.forEach((g, i) => {
    const isLast = i === groups.length - 1;
    if (isLast && i > 0 && g.parts.length === 1) words.push('и ' + g.parts[0]);
    else words.push(joinWithAnd(g.parts));
  });
  return words.join(' ');
}

export function amountInWords(amount: DecInput, currency = '', opts: { capitalize?: boolean } = {}): string {
  const v = dec(amount).abs();
  if (v.greaterThanOrEqualTo(1e12)) return '';
  const whole = v.floor();
  const cents = v.minus(whole).times(100).toDecimalPlaces(0).toNumber();
  let text = whole.isZero() ? 'нула' : integerToWords(whole.toNumber());
  const cw = CURRENCY_WORDS[currency.toUpperCase()];
  if (currency) {
    if (cw) text += ' ' + (whole.equals(1) ? cw.one : cw.many);
    if (cents !== 0) text += ' и ' + cents + (cw ? ' ' + (cents === 1 ? cw.centOne : cw.centMany) : '');
  }
  text = text.trim();
  return opts.capitalize ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
