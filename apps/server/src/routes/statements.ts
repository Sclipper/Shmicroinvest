import { Hono } from 'hono';
import { z } from 'zod';
import { STATEMENTS, STATEMENT_FORMATS, type StatementCode, type StatementFormat } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { badRequest } from '../lib/errors.ts';
import { requirePermission } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import {
  loadStatementFormulas, restoreStatementFormulas, runAbbreviatedStatements, runStatements, saveStatementFormulas, verifyStatements,
  type StatementRunOptions,
} from '../services/statements.ts';
import {
  FILTER_FIELDS, FILTER_OPS, copyUserReport, deleteUserFormula, deleteUserReport, listUserFormulas, listUserReports, loadUserReport,
  runUserReport, saveUserFormula, saveUserReport,
} from '../services/userReports.ts';

const REPORT = 'UI_Reporting_FinancialReports';
const EDIT = 'UI_Edit_Administration_StatementFormulas';
const USER_REPORTS = 'UI_Reporting_UserReportsManager';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODES = STATEMENTS.map((s) => s.code) as [StatementCode, ...StatementCode[]];

const FORMATS: StatementFormat[] = STATEMENT_FORMATS.map((f) => f.value);

/** Query: from, to, statements=balance,opr, thousands=1, usePrev=1, sameInterval=1, format=national|nsi|f2015|micro (or nsi=1), lang=bg|en. */
function runOptions(q: Record<string, string>, year: number): StatementRunOptions {
  const startDate = q.from ?? `${year}-01-01`;
  const endDate = q.to ?? `${year}-12-31`;
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw badRequest('Невалиден период.');
  if (startDate > endDate) throw badRequest('Началната дата е след крайната дата.');
  const statements = (q.statements ?? '').split(',').filter(Boolean) as StatementCode[];
  for (const c of statements) if (!CODES.includes(c)) throw badRequest('Непознат отчет.');
  const format = (q.format ?? (q.nsi === '1' ? 'nsi' : 'national')) as StatementFormat;
  if (!FORMATS.includes(format)) throw badRequest('Непознат тип справка.');
  if (q.lang !== undefined && q.lang !== 'bg' && q.lang !== 'en') throw badRequest('Непознат език.');
  return {
    startDate, endDate, statements, format, lang: q.lang === 'en' ? 'en' : 'bg',
    thousands: q.thousands === '1', usePreviousPeriodValues: q.usePrev === '1', sameIntervalPreviousYear: q.sameInterval === '1', nsi: format === 'nsi',
  };
}

const filterSpec = z.object({
  match: z.enum(['all', 'any']),
  conditions: z.array(z.object({ field: z.enum(FILTER_FIELDS), op: z.enum(FILTER_OPS), value: z.string().max(255) })).max(20),
}).nullable().optional();

const reportBody = z.object({
  name: z.string().max(255),
  description: z.string().max(2000).nullable().optional(),
  format: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  columns: z.array(z.string().max(255)).max(2),
  lines: z.array(z.object({
    number: z.number().int().min(1).max(9999),
    name: z.string().max(500),
    cells: z.array(z.object({
      // The filter formula is stored as `${key}_filter` in varchar(50).
      key: z.string().max(43).optional(),
      expression: z.string().max(4000),
      isOnlyPositive: z.boolean().optional(),
      isCurrencyAmount: z.boolean().optional(),
      isQuantityAmount: z.boolean().optional(),
      filter: filterSpec,
    })).min(1).max(2),
  })).max(500),
});

const userFormulaBody = z.object({ name: z.string().max(255), key: z.string().max(50), expression: z.string().max(4000), isOnlyPositive: z.boolean().optional() });

