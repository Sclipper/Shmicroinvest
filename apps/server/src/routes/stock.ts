import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission, workingDate } from '../session.ts';
import {
  averagePriceReport, createWriteOffs, deleteProduct, deliverySaleReport, goodsMovementReport, inventoryListReport, listProducts,
  loadProduct, productAveragePrice, productMeasures, productOptions, saveProduct, stockProducts, writeOffCandidates, writeOutReport,
  type MaterialFilter,
} from '../services/stock.ts';

const DEFINE = 'UI_Operations_Products_DefineProducts';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна стойност.');

const productBody = z.object({
  name: z.string().max(255),
  code: z.string().max(50).nullable().optional(),
  measure: z.string().max(50),
  price: decimal.optional(),
  incrementAccountIds: z.array(z.number().int()).default([]),
  decrementAccountIds: z.array(z.number().int()).default([]),
});

const writeOffBody = z.object({
  from: date, to: date, date, account: z.string().max(50).optional(), productIds: z.array(z.number().int()).optional(),
});

function materialFilter(q: Record<string, string>, year: number): MaterialFilter {
  return {
    from: q.from ?? `${year}-01-01`, to: q.to ?? `${year}-12-31`, account: q.account, productName: q.product, nameExact: q.nameExact === '1',
    productCode: q.code, companyName: q.company, documentTypeId: q.documentTypeId ? Number(q.documentTypeId) : undefined,
    documentNumber: q.documentNumber, fromNumber: q.fromNumber, toNumber: q.toNumber,
  };
}

/** Stock (СМЗ): products, average price, write-offs and material reports (spec 03a 4, 05 7.9). */
export const stockRoutes = new Hono<AppEnv>()
  // ---- Дефиниране на СМЗ ----
  .get('/products', async (c) => c.json(await listProducts(c.var.db, c.var.year.year, c.req.query('q'))))
  .get('/products/measures', async (c) => c.json(await productMeasures(c.var.db)))
  .get('/products/:id{[0-9]+}', async (c) => c.json(await loadProduct(c.var.db, c.var.year.year, Number(c.req.param('id')))))
  .post('/products', requirePermission(DEFINE), zValidator('json', productBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveProduct(tx, c.var.year.year, c.req.valid('json')));
    return c.json(r, 201);
  })
  .put('/products/:id{[0-9]+}', requirePermission(DEFINE), zValidator('json', productBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveProduct(tx, c.var.year.year, c.req.valid('json'), Number(c.req.param('id'))));
    return c.json(r);
  })
  .delete('/products/:id{[0-9]+}', requirePermission(DEFINE), async (c) => {
    await c.var.db.transaction((tx) => deleteProduct(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  // ---- Delivery / sale material dialog ----
  .get('/stock/products', async (c) => {
    const mode = c.req.query('mode') === 'sale' ? 'sale' : 'delivery';
    return c.json(await stockProducts(c.var.db, c.var.year.year, mode, c.req.query('q')));
  })
  .get('/stock/product-options', async (c) => c.json(await productOptions(c.var.db, c.var.year.year)))
  /** GetAveragePrice of the product's stock account up to a date (03a 4.5). */
  .get('/stock/average-price', async (c) => {
    const productId = Number(c.req.query('productId'));
    const d = c.req.query('date') ?? workingDate(c.var.session);
    return c.json(await productAveragePrice(c.var.db, c.var.year, productId, d));
  })

  // ---- Изписване на СМЗ (Ctrl+I) ----
  .get('/stock/write-offs', requirePermission('UI_Operations_Products_WriteOffs'), async (c) => {
    const q = c.req.query();
    const y = c.var.year.year;
    return c.json(await writeOffCandidates(c.var.db, c.var.year, { from: q.from ?? `${y}-01-01`, to: q.to ?? `${y}-12-31`, account: q.account, date: q.date ?? q.to ?? `${y}-12-31` }));
  })
  .post('/stock/write-offs', requirePermission('UI_Operations_Products_WriteOffs'), zValidator('json', writeOffBody), async (c) => {
    const { productIds, ...f } = c.req.valid('json');
    const r = await c.var.db.transaction((tx) => createWriteOffs(tx, c.var.year, c.var.user.id, f, productIds));
    return c.json(r, 201);
  })

  // ---- Справки > Стоково-материални запаси ----
  .get('/reports/stock/purchases', requirePermission('UI_Reporting_MaterialReports_PurchaseReport'), async (c) =>
    c.json(await deliverySaleReport(c.var.db, c.var.year.year, materialFilter(c.req.query(), c.var.year.year), true)))
  .get('/reports/stock/sales', requirePermission('UI_Reporting_MaterialReports_SaleReport'), async (c) =>
    c.json(await deliverySaleReport(c.var.db, c.var.year.year, materialFilter(c.req.query(), c.var.year.year), false)))
  .get('/reports/stock/goods-movement', requirePermission('UI_Reporting_MaterialReports_GoodsMovementReport'), async (c) =>
    c.json(await goodsMovementReport(c.var.db, c.var.year.year, materialFilter(c.req.query(), c.var.year.year))))
  .get('/reports/stock/average-price', requirePermission('UI_Reporting_MaterialReports_AveragePriceReport'), async (c) =>
    c.json(await averagePriceReport(c.var.db, c.var.year, materialFilter(c.req.query(), c.var.year.year))))
  .get('/reports/stock/write-out', requirePermission('UI_Reporting_MaterialReports_WriteOutReport'), async (c) =>
    c.json(await writeOutReport(c.var.db, c.var.year, materialFilter(c.req.query(), c.var.year.year))))
  .get('/reports/stock/inventory-list', requirePermission('UI_Reporting_MaterialReports'), async (c) => {
    const q = c.req.query();
    return c.json(await inventoryListReport(c.var.db, c.var.year, { toDate: q.date ?? `${c.var.year.year}-12-31`, account: q.account, withoutZero: q.withoutZero === '1' }));
  });
