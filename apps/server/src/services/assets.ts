import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  accountingLastProcessedDate, amountByDate, ASSET_MESSAGES, assetMessage, D, dec, DEPRECIATION_CATEGORY, deriveMethod,
  endOfMonth, firstEditableMonthDate as firstEditable, firstOfMonth, fmtMsg, generateSchedule, hasCritical, isLeaf,
  isMonthLocked, isStartMonthIncluded, monthIndex, monthLabelBg, monthsFromRate, NO_END_DATE, planMainDifferences, rateFromMonths, sum,
  taxLastProcessedDate, validatePlan, yearPlans, ZERO, assetFromPosting, fixedAssetOffer, isCompanyCategory, type Dec, type DepreciationMonthStatus, type MonthAmount, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { deleteEntry, loadEntry } from './journal.ts';
import { logActivity } from './audit.ts';
import { peekNextNumber, reserveNumber } from './sequences.ts';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export interface AssetCtx {
  year: ActiveYear;
  userId: number;
  /** ApplicationDate.Now (working date). */
  appDate: string;
}

/** Sequence channel 8 "Дълготрайни_активи": 10 digits, lifetime counter (2.6). */
export const ASSET_SEQUENCE_CHANNEL = 8;
export const MEMORIAL_ORDER_TYPE = 10;
export const MEMORIAL_ORDER_CHANNEL = 6;

/** The register shows the ledger of the active year (GetAllAssets: IsEuro = database currency flag). */
export const ledgerIsEuro = (year: { year: number }) => year.year > 2025;

export interface LockInfo {
  lastLockedYear: number | null;
  isLocked: (month: string) => boolean;
}

