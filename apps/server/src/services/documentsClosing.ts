import { inArray } from 'drizzle-orm';
import { closeForImport, dec, operationLabel, pairForClosing, paymentMessage, type ClosingMode, type ClosingPair } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { logActivity } from './audit.ts';
import { insertPaymentLinks, openItems, type OpenItem } from './openItems.ts';
import { assertEntriesEditable, fail } from './payments.ts';

/**
 * Закриване на документи (02a 10): proposes liability/payment pairs of the
 * active year by document, amount or second remark and saves them as
 * AccountingPaymentDetails.
 */

export interface ClosingFilter {
  mode: ClosingMode;
  /** До дата. */
  endDate?: string;
  companyId?: number;
  companyName?: string;
  accountNumber?: string;
  documentNumber?: string;
}

export interface ClosingRow {
  accountingId: number;
  accountingNumber: string;
  operation: string;
  documentDate: string;
  accountingDate: string;
  documentType: string;
  documentNumber: string;
  optionalReference: string;
  accountNumber: string;
  companyName: string;
  amount: string;
  currencyAmount: string;
}

export interface ClosingProposal {
  liability: ClosingRow;
  payment: ClosingRow;
  amount: string;
  currencyAmount: string;
}

async function activeItems(db: DbOrTx, year: ActiveYear, f: Omit<ClosingFilter, 'mode'>, accountingIds?: number[]) {
  const end = f.endDate && f.endDate < `${year.year}-12-31` ? f.endDate : `${year.year}-12-31`;
  const items = await openItems(db, {
    startDate: `${year.year}-01-01`, endDate: end, financialYearId: year.id, isEuro: year.year >= 2026,
    companyIds: f.companyId ? [f.companyId] : undefined, companyName: f.companyName || undefined,
    accountNumber: f.accountNumber || undefined, accountIds: undefined, accountingIds,
  });
  return items.map((i) => ({ ...i, optionalReference: i.optionalReference ?? '' }));
}

const row = (i: OpenItem): ClosingRow => ({
  accountingId: i.accountingId,
  accountingNumber: i.accountingNumber,
  operation: operationLabel(i.side, i.kind),
  documentDate: i.documentDate,
  accountingDate: i.accountingDate,
  documentType: i.documentTypeShortName ?? '',
  documentNumber: i.documentNumber ?? '',
  optionalReference: i.optionalReference ?? '',
  accountNumber: i.accountNumber,
  companyName: i.companyName,
  amount: i.openAbs,
  currencyAmount: i.openCurrencyAbs,
});

const proposal = (p: ClosingPair<OpenItem>): ClosingProposal => ({
  liability: row(p.liability), payment: row(p.payment), amount: p.amount.toFixed(2), currencyAmount: p.currencyAmount.toFixed(2),
});

/** The "№ на документ" filter keeps groups where either side matches the number prefix. */
const matchesNumber = (p: ClosingPair<OpenItem>, n?: string) =>
  !n || [p.liability.documentNumber, p.payment.documentNumber].some((x) => (x ?? '').toLowerCase().startsWith(n.toLowerCase()));

export async function proposeClosing(db: DbOrTx, year: ActiveYear, f: ClosingFilter): Promise<ClosingProposal[]> {
  const items = await activeItems(db, year, f);
  return pairForClosing(items, f.mode).filter((p) => matchesNumber(p, f.documentNumber)).map(proposal);
}

export interface ClosingSaveRow { liabilityAccountingId: number; paymentAccountingId: number }

/**
 * Saves the chosen pairs: recomputed from the current open items, so a pair
 * never allocates more than both sides still have open. Pairs are processed
 * one after another, each reducing what is left for the next one.
 */
