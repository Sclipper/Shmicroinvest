import { eq } from 'drizzle-orm';
import {
  costAt, D, dec, DEPRECIATION_CATEGORIES, DEPRECIATION_CATEGORY, EURO_CHANGEOVER_DATE, endOfMonth, firstOfMonth,
  NO_END_DATE, round, sum, TERMINATION_TYPES, ZERO, type Dec,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { loadPlans, locationPaths, locationSubtree, type StoredPlan } from './assets.ts';
import { matchesAccount } from './reports.ts';

/**
 * Fixed-asset reports (spec 03b 15, 05 7.10). Every report picks the ledger by
 * its end date: EUR assets when the date is on/after 2026-01-01, else BGN.
 */

interface LedgerAsset {
  asset: typeof s.fixedAssets.$inferSelect;
  sap: StoredPlan;
  dap: StoredPlan;
  location: string;
  inventoryAccount: string | null;
  inventoryAccountName: string | null;
  debitAccount: string | null;
  creditAccount: string | null;
  reserves: (typeof s.revaluationReserves.$inferSelect)[];
}

export interface CommonFilter {
  inventoryNumber?: string;
  name?: string;
  locationIds?: number[];
  account?: string;
  mol?: string;
  note?: string;
  serialNumber?: string;
}

async function loadLedger(db: DbOrTx, isEuro: boolean): Promise<LedgerAsset[]> {
  const assets = await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.isEuro, isEuro));
  const plans = await loadPlans(db, assets.flatMap((a) => [a.accountingDepreciationId, a.taxDepreciationId]));
  const paths = await locationPaths(db);
  const accounts = new Map((await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description }).from(s.accounts)).map((a) => [a.id, a]));
  const reserves = await db.select().from(s.revaluationReserves);
  const num = (id: number | null) => (id ? accounts.get(id)?.number ?? null : null);
  return assets.map((asset) => ({
    asset,
    sap: plans.get(asset.accountingDepreciationId)!,
    dap: plans.get(asset.taxDepreciationId)!,
    location: paths.get(asset.locationId) ?? '',
    inventoryAccount: num(asset.inventoryAccountId),
    inventoryAccountName: asset.inventoryAccountId ? accounts.get(asset.inventoryAccountId)?.description ?? null : null,
    debitAccount: num(asset.debitAccountId),
    creditAccount: num(asset.creditAccountId),
    reserves: reserves.filter((r) => r.fixedAssetId === asset.id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)),
  }));
}

const lc = (x: string | null | undefined) => (x ?? '').toLowerCase();

async function filterAssets(db: DbOrTx, list: LedgerAsset[], f: CommonFilter, opts: { molPrefix?: boolean; accountRule?: 'number' | 'prefix' } = {}) {
  let locs: Set<number> | null = null;
  if (f.locationIds?.length) {
    locs = new Set<number>();
    for (const id of f.locationIds) for (const x of await locationSubtree(db, id)) locs.add(x);
  }
  return list.filter((x) => {
    if (locs && !locs.has(x.asset.locationId)) return false;
    if (f.inventoryNumber && !lc(x.asset.inventoryNumber).includes(lc(f.inventoryNumber))) return false;
    if (f.name && !lc(x.asset.name).includes(lc(f.name))) return false;
    if (f.mol) {
      const m = lc(x.asset.personInCharge);
      if (opts.molPrefix ? !m.startsWith(lc(f.mol)) : !m.includes(lc(f.mol))) return false;
    }
    if (f.account) {
      const n = x.inventoryAccount ?? '';
      if (opts.accountRule === 'prefix' ? !n.startsWith(f.account) : !matchesAccount(n, f.account)) return false;
    }
    if (f.note && !lc(x.sap.dep.note).includes(lc(f.note))) return false;
    if (f.serialNumber && !lc(x.sap.dep.serialNumber).includes(lc(f.serialNumber))) return false;
    return true;
  });
}

const improvementsOf = (p: StoredPlan) => p.improvements.map((i) => ({ date: i.improvementDate, amount: i.newDepreciationAmount }));
/** Rows limited by the write-off date (Month <= IsNull(FinalDate, '2100-01-01')). */
const activeRows = (p: StoredPlan) => p.rows.filter((r) => r.month <= (p.dep.finalDate ?? '2100-01-01'));
const isLand = (a: LedgerAsset) => a.asset.categoryId === DEPRECIATION_CATEGORY.LandAndForests;

