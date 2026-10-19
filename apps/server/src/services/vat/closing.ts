import { dec, DOCUMENT_TYPE, fmtMessage, hasCritical, isMonthLocked, TRANSACTION_TYPE, VAT_MESSAGES, vatClosingRows, validateClosingRows, type ValidationMessage, type VatRole } from '@shmi/core';
import type { DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { accountBalancesMany } from '../reports.ts';
import { saveEntry } from '../journal.ts';
import { vatAccountsForYear, type VatAccountRef } from './load.ts';

/**
 * Приключване на ДДС (UI_Operations_AutoOperations_VAT, spec 02b 9 and 20).
 * Calculate builds the rows from the turnovers of 453/1, 453/2 and the
 * opening balance of 453/8; save posts one memorial order per row.
 */

export interface ClosingOptions {
  from: string;
  to: string;
  byExportMonth?: boolean;
  includeRefund?: boolean;
  alternative?: boolean;
}

const ROLE_LABEL: Record<VatRole, string> = { purchases: 'ДДС покупки', sales: 'ДДС продажби', refund: 'ДДС за възстановяване', payable: 'ДДС за внасяне' };

async function accounts(db: DbOrTx, year: number) {
  const a = await vatAccountsForYear(db, year);
  const missing: string[] = [];
  if (!a.purchases) missing.push('Начислен данък за покупките');
  if (!a.sales) missing.push('Начислен данък за продажбите');
  if (!a.refund) missing.push('ДДС за възстановяване');
  if (!a.payable) missing.push('ДДС за внасяне');
  return { a: a as Record<VatRole, VatAccountRef | undefined>, missing };
}

export async function calculateVatClosing(db: DbOrTx, year: ActiveYear, o: ClosingOptions) {
  const { a, missing } = await accounts(db, year.year);
  if (missing.length) {
    const text = `${VAT_MESSAGES.strVATAccountMissing} ${missing.join(', ')}`;
    return { purchases: '0.00', sales: '0.00', refund: '0.00', rows: [], messages: [{ key: 'strVATAccountMissing', text, severity: 'critical' } as ValidationMessage], balances: [], accounts: {} };
  }
  const period = { startDate: o.from, endDate: o.to, byExportMonth: o.byExportMonth };
  const many = await accountBalancesMany(db, [a.purchases!.number, a.sales!.number, a.refund!.number, a.payable!.number], period);
  const bal = {
    purchases: many.get(a.purchases!.number)!,
    sales: many.get(a.sales!.number)!,
    refund: many.get(a.refund!.number)!,
    payable: many.get(a.payable!.number)!,
  };
  const P = dec(bal.purchases.debitTurnover).minus(bal.purchases.creditTurnover);
  const S = dec(bal.sales.creditTurnover).minus(bal.sales.debitTurnover);
  const R = dec(bal.refund.openingDebit);
  const rows = vatClosingRows({ purchases: P, sales: S, refund: R, includeRefund: o.includeRefund && !o.alternative, alternative: o.alternative });
  const messages: ValidationMessage[] = [];
  const involved = new Set<VatRole>(rows.flatMap((r) => [r.credit, r.debit]));
  const withOpening = [...involved].filter((role) => !dec(bal[role].openingDebit).isZero() || !dec(bal[role].openingCredit).isZero()).map((role) => a[role]!.number);
  if (withOpening.length) messages.push({ key: 'strInitialBalanceWarning', text: fmtMessage('strInitialBalanceWarning', withOpening.join(', ')), severity: 'warning' });
  const ref = (role: VatRole) => ({ role, id: a[role]!.id, number: a[role]!.number, label: ROLE_LABEL[role] });
  return {
    purchases: P.toFixed(2), sales: S.toFixed(2), refund: R.toFixed(2),
    rows: rows.map((r) => ({ credit: ref(r.credit), debit: ref(r.debit), amount: r.amount.toFixed(2) })),
    messages,
    balances: (['purchases', 'sales', 'refund', 'payable'] as VatRole[]).map((role) => ({ ...ref(role), ...bal[role] })),
    accounts: Object.fromEntries((['purchases', 'sales', 'refund', 'payable'] as VatRole[]).map((role) => [role, ref(role)])),
  };
}

export interface ClosingSaveRow {
  creditAccountId: number;
  debitAccountId: number;
  amount: string;
}

/** One memorial order per row, dated `to`, term strConcludeVAT, VAT term 1, credit line first. */
export async function saveVatClosing(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, to: string, rows: ClosingSaveRow[]) {
  const messages = validateClosingRows(rows);
  const month = Number(to.slice(5, 7));
  if (Number(to.slice(0, 4)) !== ctx.year.year) messages.push({ key: 'strWrongAccountingDate', text: VAT_MESSAGES.strWrongAccountingDate, severity: 'critical' });
  else if (isMonthLocked(ctx.year.lockedMonths, month)) messages.push({ key: 'strWrongAccountingMonth', text: VAT_MESSAGES.strWrongAccountingMonth, severity: 'critical' });
  if (!rows.length) messages.push({ key: 'strSumCannotBeZero', text: VAT_MESSAGES.strSumCannotBeZero, severity: 'critical' });
  if (hasCritical(messages)) throw new ApiError(422, messages.find((m) => m.severity === 'critical')!.text, messages);
  const created: { id: number; number: string }[] = [];
  for (const r of rows) {
    if (dec(r.amount).isZero()) continue;
    const res = await saveEntry(db, {
      accountingDate: to, documentDate: to, documentTypeId: DOCUMENT_TYPE.MemorialOrder, documentNumber: '',
      term: VAT_MESSAGES.strConcludeVAT, transactionTypeId: TRANSACTION_TYPE.NotSet, source: 'vat-close',
      credits: [{ accountId: r.creditAccountId, amount: dec(r.amount).toFixed(2), vatTermId: 1 }],
      debits: [{ accountId: r.debitAccountId, amount: dec(r.amount).toFixed(2), vatTermId: 1 }],
    }, { ...ctx, force: true });
    created.push({ id: res.id, number: res.number });
  }
  return { created };
}
