import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  COMPANY_CATEGORIES, DOCUMENT_TYPE, EURO_FLAGS, VAT_CATEGORIES, YEAR_END_MESSAGES, ZERO, bgnToEur, conversionDifference, dec, isSettledPair,
  partnerCarry, splitBalance, type Dec,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, queryRows, type CompanyDb, type DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { rebuildAccountsTree } from './chart.ts';
import { addFinancialYear, ensureEuroChart } from './years.ts';
import { getConfig, setConfig } from './config.ts';
import { baseCurrencyId } from './journal.ts';
import { openItems } from './openItems.ts';
import { findSequence } from './sequences.ts';

/**
 * Year-end conclusion (spConcludeFinancialYear, spec 01b 6.4): the closing
 * balances of a year become the opening balances (IsInitialBalance) of the
 * next one, which is created when missing. Re-runs replace the openings.
 * The 2025 -> 2026 run also performs the euro changeover (04b 4, 05 12):
 * the BGN chart is mapped to the EUR chart, the openings are converted at
 * 1.95583 (rounded per row) and the rounding difference is booked on the
 * "Сметка за обиране на разлики" (config AccountForCollectingDifferences).
 */

export const DIFFERENCES_ACCOUNT_KEY = 'AccountForCollectingDifferences';
const VAT = VAT_CATEGORIES as readonly number[];
const inList = (ids: readonly number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

/** Opening row to write (one accounting with a debit leg and a credit leg on the same account). */
interface Carry {
  accountId: number;
  companyId: number | null;
  documentId: number | null;
  /** Closing-year accounting of a partner open item (for re-linking cross-year allocations). */
  sourceAccountingId: number | null;
  debit: Dec; credit: Dec;
  curDebit: Dec; curCredit: Dec;
  qtyDebit: Dec; qtyCredit: Dec;
}

const isEuroChangeover = (year: number, next: number) => year === 2025 && next === 2026;

/** The next year, created like POST /years (AddFinancialYear) when missing; a EUR year gets the EUR chart. */
async function ensureYear(tx: DbOrTx, year: number) {
  const [existing] = await tx.select().from(s.financialYears).where(eq(s.financialYears.year, year));
  if (existing) await ensureEuroChart(tx, year);
  return { fy: existing ?? (await addFinancialYear(tx, year)), created: !existing };
}

/**
 * Maps every BGN account to an EUR account (MappedAccountID; the EUR account
 * with the same number when unset, created under the mapped parent when
 * missing), links partners to the mapped accounts and re-points next-year
 * postings that still reference BGN accounts (spUpdateWrongAccountingsToEuroChart).
 */
async function prepareEuroChart(tx: DbOrTx, nextYearId: number) {
  const all = await tx.select().from(s.accounts).orderBy(asc(s.accounts.level), asc(s.accounts.number));
  const [bgnCur] = await tx.select({ id: s.currencies.id }).from(s.currencies).where(eq(s.currencies.isoCode, 'BGN'));
  const [eurCur] = await tx.select({ id: s.currencies.id }).from(s.currencies).where(eq(s.currencies.isoCode, 'EUR'));
  const eurById = new Map(all.filter((a) => a.isEuro).map((a) => [a.id, a]));
  const eurByNumber = new Map(all.filter((a) => a.isEuro).map((a) => [a.number, a.id]));
  const map = new Map<number, number>();
  let created = 0;
  for (const a of all.filter((x) => !x.isEuro)) {
    let target = a.mappedAccountId && eurById.has(a.mappedAccountId) ? a.mappedAccountId : eurByNumber.get(a.number);
    if (!target) {
      const parent = (a.parentId && map.get(a.parentId)) || eurByNumber.get('0')!;
      const [row] = await tx.insert(s.accounts).values({
        parentId: parent, number: a.number, description: a.description, englishDescription: a.englishDescription,
        accountCategoryId: a.accountCategoryId, currencyId: a.currencyId === bgnCur?.id ? eurCur!.id : a.currencyId,
        productId: a.productId, isActive: a.isActive, isHidden: a.isHidden, isForBanks: a.isForBanks, isEuro: true, iban: a.iban,
      }).returning({ id: s.accounts.id });
      target = row!.id;
      eurByNumber.set(a.number, target);
      created++;
    }
    map.set(a.id, target);
    if (a.mappedAccountId !== target) await tx.update(s.accounts).set({ mappedAccountId: target }).where(eq(s.accounts.id, a.id));
  }
  if (created) await rebuildAccountsTree(tx);
  await exec(tx, sql`
    INSERT INTO company_accounts (company_id, account_id)
    SELECT DISTINCT ca.company_id, ac.mapped_account_id FROM company_accounts ca JOIN accounts ac ON ac.id = ca.account_id
    WHERE NOT ac.is_euro AND ac.mapped_account_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM company_accounts x WHERE x.company_id = ca.company_id AND x.account_id = ac.mapped_account_id)`);
  for (const col of [sql`account_id`, sql`ref_account_id`]) {
    await exec(tx, sql`
      UPDATE accounting_details d SET ${col} = ac.mapped_account_id
      FROM accounts ac, accountings a
      WHERE ac.id = d.${col} AND NOT ac.is_euro AND ac.mapped_account_id IS NOT NULL
        AND a.id = d.accounting_id AND a.financial_year_id = ${nextYearId}`);
  }
  // Allocations between two next-year entries follow their legs.
  await exec(tx, sql`
    UPDATE accounting_payment_details p SET account_id = ac.mapped_account_id
    FROM accounts ac, accountings pa, accountings ra
    WHERE ac.id = p.account_id AND NOT ac.is_euro AND ac.mapped_account_id IS NOT NULL
      AND pa.id = p.payment_accounting_id AND ra.id = p.ref_accounting_id
      AND pa.financial_year_id = ${nextYearId} AND ra.financial_year_id = ${nextYearId}`);
  return map;
}

interface OldOpening { id: number; documentId: number | null; accountId: number; companyId: number | null; debit: string; credit: string; cur: string }

/** Opening accountings of a year (IsInitialBalance, not by correspondence), one row per (accounting, account, partner). */
async function openingsOf(tx: DbOrTx, yearId: number): Promise<OldOpening[]> {
  const rows = await queryRows<Record<string, unknown>>(tx, sql`
    SELECT a.id, a.document_id, d.account_id, d.company_id,
      SUM(d.amount) AS dr, SUM(d.ref_amount) AS cr, SUM(coalesce(d.currency_amount, 0) * d.sign) AS cur
    FROM accountings a JOIN accounting_details d ON d.accounting_id = a.id
    WHERE a.financial_year_id = ${yearId} AND a.is_initial_balance AND NOT a.is_initial_correspondence
    GROUP BY a.id, a.document_id, d.account_id, d.company_id`);
  return rows.map((r) => ({
    id: r.id as number, documentId: (r.document_id as number | null) ?? null, accountId: r.account_id as number,
    companyId: (r.company_id as number | null) ?? null,
    debit: dec(r.dr as string).toFixed(2), credit: dec(r.cr as string).toFixed(2), cur: dec(r.cur as string).toFixed(2),
  }));
}

/** Part A: balances of the non-partner accounts per (account, currency, product). */
async function nonPartnerBalances(tx: DbOrTx, yearId: number): Promise<Carry[]> {
  const rows = await queryRows<Record<string, unknown>>(tx, sql`
    SELECT d.account_id,
      SUM((d.amount + d.ref_amount) * d.sign) AS bal,
      SUM(coalesce(d.currency_amount, 0) * d.sign) AS cur,
      SUM(coalesce(d.quantity, 0) * d.sign) AS qty,
      bool_or(a.is_initial_balance AND a.is_initial_correspondence) AS to_date
    FROM accounting_details d
      JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts ac ON ac.id = d.account_id
    WHERE a.financial_year_id = ${yearId}
      AND (ac.account_category_id IS NULL OR ac.account_category_id NOT IN (${inList(COMPANY_CATEGORIES)}))
    GROUP BY d.account_id`);
  const out: Carry[] = [];
  for (const r of rows) {
    // Opening balances entered "to date" by correspondence are re-created by those entries: only currency and quantity carry.
    const money = r.to_date ? splitBalance(0) : splitBalance(dec(r.bal as string));
    const cur = splitBalance(dec(r.cur as string));
    const qty = splitBalance(dec(r.qty as string));
    out.push({
      accountId: r.account_id as number, companyId: null, documentId: null, sourceAccountingId: null,
      debit: money.debit, credit: money.credit, curDebit: cur.debit, curCredit: cur.credit, qtyDebit: qty.debit, qtyCredit: qty.credit,
    });
  }
  return out;
}

/** Part B: open items of the partner accounts; fully settled (account, partner) pairs vanish. */
async function partnerBalances(tx: DbOrTx, fy: { id: number; year: number; startDate: string }): Promise<Carry[]> {
  const items = await openItems(tx, { startDate: fy.startDate, endDate: `${fy.year}-12-31`, financialYearId: fy.id, isEuro: fy.year >= 2026 });
  const pairs = new Map<string, { money: Dec; cur: Dec }>();
  for (const i of items) {
    const k = `${i.accountId}:${i.companyId}`;
    const p = pairs.get(k) ?? { money: ZERO, cur: ZERO };
    pairs.set(k, { money: p.money.plus(i.open), cur: p.cur.plus(i.openCurrency) });
  }
  const out: Carry[] = [];
  for (const i of items) {
    const p = pairs.get(`${i.accountId}:${i.companyId}`)!;
    if (isSettledPair(p.money, p.cur)) continue;
    const isCreditNote = i.documentTypeId === DOCUMENT_TYPE.CreditNote;
    const money = partnerCarry(i.open, i.categoryId, isCreditNote);
    const cur = partnerCarry(i.openCurrency, i.categoryId, isCreditNote);
    out.push({
      accountId: i.accountId, companyId: i.companyId, documentId: i.documentId, sourceAccountingId: i.accountingId,
      debit: money.debit, credit: money.credit, curDebit: cur.debit, curCredit: cur.credit, qtyDebit: ZERO, qtyCredit: ZERO,
    });
  }
  return out;
}

const isEmpty = (c: Carry) => [c.debit, c.credit, c.curDebit, c.curCredit, c.qtyDebit, c.qtyCredit].every((v) => v.toDecimalPlaces(6).isZero());

type AccountRow = typeof s.accounts.$inferSelect;

/** BGN -> EUR conversion of the carried rows (per row, half away from zero). */
function convertToEuro(rows: Carry[], map: Map<number, number>, accounts: Map<number, AccountRow>, cur: { bgn: number; eur: number }): Carry[] {
  return rows.map((r) => {
    const src = accounts.get(r.accountId)!;
    const targetId = map.get(r.accountId) ?? r.accountId;
    const tgt = accounts.get(targetId) ?? src;
    // A EUR-denominated BGN-chart account: its currency amounts become the money.
    const srcIsEur = src.currencyId === cur.eur;
    const debit = srcIsEur ? r.curDebit : bgnToEur(r.debit);
    const credit = srcIsEur ? r.curCredit : bgnToEur(r.credit);
    let curDebit = ZERO, curCredit = ZERO;
    if (tgt.currencyId !== cur.eur) {
      // Still foreign in the EUR chart: keep the currency amounts; a BGN account keeps its leva as currency.
      const srcIsBgn = src.currencyId === cur.bgn;
      curDebit = srcIsBgn ? r.debit : r.curDebit;
      curCredit = srcIsBgn ? r.credit : r.curCredit;
    }
    return { ...r, accountId: targetId, debit, credit, curDebit, curCredit };
  });
}

export interface ConcludeInfo {
  yearId: number;
  year: number;
  nextYear: number;
  nextExists: boolean;
  nextLocked: boolean;
  isConcluded: boolean;
  isEuroChangeover: boolean;
  differencesAccountId: number | null;
  canConclude: boolean;
  reason: string | null;
  warning: string;
}

export async function concludeInfo(db: DbOrTx, yearId: number): Promise<ConcludeInfo> {
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, yearId));
  if (!fy) throw notFound('Счетоводната година');
  const [next] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, fy.year + 1));
  const diff = await getConfig(db, DIFFERENCES_ACCOUNT_KEY);
  const nextLocked = Boolean(next?.isLocked);
  return {
    yearId: fy.id, year: fy.year, nextYear: fy.year + 1, nextExists: Boolean(next), nextLocked, isConcluded: fy.isConcluded,
    isEuroChangeover: isEuroChangeover(fy.year, fy.year + 1),
    differencesAccountId: diff ? Number(diff) || null : null,
    canConclude: !nextLocked,
    reason: nextLocked ? YEAR_END_MESSAGES.strHelpCannotConcludeNextYearIsClosed : null,
    warning: YEAR_END_MESSAGES.strConcludeFinancialYearWarning,
  };
}

