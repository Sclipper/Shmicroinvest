import { dec, type Dec, type DecInput } from './money.ts';
import { amountInWords } from './amountInWords.ts';
import { CLIENT_CATEGORIES, SUPPLIER_CATEGORIES } from './categories.ts';

/**
 * Pure helpers of the partner statements and cash reports (spec 05 6, 02c 4).
 */

/** Overdue text of spOverduesReport (05 6.7): "1 ден", "N дни", empty for 0. */
export function overdueDaysText(days: number): string {
  if (!days || days <= 0) return '';
  return days === 1 ? '1 ден' : `${days} дни`;
}

/** Whole days from `from` to `to` (ISO dates, date part only). */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10) + 'T12:00:00Z') - Date.parse(from.slice(0, 10) + 'T12:00:00Z')) / 86_400_000);
}

/**
 * Overdue test (corrected defect 02c D2): a document is overdue when its due
 * date (date part only) is strictly earlier than the report end date.
 */
export function isOverdue(dueDate: string, endDate: string): boolean {
  return dueDate.slice(0, 10) < endDate.slice(0, 10);
}

/** Cash orders print two forms per output row (05 6.9): row k pairs items 2k and 2k+1. */
export function pairTwoPerRow<T>(items: T[]): { first: T; second: T | null }[] {
  const out: { first: T; second: T | null }[] = [];
  for (let i = 0; i < items.length; i += 2) out.push({ first: items[i]!, second: items[i + 1] ?? null });
  return out;
}

/**
 * Direction of a posting line of "Движение по партньор" (05 6.6): a credit line
 * on a payable account or a debit line on a receivable account increases the
 * partner balance ("Задължения/вземания"); the opposite lines are settlements
 * ("Плащания"). Corrected: categories 19/55 are receivable and 20/54 payable
 * (the original swaps 19 and 20 and drops 54/55 in the direction clauses).
 */
export function movementLineDirection(categoryId: number | null | undefined, sign: number): 'increase' | 'settlement' | null {
  if (categoryId == null) return null;
  const payable = (SUPPLIER_CATEGORIES as readonly number[]).includes(categoryId);
  const receivable = (CLIENT_CATEGORIES as readonly number[]).includes(categoryId);
  if (!payable && !receivable) return null;
  if (payable) return sign < 0 ? 'increase' : 'settlement';
  return sign > 0 ? 'increase' : 'settlement';
}

/** Closing balances of an account as used by the statement formulas: fdb (final debit), fcb (final credit). */
export interface FinalBalance {
  closingDebit: DecInput;
  closingCredit: DecInput;
}

/**
 * Касова наличност и вземания (05 6.10), seeded formulas of the
 * "CashAndReceivables" statement type:
 *   cr1 = fdb(501) + fdb(502)                 cash on hand
 *   cr2 = fdb(493) - fcb(493)                 receivables from owners
 *   cr3 = fdb(422) - fcb(422) + fdb(429)      receivables from workers and accountable persons
 */
export const CASH_AND_RECEIVABLES_SECTIONS = [
  { key: 'availableCash', title: 'Наличност в касите', accounts: ['501', '502'] },
  { key: 'ownersReceivables', title: 'Вземания от собственици - физически лица', accounts: ['493'] },
  { key: 'workersReceivables', title: 'Вземания от работници, служители, лица по договор за управление и контрол и подотчетни лица', accounts: ['422', '429'] },
] as const;

export function cashAndReceivablesFormulas(bal: (account: string) => FinalBalance) {
  const fdb = (n: string) => dec(bal(n).closingDebit);
  const fcb = (n: string) => dec(bal(n).closingCredit);
  const availableCash = fdb('501').plus(fdb('502'));
  const ownersReceivables = fdb('493').minus(fcb('493'));
  const workersReceivables = fdb('422').minus(fcb('422')).plus(fdb('429'));
  const total = availableCash.plus(ownersReceivables).plus(workersReceivables);
  const f = (d: Dec) => d.toFixed(2);
  return { availableCash: f(availableCash), ownersReceivables: f(ownersReceivables), workersReceivables: f(workersReceivables), total: f(total) };
}

/**
 * Amount in words of a cash order (fnReport_NumberToText, 02c 1.10.3):
 * capitalised; the currency word follows the document date (BGN before
 * 2026-01-01, EUR from then on) unless the amount was converted to EUR.
 */
export function cashOrderAmountInWords(amount: DecInput, documentDate: string, convertedToEur = false): string {
  const iso = convertedToEur || documentDate >= '2026-01-01' ? 'EUR' : 'BGN';
  if (dec(amount).isNegative()) return '';
  return amountInWords(amount, iso, { capitalize: true });
}

/** "Филтър по" of the partner reports: case-insensitive substring on one column, or on any column ('all'). */
export function matchesColumnFilter(row: Record<string, unknown>, column: string, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const values = column && column !== 'all' ? [row[column]] : Object.values(row);
  const alt = q.replace(',', '.');
  return values.some((v) => {
    if (v === null || v === undefined || typeof v === 'object') return false;
    const s = String(v).toLowerCase();
    return s.includes(q) || s.includes(alt);
  });
}
