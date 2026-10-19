import { and, eq, gte, inArray } from 'drizzle-orm';
import { CATEGORY, EURO_TO_YEAR, ZERO, dec, toEuro } from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { convertAssetsToEur } from '../assetOps.ts';
import { regenerateDetails } from '../reschedules.ts';
import type { EuroHookResult } from './euro.ts';

/**
 * Module steps of the euro conversion (04b 4, EuroConverter64): fixed assets,
 * accounting templates and reschedules. Each copies the BGN records into the
 * EUR ledger; the BGN originals stay for the years up to 2025.
 */

const START = `${EURO_TO_YEAR}-01-01`;

async function euroYear(db: DbOrTx) {
  const [y] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, EURO_TO_YEAR));
  return y!;
}

/** Assets not terminated at 2026-01-01 are cloned with converted plans and schedules (03b 13). */
export async function convertFixedAssets(db: DbOrTx, _mapping: Map<number, number>, userId: number): Promise<EuroHookResult> {
  const y = await euroYear(db);
  const r = await convertAssetsToEur(db, {
    year: { id: y.id, year: y.year, startDate: y.startDate, isLocked: y.isLocked, lockedMonths: y.lockedMonths, isConcluded: y.isConcluded },
    userId, appDate: START,
  });
  return { converted: r.created.length };
}

/**
 * Templates: a template with an account that has no EUR counterpart (cash in
 * base currency is never mapped by default) is skipped; accounts are mapped,
 * amounts zeroed, BGN lines become EUR lines; sign, VAT term and partner are kept.
 */
export async function convertTemplates(db: DbOrTx, mapping: Map<number, number>): Promise<EuroHookResult> {
  const bgn = await db.select().from(s.accountingTemplates).where(eq(s.accountingTemplates.isEuro, false));
  if (!bgn.length) return { converted: 0 };
  const euroNames = new Set((await db.select({ name: s.accountingTemplates.name }).from(s.accountingTemplates).where(eq(s.accountingTemplates.isEuro, true))).map((t) => t.name.trim().toLowerCase()));
  const details = await db.select().from(s.accountingTemplateDetails).where(inArray(s.accountingTemplateDetails.templateId, bgn.map((t) => t.id)));
  const accounts = new Map((await db.select().from(s.accounts)).map((a) => [a.id, a]));
  const currencies = await db.select().from(s.currencies);
  const bgnId = currencies.find((c) => c.isoCode === 'BGN')?.id;
  const eurId = currencies.find((c) => c.isoCode === 'EUR')?.id;
  let converted = 0;
  let skipped = 0;
  for (const t of bgn) {
    if (euroNames.has(t.name.trim().toLowerCase())) continue;
    const lines = details.filter((d) => d.templateId === t.id);
    const mappable = lines.every((d) => !d.accountId || (accounts.get(d.accountId)?.accountCategoryId !== CATEGORY.CashBase && mapping.has(d.accountId)));
    if (!mappable) {
      skipped++;
      continue;
    }
    const { id: _id, createdAt: _c, ...head } = t;
    const [copy] = await db.insert(s.accountingTemplates).values({ ...head, isEuro: true }).returning({ id: s.accountingTemplates.id });
    if (lines.length) {
      await db.insert(s.accountingTemplateDetails).values(lines.map(({ id: _d, templateId: _t, ...d }) => {
        const to = d.accountId ? accounts.get(mapping.get(d.accountId)!) : undefined;
        return {
          ...d, templateId: copy!.id, accountId: to?.id ?? null, accountNumber: to?.number ?? d.accountNumber, isEuro: true,
          amount: '0', currencyAmount: d.currencyAmount == null ? null : '0', price: d.price == null ? null : '0',
          currencyId: d.currencyId === bgnId ? eurId ?? d.currencyId : d.currencyId,
        };
      }));
    }
    converted++;
  }
  return { converted, note: skipped ? `пропуснати шаблони: ${skipped}` : undefined };
}

/**
 * Reschedules ending in 2026 or later: the unprocessed 2026+ remainder is
 * converted (skipped when not positive), the card starts at the later of its
 * start and 2026-01-01, accounts are mapped and the periods regenerated.
 */
export async function convertReschedules(db: DbOrTx, mapping: Map<number, number>): Promise<EuroHookResult> {
  const cards = await db.select().from(s.accountingReschedules).where(and(eq(s.accountingReschedules.isEuro, false), gte(s.accountingReschedules.toDate, START)));
  let converted = 0;
  for (const c of cards) {
    const open = await db.select().from(s.accountingRescheduleDetails)
      .where(and(eq(s.accountingRescheduleDetails.rescheduleId, c.id), eq(s.accountingRescheduleDetails.isProcessed, false), gte(s.accountingRescheduleDetails.month, START)));
    const rest = open.reduce((a, d) => a.plus(dec(d.amount)), ZERO);
    const debit = mapping.get(c.debitAccountId);
    const credit = mapping.get(c.creditAccountId);
    if (rest.lte(0) || !debit || !credit) continue;
    const { id: _id, ...card } = c;
    const [copy] = await db.insert(s.accountingReschedules).values({
      ...card, amount: toEuro(rest).toFixed(2), fromDate: c.fromDate > START ? c.fromDate : START,
      debitAccountId: debit, creditAccountId: credit, isEuro: true, sourceAccountingId: null,
    }).returning({ id: s.accountingReschedules.id });
    await regenerateDetails(db, copy!.id);
    converted++;
  }
  return { converted };
}
