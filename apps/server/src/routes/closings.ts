import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validate.ts';
import type { AppEnv } from '../context.ts';
import { requirePermission } from '../session.ts';
import {
  baseIsoOf, currencyBalances, downloadRates, getRates, partnerBalances, postRevaluation, previewRevaluation, revaluationAccounts, saveRates,
} from '../services/revaluation.ts';
import {
  accountTurnovers, autoConcludeCandidates, concludeCandidates, planManualClosing, postAutoClosing, postManualClosing,
} from '../services/closings.ts';
import { concludeFinancialYear, concludeInfo } from '../services/yearEnd.ts';

/**
 * Automatic operations (spec 02c sections 2-3) and the year-end transfer
 * (01b 6.4): FX revaluation, closing of income/expense accounts, automatic
 * closing by ConcludeAccountID, "Прехвърляне на салда".
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна стойност.');
const optId = z.coerce.number().int().positive().optional();
const ctxOf = (c: { var: AppEnv['Variables'] }) => ({ year: c.var.year, userId: c.var.user.id, branchId: c.var.session.state.branchId });

const revaluationBody = z.object({
  tab: z.enum(['currency', 'partner']),
  date,
  accountId: z.number().int().nullable().optional(),
  all: z.boolean().optional(),
  companyId: z.number().int().nullable().optional(),
  term: z.string().max(255).optional(),
  reference: z.string().max(255).nullable().optional(),
  rates: z.array(z.object({ currencyId: z.number().int(), rate: decimal })).optional(),
  rate: decimal.nullable().optional(),
});

const modeEnum = z.enum(['costs', 'economic', 'revenue']);
const closingBody = z.object({
  mode: modeEnum,
  from: date,
  to: date,
  sources: z.array(z.object({ accountId: z.number().int(), amount: decimal })),
  targets: z.array(z.object({ accountId: z.number().int().nullable(), percent: z.union([decimal, z.number()]) })),
  percentDistribution: z.boolean().default(false),
  term: z.string().max(255).optional(),
  confirm: z.boolean().optional(),
});

const REVALUATION = 'UI_Operations_AutoOperations_Reevaluation';
const CONCLUDE = 'UI_Operations_AutoOperations_ConcludeAccounts';
const AUTO_CONCLUDE = 'UI_Operations_AutoOperations_ConcludeChartOfAccounts';

export const closingsRoutes = new Hono<AppEnv>()
  // ---- FX revaluation ----
  .get('/revaluation/setup', requirePermission(REVALUATION), async (c) => {
    const accounts = await revaluationAccounts(c.var.db, c.var.year.year);
    return c.json({ ...accounts, baseIso: baseIsoOf(c.var.year.year) });
  })
  .get('/revaluation/balances', requirePermission(REVALUATION), zValidator('query', z.object({
    tab: z.enum(['currency', 'partner']).default('currency'), date, accountId: optId, companyId: optId,
  })), async (c) => {
    const { db, year } = c.var;
    const q = c.req.valid('query');
    const rows = q.tab === 'partner'
      ? (q.accountId ? await partnerBalances(db, year, q.date, q.accountId, q.companyId ?? null) : [])
      : await currencyBalances(db, year, q.date, q.accountId ?? null);
    const rates = await getRates(db, q.date, year.year, [...new Set(rows.map((r) => r.currencyId))]);
    return c.json({ rows, rates });
  })
  .get('/revaluation/rates', requirePermission(REVALUATION), zValidator('query', z.object({ date })), async (c) =>
    c.json(await getRates(c.var.db, c.req.valid('query').date, c.var.year.year)))
  .put('/revaluation/rates', requirePermission(REVALUATION), zValidator('json', z.object({
    date, rates: z.array(z.object({ currencyId: z.number().int(), rate: decimal })),
  })), async (c) => {
    const { date: d, rates } = c.req.valid('json');
    await saveRates(c.var.db, d, c.var.year.year, rates);
    return c.json(await getRates(c.var.db, d, c.var.year.year));
  })
  .post('/revaluation/rates/download', requirePermission(REVALUATION), zValidator('json', z.object({ date })), async (c) =>
    c.json(await downloadRates(c.var.db, c.req.valid('json').date, c.var.year.year)))
  .post('/revaluation/preview', requirePermission(REVALUATION), zValidator('json', revaluationBody), async (c) => {
    const { rows } = await previewRevaluation(c.var.db, c.var.year, c.req.valid('json'), { requireRates: false });
    return c.json(rows);
  })
  .post('/revaluation', requirePermission(REVALUATION), zValidator('json', revaluationBody), async (c) => {
    const body = c.req.valid('json');
    // entries + the "Валутни разлики" printout (05 6.11) of the posted differences.
    return c.json(await c.var.db.transaction((tx) => postRevaluation(tx, ctxOf(c), body)), 201);
  })

  // ---- Manual closing (Приключване на разходни и приходни сметки) ----
  .get('/closings/turnovers', requirePermission(CONCLUDE), zValidator('query', z.object({
    mode: modeEnum.default('economic'), from: date, to: date, filter: z.string().optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await concludeCandidates(c.var.db, c.var.year, q.mode, q.from, q.to, q.filter ?? ''));
  })
  .get('/closings/account-turnovers', requirePermission(CONCLUDE), zValidator('query', z.object({
    from: date, to: date, ids: z.string().regex(/^\d+(,\d+)*$/),
  })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await accountTurnovers(c.var.db, c.var.year, q.from, q.to, q.ids.split(',').map(Number)));
  })
  .post('/closings/preview', requirePermission(CONCLUDE), zValidator('json', closingBody), async (c) => {
    const { messages, entries } = await planManualClosing(c.var.db, c.var.year, c.req.valid('json'));
    return c.json({
      messages,
      entries: entries.map((e) => ({
        debits: e.debits.map((l) => ({ accountId: l.accountId, amount: l.amount.toFixed(2) })),
        credits: e.credits.map((l) => ({ accountId: l.accountId, amount: l.amount.toFixed(2) })),
      })),
    });
  })
  .post('/closings', requirePermission(CONCLUDE), zValidator('json', closingBody), async (c) => {
    const body = c.req.valid('json');
    const res = await c.var.db.transaction((tx) => postManualClosing(tx, ctxOf(c), body));
    return c.json(res, res.posted ? 201 : 200);
  })

  // ---- Automatic closing (Автоматично приключване на сметки) ----
  .get('/closings/auto', requirePermission(AUTO_CONCLUDE), zValidator('query', z.object({
    from: date, to: date, filter: z.string().optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await autoConcludeCandidates(c.var.db, c.var.year, q.from, q.to, q.filter ?? ''));
  })
  .post('/closings/auto', requirePermission(AUTO_CONCLUDE), zValidator('json', z.object({
    from: date, to: date, filter: z.string().optional(), accountIds: z.array(z.number().int()).optional(),
  })), async (c) => {
    const b = c.req.valid('json');
    const res = await c.var.db.transaction((tx) => postAutoClosing(tx, ctxOf(c), b.from, b.to, b.filter ?? '', b.accountIds));
    return c.json(res, 201);
  })

  // ---- Year-end transfer (Прехвърляне на салда) ----
  .get('/years/:id/conclude-info', requirePermission('UI_Edit_ChangeActiveFinancialYear'), async (c) =>
    c.json(await concludeInfo(c.var.db, Number(c.req.param('id')))))
  .post('/years/:id/conclude', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({
    differencesAccountId: z.number().int().nullable().optional(),
  }).default({})), async (c) => {
    const res = await concludeFinancialYear(c.var.db, Number(c.req.param('id')), c.var.user.id, c.req.valid('json'));
    return c.json(res);
  });
