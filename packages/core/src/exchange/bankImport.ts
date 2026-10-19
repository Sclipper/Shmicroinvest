import { dec, round, round2, sum, type Dec } from '../money.ts';
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
  /** Duplicate-detection keys of the file rows behind this row (one, or several after merging). */
  rowKeys: string[];
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

/**
 * Amounts of a row (1.8, 1.10). BGN accounts post the file amount. A
 * foreign-currency account takes the rate of the row date from the local
 * rate table (GetCurrencyFixedRateByDate) when it is non-zero; the base
 * amount stays the one the file carries (Fibank, Postbank, Procredit) so a
 * bank conversion at another rate shows as a currency difference, else it
 * is round(currency x rate, 2). Without a stored rate the rate is derived
 * from the file's base amount.
 */
function amounts(row: BankStatementRow, ctx: BankMapContext) {
  if (!ctx.isForeignCurrency) return { postAmount: round2(row.amount).toFixed(2), currencyAmount: null, exchangeRate: null };
  const ca = round2(row.amount);
  const stored = ctx.currencyRate?.(row.date) ?? null;
  const fileBase = row.baseAmount && !dec(row.baseAmount).isZero() ? round2(row.baseAmount) : null;
  let rate: string | null = stored && !dec(stored).isZero() ? dec(stored).toString() : null;
  let base: Dec | null = fileBase;
  if (rate) base ??= round2(ca.times(rate));
  else if (fileBase && !ca.isZero()) rate = round(fileBase.div(ca), 5).toString();
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
      term: fileTerm || t.termText, docReference: fileRef || t.referenceText, isOwnAccounts: t.isOwnAccounts, warnings: [], rowKeys: [bankRowKey(row)],
    };
  }
  return {
    ...row, ...a, templateId: null, templateName: '', debitAccountId: row.isInflow ? ctx.bankAccountId : null, creditAccountId: row.isInflow ? null : ctx.bankAccountId,
    companyId: matched?.id ?? null, companyName: matched?.name ?? row.partnerName, term: fileTerm || row.reason, docReference: fileRef,
    isOwnAccounts: false, warnings: ['strNoBankTemplateWarning'], rowKeys: [bankRowKey(row)],
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
      const copy = { ...r, rowKeys: [...r.rowKeys] };
      groups.set(key, copy);
      out.push(copy);
    } else {
      g.amount = dec(g.amount).plus(r.amount).toFixed(2);
      g.postAmount = dec(g.postAmount).plus(r.postAmount).toFixed(2);
      if (g.currencyAmount != null) g.currencyAmount = dec(g.currencyAmount).plus(r.currencyAmount ?? '0').toFixed(2);
      if (r.date > g.date) g.date = r.date;
      g.rowKeys = [...g.rowKeys, ...r.rowKeys];
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

type RuleKey =
  | 'supplier' | 'client' | 'posIn' | 'posOut' | 'cashOut' | 'cashIn' | 'fee' | 'interestIn' | 'interestOut'
  | 'doo' | 'dzpo' | 'zo' | 'zddfl' | 'vat' | 'corp' | 'salary' | 'customs' | 'enforcement' | 'feeRefund' | 'vatRefund';

const PARTNER = 'OppositeSideAccount е клиент/доставчик или OppositeSideName е клиент/доставчик';
const contains = (...words: string[]) => words.map((w) => `Reason съдържа "${w}"`).join(' или ');

/** Rule catalogue of 03a 9.1 (name, account, condition over the common statement properties). */
const RULES: Record<RuleKey, Omit<DefaultBankTemplate, 'priority'>> = {
  supplier: { name: 'Плащане към Доставчик', debit: '401', condition: PARTNER },
  client: { name: 'Получаване от Клиент', credit: '411', condition: PARTNER },
  posIn: { name: 'Получаване на ПОС терминал', credit: '411', condition: contains('ПОС', 'POS'), posPartner: true },
  posOut: { name: 'Плащане на ПОС терминал', debit: '401', condition: contains('ПОС', 'POS'), posPartner: true },
  cashOut: { name: 'Теглене в брой', debit: '501', condition: contains('теглене', 'ATM', 'банкомат') },
  cashIn: { name: 'Вноска на каса', credit: '501', condition: contains('вноска', 'внасяне') },
  fee: { name: 'Банкова такса', debit: '629', condition: contains('такса', 'комисион') },
  interestIn: { name: 'Приходна лихва', credit: '721', condition: contains('лихва') },
  interestOut: { name: 'Лихва разход', debit: '621', condition: contains('лихва') },
  doo: { name: 'Плащане на ДОО', debit: '461/1', condition: contains('ДОО') },
  dzpo: { name: 'Плащане на ДЗПО', debit: '461/2', condition: contains('ДЗПО') },
  zo: { name: 'Плащане на ЗО', debit: '463', condition: 'Reason съдържа "здравн" или Reason започва с "ЗО"' },
  zddfl: { name: 'Авансов по ЗДДФЛ', debit: '454', condition: contains('ЗДДФЛ') },
  vat: { name: 'Плащане на ДДС', debit: '453/9', condition: contains('ДДС') },
  corp: { name: 'Плащане корпоративен данък', debit: '452', condition: contains('корпоративен') },
  salary: { name: 'Възнаграждения за заплата', debit: '421', condition: contains('заплат', 'възнагражд') },
  customs: { name: 'Плащане по МД', debit: '457', condition: contains('митническа декларация', 'митни') },
  enforcement: { name: 'Плащане по изпълнително дело', debit: '459', condition: contains('изпълнително дело', 'ЧСИ') },
  feeRefund: { name: 'Възстановяване на такси', credit: '729', condition: contains('такса', 'такси') },
  vatRefund: { name: 'Възстановяване на ДДС', credit: '453/8', condition: contains('ДДС') },
};

interface BankRuleSet {
  rules: Partial<Record<RuleKey, number>>;
  /** Bank spellings of a rule name. */
  names?: Partial<Record<RuleKey, string>>;
  /** Fee codes of the bank's statements (RACOMM, GSCOMM, OPRTGS). */
  feeWords?: string[];
}

// The two priority groups of the NAP rules (03a 9.1 tallies): fee 1, ДОО 2, other NAP 3 / fee 2, ДОО 3, other NAP 2.
const NAP_A = { fee: 1, doo: 2, dzpo: 3, zo: 3, zddfl: 3 } as const;
const NAP_B = { fee: 2, doo: 3, dzpo: 2, zo: 2, zddfl: 2 } as const;

/**
 * Per-bank rule lists (03a 9.1, DefaultTemplatesHelper.AddDefaultTemplates):
 * which rules a bank gets and at which priority. The rule count of each bank
 * is the spec's (7-18 rules); the spec gives the priorities only as tallies
 * over all banks, so each bank's priorities are assigned to reproduce them.
 */
const BANK_RULE_SETS: Record<string, BankRuleSet> = {
  STSABGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 10, vat: 2, corp: 3, salary: 9 } },
  UBBSBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 3, cashIn: 3, ...NAP_A, interestIn: 3, vat: 3, corp: 3, salary: 9, feeRefund: 10 }, names: { corp: 'Плащане на корпоративен данък' } },
  BPBIBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 10, vat: 2, corp: 3, salary: 9 } },
  PRCBBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 9, vat: 2, corp: 3, salary: 9, vatRefund: 3 } },
  FINVBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 9, vat: 2, corp: 3, salary: 9 }, feeWords: ['OPRTGS'] },
  RZBBBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 3, ...NAP_A, interestIn: 9, interestOut: 10, vat: 3, corp: 3, salary: 9 }, names: { interestOut: 'Плащане на лихва', corp: 'Корпоративен данък' }, feeWords: ['RACOMM'] },
  UNCRBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 9, vat: 3, corp: 3, salary: 9 }, names: { corp: 'Плащане на данък печалба' }, feeWords: ['GSCOMM'] },
  BUINBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 9, cashIn: 9, ...NAP_A, interestIn: 9, vat: 2, corp: 3, salary: 9 } },
  EVIULT2V: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 10, ...NAP_A, interestIn: 10, vat: 2, corp: 3, salary: 9 } },
  IORTBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 9, vat: 3, corp: 2, salary: 3 } },
  TEXIBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, vat: 3, corp: 2, salary: 3, customs: 3, enforcement: 3 }, names: { vat: 'Плащане ДДС' } },
  IABGBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, vat: 3, corp: 2, salary: 3, customs: 3, enforcement: 3 }, names: { vat: 'Плащане ДДС' } },
  SOMBBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 10, vat: 3, corp: 2, salary: 3 }, names: { vat: 'Плащане ДДС' } },
  INTFBGSF: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 10, cashIn: 9, fee: 1 } },
  BGUSBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 10, vat: 3, corp: 2, salary: 3 }, names: { vat: 'Плащане ДДС', interestOut: 'Плащане на лихва' } },
  DEMIBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 3, vat: 3, corp: 2, salary: 2 }, names: { vat: 'Плащане ДДС' } },
  ESPYBGS1: { rules: { supplier: 10, client: 10, posIn: 9, posOut: 9, cashOut: 10, cashIn: 10, fee: 2 } },
  CECBBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 9, vat: 2, corp: 2, salary: 4, customs: 3, enforcement: 3 }, names: { vat: 'Плащане ДДС' } },
  TCZBBGSF: { rules: { supplier: 10, client: 10, posIn: 10, posOut: 10, cashOut: 10, cashIn: 10, ...NAP_B, interestIn: 10, interestOut: 9, vat: 2, corp: 2, salary: 8, customs: 10, enforcement: 10 }, names: { vat: 'Плащане ДДС' } },
};
// IRIS (open banking) shares BUINBGSF's list.
BANK_RULE_SETS.IRIS = BANK_RULE_SETS.BUINBGSF!;