export async function saveClosing(db: DbOrTx, year: ActiveYear, f: Omit<ClosingFilter, 'mode'>, pairs: ClosingSaveRow[], userId: number) {
  if (!pairs.length) fail([{ key: 'strNoPairsSelected', text: paymentMessage('strNoPairsSelected'), severity: 'critical' }]);
  const ids = [...new Set(pairs.flatMap((p) => [p.liabilityAccountingId, p.paymentAccountingId]))];
  const items = await activeItems(db, year, { endDate: f.endDate }, ids);
  const remaining = new Map<string, { item: OpenItem; amount: ReturnType<typeof dec>; currency: ReturnType<typeof dec> }>();
  const key = (accountingId: number, accountId: number, companyId: number) => `${accountingId}:${accountId}:${companyId}`;
  for (const i of items) remaining.set(key(i.accountingId, i.accountId, i.companyId), { item: i, amount: dec(i.openAbs), currency: dec(i.openCurrencyAbs) });
  const docs = await documentIds(db, pairs.map((p) => p.paymentAccountingId));
  const links = [];
  for (const p of pairs) {
    // Same account and partner on both sides, opposite kinds.
    const l = [...remaining.values()].find((r) => r.item.accountingId === p.liabilityAccountingId && r.item.kind === 'liability'
      && remaining.get(key(p.paymentAccountingId, r.item.accountId, r.item.companyId))?.item.kind === 'payment');
    if (!l) fail([{ key: 'strDifferentPartnerOrAccount', text: paymentMessage('strDifferentPartnerOrAccount'), severity: 'critical' }]);
    const pay = remaining.get(key(p.paymentAccountingId, l.item.accountId, l.item.companyId))!;
    const amount = l.amount.lessThan(pay.amount) ? l.amount : pay.amount;
    if (amount.lessThanOrEqualTo(0)) continue;
    const currency = l.currency.lessThan(pay.currency) ? l.currency : pay.currency;
    l.amount = l.amount.minus(amount);
    pay.amount = pay.amount.minus(amount);
    l.currency = l.currency.minus(currency);
    pay.currency = pay.currency.minus(currency);
    links.push({
      paymentAccountingId: p.paymentAccountingId,
      refAccountingId: p.liabilityAccountingId,
      documentId: docs.get(p.paymentAccountingId) ?? null,
      accountId: l.item.accountId,
      companyId: l.item.companyId,
      amount: amount.toFixed(2),
      currencyAmount: currency.toFixed(2),
    });
  }
  await assertEntriesEditable(db, [...new Set(links.map((l) => l.paymentAccountingId))]);
  const written = await insertPaymentLinks(db, links);
  await logActivity(db, userId, 'add', 'payment', null, `Закриване на документи: ${written.length} двойки`);
  return written;
}

/**
 * CloseDocumentsForImport: after a bank or Excel import the imported entries
 * are paired first among themselves, then with existing open items of the
 * active year, by a partial-allocation walk.
 */
export async function closeDocumentsForImport(db: DbOrTx, year: ActiveYear, importedAccountingIds: number[], userId: number) {
  if (!importedAccountingIds.length) return [];
  const all = await activeItems(db, year, {});
  const imported = new Set(importedAccountingIds);
  const pairs = closeForImport(all.filter((i) => imported.has(i.accountingId)), all.filter((i) => !imported.has(i.accountingId)));
  const docs = await documentIds(db, pairs.map((p) => p.payment.accountingId));
  const written = await insertPaymentLinks(db, pairs.map((p) => ({
    paymentAccountingId: p.payment.accountingId,
    refAccountingId: p.liability.accountingId,
    documentId: docs.get(p.payment.accountingId) ?? null,
    accountId: p.payment.accountId,
    companyId: p.payment.companyId,
    amount: p.amount.toFixed(2),
    currencyAmount: p.currencyAmount.toFixed(2),
  })));
  if (written.length) await logActivity(db, userId, 'add', 'payment', null, `Закриване на документи при импорт: ${written.length} двойки`);
  return written;
}

async function documentIds(db: DbOrTx, accountingIds: number[]) {
  if (!accountingIds.length) return new Map<number, number | null>();
  const rows = await db.select({ id: s.accountings.id, documentId: s.accountings.documentId }).from(s.accountings).where(inArray(s.accountings.id, accountingIds));
  return new Map(rows.map((r) => [r.id, r.documentId]));
}
