import { BGN_PER_EUR, D, dec, round2, sum, ZERO, type Dec, type DecInput } from './money.ts';
import { isCompanyCategory } from './categories.ts';

/**
 * Closing of income/expense accounts (spec 02c section 3) and the balance
 * rules of the year-end transfer (spec 01b 6.4).
 */

export const CLOSING_MESSAGES = {
  strInvalidConcludeAmount: 'Въведете положително число по-малко от оборота.',
  strInvalidConcludeToAccount: 'Не са избрани сметки, към които да се извърши приключване!',
  strInvalidConcludeAccountsPercent: 'Не е въведена коректна относителна стойност на коефициента (процент)!',
  strInvalidSumPercent: 'Сумата на всички проценти трябва да е положително число по-малко от 100.',
  strInvalidSumPercentDistribution: 'При разпределение по проценти сумата на процентите трябва да е точно 100.',
  strInvalidConcludeAccountsNumber: 'Няма избрани сметки за приключване.',
  strInitialBalanceWarning: 'Следните сметки имат начални салда: {0}.',
  strWrongAccountingMonth: 'Датата на контирането обхваща заключен месец/период!',
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strNoFinancialYear: 'Не е намерена счетоводна година за избраната дата!',
  strAutoConcludeChartOfAccounts: 'Автоматично приключване на сметки',
  strSuccessfulAutoConclude: 'Сметките са успешно приключени.',
  strNothingToConclude: 'Няма сметки за приключване за избрания период.',
} as const;

export type ConcludeMode = 'costs' | 'economic' | 'revenue';

export interface ConcludeModeDef {
  id: ConcludeMode;
  /** Combo text. */
  text: string;
  /** Term of the posted entries. */
  term: string;
  /** Closes debit balances (credit the source) — expense modes. */
  isDebitType: boolean;
  /** Percent distribution (algorithm B) offered. */
  allowsPercent: boolean;
  /** Auto-distribution basis: credit turnover of the targets (group-60 mode) instead of debit turnover. */
  creditDistribution: boolean;
}

/** The three fixed modes (multi-class file of ConcludeCustomAccountsViewModel). Default: group 60. */
export const CONCLUDE_MODES: ConcludeModeDef[] = [
  { id: 'costs', text: 'Разходи', term: 'Приключване на разходи', isDebitType: true, allowsPercent: true, creditDistribution: false },
  { id: 'economic', text: 'Разходи по икономически елементи', term: 'Приключване на група 60', isDebitType: true, allowsPercent: true, creditDistribution: true },
  { id: 'revenue', text: 'Приходи', term: 'Приключване на приходи', isDebitType: false, allowsPercent: false, creditDistribution: false },
];
export const concludeMode = (id: ConcludeMode) => CONCLUDE_MODES.find((m) => m.id === id)!;

/** Categories 601..609 (Разходи по икономически елементи). */
export const ECONOMIC_ELEMENT_CATEGORIES = [37, 38, 39, 40, 41, 42, 43, 44, 45] as const;
/** Excluded from "Разходи": 601-609, acquisition (613) and liquidation (616) of fixed assets, deferred costs (651, 652). */
export const COSTS_EXCLUDED_CATEGORIES = [...ECONOMIC_ELEMENT_CATEGORIES, 46, 47, 48, 49] as const;
/** Excluded from "Приходи": deferred income (751, 752). */
export const REVENUE_EXCLUDED_CATEGORIES = [50, 51] as const;

/** Source-account set of a mode. */
export function isModeAccount(mode: ConcludeMode, number: string, categoryId: number | null | undefined): boolean {
  const c = categoryId ?? -1;
  if (mode === 'economic') return (ECONOMIC_ELEMENT_CATEGORIES as readonly number[]).includes(c);
  if (mode === 'costs') return number.startsWith('6') && !(COSTS_EXCLUDED_CATEGORIES as readonly number[]).includes(c);
  return number.startsWith('7') && !(REVENUE_EXCLUDED_CATEGORIES as readonly number[]).includes(c);
}

