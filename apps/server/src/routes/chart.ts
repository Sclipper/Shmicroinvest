import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { ACCOUNT_CATEGORIES, isLeaf } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import type { AppEnv } from '../context.ts';
import { requirePermission } from '../session.ts';
import { addAccount, applyChartTemplate, copyAccounts, deleteAccount, deleteInfo, editAccount, suggestSubAccountNumber } from '../services/chart.ts';
import { baseCurrencyId } from '../services/journal.ts';
import { accountBalances } from '../services/reports.ts';

const accountBody = z.object({
  number: z.string().trim().max(50).optional(),
  parentId: z.number().int(),
  description: z.string().trim().max(255),
  englishDescription: z.string().max(255).nullable().optional(),
  accountCategoryId: z.number().int().nullable().optional(),
  currencyId: z.number().int().optional(),
  productId: z.number().int().nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  concludeAccountId: z.number().int().nullable().optional(),
  isHidden: z.boolean().optional(),
  iban: z.string().max(50).nullable().optional(),
});

export const chartRoutes = new Hono<AppEnv>()
  /** Chart of the active year (BGN chart before 2026, EUR chart from 2026), flat list ordered by tree. */
  .get('/accounts', async (c) => {
    const { db, year } = c.var;
    const isEuro = year.year >= 2026;
    const base = await baseCurrencyId(db, year.year);
    const rows = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, isEuro)).orderBy(asc(s.accounts.leftIndex));
    const used = await exec(db, sql`SELECT DISTINCT account_id FROM accounting_details`);
    const usedSet = new Set((used.rows as { account_id: number }[]).map((r) => r.account_id));
    return c.json(rows.map((r) => ({
      id: r.id, parentId: r.parentId, number: r.number, description: r.description, englishDescription: r.englishDescription,
      level: r.level, categoryId: r.accountCategoryId, currencyId: r.currencyId, productId: r.productId, isActive: r.isActive,
      concludeAccountId: r.concludeAccountId, isHidden: r.isHidden, iban: r.iban,
      isLeaf: isLeaf({ left: r.leftIndex, right: r.rightIndex }) && r.number !== '0',
      isForeignCurrency: r.currencyId !== base, isMaterial: r.productId != null, isUsed: usedSet.has(r.id),
    })));
  })

  .get('/accounts/categories', (c) => c.json(ACCOUNT_CATEGORIES))

  .get('/accounts/:id/next-number', async (c) => c.json({ number: await suggestSubAccountNumber(c.var.db, Number(c.req.param('id'))) }))

  .get('/accounts/:id/balance', async (c) => {
    const { db, year } = c.var;
    const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, Number(c.req.param('id'))));
    if (!acc) return c.json(null);
    const end = c.req.query('date') ?? `${year.year}-12-31`;
    return c.json(await accountBalances(db, acc.number, { startDate: `${year.year}-01-01`, endDate: end }));
  })

  .post('/accounts', requirePermission('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts'), zValidator('json', accountBody), async (c) => {
    const row = await c.var.db.transaction((tx) => addAccount(tx, c.req.valid('json')));
    return c.json(row, 201);
  })

  .put('/accounts/:id', requirePermission('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts'), zValidator('json', accountBody.partial()), async (c) => {
    const row = await c.var.db.transaction((tx) => editAccount(tx, Number(c.req.param('id')), c.req.valid('json')));
    return c.json(row);
  })

  .get('/accounts/:id/delete-info', async (c) => c.json(await deleteInfo(c.var.db, Number(c.req.param('id')))))

  .post('/accounts/:id/copy', requirePermission('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts'), zValidator('json', z.object({ targetId: z.number().int() })), async (c) => {
    const r = await c.var.db.transaction((tx) => copyAccounts(tx, Number(c.req.param('id')), c.req.valid('json').targetId));
    return c.json(r, 201);
  })

  .delete('/accounts/:id', requirePermission('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts'), async (c) => {
    await c.var.db.transaction((tx) => deleteAccount(tx, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  .post('/accounts/template', requirePermission('UI_Operations_ChartOfAccounts_ChartOfAccountsSelection'),
    zValidator('json', z.object({ type: z.enum(['commercial', 'nonProfit', 'budget']), numbers: z.array(z.string()).optional() })), async (c) => {
      const { type, numbers } = c.req.valid('json');
      const r = await c.var.db.transaction((tx) => applyChartTemplate(tx, type, c.var.year.year >= 2026, numbers));
      return c.json(r);
    });