/** Revaluation reserve up to a year: sum of the year slots, or for land the latest reserve row minus the cost. */
function reserveUpTo(a: LedgerAsset, date: string): Dec {
  if (isLand(a)) {
    const last = a.reserves.filter((r) => !r.isDeleted && r.date <= date).pop();
    return last ? dec(last.amount).minus(costAt(a.sap.dep.depreciationAmount, improvementsOf(a.sap), date)) : ZERO;
  }
  const y = Number(date.slice(0, 4));
  return sum(a.sap.years.filter((x) => Number(x.year.slice(0, 4)) <= y).map((x) => x.revaluationReserve));
}

const blankEnd = (d: string | null) => (!d || d === NO_END_DATE || d.startsWith('9999') ? null : d);
const categoryName = (id: number) => DEPRECIATION_CATEGORIES.find((c) => c.id === id)?.description ?? '';

/* ------------------------------------------------------------------ */
/* Месечни амортизационни квоти                                        */
/* ------------------------------------------------------------------ */

export async function quotasReport(db: DbOrTx, o: CommonFilter & { year: number | null; type: 'sap' | 'dap'; activeYear: number }) {
  const isEuro = o.year ? o.year >= 2026 : o.activeYear > 2025;
  const list = await filterAssets(db, await loadLedger(db, isEuro), o);
  const assets = [];
  const monthTotals = Array.from({ length: 12 }, () => ZERO);
  for (const a of list) {
    const p = o.type === 'sap' ? a.sap : a.dap;
    const rows = activeRows(p);
    if (!rows.length) continue;
    const years = [...new Set(rows.map((r) => Number(r.month.slice(0, 4))))].sort((x, y) => x - y).filter((y) => !o.year || y === o.year);
    if (!years.length) continue;
    const yearRows = years.map((y) => {
      const months = Array.from({ length: 12 }, (_, m) => sum(rows.filter((r) => r.month === `${y}-${String(m + 1).padStart(2, '0')}-01`).map((r) => r.amount)));
      const total = sum(months);
      const before = sum(rows.filter((r) => r.month < `${y}-01-01`).map((r) => r.amount));
      const cost = costAt(p.dep.depreciationAmount, improvementsOf(p), `${y}-12-31`);
      if (!o.year || y === o.year) months.forEach((m, i) => (monthTotals[i] = monthTotals[i]!.plus(m)));
      return {
        year: y, months: months.map((m) => m.toFixed(2)), total: total.toFixed(2), before: before.toFixed(2), cost: cost.toFixed(2),
        // "PayedTillNow" = cost - schedule rows up to the end of that year.
        bookValue: cost.minus(before).minus(total).toFixed(2),
      };
    });
    assets.push({
      id: a.asset.id, inventoryNumber: a.asset.inventoryNumber, name: a.asset.name, startDate: p.dep.startDate,
      cost: dec(p.dep.depreciationAmount).toFixed(2),
      total: sum(yearRows.map((y) => y.total)).toFixed(2),
      years: yearRows,
    });
  }
  assets.sort((x, y) => x.name.localeCompare(y.name, 'bg') || x.inventoryNumber.localeCompare(y.inventoryNumber));
  return { assets, monthTotals: monthTotals.map((m) => m.toFixed(2)), total: sum(monthTotals).toFixed(2), currency: isEuro ? 'EUR' : 'BGN' };
}

/* ------------------------------------------------------------------ */
/* Инвентарна книга                                                    */
/* ------------------------------------------------------------------ */

export async function inventoryBookReport(db: DbOrTx, o: CommonFilter & { toDate: string }) {
  const isEuro = o.toDate >= EURO_CHANGEOVER_DATE;
  const list = await filterAssets(db, await loadLedger(db, isEuro), o, { molPrefix: true });
  const year = Number(o.toDate.slice(0, 4));
  const rows = list
    .filter((a) => a.sap.dep.acquisitionDate <= o.toDate && (!a.sap.dep.finalDate || Number(a.sap.dep.finalDate.slice(0, 4)) >= year))
    .map((a) => {
      const p = a.sap;
      const cost = costAt(p.dep.depreciationAmount, improvementsOf(p), endOfMonth(o.toDate));
      const accrued = sum(p.rows.filter((r) => r.isProcessed && r.month <= o.toDate).map((r) => r.amount));
      const reserve = reserveUpTo(a, o.toDate);
      return {
        id: a.asset.id, inventoryNumber: a.asset.inventoryNumber, name: a.asset.name, serialNumber: p.dep.serialNumber ?? '', location: a.location,
        acquisitionDate: p.dep.acquisitionDate, startDate: p.dep.startDate, finalDate: blankEnd(p.dep.finalDate), endDate: blankEnd(p.dep.endDate),
        activePeriodLength: p.dep.activePeriodLength, activeYears: round(dec(p.dep.activePeriodLength).div(12), 0).toNumber(),
        cost: cost.toFixed(2), revaluationReserve: reserve.toFixed(2), personInCharge: a.asset.personInCharge ?? '',
        accrued: accrued.toFixed(2), bookValue: cost.minus(accrued).toFixed(2), account: a.inventoryAccount ?? '',
      };
    })
    .sort((x, y) => x.inventoryNumber.localeCompare(y.inventoryNumber));
  const t = (k: 'cost' | 'revaluationReserve' | 'accrued' | 'bookValue') => sum(rows.map((r) => r[k])).toFixed(2);
  return { rows, totals: { cost: t('cost'), revaluationReserve: t('revaluationReserve'), accrued: t('accrued'), bookValue: t('bookValue') }, currency: isEuro ? 'EUR' : 'BGN' };
}

/* ------------------------------------------------------------------ */
/* Амортизационен план                                                 */
/* ------------------------------------------------------------------ */

export type PlanSort = 'inventoryNumber' | 'name' | 'startDate' | 'endDate';

