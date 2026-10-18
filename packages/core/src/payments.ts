import { dec, round2, sum, ZERO, type Dec, type DecInput } from './money.ts';
import { KEYWORDS } from './seeds/lookups.ts';

/**
 * Payments, binding and documents closing (spec 02a 8.2 and 10, 04b 1.9,
 * 07 3.3). Pure rules: allocation walks, binding by number / by sum, the
 * three documents-closing pairing modes and the messages of the area.
 */

export const PAYMENT_MESSAGES = {
  strMissingDocumentNumberInPayment: "'Автоматично разплащане' е активиран. Не е въведен номер на документ за Разплащане!",
  strPaymentWarning: "Може да използвате 'Автоматично разплащане' или 'Разплащане' вдясно!",
  strInvalidDebitCreditPaymentAmounts: 'Сумите въведени в дебит и кредит на разплащането се различават!',
  strDifferentExchangeRatesInAccountingsError: 'Избраните документи за обвързване са с различни валутни курсове. Документите няма да бъдат обвързани. Желаете ли да продължите?',
  strDifferentAmountInPaymentAndBindingDoc: 'Сумата на автоматичното разплащане е по-голяма или равна на сумата на контировката. Документите няма да бъдат обвързани. Желаете ли да продължите?',
  strDifferentExchangeRatesInDocumentsError: 'Избраните документи са с различни валутни курсове. Операцията не може да бъде записана.',
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strWrongAccountingMonth: 'Датата на контирането обхваща заключен месец/период!',
  strLockedMonthOperation: 'Операцията, която се опитвате да извършите, обхваща заключен месец/период!',
  strDocumentsForLiabilitiesAndClaims: 'Документи за задължения и вземания',
  strDocumentsForExistingPayments: 'Документи за съществуващи плащания',
  strDocumentLiability: 'Задължение',
  strDocumentLevy: 'Вземане',
  strDocumentPayment: 'Плащане',
  // Rebuild texts (no Delta key found in the spec for these conditions).
  strPaymentAccountMissing: 'Не е избрана сметка за разплащане!',
  strPaymentAmountMissing: 'Не е въведена сума за разплащане!',
  strNoDocumentsSelected: 'Не са избрани документи за разплащане!',
  strNoPaymentsSelected: 'Не са избрани документи за плащане!',
  strPaymentExceedsOpenAmount: 'Сумата за разплащане на документ {0} надвишава неплатената сума ({1})!',
  strAllocationExceedsPayment: 'Сумата на обвързаните документи надвишава сумата на плащането!',
  strDifferentPartnerOrAccount: 'Избраните документи трябва да бъдат към един и същ партньор и сметка!',
  strNoPartnerLineForPayment: 'В контирането няма сметка с партньор, по която да се извърши разплащане!',
  strNoPairsSelected: 'Няма избрани документи за закриване!',
  strDocumentsClosed: 'Документите са закрити успешно.',
  strPaymentSaved: 'Разплащането е записано успешно.',
} as const;

export type PaymentMessageKey = keyof typeof PAYMENT_MESSAGES;

export function paymentMessage(key: PaymentMessageKey, ...args: (string | number)[]): string {
  return args.reduce<string>((t, a, i) => t.replace(`{${i}}`, String(a)), PAYMENT_MESSAGES[key]);
}

/* ------------------------------------------------------------------ */
/* Allocation walk                                                      */
/* ------------------------------------------------------------------ */

export interface AllocSide<Id> {
  id: Id;
  /** Positive amount still open. */
  amount: DecInput;
  currencyAmount?: DecInput;
}

export interface Allocation<L, P> {
  liabilityId: L;
  paymentId: P;
  amount: Dec;
  currencyAmount: Dec;
}

/**
 * Partial-allocation walk (CloseDocumentsForImport, 02a 10): two cursors;
 * each step allocates min(remaining liability, remaining payment) and advances
 * the side that reaches zero. Currency amounts are allocated in proportion and
 * follow the same cursor (the last step of a side takes its remainder).
 */
