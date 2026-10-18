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
 * SaveMappingAccounts: every BGN account (except category КасаВОсновнаВалута)
 * is mapped to the euro account with the same number (and product). User
 * relations override the default (null = leave unmapped).
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
    if (b.categoryId === CATEGORY.CashBase) continue;
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