export async function depreciationPlanReport(db: DbOrTx, o: CommonFilter & { month: string; type: 'sap' | 'dap' | 'ias'; sort?: PlanSort; showWrittenOff?: boolean }) {
  const date = endOfMonth(o.month);
  const monthStart = firstOfMonth(o.month);
  const year = Number(date.slice(0, 4));
  const isEuro = date >= EURO_CHANGEOVER_DATE;
  const list = await filterAssets(db, await loadLedger(db, isEuro), o);
  const accounting = o.type !== 'dap';
  const out: Record<string, string | number | null>[] = [];
  for (const a of list) {
    const p = accounting ? a.sap : a.dap;
    if (firstOfMonth(p.dep.startDate) > monthStart) continue;
    const endYear = p.dep.endDate === NO_END_DATE ? 9999 : Number(p.dep.endDate.slice(0, 4));
    const finalYear = p.dep.finalDate ? Number(p.dep.finalDate.slice(0, 4)) : 9999;
    if (!o.showWrittenOff && (endYear < year || finalYear < year)) continue;
    if (o.type === 'ias' && isLand(a) && !a.reserves.length) continue;
    const rows = activeRows(p);
    const counted = (r: (typeof rows)[number]) => (accounting ? r.isProcessed : true);
    const accrued = sum(rows.filter((r) => counted(r) && r.month <= date).map((r) => r.amount));
    const before = sum(rows.filter((r) => counted(r) && r.month < `${year}-01-01`).map((r) => r.amount));
    const currentYear = sum(rows.filter((r) => counted(r) && r.month >= `${year}-01-01` && r.month <= date).map((r) => r.amount));
    const cost = costAt(p.dep.depreciationAmount, improvementsOf(p), date);
    const da = dec(p.dep.depreciableAmount);
    const yp = p.years.find((y) => Number(y.year.slice(0, 4)) === year);
    const writtenOff = Boolean(p.dep.finalDate && p.dep.finalDate <= date);
    const reserve = accounting ? reserveUpTo(a, date) : ZERO;
    const finalShown = accounting ? p.dep.finalDate ?? (p.dep.endDate !== NO_END_DATE && p.dep.endDate <= date ? p.dep.endDate : null) : p.dep.finalDate;
    const monthRow = rows.find((r) => r.month === monthStart) ?? rows[0];
    const lastImp = p.improvements.length > 1 ? p.improvements[p.improvements.length - 1]!.improvementDate : null;
    out.push({
      id: a.asset.id, inventoryNumber: a.asset.inventoryNumber, name: a.asset.name, startDate: p.dep.startDate, finalDate: finalShown,
      years: round(dec(p.dep.activePeriodLength).div(12), 0).toNumber(), activePeriodLength: p.dep.activePeriodLength,
      cost: cost.toFixed(2), nonDepreciableAmount: dec(p.dep.nonDepreciableAmount).toFixed(2), depreciableAmount: da.toFixed(2),
      accrued: accrued.toFixed(2), previousYears: before.toFixed(2), remainder: D.max(ZERO, da.minus(accrued)).toFixed(2),
      bookValue: (writtenOff ? ZERO : cost.minus(accrued).plus(o.type === 'ias' ? reserve : ZERO)).toFixed(2),
      percentage: yp ? dec(yp.percentage).toDecimalPlaces(2).toFixed(2) : '0.00', currentYear: currentYear.toFixed(2),
      lastImprovementDate: lastImp, conservationStart: p.dep.conservationStartDate, conservationEnd: p.dep.conservationEndDate,
      writeOffMonth: p.dep.finalDate ? firstOfMonth(p.dep.finalDate) : null, personInCharge: a.asset.personInCharge ?? '', location: a.location,
      endDate: blankEnd(p.dep.endDate), acquisitionDate: p.dep.acquisitionDate, yearQuota: dec(yp?.amount ?? 0).toFixed(2), monthQuota: dec(monthRow?.amount ?? 0).toFixed(2),
      revaluationReserve: reserve.toFixed(2), serialNumber: p.dep.serialNumber ?? '',
      terminationReason: a.asset.terminationStatusId !== 1 ? TERMINATION_TYPES.find((t) => t.id === a.asset.terminationStatusId)?.description ?? '' : '',
      oldValue: cost.toFixed(2), newValue: cost.plus(reserve).toFixed(2), difference: reserve.toFixed(2),
      inventoryAccount: a.inventoryAccount ?? '', debitAccount: a.debitAccount ?? '', creditAccount: a.creditAccount ?? '', note: p.dep.note ?? '',
    });
  }
  const sortKey = o.sort ?? 'inventoryNumber';
  out.sort((x, y) => {
    const a = (x[sortKey] ?? '') as string;
    const b = (y[sortKey] ?? '') as string;
    return a < b ? -1 : a > b ? 1 : String(x.inventoryNumber).localeCompare(String(y.inventoryNumber));
  });
  const t = (k: 'cost' | 'nonDepreciableAmount' | 'depreciableAmount' | 'accrued' | 'previousYears' | 'remainder' | 'bookValue' | 'currentYear' | 'yearQuota' | 'revaluationReserve') => sum(out.map((r) => r[k] as string)).toFixed(2);
  return {
    rows: out,
    totals: {
      cost: t('cost'), nonDepreciableAmount: t('nonDepreciableAmount'), depreciableAmount: t('depreciableAmount'), accrued: t('accrued'), previousYears: t('previousYears'),
      remainder: t('remainder'), bookValue: t('bookValue'), currentYear: t('currentYear'), yearQuota: t('yearQuota'), revaluationReserve: t('revaluationReserve'),
    },
    currency: isEuro ? 'EUR' : 'BGN',
  };
}

/* ------------------------------------------------------------------ */
/* Активи по категории (ДАП, Справка 2 of the annual tax return)       */
/* ------------------------------------------------------------------ */

