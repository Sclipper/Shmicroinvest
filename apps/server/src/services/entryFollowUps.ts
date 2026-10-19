import { asc, eq, inArray } from 'drizzle-orm';
import { entryCardSides, ENTRY_FOLLOW_UP_MESSAGES as M, formatMessage, type EntryCardLine } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { baseCurrencyId, loadEntry } from './journal.ts';
import { downloadRates, getRates, type FixingRate } from './revaluation.ts';

/**
 * Entry editor follow-ups (02a 2, 7; 03a 5.4; 05 7.11): the fixing of a date
 * for the editor's currency lines, "Обновяване на фиксингите от БНБ" of the
 * currencies screen and the entry card printout.
 */

/**
 * Fixing of the currencies for a date (GetExchangeRateCommand): the stored
 * rate of the date; missing ones are downloaded once (ECB) when `download`.
 * Rates still missing (holiday, service down) come back null together with
 * strCurrenciesServiceUnavailableOrHoliday; there is no 1.0 fallback.
 */
export async function entryFixing(db: DbOrTx, year: number, date: string, currencyIds: number[], opts: { download: boolean }) {
  const ids = [...new Set(currencyIds)];
  let rates: FixingRate[] = ids.length ? await getRates(db, date, year, ids) : [];
  if (opts.download && rates.some((r) => r.rate == null)) {
    try {
      await downloadRates(db, date, year);
      rates = await getRates(db, date, year, ids);
    } catch {
      // Reported below as the holiday / service message.
    }
  }
  const missing = rates.some((r) => r.rate == null);
  return { date, rates, message: missing ? M.strCurrenciesServiceUnavailableOrHoliday : null };
}

/**
 * "Обновяване на фиксингите от БНБ" (DownloadCurrenciesCommand, 03a 5.4):
 * the rates of the date are downloaded and every listed foreign currency gets
 * them as its fixed rate. BGN and EUR keep their fixed 1.95583 relation, and
 * a failed download changes nothing (corrected: Delta wrote 1.0).
 */
export async function refreshCurrencyFixings(db: DbOrTx, year: number, date: string) {
  const rates = await downloadRates(db, date, year);
  const got = rates.filter((r) => r.rate != null && !['BGN', 'EUR'].includes(r.iso));
  for (const r of got) await db.update(s.currencies).set({ fixedRate: r.rate!, rateDate: date }).where(eq(s.currencies.id, r.currencyId));
  return { date, updated: got.length, message: formatMessage(M.strFixingsUpdated, date.split('-').reverse().join('.'), got.length), rates: got };
}

/** The main entry of a VAT protocol accounting (or the entry itself), for the list's protocol commands. */
export async function protocolMainId(db: DbOrTx, id: number) {
  const [main] = await db.select({ id: s.accountings.id }).from(s.accountings).where(eq(s.accountings.icaAccountingId, id)).limit(1);
  return main?.id ?? id;
}

/** Entry card (AccountingReport, 05 7.11): header, debit and credit tables with totals. */
export async function entryCard(db: DbOrTx, id: number) {
  const e = await loadEntry(db, id);
  const lines = [...e.debits, ...e.credits];
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = accountIds.length ? await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description, productId: s.accounts.productId }).from(s.accounts).where(inArray(s.accounts.id, accountIds)) : [];
  const accById = new Map(accounts.map((x) => [x.id, x]));
  const productIds = accounts.map((x) => x.productId).filter((x): x is number => x != null);
  const products = productIds.length ? await db.select({ id: s.products.id, measure: s.products.measure }).from(s.products).where(inArray(s.products.id, productIds)) : [];
  const companyIds = [...new Set(lines.map((l) => l.companyId).filter((x): x is number => x != null))];
  const companies = companyIds.length ? await db.select({ id: s.companies.id, name: s.companies.name }).from(s.companies).where(inArray(s.companies.id, companyIds)) : [];
  const currencies = await db.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies).orderBy(asc(s.currencies.id));
  const base = await baseCurrencyId(db, Number(e.accountingDate.slice(0, 4)));
  const cardLine = (l: (typeof lines)[number]): EntryCardLine => {
    const acc = accById.get(l.accountId);
    const foreign = l.currencyId != null && l.currencyId !== base;
    return {
      accountNumber: acc?.number ?? '', accountDescription: acc?.description ?? '',
      companyName: companies.find((c) => c.id === l.companyId)?.name ?? null,
      amount: l.amount,
      currencyIso: foreign ? currencies.find((c) => c.id === l.currencyId)?.iso ?? null : null,
      currencyAmount: foreign ? l.currencyAmount : null, exchangeRate: foreign ? l.exchangeRate : null, fixedRate: foreign ? l.fixedRate : null,
      quantity: l.quantity, price: l.quantity ? l.price : null,
      measure: acc?.productId ? products.find((p) => p.id === acc.productId)?.measure ?? null : null,
    };
  };
  const sides = entryCardSides(e.debits.map(cardLine), e.credits.map(cardLine));
  const one = async <T>(q: Promise<T[]>) => (await q)[0];
  const docType = e.documentTypeId ? await one(db.select().from(s.documentTypes).where(eq(s.documentTypes.id, e.documentTypeId))) : undefined;
  const tt = await one(db.select().from(s.transactionTypes).where(eq(s.transactionTypes.id, e.transactionTypeId)));
  const vatTermId = lines[0]?.vatTermId ?? null;
  const vatTerm = vatTermId ? await one(db.select().from(s.vatTerms).where(eq(s.vatTerms.id, vatTermId))) : undefined;
  const vies = e.viesId ? await one(db.select().from(s.vieses).where(eq(s.vieses.id, e.viesId))) : undefined;
  const my = await one(db.select().from(s.myCompany).limit(1));
  const side = (x: typeof sides.debit) => ({
    lines: x.lines.map((l) => ({ ...l, amount: String(l.amount) })), total: x.total.toFixed(2), hasCurrency: x.hasCurrency, hasMaterial: x.hasMaterial,
  });
  return {
    company: { name: my?.name ?? '', bulstat: my?.bulstat ?? '' },
    header: {
      id: e.id, number: e.number, accountingDate: e.accountingDate,
      documentType: docType?.name ?? '', documentTypeShort: docType?.shortName ?? '', documentNumber: e.documentNumber, documentDate: e.documentDate,
      company: companies.find((c) => c.id === e.companyId)?.name ?? companies[0]?.name ?? '',
      term: e.term, reference: e.reference, transactionType: tt?.description ?? '', vatTerm: vatTerm?.description ?? '',
      vies: vies?.description ?? '', viesMonth: e.viesMonth, isInitialBalance: e.isInitialBalance,
    },
    debit: side(sides.debit),
    credit: side(sides.credit),
  };
}
