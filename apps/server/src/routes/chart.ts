import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { ACCOUNT_CATEGORIES, isLeaf } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import type { AppEnv } from '../context.ts';
import { requireAnyPermission, requirePermission } from '../session.ts';
import { accountTemplates, addAccount, applyChartTemplate, copyAccounts, deleteAccount, deleteInfo, editAccount, suggestSubAccountNumber } from '../services/chart.ts';
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
  isForBanks: z.boolean().optional(),
  iban: z.string().max(50).nullable().optional(),
  accountType: z.enum(['standard', 'currency', 'material']).optional(),
  measure: z.string().trim().max(50).nullable().optional(),
  productCode: z.string().trim().max(50).nullable().optional(),
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
    const productRows = await db.select({ id: s.products.id, measure: s.products.measure, code: s.products.code }).from(s.products);
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const links = await db.select({ accountId: s.productAccounts.accountId, accountType: s.productAccounts.accountType }).from(s.productAccounts);
    const typeByAccount = new Map(links.map((l) => [l.accountId, l.accountType]));
    return c.json(rows.map((r) => ({
      id: r.id, parentId: r.parentId, number: r.number, description: r.description, englishDescription: r.englishDescription,
      level: r.level, categoryId: r.accountCategoryId, currencyId: r.currencyId, productId: r.productId, isActive: r.isActive,
      concludeAccountId: r.concludeAccountId, isHidden: r.isHidden, isForBanks: r.isForBanks, iban: r.iban,
      isLeaf: isLeaf({ left: r.leftIndex, right: r.rightIndex }) && r.number !== '0',
      isForeignCurrency: r.currencyId !== base, isMaterial: r.productId != null, isUsed: usedSet.has(r.id),
      measure: r.productId ? (productById.get(r.productId)?.measure ?? null) : null,
      productCode: r.productId ? (productById.get(r.productId)?.code ?? null) : null,
      productAccountType: typeByAccount.get(r.id) ?? null,
    })));
  })

  .get('/accounts/categories', (c) => c.json(ACCOUNT_CATEGORIES))

  /** Account templates of the chart type (F4 in the account editor, 03a 1.6). */
  .get('/accounts/templates', async (c) => c.json(await accountTemplates(c.var.db, c.var.year.year >= 2026, c.req.query('q'))))

  /** Copy sub-accounts under a target account (03a 1.7). */
  .post('/accounts/copy', requirePermission('UI_Operations_ChartOfAccounts_IndividualChartOfAccounts'),
    zValidator('json', z.object({ ids: z.array(z.number().int()).min(1), targetId: z.number().int() })), async (c) => {
      const { ids, targetId } = c.req.valid('json');
      return c.json(await c.var.db.transaction((tx) => copyAccounts(tx, ids, targetId)));
    })

  .get('/accounts/:id/next-number', async (c) => c.json({ number: await suggestSubAccountNumber(c.var.db, Number(c.req.param('id'))) }))

  .get('/accounts/:id/balance', requireAnyPermission('UI_Operations_ChartOfAccounts', 'UI_Operations_Accounting', 'UI_Edit_Accountings', 'UI_Reporting_AnalyticalReport'), async (c) => {
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
    const r = await c.var.db.transaction((tx) => copyAccounts(tx, [Number(c.req.param('id'))], c.req.valid('json').targetId));
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