/** Account-number filter: prefix match after removing "/", "." and spaces. */
export function matchesConcludeFilter(number: string, filter: string): boolean {
  const norm = (s: string) => s.replace(/[/.\s]/g, '');
  return !filter.trim() || norm(number).startsWith(norm(filter));
}

/** Row turnover: debit - credit for expense modes, credit - debit for revenue. */
export function concludeTurnover(mode: ConcludeMode, debitTurnover: DecInput, creditTurnover: DecInput): Dec {
  const d = dec(debitTurnover), c = dec(creditTurnover);
  return concludeMode(mode).isDebitType ? d.minus(c) : c.minus(d);
}
/** Rows with a turnover below 0.01 are hidden. */
export const isListedConcludeRow = (turnover: DecInput) => dec(turnover).greaterThanOrEqualTo('0.01');

export interface ConcludeSource { accountId: number; amount: DecInput; turnover?: DecInput; number?: string; hasInitialBalance?: boolean }
export interface ConcludeTarget { accountId: number | null; percent: DecInput }
export interface PlannedLine { accountId: number; amount: Dec }
export interface PlannedEntry { debits: PlannedLine[]; credits: PlannedLine[] }
export interface ClosingMessage { key: keyof typeof CLOSING_MESSAGES; text: string; severity: 'critical' | 'warning' }

const msg = (key: keyof typeof CLOSING_MESSAGES, severity: ClosingMessage['severity'], arg?: string): ClosingMessage => ({
  key, severity, text: arg === undefined ? CLOSING_MESSAGES[key] : CLOSING_MESSAGES[key].replace('{0}', arg),
});

/** IsPercentageDistributionActive: mode allows it, at least two targets with an account, exactly one source. */
export function isPercentDistributionAvailable(mode: ConcludeMode, sourceCount: number, targets: ConcludeTarget[]): boolean {
  return concludeMode(mode).allowsPercent && sourceCount === 1 && targets.filter((t) => t.accountId).length >= 2;
}

/**
 * Validation of the manual closing (02c 3.2), corrected variant: algorithm B
 * requires the percents to sum to exactly 100 (defect D7).
 */
export function validateClosing(mode: ConcludeMode, sources: ConcludeSource[], targets: ConcludeTarget[], percentDistribution: boolean): ClosingMessage[] {
  const out: ClosingMessage[] = [];
  if (!sources.length) out.push(msg('strInvalidConcludeAccountsNumber', 'critical'));
  for (const s of sources) {
    const a = dec(s.amount);
    if (a.lessThan(0) || (s.turnover !== undefined && a.greaterThan(dec(s.turnover)))) {
      out.push(msg('strInvalidConcludeAmount', 'critical'));
      break;
    }
  }
  const used = targets.filter((t) => t.accountId || !dec(t.percent).isZero());
  if (!used.length || used.some((t) => !t.accountId)) out.push(msg('strInvalidConcludeToAccount', 'critical'));
  if (used.some((t) => dec(t.percent).greaterThan(100) || dec(t.percent).lessThanOrEqualTo(0))) out.push(msg('strInvalidConcludeAccountsPercent', 'warning'));
  const total = sum(used.map((t) => t.percent));
  if (used.length > 1 && (total.greaterThan(100) || total.lessThanOrEqualTo(0))) out.push(msg('strInvalidSumPercent', 'critical'));
  const b = percentDistribution && isPercentDistributionAvailable(mode, sources.length, targets);
  if (b && !total.equals(100) && !out.some((m) => m.key === 'strInvalidSumPercent')) out.push(msg('strInvalidSumPercentDistribution', 'critical'));
  const withOpening = sources.filter((s) => s.hasInitialBalance).map((s) => s.number ?? String(s.accountId));
  if (withOpening.length) out.push(msg('strInitialBalanceWarning', 'warning', withOpening.join(', ')));
  return out;
}

/**
 * Part of a source for one target: round2(percent/100 * amount), capped by
 * what is still unallocated of that source, never negative (corrected D6).
 */
function cappedPart(percent: DecInput, amount: Dec, allocated: Dec): Dec {
  const part = round2(dec(percent).div(100).times(amount));
  const remaining = amount.minus(allocated);
  const capped = part.greaterThan(remaining) ? remaining : part;
  return capped.lessThan(0) ? ZERO : capped;
}

/**
 * Algorithm A (no percent distribution): one entry per target with a percent;
 * each entry credits (expenses) or debits (revenue) every source with its part
 * and books the total on the target.
 */
export function planClosingA(mode: ConcludeMode, sources: ConcludeSource[], targets: ConcludeTarget[]): PlannedEntry[] {
  const debitType = concludeMode(mode).isDebitType;
  const allocated = new Map<number, Dec>();
  const out: PlannedEntry[] = [];
  for (const t of targets) {
    if (!t.accountId || dec(t.percent).isZero()) continue;
    const lines: PlannedLine[] = [];
    for (const s of sources) {
      const amount = dec(s.amount);
      const done = allocated.get(s.accountId) ?? ZERO;
      const part = cappedPart(t.percent, amount, done);
      allocated.set(s.accountId, done.plus(part));
      if (!part.isZero()) lines.push({ accountId: s.accountId, amount: part });
    }
    const total = sum(lines.map((l) => l.amount));
    if (total.isZero()) continue;
    const target = [{ accountId: t.accountId, amount: total }];
    out.push(debitType ? { debits: target, credits: lines } : { debits: lines, credits: target });
  }
  return out;
}

/**
 * Algorithm B (percent distribution, one source): one entry, a line per target
 * for its part, and the full source amount on the other side.
 */
export function planClosingB(mode: ConcludeMode, source: ConcludeSource, targets: ConcludeTarget[]): PlannedEntry {
  const debitType = concludeMode(mode).isDebitType;
  const amount = dec(source.amount);
  let allocated = ZERO;
  const lines: PlannedLine[] = [];
  for (const t of targets) {
    if (!t.accountId || dec(t.percent).isZero()) continue;
    const part = cappedPart(t.percent, amount, allocated);
    allocated = allocated.plus(part);
    if (!part.isZero()) lines.push({ accountId: t.accountId, amount: part });
  }
  const src = [{ accountId: source.accountId, amount }];
  return debitType ? { debits: lines, credits: src } : { debits: src, credits: lines };
}

/** Plans the manual closing: B when chosen and available, else A. */
export function planClosing(mode: ConcludeMode, sources: ConcludeSource[], targets: ConcludeTarget[], percentDistribution: boolean): PlannedEntry[] {
  if (percentDistribution && isPercentDistributionAvailable(mode, sources.length, targets)) return [planClosingB(mode, sources[0]!, targets)];
  return planClosingA(mode, sources, targets);
}

/** "Автоматично разпределение": Percent_i = 100 * T_i / ΣT (no rounding step). */
export function distributePercents(turnovers: DecInput[]): Dec[] {
  const total = sum(turnovers);
  return turnovers.map((t) => (total.isZero() ? ZERO : dec(t).times(100).div(total)));
}

/**
 * Automatic closing row (AutoConcludeAccountsViewModel): active accounts with a
 * debit turnover surplus are credited, passive accounts with a credit surplus
 * are debited; the counterpart is the account's ConcludeAccount.
 */
export function autoConcludeRow(isActive: boolean | null | undefined, debitTurnover: DecInput, creditTurnover: DecInput):
  { amount: Dec; debit: 'account' | 'conclude'; credit: 'account' | 'conclude' } | null {
  const d = dec(debitTurnover), c = dec(creditTurnover);
  const net = d.minus(c);
  if (round2(net).isZero() || isActive == null) return null;
  if (isActive === true && d.greaterThan(c)) return { amount: round2(net.abs()), debit: 'conclude', credit: 'account' };
  if (isActive === false && d.lessThan(c)) return { amount: round2(net.abs()), debit: 'account', credit: 'conclude' };
  return null;
}

// ---------------------------------------------------------------------------
// Year-end transfer (spConcludeFinancialYear, spec 01b 6.4)

export const YEAR_END_MESSAGES = {
  strConcludeFinancialYearWarning:
    'Всички отворени прозорци ще бъдат затворени. При приключване на тази счетоводна година, крайните салда ще бъдат записани като начални салда за следващата. Ако тя не съществува, ще бъде създадена. Желаете ли да продължите?',
  strHelpCannotConcludeNextYearIsClosed: 'Не е възможно прехвърляне на салда към заключена счетоводна година.',
  strConcludeFinancialYearFailed: 'Грешка при изпълнението на процедурата за годишно приключване!',
  strConcludeFinancialYearDone: 'Счетоводната година {0} е приключена успешно!',
  strDifferencesAccountMissing: 'Не е избрана сметка за обиране на разлики от превалутирането!',
} as const;

/** Payable-type categories: RefAmountSign +1. */
export const PAYABLE_TYPES = [4, 6, 7, 8, 9, 20, 33, 54] as const;
/** Receivable-type categories: RefAmountSign -1. */
export const RECEIVABLE_TYPES = [10, 12, 13, 14, 15, 19, 34, 55] as const;

export interface CarriedBalance { debit: Dec; credit: Dec }

/** Signed balance (debit positive) -> DebitBalance / CreditBalance. */
export function splitBalance(balance: DecInput): CarriedBalance {
  const b = dec(balance);
  return b.greaterThan(0) ? { debit: b, credit: ZERO } : { debit: ZERO, credit: b.negated() };
}

/**
 * Partner open item to carry. Credit-note documents (type 3) are inverted and
 * clamped by account type: on a receivable account a credit balance stays on
 * the debit side as a negative amount; on a payable account a debit balance
 * stays on the credit side as a negative amount.
 */
export function partnerCarry(open: DecInput, categoryId: number, isCreditNote: boolean): CarriedBalance {
  const o = dec(open);
  if (isCreditNote) {
    if ((RECEIVABLE_TYPES as readonly number[]).includes(categoryId) && o.lessThan(0)) return { debit: o, credit: ZERO };
    if ((PAYABLE_TYPES as readonly number[]).includes(categoryId) && o.greaterThan(0)) return { debit: ZERO, credit: o.negated() };
  }
  return splitBalance(o);
}

/** Part A covers accounts outside the partner categories. */
export const isYearEndPartnerAccount = (categoryId: number | null | undefined) => isCompanyCategory(categoryId);

/** Settled-pair rule: |Σ money| and |Σ currency| below 0.000001 and no material -> the pair is dropped. */
export function isSettledPair(moneyNet: DecInput, currencyNet: DecInput, materialNet: DecInput = 0): boolean {
  const eps = new D('0.000001');
  return dec(moneyNet).abs().lessThan(eps) && dec(currencyNet).abs().lessThan(eps) && dec(materialNet).isZero();
}

/** Euro changeover: BGN -> EUR at 1.95583, rounded to cents half away from zero. */
export function bgnToEur(v: DecInput): Dec {
  return round2(dec(v).div(BGN_PER_EUR));
}

/**
 * Rounding difference of a converted set of openings: the amount to book on
 * the differences account (debit positive) so that Σ debit = Σ credit.
 */
export function conversionDifference(rows: CarriedBalance[]): Dec {
  const d = sum(rows.map((r) => r.debit));
  const c = sum(rows.map((r) => r.credit));
  return c.minus(d);
}
