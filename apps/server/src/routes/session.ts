import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { PERMISSIONS, baseCurrencyForYear, lockMonth, unlockMonth, lockYear, unlockYear } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import * as cat from '../db/catalog/schema.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { requirePermission, updateSessionState, workingDate, todayInSofia, daysBetween } from '../session.ts';
import { getConfig, setConfig, BASIC_SETTINGS } from '../services/config.ts';
import { applyChartTemplate } from '../services/chart.ts';
import { PRODUCT_VERSION } from '../services/companySetup.ts';
import { SETTING_CHILDREN } from './settingsExtras.ts';

export const sessionRoutes = new Hono<AppEnv>()
  /** Everything the shell needs: status bar cells, permissions, settings. */
  .get('/session', async (c) => {
    const { db, user, year, session } = c.var;
    const catalog = await c.var.driver.catalog();
    const [company] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, session.companyDb!));
    const [my] = await db.select().from(s.myCompany).limit(1);
    const branchId = session.state.branchId ?? 1;
    const [branch] = await db.select().from(s.branches).where(eq(s.branches.id, branchId));
    const permissions: Record<string, boolean> = {};
    for (const [, key] of PERMISSIONS) permissions[key] = await c.var.can(key);
    const settings: Record<string, string> = {};
    for (const [key, def] of Object.entries(BASIC_SETTINGS)) settings[key] = (await getConfig(db, key)) ?? def.default;
    const [{ count }] = (await exec(db, 
      sql`SELECT count(*)::int AS count FROM accounts WHERE is_euro = ${year.year >= 2026} AND number <> '0'`)).rows as [{ count: number }];
    return c.json({
      company: { db: session.companyDb, name: my?.name ?? company?.companyName ?? '', bulstat: my?.bulstat ?? '', vatId: my?.vatId ?? '', isVat: my?.isVat ?? false },
      user,
      year,
      branch: branch ? { id: branch.id, name: branch.name } : null,
      workingDate: workingDate(session),
      baseCurrency: baseCurrencyForYear(year.year),
      chartIsEmpty: count === 0,
      permissions,
      settings,
    });
  })

  /** Hidden hotkey Ctrl+Shift+F8 (06 2.5): active database information. */
  .get('/session/database-info', async (c) => {
    const { driver, session } = c.var;
    const catalog = await driver.catalog();
    const [company] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, session.companyDb!));
    const [{ version }] = (await exec(c.var.db, sql`SELECT version() AS version`)).rows as [{ version: string }];
    return c.json({
      server: driver.kind === 'pglite' ? 'PGlite (вграден)' : 'PostgreSQL',
      engine: version.split(',')[0],
      company: company?.companyName ?? '',
      database: session.companyDb,
      version: PRODUCT_VERSION,
    });
  })

  .put('/session/working-date', zValidator('json', z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })), async (c) => {
    const { date } = c.req.valid('json');
    const { db, year, user } = c.var;
    const y = Number(date.slice(0, 4));
    // Moving the working date into another year switches the active year (spec 01b 5).
    if (y !== year.year) {
      const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
      if (!fy) throw badRequest(`Не е намерена счетоводна година ${y}!`);
      if (fy.isLocked) throw badRequest('Избраната счетоводна година е заключена и не може да бъде избрана!');
      await setConfig(db, 'ActiveFinancialYear', String(y), user.id);
    }
    await updateSessionState(c, { appDateOffsetDays: daysBetween(todayInSofia(), date) });
    return c.json({ workingDate: date });
  })

  .put('/session/branch', zValidator('json', z.object({ branchId: z.number().int() })), async (c) => {
    const [b] = await c.var.db.select().from(s.branches).where(eq(s.branches.id, c.req.valid('json').branchId));
    if (!b) throw badRequest('Невалиден клон.');
    await updateSessionState(c, { branchId: b.id });
    return c.json({ ok: true });
  })

  // ---- Financial years (Счетоводна година, Ctrl+Y; spec 01b 6.3) ----
  .get('/years', async (c) => {
    const rows = await c.var.db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    return c.json(rows);
  })

  .put('/years/active', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({ year: z.number().int() })), async (c) => {
    const { db, user, session } = c.var;
    const { year } = c.req.valid('json');
    const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, year));
    if (!fy) throw badRequest(`Не е намерена счетоводна година ${year}!`);
    if (fy.isLocked) throw badRequest('Избраната счетоводна година е заключена и не може да бъде избрана!');
    await setConfig(db, 'ActiveFinancialYear', String(year), user.id);
    // Keep the working date inside the chosen year.
    const wd = workingDate(session);
    if (Number(wd.slice(0, 4)) !== year) {
      const target = `${year}${wd.slice(4)}`;
      await updateSessionState(c, { appDateOffsetDays: daysBetween(todayInSofia(), target.endsWith('02-29') ? `${year}-02-28` : target) });
    }
    return c.json({ ok: true });
  })

  .post('/years', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({ year: z.number().int().min(1901).max(2078) })), async (c) => {
    const { db } = c.var;
    const { year } = c.req.valid('json');
    const years = await db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    if (years.some((y) => y.year === year)) throw badRequest('Тази счетоводна година вече съществува.');
    const last = years[years.length - 1]!;
    const first = years[0]!;
    if (year !== last.year + 1 && year !== first.year - 1) throw badRequest('Може да се създаде само следващата или предходната година.');
    const row = await db.transaction(async (tx) => {
      const [fy] = await tx.insert(s.financialYears).values({ year, startDate: `${year}-01-01` }).returning();
      // Yearly-reset channels get a new sequence row; the others stay shared (AddFinancialYear).
      const resetting = await tx.select().from(s.sequences).where(eq(s.sequences.isNumberResetNextYear, true));
      const channels = [...new Set(resetting.map((r) => r.channel))];
      if (channels.length) await tx.insert(s.sequences).values(channels.map((channel) => ({ channel, financialYearId: fy!.id, isNumberResetNextYear: true })));
      // A EUR year needs the EUR chart; seed it from the template when empty.
      if (year >= 2026) {
        const eur = await exec(tx, sql`SELECT count(*)::int AS n FROM accounts WHERE is_euro AND number <> '0'`);
        if ((eur.rows[0] as { n: number }).n === 0) {
          const type = (await getConfig(tx, 'ChartOfAccountsType')) as 'commercial' | null;
          if (type) await applyChartTemplate(tx, type, true);
        }
      }
      return fy!;
    });
    return c.json(row, 201);
  })

  .put('/years/:id/locks', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({
    lockYear: z.boolean().optional(),
    months: z.array(z.number().int().min(1).max(12)).optional(),
  })), async (c) => {
    const { db } = c.var;
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, id));
    if (!fy) throw badRequest('Невалидна година.');
    let state = { isLocked: fy.isLocked, lockedMonths: fy.lockedMonths };
    if (body.lockYear === true) state = lockYear();
    else if (body.lockYear === false && !body.months) state = unlockYear();
    if (body.months) {
      const wanted = new Set(body.months);
      for (let m = 1; m <= 12; m++) state = wanted.has(m) ? lockMonth(state, m) : unlockMonth(state, m);
      if (body.lockYear === true) state = lockYear();
    }
    await db.update(s.financialYears).set(state).where(eq(s.financialYears.id, id));
    return c.json(state);
  })

  .delete('/years/:id', requirePermission('UI_Edit_ChangeActiveFinancialYear'), async (c) => {
    const { db, year } = c.var;
    const id = Number(c.req.param('id'));
    const years = await db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    const fy = years.find((y) => y.id === id);
    if (!fy) throw badRequest('Невалидна година.');
    if (fy.isLocked) throw badRequest('Счетоводната година не може да бъде изтрита, защото е заключена за редакция.');
    if (fy.id === year.id) throw badRequest('Текущата счетоводна година не може да бъде изтрита.');
    if (years[0]!.id !== fy.id) throw badRequest('Счетоводната година не може да бъде изтрита, защото има активни години преди нея.');
    await db.delete(s.financialYears).where(eq(s.financialYears.id, id));
    return c.json({ ok: true, message: `Счетоводната година ${fy.year} е изтрита успешно!` });
  })

  // ---- Settings (Други > Настройки) ----
  .get('/settings', async (c) => {
    const out: { key: string; label: string; value: string; default: string }[] = [];
    for (const [key, def] of Object.entries(BASIC_SETTINGS)) {
      out.push({ key, label: def.label, default: def.default, value: (await getConfig(c.var.db, key)) ?? def.default });
    }
    return c.json(out);
  })
  .put('/settings', requirePermission('UI_Other_Settings'), zValidator('json', z.record(z.string(), z.string())), async (c) => {
    const body = c.req.valid('json');
    // Validate everything first, then write in one transaction.
    const unknown = Object.keys(body).find((k) => !(k in BASIC_SETTINGS));
    if (unknown) throw new ApiError(400, `Непозната настройка ${unknown}.`);
    await c.var.db.transaction(async (tx) => {
      for (const [k, v] of Object.entries(body)) await setConfig(tx, k, v);
      // 06 3.5: a parent option turned off clears its dependent options.
      for (const [parent, children] of Object.entries(SETTING_CHILDREN)) {
        if (body[parent] === 'False') for (const child of children) if (child in BASIC_SETTINGS) await setConfig(tx, child, 'False');
      }
    });
    return c.json({ ok: true });
  });

