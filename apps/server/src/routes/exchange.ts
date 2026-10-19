import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  CLOSING_MODES, EXCEL_ENTITIES, XML_OPERATION_CATEGORIES, decodeText, msg, parseTransferXml, parseTrzFeed, readSetupSheet, trzAggregate, trzAvailableMonths,
  trzDefaultAccountingDate, trzDefaultTerm, trzGrid, trzTotal, writeTransferXml, type ClosingMode, type ExcelEntity, type ExcelMapping,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission, workingDate } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import { getConfig, setConfig } from '../services/config.ts';
import { importStep, readUpload } from '../services/exchange/common.ts';
import { excelTemplateRows, importExcel } from '../services/exchange/excelImport.ts';
import { addExportReport, listExportReports, runExportReport } from '../services/exchange/reportExports.ts';
import { importTextFile, textCategoryDefaults } from '../services/exchange/textImport.ts';
import { exportTransferData, importTransferData, xmlCategoryDefaults, XML_EXPORT_MESSAGES } from '../services/exchange/transfer.ts';
import { importTrz, trzDefineAccounts, trzMissingAccounts, type TrzImportInput } from '../services/exchange/trzImport.ts';
import { readWorkbook, writeWorkbook } from '../services/exchange/xlsx.ts';

const file = (c: { header: (k: string, v: string) => void; body: (b: ArrayBuffer) => Response }, data: Uint8Array, name: string, type: string) => {
  c.header('content-type', type);
  c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return c.body(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
};

const categoryMapBody = z.record(z.string(), z.number().int().nullable()).optional();
const toCategoryMap = (m?: Record<string, number | null>) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [Number(k), v]));
const ENTITIES = ['operations', 'partners', 'chart', 'products', 'initialBalances'] as const;
/**
 * "Експорт към външни системи" (04a 8.3) sits under Редакция > Администриране with the key
 * UI_Edit_Administration_ReportExport (06 1.3). Delta does not seed that key; it is seeded
 * here under the group, and the group's key is checked as well, as the menu does.
 */
const REPORT_EXPORT = ['UI_Edit_Administration', 'UI_Edit_Administration_ReportExport'] as const;
/** SelectedWayOfSearching: closing mode <-> the stored Delta enum name. */
const WAYS: [ClosingMode, string][] = [['document', 'Document'], ['amount', 'Amount'], ['optionalReference', 'OptionalReference']];
/** Report definitions carry SQL: only an administrator may add or remove them. */
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user.isAdmin) throw new ApiError(403, 'Нямате права за тази операция.');
  await next();
};