export async function lockInfo(db: DbOrTx): Promise<LockInfo> {
  const years = await db.select().from(s.financialYears);
  const locked = years.filter((y) => y.isLocked).map((y) => y.year);
  const byYear = new Map(years.map((y) => [y.year, y]));
  return {
    lastLockedYear: locked.length ? Math.max(...locked) : null,
    isLocked: (month) => {
      const fy = byYear.get(Number(month.slice(0, 4)));
      return Boolean(fy && (fy.isLocked || isMonthLocked(fy.lockedMonths, Number(month.slice(5, 7)))));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Locations (FixedAssetLocations)                                     */
/* ------------------------------------------------------------------ */

export async function ensureRootLocation(db: DbOrTx) {
  const [root] = await db.select().from(s.fixedAssetLocations).where(eq(s.fixedAssetLocations.id, 1));
  if (root) return root;
  const [my] = await db.select().from(s.myCompany).limit(1);
  const [sys] = await db.select().from(s.system).limit(1);
  const [row] = await db.insert(s.fixedAssetLocations).values({ id: 1, name: my?.name ?? sys?.companyName ?? 'Фирма', leftIndex: 1, rightIndex: 2, level: 1 }).returning();
  await db.execute(sql`SELECT setval(pg_get_serial_sequence('fixed_asset_locations','id'), GREATEST((SELECT max(id) FROM fixed_asset_locations), 1))`);
  return row!;
}

export async function listLocations(db: DbOrTx) {
  await ensureRootLocation(db);
  return db.select().from(s.fixedAssetLocations).where(eq(s.fixedAssetLocations.isDeleted, false)).orderBy(asc(s.fixedAssetLocations.leftIndex));
}

/** spRebuildFixedAssetLocationsTree: nested set by name. */
async function rebuildLocations(db: DbOrTx) {
  const rows = await db.select().from(s.fixedAssetLocations).where(eq(s.fixedAssetLocations.isDeleted, false));
  const kids = new Map<number | null, typeof rows>();
  for (const r of rows) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  let n = 0;
  const walk = async (r: (typeof rows)[number], level: number) => {
    const left = ++n;
    for (const c of (kids.get(r.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'bg'))) await walk(c, level + 1);
    const right = ++n;
    if (r.leftIndex !== left || r.rightIndex !== right || r.level !== level) {
      await db.update(s.fixedAssetLocations).set({ leftIndex: left, rightIndex: right, level }).where(eq(s.fixedAssetLocations.id, r.id));
    }
  };
  const root = rows.find((r) => r.id === 1);
  if (root) await walk(root, 1);
}

export async function addLocation(db: DbOrTx, name: string, parentId: number) {
  if (!name.trim()) throw new ApiError(422, ASSET_MESSAGES.strLocationNameIsEmpty);
  await ensureRootLocation(db);
  const [parent] = await db.select().from(s.fixedAssetLocations).where(and(eq(s.fixedAssetLocations.id, parentId), eq(s.fixedAssetLocations.isDeleted, false)));
  if (!parent) throw notFound('Местоположението');
  const [row] = await db.insert(s.fixedAssetLocations).values({ name: name.trim().slice(0, 255), parentId, level: parent.level + 1 }).returning();
  await rebuildLocations(db);
  return row!;
}

export async function editLocation(db: DbOrTx, id: number, patch: { name?: string; parentId?: number }) {
  const [loc] = await db.select().from(s.fixedAssetLocations).where(eq(s.fixedAssetLocations.id, id));
  if (!loc || loc.isDeleted) throw notFound('Местоположението');
  if (patch.name !== undefined && !patch.name.trim()) throw new ApiError(422, ASSET_MESSAGES.strLocationNameIsEmpty);
  if (patch.parentId !== undefined && (id === 1 || patch.parentId === id)) throw badRequest('Невалидна родителска група.');
  await db.update(s.fixedAssetLocations).set({ name: patch.name?.trim().slice(0, 255) ?? loc.name, parentId: patch.parentId ?? loc.parentId }).where(eq(s.fixedAssetLocations.id, id));
  await rebuildLocations(db);
}

export async function deleteLocation(db: DbOrTx, id: number) {
  if (id === 1) throw badRequest(ASSET_MESSAGES.strLocationRootCannotBeDeleted);
  const [child] = await db.select({ id: s.fixedAssetLocations.id }).from(s.fixedAssetLocations).where(and(eq(s.fixedAssetLocations.parentId, id), eq(s.fixedAssetLocations.isDeleted, false))).limit(1);
  if (child) throw badRequest(ASSET_MESSAGES.strLocationHasChildren);
  const [asset] = await db.select({ id: s.fixedAssets.id }).from(s.fixedAssets).where(eq(s.fixedAssets.locationId, id)).limit(1);
  if (asset) throw badRequest(ASSET_MESSAGES.strLocationHasAssets);
  await db.update(s.fixedAssetLocations).set({ isDeleted: true }).where(eq(s.fixedAssetLocations.id, id));
  await rebuildLocations(db);
}

/** fnGetFullLocationPath: "Фирма / Склад / Цех". */
export async function locationPaths(db: DbOrTx) {
  const rows = await db.select().from(s.fixedAssetLocations);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<number, string>();
  for (const r of rows) {
    const parts: string[] = [];
    let p: (typeof rows)[number] | undefined = r;
    while (p) {
      parts.unshift(p.name);
      p = p.parentId != null ? byId.get(p.parentId) : undefined;
    }
    out.set(r.id, parts.join(' / '));
  }
  return out;
}

/** Location ids of a node and its descendants. */
export async function locationSubtree(db: DbOrTx, id: number) {
  const rows = await db.select().from(s.fixedAssetLocations);
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (r.parentId != null && out.has(r.parentId) && !out.has(r.id)) { out.add(r.id); grew = true; }
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Stored plans                                                        */
/* ------------------------------------------------------------------ */

export interface StoredMonth {
  id: number;
  month: string;
  amount: string;
  isProcessed: boolean;
  accountingId: number | null;
  accountingNumber: string | null;
  accountingDate: string | null;
  postedAmount: string | null;
}

export interface StoredPlan {
  dep: typeof s.depreciations.$inferSelect;
  rows: StoredMonth[];
  years: (typeof s.depreciationYearPlans.$inferSelect)[];
  improvements: (typeof s.improvementsHistory.$inferSelect)[];
}

export async function loadPlans(db: DbOrTx, depIds: number[]): Promise<Map<number, StoredPlan>> {
  const out = new Map<number, StoredPlan>();
  if (!depIds.length) return out;
  const deps = await db.select().from(s.depreciations).where(inArray(s.depreciations.id, depIds));
  const rows = (await db.execute(sql`
    SELECT ds.id, ds.depreciation_id, ds.month::text AS month, ds.amount::text AS amount, ds.is_processed, ds.accounting_id,
      a.number AS accounting_number, a.accounting_date::text AS accounting_date,
      (SELECT sum(d.amount) FROM accounting_details d WHERE d.accounting_id = ds.accounting_id AND d.sign = 1)::text AS posted_amount
    FROM depreciation_schedules ds LEFT JOIN accountings a ON a.id = ds.accounting_id
    WHERE ds.depreciation_id IN (${sql.join(depIds.map((i) => sql`${i}`), sql`, `)})
    ORDER BY ds.month`)) as unknown as { rows: { id: number; depreciation_id: number; month: string; amount: string; is_processed: boolean; accounting_id: number | null; accounting_number: string | null; accounting_date: string | null; posted_amount: string | null }[] };
  const years = await db.select().from(s.depreciationYearPlans).where(inArray(s.depreciationYearPlans.depreciationId, depIds)).orderBy(asc(s.depreciationYearPlans.year));
  const imps = await db.select().from(s.improvementsHistory).where(inArray(s.improvementsHistory.depreciationId, depIds)).orderBy(asc(s.improvementsHistory.improvementDate), asc(s.improvementsHistory.id));
  for (const d of deps) out.set(d.id, { dep: d, rows: [], years: [], improvements: [] });
  for (const r of rows.rows) {
    out.get(r.depreciation_id)?.rows.push({
      id: r.id, month: r.month, amount: r.amount, isProcessed: r.is_processed, accountingId: r.accounting_id,
      accountingNumber: r.accounting_number, accountingDate: r.accounting_date, postedAmount: r.posted_amount,
    });
  }
  for (const y of years) out.get(y.depreciationId)?.years.push(y);
  for (const i of imps) out.get(i.depreciationId)?.improvements.push(i);
  return out;
}

/** САП LP (posting date of the last processed row) or ДАП LP (application date rule). */
export function planLastProcessed(plan: StoredPlan, appDate: string) {
  const rows = plan.rows.map((r) => ({ month: r.month, amount: r.amount, isProcessed: r.isProcessed, accountingDate: r.accountingDate }));
  const lp = plan.dep.isAccounting ? accountingLastProcessedDate(rows, plan.dep.startDate) : taxLastProcessedDate(rows, plan.dep.startDate, appDate);
  const accrued = plan.dep.isAccounting ? sum(plan.rows.filter((r) => r.isProcessed).map((r) => r.amount)) : amountByDate(plan.rows, lp);
  return { lastProcessedDate: lp, accrued };
}

export const planReserve = (plan: StoredPlan | undefined) => sum((plan?.years ?? []).map((y) => y.revaluationReserve));

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface PlanInput {
  depreciationAmount: string;
  nonDepreciableAmount?: string | null;
  acquisitionDate: string;
  startDate: string;
  calcType: 'period' | 'rate';
  annualRate?: string | null;
  activePeriodLength?: number | null;
  conservation?: { start: string | null; end: string | null } | null;
  note?: string | null;
  serialNumber?: string | null;
  manualAccrued?: { date: string | null; amount: string | null } | null;
  /** Grid edited by hand (month amounts); replaces the generated schedule. */
  months?: { month: string; amount: string }[] | null;
  /** Force regeneration (a schedule control was touched). */
  regenerate?: boolean;
}

export interface AssetInput {
  inventoryNumber: string;
  name: string;
  personInCharge?: string | null;
  categoryId?: number | null;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  inventoryAccountId?: number | null;
  locationId?: number | null;
  synchronized: boolean;
  accounting: PlanInput;
  tax: PlanInput;
  /** Answer to the 6.3 dialog: delete the differing postings or only unlink them. */
  postingsResolution?: 'delete' | 'unlink' | null;
  /** OK to strRemoveImprovementsOnAmountChangedConfirmation. */
  clearImprovements?: boolean;
  /** Yes to strDepreciationsAccountingAndTaxDepreciationDiffer. */
  plansDifferAccepted?: boolean;
  /** Migration import (14.2): both plans are built in "international accounting recalculation" mode. */
  iasMode?: boolean;
}

/* ------------------------------------------------------------------ */
/* Plan computation                                                    */
/* ------------------------------------------------------------------ */

export interface ComputedPlan {
  isAccounting: boolean;
  input: PlanInput;
  notApplied: boolean;
  life: number;
  annualRate: Dec;
  startMonthIncluded: boolean;
  rows: { month: string; amount: Dec; isProcessed: boolean }[];
  endDate: string;
  methodId: number;
  years: { year: number; percentage: Dec; amount: Dec; revaluationReserve: Dec }[];
  lastProcessedDate: string;
  accrued: Dec;
  reserve: Dec;
  firstEditableMonthDate: string;
  regenerated: boolean;
  messages: ValidationMessage[];
  /** Posted months whose amount changes or that disappear (6.3). */
  conflicts: StoredMonth[];
}

const decEq = (a: unknown, b: unknown) => dec(a as string).eq(dec(b as string));

function scheduleParamsChanged(dep: typeof s.depreciations.$inferSelect, input: PlanInput, life: number, rate: Dec, includedNow: boolean, includedBefore: boolean) {
  return !decEq(dep.depreciationAmount, input.depreciationAmount)
    || !decEq(dep.nonDepreciableAmount, input.nonDepreciableAmount ?? 0)
    || dep.startDate !== input.startDate
    || dep.activePeriodLength !== life
    || !dec(dep.annualRate).toDecimalPlaces(10).eq(rate.toDecimalPlaces(10))
    || (dep.conservationStartDate ?? null) !== (input.conservation?.start ?? null)
    || (dep.conservationEndDate ?? null) !== (input.conservation?.end ?? null)
    || includedNow !== includedBefore;
}

export function computePlan(o: {
  isAccounting: boolean;
  input: PlanInput;
  synchronized: boolean;
  wasSynchronized: boolean;
  categoryId: number | null | undefined;
  stored?: StoredPlan;
  reserve: Dec;
  locks: LockInfo;
  appDate: string;
  iasMode?: boolean;
}): ComputedPlan {
  const { isAccounting, input, stored, locks } = o;
  const land = o.categoryId === DEPRECIATION_CATEGORY.LandAndForests;
  const rateIn = dec(input.annualRate ?? 0);
  const notApplied = land || (input.calcType === 'rate' && rateIn.isZero());
  const life = notApplied ? 0 : o.iasMode && stored ? stored.dep.activePeriodLength : input.calcType === 'rate' ? monthsFromRate(rateIn) : Math.max(0, input.activePeriodLength ?? 0);
  const annualRate = notApplied ? ZERO : input.calcType === 'rate' ? rateIn : rateFromMonths(life);
  const included = isStartMonthIncluded(isAccounting, o.synchronized);
  const da = dec(input.depreciationAmount).minus(dec(input.nonDepreciableAmount ?? 0));
  const reserve = isAccounting ? o.reserve : ZERO;
  const base = isAccounting ? da.plus(reserve) : da;
  const fe = stored ? firstEditable(locks.lastLockedYear, input.startDate) : input.startDate;

  // LP and accrued: from the stored rows, or the typed "Начислени амортизации / Към дата".
  let lp = input.startDate;
  let accrued = ZERO;
  let processedMonths: MonthAmount[] | null = null;
  const storedLp = stored ? planLastProcessed(stored, o.appDate) : null;
  const hasPosted = Boolean(stored?.rows.some((r) => r.accountingId));
  const manual = input.manualAccrued && input.manualAccrued.date && !dec(input.manualAccrued.amount).isZero() && !hasPosted ? input.manualAccrued : null;
  if (manual) {
    lp = manual.date!;
    accrued = dec(manual.amount);
  } else if (storedLp && stored && (isAccounting ? stored.rows.some((r) => r.isProcessed) : true)) {
    lp = storedLp.lastProcessedDate;
    accrued = storedLp.accrued;
    processedMonths = stored.rows.filter((r) => r.month <= lp).map((r) => ({ month: r.month, amount: dec(r.amount) }));
  }

  const includedBefore = stored ? isStartMonthIncluded(isAccounting, o.wasSynchronized) : included;
  const changed = !stored || o.iasMode || input.regenerate || Boolean(input.months) || Boolean(manual)
    || scheduleParamsChanged(stored.dep, input, life, annualRate, included, includedBefore);

  let rows: ComputedPlan['rows'];
  const lpIdx = monthIndex(lp);
  const processedFlag = (month: string) => (isAccounting ? monthIndex(month) <= lpIdx && monthIndex(lp) > monthIndex(input.startDate) : true);
  if (notApplied) rows = [];
  else if (input.months) {
    rows = input.months.map((m) => ({ month: firstOfMonth(m.month), amount: dec(m.amount), isProcessed: processedFlag(m.month) }))
      .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
  } else if (!changed && stored) {
    rows = stored.rows.map((r) => ({ month: r.month, amount: dec(r.amount), isProcessed: isAccounting ? r.isProcessed : true }));
  } else {
    const g = generateSchedule({
      isAccounting, startMonthIncluded: included, depreciableAmount: da, revaluationReserve: reserve,
      startDate: input.startDate, activePeriodLength: life, lastProcessedDate: lp, amountByLastProcessedDate: accrued,
      processedMonths, firstEditableMonthDate: stored?.rows.length ? fe : null,
      lockedMonths: stored?.rows.map((r) => ({ month: r.month, amount: dec(r.amount) })),
      conservation: input.conservation?.start && input.conservation.end ? { start: firstOfMonth(input.conservation.start), end: firstOfMonth(input.conservation.end) } : null,
      iasMode: o.iasMode,
    });
    rows = g.rows;
  }
  const endDate = rows.length ? rows[rows.length - 1]!.month : NO_END_DATE;
  const yp = yearPlans(rows, base, annualRate);
  const storedReserve = new Map((stored?.years ?? []).map((y) => [Number(y.year.slice(0, 4)), dec(y.revaluationReserve)]));
  const years = yp.map((y) => ({ year: y.year, percentage: y.percentage, amount: y.amount, revaluationReserve: isAccounting ? storedReserve.get(y.year) ?? ZERO : ZERO }));
  for (const [y, r] of storedReserve) if (isAccounting && !r.isZero() && !years.some((x) => x.year === y)) years.push({ year: y, percentage: ZERO, amount: ZERO, revaluationReserve: r });
  years.sort((a, b) => a.year - b.year);

  const messages = validatePlan({
    isAccounting, notApplied, depreciationAmount: input.depreciationAmount, nonDepreciableAmount: input.nonDepreciableAmount ?? 0,
    revaluationReserve: reserve, acquisitionDate: input.acquisitionDate, startDate: input.startDate, endDate,
    activePeriodLength: notApplied ? 0 : life || null,
    conservation: input.conservation && (input.conservation.start || input.conservation.end) ? input.conservation : null,
    lastProcessedDate: lp, manualAccrued: input.manualAccrued && (input.manualAccrued.date || !dec(input.manualAccrued.amount).isZero()) && !hasPosted ? input.manualAccrued : null,
    accrued, rows, categoryId: o.categoryId, startMonthIncluded: included,
  });

  // Posted months whose amount changes or that disappear (6.3, 7: AccountingToDelete).
  const conflicts: StoredMonth[] = [];
  if (isAccounting && stored) {
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    for (const r of stored.rows) {
      if (!r.accountingId) continue;
      const n = byMonth.get(r.month);
      if (!n || !n.amount.eq(dec(r.postedAmount ?? r.amount))) conflicts.push(r);
    }
    for (const c of conflicts) {
      const label = monthLabelBg(c.month);
      if (locks.isLocked(c.month)) {
        messages.push({ key: 'strAccountingDepreciationMonthFromLockedPeriodWithDifferingAmount', text: fmtMsg(ASSET_MESSAGES.strLockedMonth, label), severity: 'critical' });
      } else {
        messages.push({ key: 'strAccountingDepreciationAccountingToDelete', text: `Счетоводни амортизации: Осчетоводеното отчисление за месец ${label} (контиране №${c.accountingNumber ?? ''}) ще бъде променено или изтрито`, severity: 'warning' });
      }
    }
  }

  return {
    isAccounting, input, notApplied, life, annualRate, startMonthIncluded: included, rows, endDate,
    methodId: deriveMethod(yp), years, lastProcessedDate: lp, accrued, reserve, firstEditableMonthDate: fe,
    regenerated: changed, messages, conflicts,
  };
}

/** CopyFrom(САП, isStartMonthIncluded: false): every main parameter of the accounting plan. */
export function copyPlanInput(from: PlanInput, to: PlanInput | undefined): PlanInput {
  return { ...from, manualAccrued: to?.manualAccrued ?? null, months: null, regenerate: from.regenerate || Boolean(from.months) };
}

/* ------------------------------------------------------------------ */
/* Asset computation (preview + save)                                  */
/* ------------------------------------------------------------------ */

export interface ComputedAsset {
  input: AssetInput;
  accounting: ComputedPlan;
  tax: ComputedPlan;
  messages: ValidationMessage[];
  existing?: typeof s.fixedAssets.$inferSelect;
  plans?: Map<number, StoredPlan>;
}

async function assetFieldMessages(db: DbOrTx, input: AssetInput, isEuro: boolean, excludeId: number | undefined, sapNotApplied: boolean) {
  const out: ValidationMessage[] = [];
  const crit = (k: keyof typeof ASSET_MESSAGES) => out.push(assetMessage(k));
  if (!input.name.trim()) crit('strAssetNameIsMissing');
  if (!input.inventoryNumber.trim()) crit('strAssetInventoryNumberIsMissing');
  else {
    // Ordinal, case-sensitive comparison within the current currency ledger (6.2).
    const same = await db.select({ id: s.fixedAssets.id }).from(s.fixedAssets)
      .where(and(eq(s.fixedAssets.inventoryNumber, input.inventoryNumber), eq(s.fixedAssets.isEuro, isEuro), excludeId ? ne(s.fixedAssets.id, excludeId) : sql`true`));
    if (same.length) crit('strAssetInventoryNumberExists');
  }
  const ids = [input.debitAccountId, input.creditAccountId, input.inventoryAccountId].filter((x): x is number => !!x);
  const accs = ids.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  const leaf = (id: number | null | undefined) => {
    const a = accs.find((x) => x.id === id);
    return !a || (isLeaf({ left: a.leftIndex, right: a.rightIndex }) && a.number !== '0');
  };
  if (!sapNotApplied && !input.debitAccountId) crit('strAssetDebitAccountIsMissing');
  if (!sapNotApplied && !input.creditAccountId) crit('strAssetCreditAccountIsMissing');
  if (!input.inventoryAccountId) crit('strAssetInventoryAccountIsMissing');
  if (input.debitAccountId && !leaf(input.debitAccountId)) crit('strDebitAssetAccountHasSubAccounts');
  if (input.creditAccountId && !leaf(input.creditAccountId)) crit('strCreditAssetAccountHasSubAccounts');
  if (input.inventoryAccountId && !leaf(input.inventoryAccountId)) crit('strInventoryAssetAccountHasSubAccounts');
  if (!input.categoryId) crit('strAssetDepreciationCategoryIsEmpty');
  return out;
}

export async function computeAsset(db: DbOrTx, ctx: AssetCtx, input: AssetInput, id?: number, opts: { stored?: boolean } = {}): Promise<ComputedAsset> {
  let existing: typeof s.fixedAssets.$inferSelect | undefined;
  let plans: Map<number, StoredPlan> | undefined;
  if (id) {
    [existing] = await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.id, id));
    if (!existing) throw notFound('Активът');
    plans = await loadPlans(db, [existing.accountingDepreciationId, existing.taxDepreciationId]);
  }
  const locks = await lockInfo(db);
  const storedSap = existing ? plans!.get(existing.accountingDepreciationId) : undefined;
  const storedDap = existing ? plans!.get(existing.taxDepreciationId) : undefined;
  const wasSync = existing?.areDepreciationsSynchronized ?? input.synchronized;
  const accounting = computePlan({ isAccounting: true, input: input.accounting, synchronized: input.synchronized, wasSynchronized: wasSync, categoryId: input.categoryId, stored: storedSap, reserve: planReserve(storedSap), locks, appDate: ctx.appDate, iasMode: input.iasMode });
  // opts.stored: show the stored plans as they are (the ДАП copy happens on save only, R7).
  const copy = input.synchronized && !opts.stored;
  const taxInput = copy ? copyPlanInput(input.accounting, input.tax) : input.tax;
  if (copy && storedDap && !existing?.areDepreciationsSynchronized) taxInput.regenerate = true;
  const tax = computePlan({ isAccounting: false, input: taxInput, synchronized: input.synchronized, wasSynchronized: wasSync, categoryId: input.categoryId, stored: storedDap, reserve: ZERO, locks, appDate: ctx.appDate, iasMode: input.iasMode });
  if (copy && storedDap && tax.regenerated) {
    // The copy may not change months of a locked period (strDepreciationsAreSynchronisedChangeConflictsWithLockedPeriod).
    const newByMonth = new Map(tax.rows.map((r) => [r.month, r.amount]));
    const conflict = storedDap.rows.some((r) => locks.isLocked(r.month) && !(newByMonth.get(r.month) ?? ZERO).eq(dec(r.amount)));
    if (conflict) tax.messages.push(assetMessage('strDepreciationsAreSynchronisedChangeConflictsWithLockedPeriod'));
  }
  const isEuro = existing?.isEuro ?? ledgerIsEuro(ctx.year);
  const messages = [
    ...(await assetFieldMessages(db, input, isEuro, id, accounting.notApplied)),
    ...accounting.messages,
    ...tax.messages,
  ];
  return { input, accounting, tax, messages, existing, plans };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

const iso = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

function depValues(p: ComputedPlan) {
  const i = p.input;
  return {
    isAccounting: p.isAccounting,
    methodId: p.methodId,
    depreciationAmount: dec(i.depreciationAmount).toFixed(6),
    nonDepreciableAmount: dec(i.nonDepreciableAmount ?? 0).toFixed(6),
    depreciableAmount: dec(i.depreciationAmount).minus(dec(i.nonDepreciableAmount ?? 0)).toFixed(6),
    acquisitionDate: i.acquisitionDate,
    startDate: i.startDate,
    endDate: p.endDate,
    conservationStartDate: i.conservation?.start ? firstOfMonth(i.conservation.start) : null,
    conservationEndDate: i.conservation?.start && i.conservation.end ? firstOfMonth(i.conservation.end) : null,
    activePeriodLength: p.life,
    annualRate: p.annualRate.toDecimalPlaces(15).toFixed(15),
    calcType: p.notApplied ? 'rate' : i.calcType,
    note: i.note?.slice(0, 1024) || null,
    serialNumber: i.serialNumber?.slice(0, 255) || null,
  };
}

/** Writes a computed plan: months merged by MonthDate so posting links survive (Z57). */
export async function persistPlan(db: DbOrTx, depId: number | null, p: ComputedPlan, stored: StoredPlan | undefined, ctx: AssetCtx, resolution: 'delete' | 'unlink' | null | undefined) {
  let id = depId;
  if (id) await db.update(s.depreciations).set(depValues(p)).where(eq(s.depreciations.id, id));
  else id = (await db.insert(s.depreciations).values(depValues(p)).returning({ id: s.depreciations.id }))[0]!.id;

  const conflictIds = new Set(p.conflicts.map((c) => c.id));
  if (p.conflicts.length) {
    for (const c of p.conflicts) {
      if (resolution === 'delete' && c.accountingId) await deleteEntry(db, c.accountingId, ctx.year, ctx.userId, { anyYear: true });
      await db.update(s.depreciationSchedules).set({ accountingId: null, isProcessed: false }).where(eq(s.depreciationSchedules.id, c.id));
    }
  }
  const existingByMonth = new Map((stored?.rows ?? []).map((r) => [r.month, r]));
  const keep = new Set<number>();
  const inserts: (typeof s.depreciationSchedules.$inferInsert)[] = [];
  for (const r of p.rows) {
    const e = existingByMonth.get(r.month);
    const isProcessed = p.isAccounting ? (e?.accountingId && !conflictIds.has(e.id) ? true : conflictIds.has(e?.id ?? -1) ? false : r.isProcessed) : true;
    if (e) {
      keep.add(e.id);
      if (!dec(e.amount).eq(r.amount) || e.isProcessed !== isProcessed) {
        await db.update(s.depreciationSchedules).set({ amount: r.amount.toFixed(6), isProcessed }).where(eq(s.depreciationSchedules.id, e.id));
      }
    } else inserts.push({ depreciationId: id, month: r.month, amount: r.amount.toFixed(6), isProcessed });
  }
  const drop = (stored?.rows ?? []).filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) await db.delete(s.depreciationSchedules).where(inArray(s.depreciationSchedules.id, drop));
  if (inserts.length) await db.insert(s.depreciationSchedules).values(inserts);

  await db.delete(s.depreciationYearPlans).where(eq(s.depreciationYearPlans.depreciationId, id));
  if (p.years.length) {
    await db.insert(s.depreciationYearPlans).values(p.years.map((y) => ({
      depreciationId: id!, year: `${y.year}-01-01`, percentage: y.percentage.toDecimalPlaces(15).toFixed(15), amount: y.amount.toFixed(6), revaluationReserve: y.revaluationReserve.toFixed(6),
    })));
  }
  return id;
}

export class PostingsConflictError extends ApiError {}

/** Save (FixedAssetViewModel.ApplyChanges / Save). */
export async function saveAsset(db: DbOrTx, ctx: AssetCtx, input: AssetInput, id?: number) {
  const c = await computeAsset(db, ctx, input, id);
  const { existing, plans } = c;
  if (existing && existing.terminationStatusId !== 1) throw badRequest(ASSET_MESSAGES.strCantEditAssetDueToAssetTermination);
  if (existing && existing.isEuro !== ledgerIsEuro(ctx.year)) throw badRequest('Активът е от друга счетоводна валута и не може да бъде редактиран в текущата година.');
  if (hasCritical(c.messages)) {
    throw new ApiError(422, fmtMsg(ASSET_MESSAGES.strFixedAssetCannotBeSaved, input.inventoryNumber), c.messages.filter((m) => m.severity === 'critical'));
  }
  const storedSap = existing ? plans!.get(existing.accountingDepreciationId) : undefined;
  const storedDap = existing ? plans!.get(existing.taxDepreciationId) : undefined;

  // Improvements exist and the cost was changed by hand (9.1 other rules).
  for (const [p, st] of [[c.accounting, storedSap], [c.tax, storedDap]] as const) {
    if (st?.improvements.length && !decEq(st.dep.depreciationAmount, p.input.depreciationAmount) && !input.clearImprovements) {
      throw new ApiError(409, ASSET_MESSAGES.strRemoveImprovementsOnAmountChangedConfirmation, undefined, 'improvements');
    }
  }
  // 03b 4: unsynchronised plans that differ in their main parameters are confirmed;
  // an edit asks only when the difference is new.
  if (!input.synchronized && !input.plansDifferAccepted) {
    const diff = planMainDifferences(input.accounting, input.tax);
    const before = storedSap && storedDap ? planMainDifferences(storedSap.dep, storedDap.dep) : [];
    if (diff.length && diff.join() !== before.join()) {
      throw new ApiError(409, fmtMsg(ASSET_MESSAGES.strDepreciationsAccountingAndTaxDepreciationDiffer, diff.join(', ')), undefined, 'plansDiffer');
    }
  }
  if (c.accounting.conflicts.length && !input.postingsResolution) {
    const lines = c.accounting.conflicts.map((x) => ({ key: 'strDepreciationMonthWithAccounting', text: fmtMsg(ASSET_MESSAGES.strDepreciationMonthWithAccounting, monthLabelBg(x.month), x.accountingNumber ?? ''), severity: 'warning' as const }));
    throw new ApiError(409, `${ASSET_MESSAGES.strTheMadeChangeInAssetPlanIsDifferentFromAccountings}\n${lines.map((l) => l.text).join('\n')}\n${ASSET_MESSAGES.strShalliDeleteTheOperations}`, lines, 'postingsDiffer');
  }

  if (input.clearImprovements) {
    for (const st of [storedSap, storedDap]) if (st) await db.delete(s.improvementsHistory).where(eq(s.improvementsHistory.depreciationId, st.dep.id));
  }
  const sapId = await persistPlan(db, existing?.accountingDepreciationId ?? null, c.accounting, storedSap, ctx, input.postingsResolution);
  const dapId = await persistPlan(db, existing?.taxDepreciationId ?? null, c.tax, storedDap, ctx, null);
  if (input.synchronized && storedSap) {
    // CopyFrom copies the improvement list too.
    const imps = await db.select().from(s.improvementsHistory).where(eq(s.improvementsHistory.depreciationId, sapId));
    await db.delete(s.improvementsHistory).where(eq(s.improvementsHistory.depreciationId, dapId));
    if (imps.length) await db.insert(s.improvementsHistory).values(imps.map((i) => ({ depreciationId: dapId, improvementDate: i.improvementDate, newDepreciationAmount: i.newDepreciationAmount })));
  }
  const root = await ensureRootLocation(db);
  const values = {
    inventoryNumber: input.inventoryNumber.slice(0, 30),
    name: input.name.slice(0, 255),
    personInCharge: input.personInCharge?.slice(0, 255) || null,
    debitAccountId: input.debitAccountId ?? null,
    creditAccountId: input.creditAccountId ?? null,
    inventoryAccountId: input.inventoryAccountId ?? null,
    categoryId: input.categoryId!,
    areDepreciationsSynchronized: input.synchronized,
    locationId: input.locationId ?? root.id,
    revaluationReserve: c.accounting.years.reduce((a, y) => a.plus(y.revaluationReserve), ZERO).toFixed(6),
  };
  let assetId: number;
  if (existing) {
    await db.update(s.fixedAssets).set(values).where(eq(s.fixedAssets.id, existing.id));
    assetId = existing.id;
  } else {
    assetId = (await db.insert(s.fixedAssets).values({ ...values, accountingDepreciationId: sapId, taxDepreciationId: dapId, isEuro: ledgerIsEuro(ctx.year) }).returning({ id: s.fixedAssets.id }))[0]!.id;
    // Keep the lifetime counter of channel 8 in step with numeric inventory numbers.
    if (/^\d+$/.test(input.inventoryNumber)) {
      const n = Number(input.inventoryNumber);
      await db.update(s.sequences).set({ lastNumber: sql`GREATEST(${s.sequences.lastNumber}, ${n})` }).where(eq(s.sequences.channel, ASSET_SEQUENCE_CHANNEL));
    }
  }
  await logActivity(db, ctx.userId, existing ? 'edit' : 'add', 'fixedAsset', assetId, `${input.inventoryNumber} ${input.name}`);
  return { id: assetId, warnings: c.messages.filter((m) => m.severity === 'warning') };
}

/** New asset defaults (6.1). */
export async function newAssetDefaults(db: DbOrTx, ctx: AssetCtx, fromAccountingId?: number) {
  const inventoryNumber = await peekNextNumber(db, ASSET_SEQUENCE_CHANNEL, ctx.year.id);
  const defaults = { inventoryNumber, acquisitionDate: ctx.appDate, startDate: ctx.appDate, isEuro: ledgerIsEuro(ctx.year) };
  if (!fromAccountingId) return { ...defaults, fromPosting: null };
  return { ...defaults, fromPosting: await assetPrefillFromPosting(db, fromAccountingId) };
}

/**
 * strAddFixedAssetData (03b 14.1, 6.1): the posting's first debit line on a
 * 2xx account (no partner account on the credit side) prefills the new asset:
 * inventory account, cost = depreciable amount, acquisition date, name from
 * the term (the account description when the term is empty). Null when the
 * posting does not qualify.
 */
export async function assetPrefillFromPosting(db: DbOrTx, accountingId: number) {
  const e = await loadEntry(db, accountingId);
  const ids = [...new Set([...e.debits, ...e.credits].map((l) => l.accountId))];
  const accs = ids.length ? await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description, categoryId: s.accounts.accountCategoryId }).from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  const byId = new Map(accs.map((a) => [a.id, a]));
  const line = (l: (typeof e.debits)[number]) => ({ accountId: l.accountId, accountNumber: byId.get(l.accountId)?.number ?? '', amount: l.amount, isCompany: isCompanyCategory(byId.get(l.accountId)?.categoryId) });
  const offer = fixedAssetOffer(e.debits.map(line), e.credits.map(line));
  if (!offer) return null;
  return { accountingId, accountingNumber: e.number, ...assetFromPosting({ accountId: offer.accountId, accountDescription: byId.get(offer.accountId)?.description ?? '', amount: offer.amount, date: e.accountingDate, term: e.term }) };
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/** Stored month states (03b 6.1); 'disabled' = no row, drawn by the grid. */
export type MonthStatus = Exclude<DepreciationMonthStatus, 'disabled'>;

export function planView(p: ComputedPlan, stored: StoredPlan | undefined, locks: LockInfo, hasStoredRows = Boolean(stored?.rows.length)) {
  const byMonth = new Map((stored?.rows ?? []).map((r) => [r.month, r]));
  const fe = p.firstEditableMonthDate;
  const months = p.rows.map((r) => {
    const e = byMonth.get(r.month);
    const posted = e?.accountingId ? e : null;
    const readOnly = hasStoredRows && (r.month < firstOfMonth(fe) || locks.isLocked(r.month));
    const status: MonthStatus = posted ? (dec(posted.postedAmount ?? posted.amount).eq(r.amount) ? 'posted' : 'postedDifferent') : readOnly ? 'readOnly' : 'normal';
    return {
      month: r.month, amount: r.amount.toFixed(2), isProcessed: r.isProcessed, status, readOnly,
      accountingId: posted?.accountingId ?? null, accountingNumber: posted?.accountingNumber ?? null, accountingDate: posted?.accountingDate ?? null,
      postedAmount: posted?.postedAmount ? dec(posted.postedAmount).toFixed(2) : null,
    };
  });
  const i = p.input;
  const da = dec(i.depreciationAmount).minus(dec(i.nonDepreciableAmount ?? 0));
  return {
    isAccounting: p.isAccounting,
    depreciationAmount: dec(i.depreciationAmount).toFixed(2),
    nonDepreciableAmount: dec(i.nonDepreciableAmount ?? 0).toFixed(2),
    depreciableAmount: da.toFixed(2),
    acquisitionDate: i.acquisitionDate,
    startDate: i.startDate,
    endDate: p.endDate === NO_END_DATE ? null : p.endDate,
    finalDate: stored?.dep.finalDate ?? null,
    activePeriodLength: p.life,
    annualRate: p.annualRate.toDecimalPlaces(10).toString(),
    calcType: p.notApplied ? 'rate' : i.calcType,
    notApplied: p.notApplied,
    conservation: i.conservation?.start ? { start: firstOfMonth(i.conservation.start), end: i.conservation.end ? firstOfMonth(i.conservation.end) : null } : null,
    note: i.note ?? '',
    serialNumber: i.serialNumber ?? '',
    methodId: p.methodId,
    lastProcessedDate: p.lastProcessedDate,
    accrued: p.accrued.toFixed(2),
    remainder: D.max(ZERO, da.minus(p.accrued)).toFixed(2),
    revaluationReserve: p.reserve.toFixed(2),
    firstEditableMonthDate: fe,
    startMonthIncluded: p.startMonthIncluded,
    improvements: (stored?.improvements ?? []).map((x) => ({ id: x.id, date: x.improvementDate, amount: dec(x.newDepreciationAmount).toFixed(2) })),
    years: p.years.map((y) => ({ year: y.year, percentage: y.percentage.toDecimalPlaces(4).toString(), amount: y.amount.toFixed(2), revaluationReserve: y.revaluationReserve.toFixed(2) })),
    months,
    total: sum(p.rows.map((r) => r.amount)).toFixed(2),
  };
}

function inputFromStored(asset: typeof s.fixedAssets.$inferSelect, sap: StoredPlan, dap: StoredPlan): AssetInput {
  const plan = (p: StoredPlan): PlanInput => ({
    depreciationAmount: p.dep.depreciationAmount, nonDepreciableAmount: p.dep.nonDepreciableAmount,
    acquisitionDate: p.dep.acquisitionDate, startDate: p.dep.startDate, calcType: p.dep.calcType as 'period' | 'rate',
    annualRate: p.dep.annualRate, activePeriodLength: p.dep.activePeriodLength,
    conservation: p.dep.conservationStartDate ? { start: p.dep.conservationStartDate, end: p.dep.conservationEndDate } : null,
    note: p.dep.note, serialNumber: p.dep.serialNumber,
  });
  return {
    inventoryNumber: asset.inventoryNumber, name: asset.name, personInCharge: asset.personInCharge, categoryId: asset.categoryId,
    debitAccountId: asset.debitAccountId, creditAccountId: asset.creditAccountId, inventoryAccountId: asset.inventoryAccountId,
    locationId: asset.locationId, synchronized: asset.areDepreciationsSynchronized, accounting: plan(sap), tax: plan(dap),
  };
}

export async function loadAssetBundle(db: DbOrTx, id: number) {
  const [asset] = await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.id, id));
  if (!asset) throw notFound('Активът');
  const plans = await loadPlans(db, [asset.accountingDepreciationId, asset.taxDepreciationId]);
  return { asset, sap: plans.get(asset.accountingDepreciationId)!, dap: plans.get(asset.taxDepreciationId)! };
}

