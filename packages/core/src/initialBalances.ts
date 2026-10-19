import { dec, type DecInput } from './money.ts';

/**
 * Opening balances with payments (01b 7, strInitialBalancesExistingPaymentWarning/Error).
 *
 * Saving an account's opening balances replaces its opening entries. A row
 * that payments are bound to (AccountingPaymentDetails) keeps its payments
 * when it is saved again with the same partner and document, on the same side
 * and for at least the paid amount; they are re-attached to the new entry.
 * A row that disappears loses its payments (warning, saved after confirmation);
 * a row that shrinks below the paid amount or changes side cannot be saved (error).
 */
export const INITIAL_BALANCE_PAYMENT_MESSAGES = {
  strInitialBalancesExistingPaymentWarning: 'Към началните салда има въведени плащания, чиито връзки ще бъдат изтрити. Желаете ли да продължите?',
  strInitialBalancesExistingPaymentError: 'Началното салдо не може да бъде по-малко от сумата на въведените към него плащания!',
} as const;

export interface OpeningRowState {
  /** Partner and document of the row (see openingRowKey). */
  key: string;
  debit: DecInput;
  credit: DecInput;
}

export interface PaidOpeningRow extends OpeningRowState {
  /** Sum of the payment links of the row's entry. */
  paid: DecInput;
}

export type OpeningPaymentOutcome = 'relink' | 'unlink' | 'tooSmall';

/** Identity of an opening row across saves: partner + document type + number (no document: partner only). */
export function openingRowKey(companyId: number | null | undefined, documentTypeId?: number | null, documentNumber?: string | null) {
  const number = documentNumber?.trim() ?? '';
  return documentTypeId || number ? `${companyId ?? 0}|${documentTypeId ?? 0}|${number}` : `${companyId ?? 0}|`;
}

/** What happens to the payments of each paid old row when the account is saved with `next`. */
export function openingPaymentOutcomes(old: PaidOpeningRow[], next: OpeningRowState[]): { key: string; outcome: OpeningPaymentOutcome }[] {
  const out: { key: string; outcome: OpeningPaymentOutcome }[] = [];
  for (const o of old) {
    const paid = dec(o.paid).abs();
    if (paid.isZero()) continue;
    const n = next.find((x) => x.key === o.key);
    const nd = dec(n?.debit ?? 0);
    const nc = dec(n?.credit ?? 0);
    if (!n || (nd.isZero() && nc.isZero())) {
      out.push({ key: o.key, outcome: 'unlink' });
      continue;
    }
    const wasDebit = !dec(o.debit).isZero();
    const isDebit = !nd.isZero();
    const amount = isDebit ? nd : nc;
    out.push({ key: o.key, outcome: wasDebit !== isDebit || amount.abs().lessThan(paid) ? 'tooSmall' : 'relink' });
  }
  return out;
}
