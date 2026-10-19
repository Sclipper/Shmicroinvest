import { dec, round2, sum, ZERO, type Dec, type DecInput } from './money.ts';
import { isMonthLocked } from './financialYear.ts';
import { isCompanyCategory } from './categories.ts';
import { DOCUMENT_TYPE, TRANSACTION_TYPE } from './seeds/lookups.ts';
import { currencyShares } from './journalExtras.ts';

/**
 * Journal entry model (spec 01a section 8 and 02a section 1).
 *
 * The editor works with debit lines and credit lines. Storage is a list of
 * legs: each debit/credit pair becomes two detail rows, a debit leg
 * (Sign +1, amount in Amount) and a mirrored credit leg (Sign -1, amount in
 * RefAmount), each naming the other account in RefAccountID.
 */

export interface EntryLine {
  accountId: number;
  amount: DecInput;
  companyId?: number | null;
  vatTermId?: number;
  currency?: { currencyId: number; currencyAmount: DecInput; exchangeRate: DecInput; fixedRate: DecInput } | null;
  material?: { productId: number; quantity: DecInput; price: DecInput } | null;
}

export interface Leg {
  accountId: number;
  refAccountId: number;
  amount: Dec;
  refAmount: Dec;
  sign: 1 | -1;
  companyId: number | null;
  vatTermId: number;
  currency: EntryLine['currency'];
  material: EntryLine['material'];
}

/**
 * Save decomposition: if debit lines <= credit lines, the first debit line is
 * saved against every credit line, otherwise the first credit line against
 * every debit line (1:1, 1:n, n:1 only). Each pair -> two legs.
 */
export function buildLegs(debits: EntryLine[], credits: EntryLine[]): Leg[] {
  const legs: Leg[] = [];
  if (debits.length === 0 || credits.length === 0) return legs;
  const oneDebit = debits.length <= credits.length;
  const single = oneDebit ? debits[0]! : credits[0]!;
  const many = oneDebit ? credits : debits;
  if ((oneDebit ? debits : credits).length > 1) {
    throw new Error('Many-to-many entries are not supported by the editor');
  }
  for (const other of many) {
    const debit = oneDebit ? single : other;
    const credit = oneDebit ? other : single;
    // The pair amount is the "many" side's line amount; the single side's
    // currency/material share is split proportionally (last takes remainder).
    const amount = round2(other.amount);
    legs.push({
      accountId: debit.accountId,
      refAccountId: credit.accountId,
      amount,
      refAmount: ZERO,
      sign: 1,
      companyId: debit.companyId ?? null,
      vatTermId: debit.vatTermId ?? 1,
      currency: oneDebit ? null : debit.currency ?? null,
      material: oneDebit ? null : debit.material ?? null,
    });
    legs.push({
      accountId: credit.accountId,
      refAccountId: debit.accountId,
      amount: ZERO,
      refAmount: amount,
      sign: -1,
      companyId: credit.companyId ?? null,
      vatTermId: credit.vatTermId ?? 1,
      currency: oneDebit ? credit.currency ?? null : null,
      material: oneDebit ? credit.material ?? null : null,
    });
  }
  // The single side's currency/material legs: attach its share to each of its legs.
  const singleLegs = legs.filter((l) => l.sign === (oneDebit ? 1 : -1));
  distributeAnalytics(single, singleLegs);
  return legs;
}

function distributeAnalytics(line: EntryLine, legs: Leg[]) {
  const total = sum(legs.map((l) => l.amount.plus(l.refAmount)));
  if (line.currency) {
    // 02a 2: each share = round2(share amount / rate), the last takes the remainder.
    const shares = currencyShares(line.currency.currencyAmount, legs.map((l) => l.amount.plus(l.refAmount)), line.currency.exchangeRate);
    legs.forEach((leg, i) => {
      leg.currency = { ...line.currency!, currencyAmount: shares[i]!.toFixed(2) };
    });
  }
  if (line.material) {
    const q = dec(line.material.quantity);
    let remaining = q;
    legs.forEach((leg, i) => {
      const legAmt = leg.amount.plus(leg.refAmount);
      const share = i === legs.length - 1 ? remaining : total.isZero() ? ZERO : q.times(legAmt).div(total).toDecimalPlaces(6);
      remaining = remaining.minus(share);
      leg.material = { ...line.material!, quantity: share.toString() };
    });
  }
}

/** Balance of a set of legs = SUM((Amount + RefAmount) * Sign); positive = debit. */
export function legBalance(legs: { amount: DecInput; refAmount: DecInput; sign: number }[]): Dec {
  return sum(legs.map((l) => dec(l.amount).plus(dec(l.refAmount)).times(l.sign)));
}