/** Editor view of a stored asset. */
export async function assetView(db: DbOrTx, ctx: AssetCtx, id: number) {
  const { asset, sap, dap } = await loadAssetBundle(db, id);
  const c = await computeAsset(db, ctx, inputFromStored(asset, sap, dap), id, { stored: true });
  const locks = await lockInfo(db);
  let terminationNumber: string | null = null;
  if (asset.terminationAccountingId) {
    const [a] = await db.select({ number: s.accountings.number }).from(s.accountings).where(eq(s.accountings.id, asset.terminationAccountingId));
    terminationNumber = a?.number ?? null;
  }
  const reserves = await db.select().from(s.revaluationReserves).where(eq(s.revaluationReserves.fixedAssetId, id)).orderBy(asc(s.revaluationReserves.date), asc(s.revaluationReserves.id));
  return {
    id: asset.id, inventoryNumber: asset.inventoryNumber, name: asset.name, personInCharge: asset.personInCharge ?? '',
    categoryId: asset.categoryId, debitAccountId: asset.debitAccountId, creditAccountId: asset.creditAccountId, inventoryAccountId: asset.inventoryAccountId,
    locationId: asset.locationId, synchronized: asset.areDepreciationsSynchronized, isEuro: asset.isEuro,
    terminationStatusId: asset.terminationStatusId, terminationAccountingId: asset.terminationAccountingId, terminationAccountingNumber: terminationNumber,
    isTerminated: asset.terminationStatusId !== 1, revaluationReserve: dec(asset.revaluationReserve).toFixed(2),
    hasPostings: sap.rows.some((r) => r.accountingId),
    hasIasChanges: reserves.length > 0 || sap.improvements.length > 0,
    reserves: reserves.map((r) => ({ id: r.id, date: r.date, amount: dec(r.amount).toFixed(2), isDeleted: r.isDeleted })),
    accounting: planView(c.accounting, sap, locks),
    tax: planView(c.tax, dap, locks),
    messages: c.messages,
  };
}

