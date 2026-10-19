import { BGN_PER_EUR, dec, round2, sum, ZERO, type DecInput } from '../money.ts';

/**
 * Turnover for VAT registration (03a 3.3, VATRegisteredTurnoverCreditsViewModel):
 * a 12-month sliding window ending with `endMonth`. From 2026 the amounts of
 * months before 2026 are converted to EUR; the limit is 100,000 BGN or
 * 51,130 EUR (02b 12).
 */
export const VAT_REGISTRATION_LIMIT = { BGN: '100000', EUR: '51130' } as const;

export interface TurnoverMonth {
  /** yyyy-MM */
  month: string;
  amount: string;
}

/** The 12 months (yyyy-MM) ending with endMonth, oldest first. */
export function turnoverWindow(endMonth: string): string[] {
  const [y, m] = endMonth.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * `monthly` holds the turnover in the currency of each month's ledger (BGN
 * before 2026, EUR from 2026); missing months count as zero.
 */
export function vatRegistrationTurnover(monthly: { month: string; amount: DecInput }[], endMonth: string, activeYear: number) {
  const euro = activeYear >= 2026;
  const byMonth = new Map<string, DecInput>(monthly.map((r) => [r.month, r.amount]));
  const months: TurnoverMonth[] = turnoverWindow(endMonth).map((month) => {
    let v = dec(byMonth.get(month) ?? ZERO);
    if (euro && month < '2026-01') v = v.div(BGN_PER_EUR);
    return { month, amount: round2(v).toFixed(2) };
  });
  const total = round2(sum(months.map((m) => m.amount)));
  const limit = euro ? VAT_REGISTRATION_LIMIT.EUR : VAT_REGISTRATION_LIMIT.BGN;
  return { months, total: total.toFixed(2), currency: euro ? 'EUR' : 'BGN', limit, exceeded: total.greaterThanOrEqualTo(limit) };
}