/** Rebuild editor lines from stored legs by summing per (account, partner) key and side. */
export function linesFromLegs<T extends { accountId: number; amount: DecInput; refAmount: DecInput; sign: number; companyId: number | null }>(
  legs: T[],
): { debits: { accountId: number; companyId: number | null; amount: Dec; legs: T[] }[]; credits: { accountId: number; companyId: number | null; amount: Dec; legs: T[] }[] } {
  const debitMap = new Map<string, { accountId: number; companyId: number | null; amount: Dec; legs: T[] }>();
  const creditMap = new Map<string, { accountId: number; companyId: number | null; amount: Dec; legs: T[] }>();
  for (const l of legs) {
    const map = l.sign > 0 ? debitMap : creditMap;
    const key = `${l.accountId}:${l.companyId ?? ''}`;
    const cur = map.get(key) ?? { accountId: l.accountId, companyId: l.companyId, amount: ZERO, legs: [] as T[] };
    cur.amount = cur.amount.plus(l.sign > 0 ? dec(l.amount) : dec(l.refAmount));
    cur.legs.push(l);
    map.set(key, cur);
  }
  return { debits: [...debitMap.values()], credits: [...creditMap.values()] };
}

// ---------------------------------------------------------------------------
// Validation (spec 02a section 4.3)

export type Severity = 'critical' | 'warning';
export interface ValidationMessage {
  key: string;
  text: string;
  severity: Severity;
  line?: { side: 'debit' | 'credit'; index: number };
}

export const JOURNAL_MESSAGES = {
  /** Stale-row update (ChangeConflictException, 01b 9): the entry changed after it was loaded. */
  strAccountingChangeConflict: 'Контирането е променено от друг потребител след зареждането му. Заредете го отново, за да видите промените.',
  strMissingValidDebitAccount: 'Не е въведена валидна сметка за дебит!',
  strMissingValidCreditAccount: 'Не е въведена валидна сметка за кредит!',
  strInvalidDebitCreditAmounts: 'Сумите въведени в дебит и кредит се различават!',
  strMissingCompany: 'Не е избран партньор!',
  strMissingDocumentType: 'Не е избран коректен тип на документ!',
  strMissingDocumentNumber: 'Не е въведен номер на документ!',
  strMissingTerm: 'Не е въведено основание!',
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strWrongAccountingMonth: 'Датата на контирането обхваща заключен месец/период!',
  strDocumentWithSaleAttention: 'Избраният документ следва да бъде с тип на сделката „Продажба“!',
  strDocumentWithPurchaseAttention: 'Избраният документ следва да бъде с тип на сделката „Покупка“!',
  strCreditNoteAmountWarning: 'При избран документ КИ, поле Сума е необходимо да се попълни с отрицателни стойности.',
  strInvalidAccount: 'Въведена е невалидна сметка!',
  strZeroAmountWarning: 'Въведена е нулева сума!',
  strManyToMany: 'Контирането може да бъде едно към едно, едно към много или много към едно.',
  strAccountNotLeaf: 'Сметката има подсметки. Изберете аналитична сметка.',
  strForeignCurrencyRequired: 'За валутна сметка е необходимо да въведете валутна сума и курс.',
  strMaterialRequired: 'За материална сметка е необходимо да въведете количество.',
  strCannotCompleteOperation: 'Операцията не може да бъде записана поради следните грешки:',
  strLockedMonthOperation: 'Операцията, която се опитвате да извършите, обхваща заключен месец/период!',
  strVoidAccountingLockedYearWarning: 'Има избрано контиране от заключена счетоводна година!',
  strReversalOperation: 'Сторно операция',
} as const;

export interface AccountInfo {
  id: number;
  number: string;
  isLeaf: boolean;
  categoryId: number | null;
  isForeignCurrency: boolean;
  isMaterial: boolean;
}

export interface EntryDraft {
  accountingDate: string; // yyyy-mm-dd
  documentTypeId: number | null;
  documentNumber: string;
  term: string;
  transactionTypeId: number;
  debits: EntryLine[];
  credits: EntryLine[];
  isInitialBalance?: boolean;
}

export interface ValidationContext {
  activeYear: number;
  lockedMonths: number;
  accounts: Map<number, AccountInfo>;
  /** Document types that imply a sale / purchase (derived by SetTransactionType). */
  saleDocumentTypes?: Set<number>;
  purchaseDocumentTypes?: Set<number>;
}

