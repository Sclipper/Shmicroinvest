import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DEPRECIATION_CATEGORIES, DEPRECIATION_METHODS, TERMINATION_TYPES, CATEGORY_MAX_RATE, RATE_PRESETS } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission, workingDate } from '../session.ts';
import {
  addLocation, assetView, deleteAsset, deleteLocation, editLocation, listAssets, listLocations, newAssetDefaults, previewAsset,
  saveAsset, type AssetCtx, type ListFilter,
} from '../services/assets.ts';
import {
  addImprovement, applyIas, assetCard, convertAssetsToEur, editCommonData, iasInfo, pendingRequests, postRequests, protocol58,
  reconcile, removeImprovement, requestDefaults, restoreAsset, scrappingProtocol, terminateAsset, terminateInfo,
} from '../services/assetOps.ts';
import {
  assetsByCategoriesReport, depreciationPlanReport, inventoryBookReport, inventoryListMolReport, quotasReport, type PlanSort,
} from '../services/assetReports.ts';

const ASSETS = 'UI_Operations_Depreciations';
const REQUESTS = 'UI_Operations_AccountingRequests';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const optDate = date.nullable().optional();

const planBody = z.object({
  depreciationAmount: amount,
  nonDepreciableAmount: amount.nullable().optional(),
  acquisitionDate: date,
  startDate: date,
  calcType: z.enum(['period', 'rate']),
  annualRate: amount.nullable().optional(),
  activePeriodLength: z.number().int().min(0).max(12000).nullable().optional(),
  conservation: z.object({ start: date.nullable(), end: date.nullable() }).nullable().optional(),
  note: z.string().max(1024).nullable().optional(),
  serialNumber: z.string().max(255).nullable().optional(),
  manualAccrued: z.object({ date: date.nullable(), amount: amount.nullable() }).nullable().optional(),
  months: z.array(z.object({ month: date, amount })).nullable().optional(),
  regenerate: z.boolean().optional(),
});

const assetBody = z.object({
  inventoryNumber: z.string().max(30),
  name: z.string().max(255),
  personInCharge: z.string().max(255).nullable().optional(),
  categoryId: z.number().int().min(1).max(8).nullable().optional(),
  debitAccountId: z.number().int().nullable().optional(),
  creditAccountId: z.number().int().nullable().optional(),
  inventoryAccountId: z.number().int().nullable().optional(),
  locationId: z.number().int().nullable().optional(),
  synchronized: z.boolean(),
  accounting: planBody,
  tax: planBody,
  postingsResolution: z.enum(['delete', 'unlink']).nullable().optional(),
  clearImprovements: z.boolean().optional(),
});

function ctxOf(c: Context<AppEnv>): AssetCtx {
  return { year: c.var.year, userId: c.var.user.id, appDate: workingDate(c.var.session) };
}

const ids = (v: string | undefined) => (v ? v.split(',').map(Number).filter((x) => Number.isFinite(x) && x > 0) : []);

