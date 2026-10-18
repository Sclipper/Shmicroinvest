import { dec, round, round2, sum } from '../money.ts';
import { normalizeIban } from '../validators.ts';
import { compileCondition, tokenizeCondition, type ConditionToken } from './formula.ts';
import { critical, warning, type ExchangeMessage } from './messages.ts';
import type { BankStatementRow } from './bankFormats.ts';

/**
 * Bank statement mapping pipeline (spec 04b 1.5-1.10) and the posting-rule
 * defaults (03a 9.1). Pure: the server injects the lookups.
 */

export interface BankTemplateDetailDef {
  /** +1 = outflow rule (counter-account on the debit side), -1 = inflow rule. */
  sign: 1 | -1;
  accountId: number | null;
  refAccountId: number | null;
  accountNumber: string | null;
}

export interface BankTemplateDef {
  id: number;
  name: string;
  priority: number;
  formula: ConditionToken[];
  termText: string;
  referenceText: string;
  companyId: number | null;
  isOwnAccounts: boolean;
  mergeRowsOnImport: boolean;
  /** Detail row of the chart in use (BGN up to 2025, EUR from 2026). */
  detail: BankTemplateDetailDef | null;
}

export interface MappedBankRow extends BankStatementRow {
  templateId: number | null;
  templateName: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
  companyId: number | null;
  companyName: string;
  term: string;
  docReference: string;
  /** Posting amount in base currency. */
  postAmount: string;
  /** Account-currency amount and rate for a foreign-currency bank account. */
  currencyAmount: string | null;
  exchangeRate: string | null;
  isOwnAccounts: boolean;
  warnings: string[];
}

export interface BankMapContext {
  /** Ledger account of the own bank account (BankStatementAccountID). */
  bankAccountId: number;
  templates: BankTemplateDef[];
  accountByNumber: (n: string) => number | null;
  isCompanyAccount: (accountId: number) => boolean;
  /** Partner lookup by IBAN (excluded IBANs skipped) then exact name, case-insensitive. */
  findCompany: (iban: string, name: string) => { id: number; name: string } | null;
  /** "е клиент/доставчик" helper. */
  isPartnerValue?: (value: string) => boolean;
  /** User-chosen model properties for term and reference (empty = none). */
  termProperty?: string;
  referenceProperty?: string;
  /** Foreign-currency bank account: rate (base per unit) for the row date. */
  currencyRate?: (date: string) => string | null;
  isForeignCurrency?: boolean;
}

function fileValue(row: BankStatementRow, prop: string | undefined) {
  if (!prop) return '';
  if (prop === 'Reason') return row.reason;
  return (row.props[prop] ?? '').trim();
}

/** Templates in priority order (lowest first), compiled once. */
export function prepareTemplates(templates: BankTemplateDef[]) {
  return [...templates]
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map((t) => {
      let test: ((r: BankStatementRow, ctx: BankMapContext) => boolean) | null = null;
      try {
        const f = compileCondition(t.formula);
        test = (r, ctx) => f({ get: (n) => (n === 'Reason' ? r.props.Reason ?? r.reason : r.props[n]), isPartner: ctx.isPartnerValue });
      } catch {
        test = null;
      }
      return { t, test };
    });
}

/** Template applicability (1.5 step 5): sign +1 needs an outflow, -1 an inflow; and the formula holds. */
export function templateApplies(t: BankTemplateDef, test: ((r: BankStatementRow, ctx: BankMapContext) => boolean) | null, row: BankStatementRow, ctx: BankMapContext) {
  if (!t.detail || !test) return false;
  if (t.detail.sign === 1 && row.isInflow) return false;
  if (t.detail.sign === -1 && !row.isInflow) return false;
  return test(row, ctx);
}

function accountsFor(t: BankTemplateDef, ctx: BankMapContext): { debit: number | null; credit: number | null } {
  const d = t.detail!;
  const bank = ctx.bankAccountId;
  if (d.accountId && d.refAccountId) return { debit: d.accountId, credit: d.refAccountId };
  if (d.accountId) return { debit: d.accountId, credit: bank };
  if (d.refAccountId) return { debit: bank, credit: d.refAccountId };
  const found = d.accountNumber ? ctx.accountByNumber(d.accountNumber) : null;
  return d.sign === 1 ? { debit: found, credit: bank } : { debit: bank, credit: found };
}

