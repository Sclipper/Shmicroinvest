import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission } from '../session.ts';
import { deleteInitialBalances, listInitialBalances, openingTotals, saveInitialBalances } from '../services/initialBalances.ts';
import { logActivity } from '../services/audit.ts';

const PERM = 'UI_Operations_ChartOfAccounts_ChartOfAccountsBalance';
const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.').nullable().optional();
const row = z.object({
  companyId: z.number().int().nullable().optional(),
  documentTypeId: z.number().int().nullable().optional(),
  documentNumber: z.string().max(100).nullable().optional(),
  documentDate: z.string().nullable().optional(),
  debit: amount, credit: amount, currencyDebit: amount, currencyCredit: amount, exchangeRate: amount, quantityDebit: amount, quantityCredit: amount,
});

/** Начални салда (Alt+U; 01b 7). */
export const initialBalanceRoutes = new Hono<AppEnv>()
  .get('/initial-balances', requirePermission(PERM), async (c) => {
    const accountId = c.req.query('accountId');
    return c.json({
      rows: await listInitialBalances(c.var.db, c.var.year, accountId ? Number(accountId) : undefined),
      totals: await openingTotals(c.var.db, c.var.year),
    });
  })
  .put('/initial-balances/:accountId', requirePermission(PERM), zValidator('json', z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rows: z.array(row),
    force: z.boolean().optional(),
  })), async (c) => {
    const { date, rows, force } = c.req.valid('json');
    const { db, year, user, session } = c.var;
    const accountId = Number(c.req.param('accountId'));
    const r = await db.transaction((tx) => saveInitialBalances(tx, year, { userId: user.id, branchId: session.state.branchId ?? 1, force }, accountId, date, rows));
    await logActivity(db, user.id, 'edit', 'accounting', accountId, 'Начални салда');
    return c.json(r);
  })
  .delete('/initial-balances/:accountId', requirePermission(PERM), async (c) => {
    await c.var.db.transaction((tx) => deleteInitialBalances(tx, c.var.year, Number(c.req.param('accountId')), c.req.query('force') === '1'));
    return c.json({ ok: true });
  });