/** Preview of an edited asset (recomputed plans + every message), nothing is saved. */
export async function previewAsset(db: DbOrTx, ctx: AssetCtx, input: AssetInput, id?: number) {
  const c = await computeAsset(db, ctx, input, id);
  const locks = await lockInfo(db);
  const sap = c.existing ? c.plans!.get(c.existing.accountingDepreciationId) : undefined;
  const dap = c.existing ? c.plans!.get(c.existing.taxDepreciationId) : undefined;
  return {
    accounting: planView(c.accounting, sap, locks),
    tax: planView(c.tax, dap, locks),
    messages: c.messages,
    conflicts: c.accounting.conflicts.map((x) => ({ month: x.month, accountingNumber: x.accountingNumber })),
  };
}

/* ------------------------------------------------------------------ */
/* Delete (11.5)                                                       */
/* ------------------------------------------------------------------ */

export async function deleteAsset(db: DbOrTx, ctx: AssetCtx, id: number) {
  const { asset, sap } = await loadAssetBundle(db, id);
  if (sap.rows.some((r) => r.accountingId)) throw badRequest(ASSET_MESSAGES.strFixedAssetAccountingAttachedError);
  // Revaluation postings stay in the ledger like the write-off posting (orphaned).
  await db.delete(s.fixedAssets).where(eq(s.fixedAssets.id, id));
  await db.delete(s.depreciations).where(inArray(s.depreciations.id, [asset.accountingDepreciationId, asset.taxDepreciationId]));
  await logActivity(db, ctx.userId, 'delete', 'fixedAsset', id, `${asset.inventoryNumber} ${asset.name}`);
}