function amounts(row: BankStatementRow, ctx: BankMapContext) {
  if (!ctx.isForeignCurrency) return { postAmount: round2(row.amount).toFixed(2), currencyAmount: null, exchangeRate: null };
  const ca = round2(row.amount);
  let rate = ctx.currencyRate?.(row.date) ?? null;
  let base = row.baseAmount ? round2(row.baseAmount) : null;
  if (base && !ca.isZero()) rate = round(base.div(ca), 5).toString();
  else if (rate) base = round2(ca.times(rate));
  return { postAmount: (base ?? dec(0)).toFixed(2), currencyAmount: ca.toFixed(2), exchangeRate: rate };
}

/** Maps statement rows to proposed postings (MapStatementsToAccountings). */
export function mapStatementRows(rows: BankStatementRow[], ctx: BankMapContext): MappedBankRow[] {
  const prepared = prepareTemplates(ctx.templates);
  return rows.map((row) => mapStatementRow(row, ctx, prepared.find((p) => templateApplies(p.t, p.test, row, ctx))?.t ?? null));
}

/** Maps one row with a given template (MapStatementToAccountingWithTemplate); null = no-template path. */
export function mapStatementRow(row: BankStatementRow, ctx: BankMapContext, t: BankTemplateDef | null): MappedBankRow {
  const fileTerm = fileValue(row, ctx.termProperty);
  const fileRef = fileValue(row, ctx.referenceProperty);
  const a = amounts(row, ctx);
  const matched = ctx.findCompany(row.partnerIban, row.partnerName);
  if (t && t.detail) {
    const { debit, credit } = accountsFor(t, ctx);
    const partnerSide = (debit && ctx.isCompanyAccount(debit)) || (credit && ctx.isCompanyAccount(credit));
    const company = t.companyId ? { id: t.companyId, name: '' } : partnerSide ? matched : null;
    return {
      ...row, ...a, templateId: t.id, templateName: t.name, debitAccountId: debit, creditAccountId: credit,
      companyId: company?.id ?? null, companyName: company?.name || (partnerSide ? row.partnerName : ''),
      term: fileTerm || t.termText, docReference: fileRef || t.referenceText, isOwnAccounts: t.isOwnAccounts, warnings: [],
    };
  }
  return {
    ...row, ...a, templateId: null, templateName: '', debitAccountId: row.isInflow ? ctx.bankAccountId : null, creditAccountId: row.isInflow ? null : ctx.bankAccountId,
    companyId: matched?.id ?? null, companyName: matched?.name ?? row.partnerName, term: fileTerm || row.reason, docReference: fileRef,
    isOwnAccounts: false, warnings: ['strNoBankTemplateWarning'],
  };
}

export type MergeCriteria = 'none' | 'all' | 'date' | 'month';

/** Merging (1.8): rows of templates with MergeRowsOnImport grouped by template (+date / +month). */
export function mergeBankRows(rows: MappedBankRow[], criteria: MergeCriteria, mergeTemplateIds: Set<number>): MappedBankRow[] {
  if (criteria === 'none') return rows;
  const out: MappedBankRow[] = [];
  const groups = new Map<string, MappedBankRow>();
  for (const r of rows) {
    if (r.templateId == null || !mergeTemplateIds.has(r.templateId)) {
      out.push(r);
      continue;
    }
    const key = `${r.templateId}|${r.isInflow}|${criteria === 'date' ? r.date : criteria === 'month' ? r.date.slice(0, 7) : ''}`;
    const g = groups.get(key);
    if (!g) {
      const copy = { ...r };
      groups.set(key, copy);
      out.push(copy);
    } else {
      g.amount = dec(g.amount).plus(r.amount).toFixed(2);
      g.postAmount = dec(g.postAmount).plus(r.postAmount).toFixed(2);
      if (g.currencyAmount != null) g.currencyAmount = dec(g.currencyAmount).plus(r.currencyAmount ?? '0').toFixed(2);
      if (r.date > g.date) g.date = r.date;
    }
  }
  return out;
}

export interface BankRowCheckContext {
  activeYear: number;
  accountInfo: (id: number) => { isLeaf: boolean; isCompany: boolean } | null;
}

/** Row validation before posting (1.10). */
export function validateBankRow(r: Pick<MappedBankRow, 'date' | 'debitAccountId' | 'creditAccountId' | 'postAmount' | 'companyId' | 'companyName'>, ctx: BankRowCheckContext): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  const d = r.debitAccountId ? ctx.accountInfo(r.debitAccountId) : null;
  const c = r.creditAccountId ? ctx.accountInfo(r.creditAccountId) : null;
  if (!d) out.push(critical('strMissingValidDebitAccount'));
  if (!c) out.push(critical('strMissingValidCreditAccount'));
  if (!r.date) out.push(critical('strEmptyDocumentDate'));
  else if (Number(r.date.slice(0, 4)) !== ctx.activeYear) out.push(critical('strWrongAccountingDate'));
  if (!(dec(r.postAmount || '0').greaterThan(0))) out.push(critical('strMissingValidDebitAndCreditAmount'));
  if ((d && !d.isLeaf) || (c && !c.isLeaf)) out.push(critical('strHelpSelectBankAccount'));
  const companySide = !!(d?.isCompany || c?.isCompany);
  if (companySide && !r.companyId) out.push(r.companyName?.trim() ? critical('strCompanyNotFound', r.companyName.trim()) : critical('strMissingCompany'));
  if (r.companyId && d && c && !companySide) out.push(critical('strMissingCompanyAccount'));
  if (d?.isCompany && c?.isCompany) out.push(warning('strCompanyAccountsOnBothSidesWarning'));
  return out;
}

/** Recompute rules (1.10): BGN = round(cur x rate, 2); cur = round(BGN / rate, 2); rate = round(BGN / cur, 5). */
export const bankRecalc = {
  base: (currency: string, rate: string) => round2(dec(currency).times(rate)).toFixed(2),
  currency: (base: string, rate: string) => (dec(rate).isZero() ? '0.00' : round2(dec(base).div(rate)).toFixed(2)),
  rate: (base: string, currency: string) => (dec(currency).isZero() ? '0' : round(dec(base).div(currency), 5).toString()),
};

// ---------------------------------------------------------------------------
// Invoice numbers and binding (1.9, 03a 8.2)

/** Normalises a document number for comparison: letters -> pad to 10; '-'/'*' kept; digits -> pad to 10, last 7. */
export function normalizeDocumentNumber(n: string): string {
  const t = n.trim();
  if (/[\p{L}]/u.test(t)) return t.padStart(10, '0');
  if (/[-*]/.test(t)) return t;
  return t.padStart(10, '0').slice(-7);
}

/** Invoice numbers found after any keyword in a payment reason. */
export function extractStatementInvoiceNumbers(text: string, keywords: string[]): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  const visit = (rest: string) => {
    for (const raw of rest.split(/[,;/ ]+/)) {
      const tok = raw.trim();
      if (!tok || !/\d/.test(tok)) continue;
      const parts = tok.split(/[-*]/);
      let v: string;
      if (/[-*]/.test(tok) && parts.length === 2 && !/[\p{L}]/u.test(tok)) v = parts[0]! + parts[1]!.padStart(10 - parts[0]!.length, '0');
      else v = normalizeDocumentNumber(tok);
      if (/^[\p{L}\d]+$/u.test(v)) out.add(/^\d+$/.test(v) ? v.padStart(10, '0').slice(-7) : v);
    }
  };
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (!k) continue;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(k, from);
      if (i < 0) break;
      const tailStart = i + k.length;
      const next = lower.indexOf(k, tailStart);
      visit(text.slice(tailStart, next < 0 ? undefined : next).trim());
      if (next < 0) break;
      from = next;
    }
  }
  return out;
}

/** First subset (bit masks ascending) whose sum of |amounts| equals the target exactly; [] when none. */
export function firstExactSubset(amounts: string[], target: string, maxItems = 20): number[] {
  const n = Math.min(amounts.length, maxItems);
  const t = dec(target).abs();
  const vals = amounts.slice(0, n).map((a) => dec(a).abs());
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = dec(0);
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s = s.plus(vals[i]!);
    if (s.eq(t)) return vals.map((_, i) => i).filter((i) => mask & (1 << i));
  }
  return [];
}

export interface OpenDocument { accountingId: number; documentNumber: string; amount: string; isInvoice: boolean }

/** Auto-bind by number, then (optionally) by sum (1.9). Returns the indexes of the chosen documents. */
export function autoBindDocuments(reason: string, amount: string, docs: OpenDocument[], keywords: string[], bySum: boolean): number[] {
  const nums = extractStatementInvoiceNumbers(reason, keywords);
  const ordered = docs.map((d, i) => ({ d, i })).sort((a, b) => Number(b.d.isInvoice) - Number(a.d.isInvoice));
  const chosen: number[] = [];
  let total = dec(0);
  const target = dec(amount).abs();
  for (const { d, i } of ordered) {
    if (total.greaterThanOrEqualTo(target)) break;
    const norm = normalizeDocumentNumber(d.documentNumber);
    if (nums.has(norm) || nums.has(norm.replace(/^0+/, '').padStart(10, '0').slice(-7))) {
      chosen.push(i);
      total = total.plus(dec(d.amount).abs());
    }
  }
  if (chosen.length || !bySum) return chosen;
  return firstExactSubset(docs.map((d) => d.amount), amount);
}