export function allocateWalk<L, P>(liabilities: AllocSide<L>[], payments: AllocSide<P>[]): Allocation<L, P>[] {
  const out: Allocation<L, P>[] = [];
  const ls = liabilities.map((l) => ({ id: l.id, rem: round2(dec(l.amount).abs()), cur: round2(dec(l.currencyAmount ?? 0).abs()) }));
  const ps = payments.map((p) => ({ id: p.id, rem: round2(dec(p.amount).abs()) }));
  let i = 0, j = 0;
  while (i < ls.length && j < ps.length) {
    const l = ls[i]!, p = ps[j]!;
    if (l.rem.lessThanOrEqualTo(0)) { i++; continue; }
    if (p.rem.lessThanOrEqualTo(0)) { j++; continue; }
    const amt = l.rem.lessThan(p.rem) ? l.rem : p.rem;
    // Currency share of the liability: all of it when the liability is exhausted, else pro rata.
    const cur = amt.equals(l.rem) ? l.cur : round2(l.cur.times(amt).div(l.rem));
    out.push({ liabilityId: l.id, paymentId: p.id, amount: amt, currencyAmount: cur });
    l.rem = l.rem.minus(amt);
    l.cur = l.cur.minus(cur);
    p.rem = p.rem.minus(amt);
    if (l.rem.isZero()) i++;
    if (p.rem.isZero()) j++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Invoice numbers (04b 1.9)                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalise a document number for matching: trim; with letters -> pad left
 * with '0' to 10; containing '-' or '*' -> unchanged; digits only -> pad to
 * 10 and keep the last 7 digits.
 */
export function normalizeInvoiceNumber(input: string): string {
  const s = input.trim();
  if (/[A-Za-zА-Яа-я]/.test(s)) return s.padStart(10, '0');
  if (/[-*]/.test(s)) return s;
  if (/^\d+$/.test(s)) return s.padStart(10, '0').slice(-7);
  return s;
}

/** Invoice numbers mentioned in a payment reason after one of the keywords. */
export function extractInvoiceNumbers(reason: string, keywords: readonly string[] = KEYWORDS): string[] {
  const found = new Set<string>();
  const lower = reason.toLowerCase();
  const visit = (text: string, depth: number) => {
    if (depth > 10) return;
    const low = text.toLowerCase();
    for (const kw of keywords) {
      const at = low.indexOf(kw);
      if (at < 0) continue;
      // Keyword must start a word.
      if (at > 0 && /[a-zа-я0-9]/i.test(low[at - 1]!)) continue;
      const after = text.slice(at + kw.length).trim();
      if (after.toLowerCase().includes(kw) && depth < 10) visit(after, depth + 1);
      for (const tok of after.split(/[,;/\s]+/)) {
        if (!/\d/.test(tok)) continue;
        const clean = tok.replace(/[^0-9A-Za-zА-Яа-я*-]/g, '');
        if (!clean) continue;
        const parts = clean.split(/[-*]/);
        if (/[-*]/.test(clean) && parts.length === 2) {
          const series = parts[0]!, num = parts[1]!;
          found.add(normalizeInvoiceNumber(series + num.padStart(Math.max(0, 10 - series.length), '0')));
        } else found.add(normalizeInvoiceNumber(clean));
      }
    }
  };
  if (lower) visit(reason, 0);
  return [...found];
}

export interface BindCandidate<Id> {
  id: Id;
  documentNumber: string;
  /** |open amount| of the document. */
  amount: DecInput;
  isInvoice?: boolean;
}

/**
 * Binding by number (04b 1.9 step 1): documents whose normalised number is in
 * the extracted set, invoice-type documents first; add each until the sum of
 * |amounts| >= |amount|.
 */
export function bindByNumber<Id>(numbers: string[], docs: BindCandidate<Id>[], amount: DecInput): BindCandidate<Id>[] {
  const wanted = new Set(numbers.map(normalizeInvoiceNumber));
  const target = dec(amount).abs();
  const cand = docs.filter((d) => wanted.has(normalizeInvoiceNumber(d.documentNumber)));
  cand.sort((a, b) => Number(Boolean(b.isInvoice)) - Number(Boolean(a.isInvoice)));
  const out: BindCandidate<Id>[] = [];
  let acc = ZERO;
  for (const d of cand) {
    if (acc.greaterThanOrEqualTo(target)) break;
    out.push(d);
    acc = acc.plus(dec(d.amount).abs());
  }
  return out;
}

/** Subset search limit: 2^20 masks at most. */
export const BIND_BY_SUM_MAX = 20;

/**
 * Binding by sum (04b 1.9 step 2): the FIRST subset (bit masks 1..2^n-1 in
 * order) whose sum of |amounts| equals the amount exactly; [] if none. Only
 * the first BIND_BY_SUM_MAX candidates take part (the original is O(2^n)).
 */
export function bindBySum<Id>(docs: BindCandidate<Id>[], amount: DecInput): BindCandidate<Id>[] {
  const target = round2(dec(amount).abs());
  const list = docs.slice(0, BIND_BY_SUM_MAX);
  const cents = list.map((d) => round2(dec(d.amount).abs()).times(100).toNumber());
  const goal = target.times(100).toNumber();
  const n = list.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    for (let b = 0; b < n; b++) if (mask & (1 << b)) s += cents[b]!;
    if (s === goal) return list.filter((_, b) => mask & (1 << b));
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Documents closing (02a 10)                                           */
/* ------------------------------------------------------------------ */

export type ClosingMode = 'document' | 'amount' | 'optionalReference';

export const CLOSING_MODES: { id: ClosingMode; key: string; label: string; text: string }[] = [
  {
    id: 'document', key: 'strDocumentClosingOnDocument', label: 'Прихващане по документ',
    text: 'Прихващане по документ - автоматично закриване на един и същ тип документи (Ф-ра, ДИ), с един и същи номер към един партньор в противоположни посоки на разчета.',
  },
  {
    id: 'amount', key: 'strDocumentClosingOnAmount', label: 'Прихващане по сума',
    text: 'Прихващане по сума - автоматично закриване на различен тип документи (Ф-ра, ДИ с РКО, ПКО, КИ и т.н.) към един партньор с равни суми в противоположни посоки на разчета.',
  },
  {
    id: 'optionalReference', key: 'strDocumentClosingOnOptionalReference', label: 'Прихващане по втора забележка',
    text: 'Прихващане по втора забележка - автоматично закриване на документи към един партньор с еднаква втора забележка в противоположни посоки на разчета.',
  },
];

export interface ClosingItem {
  accountingId: number;
  accountingDate: string;
  accountId: number;
  companyId: number;
  side: 'client' | 'supplier';
  kind: 'liability' | 'payment' | 'none';
  documentTypeId: number | null;
  documentNumber: string;
  optionalReference: string;
  /** Signed open amount (debit positive). */
  open: DecInput;
  openCurrency?: DecInput;
}

export interface ClosingPair<T extends ClosingItem> {
  liability: T;
  payment: T;
  amount: Dec;
  currencyAmount: Dec;
}

/** "007" = "7": purely numeric numbers lose their leading zeros. */
export function normalizeNumericNumber(n: string): string {
  const s = n.trim();
  return /^\d+$/.test(s) ? String(BigInt(s)) : s;
}

/** Group key of a mode; null = the item does not take part. */
export function closingKey(mode: ClosingMode, i: ClosingItem): string | null {
  const base = `${i.accountId}|${i.companyId}|${i.side}`;
  if (mode === 'document') {
    if (!i.documentNumber.trim() || i.documentTypeId == null) return null;
    return `${base}|${i.documentTypeId}|${normalizeNumericNumber(i.documentNumber)}`;
  }
  if (mode === 'amount') return `${base}|${round2(dec(i.open).abs()).toFixed(2)}`;
  const ref = i.optionalReference ?? '';
  if (!ref.trim()) return null;
  return `${base}|${ref}`;
}

/**
 * Manual documents closing: per group, liabilities and payments ordered by
 * accounting date; the i-th liability is paired with the i-th payment; the
 * pair amount is min(|bal1|, |bal2|) (currency: min of the currency balances).
 */
export function pairForClosing<T extends ClosingItem>(items: T[], mode: ClosingMode): ClosingPair<T>[] {
  const groups = new Map<string, { l: T[]; p: T[] }>();
  for (const it of items) {
    if (it.kind === 'none') continue;
    const k = closingKey(mode, it);
    if (k == null) continue;
    const g = groups.get(k) ?? { l: [], p: [] };
    (it.kind === 'liability' ? g.l : g.p).push(it);
    groups.set(k, g);
  }
  const byDate = (a: T, b: T) => (a.accountingDate < b.accountingDate ? -1 : a.accountingDate > b.accountingDate ? 1 : a.accountingId - b.accountingId);
  const out: ClosingPair<T>[] = [];
  for (const g of groups.values()) {
    g.l.sort(byDate);
    g.p.sort(byDate);
    for (let i = 0; i < Math.min(g.l.length, g.p.length); i++) {
      const l = g.l[i]!, p = g.p[i]!;
      const a1 = dec(l.open).abs(), a2 = dec(p.open).abs();
      const c1 = dec(l.openCurrency ?? 0).abs(), c2 = dec(p.openCurrency ?? 0).abs();
      out.push({ liability: l, payment: p, amount: a1.lessThan(a2) ? a1 : a2, currencyAmount: c1.lessThan(c2) ? c1 : c2 });
    }
  }
  return out.sort((x, y) => byDate(x.liability, y.liability));
}

/**
 * Import-mode closing (CloseDocumentsForImport): per (account, partner, side)
 * the cursor walk of `allocateWalk`, first among the imported items, then the
 * imported items against the existing ones.
 */
export function closeForImport<T extends ClosingItem>(imported: T[], existing: T[]): ClosingPair<T>[] {
  const out: ClosingPair<T>[] = [];
  const key = (i: T) => `${i.accountId}|${i.companyId}|${i.side}`;
  const remaining = new Map<T, Dec>();
  const remainingCur = new Map<T, Dec>();
  for (const i of [...imported, ...existing]) {
    remaining.set(i, dec(i.open).abs());
    remainingCur.set(i, dec(i.openCurrency ?? 0).abs());
  }
  const run = (ls: T[], ps: T[]) => {
    const groups = new Map<string, { l: T[]; p: T[] }>();
    for (const i of ls) if (i.kind === 'liability') { const g = groups.get(key(i)) ?? { l: [], p: [] }; g.l.push(i); groups.set(key(i), g); }
    for (const i of ps) if (i.kind === 'payment') { const g = groups.get(key(i)) ?? { l: [], p: [] }; g.p.push(i); groups.set(key(i), g); }
    for (const g of groups.values()) {
      const byDate = (a: T, b: T) => (a.accountingDate < b.accountingDate ? -1 : a.accountingDate > b.accountingDate ? 1 : a.accountingId - b.accountingId);
      g.l.sort(byDate); g.p.sort(byDate);
      const allocs = allocateWalk(
        g.l.map((l) => ({ id: l, amount: remaining.get(l)!, currencyAmount: remainingCur.get(l)! })),
        g.p.map((p) => ({ id: p, amount: remaining.get(p)!, currencyAmount: remainingCur.get(p)! })),
      );
      for (const a of allocs) {
        remaining.set(a.liabilityId, remaining.get(a.liabilityId)!.minus(a.amount));
        remaining.set(a.paymentId, remaining.get(a.paymentId)!.minus(a.amount));
        remainingCur.set(a.liabilityId, Decimal0(remainingCur.get(a.liabilityId)!.minus(a.currencyAmount)));
        remainingCur.set(a.paymentId, Decimal0(remainingCur.get(a.paymentId)!.minus(a.currencyAmount)));
        out.push({ liability: a.liabilityId, payment: a.paymentId, amount: a.amount, currencyAmount: a.currencyAmount });
      }
    }
  };
  run(imported, imported);
  run(imported, existing);
  run(existing, imported);
  return out;
}

const Decimal0 = (d: Dec) => (d.lessThan(0) ? ZERO : d);

/** Operation-type label of an open item (strDocumentLiability / strDocumentLevy / strDocumentPayment). */
export function operationLabel(side: 'client' | 'supplier', kind: 'liability' | 'payment' | 'none'): string {
  if (kind === 'payment') return PAYMENT_MESSAGES.strDocumentPayment;
  if (kind === 'liability') return side === 'client' ? PAYMENT_MESSAGES.strDocumentLevy : PAYMENT_MESSAGES.strDocumentLiability;
  return '';
}

/* ------------------------------------------------------------------ */
/* Payment validation                                                   */
/* ------------------------------------------------------------------ */

export interface PaymentAllocationCheck {
  label: string;
  /** Requested allocation (positive). */
  amount: DecInput;
  /** |open| of the document. */
  open: DecInput;
  exchangeRate?: DecInput;
}

/**
 * Checks the amounts of a payment against the selected documents: every
 * allocation <= the document's open amount, Σ allocations <= payment amount,
 * documents of a currency account share one exchange rate.
 */
export function validatePaymentAllocations(paymentAmount: DecInput, rows: PaymentAllocationCheck[], isCurrency = false): { key: PaymentMessageKey; text: string }[] {
  const out: { key: PaymentMessageKey; text: string }[] = [];
  for (const r of rows) {
    if (round2(r.amount).greaterThan(round2(dec(r.open).abs()))) {
      out.push({ key: 'strPaymentExceedsOpenAmount', text: paymentMessage('strPaymentExceedsOpenAmount', r.label, round2(dec(r.open).abs()).toFixed(2)) });
    }
  }
  if (round2(sum(rows.map((r) => r.amount))).greaterThan(round2(dec(paymentAmount).abs()))) {
    out.push({ key: 'strAllocationExceedsPayment', text: PAYMENT_MESSAGES.strAllocationExceedsPayment });
  }
  if (isCurrency && !sameExchangeRate(rows.map((r) => r.exchangeRate ?? 0))) {
    out.push({ key: 'strDifferentExchangeRatesInDocumentsError', text: PAYMENT_MESSAGES.strDifferentExchangeRatesInDocumentsError });
  }
  return out;
}

/** True when all non-zero rates are equal (compared at 5 decimals, the rate format). */
export function sameExchangeRate(rates: DecInput[]): boolean {
  const set = new Set(rates.map((r) => dec(r)).filter((r) => !r.isZero()).map((r) => r.toDecimalPlaces(5).toFixed(5)));
  return set.size <= 1;
}