/* ------------------------------------------------------------------ */
/* Register list (FixedAssetsListViewModel, 14.5)                      */
/* ------------------------------------------------------------------ */

export interface ListFilter {
  locationId?: number;
  inventoryNumber?: string;
  name?: string;
  account?: string;
  mol?: string;
  note?: string;
  categoryId?: number;
  state?: 'all' | 'active' | 'terminated';
  period?: 'all' | 'active' | 'expiredSap' | 'expiredDap' | 'writtenOffSap';
  from?: string;
  to?: string;
  showDepreciated?: boolean;
}

export async function listAssets(db: DbOrTx, ctx: AssetCtx, f: ListFilter) {
  const isEuro = ledgerIsEuro(ctx.year);
  const locIds = f.locationId ? await locationSubtree(db, f.locationId) : null;
  const res = await db.execute(sql`
    SELECT fa.id, fa.inventory_number, fa.name, fa.person_in_charge, fa.category_id, fa.location_id, fa.termination_status_id,
      fa.revaluation_reserve::text AS revaluation_reserve, fa.are_depreciations_synchronized,
      ia.number AS inventory_account, da.number AS debit_account, ca.number AS credit_account,
      sap.depreciation_amount::text AS cost, sap.depreciable_amount::text AS depreciable_amount, sap.start_date::text AS start_date,
      sap.acquisition_date::text AS acquisition_date, sap.end_date::text AS sap_end_date, sap.final_date::text AS sap_final_date,
      dap.end_date::text AS dap_end_date, dap.final_date::text AS dap_final_date, sap.note, sap.serial_number,
      (SELECT coalesce(sum(x.amount), 0) FROM depreciation_schedules x WHERE x.depreciation_id = sap.id AND x.is_processed)::text AS accrued,
      (SELECT count(*) FROM depreciation_schedules x WHERE x.depreciation_id = sap.id AND x.accounting_id IS NOT NULL)::int AS posted_count
    FROM fixed_assets fa
    JOIN depreciations sap ON sap.id = fa.accounting_depreciation_id
    JOIN depreciations dap ON dap.id = fa.tax_depreciation_id
    LEFT JOIN accounts ia ON ia.id = fa.inventory_account_id
    LEFT JOIN accounts da ON da.id = fa.debit_account_id
    LEFT JOIN accounts ca ON ca.id = fa.credit_account_id
    WHERE fa.is_euro = ${isEuro}
    ORDER BY fa.inventory_number, fa.id`);
  const paths = await locationPaths(db);
  type Row = { id: number; inventory_number: string; name: string; person_in_charge: string | null; category_id: number; location_id: number; termination_status_id: number; revaluation_reserve: string; are_depreciations_synchronized: boolean; inventory_account: string | null; debit_account: string | null; credit_account: string | null; cost: string; depreciable_amount: string; start_date: string; acquisition_date: string; sap_end_date: string; sap_final_date: string | null; dap_end_date: string; dap_final_date: string | null; note: string | null; serial_number: string | null; accrued: string; posted_count: number };
  const rows = (res as unknown as { rows: Row[] }).rows;
  const within = (d: string | null) => !!d && (!f.from || d >= f.from) && (!f.to || d <= f.to);
  const lc = (x: string | null | undefined) => (x ?? '').toLowerCase();
  const acctMatch = (n: string | null, p: string) => !!n && (n === p || n.startsWith(p));
  return rows.filter((r) => {
    if (locIds && !locIds.includes(r.location_id)) return false;
    if (f.inventoryNumber && !lc(r.inventory_number).startsWith(lc(f.inventoryNumber))) return false;
    if (f.name && !lc(r.name).includes(lc(f.name))) return false;
    if (f.account && !(acctMatch(r.inventory_account, f.account) || acctMatch(r.debit_account, f.account) || acctMatch(r.credit_account, f.account))) return false;
    if (f.mol && !lc(r.person_in_charge).includes(lc(f.mol))) return false;
    if (f.note && !lc(r.note).includes(lc(f.note))) return false;
    if (f.categoryId && r.category_id !== f.categoryId) return false;
    if (f.state === 'active' && r.termination_status_id !== 1) return false;
    if (f.state === 'terminated' && r.termination_status_id === 1) return false;
    if (f.showDepreciated === false && r.sap_end_date !== NO_END_DATE && f.from && endOfMonth(r.sap_end_date) < f.from && r.termination_status_id === 1) return false;
    switch (f.period) {
      case 'active': return (!f.to || r.start_date <= f.to) && (!f.from || (r.sap_end_date >= firstOfMonth(f.from) && (!r.sap_final_date || r.sap_final_date >= f.from)));
      case 'expiredSap': return within(r.sap_end_date);
      case 'expiredDap': return within(r.dap_end_date);
      case 'writtenOffSap': return within(r.sap_final_date);
      default: return true;
    }
  }).map((r) => ({
    id: r.id, inventoryNumber: r.inventory_number, name: r.name, personInCharge: r.person_in_charge, categoryId: r.category_id,
    locationId: r.location_id, location: paths.get(r.location_id) ?? '', terminationStatusId: r.termination_status_id,
    inventoryAccount: r.inventory_account, debitAccount: r.debit_account, creditAccount: r.credit_account,
    cost: dec(r.cost).toFixed(2), accrued: dec(r.accrued).toFixed(2), bookValue: dec(r.cost).plus(dec(r.revaluation_reserve)).minus(dec(r.accrued)).toFixed(2),
    acquisitionDate: r.acquisition_date, startDate: r.start_date,
    sapEndDate: r.sap_end_date === NO_END_DATE ? null : r.sap_end_date, dapEndDate: r.dap_end_date === NO_END_DATE ? null : r.dap_end_date,
    sapFinalDate: r.sap_final_date, dapFinalDate: r.dap_final_date, note: r.note, serialNumber: r.serial_number,
    hasPostings: r.posted_count > 0, synchronized: r.are_depreciations_synchronized,
  }));
}

/* ------------------------------------------------------------------ */
/* Memorial-order numbers                                              */
/* ------------------------------------------------------------------ */

/** Next memorial-order number of the year (channel 6), skipping numbers already used by МО documents. */
export async function nextMemorialNumber(db: DbOrTx, fy: ActiveYear) {
  const r = await reserveNumber(db, MEMORIAL_ORDER_CHANNEL, fy.id, async (n) => {
    const rows = await db.execute(sql`SELECT 1 FROM documents WHERE document_type_id = ${MEMORIAL_ORDER_TYPE} AND number = ${n} AND date BETWEEN ${`${fy.year}-01-01`} AND ${`${fy.year}-12-31`} LIMIT 1`);
    return (rows as unknown as { rows: unknown[] }).rows.length > 0;
  });
  return r.number;
}