/** Bank codes with a default rule list of their own. */
export const BANKS_WITH_DEFAULT_TEMPLATES = Object.keys(BANK_RULE_SETS);

/** True when the bank (by BIC) has default rules (AddDefaultTemplates only knows these codes). */
export const hasDefaultBankTemplates = (bankCode: string | null | undefined) => !!BANK_RULE_SETS[(bankCode ?? '').trim().toUpperCase()];

/**
 * Default posting rules of a bank (03a 9.1). A bank without a list of its own
 * gets DSK's list (the "Стандартни шаблони" command works for every bank).
 */
export function defaultBankTemplates(bankCode: string | null | undefined): DefaultBankTemplate[] {
  const set = BANK_RULE_SETS[(bankCode ?? '').trim().toUpperCase()] ?? BANK_RULE_SETS.STSABGSF!;
  return (Object.entries(set.rules) as [RuleKey, number][]).map(([key, priority]) => {
    const r = RULES[key];
    const condition = key === 'fee' && set.feeWords?.length ? `${r.condition} или ${contains(...set.feeWords)}` : r.condition;
    return { ...r, name: set.names?.[key] ?? r.name, condition, priority };
  });
}

/** DSK's list (the common set of 15 rules). */
export const DEFAULT_BANK_TEMPLATES: DefaultBankTemplate[] = defaultBankTemplates('STSABGSF');

