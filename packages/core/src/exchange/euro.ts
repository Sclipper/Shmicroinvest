import { dec, round, round2, sum, type Dec, type DecInput } from '../money.ts';
import { CATEGORY } from '../categories.ts';

/**
 * Euro conversion of a company (spec 04b 4, EuroConverter64). The legal fixed
 * rate 1.95583, years 2025 -> 2026. Pure helpers; the server runs the steps in
 * one transaction (corrected D-04b-1).
 */
export const EURO_RATE = '1.95583';
export const EURO_FROM_YEAR = 2025;
export const EURO_TO_YEAR = 2026;

/** round(x / 1.95583, 2, away from zero). */
export function toEuro(bgn: DecInput, places = 2): Dec {
  return round(dec(bgn).div(EURO_RATE), places);
}

export interface EuroAccountRef { id: number; number: string; categoryId: number | null; productId?: number | null }

/**
 * SaveMappingAccounts: every BGN account is mapped to the euro account with
 * the same number (and product). User relations override the default
 * (null = leave unmapped). Cash in base currency (КасаВОсновнаВалута) is
 * mapped too: its opening becomes EUR with a BGN currency detail
 * (`convertBalanceToEuro` kind 'cash'), so it no longer blocks the conversion.
 */
export function defaultEuroMapping(bgn: EuroAccountRef[], euro: EuroAccountRef[], relations: Record<number, number | null> = {}): Map<number, number> {
  const byKey = new Map<string, EuroAccountRef>();
  for (const e of euro) byKey.set(`${e.number}|${e.productId ?? ''}`, e);
  const out = new Map<number, number>();
  for (const b of bgn) {
    if (b.id in relations) {
      const r = relations[b.id];
      if (r) out.set(b.id, r);
      continue;
    }
    const e = byKey.get(`${b.number}|${b.productId ?? ''}`);
    if (e) out.set(b.id, e.id);
  }
  return out;
}

export interface OpeningBalance { accountId: number; debit: string; credit: string }

/**
 * Converts opening balances of the mapped BGN accounts: each side converted
 * separately, then SumAndEqualizeToAccount puts the rounding difference on
 * the differences account so the debit total equals the credit total.
 */
export function convertOpenings(openings: OpeningBalance[], mapping: Map<number, number>, differencesAccountId: number): { lines: OpeningBalance[]; difference: OpeningBalance | null; unmapped: number[] } {
  const acc = new Map<number, { d: Dec; c: Dec }>();
  const unmapped: number[] = [];
  for (const o of openings) {
    const target = mapping.get(o.accountId);
    if (target === undefined) {
      if (!dec(o.debit).isZero() || !dec(o.credit).isZero()) unmapped.push(o.accountId);
      continue;
    }
    const cur = acc.get(target) ?? { d: dec(0), c: dec(0) };
    cur.d = cur.d.plus(toEuro(o.debit));
    cur.c = cur.c.plus(toEuro(o.credit));
    acc.set(target, cur);
  }
  const lines = [...acc.entries()].map(([accountId, v]) => ({ accountId, debit: round2(v.d).toFixed(2), credit: round2(v.c).toFixed(2) }));
  const diff = round2(sum(lines.map((l) => l.debit)).minus(sum(lines.map((l) => l.credit))));
  const difference = diff.isZero()
    ? null
    : { accountId: differencesAccountId, debit: diff.isNegative() ? diff.abs().toFixed(2) : '0.00', credit: diff.isPositive() ? diff.toFixed(2) : '0.00' };
  return { lines, difference, unmapped };
}

/** Per-account difference (04b 4): abs(round((euroD - euroC) - (bgnD - bgnC)/1.95583, 2)). */
export function accountDifference(euroD: DecInput, euroC: DecInput, bgnD: DecInput, bgnC: DecInput): Dec {
  return round2(dec(euroD).minus(dec(euroC)).minus(dec(bgnD).minus(dec(bgnC)).div(EURO_RATE))).abs();
}

// ---------------------------------------------------------------------------
// Per-account detail conversion of the openings (04b 4, "Per-account detail conversion by type")

export type EuroBalanceKind = 'cash' | 'eur' | 'foreign' | 'material' | 'bgn';

/**
 * Kind of a BGN-chart account for the opening conversion: cash in base
 * currency (category КасаВОсновнаВалута), EUR-denominated, another foreign
 * currency, a material account, or a plain BGN account.
 */
