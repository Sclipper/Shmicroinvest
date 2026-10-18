import { sql } from 'drizzle-orm';
import {
  annualAdjustmentAmount, annualAdjustmentBase, annualAdjustmentPeriod, article73DefaultPeriod, article73Ratio, article73Sums, article73Warning, dec,
  hasCritical, TRANSACTION_TYPE, VAT_MESSAGES, VAT_TERM, type ValidationMessage,
} from '@shmi/core';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { getConfig, setConfig } from '../config.ts';
import { saveEntry } from '../journal.ts';
import { loadVatAccountings, vatAccountsForYear } from './load.ts';

/**
 * Коефициент по чл. 73 (UI_Operations_AutoOperations_VATOperations_VATRatio,
 * spec 02b 8 and 21) and the annual adjustment under art. 73(8).
 * Saving writes Article73Ratio(+FromDate/ToDate) and the deviation keys; it
 * never writes Coefficient73 (the KL33 source of the VAT return).
 */

export const ARTICLE73_KEYS = {
  ratio: 'Article73Ratio',
  from: 'Article73RatioFromDate',
  to: 'Article73RatioToDate',
  numerator: 'Article73RatioNumerator',
  denominator: 'Article73RatioDenominator',
} as const;

export async function getArticle73(db: DbOrTx, year: ActiveYear) {
  const def = article73DefaultPeriod(year.year);
  const ratio = await getConfig(db, ARTICLE73_KEYS.ratio);
  return {
    ratio: ratio != null && ratio !== '' ? dec(ratio).toFixed(2) : null,
    from: (await getConfig(db, ARTICLE73_KEYS.from)) || def.from,
    to: (await getConfig(db, ARTICLE73_KEYS.to)) || def.to,
    numeratorDeviation: (await getConfig(db, ARTICLE73_KEYS.numerator)) || '0',
    denominatorDeviation: (await getConfig(db, ARTICLE73_KEYS.denominator)) || '0',
  };
}

export interface Article73Input {
  from: string;
  to: string;
  numeratorDeviation?: string;
  denominatorDeviation?: string;
}

export async function calculateArticle73(db: DbOrTx, i: Article73Input) {
  const list = await loadVatAccountings(db, { from: i.from, to: i.to });
  const sums = article73Sums(list, i.from, i.to);
  const r = article73Ratio(sums.numerator, sums.denominator, i.numeratorDeviation || 0, i.denominatorDeviation || 0);
  return { numerator: sums.numerator.toFixed(2), denominator: sums.denominator.toFixed(2), exact: r.exact.toString(), ratio: r.ratio.toFixed(2), plain: r.plain.toFixed(2) };
}

/** Validation of a displayed ratio against a recomputation (NonCritical not-updated warning). */
export async function validateArticle73(db: DbOrTx, i: Article73Input & { ratio: string }, isNew = false): Promise<ValidationMessage[]> {
  const c = await calculateArticle73(db, i);
  const key = article73Warning(i.ratio, { exact: dec(c.exact), ratio: dec(c.ratio), plain: dec(c.plain) }, isNew);
  return key ? [{ key, text: VAT_MESSAGES[key], severity: 'warning' }] : [];
}

export async function saveArticle73(db: DbOrTx, i: Article73Input & { ratio: string }) {
  const warnings = await validateArticle73(db, i);
  await setConfig(db, ARTICLE73_KEYS.ratio, dec(i.ratio).toFixed(2));
  await setConfig(db, ARTICLE73_KEYS.from, i.from);
  await setConfig(db, ARTICLE73_KEYS.to, i.to);
  await setConfig(db, ARTICLE73_KEYS.numerator, String(dec(i.numeratorDeviation || 0)));
  await setConfig(db, ARTICLE73_KEYS.denominator, String(dec(i.denominatorDeviation || 0)));
  return { warnings };
}

// ---------------------------------------------------------------------------
// Annual adjustment (02b 8.2)

/** Default values: old ratio from config, new period = year after the old ToDate, base and new ratio computed. */
export async function annualAdjustmentDefaults(db: DbOrTx, year: ActiveYear, override: { oldRatio?: string; newRatio?: string; from?: string; to?: string } = {}) {
  const cur = await getArticle73(db, year);
  const period = override.from && override.to ? { from: override.from, to: override.to } : annualAdjustmentPeriod(cur.to);
  const list = await loadVatAccountings(db, { from: period.from, to: period.to });
  const base = annualAdjustmentBase(list, period.from, period.to);
  const sums = article73Sums(list, period.from, period.to);
  const computed = article73Ratio(sums.numerator, sums.denominator);
  const oldRatio = override.oldRatio ?? cur.ratio ?? '0.00';
  const newRatio = override.newRatio ?? computed.ratio.toFixed(2);
  const amount = annualAdjustmentAmount(base, oldRatio, newRatio);
  return {
    from: period.from, to: period.to, oldRatio: dec(oldRatio).toFixed(2), newRatio: dec(newRatio).toFixed(2), base: base.toFixed(2), amount: amount.toFixed(2),
    accountingDate: `${year.year}-12-31`, term: VAT_MESSAGES.strAnnualAdjustmentTerm,
  };
}

export interface AnnualAdjustmentInput {
  amount: string;
  accountingDate: string;
  documentTypeId: number | null;
  documentNumber: string;
  documentDate?: string | null;
  viesMonth?: string | null;
}

/** Posts Dt VAT purchases / Kt 709, VAT term 5, TT Purchase, term strAnnualAdjustmentTerm. */
export async function postAnnualAdjustment(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, i: AnnualAdjustmentInput) {
  const messages: ValidationMessage[] = [];
  const crit = (key: 'strSumCannotBeZero' | 'strMissingDocumentType' | 'strMissingDocumentNumber') => messages.push({ key, text: VAT_MESSAGES[key], severity: 'critical' });
  if (dec(i.amount || 0).isZero()) crit('strSumCannotBeZero');
  if (!i.documentTypeId) crit('strMissingDocumentType');
  if (!i.documentNumber?.trim()) crit('strMissingDocumentNumber');
  const vat = await vatAccountsForYear(db, ctx.year.year);
  if (!vat.purchases) messages.push({ key: 'strVatPurchasesAccountNotDefined', text: VAT_MESSAGES.strVatPurchasesAccountNotDefined, severity: 'critical' });
  const isEuro = ctx.year.year > 2025;
  const [other] = await queryRows<{ id: number }>(db, sql`
    SELECT a.id FROM accounts a WHERE a.is_euro = ${isEuro} AND a.number = '709' LIMIT 1`);
  if (!other) messages.push({ key: 'strMissingCreditAccount', text: 'Липсва сметка 709 Други приходи в индивидуалния сметкоплан.', severity: 'critical' });
  if (hasCritical(messages)) throw new ApiError(422, messages.find((m) => m.severity === 'critical')!.text, messages);
  const amount = dec(i.amount).toFixed(2);
  return saveEntry(db, {
    accountingDate: i.accountingDate, documentDate: i.documentDate || i.accountingDate, documentTypeId: i.documentTypeId, documentNumber: i.documentNumber,
    term: VAT_MESSAGES.strAnnualAdjustmentTerm, transactionTypeId: TRANSACTION_TYPE.Purchase, viesMonth: i.viesMonth || `${i.accountingDate.slice(0, 7)}-01`,
    viesId: 1, source: 'vat-art73',
    debits: [{ accountId: vat.purchases!.id, amount, vatTermId: VAT_TERM.AnnualAdjustment }],
    credits: [{ accountId: other!.id, amount, vatTermId: VAT_TERM.AnnualAdjustment }],
  }, { ...ctx, force: true });
}