export function defaultTemplateTokens(t: DefaultBankTemplate): ConditionToken[] {
  return tokenizeCondition(t.condition);
}

// ---------------------------------------------------------------------------
// Duplicate detection (corrected D-04b-6)

/** Key of a statement row for duplicate detection: hash of date, signed amount, partner IBAN and reference. */
export function bankRowKey(r: Pick<BankStatementRow, 'date' | 'isInflow' | 'amount' | 'partnerIban' | 'reference'>): string {
  const amount = round2(r.amount || '0').toFixed(2);
  return hashText(`${r.date}|${r.isInflow ? '' : '-'}${amount}|${normalizeIban(r.partnerIban ?? '')}|${(r.reference ?? '').trim().toLowerCase()}`);
}

/** 64-bit hash (two FNV-1a lanes) of a text, as 16 hex digits. */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Posting lines (1.10): currency differences and bank fees

export interface BankPostingRow {
  debitAccountId: number;
  creditAccountId: number;
  /** Base-currency amount of the counter side (from the file or typed). */
  postAmount: string;
  currencyAmount?: string | null;
  exchangeRate?: string | null;
  /** Bank fee charged with the row: base amount and, on a currency account, the currency amount. */
  feeAmount?: string | null;
  feeCurrencyAmount?: string | null;
}