export function euroBalanceKind(a: { categoryId: number | null; currencyId: number | null; productId?: number | null }, cur: { bgn: number; eur: number }): EuroBalanceKind {
  if (a.categoryId === CATEGORY.CashBase && (a.currencyId == null || a.currencyId === cur.bgn)) return 'cash';
  if (a.currencyId === cur.eur) return 'eur';
  if (a.currencyId != null && a.currencyId !== cur.bgn) return 'foreign';
  if (a.productId) return 'material';
  return 'bgn';
}

export interface EuroSides { debit: DecInput; credit: DecInput; curDebit: DecInput; curCredit: DecInput; qtyDebit: DecInput; qtyCredit: DecInput }
export interface EuroConverted {
  debit: Dec; credit: Dec;
  /** Currency amounts of the EUR opening (the leva for cash, the original currency for foreign accounts). */
  curDebit: Dec; curCredit: Dec;
  /** Rate (EUR per currency unit) and fixed rate of the currency detail; null = derived by the posting. */
  rate: Dec | null; fixedRate: Dec | null;
  /** Price of the material detail; null = derived by the posting. */
  price: Dec | null;
}

/**
 * Converts one opening row (debit and credit side) by the account kind:
 * - cash: EUR amounts plus a BGN currency detail with the original leva,
 *   FixedRate 1 and rate = round(euro / leva, ExchangeRateFormat);
 * - foreign: rate = round(BGN rate / 1.95583, ExchangeRateFormat), amount =
 *   round(currency amount x rate, 2), fallback round(amount / 1.95583, 2);
 * - material: price = round(BGN price / 1.95583, PriceFormat), amount =
 *   round(price x quantity, 2), same fallback;
 * - BGN: round(amount / 1.95583, 2); EUR: the currency amounts are copied.
 */
export function convertBalanceToEuro(kind: EuroBalanceKind, s: EuroSides, f: { priceDecimals: number; rateDecimals: number }): EuroConverted {
  const d = dec(s.debit), c = dec(s.credit), cd = dec(s.curDebit), cc = dec(s.curCredit), qd = dec(s.qtyDebit), qc = dec(s.qtyCredit);
  const zero = dec(0);
  switch (kind) {
    case 'cash': {
      const debit = toEuro(d), credit = toEuro(c);
      const leva = d.plus(c);
      return { debit, credit, curDebit: d, curCredit: c, rate: leva.isZero() ? zero : round(debit.plus(credit).div(leva), f.rateDecimals), fixedRate: dec(1), price: null };
    }
    case 'eur':
      return { debit: cd, credit: cc, curDebit: zero, curCredit: zero, rate: null, fixedRate: null, price: null };
    case 'foreign': {
      const units = cd.plus(cc);
      const rate = units.isZero() ? null : round(d.plus(c).div(units).div(EURO_RATE), f.rateDecimals);
      const side = (money: Dec, cur: Dec) => (rate && !cur.isZero() ? round2(cur.times(rate)) : toEuro(money));
      return { debit: side(d, cd), credit: side(c, cc), curDebit: cd, curCredit: cc, rate, fixedRate: null, price: null };
    }
    case 'material': {
      const qty = qd.plus(qc);
      const price = qty.isZero() ? null : round(d.plus(c).div(qty).div(EURO_RATE), f.priceDecimals);
      const side = (money: Dec, q: Dec) => (price && !q.isZero() ? round2(q.times(price)) : toEuro(money));
      return { debit: side(d, qd), credit: side(c, qc), curDebit: zero, curCredit: zero, rate: null, fixedRate: null, price };
    }
    default:
      return { debit: toEuro(d), credit: toEuro(c), curDebit: zero, curCredit: zero, rate: null, fixedRate: null, price: null };
  }
}

/** Idempotence flags and settings stored in the per-company configuration. */
export const EURO_FLAGS = {
  mapping: 'AreAccountsMappedToEuro',
  openings: 'AreInitialBalancesConvertedToEuro',
  postings: 'AreAccountingsMovedToEuroChart',
  bankTemplates: 'AreBankTemplatesConvertedToEuro',
  fixedAssets: 'AreFixedAssetsConvertedToEuro',
  templates: 'AreTemplatesConvertedToEuro',
  reschedules: 'AreReschedulesConvertedToEuro',
  differencesAccount: 'AccountForCollectingDifferences',
} as const;