export const exchangeRoutes = new Hono<AppEnv>()
  // ------------------------------------------------------------------ XML (04a 3)
  .get('/exchange/xml/categories', requirePermission('UI_Operations_Import_XMLImport'), async (c) => {
    const defaults = await xmlCategoryDefaults(c.var.db, c.var.year.year);
    const saved = await Promise.all(defaults.map(async (d) => ({ ...d, accountId: Number(await getConfig(c.var.db, `Category_${d.categoryId}`, c.var.user.id)) || d.accountId })));
    return c.json(saved);
  })
  /** Step 1: file validation; tells whether the category step is needed. */
  .post('/exchange/xml/validate', requirePermission('UI_Operations_Import_XMLImport'), async (c) => {
    const up = await readUpload(c);
    const data = await importStep(async () => parseTransferXml(decodeText(up.bytes)), false);
    return c.json({
      accounts: data.accounts?.length ?? 0, partners: data.companies?.length ?? 0, products: data.products?.length ?? 0,
      accountings: data.accountings?.length ?? 0, operations: data.operations?.length ?? 0, needsCategories: !!data.operations?.length,
      categories: XML_OPERATION_CATEGORIES,
    });
  })
  /** Documents closing after the import (IsDocumentsClosingEnabled / SelectedWayOfSearching, 3.5). */
  .get('/exchange/xml/settings', requirePermission('UI_Operations_Import_XMLImport'), async (c) => {
    const way = await getConfig(c.var.db, 'SelectedWayOfSearching', c.var.user.id);
    return c.json({
      isDocumentsClosingEnabled: (await getConfig(c.var.db, 'IsDocumentsClosingEnabled', c.var.user.id)) === 'True',
      selectedWayOfSearching: WAYS.find((w) => w[1] === way)?.[0] ?? 'document',
      ways: CLOSING_MODES.map((m) => ({ id: m.id, label: m.label })),
    });
  })
  .post('/exchange/xml/import', requirePermission('UI_Operations_Import_XMLImport'), async (c) => {
    const up = await readUpload(c);
    const categoryMap = toCategoryMap(categoryMapBody.parse(up.fields.categoryMap));
    const closing = z.object({ isDocumentsClosingEnabled: z.boolean().optional(), selectedWayOfSearching: z.enum(['document', 'amount', 'optionalReference']).optional() }).parse(up.fields);
    const data = await importStep(async () => parseTransferXml(decodeText(up.bytes)), false);
    for (const [k, v] of Object.entries(categoryMap)) if (v) await setConfig(c.var.db, `Category_${k}`, String(v), c.var.user.id);
    if (closing.isDocumentsClosingEnabled !== undefined) await setConfig(c.var.db, 'IsDocumentsClosingEnabled', closing.isDocumentsClosingEnabled ? 'True' : 'False', c.var.user.id);
    const way = closing.selectedWayOfSearching ?? 'document';
    if (closing.isDocumentsClosingEnabled) await setConfig(c.var.db, 'SelectedWayOfSearching', WAYS.find((w) => w[0] === way)![1], c.var.user.id);
    const r = await importStep(() => importTransferData(c.var.db, data, { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) }, categoryMap, {
      closeDocuments: closing.isDocumentsClosingEnabled ? way : null,
    }));
    await logActivity(c.var.db, c.var.user.id, 'import', 'xml', null, `Импорт от XML: ${up.fileName}`);
    return c.json({ ...r, message: msg('strTransferCompleted') });
  })
  .post('/exchange/xml/export', requirePermission('UI_Operations_Export_XMLExport'), zValidator('json', z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startNumber: z.string().nullable().optional(), endNumber: z.string().nullable().optional(), fileName: z.string().optional(),
  })), async (c) => {
    const body = c.req.valid('json');
    if (body.fileName !== undefined && !/^[^\\/:*?"<>|]+\.xml$/i.test(body.fileName.trim())) throw new ApiError(400, msg('strEnteredIncorrectFileNameError'));
    const { data, skippedManyToMany } = await exportTransferData(c.var.db, body);
    if (!data.accountings?.length) throw new ApiError(422, XML_EXPORT_MESSAGES.empty(), [{ key: 'strExportHaveNoAccountingsForSelectedCriteria', text: XML_EXPORT_MESSAGES.empty(), severity: 'critical' }]);
    await logActivity(c.var.db, c.var.user.id, 'export', 'xml', null, `Експорт към XML (${data.accountings.length})`);
    if (skippedManyToMany) c.header('x-export-warning', encodeURIComponent(XML_EXPORT_MESSAGES.writeOff().text));
    c.header('x-export-count', String(data.accountings.length));
    return file(c, new TextEncoder().encode(writeTransferXml(data)), body.fileName?.trim() || 'Transfer.xml', 'application/xml; charset=utf-8');
  })

  // ------------------------------------------------------------------ text (04a 4)
  .get('/exchange/text/categories', requirePermission('UI_Operations_Import_TXTImport'), async (c) => c.json(await textCategoryDefaults(c.var.db, c.var.year.year)))
  .post('/exchange/text/import', requirePermission('UI_Operations_Import_TXTImport'), async (c) => {
    const up = await readUpload(c);
    const f = z.object({
      from: z.string().optional(), to: z.string().optional(), predefinedTerm: z.string().optional(), categoryMap: categoryMapBody,
    }).parse(up.fields);
    const r = await importStep(() => c.var.db.transaction((tx) => importTextFile(tx, decodeText(up.bytes), { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) }, { ...f, categoryMap: toCategoryMap(f.categoryMap) })));
    await logActivity(c.var.db, c.var.user.id, 'import', 'txt', null, `Импорт от текстов файл: ${up.fileName}`);
    return c.json({ ...r, message: msg('strTransferCompleted') });
  })

  // ------------------------------------------------------------------ Excel (04a 5)
  .get('/exchange/excel/entities', requirePermission('UI_Operations_Import_ExcelImport'), async (c) => {
    const out = await Promise.all(ENTITIES.map(async (e) => {
      const saved = await getConfig(c.var.db, `ExcelImportMapping_${e}`, c.var.user.id);
      return { entity: e, title: EXCEL_ENTITIES[e].title, setupSheet: EXCEL_ENTITIES[e].setupSheet, columns: EXCEL_ENTITIES[e].columns, mapping: saved ? JSON.parse(saved) : null };
    }));
    return c.json(out);
  })
  /** Step 1: workbook sheets and the setup sheet of the entity (when present). */
  .post('/exchange/excel/inspect', requirePermission('UI_Operations_Import_ExcelImport'), async (c) => {
    const up = await readUpload(c);
    const entity = z.enum(ENTITIES).parse(up.fields.entity);
    const sheets = await importStep(() => readWorkbook(up.bytes), false);
    const setup = readSetupSheet(entity, sheets.find((sh) => sh.name === EXCEL_ENTITIES[entity].setupSheet));
    return c.json({ sheets: sheets.map((sh) => ({ name: sh.name, rows: sh.rowCount })), setup });
  })
  .post('/exchange/excel/import', requirePermission('UI_Operations_Import_ExcelImport'), async (c) => {
    const up = await readUpload(c);
    const entity = z.enum(ENTITIES).parse(up.fields.entity) as ExcelEntity;
    const mapping = z.object({
      sheetName: z.string(), startingRow: z.number().int(), endingRow: z.number().int(), columns: z.record(z.string(), z.string()),
      hasIcaColumns: z.boolean().optional(), conflictMode: z.enum(['insert', 'update', 'ignore', 'error']).optional(),
    }).parse(up.fields.mapping) as ExcelMapping;
    await setConfig(c.var.db, `ExcelImportMapping_${entity}`, JSON.stringify(mapping), c.var.user.id);
    const sheets = await importStep(() => readWorkbook(up.bytes));
    const r = await importStep(() => c.var.db.transaction((tx) => importExcel(tx, sheets, entity, mapping, { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) })));
    await logActivity(c.var.db, c.var.user.id, 'import', 'excel', null, `Импорт от Excel (${EXCEL_ENTITIES[entity].title}): ${up.fileName}`);
    return c.json({ ...r, message: msg('strTransferCompleted') });
  })
  /** Empty workbook with the data sheet header and the setup sheet. */
  .post('/exchange/excel/template', requirePermission('UI_Operations_Import_ExcelImport'), zValidator('json', z.object({
    entity: z.enum(ENTITIES), mapping: z.object({ sheetName: z.string(), startingRow: z.number().int(), endingRow: z.number().int(), columns: z.record(z.string(), z.string()) }),
  })), async (c) => {
    const { entity, mapping } = c.req.valid('json');
    const t = excelTemplateRows(entity, mapping);
    const def = EXCEL_ENTITIES[entity];
    const data = await writeWorkbook([
      { name: mapping.sheetName || def.title, header: def.columns.map((x) => x.caption.replace('Колона за ', '')), rows: [] },
      { name: t.setupSheet, rows: t.setup },
    ]);
    return file(c, data, `${def.title}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  })

  // ------------------------------------------------------------------ ТРЗ Pro (04a 6)
  .get('/exchange/trz/accounts', requirePermission('UI_Operations_Import_TRZProImport'), async (c) => {
    const missing = await trzMissingAccounts(c.var.db, c.var.year.year);
    return c.json({ missing, message: missing.length ? msg('strTrzProOperationsImportAccountsNotDefined') : msg('strTrzProOperationsImportNoAccountsToDefine') });
  })
  .post('/exchange/trz/accounts', requirePermission('UI_Operations_Import_TRZProImport'), async (c) => {
    const defined = await importStep(() => c.var.db.transaction((tx) => trzDefineAccounts(tx, c.var.year.year)));
    return c.json({ defined, message: defined.length ? msg('strTrzProOperationsImportAccountsDefined') : msg('strTrzProOperationsImportNoAccountsToDefine') });
  })
  /** Reads the payroll feed and returns months, defaults and the posting grid. */
  .post('/exchange/trz/preview', requirePermission('UI_Operations_Import_TRZProImport'), async (c) => {
    const up = await readUpload(c);
    const f = z.object({ month: z.string().optional(), level: z.coerce.number().int().min(0).max(10).default(0), byDetails: z.coerce.boolean().default(false) }).parse(up.fields);
    const rows = parseTrzFeed(decodeText(up.bytes));
    const months = trzAvailableMonths(rows, c.var.year.year);
    if (!months.length) return c.json({ months, warning: msg('strTrzProNoValueSalaryPeriods'), grid: [] });
    const last = await getConfig(c.var.db, 'LastTRZProImportPeriod', c.var.user.id);
    const month = f.month && months.includes(f.month) ? f.month : months.find((m) => last && m > last) ?? months[0]!;
    const grid = trzGrid(trzAggregate(rows, month, f.level), f.byDetails);
    return c.json({ months, month, accountingDate: trzDefaultAccountingDate(month), term: trzDefaultTerm(month), grid, total: trzTotal(grid) });
  })
  .post('/exchange/trz/import', requirePermission('UI_Operations_Import_TRZProImport'), zValidator('json', z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/), accountingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), term: z.string().max(255), documentTypeId: z.number().int(),
    confirmReimport: z.boolean().optional(),
    rows: z.array(z.object({ itemId: z.number().int(), itemName: z.string(), departmentName: z.string().optional(), amount: z.string(), debit: z.string(), credit: z.string() })),
  })), async (c) => {
    const body = c.req.valid('json') as TrzImportInput;
    const r = await importStep(() => c.var.db.transaction((tx) => importTrz(tx, body, { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) })), false);
    await logActivity(c.var.db, c.var.user.id, 'import', 'trz', null, r.message);
    return c.json(r);
  })

  // ------------------------------------------------------------------ report exports (04a 8.3)
  .get('/exchange/report-exports', requirePermission(...REPORT_EXPORT), async (c) => c.json(await listExportReports(c.var.db)))
  .post('/exchange/report-exports', requirePermission(...REPORT_EXPORT), requireAdmin, async (c) => {
    const up = await readUpload(c);
    const r = await importStep(() => addExportReport(c.var.db, up.fileName, decodeText(up.bytes)), false);
    return c.json(r, 201);
  })
  .delete('/exchange/report-exports/:id', requirePermission(...REPORT_EXPORT), requireAdmin, async (c) => {
    await c.var.db.delete(s.exportReports).where(eq(s.exportReports.id, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/exchange/report-exports/:id/run', requirePermission(...REPORT_EXPORT), zValidator('json', z.object({ parameters: z.record(z.string(), z.string()).default({}) })), async (c) => {
    const r = await importStep(() => runExportReport(c.var.db, Number(c.req.param('id')), c.req.valid('json').parameters), false);
    if (!r) throw notFound('Отчетът');
    await logActivity(c.var.db, c.var.user.id, 'export', 'report', Number(c.req.param('id')), r.fileName);
    const type = r.fileName.endsWith('.csv') ? 'text/csv; charset=utf-8' : r.fileName.endsWith('.zip') ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return file(c, r.data, r.fileName, type);
  });
