import { and, eq } from 'drizzle-orm';
import {
  ASSET_IMPORT_MESSAGES, assetImportMsg, checkAssetImport, dec, findAssetSheets, importedPlanInput, readAssetSheet,
  type ExcelSheet, type ExchangeMessage, type ImportedFixedAsset,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { ApiError } from '../../lib/errors.ts';
import { ASSET_SEQUENCE_CHANNEL, ledgerIsEuro, listLocations, saveAsset, type AssetCtx, type AssetInput } from '../assets.ts';
import { peekNextNumber } from '../sequences.ts';
import { loadChart } from './common.ts';

export interface AssetImportResult {
  imported: number;
  ids: number[];
  warnings: ExchangeMessage[];
  message: string;
}

const blocked = (errors: ExchangeMessage[]) =>
  new ApiError(422, `${ASSET_IMPORT_MESSAGES.strImportCouldNotBeDone}\n${errors.map((e) => e.text).join('\n')}`, errors);

/**
 * Fixed-assets Excel import (04a 5.5, 03b 14.2). Reads the САП sheet and its
 * "{name} - ДАП" sheet, runs the cross-sheet checks (all blocking, reported
 * together) and saves every asset through the normal save with both plans
 * built on the useful life in "international accounting recalculation" mode:
 * the months up to ToDate are processed (no postings) and carry the accrued
 * amount, the rest is spread over the remaining months.
 */
export async function importFixedAssets(db: DbOrTx, ctx: AssetCtx, sheets: ExcelSheet[]): Promise<AssetImportResult> {
  const pair = findAssetSheets(sheets);
  if (!pair) throw new ApiError(422, ASSET_IMPORT_MESSAGES.strFixedAssetImportSheetDapNotFound);
  const sap = readAssetSheet(pair.sap, true);
  const dap = readAssetSheet(pair.dap, false);
  const cellErrors = [...sap.errors, ...dap.errors];
  if (cellErrors.length) throw blocked(cellErrors);
  if (!sap.rows.length) throw new ApiError(422, ASSET_IMPORT_MESSAGES.strFixedAssetImportNoData);

  const isEuro = ledgerIsEuro(ctx.year);
  const existing = await db.select({ n: s.fixedAssets.inventoryNumber }).from(s.fixedAssets).where(eq(s.fixedAssets.isEuro, isEuro));
  const width = (await peekNextNumber(db, ASSET_SEQUENCE_CHANNEL, ctx.year.id)).length;
  const normalizeInventoryNumber = (n: string) => (width && /^\d+$/.test(n) ? n.padStart(width, '0') : n);
  const chart = await loadChart(db, ctx.year.year);
  const locations = await listLocations(db);
  const byName = new Map(locations.map((l) => [l.name.trim().toLowerCase(), l.id]));

  const r = checkAssetImport(sap.rows, dap.rows, {
    existingInventoryNumbers: new Set(existing.map((e) => e.n)),
    normalizeInventoryNumber,
    accountExists: (n) => chart.byNumber.has(n),
    locationByName: (n) => byName.get(n.trim().toLowerCase()) ?? null,
    sapLetters: sap.letters,
  });
  if (r.errors.length) throw blocked(r.errors);

  const ids: number[] = [];
  const warnings = [...r.warnings];
  for (const a of r.assets) {
    const input = assetInput(a, (n) => chart.byNumber.get(n)?.id ?? null);
    const saved = await saveAsset(db, ctx, input);
    let id = saved.id;
    // Revaluation reserve of the САП: stored on the year of ToDate, then the plan is re-spread
    // on the base including the reserve (same IAS mode).
    if (!dec(a.revaluationReserve).isZero()) id = await applyReserve(db, ctx, input, id, a);
    ids.push(id);
    warnings.push(...saved.warnings.map((w) => ({ key: w.key, text: `${a.inventoryNumber}: ${w.text}`, severity: 'warning' as const })));
  }
  return { imported: ids.length, ids, warnings, message: assetImportMsg('strFixedAssetsImported', ids.length) };
}

function assetInput(a: ImportedFixedAsset, accountId: (n: string) => number | null): AssetInput {
  return {
    inventoryNumber: a.inventoryNumber,
    name: a.name,
    personInCharge: a.mol || null,
    categoryId: a.categoryId,
    inventoryAccountId: a.assetAccount ? accountId(a.assetAccount) : null,
    debitAccountId: a.depreciationAccount ? accountId(a.depreciationAccount) : null,
    creditAccountId: a.expenseAccount ? accountId(a.expenseAccount) : null,
    locationId: a.locationId,
    synchronized: a.synchronized,
    accounting: importedPlanInput(a.sap, true, a.synchronized),
    tax: importedPlanInput(a.dap, false, a.synchronized),
    plansDifferAccepted: true,
    iasMode: true,
  };
}

async function applyReserve(db: DbOrTx, ctx: AssetCtx, input: AssetInput, id: number, a: ImportedFixedAsset) {
  const [asset] = await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.id, id));
  const depId = asset!.accountingDepreciationId;
  const year = `${(a.sap.toDate ?? a.sap.startDate).slice(0, 4)}-01-01`;
  const reserve = dec(a.revaluationReserve).toFixed(6);
  const where = and(eq(s.depreciationYearPlans.depreciationId, depId), eq(s.depreciationYearPlans.year, year));
  const [slot] = await db.select().from(s.depreciationYearPlans).where(where);
  if (slot) await db.update(s.depreciationYearPlans).set({ revaluationReserve: reserve }).where(where);
  else await db.insert(s.depreciationYearPlans).values({ depreciationId: depId, year, percentage: '0', amount: '0', revaluationReserve: reserve });
  return (await saveAsset(db, ctx, input, id)).id;
}
