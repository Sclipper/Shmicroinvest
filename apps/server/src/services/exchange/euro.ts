import { and, eq, sql } from 'drizzle-orm';
import {
  DataImportError, EURO_FLAGS, EURO_FROM_YEAR, EURO_TO_YEAR, critical, dec, defaultEuroMapping, msg,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../../db/provider.ts';
import { rebuildAccountsTree } from '../chart.ts';
import { getConfig, setConfig } from '../config.ts';
import { concludeIntoYear } from '../yearEnd.ts';
import { convertFixedAssets, convertReschedules, convertTemplates } from './euroModules.ts';

/**
 * Euro conversion of a database (04b 4, "ConvertDatabaseInEurView"). Runs in
 * one transaction (corrected D-04b-1); every step is guarded by a flag so a
 * second run does nothing twice.
 */

export interface EuroHookResult { converted: number; note?: string }
export type EuroHook = (tx: DbOrTx, mapping: Map<number, number>, userId: number) => Promise<EuroHookResult>;

/** Steps owned by other modules (fixed assets, accounting templates, reschedules); replaceable in tests. */
export const euroConversionHooks: { fixedAssets?: EuroHook; templates?: EuroHook; reschedules?: EuroHook } = {
  fixedAssets: convertFixedAssets, templates: convertTemplates, reschedules: convertReschedules,
};

export interface EuroOptions {
  /** BGN account id -> EUR account id (null = leave unmapped); overrides the by-number default. */
  relations?: Record<number, number | null>;
  differencesAccountId?: number | null;
  fixedAssets?: boolean;
  templates?: boolean;
  reschedules?: boolean;
}

async function years(db: DbOrTx) {
  const rows = await db.select().from(s.financialYears);
  return { from: rows.find((y) => y.year === EURO_FROM_YEAR), to: rows.find((y) => y.year === EURO_TO_YEAR) };
}

async function chartAccounts(db: DbOrTx, isEuro: boolean) {
  return (await db.select().from(s.accounts).where(eq(s.accounts.isEuro, isEuro))).filter((a) => a.number !== '0');
}

/** Copies the BGN chart into an empty EUR chart (same numbers; base-currency accounts become EUR accounts). */
export async function cloneChartToEuro(db: DbOrTx) {
  const eur = await chartAccounts(db, true);
  if (eur.length) return 0;
  const [bgnCur] = await db.select().from(s.currencies).where(eq(s.currencies.isoCode, 'BGN'));
  const [eurCur] = await db.select().from(s.currencies).where(eq(s.currencies.isoCode, 'EUR'));
  const [root] = await db.select().from(s.accounts).where(and(eq(s.accounts.isEuro, true), eq(s.accounts.number, '0')));
  const bgn = (await chartAccounts(db, false)).sort((a, b) => a.leftIndex - b.leftIndex);
  const idMap = new Map<number, number>();
  const [bgnRoot] = await db.select().from(s.accounts).where(and(eq(s.accounts.isEuro, false), eq(s.accounts.number, '0')));
  if (bgnRoot && root) idMap.set(bgnRoot.id, root.id);
  for (const a of bgn) {
    const { id, leftIndex, rightIndex, level, mappedAccountId, ...rest } = a;
    void leftIndex; void rightIndex; void level; void mappedAccountId;
    const [row] = await db.insert(s.accounts).values({
      ...rest, parentId: a.parentId ? idMap.get(a.parentId) ?? root?.id ?? null : root?.id ?? null, isEuro: true,
      currencyId: a.currencyId === bgnCur?.id ? eurCur!.id : a.currencyId,
    }).returning({ id: s.accounts.id });
    idMap.set(id, row!.id);
  }
  await rebuildAccountsTree(db);
  return bgn.length;
}

/** Mapping grid: BGN accounts with the proposed EUR account (current mapping, else same number). */
export async function euroMappingGrid(db: DbOrTx) {
  const bgn = await chartAccounts(db, false);
  const eur = await chartAccounts(db, true);
  const byNo = new Map(eur.map((e) => [e.number, e]));
  const diff = await getConfig(db, EURO_FLAGS.differencesAccount);
  const flags = Object.fromEntries(await Promise.all(Object.entries(EURO_FLAGS).filter(([k]) => k !== 'differencesAccount').map(async ([k, key]) => [k, (await getConfig(db, key)) === 'True'])));
  const y = await years(db);
  return {
    years: { from: !!y.from, to: !!y.to },
    differencesAccountId: diff ? Number(diff) : null,
    flags,
    rows: bgn.sort((a, b) => a.number.localeCompare(b.number)).map((a) => {
      const target = a.mappedAccountId ? eur.find((e) => e.id === a.mappedAccountId) : byNo.get(a.number);
      return { id: a.id, number: a.number, description: a.description, categoryId: a.accountCategoryId, euroAccountId: target?.id ?? null, euroAccountNumber: target?.number ?? null };
    }),
    euroAccounts: eur.map((e) => ({ id: e.id, number: e.number, description: e.description })),
  };
}

async function flag(db: DbOrTx, key: string) {
  return (await getConfig(db, key)) === 'True';
}

export async function convertDatabaseToEuro(db: DbOrTx, o: EuroOptions, userId: number) {
  const y = await years(db);
  if (!y.from || !y.to) throw new DataImportError(critical('strEuroConversionNeedsYears'));
  await cloneChartToEuro(db);
  const bgn = await chartAccounts(db, false);
  const eur = await chartAccounts(db, true);
  const eurIds = new Set(eur.map((e) => e.id));
  const diffId = o.differencesAccountId ?? (Number(await getConfig(db, EURO_FLAGS.differencesAccount)) || null);
  if (!diffId || !eurIds.has(diffId)) throw new DataImportError(critical('strEuroConversionDifferenceAccountMissing'));
  for (const [from, to] of Object.entries(o.relations ?? {})) {
    if (to !== null && !eurIds.has(to)) throw new DataImportError(critical('strEuroConversionInvalidMapping', bgn.find((b) => b.id === Number(from))?.number ?? from, String(to)));
  }
  // 1. Mapping (SaveMappingAccounts): same number by default (cash in base currency too), relations override.
  const relations = { ...Object.fromEntries(bgn.filter((b) => b.mappedAccountId).map((b) => [b.id, b.mappedAccountId])), ...(o.relations ?? {}) };
  const mapping = defaultEuroMapping(
    bgn.map((b) => ({ id: b.id, number: b.number, categoryId: b.accountCategoryId, productId: b.productId })),
    eur.map((e) => ({ id: e.id, number: e.number, categoryId: e.accountCategoryId, productId: e.productId })),
    relations,
  );
  for (const b of bgn) {
    const to = mapping.get(b.id) ?? null;
    if ((b.mappedAccountId ?? null) !== to) await db.update(s.accounts).set({ mappedAccountId: to }).where(eq(s.accounts.id, b.id));
  }
  await setConfig(db, EURO_FLAGS.differencesAccount, String(diffId));
  await setConfig(db, EURO_FLAGS.mapping, 'True');
  const report: Record<string, number | string> = {};

  // 2. Partner accounts for the euro chart.
  const ca = await db.select().from(s.companyAccounts);
  const have = new Set(ca.map((r) => `${r.companyId}|${r.accountId}`));
  const add = ca.filter((r) => mapping.has(r.accountId)).map((r) => ({ companyId: r.companyId, accountId: mapping.get(r.accountId)! }))
    .filter((r) => !have.has(`${r.companyId}|${r.accountId}`) && (have.add(`${r.companyId}|${r.accountId}`), true));
  if (add.length) await db.insert(s.companyAccounts).values(add);
  report.companyAccounts = add.length;

  // 3. Postings of 2026 still on BGN accounts (spUpdateWrongAccountingsToEuroChart).
  if (!(await flag(db, EURO_FLAGS.postings))) {
    const bgnIds = bgn.map((b) => b.id);
    const wrong = bgnIds.length ? await db.select({ id: s.accountingDetails.id, accountId: s.accountingDetails.accountId, refAccountId: s.accountingDetails.refAccountId })
      .from(s.accountingDetails).innerJoin(s.accountings, eq(s.accountings.id, s.accountingDetails.accountingId))
      .where(and(eq(s.accountings.financialYearId, y.to.id), sql`(${s.accountingDetails.accountId} IN (${sql.join(bgnIds.map((i) => sql`${i}`), sql`, `)}) OR ${s.accountingDetails.refAccountId} IN (${sql.join(bgnIds.map((i) => sql`${i}`), sql`, `)}))`)) : [];
    for (const w of wrong) {
      const acc = eurIds.has(w.accountId) ? w.accountId : mapping.get(w.accountId);
      const ref = eurIds.has(w.refAccountId) ? w.refAccountId : mapping.get(w.refAccountId);
      if (!acc || !ref) throw new DataImportError(critical('strEuroConversionInvalidMapping', bgn.find((b) => b.id === (acc ? w.refAccountId : w.accountId))?.number ?? '', '-'));
      await db.update(s.accountingDetails).set({ accountId: acc, refAccountId: ref }).where(eq(s.accountingDetails.id, w.id));
    }
    // Allocations between two 2026 entries follow their legs (MappedAccountID was saved in step 1).
    await exec(db, sql`
      UPDATE accounting_payment_details p SET account_id = ac.mapped_account_id
      FROM accounts ac, accountings pa, accountings ra
      WHERE ac.id = p.account_id AND NOT ac.is_euro AND ac.mapped_account_id IS NOT NULL
        AND pa.id = p.payment_accounting_id AND ra.id = p.ref_accounting_id
        AND pa.financial_year_id = ${y.to.id} AND ra.financial_year_id = ${y.to.id}`);
    report.postings = wrong.length;
    await setConfig(db, EURO_FLAGS.postings, 'True');
  }

  // 4. Opening balances of 2026 = ConcludeFinancialYear(2025, 2026) converted (04b 4 steps 2, 6 and 9):
  // non-partner accounts per account, partner accounts per open item with its document; the earlier
  // openings (a year-end transfer, a previous run) are replaced, and the payment links of the replaced
  // openings are saved and restored onto the new ones (SumAndEqualizeToAccount books the rounding).
  if (!(await flag(db, EURO_FLAGS.openings))) {
    const r = await concludeIntoYear(db, y.from, y.to, userId, {
      map: mapping, euro: true, differencesAccountId: diffId, source: 'euro-conversion',
      onUnmapped: (accountId) => {
        throw new DataImportError(critical('strEuroConversionInvalidMapping', bgn.find((b) => b.id === accountId)?.number ?? String(accountId), '-'));
      },
    });
    report.openings = r.openings;
    report.relinked = r.relinked;
    report.difference = (r.difference ?? dec(0)).abs().toFixed(2);
    await setConfig(db, EURO_FLAGS.openings, 'True');
  }

  // 5. Bank templates and own bank accounts (always).
  if (!(await flag(db, EURO_FLAGS.bankTemplates))) {
    const details = await db.select().from(s.bankTemplateDetails);
    const euroDone = new Set(details.filter((d) => d.isEuro).map((d) => d.templateId));
    let n = 0;
    for (const d of details.filter((x) => !x.isEuro && !euroDone.has(x.templateId))) {
      await db.insert(s.bankTemplateDetails).values({
        templateId: d.templateId, isEuro: true, sign: d.sign, accountId: d.accountId ? mapping.get(d.accountId) ?? null : null,
        refAccountId: d.refAccountId ? mapping.get(d.refAccountId) ?? null : null, accountNumber: d.accountNumber, companyId: d.companyId, vatTermId: d.vatTermId,
      });
      n++;
    }
    const own = await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'my'), eq(s.bankAccounts.isEuro, false)));
    const ownEuro = await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'my'), eq(s.bankAccounts.isEuro, true)));
    for (const b of own) {
      if (ownEuro.some((e) => e.account === b.account)) continue;
      await db.insert(s.bankAccounts).values({ ownerType: 'my', ownerId: b.ownerId, bankId: b.bankId, account: b.account, isEuro: true, bankStatementAccountId: b.bankStatementAccountId ? mapping.get(b.bankStatementAccountId) ?? null : null });
    }
    report.bankTemplates = n;
    await setConfig(db, EURO_FLAGS.bankTemplates, 'True');
  }

  // 6. Optional steps of other modules (no-ops when the module is not installed).
  for (const k of ['fixedAssets', 'templates', 'reschedules'] as const) {
    if (!o[k]) continue;
    if (await flag(db, EURO_FLAGS[k])) {
      report[k] = 'вече конвертирани';
      continue;
    }
    const hook = euroConversionHooks[k];
    if (!hook) {
      report[k] = 'модулът не е наличен';
      continue;
    }
    const r = await hook(db, mapping, userId);
    report[k] = r.note ? `${r.converted} (${r.note})` : r.converted;
    await setConfig(db, EURO_FLAGS[k], 'True');
  }
  // The active year becomes 2026 for this user.
  await setConfig(db, 'ActiveFinancialYear', String(EURO_TO_YEAR), userId);
  return { report, message: msg('strEuroConversionDone') };
}
