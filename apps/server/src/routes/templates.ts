import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission, workingDate } from '../session.ts';
import {
  deleteTemplate, generateSchedule, listScheduleRows, listTemplates, loadTemplate, processScheduleRows, saveTemplate, templateDraft,
} from '../services/templates.ts';
import {
  deleteReschedule, listReschedules, loadReschedule, processReschedules, reschedulesReport, saveReschedule,
} from '../services/reschedules.ts';

/** Templates, template schedules and reschedules (spec 02a 9). */

const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const optAmount = amount.nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineBody = z.object({
  accountId: z.number().int(),
  amount: z.string().regex(/^-?\d*(\.\d+)?$/, 'Невалидна сума.').default('0'),
  companyId: z.number().int().nullable().optional(),
  description: z.string().max(255).nullable().optional(),
  vatTermId: z.number().int().nullable().optional(),
  currencyAmount: optAmount,
  exchangeRate: optAmount,
  quantity: optAmount,
  price: optAmount,
});

const scheduleBody = z.object({
  mode: z.number().int().min(0).max(3),
  interval: z.number().int(),
  weekDays: z.number().int().min(0),
  months: z.number().int().min(0),
  days: z.number().int().min(0),
});

const templateBody = z.object({
  name: z.string().max(255).default(''),
  documentTypeId: z.number().int().nullable().optional(),
  term: z.string().max(255).nullable().optional(),
  reference: z.string().max(255).nullable().optional(),
  optionalReference: z.string().max(255).nullable().optional(),
  paragraph: z.string().max(255).nullable().optional(),
  transactionTypeId: z.number().int().optional(),
  viesId: z.number().int().nullable().optional(),
  companyId: z.number().int().nullable().optional(),
  debits: z.array(lineBody).default([]),
  credits: z.array(lineBody).default([]),
  schedule: scheduleBody.nullable().optional(),
});

const rescheduleBody = z.object({
  number: z.string().max(30).nullable().optional(),
  name: z.string().default(''),
  amount: z.string().regex(/^-?\d*(\.\d+)?$/, 'Невалидна сума.').default(''),
  documentTypeId: z.number().int().nullable().optional(),
  documentNumber: z.string().max(30).nullable().optional(),
  documentDate: date.nullable().optional(),
  fromDate: date,
  toDate: date,
  isRescheduleByDays: z.boolean().default(false),
  debitAccountId: z.number().int().nullable().optional(),
  creditAccountId: z.number().int().nullable().optional(),
  companyId: z.number().int().nullable().optional(),
  term: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  sourceAccountingId: z.number().int().nullable().optional(),
});

const TEMPLATES = 'UI_Operations_Templates';
const SCHEDULES = 'UI_Operations_TemplateSchedules';
const RESCHEDULES = 'UI_Operations_AccountingReschedules';

export const templateRoutes = new Hono<AppEnv>()
  // ---- Шаблони (Shift+F2) ----
  .get('/templates', async (c) => {
    const q = c.req.query();
    return c.json(await listTemplates(c.var.db, { q: q.q?.trim() || undefined, account: q.account?.trim() || undefined, fast: q.fast === '1' }, c.var.year));
  })
  .get('/templates/:id', async (c) => c.json(await loadTemplate(c.var.db, Number(c.req.param('id')))))
  .get('/templates/:id/draft', async (c) => {
    const d = c.req.query('date') ?? workingDate(c.var.session);
    return c.json(await templateDraft(c.var.db, Number(c.req.param('id')), d, c.var.year));
  })
  .post('/templates', requirePermission(TEMPLATES), zValidator('json', templateBody), async (c) => {
    const { db, year, user, session } = c.var;
    const r = await db.transaction((tx) => saveTemplate(tx, c.req.valid('json'), { year, userId: user.id, date: workingDate(session) }));
    return c.json(r, 201);
  })
  .put('/templates/:id', requirePermission(TEMPLATES), zValidator('json', templateBody), async (c) => {
    const { db, year, user, session } = c.var;
    const r = await db.transaction((tx) => saveTemplate(tx, c.req.valid('json'), { year, userId: user.id, date: workingDate(session) }, Number(c.req.param('id'))));
    return c.json(r);
  })
  .delete('/templates/:id', requirePermission(TEMPLATES), async (c) => {
    await c.var.db.transaction((tx) => deleteTemplate(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  // ---- График с шаблони за осчетоводяване ----
  .post('/templates/:id/schedule/generate', requirePermission(TEMPLATES), async (c) => {
    const r = await c.var.db.transaction((tx) => generateSchedule(tx, Number(c.req.param('id')), c.var.year));
    return c.json(r);
  })
  .get('/template-schedules', requirePermission(SCHEDULES), async (c) => {
    const q = c.req.query();
    return c.json(await listScheduleRows(c.var.db, { from: q.from || undefined, to: q.to || undefined, q: q.q?.trim() || undefined, processed: q.processed }));
  })
  .post('/template-schedules/process', requirePermission(SCHEDULES), zValidator('json', z.object({ ids: z.array(z.number().int()) })), async (c) => {
    const { db, year, user, session } = c.var;
    const r = await db.transaction((tx) => processScheduleRows(tx, c.req.valid('json').ids, { year, userId: user.id, branchId: session.state.branchId ?? 1 }));
    return c.json(r);
  })

  // ---- Разсрочване на приходи/разходи (Ctrl+R) ----
  .get('/reschedules', requirePermission(RESCHEDULES), async (c) => {
    const q = c.req.query();
    return c.json(await listReschedules(c.var.db, {
      number: q.number, name: q.name, documentTypeId: q.documentTypeId ? Number(q.documentTypeId) : undefined, documentNumber: q.documentNumber,
      debit: q.debit, credit: q.credit, from: q.from, to: q.to,
    }, c.var.year));
  })
  .get('/reschedules/:id', requirePermission(RESCHEDULES), async (c) => c.json(await loadReschedule(c.var.db, Number(c.req.param('id')))))
  .post('/reschedules/process', requirePermission(RESCHEDULES), zValidator('json', z.object({ toMonth: z.string().regex(/^\d{4}-\d{2}$/), ids: z.array(z.number().int()).optional() })), async (c) => {
    const { db, year, user, session } = c.var;
    const { toMonth, ids } = c.req.valid('json');
    const r = await db.transaction((tx) => processReschedules(tx, toMonth, ids, { year, userId: user.id, branchId: session.state.branchId ?? 1 }));
    return c.json(r);
  })
  .post('/reschedules', requirePermission(RESCHEDULES), zValidator('json', rescheduleBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveReschedule(tx, c.req.valid('json'), c.var.year));
    return c.json(r, 201);
  })
  .put('/reschedules/:id', requirePermission(RESCHEDULES), zValidator('json', rescheduleBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveReschedule(tx, c.req.valid('json'), c.var.year, Number(c.req.param('id'))));
    return c.json(r);
  })
  .delete('/reschedules/:id', requirePermission(RESCHEDULES), async (c) => {
    await c.var.db.transaction((tx) => deleteReschedule(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  // ---- Справка "Разсрочване на приходи и разходи" ----
  .get('/reports/reschedules', requirePermission('UI_Reporting_AccountingReschedules'), async (c) => {
    const q = c.req.query();
    return c.json(await reschedulesReport(c.var.db, {
      from: q.from, to: q.to, number: q.number, name: q.name, debit: q.debit, credit: q.credit, reference: q.reference, sort: q.sort,
    }, c.var.year));
  });