// ---------------------------------------------------------------------------
// Default rules (03a 9.1)

export interface DefaultBankTemplate {
  name: string;
  debit?: string;
  credit?: string;
  priority: number;
  condition: string;
  /** Rules whose name contains "ПОС" get the service partner "Служебен партньор(ПОС)". */
  posPartner?: boolean;
}

export const POS_SERVICE_PARTNER = 'Служебен партньор(ПОС)';

/**
 * The common rule catalogue. Delta keeps a per-bank list (15-18 rules,
 * priorities differ per bank); the conditions of those lists are not in the
 * spec, so every bank gets this catalogue with conditions over the common
 * properties (Reason, OppositeSideName, OppositeSideAccount).
 */
export const DEFAULT_BANK_TEMPLATES: DefaultBankTemplate[] = [
  { name: 'Банкова такса', debit: '629', priority: 2, condition: 'Reason съдържа "такса" или Reason съдържа "комисион" или Reason съдържа "RACOMM" или Reason съдържа "GSCOMM"' },
  { name: 'Плащане на ДОО', debit: '461/1', priority: 3, condition: 'Reason съдържа "ДОО"' },
  { name: 'Плащане на ДЗПО', debit: '461/2', priority: 3, condition: 'Reason съдържа "ДЗПО"' },
  { name: 'Плащане на ЗО', debit: '463', priority: 3, condition: 'Reason съдържа "здравн" или Reason започва с "ЗО"' },
  { name: 'Авансов по ЗДДФЛ', debit: '454', priority: 3, condition: 'Reason съдържа "ЗДДФЛ"' },
  { name: 'Плащане на ДДС', debit: '453/9', priority: 3, condition: 'Reason съдържа "ДДС"' },
  { name: 'Плащане корпоративен данък', debit: '452', priority: 3, condition: 'Reason съдържа "корпоративен"' },
  { name: 'Възнаграждения за заплата', debit: '421', priority: 9, condition: 'Reason съдържа "заплат"' },
  { name: 'Теглене в брой', debit: '501', priority: 9, condition: 'Reason съдържа "теглене" или Reason съдържа "ATM"' },
  { name: 'Плащане на ПОС терминал', debit: '401', priority: 9, condition: 'Reason съдържа "ПОС" или Reason съдържа "POS"', posPartner: true },
  { name: 'Плащане на лихва', debit: '621', priority: 9, condition: 'Reason съдържа "лихва"' },
  { name: 'Плащане към Доставчик', debit: '401', priority: 10, condition: 'OppositeSideAccount е клиент/доставчик или OppositeSideName е клиент/доставчик' },
  { name: 'Получаване на ПОС терминал', credit: '411', priority: 9, condition: 'Reason съдържа "ПОС" или Reason съдържа "POS"', posPartner: true },
  { name: 'Вноска на каса', credit: '501', priority: 9, condition: 'Reason съдържа "вноска"' },
  { name: 'Приходна лихва', credit: '721', priority: 9, condition: 'Reason съдържа "лихва"' },
  { name: 'Получаване от Клиент', credit: '411', priority: 10, condition: 'OppositeSideAccount е клиент/доставчик или OppositeSideName е клиент/доставчик' },
];

export function defaultTemplateTokens(t: DefaultBankTemplate): ConditionToken[] {
  return tokenizeCondition(t.condition);
}

/** Lower-cased IBAN list from a comma/space separated configuration value. */
export function parseIbanList(v: string | null | undefined): Set<string> {
  return new Set((v ?? '').split(/[\s,;]+/).map((x) => normalizeIban(x)).filter(Boolean));
}

/** Totals of a page (footer). */
export function bankTotals(rows: { isInflow: boolean; postAmount: string }[]) {
  return {
    inflow: sum(rows.filter((r) => r.isInflow).map((r) => r.postAmount)).toFixed(2),
    outflow: sum(rows.filter((r) => !r.isInflow).map((r) => r.postAmount)).toFixed(2),
  };
}