export function validateEntry(e: EntryDraft, ctx: ValidationContext): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  const crit = (key: keyof typeof JOURNAL_MESSAGES, line?: ValidationMessage['line']) =>
    out.push({ key, text: JOURNAL_MESSAGES[key], severity: 'critical', line });
  const warn = (key: keyof typeof JOURNAL_MESSAGES, line?: ValidationMessage['line']) =>
    out.push({ key, text: JOURNAL_MESSAGES[key], severity: 'warning', line });

  const validDebits = e.debits.filter((l) => ctx.accounts.has(l.accountId));
  const validCredits = e.credits.filter((l) => ctx.accounts.has(l.accountId));
  if (validDebits.length === 0) crit('strMissingValidDebitAccount');
  if (validCredits.length === 0) crit('strMissingValidCreditAccount');
  if (e.debits.length > 1 && e.credits.length > 1) crit('strManyToMany');

  const totalD = round2(sum(e.debits.map((l) => l.amount)));
  const totalC = round2(sum(e.credits.map((l) => l.amount)));
  if (!totalD.minus(totalC).isZero()) crit('strInvalidDebitCreditAmounts');

  const checkLines = (lines: EntryLine[], side: 'debit' | 'credit') => {
    lines.forEach((l, index) => {
      const acc = ctx.accounts.get(l.accountId);
      if (!acc) {
        crit('strInvalidAccount', { side, index });
        return;
      }
      if (!acc.isLeaf) crit('strAccountNotLeaf', { side, index });
      if (dec(l.amount).isZero()) warn('strZeroAmountWarning', { side, index });
      if (isCompanyCategory(acc.categoryId) && !l.companyId) crit('strMissingCompany', { side, index });
      if (acc.isForeignCurrency && (!l.currency || dec(l.currency.currencyAmount).isZero() || dec(l.currency.exchangeRate).isZero())) {
        if (!dec(l.amount).isZero()) crit('strForeignCurrencyRequired', { side, index });
      }
      if (acc.isMaterial && (!l.material || dec(l.material.quantity).isZero())) {
        warn('strMaterialRequired', { side, index });
      }
    });
  };
  checkLines(e.debits, 'debit');
  checkLines(e.credits, 'credit');

  if (!e.isInitialBalance) {
    if (!e.term.trim()) crit('strMissingTerm');
    if (e.documentTypeId == null) crit('strMissingDocumentType');
    else if (!e.documentNumber.trim() && requiresDocumentNumber(e.documentTypeId)) crit('strMissingDocumentNumber');
  }

  const [y, m] = e.accountingDate.split('-').map(Number);
  if (y !== ctx.activeYear) crit('strWrongAccountingDate');
  else if (isMonthLocked(ctx.lockedMonths, m!)) crit('strWrongAccountingMonth');

  if (e.documentTypeId != null) {
    if (ctx.saleDocumentTypes?.has(e.documentTypeId) && e.transactionTypeId !== TRANSACTION_TYPE.Sale) crit('strDocumentWithSaleAttention');
    if (ctx.purchaseDocumentTypes?.has(e.documentTypeId) && e.transactionTypeId !== TRANSACTION_TYPE.Purchase) crit('strDocumentWithPurchaseAttention');
    if (e.documentTypeId === DOCUMENT_TYPE.CreditNote && totalD.greaterThanOrEqualTo(0)) warn('strCreditNoteAmountWarning');
  }
  return out;
}

/** Documents that carry a NAP code require a document number. */
export function requiresDocumentNumber(documentTypeId: number): boolean {
  return [1, 2, 3, 4, 5, 6, 7, 13, 25, 26, 27, 28, 29, 30, 31, 34, 36, 37, 38, 39, 40, 41, 42, 43].includes(documentTypeId);
}

export function hasCritical(msgs: ValidationMessage[]): boolean {
  return msgs.some((m) => m.severity === 'critical');
}

/**
 * Reversal (red storno, spec 02a 5.2): same accounts, every amount, currency
 * amount and quantity negated, term "Сторно операция", reference
 * "<doc type name> <doc number>".
 */
export function reverseLines(lines: EntryLine[]): EntryLine[] {
  return lines.map((l) => ({
    ...l,
    amount: dec(l.amount).negated().toFixed(2),
    currency: l.currency
      ? { ...l.currency, currencyAmount: dec(l.currency.currencyAmount).isZero() ? l.currency.currencyAmount : dec(l.currency.currencyAmount).negated().toFixed(2) }
      : l.currency,
    material: l.material
      ? { ...l.material, quantity: dec(l.material.quantity).isZero() ? l.material.quantity : dec(l.material.quantity).negated().toString() }
      : l.material,
  }));
}

/** Row calculations (spec 02a section 2). */
export function amountFromCurrency(currencyAmount: DecInput, rate: DecInput): Dec {
  return round2(dec(currencyAmount).times(dec(rate)));
}
export function currencyFromAmount(amount: DecInput, rate: DecInput): Dec {
  const r = dec(rate);
  return r.isZero() ? ZERO : round2(dec(amount).div(r));
}
export function amountFromQuantity(quantity: DecInput, price: DecInput): Dec {
  return round2(dec(quantity).times(dec(price)));
}
export function exchangeRateOf(amount: DecInput, currencyAmount: DecInput): Dec {
  const c = dec(currencyAmount);
  return c.isZero() ? ZERO : dec(amount).div(c).toDecimalPlaces(6);
}
export function priceOf(amount: DecInput, quantity: DecInput): Dec {
  const q = dec(quantity);
  return q.isZero() ? ZERO : dec(amount).div(q).toDecimalPlaces(6);
}
