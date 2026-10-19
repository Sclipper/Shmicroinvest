import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { ApiError } from '../lib/errors.ts';
import { requirePermission, workingDate } from '../session.ts';
import { NAP_FILES, napFiles, napZip, vatDeclarationReport, vatDiaries, vatReport, vatReportDefaults, viesReport, type VatReportParams } from '../services/vat/reports.ts';
import { calculateVatClosing, saveVatClosing } from '../services/vat/closing.ts';
import { annualAdjustmentDefaults, calculateArticle73, getArticle73, postAnnualAdjustment, saveArticle73, validateArticle73 } from '../services/vat/article73.ts';
import { deleteProtocol, getProtocol, icaReport, protocolDefaults, protocolPrint, saveProtocol } from '../services/vat/protocols.ts';
import { documentValidation, importMissingFromNapFile, napFileCheck } from '../services/vat/checks.ts';
import { importDefaultAccounts, importVatDiaries } from '../services/vat/import.ts';

/** VAT module API (spec 02b, 04a 1-2, 05 7). */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const num = z.union([z.string(), z.number()]).transform((v) => String(v)).optional();
const amount = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Невалидна сума.');

const reportBody = z.object({
  from: date, to: date,
  kl33: num, kl70: num, kl71: num, kl80: num, kl81: num, kl82: num,
  autoFillCell71: z.boolean().optional(), sortByEntry: z.boolean().optional(), extended: z.boolean().optional(), createVies: z.boolean().optional(),
  subscriberName: z.string().optional(), subscriberEgn: z.string().optional(), subscriberRole: z.number().int().optional(),
});

function reportQuery(q: Record<string, string>): VatReportParams {
  const r = reportBody.safeParse({
    ...q,
    autoFillCell71: q.autoFillCell71 === '1' || q.autoFillCell71 === 'true',
    sortByEntry: q.sortByEntry === '1' || q.sortByEntry === 'true',
    extended: q.extended === '1' || q.extended === 'true',
    createVies: q.createVies === '1' || q.createVies === 'true',
    subscriberRole: q.subscriberRole ? Number(q.subscriberRole) : undefined,
  });
  if (!r.success) throw new ApiError(400, 'Невалиден период.');
  return r.data;
}

const fileBody = z.object({ data: z.string(), name: z.string().optional() });
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const download = (c: Context<AppEnv>, name: string, data: Uint8Array, type: string) =>
  c.body(data as unknown as ArrayBuffer, 200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });

const ctxOf = (c: Context<AppEnv>) => ({ year: c.var.year, userId: c.var.user.id, branchId: c.var.session.state.branchId ?? 1 });

const REPORT = 'UI_Reporting_VATDiary';
const CLOSE = 'UI_Operations_AutoOperations_VAT';
const RATIO = 'UI_Operations_AutoOperations_VATOperations_VATRatio';
const ICA = 'UI_Reporting_ICAReport';
const VALIDATION = 'UI_Reporting_Validation_AccountingsValidation';
const NAP_CHECK = 'UI_Reporting_Validation_AccountingsNAPFileValidation';
const IMPORT = 'UI_Operations_Import_VATDiaryImport';
const ENTRY = 'UI_Operations_Accounting';

const accountsBody = z.object({
  expense: z.number().int().optional(), vatPurchases: z.number().int().nullable().optional(), suppliers: z.number().int().optional(),
  customers: z.number().int().optional(), revenue: z.number().int().optional(), vatSales: z.number().int().nullable().optional(),
}).optional();

const protocolBody = z.object({
  icaType: z.number().int().min(1).max(9),
  purchaseTermId: z.number().int().nullable(),
  documentNumber: z.string().max(50),
  documentDate: date,
  viesMonth: date,
  term: z.string().max(255).optional(),
  base: amount,
  vat: amount,
  expenseAccountId: z.number().int().nullable().optional(),
  vatDiaryCode: z.string().max(5).nullable().optional(),
  force: z.boolean().optional(),
});