export const assetRoutes = new Hono<AppEnv>()
  /* ---- reference data ---- */
  .get('/assets/lookups', (c) => c.json({
    categories: DEPRECIATION_CATEGORIES, methods: DEPRECIATION_METHODS, terminationTypes: TERMINATION_TYPES,
    maxRates: CATEGORY_MAX_RATE, ratePresets: RATE_PRESETS,
  }))

  /* ---- locations ---- */
  .get('/asset-locations', requirePermission(ASSETS), async (c) => c.json(await listLocations(c.var.db)))
  .post('/asset-locations', requirePermission(ASSETS), zValidator('json', z.object({ name: z.string().max(255), parentId: z.number().int() })), async (c) => {
    const { name, parentId } = c.req.valid('json');
    return c.json(await c.var.db.transaction((tx) => addLocation(tx, name, parentId)), 201);
  })
  .put('/asset-locations/:id', requirePermission(ASSETS), zValidator('json', z.object({ name: z.string().max(255).optional(), parentId: z.number().int().optional() })), async (c) => {
    await c.var.db.transaction((tx) => editLocation(tx, Number(c.req.param('id')), c.req.valid('json')));
    return c.json({ ok: true });
  })
  .delete('/asset-locations/:id', requirePermission(ASSETS), async (c) => {
    await c.var.db.transaction((tx) => deleteLocation(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  /* ---- register ---- */
  .get('/assets', requirePermission(ASSETS), async (c) => {
    const q = c.req.query();
    const f: ListFilter = {
      locationId: q.locationId ? Number(q.locationId) : undefined, inventoryNumber: q.inventoryNumber, name: q.name, account: q.account,
      mol: q.mol, note: q.note, categoryId: q.categoryId ? Number(q.categoryId) : undefined, state: (q.state as ListFilter['state']) ?? 'all',
      period: (q.period as ListFilter['period']) ?? 'all', from: q.from, to: q.to,
    };
    return c.json(await listAssets(c.var.db, ctxOf(c), f));
  })
  .get('/assets/new', requirePermission(ASSETS), async (c) => c.json(await newAssetDefaults(c.var.db, ctxOf(c))))
  .post('/assets/preview', requirePermission(ASSETS), zValidator('json', assetBody.extend({ id: z.number().int().nullable().optional() })), async (c) => {
    const { id, ...input } = c.req.valid('json');
    return c.json(await previewAsset(c.var.db, ctxOf(c), input, id ?? undefined));
  })
  .post('/assets', requirePermission(ASSETS), zValidator('json', assetBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveAsset(tx, ctxOf(c), c.req.valid('json')));
    return c.json(r, 201);
  })
  .post('/assets/common-data', requirePermission(ASSETS), zValidator('json', z.object({
    ids: z.array(z.number().int()).min(1), mol: z.string().max(255).nullable().optional(), sapRate: amount.nullable().optional(),
    dapRate: amount.nullable().optional(), confirm: z.boolean().optional(),
  })), async (c) => c.json(await c.var.db.transaction((tx) => editCommonData(tx, ctxOf(c), c.req.valid('json')))))
  .post('/assets/euro-conversion', requirePermission(ASSETS), async (c) => c.json(await c.var.db.transaction((tx) => convertAssetsToEur(tx, ctxOf(c)))))
  .get('/assets/check', requirePermission(ASSETS), async (c) => {
    const y = c.var.year.year;
    return c.json(await reconcile(c.var.db, ctxOf(c), c.req.query('from') ?? `${y}-01-01`, c.req.query('to') ?? `${y}-12-31`));
  })
  .get('/assets/protocol58', requirePermission(ASSETS), async (c) => c.json(await protocol58(c.var.db, ctxOf(c), ids(c.req.query('ids')))))
  .get('/assets/scrapping-protocol', requirePermission(ASSETS), async (c) => c.json(await scrappingProtocol(c.var.db, ctxOf(c), ids(c.req.query('ids')))))
  .get('/assets/:id', requirePermission(ASSETS), async (c) => c.json(await assetView(c.var.db, ctxOf(c), Number(c.req.param('id')))))
  .get('/assets/:id/card', requirePermission(ASSETS), async (c) => c.json(await assetCard(c.var.db, ctxOf(c), Number(c.req.param('id')), c.req.query('date') ?? workingDate(c.var.session))))
  .put('/assets/:id', requirePermission(ASSETS), zValidator('json', assetBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveAsset(tx, ctxOf(c), c.req.valid('json'), Number(c.req.param('id'))));
    return c.json(r);
  })
  .delete('/assets/:id', requirePermission(ASSETS), async (c) => {
    await c.var.db.transaction((tx) => deleteAsset(tx, ctxOf(c), Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .get('/assets/:id/terminate', requirePermission(ASSETS), async (c) => c.json(await terminateInfo(c.var.db, ctxOf(c), Number(c.req.param('id')))))
  .post('/assets/:id/terminate', requirePermission(ASSETS), zValidator('json', z.object({
    type: z.number().int().min(2).max(5), sapDate: date, dapDate: date, operationAccountId: z.number().int().nullable().optional(),
    revaluationAccountId: z.number().int().nullable().optional(), profitAmount: amount.nullable().optional(),
  })), async (c) => c.json(await c.var.db.transaction((tx) => terminateAsset(tx, ctxOf(c), Number(c.req.param('id')), c.req.valid('json')))))
  .post('/assets/:id/restore', requirePermission(ASSETS), async (c) => {
    await c.var.db.transaction((tx) => restoreAsset(tx, ctxOf(c), Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/assets/:id/improvements', requirePermission(ASSETS), zValidator('json', z.object({ plan: z.enum(['accounting', 'tax']), amount })), async (c) => {
    const { plan, amount: a } = c.req.valid('json');
    await c.var.db.transaction((tx) => addImprovement(tx, ctxOf(c), Number(c.req.param('id')), plan === 'accounting', a));
    return c.json({ ok: true });
  })
  .delete('/assets/:id/improvements/:impId', requirePermission(ASSETS), async (c) => {
    await c.var.db.transaction((tx) => removeImprovement(tx, ctxOf(c), Number(c.req.param('id')), Number(c.req.param('impId'))));
    return c.json({ ok: true });
  })
  .get('/assets/:id/ias', requirePermission(ASSETS), async (c) => c.json(await iasInfo(c.var.db, ctxOf(c), Number(c.req.param('id')))))
  .post('/assets/:id/ias', requirePermission(ASSETS), zValidator('json', z.object({
    mode: z.enum(['improvement', 'revaluation']), amount, withPosting: z.boolean().optional(), accountId: z.number().int().nullable().optional(), date: optDate,
  })), async (c) => c.json(await c.var.db.transaction((tx) => applyIas(tx, ctxOf(c), Number(c.req.param('id')), c.req.valid('json')))))

  /* ---- accounting requests (Ctrl+Q) ---- */
  .get('/accounting-requests', requirePermission(REQUESTS), async (c) => {
    const q = c.req.query();
    return c.json({ defaults: requestDefaults(ctxOf(c)), ...(await pendingRequests(c.var.db, ctxOf(c), { from: q.from, to: q.to, inventoryNumber: q.inventoryNumber, name: q.name })) });
  })
  .post('/accounting-requests/post', requirePermission(REQUESTS), zValidator('json', z.object({ ids: z.array(z.number().int()) })), async (c) =>
    c.json(await postRequests(c.var.db, ctxOf(c), c.req.valid('json').ids)))

  /* ---- reports (Справки > Дълготрайни активи) ---- */
  .get('/reports/assets/quotas', requirePermission('UI_Reporting_Depreciations_MonthlyDepreciationQuotas'), async (c) => {
    const q = c.req.query();
    return c.json(await quotasReport(c.var.db, {
      year: q.year ? Number(q.year) : null, type: q.type === 'dap' ? 'dap' : 'sap', activeYear: c.var.year.year,
      inventoryNumber: q.inventoryNumber, name: q.name, locationIds: ids(q.locationIds), account: q.account,
    }));
  })
  .get('/reports/assets/inventory-book', requirePermission('UI_Reporting_Depreciations_InventoryBook'), async (c) => {
    const q = c.req.query();
    return c.json(await inventoryBookReport(c.var.db, {
      toDate: q.toDate ?? workingDate(c.var.session), inventoryNumber: q.inventoryNumber, name: q.name, locationIds: ids(q.locationIds),
      account: q.account, mol: q.mol, note: q.note, serialNumber: q.serialNumber,
    }));
  })
  .get('/reports/assets/plan', requirePermission('UI_Reporting_Depreciations_DepreciationPlan'), async (c) => {
    const q = c.req.query();
    return c.json(await depreciationPlanReport(c.var.db, {
      month: q.month ?? workingDate(c.var.session), type: q.type === 'dap' ? 'dap' : q.type === 'ias' ? 'ias' : 'sap', sort: (q.sort as PlanSort) || undefined,
      showWrittenOff: q.showWrittenOff === '1', inventoryNumber: q.inventoryNumber, name: q.name, locationIds: ids(q.locationIds),
      account: q.account, note: q.note, serialNumber: q.serialNumber,
    }));
  })
  .get('/reports/assets/by-categories', requirePermission('UI_Reporting_Depreciations_AssetsByCategories'), async (c) => {
    const q = c.req.query();
    return c.json(await assetsByCategoriesReport(c.var.db, {
      year: q.year ? Number(q.year) : c.var.year.year, filterBy: q.filterBy === 'inventoryNumber' ? 'inventoryNumber' : 'name', filter: q.filter, locationIds: ids(q.locationIds),
    }));
  })
  // The key has no seeded Permissions row; an unknown key evaluates to allowed (03b section 1, recipe R5).
  .get('/reports/assets/inventory-mol', requirePermission('UI_Reporting_Depreciations_InventoryListMOL'), async (c) => {
    const q = c.req.query();
    return c.json(await inventoryListMolReport(c.var.db, { date: q.date ?? workingDate(c.var.session), account: q.account, mol: q.mol, locationIds: ids(q.locationIds) }));
  });
