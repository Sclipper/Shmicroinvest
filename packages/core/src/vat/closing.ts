import { dec, ZERO, type Dec, type DecInput } from '../money.ts';
import { VAT_MESSAGES } from './constants.ts';
import type { ValidationMessage } from '../journal.ts';

/**
 * VAT period closing (Приключване на ДДС, spec 02b 9 and 20). Rows are
 * "Kt credit / Dt debit, amount" (the view model's DebitAccount is posted as
 * credit). Account roles: purchases 453/1 (cat. 16), sales 453/2 (17),
 * refund 453/8 (35), payable 453/9 (36).
 */
export type VatRole = 'purchases' | 'sales' | 'refund' | 'payable';

export interface ClosingRow {
  credit: VatRole;
  debit: VatRole;
  amount: Dec;
}

export interface ClosingInput {
  /** 453/1 debit minus credit turnover of the period. */
  purchases: DecInput;
  /** 453/2 credit minus debit turnover of the period. */
  sales: DecInput;
  /** Opening debit balance of the refund account 453/8. */
  refund?: DecInput;
  includeRefund?: boolean;
  alternative?: boolean;
}

export function vatClosingRows(i: ClosingInput): ClosingRow[] {
  const P = dec(i.purchases);
  const S = dec(i.sales);
  const R = dec(i.refund ?? 0);
  const D = P.minus(S).abs();
  const rows: ClosingRow[] = [];
  const push = (credit: VatRole, debit: VatRole, amount: Dec) => {
    if (!amount.isZero()) rows.push({ credit, debit, amount });
  };
  if (P.lessThan(0) || S.lessThan(0)) return rows;
  if (i.alternative) {
    // Gross variant, bug-compatible third row |P - S| (defect D1).
    if (!P.isZero()) push('purchases', 'refund', P);
    if (!S.isZero()) push('payable', 'sales', S);
    if (!P.isZero() && !S.isZero() && D.greaterThan(0)) push('refund', 'payable', D);
    return rows;
  }
  if (!P.isZero() && !S.isZero()) push('purchases', 'sales', P.lessThan(S) ? P : S);
  if (S.greaterThan(P)) {
    if (i.includeRefund && R.greaterThan(0)) {
      const used = R.lessThan(D) ? R : D;
      push('refund', 'sales', used);
      const rest = D.minus(R);
      if (rest.greaterThan(0)) push('payable', 'sales', rest);
    } else push('payable', 'sales', D);
  } else if (P.greaterThan(S)) push('purchases', 'refund', D);
  return rows;
}

/** Save-time checks of the closing rows (strInvalidNegativeAmount, strWrongAccountingMonth by the caller). */
export function validateClosingRows(rows: { amount: DecInput }[]): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  if (rows.some((r) => dec(r.amount).lessThan(0))) out.push({ key: 'strInvalidNegativeAmount', text: VAT_MESSAGES.strInvalidNegativeAmount, severity: 'critical' });
  return out;
}

export const closingRowsTotal = (rows: ClosingRow[]) => rows.reduce((a, r) => a.plus(r.amount), ZERO);