export async function assetsByCategoriesReport(db: DbOrTx, o: { year: number; filterBy?: 'inventoryNumber' | 'name'; filter?: string; locationIds?: number[] }) {
  const isEuro = o.year >= 2026;
  const list = await filterAssets(db, await loadLedger(db, isEuro), {
    locationIds: o.locationIds, inventoryNumber: o.filterBy === 'inventoryNumber' ? o.filter : undefined, name: o.filterBy !== 'inventoryNumber' ? o.filter : undefined,
  });
  const end = `${o.year}-12-31`;
  const start = `${o.year}-01-01`;
  const rows = list
    .filter((a) => !isLand(a) && a.dap.dep.startDate <= end && !(a.dap.dep.finalDate && a.dap.dep.finalDate < start))
    .map((a) => {
      const p = a.dap;
      const rowsIn = activeRows(p);
      const endYear = p.dep.endDate === NO_END_DATE ? 9999 : Number(p.dep.endDate.slice(0, 4));
      return {
        id: a.asset.id, inventoryNumber: a.asset.inventoryNumber, name: a.asset.name, categoryId: a.asset.categoryId, category: categoryName(a.asset.categoryId),
        totalValue: (endYear >= o.year ? dec(p.dep.depreciableAmount) : ZERO).toFixed(2),
        totalDepreciations: sum(rowsIn.filter((r) => r.month <= end).map((r) => r.amount)).toFixed(2),
        currentYear: sum(rowsIn.filter((r) => r.month >= start && r.month <= end).map((r) => r.amount)).toFixed(2),
      };
    })
    .sort((x, y) => x.categoryId - y.categoryId || x.inventoryNumber.localeCompare(y.inventoryNumber));
  const categories = [...new Set(rows.map((r) => r.categoryId))].map((id) => {
    const rs = rows.filter((r) => r.categoryId === id);
    return {
      categoryId: id, category: categoryName(id),
      totalValue: sum(rs.map((r) => r.totalValue)).toFixed(2), totalDepreciations: sum(rs.map((r) => r.totalDepreciations)).toFixed(2), currentYear: sum(rs.map((r) => r.currentYear)).toFixed(2),
    };
  });
  return {
    rows, categories,
    totals: { totalValue: sum(rows.map((r) => r.totalValue)).toFixed(2), totalDepreciations: sum(rows.map((r) => r.totalDepreciations)).toFixed(2), currentYear: sum(rows.map((r) => r.currentYear)).toFixed(2) },
    currency: isEuro ? 'EUR' : 'BGN',
  };
}

/* ------------------------------------------------------------------ */
/* Инвентаризационен опис на ДМА (по МОЛ)                              */
/* ------------------------------------------------------------------ */

export async function inventoryListMolReport(db: DbOrTx, o: { date: string; account?: string; mol?: string; locationIds?: number[] }) {
  const isEuro = o.date >= EURO_CHANGEOVER_DATE;
  const list = await filterAssets(db, await loadLedger(db, isEuro), { account: o.account, mol: o.mol, locationIds: o.locationIds }, { accountRule: 'prefix' });
  const rows = list
    .filter((a) => a.sap.dep.startDate <= o.date && (!a.sap.dep.finalDate || a.sap.dep.finalDate >= o.date))
    .map((a) => ({
      id: a.asset.id, personInCharge: a.asset.personInCharge ?? '', inventoryNumber: a.asset.inventoryNumber, name: a.asset.name,
      serialNumber: a.sap.dep.serialNumber ?? '', cost: costAt(a.sap.dep.depreciationAmount, improvementsOf(a.sap), o.date).toFixed(2),
      accrued: sum(a.sap.rows.filter((r) => r.isProcessed && r.month <= o.date).map((r) => r.amount)).toFixed(2),
      startDate: a.sap.dep.startDate, location: a.location, account: a.inventoryAccount ?? '',
    }))
    .sort((x, y) => x.personInCharge.localeCompare(y.personInCharge, 'bg') || x.inventoryNumber.localeCompare(y.inventoryNumber));
  const groups = [...new Set(rows.map((r) => r.personInCharge))].map((mol) => {
    const rs = rows.filter((r) => r.personInCharge === mol);
    return { personInCharge: mol, rows: rs, cost: sum(rs.map((r) => r.cost)).toFixed(2), accrued: sum(rs.map((r) => r.accrued)).toFixed(2) };
  });
  const mols = [...new Set((await loadLedger(db, isEuro)).map((a) => a.asset.personInCharge ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'bg'));
  return { groups, mols, totals: { cost: sum(rows.map((r) => r.cost)).toFixed(2), accrued: sum(rows.map((r) => r.accrued)).toFixed(2) }, currency: isEuro ? 'EUR' : 'BGN' };
}

