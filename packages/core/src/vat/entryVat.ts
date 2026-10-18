import { dec, round2, sum, type Dec, type DecInput } from '../money.ts';
import type { ValidationMessage } from '../journal.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { VAT_DOC, VAT_MESSAGES, type VatMessageKey } from './constants.ts';

/** VAT assists and checks of the accounting screen (spec 02b 1.4, 1.5, 12). */

export interface VatCalcLine {
  amount: DecInput;
  /** null = the entry's VAT term. */
  vatTermId: number | null;
  /** Debit side: account of category 16; credit side: category 17. */
  isVat: boolean;
}

/**
 * Calculate VAT (F8): each VAT line gets round(sum of the other non-VAT lines
 * of its side with the same term x rate / 100, 2, away from zero). Returns the
 * new amount per line (null for lines that are not VAT lines).
 */
export function calculateVatAmounts(lines: VatCalcLine[], entryTermId: number | null, rateOf: (termId: number) => DecInput): (Dec | null)[] {
  const term = (l: VatCalcLine) => l.vatTermId ?? entryTermId;
  return lines.map((l, i) => {
    if (!l.isVat) return null;
    const t = term(l);
    if (t == null) return null;
    const base = sum(lines.filter((o, j) => j !== i && !o.isVat && term(o) === t).map((o) => o.amount));
    return round2(base.times(dec(rateOf(t))).div(100));
  });
}

/** Terms offered for a transaction type; default = configured term if set, else the first of the list. */
export function vatTermsFor<T extends { id: number; transactionTypeId: number }>(terms: T[], transactionTypeId: number, configured?: number | null): { list: T[]; defaultId: number | null } {
  const list = terms.filter((t) => t.transactionTypeId === transactionTypeId);
  const def = configured && list.some((t) => t.id === configured) ? configured : (list[0]?.id ?? null);
  return { list, defaultId: def };
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

export interface VatEntryCheck {
  transactionTypeId: number;
  documentTypeId: number | null;
  documentDate: string;
  viesMonth: string;
  /** Sum of the debit lines. */
  debitTotal: DecInput;
  /** VAT terms used on the lines. */
  lineTerms: number[];
  hasVatPurchaseAccount: boolean;
  hasVatSaleAccount: boolean;
  /** Another entry with the same document exists (server lookup). */
  duplicateExists?: boolean;
}

/**
 * VAT checks of the save pipeline. `messages` are Critical/NonCritical,
 * `confirm` are Yes/No questions (the save continues only when confirmed).
 */
export function validateVatEntry(e: VatEntryCheck): { messages: ValidationMessage[]; confirm: ValidationMessage[] } {
  const messages: ValidationMessage[] = [];
  const confirm: ValidationMessage[] = [];
  const crit = (key: VatMessageKey) => messages.push({ key, text: VAT_MESSAGES[key], severity: 'critical' });
  const ask = (key: VatMessageKey) => confirm.push({ key, text: VAT_MESSAGES[key], severity: 'warning' });
  const tt = e.transactionTypeId;
  const isDeal = tt === TRANSACTION_TYPE.Sale || tt === TRANSACTION_TYPE.Purchase;

  if (e.documentTypeId === VAT_DOC.CallOffSendRegister && tt !== TRANSACTION_TYPE.Sale) crit('strDocumentWithSaleAttention');
  if (e.documentTypeId === VAT_DOC.CallOffReceiveRegister && tt !== TRANSACTION_TYPE.Purchase) crit('strDocumentWithPurchaseAttention');
  if (tt === TRANSACTION_TYPE.Purchase && !e.hasVatPurchaseAccount) crit('strVatPurchasesAccountNotDefined');
  if (tt === TRANSACTION_TYPE.Sale && !e.hasVatSaleAccount) crit('strVatSalesAccountNotDefined');

  if (isDeal && e.viesMonth && e.documentDate) {
    const diff = monthIndex(e.documentDate) - monthIndex(e.viesMonth);
    if (diff > 0) ask('strAskIfViesMonthIsBeforeDocumentDate');
    if (Math.abs(diff) > 13 && !e.lineTerms.includes(3)) ask('strViesMonthAfterTaxCredit');
  }
  if (isDeal && e.documentTypeId === VAT_DOC.CreditNote && dec(e.debitTotal).greaterThanOrEqualTo(0)) ask('strCreditNoteAmountConfirmation');
  if (isDeal && e.duplicateExists) ask('strDuplicatedDocumentWarning');
  return { messages, confirm };
}