export interface ConcludeResult {
  message: string;
  nextYearId: number;
  nextYearCreated: boolean;
  openings: number;
  relinked: number;
  /** Euro changeover: rounding difference booked on the differences account (debit positive). */
  difference: string | null;
}

/** spConcludeFinancialYear steps 1-5 in one transaction. */
export async function concludeFinancialYear(db: CompanyDb, yearId: number, userId: number, opts: { differencesAccountId?: number | null } = {}): Promise<ConcludeResult> {
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, yearId));
  if (!fy) throw notFound('Счетоводната година');
  const [nextRow] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, fy.year + 1));
  if (nextRow?.isLocked) throw badRequest(YEAR_END_MESSAGES.strHelpCannotConcludeNextYearIsClosed);
  try {
    return await db.transaction(async (tx) => {
      const { fy: next, created } = await ensureYear(tx, fy.year + 1);
      const euro = isEuroChangeover(fy.year, next.year);
      const map = euro ? await prepareEuroChart(tx, next.id) : new Map<number, number>();
      // The BGN chart is mapped: the euro chart counts as initialised (strSelect2026yearMessage, login guard).
      if (euro) await setConfig(tx, EURO_FLAGS.mapping, 'True');

      // Step 1: remove the previous conclusion, keeping the allocations that touch it.
      const old = await openingsOf(tx, next.id);
      const oldIds = [...new Set(old.map((o) => o.id))];
      const savedLinks = oldIds.length ? await tx.select().from(s.accountingPaymentDetails).where(sql`${s.accountingPaymentDetails.paymentAccountingId} IN (${inList(oldIds)}) OR ${s.accountingPaymentDetails.refAccountingId} IN (${inList(oldIds)})`) : [];
      if (oldIds.length) await tx.delete(s.accountings).where(inArray(s.accountings.id, oldIds));

      // Step 2: balances.
      let rows = [...await nonPartnerBalances(tx, fy.id), ...await partnerBalances(tx, fy)].filter((r) => !isEmpty(r));
      const accounts = new Map((await tx.select().from(s.accounts)).map((a) => [a.id, a]));
      let difference: Dec | null = null;
      if (euro) {
        const iso = new Map((await tx.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies)).map((c) => [c.iso, c.id]));
        rows = convertToEuro(rows, map, accounts, { bgn: iso.get('BGN') ?? 1, eur: iso.get('EUR') ?? 2 });
        difference = conversionDifference(rows);
        if (!difference.isZero()) {
          const diffId = opts.differencesAccountId ?? (Number(await getConfig(tx, DIFFERENCES_ACCOUNT_KEY)) || null);
          let acc = diffId ? accounts.get(diffId) : undefined;
          // Picked from the BGN chart (the 2025 screen): use its EUR counterpart.
          if (acc && !acc.isEuro) acc = accounts.get(map.get(acc.id) ?? -1);
          if (!acc || !acc.isEuro || acc.rightIndex !== acc.leftIndex + 1 || COMPANY_CATEGORIES.includes(acc.accountCategoryId ?? -1)) {
            throw badRequest(YEAR_END_MESSAGES.strDifferencesAccountMissing);
          }
          const side = splitBalance(difference);
          rows.push({ accountId: acc.id, companyId: null, documentId: null, sourceAccountingId: null, ...side, curDebit: ZERO, curCredit: ZERO, qtyDebit: ZERO, qtyCredit: ZERO });
          await setConfig(tx, DIFFERENCES_ACCOUNT_KEY, String(acc.id));
        }
      }

      // Step 3: postings.
      const baseCur = await baseCurrencyId(tx, next.year);
      const currencies = new Map((await tx.select().from(s.currencies)).map((c) => [c.id, c]));
      const seq = await findSequence(tx, 1, fy.id);
      const createdRows: { id: number; row: Carry }[] = [];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const ids = await tx.insert(s.accountings).values(chunk.map((r) => ({
          financialYearId: next.id, number: '', date: next.startDate, accountingDate: next.startDate,
          // Step 4: VAT accounts get the 1900-01-01 VIES month.
          viesMonth: VAT.includes(accounts.get(r.accountId)?.accountCategoryId ?? -1) ? '1900-01-01' : next.startDate,
          documentId: r.documentId, transactionTypeId: 1, branchId: 1, userId, sequenceId: seq?.id ?? null,
          isInitialBalance: true, isInitialCorrespondence: false, source: 'year-close',
        }))).returning({ id: s.accountings.id });
        chunk.forEach((row, k) => createdRows.push({ id: ids[k]!.id, row }));
      }
      const legs: (typeof s.accountingDetails.$inferInsert)[] = [];
      for (const { id, row: r } of createdRows) {
        const acc = accounts.get(r.accountId)!;
        const foreign = acc.currencyId !== baseCur;
        const curTotal = r.curDebit.plus(r.curCredit);
        const rate = foreign && !curTotal.isZero() ? r.debit.plus(r.credit).div(curTotal) : ZERO;
        const qtyTotal = r.qtyDebit.plus(r.qtyCredit);
        const price = acc.productId && !qtyTotal.isZero() ? r.debit.plus(r.credit).div(qtyTotal) : ZERO;
        const leg = (sign: 1 | -1, money: Dec, cur: Dec, qty: Dec, position: number): typeof s.accountingDetails.$inferInsert => ({
          accountingId: id, accountId: r.accountId, refAccountId: r.accountId, companyId: r.companyId, vatTermId: 1,
          amount: sign === 1 ? money.toFixed(2) : '0', refAmount: sign === -1 ? money.toFixed(2) : '0', sign,
          currencyId: foreign ? acc.currencyId : null,
          currencyAmount: foreign ? cur.toFixed(2) : null,
          exchangeRate: foreign ? (cur.isZero() ? '0' : rate.toFixed(6)) : null,
          fixedRate: foreign ? (cur.isZero() ? '0' : dec(currencies.get(acc.currencyId)?.fixedRate ?? 1).toFixed(6)) : null,
          productId: acc.productId ?? null,
          quantity: acc.productId ? qty.toFixed(6) : null,
          price: acc.productId ? (qty.isZero() ? '0' : price.toFixed(6)) : null,
          position,
        });
        legs.push(leg(1, r.debit, r.curDebit, r.qtyDebit, 0), leg(-1, r.credit, r.curCredit, r.qtyCredit, 1));
      }
      for (let i = 0; i < legs.length; i += 1000) await tx.insert(s.accountingDetails).values(legs.slice(i, i + 1000));
      const aib = createdRows.map(({ id, row }) => ({ accountId: row.accountId, accountingId: id, companyId: row.companyId, documentId: row.documentId, financialYearId: next.id }));
      for (let i = 0; i < aib.length; i += 1000) await tx.insert(s.accountInitialBalances).values(aib.slice(i, i + 1000));

      // Step 5: re-link the allocations of the replaced openings ...
      const fresh = createdRows.map(({ id, row }) => ({
        id, documentId: row.documentId, accountId: row.accountId, companyId: row.companyId,
        debit: row.debit.toFixed(2), credit: row.credit.toFixed(2), cur: row.curDebit.minus(row.curCredit).toFixed(2),
      }));
      const oldById = new Map<number, OldOpening>();
      for (const o of old) if (!oldById.has(o.id) || o.companyId) oldById.set(o.id, o);
      const matchCache = new Map<number, number | null>();
      const matchOld = (oldId: number) => {
        if (matchCache.has(oldId)) return matchCache.get(oldId)!;
        const o = oldById.get(oldId);
        let hit: number | null = null;
        if (o) {
          const same = (f: (typeof fresh)[number]) => f.documentId === o.documentId && f.accountId === (map.get(o.accountId) ?? o.accountId) && f.companyId === o.companyId;
          const exact = fresh.filter((f) => same(f) && f.debit === o.debit && f.credit === o.credit && f.cur === o.cur);
          const loose = fresh.filter(same);
          hit = exact[0]?.id ?? (loose.length === 1 ? loose[0]!.id : null);
        }
        matchCache.set(oldId, hit);
        return hit;
      };
      const oldSet = new Set(oldIds);
      const relinks = new Map<string, typeof s.accountingPaymentDetails.$inferInsert>();
      for (const l of savedLinks) {
        const pay = oldSet.has(l.paymentAccountingId) ? matchOld(l.paymentAccountingId) : l.paymentAccountingId;
        const ref = oldSet.has(l.refAccountingId) ? matchOld(l.refAccountingId) : l.refAccountingId;
        if (!pay || !ref) continue;
        const row = { paymentAccountingId: pay, refAccountingId: ref, documentId: l.documentId, accountId: map.get(l.accountId) ?? l.accountId, companyId: l.companyId, amount: l.amount, currencyAmount: l.currencyAmount };
        relinks.set(`${pay}:${ref}:${row.accountId}:${row.companyId}:${row.amount}:${row.currencyAmount}`, row);
      }
      if (relinks.size) await tx.insert(s.accountingPaymentDetails).values([...relinks.values()]);

      // ... and move allocations between a closing-year item and a next-year entry onto the item's opening.
      const bySource = new Map<string, { id: number; accountId: number }>();
      for (const { id, row } of createdRows) if (row.sourceAccountingId) bySource.set(`${row.sourceAccountingId}:${row.accountId}:${row.companyId}`, { id, accountId: row.accountId });
      // Carried rows are on the (possibly mapped) account; allocation rows may still name the BGN account.
      const sourceKeyOf = (accountingId: number, accountId: number, companyId: number | null) =>
        bySource.get(`${accountingId}:${map.get(accountId) ?? accountId}:${companyId}`);
      const cross = await queryRows<{ id: number; payment_accounting_id: number; ref_accounting_id: number; account_id: number; company_id: number | null; ref_year: number; pay_year: number }>(tx, sql`
        SELECT p.id, p.payment_accounting_id, p.ref_accounting_id, p.account_id, p.company_id, ra.financial_year_id AS ref_year, pa.financial_year_id AS pay_year
        FROM accounting_payment_details p
          JOIN accountings pa ON pa.id = p.payment_accounting_id
          JOIN accountings ra ON ra.id = p.ref_accounting_id
        WHERE (ra.financial_year_id = ${fy.id} AND pa.financial_year_id = ${next.id} AND NOT pa.is_initial_balance)
           OR (pa.financial_year_id = ${fy.id} AND ra.financial_year_id = ${next.id} AND NOT ra.is_initial_balance)`);
      let moved = 0;
      for (const c of cross) {
        const closingSide = c.ref_year === fy.id ? c.ref_accounting_id : c.payment_accounting_id;
        const opening = sourceKeyOf(closingSide, c.account_id, c.company_id);
        if (!opening) continue;
        await tx.update(s.accountingPaymentDetails).set(c.ref_year === fy.id
          ? { refAccountingId: opening.id, accountId: opening.accountId }
          : { paymentAccountingId: opening.id, accountId: opening.accountId }).where(eq(s.accountingPaymentDetails.id, c.id));
        moved++;
      }

      await tx.update(s.financialYears).set({ isConcluded: true }).where(inArray(s.financialYears.id, [fy.id, next.id]));
      return {
        message: YEAR_END_MESSAGES.strConcludeFinancialYearDone.replace('{0}', String(fy.year)),
        nextYearId: next.id, nextYearCreated: created, openings: createdRows.length, relinked: relinks.size + moved,
        difference: difference ? difference.toFixed(2) : null,
      };
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error('concludeFinancialYear', e);
    throw new ApiError(500, YEAR_END_MESSAGES.strConcludeFinancialYearFailed);
  }
}