export interface BankPostingContext {
  /** Ledger account of the own bank account. */
  bankAccountId: number;
  isForeignCurrency: (accountId: number) => boolean;
  /** Accounts of the categories ПриходиОтВалутниОперации (724) and РазходиОтВалутниОперации (624). */
  fxIncomeAccountId: number | null;
  fxExpenseAccountId: number | null;
  /** Bank fee account (629). */
  feeAccountId: number | null;
}

export interface BankPostingLine {
  accountId: number;
  amount: string;
  currencyAmount?: string;
  exchangeRate?: string;
}

const nz = (v: string | null | undefined) => !!v && !dec(v).isZero();

/**
 * Debit and credit lines of a statement row (Save, 1.10). On a foreign-currency
 * bank account the bank line is valued at the row rate (currency x rate); when
 * the counter account is in base currency and its amount differs, the
 * difference goes to 624 (loss) or 724 (gain), else strCurrencyAccountsNotFound.
 * A bank fee is Dt 629 / Ct bank (a second entry) with the strBankTax* checks.
 */
export function bankPostingLines(r: BankPostingRow, ctx: BankPostingContext): {
  debits: BankPostingLine[];
  credits: BankPostingLine[];
  /** The fee is a second entry of the same document (Dt 629 / Ct bank): an entry is one-to-one, one-to-many or many-to-one. */
  fee: { debits: BankPostingLine[]; credits: BankPostingLine[] } | null;
  difference: string;
  messages: ExchangeMessage[];
} {
  const messages: ExchangeMessage[] = [];
  const debits: BankPostingLine[] = [];
  const credits: BankPostingLine[] = [];
  const P = round2(r.postAmount || '0');
  const bankIsDebit = r.debitAccountId === ctx.bankAccountId;
  const bankIsCredit = r.creditAccountId === ctx.bankAccountId;
  const counterId = bankIsDebit ? r.creditAccountId : r.debitAccountId;
  const foreign = ctx.isForeignCurrency(ctx.bankAccountId) && (bankIsDebit || bankIsCredit);
  const cur = round2(foreign ? r.currencyAmount || '0' : '0');
  const rate = foreign && nz(r.exchangeRate) ? dec(r.exchangeRate!) : null;
  let difference = dec(0);
  let fee: { debits: BankPostingLine[]; credits: BankPostingLine[] } | null = null;
  const curLine = (accountId: number, amount: Dec): BankPostingLine => ({
    accountId, amount: amount.toFixed(2), currencyAmount: cur.toFixed(2), exchangeRate: rate ? rate.toString() : bankRecalc.rate(amount.toFixed(2), cur.toFixed(2)),
  });
  if (!foreign) {
    debits.push({ accountId: r.debitAccountId, amount: P.toFixed(2) });
    credits.push({ accountId: r.creditAccountId, amount: P.toFixed(2) });
  } else if (ctx.isForeignCurrency(counterId) || !rate || cur.isZero()) {
    // Currency on both sides (or nothing to value the bank line with): no difference.
    debits.push(r.debitAccountId === ctx.bankAccountId || ctx.isForeignCurrency(r.debitAccountId) ? curLine(r.debitAccountId, P) : { accountId: r.debitAccountId, amount: P.toFixed(2) });
    credits.push(r.creditAccountId === ctx.bankAccountId || ctx.isForeignCurrency(r.creditAccountId) ? curLine(r.creditAccountId, P) : { accountId: r.creditAccountId, amount: P.toFixed(2) });
  } else {
    const B = round2(cur.times(rate));
    difference = P.minus(B);
    const bank = curLine(ctx.bankAccountId, B);
    const counter = { accountId: counterId, amount: P.toFixed(2) };
    if (bankIsDebit) {
      debits.push(bank);
      credits.push(counter);
    } else {
      debits.push(counter);
      credits.push(bank);
    }
    if (!difference.isZero()) {
      // Bank debited: a larger counter amount is a loss; bank credited: a gain.
      const loss = bankIsDebit ? difference.greaterThan(0) : difference.lessThan(0);
      const acc = loss ? ctx.fxExpenseAccountId : ctx.fxIncomeAccountId;
      if (!acc) messages.push(critical('strCurrencyAccountsNotFound'));
      else (loss ? debits : credits).push({ accountId: acc, amount: difference.abs().toFixed(2) });
    }
  }

  // A fee row (Dt 629 / Ct bank) and a fee charged with the row.
  if (ctx.feeAccountId && bankIsCredit && r.debitAccountId === ctx.feeAccountId) {
    messages.push(...bankFeeChecks({ amount: P.toFixed(2), currencyAmount: cur.toFixed(2), rate: rate?.toString() ?? null }, foreign));
  }
  if ((bankIsDebit || bankIsCredit) && (nz(r.feeAmount) || nz(r.feeCurrencyAmount))) {
    const feeCur = round2(foreign ? r.feeCurrencyAmount || '0' : '0');
    const feeBase = foreign && rate && !feeCur.isZero() ? round2(feeCur.times(rate)) : round2(r.feeAmount || '0');
    const checks = bankFeeChecks({ amount: feeBase.toFixed(2), currencyAmount: feeCur.toFixed(2), rate: rate?.toString() ?? null }, foreign);
    if (!ctx.feeAccountId) checks.unshift(critical('strBankTaxAccountsMissing'));
    messages.push(...checks);
    if (!checks.length && ctx.feeAccountId) {
      fee = {
        debits: [{ accountId: ctx.feeAccountId, amount: feeBase.toFixed(2) }],
        credits: [foreign
          ? { accountId: ctx.bankAccountId, amount: feeBase.toFixed(2), currencyAmount: feeCur.toFixed(2), exchangeRate: rate!.toString() }
          : { accountId: ctx.bankAccountId, amount: feeBase.toFixed(2) }],
      };
    }
  }
  return { debits, credits, fee, difference: difference.toFixed(2), messages };
}

