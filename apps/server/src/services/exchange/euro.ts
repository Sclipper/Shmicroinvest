import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DataImportError, EURO_FLAGS, EURO_FROM_YEAR, EURO_TO_YEAR, critical, dec, defaultEuroMapping, msg, round2, toEuro,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { rebuildAccountsTree } from '../chart.ts';
import { getConfig, setConfig } from '../config.ts';

/**
 * Euro conversion of a database (04b 4, "ConvertDatabaseInEurView"). Runs in
 * one transaction (corrected D-04b-1); every step is guarded by a flag so a
 * second run does nothing twice.
 */

export interface EuroHookResult { converted: number; note?: string }
export type EuroHook = (tx: DbOrTx, mapping: Map<number, number>, userId: number) => Promise<EuroHookResult>;

/** Optional steps owned by other modules (fixed assets, accounting templates, reschedules). */
export const euroConversionHooks: { fixedAssets?: EuroHook; templates?: EuroHook; reschedules?: EuroHook } = {};

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
  // 1. Mapping (SaveMappingAccounts); cash in base currency only through an explicit relation.
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
    report.postings = wrong.length;
    await setConfig(db, EURO_FLAGS.postings, 'True');
  }

  // 4. Opening balances of 2026 = closing of 2025 converted (ConcludeFinancialYear + SumAndEqualizeToAccount).
  if (!(await flag(db, EURO_FLAGS.openings))) {
    const res = (await db.execute(sql`
      SELECT d.account_id, d.company_id, d.product_id, d.currency_id,
        sum(d.amount) AS d, sum(d.ref_amount) AS c,
        sum(CASE WHEN d.sign = 1 THEN coalesce(d.currency_amount, 0) ELSE -coalesce(d.currency_amount, 0) END) AS cur,
        sum(CASE WHEN d.sign = 1 THEN coalesce(d.quantity, 0) ELSE -coalesce(d.quantity, 0) END) AS qty
      FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
      WHERE a.financial_year_id = ${y.from.id} AND NOT (a.is_initial_balance AND a.is_initial_correspondence)
      GROUP BY d.account_id, d.company_id, d.product_id, d.currency_id`)) as unknown as { rows: { account_id: number; company_id: number | null; product_id: number | null; currency_id: number | null; d: string; c: string; cur: string; qty: string }[] };
    const balances = res.rows.map((r) => ({ ...r, net: round2(dec(r.d).minus(r.c)) })).filter((r) => !r.net.isZero());
    const unmapped = balances.filter((r) => !mapping.has(r.account_id));
    if (unmapped.length) {
      const no = bgn.find((b) => b.id === unmapped[0]!.account_id)?.number ?? String(unmapped[0]!.account_id);
      throw new DataImportError(critical('strEuroConversionInvalidMapping', no, '-'));
    }
    // Replace earlier conversion openings and 2026 initial balances that still sit on BGN accounts.
    const old = await db.select({ id: s.accountings.id }).from(s.accountings).where(and(eq(s.accountings.financialYearId, y.to.id), eq(s.accountings.isInitialBalance, true), eq(s.accountings.source, 'euro-conversion')));
    if (old.length) await db.delete(s.accountings).where(inArray(s.accountings.id, old.map((x) => x.id)));
    const [eurCur] = await db.select().from(s.currencies).where(eq(s.currencies.isoCode, 'EUR'));
    const [head] = await db.insert(s.accountings).values({
      financialYearId: y.to.id, number: '', date: `${EURO_TO_YEAR}-01-01`, accountingDate: `${EURO_TO_YEAR}-01-01`, viesMonth: `${EURO_TO_YEAR}-01-01`,
      transactionTypeId: 1, userId, isInitialBalance: true, source: 'euro-conversion',
    }).returning({ id: s.accountings.id });
    let pos = 0;
    let totalD = dec(0);
    let totalC = dec(0);
    for (const r of balances) {
      const to = mapping.get(r.account_id)!;
      const amount = toEuro(r.net.abs());
      if (amount.isZero()) continue;
      const sign = r.net.isPositive() ? 1 : -1;
      if (sign === 1) totalD = totalD.plus(amount);
      else totalC = totalC.plus(amount);
      const foreign = r.currency_id && r.currency_id !== eurCur?.id;
      const curAmt = dec(r.cur).abs();
      const qty = dec(r.qty).abs();
      await db.insert(s.accountingDetails).values({
        accountingId: head!.id, accountId: to, refAccountId: to, companyId: r.company_id, vatTermId: 1, sign,
        amount: sign === 1 ? amount.toFixed(2) : '0', refAmount: sign === 1 ? '0' : amount.toFixed(2),
        currencyId: foreign ? r.currency_id : null, currencyAmount: foreign ? curAmt.toFixed(2) : null,
        exchangeRate: foreign && !curAmt.isZero() ? amount.div(curAmt).toDecimalPlaces(6).toFixed(6) : null, fixedRate: foreign ? '1' : null,
        productId: r.product_id, quantity: r.product_id ? qty.toFixed(6) : null, price: r.product_id && !qty.isZero() ? amount.div(qty).toDecimalPlaces(6).toFixed(6) : null,
        position: pos++,
      });
    }
    const diff = round2(totalD.minus(totalC));
    if (!diff.isZero()) {
      await db.insert(s.accountingDetails).values({
        accountingId: head!.id, accountId: diffId, refAccountId: diffId, vatTermId: 1, sign: diff.isPositive() ? -1 : 1,
        amount: diff.isNegative() ? diff.abs().toFixed(2) : '0', refAmount: diff.isPositive() ? diff.toFixed(2) : '0', position: pos++,
      });
    }
    report.openings = pos;
    report.difference = diff.abs().toFixed(2);
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
    report[k] = (await hook(db, mapping, userId)).converted;
    await setConfig(db, EURO_FLAGS[k], 'True');
  }
  // The active year becomes 2026 for this user.
  await setConfig(db, 'ActiveFinancialYear', String(EURO_TO_YEAR), userId);
  return { report, message: msg('strEuroConversionDone') };
}