export const vatRoutes = new Hono<AppEnv>()
  // --- ДДС дневници, декларация и VIES ---
  .get('/vat/defaults', requirePermission(REPORT), async (c) => c.json(await vatReportDefaults(c.var.db, workingDate(c.var.session))))
  .post('/vat/report', requirePermission(REPORT), zValidator('json', reportBody), async (c) => {
    const db = c.var.db;
    return c.json(await db.transaction((tx) => vatReport(tx, c.req.valid('json'))));
  })
  .post('/vat/diaries', requirePermission(REPORT), zValidator('json', reportBody), async (c) => c.json(await vatDiaries(c.var.db, c.req.valid('json'))))
  .post('/vat/declaration', requirePermission(REPORT), zValidator('json', reportBody), async (c) => c.json(await vatDeclarationReport(c.var.db, c.req.valid('json'))))
  .post('/vat/vies', requirePermission(REPORT), zValidator('json', reportBody), async (c) => c.json(await viesReport(c.var.db, c.req.valid('json'))))
  .post('/vat/files', requirePermission(REPORT), zValidator('json', reportBody), async (c) => {
    const db = c.var.db;
    const r = await db.transaction((tx) => napFiles(tx, c.req.valid('json')));
    return c.json({ folder: r.folder, files: r.files.map((f) => ({ name: f.name, lines: f.lines, size: f.data.length, data: Buffer.from(f.data).toString('base64') })) });
  })
  .get('/vat/files.zip', requirePermission(REPORT), async (c) => {
    const p = reportQuery(c.req.query());
    const db = c.var.db;
    const r = await db.transaction((tx) => napZip(tx, p));
    return download(c, `NAP_${r.folder}.zip`, r.data, 'application/zip');
  })
  .get('/vat/files/:name', requirePermission(REPORT), async (c) => {
    const name = c.req.param('name').toUpperCase();
    if (!(NAP_FILES as readonly string[]).includes(name)) throw new ApiError(404, 'Не е намерено.');
    const p = reportQuery(c.req.query());
    if (name === 'VIES.TXT') p.createVies = true;
    const db = c.var.db;
    const r = await db.transaction((tx) => napFiles(tx, p));
    const f = r.files.find((x) => x.name === name)!;
    return download(c, f.name, f.data, 'text/plain; charset=windows-1251');
  })

  // --- Приключване на ДДС ---
  .post('/vat/closing/calculate', requirePermission(CLOSE), zValidator('json', z.object({
    from: date, to: date, byExportMonth: z.boolean().optional(), includeRefund: z.boolean().optional(), alternative: z.boolean().optional(),
  })), async (c) => c.json(await calculateVatClosing(c.var.db, c.var.year, c.req.valid('json'))))
  .post('/vat/closing', requirePermission(CLOSE), zValidator('json', z.object({
    to: date,
    rows: z.array(z.object({ creditAccountId: z.number().int(), debitAccountId: z.number().int(), amount })),
  })), async (c) => {
    const { to, rows } = c.req.valid('json');
    const db = c.var.db;
    return c.json(await db.transaction((tx) => saveVatClosing(tx, ctxOf(c), to, rows)), 201);
  })

  // --- Коефициент по чл. 73 ---
  .get('/vat/article73', requirePermission(RATIO), async (c) => c.json(await getArticle73(c.var.db, c.var.year)))
  .post('/vat/article73/calculate', requirePermission(RATIO), zValidator('json', z.object({ from: date, to: date, numeratorDeviation: num, denominatorDeviation: num })),
    async (c) => c.json(await calculateArticle73(c.var.db, c.req.valid('json'))))
  .post('/vat/article73/validate', requirePermission(RATIO), zValidator('json', z.object({ from: date, to: date, numeratorDeviation: num, denominatorDeviation: num, ratio: amount, isNew: z.boolean().optional() })),
    async (c) => {
      const b = c.req.valid('json');
      return c.json({ messages: await validateArticle73(c.var.db, b, b.isNew) });
    })
  .put('/vat/article73', requirePermission(RATIO), zValidator('json', z.object({ from: date, to: date, numeratorDeviation: num, denominatorDeviation: num, ratio: amount })),
    async (c) => {
      const db = c.var.db;
      return c.json(await db.transaction((tx) => saveArticle73(tx, c.req.valid('json'))));
    })
  .get('/vat/article73/adjustment', requirePermission(RATIO), async (c) => {
    const q = c.req.query();
    return c.json(await annualAdjustmentDefaults(c.var.db, c.var.year, { oldRatio: q.oldRatio || undefined, newRatio: q.newRatio || undefined, from: q.from || undefined, to: q.to || undefined }));
  })
  .post('/vat/article73/adjustment', requirePermission(RATIO), zValidator('json', z.object({
    amount: z.string(), accountingDate: date, documentTypeId: z.number().int().nullable(), documentNumber: z.string().max(50), documentDate: date.nullable().optional(), viesMonth: date.nullable().optional(),
  })), async (c) => {
    const db = c.var.db;
    return c.json(await db.transaction((tx) => postAnnualAdjustment(tx, ctxOf(c), c.req.valid('json'))), 201);
  })

  // --- Протоколи по чл. 117 ---
  .get('/vat/ica-report', requirePermission(ICA), async (c) => {
    const q = c.req.query();
    if (!q.from || !q.to) throw new ApiError(400, 'Невалиден период.');
    return c.json(await icaReport(c.var.db, {
      from: q.from, to: q.to, companyIds: q.companyId ? q.companyId.split(',').map(Number) : undefined,
      documentTypeId: q.documentTypeId ? Number(q.documentTypeId) : null, documentNumber: q.documentNumber || undefined, icaType: q.icaType ? Number(q.icaType) : 0,
    }));
  })
  .get('/vat/protocols/:id', requirePermission(ENTRY), async (c) => c.json({ protocol: await getProtocol(c.var.db, Number(c.req.param('id'))) }))
  .get('/vat/protocols/:id/defaults', requirePermission(ENTRY), async (c) => {
    const q = c.req.query();
    return c.json(await protocolDefaults(c.var.db, Number(c.req.param('id')), Number(q.icaType ?? 1), q.purchaseTermId ? Number(q.purchaseTermId) : null, c.var.year.id));
  })
  .get('/vat/protocols/:id/print', requirePermission(ENTRY), async (c) => c.json(await protocolPrint(c.var.db, Number(c.req.param('id')))))
  .put('/vat/protocols/:id', requirePermission(ENTRY), zValidator('json', protocolBody), async (c) => {
    const db = c.var.db;
    return c.json(await db.transaction((tx) => saveProtocol(tx, Number(c.req.param('id')), c.req.valid('json'), ctxOf(c))));
  })
  .delete('/vat/protocols/:id', requirePermission(ENTRY), async (c) => {
    const db = c.var.db;
    await db.transaction((tx) => deleteProtocol(tx, Number(c.req.param('id')), ctxOf(c)));
    return c.json({ ok: true });
  })

  // --- Проверки ---
  .post('/vat/validation', requirePermission(VALIDATION), zValidator('json', z.object({ from: date, to: date, reportType: z.number().int().min(0).max(2).optional(), channel: z.string().optional() })),
    async (c) => c.json(await documentValidation(c.var.db, c.req.valid('json'))))
  .post('/vat/nap-check', requirePermission(NAP_CHECK), zValidator('json', z.object({ from: date, to: date, kind: z.enum(['purchase', 'sale']), file: fileBody })),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(await napFileCheck(c.var.db, { ...b, file: b64(b.file.data) }));
    })
  .post('/vat/nap-check/import', requirePermission(NAP_CHECK), requirePermission(IMPORT), zValidator('json', z.object({ from: date, to: date, kind: z.enum(['purchase', 'sale']), file: fileBody, accounts: accountsBody })),
    async (c) => {
      const b = c.req.valid('json');
      const db = c.var.db;
      return c.json(await db.transaction((tx) => importMissingFromNapFile(tx, ctxOf(c), { ...b, file: b64(b.file.data) })), 201);
    })

  // --- Импорт от ДДС Дневници ---
  .get('/vat/import/defaults', requirePermission(IMPORT), async (c) => c.json(await importDefaultAccounts(c.var.db, c.var.year.year)))
  .post('/vat/import', requirePermission(IMPORT), zValidator('json', z.object({
    purchases: fileBody.nullable().optional(), sales: fileBody.nullable().optional(), from: date.optional(), to: date.optional(), accounts: accountsBody,
  })), async (c) => {
    const b = c.req.valid('json');
    const db = c.var.db;
    return c.json(await db.transaction((tx) => importVatDiaries(tx, ctxOf(c), {
      purchases: b.purchases ? b64(b.purchases.data) : null, sales: b.sales ? b64(b.sales.data) : null, from: b.from, to: b.to, accounts: b.accounts,
    })), 201);
  });