/** Checks of a bank fee: strBankTaxZeroSum, and on a currency account strBankTaxZeroCurrencySum / strBankTaxZeroExchangeRate. */
export function bankFeeChecks(f: { amount: string; currencyAmount: string | null; rate: string | null }, foreign: boolean): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  if (!nz(f.amount)) out.push(critical('strBankTaxZeroSum'));
  if (foreign) {
    if (!nz(f.currencyAmount)) out.push(critical('strBankTaxZeroCurrencySum'));
    if (!nz(f.rate)) out.push(critical('strBankTaxZeroExchangeRate'));
  }
  return out;
}

/** Lower-cased IBAN list from a comma/space separated configuration value. */
export function parseIbanList(v: string | null | undefined): Set<string> {
  return new Set((v ?? '').split(/[\s,;]+/).map((x) => normalizeIban(x)).filter(Boolean));
}

/** Footer totals of the preview page: base and currency amounts by direction and the currency differences. */
export function bankTotals(rows: { isInflow: boolean; postAmount: string; currencyAmount?: string | null; exchangeRate?: string | null }[]) {
  const ins = rows.filter((r) => r.isInflow);
  const outs = rows.filter((r) => !r.isInflow);
  const cur = (rs: typeof rows) => sum(rs.map((r) => r.currencyAmount || '0')).toFixed(2);
  return {
    count: rows.length,
    inflow: sum(ins.map((r) => r.postAmount || '0')).toFixed(2),
    outflow: sum(outs.map((r) => r.postAmount || '0')).toFixed(2),
    currencyInflow: cur(ins),
    currencyOutflow: cur(outs),
    difference: sum(rows.map((r) => bankRowDifference(r))).toFixed(2),
  };
}

/** Currency difference of a preview row: base amount - round(currency x rate, 2); 0 without currency or rate. */
export function bankRowDifference(r: { postAmount: string; currencyAmount?: string | null; exchangeRate?: string | null }): string {
  if (!nz(r.currencyAmount) || !nz(r.exchangeRate)) return '0.00';
  return round2(r.postAmount || '0').minus(bankRecalc.base(r.currencyAmount!, r.exchangeRate!)).toFixed(2);
}