export const statementRoutes = new Hono<AppEnv>()
  // ---- Financial statements (Отчети и баланс, Alt+B) ----
  .get('/statements/report', requirePermission(REPORT), async (c) => {
    const o = runOptions(c.req.query(), c.var.year.year);
    const r = await runStatements(c.var.db, o);
    await logActivity(c.var.db, c.var.user.id, 'print', 'report', null, `Отчети и баланс ${o.startDate} - ${o.endDate}`);
    return c.json(r);
  })
  .get('/statements/abbreviated', requirePermission(REPORT), async (c) => {
    const o = runOptions(c.req.query(), c.var.year.year);
    const r = await runAbbreviatedStatements(c.var.db, o);
    await logActivity(c.var.db, c.var.user.id, 'export', 'report', null, `Съкратени отчети ${o.startDate} - ${o.endDate}`);
    return c.json(r);
  })
  .get('/statements/verify', requirePermission(REPORT), async (c) => {
    const q = c.req.query();
    return c.json(await verifyStatements(c.var.db, { ...runOptions(q, c.var.year.year), balanceOnly: q.balanceOnly === '1' }));
  })

  // ---- Statement formula editor (Редакция на отчети и баланс, Ctrl+B) ----
  .get('/statements/formulas', requirePermission(EDIT), async (c) => c.json(await loadStatementFormulas(c.var.db)))
  .put('/statements/formulas', requirePermission(EDIT), zValidator('json', z.object({
    edits: z.array(z.object({ id: z.number().int(), formula: z.string().max(4000).optional(), valueLastPeriod: z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.').optional() })).max(1000),
  })), async (c) => {
    const r = await saveStatementFormulas(c.var.db, c.req.valid('json').edits);
    await logActivity(c.var.db, c.var.user.id, 'edit', 'statementFormulas', null, `Редакция на отчети и баланс (${r.saved})`);
    return c.json(r);
  })
  .post('/statements/formulas/restore', requirePermission(EDIT), zValidator('json', z.object({ ids: z.array(z.number().int()).optional(), statement: z.enum(CODES).optional() })), async (c) => {
    await restoreStatementFormulas(c.var.db, c.req.valid('json'));
    return c.json({ ok: true });
  })

  // ---- User-defined reports (Мениджър потребителски справки) ----
  .get('/user-reports', requirePermission(USER_REPORTS), async (c) => c.json(await listUserReports(c.var.db)))
  .get('/user-reports/:id', requirePermission(USER_REPORTS), async (c) => c.json(await loadUserReport(c.var.db, Number(c.req.param('id')))))
  .post('/user-reports', requirePermission(USER_REPORTS), zValidator('json', reportBody), async (c) => c.json(await c.var.db.transaction((tx) => saveUserReport(tx, c.req.valid('json'))), 201))
  .put('/user-reports/:id', requirePermission(USER_REPORTS), zValidator('json', reportBody), async (c) => c.json(await c.var.db.transaction((tx) => saveUserReport(tx, c.req.valid('json'), Number(c.req.param('id'))))))
  .delete('/user-reports/:id', requirePermission(USER_REPORTS), async (c) => {
    await c.var.db.transaction((tx) => deleteUserReport(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/user-reports/:id/copy', requirePermission(USER_REPORTS), async (c) => c.json(await c.var.db.transaction((tx) => copyUserReport(tx, Number(c.req.param('id')))), 201))
  .get('/user-reports/:id/run', requirePermission(USER_REPORTS), async (c) => {
    const q = c.req.query();
    const y = c.var.year.year;
    const startDate = q.from ?? `${y}-01-01`;
    const endDate = q.to ?? `${y}-12-31`;
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || startDate > endDate) throw badRequest('Невалиден период.');
    return c.json(await runUserReport(c.var.db, Number(c.req.param('id')), { startDate, endDate, year: q.year ? Number(q.year) : undefined }));
  })
  .get('/user-formulas', requirePermission(USER_REPORTS), async (c) => c.json(await listUserFormulas(c.var.db)))
  .post('/user-formulas', requirePermission(USER_REPORTS), zValidator('json', userFormulaBody), async (c) => c.json(await saveUserFormula(c.var.db, c.req.valid('json')), 201))
  .put('/user-formulas/:id', requirePermission(USER_REPORTS), zValidator('json', userFormulaBody), async (c) => c.json(await saveUserFormula(c.var.db, c.req.valid('json'), Number(c.req.param('id')))))
  .delete('/user-formulas/:id', requirePermission(USER_REPORTS), async (c) => {
    await deleteUserFormula(c.var.db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });
